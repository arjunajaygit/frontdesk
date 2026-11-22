import { KernelBusinessCalendar } from '../../apps/api/src/domain/calendar/business-calendar';
import { ArvoSlaPolicy } from '../../apps/api/src/domain/sla/sla-policy';
import type { CustomerActor, StaffActor } from '../../apps/api/src/domain/ticket/actor';
import {
  IdGenerator,
  MutationResult,
  TicketLifecycle,
} from '../../apps/api/src/domain/ticket/ticket-lifecycle';
import { loadSpec, makeValidator } from './openapi';

export const MIN = 60_000;
/** Parse an IST wall-clock time, e.g. ist('2026-11-20T18:00'). */
export const ist = (s: string): number => Date.parse(`${s}${s.length === 16 ? ':00' : ''}+05:30`);

export function calendar(holidays: string[] = []) {
  return new KernelBusinessCalendar(holidays);
}

/** Deterministic, valid v4-shaped UUIDs. */
export function sequentialIds(prefix = 1): IdGenerator & { count: () => number } {
  let n = 0;
  return {
    next: () => {
      n++;
      const hex = n.toString(16).padStart(12, '0');
      return `${String(prefix).padStart(8, '0')}-0000-4000-8000-${hex}`;
    },
    count: () => n,
  };
}

export function lifecycle(holidays: string[] = [], prefix = 1) {
  const cal = calendar(holidays);
  return {
    cal,
    lc: new TicketLifecycle({
      calendar: cal,
      policy: new ArvoSlaPolicy(cal),
      ids: sequentialIds(prefix),
    }),
  };
}

export const CUSTOMER: CustomerActor = {
  type: 'CUSTOMER',
  id: 'c0000000-0000-4000-8000-000000000001',
};
export const OTHER_CUSTOMER: CustomerActor = {
  type: 'CUSTOMER',
  id: 'c0000000-0000-4000-8000-000000000002',
};
export const AGENT: StaffActor = { type: 'AGENT', id: 'a0000000-0000-4000-8000-000000000001' };
export const AGENT2: StaffActor = { type: 'AGENT', id: 'a0000000-0000-4000-8000-000000000002' };
export const LEAD: StaffActor = { type: 'LEAD', id: 'a0000000-0000-4000-8000-000000000009' };

const auditValidator = makeValidator(loadSpec())('AuditEvent');
let envelopeSeq = 0;

/** Every emitted event must conform to the strict OpenAPI AuditEvent union once enveloped (M3 adds id/correlation). */
export function expectEventsConform(...results: MutationResult[]): void {
  for (const r of results) {
    for (const e of r.events) {
      const envelope = {
        id: `e0000000-0000-4000-8000-${(++envelopeSeq).toString(16).padStart(12, '0')}`,
        ticketId: e.ticketId,
        actorId: e.actor.type === 'SYSTEM' ? null : e.actor.id,
        actorType: e.actor.type,
        action: e.action,
        createdAt: new Date(e.occurredAt).toISOString(),
        correlationId: 'test-correlation',
        reasonCode: e.reasonCode,
        details: e.details,
      };
      if (!auditValidator(envelope)) {
        throw new Error(`${e.action} does not conform: ${JSON.stringify(auditValidator.errors)}`);
      }
    }
    for (const m of r.messages) expect(JSON.stringify(r.events)).not.toContain(m.body);
  }
}

export const actions = (r: MutationResult) => r.events.map((e) => e.action);
