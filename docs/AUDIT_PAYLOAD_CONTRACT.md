# V3.2 normative safe audit payloads
The OpenAPI AuditEvent oneOf union binds action to an exact details shape; each branch denies undeclared properties. Use the corresponding safe DTO at write time and read time; validate internal event payloads before appending. Database details JSON is not a safe serialization source by itself. Customer routes never access audit. Unknown action or invalid historical payload fails closed (safe error; no raw JSON fallback). Every event records actor, correlation, reasonCode (controlled code or null), createdAt and target. Never store or expose message bodies, email, password hashes, session IDs, cookies, lease tokens or arbitrary user input in details. Timestamps use UTC ISO 8601; breach event recordedAt is actual insertion time, logical breachedAt is domain onset. All events of one logical mutation use same before/after version; initial creation version zero. Multiple events may share version and correlation; stable order createdAt/id; reconstruct by versions and semantic relationships, not UUID tie ordering as causal evidence.

## Ticket action vocabulary
- `TICKET_CREATED`: version, priority, initialMessageId, parentTicketId, clocks.
- `TICKET_CLAIMED`: beforeVersion, afterVersion, beforeStatus, afterStatus, assigneeId.
- `TICKET_REASSIGNED`: beforeVersion, afterVersion, previousAssigneeId, assigneeId.
- `MESSAGE_PUBLISHED`: beforeVersion, afterVersion, messageId, messageKind, publishedAt.
- `INTERNAL_NOTE_ADDED`: beforeVersion, afterVersion, messageId.
- `PRIORITY_CHANGED`: beforeVersion, afterVersion, previousPriority, newPriority, clocks.
- `SLA_PAUSED`: beforeVersion, afterVersion, clock, pausedAt, requestMessageId, waitingCloseDueAt.
- `SLA_RESUMED`: beforeVersion, afterVersion, clock, resumedAt, customerMessageId.
- `SLA_BREACHED`: beforeVersion, afterVersion, clock, breachedAt, recordedAt, missedDeadlineAt, cause.
- `SLA_COMPLETED`: beforeVersion, afterVersion, clock, completedAt, qualifyingMessageId.
- `SLA_CANCELLED`: beforeVersion, afterVersion, clock, cancelledAt, reason.
- `TICKET_WAITING`: beforeVersion, afterVersion, beforeStatus, afterStatus, waitingSince, waitingCloseDueAt.
- `TICKET_RESUMED`: beforeVersion, afterVersion, beforeStatus, afterStatus, customerMessageId.
- `TICKET_RESOLVED`: beforeVersion, afterVersion, beforeStatus, afterStatus, resolvedAt, reopenUntil.
- `TICKET_CLOSED`: beforeVersion, afterVersion, beforeStatus, afterStatus, closedAt, cutoffAt, closeReason.
- `TICKET_REOPENED`: beforeVersion, afterVersion, beforeStatus, afterStatus, resolutionCycle, newClock, customerMessageId.
- `LINKED_TICKET_CREATED`: beforeVersion, afterVersion, childTicketId, reason.

Clock snapshots include kind, cycle, state, budget, consumption, deadline, currentLate, episode and policy revision. Escalation and pause/resume use before/after snapshots. MESSAGE_PUBLISHED covers initial intake and public reply/request; logical publication timestamp is sampled mutation time, visibility after commit, not proof of external delivery. INTERNAL_NOTE_ADDED contains ID only. TICKET_WAITING and TICKET_RESUMED explicitly record ticket transitions in addition to clock changes. Reassignment remains optional. Linked-child event on parent refers to child and reason; before/after version match actual parent mutation (may be equal if no parent state change). Child receives TICKET_CREATED and MESSAGE_PUBLISHED. R11 and R12 require ordering and reconstruction tests.

## Sweep-target internal events (not returned from ticket audit endpoint)
Use separate strict write schemas with no unknown keys: SWEEP_STARTED {leaseUntil}; SWEEP_FINISHED {processed,autoClosed,expired,breachesRecorded,failed,moreDue}; SWEEP_FAILED {processed,autoClosed,expired,breachesRecorded,failed,errorCode}; SWEEP_RECOVERED {processed,autoClosed,expired,breachesRecorded,failed,errorCode,expiredLeaseAt}. Counts nonnegative integers; timestamps UTC; errorCode controlled enum SWEEP_FAILED or SWEEP_LEASE_EXPIRED as applicable. Actor SYSTEM for recovery; initiating identity remains in SweepInvocation and original START attribution. Do not expose lease token. Ticket transitions caused by scheduler have SYSTEM actor and invocation correlation. One START and one terminal event per invocation; use unique eventKey.

## Error boundary
Generic Error has only code, message, requestId. StaffClaimConflict is permitted only on authorized staff claim HTTP 409 and may contain assignedAgentDisplayName when a ticket actually has an assignee. Other errors including customer errors must not carry this field, via DTO and exception filter allowlists. Test unknown properties rejected; do not put restricted info in message text.

## M4 clarification (M03, no business-rule change)
Envelope `createdAt` is the actual RECORDING time (fresh PostgreSQL clock at append inside the business transaction). Logical business times live in `details` (`publishedAt`, `breachedAt` = missed deadline + 1 ms, `completedAt`, ...). `SLA_BREACHED.recordedAt` equals the envelope `createdAt`. Events and messages become visible only when the transaction commits; neither timestamp proves external delivery, customer receipt or the exact commit instant. Causal order is reconstructed from versions and semantic links, not timestamps alone.
