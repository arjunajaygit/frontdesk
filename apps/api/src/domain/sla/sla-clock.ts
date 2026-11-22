import type { Priority } from '@frontdesk/contracts';
import type { BusinessCalendar } from '../calendar/business-calendar';
import { DurationMs, Instant, assertDuration, toIso, toIsoOrNull } from '../shared/instant';
import type { ClockKind, SlaPolicy } from './sla-policy';

export type ClockState = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

/** Persisted clock (mirrors the SlaClock table). Instances are treated as immutable values. */
export interface SlaClock {
  readonly id: string;
  readonly ticketId: string;
  readonly cycle: number;
  readonly kind: ClockKind;
  readonly state: ClockState;
  readonly cycleStartedAt: Instant;
  readonly budgetMs: DurationMs;
  readonly consumedMs: DurationMs;
  readonly currentLate: boolean;
  readonly breachSequence: number;
  readonly policyRevision: number;
  readonly runningSince: Instant | null;
  readonly deadlineAt: Instant | null;
  readonly completedAt: Instant | null;
  readonly cancelledAt: Instant | null;
  readonly firstBreachedAt: Instant | null;
}

/** AUDIT_PAYLOAD_CONTRACT clock snapshot (AuditClockSnapshot). */
export interface ClockSnapshot {
  clockId: string;
  kind: ClockKind;
  cycle: number;
  state: ClockState;
  budgetMs: number;
  consumedMs: number;
  deadlineAt: string | null;
  currentLate: boolean;
  breachSequence: number;
  policyRevision: number;
}

export interface ClockRevision {
  before: ClockSnapshot;
  after: ClockSnapshot;
}

export type BreachCause = 'DEADLINE_EXCEEDED' | 'PRIORITY_ESCALATION';

/** Facts of one immutable breach episode (clock id + breachSequence identifies it). */
export interface BreachFact {
  clock: SlaClock;
  breachedAt: Instant;
  /** Provisional (logical) — the audit writer replaces it with the actual append time. */
  recordedAt: Instant;
  missedDeadlineAt: Instant | null;
  cause: BreachCause;
}

export const isActive = (c: SlaClock): boolean => c.state === 'RUNNING' || c.state === 'PAUSED';

export function snapshot(c: SlaClock): ClockSnapshot {
  return {
    clockId: c.id,
    kind: c.kind,
    cycle: c.cycle,
    state: c.state,
    budgetMs: c.budgetMs,
    consumedMs: c.consumedMs,
    deadlineAt: toIsoOrNull(c.deadlineAt),
    currentLate: c.currentLate,
    breachSequence: c.breachSequence,
    policyRevision: c.policyRevision,
  };
}

export const breachEventKey = (c: SlaClock): string => `breach:${c.id}:${c.breachSequence}`;

/** At create/reopen: RUNNING, deadline = addWorkingMs(now, budget); budget from the effective cycle start. */
export function startClock(
  args: { id: string; ticketId: string; kind: ClockKind; cycle: number; priority: Priority; now: Instant },
  policy: SlaPolicy,
  cal: BusinessCalendar,
): SlaClock {
  if (args.kind === 'RESPONSE' && args.cycle !== 0) throw new RangeError('response clock is always cycle 0');
  const cycleStartedAt = cal.effectiveStart(args.now);
  const budgetMs = assertDuration(policy.budgetMs(args.priority, args.kind, cycleStartedAt), 'budget');
  return {
    id: args.id,
    ticketId: args.ticketId,
    cycle: args.cycle,
    kind: args.kind,
    state: 'RUNNING',
    cycleStartedAt,
    budgetMs,
    consumedMs: 0,
    currentLate: false,
    breachSequence: 0,
    policyRevision: 0,
    runningSince: args.now,
    deadlineAt: cal.addWorkingMs(args.now, budgetMs),
    completedAt: null,
    cancelledAt: null,
    firstBreachedAt: null,
  };
}

/** Effective consumption = stored consumedMs + working overlap since runningSince. */
export function consumedAt(c: SlaClock, now: Instant, cal: BusinessCalendar): DurationMs {
  if (c.state !== 'RUNNING' || c.runningSince === null) return c.consumedMs;
  if (now < c.runningSince) throw new RangeError('evaluation time precedes runningSince');
  return c.consumedMs + cal.workingMsBetween(c.runningSince, now);
}

/** Fold accrued working time into consumedMs; deadline is preserved (never re-derived from zero remaining). */
export function accrue(c: SlaClock, now: Instant, cal: BusinessCalendar): SlaClock {
  if (c.state !== 'RUNNING') return c;
  return { ...c, consumedMs: consumedAt(c, now, cal), runningSince: now };
}

/** Running: late iff now > deadline OR consumed > budget (equality on time). Paused: no deadline accrual. */
export function isLateAt(c: SlaClock, now: Instant, cal: BusinessCalendar): boolean {
  if (c.currentLate) return true;
  if (c.state === 'RUNNING') {
    return (c.deadlineAt !== null && now > c.deadlineAt) || consumedAt(c, now, cal) > c.budgetMs;
  }
  if (c.state === 'PAUSED') return c.consumedMs > c.budgetMs;
  return false;
}

/** An unrecorded deadline breach on a RUNNING clock (exactly what the sweep must persist). */
export function hasDueBreach(c: SlaClock, now: Instant, cal: BusinessCalendar): boolean {
  return c.state === 'RUNNING' && !c.currentLate && isLateAt(c, now, cal);
}

/**
 * Record a deadline breach discovered at `now`. Onset is the first overdue millisecond (deadline + 1)
 * even when discovered retrospectively; recordedAt is the actual recording time.
 */
export function recordDeadlineBreach(c: SlaClock, now: Instant, cal: BusinessCalendar): BreachFact {
  if (!hasDueBreach(c, now, cal)) throw new Error('no unrecorded breach is due on this clock');
  const accrued = accrue(c, now, cal);
  const onset = c.deadlineAt !== null && now > c.deadlineAt ? c.deadlineAt + 1 : now;
  const clock: SlaClock = {
    ...accrued,
    currentLate: true,
    breachSequence: c.breachSequence + 1,
    firstBreachedAt: c.firstBreachedAt ?? onset,
  };
  return { clock, breachedAt: onset, recordedAt: now, missedDeadlineAt: c.deadlineAt, cause: 'DEADLINE_EXCEEDED' };
}

function assertState(c: SlaClock, allowed: ClockState[], op: string): void {
  if (!allowed.includes(c.state)) throw new Error(`cannot ${op} a ${c.state} clock`);
}

/** Completion keeps the current late result; history (firstBreachedAt, sequence) is immutable. */
export function complete(c: SlaClock, now: Instant, cal: BusinessCalendar): SlaClock {
  assertState(c, ['RUNNING'], 'complete');
  if (hasDueBreach(c, now, cal)) throw new Error('record the due breach before completing');
  return { ...accrue(c, now, cal), state: 'COMPLETED', completedAt: now, runningSince: null, deadlineAt: null };
}

/** Cancellation records the prior evaluation and stops the clock; it is not a success. */
export function cancel(c: SlaClock, now: Instant, cal: BusinessCalendar): SlaClock {
  assertState(c, ['RUNNING', 'PAUSED'], 'cancel');
  if (hasDueBreach(c, now, cal)) throw new Error('record the due breach before cancelling');
  return { ...accrue(c, now, cal), state: 'CANCELLED', cancelledAt: now, runningSince: null, deadlineAt: null };
}

/** Pause: store consumption, preserve currentLate, clear runningSince/deadline. */
export function pause(c: SlaClock, now: Instant, cal: BusinessCalendar): SlaClock {
  assertState(c, ['RUNNING'], 'pause');
  if (hasDueBreach(c, now, cal)) throw new Error('record the due breach before pausing');
  return { ...accrue(c, now, cal), state: 'PAUSED', runningSince: null, deadlineAt: null };
}

/**
 * Resume: remaining > 0 and on time => deadline = addWorkingMs(now, remaining);
 * remaining = 0 or already late/exhausted => deadline = now (on time at equality, late at +1 ms).
 */
export function resume(c: SlaClock, now: Instant, cal: BusinessCalendar): SlaClock {
  assertState(c, ['PAUSED'], 'resume');
  const remaining = c.budgetMs - c.consumedMs;
  const deadlineAt = c.currentLate || remaining <= 0 ? now : cal.addWorkingMs(now, remaining);
  return { ...c, state: 'RUNNING', runningSince: now, deadlineAt };
}

export interface RevisionOutcome {
  clock: SlaClock;
  /** A new false->true lateness episode caused by the policy change (cause PRIORITY_ESCALATION). */
  breach: BreachFact | null;
  /** Current lateness cleared by a more lenient policy (history preserved). */
  lateCleared: boolean;
}

/**
 * Apply a new budget against elapsed consumption (never reset). The caller must have recorded any
 * breach due under the OLD policy first. currentLate := consumed > newBudget (equality on time).
 */
export function revise(c: SlaClock, newBudgetMs: DurationMs, now: Instant, cal: BusinessCalendar): RevisionOutcome {
  assertState(c, ['RUNNING', 'PAUSED'], 'revise');
  if (hasDueBreach(c, now, cal)) throw new Error('record the breach due under the old policy first');
  assertDuration(newBudgetMs, 'budget');
  const accrued = accrue(c, now, cal);
  const late = accrued.consumedMs > newBudgetMs;
  const newEpisode = late && !c.currentLate;
  const deadlineAt =
    accrued.state === 'RUNNING' ? cal.addWorkingMs(now, Math.max(0, newBudgetMs - accrued.consumedMs)) : null;
  const clock: SlaClock = {
    ...accrued,
    budgetMs: newBudgetMs,
    policyRevision: c.policyRevision + 1,
    currentLate: late,
    breachSequence: newEpisode ? c.breachSequence + 1 : c.breachSequence,
    firstBreachedAt: newEpisode ? (c.firstBreachedAt ?? now) : c.firstBreachedAt,
    deadlineAt,
  };
  return {
    clock,
    breach: newEpisode ? { clock, breachedAt: now, recordedAt: now, missedDeadlineAt: null, cause: 'PRIORITY_ESCALATION' } : null,
    lateCleared: c.currentLate && !late,
  };
}

/** Read-only staff projection (OpenAPI SlaClock). Never mutates; flags detected-but-unrecorded breaches. */
export interface ClockProjection {
  id: string;
  kind: ClockKind;
  cycle: number;
  state: ClockState;
  cycleStartedAt: string;
  budgetMs: number;
  consumedMs: number;
  remainingMs: number;
  deadlineAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  currentLate: boolean;
  firstBreachedAt: string | null;
  breachDetectedNotRecorded: boolean;
  asOf: string;
  breachSequence: number;
  policyRevision: number;
}

export function project(c: SlaClock, asOf: Instant, cal: BusinessCalendar): ClockProjection {
  const consumed = consumedAt(c, asOf, cal);
  const late = isLateAt(c, asOf, cal);
  return {
    id: c.id,
    kind: c.kind,
    cycle: c.cycle,
    state: c.state,
    cycleStartedAt: toIso(c.cycleStartedAt),
    budgetMs: c.budgetMs,
    consumedMs: consumed,
    remainingMs: Math.max(0, c.budgetMs - consumed),
    deadlineAt: toIsoOrNull(c.deadlineAt),
    completedAt: toIsoOrNull(c.completedAt),
    cancelledAt: toIsoOrNull(c.cancelledAt),
    currentLate: late,
    firstBreachedAt: toIsoOrNull(c.firstBreachedAt),
    breachDetectedNotRecorded: late && !c.currentLate,
    asOf: toIso(asOf),
    breachSequence: c.breachSequence,
    policyRevision: c.policyRevision,
  };
}
