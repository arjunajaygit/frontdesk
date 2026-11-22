import { complete, isLateAt, project, revise } from '../../../apps/api/src/domain/sla/sla-clock';
import { AGENT, CUSTOMER, MIN, actions, ist, lifecycle } from '../../helpers/domain';
import { Flow } from '../../helpers/flow';

describe('SLA policy tiers and independent clocks', () => {
  it.each([
    ['URGENT', 120, 540],
    ['MEDIUM', 270, 1620],
    ['LOW', 540, 2700],
  ] as const)('%s at Monday 09:30: response %i min, resolution %i min', (p, resp, resol) => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, p, ist('2026-11-23T09:30'));
    expect(f.clock('RESPONSE').budgetMs).toBe(resp * MIN);
    expect(f.clock('RESOLUTION').budgetMs).toBe(resol * MIN);
    expect(f.clock('RESPONSE').deadlineAt).not.toBe(f.clock('RESOLUTION').deadlineAt);
  });

  it('urgent resolution is the rest of the effective day, never a rolling 540 minutes', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', ist('2026-11-23T15:00'));
    expect(f.clock('RESOLUTION').budgetMs).toBe(210 * MIN);
    expect(f.clock('RESOLUTION').deadlineAt).toBe(ist('2026-11-23T18:30'));
  });

  it('worked case: Fri 18:00 medium -> response Mon 13:30, resolution Wed 18:00, neither late on Sunday', () => {
    const { lc, cal } = lifecycle();
    const f = Flow.staff(lc, 'MEDIUM', ist('2026-11-20T18:00'));
    expect(f.clock('RESPONSE').deadlineAt).toBe(ist('2026-11-23T13:30'));
    expect(f.clock('RESOLUTION').deadlineAt).toBe(ist('2026-11-25T18:00'));
    const sunday = ist('2026-11-22T12:00');
    expect(isLateAt(f.clock('RESPONSE'), sunday, cal)).toBe(false);
    expect(project(f.clock('RESOLUTION'), sunday, cal)).toMatchObject({
      consumedMs: 30 * MIN,
      currentLate: false,
      breachDetectedNotRecorded: false,
    });
  });

  it('worked case: Fri 18:00 urgent -> reply Mon 11:00, resolution Fri 18:30; equality on time, +1 ms late, still late Sunday', () => {
    const { lc, cal } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', ist('2026-11-20T18:00'));
    const res = f.clock('RESOLUTION');
    expect(f.clock('RESPONSE').deadlineAt).toBe(ist('2026-11-23T11:00'));
    expect(res.budgetMs).toBe(30 * MIN);
    expect(res.deadlineAt).toBe(ist('2026-11-20T18:30'));
    expect(isLateAt(res, ist('2026-11-20T18:30'), cal)).toBe(false);
    expect(isLateAt(res, ist('2026-11-20T18:30') + 1, cal)).toBe(true);
    // Weekend accrues nothing (consumed == budget) yet the missed Friday deadline stays missed.
    const sunday = ist('2026-11-22T12:00');
    expect(project(res, sunday, cal)).toMatchObject({
      consumedMs: 30 * MIN,
      remainingMs: 0,
      currentLate: true,
      breachDetectedNotRecorded: true,
    });
  });

  it('worked case: Fri 18:30 urgent intake -> effective Monday 09:30, reply Mon 11:30, resolution Mon 18:30', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', ist('2026-11-20T18:30'));
    expect(f.clock('RESOLUTION').cycleStartedAt).toBe(ist('2026-11-23T09:30'));
    expect(f.clock('RESPONSE').deadlineAt).toBe(ist('2026-11-23T11:30'));
    expect(f.clock('RESOLUTION').deadlineAt).toBe(ist('2026-11-23T18:30'));
  });

  it('first public reply completes RESPONSE only; staff INTAKE and private notes never satisfy it', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'MEDIUM', ist('2026-11-23T09:30'));
    expect(f.clock('RESPONSE').state).toBe('RUNNING'); // staff intake on behalf of the customer
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-23T09:40')));
    const note = f.apply((a) => lc.addNote(a, AGENT, 'internal only', ist('2026-11-23T09:50')));
    expect(actions(note)).toEqual(['INTERNAL_NOTE_ADDED']);
    expect(f.clock('RESPONSE').state).toBe('RUNNING');
    const reply = f.apply((a) => lc.publicReply(a, AGENT, 'Looking now', ist('2026-11-23T10:00')));
    expect(actions(reply)).toEqual(['MESSAGE_PUBLISHED', 'SLA_COMPLETED']);
    expect(f.clock('RESPONSE')).toMatchObject({
      state: 'COMPLETED',
      completedAt: ist('2026-11-23T10:00'),
      consumedMs: 30 * MIN,
      deadlineAt: null,
    });
    expect(f.clock('RESOLUTION').state).toBe('RUNNING');
    const second = f.apply((a) => lc.publicReply(a, AGENT, 'Update', ist('2026-11-23T11:00')));
    expect(actions(second)).toEqual(['MESSAGE_PUBLISHED']); // completed clock never touched again
  });

  it('a late reply records the breach (SYSTEM, onset deadline+1) before completing the clock as late', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', ist('2026-11-23T09:30'));
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-23T09:31')));
    const r = f.apply((a) =>
      lc.publicReply(a, AGENT, 'Sorry for the delay', ist('2026-11-23T12:00')),
    );
    expect(actions(r)).toEqual(['SLA_BREACHED', 'MESSAGE_PUBLISHED', 'SLA_COMPLETED']);
    const breach = r.events[0]!;
    expect(breach.actor).toEqual({ type: 'SYSTEM' });
    expect(breach.details).toMatchObject({
      breachedAt: new Date(ist('2026-11-23T11:30') + 1).toISOString(),
      cause: 'DEADLINE_EXCEEDED',
    });
    expect(breach.eventKey).toBe(`breach:${f.clock('RESPONSE').id}:1`);
    expect(f.clock('RESPONSE')).toMatchObject({
      state: 'COMPLETED',
      currentLate: true,
      breachSequence: 1,
      firstBreachedAt: ist('2026-11-23T11:30') + 1,
    });
  });

  it('completed and cancelled clocks are immutable', () => {
    const { lc, cal } = lifecycle();
    const f = Flow.staff(lc, 'LOW', ist('2026-11-23T09:30'));
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-23T09:31')));
    f.apply((a) => lc.publicReply(a, AGENT, 'hi', ist('2026-11-23T10:00')));
    const done = f.clock('RESPONSE');
    expect(() => revise(done, 1, ist('2026-11-23T11:00'), cal)).toThrow(/COMPLETED/);
    expect(() => complete(done, ist('2026-11-23T11:00'), cal)).toThrow(/COMPLETED/);
  });

  it('read projection is pure: evaluating never changes the stored clock', () => {
    const { lc, cal } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', ist('2026-11-23T09:30'));
    const before = JSON.stringify(f.agg);
    project(f.clock('RESPONSE'), ist('2026-11-25T12:00'), cal);
    expect(JSON.stringify(f.agg)).toBe(before);
  });
});

describe('pause / resume (explicit public request only)', () => {
  it('worked case: Mon 09:30 low, request 11:00, Wed 15:00 reply -> 90 consumed, 2610 remaining, waiting adds zero', () => {
    const { lc, cal } = lifecycle();
    const f = Flow.staff(lc, 'LOW', ist('2026-11-23T09:30'));
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-23T09:35')));
    const req = f.apply((a) =>
      lc.requestInformation(a, AGENT, 'Please send logs', ist('2026-11-23T11:00')),
    );
    expect(actions(req)).toEqual([
      'MESSAGE_PUBLISHED',
      'SLA_COMPLETED',
      'SLA_PAUSED',
      'TICKET_WAITING',
    ]);
    expect(f.clock('RESPONSE')).toMatchObject({
      state: 'COMPLETED',
      completedAt: ist('2026-11-23T11:00'),
    });
    expect(f.clock('RESOLUTION')).toMatchObject({
      state: 'PAUSED',
      consumedMs: 90 * MIN,
      deadlineAt: null,
      runningSince: null,
    });
    expect(project(f.clock('RESOLUTION'), ist('2026-11-25T14:59'), cal).consumedMs).toBe(90 * MIN);
    const back = f.apply((a) =>
      sameTicket(lc.customerReply(a, CUSTOMER, 'Logs attached', ist('2026-11-25T15:00'))),
    );
    expect(actions(back)).toEqual(['MESSAGE_PUBLISHED', 'SLA_RESUMED', 'TICKET_RESUMED']);
    expect(f.agg.ticket.status).toBe('IN_PROGRESS');
    expect(f.clock('RESOLUTION')).toMatchObject({
      state: 'RUNNING',
      consumedMs: 90 * MIN,
      deadlineAt: ist('2026-12-02T13:30'),
    });
  });

  it('worked case: Mon 17:30 urgent, request 18:00, Tue 10:00 reply -> budget 60, consumed 30, deadline Tue 10:30', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', ist('2026-11-23T17:30'));
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-23T17:31')));
    f.apply((a) => lc.requestInformation(a, AGENT, 'Which build?', ist('2026-11-23T18:00')));
    expect(f.clock('RESOLUTION')).toMatchObject({ budgetMs: 60 * MIN, consumedMs: 30 * MIN });
    f.apply((a) => sameTicket(lc.customerReply(a, CUSTOMER, 'Build 42', ist('2026-11-24T10:00'))));
    expect(f.clock('RESOLUTION').deadlineAt).toBe(ist('2026-11-24T10:30'));
  });

  it('ordinary public replies and notes never pause', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'MEDIUM', ist('2026-11-23T09:30'));
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-23T09:35')));
    f.apply((a) => lc.publicReply(a, AGENT, 'Could you tell me more?', ist('2026-11-23T10:00')));
    f.apply((a) => lc.addNote(a, AGENT, 'waiting on them', ist('2026-11-23T10:05')));
    expect(f.agg.ticket.status).toBe('IN_PROGRESS');
    expect(f.clock('RESOLUTION').state).toBe('RUNNING');
  });

  it('resume across a weekend and a holiday consumes nothing while waiting', () => {
    const { lc } = lifecycle(['2026-11-23']);
    const f = Flow.staff(lc, 'MEDIUM', ist('2026-11-20T10:00'));
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-20T10:05')));
    f.apply((a) => lc.requestInformation(a, AGENT, 'Need info', ist('2026-11-20T11:00'))); // 60 consumed
    f.apply((a) => sameTicket(lc.customerReply(a, CUSTOMER, 'Here', ist('2026-11-23T12:00')))); // holiday Monday
    // Resumed on a holiday: remaining 1560 min starts counting Tuesday 09:30 -> Tue 540, Wed 540, Thu 480 => Thu 17:30
    expect(f.clock('RESOLUTION')).toMatchObject({
      consumedMs: 60 * MIN,
      deadlineAt: ist('2026-11-26T17:30'),
    });
  });

  it('previously breached clock stays late through pause and resume (deadline = now on resume)', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', ist('2026-11-23T17:00'));
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-23T17:01')));
    f.apply((a) => lc.publicReply(a, AGENT, 'On it', ist('2026-11-23T17:10')));
    // resolution (90 min, due 18:30) is missed; request Tue 10:00 records breach first, then pauses
    const req = f.apply((a) =>
      lc.requestInformation(a, AGENT, 'Confirm?', ist('2026-11-24T10:00')),
    );
    expect(actions(req)).toEqual([
      'SLA_BREACHED',
      'MESSAGE_PUBLISHED',
      'SLA_PAUSED',
      'TICKET_WAITING',
    ]);
    expect(f.clock('RESOLUTION')).toMatchObject({
      state: 'PAUSED',
      currentLate: true,
      breachSequence: 1,
    });
    f.apply((a) => sameTicket(lc.customerReply(a, CUSTOMER, 'Yes', ist('2026-11-25T11:00'))));
    expect(f.clock('RESOLUTION')).toMatchObject({
      state: 'RUNNING',
      currentLate: true,
      breachSequence: 1,
      deadlineAt: ist('2026-11-25T11:00'),
    });
  });

  it('paused exhausted clock (equality after priority change): not late while paused; resume deadline=now; +1 ms late', () => {
    const { lc, cal } = lifecycle();
    const f = Flow.staff(lc, 'LOW', ist('2026-11-23T17:30'));
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-23T17:31')));
    f.apply((a) => lc.requestInformation(a, AGENT, 'Details?', ist('2026-11-24T09:30'))); // consumed exactly 60
    const esc = f.apply((a) => lc.changePriority(a, AGENT, 'URGENT', ist('2026-11-24T11:00')));
    expect(actions(esc)).toEqual(['PRIORITY_CHANGED']);
    expect(f.clock('RESOLUTION')).toMatchObject({
      state: 'PAUSED',
      budgetMs: 60 * MIN,
      consumedMs: 60 * MIN,
      currentLate: false,
      deadlineAt: null,
      policyRevision: 1,
    });
    f.apply((a) => sameTicket(lc.customerReply(a, CUSTOMER, 'Done', ist('2026-11-25T10:00'))));
    const res = f.clock('RESOLUTION');
    expect(res.deadlineAt).toBe(ist('2026-11-25T10:00'));
    expect(isLateAt(res, ist('2026-11-25T10:00'), cal)).toBe(false);
    expect(isLateAt(res, ist('2026-11-25T10:00') + 1, cal)).toBe(true);
    const sweep = f.apply((a) => lc.reconcileDue(a, ist('2026-11-25T10:00') + 1));
    expect(sweep.events[0]!.details).toMatchObject({
      breachedAt: new Date(ist('2026-11-25T10:00') + 1).toISOString(),
    });
  });

  it('cancellation on auto-close stops clocks without marking success and preserves breach history', () => {
    const { lc } = lifecycle();
    const f = Flow.staff(lc, 'URGENT', ist('2026-11-23T17:00'));
    f.apply((a) => lc.claim(a, AGENT, ist('2026-11-23T17:01')));
    f.apply((a) => lc.publicReply(a, AGENT, 'On it', ist('2026-11-23T17:10')));
    f.apply((a) => lc.requestInformation(a, AGENT, 'Confirm?', ist('2026-11-24T10:00'))); // breach recorded
    const due = f.agg.ticket.waitingCloseDueAt!;
    const close = f.apply((a) => lc.reconcileDue(a, due + 1));
    expect(actions(close)).toEqual(['SLA_CANCELLED', 'TICKET_CLOSED']);
    expect(f.clock('RESOLUTION')).toMatchObject({
      state: 'CANCELLED',
      cancelledAt: due + 1,
      currentLate: true,
      breachSequence: 1,
      completedAt: null,
    });
    expect(f.agg.ticket).toMatchObject({
      status: 'CLOSED',
      closeReason: 'AUTO_CLOSED_NO_REPLY',
      resolvedAt: null,
      waitingSince: null,
    });
    expect(close.counters).toEqual({ breachesRecorded: 0, autoClosed: 1, expired: 0 });
  });
});

function sameTicket(
  r: ReturnType<
    import('../../../apps/api/src/domain/ticket/ticket-lifecycle').TicketLifecycle['customerReply']
  >,
) {
  if (r.outcome !== 'SAME_TICKET') throw new Error(`expected SAME_TICKET, got ${r.outcome}`);
  return r.result;
}
