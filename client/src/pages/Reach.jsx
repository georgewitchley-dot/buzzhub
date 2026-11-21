import { useEffect, useState } from 'react';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent } from '../lib.js';
import { Icon, Modal, Puck, useToast } from '../ui.jsx';
import { useCC, useLive } from './CommandCenter.jsx';
import { LangSwitch, useLang } from '../i18n.jsx';

/* ================= Menu details: description, allergens, diet, Spanish ================= */
export function MenuDetails() {
  const toast = useToast();
  const [d, reload] = useLive(['menu'], () => api('/staff/menu/details'));
  const [edit, setEdit] = useState(null);
  if (!d) return null;
  const done = d.items.filter((i) => i.allergens.length || i.diet.length).length;
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">Allergens, diets and Spanish names</h3><span className="muted" style={{ fontSize: 13 }}>{done} of {d.items.length} items tagged</span></div>
      <table className="list"><tbody>{d.items.map((i) => (
        <tr key={i.id} onClick={() => setEdit(i)} style={{ cursor: 'pointer' }}>
          <td><b>{i.name}</b>{i.i18n?.es?.name && <div className="dim" style={{ fontSize: 12.5 }}>{i.i18n.es.name}</div>}</td>
          <td><span className="tags-line">{i.diet.map((t) => <span key={t} className="mini diet">{t}</span>)}{i.allergens.map((t) => <span key={t} className="mini">{t}</span>)}{!i.allergens.length && !i.diet.length && <span className="dim">Not tagged</span>}</span></td>
          <td style={{ textAlign: 'right' }}><button className="btn sm ghost">Edit</button></td></tr>
      ))}</tbody></table>
      {edit && <DetailsModal item={edit} lists={d} onClose={() => { setEdit(null); reload(); }} toast={toast} />}
    </section>
  );
}
function DetailsModal({ item, lists, onClose, toast }) {
  const [f, setF] = useState({ description: item.description || '', allergens: item.allergens, diet: item.diet, esName: item.i18n?.es?.name || '', esDesc: item.i18n?.es?.description || '', esCat: item.i18n?.es?.category || '' });
  const flip = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const save = async () => { try { await api(`/staff/menu/${item.id}/details`, { method: 'PUT', body: { description: f.description || undefined, allergens: f.allergens, diet: f.diet, es: { name: f.esName, description: f.esDesc, category: f.esCat } } }); toast(`${item.name} saved`, 'ok'); onClose(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={item.name} onClose={onClose} width={560}>
      <label className="field"><span>Description customers see</span><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={200} /></label>
      <div className="field"><span>Contains</span><div className="row wrap" style={{ gap: 6 }}>{lists.allergens.map((a) => <button key={a} className={`chip ${f.allergens.includes(a) ? 'rose' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={f.allergens.includes(a)} onClick={() => flip('allergens', a)}>{a}</button>)}</div></div>
      <div className="field"><span>Diet</span><div className="row wrap" style={{ gap: 6 }}>{lists.diets.map((a) => <button key={a} className={`chip ${f.diet.includes(a) ? 'teal' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={f.diet.includes(a)} onClick={() => flip('diet', a)}>{a}</button>)}</div></div>
      <b style={{ marginTop: 6 }}>Spanish</b>
      <div className="row"><label className="field grow"><span>Name</span><input className="input" value={f.esName} onChange={(e) => setF({ ...f, esName: e.target.value })} maxLength={60} /></label><label className="field grow"><span>Category</span><input className="input" value={f.esCat} onChange={(e) => setF({ ...f, esCat: e.target.value })} maxLength={40} placeholder={item.category} /></label></div>
      <label className="field"><span>Description</span><input className="input" value={f.esDesc} onChange={(e) => setF({ ...f, esDesc: e.target.value })} maxLength={200} /></label>
      <button className="btn primary lg block" onClick={save}>Save</button>
      <span className="dim" style={{ fontSize: 12.5 }}>Customers can hide dishes with an allergen. Tags are a guide only, so always tell guests to mention serious allergies.</span>
    </Modal>
  );
}

/* ================= Accounting export (owner, inside Reports) ================= */
const ACCT_LABELS = { funds: 'Money received', sales: 'Sales', tax: 'Sales tax', tips: 'Tips', gift: 'Gift cards (liability)', delivery: 'Delivery fees', memberships: 'Memberships', catering: 'Catering', deposits: 'Deposits' };
export function AccountingExport() {
  const { settings } = useCC();
  const toast = useToast();
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const [range, setRange] = useState({ from: new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10), to: y });
  const [acct, setAcct] = useState(null);
  useEffect(() => { api(`/staff/accounting?from=${y}&to=${y}`).then((r) => setAcct(r.accounts)).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const url = (format) => `/api/staff/accounting?from=${range.from}&to=${range.to}&format=${format}`;
  const saveAcct = async () => { try { await api('/staff/settings', { method: 'PUT', body: { acct_map: JSON.stringify(acct) } }); toast('Account names saved', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  void settings;
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">Accounting export</h3>
        <input className="input" type="date" style={{ width: 150, height: 34 }} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} aria-label="From" />
        <input className="input" type="date" style={{ width: 150, height: 34 }} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} aria-label="To" />
      </div>
      <div className="panel-b stack">
        <div className="row wrap">
          <a className="btn primary" href={url('quickbooks')} download>QuickBooks journal (CSV)</a>
          <a className="btn" href={url('xero')} download>Xero manual journal (CSV)</a>
          <a className="btn" href={url('csv')} download>Daily sales summary (CSV)</a>
        </div>
        <span className="muted" style={{ fontSize: 13.5 }}>One balanced entry per day: money received on one side; sales, tax, tips, gift cards, memberships, catering and deposits on the other. In QuickBooks Online, use Settings → Import data → Journal entries. In Xero, use Accounting → Manual journals → Import.</span>
        {acct && (
          <details><summary className="muted" style={{ cursor: 'pointer', fontSize: 14 }}>Match your chart of accounts (names for QuickBooks, codes for Xero)</summary>
            <div className="pick-grid" style={{ maxHeight: 'none', marginTop: 8 }}>{Object.keys(ACCT_LABELS).map((k) => <label key={k} className="field"><span>{ACCT_LABELS[k]}</span><input className="input" value={acct[k] || ''} onChange={(e) => setAcct({ ...acct, [k]: e.target.value })} maxLength={60} /></label>)}</div>
            <button className="btn sm" onClick={saveAcct} style={{ marginTop: 8 }}>Save account names</button>
          </details>
        )}
      </div>
    </section>
  );
}

/* ================= Get found (inside Marketing) ================= */
const SRC_LABEL = { instagram: 'Instagram bio', facebook: 'Facebook page', tiktok: 'TikTok bio', google: 'Google Business Profile', x: 'X profile', website: 'Your website', qr: 'Printed QR code', email: 'Email signature' };
export function GetFound() {
  const toast = useToast();
  const { settings } = useCC();
  const [d] = useLive(['settings'], () => api('/staff/links'));
  const [addr, setAddr] = useState({ business_address: settings.business_address || '', business_phone: settings.business_phone || '' });
  if (!d) return null;
  const copy = (u) => { navigator.clipboard?.writeText(u); toast('Link copied', 'ok'); };
  const saveAddr = async () => { try { await api('/staff/settings', { method: 'PUT', body: addr }); toast('Saved', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  return (
    <section className="panel" style={{ marginTop: 18 }}>
      <div className="panel-h"><h3 className="grow">Get found: one link for every profile</h3><a className="btn sm" href="/go" target="_blank" rel="noreferrer">Preview the page</a></div>
      <div className="panel-b stack">
        <span className="muted" style={{ fontSize: 14 }}>Put these links in your bios and profiles. Customers land on one page to join the line, book, order, see the menu, buy gift cards or join a membership. Each link is tracked, so you can see which profile brings people in.</span>
        <table className="list"><tbody>{d.links.map((l) => {
          const st = d.stats.find((x) => x.src === l.src);
          return (
            <tr key={l.src}><td><b>{SRC_LABEL[l.src] || l.src}</b><div className="dim num" style={{ fontSize: 12 }}>{l.url}</div></td>
              <td className="muted" style={{ fontSize: 13.5 }}>{st ? `${st.visits} visits, ${Object.values(st.clicks).reduce((a, b) => a + b, 0)} taps (${Object.entries(st.clicks).map(([k, v]) => `${v} ${k}`).join(', ')})` : `No visits in ${d.days} days`}</td>
              <td style={{ textAlign: 'right' }}>{l.svg && <button className="btn sm ghost" onClick={() => { const w = window.open('', '_blank'); w.document.write(`<title>QR</title><div style="width:420px;margin:40px auto;font-family:sans-serif;text-align:center">${l.svg}<h2>${settings.business_name}</h2><p>Scan to order, book or join the line</p></div>`); w.document.close(); }}>QR</button>}<button className="btn sm" onClick={() => copy(l.url)}>Copy</button></td></tr>
          );
        })}</tbody></table>
        <details><summary className="muted" style={{ cursor: 'pointer', fontSize: 14 }}>Add the links to your Google Business Profile</summary>
          <ol className="muted" style={{ fontSize: 14, lineHeight: 1.6 }}>
            <li>On Google, search for your business name and open your profile (you must be signed in as the owner).</li>
            <li>Choose Edit profile, then the Contact or Links section.</li>
            <li>Paste the Google link above as your Website, Order ahead or Bookings link, then save.</li>
          </ol>
        </details>
        <div className="row"><label className="field grow"><span>Address (shown on the page and to search engines)</span><input className="input" value={addr.business_address} onChange={(e) => setAddr({ ...addr, business_address: e.target.value })} maxLength={160} /></label>
          <label className="field" style={{ width: 180 }}><span>Phone</span><input className="input" value={addr.business_phone} onChange={(e) => setAddr({ ...addr, business_phone: e.target.value })} maxLength={30} /></label>
          <button className="btn" style={{ alignSelf: 'end' }} onClick={saveAddr}>Save</button></div>
      </div>
    </section>
  );
}

/* ================= Public link hub (/go) ================= */
const T_KEY = { join: ['Join the waitlist', 'Get in line'], book: ['Book a table', 'Book an appointment'], order: ['Order pickup or delivery', 'Order delivery', 'Order for pickup'], menu: ['See the menu'], members: ['Memberships'], gift: ['Buy a gift card'], review: ['Leave us a review'] };
export function LinkHub() {
  const { lang, setLang, t } = useLang();
  const [d, setD] = useState(null);
  const [specials, setSpecials] = useState([]);
  const src = new URLSearchParams(location.search).get('src') || 'other';
  useEffect(() => {
    api('/public/links').then((x) => { setD(x); applyAccent(x.business.accent); }).catch(() => {});
    api('/public/hit', { method: 'POST', body: { src, target: 'view' } }).catch(() => {});
    api('/public/specials').then(setSpecials).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="guest" />;
  void T_KEY;
  const go = (l) => { api('/public/hit', { method: 'POST', body: { src, target: l.key } }).catch(() => {}); };
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.business.accent, '#2a1f55', d.business.accent]} amplitude={0.6} speed={0.35} mouseInteraction={false} /></div>
      <main className="guest-in">
        <LangSwitch lang={lang} setLang={setLang} />
        {d.business.logo ? <img className="guest-logo" src={d.business.logo} alt={d.business.name} /> : <Puck state="buzzed" size={56} />}
        <h1 style={{ textAlign: 'center' }}>{d.business.name}</h1>
        {(d.business.address || d.business.phone) && <p style={{ textAlign: 'center' }}>{d.business.address}{d.business.address && d.business.phone ? ' · ' : ''}{d.business.phone && <a href={`tel:${d.business.phone.replace(/[^\d+]/g, '')}`}>{d.business.phone}</a>}</p>}
        {specials.length > 0 && <div className="card stack" style={{ width: '100%', gap: 4 }}><b>{t("Today's specials")}</b>{specials.map((x) => <span key={x.id}>{x.name}{x.note ? `: ${x.note}` : ''}</span>)}</div>}
        <nav className="link-hub" style={{ width: '100%' }}>{d.links.map((l) => <a key={l.key} href={l.url} onClick={() => go(l)} target={l.key === 'review' ? '_blank' : undefined} rel="noreferrer">{t(l.label)}</a>)}</nav>
        {d.business.address && <a className="btn ghost" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${d.business.name} ${d.business.address}`)}`} target="_blank" rel="noreferrer"><Icon name="pin" size={16} />{t('Directions')}</a>}
      </main>
    </div>
  );
}
