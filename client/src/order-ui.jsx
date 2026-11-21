// Shared ordering pieces: option picker, cart helpers, a customer-facing menu.
import { useEffect, useMemo, useState } from 'react';
import { api, money } from './lib.js';
import { Modal } from './ui.jsx';

export const lineKey = (l) => `${l.itemId}:${(l.mods || []).slice().sort().join(',')}:${l.note || ''}`;
export const lineTotal = (l) => l.qty * l.unitCents;

/** Pick options for one item. onAdd({ itemId, qty, mods, note, name, modNames, unitCents }) */
export function ModPicker({ item, currency, onClose, onAdd, allowNote = true }) {
  const [sel, setSel] = useState(() => Object.fromEntries(item.groups.map((g) => [g.id, g.min === 1 && g.max === 1 ? [g.options[0]?.id] : []])));
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const picked = item.groups.flatMap((g) => g.options.filter((o) => sel[g.id]?.includes(o.id)));
  const unit = item.price_cents + picked.reduce((a, o) => a + o.price_cents, 0);
  const problems = item.groups.filter((g) => (sel[g.id]?.length || 0) < g.min);
  const toggle = (g, o) => setSel((s) => {
    const cur = s[g.id] || [];
    if (g.max === 1) return { ...s, [g.id]: cur.includes(o.id) && g.min === 0 ? [] : [o.id] };
    return { ...s, [g.id]: cur.includes(o.id) ? cur.filter((x) => x !== o.id) : cur.length < g.max ? [...cur, o.id] : cur };
  });
  return (
    <Modal title={item.name} onClose={onClose}>
      {item.groups.map((g) => (
        <div key={g.id} className="field">
          <span>{g.name}{g.min > 0 ? ` (pick ${g.min === g.max ? g.min : `${g.min}–${g.max}`})` : g.max > 1 ? ` (up to ${g.max})` : ' (optional)'}</span>
          <div className="opt-grid">
            {g.options.map((o) => {
              const on = sel[g.id]?.includes(o.id);
              return <button key={o.id} type="button" className={`opt ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(g, o)}>{o.name}{o.price_cents ? <small>{o.price_cents > 0 ? '+' : ''}{money(o.price_cents, currency)}</small> : null}</button>;
            })}
          </div>
        </div>
      ))}
      {allowNote && <label className="field"><span>Note for the kitchen (optional)</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} placeholder="No onions, allergy…" /></label>}
      <div className="row">
        <span className="qty"><button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="One less">−</button><span>{qty}</span><button type="button" onClick={() => setQty(Math.min(99, qty + 1))} aria-label="One more">+</button></span>
        <button className="btn primary lg grow" disabled={problems.length > 0} onClick={() => onAdd({ itemId: item.id, qty, mods: picked.map((o) => o.id), note: note || undefined, name: item.name, modNames: picked.map((o) => o.name), unitCents: unit })}>
          {problems.length ? `Choose ${problems[0].name.toLowerCase()}` : `Add ${qty} for ${money(unit * qty, currency)}`}
        </button>
      </div>
    </Modal>
  );
}

/** Cart state shared by the register and the customer pages. */
export function useCart() {
  const [lines, setLines] = useState([]);
  const add = (l) => setLines((cur) => { const k = lineKey(l); const i = cur.findIndex((x) => lineKey(x) === k); if (i >= 0) { const n = [...cur]; n[i] = { ...n[i], qty: n[i].qty + l.qty }; return n; } return [...cur, l]; });
  const bump = (k, d) => setLines((cur) => cur.map((x) => (lineKey(x) === k ? { ...x, qty: x.qty + d } : x)).filter((x) => x.qty > 0));
  const clear = () => setLines([]);
  const subtotal = lines.reduce((a, l) => a + lineTotal(l), 0);
  const payload = lines.map((l) => ({ itemId: l.itemId, qty: l.qty, mods: l.mods?.length ? l.mods : undefined, note: l.note }));
  return { lines, add, bump, clear, subtotal, payload, count: lines.reduce((a, l) => a + l.qty, 0) };
}

export function CartLines({ cart, currency }) {
  return cart.lines.map((l) => (
    <div className="line" key={lineKey(l)}>
      <span className="qty"><button onClick={() => cart.bump(lineKey(l), -1)} aria-label={`Remove one ${l.name}`}>−</button><span>{l.qty}</span><button onClick={() => cart.bump(lineKey(l), 1)} aria-label={`Add one ${l.name}`}>+</button></span>
      <span>{l.name}{(l.modNames?.length || l.note) && <small className="mods">{[...(l.modNames || []), l.note].filter(Boolean).join(', ')}</small>}</span>
      <span className="num">{money(lineTotal(l), currency)}</span>
    </div>
  ));
}

const ALLERGY_ES = { milk: 'leche', eggs: 'huevo', fish: 'pescado', shellfish: 'mariscos', 'tree nuts': 'nueces', peanuts: 'cacahuate', wheat: 'trigo', soy: 'soya', sesame: 'ajonjolí' };
const DIET_ES = { vegetarian: 'vegetariano', vegan: 'vegano', 'gluten free': 'sin gluten', halal: 'halal', kosher: 'kosher', spicy: 'picante' };
/** Customer-facing menu list with category chips, allergen filter and Spanish names; tap an item to add it (or pick options). */
export function GuestMenu({ items, currency, onAdd, lang = 'en', viewOnly = false }) {
  const es = lang === 'es';
  const nm = (i) => (es && i.i18n?.es?.name) || i.name;
  const catName = (c) => (es && items.find((i) => i.category === c && i.i18n?.es?.category)?.i18n.es.category) || c;
  const [cat, setCat] = useState('');
  const [avoid, setAvoid] = useState([]);
  const [showFilter, setShowFilter] = useState(false);
  const [picking, setPicking] = useState(null);
  const cats = useMemo(() => [...new Set(items.map((i) => i.category))], [items]);
  const present = useMemo(() => [...new Set(items.flatMap((i) => i.allergens || []))], [items]);
  const shown = (cat ? items.filter((i) => i.category === cat) : items).filter((i) => !avoid.some((a) => (i.allergens || []).includes(a)));
  const tap = (i) => (viewOnly ? null : i.groups?.length ? setPicking(i) : onAdd({ itemId: i.id, qty: 1, mods: [], name: nm(i), modNames: [], unitCents: i.price_cents }));
  return (
    <>
      {cats.length > 1 && <div className="cat-strip">{['', ...cats].map((c) => <button key={c || 'all'} className={`btn sm ${cat === c ? 'primary' : ''}`} onClick={() => setCat(c)}>{c ? catName(c) : es ? 'Todo' : 'All'}</button>)}
        {present.length > 0 && <button className={`btn sm ${avoid.length ? 'primary' : 'ghost'}`} onClick={() => setShowFilter(!showFilter)} aria-expanded={showFilter}>{es ? 'Alergias' : 'Allergies'}{avoid.length ? ` (${avoid.length})` : ''}</button>}</div>}
      {showFilter && <div className="card allergy-filter"><span className="muted" style={{ fontSize: 13 }}>{es ? 'Ocultar platillos con:' : 'Hide dishes that contain:'}</span><div className="row wrap" style={{ gap: 6 }}>{present.map((a) => <button key={a} className={`chip ${avoid.includes(a) ? 'rose' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={avoid.includes(a)} onClick={() => setAvoid(avoid.includes(a) ? avoid.filter((x) => x !== a) : [...avoid, a])}>{es ? ALLERGY_ES[a] : a}</button>)}</div><span className="dim" style={{ fontSize: 12 }}>{es ? 'Avise al personal sobre alergias graves.' : 'Always tell the team about serious allergies.'}</span></div>}
      <div className="sheet-list">
        {(cat ? [cat] : cats).map((c) => { const list = shown.filter((i) => i.category === c); if (!list.length) return null; return (
          <section key={c}>
            <h3 className="sheet-cat">{catName(c)}</h3>
            {list.map((i) => (
              <button key={i.id} className="menu-line menu-tap" disabled={i.soldOut || viewOnly} onClick={() => tap(i)}>
                <span className="grow"><b>{nm(i)}</b>
                  {((es && i.i18n?.es?.description) || i.description) && <small className="menu-desc">{(es && i.i18n?.es?.description) || i.description}</small>}
                  <span className="muted num">{i.soldOut ? (es ? 'Agotado' : 'Sold out') : money(i.price_cents, currency)}{i.groups?.length ? (es ? ', opciones' : ', options') : ''}</span>
                  {((i.diet || []).length > 0 || (i.allergens || []).length > 0) && <span className="tags-line">{(i.diet || []).map((t) => <span key={t} className="mini diet">{es ? DIET_ES[t] : t}</span>)}{(i.allergens || []).map((t) => <span key={t} className="mini">{es ? ALLERGY_ES[t] : t}</span>)}</span>}
                </span>
                {!viewOnly && <span className="add-dot" aria-hidden="true">+</span>}
              </button>
            ))}
          </section>
        ); })}
      </div>
      {picking && <ModPicker item={picking} currency={currency} onClose={() => setPicking(null)} onAdd={(l) => { onAdd(l); setPicking(null); }} />}
    </>
  );
}

/** "Goes great with" suggestions from what customers often order together. */
let pairsCache = null;
export function PairsHint({ cart, items, currency, onPick, label = 'Goes great with' }) {
  const [pairs, setPairs] = useState(pairsCache);
  useEffect(() => { if (!pairsCache) api('/public/pairs').then((p) => { pairsCache = p; setPairs(p); }).catch(() => {}); }, []);
  if (!pairs || !items || !cart.lines.length) return null;
  const inCart = new Set(cart.lines.map((l) => l.itemId));
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const ids = [];
  for (const l of cart.lines) for (const id of pairs[l.itemId] || []) if (!inCart.has(id) && !ids.includes(id) && byId[id] && !byId[id].soldOut) ids.push(id);
  if (!ids.length) return null;
  const pick = (m) => (onPick ? onPick(m) : m.groups?.length ? null : cart.add({ itemId: m.id, qty: 1, mods: [], name: m.name, modNames: [], unitCents: m.price_cents }));
  return (
    <div className="pairs" aria-label={label}>
      <span className="dim" style={{ fontSize: 12.5 }}>{label}</span>
      {ids.slice(0, 3).filter((id) => onPick || !byId[id].groups?.length).map((id) => <button key={id} className="btn sm" onClick={() => pick(byId[id])}>+ {byId[id].name} <span className="dim">{money(byId[id].price_cents, currency)}</span></button>)}
    </div>
  );
}
