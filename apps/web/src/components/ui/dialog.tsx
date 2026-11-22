import * as D from '@radix-ui/react-dialog';
import { X, type LucideIcon } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Radix Dialog: focus trap, Escape, focus restore and aria wiring come from the primitive.
 * Floating glass panel over a softly dimmed workspace; fits the viewport on phones (scrolls inside).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  icon: Icon,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  // Controlled dialogs have no Dialog.Trigger, so Radix cannot restore focus on its own: remember the opener
  // (captured during render, before focus moves into the dialog) and return focus to it on close.
  const opener = useRef<Element | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) opener.current = document.activeElement;
  wasOpen.current = open;
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[3px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <D.Content
          className={cn(
            'glass-strong fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-white/60 p-5 shadow-pop ring-1 ring-ink/[0.06] data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in sm:p-6',
            className,
          )}
          {...(description ? {} : { 'aria-describedby': undefined })}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            (opener.current as HTMLElement | null)?.focus?.();
          }}
        >
          <div className="mb-5 flex items-start gap-3">
            {Icon ? (
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-brand/15 bg-brand-soft text-brand">
                <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <D.Title className="text-title font-semibold text-ink">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-body text-ink-2">{description}</D.Description> : null}
            </div>
            <D.Close className="-m-1.5 rounded-md p-2 text-ink-3 transition-colors hover:bg-ink/[0.06] hover:text-ink" aria-label="Close dialog">
              <X className="h-4 w-4" aria-hidden="true" />
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Consistent action row: secondary action left of the primary one, stacked full-width on narrow phones. */
export const DialogActions = ({ children }: { children: ReactNode }) => <div className="mt-6 flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">{children}</div>;
