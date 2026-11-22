import request from 'supertest';
import { Client } from 'pg';
import { connect } from '../helpers/db';
import { Browser, ORIGIN, newKey, signedIn, startApp, TestApp } from '../helpers/http';
import { TEST_PASSWORD, cloneTemplate, dropDatabase } from '../helpers/scratch';

/**
 * Final audit H01 (session restore / login CSRF / logout revocation) and H02 (stale tab acting through a
 * replacement session) on REAL PostgreSQL through the real HTTP pipeline. One supertest agent = one browser cookie
 * jar shared by "tabs"; each tab remembers only its own CSRF token + session context, exactly like the SPA.
 */
const CUST_A = 'aarav.menon@customer.example';
const CUST_B = 'diya.kapoor@customer.example';
const AGENT_A = 'arjun.nair@arvo.example';
const AGENT_B = 'priya.sharma@arvo.example';

let t: TestApp;
let db: string;
let owner: Client;

beforeAll(async () => {
  db = await cloneTemplate('finalauth');
  t = await startApp(db);
  owner = await connect('owner', db);
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
  await dropDatabase(db);
});

/** A tab in a shared jar: remembers its own CSRF token and session context. */
interface Tab {
  csrf: string;
  context: string;
  viewerId: string;
}
async function signIn(jar: ReturnType<typeof request.agent>, email: string): Promise<Tab> {
  const pre = await jar.get('/api/auth/csrf?purpose=login');
  const r = await jar
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', pre.body.csrfToken)
    .send({ email, password: TEST_PASSWORD });
  expect(r.status).toBe(200);
  return { csrf: r.body.csrfToken, context: r.body.sessionContext, viewerId: r.body.viewer.id };
}
const mutate = (
  jar: ReturnType<typeof request.agent>,
  tab: Pick<Tab, 'csrf' | 'context'>,
  path: string,
  body: object,
) =>
  jar
    .post(path)
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', tab.csrf)
    .set('X-Session-Context', tab.context)
    .set('Idempotency-Key', newKey())
    .send(body);
/** What the SPA does after a CSRF rejection: fetch a fresh token (now bound to whatever session the cookies carry). */
const freshCsrf = async (jar: ReturnType<typeof request.agent>, context?: string) => {
  const r = jar.get('/api/auth/csrf');
  return (await (context ? r.set('X-Session-Context', context) : r)).body.csrfToken as string;
};
const cookieValue = (res: request.Response, name: string) =>
  ([] as string[])
    .concat(res.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1);

describe('H01: login CSRF, prior-session revocation, logout revocation', () => {
  it('purpose=login always yields a PRE-LOGIN token, even with a valid session; logging in again revokes the old session', async () => {
    const jar = request.agent(t.server);
    const first = await signIn(jar, CUST_A);
    const plain = await jar.get('/api/auth/csrf');
    const preLogin = await jar.get('/api/auth/csrf?purpose=login');
    const binding = (tok: string) =>
      JSON.parse(Buffer.from(tok.split('.')[0]!, 'base64url').toString()).b as string;
    expect(binding(plain.body.csrfToken)).toMatch(/^s:/); // session-bound when a session exists
    expect(binding(preLogin.body.csrfToken)).toMatch(/^p:/); // explicit pre-login
    const firstSession = await owner.query(
      `SELECT id FROM "Session" WHERE "userId"=$1 AND "revokedAt" IS NULL`,
      [first.viewerId],
    );
    expect(firstSession.rowCount).toBeGreaterThanOrEqual(1);
    const second = await signIn(jar, CUST_A); // login while the old session is still valid
    expect(second.context).not.toBe(first.context);
    const live = await owner.query(
      `SELECT count(*)::int n FROM "Session" WHERE "userId"=$1 AND "revokedAt" IS NULL`,
      [first.viewerId],
    );
    expect(live.rows[0].n).toBe(1); // the replaced session was revoked, not orphaned
  });

  it('after a confirmed logout the ORIGINAL access and refresh credentials are both rejected', async () => {
    const jar = request.agent(t.server);
    const pre = await jar.get('/api/auth/csrf?purpose=login');
    const login = await jar
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', pre.body.csrfToken)
      .send({ email: CUST_A, password: TEST_PASSWORD });
    const access = cookieValue(login, 'frontdesk_access')!;
    const refresh = cookieValue(login, 'frontdesk_refresh')!;
    const csrf = login.body.csrfToken as string;
    expect(access && refresh && csrf).toBeTruthy();
    const out = await jar
      .post('/api/auth/logout')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrf)
      .set('X-Session-Context', login.body.sessionContext);
    expect(out.status).toBe(200);
    // A fresh client replaying the captured credentials (not an anonymous client, which proves nothing).
    const reuseAccess = await request(t.server)
      .get('/api/customer/tickets')
      .set('Cookie', `frontdesk_access=${access}`);
    expect(reuseAccess.status).toBe(401);
    const reuseRefresh = await request(t.server)
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('Cookie', `frontdesk_refresh=${refresh}; frontdesk_csrf=${csrf}`)
      .set('X-CSRF-Token', csrf); // CSRF is valid (bound to that session id) so the rejection is the revocation itself
    expect(reuseRefresh.status).toBe(401);
  });
});

describe('H02: a stale tab can never act or read through a replacement session (server-enforced)', () => {
  const scenarios: Array<[string, string, string, 'customer' | 'staff']> = [
    ['customer A replaced by customer B', CUST_A, CUST_B, 'customer'],
    ['staff replaced by another staff member', AGENT_A, AGENT_B, 'staff'],
    ['staff replaced by a customer', AGENT_A, CUST_B, 'staff'],
  ];
  it.each(scenarios)(
    '%s: the retried old mutation is rejected and nothing is persisted under either identity',
    async (_n, oldEmail, newEmail, kind) => {
      const jar = request.agent(t.server); // ONE browser: both tabs share these cookies
      const oldTab = await signIn(jar, oldEmail);
      const target = (await owner.query(`SELECT id FROM "Ticket" WHERE subject LIKE '[FD-010]%'`))
        .rows[0].id as string;
      const before = (
        await owner.query(`SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1`, [target])
      ).rows[0].n;
      const newTab = await signIn(jar, newEmail); // the other tab signs in as someone else
      const path = kind === 'customer' ? `/api/customer/tickets` : `/api/tickets/${target}/notes`;
      const body =
        kind === 'customer'
          ? { subject: 'stale tab', body: 'from the old identity' }
          : { body: 'stale staff note' };

      // 1) old tab submits with its own (now foreign) CSRF token -> rejected
      const first = await mutate(jar, oldTab, path, body);
      expect([403, 409]).toContain(first.status);
      // 2) the CSRF-retry path: fresh token now bound to the NEW session, old context still attached -> 409
      const retried = await mutate(
        jar,
        { csrf: await freshCsrf(jar), context: oldTab.context },
        path,
        body,
      );
      expect(retried.status).toBe(409);
      expect(retried.body.code).toBe('SESSION_CHANGED');
      // 3) without any context the business mutation is refused outright. GET /auth/csrf replaced the CSRF
      // cookie, so take a fresh token first (supertest attaches cookies when the request object is created).
      const bareCsrf = await freshCsrf(jar, newTab.context);
      newTab.csrf = bareCsrf;
      const isCust = newEmail.endsWith('@customer.example');
      const bare = await jar
        .post(isCust ? '/api/customer/tickets' : `/api/tickets/${target}/notes`)
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', bareCsrf)
        .set('Idempotency-Key', newKey())
        .send(isCust ? { subject: 'bare', body: 'no context' } : { body: 'bare note' });
      expect(bare.status).toBe(400);
      expect(bare.body.code).toBe('SESSION_CONTEXT_REQUIRED');
      // 4) reads with the old context are refused too (no foreign data under the old tab's UI)
      const read = await jar
        .get(kind === 'customer' ? '/api/customer/tickets' : '/api/tickets')
        .set('X-Session-Context', oldTab.context);
      expect(read.status).toBe(409);
      // persisted truth: nothing written by either identity
      const after = (
        await owner.query(`SELECT count(*)::int n FROM "Message" WHERE "ticketId"=$1`, [target])
      ).rows[0].n;
      expect(after).toBe(before);
      const stale = await owner.query(
        `SELECT count(*)::int n FROM "Ticket" WHERE subject='stale tab'`,
      );
      expect(stale.rows[0].n).toBe(0);
      // the new tab works normally and acts as the NEW identity (persisted actor checked in PostgreSQL)
      if (newEmail.endsWith('@customer.example')) {
        const ok = await mutate(jar, newTab, '/api/customer/tickets', {
          subject: `new tab ${newTab.viewerId}`,
          body: 'hello',
        });
        expect(ok.status).toBe(201);
        const owned = await owner.query(`SELECT "customerId" FROM "Ticket" WHERE subject=$1`, [
          `new tab ${newTab.viewerId}`,
        ]);
        expect(owned.rows[0].customerId).toBe(newTab.viewerId);
      } else {
        const fd004 = (await owner.query(`SELECT id FROM "Ticket" WHERE subject LIKE '[FD-004]%'`))
          .rows[0].id as string;
        const ok = await mutate(jar, newTab, `/api/tickets/${fd004}/claim`, {});
        expect(ok.status).toBe(200);
        const claimed = await owner.query(
          `SELECT "actorId" FROM audit_logs WHERE "ticketId"=$1 AND action='TICKET_CLAIMED'`,
          [fd004],
        );
        expect(claimed.rows.map((r) => r.actorId)).toEqual([newTab.viewerId]);
      }
    },
  );

  it('a stale tab cannot sign out or rotate the replacement session', async () => {
    const jar = request.agent(t.server);
    const oldTab = await signIn(jar, CUST_A);
    const newTab = await signIn(jar, CUST_B);
    const t1 = await freshCsrf(jar); // fetched BEFORE creating the request (cookies attach at creation)
    const out = await jar
      .post('/api/auth/logout')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', t1)
      .set('X-Session-Context', oldTab.context);
    expect(out.status).toBe(409);
    const t2 = await freshCsrf(jar);
    const refresh = await jar
      .post('/api/auth/refresh')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', t2)
      .set('X-Session-Context', oldTab.context);
    expect(refresh.status).toBe(409);
    const me = await jar.get('/api/auth/me').set('X-Session-Context', newTab.context);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(newTab.viewerId); // B is still signed in
  });

  it('session context is stable across refresh rotation (other tabs of the SAME session keep working)', async () => {
    const b = await signedIn(t, CUST_A);
    const ctx = b.sessionContext;
    const r = await b.post('/api/auth/refresh', undefined, null);
    expect(r.status).toBe(200);
    expect(r.body.sessionContext).toBe(ctx);
    b.csrf = r.body.csrfToken;
    expect(
      (await b.post('/api/customer/tickets', { subject: 'after rotation', body: 'x' })).status,
    ).toBe(201);
  });
});

describe('M01: principal-keyed limits for signed-in traffic; strict per-IP limits for unauthenticated traffic', () => {
  let lt: TestApp;
  let ldb: string;
  beforeAll(async () => {
    ldb = await cloneTemplate('limits');
    // Generous anonymous budget here: signed-in scenarios need CSRF bootstrap + login for 12 sessions.
    lt = await startApp(ldb, {
      API_RATE_LIMIT_PER_MIN: '20',
      API_IP_RATE_LIMIT_PER_MIN: '100000',
      ANON_RATE_LIMIT_PER_MIN: '200',
    });
  });
  afterAll(async () => {
    await lt?.close();
    await dropDatabase(ldb);
  });

  it('nine agents behind ONE IP each get their own budget (old per-IP scheme would have throttled them)', async () => {
    const emails = [
      'meera.iyer',
      'arjun.nair',
      'priya.sharma',
      'rohan.mehta',
      'kavya.reddy',
      'vikram.singh',
      'ananya.das',
      'imran.khan',
      'sneha.patil',
    ].map((e) => `${e}@arvo.example`);
    const agents = await Promise.all(emails.map((e) => signedIn(lt, e)));
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++)
      for (const a of agents) statuses.push((await a.get('/api/tickets?limit=5')).status);
    expect(statuses.length).toBe(135); // 135 requests from one IP, 15 per user (< 20 per user)
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('one noisy user with several sessions shares ONE budget', async () => {
    const sessions = await Promise.all(
      [1, 2, 3].map(() => signedIn(lt, 'diya.kapoor@customer.example')),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++)
      for (const s of sessions) statuses.push((await s.get('/api/customer/tickets')).status);
    expect(statuses.filter((s) => s === 200).length).toBe(20);
    expect(statuses.filter((s) => s === 429).length).toBe(10);
  });
});

describe('M01: strict per-IP limits for unauthenticated traffic', () => {
  let lt: TestApp;
  let ldb: string;
  beforeAll(async () => {
    ldb = await cloneTemplate('anonlimits');
    lt = await startApp(ldb, { ANON_RATE_LIMIT_PER_MIN: '10' });
  });
  afterAll(async () => {
    await lt?.close();
    await dropDatabase(ldb);
  });

  it('unauthenticated and forged/expired credentials are limited per IP; spoofed X-Forwarded-For does not reset it', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push(
        (
          await request(lt.server)
            .get('/api/tickets')
            .set('Cookie', i % 2 ? 'frontdesk_access=forged.jwt.value' : '')
            .set('X-Forwarded-For', `203.0.113.${i}`)
        ).status,
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true); // TRUST_PROXY_HOPS=0: XFF ignored
  });

  it('CSRF bootstrap is limited per IP; health probes are not', async () => {
    // The previous test already spent part of the shared anon budget on other keys; csrf has its own key.
    const csrf: number[] = [];
    for (let i = 0; i < 12; i++) csrf.push((await request(lt.server).get('/api/auth/csrf')).status);
    expect(csrf.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(csrf.slice(10).every((s) => s === 429)).toBe(true);
    for (let i = 0; i < 15; i++)
      expect((await request(lt.server).get('/api/healthz')).status).toBe(200);
  });
});

describe('M01: trusted proxy honours only the proxy-appended address', () => {
  let pt: TestApp;
  let pdb: string;
  beforeAll(async () => {
    pdb = await cloneTemplate('proxy');
    pt = await startApp(pdb, { TRUST_PROXY_HOPS: '1', ANON_RATE_LIMIT_PER_MIN: '5' });
  });
  afterAll(async () => {
    await pt?.close();
    await dropDatabase(pdb);
  });
  it('client-supplied leading XFF entries cannot mint new identities behind one hop', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push(
        (
          await request(pt.server)
            .get('/api/tickets')
            .set('X-Forwarded-For', `198.51.100.${i}, 192.0.2.7`)
        ).status,
      );
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
  });
});

void Browser;
