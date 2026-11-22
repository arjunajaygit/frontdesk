import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/features/auth/auth';
import { request } from '@/lib/api';
import type { CustomerOutcome, Priority, PublicMessagePage, PublicPage, PublicTicket } from '@/lib/types';

/** Portal cache keys use a separate namespace from staff data and are scoped to the signed-in customer. */
const usePortalScope = () => ['portal', useAuth().viewer?.id ?? 'anon'] as const;

export function usePortalList() {
  const scope = usePortalScope();
  return useInfiniteQuery({
    queryKey: [...scope, 'list'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => request<PublicPage>(`/customer/tickets?limit=25${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`, { signal }),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    refetchInterval: 60_000,
  });
}

export function usePortalTicket(id: string) {
  const scope = usePortalScope();
  return useQuery({ queryKey: [...scope, 'ticket', id], queryFn: ({ signal }) => request<PublicTicket>(`/customer/tickets/${id}`, { signal }), refetchInterval: 60_000 });
}

export const fetchOlderPublicMessages = (id: string, cursor: string) => request<PublicMessagePage>(`/customer/tickets/${id}/messages?limit=50&cursor=${encodeURIComponent(cursor)}`);

export function useCreatePortalTicket() {
  const qc = useQueryClient();
  const scope = usePortalScope();
  return useMutation({
    mutationFn: ({ input, key }: { input: { subject: string; body: string; requestedPriority?: Priority }; key: string }) => request<PublicTicket>('/customer/tickets', { method: 'POST', idempotencyKey: key, json: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...scope, 'list'] }),
  });
}

/** Reply and reopen return CustomerOutcome (SAME_TICKET | NEW_LINKED_TICKET). */
export function usePortalContact(ticketId: string, kind: 'replies' | 'reopen') {
  const qc = useQueryClient();
  const scope = usePortalScope();
  return useMutation({
    mutationFn: ({ body, key }: { body: string; key: string }) => request<CustomerOutcome>(`/customer/tickets/${ticketId}/${kind}`, { method: 'POST', idempotencyKey: key, json: { body } }),
    onSuccess: (o) => {
      qc.setQueryData([...scope, 'ticket', o.ticket.id], o.ticket);
      void qc.invalidateQueries({ queryKey: [...scope, 'list'] });
      void qc.invalidateQueries({ queryKey: [...scope, 'ticket', ticketId] });
    },
  });
}
