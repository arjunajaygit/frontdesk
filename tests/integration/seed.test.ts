import { Client } from 'pg';
import { connect, runNode, roleUrl, SEED_ANCHOR } from '../helpers/db';
import { loadSpec, makeValidator } from '../helpers/openapi';

const anchor = Date.parse(SEED_ANCHOR);
const ms = (s: string) => Date.parse(s);
let c: Client;
beforeAll(async () => {
  c = await connect('owner');
});
afterAll(async () => {
  await c.end();
});

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await c.query(sql, p)).rows as T[];
const ticketBy = async (no: string) =>
  (await q<Record<string, any>>(`SELECT * FROM "Ticket" WHERE subject LIKE $1`, [`[${no}]%`]))[0]!;
const clocks = async (no: string) =>
  q<Record<string, any>>(
    `SELECT s.* FROM "SlaClock" s JOIN "Ticket" t ON t.id=s."ticketId" WHERE t.subject LIKE $1 ORDER BY kind`,
    [`[${no}]%`],
  );

describe('historical seed (real PostgreSQL)', () => {
  it('seeds nine agents including Meera as LEAD, customers, holidays and fifteen scenarios', async () => {
    const roles = await q<{ role: string; n: number }>(
      `SELECT role, count(*)::int n FROM "User" GROUP BY role`,
    );
    expect(Object.fromEntries(roles.map((r) => [r.role, r.n]))).toEqual({
      LEAD: 1,
      AGENT: 8,
      CUSTOMER: 3,
    });
    expect((await q(`SELECT "displayName" FROM "User" WHERE role='LEAD'`))[0]).toEqual({
      displayName: 'Meera Iyer',
    });
    expect((await q(`SELECT count(*)::int n FROM "Holiday"`))[0]).toEqual({ n: 3 });
    const nos = (await q<{ subject: string }>(`SELECT subject FROM "Ticket" ORDER BY subject`)).map(
      (r) => r.subject.slice(1, 7),
    );
    expect(nos).toEqual(
      Array.from({ length: 15 }, (_, i) => `FD-${String(i + 1).padStart(3, '0')}`),
    );
  });

  it('passwords are Argon2id hashes (no plaintext, no committed credentials)', async () => {
    const hashes = await q<{ passwordHash: string }>(`SELECT "passwordHash" FROM "User"`);
    for (const h of hashes) expect(h.passwordHash).toMatch(/^\$argon2id\$v=19\$/);
  });

  it('is idempotent: re-running (even with a different anchor) creates nothing and changes nothing', async () => {
    const digest = async () =>
      (
        await q<{ h: string }>(`SELECT md5(
      (SELECT string_agg(t::text,'|' ORDER BY id) FROM "Ticket" t) || (SELECT string_agg(s::text,'|' ORDER BY id) FROM "SlaClock" s) ||
      (SELECT string_agg(a::text,'|' ORDER BY id) FROM audit_logs a) || (SELECT string_agg(m::text,'|' ORDER BY id) FROM "Message" m)) h`)
      )[0]!.h;
    const before = await digest();
    const run = runNode(['tsx', 'prisma/seed.ts'], {
      MIGRATION_DATABASE_URL: roleUrl('owner'),
      SEED_ANCHOR: '2027-02-02T12:00:00+05:30',
      SEED_CREDENTIALS: 'none',
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout.trim().split('\n').pop()!)).toMatchObject({
      usersCreated: 0,
      ticketsCreated: 0,
      ticketsSkipped: 15,
    });
    expect(await digest()).toBe(before);
  });

  it('every seeded audit event conforms to the strict OpenAPI AuditEvent union and carries no message body', async () => {
    const validate = makeValidator(loadSpec())('AuditEvent');
    const rows = await q<Record<string, any>>(`SELECT * FROM audit_logs ORDER BY "createdAt", id`);
    expect(rows.length).toBeGreaterThan(70);
    const seen = new Set<string>();
    for (const r of rows) {
      const event = {
        id: r.id,
        ticketId: r.ticketId,
        actorId: r.actorId,
        actorType: r.actorType,
        action: r.action,
        createdAt: r.createdAt.toISOString(),
        correlationId: r.correlationId,
        reasonCode: r.reasonCode,
        details: r.details,
      };
      if (!validate(event))
        throw new Error(`${r.eventKey} (${r.action}) invalid: ${JSON.stringify(validate.errors)}`);
      seen.add(r.action);
    }
    for (const a of [
      'TICKET_CREATED',
      'TICKET_CLAIMED',
      'MESSAGE_PUBLISHED',
      'INTERNAL_NOTE_ADDED',
      'PRIORITY_CHANGED',
      'SLA_PAUSED',
      'SLA_RESUMED',
      'SLA_BREACHED',
      'SLA_COMPLETED',
      'TICKET_WAITING',
      'TICKET_RESUMED',
      'TICKET_RESOLVED',
    ])
      expect(seen).toContain(a);
    const bodies = await q<{ n: number }>(
      `SELECT count(*)::int n FROM audit_logs a JOIN "Message" m ON m."ticketId"=a."ticketId" WHERE a.details::text LIKE '%' || left(m.body, 25) || '%'`,
    );
    expect(bodies[0]!.n).toBe(0);
  });

  it('ticket versions equal the latest afterVersion in their audit history; breach events carry SYSTEM actor', async () => {
    const rows = await q<
      Record<string, any>
    >(`SELECT t.subject, t.version, max(coalesce((a.details->>'afterVersion')::int,(a.details->>'version')::int)) v
      FROM "Ticket" t JOIN audit_logs a ON a."ticketId"=t.id GROUP BY t.id`);
    for (const r of rows) expect({ s: r.subject, v: r.version }).toEqual({ s: r.subject, v: r.v });
    const breach = await q(
      `SELECT DISTINCT "actorType","actorId" FROM audit_logs WHERE action='SLA_BREACHED'`,
    );
    expect(breach).toEqual([{ actorType: 'SYSTEM', actorId: null }]);
  });

  it('private-note isolation fixture (FD-010): marker exists only in a PRIVATE NOTE', async () => {
    const hits = await q<Record<string, any>>(
      `SELECT visibility, kind FROM "Message" WHERE body LIKE '%PRIVATE-NOTE-MARKER-FD010%'`,
    );
    expect(hits).toEqual([{ visibility: 'PRIVATE', kind: 'NOTE' }]);
    expect(
      (
        await q(
          `SELECT count(*)::int n FROM audit_logs WHERE details::text LIKE '%PRIVATE-NOTE-MARKER%'`,
        )
      )[0],
    ).toEqual({ n: 0 });
    const t = await ticketBy('FD-010');
    expect(
      (
        await q(
          `SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1 AND visibility='PUBLIC'`,
          [t.id],
        )
      )[0]!.n,
    ).toBe(4);
  });

  it('FD-001 urgent: independent response/resolution clocks both overdue with recorded breaches', async () => {
    const [resp, resol] = await clocks('FD-001');
    expect([resp!.kind, resol!.kind]).toEqual(['RESPONSE', 'RESOLUTION']);
    expect(Number(resp!.budgetMs)).toBe(120 * 60000);
    expect(resp!.currentLate && resol!.currentLate).toBe(true);
    expect(resp!.deadlineAt.getTime()).toBeLessThan(anchor);
    expect(resp!.deadlineAt.getTime()).not.toBe(resol!.deadlineAt.getTime());
  });

  it('FD-004/005 are unassigned OPEN for claim races', async () => {
    for (const no of ['FD-004', 'FD-005']) {
      const t = await ticketBy(no);
      expect({ status: t.status, assigneeId: t.assigneeId, version: t.version }).toEqual({
        status: 'OPEN',
        assigneeId: null,
        version: 0,
      });
    }
  });

  it('FD-006/007: waiting timers; FD-007 is strictly past its 2700-minute cutoff (sweep candidate)', async () => {
    const t6 = await ticketBy('FD-006');
    const t7 = await ticketBy('FD-007');
    expect(t6.status).toBe('WAITING');
    expect(t7.status).toBe('WAITING');
    expect(t6.waitingCloseDueAt.getTime()).toBeGreaterThan(anchor);
    expect(t7.waitingCloseDueAt.getTime()).toBeLessThan(anchor);
    const [, resolution] = await clocks('FD-006');
    expect(resolution!.state).toBe('PAUSED');
    expect(resolution!.deadlineAt).toBeNull();
  });

  it('FD-008 reopenable (inside 7-day window) and FD-009 expired (sweep candidate)', async () => {
    const t8 = await ticketBy('FD-008');
    const t9 = await ticketBy('FD-009');
    expect(t8.status).toBe('RESOLVED');
    expect(t9.status).toBe('RESOLVED');
    expect(t8.reopenUntil.getTime()).toBeGreaterThan(anchor);
    expect(t9.reopenUntil.getTime()).toBeLessThan(anchor);
    expect(t8.reopenUntil.getTime() - t8.resolvedAt.getTime()).toBe(7 * 86400000);
  });

  it('FD-011: LOW ticket, response RUNNING with no public staff reply', async () => {
    const t = await ticketBy('FD-011');
    const [resp] = await clocks('FD-011');
    expect({ p: t.priority, state: resp!.state, budget: Number(resp!.budgetMs) }).toEqual({
      p: 'LOW',
      state: 'RUNNING',
      budget: 540 * 60000,
    });
    expect(
      (
        await q(
          `SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1 AND kind IN ('REPLY','REQUEST') AND "authorId"=$2`,
          [t.id, t.assigneeId],
        )
      )[0],
    ).toEqual({ n: 0 });
  });

  it('FD-012: paused LOW resolution with 90 active minutes consumed, response COMPLETED, cycle started 17:30 IST', async () => {
    const [resp, resol] = await clocks('FD-012');
    expect(resp!.state).toBe('COMPLETED');
    expect({
      state: resol!.state,
      consumed: Number(resol!.consumedMs),
      budget: Number(resol!.budgetMs),
      deadline: resol!.deadlineAt,
    }).toEqual({ state: 'PAUSED', consumed: 90 * 60000, budget: 2700 * 60000, deadline: null });
    const ist = new Date(resol!.cycleStartedAt.getTime() + 330 * 60000);
    expect(ist.toISOString().slice(11, 16)).toBe('17:30');
  });

  it('FD-013: deadline skips the configured holiday (Fri 17:30 + 1620 min -> Thu 17:30, not Wed)', async () => {
    const [, resol] = await clocks('FD-013');
    expect(resol!.deadlineAt.getTime()).toBe(ms('2026-11-12T17:30:00+05:30'));
  });

  it('FD-014: escalation recorded with preserved consumption (480 min of the 510 min urgent same-day budget)', async () => {
    const t = await ticketBy('FD-014');
    const [resp, resol] = await clocks('FD-014');
    expect(t.priority).toBe('URGENT');
    expect(resp!.state).toBe('COMPLETED');
    expect({
      budget: Number(resol!.budgetMs),
      consumed: Number(resol!.consumedMs),
      rev: resol!.policyRevision,
      late: resol!.currentLate,
    }).toEqual({ budget: 510 * 60000, consumed: 480 * 60000, rev: 1, late: false });
    const ev = await q<Record<string, any>>(
      `SELECT action FROM audit_logs WHERE "ticketId"=$1 ORDER BY "createdAt", "eventKey"`,
      [t.id],
    );
    expect(ev.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'SLA_PAUSED',
        'TICKET_WAITING',
        'SLA_RESUMED',
        'TICKET_RESUMED',
        'PRIORITY_CHANGED',
      ]),
    );
  });

  it('FD-015: first public reply completed response clock with a known completion time', async () => {
    const [resp] = await clocks('FD-015');
    expect(resp!.state).toBe('COMPLETED');
    expect(resp!.completedAt).toBeInstanceOf(Date);
    expect(Number(resp!.budgetMs)).toBe(270 * 60000);
  });

  it('FD-003: Friday 18:00 medium ticket starts on a Friday at 18:00 IST', async () => {
    const t = await ticketBy('FD-003');
    const ist = new Date(t.createdAt.getTime() + 330 * 60000);
    expect({ dow: ist.getUTCDay(), hm: ist.toISOString().slice(11, 16) }).toEqual({
      dow: 5,
      hm: '18:00',
    });
  });

  it('migrations are repeatable: deploy is a no-op and status is clean on the seeded database', async () => {
    const dep = runNode(['prisma', 'migrate', 'deploy'], { DATABASE_URL: roleUrl('owner') });
    expect(dep.status).toBe(0);
    expect(dep.stdout).toContain('No pending migrations to apply');
    const st = runNode(['prisma', 'migrate', 'status'], { DATABASE_URL: roleUrl('owner') });
    expect(st.status).toBe(0);
    expect(st.stdout).toContain('Database schema is up to date');
    // Zero drift between the migrated database and schema.prisma (--exit-code: 0 = no difference).
    const diff = runNode(
      [
        'prisma',
        'migrate',
        'diff',
        '--from-url',
        roleUrl('owner'),
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      {},
    );
    expect({ status: diff.status, out: diff.stdout.trim() }).toEqual({
      status: 0,
      out: expect.stringContaining('No difference detected'),
    });
  });
});
