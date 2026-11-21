// Round 7, batch L: lobby screen, smart add-ons, referrals (optional), unhappy-guest recovery, menu sync across locations.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { db, getSettings, setSettings, audit, registerSchema, localToday, currentSlug, forEachLocation, runIn, locationExists, listLocations, getJwtSecret } from './db.js';
import { pushToCustomer, pushToGuest, emailEnabled, emailGuest } from './notify.js';
import { smartEstimate } from './growth.js';

registerSchema((db) => {
  const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name);
  if (!cols.includes('ref_code')) db.exec('ALTER TABLE customers ADD COLUMN ref_code TEXT');
  if (!cols.includes('referred_by')) db.exec('ALTER TABLE customers ADD COLUMN referred_by INTEGER');
  if (!cols.includes('referral_rewarded')) db.exec('ALTER TABLE customers ADD COLUMN referral_rewarded INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_ref ON customers(ref_code);
CREATE TABLE IF NOT EXISTS recoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, feedback_id INTEGER NOT NULL UNIQUE, code TEXT NOT NULL, reached INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL DEFAULT (datetime('now')));`);
});

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fmt = (c) => `$${(c / 100).toFixed(2)}`;
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function oneTimeCode(prefix, kind, value, days, minCents = 0, note = '') {
  for (let i = 0; i < 6; i += 1) {
    const code = `${prefix}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    try { db.prepare('INSERT INTO promos (code, kind, value, min_cents, starts_on, ends_on, max_uses, note) VALUES (?,?,?,?,?,?,1,?)').run(code, kind, value, minCents, localToday(), addDays(localToday(), days), note); return code; } catch { /* clash */ }
  }
  throw new Error('code');
}

/* ---------- smart add-ons: what's often ordered together ---------- */
const pairCache = new Map();
export function pairsMap() {
  const key = currentSlug(); const hit = pairCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60_000) return hit.v;
  const total = db.prepare("SELECT COUNT(*) n FROM orders WHERE created_at > datetime('now','-60 days') AND status <> 'void'").get().n || 1;
  const cnt = Object.fromEntries(db.prepare("SELECT oi.item_id, COUNT(DISTINCT oi.order_id) n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_at > datetime('now','-60 days') AND o.status <> 'void' GROUP BY oi.item_id").all().map((r) => [r.item_id, r.n]));
  const cat = Object.fromEntries(db.prepare('SELECT id, category FROM menu_items WHERE active = 1').all().map((r) => [r.id, r.category]));
  const rows = db.prepare(`SELECT a.item_id x, b.item_id y, COUNT(DISTINCT a.order_id) n FROM order_items a JOIN order_items b ON a.order_id = b.order_id AND a.item_id <> b.item_id
    JOIN orders o ON o.id = a.order_id WHERE o.created_at > datetime('now','-60 days') AND o.status <> 'void' GROUP BY a.item_id, b.item_id HAVING n >= 3`).all();
  const by = {};
  for (const r of rows) {
    if (!cat[r.y] || !cat[r.x] || cat[r.x] === cat[r.y]) continue;
    const lift = (r.n / cnt[r.x]) / ((cnt[r.y] || 1) / total);
    if (lift < 1.1) continue;
    (by[r.x] = by[r.x] || []).push({ id: r.y, score: r.n * lift });
  }
  const v = Object.fromEntries(Object.entries(by).map(([k, list]) => [k, list.sort((a, b) => b.score - a.score).slice(0, 2).map((x) => x.id)]));
  pairCache.set(key, { at: Date.now(), v }); return v;
}

export function registerExtras({ app, staff, io, h }) {
  const { wrap, parse, idParam, clientIp, requireAuth, requireCustomer, publicBase, publicLimiter, notifyStaff } = h;
  const mgr = requireAuth('manager');

  /* ===== lobby screen ===== */
  const screenSecret = () => `${getJwtSecret()}:screen`;
  staff.post('/screen/start', mgr, (req, res) => {
    const token = jwt.sign({ kind: 'screen', loc: currentSlug(), v: getSettings().screen_version || '1' }, screenSecret(), { expiresIn: '365d' });
    audit(req.user, 'screen.start', '', clientIp(req)); res.json({ token, loc: currentSlug() });
  });
  staff.post('/screen/signout-all', mgr, (req, res) => { setSettings({ screen_version: String(Number(getSettings().screen_version || '1') + 1) }); audit(req.user, 'screen.signout_all', '', clientIp(req)); res.json({ ok: true }); });
  app.get('/api/screen', publicLimiter, (req, res) => {
    let ok = false;
    try { const p = jwt.verify(String(req.get('X-Screen') || ''), screenSecret()); ok = p.loc === currentSlug() && String(p.v) === String(getSettings().screen_version || '1'); } catch { /* bad */ }
    if (!ok) return res.status(401).json({ error: 'This screen is signed out. A manager needs to start it again.' });
    const s = getSettings();
    const first = (n) => String(n || '').trim().split(/\s+/)[0]?.slice(0, 14) || '';
    const preparing = db.prepare("SELECT o.number, COALESCE(o.customer_name, g.name) name FROM orders o LEFT JOIN guests g ON g.id = o.guest_id WHERE o.status IN ('open','sent') AND o.created_at > datetime('now','-4 hours') AND (o.fulfillment IN ('pickup','delivery') OR o.table_id IS NULL) ORDER BY o.id LIMIT 24").all();
    const ready = db.prepare("SELECT o.number, COALESCE(o.customer_name, g.name) name FROM orders o LEFT JOIN guests g ON g.id = o.guest_id WHERE o.ready_at > datetime('now','-12 minutes') AND o.status IN ('ready','paid') AND o.fulfillment <> 'delivery' AND (o.fulfillment = 'pickup' OR o.table_id IS NULL) ORDER BY o.ready_at DESC LIMIT 12").all();
    const wait = db.prepare("SELECT name, party_size FROM guests WHERE kind = 'table' AND status IN ('waiting','buzzed','acknowledged') ORDER BY created_at").all();
    const buzzed = db.prepare("SELECT name, t.label FROM guests g LEFT JOIN tables t ON t.id = g.table_id WHERE g.kind = 'table' AND g.status IN ('buzzed','acknowledged') ORDER BY g.buzzed_at DESC LIMIT 6").all();
    res.json({ business: { name: s.business_name, accent: s.accent, logo: s.logo_version !== '0' ? `/api/public/logo?l=${currentSlug()}&v=${s.logo_version}` : null, unit: s.unit_label, type: s.business_type },
      preparing: preparing.map((o) => ({ number: o.number, name: first(o.name) })), ready: ready.map((o) => ({ number: o.number, name: first(o.name) })),
      waitlist: { count: wait.length, next: wait.slice(0, 8).map((g) => ({ name: first(g.name), party: g.party_size })), ready: buzzed.map((g) => ({ name: first(g.name), table: g.label })), minutes: smartEstimate(wait.length + 1, 2) },
      specials: h.specialsLine?.() || [], message: s.screen_message || '', joinUrl: `${publicBase(req)}/join${currentSlug() === 'main' ? '' : `?l=${currentSlug()}`}` });
  });

  /* ===== smart add-ons ===== */
  app.get('/api/public/pairs', publicLimiter, (req, res) => res.json(getSettings().upsell_enabled === '1' ? pairsMap() : {}));

  /* ===== referrals (optional) ===== */
  const refOn = () => getSettings().referral_enabled === '1';
  const refCode = (id) => {
    const c = db.prepare('SELECT ref_code, name FROM customers WHERE id = ?').get(id); if (c?.ref_code) return c.ref_code;
    for (let i = 0; i < 6; i += 1) { const code = `${(c?.name || 'FRIEND').replace(/[^A-Za-z]/g, '').slice(0, 6).toUpperCase() || 'FRIEND'}${crypto.randomInt(100, 999)}`; try { db.prepare('UPDATE customers SET ref_code = ? WHERE id = ?').run(code, id); return code; } catch { /* clash */ } }
    return null;
  };
  h.onCustomerJoined = (id, ref) => {
    if (!refOn() || !ref) return;
    const by = db.prepare('SELECT id FROM customers WHERE ref_code = ? COLLATE NOCASE').get(String(ref).slice(0, 20));
    if (by && by.id !== id) db.prepare('UPDATE customers SET referred_by = ? WHERE id = ? AND referred_by IS NULL').run(by.id, id);
  };
  app.get('/api/c/referral', requireCustomer, (req, res) => {
    const s = getSettings(); if (!refOn()) return res.json({ enabled: false });
    const code = refCode(req.customer.id); const base = publicBase(req); const l = currentSlug() === 'main' ? '' : `&l=${currentSlug()}`;
    const st = db.prepare('SELECT COUNT(*) joined, SUM(referral_rewarded) rewarded FROM customers WHERE referred_by = ?').get(req.customer.id);
    res.json({ enabled: true, code, link: `${base}/account?ref=${code}${l}`, rewardCents: Number(s.referral_reward_cents), minCents: Number(s.referral_min_cents), joined: st.joined, rewarded: st.rewarded || 0, currency: s.currency });
  });
  async function rewardReferrals() {
    if (!refOn()) return;
    const s = getSettings(); const cents = Math.max(100, Number(s.referral_reward_cents) || 500); const min = Number(s.referral_min_cents) || 0;
    const due = db.prepare(`SELECT c.*, r.name ref_name FROM customers c JOIN customers r ON r.id = c.referred_by WHERE c.referral_rewarded = 0 AND (c.visits >= 1 OR EXISTS (SELECT 1 FROM orders o LEFT JOIN guests g ON g.id = o.guest_id WHERE o.paid_at IS NOT NULL AND o.status <> 'void' AND (o.customer_id = c.id OR g.customer_id = c.id OR (o.contact_email IS NOT NULL AND o.contact_email = c.email COLLATE NOCASE))))`).all();
    for (const c of due) {
      db.prepare('UPDATE customers SET referral_rewarded = 1 WHERE id = ?').run(c.id);
      const friend = oneTimeCode('THANKS', 'amount', cents, 60, min, `Referral reward for ${c.name}`);
      const giver = oneTimeCode('THANKS', 'amount', cents, 60, min, `Referral reward for ${c.ref_name}`);
      const off = fmt(cents);
      pushToCustomer(c.id, { title: `${s.business_name}: a thank-you`, body: `Thanks for visiting! Here's ${off} off your next order: code ${friend}.`, tag: 'referral', url: '/account' }).catch(() => {});
      pushToCustomer(c.referred_by, { title: `${s.business_name}: your friend came in`, body: `${c.name.split(' ')[0]} joined from your link. Here's ${off} off: code ${giver}.`, tag: 'referral', url: '/account' }).catch(() => {});
      if (emailEnabled()) {
        const r = db.prepare('SELECT email FROM customers WHERE id = ?').get(c.referred_by);
        if (c.email) emailGuest(c.email, { businessName: s.business_name, subject: `${off} off your next visit`, message: `Thanks for visiting ${s.business_name}! Use code ${friend} for ${off} off within 60 days.`, link: process.env.PUBLIC_URL || '', accent: s.accent, button: 'Visit us' }).catch(() => {});
        if (r?.email) emailGuest(r.email, { businessName: s.business_name, subject: 'Your friend came in', message: `${c.name.split(' ')[0]} joined from your link. Use code ${giver} for ${off} off within 60 days.`, link: process.env.PUBLIC_URL || '', accent: s.accent, button: 'Visit us' }).catch(() => {});
      }
      audit(null, 'referral.reward', `${c.ref_name} → ${c.name}: ${off} each`, null);
    }
  }
  setInterval(() => forEachLocation(() => rewardReferrals().catch((e) => console.error('referrals', e.message))), 30 * 60_000).unref();
  staff.get('/referrals', mgr, (req, res) => {
    const rows = db.prepare('SELECT c.name, c.created_at, c.referral_rewarded, r.name ref_name FROM customers c JOIN customers r ON r.id = c.referred_by ORDER BY c.id DESC LIMIT 100').all();
    const top = db.prepare('SELECT r.name, COUNT(*) n, SUM(c.referral_rewarded) done FROM customers c JOIN customers r ON r.id = c.referred_by GROUP BY r.id ORDER BY n DESC LIMIT 10').all();
    const used = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) c FROM orders WHERE promo_code LIKE 'THANKS-%' AND status <> 'void'").get();
    res.json({ enabled: refOn(), rows, top, used: used.n, salesCents: used.c });
  });
  staff.post('/referrals/run', mgr, wrap(async (req, res) => { await rewardReferrals(); res.json({ ok: true }); }));

  /* ===== unhappy guest recovery ===== */
  h.onLowRating = (f, rating, comment) => {
    const s = getSettings();
    if (s.recovery_enabled !== '1' || rating > Number(s.recovery_max_rating || 2)) return null;
    if (db.prepare('SELECT 1 FROM recoveries WHERE feedback_id = ?').get(f.id)) return null;
    const kind = s.recovery_kind === 'amount' ? 'amount' : 'pct'; const value = Math.max(1, Number(s.recovery_value) || 20);
    const code = oneTimeCode('SORRY', kind, kind === 'amount' ? value * 100 : value, Number(s.recovery_days) || 30, 0, `Recovery for ${f.name}`);
    const off = kind === 'amount' ? fmt(value * 100) : `${value}% off`;
    const text = `${(s.recovery_message || "We're sorry your visit wasn't great. We'd love the chance to make it right.").trim()} Here's ${off} your next visit: code ${code}.`;
    let reached = 0;
    pushToGuest(f.guest_id, { title: `${s.business_name}: we're sorry`, body: text, tag: 'recovery', url: '/account' }).then((r) => { if (r?.sent) db.prepare('UPDATE recoveries SET reached = 1 WHERE feedback_id = ?').run(f.id); }).catch(() => {});
    const email = f.customer_id ? db.prepare('SELECT email FROM customers WHERE id = ?').get(f.customer_id)?.email : db.prepare('SELECT email FROM guests WHERE id = ?').get(f.guest_id)?.email;
    if (email && emailEnabled()) { emailGuest(email, { businessName: s.business_name, subject: "We're sorry", message: text, link: process.env.PUBLIC_URL || '', accent: s.accent, button: `Visit ${s.business_name}` }).catch(() => {}); reached = 1; }
    db.prepare('INSERT INTO recoveries (feedback_id, code, reached) VALUES (?, ?, ?)').run(f.id, code, reached);
    audit(null, 'recovery.sent', `${f.name} (${rating}/5): ${off}`, null);
    void comment;
    return { code, text };
  };
  staff.get('/recoveries', mgr, (req, res) => {
    const rows = db.prepare(`SELECT r.code, r.at, f.rating, f.comment, g.name, (SELECT COUNT(*) FROM orders o WHERE o.promo_code = r.code COLLATE NOCASE AND o.status <> 'void') came_back
      FROM recoveries r JOIN feedback f ON f.id = r.feedback_id JOIN guests g ON g.id = f.guest_id ORDER BY r.id DESC LIMIT 100`).all();
    res.json({ rows, sent: rows.length, cameBack: rows.filter((r) => r.came_back).length });
  });

  /* ===== menu sync to other locations ===== */
  staff.post('/menu/sync', requireAuth('owner'), (req, res) => {
    const b = parse(z.object({ targets: z.array(z.string()).min(1).max(50), itemIds: z.array(z.number().int()).max(500).optional(), prices: z.boolean().default(true), details: z.boolean().default(true), availability: z.boolean().default(false), addMissing: z.boolean().default(true) }), req.body);
    const from = currentSlug();
    const src = db.prepare(`SELECT * FROM menu_items WHERE active = 1 ${b.itemIds?.length ? `AND id IN (${b.itemIds.map(Number).join(',')})` : ''}`).all();
    if (!src.length) throw err('No items to send');
    const out = [];
    for (const slug of b.targets) {
      if (slug === from || !locationExists(slug)) continue;
      const r = runIn(slug, () => {
        let updated = 0; let added = 0;
        db.transaction(() => {
          for (const it of src) {
            const t = db.prepare('SELECT * FROM menu_items WHERE lower(name) = lower(?) ORDER BY active DESC LIMIT 1').get(it.name);
            if (t) {
              const sets = []; const vals = [];
              if (b.prices) { sets.push('price_cents = ?'); vals.push(it.price_cents); }
              if (b.details) { sets.push('category = ?', 'description = ?', 'allergens = ?', 'diet = ?', 'i18n = ?', 'color = ?'); vals.push(it.category, it.description, it.allergens, it.diet, it.i18n, it.color); }
              if (b.availability) { sets.push('active = ?', 'guest_orderable = ?'); vals.push(it.active, it.guest_orderable); }
              if (sets.length) { db.prepare(`UPDATE menu_items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, t.id); updated += 1; }
            } else if (b.addMissing) {
              db.prepare('INSERT INTO menu_items (name, category, price_cents, color, active, guest_orderable, sort, description, allergens, diet, i18n) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                .run(it.name, it.category, it.price_cents, it.color, 1, it.guest_orderable, it.sort, it.description, it.allergens, it.diet, it.i18n); added += 1;
            }
          }
        })();
        audit(req.user, 'menu.sync_in', `from ${from}: ${updated} updated, ${added} added`, clientIp(req));
        notifyStaff('menu');
        return { slug, updated, added };
      });
      out.push(r);
    }
    audit(req.user, 'menu.sync_out', out.map((x) => `${x.slug}: ${x.updated} updated, ${x.added} added`).join('; '), clientIp(req));
    res.json({ results: out, locations: listLocations().map((l) => l.slug) });
  });
}
