import { Lock, Mail, MessageSquareText, Send } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
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
      <p className="rounded-lg border border-dashed border-line-strong bg-surface p-3 text-[13px] text-ink-2">
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
      className={`rounded-lg border-2 bg-surface p-3 ${isNote ? 'border-warn bg-warn-soft' : 'border-line-strong'}`}
    >
      <div role="radiogroup" aria-label="Message type" className="mb-2 flex flex-wrap gap-1.5">
        {(Object.keys(MODES) as Mode[]).map((m) => {
          const M = MODES[m];
          const selected = m === mode;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!allowed(m)}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 text-[13px] font-medium disabled:opacity-45 ${
                selected ? (m === 'note' ? 'border-warn bg-warn text-white' : 'border-brand bg-brand text-white') : 'border-line-strong bg-surface text-ink-2 hover:bg-canvas'
              }`}
            >
              <M.icon className="h-3.5 w-3.5" aria-hidden="true" />
              {M.label}
            </button>
          );
        })}
      </div>
      <div
        id={`${groupId}-hint`}
        className={`mb-2 flex items-start gap-2 rounded-md px-2.5 py-1.5 text-xs ${isNote ? 'bg-warn/15 font-semibold text-warn-ink' : 'bg-canvas text-ink-2'}`}
      >
        {isNote ? <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : null}
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
        className={`min-h-[4.5rem] ${isNote ? 'border-warn/60 bg-white' : ''}`}
      />
      {error ? (
        <p role="alert" className="mt-2 text-xs font-medium text-danger-ink">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-ink-3">Ctrl/⌘ + Enter sends “{meta.short}”</span>
        <Button type="submit" variant={isNote ? 'note' : 'primary'} disabled={!body.trim() || cmd.isPending}>
          <meta.icon className="h-3.5 w-3.5" aria-hidden="true" />
          {cmd.isPending ? 'Sending…' : meta.submit}
        </Button>
      </div>
    </form>
  );
}
