-- Run ONCE against a NEW managed PostgreSQL as its admin/default user, BEFORE the first migration.
-- It provisions the two application roles and then reports whether the provider permits the security model.
-- Passwords are supplied as psql variables so they never appear in files or shell history:
--   psql "$ADMIN_URL" -v owner_pw="$FRONTDESK_OWNER_PASSWORD" -v app_pw="$FRONTDESK_APP_PASSWORD" -f infrastructure/deploy/preflight.sql
\set ON_ERROR_STOP on

CREATE ROLE frontdesk_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'owner_pw';
CREATE ROLE frontdesk_app   LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'app_pw';
-- Migrations (frontdesk_owner) need to own the schema objects in the target database:
SELECT format('ALTER DATABASE %I OWNER TO frontdesk_owner', current_database()) \gexec
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO frontdesk_app;
GRANT frontdesk_owner TO CURRENT_USER; -- some providers require the admin to be a member to SET ROLE / assign ownership

-- Capability report (read-only). Every line must say OK before deploying the application.
SELECT 'role frontdesk_app is not superuser / createrole / createdb / bypassrls / replication' AS check,
       CASE WHEN NOT (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication) THEN 'OK' ELSE 'FAIL' END AS result
FROM pg_roles WHERE rolname = 'frontdesk_app';
SELECT 'owner role may create objects in public' AS check, CASE WHEN has_schema_privilege('frontdesk_owner', 'public', 'CREATE') THEN 'OK' ELSE 'FAIL (grant CREATE on schema public to frontdesk_owner)' END AS result;
-- Managed platforms sometimes grant default privileges on new tables to API roles (e.g. Supabase anon/authenticated/service_role).
-- Any such grantee would bypass our audit/privacy design. This must list NOTHING unexpected:
SELECT 'default privileges granting table access to other roles' AS check,
       coalesce(string_agg(DISTINCT pg_get_userbyid(d.defaclrole) || ' -> ' || coalesce(a.grantee::regrole::text, 'PUBLIC'), '; '), 'OK (none)') AS result
FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a
WHERE d.defaclobjtype = 'r' AND a.grantee <> d.defaclrole;
SELECT 'roles that could read/write tables created later (review manually)' AS check,
       coalesce(string_agg(rolname, ', '), 'OK (none)') AS result
FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role', 'supabase_admin', 'authenticator');
