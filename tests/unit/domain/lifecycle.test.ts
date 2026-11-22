import { REOPEN_WINDOW_MS } from '@frontdesk/contracts';
import { DomainError } from '../../../apps/api/src/domain/shared/domain-error';
import { SYSTEM } from '../../../apps/api/src/domain/ticket/actor';
import type {
  CustomerContactResult,
  MutationResult,
  TicketLifecycle,
} from '../../../apps/api/src/domain/ticket/ticket-lifecycle';
import type { TicketAggregate } from '../../../apps/api/src/domain/ticket/ticket.types';
import {
  AGENT,
  AGENT2,
  CUSTOMER,
  LEAD,
  OTHER_CUSTOMER,
  actions,
  expectEventsConform,
  ist,
  lifecycle,
} from '../../helpers/domain';
import { Flow } from '../../helpers/flow';

const t = (hm: string, day = '2026-11-23') => ist(`${day}T${hm}`);
const same = (r: CustomerContactResult): MutationResult => {
  if (r.outcome !== 'SAME_TICKET') throw new Error(`expected SAME_TICKET, got ${r.outcome}`);
  expectEventsConform(r.result);
  return r.result;
};
const linked = (r: CustomerContactResult) => {
  if (r.outcome !== 'NEW_LINKED_TICKET')
    throw new Error(`expected NEW_LINKED_TICKET, got ${r.outcome}`);
  expectEventsConform(r.previous, r.child);
  return r;
};
const rejects = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}`);
};

function inProgress(lc: TicketLifecycle) {
  const f = Flow.staff(lc, 'MEDIUM', t('09:30'));
  f.apply((a) => lc.claim(a, AGENT, t('09:35')));
  return f;
}
function waiting(lc: TicketLifecycle) {
  const f = inProgress(lc);
  f.apply((a) => lc.requestInformation(a, AGENT, 'Please confirm the account id', t('10:00')));
  return f;
}
function resolved(lc: TicketLifecycle) {
  const f = inProgress(lc);
  f.apply((a) => lc.resolve(a, AGENT, 'Fixed the configuration', t('11:00')));
  return f;
}

describe('intake', () => {
  it('customer intake: OPEN, unassigned, cycle 0, authoritative MEDIUM, requestedPriority kept for triage', () => {
    const { lc } = lifecycle();
    const r = lc.customerIntake({
      actor: CUSTOMER,
      subject: 'Login fails',
      body: 'Cannot log in',
      requestedPriority: 'URGENT',
      now: t('10:00'),
    });
    expectEventsConform(r);
    expect(r.aggregate.ticket).toMatchObject({
      status: 'OPEN',
      assigneeId: null,
      priority: 'MEDIUM',
      requestedPriority: 'URGENT',
      version: 0,
      resolutionCycle: 0,
      customerId: CUSTOMER.id,
    });
    expect(actions(r)).toEqual(['TICKET_CREATED', 'MESSAGE_PUBLISHED']);
    expect(r.messages).toEqual([
      expect.objectContaining({ kind: 'INTAKE', visibility: 'PUBLIC', authorId: CUSTOMER.id }),
    ]);
    expect(r.aggregate.clocks.map((c) => `${c.kind}:${c.state}:${c.cycle}`)).toEqual([
      'RESPONSE:RUNNING:0',
      'RESOLUTION:RUNNING:0',
    ]);
  });

  it('staff intake requires staff, attributes INTAKE to staff; SYSTEM/customer cannot use it', () => {
    const { lc } = lifecycle();
    const r = lc.staffIntake({
      actor: LEAD,
      customerId: CUSTOMER.id,
      subject: 'Phone call',
      body: 'Customer reported outage',
      priority: 'URGENT',
      now: t('10:00'),
    });
    expect(r.aggregate.ticket).toMatchObject({
      priority: 'URGENT',
      customerId: CUSTOMER.id,
      status: 'OPEN',
    });
    expect(r.messages[0]).toMatchObject({ authorId: LEAD.id, kind: 'INTAKE' });
    rejects(
      () =>
        lc.staffIntake({
          actor: CUSTOMER,
          customerId: CUSTOMER.id,
          subject: 's',
          body: 'b',
          priority: 'LOW',
          now: t('10:00'),
        }),
      'FORBIDDEN_ACTOR',
    );
    rejects(
      () => lc.customerIntake({ actor: SYSTEM, subject: 's', body: 'b', now: t('10:00') }),
      'FORBIDDEN_ACTOR',
    );
    rejects(
      () => lc.customerIntake({ actor: AGENT, subject: 's', body: 'b', now: t('10:00') }),
      'FORBIDDEN_ACTOR',
    );
  });

  it('validates subject and body', () => {
    const { lc } = lifecycle();
    rejects(
      () => lc.customerIntake({ actor: CUSTOMER, subject: '   ', body: 'b', now: t('10:00') }),
      'MESSAGE_REQUIRED',
    );
    rejects(
      () => lc.customerIntake({ actor: CUSTOMER, subject: 's', body: '', now: t('10:00') }),
      'MESSAGE_REQUIRED',
    );
    rejects(
      () =>
        lc.customerIntake({
          actor: CUSTOMER,
          subject: 'x'.repeat(201),
          body: 'b',
          now: t('10:00'),
        }),
      'INVALID_INPUT',
    );
    rejects(
      () =>
        lc.customerIntake({
          actor: CUSTOMER,
          subject: 's',
          body: 'x'.repeat(10_001),
          now: t('10:00'),
        }),
      'INVALID_INPUT',
    );
  });
});

describe('allowed transitions and version discipline', () => {
  it('claim: OPEN -> IN_PROGRESS, version +1, one TICKET_CLAIMED; second claim conflicts', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'MEDIUM', t('09:30'));
    const r = f.apply((a) => lc.claim(a, AGENT, t('09:35')));
    expect(actions(r)).toEqual(['TICKET_CLAIMED']);
    expect(r.aggregate.ticket).toMatchObject({
      status: 'IN_PROGRESS',
      assigneeId: AGENT.id,
      version: 1,
      updatedAt: t('09:35'),
    });
    rejects(() => lc.claim(f.agg, AGENT2, t('09:36')), 'ALREADY_CLAIMED');
    rejects(() => lc.claim(f.agg, CUSTOMER, t('09:36')), 'FORBIDDEN_ACTOR');
  });

  it('each command increments version exactly once and all its events share before/after versions', () => {
    const { lc } = lifecycle();
    const f = inProgress(lc);
    const r = f.apply((a) => lc.requestInformation(a, AGENT, 'Need logs', t('10:00')));
    expect(r.aggregate.ticket.version).toBe(2);
    for (const e of r.events)
      expect(e.details).toMatchObject({ beforeVersion: 1, afterVersion: 2 });
  });

  it('notes allowed in IN_PROGRESS and WAITING with no SLA or state effect', () => {
    const { lc } = lifecycle();
    const f = waiting(lc);
    const before = f.agg.clocks;
    const r = f.apply((a) => lc.addNote(a, AGENT, 'still waiting', t('11:00')));
    expect(actions(r)).toEqual(['INTERNAL_NOTE_ADDED']);
    expect(r.messages[0]).toMatchObject({ kind: 'NOTE', visibility: 'PRIVATE' });
    expect(f.agg.clocks).toEqual(before);
    expect(f.agg.ticket.status).toBe('WAITING');
  });

  it('customer reply on OPEN/IN_PROGRESS appends REPLY without completing the response clock', () => {
    const { lc } = lifecycle();
    const f = inProgress(lc);
    const r = f.apply((a) => same(lc.customerReply(a, CUSTOMER, 'Any update?', t('10:00'))));
    expect(actions(r)).toEqual(['MESSAGE_PUBLISHED']);
    expect(f.clock('RESPONSE').state).toBe('RUNNING');
    expect(f.agg.ticket.status).toBe('IN_PROGRESS');
  });

  it('resolve: completes clocks, sets resolvedAt and reopenUntil = +7 calendar days', () => {
    const { lc } = lifecycle();
    const f = inProgress(lc);
    f.apply((a) => lc.publicReply(a, AGENT, 'Investigating', t('10:00')));
    const r = f.apply((a) => lc.resolve(a, AGENT, undefined, t('11:00')));
    expect(actions(r)).toEqual(['SLA_COMPLETED', 'TICKET_RESOLVED']);
    expect(f.agg.ticket).toMatchObject({
      status: 'RESOLVED',
      resolvedAt: t('11:00'),
      reopenUntil: t('11:00') + REOPEN_WINDOW_MS,
    });
    expect(f.clock('RESOLUTION')).toMatchObject({ state: 'COMPLETED', completedAt: t('11:00') });
  });

  it('resolve before the first public reply requires a public message in the same command', () => {
    const { lc } = lifecycle();
    const f = inProgress(lc);
    rejects(() => lc.resolve(f.agg, AGENT, undefined, t('10:00')), 'MESSAGE_REQUIRED');
    const r = f.apply((a) => lc.resolve(a, AGENT, 'Resolved: cache cleared', t('10:00')));
    expect(actions(r)).toEqual([
      'MESSAGE_PUBLISHED',
      'SLA_COMPLETED',
      'SLA_COMPLETED',
      'TICKET_RESOLVED',
    ]);
    expect(f.clock('RESPONSE').state).toBe('COMPLETED');
  });
});

describe('forbidden transitions (actor/state matrix)', () => {
  it('only the assignee mutates; customers and other staff are rejected; no staff impersonation', () => {
    const { lc } = lifecycle();
    const f = inProgress(lc);
    rejects(() => lc.publicReply(f.agg, AGENT2, 'x', t('10:00')), 'NOT_ASSIGNEE');
    rejects(() => lc.addNote(f.agg, LEAD, 'x', t('10:00')), 'NOT_ASSIGNEE');
    rejects(() => lc.requestInformation(f.agg, AGENT2, 'x', t('10:00')), 'NOT_ASSIGNEE');
    rejects(() => lc.resolve(f.agg, AGENT2, 'x', t('10:00')), 'NOT_ASSIGNEE');
    rejects(() => lc.publicReply(f.agg, CUSTOMER, 'x', t('10:00')), 'FORBIDDEN_ACTOR');
    rejects(
      () => lc.customerReply(f.agg, AGENT, 'pretending to be the customer', t('10:00')),
      'FORBIDDEN_ACTOR',
    );
    rejects(() => lc.customerReopen(f.agg, LEAD, 'x', t('10:00')), 'FORBIDDEN_ACTOR');
    rejects(() => lc.staffReopen(f.agg, AGENT), 'FORBIDDEN_ACTOR');
    rejects(() => lc.customerReply(f.agg, OTHER_CUSTOMER, 'x', t('10:00')), 'NOT_OWNER');
  });

  it('state guards: reply/request/resolve need IN_PROGRESS; no staff replies once RESOLVED; reopen on active tickets -> use reply', () => {
    const { lc } = lifecycle();
    const w = waiting(lc);
    rejects(() => lc.publicReply(w.agg, AGENT, 'x', t('10:30')), 'INVALID_STATE');
    rejects(() => lc.requestInformation(w.agg, AGENT, 'x', t('10:30')), 'INVALID_STATE');
    rejects(() => lc.resolve(w.agg, AGENT, 'x', t('10:30')), 'INVALID_STATE');
    rejects(() => lc.customerReopen(w.agg, CUSTOMER, 'x', t('10:30')), 'USE_REPLY');
    const ip = inProgress(lifecycle().lc);
    rejects(() => ip.lc.customerReopen(ip.agg, CUSTOMER, 'x', t('10:30')), 'USE_REPLY');
    const r = resolved(lifecycle().lc);
    rejects(() => r.lc.publicReply(r.agg, AGENT, 'x', t('12:00')), 'INVALID_STATE');
    rejects(() => r.lc.addNote(r.agg, AGENT, 'x', t('12:00')), 'INVALID_STATE');
    rejects(() => r.lc.claim(r.agg, AGENT2, t('12:00')), 'ALREADY_CLAIMED');
    const open = Flow.staff(lifecycle().lc, 'LOW', t('09:30'));
    rejects(() => open.lc.customerReopen(open.agg, CUSTOMER, 'x', t('10:00')), 'USE_REPLY');
    rejects(() => open.lc.publicReply(open.agg, AGENT, 'x', t('10:00')), 'NOT_ASSIGNEE');
  });

  it('request requires a non-empty public message', () => {
    const { lc } = lifecycle();
    const f = inProgress(lc);
    rejects(() => lc.requestInformation(f.agg, AGENT, '  ', t('10:00')), 'MESSAGE_REQUIRED');
  });
});

describe('auto-close (2700 working minutes, strictly after the cutoff)', () => {
  it('waiting cutoff is exactly 2700 working minutes (five working days) after the request', () => {
    const { lc } = lifecycle();
    const f = waiting(lc);
    expect(f.agg.ticket.waitingCloseDueAt).toBe(t('10:00', '2026-11-30'));
  });

  it('customer reply exactly at the cutoff resumes the same ticket', () => {
    const { lc } = lifecycle();
    const f = waiting(lc);
    const cutoff = f.agg.ticket.waitingCloseDueAt!;
    const r = f.apply((a) => same(lc.customerReply(a, CUSTOMER, 'Account id 1234', cutoff)));
    expect(actions(r)).toEqual(['MESSAGE_PUBLISHED', 'SLA_RESUMED', 'TICKET_RESUMED']);
    expect(f.agg.ticket).toMatchObject({
      status: 'IN_PROGRESS',
      waitingSince: null,
      waitingCloseDueAt: null,
    });
  });

  it('customer reply 1 ms after the cutoff closes the old ticket and creates a linked OPEN child', () => {
    const { lc } = lifecycle();
    const f = waiting(lc);
    const at = f.agg.ticket.waitingCloseDueAt! + 1;
    const r = linked(lc.customerReply(f.agg, CUSTOMER, 'Account id 1234', at));
    expect(actions(r.previous)).toEqual([
      'SLA_CANCELLED',
      'TICKET_CLOSED',
      'LINKED_TICKET_CREATED',
    ]);
    expect(r.previous.aggregate.ticket).toMatchObject({
      status: 'CLOSED',
      closeReason: 'AUTO_CLOSED_NO_REPLY',
      closedAt: at,
      version: f.agg.ticket.version + 1,
    });
    const child = r.child.aggregate.ticket;
    expect(child).toMatchObject({
      status: 'OPEN',
      assigneeId: null,
      parentTicketId: f.agg.ticket.id,
      subject: f.agg.ticket.subject,
      priority: 'MEDIUM',
      requestedPriority: null,
      version: 0,
      resolutionCycle: 0,
    });
    expect(r.child.messages).toEqual([
      expect.objectContaining({ kind: 'INTAKE', authorId: CUSTOMER.id, body: 'Account id 1234' }),
    ]);
    expect(r.previous.events.at(-1)!.details).toMatchObject({
      childTicketId: child.id,
      reason: 'AUTO_CLOSED_NO_REPLY',
      beforeVersion: 2,
      afterVersion: 3,
    });
    expect(r.previous.events.find((e) => e.action === 'TICKET_CLOSED')!.actor).toEqual(SYSTEM);
  });

  it('sweep at cutoff is a no-op; at cutoff + 1 ms it closes', () => {
    const { lc } = lifecycle();
    const f = waiting(lc);
    const cutoff = f.agg.ticket.waitingCloseDueAt!;
    const noop = lc.reconcileDue(f.agg, cutoff);
    expect(noop.changed).toBe(false);
    expect(noop.aggregate.ticket.version).toBe(f.agg.ticket.version);
    const close = f.apply((a) => lc.reconcileDue(a, cutoff + 1));
    expect(close.counters).toEqual({ breachesRecorded: 0, autoClosed: 1, expired: 0 });
  });
});

describe('reopen (7 calendar days inclusive) vs linked ticket', () => {
  it('reply exactly at reopenUntil reopens the same ticket with a new resolution cycle; response clock untouched', () => {
    const { lc } = lifecycle();
    const f = resolved(lc);
    const response = f.clock('RESPONSE');
    const until = f.agg.ticket.reopenUntil!;
    const r = f.apply((a) => same(lc.customerReply(a, CUSTOMER, 'It broke again', until)));
    expect(actions(r)).toEqual(['MESSAGE_PUBLISHED', 'TICKET_REOPENED']);
    expect(f.agg.ticket).toMatchObject({
      status: 'IN_PROGRESS',
      assigneeId: AGENT.id,
      resolutionCycle: 1,
      resolvedAt: null,
      reopenUntil: null,
    });
    expect(f.clock('RESPONSE')).toBe(response);
    expect(f.clock('RESOLUTION', 1)).toMatchObject({
      state: 'RUNNING',
      cycle: 1,
      budgetMs: 1620 * 60_000,
      consumedMs: 0,
    });
    expect(f.clock('RESOLUTION', 0).state).toBe('COMPLETED'); // history kept
  });

  it('reopen without an assignee returns to the OPEN queue', () => {
    const { lc } = lifecycle();
    const f = resolved(lc);
    const unassigned: TicketAggregate = { ...f.agg, ticket: { ...f.agg.ticket, assigneeId: null } };
    const r = same(lc.customerReopen(unassigned, CUSTOMER, 'Please look again', t('12:00')));
    expect(r.aggregate.ticket).toMatchObject({
      status: 'OPEN',
      assigneeId: null,
      resolutionCycle: 1,
    });
  });

  it('reopen 1 ms after the window expires the old ticket (RESOLUTION_WINDOW_EXPIRED) and creates a linked child', () => {
    const { lc } = lifecycle();
    const f = resolved(lc);
    const at = f.agg.ticket.reopenUntil! + 1;
    const r = linked(lc.customerReopen(f.agg, CUSTOMER, 'Broken again', at));
    expect(actions(r.previous)).toEqual(['TICKET_CLOSED', 'LINKED_TICKET_CREATED']);
    // resolvedAt / reopenUntil retained for the expired-window closure
    expect(r.previous.aggregate.ticket).toMatchObject({
      status: 'CLOSED',
      closeReason: 'RESOLUTION_WINDOW_EXPIRED',
      resolvedAt: t('11:00'),
      reopenUntil: f.agg.ticket.reopenUntil,
    });
    expect(r.previous.aggregate.ticket.resolutionCycle).toBe(0);
    expect(r.child.aggregate.ticket.parentTicketId).toBe(f.agg.ticket.id);
  });

  it('contact on an already CLOSED ticket links without mutating the parent (link versions equal)', () => {
    const { lc } = lifecycle();
    const f = resolved(lc);
    f.apply((a) => lc.reconcileDue(a, a.ticket.reopenUntil! + 1));
    const r = linked(
      lc.customerReply(f.agg, CUSTOMER, 'New problem', f.agg.ticket.reopenUntil! + 86_400_000),
    );
    expect(r.previous.changed).toBe(false);
    expect(r.previous.aggregate.ticket.version).toBe(f.agg.ticket.version);
    expect(actions(r.previous)).toEqual(['LINKED_TICKET_CREATED']);
    expect(r.previous.events[0]!.details).toMatchObject({
      beforeVersion: f.agg.ticket.version,
      afterVersion: f.agg.ticket.version,
    });
  });
});

describe('delayed sweep equivalence', () => {
  const normalise = (r: CustomerContactResult) =>
    r.outcome === 'NEW_LINKED_TICKET'
      ? {
          outcome: r.outcome,
          parent: {
            status: r.previous.aggregate.ticket.status,
            closeReason: r.previous.aggregate.ticket.closeReason,
            resolvedAt: r.previous.aggregate.ticket.resolvedAt,
          },
          child: { ...r.child.aggregate.ticket, id: 'child' },
          childClocks: r.child.aggregate.clocks.map((c) => ({ ...c, id: 'x', ticketId: 'child' })),
        }
      : { outcome: r.outcome };

  it.each(['waiting', 'resolved'] as const)(
    '%s: customer contact after the cutoff yields the same outcome with or without a prior sweep',
    (kind) => {
      const build = () => {
        const { lc } = lifecycle([], 7);
        return { lc, f: kind === 'waiting' ? waiting(lc) : resolved(lc) };
      };
      const a = build();
      const b = build();
      const cutoff =
        kind === 'waiting' ? a.f.agg.ticket.waitingCloseDueAt! : a.f.agg.ticket.reopenUntil!;
      const contact = cutoff + 3_600_000;
      // A: sweep already ran shortly after the cutoff
      const swept = a.lc.reconcileDue(a.f.agg, cutoff + 1);
      expect(swept.changed).toBe(true);
      const ra = a.lc.customerReply(swept.aggregate, CUSTOMER, 'Hello again', contact);
      // B: no sweep yet; the command reconciles first
      const rb = b.lc.customerReply(b.f.agg, CUSTOMER, 'Hello again', contact);
      expect(normalise(ra)).toEqual(normalise(rb));
      expect(ra.outcome).toBe('NEW_LINKED_TICKET');
    },
  );

  it('sweep and customer reply race at the exact cutoff resolve the same way (both keep the ticket)', () => {
    const { lc } = lifecycle();
    const f = waiting(lc);
    const cutoff = f.agg.ticket.waitingCloseDueAt!;
    expect(lc.reconcileDue(f.agg, cutoff).changed).toBe(false);
    expect(lc.customerReply(f.agg, CUSTOMER, 'here', cutoff).outcome).toBe('SAME_TICKET');
  });
});

describe('time safety', () => {
  it('clamps a backwards DB clock step to ticket.updatedAt and flags the anomaly', () => {
    const { lc } = lifecycle();
    const f = inProgress(lc);
    const r = lc.addNote(f.agg, AGENT, 'clock skew', t('09:00'));
    expect(r.timeAnomaly).toBe(true);
    expect(r.messages[0]!.createdAt).toBe(f.agg.ticket.updatedAt);
  });

  it('rejects non-integer timestamps', () => {
    const { lc } = lifecycle();
    const f = inProgress(lc);
    expect(() => lc.addNote(f.agg, AGENT, 'x', 1.5)).toThrow(RangeError);
  });
});
