import { z } from 'zod';
import { AppError } from './app-error';

/** Zod is the single validation authority for request DTOs; unknown fields are rejected (strict). */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown, where = 'request'): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || where))].slice(0, 10);
    throw new AppError(400, 'VALIDATION_FAILED', `Invalid ${where}: ${fields.join(', ')}`);
  }
  return r.data;
}

export const uuid = z.string().uuid();
export const priority = z.enum(['URGENT', 'MEDIUM', 'LOW']);
const body = z.string().min(1).max(10_000).refine((s) => s.trim().length > 0, 'blank');

export const Schemas = {
  login: z.object({ email: z.string().email().max(254), password: z.string().min(1).max(256) }).strict(),
  staffIntake: z
    .object({ customerId: uuid, subject: z.string().min(1).max(200), body, priority })
    .strict(),
  customerIntake: z
    .object({ subject: z.string().min(1).max(200), body, requestedPriority: priority.nullable().optional() })
    .strict(),
  message: z.object({ body }).strict(),
  resolve: z.object({ body: body.optional() }).strict(),
  priority: z.object({ priority }).strict(),
  empty: z.union([z.undefined(), z.object({}).strict()]),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-]'),
  page: z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().max(2048).optional(),
    })
    .strict(),
  staffList: z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().max(2048).optional(),
      scope: z.enum(['ALL', 'MINE', 'UNASSIGNED']).default('ALL'),
      status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED']).optional(),
      priority: priority.optional(),
      late: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional(),
    })
    .strict(),
  timeline: z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().max(2048).optional(),
    })
    .strict(),
  exportQuery: z.object({ format: z.enum(['json', 'csv']).default('json') }).strict(),
};
