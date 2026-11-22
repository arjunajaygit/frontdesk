import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  adoptSession,
  currentSessionContext,
  fetchCsrf,
  invalidateSession,
  onIdentityChanged,
  onSessionLost,
  probeSession,
  request,
  restoreSession,
  type CurrentSessionDto,
} from '@/lib/api';
import type { SessionResponse, Viewer } from '@/lib/types';

type Status = 'loading' | 'authenticated' | 'anonymous';
/**
 * Why the previous view ended, so the login page can say so:
 *  - expired: the session could not be refreshed (expiry / revocation / reuse detection)
 *  - elsewhere: another tab signed out or signed in as someone else
 *  - logout-unconfirmed: sign-out was requested but the server did not confirm it; the session MAY still be active
 */
export type EndedReason = 'expired' | 'elsewhere' | 'logout-unconfirmed' | null;
export type LogoutOutcome = 'confirmed' | 'unconfirmed';

interface AuthState {
  status: Status;
  viewer: Viewer | null;
  /** Opaque context of the session this tab renders; protected UI is keyed by it so drafts never cross sessions. */
  sessionKey: string | null;
  endedReason: EndedReason;
  /** Set when another tab switched this browser to a different account; shown until dismissed. */
  switchedNotice: string | null;
  dismissSwitchedNotice: () => void;
  login: (email: string, password: string) => Promise<Viewer>;
  logout: () => Promise<LogoutOutcome>;
}
const Ctx = createContext<AuthState | null>(null);

const CHANNEL = 'frontdesk-session';
type Signal = { type: 'session-changed' };

/**
 * Session lifecycle. The viewer comes ONLY from the server; nothing about the session is persisted in the browser.
 * Every path that ends or changes a session aborts in-flight requests, wipes the whole TanStack cache and remounts
 * the protected UI (key = session context), so another identity's data, drafts or retries can never surface.
 * Cross-tab: a BroadcastChannel nudges other tabs, which then ASK THE SERVER (probe) — the broadcast is a hint,
 * never an authority; the server-side session context check is the enforcement.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>('loading');
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [endedReason, setEndedReason] = useState<EndedReason>(null);
  const [switchedNotice, setSwitchedNotice] = useState<string | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const revalidating = useRef<Promise<void> | null>(null);

  const apply = useCallback(
    (next: CurrentSessionDto | null, reason: EndedReason = null) => {
      const nextContext = next?.sessionContext ?? null;
      if (viewerRef.current?.id !== next?.id || sessionKeyRef.current !== nextContext || !next) {
        void qc.cancelQueries();
        qc.clear(); // identity/session change or sign-out: drop all cached data
      }
      const v = next ? { id: next.id, displayName: next.displayName, role: next.role } : null;
      viewerRef.current = v;
      sessionKeyRef.current = nextContext;
      setViewer(v);
      setSessionKey(nextContext);
      setStatus(v ? 'authenticated' : 'anonymous');
      if (v) setEndedReason(null);
      else if (reason) setEndedReason(reason);
    },
    [qc],
  );

  const broadcast = useCallback(() => {
    try {
      channel.current?.postMessage({ type: 'session-changed' } satisfies Signal);
    } catch {
      /* channel closed */
    }
  }, []);

  /** Re-establish which session the cookies carry; adopt it (or none) if it is not this tab's. */
  const revalidate = useCallback(
    (reason: EndedReason) => {
      if (revalidating.current) return revalidating.current;
      const run = (async () => {
        const verdict = await probeSession();
        if (verdict === 'same' || verdict === 'unknown') return;
        const previous = viewerRef.current;
        const hadViewer = !!previous;
        invalidateSession(); // abort in-flight work and cancel pending retries of the old session
        let next: CurrentSessionDto | null = null;
        try {
          next = await restoreSession();
        } catch {
          next = null;
        }
        apply(next, hadViewer ? reason : null);
        if (previous && next) {
          setSwitchedNotice(
            next.id === previous.id
              ? 'Your session was renewed in another tab. Unsaved changes on this page were discarded.'
              : `This browser is now signed in as ${next.displayName} (changed in another tab). Unsaved changes for ${previous.displayName} were discarded.`,
          );
        }
      })().finally(() => {
        revalidating.current = null;
      });
      revalidating.current = run;
      return run;
    },
    [apply],
  );

  // Startup: restore the viewer, refreshing once if the access token expired while a refresh session is valid.
  useEffect(() => {
    let alive = true;
    restoreSession()
      .then((me) => alive && apply(me))
      .catch(() => alive && apply(null));
    return () => {
      alive = false;
    };
  }, [apply]);

  useEffect(
    () =>
      onSessionLost(() => {
        const hadViewer = !!viewerRef.current;
        invalidateSession();
        apply(null, hadViewer ? 'expired' : null);
        broadcast();
      }),
    [apply, broadcast],
  );

  useEffect(() => onIdentityChanged(() => void revalidate('elsewhere')), [revalidate]);

  // Other tabs, returning to a suspended tab, and back/forward-cache restores all re-check with the server.
  useEffect(() => {
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel(CHANNEL);
      channel.current.onmessage = (ev: MessageEvent<Signal>) => {
        if (ev.data?.type === 'session-changed') void revalidate('elsewhere');
      };
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void revalidate('elsewhere');
    };
    const onPageShow = (ev: PageTransitionEvent) => {
      if (ev.persisted) void revalidate('elsewhere');
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onVisible);
    return () => {
      channel.current?.close();
      channel.current = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onVisible);
    };
  }, [revalidate]);

  const login = useCallback(
    async (email: string, password: string) => {
      invalidateSession(); // nothing from a previous session may be retried under the new one
      setSwitchedNotice(null);
      await fetchCsrf('login'); // explicit PRE-LOGIN token, even if an old session cookie exists
      const res = await request<SessionResponse>('/auth/login', { method: 'POST', json: { email, password } });
      adoptSession(res.sessionContext, res.csrfToken); // CSRF rotated on login
      apply({ ...res.viewer, sessionContext: res.sessionContext });
      broadcast();
      return res.viewer;
    },
    [apply, broadcast],
  );

  /**
   * Confirmed only when the server answered 200 (session revoked, cookies cleared). Otherwise the protected UI is
   * still hidden and caches wiped, but the login page says the server-side session MAY still be active and offers
   * a retry — we never pretend a sign-out happened.
   */
  const logout = useCallback(async (): Promise<LogoutOutcome> => {
    let outcome: LogoutOutcome = 'confirmed';
    try {
      if (!currentSessionContext()) await restoreSession().catch(() => null); // retry path after a failed sign-out
      await request('/auth/logout', { method: 'POST' });
    } catch (e) {
      // SESSION_CHANGED: our session was already replaced (and revoked by that login) — nothing of ours remains.
      if (!(e instanceof ApiError && e.isSessionChanged)) outcome = 'unconfirmed';
    }
    invalidateSession();
    apply(null, outcome === 'unconfirmed' ? 'logout-unconfirmed' : null);
    setEndedReason(outcome === 'unconfirmed' ? 'logout-unconfirmed' : null);
    broadcast();
    return outcome;
  }, [apply, broadcast]);

  const dismissSwitchedNotice = useCallback(() => setSwitchedNotice(null), []);
  const value = useMemo(
    () => ({ status, viewer, sessionKey, endedReason, switchedNotice, dismissSwitchedNotice, login, logout }),
    [status, viewer, sessionKey, endedReason, switchedNotice, dismissSwitchedNotice, login, logout],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
