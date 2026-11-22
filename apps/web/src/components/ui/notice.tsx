import { AlertTriangle, CheckCircle2, Info, Lock, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'info' | 'brand' | 'warn' | 'bad' | 'ok' | 'note';
const TONE: Record<Tone, { cls: string; icon: LucideIcon; iconCls: string }> = {
  info: { cls: 'border-info/20 bg-info-soft text-info-ink', icon: Info, iconCls: 'text-info' },
  brand: { cls: 'border-brand/20 bg-brand-soft text-brand-ink', icon: Info, iconCls: 'text-brand' },
  warn: { cls: 'border-warn/25 bg-warn-soft text-warn-ink', icon: AlertTriangle, iconCls: 'text-warn' },
  bad: { cls: 'border-danger/25 bg-danger-soft text-danger-ink', icon: AlertTriangle, iconCls: 'text-danger' },
  ok: { cls: 'border-ok/20 bg-ok-soft text-ok-ink', icon: CheckCircle2, iconCls: 'text-ok' },
  note: { cls: 'border-note-line bg-note-soft text-note-ink', icon: Lock, iconCls: 'text-note' },
};

/** Inline callout for session messages, lifecycle explanations and results. One consistent shape everywhere. */
export function Notice({
  tone,
  title,
  children,
  icon,
  role,
  className,
  action,
  ...rest
}: {
  tone: Tone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: LucideIcon | null;
  role?: 'status' | 'alert';
  className?: string;
  action?: ReactNode;
  'data-testid'?: string;
}) {
  const t = TONE[tone];
  const Icon = icon === null ? null : (icon ?? t.icon);
  return (
    <div role={role} className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-body', t.cls, className)} {...rest}>
      {Icon ? <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', t.iconCls)} aria-hidden="true" /> : null}
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
