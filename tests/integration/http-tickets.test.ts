import { Client } from 'pg';
import { AuditWriter } from '../../apps/api/src/tickets/audit.writer';
import { connect } from '../helpers/db';
import { Browser, conforms, newKey, signedIn, startApp, TestApp } from '../helpers/http';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/** Real NestJS app + real PostgreSQL (scratch clone) as the restricted runtime role. */
const AG1 = 'arjun.nair@arvo.example';
const AG2 = 'priya.sharma@arvo.example';
const LEAD = 'meera.iyer@arvo.example';
const C1 = 'aarav.menon@customer.example';
const C2 = 'diya.kapoor@customer.example';
const MARKER = 'INTERNAL-SECRET-MARKER-7f3c';

let t: TestApp;
let db: string;
let owner: Client;
let ag1: Browser, ag2: Browser, lead: Browser, c1: Browser, c2: Browser;
const sweepAs = (b: Browser) => b.post('/api/admin/run-sla-sweep');

beforeAll(async () => {
  db = await cloneTemplate('tickets');
  t = await startApp(db);
  owner = await connect('owner', db);
  [ag1, ag2, lead, c1, c2] = await Promise.all([
    signedIn(t, AG1),
    signedIn(t, AG2),
    signedIn(t, LEAD),
    signedIn(t, C1),
    signedIn(t, C2),
  ]);
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
  await dropDatabase(db);
});

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await owner.query(sql, p)).rows as T[];
const actionsOf = async (id: string) =>
  (
    await q<{ action: string }>(
      `SELECT action FROM audit_logs WHERE "ticketId"=$1 ORDER BY "createdAt", id`,
      [id],
    )
  ).map((r) => r.action);
async function customerTicket(
  c: Browser,
  subject = 'Printer offline',
  body = 'The office printer is offline.',
) {
  const r = await c.post('/api/customer/tickets', { subject, body });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
async function claimed(c: Browser = c1, agent: Browser = ag1) {
  const id = await customerTicket(c);
  expect((await agent.post(`/api/tickets/${id}/claim`)).status).toBe(200);
  return id;
}
const clock = (body: { clocks: { kind: string; cycle: number }[] }, kind: string, cycle = 0) =>
  body.clocks.find((c) => c.kind === kind && c.cycle === cycle) as Record<string, unknown>;

describe('intake (atomic)', () => {
  it('customer intake: 201 PublicTicket; ticket + INTAKE message + two clocks + two audit events in one commit', async () => {
    const r = await c1.post('/api/customer/tickets', {
      subject: 'VPN down',
      body: 'Cannot connect to VPN',
      requestedPriority: 'URGENT',
    });
    expect(r.status).toBe(201);
    conforms('PublicTicket', r.body);
    const id = r.body.id;
    const [tk] = await q(
      `SELECT status, priority, "requestedPriority", "assigneeId", version, "customerId" FROM "Ticket" WHERE id=$1`,
      [id],
    );
    expect(tk).toMatchObject({
      status: 'OPEN',
      priority: 'MEDIUM',
      requestedPriority: 'URGENT',
      assigneeId: null,
      version: 0,
      customerId: c1.viewer!.id,
    });
    expect(await q(`SELECT kind, visibility FROM "Message" WHERE "ticketId"=$1`, [id])).toEqual([
      { kind: 'INTAKE', visibility: 'PUBLIC' },
    ]);
    expect(
      (
        await q(`SELECT kind, state FROM "SlaClock" WHERE "ticketId"=$1 ORDER BY kind::text`, [id])
      ).map((c) => `${c.kind}:${c.state}`),
    ).toEqual(['RESOLUTION:RUNNING', 'RESPONSE:RUNNING']);
    const audits = await q<{ action: string; actorType: string; correlationId: string }>(
      `SELECT action, "actorType", "correlationId" FROM audit_logs WHERE "ticketId"=$1 ORDER BY "createdAt", id`,
      [id],
    );
    expect(audits.map((a) => `${a.action}:${a.actorType}`).sort()).toEqual([
      'MESSAGE_PUBLISHED:CUSTOMER',
      'TICKET_CREATED:CUSTOMER',
    ]);
    expect(new Set(audits.map((a) => a.correlationId))).toEqual(
      new Set([r.headers['x-request-id']]),
    );
  });

  it('staff intake: 201 StaffTicket with authoritative priority; unknown or non-customer ids are rejected', async () => {
    const r = await ag1.post('/api/tickets', {
      customerId: c1.viewer!.id,
      subject: 'Phone report',
      body: 'Customer called about outage',
      priority: 'URGENT',
    });
    expect(r.status).toBe(201);
    conforms('StaffTicket', r.body);
    expect(r.body).toMatchObject({ priority: 'URGENT', status: 'OPEN', assigneeId: null });
    expect(clock(r.body, 'RESPONSE')).toMatchObject({ state: 'RUNNING', budgetMs: 7_200_000 });
    expect(
      (
        await ag1.post('/api/tickets', {
          customerId: '00000000-0000-4000-8000-000000000000',
          subject: 's',
          body: 'b',
          priority: 'LOW',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await ag1.post('/api/tickets', {
          customerId: ag2.viewer!.id,
          subject: 's',
          body: 'b',
          priority: 'LOW',
        })
      ).body.code,
    ).toBe('UNKNOWN_CUSTOMER');
  });

  it('client-supplied identity/visibility fields are rejected (strict DTOs)', async () => {
    expect(
      (
        await c1.post('/api/customer/tickets', {
          subject: 's',
          body: 'b',
          customerId: c2.viewer!.id,
        })
      ).status,
    ).toBe(400);
    expect(
      (await c1.post('/api/customer/tickets', { subject: 's', body: 'b', priority: 'URGENT' }))
        .status,
    ).toBe(400);
    const id = await claimed();
    expect(
      (await ag1.post(`/api/tickets/${id}/replies`, { body: 'x', visibility: 'PRIVATE' })).status,
    ).toBe(400);
    expect(
      (await ag1.post(`/api/tickets/${id}/notes`, { body: 'x', authorId: ag2.viewer!.id })).status,
    ).toBe(400);
  });
});

describe('exclusive claim (INC-0291 — basic coverage; forced-overlap races are in proof-02-claim.test.ts)', () => {
  it('two agents claiming concurrently: one 200, one 409 naming the winner; one assignee; one claim audit event', async () => {
    const id = await customerTicket(c1);
    const [r1, r2] = await Promise.all([
      ag1.post(`/api/tickets/${id}/claim`),
      ag2.post(`/api/tickets/${id}/claim`),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const [win, lose] = r1.status === 200 ? [r1, r2] : [r2, r1];
    conforms('StaffTicket', win.body);
    conforms('StaffClaimConflict', lose.body);
    expect(lose.body).toMatchObject({
      code: 'CLAIM_CONFLICT',
      assignedAgentDisplayName: win.body.assigneeDisplayName,
    });
    const [tk] = await q(`SELECT status, "assigneeId", version FROM "Ticket" WHERE id=$1`, [id]);
    expect(tk).toMatchObject({
      status: 'IN_PROGRESS',
      assigneeId: win.body.assigneeId,
      version: 1,
    });
    expect((await actionsOf(id)).filter((a) => a === 'TICKET_CLAIMED')).toHaveLength(1);
    const loser = win === r1 ? ag2 : ag1;
    expect((await loser.post(`/api/tickets/${id}/replies`, { body: 'me too' })).status).toBe(403);
  });

  it('claiming a non-OPEN ticket is a plain 409 conflict; customer errors never carry assignee data', async () => {
    const id = await claimed();
    const again = await ag2.post(`/api/tickets/${id}/claim`);
    expect(again.status).toBe(409);
    const notFound = await c2.post(`/api/customer/tickets/${id}/replies`, { body: 'hi' });
    expect(notFound.status).toBe(404);
    conforms('Error', notFound.body);
    expect(notFound.body.assignedAgentDisplayName).toBeUndefined();
  });
});

describe('conversation + SLA lifecycle through the real application', () => {
  it('reply completes RESPONSE; note does not; wait pauses; customer reply resumes; priority revises; resolve; reopen', async () => {
    const id = await claimed();
    const note = await ag1.post(`/api/tickets/${id}/notes`, { body: 'internal: check logs' });
    expect(note.status).toBe(200);
    conforms('StaffTicket', note.body);
    expect(clock(note.body, 'RESPONSE').state).toBe('RUNNING');

    const reply = await ag1.post(`/api/tickets/${id}/replies`, { body: 'Looking into it now.' });
    expect(clock(reply.body, 'RESPONSE')).toMatchObject({ state: 'COMPLETED' });
    expect(clock(reply.body, 'RESOLUTION').state).toBe('RUNNING');

    const wait = await ag1.post(`/api/tickets/${id}/wait`, { body: 'Please send the error code.' });
    expect(wait.body.status).toBe('WAITING');
    expect(wait.body.waitingCloseDueAt).not.toBeNull();
    expect(clock(wait.body, 'RESOLUTION')).toMatchObject({ state: 'PAUSED', deadlineAt: null });

    const back = await c1.post(`/api/customer/tickets/${id}/replies`, { body: 'Error code 0x42' });
    expect(back.status).toBe(200);
    conforms('CustomerOutcome', back.body);
    expect(back.body).toMatchObject({
      outcome: 'SAME_TICKET',
      previousTicketId: null,
      ticket: { status: 'IN_PROGRESS' },
    });

    const esc = await ag1.patch(`/api/tickets/${id}/priority`, { priority: 'URGENT' });
    expect(esc.body.priority).toBe('URGENT');
    expect(clock(esc.body, 'RESOLUTION').policyRevision).toBe(1);
    const responseAfter = clock(esc.body, 'RESPONSE');
    expect(responseAfter).toMatchObject({ state: 'COMPLETED', policyRevision: 0 }); // completed clock never revised
    const same = await ag1.patch(`/api/tickets/${id}/priority`, { priority: 'URGENT' });
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(esc.body.version); // no-op

    const res = await ag1.post(`/api/tickets/${id}/resolve`, {});
    expect(res.body.status).toBe('RESOLVED');
    expect(new Date(res.body.reopenUntil).getTime() - new Date(res.body.updatedAt).getTime()).toBe(
      7 * 86_400_000,
    );

    const reopen = await c1.post(`/api/customer/tickets/${id}/reopen`, {
      body: 'It is broken again.',
    });
    expect(reopen.status).toBe(200);
    expect(reopen.body).toMatchObject({
      outcome: 'SAME_TICKET',
      ticket: { id, status: 'IN_PROGRESS' },
    });
    const staffView = (await ag1.get(`/api/tickets/${id}`)).body;
    expect(staffView.resolutionCycle).toBe(1);
    expect(clock(staffView, 'RESOLUTION', 1)).toMatchObject({ state: 'RUNNING', cycle: 1 });
    expect(clock(staffView, 'RESPONSE')).toEqual({
      ...responseAfter,
      asOf: expect.any(String),
      remainingMs: expect.any(Number),
      consumedMs: responseAfter.consumedMs,
    });

    const trail = await actionsOf(id);
    expect(trail).toEqual(
      expect.arrayContaining([
        'TICKET_CLAIMED',
        'INTERNAL_NOTE_ADDED',
        'SLA_COMPLETED',
        'SLA_PAUSED',
        'TICKET_WAITING',
        'SLA_RESUMED',
        'TICKET_RESUMED',
        'PRIORITY_CHANGED',
        'TICKET_RESOLVED',
        'TICKET_REOPENED',
      ]),
    );
  });

  it('state and actor guards surface as 400/403/409 with the safe envelope', async () => {
    const id = await claimed();
    expect((await ag1.post(`/api/tickets/${id}/resolve`, {})).body.code).toBe('MESSAGE_REQUIRED'); // response still pending
    await ag1.post(`/api/tickets/${id}/wait`, { body: 'Need details' });
    const r = await ag1.post(`/api/tickets/${id}/replies`, { body: 'x' });
    expect(r.status).toBe(409);
    conforms('Error', r.body);
    expect((await ag1.post(`/api/tickets/${id}/reopen`)).status).toBe(403); // staff reopen stub
    expect((await c1.post(`/api/customer/tickets/${id}/reopen`, { body: 'x' })).body.code).toBe(
      'USE_REPLY',
    );
  });
});

describe('cutoffs: customer contact after expiry creates a linked ticket (fixture timestamps moved into the past)', () => {
  it('waiting past the inactivity cutoff: old ticket auto-closes, linked OPEN child returned (201)', async () => {
    const id = await claimed();
    await ag1.post(`/api/tickets/${id}/wait`, { body: 'Please confirm.' });
    await owner.query(
      `UPDATE "Ticket" SET "waitingSince" = now() - interval '10 days', "waitingCloseDueAt" = now() - interval '1 minute' WHERE id=$1`,
      [id],
    );
    const r = await c1.post(`/api/customer/tickets/${id}/replies`, { body: 'Sorry for the delay' });
    expect(r.status).toBe(201);
    conforms('CustomerOutcome', r.body);
    expect(r.body).toMatchObject({
      outcome: 'NEW_LINKED_TICKET',
      previousTicketId: id,
      ticket: { status: 'OPEN', parentTicketId: id },
    });
    const [old] = await q(`SELECT status, "closeReason", "resolvedAt" FROM "Ticket" WHERE id=$1`, [
      id,
    ]);
    expect(old).toEqual({
      status: 'CLOSED',
      closeReason: 'AUTO_CLOSED_NO_REPLY',
      resolvedAt: null,
    });
    expect(await actionsOf(id)).toEqual(
      expect.arrayContaining(['SLA_CANCELLED', 'TICKET_CLOSED', 'LINKED_TICKET_CREATED']),
    );
    expect(await actionsOf(r.body.ticket.id)).toEqual(['TICKET_CREATED', 'MESSAGE_PUBLISHED']);
  });

  it('resolved past the 7-day window: expired closure keeps resolvedAt; reopen creates a linked child', async () => {
    const id = await claimed();
    await ag1.post(`/api/tickets/${id}/resolve`, { body: 'Fixed.' });
    await owner.query(
      `UPDATE "Ticket" SET "resolvedAt" = now() - interval '8 days', "reopenUntil" = now() - interval '1 day' WHERE id=$1`,
      [id],
    );
    const r = await c1.post(`/api/customer/tickets/${id}/reopen`, { body: 'Still broken' });
    expect(r.status).toBe(201);
    const [old] = await q<{ status: string; closeReason: string; resolvedAt: Date | null }>(
      `SELECT status, "closeReason", "resolvedAt" FROM "Ticket" WHERE id=$1`,
      [id],
    );
    expect(old!.status).toBe('CLOSED');
    expect(old!.closeReason).toBe('RESOLUTION_WINDOW_EXPIRED');
    expect(old!.resolvedAt).not.toBeNull();
  });
});

describe('private-note isolation (INC-0304)', () => {
  let id: string;
  let noteId: string;
  beforeAll(async () => {
    id = await claimed(c1, ag1);
    await ag1.post(`/api/tickets/${id}/replies`, { body: 'PUBLIC-REPLY-VISIBLE-123' });
    const n = await ag1.post(`/api/tickets/${id}/notes`, {
      body: `${MARKER}: customer is on a watch list`,
    });
    noteId = n.body.messages.find((m: { kind: string }) => m.kind === 'NOTE').id;
  });

  it('customer list, detail, JSON export and CSV export contain public content but never the note', async () => {
    const list = await c1.get('/api/customer/tickets?limit=100');
    const detail = await c1.get(`/api/customer/tickets/${id}`);
    const json = await c1.get(`/api/customer/tickets/${id}/export?format=json`);
    const csv = await c1.get(`/api/customer/tickets/${id}/export?format=csv`);
    conforms('PublicPage', list.body);
    conforms('PublicTicket', detail.body);
    conforms('PublicTicket', JSON.parse(json.text));
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(id);
    for (const raw of [JSON.stringify(list.body), detail.text, json.text, csv.text]) {
      expect(raw).not.toContain(MARKER);
      expect(raw).not.toContain(noteId);
      expect(raw).not.toMatch(
        /"(visibility|kind|assigneeId|assigneeDisplayName|clocks|requestedPriority)"/,
      );
    }
    for (const raw of [detail.text, json.text, csv.text])
      expect(raw).toContain('PUBLIC-REPLY-VISIBLE-123');
    expect(detail.body.messages).toHaveLength(2); // intake + public reply; no private count leak
  });

  it('staff detail shows the note; staff audit payloads never contain any message body', async () => {
    expect((await ag2.get(`/api/tickets/${id}`)).text).toContain(MARKER);
    const audit = await ag2.get(`/api/tickets/${id}/audit?limit=100`);
    conforms('AuditPage', audit.body);
    expect(audit.text).not.toContain(MARKER);
    expect(audit.text).not.toContain('PUBLIC-REPLY-VISIBLE-123');
  });

  it('exports are attachments with no-store; CSV neutralises spreadsheet formulas', async () => {
    await c1.post(`/api/customer/tickets/${id}/replies`, {
      body: '=HYPERLINK("http://evil.example","x")',
    });
    const csv = await c1.get(`/api/customer/tickets/${id}/export?format=csv`);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/^attachment; filename="ticket-/);
    expect(csv.headers['cache-control']).toBe('no-store');
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(csv.text.split('\r\n')[0]).toBe(
      '"ticket_id","subject","status","ticket_created_at","parent_ticket_id","message_id","message_created_at","author_type","author_display_name","body"',
    );
  });

  it('cross-customer access is 404 on every customer path; staff-only routes are 403 for customers', async () => {
    for (const r of [
      await c2.get(`/api/customer/tickets/${id}`),
      await c2.get(`/api/customer/tickets/${id}/export?format=csv`),
      await c2.post(`/api/customer/tickets/${id}/replies`, { body: 'x' }),
      await c2.post(`/api/customer/tickets/${id}/reopen`, { body: 'x' }),
    ]) {
      expect(r.status).toBe(404);
      expect(r.text).not.toContain(MARKER);
    }
    expect(
      (await c2.get('/api/customer/tickets?limit=100')).body.items.map((i: { id: string }) => i.id),
    ).not.toContain(id);
    expect((await c1.get(`/api/tickets/${id}`)).status).toBe(403);
    expect((await c1.get(`/api/tickets/${id}/audit`)).status).toBe(403);
    expect((await c1.post(`/api/tickets/${id}/notes`, { body: 'x' })).status).toBe(403);
    expect((await ag1.get('/api/customer/tickets')).status).toBe(403);
    expect((await sweepAs(ag1)).status).toBe(403);
    expect((await sweepAs(c1)).status).toBe(403);
    expect((await sweepAs(lead)).status).toBe(200); // the lead may sweep
    expect((await new Browser(t.server).get('/api/tickets')).status).toBe(401);
  });
});

describe('audit (INC-0318)', () => {
  it('audit page is strict, ordered, correlated to the request id, and paginates with signed cursors', async () => {
    const id = await customerTicket(c1);
    const claim = await ag1.post(`/api/tickets/${id}/claim`);
    await ag1.post(`/api/tickets/${id}/replies`, { body: 'hello' });
    const p1 = await ag1.get(`/api/tickets/${id}/audit?limit=2`);
    conforms('AuditPage', p1.body);
    expect(p1.body.items.map((e: { action: string }) => e.action)).toEqual([
      'TICKET_CREATED',
      'MESSAGE_PUBLISHED',
    ]);
    const p2 = await ag1.get(
      `/api/tickets/${id}/audit?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`,
    );
    const claimEvent = p2.body.items.find((e: { action: string }) => e.action === 'TICKET_CLAIMED');
    expect(claimEvent).toMatchObject({
      actorType: 'AGENT',
      actorId: ag1.viewer!.id,
      correlationId: claim.headers['x-request-id'],
    });
    expect(
      (
        await ag1.get(
          `/api/tickets/${id}/audit?cursor=${encodeURIComponent(p1.body.nextCursor + 'x')}`,
        )
      ).body.code,
    ).toBe('INVALID_CURSOR');
    const other = await customerTicket(c1);
    expect(
      (
        await ag1.get(
          `/api/tickets/${other}/audit?cursor=${encodeURIComponent(p1.body.nextCursor)}`,
        )
      ).status,
    ).toBe(400); // cursor bound to ticket
    expect(
      (await ag2.get(`/api/tickets/${id}/audit?cursor=${encodeURIComponent(p1.body.nextCursor)}`))
        .status,
    ).toBe(400); // and to actor
  });

  it('a failing audit append rolls back the whole business mutation (claim stays unassigned, no stored outcome)', async () => {
    const id = await customerTicket(c1);
    const failing = await startApp(db, {}, (b) =>
      b.overrideProvider(AuditWriter).useValue({
        appendTicketEvents: async () => {
          throw new Error('simulated audit append failure');
        },
      }),
    );
    try {
      const agent = await signedIn(failing, AG1);
      const key = newKey();
      const r = await agent.post(`/api/tickets/${id}/claim`, undefined, key);
      expect(r.status).toBe(500);
      expect(r.body).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId: expect.any(String),
      });
      const [tk] = await q(`SELECT status, "assigneeId", version FROM "Ticket" WHERE id=$1`, [id]);
      expect(tk).toEqual({ status: 'OPEN', assigneeId: null, version: 0 });
      expect(await actionsOf(id)).toEqual(['TICKET_CREATED', 'MESSAGE_PUBLISHED']);
      expect(await q(`SELECT 1 FROM "IdempotencyRecord" WHERE key=$1`, [key])).toEqual([]);
    } finally {
      await failing.close();
    }
    expect((await ag1.post(`/api/tickets/${id}/claim`)).status).toBe(200); // healthy app then succeeds
  });
});

describe('idempotency (persistent, actor-scoped)', () => {
  it('same key + same body replays the identical response without a second side effect', async () => {
    const id = await claimed();
    const key = newKey();
    const a = await ag1.post(`/api/tickets/${id}/replies`, { body: 'only once please' }, key);
    const b = await ag1.post(`/api/tickets/${id}/replies`, { body: 'only once please' }, key);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    expect(
      await q(
        `SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1 AND body='only once please'`,
        [id],
      ),
    ).toEqual([{ n: 1 }]);
    expect((await actionsOf(id)).filter((x) => x === 'MESSAGE_PUBLISHED')).toHaveLength(2); // intake + one reply
  });

  it('same key + different body is 409 IDEMPOTENCY_CONFLICT; a different actor with the same key is independent', async () => {
    const id = await claimed();
    const key = newKey();
    await ag1.post(`/api/tickets/${id}/notes`, { body: 'first' }, key);
    const conflict = await ag1.post(`/api/tickets/${id}/notes`, { body: 'second' }, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    const cust = await c1.post(
      '/api/customer/tickets',
      { subject: 'Same key, other actor', body: 'b' },
      key,
    );
    expect(cust.status).toBe(201);
  });

  it('concurrent duplicates with one key execute once and both receive the stored result', async () => {
    const id = await claimed();
    const key = newKey();
    const [a, b] = await Promise.all([
      ag1.post(`/api/tickets/${id}/replies`, { body: 'racing duplicate' }, key),
      ag1.post(`/api/tickets/${id}/replies`, { body: 'racing duplicate' }, key),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(b.body).toEqual(a.body);
    expect(
      await q(
        `SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1 AND body='racing duplicate'`,
        [id],
      ),
    ).toEqual([{ n: 1 }]);
  });

  it('failed commands store nothing (retry re-evaluates); missing or malformed keys are 400', async () => {
    const id = await claimed();
    const key = newKey();
    expect((await ag2.post(`/api/tickets/${id}/replies`, { body: 'not mine' }, key)).status).toBe(
      403,
    );
    expect(await q(`SELECT 1 FROM "IdempotencyRecord" WHERE key=$1`, [key])).toEqual([]);
    expect((await ag1.post(`/api/tickets/${id}/notes`, { body: 'x' }, null)).status).toBe(400);
    expect((await ag1.post(`/api/tickets/${id}/notes`, { body: 'x' }, 'short')).status).toBe(400);
  });
});

describe('read side is a pure projection', () => {
  it('GETs never mutate: an overdue clock is projected as detected-not-recorded without writing anything', async () => {
    const id = await claimed();
    await owner.query(
      `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '1 minute' WHERE "ticketId"=$1 AND kind='RESPONSE'`,
      [id],
    );
    const before = await q(`SELECT version, "updatedAt" FROM "Ticket" WHERE id=$1`, [id]);
    const auditsBefore = await actionsOf(id);
    const detail = await ag1.get(`/api/tickets/${id}`);
    await ag1.get(`/api/tickets?late=true&limit=100`);
    await ag1.get(`/api/tickets/${id}/audit`);
    await c1.get(`/api/customer/tickets/${id}`);
    expect(clock(detail.body, 'RESPONSE')).toMatchObject({
      currentLate: true,
      breachDetectedNotRecorded: true,
    });
    expect(await q(`SELECT version, "updatedAt" FROM "Ticket" WHERE id=$1`, [id])).toEqual(before);
    expect(await actionsOf(id)).toEqual(auditsBefore);
    expect(
      await q(`SELECT "currentLate" FROM "SlaClock" WHERE "ticketId"=$1 AND kind='RESPONSE'`, [id]),
    ).toEqual([{ currentLate: false }]);
  });

  it('staff queue filters (MINE / UNASSIGNED / status / late) and stable keyset pagination', async () => {
    const mine = await claimed(c1, ag2);
    const open = await customerTicket(c2);
    const ids = async (path: string) =>
      (await ag2.get(path)).body.items.map((i: { id: string }) => i.id) as string[];
    expect(await ids('/api/tickets?scope=MINE&limit=100')).toContain(mine);
    expect(await ids('/api/tickets?scope=MINE&limit=100')).not.toContain(open);
    expect(await ids('/api/tickets?scope=UNASSIGNED&limit=100')).toContain(open);
    expect(await ids('/api/tickets?status=IN_PROGRESS&limit=100')).not.toContain(open);
    const all: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const res: { body: { items: { id: string }[]; nextCursor: string | null } } = await ag2.get(
        `/api/tickets?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      conforms('StaffPage', res.body);
      all.push(...res.body.items.map((x) => x.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe((await q(`SELECT count(*)::int n FROM "Ticket"`))[0]!.n);
    const late = await ag2.get('/api/tickets?late=true&limit=100');
    for (const item of late.body.items)
      expect(item.clocks.some((c: { currentLate: boolean }) => c.currentLate)).toBe(true);
    expect((await ag2.get('/api/tickets?bogus=1')).status).toBe(400);
    expect((await ag2.get('/api/tickets?limit=500')).status).toBe(400);
  });
});
