// Generates a git-ignored .env with independent random secrets. Refuses to overwrite.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const target = new URL('../.env', import.meta.url);
if (existsSync(target)) {
  console.log('.env already exists; leaving it untouched.');
  process.exit(0);
}
const hex = (n) => randomBytes(n).toString('hex');
const pw = () => randomBytes(24).toString('base64url');
const v = {
  owner: pw(),
  app: pw(),
  boot: pw(),
};
let text = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
text = text
  .replace('postgresql://frontdesk_app:REPLACE_ME@', `postgresql://frontdesk_app:${v.app}@`)
  .replace('postgresql://frontdesk_owner:REPLACE_ME@', `postgresql://frontdesk_owner:${v.owner}@`)
  .replace('JWT_SECRET=REPLACE_WITH_RANDOM_SECRET', `JWT_SECRET=${hex(32)}`)
  .replace('CSRF_SIGNING_KEY=REPLACE_WITH_INDEPENDENT_RANDOM_SECRET', `CSRF_SIGNING_KEY=${hex(32)}`)
  .replace('POSTGRES_BOOTSTRAP_PASSWORD=REPLACE_ME', `POSTGRES_BOOTSTRAP_PASSWORD=${v.boot}`)
  .replace('FRONTDESK_OWNER_PASSWORD=REPLACE_ME', `FRONTDESK_OWNER_PASSWORD=${v.owner}`)
  .replace('FRONTDESK_APP_PASSWORD=REPLACE_ME', `FRONTDESK_APP_PASSWORD=${v.app}`);
writeFileSync(target, text, { mode: 0o600 });
console.log('.env written (mode 600). Secrets are not printed.');
