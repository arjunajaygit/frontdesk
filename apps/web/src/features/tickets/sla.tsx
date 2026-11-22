import { AlertTriangle, CheckCircle2, Clock3, History, PauseCircle, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Notice } from '@/components/ui/notice';
import { formatIst, formatIstFull, formatWorking } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { SlaClock } from '@/lib/types';

export type SlaVisual = 'breached' | 'paused' | 'completed' | 'ontrack' | 'cancelled';

/** Pure presentation of SERVER state: no deadline, lateness or remaining-time computation happens here. */
export function slaVisual(c: SlaClock): SlaVisual {
  if (c.state === 'CANCELLED') return 'cancelled';
  if (c.state === 'COMPLETED') return 'completed';
  if (c.currentLate) return 'breached';
  if (c.state === 'PAUSED') return 'paused';
  return 'ontrack';
}

const META = {
  breached: { tone: 'bad', icon: AlertTriangle, word: 'Breached' },
  paused: { tone: 'warn', icon: PauseCircle, word: 'Paused' },
  completed: { tone: 'ok', icon: CheckCircle2, word: 'Completed' },
  ontrack: { tone: 'brand', icon: Clock3, word: 'On track' },
  cancelled: { tone: 'neutral', icon: XCircle, word: 'Cancelled' },
} as const;

const KIND = { RESPONSE: 'Response', RESOLUTION: 'Resolution' } as const;

/** Latest cycle of each kind: reopened tickets show their current resolution cycle, history stays in the audit tab. */
export function currentClocks(clocks: SlaClock[]): { response?: SlaClock; resolution?: SlaClock } {
  const pick = (k: SlaClock['kind']) => clocks.filter((c) => c.kind === k).sort((a, b) => b.cycle - a.cycle)[0];
  return { response: pick('RESPONSE'), resolution: pick('RESOLUTION') };
}

/**
 * Share of the working-time budget already used, from the server's own numbers (budget − remaining).
 * Only meaningful while the clock is counting or paused; null otherwise (no bar is drawn).
 */
export function budgetUsed(c: SlaClock): number | null {
  if ((c.state !== 'RUNNING' && c.state !== 'PAUSED') || c.budgetMs <= 0) return null;
  if (c.currentLate) return 1;
  return Math.min(1, Math.max(0, (c.budgetMs - c.remainingMs) / c.budgetMs));
}

/** Compact indicator for list rows. Text + icon, never colour alone. */
export function SlaPill({ clock }: { clock: SlaClock | undefined }) {
  if (!clock) return null;
  const v = slaVisual(clock);
  const { tone, icon: Icon, word } = META[v];
  const detail = v === 'ontrack' ? formatWorking(clock.remainingMs) : '';
  return (
    <Badge tone={tone} title={`${KIND[clock.kind]} SLA: ${word}`} className="tabular-nums">
      <Icon aria-hidden="true" />
      <span className="sr-only">{KIND[clock.kind]} SLA: </span>
      <span aria-hidden="true" className="font-normal">
        {clock.kind === 'RESPONSE' ? 'Resp' : 'Resol'}
      </span>
      {word}
      {detail ? <span className="font-normal">· {detail}</span> : null}
    </Badge>
  );
}

/** Detailed card: authoritative deadline, remaining WORKING time, and history kept distinct from current status. */
export function SlaCard({ clock }: { clock: SlaClock }) {
  const v = slaVisual(clock);
  const { tone, icon: Icon, word } = META[v];
  const historical = clock.breachSequence > 0 && !clock.currentLate;
  const used = budgetUsed(clock);
  const counting = clock.state === 'RUNNING' || clock.state === 'PAUSED';
  const barTone = clock.currentLate ? 'bg-danger' : clock.state === 'PAUSED' ? 'bg-warn' : used !== null && used >= 0.8 ? 'bg-warn' : 'bg-brand';
  return (
    <section aria-label={`${KIND[clock.kind]} SLA`} className={cn('rounded-lg border bg-surface p-3.5 shadow-xs', clock.currentLate && counting ? 'border-danger/30' : 'border-line')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-caption font-semibold uppercase tracking-[0.06em] text-ink-3">
          {KIND[clock.kind]}
          {clock.kind === 'RESOLUTION' && clock.cycle > 0 ? ` · cycle ${clock.cycle + 1}` : ''}
        </h3>
        <Badge tone={tone}>
          <Icon aria-hidden="true" />
          {word}
        </Badge>
      </div>

      {counting ? (
        <div className="mt-2.5">
          <p className="flex items-baseline gap-1.5">
            <span className={cn('text-heading font-semibold tabular-nums tracking-[-0.01em]', clock.currentLate ? 'text-danger-ink' : 'text-ink')}>
              {clock.currentLate ? 'Overdue' : formatWorking(clock.remainingMs)}
            </span>
            <span className="text-meta text-ink-3">{clock.currentLate ? (clock.state === 'PAUSED' ? 'over budget' : 'no working time left') : 'working time left'}</span>
          </p>
          {used !== null ? (
            <div
              role="progressbar"
              aria-label={`${KIND[clock.kind]} working-time budget used`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(used * 100)}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-sunken"
            >
              <div className={cn('h-full rounded-full transition-[width] duration-300', barTone)} style={{ width: `${Math.max(used * 100, 2)}%` }} />
            </div>
          ) : null}
        </div>
      ) : null}

      <dl className="mt-3 space-y-1.5 text-body">
        {clock.state === 'RUNNING' && clock.deadlineAt ? <Row k={clock.currentLate ? 'Was due' : 'Due'} v={formatIst(clock.deadlineAt)} /> : null}
        {clock.state === 'PAUSED' ? <Row k="Status" v="Paused while waiting on the customer — no time is counting" /> : null}
        {clock.state === 'COMPLETED' ? <Row k="Completed" v={formatIst(clock.completedAt)} /> : null}
        {clock.state === 'CANCELLED' ? <Row k="Cancelled" v={`${formatIst(clock.cancelledAt)} (not a resolution)`} /> : null}
        <Row k="Budget" v={`${formatWorking(clock.budgetMs)} working time`} />
        {clock.firstBreachedAt ? <Row k="First breached" v={formatIstFull(clock.firstBreachedAt)} /> : null}
      </dl>
      {clock.breachDetectedNotRecorded ? (
        <Notice tone="bad" className="mt-3 text-meta">
          Overdue as of {formatIst(clock.asOf)}. The breach event has not been recorded yet; the next sweep records it.
        </Notice>
      ) : null}
      {historical || (clock.currentLate && clock.breachSequence > 1) ? (
        <p className="mt-3 flex items-start gap-1.5 border-t border-line pt-2.5 text-meta text-ink-2">
          <History className="mt-px h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          <span>
            {clock.breachSequence} breach {clock.breachSequence === 1 ? 'episode' : 'episodes'} on record
            {historical ? ' — currently within budget (history is kept in the audit trail).' : '.'}
          </span>
        </p>
      ) : null}
    </section>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex gap-3">
    <dt className="w-24 shrink-0 text-ink-3">{k}</dt>
    <dd className="min-w-0 flex-1 tabular-nums text-ink">{v}</dd>
  </div>
);

/** Both clocks plus the working-hours rule that explains them. `stacked` for the side rail. */
export function SlaPanel({ response, resolution, stacked }: { response?: SlaClock; resolution?: SlaClock; stacked?: boolean }) {
  if (!response && !resolution) return null;
  return (
    <div className="@container">
      {/* Container query: side by side only when the PANE (not the viewport) has room for two readable cards. */}
      <div className={cn('grid grid-cols-1 gap-3', stacked ? '' : '@[40rem]:grid-cols-2')}>
        {response ? <SlaCard clock={response} /> : null}
        {resolution ? <SlaCard clock={resolution} /> : null}
      </div>
      <p className="mt-2.5 text-caption text-ink-3">Clocks count working time only: Monday–Friday, 09:30–18:30 IST, excluding configured holidays.</p>
    </div>
  );
}
