package server

// Port of server/src/kds.js: kitchen area screens (one device token per area), expo, packing,
// all-day counts and the menu board TV. Also holds the small helpers the other kitchen modules
// (line.go, pass.go, station.go, pace.go) share.

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

func init() { modules = append(modules, (*App).registerKds) }

const (
	kdsExpo = "Expo"
	kdsPack = "Packing"
	kdsAll  = "All areas"
)

/* ---------- JS-like helpers shared by the kitchen modules ---------- */

// kdsPJ is the modules' pj(): JSON.parse(v) with a fallback. A SQL NULL parses to null, as in JS.
func kdsPJ(v any, d any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		var out any
		if json.Unmarshal([]byte(x), &out) != nil {
			return d
		}
		return out
	case int64, float64:
		return x
	}
	return d
}

// kdsList is a parsed JSON value as an array (nil when it is not one).
func kdsList(v any) []any { l, _ := v.([]any); return l }

// kdsJS is JavaScript's String(v).
func kdsJS(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case int64:
		return itoa(x)
	case int:
		return strconv.Itoa(x)
	case float64:
		if math.IsNaN(x) {
			return "NaN"
		}
		return fmtJSNum(x)
	}
	return str(v)
}

// kdsNum is JavaScript's Number(v) (NaN for junk).
func kdsNum(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case int64:
		return float64(x)
	case int:
		return float64(x)
	case float64:
		return x
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

// kdsNumOr is Number(v) || def.
func kdsNumOr(v any, def float64) float64 {
	f := kdsNum(v)
	if f == 0 || math.IsNaN(f) {
		return def
	}
	return f
}

// kdsSetNum is Number(s || def) for a setting (empty string falls back).
func kdsSetNum(v string, def float64) float64 {
	if v == "" {
		return def
	}
	return kdsNum(v)
}

// kdsOut turns a float into a JSON-safe value (NaN → null, as JSON.stringify does).
func kdsOut(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return f
}

func kdsR1(x float64) float64 { return float64(roundJS(x*10)) / 10 }
func kdsR2(x float64) float64 { return float64(roundJS(x*100)) / 100 }

// kdsMs is Date.parse(`${sql.replace(' ','T')}Z`) in milliseconds (NaN when it does not parse).
func kdsMs(v any) float64 {
	s := strings.Replace(kdsJS(v), " ", "T", 1) + "Z"
	for _, f := range []string{"2006-01-02T15:04:05Z", "2006-01-02T15:04:05.999999999Z", "2006-01-02T15:04Z", "2006-01-02Z"} {
		if t, err := time.Parse(f, s); err == nil {
			return float64(t.UnixMilli())
		}
	}
	return math.NaN()
}

// kdsSQLAt formats milliseconds as SQLite UTC text.
func kdsSQLAt(ms float64) string {
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02 15:04:05")
}
func kdsNowSQL() string { return store.Now() }
func kdsNowMs() float64 { return float64(time.Now().UnixMilli()) }

func (c *C) kdsTZ() *time.Location {
	tz := c.S()["timezone"]
	if tz == "" {
		tz = "America/New_York"
	}
	return loadTZ(tz)
}
func (c *C) kdsLocalToday() string { return time.Now().In(c.kdsTZ()).Format("2006-01-02") }

// kdsDayBounds is ops.js dayBounds: UTC bounds of a local business day.
func (c *C) kdsDayBounds(date string) (string, string) {
	d, err := time.Parse("2006-01-02", date)
	if err != nil {
		return "", ""
	}
	_, off := d.Add(12 * time.Hour).In(c.kdsTZ()).Zone()
	start := d.Add(-time.Duration(off) * time.Second)
	return start.Format("2006-01-02 15:04:05"), start.Add(24 * time.Hour).Format("2006-01-02 15:04:05")
}

// kdsAddDays is addDays(d, n) with a possibly fractional n, as the JS does.
func kdsAddDays(d string, n float64) string {
	t, err := time.Parse("2006-01-02", d)
	if err != nil {
		return d
	}
	return t.Add(12*time.Hour + time.Duration(n*86400000)*time.Millisecond).Format("2006-01-02")
}

// kdsDays is Math.min(hi, Math.max(lo, Number(req.query.days) || def)).
func (c *C) kdsDays(def, lo, hi float64) float64 {
	return math.Min(hi, math.Max(lo, kdsNumOr(c.Q("days"), def)))
}

// kdsSince is the start of the window of the last `days` local days.
func (c *C) kdsSince(days float64) string {
	s, _ := c.kdsDayBounds(kdsAddDays(c.kdsLocalToday(), -(days - 1)))
	return s
}

// kdsPID is Number(req.params[name]) for a query: nil when it is not a whole number.
func (c *C) kdsPID(name string) any {
	s := c.Param(name)
	f := kdsNum(s)
	if math.IsNaN(f) || f != math.Trunc(f) {
		return nil
	}
	return int64(f)
}

// kdsFirst is name.split(' ')[0].
func kdsFirst(s string) string { return strings.SplitN(s, " ", 2)[0] }

// kdsUser reads the staff session cookie (userFromToken).
func (c *C) kdsUser() *auth.User {
	if c.U != nil {
		return c.U
	}
	u, err := c.a.sess.UserFromToken(c.Ctx, c.Tx, cookie(c.R, auth.SessionCookie))
	if err != nil {
		return nil
	}
	return u
}

// kdsWhoT is who an area-screen request is from.
type kdsWhoT struct {
	area   string
	user   *auth.User
	device bool
}

// kdsWho is the `who` of the kitchen modules: an area screen token in X-Kds, or a signed-in staff
// member picking an area with ?area=. strict is the kds.js variant (its messages, and an unknown area
// becomes All areas); line/pass/station use the short messages and the area as given.
func (c *C) kdsWho(strict bool) (*kdsWhoT, error) {
	if t := c.R.Header.Get("X-Kds"); t != "" {
		if p, ok := c.a.sess.VerifyDevice("kds", t); ok && kdsJS(p["loc"]) == c.Slug() && kdsJS(p["v"]) == c.kdsVersion("kds_version") {
			return &kdsWhoT{area: kdsJS(p["area"]), device: true}, nil
		}
		if strict {
			return nil, fail(http.StatusUnauthorized, "This kitchen screen is signed out. A manager needs to set it up again.")
		}
		return nil, fail(http.StatusUnauthorized, "This kitchen screen is signed out.")
	}
	u := c.kdsUser()
	if u == nil {
		if strict {
			return nil, fail(http.StatusUnauthorized, "Sign in or set this screen up from the Kitchen page.")
		}
		return nil, fail(http.StatusUnauthorized, "Sign in first")
	}
	area := kdsAll
	if q := c.Q("area"); q != "" {
		area = q
	} else if b, ok := c.Raw().(map[string]any); ok && truthy(b["area"]) {
		area = kdsJS(b["area"])
	}
	if strict && !kdsHas(c.kdsAreaNames(), area) {
		area = kdsAll
	}
	return &kdsWhoT{area: area, user: u}, nil
}

func (c *C) kdsVersion(key string) string {
	if v := c.S()[key]; v != "" {
		return v
	}
	return "1"
}

func kdsHas(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// kdsStationList is the kitchen areas from the setting (at least one).
func (c *C) kdsStationList() []string {
	l, ok := kdsPJ(c.S()["kitchen_stations"], []any{"Kitchen"}).([]any)
	if !ok || len(l) == 0 {
		return []string{"Kitchen"}
	}
	out := make([]string, len(l))
	for i, x := range l {
		out[i] = kdsJS(x)
	}
	return out
}
func (c *C) kdsStationMap() map[string]any {
	m, _ := kdsPJ(c.S()["station_map"], M{}).(map[string]any)
	return m
}

// kdsStationFor: which area makes this item: the item's own choice, else its category's, else the first area.
func kdsStationFor(item M, list []string, mp map[string]any) string {
	if st, ok := item["station"].(string); ok && st != "" && kdsHas(list, st) {
		return st
	}
	if st, ok := mp[kdsJS(item["category"])].(string); ok && st != "" && kdsHas(list, st) {
		return st
	}
	return list[0]
}
func (c *C) kdsStationOf(item M) string {
	return kdsStationFor(item, c.kdsStationList(), c.kdsStationMap())
}

func (c *C) kdsAreaNames() []string {
	return append(c.kdsStationList(), kdsExpo, kdsPack, "Runner", kdsAll)
}

// kdsLive: held courses don't count until fired.
func kdsLive(i M) bool { return i64(i["course"]) <= 1 || truthy(i["fired_at"]) }

// kdsSign makes a device token like jwt.sign(claims, secret + ':' + kind, { expiresIn: '365d' }).
func (c *C) kdsSign(kind string, claims jwt.MapClaims) (string, error) {
	now := time.Now().Unix()
	claims["iat"] = now
	claims["exp"] = now + 365*86400
	return c.a.sess.SignDevice(kind, claims)
}

// kdsAsBool reads a hook's answer as JS truthiness.
func kdsAsBool(v any, err error) (bool, error) { return truthy(v), err }

// kdsSavepoint runs best-effort work (try { … } catch {}): its failure is ignored and rolled back.
func (c *C) kdsSavepoint(fn func() error) { _ = c.Tx.Savepoint(c.Ctx, fn) }

var kdsAllergyRE = regexp.MustCompile(`(?i)allerg|free|vegan|celiac|dairy|lactose`)

/* ---------- the board every screen reads ---------- */

func (c *C) kdsBoard() ([]M, error) {
	s := c.S()
	list := c.kdsStationList()
	mp := c.kdsStationMap()
	orders, err := c.All(`SELECT o.id, o.number, o.status, o.source, o.customer_name, o.sent_at, o.ready_at, o.created_at, o.fulfillment, o.delivery_address, o.order_notes, o.prepaid, o.allergy_note, o.packed_at, o.expo_at, o.driver_id, o.arrived_at, o.arrival_note, o.handed_at, o.served_at, o.makegood_at, o.tab_id, o.allergy_handed_by, o.priority,
      t.label table_label, g.name guest_name, (SELECT c.tags FROM customers c WHERE c.id = COALESCE(o.customer_id, g.customer_id)) customer_tags, (SELECT name FROM users WHERE id = o.driver_id) driver_name
    FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN guests g ON g.id = o.guest_id
    WHERE o.status IN ('open','sent') OR (o.status IN ('ready','paid') AND o.ready_at > datetime('now','-45 minutes'))
    ORDER BY o.priority DESC, COALESCE(o.sent_at, o.created_at), o.id`)
	if err != nil {
		return nil, err
	}
	var items []store.Row
	if len(orders) > 0 {
		ids := make([]string, len(orders))
		for i, o := range orders {
			ids[i] = itoa(i64(o["id"]))
		}
		if items, err = c.All(`SELECT oi.id, oi.order_id, oi.item_id, oi.name, oi.qty, oi.note, oi.mods, oi.course, oi.fired_at, oi.done_at, oi.done_station, oi.seat, oi.seat_name, oi.done_by, m.category, m.station, m.cook_minutes
    FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id IN (` + strings.Join(ids, ",") + `) ORDER BY oi.id`); err != nil {
			return nil, err
		}
	}
	pacing := s["kds_pacing"] == "1"
	now := kdsNowMs()
	out := []M{}
	for _, x := range orders {
		cooking := str(x["status"]) == "open" || str(x["status"]) == "sent"
		parts := []string{}
		if truthy(x["allergy_note"]) {
			parts = append(parts, kdsJS(x["allergy_note"]))
		}
		tags := []any{}
		if t, ok := kdsPJ(orEmptyList(x["customer_tags"]), nil).([]any); ok {
			tags = t
		}
		for _, t := range tags {
			if ts, ok := t.(string); ok && kdsAllergyRE.MatchString(ts) && ts != "" {
				parts = append(parts, ts)
			}
		}
		allergy := strings.Join(parts, ", ")
		its := []M{}
		for _, i := range items {
			if i64(i["order_id"]) != i64(x["id"]) {
				continue
			}
			mods := []any{}
			for _, m := range kdsList(kdsPJ(orEmptyList(i["mods"]), []any{})) {
				mm, _ := m.(map[string]any)
				mods = append(mods, mm["name"])
			}
			held := !kdsLive(i)
			var fireIn any
			if held && c.Has("fireIn") {
				if fireIn, err = c.G("fireIn", x["id"], i["course"]); err != nil {
					return nil, err
				}
			}
			its = append(its, M{"id": i["id"], "itemId": i["item_id"], "name": i["name"], "qty": i["qty"], "note": i["note"], "mods": mods, "course": i["course"], "held": held,
				"done": truthy(i["done_at"]), "doneAt": i["done_at"], "area": kdsStationFor(i, list, mp), "cook": i["cook_minutes"], "firedAt": i["fired_at"],
				"seat": orNil(i["seat"]), "seatName": orNil(i["seat_name"]), "fireIn": fireIn})
		}
		// pacing: the longest dish on the ticket starts now; shorter ones wait so everything finishes together
		if pacing && cooking {
			maxCook := 0.0
			for _, i := range its {
				if !i["held"].(bool) && !i["done"].(bool) && truthy(i["cook"]) {
					maxCook = math.Max(maxCook, f64(i["cook"]))
				}
			}
			for _, i := range its {
				if i["held"].(bool) || i["done"].(bool) || !truthy(i["cook"]) {
					i["startIn"] = nil
					continue
				}
				baseV := i["firedAt"]
				if !truthy(baseV) {
					baseV = x["sent_at"]
				}
				if !truthy(baseV) {
					baseV = x["created_at"]
				}
				at := kdsMs(baseV) + (maxCook-f64(i["cook"]))*60000
				i["startIn"] = kdsOut(math.Max(0, math.Ceil((at-now)/60000)))
			}
		}
		areas := M{}
		live2 := []M{}
		for _, i := range its {
			if i["held"].(bool) {
				continue
			}
			live2 = append(live2, i)
			a, _ := areas[i["area"].(string)].(M)
			if a == nil {
				a = M{"total": int64(0), "done": int64(0)}
				areas[i["area"].(string)] = a
			}
			a["total"] = i64(a["total"]) + 1
			if i["done"].(bool) {
				a["done"] = i64(a["done"]) + 1
			}
		}
		var passSince any
		if cooking && len(live2) > 0 {
			all := true
			last := ""
			for _, i := range live2 {
				if !i["done"].(bool) {
					all = false
					break
				}
				if d := kdsJS(i["doneAt"]); d > last {
					last = d
				}
			}
			if all {
				passSince = last
			}
		}
		photo := false
		if c.Has("photoNeeded") {
			xx := M{}
			for k, v := range x {
				xx[k] = v
			}
			xx["allergy"] = allergy
			if photo, err = kdsAsBool(c.G("photoNeeded", xx)); err != nil {
				return nil, err
			}
			if photo {
				has, err := kdsAsBool(c.G("hasPlatePhoto", x["id"]))
				if err != nil {
					return nil, err
				}
				photo = !has
			}
		}
		makegood := false
		if c.Has("makegoodDue") {
			if makegood, err = kdsAsBool(c.G("makegoodDue", x)); err != nil {
				return nil, err
			}
		}
		o := M{}
		for k, v := range x {
			if k != "customer_tags" {
				o[k] = v
			}
		}
		o["allergy"], o["items"], o["areas"], o["passSince"], o["photoNeeded"], o["makegood"], o["cooking"] = allergy, its, areas, passSince, photo, makegood, cooking
		o["arrived"] = truthy(x["arrived_at"]) && !truthy(x["handed_at"])
		out = append(out, o)
	}
	return out, nil
}

// orEmptyList is `v || '[]'`.
func orEmptyList(v any) any {
	if !truthy(v) {
		return "[]"
	}
	return v
}

// kdsAllDay: how many of each item are still to make, for one area or all.
func kdsAllDay(orders []M, area string) []M {
	type cnt struct {
		name, area string
		qty        int64
		mods       []string
		modQ       map[string]int64
	}
	byName := map[string]*cnt{}
	order := []*cnt{}
	for _, o := range orders {
		if !truthy(o["cooking"]) {
			continue
		}
		for _, i := range o["items"].([]M) {
			if i["held"].(bool) || i["done"].(bool) || (area != "" && i["area"] != area) {
				continue
			}
			k := kdsJS(i["name"])
			cc := byName[k]
			if cc == nil {
				cc = &cnt{name: k, area: i["area"].(string), modQ: map[string]int64{}}
				byName[k] = cc
				order = append(order, cc)
			}
			cc.qty += i64(i["qty"])
			for _, m := range i["mods"].([]any) {
				mn := kdsJS(m)
				if _, ok := cc.modQ[mn]; !ok {
					cc.mods = append(cc.mods, mn)
				}
				cc.modQ[mn] += i64(i["qty"])
			}
		}
	}
	sort.SliceStable(order, func(a, b int) bool { return order[a].qty > order[b].qty })
	out := []M{}
	for _, cc := range order {
		mods := []M{}
		for _, m := range cc.mods {
			mods = append(mods, M{"name": m, "qty": cc.modQ[m]})
		}
		out = append(out, M{"name": cc.name, "qty": cc.qty, "area": cc.area, "mods": mods})
	}
	return out
}

/* ---------- allergy check ---------- */

// kdsAllergyOf: the note on the order plus the customer's allergy tags.
func (c *C) kdsAllergyOf(o store.Row) (string, error) {
	cid, gid := o["customer_id"], o["guest_id"]
	if !truthy(cid) {
		cid = int64(0)
	}
	if !truthy(gid) {
		gid = int64(0)
	}
	r, err := c.One(`SELECT c.tags FROM customers c LEFT JOIN guests g ON g.customer_id = c.id WHERE c.id = ? OR g.id = ? LIMIT 1`, cid, gid)
	if err != nil {
		return "", err
	}
	parts := []string{}
	if truthy(o["allergy_note"]) {
		parts = append(parts, kdsJS(o["allergy_note"]))
	}
	var tags any = "[]"
	if r != nil && truthy(r["tags"]) {
		tags = r["tags"]
	}
	for _, t := range kdsList(kdsPJ(tags, []any{})) {
		if ts, ok := t.(string); ok && ts != "" && kdsAllergyRE.MatchString(ts) {
			parts = append(parts, ts)
		}
	}
	return strings.Join(parts, ", "), nil
}

func (w *kdsWhoT) label() string {
	if w.user != nil {
		return w.user.Name
	}
	return w.area + " screen"
}

func (c *C) kdsCheckAllergy(o store.Row, w *kdsWhoT) error {
	if _, err := c.Run(`UPDATE orders SET allergy_checked_by = ? WHERE id = ?`, w.label(), o["id"]); err != nil {
		return err
	}
	al, err := c.kdsAllergyOf(o)
	if err != nil {
		return err
	}
	return c.AuditAs(w.user, "allergy.check", fmt.Sprintf("#%s: %s (%s)", kdsJS(o["number"]), al, w.label()), c.IP())
}

func (c *C) kdsOrder(id any) (store.Row, error) {
	o, err := c.One(`SELECT * FROM orders WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	if o == nil {
		return nil, notFound("Order not found")
	}
	return o, nil
}

func (c *C) kdsFinished(oid any) (bool, error) {
	a, err := c.N(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND done_at IS NULL AND (course <= 1 OR fired_at IS NOT NULL)`, oid)
	if err != nil || a != 0 {
		return false, err
	}
	b, err := c.N(`SELECT COUNT(*) c FROM order_items WHERE order_id = ? AND fired_at IS NULL AND course > 1`, oid)
	return b == 0, err
}

// kdsSpeed: average minutes from ticket in to area done, today, per area.
func (c *C) kdsSpeed() ([]M, error) {
	rows, err := c.All(`SELECT oi.done_station area, COUNT(*) n, AVG((julianday(oi.done_at) - julianday(COALESCE(oi.fired_at, o.sent_at, o.created_at))) * 1440) m
      FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.done_at >= datetime('now','-1 day') AND oi.done_station IS NOT NULL GROUP BY oi.done_station ORDER BY oi.done_station`)
	if err != nil {
		return nil, err
	}
	out := []M{}
	for _, r := range rows {
		out = append(out, M{"area": r["area"], "items": r["n"], "minutes": kdsR1(f64(r["m"]))})
	}
	return out, nil
}

func kdsStatusIn(o M, sts ...string) bool {
	s := str(o["status"])
	for _, x := range sts {
		if s == x {
			return true
		}
	}
	return false
}

func (a *App) registerKds(rt *router) {
	/* ===== setting the screens up ===== */
	rt.staff("POST /kds/start", "manager", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"area": valid.String().Min(1).Max(24)}))
		if err != nil {
			return err
		}
		area := str(b["area"])
		if !kdsHas(c.kdsAreaNames(), area) {
			return bad("Pick an area")
		}
		tok, err := c.kdsSign("kds", jwt.MapClaims{"kind": "kds", "area": area, "loc": c.Slug(), "v": c.kdsVersion("kds_version")})
		if err != nil {
			return err
		}
		if err := c.Audit("kds.device", area+" screen started"); err != nil {
			return err
		}
		return c.JSON(M{"token": tok, "loc": c.Slug(), "area": area})
	})
	rt.staff("POST /kds/signout-all", "manager", func(c *C) error {
		if err := c.Tx.SetSettings(c.Ctx, map[string]string{"kds_version": kdsJS(kdsNum(c.kdsVersion("kds_version")) + 1)}); err != nil {
			return err
		}
		c.Refresh()
		if err := c.Audit("kds.device", "all signed out"); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("GET /kds/setup", "manager", func(c *C) error {
		s := c.S()
		list := c.kdsStationList()
		cats, err := c.All(`SELECT DISTINCT category FROM menu_items ORDER BY category NULLS FIRST`)
		if err != nil {
			return err
		}
		catList := []any{}
		for _, r := range cats {
			catList = append(catList, r["category"])
		}
		items, err := c.All(`SELECT id, name, category, station FROM menu_items WHERE active = 1 ORDER BY category NULLS FIRST, name`)
		if err != nil {
			return err
		}
		mp := c.kdsStationMap()
		for _, i := range items {
			i["area"] = kdsStationFor(i, list, mp)
		}
		sp, err := c.kdsSpeed()
		if err != nil {
			return err
		}
		return c.JSON(M{"stations": list, "map": kdsPJ(s["station_map"], M{}), "expo": s["kds_expo"] == "1", "pack": s["kds_pack"] == "1", "allergyCheck": s["kds_allergy_check"] == "1", "pacing": s["kds_pacing"] == "1",
			"categories": catList, "items": items, "speed": sp})
	})
	rt.staff("PUT /kds/item-station", "manager", func(c *C) error {
		b, err := c.Body(valid.Ordered("itemId", valid.Int(), "station", valid.String().Max(20).Nullable()))
		if err != nil {
			return err
		}
		if truthy(b["station"]) && !kdsHas(c.kdsStationList(), str(b["station"])) {
			return bad("Unknown area")
		}
		if _, err := c.Run(`UPDATE menu_items SET station = ? WHERE id = ?`, orNil(b["station"]), b["itemId"]); err != nil {
			return err
		}
		c.Notify("menu")
		return c.OK()
	})

	/* ===== the screen itself ===== */
	rt.pub("GET /api/kds", func(c *C) error {
		w, err := c.kdsWho(true)
		if err != nil {
			return err
		}
		s := c.S()
		all, err := c.kdsBoard()
		if err != nil {
			return err
		}
		kind := "station"
		switch w.area {
		case kdsExpo:
			kind = "expo"
		case kdsPack:
			kind = "pack"
		case "Runner":
			kind = "runner"
		case kdsAll:
			kind = "all"
		}
		orders := []M{}
		switch kind {
		case "station":
			for _, o := range all {
				if !o["cooking"].(bool) {
					continue
				}
				has := false
				mine := []M{}
				for _, i := range o["items"].([]M) {
					if i["area"] == w.area {
						mine = append(mine, i)
						if !i["held"].(bool) && !i["done"].(bool) {
							has = true
						}
					}
				}
				if has {
					oo := M{}
					for k, v := range o {
						oo[k] = v
					}
					oo["mine"] = mine
					orders = append(orders, oo)
				}
			}
		case "pack":
			for _, o := range all {
				f, src := str(o["fulfillment"]), str(o["source"])
				if (f == "pickup" || f == "delivery" || src == "online" || src == "kiosk") && !truthy(o["packed_at"]) && (o["cooking"].(bool) || kdsStatusIn(o, "ready", "paid")) {
					orders = append(orders, o)
				}
			}
		case "runner":
			if c.Has("runnerOrders") {
				r, err := c.G("runnerOrders", all)
				if err != nil {
					return err
				}
				switch x := r.(type) {
				case []M:
					orders = x
				case []any:
					for _, v := range x {
						if m, ok := v.(M); ok {
							orders = append(orders, m)
						}
					}
				}
			}
		default:
			for _, o := range all {
				if o["cooking"].(bool) {
					orders = append(orders, o)
				}
			}
		}
		// recently finished tickets
		var rec []M
		firstDone := func(o M) string {
			for _, i := range o["items"].([]M) {
				if i["area"] == w.area {
					return kdsJS(i["doneAt"])
				}
			}
			return "undefined"
		}
		var key func(o M) string
		switch kind {
		case "station":
			for _, o := range all {
				for _, i := range o["items"].([]M) {
					if i["area"] == w.area && i["done"].(bool) && !i["held"].(bool) {
						rec = append(rec, o)
						break
					}
				}
			}
			key = firstDone
		case "runner":
			for _, o := range all {
				if truthy(o["served_at"]) {
					rec = append(rec, o)
				}
			}
			key = func(o M) string { return kdsJS(o["served_at"]) }
		case "pack":
			for _, o := range all {
				if truthy(o["packed_at"]) {
					rec = append(rec, o)
				}
			}
			key = func(o M) string { return kdsJS(o["packed_at"]) }
		default:
			for _, o := range all {
				if !o["cooking"].(bool) {
					rec = append(rec, o)
				}
			}
			key = func(o M) string { return kdsJS(o["ready_at"]) }
		}
		sort.SliceStable(rec, func(a, b int) bool { return key(rec[a]) > key(rec[b]) })
		if len(rec) > 8 {
			rec = rec[:8]
		}
		recent := []M{}
		for _, o := range rec {
			its := []M{}
			for _, i := range o["items"].([]M) {
				if !i["held"].(bool) && (kind != "station" || i["area"] == w.area) {
					its = append(its, M{"id": i["id"], "name": i["name"], "qty": i["qty"], "area": i["area"]})
				}
			}
			name := o["customer_name"]
			if !truthy(name) {
				name = o["guest_name"]
			}
			recent = append(recent, M{"id": o["id"], "number": o["number"], "table": o["table_label"], "name": name, "status": o["status"], "items": its})
		}
		// the area's opening/closing lists
		today := c.kdsLocalToday()
		tpls, err := c.All(`SELECT * FROM checklist_templates WHERE active = 1 AND area = ? ORDER BY sort, id`, w.area)
		if err != nil {
			return err
		}
		lists := []M{}
		for _, t := range tpls {
			run, err := c.One(`SELECT * FROM checklist_runs WHERE template_id = ? AND day = ?`, t["id"], today)
			if err != nil {
				return err
			}
			var dv any = "{}"
			if run != nil && truthy(run["done"]) {
				dv = run["done"]
			}
			done, _ := kdsPJ(dv, M{}).(map[string]any)
			its := []M{}
			count := 0
			tItems := kdsList(kdsPJ(t["items"], []any{}))
			for i, it := range tItems {
				im, _ := it.(map[string]any)
				d := done[strconv.Itoa(i)]
				if !truthy(d) {
					d = nil
				} else {
					count++
				}
				its = append(its, M{"text": im["text"], "needsValue": truthy(im["needsValue"]), "done": d})
			}
			lists = append(lists, M{"id": t["id"], "name": t["name"], "kind": t["kind"], "dueTime": t["due_time"], "items": its, "count": count, "total": len(tItems)})
		}
		evs, err := c.paceEventsToday()
		if err != nil {
			return err
		}
		events := []M{}
		for _, e := range evs {
			ee := M{}
			for k, v := range e {
				ee[k] = v
			}
			its := e["items"].([]M)
			if kind == "station" {
				f := []M{}
				for _, i := range its {
					if c.kdsStationOf(i) == w.area {
						f = append(f, i)
					}
				}
				its = f
			}
			ee["items"] = its
			if len(its) > 0 {
				events = append(events, ee)
			}
		}
		out, err := c.passKdsExtra(w.area)
		if err != nil {
			return err
		}
		if out["bumpKeys"], err = c.G("bumpKeys"); err != nil {
			return err
		}
		out["timeline"] = []any{}
		if kind == "expo" || kind == "all" || kind == "runner" {
			if c.Has("tableTimeline") {
				tl, err := c.G("tableTimeline")
				if err != nil {
					return err
				}
				if tl != nil {
					out["timeline"] = tl
				}
			}
		}
		out["enRoute"] = []M{}
		out["arrivals"] = []M{}
		if kind == "pack" || kind == "expo" || kind == "all" {
			if out["enRoute"], err = c.passEnRoute(); err != nil {
				return err
			}
			arr := []M{}
			for _, o := range all {
				if o["arrived"].(bool) {
					name := o["customer_name"]
					if !truthy(name) {
						name = o["guest_name"]
					}
					arr = append(arr, M{"id": o["id"], "number": o["number"], "name": name, "note": o["arrival_note"], "ready": !o["cooking"].(bool)})
				}
			}
			out["arrivals"] = arr
		}
		if out["rush"], err = c.lineRushState(); err != nil {
			return err
		}
		if out["quote"], err = c.lineQuoteMinutes(); err != nil {
			return err
		}
		held, err := c.N(`SELECT COUNT(*) c FROM orders WHERE status = 'held'`)
		if err != nil {
			return err
		}
		dayArea := ""
		if kind == "station" {
			dayArea = w.area
		}
		for k, v := range (M{"business": M{"name": s["business_name"], "accent": s["accent"]}, "area": w.area, "kind": kind, "device": w.device, "expo": s["kds_expo"] == "1",
			"pack": s["kds_pack"] == "1", "unit": s["unit_label"], "allergyCheck": s["kds_allergy_check"] == "1", "pacing": s["kds_pacing"] == "1", "lists": lists, "events": events,
			"stations": c.kdsStationList(), "areas": c.kdsAreaNames(), "lateMinutes": kdsOut(kdsSetNum(s["kds_late_minutes"], 12)), "orders": orders, "recent": recent,
			"allDay": kdsAllDay(all, dayArea), "held": held}) {
			out[k] = v
		}
		return c.JSON(out)
	})

	// An area finishes some or all of its items on a ticket.
	rt.pub("POST /api/kds/bump", func(c *C) error {
		w, err := c.kdsWho(true)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("orderId", valid.Int(), "itemIds", valid.Array(valid.Int()).Max(100).Optional(), "undo", valid.Bool().Optional(),
			"allergyConfirmed", valid.Bool().Optional(), "cookId", valid.Int().Optional()))
		if err != nil {
			return err
		}
		var cook any
		if cf, err := c.passCookFor(b); err != nil {
			return err
		} else if cf != nil {
			cook = cf
		} else if w.user != nil {
			cook = w.user.ID
		}
		o, err := c.kdsOrder(b["orderId"])
		if err != nil {
			return err
		}
		list := c.kdsStationList()
		mp := c.kdsStationMap()
		rows, err := c.All(`SELECT oi.*, m.category, m.station FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id = ? ORDER BY oi.id`, o["id"])
		if err != nil {
			return err
		}
		ids, hasIDs := b["itemIds"].([]any)
		inIDs := func(id any) bool {
			for _, x := range ids {
				if i64(x) == i64(id) {
					return true
				}
			}
			return false
		}
		undo := b["undo"] == true
		n := 0
		for _, i := range rows {
			if !kdsLive(i) || !(w.area == kdsAll || w.area == kdsExpo || kdsStationFor(i, list, mp) == w.area) || (hasIDs && !inIDs(i["id"])) {
				continue
			}
			n++
			if undo {
				_, err = c.Run(`UPDATE order_items SET done_at = NULL, done_station = NULL, done_by = NULL WHERE id = ?`, i["id"])
			} else {
				_, err = c.Run(`UPDATE order_items SET done_at = COALESCE(done_at, datetime('now')), done_station = COALESCE(done_station, ?), done_by = COALESCE(done_by, ?) WHERE id = ?`, kdsStationFor(i, list, mp), cook, i["id"])
			}
			if err != nil {
				return err
			}
		}
		if n == 0 {
			return bad("Nothing on this ticket for this area")
		}
		if undo && kdsStatusIn(o, "ready", "paid") && !truthy(o["paid_at"]) {
			if _, err := c.Run(`UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?`, o["id"]); err != nil {
				return err
			}
		}
		var ready M
		needs := false
		fin, err := c.kdsFinished(o["id"])
		if err != nil {
			return err
		}
		al, err := c.kdsAllergyOf(o)
		if err != nil {
			return err
		}
		if !undo && fin && kdsStatusIn(o, "open", "sent") && c.S()["kds_expo"] != "1" {
			if al != "" && c.S()["kds_allergy_check"] == "1" && b["allergyConfirmed"] != true {
				needs = true
			} else {
				if al != "" {
					if err := c.kdsCheckAllergy(o, w); err != nil {
						return err
					}
				}
				if ready, err = c.markReady(o, w.user, c.IP(), w.label()); err != nil {
					return err
				}
			}
		}
		action := "kds.bump"
		if undo {
			action = "kds.undo"
		}
		if err := c.AuditAs(w.user, action, fmt.Sprintf("#%s %s", kdsJS(o["number"]), w.area), c.IP()); err != nil {
			return err
		}
		c.Notify("orders")
		if fin, err = c.kdsFinished(o["id"]); err != nil {
			return err
		}
		var buzz any
		if ready != nil {
			buzz = orNil(ready["buzz"])
		}
		res := M{"ok": true, "needsAllergyCheck": needs, "allDone": fin, "ready": ready != nil, "buzz": buzz, "waitingForExpo": !undo && fin && c.S()["kds_expo"] == "1"}
		if needs {
			res["allergy"] = al
		}
		return c.JSON(res)
	})

	// Expo (or any full screen) completes the order: everything done, customer buzzed.
	rt.pub("POST /api/kds/complete", func(c *C) error {
		w, err := c.kdsWho(true)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("orderId", valid.Int(), "allergyConfirmed", valid.Bool().Optional()))
		if err != nil {
			return err
		}
		if w.area != kdsExpo && w.area != kdsAll && c.S()["kds_expo"] == "1" {
			return bad("Only the expo screen completes orders")
		}
		o, err := c.kdsOrder(b["orderId"])
		if err != nil {
			return err
		}
		if !kdsStatusIn(o, "open", "sent") {
			return conflict("This order is already done")
		}
		al, err := c.kdsAllergyOf(o)
		if err != nil {
			return err
		}
		if c.Has("photoNeeded") {
			oo := M{}
			for k, v := range o {
				oo[k] = v
			}
			oo["allergy"] = al
			need, err := kdsAsBool(c.G("photoNeeded", oo))
			if err != nil {
				return err
			}
			if need {
				has, err := kdsAsBool(c.G("hasPlatePhoto", o["id"]))
				if err != nil {
					return err
				}
				if !has {
					return failX(http.StatusConflict, "Take a photo of the plate first", M{"needsPhoto": true})
				}
			}
		}
		if al != "" && c.S()["kds_allergy_check"] == "1" {
			if b["allergyConfirmed"] != true {
				return failX(http.StatusConflict, "Check the allergy first: "+al, M{"needsAllergyCheck": true})
			}
			if err := c.kdsCheckAllergy(o, w); err != nil {
				return err
			}
		}
		if _, err := c.Run(`UPDATE order_items SET done_at = COALESCE(done_at, datetime('now')) WHERE order_id = ? AND (course <= 1 OR fired_at IS NOT NULL)`, o["id"]); err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE orders SET expo_at = datetime('now') WHERE id = ?`, o["id"]); err != nil {
			return err
		}
		r, err := c.markReady(o, w.user, c.IP(), w.label())
		if err != nil {
			return err
		}
		c.Notify("orders")
		return c.JSON(M{"ok": true, "buzz": orNil(r["buzz"])})
	})

	rt.pub("POST /api/kds/recall", func(c *C) error {
		w, err := c.kdsWho(true)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("orderId", valid.Int(), "reason", valid.Enum("missing", "wrong", "remake", "cold", "other").Optional()))
		if err != nil {
			return err
		}
		o, err := c.kdsOrder(b["orderId"])
		if err != nil {
			return err
		}
		if c.Has("recallReason") {
			if _, err := c.G("recallReason", o, b["reason"], w.area, w.label()); err != nil {
				return err
			}
		}
		if w.area != kdsExpo && w.area != kdsAll && w.area != kdsPack {
			list := c.kdsStationList()
			mp := c.kdsStationMap()
			rows, err := c.All(`SELECT oi.*, m.category, m.station FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id = ?`, o["id"])
			if err != nil {
				return err
			}
			for _, i := range rows {
				if kdsStationFor(i, list, mp) == w.area {
					if _, err := c.Run(`UPDATE order_items SET done_at = NULL, done_station = NULL WHERE id = ?`, i["id"]); err != nil {
						return err
					}
				}
			}
		}
		if w.area == kdsPack {
			if _, err := c.Run(`UPDATE orders SET packed_at = NULL WHERE id = ?`, o["id"]); err != nil {
				return err
			}
		} else if kdsStatusIn(o, "ready", "paid") && (str(o["status"]) == "ready" || !truthy(o["paid_at"]) || truthy(o["prepaid"])) {
			if _, err := c.Run(`UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?`, o["id"]); err != nil {
				return err
			}
		}
		if err := c.AuditAs(w.user, "kds.recall", fmt.Sprintf("#%s %s", kdsJS(o["number"]), w.area), c.IP()); err != nil {
			return err
		}
		c.Notify("orders")
		return c.OK()
	})

	// Packing: the bag is checked and sealed.
	rt.pub("POST /api/kds/packed", func(c *C) error {
		w, err := c.kdsWho(true)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("orderId", valid.Int(), "shelf", valid.String().Trim().Max(8).Optional()))
		if err != nil {
			return err
		}
		if w.area != kdsPack && w.area != kdsAll && w.area != kdsExpo {
			return bad("Use the packing screen")
		}
		o, err := c.kdsOrder(b["orderId"])
		if err != nil {
			return err
		}
		shelf := orNil(b["shelf"])
		if _, err := c.Run(`UPDATE orders SET packed_at = datetime('now'), shelf = COALESCE(?, shelf) WHERE id = ?`, shelf, o["id"]); err != nil {
			return err
		}
		if shelf != nil && truthy(o["guest_id"]) {
			if err := c.pushGuest(i64(o["guest_id"])); err != nil {
				return err
			}
		}
		if err := c.AuditAs(w.user, "kds.packed", "#"+kdsJS(o["number"]), c.IP()); err != nil {
			return err
		}
		c.Notify("orders")
		if c.Has("printSticker") {
			c.kdsSavepoint(func() error { _, e := c.G("printSticker", o["id"], w.label()); return e })
		}
		return c.OK()
	})

	// area opening/closing lists, ticked on the area screen
	rt.pub("POST /api/kds/list-check", func(c *C) error {
		w, err := c.kdsWho(true)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Ordered("templateId", valid.Int(), "index", valid.Int().Min(0).Max(100), "done", valid.Bool(),
			"value", valid.String().Trim().Max(40).Optional(), "by", valid.String().Trim().Max(30).Optional()))
		if err != nil {
			return err
		}
		t, err := c.One(`SELECT * FROM checklist_templates WHERE id = ? AND area = ?`, b["templateId"], w.area)
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("This list is not for this area")
		}
		items := kdsList(kdsPJ(t["items"], []any{}))
		idx := int(i64(b["index"]))
		if idx >= len(items) {
			return bad("Bad item")
		}
		day := c.kdsLocalToday()
		if _, err := c.Run(`INSERT OR IGNORE INTO checklist_runs (template_id, day) VALUES (?, ?)`, t["id"], day); err != nil {
			return err
		}
		run, err := c.Get(`SELECT * FROM checklist_runs WHERE template_id = ? AND day = ?`, t["id"], day)
		if err != nil {
			return err
		}
		done, _ := kdsPJ(run["done"], M{}).(map[string]any)
		if done == nil {
			done = map[string]any{}
		}
		by := ""
		if w.user != nil {
			by = kdsFirst(w.user.Name)
		} else if truthy(b["by"]) {
			by = str(b["by"])
		} else {
			by = w.area + " screen"
		}
		if b["done"] == true {
			done[strconv.Itoa(idx)] = M{"by": by, "at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "value": orNil(b["value"])}
		} else {
			delete(done, strconv.Itoa(idx))
		}
		complete := true
		for i := range items {
			if !truthy(done[strconv.Itoa(i)]) {
				complete = false
			}
		}
		var completedAt, completedBy any
		if complete {
			completedAt = orNil(run["completed_at"])
			if completedAt == nil {
				completedAt = kdsNowSQL()
			}
			if w.user != nil {
				completedBy = w.user.ID
			}
		}
		if _, err := c.Run(`UPDATE checklist_runs SET done = ?, completed_at = ?, completed_by = ? WHERE id = ?`, kdsIntKeyJSON(done), completedAt, completedBy, run["id"]); err != nil {
			return err
		}
		if complete && !truthy(run["completed_at"]) {
			if err := c.AuditAs(w.user, "checklist.done", fmt.Sprintf("%s %s (%s)", str(t["name"]), day, w.label()), c.IP()); err != nil {
				return err
			}
		}
		c.Notify("checklists")
		return c.JSON(M{"ok": true, "complete": complete})
	})

	// packing/expo: the curbside customer got their order
	rt.pub("POST /api/kds/handed", func(c *C) error {
		w, err := c.kdsWho(true)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"orderId": valid.Int()}))
		if err != nil {
			return err
		}
		o, err := c.kdsOrder(b["orderId"])
		if err != nil {
			return err
		}
		if err := c.paceHandOff(o, w.user); err != nil {
			return err
		}
		return c.OK()
	})

	/* ================= Menu board TV ================= */
	rt.staff("POST /menuboard/start", "manager", func(c *C) error {
		tok, err := c.kdsSign("board", jwt.MapClaims{"kind": "board", "loc": c.Slug(), "v": c.kdsVersion("board_version")})
		if err != nil {
			return err
		}
		if err := c.Audit("board.device", "started"); err != nil {
			return err
		}
		return c.JSON(M{"token": tok, "loc": c.Slug()})
	})
	rt.staff("POST /menuboard/signout-all", "manager", func(c *C) error {
		if err := c.Tx.SetSettings(c.Ctx, map[string]string{"board_version": kdsJS(kdsNum(c.kdsVersion("board_version")) + 1)}); err != nil {
			return err
		}
		c.Refresh()
		return c.OK()
	})
	rt.pub("GET /api/menuboard", func(c *C) error {
		p, ok := c.a.sess.VerifyDevice("board", c.R.Header.Get("X-Board"))
		ok = ok && kdsJS(p["loc"]) == c.Slug() && kdsJS(p["v"]) == c.kdsVersion("board_version")
		if !ok && c.kdsUser() == nil {
			return fail(http.StatusUnauthorized, "This menu board is signed out. A manager needs to set it up again.")
		}
		d, err := c.kdsBoardData()
		if err != nil {
			return err
		}
		return c.JSON(d)
	})
}

// kdsIntKeyJSON is JSON.stringify of an object whose keys are array indexes (JS puts them in number order).
func kdsIntKeyJSON(m map[string]any) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(a, b int) bool {
		x, e1 := strconv.Atoi(keys[a])
		y, e2 := strconv.Atoi(keys[b])
		if e1 == nil && e2 == nil {
			return x < y
		}
		return keys[a] < keys[b]
	})
	var sb strings.Builder
	sb.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			sb.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		vb, _ := json.Marshal(m[k])
		sb.Write(kb)
		sb.WriteByte(':')
		sb.Write(vb)
	}
	sb.WriteByte('}')
	return sb.String()
}

func (c *C) kdsBoardData() (M, error) {
	s := c.S()
	cats := []string{}
	for _, x := range kdsList(kdsPJ(s["board_categories"], []any{})) {
		cats = append(cats, kdsJS(x))
	}
	menu, err := c.menuWithMods("")
	if err != nil {
		return nil, err
	}
	items := []M{}
	for _, i := range menu {
		if truthy(i["special_only"]) && !truthy(i["special"]) {
			continue
		}
		if len(cats) > 0 && !kdsHas(cats, kdsJS(i["category"])) {
			continue
		}
		items = append(items, i)
	}
	order := cats
	if len(cats) == 0 {
		for _, i := range items {
			if !kdsHas(order, kdsJS(i["category"])) {
				order = append(order, kdsJS(i["category"]))
			}
		}
	}
	sections := []M{}
	for _, cat := range order {
		its := []M{}
		for _, i := range items {
			if kdsJS(i["category"]) != cat {
				continue
			}
			reg := i["regularCents"]
			if reg == nil {
				reg = i["price_cents"]
			}
			desc := i["description"]
			if !truthy(desc) {
				desc = ""
			}
			its = append(its, M{"id": i["id"], "name": i["name"], "description": desc, "priceCents": i["price_cents"], "regularCents": reg, "deal": orNil(i["deal"]),
				"special": truthy(i["special"]), "soldOut": i["soldOut"], "calories": i["calories"], "photo": orNil(i["photo"]), "diet": i["diet"]})
		}
		if len(its) > 0 {
			sections = append(sections, M{"name": cat, "items": its})
		}
	}
	var logo any
	if s["logo_version"] != "0" {
		logo = "/api/public/logo?l=" + c.Slug() + "&v=" + s["logo_version"]
	}
	return M{"business": M{"name": s["business_name"], "accent": s["accent"], "logo": logo}, "currency": s["currency"],
		"title": s["board_title"], "rotateSeconds": math.Max(5, kdsNumOr(s["board_rotate_seconds"], 12)), "columns": math.Min(4, math.Max(1, kdsNumOr(s["board_cols"], 3))),
		"showPhotos": s["board_photos"] == "1", "sections": sections}, nil
}
