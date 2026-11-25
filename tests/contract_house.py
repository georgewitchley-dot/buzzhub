from contractlib import *
JN, JG = '/tmp/j5_n', '/tmp/j5_g'; SN, SG = '/tmp/j5_sn', '/tmp/j5_sg'
login(N, '8642', JN); login(G, '8642', JG); login(N, '5791', SN); login(G, '5791', SG)

def both(method, path, body=None, jn=JN, jg=JG):
    return call(N, method, path, body, jar=jn), call(G, method, path, body, jar=jg)
def pair(method, pn, pg, body=None, jn=JN, jg=JG):
    return call(N, method, pn, body, jar=jn), call(G, method, pg, body, jar=jg)
def same(label, a, b, exact=False):
    check(f'{label}: status {a[0]}', a[0] == b[0], (a, b))
    if a[0] == b[0] == 200 and isinstance(a[1], (dict, list)):
        if exact: check(f'{label}: same value', a[1] == b[1], (a[1], b[1]))
        else:
            d = diff(shape(a[1]), shape(b[1])); check(f'{label}: same shape', not d, d)
    elif a[0] >= 400: check(f'{label}: same error', a[1] == b[1], (a[1], b[1]))

for p in ['/api/staff/checklists', '/api/staff/checklists?day=2026-11-02', '/api/staff/temps', '/api/staff/inspection-log', '/api/staff/inspection-log?from=2026-10-01&to=2026-11-30',
          '/api/public/events', '/api/staff/events', '/api/staff/events/1/attendees', '/api/e/jb2nXU7QStu4wgGv', '/api/e/nope', '/api/staff/deposits',
          '/api/staff/deposits?from=2026-10-01&to=2026-11-20', '/api/staff/menu-engineering', '/api/staff/menu-engineering?days=180', '/api/staff/prep', '/api/staff/prep?date=2026-11-28']:
    same_get(p, JN, JG)
same_get('/api/staff/checklists', SN, SG, 'checklists as staff')
same_get('/api/staff/deposits', SN, SG, 'deposits as staff')
for p in ['/api/staff/deposits?from=2026-10-01&to=2026-11-20', '/api/staff/menu-engineering', '/api/staff/prep?date=2026-11-28', '/api/staff/inspection-log?from=2026-10-01&to=2026-11-20',
          '/api/staff/events/1/attendees']:
    same(f'{p} values', *both('GET', p), exact=True)
a, b = both('GET', '/api/e/jb2nXU7QStu4wgGv'); a[1].pop('svg'); b[1].pop('svg'); same('ticket page values (svg aside)', a, b, exact=True)

# checklists
same('template bad', *both('POST', '/api/staff/checklist-templates', {'name': '', 'kind': 'x', 'items': [], 'dueTime': '9'}))
same('template add (staff forbidden)', *both('POST', '/api/staff/checklist-templates', {'name': 'X', 'kind': 'daily', 'items': [{'text': 'a'}]}, SN, SG))
a, b = both('POST', '/api/staff/checklist-templates', {'name': 'CT list', 'kind': 'daily', 'dueTime': '00:01', 'items': [{'text': 'one'}, {'text': 'temp', 'needsValue': True}]})
same('template add', a, b)
tn, tg = a[1]['id'], b[1]['id']
same('template put', *pair('PUT', f'/api/staff/checklist-templates/{tn}', f'/api/staff/checklist-templates/{tg}', {'name': 'CT list', 'kind': 'weekly', 'dow': None, 'dueTime': '00:01', 'items': [{'text': 'one'}, {'text': 'temp', 'needsValue': True}], 'area': 'Kitchen'}), exact=True)
same('template put back', *pair('PUT', f'/api/staff/checklist-templates/{tn}', f'/api/staff/checklist-templates/{tg}', {'name': 'CT list', 'kind': 'daily', 'dueTime': '00:01', 'items': [{'text': 'one'}, {'text': 'temp', 'needsValue': True}]}), exact=True)
same('check bad item', *pair('POST', f'/api/staff/checklists/{tn}/check', f'/api/staff/checklists/{tg}/check', {'index': 5, 'done': True}, SN, SG))
same('check missing tpl', *both('POST', '/api/staff/checklists/9999/check', {'index': 0, 'done': True}))
same('check bad body', *both('POST', '/api/staff/checklists/1/check', {'index': -1}))
same('check 1', *pair('POST', f'/api/staff/checklists/{tn}/check', f'/api/staff/checklists/{tg}/check', {'index': 0, 'done': True}, SN, SG), exact=True)
a, b = both('GET', '/api/staff/checklists', jn=SN, jg=SG)
ln = next(x for x in a[1]['lists'] if x['name'] == 'CT list'); lg = next(x for x in b[1]['lists'] if x['name'] == 'CT list')
check('list overdue + count same', (ln['overdue'], ln['count'], ln['total']) == (lg['overdue'], lg['count'], lg['total']), (ln, lg))
check('done entry fields', set(ln['items'][0]['done']) == set(lg['items'][0]['done']), (ln['items'][0], lg['items'][0]))
same('check 2 completes', *pair('POST', f'/api/staff/checklists/{tn}/check', f'/api/staff/checklists/{tg}/check', {'index': 1, 'done': True, 'value': '38'}, SN, SG), exact=True)
same('uncheck', *pair('POST', f'/api/staff/checklists/{tn}/check', f'/api/staff/checklists/{tg}/check', {'index': 1, 'done': False}, SN, SG), exact=True)
same('starter exists', *both('POST', '/api/staff/checklist-templates/starter', {}))
same_get('/api/staff/checklists', JN, JG, 'checklists after')

# temperatures
same('temp unit bad', *both('POST', '/api/staff/temp-units', {'name': 'X', 'min': 40, 'max': 30, 'scale': 'F'}))
same('temp unit bad body', *both('POST', '/api/staff/temp-units', {'name': '', 'scale': 'K'}))
same('temp unit add', *both('POST', '/api/staff/temp-units', {'name': 'CT fridge', 'min': 33, 'max': 41, 'scale': 'F'}), exact=True)
a, b = both('GET', '/api/staff/temps'); un, ug = a[1]['units'][-1]['id'], b[1]['units'][-1]['id']
same('temp out of range', *pair('POST', f'/api/staff/temps/{un}', f'/api/staff/temps/{ug}', {'value': 45.5}, SN, SG))
same('temp out of range fixed', *pair('POST', f'/api/staff/temps/{un}', f'/api/staff/temps/{ug}', {'value': 45.5, 'corrective': 'moved food'}, SN, SG), exact=True)
same('temp ok', *pair('POST', f'/api/staff/temps/{un}', f'/api/staff/temps/{ug}', {'value': 38, 'note': 'fine'}, SN, SG), exact=True)
same('temp unknown unit', *both('POST', '/api/staff/temps/9999', {'value': 38}))
same('temp bad unit id', *both('POST', '/api/staff/temps/abc', {'value': 38}))
a, b = both('GET', '/api/staff/temps'); same('temps after', a, b)
check('temps today same', [ (x['value'], x['ok']) for x in a[1]['units'][-1]['today']] == [(x['value'], x['ok']) for x in b[1]['units'][-1]['today']], (a[1]['units'][-1], b[1]['units'][-1]))
same('temp unit delete', *pair('DELETE', f'/api/staff/temp-units/{un}', f'/api/staff/temp-units/{ug}'), exact=True)

# events + tickets
same('event bad', *both('POST', '/api/staff/events', {'title': '', 'startsLocal': '2026-12-01', 'capacity': 0, 'priceCents': -1}))
ev = {'title': 'CT night', 'startsLocal': '2027-01-10 19:00', 'capacity': 3, 'priceCents': 0, 'maxPerOrder': 2}
a, b = both('POST', '/api/staff/events', ev); same('event add', a, b)
en, eg = a[1]['id'], b[1]['id']
same('event put', *pair('PUT', f'/api/staff/events/{en}', f'/api/staff/events/{eg}', {**ev, 'description': 'Fun', 'endsLocal': ''}), exact=True)
tb = {'name': 'Pat Doe', 'email': 'pat@example.com', 'qty': 2}
same('ticket too many per order', *pair('POST', f'/api/public/events/{en}/tickets', f'/api/public/events/{eg}/tickets', {**tb, 'qty': 3}))
same('ticket bad body', *pair('POST', f'/api/public/events/{en}/tickets', f'/api/public/events/{eg}/tickets', {'email': 'x'}))
same('ticket unknown event', *both('POST', '/api/public/events/9999/tickets', tb))
a, b = pair('POST', f'/api/public/events/{en}/tickets', f'/api/public/events/{eg}/tickets', tb); same('ticket free', a, b)
cn, cg = a[1]['url'].split('/ticket/')[1], b[1]['url'].split('/ticket/')[1]
check('ticket code 16 chars', len(cn) == len(cg) == 16, (cn, cg))
same('ticket sold out', *pair('POST', f'/api/public/events/{en}/tickets', f'/api/public/events/{eg}/tickets', tb))
same('ticket page', *pair('GET', f'/api/e/{cn}', f'/api/e/{cg}'))
a, b = pair('GET', f'/api/e/{cn}', f'/api/e/{cg}'); check('ticket svg on both', bool(a[1]['svg']) and bool(b[1]['svg']) and b[1]['svg'].startswith('<svg'), '')
same('checkin unknown', *both('POST', '/api/staff/tickets/checkin', {'code': 'BH-T-nope'}))
same('checkin 1', *(call(N, 'POST', '/api/staff/tickets/checkin', {'code': f'BH-T-{cn}', 'count': 1}, jar=SN), call(G, 'POST', '/api/staff/tickets/checkin', {'code': f'BH-T-{cg}', 'count': 1}, jar=SG)), exact=True)
same('checkin rest', call(N, 'POST', '/api/staff/tickets/checkin', {'code': cn}, jar=SN), call(G, 'POST', '/api/staff/tickets/checkin', {'code': cg}, jar=SG), exact=True)
same('checkin again', call(N, 'POST', '/api/staff/tickets/checkin', {'code': cn}, jar=SN), call(G, 'POST', '/api/staff/tickets/checkin', {'code': cg}, jar=SG))
a, b = pair('GET', f'/api/staff/events/{en}/attendees', f'/api/staff/events/{eg}/attendees'); same('attendees', a, b)
tidn, tidg = a[1][0]['id'], b[1][0]['id']
same('ticket cancel', *pair('POST', f'/api/staff/tickets/{tidn}/cancel', f'/api/staff/tickets/{tidg}/cancel', {}), exact=True)
same('ticket cancel missing', *both('POST', '/api/staff/tickets/99999/cancel', {}))
same('checkin cancelled', call(N, 'POST', '/api/staff/tickets/checkin', {'ticketId': tidn}, jar=SN), call(G, 'POST', '/api/staff/tickets/checkin', {'ticketId': tidg}, jar=SG))
a, b = both('POST', '/api/staff/events', {**ev, 'title': 'CT paid', 'priceCents': 1500})
pn, pg = call(N, 'GET', '/api/public/events')[1]['payOnline'], call(G, 'GET', '/api/public/events')[1]['payOnline']
r = pair('POST', f'/api/public/events/{a[1]["id"]}/tickets', f'/api/public/events/{b[1]["id"]}/tickets', tb)
if pn == pg: same('paid ticket', *r)
else: check('paid ticket: Go has no payments port yet, so it answers 503 (Node pays online)', r[1][0] == 503 and r[0][0] == 200, r)
a, b = both('GET', '/api/staff/events'); same('events after', a, b)
sel = lambda l: [(e['title'], e['sold'], e['checkedIn'], e['left']) for e in l if e['title'] != 'CT paid' or pn == pg]
check('events sold/checkedIn same', sel(a[1]['events']) == sel(b[1]['events']), (a[1]['events'][:3], b[1]['events'][:3]))
same_get('/api/public/events', JN, JG, 'public events after')

# deposits
same('deposit bad', *both('POST', '/api/staff/deposits', {'source': 'gold', 'amountCents': 0}))
same('deposit days reversed', *both('POST', '/api/staff/deposits', {'source': 'cash', 'amountCents': 100, 'depositDate': '2026-11-10', 'coverFrom': '2026-11-09', 'coverTo': '2026-11-01'}))
same('deposit add', *both('POST', '/api/staff/deposits', {'source': 'card', 'amountCents': 12345, 'depositDate': '2026-11-10', 'coverFrom': '2026-11-05', 'coverTo': '2026-11-08', 'reference': 'CT'}), exact=True)
a, b = both('GET', '/api/staff/deposits?from=2026-11-01&to=2026-11-20'); same('deposits after', a, b, exact=True)
dn, dg = a[1]['deposits'][0]['id'], b[1]['deposits'][0]['id']
same('deposit import', *both('POST', '/api/staff/deposits/import', {}), exact=True)
same('deposit delete', *pair('DELETE', f'/api/staff/deposits/{dn}', f'/api/staff/deposits/{dg}'), exact=True)
done()
