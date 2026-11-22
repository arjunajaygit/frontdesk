import type { Instant } from '../shared/instant';
import { SWEEP_DEFAULTS, SweepCandidate, SweepCursor, SweepErrorCode } from './sweep-policy';

/** Identity a worker holds for one invocation. The token is never logged or exposed. */
export interface InvocationLease {
  readonly id: string;
  readonly token: string;
}

export type TerminalOutcome =
  | { kind: 'COMPLETED'; status: 200; body: unknown }
  | { kind: 'FAILED'; status: 503; body: unknown; code: SweepErrorCode }
  /** Lease lost (expired / recovered / stale token): this worker must stop; recovery terminalises. */
  | { kind: 'FENCED' };

/** Invocation bookkeeping; each method is its own bounded transaction locking only the invocation row. */
export interface SweepInvocationStore {
  now(): Promise<Instant>;
  refreshLease(lease: InvocationLease, leaseMs: number): Promise<boolean>;
  recordFailure(lease: InvocationLease): Promise<boolean>;
  finish(lease: InvocationLease, moreDue: boolean): Promise<TerminalOutcome>;
  fail(lease: InvocationLease, code: 'SWEEP_FAILED'): Promise<TerminalOutcome>;
  recoverExpired(limit: number): Promise<number>;
}

export interface SweepCandidateSource {
  /** `budgetMs`: remaining invocation time; implementations must bound the scan by it (M04). */
  selectCandidates(snapshot: Instant, after: SweepCursor | null, limit: number, budgetMs: number): Promise<SweepCandidate[]>;
  anyDue(snapshot: Instant, budgetMs: number): Promise<boolean>;
}

export type TicketProcessOutcome =
  | { kind: 'CHANGED' }
  | { kind: 'NOOP' }
  | { kind: 'SKIPPED_LOCKED' }
  | { kind: 'FENCED' };

/**
 * One ticket transaction (M3 adapter): lock invocation row -> ticket FOR UPDATE SKIP LOCKED -> ordered clocks,
 * recheck eligibility with fresh DB time, persist domain changes + audit + counters, re-verify lease before commit.
 */
export interface SweepTicketProcessor {
  processTicket(lease: InvocationLease, ticketId: string): Promise<TicketProcessOutcome>;
}

export interface SweepRunConfig {
  leaseMs: number;
  batchSize: number;
  maxBatches: number;
  maxElapsedMs: number;
}

export interface SweepRunDeps {
  invocations: SweepInvocationStore;
  candidates: SweepCandidateSource;
  processor: SweepTicketProcessor;
  /** Monotonic elapsed-time source (performance.now in production, fake in tests). */
  monotonicMs: () => number;
}

/**
 * Bounded keyset progression over due tickets (SWEEP_CONTRACT). No global transaction and no global lock:
 * every ticket commits independently, so committed progress survives crashes. The cursor advances past every
 * considered candidate (including skipped/failed) so the head of a batch is never re-selected.
 */
export class SweepRunner {
  private readonly config: SweepRunConfig;

  constructor(
    private readonly deps: SweepRunDeps,
    config: Partial<SweepRunConfig> = {},
  ) {
    this.config = { ...SWEEP_DEFAULTS, ...config };
  }

  async run(lease: InvocationLease): Promise<TerminalOutcome> {
    const { invocations, candidates, processor } = this.deps;
    const started = this.deps.monotonicMs();
    const remaining = () => this.config.maxElapsedMs - (this.deps.monotonicMs() - started);
    const timeLeft = () => remaining() > 0;
    let cursor: SweepCursor | null = null;
    try {
      for (let batch = 0; batch < this.config.maxBatches && timeLeft(); batch++) {
        if (!(await invocations.refreshLease(lease, this.config.leaseMs))) return { kind: 'FENCED' };
        const snapshot = await invocations.now();
        const page = await candidates.selectCandidates(snapshot, cursor, this.config.batchSize, remaining());
        for (const candidate of page) {
          if (!timeLeft()) break;
          cursor = candidate;
          let outcome: TicketProcessOutcome;
          try {
            outcome = await processor.processTicket(lease, candidate.ticketId);
          } catch {
            // Ticket transaction rolled back; count the failure separately under the invocation lock.
            outcome = (await invocations.recordFailure(lease)) ? { kind: 'NOOP' } : { kind: 'FENCED' };
          }
          if (outcome.kind === 'FENCED') return { kind: 'FENCED' };
        }
        if (page.length < this.config.batchSize) break;
      }
      // Final check without cursor; skipped/failed-but-still-due work keeps moreDue=true.
      // The final backlog check gets a small floor so a time-capped run can still report moreDue.
      const moreDue = await candidates.anyDue(await invocations.now(), Math.max(remaining(), 1_000));
      return await invocations.finish(lease, moreDue);
    } catch {
      // Controlled operational failure while (possibly) still leased: store a safe terminal 503.
      return invocations.fail(lease, 'SWEEP_FAILED');
    }
  }

  /** Independent of browser traffic: called before work and by the scheduler on every tick. */
  recover(limit = SWEEP_DEFAULTS.recoveryLimit): Promise<number> {
    return this.deps.invocations.recoverExpired(limit);
  }
}
