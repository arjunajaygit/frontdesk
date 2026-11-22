import { randomBytes } from 'node:crypto';
import { ConfigValidationError, parseEnv } from '../../apps/api/src/config/env';

const hex = () => randomBytes(32).toString('hex');
const good = () => ({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://frontdesk_app:pw@localhost:55432/frontdesk',
  MIGRATION_DATABASE_URL: 'postgresql://frontdesk_owner:pw@localhost:55432/frontdesk',
  PUBLIC_ORIGIN: 'http://localhost:5173',
  JWT_SECRET: hex(),
  CSRF_SIGNING_KEY: hex(),
});
const issues = (env: Record<string, string | undefined>) => {
  try {
    parseEnv(env);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigValidationError);
    return (e as ConfigValidationError).issues.join('\n');
  }
  throw new Error('config unexpectedly valid');
};

describe('startup configuration (AUTH_CONTRACT)', () => {
  it('accepts a valid development configuration and applies defaults', () => {
    const cfg = parseEnv(good());
    expect(cfg.PORT).toBe(3000);
    expect(cfg.BUSINESS_TIMEZONE).toBe('Asia/Kolkata');
    expect(cfg.SWEEP_LEASE_MS).toBe(30_000);
  });
  it('accepts base64 and base64url secrets of 32+ bytes', () => {
    const e = {
      ...good(),
      JWT_SECRET: randomBytes(32).toString('base64'),
      CSRF_SIGNING_KEY: randomBytes(48).toString('base64url'),
    };
    expect(() => parseEnv(e)).not.toThrow();
  });

  it.each([
    ['missing DATABASE_URL', { DATABASE_URL: undefined }, 'DATABASE_URL'],
    ['missing PUBLIC_ORIGIN', { PUBLIC_ORIGIN: undefined }, 'PUBLIC_ORIGIN'],
    ['missing JWT_SECRET', { JWT_SECRET: undefined }, 'JWT_SECRET'],
    ['missing CSRF_SIGNING_KEY', { CSRF_SIGNING_KEY: undefined }, 'CSRF_SIGNING_KEY'],
    ['placeholder JWT', { JWT_SECRET: 'REPLACE_WITH_RANDOM_SECRET' }, 'JWT_SECRET'],
    [
      'placeholder CSRF',
      { CSRF_SIGNING_KEY: 'REPLACE_WITH_INDEPENDENT_RANDOM_SECRET' },
      'CSRF_SIGNING_KEY',
    ],
    ['short JWT', { JWT_SECRET: randomBytes(16).toString('hex') }, 'JWT_SECRET'],
    ['malformed CSRF', { CSRF_SIGNING_KEY: '!!not*encoded!!'.repeat(5) }, 'CSRF_SIGNING_KEY'],
    ['low entropy JWT', { JWT_SECRET: 'a'.repeat(64) }, 'JWT_SECRET'],
    ['trailing slash origin', { PUBLIC_ORIGIN: 'http://localhost:5173/' }, 'PUBLIC_ORIGIN'],
    ['origin with path', { PUBLIC_ORIGIN: 'http://localhost:5173/app' }, 'PUBLIC_ORIGIN'],
    ['origin with query', { PUBLIC_ORIGIN: 'http://localhost:5173?x=1' }, 'PUBLIC_ORIGIN'],
    [
      'non-canonical origin (default port)',
      { PUBLIC_ORIGIN: 'https://frontdesk.example.com:443' },
      'PUBLIC_ORIGIN',
    ],
    ['non-loopback plain http', { PUBLIC_ORIGIN: 'http://frontdesk.example.com' }, 'PUBLIC_ORIGIN'],
    ['non-url origin', { PUBLIC_ORIGIN: 'localhost' }, 'PUBLIC_ORIGIN'],
    [
      'same db role for runtime and migration',
      { DATABASE_URL: 'postgresql://frontdesk_owner:pw@localhost:55432/frontdesk' },
      'MIGRATION_DATABASE_URL',
    ],
    ['unsupported timezone', { BUSINESS_TIMEZONE: 'UTC' }, 'BUSINESS_TIMEZONE'],
  ])('rejects %s', (_n, patch, field) => {
    expect(issues({ ...good(), ...patch })).toContain(field);
  });

  it('rejects identical secrets, including the same bytes in different encodings', () => {
    const k = randomBytes(32);
    expect(
      issues({ ...good(), JWT_SECRET: k.toString('hex'), CSRF_SIGNING_KEY: k.toString('hex') }),
    ).toContain('independently');
    expect(
      issues({ ...good(), JWT_SECRET: k.toString('hex'), CSRF_SIGNING_KEY: k.toString('base64') }),
    ).toContain('independently');
  });

  it('production requires https and still allows loopback http only in development', () => {
    expect(issues({ ...good(), NODE_ENV: 'production' })).toContain('https in production');
    expect(() =>
      parseEnv({
        ...good(),
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://frontdesk.example.com',
      }),
    ).not.toThrow();
    expect(() => parseEnv({ ...good(), PUBLIC_ORIGIN: 'http://127.0.0.1:5173' })).not.toThrow();
  });

  it('loopback http in production needs the explicit local-only flag, and never for a real host', () => {
    const prod = { ...good(), NODE_ENV: 'production' };
    expect(issues(prod)).toContain('https in production');
    expect(() => parseEnv({ ...prod, ALLOW_LOOPBACK_HTTP_IN_PRODUCTION: 'true' })).not.toThrow();
    expect(
      issues({
        ...prod,
        ALLOW_LOOPBACK_HTTP_IN_PRODUCTION: 'true',
        PUBLIC_ORIGIN: 'http://frontdesk.example.com',
      }),
    ).toContain('PUBLIC_ORIGIN');
  });

  it('never echoes secret values in error messages', () => {
    const jwt = 'REPLACE_WITH_RANDOM_SECRET';
    const key = randomBytes(8).toString('hex');
    const text = issues({ ...good(), JWT_SECRET: jwt, CSRF_SIGNING_KEY: key });
    expect(text).not.toContain(jwt);
    expect(text).not.toContain(key);
  });

  it('rejects the placeholders shipped in .env.example', () => {
    const { readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
    const text = readFileSync(`${__dirname}/../../.env.example`, 'utf8');
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
    const msg = issues(env);
    expect(msg).toContain('JWT_SECRET');
    expect(msg).toContain('CSRF_SIGNING_KEY');
  });
});
