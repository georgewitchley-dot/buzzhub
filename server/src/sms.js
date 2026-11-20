// Optional SMS fallback via Twilio. Enabled only when all three env vars are set.
const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM: FROM } = process.env;

export const smsEnabled = () => Boolean(SID && TOKEN && FROM);

export async function sendSms(to, body) {
  if (!smsEnabled()) return { ok: false, error: 'SMS not configured' };
  const digits = to.replace(/[^\d+]/g, '');
  const e164 = digits.startsWith('+') ? digits : `+1${digits}`;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: e164, From: FROM, Body: body.slice(0, 300) }),
  });
  return { ok: r.ok, status: r.status };
}
