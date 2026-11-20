import { io } from 'socket.io-client';
import { useEffect, useRef } from 'react';
import Lenis from 'lenis';

/* ---------- API ---------- */
export class ApiError extends Error {
  constructor(msg, status, data) { super(msg); this.status = status; this.data = data; }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'X-BuzzHub': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path.startsWith('/staff')) window.dispatchEvent(new Event('bh:locked'));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

/* ---------- sockets ---------- */
export const connectStaff = () => io({ withCredentials: true, transports: ['websocket', 'polling'] });
export const connectGuest = (guestToken) => io({ auth: { guestToken }, transports: ['websocket', 'polling'] });

/* ---------- formatting ---------- */
export function money(cents, currency = 'USD') {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100);
}
export function minutesSince(sqlTs) {
  if (!sqlTs) return 0;
  const t = new Date(sqlTs.replace(' ', 'T') + 'Z').getTime();
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}
export function timeOf(sqlTs) {
  if (!sqlTs) return '';
  return new Date(sqlTs.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* ---------- smooth scrolling (Lenis) on a given wrapper ---------- */
export function useLenis(wrapperRef, contentRef) {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const opts = wrapperRef ? { wrapper: wrapperRef.current, content: contentRef.current } : {};
    const lenis = new Lenis({ ...opts, lerp: 0.12, smoothWheel: true });
    let id;
    const raf = (t) => { lenis.raf(t); id = requestAnimationFrame(raf); };
    id = requestAnimationFrame(raf);
    return () => { cancelAnimationFrame(id); lenis.destroy(); };
  }, [wrapperRef, contentRef]);
}

/* ---------- tick every N ms to refresh "x min ago" ---------- */
import { useState } from 'react';
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => { const i = setInterval(() => set((n) => n + 1), ms); return () => clearInterval(i); }, [ms]);
}

export function useLatest(v) { const r = useRef(v); r.current = v; return r; }

/* ---------- accent colour from business settings ---------- */
export function applyAccent(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
  document.documentElement.style.setProperty('--accent', hex);
  const n = parseInt(hex.slice(1), 16);
  document.documentElement.style.setProperty('--accent-rgb', `${n >> 16}, ${(n >> 8) & 255}, ${n & 255}`);
}

/* ---------- buzzer sound: synthesized, no assets ---------- */
let ctx;
export function unlockAudio() {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export function playBuzz(times = 3) {
  const c = unlockAudio();
  const t0 = c.currentTime;
  for (let i = 0; i < times; i++) {
    for (const [f, off] of [[880, 0], [1320, 0.14]]) {
      const o = c.createOscillator(); const g = c.createGain();
      o.type = 'square'; o.frequency.value = f;
      const s = t0 + i * 0.6 + off;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.25, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.13);
      o.connect(g).connect(c.destination); o.start(s); o.stop(s + 0.15);
    }
  }
}
export function playChime() {
  const c = unlockAudio(); const t = c.currentTime;
  [660, 990].forEach((f, i) => {
    const o = c.createOscillator(); const g = c.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + i * 0.12); g.gain.exponentialRampToValueAtTime(0.15, t + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.4);
    o.connect(g).connect(c.destination); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.45);
  });
}
