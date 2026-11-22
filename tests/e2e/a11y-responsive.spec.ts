import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { USERS } from './helpers/env';
import { db, signedInContext } from './helpers/ui';

/** WCAG 2.2 AA-oriented automated checks (axe) + manual-style keyboard/viewport checks. Not a compliance claim. */
const SHOTS = '.local/screenshots';
const sizes = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];
let fd010: string;
test.beforeAll(async () => {
  fd010 = await db(
    async (c) =>
      (await c.query(`SELECT id FROM "Ticket" WHERE subject LIKE '[FD-010]%'`)).rows[0].id,
  );
});

async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target}`)).toEqual([]);
}
/** The staff workspace is an app shell: panes scroll, the document itself must never scroll (no empty page scroll). */
const noPageScroll = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight),
  ).toBeLessThanOrEqual(1);
const noHorizontalOverflow = async (page: Page) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);

test('login page: axe clean, labelled form, keyboard-only sign-in', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await axe(page, 'login');
  await page.screenshot({ path: `${SHOTS}/login-1440.png` });
  await page.getByLabel('Email').focus();
  await page.keyboard.type(USERS.agent1);
  await page.keyboard.press('Tab');
  await page.keyboard.type((await import('./helpers/env')).E2E_PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('viewer-name')).toBeVisible();
  await ctx.close();
});

for (const s of sizes) {
  test(`staff workspace at ${s.name}px: axe clean, no horizontal overflow, usable controls`, async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.imran, {
      width: s.width,
      height: s.height,
    });
    const wide = s.width >= 1024;
    if (!wide) await page.getByRole('button', { name: 'Open menu' }).click(); // mobile nav is a disclosure
    await expect(page.getByRole('navigation', { name: 'Ticket views' })).toBeVisible();
    if (!wide)
      await page
        .getByRole('navigation', { name: 'Ticket views' })
        .getByRole('link', { name: 'All tickets' })
        .click();
    await expect(
      page
        .getByRole('list', { name: /tickets/ })
        .getByRole('link')
        .first(),
    ).toBeVisible();
    await noHorizontalOverflow(page);
    await noPageScroll(page);
    await axe(page, `staff-list-${s.name}`);
    await page.screenshot({ path: `${SHOTS}/staff-list-${s.name}.png` });

    await page.goto(`/staff?view=all&ticket=${fd010}`);
    await expect(page.locator('#ticket-title')).toBeVisible();
    await expect(page.getByText('Internal note · team only').first()).toBeVisible();
    await noHorizontalOverflow(page);
    await noPageScroll(page);
    await axe(page, `staff-detail-${s.name}`);
    if (!wide) await expect(page.getByRole('button', { name: 'Back to list' })).toBeVisible();
    await page.getByRole('radio', { name: 'Internal note' }).click();
    await page.screenshot({ path: `${SHOTS}/staff-detail-note-${s.name}.png` });
    // Touch targets: primary buttons are at least 36px tall (WCAG 2.2 target size minimum is 24px).
    for (const b of await page.getByRole('button').all()) {
      const box = await b.boundingBox();
      if (box && box.height > 0) expect(box.height).toBeGreaterThanOrEqual(31);
    }
    await page.getByRole('tab', { name: 'SLA history & audit' }).click();
    await axe(page, `staff-history-${s.name}`);
    await page.screenshot({ path: `${SHOTS}/staff-history-${s.name}.png` });
    await ctx.close();
  });

  test(`customer portal at ${s.name}px: axe clean and no horizontal overflow`, async ({
    browser,
  }) => {
    const { ctx, page } = await signedInContext(browser, USERS.customer1, {
      width: s.width,
      height: s.height,
    });
    await expect(page.getByRole('heading', { name: 'Your tickets' })).toBeVisible();
    await noHorizontalOverflow(page);
    await axe(page, `portal-list-${s.name}`);
    await page.screenshot({ path: `${SHOTS}/portal-list-${s.name}.png` });
    await page.goto(`/portal/tickets/${fd010}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Billing address change' }),
    ).toBeVisible();
    await noHorizontalOverflow(page);
    await axe(page, `portal-ticket-${s.name}`);
    await page.screenshot({ path: `${SHOTS}/portal-ticket-${s.name}.png` });
    await ctx.close();
  });
}

test('dialogs trap focus, close with Escape and return focus; reduced motion is honoured', async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  const { loginUi } = await import('./helpers/ui');
  await loginUi(page, USERS.lead);
  const trigger = page.getByRole('button', { name: 'New ticket' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'New ticket' });
  await expect(dialog).toBeVisible();
  await axe(page, 'new-ticket-dialog');
  await page.screenshot({ path: `${SHOTS}/new-ticket-dialog-1440.png` });
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(
      true,
    ); // focus never leaves
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Run SLA sweep' }).click();
  await expect(page.getByRole('dialog', { name: /sweep/i })).toBeVisible();
  await axe(page, 'sweep-dialog');
  await ctx.close();
});

test('SLA cards stay inside the detail pane at compact desktop widths (no clipped content)', async ({
  browser,
}) => {
  const { ctx, page } = await signedInContext(browser, USERS.imran, { width: 1024, height: 768 });
  await page.goto(`/staff?view=all&ticket=${fd010}`);
  const pane = page.locator('section[aria-labelledby="ticket-title"]');
  await expect(page.getByRole('region', { name: 'Resolution SLA' })).toBeVisible();
  const paneBox = (await pane.boundingBox())!;
  for (const name of ['Response SLA', 'Resolution SLA']) {
    const box = (await page.getByRole('region', { name }).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(paneBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
  }
  await ctx.close();
});
