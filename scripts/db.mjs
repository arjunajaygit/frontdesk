// Runs Prisma tooling as the schema OWNER role (MIGRATION_DATABASE_URL), never the runtime role.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

export function loadEnv() {
  const env = { ...process.env };
  const file = new URL('../.env', import.meta.url);
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2];
    }
  }
  return env;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const url = env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('MIGRATION_DATABASE_URL missing (run npm run env:gen)');
    process.exit(1);
  }
  const cmd = process.argv[2];
  const args = { migrate: ['migrate', 'deploy'], status: ['migrate', 'status'] }[cmd];
  if (!args) {
    console.error('usage: db.mjs migrate|status');
    process.exit(1);
  }
  const r = spawnSync('npx', ['prisma', ...args], {
    stdio: 'inherit',
    env: { ...env, DATABASE_URL: url },
  });
  process.exit(r.status ?? 1);
}
