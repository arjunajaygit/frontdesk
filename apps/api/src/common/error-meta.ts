import { Prisma } from '@prisma/client';

/**
 * Allowlisted diagnostic metadata for logs (M05). Never includes error messages, stack traces, SQL, driver
 * text or user content — those may carry tokens, credentials or private note bodies.
 */
export interface ErrorMeta {
  errorClass: string;
  code?: string;
}

const KNOWN_CLASSES = new Set([
  'AppError', 'DomainError', 'AuditPayloadError', 'ConcurrentModificationError', 'TypeError', 'RangeError',
  'PrismaClientKnownRequestError', 'PrismaClientUnknownRequestError', 'PrismaClientInitializationError',
  'PrismaClientValidationError', 'PrismaClientRustPanicError', 'Error',
]);

export function errorMeta(e: unknown): ErrorMeta {
  if (!(e instanceof Error)) return { errorClass: 'NonError' };
  const errorClass = KNOWN_CLASSES.has(e.name) ? e.name : KNOWN_CLASSES.has(e.constructor?.name) ? e.constructor.name : 'Error';
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const pg = (e.meta as { code?: unknown } | undefined)?.code;
    return { errorClass, code: typeof pg === 'string' && /^[0-9A-Z]{5}$/.test(pg) ? `${e.code}/${pg}` : e.code };
  }
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? { errorClass, code } : { errorClass };
}
