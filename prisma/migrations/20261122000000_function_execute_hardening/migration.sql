-- M8 hardening (managed-hosting review): no Frontdesk function is callable by PUBLIC. On platforms that expose an
-- auto-generated API over `public` (e.g. Supabase's Data API) PUBLIC EXECUTE would make functions reachable as RPC.
-- Trigger functions do not need the caller to hold EXECUTE (it is checked when the trigger is created), so the
-- append-only audit triggers keep firing for every role. Runs as the schema owner (frontdesk_owner).
REVOKE EXECUTE ON FUNCTION public.prevent_audit_log_mutation() FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
