-- Run as `postgres` immediately after `prisma migrate deploy` (frontdesk_owner) succeeds.
-- Removes the temporary database-level CREATE needed only by the baseline migration's CREATE SCHEMA IF NOT EXISTS.
\set ON_ERROR_STOP on
REVOKE CREATE ON DATABASE postgres FROM frontdesk_owner;
SELECT 'revoked temporary database CREATE from frontdesk_owner' AS result;
