import { expect, test, type Page } from '@playwright/test';
import { USERS } from './helpers/env';
import { createCustomerTicket, db, openStaffTicket, signedInContext } from './helpers/ui';

const uniq = (p: string) =>
  `${p} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const clockCard = (page: Page, name: 'Response' | 'Resolution') =>
  page.getByRole('region', { name: `${name} SLA` });

test('live claim contention: two independent agent browsers click Claim together; exactly one wins and the loser is told', async ({
  browser,
}) => {
  const cust = await signedInContext(browser, USERS.customer1);
  const subject = uniq('Claim race');
  const id = await createCustomerTicket(cust.page, subject, 'Two agents will try to claim this.');
  const a = await signedInContext(browser, USERS.agent1);
  const b = await signedInContext(browser, USERS.agent2);
  await Promise.all([openStaffTicket(a.page, id), openStaffTicket(b.page, id)]);
  const claimA = a.page.getByRole('button', { name: 'Claim ticket' });
  const claimB = b.page.getByRole('button', { name: 'Claim ticket' });
  await expect(claimA).toBeVisible();
  await expect(claimB).toBeVisible();
  await Promise.all([claimA.click(), claimB.click()]);
  const won = (p: Page) => p.getByText('You claimed this ticket.');
  const lost = (p: Page) => p.getByText(/claimed this ticket first/);
  await expect.poll(async () => (await won(a.page).count()) + (await won(b.page).count())).toBe(1);
  await expect
    .poll(async () => (await lost(a.page).count()) + (await lost(b.page).count()))
    .toBe(1);
  // The loser's screen was refreshed from the server: it now shows the winner as assignee and no Claim button.
  const winner = (await won(a.page).count()) ? a : b;
  const loser = winner === a ? b : a;
  const winnerName = winner === a ? 'Arjun Nair' : 'Priya Sharma';
  await expect(loser.page.getByText(`Assigned to ${winnerName}`)).toBeVisible();
  await expect(loser.page.getByRole('button', { name: 'Claim ticket' })).toHaveCount(0);
  await expect(loser.page.getByText(`Only the assignee (${winnerName}) can reply`)).toBeVisible();
  expect(
    await db(
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='TICKET_CLAIMED'`,
            [id],
          )
        ).rows[0].n,
    ),
  ).toBe(1);
  await Promise.all([cust.ctx.close(), a.ctx.close(), b.ctx.close()]);
});

test('full lifecycle through the real UI: note, public reply, wait, customer reply, escalation, resolve, reopen, audit explanation', async ({
  browser,
}) => {
  const cust = await signedInContext(browser, USERS.customer1);
  const agent = await signedInContext(browser, USERS.agent1);
  const subject = uniq('Lifecycle');
  const id = await createCustomerTicket(cust.page, subject, 'My report export is failing.');
  const p = agent.page;
  await openStaffTicket(p, id);
  await p.getByRole('button', { name: 'Claim ticket' }).click();
  await expect(p.getByText('You claimed this ticket.')).toBeVisible();

  // Composer: note mode is distinct, drafts never cross modes.
  await p.getByRole('radio', { name: 'Internal note' }).click();
  await expect(p.getByText(/TEAM ONLY/)).toBeVisible();
  await p.getByLabel('Internal note text').fill('NOTE-ONLY-DRAFT');
  await p.getByRole('radio', { name: 'Public reply' }).click();
  await expect(p.getByLabel('Public reply text')).toHaveValue('');
  await p.getByRole('radio', { name: 'Internal note' }).click();
  await expect(p.getByLabel('Internal note text')).toHaveValue('NOTE-ONLY-DRAFT');
  await p.getByRole('button', { name: 'Add internal note' }).click();
  await expect(p.locator('[data-kind="NOTE"]')).toContainText('NOTE-ONLY-DRAFT');
  await expect(clockCard(p, 'Response')).toContainText('On track'); // a note never satisfies the response SLA

  await p.getByRole('radio', { name: 'Public reply' }).click();
  await p.getByLabel('Public reply text').fill('We are looking into it.');
  await p.getByRole('button', { name: 'Send public reply' }).click();
  await expect(p.getByText('Reply sent to the customer.')).toBeVisible();
  await expect(clockCard(p, 'Response')).toContainText('Completed');
  await expect(clockCard(p, 'Resolution')).toContainText('On track');

  await p.getByRole('radio', { name: 'Request information' }).click();
  await p.getByLabel('Request information text').fill('Which report and date range?');
  await p.getByRole('button', { name: 'Send request & wait' }).click();
  await expect(p.getByText('Waiting on customer').first()).toBeVisible();
  await expect(clockCard(p, 'Resolution')).toContainText('Paused');
  await expect(p.getByRole('radio', { name: 'Public reply' })).toBeDisabled(); // server rule mirrored: only notes while waiting

  // The real customer replies in their own browser.
  await cust.page.goto(`/portal/tickets/${id}`);
  await expect(cust.page.getByText('Which report and date range?')).toBeVisible();
  await cust.page.getByLabel('Reply', { exact: true }).fill('Monthly sales, 1-30 Nov.');
  await cust.page.getByRole('button', { name: 'Send reply' }).click();
  // Wait for the server-confirmed completion signal. The typed text alone is not proof: React mirrors a textarea's
  // value into its text content, so getByText would match before the request has committed.
  await expect(cust.page.getByText('Reply sent.')).toBeVisible();
  await expect(cust.page.getByLabel('Reply', { exact: true })).toHaveValue('');
  await expect(
    cust.page.locator('[role="log"] article', { hasText: 'Monthly sales, 1-30 Nov.' }),
  ).toBeVisible();

  await p.reload();
  await expect(p.getByText('In progress').first()).toBeVisible();
  await expect(clockCard(p, 'Resolution')).toContainText('On track');

  await p.getByLabel('Ticket priority').selectOption('URGENT');
  await p.getByRole('button', { name: 'Apply priority' }).click();
  await expect(p.getByText(/Priority set to Urgent/)).toBeVisible();
  await expect(
    p.locator('#ticket-title').locator('xpath=preceding-sibling::div').getByText('Urgent'),
  ).toBeVisible();

  await p.getByRole('button', { name: 'Resolve…' }).click();
  await p.getByLabel(/Resolution message/).fill('Fixed: export job restarted.');
  await p.getByRole('button', { name: 'Resolve ticket' }).click();
  await expect(p.getByText('Ticket resolved.')).toBeVisible();
  await expect(p.getByText(/Customer can reopen until/)).toBeVisible();
  await expect(p.getByRole('radio', { name: 'Public reply' })).toHaveCount(0); // staff cannot message a resolved ticket

  await cust.page.reload();
  await cust.page
    .getByLabel('Not resolved? Reopen this ticket')
    .fill('Still failing for December.');
  await cust.page.getByRole('button', { name: 'Reopen ticket' }).click();
  await expect(cust.page.getByText('Ticket reopened.')).toBeVisible();
  await expect(cust.page.getByText('Still failing for December.')).toBeVisible();

  // Audit: the reconstructed SLA story names priority change, pause, resume and reopen from immutable events.
  await p.reload();
  await p.getByRole('tab', { name: 'SLA history & audit' }).click();
  const story = p.getByRole('region', { name: /SLA history|Why was this ticket late/ });
  await expect(story).toContainText('Priority Medium → Urgent');
  await expect(story).toContainText('Elapsed time was kept, not reset');
  await expect(story).toContainText('paused while waiting on the customer');
  await expect(story).toContainText('resumed');
  await expect(story).toContainText('Reopened by the customer');
  await expect(p.getByRole('list', { name: 'Audit events' })).not.toContainText('NOTE-ONLY-DRAFT'); // no bodies in audit
  await Promise.all([cust.ctx.close(), agent.ctx.close()]);
});

test('breached ticket is explained: breach recorded by the sweep, late reply keeps history visible', async ({
  browser,
}) => {
  const cust = await signedInContext(browser, USERS.customer2);
  const lead = await signedInContext(browser, USERS.lead);
  const id = await createCustomerTicket(cust.page, uniq('Overdue'), 'Nobody answered me.');
  await db((c) =>
    c.query(
      `UPDATE "SlaClock" SET "deadlineAt" = now() - interval '5 minutes' WHERE "ticketId"=$1 AND kind='RESPONSE'`,
      [id],
    ),
  );
  const p = lead.page;
  await openStaffTicket(p, id);
  await expect(clockCard(p, 'Response')).toContainText('Breached');
  await expect(clockCard(p, 'Response')).toContainText('not been recorded yet'); // read-only projection: detected, not recorded
  await p.getByRole('button', { name: 'Run SLA sweep' }).click();
  await p.getByRole('button', { name: 'Run sweep now' }).click();
  await expect(p.getByRole('status').filter({ hasText: 'Sweep finished' })).toBeVisible();
  expect(Number(await p.getByTestId('sweep-processed').textContent())).toBeGreaterThanOrEqual(1);
  await p.keyboard.press('Escape');
  await p.reload();
  await expect(clockCard(p, 'Response')).toContainText('First breached');
  await expect(clockCard(p, 'Response')).not.toContainText('not been recorded yet');
  await p.getByRole('tab', { name: 'SLA history & audit' }).click();
  await expect(p.getByRole('region', { name: 'Why was this ticket late?' })).toContainText(
    'SLA breached',
  );
  await p.goto('/staff?view=breached');
  await expect(
    p.getByRole('list', { name: 'Breached tickets' }).getByRole('link').first(),
  ).toBeVisible();
  await Promise.all([cust.ctx.close(), lead.ctx.close()]);
});

test('customer follow-up after the reopen window creates a linked ticket and navigates to it', async ({
  browser,
}) => {
  const cust = await signedInContext(browser, USERS.customer1);
  const agent = await signedInContext(browser, USERS.agent1);
  const subject = uniq('Linked');
  const id = await createCustomerTicket(cust.page, subject, 'Please help.');
  await openStaffTicket(agent.page, id);
  await agent.page.getByRole('button', { name: 'Claim ticket' }).click();
  await agent.page.getByRole('button', { name: 'Resolve…' }).click();
  await agent.page.getByLabel(/Resolution message/).fill('Done.');
  await agent.page.getByRole('button', { name: 'Resolve ticket' }).click();
  await expect(agent.page.getByText('Ticket resolved.')).toBeVisible();
  await db((c) =>
    c.query(
      `UPDATE "Ticket" SET "resolvedAt" = now() - interval '9 days', "reopenUntil" = now() - interval '2 days' WHERE id=$1`,
      [id],
    ),
  );
  await cust.page.goto(`/portal/tickets/${id}`);
  await cust.page
    .getByLabel('Not resolved? Reopen this ticket')
    .fill('It broke again after the window.');
  await cust.page.getByRole('button', { name: 'Reopen ticket' }).click();
  await expect(cust.page.getByText(/new linked ticket with your message/)).toBeVisible();
  await expect(cust.page).not.toHaveURL(new RegExp(id));
  await expect(cust.page.getByText('It broke again after the window.')).toBeVisible();
  await cust.page.getByRole('link', { name: 'View the earlier ticket' }).click();
  await expect(cust.page.getByText('Closed', { exact: true }).first()).toBeVisible();
  await Promise.all([cust.ctx.close(), agent.ctx.close()]);
});

test('authorization in the UI and API: agents have no sweep; direct API calls are refused', async ({
  browser,
}) => {
  const agent = await signedInContext(browser, USERS.agent1);
  await expect(agent.page.getByRole('button', { name: 'Run SLA sweep' })).toHaveCount(0);
  const status = await agent.page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/auth/csrf')).json();
    const r = await fetch('/api/admin/run-sla-sweep', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': crypto.randomUUID() },
    });
    return r.status;
  });
  expect(status).toBe(403);
  const cust = await signedInContext(browser, USERS.customer1);
  await cust.page.goto('/staff');
  await expect(cust.page).toHaveURL(/\/portal/);
  expect((await cust.page.request.get('/api/tickets')).status()).toBe(403);
  await Promise.all([agent.ctx.close(), cust.ctx.close()]);
});

test('queue views and filters use the server: unassigned, my tickets, waiting, priority', async ({
  browser,
}) => {
  const agent = await signedInContext(browser, USERS.agent1);
  const p = agent.page;
  await p
    .getByRole('navigation', { name: 'Ticket views' })
    .getByRole('link', { name: 'Unassigned', exact: true })
    .click();
  const items = p.getByRole('list', { name: 'Unassigned tickets' }).getByRole('link');
  await expect(items.first()).toBeVisible();
  for (const t of await items.all()) await expect(t).toContainText('Unassigned');
  await p.getByLabel('Filter by priority').selectOption('URGENT');
  await expect(p.getByText('No tickets here')).toBeVisible();
  await p.getByLabel('Filter by priority').selectOption('');
  await p
    .getByRole('navigation', { name: 'Ticket views' })
    .getByRole('link', { name: 'Waiting on customer', exact: true })
    .click();
  await expect(
    p.getByRole('list', { name: 'Waiting on customer tickets' }).getByRole('link').first(),
  ).toBeVisible();
  await p
    .getByRole('navigation', { name: 'Ticket views' })
    .getByRole('link', { name: 'My tickets', exact: true })
    .click();
  for (const t of await p.getByRole('list', { name: 'My tickets tickets' }).getByRole('link').all())
    await expect(t).toContainText('Arjun Nair');
  await agent.ctx.close();
});
