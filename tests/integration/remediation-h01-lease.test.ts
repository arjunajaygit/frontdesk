import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { sweepKey } from '../../apps/api/src/domain/sweep/sweep-policy';
import type { InvocationLease } from '../../apps/api/src/domain/sweep/sweep-runner';
import { LeaseWriteOp, PgSweepStore } from '../../apps/api/src/infrastructure/sweep/pg-sweep-store';
import { PrismaService } from '../../apps/api/src/prisma/prisma.service';
import { PgSweepTicketProcessor } from '../../apps/api/src/sweep/sweep-ticket.processor';
import { connect, roleUrl } from '../helpers/db';
import { signedIn, startApp, TestApp } from '../helpers/http';
import { LockHolder, Observer } from '../helpers/observe';
import { dropDatabase, freshDatabase } from '../helpers/scratch';

/**
 * Lease fencing: every lease-sensitive write is fenced by a guarded UPDATE evaluated with the statement's own
 * advancing clock_timestamp(). A test-only hook pauses the worker AFTER it holds the invocation row lock and
 * BEFORE the guarded write, until PostgreSQL's clock has passed leaseUntil (deterministic, DB-time barrier).
 */
let db: string;
let prisma: PrismaClient;
let owner: Client;
let observer: Observer;
let plan: { op: LeaseWriteOp; action: () => Promise<void> } | null = null;
const hooks = {
  beforeLeaseWrite: async (op: LeaseWriteOp) =>
    plan && plan.op === op ? plan.action() : undefined,
};
let store: PgSweepStore;

beforeAll(async () => {
  db = await freshDatabase('h01');
  prisma = new PrismaClient({ datasources: { db: { url: roleUrl('app', db) } } });
  store = new PgSweepStore(prisma, hooks);
  owner = await connect('owner', db);
  observer = await Observer.open(db);
});
afterAll(async () => {
  await prisma?.$disconnect();
  await owner?.end();
  await observer?.close();
  await dropDatabase(db);
});
afterEach(() => {
  plan = null;
});

const row = async (id: string) =>
  (await owner.query(`SELECT * FROM "SweepInvocation" WHERE id=$1`, [id])).rows[0];
const audits = async (id: string) =>
  (
    await owner.query(
      `SELECT action FROM audit_logs WHERE "sweepId"=$1 ORDER BY "createdAt", "eventKey"`,
      [id],
    )
  ).rows.map((r) => r.action);
let n = 0;
async function reserve(leaseMs = 700): Promise<InvocationLease> {
  const r = await store.reserve({
    initiator: { type: 'SYSTEM' },
    key: sweepKey({ type: 'SYSTEM' }, `h01-${Date.now()}-${n++}`),
    requestHash: 'sha256:h01',
    correlationId: `h01-${n}`,
    leaseMs,
  });
  if (r.kind !== 'RESERVED') throw new Error(r.kind);
  return r.lease;
}
/** Pause inside the worker's transaction until DB time is strictly past leaseUntil. */
const expireDuring = (op: LeaseWriteOp, lease: InvocationLease) => {
  plan = { op, action: async () => observer.untilDbTimeAfter((await row(lease.id)).leaseUntil) };
};

describe('lease expiry between verification and the write is fenced in the write itself', () => {
  it('renewal: expires after the lock is held, before renewal -> false, leaseUntil unchanged', async () => {
    const lease = await reserve();
    const before = (await row(lease.id)).leaseUntil.getTime();
    expireDuring('refresh', lease);
    expect(await store.refreshLease(lease, 30_000)).toBe(false);
    expect((await row(lease.id)).leaseUntil.getTime()).toBe(before);
    expect((await row(lease.id)).state).toBe('RUNNING');
  });

  it('failure counter: expires before the update -> false, failed unchanged', async () => {
    const lease = await reserve();
    expireDuring('failure', lease);
    expect(await store.recordFailure(lease)).toBe(false);
    expect((await row(lease.id)).failed).toBe(0);
  });

  it('successful terminal write: expires before COMPLETED -> FENCED, no SWEEP_FINISHED event', async () => {
    const lease = await reserve();
    expireDuring('finish', lease);
    expect(await store.finish(lease, false)).toEqual({ kind: 'FENCED' });
    expect((await row(lease.id)).state).toBe('RUNNING');
    expect(await audits(lease.id)).toEqual(['SWEEP_STARTED']);
  });

  it('failed terminal write: expires before FAILED -> FENCED, no SWEEP_FAILED event', async () => {
    const lease = await reserve();
    expireDuring('fail', lease);
    expect(await store.fail(lease, 'SWEEP_FAILED')).toEqual({ kind: 'FENCED' });
    expect((await row(lease.id)).responseStatus).toBeNull();
    expect(await audits(lease.id)).toEqual(['SWEEP_STARTED']);
  });

  it('lease expires while the worker WAITS for the invocation row lock -> fenced after acquiring it', async () => {
    const lease = await reserve();
    const holder = await LockHolder.hold(
      db,
      `SELECT id FROM "SweepInvocation" WHERE id=$1 FOR UPDATE`,
      [lease.id],
    );
    const pending = store.refreshLease(lease, 30_000);
    await observer.waitForLockWaiters('%FROM "SweepInvocation"%FOR UPDATE%', 1);
    await observer.untilDbTimeAfter((await row(lease.id)).leaseUntil);
    await holder.release(); // row unchanged by the holder: a pre-wait qualifier would wrongly still pass
    expect(await pending).toBe(false);
  });

  it('stale worker after recovery: exactly one SWEEP_RECOVERED, counters preserved, every later write fenced', async () => {
    const lease = await reserve(30_000);
    await owner.query(
      `UPDATE "SweepInvocation" SET processed=2, "breachesRecorded"=1 WHERE id=$1`,
      [lease.id],
    ); // committed progress
    await owner.query(
      `UPDATE "SweepInvocation" SET "startedAt" = now() - interval '1 minute', "leaseUntil" = now() - interval '1 second' WHERE id=$1`,
      [lease.id],
    );
    expect(await store.recoverExpired(50)).toBeGreaterThanOrEqual(1);
    expect(await store.recoverExpired(50)).toBe(0);
    expect(await store.refreshLease(lease, 30_000)).toBe(false);
    expect(await store.recordFailure(lease)).toBe(false);
    expect(await store.finish(lease, false)).toEqual({ kind: 'FENCED' });
    expect(await store.fail(lease, 'SWEEP_FAILED')).toEqual({ kind: 'FENCED' });
    const r = await row(lease.id);
    expect({
      state: r.state,
      status: r.responseStatus,
      processed: r.processed,
      breaches: r.breachesRecorded,
      failed: r.failed,
    }).toEqual({ state: 'FAILED', status: 503, processed: 2, breaches: 1, failed: 0 });
    expect(await audits(lease.id)).toEqual(['SWEEP_STARTED', 'SWEEP_RECOVERED']);
  });
});

describe('a ticket transaction whose final lease fence fails rolls back completely', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp(db, {}, (b) =>
      b.overrideProvider(PgSweepStore).useFactory({
        factory: (p: PrismaService) => new PgSweepStore(p, hooks),
        inject: [PrismaService],
      }),
    );
  });
  afterAll(async () => {
    await t?.close();
  });

  it('expiry before the progress write -> FENCED; ticket, clocks, audit and counters unchanged', async () => {
    const customer = await signedIn(t, 'cust1@customer.example');
    const created = await customer.post('/api/customer/tickets', { subject: 'Fence', body: 'due' });
    const id = created.body.id as string;
    await owner.query(
      `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '1 minute' WHERE "ticketId"=$1 AND kind='RESPONSE'`,
      [id],
    );
    const appStore = t.app.get(PgSweepStore);
    const r = await appStore.reserve({
      initiator: { type: 'SYSTEM' },
      key: sweepKey({ type: 'SYSTEM' }, `h01-proc-${Date.now()}`),
      requestHash: 'sha256:h01p',
      correlationId: 'h01p',
      leaseMs: 700,
    });
    if (r.kind !== 'RESERVED') throw new Error(r.kind);
    expireDuring('progress', r.lease);
    const auditBefore = (
      await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1`, [id])
    ).rows[0].n;
    expect(await t.app.get(PgSweepTicketProcessor).processTicket(r.lease, id)).toEqual({
      kind: 'FENCED',
    });
    expect(
      (
        await owner.query(
          `SELECT "currentLate", "breachSequence" FROM "SlaClock" WHERE "ticketId"=$1 AND kind='RESPONSE'`,
          [id],
        )
      ).rows,
    ).toEqual([{ currentLate: false, breachSequence: 0 }]);
    expect(
      (await owner.query(`SELECT version FROM "Ticket" WHERE id=$1`, [id])).rows[0].version,
    ).toBe(0);
    expect(
      (await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1`, [id]))
        .rows[0].n,
    ).toBe(auditBefore);
    expect((await row(r.lease.id)).processed).toBe(0);
  });
});
