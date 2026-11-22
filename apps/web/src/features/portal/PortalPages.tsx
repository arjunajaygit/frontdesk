import { ArrowLeft, ChevronRight, Clock3, Download, Link2, LogOut, MessageSquarePlus, Plus, RotateCcw, Send } from 'lucide-react';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Avatar, LogoMark } from '@/components/ui/identity';
import { Notice } from '@/components/ui/notice';
import { EmptyState, ErrorState, LoadingRows } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { ApiError, newIdempotencyKey } from '@/lib/api';
import { formatIst } from '@/lib/format';
import type { Priority, PublicMessage, PublicTicketSummary, Status } from '@/lib/types';
import { useAuth } from '../auth/auth';
import { statusTone } from '../tickets/badges';
import { Timeline, type TimelineMessage } from '../tickets/Timeline';
import { useTimeline } from '../tickets/useTimeline';
import { fetchOlderPublicMessages, useCreatePortalTicket, usePortalContact, usePortalList, usePortalTicket } from './api';

/** Customer wording: the same states, phrased from the customer's side. */
const CUSTOMER_STATUS: Record<Status, string> = { OPEN: 'Open', IN_PROGRESS: 'In progress', WAITING: 'Waiting for your reply', RESOLVED: 'Resolved', CLOSED: 'Closed' };
const toTimeline = (m: PublicMessage): TimelineMessage => ({ id: m.id, body: m.body, createdAt: m.createdAt, authorName: m.authorDisplayName, authorIsCustomer: m.authorType === 'CUSTOMER' });
const CustomerStatus = ({ status }: { status: Status }) => <Badge tone={statusTone(status)}>{CUSTOMER_STATUS[status]}</Badge>;

/** Customer-facing shell: its own layout, its own cache namespace, public DTOs only. */
export function PortalLayout() {
  const { viewer, logout } = useAuth();
  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="glass-canvas sticky top-0 z-20 border-b border-line">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-3 px-4">
          <Link to="/portal" className="flex items-center gap-2.5 rounded-md">
            <LogoMark className="h-7 w-7" />
            <span className="text-title font-semibold tracking-[-0.01em]">
              Frontdesk <span className="font-normal text-ink-3">Support</span>
            </span>
          </Link>
          <span className="ml-auto hidden items-center gap-2 text-body text-ink-2 sm:inline-flex">
            <Avatar name={viewer?.displayName} size="sm" />
            <span data-testid="viewer-name">{viewer?.displayName}</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => void logout()} className="ml-auto sm:ml-0">
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-16 pt-6 sm:pt-8">
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
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="my-tickets" className="text-display font-semibold tracking-[-0.02em]">
            Your tickets
          </h1>
          <p className="mt-1 text-body text-ink-2">Follow your requests and reply to our team in one place.</p>
        </div>
        <Button variant="primary" asChild>
          <Link to="/portal/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            New ticket
          </Link>
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
        {q.isPending ? (
          <LoadingRows rows={4} />
        ) : q.isError ? (
          <ErrorState message="Your tickets could not be loaded." onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No tickets yet"
            icon={MessageSquarePlus}
            action={
              <Button variant="primary" size="sm" asChild>
                <Link to="/portal/new">Create your first ticket</Link>
              </Button>
            }
          >
            Create a ticket and our team will respond within our service targets.
          </EmptyState>
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
              <div className="border-t border-line p-3 text-center">
                <Button size="sm" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                  Load more tickets
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
      <p className="mt-4 flex items-center gap-1.5 text-meta text-ink-3">
        <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
        Our team works Monday–Friday, 09:30–18:30 IST, except holidays.
      </p>
    </section>
  );
}

const Row = ({ t }: { t: PublicTicketSummary }) => (
  <Link to={`/portal/tickets/${t.id}`} className="group flex items-center gap-3 border-b border-line px-4 py-3.5 transition-colors duration-150 last:border-b-0 hover:bg-surface-2 sm:px-5">
    <div className="min-w-0 flex-1">
      <p className="truncate text-ui font-medium text-ink">{t.subject}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <CustomerStatus status={t.status} />
        {t.parentTicketId ? (
          <Badge tone="neutral">
            <Link2 aria-hidden="true" />
            Follow-up
          </Badge>
        ) : null}
        <time dateTime={t.createdAt} className="text-meta tabular-nums text-ink-3">
          Opened {formatIst(t.createdAt)}
        </time>
      </div>
    </div>
    <ChevronRight className="h-4 w-4 shrink-0 text-ink-3 transition-transform duration-150 group-hover:translate-x-0.5" aria-hidden="true" />
  </Link>
);

const BackLink = () => (
  <Link to="/portal" className="inline-flex items-center gap-1.5 rounded-md text-body font-medium text-ink-2 transition-colors hover:text-ink">
    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
    All tickets
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
      <BackLink />
      <h1 id="new-title" className="mt-4 text-display font-semibold tracking-[-0.02em]">
        New ticket
      </h1>
      <p className="mb-5 mt-1 text-body text-ink-2">Tell us what is going on. The more detail you share, the faster we can help.</p>
      <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-5 shadow-sm sm:p-6">
        <Field label="Subject">{(p) => <Input {...p} required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="For example: Invoice shows the wrong address" />}</Field>
        <Field label="What do you need help with?">
          {(p) => <Textarea {...p} required maxLength={10_000} value={body} onChange={(e) => setBody(e.target.value)} className="min-h-36" placeholder="Describe the problem, what you expected, and any steps to reproduce it." />}
        </Field>
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
          <Notice tone="bad" role="alert">
            {error}
          </Notice>
        ) : null}
        <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
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

  if (q.isPending)
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-surface">
        <LoadingRows rows={3} />
      </div>
    );
  if (q.isError || !t) {
    const missing = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-xl border border-line bg-surface">
          <ErrorState message={missing ? 'We could not find that ticket in your account.' : 'This ticket could not be loaded.'} onRetry={missing ? undefined : () => void q.refetch()} />
        </div>
      </div>
    );
  }
  return (
    <section aria-labelledby="pt-title" ref={scroller} className="space-y-5">
      <BackLink />
      {linkedFrom ? (
        <Notice tone="brand" role="status" icon={Link2}>
          <p>
            Your earlier ticket was no longer open for replies, so we created this new linked ticket with your message.{' '}
            <Link className="font-semibold underline underline-offset-2" to={`/portal/tickets/${linkedFrom}`}>
              View the earlier ticket
            </Link>
          </p>
        </Notice>
      ) : null}
      <header className="rounded-xl border border-line bg-surface p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <CustomerStatus status={t.status} />
          {t.parentTicketId ? (
            <Link className="inline-flex items-center gap-1 text-meta font-medium text-brand-ink underline underline-offset-2" to={`/portal/tickets/${t.parentTicketId}`}>
              <Link2 className="h-3 w-3" aria-hidden="true" />
              Follow-up of an earlier ticket
            </Link>
          ) : null}
          <span className="ml-auto text-meta tabular-nums text-ink-3">Opened {formatIst(t.createdAt)}</span>
        </div>
        <h1 id="pt-title" className="mt-2 text-heading font-semibold tracking-[-0.015em]">
          {t.subject}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
          <span className="text-meta font-medium text-ink-3">Download conversation</span>
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
        perspective="customer"
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
  const explain =
    status === 'RESOLVED'
      ? 'Reopening sends your message to the team on this same ticket.'
      : status === 'CLOSED'
        ? 'This ticket is closed, so your message starts a new ticket linked to this one.'
        : status === 'WAITING'
          ? 'Our team is waiting for your reply — answering resumes work on your ticket.'
          : null;
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
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-line bg-surface p-4 shadow-sm focus-within:shadow-[0_0_0_3px_rgb(15_118_110/0.12)] sm:p-5">
      <Field label={heading} hint={explain ?? undefined}>
        {(p) => <Textarea {...p} required maxLength={10_000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your message…" />}
      </Field>
      {error ? (
        <Notice tone="bad" role="alert">
          {error}
        </Notice>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={mut.isPending || !body.trim()}>
          {kind === 'reopen' ? <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
          {mut.isPending ? 'Sending…' : action}
        </Button>
      </div>
    </form>
  );
}
