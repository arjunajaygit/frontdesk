import { AlertTriangle, CheckCircle2, Clock3, History, PauseCircle, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatIst, formatIstFull, formatWorking } from '@/lib/format';
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

/** Compact pill for list rows. Text + icon, never colour alone. */
export function SlaPill({ clock }: { clock: SlaClock | undefined }) {
  if (!clock) return null;
  const v = slaVisual(clock);
  const { tone, icon: Icon, word } = META[v];
  const detail = v === 'ontrack' ? formatWorking(clock.remainingMs) : v === 'breached' ? '' : '';
  return (
    <Badge tone={tone} title={`${KIND[clock.kind]} SLA: ${word}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">{KIND[clock.kind]} SLA: </span>
      <span aria-hidden="true">{clock.kind === 'RESPONSE' ? 'Resp' : 'Resol'}</span> {word}
      {detail ? ` · ${detail}` : ''}
    </Badge>
  );
}

/** Detailed card: authoritative deadline, remaining WORKING time, and history kept distinct from current status. */
export function SlaCard({ clock }: { clock: SlaClock }) {
  const v = slaVisual(clock);
  const { tone, icon: Icon, word } = META[v];
  const historical = clock.breachSequence > 0 && !clock.currentLate;
  return (
    <section aria-label={`${KIND[clock.kind]} SLA`} className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-2">
          {KIND[clock.kind]}
          {clock.kind === 'RESOLUTION' && clock.cycle > 0 ? ` · cycle ${clock.cycle + 1}` : ''}
        </h3>
        <Badge tone={tone}>
          <Icon className="h-3 w-3" aria-hidden="true" />
          {word}
        </Badge>
      </div>
      <dl className="mt-2 space-y-1 text-[13px]">
        {clock.state === 'RUNNING' && clock.deadlineAt ? (
          <>
            <Row k={clock.currentLate ? 'Was due' : 'Due'} v={formatIst(clock.deadlineAt)} />
            <Row k="Working time left" v={clock.currentLate ? 'None — overdue' : formatWorking(clock.remainingMs)} />
          </>
        ) : null}
        {clock.state === 'PAUSED' ? (
          <>
            <Row k="Status" v="Paused while waiting on the customer — no time is counting" />
            <Row k="Working time left" v={clock.currentLate ? 'None — over budget' : formatWorking(clock.remainingMs)} />
          </>
        ) : null}
        {clock.state === 'COMPLETED' ? <Row k="Completed" v={formatIst(clock.completedAt)} /> : null}
        {clock.state === 'CANCELLED' ? <Row k="Cancelled" v={`${formatIst(clock.cancelledAt)} (not a resolution)`} /> : null}
        <Row k="Budget" v={`${formatWorking(clock.budgetMs)} working time`} />
        {clock.firstBreachedAt ? <Row k="First breached" v={formatIstFull(clock.firstBreachedAt)} /> : null}
      </dl>
      {clock.breachDetectedNotRecorded ? (
        <p className="mt-2 rounded-md border border-danger/30 bg-danger-soft p-2 text-xs text-danger-ink">
          Overdue as of {formatIst(clock.asOf)}. The breach event has not been recorded yet; the next sweep records it.
        </p>
      ) : null}
      {historical || (clock.currentLate && clock.breachSequence > 1) ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-2">
          <History className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
  <div className="flex gap-2">
    <dt className="w-28 shrink-0 text-ink-3 sm:w-32">{k}</dt>
    <dd className="min-w-0 flex-1 text-ink">{v}</dd>
  </div>
);
