import { Client } from 'pg';
import { connect, expectPgError } from '../helpers/db';

const U = (n: number) => `22222222-0000-4000-8000-${String(n).padStart(12, '0')}`;
let c: Client;
let customer: string;
let agent: string;

beforeAll(async () => {
  c = await connect('owner');
  customer = (await c.query(`SELECT id FROM "User" WHERE role='CUSTOMER' LIMIT 1`)).rows[0].id;
  agent = (await c.query(`SELECT id FROM "User" WHERE role='AGENT' LIMIT 1`)).rows[0].id;
});
afterAll(async () => {
  await c.end();
});
beforeEach(async () => {
  await c.query('BEGIN');
});
afterEach(async () => {
  await c.query('ROLLBACK');
});

const ticket = async (n: number, o: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: U(n),
    subject: 'constraint probe',
    customerId: customer,
    priority: 'MEDIUM',
    status: 'OPEN',
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:00:00Z',
    ...o,
  };
  const keys = Object.keys(row);
  const sql = `INSERT INTO "Ticket"(${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}${k2cast(keys[i]!)}`).join(',')})`;
  return { sql, values: Object.values(row) };
};
const k2cast = (k: string) =>
  k === 'status'
    ? '::"Status"'
    : k === 'priority' || k === 'requestedPriority'
      ? '::"Priority"'
      : k === 'closeReason'
        ? '::"CloseReason"'
        : '';
const insertTicket = async (n: number, o?: Record<string, unknown>) => {
  const t = await ticket(n, o);
  await c.query(t.sql, t.values);
};
const failTicket = async (n: number, o: Record<string, unknown>) => {
  const t = await ticket(n, o);
  return expectPgError(c, t.sql, t.values);
};

describe('database integrity constraints (real PostgreSQL)', () => {
  it('control: a coherent OPEN ticket inserts', async () => {
    await insertTicket(1);
  });

  it.each([
    ['OPEN with an assignee', { assigneeId: () => agent }],
    ['IN_PROGRESS without assignee', { status: 'IN_PROGRESS' }],
    [
      'WAITING without waitingSince/waitingCloseDueAt',
      { status: 'WAITING', assigneeId: () => agent },
    ],
    ['CLOSED without closedAt/closeReason', { status: 'CLOSED' }],
    ['resolvedAt without reopenUntil', { resolvedAt: '2026-11-20T11:00:00Z' }],
    ['negative version', { version: -1 }],
    ['updatedAt before createdAt', { updatedAt: '2026-11-19T10:00:00Z' }],
  ])('ticket_state_fields rejects %s', async (_n, patch) => {
    const o = Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, typeof v === 'function' ? v() : v]),
    );
    const e = await failTicket(2, o);
    expect({ code: e.code, constraint: e.constraint }).toEqual({
      code: '23514',
      constraint: 'ticket_state_fields',
    });
  });

  it('accepts coherent WAITING, RESOLVED and CLOSED states', async () => {
    await insertTicket(3, {
      status: 'WAITING',
      assigneeId: agent,
      waitingSince: '2026-11-20T11:00:00Z',
      waitingCloseDueAt: '2026-11-27T11:00:00Z',
    });
    await insertTicket(4, {
      status: 'RESOLVED',
      assigneeId: agent,
      resolvedAt: '2026-11-20T11:00:00Z',
      reopenUntil: '2026-11-27T11:00:00Z',
    });
    await insertTicket(5, {
      status: 'CLOSED',
      assigneeId: agent,
      closedAt: '2026-11-20T12:00:00Z',
      closeReason: 'AUTO_CLOSED_NO_REPLY',
    });
    await insertTicket(6, {
      status: 'CLOSED',
      assigneeId: agent,
      closedAt: '2026-11-28T12:00:00Z',
      closeReason: 'RESOLUTION_WINDOW_EXPIRED',
      resolvedAt: '2026-11-20T11:00:00Z',
      reopenUntil: '2026-11-27T11:00:00Z',
    });
  });

  it('rejects a ticket that is its own parent, and RESTRICTs deleting a referenced user', async () => {
    const self = await expectPgError(
      c,
      ...(await ticket(7, { parentTicketId: U(7) }).then((t) => [t.sql, t.values] as const)),
    );
    expect({ code: self.code, constraint: self.constraint }).toEqual({
      code: '23514',
      constraint: 'ticket_state_fields',
    }); // CHECK precedes FK
    const orphan = await ticket(9, { parentTicketId: U(12345) });
    expect((await expectPgError(c, orphan.sql, orphan.values)).code).toBe('23503'); // unknown parent -> FK
    await insertTicket(8);
    const e = await expectPgError(c, `UPDATE "Ticket" SET "parentTicketId"=id WHERE id=$1`, [U(8)]);
    expect({ code: e.code, constraint: e.constraint }).toEqual({
      code: '23514',
      constraint: 'ticket_state_fields',
    });
    expect((await expectPgError(c, `DELETE FROM "User" WHERE id=$1`, [customer])).code).toBe(
      '23503',
    );
  });

  const clock = (o: Record<string, unknown> = {}) => {
    const row = {
      id: U(Math.floor(Math.random() * 1e9) + 100),
      ticketId: U(20),
      cycle: 0,
      kind: 'RESPONSE',
      state: 'RUNNING',
      cycleStartedAt: '2026-11-20T10:00:00Z',
      budgetMs: 7200000,
      consumedMs: 0,
      runningSince: '2026-11-20T10:00:00Z',
      deadlineAt: '2026-11-20T12:00:00Z',
      ...o,
    };
    const keys = Object.keys(row);
    const cast = (k: string) =>
      k === 'kind' ? '::"ClockKind"' : k === 'state' ? '::"ClockState"' : '';
    return {
      sql: `INSERT INTO "SlaClock"(${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((k, i) => `$${i + 1}${cast(k)}`).join(',')})`,
      values: Object.values(row),
    };
  };

  it('sla_fields and clock uniqueness', async () => {
    await insertTicket(20);
    const ok = clock();
    await c.query(ok.sql, ok.values);
    const dup = clock({ id: U(999999) });
    expect((await expectPgError(c, dup.sql, dup.values)).code).toBe('23505'); // unique(ticket,cycle,kind)
    for (const patch of [
      { kind: 'RESOLUTION', cycle: 0, deadlineAt: null }, // RUNNING without deadline
      { kind: 'RESOLUTION', budgetMs: -1 },
      { kind: 'RESOLUTION', state: 'PAUSED' }, // PAUSED but still has runningSince/deadline
      { kind: 'RESOLUTION', state: 'COMPLETED', runningSince: null, deadlineAt: null }, // COMPLETED without completedAt
      { kind: 'RESOLUTION', cycle: 1, currentLate: true }, // late without firstBreachedAt
      { kind: 'RESPONSE', cycle: 1 }, // response clock must be cycle 0
    ]) {
      const bad = clock({ id: U(Math.floor(Math.random() * 1e9) + 100), ...patch });
      const e = await expectPgError(c, bad.sql, bad.values);
      expect({ patch, constraint: e.constraint }).toEqual({
        patch,
        constraint: expect.stringMatching(/^(sla_fields|SlaClock_ticketId_cycle_kind_key)$/),
      });
    }
  });

  it('message_kind_visibility: only NOTE is PRIVATE', async () => {
    await insertTicket(30);
    const ins = (kind: string, vis: string) =>
      expectPgError(
        c,
        `INSERT INTO "Message"(id,"ticketId","authorId",body,visibility,kind) VALUES (gen_random_uuid(),$1,$2,'x',$3::"Visibility",$4::"MessageKind")`,
        [U(30), agent, vis, kind],
      );
    expect((await ins('NOTE', 'PUBLIC')).constraint).toBe('message_kind_visibility');
    expect((await ins('REPLY', 'PRIVATE')).constraint).toBe('message_kind_visibility');
    await c.query(
      `INSERT INTO "Message"(id,"ticketId","authorId",body,visibility,kind) VALUES (gen_random_uuid(),$1,$2,'x','PRIVATE','NOTE')`,
      [U(30), agent],
    );
  });

  it('audit_target_actor and eventKey uniqueness', async () => {
    await insertTicket(40);
    const ins = (
      target: string,
      ticketId: string | null,
      sweepId: string | null,
      actorType: string,
      actorId: string | null,
      key: string,
    ) =>
      expectPgError(
        c,
        `INSERT INTO audit_logs(id,target,"ticketId","sweepId","correlationId","actorType","actorId",action,details,"eventKey")
       VALUES (gen_random_uuid(),$1::"AuditTarget",$2,$3,'c',$4::"ActorType",$5,'X','{}',$6)`,
        [target, ticketId, sweepId, actorType, actorId, key],
      );
    expect((await ins('TICKET', null, null, 'SYSTEM', null, 'k1')).constraint).toBe(
      'audit_target_actor',
    ); // ticket target needs ticketId
    expect((await ins('SWEEP', U(40), null, 'SYSTEM', null, 'k2')).constraint).toBe(
      'audit_target_actor',
    );
    expect((await ins('TICKET', U(40), null, 'AGENT', null, 'k3')).constraint).toBe(
      'audit_target_actor',
    ); // non-system needs actor
    expect((await ins('TICKET', U(40), null, 'SYSTEM', agent, 'k4')).constraint).toBe(
      'audit_target_actor',
    ); // system must not have actor
    await c.query(
      `INSERT INTO audit_logs(id,target,"ticketId","correlationId","actorType","actorId",action,details,"eventKey") VALUES (gen_random_uuid(),'TICKET',$1,'c','AGENT',$2,'X','{}','dup')`,
      [U(40), agent],
    );
    expect((await ins('TICKET', U(40), null, 'AGENT', agent, 'dup')).code).toBe('23505');
  });

  it('SweepInvocation: actor/state/lease/progress constraints and unique key', async () => {
    const ins = (o: Record<string, unknown>) => {
      const row = {
        id: U(Math.floor(Math.random() * 1e9) + 100),
        actorType: 'SYSTEM',
        actorId: null,
        key: 'k-' + Math.random(),
        requestHash: 'h',
        state: 'RUNNING',
        startedAt: '2026-11-20T10:00:00Z',
        leaseUntil: '2026-11-20T10:00:30Z',
        leaseToken: 'tok',
        ...o,
      };
      const keys = Object.keys(row);
      const cast = (k: string) =>
        k === 'actorType' ? '::"ActorType"' : k === 'state' ? '::"SweepState"' : '';
      return expectPgError(
        c,
        `INSERT INTO "SweepInvocation"(${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((k, i) => `$${i + 1}${cast(k)}`).join(',')})`,
        Object.values(row),
      );
    };
    const good = { id: U(900001), key: 'good' };
    const gr = {
      ...{
        actorType: 'SYSTEM',
        actorId: null,
        requestHash: 'h',
        state: 'RUNNING',
        startedAt: '2026-11-20T10:00:00Z',
        leaseUntil: '2026-11-20T10:00:30Z',
        leaseToken: 'tok',
      },
      ...good,
    };
    await c.query(
      `INSERT INTO "SweepInvocation"(id,"actorType","actorId",key,"requestHash",state,"startedAt","leaseUntil","leaseToken") VALUES ($1,'SYSTEM',NULL,$2,$3,'RUNNING',$4,$5,$6)`,
      [gr.id, gr.key, gr.requestHash, gr.startedAt, gr.leaseUntil, gr.leaseToken],
    );
    expect((await ins({ key: 'good' })).code).toBe('23505');
    const expectCheck = async (o: Record<string, unknown>, name: string) =>
      expect((await ins(o)).constraint).toBe(name);
    await expectCheck({ actorType: 'AGENT', actorId: agent }, 'sweep_actor_state');
    await expectCheck({ actorType: 'LEAD', actorId: null }, 'sweep_actor_state');
    await expectCheck({ leaseUntil: '2026-11-20T09:00:00Z' }, 'sweep_actor_state');
    await expectCheck(
      { state: 'COMPLETED', finishedAt: '2026-11-20T10:01:00Z' },
      'sweep_progress_terminal',
    ); // COMPLETED needs 200/result
    await expectCheck({ processed: 1, autoClosed: 1, expired: 1 }, 'sweep_progress_terminal'); // closed+expired > processed
    await expectCheck({ leaseToken: '' }, 'sweep_progress_terminal');
    await expectCheck({ failed: -1 }, 'sweep_progress_terminal');
    await expectCheck(
      { state: 'FAILED', finishedAt: '2026-11-20T10:01:00Z', responseStatus: 200, result: '{}' },
      'sweep_progress_terminal',
    ); // FAILED must be 503
    // coherent terminal rows are accepted
    await c.query(
      `INSERT INTO "SweepInvocation"(id,"actorType",key,"requestHash",state,"startedAt","leaseUntil","leaseToken","finishedAt","responseStatus",result,processed,"autoClosed")
      VALUES ($1,'SYSTEM','done','h','COMPLETED','2026-11-20T10:00:00Z','2026-11-20T10:00:30Z','t','2026-11-20T10:00:05Z',200,'{"ok":true}',3,1)`,
      [U(900002)],
    );
    await c.query(
      `INSERT INTO "SweepInvocation"(id,"actorType",key,"requestHash",state,"startedAt","leaseUntil","leaseToken","finishedAt","responseStatus",result)
      VALUES ($1,'SYSTEM','failed','h','FAILED','2026-11-20T10:00:00Z','2026-11-20T10:00:30Z','t','2026-11-20T10:00:31Z',503,'{"code":"SWEEP_LEASE_EXPIRED"}')`,
      [U(900003)],
    );
  });

  it('IdempotencyRecord: response and responseStatus are set together; key unique per actor+operation', async () => {
    const ins = (n: number, resp: string | null, status: number | null, key = 'k') =>
      expectPgError(
        c,
        `INSERT INTO "IdempotencyRecord"(id,"actorId",operation,key,"requestHash",response,"responseStatus") VALUES ($1,$2,'claim',$3,'h',$4::jsonb,$5)`,
        [U(n), agent, key, resp, status],
      );
    expect((await ins(1, '{"a":1}', null)).constraint).toBe('idempotency_result_pair');
    expect((await ins(2, null, 200)).constraint).toBe('idempotency_result_pair');
    await c.query(
      `INSERT INTO "IdempotencyRecord"(id,"actorId",operation,key,"requestHash") VALUES ($1,$2,'claim','k','h')`,
      [U(3), agent],
    );
    expect((await ins(4, null, null)).code).toBe('23505');
  });

  it('partial index for unprocessed due clocks exists', async () => {
    const r = await c.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname='sla_unprocessed_due_idx'`,
    );
    expect(r.rows[0].indexdef).toMatch(/WHERE .*RUNNING.*currentLate.* = false|WHERE.*currentLate/);
  });
});
