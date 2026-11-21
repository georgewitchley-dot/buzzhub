import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'buzzhub.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
};

/* ---------- business-local dates inside SQL: localdate(ts) / localtoday() ---------- */
let TZ = 'America/New_York';
const dayFmt = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
let fmt = dayFmt();
export const currentTz = () => TZ;
export const localDateOf = (ts) => (ts ? fmt.format(new Date(`${String(ts).replace(' ', 'T')}Z`)) : null);
export const localToday = () => fmt.format(new Date());
db.function('localdate', { deterministic: false }, (ts) => localDateOf(ts));
db.function('localtoday', { deterministic: false }, () => localToday());
function setTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); TZ = tz; fmt = dayFmt(); } catch { /* keep old */ } }

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
  if (obj.timezone) setTz(obj.timezone);
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

setTz(getSettings().timezone);
