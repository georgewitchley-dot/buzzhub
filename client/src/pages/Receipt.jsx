import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib.js';
import { ReceiptBody } from '../pro-ui.jsx';

export default function Receipt() {
  const { token } = useParams();
  const [r, setR] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/r/${token}`).then((x) => { setR(x); document.title = `Receipt #${x.number}, ${x.business.name}`; }).catch((e) => setErr(e.message)); }, [token]);
  if (err) return <div className="receipt-page"><div className="receipt"><h2>Receipt not found</h2><p className="receipt-meta">{err}</p></div></div>;
  if (!r) return <div className="receipt-page" />;
  return (
    <div className="receipt-page">
      <div className="stack" style={{ width: '100%', maxWidth: 360 }}>
        <ReceiptBody r={{ ...r, token }} />
        <button className="btn no-print" onClick={() => window.print()}>Print or save as PDF</button>
        <a className="btn primary no-print" href={`/account${location.search}`}>Join our rewards and rate your visit</a>
      </div>
    </div>
  );
}
