/** Shared domain constants — single source of truth (DOMAIN_CONTRACT). Durations are integer ms. */
export const MINUTE_MS = 60_000;
export const BUSINESS_DAY_MS = 540 * MINUTE_MS; // 09:30-18:30
export const REOPEN_WINDOW_MS = 7 * 86_400_000; // calendar week, inclusive
export const AUTO_CLOSE_BUDGET_MS = 2700 * MINUTE_MS;

export const PRIORITIES = ['URGENT', 'MEDIUM', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ROLES = ['AGENT', 'LEAD', 'CUSTOMER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

/** Response / resolution budgets in ms. URGENT resolution is dynamic (rest of effective business day). */
export const SLA_POLICY: Record<Priority, { responseMs: number; resolutionMs: number | null }> = {
  URGENT: { responseMs: 120 * MINUTE_MS, resolutionMs: null },
  MEDIUM: { responseMs: 270 * MINUTE_MS, resolutionMs: 1620 * MINUTE_MS },
  LOW: { responseMs: 540 * MINUTE_MS, resolutionMs: 2700 * MINUTE_MS },
};

export const COOKIE_NAMES = {
  access: 'frontdesk_access',
  refresh: 'frontdesk_refresh',
  csrf: 'frontdesk_csrf',
} as const;

/** AUTH_CONTRACT lifetimes (ms). */
export const ACCESS_TOKEN_TTL_MS = 15 * MINUTE_MS;
export const SESSION_ABSOLUTE_TTL_MS = 7 * 86_400_000;
export const CSRF_TOKEN_TTL_MS = 60 * MINUTE_MS;
/** Refresh-token digests are retained until session expiry + 24h; idempotency records >= 24h. */
export const RETENTION_GRACE_MS = 86_400_000;
export const IDEMPOTENCY_RETENTION_MS = 86_400_000;

/** Strict AuditEvent union generated from the authoritative OpenAPI (single source of truth). */
export { default as AUDIT_EVENT_SCHEMA } from './audit-event.schema.json';
