import { ChevronUp, Lock, Mail } from 'lucide-react';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/identity';
import { formatIst, formatIstFull } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { MessageKind } from '@/lib/types';

/** Normalised message for rendering (staff and public payloads are mapped by their own callers). */
export interface TimelineMessage {
  id: string;
  body: string;
  createdAt: string;
  authorName: string;
  authorIsCustomer: boolean;
  /** Present only for staff timelines; the customer portal never receives (or renders) it. */
  kind?: MessageKind;
}

/** Chronological order by (createdAt, id): stable when timestamps are identical. De-duplicates by id. */
export function mergeMessages(...lists: TimelineMessage[][]): TimelineMessage[] {
  const byId = new Map<string, TimelineMessage>();
  for (const list of lists) for (const m of list) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function Timeline({
  messages,
  hasOlder,
  loadingOlder,
  olderError,
  onLoadOlder,
  scrollParent,
  label,
  perspective = 'staff',
}: {
  messages: TimelineMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  olderError?: string | null;
  onLoadOlder: () => void;
  scrollParent: RefObject<HTMLElement | null>;
  label: string;
  /** 'customer' labels the viewer's own messages "You" and staff replies "Support team". */
  perspective?: 'staff' | 'customer';
}) {
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const count = messages.length;

  // Keep the reader's place when older messages are prepended: restore the same distance from the bottom.
  useLayoutEffect(() => {
    const el = scrollParent.current;
    const a = anchor.current;
    if (el && a) {
      el.scrollTop = el.scrollHeight - a.height + a.top;
      anchor.current = null;
    }
  }, [count, scrollParent]);

  const load = () => {
    const el = scrollParent.current;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    onLoadOlder();
  };

  return (
    <div aria-label={label} role="log" aria-live="off" className="space-y-5">
      {hasOlder ? (
        <div className="flex flex-col items-center gap-1.5">
          <Button size="sm" onClick={load} disabled={loadingOlder}>
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
          </Button>
          {olderError ? (
            <p role="alert" className="text-meta text-danger-ink">
              {olderError}
            </p>
          ) : null}
        </div>
      ) : count > 0 ? (
        <div className="flex items-center gap-3 text-caption text-ink-3">
          <span className="h-px flex-1 bg-line" aria-hidden="true" />
          <p>Start of conversation</p>
          <span className="h-px flex-1 bg-line" aria-hidden="true" />
        </div>
      ) : null}
      {messages.map((m) => (
        <MessageItem key={m.id} m={m} perspective={perspective} />
      ))}
    </div>
  );
}

function MessageItem({ m, perspective }: { m: TimelineMessage; perspective: 'staff' | 'customer' }) {
  const note = m.kind === 'NOTE';
  const request = m.kind === 'REQUEST';
  const intake = m.kind === 'INTAKE';
  const mine = perspective === 'customer' && m.authorIsCustomer;
  const label = intake
    ? 'Original request'
    : request
      ? 'Information requested'
      : note
        ? 'Internal note'
        : perspective === 'customer'
          ? m.authorIsCustomer
            ? 'You'
            : 'Support team'
          : m.authorIsCustomer
            ? 'Customer'
            : 'Public reply';
  const surface = note
    ? 'border-note-line bg-note-soft'
    : request
      ? 'border-info/20 bg-info-soft/60'
      : m.authorIsCustomer
        ? 'border-line bg-surface'
        : 'border-brand/15 bg-brand-soft/50';
  return (
    <article data-kind={m.kind ?? 'PUBLIC'} className="flex gap-3">
      <div className="pt-0.5">
        <Avatar name={m.authorName} tone={note ? 'note' : m.authorIsCustomer ? 'neutral' : request ? 'info' : 'brand'} />
      </div>
      <div className="min-w-0 flex-1">
        <header className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
          <span className="font-semibold text-ink">{mine ? 'You' : m.authorName}</span>
          {note ? (
            <Badge tone="note">
              <Lock aria-hidden="true" />
              Internal note · team only
            </Badge>
          ) : mine ? null : (
            <Badge tone={request ? 'info' : intake ? 'brand' : 'neutral'}>
              {request ? <Mail aria-hidden="true" /> : null}
              {label}
            </Badge>
          )}
          <time dateTime={m.createdAt} title={formatIstFull(m.createdAt)} className="ml-auto tabular-nums text-ink-3">
            {formatIst(m.createdAt)}
          </time>
        </header>
        <div className={cn('rounded-lg rounded-tl-sm border px-3.5 py-2.5', surface, note && 'border-dashed')}>
          <p className={cn('whitespace-pre-wrap break-words text-body leading-relaxed', note ? 'text-note-ink' : 'text-ink')}>{m.body}</p>
        </div>
      </div>
    </article>
  );
}
