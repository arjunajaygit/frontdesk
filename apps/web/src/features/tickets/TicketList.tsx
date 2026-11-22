import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { formatIst, ticketRef } from '@/lib/format';
import type { Priority, StaffTicketSummary } from '@/lib/types';
import { useTicketList } from './api';
import { PriorityBadge, StatusBadge } from './badges';
import { SlaPill, currentClocks } from './sla';
import { PRIORITIES, type ViewFilter } from './views';

export function TicketList({
  title,
  blurb,
  filter,
  priority,
  onPriority,
  selectedId,
  hrefFor,
}: {
  title: string;
  blurb: string;
  filter: ViewFilter;
  priority: Priority | '';
  onPriority: (p: Priority | '') => void;
  selectedId: string | null;
  hrefFor: (id: string) => string;
}) {
  const q = useTicketList(filter, priority);
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section aria-labelledby="list-title" className="flex h-full min-h-0 flex-col bg-surface">
      <header className="border-b border-line p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 id="list-title" className="text-sm font-semibold">
              {title}
            </h2>
            <p className="text-xs text-ink-3">{blurb}</p>
          </div>
          <Button size="icon" variant="ghost" aria-label="Refresh ticket list" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor="priority-filter" className="text-xs font-semibold text-ink-2">
            Filter by priority
          </label>
          <Select id="priority-filter" value={priority} onChange={(e) => onPriority(e.target.value as Priority | '')} className="max-w-40">
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p[0] + p.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </div>
      </header>
      {/* relative: the containing block for absolutely positioned descendants (e.g. sr-only labels), so they are clipped
          and scrolled with the list instead of extending the whole page (empty page scroll). */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {q.isPending ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState message="The ticket list could not be loaded." onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="No tickets here">Nothing matches this view{priority ? ' and priority' : ''} right now.</EmptyState>
        ) : (
          <>
            <ul aria-label={`${title} tickets`}>
              {items.map((t) => (
                <li key={t.id}>
                  <Row ticket={t} selected={t.id === selectedId} href={hrefFor(t.id)} />
                </li>
              ))}
            </ul>
            <div className="flex flex-col items-center gap-1 p-3">
              {q.hasNextPage ? (
                <Button size="sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                  {q.isFetchingNextPage ? 'Loading…' : 'Load more tickets'}
                </Button>
              ) : (
                <span className="text-xs text-ink-3">End of list</span>
              )}
              <span className="text-xs text-ink-3" aria-live="polite">
                {items.length} loaded
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Row({ ticket: t, selected, href }: { ticket: StaffTicketSummary; selected: boolean; href: string }) {
  const { response, resolution } = currentClocks(t.clocks);
  return (
    <Link
      to={href}
      aria-current={selected ? 'true' : undefined}
      className={`block border-b border-line px-3 py-2.5 hover:bg-canvas ${selected ? 'bg-brand-soft shadow-[inset_3px_0_0_var(--color-brand)]' : ''}`}
    >
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <span className="font-mono">{ticketRef(t.id)}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={t.createdAt}>{formatIst(t.createdAt)}</time>
        {t.parentTicketId ? <Badge tone="neutral">Linked</Badge> : null}
      </div>
      <p className="mt-0.5 truncate text-[13px] font-semibold text-ink">{t.subject}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={t.priority} />
        <StatusBadge status={t.status} />
        <span className="text-xs text-ink-2">{t.assigneeDisplayName ?? 'Unassigned'}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <SlaPill clock={response} />
        <SlaPill clock={resolution} />
      </div>
    </Link>
  );
}
