import { useEffect, useState } from 'react';
import { api, logoUrl } from '../lib';
import { Icon, Modal } from '../ui';

/** Printable door sign: QR with the business logo in the middle (QR uses high error correction so it still scans). */
export function PrintSign({ settings, onClose }: { settings?: any; onClose?: any; }) {
  const [qr, setQr] = useState(null);
  useEffect(() => { api('/staff/join-qr').then(setQr); }, []);
  const logo = settings.logo_version && settings.logo_version !== '0' ? logoUrl(settings.logo_version) : null;
  const service = settings.business_type === 'service';
  const lines = [
    service ? 'Check in and we\'ll buzz your phone when we\'re ready for you.' : 'Get a buzz on your phone when your table is ready.',
    settings.preorder_enabled === '1' && !service ? 'Order drinks while you wait.' : null,
    settings.booking_enabled === '1' ? 'Book your next visit from the same page.' : null,
  ].filter(Boolean);
  return (
    <Modal title="Door sign" onClose={onClose} width={600}>
      <div className="print-area">
        <div className="sign">
          {logo ? <img className="sign-logo-top" src={logo} alt="" /> : <b style={{ fontFamily: 'var(--display)', fontSize: 22 }}>{settings.business_name}</b>}
          <h2>{settings.sign_headline}</h2>
          <div className="sign-qr">
            {qr ? <div dangerouslySetInnerHTML={{ __html: qr.svg }} /> : <div style={{ aspectRatio: 1 }} />}
            {logo && <span className="mark"><img src={logo} alt="" /></span>}
          </div>
          <p>{lines.join(' ')}</p>
          <small>Open your phone camera and point it at the code. No app to download.</small>
        </div>
      </div>
      <div className="row">
        <button className="btn grow" onClick={onClose}>Close</button>
        <button className="btn primary grow" onClick={() => { document.body.classList.add('printing-sign'); window.addEventListener('afterprint', () => document.body.classList.remove('printing-sign'), { once: true }); window.print(); }}><Icon name="print" size={17} />Print</button>
      </div>
    </Modal>
  );
}
