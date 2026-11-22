import type { Priority } from '@frontdesk/contracts';
import type { BreachCause, ClockRevision, ClockSnapshot } from '../sla/sla-clock';
import type { Instant } from '../shared/instant';
import type { Actor } from './actor';
import type { CloseReason, MessageKind, TicketStatus } from './ticket.types';

/**
 * Action-bound safe audit payloads (AUDIT_PAYLOAD_CONTRACT / OpenAPI AuditEvent oneOf). Details carry IDs,
 * states, versions and timestamps only: never message bodies, emails, tokens or arbitrary input.
 */
type V = { beforeVersion: number; afterVersion: number };
type Transition = V & { beforeStatus: TicketStatus; afterStatus: TicketStatus };

export interface AuditDetailsByAction {
  TICKET_CREATED: { version: number; priority: Priority; initialMessageId: string; parentTicketId: string | null; clocks: ClockSnapshot[] };
  TICKET_CLAIMED: Transition & { assigneeId: string };
  TICKET_REASSIGNED: V & { previousAssigneeId: string | null; assigneeId: string | null };
  MESSAGE_PUBLISHED: V & { messageId: string; messageKind: Exclude<MessageKind, 'NOTE'>; publishedAt: string };
  INTERNAL_NOTE_ADDED: V & { messageId: string };
  PRIORITY_CHANGED: V & { previousPriority: Priority; newPriority: Priority; clocks: ClockRevision[] };
  SLA_PAUSED: V & { clock: ClockRevision; pausedAt: string; requestMessageId: string; waitingCloseDueAt: string };
  SLA_RESUMED: V & { clock: ClockRevision; resumedAt: string; customerMessageId: string };
  SLA_BREACHED: V & { clock: ClockSnapshot; breachedAt: string; recordedAt: string; missedDeadlineAt: string | null; cause: BreachCause };
  SLA_COMPLETED: V & { clock: ClockRevision; completedAt: string; qualifyingMessageId: string | null };
  SLA_CANCELLED: V & { clock: ClockRevision; cancelledAt: string; reason: 'AUTO_CLOSED_NO_REPLY' };
  TICKET_WAITING: Transition & { waitingSince: string; waitingCloseDueAt: string };
  TICKET_RESUMED: Transition & { customerMessageId: string };
  TICKET_RESOLVED: Transition & { resolvedAt: string; reopenUntil: string };
  TICKET_CLOSED: Transition & { closedAt: string; cutoffAt: string; closeReason: CloseReason };
  TICKET_REOPENED: Transition & { resolutionCycle: number; newClock: ClockSnapshot; customerMessageId: string };
  LINKED_TICKET_CREATED: V & { childTicketId: string; reason: CloseReason };
}

export type TicketAuditAction = keyof AuditDetailsByAction;

/**
 * Domain event intent. Persistence adds id, correlationId and createdAt in the same transaction.
 * Construct only through `ticketEvent()`, which binds `details` to `action` at compile time.
 */
export interface TicketDomainEvent<A extends TicketAuditAction = TicketAuditAction> {
  readonly action: A;
  readonly ticketId: string;
  readonly actor: Actor;
  readonly occurredAt: Instant;
  /** Stable idempotency key where the contract requires one (breach episodes); otherwise null. */
  readonly eventKey: string | null;
  readonly reasonCode: string | null;
  readonly details: AuditDetailsByAction[A];
}

export function ticketEvent<A extends TicketAuditAction>(
  action: A,
  ticketId: string,
  actor: Actor,
  occurredAt: Instant,
  details: AuditDetailsByAction[A],
  eventKey: string | null = null,
): TicketDomainEvent<A> {
  return { action, ticketId, actor, occurredAt, eventKey, reasonCode: null, details };
}

export const TICKET_AUDIT_ACTIONS: readonly TicketAuditAction[] = [
  'TICKET_CREATED', 'TICKET_CLAIMED', 'TICKET_REASSIGNED', 'MESSAGE_PUBLISHED', 'INTERNAL_NOTE_ADDED',
  'PRIORITY_CHANGED', 'SLA_PAUSED', 'SLA_RESUMED', 'SLA_BREACHED', 'SLA_COMPLETED', 'SLA_CANCELLED',
  'TICKET_WAITING', 'TICKET_RESUMED', 'TICKET_RESOLVED', 'TICKET_CLOSED', 'TICKET_REOPENED', 'LINKED_TICKET_CREATED',
];
