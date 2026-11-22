// Deployed workflow verification against a LIVE deployment (real HTTPS, real sessions, CSRF, session context).
// Creates data ONLY for the synthetic verification customer (reviewer scenarios FD-001..FD-015 are never touched).
// Persisted truth (claims, audit, links) is checked in PostgreSQL through OWNER_URL; time-dependent paths
// (expired reopen window, overdue waiting reply, auto-close) are set up by moving stored deadlines into the past
// on the verification tickets only, exactly as the integration tests do. No secrets are printed.
//   OWNER_URL=... node scripts/hosted-verify.mjs --base https://<host> --creds .local/credentials.hosted.json
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const arg = (n, d) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : d);
const BASE = arg('--base').replace(/\/$/, '');
const CREDS = JSON.parse(readFileSync(arg('--creds'), 'utf8'));
const VERIFY_CUSTOMER = 'verification.bot@customer.example';
const STAFF = Object.keys(CREDS)
  .filter((e) => e.endsWith('@arvo.example'))
  .sort();
const LEAD = 'meera.iyer@arvo.example';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
  if (!ok) failures++;
};

class Session {
  jar = new Map();
  csrf = '';
  context = '';
  async req(path, { method = 'GET', body } = {}) {
    const h = { Accept: 'application/json' };
    if (this.jar.size) h.Cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.context) h['X-Session-Context'] = this.context;
    if (method !== 'GET')
      Object.assign(h, {
        Origin: BASE,
        'X-CSRF-Token': this.csrf,
        'Idempotency-Key': randomUUID(),
      });
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const [k, ...v] = pair.split('=');
      if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(c)) this.jar.delete(k);
      else this.jar.set(k, v.join('='));
    }
    let json = null;
    const text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      /* csv or empty */
    }
    return { status: res.status, json, text };
  }
  async login(email) {
    this.csrf = (await this.req('/api/auth/csrf?purpose=login')).json.csrfToken;
    const r = await this.req('/api/auth/login', {
      method: 'POST',
      body: { email, password: CREDS[email] },
    });
    if (r.status === 200) {
      this.csrf = r.json.csrfToken;
      this.context = r.json.sessionContext;
    }
    return r;
  }
}
const login = async (email) => {
  const s = new Session();
  const r = await s.login(email);
  if (r.status !== 200)
    throw new Error(`login failed for a ${email.split('@')[1]} account: ${r.status}`);
  return s;
};

const db = new pg.Client({
  connectionString: process.env.OWNER_URL,
  ssl: { rejectUnauthorized: false },
});
await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const stamp = new Date().toISOString().replace(/[:.]/g, '');
const marker = `VERIFY-PRIVATE-${randomUUID()}`;

const cust = await login(VERIFY_CUSTOMER);
const agents = await Promise.all(STAFF.map((e) => login(e)));
const lead = agents[STAFF.indexOf(LEAD)];
const clock = (t, kind) => t.clocks?.find((c) => c.kind === kind) ?? {};

// 1. Intake + 9-agent claim contention
const t1 = await cust.req('/api/customer/tickets', {
  method: 'POST',
  body: { subject: `[verification ${stamp}] claim race`, body: 'Synthetic deployment check.' },
});
check('customer intake 201', t1.status === 201, String(t1.status));
const id = t1.json.id;
const claims = await Promise.all(
  agents.map((a) => a.req(`/api/tickets/${id}/claim`, { method: 'POST' })),
);
const statuses = claims.map((r) => r.status);
check(
  '9-agent claim race: exactly one 200',
  statuses.filter((s) => s === 200).length === 1,
  statuses.join(','),
);
check(
  '9-agent claim race: eight 409',
  statuses.filter((s) => s === 409).length === 8,
  statuses.join(','),
);
check(
  'DB: exactly one TICKET_CLAIMED audit row',
  (
    await q(
      `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='TICKET_CLAIMED'`,
      [id],
    )
  )[0].n === 1,
);
const winner = agents[statuses.indexOf(200)];

// 2. Public reply completes the response clock; resolution keeps running (independent clocks)
const rep = await winner.req(`/api/tickets/${id}/replies`, {
  method: 'POST',
  body: { body: 'We are on it (verification).' },
});
check('assignee public reply 200 (contract)', rep.status === 200, String(rep.status));
let staffView = (await winner.req(`/api/tickets/${id}`)).json;
check(
  'independent clocks: response COMPLETED, resolution RUNNING',
  clock(staffView, 'RESPONSE').state === 'COMPLETED' &&
    clock(staffView, 'RESOLUTION').state === 'RUNNING',
  JSON.stringify(staffView.clocks?.map((c) => [c.kind, c.state])),
);

// 3. Private note never reaches the customer (detail, timeline, JSON and CSV export)
const note = await winner.req(`/api/tickets/${id}/notes`, {
  method: 'POST',
  body: { body: marker },
});
check('internal note 200 (contract)', note.status === 200, String(note.status));
check(
  'staff detail shows the internal note',
  (await winner.req(`/api/tickets/${id}`)).text.includes(marker),
);
for (const [name, path] of [
  ['customer detail', `/api/customer/tickets/${id}`],
  ['customer timeline', `/api/customer/tickets/${id}/messages?limit=100`],
  ['customer JSON export', `/api/customer/tickets/${id}/export?format=json`],
  ['customer CSV export', `/api/customer/tickets/${id}/export?format=csv`],
]) {
  const r = await cust.req(path);
  check(
    `${name}: 200 and no private note`,
    r.status === 200 && !r.text.includes(marker),
    String(r.status),
  );
}
const other = await login(
  Object.keys(CREDS).find((e) => e.endsWith('@customer.example') && e !== VERIFY_CUSTOMER),
);
check(
  'another customer gets 404 for this ticket (ownership)',
  (await other.req(`/api/customer/tickets/${id}`)).status === 404,
);

// 4. Waiting pauses resolution; customer reply resumes it
const wait = await winner.req(`/api/tickets/${id}/wait`, {
  method: 'POST',
  body: { body: 'Which invoice number?' },
});
staffView = (await winner.req(`/api/tickets/${id}`)).json;
check(
  'request info -> WAITING, resolution PAUSED',
  wait.status === 200 &&
    staffView.status === 'WAITING' &&
    clock(staffView, 'RESOLUTION').state === 'PAUSED',
  `${wait.status} ${staffView.status} ${clock(staffView, 'RESOLUTION').state}`,
);
const creply = await cust.req(`/api/customer/tickets/${id}/replies`, {
  method: 'POST',
  body: { body: 'Invoice 42.' },
});
staffView = (await winner.req(`/api/tickets/${id}`)).json;
check(
  'customer reply -> SAME_TICKET, resumed',
  creply.status === 200 &&
    creply.json?.outcome === 'SAME_TICKET' &&
    clock(staffView, 'RESOLUTION').state === 'RUNNING',
  `${creply.status} ${creply.json?.outcome}`,
);

// 5. Priority escalation keeps consumed time
const pr = await winner.req(`/api/tickets/${id}/priority`, {
  method: 'PATCH',
  body: { priority: 'URGENT' },
});
check(
  'priority change to URGENT 200',
  pr.status === 200 && pr.json?.priority === 'URGENT',
  `${pr.status} ${pr.json?.priority}`,
);
check(
  'DB: PRIORITY_CHANGED audit recorded',
  (
    await q(
      `SELECT count(*)::int n FROM audit_logs WHERE "ticketId"=$1 AND action='PRIORITY_CHANGED'`,
      [id],
    )
  )[0].n === 1,
);

// 6. Resolve -> reopen within the window -> resolve -> expired window -> new linked ticket
const res1 = await winner.req(`/api/tickets/${id}/resolve`, {
  method: 'POST',
  body: { body: 'Fixed.' },
});
check(
  'resolve 200',
  res1.status === 200 && res1.json?.status === 'RESOLVED',
  `${res1.status} ${res1.json?.status}`,
);
const reo = await cust.req(`/api/customer/tickets/${id}/reopen`, {
  method: 'POST',
  body: { body: 'Still broken.' },
});
check(
  'customer reopen inside 7 days -> same ticket reopened',
  reo.status === 200 && reo.json?.outcome === 'SAME_TICKET',
  `${reo.status} ${reo.json?.outcome}`,
);
await winner.req(`/api/tickets/${id}/resolve`, { method: 'POST', body: { body: 'Fixed again.' } });
await q(
  `UPDATE "Ticket" SET "resolvedAt" = now() - interval '9 days', "reopenUntil" = now() - interval '2 days' WHERE id=$1 AND subject LIKE '[verification%'`,
  [id],
);
const reo2 = await cust.req(`/api/customer/tickets/${id}/reopen`, {
  method: 'POST',
  body: { body: 'It is back.' },
});
check(
  'reopen after the window -> NEW_LINKED_TICKET (201)',
  reo2.status === 201 &&
    reo2.json?.outcome === 'NEW_LINKED_TICKET' &&
    reo2.json?.previousTicketId === id,
  `${reo2.status} ${reo2.json?.outcome}`,
);
const childId = reo2.json?.ticket?.id;
check(
  'DB: child linked to parent',
  (await q(`SELECT "parentTicketId" p FROM "Ticket" WHERE id=$1`, [childId]))[0]?.p === id,
);

// 7. Overdue waiting reply -> new linked ticket
const t2 = (
  await cust.req('/api/customer/tickets', {
    method: 'POST',
    body: { subject: `[verification ${stamp}] overdue wait`, body: 'Synthetic.' },
  })
).json.id;
await winner.req(`/api/tickets/${t2}/claim`, { method: 'POST' });
await winner.req(`/api/tickets/${t2}/wait`, { method: 'POST', body: { body: 'Need logs.' } });
await q(
  `UPDATE "Ticket" SET "waitingSince" = now() - interval '10 days', "waitingCloseDueAt" = now() - interval '1 minute' WHERE id=$1 AND subject LIKE '[verification%'`,
  [t2],
);
const late = await cust.req(`/api/customer/tickets/${t2}/replies`, {
  method: 'POST',
  body: { body: 'Here are the logs (late).' },
});
check(
  'reply after the waiting cutoff -> NEW_LINKED_TICKET',
  late.status === 201 && late.json?.outcome === 'NEW_LINKED_TICKET',
  `${late.status} ${late.json?.outcome}`,
);

// 8. Auto-close by an authorised manual sweep (lead) on an overdue waiting ticket
const t3 = (
  await cust.req('/api/customer/tickets', {
    method: 'POST',
    body: { subject: `[verification ${stamp}] auto-close`, body: 'Synthetic.' },
  })
).json.id;
await winner.req(`/api/tickets/${t3}/claim`, { method: 'POST' });
await winner.req(`/api/tickets/${t3}/wait`, { method: 'POST', body: { body: 'Please confirm.' } });
await q(
  `UPDATE "Ticket" SET "waitingSince" = now() - interval '10 days', "waitingCloseDueAt" = now() - interval '1 minute' WHERE id=$1 AND subject LIKE '[verification%'`,
  [t3],
);
const sweep = await lead.req('/api/admin/run-sla-sweep', { method: 'POST' });
check(
  'lead manual sweep 200 (or 409 while the scheduler holds the lease)',
  [200, 409].includes(sweep.status),
  String(sweep.status),
);
let closed;
for (let i = 0; i < 20; i++) {
  closed = (await q(`SELECT status, "closeReason" FROM "Ticket" WHERE id=$1`, [t3]))[0];
  if (closed.status === 'CLOSED') break;
  await new Promise((r) => setTimeout(r, 3000));
}
check(
  'overdue waiting ticket auto-closed (AUTO_CLOSED_NO_REPLY)',
  closed.status === 'CLOSED' && closed.closeReason === 'AUTO_CLOSED_NO_REPLY',
  JSON.stringify(closed),
);
const closer = await q(
  `SELECT a."actorType" FROM audit_logs a WHERE a."ticketId"=$1 AND a.action='TICKET_CLOSED' AND EXISTS (SELECT 1 FROM audit_logs s WHERE s.action='SWEEP_STARTED' AND s."correlationId"=a."correlationId")`,
  [t3],
);
check(
  'DB: TICKET_CLOSED belongs to a sweep invocation (same correlation as SWEEP_STARTED)',
  closer.length === 1,
  JSON.stringify(closer),
);
console.log(
  `      (closed by ${closer[0]?.actorType ?? '?'}: SYSTEM = the deployed scheduler, LEAD = the manual sweep)`,
);
check(
  'non-lead agent cannot run the sweep (403)',
  (await agents.find((a) => a !== lead).req('/api/admin/run-sla-sweep', { method: 'POST' }))
    .status === 403,
);

// 9. Conversation pagination (> 50 messages)
const t4 = (
  await cust.req('/api/customer/tickets', {
    method: 'POST',
    body: { subject: `[verification ${stamp}] pagination`, body: 'Synthetic.' },
  })
).json.id;
await winner.req(`/api/tickets/${t4}/claim`, { method: 'POST' });
for (let i = 1; i <= 55; i++)
  await winner.req(`/api/tickets/${t4}/replies`, {
    method: 'POST',
    body: { body: `page message ${i}` },
  });
let all = [];
let cursor = null;
do {
  const r = await cust.req(
    `/api/customer/tickets/${t4}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  all = all.concat(r.json.items);
  cursor = r.json.nextCursor;
} while (cursor);
check(
  'customer pages through all 56 public messages without duplicates',
  all.length === 56 && new Set(all.map((m) => m.id)).size === 56,
  String(all.length),
);

// 10. Immutable audit reconstruction (staff) and DB immutability for the runtime role is proven by 03-verify.sql
const audit = await winner.req(`/api/tickets/${id}/audit`);
const actions = (audit.json?.items ?? audit.json ?? []).map((e) => e.action);
check(
  'staff audit history reconstructs the lifecycle',
  [
    'TICKET_CREATED',
    'TICKET_CLAIMED',
    'PRIORITY_CHANGED',
    'TICKET_RESOLVED',
    'TICKET_REOPENED',
  ].every((a) => actions.includes(a)),
  actions.join(','),
);
check(
  'customer cannot read the audit endpoint',
  (await cust.req(`/api/tickets/${id}/audit`)).status === 403,
);

await db.end();
console.log(
  failures
    ? `\n${failures} hosted verification check(s) FAILED`
    : '\nAll hosted workflow checks passed',
);
process.exit(failures ? 1 : 0);
