-- Executed in migration 20261121000100_domain_constraints (keep in sync; drift test enforces).
ALTER TABLE public."Ticket" ADD CONSTRAINT ticket_state_fields CHECK (
 "version" >= 0 AND "resolutionCycle" >= 0 AND "updatedAt" >= "createdAt" AND
 (status <> 'OPEN' OR "assigneeId" IS NULL) AND
 (status NOT IN ('IN_PROGRESS','WAITING') OR "assigneeId" IS NOT NULL) AND
 ((status = 'WAITING') = ("waitingSince" IS NOT NULL)) AND
 ((status = 'WAITING') = ("waitingCloseDueAt" IS NOT NULL)) AND
 ("waitingCloseDueAt" IS NULL OR "waitingCloseDueAt" >= "waitingSince") AND
 ((status = 'CLOSED') = ("closedAt" IS NOT NULL)) AND
 ((status = 'CLOSED') = ("closeReason" IS NOT NULL)) AND
 ((status = 'RESOLVED' OR (status = 'CLOSED' AND "closeReason" = 'RESOLUTION_WINDOW_EXPIRED')) = ("resolvedAt" IS NOT NULL)) AND
 (("resolvedAt" IS NULL) = ("reopenUntil" IS NULL)) AND
 ("reopenUntil" IS NULL OR "reopenUntil" >= "resolvedAt") AND
 ("closedAt" IS NULL OR "closedAt" >= "createdAt") AND
 ("parentTicketId" IS NULL OR "parentTicketId" <> id)
);
ALTER TABLE public."SlaClock" ADD CONSTRAINT sla_fields CHECK (
 "budgetMs" >= 0 AND "consumedMs" >= 0 AND cycle >= 0 AND "breachSequence" >= 0 AND "policyRevision" >= 0 AND
 (kind <> 'RESPONSE' OR cycle = 0) AND
 ((state = 'RUNNING') = ("runningSince" IS NOT NULL)) AND
 ((state = 'RUNNING') = ("deadlineAt" IS NOT NULL)) AND
 ((state = 'COMPLETED') = ("completedAt" IS NOT NULL)) AND
 ((state = 'CANCELLED') = ("cancelledAt" IS NOT NULL)) AND
 (("breachSequence" = 0) = ("firstBreachedAt" IS NULL)) AND
 (NOT "currentLate" OR "firstBreachedAt" IS NOT NULL)
);
ALTER TABLE public."Message" ADD CONSTRAINT message_kind_visibility CHECK ((kind = 'NOTE') = (visibility = 'PRIVATE'));
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_target_actor CHECK (
 (target = 'TICKET' AND "ticketId" IS NOT NULL AND "sweepId" IS NULL OR
 target = 'SWEEP' AND "sweepId" IS NOT NULL AND "ticketId" IS NULL) AND
 (("actorType" = 'SYSTEM') = ("actorId" IS NULL))
);
ALTER TABLE public."SweepInvocation" ADD CONSTRAINT sweep_actor_state CHECK (
 (("actorType" = 'SYSTEM') = ("actorId" IS NULL)) AND "actorType" IN ('SYSTEM','LEAD','ADMIN') AND
 ((state = 'RUNNING') = ("finishedAt" IS NULL)) AND "leaseUntil" >= "startedAt"
);
ALTER TABLE public."IdempotencyRecord" ADD CONSTRAINT idempotency_result_pair CHECK ((response IS NULL) = ("responseStatus" IS NULL));
-- Cross-row invariants (customer/assignee role, same customer lineage, current clock cycle, timestamp order) use locked service checks + integration tests.

-- V3.2: validate with real PostgreSQL in M1 after baseline schema migration.
ALTER TABLE public."SweepInvocation" ADD CONSTRAINT sweep_progress_terminal CHECK (
 "processed" >= 0 AND "autoClosed" >= 0 AND "expired" >= 0 AND "breachesRecorded" >= 0 AND "failed" >= 0 AND
 "autoClosed" + "expired" <= "processed" AND length("leaseToken") > 0 AND
 ((state = 'RUNNING') = ("responseStatus" IS NULL)) AND
 ((state = 'RUNNING') = (result IS NULL)) AND
 (state <> 'COMPLETED' OR "responseStatus" = 200) AND
 (state <> 'FAILED' OR "responseStatus" = 503) AND
 ("finishedAt" IS NULL OR "finishedAt" >= "startedAt")
);
CREATE INDEX sla_unprocessed_due_idx ON public."SlaClock" ("deadlineAt", "ticketId")
 WHERE state = 'RUNNING' AND "currentLate" = false;
