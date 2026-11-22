import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { CursorCodec } from '../../apps/api/src/tickets/cursor';
import { TicketViews } from '../../apps/api/src/tickets/ticket.views';
import { connect } from '../helpers/db';
import { Browser, conforms, newKey, signedIn, startApp, TestApp } from '../helpers/http';
import { LockHolder } from '../helpers/observe';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/**
 * INC-0304 — customer privacy, including complete timelines with no truncation (> 500 public messages).
 * Browser DOM / network / client-cache privacy is verified in tests/e2e/privacy.spec.ts.
 */
const RUN = randomBytes(4).toString('hex');
const marker = (i: number) => `PRIVNOTE-${RUN}-${i}`;
const PUBLIC_COUNT = 520; // > 500: the old cap silently hid message 501+
const TIES = 5; // public messages sharing one timestamp (stable ordering across a page boundary)

let t: TestApp;
let db: string;
let owner: Client;
let agent: Browser, other: Browser, c1: Browser, c2: Browser;
let ticketId: string;
let noteIds: string[] = [];
let publicIds: string[] = [];

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await owner.query(sql, p)).rows as T[];

beforeAll(async () => {
  db = await cloneTemplate('proof03');
  t = await startApp(db);
  owner = await connect('owner', db);
  [agent, other, c1, c2] = await Promise.all([
    signedIn(t, 'arjun.nair@arvo.example'),
    signedIn(t, 'priya.sharma@arvo.example'),
    signedIn(t, 'aarav.menon@customer.example'),
    signedIn(t, 'diya.kapoor@customer.example'),
  ]);
  const created = await c1.post('/api/customer/tickets', {
    subject: `Privacy ${RUN}`,
    body: 'intake (public 1)',
  });
  ticketId = created.body.id;
  expect((await agent.post(`/api/tickets/${ticketId}/claim`)).status).toBe(200);
  // Real HTTP traffic: alternating staff/customer public replies, a private note every 40 messages.
  for (let i = 2; i <= PUBLIC_COUNT - TIES; i++) {
    const who = i % 2 ? agent : c1;
    const path =
      who === agent
        ? `/api/tickets/${ticketId}/replies`
        : `/api/customer/tickets/${ticketId}/replies`;
    const body = i === 300 ? '=HYPERLINK("http://evil.example","click")' : `public ${i}`;
    expect((await who.post(path, { body })).status).toBe(200);
    if (i % 40 === 0) {
      const n = await agent.post(`/api/tickets/${ticketId}/notes`, {
        body: `${marker(i)} internal only`,
      });
      expect(n.status).toBe(200);
    }
  }
  // Tie fixture: TIES public messages with one identical timestamp (newest), inserted directly.
  await owner.query(
    `INSERT INTO "Message"(id,"ticketId","authorId",body,visibility,kind,"createdAt")
     SELECT gen_random_uuid(), $1, $2, 'tie ' || g, 'PUBLIC', 'REPLY', date_trunc('milliseconds', now()) + interval '1 hour'
     FROM generate_series(1, $3) g`,
    [ticketId, c1.viewer!.id, TIES],
  );
  noteIds = (
    await q<{ id: string }>(
      `SELECT id FROM "Message" WHERE "ticketId"=$1 AND visibility='PRIVATE'`,
      [ticketId],
    )
  ).map((r) => r.id);
  publicIds = (
    await q<{ id: string }>(
      `SELECT id FROM "Message" WHERE "ticketId"=$1 AND visibility='PUBLIC' ORDER BY "createdAt", id`,
      [ticketId],
    )
  ).map((r) => r.id);
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
  await dropDatabase(db);
});

const assertNoPrivate = (raw: string) => {
  expect(raw).not.toMatch(new RegExp(`PRIVNOTE-${RUN}`));
  for (const id of noteIds) expect(raw).not.toContain(id);
  expect(raw).not.toMatch(
    /"(visibility|kind|assigneeId|assigneeDisplayName|assignedAgentDisplayName|clocks|requestedPriority|details)"/,
  );
};

describe('private-note isolation: complete timeline without truncation, private content absent', () => {
  it('fixture: > 500 public messages with interleaved private notes', () => {
    expect(publicIds.length).toBe(PUBLIC_COUNT);
    expect(noteIds.length).toBeGreaterThanOrEqual(12);
  });

  it('customer detail shows the most recent page; walking older pages yields every public message exactly once', async () => {
    const detail = await c1.get(`/api/customer/tickets/${ticketId}`);
    conforms('PublicTicket', detail.body);
    assertNoPrivate(detail.text);
    expect(detail.body.messages).toHaveLength(50);
    expect(detail.body.messages.at(-1).id).toBe(publicIds.at(-1)); // newest present (501+ discoverable)
    const seen: string[] = [...detail.body.messages.map((m: { id: string }) => m.id)];
    let cursor: string | null = detail.body.olderMessagesCursor;
    while (cursor) {
      const page = await c1.get(
        `/api/customer/tickets/${ticketId}/messages?limit=37&cursor=${encodeURIComponent(cursor)}`,
      );
      conforms('PublicMessagePage', page.body);
      assertNoPrivate(page.text);
      seen.unshift(...page.body.items.map((m: { id: string }) => m.id));
      cursor = page.body.nextCursor;
    }
    expect(seen).toEqual(publicIds); // complete, chronological, no gaps, no duplicates
  });

  it('identical timestamps are ordered stably by id across page boundaries', async () => {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const r = await c1.get(
        `/api/customer/tickets/${ticketId}/messages?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      pages.push(r.body.items.map((m: { id: string }) => m.id));
      cursor = r.body.nextCursor;
    }
    expect(pages.reverse().flat()).toEqual(publicIds.slice(-6)); // 5 ties + 1 earlier, split across 3 pages
  });

  it('staff timeline pagination returns every message including notes', async () => {
    const all = (
      await q<{ id: string }>(
        `SELECT id FROM "Message" WHERE "ticketId"=$1 ORDER BY "createdAt", id`,
        [ticketId],
      )
    ).map((r) => r.id);
    const detail = await other.get(`/api/tickets/${ticketId}`);
    conforms('StaffTicket', detail.body);
    const seen: string[] = detail.body.messages.map((m: { id: string }) => m.id);
    let cursor: string | null = detail.body.olderMessagesCursor;
    while (cursor) {
      const page = await other.get(
        `/api/tickets/${ticketId}/messages?limit=100&cursor=${encodeURIComponent(cursor)}`,
      );
      conforms('StaffMessagePage', page.body);
      seen.unshift(...page.body.items.map((m: { id: string }) => m.id));
      cursor = page.body.nextCursor;
    }
    expect(seen).toEqual(all);
  });

  it('JSON and CSV exports contain every public message exactly once and nothing private', async () => {
    const json = await c1.get(`/api/customer/tickets/${ticketId}/export?format=json`);
    const exported = JSON.parse(json.text);
    conforms('PublicTicket', exported);
    expect(exported.messages.map((m: { id: string }) => m.id)).toEqual(publicIds);
    expect(exported.olderMessagesCursor).toBeNull();
    assertNoPrivate(json.text);
    const csv = await c1.get(`/api/customer/tickets/${ticketId}/export?format=csv`);
    const rows = csv.text.trimEnd().split('\r\n');
    expect(rows).toHaveLength(PUBLIC_COUNT + 1);
    for (const id of publicIds) expect(csv.text.split(id).length - 1).toBe(1);
    assertNoPrivate(csv.text);
    expect(csv.text).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")"`); // formula neutralised
    for (const r of [json, csv]) {
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers.vary).toMatch(/Cookie/);
    }
  });

  it('customer list exposes only public summaries', async () => {
    const list = await c1.get('/api/customer/tickets?limit=100');
    conforms('PublicPage', list.body);
    assertNoPrivate(list.text);
    expect(list.text).not.toContain('public 2"'); // no message previews in list
  });
});

describe('private-note isolation: authorisation boundaries', () => {
  it('cross-customer reads and mutations are 404 everywhere and leak nothing', async () => {
    const paths = [
      c2.get(`/api/customer/tickets/${ticketId}`),
      c2.get(`/api/customer/tickets/${ticketId}/messages`),
      c2.get(`/api/customer/tickets/${ticketId}/export?format=json`),
      c2.get(`/api/customer/tickets/${ticketId}/export?format=csv`),
      c2.post(`/api/customer/tickets/${ticketId}/replies`, { body: 'x' }),
      c2.post(`/api/customer/tickets/${ticketId}/reopen`, { body: 'x' }),
    ];
    for (const r of await Promise.all(paths)) {
      expect(r.status).toBe(404);
      conforms('Error', r.body);
      expect(r.headers['cache-control']).toBe('no-store');
      assertNoPrivate(r.text);
      expect(r.text).not.toContain('public ');
    }
    const cursor = (await c1.get(`/api/customer/tickets/${ticketId}`)).body.olderMessagesCursor;
    expect(
      (
        await c2.get(
          `/api/customer/tickets/${ticketId}/messages?cursor=${encodeURIComponent(cursor)}`,
        )
      ).status,
    ).toBe(404);
  });

  it('a foreign ticket held locked by another connection is still a fast, uniform 404', async () => {
    const holder = await LockHolder.hold(db, `SELECT id FROM "Ticket" WHERE id=$1 FOR UPDATE`, [
      ticketId,
    ]);
    try {
      const began = Date.now();
      const r = await c2.post(`/api/customer/tickets/${ticketId}/replies`, { body: 'x' });
      expect(r.status).toBe(404);
      expect(Date.now() - began).toBeLessThan(1_500);
    } finally {
      await holder.release();
    }
  });

  it('customers cannot reach staff notes, staff detail, audit or the sweep; staff cannot use customer routes', async () => {
    expect((await c1.post(`/api/tickets/${ticketId}/notes`, { body: 'x' })).status).toBe(403);
    expect((await c1.get(`/api/tickets/${ticketId}`)).status).toBe(403);
    expect((await c1.get(`/api/tickets/${ticketId}/messages`)).status).toBe(403);
    expect((await c1.get(`/api/tickets/${ticketId}/audit`)).status).toBe(403);
    expect((await c1.post('/api/admin/run-sla-sweep')).status).toBe(403);
    expect((await agent.get(`/api/customer/tickets/${ticketId}`)).status).toBe(403);
    const anon = new Browser(t.server);
    expect((await anon.get(`/api/customer/tickets/${ticketId}/export`)).status).toBe(401);
  });

  it('unauthorised idempotent replay never releases the stored body', async () => {
    const mine = await c1.post('/api/customer/tickets', { subject: 'Replay', body: 'orig' });
    const key = newKey();
    const first = await c1.post(
      `/api/customer/tickets/${mine.body.id}/replies`,
      { body: 'stored reply' },
      key,
    );
    expect(first.status).toBe(200);
    await owner.query(`UPDATE "Ticket" SET "customerId"=$1 WHERE id=$2`, [
      c2.viewer!.id,
      mine.body.id,
    ]);
    const replay = await c1.post(
      `/api/customer/tickets/${mine.body.id}/replies`,
      { body: 'stored reply' },
      key,
    );
    expect(replay.status).toBe(404);
    expect(replay.text).not.toContain('stored reply');
  });

  it('staff-only conflict fields never appear on customer errors', async () => {
    const claimed = await c1.post('/api/customer/tickets', { subject: 'Conflict', body: 'x' });
    await agent.post(`/api/tickets/${claimed.body.id}/claim`);
    const staffConflict = await other.post(`/api/tickets/${claimed.body.id}/claim`);
    expect(staffConflict.body.assignedAgentDisplayName).toBeDefined(); // authorised staff path only
    for (const r of [
      await c1.post(`/api/customer/tickets/${claimed.body.id}/reopen`, { body: 'x' }), // 409 USE_REPLY
      await c2.post(`/api/customer/tickets/${claimed.body.id}/replies`, { body: 'x' }), // 404
    ]) {
      expect(r.body.assignedAgentDisplayName).toBeUndefined();
      expect(Object.keys(r.body).sort()).toEqual(['code', 'message', 'requestId']);
    }
  });
});

describe('private-note isolation: SQL-level projections (inspected arguments of the customer queries)', () => {
  it('customer queries filter ownership AND visibility=PUBLIC and select only allowlisted columns on every page', async () => {
    const calls: { model: string; args: Record<string, unknown> }[] = [];
    const record = (model: string, result: unknown) => async (args: Record<string, unknown>) => (
      calls.push({ model, args }),
      result
    );
    const fake = {
      ticket: {
        findFirst: record('ticket.findFirst', {
          id: 'x',
          subject: 's',
          status: 'OPEN',
          createdAt: new Date(0),
          parentTicketId: null,
        }),
      },
      message: { findMany: record('message.findMany', []) },
    } as never;
    const views = new TicketViews({ calendar: () => undefined } as never, t.app.get(CursorCodec));
    await views.publicTicket(fake, 'cust-1', 'ticket-1');
    await views.publicMessages(fake, 'cust-1', 'ticket-1', undefined, 10);
    const msgCalls = calls.filter((c) => c.model === 'message.findMany');
    expect(msgCalls.length).toBe(2);
    for (const c of msgCalls) {
      expect(c.args.where).toMatchObject({
        ticketId: 'ticket-1',
        visibility: 'PUBLIC',
        ticket: { customerId: 'cust-1' },
      });
      expect(Object.keys(c.args.select as object).sort()).toEqual([
        'author',
        'body',
        'createdAt',
        'id',
      ]);
      expect((c.args.select as { author: { select: object } }).author.select).toEqual({
        displayName: true,
        role: true,
      });
      expect(c.args).not.toHaveProperty('include');
    }
    const ticketCall = calls.find((c) => c.model === 'ticket.findFirst')!;
    expect(ticketCall.args.where).toEqual({ id: 'ticket-1', customerId: 'cust-1' });
    expect(Object.keys(ticketCall.args.select as object).sort()).toEqual([
      'createdAt',
      'id',
      'parentTicketId',
      'status',
      'subject',
    ]);
  });
});
