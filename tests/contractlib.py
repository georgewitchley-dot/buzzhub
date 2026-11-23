"""Shared helpers for Node-vs-Go contract tests. Set NODE / GO env vars to point at other ports."""
import json, os, subprocess, sys, uuid
N = os.environ.get('NODE', 'http://localhost:8099'); G = os.environ.get('GO', 'http://localhost:8097')
def call(base, method, path, body=None, jar=None, csrf=True, ip=None, headers=None):
    out = f'/tmp/cbody-{uuid.uuid4().hex}'
    cmd = ['curl', '-s', '-o', out, '-w', '%{http_code}', '-X', method, base + path]
    if csrf: cmd += ['-H', 'X-BuzzHub: 1']
    for k, v in (headers or {}).items(): cmd += ['-H', f'{k}: {v}']
    if body is not None: cmd += ['-H', 'Content-Type: application/json', '-d', json.dumps(body)]
    if jar: cmd += ['-b', jar, '-c', jar]
    if ip: cmd += ['-H', f'X-Forwarded-For: {ip}']
    code = int(subprocess.run(cmd, capture_output=True, text=True).stdout or 0)
    raw = open(out, 'rb').read(); os.remove(out)
    try: data = json.loads(raw)
    except Exception: data = raw[:80]
    return code, data
ok = 0; bad = 0
def check(name, cond, detail=''):
    global ok, bad
    if cond: ok += 1; print('  ok  ', name)
    else: bad += 1; print('  FAIL', name, str(detail)[:600])
def shape(v):
    if isinstance(v, bool): return 'bool'
    if isinstance(v, (int, float)): return 'number'
    if isinstance(v, dict): return {k: shape(x) for k, x in sorted(v.items())}
    if isinstance(v, list): return [shape(v[0])] if v else []
    return type(v).__name__ if v is not None else 'null'
def diff(a, b, path=''):
    """Differences in fields/types; null on one side and a value on the other is allowed, as are empty lists."""
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b: out.append(f'{path}.{k} only in {"node" if k in a else "go"}'); continue
            out += diff(a[k], b[k], f'{path}.{k}')
    elif isinstance(a, list) and isinstance(b, list):
        if a and b: out += diff(a[0], b[0], path + '[0]')
    elif 'null' in (a, b) or a == b: pass
    else: out.append(f'{path}: node {a} vs go {b}')
    return out
def login(base, pin, jar):
    subprocess.run(['rm', '-f', jar]); return call(base, 'POST', '/api/auth/login', {'pin': pin}, jar=jar)
def same_get(path, jar_n, jar_g, label=None):
    a, b = call(N, 'GET', path, jar=jar_n), call(G, 'GET', path, jar=jar_g)
    check(f'{label or path}: status {a[0]}', a[0] == b[0], (a[0], b[0], b[1] if b[0] >= 400 else ''))
    if a[0] == b[0] == 200:
        d = diff(shape(a[1]), shape(b[1])); check(f'{label or path}: same shape', not d, d)
    return a, b
def done():
    print(f'\n{ok} passed, {bad} failed'); sys.exit(1 if bad else 0)
