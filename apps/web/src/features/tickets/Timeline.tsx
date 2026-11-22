import { ChevronUp, Lock, Mail, MessageSquareText, UserRound } from 'lucide-react';
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatIst, formatIstFull } from '@/lib/format';
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
}: {
  messages: TimelineMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  olderError?: string | null;
  onLoadOlder: () => void;
  scrollParent: RefObject<HTMLElement | null>;
  label: string;
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
    <div aria-label={label} role="log" aria-live="off" className="space-y-3">
      {hasOlder ? (
        <div className="flex flex-col items-center gap-1">
          <Button size="sm" onClick={load} disabled={loadingOlder}>
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
          </Button>
          {olderError ? (
            <p role="alert" className="text-xs text-danger-ink">
              {olderError}
            </p>
          ) : null}
        </div>
      ) : count > 0 ? (
        <p className="text-center text-xs text-ink-3">Start of conversation</p>
      ) : null}
      {messages.map((m) => (
        <MessageItem key={m.id} m={m} />
      ))}
    </div>
  );
}

function MessageItem({ m }: { m: TimelineMessage }) {
  const note = m.kind === 'NOTE';
  const label = m.kind === 'INTAKE' ? 'Original request' : m.kind === 'REQUEST' ? 'Information requested' : note ? 'Internal note' : m.authorIsCustomer ? 'Customer' : 'Public reply';
  const Icon = note ? Lock : m.kind === 'REQUEST' ? Mail : m.authorIsCustomer ? UserRound : MessageSquareText;
  return (
    <article
      data-kind={m.kind ?? 'PUBLIC'}
      className={`rounded-lg border p-3 ${note ? 'border-warn/50 border-l-4 bg-warn-soft' : m.authorIsCustomer ? 'border-line bg-surface' : 'border-brand/25 bg-brand-soft/60'}`}
    >
      <header className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Icon className={`h-3.5 w-3.5 ${note ? 'text-warn-ink' : 'text-ink-3'}`} aria-hidden="true" />
        <span className="font-semibold text-ink">{m.authorName}</span>
        {note ? (
          <Badge tone="warn">
            <Lock className="h-3 w-3" aria-hidden="true" />
            Internal note · team only
          </Badge>
        ) : (
          <Badge tone={m.kind === 'REQUEST' ? 'info' : 'neutral'}>{label}</Badge>
        )}
        <time dateTime={m.createdAt} title={formatIstFull(m.createdAt)} className="ml-auto text-ink-3">
          {formatIst(m.createdAt)}
        </time>
      </header>
      <p className="whitespace-pre-wrap break-words text-[13px] text-ink">{m.body}</p>
    </article>
  );
}
