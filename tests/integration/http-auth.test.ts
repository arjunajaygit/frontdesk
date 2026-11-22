import jwt from 'jsonwebtoken';
import request from 'supertest';
import { Client } from 'pg';
import { Browser, ORIGIN, conforms, signedIn, startApp, TestApp } from '../helpers/http';
import { cloneTemplate, dropDatabase, TEST_PASSWORD } from '../helpers/scratch';
import { connect, dotenv } from '../helpers/db';

const LEAD = 'meera.iyer@arvo.example';
const AGENT = 'arjun.nair@arvo.example';
const CUSTOMER = 'aarav.menon@customer.example';

let t: TestApp;
let db: string;
let owner: Client;
const jwtKey = () => Buffer.from(dotenv().JWT_SECRET!, 'hex');
const setCookies = (r: { headers: Record<string, unknown> }) =>
  ([] as string[]).concat((r.headers['set-cookie'] as string[]) ?? []);
const cookieLine = (r: { headers: Record<string, unknown> }, name: string) =>
  setCookies(r).find((c) => c.startsWith(`${name}=`));

beforeAll(async () => {
  db = await cloneTemplate('auth');
  t = await startApp(db);
  owner = await connect('owner', db);
});
afterAll(async () => {
  await owner?.end();
  await t?.close();
  await dropDatabase(db);
});

describe('CSRF bootstrap and login', () => {
  it('GET /auth/csrf issues a prelogin token in an HttpOnly SameSite=Lax cookie on Path=/api, no-store', async () => {
    const b = new Browser(t.server);
    const r = await b.get('/api/auth/csrf');
    expect(r.status).toBe(200);
    conforms('Csrf', r.body);
    const c = cookieLine(r, 'frontdesk_csrf')!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\/api(;|$)/);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers.vary).toMatch(/Cookie/);
  });

  it('login sets access (Path=/api, 15 min) and refresh (Path=/api/auth) cookies, rotates CSRF, returns no secrets', async () => {
    const b = new Browser(t.server);
    const pre = await b.primeCsrf();
    const r = await b.login(LEAD);
    expect(r.status).toBe(200);
    conforms('SessionResponse', r.body);
    expect(r.body.csrfToken).not.toBe(pre);
    const access = cookieLine(r, 'frontdesk_access')!;
    const refresh = cookieLine(r, 'frontdesk_refresh')!;
    expect(access).toMatch(/Path=\/api(;|$)/);
    expect(access).toMatch(/Max-Age=900/);
    expect(access).toMatch(/HttpOnly/);
    expect(access).toMatch(/SameSite=Lax/);
    expect(access).not.toMatch(/Domain=/i); // host-only
    expect(refresh).toMatch(/Path=\/api\/auth(;|$)/);
    expect(refresh).toMatch(/HttpOnly/);
    expect(JSON.stringify(r.body)).not.toMatch(/argon2|passwordHash|frontdesk_refresh/);
  });

  it('invalid password and unknown account fail identically (401, generic message)', async () => {
    const wrong = await new Browser(t.server).login(LEAD, 'not-the-password');
    const unknown = await new Browser(t.server).login('nobody@arvo.example', 'whatever');
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.message).toBe(unknown.body.message);
    conforms('Error', wrong.body);
  });

  it('login requires a prelogin CSRF token and the exact Origin (missing / null / foreign rejected)', async () => {
    const b = new Browser(t.server);
    await b.primeCsrf();
    const send = (origin: string | null, csrf: string | null) => {
      let r = b.agent.post('/api/auth/login');
      if (origin !== null) r = r.set('Origin', origin);
      if (csrf !== null) r = r.set('X-CSRF-Token', csrf);
      return r.send({ email: LEAD, password: TEST_PASSWORD });
    };
    expect((await send(null, b.csrf)).body.code).toBe('ORIGIN_REJECTED');
    expect((await send('null', b.csrf)).status).toBe(403);
    expect((await send('https://evil.example', b.csrf)).status).toBe(403);
    expect((await send(`${ORIGIN}/`, b.csrf)).status).toBe(403);
    expect((await send(ORIGIN, null)).body.code).toBe('CSRF_REJECTED');
    expect((await send(ORIGIN, b.csrf + 'x')).status).toBe(403);
  });

  it('a session-bound CSRF token cannot be used for prelogin, nor across sessions', async () => {
    const a = await signedIn(t, LEAD);
    const b = await signedIn(t, AGENT);
    const login = await a.agent
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', a.csrf)
      .send({ email: LEAD, password: TEST_PASSWORD });
    expect(login.status).toBe(403);
    // b's token with a's cookie jar: header != cookie and binding differs
    const cross = await a.agent
      .post('/api/customer/tickets')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', b.csrf)
      .set('Idempotency-Key', 'k-cross-session-1')
      .send({ subject: 's', body: 'b' });
    expect(cross.status).toBe(403);
  });
});

describe('access token verification (every protected call)', () => {
  it('rejects missing, tampered, wrong-key, wrong-type, alg=none and expired tokens', async () => {
    const lead = await signedIn(t, LEAD);
    const good = lead.cookie('frontdesk_access')!;
    const claims = jwt.decode(good) as jwt.JwtPayload;
    const forge = (payload: object, key: Buffer | string = jwtKey(), opts: jwt.SignOptions = {}) =>
      jwt.sign(payload, key, { algorithm: 'HS256', ...opts });
    const base = {
      sub: claims.sub,
      sid: claims.sid,
      typ: 'access',
      iss: 'frontdesk',
      aud: 'frontdesk-api',
    };
    const tokens: Record<string, string> = {
      tampered: good.slice(0, -2) + (good.endsWith('A') ? 'BB' : 'AA'),
      wrongKey: forge({ ...base, exp: Math.floor(Date.now() / 1000) + 600 }, 'x'.repeat(64)),
      wrongType: forge({ ...base, typ: 'refresh', exp: Math.floor(Date.now() / 1000) + 600 }),
      wrongAudience: forge({ ...base, aud: 'other', exp: Math.floor(Date.now() / 1000) + 600 }),
      expired: forge({ ...base, exp: Math.floor(Date.now() / 1000) - 10 }),
      algNone: `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ ...base, exp: 9e9 })).toString('base64url')}.`,
    };
    expect((await new Browser(t.server).get('/api/auth/me')).status).toBe(401);
    for (const [name, token] of Object.entries(tokens)) {
      const r = await new Browser(t.server)
        .get('/api/auth/me')
        .set('Cookie', `frontdesk_access=${token}`);
      expect({ name, status: r.status }).toEqual({ name, status: 401 });
    }
    expect(
      (await new Browser(t.server).get('/api/auth/me').set('Cookie', `frontdesk_access=${good}`))
        .status,
    ).toBe(200);
  });

  it('a valid JWT for an expired or revoked DB session is rejected immediately', async () => {
    const b = await signedIn(t, AGENT);
    const token = b.cookie('frontdesk_access')!;
    const sid = (jwt.decode(token) as jwt.JwtPayload).sid;
    await owner.query(
      `UPDATE "Session" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`,
      [sid],
    );
    expect((await b.get('/api/auth/me')).status).toBe(401);
    const c = await signedIn(t, AGENT);
    await owner.query(`UPDATE "Session" SET "revokedAt" = now() WHERE id = $1`, [
      (jwt.decode(c.cookie('frontdesk_access')!) as jwt.JwtPayload).sid,
    ]);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('refresh rotation, reuse detection and logout', () => {
  /** Jar-less request carrying exactly the given cookies (simulates an attacker / second tab precisely). */
  const bare = (path: string, b: Browser, cookies: Record<string, string | undefined>) =>
    request(t.server)
      .post(path)
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', b.csrf)
      .set(
        'Cookie',
        Object.entries(cookies)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${v}`)
          .join('; '),
      );
  const refresh = (b: Browser, cookie?: string) =>
    cookie
      ? bare('/api/auth/refresh', b, {
          frontdesk_refresh: cookie,
          frontdesk_csrf: b.cookie('frontdesk_csrf'),
        })
      : b.agent.post('/api/auth/refresh').set('Origin', ORIGIN).set('X-CSRF-Token', b.csrf);

  it('rotates the refresh token, stores only digests, and issues new access + CSRF', async () => {
    const b = await signedIn(t, CUSTOMER);
    const oldRefresh = b.cookie('frontdesk_refresh')!;
    const r = await refresh(b);
    expect(r.status).toBe(200);
    conforms('SessionResponse', r.body);
    b.csrf = r.body.csrfToken;
    expect(b.cookie('frontdesk_refresh')).not.toBe(oldRefresh);
    const [sid, secret] = oldRefresh.split('.');
    const rows = (
      await owner.query(
        `SELECT "tokenHash", "usedAt" FROM "RefreshToken" WHERE "sessionId" = $1 ORDER BY "issuedAt"`,
        [sid],
      )
    ).rows;
    expect(rows.length).toBe(2);
    expect(rows[0].usedAt).not.toBeNull();
    expect(JSON.stringify(rows)).not.toContain(secret); // raw token never stored
    const me = await b.get('/api/auth/me');
    expect(me.status).toBe(200);
    conforms('CurrentSession', me.body);
    expect(me.body).toEqual({ ...b.viewer, sessionContext: b.sessionContext }); // context stable across rotation
  });

  it('replaying a used refresh token revokes the whole family (401), killing the newest access token too', async () => {
    const b = await signedIn(t, CUSTOMER);
    const stolen = b.cookie('frontdesk_refresh')!;
    const ok = await refresh(b);
    expect(ok.status).toBe(200);
    b.csrf = ok.body.csrfToken;
    const replay = await refresh(b, stolen);
    expect(replay.status).toBe(401);
    expect((await b.get('/api/auth/me')).status).toBe(401); // family revoked, committed before the 401
    const sid = stolen.split('.')[0];
    expect(
      (await owner.query(`SELECT "revokedAt" FROM "Session" WHERE id=$1`, [sid])).rows[0].revokedAt,
    ).not.toBeNull();
  });

  it('concurrent refreshes with the same token serialise: one rotates, the other is treated as reuse and revokes', async () => {
    const b = await signedIn(t, CUSTOMER);
    const cookie = b.cookie('frontdesk_refresh')!;
    const [r1, r2] = await Promise.all([refresh(b, cookie), refresh(b, cookie)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
    const sid = cookie.split('.')[0];
    expect(
      (await owner.query(`SELECT "revokedAt" FROM "Session" WHERE id=$1`, [sid])).rows[0].revokedAt,
    ).not.toBeNull();
  });

  it('refresh never accepts the access JWT, and requires session-bound CSRF + Origin', async () => {
    const b = await signedIn(t, AGENT);
    const noRefresh = await bare('/api/auth/refresh', b, {
      frontdesk_access: b.cookie('frontdesk_access'),
      frontdesk_csrf: b.cookie('frontdesk_csrf'),
    });
    expect([401, 403]).toContain(noRefresh.status);
    expect((await b.agent.post('/api/auth/refresh').set('X-CSRF-Token', b.csrf)).status).toBe(403); // no Origin
    expect((await b.agent.post('/api/auth/refresh').set('Origin', ORIGIN)).status).toBe(403); // no CSRF
  });

  it('logout revokes the session, clears all three cookies with matching paths, and repeats as a no-op', async () => {
    const b = await signedIn(t, LEAD);
    const r = await b.post('/api/auth/logout', undefined, null);
    expect(r.status).toBe(200);
    conforms('Ok', r.body);
    const cleared = setCookies(r);
    expect(cleared.find((c) => c.startsWith('frontdesk_access=;'))).toMatch(/Path=\/api(;|$)/);
    expect(cleared.find((c) => c.startsWith('frontdesk_refresh=;'))).toMatch(
      /Path=\/api\/auth(;|$)/,
    );
    expect(cleared.find((c) => c.startsWith('frontdesk_csrf=;'))).toMatch(/Path=\/api(;|$)/);
    expect((await b.get('/api/auth/me')).status).toBe(401);
    await b.primeCsrf();
    expect((await b.post('/api/auth/logout', undefined, null)).status).toBe(200); // anonymous no-op with prelogin CSRF
  });

  it('logout works from the refresh identity alone when the access token is gone', async () => {
    const b = await signedIn(t, AGENT);
    const refreshCookie = b.cookie('frontdesk_refresh')!;
    const r = await bare('/api/auth/logout', b, {
      frontdesk_refresh: refreshCookie,
      frontdesk_csrf: b.cookie('frontdesk_csrf'),
    });
    expect(r.status).toBe(200);
    expect(
      (
        await owner.query(`SELECT "revokedAt" FROM "Session" WHERE id=$1`, [
          refreshCookie.split('.')[0],
        ])
      ).rows[0].revokedAt,
    ).not.toBeNull();
  });
});

describe('transport hardening', () => {
  it('security headers, no-store and Vary: Cookie on success and error responses', async () => {
    for (const r of [
      await new Browser(t.server).get('/api/healthz'),
      await new Browser(t.server).get('/api/tickets'),
    ]) {
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
      expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
      expect(r.headers['x-powered-by']).toBeUndefined();
      expect(r.headers['access-control-allow-origin']).toBeUndefined(); // no CORS
    }
  });

  it('oversized and malformed bodies are rejected safely without stack traces', async () => {
    const b = await signedIn(t, CUSTOMER);
    const big = await b.post('/api/customer/tickets', { subject: 's', body: 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    const bad = await b.agent
      .post('/api/customer/tickets')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', b.csrf)
      .set('Idempotency-Key', 'k-malformed-1')
      .set('Content-Type', 'application/json')
      .send('{"subject":');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at \w+ \(|node_modules|SyntaxError/);
    conforms('Error', bad.body);
  });
});

describe('login rate limiting', () => {
  it('throttles repeated attempts for one principal with 429', async () => {
    const limited = await startApp(db, { LOGIN_RATE_LIMIT_PER_MIN: '3' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++)
        statuses.push((await new Browser(limited.server).login(AGENT, 'wrong-password')).status);
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses.slice(3)).toEqual([429, 429]);
    } finally {
      await limited.close();
    }
  });
});
