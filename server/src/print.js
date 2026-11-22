// Printers and print helpers. The server runs in the cloud, so it can't reach printers on the
// business network directly. A "print helper" (the browser page /print-agent, or tools/print-agent.mjs
// on any computer / Raspberry Pi) pairs with a token, pulls jobs and sends them to its printers:
// network ESC/POS printers (TCP 9100), USB printers (Web Serial in Chrome, or a device path), or
// the system print dialog.
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { db, getSettings, setSettings, audit, registerSchema, currentSlug, getJwtSecret, forEachLocation, runIn } from './db.js';
import { orderHooks } from './commerce.js';
import { receiptData, receiptToken } from './pro.js';
import { userFromToken, SESSION_COOKIE } from './security.js';
import { stationFor, stationList } from './kds.js';

registerSchema((db) => {
  db.exec(`CREATE TABLE IF NOT EXISTS print_agents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'browser', last_seen TEXT, info TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS printers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, agent_id INTEGER, connection TEXT NOT NULL DEFAULT 'network', address TEXT, width INTEGER NOT NULL DEFAULT 42,
      jobs TEXT NOT NULL DEFAULT '[]', area TEXT, copies INTEGER NOT NULL DEFAULT 1, cut INTEGER NOT NULL DEFAULT 1, drawer INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, last_ok TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS print_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, printer_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', tries INTEGER NOT NULL DEFAULT 0,
      error TEXT, by_label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, done_at TEXT);
    CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status, printer_id);`);
  const pc = db.prepare('PRAGMA table_info(printers)').all().map((c) => c.name);
  if (!pc.includes('backup_id')) db.exec('ALTER TABLE printers ADD COLUMN backup_id INTEGER');
});

/** Kinds of print a printer can take. */
export const JOB_KINDS = { ticket: 'Kitchen tickets', receipt: 'Receipts', allergy: 'Allergy slips', label: 'Prep and shelf labels', sticker: 'To-go bag stickers', checkout: 'Server and driver checkouts', report: 'Reports and full pages', test: 'Test prints' };
const CONNECTIONS = ['network', 'usb', 'bluetooth', 'browser', 'device'];
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const pj = (v, d) => { try { return JSON.parse(v) ?? d; } catch { return d; } };
const secret = () => `${getJwtSecret()}:print`;
const bus = new EventEmitter(); bus.setMaxListeners(200);
const fmt = (c) => `$${(c / 100).toFixed(2)}`;

/* ---------- plain lines for receipt-style printers ---------- */
const lineSchema = z.object({ qr: z.string().max(300).optional(), text: z.string().max(200).default(''), bold: z.boolean().optional(), big: z.boolean().optional(), center: z.boolean().optional(), right: z.string().max(40).optional(), invert: z.boolean().optional() });
const jobSchema = z.object({ kind: z.enum(Object.keys(JOB_KINDS)), title: z.string().max(80).optional(), area: z.string().max(40).optional(), printerId: z.number().int().optional(),
  lines: z.array(lineSchema).max(400).optional(), html: z.string().max(400000).optional(), drawer: z.boolean().optional() });

export function registerPrint({ app, staff, io, h }) {
  const { parse, clientIp, requireAuth, notifyStaff } = h;
  const mgr = requireAuth('manager');

  /** Printers that take this kind of job (tickets also by area). */
  const route = (kind, area) => db.prepare('SELECT * FROM printers WHERE active = 1').all()
    .filter((p) => pj(p.jobs, []).includes(kind) && (kind !== 'ticket' || !p.area || !area || p.area === area || p.area === 'All areas'));
  /** Queue a job; returns how many printers took it (0 = nothing routed, print in the browser instead). */
  const enqueue = (job, by) => {
    const targets = job.printerId ? db.prepare('SELECT * FROM printers WHERE id = ? AND active = 1').all(job.printerId) : route(job.kind, job.area);
    const online = (p) => { const a = p.agent_id ? db.prepare('SELECT last_seen FROM print_agents WHERE id = ? AND active = 1').get(p.agent_id) : null; return Boolean(a?.last_seen && Date.now() - Date.parse(`${a.last_seen.replace(' ', 'T')}Z`) < 120_000); };
    const used = new Set();
    for (let p of targets) {
      if (!job.printerId && !online(p) && p.backup_id) { const b = db.prepare('SELECT * FROM printers WHERE id = ? AND active = 1').get(p.backup_id); if (b && online(b)) { p = { ...b }; job = { ...job, title: `${job.title || JOB_KINDS[job.kind]} (backup for ${targets.find((x) => x.backup_id === b.id)?.name || 'another printer'})` }; } }
      if (used.has(p.id)) continue; used.add(p.id);
      for (let c = 0; c < Math.max(1, Math.min(5, p.copies || 1)); c++) {
        db.prepare('INSERT INTO print_jobs (printer_id, kind, title, payload, by_label) VALUES (?, ?, ?, ?, ?)').run(p.id, job.kind, job.title || JOB_KINDS[job.kind], JSON.stringify({ lines: job.lines || null, html: job.html || null, drawer: Boolean(job.drawer && p.drawer) }), by || null);
      }
      bus.emit(`${currentSlug()}:${p.agent_id}`);
    }
    return targets.length;
  };
  h.printJob = enqueue;
  h.printRoutes = (kind, area) => route(kind, area).length;

  /* ----- staff / screens send a print ----- */
  const sender = (req) => {
    const t = req.get('X-Kds');
    if (t) { try { const p = jwt.verify(t, `${getJwtSecret()}:kds`); if (p.loc === currentSlug()) return `${p.area} screen`; } catch { /* bad */ } throw err('This screen is signed out.', 401); }
    let user = null; try { user = req.cookies?.[SESSION_COOKIE] ? userFromToken(req.cookies[SESSION_COOKIE]) : null; } catch { user = null; }
    if (!user) throw err('Sign in first', 401);
    return user.name;
  };
  app.post('/api/print', (req, res) => {
    const by = sender(req); const b = parse(jobSchema, req.body);
    if (!b.lines?.length && !b.html) throw err('Nothing to print');
    res.json({ queued: enqueue(b, by) });
  });
  app.get('/api/print/routes', (req, res) => { sender(req); const out = {}; for (const k of Object.keys(JOB_KINDS)) out[k] = route(k).map((p) => ({ id: p.id, name: p.name, area: p.area })); res.json(out); });

  /* ----- printers (managers) ----- */
  const printerBody = z.object({ name: z.string().trim().min(1).max(40), agentId: z.number().int().nullable().optional(), connection: z.enum(CONNECTIONS), address: z.string().trim().max(120).optional().nullable(),
    width: z.number().int().refine((w) => [32, 42, 48, 64].includes(w)).default(42), jobs: z.array(z.enum(Object.keys(JOB_KINDS))).max(10), area: z.string().max(40).optional().nullable(),
    copies: z.number().int().min(1).max(5).default(1), cut: z.boolean().default(true), drawer: z.boolean().default(false), active: z.boolean().default(true), backupId: z.number().int().nullable().optional() });
  const out = (p) => {
    const a = p.agent_id ? db.prepare('SELECT id, name, last_seen FROM print_agents WHERE id = ?').get(p.agent_id) : null;
    const q = db.prepare("SELECT COUNT(*) n FROM print_jobs WHERE printer_id = ? AND status IN ('queued','sent')").get(p.id).n;
    return { id: p.id, name: p.name, agentId: p.agent_id, agent: a?.name || null, agentOnline: Boolean(a?.last_seen && Date.now() - Date.parse(`${a.last_seen.replace(' ', 'T')}Z`) < 90_000), connection: p.connection, address: p.address, width: p.width, jobs: pj(p.jobs, []), area: p.area, copies: p.copies, cut: Boolean(p.cut), drawer: Boolean(p.drawer), active: Boolean(p.active), backupId: p.backup_id || null, lastOk: p.last_ok, lastError: p.last_error, waiting: q };
  };
  staff.get('/printers', (req, res) => res.json({ kinds: JOB_KINDS, areas: ['All areas', ...stationList(), 'Expo', 'Packing', 'Runner'], printers: db.prepare('SELECT * FROM printers ORDER BY name').all().map(out),
    agents: db.prepare('SELECT id, name, kind, last_seen, info, active FROM print_agents WHERE active = 1 ORDER BY name').all().map((a) => ({ ...a, info: pj(a.info, {}), online: Boolean(a.last_seen && Date.now() - Date.parse(`${a.last_seen.replace(' ', 'T')}Z`) < 90_000) })) }));
  staff.post('/printers', mgr, (req, res) => {
    const b = parse(printerBody, req.body);
    const id = db.prepare('INSERT INTO printers (name, agent_id, connection, address, width, jobs, area, copies, cut, drawer, active) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(b.name, b.agentId || null, b.connection, b.address || null, b.width, JSON.stringify(b.jobs), b.area || null, b.copies, b.cut ? 1 : 0, b.drawer ? 1 : 0, b.active ? 1 : 0).lastInsertRowid;
    db.prepare('UPDATE printers SET backup_id = ? WHERE id = ?').run(b.backupId || null, id);
    audit(req.user, 'printer.add', b.name, clientIp(req)); res.json(out(db.prepare('SELECT * FROM printers WHERE id = ?').get(id)));
  });
  staff.put('/printers/:id', mgr, (req, res) => {
    const b = parse(printerBody, req.body); const id = Number(req.params.id);
    db.prepare('UPDATE printers SET name=?, agent_id=?, connection=?, address=?, width=?, jobs=?, area=?, copies=?, cut=?, drawer=?, active=? WHERE id=?')
      .run(b.name, b.agentId || null, b.connection, b.address || null, b.width, JSON.stringify(b.jobs), b.area || null, b.copies, b.cut ? 1 : 0, b.drawer ? 1 : 0, b.active ? 1 : 0, id);
    db.prepare('UPDATE printers SET backup_id = ? WHERE id = ?').run(b.backupId && b.backupId !== id ? b.backupId : null, id);
    audit(req.user, 'printer.edit', b.name, clientIp(req)); bus.emit(`${currentSlug()}:${b.agentId}`); res.json({ ok: true });
  });
  staff.delete('/printers/:id', mgr, (req, res) => { db.prepare("UPDATE print_jobs SET status = 'cancelled' WHERE printer_id = ? AND status IN ('queued','sent')").run(Number(req.params.id)); db.prepare('DELETE FROM printers WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });
  staff.post('/printers/:id/test', (req, res) => {
    const p = db.prepare('SELECT * FROM printers WHERE id = ?').get(Number(req.params.id)); if (!p) throw err('Not found', 404);
    const s = getSettings();
    enqueue({ kind: 'test', printerId: p.id, title: 'Test print', lines: [{ text: s.business_name, big: true, center: true }, { text: `Printer: ${p.name}`, center: true }, { text: `Takes: ${pj(p.jobs, []).map((k) => JOB_KINDS[k]).join(', ') || 'nothing yet'}` }, { text: `Width ${p.width} characters` }, { text: '-'.repeat(p.width) }, { text: 'If you can read this, it works.', bold: true, center: true }] }, req.user.name);
    res.json({ ok: true });
  });
  staff.get('/print-jobs', (req, res) => res.json(db.prepare('SELECT j.id, j.kind, j.title, j.status, j.error, j.tries, j.by_label, j.created_at, j.done_at, p.name printer FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id ORDER BY j.id DESC LIMIT 60').all()));
  staff.post('/print-jobs/:id/retry', (req, res) => { db.prepare("UPDATE print_jobs SET status = 'queued', error = NULL WHERE id = ?").run(Number(req.params.id)); const j = db.prepare('SELECT p.agent_id FROM print_jobs j JOIN printers p ON p.id = j.printer_id WHERE j.id = ?').get(Number(req.params.id)); bus.emit(`${currentSlug()}:${j?.agent_id}`); res.json({ ok: true }); });

  /* ----- print helpers (pairing) ----- */
  staff.post('/print-agents', mgr, (req, res) => {
    const { name, kind } = parse(z.object({ name: z.string().trim().min(1).max(40), kind: z.enum(['browser', 'node']).default('browser') }), req.body);
    const id = db.prepare('INSERT INTO print_agents (name, kind) VALUES (?, ?)').run(name, kind).lastInsertRowid;
    const token = jwt.sign({ kind: 'print', agent: id, loc: currentSlug(), v: getSettings().print_version || '1' }, secret(), { expiresIn: '3650d' });
    audit(req.user, 'print.agent_pair', name, clientIp(req)); res.json({ id, token, loc: currentSlug() });
  });
  staff.delete('/print-agents/:id', mgr, (req, res) => { db.prepare('UPDATE print_agents SET active = 0 WHERE id = ?').run(Number(req.params.id)); db.prepare('UPDATE printers SET agent_id = NULL WHERE agent_id = ?').run(Number(req.params.id)); audit(req.user, 'print.agent_remove', req.params.id, clientIp(req)); res.json({ ok: true }); });
  staff.post('/print-agents/signout-all', mgr, (req, res) => { setSettings({ print_version: String(Number(getSettings().print_version || '1') + 1) }); res.json({ ok: true }); });
  staff.get('/print-agent.mjs', mgr, (req, res) => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'print-agent.mjs');
    res.set('Content-Type', 'text/javascript').set('Content-Disposition', 'attachment; filename="buzzhub-print-agent.mjs"').send(fs.readFileSync(file));
  });

  /* ----- the helper's side ----- */
  const agentAuth = (req) => {
    const t = req.get('X-Print') || ''; let p;
    try { p = jwt.verify(t, secret()); } catch { throw err('This print helper is not paired. Pair it again from Devices.', 401); }
    if (p.loc !== currentSlug() || String(p.v) !== String(getSettings().print_version || '1')) throw err('This print helper was signed out. Pair it again from Devices.', 401);
    const a = db.prepare('SELECT * FROM print_agents WHERE id = ? AND active = 1').get(p.agent); if (!a) throw err('This print helper was removed.', 401);
    db.prepare("UPDATE print_agents SET last_seen = datetime('now') WHERE id = ?").run(a.id);
    return a;
  };
  app.get('/api/print/agent', (req, res) => {
    const a = agentAuth(req); const s = getSettings();
    res.json({ agent: { id: a.id, name: a.name, kind: a.kind }, business: s.business_name, printers: db.prepare('SELECT * FROM printers WHERE agent_id = ? AND active = 1').all(a.id).map(out) });
  });
  app.post('/api/print/agent/info', (req, res) => { const a = agentAuth(req); const b = parse(z.object({ version: z.string().max(20).optional(), host: z.string().max(80).optional(), platform: z.string().max(40).optional() }), req.body || {}); db.prepare('UPDATE print_agents SET info = ? WHERE id = ?').run(JSON.stringify(b), a.id); res.json({ ok: true }); });
  const claim = (a) => {
    db.prepare("UPDATE print_jobs SET status = 'queued' WHERE status = 'sent' AND sent_at < datetime('now','-2 minutes') AND tries < 3").run();
    const jobs = db.prepare("SELECT j.*, p.connection, p.address, p.width, p.cut, p.name printer_name FROM print_jobs j JOIN printers p ON p.id = j.printer_id WHERE j.status = 'queued' AND p.agent_id = ? AND p.active = 1 ORDER BY j.id LIMIT 20").all(a.id);
    for (const j of jobs) db.prepare("UPDATE print_jobs SET status = 'sent', sent_at = datetime('now'), tries = tries + 1 WHERE id = ?").run(j.id);
    return jobs.map((j) => ({ id: j.id, kind: j.kind, title: j.title, printer: { id: j.printer_id, name: j.printer_name, connection: j.connection, address: j.address, width: j.width, cut: Boolean(j.cut) }, ...pj(j.payload, {}) }));
  };
  app.get('/api/print/jobs', (req, res) => {
    const a = agentAuth(req); const now = claim(a);
    if (now.length || req.query.wait !== '1') return res.json(now);
    const key = `${currentSlug()}:${a.id}`; const slug = currentSlug();
    const t = setTimeout(() => { bus.off(key, on); res.json([]); }, 25_000);
    function on() { clearTimeout(t); bus.off(key, on); try { res.json(runIn(slug, () => claim(a))); } catch { res.json([]); } }
    bus.on(key, on); req.on('close', () => { clearTimeout(t); bus.off(key, on); });
  });
  app.post('/api/print/jobs/:id/result', (req, res) => {
    const a = agentAuth(req); const b = parse(z.object({ ok: z.boolean(), error: z.string().max(300).optional() }), req.body);
    const j = db.prepare('SELECT j.*, p.name pname FROM print_jobs j JOIN printers p ON p.id = j.printer_id WHERE j.id = ? AND p.agent_id = ?').get(Number(req.params.id), a.id); if (!j) throw err('Not found', 404);
    if (b.ok) { db.prepare("UPDATE print_jobs SET status = 'done', done_at = datetime('now'), error = NULL WHERE id = ?").run(j.id); db.prepare("UPDATE printers SET last_ok = datetime('now'), last_error = NULL WHERE id = ?").run(j.printer_id); }
    else {
      db.prepare("UPDATE print_jobs SET status = ?, error = ? WHERE id = ?").run(j.tries >= 3 ? 'failed' : 'queued', b.error || 'Failed', j.id);
      db.prepare('UPDATE printers SET last_error = ? WHERE id = ?').run(b.error || 'Failed', j.printer_id);
      if (j.tries >= 3) { const pr = db.prepare('SELECT backup_id FROM printers WHERE id = ?').get(j.printer_id); const bk = pr?.backup_id ? db.prepare('SELECT * FROM printers WHERE id = ? AND active = 1').get(pr.backup_id) : null; if (bk) { db.prepare('INSERT INTO print_jobs (printer_id, kind, title, payload, by_label) VALUES (?, ?, ?, ?, ?)').run(bk.id, j.kind, `${j.title || j.kind} (backup)`, j.payload, 'Backup'); bus.emit(`${currentSlug()}:${bk.agent_id}`); } io.to('staff').emit('security', { type: 'printer', detail: `Printer "${j.pname}" couldn't print ${j.title || j.kind}: ${b.error || 'failed'}` }); notifyStaff('printers'); }
      else bus.emit(`${currentSlug()}:${a.id}`);
    }
    res.json({ ok: true });
  });

  /* ----- kitchen tickets printed by the server when an order goes in ----- */
  h.ticketLines = (orderId, area, reprint, course) => {
    const o = db.prepare('SELECT o.*, t.label table_label FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.id = ?').get(orderId); if (!o) return null;
    const list = stationList(); const map = pj(getSettings().station_map, {});
    const items = db.prepare('SELECT oi.*, m.category, m.station FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id = ? ORDER BY oi.seat, oi.id').all(o.id)
      .filter((i) => (course ? (i.course || 1) === course : (i.course || 1) <= 1 || i.fired_at)).filter((i) => !area || area === 'All areas' || stationFor(i, list, map) === area);
    if (!items.length) return null;
    const unit = getSettings().unit_label;
    const lines = [{ text: `#${o.number}${o.priority === 2 ? '  VIP' : o.priority === 1 ? '  RUSH' : ''}`, big: true, invert: Boolean(o.priority) },
      { text: o.table_label ? `${unit} ${o.table_label}` : o.fulfillment === 'delivery' ? 'Delivery' : o.customer_name || 'To go', bold: true }, { text: `${area || 'Kitchen'}${course ? ` · course ${course}` : ''}${reprint ? ' (reprint)' : ''}`, right: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: getSettings().timezone || 'America/New_York' }) }];
    if (o.allergy_note) lines.push({ text: `ALLERGY: ${o.allergy_note}`, bold: true, invert: true });
    lines.push({ text: '' });
    let seat = null;
    for (const i of items) {
      if (i.seat && i.seat !== seat) { seat = i.seat; lines.push({ text: `Seat ${i.seat}${i.seat_name ? ` ${i.seat_name}` : ''}`, bold: true }); }
      lines.push({ text: `${i.qty} x ${i.name}`, big: true });
      for (const m of pj(i.mods || '[]', [])) lines.push({ text: `   ${m.name || m}` });
      if (i.note) lines.push({ text: `   ** ${i.note}`, bold: true });
    }
    if (o.order_notes) lines.push({ text: '' }, { text: o.order_notes });
    return lines;
  };
  h.printTickets = (orderId, reprint, course) => {
    if (getSettings().print_tickets_auto === '0') return 0;
    const areas = new Set(db.prepare('SELECT * FROM printers WHERE active = 1').all().filter((p) => pj(p.jobs, []).includes('ticket')).map((p) => p.area || 'All areas'));
    let n = 0;
    for (const a of areas) { const lines = h.ticketLines(orderId, a, reprint, course); if (lines) n += enqueue({ kind: 'ticket', area: a, title: `Ticket ${a}`, lines }, 'Auto'); }
    return n;
  };
  orderHooks.inserted.push((id) => { try { const o = db.prepare('SELECT status FROM orders WHERE id = ?').get(id); if (o?.status === 'sent') setImmediate(() => { try { h.printTickets(id); } catch (e) { console.error('auto print', e.message); } }); } catch { /* ignore */ } });
  staff.post('/orders/:id/print-tickets', (req, res) => res.json({ queued: h.printTickets(Number(req.params.id), true) }));

  /* ----- receipts ----- */
  h.receiptLines = (r, width = 42) => {
    const lines = [{ text: r.business.name, big: true, center: true }, { text: `Order #${r.number}${r.name ? `, ${r.name}` : ''}`, center: true }, { text: new Date(`${String(r.at).replace(' ', 'T')}Z`).toLocaleString('en-US', { timeZone: getSettings().timezone || 'America/New_York' }), center: true }, { text: '-'.repeat(width) }];
    for (const i of r.items) { lines.push({ text: `${i.qty} x ${i.name}`, right: fmt(i.cents) }); for (const m of i.mods || []) lines.push({ text: `   ${m}` }); }
    lines.push({ text: '-'.repeat(width) }, { text: 'Subtotal', right: fmt(r.subtotalCents) });
    if (r.discountCents) lines.push({ text: 'Discount', right: `-${fmt(r.discountCents)}` });
    lines.push({ text: 'Tax', right: fmt(r.taxCents) });
    if (r.feeCents) lines.push({ text: 'Delivery', right: fmt(r.feeCents) });
    if (r.tipCents) lines.push({ text: 'Tip', right: fmt(r.tipCents) });
    lines.push({ text: 'Total', right: fmt(r.totalCents), bold: true, big: true }, { text: r.paid ? `Paid${r.method ? ` by ${r.method}` : ''}` : 'Not paid yet', center: true }, { text: '' }, { text: 'Thank you!', center: true });
    if (r.qrUrl) lines.push({ text: '' }, { qr: r.qrUrl, text: '' }, { text: 'Scan to rate your visit and join our rewards', center: true });
    return lines;
  };
  staff.post('/orders/:id/print-receipt', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id)); if (!o) throw err('Not found', 404);
    const r = receiptData(o);
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    if (getSettings().receipt_qr !== '0') r.qrUrl = `${base}/r/${receiptToken(o.id)}${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}`;
    res.json({ queued: enqueue({ kind: 'receipt', title: `Receipt #${o.number}`, lines: h.receiptLines(r), drawer: o.payment_method === 'cash' }, req.user.name) });
  });

  // keep the queue small
  setInterval(() => forEachLocation(() => { try { db.prepare("DELETE FROM print_jobs WHERE created_at < datetime('now','-3 days')").run(); db.prepare("UPDATE print_jobs SET status = 'failed', error = COALESCE(error, 'No print helper picked it up') WHERE status = 'queued' AND created_at < datetime('now','-30 minutes')").run(); } catch { /* table gone */ } }), 600_000).unref();
}
