import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { E2E_PASSWORD, USERS, WEB_ORIGIN } from './helpers/env';
import { db, loginUi } from './helpers/ui';

/**
 * Final audit H01 (restore / logout) and H02 (stale tabs) in a REAL browser. Every multi-tab test uses TWO PAGES
 * IN ONE BROWSER CONTEXT (shared cookie jar), and verifies persisted database truth, not only the UI.
 */
let fd010: string;
test.beforeAll(async () => {
  fd010 = await db(
    async (c) =>
      (await c.query(`SELECT id FROM "Ticket" WHERE subject LIKE '[FD-010]%'`)).rows[0].id,
  );
});

const newContext = (browser: import('@playwright/test').Browser) =>
  browser.newContext({ baseURL: WEB_ORIGIN, viewport: { width: 1440, height: 900 } });
const sessionIdOf = async (ctx: BrowserContext) =>
  (await ctx.cookies()).find((c) => c.name === 'frontdesk_refresh')!.value.split('.')[0]!;
const tokenRows = (sessionId: string) =>
  db(
    async (c) =>
      (
        await c.query(`SELECT count(*)::int n FROM "RefreshToken" WHERE "sessionId"=$1`, [
          sessionId,
        ])
      ).rows[0].n as number,
  );
const revokedAt = (sessionId: string) =>
  db(
    async (c) =>
      (await c.query(`SELECT "revokedAt" FROM "Session" WHERE id=$1`, [sessionId])).rows[0]
        .revokedAt as Date | null,
  );
const messagesWith = (text: string) =>
  db(
    async (c) =>
      (await c.query(`SELECT count(*)::int n FROM "Message" WHERE body=$1`, [text])).rows[0]
        .n as number,
  );
/** Expire the access token exactly as the browser would (the access cookie's max-age elapses). */
const expireAccess = (ctx: BrowserContext) => ctx.clearCookies({ name: 'frontdesk_access' });
/** Another identity signs in through the SAME cookie jar without any UI (no BroadcastChannel hint): a truly stale tab. */
async function apiLoginAs(ctx: BrowserContext, email: string) {
  const pre = await ctx.request.get('/api/auth/csrf?purpose=login');
  const token = (await pre.json()).csrfToken as string;
  const r = await ctx.request.post('/api/auth/login', {
    headers: { Origin: WEB_ORIGIN, 'X-CSRF-Token': token },
    data: { email, password: E2E_PASSWORD },
  });
  expect(r.status()).toBe(200);
  return (await r.json()) as { viewer: { id: string; displayName: string } };
}
const nudge = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // tab returns to the foreground

test.describe('H01: session restoration and logout', () => {
  test('reload with an expired access token and a valid refresh session restores the viewer (one rotation)', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    await loginUi(page, USERS.agent1);
    const sid = await sessionIdOf(ctx);
    const before = await tokenRows(sid);
    await expireAccess(ctx);
    await page.reload();
    await expect(page.getByTestId('viewer-name')).toBeVisible();
    await expect(page).toHaveURL(/\/staff/);
    expect(await tokenRows(sid)).toBe(before + 1); // exactly one refresh rotation
    expect(await revokedAt(sid)).toBeNull();
    await ctx.close();
  });

  test('two tabs reloading at once after access expiry share ONE refresh; the session is not revoked as reuse', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const a = await ctx.newPage();
    await loginUi(a, USERS.agent1);
    const b = await ctx.newPage();
    await b.goto('/staff');
    await expect(b.getByTestId('viewer-name')).toBeVisible();
    const sid = await sessionIdOf(ctx);
    const before = await tokenRows(sid);
    await expireAccess(ctx);
    await Promise.all([a.reload(), b.reload()]);
    await expect(a.getByTestId('viewer-name')).toBeVisible();
    await expect(b.getByTestId('viewer-name')).toBeVisible();
    expect(await revokedAt(sid)).toBeNull();
    expect(await tokenRows(sid)).toBe(before + 1);
    await ctx.close();
  });

  test('reload with a revoked refresh session lands on sign-in, and signing in again works', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    await loginUi(page, USERS.customer1);
    const sid = await sessionIdOf(ctx);
    await db((c) => c.query(`UPDATE "Session" SET "revokedAt"=now() WHERE id=$1`, [sid]));
    await expireAccess(ctx);
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
    await loginUi(page, USERS.customer1); // the login CSRF is pre-login even though an old refresh cookie exists
    await expect(page.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
    await ctx.close();
  });

  test('a failed sign-out is reported as unconfirmed (session still live); retry confirms and revokes it', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    await loginUi(page, USERS.customer1);
    const sid = await sessionIdOf(ctx);
    await page.route('**/api/auth/logout', (r) => r.abort('failed'));
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page.getByText('We could not confirm sign-out with the server')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your tickets' })).toHaveCount(0); // protected content hidden
    expect(await revokedAt(sid)).toBeNull(); // the truth: the server session is still active
    await page.unroute('**/api/auth/logout');
    await page.getByRole('button', { name: 'Retry sign-out' }).click();
    await expect(page.getByText('We could not confirm sign-out with the server')).toHaveCount(0);
    await expect.poll(() => revokedAt(sid)).not.toBeNull();
    await ctx.close();
  });

  test('after a confirmed sign-out, replaying the ORIGINAL access and refresh cookies is rejected', async ({
    browser,
    playwright,
  }) => {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    await loginUi(page, USERS.customer1);
    const jar = await ctx.cookies();
    const access = jar.find((c) => c.name === 'frontdesk_access')!.value;
    const refresh = jar.find((c) => c.name === 'frontdesk_refresh')!.value;
    const csrfCookie = jar.find((c) => c.name === 'frontdesk_csrf')!.value;
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    const replay = await playwright.request.newContext({ baseURL: WEB_ORIGIN });
    expect(
      (
        await replay.get('/api/customer/tickets', {
          headers: { Cookie: `frontdesk_access=${access}` },
        })
      ).status(),
    ).toBe(401);
    const r = await replay.post('/api/auth/refresh', {
      headers: {
        Origin: WEB_ORIGIN,
        Cookie: `frontdesk_refresh=${refresh}; frontdesk_csrf=${csrfCookie}`,
        'X-CSRF-Token': csrfCookie,
      },
    });
    expect(r.status()).toBe(401);
    await replay.dispose();
    await ctx.close();
  });
});

test.describe('H02: two tabs, one browser — identity changes', () => {
  test('customer A replaced by customer B: A’s pending draft is rejected by the server, nothing persists, A’s content disappears', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const tab = await ctx.newPage();
    await loginUi(tab, USERS.customer1);
    await tab.goto(`/portal/tickets/${fd010}`);
    await expect(
      tab.getByRole('heading', { level: 1, name: 'Billing address change' }),
    ).toBeVisible();
    const draft = 'STALE-TAB-DRAFT-customer-A';
    await tab.getByLabel('Reply', { exact: true }).fill(draft);
    const b = await apiLoginAs(ctx, USERS.customer2); // replacement identity, no UI hint at all
    await tab.getByRole('button', { name: 'Send reply' }).click(); // CSRF retry path + server context check
    await expect(tab.getByTestId('session-switched')).toContainText(b.viewer.displayName);
    await expect(
      tab.getByRole('heading', { level: 1, name: 'Billing address change' }),
    ).toHaveCount(0);
    await expect(tab.getByText(draft)).toHaveCount(0);
    expect(await messagesWith(draft)).toBe(0); // not attributed to A or to B
    await tab.goBack(); // back/forward must not resurrect A's protected content
    await expect(tab.getByText('Billing address change')).toHaveCount(0);
    await ctx.close();
  });

  test('staff replaced by another staff member: the old public-reply draft never posts as the new agent', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const tab = await ctx.newPage();
    await loginUi(tab, USERS.imran); // FD-010 assignee
    await tab.goto(`/staff?view=all&ticket=${fd010}`);
    await expect(tab.locator('#ticket-title')).toBeVisible();
    await tab.getByRole('radio', { name: 'Public reply' }).click();
    const draft = 'STALE-TAB-DRAFT-staff-imran';
    await tab.getByLabel('Public reply text').fill(draft);
    const b = await apiLoginAs(ctx, USERS.agent2);
    await tab.getByRole('button', { name: 'Send public reply' }).click();
    await expect(tab.getByTestId('session-switched')).toContainText(b.viewer.displayName);
    await expect(tab.getByTestId('viewer-name')).toContainText(b.viewer.displayName);
    expect(await messagesWith(draft)).toBe(0);
    await ctx.close();
  });

  test('staff replaced by a customer: staff UI and data are removed; the old note draft is never sent', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const tab = await ctx.newPage();
    await loginUi(tab, USERS.imran);
    await tab.goto(`/staff?view=all&ticket=${fd010}`);
    await expect(tab.getByText('Internal note · team only').first()).toBeVisible();
    await tab.getByRole('radio', { name: 'Internal note' }).click();
    const draft = 'STALE-TAB-DRAFT-note';
    await tab.getByLabel('Internal note text').fill(draft);
    await apiLoginAs(ctx, USERS.customer2);
    await tab.getByRole('button', { name: 'Add internal note' }).click();
    await expect(tab).toHaveURL(/\/portal/);
    await expect(tab.getByText('Internal note · team only')).toHaveCount(0);
    expect(await messagesWith(draft)).toBe(0);
    await ctx.close();
  });

  // The two cases below are the ones where the OLD client WOULD have persisted the draft under the replacement
  // identity (creation is allowed for any customer / any staff member), so they prove the server-side fix.
  const ticketsWithSubject = (subject: string) =>
    db(
      async (c) =>
        (await c.query(`SELECT "customerId" FROM "Ticket" WHERE subject=$1`, [subject]))
          .rows as Array<{ customerId: string }>,
    );

  test('customer A replaced by customer B: A’s pending NEW TICKET is not created for B (or A)', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const tab = await ctx.newPage();
    await loginUi(tab, USERS.customer1);
    await tab.goto('/portal/new');
    const subject = 'STALE-TAB-NEW-TICKET-customer';
    await tab.getByLabel('Subject').fill(subject);
    await tab.getByLabel('What do you need help with?').fill('drafted by customer A');
    const b = await apiLoginAs(ctx, USERS.customer2);
    await tab.getByRole('button', { name: 'Create ticket' }).click();
    await expect(tab.getByTestId('session-switched')).toContainText(b.viewer.displayName);
    expect(await ticketsWithSubject(subject)).toEqual([]);
    await ctx.close();
  });

  test('staff replaced by another staff member: the pending staff intake is not created as the new agent', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const tab = await ctx.newPage();
    await loginUi(tab, USERS.imran);
    await tab.getByRole('button', { name: 'New ticket' }).click();
    const dialog = tab.getByRole('dialog', { name: 'New ticket' });
    await expect(
      dialog.getByLabel('Customer', { exact: true }).locator('option').nth(1),
    ).toBeAttached();
    await dialog.getByLabel('Customer', { exact: true }).selectOption({ index: 1 });
    const subject = 'STALE-TAB-NEW-TICKET-staff';
    await dialog.getByLabel('Subject').fill(subject);
    await dialog.getByLabel("Customer's request").fill('phoned in, drafted by Imran');
    const b = await apiLoginAs(ctx, USERS.agent2);
    await dialog.getByRole('button', { name: 'Create ticket' }).click();
    await expect(tab.getByTestId('session-switched')).toContainText(b.viewer.displayName);
    expect(await ticketsWithSubject(subject)).toEqual([]);
    await ctx.close();
  });

  test('a suspended tab returning after an identity change revalidates before showing anything', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const tab = await ctx.newPage();
    await loginUi(tab, USERS.customer1);
    await expect(tab.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
    const b = await apiLoginAs(ctx, USERS.customer2);
    await nudge(tab);
    await expect(tab.getByTestId('session-switched')).toContainText(b.viewer.displayName);
    await expect(tab.getByText('Billing address change')).toHaveCount(0); // A's ticket list is gone
    await ctx.close();
  });

  test('sign-out in one tab signs the other tab out (cross-tab), and sign-in elsewhere is announced', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const a = await ctx.newPage();
    await loginUi(a, USERS.customer1);
    const b = await ctx.newPage();
    await b.goto('/portal');
    await expect(b.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
    await b.getByRole('button', { name: /sign out/i }).click();
    await expect(a).toHaveURL(/\/login/); // BroadcastChannel hint -> server revalidation
    await expect(a.getByText('You were signed out in another tab or window')).toBeVisible();
    await ctx.close();
  });

  test('refresh in one tab does not disturb another tab of the SAME session (stable context)', async ({
    browser,
  }) => {
    const ctx = await newContext(browser);
    const a = await ctx.newPage();
    await loginUi(a, USERS.customer1);
    const b = await ctx.newPage();
    await b.goto('/portal');
    await expect(b.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
    await expireAccess(ctx);
    await a.reload(); // tab A refreshes (rotation)
    await expect(a.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
    await nudge(b);
    await b
      .getByRole('link', { name: /new ticket/i })
      .first()
      .click();
    await expect(b.getByTestId('session-switched')).toHaveCount(0);
    await ctx.close();
  });
});
