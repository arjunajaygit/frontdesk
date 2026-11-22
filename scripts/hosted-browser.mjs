// Real-browser checks against a LIVE deployment (Chromium via Playwright): privacy in the rendered DOM and in the
// actual network responses, two-tab identity protection, session restoration and cross-tab sign-out.
// Mutations are attempted only for the synthetic verification customer; reviewer accounts are only read/signed in.
//   OWNER_URL=... node scripts/hosted-browser.mjs --base https://<host> --creds .local/credentials.hosted.json
import { readFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import pg from 'pg';

const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const BASE = arg('--base').replace(/\/$/, '');
const CREDS = JSON.parse(readFileSync(arg('--creds'), 'utf8'));
const MARKER = 'PRIVATE-NOTE-MARKER-FD010-DO-NOT-LEAK';
const VERIFY = 'verification.bot@customer.example';
const REVIEW_CUSTOMER = 'aarav.menon@customer.example';
const OTHER_CUSTOMER = 'diya.kapoor@customer.example';
const ASSIGNEE = 'imran.khan@arvo.example';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) failures++;
};
// TLS is VERIFIED against Supabase's root CA (committed, fingerprint-pinned) — never rejectUnauthorized:false.
const SUPABASE_CA = readFileSync(
  new URL('../infrastructure/deploy/supabase/supabase-prod-ca-2021.crt', import.meta.url),
);
const db = new pg.Client({ connectionString: process.env.OWNER_URL, ssl: { ca: SUPABASE_CA } });
await db.connect();
const fd010 = (await db.query(`SELECT id FROM "Ticket" WHERE subject LIKE '[FD-010]%'`)).rows[0].id;

const browser = await chromium.launch();
const newCtx = () => browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
async function signIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(CREDS[email]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 90_000 });
}
const attempt = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name, false, String(e).split('\n')[0].slice(0, 200));
  }
};

// 1. Privacy: staff sees the internal note; the customer's DOM and every API response never contain it.
await attempt('privacy', async () => {
  const staff = await newCtx();
  const sp = await staff.newPage();
  await signIn(sp, ASSIGNEE);
  await sp.goto(`/staff?view=all&ticket=${fd010}`);
  await expect(sp.getByText('Internal note · team only').first()).toBeVisible({ timeout: 30_000 });
  check('staff (assignee) sees the internal note, visually marked', true);
  await staff.close();
  const cust = await newCtx();
  const cp = await cust.newPage();
  const bodies = [];
  cp.on('response', async (r) => {
    if (r.url().includes('/api/')) bodies.push(await r.text().catch(() => ''));
  });
  await signIn(cp, REVIEW_CUSTOMER);
  await cp.goto(`/portal/tickets/${fd010}`);
  await expect(cp.getByRole('heading', { level: 1, name: 'Billing address change' })).toBeVisible({
    timeout: 30_000,
  });
  await cp.waitForLoadState('networkidle');
  check(
    'customer DOM never shows the private note',
    !(await cp.content()).includes(MARKER) && (await cp.getByText('Internal note').count()) === 0,
  );
  check(
    `customer network responses never contain it (${bodies.length} API responses inspected)`,
    bodies.length > 0 && bodies.every((b) => !b.includes(MARKER)),
  );
  await cust.close();
});

// 2. Two tabs, one browser: another customer signs in through the same cookie jar (no UI hint); the old tab's
//    pending NEW TICKET draft is refused by the server and nothing is created for either identity.
await attempt('two-tab', async () => {
  const ctx = await newCtx();
  const tab = await ctx.newPage();
  await signIn(tab, VERIFY);
  await tab.goto('/portal/new');
  const subject = `[verification] stale-tab draft ${Date.now()}`;
  await tab.getByLabel('Subject').fill(subject);
  await tab.getByLabel('What do you need help with?').fill('drafted by the verification customer');
  const pre = await ctx.request.get('/api/auth/csrf?purpose=login');
  const r = await ctx.request.post('/api/auth/login', {
    headers: { Origin: BASE, 'X-CSRF-Token': (await pre.json()).csrfToken },
    data: { email: OTHER_CUSTOMER, password: CREDS[OTHER_CUSTOMER] },
  });
  check(
    'second identity signs in through the shared cookie jar',
    r.status() === 200,
    String(r.status()),
  );
  await tab.getByRole('button', { name: 'Create ticket' }).click();
  await expect(tab.getByTestId('session-switched')).toBeVisible({ timeout: 30_000 });
  check('stale tab is told the browser switched identity', true);
  const n = (await db.query(`SELECT count(*)::int n FROM "Ticket" WHERE subject=$1`, [subject]))
    .rows[0].n;
  check('DB: the stale draft was not created under either identity', n === 0, String(n));
  await ctx.close();
});

// 3. Session restore after access-token expiry, and cross-tab sign-out.
await attempt('session', async () => {
  const ctx = await newCtx();
  const a = await ctx.newPage();
  await signIn(a, VERIFY);
  await ctx.clearCookies({ name: 'frontdesk_access' });
  await a.reload();
  await expect(a.getByRole('heading', { name: 'Your tickets' })).toBeVisible({ timeout: 30_000 });
  check('reload with an expired access token restores the session (one refresh)', true);
  const b = await ctx.newPage();
  await b.goto('/portal');
  await expect(b.getByRole('heading', { name: 'Your tickets' })).toBeVisible({ timeout: 30_000 });
  await b.getByRole('button', { name: /sign out/i }).click();
  await expect(a).toHaveURL(/\/login/, { timeout: 30_000 });
  check('signing out in one tab signs the other tab out', true);
  await ctx.close();
});

await browser.close();
await db.end();
console.log(
  failures ? `\n${failures} browser check(s) FAILED` : '\nAll hosted browser checks passed',
);
process.exit(failures ? 1 : 0);
