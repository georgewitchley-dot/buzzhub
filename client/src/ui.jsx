import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { gsap } from 'gsap';

/* ---------- icons (inline, stroke-based) ---------- */
const P = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  floor: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  register: 'M4 7h16v13H4zM8 7V4h8v3M8 12h2M14 12h2M8 16h2M14 16h2',
  ticket: 'M4 5h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4zM9 5v12',
  menu: 'M5 4h14v16H5zM9 8h6M9 12h6M9 16h4',
  staff: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  plus: 'M12 5v14M5 12h14',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  back: 'M15 18l-6-6 6-6',
};
export function Icon({ name, size }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}

/* ---------- puck (pager LED) ---------- */
export const Puck = ({ state = 'idle', size }) => <span className="puck" data-state={state} style={size ? { '--size': `${size}px` } : undefined} aria-hidden="true" />;

/* ---------- modal ---------- */
export function Modal({ title, onClose, children, width }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    gsap.fromTo(el, { y: 18, opacity: 0, scale: 0.98 }, { y: 0, opacity: 1, scale: 1, duration: 0.28, ease: 'power3.out' });
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    el.querySelector('input, select, button.primary')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title} style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <header><h2>{title}</h2>{onClose && <button className="btn ghost sm" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>}</header>
        {children}
      </div>
    </div>
  );
}

/* ---------- toasts ---------- */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, kind = '') => {
    const id = Math.random().toString(36).slice(2);
    setItems((l) => [...l.slice(-3), { id, text, kind }]);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
