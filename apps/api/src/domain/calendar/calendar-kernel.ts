import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The preserved calendar kernel (repo-root src/calendar.mjs) is an ES module. The API compiles to
 * CommonJS and Jest runs CommonJS, and Jest's module registry refuses `.mjs` outright. We therefore load
 * the kernel through Node's *native* require (Node >= 22.12 supports require(esm)), obtained via
 * process.getBuiltinModule so that test runners cannot intercept it. Same code path in production and tests;
 * the kernel itself is untouched and is still exercised by its original node:test suite.
 */
export interface CalendarKernel {
  addBusinessMinutes(start: number, minutes: number, holidays?: Set<string>): number;
  businessMinutesBetween(start: number, end: number, holidays?: Set<string>): number;
  urgentDayBudget(start: number, holidays?: Set<string>): number;
}

const EXPORTS = ['addBusinessMinutes', 'businessMinutesBetween', 'urgentDayBudget'] as const;

export function isCalendarKernel(value: unknown): value is CalendarKernel {
  if (typeof value !== 'object' || value === null) return false;
  return EXPORTS.every((name) => typeof Reflect.get(value, name) === 'function');
}

/** apps/api/{src,dist}/domain/calendar -> repository root. */
export const KERNEL_PATH = resolve(__dirname, '../../../../../src/calendar.mjs');

let cached: CalendarKernel | undefined;

export function loadCalendarKernel(path: string = KERNEL_PATH): CalendarKernel {
  if (cached && path === KERNEL_PATH) return cached;
  if (!existsSync(path)) throw new Error(`calendar kernel not found at ${path}`);
  const nativeRequire = process.getBuiltinModule('node:module').createRequire(__filename);
  const loaded: unknown = nativeRequire(path);
  if (!isCalendarKernel(loaded)) throw new Error('calendar kernel does not expose the expected functions');
  if (path === KERNEL_PATH) cached = loaded;
  return loaded;
}
