import { ChevronDown } from 'lucide-react';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Shared control surface: hairline border, soft inner shadow, teal border + halo on focus (3:1 against white). */
const control =
  'w-full rounded-md border border-control bg-surface px-3 text-body text-ink shadow-xs transition-[border-color,box-shadow] duration-150 placeholder:text-ink-3 hover:border-ink-3 focus:border-brand focus:outline-none focus:ring-[3px] focus:ring-brand/15 disabled:cursor-not-allowed disabled:bg-sunken disabled:opacity-70 aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/15';

export function Field({
  label,
  hint,
  error,
  hideLabel,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  /** Visually hidden but still the accessible name (compact toolbars). */
  hideLabel?: boolean;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'block text-meta font-medium text-ink-2'}>
        {label}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined })}
      {error ? (
        <p id={`${id}-err`} role="alert" className="text-meta font-medium text-danger-ink">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-meta text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn(control, 'h-9', className)} {...p} />);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn(control, 'min-h-24 resize-y py-2 leading-relaxed', className)} {...p} />
));
Textarea.displayName = 'Textarea';

/** Native select (best keyboard + mobile behaviour) with a consistent chevron. `className` sizes the wrapper. */
export const Select = forwardRef<HTMLSelectElement, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> & { size?: 'sm' | 'md' }>(({ className, size = 'md', ...p }, ref) => (
  <div className={cn('relative', className)}>
    <select ref={ref} className={cn(control, 'cursor-pointer appearance-none pr-8', size === 'sm' ? 'h-8 text-meta' : 'h-9')} {...p} />
    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-3" aria-hidden="true" />
  </div>
));
Select.displayName = 'Select';
