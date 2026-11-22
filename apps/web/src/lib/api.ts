/**
 * The ONLY module that talks to the backend. Same-origin requests with HttpOnly cookies — no token is ever
 * readable by script, and nothing is written to localStorage/sessionStorage. CSRF token and session context live
 * in memory only.
 *
 * Session binding: every request carries `X-Session-Context`, the opaque context of the
 * session THIS tab was rendered for. Tabs share cookies; if another tab signs in as someone else, the server
 * answers 409 SESSION_CHANGED instead of acting as (or reading as) the replacement identity. Locally, an `epoch`
 * counter increments on every session change: in-flight requests are aborted and no retry (CSRF or refresh) that
 * started under an older epoch is ever sent.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    /** Only present on the staff claim-conflict response (StaffClaimConflict). */
    readonly assignedAgentDisplayName?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get isConflict() {
    return this.status === 409;
  }
  get isSessionChanged() {
    return this.status === 409 && this.code === 'SESSION_CHANGED';
  }
}

export interface CurrentSessionDto {
  id: string;
  displayName: string;
  role: 'AGENT' | 'LEAD' | 'ADMIN' | 'CUSTOMER';
  sessionContext: string;
}

const BASE = '/api';
let csrfToken: string | null = null;
let sessionContext: string | null = null;
let epoch = 0;
let refreshing: Promise<void> | null = null;
const inflight = new Set<AbortController>();
const sessionLostListeners = new Set<() => void>();
const identityChangedListeners = new Set<() => void>();

const sessionChangedError = () =>
  new ApiError(409, 'SESSION_CHANGED', 'Your session changed in another tab or window. Nothing was saved; reload to continue.');

/** Fired when the session is gone and could not be refreshed (expiry, revocation, reuse detection). */
export function onSessionLost(cb: () => void): () => void {
  sessionLostListeners.add(cb);
  return () => sessionLostListeners.delete(cb);
}
/** Fired when the server reports that the cookies now belong to a different session than this tab's. */
export function onIdentityChanged(cb: () => void): () => void {
  identityChangedListeners.add(cb);
  return () => identityChangedListeners.delete(cb);
}
export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};
/** Adopt the session this tab now represents (login / restore). */
export function adoptSession(context: string, csrf?: string | null): void {
  sessionContext = context;
  if (csrf !== undefined) csrfToken = csrf;
}
export const currentSessionContext = () => sessionContext;
export const currentEpoch = () => epoch;

/**
 * Forget this tab's session binding: bump the epoch, abort every in-flight request (queries AND mutations) and
 * drop the in-memory CSRF token and context. Pending retries see the new epoch and are never sent.
 */
export function invalidateSession(): void {
  epoch += 1;
  for (const c of inflight) c.abort();
  inflight.clear();
  csrfToken = null;
  sessionContext = null;
}

/** Test seam only: reset module state between tests. */
export const __resetApiState = () => {
  csrfToken = null;
  sessionContext = null;
  epoch = 0;
  refreshing = null;
  inflight.clear();
  sessionLostListeners.clear();
  identityChangedListeners.clear();
};

async function parseError(res: Response): Promise<ApiError> {
  let body: { code?: string; message?: string; requestId?: string; assignedAgentDisplayName?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, body.code ?? `HTTP_${res.status}`, body.message ?? 'Request failed.', body.requestId, body.assignedAgentDisplayName);
}

async function rawFetch(path: string, init: RequestInit & { csrf?: boolean; idempotencyKey?: string; json?: unknown }): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  if (init.csrf && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  if (init.idempotencyKey) headers.set('Idempotency-Key', init.idempotencyKey);
  if (sessionContext) headers.set('X-Session-Context', sessionContext);
  const controller = new AbortController();
  const outer = init.signal;
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  inflight.add(controller);
  try {
    return await fetch(`${BASE}${path}`, { ...init, headers, body, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
  } finally {
    inflight.delete(controller);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Fetch (and remember) a signed CSRF token. `login` always yields a PRE-LOGIN token (valid only for login), so the
 * sign-in form works even while an older session cookie exists; otherwise the token is bound to the current session.
 */
export async function fetchCsrf(purpose?: 'login'): Promise<string> {
  const res = await rawFetch(purpose === 'login' ? '/auth/csrf?purpose=login' : '/auth/csrf', { method: 'GET' });
  if (!res.ok) throw await parseError(res);
  const { csrfToken: token } = (await res.json()) as { csrfToken: string };
  csrfToken = token;
  return token;
}

/**
 * Single-flight refresh. Concurrent callers (and other tabs, via the Web Locks API) share ONE rotation: a
 * second POST with the same refresh token would be treated as reuse and revoke the whole session family.
 * Never retried automatically. Rejects with SESSION_CHANGED if the cookies now belong to another session.
 */
export function refreshSession(): Promise<void> {
  if (refreshing) return refreshing;
  const startedIn = epoch;
  const run = async () => {
    // Another tab may have rotated while we waited for the lock: if the session works now, we're done.
    const probe = await rawFetch('/auth/me', { method: 'GET' });
    if (probe.ok) return;
    if (probe.status === 409) throw await parseError(probe);
    if (epoch !== startedIn) throw sessionChangedError();
    await fetchCsrf();
    const res = await rawFetch('/auth/refresh', { method: 'POST', csrf: true });
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as { csrfToken: string; sessionContext: string };
    if (epoch !== startedIn) throw sessionChangedError();
    csrfToken = body.csrfToken;
    if (!sessionContext) sessionContext = body.sessionContext; // restore path: adopt; otherwise the server proved equality
  };
  const locked = async (): Promise<void> => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('frontdesk-session-refresh', () => run());
      return;
    }
    await run();
  };
  const flight: Promise<void> = locked().finally(() => {
    refreshing = null;
  });
  refreshing = flight;
  return flight;
}

/**
 * Startup / revalidation: who are the cookies signed in as? One coordinated refresh when the access token has
 * expired (previously /auth/me was excluded from refresh, which stranded valid refresh sessions). Returns null when
 * there is no usable session. Never loops: at most one refresh, then one re-read.
 */
export async function restoreSession(): Promise<CurrentSessionDto | null> {
  const read = async () => {
    const res = await rawFetch('/auth/me', { method: 'GET' });
    if (res.ok) return (await res.json()) as CurrentSessionDto;
    throw await parseError(res);
  };
  try {
    const me = await read();
    adoptSession(me.sessionContext);
    return me;
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
  }
  try {
    await refreshSession();
    const me = await read();
    adoptSession(me.sessionContext);
    return me;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.isSessionChanged)) return null;
    throw e;
  }
}

/** Ask the server whether this tab's session is still the one the cookies carry (no refresh, no side effects). */
export async function probeSession(): Promise<'same' | 'changed' | 'unauthenticated' | 'unknown'> {
  if (!sessionContext) return 'changed';
  try {
    const res = await rawFetch('/auth/me', { method: 'GET' });
    if (res.ok) {
      const me = (await res.json()) as CurrentSessionDto;
      return me.sessionContext === sessionContext ? 'same' : 'changed';
    }
    if (res.status === 409) return 'changed';
    if (res.status === 401) return 'unauthenticated';
    return 'unknown';
  } catch {
    return 'unknown'; // offline / aborted: keep the current view, try again later
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  json?: unknown;
  /** Required for business mutations (one key per user intent; reused on safe retry). */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const isAuthPath = (p: string) => p.startsWith('/auth/');

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const mutating = method !== 'GET';
  const startedIn = epoch;
  const sameEpoch = () => {
    if (epoch !== startedIn) throw sessionChangedError(); // never retry a previous identity's request
  };
  const send = async () => {
    if (mutating && !csrfToken) await fetchCsrf();
    sameEpoch();
    return rawFetch(path, { method, csrf: mutating, json: opts.json, idempotencyKey: opts.idempotencyKey, signal: opts.signal });
  };
  let res = await send();
  if (res.status === 409) {
    const err = await parseError(res.clone());
    if (err.isSessionChanged) {
      identityChangedListeners.forEach((cb) => cb());
      throw err;
    }
  }
  if (res.status === 403 && mutating) {
    const err = await parseError(res.clone());
    if (err.code === 'CSRF_REJECTED') {
      await fetchCsrf(); // token expired/rotated: fetch once and retry with the SAME idempotency key
      res = await send(); // the server still rejects it (409) if the cookies now belong to another session
    }
  }
  if (res.status === 401 && !isAuthPath(path)) {
    try {
      await refreshSession();
    } catch (e) {
      if (e instanceof ApiError && e.isSessionChanged) {
        identityChangedListeners.forEach((cb) => cb());
        throw e;
      }
      sessionLostListeners.forEach((cb) => cb());
      throw await parseError(res);
    }
    res = await send(); // exactly one retry after a successful refresh: no refresh loops
    if (res.status === 401) sessionLostListeners.forEach((cb) => cb());
  }
  if (res.status === 409) {
    const err = await parseError(res.clone());
    if (err.isSessionChanged) identityChangedListeners.forEach((cb) => cb());
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Fresh idempotency key for one user intent. */
export const newIdempotencyKey = () => crypto.randomUUID();
