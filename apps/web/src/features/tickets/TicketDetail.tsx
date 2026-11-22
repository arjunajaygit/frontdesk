import { ArrowLeft, Link2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingRows } from '@/components/ui/states';
import { ApiError } from '@/lib/api';
import { formatIst, ticketRef } from '@/lib/format';
import type { StaffMessage, Viewer } from '@/lib/types';
import { useAuth } from '../auth/auth';
import { fetchOlderStaffMessages, useAudit, useTicket } from './api';
import { useTimeline } from './useTimeline';
import { AuditList, SlaStory } from './audit';
import { PriorityBadge, StatusBadge } from './badges';
import { Composer } from './Composer';
import { SlaCard, currentClocks } from './sla';
import { TicketActions } from './TicketActions';
import { Timeline, type TimelineMessage } from './Timeline';

const toTimeline = (m: StaffMessage): TimelineMessage => ({ id: m.id, body: m.body, createdAt: m.createdAt, authorName: m.author.displayName, authorIsCustomer: m.author.role === 'CUSTOMER', kind: m.kind });

export function TicketDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { viewer } = useAuth();
  const q = useTicket(id);
  const scroller = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'conversation' | 'history'>('conversation');
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

  if (q.isPending) return <div className="bg-surface"><LoadingRows rows={4} /></div>;
  if (q.isError || !ticket || !viewer) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <ErrorState message={notFound ? 'This ticket does not exist or is not available to you.' : 'The ticket could not be loaded.'} onRetry={notFound ? onBack : () => void q.refetch()} />;
  }
  const { response, resolution } = currentClocks(ticket.clocks);

  return (
    <section aria-labelledby="ticket-title" className="flex h-full min-h-0 flex-col bg-canvas">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <header className="border-b border-line bg-surface p-4">
          <Button size="sm" variant="ghost" className="mb-2 lg:hidden" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to list
          </Button>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
            <span className="font-mono">{ticketRef(ticket.id)}</span>
            <PriorityBadge priority={ticket.priority} />
            <StatusBadge status={ticket.status} />
            {ticket.requestedPriority && ticket.requestedPriority !== ticket.priority ? <span>Customer asked for {ticket.requestedPriority.toLowerCase()}</span> : null}
            {ticket.parentTicketId ? (
              <span className="inline-flex items-center gap-1">
                <Link2 className="h-3 w-3" aria-hidden="true" /> Follow-up of {ticketRef(ticket.parentTicketId)}
              </span>
            ) : null}
          </div>
          <h2 id="ticket-title" className="mt-1 text-lg font-semibold leading-snug">
            {ticket.subject}
          </h2>
          <p className="mt-1 text-xs text-ink-2">
            Opened {formatIst(ticket.createdAt)} · {ticket.assigneeDisplayName ? `Assigned to ${ticket.assigneeDisplayName}` : 'Unassigned'} · Updated {formatIst(ticket.updatedAt)}
            {ticket.status === 'WAITING' && ticket.waitingCloseDueAt ? ` · Auto-closes after ${formatIst(ticket.waitingCloseDueAt)} without a reply` : ''}
            {ticket.status === 'RESOLVED' && ticket.reopenUntil ? ` · Customer can reopen until ${formatIst(ticket.reopenUntil)}` : ''}
          </p>
          <div className="mt-3">
            <TicketActions ticket={ticket} viewer={viewer as Viewer} />
          </div>
        </header>

        <div className="grid grid-cols-1 gap-3 p-4 xl:grid-cols-2">
          {response ? <SlaCard clock={response} /> : null}
          {resolution ? <SlaCard clock={resolution} /> : null}
        </div>

        <div className="px-4">
          <div role="tablist" aria-label="Ticket sections" className="flex gap-1 border-b border-line">
            {(['conversation', 'history'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                id={`tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`panel-${t}`}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') setTab(tab === 'conversation' ? 'history' : 'conversation');
                }}
                className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-medium ${tab === t ? 'border-brand text-brand-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
              >
                {t === 'conversation' ? 'Conversation' : 'SLA history & audit'}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
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
        <div className="border-t border-line bg-surface p-3">
          <Composer ticket={ticket} canWrite={ticket.assigneeId === viewer.id} />
        </div>
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
    <div className="space-y-4">
      <SlaStory events={events} complete={!q.hasNextPage} />
      <AuditList events={events} hasMore={!!q.hasNextPage} loadingMore={q.isFetchingNextPage} onLoadMore={() => void q.fetchNextPage()} />
    </div>
  );
}
