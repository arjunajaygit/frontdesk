import { Client } from 'pg';
import { sweepKey } from '../../apps/api/src/domain/sweep/sweep-policy';
import { PgSweepStore } from '../../apps/api/src/infrastructure/sweep/pg-sweep-store';
import { PgSweepTicketProcessor } from '../../apps/api/src/sweep/sweep-ticket.processor';
import { SweepScheduler } from '../../apps/api/src/sweep/sweep.scheduler';
import { SweepService } from '../../apps/api/src/sweep/sweep.service';
import { requestHash } from '../../apps/api/src/tickets/idempotency.service';
import { connect } from '../helpers/db';
import { Browser, conforms, newKey, signedIn, startApp, TestApp } from '../helpers/http';
import { dropDatabase, freshDatabase } from '../helpers/scratch';

/** Fresh migrated DB (no seeded tickets) so "nothing is due" is deterministic regardless of today's date. */
let t: TestApp;
let db: string;
let owner: Client;
let lead: Browser, agent: Browser, customer: Browser;

beforeAll(async () => {
  db = await freshDatabase('sweep');
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

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await owner.query(sql, p)).rows as T[];
const sweep = (key = newKey(), who: Browser = lead) =>
  who.post('/api/admin/run-sla-sweep', undefined, key);

async function ticket(): Promise<string> {
  const r = await customer.post('/api/customer/tickets', {
    subject: 'Sweep fixture',
    body: 'Needs attention',
  });
  expect(r.status).toBe(201);
  return r.body.id;
}
/** Fixture helpers move stored deadlines into the past (data only; no clock override exists anywhere). */
async function overdueResponse(): Promise<string> {
  const id = await ticket();
  await owner.query(
    `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '1 minute' WHERE "ticketId"=$1 AND kind='RESPONSE'`,
    [id],
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
async function resolvedPastWindow(): Promise<string> {
  const id = await ticket();
  await agent.post(`/api/tickets/${id}/claim`);
  await agent.post(`/api/tickets/${id}/resolve`, { body: 'Fixed.' });
  await owner.query(
    `UPDATE "Ticket" SET "resolvedAt" = now() - interval '8 days', "reopenUntil" = now() - interval '1 day' WHERE id=$1`,
    [id],
  );
  return id;
}

describe('manual sweep endpoint', () => {
  it('requires LEAD/ADMIN, session, CSRF/Origin and an Idempotency-Key', async () => {
    expect((await sweep(newKey(), agent)).status).toBe(403);
    expect((await sweep(newKey(), customer)).status).toBe(403);
    expect((await new Browser(t.server).post('/api/admin/run-sla-sweep')).status).toBe(401);
    expect(
      (await lead.agent.post('/api/admin/run-sla-sweep').set('Idempotency-Key', newKey())).status,
    ).toBe(403);
    expect((await lead.post('/api/admin/run-sla-sweep', undefined, null)).status).toBe(400);
    expect(
      (await lead.post('/api/admin/run-sla-sweep', { now: '2030-01-01T00:00:00Z' })).status,
    ).toBe(400); // no client time accepted
  });

  it('zero-ticket run is attributed and audited (START by the lead, FINISH) and replays identically', async () => {
    const key = newKey();
    const r = await sweep(key);
    expect(r.status).toBe(200);
    conforms('SweepResult', r.body);
    expect(r.body).toMatchObject({
      processed: 0,
      autoClosed: 0,
      expired: 0,
      breachesRecorded: 0,
      failed: 0,
      moreDue: false,
      correlationId: r.headers['x-request-id'],
    });
    const audits = await q(
      `SELECT action, "actorType", "actorId", "correlationId" FROM audit_logs WHERE "sweepId"=$1 ORDER BY "createdAt", "eventKey" DESC`,
      [r.body.invocationId],
    );
    expect(audits).toEqual([
      {
        action: 'SWEEP_STARTED',
        actorType: 'LEAD',
        actorId: lead.viewer!.id,
        correlationId: r.body.correlationId,
      },
      {
        action: 'SWEEP_FINISHED',
        actorType: 'LEAD',
        actorId: lead.viewer!.id,
        correlationId: r.body.correlationId,
      },
    ]);
    const replay = await sweep(key);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(r.body);
    expect(
      await q(`SELECT count(*)::int n FROM audit_logs WHERE "sweepId"=$1`, [r.body.invocationId]),
    ).toEqual([{ n: 2 }]);
  });

  it('processes real due transitions atomically with durable counters and SYSTEM-attributed ticket events', async () => {
    const waiting = await waitingPastCutoff();
    const resolved = await resolvedPastWindow();
    const late = await overdueResponse();
    const r = await sweep();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      processed: 3,
      autoClosed: 1,
      expired: 1,
      breachesRecorded: 1,
      failed: 0,
      moreDue: false,
    });
    const states = await q<{ id: string; status: string; closeReason: string | null }>(
      `SELECT id, status, "closeReason" FROM "Ticket" WHERE id = ANY($1)`,
      [[waiting, resolved, late]],
    );
    expect(Object.fromEntries(states.map((s) => [s.id, `${s.status}:${s.closeReason}`]))).toEqual({
      [waiting]: 'CLOSED:AUTO_CLOSED_NO_REPLY',
      [resolved]: 'CLOSED:RESOLUTION_WINDOW_EXPIRED',
      [late]: 'OPEN:null',
    });
    expect(
      await q(
        `SELECT "currentLate", "breachSequence" FROM "SlaClock" WHERE "ticketId"=$1 AND kind='RESPONSE'`,
        [late],
      ),
    ).toEqual([{ currentLate: true, breachSequence: 1 }]);
    const ticketEvents = await q<{ action: string; actorType: string; correlationId: string }>(
      `SELECT action, "actorType", "correlationId" FROM audit_logs WHERE "ticketId" = ANY($1) AND action IN ('TICKET_CLOSED','SLA_CANCELLED','SLA_BREACHED')`,
      [[waiting, resolved, late]],
    );
    expect(ticketEvents.length).toBeGreaterThanOrEqual(4);
    for (const e of ticketEvents)
      expect(e).toMatchObject({ actorType: 'SYSTEM', correlationId: r.body.correlationId });
    const [inv] = await q(
      `SELECT state, "responseStatus", processed, "autoClosed", expired, "breachesRecorded", failed FROM "SweepInvocation" WHERE id=$1`,
      [r.body.invocationId],
    );
    expect(inv).toEqual({
      state: 'COMPLETED',
      responseStatus: 200,
      processed: 3,
      autoClosed: 1,
      expired: 1,
      breachesRecorded: 1,
      failed: 0,
    });
    const again = await sweep();
    expect(again.body).toMatchObject({ processed: 0, breachesRecorded: 0, moreDue: false }); // no duplicate transitions
    expect(
      (
        await q(
          `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='SLA_BREACHED'`,
          [late],
        )
      )[0],
    ).toEqual({ n: 1 });
  });

  it('a running invocation with the same key returns 409 SWEEP_IN_PROGRESS', async () => {
    const key = newKey();
    const store = t.app.get(PgSweepStore);
    const held = await store.reserve({
      initiator: { type: 'LEAD', id: lead.viewer!.id },
      key: sweepKey({ type: 'LEAD', id: lead.viewer!.id }, key),
      requestHash: requestHash('POST /admin/run-sla-sweep', null, {}),
      correlationId: 'held-elsewhere',
      leaseMs: 30_000,
    });
    expect(held.kind).toBe('RESERVED');
    const r = await sweep(key);
    expect(r.status).toBe(409);
    conforms('Error', r.body);
    expect(r.body.code).toBe('SWEEP_IN_PROGRESS');
    if (held.kind === 'RESERVED') await store.finish(held.lease, false);
  });
});

describe('bounded batches and backlog progression', () => {
  it('reports moreDue when the batch cap is hit and drains on the next invocation', async () => {
    const small = await startApp(db, { SWEEP_BATCH_SIZE: '2', SWEEP_MAX_BATCHES: '1' });
    try {
      const l = await signedIn(small, 'lead@arvo.example');
      for (let i = 0; i < 3; i++) await overdueResponse();
      const first = await l.post('/api/admin/run-sla-sweep');
      expect(first.body).toMatchObject({ processed: 2, moreDue: true });
      const second = await l.post('/api/admin/run-sla-sweep');
      expect(second.body).toMatchObject({ processed: 1, moreDue: false });
    } finally {
      await small.close();
    }
  });
});

describe('lease fencing in the per-ticket transaction', () => {
  it('an expired lease or stale token processes nothing (FENCED) and leaves the ticket untouched', async () => {
    const id = await overdueResponse();
    const store = t.app.get(PgSweepStore);
    const processor = t.app.get(PgSweepTicketProcessor);
    const res = await store.reserve({
      initiator: { type: 'SYSTEM' },
      key: sweepKey({ type: 'SYSTEM' }, `fence-${Date.now()}`),
      requestHash: 'sha256:fence',
      correlationId: 'fence-test',
      leaseMs: 30_000,
    });
    if (res.kind !== 'RESERVED') throw new Error(res.kind);
    expect(await processor.processTicket({ id: res.lease.id, token: 'stale-token' }, id)).toEqual({
      kind: 'FENCED',
    });
    await owner.query(
      `UPDATE "SweepInvocation" SET "startedAt" = now() - interval '1 minute', "leaseUntil" = now() - interval '1 second' WHERE id=$1`,
      [res.lease.id],
    );
    expect(await processor.processTicket(res.lease, id)).toEqual({ kind: 'FENCED' });
    expect(
      await q(`SELECT "currentLate" FROM "SlaClock" WHERE "ticketId"=$1 AND kind='RESPONSE'`, [id]),
    ).toEqual([{ currentLate: false }]);
    expect(await q(`SELECT processed FROM "SweepInvocation" WHERE id=$1`, [res.lease.id])).toEqual([
      { processed: 0 },
    ]);
    expect(await t.app.get(SweepService).recover()).toBeGreaterThanOrEqual(1);
    expect(
      await q(`SELECT state, "responseStatus" FROM "SweepInvocation" WHERE id=$1`, [res.lease.id]),
    ).toEqual([{ state: 'FAILED', responseStatus: 503 }]);
    await sweep(); // leave nothing due for later tests
  });
});

describe('scheduler (no browser traffic involved)', () => {
  it('a tick runs a SYSTEM invocation; overlapping ticks in one process do not start a second run', async () => {
    const id = await overdueResponse();
    const before = (
      await q<{ n: number }>(
        `SELECT count(*)::int n FROM "SweepInvocation" WHERE "actorType"='SYSTEM' AND key LIKE 'SYSTEM:-:tick-%'`,
      )
    )[0]!.n;
    const scheduler = t.app.get(SweepScheduler);
    await Promise.all([scheduler.tick(), scheduler.tick(), scheduler.tick()]);
    const after = await q<{ state: string; processed: number }>(
      `SELECT state, processed FROM "SweepInvocation" WHERE "actorType"='SYSTEM' AND key LIKE 'SYSTEM:-:tick-%' ORDER BY "startedAt"`,
    );
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toEqual({ state: 'COMPLETED', processed: 1 });
    expect(
      await q(`SELECT "currentLate" FROM "SlaClock" WHERE "ticketId"=$1 AND kind='RESPONSE'`, [id]),
    ).toEqual([{ currentLate: true }]);
  });

  it('scheduler errors are contained and logged; the next tick works', async () => {
    const scheduler = t.app.get(SweepScheduler);
    const spy = jest
      .spyOn(t.app.get(SweepService), 'runScheduled')
      .mockRejectedValueOnce(new Error('database unavailable'));
    await expect(scheduler.tick()).resolves.toBeUndefined();
    spy.mockRestore();
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect((await new Browser(t.server).get('/api/healthz')).status).toBe(200); // process keeps serving
  });
});
