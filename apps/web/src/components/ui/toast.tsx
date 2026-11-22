import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type Tone = 'ok' | 'bad' | 'info';
interface ToastItem {
  id: number;
  tone: Tone;
  text: string;
}
const Ctx = createContext<{ push: (tone: Tone, text: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const push = useCallback((tone: Tone, text: string) => {
    const id = ++seq.current;
    setItems((cur) => [...cur.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), tone === 'bad' ? 9000 : 5000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  const Icon = { ok: CheckCircle2, bad: AlertTriangle, info: Info };
  return (
    <Ctx.Provider value={value}>
      {children}
      {/* aria-live region announces results to screen readers */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2" role="region" aria-label="Notifications">
        {items.map((t) => {
          const I = Icon[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === 'bad' ? 'alert' : 'status'}
              className={`pointer-events-auto flex items-start gap-2 rounded-lg border bg-surface p-3 text-[13px] shadow-pop ${t.tone === 'bad' ? 'border-danger/40' : t.tone === 'ok' ? 'border-ok/40' : 'border-line-strong'}`}
            >
              <I className={`mt-0.5 h-4 w-4 shrink-0 ${t.tone === 'bad' ? 'text-danger' : t.tone === 'ok' ? 'text-ok' : 'text-ink-3'}`} aria-hidden="true" />
              <p className="flex-1 text-ink">{t.text}</p>
              <button type="button" className="rounded p-1 text-ink-3 hover:bg-canvas" aria-label="Dismiss notification" onClick={() => setItems((cur) => cur.filter((x) => x.id !== t.id))}>
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
