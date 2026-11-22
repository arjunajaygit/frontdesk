import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { SEED_ANCHOR, dotenv, runNode, withDatabase } from '../helpers/db';

/** Provision an isolated scratch database inside the dedicated Frontdesk PostgreSQL, migrate and seed it. */
export default async function setup(): Promise<void> {
  const env = dotenv();
  if (!env.MIGRATION_DATABASE_URL)
    throw new Error('MIGRATION_DATABASE_URL missing; run npm run env:gen && npm run db:up');
  // The seed imports the domain engine, which consumes the shared contracts package from its build output.
  const build = runNode(['tsc', '-p', 'packages/contracts/tsconfig.json'], {});
  if (build.status !== 0)
    throw new Error(`contracts build failed:\n${build.stdout}\n${build.stderr}`);
  const name = `frontdesk_it_${randomBytes(4).toString('hex')}`;
  const admin = new Client({
    connectionString: withDatabase(env.MIGRATION_DATABASE_URL, 'frontdesk'),
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER frontdesk_owner`);
    await admin.query(`REVOKE ALL ON DATABASE ${name} FROM PUBLIC`);
    await admin.query(`GRANT CONNECT ON DATABASE ${name} TO frontdesk_app`);
  } finally {
    await admin.end();
  }
  process.env.FRONTDESK_IT_DB = name;
  const url = withDatabase(env.MIGRATION_DATABASE_URL, name);
  const mig = runNode(['prisma', 'migrate', 'deploy'], { DATABASE_URL: url });
  if (mig.status !== 0) throw new Error(`migrate deploy failed:\n${mig.stdout}\n${mig.stderr}`);
  const seed = runNode(['tsx', 'prisma/seed.ts'], {
    MIGRATION_DATABASE_URL: url,
    SEED_ANCHOR,
    SEED_CREDENTIALS: 'none',
  });
  if (seed.status !== 0) throw new Error(`seed failed:\n${seed.stdout}\n${seed.stderr}`);
}
