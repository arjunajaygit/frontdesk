import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const ROOT = resolve(__dirname, '../..');
export const SEED_ANCHOR = '2026-11-24T12:00:00+05:30'; // Tuesday noon IST, pinned for deterministic expectations

export function dotenv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const file = resolve(ROOT, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!;
    }
  }
  return env;
}

/** Values from the git-ignored .env file only (no process.env), used as the per-boot baseline. */
export function envFile(): Record<string, string> {
  const env: Record<string, string> = {};
  const file = resolve(ROOT, '.env');
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
  }
  return env;
}

export function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export function scratchName(): string {
  const n = process.env.FRONTDESK_IT_DB;
  if (!n) throw new Error('integration global setup did not provision a scratch database');
  return n;
}

export type Role = 'owner' | 'app' | 'bootstrap';

export function roleUrl(role: Role, db = scratchName()): string {
  const env = dotenv();
  const owner = env.MIGRATION_DATABASE_URL!;
  const url =
    role === 'owner'
      ? owner
      : role === 'app'
        ? env.DATABASE_URL!
        : (() => {
            const u = new URL(owner);
            u.username = 'frontdesk_bootstrap';
            u.password = env.POSTGRES_BOOTSTRAP_PASSWORD!;
            return u.toString();
          })();
  return withDatabase(url, db);
}

export async function connect(role: Role, db = scratchName()): Promise<Client> {
  const c = new Client({ connectionString: roleUrl(role, db) });
  await c.connect();
  return c;
}

/** Run `fn` in a transaction that is always rolled back (audit rows cannot be deleted afterwards). */
export async function rolledBack<T>(client: Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

/**
 * Expect a statement to fail; returns the PG error (code, constraint, message). Works inside a caller's
 * transaction (savepoint) or standalone (wraps the attempt in its own rolled-back transaction).
 */
export async function expectPgError(client: Client, sql: string, params: unknown[] = []) {
  let standalone = false;
  try {
    await client.query('SAVEPOINT s');
  } catch (e) {
    if ((e as { code?: string }).code !== '25P01') throw e; // no_active_sql_transaction
    standalone = true;
    await client.query('BEGIN');
    await client.query('SAVEPOINT s');
  }
  try {
    await client.query(sql, params);
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT s');
    if (standalone) await client.query('ROLLBACK');
    return e as { code?: string; constraint?: string; message: string };
  }
  await client.query(standalone ? 'ROLLBACK' : 'ROLLBACK TO SAVEPOINT s');
  throw new Error(`statement unexpectedly succeeded: ${sql}`);
}

export function runNode(args: string[], envOverride: Record<string, string>) {
  return spawnSync('npx', args, {
    cwd: ROOT,
    env: { ...dotenv(), ...envOverride },
    encoding: 'utf8',
  });
}
export { ROOT };
