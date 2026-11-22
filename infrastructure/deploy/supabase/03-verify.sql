-- Post-migration verification (run as `postgres` after migrate deploy and 02-post-migrate.sql).
-- Every row must read OK. Read-only.
SELECT 'frontdesk_app attributes are restricted' AS check,
  CASE WHEN NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND NOT rolreplication
       THEN 'OK' ELSE 'FAIL' END AS result FROM pg_roles WHERE rolname = 'frontdesk_app'
UNION ALL
SELECT 'frontdesk_app is a member of no role',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'frontdesk_app')
       THEN 'OK' ELSE 'FAIL' END
UNION ALL
SELECT 'every Frontdesk table is owned by frontdesk_owner',
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public'
         AND tablename IN ('User','Ticket','Message','SlaClock','audit_logs','Session','RefreshToken','SweepInvocation','IdempotencyRecord','Holiday','_prisma_migrations')
         AND tableowner <> 'frontdesk_owner') THEN 'OK' ELSE 'FAIL' END
UNION ALL
SELECT 'no Supabase API role (anon/authenticated/service_role) or PUBLIC holds any privilege on Frontdesk tables',
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants g
    WHERE g.table_schema = 'public' AND g.grantee IN ('anon','authenticated','service_role','PUBLIC')
      AND g.table_name IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'frontdesk_owner'))
  THEN 'OK' ELSE 'FAIL' END
UNION ALL
SELECT 'no Frontdesk function is executable by PUBLIC or API roles',
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE n.nspname = 'public' AND o.rolname = 'frontdesk_owner' AND a.privilege_type = 'EXECUTE'
      AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role'))))
  THEN 'OK' ELSE 'FAIL' END
UNION ALL
SELECT 'append-only triggers present and enabled on audit_logs',
  CASE WHEN (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.audit_logs'::regclass AND NOT tgisinternal AND tgenabled <> 'D') >= 2
       THEN 'OK' ELSE 'FAIL' END
UNION ALL
SELECT 'frontdesk_app cannot UPDATE/DELETE/TRUNCATE audit_logs',
  CASE WHEN NOT has_table_privilege('frontdesk_app', 'public.audit_logs', 'UPDATE')
        AND NOT has_table_privilege('frontdesk_app', 'public.audit_logs', 'DELETE')
        AND NOT has_table_privilege('frontdesk_app', 'public.audit_logs', 'TRUNCATE') THEN 'OK' ELSE 'FAIL' END
UNION ALL
SELECT 'frontdesk_app cannot create objects in public or the database',
  CASE WHEN NOT has_schema_privilege('frontdesk_app', 'public', 'CREATE')
        AND NOT has_database_privilege('frontdesk_app', current_database(), 'CREATE') THEN 'OK' ELSE 'FAIL' END
UNION ALL
SELECT 'frontdesk_owner no longer holds database CREATE (temporary migration grant revoked)',
  CASE WHEN NOT has_database_privilege('frontdesk_owner', current_database(), 'CREATE') THEN 'OK' ELSE 'FAIL' END;
