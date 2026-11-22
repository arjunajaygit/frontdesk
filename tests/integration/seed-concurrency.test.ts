import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as argon2 from 'argon2';
import { Client } from 'pg';
import { credentialsFileFor } from '../../prisma/credentials';
import { AGENTS, CUSTOMERS } from '../../prisma/seed-data';
import { ROOT, dotenv, roleUrl, SEED_ANCHOR } from '../helpers/db';
import { dropDatabase, freshDatabase } from '../helpers/scratch';

/**
 * Final audit M02 on REAL PostgreSQL with REAL concurrent processes. Overlap is forced at the worst point: run A
 * has recorded its passwords in the credentials file and is blocked BEFORE inserting the users (a test transaction
 * holds a table lock that conflicts only with INSERT); run B is started while A is stalled. Both runs carry the
 * overwrite authorisation. Previously B would overwrite A's recorded passwords and A would then commit hashes for
 * passwords nobody knows. Now B must wait on the per-database advisory lock and create nothing.
 */
type Run = { status: number | null; stdout: string; stderr: string };
function startNode(args: string[], env: Record<string, string>) {
  const proc = spawn('npx', args, { cwd: ROOT, env: { ...process.env, ...dotenv(), ...env } });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => (stdout += d));
  proc.stderr.on('data', (d) => (stderr += d));
  const done = new Promise<Run>((resolve) =>
    proc.on('close', (status) => resolve({ status, stdout, stderr })),
  );
  return { proc, done };
}
async function waitFor(c: Client, sql: string, label: string, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await c.query(sql)).rowCount) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const BLOCKED_ON_INSERT = `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'INSERT INTO "public"."User"%'`;
const WAITING_ON_ADVISORY = `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;

async function verifyAll(c: Client, file: string) {
  const recorded = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
  const users = (await c.query(`SELECT email, "passwordHash" h FROM "User" ORDER BY email`))
    .rows as Array<{ email: string; h: string }>;
  expect(users).toHaveLength(AGENTS.length + CUSTOMERS.length);
  for (const u of users)
    expect({ email: u.email, verifies: await argon2.verify(u.h, recorded[u.email] ?? '') }).toEqual(
      { email: u.email, verifies: true },
    );
  return recorded;
}

describe('M02: concurrent credential-producing operations are serialised per database', () => {
  let db: string;
  let c: Client;
  let blocker: Client;
  const label = `it-${randomBytes(4).toString('hex')}`;
  const file = credentialsFileFor('unused', label);
  const seedEnv = () => ({
    MIGRATION_DATABASE_URL: roleUrl('owner', db),
    SEED_ANCHOR,
    SEED_CREDENTIALS: 'write',
    SEED_TARGET_LABEL: label,
    SEED_ALLOW_CREDENTIAL_OVERWRITE: 'true',
  });

  let n = 0;
  beforeEach(async () => {
    db = await freshDatabase(`seedlock${++n}`); // each scenario starts from its own empty database
    c = new Client({ connectionString: roleUrl('owner', db) });
    await c.connect();
    await c.query(`DELETE FROM "User"`);
    blocker = new Client({ connectionString: roleUrl('owner', db) });
    await blocker.connect();
  });
  afterEach(async () => {
    await blocker?.end().catch(() => undefined);
    await c?.end();
    rmSync(file, { force: true });
    rmSync(`${file}.lock`, { force: true });
    if (db) await dropDatabase(db);
  });

  it('overlap forced after A records passwords and before A inserts: B waits on the advisory lock and creates nothing; every recorded password matches its hash', async () => {
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`); // blocks INSERT, not SELECT
    const a = startNode(['tsx', 'prisma/seed.ts'], seedEnv());
    await waitFor(c, BLOCKED_ON_INSERT, 'run A to block on its user INSERT');
    const recordedByA = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    expect(Object.keys(recordedByA)).toHaveLength(AGENTS.length + CUSTOMERS.length); // A already wrote the file
    const b = startNode(['tsx', 'prisma/seed.ts'], seedEnv());
    await waitFor(c, WAITING_ON_ADVISORY, 'run B to wait on the credential advisory lock');
    await blocker.query('COMMIT'); // release: A inserts and commits, then B proceeds
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect({
      a: ra.status,
      b: rb.status,
      stderrA: ra.stderr.slice(-300),
      stderrB: rb.stderr.slice(-300),
    }).toMatchObject({ a: 0, b: 0 });
    expect(JSON.parse(ra.stdout.trim().split('\n').pop()!).usersCreated).toBe(
      AGENTS.length + CUSTOMERS.length,
    );
    expect(JSON.parse(rb.stdout.trim().split('\n').pop()!).usersCreated).toBe(0);
    const final = await verifyAll(c, file);
    expect(final).toEqual(recordedByA); // B never touched the recorded passwords
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('a run killed after recording passwords (before insertion) leaves no hashes and no lock; an authorised rerun completes consistently', async () => {
    await blocker.query('BEGIN');
    await blocker.query(`LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`);
    const a = startNode(['tsx', 'prisma/seed.ts'], seedEnv());
    await waitFor(c, BLOCKED_ON_INSERT, 'run A to block on its user INSERT');
    expect(existsSync(file)).toBe(true);
    // Hard interruption: kill the whole process tree (npx -> tsx -> node); PostgreSQL rolls back and frees the lock.
    const pids = (
      await c.query(
        `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'INSERT INTO "public"."User"%'`,
      )
    ).rows.map((r) => r.pid as number);
    a.proc.kill('SIGKILL');
    for (const pid of pids) await c.query('SELECT pg_terminate_backend($1)', [pid]); // the backend of the killed client
    await a.done;
    await blocker.query('COMMIT');
    expect((await c.query(`SELECT count(*)::int n FROM "User"`)).rows[0].n).toBe(0);
    expect(
      (await c.query(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory'`)).rows[0].n,
    ).toBe(0);
    const rerun = startNode(['tsx', 'prisma/seed.ts'], seedEnv());
    const r = await rerun.done;
    expect({ status: r.status, err: r.stderr.slice(-300) }).toMatchObject({ status: 0 });
    await verifyAll(c, file);
  });

  it('password reset uses the same lock: two overlapping resets -> one succeeds, the other refuses; recorded passwords match', async () => {
    const resetFile = credentialsFileFor(db);
    rmSync(resetFile, { force: true });
    const seeded = await startNode(['tsx', 'prisma/seed.ts'], {
      ...seedEnv(),
      SEED_CREDENTIALS: 'none',
    }).done;
    expect(seeded.status).toBe(0); // users exist (passwords unrecorded) — the situation a reset is for
    try {
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE "User" IN EXCLUSIVE MODE`); // blocks UPDATE, not SELECT
      const args = [
        'tsx',
        'scripts/reset-passwords.ts',
        '--db',
        db,
        '--confirm-reset-passwords-for',
        db,
      ];
      const r1 = startNode(args, {});
      await waitFor(
        c,
        `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE 'UPDATE "public"."User"%'`,
        'reset 1 to block on UPDATE',
      );
      const r2 = startNode(args, {});
      await waitFor(c, WAITING_ON_ADVISORY, 'reset 2 to wait on the advisory lock');
      await blocker.query('COMMIT');
      const [o1, o2] = await Promise.all([r1.done, r2.done]);
      expect([o1.status, o2.status].sort()).toEqual([0, 1]);
      expect((o1.status ? o1 : o2).stderr).toMatch(/refusing to overwrite/);
      await verifyAll(c, resetFile);
    } finally {
      rmSync(resetFile, { force: true });
    }
  });
});
