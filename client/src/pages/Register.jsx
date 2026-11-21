import { useEffect, useRef, useState } from 'react';
import { ReaderCharge } from '../pro-ui.jsx';
import { CustomerPicker } from './Club.jsx';
import { gsap } from 'gsap';
import SpotlightCard from '../bits/SpotlightCard.jsx';
import ClickSpark from '../bits/ClickSpark.jsx';
import { api, money } from '../lib.js';
import { Icon, Modal, useToast } from '../ui.jsx';
import { CartLines, ComboPicker, ModPicker, PairsHint, PriceTag, useCart } from '../order-ui.jsx';
import { GoalBar, PairDisplay, useDisplayPush, useLiveCombos } from './Plus.jsx';
import { PunchUse, SellPunch, applyPunches } from './More.jsx';
import { PageHead, useCC, useLive } from './CommandCenter.jsx';
import { QrModal, RedeemModal } from './Waitlist.jsx';
import { queueSale, attachPayment, isNetworkError } from '../offline.js';

const dollars = (v) => Math.round(Number(String(v).replace(/[^\d.]/g, '') || 0) * 100);

/* ---------- split a check: record each share by cash/card, or let each person pay by phone ---------- */
export function SplitModal({ order, tableId, currency, onClose }) {
  const toast = useToast();
  const [bill, setBill] = useState(null);
  const [mode, setMode] = useState('even');
  const [ways, setWays] = useState(2);
  const [picked, setPicked] = useState([]);
  const [method, setMethod] = useState('card');
  const [tip, setTip] = useState('');
  const [qr, setQr] = useState(null);
  useEffect(() => { api('/staff/bills', { method: 'POST', body: tableId ? { tableId } : { orderId: order.id } }).then(setBill).catch((e) => toast(e.message, 'err')); }, [tableId, order?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!bill) return null;
  const share = mode === 'even' ? Math.min(bill.remainingCents, Math.ceil(bill.dueCents / ways)) : mode === 'items' ? Math.min(bill.remainingCents, bill.items.filter((i) => picked.includes(i.id)).reduce((a, i) => a + i.shareCents, 0)) : bill.remainingCents;
  const record = async () => {
    try {
      const r = await api(`/staff/bills/${bill.id}/payments`, { method: 'POST', body: { split: mode, ways: mode === 'even' ? ways : undefined, itemIds: mode === 'items' ? picked : undefined, method, tipCents: dollars(tip) } });
      setBill({ ...bill, ...r }); setPicked([]); setTip('');
      toast(r.status === 'paid' ? 'Check fully paid' : `Recorded. ${money(r.remainingCents, currency)} left`, 'ok');
      if (r.status === 'paid') onClose();
    } catch (e) { toast(e.message, 'err'); }
  };
  const showQr = async () => { try { setQr(await api(`/staff/bills/${bill.id}/qr`)); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title={`Split ${bill.table ? `table ${bill.table}` : `#${bill.numbers.join(', #')}`}`} onClose={onClose} width={540}>
      <div className="totals" style={{ paddingTop: 0 }}>
        <div><span>Check</span><span>{money(bill.dueCents, currency)}</span></div>
        <div><span>Paid so far</span><span>{money(bill.paidCents, currency)}</span></div>
        <div className="grand"><span>Left to pay</span><span>{money(bill.remainingCents, currency)}</span></div>
      </div>
      <div className="seg" style={{ width: '100%' }}>
        {[['even', 'Split evenly'], ['items', 'By item'], ['full', 'The rest']].map(([k, l]) => <button key={k} aria-pressed={mode === k} onClick={() => setMode(k)} style={{ flex: 1 }}>{l}</button>)}
      </div>
      {mode === 'even' && <div className="row"><span className="muted grow">How many people?</span>{[2, 3, 4, 5, 6].map((n) => <button key={n} className={`btn sm ${ways === n ? 'primary' : ''}`} onClick={() => setWays(n)} style={{ width: 40 }}>{n}</button>)}</div>}
      {mode === 'items' && (
        <div className="stack" style={{ gap: 4, maxHeight: 240, overflow: 'auto' }}>
          {bill.items.map((i) => (
            <label key={i.id} className="row" style={{ opacity: i.paid ? 0.45 : 1, fontSize: 14 }}>
              <input type="checkbox" disabled={i.paid || i.claimed} checked={picked.includes(i.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))} />
              <span className="grow">{i.qty} × {i.name}{i.mods.length ? ` (${i.mods.map((m) => m.name).join(', ')})` : ''}</span>
              <span className="num">{i.paid ? 'Paid' : money(i.shareCents, currency)}</span>
            </label>
          ))}
        </div>
      )}
      <div className="row">
        <div className="seg">{['card', 'cash', 'other'].map((m) => <button key={m} aria-pressed={method === m} onClick={() => setMethod(m)} style={{ textTransform: 'capitalize' }}>{m}</button>)}</div>
        <input className="input grow" inputMode="decimal" placeholder="Tip" value={tip} onChange={(e) => setTip(e.target.value)} aria-label="Tip for this share" />
      </div>
      {method === 'card' && share > 0 && <ReaderCharge currency={currency} label={`Charge ${money(share + dollars(tip), currency)} on reader`} body={{ billId: bill.id, split: mode, ways: mode === 'even' ? ways : undefined, itemIds: mode === 'items' ? picked : undefined, tipCents: dollars(tip) }} onPaid={() => api('/staff/bills', { method: 'POST', body: tableId ? { tableId } : { orderId: order.id } }).then((b) => { setBill(b); setPicked([]); setTip(''); if (b.status === 'paid' || b.remainingCents <= 0) onClose(); })} />}
      <button className="btn primary lg block" disabled={share <= 0} onClick={record}>Record {money(share, currency)}{tip ? ` + ${money(dollars(tip), currency)} tip` : ''}</button>
      {bill.payments.length > 0 && <div className="dim" style={{ fontSize: 13 }}>{bill.payments.map((p, i) => <div key={i}>{p.label}: {money(p.amountCents, currency)} by {p.method}{p.tipCents ? ` + ${money(p.tipCents, currency)} tip` : ''}</div>)}</div>}
      {!qr ? <button className="btn block" onClick={showQr}>Let everyone pay their share by phone</button> : (
        <div className="stack"><p className="muted" style={{ margin: 0, fontSize: 14 }}>Each person scans, chooses their share or their items, tips and pays. Shares already paid are crossed off.</p><div className="qr" dangerouslySetInnerHTML={{ __html: qr.svg }} /></div>
      )}
    </Modal>
  );
}

export function PayModal({ order, currency, onClose, onPaid }) {
  const toast = useToast();
  const [phone, setPhone] = useState(null);
  const [split, setSplit] = useState(false);
  const [giftCode, setGiftCode] = useState('');
  const [giftOpen, setGiftOpen] = useState(false);
  const [applied, setApplied] = useState(order.gift_cents || 0);
  const payByPhone = async (notify) => { try { const r = await api(`/staff/orders/${order.id}/paylink`, { method: 'POST', body: { notify, wholeTable: Boolean(order.table_id) } }); setPhone(r); if (notify) toast(r.pushed ? 'Sent the check to their phone' : 'They have no phone alerts on. Show them the code instead.', r.pushed ? 'ok' : 'err'); } catch (e) { toast(e.message, 'err'); } };
  const base = order.subtotal_cents - order.discount_cents + order.tax_cents + (order.fee_cents || 0) - applied;
  const [method, setMethod] = useState('card');
  const [tipPct, setTipPct] = useState(0);
  const [customTip, setCustomTip] = useState('');
  const [tendered, setTendered] = useState('');
  const [busy, setBusy] = useState(false);
  const tip = customTip !== '' ? dollars(customTip) : Math.round((order.subtotal_cents - order.discount_cents) * tipPct / 100);
  const { socket } = useCC();
  useEffect(() => {
    if (!socket) return undefined;
    const on = (x) => { let code = ''; try { code = localStorage.getItem('bh_display') || ''; } catch { /* none */ } if (x.code !== code) return; if (x.cents !== null) setCustomTip((x.cents / 100).toFixed(2)); else { setCustomTip(''); setTipPct(x.pct || 0); } toast('The customer picked a tip', 'ok'); };
    socket.on('display:tip', on); return () => socket.off('display:tip', on);
  }, [socket]); // eslint-disable-line react-hooks/exhaustive-deps
  const cashPct = Number(useCC().settings.cash_discount_pct) || 0;
  const cashOff = method === 'cash' && cashPct > 0 && !order.offlineKey ? Math.round((order.subtotal_cents - order.discount_cents) * cashPct / 100 * (1 + (Number(useCC().settings.tax_rate) || 0) / 100)) : 0;
  const total = base + tip - cashOff;
  const tenderedCents = tendered === '' ? undefined : dollars(tendered);
  const pay = async () => {
    if (order.offlineKey) { attachPayment(order.offlineKey, { method, tipCents: tip, tenderedCents: method === 'cash' ? tenderedCents : undefined }); toast(`Offline: ${money(total, currency)} ${method} saved. It syncs when the connection is back.`, 'ok'); onPaid({}); return; }
    setBusy(true);
    try {
      const r = await api(`/staff/orders/${order.id}/pay`, { method: 'POST', body: { method, tipCents: tip, tenderedCents: method === 'cash' ? tenderedCents : undefined } });
      toast(r.changeCents > 0 ? `Paid. Change due ${money(r.changeCents, currency)}` : `Paid ${money(r.totalCents, currency)}`, 'ok');
      onPaid(r);
    } catch (e) {
      toast(isNetworkError(e) ? 'No connection. Try again in a moment, or record it once you are back online.' : e.message, 'err');
    } finally { setBusy(false); }
  };
  const useGift = async () => {
    try {
      const r = await api(`/staff/orders/${order.id}/gift`, { method: 'POST', body: { code: giftCode } });
      setApplied(applied + r.usedCents); setGiftOpen(false); setGiftCode('');
      toast(r.paid ? `Paid in full by gift card. ${money(r.cardBalanceCents, currency)} left on the card.` : `${money(r.usedCents, currency)} taken from the gift card. ${money(r.remainingCents, currency)} still to pay.`, 'ok');
      if (r.paid) onPaid(r);
    } catch (e) { toast(e.message, 'err'); }
  };
  if (split) return <SplitModal order={order} tableId={order.table_id && order.source === 'table' ? order.table_id : null} currency={currency} onClose={() => { setSplit(false); onClose(); }} />;
  return (
    <Modal title={order.offlineKey ? 'Take payment (offline)' : `Take payment for #${order.number}`} onClose={onClose}>
      <div className="seg" role="group" aria-label="Payment method" style={{ width: '100%' }}>
        {['card', 'cash', 'other'].map((m) => <button key={m} aria-pressed={method === m} onClick={() => setMethod(m)} style={{ flex: 1, textTransform: 'capitalize' }}>{m}</button>)}
      </div>
      <div className="field"><span>Tip</span>
        <div className="row wrap">
          {[0, 15, 18, 20, 25].map((p) => <button key={p} className={`btn sm ${customTip === '' && tipPct === p ? 'primary' : ''}`} onClick={() => { setTipPct(p); setCustomTip(''); }}>{p ? `${p}%` : 'None'}</button>)}
          <input className="input" style={{ width: 110, height: 34 }} inputMode="decimal" placeholder="Custom" value={customTip} onChange={(e) => setCustomTip(e.target.value.replace(/[^\d.]/g, ''))} aria-label="Custom tip amount" />
        </div>
      </div>
      {method === 'cash' && (
        <label className="field"><span>Cash received</span>
          <input className="input" inputMode="decimal" value={tendered} onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ''))} placeholder={(total / 100).toFixed(2)} />
          {tenderedCents !== undefined && <span className="num" style={{ color: tenderedCents >= total ? 'var(--seated)' : 'var(--dirty)' }}>{tenderedCents >= total ? `Change ${money(tenderedCents - total, currency)}` : `Short ${money(total - tenderedCents, currency)}`}</span>}
        </label>
      )}
      <div className="totals">
        {order.fee_cents > 0 && <div><span>Delivery fee</span><span>{money(order.fee_cents, currency)}</span></div>}
        {applied > 0 && <div><span>Gift card</span><span>−{money(applied, currency)}</span></div>}
        {cashOff > 0 && <div><span>Cash discount ({cashPct}%)</span><span>−{money(cashOff, currency)}</span></div>}
        <div><span>Before tip</span><span>{money(base, currency)}</span></div>
        <div><span>Tip</span><span>{money(tip, currency)}</span></div>
        <div className="grand"><span>Total</span><span>{money(total, currency)}</span></div>
      </div>
      {method === 'card' && order.id && !order.offlineKey && <ReaderCharge currency={currency} label={`Charge ${money(total, currency)} on reader`} body={{ orderId: order.id, split: 'full', tipCents: tip }} onPaid={(s) => onPaid({ totalCents: s.amountCents })} />}
      {method === 'card' && <p className="dim" style={{ margin: 0, fontSize: 13 }}>No card reader? Run the card on your own terminal, then record it here.</p>}
      <button className="btn primary lg block" onClick={pay} disabled={busy}>{busy ? 'Recording…' : `Record ${money(total, currency)} paid`}</button>
      {order.id && !order.offlineKey && (
        <div className="row wrap">
          <button className="btn grow" onClick={() => setSplit(true)}>Split check</button>
          <button className="btn grow" onClick={() => setGiftOpen(!giftOpen)}><Icon name="gift" size={16} />Gift card</button>
        </div>
      )}
      {giftOpen && <div className="row"><input className="input grow" inputMode="numeric" placeholder="Gift card code" value={giftCode} onChange={(e) => setGiftCode(e.target.value)} aria-label="Gift card code" /><button className="btn primary" disabled={giftCode.replace(/\D/g, '').length < 16} onClick={useGift}>Apply</button></div>}
      {order.id && !order.offlineKey && (!phone ? (
        <div className="row"><button className="btn grow" onClick={() => payByPhone(false)}>Let them pay by phone</button>{order.guest_id && <button className="btn grow" onClick={() => payByPhone(true)}>Send check to their phone</button>}</div>
      ) : (
        <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          {phone.cardsEnabled ? <p className="muted" style={{ margin: 0, fontSize: 14 }}>They scan this, can split it, add a tip and pay with card, Apple Pay or Google Pay. The order closes on its own when it's paid.</p>
            : <p className="muted" style={{ margin: 0, fontSize: 14 }}>Card payments aren't connected yet, so this page only shows the bill. An owner can connect Stripe in Settings.</p>}
          <div className="qr" dangerouslySetInnerHTML={{ __html: phone.svg }} />
          <input className="input" readOnly value={phone.link} onFocus={(e) => e.target.select()} aria-label="Pay link" />
        </div>
      ))}
    </Modal>
  );
}

function SellGiftModal({ currency, canComp, onClose }) {
  const [bonus, setBonus] = useState(null);
  const toast = useToast();
  const [amount, setAmount] = useState(25);
  const [custom, setCustom] = useState('');
  const [method, setMethod] = useState('card');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(null);
  const cents = custom ? dollars(custom) : amount * 100;
  const sell = async () => { try { const r = await api('/staff/giftcards', { method: 'POST', body: { amountCents: cents, method, name: name || undefined, email: email || undefined } }); setDone(r.code); setBonus(r.bonus || null); } catch (e) { toast(e.message, 'err'); } };
  return (
    <Modal title="Sell a gift card" onClose={onClose}>
      {done ? (
        <>
          <p className="muted" style={{ margin: 0 }}>Write this code on a card or give it to the customer. {email ? 'We also emailed it if email is set up.' : ''}</p>
          <div className="reward-code num">{done}</div>
          {bonus && <><p className="muted" style={{ margin: 0 }}>{bonus.promo}: they also get a {money(bonus.cents, currency)} bonus card{bonus.validFrom ? `, good from ${bonus.validFrom}` : ''}{bonus.validUntil ? ` until ${bonus.validUntil}` : ''}.</p><div className="reward-code num">{bonus.code}</div></>}
          <button className="btn primary block" onClick={onClose}>Done</button>
        </>
      ) : (
        <>
          <div className="row wrap">{[10, 25, 50, 100].map((a) => <button key={a} className={`btn ${!custom && amount === a ? 'primary' : ''}`} onClick={() => { setAmount(a); setCustom(''); }}>{money(a * 100, currency)}</button>)}
            <input className="input" style={{ width: 110 }} inputMode="decimal" placeholder="Other" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Other amount" /></div>
          <div className="seg" style={{ width: '100%' }}>{[['card', 'Card'], ['cash', 'Cash'], ['other', 'Other'], ...(canComp ? [['comp', 'Free']] : [])].map(([m, l]) => <button key={m} aria-pressed={method === m} onClick={() => setMethod(m)} style={{ flex: 1 }}>{l}</button>)}</div>
          <div className="row"><input className="input grow" placeholder="For (optional)" value={name} onChange={(e) => setName(e.target.value)} /><input className="input grow" type="email" placeholder="Email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <button className="btn primary lg block" disabled={cents < 100} onClick={sell}>Sell {money(cents, currency)} gift card</button>
        </>
      )}
    </Modal>
  );
}

export default function Register() {
  const { settings, can } = useCC();
  const cur = settings.currency;
  const toast = useToast();
  const [menu] = useLive(['menu'], () => api('/staff/menu/full').then((m) => { try { localStorage.setItem('bh_menu_cache', JSON.stringify(m)); } catch { /* full */ } return m; }).catch((e) => { const c = localStorage.getItem('bh_menu_cache'); if (c) return JSON.parse(c); throw e; }));
  const [tables] = useLive(['tables'], () => api('/staff/tables').catch(() => []));
  const [cat, setCat] = useState('All');
  const cart = useCart();
  const [customer, setCustomer] = useState('');
  const [tableId, setTableId] = useState('');
  const [discount, setDiscount] = useState(0);
  const [promo, setPromo] = useState('');
  const [cust, setCust] = useState(null);
  const [allergies, setAllergies] = useState([]);
  const [buzzer, setBuzzer] = useState(settings.business_type !== 'restaurant');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(null);
  const [qr, setQr] = useState(null);
  const [redeem, setRedeem] = useState(false);
  const [sellGift, setSellGift] = useState(false);
  const [picking, setPicking] = useState(null);
  const [combo, setCombo] = useState(null);
  const [hold, setHold] = useState(false);
  const [pair, setPair] = useState(false);
  const [punchPicks, setPunchPicks] = useState({});
  const [sellPunch, setSellPunch] = useState(false);
  const [thanks, setThanks] = useState(false);
  const combos = useLiveCombos();
  const totalRef = useRef(null);

  const items = (menu || []).filter((m) => m.active || m.soldOut);
  const cats = ['All', ...new Set(items.map((m) => m.category))];
  const shown = cat === 'All' ? items : items.filter((m) => m.category === cat);
  const memberPct = cust?.member?.good ? cust.member.discountPct : 0;
  const disc = Math.round(cart.subtotal * Math.max(discount, memberPct) / 100);
  const tax = Math.round((cart.subtotal - disc) * Number(settings.tax_rate) / 100);
  const total = cart.subtotal - disc + tax;

  const tap = (m) => {
    if (m.soldOut) return;
    const hit = (m.allergens || []).filter((a) => allergies.includes(a));
    if (hit.length && !confirm(`${m.name} contains ${hit.join(' and ')}. Add it anyway?`)) return;
    if (m.groups.length) return setPicking(m);
    cart.add({ itemId: m.id, qty: 1, mods: [], name: m.name, modNames: [], unitCents: m.price_cents, course: hold ? 2 : 1 });
    gsap.fromTo(totalRef.current, { scale: 1.06 }, { scale: 1, duration: 0.3, ease: 'back.out(3)' });
  };
  const addLine = (l) => cart.add({ ...l, course: hold ? 2 : 1 });
  const displayCode = useDisplayPush(paying ? { stage: 'tip', lines: paying.lines || [], subtotalCents: paying.subtotal_cents, discountCents: paying.discount_cents, taxCents: paying.tax_cents, totalCents: paying.subtotal_cents - paying.discount_cents + paying.tax_cents, tipBaseCents: paying.subtotal_cents - paying.discount_cents }
    : thanks ? { stage: 'paid' } : cart.count ? { stage: 'cart', lines: cart.lines.map((l) => ({ name: l.name, qty: l.qty, cents: l.qty * l.unitCents })), subtotalCents: cart.subtotal, discountCents: disc, taxCents: tax, totalCents: total } : { stage: 'idle' });
  const reset = () => { setHold(false); cart.clear(); setCustomer(''); setTableId(''); setDiscount(0); setPhone(''); setPromo(''); setCust(null); setAllergies([]); };

  const submit = async (payNow) => {
    if (!cart.count) return;
    setBusy(true);
    const clientKey = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const body = { items: cart.payload, tableId: tableId ? Number(tableId) : null, customerName: customer || cust?.name || undefined, discountPct: discount || undefined, customerId: cust?.id, allergies: allergies.length ? allergies : undefined, attachBuzzer: buzzer, phone, promoCode: promo || undefined, clientKey };
    try {
      const r = await api('/staff/orders', { method: 'POST', body });
      const pu = Object.values(punchPicks).some((n) => n > 0) ? await applyPunches(r.id, punchPicks) : null;
      if (pu?.error) toast(pu.error, 'err'); else if (pu?.used.length) toast(`Punch card used for ${pu.used.join(', ')}`, 'ok');
      const order = { id: r.id, number: r.number, subtotal_cents: cart.subtotal, discount_cents: pu?.last ? pu.last.discountCents : r.discountCents ?? disc, tax_cents: pu?.last ? pu.last.taxCents : tax, lines: cart.lines.map((l) => ({ name: l.name, qty: l.qty, cents: l.qty * l.unitCents })) };
      reset();
      if (r.buzzer) setQr({ link: r.buzzer.link, svg: r.buzzer.svg, title: `Buzzer for order #${r.number}`, note: 'The customer scans this. Their phone buzzes when you mark the order ready.' });
      if (payNow) setPaying(order); else toast(`Order #${r.number} sent`, 'ok');
    } catch (e) {
      if (isNetworkError(e)) {
        // no connection: keep the sale on this device and send it when we're back online
        const offline = { offlineKey: clientKey, number: 'offline', subtotal_cents: cart.subtotal, discount_cents: disc, tax_cents: tax };
        queueSale({ body: { ...body, attachBuzzer: false }, pay: null });
        reset();
        if (payNow) setPaying(offline); else toast('Offline: sale saved on this device. It sends when the connection is back.', 'ok');
      } else toast(e.message, 'err');
    } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title="Register" sub="Tap items to add them to the ticket.">
        <button className="btn" onClick={() => setSellGift(true)}><Icon name="gift" size={17} />Sell gift card</button>
        <button className="btn" onClick={() => setSellPunch(true)}>Sell punch card</button>
        {settings.loyalty_enabled === '1' && <button className="btn" onClick={() => setRedeem(true)}>Redeem reward</button>}
        <button className="btn" onClick={() => setPair(true)}>{displayCode ? `Display ${displayCode}` : 'Customer display'}</button>
      </PageHead>
      <GoalBar />
      <div className="register">
        <div>
          {combos.length > 0 && <div className="cats">{combos.map((c) => <button key={c.id} className="btn sm" onClick={() => setCombo(c)}>{c.name} {money(c.priceCents, cur)}</button>)}</div>}
          <div className="cats">{cats.map((c) => <button key={c} className={`btn sm ${c === cat ? 'primary' : ''}`} onClick={() => setCat(c)}>{c}</button>)}</div>
          <ClickSpark sparkColor={settings.accent} sparkCount={10} sparkRadius={26}>
            <div className="items">
              {shown.map((m) => (
                <button key={m.id} className="item-btn" onClick={() => tap(m)} disabled={m.soldOut} aria-label={`Add ${m.name}, ${money(m.price_cents, cur)}`} style={m.soldOut ? { opacity: 0.4 } : undefined}>
                  <SpotlightCard className="item-card" spotlightColor={`${m.color}55`} style={{ '--c': m.color }}>
                    <b>{m.name}</b>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="p grow"><PriceTag i={m} currency={cur} inline /></span>{m.special && <span className="chip teal">Special</span>}
                      {m.soldOut ? <span className="chip rose">Sold out</span> : m.stock !== null && m.stock <= m.low_stock ? <span className="chip amber">{m.stock} left</span> : m.groups.length ? <span className="chip">Options</span> : null}
                    </span>
                  </SpotlightCard>
                </button>
              ))}
            </div>
          </ClickSpark>
        </div>

        <aside className="panel ticket">
          <div className="panel-h"><h3 className="grow">Ticket</h3>{cart.count > 0 && <button className="btn ghost sm" onClick={reset}>Clear</button>}</div>
          <div className="panel-b stack">
            {cart.count === 0 ? <p className="muted" style={{ margin: 0 }}>The ticket is empty.</p> : <div><CartLines cart={cart} currency={cur} /><PairsHint cart={cart} items={menu?.items || menu} currency={cur} onPick={tap} label="Suggest" /></div>}
            <div className="row">
              <input className="input grow" placeholder="Customer name" value={customer} onChange={(e) => setCustomer(e.target.value)} maxLength={40} aria-label="Customer name" />
              {settings.business_type === 'restaurant' && (
                <select className="input" style={{ width: 120 }} value={tableId} onChange={(e) => setTableId(e.target.value)} aria-label={settings.unit_label}>
                  <option value="">To go</option>{(tables || []).map((t) => <option key={t.id} value={t.id}>{settings.unit_label} {t.label}</option>)}
                </select>
              )}
            </div>
            <CustomerPicker value={cust} onChange={setCust} allergies={allergies} setAllergies={setAllergies} currency={cur} />
            <PunchUse customer={cust} picks={punchPicks} setPicks={setPunchPicks} />
            <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={buzzer} onChange={(e) => setBuzzer(e.target.checked)} /> Give the customer a phone buzzer for pickup</label>
            {buzzer && <input className="input" type="tel" placeholder="Mobile number (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} aria-label="Mobile number" />}
            {settings.business_type !== 'service' && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={hold} onChange={(e) => setHold(e.target.checked)} /> Hold the next items until I fire them (mains after starters)</label>}
            <div className="row" style={{ fontSize: 14 }}><span className="muted grow">Discount</span>{[0, 10, 15, 50].map((p) => <button key={p} className={`btn sm ${discount === p ? 'primary' : ''}`} onClick={() => setDiscount(p)}>{p}%</button>)}</div>
            <input className="input" placeholder="Promo code (optional)" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} maxLength={30} aria-label="Promo code" />
            <div className="totals">
              <div><span>Subtotal</span><span>{money(cart.subtotal, cur)}</span></div>
              {disc > 0 && <div><span>{memberPct >= discount && memberPct ? `Member price (${memberPct}%)` : 'Discount'}</span><span>−{money(disc, cur)}</span></div>}
              {promo && <div><span>Promo {promo}</span><span>applied at checkout</span></div>}
              <div><span>Tax {settings.tax_rate}%</span><span>{money(tax, cur)}</span></div>
              <div className="grand" ref={totalRef}><span>Total</span><span>{money(total, cur)}</span></div>
            </div>
            <div className="row">
              <button className="btn lg grow" disabled={!cart.count || busy} onClick={() => submit(false)}>Send, pay later</button>
              <button className="btn primary lg grow" disabled={!cart.count || busy} onClick={() => submit(true)}>Charge</button>
            </div>
          </div>
        </aside>
      </div>
      {picking && <ModPicker item={picking} currency={cur} onClose={() => setPicking(null)} onAdd={(l) => { addLine(l); setPicking(null); }} />}
      {combo && <ComboPicker combo={combo} items={items} currency={cur} onClose={() => setCombo(null)} onAdd={(l) => { addLine(l); setCombo(null); }} />}
      {pair && <PairDisplay onClose={() => setPair(false)} />}
      {sellPunch && <SellPunch onClose={() => setSellPunch(false)} />}
      {redeem && <RedeemModal onClose={() => setRedeem(false)} />}
      {sellGift && <SellGiftModal currency={cur} canComp={can('manager')} onClose={() => setSellGift(false)} />}
      {paying && <PayModal order={paying} currency={cur} onClose={() => setPaying(null)} onPaid={() => { setPaying(null); setThanks(true); setTimeout(() => setThanks(false), 6000); }} />}
      {qr && !paying && <QrModal {...qr} onClose={() => setQr(null)} />}
    </>
  );
}
