import { Client } from 'pg';
import { connect, expectPgError } from '../helpers/db';
import { Browser, conforms, newKey, signedIn, startApp, TestApp } from '../helpers/http';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

/**
 * INC-0318 — immutable, attributable, transactionally consistent audit.
 * Trusted-owner boundary (documented): the schema owner can disable triggers via DDL; no tamper-proof claim.
 */
let t: TestApp;
let db: string;
let owner: Client;
let app: Client;
let lead: Browser, agent: Browser, customer: Browser;
const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await owner.query(sql, p)).rows as T[];
const digest = async () =>
  (
    await q<{ h: string; n: number }>(
      `SELECT count(*)::int n, md5(string_agg(a::text, '|' ORDER BY id)) h FROM audit_logs a`,
    )
  )[0]!;

beforeAll(async () => {
  db = await cloneTemplate('proof04');
  t = await startApp(db);
  owner = await connect('owner', db);
  app = await connect('app', db);
  [lead, agent, customer] = await Promise.all([
    signedIn(t, 'meera.iyer@arvo.example'),
    signedIn(t, 'arjun.nair@arvo.example'),
    signedIn(t, 'aarav.menon@customer.example'),
  ]);
});
afterAll(async () => {
  await app?.end();
  await owner?.end();
  await t?.close();
  await dropDatabase(db);
});

describe('audit immutability: append-only enforcement in PostgreSQL', () => {
  it('runtime role: UPDATE/DELETE/TRUNCATE denied by privilege and triggers cannot be disabled; owner: trigger rejects; rows unchanged', async () => {
    const before = await digest();
    const seeded = (
      await q<{ id: string }>(`SELECT id FROM audit_logs WHERE "eventKey" = 'seed:FD-001:0'`)
    )[0]!.id; // existing seeded event
    for (const sql of [
      `UPDATE audit_logs SET action='X' WHERE id='${seeded}'`,
      `DELETE FROM audit_logs WHERE id='${seeded}'`,
      'TRUNCATE audit_logs',
      'ALTER TABLE audit_logs DISABLE TRIGGER ALL',
    ]) {
      expect({ sql, code: (await expectPgError(app, sql)).code }).toEqual({ sql, code: '42501' });
    }
    for (const sql of [
      `UPDATE audit_logs SET action='X' WHERE id='${seeded}'`,
      `DELETE FROM audit_logs WHERE id='${seeded}'`,
      'TRUNCATE audit_logs',
    ]) {
      const e = await expectPgError(owner, sql);
      expect({ sql, code: e.code, msg: e.message }).toEqual({
        sql,
        code: 'P0001',
        msg: 'audit_logs is append-only and immutable',
      });
    }
    expect(await digest()).toEqual(before);
  });
});

describe('audit immutability: attribution, correlation and causal reconstruction through the staff audit API', () => {
  it('reconstructs WHY a ticket was late and WHEN the public reply became visible', async () => {
    const created = await customer.post('/api/customer/tickets', {
      subject: 'Why late?',
      body: 'Please help',
    });
    const id = created.body.id as string;
    const claim = await agent.post(`/api/tickets/${id}/claim`);
    await owner.query(
      `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '2 minutes' WHERE "ticketId"=$1 AND kind='RESPONSE'`,
      [id],
    );
    const sweep = await lead.post('/api/admin/run-sla-sweep');
    expect(sweep.body.breachesRecorded).toBeGreaterThanOrEqual(1);
    const reply = await agent.post(`/api/tickets/${id}/replies`, { body: 'Sorry for the wait' });

    const page = await agent.get(`/api/tickets/${id}/audit?limit=100`);
    conforms('AuditPage', page.body);
    const ev = page.body.items as {
      action: string;
      actorType: string;
      actorId: string | null;
      correlationId: string;
      createdAt: string;
      details: Record<string, any>;
    }[];
    const byAction = (a: string) => ev.filter((e) => e.action === a);
    // Attribution + correlation for every actor type.
    expect(byAction('TICKET_CREATED')[0]).toMatchObject({
      actorType: 'CUSTOMER',
      actorId: customer.viewer!.id,
      correlationId: created.headers['x-request-id'],
    });
    expect(byAction('TICKET_CLAIMED')[0]).toMatchObject({
      actorType: 'AGENT',
      actorId: agent.viewer!.id,
      correlationId: claim.headers['x-request-id'],
    });
    const breach = byAction('SLA_BREACHED').find((e) => e.details.clock.kind === 'RESPONSE')!;
    expect(breach).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      correlationId: sweep.body.correlationId,
    });
    // Why late: the missed deadline, the logical onset (deadline + 1 ms) and when it was recorded.
    const missed = new Date(breach.details.missedDeadlineAt).getTime();
    expect(new Date(breach.details.breachedAt).getTime()).toBe(missed + 1);
    expect(new Date(breach.details.recordedAt).getTime()).toBe(
      new Date(breach.createdAt).getTime(),
    );
    expect(new Date(breach.details.recordedAt).getTime()).toBeGreaterThan(missed);
    const responseAtCreate = byAction('TICKET_CREATED')[0]!.details.clocks.find(
      (c: { kind: string }) => c.kind === 'RESPONSE',
    );
    expect(responseAtCreate.budgetMs).toBe(270 * 60_000); // policy in force at creation
    // Late completion: response completed with currentLate preserved, triggered by the public message.
    const completed = byAction('SLA_COMPLETED').find(
      (e) => e.details.clock.after.kind === 'RESPONSE',
    )!;
    expect(completed.details.clock.after).toMatchObject({
      state: 'COMPLETED',
      currentLate: true,
      breachSequence: 1,
    });
    const published = byAction('MESSAGE_PUBLISHED').find(
      (e) => e.details.messageId === completed.details.qualifyingMessageId,
    )!;
    expect(published).toMatchObject({
      actorId: agent.viewer!.id,
      correlationId: reply.headers['x-request-id'],
    });
    const [msg] = await q<{ createdAt: Date; authorId: string }>(
      `SELECT "createdAt", "authorId" FROM "Message" WHERE id=$1`,
      [published.details.messageId],
    );
    expect(published.details.publishedAt).toBe(msg!.createdAt.toISOString()); // logical publication time
    // Versions give causal order: the reply mutation strictly follows the breach mutation.
    expect(published.details.beforeVersion).toBe(breach.details.afterVersion);
    expect(JSON.stringify(ev)).not.toContain('Sorry for the wait'); // no bodies in audit
  });

  it('a malformed stored payload fails closed (503) — never a raw JSON fallback', async () => {
    const created = await customer.post('/api/customer/tickets', {
      subject: 'Tamper probe',
      body: 'x',
    });
    await owner.query(
      `INSERT INTO audit_logs(id,target,"ticketId","correlationId","actorType","actorId",action,details,"createdAt")
       VALUES (gen_random_uuid(),'TICKET',$1,'c','AGENT',$2,'MESSAGE_PUBLISHED','{"beforeVersion":0,"afterVersion":1,"messageId":"x","body":"SECRET-RAW"}', now())`,
      [created.body.id, agent.viewer!.id],
    );
    const r = await agent.get(`/api/tickets/${created.body.id}/audit`);
    expect(r.status).toBe(503);
    conforms('Error', r.body);
    expect(r.body.code).toBe('AUDIT_UNAVAILABLE');
    expect(r.text).not.toContain('SECRET-RAW');
  });

  it('zero-ticket sweep invocations are still attributed and audited', async () => {
    await lead.post('/api/admin/run-sla-sweep'); // drain anything due
    const r = await lead.post('/api/admin/run-sla-sweep');
    expect(r.body.processed).toBe(0);
    const rows = await q(
      `SELECT action, "actorType", "actorId" FROM audit_logs WHERE "sweepId"=$1 ORDER BY (action = 'SWEEP_STARTED') DESC`,
      [r.body.invocationId],
    );
    expect(rows).toEqual([
      { action: 'SWEEP_STARTED', actorType: 'LEAD', actorId: lead.viewer!.id },
      { action: 'SWEEP_FINISHED', actorType: 'LEAD', actorId: lead.viewer!.id },
    ]);
  });

  it('a DB-level rejection of MESSAGE_PUBLISHED rolls back the public reply itself (message never visible)', async () => {
    const created = await customer.post('/api/customer/tickets', {
      subject: 'Rollback reply',
      body: 'x',
    });
    const id = created.body.id as string;
    await agent.post(`/api/tickets/${id}/claim`);
    await owner.query(`
      CREATE FUNCTION public.proof04_reject_publish() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.action = 'MESSAGE_PUBLISHED' AND NEW."ticketId" = '${id}' THEN RAISE EXCEPTION 'proof04 injected'; END IF; RETURN NEW; END $f$`);
    await owner.query(
      `CREATE TRIGGER proof04_reject_publish BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.proof04_reject_publish()`,
    );
    const key = newKey();
    try {
      expect(
        (await agent.post(`/api/tickets/${id}/replies`, { body: 'must not survive' }, key)).status,
      ).toBe(500);
    } finally {
      await owner.query('DROP TRIGGER IF EXISTS proof04_reject_publish ON public.audit_logs');
      await owner.query('DROP FUNCTION IF EXISTS public.proof04_reject_publish()');
    }
    expect(
      await q(
        `SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1 AND body='must not survive'`,
        [id],
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      (await q(`SELECT state FROM "SlaClock" WHERE "ticketId"=$1 AND kind='RESPONSE'`, [id]))[0],
    ).toEqual({ state: 'RUNNING' });
    expect((await q(`SELECT version FROM "Ticket" WHERE id=$1`, [id]))[0]).toEqual({ version: 1 });
    expect((await customer.get(`/api/customer/tickets/${id}`)).text).not.toContain(
      'must not survive',
    );
  });

  it('no audit payload anywhere contains a message body, email, password hash or lease token', async () => {
    const rows = await q<{ details: unknown }>(`SELECT details FROM audit_logs`);
    const text = JSON.stringify(rows);
    const bodies = await q<{ body: string }>(
      `SELECT DISTINCT body FROM "Message" WHERE length(body) > 12 LIMIT 500`,
    );
    for (const b of bodies) expect(text).not.toContain(b.body);
    const tokens = await q<{ t: string }>(`SELECT "leaseToken" t FROM "SweepInvocation"`);
    for (const x of tokens) expect(text).not.toContain(x.t);
    expect(text).not.toMatch(/@(arvo|customer)\.example|\$argon2/);
  });
});
