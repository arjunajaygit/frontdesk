import { Link2, RefreshCw, SearchX } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Avatar, Tip } from '@/components/ui/identity';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { formatIstFull, formatIstShort, ticketRef } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Priority, StaffTicketSummary } from '@/lib/types';
import { useTicketList } from './api';
import { PriorityMark, StatusBadge } from './badges';
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
      {/* relative: the containing block for absolutely positioned descendants (e.g. sr-only labels), so they are clipped
          and scrolled with the list instead of extending the whole page (empty page scroll). */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {/* Sticky glass header: rows scroll beneath it, so the view title and filter stay in reach. */}
        <header className="glass sticky top-0 z-10 border-b border-line px-4 pb-3 pt-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 id="list-title" className="text-title font-semibold tracking-[-0.01em]">
                {title}
              </h2>
              <p className="mt-0.5 truncate text-meta text-ink-3">{blurb}</p>
            </div>
            <Tip label="Refresh">
              <Button size="icon-sm" variant="ghost" aria-label="Refresh ticket list" onClick={() => void q.refetch()} disabled={q.isFetching}>
                <RefreshCw className={cn('h-4 w-4', q.isFetching && 'animate-spin motion-reduce:animate-none')} aria-hidden="true" />
              </Button>
            </Tip>
          </div>
          <div className="mt-2.5 flex items-center gap-2">
            <label htmlFor="priority-filter" className="sr-only">
              Filter by priority
            </label>
            <Select id="priority-filter" size="sm" value={priority} onChange={(e) => onPriority(e.target.value as Priority | '')} className="w-36">
              <option value="">All priorities</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0] + p.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
            {items.length > 0 ? (
              <span className="ml-auto text-meta tabular-nums text-ink-3" aria-hidden="true">
                {items.length}
                {q.hasNextPage ? '+' : ''} shown
              </span>
            ) : null}
          </div>
        </header>

        {q.isPending ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState message="The ticket list could not be loaded." onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="No tickets here" icon={priority ? SearchX : undefined}>
            Nothing matches this view{priority ? ' and priority' : ''} right now.
          </EmptyState>
        ) : (
          <>
            <ul aria-label={`${title} tickets`}>
              {items.map((t) => (
                <li key={t.id}>
                  <Row ticket={t} selected={t.id === selectedId} href={hrefFor(t.id)} />
                </li>
              ))}
            </ul>
            <div className="flex flex-col items-center gap-1.5 px-4 py-5">
              {q.hasNextPage ? (
                <Button size="sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                  {q.isFetchingNextPage ? 'Loading…' : 'Load more tickets'}
                </Button>
              ) : (
                <span className="text-meta text-ink-3">End of list</span>
              )}
              <span className="text-caption tabular-nums text-ink-3" aria-live="polite">
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
  const late = !!(response?.currentLate && response.state !== 'COMPLETED' && response.state !== 'CANCELLED') || !!(resolution?.currentLate && resolution.state !== 'COMPLETED' && resolution.state !== 'CANCELLED');
  return (
    <Link
      to={href}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group relative block border-b border-line px-4 py-3 transition-colors duration-150 hover:bg-surface-2',
        selected && 'bg-brand-soft/70 hover:bg-brand-soft/90',
        // Left edge: teal = selected, red = a clock is overdue right now (also stated in text by the SLA pills).
        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[""]',
        selected ? 'before:bg-brand' : late ? 'before:bg-danger/80' : 'before:bg-transparent',
      )}
    >
      <div className="flex items-center gap-2 text-meta text-ink-3">
        <PriorityMark priority={t.priority} />
        <span aria-hidden="true" className="text-ink-3">
          ·
        </span>
        <span className="whitespace-nowrap font-mono text-caption tracking-tight">{ticketRef(t.id)}</span>
        {t.parentTicketId ? (
          <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-caption" title="Linked follow-up ticket">
            <Link2 className="h-3 w-3" aria-hidden="true" />
            Linked
          </span>
        ) : null}
        <time dateTime={t.createdAt} title={formatIstFull(t.createdAt)} className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
          {formatIstShort(t.createdAt)}
          <span className="sr-only"> IST</span>
        </time>
      </div>
      <div className="mt-1 flex items-center gap-3">
        <p className={cn('min-w-0 flex-1 truncate text-ui font-medium', selected ? 'text-brand-ink' : 'text-ink')}>{t.subject}</p>
        <span className="inline-flex max-w-[40%] shrink-0 items-center gap-1.5 text-meta text-ink-2">
          <Avatar name={t.assigneeDisplayName} size="sm" tone="brand" />
          <span className={cn('truncate', !t.assigneeDisplayName && 'text-ink-3')}>{t.assigneeDisplayName ?? 'Unassigned'}</span>
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={t.status} />
        <SlaPill clock={response} />
        <SlaPill clock={resolution} />
      </div>
    </Link>
  );
}
