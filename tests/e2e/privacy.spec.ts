import { expect, test } from '@playwright/test';
import { USERS } from './helpers/env';
import { captureApi, db, loginUi, signedInContext } from './helpers/ui';

/**
 * PROOF-03 (browser): real Chromium, real frontend, real NestJS, real PostgreSQL. Staff and customers use
 * INDEPENDENT browser contexts. Network response bodies are inspected, not just the rendered DOM.
 */
const MARKER = 'PRIVATE-NOTE-MARKER-FD010-DO-NOT-LEAK'; // seeded private note on FD-010 (customer: Aarav)
const PAGED = 520;

/** page.content() throws while a SPA navigation is in flight; retry until a settled document can be read. */
async function settledContent(page: import('@playwright/test').Page): Promise<string> {
  for (let i = 0; i < 40; i++) {
    try {
      await page.waitForLoadState('load');
      return await page.content();
    } catch {
      await page.waitForTimeout(100);
    }
  }
  throw new Error('page never settled');
}
let fd010: string;
let paged: string;
let noteIds: string[] = [];

test.beforeAll(async () => {
  fd010 = await db(
    async (c) =>
      (await c.query(`SELECT id FROM "Ticket" WHERE subject LIKE '[FD-010]%'`)).rows[0].id,
  );
  // > 500 public messages with interleaved private notes, for the customer pagination proof.
  paged = await db(async (c) => {
    const cust = (await c.query(`SELECT id FROM "User" WHERE email=$1`, [USERS.customer1])).rows[0]
      .id;
    const agent = (await c.query(`SELECT id FROM "User" WHERE email=$1`, [USERS.agent1])).rows[0]
      .id;
    const id = (
      await c.query(
        `INSERT INTO "Ticket"(id,subject,"customerId",priority,"createdAt","updatedAt") VALUES (gen_random_uuid(),'Pagination fixture',$1,'LOW',now() - interval '2 days',now() - interval '2 days') RETURNING id`,
        [cust],
      )
    ).rows[0].id;
    await c.query(
      `INSERT INTO "Message"(id,"ticketId","authorId",body,visibility,kind,"createdAt")
       SELECT gen_random_uuid(), $1, CASE WHEN g % 2 = 0 THEN $2::text ELSE $3::text END, 'public message ' || lpad(g::text, 4, '0'),
              'PUBLIC', CASE WHEN g = 1 THEN 'INTAKE'::"MessageKind" ELSE 'REPLY'::"MessageKind" END, now() - interval '2 days' + (g || ' seconds')::interval
       FROM generate_series(1, ${PAGED}) g`,
      [id, cust, agent],
    );
    await c.query(
      `INSERT INTO "Message"(id,"ticketId","authorId",body,visibility,kind,"createdAt")
       SELECT gen_random_uuid(), $1, $2, 'PAGEDNOTE-SECRET-' || g, 'PRIVATE', 'NOTE', now() - interval '2 days' + (g * 40 || ' seconds')::interval + interval '500 milliseconds'
       FROM generate_series(1, 12) g`,
      [id, agent],
    );
    return id;
  });
  noteIds = await db(async (c) =>
    (
      await c.query(`SELECT id FROM "Message" WHERE "ticketId"=$1 AND visibility='PRIVATE'`, [
        paged,
      ])
    ).rows.map((r) => r.id),
  );
});

test.describe('private notes: authorised staff vs customer browser', () => {
  test('staff see the internal note, clearly marked team-only', async ({ browser }) => {
    const { ctx, page } = await signedInContext(browser, USERS.agent2);
    await page.goto(`/staff?view=all&ticket=${fd010}`);
    await expect(page.getByText(MARKER, { exact: false })).toBeVisible();
    await expect(page.getByText('Internal note · team only').first()).toBeVisible();
    await ctx.close();
  });

  test('customer DOM and every network response omit the note, its id and private fields; public content shows', async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.customer1);
    const net = captureApi(page);
    await page.goto('/portal');
    await page.getByRole('link', { name: /Billing address change/ }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Billing address change' }),
    ).toBeVisible();
    await expect(page.getByText('Updated. You will see it on the next invoice.')).toBeVisible(); // public content present
    const dom = await page.content();
    expect(dom).not.toContain(MARKER);
    expect(dom).not.toContain('Internal note');
    expect(await page.locator('[data-kind="NOTE"]').count()).toBe(0);
    const privateIds = await db(async (c) =>
      (await c.query(`SELECT id FROM "Message" WHERE visibility='PRIVATE'`)).rows.map((r) => r.id),
    );
    expect(net.bodies.length).toBeGreaterThan(0);
    for (const b of net.bodies) {
      expect(b.text).not.toContain(MARKER);
      for (const id of privateIds) expect(b.text).not.toContain(id);
      expect(b.text).not.toMatch(
        /"(visibility|kind|assigneeId|assigneeDisplayName|clocks|requestedPriority|details)"/,
      );
    }
    expect(net.requests.filter((r) => /\/api\/(tickets|admin|customers)/.test(r))).toEqual([]); // portal never touches staff endpoints
    await ctx.close();
  });

  test('customer JSON and CSV exports (downloaded in the browser) contain only authorised public data', async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.customer1);
    await page.goto(`/portal/tickets/${fd010}`);
    for (const [label, ext] of [
      ['JSON', 'json'],
      ['CSV', 'csv'],
    ] as const) {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('link', { name: label }).click(),
      ]);
      expect(download.suggestedFilename()).toBe(`ticket-${fd010}.${ext}`);
      const text = await (
        await import('node:fs/promises')
      ).readFile((await download.path())!, 'utf8');
      expect(text).toContain('Updated. You will see it on the next invoice.');
      expect(text).not.toContain(MARKER);
      expect(text).not.toMatch(/Internal note|visibility|assignee/i);
    }
    await ctx.close();
  });

  test('another customer is denied: UI shows not-found and the API answers 404 with no content', async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.customer2);
    const net = captureApi(page);
    await page.goto(`/portal/tickets/${fd010}`);
    await expect(page.getByText('We could not find that ticket in your account.')).toBeVisible();
    // Response bodies are recorded asynchronously by the capture helper: wait for the 404 entry, then inspect all.
    await expect.poll(() => net.bodies.some((b) => b.status === 404)).toBe(true);
    for (const b of net.bodies) expect(b.text).not.toContain('Billing address');
    const exp = await page.request.get(`/api/customer/tickets/${fd010}/export?format=csv`);
    expect(exp.status()).toBe(404);
    await ctx.close();
  });
});

test.describe('timeline pagination (> 500 messages) in the browser', () => {
  test('customer reaches all 520 public messages via server paging; no private notes, ids or counts leak', async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.customer1);
    const net = captureApi(page);
    await page.goto(`/portal/tickets/${paged}`);
    const articles = page.locator('[role="log"] article');
    await expect(articles).toHaveCount(50); // most recent page only
    await expect(page.getByText('public message 0520')).toBeVisible(); // newest (501+) is immediately visible
    for (
      let i = 0;
      i < 40 && (await page.getByRole('button', { name: 'Load older messages' }).count());
      i++
    ) {
      const before = await articles.count();
      await page.getByRole('button', { name: 'Load older messages' }).click();
      await expect.poll(() => articles.count()).toBeGreaterThan(before);
    }
    await expect(articles).toHaveCount(PAGED);
    await expect(page.getByText('Start of conversation')).toBeVisible();
    const texts = await articles.locator('p').allTextContents();
    expect(new Set(texts).size).toBe(PAGED); // no duplicates
    expect(texts[0]).toBe('public message 0001'); // chronological, oldest first
    expect(texts.at(-1)).toBe('public message 0520');
    const all = net.bodies.map((b) => b.text).join('\n');
    expect(all).not.toContain('PAGEDNOTE-SECRET');
    for (const id of noteIds) expect(all).not.toContain(id);
    expect(await page.content()).not.toContain('PAGEDNOTE-SECRET');
    await ctx.close();
  });

  test('staff timeline pages through the same ticket and shows all 532 messages including the 12 notes', async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.agent1);
    await page.goto(`/staff?view=all&ticket=${paged}`);
    const articles = page.locator('[role="log"] article');
    await expect(articles.first()).toBeVisible();
    for (
      let i = 0;
      i < 40 && (await page.getByRole('button', { name: 'Load older messages' }).count());
      i++
    ) {
      const before = await articles.count();
      await page.getByRole('button', { name: 'Load older messages' }).click();
      await expect.poll(() => articles.count()).toBeGreaterThan(before);
    }
    await expect(articles).toHaveCount(PAGED + 12);
    await expect(page.locator('[data-kind="NOTE"]')).toHaveCount(12);
    await ctx.close();
  });
});

test.describe('session, cache and storage hygiene', () => {
  test('staff -> logout -> customer in one browser: no staff content, no staff API calls, back/forward shows nothing sensitive', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginUi(page, USERS.agent1);
    await page.goto(`/staff?view=all&ticket=${fd010}`);
    await expect(page.getByText(MARKER, { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(await page.content()).not.toContain(MARKER);

    const net = captureApi(page);
    await loginUi(page, USERS.customer1);
    expect(await page.content()).not.toContain(MARKER);
    expect(net.requests.filter((r) => /\/api\/(tickets|admin|customers)/.test(r))).toEqual([]);
    expect(net.bodies.every((b) => !b.text.includes(MARKER))).toBe(true);

    // Back/forward must never resurrect the previous identity's screens.
    for (let i = 0; i < 4; i++) {
      await page.goBack().catch(() => undefined);
      expect(await settledContent(page)).not.toContain(MARKER);
    }
    await page.goForward().catch(() => undefined);
    expect(await settledContent(page)).not.toContain(MARKER);
    // A customer navigating directly to a staff URL is bounced to their own portal.
    await page.goto(`/staff?view=all&ticket=${fd010}`);
    await expect(page).toHaveURL(/\/portal/);
    expect(await page.content()).not.toContain(MARKER);
    await ctx.close();
  });

  test('after sign-out the protected API is 401 and /staff redirects to login', async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.agent2);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect((await page.request.get('/api/tickets')).status()).toBe(401);
    await page.goto('/staff');
    await expect(page).toHaveURL(/\/login/);
    await ctx.close();
  });

  test('a revoked/expired session removes the protected UI and explains why', async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.agent2);
    await page.goto(`/staff?view=all&ticket=${fd010}`);
    await expect(page.getByText(MARKER, { exact: false })).toBeVisible();
    await db((c) =>
      c.query(
        `UPDATE "Session" SET "revokedAt" = now() WHERE "userId" = (SELECT id FROM "User" WHERE email=$1)`,
        [USERS.agent2],
      ),
    );
    await page.getByRole('button', { name: 'Refresh ticket list' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Your session ended. Please sign in again.')).toBeVisible();
    expect(await page.content()).not.toContain(MARKER);
    await ctx.close();
  });

  test('browser persistence holds no tokens or staff data; auth cookies are HttpOnly and path-scoped', async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.agent1);
    await page.goto(`/staff?view=all&ticket=${fd010}`);
    await expect(page.getByText(MARKER, { exact: false })).toBeVisible();
    const store = await page.evaluate(async () => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
      idb: ((await indexedDB.databases?.()) ?? []).map((d) => d.name),
      caches: await caches.keys(),
    }));
    expect(JSON.stringify(store.local) + JSON.stringify(store.session)).not.toMatch(
      /token|jwt|frontdesk_|Bearer|argon2|[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}/i,
    );
    expect(JSON.stringify(store)).not.toContain(MARKER);
    expect(store.cookie).not.toMatch(/frontdesk_/); // HttpOnly: invisible to script
    expect(store.idb).toEqual([]);
    expect(store.caches).toEqual([]);
    const cookies = await ctx.cookies();
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));
    for (const n of ['frontdesk_access', 'frontdesk_refresh', 'frontdesk_csrf']) {
      expect(byName[n]?.httpOnly).toBe(true);
      expect(byName[n]?.sameSite).toBe('Lax');
    }
    expect(byName.frontdesk_access!.path).toBe('/api');
    expect(byName.frontdesk_refresh!.path).toBe('/api/auth');
    await ctx.close();
  });
});
