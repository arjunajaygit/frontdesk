import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { Client } from 'pg';
import { PRIVATE_NOTE_MARKER } from '../../prisma/seed-data';
import { connect } from '../helpers/db';
import { Browser, newKey, signedIn, startApp, TestApp } from '../helpers/http';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/**
 * M7 metrics on REAL PostgreSQL through the real HTTP pipeline: counts match committed database truth, replays
 * and losing claims are classified correctly, labels carry no identities, and the listener is internal + authenticated.
 */
const STAFF = [
  'meera.iyer@arvo.example',
  'arjun.nair@arvo.example',
  'priya.sharma@arvo.example',
  'rohan.mehta@arvo.example',
  'kavya.reddy@arvo.example',
  'vikram.singh@arvo.example',
  'ananya.das@arvo.example',
  'imran.khan@arvo.example',
  'sneha.patil@arvo.example',
];
const TOKEN = randomBytes(32).toString('base64url');
const PORT = 39_000 + Math.floor(Math.random() * 2000);

let t: TestApp;
let db: string;
let owner: Client;
let agents: Browser[];
let customer: Browser;

const scrape = (token: string | null = TOKEN) => {
  const r = request(`http://127.0.0.1:${PORT}`).get('/metrics');
  return token ? r.set('Authorization', `Bearer ${token}`) : r;
};
async function value(series: string): Promise<number> {
  const text = (await scrape()).text;
  const hit = text.split('\n').find((l) => l.startsWith(series + ' '));
  return hit ? Number(hit.slice(series.length + 1)) : 0;
}

beforeAll(async () => {
  db = await cloneTemplate('metrics');
  t = await startApp(db, {
    METRICS_PORT: String(PORT),
    METRICS_HOST: '127.0.0.1',
    METRICS_TOKEN: TOKEN,
  });
  owner = await connect('owner', db);
  agents = await Promise.all(STAFF.map((e) => signedIn(t, e)));
  customer = await signedIn(t, 'aarav.menon@customer.example');
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
  await dropDatabase(db);
});

describe('M7 Prometheus metrics (real PostgreSQL)', () => {
  it('listener is internal and authenticated; the public app port does not serve metrics', async () => {
    expect((await scrape(null)).status).toBe(401);
    expect((await scrape('x'.repeat(TOKEN.length))).status).toBe(401);
    const ok = await scrape();
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/text\/plain/);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(
      (
        await request(`http://127.0.0.1:${PORT}`)
          .post('/metrics')
          .set('Authorization', `Bearer ${TOKEN}`)
      ).status,
    ).toBe(404);
    expect((await request(t.server).get('/api/metrics')).status).toBe(404);
    expect((await request(t.server).get('/metrics')).status).toBe(404);
    expect(await value('frontdesk_db_up')).toBe(1);
  });

  it('9-agent claim race: exactly one committed win counted, losers counted as conflicts, a replay never re-counts', async () => {
    const won0 = await value('frontdesk_ticket_claims_total{outcome="won"}');
    const lost0 = await value('frontdesk_ticket_claims_total{outcome="conflict"}');
    const rep0 = await value(
      'frontdesk_ticket_commands_total{command="POST /tickets/{id}/claim",outcome="replayed"}',
    );
    const created = await customer.post('/api/customer/tickets', {
      subject: 'Metrics race',
      body: 'Who takes it?',
    });
    expect(created.status).toBe(201);
    const keys = agents.map(() => newKey());
    const results = await Promise.all(
      agents.map((a, i) => a.post(`/api/tickets/${created.body.id}/claim`, undefined, keys[i]!)),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(8);
    expect(await value('frontdesk_ticket_claims_total{outcome="won"}')).toBe(won0 + 1);
    expect(await value('frontdesk_ticket_claims_total{outcome="conflict"}')).toBe(lost0 + 8);
    const winner = results.findIndex((r) => r.status === 200);
    const replay = await agents[winner]!.post(
      `/api/tickets/${created.body.id}/claim`,
      undefined,
      keys[winner]!,
    );
    expect(replay.status).toBe(200);
    expect(await value('frontdesk_ticket_claims_total{outcome="won"}')).toBe(won0 + 1); // unchanged
    expect(
      await value(
        'frontdesk_ticket_commands_total{command="POST /tickets/{id}/claim",outcome="replayed"}',
      ),
    ).toBe(rep0 + 1);
    const assigned = await owner.query(
      `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='TICKET_CLAIMED'`,
      [created.body.id],
    );
    expect(assigned.rows[0].n).toBe(1); // database truth agrees with the metric
    expect(
      await value(
        'frontdesk_http_requests_total{method="POST",route="/api/tickets/{id}/claim",status_class="4xx"}',
      ),
    ).toBeGreaterThanOrEqual(8);
  });

  it('sweep: breach and processed-ticket counters equal what the committed sweep wrote to PostgreSQL', async () => {
    const breaches = `SELECT count(*)::int n FROM audit_logs WHERE action='SLA_BREACHED'`;
    const b0 = (await owner.query(breaches)).rows[0].n as number;
    const sumBreaches = async () => {
      const text = (await scrape()).text;
      return text
        .split('\n')
        .filter((l) => l.startsWith('frontdesk_sla_breaches_recorded_total{'))
        .reduce((acc, l) => acc + Number(l.split(' ').pop()), 0);
    };
    const m0 = await sumBreaches();
    const p0 = await value('frontdesk_sweep_tickets_processed_total');
    const lead = agents[0]!; // Meera is the LEAD
    const r = await lead.post('/api/admin/run-sla-sweep');
    expect(r.status).toBe(200);
    const b1 = (await owner.query(breaches)).rows[0].n as number;
    expect(await sumBreaches()).toBe(m0 + (b1 - b0));
    expect(await value('frontdesk_sweep_tickets_processed_total')).toBe(p0 + r.body.processed);
    expect(r.body.processed).toBeGreaterThan(0); // the historical seed has due work
    expect(
      await value(
        'frontdesk_sweep_invocations_total{initiator="lead",trigger="manual",outcome="completed"}',
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(await value('frontdesk_sweep_more_due')).toBe(r.body.moreDue ? 1 : 0);
    expect(await value('frontdesk_sweep_last_manual_success_timestamp_seconds')).toBeGreaterThan(0);
    expect(await value('frontdesk_sweep_last_scheduled_success_timestamp_seconds')).toBe(0); // L01: manual never counts as scheduled
  });

  it('privacy: the full exposition contains no ids, emails, subjects, message bodies, tokens or private-note content', async () => {
    const text = (await scrape()).text;
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    expect(text).not.toMatch(/@[a-z]+\.example/);
    for (const s of [
      PRIVATE_NOTE_MARKER,
      'Metrics race',
      'Who takes it',
      'Billing address',
      TOKEN,
      'frontdesk_access',
      ...agents.map((a) => a.csrf),
    ])
      expect(text).not.toContain(s);
    const routes = [...text.matchAll(/route="([^"]+)"/g)].map((m) => m[1]!);
    for (const r of routes)
      expect(r === 'unmatched' || /^\/api(\/[a-z-]+|\/\{[a-zA-Z]+\})*$/.test(r)).toBe(true);
  });
});
