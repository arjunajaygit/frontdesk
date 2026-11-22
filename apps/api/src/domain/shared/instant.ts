/** Integer-millisecond UTC instants and durations (DOMAIN_CONTRACT: all durations integer ms). */
export type Instant = number;
export type DurationMs = number;

export function assertInstant(value: number, name = 'instant'): Instant {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be an integer-millisecond timestamp`);
  return value;
}

export function assertDuration(value: number, name = 'duration'): DurationMs {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of milliseconds`);
  }
  return value;
}

/** PostgreSQL timestamptz(3) values arrive as Date; floor defensively to whole milliseconds. */
export function fromDate(d: Date): Instant {
  return assertInstant(Math.floor(d.getTime()));
}

export function fromNullableDate(d: Date | null): Instant | null {
  return d === null ? null : fromDate(d);
}

export function toIso(t: Instant): string {
  return new Date(assertInstant(t)).toISOString();
}

export function toIsoOrNull(t: Instant | null): string | null {
  return t === null ? null : toIso(t);
}

/** bigint (PostgreSQL BIGINT) -> safe JSON number; throws rather than silently losing precision. */
export function bigintToSafeNumber(v: bigint, name = 'value'): number {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} is outside the safe integer range`);
  }
  return Number(v);
}

export function safeNumberToBigint(v: number, name = 'value'): bigint {
  return BigInt(assertDuration(v, name));
}
