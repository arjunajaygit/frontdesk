import { AlertCircle, Inbox, Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

export const Skeleton = ({ className = '' }: { className?: string }) => <div className={cn('fd-skeleton', className)} aria-hidden="true" />;

/** Placeholder rows shaped like the real ticket rows, so content does not jump when it arrives. */
export function LoadingRows({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-2.5 border-b border-line px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
          <Skeleton className={cn('h-3.5', i % 3 === 0 ? 'w-4/5' : i % 3 === 1 ? 'w-3/5' : 'w-2/3')} />
          <div className="flex gap-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

function StateFrame({ icon: Icon, tone, title, children, action, role }: { icon: LucideIcon; tone: 'neutral' | 'bad'; title?: string; children?: ReactNode; action?: ReactNode; role?: 'alert' }) {
  return (
    <div role={role} className="flex flex-col items-center px-6 py-14 text-center">
      <span className={cn('mb-3 grid h-10 w-10 place-items-center rounded-full border', tone === 'bad' ? 'border-danger/20 bg-danger-soft text-danger' : 'border-line bg-surface-2 text-ink-3')}>
        <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      {title ? <p className="text-ui font-semibold text-ink">{title}</p> : null}
      {children ? <p className="mt-1 max-w-sm text-body text-ink-2">{children}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function EmptyState({ title, children, icon = Inbox, action }: { title: string; children?: ReactNode; icon?: LucideIcon; action?: ReactNode }) {
  return (
    <StateFrame icon={icon} tone="neutral" title={title} action={action}>
      {children}
    </StateFrame>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <StateFrame
      role="alert"
      icon={AlertCircle}
      tone="bad"
      action={
        onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    >
      {message}
    </StateFrame>
  );
}

export const Spinner = ({ label = 'Working' }: { label?: string }) => (
  <span role="status" className="inline-flex items-center gap-2 text-body text-ink-2">
    <Loader2 className="h-4 w-4 animate-spin text-brand motion-reduce:animate-none" aria-hidden="true" />
    {label}
  </span>
);
