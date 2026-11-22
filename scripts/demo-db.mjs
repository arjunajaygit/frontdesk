// Creates (or refreshes the seed of) the separate reviewer demo database `frontdesk_demo`.
// Never touches the existing `frontdesk` development database or its immutable audit history.
import { spawnSync } from 'node:child_process';
import { loadEnv } from './db.mjs';

const env = loadEnv();
const owner = env.MIGRATION_DATABASE_URL;
if (!owner) throw new Error('MIGRATION_DATABASE_URL missing (run npm run env:gen)');
const NAME = 'frontdesk_demo';
const withDb = (url, db) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const run = (cmd, args, extra) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...env, ...extra } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const psql = (sql) =>
  spawnSync(
    'docker',
    ['exec', 'frontdesk-postgres', 'psql', '-U', 'frontdesk_owner', '-d', 'frontdesk', '-Atc', sql],
    { encoding: 'utf8' },
  );

const exists = psql(`select 1 from pg_database where datname='${NAME}'`).stdout.trim() === '1';
if (!exists) {
  for (const sql of [
    `CREATE DATABASE ${NAME} OWNER frontdesk_owner`,
    `REVOKE ALL ON DATABASE ${NAME} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${NAME} TO frontdesk_app`,
  ]) {
    const r = psql(sql);
    if (r.status !== 0) throw new Error(r.stderr);
  }
  console.log(`created database ${NAME}`);
}
const url = withDb(owner, NAME);
run('npx', ['prisma', 'migrate', 'deploy'], { DATABASE_URL: url });
run('npx', ['tsx', 'prisma/seed.ts'], {
  MIGRATION_DATABASE_URL: url,
  SEED_CREDENTIALS: 'write',
});
console.log(
  `\nDemo database ready. Passwords (random, git-ignored, 0600): .local/credentials.frontdesk_demo.json`,
);
console.log(
  `Run the API against it with:  DATABASE_URL=${withDb(env.DATABASE_URL, NAME).replace(/:[^:@]+@/, ':****@')}  (see docs/REVIEWER_WALKTHROUGH.md)`,
);
