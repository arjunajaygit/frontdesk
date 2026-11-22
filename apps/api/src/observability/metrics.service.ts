import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';

/** Closed label vocabularies: anything else is folded into a fixed bucket, so cardinality stays bounded. */
export const COMMANDS = [
  'POST /tickets',
  'POST /tickets/{id}/claim',
  'POST /tickets/{id}/replies',
  'POST /tickets/{id}/notes',
  'POST /tickets/{id}/wait',
  'POST /tickets/{id}/resolve',
  'PATCH /tickets/{id}/priority',
  'POST /customer/tickets',
  'POST /customer/tickets/{id}/replies',
  'POST /customer/tickets/{id}/reopen',
] as const;
export type CommandOutcome = 'success' | 'replayed' | 'conflict' | 'rejected' | 'busy' | 'error';
export type SweepOutcome = 'completed' | 'failed' | 'fenced' | 'conflict' | 'replayed' | 'error';
const CLOCKS = new Set(['RESPONSE', 'RESOLUTION']);
const PRIORITIES = new Set(['URGENT', 'MEDIUM', 'LOW']);
const ROUTE_SAFE = /^\/api(\/[A-Za-z0-9_\-{}:]+)*$/;
/** Defence in depth: a raw URL with an id (uuid-ish hex run or digits) must never become a label. */
const ID_LIKE = /[0-9a-f]{8}-|[0-9a-f]{12,}|\d{3,}/i;

/**
 * Prometheus metrics. ALL counters here are PROCESS-LOCAL (reset on restart, per instance): they describe what
 * this process observed, not business totals. Persistent business totals live in PostgreSQL (audit log,
 * sweep invocation rows). Labels never carry ids, emails, bodies, tokens or free text.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly httpTotal = new Counter({ name: 'frontdesk_http_requests_total', help: 'API requests handled by this process (process-local).', labelNames: ['method', 'route', 'status_class'], registers: [this.registry] });
  private readonly httpDuration = new Histogram({ name: 'frontdesk_http_request_duration_seconds', help: 'API request latency (process-local).', labelNames: ['method', 'route', 'status_class'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [this.registry] });
  private readonly commands = new Counter({ name: 'frontdesk_ticket_commands_total', help: 'Ticket command outcomes after the transaction finished (process-local; replays counted separately).', labelNames: ['command', 'outcome'], registers: [this.registry] });
  private readonly claims = new Counter({ name: 'frontdesk_ticket_claims_total', help: 'Claim attempts: won (committed) vs conflict (lost the race / already assigned) (process-local).', labelNames: ['outcome'], registers: [this.registry] });
  private readonly breaches = new Counter({ name: 'frontdesk_sla_breaches_recorded_total', help: 'SLA_BREACHED audit events committed by this process (process-local; the audit log is the durable record).', labelNames: ['clock', 'priority'], registers: [this.registry] });
  private readonly sweeps = new Counter({ name: 'frontdesk_sweep_invocations_total', help: 'SLA sweep invocations started by this process, by initiator, trigger and outcome (process-local).', labelNames: ['initiator', 'trigger', 'outcome'], registers: [this.registry] });
  private readonly sweepDuration = new Histogram({ name: 'frontdesk_sweep_duration_seconds', help: 'SLA sweep invocation duration (process-local).', labelNames: ['initiator'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60], registers: [this.registry] });
  private readonly sweepTickets = new Counter({ name: 'frontdesk_sweep_tickets_processed_total', help: 'Tickets changed by committed sweep work (process-local; durable counts are on the invocation rows).', registers: [this.registry] });
  private readonly recoveries = new Counter({ name: 'frontdesk_sweep_lease_recoveries_total', help: 'Expired sweep invocations terminalised by recovery in this process (process-local).', registers: [this.registry] });
  private readonly moreDue = new Gauge({ name: 'frontdesk_sweep_more_due', help: '1 if the last completed sweep reported more due work (backlog), else 0; NaN before the first run.', registers: [this.registry] });
  /** Final audit L01: scheduled (SYSTEM) and manual success are separate, so a manual run cannot hide a dead scheduler. */
  private readonly lastScheduled = new Gauge({ name: 'frontdesk_sweep_last_scheduled_success_timestamp_seconds', help: 'Unix time of the last COMPLETED scheduled (SYSTEM actor: in-process timer or authenticated external trigger) sweep in this process (0 = none yet).', registers: [this.registry] });
  private readonly lastManual = new Gauge({ name: 'frontdesk_sweep_last_manual_success_timestamp_seconds', help: 'Unix time of the last COMPLETED manual (lead/admin) sweep in this process (0 = none yet).', registers: [this.registry] });
  private readonly dbUp = new Gauge({
    name: 'frontdesk_db_up',
    help: '1 if the restricted runtime connection answered a readiness query during this scrape, else 0.',
    registers: [this.registry],
    collect: async () => {
      this.dbUp.set(await this.probeDb());
    },
  });

  constructor(private readonly prisma: PrismaService) {
    collectDefaultMetrics({ register: this.registry, prefix: 'frontdesk_' });
    this.moreDue.set(Number.NaN);
    this.lastScheduled.set(0);
    this.lastManual.set(0);
  }

  private async probeDb(): Promise<number> {
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref()),
      ]);
      return 1;
    } catch {
      return 0;
    }
  }

  /** `route` must be the matched route TEMPLATE (never the raw URL); unknown shapes fold to `unmatched`. */
  observeHttp(method: string, route: string | undefined, status: number, seconds: number): void {
    const m = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'OTHER';
    const r = route && ROUTE_SAFE.test(route) && !ID_LIKE.test(route) && route.length <= 80 ? route : 'unmatched';
    const labels = { method: m, route: r, status_class: `${Math.floor(status / 100)}xx` };
    this.httpTotal.inc(labels);
    this.httpDuration.observe(labels, seconds);
  }

  command(operation: string, outcome: CommandOutcome): void {
    const command = (COMMANDS as readonly string[]).includes(operation) ? operation : 'other';
    this.commands.inc({ command, outcome });
    if (command === 'POST /tickets/{id}/claim' && (outcome === 'success' || outcome === 'conflict')) {
      this.claims.inc({ outcome: outcome === 'success' ? 'won' : 'conflict' });
    }
  }

  breachRecorded(clock: string, priority: string): void {
    this.breaches.inc({ clock: CLOCKS.has(clock) ? clock : 'other', priority: PRIORITIES.has(priority) ? priority : 'other' });
  }

  sweepTicketChanged(): void {
    this.sweepTickets.inc();
  }

  leaseRecoveries(n: number): void {
    if (n > 0) this.recoveries.inc(n);
  }

  /** `trigger` applies to SYSTEM sweeps: the in-process `timer` or the machine-authenticated `external` endpoint. */
  sweepFinished(initiator: string, outcome: SweepOutcome, seconds: number, moreDue?: boolean, trigger: 'timer' | 'external' | 'manual' = 'manual'): void {
    const i = initiator === 'SYSTEM' ? 'system' : initiator === 'LEAD' ? 'lead' : initiator === 'ADMIN' ? 'admin' : 'other';
    const t = i === 'system' ? (trigger === 'external' ? 'external' : 'timer') : 'manual';
    this.sweeps.inc({ initiator: i, trigger: t, outcome });
    this.sweepDuration.observe({ initiator: i }, seconds);
    if (outcome === 'completed') {
      (i === 'system' ? this.lastScheduled : this.lastManual).set(Date.now() / 1000);
      if (moreDue !== undefined) this.moreDue.set(moreDue ? 1 : 0);
    }
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
