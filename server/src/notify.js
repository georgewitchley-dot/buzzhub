// Free notification channels: Web Push (browser/phone notifications) and optional email via your own SMTP.
import * as webpush from 'web-push';
import nodemailer from 'nodemailer';
import { db, getVapidKeys, forEachLocation } from './db.js';

const vapid = getVapidKeys(() => webpush.generateVAPIDKeys());
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:alerts@buzzhub.app', vapid.publicKey, vapid.privateKey);
export const VAPID_PUBLIC_KEY = vapid.publicKey;

/* ---------- Web Push ---------- */
/** Save a phone/browser for alerts. Linked to a waitlist visit, a customer account, or both. */
export function saveSubscription({ guestId = null, customerId = null }, sub) {
  const col = customerId ? 'customer_id' : 'guest_id';
  const owner = customerId || guestId;
  const existing = db.prepare(`SELECT id FROM push_subs WHERE ${col} = ? ORDER BY id`).all(owner);
  if (existing.length >= 3) db.prepare('DELETE FROM push_subs WHERE id = ?').run(existing[0].id);
  db.prepare(`INSERT INTO push_subs (guest_id, customer_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET guest_id = COALESCE(excluded.guest_id, guest_id), customer_id = COALESCE(excluded.customer_id, customer_id), p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(guestId, customerId, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
}

async function sendTo(subs, payload) {
  const body = JSON.stringify(payload);
  const seen = new Set();
  const unique = subs.filter((s) => !seen.has(s.endpoint) && seen.add(s.endpoint));
  const results = await Promise.allSettled(unique.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 900, urgency: 'high' })
      .catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subs WHERE id = ?').run(s.id);
        throw err;
      })));
  return { sent: results.filter((r) => r.status === 'fulfilled').length, devices: unique.length };
}

export function devicesForGuest(guestId) {
  const g = db.prepare('SELECT customer_id FROM guests WHERE id = ?').get(guestId);
  return db.prepare('SELECT * FROM push_subs WHERE guest_id = ? OR (customer_id IS NOT NULL AND customer_id = ?)').all(guestId, g?.customer_id ?? -1);
}
export const pushToGuest = (guestId, payload) => sendTo(devicesForGuest(guestId), payload);
export const pushToCustomer = (customerId, payload) => sendTo(db.prepare('SELECT * FROM push_subs WHERE customer_id = ?').all(customerId), payload);

/** Security alerts to staff phones. roles: which roles get it; onlyUser: limit to one person. */
export const pushToUsers = (roles, payload, onlyUser = null) => sendTo(
  db.prepare(`SELECT p.* FROM push_subs p JOIN users u ON u.id = p.user_id WHERE u.active = 1 AND u.role IN (${roles.map(() => '?').join(',')}) ${onlyUser ? 'AND u.id = ?' : ''}`).all(...roles, ...(onlyUser ? [onlyUser] : [])),
  payload,
);

export function forgetGuestDevices(guestId) {
  db.prepare('DELETE FROM push_subs WHERE guest_id = ? AND customer_id IS NULL').run(guestId);
}

// Clean out subscriptions for guests who left more than a day ago.
setInterval(() => forEachLocation(() => {
  db.prepare("DELETE FROM push_subs WHERE customer_id IS NULL AND guest_id IN (SELECT id FROM guests WHERE closed_at IS NOT NULL AND closed_at < datetime('now','-1 day'))").run();
}), 3_600_000).unref();

/* ---------- Email (optional, uses the business's own mailbox, e.g. a free Gmail app password) ---------- */
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
const mailer = SMTP_HOST && SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({ host: SMTP_HOST, port: Number(SMTP_PORT || 587), secure: Number(SMTP_PORT) === 465, auth: { user: SMTP_USER, pass: SMTP_PASS } })
  : null;
export const emailEnabled = () => Boolean(mailer);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function emailGuest(to, { businessName, subject, message, link, accent = '#ffb020' }) {
  if (!mailer || !to) return { ok: false };
  await mailer.sendMail({
    from: SMTP_FROM || `"${businessName.replace(/"/g, '')}" <${SMTP_USER}>`,
    to,
    subject: `${businessName}: ${subject}`,
    text: `${message}\n\nOpen your buzzer: ${link}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px">
      <h2 style="margin:0 0 8px">${esc(subject)}</h2><p style="font-size:16px;color:#333">${esc(message)}</p>
      <p><a href="${esc(link)}" style="display:inline-block;background:${esc(accent)};color:#1a1406;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:700">Open my buzzer</a></p>
      <p style="color:#888;font-size:12px">${esc(businessName)}</p></div>`,
  });
  return { ok: true };
}
