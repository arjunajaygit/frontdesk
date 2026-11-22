import type { TicketAggregate } from '../ticket/ticket.types';
import type { Instant } from '../shared/instant';

/** SWEEP_CONTRACT defaults (overridable via validated config: SWEEP_LEASE_MS / SWEEP_BATCH_SIZE / SWEEP_MAX_BATCHES). */
export const SWEEP_DEFAULTS = Object.freeze({
  leaseMs: 30_000,
  batchSize: 50,
  maxBatches: 10,
  /** Bounded elapsed time, below typical host request limits. */
  maxElapsedMs: 20_000,
  recoveryLimit: 20,
});

export type SweepState = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type SweepErrorCode = 'SWEEP_FAILED' | 'SWEEP_LEASE_EXPIRED';

export interface SweepCounters {
  processed: number;
  autoClosed: number;
  expired: number;
  breachesRecorded: number;
  failed: number;
}

export interface SweepCandidate {
  ticketId: string;
  dueAt: Instant;
}

/** Keyset cursor: strictly after (dueAt, ticketId). */
export type SweepCursor = SweepCandidate;

export function afterCursor(c: SweepCandidate, cursor: SweepCursor | null): boolean {
  if (cursor === null) return true;
  return c.dueAt > cursor.dueAt || (c.dueAt === cursor.dueAt && c.ticketId > cursor.ticketId);
}

export function compareCandidates(a: SweepCandidate, b: SweepCandidate): number {
  return a.dueAt - b.dueAt || (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0);
}

/**
 * Earliest *unprocessed* due transition for a ticket, or null. Mirrors the SQL candidate query:
 * WAITING past cutoff, RESOLVED past reopen window, or a RUNNING clock with currentLate=false past its
 * deadline. A recorded late clock never qualifies merely because its deadline is old. Strict "<".
 */
export function candidateDueAt(agg: TicketAggregate, snapshot: Instant): Instant | null {
  const t = agg.ticket;
  const dues: Instant[] = [];
  if (t.status === 'WAITING' && t.waitingCloseDueAt !== null && t.waitingCloseDueAt < snapshot) dues.push(t.waitingCloseDueAt);
  if (t.status === 'RESOLVED' && t.reopenUntil !== null && t.reopenUntil < snapshot) dues.push(t.reopenUntil);
  for (const c of agg.clocks) {
    if (c.state === 'RUNNING' && !c.currentLate && c.deadlineAt !== null && c.deadlineAt < snapshot) dues.push(c.deadlineAt);
  }
  return dues.length ? Math.min(...dues) : null;
}

/** Lease is live strictly before leaseUntil; equality is expired (now >= leaseUntil). */
export function isLeaseLive(
  inv: { state: SweepState; leaseToken: string; leaseUntil: Instant },
  token: string,
  now: Instant,
): boolean {
  return inv.state === 'RUNNING' && inv.leaseToken === token && now < inv.leaseUntil;
}

export function isRecoverable(inv: { state: SweepState; leaseUntil: Instant }, now: Instant): boolean {
  return inv.state === 'RUNNING' && now >= inv.leaseUntil;
}

export interface ExistingInvocation {
  state: SweepState;
  requestHash: string;
  leaseUntil: Instant;
  responseStatus: number | null;
  result: unknown;
}

export type ReservationDecision =
  | { kind: 'RESERVE' }
  | { kind: 'CONFLICT'; status: 409; code: 'IDEMPOTENCY_CONFLICT' }
  | { kind: 'IN_PROGRESS'; status: 409; code: 'SWEEP_IN_PROGRESS' }
  | { kind: 'RECOVER_THEN_REPLAY' }
  | { kind: 'REPLAY'; status: number; body: unknown };

/** Deterministic same-key handling: changed hash always conflicts; expired RUNNING is terminalised before replay. */
export function decideReservation(existing: ExistingInvocation | null, requestHash: string, now: Instant): ReservationDecision {
  if (existing === null) return { kind: 'RESERVE' };
  if (existing.requestHash !== requestHash) return { kind: 'CONFLICT', status: 409, code: 'IDEMPOTENCY_CONFLICT' };
  if (existing.state === 'RUNNING') {
    return isRecoverable(existing, now) ? { kind: 'RECOVER_THEN_REPLAY' } : { kind: 'IN_PROGRESS', status: 409, code: 'SWEEP_IN_PROGRESS' };
  }
  if (existing.responseStatus === null) throw new Error('invariant: terminal invocation without stored status');
  return { kind: 'REPLAY', status: existing.responseStatus, body: existing.result };
}

const CALLER_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** One invocation per actor-scoped key: the unique key embeds actor type and id. */
export function sweepKey(actor: { type: 'SYSTEM' } | { type: 'LEAD' | 'ADMIN'; id: string }, callerKey: string): string {
  if (!CALLER_KEY.test(callerKey)) throw new RangeError('idempotency key must be 8-128 chars of [A-Za-z0-9_-]');
  return `${actor.type}:${actor.type === 'SYSTEM' ? '-' : actor.id}:${callerKey}`;
}

export const ERROR_MESSAGES: Record<SweepErrorCode, string> = {
  SWEEP_FAILED: 'The SLA sweep failed; committed progress is preserved.',
  SWEEP_LEASE_EXPIRED: 'The SLA sweep lease expired before completion; committed progress is preserved.',
};
