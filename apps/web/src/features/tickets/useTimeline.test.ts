import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineMessage } from './Timeline';
import { MAX_GAP_PAGES, useTimeline, type TimelinePage } from './useTimeline';

const T0 = Date.parse('2026-11-23T04:00:00.000Z');
const msg = (n: number): TimelineMessage => ({ id: `m${String(n).padStart(5, '0')}`, body: `message ${n}`, createdAt: new Date(T0 + n * 1000).toISOString(), authorName: 'a', authorIsCustomer: false });
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => msg(a + i));
const ids = (ms: TimelineMessage[]) => ms.map((m) => m.id);
const numbers = (ms: TimelineMessage[]) => ms.map((m) => Number(m.id.slice(1)));

/** Fake server: `all` is the full conversation; cursor "before:N" returns the 50 messages older than N (chronological). */
function server(total: { n: number }) {
  const calls: string[] = [];
  const page = (before: number): TimelinePage => {
    const items = range(Math.max(1, before - 50), before - 1).filter((m) => Number(m.id.slice(1)) >= 1);
    return { items, nextCursor: before - 50 > 1 ? `before:${before - 50}` : null };
  };
  const fetchPage = vi.fn(async (cursor: string) => {
    calls.push(cursor);
    return page(Number(cursor.split(':')[1]));
  });
  const recent = (): { items: TimelineMessage[]; cursor: string | null } => {
    const lo = Math.max(1, total.n - 49);
    return { items: range(lo, total.n), cursor: lo > 1 ? `before:${lo}` : null };
  };
  return { fetchPage, calls, recent };
}

describe('useTimeline: > 50 messages arriving while a ticket is open', () => {
  it('reconciles the gap: nothing lost, nothing duplicated, older paging still works afterwards', async () => {
    const total = { n: 1000 };
    const srv = server(total);
    let { items, cursor } = srv.recent();
    const { result, rerender } = renderHook((p: { recent: TimelineMessage[]; cursor: string | null }) => useTimeline({ ticketId: 't1', recent: p.recent, recentCursor: p.cursor, fetchPage: srv.fetchPage }), {
      initialProps: { recent: items, cursor },
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(50));
    await act(async () => result.current.loadOlder()); // user loaded one older page (901..950)
    await waitFor(() => expect(result.current.messages).toHaveLength(100));
    expect(numbers(result.current.messages)[0]).toBe(901);

    total.n = 1060; // 60 new messages arrive; the refetched "recent" page (1011..1060) no longer overlaps 951..1000
    ({ items, cursor } = srv.recent());
    rerender({ recent: items, cursor });
    // Wait for the RECONCILED state: the newest page is merged (and rendered) before the gap walk finishes.
    const expected = Array.from({ length: 1060 - 901 + 1 }, (_, i) => 901 + i); // contiguous 901..1060
    await waitFor(() => expect(numbers(result.current.messages)).toEqual(expected));

    const nums = numbers(result.current.messages);
    expect(nums).toEqual(expected);
    expect(new Set(ids(result.current.messages)).size).toBe(nums.length); // no duplicates
    expect(result.current.gapUnresolved).toBe(false);
    expect(srv.calls).toEqual(['before:951', 'before:1011']); // the gap walk started from the NEW page's cursor, stopped at the overlap

    await act(async () => result.current.loadOlder()); // the older boundary is still the one below 901
    await waitFor(() => expect(result.current.messages).toHaveLength(nums.length + 50));
    expect(srv.calls.at(-1)).toBe('before:901');
    expect(result.current.hasOlder).toBe(true);
  });

  it('a normal refetch with a few new messages needs no extra requests', async () => {
    const total = { n: 120 };
    const srv = server(total);
    let { items, cursor } = srv.recent();
    const { result, rerender } = renderHook((p: { recent: TimelineMessage[]; cursor: string | null }) => useTimeline({ ticketId: 't1', recent: p.recent, recentCursor: p.cursor, fetchPage: srv.fetchPage }), {
      initialProps: { recent: items, cursor },
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(50));
    total.n = 123;
    ({ items, cursor } = srv.recent());
    rerender({ recent: items, cursor });
    await waitFor(() => expect(numbers(result.current.messages).at(-1)).toBe(123));
    expect(srv.fetchPage).not.toHaveBeenCalled();
    expect(result.current.messages).toHaveLength(53);
  });

  it('short conversations (no older cursor) never fetch, and switching tickets does not leak messages', async () => {
    const srv = server({ n: 5 });
    const a = srv.recent();
    const { result, rerender } = renderHook((p: { id: string; recent: TimelineMessage[]; cursor: string | null }) => useTimeline({ ticketId: p.id, recent: p.recent, recentCursor: p.cursor, fetchPage: srv.fetchPage }), {
      initialProps: { id: 'a', recent: a.items, cursor: a.cursor },
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(5));
    expect(result.current.hasOlder).toBe(false);
    rerender({ id: 'b', recent: range(100, 102), cursor: null });
    await waitFor(() => expect(numbers(result.current.messages)).toEqual([100, 101, 102]));
  });

  it('an enormous gap stops after the safety bound and says so instead of looping', async () => {
    const total = { n: 100 };
    const srv = server(total);
    let { items, cursor } = srv.recent();
    const { result, rerender } = renderHook((p: { recent: TimelineMessage[]; cursor: string | null }) => useTimeline({ ticketId: 't1', recent: p.recent, recentCursor: p.cursor, fetchPage: srv.fetchPage }), {
      initialProps: { recent: items, cursor },
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(50));
    total.n = 100 + 50 * (MAX_GAP_PAGES + 5); // far more than the bound
    ({ items, cursor } = srv.recent());
    rerender({ recent: items, cursor });
    await waitFor(() => expect(result.current.gapUnresolved).toBe(true));
    expect(srv.calls.length).toBe(MAX_GAP_PAGES);
  });

  it('a refetch that lands while a gap walk is in flight does not leave a hole (walk is not cancelled)', async () => {
    const total = { n: 200 };
    const srv = server(total);
    const gate: Array<() => void> = [];
    const slow = vi.fn(async (cursor: string) => {
      await new Promise<void>((r) => gate.push(r)); // each page resolves only when released
      return srv.fetchPage(cursor);
    });
    let { items, cursor } = srv.recent();
    const { result, rerender } = renderHook((p: { recent: TimelineMessage[]; cursor: string | null }) => useTimeline({ ticketId: 't1', recent: p.recent, recentCursor: p.cursor, fetchPage: slow }), {
      initialProps: { recent: items, cursor },
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(50)); // 151..200
    total.n = 320; // 120 new: recent 271..320, gap 201..270
    ({ items, cursor } = srv.recent());
    rerender({ recent: items, cursor });
    await waitFor(() => expect(gate).toHaveLength(1)); // gap walk is waiting on its first page
    total.n = 330; // a second refetch overlaps the previous recent page (no new gap of its own)
    ({ items, cursor } = srv.recent());
    rerender({ recent: items, cursor });
    for (let i = 0; i < 5 && result.current.messages.length < 180; i++) {
      await act(async () => {
        while (gate.length) gate.shift()!();
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    await waitFor(() => expect(numbers(result.current.messages)).toEqual(Array.from({ length: 180 }, (_, i) => 151 + i)));
    expect(result.current.gapUnresolved).toBe(false);
  });

  it('a failed gap page is reported, never silently ignored', async () => {
    const total = { n: 100 };
    const srv = server(total);
    const failing = vi.fn(async () => {
      throw new Error('network');
    });
    let { items, cursor } = srv.recent();
    const { result, rerender } = renderHook((p: { recent: TimelineMessage[]; cursor: string | null }) => useTimeline({ ticketId: 't1', recent: p.recent, recentCursor: p.cursor, fetchPage: failing }), {
      initialProps: { recent: items, cursor },
    });
    await waitFor(() => expect(result.current.messages).toHaveLength(50));
    total.n = 170;
    ({ items, cursor } = srv.recent());
    rerender({ recent: items, cursor });
    await waitFor(() => expect(result.current.gapUnresolved).toBe(true));
  });
});
