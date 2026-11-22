/** Typed mirror of the authoritative OpenAPI contract (docs/openapi.draft.yaml). Server data only. */
export type Role = 'AGENT' | 'LEAD' | 'ADMIN' | 'CUSTOMER';
export type Priority = 'URGENT' | 'MEDIUM' | 'LOW';
export type Status = 'OPEN' | 'IN_PROGRESS' | 'WAITING' | 'RESOLVED' | 'CLOSED';
export type CloseReason = 'AUTO_CLOSED_NO_REPLY' | 'RESOLUTION_WINDOW_EXPIRED';
export type ClockKind = 'RESPONSE' | 'RESOLUTION';
export type ClockState = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export interface Viewer {
  id: string;
  displayName: string;
  role: Role;
}
export interface SessionResponse {
  viewer: Viewer;
  csrfToken: string;
  sessionContext: string;
}
export interface CurrentSession extends Viewer {
  sessionContext: string;
}

export interface SlaClock {
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

export interface StaffTicketSummary {
  id: string;
  subject: string;
  status: Status;
  priority: Priority;
  requestedPriority: Priority | null;
  customerId: string;
  assigneeId: string | null;
  assigneeDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  parentTicketId: string | null;
  version: number;
  resolutionCycle: number;
  waitingCloseDueAt: string | null;
  reopenUntil: string | null;
  closeReason: CloseReason | null;
  clocks: SlaClock[];
}
export type MessageKind = 'INTAKE' | 'REPLY' | 'REQUEST' | 'NOTE';
export interface StaffMessage {
  id: string;
  body: string;
  author: Viewer;
  kind: MessageKind;
  visibility: 'PUBLIC' | 'PRIVATE';
  createdAt: string;
}
export interface StaffTicket extends StaffTicketSummary {
  messages: StaffMessage[];
  olderMessagesCursor: string | null;
}
export interface StaffPage {
  items: StaffTicketSummary[];
  nextCursor: string | null;
}
export interface StaffMessagePage {
  items: StaffMessage[];
  nextCursor: string | null;
}

export interface PublicMessage {
  id: string;
  body: string;
  authorDisplayName: string;
  authorType: 'STAFF' | 'CUSTOMER';
  createdAt: string;
}
export interface PublicTicketSummary {
  id: string;
  subject: string;
  status: Status;
  createdAt: string;
  parentTicketId: string | null;
}
export interface PublicTicket extends PublicTicketSummary {
  messages: PublicMessage[];
  olderMessagesCursor: string | null;
}
export interface PublicPage {
  items: PublicTicketSummary[];
  nextCursor: string | null;
}
export interface PublicMessagePage {
  items: PublicMessage[];
  nextCursor: string | null;
}
export interface CustomerOutcome {
  outcome: 'SAME_TICKET' | 'NEW_LINKED_TICKET';
  ticket: PublicTicket;
  previousTicketId: string | null;
}
export interface CustomerSummary {
  id: string;
  displayName: string;
}

export interface SweepResult {
  invocationId: string;
  correlationId: string;
  processed: number;
  autoClosed: number;
  expired: number;
  breachesRecorded: number;
  failed: number;
  moreDue: boolean;
}

/** Strict action-bound audit event (details shape depends on action; see describeAudit). */
export interface AuditEvent {
  id: string;
  ticketId: string;
  actorId: string | null;
  actorType: Role | 'SYSTEM';
  action: string;
  createdAt: string;
  correlationId: string;
  reasonCode: string | null;
  details: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export interface AuditPage {
  items: AuditEvent[];
  nextCursor: string | null;
}
