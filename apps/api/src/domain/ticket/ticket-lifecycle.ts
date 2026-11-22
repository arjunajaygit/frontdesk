import { AUTO_CLOSE_BUDGET_MS, REOPEN_WINDOW_MS, type Priority } from '@frontdesk/contracts';
import type { BusinessCalendar } from '../calendar/business-calendar';
import {
  BreachFact,
  SlaClock,
  breachEventKey,
  cancel,
  complete,
  hasDueBreach,
  isActive,
  pause,
  recordDeadlineBreach,
  resume,
  revise,
  snapshot,
  startClock,
} from '../sla/sla-clock';
import type { ClockKind, SlaPolicy } from '../sla/sla-policy';
import { DomainError } from '../shared/domain-error';
import { Instant, assertInstant, toIso } from '../shared/instant';
import { Actor, CustomerActor, SYSTEM, StaffActor, isCustomer, isStaff } from './actor';
import { AuditDetailsByAction, TicketAuditAction, TicketDomainEvent, ticketEvent } from './audit-events';
import type { MessageKind, NewMessage, Ticket, TicketAggregate, TicketStatus, Visibility } from './ticket.types';

export interface IdGenerator {
  next(kind: 'ticket' | 'message' | 'clock'): string;
}

export interface LifecycleDeps {
  readonly calendar: BusinessCalendar;
  readonly policy: SlaPolicy;
  readonly ids: IdGenerator;
}

/** Per-ticket outcome counters used by the sweep (SWEEP_CONTRACT). */
export interface TransitionCounters {
  breachesRecorded: number;
  autoClosed: number;
  expired: number;
}

export interface MutationResult {
  readonly aggregate: TicketAggregate;
  readonly messages: readonly NewMessage[];
  readonly events: readonly TicketDomainEvent[];
  /** false => nothing to persist; version and updatedAt unchanged. */
  readonly changed: boolean;
  readonly counters: TransitionCounters;
  /** DB time was behind ticket.updatedAt and was clamped (log, M3). */
  readonly timeAnomaly: boolean;
}

export type CustomerContactResult =
  | { readonly outcome: 'SAME_TICKET'; readonly result: MutationResult }
  | { readonly outcome: 'NEW_LINKED_TICKET'; readonly previous: MutationResult; readonly child: MutationResult };

export const MAX_BODY = 10_000;
export const MAX_SUBJECT = 200;

function text(value: string, max: number, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('MESSAGE_REQUIRED', `${field} must not be empty`);
  }
  if (value.length > max) throw new DomainError('INVALID_INPUT', `${field} exceeds ${max} characters`);
  return value;
}

/** Mutable working copy of one aggregate during a single logical mutation. */
class Draft {
  ticket: { -readonly [K in keyof Ticket]: Ticket[K] };
  clocks: SlaClock[];
  readonly events: TicketDomainEvent[] = [];
  readonly messages: NewMessage[] = [];
  readonly counters: TransitionCounters = { breachesRecorded: 0, autoClosed: 0, expired: 0 };
  private readonly base: number;

  constructor(
    agg: TicketAggregate,
    readonly now: Instant,
    readonly timeAnomaly: boolean,
  ) {
    this.ticket = { ...agg.ticket };
    this.clocks = [...agg.clocks];
    this.base = agg.ticket.version;
  }

  get changed(): boolean {
    return this.events.length > 0;
  }
  /** Every event of one logical mutation shares the same before/after version. */
  get v() {
    return { beforeVersion: this.base, afterVersion: this.base + 1 };
  }

  emit<A extends TicketAuditAction>(action: A, actor: Actor, details: AuditDetailsByAction[A], eventKey: string | null = null) {
    this.events.push(ticketEvent(action, this.ticket.id, actor, this.now, details, eventKey));
  }

  message(authorId: string, body: string, kind: MessageKind, id: string): NewMessage {
    const visibility: Visibility = kind === 'NOTE' ? 'PRIVATE' : 'PUBLIC';
    const m: NewMessage = { id, ticketId: this.ticket.id, authorId, body, visibility, kind, createdAt: this.now };
    this.messages.push(m);
    return m;
  }

  clock(kind: ClockKind): SlaClock {
    const cycle = kind === 'RESPONSE' ? 0 : this.ticket.resolutionCycle;
    const c = this.clocks.find((x) => x.kind === kind && x.cycle === cycle);
    if (!c) throw new Error(`invariant: ${kind} clock for cycle ${cycle} is missing`);
    return c;
  }

  put(c: SlaClock): void {
    const i = this.clocks.findIndex((x) => x.id === c.id);
    if (i < 0) this.clocks.push(c);
    else this.clocks[i] = c;
  }

  result(): MutationResult {
    const changed = this.changed;
    const ticket: Ticket = changed ? { ...this.ticket, version: this.base + 1, updatedAt: this.now } : { ...this.ticket };
    return {
      aggregate: { ticket, clocks: this.clocks },
      messages: this.messages,
      events: this.events,
      changed,
      counters: this.counters,
      timeAnomaly: this.timeAnomaly,
    };
  }
}

/**
 * Centralised ticket state machine (DOMAIN_CONTRACT actor/command matrix). Pure: callers supply the
 * DB-sampled time; results are persisted by the application layer in one transaction (M3).
 * Every command first applies `reconcile`, the exact rule the sweep applies, so outcomes do not depend
 * on whether a sweep has already run.
 */
export class TicketLifecycle {
  constructor(private readonly deps: LifecycleDeps) {}

  // ---------------------------------------------------------------- intake

  /** Customer intake: authoritative priority MEDIUM; requestedPriority stored for triage only. */
  customerIntake(cmd: { actor: Actor; subject: string; body: string; requestedPriority?: Priority | null; now: Instant }): MutationResult {
    const actor = this.requireCustomer(cmd.actor);
    return this.createTicket({
      actor,
      customerId: actor.id,
      subject: cmd.subject,
      body: cmd.body,
      priority: 'MEDIUM',
      requestedPriority: cmd.requestedPriority ?? null,
      parentTicketId: null,
      now: cmd.now,
    });
  }

  /** Staff intake on behalf of an existing customer (existence checked by M3). INTAKE never satisfies RESPONSE. */
  staffIntake(cmd: { actor: Actor; customerId: string; subject: string; body: string; priority: Priority; now: Instant }): MutationResult {
    const actor = this.requireStaff(cmd.actor);
    return this.createTicket({ ...cmd, actor, requestedPriority: null, parentTicketId: null });
  }

  // ---------------------------------------------------------------- staff commands

  claim(agg: TicketAggregate, actor: Actor, sampledNow: Instant): MutationResult {
    const staff = this.requireStaff(actor);
    const d = this.begin(agg, sampledNow);
    if (d.ticket.assigneeId !== null) throw new DomainError('ALREADY_CLAIMED', 'ticket is already claimed');
    if (d.ticket.status !== 'OPEN') throw new DomainError('INVALID_STATE', 'only OPEN tickets can be claimed');
    d.ticket.status = 'IN_PROGRESS';
    d.ticket.assigneeId = staff.id;
    d.emit('TICKET_CLAIMED', staff, { ...d.v, beforeStatus: 'OPEN', afterStatus: 'IN_PROGRESS', assigneeId: staff.id });
    return d.result();
  }

  /** Assignee public reply: completes the first response; never pauses. */
  publicReply(agg: TicketAggregate, actor: Actor, body: string, sampledNow: Instant): MutationResult {
    const staff = this.requireAssignee(agg, actor);
    text(body, MAX_BODY, 'reply');
    const d = this.begin(agg, sampledNow);
    this.requireStatus(d, ['IN_PROGRESS']);
    const m = d.message(staff.id, body, 'REPLY', this.deps.ids.next('message'));
    d.emit('MESSAGE_PUBLISHED', staff, { ...d.v, messageId: m.id, messageKind: 'REPLY', publishedAt: toIso(d.now) });
    this.completeIfRunning(d, 'RESPONSE', staff, m.id);
    return d.result();
  }

  /** Private note: no SLA effect whatsoever. */
  addNote(agg: TicketAggregate, actor: Actor, body: string, sampledNow: Instant): MutationResult {
    const staff = this.requireAssignee(agg, actor);
    text(body, MAX_BODY, 'note');
    const d = this.begin(agg, sampledNow);
    this.requireStatus(d, ['IN_PROGRESS', 'WAITING']);
    const m = d.message(staff.id, body, 'NOTE', this.deps.ids.next('message'));
    d.emit('INTERNAL_NOTE_ADDED', staff, { ...d.v, messageId: m.id });
    return d.result();
  }

  /** Explicit public request: completes pending response, pauses resolution, starts the 2700-min inactivity timer. */
  requestInformation(agg: TicketAggregate, actor: Actor, body: string, sampledNow: Instant): MutationResult {
    const staff = this.requireAssignee(agg, actor);
    text(body, MAX_BODY, 'request');
    const d = this.begin(agg, sampledNow);
    this.requireStatus(d, ['IN_PROGRESS']);
    const m = d.message(staff.id, body, 'REQUEST', this.deps.ids.next('message'));
    d.emit('MESSAGE_PUBLISHED', staff, { ...d.v, messageId: m.id, messageKind: 'REQUEST', publishedAt: toIso(d.now) });
    this.completeIfRunning(d, 'RESPONSE', staff, m.id);
    const dueAt = this.deps.calendar.addWorkingMs(d.now, AUTO_CLOSE_BUDGET_MS);
    const res = d.clock('RESOLUTION');
    if (res.state === 'RUNNING') {
      const paused = pause(res, d.now, this.deps.calendar);
      d.put(paused);
      d.emit('SLA_PAUSED', staff, {
        ...d.v,
        clock: { before: snapshot(res), after: snapshot(paused) },
        pausedAt: toIso(d.now),
        requestMessageId: m.id,
        waitingCloseDueAt: toIso(dueAt),
      });
    }
    d.ticket.status = 'WAITING';
    d.ticket.waitingSince = d.now;
    d.ticket.waitingCloseDueAt = dueAt;
    d.emit('TICKET_WAITING', staff, {
      ...d.v,
      beforeStatus: 'IN_PROGRESS',
      afterStatus: 'WAITING',
      waitingSince: toIso(d.now),
      waitingCloseDueAt: toIso(dueAt),
    });
    return d.result();
  }

  /**
   * Priority change: reconcile old deadlines first, then apply the new budget to consumed time (never reset).
   * Completed/cancelled clocks are never revised; downgrade may clear current lateness but never history.
   */
  changePriority(agg: TicketAggregate, actor: Actor, priority: Priority, sampledNow: Instant): MutationResult {
    const staff = this.requireAssignee(agg, actor);
    // State guards apply to the EFFECTIVE (reconciled) state first, so resolved/closed/expired tickets can't
    // slip through as a "same priority" no-op (L01).
    const d = this.begin(agg, sampledNow);
    this.requireStatus(d, ['IN_PROGRESS', 'WAITING']);
    if (agg.ticket.priority === priority) return this.begin(agg, sampledNow, false).result(); // pure no-op
    const revisions: AuditDetailsByAction['PRIORITY_CHANGED']['clocks'] = [];
    const breaches: BreachFact[] = [];
    for (const kind of ['RESPONSE', 'RESOLUTION'] as const) {
      const c = d.clock(kind);
      if (!isActive(c)) continue;
      const budget = this.deps.policy.budgetMs(priority, kind, c.cycleStartedAt);
      const out = revise(c, budget, d.now, this.deps.calendar);
      d.put(out.clock);
      revisions.push({ before: snapshot(c), after: snapshot(out.clock) });
      if (out.breach) breaches.push(out.breach);
    }
    const previous = d.ticket.priority;
    d.ticket.priority = priority;
    d.emit('PRIORITY_CHANGED', staff, { ...d.v, previousPriority: previous, newPriority: priority, clocks: revisions });
    for (const b of breaches) this.emitBreach(d, b, staff);
    return d.result();
  }

  /** Resolve: a public message is mandatory while the first response is pending; it completes response first. */
  resolve(agg: TicketAggregate, actor: Actor, body: string | undefined, sampledNow: Instant): MutationResult {
    const staff = this.requireAssignee(agg, actor);
    if (body !== undefined) text(body, MAX_BODY, 'resolution message');
    const d = this.begin(agg, sampledNow);
    this.requireStatus(d, ['IN_PROGRESS']);
    if (body === undefined && d.clock('RESPONSE').state === 'RUNNING') {
      throw new DomainError('MESSAGE_REQUIRED', 'a public resolution message is required before the first response');
    }
    let qualifying: string | null = null;
    if (body !== undefined) {
      const m = d.message(staff.id, body, 'REPLY', this.deps.ids.next('message'));
      qualifying = m.id;
      d.emit('MESSAGE_PUBLISHED', staff, { ...d.v, messageId: m.id, messageKind: 'REPLY', publishedAt: toIso(d.now) });
      this.completeIfRunning(d, 'RESPONSE', staff, m.id);
    }
    this.completeIfRunning(d, 'RESOLUTION', staff, qualifying);
    const reopenUntil = d.now + REOPEN_WINDOW_MS;
    d.ticket.status = 'RESOLVED';
    d.ticket.resolvedAt = d.now;
    d.ticket.reopenUntil = reopenUntil;
    d.emit('TICKET_RESOLVED', staff, {
      ...d.v,
      beforeStatus: 'IN_PROGRESS',
      afterStatus: 'RESOLVED',
      resolvedAt: toIso(d.now),
      reopenUntil: toIso(reopenUntil),
    });
    return d.result();
  }

  /** Compatibility stub: staff can never reopen on behalf of a customer (no impersonation). */
  staffReopen(_agg: TicketAggregate, _actor: Actor): never {
    throw new DomainError('FORBIDDEN_ACTOR', 'only the owning customer can reopen a ticket');
  }

  // ---------------------------------------------------------------- customer commands

  customerReply(agg: TicketAggregate, actor: Actor, body: string, sampledNow: Instant): CustomerContactResult {
    const customer = this.requireOwner(agg, actor);
    text(body, MAX_BODY, 'reply');
    const d = this.begin(agg, sampledNow);
    switch (d.ticket.status) {
      case 'OPEN':
      case 'IN_PROGRESS': {
        this.customerMessage(d, customer, body);
        return { outcome: 'SAME_TICKET', result: d.result() };
      }
      case 'WAITING':
        return { outcome: 'SAME_TICKET', result: this.resumeFromWaiting(d, customer, body) };
      case 'RESOLVED':
        return { outcome: 'SAME_TICKET', result: this.reopenSameTicket(d, customer, body) };
      case 'CLOSED':
        return this.linkedTicket(d, customer, body);
    }
  }

  /** Reopen with a mandatory message: RESOLVED within window -> same ticket; CLOSED -> linked child; else 409. */
  customerReopen(agg: TicketAggregate, actor: Actor, body: string, sampledNow: Instant): CustomerContactResult {
    const customer = this.requireOwner(agg, actor);
    text(body, MAX_BODY, 'reopen message');
    const d = this.begin(agg, sampledNow);
    if (d.ticket.status === 'RESOLVED') return { outcome: 'SAME_TICKET', result: this.reopenSameTicket(d, customer, body) };
    if (d.ticket.status === 'CLOSED') return this.linkedTicket(d, customer, body);
    throw new DomainError('USE_REPLY', 'ticket is active; send a reply instead');
  }

  // ---------------------------------------------------------------- system / sweep

  /** Reconcile all due transitions for one ticket (SYSTEM actor). No-op => changed=false, nothing to persist. */
  reconcileDue(agg: TicketAggregate, sampledNow: Instant): MutationResult {
    return this.begin(agg, sampledNow).result();
  }

  // ---------------------------------------------------------------- internals

  private begin(agg: TicketAggregate, sampledNow: Instant, reconcile = true): Draft {
    assertInstant(sampledNow, 'now');
    // Clamp a backwards DB clock step to the last mutation so durations can never go negative.
    const now = Math.max(sampledNow, agg.ticket.updatedAt);
    const d = new Draft(agg, now, now !== sampledNow);
    if (reconcile) this.reconcile(d);
    return d;
  }

  /** The single due-transition rule shared by every command and the sweep. Strictly-after cutoffs. */
  private reconcile(d: Draft): void {
    const cal = this.deps.calendar;
    for (const c of [...d.clocks]) {
      if (hasDueBreach(c, d.now, cal)) this.emitBreach(d, recordDeadlineBreach(c, d.now, cal), SYSTEM);
    }
    const t = d.ticket;
    if (t.status === 'WAITING' && t.waitingCloseDueAt !== null && d.now > t.waitingCloseDueAt) {
      const cutoff = t.waitingCloseDueAt;
      for (const c of [...d.clocks]) {
        if (!isActive(c)) continue;
        const cancelled = cancel(c, d.now, cal);
        d.put(cancelled);
        d.emit('SLA_CANCELLED', SYSTEM, {
          ...d.v,
          clock: { before: snapshot(c), after: snapshot(cancelled) },
          cancelledAt: toIso(d.now),
          reason: 'AUTO_CLOSED_NO_REPLY',
        });
      }
      this.close(d, 'WAITING', 'AUTO_CLOSED_NO_REPLY', cutoff);
      t.waitingSince = null;
      t.waitingCloseDueAt = null;
      d.counters.autoClosed++;
    } else if (t.status === 'RESOLVED' && t.reopenUntil !== null && d.now > t.reopenUntil) {
      // resolvedAt / reopenUntil are retained for RESOLUTION_WINDOW_EXPIRED.
      this.close(d, 'RESOLVED', 'RESOLUTION_WINDOW_EXPIRED', t.reopenUntil);
      d.counters.expired++;
    }
  }

  private close(d: Draft, from: TicketStatus, reason: 'AUTO_CLOSED_NO_REPLY' | 'RESOLUTION_WINDOW_EXPIRED', cutoff: Instant): void {
    d.ticket.status = 'CLOSED';
    d.ticket.closedAt = d.now;
    d.ticket.closeReason = reason;
    d.emit('TICKET_CLOSED', SYSTEM, {
      ...d.v,
      beforeStatus: from,
      afterStatus: 'CLOSED',
      closedAt: toIso(d.now),
      cutoffAt: toIso(cutoff),
      closeReason: reason,
    });
  }

  private emitBreach(d: Draft, b: BreachFact, actor: Actor): void {
    d.put(b.clock);
    d.counters.breachesRecorded++;
    d.emit(
      'SLA_BREACHED',
      actor,
      {
        ...d.v,
        clock: snapshot(b.clock),
        breachedAt: toIso(b.breachedAt),
        recordedAt: toIso(b.recordedAt),
        missedDeadlineAt: b.missedDeadlineAt === null ? null : toIso(b.missedDeadlineAt),
        cause: b.cause,
      },
      breachEventKey(b.clock),
    );
  }

  private completeIfRunning(d: Draft, kind: ClockKind, actor: Actor, qualifyingMessageId: string | null): void {
    const c = d.clock(kind);
    if (c.state !== 'RUNNING') return;
    const done = complete(c, d.now, this.deps.calendar);
    d.put(done);
    d.emit('SLA_COMPLETED', actor, {
      ...d.v,
      clock: { before: snapshot(c), after: snapshot(done) },
      completedAt: toIso(d.now),
      qualifyingMessageId,
    });
  }

  private customerMessage(d: Draft, customer: CustomerActor, body: string): NewMessage {
    const m = d.message(customer.id, body, 'REPLY', this.deps.ids.next('message'));
    d.emit('MESSAGE_PUBLISHED', customer, { ...d.v, messageId: m.id, messageKind: 'REPLY', publishedAt: toIso(d.now) });
    return m;
  }

  /** Customer reply at or before the cutoff: resume the remaining budget on the same ticket. */
  private resumeFromWaiting(d: Draft, customer: CustomerActor, body: string): MutationResult {
    const m = this.customerMessage(d, customer, body);
    const res = d.clock('RESOLUTION');
    if (res.state === 'PAUSED') {
      const resumed = resume(res, d.now, this.deps.calendar);
      d.put(resumed);
      d.emit('SLA_RESUMED', customer, {
        ...d.v,
        clock: { before: snapshot(res), after: snapshot(resumed) },
        resumedAt: toIso(d.now),
        customerMessageId: m.id,
      });
      // Exhausted-but-unrecorded budget becomes late immediately on resume.
      if (hasDueBreach(resumed, d.now, this.deps.calendar)) {
        this.emitBreach(d, recordDeadlineBreach(resumed, d.now, this.deps.calendar), SYSTEM);
      }
    }
    d.ticket.status = 'IN_PROGRESS';
    d.ticket.waitingSince = null;
    d.ticket.waitingCloseDueAt = null;
    d.emit('TICKET_RESUMED', customer, { ...d.v, beforeStatus: 'WAITING', afterStatus: 'IN_PROGRESS', customerMessageId: m.id });
    return d.result();
  }

  /** Within the 7-calendar-day window: new resolution cycle on the same ticket; response clock untouched. */
  private reopenSameTicket(d: Draft, customer: CustomerActor, body: string): MutationResult {
    const m = this.customerMessage(d, customer, body);
    const cycle = d.ticket.resolutionCycle + 1;
    const clock = startClock(
      { id: this.deps.ids.next('clock'), ticketId: d.ticket.id, kind: 'RESOLUTION', cycle, priority: d.ticket.priority, now: d.now },
      this.deps.policy,
      this.deps.calendar,
    );
    d.put(clock);
    const afterStatus: TicketStatus = d.ticket.assigneeId !== null ? 'IN_PROGRESS' : 'OPEN';
    d.ticket.status = afterStatus;
    d.ticket.resolutionCycle = cycle;
    d.ticket.resolvedAt = null;
    d.ticket.reopenUntil = null;
    d.emit('TICKET_REOPENED', customer, {
      ...d.v,
      beforeStatus: 'RESOLVED',
      afterStatus,
      resolutionCycle: cycle,
      newClock: snapshot(clock),
      customerMessageId: m.id,
    });
    return d.result();
  }

  /** Contact on a CLOSED ticket: new OPEN child with original subject/customer/priority; parent history unchanged. */
  private linkedTicket(d: Draft, customer: CustomerActor, body: string): CustomerContactResult {
    const reason = d.ticket.closeReason;
    if (reason === null) throw new Error('invariant: CLOSED ticket without closeReason');
    const child = this.createTicket({
      actor: customer,
      customerId: d.ticket.customerId,
      subject: d.ticket.subject,
      body,
      priority: d.ticket.priority,
      requestedPriority: null,
      parentTicketId: d.ticket.id,
      now: d.now,
    });
    const parentChanged = d.changed;
    const v = parentChanged ? d.v : { beforeVersion: d.v.beforeVersion, afterVersion: d.v.beforeVersion };
    const parent = d.result();
    // The link event refers to the child; versions match the actual parent mutation (equal if none).
    const link = ticketEvent('LINKED_TICKET_CREATED', d.ticket.id, customer, d.now, {
      ...v,
      childTicketId: child.aggregate.ticket.id,
      reason,
    });
    return {
      outcome: 'NEW_LINKED_TICKET',
      previous: { ...parent, events: [...parent.events, link] },
      child,
    };
  }

  private createTicket(c: {
    actor: StaffActor | CustomerActor;
    customerId: string;
    subject: string;
    body: string;
    priority: Priority;
    requestedPriority: Priority | null;
    parentTicketId: string | null;
    now: Instant;
  }): MutationResult {
    const now = assertInstant(c.now, 'now');
    text(c.subject, MAX_SUBJECT, 'subject');
    text(c.body, MAX_BODY, 'message');
    const id = this.deps.ids.next('ticket');
    const clocks = (['RESPONSE', 'RESOLUTION'] as const).map((kind) =>
      startClock({ id: this.deps.ids.next('clock'), ticketId: id, kind, cycle: 0, priority: c.priority, now }, this.deps.policy, this.deps.calendar),
    );
    const ticket: Ticket = {
      id,
      subject: c.subject,
      customerId: c.customerId,
      assigneeId: null,
      status: 'OPEN',
      priority: c.priority,
      requestedPriority: c.requestedPriority,
      createdAt: now,
      updatedAt: now,
      parentTicketId: c.parentTicketId,
      version: 0,
      resolutionCycle: 0,
      closedAt: null,
      closeReason: null,
      reopenUntil: null,
      waitingCloseDueAt: null,
      resolvedAt: null,
      waitingSince: null,
    };
    const message: NewMessage = {
      id: this.deps.ids.next('message'),
      ticketId: id,
      authorId: c.actor.id,
      body: c.body,
      visibility: 'PUBLIC',
      kind: 'INTAKE',
      createdAt: now,
    };
    const events: TicketDomainEvent[] = [
      ticketEvent('TICKET_CREATED', id, c.actor, now, {
        version: 0,
        priority: c.priority,
        initialMessageId: message.id,
        parentTicketId: c.parentTicketId,
        clocks: clocks.map(snapshot),
      }),
      ticketEvent('MESSAGE_PUBLISHED', id, c.actor, now, {
        beforeVersion: 0,
        afterVersion: 0,
        messageId: message.id,
        messageKind: 'INTAKE',
        publishedAt: toIso(now),
      }),
    ];
    return {
      aggregate: { ticket, clocks },
      messages: [message],
      events,
      changed: true,
      counters: { breachesRecorded: 0, autoClosed: 0, expired: 0 },
      timeAnomaly: false,
    };
  }

  private requireStaff(actor: Actor): StaffActor {
    if (!isStaff(actor)) throw new DomainError('FORBIDDEN_ACTOR', 'staff only');
    return actor;
  }

  private requireCustomer(actor: Actor): CustomerActor {
    if (!isCustomer(actor)) throw new DomainError('FORBIDDEN_ACTOR', 'customers only (no staff impersonation)');
    return actor;
  }

  private requireAssignee(agg: TicketAggregate, actor: Actor): StaffActor {
    const staff = this.requireStaff(actor);
    if (agg.ticket.assigneeId !== staff.id) throw new DomainError('NOT_ASSIGNEE', 'only the assigned staff member can do this');
    return staff;
  }

  private requireOwner(agg: TicketAggregate, actor: Actor): CustomerActor {
    const customer = this.requireCustomer(actor);
    if (agg.ticket.customerId !== customer.id) throw new DomainError('NOT_OWNER', 'ticket not found');
    return customer;
  }

  private requireStatus(d: Draft, allowed: TicketStatus[]): void {
    if (!allowed.includes(d.ticket.status)) {
      throw new DomainError('INVALID_STATE', `not allowed while ${d.ticket.status}`);
    }
  }
}
