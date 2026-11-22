#!/usr/bin/env node
// BuzzHub print helper: runs on any computer or Raspberry Pi at the business and sends print jobs
// from BuzzHub to printers on the local network (Wi-Fi / Ethernet, port 9100) or to a printer device
// (USB: /dev/usb/lp0, paired classic Bluetooth: /dev/rfcomm0, Windows: \\.\COM3).
// Needs Node 18 or newer. No packages to install.
//
//   node buzzhub-print-agent.mjs --server https://your-buzzhub.example --token PASTE_TOKEN
//
// Or set BUZZHUB_SERVER and BUZZHUB_PRINT_TOKEN. Keep it running (pm2, systemd, Task Scheduler).
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';

const VERSION = '1.0.0';
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const SERVER = (arg('server') || process.env.BUZZHUB_SERVER || '').replace(/\/$/, '');
const TOKEN = arg('token') || process.env.BUZZHUB_PRINT_TOKEN || '';
if (!SERVER || !TOKEN) { console.error('Usage: node buzzhub-print-agent.mjs --server https://your-buzzhub --token TOKEN'); process.exit(1); }
let LOC = 'main';
try { LOC = JSON.parse(Buffer.from(TOKEN.split('.')[1], 'base64url').toString()).loc || 'main'; } catch { /* keep main */ }
const headers = { 'X-Print': TOKEN, 'X-Location': LOC, 'X-BuzzHub': '1', 'Content-Type': 'application/json' };
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

/* ---------- ESC/POS ---------- */
const ESC = 0x1b; const GS = 0x1d;
const ascii = (s) => Buffer.from(String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?'), 'latin1');
export function escpos(job) {
  const width = job.printer?.width || 42; const parts = [Buffer.from([ESC, 0x40])];
  const lines = job.lines || htmlToLines(job.html || '');
  for (const l of lines) {
    if (l.qr) { const d = Buffer.from(String(l.qr), 'utf8'); const n = d.length + 3; parts.push(Buffer.from([ESC, 0x61, 1, GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0, GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, 6, GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31, GS, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30]), d, Buffer.from([GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30, 0x0a])); continue; }
    const w = l.big ? Math.floor(width / 2) : width;
    let text = l.text || '';
    if (l.right) { const gap = Math.max(1, w - text.length - l.right.length); text = text.length + l.right.length + 1 > w ? `${text}\n${' '.repeat(Math.max(0, w - l.right.length))}${l.right}` : `${text}${' '.repeat(gap)}${l.right}`; }
    parts.push(Buffer.from([ESC, 0x61, l.center ? 1 : 0, ESC, 0x45, l.bold || l.big ? 1 : 0, GS, 0x21, l.big ? 0x11 : 0x00, GS, 0x42, l.invert ? 1 : 0]));
    parts.push(ascii(text), Buffer.from([0x0a]));
  }
  parts.push(Buffer.from([GS, 0x42, 0, GS, 0x21, 0, ESC, 0x45, 0, ESC, 0x61, 0, 0x0a, 0x0a, 0x0a]));
  if (job.drawer) parts.push(Buffer.from([ESC, 0x70, 0, 25, 250]));
  if (job.printer?.cut !== false) parts.push(Buffer.from([GS, 0x56, 66, 0]));
  return Buffer.concat(parts);
}
function htmlToLines(html) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').split('\n').map((t) => ({ text: t.trim() })).filter((l, i, a) => l.text || (a[i - 1] && a[i - 1].text));
}

/* ---------- send ---------- */
function sendNetwork(address, buf) {
  const [host, port] = String(address || '').split(':');
  if (!host) return Promise.reject(new Error('No printer address set (use the IP, like 192.168.1.50:9100)'));
  return new Promise((ok, fail) => {
    const s = net.connect({ host, port: Number(port) || 9100 }, () => { s.end(buf); });
    s.setTimeout(8000, () => { s.destroy(); fail(new Error(`No answer from ${host}:${port || 9100}`)); });
    s.on('error', fail); s.on('close', (hadErr) => { if (!hadErr) ok(); });
  });
}
const sendDevice = (address, buf) => new Promise((ok, fail) => {
  if (!address) return fail(new Error('No device path set (like /dev/usb/lp0, /dev/rfcomm0 or \\\\.\\COM3)'));
  fs.writeFile(address, buf, (e) => (e ? fail(e) : ok()));
});
async function print(job) {
  const c = job.printer.connection; const buf = escpos(job);
  if (c === 'network') return sendNetwork(job.printer.address, buf);
  if (c === 'device' || c === 'usb' || c === 'bluetooth') return sendDevice(job.printer.address, buf);
  throw new Error('This printer is set to print from a browser. Open the print helper page in Chrome instead.');
}

/* ---------- loop ---------- */
async function call(path, opts = {}) {
  const r = await fetch(`${SERVER}${path}`, { ...opts, headers });
  if (r.status === 401) { const t = await r.json().catch(() => ({})); console.error(t.error || 'Not paired'); process.exit(2); }
  if (!r.ok) throw new Error(`Server said ${r.status}`);
  return r.json();
}
async function main() {
  const me = await call('/api/print/agent');
  log(`Connected to ${me.business} as "${me.agent.name}". Printers: ${me.printers.map((p) => `${p.name} (${p.connection}${p.address ? ` ${p.address}` : ''})`).join(', ') || 'none yet, add them in Devices'}`);
  await call('/api/print/agent/info', { method: 'POST', body: JSON.stringify({ version: VERSION, host: os.hostname().slice(0, 80), platform: `${os.platform()} ${os.arch()}` }) }).catch(() => {});
  for (;;) {
    let jobs = [];
    try { jobs = await call('/api/print/jobs?wait=1'); } catch (e) { log('Waiting for the server:', e.message); await new Promise((r) => setTimeout(r, 5000)); continue; }
    for (const j of jobs) {
      try { await print(j); log(`Printed ${j.title || j.kind} on ${j.printer.name}`); await call(`/api/print/jobs/${j.id}/result`, { method: 'POST', body: JSON.stringify({ ok: true }) }); }
      catch (e) { log(`Couldn't print on ${j.printer.name}:`, e.message); await call(`/api/print/jobs/${j.id}/result`, { method: 'POST', body: JSON.stringify({ ok: false, error: e.message.slice(0, 280) }) }).catch(() => {}); }
    }
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
