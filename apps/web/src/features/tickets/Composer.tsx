import { Lock, Mail, MessageSquareText, Send } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Kbd } from '@/components/ui/identity';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { StaffTicket } from '@/lib/types';
import { newIdempotencyKey, useTicketCommand } from './api';

type Mode = 'reply' | 'note' | 'wait';
const MODES: Record<Mode, { label: string; short: string; submit: string; icon: typeof Send; hint: string }> = {
  reply: { label: 'Public reply', short: 'Reply', submit: 'Send public reply', icon: MessageSquareText, hint: 'Visible to the customer. Completes the first-response clock.' },
  note: { label: 'Internal note', short: 'Note', submit: 'Add internal note', icon: Lock, hint: 'Team only. The customer can never see this. Does not affect any SLA clock.' },
  wait: { label: 'Request information', short: 'Request', submit: 'Send request & wait', icon: Mail, hint: 'Visible to the customer. Pauses the resolution clock until they reply; auto-closes after five working days of silence.' },
};

/**
 * Three distinct commands. Each mode keeps its OWN draft so text typed as a note can never be sent publicly
 * by switching tabs, and the submit button always names exactly what will happen.
 */
export function Composer({ ticket, canWrite }: { ticket: StaffTicket; canWrite: boolean }) {
  const [mode, setMode] = useState<Mode>('reply');
  const [drafts, setDrafts] = useState<Record<Mode, string>>({ reply: '', note: '', wait: '' });
  const [error, setError] = useState<string | null>(null);
  const cmd = useTicketCommand(ticket.id);
  const toast = useToast();
  const groupId = useId();
  const waiting = ticket.status === 'WAITING';
  const active = ticket.status === 'IN_PROGRESS' || waiting;
  const allowed = (m: Mode) => canWrite && active && (m === 'note' || !waiting);
  const meta = MODES[mode];

  if (!canWrite || !active) {
    return (
      <p className="flex items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface px-3.5 py-3 text-body text-ink-2">
        <Lock className="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
        {ticket.status === 'RESOLVED' || ticket.status === 'CLOSED'
          ? `This ticket is ${ticket.status === 'RESOLVED' ? 'resolved' : 'closed'}. Staff cannot add messages; the customer can reopen or follow up.`
          : ticket.assigneeId
            ? `Only the assignee (${ticket.assigneeDisplayName}) can reply, add notes or change this ticket.`
            : 'Claim this ticket to reply, add notes or request information.'}
      </p>
    );
  }

  const body = drafts[mode];
  const submit = () => {
    const text = body.trim();
    if (!text || cmd.isPending || !allowed(mode)) return;
    setError(null);
    cmd.mutate(
      { cmd: { type: mode, body: text }, key: newIdempotencyKey() },
      {
        onSuccess: () => {
          setDrafts((d) => ({ ...d, [mode]: '' }));
          toast.push('ok', mode === 'note' ? 'Internal note added.' : mode === 'wait' ? 'Request sent. The resolution clock is paused.' : 'Reply sent to the customer.');
        },
        onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not send. Please try again.'),
      },
    );
  };
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
  };

  const isNote = mode === 'note';
  return (
    <form
      aria-label="Compose message"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn(
        'overflow-hidden rounded-xl border bg-surface shadow-sm transition-[border-color,background-color,box-shadow] duration-200 focus-within:shadow-[0_0_0_3px_rgb(15_118_110/0.12)]',
        isNote ? 'border-note bg-note-soft focus-within:shadow-[0_0_0_3px_rgb(161_92_7/0.14)]' : 'border-control focus-within:border-brand',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line/70 px-2 py-2">
        <div role="radiogroup" aria-label="Message type" className="inline-flex flex-wrap gap-0.5 rounded-lg bg-sunken p-0.5">
          {(Object.keys(MODES) as Mode[]).map((m) => {
            const M = MODES[m];
            const selected = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={M.label}
                disabled={!allowed(m)}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={cn(
                  'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-meta font-medium transition-[background-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-40',
                  selected ? (m === 'note' ? 'bg-note text-white shadow-xs' : 'bg-surface text-ink shadow-xs ring-1 ring-line') : 'text-ink-2 hover:text-ink',
                )}
              >
                <M.icon className={cn('h-3.5 w-3.5', selected && m !== 'note' && 'text-brand')} aria-hidden="true" />
                {/* Phones show the short word; the accessible name (aria-label) is always the full one and contains it. */}
                <span className="sm:hidden">{M.short}</span>
                <span className="hidden sm:inline">{M.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div
        id={`${groupId}-hint`}
        className={cn('flex items-start gap-2 px-3.5 pt-2.5 text-meta', isNote ? 'font-semibold text-note-ink' : 'text-ink-3')}
      >
        {isNote ? <Lock className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
        <span>{isNote ? `TEAM ONLY — ${meta.hint}` : meta.hint}</span>
      </div>
      <label htmlFor={`${groupId}-body`} className="sr-only">
        {meta.label} text
      </label>
      <Textarea
        id={`${groupId}-body`}
        aria-describedby={`${groupId}-hint`}
        value={body}
        maxLength={10_000}
        onChange={(e) => setDrafts((d) => ({ ...d, [mode]: e.target.value }))}
        onKeyDown={onKey}
        placeholder={isNote ? 'Write a note for your team…' : mode === 'wait' ? 'What do you need from the customer?' : 'Write a reply to the customer…'}
        className="min-h-[3.25rem] resize-none sm:min-h-[4.75rem] border-0 bg-transparent px-3.5 shadow-none hover:border-0 focus:ring-0"
      />
      {error ? (
        <p role="alert" className="px-3.5 pb-1 text-meta font-medium text-danger-ink">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 px-3 pb-3">
        <span className="hidden items-center gap-1 text-caption text-ink-3 sm:inline-flex">
          <Kbd>Ctrl/⌘</Kbd>
          <Kbd>Enter</Kbd>
          <span className="ml-0.5">sends “{meta.short}”</span>
        </span>
        <Button type="submit" variant={isNote ? 'note' : 'primary'} disabled={!body.trim() || cmd.isPending} className="ml-auto">
          <meta.icon className="h-3.5 w-3.5" aria-hidden="true" />
          {cmd.isPending ? 'Sending…' : meta.submit}
        </Button>
      </div>
    </form>
  );
}
