import type { Prisma, SlaClock as ClockRow, Ticket as TicketRow } from '@prisma/client';
import type { SlaClock } from '../../domain/sla/sla-clock';
import { bigintToSafeNumber, fromDate, fromNullableDate, safeNumberToBigint } from '../../domain/shared/instant';
import type { TicketDomainEvent } from '../../domain/ticket/audit-events';
import type { NewMessage, Ticket, TicketAggregate } from '../../domain/ticket/ticket.types';

/** Rows <-> domain. BigInt budgets are converted with explicit safe-range checks, never silently. */
const d = (t: number | null): Date | null => (t === null ? null : new Date(t));

export function clockFromRow(r: ClockRow): SlaClock {
  return {
    id: r.id,
    ticketId: r.ticketId,
    cycle: r.cycle,
    kind: r.kind,
    state: r.state,
    cycleStartedAt: fromDate(r.cycleStartedAt),
    budgetMs: bigintToSafeNumber(r.budgetMs, 'budgetMs'),
    consumedMs: bigintToSafeNumber(r.consumedMs, 'consumedMs'),
    currentLate: r.currentLate,
    breachSequence: r.breachSequence,
    policyRevision: r.policyRevision,
    runningSince: fromNullableDate(r.runningSince),
    deadlineAt: fromNullableDate(r.deadlineAt),
    completedAt: fromNullableDate(r.completedAt),
    cancelledAt: fromNullableDate(r.cancelledAt),
    firstBreachedAt: fromNullableDate(r.firstBreachedAt),
  };
}

export function ticketFromRow(r: TicketRow): Ticket {
  return {
    id: r.id,
    subject: r.subject,
    customerId: r.customerId,
    assigneeId: r.assigneeId,
    status: r.status,
    priority: r.priority,
    requestedPriority: r.requestedPriority,
    createdAt: fromDate(r.createdAt),
    updatedAt: fromDate(r.updatedAt),
    parentTicketId: r.parentTicketId,
    version: r.version,
    resolutionCycle: r.resolutionCycle,
    closedAt: fromNullableDate(r.closedAt),
    closeReason: r.closeReason,
    reopenUntil: fromNullableDate(r.reopenUntil),
    waitingCloseDueAt: fromNullableDate(r.waitingCloseDueAt),
    resolvedAt: fromNullableDate(r.resolvedAt),
    waitingSince: fromNullableDate(r.waitingSince),
  };
}

export function aggregateFromRows(t: TicketRow, clocks: ClockRow[]): TicketAggregate {
  const ordered = [...clocks].sort((a, b) => a.cycle - b.cycle || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { ticket: ticketFromRow(t), clocks: ordered.map(clockFromRow) };
}

export function clockToRow(c: SlaClock): Prisma.SlaClockUncheckedCreateInput {
  return {
    id: c.id,
    ticketId: c.ticketId,
    cycle: c.cycle,
    kind: c.kind,
    state: c.state,
    cycleStartedAt: new Date(c.cycleStartedAt),
    budgetMs: safeNumberToBigint(c.budgetMs, 'budgetMs'),
    consumedMs: safeNumberToBigint(c.consumedMs, 'consumedMs'),
    currentLate: c.currentLate,
    breachSequence: c.breachSequence,
    policyRevision: c.policyRevision,
    runningSince: d(c.runningSince),
    deadlineAt: d(c.deadlineAt),
    completedAt: d(c.completedAt),
    cancelledAt: d(c.cancelledAt),
    firstBreachedAt: d(c.firstBreachedAt),
  };
}

export function ticketToRow(t: Ticket): Prisma.TicketUncheckedCreateInput {
  return {
    id: t.id,
    subject: t.subject,
    customerId: t.customerId,
    assigneeId: t.assigneeId,
    status: t.status,
    priority: t.priority,
    requestedPriority: t.requestedPriority,
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.updatedAt),
    parentTicketId: t.parentTicketId,
    version: t.version,
    resolutionCycle: t.resolutionCycle,
    closedAt: d(t.closedAt),
    closeReason: t.closeReason,
    reopenUntil: d(t.reopenUntil),
    waitingCloseDueAt: d(t.waitingCloseDueAt),
    resolvedAt: d(t.resolvedAt),
    waitingSince: d(t.waitingSince),
  };
}

export function messageToRow(m: NewMessage): Prisma.MessageUncheckedCreateInput {
  return { ...m, createdAt: new Date(m.createdAt) };
}

/** Ticket-target audit row. `id`, `correlationId` and `eventKey` defaults are supplied by the caller (M3). */
export function auditToRow(
  e: TicketDomainEvent,
  /** recordedAt: actual append time (M03); defaults to the logical time for historical seed replay only. */
  envelope: { id: string; correlationId: string; eventKey?: string | null; recordedAt?: Date },
): Prisma.AuditEventUncheckedCreateInput {
  return {
    id: envelope.id,
    target: 'TICKET',
    ticketId: e.ticketId,
    correlationId: envelope.correlationId,
    reasonCode: e.reasonCode,
    actorType: e.actor.type,
    actorId: e.actor.type === 'SYSTEM' ? null : e.actor.id,
    action: e.action,
    details: e.details as unknown as Prisma.InputJsonValue,
    eventKey: e.eventKey ?? envelope.eventKey ?? null,
    createdAt: envelope.recordedAt ?? new Date(e.occurredAt),
  };
}
