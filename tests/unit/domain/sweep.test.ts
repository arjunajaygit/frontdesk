import {
  SweepAuditSchemas,
  validateSweepDetails,
} from '../../../apps/api/src/domain/sweep/sweep-events';
import {
  SweepCandidate,
  SweepCounters,
  SweepCursor,
  afterCursor,
  candidateDueAt,
  compareCandidates,
  decideReservation,
  isLeaseLive,
  isRecoverable,
  sweepKey,
} from '../../../apps/api/src/domain/sweep/sweep-policy';
import {
  InvocationLease,
  SweepCandidateSource,
  SweepInvocationStore,
  SweepRunner,
  SweepTicketProcessor,
  TerminalOutcome,
  TicketProcessOutcome,
} from '../../../apps/api/src/domain/sweep/sweep-runner';
import type { TicketLifecycle } from '../../../apps/api/src/domain/ticket/ticket-lifecycle';
import type { TicketAggregate } from '../../../apps/api/src/domain/ticket/ticket.types';
import { AGENT, CUSTOMER, ist, lifecycle } from '../../helpers/domain';

describe('sweep candidate rule (pure mirror of the SQL query)', () => {
  const { lc } = lifecycle();
  const base = lc.customerIntake({
    actor: CUSTOMER,
    subject: 's',
    body: 'b',
    now: ist('2026-11-23T09:30'),
  }).aggregate;
  const responseDeadline = base.clocks[0]!.deadlineAt!;

  it('running clock is due strictly after its deadline', () => {
    expect(candidateDueAt(base, responseDeadline)).toBeNull();
    expect(candidateDueAt(base, responseDeadline + 1)).toBe(responseDeadline);
  });

  it('an already-recorded late clock never qualifies merely because its deadline is old', () => {
    const swept = lc.reconcileDue(base, responseDeadline + 1).aggregate;
    expect(swept.clocks[0]!.currentLate).toBe(true);
    expect(candidateDueAt(swept, responseDeadline + 10_000)).toBeNull(); // resolution not yet due
  });

  it('paused clocks are never candidates; WAITING qualifies only strictly after waitingCloseDueAt', () => {
    let agg = lc.claim(base, AGENT, ist('2026-11-23T09:35')).aggregate;
    agg = lc.requestInformation(agg, AGENT, 'Need info', ist('2026-11-23T10:00')).aggregate;
    const due = agg.ticket.waitingCloseDueAt!;
    expect(candidateDueAt(agg, due)).toBeNull();
    expect(candidateDueAt(agg, due + 1)).toBe(due);
  });

  it('keyset ordering is (dueAt, ticketId) with strict "after"', () => {
    const a: SweepCandidate = { ticketId: 'a', dueAt: 5 };
    const b: SweepCandidate = { ticketId: 'b', dueAt: 5 };
    const c: SweepCandidate = { ticketId: 'a', dueAt: 6 };
    expect([c, b, a].sort(compareCandidates)).toEqual([a, b, c]);
    expect(afterCursor(a, a)).toBe(false);
    expect(afterCursor(b, a)).toBe(true);
    expect(afterCursor(c, b)).toBe(true);
    expect(afterCursor(a, null)).toBe(true);
  });
});

describe('lease and reservation rules', () => {
  const inv = { state: 'RUNNING' as const, leaseToken: 'tok', leaseUntil: 1000 };
  it('lease is live strictly before leaseUntil; equality is expired; token must match', () => {
    expect(isLeaseLive(inv, 'tok', 999)).toBe(true);
    expect(isLeaseLive(inv, 'tok', 1000)).toBe(false);
    expect(isLeaseLive(inv, 'stale', 999)).toBe(false);
    expect(isLeaseLive({ ...inv, state: 'FAILED' }, 'tok', 0)).toBe(false);
    expect(isRecoverable(inv, 999)).toBe(false);
    expect(isRecoverable(inv, 1000)).toBe(true);
    expect(isRecoverable({ ...inv, state: 'COMPLETED' }, 5000)).toBe(false);
  });

  it('same-key decisions are deterministic', () => {
    const run = {
      state: 'RUNNING' as const,
      requestHash: 'h',
      leaseUntil: 1000,
      responseStatus: null,
      result: null,
    };
    expect(decideReservation(null, 'h', 0)).toEqual({ kind: 'RESERVE' });
    expect(decideReservation(run, 'other', 0)).toMatchObject({
      kind: 'CONFLICT',
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(
      decideReservation({ ...run, state: 'COMPLETED', responseStatus: 200 }, 'other', 0),
    ).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(decideReservation(run, 'h', 999)).toMatchObject({
      kind: 'IN_PROGRESS',
      code: 'SWEEP_IN_PROGRESS',
    });
    expect(decideReservation(run, 'h', 1000)).toEqual({ kind: 'RECOVER_THEN_REPLAY' });
    const body = { code: 'SWEEP_LEASE_EXPIRED' };
    expect(
      decideReservation({ ...run, state: 'FAILED', responseStatus: 503, result: body }, 'h', 5000),
    ).toEqual({ kind: 'REPLAY', status: 503, body });
  });

  it('keys are actor-scoped and validated', () => {
    expect(sweepKey({ type: 'SYSTEM' }, 'tick-00000001')).toBe('SYSTEM:-:tick-00000001');
    expect(sweepKey({ type: 'LEAD', id: 'u1' }, 'manual-key-1')).toBe('LEAD:u1:manual-key-1');
    expect(() => sweepKey({ type: 'SYSTEM' }, 'short')).toThrow(RangeError);
    expect(() => sweepKey({ type: 'SYSTEM' }, 'has spaces in it')).toThrow(RangeError);
  });

  it('sweep audit payloads are strict: unknown fields, lease tokens and bad codes are rejected', () => {
    const c = { processed: 1, autoClosed: 0, expired: 0, breachesRecorded: 1, failed: 0 };
    expect(validateSweepDetails('SWEEP_FINISHED', { ...c, moreDue: false })).toEqual({
      ...c,
      moreDue: false,
    });
    expect(() =>
      validateSweepDetails('SWEEP_STARTED', {
        leaseUntil: '2026-11-23T04:00:00.000Z',
        leaseToken: 'secret',
      }),
    ).toThrow();
    expect(() =>
      validateSweepDetails('SWEEP_FAILED', { ...c, errorCode: 'SWEEP_LEASE_EXPIRED' }),
    ).toThrow();
    expect(() =>
      validateSweepDetails('SWEEP_RECOVERED', { ...c, errorCode: 'SWEEP_LEASE_EXPIRED' }),
    ).toThrow(); // expiredLeaseAt required
    expect(() =>
      validateSweepDetails('SWEEP_FINISHED', { ...c, processed: -1, moreDue: true }),
    ).toThrow();
    expect(Object.keys(SweepAuditSchemas).sort()).toEqual([
      'SWEEP_FAILED',
      'SWEEP_FINISHED',
      'SWEEP_RECOVERED',
      'SWEEP_STARTED',
    ]);
  });
});

/** In-memory adapters that run the REAL domain lifecycle; they model ports, not PostgreSQL concurrency. */
class MemorySweep implements SweepInvocationStore, SweepCandidateSource, SweepTicketProcessor {
  tickets = new Map<string, TicketAggregate>();
  locked = new Set<string>();
  failing = new Set<string>();
  processedIds: string[] = [];
  inv = {
    id: 'inv-1',
    token: 'tok',
    state: 'RUNNING' as 'RUNNING' | 'COMPLETED' | 'FAILED',
    leaseUntil: 0,
  };
  counters: SweepCounters = {
    processed: 0,
    autoClosed: 0,
    expired: 0,
    breachesRecorded: 0,
    failed: 0,
  };
  clock: number;
  selectCalls = 0;
  failSelect = false;

  constructor(
    private readonly lc: TicketLifecycle,
    start: number,
  ) {
    this.clock = start;
  }
  reset(id: string) {
    this.inv = { id, token: `tok-${id}`, state: 'RUNNING', leaseUntil: this.clock + 30_000 };
    this.counters = { processed: 0, autoClosed: 0, expired: 0, breachesRecorded: 0, failed: 0 };
    return { id, token: `tok-${id}` };
  }
  private live(l: InvocationLease) {
    return isLeaseLive(
      { state: this.inv.state, leaseToken: this.inv.token, leaseUntil: this.inv.leaseUntil },
      l.token,
      this.clock,
    );
  }
  async now() {
    return this.clock;
  }
  async refreshLease(l: InvocationLease, ms: number) {
    if (!this.live(l)) return false;
    this.inv.leaseUntil = this.clock + ms;
    return true;
  }
  async recordFailure(l: InvocationLease) {
    if (!this.live(l)) return false;
    this.counters.failed++;
    return true;
  }
  async finish(l: InvocationLease, moreDue: boolean): Promise<TerminalOutcome> {
    if (!this.live(l)) return { kind: 'FENCED' };
    this.inv.state = 'COMPLETED';
    return { kind: 'COMPLETED', status: 200, body: { ...this.counters, moreDue } };
  }
  async fail(l: InvocationLease): Promise<TerminalOutcome> {
    if (!this.live(l)) return { kind: 'FENCED' };
    this.inv.state = 'FAILED';
    return { kind: 'FAILED', status: 503, body: { code: 'SWEEP_FAILED' }, code: 'SWEEP_FAILED' };
  }
  async recoverExpired() {
    if (this.inv.state === 'RUNNING' && isRecoverable(this.inv, this.clock)) {
      this.inv.state = 'FAILED';
      return 1;
    }
    return 0;
  }
  async selectCandidates(snapshot: number, after: SweepCursor | null, limit: number) {
    this.selectCalls++;
    if (this.failSelect) throw new Error('db unavailable');
    return [...this.tickets.values()]
      .map((a) => ({ ticketId: a.ticket.id, dueAt: candidateDueAt(a, snapshot) }))
      .filter(
        (c): c is SweepCandidate => c.dueAt !== null && afterCursor(c as SweepCandidate, after),
      )
      .sort(compareCandidates)
      .slice(0, limit);
  }
  async anyDue(snapshot: number) {
    return [...this.tickets.values()].some((a) => candidateDueAt(a, snapshot) !== null);
  }
  async processTicket(l: InvocationLease, id: string): Promise<TicketProcessOutcome> {
    if (!this.live(l)) return { kind: 'FENCED' };
    if (this.locked.has(id)) return { kind: 'SKIPPED_LOCKED' };
    if (this.failing.has(id)) throw new Error('ticket transaction failed');
    const r = this.lc.reconcileDue(this.tickets.get(id)!, this.clock);
    if (!r.changed) return { kind: 'NOOP' };
    this.tickets.set(id, r.aggregate);
    this.processedIds.push(id);
    this.counters.processed++;
    this.counters.autoClosed += r.counters.autoClosed;
    this.counters.expired += r.counters.expired;
    this.counters.breachesRecorded += r.counters.breachesRecorded;
    return { kind: 'CHANGED' };
  }
}

function backlog(n: number) {
  const { lc } = lifecycle();
  const store = new MemorySweep(lc, ist('2026-11-27T12:00'));
  // n fresh due tickets (response deadlines Mon 09:30 + 270 min + i ms) ...
  for (let i = 0; i < n; i++) {
    const a = lc.customerIntake({
      actor: CUSTOMER,
      subject: `t${i}`,
      body: 'b',
      now: ist('2026-11-23T09:30') + i,
    }).aggregate;
    store.tickets.set(a.ticket.id, a);
  }
  // ... plus older tickets whose breaches are ALREADY recorded (earlier deadlines must not starve fresh work)
  for (let i = 0; i < 5; i++) {
    const a = lc.customerIntake({
      actor: CUSTOMER,
      subject: `old${i}`,
      body: 'b',
      now: ist('2026-11-16T09:30') + i,
    }).aggregate;
    const swept = lc.reconcileDue(a, ist('2026-11-27T11:00')).aggregate;
    store.tickets.set(swept.ticket.id, swept);
  }
  let t = 0;
  const runner = (cfg = {}) =>
    new SweepRunner(
      { invocations: store, candidates: store, processor: store, monotonicMs: () => (t += 1) },
      cfg,
    );
  return { lc, store, runner };
}

describe('SweepRunner progression (ports exercised with the real domain; not a PostgreSQL proof)', () => {
  it('drains a backlog larger than one batch across invocations: bounded batches, moreDue, no duplicates, no starvation', async () => {
    const { store, runner } = backlog(120);
    const r1 = await runner({ batchSize: 50, maxBatches: 2 }).run(store.reset('inv-1'));
    expect(r1).toMatchObject({ kind: 'COMPLETED', body: { processed: 100, moreDue: true } });
    const r2 = await runner({ batchSize: 50, maxBatches: 2 }).run(store.reset('inv-2'));
    expect(r2).toMatchObject({ kind: 'COMPLETED', body: { processed: 20, moreDue: false } });
    expect(new Set(store.processedIds).size).toBe(120);
    expect(store.processedIds.length).toBe(120); // each ticket transitioned exactly once
    // already-recorded old tickets were never reprocessed
    const oldIds = [...store.tickets.values()]
      .filter((a) => a.ticket.subject.startsWith('old'))
      .map((a) => a.ticket.id);
    expect(store.processedIds.some((id) => oldIds.includes(id))).toBe(false);
  });

  it('advances past skipped (locked) and failed candidates; they stay due and are revisited by the next invocation', async () => {
    const { store, runner } = backlog(10);
    const ids = [...store.tickets.values()]
      .filter((a) => !a.ticket.subject.startsWith('old'))
      .map((a) => a.ticket.id);
    store.locked.add(ids[0]!);
    store.failing.add(ids[1]!);
    const r1 = await runner({ batchSize: 4 }).run(store.reset('inv-1'));
    expect(r1).toMatchObject({
      kind: 'COMPLETED',
      body: { processed: 8, failed: 1, moreDue: true },
    });
    store.locked.clear();
    store.failing.clear();
    const r2 = await runner({ batchSize: 4 }).run(store.reset('inv-2'));
    expect(r2).toMatchObject({
      kind: 'COMPLETED',
      body: { processed: 2, failed: 0, moreDue: false },
    });
  });

  it('stops without finalising when the lease is lost (fencing); recovery then terminalises once', async () => {
    const { store, runner } = backlog(10);
    const lease = store.reset('inv-1');
    store.clock = store.inv.leaseUntil; // lease equality => expired
    expect(await runner().run(lease)).toEqual({ kind: 'FENCED' });
    expect(store.inv.state).toBe('RUNNING');
    expect(await runner().recover()).toBe(1);
    expect(await runner().recover()).toBe(0); // repeated recovery is a no-op
    expect(await store.finish(lease, false)).toEqual({ kind: 'FENCED' }); // stale worker cannot finalise
    expect(await store.refreshLease(lease, 30_000)).toBe(false); // nor renew
  });

  it('a stale token is fenced even while the lease is live', async () => {
    const { store, runner } = backlog(3);
    store.reset('inv-1');
    expect(await runner().run({ id: 'inv-1', token: 'forged' })).toEqual({ kind: 'FENCED' });
    expect(store.processedIds).toEqual([]);
  });

  it('controlled operational failure while leased stores a terminal SWEEP_FAILED', async () => {
    const { store, runner } = backlog(3);
    store.failSelect = true;
    expect(await runner().run(store.reset('inv-1'))).toMatchObject({
      kind: 'FAILED',
      status: 503,
      code: 'SWEEP_FAILED',
    });
  });

  it('respects the elapsed-time bound and reports remaining work as moreDue', async () => {
    const { store } = backlog(30);
    let t = 0;
    const runner = new SweepRunner(
      { invocations: store, candidates: store, processor: store, monotonicMs: () => (t += 10) },
      { maxElapsedMs: 100 },
    );
    const r = await runner.run(store.reset('inv-1'));
    expect(r).toMatchObject({ kind: 'COMPLETED', body: { moreDue: true } });
    expect((r as { body: { processed: number } }).body.processed).toBeLessThan(30);
  });

  it('zero due tickets still completes (and is attributable) with moreDue=false', async () => {
    const { store, runner } = backlog(0);
    expect(await runner().run(store.reset('inv-1'))).toMatchObject({
      kind: 'COMPLETED',
      body: { processed: 0, moreDue: false },
    });
  });
});
