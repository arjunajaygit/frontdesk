-- Supabase provisioning for Frontdesk (run ONCE as the project's `postgres` role, BEFORE the first migration).
-- Keeps Supabase's own ownership intact (never ALTER DATABASE/SCHEMA OWNER on a Supabase project) and creates the
-- same two-role model as everywhere else: frontdesk_owner (migrations/seed only) and frontdesk_app (runtime).
-- Passwords arrive as psql variables, never in files or history:
--   psql "$SUPABASE_ADMIN_URL" -v owner_pw="$FRONTDESK_OWNER_PASSWORD" -v app_pw="$FRONTDESK_APP_PASSWORD" \
--        -v ON_ERROR_STOP=1 -f infrastructure/deploy/supabase/01-provision.sql
\set ON_ERROR_STOP on
CREATE ROLE frontdesk_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE frontdesk_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
  CONNECTION LIMIT 10 PASSWORD :'app_pw';
-- Migrations create (and therefore own) every Frontdesk object in `public`; the owner may pass on USAGE only.
GRANT USAGE ON SCHEMA public TO frontdesk_owner WITH GRANT OPTION;
GRANT CREATE ON SCHEMA public TO frontdesk_owner;
GRANT USAGE ON SCHEMA public TO frontdesk_app;
GRANT CONNECT ON DATABASE postgres TO frontdesk_owner, frontdesk_app;
-- TEMPORARY: the baseline migration begins with `CREATE SCHEMA IF NOT EXISTS "public"`, which PostgreSQL authorises
-- against database CREATE even though the schema exists. Revoked by 02-post-migrate.sql right after migrating;
-- 03-verify.sql fails if it is still present. (Editing the applied baseline would change its checksum everywhere.)
GRANT CREATE ON DATABASE postgres TO frontdesk_owner;
-- Objects created by frontdesk_owner never receive Supabase's default API grants (those are defined FOR ROLE
-- postgres / supabase_admin); 02-verify.sql proves it after migrating. PUBLIC function EXECUTE is revoked by the
-- migration 20261122000000_function_execute_hardening (portable to every environment).
SELECT 'provisioned frontdesk_owner and frontdesk_app' AS result;
