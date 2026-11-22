import type { Priority } from '@frontdesk/contracts';
import type { SlaClock } from '../sla/sla-clock';
import type { Instant } from '../shared/instant';

export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'RESOLVED' | 'CLOSED';
export type CloseReason = 'AUTO_CLOSED_NO_REPLY' | 'RESOLUTION_WINDOW_EXPIRED';
export type MessageKind = 'INTAKE' | 'REPLY' | 'REQUEST' | 'NOTE';
export type Visibility = 'PUBLIC' | 'PRIVATE';

export interface Ticket {
  readonly id: string;
  readonly subject: string;
  readonly customerId: string;
  readonly assigneeId: string | null;
  readonly status: TicketStatus;
  readonly priority: Priority;
  readonly requestedPriority: Priority | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly parentTicketId: string | null;
  readonly version: number;
  readonly resolutionCycle: number;
  readonly closedAt: Instant | null;
  readonly closeReason: CloseReason | null;
  readonly reopenUntil: Instant | null;
  readonly waitingCloseDueAt: Instant | null;
  readonly resolvedAt: Instant | null;
  readonly waitingSince: Instant | null;
}

/** Consistency boundary: one ticket and all of its clocks (all cycles; history is never rewritten). */
export interface TicketAggregate {
  readonly ticket: Ticket;
  readonly clocks: readonly SlaClock[];
}

export interface NewMessage {
  readonly id: string;
  readonly ticketId: string;
  readonly authorId: string;
  readonly body: string;
  readonly visibility: Visibility;
  readonly kind: MessageKind;
  readonly createdAt: Instant;
}
