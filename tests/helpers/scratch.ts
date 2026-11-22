import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { Client } from 'pg';
import { dotenv, roleUrl, runNode, scratchName, withDatabase } from './db';

/** Known password for scratch databases only (never used outside throwaway test DBs). */
export const TEST_PASSWORD = 'scratch-only-' + randomBytes(9).toString('base64url');

async function admin<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({
    connectionString: withDatabase(dotenv().MIGRATION_DATABASE_URL!, 'frontdesk'),
  });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function grantAccess(c: Client, name: string): Promise<void> {
  await c.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
  await c.query(`GRANT CONNECT ON DATABASE ${name} TO frontdesk_app`);
}

/** Clone the migrated+seeded template (isolated per suite; retries while the template still has a session). */
export async function cloneTemplate(label: string): Promise<string> {
  const name = `${scratchName()}_${label}`;
  await admin(async (c) => {
    for (let i = 0; ; i++) {
      try {
        await c.query(`CREATE DATABASE ${name} TEMPLATE ${scratchName()} OWNER frontdesk_owner`);
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== '55006' || i > 30) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    await grantAccess(c, name);
  });
  await setKnownPasswords(name);
  return name;
}

/** Empty migrated database with a minimal identity set (deterministic "nothing is due" baseline). */
export async function freshDatabase(label: string): Promise<string> {
  const name = `${scratchName()}_${label}`;
  await admin(async (c) => {
    await c.query(`CREATE DATABASE ${name} OWNER frontdesk_owner`);
    await grantAccess(c, name);
  });
  const mig = runNode(['prisma', 'migrate', 'deploy'], { DATABASE_URL: roleUrl('owner', name) });
  if (mig.status !== 0) throw new Error(`migrate failed: ${mig.stderr}`);
  const hash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
  const c = new Client({ connectionString: roleUrl('owner', name) });
  await c.connect();
  try {
    const users = [
      ['lead@arvo.example', 'Lead Lakshmi', 'LEAD'],
      ['agent1@arvo.example', 'Agent Asha', 'AGENT'],
      ['agent2@arvo.example', 'Agent Bala', 'AGENT'],
      ['cust1@customer.example', 'Customer One', 'CUSTOMER'],
      ['cust2@customer.example', 'Customer Two', 'CUSTOMER'],
    ];
    for (const [email, name2, role] of users) {
      await c.query(
        `INSERT INTO "User"(id,email,"displayName","passwordHash",role) VALUES (gen_random_uuid(),$1,$2,$3,$4::"Role")`,
        [email, name2, hash, role],
      );
    }
  } finally {
    await c.end();
  }
  return name;
}

async function setKnownPasswords(name: string): Promise<void> {
  const hash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
  const c = new Client({ connectionString: roleUrl('owner', name) });
  await c.connect();
  try {
    await c.query(`UPDATE "User" SET "passwordHash" = $1`, [hash]);
  } finally {
    await c.end();
  }
}

/**
 * Drop a per-suite scratch database. Uses the test-only superuser: FORCE must be able to terminate backends
 * of other roles (e.g. an app pool connection still exiting after app.close()), which the owner cannot.
 */
export async function dropDatabase(name: string): Promise<void> {
  if (!name.startsWith(`${scratchName()}_`))
    throw new Error('refusing to drop a non-scratch database');
  const c = new Client({ connectionString: roleUrl('bootstrap', 'postgres') });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await c.end();
  }
}
