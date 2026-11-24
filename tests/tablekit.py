"""Helpers for the table/seat/serve/flow contract tests: run SQL on both databases, sign a KDS token,
fetch raw bytes. Set SQLITE (Node data dir db file) and PGDB (Postgres database) to point at your copies."""
import base64, hashlib, hmac, json, os, subprocess, time, uuid
from contractlib import N, G

DATA = os.environ.get('DATA', '/tmp/bh10')
PGDB = os.environ.get('PGDB', 'agent10')
NODE_DIR = '/home/claude/buzzhub/server'


def sqlite(sql, params=()):
    js = ("const D=require('better-sqlite3');const db=new D(process.argv[1]);const s=db.prepare(process.argv[2]);"
          "const p=JSON.parse(process.argv[3]);const r=s.reader?s.all(...p):s.run(...p);console.log(JSON.stringify(r))")
    out = subprocess.run(['node', '-e', js, f'{DATA}/buzzhub.db', sql, json.dumps(list(params))], cwd=NODE_DIR, capture_output=True, text=True)
    if out.returncode: raise RuntimeError(out.stderr)
    return json.loads(out.stdout)


def pg(sql):
    out = subprocess.run(['psql', '-h', '/tmp', '-p', '54329', '-U', 'buzzhub', '-d', PGDB, '-Atc', sql], capture_output=True, text=True)
    if out.returncode: raise RuntimeError(out.stderr)
    return out.stdout.strip()


def both(sql):
    """Run the same (portable) SQL on both databases."""
    sqlite(sql); pg(sql)


def lit(v):
    return 'NULL' if v is None else str(v) if isinstance(v, (int, float)) else "'" + str(v).replace("'", "''") + "'"


def secret():
    return open(f'{DATA}/.jwt_secret').read().strip()


def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()


def kds_token(area='Kitchen', v='1', loc='main', key_suffix=':kds'):
    head = b64u(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    body = b64u(json.dumps({'kind': 'kds', 'area': area, 'loc': loc, 'v': v, 'iat': int(time.time()), 'exp': int(time.time()) + 3600}).encode())
    sig = hmac.new((secret() + key_suffix).encode(), f'{head}.{body}'.encode(), hashlib.sha256).digest()
    return f'{head}.{body}.{b64u(sig)}'


def raw(base, path, jar=None):
    """GET returning (status, content-type, bytes)."""
    out = f'/tmp/craw-{uuid.uuid4().hex}'
    cmd = ['curl', '-s', '-o', out, '-w', '%{http_code} %{content_type}', base + path]
    if jar: cmd += ['-b', jar, '-c', jar]
    r = subprocess.run(cmd, capture_output=True, text=True).stdout.split(' ', 1)
    data = open(out, 'rb').read(); os.remove(out)
    return int(r[0]), (r[1] if len(r) > 1 else '').split(';')[0], data


def setting(key, value):
    """Set (or with None, delete) a setting on both servers' databases."""
    if value is None:
        both(f"DELETE FROM settings WHERE key = {lit(key)}"); return
    sqlite(f"INSERT OR REPLACE INTO settings (key, value) VALUES ({lit(key)}, {lit(value)})")
    pg(f"INSERT INTO settings (key, value) VALUES ({lit(key)}, {lit(value)}) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
