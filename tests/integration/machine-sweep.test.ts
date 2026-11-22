import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { Client } from 'pg';
import { connect } from '../helpers/db';
import { ORIGIN, newKey, signedIn, startApp, TestApp } from '../helpers/http';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/**
 * Machine-triggered scheduled sweep (free-hosting adaptation) on REAL PostgreSQL: dedicated credential, explicit
 * boundary (only this route skips Origin/CSRF), SYSTEM attribution, deterministic slot identity (replay, duplicate
 * delivery), persisted business outcome, metrics trigger label (L01).
 */
const TOKEN = randomBytes(36).toString('base64url');
const MPORT = 40_500 + Math.floor(Math.random() * 300);
const MTOKEN = randomBytes(32).toString('base64url');
let t: TestApp;
let off: TestApp;
let db: string;
let db2: string;
let owner: Client;

const trigger = (key: string | null, auth: string | null = `Bearer ${TOKEN}`) => {
  let r = request(t.server).post('/api/internal/sweep');
  if (auth) r = r.set('Authorization', auth);
  if (key) r = r.set('Idempotency-Key', key);
  return r;
};
const metric = async (series: string) => {
  const text = (
    await request(`http://127.0.0.1:${MPORT}`)
      .get('/metrics')
      .set('Authorization', `Bearer ${MTOKEN}`)
  ).text;
  const hit = text.split('\n').find((l) => l.startsWith(series + ' '));
  return hit ? Number(hit.slice(series.length + 1)) : 0;
};

beforeAll(async () => {
  db = await cloneTemplate('machine');
  t = await startApp(db, {
    SWEEP_TRIGGER_TOKEN: TOKEN,
    ANON_RATE_LIMIT_PER_MIN: '6',
    METRICS_PORT: String(MPORT),
    METRICS_HOST: '127.0.0.1',
    METRICS_TOKEN: MTOKEN,
  });
  owner = await connect('owner', db);
  db2 = await cloneTemplate('machineoff');
  off = await startApp(db2); // no SWEEP_TRIGGER_TOKEN configured
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
  await off?.close();
  await dropDatabase(db);
  await dropDatabase(db2);
});

describe('POST /api/internal/sweep', () => {
  it('is disabled (404) when no machine credential is configured', async () => {
    const r = await request(off.server)
      .post('/api/internal/sweep')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Idempotency-Key', 'cron-slot-off-0001');
    expect(r.status).toBe(404);
  });

  it('runs as SYSTEM without cookies/Origin/CSRF, persists the business outcome, and replays the same slot', async () => {
    await owner.query(
      `UPDATE "Ticket" SET "waitingSince" = now() - interval '10 days', "waitingCloseDueAt" = now() - interval '1 minute' WHERE subject LIKE '[FD-007]%'`,
    );
    const r = await trigger('cron-slot-0001');
    expect(r.status).toBe(200);
    expect(r.body.processed).toBeGreaterThanOrEqual(1);
    const inv = (
      await owner.query(
        `SELECT id, "actorType", "actorId", key, state FROM "SweepInvocation" WHERE key LIKE '%cron-slot-0001'`,
      )
    ).rows;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null, state: 'COMPLETED' });
    const fd007 = (
      await owner.query(
        `SELECT id, status, "closeReason" FROM "Ticket" WHERE subject LIKE '[FD-007]%'`,
      )
    ).rows[0];
    expect(fd007).toMatchObject({ status: 'CLOSED', closeReason: 'AUTO_CLOSED_NO_REPLY' });
    const closedBy = (
      await owner.query(
        `SELECT "actorType", "actorId" FROM audit_logs WHERE "ticketId"=$1 AND action='TICKET_CLOSED'`,
        [fd007.id],
      )
    ).rows;
    expect(closedBy).toEqual([{ actorType: 'SYSTEM', actorId: null }]);

    const again = await trigger('cron-slot-0001'); // retried / duplicated delivery of the SAME slot
    expect(again.status).toBe(200);
    expect(again.body.invocationId).toBe(r.body.invocationId);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int n FROM "SweepInvocation" WHERE key LIKE '%cron-slot-0001'`,
        )
      ).rows[0].n,
    ).toBe(1);

    expect(
      await metric(
        'frontdesk_sweep_invocations_total{initiator="system",trigger="external",outcome="completed"}',
      ),
    ).toBe(1);
    expect(
      await metric(
        'frontdesk_sweep_invocations_total{initiator="system",trigger="external",outcome="replayed"}',
      ),
    ).toBe(1);
    expect(
      await metric('frontdesk_sweep_last_scheduled_success_timestamp_seconds'),
    ).toBeGreaterThan(0);
  });

  it('two simultaneous deliveries of one slot create exactly one invocation', async () => {
    const [a, b] = await Promise.all([trigger('cron-slot-0002'), trigger('cron-slot-0002')]);
    expect([a.status, b.status].sort()).toEqual(expect.arrayContaining([200]));
    for (const r of [a, b]) expect([200, 409]).toContain(r.status);
    expect(
      (
        await owner.query(
          `SELECT count(*)::int n FROM "SweepInvocation" WHERE key LIKE '%cron-slot-0002'`,
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('rejects missing/invalid credentials, user cookies, bodies and bad keys; failures are rate limited per IP', async () => {
    expect((await trigger('cron-slot-0003', null)).status).toBe(401);
    const lead = await signedIn(t, 'meera.iyer@arvo.example');
    const withCookies = await lead.agent
      .post('/api/internal/sweep')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', lead.csrf)
      .set('Idempotency-Key', 'cron-slot-0004');
    expect(withCookies.status).toBe(401); // a user session is NOT a machine credential
    expect((await trigger('cron-slot-0005').send({ now: '2030-01-01T00:00:00Z' })).status).toBe(
      400,
    ); // no clock input
    expect((await trigger('bad key!')).status).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push((await trigger(`cron-slot-x${i}xxxx`, `Bearer wrong-${i}`)).status);
    expect(statuses).toContain(401);
    expect(statuses.at(-1)).toBe(429);
  });

  it('the Origin/CSRF exemption is ONLY for the machine route: ordinary mutations without Origin still fail', async () => {
    const cust = await signedIn(t, 'aarav.menon@customer.example');
    const noOrigin = await cust.agent
      .post('/api/customer/tickets')
      .set('X-CSRF-Token', cust.csrf)
      .set('X-Session-Context', cust.sessionContext)
      .set('Idempotency-Key', newKey())
      .send({ subject: 'x', body: 'y' });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.code).toBe('ORIGIN_REJECTED');
  });
});
