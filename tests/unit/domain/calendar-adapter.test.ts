import {
  KernelBusinessCalendar,
  validateHoliday,
} from '../../../apps/api/src/domain/calendar/business-calendar';
import {
  KERNEL_PATH,
  isCalendarKernel,
  loadCalendarKernel,
} from '../../../apps/api/src/domain/calendar/calendar-kernel';
import {
  bigintToSafeNumber,
  safeNumberToBigint,
  toIso,
} from '../../../apps/api/src/domain/shared/instant';
import { MIN, calendar, ist } from '../../helpers/domain';

describe('calendar kernel loading (ESM kernel under CommonJS/Jest)', () => {
  it('loads the preserved kernel through native require and validates its shape', () => {
    const k = loadCalendarKernel();
    expect(isCalendarKernel(k)).toBe(true);
    expect(KERNEL_PATH.endsWith('/src/calendar.mjs')).toBe(true);
    expect(k.addBusinessMinutes(ist('2026-11-20T18:00'), 120)).toBe(ist('2026-11-23T11:00')); // kernel's own semantics
  });
  it('rejects a missing kernel path and non-kernel shapes', () => {
    expect(() => loadCalendarKernel('/nonexistent/calendar.mjs')).toThrow(/not found/);
    expect(isCalendarKernel({ addBusinessMinutes: () => 0 })).toBe(false);
    expect(isCalendarKernel(null)).toBe(false);
  });
});

describe('BusinessCalendar adapter (integer ms, Asia/Kolkata, 09:30-18:30 Mon-Fri)', () => {
  const cal = calendar();

  it('Friday 18:00 intake: 120 working minutes due Monday 11:00; weekend contributes nothing', () => {
    expect(cal.addWorkingMs(ist('2026-11-20T18:00'), 120 * MIN)).toBe(ist('2026-11-23T11:00'));
    expect(cal.workingMsBetween(ist('2026-11-20T18:00'), ist('2026-11-22T12:00'))).toBe(30 * MIN);
    expect(cal.workingMsBetween(ist('2026-11-21T00:00'), ist('2026-11-23T09:30'))).toBe(0);
  });

  it('Friday exact 18:30 intake starts Monday 09:30 (half-open working interval)', () => {
    expect(cal.effectiveStart(ist('2026-11-20T18:30'))).toBe(ist('2026-11-23T09:30'));
    expect(cal.effectiveStart(ist('2026-11-20T18:30') - 1)).toBe(ist('2026-11-20T18:30') - 1);
    expect(cal.effectiveStart(ist('2026-11-23T09:30') - 1)).toBe(ist('2026-11-23T09:30'));
    expect(cal.effectiveStart(ist('2026-11-23T09:30'))).toBe(ist('2026-11-23T09:30'));
    expect(cal.addWorkingMs(ist('2026-11-20T18:30'), 120 * MIN)).toBe(ist('2026-11-23T11:30'));
  });

  it('exact closing boundary: a budget that exhausts the day ends at 18:30, not next opening', () => {
    expect(cal.addWorkingMs(ist('2026-11-20T17:30'), 60 * MIN)).toBe(ist('2026-11-20T18:30'));
    expect(cal.addWorkingMs(ist('2026-11-23T09:30'), 540 * MIN)).toBe(ist('2026-11-23T18:30'));
  });

  it('corrects float overshoot at every sub-minute boundary (kernel alone pushes ~2% into the next day)', () => {
    const close = ist('2026-11-20T18:30');
    const k = loadCalendarKernel();
    let rawFlips = 0;
    for (let r = 1; r < 3_600_000; r += 997) {
      if (Math.round(k.addBusinessMinutes(close - r, r / MIN)) !== close) rawFlips++;
      expect(cal.addWorkingMs(close - r, r)).toBe(close);
    }
    expect(rawFlips).toBeGreaterThan(0); // documents why the correction exists
  });

  it('round-trips arbitrary integer-ms budgets exactly (seeded pseudo-random property)', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const holidays = calendar(['2026-11-23', '2026-11-24']);
    for (let i = 0; i < 3000; i++) {
      const start = ist('2026-11-16T00:00') + Math.floor(rnd() * 14 * 86_400_000);
      const ms = Math.floor(rnd() * 3000 * MIN);
      for (const c of [cal, holidays]) {
        const end = c.addWorkingMs(start, ms);
        expect(Number.isSafeInteger(end)).toBe(true);
        expect(c.workingMsBetween(start, end)).toBe(ms);
      }
    }
  });

  it('single-millisecond precision is preserved, never rounded to minutes', () => {
    const start = ist('2026-11-20T10:00');
    expect(cal.addWorkingMs(start, 1)).toBe(start + 1);
    expect(cal.workingMsBetween(start, start + 59_999)).toBe(59_999);
    expect(toIso(start + 1)).toBe('2026-11-20T04:30:00.001Z');
  });

  it('zero budget returns the exact start, even outside working hours', () => {
    const sat = ist('2026-11-21T12:00');
    expect(cal.addWorkingMs(sat, 0)).toBe(sat);
  });

  it('skips configured holidays, including consecutive ones', () => {
    const one = calendar(['2026-11-23']);
    const two = calendar(['2026-11-23', '2026-11-24']);
    expect(one.addWorkingMs(ist('2026-11-20T18:00'), 120 * MIN)).toBe(ist('2026-11-24T11:00'));
    expect(two.addWorkingMs(ist('2026-11-20T18:00'), 120 * MIN)).toBe(ist('2026-11-25T11:00'));
    expect(two.workingMsBetween(ist('2026-11-23T00:00'), ist('2026-11-25T00:00'))).toBe(0);
    expect(new KernelBusinessCalendar(['2026-11-24', '2026-11-23']).holidayDates()).toEqual([
      '2026-11-23',
      '2026-11-24',
    ]);
  });

  it('urgent day budget: rest of the effective business day', () => {
    expect(cal.urgentDayBudgetMs(ist('2026-11-20T18:00'))).toBe(30 * MIN);
    expect(cal.urgentDayBudgetMs(ist('2026-11-20T19:00'))).toBe(540 * MIN); // next working day
    expect(cal.urgentDayBudgetMs(ist('2026-11-23T17:30'))).toBe(60 * MIN);
    expect(calendar(['2026-11-23']).urgentDayBudgetMs(ist('2026-11-21T10:00'))).toBe(540 * MIN);
  });

  it('nine-hour working day = 32 400 000 ms', () => {
    expect(cal.workingMsBetween(ist('2026-11-23T00:00'), ist('2026-11-24T00:00'))).toBe(32_400_000);
  });

  it('rejects invalid inputs instead of rounding them', () => {
    expect(() => cal.addWorkingMs(1.5, 0)).toThrow(RangeError);
    expect(() => cal.addWorkingMs(0, -1)).toThrow(RangeError);
    expect(() => cal.addWorkingMs(0, 0.5)).toThrow(RangeError);
    expect(() => cal.workingMsBetween(10, 5)).toThrow(RangeError);
    expect(() => validateHoliday('2026-02-30')).toThrow(RangeError);
    expect(() => validateHoliday('23-11-2026')).toThrow(RangeError);
  });
});

describe('PostgreSQL bigint <-> API integer conversion', () => {
  it('converts safe values exactly and refuses unsafe ones', () => {
    expect(bigintToSafeNumber(97_200_000n)).toBe(97_200_000);
    expect(safeNumberToBigint(162_000_000)).toBe(162_000_000n);
    expect(() => bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(RangeError);
    expect(() => bigintToSafeNumber(-1n)).toThrow(RangeError);
    expect(() => safeNumberToBigint(1.5)).toThrow(RangeError);
  });
});
