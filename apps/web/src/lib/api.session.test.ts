import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetApiState, adoptSession, invalidateSession, onIdentityChanged, onSessionLost, refreshSession, request, restoreSession } from './api';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ME = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Aarav', role: 'CUSTOMER', sessionContext: 'ctx-A'.padEnd(32, 'a') };

let calls: Array<{ url: string; method: string; headers: Headers }>;
function mockFetch(handler: Handler) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers) });
      return handler(url, init);
    }),
  );
}
const count = (pred: (c: (typeof calls)[number]) => boolean) => calls.filter(pred).length;

beforeEach(() => __resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe('restoreSession', () => {
  it('expired access + valid refresh: exactly ONE refresh, then the viewer is restored', async () => {
    let refreshed = false;
    mockFetch((url) => {
      if (url === '/api/auth/me') return refreshed ? json(200, ME) : json(401, { code: 'UNAUTHENTICATED' });
      if (url === '/api/auth/csrf') return json(200, { csrfToken: 'tok' });
      if (url === '/api/auth/refresh') {
        refreshed = true;
        return json(200, { csrfToken: 'tok2', sessionContext: ME.sessionContext, viewer: ME });
      }
      return json(404, {});
    });
    const me = await restoreSession();
    expect(me?.id).toBe(ME.id);
    expect(count((c) => c.url === '/api/auth/refresh')).toBe(1);
  });

  it('revoked refresh session: one attempt, returns null, no loop', async () => {
    mockFetch((url) => {
      if (url === '/api/auth/me') return json(401, { code: 'UNAUTHENTICATED' });
      if (url === '/api/auth/csrf') return json(200, { csrfToken: 'tok' });
      if (url === '/api/auth/refresh') return json(401, { code: 'UNAUTHENTICATED' });
      return json(404, {});
    });
    expect(await restoreSession()).toBeNull();
    expect(count((c) => c.url === '/api/auth/refresh')).toBe(1);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it('concurrent refresh callers share ONE rotation (reuse detection never trips)', async () => {
    let refreshed = false;
    mockFetch(async (url) => {
      if (url === '/api/auth/me') return refreshed ? json(200, ME) : json(401, {});
      if (url === '/api/auth/csrf') return json(200, { csrfToken: 'tok' });
      if (url === '/api/auth/refresh') {
        await new Promise((r) => setTimeout(r, 10));
        refreshed = true;
        return json(200, { csrfToken: 'tok2', sessionContext: ME.sessionContext, viewer: ME });
      }
      return json(404, {});
    });
    await Promise.all([refreshSession(), refreshSession(), refreshSession()]);
    expect(count((c) => c.url === '/api/auth/refresh')).toBe(1);
  });
});

describe('session-bound requests', () => {
  it('every request carries the tab session context', async () => {
    mockFetch(() => json(200, { items: [] }));
    adoptSession(ME.sessionContext, 'tok');
    await request('/customer/tickets');
    await request('/customer/tickets', { method: 'POST', json: { subject: 's', body: 'b' }, idempotencyKey: 'k' });
    expect(calls.every((c) => c.headers.get('X-Session-Context') === ME.sessionContext)).toBe(true);
  });

  it('SESSION_CHANGED is never retried and notifies the identity listener', async () => {
    const changed = vi.fn();
    onIdentityChanged(changed);
    mockFetch(() => json(409, { code: 'SESSION_CHANGED', message: 'changed' }));
    adoptSession(ME.sessionContext, 'tok');
    await expect(request('/customer/tickets', { method: 'POST', json: {}, idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(count((c) => c.method === 'POST')).toBe(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('a CSRF retry that would happen after an identity change is cancelled (never sent)', async () => {
    mockFetch((url, init) => {
      if (url === '/api/auth/csrf') {
        invalidateSession(); // another tab signed in while this request was waiting for a fresh token
        return json(200, { csrfToken: 'tok-B' });
      }
      if ((init.method ?? 'GET') === 'POST') return json(403, { code: 'CSRF_REJECTED' });
      return json(200, {});
    });
    adoptSession(ME.sessionContext, 'tok-A');
    await expect(request('/customer/tickets', { method: 'POST', json: {}, idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
    expect(count((c) => c.method === 'POST' && c.url === '/api/customer/tickets')).toBe(1); // the retry never left
  });

  it('invalidateSession aborts in-flight requests', async () => {
    mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    adoptSession(ME.sessionContext, 'tok');
    const pending = request('/customer/tickets');
    invalidateSession();
    await expect(pending).rejects.toThrow(/abort/i);
  });

  it('a refresh failure fires session-lost exactly once and does not loop', async () => {
    const lost = vi.fn();
    onSessionLost(lost);
    mockFetch((url) => {
      if (url === '/api/auth/csrf') return json(200, { csrfToken: 'tok' });
      return json(401, { code: 'UNAUTHENTICATED' });
    });
    adoptSession(ME.sessionContext, 'tok');
    await expect(request('/customer/tickets')).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(count((c) => c.url === '/api/auth/refresh')).toBe(1);
  });
});
