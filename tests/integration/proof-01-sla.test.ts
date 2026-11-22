import { Client } from 'pg';
import { KernelBusinessCalendar } from '../../apps/api/src/domain/calendar/business-calendar';
import { connect } from '../helpers/db';
import { Browser, conforms, signedIn, startApp, TestApp } from '../helpers/http';
import { dropDatabase, freshDatabase } from '../helpers/scratch';

/**
 * SLA correctness through the real application. Exact calendar boundaries (Friday 18:00/18:30,
 * weekend/holiday rollover, equality vs +1 ms, worked DOMAIN_CONTRACT cases) are deterministic domain tests
 * (tests/unit/domain/*, 12 original kernel tests) executed in the same proof run; here every rule is
 * re-verified end-to-end with real DB time and stored-state fixtures (no clock override exists).
 */
const MIN = 60_000;
let t: TestApp;
let db: string;
let owner: Client;
let lead: Browser, agent: Browser, customer: Browser;
const cal = new KernelBusinessCalendar([]); // fresh DB: no holidays configured
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await owner.query(sql, p)).rows as T[];
type Clock = Record<string, any>;
const clock = (body: { clocks: Clock[] }, kind: string, cycle = 0) =>
  body.clocks.find((c) => c.kind === kind && c.cycle === cycle)!;

beforeAll(async () => {
  db = await freshDatabase('proof01');
  t = await startApp(db);
  owner = await connect('owner', db);
  [lead, agent, customer] = await Promise.all([
    signedIn(t, 'lead@arvo.example'),
    signedIn(t, 'agent1@arvo.example'),
    signedIn(t, 'cust1@customer.example'),
  ]);
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
  await dropDatabase(db);
});

async function staffTicket(priority: 'URGENT' | 'MEDIUM' | 'LOW') {
  const r = await agent.post('/api/tickets', {
    customerId: (await q<{ id: string }>(`SELECT id FROM "User" WHERE role='CUSTOMER' LIMIT 1`))[0]!
      .id,
    subject: `SLA ${priority}`,
    body: 'b',
    priority,
  });
  expect(r.status).toBe(201);
  conforms('StaffTicket', r.body);
  await agent.post(`/api/tickets/${r.body.id}/claim`);
  return r.body as { id: string; clocks: Clock[] };
}

describe('SLA correctness: policy tiers and independent clocks (HTTP, real DB time)', () => {
  it.each([
    ['URGENT', 120, null],
    ['MEDIUM', 270, 1620],
    ['LOW', 540, 2700],
  ] as const)(
    '%s: response %i min; resolution per policy (urgent = rest of effective day); deadlines from cycle start',
    async (p, resp, resol) => {
      const b = await staffTicket(p);
      const r = clock(b, 'RESPONSE');
      const s = clock(b, 'RESOLUTION');
      const start = Date.parse(s.cycleStartedAt);
      expect(r.budgetMs).toBe(resp * MIN);
      expect(s.budgetMs).toBe(resol === null ? cal.urgentDayBudgetMs(start) : resol * MIN);
      expect(Date.parse(s.deadlineAt)).toBe(cal.addWorkingMs(start, s.budgetMs));
      expect(Date.parse(r.deadlineAt)).toBe(cal.addWorkingMs(start, r.budgetMs));
      if (p === 'URGENT') expect(s.budgetMs).toBeLessThanOrEqual(540 * MIN); // never a rolling 540+ window
    },
  );

  it('a private note never satisfies the response SLA; the first public reply completes RESPONSE only', async () => {
    const b = await staffTicket('MEDIUM');
    const note = await agent.post(`/api/tickets/${b.id}/notes`, { body: 'internal' });
    expect(clock(note.body, 'RESPONSE').state).toBe('RUNNING');
    const reply = await agent.post(`/api/tickets/${b.id}/replies`, { body: 'public' });
    expect(clock(reply.body, 'RESPONSE').state).toBe('COMPLETED');
    expect(clock(reply.body, 'RESOLUTION').state).toBe('RUNNING');
  });
});

describe('SLA correctness: explicit waiting, zero-budget resume, escalation and history', () => {
  it('waiting freezes consumption; resume with zero remaining sets deadline = resume time (late at +1 ms)', async () => {
    const b = await staffTicket('MEDIUM');
    const wait = await agent.post(`/api/tickets/${b.id}/wait`, { body: 'need info' });
    const paused = clock(wait.body, 'RESOLUTION');
    expect(paused).toMatchObject({ state: 'PAUSED', deadlineAt: null });
    // Fixture: exhaust the remaining budget while paused (equality: consumed == budget, not yet late).
    await owner.query(
      `UPDATE "SlaClock" SET "consumedMs" = "budgetMs" WHERE "ticketId"=$1 AND kind='RESOLUTION'`,
      [b.id],
    );
    const back = await customer.post(`/api/customer/tickets/${b.id}/replies`, { body: 'here' });
    expect(back.status).toBe(200);
    const audit = (await agent.get(`/api/tickets/${b.id}/audit?limit=100`)).body.items as {
      action: string;
      details: Record<string, any>;
    }[];
    const resumed = audit.find((e) => e.action === 'SLA_RESUMED')!;
    expect(resumed.details.clock.after.deadlineAt).toBe(resumed.details.resumedAt); // deadline = now on resume
    expect(resumed.details.clock.after.currentLate).toBe(false); // equality is on time
    const later = await agent.get(`/api/tickets/${b.id}`);
    expect(clock(later.body, 'RESOLUTION')).toMatchObject({
      currentLate: true,
      breachDetectedNotRecorded: true,
    }); // > deadline
  });

  it('escalation while active and while paused applies the new budget to consumed time without resetting it', async () => {
    const active = await staffTicket('LOW');
    const esc = await agent.patch(`/api/tickets/${active.id}/priority`, { priority: 'URGENT' });
    const changed = (await agent.get(`/api/tickets/${active.id}/audit?limit=100`)).body.items.find(
      (e: { action: string }) => e.action === 'PRIORITY_CHANGED',
    );
    for (const rev of changed.details.clocks)
      expect(rev.after.consumedMs).toBe(rev.before.consumedMs); // never reset
    expect(clock(esc.body, 'RESPONSE')).toMatchObject({ budgetMs: 120 * MIN, policyRevision: 1 });
    const paused = await staffTicket('LOW');
    await agent.post(`/api/tickets/${paused.id}/wait`, { body: 'info?' });
    await owner.query(
      `UPDATE "SlaClock" SET "consumedMs" = 2000 * 60000 WHERE "ticketId"=$1 AND kind='RESOLUTION'`,
      [paused.id],
    );
    const p2 = await agent.patch(`/api/tickets/${paused.id}/priority`, { priority: 'MEDIUM' }); // 1620 < 2000 consumed
    expect(clock(p2.body, 'RESOLUTION')).toMatchObject({
      state: 'PAUSED',
      budgetMs: 1620 * MIN,
      consumedMs: 2000 * MIN,
      currentLate: true,
      deadlineAt: null,
    });
  });

  it('completed response is preserved; downgrade keeps historic breaches; a later miss is a distinct breach identity', async () => {
    const b = await staffTicket('URGENT');
    await owner.query(
      `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '1 minute' WHERE "ticketId"=$1 AND kind='RESPONSE'`,
      [b.id],
    );
    await lead.post('/api/admin/run-sla-sweep'); // records breach episode 1 (SYSTEM)
    const down = await agent.patch(`/api/tickets/${b.id}/priority`, { priority: 'LOW' });
    const resp = clock(down.body, 'RESPONSE');
    expect(resp).toMatchObject({ currentLate: false, breachSequence: 1 });
    expect(resp.firstBreachedAt).not.toBeNull();
    await owner.query(
      `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '1 minute' WHERE "ticketId"=$1 AND kind='RESPONSE'`,
      [b.id],
    );
    await lead.post('/api/admin/run-sla-sweep'); // episode 2
    const keys = await q<{ eventKey: string }>(
      `SELECT "eventKey" FROM audit_logs WHERE "ticketId"=$1 AND action='SLA_BREACHED' AND details->'clock'->>'kind'='RESPONSE' ORDER BY "createdAt"`,
      [b.id],
    );
    expect(keys.map((k) => k.eventKey.replace(/^breach:[^:]+:/, ''))).toEqual(['1', '2']);
    expect(new Set(keys.map((k) => k.eventKey)).size).toBe(2);
    const replied = await agent.post(`/api/tickets/${b.id}/replies`, { body: 'finally' });
    const completed = clock(replied.body, 'RESPONSE');
    await agent.patch(`/api/tickets/${b.id}/priority`, { priority: 'URGENT' });
    expect(clock((await agent.get(`/api/tickets/${b.id}`)).body, 'RESPONSE')).toMatchObject({
      state: 'COMPLETED',
      budgetMs: completed.budgetMs,
      policyRevision: completed.policyRevision,
      breachSequence: 2,
    });
  });

  it('GET is read-only and same-priority requests respect lifecycle state', async () => {
    const b = await staffTicket('MEDIUM');
    const before = await q(`SELECT version, "updatedAt" FROM "Ticket" WHERE id=$1`, [b.id]);
    await agent.get(`/api/tickets/${b.id}`);
    await agent.get(`/api/tickets?limit=50&late=true`);
    expect(await q(`SELECT version, "updatedAt" FROM "Ticket" WHERE id=$1`, [b.id])).toEqual(
      before,
    );
    await agent.post(`/api/tickets/${b.id}/resolve`, { body: 'done' });
    expect(
      (await agent.patch(`/api/tickets/${b.id}/priority`, { priority: 'MEDIUM' })).status,
    ).toBe(409);
  });
});
