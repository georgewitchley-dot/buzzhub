from contractlib import *
JN, JG = '/tmp/j5_n', '/tmp/j5_g'; SN, SG = '/tmp/j5_sn', '/tmp/j5_sg'
login(N, '8642', JN); login(G, '8642', JG); login(N, '5791', SN); login(G, '5791', SG)

def both(method, path, body=None, jn=JN, jg=JG):
    return call(N, method, path, body, jar=jn), call(G, method, path, body, jar=jg)

def same(label, a, b, exact=False):
    check(f'{label}: status {a[0]}', a[0] == b[0], (a, b))
    if a[0] == b[0] == 200 and isinstance(a[1], (dict, list)):
        if exact: check(f'{label}: same value', a[1] == b[1], (a[1], b[1]))
        else:
            d = diff(shape(a[1]), shape(b[1])); check(f'{label}: same shape', not d, d)
    elif a[0] >= 400: check(f'{label}: same error', a[1] == b[1], (a[1], b[1]))

for p in ['/api/staff/allergen-chart', '/api/public/allergens', '/api/staff/rotation', '/api/staff/supplier-credits', '/api/staff/sales-tax',
          '/api/staff/sales-tax?period=year&year=2026', '/api/staff/sales-tax?period=month&n=11', '/api/staff/sales-tax?period=custom&from=2026-01-01&to=2026-11-30',
          '/api/staff/sales-tax?period=quarter&n=4&year=2025', '/api/staff/transfers', '/api/staff/certificates', '/api/staff/cash-flow', '/api/staff/cash-flow?days=90',
          '/api/staff/delivery-zones', '/api/staff/catering-feedback', '/api/i/FBQM2uEo-LeZLDaUEdZv/feedback', '/api/i/nope-nope-nope-nope/feedback']:
    same_get(p, JN, JG)
same_get('/api/staff/certificates', SN, SG, 'certificates as staff')
same_get('/api/staff/supplier-credits', SN, SG, 'credits as staff (forbidden)')
for p in ['/api/staff/sales-tax?period=year&year=2026', '/api/staff/sales-tax?period=custom&from=2026-01-01&to=2026-11-30', '/api/staff/allergen-chart', '/api/staff/rotation']:
    same(f'{p} values', *both('GET', p), exact=True)
a, b = both('GET', '/api/staff/cash-flow')
check('cash flow same dates', [d['date'] for d in a[1]['days']] == [d['date'] for d in b[1]['days']], '')
check('cash flow same bills/fixed', (a[1]['billsCents'], a[1]['fixed'], a[1]['startCents']) == (b[1]['billsCents'], b[1]['fixed'], b[1]['startCents']), (a[1]['billsCents'], b[1]['billsCents']))
code_n = subprocess.run(['curl', '-s', '-b', JN, N + '/api/staff/sales-tax?period=year&year=2026&format=csv'], capture_output=True, text=True).stdout
code_g = subprocess.run(['curl', '-s', '-b', JG, G + '/api/staff/sales-tax?period=year&year=2026&format=csv'], capture_output=True, text=True).stdout
check('sales tax csv identical', code_n == code_g, (code_n[:300], code_g[:300]))

# delivery credits
same('credit bad body', *both('POST', '/api/staff/supplier-credits', {'supplierId': 'x', 'amountCents': 0, 'reason': 'nah'}))
same('credit unknown supplier', *both('POST', '/api/staff/supplier-credits', {'supplierId': 999, 'amountCents': 100, 'reason': 'short'}))
a, b = both('POST', '/api/staff/supplier-credits', {'supplierId': 1, 'amountCents': 250, 'reason': 'damaged', 'items': [{'name': 'Bun', 'qty': 2}], 'adjustStock': True})
same('credit add', a, b)
cn, cg = a[1]['id'], b[1]['id']
same('credit apply wrong bill', call(N, 'POST', f'/api/staff/supplier-credits/{cn}/apply', {'billId': 999}, jar=JN), call(G, 'POST', f'/api/staff/supplier-credits/{cg}/apply', {'billId': 999}, jar=JG))
a, b = call(N, 'POST', f'/api/staff/supplier-credits/{cn}/apply', {'billId': 1}, jar=JN), call(G, 'POST', f'/api/staff/supplier-credits/{cg}/apply', {'billId': 1}, jar=JG)
same('credit apply', a, b, exact=True)
same('credit apply again', call(N, 'POST', f'/api/staff/supplier-credits/{cn}/apply', {'billId': 1}, jar=JN), call(G, 'POST', f'/api/staff/supplier-credits/{cg}/apply', {'billId': 1}, jar=JG))
a, b = both('POST', '/api/staff/supplier-credits', {'supplierId': 2, 'amountCents': 100, 'reason': 'other'})
same('credit void', call(N, 'POST', f'/api/staff/supplier-credits/{a[1]["id"]}/void', {}, jar=JN), call(G, 'POST', f'/api/staff/supplier-credits/{b[1]["id"]}/void', {}, jar=JG), exact=True)
same_get('/api/staff/supplier-credits', JN, JG, 'credits after')

# stock transfers
same('transfer to self', *both('POST', '/api/staff/transfers', {'to': 'main', 'lines': [{'ingredientId': 1, 'qty': 1}]}))
same('transfer too much', *both('POST', '/api/staff/transfers', {'to': 'uptown', 'lines': [{'ingredientId': 2, 'qty': 99999}]}))
same('transfer unknown ingredient', *both('POST', '/api/staff/transfers', {'to': 'uptown', 'lines': [{'ingredientId': 9999, 'qty': 1}]}))
same('transfer bad body', *both('POST', '/api/staff/transfers', {'to': 'uptown', 'lines': []}))
same('transfer ok', *both('POST', '/api/staff/transfers', {'to': 'uptown', 'lines': [{'ingredientId': 1, 'qty': 2}], 'note': 'ct'}), exact=True)
a, b = both('GET', '/api/staff/transfers'); same('transfers after', a, b)
check('transfer history same', a[1]['history'][0]['lines'] == b[1]['history'][0]['lines'] and a[1]['history'][0]['direction'] == b[1]['history'][0]['direction'], (a[1]['history'][:1], b[1]['history'][:1]))

# certificates
same('cert bad', *both('POST', '/api/staff/certificates', {'kind': '', 'expires': '2026/01/01'}))
a, b = both('POST', '/api/staff/certificates', {'kind': 'Food handler', 'number': 'A1', 'expires': '2026-12-01', 'userId': 2})
same('cert add (owner)', a, b)
cn, cg = a[1]['id'], b[1]['id']
same('cert add (staff)', *both('POST', '/api/staff/certificates', {'kind': 'Alcohol server', 'issued': ''}, SN, SG))
same('cert verify (staff forbidden)', call(N, 'POST', f'/api/staff/certificates/{cn}/verify', {}, jar=SN), call(G, 'POST', f'/api/staff/certificates/{cg}/verify', {}, jar=SG))
same('cert verify', call(N, 'POST', f'/api/staff/certificates/{cn}/verify', {}, jar=JN), call(G, 'POST', f'/api/staff/certificates/{cg}/verify', {}, jar=JG), exact=True)
png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
same('cert photo bad', call(N, 'PUT', f'/api/staff/certificates/{cn}/photo', {'dataUrl': 'data:text/plain;base64,AA=='}, jar=JN), call(G, 'PUT', f'/api/staff/certificates/{cg}/photo', {'dataUrl': 'data:text/plain;base64,AA=='}, jar=JG))
same('cert photo', call(N, 'PUT', f'/api/staff/certificates/{cn}/photo', {'dataUrl': png}, jar=JN), call(G, 'PUT', f'/api/staff/certificates/{cg}/photo', {'dataUrl': png}, jar=JG), exact=True)
pn = subprocess.run(['curl', '-s', '-b', JN, f'{N}/api/staff/certificates/{cn}/photo'], capture_output=True).stdout
pg = subprocess.run(['curl', '-s', '-b', JG, f'{G}/api/staff/certificates/{cg}/photo'], capture_output=True).stdout
check('cert photo bytes identical', pn == pg and len(pn) > 20, (len(pn), len(pg)))
same('cert photo 404', call(N, 'GET', '/api/staff/certificates/99999/photo', jar=JN), call(G, 'GET', '/api/staff/certificates/99999/photo', jar=JG))
a, b = both('GET', '/api/staff/certificates'); same('certificates after', a, b)
check('certificate view has photo + daysLeft', all(k in b[1]['certificates'][-1] for k in ('photo', 'daysLeft', 'verified_name')), b[1]['certificates'][-1:])
same('cert delete by other staff', call(N, 'DELETE', f'/api/staff/certificates/{cn}', jar=SN), call(G, 'DELETE', f'/api/staff/certificates/{cg}', jar=SG))
same('cert delete', call(N, 'DELETE', f'/api/staff/certificates/{cn}', jar=JN), call(G, 'DELETE', f'/api/staff/certificates/{cg}', jar=JG), exact=True)
same('cert delete missing', call(N, 'DELETE', f'/api/staff/certificates/{cn}', jar=JN), call(G, 'DELETE', f'/api/staff/certificates/{cg}', jar=JG))

# delivery zones
for bad in [{'name': '', 'points': [[1], [1, 2, 3], [100, 0], 'x', [1, 'a']], 'feeCents': 0, 'minCents': 0},
            {'name': 'A', 'points': 'x', 'feeCents': 0, 'minCents': 0}, {'name': 'A', 'points': [[1, 2]], 'feeCents': -1, 'minCents': 0, 'color': 'red'}, {}]:
    same(f'zone validation {list(bad)}', *both('POST', '/api/staff/delivery-zones', bad))
zone = {'name': 'CT zone', 'points': [[40, -74], [40.1, -74], [40.1, -73.9]], 'feeCents': 300, 'minCents': 1500, 'color': '#112233'}
same('zone add', *both('POST', '/api/staff/delivery-zones', zone), exact=True)
a, b = both('GET', '/api/staff/delivery-zones'); same('zones after add', a, b)
zn, zg = a[1]['zones'][-1]['id'], b[1]['zones'][-1]['id']
same('zone put', call(N, 'PUT', f'/api/staff/delivery-zones/{zn}', {**zone, 'active': False}, jar=JN), call(G, 'PUT', f'/api/staff/delivery-zones/{zg}', {**zone, 'active': False}, jar=JG), exact=True)
a, b = both('GET', '/api/staff/delivery-zones'); check('zone put applied', a[1]['zones'][-1]['active'] == b[1]['zones'][-1]['active'] == 0 and b[1]['zones'][-1]['points'] == zone['points'], b[1]['zones'][-1])
same('quote bad', *both('POST', '/api/o/delivery-quote', {'address': 'x'}))
same('geocode bad', *both('POST', '/api/staff/delivery-zones/geocode', {'address': '1'}))
same('zone delete', call(N, 'DELETE', f'/api/staff/delivery-zones/{zn}', jar=JN), call(G, 'DELETE', f'/api/staff/delivery-zones/{zg}', jar=JG), exact=True)

# catering feedback
tok = 'FBQM2uEo-LeZLDaUEdZv'
same('feedback bad', call(N, 'POST', f'/api/i/{tok}/feedback', {'rating': 9}), call(G, 'POST', f'/api/i/{tok}/feedback', {'rating': 9}))
same('feedback unknown', call(N, 'POST', '/api/i/nope-nope-nope-nope/feedback', {'rating': 5}), call(G, 'POST', '/api/i/nope-nope-nope-nope/feedback', {'rating': 5}))
same('feedback', call(N, 'POST', f'/api/i/{tok}/feedback', {'rating': 5, 'comment': 'Great'}), call(G, 'POST', f'/api/i/{tok}/feedback', {'rating': 5, 'comment': 'Great'}), exact=True)
same('feedback again', call(N, 'POST', f'/api/i/{tok}/feedback', {'rating': 3}), call(G, 'POST', f'/api/i/{tok}/feedback', {'rating': 3}), exact=True)
same_get(f'/api/i/{tok}/feedback', None, None, 'feedback page after')
same('catering-feedback list', *both('GET', '/api/staff/catering-feedback'))
done()
