// Printing: send a job to a connected printer if one takes this kind, otherwise use the browser's print.
import { api } from './lib.js';

/** Try a connected printer first. Returns true when a printer took it. */
export async function devicePrint(kind, job, fallback, headers) {
  try {
    const r = await api('/print', { method: 'POST', body: { kind, ...job }, ...(headers ? { headers } : {}) });
    if (r.queued > 0) return true;
  } catch { /* no printers or offline: print here */ }
  fallback?.();
  return false;
}
/** Print a full page (reports, label sheets) on a page printer, or in the browser. */
export const printPage = (title, selector = '.cc-main, main') => devicePrint('report', { title, html: (document.querySelector(selector) || document.body).outerHTML.slice(0, 390000) }, () => window.print());

let routeCache = { at: 0, data: null, key: '' };
/** Which job kinds have printers (cached 30 s). */
export async function printRoutes(headers) {
  const key = headers ? JSON.stringify(headers) : '';
  if (routeCache.data && routeCache.key === key && Date.now() - routeCache.at < 30_000) return routeCache.data;
  try { const d = await api('/print/routes', headers ? { headers } : {}); routeCache = { at: Date.now(), data: d, key }; return d; } catch { return {}; }
}

/* ---------- ESC/POS for USB (Web Serial) and Bluetooth (Web Bluetooth) printers ---------- */
const ESC = 0x1b; const GS = 0x1d;
const ascii = (s) => Array.from(String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?')).map((c) => c.charCodeAt(0));
export function htmlToLines(html) {
  const d = document.createElement('div'); d.innerHTML = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  return (d.innerText || d.textContent || '').split('\n').map((t) => ({ text: t.trim() })).filter((l, i, a) => l.text || (a[i - 1] && a[i - 1].text));
}
export function escpos(job) {
  const width = job.printer?.width || 42; const out = [ESC, 0x40];
  for (const l of job.lines || htmlToLines(job.html || '')) {
    const w = l.big ? Math.floor(width / 2) : width; let text = l.text || '';
    if (l.right) text = text.length + l.right.length + 1 > w ? `${text}\n${' '.repeat(Math.max(0, w - l.right.length))}${l.right}` : `${text}${' '.repeat(w - text.length - l.right.length)}${l.right}`;
    out.push(ESC, 0x61, l.center ? 1 : 0, ESC, 0x45, l.bold || l.big ? 1 : 0, GS, 0x21, l.big ? 0x11 : 0, GS, 0x42, l.invert ? 1 : 0, ...ascii(text), 0x0a);
  }
  out.push(GS, 0x42, 0, GS, 0x21, 0, ESC, 0x45, 0, ESC, 0x61, 0, 0x0a, 0x0a, 0x0a);
  if (job.drawer) out.push(ESC, 0x70, 0, 25, 250);
  if (job.printer?.cut !== false) out.push(GS, 0x56, 66, 0);
  return new Uint8Array(out);
}
/** Common Bluetooth LE services used by thermal printers. */
export const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000ff00-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb'];
export async function bleWritable(device) {
  const server = device.gatt.connected ? device.gatt : await device.gatt.connect();
  for (const s of await server.getPrimaryServices()) {
    for (const c of await s.getCharacteristics()) if (c.properties.write || c.properties.writeWithoutResponse) return c;
  }
  throw new Error('No printing channel found on this Bluetooth device');
}
export async function bleWrite(device, bytes) {
  const ch = await bleWritable(device);
  for (let i = 0; i < bytes.length; i += 180) {
    const part = bytes.slice(i, i + 180);
    if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(part); else await ch.writeValue(part);
    await new Promise((r) => setTimeout(r, 20));
  }
}
export async function serialWrite(port, bytes) {
  if (!port.writable) await port.open({ baudRate: 9600 });
  const w = port.writable.getWriter(); try { await w.write(bytes); } finally { w.releaseLock(); }
}
