import { expect, test, type Page } from '@playwright/test';
import { USERS } from './helpers/env';
import { db, signedInContext } from './helpers/ui';

/**
 * Runtime health of the redesigned UI: every screen is opened as each role at desktop and phone widths, and the
 * run fails on ANY console error/warning, uncaught page error, failed asset request (JS/CSS/font/image/favicon) or
 * API 5xx. The only tolerated browser messages are the signed-out session probe's expected 401/403 on /login.
 */
interface Problems {
  list: string[];
}
function watch(page: Page): Problems {
  const p: Problems = { list: [] };
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const url = m.location()?.url ?? '';
    // Signed-out startup probe (lib/api.ts restoreSession): GET /auth/me -> 401, then POST /auth/refresh -> 401/403
    // (CSRF guard: no session-bound token exists yet). Both are expected and handled; browsers log any 4xx fetch.
    const expectedProbe =
      (/\/api\/auth\/me$/.test(url) && m.text().includes('401')) ||
      (/\/api\/auth\/refresh$/.test(url) && /40[13]/.test(m.text()));
    if (!expectedProbe) p.list.push(`console.${m.type()}: ${m.text().slice(0, 200)} @ ${url}`);
  });
  page.on('pageerror', (e) => p.list.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('requestfailed', (r) => {
    if (!r.url().includes('/api/'))
      p.list.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 500) p.list.push(`HTTP ${r.status()}: ${u}`);
    else if (r.status() >= 400 && !u.includes('/api/'))
      p.list.push(`asset HTTP ${r.status()}: ${u}`);
  });
  return p;
}
// Deterministic observation window. ('networkidle' never settles under the Vite dev server: React StrictMode's
// aborted duplicate session probe stays pending in the browser's request tracking. Not a product behaviour.)
const settle = async (page: Page) => {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1200);
};
/** Phones: open the navigation drawer only if it is not already open (it is a toggle). */
async function ensureMenu(page: Page) {
  const b = page.locator('button[aria-controls="staff-nav"]');
  if ((await b.isVisible()) && (await b.getAttribute('aria-expanded')) !== 'true') await b.click();
}

let fd010: string;
test.beforeAll(async () => {
  fd010 = await db(
    async (c) =>
      (await c.query(`SELECT id FROM "Ticket" WHERE subject LIKE '[FD-010]%'`)).rows[0].id,
  );
});

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test(`login screen loads cleanly (${vp.name})`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    const p = watch(page);
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await settle(page);
    const favicon = await page.request.get('/favicon.svg');
    expect(favicon.status(), 'favicon asset is served').toBe(200);
    expect(p.list).toEqual([]);
    await ctx.close();
  });

  test(`staff screens, tabs and dialogs run without runtime errors (${vp.name})`, async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.lead, {
      width: vp.width,
      height: vp.height,
    });
    const p = watch(page);
    for (const view of ['all', 'mine', 'unassigned', 'breached', 'waiting', 'resolved', 'closed']) {
      await page.goto(`/staff?view=${view}`);
      await expect(page.locator('#list-title')).toBeVisible();
      await settle(page);
    }
    await page.goto(`/staff?view=all&ticket=${fd010}`);
    await expect(page.locator('#ticket-title')).toBeVisible();
    await settle(page);
    await page.getByRole('tab', { name: 'SLA history & audit' }).click();
    await expect(page.getByRole('list', { name: 'Audit events' })).toBeVisible();
    await settle(page);
    if (vp.width < 1024) await page.getByRole('button', { name: 'Back to list' }).click();
    await ensureMenu(page);
    await page.getByRole('button', { name: 'New ticket' }).click();
    await expect(page.getByRole('dialog', { name: 'New ticket' })).toBeVisible();
    await settle(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'New ticket' })).toHaveCount(0);
    await ensureMenu(page);
    await page.getByRole('button', { name: 'Run SLA sweep' }).click();
    await expect(page.getByRole('dialog', { name: /sweep/i })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(p.list).toEqual([]);
    await ctx.close();
  });

  test(`customer portal screens run without runtime errors (${vp.name})`, async ({ browser }) => {
    const { ctx, page } = await signedInContext(browser, USERS.customer1, {
      width: vp.width,
      height: vp.height,
    });
    const p = watch(page);
    await expect(page.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
    await settle(page);
    await page.goto('/portal/new');
    await expect(page.getByLabel('Subject')).toBeVisible();
    await settle(page);
    await page.goto(`/portal/tickets/${fd010}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Billing address change' }),
    ).toBeVisible();
    await settle(page);
    expect(p.list).toEqual([]);
    await ctx.close();
  });
}
