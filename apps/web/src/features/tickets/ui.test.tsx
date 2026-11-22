import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/components/ui/toast';
import type { SlaClock, StaffTicket } from '@/lib/types';
import { AuthProvider } from '../auth/auth';
import { Composer } from './Composer';
import { SlaCard, slaVisual } from './sla';
import { mergeMessages } from './Timeline';

vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));

const clock = (o: Partial<SlaClock>): SlaClock => ({
  id: 'c', kind: 'RESPONSE', cycle: 0, state: 'RUNNING', cycleStartedAt: '2026-11-23T04:00:00.000Z', budgetMs: 16_200_000, consumedMs: 0, remainingMs: 16_200_000,
  deadlineAt: '2026-11-23T08:30:00.000Z', completedAt: null, cancelledAt: null, currentLate: false, firstBreachedAt: null, breachDetectedNotRecorded: false,
  asOf: '2026-11-23T04:00:00.000Z', breachSequence: 0, policyRevision: 0, ...o,
});
const ticket = (o: Partial<StaffTicket> = {}): StaffTicket => ({
  id: 't1', subject: 's', status: 'IN_PROGRESS', priority: 'MEDIUM', requestedPriority: null, customerId: 'c', assigneeId: 'me', assigneeDisplayName: 'Me', createdAt: '2026-11-23T04:00:00.000Z',
  updatedAt: '2026-11-23T04:00:00.000Z', parentTicketId: null, version: 1, resolutionCycle: 0, waitingCloseDueAt: null, reopenUntil: null, closeReason: null, clocks: [clock({})], messages: [], olderMessagesCursor: null, ...o,
});
const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter>
      <ToastProvider>
        <AuthProvider>{ui}</AuthProvider>
      </ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>
);

describe('SLA presentation (server state only)', () => {
  it('distinguishes current status from history, and paused/completed/cancelled', () => {
    expect(slaVisual(clock({}))).toBe('ontrack');
    expect(slaVisual(clock({ currentLate: true }))).toBe('breached');
    expect(slaVisual(clock({ state: 'PAUSED' }))).toBe('paused');
    expect(slaVisual(clock({ state: 'COMPLETED' }))).toBe('completed');
    expect(slaVisual(clock({ state: 'CANCELLED' }))).toBe('cancelled');
  });
  it('shows a recovered clock as on track while keeping the breach history visible', () => {
    render(<SlaCard clock={clock({ breachSequence: 1, firstBreachedAt: '2026-11-23T05:00:00.000Z', currentLate: false })} />);
    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText(/1 breach episode on record — currently within budget/)).toBeInTheDocument();
  });
  it('labels a paused clock explicitly (not just by colour) and never shows a due time', () => {
    render(<SlaCard clock={clock({ state: 'PAUSED', deadlineAt: null })} />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.getByText(/no time is counting/)).toBeInTheDocument();
    expect(screen.queryByText('Due')).not.toBeInTheDocument();
  });
});

describe('timeline merge', () => {
  const m = (id: string, createdAt: string) => ({ id, body: id, createdAt, authorName: 'a', authorIsCustomer: false });
  it('orders by (createdAt, id), de-duplicates, and is stable for identical timestamps', () => {
    const t = '2026-11-23T04:00:00.000Z';
    const merged = mergeMessages([m('b', t), m('a', t)], [m('c', '2026-11-23T03:00:00.000Z'), m('a', t)]);
    expect(merged.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('composer: three distinct, isolated modes', () => {
  it('keeps a separate draft per mode, labels the team-only warning, and names exactly what each button does', async () => {
    const user = userEvent.setup();
    render(wrap(<Composer ticket={ticket()} canWrite />));
    expect(screen.getByRole('button', { name: 'Send public reply' })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: 'Internal note' }));
    expect(screen.getByText(/TEAM ONLY/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Internal note text'), 'secret thought');
    expect(screen.getByRole('button', { name: 'Add internal note' })).toBeEnabled();
    await user.click(screen.getByRole('radio', { name: 'Public reply' }));
    expect(screen.getByLabelText('Public reply text')).toHaveValue(''); // the note never leaks into the public draft
    expect(screen.queryByText(/TEAM ONLY/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Request information' }));
    expect(screen.getByRole('button', { name: 'Send request & wait' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Internal note' }));
    expect(screen.getByLabelText('Internal note text')).toHaveValue('secret thought');
  });

  it('only notes are allowed while waiting; non-assignees and resolved tickets get a read-only explanation', () => {
    const { unmount } = render(wrap(<Composer ticket={ticket({ status: 'WAITING' })} canWrite />));
    expect(screen.getByRole('radio', { name: 'Public reply' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Request information' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Internal note' })).toBeEnabled();
    unmount();
    render(wrap(<Composer ticket={ticket({ assigneeId: 'other', assigneeDisplayName: 'Priya' })} canWrite={false} />));
    expect(within(document.body).getByText(/Only the assignee \(Priya\)/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });
});
