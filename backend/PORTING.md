# Porting a Node module to the Go backend

The Go server (`backend/`) must answer **exactly** like the Node server (`server/src/*.js`): same
paths, status codes, JSON field names and types, error messages, audit entries, Socket.IO events.
The React client must not need any change. Read `internal/server/core_routes.go` first — it is
the reference port of `index.js` and shows every pattern below.

## Where things are

| Node | Go |
|---|---|
| `staff.get('/x', requireAuth('manager'), fn)` | `rt.staff("GET /x", "manager", fn)` (staff routes default to `"staff"`) |
| `app.post('/api/x', limiter, fn)` | `rt.pub("POST /api/x", fn, a.publicLim())` (also `orderLim`, `joinLim`, `custLim`, `authLim`) |
| `req.params.id` / `idParam(req)` | `c.Param("id")` / `c.ID()` — Go patterns use `{id}` |
| `req.query.x` | `c.Q("x")` |
| `parse(z.object({...}), req.body)` | `c.Body(valid.Object(map[string]valid.Schema{...}))` — see `internal/valid` |
| `db.prepare(sql).all/get/run(...)` | `c.All / c.One (nil if no row) / c.Get (error if no row) / c.Run / c.Val / c.N` |
| `getSettings()` / `setSettings({...})` | `c.S()` / `c.Tx.SetSettings(c.Ctx, map[string]string{...})` then `c.Refresh()` |
| `audit(req.user, action, detail, clientIp(req))` | `c.Audit(action, detail)`; other user or system: `c.AuditAs(user|nil, action, detail, ip)` |
| `notifyStaff('x')` | `c.Notify("x")` |
| `io.to('staff').emit(ev, data)` | `c.Emit("staff", ev, data)` (`"owners"`, `"user:3"`, `"guest:12"`, `"all"` for `io.emit`) |
| `res.status(409).json({error})` | `return conflict(msg)` / `bad` / `notFound` / `forbidden` / `fail(code,msg)` / `failX(code,msg,M{extra})` |
| error answer whose writes must still be kept (audit of a failure) | `return &committedError{HTTPError{Status:…, Msg:…}}` |
| `res.json(x)` | `return c.JSON(x)` ; `c.OK()` for `{ok:true}` |
| `G.someHook = fn` (shared between modules) | `a.G["someHook"] = func(c *C, args ...any) (any, error) {...}` — keep the Node name |
| `G.someHook?.(x)` | `c.G("someHook", x)` (returns nil,nil if no module registered it) / `c.Has("someHook")` |
| `menuHooks.adjust.push(f)` / `menuHooks.combo = f` | `a.menu.adjust = append(...)` / `a.menu.combo = f` |
| `orderHooks.inserted/voided.push(f)` | `a.orders.inserted/voided = append(...)` |
| `setInterval(() => forEachLocation(fn), ms)` | `a.every("name", d, func(c *C) error {...})` inside your register function |
| `pushToGuest/pushToCustomer/pushToUsers` | `a.pushToGuest(c.Ctx, c.Tx, id, M{...})` etc. (`notify.go`) |
| `emailGuest(to, {...})` | `emailGuest(to, emailMsg{...})` |
| `QRCode.toString(link, {type:'svg', margin:1})` | `qrSVG(link, 1, dark, light, highEC)` |
| `publicBase(req)` | `c.PublicBase()` |
| customers: `requireCustomer`, `customerFromReq` | `c.requireCustomer()`, `c.Customer()` |
| `h.managerOr('void')` middleware | `by, err := c.managerOr("void")` at the top of the handler |
| `G.hasApproval(req, 'discount')` | `c.hasApproval("discount")` |
| device tokens `jwt.sign(x, secret+':kiosk')` | `a.sess.SignDevice("kiosk", claims)` / `a.sess.VerifyDevice(kind, tok)` |
| other JWTs signed with the plain secret | `a.signJWT(claims, ttl)` / `a.verifyJWT(tok)` |
| order builder: `priceLines`, `insertOrder`, `returnStock`, `menuWithMods`, `dueOf`, `lineSchema` | `c.priceLines`, `c.insertOrder(newOrder{...})`, `c.returnStock`, `c.menuWithMods`, `dueOf`, `lineSchema` (`orders.go`) |
| waitlist helpers: `createGuest`, `pushGuest`, `buzzGuest`, `alertGuest`, `markReady`, `guestPublicView` | same names as methods on `*C` (`guests.go`, `core_routes.go`) |
| `alertOwners(title, body, tag)` | `c.alertOwners(title, body, tag)` |

Values from the database come back loosely typed like SQLite: integers as `int64`, reals as
`float64`, booleans as 0/1, text as `string`, NULL as `nil`. Use `str()`, `i64()`, `f64()`,
`truthy()`, `orNil()` (JS `x || null`). `roundJS` is `Math.round`. `dollars(cents)` is
`(cents/100).toFixed(2)`. `jparse(v, def)` is `JSON.parse` with a fallback.

SQL is written in SQLite dialect and translated (`internal/store/sql.go`): `?` placeholders,
`datetime('now','-1 day')`, `date(x)`, `julianday`, `strftime`, `group_concat`, `INSERT OR IGNORE`,
`INSERT OR REPLACE`, `ON CONFLICT ... excluded.x`, `localdate(x)` / `localtoday()` all work. Postgres
is stricter in a few places — fix these by hand:
- `GROUP BY alias` with an expression: repeat the expression.
- `ON CONFLICT ... DO UPDATE SET col = COALESCE(excluded.col, col)`: qualify the bare column (`table.col`).
- Comparing a text column to a number (`WHERE code = 123`): pass the matching type.
- `ORDER BY x DESC` where SQLite put NULLs last: add `NULLS LAST`.
- Booleans in expressions (`a = b AS flag`): use `CASE WHEN ... THEN 1 ELSE 0 END` to keep 0/1.
- `LIKE` is turned into `ILIKE` (SQLite LIKE ignores case).
Every request runs in **one transaction**; any error rolls the whole request back (Node sometimes
kept partial writes — the Go behaviour is fine and preferred). Responses are buffered and only sent
after commit. `c.Emit`/`c.Notify` are sent after commit too.

All tables and columns already exist (`migrations/0001_schema.sql` was generated from the full
SQLite schema). If you truly need a new database object, add `migrations/<your range>_<name>.sql`.

## Rules for parallel work

1. Put your port in **new files only**: `internal/server/<module>.go` (one per Node module, e.g.
   `kds.go`). Register with `func init() { modules = append(modules, (*App).registerKds) }`.
2. **Do not edit shared files** (`ctx.go`, `guests.go`, `orders.go`, `core_routes.go`, `router.go`,
   `server.go`, `module.go`, `notify.go`, `guard.go`, `settings.go`, `internal/valid`, `internal/store`,
   `internal/auth`). If you need a shared helper, write it in your own file.
3. **Prefix every new top-level identifier** (functions, types, vars, methods on `*C`/`*App`) with
   your module name — e.g. `kdsTicketView`, `(c *C) kdsBump` — so ports merge without clashes.
   Exception: the `register<Module>` function.
4. Hooks that another module provides: call `c.G("NodeName", ...)` and keep going if it's nil.
   Hooks your module provides: register them under the **exact** Node `G.` / `h.` name.
5. Keep error messages, field names, status codes and audit action/detail strings identical.
6. Test against the Node server with the contract helpers in `tests/contractlib.py`
   (`same_get`, `call`, `diff`, `check`). Write `tests/contract_<module>.py`. Use your own Node
   and Go ports and your own database (see your task). PINs: owner 8642, staff Ana 5791.
7. `gofmt`, `go vet ./...` and your contract tests must pass before you commit.
