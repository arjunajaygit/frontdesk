-- Executed in migration 20261121000200_audit_immutability_and_grants (keep in sync; drift test enforces).
-- public schema assumed; migration owner owns table/function, frontdesk_app is non-owner.
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
