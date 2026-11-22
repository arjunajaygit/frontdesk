import { Client } from 'pg';
import { connect } from '../helpers/db';
import { Browser, conforms, signedIn, startApp, TestApp } from '../helpers/http';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/**
 * INC-0318 completeness: one ticket driven through EVERY lifecycle step via the real HTTP API with real sessions,
 * and one through waiting -> automatic closure. The audit trail must contain each business event with the right
 * actor type/id, before/after details, chronological recording times and no message bodies; a rejected command
 * must leave no audit trace (business change and audit are one transaction).
 */
const CUSTOMER = 'aarav.menon@customer.example';
const AGENT = 'arjun.nair@arvo.example';
const OTHER_AGENT = 'priya.sharma@arvo.example';
const LEAD = 'meera.iyer@arvo.example';
const BODIES = [
  'audit-body-intake',
  'audit-body-note',
  'audit-body-reply',
  'audit-body-request',
  'audit-body-customer',
  'audit-body-resolve',
  'audit-body-reopen',
  'audit-body-resolve-2',
  'audit-body-followup',
];

interface AuditItem {
  action: string;
  actorType: string;
  actorId: string | null;
  correlationId: string;
  createdAt: string;
  details: Record<string, any>;
}

let t: TestApp;
let db: string;
let owner: Client;
let customer: Browser, agent: Browser, otherAgent: Browser, lead: Browser;

beforeAll(async () => {
  db = await cloneTemplate('auditall');
  t = await startApp(db);
  owner = await connect('owner', db);
  [customer, agent, otherAgent, lead] = await Promise.all([
    signedIn(t, CUSTOMER),
    signedIn(t, AGENT),
    signedIn(t, OTHER_AGENT),
    signedIn(t, LEAD),
  ]);
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
  await dropDatabase(db);
});

async function audit(id: string): Promise<AuditItem[]> {
  const r = await agent.get(`/api/tickets/${id}/audit?limit=100`);
  expect(r.status).toBe(200);
  conforms('AuditPage', r.body);
  return r.body.items as AuditItem[];
}
const auditRows = async (id: string) =>
  Number(
    (await owner.query(`SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1`, [id])).rows[0]
      .n,
  );
const ok = (r: { status: number; body: unknown }, ...codes: number[]) =>
  expect(codes.length ? codes : [200, 201]).toContain(r.status);

it('every lifecycle step is recorded with actor, time and before/after detail; rejected commands leave no trace', async () => {
  const t0 = Date.now();
  const created = await customer.post('/api/customer/tickets', {
    subject: 'Audit completeness',
    body: BODIES[0],
  });
  ok(created, 201);
  const id = created.body.id as string;

  ok(await agent.post(`/api/tickets/${id}/claim`));
  // A losing claim is a 409 and must not add any audit row (transactional consistency).
  const before = await auditRows(id);
  const lost = await otherAgent.post(`/api/tickets/${id}/claim`);
  expect(lost.status).toBe(409);
  expect(await auditRows(id)).toBe(before);

  // Response deadline passes -> the lead-triggered sweep records the breach as SYSTEM.
  await owner.query(
    `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '2 minutes' WHERE "ticketId"=$1 AND kind='RESPONSE'`,
    [id],
  );
  const sweep = await lead.post('/api/admin/run-sla-sweep');
  expect(sweep.status).toBe(200);
  expect(sweep.body.breachesRecorded).toBeGreaterThanOrEqual(1);

  ok(await agent.post(`/api/tickets/${id}/notes`, { body: BODIES[1] }));
  ok(await agent.post(`/api/tickets/${id}/replies`, { body: BODIES[2] }));
  ok(await agent.post(`/api/tickets/${id}/wait`, { body: BODIES[3] }));
  ok(await customer.post(`/api/customer/tickets/${id}/replies`, { body: BODIES[4] }));
  ok(await agent.patch(`/api/tickets/${id}/priority`, { priority: 'URGENT' }));
  ok(await agent.post(`/api/tickets/${id}/resolve`, { body: BODIES[5] }));
  ok(await customer.post(`/api/customer/tickets/${id}/reopen`, { body: BODIES[6] }));
  ok(await agent.post(`/api/tickets/${id}/resolve`, { body: BODIES[7] }));
  // Reopen window expires -> contact creates a linked follow-up and expires the parent.
  await owner.query(
    `UPDATE "Ticket" SET "resolvedAt" = now() - interval '8 days', "reopenUntil" = now() - interval '1 day' WHERE id=$1`,
    [id],
  );
  const follow = await customer.post(`/api/customer/tickets/${id}/reopen`, { body: BODIES[8] });
  ok(follow);
  expect(follow.body.outcome).toBe('NEW_LINKED_TICKET');
  const childId = follow.body.ticket.id as string;

  const ev = await audit(id);
  const actions = ev.map((e) => e.action);
  for (const a of [
    'TICKET_CREATED',
    'MESSAGE_PUBLISHED',
    'TICKET_CLAIMED',
    'SLA_BREACHED',
    'INTERNAL_NOTE_ADDED',
    'SLA_COMPLETED',
    'TICKET_WAITING',
    'SLA_PAUSED',
    'SLA_RESUMED',
    'TICKET_RESUMED',
    'PRIORITY_CHANGED',
    'TICKET_RESOLVED',
    'TICKET_REOPENED',
    'TICKET_CLOSED',
    'LINKED_TICKET_CREATED',
  ])
    expect(actions).toContain(a);

  const one = (a: string) => ev.find((e) => e.action === a)!;
  // Actor attribution per actor type.
  expect(one('TICKET_CREATED')).toMatchObject({
    actorType: 'CUSTOMER',
    actorId: customer.viewer!.id,
  });
  expect(one('TICKET_CLAIMED')).toMatchObject({
    actorType: 'AGENT',
    actorId: agent.viewer!.id,
    details: { beforeStatus: 'OPEN', afterStatus: 'IN_PROGRESS' },
  });
  expect(one('SLA_BREACHED')).toMatchObject({ actorType: 'SYSTEM', actorId: null });
  expect(one('INTERNAL_NOTE_ADDED')).toMatchObject({
    actorType: 'AGENT',
    actorId: agent.viewer!.id,
  });
  expect(one('TICKET_RESUMED')).toMatchObject({
    actorType: 'CUSTOMER',
    actorId: customer.viewer!.id,
  });
  expect(one('TICKET_REOPENED')).toMatchObject({
    actorType: 'CUSTOMER',
    actorId: customer.viewer!.id,
  });
  expect(
    ev.filter((e) => e.action === 'TICKET_CLOSED').map((e) => e.details.closeReason),
  ).toContain('RESOLUTION_WINDOW_EXPIRED');

  // Before/after detail where the business state changes.
  const pc = one('PRIORITY_CHANGED');
  expect(pc.actorType).toBe('AGENT');
  expect(pc.details).toMatchObject({ previousPriority: 'MEDIUM', newPriority: 'URGENT' });
  expect(Array.isArray(pc.details.clocks) && pc.details.clocks.length).toBeTruthy();
  for (const c of pc.details.clocks)
    expect(c).toEqual(
      expect.objectContaining({ before: expect.any(Object), after: expect.any(Object) }),
    );
  const breach = one('SLA_BREACHED');
  // When it happened vs when the system recorded it are distinct, explicit fields.
  expect(breach.details).toEqual(
    expect.objectContaining({ breachedAt: expect.any(String), recordedAt: expect.any(String) }),
  );
  expect(Date.parse(breach.details.breachedAt)).toBeLessThanOrEqual(
    Date.parse(breach.details.recordedAt),
  );
  expect(one('SLA_PAUSED').details.waitingCloseDueAt).toEqual(expect.any(String));

  // Recording times are real, ordered and inside this test's window.
  const times = ev.map((e) => Date.parse(e.createdAt));
  expect([...times].sort((a, b) => a - b)).toEqual(times);
  expect(times[0]).toBeGreaterThanOrEqual(t0 - 2000);
  expect(times.at(-1)).toBeLessThanOrEqual(Date.now() + 2000);

  // The audit trail proves what happened without ever storing message content.
  const raw =
    JSON.stringify(ev) +
    JSON.stringify(
      (
        await owner.query(`SELECT details FROM audit_logs WHERE "ticketId" = ANY($1)`, [
          [id, childId],
        ])
      ).rows,
    );
  for (const b of BODIES) expect(raw).not.toContain(b);

  // The follow-up is a new ticket linked to the old one; the old history is intact.
  const child = await audit(childId);
  expect(child.find((e) => e.action === 'TICKET_CREATED')!.details.parentTicketId).toBe(id);
  expect((await audit(id)).length).toBe(ev.length);
});

it('automatic closure after the waiting cutoff is recorded as SYSTEM with its reason, and clocks are cancelled', async () => {
  const created = await customer.post('/api/customer/tickets', {
    subject: 'Audit auto-close',
    body: 'silent customer',
  });
  const id = created.body.id as string;
  ok(await agent.post(`/api/tickets/${id}/claim`));
  ok(await agent.post(`/api/tickets/${id}/wait`, { body: 'Which invoice?' }));
  await owner.query(
    `UPDATE "Ticket" SET "waitingSince" = now() - interval '10 days', "waitingCloseDueAt" = now() - interval '1 minute' WHERE id=$1`,
    [id],
  );
  const sweep = await lead.post('/api/admin/run-sla-sweep');
  expect(sweep.status).toBe(200);
  expect(sweep.body.autoClosed).toBeGreaterThanOrEqual(1);
  const ev = await audit(id);
  const closed = ev.find((e) => e.action === 'TICKET_CLOSED')!;
  expect(closed).toMatchObject({
    actorType: 'SYSTEM',
    actorId: null,
    details: { closeReason: 'AUTO_CLOSED_NO_REPLY' },
  });
  expect(ev.some((e) => e.action === 'SLA_CANCELLED')).toBe(true);
  // Replaying the sweep changes nothing (idempotent).
  const n = ev.length;
  await lead.post('/api/admin/run-sla-sweep');
  expect((await audit(id)).length).toBe(n);
});
