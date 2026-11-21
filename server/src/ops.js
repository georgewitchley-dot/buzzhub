// Batch 1: kitchen display, end-of-day report + cash drawer, shifts & labor.
import { z } from 'zod';
import { db, getSettings, audit, currentTz, localToday } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS cash_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_by INTEGER, opened_at TEXT NOT NULL DEFAULT (datetime('now')), opening_cents INTEGER NOT NULL,
  closed_by INTEGER, closed_at TEXT, counted_cents INTEGER, expected_cents INTEGER, notes TEXT
);
CREATE TABLE IF NOT EXISTS cash_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('in','out')),
  amount_cents INTEGER NOT NULL, reason TEXT, user_id INTEGER, at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, clock_in TEXT NOT NULL DEFAULT (datetime('now')), clock_out TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0, edited_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shifts_user ON shifts(user_id, clock_in);
CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, start_local TEXT NOT NULL, end_local TEXT NOT NULL, role_note TEXT
);
`);
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'hourly_cents')) db.exec('ALTER TABLE users ADD COLUMN hourly_cents INTEGER NOT NULL DEFAULT 0');

/* ---------- time helpers (business timezone) ---------- */
function tzOffsetMin(tz, at = new Date()) {
  const f = (zone) => Date.parse(at.toLocaleString('en-US', { timeZone: zone, hour12: false }).replace(/(\d+)\/(\d+)\/(\d+), (\d+):(\d+):(\d+)/, '$3-$1-$2T$4:$5:$6Z').replace('T24:', 'T00:'));
  return (f(tz) - f('UTC')) / 60000;
}
/** UTC 'YYYY-MM-DD HH:MM:SS' bounds of a local business day. */
export function dayBounds(date, tz = currentTz()) {
  const mid = new Date(`${date}T12:00:00Z`);
  const off = tzOffsetMin(tz, mid);
  const start = new Date(Date.parse(`${date}T00:00:00Z`) - off * 60000);
  const end = new Date(start.getTime() + 86400000);
  const s = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
  return { start: s(start), end: s(end) };
}
const hoursBetween = (a, b) => Math.max(0, (Date.parse(`${(b || new Date().toISOString().slice(0, 19)).replace(' ', 'T')}Z`) - Date.parse(`${a.replace(' ', 'T')}Z`)) / 3600000);
const localHour = (ts) => Number(new Intl.DateTimeFormat('en-US', { timeZone: currentTz(), hour: 'numeric', hourCycle: 'h23' }).format(new Date(`${ts.replace(' ', 'T')}Z`)));

export function registerOps({ app, staff, io, h }) {
  const { wrap, parse, idParam, now, notifyStaff, clientIp, requireAuth, authLimiter, findUserByPin, loginBlocked, recordLoginFail, clearLoginFails } = h;

  /* ================= Kitchen display ================= */
  staff.get('/kitchen', (req, res) => {
    const orders = db.prepare(`SELECT o.id, o.number, o.status, o.source, o.customer_name, o.sent_at, o.ready_at, o.created_at, t.label table_label, g.name guest_name
      FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN guests g ON g.id = o.guest_id
      WHERE o.status IN ('open','sent') OR (o.status IN ('ready','paid') AND o.ready_at > datetime('now','-10 minutes'))
      ORDER BY CASE WHEN o.status IN ('open','sent') THEN 0 ELSE 1 END, COALESCE(o.sent_at, o.created_at)`).all();
    const items = orders.length ? db.prepare(`SELECT order_id, name, qty, note FROM order_items WHERE order_id IN (${orders.map((o) => o.id).join(',')})`).all() : [];
    const held = db.prepare("SELECT COUNT(*) c FROM orders WHERE status = 'held'").get().c;
    res.json({ orders: orders.map((o) => ({ ...o, items: items.filter((i) => i.order_id === o.id) })), held, lateMinutes: Number(getSettings().kds_late_minutes || 12) });
  });
  staff.post('/kitchen/:id/recall', (req, res) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(idParam(req));
    if (!o || o.status !== 'ready') return res.status(409).json({ error: 'Only ready orders can be recalled' });
    db.prepare("UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?").run(o.id);
    audit(req.user, 'order.recall', `#${o.number}`, clientIp(req));
    notifyStaff('orders'); res.json({ ok: true });
  });

  /* ================= End-of-day report ================= */
  function dayReport(date) {
    const { start, end } = dayBounds(date);
    const paid = db.prepare("SELECT * FROM orders WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?").all(start, end);
    const voids = db.prepare("SELECT * FROM orders WHERE status = 'void' AND created_at >= ? AND created_at < ?").all(start, end);
    const sum = (arr, k) => arr.reduce((a, o) => a + (o[k] || 0), 0);
    const byMethod = {};
    for (const o of paid) { const m = o.payment_method || 'other'; byMethod[m] = byMethod[m] || { count: 0, cents: 0, tips: 0 }; byMethod[m].count++; byMethod[m].cents += o.total_cents; byMethod[m].tips += o.tip_cents; }
    const hourly = Array.from({ length: 24 }, () => 0);
    for (const o of paid) hourly[localHour(o.paid_at)] += o.total_cents;
    const ids = paid.map((o) => o.id).join(',') || '0';
    const items = db.prepare(`SELECT name, SUM(qty) qty, SUM(qty * price_cents) cents FROM order_items WHERE order_id IN (${ids}) GROUP BY name ORDER BY cents DESC`).all();
    const byStaff = db.prepare(`SELECT COALESCE(u.name, 'Guest order') name, COUNT(*) orders, SUM(o.total_cents) cents, SUM(o.tip_cents) tips FROM orders o LEFT JOIN users u ON u.id = o.created_by WHERE o.id IN (${ids}) GROUP BY o.created_by ORDER BY cents DESC`).all();
    const guests = db.prepare("SELECT status, COUNT(*) c, SUM(party_size) covers FROM guests WHERE created_at >= ? AND created_at < ? GROUP BY status").all(start, end);
    const avgWait = db.prepare('SELECT AVG((julianday(seated_at) - julianday(created_at)) * 1440) m FROM guests WHERE seated_at IS NOT NULL AND created_at >= ? AND created_at < ?').get(start, end).m;
    const bookings = db.prepare("SELECT status, COUNT(*) c FROM bookings WHERE substr(start_local,1,10) = ? GROUP BY status").all(date);
    const shifts = db.prepare('SELECT s.*, u.name, u.hourly_cents FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in < ? AND (s.clock_out IS NULL OR s.clock_out >= ?)').all(end, start);
    const labor = shifts.map((s) => { const hrs = Math.max(0, hoursBetween(s.clock_in < start ? start : s.clock_in, s.clock_out && s.clock_out < end ? s.clock_out : (s.clock_out ? end : null)) - s.break_minutes / 60); return { name: s.name, hours: hrs, cents: Math.round(hrs * s.hourly_cents) }; });
    const cash = db.prepare('SELECT * FROM cash_sessions WHERE opened_at >= ? AND opened_at < ? ORDER BY id').all(start, end);
    const gross = sum(paid, 'subtotal_cents');
    const laborCents = labor.reduce((a, l) => a + l.cents, 0);
    return {
      date, generatedAt: now(),
      totals: { orders: paid.length, grossCents: gross, discountCents: sum(paid, 'discount_cents'), taxCents: sum(paid, 'tax_cents'), tipsCents: sum(paid, 'tip_cents'),
        netCents: gross - sum(paid, 'discount_cents'), collectedCents: sum(paid, 'total_cents'), avgTicketCents: paid.length ? Math.round(sum(paid, 'total_cents') / paid.length) : 0,
        voids: voids.length, voidCents: sum(voids, 'total_cents'), laborCents, laborPct: gross ? Math.round((laborCents / gross) * 1000) / 10 : 0 },
      byMethod, hourly, items, byStaff, labor,
      guests: Object.fromEntries(guests.map((g) => [g.status, { count: g.c, covers: g.covers }])), avgWait: avgWait ? Math.round(avgWait) : 0,
      bookings: Object.fromEntries(bookings.map((b) => [b.status, b.c])), cash: cash.map(cashSummary),
    };
  }

  staff.get('/reports/day', requireAuth('manager'), (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : localToday();
    res.json(dayReport(date));
  });
  staff.get('/reports/day.csv', requireAuth('manager'), (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : localToday();
    const r = dayReport(date);
    const { start, end } = dayBounds(date);
    const rows = db.prepare(`SELECT o.number, o.paid_at, o.status, o.payment_method, o.subtotal_cents, o.discount_cents, o.tax_cents, o.tip_cents, o.total_cents, COALESCE(u.name,'Guest') staff, t.label table_label
      FROM orders o LEFT JOIN users u ON u.id=o.created_by LEFT JOIN tables t ON t.id=o.table_id WHERE (o.paid_at >= ? AND o.paid_at < ?) OR (o.status='void' AND o.created_at >= ? AND o.created_at < ?) ORDER BY o.id`).all(start, end, start, end);
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
    const d = (c) => (c / 100).toFixed(2);
    const lines = [['Order', 'Paid at (UTC)', 'Status', 'Method', 'Subtotal', 'Discount', 'Tax', 'Tip', 'Total', 'Staff', 'Table'].join(',')];
    for (const o of rows) lines.push([o.number, o.paid_at, o.status, o.payment_method, d(o.subtotal_cents), d(o.discount_cents), d(o.tax_cents), d(o.tip_cents), d(o.total_cents), o.staff, o.table_label].map(esc).join(','));
    lines.push('', ['Summary', 'Gross', 'Discounts', 'Tax', 'Tips', 'Collected', 'Voids', 'Labor', 'Labor %'].join(','));
    lines.push(['', d(r.totals.grossCents), d(r.totals.discountCents), d(r.totals.taxCents), d(r.totals.tipsCents), d(r.totals.collectedCents), d(r.totals.voidCents), d(r.totals.laborCents), r.totals.laborPct].join(','));
    audit(req.user, 'report.export', date, clientIp(req));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="buzzhub-${date}.csv"` });
    res.send(lines.join('\n'));
  });

  /* ================= Cash drawer ================= */
  function cashSummary(cs) {
    const cashSales = db.prepare("SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE status='paid' AND payment_method='cash' AND paid_at >= ? AND paid_at < COALESCE(?, datetime('now','+1 second'))").get(cs.opened_at, cs.closed_at).c;
    const moves = db.prepare('SELECT m.*, u.name user_name FROM cash_moves m LEFT JOIN users u ON u.id = m.user_id WHERE session_id = ? ORDER BY id').all(cs.id);
    const ins = moves.filter((m) => m.kind === 'in').reduce((a, m) => a + m.amount_cents, 0);
    const outs = moves.filter((m) => m.kind === 'out').reduce((a, m) => a + m.amount_cents, 0);
    const expected = cs.opening_cents + cashSales + ins - outs;
    const names = db.prepare('SELECT id, name FROM users WHERE id IN (?, ?)').all(cs.opened_by || 0, cs.closed_by || 0);
    const nm = (id) => names.find((n) => n.id === id)?.name || null;
    return { ...cs, openedByName: nm(cs.opened_by), closedByName: nm(cs.closed_by), cashSalesCents: cashSales, paidInCents: ins, paidOutCents: outs, moves,
      expectedCents: cs.closed_at ? cs.expected_cents : expected, varianceCents: cs.closed_at ? cs.counted_cents - cs.expected_cents : null };
  }
  const openSession = () => db.prepare('SELECT * FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1').get();

  staff.get('/cash', (req, res) => {
    const cur = openSession();
    const recent = db.prepare('SELECT * FROM cash_sessions WHERE closed_at IS NOT NULL ORDER BY id DESC LIMIT 10').all();
    res.json({ current: cur ? cashSummary(cur) : null, recent: recent.map(cashSummary) });
  });
  staff.post('/cash/open', (req, res) => {
    if (openSession()) return res.status(409).json({ error: 'The drawer is already open' });
    const { openingCents } = parse(z.object({ openingCents: z.number().int().min(0).max(10_000_000) }), req.body);
    db.prepare('INSERT INTO cash_sessions (opened_by, opening_cents) VALUES (?, ?)').run(req.user.id, openingCents);
    audit(req.user, 'cash.open', `float ${(openingCents / 100).toFixed(2)}`, clientIp(req));
    notifyStaff('cash'); res.json({ ok: true });
  });
  staff.post('/cash/move', (req, res) => {
    const cs = openSession(); if (!cs) return res.status(409).json({ error: 'Open the drawer first' });
    const b = parse(z.object({ kind: z.enum(['in', 'out']), amountCents: z.number().int().min(1).max(10_000_000), reason: z.string().trim().min(1).max(80) }), req.body);
    db.prepare('INSERT INTO cash_moves (session_id, kind, amount_cents, reason, user_id) VALUES (?, ?, ?, ?, ?)').run(cs.id, b.kind, b.amountCents, b.reason, req.user.id);
    audit(req.user, `cash.paid_${b.kind}`, `${(b.amountCents / 100).toFixed(2)} ${b.reason}`, clientIp(req));
    notifyStaff('cash'); res.json({ ok: true });
  });
  staff.post('/cash/close', requireAuth('manager'), (req, res) => {
    const cs = openSession(); if (!cs) return res.status(409).json({ error: 'The drawer is not open' });
    const b = parse(z.object({ countedCents: z.number().int().min(0).max(10_000_000), notes: z.string().trim().max(200).optional() }), req.body);
    const expected = cashSummary(cs).expectedCents;
    db.prepare('UPDATE cash_sessions SET closed_by=?, closed_at=?, counted_cents=?, expected_cents=?, notes=? WHERE id=?').run(req.user.id, now(), b.countedCents, expected, b.notes || null, cs.id);
    const variance = b.countedCents - expected;
    audit(req.user, 'cash.close', `counted ${(b.countedCents / 100).toFixed(2)}, expected ${(expected / 100).toFixed(2)}, ${variance === 0 ? 'balanced' : `${variance > 0 ? 'over' : 'short'} ${(Math.abs(variance) / 100).toFixed(2)}`}`, clientIp(req));
    if (Math.abs(variance) >= 500) io.to('owners').emit('security', { type: 'cash_variance', detail: `Drawer ${variance > 0 ? 'over' : 'short'} by $${(Math.abs(variance) / 100).toFixed(2)}`, at: Date.now() });
    notifyStaff('cash'); res.json({ ok: true, expectedCents: expected, varianceCents: variance });
  });

  /* ================= Shifts: clock in/out with PIN, schedule, labor ================= */
  const openShift = (uid) => db.prepare('SELECT * FROM shifts WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(uid);

  // From the lock screen: the PIN identifies the person, no session is created.
  app.post('/api/auth/clock', authLimiter, wrap(async (req, res) => {
    const ip = clientIp(req);
    const wait = loginBlocked(ip);
    if (wait) return res.status(429).json({ error: `Terminal locked. Try again in ${wait}s.` });
    const { pin } = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/, 'Enter your PIN') }), req.body);
    const user = await findUserByPin(pin);
    if (!user) { const r = recordLoginFail(ip); audit(null, 'auth.fail', 'bad PIN at time clock', ip); return res.status(401).json({ error: r.lockedFor ? `Too many wrong PINs. Locked for ${r.lockedFor}s.` : 'Wrong PIN' }); }
    clearLoginFails(ip);
    const cur = openShift(user.id);
    if (cur) {
      db.prepare('UPDATE shifts SET clock_out = ? WHERE id = ?').run(now(), cur.id);
      const hrs = hoursBetween(cur.clock_in, now()) - cur.break_minutes / 60;
      audit(user, 'shift.out', `${hrs.toFixed(2)} h`, ip);
      notifyStaff('shifts');
      return res.json({ name: user.name, action: 'out', hours: Math.round(hrs * 100) / 100 });
    }
    db.prepare('INSERT INTO shifts (user_id, clock_in) VALUES (?, ?)').run(user.id, now());
    audit(user, 'shift.in', null, ip);
    notifyStaff('shifts');
    res.json({ name: user.name, action: 'in' });
  }));

  staff.get('/shifts', (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : localToday();
    const start = dayBounds(date).start;
    const end = dayBounds(new Date(Date.parse(`${date}T12:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10)).end;
    const isMgr = ['manager', 'owner'].includes(req.user.role);
    const onNow = db.prepare('SELECT s.id, s.clock_in, u.id user_id, u.name, u.role FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_out IS NULL ORDER BY s.clock_in').all();
    const shifts = db.prepare(`SELECT s.*, u.name, u.hourly_cents FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in >= ? AND s.clock_in < ? ${isMgr ? '' : 'AND s.user_id = ?'} ORDER BY s.clock_in DESC`).all(...[start, end, ...(isMgr ? [] : [req.user.id])])
      .map((s) => { const hours = Math.max(0, hoursBetween(s.clock_in, s.clock_out) - s.break_minutes / 60); return { ...s, hours: Math.round(hours * 100) / 100, cost_cents: isMgr ? Math.round(hours * s.hourly_cents) : undefined, hourly_cents: isMgr ? s.hourly_cents : undefined }; });
    const sched = db.prepare('SELECT sc.*, u.name FROM schedule sc JOIN users u ON u.id = sc.user_id WHERE substr(sc.start_local,1,10) >= ? AND substr(sc.start_local,1,10) <= ? ORDER BY sc.start_local')
      .all(date, new Date(Date.parse(`${date}T12:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10));
    const today = dayBounds(localToday());
    const salesToday = db.prepare("SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) c FROM orders WHERE status='paid' AND paid_at >= ? AND paid_at < ?").get(today.start, today.end).c;
    const laborToday = isMgr ? db.prepare('SELECT s.*, u.hourly_cents FROM shifts s JOIN users u ON u.id=s.user_id WHERE s.clock_in < ? AND (s.clock_out IS NULL OR s.clock_out >= ?)').all(today.end, today.start)
      .reduce((a, s) => a + Math.max(0, hoursBetween(s.clock_in < today.start ? today.start : s.clock_in, s.clock_out) - s.break_minutes / 60) * s.hourly_cents, 0) : null;
    res.json({ from: date, today: localToday(), onNow, shifts, schedule: sched, salesTodayCents: salesToday, laborTodayCents: laborToday === null ? null : Math.round(laborToday) });
  });

  staff.put('/shifts/:id', requireAuth('manager'), (req, res) => {
    const id = idParam(req);
    const b = parse(z.object({ clock_in: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).optional(), clock_out: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).nullable().optional(), break_minutes: z.number().int().min(0).max(600).optional() }), req.body);
    const s = db.prepare('SELECT * FROM shifts WHERE id=?').get(id); if (!s) return res.status(404).json({ error: 'Not found' });
    const m = { ...s, ...b };
    if (m.clock_out && m.clock_out <= m.clock_in) return res.status(400).json({ error: 'Clock-out must be after clock-in' });
    db.prepare('UPDATE shifts SET clock_in=?, clock_out=?, break_minutes=?, edited_by=? WHERE id=?').run(m.clock_in, m.clock_out ?? null, m.break_minutes, req.user.id, id);
    audit(req.user, 'shift.edit', `#${id}`, clientIp(req));
    notifyStaff('shifts'); res.json({ ok: true });
  });

  staff.post('/schedule', requireAuth('manager'), (req, res) => {
    const b = parse(z.object({ userId: z.number().int(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), note: z.string().trim().max(40).optional() }), req.body);
    if (b.end <= b.start) return res.status(400).json({ error: 'End must be after start' });
    if (!db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(b.userId)) return res.status(404).json({ error: 'Unknown team member' });
    db.prepare('INSERT INTO schedule (user_id, start_local, end_local, role_note) VALUES (?, ?, ?, ?)').run(b.userId, `${b.date} ${b.start}`, `${b.date} ${b.end}`, b.note || null);
    audit(req.user, 'schedule.add', `${b.date} ${b.start}-${b.end}`, clientIp(req));
    notifyStaff('shifts'); res.json({ ok: true });
  });
  staff.delete('/schedule/:id', requireAuth('manager'), (req, res) => {
    db.prepare('DELETE FROM schedule WHERE id=?').run(idParam(req));
    notifyStaff('shifts'); res.json({ ok: true });
  });
  staff.put('/users/:id/wage', requireAuth('owner'), (req, res) => {
    const { hourlyCents } = parse(z.object({ hourlyCents: z.number().int().min(0).max(100_000) }), req.body);
    db.prepare('UPDATE users SET hourly_cents=? WHERE id=?').run(hourlyCents, idParam(req));
    audit(req.user, 'user.wage', `#${req.params.id}`, clientIp(req));
    res.json({ ok: true });
  });
}
