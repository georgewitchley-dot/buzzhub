// Batch 4: drag-and-drop floor plan + server assignment, and pay-by-phone with Stripe Checkout.
import { z } from 'zod';
import { db, audit, registerSchema } from './db.js';

registerSchema((db) => {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const t = cols('tables');
  for (const [c, def] of [['x', 'REAL'], ['y', 'REAL'], ['w', 'REAL'], ['h', 'REAL'], ['shape', "TEXT NOT NULL DEFAULT 'square'"], ['server_id', 'INTEGER']]) if (!t.includes(c)) db.exec(`ALTER TABLE tables ADD COLUMN ${c} ${def}`);
});

export function registerFloorPay({ app, staff, io, h }) {
  const { wrap, parse, idParam, now, clientIp, requireAuth, notifyStaff, publicLimiter, publicBase } = h;

  /* ================= Floor plan ================= */
  const box = z.object({ id: z.number().int(), x: z.number().min(0).max(100), y: z.number().min(0).max(100), w: z.number().min(3).max(60), h: z.number().min(3).max(60), shape: z.enum(['square', 'round', 'bar']) });
  staff.put('/tables/layout', requireAuth('manager'), (req, res) => {
    const list = parse(z.array(box).max(300), req.body);
    const up = db.prepare('UPDATE tables SET x=?, y=?, w=?, h=?, shape=? WHERE id=?');
    db.transaction(() => { for (const t of list) up.run(t.x, t.y, t.w, t.h, t.shape, t.id); })();
    audit(req.user, 'floor.layout', `${list.length} tables`, clientIp(req));
    notifyStaff('tables'); res.json({ ok: true });
  });
  staff.put('/tables/:id', requireAuth('manager'), (req, res) => {
    const b = parse(z.object({ label: z.string().trim().min(1).max(10), seats: z.number().int().min(1).max(40), zone: z.string().trim().min(1).max(20) }).partial(), req.body);
    const t = db.prepare('SELECT * FROM tables WHERE id = ?').get(idParam(req)); if (!t) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE tables SET label=?, seats=?, zone=? WHERE id=?').run(b.label ?? t.label, b.seats ?? t.seats, b.zone ?? t.zone, t.id);
    notifyStaff('tables'); res.json({ ok: true });
  });
  staff.post('/tables/:id/server', (req, res) => {
    const { userId } = parse(z.object({ userId: z.number().int().nullable() }), req.body);
    if (userId && !db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(userId)) return res.status(404).json({ error: 'Unknown team member' });
    db.prepare('UPDATE tables SET server_id = ? WHERE id = ?').run(userId, idParam(req));
    notifyStaff('tables'); res.json({ ok: true });
  });
  staff.get('/team', (req, res) => res.json(db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all()));


}
