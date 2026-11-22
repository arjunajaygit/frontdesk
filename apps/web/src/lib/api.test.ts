import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, __resetApiState, fetchCsrf, onSessionLost, request } from './api';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let calls: { url: string; method: string; headers: Headers }[] = [];

function mockFetch(handler: Handler) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers) });
      return handler(url, init);
    }),
  );
}
const count = (path: string, method = 'POST') => calls.filter((c) => c.url === `/api${path}` && c.method === method).length;

beforeEach(() => __resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe('API client', () => {
  it('coalesces concurrent 401s into ONE refresh (a second rotation would be reuse and revoke the session)', async () => {
    let refreshed = false;
    mockFetch((url) => {
      if (url === '/api/auth/me') return json(401, { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' });
      if (url === '/api/auth/csrf') return json(200, { csrfToken: 'csrf-1' });
      if (url === '/api/auth/refresh') {
        refreshed = true;
        return json(200, { viewer: { id: 'u', displayName: 'U', role: 'AGENT' }, csrfToken: 'csrf-2' });
      }
      return refreshed ? json(200, { ok: true }) : json(401, { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' });
    });
    const results = await Promise.all([request('/tickets'), request('/tickets?limit=1'), request('/customers'), request('/tickets/abc')]);
    expect(results).toHaveLength(4);
    expect(count('/auth/refresh')).toBe(1);
  });

  it('does not loop: a failed refresh signals session loss once, and the original call is not retried forever', async () => {
    mockFetch((url) => {
      if (url === '/api/auth/csrf') return json(200, { csrfToken: 'c' });
      return json(401, { code: 'UNAUTHENTICATED', message: 'Authentication required.', requestId: 'r' });
    });
    const lost = vi.fn();
    onSessionLost(lost);
    await expect(request('/tickets')).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(count('/auth/refresh')).toBe(1);
    expect(count('/tickets', 'GET')).toBe(1);
  });

  it('after a successful refresh retries exactly once (no refresh loop if it is still 401)', async () => {
    mockFetch((url) => {
      if (url === '/api/auth/me') return json(401, {});
      if (url === '/api/auth/csrf') return json(200, { csrfToken: 'c' });
      if (url === '/api/auth/refresh') return json(200, { viewer: {}, csrfToken: 'c2' });
      return json(401, { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' });
    });
    await expect(request('/tickets')).rejects.toBeInstanceOf(ApiError);
    expect(count('/auth/refresh')).toBe(1);
    expect(count('/tickets', 'GET')).toBe(2);
  });

  it('mutations send CSRF + Idempotency-Key; an expired CSRF token is refetched once and retried with the SAME key', async () => {
    let first = true;
    mockFetch((url, init) => {
      if (url === '/api/auth/csrf') return json(200, { csrfToken: first ? 'stale' : 'fresh' });
      const h = new Headers(init.headers);
      if (h.get('X-CSRF-Token') === 'stale') {
        first = false;
        return json(403, { code: 'CSRF_REJECTED', message: 'no', requestId: 'r' });
      }
      return json(200, { ok: true });
    });
    await request('/tickets/1/claim', { method: 'POST', idempotencyKey: 'key-12345678', json: {} });
    const posts = calls.filter((c) => c.url === '/api/tickets/1/claim');
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.headers.get('Idempotency-Key'))).toEqual(['key-12345678', 'key-12345678']);
    expect(posts[1]!.headers.get('X-CSRF-Token')).toBe('fresh');
  });

  it('maps the claim-conflict body and never writes to localStorage/sessionStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mockFetch((url) => (url === '/api/auth/csrf' ? json(200, { csrfToken: 'c' }) : json(409, { code: 'CLAIM_CONFLICT', message: 'taken', requestId: 'rid', assignedAgentDisplayName: 'Priya Sharma' })));
    await fetchCsrf();
    const err = await request('/tickets/1/claim', { method: 'POST', idempotencyKey: 'k-0123456789', json: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'CLAIM_CONFLICT', assignedAgentDisplayName: 'Priya Sharma', requestId: 'rid' });
    expect(setItem).not.toHaveBeenCalled();
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});
