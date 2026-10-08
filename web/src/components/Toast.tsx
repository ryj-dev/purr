import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

type Kind = 'info' | 'error' | 'ok';
interface T { id: number; kind: Kind; text: string }
const Ctx = createContext<(text: string, kind?: Kind) => void>(() => {});
const ICON = { info: Info, error: CircleAlert, ok: CircleCheck };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const push = useCallback((text: string, kind: Kind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => {
          const Icon = ICON[t.kind];
          return (
            <div key={t.id} className={`toast ${t.kind}`}>
              <Icon size={15} />
              <span className="txt">{t.text}</span>
              <span className="x" role="button" aria-label="Dismiss" onClick={() => setItems((x) => x.filter((y) => y.id !== t.id))}><X size={13} /></span>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
