import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/auth';
import { newIdempotencyKey, request } from '@/lib/api';
import type { AuditPage, CustomerSummary, Priority, StaffMessagePage, StaffPage, StaffTicket, SweepResult } from '@/lib/types';
import type { ViewFilter } from './views';

/** All staff cache keys are namespaced by viewer id so one identity can never read another's entries. */
export const useStaffScope = () => {
  const { viewer } = useAuth();
  return ['staff', viewer?.id ?? 'anon'] as const;
};

const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export function useTicketList(filter: ViewFilter, priority: Priority | '') {
  const scope = useStaffScope();
  return useInfiniteQuery({
    queryKey: [...scope, 'list', filter, priority],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => request<StaffPage>(`/tickets${qs({ limit: 25, cursor: pageParam, scope: filter.scope, status: filter.status, late: filter.late, priority: priority || undefined })}`, { signal }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000, // authoritative SLA state is re-read from the server; the client never computes it
  });
}

export function useTicket(id: string | null) {
  const scope = useStaffScope();
  return useQuery({
    queryKey: [...scope, 'ticket', id],
    enabled: !!id,
    queryFn: ({ signal }) => request<StaffTicket>(`/tickets/${id}`, { signal }),
    refetchInterval: 60_000,
  });
}

export const fetchOlderStaffMessages = (id: string, cursor: string) => request<StaffMessagePage>(`/tickets/${id}/messages${qs({ limit: 50, cursor })}`);

export function useAudit(id: string | null) {
  const scope = useStaffScope();
  return useInfiniteQuery({
    queryKey: [...scope, 'audit', id],
    enabled: !!id,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => request<AuditPage>(`/tickets/${id}/audit${qs({ limit: 100, cursor: pageParam })}`, { signal }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useCustomers(enabled: boolean) {
  const scope = useStaffScope();
  return useQuery({ queryKey: [...scope, 'customers'], enabled, queryFn: () => request<{ items: CustomerSummary[] }>('/customers'), staleTime: 5 * 60_000 });
}

type Cmd =
  | { type: 'claim' }
  | { type: 'reply'; body: string }
  | { type: 'note'; body: string }
  | { type: 'wait'; body: string }
  | { type: 'resolve'; body?: string }
  | { type: 'priority'; priority: Priority };

/** One mutation for every ticket command. Server-confirmed state only: the cache is updated from the response. */
export function useTicketCommand(ticketId: string) {
  const qc = useQueryClient();
  const scope = useStaffScope();
  return useMutation({
    mutationFn: ({ cmd, key }: { cmd: Cmd; key: string }) => {
      const base = `/tickets/${ticketId}`;
      switch (cmd.type) {
        case 'claim':
          return request<StaffTicket>(`${base}/claim`, { method: 'POST', idempotencyKey: key, json: {} });
        case 'reply':
          return request<StaffTicket>(`${base}/replies`, { method: 'POST', idempotencyKey: key, json: { body: cmd.body } });
        case 'note':
          return request<StaffTicket>(`${base}/notes`, { method: 'POST', idempotencyKey: key, json: { body: cmd.body } });
        case 'wait':
          return request<StaffTicket>(`${base}/wait`, { method: 'POST', idempotencyKey: key, json: { body: cmd.body } });
        case 'resolve':
          return request<StaffTicket>(`${base}/resolve`, { method: 'POST', idempotencyKey: key, json: cmd.body ? { body: cmd.body } : {} });
        case 'priority':
          return request<StaffTicket>(`${base}/priority`, { method: 'PATCH', idempotencyKey: key, json: { priority: cmd.priority } });
      }
    },
    onSuccess: (ticket) => {
      qc.setQueryData([...scope, 'ticket', ticketId], ticket); // confirmed by the server
      void qc.invalidateQueries({ queryKey: [...scope, 'list'] });
      void qc.invalidateQueries({ queryKey: [...scope, 'audit', ticketId] });
    },
    onError: () => {
      // Lost claim / stale state: re-read the authoritative ticket and queue.
      void qc.invalidateQueries({ queryKey: [...scope, 'ticket', ticketId] });
      void qc.invalidateQueries({ queryKey: [...scope, 'list'] });
    },
  });
}
export { newIdempotencyKey };

export function useCreateStaffTicket() {
  const qc = useQueryClient();
  const scope = useStaffScope();
  return useMutation({
    mutationFn: ({ input, key }: { input: { customerId: string; subject: string; body: string; priority: Priority }; key: string }) =>
      request<StaffTicket>('/tickets', { method: 'POST', idempotencyKey: key, json: input }),
    onSuccess: (t) => {
      qc.setQueryData([...scope, 'ticket', t.id], t);
      void qc.invalidateQueries({ queryKey: [...scope, 'list'] });
    },
  });
}

export function useRunSweep() {
  const qc = useQueryClient();
  const scope = useStaffScope();
  return useMutation({
    mutationFn: (key: string) => request<SweepResult>('/admin/run-sla-sweep', { method: 'POST', idempotencyKey: key }),
    onSettled: () => void qc.invalidateQueries({ queryKey: scope }),
  });
}
