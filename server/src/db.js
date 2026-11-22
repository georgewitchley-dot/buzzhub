import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
fs.mkdirSync(path.join(DATA_DIR, 'locations'), { recursive: true });

/* ======================================================================
   One database per location. `db` always points at the current request's
   location (AsyncLocalStorage), so feature code just uses `db` as before.
   ====================================================================== */
const als = new AsyncLocalStorage();
const dbs = new Map();          // slug -> Database
const tzOf = new WeakMap();     // Database -> { tz, fmt }
const schemaFns = [];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const currentSlug = () => als.getStore()?.slug || 'main';
export const runIn = (slug, fn) => als.run({ slug }, fn);

function fileFor(slug) { return slug === 'main' ? path.join(DATA_DIR, 'buzzhub.db') : path.join(DATA_DIR, 'locations', `${slug}.db`); }
function setTzFor(d, tz) {
  try { const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); tzOf.set(d, { tz, fmt }); } catch { /* keep old */ }
}
function openDatabase(slug) {
  const d = new Database(fileFor(slug));
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  setTzFor(d, 'America/New_York');
  d.function('localdate', { deterministic: false }, (ts) => (ts ? tzOf.get(d).fmt.format(new Date(`${String(ts).replace(' ', 'T')}Z`)) : null));
  d.function('localtoday', { deterministic: false }, () => tzOf.get(d).fmt.format(new Date()));
  dbs.set(slug, d);
  for (const fn of schemaFns) fn(d);
  const tzRow = d.prepare("SELECT value FROM settings WHERE key = 'timezone'").get();
  setTzFor(d, tzRow?.value || process.env.TZ_DEFAULT || 'America/New_York');
  return d;
}
function current() {
  const slug = currentSlug();
  return dbs.get(slug) || (slug === 'main' || locationExists(slug) ? openDatabase(slug) : dbs.get('main'));
}
/** Run every migration/table creation on every location, now and when new ones open. */
export function registerSchema(fn) { schemaFns.push(fn); for (const d of dbs.values()) fn(d); }

export const db = new Proxy({}, {
  get(_, key) { const d = current(); const v = d[key]; return typeof v === 'function' ? v.bind(d) : v; },
});

export function locationExists(slug) {
  if (slug === 'main') return true;
  if (!SLUG_RE.test(slug)) return false;
  const main = dbs.get('main');
  return Boolean(main?.prepare('SELECT 1 FROM locations WHERE slug = ?').get(slug));
}
export function allSlugs() {
  const main = dbs.get('main');
  return ['main', ...main.prepare('SELECT slug FROM locations ORDER BY created_at').all().map((r) => r.slug)];
}
export function listLocations() {
  return allSlugs().map((slug) => runIn(slug, () => ({ slug, name: getSettings().business_name, type: getSettings().business_type })));
}
/** Run fn once for each location (used by background jobs). */
export async function forEachLocation(fn) {
  for (const slug of allSlugs()) {
    try { await runIn(slug, fn); } catch (e) { console.error(`[${slug}]`, e); }
  }
}
export function createLocationDb(slug, name) {
  dbs.get('main').prepare('INSERT INTO locations (slug, name) VALUES (?, ?)').run(slug, name);
  openDatabase(slug);
}

registerSchema((db) => {
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','manager','staff')),
  pin_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 4,
  zone TEXT NOT NULL DEFAULT 'Main',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reserved','seated','dirty')),
  guest_id INTEGER,
  seated_at TEXT
);

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'table' CHECK (kind IN ('table','order')),
  name TEXT NOT NULL,
  phone TEXT,
  party_size INTEGER NOT NULL DEFAULT 2,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','buzzed','acknowledged','seated','done','cancelled','noshow')),
  token TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL DEFAULT 'staff',
  buzz_count INTEGER NOT NULL DEFAULT 0,
  last_message TEXT,
  table_id INTEGER,
  order_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  buzzed_at TEXT,
  acknowledged_at TEXT,
  seated_at TEXT,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_guests_status ON guests(status);

CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  price_cents INTEGER NOT NULL,
  color TEXT NOT NULL DEFAULT '#7c5cff',
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','sent','ready','paid','void')),
  table_id INTEGER,
  guest_id INTEGER,
  customer_name TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  tip_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  ready_at TEXT,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
`);

/* ---------- migrations (idempotent, safe on an existing database) ---------- */
const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
const addCol = (table, col, def) => { if (!hasCol(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };

addCol('guests', 'email', 'TEXT');
addCol('guests', 'notify_email', 'INTEGER NOT NULL DEFAULT 0');
addCol('guests', 'heads_up_at', 'TEXT');
addCol('guests', 'preorder_open', 'INTEGER NOT NULL DEFAULT 0');
if (!hasCol('menu_items', 'guest_orderable')) {
  addCol('menu_items', 'guest_orderable', 'INTEGER NOT NULL DEFAULT 0');
  db.exec("UPDATE menu_items SET guest_orderable = 1 WHERE category IN ('Drinks','Sides','Coffee','Tea','Bakery','Beverages','Appetizers')");
}
addCol('orders', 'source', "TEXT NOT NULL DEFAULT 'staff'");
addCol('guests', 'customer_id', 'INTEGER');
addCol('guests', 'booking_id', 'INTEGER');
addCol('users', 'hub_key', 'TEXT');

// orders.status needs a new 'held' state (guest pre-orders waiting for their table)
const ordersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get()?.sql || '';
if (!ordersSql.includes("'held'")) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE orders_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('held','open','sent','ready','paid','void')),
        table_id INTEGER, guest_id INTEGER, customer_name TEXT,
        subtotal_cents INTEGER NOT NULL DEFAULT 0, tax_cents INTEGER NOT NULL DEFAULT 0,
        tip_cents INTEGER NOT NULL DEFAULT 0, discount_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL DEFAULT 0, payment_method TEXT, created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, ready_at TEXT, paid_at TEXT,
        source TEXT NOT NULL DEFAULT 'staff'
      );
      INSERT INTO orders_new (id, number, status, table_id, guest_id, customer_name, subtotal_cents, tax_cents, tip_cents, discount_cents, total_cents, payment_method, created_by, created_at, sent_at, ready_at, paid_at, source)
        SELECT id, number, status, table_id, guest_id, customer_name, subtotal_cents, tax_cents, tip_cents, discount_cents, total_cents, payment_method, created_by, created_at, sent_at, ready_at, paid_at, source FROM orders;
      DROP TABLE orders;
      ALTER TABLE orders_new RENAME TO orders;
    `);
  })();
  db.pragma('foreign_keys = ON');
}

db.exec(`
CREATE TABLE IF NOT EXISTS push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER,
  customer_id INTEGER,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_guest ON push_subs(guest_id);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  pw_hash TEXT NOT NULL,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  service_id INTEGER,
  service_name TEXT,
  party_size INTEGER NOT NULL DEFAULT 1,
  start_local TEXT NOT NULL,           -- 'YYYY-MM-DD HH:MM' in the business timezone
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','checked_in','done','cancelled','noshow')),
  guest_id INTEGER,
  reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_start ON bookings(start_local);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE TABLE IF NOT EXISTS assets (key TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
`);

db.exec(`CREATE TABLE IF NOT EXISTS locations (slug TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
});

/** Web Push VAPID keys: env vars, else generated once and kept in the data dir. */
export function getVapidKeys(generate) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  const file = path.join(DATA_DIR, '.vapid.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = generate();
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

const DEFAULTS = {
  business_name: 'My Business',
  business_type: 'restaurant',
  unit_label: 'Table',
  accent: '#ffb020',
  currency: 'USD',
  tax_rate: '8.875',
  avg_turn_minutes: '12',
  idle_lock_minutes: '5',
  self_checkin: '1',
  welcome_message: "You're on the list! Turn on alerts and we'll buzz your phone the moment we're ready.",
  preorder_enabled: '1',
  preorder_open_minutes: '20',
  heads_up_minutes: '15',
  sign_headline: 'Scan to join the waitlist',
  logo_version: '0',
  timezone: process.env.TZ_DEFAULT || 'America/New_York',
  booking_enabled: '0',
  booking_open: '09:00',
  booking_close: '17:00',
  booking_days: '0111110', // Sun..Sat
  booking_slot_minutes: '30',
  booking_capacity: '1',
  booking_days_ahead: '14',
  booking_reminder_minutes: '60',
  kds_late_minutes: '12',
  require_approved_devices: '0',
  smart_waits: '1',
  loyalty_enabled: '1',
  loyalty_visits: '5',
  loyalty_reward: 'A free drink',
  feedback_enabled: '1',
  feedback_delay_minutes: '60',
  feedback_review_threshold: '4',
  review_url: '',
  online_enabled: '0',
  online_pickup: '1',
  online_delivery: '0',
  delivery_fee_cents: '499',
  delivery_min_cents: '1500',
  delivery_area: '',
  online_prep_minutes: '15',
  online_pay_later: '1',
  table_ordering: '0',
  tip_pool_enabled: '0', tip_pool_managers: '0',
  booking_deposit_cents: '0', deposit_refund_hours: '24', terminal_location_id: '',
  auto_birthday: '0', auto_birthday_pct: '15', auto_winback: '0', auto_winback_days: '45', auto_winback_pct: '10', auto_welcome: '0', auto_welcome_pct: '10', auto_last_run: '',
  pay_handles_enabled: '0', pay_cashapp: '', pay_venmo: '', pay_paypalme: '', pay_zelle: '', card_provider: 'auto', cash_discount_pct: '0',
  fee_rates: '{"card":[2.6,15],"online":[2.9,30],"venmo":[1.9,10],"cashapp":[2.75,0],"paypal":[3.49,49],"paypalme":[3.49,49],"zelle":[0,0],"cash":[0,0],"gift":[0,0],"other":[0,0]}',
  ot_guard: '0', booking_preorder: '0', preorder_reminder: '1', booking_preorder_pay: '0', auto_join_tables: '0', prep_split_hour: '0', leftover_rollover: '1', vip_arrival_alert: '1', fire_reminders: '0', auto_vip: '0', auto_vip_members: '1', auto_vip_spend_cents: '0', pace_default_minutes: '15', preorder_reminder_hour: '15', delivery_signature_cents: '0', photo_check: 'off', course_gap_minutes: '0', ingredient_86: '1', makegood_minutes: '0', makegood_item_id: '', makegood_pct: '10', batch_radius_km: '2', batch_window_minutes: '15', bar_tabs: '0', area_alerts: '0', area_alert_high: '12', area_alert_quiet_minutes: '30', pass_alert_minutes: '3', slot_capacity: '0', pickup_shelves: '', kds_quick_messages: '["Need 2 more fries","Need hands here","Behind, 5 minutes","Fire the next course","86 coming","Pick up at the pass"]', dish_ratings: '1', schedule_by_area: '0', area_sales_per_hour_cents: '20000', smart_quotes: '0', kitchen_parallel: '4', rush_mode: 'off', rush_busy_tickets: '12', rush_busy_late: '3', rush_pause_tickets: '25', rush_pause_late: '8', rush_extra_minutes: '15', online_paused_until: '', shift_pulse: '1', pulse_anonymous: '1', tipout_at_clockout: '1', curbside: '0', curbside_prompt: '', kds_allergy_check: '0', kds_pacing: '0', declare_tips: '0', break_minutes_planned: '30', punch_geofence: '0', punch_radius_m: '150', biz_lat: '', biz_lng: '', punch_photo: '0', handoff_notes: '1', adp_company_code: '', kds_version: '1', kds_expo: '0', kds_pack: '0', board_version: '1', board_categories: '[]', board_title: '', board_rotate_seconds: '12', board_cols: '3', board_photos: '0', rooms_online: '0', rooms_lead_days: '2', app_punch: '0', clock_version: '1', clock_message: '', catering_followup: '1', required_certs: '[]', fixed_costs: '[]', cash_balance_cents: '0', cash_balance_on: '', payroll_dow: '5', payroll_every: 'weekly',
  pay_bank_enabled: '0', pay_bank_min_cents: '10000', menu_photos: '0', catering_online: '0', catering_lead_hours: '48', catering_deposit_pct: '50', catering_delivery_cents: '0', catering_min_cents: '0', safe_log_enabled: '0', safe_two_person: '1',
  show_calories: '0', loyalty_tiers: '[]', tipout_rules: '[]', table_calls: '1', weekly_report: '1', weekly_report_hour: '8', report_email: '', languages: '["en","es"]', auto_reorder: '0',
  labor_target_pct: '25', labor_alerts: '1', online_schedule: '1', online_schedule_days: '7', booking_duration_minutes: '90', kitchen_stations: '["Kitchen","Bar"]', station_map: '{}', label_shelf_days: '3',
  sales_goals: '[]', table_long_minutes: '90', kitchen_slow_minutes: '20', price_watch_pct: '5', display_version: '1',
  screen_message: '', screen_version: '1', upsell_enabled: '1', prep_buffer_pct: '10',
  referral_enabled: '0', referral_reward_cents: '500', referral_min_cents: '1500',
  recovery_enabled: '1', recovery_max_rating: '2', recovery_kind: 'pct', recovery_value: '20', recovery_days: '30', recovery_message: '',
  chat_enabled: '1', chat_quick: '["Your table is almost ready","We have your order, it will be out soon","Running about 10 minutes behind, sorry!","Come to the host stand please"]',
  business_address: '', business_phone: '', acct_map: '{}',
  kiosk_version: '1', kiosk_reader_id: '', kiosk_message: '',
  ot_weekly_hours: '40', payroll_week_start: '1', ot_alerts: '1', break_after_hours: '6', food_cost_target: '30',
  insights_summary: '1', insights_hour: '22', insights_alerts: '1', insights_void_limit: '3', insights_refund_cents: '10000',
  forecast_city: '', forecast_rain_pct: '-10', staff_sales_per_hour_cents: '15000', staff_min: '1',
};

/* ---------- business-local dates (per location) ---------- */
export const currentTz = () => tzOf.get(current())?.tz || 'America/New_York';
export const localDateOf = (ts) => (ts ? tzOf.get(current()).fmt.format(new Date(`${String(ts).replace(' ', 'T')}Z`)) : null);
export const localToday = () => tzOf.get(current()).fmt.format(new Date());

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export function setSettings(obj) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction((o) => { for (const [k, v] of Object.entries(o)) stmt.run(k, String(v)); });
  tx(obj);
  if (obj.timezone) setTzFor(current(), obj.timezone);
}

/** JWT signing secret: env var, else generated once and persisted in the data dir. */
export function getJwtSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32) return process.env.JWT_SECRET;
  const file = path.join(DATA_DIR, '.jwt_secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

export function audit(user, action, detail, ip) {
  db.prepare('INSERT INTO audit (user_id, user_name, action, detail, ip) VALUES (?, ?, ?, ?, ?)')
    .run(user?.id ?? null, user?.name ?? null, action, detail ? String(detail).slice(0, 500) : null, ip ?? null);
}

export function seedDemoData(businessType) {
  const tableCount = db.prepare('SELECT COUNT(*) c FROM tables').get().c;
  if (!tableCount) {
    const ins = db.prepare('INSERT INTO tables (label, seats, zone) VALUES (?, ?, ?)');
    const layout = [
      ['1', 2, 'Main'], ['2', 2, 'Main'], ['3', 4, 'Main'], ['4', 4, 'Main'], ['5', 4, 'Main'], ['6', 6, 'Main'],
      ['B1', 2, 'Bar'], ['B2', 2, 'Bar'], ['B3', 2, 'Bar'],
      ['P1', 4, 'Patio'], ['P2', 4, 'Patio'], ['P3', 8, 'Patio'],
    ];
    for (const t of layout) ins.run(...t);
  }
  const menuCount = db.prepare('SELECT COUNT(*) c FROM menu_items').get().c;
  if (!menuCount) {
    const ins = db.prepare('INSERT INTO menu_items (name, category, price_cents, color, sort, guest_orderable) VALUES (?, ?, ?, ?, ?, ?)');
    const guestCats = new Set(['Drinks', 'Sides', 'Coffee', 'Tea', 'Bakery']);
    const menus = {
      restaurant: [
        ['Smash Burger', 'Mains', 1450, '#ff6b4a'], ['Chicken Sandwich', 'Mains', 1350, '#ff6b4a'], ['Caesar Salad', 'Mains', 1100, '#3ddc97'],
        ['Fries', 'Sides', 500, '#ffc845'], ['Onion Rings', 'Sides', 600, '#ffc845'], ['Wings (8)', 'Sides', 1200, '#ffc845'],
        ['Soda', 'Drinks', 300, '#4cc9f0'], ['Iced Tea', 'Drinks', 350, '#4cc9f0'], ['Craft Beer', 'Drinks', 800, '#4cc9f0'],
        ['Brownie', 'Dessert', 700, '#c77dff'], ['Milkshake', 'Dessert', 750, '#c77dff'],
      ],
      cafe: [
        ['Espresso', 'Coffee', 325, '#b5835a'], ['Latte', 'Coffee', 525, '#b5835a'], ['Cold Brew', 'Coffee', 495, '#b5835a'],
        ['Matcha', 'Tea', 575, '#3ddc97'], ['Chai', 'Tea', 525, '#3ddc97'],
        ['Croissant', 'Bakery', 425, '#ffc845'], ['Bagel', 'Bakery', 375, '#ffc845'], ['Avocado Toast', 'Food', 1100, '#ff6b4a'],
      ],
      service: [
        ['Basic Service', 'Services', 3500, '#7c5cff'], ['Premium Service', 'Services', 6500, '#7c5cff'],
        ['Consultation', 'Services', 2500, '#4cc9f0'], ['Add-on', 'Extras', 1000, '#ffc845'], ['Product', 'Retail', 1800, '#3ddc97'],
      ],
    };
    const list = menus[businessType] || menus.restaurant;
    list.forEach((m, i) => ins.run(m[0], m[1], m[2], m[3], i, guestCats.has(m[1]) ? 1 : 0));
  }
}

// open the main location now
openDatabase('main');
