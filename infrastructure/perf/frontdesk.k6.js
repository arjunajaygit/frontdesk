// k6 workloads for the ISOLATED local production-like stack (synthetic seeded accounts only).
// Real security path: CSRF bootstrap -> login (HttpOnly cookies) -> Origin + X-CSRF-Token + Idempotency-Key on
// every mutation. Nothing is disabled for benchmarking: the per-IP API limit (default 600/min) applies, and all
// k6 VUs share ONE source IP, so 429s in the stress scenario are the limiter working, not failures.
//
//   k6 run -e SCENARIO=smoke|mixed|contention|stress -e BASE=http://localhost:8080 \
//          -e CREDS=.local/credentials.prod-compose.json infrastructure/perf/frontdesk.k6.js
// Passwords are read from the git-ignored credentials file and never logged.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.BASE || 'http://localhost:8080';
const SCENARIO = __ENV.SCENARIO || 'smoke';
const CREDS = JSON.parse(open(__ENV.CREDS || '../../.local/credentials.prod-compose.json'));
const STAFF = Object.keys(CREDS)
  .filter((e) => e.endsWith('@arvo.example'))
  .sort();
const CUSTOMERS = Object.keys(CREDS)
  .filter((e) => e.endsWith('@customer.example'))
  .sort();
const CONTENTION_TICKETS = Number(__ENV.CONTENTION_TICKETS || 10);

const unexpected = new Counter('unexpected_responses'); // 5xx or any status the scenario does not expect
const unexpectedRate = new Rate('unexpected_rate');
const rateLimited = new Counter('rate_limited_429'); // intentional limiter responses
const claimWon = new Counter('claims_won');
const claimConflict = new Counter('claims_conflict_409'); // expected losers
const readLatency = new Trend('read_latency', true);
const writeLatency = new Trend('write_latency', true);

const SCENARIOS = {
  smoke: { health: { executor: 'constant-vus', vus: 1, duration: '20s', exec: 'health' } },
  // Assessment context: 9 agents + a few customers; ~40 tickets/day compressed into a busy 3-minute window.
  mixed: {
    agents: { executor: 'constant-vus', vus: 9, duration: '3m', exec: 'agent' },
    customers: { executor: 'constant-vus', vus: 3, duration: '3m', exec: 'customer' },
  },
  // 9 agents race for the same tickets, ticket by ticket.
  contention: {
    claim: {
      executor: 'per-vu-iterations',
      vus: 9,
      iterations: CONTENTION_TICKETS,
      exec: 'contend',
      maxDuration: '2m',
    },
  },
  // Modest burst without think time: shows latency under load AND that the per-IP limiter holds.
  stress: {
    burst: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '20s', target: 20 },
        { duration: '40s', target: 20 },
        { duration: '10s', target: 0 },
      ],
      exec: 'agentNoThink',
    },
  },
};
export const options = {
  scenarios: SCENARIOS[SCENARIO],
  noCookiesReset: true, // a VU keeps its signed-in session across iterations (k6 resets cookies by default)
  thresholds: {
    unexpected_rate: ['rate<0.01'],
    checks: ['rate>0.99'],
    ...(SCENARIO === 'contention'
      ? {
          claims_won: [`count==${CONTENTION_TICKETS}`],
          claims_conflict_409: [`count==${CONTENTION_TICKETS * 8}`],
        }
      : {}),
    ...(SCENARIO === 'mixed' ? { read_latency: ['p(95)<500'], write_latency: ['p(95)<1000'] } : {}),
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function uuid() {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

let session = null; // per VU
function track(res, expected, kind) {
  const ok = expected.includes(res.status);
  if (res.status === 429) rateLimited.add(1);
  const bad = !ok && res.status !== 429;
  unexpected.add(bad ? 1 : 0);
  unexpectedRate.add(bad);
  (kind === 'write' ? writeLatency : readLatency).add(res.timings.duration);
  return ok;
}
function login(email) {
  const jar = http.cookieJar();
  jar.clear(BASE);
  const c = http.get(`${BASE}/api/auth/csrf?purpose=login`, {
    tags: { name: 'GET /api/auth/csrf' },
  });
  const csrf = c.json('csrfToken');
  const r = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email, password: CREDS[email] }), {
    headers: { 'Content-Type': 'application/json', Origin: BASE, 'X-CSRF-Token': csrf },
    tags: { name: 'POST /api/auth/login' },
  });
  check(r, { 'login 200': (x) => x.status === 200 });
  return {
    email,
    csrf: r.status === 200 ? r.json('csrfToken') : csrf,
    context: r.status === 200 ? r.json('sessionContext') : '',
  };
}
function get(path, name, expected = [200]) {
  const headers = session && session.context ? { 'X-Session-Context': session.context } : {};
  const r = http.get(`${BASE}${path}`, { tags: { name }, headers });
  track(r, expected, 'read');
  return r;
}
function send(method, path, name, body, expected) {
  const r = http.request(
    method,
    `${BASE}${path}`,
    body === undefined ? null : JSON.stringify(body),
    {
      headers: {
        'Content-Type': 'application/json',
        Origin: BASE,
        'X-CSRF-Token': session.csrf,
        'X-Session-Context': session.context,
        'Idempotency-Key': uuid(),
      },
      tags: { name },
    },
  );
  track(r, expected, 'write');
  return r;
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ensure = (email) => {
  if (!session) session = login(email);
};

export function health() {
  check(get('/api/healthz', 'GET /api/healthz'), { 'healthz 200': (r) => r.status === 200 });
  check(get('/api/readyz', 'GET /api/readyz'), { 'readyz 200': (r) => r.status === 200 });
  sleep(0.5);
}

function agentIteration(think) {
  ensure(STAFF[(exec.vu.idInTest - 1) % STAFF.length]);
  const list = get('/api/tickets?limit=25', 'GET /api/tickets');
  check(list, { 'staff list 200': (r) => r.status === 200 });
  const items = list.status === 200 ? list.json('items') : [];
  if (items.length) {
    const t = pick(items);
    check(get(`/api/tickets/${t.id}`, 'GET /api/tickets/{id}'), {
      'detail 200': (r) => r.status === 200,
    });
    const page = get(`/api/tickets/${t.id}/messages?limit=50`, 'GET /api/tickets/{id}/messages');
    const next = page.status === 200 ? page.json('nextCursor') : null;
    if (next)
      get(
        `/api/tickets/${t.id}/messages?limit=50&cursor=${encodeURIComponent(next)}`,
        'GET /api/tickets/{id}/messages',
      );
  }
  if (think) sleep(1 + Math.random() * 2);
  const open = get('/api/tickets?scope=UNASSIGNED&limit=10', 'GET /api/tickets?scope=UNASSIGNED');
  const unassigned = open.status === 200 ? open.json('items') : [];
  if (unassigned.length && Math.random() < 0.5) {
    const t = pick(unassigned);
    const c = send(
      'POST',
      `/api/tickets/${t.id}/claim`,
      'POST /api/tickets/{id}/claim',
      undefined,
      [200, 409],
    );
    if (c.status === 200) {
      claimWon.add(1);
      const rep = send(
        'POST',
        `/api/tickets/${t.id}/replies`,
        'POST /api/tickets/{id}/replies',
        { body: 'Thanks, looking into this now.' },
        [201, 200],
      );
      check(rep, { 'reply accepted': (r) => r.status === 201 || r.status === 200 });
      send(
        'POST',
        `/api/tickets/${t.id}/notes`,
        'POST /api/tickets/{id}/notes',
        { body: 'Internal: checked billing system.' },
        [201, 200],
      );
    } else if (c.status === 409) claimConflict.add(1);
  }
  if (think) sleep(1 + Math.random() * 2);
}
export const agent = () => agentIteration(true);
export const agentNoThink = () => agentIteration(false);

export function customer() {
  ensure(CUSTOMERS[(exec.vu.idInTest - 1) % CUSTOMERS.length]);
  const list = get('/api/customer/tickets?limit=50', 'GET /api/customer/tickets');
  check(list, { 'customer list 200': (r) => r.status === 200 });
  const items = list.status === 200 ? list.json('items') : [];
  if (items.length)
    get(`/api/customer/tickets/${pick(items).id}`, 'GET /api/customer/tickets/{id}');
  if (Math.random() < 0.25) {
    const r = send(
      'POST',
      '/api/customer/tickets',
      'POST /api/customer/tickets',
      { subject: 'Load test: invoice question', body: 'Synthetic k6 ticket.' },
      [201],
    );
    check(r, { 'ticket created': (x) => x.status === 201 });
  }
  sleep(4 + Math.random() * 4);
}

export function setup() {
  if (SCENARIO !== 'contention') return {};
  session = login(CUSTOMERS[0]);
  const ids = [];
  for (let i = 0; i < CONTENTION_TICKETS; i++) {
    const r = send(
      'POST',
      '/api/customer/tickets',
      'POST /api/customer/tickets',
      { subject: `Contention ${i}`, body: 'Synthetic claim race.' },
      [201],
    );
    ids.push(r.json('id'));
  }
  session = null;
  return { ids };
}
export function contend(data) {
  ensure(STAFF[(exec.vu.idInTest - 1) % STAFF.length]);
  const id = data.ids[exec.vu.iterationInScenario];
  sleep(Math.max(0, 1 - (Date.now() % 1000) / 1000)); // align VUs on the next second boundary to overlap requests
  const r = send(
    'POST',
    `/api/tickets/${id}/claim`,
    'POST /api/tickets/{id}/claim',
    undefined,
    [200, 409],
  );
  if (r.status === 200) claimWon.add(1);
  if (r.status === 409) claimConflict.add(1);
  check(r, { 'claim is 200 or 409': (x) => x.status === 200 || x.status === 409 });
}
