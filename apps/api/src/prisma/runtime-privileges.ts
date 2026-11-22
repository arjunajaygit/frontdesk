import type { PrismaClient } from '@prisma/client';

/**
 * The application must run as a RESTRICTED runtime role, otherwise database-enforced audit immutability
 * is meaningless. Verified against the live connection's EFFECTIVE privileges at startup (fail closed).
 * Violations are stable codes only — no credentials, hostnames or SQL are ever included.
 */
export class RuntimePrivilegeError extends Error {
  constructor(readonly violations: string[]) {
    super(`Database runtime role is not safely restricted: ${violations.join(', ')}`);
    this.name = 'RuntimePrivilegeError';
  }
}

/** Privileges the runtime role must NOT hold (least privilege beyond what the application needs). */
const PROHIBITED: [string, string][] = [
  ...['audit_logs', 'Ticket', 'Message', 'SlaClock', 'User', 'Holiday', 'SweepInvocation'].flatMap((t): [string, string][] => [
    [t, 'DELETE'],
    [t, 'TRUNCATE'],
    [t, 'TRIGGER'],
    [t, 'REFERENCES'],
  ]),
  ...['IdempotencyRecord', 'RefreshToken', 'Session'].flatMap((t): [string, string][] => [
    [t, 'TRUNCATE'],
    [t, 'TRIGGER'],
    [t, 'REFERENCES'],
  ]),
  ['audit_logs', 'UPDATE'],
  ['Message', 'UPDATE'],
  ['User', 'UPDATE'],
  ['Holiday', 'UPDATE'],
  ['User', 'INSERT'],
  ['Holiday', 'INSERT'],
];
const REQUIRED: [string, string][] = [
  ['audit_logs', 'SELECT'],
  ['audit_logs', 'INSERT'],
  ['Ticket', 'UPDATE'],
  ['SlaClock', 'UPDATE'],
];

interface Facts {
  role: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  memberships: number;
  owned: number;
  owns_schema: boolean;
  owns_database: boolean;
  schema_create: boolean;
  db_create: boolean;
  audit_column_update: number;
  triggers_enabled: number;
}

export async function verifyRuntimePrivileges(db: PrismaClient, expectedRole: string): Promise<string[]> {
  const [f] = await db.$queryRaw<Facts[]>`
    SELECT current_user::text AS role, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
      (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::int AS memberships,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relowner = r.oid)::int AS owned,
      (SELECT nspowner = r.oid FROM pg_namespace WHERE nspname = 'public') AS owns_schema,
      (SELECT datdba = r.oid FROM pg_database WHERE datname = current_database()) AS owns_database,
      has_schema_privilege('public', 'CREATE') AS schema_create,
      has_database_privilege(current_database(), 'CREATE') AS db_create,
      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid = 'public.audit_logs'::regclass AND a.attnum > 0
         AND NOT a.attisdropped AND has_column_privilege('public.audit_logs', a.attname, 'UPDATE'))::int AS audit_column_update,
      (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.audit_logs'::regclass AND t.tgenabled <> 'D'
         AND t.tgname IN ('trg_audit_logs_immutable', 'trg_audit_logs_no_truncate'))::int AS triggers_enabled
    FROM pg_roles r WHERE r.rolname = current_user`;
  if (!f) return ['ROLE_NOT_FOUND'];
  const v: string[] = [];
  if (f.role !== expectedRole) v.push('UNEXPECTED_ROLE');
  if (f.rolsuper) v.push('SUPERUSER');
  if (f.rolcreaterole) v.push('CREATEROLE');
  if (f.rolcreatedb) v.push('CREATEDB');
  if (f.rolreplication) v.push('REPLICATION');
  if (f.rolbypassrls) v.push('BYPASSRLS');
  if (f.memberships > 0) v.push('ROLE_MEMBERSHIP');
  if (f.owned > 0) v.push('OWNS_OBJECTS');
  if (f.owns_schema) v.push('OWNS_SCHEMA');
  if (f.owns_database) v.push('OWNS_DATABASE');
  if (f.schema_create) v.push('SCHEMA_CREATE');
  if (f.db_create) v.push('DATABASE_CREATE');
  if (f.audit_column_update > 0) v.push('AUDIT_COLUMN_UPDATE');
  if (f.triggers_enabled !== 2) v.push('AUDIT_TRIGGERS_MISSING_OR_DISABLED');
  const checks = [...PROHIBITED.map(([t, p]) => ({ t, p, want: false })), ...REQUIRED.map(([t, p]) => ({ t, p, want: true }))];
  const rows = await db.$queryRaw<{ t: string; p: string; has: boolean }[]>`
    SELECT x.t, x.p, has_table_privilege(format('public.%I', x.t), x.p) AS has
    FROM jsonb_to_recordset(${JSON.stringify(checks.map(({ t, p }) => ({ t, p })))}::jsonb) AS x(t text, p text)`;
  for (const r of rows) {
    const want = checks.find((c) => c.t === r.t && c.p === r.p)!.want;
    if (r.has !== want) v.push(`${want ? 'MISSING' : 'PROHIBITED'}_${r.p}_${r.t.toUpperCase()}`);
  }
  return [...new Set(v)];
}
