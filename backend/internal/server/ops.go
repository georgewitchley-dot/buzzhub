package server

import (
	"fmt"
	"math"
	"regexp"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of ops.js: kitchen display, end-of-day report + CSV, cash drawer, shifts (lock-screen
// clock in/out), schedule and wages.

func init() { modules = append(modules, (*App).registerOps) }

/* ---------- time helpers (business timezone) ---------- */

// opsTZ is currentTz(): the location's timezone setting.
func opsTZ(c *C) string {
	if tz := c.S()["timezone"]; tz != "" {
		return tz
	}
	return "America/New_York"
}

// opsToday is localToday().
func opsToday(c *C) string { return localNow(opsTZ(c)).Date }

const opsSQLTime = "2006-01-02 15:04:05"

func opsFmtSQL(t time.Time) string { return t.UTC().Format(opsSQLTime) }

// opsDayBounds returns the UTC 'YYYY-MM-DD HH:MM:SS' bounds of a local business day.
func opsDayBounds(date, tz string) (string, string) {
	d, err := time.Parse("2006-01-02", date)
	if err != nil {
		d = time.Now().UTC().Truncate(24 * time.Hour)
	}
	_, off := d.Add(12 * time.Hour).In(loadTZ(tz)).Zone()
	start := d.Add(-time.Duration(off) * time.Second)
	return opsFmtSQL(start), opsFmtSQL(start.Add(24 * time.Hour))
}

// opsMs is Date.parse(`${ts.replace(' ', 'T')}Z`) in milliseconds (NaN → 0).
func opsMs(ts string) int64 {
	ts = strings.Replace(ts, " ", "T", 1)
	for _, f := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.Parse(f, strings.TrimSuffix(ts, "Z")); err == nil {
			return t.UnixMilli()
		}
	}
	return 0
}

// opsHoursBetween: hours from a to b (b nil/"" = now), never negative.
func opsHoursBetween(a string, b any) float64 {
	end := nowMs()
	if s := str(b); s != "" {
		end = opsMs(s)
	}
	return math.Max(0, float64(end-opsMs(a))/3600000)
}

func opsLocalHour(ts, tz string) int {
	return time.UnixMilli(opsMs(ts)).In(loadTZ(tz)).Hour()
}

// opsNumber is Number(setting || def): a float, or nil for NaN.
func opsNumber(v string, def float64) any {
	if v == "" {
		return def
	}
	f, ok := jsNumber(v)
	if !ok {
		return nil
	}
	return f
}

func opsCopy(r store.Row) M {
	out := M{}
	for k, v := range r {
		out[k] = v
	}
	return out
}

var opsDateRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func (c *C) opsDateQ(name string) string {
	if q := c.Q(name); opsDateRE.MatchString(q) {
		return q
	}
	return opsToday(c)
}

/* ---------- cash drawer ---------- */

func (c *C) opsCashSummary(cs store.Row) (M, error) {
	cashSales, err := c.N(`SELECT COALESCE(SUM(total_cents),0) c FROM orders WHERE paid_at IS NOT NULL AND status <> 'void' AND payment_method='cash' AND paid_at >= ? AND paid_at < COALESCE(?, datetime('now','+1 second'))`, cs["opened_at"], cs["closed_at"])
	if err != nil {
		return nil, err
	}
	moves, err := c.All(`SELECT m.*, u.name user_name FROM cash_moves m LEFT JOIN users u ON u.id = m.user_id WHERE session_id = ? ORDER BY id`, cs["id"])
	if err != nil {
		return nil, err
	}
	var ins, outs int64
	for _, m := range moves {
		if str(m["kind"]) == "in" {
			ins += i64(m["amount_cents"])
		} else if str(m["kind"]) == "out" {
			outs += i64(m["amount_cents"])
		}
	}
	cashRefunds, err := c.N(`SELECT COALESCE(SUM(amount_cents),0) c FROM refunds WHERE method='cash' AND at >= ? AND at < COALESCE(?, datetime('now','+1 second'))`, cs["opened_at"], cs["closed_at"])
	if err != nil {
		return nil, err
	}
	expected := i64(cs["opening_cents"]) + cashSales + ins - outs - cashRefunds
	names, err := c.All(`SELECT id, name FROM users WHERE id IN (?, ?)`, i64(cs["opened_by"]), i64(cs["closed_by"]))
	if err != nil {
		return nil, err
	}
	nm := func(id any) any {
		if id == nil {
			return nil
		}
		for _, n := range names {
			if i64(n["id"]) == i64(id) {
				return n["name"]
			}
		}
		return nil
	}
	out := opsCopy(cs)
	out["openedByName"], out["closedByName"] = nm(cs["opened_by"]), nm(cs["closed_by"])
	out["cashSalesCents"], out["paidInCents"], out["paidOutCents"], out["moves"] = cashSales, ins, outs, moves
	if truthy(cs["closed_at"]) {
		out["expectedCents"] = cs["expected_cents"]
		out["varianceCents"] = i64(cs["counted_cents"]) - i64(cs["expected_cents"])
	} else {
		out["expectedCents"] = expected
		out["varianceCents"] = nil
	}
	return out, nil
}

func (c *C) opsOpenSession() (store.Row, error) {
	return c.One(`SELECT * FROM cash_sessions WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1`)
}

/* ---------- end-of-day report ---------- */

func (c *C) opsDayReport(date string) (M, error) {
	tz := opsTZ(c)
	start, end := opsDayBounds(date, tz)
	paid, err := c.All(`SELECT * FROM orders WHERE paid_at IS NOT NULL AND status <> 'void' AND paid_at >= ? AND paid_at < ?`, start, end)
	if err != nil {
		return nil, err
	}
	voids, err := c.All(`SELECT * FROM orders WHERE status = 'void' AND created_at >= ? AND created_at < ?`, start, end)
	if err != nil {
		return nil, err
	}
	sum := func(arr []store.Row, k string) int64 {
		var t int64
		for _, o := range arr {
			t += i64(o[k])
		}
		return t
	}
	byMethod := M{}
	for _, o := range paid {
		m := str(o["payment_method"])
		if m == "" {
			m = "other"
		}
		bm, _ := byMethod[m].(M)
		if bm == nil {
			bm = M{"count": int64(0), "cents": int64(0), "tips": int64(0)}
			byMethod[m] = bm
		}
		bm["count"] = i64(bm["count"]) + 1
		bm["cents"] = i64(bm["cents"]) + i64(o["total_cents"])
		bm["tips"] = i64(bm["tips"]) + i64(o["tip_cents"])
	}
	hourly := make([]int64, 24)
	idList := []string{}
	for _, o := range paid {
		hourly[opsLocalHour(str(o["paid_at"]), tz)] += i64(o["total_cents"])
		idList = append(idList, itoa(i64(o["id"])))
	}
	ids := strings.Join(idList, ",")
	if ids == "" {
		ids = "0"
	}
	items, err := c.All(`SELECT name, SUM(qty) qty, SUM(qty * price_cents) cents FROM order_items WHERE order_id IN (` + ids + `) GROUP BY name ORDER BY cents DESC`)
	if err != nil {
		return nil, err
	}
	byStaff, err := c.All(`SELECT COALESCE(u.name, 'Guest order') name, COUNT(*) orders, SUM(o.total_cents) cents, SUM(o.tip_cents) tips FROM orders o LEFT JOIN users u ON u.id = o.created_by WHERE o.id IN (` + ids + `) GROUP BY o.created_by, u.name ORDER BY cents DESC`)
	if err != nil {
		return nil, err
	}
	guests, err := c.All(`SELECT status, COUNT(*) c, SUM(party_size) covers FROM guests WHERE created_at >= ? AND created_at < ? GROUP BY status`, start, end)
	if err != nil {
		return nil, err
	}
	avgWait, err := c.Val(`SELECT AVG((julianday(seated_at) - julianday(created_at)) * 1440) m FROM guests WHERE seated_at IS NOT NULL AND created_at >= ? AND created_at < ?`, start, end)
	if err != nil {
		return nil, err
	}
	bookings, err := c.All(`SELECT status, COUNT(*) c FROM bookings WHERE substr(start_local,1,10) = ? GROUP BY status`, date)
	if err != nil {
		return nil, err
	}
	shifts, err := c.All(`SELECT s.*, u.name, u.hourly_cents FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in < ? AND (s.clock_out IS NULL OR s.clock_out >= ?)`, end, start)
	if err != nil {
		return nil, err
	}
	labor := []M{}
	var laborCents int64
	for _, s := range shifts {
		in := str(s["clock_in"])
		if in < start {
			in = start
		}
		var out any
		if co := str(s["clock_out"]); co != "" {
			if co < end {
				out = co
			} else {
				out = end
			}
		}
		hrs := math.Max(0, opsHoursBetween(in, out)-f64(s["break_minutes"])/60)
		cents := roundJS(hrs * f64(s["hourly_cents"]))
		laborCents += cents
		labor = append(labor, M{"name": s["name"], "hours": hrs, "cents": cents})
	}
	cash, err := c.All(`SELECT * FROM cash_sessions WHERE opened_at >= ? AND opened_at < ? ORDER BY id`, start, end)
	if err != nil {
		return nil, err
	}
	cashOut := []M{}
	for _, cs := range cash {
		v, err := c.opsCashSummary(cs)
		if err != nil {
			return nil, err
		}
		cashOut = append(cashOut, v)
	}
	refunds, err := c.All(`SELECT r.*, o.number FROM refunds r JOIN orders o ON o.id = r.order_id WHERE r.at >= ? AND r.at < ?`, start, end)
	if err != nil {
		return nil, err
	}
	var refundCents int64
	refundList := []M{}
	for _, r := range refunds {
		refundCents += i64(r["amount_cents"])
		refundList = append(refundList, M{"number": r["number"], "cents": r["amount_cents"], "reason": r["reason"]})
	}
	gross := sum(paid, "subtotal_cents")
	var avgTicket int64
	if len(paid) > 0 {
		avgTicket = roundJS(float64(sum(paid, "total_cents")) / float64(len(paid)))
	}
	laborPct := 0.0
	if gross != 0 {
		laborPct = float64(roundJS(float64(laborCents)/float64(gross)*1000)) / 10
	}
	gOut := M{}
	for _, g := range guests {
		gOut[str(g["status"])] = M{"count": g["c"], "covers": g["covers"]}
	}
	bOut := M{}
	for _, b := range bookings {
		bOut[str(b["status"])] = b["c"]
	}
	var aw int64
	if f := f64(avgWait); avgWait != nil && f != 0 {
		aw = roundJS(f)
	}
	return M{
		"date": date, "generatedAt": store.Now(),
		"totals": M{"orders": len(paid), "grossCents": gross, "discountCents": sum(paid, "discount_cents"), "taxCents": sum(paid, "tax_cents"), "tipsCents": sum(paid, "tip_cents"),
			"netCents": gross - sum(paid, "discount_cents"), "collectedCents": sum(paid, "total_cents"), "avgTicketCents": avgTicket,
			"voids": len(voids), "voidCents": sum(voids, "total_cents"), "refunds": len(refunds), "refundCents": refundCents, "laborCents": laborCents, "laborPct": laborPct},
		"byMethod": byMethod, "hourly": hourly, "items": items, "byStaff": byStaff, "labor": labor, "refundList": refundList,
		"guests": gOut, "avgWait": aw, "bookings": bOut, "cash": cashOut,
	}, nil
}

var opsCSVNeedsQuote = regexp.MustCompile(`[",\n]`)
var opsCSVFormula = regexp.MustCompile(`^[=+\-@]`)

// opsCSVEsc is the end-of-day CSV cell escaper (quote, and neutralise formulas).
func opsCSVEsc(v any) string {
	s := ""
	if v != nil {
		s = str(v)
	}
	if opsCSVNeedsQuote.MatchString(s) || opsCSVFormula.MatchString(s) {
		s = opsCSVFormula.ReplaceAllString(s, "'$0")
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

/* ---------- registration ---------- */

func (a *App) registerOps(rt *router) {
	/* ================= Kitchen display ================= */
	rt.staff("GET /kitchen", "staff", func(c *C) error {
		orders, err := c.All(`SELECT o.id, o.number, o.status, o.source, o.customer_name, o.sent_at, o.ready_at, o.created_at, o.fulfillment, o.delivery_address, o.order_notes, o.prepaid, o.allergy_note, t.label table_label, g.name guest_name,
        (SELECT c.tags FROM customers c WHERE c.id = COALESCE(o.customer_id, g.customer_id)) customer_tags
      FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN guests g ON g.id = o.guest_id
      WHERE o.status IN ('open','sent') OR (o.status IN ('ready','paid') AND o.ready_at > datetime('now','-10 minutes'))
      ORDER BY CASE WHEN o.status IN ('open','sent') THEN 0 ELSE 1 END, COALESCE(o.sent_at, o.created_at)`)
		if err != nil {
			return err
		}
		var items []store.Row
		if len(orders) > 0 {
			ids := []string{}
			for _, o := range orders {
				ids = append(ids, itoa(i64(o["id"])))
			}
			items, err = c.All(`SELECT oi.id, oi.order_id, oi.item_id, oi.name, oi.qty, oi.note, oi.mods, oi.course, oi.fired_at, oi.done_at, m.category FROM order_items oi LEFT JOIN menu_items m ON m.id = oi.item_id WHERE oi.order_id IN (` + strings.Join(ids, ",") + `)`)
			if err != nil {
				return err
			}
		}
		held, err := c.N(`SELECT COUNT(*) c FROM orders WHERE status = 'held'`)
		if err != nil {
			return err
		}
		out := []M{}
		for _, o := range orders {
			v := opsCopy(o)
			its := []M{}
			for _, i := range items {
				if i64(i["order_id"]) == i64(o["id"]) {
					iv := opsCopy(i)
					mods := str(i["mods"])
					if mods == "" {
						mods = "[]"
					}
					iv["mods"] = jparse(mods, []any{})
					its = append(its, iv)
				}
			}
			v["items"] = its
			out = append(out, v)
		}
		return c.JSON(M{"orders": out, "held": held, "lateMinutes": opsNumber(c.S()["kds_late_minutes"], 12)})
	})
	rt.staff("POST /kitchen/{id}/recall", "staff", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		o, err := c.One(`SELECT * FROM orders WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if o == nil || str(o["status"]) != "ready" {
			return conflict("Only ready orders can be recalled")
		}
		if _, err := c.Run(`UPDATE orders SET status = 'sent', ready_at = NULL WHERE id = ?`, o["id"]); err != nil {
			return err
		}
		if err := c.Audit("order.recall", fmt.Sprintf("#%v", o["number"])); err != nil {
			return err
		}
		c.Notify("orders")
		return c.OK()
	})

	/* ================= End-of-day report ================= */
	rt.staff("GET /reports/day", "manager", func(c *C) error {
		r, err := c.opsDayReport(c.opsDateQ("date"))
		if err != nil {
			return err
		}
		return c.JSON(r)
	})
	rt.staff("GET /reports/day.csv", "manager", func(c *C) error {
		date := c.opsDateQ("date")
		r, err := c.opsDayReport(date)
		if err != nil {
			return err
		}
		start, end := opsDayBounds(date, opsTZ(c))
		rows, err := c.All(`SELECT o.number, o.paid_at, o.status, o.payment_method, o.subtotal_cents, o.discount_cents, o.tax_cents, o.tip_cents, o.total_cents, COALESCE(u.name,'Guest') staff, t.label table_label
      FROM orders o LEFT JOIN users u ON u.id=o.created_by LEFT JOIN tables t ON t.id=o.table_id WHERE (o.paid_at >= ? AND o.paid_at < ?) OR (o.status='void' AND o.created_at >= ? AND o.created_at < ?) ORDER BY o.id`, start, end, start, end)
		if err != nil {
			return err
		}
		d := func(v any) string { return dollars(i64(v)) }
		lines := []string{"Order,Paid at (UTC),Status,Method,Subtotal,Discount,Tax,Tip,Total,Staff,Table"}
		for _, o := range rows {
			cells := []any{o["number"], o["paid_at"], o["status"], o["payment_method"], d(o["subtotal_cents"]), d(o["discount_cents"]), d(o["tax_cents"]), d(o["tip_cents"]), d(o["total_cents"]), o["staff"], o["table_label"]}
			parts := make([]string, len(cells))
			for i, x := range cells {
				parts[i] = opsCSVEsc(x)
			}
			lines = append(lines, strings.Join(parts, ","))
		}
		t := r["totals"].(M)
		lines = append(lines, "", "Summary,Gross,Discounts,Tax,Tips,Collected,Voids,Labor,Labor %")
		lines = append(lines, strings.Join([]string{"", d(t["grossCents"]), d(t["discountCents"]), d(t["taxCents"]), d(t["tipsCents"]), d(t["collectedCents"]), d(t["voidCents"]), d(t["laborCents"]), fmtJSNum(f64(t["laborPct"]))}, ","))
		if err := c.Audit("report.export", date); err != nil {
			return err
		}
		c.W.Header().Set("Content-Type", "text/csv; charset=utf-8")
		c.W.Header().Set("Content-Disposition", `attachment; filename="buzzhub-`+date+`.csv"`)
		_, err = c.W.Write([]byte(strings.Join(lines, "\n")))
		return err
	})

	/* ================= Cash drawer ================= */
	rt.staff("GET /cash", "staff", func(c *C) error {
		cur, err := c.opsOpenSession()
		if err != nil {
			return err
		}
		recent, err := c.All(`SELECT * FROM cash_sessions WHERE closed_at IS NOT NULL ORDER BY id DESC LIMIT 10`)
		if err != nil {
			return err
		}
		var current any
		if cur != nil {
			if current, err = c.opsCashSummary(cur); err != nil {
				return err
			}
		}
		rs := []M{}
		for _, r := range recent {
			v, err := c.opsCashSummary(r)
			if err != nil {
				return err
			}
			rs = append(rs, v)
		}
		return c.JSON(M{"current": current, "recent": rs})
	})
	opsOpenSchema := valid.Object(map[string]valid.Schema{"openingCents": valid.Int().Min(0).Max(10_000_000)})
	rt.staff("POST /cash/open", "staff", func(c *C) error {
		if cs, err := c.opsOpenSession(); err != nil {
			return err
		} else if cs != nil {
			return conflict("The drawer is already open")
		}
		b, err := c.Body(opsOpenSchema)
		if err != nil {
			return err
		}
		if _, err := c.Run(`INSERT INTO cash_sessions (opened_by, opening_cents) VALUES (?, ?)`, c.U.ID, b["openingCents"]); err != nil {
			return err
		}
		if err := c.Audit("cash.open", "float "+dollars(i64(b["openingCents"]))); err != nil {
			return err
		}
		c.Notify("cash")
		return c.OK()
	})
	opsMoveSchema := valid.Ordered("kind", valid.Enum("in", "out"), "amountCents", valid.Int().Min(1).Max(10_000_000), "reason", valid.String().Trim().Min(1).Max(80))
	rt.staff("POST /cash/move", "staff", func(c *C) error {
		cs, err := c.opsOpenSession()
		if err != nil {
			return err
		}
		if cs == nil {
			return conflict("Open the drawer first")
		}
		b, err := c.Body(opsMoveSchema)
		if err != nil {
			return err
		}
		if _, err := c.Run(`INSERT INTO cash_moves (session_id, kind, amount_cents, reason, user_id) VALUES (?, ?, ?, ?, ?)`, cs["id"], b["kind"], b["amountCents"], b["reason"], c.U.ID); err != nil {
			return err
		}
		if err := c.Audit("cash.paid_"+str(b["kind"]), dollars(i64(b["amountCents"]))+" "+str(b["reason"])); err != nil {
			return err
		}
		c.Notify("cash")
		return c.OK()
	})
	opsCloseSchema := valid.Ordered("countedCents", valid.Int().Min(0).Max(10_000_000), "notes", valid.String().Trim().Max(200).Optional())
	rt.staff("POST /cash/close", "staff", func(c *C) error {
		if _, err := c.managerOr("cash_close"); err != nil {
			return err
		}
		cs, err := c.opsOpenSession()
		if err != nil {
			return err
		}
		if cs == nil {
			return conflict("The drawer is not open")
		}
		b, err := c.Body(opsCloseSchema)
		if err != nil {
			return err
		}
		sm, err := c.opsCashSummary(cs)
		if err != nil {
			return err
		}
		expected := i64(sm["expectedCents"])
		counted := i64(b["countedCents"])
		if _, err := c.Run(`UPDATE cash_sessions SET closed_by=?, closed_at=?, counted_cents=?, expected_cents=?, notes=? WHERE id=?`, c.U.ID, store.Now(), counted, expected, orNil(b["notes"]), cs["id"]); err != nil {
			return err
		}
		variance := counted - expected
		state := "balanced"
		if variance != 0 {
			dir := "short"
			if variance > 0 {
				dir = "over"
			}
			state = dir + " " + dollars(absI64(variance))
		}
		if err := c.Audit("cash.close", fmt.Sprintf("counted %s, expected %s, %s", dollars(counted), dollars(expected), state)); err != nil {
			return err
		}
		if absI64(variance) >= 500 {
			dir := "short"
			if variance > 0 {
				dir = "over"
			}
			c.Emit("owners", "security", M{"type": "cash_variance", "detail": fmt.Sprintf("Drawer %s by $%s", dir, dollars(absI64(variance))), "at": nowMs()})
		}
		c.Notify("cash")
		return c.JSON(M{"ok": true, "expectedCents": expected, "varianceCents": variance})
	})

	/* ================= Shifts: clock in/out with PIN, schedule, labor ================= */
	opsOpenShift := func(c *C, uid int64) (store.Row, error) {
		return c.One(`SELECT * FROM shifts WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1`, uid)
	}
	opsPinSchema := valid.Object(map[string]valid.Schema{"pin": valid.String().RegexMsg(`^\d{4,8}$`, "Enter your PIN")})
	// From the lock screen: the PIN identifies the person, no session is created.
	// (In Node the hooks object ops.js receives has no punchGuard/handoffFor, so neither runs here.)
	rt.pub("POST /api/auth/clock", func(c *C) error {
		ip := c.IP()
		if wait := a.lockout.Blocked(ip); wait > 0 {
			return fail(429, fmt.Sprintf("Terminal locked. Try again in %ds.", wait))
		}
		b, err := c.Body(opsPinSchema)
		if err != nil {
			return err
		}
		user, _, err := auth.FindUserByPin(c.Ctx, c.Tx, str(b["pin"]))
		if err != nil {
			return err
		}
		if user == nil {
			_, locked := a.lockout.Fail(ip)
			if err := c.AuditAs(nil, "auth.fail", "bad PIN at time clock", ip); err != nil {
				return err
			}
			msg := "Wrong PIN"
			if locked > 0 {
				msg = fmt.Sprintf("Too many wrong PINs. Locked for %ds.", locked)
			}
			return &committedError{HTTPError{Status: 401, Msg: msg}}
		}
		a.lockout.Clear(ip)
		cur, err := opsOpenShift(c, user.ID)
		if err != nil {
			return err
		}
		now := store.Now()
		if cur != nil {
			var brk int64
			if bs := str(cur["break_started"]); bs != "" {
				brk = roundJS(opsHoursBetween(bs, now) * 60)
			}
			if _, err := c.Run(`UPDATE shifts SET clock_out = ?, break_minutes = break_minutes + ?, break_started = NULL WHERE id = ?`, now, brk, cur["id"]); err != nil {
				return err
			}
			hrs := opsHoursBetween(str(cur["clock_in"]), now) - float64(i64(cur["break_minutes"])+brk)/60
			if err := c.AuditAs(user, "shift.out", fmt.Sprintf("%.2f h", hrs), ip); err != nil {
				return err
			}
			c.Notify("shifts")
			return c.JSON(M{"name": user.Name, "action": "out", "hours": float64(roundJS(hrs*100)) / 100})
		}
		if _, err := c.Run(`INSERT INTO shifts (user_id, clock_in) VALUES (?, ?)`, user.ID, now); err != nil {
			return err
		}
		if err := c.AuditAs(user, "shift.in", "", ip); err != nil {
			return err
		}
		c.Notify("shifts")
		return c.JSON(M{"name": user.Name, "action": "in", "notes": []any{}})
	}, a.authLim())

	rt.staff("GET /shifts", "staff", func(c *C) error {
		date := c.opsDateQ("from")
		tz := opsTZ(c)
		start, _ := opsDayBounds(date, tz)
		last := addDays(date, 6)
		_, end := opsDayBounds(last, tz)
		isMgr := c.U.Role == "manager" || c.U.Role == "owner"
		onNow, err := c.All(`SELECT s.id, s.clock_in, u.id user_id, u.name, u.role FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_out IS NULL ORDER BY s.clock_in`)
		if err != nil {
			return err
		}
		q := `SELECT s.*, u.name, u.hourly_cents FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.clock_in >= ? AND s.clock_in < ? `
		args := []any{start, end}
		if !isMgr {
			q += `AND s.user_id = ? `
			args = append(args, c.U.ID)
		}
		rows, err := c.All(q+`ORDER BY s.clock_in DESC`, args...)
		if err != nil {
			return err
		}
		shifts := []M{}
		for _, s := range rows {
			hours := math.Max(0, opsHoursBetween(str(s["clock_in"]), s["clock_out"])-f64(s["break_minutes"])/60)
			v := opsCopy(s)
			v["hours"] = float64(roundJS(hours*100)) / 100
			if isMgr {
				v["cost_cents"] = roundJS(hours * f64(s["hourly_cents"]))
			} else {
				delete(v, "hourly_cents")
			}
			shifts = append(shifts, v)
		}
		sched, err := c.All(`SELECT sc.*, u.name FROM schedule sc JOIN users u ON u.id = sc.user_id WHERE substr(sc.start_local,1,10) >= ? AND substr(sc.start_local,1,10) <= ? ORDER BY sc.start_local`, date, last)
		if err != nil {
			return err
		}
		today := opsToday(c)
		ts, te := opsDayBounds(today, tz)
		sales, err := c.N(`SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) c FROM orders WHERE paid_at IS NOT NULL AND status <> 'void' AND paid_at >= ? AND paid_at < ?`, ts, te)
		if err != nil {
			return err
		}
		var laborToday any
		if isMgr {
			ls, err := c.All(`SELECT s.*, u.hourly_cents FROM shifts s JOIN users u ON u.id=s.user_id WHERE s.clock_in < ? AND (s.clock_out IS NULL OR s.clock_out >= ?)`, te, ts)
			if err != nil {
				return err
			}
			total := 0.0
			for _, s := range ls {
				in := str(s["clock_in"])
				if in < ts {
					in = ts
				}
				total += math.Max(0, opsHoursBetween(in, s["clock_out"])-f64(s["break_minutes"])/60) * f64(s["hourly_cents"])
			}
			laborToday = roundJS(total)
		}
		return c.JSON(M{"from": date, "today": today, "onNow": onNow, "shifts": shifts, "schedule": sched, "salesTodayCents": sales, "laborTodayCents": laborToday})
	})

	opsStamp := `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`
	opsShiftSchema := valid.Ordered("clock_in", valid.String().Regex(opsStamp).Optional(), "clock_out", valid.String().Regex(opsStamp).Nullable().Optional(), "break_minutes", valid.Int().Min(0).Max(600).Optional())
	rt.staff("PUT /shifts/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		b, err := c.Body(opsShiftSchema)
		if err != nil {
			return err
		}
		s, err := c.One(`SELECT * FROM shifts WHERE id=?`, id)
		if err != nil {
			return err
		}
		if s == nil {
			return notFound("Not found")
		}
		m := opsCopy(s)
		for k, v := range b {
			m[k] = v
		}
		if co := str(m["clock_out"]); co != "" && co <= str(m["clock_in"]) {
			return bad("Clock-out must be after clock-in")
		}
		if _, err := c.Run(`UPDATE shifts SET clock_in=?, clock_out=?, break_minutes=?, edited_by=? WHERE id=?`, m["clock_in"], m["clock_out"], m["break_minutes"], c.U.ID, id); err != nil {
			return err
		}
		if err := c.Audit("shift.edit", "#"+itoa(id)); err != nil {
			return err
		}
		c.Notify("shifts")
		return c.OK()
	})

	opsSchedSchema := valid.Ordered("userId", valid.Int(), "date", valid.String().Regex(`^\d{4}-\d{2}-\d{2}$`), "start", valid.String().Regex(`^\d{2}:\d{2}$`), "end", valid.String().Regex(`^\d{2}:\d{2}$`), "note", valid.String().Trim().Max(40).Optional())
	rt.staff("POST /schedule", "manager", func(c *C) error {
		b, err := c.Body(opsSchedSchema)
		if err != nil {
			return err
		}
		date, st, en := str(b["date"]), str(b["start"]), str(b["end"])
		if en <= st {
			return bad("End must be after start")
		}
		if u, err := c.One(`SELECT 1 FROM users WHERE id=? AND active=1`, b["userId"]); err != nil {
			return err
		} else if u == nil {
			return notFound("Unknown team member")
		}
		if _, err := c.Run(`INSERT INTO schedule (user_id, start_local, end_local, role_note) VALUES (?, ?, ?, ?)`, b["userId"], date+" "+st, date+" "+en, orNil(b["note"])); err != nil {
			return err
		}
		if err := c.Audit("schedule.add", fmt.Sprintf("%s %s-%s", date, st, en)); err != nil {
			return err
		}
		warnings, err := c.G("shiftConflicts", i64(b["userId"]), date, st, en)
		if err != nil {
			return err
		}
		if warnings == nil {
			warnings = []any{}
		}
		c.Notify("shifts")
		return c.JSON(M{"ok": true, "warnings": warnings})
	})
	rt.staff("DELETE /schedule/{id}", "manager", func(c *C) error {
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`DELETE FROM schedule WHERE id=?`, id); err != nil {
			return err
		}
		c.Notify("shifts")
		return c.OK()
	})
	opsWageSchema := valid.Object(map[string]valid.Schema{"hourlyCents": valid.Int().Min(0).Max(100_000)})
	rt.staff("PUT /users/{id}/wage", "owner", func(c *C) error {
		b, err := c.Body(opsWageSchema)
		if err != nil {
			return err
		}
		id, err := c.ID()
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE users SET hourly_cents=? WHERE id=?`, b["hourlyCents"], id); err != nil {
			return err
		}
		if err := c.Audit("user.wage", "#"+c.Param("id")); err != nil {
			return err
		}
		return c.OK()
	})
}

func absI64(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}
