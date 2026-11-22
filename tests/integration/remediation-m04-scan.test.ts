import { Client } from 'pg';
import { SweepScheduler } from '../../apps/api/src/sweep/sweep.scheduler';
import { connect } from '../helpers/db';
import { conforms, newKey, signedIn, start, startApp, TestApp } from '../helpers/http';
import { Observer } from '../helpers/observe';
import { dropDatabase, freshDatabase } from '../helpers/scratch';

/** Candidate scans run under transaction-local timeouts bounded by the remaining invocation budget. */
let t: TestApp;
let db: string;
let owner: Client;
let observer: Observer;

beforeAll(async () => {
  db = await freshDatabase('m04');
  t = await startApp(db);
  owner = await connect('owner', db);
  observer = await Observer.open(db);
});
afterAll(async () => {
  await owner?.end();
  await observer?.close();
  await t?.close();
  await dropDatabase(db);
});

async function blockClockTable(): Promise<Client> {
  const c = await connect('owner', db);
  await c.query('BEGIN');
  await c.query('LOCK TABLE "SlaClock" IN ACCESS EXCLUSIVE MODE'); // blocks even plain SELECTs
  return c;
}

it('a blocked scan ends in a bounded, safe SWEEP_FAILED; scheduler is released; replay is stable; next sweep catches up', async () => {
  const lead = await signedIn(t, 'lead@arvo.example');
  const customer = await signedIn(t, 'cust1@customer.example');
  const created = await customer.post('/api/customer/tickets', { subject: 'Due', body: 'due' });
  await owner.query(
    `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '1 minute' WHERE "ticketId"=$1 AND kind='RESPONSE'`,
    [created.body.id],
  );

  const blocker = await blockClockTable();
  const key = newKey();
  const began = Date.now();
  const pending = start(lead.post('/api/admin/run-sla-sweep', undefined, key));
  await observer.waitForLockWaiters('%FROM "SlaClock"%', 1); // the scan is genuinely blocked in PostgreSQL
  const r = await pending;
  expect(Date.now() - began).toBeLessThan(9_000); // bounded by the scan budget (5s cap), not indefinite
  expect(r.status).toBe(503);
  conforms('Error', r.body);
  expect(r.body.code).toBe('SWEEP_FAILED');
  const inv = (
    await owner.query(
      `SELECT id, state, "responseStatus" FROM "SweepInvocation" ORDER BY "startedAt" DESC LIMIT 1`,
    )
  ).rows[0];
  expect(inv).toMatchObject({ state: 'FAILED', responseStatus: 503 });
  expect(
    (
      await owner.query(
        `SELECT action FROM audit_logs WHERE "sweepId"=$1 ORDER BY "createdAt", "eventKey" DESC`,
        [inv.id],
      )
    ).rows.map((x) => x.action),
  ).toEqual(['SWEEP_STARTED', 'SWEEP_FAILED']);

  // The scheduler's in-flight state is released even while the table stays blocked.
  const scheduler = t.app.get(SweepScheduler);
  await scheduler.tick();
  expect((scheduler as unknown as { running: unknown }).running).toBeNull();

  await blocker.query('ROLLBACK');
  await blocker.end();
  const replay = await lead.post('/api/admin/run-sla-sweep', undefined, key);
  expect([replay.status, replay.body]).toEqual([503, r.body]); // same-key replay of the stored terminal failure
  const catchUp = await lead.post('/api/admin/run-sla-sweep');
  expect(catchUp.status).toBe(200);
  expect(catchUp.body).toMatchObject({ processed: 1, breachesRecorded: 1, moreDue: false });
});
