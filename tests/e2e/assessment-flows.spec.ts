import { expect, test } from '@playwright/test';
import { USERS } from './helpers/env';
import { captureApi, createCustomerTicket, db, signedInContext } from './helpers/ui';

/** UI paths that complete the assessment walk-through: staff intake, requested priority, server-side list paging. */
const uniq = (s: string) => `${s} ${Date.now().toString(36)}`;

test('staff records a phoned-in request for a customer; it opens as Urgent and appears in that customer portal', async ({
  browser,
}) => {
  const staff = await signedInContext(browser, USERS.lead);
  const subject = uniq('Phoned in: cannot log in');
  await staff.page.getByRole('button', { name: 'New ticket' }).click();
  const dialog = staff.page.getByRole('dialog', { name: 'New ticket' });
  const customerName = await db(
    async (c) =>
      (await c.query(`SELECT "displayName" FROM "User" WHERE email=$1`, [USERS.customer1])).rows[0]
        .displayName as string,
  );
  await dialog.getByLabel('Customer', { exact: true }).selectOption({ label: customerName });
  await dialog.getByLabel('Subject').fill(subject);
  await dialog.getByLabel("Customer's request").fill('Whole team locked out since 9am.');
  await dialog.getByLabel('Priority').selectOption('URGENT');
  await dialog.getByRole('button', { name: 'Create ticket' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(staff.page.getByRole('heading', { level: 2, name: subject })).toBeVisible();
  await expect(
    staff.page.locator('#ticket-title').locator('xpath=preceding-sibling::div').getByText('Urgent'),
  ).toBeVisible();
  await expect(
    staff.page.locator('[role="log"] article', { hasText: 'Whole team locked out' }),
  ).toContainText('Original request');
  // Authoritative DB state: urgent, owned by that customer, intake attributed to the staff member.
  const row = await db(
    async (c) =>
      (
        await c.query(
          `SELECT t.priority, u.email FROM "Ticket" t JOIN "User" u ON u.id=t."customerId" WHERE t.subject=$1`,
          [subject],
        )
      ).rows[0],
  );
  expect(row).toEqual({ priority: 'URGENT', email: USERS.customer1 });

  const cust = await signedInContext(browser, USERS.customer1);
  await expect(cust.page.getByRole('link', { name: new RegExp(subject) })).toBeVisible();
  // An agent takes it, as in real life (also keeps the shared "unassigned urgent" queue empty for other specs).
  const agent = await signedInContext(browser, USERS.agent2);
  await agent.page.goto(staff.page.url().replace(/^.*\/staff/, '/staff'));
  await agent.page.getByRole('button', { name: 'Claim ticket' }).click();
  await expect(agent.page.getByText('You claimed this ticket.')).toBeVisible();
  await Promise.all([staff.ctx.close(), cust.ctx.close(), agent.ctx.close()]);
});

test('a customer-requested priority is shown to staff as a request; the authoritative priority stays Medium', async ({
  browser,
}) => {
  const cust = await signedInContext(browser, USERS.customer1);
  const subject = uniq('Requested urgent');
  await cust.page.goto('/portal/new');
  await cust.page.getByLabel('Subject').fill(subject);
  await cust.page.getByLabel('What do you need help with?').fill('Production checkout is down.');
  await cust.page.getByLabel('How urgent is this for you?').selectOption('URGENT');
  await cust.page.getByRole('button', { name: 'Create ticket' }).click();
  await expect(cust.page.getByRole('heading', { level: 1, name: subject })).toBeVisible();
  const id = cust.page.url().split('/').pop()!;

  const staff = await signedInContext(browser, USERS.agent1);
  await staff.page.goto(`/staff?view=all&ticket=${id}`);
  await expect(staff.page.locator('#ticket-title')).toHaveText(subject);
  const meta = staff.page.locator('#ticket-title').locator('xpath=preceding-sibling::div');
  await expect(meta.getByText('Medium')).toBeVisible();
  await expect(meta.getByText('Customer asked for urgent')).toBeVisible();
  const row = await db(
    async (c) =>
      (await c.query(`SELECT priority, "requestedPriority" FROM "Ticket" WHERE id=$1`, [id]))
        .rows[0],
  );
  expect(row).toEqual({ priority: 'MEDIUM', requestedPriority: 'URGENT' });
  await Promise.all([staff.ctx.close(), cust.ctx.close()]);
});

test('the staff list pages through the server (25 per page): Load more shows every ticket exactly once, matching the API', async ({
  browser,
}) => {
  const total = await db(async (c) =>
    Number((await c.query(`SELECT count(*) n FROM "Ticket"`)).rows[0].n),
  );
  if (total < 30) {
    const cust = await signedInContext(browser, USERS.customer2);
    for (let i = total; i < 30; i++)
      await createCustomerTicket(cust.page, uniq(`Paging ${i}`), 'paging fixture');
    await cust.ctx.close();
  }
  const expected = await db(async (c) =>
    Number((await c.query(`SELECT count(*) n FROM "Ticket"`)).rows[0].n),
  );
  const staff = await signedInContext(browser, USERS.agent1);
  const api = captureApi(staff.page);
  await staff.page.goto('/staff?view=all');
  const rows = staff.page.getByRole('list', { name: 'All tickets tickets' }).getByRole('link');
  await expect(rows).toHaveCount(25);
  while (await staff.page.getByRole('button', { name: 'Load more tickets' }).isVisible()) {
    const before = await rows.count();
    await staff.page.getByRole('button', { name: 'Load more tickets' }).click();
    await expect.poll(() => rows.count()).toBeGreaterThan(before);
  }
  await expect(staff.page.getByText('End of list')).toBeVisible();
  const hrefs = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(new Set(hrefs).size).toBe(hrefs.length); // no duplicates across pages
  expect(hrefs.length).toBe(expected); // every ticket in the database, nothing invented
  // Paging really went through the server cursor (no client-side slicing of one big response).
  expect(api.bodies.some((b) => b.url.includes('cursor=') && b.status === 200)).toBe(true);
  await staff.ctx.close();
});
