import * as argon2 from 'argon2';
import { Client } from 'pg';
import { roleUrl, runNode } from '../helpers/db';
import { E2E_DB, E2E_PASSWORD } from './helpers/env';

/** Recreate the dedicated e2e database (only this one name), migrate, seed FD-001..015, set known passwords. */
export async function prepareE2eDatabase(): Promise<void> {
  const boot = new Client({ connectionString: roleUrl('bootstrap', 'postgres') });
  await boot.connect();
  try {
    await boot.query(`DROP DATABASE IF EXISTS ${E2E_DB} WITH (FORCE)`);
    await boot.query(`CREATE DATABASE ${E2E_DB} OWNER frontdesk_owner`);
    await boot.query(`REVOKE ALL ON DATABASE ${E2E_DB} FROM PUBLIC`);
    await boot.query(`GRANT CONNECT ON DATABASE ${E2E_DB} TO frontdesk_app`);
  } finally {
    await boot.end();
  }
  const url = roleUrl('owner', E2E_DB);
  const mig = runNode(['prisma', 'migrate', 'deploy'], { DATABASE_URL: url });
  if (mig.status !== 0) throw new Error(`migrate failed: ${mig.stderr}`);
  const seed = runNode(['tsx', 'prisma/seed.ts'], {
    MIGRATION_DATABASE_URL: url,
    SEED_CREDENTIALS: 'none',
  });
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr}`);
  const hash = await argon2.hash(E2E_PASSWORD, { type: argon2.argon2id });
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`UPDATE "User" SET "passwordHash" = $1`, [hash]);
  } finally {
    await c.end();
  }
}

if (require.main === module) {
  prepareE2eDatabase().then(
    () => console.log('e2e database ready'),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
