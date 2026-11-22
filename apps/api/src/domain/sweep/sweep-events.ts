import { z } from 'zod';

/** Strict write schemas for SWEEP-target audit events (AUDIT_PAYLOAD_CONTRACT). Unknown keys are rejected. */
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const isoUtc = z.string().datetime({ offset: false, precision: 3 });
const counters = { processed: count, autoClosed: count, expired: count, breachesRecorded: count, failed: count };

export const SweepAuditSchemas = {
  SWEEP_STARTED: z.object({ leaseUntil: isoUtc }).strict(),
  SWEEP_FINISHED: z.object({ ...counters, moreDue: z.boolean() }).strict(),
  SWEEP_FAILED: z.object({ ...counters, errorCode: z.literal('SWEEP_FAILED') }).strict(),
  SWEEP_RECOVERED: z.object({ ...counters, errorCode: z.literal('SWEEP_LEASE_EXPIRED'), expiredLeaseAt: isoUtc }).strict(),
} as const;

export type SweepAuditAction = keyof typeof SweepAuditSchemas;
export type SweepAuditDetails<A extends SweepAuditAction> = z.infer<(typeof SweepAuditSchemas)[A]>;

/** Validate before append; throws (fails closed) on any undeclared or malformed field. */
export function validateSweepDetails<A extends SweepAuditAction>(action: A, details: unknown): SweepAuditDetails<A> {
  return SweepAuditSchemas[action].parse(details) as SweepAuditDetails<A>;
}
