import { useEffect, useMemo, useRef, useState } from 'react';
import { api, minutesSince, useTick } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { TableQrModal } from './Commerce.jsx';
import { SplitModal } from './Register.jsx';
import { NextUp } from './Desk.jsx';
import { RoomsToday } from './Crew.jsx';
import { FloorTimeline } from './Table.jsx';

let LONG = 90;
const isLong = (t) => t.status === 'seated' && t.seated_at && LONG > 0 && minutesSince(t.seated_at) >= LONG;

const STATUS = { open: 'Open', reserved: 'Held for guest', seated: 'Seated', dirty: 'Needs bussing' };
const initials = (n) => (n || '').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function TableModal({ table, waiting, unit, team, onClose }) {
  const toast = useToast();
  const { settings } = useCC();
  const [qr, setQr] = useState(false);
  const [split, setSplit] = useState(false);
  const [guestId, setGuestId] = useState('');
  const run = async (fn, msg) => { try { await fn(); toast(msg, 'ok'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  const setStatus = (status) => run(() => api(`/staff/tables/${table.id}/status`, { method: 'POST', body: { status } }), `${unit} ${table.label} is ${STATUS[status].toLowerCase()}`);
  const seat = () => run(() => api(`/staff/guests/${guestId}/seat`, { method: 'POST', body: { tableId: table.id } }), `Seated at ${unit} ${table.label}`);
  const buzz = () => run(() => api(`/staff/guests/${guestId}/buzz`, { method: 'POST', body: { tableId: table.id } }), 'Buzzed. The table is held for them.');
  if (qr) return <TableQrModal table={table} settings={settings} onClose={() => setQr(false)} />;
  if (split) return <SplitModal tableId={table.id} currency={settings.currency} onClose={onClose} />;
  const assign = (v) => api(`/staff/tables/${table.id}/server`, { method: 'POST', body: { userId: v ? Number(v) : null } }).then(() => toast(v ? 'Server assigned' : 'Server removed', 'ok')).catch((e) => toast(e.message, 'err'));
  return (
    <Modal title={`${unit} ${table.label}`} onClose={onClose}>
      <div className="muted">{table.zone}, seats {table.seats}. {STATUS[table.status]}{table.guest_name ? `, ${table.guest_name}, party of ${table.party_size}` : ''}{table.seated_at ? `, ${minutesSince(table.seated_at)} min` : ''}.</div>
      <label className="field"><span>Server</span>
        <select className="input" defaultValue={table.server_id || ''} onChange={(e) => assign(e.target.value)}>
          <option value="">Nobody</option>{team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </label>
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
        {table.status === 'seated' && <button className="btn primary grow" onClick={() => setStatus('dirty')}>Guests left, needs bussing</button>}
        {table.status !== 'open' && <button className="btn grow" onClick={() => setStatus('open')}>Mark open</button>}
        {table.status === 'open' && <button className="btn grow" onClick={() => setStatus('reserved')}>Hold</button>}
      </div>
      <div className="row wrap">
        {table.status === 'seated' && <button className="btn grow" onClick={() => setSplit(true)}>Check and split</button>}
        <button className="btn grow" onClick={() => setQr(true)}>Table QR code</button>
      </div>
    </Modal>
  );
}

/* ---------- map of the room; drag to arrange in edit mode ---------- */
function autoPlace(list) {
  const byZone = {};
  return list.map((t) => {
    if (t.x != null) return t;
    const i = (byZone[t.zone] = (byZone[t.zone] ?? -1) + 1);
    const col = i % 6; const row = Math.floor(i / 6);
    const big = t.seats >= 6;
    return { ...t, x: 5 + col * 15.5, y: 8 + row * 24, w: big ? 13 : 10, h: big ? 15 : 13, shape: t.zone === 'Bar' ? 'round' : t.shape || 'square' };
  });
}

function FloorMap({ tables, zone, editing, onOpen, onChange, selected, setSelected }) {
  const ref = useRef(null);
  const drag = useRef(null);
  const items = tables.filter((t) => t.zone === zone);
  const onDown = (e, t, mode) => {
    if (!editing) return;
    e.preventDefault(); e.stopPropagation();
    setSelected(t.id);
    const r = ref.current.getBoundingClientRect();
    drag.current = { id: t.id, mode, sx: e.clientX, sy: e.clientY, ox: t.x, oy: t.y, ow: t.w, oh: t.h, rw: r.width, rh: r.height };
  };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    const dx = ((e.clientX - d.sx) / d.rw) * 100; const dy = ((e.clientY - d.sy) / d.rh) * 100;
    const snap = (v) => Math.round(v * 2) / 2;
    if (d.mode === 'move') onChange(d.id, { x: snap(Math.min(100 - d.ow, Math.max(0, d.ox + dx))), y: snap(Math.min(100 - d.oh, Math.max(0, d.oy + dy))) });
    else onChange(d.id, { w: snap(Math.min(60, Math.max(4, d.ow + dx))), h: snap(Math.min(60, Math.max(4, d.oh + dy))) });
  };
  const onUp = () => { drag.current = null; };
  return (
    <div className={`floor-map ${editing ? 'editing' : ''}`} ref={ref} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onPointerDown={() => editing && setSelected(null)}>
      {items.map((t) => (
        <button key={t.id} type="button" className={`ft ${t.shape || 'square'} ${selected === t.id ? 'sel' : ''}`} data-status={t.status} data-long={isLong(t) ? '1' : undefined}
          style={{ left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%` }}
          onPointerDown={(e) => onDown(e, t, 'move')} onClick={() => !editing && onOpen(t)} aria-label={`${t.label}, ${STATUS[t.status]}`}>
          <b>{t.label}</b>
          <small>{t.status === 'seated' ? `${minutesSince(t.seated_at)}m` : `${t.seats} seats`}</small>
          {t.server_name && <i className="srv" title={t.server_name}>{initials(t.server_name)}</i>}
          {editing && <span className="rs" onPointerDown={(e) => onDown(e, t, 'resize')} aria-hidden="true" />}
        </button>
      ))}
      {items.length === 0 && <div className="empty" style={{ position: 'absolute', inset: 0, placeContent: 'center' }}>No tables in this area yet.</div>}
    </div>
  );
}

export default function Floor() {
  const { settings, can } = useCC();
  LONG = Number(settings.table_long_minutes ?? 90);
  const toast = useToast();
  const unit = settings.unit_label;
  const [tables, reload] = useLive(['tables'], () => api('/staff/tables'));
  const [guests] = useLive(['guests'], () => api('/staff/guests'));
  const [team] = useLive([], () => api('/staff/team'));
  const [open, setOpen] = useState(null);
  const [view, setView] = useState(() => { try { return localStorage.getItem('bh_floor_view') || 'map'; } catch { return 'map'; } });
  const [zone, setZone] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [selected, setSelected] = useState(null);
  useTick(30000);
  useEffect(() => { try { localStorage.setItem('bh_floor_view', view); } catch { /* ignore */ } }, [view]);

  const placed = useMemo(() => (tables ? autoPlace(tables) : []), [tables]);
  if (!tables) return null;
  const list = editing && draft ? draft : placed;
  const zones = [...new Set(list.map((t) => t.zone))];
  const z = zone && zones.includes(zone) ? zone : zones[0];
  const waiting = (guests?.active || []).filter((g) => g.kind === 'table');
  const counts = tables.reduce((a, t) => ({ ...a, [t.status]: (a[t.status] || 0) + 1 }), {});
  const sel = list.find((t) => t.id === selected);

  const startEdit = () => { setDraft(placed.map((t) => ({ ...t }))); setEditing(true); setView('map'); };
  const change = (id, patch) => setDraft((d) => d.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const saveLayout = async () => {
    try {
      await api('/staff/tables/layout', { method: 'PUT', body: draft.map((t) => ({ id: t.id, x: t.x, y: t.y, w: t.w, h: t.h, shape: t.shape || 'square' })) });
      for (const t of draft) {
        const o = tables.find((x) => x.id === t.id);
        if (o && (o.label !== t.label || o.seats !== Number(t.seats) || o.zone !== t.zone)) await api(`/staff/tables/${t.id}`, { method: 'PUT', body: { label: t.label, seats: Number(t.seats), zone: t.zone } });
      }
      toast('Floor plan saved', 'ok'); setEditing(false); setDraft(null); reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  const addTable = async () => {
    try {
      const label = String(Math.max(0, ...draft.map((t) => Number(t.label) || 0)) + 1);
      await api('/staff/tables', { method: 'POST', body: { label, seats: 4, zone: z || 'Main' } });
      const fresh = await api('/staff/tables');
      const added = fresh.filter((t) => !draft.some((d) => d.id === t.id)).map((t) => ({ ...t, x: 45, y: 40, w: 10, h: 13, shape: 'square' }));
      setDraft([...draft, ...added]); setSelected(added[0]?.id);
    } catch (e) { toast(e.message, 'err'); }
  };
  const removeTable = async () => {
    if (!sel || !confirm(`Delete ${unit} ${sel.label}?`)) return;
    try { await api(`/staff/tables/${sel.id}`, { method: 'DELETE' }); setDraft(draft.filter((t) => t.id !== sel.id)); setSelected(null); } catch (e) { toast(e.message, 'err'); }
  };

  return (
    <>
      <PageHead title="Floor" sub={`${counts.open || 0} open, ${counts.seated || 0} seated, ${counts.dirty || 0} to bus`}>
        {!editing && <div className="seg"><button aria-pressed={view === 'map'} onClick={() => setView('map')}>Map</button><button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button></div>}
        {can('manager') && !editing && <button className="btn" onClick={startEdit}>Edit floor plan</button>}
        {editing && <><button className="btn" onClick={addTable}><Icon name="plus" size={16} />Add {unit.toLowerCase()}</button><button className="btn ghost" onClick={() => { setEditing(false); setDraft(null); }}>Cancel</button><button className="btn primary" onClick={saveLayout}>Save floor plan</button></>}
      </PageHead>
      <NextUp />
      <RoomsToday />
      <FloorTimeline />
      <div className="row wrap" style={{ marginBottom: 14 }}>
        {zones.length > 1 && <div className="seg">{zones.map((x) => <button key={x} aria-pressed={x === z} onClick={() => setZone(x)}>{x}</button>)}</div>}
        <div className="grow" />
        <div className="legend"><span style={{ '--c': 'var(--seated)' }}>Open</span><span style={{ '--c': 'var(--reserved)' }}>Held</span><span style={{ '--c': 'var(--accent)' }}>Seated</span><span style={{ '--c': 'var(--dirty)' }}>Bus</span></div>
      </div>

      {view === 'map' || editing ? (
        <div className={editing ? 'floor-edit' : ''}>
          <FloorMap tables={list} zone={z} editing={editing} onOpen={setOpen} onChange={change} selected={selected} setSelected={setSelected} />
          {editing && (
            <aside className="panel floor-side">
              {sel ? (
                <div className="panel-b stack">
                  <h3>{unit} {sel.label}</h3>
                  <div className="row"><label className="field grow"><span>Label</span><input className="input" value={sel.label} maxLength={10} onChange={(e) => change(sel.id, { label: e.target.value })} /></label><label className="field" style={{ width: 90 }}><span>Seats</span><input className="input" type="number" min={1} max={40} value={sel.seats} onChange={(e) => change(sel.id, { seats: e.target.value })} /></label></div>
                  <label className="field"><span>Area</span><input className="input" value={sel.zone} maxLength={20} onChange={(e) => change(sel.id, { zone: e.target.value })} list="zones" /><datalist id="zones">{zones.map((x) => <option key={x} value={x} />)}</datalist></label>
                  <div className="field"><span>Shape</span><div className="seg">{['square', 'round', 'bar'].map((sh) => <button key={sh} aria-pressed={(sel.shape || 'square') === sh} onClick={() => change(sel.id, { shape: sh, ...(sh === 'bar' ? { w: Math.max(sel.w, 22), h: 8 } : {}) })} style={{ textTransform: 'capitalize' }}>{sh}</button>)}</div></div>
                  <button className="btn ghost danger" onClick={removeTable}>Delete {unit.toLowerCase()}</button>
                </div>
              ) : <div className="panel-b muted" style={{ fontSize: 14 }}>Drag tables to match your room, and drag the corner to resize. Tap a table to rename it or change its seats, area or shape. Each area shows as a tab.</div>}
            </aside>
          )}
        </div>
      ) : (
        <div className="tables">
          {tables.filter((t) => t.zone === z).map((t) => (
            <button key={t.id} className="tbl" data-status={t.status} data-long={isLong(t) ? '1' : undefined} onClick={() => setOpen(t)} aria-label={`${unit} ${t.label}, ${STATUS[t.status]}`}>
              <b>{t.label}</b><span className="s">{t.seats} seats{t.server_name ? `, ${t.server_name}` : ''}</span>
              <span className="s" style={{ color: 'var(--text)' }}>{t.status === 'seated' ? `${t.guest_name || 'Walk-in'}, ${minutesSince(t.seated_at)}m` : t.status === 'reserved' ? `Held for ${t.guest_name || 'guest'}` : STATUS[t.status]}</span>
            </button>
          ))}
        </div>
      )}
      {open && <TableModal table={open} waiting={waiting} unit={unit} team={team || []} onClose={() => setOpen(null)} />}
    </>
  );
}
