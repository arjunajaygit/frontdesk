import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { ERROR_MESSAGES, sweepKey } from '../domain/sweep/sweep-policy';
import { InvocationLease, SweepRunner, TerminalOutcome } from '../domain/sweep/sweep-runner';
import { PgSweepStore, SweepInitiator } from '../infrastructure/sweep/pg-sweep-store';
import { requestHash } from '../tickets/idempotency.service';
import { PgSweepTicketProcessor } from './sweep-ticket.processor';
import { MetricsService, type SweepOutcome } from '../observability/metrics.service';

export interface SweepHttpOutcome {
  status: number;
  body: unknown;
}

/** One sweep service for both the scheduler (SYSTEM) and the lead/admin endpoint. */
@Injectable()
export class SweepService {
  private readonly runner: SweepRunner;

  constructor(
    private readonly store: PgSweepStore,
    processor: PgSweepTicketProcessor,
    @Inject(APP_CONFIG) config: AppConfig,
    @InjectPinoLogger(SweepService.name) private readonly log: PinoLogger,
    private readonly metrics: MetricsService,
  ) {
    this.runner = new SweepRunner(
      { invocations: store, candidates: store, processor, monotonicMs: () => performance.now() },
      { leaseMs: config.SWEEP_LEASE_MS, batchSize: config.SWEEP_BATCH_SIZE, maxBatches: config.SWEEP_MAX_BATCHES },
    );
    this.leaseMs = config.SWEEP_LEASE_MS;
  }
  private readonly leaseMs: number;

  /** Authorised manual run; replay/conflict semantics follow SWEEP_CONTRACT. */
  async runManual(initiator: Exclude<SweepInitiator, { type: 'SYSTEM' }>, idempotencyKey: string, requestId: string): Promise<SweepHttpOutcome> {
    return this.execute(initiator, idempotencyKey, requestId);
  }

  /** Scheduled run: fresh key per invocation, SYSTEM actor, independent of browser traffic. */
  async runScheduled(): Promise<SweepHttpOutcome> {
    return this.execute({ type: 'SYSTEM' }, `tick-${randomUUID()}`, randomUUID(), 'timer');
  }

  /**
   * Externally scheduled run (machine-authenticated): SYSTEM actor, and a DETERMINISTIC invocation identity from the
   * caller's slot key, so a retried or duplicated cron delivery replays the stored outcome instead of running again.
   */
  async runExternal(slotKey: string, correlationId: string): Promise<SweepHttpOutcome> {
    return this.execute({ type: 'SYSTEM' }, `ext-${slotKey}`, correlationId, 'external');
  }

  async recover(): Promise<number> {
    const n = await this.runner.recover();
    this.metrics.leaseRecoveries(n);
    return n;
  }

  private async execute(initiator: SweepInitiator, callerKey: string, correlationId: string, trigger: 'timer' | 'external' | 'manual' = 'manual'): Promise<SweepHttpOutcome> {
    const started = performance.now();
    const done = (outcome: SweepOutcome, moreDue?: boolean) => this.metrics.sweepFinished(initiator.type, outcome, (performance.now() - started) / 1000, moreDue, trigger);
    try {
      const r = await this.executeInner(initiator, callerKey, correlationId);
      done(r.metric, r.moreDue);
      return r.http;
    } catch (e) {
      done('error');
      throw e;
    }
  }

  private async executeInner(
    initiator: SweepInitiator,
    callerKey: string,
    correlationId: string,
  ): Promise<{ http: SweepHttpOutcome; metric: SweepOutcome; moreDue?: boolean }> {
    await this.recover(); // terminalise stale invocations before starting work
    const key = sweepKey(initiator, callerKey);
    const reservation = await this.store.reserve({
      initiator,
      key,
      requestHash: requestHash('POST /admin/run-sla-sweep', null, {}),
      correlationId,
      leaseMs: this.leaseMs,
    });
    if (reservation.kind === 'REPLAY') return { http: { status: reservation.status, body: reservation.body }, metric: 'replayed' };
    if (reservation.kind === 'CONFLICT') {
      const message = reservation.code === 'SWEEP_IN_PROGRESS' ? 'This sweep is already running.' : 'This Idempotency-Key was already used with a different request.';
      return { http: { status: 409, body: { code: reservation.code, message, requestId: correlationId } }, metric: 'conflict' };
    }
    const outcome = await this.runLeased(reservation.lease);
    this.log.info({ invocationId: reservation.lease.id, outcome: outcome.kind, actorType: initiator.type, correlationId }, 'sla sweep finished');
    if (outcome.kind === 'FENCED') {
      return { http: { status: 503, body: { code: 'SWEEP_LEASE_EXPIRED', message: ERROR_MESSAGES.SWEEP_LEASE_EXPIRED, requestId: correlationId } }, metric: 'fenced' };
    }
    const moreDue = outcome.kind === 'COMPLETED' ? (outcome.body as { moreDue?: unknown } | null)?.moreDue : undefined;
    return {
      http: { status: outcome.status, body: outcome.body },
      metric: outcome.kind === 'COMPLETED' ? 'completed' : 'failed',
      moreDue: typeof moreDue === 'boolean' ? moreDue : undefined,
    };
  }

  private async runLeased(lease: InvocationLease): Promise<TerminalOutcome> {
    return this.runner.run(lease);
  }
}
