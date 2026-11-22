import { expect, test } from '@playwright/test';
import { E2E_PASSWORD, USERS } from './helpers/env';

test('staff can sign in, see seeded tickets, open one and sign out', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill(USERS.agent1);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('viewer-name')).toHaveText('Arjun Nair');
  const list = page.getByRole('list', { name: /All tickets tickets/ });
  await expect(list.getByRole('link').first()).toBeVisible();
  await list.getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 2, name: /\[FD-/ })).toBeVisible();
  await page.screenshot({ path: '.local/screenshots/smoke-staff.png' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
