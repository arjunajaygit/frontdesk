import type { Priority, Status } from '@/lib/types';

export type ViewId = 'all' | 'mine' | 'unassigned' | 'breached' | 'waiting' | 'resolved' | 'closed';

/** Every sidebar view maps to filters the SERVER understands (no client-side filtering of partial pages). */
export interface ViewFilter {
  scope?: 'ALL' | 'MINE' | 'UNASSIGNED';
  status?: Status;
  late?: boolean;
}
export const VIEWS: { id: ViewId; label: string; filter: ViewFilter; blurb: string }[] = [
  { id: 'all', label: 'All tickets', filter: {}, blurb: 'Every ticket, newest first.' },
  { id: 'mine', label: 'My tickets', filter: { scope: 'MINE' }, blurb: 'Tickets assigned to you.' },
  { id: 'unassigned', label: 'Unassigned', filter: { scope: 'UNASSIGNED' }, blurb: 'Waiting to be claimed.' },
  { id: 'breached', label: 'Breached', filter: { late: true }, blurb: 'A response or resolution clock is past its deadline.' },
  { id: 'waiting', label: 'Waiting on customer', filter: { status: 'WAITING' }, blurb: 'Clock paused until the customer replies.' },
  { id: 'resolved', label: 'Resolved', filter: { status: 'RESOLVED' }, blurb: 'Customers can reopen within seven days.' },
  { id: 'closed', label: 'Closed', filter: { status: 'CLOSED' }, blurb: 'Auto-closed or expired.' },
];
export const viewById = (id: string | null): (typeof VIEWS)[number] => VIEWS.find((v) => v.id === id) ?? VIEWS[0]!;
export const PRIORITIES: Priority[] = ['URGENT', 'MEDIUM', 'LOW'];
