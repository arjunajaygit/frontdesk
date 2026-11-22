import { DurationMs, Instant, assertDuration, assertInstant } from '../shared/instant';
import { CalendarKernel, loadCalendarKernel } from './calendar-kernel';

const MINUTE_MS = 60_000;

/**
 * Fixed Asia/Kolkata business calendar: Mon-Fri, [09:30, 18:30), minus configured holidays.
 * All inputs/outputs are integer milliseconds. One implementation, used by every domain rule.
 */
export interface BusinessCalendar {
  /** Instant reached after consuming `ms` working milliseconds from `start` (0 => start, even out of hours). */
  addWorkingMs(start: Instant, ms: DurationMs): Instant;
  /** Working milliseconds in [start, end). Throws on reversed intervals. */
  workingMsBetween(start: Instant, end: Instant): DurationMs;
  /** Urgent resolution budget: rest of the effective business day containing/after `start`. */
  urgentDayBudgetMs(start: Instant): DurationMs;
  /** `t` if inside working time, else the next eligible opening. */
  effectiveStart(t: Instant): Instant;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateHoliday(day: string): string {
  if (!DATE.test(day) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) {
    throw new RangeError(`invalid holiday date ${day}; expected YYYY-MM-DD`);
  }
  return day;
}

/**
 * Adapter over the minute-based kernel. Converting ms -> fractional minutes is inexact in IEEE-754
 * (e.g. (59/60000)*60000 !== 59), so results are rounded to the nearest ms and one boundary case is
 * corrected: when the budget exactly exhausts a working day, float error can push the kernel's answer
 * to the next opening instead of the closing instant. Every result is verified by an exact round trip.
 */
export class KernelBusinessCalendar implements BusinessCalendar {
  private readonly holidays: Set<string>;

  constructor(
    holidays: Iterable<string> = [],
    private readonly kernel: CalendarKernel = loadCalendarKernel(),
  ) {
    this.holidays = new Set([...holidays].map(validateHoliday));
  }

  holidayDates(): string[] {
    return [...this.holidays].sort();
  }

  addWorkingMs(start: Instant, ms: DurationMs): Instant {
    assertInstant(start, 'start');
    assertDuration(ms, 'working duration');
    if (ms === 0) return start;
    let result = this.rawAdd(start, ms);
    // A positive budget can never end exactly at an opening instant; landing there means float overshoot.
    if (this.workingMsBetween(result - 1, result) === 0) result = this.rawAdd(start, ms - 1) + 1;
    if (this.workingMsBetween(start, result) !== ms) {
      throw new Error('calendar adapter invariant violated: working-time round trip failed');
    }
    return result;
  }

  workingMsBetween(start: Instant, end: Instant): DurationMs {
    assertInstant(start, 'start');
    assertInstant(end, 'end');
    if (end < start) throw new RangeError('reversed interval');
    if (end === start) return 0;
    return Math.round(this.kernel.businessMinutesBetween(start, end, this.holidays) * MINUTE_MS);
  }

  urgentDayBudgetMs(start: Instant): DurationMs {
    assertInstant(start, 'start');
    return Math.round(this.kernel.urgentDayBudget(start, this.holidays) * MINUTE_MS);
  }

  effectiveStart(t: Instant): Instant {
    // Consuming one working ms from t lands exactly 1 ms after the first working instant >= t.
    return this.addWorkingMs(t, 1) - 1;
  }

  private rawAdd(start: Instant, ms: DurationMs): Instant {
    return Math.round(this.kernel.addBusinessMinutes(start, ms / MINUTE_MS, this.holidays));
  }
}
