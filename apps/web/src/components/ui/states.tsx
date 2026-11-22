import { AlertCircle, Inbox, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';

export const Skeleton = ({ className = '' }: { className?: string }) => <div className={`fd-skeleton ${className}`} aria-hidden="true" />;

export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-px">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2 border-b border-line p-3">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Inbox className="h-7 w-7 text-ink-3" aria-hidden="true" />
      <p className="font-semibold text-ink">{title}</p>
      {children ? <p className="max-w-sm text-[13px] text-ink-2">{children}</p> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <AlertCircle className="h-7 w-7 text-danger" aria-hidden="true" />
      <p className="max-w-sm text-[13px] text-ink-2">{message}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export const Spinner = ({ label = 'Working' }: { label?: string }) => (
  <span role="status" className="inline-flex items-center gap-2 text-[13px] text-ink-2">
    <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    {label}
  </span>
);
