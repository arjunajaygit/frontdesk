import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InvocationLease, SweepTicketProcessor, TicketProcessOutcome } from '../domain/sweep/sweep-runner';
import { aggregateFromRows } from '../infrastructure/persistence/ticket-mapper';
import { PgSweepStore, dbNow } from '../infrastructure/sweep/pg-sweep-store';
import { CalendarProvider } from '../calendar/calendar.provider';
import { PrismaService } from '../prisma/prisma.service';
import { TicketRepository } from '../tickets/ticket.repository';
import { CommitHooks } from '../observability/commit-hooks';
import { MetricsService } from '../observability/metrics.service';

class Fenced extends Error {}

/**
 * One bounded transaction per ticket (SWEEP_CONTRACT): lock OWN invocation row + verify lease -> ticket
 * FOR UPDATE SKIP LOCKED -> fresh DB time -> ordered clocks -> recheck eligibility via the domain ->
 * persist ticket/clocks/audit + durable counters -> re-verify lease with advancing DB time before commit.
 */
@Injectable()
export class PgSweepTicketProcessor implements SweepTicketProcessor {
  constructor(
    private readonly db: PrismaService,
    private readonly store: PgSweepStore,
    private readonly repo: TicketRepository,
    private readonly calendars: CalendarProvider,
    private readonly hooks: CommitHooks,
    private readonly metrics: MetricsService,
  ) {}

  async processTicket(lease: InvocationLease, ticketId: string): Promise<TicketProcessOutcome> {
    let txRef: object | undefined;
    try {
      const out = await this.db.$transaction(
        async (tx) => {
          txRef = tx;
          await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          if (!(await this.store.verifyLease(tx, lease))) throw new Fenced();
          const row = await this.repo.lockTicketSkipLocked(tx, ticketId);
          if (!row) return { kind: 'SKIPPED_LOCKED' } as const;
          const now = await dbNow(tx);
          const clocks = await this.repo.lockClocks(tx, ticketId);
          const before = aggregateFromRows(row, clocks);
          const r = this.calendars.lifecycle().reconcileDue(before, now);
          if (!r.changed) return { kind: 'NOOP' } as const; // no version bump, no writes
          const correlationId = await this.store.correlationOf(tx, lease.id);
          await this.repo.persist(tx, before, r, correlationId);
          // Final fence (H01): counters are written by a lease-guarded statement; failure rolls back the ticket work.
          if (!(await this.store.commitTicketProgress(tx, lease, r.counters))) throw new Fenced();
          this.hooks.onCommit(tx, () => this.metrics.sweepTicketChanged());
          return { kind: 'CHANGED' } as const;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 10_000 },
      );
      this.hooks.committed(txRef);
      return out;
    } catch (e) {
      this.hooks.discarded(txRef);
      if (e instanceof Fenced) return { kind: 'FENCED' };
      throw e; // runner records the failure under the invocation lock and continues
    }
  }
}
