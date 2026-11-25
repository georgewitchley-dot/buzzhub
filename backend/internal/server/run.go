package server

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of run.js: auto-fire courses, ingredient 86, prep lists per area, runner screen, late-ticket
// make-good, delivery batching, bar tabs from table QR, area staffing alerts.

func init() { modules = append(modules, (*App).registerRun) }

/* ---------- copies of kds.js stationList/stationFor, timeclock.js whosOn and house.js prepList ---------- */

func (c *C) runStationList() []string {
	out := []string{}
	if l, ok := jparse(c.S()["kitchen_stations"], nil).([]any); ok {
		for _, x := range l {
			out = append(out, crewJSString(x))
		}
	}
	if len(out) == 0 {
		return []string{"Kitchen"}
	}
	return out
}

func (c *C) runStationMap() map[string]any {
	m, _ := jparse(c.S()["station_map"], map[string]any{}).(map[string]any)
	if m == nil {
		m = map[string]any{}
	}
	return m
}

func runIn(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// runStationFor: which area makes this item (its own station, else its category's, else the first area).
func runStationFor(item M, list []string, mp map[string]any) string {
	if st := str(item["station"]); st != "" && runIn(list, st) {
		return st
	}
	if st, ok := mp[str(item["category"])].(string); ok && st != "" && runIn(list, st) {
		return st
	}
	return list[0]
}

var runAllAreas = map[string]bool{"All areas": true, "Expo": true, "Packing": true, "Runner": true}

type runOnShift struct {
	userID  int64
	name    string
	onBreak bool
}

func (c *C) runWhosOn() ([]runOnShift, error) {
	rows, err := c.All(`SELECT s.user_id, s.break_started, u.name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_out IS NULL ORDER BY s.clock_in`)
	if err != nil {
		return nil, err
	}
	out := []runOnShift{}
	for _, r := range rows {
		out = append(out, runOnShift{i64(r["user_id"]), str(r["name"]), truthy(r["break_started"])})
	}
	return out, nil
}

func (c *C) runPrepList(date string) (M, error) {
	s := c.S()
	bp, ok := jsNumber(s["prep_buffer_pct"])
	if !ok || bp == 0 {
		bp = 10
	}
	buffer := 1 + bp/100
	t, _ := time.Parse("2006-01-02", date)
	counts := map[int64]float64{}
	seen := 0
	for k := 1; k <= 8; k++ {
		start, end := opsDayBounds(addDays(date, -7*k), opsTZ(c))
		rows, err := c.All(`SELECT oi.item_id id, SUM(oi.qty) q FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.created_at >= ? AND o.created_at < ? AND o.status <> 'void' GROUP BY oi.item_id`, start, end)
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			seen++
		}
		for _, r := range rows {
			counts[i64(r["id"])] += f64(r["q"])
		}
	}
	n := math.Max(1, float64(seen))
	menu, err := c.All(`SELECT id, name, category FROM menu_items WHERE active = 1 ORDER BY category, sort, id`)
	if err != nil {
		return nil, err
	}
	items := []M{}
	need := map[int64]float64{}
	for _, m := range menu {
		cnt := counts[i64(m["id"])]
		prep := int64(math.Ceil(cnt / n * buffer))
		if prep <= 0 {
			continue
		}
		v := opsCopy(m)
		v["avg"] = float64(roundJS(cnt/n*10)) / 10
		v["prep"] = prep
		items = append(items, v)
		rs, err := c.All(`SELECT r.ingredient_id, r.qty FROM item_recipes r WHERE r.item_id = ?`, m["id"])
		if err != nil {
			return nil, err
		}
		for _, r := range rs {
			need[i64(r["ingredient_id"])] += f64(r["qty"]) * float64(prep)
		}
	}
	ids := []int64{}
	for id := range need {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	ings := []M{}
	for _, id := range ids {
		g, err := c.One(`SELECT * FROM ingredients WHERE id = ?`, id)
		if err != nil {
			return nil, err
		}
		if g == nil {
			continue
		}
		q := need[id]
		var have any
		short := 0.0
		if g["stock"] != nil {
			h := f64(g["stock"])
			have = crewR2(h)
			if h < q {
				short = crewR2(q - h)
			}
		}
		ings = append(ings, M{"id": g["id"], "name": g["name"], "unit": g["unit"], "need": crewR2(q), "have": have, "short": short})
	}
	sort.SliceStable(ings, func(i, j int) bool {
		a, b := f64(ings[i]["short"]), f64(ings[j]["short"])
		if a != b {
			return a > b
		}
		return strings.ToLower(str(ings[i]["name"])) < strings.ToLower(str(ings[j]["name"]))
	})
	return M{"date": date, "weekday": t.Weekday().String(), "weeksOfData": seen, "bufferPct": bp, "items": items, "ingredients": ings}, nil
}

/* ---------- helpers ---------- */

type runWho struct {
	area string
	user *auth.User
}

func (w runWho) label() string {
	if w.user != nil {
		return w.user.Name
	}
	return w.area + " screen"
}

// runWho: a paired kitchen screen (X-Kds) or a signed-in staff member.
func (c *C) runWho() (runWho, error) {
	if t := c.R.Header.Get("X-Kds"); t != "" {
		if p, ok := c.a.sess.VerifyDevice("kds", t); ok && str(p["loc"]) == c.Slug() {
			v := c.S()["kds_version"]
			if v == "" {
				v = "1"
			}
			if crewJSString(p["v"]) == v {
				return runWho{area: str(p["area"])}, nil
			}
		}
		return runWho{}, fail(401, "This kitchen screen is signed out.")
	}
	u, err := c.a.sess.UserFromToken(c.Ctx, c.Tx, cookie(c.R, auth.SessionCookie))
	if err != nil || u == nil {
		return runWho{}, fail(401, "Sign in first")
	}
	area := c.Q("area")
	if area == "" {
		if m, ok := c.Raw().(map[string]any); ok {
			area = crewJSString(m["area"])
			if m["area"] == nil || m["area"] == false || m["area"] == "" {
				area = ""
			}
		}
	}
	if area == "" {
		area = "All areas"
	}
	return runWho{area: area, user: u}, nil
}

func (c *C) runRetotal(orderID any) error {
	o, err := c.Get(`SELECT * FROM orders WHERE id = ?`, orderID)
	if err != nil {
		return err
	}
	sub, err := c.N(`SELECT COALESCE(SUM(qty * price_cents),0) c FROM order_items WHERE order_id = ?`, orderID)
	if err != nil {
		return err
	}
	disc := i64(o["discount_cents"])
	if sub < disc {
		disc = sub
	}
	rate, _ := jsNumber(c.S()["tax_rate"])
	tax := roundJS(float64(sub-disc) * rate / 100)
	_, err = c.Run(`UPDATE orders SET subtotal_cents = ?, discount_cents = ?, tax_cents = ?, total_cents = ? WHERE id = ?`, sub, disc, tax, sub-disc+tax+i64(o["fee_cents"]), orderID)
	return err
}

func runDist(a, b, c, d float64) float64 { return crewDist(a, b, c, d) / 1000 }

var runTableTokRE = regexp.MustCompile(`^[A-Za-z0-9_-]{16}$`)
var runTabTokRE = regexp.MustCompile(`^[A-Za-z0-9_-]{16,30}$`)

func (c *C) runTableByToken(t string) (store.Row, error) {
	if !runTableTokRE.MatchString(t) {
		return nil, nil
	}
	return c.One(`SELECT * FROM tables WHERE qr_token = ?`, t)
}

func (c *C) runTabByToken(t string) (store.Row, error) {
	if !runTabTokRE.MatchString(t) {
		return nil, nil
	}
	return c.One(`SELECT * FROM tabs WHERE token = ?`, t)
}

func (c *C) runTabView(tab store.Row) (M, error) {
	orders, err := c.All(`SELECT id, number, status, total_cents, created_at FROM orders WHERE tab_id = ? AND status <> 'void' ORDER BY id`, tab["id"])
	if err != nil {
		return nil, err
	}
	items := []store.Row{}
	var total int64
	if len(orders) > 0 {
		ids := []int64{}
		for _, o := range orders {
			ids = append(ids, i64(o["id"]))
			total += i64(o["total_cents"])
		}
		if items, err = c.All(`SELECT name, SUM(qty) qty, SUM(qty * price_cents) cents FROM order_items WHERE order_id IN (` + crewJoinIDs(ids) + `) GROUP BY name ORDER BY MIN(id)`); err != nil {
			return nil, err
		}
	}
	code, err := c.G("tabCode", tab["id"])
	if err != nil {
		return nil, err
	}
	members, err := c.G("tabMembers", tab)
	if err != nil {
		return nil, err
	}
	if members == nil {
		members = []any{}
	}
	var billToken any
	if truthy(tab["bill_id"]) {
		if b, err := c.One(`SELECT token FROM bills WHERE id = ?`, tab["bill_id"]); err != nil {
			return nil, err
		} else if b != nil {
			billToken = b["token"]
		}
	}
	return M{"token": tab["token"], "name": tab["name"], "code": code, "members": members, "status": tab["status"], "openedAt": tab["opened_at"], "rounds": len(orders), "totalCents": total, "items": items, "billToken": billToken}, nil
}

func (c *C) runCloseTab(tab store.Row) (any, error) {
	orders, err := c.All(`SELECT id FROM orders WHERE tab_id = ? AND status <> 'void' AND paid_at IS NULL`, tab["id"])
	if err != nil {
		return nil, err
	}
	billID := i64(tab["bill_id"])
	if billID == 0 {
		res, err := c.Run(`INSERT INTO bills (token) VALUES (?)`, crewToken(16))
		if err != nil {
			return nil, err
		}
		billID = res.LastID
		if _, err := c.Run(`UPDATE tabs SET bill_id = ?, status = 'closing' WHERE id = ?`, billID, tab["id"]); err != nil {
			return nil, err
		}
	}
	for _, o := range orders {
		if _, err := c.Run(`INSERT OR IGNORE INTO bill_orders (bill_id, order_id) VALUES (?, ?)`, billID, o["id"]); err != nil {
			return nil, err
		}
	}
	return c.Val(`SELECT token FROM bills WHERE id = ?`, billID)
}

func (c *C) runUnpaidOnTab(id any) (bool, error) {
	r, err := c.One(`SELECT 1 FROM orders WHERE tab_id = ? AND status <> 'void' AND paid_at IS NULL`, id)
	return r != nil, err
}

/* ---------- registration ---------- */

func (a *App) registerRun(rt *router) {
	gap := func(c *C) float64 { f, _ := jsNumber(c.S()["course_gap_minutes"]); return f }

	/* ===== auto-fire courses ===== */
	// fireIn(orderId, course) → minutes until a held course fires on its own, or nil.
	fireIn := func(c *C, orderID, course any) (any, error) {
		g := gap(c)
		if g == 0 || math.IsNaN(g) {
			return nil, nil
		}
		prev, err := c.Get(`SELECT COUNT(*) n, SUM(CASE WHEN done_at IS NULL THEN 1 ELSE 0 END) open, MAX(done_at) last FROM order_items WHERE order_id = ? AND course < ? AND price_cents >= 0`, orderID, course)
		if err != nil {
			return nil, err
		}
		if i64(prev["n"]) == 0 || i64(prev["open"]) != 0 {
			return nil, nil
		}
		return int64(math.Max(0, math.Ceil(float64(opsMs(str(prev["last"]))+int64(g*60000)-nowMs())/60000))), nil
	}
	a.G["fireIn"] = func(c *C, args ...any) (any, error) { return fireIn(c, args[0], args[1]) }
	a.every("auto-fire courses", 30*time.Second, func(c *C) error {
		if g := gap(c); g == 0 || math.IsNaN(g) {
			return nil
		}
		rows, err := c.All(`SELECT oi.order_id, MIN(oi.course) course FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.fired_at IS NULL AND oi.course > 1 AND o.status IN ('open','sent') GROUP BY oi.order_id`)
		if err != nil {
			return err
		}
		for _, r := range rows {
			v, err := fireIn(c, r["order_id"], r["course"])
			if err != nil {
				return err
			}
			if v == nil || i64(v) != 0 {
				continue
			}
			if _, err := c.Run(`UPDATE order_items SET fired_at = datetime('now') WHERE order_id = ? AND course = ? AND fired_at IS NULL`, r["order_id"], r["course"]); err != nil {
				return err
			}
			num, err := c.Val(`SELECT number FROM orders WHERE id = ?`, r["order_id"])
			if err != nil {
				return err
			}
			if err := c.AuditAs(nil, "course.autofire", fmt.Sprintf("#%v course %v", num, r["course"]), ""); err != nil {
				return err
			}
			c.Notify("orders")
			_ = c.Tx.Savepoint(c.Ctx, func() error { _, err := c.G("printTickets", r["order_id"], false, r["course"]); return err }) // best-effort
		}
		return nil
	})

	/* ===== ingredient 86 ===== */
	ingredientSweep := func(c *C) error {
		if c.S()["ingredient_86"] == "0" {
			return nil
		}
		out, err := c.All(`SELECT id, name FROM ingredients WHERE active = 1 AND stock IS NOT NULL AND stock <= 0`)
		if err != nil {
			return err
		}
		for _, g := range out {
			ms, err := c.All(`SELECT m.id, m.name, m.stock FROM item_recipes r JOIN menu_items m ON m.id = r.item_id WHERE r.ingredient_id = ? AND m.active = 1`, g["id"])
			if err != nil {
				return err
			}
			for _, m := range ms {
				if x, err := c.One(`SELECT 1 FROM ingredient_86 WHERE item_id = ? AND ingredient_id = ?`, m["id"], g["id"]); err != nil {
					return err
				} else if x != nil {
					continue
				}
				if _, err := c.Run(`INSERT INTO ingredient_86 (item_id, ingredient_id) VALUES (?, ?)`, m["id"], g["id"]); err != nil {
					return err
				}
				if m["stock"] == nil || f64(m["stock"]) > 0 {
					if _, err := c.Run(`UPDATE menu_items SET stock = 0 WHERE id = ?`, m["id"]); err != nil {
						return err
					}
					if err := c.AuditAs(nil, "item.86", fmt.Sprintf("%s: out of %s", str(m["name"]), str(g["name"])), ""); err != nil {
						return err
					}
					c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, M{"title": "86 " + str(m["name"]), "body": "Out of " + str(g["name"]) + ".", "tag": fmt.Sprintf("86-%v", m["id"]), "url": "/menu"}, 0)
					c.Notify("menu")
				}
			}
		}
		// back in stock: release dishes no other empty ingredient is holding
		back, err := c.All(`SELECT x.item_id, x.ingredient_id FROM ingredient_86 x JOIN ingredients g ON g.id = x.ingredient_id WHERE g.stock IS NULL OR g.stock > 0`)
		if err != nil {
			return err
		}
		for _, row := range back {
			if _, err := c.Run(`DELETE FROM ingredient_86 WHERE item_id = ? AND ingredient_id = ?`, row["item_id"], row["ingredient_id"]); err != nil {
				return err
			}
			if x, err := c.One(`SELECT 1 FROM ingredient_86 WHERE item_id = ?`, row["item_id"]); err != nil {
				return err
			} else if x == nil {
				if _, err := c.Run(`UPDATE menu_items SET stock = NULL WHERE id = ? AND stock <= 0`, row["item_id"]); err != nil {
					return err
				}
				c.Notify("menu")
			}
		}
		return nil
	}
	a.G["ingredientSweep"] = func(c *C, args ...any) (any, error) { return nil, ingredientSweep(c) }
	a.every("ingredient 86 sweep", 30*time.Second, ingredientSweep)

	rt.pub("GET /api/kds/ingredients", func(c *C) error {
		w, err := c.runWho()
		if err != nil {
			return err
		}
		list, mp := c.runStationList(), c.runStationMap()
		all := runAllAreas[w.area]
		menu, err := c.All(`SELECT id, category, station FROM menu_items WHERE active = 1`)
		if err != nil {
			return err
		}
		dishes := []int64{}
		for _, m := range menu {
			if all || runStationFor(m, list, mp) == w.area {
				dishes = append(dishes, i64(m["id"]))
			}
		}
		if len(dishes) == 0 {
			return c.JSON([]any{})
		}
		gs, err := c.All(`SELECT DISTINCT g.id, g.name, g.unit, g.stock, g.manual_out FROM ingredients g JOIN item_recipes r ON r.ingredient_id = g.id WHERE g.active = 1 AND r.item_id IN (` + crewJoinIDs(dishes) + `) ORDER BY g.name`)
		if err != nil {
			return err
		}
		out := []M{}
		for _, g := range gs {
			ds, err := c.All(`SELECT m.name FROM item_recipes r JOIN menu_items m ON m.id = r.item_id WHERE r.ingredient_id = ? AND m.active = 1`, g["id"])
			if err != nil {
				return err
			}
			names := []any{}
			for _, d := range ds {
				names = append(names, d["name"])
			}
			out = append(out, M{"id": g["id"], "name": g["name"], "unit": g["unit"], "out": g["stock"] != nil && f64(g["stock"]) <= 0, "stock": g["stock"], "dishes": names})
		}
		return c.JSON(out)
	})
	run86Schema := valid.Ordered("ingredientId", valid.Int(), "out", valid.Bool())
	rt.pub("POST /api/kds/ingredient-86", func(c *C) error {
		w, err := c.runWho()
		if err != nil {
			return err
		}
		b, err := c.Body(run86Schema)
		if err != nil {
			return err
		}
		g, err := c.One(`SELECT * FROM ingredients WHERE id = ?`, b["ingredientId"])
		if err != nil {
			return err
		}
		if g == nil {
			return notFound("Not found")
		}
		out := b["out"] == true
		if out {
			if !truthy(g["manual_out"]) {
				if _, err := c.Run(`UPDATE ingredients SET manual_out = 1, prev_stock = stock, stock = 0 WHERE id = ?`, g["id"]); err != nil {
					return err
				}
			}
		} else {
			if !truthy(g["manual_out"]) && g["stock"] != nil && f64(g["stock"]) <= 0 {
				return conflict(str(g["name"]) + " ran out by count. Add the delivery or a new count in Inventory to put it back.")
			}
			if _, err := c.Run(`UPDATE ingredients SET stock = CASE WHEN manual_out = 1 THEN prev_stock ELSE stock END, manual_out = 0, prev_stock = NULL WHERE id = ?`, g["id"]); err != nil {
				return err
			}
		}
		reason, action := "back ("+w.label()+")", "ingredient.back"
		if out {
			reason, action = "out ("+w.label()+")", "ingredient.out"
		}
		var uid any
		if w.user != nil {
			uid = w.user.ID
		}
		if _, err := c.Run(`INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?, 0, ?, ?)`, g["id"], reason, uid); err != nil {
			return err
		}
		if err := c.AuditAs(w.user, action, fmt.Sprintf("%s (%s)", str(g["name"]), w.label()), c.IP()); err != nil {
			return err
		}
		if err := ingredientSweep(c); err != nil {
			return err
		}
		c.Notify("menu")
		return c.OK()
	})

	/* ===== prep list per area ===== */
	rt.pub("GET /api/kds/prep", func(c *C) error {
		w, err := c.runWho()
		if err != nil {
			return err
		}
		list, mp := c.runStationList(), c.runStationMap()
		p, err := c.runPrepList(opsToday(c))
		if err != nil {
			return err
		}
		all := runAllAreas[w.area]
		metaRows, err := c.All(`SELECT id, category, station, shelf_days FROM menu_items`)
		if err != nil {
			return err
		}
		meta := map[int64]store.Row{}
		for _, m := range metaRows {
			meta[i64(m["id"])] = m
		}
		keep := func(i M) bool {
			if all {
				return true
			}
			if m := meta[i64(i["id"])]; m != nil {
				return runStationFor(m, list, mp) == w.area
			}
			return runStationFor(i, list, mp) == w.area
		}
		kept := []M{}
		for _, i := range p["items"].([]M) {
			if keep(i) {
				kept = append(kept, i)
			}
		}
		var items0 any = kept
		if c.Has("applyPars") {
			if items0, err = c.G("applyPars", kept, keep); err != nil {
				return err
			}
		}
		items1 := items0
		if c.Has("wasteAdjust") {
			if items1, err = c.G("wasteAdjust", items0); err != nil {
				return err
			}
		}
		items2 := items1
		if c.Has("prepSplit") {
			if items2, err = c.G("prepSplit", items1); err != nil {
				return err
			}
		}
		items := []M{}
		ids := []int64{}
		for _, i := range crewList(items2) {
			v := opsCopy(i)
			v["shelfDays"] = nil
			if m := meta[i64(i["id"])]; m != nil {
				v["shelfDays"] = m["shelf_days"]
			}
			recipe, err := c.G("prepRecipe", i["id"], i["prep"])
			if err != nil {
				return err
			}
			if recipe == nil {
				recipe = []any{}
			}
			v["recipe"] = recipe
			items = append(items, v)
			ids = append(ids, i64(i["id"]))
		}
		in := crewJoinIDs(ids)
		if in == "" {
			in = "0"
		}
		rs, err := c.All(`SELECT ingredient_id FROM item_recipes WHERE item_id IN (` + in + `)`)
		if err != nil {
			return err
		}
		ingIDs := map[int64]bool{}
		for _, r := range rs {
			ingIDs[i64(r["ingredient_id"])] = true
		}
		ings := []M{}
		for _, g := range p["ingredients"].([]M) {
			if ingIDs[i64(g["id"])] {
				ings = append(ings, g)
			}
		}
		left, err := c.G("prepLeftoversToday")
		if err != nil {
			return err
		}
		if left == nil {
			left = M{}
		}
		s := c.S()
		return c.JSON(M{"date": p["date"], "weekday": p["weekday"], "weeksOfData": p["weeksOfData"], "bufferPct": p["bufferPct"], "prepLabels": s["prep_labels"] == "1", "business": s["business_name"], "leftovers": left, "items": items, "ingredients": ings})
	})

	rt.pub("GET /api/kds/done-list", func(c *C) error {
		w, err := c.runWho()
		if err != nil {
			return err
		}
		v, err := c.G("recentDone", w.area, runAllAreas[w.area])
		if err != nil {
			return err
		}
		if v == nil {
			v = []any{}
		}
		return c.JSON(v)
	})
	// These three call hooks that other modules provide (house/table); Node throws (500) when they are missing.
	needHook := func(c *C, name string) error {
		if !c.Has(name) {
			return fmt.Errorf("%s hook is not available", name)
		}
		return nil
	}
	byName := func(w runWho, b valid.M) string {
		if w.user != nil {
			return w.user.Name
		}
		if by := str(b["by"]); by != "" {
			return by
		}
		return w.label()
	}
	runLeftSchema := valid.Ordered("lines", valid.Array(valid.Ordered("itemId", valid.Int(), "qty", valid.Int().Min(0).Max(9999))).Max(200), "by", valid.String().Trim().Max(30).Optional())
	rt.pub("POST /api/kds/leftovers", func(c *C) error {
		w, err := c.runWho()
		if err != nil {
			return err
		}
		b, err := c.Body(runLeftSchema)
		if err != nil {
			return err
		}
		if err := needHook(c, "prepLeftovers"); err != nil {
			return err
		}
		v, err := c.G("prepLeftovers", b["lines"], byName(w, b), w.user)
		if err != nil {
			return err
		}
		return c.JSON(v)
	})
	runAllergySchema := valid.Ordered("orderId", valid.Int(), "by", valid.String().Trim().Max(30).Optional())
	rt.pub("POST /api/kds/allergy-handoff", func(c *C) error {
		w, err := c.runWho()
		if err != nil {
			return err
		}
		b, err := c.Body(runAllergySchema)
		if err != nil {
			return err
		}
		if err := needHook(c, "allergyHandoff"); err != nil {
			return err
		}
		if _, err := c.G("allergyHandoff", b["orderId"], byName(w, b)); err != nil {
			return err
		}
		return c.OK()
	})
	runCountSchema := valid.Ordered("itemId", valid.Int(), "qty", valid.Int().Min(0).Max(9999).Nullable(), "by", valid.String().Trim().Max(30).Optional())
	rt.pub("POST /api/kds/prep-count", func(c *C) error {
		w, err := c.runWho()
		if err != nil {
			return err
		}
		b, err := c.Body(runCountSchema)
		if err != nil {
			return err
		}
		if err := needHook(c, "prepCount"); err != nil {
			return err
		}
		if _, err := c.G("prepCount", b["itemId"], b["qty"], byName(w, b)); err != nil {
			return err
		}
		return c.OK()
	})

	/* ===== runner screen ===== */
	// runnerOrders(list) → the orders a runner should take out.
	a.G["runnerOrders"] = func(c *C, args ...any) (any, error) {
		out := []M{}
		for _, o := range crewList(args[0]) {
			st := str(o["status"])
			if !truthy(o["table_label"]) || truthy(o["served_at"]) {
				continue
			}
			if truthy(o["passSince"]) || ((st == "ready" || st == "paid") && truthy(o["ready_at"]) && nowMs()-opsMs(str(o["ready_at"])) < 60*60000) {
				out = append(out, o)
			}
		}
		return out, nil
	}
	runOrderSchema := valid.Object(map[string]valid.Schema{"orderId": valid.Int()})
	rt.pub("POST /api/kds/served", func(c *C) error {
		w, err := c.runWho()
		if err != nil {
			return err
		}
		b, err := c.Body(runOrderSchema)
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, b["orderId"])
		if err != nil {
			return err
		}
		if o == nil {
			return notFound("Not found")
		}
		if _, err := c.Run(`UPDATE orders SET served_at = datetime('now') WHERE id = ?`, o["id"]); err != nil {
			return err
		}
		if err := c.AuditAs(w.user, "order.served", fmt.Sprintf("#%v (%s)", o["number"], w.label()), c.IP()); err != nil {
			return err
		}
		c.Notify("orders")
		return c.OK()
	})

	/* ===== late-ticket make-good ===== */
	lateLimit := func(c *C) float64 { f, _ := jsNumber(c.S()["makegood_minutes"]); return f }
	a.G["makegoodDue"] = func(c *C, args ...any) (any, error) {
		o := crewMap(args[0])
		l := lateLimit(c)
		st := str(o["status"])
		return l != 0 && !truthy(o["makegood_at"]) && (st == "open" || st == "sent") && truthy(o["sent_at"]) && float64(nowMs()-opsMs(str(o["sent_at"]))) >= l*60000, nil
	}
	// by is the audit user (nil for a kitchen screen); who is the label in brackets.
	makeGood := func(c *C, o store.Row, kind string, by *auth.User, who, ip string) (string, error) {
		s := c.S()
		if truthy(o["makegood_at"]) {
			return "", conflict("Already made good")
		}
		if truthy(o["paid_at"]) {
			return "", conflict("This order is already paid; take care of it at the table")
		}
		var what string
		if kind == "item" {
			mid, _ := jsNumber(s["makegood_item_id"])
			m, err := c.One(`SELECT * FROM menu_items WHERE id = ? AND active = 1`, int64(mid))
			if err != nil {
				return "", err
			}
			if m == nil {
				return "", bad("Pick the make-good dish in Settings first")
			}
			if _, err := c.Run(`INSERT INTO order_items (order_id, item_id, name, qty, price_cents, note, course, fired_at) VALUES (?, ?, ?, 1, 0, 'On us: sorry for the wait', 1, datetime('now'))`, o["id"], m["id"], m["name"]); err != nil {
				return "", err
			}
			what = "free " + str(m["name"])
		} else {
			pct := 10.0
			if v := s["makegood_pct"]; v != "" {
				if f, ok := jsNumber(v); ok && f != 0 {
					pct = f
				}
			}
			pct = math.Min(100, math.Max(1, pct))
			sub, err := c.N(`SELECT COALESCE(SUM(qty * price_cents),0) c FROM order_items WHERE order_id = ?`, o["id"])
			if err != nil {
				return "", err
			}
			off := roundJS(float64(sub) * pct / 100)
			if _, err := c.Run(`UPDATE orders SET discount_cents = discount_cents + ? WHERE id = ?`, off, o["id"]); err != nil {
				return "", err
			}
			if err := c.runRetotal(o["id"]); err != nil {
				return "", err
			}
			what = fmt.Sprintf("%s%% off ($%s)", fmtJSNum(pct), dollars(off))
		}
		if _, err := c.Run(`UPDATE orders SET makegood_at = datetime('now'), order_notes = TRIM(COALESCE(order_notes, '') || ' ' || ?) WHERE id = ?`, "[Make-good: "+what+"]", o["id"]); err != nil {
			return "", err
		}
		if err := c.AuditAs(by, "order.makegood", fmt.Sprintf("#%v: %s (%s)", o["number"], what, who), ip); err != nil {
			return "", err
		}
		c.Notify("orders")
		return what, nil
	}
	runMGSchema := valid.Ordered("orderId", valid.Int(), "kind", valid.Enum("item", "discount"))
	rt.pub("POST /api/kds/makegood", func(c *C) error {
		w, err := c.runWho()
		if err != nil {
			return err
		}
		b, err := c.Body(runMGSchema)
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, b["orderId"])
		if err != nil {
			return err
		}
		if o == nil {
			return notFound("Not found")
		}
		what, err := makeGood(c, o, str(b["kind"]), w.user, w.label(), c.IP())
		if err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "what": what})
	})
	runMGStaffSchema := valid.Object(map[string]valid.Schema{"kind": valid.Enum("item", "discount")})
	rt.staff("POST /orders/{id}/makegood", "manager", func(c *C) error {
		b, err := c.Body(runMGStaffSchema)
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, c.crewNumParam("id"))
		if err != nil {
			return err
		}
		if o == nil {
			return notFound("Not found")
		}
		what, err := makeGood(c, o, str(b["kind"]), c.U, c.U.Name, c.IP())
		if err != nil {
			return err
		}
		return c.JSON(M{"ok": true, "what": what})
	})
	a.every("late-ticket alerts", 30*time.Second, func(c *C) error {
		l := lateLimit(c)
		if l == 0 || math.IsNaN(l) {
			return nil
		}
		cut := opsFmtSQL(time.Now().Add(-time.Duration(l * float64(time.Minute))))
		rows, err := c.All(`SELECT o.id, o.number, o.sent_at, t.label FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.status IN ('open','sent') AND o.makegood_at IS NULL AND o.makegood_alerted IS NULL AND o.sent_at < ?`, cut)
		if err != nil {
			return err
		}
		for _, o := range rows {
			if _, err := c.Run(`UPDATE orders SET makegood_alerted = datetime('now') WHERE id = ?`, o["id"]); err != nil {
				return err
			}
			body := "Offer a make-good from the expo screen or Orders."
			if truthy(o["label"]) {
				body = c.S()["unit_label"] + " " + str(o["label"]) + ". " + body
			}
			late := roundJS(float64(nowMs()-opsMs(str(o["sent_at"]))) / 60000)
			c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": fmt.Sprintf("#%v is %d minutes late", o["number"], late), "body": body, "tag": fmt.Sprintf("late-%v", o["id"]), "url": "/orders"}, 0)
		}
		return nil
	})

	/* ===== delivery batching ===== */
	rt.staff("GET /delivery-batches", "manager", func(c *C) error {
		s := c.S()
		radius := 2.0
		if f, ok := jsNumber(s["batch_radius_km"]); ok && f != 0 {
			radius = f
		}
		windowMin := 15.0
		if f, ok := jsNumber(s["batch_window_minutes"]); ok && f != 0 {
			windowMin = f
		}
		list, err := c.All(`SELECT id, number, delivery_address, drop_lat, drop_lng, status, sent_at, ready_at, customer_name FROM orders WHERE fulfillment = 'delivery' AND driver_id IS NULL AND delivered_at IS NULL AND status IN ('open','sent','ready','paid') AND created_at > datetime('now','-4 hours') ORDER BY COALESCE(ready_at, sent_at)`)
		if err != nil {
			return err
		}
		for _, o := range list {
			if o["drop_lat"] == nil && truthy(o["delivery_address"]) && c.Has("geocode") {
				g, err := c.G("geocode", o["delivery_address"])
				if err != nil || g == nil {
					continue
				}
				gm := crewMap(g)
				if _, err := c.Run(`UPDATE orders SET drop_lat = ?, drop_lng = ? WHERE id = ?`, gm["lat"], gm["lng"], o["id"]); err != nil {
					return err
				}
				o["drop_lat"], o["drop_lng"] = gm["lat"], gm["lng"]
			}
		}
		placed := []store.Row{}
		for _, o := range list {
			if o["drop_lat"] != nil {
				placed = append(placed, o)
			}
		}
		used := map[int64]bool{}
		batches := []M{}
		t := func(x store.Row) int64 {
			v := str(x["ready_at"])
			if v == "" {
				v = str(x["sent_at"])
			}
			if v == "" {
				return nowMs() / 1000 * 1000
			}
			return opsMs(v)
		}
		d := func(x, y store.Row) float64 {
			return runDist(f64(x["drop_lat"]), f64(x["drop_lng"]), f64(y["drop_lat"]), f64(y["drop_lng"]))
		}
		for _, oa := range placed {
			if used[i64(oa["id"])] {
				continue
			}
			group := []store.Row{oa}
			used[i64(oa["id"])] = true
			for _, ob := range placed {
				if used[i64(ob["id"])] || len(group) >= 4 {
					continue
				}
				near := true
				for _, g := range group {
					if d(g, ob) > radius {
						near = false
						break
					}
				}
				if near && math.Abs(float64(t(oa)-t(ob))) <= windowMin*60000 {
					group = append(group, ob)
					used[i64(ob["id"])] = true
				}
			}
			if len(group) > 1 {
				orders := []M{}
				spread := 0.0
				for _, x := range group {
					st := str(x["status"])
					orders = append(orders, M{"id": x["id"], "number": x["number"], "address": x["delivery_address"], "name": x["customer_name"], "ready": st == "ready" || st == "paid"})
					for _, y := range group {
						spread = math.Max(spread, d(x, y))
					}
				}
				batches = append(batches, M{"orders": orders, "spreadKm": float64(roundJS(spread*10)) / 10})
			}
		}
		unplaced := []M{}
		for _, o := range list {
			if o["drop_lat"] == nil {
				unplaced = append(unplaced, M{"id": o["id"], "number": o["number"], "address": o["delivery_address"]})
			}
		}
		drivers, err := c.All(`SELECT id, name FROM users WHERE is_driver = 1 AND active = 1 ORDER BY name`)
		if err != nil {
			return err
		}
		return c.JSON(M{"radiusKm": radius, "windowMinutes": windowMin, "batches": batches, "unplaced": unplaced, "drivers": drivers})
	})
	runAssignSchema := valid.Ordered("orderIds", valid.Array(valid.Int()).Min(1).Max(6), "driverId", valid.Int())
	rt.staff("POST /delivery-batches/assign", "manager", func(c *C) error {
		b, err := c.Body(runAssignSchema)
		if err != nil {
			return err
		}
		driver := i64(b["driverId"])
		if x, err := c.One(`SELECT 1 FROM users WHERE id = ? AND is_driver = 1 AND active = 1`, driver); err != nil {
			return err
		} else if x == nil {
			return bad("Pick a driver")
		}
		nums := []string{}
		for _, id := range b["orderIds"].([]any) {
			o, err := c.One(`SELECT * FROM orders WHERE id = ? AND fulfillment = 'delivery' AND delivered_at IS NULL`, id)
			if err != nil {
				return err
			}
			if o == nil {
				continue
			}
			if _, err := c.Run(`UPDATE orders SET driver_id = ? WHERE id = ?`, driver, o["id"]); err != nil {
				return err
			}
			nums = append(nums, fmt.Sprintf("#%v", o["number"]))
		}
		joined := strings.Join(nums, ", ")
		c.Emit("user:"+itoa(driver), "delivery:assigned", M{"number": joined})
		c.a.pushToUsers(c.Ctx, c.Tx, []string{"staff", "manager", "owner"}, M{"title": fmt.Sprintf("%d deliveries for you", len(nums)), "body": "Orders " + joined, "tag": "drv-batch", "url": "/deliveries"}, driver)
		if err := c.Audit("delivery.batch", fmt.Sprintf("%s → driver %d", joined, driver)); err != nil {
			return err
		}
		c.Notify("orders")
		return c.JSON(M{"ok": true, "assigned": len(nums)})
	})

	/* ===== bar tabs from table QR ===== */
	// tabForOrder(tabToken, tableId) → the open tab, nil when no tab was asked for.
	a.G["tabForOrder"] = func(c *C, args ...any) (any, error) {
		tok := ""
		if len(args) > 0 {
			tok = str(args[0])
		}
		if tok == "" {
			return nil, nil
		}
		tab, err := c.runTabByToken(tok)
		if err != nil {
			return nil, err
		}
		var tableID int64
		if len(args) > 1 {
			tableID = i64(args[1])
		}
		if tab == nil || str(tab["status"]) != "open" || (truthy(tab["table_id"]) && tableID != 0 && i64(tab["table_id"]) != tableID) {
			return nil, conflict("This tab is closed. Start a new one.")
		}
		return tab, nil
	}
	runTabSchema := valid.Ordered("name", valid.String().Trim().Min(1).Max(30), "phone", valid.String().Trim().Max(20).Optional())
	rt.pub("POST /api/t/{token}/tab", func(c *C) error {
		if c.S()["bar_tabs"] != "1" {
			return forbidden("Tabs are not available here")
		}
		t, err := c.runTableByToken(c.Param("token"))
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("This table code is not valid.")
		}
		b, err := c.Body(runTabSchema)
		if err != nil {
			return err
		}
		token := crewToken(12)
		if _, err := c.Run(`INSERT INTO tabs (token, table_id, name, phone) VALUES (?,?,?,?)`, token, t["id"], b["name"], orNil(b["phone"])); err != nil {
			return err
		}
		if err := c.AuditAs(nil, "tab.open", fmt.Sprintf("%s at %s", str(b["name"]), str(t["label"])), c.IP()); err != nil {
			return err
		}
		c.Notify("tabs")
		tab, err := c.runTabByToken(token)
		if err != nil {
			return err
		}
		v, err := c.runTabView(tab)
		if err != nil {
			return err
		}
		return c.JSON(v)
	}, a.publicLim())
	rt.pub("GET /api/t/{token}/tab/{tab}", func(c *C) error {
		tab, err := c.runTabByToken(c.Param("tab"))
		if err != nil {
			return err
		}
		if tab == nil {
			return notFound("Tab not found")
		}
		v, err := c.runTabView(tab)
		if err != nil {
			return err
		}
		return c.JSON(v)
	}, a.publicLim())
	rt.pub("POST /api/t/{token}/tab/{tab}/close", func(c *C) error {
		tab, err := c.runTabByToken(c.Param("tab"))
		if err != nil {
			return err
		}
		if tab == nil {
			return notFound("Tab not found")
		}
		if x, err := c.One(`SELECT 1 FROM orders WHERE tab_id = ? AND status <> 'void'`, tab["id"]); err != nil {
			return err
		} else if x == nil {
			if _, err := c.Run(`UPDATE tabs SET status = 'closed', closed_at = datetime('now') WHERE id = ?`, tab["id"]); err != nil {
				return err
			}
			return c.JSON(M{"closed": true})
		}
		token, err := c.runCloseTab(tab)
		if err != nil {
			return err
		}
		c.Notify("tabs")
		var member any
		if m, ok := c.Raw().(map[string]any); ok {
			if s, ok := m["member"].(string); ok {
				member = crewSlice(s, 30)
			}
		}
		items, err := c.G("memberItems", tab, member)
		if err != nil {
			return err
		}
		if items == nil {
			items = []any{}
		}
		return c.JSON(M{"billToken": token, "items": items})
	}, a.publicLim())
	rt.staff("GET /tabs", "staff", func(c *C) error {
		rows, err := c.All(`SELECT t.*, tb.label table_label FROM tabs t LEFT JOIN tables tb ON tb.id = t.table_id WHERE t.status <> 'closed' AND t.opened_at > datetime('now','-24 hours') ORDER BY t.opened_at`)
		if err != nil {
			return err
		}
		out := []M{}
		for _, t := range rows {
			v, err := c.runTabView(t)
			if err != nil {
				return err
			}
			v["id"], v["table"] = t["id"], t["table_label"]
			out = append(out, v)
		}
		return c.JSON(out)
	})
	rt.staff("POST /tabs/{id}/close", "staff", func(c *C) error {
		tab, err := c.One(`SELECT * FROM tabs WHERE id = ?`, c.crewNumParam("id"))
		if err != nil {
			return err
		}
		if tab == nil {
			return notFound("Not found")
		}
		unpaid, err := c.runUnpaidOnTab(tab["id"])
		if err != nil {
			return err
		}
		if !unpaid {
			if _, err := c.Run(`UPDATE tabs SET status = 'closed', closed_at = datetime('now') WHERE id = ?`, tab["id"]); err != nil {
				return err
			}
			c.Notify("tabs")
			return c.JSON(M{"closed": true})
		}
		token, err := c.runCloseTab(tab)
		if err != nil {
			return err
		}
		if err := c.Audit("tab.close", str(tab["name"])); err != nil {
			return err
		}
		c.Notify("tabs")
		return c.JSON(M{"billToken": token})
	})
	// tabs whose orders are all paid close themselves
	a.every("tab sweep", 30*time.Second, func(c *C) error {
		rows, err := c.All(`SELECT id FROM tabs WHERE status = 'closing'`)
		if err != nil {
			return err
		}
		for _, t := range rows {
			unpaid, err := c.runUnpaidOnTab(t["id"])
			if err != nil {
				return err
			}
			if !unpaid {
				if _, err := c.Run(`UPDATE tabs SET status = 'closed', closed_at = datetime('now') WHERE id = ?`, t["id"]); err != nil {
					return err
				}
			}
		}
		return nil
	})

	/* ===== area staffing alerts ===== */
	areaLoad := func(c *C) ([]M, error) {
		list, mp := c.runStationList(), c.runStationMap()
		on, err := c.runWhosOn()
		if err != nil {
			return nil, err
		}
		us, err := c.All(`SELECT id, area FROM users`)
		if err != nil {
			return nil, err
		}
		areaOf := map[int64]string{}
		for _, u := range us {
			areaOf[i64(u["id"])] = str(u["area"])
		}
		items, err := c.All(`SELECT oi.qty, m.category, m.station FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN menu_items m ON m.id = oi.item_id WHERE o.status IN ('open','sent') AND oi.done_at IS NULL AND (oi.course <= 1 OR oi.fired_at IS NOT NULL)`)
		if err != nil {
			return nil, err
		}
		out := []M{}
		for _, ar := range list {
			names := []any{}
			for _, p := range on {
				if !p.onBreak && areaOf[p.userID] == ar {
					names = append(names, strings.SplitN(p.name, " ", 2)[0])
				}
			}
			var n int64
			for _, i := range items {
				if runStationFor(i, list, mp) == ar {
					n += i64(i["qty"])
				}
			}
			var per any = n
			if len(names) > 0 {
				per = float64(roundJS(float64(n)/float64(len(names))*10)) / 10
			}
			out = append(out, M{"area": ar, "items": n, "cooks": len(names), "names": names, "perCook": per})
		}
		return out, nil
	}
	a.G["areaLoad"] = func(c *C, args ...any) (any, error) { return areaLoad(c) }
	areaHigh := func(c *C) float64 {
		if f, ok := jsNumber(c.S()["area_alert_high"]); ok && f != 0 {
			return f
		}
		return 12
	}
	rt.staff("GET /area-load", "staff", func(c *C) error {
		l, err := areaLoad(c)
		if err != nil {
			return err
		}
		return c.JSON(M{"high": areaHigh(c), "areas": l})
	})
	a.every("area staffing alerts", 5*time.Minute, func(c *C) error {
		s := c.S()
		if s["area_alerts"] != "1" {
			return nil
		}
		high := areaHigh(c)
		quiet := 30.0
		if f, ok := jsNumber(s["area_alert_quiet_minutes"]); ok && f != 0 {
			quiet = f
		}
		once := func(area, kind string, mins float64) (bool, error) {
			r, err := c.One(`SELECT at FROM area_alerts WHERE area = ? AND kind = ?`, area, kind)
			if err != nil {
				return false, err
			}
			if r != nil && float64(nowMs()-opsMs(str(r["at"]))) < mins*60000 {
				return false, nil
			}
			_, err = c.Run(`INSERT INTO area_alerts (area, kind, at) VALUES (?, ?, ?) ON CONFLICT (area, kind) DO UPDATE SET at = excluded.at`, area, kind, store.Now())
			return err == nil, err
		}
		loads, err := areaLoad(c)
		if err != nil {
			return err
		}
		for _, al := range loads {
			area, items, cooks := str(al["area"]), i64(al["items"]), al["cooks"].(int)
			if items > 0 && (cooks == 0 || f64(al["perCook"]) > high) {
				ok, err := once(area, "high", 45)
				if err != nil {
					return err
				}
				if ok {
					who := "nobody clocked in for it"
					if cooks == 1 {
						who = "1 cook"
					} else if cooks > 1 {
						who = fmt.Sprintf("%d cooks", cooks)
					}
					c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": area + " needs help", "body": fmt.Sprintf("%d items waiting, %s.", items, who), "tag": "area-" + area, "url": "/kitchen"}, 0)
				}
			}
			if items == 0 && cooks >= 2 {
				last, err := c.Val(`SELECT MAX(oi.done_at) t FROM order_items oi WHERE oi.done_station = ?`, area)
				if err != nil {
					return err
				}
				if last == nil || float64(nowMs()-opsMs(str(last))) > quiet*60000 {
					ok, err := once(area, "quiet", 120)
					if err != nil {
						return err
					}
					if ok {
						names := []string{}
						for _, n := range al["names"].([]any) {
							names = append(names, str(n))
						}
						c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": area + " is quiet", "body": fmt.Sprintf("%d on the clock (%s) and nothing cooking for %s+ minutes. Send someone on break or home?", cooks, strings.Join(names, ", "), fmtJSNum(quiet)), "tag": "area-" + area, "url": "/labor-areas"}, 0)
					}
				}
			}
		}
		return nil
	})
}
