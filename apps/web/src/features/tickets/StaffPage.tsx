import { AlertTriangle, Archive, CheckCircle2, CircleDashed, Hourglass, Inbox, LogOut, Menu, MousePointerClick, Plus, ShieldAlert, UserRound, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Avatar, LogoMark, Tip, Wordmark } from '@/components/ui/identity';
import { cn } from '@/lib/utils';
import type { Priority } from '@/lib/types';
import { SweepDialog } from '../admin/SweepDialog';
import { useAuth } from '../auth/auth';
import { NewTicketDialog } from './NewTicketDialog';
import { TicketDetail } from './TicketDetail';
import { TicketList } from './TicketList';
import { VIEWS, viewById, type ViewId } from './views';

const ROLE_LABEL = { AGENT: 'Agent', LEAD: 'Support lead', ADMIN: 'Admin', CUSTOMER: 'Customer' } as const;
const VIEW_ICON: Record<ViewId, LucideIcon> = {
  all: Inbox,
  mine: UserRound,
  unassigned: CircleDashed,
  breached: AlertTriangle,
  waiting: Hourglass,
  resolved: CheckCircle2,
  closed: Archive,
};

/**
 * Staff workspace. Desktop: navigation | ticket list | ticket detail, with the two panes on one raised sheet.
 * Mobile: glass top bar + slide-in navigation drawer, and a list → detail drill-down.
 */
export function StaffPage() {
  const { viewer, logout } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = viewById(params.get('view'));
  const ticketId = params.get('ticket');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [navOpen, setNavOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const canSweep = viewer?.role === 'LEAD' || viewer?.role === 'ADMIN';

  useEffect(() => setNavOpen(false), [view.id]);
  // Mobile drawer: Escape closes it; opening moves focus into the navigation.
  useEffect(() => {
    if (!navOpen) return;
    navRef.current?.querySelector<HTMLElement>('a[aria-current="page"], a')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setNavOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);
  const href = (id: string | null, v = view.id) => `/staff?view=${v}${id ? `&ticket=${id}` : ''}`;

  return (
    <div className="flex h-dvh flex-col bg-canvas lg:flex-row">
      {/* Mobile top bar (glass: the list scrolls beneath its edge on overscroll). */}
      <header className="glass-canvas relative z-30 flex h-13 shrink-0 items-center gap-2.5 border-b border-line px-3 lg:hidden">
        <LogoMark className="h-6 w-6" />
        <span className="text-ui font-semibold">Frontdesk</span>
        <span className="ml-auto truncate text-meta text-ink-3">{view.label}</span>
        <Button variant="ghost" size="icon" aria-expanded={navOpen} aria-controls="staff-nav" aria-label={navOpen ? 'Close menu' : 'Open menu'} onClick={() => setNavOpen((o) => !o)}>
          {navOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
        </Button>
      </header>

      {/* Scrim for the mobile drawer. */}
      <div aria-hidden="true" onClick={() => setNavOpen(false)} className={cn('fixed inset-0 z-30 bg-ink/20 backdrop-blur-[2px] lg:hidden', navOpen ? 'block animate-fade-in' : 'hidden')} />

      <aside
        id="staff-nav"
        ref={navRef}
        className={cn(
          'z-40 flex w-[min(17rem,84vw)] shrink-0 flex-col transition-[transform,visibility] duration-200 ease-out',
          'max-lg:glass-canvas max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:border-r max-lg:border-line max-lg:shadow-pop',
          navOpen ? 'max-lg:visible max-lg:translate-x-0' : 'max-lg:invisible max-lg:-translate-x-full',
          'lg:w-56 xl:w-60',
        )}
      >
        <div className="flex h-14 items-center px-4">
          <Wordmark sub="Arvo support" />
        </div>
        <div className="px-3 pb-2">
          <Button variant="primary" className="w-full" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New ticket
          </Button>
        </div>
        <nav aria-label="Ticket views" className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
          <p className="px-2.5 pb-1.5 text-caption font-medium text-ink-3">Views</p>
          <ul className="space-y-px">
            {VIEWS.map((v) => {
              const Icon = VIEW_ICON[v.id];
              const active = v.id === view.id;
              return (
                <li key={v.id}>
                  <Link
                    to={href(null, v.id)}
                    onClick={() => setNavOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-9 items-center gap-2.5 rounded-md border px-2.5 text-body font-medium transition-colors duration-150',
                      active ? 'border-line bg-surface text-ink shadow-xs' : 'border-transparent text-ink-2 hover:bg-ink/[0.045] hover:text-ink',
                    )}
                  >
                    <Icon className={cn('h-4 w-4', v.id === 'breached' ? 'text-danger' : active ? 'text-brand' : 'text-ink-3')} aria-hidden="true" />
                    {v.label}
                  </Link>
                </li>
              );
            })}
          </ul>
          {canSweep ? (
            <div className="mt-5">
              <p className="px-2.5 pb-1.5 text-caption font-medium text-ink-3">Administration</p>
              <button
                type="button"
                onClick={() => setSweepOpen(true)}
                className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body font-medium text-ink-2 transition-colors duration-150 hover:bg-ink/[0.045] hover:text-ink"
              >
                <ShieldAlert className="h-4 w-4 text-ink-3" aria-hidden="true" />
                Run SLA sweep
              </button>
            </div>
          ) : null}
        </nav>
        <div className="m-2 flex items-center gap-2.5 rounded-lg border border-line bg-surface p-2.5 shadow-xs">
          <Avatar name={viewer?.displayName} tone="brand" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-semibold text-ink" data-testid="viewer-name">
              {viewer?.displayName}
            </p>
            <p className="truncate text-caption text-ink-3">{viewer ? ROLE_LABEL[viewer.role] : ''}</p>
          </div>
          <Tip label="Sign out" side="top">
            <Button variant="ghost" size="icon-sm" aria-label="Sign out" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </Button>
          </Tip>
        </div>
      </aside>

      <main className="flex min-h-0 flex-1 lg:py-2 lg:pr-2">
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-surface lg:rounded-xl lg:border lg:border-line lg:shadow-sm">
          <div className={cn('min-h-0 w-full border-line lg:block lg:w-[22rem] lg:shrink-0 lg:border-r xl:w-[25rem]', ticketId ? 'hidden' : 'block')}>
            <TicketList title={view.label} blurb={view.blurb} filter={view.filter} priority={priority} onPriority={setPriority} selectedId={ticketId} hrefFor={(id) => href(id)} />
          </div>
          <div className={cn('min-h-0 min-w-0 flex-1 lg:block', ticketId ? 'block' : 'hidden')}>
            {ticketId ? (
              <TicketDetail key={ticketId} id={ticketId} onBack={() => setParams({ view: view.id })} />
            ) : (
              <div className="hidden h-full flex-col items-center justify-center gap-3 bg-surface-2 p-8 text-center lg:flex">
                <span className="grid h-11 w-11 place-items-center rounded-full border border-line bg-surface text-ink-3 shadow-xs">
                  <MousePointerClick className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-ui font-semibold text-ink">No ticket selected</p>
                  <p className="mt-1 max-w-xs text-body text-ink-3">Select a ticket to see its conversation, SLA clocks and history.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      <NewTicketDialog open={newOpen} onOpenChange={setNewOpen} onCreated={(id) => setParams({ view: 'all', ticket: id })} />
      {canSweep ? <SweepDialog open={sweepOpen} onOpenChange={setSweepOpen} /> : null}
    </div>
  );
}
