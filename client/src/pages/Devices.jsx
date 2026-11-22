import { useEffect, useRef, useState } from 'react';
import { api } from '../lib.js';
import { Modal, useToast } from '../ui.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { BLE_SERVICES, bleWritable, bleWrite, escpos, htmlToLines, serialWrite } from '../printing.js';

const CONN = { network: 'Wi-Fi or network cable (IP address)', bluetooth: 'Bluetooth (paired in Chrome on the helper)', usb: 'USB (plugged into the helper)', device: 'Device path on the helper computer', browser: "The helper's normal print dialog" };
const fmtAgo = (sql) => { if (!sql) return 'never'; const m = Math.round((Date.now() - Date.parse(`${sql.replace(' ', 'T')}Z`)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

/* ================= Devices page (managers) ================= */
export function DevicesPage() {
  const { can } = useCC(); const toast = useToast();
  const [d, reload] = useLive(['printers'], () => api('/staff/printers'));
  const [jobs, reloadJobs] = useLive(['printers'], () => api('/staff/print-jobs'));
  const [edit, setEdit] = useState(null); const [pair, setPair] = useState(null);
  useEffect(() => { const t = setInterval(() => { reload(); reloadJobs(); }, 10_000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return null;
  const test = (p) => api(`/staff/printers/${p.id}/test`, { method: 'POST' }).then(() => { toast(`Test sent to ${p.name}`, 'ok'); reloadJobs(); }).catch((e) => toast(e.message, 'err'));
  const removeAgent = (a) => confirm(`Remove the print helper "${a.name}"? Its printers stop printing until you pick another helper.`) && api(`/staff/print-agents/${a.id}`, { method: 'DELETE' }).then(reload);
  return (
    <div>
      <PageHead title="Devices and printers" sub="Connect receipt, kitchen and label printers, and see every screen paired to this business." />
      <section className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-h"><h3 className="grow">Print helpers</h3>{can('manager') && <button className="btn primary" onClick={() => setPair({})}>Add a print helper</button>}</div>
        <div className="panel-b stack">
          <span className="muted" style={{ fontSize: 14 }}>A print helper is a computer, tablet or Raspberry Pi at the business that passes print jobs to your printers. Use a Chrome tab for USB and Bluetooth printers or the normal print dialog, or the small helper program for Wi-Fi and network printers. One helper can run many printers.</span>
          {d.agents.length === 0 ? <span className="dim">No helpers yet.</span> : <table className="list"><tbody>{d.agents.map((a) => (
            <tr key={a.id}><td><b>{a.name}</b><div className="dim" style={{ fontSize: 12 }}>{a.kind === 'node' ? 'Helper program' : 'Chrome page'}{a.info?.host ? ` on ${a.info.host}` : ''}{a.info?.platform ? ` (${a.info.platform})` : ''}</div></td>
              <td><span className={`chip ${a.online ? 'teal' : ''}`}>{a.online ? 'Online' : `Last seen ${fmtAgo(a.last_seen)}`}</span></td>
              <td style={{ textAlign: 'right' }}>{can('manager') && <button className="btn sm ghost danger" onClick={() => removeAgent(a)}>Remove</button>}</td></tr>
          ))}</tbody></table>}
        </div>
      </section>
      <section className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-h"><h3 className="grow">Printers</h3>{can('manager') && <button className="btn primary" disabled={!d.agents.length} title={d.agents.length ? '' : 'Add a print helper first'} onClick={() => setEdit({ name: '', agentId: d.agents[0]?.id, connection: 'network', address: '', width: 42, jobs: ['ticket'], area: 'All areas', copies: 1, cut: true, drawer: false, active: true })}>Add a printer</button>}</div>
        <div className="panel-b">
          {d.printers.length === 0 ? <span className="dim">No printers yet. Until you add one, every print opens the browser's print box.</span> : <table className="list"><tbody>{d.printers.map((p) => (
            <tr key={p.id}><td><b>{p.name}</b>{!p.active && <span className="chip" style={{ marginLeft: 6 }}>Off</span>}<div className="dim" style={{ fontSize: 12 }}>{CONN[p.connection]}{p.address ? `: ${p.address}` : ''} · {p.width} characters · through {p.agent || 'no helper'}</div>
              <div style={{ fontSize: 12.5 }}>{p.jobs.map((k) => d.kinds[k]).join(', ') || 'Takes nothing yet'}{p.jobs.includes('ticket') && p.area ? ` (${p.area})` : ''}</div>
              {p.lastError && <div className="chip rose" style={{ fontSize: 11, marginTop: 4 }}>Last problem: {p.lastError}</div>}</td>
              <td><span className={`chip ${p.agentOnline ? 'teal' : 'amber'}`}>{p.agentOnline ? 'Ready' : 'Helper offline'}</span>{p.waiting > 0 && <div className="dim" style={{ fontSize: 12 }}>{p.waiting} waiting</div>}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn sm" onClick={() => test(p)}>Test print</button>{can('manager') && <button className="btn sm" onClick={() => setEdit(p)}>Edit</button>}</td></tr>
          ))}</tbody></table>}
        </div>
      </section>
      {jobs?.length > 0 && <section className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-h"><h3 className="grow">Recent prints</h3></div>
        <div className="panel-b"><table className="list"><tbody>{jobs.slice(0, 25).map((j) => (
          <tr key={j.id}><td>{j.title || j.kind}<div className="dim" style={{ fontSize: 12 }}>{j.printer} · {j.by_label || ''} · {fmtAgo(j.created_at)}</div></td>
            <td><span className={`chip ${j.status === 'done' ? 'teal' : j.status === 'failed' ? 'rose' : 'amber'}`}>{{ done: 'Printed', failed: 'Failed', queued: 'Waiting', sent: 'Printing', cancelled: 'Cancelled' }[j.status]}</span>{j.error && <div className="dim" style={{ fontSize: 11.5 }}>{j.error}</div>}</td>
            <td style={{ textAlign: 'right' }}>{j.status === 'failed' && <button className="btn sm" onClick={() => api(`/staff/print-jobs/${j.id}/retry`, { method: 'POST' }).then(reloadJobs)}>Try again</button>}</td></tr>
        ))}</tbody></table></div>
      </section>}
      <AutoPrints />
      <ScannerTest />
      <BumpBarKeys />
      <OtherDevices />
      {edit && <PrinterForm p={edit} d={d} onClose={(saved) => { setEdit(null); if (saved) reload(); }} />}
      {pair && <PairHelper onClose={() => { setPair(null); reload(); }} />}
    </div>
  );
}

function PrinterForm({ p, d, onClose }) {
  const toast = useToast(); const [f, setF] = useState({ ...p, address: p.address || '', area: p.area || 'All areas' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const agent = d.agents.find((a) => a.id === Number(f.agentId));
  const save = () => {
    const body = { name: f.name, agentId: f.agentId ? Number(f.agentId) : null, connection: f.connection, address: f.address || null, width: Number(f.width), jobs: f.jobs, area: f.jobs.includes('ticket') ? f.area : null, copies: Number(f.copies) || 1, cut: Boolean(f.cut), drawer: Boolean(f.drawer), active: Boolean(f.active), backupId: f.backupId || null };
    (p.id ? api(`/staff/printers/${p.id}`, { method: 'PUT', body }) : api('/staff/printers', { method: 'POST', body })).then(() => { toast('Printer saved', 'ok'); onClose(true); }).catch((e) => toast(e.message, 'err'));
  };
  const needsAddress = ['network', 'device'].includes(f.connection) || (agent?.kind === 'node' && ['usb', 'bluetooth'].includes(f.connection));
  return (
    <Modal title={p.id ? `Edit ${p.name}` : 'Add a printer'} onClose={() => onClose(false)} width={520}>
      <label className="field"><span>Name</span><input className="input" value={f.name} onChange={set('name')} placeholder="Grill printer" maxLength={40} /></label>
      <label className="field"><span>Print helper</span><select className="input" value={f.agentId || ''} onChange={set('agentId')}>{d.agents.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.kind === 'node' ? 'helper program' : 'Chrome page'})</option>)}</select></label>
      <label className="field"><span>How it connects</span><select className="input" value={f.connection} onChange={set('connection')}>{Object.entries(CONN).map(([k, l]) => <option key={k} value={k} disabled={agent?.kind === 'node' && k === 'browser'}>{l}</option>)}</select></label>
      {needsAddress && <label className="field"><span>{f.connection === 'network' ? 'Printer IP address (port 9100 unless you add one)' : 'Device path on the helper'}</span><input className="input" value={f.address} onChange={set('address')} placeholder={f.connection === 'network' ? '192.168.1.50:9100' : '/dev/usb/lp0  ·  /dev/rfcomm0  ·  \\\\.\\COM3'} /></label>}
      {agent?.kind !== 'node' && ['usb', 'bluetooth'].includes(f.connection) && <span className="dim" style={{ fontSize: 13 }}>After saving, open the helper's Chrome page and tap Pair next to this printer.</span>}
      <div className="row wrap" style={{ gap: 10 }}>
        <label className="field"><span>Paper</span><select className="input" value={f.width} onChange={set('width')}><option value={32}>58 mm (32 characters)</option><option value={42}>80 mm (42 characters)</option><option value={48}>80 mm (48 characters)</option><option value={64}>Wide (64 characters)</option></select></label>
        <label className="field"><span>Copies</span><input className="input" style={{ width: 70 }} type="number" min={1} max={5} value={f.copies} onChange={set('copies')} /></label>
      </div>
      <b>What it prints</b>
      <div className="par-grid">{Object.entries(d.kinds).filter(([k]) => k !== 'test').map(([k, l]) => <label key={k} className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.jobs.includes(k)} onChange={(e) => setF({ ...f, jobs: e.target.checked ? [...f.jobs, k] : f.jobs.filter((x) => x !== k) })} />{l}</label>)}</div>
      {f.jobs.includes('ticket') && <label className="field"><span>Tickets for</span><select className="input" value={f.area} onChange={set('area')}>{d.areas.map((a) => <option key={a}>{a}</option>)}</select></label>}
      <label className="field"><span>If it's offline or keeps failing, send its prints to</span><select className="input" value={f.backupId || ''} onChange={(e) => setF({ ...f, backupId: e.target.value ? Number(e.target.value) : null })}><option value="">No backup</option>{d.printers.filter((x) => x.id !== p.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={Boolean(f.cut)} onChange={set('cut')} />Cut the paper after each print</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={Boolean(f.drawer)} onChange={set('drawer')} />Open the cash drawer on cash receipts (drawer plugged into this printer)</label>
      <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={Boolean(f.active)} onChange={set('active')} />On</label>
      <div className="row">{p.id && <button className="btn ghost danger" onClick={() => confirm(`Remove ${p.name}?`) && api(`/staff/printers/${p.id}`, { method: 'DELETE' }).then(() => onClose(true))}>Remove</button>}<span className="grow" /><button className="btn primary" disabled={!f.name.trim() || !f.agentId} onClick={save}>Save</button></div>
    </Modal>
  );
}

function PairHelper({ onClose }) {
  const toast = useToast(); const [name, setName] = useState(''); const [kind, setKind] = useState('browser'); const [r, setR] = useState(null);
  const make = () => api('/staff/print-agents', { method: 'POST', body: { name: name.trim(), kind } }).then(setR).catch((e) => toast(e.message, 'err'));
  const link = r ? `${location.origin}/print-agent#t=${r.token}` : '';
  const cmd = r ? `node buzzhub-print-agent.mjs --server ${location.origin} --token ${r.token}` : '';
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Copied', 'ok'));
  return (
    <Modal title="Add a print helper" onClose={onClose} width={560}>
      {!r ? <>
        <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Kitchen tablet, Back office Pi…" maxLength={40} /></label>
        <label className="row" style={{ fontSize: 14 }}><input type="radio" checked={kind === 'browser'} onChange={() => setKind('browser')} /><span><b>Chrome page</b>: for USB and Bluetooth printers, or any printer the computer already knows. Runs on Windows, Mac, Chromebook, Android or Linux.</span></label>
        <label className="row" style={{ fontSize: 14 }}><input type="radio" checked={kind === 'node'} onChange={() => setKind('node')} /><span><b>Helper program</b>: for Wi-Fi and network printers, and USB or classic Bluetooth printers on the helper computer. Good on a Raspberry Pi left running in the back.</span></label>
        <button className="btn primary lg block" disabled={!name.trim()} onClick={make}>Create the pairing</button>
      </> : kind === 'browser' ? <>
        <span className="muted" style={{ fontSize: 14 }}>On the helper computer or tablet, open this link in Chrome and leave the tab open. Don't share it: anyone with it can print here.</span>
        <div className="code-box">{link}</div>
        <div className="row"><button className="btn" onClick={() => copy(link)}>Copy link</button><a className="btn primary" href={link} target="_blank" rel="noreferrer">Open on this device</a></div>
        <span className="dim" style={{ fontSize: 12.5 }}>To print without the print box popping up, start Chrome with --kiosk-printing.</span>
      </> : <>
        <span className="muted" style={{ fontSize: 14 }}>On the helper computer (Node 18 or newer), download the helper and run it. Keep it running with pm2, systemd or Task Scheduler. Don't share the token.</span>
        <a className="btn" href="/api/staff/print-agent.mjs" download>Download the helper</a>
        <div className="code-box">{cmd}</div>
        <button className="btn" onClick={() => copy(cmd)}>Copy the command</button>
      </>}
    </Modal>
  );
}

function OtherDevices() {
  const rows = [
    ['Kitchen and area screens', 'Kitchen → Area screens → Start on this device', '/kitchen'],
    ['Menu board TVs', 'Settings → Menu board', '/settings'],
    ['Customer displays (facing guests at the till)', 'Register → Customer display → Pair', '/register'],
    ['Time clock', 'Shifts → Time clock screen', '/shifts'],
    ['Self-order kiosk', 'Settings → Kiosk', '/settings'],
    ['Lobby screen', 'Settings → Lobby screen', '/settings'],
    ['Card readers', 'Settings → Card readers', '/settings'],
  ];
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h3 className="grow">Other screens and devices</h3></div>
      <div className="panel-b"><table className="list"><tbody>{rows.map(([n, how, to]) => <tr key={n}><td><b>{n}</b><div className="dim" style={{ fontSize: 12 }}>{how}</div></td><td style={{ textAlign: 'right' }}><a className="btn sm" href={to}>Open</a></td></tr>)}</tbody></table>
        <span className="dim" style={{ fontSize: 12.5 }}>Each kind of screen can be signed out everywhere from its own settings if a device is lost.</span></div>
    </section>
  );
}

/* ================= The print helper page (/print-agent), runs in Chrome at the business ================= */
const SAVED = 'bh_print_token';
export function PrintAgentPage() {
  const [token, setToken] = useState(() => { const m = location.hash.match(/t=([^&]+)/); if (m) { localStorage.setItem(SAVED, m[1]); history.replaceState(null, '', '/print-agent'); return m[1]; } return localStorage.getItem(SAVED) || ''; });
  const loc = (() => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).loc || 'main'; } catch { return 'main'; } })();
  const hdr = { 'X-Print': token, 'X-Location': loc };
  const [me, setMe] = useState(null); const [err, setErr] = useState(''); const [log, setLog] = useState([]); const [ports, setPorts] = useState({}); const [ble, setBle] = useState({});
  const [html, setHtml] = useState(null);
  const portsRef = useRef({}); portsRef.current = ports; const bleRef = useRef({}); bleRef.current = ble;
  const add = (t) => setLog((l) => [`${new Date().toLocaleTimeString()} ${t}`, ...l].slice(0, 40));
  const load = () => api('/print/agent', { headers: hdr }).then((x) => { setMe(x); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { if (!token) return undefined; load(); api('/print/agent/info', { method: 'POST', headers: hdr, body: { version: 'web', host: navigator.userAgentData?.platform || navigator.platform || 'browser', platform: 'Chrome page' } }).catch(() => {}); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  // reconnect USB printers this browser already allowed
  useEffect(() => { if (!navigator.serial || !me) return; navigator.serial.getPorts().then((list) => { const saved = JSON.parse(localStorage.getItem('bh_print_ports') || '{}'); const m = {}; for (const [pid, key] of Object.entries(saved)) { const p = list.find((x) => { const i = x.getInfo(); return `${i.usbVendorId}:${i.usbProductId}` === key; }); if (p) m[pid] = p; } setPorts(m); }); }, [me]);
  // the job loop
  useEffect(() => {
    if (!me) return undefined; let stop = false;
    const run = async () => {
      while (!stop) {
        let jobs = [];
        try { jobs = await api('/print/jobs?wait=1', { headers: hdr }); } catch (e) { if (e.status === 401) { setErr(e.message); return; } await new Promise((r) => setTimeout(r, 5000)); continue; }
        for (const j of jobs) {
          try { await printOne(j); add(`Printed ${j.title || j.kind} on ${j.printer.name}`); await api(`/print/jobs/${j.id}/result`, { method: 'POST', headers: hdr, body: { ok: true } }); }
          catch (e) { add(`Couldn't print on ${j.printer.name}: ${e.message}`); await api(`/print/jobs/${j.id}/result`, { method: 'POST', headers: hdr, body: { ok: false, error: String(e.message).slice(0, 280) } }).catch(() => {}); }
        }
      }
    };
    run(); return () => { stop = true; };
  }, [me?.agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function printOne(j) {
    const c = j.printer.connection; const bytes = escpos(j);
    if (c === 'usb') { const p = portsRef.current[j.printer.id]; if (!p) throw new Error('USB printer not paired on this page. Tap Pair.'); return serialWrite(p, bytes); }
    if (c === 'bluetooth') { const dv = bleRef.current[j.printer.id]; if (!dv) throw new Error('Bluetooth printer not connected. Tap Pair on the helper page.'); return bleWrite(dv, bytes); }
    if (c === 'browser') {
      setHtml(j.html || `<pre class="agent-lines">${(j.lines || []).map((l) => l.qr ? `<center>${escape(l.qr)}</center>` : `${l.center ? '<center>' : ''}${l.bold || l.big ? '<b>' : ''}${escape(l.text)}${l.right ? ` ${escape(l.right)}` : ''}${l.bold || l.big ? '</b>' : ''}${l.center ? '</center>' : ''}`).join('\n')}</pre>`);
      await new Promise((r) => setTimeout(r, 120)); document.body.classList.add('printing-agent'); window.print(); document.body.classList.remove('printing-agent'); return null;
    }
    throw new Error('Network and device-path printers need the helper program, not this page.');
  }
  const pairUsb = async (p) => { try { const port = await navigator.serial.requestPort(); const i = port.getInfo(); const saved = JSON.parse(localStorage.getItem('bh_print_ports') || '{}'); saved[p.id] = `${i.usbVendorId}:${i.usbProductId}`; localStorage.setItem('bh_print_ports', JSON.stringify(saved)); setPorts({ ...portsRef.current, [p.id]: port }); add(`${p.name} paired over USB`); } catch (e) { add(e.message); } };
  const pairBle = async (p) => { try { const dv = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES }); await bleWritable(dv); dv.addEventListener('gattserverdisconnected', () => add(`${p.name} disconnected; it reconnects on the next print`)); setBle({ ...bleRef.current, [p.id]: dv }); add(`${p.name} connected over Bluetooth (${dv.name || 'printer'})`); } catch (e) { add(e.message); } };
  const test = (p) => printOne({ printer: p, title: 'Test', lines: [{ text: 'BuzzHub', big: true, center: true }, { text: `Printer: ${p.name}`, center: true }, { text: 'It works.', bold: true, center: true }] }).then(() => add(`Test printed on ${p.name}`)).catch((e) => add(e.message));
  if (!token) return <div className="agent-page"><h1>Print helper</h1><p>Open the pairing link from Devices and printers in the command center.</p></div>;
  return (
    <div className="agent-page">
      <h1>Print helper</h1>
      {err ? <p className="lock-msg">{err}</p> : !me ? <p>Connecting…</p> : <>
        <p className="muted">{me.business} · {me.agent.name}. Leave this tab open. Prints arrive here and go to the printers below.</p>
        {me.printers.length === 0 && <p>No printers use this helper yet. Add one in Devices and printers.</p>}
        <div className="stack" style={{ gap: 8 }}>{me.printers.map((p) => (
          <div key={p.id} className="card row" style={{ gap: 10 }}>
            <span className="grow"><b>{p.name}</b><div className="dim" style={{ fontSize: 13 }}>{CONN[p.connection]}</div></span>
            {p.connection === 'usb' && (navigator.serial ? <button className="btn" onClick={() => pairUsb(p)}>{ports[p.id] ? 'Paired (change)' : 'Pair USB'}</button> : <span className="chip rose">This browser can't use USB printers</span>)}
            {p.connection === 'bluetooth' && (navigator.bluetooth ? <button className="btn" onClick={() => pairBle(p)}>{ble[p.id] ? 'Connected (change)' : 'Pair Bluetooth'}</button> : <span className="chip rose">This browser can't use Bluetooth printers</span>)}
            <button className="btn" onClick={() => test(p)}>Test</button>
          </div>
        ))}</div>
        {me.printers.some((p) => p.connection === 'bluetooth') && <p className="dim" style={{ fontSize: 13 }}>Bluetooth needs a tap on Pair each time this page is opened (the browser asks for it). Keep the tab open to stay connected.</p>}
        <h3>Activity</h3><div className="agent-log">{log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <span className="dim">Waiting for prints…</span>}</div>
      </>}
      <div className="agent-print" dangerouslySetInnerHTML={{ __html: html || '' }} />
    </div>
  );
}
const escape = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export { htmlToLines };

/* ================= Round 24: printer lights ================= */
export function PrinterLight({ kinds, area, headers }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = () => api(`/print/status?kinds=${kinds}${area ? `&area=${encodeURIComponent(area)}` : ''}`, headers ? { headers } : {}).then((x) => { if (!stop) setList(x); }).catch(() => {});
    load(); const t = setInterval(load, 30_000); return () => { stop = true; clearInterval(t); };
  }, [kinds, area]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list?.length) return null;
  const bad = list.filter((p) => p.state !== 'ok');
  const label = { offline: 'offline', error: 'had a problem', stuck: 'is behind' };
  return (
    <span className={`printer-light ${bad.length ? 'bad' : 'ok'}`} title={list.map((p) => `${p.name}: ${p.state === 'ok' ? 'ready' : `${label[p.state]}${p.error ? ` (${p.error})` : ''}`}`).join('\n')}>
      <i aria-hidden="true" />{bad.length ? `${bad[0].name} ${label[bad[0].state]}${bad.length > 1 ? ` +${bad.length - 1}` : ''}` : list.length === 1 ? list[0].name : `${list.length} printers`}
    </span>
  );
}

/* ================= Round 24: no-sale drawer ================= */
export function NoSaleButton() {
  const toast = useToast();
  const go = () => { const reason = prompt('Why open the drawer? (for the log)', ''); if (reason === null) return; api('/staff/drawer/no-sale', { method: 'POST', body: { reason: reason.trim() || undefined } }).then((r) => toast(`Drawer opened (${r.drawers})`, 'ok')).catch((e) => toast(e.message, 'err')); };
  return <button className="btn" onClick={go} title="Open the cash drawer without a sale. Needs a manager.">No sale</button>;
}

/* ================= Round 24: scanners, bump bars, automatic prints (Devices page sections) ================= */
export function ScannerTest() {
  const [code, setCode] = useState(''); const [r, setR] = useState(null);
  const test = (e) => { e.preventDefault(); if (!code.trim()) return; api(`/staff/scan?code=${encodeURIComponent(code.trim())}`).then(setR).catch((x) => setR({ type: 'error', error: x.message })); setCode(''); };
  const say = (x) => (x.type === 'customer' ? `Member card: ${x.name}` : x.type === 'gift' ? `Gift card ${x.code}: $${(x.balanceCents / 100).toFixed(2)} left (${x.status})` : x.type === 'ingredient' ? `Ingredient: ${x.name} (${x.stock ?? '?'} ${x.unit || ''} on hand)` : x.type === 'ticket' ? `Event ticket ${x.code}` : x.type === 'error' ? x.error : `Not recognised: ${x.code}`);
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h3 className="grow">Barcode scanners</h3></div>
      <div className="panel-b stack">
        <span className="muted" style={{ fontSize: 14 }}>USB, Bluetooth and wireless scanners all work: pair or plug them in like a keyboard (most do this out of the box; Bluetooth ones pair in the device's Bluetooth settings). Set the scanner to send Enter after each scan. Anywhere in the command center, scanning a member card opens their profile, a gift card shows its balance, and an ingredient's barcode opens the stock count.</span>
        <form className="row" onSubmit={test}><input className="input grow" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Click here and scan something to test" /><button className="btn">Check</button></form>
        {r && <span className={`chip ${r.type === 'none' || r.type === 'error' ? 'rose' : 'teal'}`}>{say(r)}</span>}
      </div>
    </section>
  );
}
const KEY_LABELS = { next: 'Next ticket', prev: 'Previous ticket', bump: 'Bump / complete', recall: 'Bring back the last one', allday: 'All-day counts' };
export function BumpBarKeys() {
  const { settings } = useCC(); const toast = useToast();
  const [k, setK] = useState(() => { try { return { next: 'ArrowRight', prev: 'ArrowLeft', bump: 'Enter', recall: 'r', allday: 'a', select: '1-9', ...JSON.parse(settings.bumpbar_keys || '{}') }; } catch { return { next: 'ArrowRight', prev: 'ArrowLeft', bump: 'Enter', recall: 'r', allday: 'a', select: '1-9' }; } });
  const [listen, setListen] = useState(null);
  useEffect(() => { if (!listen) return undefined; const on = (e) => { e.preventDefault(); setK((v) => ({ ...v, [listen]: e.key })); setListen(null); }; window.addEventListener('keydown', on, { once: true }); return () => window.removeEventListener('keydown', on); }, [listen]);
  const save = () => api('/staff/bumpbar-keys', { method: 'PUT', body: k }).then(() => toast('Bump bar keys saved. Kitchen screens pick them up within a few seconds.', 'ok')).catch((e) => toast(e.message, 'err'));
  const show = (x) => ({ ' ': 'Space', ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓' }[x] || x);
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h3 className="grow">Bump bars</h3><button className="btn sm primary" onClick={save}>Save keys</button></div>
      <div className="panel-b stack">
        <span className="muted" style={{ fontSize: 14 }}>Bump bars plug into a kitchen screen by USB (or pair by Bluetooth) and send keys. Tap a button below, then press the bump bar key you want for it.</span>
        <div className="par-grid">{Object.entries(KEY_LABELS).map(([id, l]) => <div key={id} className="row" style={{ fontSize: 14 }}><span className="grow">{l}</span><button className={`btn sm ${listen === id ? 'primary' : ''}`} onClick={() => setListen(id)}>{listen === id ? 'Press a key…' : <kbd>{show(k[id])}</kbd>}</button></div>)}</div>
        <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={k.select !== 'off'} onChange={(e) => setK({ ...k, select: e.target.checked ? '1-9' : 'off' })} />Keys 1 to 9 pick the ticket in that spot</label>
      </div>
    </section>
  );
}
export function AutoPrints() {
  const { settings } = useCC(); const toast = useToast(); const [f, setF] = useState({ print_tickets_auto: settings.print_tickets_auto ?? '1', receipt_qr: settings.receipt_qr ?? '1', eod_print: settings.eod_print ?? '0', eod_print_hour: settings.eod_print_hour ?? '23', display_idle: settings.display_idle ?? '1' });
  const save = (next) => { setF(next); api('/staff/settings', { method: 'PUT', body: next }).then(() => toast('Saved', 'ok')).catch((e) => toast(e.message, 'err')); };
  const flag = (k) => (e) => save({ ...f, [k]: e.target.checked ? '1' : '0' });
  return (
    <section className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-h"><h3 className="grow">Automatic prints</h3><button className="btn sm" onClick={() => api('/staff/eod/print', { method: 'POST', body: {} }).then((r) => toast(r.queued ? 'End-of-day report sent to the printer' : 'No printer takes reports yet', r.queued ? 'ok' : 'err'))}>Print end of day now</button></div>
      <div className="panel-b stack">
        <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.print_tickets_auto !== '0'} onChange={flag('print_tickets_auto')} />Kitchen tickets print on each area's printer as orders come in</label>
        <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.receipt_qr !== '0'} onChange={flag('receipt_qr')} />Put a QR code on printed receipts (their receipt, a rating and rewards sign-up)</label>
        <div className="row wrap"><label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.eod_print === '1'} onChange={flag('eod_print')} />Print the end-of-day summary on the report printer at</label>
          <select className="input" style={{ width: 110 }} value={f.eod_print_hour} onChange={(e) => save({ ...f, eod_print_hour: e.target.value })} aria-label="Hour">{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`}</option>)}</select></div>
        <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={f.display_idle !== '0'} onChange={flag('display_idle')} />Customer displays show specials and dish photos when nobody is paying</label>
      </div>
    </section>
  );
}
