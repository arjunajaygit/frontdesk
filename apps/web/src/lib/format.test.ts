import { describe, expect, it } from 'vitest';
import { formatIst, formatWorking, ticketRef } from './format';

describe('formatting', () => {
  it('renders instants in IST with the zone labelled', () => {
    expect(formatIst('2026-11-23T04:00:00.000Z')).toBe('Mon, 23 Nov, 09:30 IST');
    expect(formatIst(null)).toBe('—');
  });
  it('formats server-provided working time using the 9-hour working day', () => {
    expect(formatWorking(0)).toBe('0m');
    expect(formatWorking(30 * 60_000)).toBe('30m');
    expect(formatWorking(270 * 60_000)).toBe('4h 30m');
    expect(formatWorking(540 * 60_000)).toBe('1d');
    expect(formatWorking(2700 * 60_000)).toBe('5d');
    expect(formatWorking(30_000)).toBe('<1m');
  });
  it('derives a stable short reference from the id', () => {
    expect(ticketRef('0190e000-0000-7000-8000-000000000001')).toBe('FD-0190E000');
  });
});
