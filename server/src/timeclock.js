// Time clock: a wall screen (its own device token, like the lobby screen) where staff punch in and out with their PIN,
// take breaks, and see their own hours; plus "who's on now" for the command center.
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, registerSchema, localToday, currentSlug, currentTz, getJwtSecret } from './db.js';
import { findUserByPin, loginBlocked, recordLoginFail, clearLoginFails } from './security.js';
import { dayBounds } from './ops.js';

registerSchema((db) => {
  const cols = db.prepare('PRAGMA table_info(shifts)').all().map((c) => c.name);
  if (!cols.includes('break_started')) db.exec('ALTER TABLE shifts ADD COLUMN break_started TEXT');
  if (!cols.includes('source')) db.exec("ALTER TABLE shifts ADD COLUMN source TEXT NOT NULL DEFAULT 'lock'");
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const ms = (sql) => Date.parse(`${sql.replace(' ', 'T')}Z`);
const hoursBetween = (a, b) => Math.max(0, ((b ? ms(b) : Date.now()) - ms(a)) / 3600000);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const localHM = () => new Intl.DateTimeFormat('en-GB', { timeZone: currentTz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const r2 = (x) => Math.round(x * 100) / 100;
const openShift = (uid) => db.prepare('SELECT * FROM shifts WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1').get(uid);
const breakMin = (s) => (s.break_minutes || 0) + (s.break_started ? hoursBetween(s.break_started) * 60 : 0);
const worked = (s) => Math.max(0, hoursBetween(s.clock_in, s.clock_out) - breakMin(s) / 60);

/** Everyone on the clock right now, with today's hours and break state. */
export function whosOn() {
  const { start } = dayBounds(localToday());
  return db.prepare('SELECT s.*, u.name, u.role, u.tip_role FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_out IS NULL ORDER BY s.clock_in').all().map((s) => {
    const sched = db.prepare('SELECT start_local, end_local, role_note FROM schedule WHERE user_id = ? AND substr(start_local,1,10) = ? ORDER BY start_local LIMIT 1').get(s.user_id, localToday());
    return { userId: s.user_id, name: s.name, role: s.role, position: sched?.role_note || s.tip_role || '', since: s.clock_in, onBreak: Boolean(s.break_started), breakSince: s.break_started,
      hours: r2(worked(s)), scheduledEnd: sched?.end_local?.slice(11) || null, overnight: s.clock_in < start };
  });
}

/** One person's time card: today, this week, their schedule and their next shift. */
export function timeCard(uid) {
  const s = getSettings(); const today = localToday();
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); const weekStartDow = Number(s.payroll_week_start ?? 1);
  const weekStart = addDays(today, -((dow - weekStartDow + 7) % 7));
  const a = dayBounds(weekStart).start; const t0 = dayBounds(today).start;
  const rows = db.prepare('SELECT * FROM shifts WHERE user_id = ? AND (clock_out IS NULL OR clock_out >= ?) ORDER BY clock_in').all(uid, a);
  const todayH = rows.filter((x) => !x.clock_out || x.clock_out >= t0).reduce((h, x) => h + Math.max(0, hoursBetween(x.clock_in < t0 ? t0 : x.clock_in, x.clock_out) - breakMin(x) / 60), 0);
  const weekH = rows.reduce((h, x) => h + Math.max(0, hoursBetween(x.clock_in < a ? a : x.clock_in, x.clock_out) - breakMin(x) / 60), 0);
  const sched = db.prepare('SELECT start_local, end_local, role_note FROM schedule WHERE user_id = ? AND substr(start_local,1,10) = ? ORDER BY start_local').all(uid, today);
  const next = db.prepare("SELECT start_local, end_local, role_note FROM schedule WHERE user_id = ? AND start_local > ? ORDER BY start_local LIMIT 1").get(uid, `${today} ${localHM()}`);
  const cur = openShift(uid);
  const ot = Number(s.ot_weekly_hours) || 40;
  return { todayHours: r2(todayH), weekHours: r2(weekH), weekStart, overtimeAt: ot, overtimeHours: r2(Math.max(0, weekH - ot)), scheduledToday: sched.map((x) => ({ start: x.start_local.slice(11), end: x.end_local.slice(11), position: x.role_note || '' })),
    next: next ? { start: next.start_local, end: next.end_local.slice(11), position: next.role_note || '' } : null,
    clockedIn: Boolean(cur), since: cur?.clock_in || null, onBreak: Boolean(cur?.break_started), breakMinutes: cur ? Math.round(breakMin(cur)) : 0,
    recent: db.prepare("SELECT clock_in, clock_out, break_minutes FROM shifts WHERE user_id = ? AND clock_out IS NOT NULL ORDER BY id DESC LIMIT 5").all(uid).map((x) => ({ in: x.clock_in, out: x.clock_out, hours: r2(worked(x)) })) };
}

/** Clock in, clock out, or start/end a break. Returns what happened. */
export function punch(user, action, ip, source = 'clock') {
  const cur = openShift(user.id); const t = nowSql();
  if (action === 'auto') action = cur ? 'out' : 'in';
  if (action === 'in') {
    if (cur) throw err(`${user.name.split(' ')[0]} is already clocked in`, 409);
    db.prepare('INSERT INTO shifts (user_id, clock_in, source) VALUES (?, ?, ?)').run(user.id, t, source);
    const sched = db.prepare('SELECT start_local FROM schedule WHERE user_id = ? AND substr(start_local,1,10) = ? ORDER BY start_local LIMIT 1').get(user.id, localToday());
    let late = 0; if (sched) { const [h, m] = sched.start_local.slice(11).split(':').map(Number); const [nh, nm] = localHM().split(':').map(Number); late = nh * 60 + nm - (h * 60 + m); }
    audit(user, 'shift.in', `${source}${late > 5 ? `, ${late} min late` : ''}`, ip);
    return { action: 'in', lateMinutes: late > 5 ? late : 0, early: late < -15 ? -late : 0 };
  }
  if (!cur) throw err(`${user.name.split(' ')[0]} is not clocked in`, 409);
  if (action === 'break_start') {
    if (cur.break_started) throw err('Already on break', 409);
    db.prepare('UPDATE shifts SET break_started = ? WHERE id = ?').run(t, cur.id); audit(user, 'shift.break', 'start', ip); return { action: 'break_start' };
  }
  if (action === 'break_end') {
    if (!cur.break_started) throw err('Not on break', 409);
    const mins = Math.round(hoursBetween(cur.break_started) * 60);
    db.prepare('UPDATE shifts SET break_minutes = break_minutes + ?, break_started = NULL WHERE id = ?').run(mins, cur.id); audit(user, 'shift.break', `end, ${mins} min`, ip); return { action: 'break_end', breakMinutes: mins };
  }
  if (action === 'out') {
    const extra = cur.break_started ? Math.round(hoursBetween(cur.break_started) * 60) : 0;
    db.prepare('UPDATE shifts SET clock_out = ?, break_minutes = break_minutes + ?, break_started = NULL WHERE id = ?').run(t, extra, cur.id);
    const done = db.prepare('SELECT * FROM shifts WHERE id = ?').get(cur.id);
    const hours = r2(worked(done)); audit(user, 'shift.out', `${hours} h`, ip); return { action: 'out', hours };
  }
  throw err('Unknown action');
}

export function registerTimeClock({ app, staff, h }) {
  const { parse, clientIp, requireAuth, notifyStaff, wrap } = h;
  const mgr = requireAuth('manager');
  const secret = () => `${getJwtSecret()}:clock`;
  const clockAuth = (req) => {
    try { const p = jwt.verify(String(req.get('X-Clock') || ''), secret()); if (p.loc === currentSlug() && String(p.v) === String(getSettings().clock_version || '1')) return p; } catch { /* bad */ }
    throw err('This time clock is signed out. A manager needs to set it up again.', 401);
  };
  staff.post('/timeclock/start', mgr, (req, res) => { const token = jwt.sign({ kind: 'clock', loc: currentSlug(), v: getSettings().clock_version || '1' }, secret(), { expiresIn: '365d' }); audit(req.user, 'clock.device', 'started', clientIp(req)); res.json({ token, loc: currentSlug() }); });
  staff.post('/timeclock/signout-all', mgr, (req, res) => { setSettings({ clock_version: String(Number(getSettings().clock_version || '1') + 1) }); audit(req.user, 'clock.device', 'all signed out', clientIp(req)); res.json({ ok: true }); });

  // The wall screen: who's on (first names only), the clock, the business name.
  app.get('/api/clock', (req, res) => {
    clockAuth(req); const s = getSettings();
    res.json({ business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null }, tz: currentTz(), message: s.clock_message || '',
      on: whosOn().map((p) => ({ name: p.name.split(' ')[0], position: p.position, since: p.since, onBreak: p.onBreak, breakSince: p.breakSince })),
      breakReminderHours: Number(s.break_after_hours || 0), declareTips: s.declare_tips === '1', pulse: s.shift_pulse !== '0', punchPhoto: s.punch_photo === '1', handoff: s.handoff_notes !== '0', otGuard: s.ot_guard === '1' });
  });
  // Step 1: PIN → who you are and what you can do. Step 2: PIN + action.
  app.post('/api/clock/punch', wrap(async (req, res) => {
    clockAuth(req);
    const ip = clientIp(req); const wait = loginBlocked(ip);
    if (wait) return res.status(429).json({ error: `Too many wrong PINs. Try again in ${wait}s.` });
    const b = parse(z.object({ pin: z.string().regex(/^\d{4,8}$/, 'Enter your PIN'), action: z.enum(['check', 'in', 'out', 'break_start', 'break_end', 'note', 'pulse']).default('check'), managerPin: z.string().regex(/^\d{4,8}$/).optional(), photo: z.string().max(130000).optional(), note: z.string().max(600).optional(), tipsCents: z.number().int().min(0).max(1_000_000).optional(), rating: z.number().int().min(1).max(4).optional() }), req.body);
    const user = await findUserByPin(b.pin);
    if (!user) { const r = recordLoginFail(ip); audit(null, 'auth.fail', 'bad PIN at time clock screen', ip); return res.status(401).json({ error: r.lockedFor ? `Too many wrong PINs. Locked for ${r.lockedFor}s.` : 'Wrong PIN' }); }
    clearLoginFails(ip);
    let result = null; let approval = null;
    if (b.action === 'note') { h.addHandoff?.(user, b.note, ip); return res.json({ ok: true, firstName: user.name.split(' ')[0] }); }
    if (b.action === 'pulse') { if (b.rating) h.addPulse?.(user, b.rating, b.note); return res.json({ ok: true, firstName: user.name.split(' ')[0] }); }
    if (b.action === 'in') approval = await h.punchGuard?.({ user, action: 'in', managerPin: b.managerPin, ip, where: 'time clock' });
    if (b.action !== 'check') { result = punch(user, b.action, ip, 'clock'); h.afterPunch?.({ user, result, photo: b.photo }); if (result.action === 'out' && b.tipsCents !== undefined) h.declareTips?.(user.id, b.tipsCents); notifyStaff('shifts'); }
    const card = timeCard(user.id);
    let otWarn = null; if (b.action === 'check' && !card.clockedIn) { try { await h.punchGuard?.({ user, action: 'in', ip, where: 'check' }); } catch (e) { if (e.needsManager) otWarn = e.message; } }
    res.json({ name: user.name, firstName: user.name.split(' ')[0], result, card, approval, otWarn, tipout: result?.action === 'out' ? (h.shiftTipout?.(user.id) || null) : null, notes: result?.action === 'in' ? (h.handoffFor?.(user.id) || []) : [],
      choices: card.clockedIn ? (card.onBreak ? ['break_end', 'out'] : ['out', 'break_start']) : ['in'] });
  }));

  // In the command center
  staff.get('/whos-on', (req, res) => {
    const list = whosOn(); const isMgr = ['manager', 'owner'].includes(req.user.role);
    res.json({ on: list.map((p) => (isMgr ? p : { name: p.name, position: p.position, since: p.since, onBreak: p.onBreak })), count: list.length, onBreak: list.filter((p) => p.onBreak).length });
  });
  staff.get('/me/timecard', (req, res) => res.json(timeCard(req.user.id)));
  staff.post('/me/punch', wrap(async (req, res) => {
    if (getSettings().app_punch !== '1') throw err('Clock in at the time clock or the lock screen with your PIN.', 403);
    const b = parse(z.object({ action: z.enum(['in', 'out', 'break_start', 'break_end']), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), acc: z.number().min(0).max(100000).optional(), tipsCents: z.number().int().min(0).max(1_000_000).optional() }), req.body);
    h.phonePunchCheck?.(b);
    if (b.action === 'in') await h.punchGuard?.({ user: req.user, action: 'in', ip: clientIp(req), where: 'phone' });
    const r = punch(req.user, b.action, clientIp(req), 'app'); if (r.action === 'out' && b.tipsCents !== undefined) h.declareTips?.(req.user.id, b.tipsCents); notifyStaff('shifts'); res.json({ result: r, card: timeCard(req.user.id), notes: b.action === 'in' ? (h.handoffFor?.(req.user.id) || []) : [] });
  }));
  staff.post('/users/:id/punch', mgr, wrap(async (req, res) => {
    const b = parse(z.object({ action: z.enum(['in', 'out', 'break_start', 'break_end']) }), req.body);
    const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(Number(req.params.id)); if (!u) throw err('Not found', 404);
    if (b.action === 'in') await h.punchGuard?.({ user: u, action: 'in', approvedBy: req.user, ip: clientIp(req), where: 'manager' });
    const r = punch(u, b.action, clientIp(req), `manager:${req.user.name}`); audit(req.user, 'shift.manager_punch', `${u.name} ${b.action}`, clientIp(req)); notifyStaff('shifts'); res.json({ result: r });
  }));
}
