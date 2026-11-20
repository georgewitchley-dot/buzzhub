import { useState } from 'react';
import { api, minutesSince, useTick } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';

const STATUS = { open: 'Open', reserved: 'Held for guest', seated: 'Seated', dirty: 'Needs bussing' };

function TableModal({ table, waiting, unit, onClose }) {
  const toast = useToast();
  const [guestId, setGuestId] = useState('');
  const run = async (fn, msg) => { try { await fn(); toast(msg, 'ok'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  const setStatus = (status) => run(() => api(`/staff/tables/${table.id}/status`, { method: 'POST', body: { status } }), `${unit} ${table.label} is ${STATUS[status].toLowerCase()}`);
  const seat = () => run(() => api(`/staff/guests/${guestId}/seat`, { method: 'POST', body: { tableId: table.id } }), `Seated at ${unit} ${table.label}`);
  const buzz = () => run(() => api(`/staff/guests/${guestId}/buzz`, { method: 'POST', body: { tableId: table.id } }), 'Buzzed — table is held for them');
  return (
    <Modal title={`${unit} ${table.label}`} onClose={onClose}>
      <div className="muted">{table.zone}, seats {table.seats}. {STATUS[table.status]}{table.guest_name ? ` — ${table.guest_name}, party of ${table.party_size}` : ''}{table.seated_at ? `, ${minutesSince(table.seated_at)} min` : ''}.</div>
      {(table.status === 'open' || table.status === 'reserved') && waiting.length > 0 && (
        <div className="stack">
          <label className="field"><span>Guest from the waitlist</span>
            <select className="input" value={guestId} onChange={(e) => setGuestId(e.target.value)}>
              <option value="">Choose a guest</option>
              {waiting.map((g) => <option key={g.id} value={g.id}>{g.name}, party of {g.party_size}{g.party_size > table.seats ? ' (too big)' : ''}</option>)}
            </select>
          </label>
          <div className="row"><button className="btn primary grow" disabled={!guestId} onClick={buzz}>Buzz and hold</button><button className="btn grow" disabled={!guestId} onClick={seat}>Seat now</button></div>
        </div>
      )}
      <div className="row wrap">
        {table.status === 'seated' && <button className="btn primary grow" onClick={() => setStatus('dirty')}>Guests left — needs bussing</button>}
        {table.status !== 'open' && <button className="btn grow" onClick={() => setStatus('open')}>Mark open</button>}
        {table.status === 'open' && <button className="btn grow" onClick={() => setStatus('reserved')}>Hold</button>}
      </div>
    </Modal>
  );
}

function AddTable({ onClose }) {
  const toast = useToast();
  const [f, setF] = useState({ label: '', seats: 4, zone: 'Main' });
  const submit = async (e) => { e.preventDefault(); try { await api('/staff/tables', { method: 'POST', body: { ...f, seats: Number(f.seats) } }); onClose(); } catch (e2) { toast(e2.message, 'err'); } };
  return (
    <Modal title="Add a spot" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="row">
          <label className="field grow"><span>Label</span><input className="input" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={10} required /></label>
          <label className="field" style={{ width: 100 }}><span>Seats</span><input className="input" type="number" min={1} max={40} value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} /></label>
        </div>
        <label className="field"><span>Area</span><input className="input" value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })} maxLength={20} /></label>
        <button className="btn primary block">Add</button>
      </form>
    </Modal>
  );
}

export default function Floor() {
  const { settings, can } = useCC();
  const unit = settings.unit_label;
  const [tables] = useLive(['tables'], () => api('/staff/tables'));
  const [guests] = useLive(['guests'], () => api('/staff/guests'));
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  useTick(30000);
  if (!tables) return null;
  const zones = [...new Set(tables.map((t) => t.zone))];
  const waiting = (guests?.active || []).filter((g) => g.kind === 'table');
  const counts = tables.reduce((a, t) => ({ ...a, [t.status]: (a[t.status] || 0) + 1 }), {});

  return (
    <>
      <PageHead title="Floor" sub={`${counts.open || 0} open, ${counts.seated || 0} seated, ${counts.dirty || 0} to bus`}>
        <div className="legend">
          <span style={{ '--c': 'var(--seated)' }}>Open</span><span style={{ '--c': 'var(--reserved)' }}>Held</span>
          <span style={{ '--c': 'var(--accent)' }}>Seated</span><span style={{ '--c': 'var(--dirty)' }}>Bus</span>
        </div>
        {can('manager') && <button className="btn" onClick={() => setAdding(true)}>Add a spot</button>}
      </PageHead>
      <div className="zones">
        {zones.map((z) => (
          <section className="zone" key={z}>
            <h3>{z}</h3>
            <div className="tables">
              {tables.filter((t) => t.zone === z).map((t) => (
                <button key={t.id} className="tbl" data-status={t.status} onClick={() => setOpen(t)} aria-label={`${unit} ${t.label}, ${STATUS[t.status]}`}>
                  <b>{t.label}</b>
                  <span className="s">{t.seats} seats</span>
                  <span className="s" style={{ color: 'var(--text)' }}>
                    {t.status === 'seated' ? `${t.guest_name || 'Walk-in'}, ${minutesSince(t.seated_at)}m` : t.status === 'reserved' ? `Held for ${t.guest_name || 'guest'}` : STATUS[t.status]}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      {open && <TableModal table={open} waiting={waiting} unit={unit} onClose={() => setOpen(null)} />}
      {adding && <AddTable onClose={() => setAdding(false)} />}
    </>
  );
}
