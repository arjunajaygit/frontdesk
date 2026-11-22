-- M3: retention support (AUTH_CONTRACT / DOMAIN_CONTRACT). Additive only.
-- Idempotency records (>= 24h retry window) and expired sessions/refresh digests (expiry + 24h) must be purged
-- by the runtime scheduler, which requires DELETE on exactly these three non-audit tables. audit_logs keeps
-- SELECT/INSERT only (unchanged); Ticket/Message/SlaClock still have no DELETE.
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
GRANT DELETE ON TABLE public."IdempotencyRecord", public."RefreshToken", public."Session" TO frontdesk_app;
