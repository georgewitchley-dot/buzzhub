from contractlib import *
JN, JG = '/tmp/j1f_n', '/tmp/j1f_g'
login(N, '8642', JN); login(G, '8642', JG)
same_get('/api/staff/team', JN, JG)
a, b = call(N, 'GET', '/api/staff/team', jar=JN), call(G, 'GET', '/api/staff/team', jar=JG)
check('team: same list', a == b, (a, b))

def both(method, path, body=None, label=None):
    a = call(N, method, path, body, jar=JN); b = call(G, method, path, body, jar=JG)
    lab = label or f'{method} {path}'
    check(f'{lab}: status {a[0]}', a[0] == b[0], (a, b))
    check(f'{lab}: same answer', a[1] == b[1], (a[1], b[1]))
    return a, b

c, tables = call(N, 'GET', '/api/staff/tables', jar=JN)
tables = tables if isinstance(tables, list) else tables['tables']
t = tables[0]
team = a[1]
both('PUT', '/api/staff/tables/layout', [{'id': t['id'], 'x': 200, 'y': 1, 'w': 1, 'h': 5, 'shape': 'oval'}], 'layout: bad box')
both('PUT', '/api/staff/tables/layout', {'id': 1}, 'layout: not a list')
both('PUT', '/api/staff/tables/layout', [{'id': t['id'], 'x': 12.5, 'y': 30, 'w': 10, 'h': 8.25, 'shape': 'round'}], 'layout: save')
both('PUT', f'/api/staff/tables/{t["id"]}', {'label': '', 'seats': 0}, 'edit table: bad')
both('PUT', '/api/staff/tables/999999', {'seats': 4}, 'edit table: missing')
both('PUT', f'/api/staff/tables/{t["id"]}', {'seats': 6, 'zone': ' Patio '}, 'edit table: save')
both('POST', f'/api/staff/tables/{t["id"]}/server', {'userId': 999999}, 'server: unknown member')
both('POST', f'/api/staff/tables/{t["id"]}/server', {}, 'server: missing userId')
both('POST', f'/api/staff/tables/{t["id"]}/server', {'userId': team[0]['id']}, 'server: assign')
a = call(N, 'GET', '/api/staff/tables', jar=JN)[1]; b = call(G, 'GET', '/api/staff/tables', jar=JG)[1]
pick = lambda ts: next({k: x.get(k) for k in ('x', 'y', 'w', 'h', 'shape', 'seats', 'zone', 'server_id')} for x in (ts if isinstance(ts, list) else ts['tables']) if x['id'] == t['id'])
check('table saved the same', pick(a) == pick(b), (pick(a), pick(b)))
both('POST', f'/api/staff/tables/{t["id"]}/server', {'userId': None}, 'server: clear')
both('PUT', f'/api/staff/tables/{t["id"]}', {'seats': t['seats'], 'zone': t['zone']}, 'edit table: restore')
login(N, '5791', JN); login(G, '5791', JG)
both('PUT', '/api/staff/tables/layout', [], 'layout: staff not allowed')
done()
