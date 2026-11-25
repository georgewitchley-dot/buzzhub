package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of desk.js (round 12): allergen chart, seating rotation, delivery credits, sales tax report,
// stock transfers between locations, staff certificates, cash flow forecast, delivery zones,
// catering follow-up.

func init() { modules = append(modules, (*App).registerDesk) }

var deskCertKinds = []string{"Food handler", "Food protection manager", "Alcohol server", "Allergen awareness", "First aid / CPR", "Other"}

var deskDateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

/* ---------- time helpers shared by desk/house/care ---------- */

// deskTZOffMin is the zone's UTC offset in minutes at the given instant.
func deskTZOffMin(tz string, at time.Time) int {
	_, off := at.In(loadTZ(tz)).Zone()
	return off / 60
}

// deskDayBounds is ops.js dayBounds: UTC 'YYYY-MM-DD HH:MM:SS' bounds of a local business day.
func deskDayBounds(date, tz string) (string, string) {
	d, err := time.Parse("2006-01-02", date)
	if err != nil {
		d = time.Unix(0, 0).UTC()
	}
	off := deskTZOffMin(tz, d.Add(12*time.Hour))
	start := d.Add(-time.Duration(off) * time.Minute)
	end := start.Add(24 * time.Hour)
	f := "2006-01-02 15:04:05"
	return start.Format(f), end.Format(f)
}

func (c *C) deskTZ() string      { return c.S()["timezone"] }
func (c *C) deskToday() string   { return localNow(c.deskTZ()).Date }
func (c *C) deskHM() string      { return time.Now().In(loadTZ(c.deskTZ())).Format("15:04") }
func deskDowOf(d string) int     { return dow(d) }
func deskFmt(cents int64) string { return "$" + dollars(cents) }

func deskDaysBetween(a, b string) int {
	ta, _ := time.Parse("2006-01-02", a)
	tb, _ := time.Parse("2006-01-02", b)
	return int(math.Floor(tb.Sub(ta).Hours()/24 + 0.5))
}

// deskNum is JavaScript's Number(x) for strings (NaN when it is not a number).
func deskNum(v any) float64 {
	switch x := v.(type) {
	case nil:
		return 0
	case int64:
		return float64(x)
	case float64:
		return x
	case bool:
		if x {
			return 1
		}
		return 0
	}
	s := strings.TrimSpace(str(v))
	if s == "" {
		return 0
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || strings.ContainsAny(s, "xXpP_") {
		return math.NaN()
	}
	return f
}

// deskOr is `Number(x) || def`.
func deskOr(v any, def float64) float64 {
	f := deskNum(v)
	if f == 0 || math.IsNaN(f) {
		return def
	}
	return f
}

// deskLocaleCmp approximates String.prototype.localeCompare for plain names.
func deskLocaleCmp(a, b string) int {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	if la != lb {
		if la < lb {
			return -1
		}
		return 1
	}
	if a == b {
		return 0
	}
	if a > b { // lowercase sorts before uppercase
		return -1
	}
	return 1
}

func deskJList(v any) []any {
	if l, ok := jparse(v, []any{}).([]any); ok {
		return l
	}
	return []any{}
}

func deskJObj(v any) map[string]any {
	if m, ok := jparse(v, map[string]any{}).(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func deskJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func round1(f float64) float64 { return float64(roundJS(f*10)) / 10 }
func round2(f float64) float64 { return float64(roundJS(f*100)) / 100 }

// deskFeeRate reads fee_rates[key][0] (JSON settings) with a default.
func deskFeeRate(s map[string]string, key string, def float64) float64 {
	rates := deskJObj(s["fee_rates"])
	if l, ok := rates[key].([]any); ok && len(l) > 0 && l[0] != nil {
		if f, ok := l[0].(float64); ok {
			return f
		}
		return deskNum(l[0])
	}
	return def
}

/* ---------- seating rotation ---------- */

func (c *C) deskRotation() (M, error) {
	start, _ := deskDayBounds(c.deskToday(), c.deskTZ())
	servers, err := c.All(`SELECT u.id, u.name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_out IS NULL AND s.break_started IS NULL AND u.active = 1 GROUP BY u.id, u.name ORDER BY MIN(s.id)`)
	if err != nil {
		return nil, err
	}
	sections, err := c.All(`SELECT id, label, seats, status, server_id FROM tables ORDER BY id`)
	if err != nil {
		return nil, err
	}
	seats, err := c.All(`SELECT t.server_id sid, COUNT(*) n, COALESCE(SUM(g.party_size),0) covers, MAX(g.seated_at) last FROM guests g JOIN tables t ON t.id = g.table_id WHERE g.seated_at >= ? AND t.server_id IS NOT NULL GROUP BY t.server_id`, start)
	if err != nil {
		return nil, err
	}
	by := map[int64]store.Row{}
	for _, r := range seats {
		by[i64(r["sid"])] = r
	}
	list := []M{}
	for _, u := range servers {
		uid := i64(u["id"])
		n, open, seated := 0, []any{}, 0
		for _, t := range sections {
			if t["server_id"] == nil || i64(t["server_id"]) != uid {
				continue
			}
			n++
			if str(t["status"]) == "open" {
				open = append(open, t["label"])
			}
			if str(t["status"]) == "seated" {
				seated++
			}
		}
		if n == 0 {
			continue
		}
		var parties, covers int64
		var last any
		if r := by[uid]; r != nil {
			parties, covers, last = i64(r["n"]), i64(r["covers"]), orNil(r["last"])
		}
		list = append(list, M{"userId": uid, "name": u["name"], "tables": n, "open": open, "seated": seated, "partiesToday": parties, "coversToday": covers, "lastSeated": last})
	}
	ranked := []M{}
	for _, x := range list {
		if len(x["open"].([]any)) > 0 {
			ranked = append(ranked, x)
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		a, b := ranked[i], ranked[j]
		if a["seated"].(int) != b["seated"].(int) {
			return a["seated"].(int) < b["seated"].(int)
		}
		if la, lb := str(a["lastSeated"]), str(b["lastSeated"]); la != lb {
			return deskLocaleCmp(la, lb) < 0
		}
		return a["coversToday"].(int64) < b["coversToday"].(int64)
	})
	var next any
	order := []any{}
	for _, x := range ranked {
		order = append(order, x["userId"])
	}
	if len(ranked) > 0 {
		next = ranked[0]
	}
	unassigned := []any{}
	for _, t := range sections {
		if !truthy(t["server_id"]) && str(t["status"]) == "open" {
			unassigned = append(unassigned, t["label"])
		}
	}
	return M{"servers": list, "nextUp": next, "order": order, "unassignedOpen": unassigned}, nil
}

/* ---------- sales tax ---------- */

var deskTaxKeys = []string{"orders", "grossCents", "discountCents", "netCents", "taxableCents", "exemptCents", "taxCents", "tipsCents", "feesCents", "refundsCents"}

func (c *C) deskSalesTax(from, to string) (M, error) {
	a, _ := deskDayBounds(from, c.deskTZ())
	_, z2 := deskDayBounds(to, c.deskTZ())
	fd, _ := time.Parse("2006-01-02", from)
	off := deskTZOffMin(c.deskTZ(), fd.Add(12*time.Hour))
	mexpr := fmt.Sprintf(`substr(datetime(paid_at, '%d minutes'),1,7)`, off)
	rows, err := c.All(`SELECT `+mexpr+` AS month, COUNT(*) n, COALESCE(SUM(subtotal_cents),0) gross, COALESCE(SUM(discount_cents),0) disc,
    COALESCE(SUM(CASE WHEN tax_cents > 0 THEN subtotal_cents - discount_cents ELSE 0 END),0) taxable, COALESCE(SUM(CASE WHEN tax_cents = 0 THEN subtotal_cents - discount_cents ELSE 0 END),0) exempt,
    COALESCE(SUM(tax_cents),0) tax, COALESCE(SUM(tip_cents),0) tips, COALESCE(SUM(fee_cents),0) fees
    FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void' GROUP BY `+mexpr+` ORDER BY 1`, a, z2)
	if err != nil {
		return nil, err
	}
	// The Node queries for refunds and invoice payments read a created_at column those tables
	// don't have, so they always fail and count 0 there; this keeps the same answer.
	months := []M{}
	totals := M{}
	for _, k := range deskTaxKeys {
		totals[k] = int64(0)
	}
	for _, r := range rows {
		m := M{"month": r["month"], "orders": i64(r["n"]), "grossCents": i64(r["gross"]), "discountCents": i64(r["disc"]), "netCents": i64(r["gross"]) - i64(r["disc"]),
			"taxableCents": i64(r["taxable"]), "exemptCents": i64(r["exempt"]), "taxCents": i64(r["tax"]), "tipsCents": i64(r["tips"]), "feesCents": i64(r["fees"]), "refundsCents": int64(0)}
		months = append(months, m)
		for _, k := range deskTaxKeys {
			totals[k] = totals[k].(int64) + m[k].(int64)
		}
	}
	return M{"from": from, "to": to, "rate": deskNum(c.S()["tax_rate"]), "months": months, "totals": totals, "invoicePaymentsCents": int64(0)}, nil
}

/* ---------- cash flow ---------- */

func (c *C) deskCashFlow(days int) (M, error) {
	s := c.S()
	today := c.deskToday()
	tz := c.deskTZ()
	start := int64(deskNum(orNil(s["cash_balance_cents"])))
	asOf := orNil(s["cash_balance_on"])
	hist, seen := map[int]int64{}, map[int]int64{}
	off := deskTZOffMin(tz, time.Now())
	dexpr := fmt.Sprintf(`substr(datetime(paid_at, '%d minutes'),1,10)`, off)
	st56, _ := deskDayBounds(addDays(today, -56), tz)
	rows, err := c.All(`SELECT `+dexpr+` AS d, SUM(total_cents - tip_cents) c FROM orders WHERE paid_at >= ? AND status <> 'void' GROUP BY `+dexpr, st56)
	if err != nil {
		return nil, err
	}
	for _, r := range rows {
		d := str(r["d"])
		if d >= today {
			continue
		}
		w := deskDowOf(d)
		hist[w] += i64(r["c"])
		seen[w]++
	}
	feePct := deskFeeRate(s, "card", 2.6) / 100
	st28, _ := deskDayBounds(addDays(today, -28), tz)
	labor, err := c.Val(`SELECT COALESCE(SUM((julianday(COALESCE(s.clock_out, datetime('now'))) - julianday(s.clock_in)) * 24 * u.hourly_cents - s.break_minutes / 60.0 * u.hourly_cents),0) c FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in >= ?`, st28)
	if err != nil {
		return nil, err
	}
	laborPerDay := roundJS(f64(labor) / 28)
	sched, err := c.All(`SELECT substr(s.start_local,1,10) d, SUM((julianday(replace(s.end_local,' ','T')) - julianday(replace(s.start_local,' ','T'))) * 24 * u.hourly_cents) c FROM schedule s JOIN users u ON u.id = s.user_id WHERE substr(s.start_local,1,10) BETWEEN ? AND ? GROUP BY substr(s.start_local,1,10)`, today, addDays(today, days))
	if err != nil {
		return nil, err
	}
	schedBy := map[string]int64{}
	for _, r := range sched {
		if r["c"] != nil {
			schedBy[str(r["d"])] = roundJS(f64(r["c"]))
		}
	}
	billRows, err := c.All(`SELECT b.id, b.due_date, b.amount_cents - COALESCE((SELECT SUM(amount_cents) FROM bill_payments p WHERE p.bill_id = b.id),0) owed, s.name FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.status = 'open' ORDER BY b.id`)
	if err != nil {
		return nil, err
	}
	bills := []store.Row{}
	var billsCents int64
	for _, b := range billRows {
		if i64(b["owed"]) > 0 {
			bills = append(bills, b)
			billsCents += i64(b["owed"])
		}
	}
	fixed := []any{}
	for _, f := range deskJList(s["fixed_costs"]) {
		m, ok := f.(map[string]any)
		if ok && truthy(m["name"]) && deskNum(m["cents"]) > 0 {
			fixed = append(fixed, m)
		}
	}
	payDow := 5.0
	if v, ok := s["payroll_dow"]; ok {
		payDow = deskNum(v)
	}
	payEvery := 7
	if s["payroll_every"] == "biweekly" {
		payEvery = 14
	}
	bal := start
	low := M{"cents": start, "date": today}
	lowC := start
	out := []M{}
	var laborAcc int64
	for i := 0; i <= days; i++ {
		d := addDays(today, i)
		w := deskDowOf(d)
		var salesIn int64
		if seen[w] > 0 {
			salesIn = roundJS(float64(hist[w]) / float64(seen[w]) * (1 - feePct))
		}
		if v, ok := schedBy[d]; ok {
			laborAcc += v
		} else {
			laborAcc += laborPerDay
		}
		items := []M{}
		if salesIn != 0 {
			items = append(items, M{"label": "Expected sales (after card fees)", "cents": salesIn})
		}
		for _, b := range bills {
			due := str(b["due_date"])
			late := ""
			if due < today {
				due, late = today, " (late)"
			}
			if due == d {
				items = append(items, M{"label": str(b["name"]) + " bill" + late, "cents": -i64(b["owed"])})
			}
		}
		for _, f := range fixed {
			m := f.(map[string]any)
			day := deskOr(m["day"], 1)
			day = math.Min(28, math.Max(1, day))
			dn, _ := strconv.Atoi(d[8:])
			if float64(dn) == day {
				items = append(items, M{"label": m["name"], "cents": -int64(deskNum(m["cents"]))})
			}
		}
		if float64(w) == payDow && deskDaysBetween("2026-01-02", d)%payEvery < 7 {
			items = append(items, M{"label": "Payroll (estimated)", "cents": -laborAcc})
			laborAcc = 0
		}
		var net int64
		for _, x := range items {
			net += x["cents"].(int64)
		}
		bal += net
		if bal < lowC {
			lowC = bal
			low = M{"cents": bal, "date": d}
		}
		out = append(out, M{"date": d, "items": items, "netCents": net, "balanceCents": bal})
	}
	return M{"startCents": start, "asOf": asOf, "days": out, "low": low, "billsCents": billsCents, "laborPerDayCents": laborPerDay, "fixed": fixed}, nil
}

/* ---------- delivery zones ---------- */

type deskPt struct{ Lat, Lng float64 }

func deskInside(pt deskPt, poly []any) bool {
	in := false
	n := len(poly)
	get := func(i int) (float64, float64) {
		p, _ := poly[i].([]any)
		if len(p) < 2 {
			return math.NaN(), math.NaN()
		}
		return valid.ToFloat(p[0]), valid.ToFloat(p[1])
	}
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		yi, xi := get(i)
		yj, xj := get(j)
		if (yi > pt.Lat) != (yj > pt.Lat) && pt.Lng < (xj-xi)*(pt.Lat-yi)/(yj-yi)+xi {
			in = !in
		}
	}
	return in
}

var deskGeoCache sync.Map // address -> *deskPt (nil = not found)
var deskGeoClient = &http.Client{Timeout: 6 * time.Second}

func deskGeocode(address string) *deskPt {
	if v, ok := deskGeoCache.Load(address); ok {
		return v.(*deskPt)
	}
	req, _ := http.NewRequest("GET", "https://nominatim.openstreetmap.org/search?format=json&limit=1&q="+url.QueryEscape(address), nil)
	req.Header.Set("User-Agent", "BuzzHub/1.0 (delivery zones)")
	req.Header.Set("Accept-Language", "en")
	resp, err := deskGeoClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var j []map[string]any
	if json.NewDecoder(resp.Body).Decode(&j) != nil {
		return nil
	}
	var hit *deskPt
	if len(j) > 0 {
		hit = &deskPt{deskNum(j[0]["lat"]), deskNum(j[0]["lon"])}
	}
	deskGeoCache.Store(address, hit)
	return hit
}

// deskZoneFor is zoneFor(address): nil when no zones are drawn.
func (c *C) deskZoneFor(address string) (M, error) {
	zones, err := c.All(`SELECT * FROM delivery_zones WHERE active = 1 ORDER BY sort, id`)
	if err != nil || len(zones) == 0 {
		return nil, err
	}
	pt := deskGeocode(address)
	if pt == nil {
		return M{"unknown": true, "error": nil}, nil
	}
	for _, z := range zones {
		if deskInside(*pt, deskJList(z["points"])) {
			return M{"zone": z["name"], "feeCents": z["fee_cents"], "minCents": z["min_cents"], "point": M{"lat": pt.Lat, "lng": pt.Lng}}, nil
		}
	}
	return M{"outside": true, "error": "Sorry, that address is outside our delivery area. Pickup is available."}, nil
}

func deskTypeName(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64, int64:
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

// deskPointsErrors checks z.array(z.tuple([lat, lng])).min(3).max(200) with zod's messages.
func deskPointsErrors(v any, present bool) []string {
	var errs []string
	add := func(p, m string) { errs = append(errs, p+": "+m) }
	if !present {
		add("points", "Invalid input: expected array, received undefined")
		return errs
	}
	arr, ok := v.([]any)
	if !ok {
		add("points", "Invalid input: expected array, received "+deskTypeName(v))
		if s, ok := v.(string); ok {
			if n := utf16Count(s); n < 3 {
				add("points", "Too small: expected string to have >=3 characters")
			} else if n > 200 {
				add("points", "Too big: expected string to have <=200 characters")
			}
		}
		return errs
	}
	if len(arr) < 3 {
		add("points", "Too small: expected array to have >=3 items")
	}
	if len(arr) > 200 {
		add("points", "Too big: expected array to have <=200 items")
		return errs
	}
	lim := [2]float64{90, 180}
	for i, el := range arr {
		p := "points." + strconv.Itoa(i)
		t, ok := el.([]any)
		if !ok {
			add(p, "Invalid input: expected tuple, received "+deskTypeName(el))
			continue
		}
		if len(t) < 2 {
			add(p, "Too small: expected array to have >=2 items")
			continue
		}
		if len(t) > 2 {
			add(p, "Too big: expected array to have <=2 items")
			continue
		}
		for k, x := range t {
			pk := p + "." + strconv.Itoa(k)
			f, ok := x.(float64)
			if !ok {
				add(pk, "Invalid input: expected number, received "+deskTypeName(x))
				continue
			}
			if f < -lim[k] {
				add(pk, "Too small: expected number to be >="+fmtJSNum(-lim[k]))
			}
			if f > lim[k] {
				add(pk, "Too big: expected number to be <="+fmtJSNum(lim[k]))
			}
		}
	}
	return errs
}

func utf16Count(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

var deskZoneSchema = valid.Ordered(
	"name", valid.String().Trim().Min(1).Max(40),
	"feeCents", valid.Int().Min(0).Max(100000),
	"minCents", valid.Int().Min(0).Max(1_000_000),
	"color", valid.String().Regex(`^#[0-9a-fA-F]{6}$`).Optional(),
	"active", valid.Bool().Optional(),
)

// deskZoneBody validates a zone with the points tuple list, keeping zod's error order.
func (c *C) deskZoneBody() (valid.M, []any, error) {
	raw, _ := c.Raw().(map[string]any)
	if raw == nil {
		raw = map[string]any{}
	}
	pv, has := raw["points"]
	perrs := deskPointsErrors(pv, has)
	b, err := valid.Obj(deskZoneSchema, raw)
	var errs []string
	if err != nil {
		errs = strings.Split(err.Error(), "; ")
	}
	if len(perrs) > 0 || err != nil {
		var out []string
		for _, e := range errs {
			if strings.HasPrefix(e, "name:") {
				out = append(out, e)
			}
		}
		out = append(out, perrs...)
		for _, e := range errs {
			if !strings.HasPrefix(e, "name:") {
				out = append(out, e)
			}
		}
		return nil, nil, bad(strings.Join(out, "; "))
	}
	return b, pv.([]any), nil
}

/* ---------- other locations ---------- */

type deskLoc struct{ Slug, Name, Type string }

func (c *C) deskListLocations() ([]deskLoc, error) {
	out := []deskLoc{}
	for _, slug := range c.a.allSlugs(c.Ctx) {
		if err := c.a.db.Migrate(c.Ctx, slug); err != nil {
			return nil, err
		}
		sch := `"` + store.SchemaFor(slug) + `"`
		rows, err := c.All(`SELECT key, value FROM ` + sch + `.settings WHERE key IN ('business_name','business_type')`)
		if err != nil {
			return nil, err
		}
		l := deskLoc{Slug: slug, Name: store.Defaults["business_name"], Type: store.Defaults["business_type"]}
		for _, r := range rows {
			if str(r["key"]) == "business_name" {
				l.Name = str(r["value"])
			} else {
				l.Type = str(r["value"])
			}
		}
		out = append(out, l)
	}
	return out, nil
}

// deskRunIn runs fn with the transaction pointed at another location's schema.
func (c *C) deskRunIn(slug string, fn func() error) error {
	if err := c.a.db.Migrate(c.Ctx, slug); err != nil {
		return err
	}
	if _, err := c.Tx.Exec(c.Ctx, `SELECT set_config('search_path', $1, true)`, store.SchemaFor(slug)+", public"); err != nil {
		return err
	}
	ferr := fn()
	if _, err := c.Tx.Exec(c.Ctx, `SELECT set_config('search_path', $1, true)`, store.SchemaFor(c.Slug())+", public"); err != nil && ferr == nil {
		ferr = err
	}
	return ferr
}

/* ---------- certificates ---------- */

func (c *C) deskCertView(r store.Row) M {
	m := M{}
	for k, v := range r {
		m[k] = v
	}
	if truthy(r["expires"]) {
		m["daysLeft"] = deskDaysBetween(c.deskToday(), str(r["expires"]))
	} else {
		m["daysLeft"] = nil
	}
	if str(r["photo_version"]) != "0" {
		m["photo"] = fmt.Sprintf("/api/staff/certificates/%v/photo?v=%s", r["id"], str(r["photo_version"]))
	} else {
		m["photo"] = nil
	}
	return m
}

func (c *C) deskIsMgr() bool { return c.U.Role == "manager" || c.U.Role == "owner" }

var deskCertDataRE = regexp.MustCompile(`^data:(image/(png|jpeg|webp)|application/pdf);base64,([A-Za-z0-9+/=]+)$`)

func (c *C) deskInvByToken(t string) (store.Row, error) {
	if !tokenPathTok.MatchString(t) {
		return nil, nil
	}
	return c.One(`SELECT * FROM invoices WHERE token = ?`, t)
}

func (c *C) deskOnce(table, key string) (bool, error) {
	r, err := c.Run(`INSERT OR IGNORE INTO `+table+` (key) VALUES (?)`, key)
	return r.Changes > 0, err
}

func (a *App) registerDesk(rt *router) {
	/* ===== allergen chart ===== */
	chart := func(c *C) (M, error) {
		rows, err := c.All(`SELECT id, name, category, allergens, diet, price_cents FROM menu_items WHERE active = 1 ORDER BY category, sort, name`)
		if err != nil {
			return nil, err
		}
		items := []M{}
		used := []any{}
		seen := map[string]bool{}
		untagged := 0
		for _, m := range rows {
			al, di := deskJList(m["allergens"]), deskJList(m["diet"])
			items = append(items, M{"id": m["id"], "name": m["name"], "category": m["category"], "allergens": al, "diet": di, "priceCents": m["price_cents"]})
			for _, x := range al {
				if k := deskJSON(x); !seen[k] {
					seen[k] = true
					used = append(used, x)
				}
			}
			if len(al) == 0 && len(di) == 0 {
				untagged++
			}
		}
		return M{"business": c.S()["business_name"], "updated": c.deskToday(), "allergens": used, "items": items, "untagged": untagged}, nil
	}
	rt.staff("GET /allergen-chart", "staff", func(c *C) error {
		r, err := chart(c)
		if err != nil {
			return err
		}
		return c.JSON(r)
	})
	rt.pub("GET /api/public/allergens", func(c *C) error {
		r, err := chart(c)
		if err != nil {
			return err
		}
		for _, i := range r["items"].([]M) {
			delete(i, "priceCents")
		}
		return c.JSON(r)
	}, a.publicLim())

	/* ===== seating rotation ===== */
	rt.staff("GET /rotation", "staff", func(c *C) error {
		r, err := c.deskRotation()
		if err != nil {
			return err
		}
		return c.JSON(r)
	})

	/* ===== delivery credits ===== */
	creditView := func(c *C, r store.Row) (M, error) {
		m := M{}
		for k, v := range r {
			m[k] = v
		}
		name, err := c.Val(`SELECT name FROM suppliers WHERE id = ?`, r["supplier_id"])
		if err != nil {
			return nil, err
		}
		if !truthy(name) {
			name = "?"
		}
		m["supplier"] = name
		m["items"] = deskJList(r["items"])
		return m, nil
	}
	applyCredit := func(c *C, creditID, billID int64) (int64, error) {
		cr, err := c.One(`SELECT * FROM supplier_credits WHERE id = ? AND status = 'open'`, creditID)
		if err != nil {
			return 0, err
		}
		if cr == nil {
			return 0, conflict("This credit is already used")
		}
		bill, err := c.One(`SELECT * FROM supplier_bills WHERE id = ? AND status = 'open' AND supplier_id = ?`, billID, cr["supplier_id"])
		if err != nil {
			return 0, err
		}
		if bill == nil {
			return 0, conflict("Pick an open bill from the same supplier")
		}
		paid, err := c.N(`SELECT COALESCE(SUM(amount_cents),0) c FROM bill_payments WHERE bill_id = ?`, bill["id"])
		if err != nil {
			return 0, err
		}
		owed := i64(bill["amount_cents"]) - paid
		amt := i64(cr["amount_cents"])
		use := owed
		if amt < use {
			use = amt
		}
		var uid any
		if c.U != nil {
			uid = c.U.ID
		}
		if _, err := c.Run(`INSERT INTO bill_payments (bill_id, amount_cents, method, reference, paid_on, user_id) VALUES (?, ?, 'credit', ?, ?, ?)`, bill["id"], use, fmt.Sprintf("Credit #%v (%s)", cr["id"], str(cr["reason"])), c.deskToday(), uid); err != nil {
			return 0, err
		}
		if use >= owed {
			if _, err := c.Run(`UPDATE supplier_bills SET status = 'paid', paid_at = datetime('now') WHERE id = ?`, bill["id"]); err != nil {
				return 0, err
			}
		}
		if use < amt {
			if _, err := c.Run(`UPDATE supplier_credits SET amount_cents = amount_cents - ? WHERE id = ?`, use, cr["id"]); err != nil {
				return 0, err
			}
			if _, err := c.Run(`INSERT INTO supplier_credits (supplier_id, po_id, amount_cents, reason, items, status, bill_id, created_by, applied_at) VALUES (?,?,?,?,?,?,?,?, datetime('now'))`, cr["supplier_id"], cr["po_id"], use, cr["reason"], cr["items"], "applied", bill["id"], uid); err != nil {
				return 0, err
			}
		} else if _, err := c.Run(`UPDATE supplier_credits SET status = 'applied', bill_id = ?, applied_at = datetime('now') WHERE id = ?`, bill["id"], cr["id"]); err != nil {
			return 0, err
		}
		return use, nil
	}
	rt.staff("GET /supplier-credits", "owner", func(c *C) error {
		rows, err := c.All(`SELECT * FROM supplier_credits WHERE status <> 'void' ORDER BY CASE WHEN status = 'open' THEN 1 ELSE 0 END DESC, id DESC LIMIT 200`)
		if err != nil {
			return err
		}
		out := []M{}
		for _, r := range rows {
			m, err := creditView(c, r)
			if err != nil {
				return err
			}
			out = append(out, m)
		}
		return c.JSON(out)
	})
	rt.staff("POST /supplier-credits", "manager", func(c *C) error {
		b, err := c.Body(valid.Ordered(
			"supplierId", valid.Int(),
			"poId", valid.Int().Nullable().Optional(),
			"amountCents", valid.Int().Min(1).Max(10_000_000),
			"reason", valid.Enum("short", "damaged", "wrong item", "quality", "price error", "returned", "other"),
			"items", valid.Array(valid.Ordered("name", valid.String().Trim().Max(60), "qty", valid.Number().Min(0).Max(100000), "note", valid.String().Trim().Max(80).Optional())).Max(40).Default([]any{}),
			"adjustStock", valid.Bool().Default(false),
		))
		if err != nil {
			return err
		}
		if r, err := c.One(`SELECT 1 FROM suppliers WHERE id = ?`, b["supplierId"]); err != nil {
			return err
		} else if r == nil {
			return bad("Pick a supplier")
		}
		items := b["items"].([]any)
		reason := str(b["reason"])
		res, err := c.Run(`INSERT INTO supplier_credits (supplier_id, po_id, amount_cents, reason, items, created_by) VALUES (?,?,?,?,?,?)`, b["supplierId"], b["poId"], b["amountCents"], reason, deskJSON(items), c.U.ID)
		if err != nil {
			return err
		}
		if b["adjustStock"] == true {
			for _, x := range items {
				it := x.(valid.M)
				g, err := c.One(`SELECT id, stock FROM ingredients WHERE lower(name) = lower(?)`, it["name"])
				if err != nil {
					return err
				}
				if g != nil && g["stock"] != nil && f64(it["qty"]) > 0 {
					if _, err := c.Run(`UPDATE ingredients SET stock = stock - ? WHERE id = ?`, f64(it["qty"]), g["id"]); err != nil {
						return err
					}
					if _, err := c.Run(`INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?,?,?,?)`, g["id"], -f64(it["qty"]), "credit: "+reason, c.U.ID); err != nil {
						return err
					}
				}
			}
		}
		var applied any
		if truthy(b["poId"]) {
			bill, err := c.One(`SELECT id FROM supplier_bills WHERE po_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`, b["poId"])
			if err != nil {
				return err
			}
			if bill != nil {
				if _, err := applyCredit(c, res.LastID, i64(bill["id"])); err != nil {
					return err
				}
				applied = bill["id"]
			}
		}
		if err := c.Audit("credit.add", deskFmt(i64(b["amountCents"]))+" "+reason); err != nil {
			return err
		}
		c.Notify("bills")
		return c.JSON(M{"id": res.LastID, "appliedTo": applied})
	})
	rt.staff("POST /supplier-credits/{id}/apply", "owner", func(c *C) error {
		b, err := c.Body(valid.Object(map[string]valid.Schema{"billId": valid.Int()}))
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		used, err := applyCredit(c, id, i64(b["billId"]))
		if err != nil {
			return err
		}
		if err := c.Audit("credit.apply", fmt.Sprintf("#%s → bill %d %s", c.Param("id"), i64(b["billId"]), deskFmt(used))); err != nil {
			return err
		}
		c.Notify("bills")
		return c.JSON(M{"ok": true, "usedCents": used})
	})
	rt.staff("POST /supplier-credits/{id}/void", "owner", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE supplier_credits SET status = 'void' WHERE id = ? AND status = 'open'`, id); err != nil {
			return err
		}
		c.Notify("bills")
		return c.OK()
	})

	/* ===== sales tax ===== */
	rt.staff("GET /sales-tax", "owner", func(c *C) error {
		today := c.deskToday()
		curY, _ := strconv.Atoi(today[:4])
		curM, _ := strconv.Atoi(today[5:7])
		y := int(deskOr(c.Q("year"), float64(curY)))
		period := c.Q("period")
		switch period {
		case "month", "quarter", "year", "custom":
		default:
			period = "quarter"
		}
		var from, to string
		pad := func(n int) string { return fmt.Sprintf("%02d", n) }
		if period == "custom" && deskDateRE.MatchString(c.Q("from")) && deskDateRE.MatchString(c.Q("to")) {
			from, to = c.Q("from"), c.Q("to")
		} else if period == "year" {
			from, to = fmt.Sprintf("%d-01-01", y), fmt.Sprintf("%d-12-31", y)
		} else if period == "month" {
			m := int(math.Min(12, math.Max(1, deskOr(c.Q("n"), float64(curM)))))
			from = fmt.Sprintf("%d-%s-01", y, pad(m))
			nx := fmt.Sprintf("%d-%s-01", y, pad(m+1))
			if m == 12 {
				nx = fmt.Sprintf("%d-01-01", y+1)
			}
			to = addDays(nx, -1)
		} else {
			q := int(math.Min(4, math.Max(1, deskOr(c.Q("n"), math.Ceil(float64(curM)/3)))))
			from = fmt.Sprintf("%d-%s-01", y, pad(q*3-2))
			nx := fmt.Sprintf("%d-%s-01", y, pad(q*3+1))
			if q == 4 {
				nx = fmt.Sprintf("%d-01-01", y+1)
			}
			to = addDays(nx, -1)
		}
		upto := to
		if upto >= today {
			upto = today
		}
		r, err := c.deskSalesTax(from, upto)
		if err != nil {
			return err
		}
		if c.Q("format") == "csv" {
			m := func(v any) string { return dollars(v.(int64)) }
			lines := []string{"Month,Orders,Gross sales,Discounts,Net sales,Taxable sales,Non-taxable sales,Tax collected,Tips,Fees,Refunds"}
			row := func(label string, x M) string {
				return strings.Join([]string{label, itoa(x["orders"].(int64)), m(x["grossCents"]), m(x["discountCents"]), m(x["netCents"]), m(x["taxableCents"]), m(x["exemptCents"]), m(x["taxCents"]), m(x["tipsCents"]), m(x["feesCents"]), m(x["refundsCents"])}, ",")
			}
			for _, x := range r["months"].([]M) {
				lines = append(lines, row(str(x["month"]), x))
			}
			lines = append(lines, row("Total", r["totals"].(M)))
			c.W.Header().Set("Content-Type", "text/csv; charset=utf-8")
			c.W.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="sales-tax-%s-to-%s.csv"`, from, to))
			_, _ = c.W.Write([]byte(strings.Join(lines, "\n")))
			return nil
		}
		r["period"], r["year"], r["periodTo"] = period, y, to
		return c.JSON(r)
	})

	/* ===== stock transfers ===== */
	rt.staff("GET /transfers", "owner", func(c *C) error {
		locs, err := c.deskListLocations()
		if err != nil {
			return err
		}
		others := []M{}
		for _, l := range locs {
			if l.Slug != c.Slug() {
				others = append(others, M{"slug": l.Slug, "name": l.Name, "type": l.Type})
			}
		}
		hist, err := c.All(`SELECT * FROM stock_transfers ORDER BY id DESC LIMIT 50`)
		if err != nil {
			return err
		}
		for _, t := range hist {
			t["lines"] = deskJList(t["lines"])
		}
		ings, err := c.All(`SELECT id, name, unit, stock FROM ingredients WHERE active = 1 ORDER BY name COLLATE "C"`)
		if err != nil {
			return err
		}
		return c.JSON(M{"locations": others, "history": hist, "ingredients": ings})
	})
	rt.staff("POST /transfers", "owner", func(c *C) error {
		b, err := c.Body(valid.Ordered(
			"to", valid.String().Max(40),
			"lines", valid.Array(valid.Ordered("ingredientId", valid.Int(), "qty", valid.Number().Positive().Max(100000))).Min(1).Max(60),
			"note", valid.String().Trim().Max(200).Optional(),
		))
		if err != nil {
			return err
		}
		to, here := str(b["to"]), c.Slug()
		if to == here || !c.a.db.LocationExists(c.Ctx, to) {
			return bad("Pick another location")
		}
		locs, err := c.deskListLocations()
		if err != nil {
			return err
		}
		toName, fromName := to, here
		for _, l := range locs {
			if l.Slug == to {
				toName = l.Name
			}
			if l.Slug == here {
				fromName = l.Name
			}
		}
		type mv struct {
			g   store.Row
			qty float64
		}
		moved := []mv{}
		for _, x := range b["lines"].([]any) {
			l := x.(valid.M)
			g, err := c.One(`SELECT * FROM ingredients WHERE id = ?`, l["ingredientId"])
			if err != nil {
				return err
			}
			if g == nil {
				return bad("An ingredient was not found")
			}
			q := f64(l["qty"])
			if g["stock"] != nil && f64(g["stock"]) < q {
				return bad(fmt.Sprintf("Only %s %s of %s here", fmtJSNum(f64(g["stock"])), str(g["unit"]), str(g["name"])))
			}
			moved = append(moved, mv{g, q})
		}
		lines := []M{}
		for _, m := range moved {
			if m.g["stock"] != nil {
				if _, err := c.Run(`UPDATE ingredients SET stock = stock - ? WHERE id = ?`, m.qty, m.g["id"]); err != nil {
					return err
				}
			}
			if _, err := c.Run(`INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?,?,?,?)`, m.g["id"], -m.qty, "transfer to "+toName, c.U.ID); err != nil {
				return err
			}
			lines = append(lines, M{"name": m.g["name"], "unit": m.g["unit"], "qty": m.qty, "costCents": m.g["cost_cents"]})
		}
		note := orNil(b["note"])
		if _, err := c.Run(`INSERT INTO stock_transfers (direction, other_slug, other_name, lines, note, user_name) VALUES ('out',?,?,?,?,?)`, to, toName, deskJSON(lines), note, c.U.Name); err != nil {
			return err
		}
		if err := c.deskRunIn(to, func() error {
			for _, l := range lines {
				g, err := c.One(`SELECT * FROM ingredients WHERE lower(name) = lower(?)`, l["name"])
				if err != nil {
					return err
				}
				var gid any
				if g == nil {
					r, err := c.Run(`INSERT INTO ingredients (name, unit, cost_cents, stock) VALUES (?,?,?,0)`, l["name"], l["unit"], l["costCents"])
					if err != nil {
						return err
					}
					gid = r.LastID
				} else {
					gid = g["id"]
				}
				if _, err := c.Run(`UPDATE ingredients SET stock = COALESCE(stock, 0) + ? WHERE id = ?`, l["qty"], gid); err != nil {
					return err
				}
				if _, err := c.Run(`INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?,?,?,NULL)`, gid, l["qty"], "transfer from "+fromName); err != nil {
					return err
				}
			}
			if _, err := c.Run(`INSERT INTO stock_transfers (direction, other_slug, other_name, lines, note, user_name) VALUES ('in',?,?,?,?,?)`, here, fromName, deskJSON(lines), note, c.U.Name); err != nil {
				return err
			}
			return c.AuditAs(nil, "stock.transfer_in", fmt.Sprintf("%d items from %s", len(lines), fromName), "")
		}); err != nil {
			return err
		}
		if err := c.Audit("stock.transfer_out", fmt.Sprintf("%d items to %s", len(lines), toName)); err != nil {
			return err
		}
		c.Notify("menu")
		return c.OK()
	})

	/* ===== staff certificates ===== */
	rt.staff("GET /certificates", "staff", func(c *C) error {
		isMgr := c.deskIsMgr()
		q := `SELECT c.*, u.name, v.name verified_name FROM certificates c JOIN users u ON u.id = c.user_id LEFT JOIN users v ON v.id = c.verified_by WHERE u.active = 1 `
		args := []any{}
		if !isMgr {
			q += `AND c.user_id = ? `
			args = append(args, c.U.ID)
		}
		rows, err := c.All(q+`ORDER BY c.expires NULLS FIRST`, args...)
		if err != nil {
			return err
		}
		certs := []M{}
		for _, r := range rows {
			certs = append(certs, c.deskCertView(r))
		}
		required := deskJList(c.S()["required_certs"])
		missing, team := []M{}, []store.Row{}
		if isMgr {
			users, err := c.All(`SELECT id, name, role FROM users WHERE active = 1 AND role <> 'owner' ORDER BY id`)
			if err != nil {
				return err
			}
			for _, u := range users {
				for _, k := range required {
					has := false
					for _, ct := range certs {
						if i64(ct["user_id"]) == i64(u["id"]) && ct["kind"] == k && (ct["daysLeft"] == nil || ct["daysLeft"].(int) >= 0) {
							has = true
							break
						}
					}
					if !has {
						missing = append(missing, M{"userId": u["id"], "name": u["name"], "kind": k})
					}
				}
			}
			if team, err = c.All(`SELECT id, name FROM users WHERE active = 1 ORDER BY name COLLATE "C"`); err != nil {
				return err
			}
		}
		return c.JSON(M{"certificates": certs, "kinds": deskCertKinds, "required": required, "missing": missing, "team": team})
	})
	certSchema := valid.Ordered(
		"userId", valid.Int().Optional(),
		"kind", valid.String().Trim().Min(1).Max(40),
		"number", valid.String().Trim().Max(40).Optional(),
		"issued", valid.String().Regex(`^\d{4}-\d{2}-\d{2}$`).Optional().Or(valid.Literal("")),
		"expires", valid.String().Regex(`^\d{4}-\d{2}-\d{2}$`).Optional().Or(valid.Literal("")),
	)
	rt.staff("POST /certificates", "staff", func(c *C) error {
		b, err := c.Body(certSchema)
		if err != nil {
			return err
		}
		isMgr := c.deskIsMgr()
		uid := c.U.ID
		if isMgr && truthy(b["userId"]) {
			uid = i64(b["userId"])
		}
		var ver any
		if isMgr {
			ver = c.U.ID
		}
		res, err := c.Run(`INSERT INTO certificates (user_id, kind, number, issued, expires, verified_by) VALUES (?,?,?,?,?,?)`, uid, b["kind"], orNil(b["number"]), orNil(b["issued"]), orNil(b["expires"]), ver)
		if err != nil {
			return err
		}
		if err := c.Audit("cert.add", fmt.Sprintf("%s for user %d", str(b["kind"]), uid)); err != nil {
			return err
		}
		c.Notify("certs")
		return c.JSON(M{"id": res.LastID})
	})
	rt.staff("POST /certificates/{id}/verify", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE certificates SET verified_by = ? WHERE id = ?`, c.U.ID, id); err != nil {
			return err
		}
		c.Notify("certs")
		return c.OK()
	})
	ownCert := func(c *C) (store.Row, error) {
		id, err := c.ID()
		if err != nil {
			return nil, err
		}
		ct, err := c.One(`SELECT * FROM certificates WHERE id = ?`, id)
		if err != nil {
			return nil, err
		}
		if ct == nil {
			return nil, notFound("Not found")
		}
		if i64(ct["user_id"]) != c.U.ID && !c.deskIsMgr() {
			return nil, forbidden("Not allowed")
		}
		return ct, nil
	}
	rt.staff("DELETE /certificates/{id}", "staff", func(c *C) error {
		ct, err := ownCert(c)
		if err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM certificates WHERE id = ?`, ct["id"]); err != nil {
			return err
		}
		c.Notify("certs")
		return c.OK()
	})
	rt.staff("PUT /certificates/{id}/photo", "staff", func(c *C) error {
		ct, err := ownCert(c)
		if err != nil {
			return err
		}
		b, err := c.Body(valid.Object(map[string]valid.Schema{"dataUrl": valid.String().Max(1_400_000)}))
		if err != nil {
			return err
		}
		m := deskCertDataRE.FindStringSubmatch(str(b["dataUrl"]))
		if m == nil {
			return bad("Upload a photo or a PDF")
		}
		buf, err := base64.StdEncoding.DecodeString(m[3])
		if err != nil {
			buf, _ = base64.RawStdEncoding.DecodeString(strings.TrimRight(m[3], "="))
		}
		if len(buf) > 1_000_000 {
			return bad("Max 1 MB")
		}
		if _, err := c.Run(`INSERT INTO assets (key, mime, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET mime=excluded.mime, data=excluded.data, updated_at=datetime('now')`, fmt.Sprintf("cert:%v", ct["id"]), m[1], buf); err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE certificates SET photo_version = ? WHERE id = ?`, itoa(nowMs()), ct["id"]); err != nil {
			return err
		}
		c.Notify("certs")
		return c.OK()
	})
	rt.staff("GET /certificates/{id}/photo", "staff", func(c *C) error {
		id, _ := c.ID()
		ct, err := c.One(`SELECT * FROM certificates WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if ct == nil || (i64(ct["user_id"]) != c.U.ID && !c.deskIsMgr()) {
			c.W.WriteHeader(http.StatusNotFound)
			return nil
		}
		var mime string
		var data []byte
		if err := c.Tx.QueryRow(c.Ctx, `SELECT mime, data FROM assets WHERE key = $1`, fmt.Sprintf("cert:%v", ct["id"])).Scan(&mime, &data); err != nil {
			c.W.WriteHeader(http.StatusNotFound)
			return nil
		}
		c.W.Header().Set("Content-Type", mime)
		c.W.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = c.W.Write(data)
		return nil
	})

	/* ===== cash flow ===== */
	rt.staff("GET /cash-flow", "owner", func(c *C) error {
		days := int(math.Min(90, math.Max(7, deskOr(c.Q("days"), 30))))
		r, err := c.deskCashFlow(days)
		if err != nil {
			return err
		}
		return c.JSON(r)
	})

	/* ===== delivery zones ===== */
	rt.staff("GET /delivery-zones", "manager", func(c *C) error {
		rows, err := c.All(`SELECT * FROM delivery_zones ORDER BY sort, id`)
		if err != nil {
			return err
		}
		for _, z := range rows {
			z["points"] = deskJList(z["points"])
		}
		return c.JSON(M{"zones": rows, "center": nil, "address": c.S()["business_address"]})
	})
	rt.staff("POST /delivery-zones", "manager", func(c *C) error {
		b, pts, err := c.deskZoneBody()
		if err != nil {
			return err
		}
		if _, err := c.Run(`INSERT INTO delivery_zones (name, points, fee_cents, min_cents, color) VALUES (?,?,?,?,?)`, b["name"], deskJSON(pts), b["feeCents"], b["minCents"], orNil(b["color"])); err != nil {
			return err
		}
		if err := c.Audit("delivery.zone", str(b["name"])); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("PUT /delivery-zones/{id}", "manager", func(c *C) error {
		b, pts, err := c.deskZoneBody()
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		var act any
		if v, ok := b["active"].(bool); ok {
			act = v
		}
		if _, err := c.Run(`UPDATE delivery_zones SET name=?, points=?, fee_cents=?, min_cents=?, color=?, active=COALESCE(?, active) WHERE id=?`, b["name"], deskJSON(pts), b["feeCents"], b["minCents"], orNil(b["color"]), act, id); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("DELETE /delivery-zones/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM delivery_zones WHERE id = ?`, id); err != nil {
			return err
		}
		return c.OK()
	})
	addrSchema := valid.Object(map[string]valid.Schema{"address": valid.String().Trim().Min(5).Max(200)})
	rt.staff("POST /delivery-zones/geocode", "manager", func(c *C) error {
		b, err := c.Body(addrSchema)
		if err != nil {
			return err
		}
		p := deskGeocode(str(b["address"]))
		if p == nil {
			return bad("Could not find that address on the map")
		}
		return c.JSON(M{"lat": p.Lat, "lng": p.Lng})
	})
	a.G["deliveryZone"] = func(c *C, args ...any) (any, error) {
		z, err := c.deskZoneFor(str(args[0]))
		if z == nil {
			return nil, err
		}
		return z, err
	}
	rt.pub("POST /api/o/delivery-quote", func(c *C) error {
		b, err := c.Body(addrSchema)
		if err != nil {
			return err
		}
		zq, err := c.deskZoneFor(str(b["address"]))
		if err != nil {
			return err
		}
		s := c.S()
		if zq == nil {
			return c.JSON(M{"ok": true, "feeCents": deskNum(s["delivery_fee_cents"]), "minCents": deskNum(s["delivery_min_cents"])})
		}
		if zq["outside"] == true {
			return c.JSON(M{"ok": false, "error": zq["error"]})
		}
		if zq["unknown"] == true {
			return c.JSON(M{"ok": true, "feeCents": deskNum(s["delivery_fee_cents"]), "minCents": deskNum(s["delivery_min_cents"]), "note": "We couldn't find that address on the map. We'll confirm the fee."})
		}
		return c.JSON(M{"ok": true, "zone": zq["zone"], "feeCents": zq["feeCents"], "minCents": zq["minCents"]})
	}, a.publicLim())

	/* ===== catering follow-up ===== */
	rt.pub("GET /api/i/{token}/feedback", func(c *C) error {
		inv, err := c.deskInvByToken(c.Param("token"))
		if err != nil {
			return err
		}
		if inv == nil {
			return notFound("Not found")
		}
		f, err := c.One(`SELECT * FROM catering_feedback WHERE invoice_id = ?`, inv["id"])
		if err != nil {
			return err
		}
		s := c.S()
		l := ""
		if c.Slug() != "main" {
			l = "?l=" + c.Slug()
		}
		return c.JSON(M{"title": inv["title"], "name": inv["customer_name"], "business": M{"name": s["business_name"], "accent": s["accent"], "review": s["review_url"]},
			"rated": f != nil && truthy(f["rating"]), "rebook": c.PublicBase() + "/catering-order" + l})
	}, a.publicLim())
	rt.pub("POST /api/i/{token}/feedback", func(c *C) error {
		inv, err := c.deskInvByToken(c.Param("token"))
		if err != nil {
			return err
		}
		if inv == nil {
			return notFound("Not found")
		}
		b, err := c.Body(valid.Ordered("rating", valid.Int().Min(1).Max(5), "comment", valid.String().Trim().Max(800).Optional()))
		if err != nil {
			return err
		}
		if r, err := c.Val(`SELECT rating FROM catering_feedback WHERE invoice_id = ?`, inv["id"]); err != nil {
			return err
		} else if truthy(r) {
			return c.JSON(M{"ok": true, "already": true})
		}
		rating := i64(b["rating"])
		if _, err := c.Run(`INSERT INTO catering_feedback (invoice_id, rating, comment, responded_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(invoice_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, responded_at = excluded.responded_at`, inv["id"], rating, orNil(b["comment"])); err != nil {
			return err
		}
		s := c.S()
		what := str(b["comment"])
		if what == "" {
			what = str(inv["title"])
		}
		c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": fmt.Sprintf("%s: catering rated %d★", s["business_name"], rating), "body": trunc(str(inv["customer_name"])+": "+what, 140), "tag": fmt.Sprintf("catfb-%v", inv["id"]), "url": "/catering"}, 0)
		if err := c.AuditAs(nil, "catering.feedback", fmt.Sprintf("%s %d★", str(inv["title"]), rating), ""); err != nil {
			return err
		}
		c.Notify("invoices")
		review := ""
		if rating >= 4 {
			review = s["review_url"]
		}
		return c.JSON(M{"ok": true, "review": review})
	}, a.publicLim())
	rt.staff("GET /catering-feedback", "manager", func(c *C) error {
		rows, err := c.All(`SELECT f.*, i.title, i.customer_name, i.event_date FROM catering_feedback f JOIN invoices i ON i.id = f.invoice_id ORDER BY f.invoice_id DESC LIMIT 50`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})

	/* ===== jobs ===== */
	a.every("desk-alerts", 10*time.Minute, func(c *C) error {
		s := c.S()
		today, hm := c.deskToday(), c.deskHM()
		if hm < "09:00" {
			return nil
		}
		certs, err := c.All(`SELECT c.*, u.name FROM certificates c JOIN users u ON u.id = c.user_id WHERE u.active = 1 AND c.expires IS NOT NULL AND c.expires <= ?`, addDays(today, 30))
		if err != nil {
			return err
		}
		for _, ct := range certs {
			dl := deskDaysBetween(today, str(ct["expires"]))
			stage := "month"
			if dl < 0 {
				stage = "expired"
			} else if dl <= 7 {
				stage = "week"
			}
			first, err := c.deskOnce("desk_alerts", fmt.Sprintf("cert:%v:%s", ct["id"], stage))
			if err != nil {
				return err
			}
			if !first {
				continue
			}
			var when, mine, head string
			switch {
			case dl < 0:
				when, mine, head = fmt.Sprintf("expired %d days ago", -dl), "has expired", "expired"
			case dl == 0:
				when, mine, head = "expires today", "expires today", "expiring"
			default:
				when, mine, head = fmt.Sprintf("expires in %d days", dl), fmt.Sprintf("expires in %d days", dl), "expiring"
			}
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": s["business_name"] + ": certificate " + head, "body": fmt.Sprintf("%s's %s %s", str(ct["name"]), str(ct["kind"]), when), "tag": fmt.Sprintf("cert-%v", ct["id"]), "url": "/certificates"}, 0)
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, M{"title": "Your certificate", "body": fmt.Sprintf("Your %s %s. Renew it and add the new one in BuzzHub.", str(ct["kind"]), mine), "tag": fmt.Sprintf("mycert-%v", ct["id"]), "url": "/certificates"}, i64(ct["user_id"]))
		}
		if s["catering_followup"] == "1" && hm >= "10:00" && emailEnabled() {
			invs, err := c.All(`SELECT * FROM invoices WHERE event_date IS NOT NULL AND event_date < ? AND event_date >= ? AND status IN ('accepted','deposit_paid','paid') AND email IS NOT NULL AND NOT EXISTS (SELECT 1 FROM catering_feedback f WHERE f.invoice_id = invoices.id AND f.sent_at IS NOT NULL)`, today, addDays(today, -7))
			if err != nil {
				return err
			}
			for _, inv := range invs {
				if _, err := c.Run(`INSERT INTO catering_feedback (invoice_id, sent_at) VALUES (?, datetime('now')) ON CONFLICT(invoice_id) DO UPDATE SET sent_at = datetime('now')`, inv["id"]); err != nil {
					return err
				}
				base := strings.TrimRight(c.a.cfg.PublicURL, "/")
				l := ""
				if c.Slug() != "main" {
					l = "?l=" + c.Slug()
				}
				first := strings.Split(str(inv["customer_name"]), " ")[0]
				_, _ = emailGuest(str(inv["email"]), emailMsg{BusinessName: s["business_name"], Subject: "Thanks for choosing " + s["business_name"],
					Message: fmt.Sprintf("Hi %s,\n\nThank you for having us cater %s. How did we do? It takes 10 seconds, and it helps a lot.\n\nPlanning another event? You can book again from the same link.", first, str(inv["title"])),
					Link:    base + "/rate/" + str(inv["token"]) + l, Accent: s["accent"], Button: "Rate your catering"})
			}
		}
		return nil
	})
}
