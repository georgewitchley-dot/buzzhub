package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of house.js (round 7, batch M): checklists and temperature logs, event tickets,
// bank deposit matching, menu engineering, prep list.

func init() { modules = append(modules, (*App).registerHouse) }

/* ---------- Stripe REST (own copy so this module doesn't depend on the commerce port) ---------- */

var houseStripeClient = &http.Client{Timeout: 20 * time.Second}

func houseStripeKey() string { return os.Getenv("STRIPE_SECRET_KEY") }

var houseStripeKeyRE = regexp.MustCompile(`^sk_(live|test)_`)

func houseStripeEnabled() bool { return houseStripeKeyRE.MatchString(houseStripeKey()) }

// houseStripe calls the Stripe API like commerce.js stripe(method, path, form).
func houseStripe(method, path string, form url.Values) (map[string]any, error) {
	var body *strings.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	} else {
		body = strings.NewReader("")
	}
	req, err := http.NewRequest(method, "https://api.stripe.com/v1"+path, body)
	if err != nil {
		return nil, fail(502, "Couldn't reach the card processor. Please try again or pay your server.")
	}
	req.Header.Set("Authorization", "Bearer "+houseStripeKey())
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	req.Header.Set("Stripe-Version", "2024-06-20")
	resp, err := houseStripeClient.Do(req)
	if err != nil {
		return nil, fail(502, "Couldn't reach the card processor. Please try again or pay your server.")
	}
	defer resp.Body.Close()
	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, fail(500, "Server error")
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		msg := "Card payments are not available right now"
		if e, ok := data["error"].(map[string]any); ok && truthy(e["message"]) {
			msg = str(e["message"])
		}
		return nil, fail(502, msg)
	}
	return data, nil
}

/* ---------- checklists for a day ---------- */

func (c *C) houseChecklistsFor(day string) ([]M, error) {
	tpls, err := c.All(`SELECT * FROM checklist_templates WHERE active = 1 ORDER BY sort, id`)
	if err != nil {
		return nil, err
	}
	out := []M{}
	today, hm := c.deskToday(), c.deskHM()
	for _, t := range tpls {
		if str(t["kind"]) == "weekly" && (t["dow"] == nil || i64(t["dow"]) != int64(deskDowOf(day))) {
			continue
		}
		items := deskJList(t["items"])
		run, err := c.One(`SELECT r.*, u.name by_name FROM checklist_runs r LEFT JOIN users u ON u.id = r.completed_by WHERE r.template_id = ? AND r.day = ?`, t["id"], day)
		if err != nil {
			return nil, err
		}
		var done map[string]any
		if run != nil {
			done = deskJObj(run["done"])
		} else {
			done = map[string]any{}
		}
		list := []M{}
		count := 0
		for i, x := range items {
			it, _ := x.(map[string]any)
			d := done[fmt.Sprint(i)]
			if truthy(d) {
				count++
			} else {
				d = nil
			}
			list = append(list, M{"text": it["text"], "needsValue": truthy(it["needsValue"]), "done": d})
		}
		var completedAt, completedBy any
		if run != nil {
			completedAt, completedBy = orNil(run["completed_at"]), orNil(run["by_name"])
		}
		var overdue any
		switch {
		case completedAt != nil:
			overdue = false
		case !truthy(t["due_time"]):
			overdue = t["due_time"]
		default:
			overdue = day == today && hm > str(t["due_time"])
		}
		out = append(out, M{"id": t["id"], "name": t["name"], "kind": t["kind"], "area": orNil(t["area"]), "dueTime": t["due_time"], "items": list, "count": count, "total": len(items),
			"completedAt": completedAt, "completedBy": completedBy, "overdue": overdue})
	}
	return out, nil
}

/* ---------- menu engineering ---------- */

var houseAdvice = map[string]string{"star": "Keep it front and center. Protect quality, and consider a small price rise.", "plowhorse": "Popular but low profit: trim portion or cost, raise the price a little, or pair it with a high-margin add-on.", "puzzle": "Profitable but slow: move it higher on the menu, rename or describe it better, or have staff suggest it.", "dog": "Low sales and low profit: rework it, or take it off the menu."}

func (c *C) houseMenuEngineering(days int) (M, error) {
	target := deskOr(c.S()["food_cost_target"], 30) / 100
	sold, err := c.All(`SELECT oi.item_id id, SUM(oi.qty) qty FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.paid_at > datetime('now', ?) AND o.status <> 'void' GROUP BY oi.item_id`, fmt.Sprintf("-%d days", days))
	if err != nil {
		return nil, err
	}
	soldMap := map[int64]float64{}
	for _, r := range sold {
		soldMap[i64(r["id"])] = f64(r["qty"])
	}
	costs, err := c.All(`SELECT r.item_id id, SUM(r.qty * g.cost_cents) c FROM item_recipes r JOIN ingredients g ON g.id = r.ingredient_id GROUP BY r.item_id`)
	if err != nil {
		return nil, err
	}
	cost := map[int64]any{}
	for _, r := range costs {
		cost[i64(r["id"])] = r["c"]
	}
	rows, err := c.All(`SELECT id, name, category, price_cents FROM menu_items WHERE active = 1 ORDER BY id`)
	if err != nil {
		return nil, err
	}
	type it struct {
		m      M
		qty    float64
		margin int64
	}
	items := []it{}
	totalQty := 0.0
	for _, m := range rows {
		price := i64(m["price_cents"])
		var cc any
		var cm int64
		if v, ok := cost[i64(m["id"])]; ok {
			r := roundJS(f64(v))
			cc = r
			cm = price - r
		} else {
			cm = price - roundJS(float64(price)*target)
		}
		q := soldMap[i64(m["id"])]
		totalQty += q
		items = append(items, it{M{"id": m["id"], "name": m["name"], "category": m["category"], "price_cents": m["price_cents"], "qty": q, "costCents": cc, "estimated": cc == nil, "marginCents": cm}, q, cm})
	}
	if totalQty == 0 {
		totalQty = 1
	}
	popLine := (1 / math.Max(1, float64(len(items)))) * 0.7
	sumCm := 0.0
	for _, i := range items {
		sumCm += float64(i.margin) * i.qty
	}
	avgCm := sumCm / totalQty
	out := []M{}
	for _, i := range items {
		mix := i.qty / totalQty
		popular, profitable := mix >= popLine, float64(i.margin) >= avgCm
		cls := "dog"
		switch {
		case popular && profitable:
			cls = "star"
		case popular:
			cls = "plowhorse"
		case profitable:
			cls = "puzzle"
		}
		m := i.m
		m["mixPct"], m["class"], m["advice"], m["contributionCents"] = round1(mix*100), cls, houseAdvice[cls], float64(i.margin)*i.qty
		out = append(out, m)
	}
	sort.SliceStable(out, func(a, b int) bool {
		return out[a]["contributionCents"].(float64) > out[b]["contributionCents"].(float64)
	})
	return M{"days": days, "averageMarginCents": roundJS(avgCm), "popularityLinePct": round1(popLine * 100), "items": out}, nil
}

/* ---------- prep list ---------- */

var houseWeekdays = []string{"Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"}

func (c *C) housePrepList(date string) (M, error) {
	s := c.S()
	bufPct := deskOr(s["prep_buffer_pct"], 10)
	buffer := 1 + bufPct/100
	counts := map[int64]float64{}
	seen := 0
	for k := 1; k <= 8; k++ {
		start, end := deskDayBounds(addDays(date, -7*k), c.deskTZ())
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
	n := float64(seen)
	if n < 1 {
		n = 1
	}
	menu, err := c.All(`SELECT id, name, category FROM menu_items WHERE active = 1 ORDER BY category, sort, id`)
	if err != nil {
		return nil, err
	}
	items := []M{}
	need := map[int64]float64{}
	for _, m := range menu {
		x := counts[i64(m["id"])] / n
		prep := math.Ceil(x * buffer)
		if prep <= 0 {
			continue
		}
		items = append(items, M{"id": m["id"], "name": m["name"], "category": m["category"], "avg": round1(x), "prep": prep})
		recs, err := c.All(`SELECT r.ingredient_id, r.qty FROM item_recipes r WHERE r.item_id = ?`, m["id"])
		if err != nil {
			return nil, err
		}
		for _, r := range recs {
			need[i64(r["ingredient_id"])] += f64(r["qty"]) * prep
		}
	}
	ids := make([]int64, 0, len(need))
	for id := range need {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
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
			have = round2(h)
			if h < q {
				short = round2(q - h)
			}
		}
		ings = append(ings, M{"id": g["id"], "name": g["name"], "unit": g["unit"], "need": round2(q), "have": have, "short": short})
	}
	sort.SliceStable(ings, func(a, b int) bool {
		sa, sb := ings[a]["short"].(float64), ings[b]["short"].(float64)
		if sa != sb {
			return sa > sb
		}
		return deskLocaleCmp(str(ings[a]["name"]), str(ings[b]["name"])) < 0
	})
	return M{"date": date, "weekday": houseWeekdays[deskDowOf(date)], "weeksOfData": seen, "bufferPct": bufPct, "items": items, "ingredients": ings}, nil
}

/* ---------- daily books (reach.js dailyBooks, needed for deposit matching) ---------- */

type houseDay struct {
	Date     string
	ByMethod map[string]int64
	Order    []string
}

func (c *C) houseDailyBooks(from, to string) ([]houseDay, error) {
	out := []houseDay{}
	add := func(d *houseDay, k string, v int64) {
		if _, ok := d.ByMethod[k]; !ok {
			d.Order = append(d.Order, k)
		}
		d.ByMethod[k] += v
	}
	for d := from; d <= to; d = addDays(d, 1) {
		start, end := deskDayBounds(d, c.deskTZ())
		day := houseDay{Date: d, ByMethod: map[string]int64{}}
		rows, err := c.All(`SELECT payment_method m, subtotal_cents - discount_cents + tax_cents + COALESCE(fee_cents,0) + tip_cents - COALESCE(gift_cents,0) c FROM orders WHERE paid_at >= ? AND paid_at < ? AND status <> 'void'`, start, end)
		if err != nil {
			return nil, err
		}
		for _, r := range rows {
			k := strings.Split(str(orNil(r["m"])), "+")[0]
			if r["m"] == nil || str(r["m"]) == "" {
				k = "other"
			}
			if k == "" {
				k = "other"
			}
			add(&day, k, i64(r["c"]))
		}
		extra, err := c.All(`SELECT kind, method, COALESCE(provider,'') provider, amount_cents + tip_cents c FROM payments WHERE status = 'paid' AND kind IN ('giftcard','membership','invoice','deposit') AND paid_at >= ? AND paid_at < ?`, start, end)
		if err != nil {
			return nil, err
		}
		for _, x := range extra {
			if str(x["kind"]) == "giftcard" {
				continue
			}
			k := str(x["method"])
			if p := str(x["provider"]); strings.HasPrefix(p, "manual:") {
				k = p[7:]
			} else if k == "" {
				k = "card"
			}
			add(&day, k, i64(x["c"]))
		}
		gifts, err := c.All(`SELECT method, SUM(delta_cents) c FROM gift_txns WHERE delta_cents > 0 AND order_id IS NULL AND at >= ? AND at < ? GROUP BY method`, start, end)
		if err != nil {
			return nil, err
		}
		for _, g := range gifts {
			k := str(g["method"])
			if k == "" {
				k = "card"
			}
			add(&day, k, i64(g["c"]))
		}
		out = append(out, day)
	}
	return out, nil
}

var houseSrc = []struct {
	key     string
	methods []string
}{{"cash", []string{"cash"}}, {"card", []string{"card", "split", "online"}}, {"app", []string{"zelle", "venmo", "cashapp", "paypal", "paypalme"}}}

func houseSrcOf(m string) string {
	for _, s := range houseSrc {
		for _, x := range s.methods {
			if x == m {
				return s.key
			}
		}
	}
	return "card"
}

func (c *C) houseExpected(from, to string) (map[string]int64, []houseDay, error) {
	days, err := c.houseDailyBooks(from, to)
	if err != nil {
		return nil, nil, err
	}
	out := map[string]int64{"cash": 0, "card": 0, "app": 0}
	for _, d := range days {
		for _, m := range d.Order {
			out[houseSrcOf(m)] += d.ByMethod[m]
		}
	}
	tips, err := c.N(`SELECT COALESCE(SUM(cents),0) c FROM tip_payouts WHERE method = 'cash' AND period_to BETWEEN ? AND ?`, from, to)
	if err != nil {
		return nil, nil, err
	}
	out["cash"] -= tips
	return out, days, nil
}

func (c *C) houseEventView(e store.Row) (M, error) {
	taken, err := c.houseSeatsTaken(e["id"])
	if err != nil {
		return nil, err
	}
	left := i64(e["capacity"]) - taken
	if left < 0 {
		left = 0
	}
	return M{"id": e["id"], "title": e["title"], "description": e["description"], "startsLocal": e["starts_local"], "endsLocal": e["ends_local"], "priceCents": e["price_cents"], "capacity": e["capacity"], "left": left, "maxPerOrder": e["max_per_order"], "active": truthy(e["active"])}, nil
}

func (c *C) houseSeatsTaken(eid any) (int64, error) {
	return c.N(`SELECT COALESCE(SUM(qty),0) n FROM tickets WHERE event_id = ? AND (status IN ('paid','checked_in') OR (status = 'pending' AND created_at > datetime('now','-30 minutes')))`, eid)
}

func (c *C) houseSendTicket(t, e store.Row, link string) {
	if !emailEnabled() || !truthy(t["email"]) {
		return
	}
	s := c.S()
	q := i64(t["qty"])
	pl := "s"
	if q == 1 {
		pl = ""
	}
	_, _ = emailGuest(str(t["email"]), emailMsg{BusinessName: s["business_name"], Subject: "Your tickets: " + str(e["title"]),
		Message: fmt.Sprintf("Hi %s,\n\nYou're going to %s on %s. %d ticket%s. Show the QR code at the door.", strings.Split(str(t["name"]), " ")[0], str(e["title"]), str(e["starts_local"]), q, pl),
		Link:    link, Accent: s["accent"], Button: "Show my ticket"})
}

func (c *C) houseTellManagers(title, body, u string) {
	c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": title, "body": body, "tag": "house", "url": u}, 0)
}

func (c *C) houseLoc() string {
	if c.Slug() == "main" {
		return ""
	}
	return "?l=" + c.Slug()
}

func (a *App) registerHouse(rt *router) {
	dateOK := func(v string) bool { return deskDateRE.MatchString(v) }

	/* ===== checklists ===== */
	rt.staff("GET /checklists", "staff", func(c *C) error {
		day := c.Q("day")
		if !dateOK(day) {
			day = c.deskToday()
		}
		lists, err := c.houseChecklistsFor(day)
		if err != nil {
			return err
		}
		out := M{"day": day, "lists": lists}
		if c.deskIsMgr() {
			tpls, err := c.All(`SELECT * FROM checklist_templates ORDER BY active DESC, sort, id`)
			if err != nil {
				return err
			}
			for _, t := range tpls {
				t["items"] = deskJList(t["items"])
			}
			out["templates"] = tpls
		}
		return c.JSON(out)
	})
	rt.staff("POST /checklists/{id}/check", "staff", func(c *C) error {
		b, err := c.Body(valid.Ordered(
			"index", valid.Int().Min(0).Max(100),
			"done", valid.Bool(),
			"value", valid.String().Trim().Max(40).Optional(),
			"day", valid.String().Regex(`^\d{4}-\d{2}-\d{2}$`).Optional(),
		))
		if err != nil {
			return err
		}
		today := c.deskToday()
		day := today
		if d := str(b["day"]); d != "" && d <= today {
			day = d
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		t, err := c.One(`SELECT * FROM checklist_templates WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Not found")
		}
		items := deskJList(t["items"])
		idx := i64(b["index"])
		if idx >= int64(len(items)) {
			return bad("Bad item")
		}
		if _, err := c.Run(`INSERT OR IGNORE INTO checklist_runs (template_id, day) VALUES (?, ?)`, t["id"], day); err != nil {
			return err
		}
		run, err := c.Get(`SELECT * FROM checklist_runs WHERE template_id = ? AND day = ?`, t["id"], day)
		if err != nil {
			return err
		}
		done := deskJObj(run["done"])
		key := fmt.Sprint(idx)
		if b["done"] == true {
			done[key] = M{"by": strings.Split(c.U.Name, " ")[0], "at": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "value": orNil(b["value"])}
		} else {
			delete(done, key)
		}
		complete := true
		for i := range items {
			if !truthy(done[fmt.Sprint(i)]) {
				complete = false
			}
		}
		var at, by any
		if complete {
			at = orNil(run["completed_at"])
			if at == nil {
				at = store.Now()
			}
			by = c.U.ID
		}
		if _, err := c.Run(`UPDATE checklist_runs SET done = ?, completed_at = ?, completed_by = ? WHERE id = ?`, deskJSON(done), at, by, run["id"]); err != nil {
			return err
		}
		if complete && !truthy(run["completed_at"]) {
			if err := c.Audit("checklist.done", str(t["name"])+" "+day); err != nil {
				return err
			}
		}
		c.Notify("checklists")
		return c.JSON(M{"ok": true, "complete": complete})
	})
	tplSchema := valid.Ordered(
		"name", valid.String().Trim().Min(1).Max(60),
		"kind", valid.Enum("open", "close", "daily", "weekly"),
		"dow", valid.Int().Min(0).Max(6).Nullable().Optional(),
		"dueTime", valid.String().Regex(`^(\d{2}:\d{2})?$`).Optional(),
		"items", valid.Array(valid.Ordered("text", valid.String().Trim().Min(1).Max(120), "needsValue", valid.Bool().Optional())).Min(1).Max(60),
		"active", valid.Bool().Optional(),
		"area", valid.String().Trim().Max(24).Nullable().Optional(),
	)
	tplDow := func(b valid.M) any {
		if str(b["kind"]) != "weekly" {
			return nil
		}
		if b["dow"] == nil {
			return int64(1)
		}
		return b["dow"]
	}
	rt.staff("POST /checklist-templates", "manager", func(c *C) error {
		b, err := c.Body(tplSchema)
		if err != nil {
			return err
		}
		r, err := c.Run(`INSERT INTO checklist_templates (name, kind, dow, due_time, items, area) VALUES (?,?,?,?,?,?)`, b["name"], b["kind"], tplDow(b), orNil(b["dueTime"]), deskJSON(b["items"]), orNil(b["area"]))
		if err != nil {
			return err
		}
		if err := c.Audit("checklist.create", str(b["name"])); err != nil {
			return err
		}
		c.Notify("checklists")
		return c.JSON(M{"id": r.LastID})
	})
	rt.staff("PUT /checklist-templates/{id}", "manager", func(c *C) error {
		b, err := c.Body(tplSchema)
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
		if _, err := c.Run(`UPDATE checklist_templates SET name=?, kind=?, dow=?, due_time=?, items=?, active=COALESCE(?, active), area=? WHERE id=?`, b["name"], b["kind"], tplDow(b), orNil(b["dueTime"]), deskJSON(b["items"]), act, orNil(b["area"]), id); err != nil {
			return err
		}
		c.Notify("checklists")
		return c.OK()
	})
	rt.staff("POST /checklist-templates/starter", "manager", func(c *C) error {
		if r, err := c.One(`SELECT 1 FROM checklist_templates`); err != nil {
			return err
		} else if r != nil {
			return conflict("You already have checklists")
		}
		typ := c.S()["business_type"]
		food := typ == "restaurant" || typ == "cafe" || typ == "bar" || typ == "food_truck" || (typ != "salon" && typ != "clinic" && typ != "service")
		type set struct {
			name, kind, due string
			items           []string
		}
		var sets []set
		if food {
			sets = []set{
				{"Opening", "open", "10:30", []string{"Turn on equipment and check it works", "Check fridge and freezer temperatures", "Wash hands station stocked (soap, towels)", "Sanitizer buckets made at the right strength", "Prep list checked and started", "Dining room clean, tables set", "Restrooms clean and stocked", "Count the cash drawer"}},
				{"Closing", "close", "23:30", []string{"Food labeled, dated and stored", "Fridge and freezer temperatures checked", "Surfaces cleaned and sanitized", "Floors swept and mopped", "Trash and recycling out", "Equipment off and cleaned", "Cash drawer counted and closed", "Doors locked and alarm set"}},
				{"Weekly deep clean", "weekly", "", []string{"Clean behind and under equipment", "Descale coffee and ice machines", "Clean hood filters", "Check pest traps", "Check fire extinguisher and first aid kit"}},
			}
		} else {
			sets = []set{
				{"Opening", "open", "09:00", []string{"Lights, music and signage on", "Stations clean and sanitized", "Tools and supplies restocked", "Check today’s bookings", "Restroom clean and stocked", "Count the cash drawer"}},
				{"Closing", "close", "20:30", []string{"Stations cleaned and sanitized", "Tools cleaned or sterilized", "Laundry started", "Trash out", "Cash drawer counted and closed", "Doors locked and alarm set"}},
			}
		}
		tempRE := regexp.MustCompile(`(?i)temperature`)
		for _, st := range sets {
			items := []M{}
			for _, t := range st.items {
				items = append(items, M{"text": t, "needsValue": tempRE.MatchString(t)})
			}
			var d any
			if st.kind == "weekly" {
				d = 1
			}
			if _, err := c.Run(`INSERT INTO checklist_templates (name, kind, dow, due_time, items) VALUES (?,?,?,?,?)`, st.name, st.kind, d, orNil(st.due), deskJSON(items)); err != nil {
				return err
			}
		}
		if food {
			if r, err := c.One(`SELECT 1 FROM temp_units`); err != nil {
				return err
			} else if r == nil {
				for _, u := range []struct {
					n    string
					a, b int
				}{{"Walk-in fridge", 33, 41}, {"Reach-in fridge", 33, 41}, {"Freezer", -10, 0}} {
					if _, err := c.Run(`INSERT INTO temp_units (name, min_temp, max_temp) VALUES (?,?,?)`, u.n, u.a, u.b); err != nil {
						return err
					}
				}
			}
		}
		if err := c.Audit("checklist.starter", typ); err != nil {
			return err
		}
		c.Notify("checklists")
		return c.OK()
	})

	/* ===== temperature logs ===== */
	rt.staff("GET /temps", "staff", func(c *C) error {
		units, err := c.All(`SELECT * FROM temp_units WHERE active = 1 ORDER BY id`)
		if err != nil {
			return err
		}
		for _, u := range units {
			last, err := c.One(`SELECT l.*, us.name by_name FROM temp_logs l LEFT JOIN users us ON us.id = l.user_id WHERE l.unit_id = ? ORDER BY l.id DESC LIMIT 1`, u["id"])
			if err != nil {
				return err
			}
			today, err := c.All(`SELECT value, ok, at FROM temp_logs WHERE unit_id = ? AND localdate(at) = localtoday() ORDER BY id`, u["id"])
			if err != nil {
				return err
			}
			if last == nil {
				u["last"] = nil
			} else {
				u["last"] = last
			}
			u["today"] = today
		}
		return c.JSON(M{"units": units})
	})
	rt.staff("POST /temps/{unitId}", "staff", func(c *C) error {
		b, err := c.Body(valid.Ordered(
			"value", valid.Number().Min(-60).Max(250),
			"note", valid.String().Trim().Max(120).Optional(),
			"corrective", valid.String().Trim().Max(200).Optional(),
		))
		if err != nil {
			return err
		}
		uid := deskNum(c.Param("unitId"))
		u, err := c.One(`SELECT * FROM temp_units WHERE id = ? AND active = 1`, int64(uid))
		if err != nil {
			return err
		}
		if u == nil || math.IsNaN(uid) || uid != math.Trunc(uid) {
			return notFound("Not found")
		}
		v := f64(b["value"])
		mn, mx, sc := f64(u["min_temp"]), f64(u["max_temp"]), str(u["scale"])
		ok := v >= mn && v <= mx
		corr := str(b["corrective"])
		if !ok && corr == "" {
			return failX(400, fmt.Sprintf("%s°%s is outside %s–%s°%s. Say what you did about it.", fmtJSNum(v), sc, fmtJSNum(mn), fmtJSNum(mx), sc), M{"needsCorrective": true})
		}
		okN := 0
		if ok {
			okN = 1
		}
		if _, err := c.Run(`INSERT INTO temp_logs (unit_id, value, ok, note, corrective, user_id) VALUES (?,?,?,?,?,?)`, u["id"], v, okN, orNil(b["note"]), orNil(b["corrective"]), c.U.ID); err != nil {
			return err
		}
		if !ok {
			c.houseTellManagers(fmt.Sprintf("%s: %s out of range", c.S()["business_name"], str(u["name"])), fmt.Sprintf("%s logged %s°%s (should be %s–%s). Action: %s", c.U.Name, fmtJSNum(v), sc, fmtJSNum(mn), fmtJSNum(mx), corr), "/checklists")
		}
		tail := ""
		if !ok {
			tail = " OUT OF RANGE"
		}
		if err := c.Audit("temp.log", fmt.Sprintf("%s %s°%s%s", str(u["name"]), fmtJSNum(v), sc, tail)); err != nil {
			return err
		}
		c.Notify("checklists")
		return c.JSON(M{"ok": true, "inRange": ok})
	})
	rt.staff("POST /temp-units", "manager", func(c *C) error {
		b, err := c.Body(valid.Ordered("name", valid.String().Trim().Min(1).Max(40), "min", valid.Number().Min(-60).Max(250), "max", valid.Number().Min(-60).Max(250), "scale", valid.Enum("F", "C")))
		if err != nil {
			return err
		}
		if f64(b["max"]) <= f64(b["min"]) {
			return bad("Max must be above min")
		}
		if _, err := c.Run(`INSERT INTO temp_units (name, min_temp, max_temp, scale) VALUES (?,?,?,?)`, b["name"], f64(b["min"]), f64(b["max"]), b["scale"]); err != nil {
			return err
		}
		c.Notify("checklists")
		return c.OK()
	})
	rt.staff("DELETE /temp-units/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE temp_units SET active = 0 WHERE id = ?`, id); err != nil {
			return err
		}
		c.Notify("checklists")
		return c.OK()
	})
	rt.staff("GET /inspection-log", "manager", func(c *C) error {
		to := c.Q("to")
		if !dateOK(to) {
			to = c.deskToday()
		}
		from := c.Q("from")
		if !dateOK(from) {
			from = addDays(to, -29)
		}
		a0, _ := deskDayBounds(from, c.deskTZ())
		_, z2 := deskDayBounds(to, c.deskTZ())
		temps, err := c.All(`SELECT l.at, l.value, l.ok, l.note, l.corrective, t.name unit, t.scale, t.min_temp, t.max_temp, u.name by_name FROM temp_logs l JOIN temp_units t ON t.id = l.unit_id LEFT JOIN users u ON u.id = l.user_id WHERE l.at >= ? AND l.at < ? ORDER BY l.at`, a0, z2)
		if err != nil {
			return err
		}
		rows, err := c.All(`SELECT r.day, r.done, r.completed_at, t.name, t.items, u.name by_name FROM checklist_runs r JOIN checklist_templates t ON t.id = r.template_id LEFT JOIN users u ON u.id = r.completed_by WHERE r.day BETWEEN ? AND ? ORDER BY r.day, t.sort`, from, to)
		if err != nil {
			return err
		}
		runs := []M{}
		for _, r := range rows {
			items, done := deskJList(r["items"]), deskJObj(r["done"])
			n := 0
			for i := range items {
				if truthy(done[fmt.Sprint(i)]) {
					n++
				}
			}
			runs = append(runs, M{"day": r["day"], "name": r["name"], "completedAt": r["completed_at"], "by": r["by_name"], "done": n, "total": len(items)})
		}
		return c.JSON(M{"from": from, "to": to, "business": c.S()["business_name"], "temps": temps, "runs": runs})
	})

	/* ===== event tickets ===== */
	payOnline := func(c *C) bool {
		v, err := c.G("onlinePayEnabled")
		return err == nil && truthy(v)
	}
	rt.pub("GET /api/public/events", func(c *C) error {
		s := c.S()
		rows, err := c.All(`SELECT * FROM events WHERE active = 1 AND starts_local >= ? ORDER BY starts_local LIMIT 50`, c.deskToday()+" 00:00")
		if err != nil {
			return err
		}
		evs := []M{}
		for _, e := range rows {
			v, err := c.houseEventView(e)
			if err != nil {
				return err
			}
			evs = append(evs, v)
		}
		return c.JSON(M{"business": M{"name": s["business_name"], "accent": s["accent"], "logo": c.logoURL()}, "currency": s["currency"], "payOnline": payOnline(c), "events": evs})
	}, a.publicLim())
	rt.pub("POST /api/public/events/{id}/tickets", func(c *C) error {
		b, err := c.Body(valid.Ordered(
			"name", valid.String().Trim().Min(1).Max(60),
			"email", valid.String().Trim().Email().Max(120),
			"phone", valid.String().Trim().Max(30).Optional(),
			"qty", valid.Int().Min(1).Max(20),
		))
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		e, err := c.One(`SELECT * FROM events WHERE id = ? AND active = 1`, id)
		if err != nil {
			return err
		}
		if e == nil {
			return notFound("This event is not available")
		}
		if str(e["starts_local"]) < c.deskToday()+" 00:00" {
			return conflict("This event has passed")
		}
		qty := i64(b["qty"])
		if qty > i64(e["max_per_order"]) {
			return bad(fmt.Sprintf("Up to %d tickets per order", i64(e["max_per_order"])))
		}
		code := newToken(12)
		taken, err := c.houseSeatsTaken(e["id"])
		if err != nil {
			return err
		}
		if taken+qty > i64(e["capacity"]) {
			left := i64(e["capacity"]) - taken
			if left <= 0 {
				return conflict("Sold out")
			}
			pl := "s"
			if left == 1 {
				pl = ""
			}
			return conflict(fmt.Sprintf("Only %d seat%s left", left, pl))
		}
		price := i64(e["price_cents"])
		status := "paid"
		if price != 0 {
			status = "pending"
		}
		r, err := c.Run(`INSERT INTO tickets (event_id, code, name, email, phone, qty, status) VALUES (?,?,?,?,?,?,?)`, e["id"], code, b["name"], b["email"], orNil(b["phone"]), qty, status)
		if err != nil {
			return err
		}
		tid := r.LastID
		base := c.PublicBase()
		ticketURL := base + "/ticket/" + code + c.houseLoc()
		if price == 0 {
			t, err := c.Get(`SELECT * FROM tickets WHERE id = ?`, tid)
			if err != nil {
				return err
			}
			c.houseSendTicket(t, e, ticketURL)
			c.Notify("events")
			return c.JSON(M{"url": ticketURL})
		}
		if !payOnline(c) {
			if _, err := c.Run(`UPDATE tickets SET status = 'cancelled' WHERE id = ?`, tid); err != nil {
				return err
			}
			return &committedError{HTTPError{Status: 503, Msg: "Online payment is not set up. Contact us for tickets."}}
		}
		pr, err := c.Run(`INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('ticket', ?, 'card', ?, ?)`, price*qty, fmt.Sprintf("%d × %s", qty, str(e["title"])), deskJSON(M{"ticketId": tid}))
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE tickets SET payment_id = ? WHERE id = ?`, pr.LastID, tid); err != nil {
			return err
		}
		pl := "s"
		if qty == 1 {
			pl = ""
		}
		u, err := c.G("startPay", pr.LastID, M{"base": base, "lines": []M{{"name": fmt.Sprintf("%s (%d ticket%s)", str(e["title"]), qty, pl), "cents": price * qty}}, "successUrl": ticketURL, "cancelUrl": base + "/events" + c.houseLoc(), "email": b["email"], "descr": e["title"]})
		if err != nil {
			return err
		}
		if u == nil {
			return fail(500, "Server error")
		}
		return c.JSON(M{"url": u})
	}, a.orderLim())
	a.G["payHooks.ticket"] = func(c *C, args ...any) (any, error) {
		p, _ := args[0].(store.Row)
		if p == nil {
			return nil, nil
		}
		meta := deskJObj(p["meta"])
		t, err := c.One(`SELECT * FROM tickets WHERE id = ?`, i64(meta["ticketId"]))
		if err != nil || t == nil {
			return nil, err
		}
		if _, err := c.Run(`UPDATE tickets SET status = 'paid' WHERE id = ? AND status IN ('pending','cancelled')`, t["id"]); err != nil {
			return nil, err
		}
		e, err := c.Get(`SELECT * FROM events WHERE id = ?`, t["event_id"])
		if err != nil {
			return nil, err
		}
		c.houseSendTicket(t, e, strings.TrimRight(c.a.cfg.PublicURL, "/")+"/ticket/"+str(t["code"])+c.houseLoc())
		if err := c.AuditAs(nil, "ticket.paid", fmt.Sprintf("%d × %s for %s", i64(t["qty"]), str(e["title"]), str(t["name"])), ""); err != nil {
			return nil, err
		}
		c.Notify("events")
		return nil, nil
	}
	ticketCodeRE := regexp.MustCompile(`^[A-Za-z0-9_-]{16}$`)
	rt.pub("GET /api/e/{code}", func(c *C) error {
		code := c.Param("code")
		var t store.Row
		var err error
		if ticketCodeRE.MatchString(code) {
			if t, err = c.One(`SELECT * FROM tickets WHERE code = ?`, code); err != nil {
				return err
			}
		}
		if t == nil {
			return notFound("This ticket link is not valid.")
		}
		e, err := c.Get(`SELECT * FROM events WHERE id = ?`, t["event_id"])
		if err != nil {
			return err
		}
		s := c.S()
		var svg any
		if st := str(t["status"]); st == "paid" || st == "checked_in" {
			q, err := qrSVG("BH-T-"+str(t["code"]), 1, "", "", false)
			if err != nil {
				return err
			}
			svg = q
		}
		return c.JSON(M{"status": t["status"], "name": t["name"], "qty": t["qty"], "checkedIn": t["checked_in"], "event": M{"title": e["title"], "startsLocal": e["starts_local"], "endsLocal": e["ends_local"], "description": e["description"]},
			"business": M{"name": s["business_name"], "accent": s["accent"], "address": s["business_address"]}, "svg": svg})
	}, a.publicLim())
	evSchema := valid.Ordered(
		"title", valid.String().Trim().Min(1).Max(80),
		"description", valid.String().Trim().Max(600).Optional(),
		"startsLocal", valid.String().Regex(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$`),
		"endsLocal", valid.String().Regex(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$`).Optional().Or(valid.Literal("")),
		"capacity", valid.Int().Min(1).Max(10000),
		"priceCents", valid.Int().Min(0).Max(1000000),
		"maxPerOrder", valid.Int().Min(1).Max(50).Default(6),
		"active", valid.Bool().Optional(),
	)
	rt.staff("GET /events", "manager", func(c *C) error {
		rows, err := c.All(`SELECT * FROM events ORDER BY starts_local DESC LIMIT 100`)
		if err != nil {
			return err
		}
		evs := []M{}
		for _, e := range rows {
			v, err := c.houseEventView(e)
			if err != nil {
				return err
			}
			if v["sold"], err = c.N(`SELECT COALESCE(SUM(qty),0) n FROM tickets WHERE event_id = ? AND status IN ('paid','checked_in')`, e["id"]); err != nil {
				return err
			}
			if v["checkedIn"], err = c.N(`SELECT COALESCE(SUM(checked_in),0) n FROM tickets WHERE event_id = ?`, e["id"]); err != nil {
				return err
			}
			evs = append(evs, v)
		}
		return c.JSON(M{"events": evs, "link": c.PublicBase() + "/events" + c.houseLoc()})
	})
	rt.staff("POST /events", "manager", func(c *C) error {
		b, err := c.Body(evSchema)
		if err != nil {
			return err
		}
		r, err := c.Run(`INSERT INTO events (title, description, starts_local, ends_local, capacity, price_cents, max_per_order) VALUES (?,?,?,?,?,?,?)`, b["title"], orNil(b["description"]), b["startsLocal"], orNil(b["endsLocal"]), b["capacity"], b["priceCents"], b["maxPerOrder"])
		if err != nil {
			return err
		}
		if err := c.Audit("event.create", str(b["title"])); err != nil {
			return err
		}
		c.Notify("events")
		return c.JSON(M{"id": r.LastID})
	})
	rt.staff("PUT /events/{id}", "manager", func(c *C) error {
		b, err := c.Body(evSchema)
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
		if _, err := c.Run(`UPDATE events SET title=?, description=?, starts_local=?, ends_local=?, capacity=?, price_cents=?, max_per_order=?, active=COALESCE(?, active) WHERE id=?`, b["title"], orNil(b["description"]), b["startsLocal"], orNil(b["endsLocal"]), b["capacity"], b["priceCents"], b["maxPerOrder"], act, id); err != nil {
			return err
		}
		c.Notify("events")
		return c.OK()
	})
	rt.staff("GET /events/{id}/attendees", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		rows, err := c.All(`SELECT id, name, email, phone, qty, status, checked_in, checked_in_at FROM tickets WHERE event_id = ? AND status <> 'cancelled' AND (status <> 'pending' OR created_at > datetime('now','-30 minutes')) ORDER BY name COLLATE "C"`, id)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
	rt.staff("POST /tickets/checkin", "staff", func(c *C) error {
		b, err := c.Body(valid.Ordered("code", valid.String().Trim().Max(40).Optional(), "ticketId", valid.Int().Optional(), "count", valid.Int().Min(1).Max(50).Optional()))
		if err != nil {
			return err
		}
		code := strings.TrimPrefix(str(b["code"]), "BH-T-")
		var t store.Row
		if truthy(b["ticketId"]) {
			t, err = c.One(`SELECT * FROM tickets WHERE id = ?`, b["ticketId"])
		} else {
			t, err = c.One(`SELECT * FROM tickets WHERE code = ?`, code)
		}
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Ticket not found")
		}
		st := str(t["status"])
		if st != "paid" && st != "checked_in" {
			if st == "pending" {
				return conflict("This ticket was not paid")
			}
			return conflict("This ticket was cancelled")
		}
		qty, in := i64(t["qty"]), i64(t["checked_in"])
		rem := qty - in
		add := rem
		if n := i64(b["count"]); n != 0 && n < rem {
			add = n
		}
		if add <= 0 {
			return conflict(fmt.Sprintf("Already checked in (%d of %d)", qty, qty))
		}
		if _, err := c.Run(`UPDATE tickets SET checked_in = checked_in + ?, status = 'checked_in', checked_in_at = datetime('now') WHERE id = ?`, add, t["id"]); err != nil {
			return err
		}
		title, err := c.Val(`SELECT title FROM events WHERE id = ?`, t["event_id"])
		if err != nil {
			return err
		}
		if err := c.Audit("ticket.checkin", fmt.Sprintf("%s ×%d %s", str(t["name"]), add, str(title))); err != nil {
			return err
		}
		c.Notify("events")
		return c.JSON(M{"name": t["name"], "event": title, "checkedIn": in + add, "qty": qty})
	})
	rt.staff("POST /tickets/{id}/cancel", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		t, err := c.One(`SELECT * FROM tickets WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if t == nil {
			return notFound("Not found")
		}
		if _, err := c.Run(`UPDATE tickets SET status = 'cancelled' WHERE id = ?`, t["id"]); err != nil {
			return err
		}
		refund := "none"
		if truthy(t["payment_id"]) {
			p, err := c.One(`SELECT * FROM payments WHERE id = ?`, t["payment_id"])
			if err != nil {
				return err
			}
			if p != nil && str(p["status"]) == "paid" && truthy(p["refund_ref"]) {
				if r, err := c.G("refundRef", p["refund_ref"], p["amount_cents"]); err != nil || !truthy(r) {
					refund = "manual"
				} else {
					refund = str(r)
				}
			}
		}
		if err := c.Audit("ticket.cancel", fmt.Sprintf("%s (%s)", str(t["name"]), refund)); err != nil {
			return err
		}
		c.Notify("events")
		return c.JSON(M{"ok": true, "refund": refund})
	})

	/* ===== bank deposit matching ===== */
	rt.staff("GET /deposits", "owner", func(c *C) error {
		to := c.Q("to")
		if !dateOK(to) {
			to = addDays(c.deskToday(), -1)
		}
		from := c.Q("from")
		if !dateOK(from) {
			from = addDays(to, -13)
		}
		deps, err := c.All(`SELECT * FROM bank_deposits WHERE cover_to >= ? AND cover_from <= ? ORDER BY deposit_date DESC`, from, to)
		if err != nil {
			return err
		}
		s := c.S()
		feePct := map[string]float64{"cash": 0, "card": deskFeeRate(s, "card", 2.6), "app": deskFeeRate(s, "venmo", 1.9)}
		list := []M{}
		for _, d := range deps {
			tot, _, err := c.houseExpected(str(d["cover_from"]), str(d["cover_to"]))
			if err != nil {
				return err
			}
			src := str(d["source"])
			ex := tot[src]
			fees := roundJS(float64(ex) * feePct[src] / 100)
			df := i64(d["amount_cents"]) - ex
			m := M{}
			for k, v := range d {
				m[k] = v
			}
			tol := roundJS(float64(ex) * 0.01)
			if tol < 500 {
				tol = 500
			}
			un := df + fees
			m["expectedCents"], m["estFeesCents"], m["diffCents"], m["unexplainedCents"], m["matched"] = ex, fees, df, un, un <= tol && -un <= tol
			list = append(list, m)
		}
		_, days, err := c.houseExpected(from, to)
		if err != nil {
			return err
		}
		rows := []M{}
		for _, d := range days {
			by := map[string]int64{"cash": 0, "card": 0, "app": 0}
			for _, m := range d.Order {
				by[houseSrcOf(m)] += d.ByMethod[m]
			}
			cov := M{}
			for _, k := range []string{"cash", "card", "app"} {
				has := false
				for _, x := range deps {
					if str(x["source"]) == k && str(x["cover_from"]) <= d.Date && str(x["cover_to"]) >= d.Date {
						has = true
					}
				}
				cov[k] = has
			}
			rows = append(rows, M{"date": d.Date, "cashCents": by["cash"], "cardCents": by["card"], "appCents": by["app"], "covered": cov})
		}
		sq, _ := c.G("squareOn")
		return c.JSON(M{"from": from, "to": to, "deposits": list, "days": rows, "providers": M{"stripe": houseStripeEnabled(), "square": truthy(sq)}})
	})
	rt.staff("POST /deposits", "owner", func(c *C) error {
		d := `^\d{4}-\d{2}-\d{2}$`
		b, err := c.Body(valid.Ordered(
			"source", valid.Enum("cash", "card", "app"),
			"amountCents", valid.Int().Min(1).Max(1e9),
			"depositDate", valid.String().Regex(d),
			"coverFrom", valid.String().Regex(d),
			"coverTo", valid.String().Regex(d),
			"reference", valid.String().Trim().Max(60).Optional(),
			"note", valid.String().Trim().Max(200).Optional(),
		))
		if err != nil {
			return err
		}
		if str(b["coverTo"]) < str(b["coverFrom"]) {
			return bad("The last sales day is before the first")
		}
		if _, err := c.Run(`INSERT INTO bank_deposits (source, amount_cents, deposit_date, cover_from, cover_to, reference, note, created_by) VALUES (?,?,?,?,?,?,?,?)`, b["source"], b["amountCents"], b["depositDate"], b["coverFrom"], b["coverTo"], orNil(b["reference"]), orNil(b["note"]), c.U.ID); err != nil {
			return err
		}
		if err := c.Audit("deposit.add", fmt.Sprintf("%s %s for %s..%s", str(b["source"]), deskFmt(i64(b["amountCents"])), str(b["coverFrom"]), str(b["coverTo"]))); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("DELETE /deposits/{id}", "owner", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM bank_deposits WHERE id = ?`, id); err != nil {
			return err
		}
		if err := c.Audit("deposit.delete", "#"+c.Param("id")); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("POST /deposits/import", "owner", func(c *C) error {
		var added int64
		notes := []string{}
		ins := func(amount any, d, from, to, ref, note, ext string) error {
			r, err := c.Run(`INSERT OR IGNORE INTO bank_deposits (source, amount_cents, deposit_date, cover_from, cover_to, reference, note, external_id, created_by) VALUES ('card', ?, ?, ?, ?, ?, ?, ?, ?)`, amount, d, from, to, ref, note, ext, c.U.ID)
			added += r.Changes
			return err
		}
		errMsg := func(err error) string {
			var he *HTTPError
			if errors.As(err, &he) {
				return he.Msg
			}
			return err.Error()
		}
		loc := loadTZ(c.deskTZ())
		if houseStripeEnabled() {
			r, err := houseStripe("GET", "/payouts?limit=30", nil)
			if err != nil {
				notes = append(notes, "Stripe: "+errMsg(err))
			}
			data, _ := r["data"].([]any)
			for _, x := range data {
				p, _ := x.(map[string]any)
				if st := str(p["status"]); st != "paid" && st != "in_transit" {
					continue
				}
				d := time.Unix(int64(f64(p["arrival_date"])), 0).In(loc).Format("2006-01-02")
				if err := ins(int64(f64(p["amount"])), d, addDays(d, -2), addDays(d, -1), str(p["id"]), "Stripe payout", "stripe:"+str(p["id"])); err != nil {
					return err
				}
			}
		}
		if on, _ := c.G("squareOn"); truthy(on) && c.Has("squareGet") {
			r, err := c.G("squareGet", "/v2/payouts?location_id="+os.Getenv("SQUARE_LOCATION_ID")+"&limit=30")
			if err != nil {
				notes = append(notes, "Square: "+errMsg(err))
			}
			m, _ := r.(map[string]any)
			pays, _ := m["payouts"].([]any)
			for _, x := range pays {
				p, _ := x.(map[string]any)
				if st := str(p["status"]); st != "SENT" && st != "PAID" {
					continue
				}
				d := str(p["arrival_date"])
				if d == "" {
					d = str(p["created_at"])
				}
				if len(d) > 10 {
					d = d[:10]
				}
				if d == "" {
					continue
				}
				amt, _ := p["amount_money"].(map[string]any)
				if err := ins(int64(deskNum(amt["amount"])), d, addDays(d, -1), addDays(d, -1), str(p["id"]), "Square payout", "square:"+str(p["id"])); err != nil {
					return err
				}
			}
		}
		if err := c.Audit("deposit.import", fmt.Sprintf("%d payouts", added)); err != nil {
			return err
		}
		return c.JSON(M{"added": added, "notes": notes})
	})

	/* ===== menu engineering + prep list ===== */
	rt.staff("GET /menu-engineering", "manager", func(c *C) error {
		r, err := c.houseMenuEngineering(int(math.Min(180, math.Max(7, deskOr(c.Q("days"), 30)))))
		if err != nil {
			return err
		}
		return c.JSON(r)
	})
	rt.staff("GET /prep", "staff", func(c *C) error {
		d := c.Q("date")
		if !dateOK(d) {
			d = addDays(c.deskToday(), 1)
		}
		r, err := c.housePrepList(d)
		if err != nil {
			return err
		}
		return c.JSON(r)
	})

	/* ===== jobs: overdue checklists, expired pending tickets ===== */
	a.every("house-checklists", 10*time.Minute, func(c *C) error {
		today := c.deskToday()
		lists, err := c.houseChecklistsFor(today)
		if err != nil {
			return err
		}
		for _, l := range lists {
			if l["overdue"] != true {
				continue
			}
			first, err := c.deskOnce("house_alerts", fmt.Sprintf("cl:%v:%s", l["id"], today))
			if err != nil {
				return err
			}
			if first {
				c.houseTellManagers(c.S()["business_name"]+": checklist overdue", fmt.Sprintf("%s was due at %s. %d of %d done.", str(l["name"]), str(l["dueTime"]), l["count"], l["total"]), "/checklists")
			}
		}
		_, err = c.Run(`UPDATE tickets SET status = 'cancelled' WHERE status = 'pending' AND created_at < datetime('now','-45 minutes')`)
		return err
	})
}
