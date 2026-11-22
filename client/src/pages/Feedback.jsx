import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import Aurora from '../bits/Aurora.jsx';
import { api, applyAccent, timeOf } from '../lib.js';
import { Puck } from '../ui.jsx';
import { PageHead, useLive } from './CommandCenter.jsx';
import { ReviewThemes } from './Smart.jsx';
import { DishRatings } from './Pass.jsx';

/* ---------- guest: rate the visit ---------- */
export function RateVisit() {
  const { token } = useParams();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const [liked, setLiked] = useState({});
  useEffect(() => { api(`/f/${token}`).then((x) => { setD(x); applyAccent(x.business.accent); if (x.rating) setRating(x.rating); setSent(x.done); }).catch((e) => setErr(e.message)); }, [token]);
  const [offer, setOffer] = useState(null);
  const send = async () => { try { const r = await api(`/f/${token}`, { method: 'POST', body: { rating, comment: comment || undefined, dishes: Object.entries(liked).map(([name, v]) => ({ name, liked: v })) } }); setOffer(r.recovery || null); setSent(true); } catch (e) { setErr(e.message); } };
  if (err) return <div className="guest"><main className="guest-in"><h1>Thanks!</h1><p>{err}</p></main></div>;
  if (!d) return <div className="guest" />;
  const happy = rating >= d.threshold;
  return (
    <div className="guest">
      <div className="guest-bg"><Aurora colorStops={[d.business.accent, '#2a1f55', d.business.accent]} amplitude={0.6} speed={0.35} mouseInteraction={false} /></div>
      <main className="guest-in">
        {d.business.logo ? <img className="guest-logo" src={d.business.logo} alt={d.business.name} /> : <Puck state="buzzed" size={48} />}
        {!sent ? (
          <>
            <div style={{ display: 'grid', gap: 8 }}><h1>How was your visit, {d.name}?</h1><p>Tap a star. Your answer goes straight to the {d.business.name} team.</p></div>
            <div className="stars" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => <button key={n} role="radio" aria-checked={rating === n} aria-label={`${n} star${n > 1 ? 's' : ''}`} className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}>★</button>)}
            </div>
            {rating > 0 && (
              <div className="card">
                <label className="field"><span>{happy ? 'What did you like? (optional)' : 'What could we do better? (optional)'}</span><textarea className="input" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={600} /></label>
                {d.dishes?.length > 0 && <div className="stack" style={{ gap: 6 }}><span className="muted" style={{ fontSize: 14 }}>How was each dish? (optional)</span>{d.dishes.map((x) => <div key={x.name} className="row"><span className="grow">{x.name}</span><button type="button" className={`btn sm ${liked[x.name] === 1 ? 'primary' : ''}`} aria-pressed={liked[x.name] === 1} onClick={() => setLiked({ ...liked, [x.name]: 1 })}>Loved it</button><button type="button" className={`btn sm ${liked[x.name] === 0 ? 'primary' : ''}`} aria-pressed={liked[x.name] === 0} onClick={() => setLiked({ ...liked, [x.name]: 0 })}>Not great</button></div>)}</div>}
                <button className="btn primary lg block" onClick={send}>Send</button>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 8 }}><h1>Thank you!</h1><p>{happy ? "We're so glad you had a good time." : "We're sorry it wasn't great. A manager will read this personally."}</p></div>
            {offer && <div className="card stack" style={{ textAlign: 'center' }}><span>{offer.text}</span><b style={{ fontSize: 26, letterSpacing: 1 }}>{offer.code}</b><button className="btn block" onClick={() => navigator.clipboard?.writeText(offer.code)}>Copy code</button></div>}
            {happy && d.reviewUrl && (
              <a className="btn primary lg block" href={d.reviewUrl} target="_blank" rel="noopener noreferrer" onClick={() => api(`/f/${token}/review`, { method: 'POST' }).catch(() => {})}>Share it in a review</a>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ---------- staff: what guests said ---------- */
export function FeedbackAdmin() {
  const [d] = useLive(['feedback'], () => api('/staff/feedback'));
  if (!d) return null;
  const total = Object.values(d.dist).reduce((a, b) => a + b, 0) || 1;
  return (
    <>
      <PageHead title="Guest feedback" sub="Guests get a short rating request on their phone after their visit. Happy guests are pointed to your review page. Unhappy ones come only to you." />
      <div className="kpis">
        <div className="kpi"><div className="v">{d.stats.avg ? d.stats.avg.toFixed(1) : '–'}<small style={{ fontSize: '1rem' }}> / 5</small></div><div className="l">Average rating, all time</div></div>
        <div className="kpi"><div className="v">{d.stats.avg7 ? d.stats.avg7.toFixed(1) : '–'}</div><div className="l">Last 7 days</div></div>
        <div className="kpi"><div className="v">{d.stats.sent ? Math.round(((d.stats.answered || 0) / d.stats.sent) * 100) : 0}%</div><div className="l">Of {d.stats.sent || 0} guests answered</div></div>
        <div className="kpi"><div className="v">{d.stats.reviews || 0}</div><div className="l">Sent to your review page</div></div>
      </div>
      <div className="grid-2" style={{ marginTop: 18 }}>
        <section className="panel"><div className="panel-h"><h3>Comments</h3></div>
          {d.rows.length ? <table className="list"><tbody>{d.rows.map((r, i) => (
            <tr key={i}><td style={{ width: 90 }}><span className={`chip ${r.rating >= 4 ? 'teal' : r.rating <= 2 ? 'rose' : 'amber'}`}>{'★'.repeat(r.rating)}</span></td>
              <td><b>{r.name}</b>{r.table_label ? <span className="muted">, table {r.table_label}</span> : null}<div className="muted" style={{ fontSize: 14 }}>{r.comment || 'No comment'}</div></td>
              <td className="dim num" style={{ whiteSpace: 'nowrap' }}>{new Date(r.responded_at.replace(' ', 'T') + 'Z').toLocaleDateString([], { month: 'short', day: 'numeric' })} {timeOf(r.responded_at)}</td></tr>
          ))}</tbody></table> : <div className="panel-b muted">No feedback yet. Requests go out about an hour after a party is seated.</div>}
        </section>
        <section className="panel"><div className="panel-h"><h3>Ratings</h3></div><div className="panel-b stack" style={{ gap: 8 }}>
          {[5, 4, 3, 2, 1].map((n) => (
            <div key={n} className="row"><span style={{ width: 28 }}>{n}★</span><div className="meter grow"><span style={{ width: `${((d.dist[n] || 0) / total) * 100}%` }} /></div><span className="num muted" style={{ width: 30, textAlign: 'right' }}>{d.dist[n] || 0}</span></div>
          ))}
          <p className="muted" style={{ margin: '10px 0 0', fontSize: 14 }}>Quoted waits {d.wait.learned ? `are learned from ${d.wait.samples} recent parties, about ${d.wait.perPlace} minutes per place in line.` : 'use your setting until about 8 parties have been seated. Then they learn from real data.'}</p>
        </div></section>
      </div>
      <ReviewThemes />
      <DishRatings />
    </>
  );
}
