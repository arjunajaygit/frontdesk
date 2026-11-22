import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { Client } from 'pg';
import { roleUrl } from '../../helpers/db';
import { E2E_DB, E2E_PASSWORD, WEB_ORIGIN } from './env';

export async function loginUi(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator('main')).toBeVisible(); // viewport-agnostic: the name is hidden on narrow screens
}

/** An independent browser profile (own cookie jar) already signed in. */
export async function signedInContext(
  browser: Browser,
  email: string,
  viewport = { width: 1440, height: 900 },
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: WEB_ORIGIN, viewport });
  const page = await ctx.newPage();
  await loginUi(page, email);
  return { ctx, page };
}

/** Owner-role fixtures for the isolated e2e DB only (e.g. moving stored deadlines into the past). */
export async function db<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: roleUrl('owner', E2E_DB) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Records every /api response body so privacy assertions inspect the REAL network payloads, not just the DOM. */
export function captureApi(page: Page): {
  bodies: { url: string; status: number; text: string }[];
  requests: string[];
} {
  const bodies: { url: string; status: number; text: string }[] = [];
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/')) requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  page.on('response', async (r) => {
    if (!r.url().includes('/api/')) return;
    try {
      bodies.push({
        url: new URL(r.url()).pathname + new URL(r.url()).search,
        status: r.status(),
        text: await r.text(),
      });
    } catch {
      /* body unavailable (redirect/abort) */
    }
  });
  return { bodies, requests };
}

export async function createCustomerTicket(
  page: Page,
  subject: string,
  body: string,
): Promise<string> {
  await page.goto('/portal/new');
  await page.getByLabel('Subject').fill(subject);
  await page.getByLabel('What do you need help with?').fill(body);
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await expect(page.getByRole('heading', { level: 1, name: subject })).toBeVisible();
  return page.url().split('/').pop()!;
}

export async function openStaffTicket(page: Page, id: string): Promise<void> {
  await page.goto(`/staff?view=all&ticket=${id}`);
  await expect(page.locator('#ticket-title')).toBeVisible();
}
