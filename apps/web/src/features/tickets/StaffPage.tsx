import { Headset, LogOut, Menu, Plus, ShieldAlert, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Priority } from '@/lib/types';
import { SweepDialog } from '../admin/SweepDialog';
import { useAuth } from '../auth/auth';
import { NewTicketDialog } from './NewTicketDialog';
import { TicketDetail } from './TicketDetail';
import { TicketList } from './TicketList';
import { VIEWS, viewById } from './views';

const ROLE_LABEL = { AGENT: 'Agent', LEAD: 'Support lead', ADMIN: 'Admin', CUSTOMER: 'Customer' } as const;

/** Staff workspace: sidebar views, server-filtered list and ticket detail side by side (stacked on narrow screens). */
export function StaffPage() {
  const { viewer, logout } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = viewById(params.get('view'));
  const ticketId = params.get('ticket');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [navOpen, setNavOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const canSweep = viewer?.role === 'LEAD' || viewer?.role === 'ADMIN';

  useEffect(() => setNavOpen(false), [view.id]);
  const href = (id: string | null, v = view.id) => `/staff?view=${v}${id ? `&ticket=${id}` : ''}`;

  return (
    <div className="flex h-dvh flex-col lg:flex-row">
      <header className="nav-surface flex items-center gap-2 bg-nav px-3 py-2 text-white lg:hidden">
        <Headset className="h-5 w-5 text-[#7ee0d4]" aria-hidden="true" />
        <span className="font-semibold">Frontdesk</span>
        <span className="ml-auto text-xs text-nav-text">{view.label}</span>
        <Button variant="nav" size="icon" aria-expanded={navOpen} aria-controls="staff-nav" aria-label={navOpen ? 'Close menu' : 'Open menu'} onClick={() => setNavOpen((o) => !o)}>
          {navOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
        </Button>
      </header>

      <aside id="staff-nav" className={cn('nav-surface w-full shrink-0 flex-col bg-nav text-nav-text lg:flex lg:w-52 xl:w-60', navOpen ? 'flex' : 'hidden')}>
        <div className="hidden items-center gap-2 px-4 py-4 text-white lg:flex">
          <Headset className="h-5 w-5 text-[#7ee0d4]" aria-hidden="true" />
          <span className="text-base font-semibold tracking-tight">Frontdesk</span>
        </div>
        <div className="px-3 pt-3 lg:pt-0">
          <Button variant="primary" className="w-full" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New ticket
          </Button>
        </div>
        <nav aria-label="Ticket views" className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-2">
          {VIEWS.map((v) => (
            <Link
              key={v.id}
              to={href(null, v.id)}
              onClick={() => setNavOpen(false)}
              aria-current={v.id === view.id ? 'page' : undefined}
              className={cn('block rounded-md px-3 py-2 text-[13px] font-medium', v.id === view.id ? 'bg-nav-2 text-white' : 'hover:bg-nav-2 hover:text-white')}
            >
              {v.label}
            </Link>
          ))}
          {canSweep ? (
            <div className="mt-4 border-t border-white/10 pt-3">
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-nav-text/80">Administration</p>
              <button type="button" onClick={() => setSweepOpen(true)} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] font-medium hover:bg-nav-2 hover:text-white">
                <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                Run SLA sweep
              </button>
            </div>
          ) : null}
        </nav>
        <div className="border-t border-white/10 p-3">
          <p className="truncate text-[13px] font-semibold text-white" data-testid="viewer-name">
            {viewer?.displayName}
          </p>
          <div className="mt-1 flex items-center justify-between">
            <Badge tone="brand">{viewer ? ROLE_LABEL[viewer.role] : ''}</Badge>
            <Button variant="nav" size="sm" onClick={() => void logout()}>
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </div>
      </aside>

      <main className="flex min-h-0 flex-1">
        <div className={cn('min-h-0 w-full border-r border-line lg:block lg:w-[21rem] lg:shrink-0 xl:w-[25rem]', ticketId ? 'hidden' : 'block')}>
          <TicketList title={view.label} blurb={view.blurb} filter={view.filter} priority={priority} onPriority={setPriority} selectedId={ticketId} hrefFor={(id) => href(id)} />
        </div>
        <div className={cn('min-h-0 min-w-0 flex-1 lg:block', ticketId ? 'block' : 'hidden')}>
          {ticketId ? (
            <TicketDetail key={ticketId} id={ticketId} onBack={() => setParams({ view: view.id })} />
          ) : (
            <div className="hidden h-full items-center justify-center p-8 text-center text-[13px] text-ink-3 lg:flex">Select a ticket to see its conversation, SLA clocks and history.</div>
          )}
        </div>
      </main>

      <NewTicketDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(id) => setParams({ view: 'all', ticket: id })} />
      {canSweep ? <SweepDialog open={sweepOpen} onOpenChange={setSweepOpen} /> : null}
    </div>
  );
}
