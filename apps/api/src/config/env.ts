import { z } from 'zod';

/** Startup configuration (AUTH_CONTRACT V3.2). Error messages never echo secret values. */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PLACEHOLDER = /(replace_with|replace_me|changeme|change_me|placeholder|your[-_]secret)/i;
const MIN_SECRET_BYTES = 32;

/** Decode a secret supplied as hex, base64 or base64url. Returns null when malformed. */
export function decodeSecret(value: string): Buffer | null {
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9_-]+={0,2}$/.test(value) || /^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const buf = Buffer.from(value, 'base64');
    return buf.length > 0 ? buf : null;
  }
  return null;
}

function secretIssue(name: string, value: string): string | null {
  if (PLACEHOLDER.test(value)) return `${name} looks like a placeholder`;
  const bytes = decodeSecret(value);
  if (!bytes) return `${name} must be hex, base64 or base64url encoded`;
  if (bytes.length < MIN_SECRET_BYTES) return `${name} must decode to at least ${MIN_SECRET_BYTES} bytes`;
  if (new Set(bytes).size < 8) return `${name} has too little entropy`;
  return null;
}

export function secretsEqual(a: string, b: string): boolean {
  const x = decodeSecret(a);
  const y = decodeSecret(b);
  return a === b || (x !== null && y !== null && x.equals(y));
}

const origin = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'PUBLIC_ORIGIN must be an absolute URL origin' });
    return;
  }
  if (url.origin !== value || value.endsWith('/')) {
    ctx.addIssue({
      code: 'custom',
      message: 'PUBLIC_ORIGIN must be a canonical origin: scheme://host[:port], no path/query/fragment/trailing slash',
    });
  }
});

const dbUrl = z
  .string()
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgresql:// URL');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    BUSINESS_TIMEZONE: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
    DATABASE_URL: dbUrl,
    MIGRATION_DATABASE_URL: dbUrl.optional(),
    /** Restricted runtime role the app must connect as; an equivalent role is allowed only if it passes H04 checks. */
    DATABASE_RUNTIME_ROLE: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default('frontdesk_app'),
    PUBLIC_ORIGIN: origin,
    JWT_SECRET: z.string().min(1),
    CSRF_SIGNING_KEY: z.string().min(1),
    SWEEP_LEASE_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),
    SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
    SWEEP_MAX_BATCHES: z.coerce.number().int().min(1).max(100).default(10),
    /** Local prod-like runs only: allow a loopback http:// PUBLIC_ORIGIN with NODE_ENV=production. Never needed on a real host. */
    ALLOW_LOOPBACK_HTTP_IN_PRODUCTION: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    /** Directory of the compiled React app. When set, the API process also serves it (single same-origin container). */
    WEB_DIST_DIR: z.string().min(1).optional(),
    /** Transaction-local lock_timeout for business commands (bounded waits; raised only by proof tests). */
    DB_LOCK_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(3_000),
    SWEEP_SCHEDULER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SWEEP_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
    /** Bounded drain of an in-flight sweep tick on SIGTERM; keep below the platform's stop grace period. */
    SWEEP_SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(100).max(120_000).default(20_000),
    /** Number of trusted reverse-proxy hops (0 = trust none). Configure narrowly per host (M8). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    LOGIN_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(10_000).default(10),
    SWEEP_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(1_000).default(6),
    /** Per authenticated USER (all of that user's sessions share it) — final audit M01. */
    API_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(100_000).default(600),
    /** Coarse per-IP flood ceiling for all /api traffic before authentication (a whole office may share one IP). */
    API_IP_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(1_000_000).default(3000),
    /** Strict per-IP budget for unauthenticated work: failed authentication, CSRF bootstrap, refresh attempts. */
    ANON_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(5).max(100_000).default(120),
    /**
     * Machine credential for POST /api/internal/sweep (external scheduler, e.g. Supabase Cron + pg_net, when the
     * host sleeps). Unset = endpoint disabled (404). Dedicated: never a user credential, never another secret.
     */
    SWEEP_TRIGGER_TOKEN: z.string().min(1).optional(),
    SWEEP_TRIGGER_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(600).default(12),
    /** Internal Prometheus listener; 0 = disabled (default). Never the public port; do not publish it. */
    METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(0),
    METRICS_HOST: z.string().min(1).default('127.0.0.1'),
    /** Bearer token for scrapes; REQUIRED in production when the listener is enabled. */
    METRICS_TOKEN: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (env.PUBLIC_ORIGIN) {
      try {
        const url = new URL(env.PUBLIC_ORIGIN);
        const loopback = LOOPBACK_HOSTS.has(url.hostname === '::1' ? '[::1]' : url.hostname);
        if (env.NODE_ENV === 'production' && url.protocol !== 'https:' && !(env.ALLOW_LOOPBACK_HTTP_IN_PRODUCTION && loopback)) {
          add('PUBLIC_ORIGIN', 'must be https in production');
        }
        if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname === '::1' ? '[::1]' : url.hostname)) {
          add('PUBLIC_ORIGIN', 'plain http is allowed only for loopback hosts');
        }
      } catch {
        /* reported by field validator */
      }
    }
    if (env.METRICS_PORT && env.METRICS_PORT === env.PORT) add('METRICS_PORT', 'must differ from PORT (metrics stay off the public listener)');
    if (env.NODE_ENV === 'production' && env.METRICS_PORT && (!env.METRICS_TOKEN || env.METRICS_TOKEN.length < 32)) {
      add('METRICS_TOKEN', 'a random token of at least 32 characters is required in production when METRICS_PORT is set');
    }
    if (env.SWEEP_TRIGGER_TOKEN !== undefined) {
      if (env.SWEEP_TRIGGER_TOKEN.length < 32 || env.SWEEP_TRIGGER_TOKEN.length > 256) add('SWEEP_TRIGGER_TOKEN', 'must be a random token of 32-256 characters');
      if ([env.JWT_SECRET, env.CSRF_SIGNING_KEY, env.METRICS_TOKEN].includes(env.SWEEP_TRIGGER_TOKEN)) add('SWEEP_TRIGGER_TOKEN', 'must be generated independently of every other secret');
    }
    const jwt = secretIssue('JWT_SECRET', env.JWT_SECRET);
    if (jwt) add('JWT_SECRET', jwt);
    const csrf = secretIssue('CSRF_SIGNING_KEY', env.CSRF_SIGNING_KEY);
    if (csrf) add('CSRF_SIGNING_KEY', csrf);
    if (!jwt && !csrf && secretsEqual(env.JWT_SECRET, env.CSRF_SIGNING_KEY)) {
      add('CSRF_SIGNING_KEY', 'must be generated independently of JWT_SECRET');
    }
    if (env.MIGRATION_DATABASE_URL) {
      try {
        const runtimeUser = decodeURIComponent(new URL(env.DATABASE_URL).username);
        const ownerUser = decodeURIComponent(new URL(env.MIGRATION_DATABASE_URL).username);
        if (runtimeUser === ownerUser) {
          add('MIGRATION_DATABASE_URL', 'migration owner and runtime database roles must differ');
        }
      } catch {
        add('DATABASE_URL', 'cannot parse database URL');
      }
    }
  });

export type AppConfig = z.infer<typeof schema>;

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n - ${issues.join('\n - ')}`);
    this.name = 'ConfigValidationError';
  }
}

export function parseEnv(raw: Record<string, string | undefined>): AppConfig {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`),
    );
  }
  return result.data;
}
