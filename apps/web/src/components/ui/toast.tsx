import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'ok' | 'bad' | 'info';
interface ToastItem {
  id: number;
  tone: Tone;
  text: string;
}
const Ctx = createContext<{ push: (tone: Tone, text: string) => void } | null>(null);

const ICON = { ok: CheckCircle2, bad: AlertTriangle, info: Info };
const ICON_TONE = { ok: 'text-ok', bad: 'text-danger', info: 'text-info' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((tone: Tone, text: string) => {
    const id = ++seq.current;
    setItems((cur) => [...cur.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), tone === 'bad' ? 9000 : 5000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* Each toast is its own status/alert region, so results are announced to screen readers. */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(23rem,calc(100vw-2rem))] flex-col gap-2" role="region" aria-label="Notifications">
        {items.map((t) => {
          const I = ICON[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === 'bad' ? 'alert' : 'status'}
              className={cn(
                'glass-strong pointer-events-auto flex animate-rise-in items-start gap-2.5 rounded-lg border p-3 text-body shadow-pop',
                t.tone === 'bad' ? 'border-danger/30' : 'border-line',
              )}
            >
              <I className={cn('mt-0.5 h-4 w-4 shrink-0', ICON_TONE[t.tone])} aria-hidden="true" />
              <p className="flex-1 text-ink">{t.text}</p>
              <button
                type="button"
                className="-m-1 rounded-md p-1.5 text-ink-3 transition-colors hover:bg-ink/[0.06] hover:text-ink"
                aria-label="Dismiss notification"
                onClick={() => setItems((cur) => cur.filter((x) => x.id !== t.id))}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('ToastProvider missing');
  return c;
}
