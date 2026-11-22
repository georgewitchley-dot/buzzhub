import { useEffect, useState } from 'react';
import { api, imageToPng, logoUrl, money, timeOf } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { PrintSign } from './PrintSign.jsx';
import { OnlinePanel, OptionsAdmin } from './Commerce.jsx';
import { TeamPanel } from './Team.jsx';
import { MenuDetails } from './Reach.jsx';
import { GrowPanel, MenuSync } from './House.jsx';
import { FloorPanel, RecipeCard } from './Plus.jsx';
import { OwnerPanel } from './Owner.jsx';
import { SmartPanel } from './Smart.jsx';
import { KioskPanel, MorePanel, PaymentsSetup, ReadersPanel } from './Field.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { DeskPanel } from './Desk.jsx';
import { MenuBoardPanel } from './Areas.jsx';
import { CrewPanel } from './Crew.jsx';
import { PacePanel } from './Pace.jsx';
import { LinePanel } from './Line.jsx';
import { PassPanel } from './Pass.jsx';
import { RunPanel } from './Run.jsx';

/* ================= Menu ================= */
function ItemModal({ item, onClose, currency }) {
  const toast = useToast();
  const [f, setF] = useState(item ? { ...item, price: (item.price_cents / 100).toFixed(2) } : { name: '', category: '', price: '', color: '#ffb020' });
  const save = async (e) => {
    e.preventDefault();
    const body = { name: f.name, category: f.category, price_cents: Math.round(Number(f.price) * 100), color: f.color };
    try { await api(item ? `/staff/menu/${item.id}` : '/staff/menu', { method: item ? 'PUT' : 'POST', body }); onClose(); } catch (e2) { toast(e2.message, 'err'); }
  };
  return (
    <Modal title={item ? `Edit ${item.name}` : 'Add an item'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} required /></label>
        <div className="row">
          <label className="field grow"><span>Category</span><input className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} maxLength={24} required /></label>
          <label className="field" style={{ width: 120 }}><span>Price ({currency})</span><input className="input" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/[^\d.]/g, '') })} required /></label>
          <label className="field" style={{ width: 70 }}><span>Color</span><input className="input" type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} style={{ padding: 4 }} /></label>
        </div>
        <button className="btn primary block">{item ? 'Save changes' : 'Add item'}</button>
      </form>
    </Modal>
  );
}

export function MenuAdmin() {
  const { settings } = useCC();
  const toast = useToast();
  const [menu] = useLive(['menu'], () => api('/staff/menu'));
  const [edit, setEdit] = useState(undefined);
  const [card, setCard] = useState(null);
  const toggle = (m) => api(`/staff/menu/${m.id}`, { method: 'PUT', body: { active: !m.active } }).catch((e) => toast(e.message, 'err'));
  const toggleAhead = (m) => api(`/staff/menu/${m.id}`, { method: 'PUT', body: { guest_orderable: !m.guest_orderable } }).catch((e) => toast(e.message, 'err'));
  const del = (m) => confirm(`Delete ${m.name}?`) && api(`/staff/menu/${m.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <PageHead title="Menu" sub="What shows on the register. Items set to order ahead show on the guest's phone while they wait."><MenuSync /><button className="btn primary" onClick={() => setEdit(null)}>Add an item</button></PageHead>
      <section className="panel"><table className="list">
        <thead><tr><th>Item</th><th>Category</th><th>Price</th><th>On register</th><th>Guests can order ahead</th><th /></tr></thead>
        <tbody>{(menu || []).map((m) => (
          <tr key={m.id} style={{ opacity: m.active ? 1 : 0.5 }}>
            <td><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: m.color, marginRight: 10 }} />{m.name}</td>
            <td className="muted">{m.category}</td><td className="num">{money(m.price_cents, settings.currency)}</td>
            <td><button className={`btn sm ${m.active ? '' : 'ghost'}`} onClick={() => toggle(m)}>{m.active ? 'On' : 'Sold out'}</button></td>
            <td><button className={`btn sm ${m.guest_orderable ? 'primary' : 'ghost'}`} onClick={() => toggleAhead(m)} aria-pressed={Boolean(m.guest_orderable)}>{m.guest_orderable ? 'Yes' : 'No'}</button></td>
            <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setCard(m.id)}>Recipe card</button><button className="btn sm ghost" onClick={() => setEdit(m)}>Edit</button><button className="btn sm ghost danger" onClick={() => del(m)}>Delete</button></td>
          </tr>
        ))}</tbody>
      </table></section>
      <OptionsAdmin />
      <MenuDetails />
      {edit !== undefined && <ItemModal item={edit} currency={settings.currency} onClose={() => setEdit(undefined)} />}
      {card && <RecipeCard itemId={card} onClose={() => setCard(null)} />}
    </>
  );
}

/* ================= Staff ================= */
function StaffModal({ person, onClose, myRole }) {
  const toast = useToast();
  const [f, setF] = useState({ name: person?.name || '', role: person?.role || 'staff', pin: '' });
  const save = async (e) => {
    e.preventDefault();
    try {
      if (person) {
        const body = { name: f.name };
        if (f.pin) body.pin = f.pin;
        if (myRole === 'owner' && f.role !== person.role) body.role = f.role;
        await api(`/staff/users/${person.id}`, { method: 'PUT', body });
        toast(f.pin ? `${f.name}'s PIN was reset and their sessions were signed out` : 'Saved', 'ok');
      } else { await api('/staff/users', { method: 'POST', body: f }); toast(`${f.name} can now unlock with their PIN`, 'ok'); }
      onClose();
    } catch (e2) { toast(e2.message, 'err'); }
  };
  return (
    <Modal title={person ? `Edit ${person.name}` : 'Add a team member'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={40} required /></label>
        <label className="field"><span>Role</span>
          <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} disabled={person && myRole !== 'owner'}>
            <option value="staff">Staff: waitlist, floor, register, orders</option>
            <option value="manager">Manager: also menu, staff, settings, voids, big discounts</option>
            {myRole === 'owner' && <option value="owner">Owner: everything, including roles</option>}
          </select>
        </label>
        <label className="field"><span>{person ? 'New PIN (leave blank to keep the current one)' : 'PIN (4–8 digits, unique to this person)'}</span>
          <input className="input" type="password" inputMode="numeric" pattern="\d{4,8}" value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} required={!person} autoComplete="new-password" />
        </label>
        <button className="btn primary block">{person ? 'Save changes' : 'Add team member'}</button>
      </form>
    </Modal>
  );
}

export function StaffAdmin() {
  const { user } = useCC();
  const toast = useToast();
  const [people, reload] = useLive([], () => api('/staff/users'));
  const [edit, setEdit] = useState(undefined);
  const call = async (path, method, body, msg) => { try { await api(path, { method, body }); toast(msg, 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <>
      <PageHead title="Staff" sub="Everyone signs in with their own PIN, so every action in the security log has a name on it."><button className="btn primary" onClick={() => setEdit(null)}>Add a team member</button></PageHead>
      <section className="panel"><table className="list">
        <thead><tr><th>Name</th><th>Role</th><th>Last unlock</th><th /></tr></thead>
        <tbody>{(people || []).map((p) => (
          <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
            <td>{p.name}{p.id === user.id && <span className="chip" style={{ marginLeft: 8 }}>You</span>}</td>
            <td style={{ textTransform: 'capitalize' }}>{p.role}{p.totp_enabled ? <span className="chip teal" style={{ marginLeft: 8, textTransform: 'none' }}>Two-step</span> : null}
              <button className={`chip ${p.is_driver ? 'blue' : ''}`} style={{ marginLeft: 8, textTransform: 'none', cursor: 'pointer', border: 0 }} onClick={() => api(`/staff/users/${p.id}/driver`, { method: 'PUT', body: { driver: !p.is_driver } }).then(reload)} title="Drivers see their deliveries and share their location while delivering">{p.is_driver ? 'Driver' : 'Not a driver'}</button></td>
            <td className="muted">{p.last_login_at ? `${new Date(p.last_login_at.replace(' ', 'T') + 'Z').toLocaleDateString()} ${timeOf(p.last_login_at)}` : 'Never'}</td>
            <td style={{ textAlign: 'right' }}>
              <button className="btn sm ghost" onClick={() => setEdit(p)}>Edit</button>
              <button className="btn sm ghost" onClick={() => call(`/staff/users/${p.id}/revoke`, 'POST', undefined, `${p.name} signed out everywhere`)}>Sign out everywhere</button>
              {user.role === 'owner' && p.totp_enabled ? <button className="btn sm ghost" onClick={() => confirm(`Reset ${p.name}'s two-step sign-in? They'll set it up again.`) && call(`/staff/users/${p.id}/reset-2fa`, 'POST', undefined, `${p.name}'s two-step sign-in was reset`)}>Reset two-step</button> : null}
              {p.id !== user.id && <button className="btn sm ghost danger" onClick={() => call(`/staff/users/${p.id}`, 'PUT', { active: !p.active }, p.active ? `${p.name} disabled` : `${p.name} enabled`)}>{p.active ? 'Disable' : 'Enable'}</button>}
            </td>
          </tr>
        ))}</tbody>
      </table></section>
      {edit !== undefined && <StaffModal person={edit} myRole={user.role} onClose={() => { setEdit(undefined); reload(); }} />}
    </>
  );
}

/* ================= Settings ================= */
const PRESETS = {
  restaurant: { unit_label: 'Table' }, cafe: { unit_label: 'Order' }, service: { unit_label: 'Appointment' },
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Puerto_Rico', 'Europe/London', 'Europe/Paris', 'Australia/Sydney'];

function LogoBox({ settings, onChange }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try { const dataUrl = await imageToPng(file); await api('/staff/logo', { method: 'PUT', body: { dataUrl } }); toast('Logo saved', 'ok'); onChange(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const remove = async () => { await api('/staff/logo', { method: 'DELETE' }); onChange(); };
  const has = settings.logo_version && settings.logo_version !== '0';
  return (
    <div className="row" style={{ alignItems: 'center' }}>
      <div className="logo-box">{has ? <img src={logoUrl(settings.logo_version)} alt="Your logo" /> : <span className="dim">No logo</span>}</div>
      <div className="stack grow" style={{ gap: 8 }}>
        <label className="btn" style={{ cursor: 'pointer' }}>{busy ? 'Uploading…' : has ? 'Replace logo' : 'Upload logo'}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr" onChange={(e) => upload(e.target.files?.[0])} disabled={busy} />
        </label>
        {has && <button type="button" className="btn ghost sm" onClick={remove}>Remove</button>}
        <span className="dim" style={{ fontSize: 12.5 }}>PNG, JPG or WebP. A square logo looks best in the QR code.</span>
      </div>
    </div>
  );
}

function PaymentsPanel() {
  const [p] = useLive([], () => api('/staff/payments/status'));
  if (!p) return null;
  return (
    <section className="panel"><div className="panel-h"><h3 className="grow">Card payments by phone</h3><span className={`chip ${p.cardsEnabled ? 'teal' : ''}`}>{p.cardsEnabled ? (p.mode === 'live' ? 'Live' : 'Test mode') : 'Not connected'}</span></div><div className="panel-b stack">
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>Guests scan a code (or get their check on their phone), add a tip and pay with card, Apple Pay or Google Pay. Money goes straight to your Stripe account and the order closes itself.</p>
      {p.cardsEnabled ? (
        <span className="muted" style={{ fontSize: 14 }}>{p.webhook ? 'Payments are confirmed instantly, even if a guest closes the page.' : 'Payments are confirmed when the guest returns from checkout. For extra safety, add a webhook in Stripe pointing to the address below and set STRIPE_WEBHOOK_SECRET.'}</span>
      ) : (
        <ol className="steps"><li>Create a free Stripe account at stripe.com (they charge per payment, nothing monthly).</li><li>Copy your secret key from Stripe → Developers → API keys.</li><li>Add it to the server as STRIPE_SECRET_KEY. Ask me to do this and I'll set it on Railway.</li></ol>
      )}
      <label className="field"><span>Webhook address for Stripe</span><input className="input" readOnly value={p.webhookUrl} onFocus={(e) => e.target.select()} /></label>
    </div></section>
  );
}

export function SettingsAdmin() {
  const { settings, reloadSettings } = useCC();
  const toast = useToast();
  const [f, setF] = useState(settings);
  const [printing, setPrinting] = useState(false);
  useEffect(() => setF(settings), [settings]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const flag = (k) => (e) => setF({ ...f, [k]: e.target.checked ? '1' : '0' });
  const save = async (e) => {
    e?.preventDefault();
    const keys = ['business_name', 'business_type', 'unit_label', 'accent', 'currency', 'tax_rate', 'avg_turn_minutes', 'idle_lock_minutes', 'self_checkin', 'welcome_message',
      'preorder_enabled', 'preorder_open_minutes', 'heads_up_minutes', 'sign_headline', 'timezone',
      'online_enabled', 'online_pickup', 'online_delivery', 'delivery_fee_cents', 'delivery_min_cents', 'delivery_area', 'online_prep_minutes', 'online_pay_later', 'table_ordering',
      'tip_pool_enabled', 'tip_pool_managers', 'forecast_city', 'forecast_rain_pct', 'staff_sales_per_hour_cents', 'staff_min',
      'booking_deposit_cents', 'deposit_refund_hours', 'ot_weekly_hours', 'payroll_week_start', 'ot_alerts', 'break_after_hours', 'food_cost_target', 'insights_summary', 'insights_hour', 'insights_alerts', 'insights_void_limit', 'insights_refund_cents', 'kiosk_reader_id', 'kiosk_message', 'chat_enabled', 'chat_quick', 'table_long_minutes', 'kitchen_slow_minutes', 'price_watch_pct', 'labor_target_pct', 'labor_alerts', 'clock_message', 'app_punch', 'course_gap_minutes', 'ingredient_86', 'makegood_minutes', 'makegood_item_id', 'makegood_pct', 'batch_radius_km', 'batch_window_minutes', 'bar_tabs', 'area_alerts', 'area_alert_high', 'area_alert_quiet_minutes', 'pass_alert_minutes', 'slot_capacity', 'pickup_shelves', 'kds_quick_messages', 'dish_ratings', 'schedule_by_area', 'area_sales_per_hour_cents', 'smart_quotes', 'kitchen_parallel', 'rush_mode', 'rush_busy_tickets', 'rush_busy_late', 'rush_pause_tickets', 'rush_pause_late', 'rush_extra_minutes', 'shift_pulse', 'pulse_anonymous', 'tipout_at_clockout', 'curbside', 'curbside_prompt', 'declare_tips', 'break_minutes_planned', 'ot_guard', 'punch_geofence', 'punch_radius_m', 'biz_lat', 'biz_lng', 'punch_photo', 'handoff_notes', 'adp_company_code', 'rooms_online', 'rooms_lead_days', 'board_categories', 'board_title', 'board_rotate_seconds', 'board_cols', 'board_photos', 'catering_followup', 'pay_bank_enabled', 'pay_bank_min_cents', 'menu_photos', 'catering_online', 'catering_lead_hours', 'catering_deposit_pct', 'catering_delivery_cents', 'catering_min_cents', 'safe_log_enabled', 'safe_two_person', 'languages', 'loyalty_tiers', 'table_calls', 'auto_reorder', 'weekly_report', 'weekly_report_hour', 'report_email', 'online_schedule', 'online_schedule_days', 'booking_duration_minutes', 'label_shelf_days', 'screen_message', 'upsell_enabled', 'prep_buffer_pct', 'referral_enabled', 'referral_reward_cents', 'referral_min_cents', 'recovery_enabled', 'recovery_max_rating', 'recovery_kind', 'recovery_value', 'recovery_days', 'recovery_message', 'pay_handles_enabled', 'pay_cashapp', 'pay_venmo', 'pay_paypalme', 'pay_zelle', 'card_provider', 'cash_discount_pct', 'fee_rates',
      'smart_waits', 'loyalty_enabled', 'loyalty_visits', 'loyalty_reward', 'feedback_enabled', 'feedback_delay_minutes', 'feedback_review_threshold', 'review_url',
      'booking_enabled', 'booking_open', 'booking_close', 'booking_days', 'booking_slot_minutes', 'booking_capacity', 'booking_days_ahead', 'booking_reminder_minutes'];
    try { await api('/staff/settings', { method: 'PUT', body: Object.fromEntries(keys.map((k) => [k, f[k]])) }); toast('Settings saved', 'ok'); reloadSettings(); } catch (e2) { toast(e2.message, 'err'); }
  };
  const toggleDay = (i) => setF({ ...f, booking_days: f.booking_days.split('').map((c, j) => (j === i ? (c === '1' ? '0' : '1') : c)).join('') });

  return (
    <>
      <PageHead title="Settings" sub="Make the command center and the guest's phone fit your business.">
        <button className="btn" onClick={() => setPrinting(true)}><Icon name="print" size={17} />Print door sign</button>
        <button className="btn primary" onClick={save}>Save settings</button>
      </PageHead>
      <form className="settings-grid" onSubmit={save}>
        <section className="panel"><div className="panel-h"><h3>Business</h3></div><div className="panel-b stack">
          <label className="field"><span>Name guests see</span><input className="input" value={f.business_name} onChange={set('business_name')} maxLength={60} /></label>
          <div className="row">
            <label className="field grow"><span>Kind of business</span>
              <select className="input" value={f.business_type} onChange={(e) => setF({ ...f, business_type: e.target.value, ...PRESETS[e.target.value] })}>
                <option value="restaurant">Restaurant or bar</option><option value="cafe">Café or counter</option><option value="service">Salon, clinic, shop</option>
              </select>
            </label>
            <label className="field grow"><span>What you call a spot</span><input className="input" value={f.unit_label} onChange={set('unit_label')} maxLength={20} /></label>
          </div>
          <div className="row">
            <label className="field"><span>Brand color</span><input className="input" type="color" value={f.accent} onChange={set('accent')} style={{ width: 80, padding: 4 }} /></label>
            <label className="field grow"><span>Currency</span><input className="input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase().slice(0, 3) })} /></label>
            <label className="field grow"><span>Sales tax %</span><input className="input" inputMode="decimal" value={f.tax_rate} onChange={set('tax_rate')} /></label>
          </div>
          <label className="field"><span>Time zone</span>
            <select className="input" value={f.timezone} onChange={set('timezone')}>{[...new Set([f.timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z.replace('_', ' ')}</option>)}</select>
          </label>
        </div></section>

        <section className="panel"><div className="panel-h"><h3>Logo and door sign</h3></div><div className="panel-b stack">
          <LogoBox settings={settings} onChange={reloadSettings} />
          <label className="field"><span>Headline on the printed sign</span><input className="input" value={f.sign_headline} onChange={set('sign_headline')} maxLength={60} /></label>
          <label className="field"><span>Message on the guest's phone after they join</span><textarea className="input" rows={2} value={f.welcome_message} onChange={set('welcome_message')} maxLength={240} /></label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.self_checkin === '1'} onChange={flag('self_checkin')} /> Guests can join the line by scanning the door sign</label>
          <button type="button" className="btn block" onClick={() => setPrinting(true)}><Icon name="print" size={17} />Preview and print the sign</button>
        </div></section>

        <section className="panel"><div className="panel-h"><h3>Waitlist and ordering ahead</h3></div><div className="panel-b stack">
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.smart_waits === '1'} onChange={flag('smart_waits')} /> Learn wait times from real seating data (uses the number below until there's enough history)</label>
          <label className="field"><span>Average minutes per party in line (for quoted waits)</span><input className="input" type="number" min={1} max={240} value={f.avg_turn_minutes} onChange={set('avg_turn_minutes')} /></label>
          <label className="field"><span>Send an "almost ready" alert when the wait is this many minutes or less</span><input className="input" type="number" min={0} max={240} value={f.heads_up_minutes} onChange={set('heads_up_minutes')} /><span className="dim" style={{ fontSize: 12.5 }}>0 turns it off. You can always send it by hand from the waitlist.</span></label>
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.preorder_enabled === '1'} onChange={flag('preorder_enabled')} /> Let waiting guests order ahead from their phone</label>
          {f.preorder_enabled === '1' && (
            <label className="field"><span>Open ordering when the wait is this many minutes or less</span><input className="input" type="number" min={0} max={240} value={f.preorder_open_minutes} onChange={set('preorder_open_minutes')} /><span className="dim" style={{ fontSize: 12.5 }}>Orders wait until you call the party, then go to the bar or kitchen. Choose which items in Menu.</span></label>
          )}
        </div></section>

        <section className="panel"><div className="panel-h"><h3>Online booking</h3></div><div className="panel-b stack">
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.booking_enabled === '1'} onChange={flag('booking_enabled')} /> Customers can book a time from their account</label>
          {f.booking_enabled === '1' && (
            <>
              <div className="field"><span>Open days</span><div className="row wrap">{DAYS.map((d, i) => <button type="button" key={d} className={`btn sm ${f.booking_days[i] === '1' ? 'primary' : ''}`} onClick={() => toggleDay(i)} aria-pressed={f.booking_days[i] === '1'}>{d}</button>)}</div></div>
              <div className="row">
                <label className="field grow"><span>First booking</span><input className="input" type="time" value={f.booking_open} onChange={set('booking_open')} /></label>
                <label className="field grow"><span>Closing time</span><input className="input" type="time" value={f.booking_close} onChange={set('booking_close')} /></label>
              </div>
              <div className="row">
                <label className="field grow"><span>Minutes per booking</span><input className="input" type="number" min={5} max={480} value={f.booking_slot_minutes} onChange={set('booking_slot_minutes')} /></label>
                <label className="field grow"><span>Bookings at the same time</span><input className="input" type="number" min={1} max={50} value={f.booking_capacity} onChange={set('booking_capacity')} /></label>
              </div>
              <div className="row">
                <label className="field grow"><span>Days ahead customers can book</span><input className="input" type="number" min={1} max={120} value={f.booking_days_ahead} onChange={set('booking_days_ahead')} /></label>
                <label className="field grow"><span>Remind them this many minutes before</span><input className="input" type="number" min={0} max={1440} value={f.booking_reminder_minutes} onChange={set('booking_reminder_minutes')} /></label>
              </div>
              <span className="dim" style={{ fontSize: 12.5 }}>"Bookings at the same time" is how many chairs, rooms or tables you can give out per time slot.</span>
            </>
          )}
        </div></section>

        <section className="panel"><div className="panel-h"><h3>Loyalty and feedback</h3></div><div className="panel-b stack">
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.loyalty_enabled === '1'} onChange={flag('loyalty_enabled')} /> Reward customers with accounts for repeat visits</label>
          {f.loyalty_enabled === '1' && (
            <div className="row">
              <label className="field" style={{ width: 120 }}><span>Every</span><input className="input" type="number" min={2} max={50} value={f.loyalty_visits} onChange={set('loyalty_visits')} /></label>
              <label className="field grow"><span>visits, they get</span><input className="input" value={f.loyalty_reward} onChange={set('loyalty_reward')} maxLength={60} /></label>
            </div>
          )}
          <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.feedback_enabled === '1'} onChange={flag('feedback_enabled')} /> Ask guests how it went after their visit</label>
          {f.feedback_enabled === '1' && (
            <>
              <label className="field"><span>Send the question this many minutes after seating</span><input className="input" type="number" min={5} max={1440} value={f.feedback_delay_minutes} onChange={set('feedback_delay_minutes')} /></label>
              <label className="field"><span>Your Google or Yelp review link</span><input className="input" type="url" value={f.review_url} onChange={set('review_url')} placeholder="https://g.page/r/…/review" /></label>
              <label className="field"><span>Point guests to the review link when they rate at least</span>
                <select className="input" value={f.feedback_review_threshold} onChange={set('feedback_review_threshold')}><option value="5">5 stars</option><option value="4">4 stars</option><option value="3">3 stars</option></select>
              </label>
              <span className="dim" style={{ fontSize: 12.5 }}>Lower ratings stay private, and 1–2 stars send an alert to managers.</span>
            </>
          )}
        </div></section>

        <OnlinePanel f={f} setF={setF} />

        <TeamPanel f={f} setF={setF} />

        <PaymentsSetup f={f} setF={setF} />

        <MorePanel f={f} setF={setF} />

        <ReadersPanel f={f} setF={setF} />

        <KioskPanel f={f} setF={setF} />

        <GrowPanel f={f} setF={setF} />

        <FloorPanel f={f} setF={setF} />

        <OwnerPanel f={f} setF={setF} />

        <SmartPanel f={f} setF={setF} />

        <DeskPanel f={f} setF={setF} />

        <CrewPanel f={f} setF={setF} />

        <PacePanel f={f} setF={setF} />

        <LinePanel f={f} setF={setF} />

        <PassPanel f={f} setF={setF} />

        <RunPanel f={f} setF={setF} />

        <MenuBoardPanel f={f} setF={setF} />

        <PaymentsPanel />

        <section className="panel"><div className="panel-h"><h3>Security and alerts</h3></div><div className="panel-b stack">
          <label className="field"><span>Lock the terminal after this many idle minutes</span><input className="input" type="number" min={1} max={60} value={f.idle_lock_minutes} onChange={set('idle_lock_minutes')} /></label>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>Phone notifications are built in and free. Guests allow them once on their phone.</p>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>Email alerts are {settings.email_enabled ? 'on' : 'off'}. {settings.email_enabled ? '' : 'To turn them on for free, add your own mailbox (for example a Gmail app password) to the server settings.'}</p>
          <button className="btn primary lg block">Save settings</button>
        </div></section>
      </form>
      {printing && <PrintSign settings={{ ...settings, sign_headline: f.sign_headline }} onClose={() => setPrinting(false)} />}
    </>
  );
}

/* ================= Audit / security log ================= */
export function AuditLog({ embedded }) {
  const [rows] = useLive(['guests', 'orders', 'tables', 'menu'], () => api('/staff/audit'));
  const [q, setQ] = useState('');
  const [onlySec, setOnlySec] = useState(false);
  const list = (rows || []).filter((r) => (!onlySec || /^(auth|user|settings|setup)/.test(r.action)) && (!q || `${r.user_name} ${r.action} ${r.detail} ${r.ip}`.toLowerCase().includes(q.toLowerCase())));
  const fails = (rows || []).filter((r) => r.action === 'auth.fail').length;
  return (
    <>
      <PageHead title={embedded ? 'Activity log' : 'Security log'} sub={`Every unlock, sale, buzz and change, with who did it and from where. ${fails} wrong PIN attempts recorded.`}>
        <div className="seg"><button aria-pressed={!onlySec} onClick={() => setOnlySec(false)}>Everything</button><button aria-pressed={onlySec} onClick={() => setOnlySec(true)}>Sign-ins and access</button></div>
        <input className="input" style={{ width: 220 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search log" />
      </PageHead>
      <section className="panel"><table className="list">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>Address</th></tr></thead>
        <tbody>{list.map((r) => (
          <tr key={r.id}>
            <td className="muted num" style={{ whiteSpace: 'nowrap' }}>{new Date(r.ts.replace(' ', 'T') + 'Z').toLocaleDateString([], { month: 'short', day: 'numeric' })} {timeOf(r.ts)}</td>
            <td>{r.user_name || <span className="dim">Guest or unknown</span>}</td>
            <td><span className={`chip ${r.action === 'auth.fail' ? 'rose' : r.action.startsWith('auth') ? 'blue' : ''}`}>{r.action}</span></td>
            <td className="muted">{r.detail}</td><td className="dim num">{r.ip}</td>
          </tr>
        ))}</tbody>
      </table></section>
    </>
  );
}
