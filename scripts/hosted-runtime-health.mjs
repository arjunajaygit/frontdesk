/* global document, window -- referenced only inside page.evaluate() callbacks, which run in the browser */
// Runtime health of the DEPLOYED production build (real Chromium): every staff and customer screen at desktop and
// phone widths must produce no console error/warning, no uncaught page error, no failed asset and no API 5xx.
// Read-only: reviewer accounts are only signed in; dialogs are opened and closed, nothing is submitted.
//   node scripts/hosted-runtime-health.mjs --base https://<host> --creds .local/credentials.hosted.json
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const BASE = arg('--base').replace(/\/$/, '');
const CREDS = JSON.parse(readFileSync(arg('--creds'), 'utf8'));
const LEAD = 'meera.iyer@arvo.example';
const CUSTOMER = 'aarav.menon@customer.example';
let failures = 0;
const check = (name, problems) => {
  console.log(
    `${problems.length ? 'FAIL' : 'PASS'}  ${name}${problems.length ? `\n      ${problems.join('\n      ')}` : ''}`,
  );
  if (problems.length) failures++;
};
function watch(page) {
  const list = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const url = m.location()?.url ?? '';
    // Expected signed-out startup probe (lib/api.ts restoreSession): /auth/me 401, /auth/refresh 401/403.
    const probe =
      (/\/api\/auth\/me$/.test(url) && m.text().includes('401')) ||
      (/\/api\/auth\/refresh$/.test(url) && /40[13]/.test(m.text()));
    if (!probe) list.push(`console.${m.type()}: ${m.text().slice(0, 160)} @ ${url}`);
  });
  page.on('pageerror', (e) => list.push(`pageerror: ${String(e).slice(0, 160)}`));
  page.on('requestfailed', (r) => {
    if (!r.url().includes('/api/'))
      list.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) list.push(`HTTP ${r.status()}: ${r.url()}`);
    else if (r.status() >= 400 && !r.url().includes('/api/'))
      list.push(`asset HTTP ${r.status()}: ${r.url()}`);
  });
  return list;
}
const settle = async (page) => {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
};
async function signIn(page, email) {
  await page.goto(BASE + '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(CREDS[email]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 90_000 });
}

const browser = await chromium.launch();
for (const vp of [
  { name: 'desktop 1440', width: 1440, height: 900 },
  { name: 'tablet 1024', width: 1024, height: 768 },
  { name: 'phone 390', width: 390, height: 844 },
]) {
  {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    const p = watch(page);
    await page.goto(BASE + '/login');
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
    await settle(page);
    check(`login (${vp.name})`, p);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    const p = watch(page);
    await signIn(page, LEAD);
    for (const view of ['all', 'mine', 'unassigned', 'breached', 'waiting', 'resolved', 'closed']) {
      await page.goto(`${BASE}/staff?view=${view}`);
      await page.locator('#list-title').waitFor();
      await settle(page);
    }
    const first = page
      .getByRole('list', { name: /tickets/ })
      .getByRole('link')
      .first();
    await first.click();
    await page.locator('#ticket-title').waitFor();
    await settle(page);
    await page.getByRole('tab', { name: 'SLA history & audit' }).click();
    await page.getByRole('list', { name: 'Audit events' }).waitFor();
    await settle(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow > 1) p.push(`horizontal overflow ${overflow}px`);
    check(`staff views, ticket detail, audit tab (${vp.name})`, p);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    const p = watch(page);
    await signIn(page, CUSTOMER);
    await page.getByRole('heading', { name: 'Your tickets' }).waitFor();
    await settle(page);
    await page.getByRole('list', { name: 'Your tickets' }).getByRole('link').first().click();
    await page.getByRole('heading', { level: 1 }).waitFor();
    await settle(page);
    await page.goto(BASE + '/portal/new');
    await page.getByLabel('Subject').waitFor();
    await settle(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow > 1) p.push(`horizontal overflow ${overflow}px`);
    check(`customer portal list, ticket, new-ticket form (${vp.name})`, p);
    await ctx.close();
  }
}
await browser.close();
console.log(
  failures ? `\n${failures} hosted runtime check(s) FAILED` : '\nAll hosted runtime checks passed',
);
process.exit(failures ? 1 : 0);
