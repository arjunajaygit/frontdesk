import { CommitHooks } from '../../apps/api/src/observability/commit-hooks';
import { MetricsService } from '../../apps/api/src/observability/metrics.service';
import { Logger, PinoLogger } from 'nestjs-pino';
import { Client } from 'pg';
import type { TicketDomainEvent } from '../../apps/api/src/domain/ticket/audit-events';
import { IdempotencyService } from '../../apps/api/src/tickets/idempotency.service';
import { AuditValidator, AuditWriter } from '../../apps/api/src/tickets/audit.writer';
import type { Tx } from '../../apps/api/src/tickets/unit-of-work';
import { SweepService } from '../../apps/api/src/sweep/sweep.service';
import { SweepScheduler } from '../../apps/api/src/sweep/sweep.scheduler';
import { connect } from '../helpers/db';
import { Browser, newKey, signedIn, startApp, TestApp } from '../helpers/http';
import { LockHolder, Observer } from '../helpers/observe';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

const C1 = 'aarav.menon@customer.example';
const C2 = 'diya.kapoor@customer.example';
const AG1 = 'arjun.nair@arvo.example';
const AG2 = 'priya.sharma@arvo.example';

/** Controllable audit writer: lets a test pause INSIDE the business transaction before the append. */
class GatedAuditWriter extends AuditWriter {
  gate: Promise<void> | null = null;
  entered: (() => void) | null = null;
  override async appendTicketEvents(
    tx: Tx,
    events: readonly TicketDomainEvent[],
    correlationId: string,
    priority?: string,
  ): Promise<void> {
    if (this.gate) {
      this.entered?.();
      await this.gate;
    }
    return super.appendTicketEvents(tx, events, correlationId, priority);
  }
}

let t: TestApp;
let db: string;
let owner: Client;
let observer: Observer;
let c1: Browser, c2: Browser, ag1: Browser, ag2: Browser;
const writer = new GatedAuditWriter(
  new AuditValidator(),
  new CommitHooks(),
  new MetricsService({} as never),
);

beforeAll(async () => {
  db = await cloneTemplate('remed');
  t = await startApp(db, {}, (b) => b.overrideProvider(AuditWriter).useValue(writer));
  owner = await connect('owner', db);
  observer = await Observer.open(db);
  [c1, c2, ag1, ag2] = await Promise.all([
    signedIn(t, C1),
    signedIn(t, C2),
    signedIn(t, AG1),
    signedIn(t, AG2),
  ]);
});
afterAll(async () => {
  await owner?.end();
  await observer?.close();
  await t?.close();
  await dropDatabase(db);
});

const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await owner.query(sql, p)).rows as T[];
async function customerTicket(c = c1) {
  const r = await c.post('/api/customer/tickets', { subject: 'Remediation', body: 'Problem' });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

describe('customer mutations never lock (or wait on) a foreign ticket', () => {
  it('busy foreign ticket and nonexistent ticket both 404 immediately; nothing is committed', async () => {
    const id = await customerTicket(c1);
    const holder = await LockHolder.hold(db, `SELECT id FROM "Ticket" WHERE id=$1 FOR UPDATE`, [
      id,
    ]);
    try {
      const keys = [newKey(), newKey()];
      const started = Date.now();
      const reply = await c2.post(
        `/api/customer/tickets/${id}/replies`,
        { body: 'not mine' },
        keys[0],
      );
      const reopen = await c2.post(
        `/api/customer/tickets/${id}/reopen`,
        { body: 'not mine' },
        keys[1],
      );
      const missing = await c2.post(
        `/api/customer/tickets/00000000-0000-4000-8000-000000000000/replies`,
        { body: 'x' },
      );
      expect(Date.now() - started).toBeLessThan(1_500); // the foreign lock (held) was never waited on
      expect([reply.status, reopen.status, missing.status]).toEqual([404, 404, 404]);
      expect(reply.body.code).toBe(missing.body.code);
      expect(reply.body.message).toBe(missing.body.message);
      expect(
        await q(`SELECT count(*)::int n FROM "IdempotencyRecord" WHERE key = ANY($1)`, [keys]),
      ).toEqual([{ n: 0 }]);
      expect(await q(`SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1`, [id])).toEqual([
        { n: 1 },
      ]);
      // The owner's authorised reply DOES take the ticket lock: it waits behind the holder.
      const own = Promise.resolve(c1.post(`/api/customer/tickets/${id}/replies`, { body: 'mine' })); // supertest is lazy: start it
      await observer.waitForLockWaiters('%FROM "Ticket"%FOR UPDATE%', 1);
      await holder.release();
      expect((await own).status).toBe(200);
    } finally {
      await holder.release().catch(() => undefined);
    }
  });
});

describe('idempotent replay re-checks CURRENT authorisation before releasing a stored response', () => {
  it('former owner replaying after an ownership change gets 404, no stored body leak', async () => {
    const id = await customerTicket(c1);
    const key = newKey();
    const first = await c1.post(`/api/customer/tickets/${id}/replies`, { body: 'hello' }, key);
    expect(first.status).toBe(200);
    expect(
      (await c1.post(`/api/customer/tickets/${id}/replies`, { body: 'hello' }, key)).body,
    ).toEqual(first.body); // authorised replay exact
    await owner.query(`UPDATE "Ticket" SET "customerId"=$1 WHERE id=$2`, [c2.viewer!.id, id]);
    const replay = await c1.post(`/api/customer/tickets/${id}/replies`, { body: 'hello' }, key);
    expect(replay.status).toBe(404);
    expect(replay.text).not.toContain('hello');
    expect(
      (await c1.post(`/api/customer/tickets/${id}/replies`, { body: 'changed' }, key)).body.code,
    ).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('former assignee replaying an assignee-only command after reassignment gets 403 NOT_ASSIGNEE', async () => {
    const id = await customerTicket(c1);
    await ag1.post(`/api/tickets/${id}/claim`);
    const key = newKey();
    const first = await ag1.post(`/api/tickets/${id}/notes`, { body: 'internal' }, key);
    expect(first.status).toBe(200);
    const msgs = await q(`SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1`, [id]);
    expect((await ag1.post(`/api/tickets/${id}/notes`, { body: 'internal' }, key)).body).toEqual(
      first.body,
    );
    expect(await q(`SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1`, [id])).toEqual(
      msgs,
    ); // side-effect free
    await owner.query(`UPDATE "Ticket" SET "assigneeId"=$1 WHERE id=$2`, [ag2.viewer!.id, id]);
    const replay = await ag1.post(`/api/tickets/${id}/notes`, { body: 'internal' }, key);
    expect(replay.status).toBe(403);
    expect(replay.body.code).toBe('NOT_ASSIGNEE');
    expect(replay.text).not.toContain('internal');
  });
});

describe('logical event time vs actual audit recording time', () => {
  it('breachedAt stays deadline+1 while recordedAt/createdAt reflect the delayed append; message & publication agree', async () => {
    const id = await customerTicket(c1);
    await ag1.post(`/api/tickets/${id}/claim`);
    const deadline = (
      await q<{ deadline: Date }>(
        `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '5 seconds' WHERE "ticketId"=$1 AND kind='RESPONSE' RETURNING "deadlineAt" AS deadline`,
        [id],
      )
    )[0]!.deadline;
    let release!: () => void;
    writer.gate = new Promise((r) => (release = r));
    const entered = new Promise<void>((r) => (writer.entered = r));
    const pending = Promise.resolve(ag1.post(`/api/tickets/${id}/replies`, { body: 'late reply' })); // start now
    await entered; // business tx is open; message row inserted but not committed
    // Not visible to any other session before commit:
    expect(
      await q(`SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1 AND body='late reply'`, [
        id,
      ]),
    ).toEqual([{ n: 0 }]);
    const gateAt = (await q<{ gateAt: Date }>(`SELECT clock_timestamp() AS "gateAt"`))[0]!.gateAt;
    await observer.untilDbTimeAfter(new Date(gateAt.getTime() + 300));
    writer.gate = null;
    release();
    expect((await pending).status).toBe(200);
    const events = await q<{
      action: string;
      createdAt: Date;
      actorId: string | null;
      details: Record<string, string>;
    }>(
      `SELECT action, "createdAt", "actorId", details FROM audit_logs WHERE "ticketId"=$1 AND action IN ('SLA_BREACHED','MESSAGE_PUBLISHED','SLA_COMPLETED') ORDER BY "createdAt", id`,
      [id],
    );
    const breach = events.find((e) => e.action === 'SLA_BREACHED')!;
    const pub = events.filter((e) => e.action === 'MESSAGE_PUBLISHED').at(-1)!;
    expect(breach.details.breachedAt).toBe(new Date(deadline.getTime() + 1).toISOString()); // logical onset
    expect(new Date(breach.details.recordedAt!).getTime()).toBe(breach.createdAt.getTime()); // recording time
    expect(breach.createdAt.getTime()).toBeGreaterThanOrEqual(gateAt.getTime() + 300); // after the delayed append
    const [msg] = await q<{ createdAt: Date; authorId: string }>(
      `SELECT "createdAt", "authorId" FROM "Message" WHERE "ticketId"=$1 AND body='late reply'`,
      [id],
    );
    expect(pub.details.publishedAt).toBe(msg!.createdAt.toISOString()); // logical publication == message time
    expect(pub.actorId).toBe(msg!.authorId);
    expect(pub.createdAt.getTime()).toBeGreaterThan(msg!.createdAt.getTime()); // recorded later than logical time
  });
});

describe('same-priority requests still honour lifecycle guards', () => {
  const patch = (b: Browser, id: string, p = 'MEDIUM') =>
    b.patch(`/api/tickets/${id}/priority`, { priority: p });
  it('RESOLVED, CLOSED and overdue WAITING reject; IN_PROGRESS and eligible WAITING are pure no-ops', async () => {
    const resolved = await customerTicket(c1);
    await ag1.post(`/api/tickets/${resolved}/claim`);
    await ag1.post(`/api/tickets/${resolved}/resolve`, { body: 'done' });
    expect((await patch(ag1, resolved)).status).toBe(409);

    await owner.query(
      `UPDATE "Ticket" SET "resolvedAt" = now() - interval '9 days', "reopenUntil" = now() - interval '2 days' WHERE id=$1`,
      [resolved],
    );
    await c1.post(`/api/customer/tickets/${resolved}/replies`, { body: 'ping' }); // closes old, links child
    expect((await q(`SELECT status FROM "Ticket" WHERE id=$1`, [resolved]))[0]).toEqual({
      status: 'CLOSED',
    });
    expect((await patch(ag1, resolved)).status).toBe(409);

    const waiting = await customerTicket(c1);
    await ag1.post(`/api/tickets/${waiting}/claim`);
    await ag1.post(`/api/tickets/${waiting}/wait`, { body: 'info?' });
    const v = (
      await q<{ version: number }>(`SELECT version FROM "Ticket" WHERE id=$1`, [waiting])
    )[0]!.version;
    const ok = await patch(ag1, waiting);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(v); // eligible WAITING: no-op
    await owner.query(
      `UPDATE "Ticket" SET "waitingSince" = now() - interval '10 days', "waitingCloseDueAt" = now() - interval '1 minute' WHERE id=$1`,
      [waiting],
    );
    expect((await patch(ag1, waiting)).status).toBe(409); // effectively expired
    expect((await q(`SELECT status, version FROM "Ticket" WHERE id=$1`, [waiting]))[0]).toEqual({
      status: 'WAITING',
      version: v,
    }); // nothing persisted

    const active = await customerTicket(c1);
    await ag1.post(`/api/tickets/${active}/claim`);
    const same = await patch(ag1, active);
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(1);
    expect(same.body.clocks.every((c: { policyRevision: number }) => c.policyRevision === 0)).toBe(
      true,
    );
  });
});

describe('classified error logging and independent retention maintenance', () => {
  it('a dependency failure carrying a private marker never reaches logs or the HTTP error', async () => {
    const MARKER = 'M05-PRIVATE-MARKER-9d1e';
    const captured: string[] = [];
    const capture = (...args: unknown[]) => void captured.push(JSON.stringify(args));
    const spies = [
      jest.spyOn(PinoLogger.prototype, 'error').mockImplementation(capture),
      jest.spyOn(PinoLogger.prototype, 'warn').mockImplementation(capture),
      jest.spyOn(PinoLogger.prototype, 'info').mockImplementation(capture),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(capture),
    ];
    const id = await customerTicket(c1);
    await ag1.post(`/api/tickets/${id}/claim`);
    const fail = jest
      .spyOn(writer, 'appendTicketEvents')
      .mockRejectedValueOnce(
        new Error(`connection reset while writing note ${MARKER} password=hunter2`),
      );
    try {
      const r = await ag1.post(`/api/tickets/${id}/notes`, { body: `${MARKER} note body` });
      expect(r.status).toBe(500);
      expect(r.text).not.toContain(MARKER);
      jest
        .spyOn(t.app.get(SweepService), 'runScheduled')
        .mockRejectedValueOnce(new Error(`sweep exploded ${MARKER}`));
      await t.app.get(SweepScheduler).tick();
      expect(captured.length).toBeGreaterThan(0);
      for (const line of captured) {
        expect(line).not.toContain(MARKER);
        expect(line).not.toContain('hunter2');
      }
      expect(captured.join('\n')).toMatch(/"errorClass":"Error"/);
    } finally {
      fail.mockRestore();
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('retention runs even when every sweep fails; only completed, expired snapshots are purged', async () => {
    const actor = c1.viewer!.id;
    const ins = (key: string, ageHours: number, completed: boolean) =>
      owner.query(
        `INSERT INTO "IdempotencyRecord"(id,"actorId",operation,key,"requestHash","createdAt",response,"responseStatus")
         VALUES (gen_random_uuid(),$1,'TEST op',$2,'h', now() - make_interval(hours => $3), ${completed ? `'{"ok":true}'::jsonb, 200` : 'NULL, NULL'})`,
        [actor, key, ageHours],
      );
    await ins('m05-old-done', 30, true);
    await ins('m05-fresh-done', 1, true);
    await ins('m05-old-pending', 30, false); // defensive: a committed pending row is never purged
    // An in-flight (uncommitted) reservation in another transaction:
    const inflight = await connect('owner', db);
    await inflight.query('BEGIN');
    await inflight.query(
      `INSERT INTO "IdempotencyRecord"(id,"actorId",operation,key,"requestHash","createdAt") VALUES (gen_random_uuid(),$1,'TEST op','m05-inflight','h', now() - interval '30 hours')`,
      [actor],
    );
    const sweep = jest
      .spyOn(t.app.get(SweepService), 'runScheduled')
      .mockRejectedValue(new Error('sweep down'));
    try {
      await t.app.get(SweepScheduler).tick();
      await t.app.get(SweepScheduler).tick();
    } finally {
      sweep.mockRestore();
    }
    const keys = (
      await q<{ key: string }>(
        `SELECT key FROM "IdempotencyRecord" WHERE operation='TEST op' ORDER BY key`,
      )
    ).map((r) => r.key);
    expect(keys).toEqual(['m05-fresh-done', 'm05-old-pending']);
    await inflight.query('COMMIT');
    await inflight.end();
    expect(
      (await q<{ key: string }>(`SELECT key FROM "IdempotencyRecord" WHERE key='m05-inflight'`))
        .length,
    ).toBe(1); // survived maintenance
    expect(await t.app.get(IdempotencyService).purgeExpired()).toBeGreaterThanOrEqual(0);
  });

  it('refresh-token history of live sessions is never purged (reuse detection preserved)', async () => {
    const b = await signedIn(t, AG2);
    const sid = (b.cookie('frontdesk_refresh') ?? '').split('.')[0];
    await owner.query(
      `UPDATE "RefreshToken" SET "issuedAt" = now() - interval '30 days' WHERE "sessionId"=$1`,
      [sid],
    );
    await t.app.get(SweepScheduler).tick();
    expect(
      (await q(`SELECT count(*)::int n FROM "RefreshToken" WHERE "sessionId"=$1`, [sid]))[0],
    ).toEqual({ n: 1 });
  });
});
