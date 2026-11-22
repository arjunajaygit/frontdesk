// Generates .env.production.local (git-ignored, mode 600) for the production-like compose stack.
// Independent random secrets; NEVER overwrites an existing value (an existing file only gains keys it lacks, e.g.
// METRICS_TOKEN added in M7); never prints secret values.
// Usage: node scripts/gen-env-prod.mjs [--origin https://frontdesk.example.com] [--port 8080]
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const origin = arg('--origin', 'http://localhost:8080');
const port = arg('--port', '8080');
const target = new URL('../.env.production.local', import.meta.url);
const hex = () => randomBytes(32).toString('hex');
const pw = () => randomBytes(24).toString('base64url');
// Keys introduced after a file may already exist; added only when missing.
const later = {
  METRICS_TOKEN: () => randomBytes(32).toString('base64url'),
  GRAFANA_ADMIN_PASSWORD: pw,
};
if (existsSync(target)) {
  const have = new Set(
    readFileSync(target, 'utf8')
      .split('\n')
      .map((l) => l.split('=')[0]),
  );
  const missing = Object.keys(later).filter((k) => !have.has(k));
  if (missing.length)
    appendFileSync(target, missing.map((k) => `${k}=${later[k]()}`).join('\n') + '\n');
  console.log(
    `.env.production.local exists; existing values untouched; added: ${missing.join(', ') || 'nothing'}.`,
  );
  process.exit(0);
}
const loopbackHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const lines = [
  '# Production-like compose stack. Git-ignored. Never commit. Rotate by deleting and regenerating (then restart; sessions are invalidated).',
  `PUBLIC_ORIGIN=${origin}`,
  `APP_PORT=${port}`,
  `ALLOW_LOOPBACK_HTTP_IN_PRODUCTION=${loopbackHttp ? 'true' : 'false'}`,
  'TRUST_PROXY_HOPS=0',
  'SWEEP_INTERVAL_MS=60000',
  `JWT_SECRET=${hex()}`,
  `CSRF_SIGNING_KEY=${hex()}`,
  `POSTGRES_BOOTSTRAP_PASSWORD=${pw()}`,
  `FRONTDESK_OWNER_PASSWORD=${pw()}`,
  `FRONTDESK_APP_PASSWORD=${pw()}`,
  ...Object.entries(later).map(([k, gen]) => `${k}=${gen()}`),
  '',
];
writeFileSync(target, lines.join('\n'), { mode: 0o600, flag: 'wx' });
console.log('.env.production.local written (mode 600). Secrets are not printed.');
