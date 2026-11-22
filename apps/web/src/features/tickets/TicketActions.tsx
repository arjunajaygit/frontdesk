import { CheckCheck, Hand } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { priorityLabel } from '@/lib/format';
import type { Priority, StaffTicket, Viewer } from '@/lib/types';
import { newIdempotencyKey, useTicketCommand } from './api';
import { currentClocks } from './sla';
import { PRIORITIES } from './views';

export function TicketActions({ ticket, viewer }: { ticket: StaffTicket; viewer: Viewer }) {
  const cmd = useTicketCommand(ticket.id);
  const toast = useToast();
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveText, setResolveText] = useState('');
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>(ticket.priority);

  const isAssignee = ticket.assigneeId === viewer.id;
  const canClaim = ticket.status === 'OPEN' && !ticket.assigneeId;
  const open = ticket.status === 'IN_PROGRESS' || ticket.status === 'WAITING';
  const responsePending = currentClocks(ticket.clocks).response?.state === 'RUNNING';

  const claim = () =>
    cmd.mutate(
      { cmd: { type: 'claim' }, key: newIdempotencyKey() },
      {
        onSuccess: () => toast.push('ok', 'You claimed this ticket.'),
        onError: (e) => {
          if (e instanceof ApiError && e.code === 'CLAIM_CONFLICT') {
            toast.push('bad', `${e.assignedAgentDisplayName ?? 'Another agent'} claimed this ticket first. It has been refreshed.`);
          } else toast.push('bad', e instanceof ApiError ? e.message : 'Could not claim the ticket.');
        },
      },
    );

  const applyPriority = () =>
    cmd.mutate(
      { cmd: { type: 'priority', priority }, key: newIdempotencyKey() },
      {
        onSuccess: () => toast.push('ok', `Priority set to ${priorityLabel[priority]}. SLA deadlines were recalculated from time already used.`),
        onError: (e) => toast.push('bad', e instanceof ApiError ? e.message : 'Could not change priority.'),
      },
    );

  const resolve = () => {
    setResolveError(null);
    cmd.mutate(
      { cmd: { type: 'resolve', body: resolveText.trim() || undefined }, key: newIdempotencyKey() },
      {
        onSuccess: () => {
          setResolveOpen(false);
          setResolveText('');
          toast.push('ok', 'Ticket resolved. The customer can reopen it for seven days.');
        },
        onError: (e) => setResolveError(e instanceof ApiError ? e.message : 'Could not resolve the ticket.'),
      },
    );
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      {canClaim ? (
        <Button variant="primary" onClick={claim} disabled={cmd.isPending}>
          <Hand className="h-3.5 w-3.5" aria-hidden="true" />
          {cmd.isPending ? 'Claiming…' : 'Claim ticket'}
        </Button>
      ) : null}
      {isAssignee && open ? (
        <>
          <div className="flex items-end gap-1.5">
            <Field label="Ticket priority">
              {(p) => (
                <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className="w-32">
                  {PRIORITIES.map((x) => (
                    <option key={x} value={x}>
                      {priorityLabel[x]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button onClick={applyPriority} disabled={cmd.isPending || priority === ticket.priority}>
              Apply priority
            </Button>
          </div>
          {ticket.status === 'IN_PROGRESS' ? (
            <Button variant="secondary" onClick={() => setResolveOpen(true)}>
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Resolve…
            </Button>
          ) : null}
        </>
      ) : null}
      <Dialog open={resolveOpen} onOpenChange={setResolveOpen} title="Resolve ticket" description="The customer sees this message. They can reopen the same ticket for seven days.">
        <div className="space-y-3">
          <Field label={responsePending ? 'Resolution message (required — no public reply has been sent yet)' : 'Resolution message (optional)'} error={resolveError}>
            {(p) => <Textarea {...p} value={resolveText} onChange={(e) => setResolveText(e.target.value)} maxLength={10_000} />}
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setResolveOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={resolve} disabled={cmd.isPending || (responsePending && !resolveText.trim())}>
              {cmd.isPending ? 'Resolving…' : 'Resolve ticket'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
