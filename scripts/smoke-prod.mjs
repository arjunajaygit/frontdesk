// Production-mode smoke test against a RUNNING stack (container or any deployment). No secrets are printed.
//   node scripts/smoke-prod.mjs --base http://localhost:8080 --creds .local/credentials.prod-compose.json
import { readFileSync } from 'node:fs';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const BASE = arg('--base', 'http://localhost:8080').replace(/\/$/, '');
const CREDS = JSON.parse(
  readFileSync(arg('--creds', '.local/credentials.prod-compose.json'), 'utf8'),
);
const ORIGIN = arg('--origin', BASE);
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) failures++;
};

class Session {
  jar = new Map();
  csrf = '';
  context = ''; // opaque session context echoed as X-Session-Context (final audit H02)
  async req(path, { method = 'GET', body, headers = {}, origin = ORIGIN } = {}) {
    const h = { ...headers };
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.context) h['X-Session-Context'] = this.context;
    if (method !== 'GET') {
      if (origin) h.Origin = origin;
      if (this.csrf) h['X-CSRF-Token'] = this.csrf;
      h['Idempotency-Key'] ??= crypto.randomUUID();
    }
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      if (/;\s*expires=Thu, 01 Jan 1970|Max-Age=0/i.test(c)) this.jar.delete(k);
      else this.jar.set(k, v.join('='));
    }
    return res;
  }
  async login(email, password) {
    this.csrf = (await (await this.req('/api/auth/csrf?purpose=login')).json()).csrfToken;
    const r = await this.req('/api/auth/login', { method: 'POST', body: { email, password } });
    if (r.status === 200) {
      const b = await r.clone().json();
      this.csrf = b.csrfToken;
      this.context = b.sessionContext;
    }
    return r;
  }
}

// --- static app + headers
const home = await fetch(BASE + '/');
const html = await home.text();
check('GET / serves the SPA shell', home.status === 200 && html.includes('<div id="root">'));
const csp = home.headers.get('content-security-policy') ?? '';
check(
  'page CSP: script-src self, no inline scripts, frame-ancestors none',
  /script-src 'self'/.test(csp) &&
    !/script-src[^;]*unsafe-inline/.test(csp) &&
    /frame-ancestors 'none'/.test(csp),
  csp,
);
check(
  'deep link falls back to the SPA',
  (await (await fetch(BASE + '/portal/tickets/x')).text()).includes('<div id="root">'),
);
const asset = html.match(/\/assets\/[^"']+\.js/)?.[0];
const a = await fetch(BASE + (asset ?? '/assets/none.js'));
check(
  'hashed asset is immutable-cacheable',
  a.status === 200 && /immutable/.test(a.headers.get('cache-control') ?? ''),
);
const miss = await fetch(BASE + '/assets/missing.js');
check(
  'missing asset is a plain 404 (not the SPA shell)',
  miss.status === 404 && !(await miss.text()).includes('<div id="root">'),
);

// --- API contract basics
const health = await fetch(BASE + '/api/healthz');
check(
  'healthz 200 + no-store + strict API CSP',
  health.status === 200 &&
    health.headers.get('cache-control') === 'no-store' &&
    /default-src 'none'/.test(health.headers.get('content-security-policy') ?? ''),
);
const ready = await fetch(BASE + '/api/readyz');
const readyBody = await ready.text();
check(
  'readyz ready and reveals no topology',
  ready.status === 200 && readyBody === '{"ok":true}',
  readyBody,
);
const nf = await fetch(BASE + '/api/no-such-route');
const nfj = await nf.json().catch(() => ({}));
check('unknown /api route -> JSON 404, not HTML', nf.status === 404 && nfj.code === 'NOT_FOUND');
check(
  'protected API requires auth (401, no-store)',
  (await fetch(BASE + '/api/tickets')).status === 401,
);
check(
  'no CORS for foreign origins',
  (await fetch(BASE + '/api/healthz', { headers: { Origin: 'https://evil.example' } })).headers.get(
    'access-control-allow-origin',
  ) === null,
);

// --- authentication, cookies, CSRF, Origin
const staff = new Session();
const bad = await staff.login('meera.iyer@arvo.example', 'definitely-wrong');
check('wrong password -> 401', bad.status === 401);
const ok = await new Session();
const loginRes = await ok.login('meera.iyer@arvo.example', CREDS['meera.iyer@arvo.example']);
check('staff login 200', loginRes.status === 200, String(loginRes.status));
check(
  'cookies set: access/refresh/csrf',
  ['frontdesk_access', 'frontdesk_refresh', 'frontdesk_csrf'].every((c) => ok.jar.has(c)),
);
const rawLogin = await fetch(BASE + '/api/auth/csrf');
check('csrf endpoint is no-store', rawLogin.headers.get('cache-control') === 'no-store');
const list = await ok.req('/api/tickets?limit=5');
check(
  'staff list 200 with no-store + Vary: Cookie',
  list.status === 200 &&
    list.headers.get('cache-control') === 'no-store' &&
    /Cookie/.test(list.headers.get('vary') ?? ''),
);
const noCsrf = await new Session();
noCsrf.jar = new Map(ok.jar);
check(
  'mutation without CSRF -> 403',
  (await noCsrf.req('/api/admin/run-sla-sweep', { method: 'POST' })).status === 403,
);
check(
  'mutation with foreign Origin -> 403',
  (await ok.req('/api/admin/run-sla-sweep', { method: 'POST', origin: 'https://evil.example' }))
    .status === 403,
);
check(
  'mutation with no Origin -> 403',
  (await ok.req('/api/admin/run-sla-sweep', { method: 'POST', origin: '' })).status === 403,
);

// --- authorization + privacy spot check
const cust = new Session();
check(
  'customer login 200',
  (await cust.login('aarav.menon@customer.example', CREDS['aarav.menon@customer.example']))
    .status === 200,
);
check('customer cannot reach staff API (403)', (await cust.req('/api/tickets')).status === 403);
const tickets = await cust.req('/api/customer/tickets?limit=50');
const items = (await tickets.json()).items ?? [];
const fd010 = items.find((t) => t.subject.startsWith('[FD-010]'));
if (fd010) {
  const detail = await cust.req(`/api/customer/tickets/${fd010.id}`);
  const text = await detail.text();
  check(
    'customer ticket detail omits private notes',
    detail.status === 200 &&
      !text.includes('PRIVATE-NOTE-MARKER') &&
      !/"visibility"|"kind"/.test(text),
  );
  const csv = await (await cust.req(`/api/customer/tickets/${fd010.id}/export?format=csv`)).text();
  check(
    'customer CSV export omits private notes',
    csv.includes('Updated. You will see it') && !csv.includes('PRIVATE-NOTE-MARKER'),
  );
} else
  check(
    'seeded customer ticket FD-010 present',
    false,
    'seed the stack first (docker compose --profile ops run --rm seed)',
  );
// Real revocation test (final audit H01): replay the ORIGINAL credentials after logout, not an anonymous client.
const staleTab = new Session();
staleTab.jar = new Map(ok.jar);
staleTab.csrf = ok.csrf;
staleTab.context = ok.context;
const captured = {
  access: ok.jar.get('frontdesk_access'),
  refresh: ok.jar.get('frontdesk_refresh'),
  csrf: ok.csrf,
};
const logout = await ok.req('/api/auth/logout', { method: 'POST' });
check('logout 200', logout.status === 200, String(logout.status));
const replayAccess = new Session();
replayAccess.jar.set('frontdesk_access', captured.access);
check(
  'original access cookie rejected after logout (401)',
  (await replayAccess.req('/api/tickets')).status === 401,
);
const replayRefresh = new Session();
replayRefresh.jar.set('frontdesk_refresh', captured.refresh);
replayRefresh.jar.set('frontdesk_csrf', captured.csrf);
replayRefresh.csrf = captured.csrf;
check(
  'original refresh cookie rejected after logout (401)',
  (await replayRefresh.req('/api/auth/refresh', { method: 'POST' })).status === 401,
);
// Stale tab (H02): the SAME browser signs in as a customer; the old staff tab's mutation must be refused.
const customerEmail = Object.keys(CREDS).find((e) => e.endsWith('@customer.example'));
const sharedJar = new Session();
await sharedJar.login(
  Object.keys(CREDS).find((e) => e.endsWith('@arvo.example')),
  CREDS[Object.keys(CREDS).find((e) => e.endsWith('@arvo.example'))],
);
const oldContext = sharedJar.context;
await sharedJar.login(customerEmail, CREDS[customerEmail]);
sharedJar.context = oldContext; // the stale tab still believes it is the staff session
const stale = await sharedJar.req('/api/customer/tickets', {
  method: 'POST',
  body: { subject: 'smoke stale tab', body: 'must not persist' },
});
check(
  'stale tab mutation through a replacement session -> 409 SESSION_CHANGED',
  stale.status === 409,
  String(stale.status),
);
void staleTab;

console.log(failures ? `\n${failures} smoke check(s) FAILED` : '\nAll smoke checks passed');
process.exit(failures ? 1 : 0);
