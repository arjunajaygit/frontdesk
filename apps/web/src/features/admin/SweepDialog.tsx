import { PlayCircle, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogActions } from '@/components/ui/dialog';
import { Notice } from '@/components/ui/notice';
import { Spinner } from '@/components/ui/states';
import { ApiError, newIdempotencyKey } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { SweepResult } from '@/lib/types';
import { useRunSweep } from '../tickets/api';

const MESSAGES: Record<string, string> = {
  SWEEP_IN_PROGRESS: 'A sweep with this request is already running. Wait a moment and try again.',
  SWEEP_FAILED: 'The sweep failed. Work that was already committed is kept; run it again to catch up.',
  SWEEP_LEASE_EXPIRED: 'The sweep took too long and was stopped safely. Work already committed is kept; run it again to continue.',
  RATE_LIMITED: 'You have run the sweep too often. Please wait a minute.',
  FORBIDDEN: 'Only support leads and admins can run the sweep.',
};

/** Real POST /admin/run-sla-sweep. There is no clock override: it processes what is genuinely due now. */
export function SweepDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const sweep = useRunSweep();
  const [result, setResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    setResult(null);
    setError(null);
    sweep.mutate(newIdempotencyKey(), {
      onSuccess: setResult,
      onError: (e) => setError(e instanceof ApiError ? (MESSAGES[e.code] ?? e.message) : 'The sweep could not be started. Check your connection and try again.'),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      icon={ShieldAlert}
      title="Run SLA / auto-close sweep"
      description="Records breaches that are due, closes tickets that waited more than five working days for a customer, and expires reopen windows older than seven days. The scheduler also does this automatically."
      className="max-w-lg"
    >
      <div className="space-y-3">
        {sweep.isPending ? (
          <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
            <Spinner label="Sweeping due tickets…" />
          </div>
        ) : null}
        {error ? (
          <Notice tone="bad" role="alert">
            {error}
          </Notice>
        ) : null}
        {result ? (
          <div role="status" className="space-y-3">
            <Notice tone="ok" title="Sweep finished">
              <p>{result.moreDue ? 'More work is still due (batch limit reached). Run the sweep again to continue.' : 'Nothing else is due right now.'}</p>
            </Notice>
            <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3" style={{ gap: 1 }}>
              <Stat k="Tickets processed" v={result.processed} testId="sweep-processed" />
              <Stat k="Auto-closed (no reply)" v={result.autoClosed} />
              <Stat k="Reopen windows expired" v={result.expired} />
              <Stat k="Breaches recorded" v={result.breachesRecorded} />
              <Stat k="Failures" v={result.failed} bad={result.failed > 0} />
            </dl>
          </div>
        ) : null}
      </div>
      <DialogActions>
        <Button onClick={() => onOpenChange(false)}>Close</Button>
        <Button variant="primary" onClick={run} disabled={sweep.isPending}>
          <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
          {result || error ? 'Run again' : 'Run sweep now'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const Stat = ({ k, v, testId, bad }: { k: string; v: number; testId?: string; bad?: boolean }) => (
  <div className="bg-surface px-3 py-2.5">
    <dt className="text-caption text-ink-3">{k}</dt>
    <dd className={cn('mt-0.5 text-heading font-semibold tabular-nums', bad ? 'text-danger-ink' : 'text-ink')} data-testid={testId}>
      {v}
    </dd>
  </div>
);
