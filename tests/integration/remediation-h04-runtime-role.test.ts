import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { connect, dotenv, roleUrl, withDatabase } from '../helpers/db';
import { startApp } from '../helpers/http';
import { Browser } from '../helpers/http';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/**
 * The app must refuse to start unless the EFFECTIVE database identity is a restricted runtime role.
 * Test roles are created by the test-only bootstrap superuser inside the dedicated Frontdesk cluster and are
 * always dropped afterwards (names are run-unique).
 */
let db: string;
let boot: Client;
const suffix = randomBytes(3).toString('hex');
const roles: string[] = [];
const pw = randomBytes(18).toString('base64url');

async function role(name: string, setup: string[]): Promise<string> {
  const r = `frontdesk_it_${name}_${suffix}`;
  roles.push(r);
  await boot.query(`CREATE ROLE ${r} LOGIN NOINHERIT PASSWORD '${pw}'`);
  const inDb = await connect('bootstrap', db);
  try {
    await inDb.query(`GRANT CONNECT ON DATABASE ${db} TO ${r}`);
    await inDb.query(`GRANT USAGE ON SCHEMA public TO ${r}`);
    // Mirror the exact runtime grants of frontdesk_app ...
    await inDb.query(`GRANT SELECT, INSERT ON public.audit_logs TO ${r}`);
    await inDb.query(`GRANT SELECT ON public."User", public."Holiday" TO ${r}`);
    await inDb.query(`GRANT SELECT, INSERT ON public."Message" TO ${r}`);
    await inDb.query(
      `GRANT SELECT, INSERT, UPDATE ON public."Ticket", public."SlaClock", public."SweepInvocation" TO ${r}`,
    );
    await inDb.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public."Session", public."RefreshToken", public."IdempotencyRecord" TO ${r}`,
    );
    for (const s of setup) await inDb.query(s.replaceAll('$ROLE', r));
  } finally {
    await inDb.end();
  }
  return r;
}
const urlFor = (r: string, password = pw) => {
  const u = new URL(withDatabase(dotenv().MIGRATION_DATABASE_URL!, db));
  u.username = r;
  u.password = password;
  return u.toString();
};
async function bootWith(env: Record<string, string>): Promise<{ ok: boolean; message: string }> {
  try {
    const app = await startApp(db, env);
    const ready = await new Browser(app.server).get('/api/readyz');
    await app.close();
    return { ok: ready.status === 200, message: '' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

beforeAll(async () => {
  db = await cloneTemplate('h04');
  boot = await connect('bootstrap', 'frontdesk');
});
afterAll(async () => {
  try {
    if (db) await dropDatabase(db); // removes every in-database grant held by the test roles
  } finally {
    for (const r of roles) await boot?.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
    await boot?.end();
  }
});

describe('startup verifies the effective runtime identity and privileges', () => {
  it('the intended restricted runtime role starts and is ready', async () => {
    expect(await bootWith({})).toEqual({ ok: true, message: '' });
  });

  it('migration-owner credentials are rejected by config (layer 1) AND by the privilege check (layer 2)', async () => {
    expect((await bootWith({ DATABASE_URL: roleUrl('owner', db) })).message).toMatch(/must differ/);
    // Distinct migration user so the config check passes and the privilege check itself must reject the owner.
    // (UNSET would be undone: the Prisma client auto-loads missing variables from .env on import.)
    const r = await bootWith({
      DATABASE_URL: roleUrl('owner', db),
      MIGRATION_DATABASE_URL: roleUrl('bootstrap', db),
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/UNEXPECTED_ROLE/);
    expect(r.message).toMatch(/OWNS_OBJECTS/);
    expect(r.message).not.toContain(dotenv().FRONTDESK_OWNER_PASSWORD!);
  });

  it('superuser credentials are rejected', async () => {
    const r = await bootWith({
      DATABASE_URL: roleUrl('bootstrap', db),
      DATABASE_RUNTIME_ROLE: 'frontdesk_bootstrap',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/SUPERUSER/);
  });

  it('an equivalent explicitly configured restricted role is accepted only because it passes every check', async () => {
    const r = await role('equiv', []);
    expect(await bootWith({ DATABASE_URL: urlFor(r), DATABASE_RUNTIME_ROLE: r })).toEqual({
      ok: true,
      message: '',
    });
    expect((await bootWith({ DATABASE_URL: urlFor(r) })).message).toMatch(/UNEXPECTED_ROLE/); // not the configured name
  });

  it('an artificially over-privileged role (member of the owner role) is rejected', async () => {
    const r = await role('member', []);
    await boot.query(`GRANT frontdesk_owner TO ${r}`);
    const res = await bootWith({ DATABASE_URL: urlFor(r), DATABASE_RUNTIME_ROLE: r });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/ROLE_MEMBERSHIP/);
    await boot.query(`REVOKE frontdesk_owner FROM ${r}`);
  });

  it.each([
    ['audit UPDATE', 'GRANT UPDATE ON public.audit_logs TO $ROLE', /PROHIBITED_UPDATE_AUDIT_LOGS/],
    [
      'audit TRUNCATE',
      'GRANT TRUNCATE ON public.audit_logs TO $ROLE',
      /PROHIBITED_TRUNCATE_AUDIT_LOGS/,
    ],
    ['message DELETE', 'GRANT DELETE ON public."Message" TO $ROLE', /PROHIBITED_DELETE_MESSAGE/],
    [
      'audit column UPDATE',
      'GRANT UPDATE (details) ON public.audit_logs TO $ROLE',
      /AUDIT_COLUMN_UPDATE/,
    ],
    ['schema CREATE', 'GRANT CREATE ON SCHEMA public TO $ROLE', /SCHEMA_CREATE/],
    ['CREATEDB attribute', 'ALTER ROLE $ROLE CREATEDB', /CREATEDB/],
  ])(
    'an expected-looking role with an unsafe extra grant (%s) is rejected',
    async (_n, grant, code) => {
      const r = await role(`x${roles.length}`, [grant]);
      const res = await bootWith({ DATABASE_URL: urlFor(r), DATABASE_RUNTIME_ROLE: r });
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(code);
    },
  );

  it('a disabled audit trigger makes even the correct runtime role unsafe', async () => {
    const c = await connect('owner', db);
    try {
      await c.query('ALTER TABLE public.audit_logs DISABLE TRIGGER trg_audit_logs_immutable');
      expect((await bootWith({})).message).toMatch(/AUDIT_TRIGGERS_MISSING_OR_DISABLED/);
    } finally {
      await c.query('ALTER TABLE public.audit_logs ENABLE TRIGGER trg_audit_logs_immutable');
      await c.end();
    }
    expect((await bootWith({})).ok).toBe(true);
  });
});
