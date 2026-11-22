// Repository secret-safety check (M1 gate). Complements, not replaces, Gitleaks in CI (M6).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const failures = [];
const ignored = execFileSync('git', ['check-ignore', '.env', '.local/demo-credentials.json'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
for (const f of ['.env', '.local/demo-credentials.json'])
  if (!ignored.includes(f)) failures.push(`${f} is not git-ignored`);
if (tracked.some((f) => f === '.env' || f.startsWith('.local/')))
  failures.push('env/credential file is tracked or untracked-but-addable');

const rules = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  [
    'connection string with real-looking password',
    /postgres(?:ql)?:\/\/[^:\s/]+:(?!REPLACE_ME|pw@|pw\b|\$\{|%)[^@\s]{6,}@/,
  ],
  ['long hex secret assignment', /(SECRET|SIGNING_KEY|PASSWORD)\s*=\s*[0-9a-f]{48,}/i],
  ['argon2 hash literal', /\$argon2id\$v=19\$m=/],
];
for (const f of tracked) {
  if (/\.(png|pdf|lock)$|package-lock\.json$/.test(f)) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (f === 'scripts/secret-scan.mjs' || f === 'tests/integration/seed.test.ts') continue;
  for (const [name, re] of rules) if (re.test(text)) failures.push(`${f}: ${name}`);
}
if (failures.length) {
  console.error('SECRET-SAFETY FAILURES:\n' + failures.map((x) => ' - ' + x).join('\n'));
  process.exit(1);
}
console.log(
  `secret-safety OK: ${tracked.length} files scanned; .env and .local/ ignored and untracked`,
);
