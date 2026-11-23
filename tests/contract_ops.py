"""Node vs Go: ops.js (kitchen, day report, cash drawer, shifts, schedule, wages)."""
import subprocess, uuid
from contractlib import *
JN, JG, SN, SG = '/tmp/j7o_n', '/tmp/j7o_g', '/tmp/j7o_sn', '/tmp/j7o_sg'
login(N, '8642', JN); login(G, '8642', JG); login(N, '5791', SN); login(G, '5791', SG)
for p in ['/api/staff/kitchen', '/api/staff/reports/day', '/api/staff/reports/day?date=2026-01-01', '/api/staff/cash', '/api/staff/shifts', '/api/staff/shifts?from=2026-11-01']:
    same_get(p, JN, JG)
same_get('/api/staff/shifts', SN, SG, 'shifts as staff')
same_get('/api/staff/reports/day', SN, SG, 'day report as staff (403)')
same_get('/api/staff/cash', SN, SG, 'cash as staff')
a, b = call(N, 'GET', '/api/staff/shifts', jar=SN), call(G, 'GET', '/api/staff/shifts', jar=SG)
check('staff sees no laborTodayCents', a[1].get('laborTodayCents') is None and b[1].get('laborTodayCents') is None)
for base, jar in [(N, JN), (G, JG)]:
    out = f'/tmp/t7/{uuid.uuid4().hex}'
    subprocess.run(['curl', '-s', '-o', out, '-D', out + '.h', '-b', jar, base + '/api/staff/reports/day.csv'])
    body, hdr = open(out).read(), open(out + '.h').read().lower()
    globals()['csv_' + ('n' if base == N else 'g')] = (body.split('\n')[0], body.count('\n'), 'text/csv' in hdr, 'attachment; filename="buzzhub-' in hdr)
check('day.csv header/lines/headers match', csv_n == csv_g, (csv_n, csv_g))
def both(method, path, body=None, jarn=JN, jarg=JG, label=None, cmp_body=True, ip=None):
    a = call(N, method, path, body, jar=jarn, ip=ip); b = call(G, method, path, body, jar=jarg, ip=ip)
    good = a[0] == b[0] and (not cmp_body or a[0] == 200 or a[1] == b[1])
    if a[0] == b[0] == 200 and isinstance(a[1], dict): good = good and not diff(shape(a[1]), shape(b[1]))
    check(f'{label or method + " " + path}: {a[0]}', good, (a, b)); return a, b
# validation + error paths
both('POST', '/api/staff/cash/move', {'kind': 'sideways', 'amountCents': 0, 'reason': ''}, label='cash move bad body or closed')
both('POST', '/api/staff/cash/open', {'openingCents': -5}, label='cash open bad body or already open')
both('POST', '/api/staff/kitchen/999999/recall', {}, label='recall unknown')
both('POST', '/api/staff/kitchen/abc/recall', {}, label='recall bad id')
both('POST', '/api/staff/cash/close', {'countedCents': 100}, SN, SG, label='cash close as staff needs approval')
# full drawer cycle (close any open drawer first)
for base, jar, lab in [(N, JN, 'node'), (G, JG, 'go')]:
    c, d = call(base, 'GET', '/api/staff/cash', jar=jar)
    if d.get('current'): call(base, 'POST', '/api/staff/cash/close', {'countedCents': 0}, jar=jar)
both('POST', '/api/staff/cash/open', {'openingCents': 20000}, label='cash open')
both('POST', '/api/staff/cash/open', {'openingCents': 20000}, label='cash open twice')
both('POST', '/api/staff/cash/move', {'kind': 'out', 'amountCents': 1500, 'reason': 'Ice'}, label='paid out')
a, b = both('GET', '/api/staff/cash', label='cash with open drawer')
check('cash current same shape', not diff(shape(a[1]['current']), shape(b[1]['current'])), diff(shape(a[1]['current']), shape(b[1]['current'])))
a, b = both('POST', '/api/staff/cash/close', {'countedCents': 18000, 'notes': 'ok'}, label='cash close', cmp_body=False)
check('cash close fields', set(a[1]) == set(b[1]), (a, b))
both('POST', '/api/staff/cash/close', {'countedCents': 1}, label='cash close when closed')
# schedule + shifts
both('POST', '/api/staff/schedule', {'userId': 1, 'date': '2026-12-01', 'start': '18:00', 'end': '10:00'}, label='schedule end before start')
both('POST', '/api/staff/schedule', {'userId': 99999, 'date': '2026-12-01', 'start': '10:00', 'end': '18:00'}, label='schedule unknown user')
both('POST', '/api/staff/schedule', {'userId': 'x', 'date': 'bad', 'start': '1', 'end': '2'}, label='schedule bad body')
a, b = both('POST', '/api/staff/schedule', {'userId': 1, 'date': '2026-12-01', 'start': '10:00', 'end': '18:00', 'note': 'CT'}, label='schedule add', cmp_body=False)
both('POST', '/api/staff/schedule', {'userId': 1, 'date': '2026-12-01', 'start': '10:00', 'end': '18:00'}, SN, SG, label='schedule as staff')
for base, jar in [(N, JN), (G, JG)]:
    c, d = call(base, 'GET', '/api/staff/shifts?from=2026-12-01', jar=jar)
    for s in d['schedule']:
        if s.get('role_note') == 'CT': call(base, 'DELETE', f"/api/staff/schedule/{s['id']}", jar=jar)
both('PUT', '/api/staff/shifts/999999', {'break_minutes': 5}, label='edit unknown shift')
both('PUT', '/api/staff/shifts/1', {'clock_in': 'yesterday'}, label='edit shift bad body')
both('PUT', '/api/staff/users/2/wage', {'hourlyCents': -1}, label='wage bad')
both('PUT', '/api/staff/users/2/wage', {'hourlyCents': 1600}, SN, SG, label='wage as staff')
both('PUT', '/api/staff/users/2/wage', {'hourlyCents': 1600}, label='wage set')
# lock-screen clock
both('POST', '/api/auth/clock', {'pin': '12'}, None, None, label='clock bad pin format', ip='10.7.0.1')
both('POST', '/api/auth/clock', {'pin': '00001'}, None, None, label='clock wrong pin', ip='10.7.0.2')
for k in range(2):
    a, b = both('POST', '/api/auth/clock', {'pin': '5791'}, None, None, label=f'clock Ana #{k + 1}', cmp_body=False, ip='10.7.0.3')
    check(f'clock Ana #{k + 1} same action', a[1].get('action') == b[1].get('action') and set(a[1]) == set(b[1]), (a, b))
# edit the shift just made
for base, jar in [(N, JN), (G, JG)]:
    c, d = call(base, 'GET', '/api/staff/shifts', jar=jar); sid = d['shifts'][0]['id'] if d['shifts'] else 1
    c, e = call(base, 'PUT', f'/api/staff/shifts/{sid}', {'clock_out': '2000-01-01 00:00:00'}, jar=jar)
    globals()['edit_' + ('n' if base == N else 'g')] = (c, e)
check('edit shift clock-out before clock-in', edit_n == edit_g, (edit_n, edit_g))
done()
