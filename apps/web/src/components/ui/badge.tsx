import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Compact label. Always text (plus an icon where useful) — colour is never the only signal. */
const badge = cva('inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 text-caption font-medium [&_svg]:h-3 [&_svg]:w-3 [&_svg]:shrink-0', {
  variants: {
    tone: {
      neutral: 'border-line bg-surface-2 text-ink-2',
      brand: 'border-brand/20 bg-brand-soft text-brand-ink',
      ok: 'border-ok/20 bg-ok-soft text-ok-ink',
      warn: 'border-warn/25 bg-warn-soft text-warn-ink',
      bad: 'border-danger/25 bg-danger-soft text-danger-ink',
      info: 'border-info/20 bg-info-soft text-info-ink',
      note: 'border-note-line bg-note-soft text-note-ink',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export type BadgeTone = NonNullable<VariantProps<typeof badge>['tone']>;

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
