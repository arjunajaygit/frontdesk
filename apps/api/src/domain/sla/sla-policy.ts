import { SLA_POLICY, type Priority } from '@frontdesk/contracts';
import type { BusinessCalendar } from '../calendar/business-calendar';
import type { DurationMs, Instant } from '../shared/instant';

export type ClockKind = 'RESPONSE' | 'RESOLUTION';

/** Strategy: budget for a clock kind under a priority. Urgent resolution depends on the cycle start. */
export interface SlaPolicy {
  budgetMs(priority: Priority, kind: ClockKind, cycleStartedAt: Instant): DurationMs;
}

export class ArvoSlaPolicy implements SlaPolicy {
  constructor(private readonly calendar: BusinessCalendar) {}

  budgetMs(priority: Priority, kind: ClockKind, cycleStartedAt: Instant): DurationMs {
    const policy = SLA_POLICY[priority];
    if (kind === 'RESPONSE') return policy.responseMs;
    // URGENT: remaining working time to close of the *original* effective cycle day (never a rolling 540).
    return policy.resolutionMs ?? this.calendar.urgentDayBudgetMs(cycleStartedAt);
  }
}
