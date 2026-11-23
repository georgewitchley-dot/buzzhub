import json, subprocess, sys
N, G = 'http://localhost:8099', 'http://localhost:8097'
def call(base, method, path, body=None, jar=None, csrf=True, ip=None):
    cmd = ['curl', '-s', '-o', '/tmp/cbody', '-w', '%{http_code}', '-X', method, base + path]
    if csrf: cmd += ['-H', 'X-BuzzHub: 1']
    if body is not None: cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(body)]
    if jar: cmd += ['-b', jar, '-c', jar]
    if ip: cmd += ['-H', f'X-Forwarded-For: {ip}']
    code = int(subprocess.run(cmd, capture_output=True, text=True).stdout)
    try: data = json.load(open('/tmp/cbody'))
    except Exception: data = open('/tmp/cbody').read()[:80]
    return code, data
ok = 0; bad = 0
def check(name, cond, detail=''):
    global ok, bad
    if cond: ok += 1; print('  ok  ', name)
    else: bad += 1; print('  FAIL', name, detail)
def shape(v):
    if isinstance(v, dict): return {k: shape(x) for k, x in sorted(v.items())}
    if isinstance(v, list): return [shape(v[0])] if v else []
    return type(v).__name__ if v is not None else 'null'
for path in ['/api/setup/status', '/api/public/business']:
    a, b = call(N, 'GET', path), call(G, 'GET', path)
    check(f'{path} status', a[0] == b[0], (a[0], b[0]))
    sa, sb = shape(a[1]), shape(b[1])
    check(f'{path} same fields and types', sa == sb, json.dumps({k: (sa.get(k), sb.get(k)) for k in set(sa) | set(sb) if sa.get(k) != sb.get(k)}))
    if path.endswith('business'):
        same = {k: (a[1][k], b[1][k]) for k in a[1] if k != 'waiting' and a[1][k] != b[1].get(k)}
        check('business values match (except live waitlist count)', not same, same)
for base, label in [(N, 'node'), (G, 'go')]:
    c, d = call(base, 'POST', '/api/auth/login', {'pin': '8642'}, csrf=False)
    check(f'{label}: no X-BuzzHub header is refused', c == 403 and d.get('error') == 'Bad request origin', (c, d))
    c, d = call(base, 'POST', '/api/auth/login', {'pin': '12'})
    check(f'{label}: short PIN is a 400', c == 400, (c, d))
c1, d1 = call(N, 'POST', '/api/auth/login', {'pin': '9999'}, ip='10.9.9.1'); c2, d2 = call(G, 'POST', '/api/auth/login', {'pin': '9999'}, ip='10.9.9.1')
check('wrong PIN: same status and fields', c1 == c2 == 401 and set(d1) == set(d2), (c1, d1, c2, d2))
for jar, base, other, label in [('/tmp/jn', N, G, 'node cookie on go'), ('/tmp/jg', G, N, 'go cookie on node')]:
    subprocess.run(['rm', '-f', jar])
    c, d = call(base, 'POST', '/api/auth/login', {'pin': '8642'}, jar=jar)
    check(f'login on {"node" if base == N else "go"}', c == 200 and d.get('user', {}).get('role') == 'owner', (c, d))
    c, d = call(other, 'GET', '/api/auth/me', jar=jar)
    check(label, c == 200 and d.get('user', {}).get('name'), (c, d))
c, dn = call(N, 'GET', '/api/staff/settings', jar='/tmp/jn'); c2, dg = call(G, 'GET', '/api/staff/settings', jar='/tmp/jn')
check('staff settings: same keys', set(dn) == set(dg), sorted(set(dn) ^ set(dg))[:12])
c, d = call(G, 'GET', '/api/staff/settings')
check('go: settings without a session is 401 Locked', c == 401 and d.get('error') == 'Locked', (c, d))
c, d = call(G, 'POST', '/api/auth/logout', jar='/tmp/jg'); c2, d2 = call(G, 'GET', '/api/auth/me', jar='/tmp/jg')
check('go: logout ends the session', c == 200 and c2 == 401, (c, c2))
codes = [call(G, 'POST', '/api/auth/login', {'pin': '9998'}, ip='10.9.9.2')[0] for _ in range(6)]
c, d = call(G, 'POST', '/api/auth/login', {'pin': '8642'}, ip='10.9.9.2')
check('go: 5 wrong PINs lock the terminal, even for the right PIN', c == 429 and d.get('lockedFor', 0) > 0, (codes, c, d))
print(f'\n{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
