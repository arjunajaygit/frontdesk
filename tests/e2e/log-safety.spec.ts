import { spawn, type ChildProcess } from 'node:child_process';
import { expect, request, test } from '@playwright/test';
import { E2E_PASSWORD, USERS, WEB_ORIGIN, apiEnv } from './helpers/env';

/**
 * Log safety, proven at runtime: the REAL compiled server (apps/api/dist, the production logger configuration)
 * runs at the most verbose level while a full credential lifecycle happens over HTTP. Its entire stdout/stderr
 * must contain no password, no cookie or token value, no CSRF token and no session context, and the redaction
 * marker must prove the sensitive headers were actually seen and censored (not merely absent).
 */
const PORT = 3197;
const BASE = `http://localhost:${PORT}`;
let api: ChildProcess;
let logs = '';

test.beforeAll(async () => {
  api = spawn(process.execPath, ['apps/api/dist/main.js'], {
    env: { ...apiEnv(), PORT: String(PORT), LOG_LEVEL: 'trace' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout!.on('data', (d) => (logs += d.toString()));
  api.stderr!.on('data', (d) => (logs += d.toString()));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/readyz`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`log-safety API did not become ready:\n${logs.slice(-2000)}`);
});
test.afterAll(() => {
  api?.kill('SIGTERM');
});

test('verbose server logs never contain passwords, cookies, tokens, CSRF values or session contexts', async () => {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { Origin: WEB_ORIGIN } });
  const secrets: string[] = [E2E_PASSWORD];
  const label = new Map<string, string>([[E2E_PASSWORD, 'password']]);
  const add = (kind: string, v: string) => {
    secrets.push(v);
    label.set(v, kind);
  };
  const wrong = 'Wrong-Passw0rd-must-not-be-logged';
  add('wrong password', wrong);

  // Failed login (a password that is not the account's) and a successful one.
  let csrf = (await (await ctx.get('/api/auth/csrf?purpose=login')).json()).csrfToken as string;
  add('pre-login CSRF token', csrf);
  expect(
    (
      await ctx.post('/api/auth/login', {
        headers: { 'X-CSRF-Token': csrf },
        data: { email: USERS.agent1, password: wrong },
      })
    ).status(),
  ).toBe(401);
  csrf = (await (await ctx.get('/api/auth/csrf?purpose=login')).json()).csrfToken as string;
  add('pre-login CSRF token', csrf);
  const login = await ctx.post('/api/auth/login', {
    headers: { 'X-CSRF-Token': csrf },
    data: { email: USERS.agent1, password: E2E_PASSWORD },
  });
  expect(login.status()).toBe(200);
  csrf = (await login.json()).csrfToken as string;
  add('session CSRF token', csrf);

  // Authenticated traffic that carries every sensitive header: cookies, CSRF, session context, idempotency key.
  const me = await (await ctx.get('/api/auth/me')).json();
  const sessionContext = me.sessionContext as string;
  add('session context', sessionContext);
  const auth = { 'X-CSRF-Token': csrf, 'X-Session-Context': sessionContext };
  expect((await ctx.get('/api/tickets?scope=ALL', { headers: auth })).status()).toBe(200);
  for (const c of (await ctx.storageState()).cookies)
    if (c.value.length >= 8) add(`cookie ${c.name} (pre-refresh)`, c.value);
  const refresh = await ctx.post('/api/auth/refresh', { headers: auth });
  expect(refresh.status()).toBe(200);
  const rb = await refresh.json();
  const rotated = rb.csrfToken as string;
  const rotatedContext = rb.sessionContext as string;
  add('rotated CSRF token', rotated);
  add('rotated session context', rotatedContext);
  const state = await ctx.storageState();
  for (const c of state.cookies) if (c.value.length >= 8) add(`cookie ${c.name}`, c.value);
  expect(state.cookies.map((c) => c.name).sort()).toEqual(
    expect.arrayContaining(['frontdesk_access', 'frontdesk_refresh']),
  );
  expect(
    (
      await ctx.post('/api/auth/logout', {
        headers: { 'X-CSRF-Token': rotated, 'X-Session-Context': rotatedContext },
      })
    ).status(),
  ).toBe(200);
  await ctx.dispose();
  await new Promise((r) => setTimeout(r, 500)); // let the async log destination flush

  expect(logs.length).toBeGreaterThan(1000); // trace logging really ran
  expect(logs).toContain('[REDACTED]'); // sensitive headers were present and censored
  const leaked = secrets.filter((v) => logs.includes(v)).map((v) => label.get(v));
  expect(leaked, 'secret values found in the server logs').toEqual([]);
  expect(logs).not.toMatch(/"password"\s*:/i);
});
