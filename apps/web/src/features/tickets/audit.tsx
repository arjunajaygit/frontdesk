import { History, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatIst, formatIstFull, formatWorking, priorityLabel, statusLabel } from '@/lib/format';
import type { AuditEvent, Priority, Status } from '@/lib/types';

const kind = (k: string) => (k === 'RESPONSE' ? 'Response' : 'Resolution');
const when = (iso?: string | null) => (iso ? formatIst(iso) : '—');

const ACTOR: Record<string, string> = { AGENT: 'Agent', LEAD: 'Support lead', ADMIN: 'Admin', CUSTOMER: 'Customer', SYSTEM: 'System' };

/**
 * Renders the discriminated audit union as sentences. Unknown actions fall back to a neutral label — never to
 * raw JSON. All numbers/times come from the immutable events; nothing is recomputed in the browser.
 */
export function describeAudit(e: AuditEvent): string {
  const d = e.details;
  switch (e.action) {
    case 'TICKET_CREATED': {
      const clocks = (d.clocks ?? []) as { kind: string; deadlineAt: string | null; budgetMs: number }[];
      const parts = clocks.map((c) => `${kind(c.kind)} due ${when(c.deadlineAt)} (${formatWorking(c.budgetMs)} working time)`);
      return `Ticket created at ${priorityLabel[d.priority as Priority]} priority${d.parentTicketId ? ' as a linked follow-up' : ''}. ${parts.join('; ')}.`;
    }
    case 'TICKET_CLAIMED':
      return `Claimed: ${statusLabel[d.beforeStatus as Status]} → ${statusLabel[d.afterStatus as Status]}.`;
    case 'TICKET_REASSIGNED':
      return 'Assignment changed.';
    case 'MESSAGE_PUBLISHED': {
      const what = d.messageKind === 'INTAKE' ? 'Original request recorded' : d.messageKind === 'REQUEST' ? 'Information request published' : 'Public reply published';
      return `${what}; visible in Frontdesk from ${when(d.publishedAt)} (recorded publication time, not proof of delivery).`;
    }
    case 'INTERNAL_NOTE_ADDED':
      return 'Internal note added (content not stored in audit).';
    case 'PRIORITY_CHANGED': {
      const revs = (d.clocks ?? []) as { before: { kind: string; budgetMs: number }; after: { budgetMs: number; deadlineAt: string | null; currentLate: boolean; consumedMs: number } }[];
      const parts = revs.map((r) => `${kind(r.before.kind)} budget ${formatWorking(r.before.budgetMs)} → ${formatWorking(r.after.budgetMs)} with ${formatWorking(r.after.consumedMs)} already used${r.after.deadlineAt ? `, new deadline ${when(r.after.deadlineAt)}` : r.after.currentLate ? ', now over budget' : ''}`);
      return `Priority ${priorityLabel[d.previousPriority as Priority]} → ${priorityLabel[d.newPriority as Priority]}. Elapsed time was kept, not reset. ${parts.join('; ')}${parts.length ? '.' : ''}`;
    }
    case 'SLA_PAUSED':
      return `Resolution clock paused while waiting on the customer; auto-close if no reply by ${when(d.waitingCloseDueAt)}.`;
    case 'SLA_RESUMED':
      return `Customer replied; resolution clock resumed${d.clock?.after?.deadlineAt ? `, new deadline ${when(d.clock.after.deadlineAt)}` : ''}.`;
    case 'SLA_BREACHED':
      return `${kind(d.clock.kind)} SLA breached${d.cause === 'PRIORITY_ESCALATION' ? ' by a priority change' : ''}: ${d.missedDeadlineAt ? `the deadline of ${formatIstFull(d.missedDeadlineAt)} passed` : 'time used exceeded the new budget'}; overdue from ${formatIstFull(d.breachedAt)}; recorded ${formatIstFull(d.recordedAt)}.`;
    case 'SLA_COMPLETED':
      return `${kind(d.clock.after.kind)} clock completed${d.clock.after.currentLate ? ' (late)' : ' on time'}.`;
    case 'SLA_CANCELLED':
      return `${kind(d.clock.after.kind)} clock cancelled (auto-close; not a resolution).`;
    case 'TICKET_WAITING':
      return `Waiting on customer since ${when(d.waitingSince)}.`;
    case 'TICKET_RESUMED':
      return 'Back in progress after the customer replied.';
    case 'TICKET_RESOLVED':
      return `Resolved; customer can reopen until ${when(d.reopenUntil)}.`;
    case 'TICKET_CLOSED':
      return `Closed (${d.closeReason === 'AUTO_CLOSED_NO_REPLY' ? 'no customer reply within five working days' : 'reopen window expired'}).`;
    case 'TICKET_REOPENED':
      return `Reopened by the customer (resolution cycle ${Number(d.resolutionCycle) + 1}); the first response clock was not restarted.`;
    case 'LINKED_TICKET_CREATED':
      return 'A new linked ticket was created for the customer’s follow-up.';
    default:
      return 'Activity recorded.';
  }
}

const SLA_ACTIONS = new Set(['TICKET_CREATED', 'PRIORITY_CHANGED', 'SLA_PAUSED', 'SLA_RESUMED', 'SLA_BREACHED', 'SLA_COMPLETED', 'SLA_CANCELLED', 'MESSAGE_PUBLISHED', 'TICKET_RESOLVED', 'TICKET_CLOSED', 'TICKET_REOPENED']);

export function SlaStory({ events, complete }: { events: AuditEvent[]; complete: boolean }) {
  const breached = events.some((e) => e.action === 'SLA_BREACHED');
  const story = events.filter((e) => SLA_ACTIONS.has(e.action) && !(e.action === 'MESSAGE_PUBLISHED' && e.details.messageKind === 'INTAKE'));
  if (!story.length) return null;
  return (
    <section aria-labelledby="sla-story" className="rounded-lg border border-line bg-surface p-3">
      <h3 id="sla-story" className="flex items-center gap-2 text-sm font-semibold">
        <History className="h-4 w-4 text-ink-3" aria-hidden="true" />
        {breached ? 'Why was this ticket late?' : 'SLA history'}
      </h3>
      <p className="mt-1 text-xs text-ink-3">Reconstructed from immutable audit events. Historical breaches stay on record even after the current status recovers.{complete ? '' : ' Showing loaded events; load more below for the full trail.'}</p>
      <ol className="mt-2 space-y-2 border-l border-line pl-3">
        {story.map((e) => (
          <li key={e.id} className="text-[13px]">
            <span className="text-xs text-ink-3">{formatIst(e.createdAt)} · </span>
            {describeAudit(e)}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function AuditList({ events, hasMore, loadingMore, onLoadMore }: { events: AuditEvent[]; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void }) {
  return (
    <div className="space-y-3">
      <ol className="space-y-2" aria-label="Audit events">
        {events.map((e) => (
          <li key={e.id} className="rounded-lg border border-line bg-surface p-3 text-[13px]">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-ink-3">
              <Badge tone="neutral">{e.action.replace(/_/g, ' ').toLowerCase()}</Badge>
              <span className="font-medium text-ink-2">{ACTOR[e.actorType] ?? e.actorType}</span>
              <time dateTime={e.createdAt} className="ml-auto" title={`Recorded ${new Date(e.createdAt).toISOString()} (UTC)`}>
                recorded {formatIstFull(e.createdAt)}
              </time>
            </div>
            <p className="text-ink">{describeAudit(e)}</p>
          </li>
        ))}
      </ol>
      {hasMore ? (
        <Button size="sm" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more events'}
        </Button>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-ink-3">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> End of audit trail. Events are append-only; times are recording times in IST.
        </p>
      )}
    </div>
  );
}
