import { useEffect, useState } from 'react';
import { api, money, timeOf } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';

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
  const toggle = (m) => api(`/staff/menu/${m.id}`, { method: 'PUT', body: { active: !m.active } }).catch((e) => toast(e.message, 'err'));
  const del = (m) => confirm(`Delete ${m.name}?`) && api(`/staff/menu/${m.id}`, { method: 'DELETE' }).catch((e) => toast(e.message, 'err'));
  return (
    <>
      <PageHead title="Menu" sub="What shows on the register. Turn items off when you run out."><button className="btn primary" onClick={() => setEdit(null)}>Add an item</button></PageHead>
      <section className="panel"><table className="list">
        <thead><tr><th>Item</th><th>Category</th><th>Price</th><th>On register</th><th /></tr></thead>
        <tbody>{(menu || []).map((m) => (
          <tr key={m.id} style={{ opacity: m.active ? 1 : 0.5 }}>
            <td><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: m.color, marginRight: 10 }} />{m.name}</td>
            <td className="muted">{m.category}</td><td className="num">{money(m.price_cents, settings.currency)}</td>
            <td><button className={`btn sm ${m.active ? '' : 'ghost'}`} onClick={() => toggle(m)}>{m.active ? 'On' : 'Sold out'}</button></td>
            <td style={{ textAlign: 'right' }}><button className="btn sm ghost" onClick={() => setEdit(m)}>Edit</button><button className="btn sm ghost danger" onClick={() => del(m)}>Delete</button></td>
          </tr>
        ))}</tbody>
      </table></section>
      {edit !== undefined && <ItemModal item={edit} currency={settings.currency} onClose={() => setEdit(undefined)} />}
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
            <td style={{ textTransform: 'capitalize' }}>{p.role}</td>
            <td className="muted">{p.last_login_at ? `${new Date(p.last_login_at.replace(' ', 'T') + 'Z').toLocaleDateString()} ${timeOf(p.last_login_at)}` : 'Never'}</td>
            <td style={{ textAlign: 'right' }}>
              <button className="btn sm ghost" onClick={() => setEdit(p)}>Edit</button>
              <button className="btn sm ghost" onClick={() => call(`/staff/users/${p.id}/revoke`, 'POST', undefined, `${p.name} signed out everywhere`)}>Sign out everywhere</button>
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
export function SettingsAdmin() {
  const { settings, reloadSettings } = useCC();
  const toast = useToast();
  const [f, setF] = useState(settings);
  useEffect(() => setF(settings), [settings]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    const keys = ['business_name', 'business_type', 'unit_label', 'accent', 'currency', 'tax_rate', 'avg_turn_minutes', 'idle_lock_minutes', 'self_checkin', 'welcome_message'];
    try { await api('/staff/settings', { method: 'PUT', body: Object.fromEntries(keys.map((k) => [k, f[k]])) }); toast('Settings saved', 'ok'); reloadSettings(); } catch (e2) { toast(e2.message, 'err'); }
  };
  return (
    <>
      <PageHead title="Settings" sub="Make the command center and the guest buzzer fit your business." />
      <form className="grid-2" onSubmit={save}>
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
          <label className="field"><span>Message on the guest's buzzer screen</span><textarea className="input" rows={3} value={f.welcome_message} onChange={set('welcome_message')} maxLength={240} /></label>
        </div></section>
        <section className="panel"><div className="panel-h"><h3>Waitlist and security</h3></div><div className="panel-b stack">
          <label className="field"><span>Average minutes per party in line (used for quoted waits)</span><input className="input" type="number" min={1} max={240} value={f.avg_turn_minutes} onChange={set('avg_turn_minutes')} /></label>
          <label className="field"><span>Guests can add themselves by scanning the door code</span>
            <select className="input" value={f.self_checkin} onChange={set('self_checkin')}><option value="1">Yes</option><option value="0">No, staff only</option></select>
          </label>
          <label className="field"><span>Lock the terminal after this many idle minutes</span><input className="input" type="number" min={1} max={60} value={f.idle_lock_minutes} onChange={set('idle_lock_minutes')} /></label>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>Text message alerts are {settings.sms_enabled ? 'on' : 'off'}. {settings.sms_enabled ? 'Guests with a phone number also get a text when buzzed.' : 'Add Twilio credentials to the server to turn them on.'}</p>
          <button className="btn primary lg block">Save settings</button>
        </div></section>
      </form>
    </>
  );
}

/* ================= Audit / security log ================= */
export function AuditLog() {
  const [rows] = useLive(['guests', 'orders', 'tables', 'menu'], () => api('/staff/audit'));
  const [q, setQ] = useState('');
  const [onlySec, setOnlySec] = useState(false);
  const list = (rows || []).filter((r) => (!onlySec || /^(auth|user|settings|setup)/.test(r.action)) && (!q || `${r.user_name} ${r.action} ${r.detail} ${r.ip}`.toLowerCase().includes(q.toLowerCase())));
  const fails = (rows || []).filter((r) => r.action === 'auth.fail').length;
  return (
    <>
      <PageHead title="Security log" sub={`Every unlock, sale, buzz and change, with who did it and from where. ${fails} wrong PIN attempts recorded.`}>
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
