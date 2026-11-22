import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api';
import { priorityLabel } from '@/lib/format';
import type { Priority } from '@/lib/types';
import { newIdempotencyKey, useCreateStaffTicket, useCustomers } from './api';
import { PRIORITIES } from './views';

export function NewTicketDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const customers = useCustomers(open);
  const create = useCreateStaffTicket();
  const toast = useToast();
  const [customerId, setCustomerId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<Priority>('MEDIUM');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    create.mutate(
      { input: { customerId, subject: subject.trim(), body: body.trim(), priority }, key: newIdempotencyKey() },
      {
        onSuccess: (t) => {
          toast.push('ok', 'Ticket created on behalf of the customer.');
          setSubject('');
          setBody('');
          onOpenChange(false);
          onCreated(t.id);
        },
        onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create the ticket.'),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New ticket" description="Record a request on behalf of a customer (phone or email). Your message is stored as the customer's original request." className="max-w-lg">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Customer">
          {(p) => (
            <Select {...p} required value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">{customers.isPending ? 'Loading customers…' : 'Select a customer'}</option>
              {customers.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Subject">{(p) => <Input {...p} required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />}</Field>
        <Field label="Customer's request">{(p) => <Textarea {...p} required maxLength={10_000} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
        <Field label="Priority" hint="Urgent resolution is due by the end of the working day the ticket starts.">
          {(p) => (
            <Select {...p} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {priorityLabel[x]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {error ? (
          <p role="alert" className="text-[13px] font-medium text-danger-ink">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={create.isPending || !customerId || !subject.trim() || !body.trim()}>
            {create.isPending ? 'Creating…' : 'Create ticket'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
