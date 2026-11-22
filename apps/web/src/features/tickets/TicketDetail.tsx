import { ArrowLeft, History, Link2, MessagesSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import { formatIst, ticketRef } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/lib/useMediaQuery';
import type { StaffMessage, Viewer } from '@/lib/types';
import { useAuth } from '../auth/auth';
import { fetchOlderStaffMessages, useAudit, useTicket } from './api';
import { useTimeline } from './useTimeline';
import { AuditList, SlaStory } from './audit';
import { PriorityBadge, StatusBadge } from './badges';
import { Composer } from './Composer';
import { SlaPanel, currentClocks } from './sla';
import { TicketActions } from './TicketActions';
import { Timeline, type TimelineMessage } from './Timeline';

const toTimeline = (m: StaffMessage): TimelineMessage => ({ id: m.id, body: m.body, createdAt: m.createdAt, authorName: m.author.displayName, authorIsCustomer: m.author.role === 'CUSTOMER', kind: m.kind });
const TABS = [
  { id: 'conversation', label: 'Conversation', icon: MessagesSquare },
  { id: 'history', label: 'SLA history & audit', icon: History },
] as const;

export function TicketDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { viewer } = useAuth();
  const q = useTicket(id);
  const scroller = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'conversation' | 'history'>('conversation');
  // Wide screens get a dedicated SLA rail; narrower ones show the clocks inline. Rendered in ONE place only.
  const rail = useMediaQuery('(min-width: 1440px)');
  const ticket = q.data;
  const recent = useMemo(() => ticket?.messages.map(toTimeline), [ticket?.messages]);
  const timeline = useTimeline({
    ticketId: id,
    recent,
    recentCursor: ticket?.olderMessagesCursor,
    fetchPage: async (cursor) => {
      const page = await fetchOlderStaffMessages(id, cursor);
      return { items: page.items.map(toTimeline), nextCursor: page.nextCursor };
    },
  });

  useEffect(() => setTab('conversation'), [id]);

  if (q.isPending)
    return (
      <div className="h-full bg-surface">
        <LoadingRows rows={4} />
      </div>
    );
  if (q.isError || !ticket || !viewer) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <ErrorState message={notFound ? 'This ticket does not exist or is not available to you.' : 'The ticket could not be loaded.'} onRetry={notFound ? onBack : () => void q.refetch()} />;
  }
  const { response, resolution } = currentClocks(ticket.clocks);

  return (
    <section aria-labelledby="ticket-title" className="flex h-full min-h-0 bg-surface">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* relative: contain absolutely positioned descendants (sr-only labels) inside this scroller; see TicketList. */}
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
          <header className="glass z-10 border-b border-line px-4 pb-4 pt-3 sm:px-6 lg:sticky lg:top-0">
            <Button size="sm" variant="ghost" className="-ml-2 mb-1.5 lg:hidden" onClick={onBack}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Back to list
            </Button>
            <div className="flex flex-wrap items-center gap-1.5 text-meta text-ink-3">
              <span className="mr-0.5 font-mono text-caption tracking-tight text-ink-2">{ticketRef(ticket.id)}</span>
              <PriorityBadge priority={ticket.priority} />
              <StatusBadge status={ticket.status} />
              {ticket.requestedPriority && ticket.requestedPriority !== ticket.priority ? <span className="ml-1">Customer asked for {ticket.requestedPriority.toLowerCase()}</span> : null}
              {ticket.parentTicketId ? (
                <span className="ml-1 inline-flex items-center gap-1">
                  <Link2 className="h-3 w-3" aria-hidden="true" /> Follow-up of {ticketRef(ticket.parentTicketId)}
                </span>
              ) : null}
            </div>
            <h2 id="ticket-title" className="mt-1.5 text-heading font-semibold tracking-[-0.015em] text-ink">
              {ticket.subject}
            </h2>
            <p className="mt-1 text-meta tabular-nums text-ink-3">
              <span className="font-medium text-ink-2">{ticket.assigneeDisplayName ? `Assigned to ${ticket.assigneeDisplayName}` : 'Unassigned'}</span>
              {` · Opened ${formatIst(ticket.createdAt)} · Updated ${formatIst(ticket.updatedAt)}`}
              {ticket.status === 'WAITING' && ticket.waitingCloseDueAt ? ` · Auto-closes after ${formatIst(ticket.waitingCloseDueAt)} without a reply` : ''}
              {ticket.status === 'RESOLVED' && ticket.reopenUntil ? ` · Customer can reopen until ${formatIst(ticket.reopenUntil)}` : ''}
            </p>
            <div className="mt-3 empty:hidden">
              <TicketActions ticket={ticket} viewer={viewer as Viewer} />
            </div>
          </header>

          {!rail ? (
            <div className="border-b border-line bg-surface-2 px-4 py-4 sm:px-6">
              <SlaPanel response={response} resolution={resolution} />
            </div>
          ) : null}

          <div className="px-4 sm:px-6">
            <div role="tablist" aria-label="Ticket sections" className="flex gap-4 border-b border-line">
              {TABS.map(({ id: t, label, icon: Icon }) => (
                <button
                  key={t}
                  role="tab"
                  id={`tab-${t}`}
                  aria-selected={tab === t}
                  aria-controls={`panel-${t}`}
                  tabIndex={tab === t ? 0 : -1}
                  onClick={() => setTab(t)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                      const next = tab === 'conversation' ? 'history' : 'conversation';
                      setTab(next);
                      document.getElementById(`tab-${next}`)?.focus();
                    }
                  }}
                  className={cn(
                    '-mb-px inline-flex h-11 items-center gap-1.5 border-b-2 text-body font-medium transition-colors duration-150',
                    tab === t ? 'border-brand text-ink' : 'border-transparent text-ink-3 hover:text-ink',
                  )}
                >
                  <Icon className={cn('h-4 w-4', tab === t ? 'text-brand' : '')} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === 'conversation' ? (
              <Timeline
                messages={timeline.messages}
                hasOlder={timeline.hasOlder}
                loadingOlder={timeline.loadingOlder}
                olderError={timeline.gapUnresolved ? 'Many messages arrived while this ticket was open; reload the page to see the full conversation.' : timeline.error}
                onLoadOlder={timeline.loadOlder}
                scrollParent={scroller}
                label="Conversation"
              />
            ) : (
              <HistoryTab id={id} />
            )}
          </div>
        </div>
        {tab === 'conversation' ? (
          <div className="border-t border-line bg-surface-2 px-3 py-3 sm:px-4">
            <div className="mx-auto max-w-3xl">
              <Composer ticket={ticket} canWrite={ticket.assigneeId === viewer.id} />
            </div>
          </div>
        ) : null}
      </div>

      {rail ? (
        <aside aria-label="Service levels" className="w-[19rem] shrink-0 overflow-y-auto border-l border-line bg-surface-2 p-4">
          <h3 className="mb-3 text-caption font-medium text-ink-3">Service levels</h3>
          <SlaPanel response={response} resolution={resolution} stacked />
        </aside>
      ) : null}
    </section>
  );
}

function HistoryTab({ id }: { id: string }) {
  const q = useAudit(id);
  const events = q.data?.pages.flatMap((p) => p.items) ?? [];
  if (q.isPending) return <LoadingRows rows={3} />;
  if (q.isError) return <ErrorState message="The audit history could not be loaded." onRetry={() => void q.refetch()} />;
  return (
    <div className="space-y-6">
      <SlaStory events={events} complete={!q.hasNextPage} />
      <AuditList events={events} hasMore={!!q.hasNextPage} loadingMore={q.isFetchingNextPage} onLoadMore={() => void q.fetchNextPage()} />
    </div>
  );
}
