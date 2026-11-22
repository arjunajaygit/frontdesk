-- Audit immutability + least-privilege runtime grants.
-- Executed form of prisma/sql/audit_immutability.sql, preceded by a role-provisioning guard.
-- Run as the schema OWNER (frontdesk_owner). frontdesk_app must already exist (environment-specific provisioning).
DO $$
DECLARE r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'frontdesk_app';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime role frontdesk_app is not provisioned';
  END IF;
  IF r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication THEN
    RAISE EXCEPTION 'runtime role frontdesk_app must not hold elevated attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) THEN
    RAISE EXCEPTION 'runtime role frontdesk_app must not be a member of other roles';
  END IF;
  IF current_user = 'frontdesk_app' THEN
    RAISE EXCEPTION 'migrations must not run as the runtime role';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'audit_logs is append-only and immutable';
END;
$$;
CREATE TRIGGER trg_audit_logs_immutable
BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();
CREATE TRIGGER trg_audit_logs_no_truncate
BEFORE TRUNCATE ON public.audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION public.prevent_audit_log_mutation();
REVOKE ALL ON TABLE public.audit_logs FROM PUBLIC, frontdesk_app;
GRANT SELECT, INSERT ON TABLE public.audit_logs TO frontdesk_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC, frontdesk_app;
GRANT USAGE ON SCHEMA public TO frontdesk_app;
-- Do not grant owner memberships, superuser, replication or ALTER permissions.
-- Verify inherited grants, column privileges, schema/database ownership separately.

-- Runtime grants: explicit, minimal. No DELETE/TRUNCATE anywhere; append-only tables get no UPDATE.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, frontdesk_app;
GRANT SELECT, INSERT ON TABLE public.audit_logs TO frontdesk_app;
GRANT SELECT ON TABLE public."User", public."Holiday" TO frontdesk_app;
GRANT SELECT, INSERT ON TABLE public."Message" TO frontdesk_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public."Ticket", public."SlaClock", public."Session",
  public."RefreshToken", public."SweepInvocation", public."IdempotencyRecord" TO frontdesk_app;
