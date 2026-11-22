import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The Frontdesk mark: a ticket stub (side notches + perforation) in ink with a teal tab — support tickets,
 * handled precisely. Decorative; the wordmark next to it carries the name.
 */
export function LogoMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <path
        d="M7 5h18a3 3 0 0 1 3 3v4.5a3.5 3.5 0 0 0 0 7V24a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-4.5a3.5 3.5 0 0 0 0-7V8a3 3 0 0 1 3-3Z"
        fill="#14181f"
      />
      <path d="M20 5h5a3 3 0 0 1 3 3v4.5a3.5 3.5 0 0 0 0 7V24a3 3 0 0 1-3 3h-5V5Z" fill="#0f766e" />
      <path d="M20 8.5v15" stroke="#f5f5f2" strokeWidth="1.4" strokeDasharray="1.6 2.2" strokeLinecap="round" />
      <path d="M9 12h7M9 16h5M9 20h6" stroke="#f5f5f2" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ sub }: { sub?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark />
      <span className="leading-tight">
        <span className="block text-title font-semibold tracking-[-0.01em] text-ink">Frontdesk</span>
        {sub ? <span className="block text-caption text-ink-3">{sub}</span> : null}
      </span>
    </span>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** Initials avatar. Decorative: the person's name is always rendered as text beside it. */
export function Avatar({ name, tone = 'neutral', size = 'md' }: { name: string | null | undefined; tone?: 'neutral' | 'brand' | 'note' | 'info'; size?: 'sm' | 'md' }) {
  const toneCls = {
    neutral: 'bg-sunken text-ink-2 ring-line',
    brand: 'bg-brand-soft text-brand-ink ring-brand/20',
    note: 'bg-note-soft text-note-ink ring-note-line',
    info: 'bg-info-soft text-info-ink ring-info/20',
  }[tone];
  const sizeCls = size === 'sm' ? 'h-6 w-6 text-[10px]' : 'h-8 w-8 text-caption';
  if (!name)
    return <span aria-hidden="true" className={cn('inline-block shrink-0 rounded-full border border-dashed border-line-strong', size === 'sm' ? 'h-6 w-6' : 'h-8 w-8')} />;
  return (
    <span aria-hidden="true" className={cn('inline-grid shrink-0 select-none place-items-center rounded-full font-semibold ring-1 ring-inset', toneCls, sizeCls)}>
      {initials(name)}
    </span>
  );
}

export const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line-strong bg-surface px-1 font-sans text-[10.5px] font-medium text-ink-2 shadow-[0_1px_0_var(--color-line-strong)]">{children}</kbd>
);

/**
 * Lightweight tooltip for icon-only controls: shown on hover and keyboard focus. The control keeps its own
 * aria-label (the accessible name); the bubble is a visual echo, hidden from assistive technology.
 */
export function Tip({ label, children, side = 'bottom' }: { label: string; children: ReactNode; side?: 'bottom' | 'top' }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-caption font-medium text-white opacity-0 shadow-pop transition-opacity delay-0 duration-150 group-hover/tip:opacity-100 group-hover/tip:delay-300 group-has-[:focus-visible]/tip:opacity-100',
          side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
        )}
      >
        {label}
      </span>
    </span>
  );
}
