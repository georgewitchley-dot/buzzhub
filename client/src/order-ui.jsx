// Shared ordering pieces: option picker, cart helpers, a customer-facing menu.
import { useEffect, useMemo, useState } from 'react';
import { api, money } from './lib.js';
import { Modal } from './ui.jsx';
import { tr } from './i18n.jsx';

export const lineKey = (l) => `${l.comboId ? `c${l.comboId}:${JSON.stringify(l.picks)}` : l.itemId}:${(l.mods || []).slice().sort().join(',')}:${l.note || ''}:${l.course || 1}:${l.seat || ''}`;
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
  const payload = lines.map((l) => (l.comboId ? { comboId: l.comboId, picks: l.picks, qty: l.qty, note: l.note, course: l.course > 1 ? l.course : undefined, seat: l.seat || undefined } : { itemId: l.itemId, qty: l.qty, mods: l.mods?.length ? l.mods : undefined, note: l.note, course: l.course > 1 ? l.course : undefined, seat: l.seat || undefined }));
  return { lines, add, bump, clear, subtotal, payload, count: lines.reduce((a, l) => a + l.qty, 0) };
}

export function CartLines({ cart, currency }) {
  return cart.lines.map((l) => (
    <div className="line" key={lineKey(l)}>
      <span className="qty"><button onClick={() => cart.bump(lineKey(l), -1)} aria-label={`Remove one ${l.name}`}>−</button><span>{l.qty}</span><button onClick={() => cart.bump(lineKey(l), 1)} aria-label={`Add one ${l.name}`}>+</button></span>
      <span>{l.seat ? <span className="chip" style={{ marginRight: 6, fontSize: 11 }}>S{l.seat}</span> : null}{l.name}{l.course > 1 && <span className="chip amber" style={{ marginLeft: 6, fontSize: 11 }}>Held</span>}{(l.modNames?.length || l.note) && <small className="mods">{[...(l.modNames || []), l.note].filter(Boolean).join(', ')}</small>}</span>
      <span className="num">{money(lineTotal(l), currency)}</span>
    </div>
  ));
}

const ALLERGY_ES = { milk: 'leche', eggs: 'huevo', fish: 'pescado', shellfish: 'mariscos', 'tree nuts': 'nueces', peanuts: 'cacahuate', wheat: 'trigo', soy: 'soya', sesame: 'ajonjolí' };
const DIET_ES = { vegetarian: 'vegetariano', vegan: 'vegano', 'gluten free': 'sin gluten', halal: 'halal', kosher: 'kosher', spicy: 'picante' };
/** Customer-facing menu list with category chips, allergen filter and Spanish names; tap an item to add it (or pick options). */
export function GuestMenu({ items, currency, onAdd, lang = 'en', viewOnly = false, combos = [] }) {
  const es = lang === 'es'; const L = lang !== 'en' ? lang : null; const T = (k) => tr(lang, k);
  const nm = (i) => (L && i.i18n?.[L]?.name) || i.name;
  const catName = (c) => (L && items.find((i) => i.category === c && i.i18n?.[L]?.category)?.i18n[L].category) || c;
  const [cat, setCat] = useState('');
  const [avoid, setAvoid] = useState([]);
  const [showFilter, setShowFilter] = useState(false);
  const [picking, setPicking] = useState(null);
  const [combo, setCombo] = useState(null);
  const specials = items.filter((i) => i.special && !i.soldOut);
  const cats = useMemo(() => [...new Set(items.map((i) => i.category))], [items]);
  const present = useMemo(() => [...new Set(items.flatMap((i) => i.allergens || []))], [items]);
  const shown = (cat ? items.filter((i) => i.category === cat) : items).filter((i) => !avoid.some((a) => (i.allergens || []).includes(a)));
  const tap = (i) => (viewOnly ? null : i.groups?.length ? setPicking(i) : onAdd({ itemId: i.id, qty: 1, mods: [], name: nm(i), modNames: [], unitCents: i.price_cents }));
  return (
    <>
      {cats.length > 1 && <div className="cat-strip">{['', ...cats].map((c) => <button key={c || 'all'} className={`btn sm ${cat === c ? 'primary' : ''}`} onClick={() => setCat(c)}>{c ? catName(c) : T('All')}</button>)}
        {present.length > 0 && <button className={`btn sm ${avoid.length ? 'primary' : 'ghost'}`} onClick={() => setShowFilter(!showFilter)} aria-expanded={showFilter}>{T('Allergies')}{avoid.length ? ` (${avoid.length})` : ''}</button>}</div>}
      {showFilter && <div className="card allergy-filter"><span className="muted" style={{ fontSize: 13 }}>{T('Hide dishes that contain:')}</span><div className="row wrap" style={{ gap: 6 }}>{present.map((a) => <button key={a} className={`chip ${avoid.includes(a) ? 'rose' : ''}`} style={{ border: 0, cursor: 'pointer' }} aria-pressed={avoid.includes(a)} onClick={() => setAvoid(avoid.includes(a) ? avoid.filter((x) => x !== a) : [...avoid, a])}>{es ? ALLERGY_ES[a] : a}</button>)}</div><span className="dim" style={{ fontSize: 12 }}>{T('Always tell the team about serious allergies.')}</span></div>}
      <div className="sheet-list">
        {!cat && specials.length > 0 && <section><h3 className="sheet-cat">{T("Today's specials")}</h3>
          {specials.map((i) => <button key={i.id} className="menu-line menu-tap special-line" disabled={viewOnly} onClick={() => tap(i)}><span className="grow"><b>{nm(i)}</b>{i.special.note && <small className="menu-desc">{i.special.note}</small>}<PriceTag i={i} currency={currency} /></span>{!viewOnly && <span className="add-dot" aria-hidden="true">+</span>}</button>)}
        </section>}
        {!cat && combos.length > 0 && <section><h3 className="sheet-cat">Combos</h3>
          {combos.map((c) => <button key={c.id} className="menu-line menu-tap" disabled={viewOnly} onClick={() => setCombo(c)}><span className="grow"><b>{c.name}</b><small className="menu-desc">{c.description || c.slots.map((x) => x.label).join(' + ')}</small><span className="muted num">{money(c.priceCents, currency)}</span></span>{!viewOnly && <span className="add-dot" aria-hidden="true">+</span>}</button>)}
        </section>}
        {(cat ? [cat] : cats).map((c) => { const list = shown.filter((i) => i.category === c); if (!list.length) return null; return (
          <section key={c}>
            <h3 className="sheet-cat">{catName(c)}</h3>
            {list.map((i) => (
              <button key={i.id} className="menu-line menu-tap" disabled={i.soldOut || viewOnly} onClick={() => tap(i)}>
                {i.photo && <img className="menu-photo" src={i.photo} alt="" loading="lazy" />}
                <span className="grow"><b>{nm(i)}</b>
                  {((L && i.i18n?.[L]?.description) || i.description) && <small className="menu-desc">{(L && i.i18n?.[L]?.description) || i.description}</small>}
                  <span className="muted num">{i.soldOut ? T('Sold out') : <PriceTag i={i} currency={currency} inline />}{i.groups?.length ? `, ${T('options')}` : ''}{i.calories !== undefined ? ` · ${i.calories} ${T('cal')}` : ''}</span>
                  {((i.diet || []).length > 0 || (i.allergens || []).length > 0) && <span className="tags-line">{(i.diet || []).map((t) => <span key={t} className="mini diet">{es ? DIET_ES[t] : t}</span>)}{(i.allergens || []).map((t) => <span key={t} className="mini">{es ? ALLERGY_ES[t] : t}</span>)}</span>}
                </span>
                {!viewOnly && <span className="add-dot" aria-hidden="true">+</span>}
              </button>
            ))}
          </section>
        ); })}
      </div>
      {picking && <ModPicker item={picking} currency={currency} onClose={() => setPicking(null)} onAdd={(l) => { onAdd(l); setPicking(null); }} />}
      {combo && <ComboPicker combo={combo} items={items} currency={currency} onClose={() => setCombo(null)} onAdd={(l) => { onAdd(l); setCombo(null); }} />}
    </>
  );
}

/** Price with the regular price struck through during a deal or special. */
export function PriceTag({ i, currency, inline = false }) {
  if (!i.regularCents) return inline ? money(i.price_cents, currency) : <span className="muted num">{money(i.price_cents, currency)}</span>;
  const body = <><s className="dim">{money(i.regularCents, currency)}</s> <b style={{ color: 'var(--accent)' }}>{money(i.price_cents, currency)}</b>{i.deal && <span className="mini diet" style={{ marginLeft: 6 }}>{i.deal}</span>}</>;
  return inline ? body : <span className="num">{body}</span>;
}

/** Build a combo: one choice per slot, with options. onAdd(cart line). */
export function ComboPicker({ combo, items, currency, onClose, onAdd }) {
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  const [picks, setPicks] = useState(() => combo.slots.map((s) => ({ itemId: s.itemIds.length === 1 ? s.itemIds[0] : null, mods: [] })));
  const [qty, setQty] = useState(1);
  const setPick = (k, v) => setPicks((p) => p.map((x, i) => (i === k ? { ...x, ...v } : x)));
  const toggleMod = (k, g, o) => { const cur = picks[k].mods; const inG = g.options.map((x) => x.id); const mine = cur.filter((x) => inG.includes(x));
    let next = mine.includes(o.id) ? mine.filter((x) => x !== o.id) : g.max === 1 ? [o.id] : mine.length < g.max ? [...mine, o.id] : mine;
    if (g.max === 1 && mine.includes(o.id) && g.min > 0) next = mine;
    setPick(k, { mods: [...cur.filter((x) => !inG.includes(x)), ...next] }); };
  const modObjs = (p) => (byId[p.itemId]?.groups || []).flatMap((g) => g.options.filter((o) => p.mods.includes(o.id)));
  const extra = picks.reduce((a, p) => a + modObjs(p).reduce((b, o) => b + o.price_cents, 0), 0);
  const missing = picks.findIndex((p) => !p.itemId || (byId[p.itemId]?.groups || []).some((g) => g.options.filter((o) => p.mods.includes(o.id)).length < g.min));
  const add = () => onAdd({ comboId: combo.id, picks: picks.map((p) => ({ itemId: p.itemId, mods: p.mods })), qty, name: combo.name, modNames: picks.map((p) => [byId[p.itemId]?.name, ...modObjs(p).map((o) => o.name)].join(' ')), unitCents: combo.priceCents + extra });
  return (
    <Modal title={combo.name} onClose={onClose}>
      {combo.slots.map((s, k) => (
        <div key={k} className="field"><span>{s.label}</span>
          <div className="opt-grid">{s.itemIds.map((id) => byId[id] && <button key={id} type="button" className={`opt ${picks[k].itemId === id ? 'on' : ''}`} aria-pressed={picks[k].itemId === id} onClick={() => setPick(k, { itemId: id, mods: [] })}>{byId[id].name}</button>)}</div>
          {(byId[picks[k].itemId]?.groups || []).map((g) => (
            <div key={g.id} className="opt-grid" style={{ marginTop: 6 }}><small className="dim" style={{ gridColumn: '1 / -1' }}>{g.name}{g.min ? ' (required)' : ''}</small>
              {g.options.map((o) => { const on = picks[k].mods.includes(o.id); return <button key={o.id} type="button" className={`opt ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggleMod(k, g, o)}>{o.name}{o.price_cents ? <small>+{money(o.price_cents, currency)}</small> : null}</button>; })}</div>
          ))}
        </div>
      ))}
      <div className="row">
        <span className="qty"><button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="One less">−</button><span>{qty}</span><button type="button" onClick={() => setQty(Math.min(20, qty + 1))} aria-label="One more">+</button></span>
        <button className="btn primary lg grow" disabled={missing >= 0} onClick={add}>{missing >= 0 ? `Choose ${combo.slots[missing].label.toLowerCase()}` : `Add ${qty} for ${money((combo.priceCents + extra) * qty, currency)}`}</button>
      </div>
    </Modal>
  );
}

/** Live combos for a customer page. */
export function useCombos(all = false) {
  const [c, setC] = useState([]);
  useEffect(() => { api(all ? '/public/combos/all' : '/public/combos').then(setC).catch(() => {}); }, [all]);
  return c;
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
  const shown = ids.filter((id) => onPick || !byId[id].groups?.length).slice(0, 3);
  if (!shown.length) return null;
  const pick = (m) => (onPick ? onPick(m) : m.groups?.length ? null : cart.add({ itemId: m.id, qty: 1, mods: [], name: m.name, modNames: [], unitCents: m.price_cents }));
  return (
    <div className="pairs" aria-label={label}>
      <span className="dim" style={{ fontSize: 12.5 }}>{label}</span>
      {shown.map((id) => <button key={id} className="btn sm" onClick={() => pick(byId[id])}>+ {byId[id].name} <span className="dim">{money(byId[id].price_cents, currency)}</span></button>)}
    </div>
  );
}
