import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Client } from 'pg';
import { ROOT, connect, dotenv, roleUrl } from '../helpers/db';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/**
 * Final audit M03 with a REAL process and a REAL SIGTERM. The test holds row locks on SLA clocks so the scheduler's
 * ticket transaction is provably in flight (blocked inside PostgreSQL) when SIGTERM arrives; the locks are released
 * during the drain. Required: the in-flight transaction commits (ticket changes, audit, durable counters), the
 * invocation is terminal, the process exits by the re-raised signal, and a restart finds nothing to recover.
 * Previously Prisma disconnected (onModuleDestroy) before the scheduler drained (onApplicationShutdown).
 */
jest.setTimeout(180_000);

let db: string;
let owner: Client;
let observer: Client; // test-only superuser: other roles' query text in pg_stat_activity is hidden from non-superusers
const logs: string[] = [];

function startApi(extra: Record<string, string> = {}) {
  const env = dotenv();
  const port = String(39_500 + Math.floor(Math.random() * 400));
  const proc = spawn('node', ['apps/api/dist/main.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH!,
      NODE_ENV: 'development', // shutdown hooks are enabled outside tests (same code path as production)
      PORT: port,
      LOG_LEVEL: 'info',
      DATABASE_URL: roleUrl('app', db),
      PUBLIC_ORIGIN: 'http://localhost:5173',
      JWT_SECRET: env.JWT_SECRET!,
      CSRF_SIGNING_KEY: env.CSRF_SIGNING_KEY!,
      SWEEP_SCHEDULER_ENABLED: 'true',
      SWEEP_INTERVAL_MS: '5000',
      SWEEP_BATCH_SIZE: '50',
      ...extra,
    },
  });
  // Assemble complete lines across chunks: a pipe chunk can end mid-line, and splitting each chunk on its own lost
  // JSON log records that straddled a boundary (the cause of an intermittent CI failure of this test).
  const lines = (stream: NodeJS.ReadableStream) => {
    let rest = '';
    stream.on('data', (d) => {
      const parts = (rest + String(d)).split('\n');
      rest = parts.pop() ?? '';
      logs.push(...parts.filter(Boolean));
    });
    stream.on('end', () => {
      if (rest) logs.push(rest);
      rest = '';
    });
  };
  lines(proc.stdout!);
  lines(proc.stderr!);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    // 'close' (not 'exit'): fires only after stdout/stderr are fully read, so the final shutdown log is captured.
    proc.on('close', (code, signal) => resolve({ code, signal })),
  );
  return { proc, exited };
}
async function until(cond: () => Promise<boolean> | boolean, label: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out: ${label}\n${logs.slice(-15).join('\n')}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const logged = (msg: string) => logs.some((l) => l.includes(msg));
const BLOCKED_SWEEP = `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND usename = 'frontdesk_app' AND wait_event_type = 'Lock' AND query ILIKE '%"SlaClock"%FOR UPDATE%'`;

beforeAll(async () => {
  for (const ws of ['@frontdesk/contracts', '@frontdesk/api']) {
    const b = spawnSync('npm', ['run', 'build', '-w', ws], { cwd: ROOT, encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`build ${ws} failed: ${b.stderr}`);
  }
  db = await cloneTemplate('drain');
  owner = await connect('owner', db);
  observer = await connect('bootstrap', db);
});
afterAll(async () => {
  await owner?.end();
  await observer?.end();
  if (db) await dropDatabase(db);
});

describe('M03: SIGTERM while a real sweep transaction is in flight', () => {
  let proc: ChildProcess | undefined;
  afterEach(() => proc?.kill('SIGKILL'));

  it('drains: the blocked ticket transaction commits after SIGTERM; invocation terminal; exit by re-raised SIGTERM', async () => {
    // The historical seed is anchored in the (near) future relative to real DB time, so make FD-007's auto-close
    // cutoff genuinely past NOW (exactly as the other lifecycle tests do).
    const fd = await owner.query(
      `UPDATE "Ticket" SET "waitingSince" = now() - interval '10 days', "waitingCloseDueAt" = now() - interval '1 minute'
       WHERE subject LIKE '[FD-007]%' AND status = 'WAITING' RETURNING id`,
    );
    expect(fd.rowCount).toBe(1);

    const locker = new Client({ connectionString: roleUrl('owner', db) });
    locker.on('error', () => undefined); // terminated by the forced scratch-DB drop if the test fails early
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query(`SELECT id FROM "SlaClock" FOR UPDATE`); // every clock row: the first candidate will block
    const app = startApi();
    proc = app.proc;
    await until(() => logged('frontdesk started'), 'app start');
    await until(
      async () => (await observer.query(BLOCKED_SWEEP)).rowCount! > 0,
      'sweep transaction blocked in PostgreSQL',
    );
    app.proc.kill('SIGTERM'); // the ticket transaction is IN FLIGHT right now
    await new Promise((r) => setTimeout(r, 300));
    await locker.query('COMMIT'); // let it proceed during the drain (well inside its 2 s lock_timeout)
    await locker.end();
    const exit = await app.exited;
    expect(exit.signal === 'SIGTERM' || exit.code === 143).toBe(true);

    expect(logs.filter((l) => l.includes('scheduled maintenance step failed'))).toEqual([]);
    const shutdown = logs
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((j) => j?.msg?.startsWith('shutdown:'));
    expect(shutdown).toMatchObject({ signal: 'SIGTERM', inFlightTick: true, drained: true });
    const inv = (
      await owner.query(
        `SELECT id, state, processed, "autoClosed", "finishedAt" FROM "SweepInvocation" WHERE "actorType" = 'SYSTEM' ORDER BY "startedAt" DESC LIMIT 1`,
      )
    ).rows[0];
    expect(inv.state).toBe('COMPLETED');
    expect(inv.finishedAt).not.toBeNull();
    expect(inv.processed).toBeGreaterThanOrEqual(1); // durable counters written by the drained work
    const fd007 = (
      await owner.query(`SELECT status, "closeReason" FROM "Ticket" WHERE subject LIKE '[FD-007]%'`)
    ).rows[0];
    expect(fd007).toMatchObject({ status: 'CLOSED', closeReason: 'AUTO_CLOSED_NO_REPLY' }); // committed ticket change
    const audits = (
      await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE "sweepId" = $1`, [inv.id])
    ).rows[0].n;
    expect(audits).toBeGreaterThan(0); // and its audit trail, attributed to this invocation
  });

  it('restart after the drained shutdown: no RUNNING invocation to recover, the scheduler works again', async () => {
    logs.length = 0;
    const app = startApi();
    proc = app.proc;
    await until(() => logged('frontdesk started'), 'app restart');
    await until(() => logged('sla sweep finished'), 'a sweep after restart', 30_000);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int n FROM "SweepInvocation" WHERE state = 'RUNNING' AND "leaseUntil" < now()`,
        )
      ).rows[0].n,
    ).toBe(0);
    app.proc.kill('SIGTERM');
    const exit = await app.exited;
    expect(exit.signal === 'SIGTERM' || exit.code === 143).toBe(true);
  });
});
