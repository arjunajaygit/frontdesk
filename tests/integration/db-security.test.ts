import { Client } from 'pg';
import { connect, expectPgError, rolledBack, scratchName } from '../helpers/db';

const TABLES = [
  'User',
  'Ticket',
  'SlaClock',
  'Message',
  'audit_logs',
  'Holiday',
  'Session',
  'RefreshToken',
  'SweepInvocation',
  'IdempotencyRecord',
];
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
// Explicit least-privilege expectation for frontdesk_app (see migration 20261121000200).
// Explicit least-privilege expectation for frontdesk_app (migrations 20261121000200 + 20261121000300).
// DELETE exists ONLY on the three retention-purged, non-audit tables; never on audit/ticket/message/clock tables.
const EXPECTED: Record<string, string[]> = {
  User: ['SELECT'],
  Holiday: ['SELECT'],
  Message: ['SELECT', 'INSERT'],
  audit_logs: ['SELECT', 'INSERT'],
  Ticket: ['SELECT', 'INSERT', 'UPDATE'],
  SlaClock: ['SELECT', 'INSERT', 'UPDATE'],
  Session: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  RefreshToken: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  SweepInvocation: ['SELECT', 'INSERT', 'UPDATE'],
  IdempotencyRecord: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
};
const IMMUTABLE_MSG = 'audit_logs is append-only and immutable';
const auditDigest = async (c: Client) =>
  (
    await c.query(
      `SELECT count(*)::int n, md5(string_agg(t::text, '|' ORDER BY id)) h FROM audit_logs t`,
    )
  ).rows[0] as { n: number; h: string };

describe('audit immutability foundation: ownership, effective privileges, audit immutability', () => {
  let owner: Client, app: Client, boot: Client;
  beforeAll(async () => {
    [owner, app, boot] = await Promise.all([
      connect('owner'),
      connect('app'),
      connect('bootstrap'),
    ]);
  });
  afterAll(async () => {
    await Promise.all([owner?.end(), app?.end(), boot?.end()]);
  });

  it('connections are really made as the intended roles', async () => {
    expect((await owner.query('SELECT current_user u')).rows[0].u).toBe('frontdesk_owner');
    expect((await app.query('SELECT current_user u')).rows[0].u).toBe('frontdesk_app');
    expect((await owner.query('SELECT current_database() d')).rows[0].d).toBe(scratchName());
  });

  it('schema objects are owned by the migration owner; the runtime role owns nothing', async () => {
    const rel =
      await owner.query(`SELECT c.relname, r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S','v','m','p')`);
    expect(rel.rowCount).toBeGreaterThanOrEqual(TABLES.length);
    for (const row of rel.rows)
      expect({ rel: row.relname, owner: row.rolname }).toEqual({
        rel: row.relname,
        owner: 'frontdesk_owner',
      });
    const fn = await owner.query(
      `SELECT r.rolname FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname='prevent_audit_log_mutation'`,
    );
    expect(fn.rows.map((r) => r.rolname)).toEqual(['frontdesk_owner']);
    const ns = await owner.query(
      `SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='public'`,
    );
    expect(ns.rows[0].rolname).not.toBe('frontdesk_app');
    const db = await owner.query(
      `SELECT r.rolname FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database()`,
    );
    expect(db.rows[0].rolname).toBe('frontdesk_owner');
    const owned =
      await owner.query(`SELECT count(*)::int n FROM pg_shdepend s JOIN pg_roles r ON r.oid=s.refobjid
      WHERE r.rolname='frontdesk_app' AND s.deptype='o'`);
    expect(owned.rows[0].n).toBe(0);
  });

  it('runtime role has no elevated attributes, memberships or schema CREATE', async () => {
    const r = (
      await owner.query(`SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolinherit, rolcanlogin
      FROM pg_roles WHERE rolname='frontdesk_app'`)
    ).rows[0];
    expect(r).toEqual({
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolbypassrls: false,
      rolreplication: false,
      rolinherit: false,
      rolcanlogin: true,
    });
    const members = await owner.query(
      `SELECT count(*)::int n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='frontdesk_app'`,
    );
    expect(members.rows[0].n).toBe(0);
    const s = (
      await app.query(`SELECT has_schema_privilege('public','CREATE') c, has_schema_privilege('public','USAGE') u,
      has_database_privilege(current_database(),'CREATE') dc, pg_has_role(current_user,'frontdesk_owner','MEMBER') m`)
    ).rows[0];
    expect(s).toEqual({ c: false, u: true, dc: false, m: false });
  });

  it('effective table privileges for the runtime role match the explicit least-privilege matrix', async () => {
    for (const t of TABLES) {
      for (const p of PRIVS) {
        const has = (
          await app.query(
            `SELECT has_table_privilege('frontdesk_app', format('public.%I', $1::text), $2) h`,
            [t, p],
          )
        ).rows[0].h as boolean;
        expect({ t, p, has }).toEqual({ t, p, has: EXPECTED[t]!.includes(p) });
      }
    }
  });

  it('no PUBLIC grants and no column-level UPDATE on audit_logs; _prisma_migrations is inaccessible', async () => {
    const pub = await owner.query(`SELECT c.relname FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.relnamespace='public'::regnamespace AND a.grantee=0 AND c.relkind='r'`);
    expect(pub.rows).toEqual([]);
    const cols = (
      await owner.query(
        `SELECT attname FROM pg_attribute WHERE attrelid='public.audit_logs'::regclass AND attnum>0 AND NOT attisdropped`,
      )
    ).rows;
    for (const { attname } of cols) {
      const h = (
        await app.query(
          `SELECT has_column_privilege('frontdesk_app','public.audit_logs',$1,'UPDATE') h`,
          [attname],
        )
      ).rows[0].h;
      expect({ attname, h }).toEqual({ attname, h: false });
    }
    const e = await expectPgError(app, 'SELECT 1 FROM _prisma_migrations LIMIT 1');
    expect(e.code).toBe('42501');
  });

  it('runtime role cannot alter schema, disable triggers, drop audit objects or assume the owner role', async () => {
    const statements = [
      'ALTER TABLE public.audit_logs DISABLE TRIGGER trg_audit_logs_immutable',
      'ALTER TABLE public.audit_logs DISABLE TRIGGER ALL',
      'DROP TRIGGER trg_audit_logs_immutable ON public.audit_logs',
      'DROP TABLE public.audit_logs',
      'CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
      'CREATE TABLE public.evil (id int)',
      'SET ROLE frontdesk_owner',
      'ALTER TABLE public.audit_logs OWNER TO frontdesk_app',
    ];
    for (const sql of statements) {
      const e = await expectPgError(app, sql).catch(() => {
        throw new Error(`runtime role was able to run: ${sql}`);
      });
      expect({ sql, code: e.code }).toEqual({ sql, code: '42501' }); // insufficient_privilege (also for ownership-gated DDL)
    }
  });

  it('runtime role cannot self-grant: PostgreSQL only warns, and no privilege is actually gained', async () => {
    await rolledBack(app, async () => {
      await app.query('GRANT UPDATE, DELETE, TRUNCATE ON public.audit_logs TO frontdesk_app'); // warning 01007, no error
      const r = (
        await app.query(`SELECT has_table_privilege('public.audit_logs','UPDATE') u, has_table_privilege('public.audit_logs','DELETE') d,
        has_table_privilege('public.audit_logs','TRUNCATE') t`)
      ).rows[0];
      expect(r).toEqual({ u: false, d: false, t: false });
    });
  });

  describe('append-only audit_logs', () => {
    let before: { n: number; h: string };
    beforeAll(async () => {
      before = await auditDigest(owner);
    });

    it('runtime role: UPDATE, DELETE and TRUNCATE are denied by privileges (42501)', async () => {
      for (const sql of [
        `UPDATE audit_logs SET action='X'`,
        'DELETE FROM audit_logs',
        'TRUNCATE audit_logs',
        'TRUNCATE audit_logs CASCADE',
      ]) {
        const e = await expectPgError(app, sql);
        expect({ sql, code: e.code }).toEqual({ sql, code: '42501' });
      }
    });

    it.each([['owner'], ['bootstrap']] as const)(
      'privileged role %s: UPDATE, DELETE and TRUNCATE are rejected by triggers',
      async (who) => {
        const c = who === 'owner' ? owner : boot;
        for (const sql of [
          `UPDATE audit_logs SET action='TAMPERED'`,
          `UPDATE audit_logs SET details='{}'::jsonb WHERE true`,
          'DELETE FROM audit_logs',
          `DELETE FROM audit_logs WHERE action='TICKET_CREATED'`,
          'TRUNCATE audit_logs',
          'TRUNCATE audit_logs, "Ticket" CASCADE',
        ]) {
          await c.query('BEGIN');
          const e = (await c.query(sql).then(
            () => null,
            (err) => err,
          )) as { code: string; message: string } | null;
          await c.query('ROLLBACK');
          expect({ who, sql, rejected: e !== null }).toEqual({ who, sql, rejected: true });
          expect(e!.message).toContain(IMMUTABLE_MSG);
          expect(e!.code).toBe('P0001');
        }
      },
    );

    it('protected audit rows are unchanged after every attempted mutation', async () => {
      expect(await auditDigest(owner)).toEqual(before);
      expect(before.n).toBeGreaterThan(50);
    });

    it('runtime role can INSERT with actor attribution, and an aborted transaction leaves no ticket/audit rows', async () => {
      const cust = (await app.query(`SELECT id FROM "User" WHERE role='CUSTOMER' LIMIT 1`)).rows[0]
        .id;
      const agent = (await app.query(`SELECT id FROM "User" WHERE role='AGENT' LIMIT 1`)).rows[0]
        .id;
      const tid = '11111111-0000-4000-8000-000000000001';
      await rolledBack(app, async () => {
        await app.query(
          `INSERT INTO "Ticket"(id,subject,"customerId",priority,"createdAt","updatedAt") VALUES ($1,'tx-proof',$2,'LOW',now(),now())`,
          [tid, cust],
        );
        await app.query(
          `INSERT INTO audit_logs(id,target,"ticketId","correlationId","actorType","actorId",action,details,"eventKey")
          VALUES (gen_random_uuid(),'TICKET',$1,'corr','AGENT',$2,'TICKET_CREATED','{}','tx-proof-1')`,
          [tid, agent],
        );
        const inside = (
          await app.query(
            `SELECT (SELECT count(*) FROM "Ticket" WHERE id=$1)::int t, (SELECT count(*) FROM audit_logs WHERE "eventKey"='tx-proof-1')::int a`,
            [tid],
          )
        ).rows[0];
        expect(inside).toEqual({ t: 1, a: 1 });
      });
      const after = (
        await owner.query(
          `SELECT (SELECT count(*) FROM "Ticket" WHERE id=$1)::int t, (SELECT count(*) FROM audit_logs WHERE "eventKey"='tx-proof-1')::int a`,
          [tid],
        )
      ).rows[0];
      expect(after).toEqual({ t: 0, a: 0 });
      expect(await auditDigest(owner)).toEqual(before);
    });

    it('a failing business statement aborts the whole transaction including its audit insert', async () => {
      const cust = (await app.query(`SELECT id FROM "User" WHERE role='CUSTOMER' LIMIT 1`)).rows[0]
        .id;
      const tid = '11111111-0000-4000-8000-000000000002';
      await app.query('BEGIN');
      await app.query(
        `INSERT INTO "Ticket"(id,subject,"customerId",priority,"createdAt","updatedAt") VALUES ($1,'tx-proof-2',$2,'LOW',now(),now())`,
        [tid, cust],
      );
      await app.query(
        `INSERT INTO audit_logs(id,target,"ticketId","correlationId","actorType",action,details,"eventKey") VALUES (gen_random_uuid(),'TICKET',$1,'c','SYSTEM','X','{}','tx-proof-2')`,
        [tid],
      );
      // violates ticket_state_fields (OPEN with an assignee)
      const failure = await app
        .query(
          `UPDATE "Ticket" SET "assigneeId"=(SELECT id FROM "User" WHERE role='AGENT' LIMIT 1) WHERE id=$1`,
          [tid],
        )
        .then(
          () => null,
          (e) => e,
        );
      expect(failure?.code).toBe('23514');
      await app.query('ROLLBACK');
      const n = (
        await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE "eventKey"='tx-proof-2'`)
      ).rows[0].n;
      expect(n).toBe(0);
    });

    it('trusted-owner boundary (documented, not a tamper-proof claim): the owner can disable the trigger via DDL', async () => {
      await rolledBack(owner, async () => {
        await owner.query('ALTER TABLE public.audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
        const r = await owner.query(`DELETE FROM audit_logs WHERE "eventKey"='seed:FD-001:0'`);
        expect(r.rowCount).toBe(1); // proves the boundary exists; rolled back below
      });
      expect(await auditDigest(owner)).toEqual(before);
    });
  });
});
