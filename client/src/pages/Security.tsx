import { useState } from 'react';
import { api, enablePush, isIOS, isStandalone, timeOf } from '../lib';
import { Modal, useToast } from '../ui';
import { PageHead, useCC, useLive } from './CommandCenter';
import { AuditLog } from './Admin';

function TwoStep({ me, reload }: { me?: any; reload?: any; }) {
  const toast = useToast();
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const [off, setOff] = useState(false);
  const start = async () => { try { setSetup(await api('/staff/security/2fa/setup', { method: 'POST' })); } catch (e) { toast(e.message, 'err'); } };
  const enable = async () => { try { const r = await api('/staff/security/2fa/enable', { method: 'POST', body: { code } }); setSetup(null); setCode(''); setCodes(r.recoveryCodes); reload(); } catch (e) { toast(e.message, 'err'); } };
  const disable = async () => { try { await api('/staff/security/2fa/disable', { method: 'POST', body: { code } }); setOff(false); setCode(''); toast('Two-step sign-in is off', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <section className="panel"><div className="panel-h"><h3 className="grow">Two-step sign-in</h3><span className={`chip ${me.twoStep ? 'teal' : 'rose'}`}>{me.twoStep ? 'On' : 'Off'}</span></div><div className="panel-b stack">
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>After your PIN, you'll also enter a 6-digit code from a free authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…). Someone who learns your PIN still can't get in. You're asked once per 12 hours on each device.</p>
      {me.twoStep ? (
        <>
          <span className="muted" style={{ fontSize: 14 }}>{me.recoveryLeft} of 8 recovery codes left.</span>
          <button className="btn ghost danger" onClick={() => setOff(true)}>Turn off two-step sign-in</button>
        </>
      ) : <button className="btn primary block" onClick={start}>Set up two-step sign-in</button>}
    </div>
      {setup && (
        <Modal title="Set up two-step sign-in" onClose={() => setSetup(null)}>
          <ol className="steps" style={{ color: 'var(--text)' }}><li>Open your authenticator app and add an account.</li><li>Scan this code, or type the key below.</li><li>Enter the 6-digit code the app shows.</li></ol>
          <div className="qr" dangerouslySetInnerHTML={{ __html: setup.svg }} />
          <code style={{ textAlign: 'center', letterSpacing: 1, fontSize: 15 }}>{setup.secret}</code>
          <input className="input" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6-digit code" aria-label="Code from app" style={{ textAlign: 'center', fontSize: 22, letterSpacing: 6, height: 54 }} />
          <button className="btn primary lg block" disabled={code.length !== 6} onClick={enable}>Turn on</button>
        </Modal>
      )}
      {codes && (
        <Modal title="Save your recovery codes" onClose={() => setCodes(null)}>
          <p className="muted" style={{ margin: 0 }}>If you lose your phone, each of these works once instead of the app code. Print them or store them somewhere safe. You won't see them again.</p>
          <div className="codes">{codes.map((c) => <code key={c}>{c.slice(0, 5)}-{c.slice(5)}</code>)}</div>
          <div className="row"><button className="btn grow" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Copied', 'ok'))}>Copy</button><button className="btn primary grow" onClick={() => setCodes(null)}>I saved them</button></div>
        </Modal>
      )}
      {off && (
        <Modal title="Turn off two-step sign-in" onClose={() => setOff(false)}>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="Code from your app, or a recovery code" aria-label="Code" />
          <button className="btn primary block" disabled={code.length < 6} onClick={disable}>Turn off</button>
        </Modal>
      )}
    </section>
  );
}

function Devices({ owner }: { owner?: any; }) {
  const toast = useToast();
  const [data, reload] = useLive(['devices'], () => api('/staff/security/devices'));
  if (!data) return null;
  const set = async (d, body, msg) => { try { await api(`/staff/security/devices/${d.id}`, { method: 'POST', body }); toast(msg, 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  const toggle = async () => { try { await api('/staff/security/require-devices', { method: 'POST', body: { on: !data.requireApproved } }); toast(data.requireApproved ? 'Any device can sign in' : 'Only approved devices can sign in. This one is approved.', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  const pending = data.devices.filter((d) => d.status === 'pending');
  return (
    <section className="panel"><div className="panel-h"><h3 className="grow">Devices</h3>{owner && <button className={`btn sm ${data.requireApproved ? 'primary' : ''}`} onClick={toggle} aria-pressed={data.requireApproved}>{data.requireApproved ? 'Approved devices only' : 'Any device can sign in'}</button>}</div>
      <div className="panel-b muted" style={{ fontSize: 14, paddingBottom: 0 }}>{data.requireApproved ? 'A new tablet or phone has to be approved here before anyone can sign in on it. You get an alert with its code.' : 'Turn on "Approved devices only" so a stolen PIN only works on your own tablets.'}</div>
      <table className="list"><tbody>
        {[...pending, ...data.devices.filter((d) => d.status !== 'pending')].slice(0, 30).map((d) => (
          <tr key={d.id} style={{ opacity: d.status === 'blocked' ? 0.5 : 1 }}>
            <td><b>{d.name}</b>{d.this_device ? <span className="chip" style={{ marginLeft: 8 }}>This device</span> : null}<div className="dim" style={{ fontSize: 12.5 }}>{d.ip}, last used {d.last_seen ? `${new Date(d.last_seen.replace(' ', 'T') + 'Z').toLocaleDateString()} ${timeOf(d.last_seen)}` : 'never'}</div></td>
            <td>{d.status === 'pending' ? <span className="chip amber">Waiting, code {d.code}</span> : <span className={`chip ${d.status === 'approved' ? 'teal' : 'rose'}`}>{d.status === 'approved' ? 'Approved' : 'Blocked'}</span>}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{owner && <>
              {d.status !== 'approved' && <button className="btn sm primary" onClick={() => set(d, { status: 'approved' }, `${d.name} approved`)}>Approve</button>}
              {d.status !== 'blocked' && !d.this_device && <button className="btn sm ghost danger" onClick={() => set(d, { status: 'blocked' }, `${d.name} blocked`)}>Block</button>}
              <button className="btn sm ghost" onClick={() => { const n = prompt('Name this device', d.name); if (n) set(d, { name: n }, 'Renamed'); }}>Rename</button>
            </>}</td>
          </tr>
        ))}
      </tbody></table>
    </section>
  );
}

function PhoneAlerts({ me, reload }: { me?: any; reload?: any; }) {
  const toast = useToast();
  const on = async () => {
    const r = await enablePush('/staff/security/push').catch(() => 'unsupported');
    if (r === 'on') { toast('Security alerts will come to this phone', 'ok'); reload(); api('/staff/security/push/test', { method: 'POST' }).catch(() => {}); }
    else toast(r === 'needs-install' ? 'On iPhone, add this page to your Home Screen first, then try again.' : r === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : "This browser can't receive notifications.", 'err');
  };
  return (
    <section className="panel"><div className="panel-h"><h3 className="grow">Security alerts on your phone</h3><span className={`chip ${me.phoneAlerts ? 'teal' : ''}`}>{me.phoneAlerts ? `${me.phoneAlerts} phone${me.phoneAlerts === 1 ? '' : 's'}` : 'Off'}</span></div><div className="panel-b stack">
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>Get a notification for repeated wrong PINs, new devices trying to sign in, big voids and refunds, drawers that come up short, and recovery code use.</p>
      {isIOS() && !isStandalone() && <span className="dim" style={{ fontSize: 13 }}>On iPhone: Share, then Add to Home Screen, open it from there and tap the button.</span>}
      <button className="btn block" onClick={on}>Send alerts to this phone</button>
    </div></section>
  );
}

export default function Security() {
  const { user } = useCC();
  const [me, reload] = useLive([], () => api('/staff/security/me'));
  return (
    <>
      <PageHead title="Security" sub="Protect the command center beyond the PIN." />
      {me && (
        <div className="settings-grid" style={{ marginBottom: 18 }}>
          <TwoStep me={me} reload={reload} />
          <PhoneAlerts me={me} reload={reload} />
          <div style={{ gridColumn: '1 / -1' }}><Devices owner={user.role === 'owner'} /></div>
        </div>
      )}
      <AuditLog embedded />
    </>
  );
}
