import { isLateAt } from '../../../apps/api/src/domain/sla/sla-clock';
import { AGENT, CUSTOMER, MIN, actions, ist, lifecycle } from '../../helpers/domain';
import { Flow } from '../../helpers/flow';

const mon = (hm: string) => ist(`2026-11-23T${hm}`);

function lowAt0930() {
  const { lc, cal } = lifecycle();
  const f = Flow.staff(lc, 'LOW', mon('09:30'));
  f.apply((a) => lc.claim(a, AGENT, mon('09:31')));
  return { lc, cal, f };
}

describe('priority revision (never resets elapsed time)', () => {
  it('worked case: Mon 09:30 low, escalate to URGENT at 11:30 -> consumed 120, response due now (on time), resolution 18:30', () => {
    const { lc, cal, f } = lowAt0930();
    const r = f.apply((a) => lc.changePriority(a, AGENT, 'URGENT', mon('11:30')));
    expect(actions(r)).toEqual(['PRIORITY_CHANGED']);
    expect(f.clock('RESPONSE')).toMatchObject({
      budgetMs: 120 * MIN,
      consumedMs: 120 * MIN,
      currentLate: false,
      deadlineAt: mon('11:30'),
      policyRevision: 1,
    });
    expect(f.clock('RESOLUTION')).toMatchObject({
      budgetMs: 540 * MIN,
      consumedMs: 120 * MIN,
      deadlineAt: mon('18:30'),
    });
    expect(isLateAt(f.clock('RESPONSE'), mon('11:30'), cal)).toBe(false);
    expect(isLateAt(f.clock('RESPONSE'), mon('11:30') + 1, cal)).toBe(true);
  });

  it('escalation exceeding the budget by 1 ms records a PRIORITY_ESCALATION breach at change time', () => {
    const { lc, f } = lowAt0930();
    const at = mon('11:30') + 1;
    const r = f.apply((a) => lc.changePriority(a, AGENT, 'URGENT', at));
    expect(actions(r)).toEqual(['PRIORITY_CHANGED', 'SLA_BREACHED']);
    expect(r.events[1]!.actor).toEqual(AGENT);
    expect(r.events[1]!.details).toMatchObject({
      cause: 'PRIORITY_ESCALATION',
      breachedAt: new Date(at).toISOString(),
      missedDeadlineAt: null,
    });
    expect(f.clock('RESPONSE')).toMatchObject({
      currentLate: true,
      breachSequence: 1,
      firstBreachedAt: at,
      deadlineAt: at,
    });
  });

  it('worked case: escalate at 12:00 -> consumed 150 > 120, breached now; resolution still due 18:30', () => {
    const { lc, f } = lowAt0930();
    const r = f.apply((a) => lc.changePriority(a, AGENT, 'URGENT', mon('12:00')));
    expect(r.counters.breachesRecorded).toBe(1);
    expect(f.clock('RESPONSE')).toMatchObject({
      consumedMs: 150 * MIN,
      currentLate: true,
      firstBreachedAt: mon('12:00'),
    });
    expect(f.clock('RESOLUTION')).toMatchObject({ currentLate: false, deadlineAt: mon('18:30') });
  });

  it('LOW -> MEDIUM below the new budget: new deadlines from remaining budget', () => {
    const { lc, f } = lowAt0930();
    f.apply((a) => lc.changePriority(a, AGENT, 'MEDIUM', mon('10:30')));
    expect(f.clock('RESPONSE')).toMatchObject({
      budgetMs: 270 * MIN,
      consumedMs: 60 * MIN,
      deadlineAt: mon('14:00'),
      currentLate: false,
    });
    expect(f.clock('RESOLUTION').budgetMs).toBe(1620 * MIN);
  });

  it('MEDIUM -> URGENT uses the ORIGINAL effective cycle start for the same-day budget, not the escalation day', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'MEDIUM', mon('17:30'));
    f.apply((a) => lc.claim(a, AGENT, mon('17:31')));
    f.apply((a) => lc.publicReply(a, AGENT, 'ack', mon('17:40')));
    f.apply((a) => lc.changePriority(a, AGENT, 'URGENT', ist('2026-11-24T09:45')));
    // original day Mon 17:30 -> 18:30 = 60 min budget; consumed 60 + 15 = 75 => late now
    expect(f.clock('RESOLUTION')).toMatchObject({
      budgetMs: 60 * MIN,
      consumedMs: 75 * MIN,
      currentLate: true,
    });
  });

  it('escalation while paused (FD-012 shape): late immediately while paused, deadline stays null, waiting adds zero', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'LOW', mon('17:30'));
    f.apply((a) => lc.claim(a, AGENT, mon('17:35')));
    f.apply((a) => lc.requestInformation(a, AGENT, 'Date range?', ist('2026-11-24T10:00'))); // 90 consumed
    const r = f.apply((a) => lc.changePriority(a, AGENT, 'URGENT', ist('2026-11-24T15:00')));
    expect(actions(r)).toEqual(['PRIORITY_CHANGED', 'SLA_BREACHED']);
    expect(f.clock('RESOLUTION')).toMatchObject({
      state: 'PAUSED',
      budgetMs: 60 * MIN,
      consumedMs: 90 * MIN,
      currentLate: true,
      deadlineAt: null,
    });
    expect(f.agg.ticket.status).toBe('WAITING');
  });

  it('escalation after completed first response leaves the response row unchanged (FD-015)', () => {
    const { lc, f } = lowAt0930();
    f.apply((a) => lc.publicReply(a, AGENT, 'Here you go', mon('10:00')));
    const response = f.clock('RESPONSE');
    const r = f.apply((a) => lc.changePriority(a, AGENT, 'URGENT', mon('11:00')));
    expect(f.clock('RESPONSE')).toBe(response); // identical object: never revised
    const revisions = (r.events[0]!.details as { clocks: { before: { kind: string } }[] }).clocks;
    expect(revisions.map((c) => c.before.kind)).toEqual(['RESOLUTION']);
  });

  it('downgrade clears current lateness but preserves history; a later miss is a distinct episode', () => {
    const { lc, cal } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', mon('09:30'));
    f.apply((a) => lc.claim(a, AGENT, mon('09:31')));
    f.apply((a) => lc.reconcileDue(a, mon('11:30') + 1)); // response breach episode 1 recorded
    const firstKey = `breach:${f.clock('RESPONSE').id}:1`;
    const down = f.apply((a) => lc.changePriority(a, AGENT, 'LOW', mon('12:00')));
    expect(actions(down)).toEqual(['PRIORITY_CHANGED']);
    expect(f.clock('RESPONSE')).toMatchObject({
      budgetMs: 540 * MIN,
      currentLate: false,
      breachSequence: 1,
      firstBreachedAt: mon('11:30') + 1,
    });
    const deadline = f.clock('RESPONSE').deadlineAt!;
    expect(deadline).toBe(mon('18:30'));
    expect(isLateAt(f.clock('RESPONSE'), deadline, cal)).toBe(false);
    const second = f.apply((a) => lc.reconcileDue(a, deadline + 1));
    const keys = second.events.filter((e) => e.action === 'SLA_BREACHED').map((e) => e.eventKey);
    expect(keys).toContain(`breach:${f.clock('RESPONSE').id}:2`);
    expect(keys).not.toContain(firstKey);
    expect(f.clock('RESPONSE')).toMatchObject({
      breachSequence: 2,
      firstBreachedAt: mon('11:30') + 1,
      currentLate: true,
    });
  });

  it('records a breach that was due under the OLD policy before applying the new one', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', mon('09:30'));
    f.apply((a) => lc.claim(a, AGENT, mon('09:31')));
    const r = f.apply((a) => lc.changePriority(a, AGENT, 'LOW', mon('12:00')));
    expect(actions(r)).toEqual(['SLA_BREACHED', 'PRIORITY_CHANGED']);
    expect(r.events[0]!.details).toMatchObject({
      cause: 'DEADLINE_EXCEEDED',
      missedDeadlineAt: new Date(mon('11:30')).toISOString(),
    });
    expect(f.clock('RESPONSE')).toMatchObject({ currentLate: false, breachSequence: 1 });
  });

  it('same priority is a pure no-op: no events, no version change', () => {
    const { lc, f } = lowAt0930();
    const before = f.agg;
    const r = lc.changePriority(before, AGENT, 'LOW', mon('12:00'));
    expect(r.changed).toBe(false);
    expect(r.events).toEqual([]);
    expect(r.aggregate.ticket.version).toBe(before.ticket.version);
  });

  it('only the assignee may change priority, and not after resolution', () => {
    const { lc, f } = lowAt0930();
    expect(() =>
      lc.changePriority(
        f.agg,
        { type: 'AGENT', id: 'a0000000-0000-4000-8000-0000000000ff' },
        'URGENT',
        mon('10:00'),
      ),
    ).toThrow(/assigned/);
    f.apply((a) => lc.resolve(a, AGENT, 'Fixed', mon('10:00')));
    expect(() => lc.changePriority(f.agg, AGENT, 'URGENT', mon('10:05'))).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE' }),
    );
    expect(() => lc.changePriority(f.agg, CUSTOMER, 'URGENT', mon('10:05'))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN_ACTOR' }),
    );
  });
});
