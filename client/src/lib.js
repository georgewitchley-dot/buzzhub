import { io } from 'socket.io-client';
import { useEffect, useRef } from 'react';
import Lenis from 'lenis';

/* ---------- API ---------- */
export class ApiError extends Error {
  constructor(msg, status, data) { super(msg); this.status = status; this.data = data; }
}

export async function api(path, { method = 'GET', body, approval } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'X-BuzzHub': '1', ...(approval ? { 'X-Approval': approval } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // A manager has to OK this: ask for their PIN, then retry once with the approval
  if (res.status === 403 && data.needsApproval && !approval && window.__bhApprove) {
    const token = await window.__bhApprove(data.needsApproval);
    if (token) return api(path, { method, body, approval: token });
    throw new ApiError('Not approved', 403, data);
  }
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

/* ---------- phone notifications (Web Push) ---------- */
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try { return await navigator.serviceWorker.register('/sw.js', { scope: '/' }); } catch { return null; }
}

function b64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Ask permission and subscribe this phone. `endpoint` is where to save it:
 * '/g/<token>/push' for a waitlist visit, '/c/push' for a signed-in customer.
 * Returns 'on' | 'denied' | 'needs-install' | 'unsupported'.
 */
/** Is this phone already subscribed? If so, re-link it to `endpoint` (cheap) and return true. */
export async function pushIsOn(endpoint) {
  try {
    if (!pushSupported() || Notification.permission !== 'granted') return false;
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return false;
    if (endpoint) await api(endpoint, { method: 'POST', body: sub.toJSON() }).catch(() => {});
    return true;
  } catch { return false; }
}

export async function enablePush(endpoint) {
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!pushSupported()) return 'unsupported';
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (perm !== 'granted') return 'denied';
  const reg = (await registerSW()) || (await navigator.serviceWorker.ready);
  await navigator.serviceWorker.ready;
  const { publicKey } = await api('/public/vapid');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api(endpoint, { method: 'POST', body: sub.toJSON() });
  return 'on';
}

/** Point "Add to Home Screen" at a specific page (iPhone only delivers notifications to installed web apps). */
export function setManifest(href) {
  let link = document.querySelector('link[rel="manifest"]');
  if (!link) { link = document.createElement('link'); link.rel = 'manifest'; document.head.appendChild(link); }
  link.href = href;
}

/** Downscale an uploaded image to a PNG data URL (max 512px) so only clean pixels reach the server. */
export function imageToPng(file, max = 512) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

export function fmtSlot(startLocal) {
  const [d, t] = startLocal.split(' ');
  const date = new Date(`${d}T${t}:00Z`);
  return {
    day: date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }),
    time: date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }),
  };
}
