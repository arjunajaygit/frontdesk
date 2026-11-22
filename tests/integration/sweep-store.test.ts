import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { validateSweepDetails } from '../../apps/api/src/domain/sweep/sweep-events';
import {
  candidateDueAt,
  compareCandidates,
  SweepCandidate,
  sweepKey,
} from '../../apps/api/src/domain/sweep/sweep-policy';
import { PgSweepStore } from '../../apps/api/src/infrastructure/sweep/pg-sweep-store';
import { aggregateFromRows } from '../../apps/api/src/infrastructure/persistence/ticket-mapper';
import { connect, roleUrl, SEED_ANCHOR } from '../helpers/db';
import { loadSpec, makeValidator } from '../helpers/openapi';

/**
 * Real PostgreSQL, single-connection behaviour of the sweep selection and invocation bookkeeping, executed as
 * the restricted runtime role. Overlapping workers, crash-after-commit and per-ticket transactions are M3/M4.
 */
const anchor = Date.parse(SEED_ANCHOR);
let db: PrismaClient;
let store: PgSweepStore;
let owner: Client;
let lead: { type: 'LEAD'; id: string };

beforeAll(async () => {
  db = new PrismaClient({ datasources: { db: { url: roleUrl('app') } } });
  store = new PgSweepStore(db);
  owner = await connect('owner');
  const r = await owner.query(`SELECT id FROM "User" WHERE role='LEAD' LIMIT 1`);
  lead = { type: 'LEAD', id: r.rows[0].id };
});
afterAll(async () => {
  await db.$disconnect();
  await owner.end();
});

async function pureCandidates(snapshot: number): Promise<SweepCandidate[]> {
  const tickets = await db.ticket.findMany({ include: { clocks: true } });
  return tickets
    .map(({ clocks, ...t }) => ({
      ticketId: t.id,
      dueAt: candidateDueAt(aggregateFromRows(t, clocks), snapshot),
    }))
    .filter((c): c is SweepCandidate => c.dueAt !== null)
    .sort(compareCandidates);
}
const subjectOf = async (id: string) =>
  (await db.ticket.findUniqueOrThrow({ where: { id } })).subject.slice(1, 7);
const ticket = (no: string) =>
  db.ticket.findFirstOrThrow({
    where: { subject: { startsWith: `[${no}]` } },
    include: { clocks: true },
  });

describe('candidate selection (SQL) on the seeded historical data', () => {
  it('runs as the restricted runtime role and reads authoritative DB time with ms precision', async () => {
    const [who] = await db.$queryRaw<{ u: string }[]>`SELECT current_user AS u`;
    expect(who!.u).toBe('frontdesk_app');
    const now = await store.now();
    expect(Number.isSafeInteger(now)).toBe(true);
    expect(Math.abs(now - Date.now())).toBeLessThan(60_000);
  });

  it('SQL candidates equal the pure domain rule at the anchor and excludes already-recorded breaches', async () => {
    const sql = await store.selectCandidates(anchor, null, 1000);
    expect(sql).toEqual(await pureCandidates(anchor));
    const nos = await Promise.all(sql.map((c) => subjectOf(c.ticketId)));
    expect(nos).toEqual(expect.arrayContaining(['FD-007', 'FD-009', 'FD-013', 'FD-014']));
    expect(nos).not.toContain('FD-001'); // both breaches already recorded (old deadlines must not qualify)
    expect(nos).not.toContain('FD-002'); // resolution recorded; response completed
    expect(nos).not.toContain('FD-012'); // paused clocks are never candidates
    expect(await store.anyDue(anchor)).toBe(true);
  });

  it('strict cutoffs: exact cutoff excluded, +1 ms included (waiting, reopen window, running deadline)', async () => {
    const t7 = await ticket('FD-007');
    const t9 = await ticket('FD-009');
    const t13 = await ticket('FD-013');
    const deadline13 = t13.clocks.find((c) => c.kind === 'RESOLUTION')!.deadlineAt!.getTime();
    for (const [id, cutoff] of [
      [t7.id, t7.waitingCloseDueAt!.getTime()],
      [t9.id, t9.reopenUntil!.getTime()],
      [t13.id, deadline13],
    ] as const) {
      const at = (await store.selectCandidates(cutoff, null, 1000)).map((c) => c.ticketId);
      const after = (await store.selectCandidates(cutoff + 1, null, 1000)).map((c) => c.ticketId);
      expect({ id, atCutoff: at.includes(id), afterCutoff: after.includes(id) }).toEqual({
        id,
        atCutoff: false,
        afterCutoff: true,
      });
      expect(await store.selectCandidates(cutoff + 1, null, 1000)).toEqual(
        await pureCandidates(cutoff + 1),
      );
    }
  });

  it('keyset pages are stable, strictly increasing, gap-free and duplicate-free', async () => {
    const all = await store.selectCandidates(anchor, null, 1000);
    expect(all.length).toBeGreaterThanOrEqual(4);
    const paged: SweepCandidate[] = [];
    let cursor: SweepCandidate | null = null;
    for (;;) {
      const page: SweepCandidate[] = await store.selectCandidates(anchor, cursor, 2);
      if (page.length === 0) break;
      paged.push(...page);
      cursor = page[page.length - 1]!;
    }
    expect(paged).toEqual(all);
    for (let i = 1; i < paged.length; i++)
      expect(compareCandidates(paged[i - 1]!, paged[i]!)).toBeLessThan(0);
  });

  it('nothing is due before the earliest seeded deadline', async () => {
    expect(await store.anyDue(Date.parse('2026-01-01T00:00:00Z'))).toBe(false);
    expect(await store.selectCandidates(Date.parse('2026-01-01T00:00:00Z'), null, 10)).toEqual([]);
  });
});

describe('invocation reservation, fencing and recovery (single connection)', () => {
  const hash = 'sha256:request-a';
  const expire = (id: string) =>
    owner.query(
      `UPDATE "SweepInvocation" SET "startedAt" = clock_timestamp() - interval '1 minute', "leaseUntil" = clock_timestamp() - interval '1 second' WHERE id=$1`,
      [id],
    );
  const row = async (id: string) =>
    (await owner.query(`SELECT * FROM "SweepInvocation" WHERE id=$1`, [id])).rows[0];
  const audits = async (id: string) =>
    (
      await owner.query(
        `SELECT action, "actorType", "actorId", "correlationId", details, "eventKey" FROM audit_logs WHERE "sweepId"=$1 ORDER BY "createdAt", "eventKey"`,
        [id],
      )
    ).rows;
  const reserve = (
    key: string,
    requestHash = hash,
    initiator: { type: 'SYSTEM' } | { type: 'LEAD'; id: string } = lead,
  ) =>
    store.reserve({
      initiator,
      key: sweepKey(initiator, key),
      requestHash,
      correlationId: `corr-${key}`,
      leaseMs: 30_000,
    });

  it('reserve writes one START audit attributed to the initiator without exposing the lease token', async () => {
    const r = await reserve('manual-0001');
    if (r.kind !== 'RESERVED') throw new Error(r.kind);
    const a = await audits(r.lease.id);
    expect(a).toEqual([
      expect.objectContaining({
        action: 'SWEEP_STARTED',
        actorType: 'LEAD',
        actorId: lead.id,
        correlationId: 'corr-manual-0001',
        eventKey: `sweep:${r.lease.id}:start`,
      }),
    ]);
    expect(JSON.stringify(a)).not.toContain(r.lease.token);
    expect(validateSweepDetails('SWEEP_STARTED', a[0].details)).toBeTruthy();
    expect(await reserve('manual-0001')).toEqual({
      kind: 'CONFLICT',
      status: 409,
      code: 'SWEEP_IN_PROGRESS',
    });
    expect(await reserve('manual-0001', 'sha256:different')).toEqual({
      kind: 'CONFLICT',
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('live lease renews; stale tokens are fenced; finish completes once and replays identically', async () => {
    const r = await reserve('manual-0002');
    if (r.kind !== 'RESERVED') throw new Error(r.kind);
    const stale = { id: r.lease.id, token: 'stale-token' };
    expect(await store.refreshLease(r.lease, 30_000)).toBe(true);
    expect(await store.refreshLease(stale, 30_000)).toBe(false);
    expect(await store.recordFailure(stale)).toBe(false);
    expect(await store.finish(stale, false)).toEqual({ kind: 'FENCED' });
    expect(await store.recordFailure(r.lease)).toBe(true);
    const done = await store.finish(r.lease, true);
    expect(done).toMatchObject({
      kind: 'COMPLETED',
      status: 200,
      body: {
        invocationId: r.lease.id,
        correlationId: 'corr-manual-0002',
        failed: 1,
        processed: 0,
        moreDue: true,
      },
    });
    const sweepResult = makeValidator(loadSpec())('SweepResult');
    expect(sweepResult((done as { body: unknown }).body)).toBe(true);
    expect(await store.finish(r.lease, true)).toEqual({ kind: 'FENCED' }); // terminal: cannot finish twice
    expect(await store.refreshLease(r.lease, 30_000)).toBe(false); // nor renew
    expect(await reserve('manual-0002')).toEqual({
      kind: 'REPLAY',
      status: 200,
      body: (done as { body: unknown }).body,
    });
    expect((await audits(r.lease.id)).map((a: { action: string }) => a.action)).toEqual([
      'SWEEP_STARTED',
      'SWEEP_FINISHED',
    ]);
    expect((await row(r.lease.id)).state).toBe('COMPLETED');
  });

  it('expired lease: worker is fenced; recovery terminalises once with SWEEP_LEASE_EXPIRED and preserves committed counters', async () => {
    const r = await reserve('manual-0003');
    if (r.kind !== 'RESERVED') throw new Error(r.kind);
    // Simulated committed per-ticket progress (the M3 processor commits these with domain changes).
    await owner.query(
      `UPDATE "SweepInvocation" SET processed=2, "autoClosed"=1, "breachesRecorded"=1 WHERE id=$1`,
      [r.lease.id],
    );
    await expire(r.lease.id);
    const expiredAt = (await row(r.lease.id)).leaseUntil.toISOString();
    expect(await store.refreshLease(r.lease, 30_000)).toBe(false);
    expect(await store.recordFailure(r.lease)).toBe(false);
    expect(await store.finish(r.lease, false)).toEqual({ kind: 'FENCED' });
    expect(await store.recoverExpired(20)).toBeGreaterThanOrEqual(1);
    expect(await store.recoverExpired(20)).toBe(0); // repeated recovery is a no-op
    const after = await row(r.lease.id);
    expect({
      state: after.state,
      status: after.responseStatus,
      processed: after.processed,
      autoClosed: after.autoClosed,
      breaches: after.breachesRecorded,
    }).toEqual({ state: 'FAILED', status: 503, processed: 2, autoClosed: 1, breaches: 1 });
    const a = await audits(r.lease.id);
    expect(a.map((x: { action: string }) => x.action)).toEqual([
      'SWEEP_STARTED',
      'SWEEP_RECOVERED',
    ]);
    expect(a[1]).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      correlationId: 'corr-manual-0003',
    });
    expect(validateSweepDetails('SWEEP_RECOVERED', a[1].details)).toEqual({
      processed: 2,
      autoClosed: 1,
      expired: 0,
      breachesRecorded: 1,
      failed: 0,
      errorCode: 'SWEEP_LEASE_EXPIRED',
      expiredLeaseAt: expiredAt,
    });
    const replay = await reserve('manual-0003');
    expect(replay).toEqual({
      kind: 'REPLAY',
      status: 503,
      body: {
        code: 'SWEEP_LEASE_EXPIRED',
        message: expect.any(String),
        requestId: 'corr-manual-0003',
      },
    });
    expect(await reserve('manual-0003')).toEqual(replay); // stable
    expect(await store.finish(r.lease, false)).toEqual({ kind: 'FENCED' }); // a stale worker can never finalise a recovered run
    expect((await reserve('manual-0004')).kind).toBe('RESERVED'); // a new key may start catch-up
  });

  it('same-key retry of an expired RUNNING invocation recovers it first, then replays the stored failure', async () => {
    const r = await reserve('manual-0005');
    if (r.kind !== 'RESERVED') throw new Error(r.kind);
    await expire(r.lease.id);
    expect(await reserve('manual-0005')).toMatchObject({
      kind: 'REPLAY',
      status: 503,
      body: { code: 'SWEEP_LEASE_EXPIRED' },
    });
    expect((await audits(r.lease.id)).map((a: { action: string }) => a.action)).toEqual([
      'SWEEP_STARTED',
      'SWEEP_RECOVERED',
    ]);
  });

  it('zero-ticket SYSTEM invocation that expired is recovered and attributed', async () => {
    const r = await reserve('tick-00000001', 'sha256:tick', { type: 'SYSTEM' });
    if (r.kind !== 'RESERVED') throw new Error(r.kind);
    await expire(r.lease.id);
    await store.recoverExpired(20);
    const a = await audits(r.lease.id);
    expect(
      a.map((x: { action: string; actorType: string }) => `${x.action}:${x.actorType}`),
    ).toEqual(['SWEEP_STARTED:SYSTEM', 'SWEEP_RECOVERED:SYSTEM']);
    expect(validateSweepDetails('SWEEP_RECOVERED', a[1].details)).toMatchObject({ processed: 0 });
  });

  it('controlled failure while leased stores a stable terminal SWEEP_FAILED 503', async () => {
    const r = await reserve('manual-0006');
    if (r.kind !== 'RESERVED') throw new Error(r.kind);
    const failed = await store.fail(r.lease, 'SWEEP_FAILED');
    expect(failed).toMatchObject({
      kind: 'FAILED',
      status: 503,
      body: { code: 'SWEEP_FAILED', requestId: 'corr-manual-0006' },
    });
    expect(await reserve('manual-0006')).toEqual({
      kind: 'REPLAY',
      status: 503,
      body: (failed as { body: unknown }).body,
    });
    expect(await store.fail(r.lease, 'SWEEP_FAILED')).toEqual({ kind: 'FENCED' });
  });

  it('every sweep audit row passes its strict schema and no row carries a lease token', async () => {
    const rows = (
      await owner.query(
        `SELECT a.action, a.details, s."leaseToken" FROM audit_logs a JOIN "SweepInvocation" s ON s.id=a."sweepId"`,
      )
    ).rows;
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const r of rows) {
      expect(() => validateSweepDetails(r.action, r.details)).not.toThrow();
      expect(JSON.stringify(r.details)).not.toContain(r.leaseToken);
    }
  });
});
