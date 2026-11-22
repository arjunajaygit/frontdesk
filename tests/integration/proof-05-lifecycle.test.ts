import { Client } from 'pg';
import { sweepKey } from '../../apps/api/src/domain/sweep/sweep-policy';
import { LeaseWriteOp, PgSweepStore } from '../../apps/api/src/infrastructure/sweep/pg-sweep-store';
import { PrismaService } from '../../apps/api/src/prisma/prisma.service';
import { PgSweepTicketProcessor } from '../../apps/api/src/sweep/sweep-ticket.processor';
import { requestHash } from '../../apps/api/src/tickets/idempotency.service';
import { connect } from '../helpers/db';
import { Browser, newKey, signedIn, start, startApp, TestApp } from '../helpers/http';
import { LockHolder, Observer } from '../helpers/observe';
import { dropDatabase, freshDatabase } from '../helpers/scratch';

/**
 * Lifecycle, auto-close/reopen/linked tickets and scheduler correctness on real PostgreSQL.
 * Business time is controlled only through DATA fixtures (stored deadlines moved into the past); there is
 * no clock override anywhere in the application. Exact cutoff equality (+1 ms) is proven at the domain and
 * SQL-snapshot level (tests/unit/domain/*, tests/integration/sweep-store.test.ts) and re-run with this proof.
 */
let t: TestApp;
let db: string;
let owner: Client;
let observer: Observer;
let lead: Browser, agent: Browser, customer: Browser;
let barrier: ((op: LeaseWriteOp) => Promise<void>) | null = null;
const hooks = { beforeLeaseWrite: async (op: LeaseWriteOp) => barrier?.(op) };

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await owner.query(sql, p)).rows as T[];

beforeAll(async () => {
  db = await freshDatabase('proof05');
  t = await startApp(db, { DB_LOCK_TIMEOUT_MS: '20000' }, (b) =>
    b.overrideProvider(PgSweepStore).useFactory({
      factory: (p: PrismaService) => new PgSweepStore(p, hooks),
      inject: [PrismaService],
    }),
  );
  owner = await connect('owner', db);
  observer = await Observer.open(db);
  [lead, agent, customer] = await Promise.all([
    signedIn(t, 'lead@arvo.example'),
    signedIn(t, 'agent1@arvo.example'),
    signedIn(t, 'cust1@customer.example'),
  ]);
});
afterAll(async () => {
  await owner?.end();
  await observer?.close();
  await t?.close();
  await dropDatabase(db);
});
afterEach(async () => {
  barrier = null;
  await lead.post('/api/admin/run-sla-sweep'); // leave nothing due for the next test
});

async function ticket(): Promise<string> {
  const r = await customer.post('/api/customer/tickets', { subject: 'Lifecycle', body: 'x' });
  expect(r.status).toBe(201);
  return r.body.id;
}
async function overdue(minutesAgo = 1): Promise<string> {
  const id = await ticket();
  await owner.query(
    `UPDATE "SlaClock" SET "deadlineAt" = now() - make_interval(mins => $2) WHERE "ticketId"=$1 AND kind='RESPONSE'`,
    [id, minutesAgo],
  );
  return id;
}
async function waitingPastCutoff(): Promise<string> {
  const id = await ticket();
  await agent.post(`/api/tickets/${id}/claim`);
  await agent.post(`/api/tickets/${id}/wait`, { body: 'Please confirm.' });
  await owner.query(
    `UPDATE "Ticket" SET "waitingSince" = now() - interval '10 days', "waitingCloseDueAt" = now() - interval '1 minute' WHERE id=$1`,
    [id],
  );
  return id;
}
const breaches = async (id: string) =>
  (
    await q<{ n: number }>(
      `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='SLA_BREACHED'`,
      [id],
    )
  )[0]!.n;

describe('lifecycle and scheduler: overlapping sweep workers on separate connections', () => {
  it('two invocations RUNNING at the same time transition each ticket exactly once; counters reflect commits only', async () => {
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map(() => overdue()));
    // Barrier: every progress write waits until BOTH invocations are RUNNING, forcing genuine overlap.
    barrier = async (op) => {
      if (op !== 'progress') return;
      const deadline = Date.now() + 8_000;
      while (
        (
          await q<{ n: number }>(
            `SELECT count(*)::int n FROM "SweepInvocation" WHERE state='RUNNING'`,
          )
        )[0]!.n < 2
      ) {
        if (Date.now() > deadline) throw new Error('second worker never started');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    const [a, b] = await Promise.all([
      start(lead.post('/api/admin/run-sla-sweep')),
      start(lead.post('/api/admin/run-sla-sweep')),
    ]);
    barrier = null;
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.invocationId).not.toBe(b.body.invocationId);
    expect(a.body.processed + b.body.processed).toBe(6);
    expect(a.body.breachesRecorded + b.body.breachesRecorded).toBe(6);
    for (const id of ids) expect(await breaches(id)).toBe(1); // one event per clock episode, no duplicates
    const inv = await q<{ processed: number }>(
      `SELECT processed FROM "SweepInvocation" WHERE id = ANY($1)`,
      [[a.body.invocationId, b.body.invocationId]],
    );
    expect(inv.reduce((s, r) => s + r.processed, 0)).toBe(6);
  });
});

describe('lifecycle and scheduler: crash after a ticket commit, before FINISH', () => {
  it('recovers once to FAILED, same-key replay is a stable 503, a new key catches up without duplicates', async () => {
    const first = await overdue();
    const second = await overdue();
    const store = t.app.get(PgSweepStore);
    const lead2 = { type: 'LEAD' as const, id: lead.viewer!.id };
    const callerKey = newKey();
    const res = await store.reserve({
      initiator: lead2,
      key: sweepKey(lead2, callerKey),
      requestHash: requestHash('POST /admin/run-sla-sweep', null, {}),
      correlationId: 'crash',
      leaseMs: 30_000,
    });
    if (res.kind !== 'RESERVED') throw new Error(res.kind);
    expect(await t.app.get(PgSweepTicketProcessor).processTicket(res.lease, first)).toEqual({
      kind: 'CHANGED',
    }); // committed
    // "crash": the worker never finishes; time passes beyond its lease
    await owner.query(
      `UPDATE "SweepInvocation" SET "startedAt" = now() - interval '1 minute', "leaseUntil" = now() - interval '1 second' WHERE id=$1`,
      [res.lease.id],
    );
    const replay1 = await lead.post('/api/admin/run-sla-sweep', undefined, callerKey);
    expect(replay1.status).toBe(503);
    expect(replay1.body.code).toBe('SWEEP_LEASE_EXPIRED');
    const replay2 = await lead.post('/api/admin/run-sla-sweep', undefined, callerKey);
    expect([replay2.status, replay2.body]).toEqual([503, replay1.body]);
    expect(
      await q(`SELECT action FROM audit_logs WHERE "sweepId"=$1 AND action='SWEEP_RECOVERED'`, [
        res.lease.id,
      ]),
    ).toHaveLength(1);
    expect(
      (await q(`SELECT processed FROM "SweepInvocation" WHERE id=$1`, [res.lease.id]))[0],
    ).toEqual({ processed: 1 }); // committed progress kept
    const catchUp = await lead.post('/api/admin/run-sla-sweep');
    expect(catchUp.body).toMatchObject({ processed: 1, breachesRecorded: 1, moreDue: false });
    expect([await breaches(first), await breaches(second)]).toEqual([1, 1]);
  });
});

describe('lifecycle and scheduler: backlog beyond one batch, no starvation behind old recorded breaches', () => {
  it('bounded runs report moreDue and the next run drains; older recorded breaches are never re-selected', async () => {
    const small = await startApp(db, { SWEEP_BATCH_SIZE: '2', SWEEP_MAX_BATCHES: '1' });
    try {
      const l = await signedIn(small, 'lead@arvo.example');
      const old = await Promise.all([overdue(500), overdue(400)]);
      await l.post('/api/admin/run-sla-sweep'); // records their breaches (older deadlines)
      const fresh = await Promise.all([overdue(5), overdue(4), overdue(3)]);
      const r1 = await l.post('/api/admin/run-sla-sweep');
      expect(r1.body).toMatchObject({ processed: 2, moreDue: true });
      const r2 = await l.post('/api/admin/run-sla-sweep');
      expect(r2.body).toMatchObject({ processed: 1, moreDue: false });
      for (const id of [...old, ...fresh]) expect(await breaches(id)).toBe(1);
    } finally {
      await small.close();
    }
  });
});

describe('lifecycle and scheduler: customer reply racing the sweep on a ticket past its inactivity cutoff', () => {
  it('reply holds the ticket; the sweep skips it (SKIP LOCKED); exactly one closure and one linked child', async () => {
    const id = await waitingPastCutoff();
    const holder = await LockHolder.hold(db, `SELECT id FROM "Ticket" WHERE id=$1 FOR UPDATE`, [
      id,
    ]);
    const reply = start(customer.post(`/api/customer/tickets/${id}/replies`, { body: 'Back now' }));
    await observer.waitForLockWaiters('%FROM "Ticket"%FOR UPDATE%', 1); // reply blocked on the ticket
    const sweep = await lead.post('/api/admin/run-sla-sweep'); // runs while the row is locked
    expect(sweep.body.processed).toBe(0);
    expect(sweep.body.moreDue).toBe(true); // still due, skipped not lost
    await holder.release();
    const r = await reply;
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe('NEW_LINKED_TICKET');
    const next = await lead.post('/api/admin/run-sla-sweep');
    expect(next.body.processed).toBe(0); // already closed by the reply's reconciliation
    expect(
      await q(
        `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='TICKET_CLOSED'`,
        [id],
      ),
    ).toEqual([{ n: 1 }]);
    expect(await q(`SELECT count(*)::int n FROM "Ticket" WHERE "parentTicketId"=$1`, [id])).toEqual(
      [{ n: 1 }],
    );
  });
});

describe('lifecycle and scheduler: delayed-sweep equivalence and linked-ticket replay', () => {
  it('contact after the cutoff gives the same outcome whether or not a sweep ran first; replay creates no second child', async () => {
    const swept = await waitingPastCutoff();
    await lead.post('/api/admin/run-sla-sweep'); // the sweep ran first for this one ...
    const fresh = await waitingPastCutoff(); // ...this one has NOT been swept
    const key = newKey();
    const a = await customer.post(`/api/customer/tickets/${swept}/replies`, { body: 'hello' });
    const b = await customer.post(`/api/customer/tickets/${fresh}/replies`, { body: 'hello' }, key);
    for (const r of [a, b]) {
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ outcome: 'NEW_LINKED_TICKET', ticket: { status: 'OPEN' } });
    }
    for (const id of [swept, fresh]) {
      expect((await q(`SELECT status, "closeReason" FROM "Ticket" WHERE id=$1`, [id]))[0]).toEqual({
        status: 'CLOSED',
        closeReason: 'AUTO_CLOSED_NO_REPLY',
      });
    }
    const replay = await customer.post(
      `/api/customer/tickets/${fresh}/replies`,
      { body: 'hello' },
      key,
    );
    expect([replay.status, replay.body]).toEqual([201, b.body]);
    expect(
      await q(`SELECT count(*)::int n FROM "Ticket" WHERE "parentTicketId"=$1`, [fresh]),
    ).toEqual([{ n: 1 }]);
    expect(
      (await customer.post(`/api/customer/tickets/${fresh}/replies`, { body: 'different' }, key))
        .body.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('lifecycle and scheduler: restart catch-up without browser traffic', () => {
  it('a fresh process with the scheduler enabled processes work that became due while it was down', async () => {
    const id = await overdue();
    await t.close(); // "down"
    const restarted = await startApp(db, {
      SWEEP_SCHEDULER_ENABLED: 'true',
      SWEEP_INTERVAL_MS: '5000',
    });
    try {
      const deadline = Date.now() + 15_000;
      while (
        (
          await q<{ c: boolean }>(
            `SELECT "currentLate" c FROM "SlaClock" WHERE "ticketId"=$1 AND kind='RESPONSE'`,
            [id],
          )
        )[0]!.c === false
      ) {
        if (Date.now() > deadline) throw new Error('scheduler did not catch up');
        await new Promise((r) => setTimeout(r, 100));
      }
      // Ticket progress commits BEFORE the invocation's separate FINISH transaction (by design), so wait for the
      // terminal state too rather than assuming it is already visible.
      for (;;) {
        const inv = await q<{ actorType: string; state: string }>(
          `SELECT "actorType", state FROM "SweepInvocation" WHERE key LIKE 'SYSTEM:-:tick-%' AND processed >= 1 ORDER BY "startedAt" DESC LIMIT 1`,
        );
        if (inv[0]?.state === 'COMPLETED') {
          expect(inv[0]).toEqual({ actorType: 'SYSTEM', state: 'COMPLETED' });
          break;
        }
        if (Date.now() > deadline)
          throw new Error(`invocation not terminal: ${JSON.stringify(inv[0])}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await restarted.close();
      t = await startApp(db, { DB_LOCK_TIMEOUT_MS: '20000' }, (b) =>
        b.overrideProvider(PgSweepStore).useFactory({
          factory: (p: PrismaService) => new PgSweepStore(p, hooks),
          inject: [PrismaService],
        }),
      );
      [lead, agent, customer] = await Promise.all([
        signedIn(t, 'lead@arvo.example'),
        signedIn(t, 'agent1@arvo.example'),
        signedIn(t, 'cust1@customer.example'),
      ]);
    }
  });
});
