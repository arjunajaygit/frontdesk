import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';
import { connect, dotenv } from '../helpers/db';
import { Browser, ORIGIN, signedIn, start, startApp, TestApp } from '../helpers/http';
import { LockHolder, Observer } from '../helpers/observe';
import { cloneTemplate, dropDatabase } from '../helpers/scratch';

const AGENT = 'arjun.nair@arvo.example';
const OTHER = 'priya.sharma@arvo.example';
let t: TestApp;
let db: string;
let owner: Client;
let observer: Observer;

beforeAll(async () => {
  db = await cloneTemplate('m02');
  t = await startApp(db);
  owner = await connect('owner', db);
  observer = await Observer.open(db);
});
afterAll(async () => {
  await owner?.end();
  await observer?.close();
  await t?.close();
  await dropDatabase(db);
});

const refreshWith = (b: Browser, cookie: string) =>
  request(t.server)
    .post('/api/auth/refresh')
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', b.csrf)
    .set('Cookie', `frontdesk_refresh=${cookie}; frontdesk_csrf=${b.cookie('frontdesk_csrf')}`);
const SESSION_LOCK = '%FROM "Session"%FOR UPDATE%';

describe('refresh re-validates absolute expiry with fresh DB time AFTER the session lock', () => {
  it('session valid when refresh starts, expires while it waits on the lock -> 401, no rotation, token unused', async () => {
    const b = await signedIn(t, AGENT);
    const cookie = b.cookie('frontdesk_refresh')!;
    const sid = cookie.split('.')[0]!;
    const expiresAt = (
      await owner.query(
        `UPDATE "Session" SET "expiresAt" = now() + interval '1200 milliseconds' WHERE id=$1 RETURNING "expiresAt"`,
        [sid],
      )
    ).rows[0].expiresAt;
    const holder = await LockHolder.hold(db, `SELECT id FROM "Session" WHERE id=$1 FOR UPDATE`, [
      sid,
    ]);
    const pending = start(refreshWith(b, cookie));
    await observer.waitForLockWaiters(SESSION_LOCK, 1);
    await observer.untilDbTimeAfter(expiresAt);
    await holder.release(); // unchanged row: a pre-wait validity predicate would wrongly still pass
    expect((await pending).status).toBe(401);
    const tokens = (
      await owner.query(`SELECT "usedAt" FROM "RefreshToken" WHERE "sessionId"=$1`, [sid])
    ).rows;
    expect(tokens).toEqual([{ usedAt: null }]); // no rotation, token-use unchanged
  });

  it('overlapping refreshes with one credential (forced overlap): one 200, one 401, family revoked', async () => {
    const b = await signedIn(t, AGENT);
    const cookie = b.cookie('frontdesk_refresh')!;
    const sid = cookie.split('.')[0]!;
    const holder = await LockHolder.hold(db, `SELECT id FROM "Session" WHERE id=$1 FOR UPDATE`, [
      sid,
    ]);
    const a = start(refreshWith(b, cookie));
    const c = start(refreshWith(b, cookie));
    await observer.waitForLockWaiters(SESSION_LOCK, 2); // both genuinely blocked inside PostgreSQL
    await holder.release();
    const [ra, rc] = await Promise.all([a, c]);
    expect([ra.status, rc.status].sort()).toEqual([200, 401]);
    expect(
      (await owner.query(`SELECT "revokedAt" FROM "Session" WHERE id=$1`, [sid])).rows[0].revokedAt,
    ).not.toBeNull();
    const winner = ra.status === 200 ? ra : rc;
    const access = ([] as string[])
      .concat(winner.headers['set-cookie'] as unknown as string[])
      .find((x) => x.startsWith('frontdesk_access='))!;
    expect(
      (await request(t.server).get('/api/auth/me').set('Cookie', access.split(';')[0]!)).status,
    ).toBe(401);
  });
});

describe('access JWTs must carry every mandatory claim', () => {
  it('rejects correctly-signed tokens with missing/invalid exp or iat, excessive lifetime, wrong iss/aud/typ, or sub/sid mismatch', async () => {
    const b = await signedIn(t, AGENT);
    const other = await signedIn(t, OTHER);
    const real = jwt.decode(b.cookie('frontdesk_access')!) as jwt.JwtPayload;
    const key = Buffer.from(dotenv().JWT_SECRET!, 'hex');
    const now = Math.floor(Date.now() / 1000);
    /** Hand-rolled HS256 so malformed claims (which jsonwebtoken refuses to sign) can be produced. */
    const sign = (claims: Record<string, unknown>) => {
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}`;
      return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
    };
    const base = {
      sub: real.sub,
      sid: real.sid,
      typ: 'access',
      iss: 'frontdesk',
      aud: 'frontdesk-api',
    };
    const forged: Record<string, string> = {
      missingExp: sign({ ...base, iat: now }),
      stringExp: sign({ ...base, iat: now, exp: `${now + 600}` }),
      fractionalExp: sign({ ...base, iat: now, exp: now + 600.5 }),
      missingIat: sign({ ...base, exp: now + 600 }),
      tooLong: sign({ ...base, iat: now, exp: now + 86_400 }),
      expBeforeIat: sign({ ...base, iat: now, exp: now - 1 }),
      wrongIssuer: sign({ ...base, iss: 'someone-else', iat: now, exp: now + 600 }),
      wrongAudience: sign({ ...base, aud: 'other-api', iat: now, exp: now + 600 }),
      wrongType: sign({ ...base, typ: 'refresh', iat: now, exp: now + 600 }),
      subjectMismatch: sign({ ...base, sub: other.viewer!.id, iat: now, exp: now + 600 }),
      emptySid: sign({ ...base, sid: '', iat: now, exp: now + 600 }),
    };
    for (const [name, token] of Object.entries(forged)) {
      const r = await request(t.server)
        .get('/api/auth/me')
        .set('Cookie', `frontdesk_access=${token}`);
      expect({ name, status: r.status }).toEqual({ name, status: 401 });
    }
    const valid = sign({ ...base, iat: now, exp: now + 600 });
    expect(
      (await request(t.server).get('/api/auth/me').set('Cookie', `frontdesk_access=${valid}`))
        .status,
    ).toBe(200); // control
  });
});
