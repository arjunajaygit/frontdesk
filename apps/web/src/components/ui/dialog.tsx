import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Radix Dialog: focus trap, Escape, focus restore and aria wiring come from the primitive. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: string;
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
        <D.Overlay className="fixed inset-0 z-40 bg-nav/55" />
        <D.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line bg-surface p-5 shadow-pop',
            className,
          )}
          aria-describedby={description ? undefined : undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            (opener.current as HTMLElement | null)?.focus?.();
          }}
        >
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-base font-semibold text-ink">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-[13px] text-ink-2">{description}</D.Description> : null}
            </div>
            <D.Close className="-m-1 rounded-md p-2 text-ink-3 hover:bg-canvas" aria-label="Close dialog">
              <X className="h-4 w-4" aria-hidden="true" />
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
