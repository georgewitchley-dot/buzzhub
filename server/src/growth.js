// Batch 3: wait times learned from real data, loyalty rewards, post-visit feedback.
import crypto from 'node:crypto';
import { z } from 'zod';
import { db, getSettings, audit } from './db.js';
import { pushToGuest, pushToCustomer, emailEnabled, emailGuest } from './notify.js';

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('guests').includes('ahead_at_join')) db.exec('ALTER TABLE guests ADD COLUMN ahead_at_join INTEGER');
if (!cols('customers').includes('visits')) db.exec('ALTER TABLE customers ADD COLUMN visits INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL, title TEXT NOT NULL, code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','redeemed','expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), redeemed_at TEXT, redeemed_by INTEGER
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id INTEGER NOT NULL UNIQUE, customer_id INTEGER, token TEXT NOT NULL UNIQUE,
  send_after TEXT NOT NULL, sent_at TEXT, rating INTEGER, comment TEXT, responded_at TEXT, review_clicked INTEGER NOT NULL DEFAULT 0
);
`);

/* ================= Smart wait times ================= */
// Minutes per place in line, learned from the last 60 days. Buckets by party size and time of day.
const sizeBucket = (n) => (n <= 2 ? 's' : n <= 4 ? 'm' : n <= 6 ? 'l' : 'xl');
const partBucket = (h) => (h >= 11 && h < 15 ? 'lunch' : h >= 17 && h < 22 ? 'dinner' : 'other');
let model = { at: 0, buckets: {}, overall: null, samples: 0 };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function rebuild() {
  const tz = getSettings().timezone;
  const hourOf = (ts) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(`${ts.replace(' ', 'T')}Z`)));
  const rows = db.prepare(`SELECT party_size, created_at, ahead_at_join, (julianday(seated_at) - julianday(created_at)) * 1440 wait
    FROM guests WHERE kind = 'table' AND seated_at IS NOT NULL AND ahead_at_join IS NOT NULL AND created_at > datetime('now','-60 days')`).all();
  const buckets = {}; const all = [];
  for (const r of rows) {
    if (r.wait < 0 || r.wait > 240) continue; // ignore bad data
    const per = r.wait / (r.ahead_at_join + 1);
    all.push(per);
    for (const k of [`${sizeBucket(r.party_size)}:${partBucket(hourOf(r.created_at))}`, `${sizeBucket(r.party_size)}:*`, `*:${partBucket(hourOf(r.created_at))}`]) (buckets[k] = buckets[k] || []).push(per);
  }
  const out = {};
  for (const [k, v] of Object.entries(buckets)) if (v.length >= 8) out[k] = median(v);
  model = { at: Date.now(), buckets: out, overall: all.length >= 8 ? median(all) : null, samples: all.length };
}

/** Estimated minutes for someone at `pos` (1 = next). Falls back to the business's setting until there's enough data. */
export function smartEstimate(pos, partySize, s = getSettings()) {
  if (!pos) return 0;
  const fallback = Number(s.avg_turn_minutes || 10);
  if (s.smart_waits !== '1') return Math.max(1, pos * fallback);
  if (Date.now() - model.at > 10 * 60_000) rebuild();
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: s.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const sb = sizeBucket(partySize || 2); const pb = partBucket(h);
  const per = model.buckets[`${sb}:${pb}`] ?? model.buckets[`${sb}:*`] ?? model.buckets[`*:${pb}`] ?? model.overall ?? fallback;
  return Math.max(1, Math.round(pos * per));
}
export const waitModelInfo = () => { if (Date.now() - model.at > 10 * 60_000) rebuild(); return { samples: model.samples, learned: model.overall !== null, perPlace: model.overall ? Math.round(model.overall * 10) / 10 : null }; };

export function registerGrowth({ app, staff, io, h }) {
  const { parse, idParam, now, clientIp, requireAuth, notifyStaff, requireCustomer, publicLimiter, alertOwners } = h;

  /* ================= Loyalty ================= */
  const newCode = () => String(crypto.randomInt(100000, 999999));
  /** Count a finished visit for a customer and hand out a reward when they hit the target. */
  h.countVisit = async (customerId) => {
    if (!customerId) return;
    const s = getSettings();
    db.prepare('UPDATE customers SET visits = visits + 1 WHERE id = ?').run(customerId);
    const c = db.prepare('SELECT id, name, visits FROM customers WHERE id = ?').get(customerId);
    const every = Number(s.loyalty_visits);
    if (s.loyalty_enabled !== '1' || !every || c.visits % every !== 0) return;
    const code = newCode();
    db.prepare('INSERT INTO rewards (customer_id, title, code) VALUES (?, ?, ?)').run(c.id, s.loyalty_reward, code);
    audit(null, 'loyalty.earned', `${c.name}: ${s.loyalty_reward} (visit ${c.visits})`, null);
    await pushToCustomer(c.id, { title: `${s.business_name}: you earned a reward`, body: `Thanks for ${c.visits} visits! ${s.loyalty_reward} is yours next time. Open your account to show it.`, tag: 'reward', url: '/account' }).catch(() => {});
    notifyStaff('customers');
  };

  app.get('/api/c/loyalty', requireCustomer, (req, res) => {
    const s = getSettings();
    const c = db.prepare('SELECT visits FROM customers WHERE id = ?').get(req.customer.id);
    const every = Number(s.loyalty_visits) || 0;
    res.json({ enabled: s.loyalty_enabled === '1', visits: c.visits, every, reward: s.loyalty_reward, toNext: every ? every - (c.visits % every) : null,
      rewards: db.prepare("SELECT id, title, code, created_at FROM rewards WHERE customer_id = ? AND status = 'active' ORDER BY id").all(req.customer.id) });
  });

  staff.get('/rewards/lookup', (req, res) => {
    const code = String(req.query.code || '').replace(/\D/g, '');
    const r = /^\d{6}$/.test(code) ? db.prepare("SELECT r.*, c.name FROM rewards r JOIN customers c ON c.id = r.customer_id WHERE r.code = ? AND r.status = 'active'").get(code) : null;
    if (!r) return res.status(404).json({ error: 'No active reward with that code' });
    res.json({ id: r.id, title: r.title, name: r.name, created_at: r.created_at });
  });
  staff.get('/customers/:id/rewards', (req, res) => {
    res.json(db.prepare("SELECT id, title, code, created_at FROM rewards WHERE customer_id = ? AND status = 'active' ORDER BY id").all(idParam(req)));
  });
  staff.post('/rewards/:id/redeem', (req, res) => {
    const r = db.prepare("SELECT r.*, c.name FROM rewards r JOIN customers c ON c.id = r.customer_id WHERE r.id = ? AND r.status = 'active'").get(idParam(req));
    if (!r) return res.status(409).json({ error: 'That reward was already used' });
    db.prepare("UPDATE rewards SET status = 'redeemed', redeemed_at = ?, redeemed_by = ? WHERE id = ?").run(now(), req.user.id, r.id);
    audit(req.user, 'loyalty.redeem', `${r.name}: ${r.title}`, clientIp(req));
    notifyStaff('guests'); notifyStaff('customers');
    res.json({ ok: true, title: r.title, name: r.name });
  });

  /* ================= Feedback after the visit ================= */
  h.scheduleFeedback = (guestId) => {
    const s = getSettings();
    if (s.feedback_enabled !== '1') return;
    const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
    if (!g) return;
    const delay = Number(s.feedback_delay_minutes || 60);
    const at = new Date(Date.now() + delay * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare('INSERT OR IGNORE INTO feedback (guest_id, customer_id, token, send_after) VALUES (?, ?, ?, ?)').run(g.id, g.customer_id || null, crypto.randomBytes(16).toString('base64url'), at);
  };

  setInterval(async () => {
    try {
      const s = getSettings();
      if (s.feedback_enabled !== '1') return;
      const due = db.prepare("SELECT f.*, g.email, g.notify_email, g.name FROM feedback f JOIN guests g ON g.id = f.guest_id WHERE f.sent_at IS NULL AND f.send_after <= datetime('now') AND f.send_after > datetime('now','-1 day') LIMIT 20").all();
      for (const f of due) {
        db.prepare('UPDATE feedback SET sent_at = ? WHERE id = ?').run(now(), f.id);
        const payload = { title: `${s.business_name}`, body: `Thanks for coming in, ${f.name.split(' ')[0]}. How was everything? It takes 10 seconds.`, tag: 'feedback', url: `/f/${f.token}` };
        await pushToGuest(f.guest_id, payload).catch(() => {});
        if (f.email && emailEnabled()) await emailGuest(f.email, { businessName: s.business_name, subject: 'How was your visit?', message: payload.body, link: `${process.env.PUBLIC_URL || ''}/f/${f.token}`, accent: s.accent }).catch(() => {});
      }
    } catch (e) { console.error('feedback', e); }
  }, 60_000).unref();

  const fbByToken = (t) => (/^[A-Za-z0-9_-]{20,30}$/.test(t) ? db.prepare('SELECT f.*, g.name FROM feedback f JOIN guests g ON g.id = f.guest_id WHERE f.token = ?').get(t) : null);
  app.get('/api/f/:token', publicLimiter, (req, res) => {
    const f = fbByToken(req.params.token); if (!f) return res.status(404).json({ error: 'This link is not valid.' });
    const s = getSettings();
    res.json({ name: f.name.split(' ')[0], rating: f.rating, done: Boolean(f.responded_at), business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?v=${s.logo_version}` : null },
      reviewUrl: s.review_url || null, threshold: Number(s.feedback_review_threshold || 4) });
  });
  app.post('/api/f/:token', publicLimiter, (req, res) => {
    const f = fbByToken(req.params.token); if (!f) return res.status(404).json({ error: 'This link is not valid.' });
    if (f.responded_at && Date.now() - Date.parse(`${f.responded_at.replace(' ', 'T')}Z`) > 3_600_000) return res.status(409).json({ error: 'Thanks, we already have your feedback.' });
    const b = parse(z.object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(600).optional() }), req.body);
    db.prepare('UPDATE feedback SET rating = ?, comment = ?, responded_at = ? WHERE id = ?').run(b.rating, b.comment || null, now(), f.id);
    audit(null, 'feedback.received', `${f.name}: ${b.rating}/5${b.comment ? ` — ${b.comment.slice(0, 80)}` : ''}`, clientIp(req));
    if (b.rating <= 2 && !f.rating) alertOwners?.(`${getSettings().business_name}: unhappy guest`, `${f.name} rated their visit ${b.rating}/5${b.comment ? `: "${b.comment.slice(0, 120)}"` : ''}`, 'feedback');
    notifyStaff('feedback');
    res.json({ ok: true });
  });
  app.post('/api/f/:token/review', publicLimiter, (req, res) => {
    const f = fbByToken(req.params.token); if (f) db.prepare('UPDATE feedback SET review_clicked = 1 WHERE id = ?').run(f.id);
    res.json({ ok: true });
  });

  staff.get('/feedback', requireAuth('manager'), (req, res) => {
    const rows = db.prepare(`SELECT f.rating, f.comment, f.responded_at, f.review_clicked, g.name, g.party_size, t.label table_label
      FROM feedback f JOIN guests g ON g.id = f.guest_id LEFT JOIN tables t ON t.id = g.table_id WHERE f.responded_at IS NOT NULL ORDER BY f.responded_at DESC LIMIT 200`).all();
    const stats = db.prepare(`SELECT COUNT(*) sent, SUM(responded_at IS NOT NULL) answered, AVG(rating) avg, SUM(review_clicked) reviews,
      AVG(CASE WHEN responded_at > datetime('now','-7 days') THEN rating END) avg7 FROM feedback WHERE sent_at IS NOT NULL`).get();
    const dist = db.prepare('SELECT rating, COUNT(*) c FROM feedback WHERE rating IS NOT NULL GROUP BY rating').all();
    res.json({ rows, stats, dist: Object.fromEntries(dist.map((d) => [d.rating, d.c])), wait: waitModelInfo() });
  });
}
