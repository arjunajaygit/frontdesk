// Type declarations for the preserved calendar kernel (calendar.mjs itself is unchanged).
export function addBusinessMinutes(start: number, minutes: number, holidays?: Set<string>): number;
export function businessMinutesBetween(start: number, end: number, holidays?: Set<string>): number;
export function urgentDayBudget(start: number, holidays?: Set<string>): number;
