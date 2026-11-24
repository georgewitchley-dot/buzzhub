"""Webhook signature checks. Start both servers with STRIPE_WEBHOOK_SECRET and SQUARE_WEBHOOK_SIGNATURE_KEY
set to the same values as here (and PUBLIC_URL=http://hook.test) to run it."""
import hmac, hashlib, base64, time, json, subprocess, uuid
from contractlib import *
SK, QK = os.environ.get('STRIPE_WEBHOOK_SECRET', 'whsec_ct'), os.environ.get('SQUARE_WEBHOOK_SIGNATURE_KEY', 'sqk_ct')
def raw(base, path, body, headers):
    out = f'/tmp/wh-{uuid.uuid4().hex}'
    cmd = ['curl', '-s', '-o', out, '-w', '%{http_code}', '-X', 'POST', base + path, '-H', 'Content-Type: application/json', '--data-binary', body]
    for k, v in headers.items(): cmd += ['-H', f'{k}: {v}']
    code = int(subprocess.run(cmd, capture_output=True, text=True).stdout or 0); b = open(out, 'rb').read(); os.remove(out); return code, b
ev = json.dumps({'type': 'payment_intent.succeeded', 'data': {'object': {'id': 'pi_1', 'metadata': {'loc': 'main'}}}})
t = str(int(time.time())); sig = hmac.new(SK.encode(), f'{t}.{ev}'.encode(), hashlib.sha256).hexdigest()
sev = json.dumps({'data': {'object': {'payment': {'status': 'COMPLETED', 'order_id': 'nope', 'id': 'p1'}}}})
ssig = base64.b64encode(hmac.new(QK.encode(), ('http://hook.test/api/square/webhook' + sev).encode(), hashlib.sha256).digest()).decode()
cases = [('stripe good', '/api/stripe/webhook', ev, {'Stripe-Signature': f't={t},v1={sig}'}),
         ('stripe bad sig', '/api/stripe/webhook', ev, {'Stripe-Signature': f't={t},v1={"0" * 64}'}),
         ('stripe stale', '/api/stripe/webhook', ev, {'Stripe-Signature': f't=1000,v1=' + hmac.new(SK.encode(), f'1000.{ev}'.encode(), hashlib.sha256).hexdigest()}),
         ('stripe no header', '/api/stripe/webhook', ev, {}),
         ('square good', '/api/square/webhook', sev, {'X-Square-HmacSha256-Signature': ssig}),
         ('square bad', '/api/square/webhook', sev, {'X-Square-HmacSha256-Signature': 'x' * len(ssig)})]
for name, path, body, h in cases:
    a, b = raw(N, path, body, h), raw(G, path, body, h)
    check(f'{name}: status {a[0]}', a[0] == b[0], (a, b))
    check(f'{name}: same body', a[1].strip() == b[1].strip(), (a, b))
done()
