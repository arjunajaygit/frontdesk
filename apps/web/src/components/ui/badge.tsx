import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const badge = cva('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-semibold leading-4', {
  variants: {
    tone: {
      neutral: 'border-line bg-canvas text-ink-2',
      brand: 'border-brand/25 bg-brand-soft text-brand-ink',
      ok: 'border-ok/25 bg-ok-soft text-ok-ink',
      warn: 'border-warn/30 bg-warn-soft text-warn-ink',
      bad: 'border-danger/30 bg-danger-soft text-danger-ink',
      info: 'border-info-ink/20 bg-info-soft text-info-ink',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
