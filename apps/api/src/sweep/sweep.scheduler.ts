import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env';
import { CalendarProvider } from '../calendar/calendar.provider';
import { SessionMaintenance } from '../auth/session-maintenance';
import { IdempotencyService } from '../tickets/idempotency.service';
import { SweepService } from './sweep.service';
import { errorMeta } from '../common/error-meta';

/**
 * In-process scheduler (DB-backed source of truth). The `running` flag prevents overlapping ticks in this
 * process; leases + row locks protect against other instances. Errors are logged, never thrown into Node.
 */
@Injectable()
export class SweepScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly sweeps: SweepService,
    private readonly calendars: CalendarProvider,
    private readonly idempotency: IdempotencyService,
    private readonly sessions: SessionMaintenance,
    private readonly registry: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(SweepScheduler.name) private readonly log: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.SWEEP_SCHEDULER_ENABLED) return;
    const handle = setInterval(() => void this.tick(), this.config.SWEEP_INTERVAL_MS);
    this.registry.addInterval('sla-sweep', handle);
  }

  /**
   * One tick. Each step is isolated (M05): retention maintenance runs even when the sweep fails, and a failure
   * is logged only as classified metadata (never raw messages). Stale invocations are recovered inside the sweep.
   */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve(); // shutting down: never start new work
    if (this.running) return this.running; // no overlapping ticks in-process
    this.running = (async () => {
      try {
        await this.step('calendar', () => this.calendars.refresh());
        await this.step('sweep', async () => this.log.info({ status: (await this.sweeps.runScheduled()).status }, 'scheduled sla sweep tick'));
        await this.step('idempotency-retention', async () => this.log.info({ purged: await this.idempotency.purgeExpired() }, 'idempotency retention'));
        await this.step('session-retention', async () => this.log.info({ purged: await this.sessions.purgeExpired() }, 'session retention'));
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async step(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log.error({ step: name, ...errorMeta(e) }, 'scheduled maintenance step failed');
    }
  }

  /**
   * Final audit M03: stop new ticks and drain the in-flight tick BEFORE the HTTP server and the database close
   * (Prisma disconnects in onApplicationShutdown, the last phase). The drain is bounded by SWEEP_SHUTDOWN_DRAIN_MS;
   * if it is exceeded the invocation keeps its lease and is terminalised by recovery on the next start (fenced:
   * a late commit from this process is rejected by the lease check).
   */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (this.registry.doesExist('interval', 'sla-sweep')) this.registry.deleteInterval('sla-sweep');
    this.stopped = true;
    const inFlight = this.running;
    let drained = true;
    if (inFlight) {
      let timer: NodeJS.Timeout | undefined;
      drained = await Promise.race([
        inFlight.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.config.SWEEP_SHUTDOWN_DRAIN_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    // Nest re-raises the signal after all hooks complete, so the process exit status is 128+signal (143 for SIGTERM).
    this.log.info(
      { signal: signal ?? 'none', inFlightTick: !!inFlight, drained, drainBudgetMs: this.config.SWEEP_SHUTDOWN_DRAIN_MS },
      drained ? 'shutdown: scheduler stopped and drained; HTTP server and database connections close next' : 'shutdown: drain budget exceeded; invocation left leased for recovery',
    );
  }
}
