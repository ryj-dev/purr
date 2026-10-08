import { useEffect, type ReactNode } from 'react';

export function Modal({ title, children, onClose, actions, wide }: { title: string; children: ReactNode; onClose: () => void; actions?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <div className="m-head"><h2>{title}</h2></div>
        <div className="m-body">{children}</div>
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}

/** In-page confirmation (never window.confirm). */
export function Confirm({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel }: {
  title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} actions={<>
      <button onClick={onCancel}>Cancel</button>
      <button className={danger ? 'danger solid' : 'primary'} onClick={onConfirm} autoFocus>{confirmLabel}</button>
    </>}>
      <div style={{ color: 'var(--text-2)', lineHeight: 1.55 }}>{message}</div>
    </Modal>
  );
}
