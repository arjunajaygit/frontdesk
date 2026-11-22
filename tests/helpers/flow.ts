import type { Priority } from '@frontdesk/contracts';
import type { SlaClock } from '../../apps/api/src/domain/sla/sla-clock';
import type { TicketAggregate } from '../../apps/api/src/domain/ticket/ticket.types';
import type {
  MutationResult,
  TicketLifecycle,
} from '../../apps/api/src/domain/ticket/ticket-lifecycle';
import { AGENT, CUSTOMER, expectEventsConform } from './domain';

/** Small fluent driver: applies commands, checks event conformance and version discipline every step. */
export class Flow {
  results: MutationResult[] = [];
  constructor(
    readonly lc: TicketLifecycle,
    public agg: TicketAggregate,
  ) {}

  static staff(lc: TicketLifecycle, priority: Priority, at: number): Flow {
    const r = lc.staffIntake({
      actor: AGENT,
      customerId: CUSTOMER.id,
      subject: 'Synthetic',
      body: 'Problem statement',
      priority,
      now: at,
    });
    const f = new Flow(lc, r.aggregate);
    f.record(r);
    return f;
  }

  record(r: MutationResult): MutationResult {
    expectEventsConform(r);
    if (r.changed) {
      for (const e of r.events) {
        if (
          'beforeVersion' in e.details &&
          e.action !== 'MESSAGE_PUBLISHED' &&
          e.action !== 'TICKET_CREATED'
        ) {
          expect(e.details.afterVersion).toBe(e.details.beforeVersion + 1);
        }
      }
    }
    this.results.push(r);
    this.agg = r.aggregate;
    return r;
  }

  apply(fn: (agg: TicketAggregate) => MutationResult): MutationResult {
    return this.record(fn(this.agg));
  }

  clock(kind: 'RESPONSE' | 'RESOLUTION', cycle?: number): SlaClock {
    const c = this.agg.clocks.find(
      (x) =>
        x.kind === kind &&
        x.cycle === (cycle ?? (kind === 'RESPONSE' ? 0 : this.agg.ticket.resolutionCycle)),
    );
    if (!c) throw new Error(`no ${kind} clock`);
    return c;
  }
}
