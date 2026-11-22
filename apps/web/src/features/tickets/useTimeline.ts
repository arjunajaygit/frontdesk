import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { mergeMessages, type TimelineMessage } from './Timeline';

export interface TimelinePage {
  items: TimelineMessage[];
  nextCursor: string | null;
}

/** Safety bound for gap reconciliation (pages of 50): beyond this we tell the user instead of looping. */
export const MAX_GAP_PAGES = 20;

interface State {
  ticketId: string;
  held: Map<string, TimelineMessage>;
  /** Cursor for messages OLDER than everything held; undefined = not initialised yet. */
  boundary: string | null | undefined;
  loading: boolean;
  error: string | null;
  gapUnresolved: boolean;
  /** Gaps still to fill, oldest-detected first: walk older from `cursor` until a message in `stopAt` is reached. */
  gaps: Array<{ cursor: string; stopAt: Set<string> }>;
  walking: boolean;
}
const empty = (ticketId: string): State => ({ ticketId, held: new Map(), boundary: undefined, loading: false, error: null, gapUnresolved: false, gaps: [], walking: false });

/**
 * One timeline for staff and customer views.
 *
 * `recent` is the newest page returned by the ticket detail endpoint and is REPLACED on every refetch. If more
 * than a page of messages arrived since the previous refetch, the new page no longer overlaps what we already
 * hold; we then walk the real `/messages` endpoint from the new page's cursor until we reach a message we
 * already have, so nothing is lost and nothing is duplicated (merge is by id, ordered by (createdAt, id)).
 *
 * The bookkeeping lives in a ref that is mutated synchronously (React state updaters run lazily and must not be
 * used to read-then-decide); a version counter triggers re-renders.
 *
 * Gap walks are QUEUED on the per-ticket store and are deliberately NOT cancelled when another refetch arrives:
 * a later page that overlaps the earlier one detects no gap of its own, so cancelling would leave a permanent
 * hole. A walk stops only when the ticket changes (new store) or the component unmounts.
 */
export function useTimeline(opts: { ticketId: string; recent: TimelineMessage[] | undefined; recentCursor: string | null | undefined; fetchPage: (cursor: string) => Promise<TimelinePage> }) {
  const { ticketId, recent, recentCursor, fetchPage } = opts;
  const store = useRef<State>(empty(ticketId));
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  if (store.current.ticketId !== ticketId) store.current = empty(ticketId); // never carry messages across tickets

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const drainGaps = useCallback(
    async (st: State) => {
      if (st.walking) return; // the running walker picks up newly queued gaps
      st.walking = true;
      const alive = () => mounted.current && store.current === st;
      try {
        while (st.gaps.length && alive()) {
          const gap = st.gaps[0]!;
          let cursor: string | null = gap.cursor;
          let reached = false;
          for (let i = 0; i < MAX_GAP_PAGES && cursor; i++) {
            let page: TimelinePage;
            try {
              page = await fetchRef.current(cursor);
            } catch {
              break; // reported below as unresolved; never silently ignored
            }
            if (!alive()) return;
            for (const m of page.items) st.held.set(m.id, m);
            bump();
            if (page.items.some((m) => gap.stopAt.has(m.id))) {
              reached = true;
              break;
            }
            cursor = page.nextCursor;
            if (!cursor) reached = true; // reached the start of the conversation
          }
          st.gaps.shift();
          if (!reached) st.gapUnresolved = true;
        }
      } finally {
        st.walking = false;
        if (alive()) bump();
      }
    },
    [bump],
  );

  useEffect(() => {
    if (!recent) return;
    const st = store.current;
    if (st.ticketId !== ticketId) return;
    const heldBefore = new Set(st.held.keys());
    const first = st.boundary === undefined;
    for (const m of recent) st.held.set(m.id, m);
    if (first) st.boundary = recentCursor ?? null;
    bump();
    if (first || !recentCursor || recent.some((m) => heldBefore.has(m.id))) return; // contiguous: nothing missing
    st.gaps.push({ cursor: recentCursor, stopAt: heldBefore });
    void drainGaps(st);
  }, [ticketId, recent, recentCursor, bump, drainGaps]);

  const loadOlder = useCallback(async () => {
    const st = store.current;
    const cursor = st.boundary;
    if (!cursor || st.loading) return;
    st.loading = true;
    st.error = null;
    bump();
    try {
      const page = await fetchRef.current(cursor);
      if (store.current !== st) return;
      for (const m of page.items) st.held.set(m.id, m);
      st.boundary = page.nextCursor;
    } catch (e) {
      st.error = e instanceof ApiError ? e.message : 'Could not load older messages.';
    } finally {
      st.loading = false;
      if (store.current === st) bump();
    }
  }, [bump]);

  const messages = useMemo(() => mergeMessages([...store.current.held.values()]), [version, ticketId]);
  const st = store.current;
  return { messages, hasOlder: !!st.boundary, loadingOlder: st.loading, error: st.error, gapUnresolved: st.gapUnresolved, loadOlder: () => void loadOlder() };
}
