import { PlayCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/states';
import { ApiError, newIdempotencyKey } from '@/lib/api';
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
    <Dialog open={open} onOpenChange={onOpenChange} title="Run SLA / auto-close sweep" description="Records breaches that are due, closes tickets that waited more than five working days for a customer, and expires reopen windows older than seven days. The scheduler also does this automatically." className="max-w-lg">
      <div className="space-y-3">
        {sweep.isPending ? <Spinner label="Sweeping due tickets…" /> : null}
        {error ? (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px] text-danger-ink">
            {error}
          </p>
        ) : null}
        {result ? (
          <div role="status" className="space-y-2 rounded-md border border-ok/30 bg-ok-soft p-3 text-[13px]">
            <p className="font-semibold text-ok-ink">Sweep finished</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <dt>Tickets processed</dt>
              <dd className="font-semibold" data-testid="sweep-processed">{result.processed}</dd>
              <dt>Auto-closed (no reply)</dt>
              <dd className="font-semibold">{result.autoClosed}</dd>
              <dt>Reopen windows expired</dt>
              <dd className="font-semibold">{result.expired}</dd>
              <dt>Breaches recorded</dt>
              <dd className="font-semibold">{result.breachesRecorded}</dd>
              <dt>Failures</dt>
              <dd className="font-semibold">{result.failed}</dd>
            </dl>
            <p>{result.moreDue ? 'More work is still due (batch limit reached). Run the sweep again to continue.' : 'Nothing else is due right now.'}</p>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button variant="primary" onClick={run} disabled={sweep.isPending}>
            <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {result || error ? 'Run again' : 'Run sweep now'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
