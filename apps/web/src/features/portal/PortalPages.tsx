import { Download, Headset, LogOut, Plus, RotateCcw } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { ApiError, newIdempotencyKey } from '@/lib/api';
import { formatIst, statusLabel } from '@/lib/format';
import type { Priority, PublicMessage, PublicTicketSummary, Status } from '@/lib/types';
import { useAuth } from '../auth/auth';
import { Timeline, type TimelineMessage } from '../tickets/Timeline';
import { useTimeline } from '../tickets/useTimeline';
import { fetchOlderPublicMessages, useCreatePortalTicket, usePortalContact, usePortalList, usePortalTicket } from './api';

const STATUS_TONE: Record<Status, 'info' | 'brand' | 'warn' | 'ok' | 'neutral'> = { OPEN: 'info', IN_PROGRESS: 'brand', WAITING: 'warn', RESOLVED: 'ok', CLOSED: 'neutral' };
const toTimeline = (m: PublicMessage): TimelineMessage => ({ id: m.id, body: m.body, createdAt: m.createdAt, authorName: m.authorDisplayName, authorIsCustomer: m.authorType === 'CUSTOMER' });

/** Customer-facing shell: its own layout, its own cache namespace, public DTOs only. */
export function PortalLayout() {
  const { viewer, logout } = useAuth();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="nav-surface bg-nav text-white">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <Headset className="h-5 w-5 text-[#7ee0d4]" aria-hidden="true" />
          <Link to="/portal" className="font-semibold">
            Frontdesk <span className="font-normal text-nav-text">support portal</span>
          </Link>
          <span className="ml-auto hidden text-[13px] text-nav-text sm:inline" data-testid="viewer-name">
            {viewer?.displayName}
          </span>
          <Button variant="nav" size="sm" onClick={() => void logout()}>
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 p-4">
        <Outlet />
      </main>
    </div>
  );
}

export function PortalList() {
  const q = usePortalList();
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section aria-labelledby="my-tickets">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 id="my-tickets" className="text-lg font-semibold">
          Your tickets
        </h1>
        <Button variant="primary" asChild>
          <Link to="/portal/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New ticket
          </Link>
        </Button>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {q.isPending ? (
          <LoadingRows />
        ) : q.isError ? (
          <ErrorState message="Your tickets could not be loaded." onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="No tickets yet">Create a ticket and our team will respond within our service targets.</EmptyState>
        ) : (
          <>
            <ul aria-label="Your tickets">
              {items.map((t) => (
                <li key={t.id}>
                  <Row t={t} />
                </li>
              ))}
            </ul>
            {q.hasNextPage ? (
              <div className="p-3 text-center">
                <Button size="sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                  Load more tickets
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}

const Row = ({ t }: { t: PublicTicketSummary }) => (
  <Link to={`/portal/tickets/${t.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 last:border-b-0 hover:bg-canvas">
    <span className="min-w-0 flex-1 truncate font-semibold">{t.subject}</span>
    {t.parentTicketId ? <Badge tone="neutral">Follow-up</Badge> : null}
    <Badge tone={STATUS_TONE[t.status]}>{statusLabel[t.status]}</Badge>
    <time dateTime={t.createdAt} className="text-xs text-ink-3">
      {formatIst(t.createdAt)}
    </time>
  </Link>
);

export function PortalNew() {
  const nav = useNavigate();
  const create = useCreatePortalTicket();
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [pref, setPref] = useState<Priority | ''>('');
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate(
      { input: { subject: subject.trim(), body: body.trim(), ...(pref ? { requestedPriority: pref } : {}) }, key: newIdempotencyKey() },
      {
        onSuccess: (t) => {
          toast.push('ok', 'Your ticket was created.');
          nav(`/portal/tickets/${t.id}`);
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create your ticket. Please try again.'),
      },
    );
  };
  return (
    <section aria-labelledby="new-title" className="mx-auto max-w-xl">
      <h1 id="new-title" className="mb-3 text-lg font-semibold">
        New ticket
      </h1>
      <form onSubmit={submit} className="space-y-3 rounded-lg border border-line bg-surface p-4">
        <Field label="Subject">{(p) => <Input {...p} required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
        <Field label="What do you need help with?">{(p) => <Textarea {...p} required maxLength={10_000} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        <Field label="How urgent is this for you?" hint="Our team confirms the final priority and its service targets.">
          {(p) => (
            <Select {...p} value={pref} onChange={(e) => setPref(e.target.value as Priority | '')}>
              <option value="">No preference</option>
              <option value="URGENT">Urgent</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </Select>
          )}
        </Field>
        {error ? (
          <p role="alert" className="text-[13px] font-medium text-danger-ink">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button asChild>
            <Link to="/portal">Cancel</Link>
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending || !subject.trim() || !body.trim()}>
            {create.isPending ? 'Creating…' : 'Create ticket'}
          </Button>
        </div>
      </form>
    </section>
  );
}

export function PortalTicket() {
  const { id = '' } = useParams();
  const location = useLocation();
  const linkedFrom = (location.state as { linkedFrom?: string } | null)?.linkedFrom;
  const q = usePortalTicket(id);
  const scroller = useRef<HTMLDivElement>(null);
  const t = q.data;
  const recent = useMemo(() => t?.messages.map(toTimeline), [t?.messages]);
  const timeline = useTimeline({
    ticketId: id,
    recent,
    recentCursor: t?.olderMessagesCursor,
    fetchPage: async (cursor) => {
      const page = await fetchOlderPublicMessages(id, cursor);
      return { items: page.items.map(toTimeline), nextCursor: page.nextCursor };
    },
  });

  if (q.isPending) return <LoadingRows rows={4} />;
  if (q.isError || !t) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return <ErrorState message={missing ? 'We could not find that ticket in your account.' : 'This ticket could not be loaded.'} onRetry={missing ? undefined : () => void q.refetch()} />;
  }
  return (
    <section aria-labelledby="pt-title" ref={scroller} className="space-y-4">
      <Link to="/portal" className="text-[13px] font-medium text-brand-ink underline">
        ← All tickets
      </Link>
      {linkedFrom ? (
        <p role="status" className="rounded-md border border-brand/30 bg-brand-soft p-3 text-[13px] text-brand-ink">
          Your earlier ticket was no longer open for replies, so we created this new linked ticket with your message.{' '}
          <Link className="font-semibold underline" to={`/portal/tickets/${linkedFrom}`}>
            View the earlier ticket
          </Link>
        </p>
      ) : null}
      <header className="rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[t.status]}>{statusLabel[t.status]}</Badge>
          {t.parentTicketId ? (
            <Link className="text-xs font-medium text-brand-ink underline" to={`/portal/tickets/${t.parentTicketId}`}>
              Follow-up of an earlier ticket
            </Link>
          ) : null}
          <span className="ml-auto text-xs text-ink-3">Opened {formatIst(t.createdAt)}</span>
        </div>
        <h1 id="pt-title" className="mt-1 text-lg font-semibold">
          {t.subject}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-ink-2">Download this conversation:</span>
          <Button size="sm" asChild>
            <a href={`/api/customer/tickets/${t.id}/export?format=json`} download>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              JSON
            </a>
          </Button>
          <Button size="sm" asChild>
            <a href={`/api/customer/tickets/${t.id}/export?format=csv`} download>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              CSV
            </a>
          </Button>
        </div>
      </header>
      <Timeline
        messages={timeline.messages}
        hasOlder={timeline.hasOlder}
        loadingOlder={timeline.loadingOlder}
        olderError={timeline.gapUnresolved ? 'Many messages arrived while this page was open; reload to see the full conversation.' : timeline.error}
        onLoadOlder={timeline.loadOlder}
        scrollParent={{ current: document.scrollingElement as HTMLElement | null }}
        label="Conversation"
      />
      <PortalComposer id={t.id} status={t.status} />
    </section>
  );
}

function PortalComposer({ id, status }: { id: string; status: Status }) {
  const nav = useNavigate();
  const toast = useToast();
  const kind = status === 'RESOLVED' || status === 'CLOSED' ? 'reopen' : 'replies';
  const mut = usePortalContact(id, kind);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const heading = status === 'RESOLVED' ? 'Not resolved? Reopen this ticket' : status === 'CLOSED' ? 'Need more help? Start a follow-up' : 'Reply';
  const action = status === 'RESOLVED' ? 'Reopen ticket' : status === 'CLOSED' ? 'Create follow-up ticket' : 'Send reply';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    mut.mutate(
      { body: body.trim(), key: newIdempotencyKey() },
      {
        onSuccess: (o) => {
          setBody('');
          if (o.outcome === 'NEW_LINKED_TICKET') {
            toast.push('info', 'A new linked ticket was created for your message.');
            nav(`/portal/tickets/${o.ticket.id}`, { state: { linkedFrom: o.previousTicketId } });
          } else toast.push('ok', kind === 'reopen' ? 'Ticket reopened.' : 'Reply sent.');
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not send your message. Please try again.'),
      },
    );
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-line-strong bg-surface p-3">
      <Field label={heading}>{(p) => <Textarea {...p} required maxLength={10_000} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
      {error ? (
        <p role="alert" className="text-xs font-medium text-danger-ink">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={mut.isPending || !body.trim()}>
          {kind === 'reopen' ? <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> : null}
          {mut.isPending ? 'Sending…' : action}
        </Button>
      </div>
    </form>
  );
}


