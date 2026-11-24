package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/auth"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/store"
	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Port of crew.js: overtime guard, phone clock-in by location, punch photos, shift handoff notes,
// payroll files (Gusto / ADP), use-first stock (ingredient lots), table turn report and private rooms.

func init() { modules = append(modules, (*App).registerCrew) }

/* ---------- small helpers ---------- */

// crewAddDays is addDays from crew.js (noon-anchored, allows fractional days like JS).
func crewAddDays(d string, n float64) string {
	t, err := time.Parse("2006-01-02", d)
	if err != nil {
		return d
	}
	return t.Add(12*time.Hour + time.Duration(n*float64(24*time.Hour))).UTC().Format("2006-01-02")
}

func crewDaysUntil(d, today string) int64 {
	a, _ := time.Parse("2006-01-02", d)
	b, _ := time.Parse("2006-01-02", today)
	return roundJS(a.Sub(b).Hours() / 24)
}

func crewMins(t string) int {
	p := strings.SplitN(t, ":", 2)
	a, _ := strconv.Atoi(p[0])
	b := 0
	if len(p) > 1 {
		b, _ = strconv.Atoi(p[1])
	}
	return a*60 + b
}

func crewFmt(c int64) string { return "$" + dollars(c) }

// crewJSString is String(v ?? ”) for values from the database or other modules.
func crewJSString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case float64:
		return fmtJSNum(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	}
	return str(v)
}

var crewFormulaRE = regexp.MustCompile(`^[=+\-@]`)
var crewQuoteRE = regexp.MustCompile(`[",\n]`)

func crewCSVCell(v any) string {
	s := crewJSString(v)
	if crewFormulaRE.MatchString(s) {
		return "'" + s
	}
	if crewQuoteRE.MatchString(s) {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

func crewCSV(rows [][]any) string {
	lines := make([]string, len(rows))
	for i, r := range rows {
		cells := make([]string, len(r))
		for j, v := range r {
			cells[j] = crewCSVCell(v)
		}
		lines[i] = strings.Join(cells, ",")
	}
	return strings.Join(lines, "\n")
}

func crewDist(a, b, c, d float64) float64 {
	const R = 6371000.0
	r := math.Pi / 180
	x := math.Pow(math.Sin((c-a)*r/2), 2) + math.Cos(a*r)*math.Cos(c*r)*math.Pow(math.Sin((d-b)*r/2), 2)
	return 2 * R * math.Asin(math.Sqrt(x))
}

func crewR2(x float64) float64 { return float64(roundJS(x*100)) / 100 }

func crewSlice(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// crewNumParam is Number(req.params.x) used straight in a query (bad values match no row).
func (c *C) crewNumParam(name string) int64 {
	n, err := strconv.ParseInt(c.Param(name), 10, 64)
	if err != nil {
		return -1
	}
	return n
}

func crewToken(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (c *C) crewLocQS() string {
	if c.Slug() == "main" {
		return ""
	}
	return "?l=" + c.Slug()
}

// crewMap reads an M from a hook argument (M / store.Row).
func crewMap(v any) M {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return M{}
}

func crewList(v any) []M {
	out := []M{}
	switch x := v.(type) {
	case []M:
		return x
	case []any:
		for _, e := range x {
			out = append(out, crewMap(e))
		}
	}
	return out
}

func crewUser(v any) *auth.User {
	switch x := v.(type) {
	case *auth.User:
		return x
	case auth.User:
		return &x
	case map[string]any:
		return &auth.User{ID: i64(x["id"]), Name: str(x["name"]), Role: str(x["role"])}
	}
	return nil
}

/* ---------- time card (the part of timeclock.js timeCard that the overtime guard needs) ---------- */

func crewBreakMin(s store.Row) float64 {
	m := f64(s["break_minutes"])
	if bs := str(s["break_started"]); bs != "" {
		m += opsHoursBetween(bs, nil) * 60
	}
	return m
}

type crewCard struct {
	weekHours, overtimeAt float64
	scheduledToday        []store.Row
}

func (c *C) crewTimeCard(uid int64) (crewCard, error) {
	s := c.S()
	tz := opsTZ(c)
	today := opsToday(c)
	t, _ := time.Parse("2006-01-02", today)
	dow := int(t.Weekday())
	wsd := 1
	if v, ok := s["payroll_week_start"]; ok {
		f, _ := jsNumber(v)
		wsd = int(f)
	}
	weekStart := addDays(today, -(((dow-wsd)%7 + 7) % 7))
	a, _ := opsDayBounds(weekStart, tz)
	rows, err := c.All(`SELECT * FROM shifts WHERE user_id = ? AND (clock_out IS NULL OR clock_out >= ?) ORDER BY clock_in`, uid, a)
	if err != nil {
		return crewCard{}, err
	}
	weekH := 0.0
	for _, x := range rows {
		in := str(x["clock_in"])
		if in < a {
			in = a
		}
		weekH += math.Max(0, opsHoursBetween(in, x["clock_out"])-crewBreakMin(x)/60)
	}
	sched, err := c.All(`SELECT start_local, end_local, role_note FROM schedule WHERE user_id = ? AND substr(start_local,1,10) = ? ORDER BY start_local`, uid, today)
	if err != nil {
		return crewCard{}, err
	}
	ot, _ := jsNumber(s["ot_weekly_hours"])
	if ot == 0 || math.IsNaN(ot) {
		ot = 40
	}
	return crewCard{weekHours: crewR2(weekH), overtimeAt: ot, scheduledToday: sched}, nil
}

// crewOvertimeRisk: would clocking in now put this person into overtime this week? (nil = no)
func (c *C) crewOvertimeRisk(uid int64) (M, error) {
	if c.S()["ot_guard"] != "1" {
		return nil, nil
	}
	card, err := c.crewTimeCard(uid)
	if err != nil {
		return nil, err
	}
	planned := 0.0
	for _, x := range card.scheduledToday {
		st, en := str(x["start_local"]), str(x["end_local"])
		if len(st) > 11 {
			st = st[11:]
		}
		if len(en) > 11 {
			en = en[11:]
		}
		m := crewMins(en) - crewMins(st)
		if m < 0 {
			m += 1440
		}
		planned += float64(m) / 60
	}
	projected := card.weekHours + planned
	already := card.weekHours >= card.overtimeAt-0.01
	if already || projected > card.overtimeAt+0.01 {
		return M{"weekHours": card.weekHours, "projected": float64(roundJS(projected*10)) / 10, "overtimeAt": card.overtimeAt, "already": already}, nil
	}
	return nil, nil
}

func crewOTMessage(r M, name string) string {
	if r["already"] == true {
		return fmt.Sprintf("%s already has %s hours this week (overtime starts at %s).", name, fmtJSNum(f64(r["weekHours"])), fmtJSNum(f64(r["overtimeAt"])))
	}
	return fmt.Sprintf("Today's shift would bring %s to about %s hours this week (overtime starts at %s).", name, fmtJSNum(f64(r["projected"])), fmtJSNum(f64(r["overtimeAt"])))
}

/* ---------- rooms ---------- */

func crewRoomView(r store.Row) M {
	v := opsCopy(r)
	v["table_ids"] = jparse(r["table_ids"], []any{})
	return v
}

func crewQuote(room store.Row) M {
	dep := roundJS((f64(room["min_spend_cents"]) + f64(room["fee_cents"])) * f64(room["deposit_pct"]) / 100)
	return M{"minSpendCents": room["min_spend_cents"], "feeCents": room["fee_cents"], "depositCents": dep}
}

func crewIDs(v any) []int64 {
	out := []int64{}
	if l, ok := jparse(v, []any{}).([]any); ok {
		for _, x := range l {
			out = append(out, i64(x))
		}
	}
	return out
}

func crewJoinIDs(ids []int64) string {
	p := make([]string, len(ids))
	for i, x := range ids {
		p[i] = itoa(x)
	}
	return strings.Join(p, ",")
}

func (c *C) crewClash(roomID any, date, st, en string, exceptID int64) (store.Row, error) {
	rows, err := c.All(`SELECT id, name, start_time, end_time FROM room_bookings WHERE room_id = ? AND date = ? AND status IN ('requested','confirmed') AND id <> ?`, roomID, date, exceptID)
	if err != nil {
		return nil, err
	}
	for _, b := range rows {
		if crewMins(st) < crewMins(str(b["end_time"])) && crewMins(str(b["start_time"])) < crewMins(en) {
			return b, nil
		}
	}
	return nil, nil
}

func (c *C) crewBookingView(b store.Row) (M, error) {
	r, err := c.One(`SELECT name, table_ids FROM rooms WHERE id = ?`, b["room_id"])
	if err != nil {
		return nil, err
	}
	v := opsCopy(b)
	v["room"] = "Room"
	tables := []any{}
	if r != nil {
		if truthy(r["name"]) {
			v["room"] = r["name"]
		}
		in := crewJoinIDs(crewIDs(r["table_ids"]))
		if in == "" {
			in = "0"
		}
		rows, err := c.All(`SELECT label FROM tables WHERE id IN (` + in + `)`)
		if err != nil {
			return nil, err
		}
		for _, t := range rows {
			tables = append(tables, t["label"])
		}
	}
	v["tables"] = tables
	return v, nil
}

func (c *C) crewSpendFor(b store.Row) (int64, error) {
	r, err := c.One(`SELECT table_ids FROM rooms WHERE id = ?`, b["room_id"])
	if err != nil {
		return 0, err
	}
	var ids []int64
	if r != nil {
		ids = crewIDs(r["table_ids"])
	}
	if len(ids) == 0 {
		return 0, nil
	}
	start, _ := opsDayBounds(str(b["date"]), opsTZ(c))
	base := time.UnixMilli(opsMs(start)).UTC()
	at := func(t string) string { return opsFmtSQL(base.Add(time.Duration(crewMins(t)) * time.Minute)) }
	return c.N(`SELECT COALESCE(SUM(subtotal_cents - discount_cents),0) c FROM orders WHERE status <> 'void' AND table_id IN (`+crewJoinIDs(ids)+`) AND created_at BETWEEN ? AND ?`, at(str(b["start_time"])), at(str(b["end_time"])))
}

func (c *C) crewTellCustomer(b store.Row, subject, message string) {
	if !truthy(b["email"]) || !emailEnabled() {
		return
	}
	s := c.S()
	m := emailMsg{BusinessName: s["business_name"], Subject: subject, Message: message, Accent: s["accent"], Link: os.Getenv("PUBLIC_URL") + "/event-room/" + str(b["token"]) + c.crewLocQS(), Button: "See your booking"}
	to := str(b["email"])
	c.Tx.AfterCommit(func() { go func() { _, _ = emailGuest(to, m) }() })
}

var crewBookSchema = valid.Ordered(
	"roomId", valid.Int(),
	"name", valid.String().Trim().Min(1).Max(60),
	"email", valid.String().Trim().Email().Max(120).Optional().Or(valid.Literal("")),
	"phone", valid.String().Trim().Max(30).Optional(),
	"date", valid.String().Regex(`^\d{4}-\d{2}-\d{2}$`),
	"start", valid.String().Regex(`^\d{2}:\d{2}$`),
	"end", valid.String().Regex(`^\d{2}:\d{2}$`),
	"guests", valid.Int().Min(1).Max(1000),
	"occasion", valid.String().Trim().Max(60).Optional(),
	"notes", valid.String().Trim().Max(600).Optional(),
)

func (c *C) crewCreateBooking(b valid.M, source string) (store.Row, error) {
	room, err := c.One(`SELECT * FROM rooms WHERE id = ? AND active = 1`, b["roomId"])
	if err != nil {
		return nil, err
	}
	if room == nil {
		return nil, bad("That room is not available")
	}
	st, en, date := str(b["start"]), str(b["end"]), str(b["date"])
	if crewMins(en) <= crewMins(st) {
		return nil, bad("The end time must be after the start time")
	}
	if date < opsToday(c) {
		return nil, bad("Pick a date in the future")
	}
	if i64(b["guests"]) > i64(room["capacity"]) {
		return nil, bad(fmt.Sprintf("%s holds up to %d guests", str(room["name"]), i64(room["capacity"])))
	}
	cl, err := c.crewClash(room["id"], date, st, en, 0)
	if err != nil {
		return nil, err
	}
	if cl != nil {
		return nil, conflict(fmt.Sprintf("%s is already booked %s–%s that day", str(room["name"]), str(cl["start_time"]), str(cl["end_time"])))
	}
	q := crewQuote(room)
	res, err := c.Run(`INSERT INTO room_bookings (room_id, token, name, email, phone, date, start_time, end_time, guests, occasion, notes, min_spend_cents, fee_cents, deposit_cents, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		room["id"], crewToken(16), b["name"], orNil(b["email"]), orNil(b["phone"]), date, st, en, b["guests"], orNil(b["occasion"]), orNil(b["notes"]), q["minSpendCents"], q["feeCents"], q["depositCents"], source)
	if err != nil {
		return nil, err
	}
	return c.Get(`SELECT * FROM room_bookings WHERE id = ?`, res.LastID)
}

/* ---------- table turns ---------- */

type crewGroup struct {
	key                    any
	turns                  int
	minutes, spend, covers float64
	list                   []float64
}

func crewGroupBy(rows []M, key func(M) any) []M {
	order := []any{}
	m := map[any]*crewGroup{}
	for _, r := range rows {
		k := key(r)
		g := m[k]
		if g == nil {
			g = &crewGroup{key: k}
			m[k] = g
			order = append(order, k)
		}
		g.turns++
		g.minutes += f64(r["minutes"])
		g.spend += f64(r["spend"])
		g.covers += f64(r["party_size"])
		g.list = append(g.list, f64(r["minutes"]))
	}
	out := []M{}
	for _, k := range order {
		g := m[k]
		sort.Float64s(g.list)
		var perCover, perHour int64
		if g.covers != 0 {
			perCover = roundJS(g.spend / g.covers)
		}
		if g.minutes != 0 {
			perHour = roundJS(g.spend / (g.minutes / 60))
		}
		out = append(out, M{"key": g.key, "turns": g.turns, "avgMinutes": roundJS(g.minutes / float64(g.turns)), "medianMinutes": roundJS(g.list[len(g.list)/2]),
			"avgSpendCents": roundJS(g.spend / float64(g.turns)), "spendPerCoverCents": perCover, "spendPerHourCents": perHour})
	}
	return out
}

func crewSize(n float64) string {
	switch {
	case n <= 2:
		return "1–2"
	case n <= 4:
		return "3–4"
	case n <= 6:
		return "5–6"
	}
	return "7+"
}

/* ---------- registration ---------- */

func (a *App) registerCrew(rt *router) {
	/* ===== overtime guard: used by the time clock, the lock screen, the phone and manager punches =====
	   args[0]: M{user *auth.User, action, managerPin, approvedBy *auth.User, ip, where}.
	   Returns nil or M{approvedBy: name}; errors carry needsManager (and overtime) in HTTPError.Extra. */
	a.G["punchGuard"] = func(c *C, args ...any) (any, error) {
		p := crewMap(args[0])
		user := crewUser(p["user"])
		action := str(p["action"])
		if user == nil || (action != "in" && action != "auto") {
			return nil, nil
		}
		r, err := c.crewOvertimeRisk(user.ID)
		if err != nil || r == nil {
			return nil, err
		}
		ip, where := str(p["ip"]), str(p["where"])
		if by := crewUser(p["approvedBy"]); by != nil {
			if err := c.AuditAs(by, "overtime.approve", fmt.Sprintf("%s: %s h", user.Name, fmtJSNum(f64(r["projected"]))), ip); err != nil {
				return nil, err
			}
			return M{"approvedBy": by.Name}, nil
		}
		if pin := str(p["managerPin"]); pin != "" {
			m, _, err := auth.FindUserByPin(c.Ctx, c.Tx, pin)
			if err != nil {
				return nil, err
			}
			if m == nil || (m.Role != "manager" && m.Role != "owner") {
				return nil, failX(403, "That PIN is not a manager PIN", M{"needsManager": true})
			}
			if m.ID == user.ID && m.Role != "owner" {
				return nil, failX(403, "A different manager has to approve your overtime", M{"needsManager": true})
			}
			if err := c.AuditAs(m, "overtime.approve", fmt.Sprintf("%s: %s h (%s)", user.Name, fmtJSNum(f64(r["projected"])), where), ip); err != nil {
				return nil, err
			}
			return M{"approvedBy": m.Name}, nil
		}
		first := strings.SplitN(user.Name, " ", 2)[0]
		return nil, failX(409, crewOTMessage(r, first)+" A manager needs to approve.", M{"needsManager": true, "overtime": r})
	}

	/* ===== phone clock-in by location: args[0] is the body {lat, lng, acc} ===== */
	a.G["phonePunchCheck"] = func(c *C, args ...any) (any, error) {
		s := c.S()
		if s["punch_geofence"] != "1" {
			return nil, nil
		}
		b := M{}
		if len(args) > 0 {
			b = crewMap(args[0])
		}
		lat, latOK := jsNumber(s["biz_lat"])
		lng, _ := jsNumber(s["biz_lng"])
		if s["biz_lat"] == "" || s["biz_lng"] == "" || !latOK {
			return nil, conflict("Ask a manager to set the business location in Settings first.")
		}
		isNum := func(v any) bool {
			switch v.(type) {
			case float64, int64, int:
				return true
			}
			return false
		}
		if !isNum(b["lat"]) || !isNum(b["lng"]) {
			return nil, bad("Allow location so BuzzHub can check you are at work.")
		}
		radius, _ := jsNumber(s["punch_radius_m"])
		if radius == 0 || math.IsNaN(radius) {
			radius = 150
		}
		d := crewDist(lat, lng, f64(b["lat"]), f64(b["lng"]))
		acc := f64(b["acc"])
		if math.IsNaN(acc) {
			acc = 0
		}
		if d > radius+math.Min(acc, 100) {
			return nil, forbidden(fmt.Sprintf("You are about %d m away. Clock in when you are at work (within %s m).", roundJS(d), fmtJSNum(radius)))
		}
		return nil, nil
	}

	/* ===== punch photos: args[0] is M{user, result (M with action), photo} ===== */
	crewPhotoRE := regexp.MustCompile(`^data:image/jpeg;base64,[A-Za-z0-9+/=]+$`)
	a.G["afterPunch"] = func(c *C, args ...any) (any, error) {
		p := crewMap(args[0])
		photo := str(p["photo"])
		user := crewUser(p["user"])
		if photo == "" || c.S()["punch_photo"] != "1" || p["result"] == nil || user == nil {
			return nil, nil
		}
		if !crewPhotoRE.MatchString(photo) || len(photo) > 120000 {
			return nil, nil
		}
		_, err := c.Run(`INSERT INTO punch_photos (user_id, action, data) VALUES (?, ?, ?)`, user.ID, crewMap(p["result"])["action"], photo)
		return nil, err
	}
	rt.staff("GET /punch-photos", "manager", func(c *C) error {
		date := c.opsDateQ("date")
		start, end := opsDayBounds(date, opsTZ(c))
		rows, err := c.All(`SELECT p.id, p.user_id, p.action, p.at, u.name FROM punch_photos p JOIN users u ON u.id = p.user_id WHERE p.at >= ? AND p.at < ? ORDER BY p.at DESC`, start, end)
		if err != nil {
			return err
		}
		out := []M{}
		for _, p := range rows {
			v := opsCopy(p)
			v["url"] = fmt.Sprintf("/api/staff/punch-photos/%v", p["id"])
			out = append(out, v)
		}
		return c.JSON(M{"date": date, "photos": out})
	})
	rt.staff("GET /punch-photos/{id}", "manager", func(c *C) error {
		p, err := c.One(`SELECT data FROM punch_photos WHERE id = ?`, c.crewNumParam("id"))
		if err != nil {
			return err
		}
		if p == nil {
			return notFound("Not found")
		}
		parts := strings.SplitN(str(p["data"]), ",", 2)
		raw := []byte{}
		if len(parts) == 2 {
			raw, _ = base64.StdEncoding.DecodeString(parts[1])
		}
		c.W.Header().Set("Content-Type", "image/jpeg")
		c.W.Header().Set("Cache-Control", "private, max-age=3600")
		_, err = c.W.Write(raw)
		return err
	})

	/* ===== shift handoff notes ===== */
	// handoffFor(uid) → recent notes from others (empty when the feature is off)
	a.G["handoffFor"] = func(c *C, args ...any) (any, error) {
		if c.S()["handoff_notes"] == "0" {
			return []store.Row{}, nil
		}
		uid := int64(0)
		if len(args) > 0 {
			uid = i64(args[0])
		}
		return c.All(`SELECT n.id, n.body, n.at, u.name FROM handoff_notes n JOIN users u ON u.id = n.user_id WHERE n.at >= datetime('now','-24 hours') AND n.user_id <> ? ORDER BY n.at DESC LIMIT 6`, uid)
	}
	crewAddHandoff := func(c *C, user *auth.User, body, ip string) error {
		t := crewSlice(strings.TrimSpace(body), 600)
		if t == "" || user == nil {
			return nil
		}
		if _, err := c.Run(`INSERT INTO handoff_notes (user_id, body) VALUES (?, ?)`, user.ID, t); err != nil {
			return err
		}
		if err := c.AuditAs(user, "handoff.note", crewSlice(t, 60), ip); err != nil {
			return err
		}
		c.Notify("handoff")
		return nil
	}
	// addHandoff(user, body, ip)
	a.G["addHandoff"] = func(c *C, args ...any) (any, error) {
		ip := ""
		if len(args) > 2 {
			ip = str(args[2])
		}
		return nil, crewAddHandoff(c, crewUser(args[0]), str(args[1]), ip)
	}
	rt.staff("GET /handoff", "staff", func(c *C) error {
		rows, err := c.All(`SELECT n.id, n.body, n.at, n.user_id, u.name FROM handoff_notes n JOIN users u ON u.id = n.user_id WHERE n.at >= datetime('now','-36 hours') ORDER BY n.at DESC LIMIT 20`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
	crewHandoffSchema := valid.Object(map[string]valid.Schema{"body": valid.String().Trim().Min(1).Max(600)})
	rt.staff("POST /handoff", "staff", func(c *C) error {
		b, err := c.Body(crewHandoffSchema)
		if err != nil {
			return err
		}
		if err := crewAddHandoff(c, c.U, str(b["body"]), c.IP()); err != nil {
			return err
		}
		return c.OK()
	})
	rt.staff("DELETE /handoff/{id}", "staff", func(c *C) error {
		n, err := c.One(`SELECT * FROM handoff_notes WHERE id = ?`, c.crewNumParam("id"))
		if err != nil {
			return err
		}
		if n == nil {
			return notFound("Not found")
		}
		if i64(n["user_id"]) != c.U.ID && c.U.Role != "manager" && c.U.Role != "owner" {
			return forbidden("Only the writer or a manager can remove this")
		}
		if _, err := c.Run(`DELETE FROM handoff_notes WHERE id = ?`, n["id"]); err != nil {
			return err
		}
		c.Notify("handoff")
		return c.OK()
	})

	/* ===== payroll files ===== */
	crewPayrollSchema := valid.Object(map[string]valid.Schema{"payrollId": valid.String().Trim().Max(20)})
	rt.staff("PUT /users/{id}/payroll-id", "owner", func(c *C) error {
		b, err := c.Body(crewPayrollSchema)
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE users SET payroll_id = ? WHERE id = ?`, orNil(b["payrollId"]), c.crewNumParam("id")); err != nil {
			return err
		}
		return c.OK()
	})
	// payrollFile(p, format) → CSV text. p: {to, people: [{userId, name, regular, overtime, tipsCents, declaredTipsCents}]}
	a.G["payrollFile"] = func(c *C, args ...any) (any, error) {
		p := crewMap(args[0])
		format := ""
		if len(args) > 1 {
			format = str(args[1])
		}
		us, err := c.All(`SELECT id, payroll_id FROM users`)
		if err != nil {
			return nil, err
		}
		ids := map[int64]string{}
		for _, u := range us {
			ids[i64(u["id"])] = str(u["payroll_id"])
		}
		idOf := func(x M) any {
			if v, ok := ids[i64(x["userId"])]; ok {
				return v
			}
			return nil
		}
		money := func(v any) string { return dollars(roundJS(f64(v))) }
		people := crewList(p["people"])
		if format == "gusto" {
			rows := [][]any{{"first_name", "last_name", "employee_id", "regular_hours", "overtime_hours", "paycheck_tips", "cash_tips"}}
			for _, x := range people {
				parts := strings.Fields(str(x["name"]))
				f, l := "", ""
				if len(parts) > 0 {
					f, l = parts[0], strings.Join(parts[1:], " ")
				}
				rows = append(rows, []any{f, l, idOf(x), x["regular"], x["overtime"], money(x["tipsCents"]), money(x["declaredTipsCents"])})
			}
			return crewCSV(rows), nil
		}
		co := c.S()["adp_company_code"]
		batch := "BH" + strings.ReplaceAll(str(p["to"]), "-", "")
		rows := [][]any{{"Co Code", "Batch ID", "File #", "Employee Name", "Reg Hours", "O/T Hours", "Earnings 3 Code", "Earnings 3 Amount", "Earnings 4 Code", "Earnings 4 Amount"}}
		for _, x := range people {
			t3, a3, t4, a4 := "", "", "", ""
			if truthy(x["tipsCents"]) {
				t3, a3 = "T", money(x["tipsCents"])
			}
			if truthy(x["declaredTipsCents"]) {
				t4, a4 = "CT", money(x["declaredTipsCents"])
			}
			rows = append(rows, []any{co, batch, idOf(x), x["name"], x["regular"], x["overtime"], t3, a3, t4, a4})
		}
		return crewCSV(rows), nil
	}
	rt.staff("GET /payroll-ids", "owner", func(c *C) error {
		rows, err := c.All(`SELECT id, name, payroll_id FROM users WHERE active = 1 ORDER BY name`)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})

	/* ===== use-first stock ===== */
	// onReceive(ingredientId, qty, source)
	a.G["onReceive"] = func(c *C, args ...any) (any, error) {
		g, err := c.One(`SELECT shelf_days FROM ingredients WHERE id = ?`, i64(args[0]))
		if err != nil {
			return nil, err
		}
		qty := f64(args[1])
		if g == nil || !truthy(g["shelf_days"]) || qty <= 0 {
			return nil, nil
		}
		var src any
		if len(args) > 2 {
			src = orNil(args[2])
		}
		today := opsToday(c)
		_, err = c.Run(`INSERT INTO ingredient_lots (ingredient_id, qty, received_on, use_by, source) VALUES (?,?,?,?,?)`, i64(args[0]), qty, today, crewAddDays(today, f64(g["shelf_days"])), src)
		return nil, err
	}
	lotView := func(c *C, l store.Row) M {
		v := opsCopy(l)
		d := crewDaysUntil(str(l["use_by"]), opsToday(c))
		v["daysLeft"] = d
		switch {
		case d < 0:
			v["state"] = "expired"
		case d <= 1:
			v["state"] = "soon"
		default:
			v["state"] = "ok"
		}
		return v
	}
	rt.staff("GET /lots", "staff", func(c *C) error {
		rows, err := c.All(`SELECT l.*, g.name, g.unit FROM ingredient_lots l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.status = 'open' ORDER BY l.use_by, l.id`)
		if err != nil {
			return err
		}
		first, count := map[int64]int64{}, map[int64]int{}
		for _, l := range rows {
			g := i64(l["ingredient_id"])
			if _, ok := first[g]; !ok {
				first[g] = i64(l["id"])
			}
			count[g]++
		}
		lots := []M{}
		for _, l := range rows {
			v := lotView(c, l)
			g := i64(l["ingredient_id"])
			v["useFirst"] = first[g] == i64(l["id"]) && count[g] > 1
			lots = append(lots, v)
		}
		ings, err := c.All(`SELECT id, name, unit, shelf_days FROM ingredients WHERE active = 1 ORDER BY name`)
		if err != nil {
			return err
		}
		closed, err := c.All(`SELECT l.*, g.name, g.unit FROM ingredient_lots l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.status <> 'open' ORDER BY l.closed_at DESC NULLS LAST LIMIT 20`)
		if err != nil {
			return err
		}
		return c.JSON(M{"lots": lots, "ingredients": ings, "closed": closed})
	})
	crewDate := `^\d{4}-\d{2}-\d{2}$`
	crewLotSchema := valid.Ordered("ingredientId", valid.Int(), "qty", valid.Number().Positive().Max(1e6), "useBy", valid.String().Regex(crewDate).Optional(), "receivedOn", valid.String().Regex(crewDate).Optional())
	rt.staff("POST /lots", "staff", func(c *C) error {
		b, err := c.Body(crewLotSchema)
		if err != nil {
			return err
		}
		g, err := c.One(`SELECT * FROM ingredients WHERE id = ?`, b["ingredientId"])
		if err != nil {
			return err
		}
		if g == nil {
			return notFound("Ingredient not found")
		}
		rec := str(b["receivedOn"])
		if rec == "" {
			rec = opsToday(c)
		}
		useBy := str(b["useBy"])
		if useBy == "" && truthy(g["shelf_days"]) {
			useBy = crewAddDays(rec, f64(g["shelf_days"]))
		}
		if useBy == "" {
			return bad("Set a use-by date, or how many days this keeps")
		}
		if _, err := c.Run(`INSERT INTO ingredient_lots (ingredient_id, qty, received_on, use_by, source) VALUES (?,?,?,?, 'manual')`, g["id"], b["qty"], rec, useBy); err != nil {
			return err
		}
		if err := c.Audit("lot.add", fmt.Sprintf("%s %s %s use by %s", fmtJSNum(f64(b["qty"])), str(g["unit"]), str(g["name"]), useBy)); err != nil {
			return err
		}
		c.Notify("lots")
		return c.OK()
	})
	crewShelfSchema := valid.Object(map[string]valid.Schema{"days": valid.Int().Min(0).Max(730)})
	rt.staff("PUT /ingredients/{id}/shelf-days", "manager", func(c *C) error {
		b, err := c.Body(crewShelfSchema)
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE ingredients SET shelf_days = ? WHERE id = ?`, orNil(b["days"]), c.crewNumParam("id")); err != nil {
			return err
		}
		c.Notify("lots")
		return c.OK()
	})
	crewTossSchema := valid.Object(map[string]valid.Schema{"qty": valid.Number().Positive().Max(1e6).Optional()})
	rt.staff("POST /lots/{id}/{what}", "staff", func(c *C) error {
		l, err := c.One(`SELECT l.*, g.name, g.unit, g.cost_cents, g.stock FROM ingredient_lots l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.id = ? AND l.status = 'open'`, c.crewNumParam("id"))
		if err != nil {
			return err
		}
		if l == nil {
			return conflict("This batch is already closed")
		}
		what := c.Param("what")
		switch what {
		case "used":
			if _, err := c.Run(`UPDATE ingredient_lots SET status = 'used', closed_at = datetime('now') WHERE id = ?`, l["id"]); err != nil {
				return err
			}
		case "toss":
			b, err := c.Body(crewTossSchema)
			if err != nil {
				return err
			}
			q := f64(b["qty"])
			if q == 0 {
				q = f64(l["qty"])
			}
			if _, err := c.Run(`UPDATE ingredient_lots SET status = 'tossed', closed_at = datetime('now') WHERE id = ?`, l["id"]); err != nil {
				return err
			}
			if l["stock"] != nil {
				if _, err := c.Run(`UPDATE ingredients SET stock = stock - ? WHERE id = ?`, q, l["ingredient_id"]); err != nil {
					return err
				}
				if _, err := c.Run(`INSERT INTO ingredient_moves (ingredient_id, delta, reason, user_id) VALUES (?, ?, 'waste: expired', ?)`, l["ingredient_id"], -q, c.U.ID); err != nil {
					return err
				}
			}
			if _, err := c.Run(`INSERT INTO waste_log (ingredient_id, name, qty, unit, reason, cost_cents, note, user_id) VALUES (?,?,?,?, 'expired', ?, ?, ?)`, l["ingredient_id"], l["name"], q, l["unit"], roundJS(f64(l["cost_cents"])*q), "use by "+str(l["use_by"]), c.U.ID); err != nil {
				return err
			}
			c.Notify("waste")
		default:
			return notFound("Unknown action")
		}
		if err := c.Audit("lot."+what, fmt.Sprintf("%s (use by %s)", str(l["name"]), str(l["use_by"]))); err != nil {
			return err
		}
		c.Notify("lots")
		return c.OK()
	})
	a.every("lot alerts", 15*time.Minute, func(c *C) error {
		s := c.S()
		if time.Now().In(loadTZ(opsTZ(c))).Hour() < 7 {
			return nil
		}
		today := opsToday(c)
		due, err := c.All(`SELECT l.*, g.name, g.unit FROM ingredient_lots l JOIN ingredients g ON g.id = l.ingredient_id WHERE l.status = 'open' AND l.use_by <= ? AND (l.alerted IS NULL OR l.alerted <> ?)`, crewAddDays(today, 1), today)
		if err != nil || len(due) == 0 {
			return err
		}
		ids, parts := []int64{}, []string{}
		for _, d := range due {
			ids = append(ids, i64(d["id"]))
			ub := str(d["use_by"])
			when := "tomorrow"
			if ub < today {
				when = "expired"
			} else if ub == today {
				when = "today"
			}
			parts = append(parts, fmt.Sprintf("%s %s %s (%s)", crewJSString(d["qty"]), str(d["unit"]), str(d["name"]), when))
		}
		if _, err := c.Run(`UPDATE ingredient_lots SET alerted = ? WHERE id IN (`+crewJoinIDs(ids)+`)`, today); err != nil {
			return err
		}
		c.a.pushToUsers(c.Ctx, c.Tx, []string{"manager", "owner"}, M{"title": s["business_name"] + ": use these first", "body": strings.Join(parts, ", "), "tag": "lots-" + today, "url": "/use-first"}, 0)
		return nil
	})
	a.every("punch photo cleanup", 6*time.Hour, func(c *C) error {
		_ = c.Tx.Savepoint(c.Ctx, func() error {
			_, err := c.Run(`DELETE FROM punch_photos WHERE at < datetime('now','-60 days')`)
			return err
		})
		return nil
	})

	/* ===== table turn report ===== */
	rt.staff("GET /table-turns", "manager", func(c *C) error {
		days := 30.0
		if f, ok := jsNumber(c.Q("days")); ok && f != 0 {
			days = f
		}
		days = math.Min(180, math.Max(1, days))
		tz := opsTZ(c)
		since, _ := opsDayBounds(crewAddDays(opsToday(c), -(days-1)), tz)
		raw, err := c.All(`SELECT g.id, g.party_size, g.seated_at, g.closed_at, t.id table_id, t.label, t.zone, t.seats, u.name server,
        (SELECT COALESCE(SUM(o.total_cents),0) FROM orders o WHERE o.status <> 'void' AND o.paid_at IS NOT NULL AND (o.guest_id = g.id OR (o.table_id = t.id AND o.created_at BETWEEN g.seated_at AND g.closed_at))) spend
      FROM guests g JOIN tables t ON t.id = g.table_id LEFT JOIN users u ON u.id = t.server_id
      WHERE g.kind = 'table' AND g.seated_at >= ? AND g.closed_at IS NOT NULL AND g.closed_at > g.seated_at`, since)
		if err != nil {
			return err
		}
		rows := []M{}
		total := 0.0
		for _, r := range raw {
			m := float64(opsMs(str(r["closed_at"]))-opsMs(str(r["seated_at"]))) / 60000
			if m < 5 || m > 600 {
				continue
			}
			v := opsCopy(r)
			v["minutes"] = m
			total += m
			rows = append(rows, v)
		}
		loc := loadTZ(tz)
		at := func(r M) time.Time { return time.UnixMilli(opsMs(str(r["seated_at"]))).In(loc) }
		bySize := crewGroupBy(rows, func(r M) any { return crewSize(f64(r["party_size"])) })
		sizeOrder := map[any]int{"1–2": 1, "3–4": 2, "5–6": 3, "7+": 4}
		sort.SliceStable(bySize, func(i, j int) bool { return sizeOrder[bySize[i]["key"]] < sizeOrder[bySize[j]["key"]] })
		byTurns := func(l []M) []M {
			sort.SliceStable(l, func(i, j int) bool { return l[i]["turns"].(int) > l[j]["turns"].(int) })
			return l
		}
		byZone := byTurns(crewGroupBy(rows, func(r M) any { return r["zone"] }))
		dows := map[any]int{"Mon": 0, "Tue": 1, "Wed": 2, "Thu": 3, "Fri": 4, "Sat": 5, "Sun": 6}
		byDay := crewGroupBy(rows, func(r M) any { return at(r).Weekday().String()[:3] })
		sort.SliceStable(byDay, func(i, j int) bool { return dows[byDay[i]["key"]] < dows[byDay[j]["key"]] })
		byHour := crewGroupBy(rows, func(r M) any { return int64(at(r).Hour()) })
		sort.SliceStable(byHour, func(i, j int) bool { return byHour[i]["key"].(int64) < byHour[j]["key"].(int64) })
		byServer := byTurns(crewGroupBy(rows, func(r M) any {
			if truthy(r["server"]) {
				return r["server"]
			}
			return "No server"
		}))
		tables, err := c.N(`SELECT COUNT(*) c FROM tables`)
		if err != nil {
			return err
		}
		seated, err := c.All(`SELECT t.label, t.zone, t.seated_at, g.party_size, g.name FROM tables t LEFT JOIN guests g ON g.id = t.guest_id WHERE t.status = 'seated' AND t.seated_at IS NOT NULL`)
		if err != nil {
			return err
		}
		now := []M{}
		for _, t := range seated {
			m := roundJS(float64(nowMs()-opsMs(str(t["seated_at"]))) / 60000)
			ps := f64(t["party_size"])
			if ps == 0 {
				ps = 2
			}
			var typical any
			for _, x := range bySize {
				if x["key"] == crewSize(ps) {
					if av := i64(x["avgMinutes"]); av != 0 {
						typical = av
					}
					break
				}
			}
			v := opsCopy(t)
			v["minutes"], v["typical"] = m, typical
			v["over"] = typical != nil && float64(m) > float64(i64(typical))*1.25
			now = append(now, v)
		}
		var tpt float64
		if tables > 0 {
			tpt = float64(roundJS(float64(len(rows))/float64(tables)/days*10)) / 10
		}
		var avg int64
		if len(rows) > 0 {
			avg = roundJS(total / float64(len(rows)))
		}
		return c.JSON(M{"days": days, "total": len(rows), "turnsPerTablePerDay": tpt, "avgMinutes": avg,
			"bySize": bySize, "byZone": byZone, "byDay": byDay, "byHour": byHour, "byServer": byServer, "seatedNow": now})
	})

	/* ===== private rooms ===== */
	crewRoomSchema := valid.Ordered(
		"name", valid.String().Trim().Min(1).Max(40),
		"capacity", valid.Int().Min(1).Max(1000),
		"minSpendCents", valid.Int().Min(0).Max(10_000_000),
		"depositPct", valid.Number().Min(0).Max(100),
		"feeCents", valid.Int().Min(0).Max(1_000_000).Default(0),
		"tableIds", valid.Array(valid.Int()).Max(100).Default([]any{}),
		"description", valid.String().Trim().Max(300).Optional(),
		"active", valid.Bool().Optional(),
	)
	jsonIDs := func(v any) string {
		b, _ := json.Marshal(v)
		return string(b)
	}
	rt.staff("GET /rooms", "manager", func(c *C) error {
		today := opsToday(c)
		bs, err := c.All(`SELECT * FROM room_bookings WHERE date >= ? ORDER BY date, start_time`, crewAddDays(today, -7))
		if err != nil {
			return err
		}
		bookings := []M{}
		for _, b := range bs {
			v, err := c.crewBookingView(b)
			if err != nil {
				return err
			}
			if str(b["date"]) == today || str(b["status"]) == "done" {
				if v["spendCents"], err = c.crewSpendFor(b); err != nil {
					return err
				}
			}
			bookings = append(bookings, v)
		}
		rs, err := c.All(`SELECT * FROM rooms ORDER BY name`)
		if err != nil {
			return err
		}
		rooms := []M{}
		for _, r := range rs {
			rooms = append(rooms, crewRoomView(r))
		}
		tables, err := c.All(`SELECT id, label, zone FROM tables ORDER BY zone, id`)
		if err != nil {
			return err
		}
		return c.JSON(M{"rooms": rooms, "bookings": bookings, "tables": tables, "link": c.PublicBase() + "/event-rooms" + c.crewLocQS()})
	})
	rt.staff("POST /rooms", "manager", func(c *C) error {
		b, err := c.Body(crewRoomSchema)
		if err != nil {
			return err
		}
		if _, err := c.Run(`INSERT INTO rooms (name, capacity, min_spend_cents, deposit_pct, fee_cents, table_ids, description) VALUES (?,?,?,?,?,?,?)`, b["name"], b["capacity"], b["minSpendCents"], b["depositPct"], b["feeCents"], jsonIDs(b["tableIds"]), orNil(b["description"])); err != nil {
			return err
		}
		if err := c.Audit("room.add", str(b["name"])); err != nil {
			return err
		}
		c.Notify("rooms")
		return c.OK()
	})
	rt.staff("PUT /rooms/{id}", "manager", func(c *C) error {
		b, err := c.Body(crewRoomSchema)
		if err != nil {
			return err
		}
		var active any
		if v, ok := b["active"]; ok {
			active = v == true
		}
		if _, err := c.Run(`UPDATE rooms SET name=?, capacity=?, min_spend_cents=?, deposit_pct=?, fee_cents=?, table_ids=?, description=?, active=COALESCE(?, active) WHERE id=?`, b["name"], b["capacity"], b["minSpendCents"], b["depositPct"], b["feeCents"], jsonIDs(b["tableIds"]), orNil(b["description"]), active, c.crewNumParam("id")); err != nil {
			return err
		}
		c.Notify("rooms")
		return c.OK()
	})
	rt.staff("POST /rooms/bookings", "manager", func(c *C) error {
		b, err := c.Body(crewBookSchema)
		if err != nil {
			return err
		}
		bk, err := c.crewCreateBooking(b, "staff")
		if err != nil {
			return err
		}
		if _, err := c.Run(`UPDATE room_bookings SET status = 'confirmed' WHERE id = ?`, bk["id"]); err != nil {
			return err
		}
		if err := c.Audit("room.book", str(bk["name"])+" "+str(bk["date"])); err != nil {
			return err
		}
		c.Notify("rooms")
		return c.JSON(M{"ok": true, "token": bk["token"]})
	})
	crewPaidSchema := valid.Object(map[string]valid.Schema{"cents": valid.Int().Min(1).Max(10_000_000)})
	rt.staff("POST /rooms/bookings/{id}/{what}", "manager", func(c *C) error {
		w := c.Param("what")
		if w == "fire" { // handled by pace.js's own route (more specific pattern) once that moves over
			return fail(http.StatusNotImplemented, "This part of BuzzHub hasn't moved to the new server yet")
		}
		bk, err := c.One(`SELECT * FROM room_bookings WHERE id = ?`, c.crewNumParam("id"))
		if err != nil {
			return err
		}
		if bk == nil {
			return notFound("Not found")
		}
		first := strings.SplitN(str(bk["name"]), " ", 2)[0]
		dep, paid := i64(bk["deposit_cents"]), i64(bk["deposit_paid_cents"])
		switch w {
		case "confirm":
			if _, err := c.Run(`UPDATE room_bookings SET status = 'confirmed' WHERE id = ?`, bk["id"]); err != nil {
				return err
			}
			msg := fmt.Sprintf("Hi %s, your booking on %s from %s to %s is confirmed.", first, str(bk["date"]), str(bk["start_time"]), str(bk["end_time"]))
			if dep > paid {
				msg += fmt.Sprintf(" Please pay the %s deposit to hold it.", crewFmt(dep-paid))
			}
			c.crewTellCustomer(bk, "Your event is confirmed", msg)
		case "decline", "cancel":
			st, subj := "cancelled", "Your event was cancelled"
			msg := fmt.Sprintf("Hi %s, your booking on %s has been cancelled.", first, str(bk["date"]))
			if w == "decline" {
				st, subj = "declined", "About your event request"
				msg = fmt.Sprintf("Hi %s, we can't host your event on %s. Please call us to find another time.", first, str(bk["date"]))
			}
			if paid != 0 {
				msg += " We will be in touch about your deposit."
			}
			if _, err := c.Run(`UPDATE room_bookings SET status = ? WHERE id = ?`, st, bk["id"]); err != nil {
				return err
			}
			c.crewTellCustomer(bk, subj, msg)
		case "checkin":
			if truthy(bk["credit_code"]) {
				return c.JSON(M{"ok": true, "code": bk["credit_code"]})
			}
			if paid == 0 {
				return bad("No deposit was paid for this booking")
			}
			if !c.Has("issueCard") {
				return fmt.Errorf("issueCard hook is not available")
			}
			card, err := c.G("issueCard", M{"cents": paid, "name": "Room deposit: " + str(bk["name"]), "email": bk["email"], "source": "deposit", "userId": c.U.ID, "method": "card"})
			if err != nil {
				return err
			}
			code := crewMap(card)["code"]
			if _, err := c.Run(`UPDATE room_bookings SET credit_code = ? WHERE id = ?`, code, bk["id"]); err != nil {
				return err
			}
			if err := c.Audit("room.checkin", fmt.Sprintf("%s: deposit %s", str(bk["name"]), crewFmt(paid))); err != nil {
				return err
			}
			c.Notify("rooms")
			return c.JSON(M{"ok": true, "code": code})
		case "done":
			if _, err := c.Run(`UPDATE room_bookings SET status = 'done' WHERE id = ?`, bk["id"]); err != nil {
				return err
			}
		case "paid":
			b, err := c.Body(crewPaidSchema)
			if err != nil {
				return err
			}
			if _, err := c.Run(`UPDATE room_bookings SET deposit_paid_cents = deposit_paid_cents + ? WHERE id = ?`, b["cents"], bk["id"]); err != nil {
				return err
			}
		default:
			return notFound("Unknown action")
		}
		if err := c.Audit("room."+w, str(bk["name"])+" "+str(bk["date"])); err != nil {
			return err
		}
		c.Notify("rooms")
		return c.OK()
	})
	// Today's private events, for the floor.
	rt.staff("GET /rooms/today", "staff", func(c *C) error {
		bs, err := c.All(`SELECT * FROM room_bookings WHERE date = ? AND status = 'confirmed' ORDER BY start_time`, opsToday(c))
		if err != nil {
			return err
		}
		out := []M{}
		for _, b := range bs {
			v, err := c.crewBookingView(b)
			if err != nil {
				return err
			}
			if v["spendCents"], err = c.crewSpendFor(b); err != nil {
				return err
			}
			out = append(out, v)
		}
		return c.JSON(out)
	})

	// public
	leadDays := func(s map[string]string) (any, float64, string) {
		v := s["rooms_lead_days"]
		if v == "" {
			return 2.0, 2, "2"
		}
		f, ok := jsNumber(v)
		if !ok {
			return nil, math.NaN(), v
		}
		return f, f, v
	}
	rt.pub("GET /api/public/rooms", func(c *C) error {
		s := c.S()
		biz := M{"name": s["business_name"], "accent": s["accent"]}
		if s["rooms_online"] != "1" {
			return c.JSON(M{"enabled": false, "business": biz})
		}
		rs, err := c.All(`SELECT * FROM rooms WHERE active = 1 ORDER BY name`)
		if err != nil {
			return err
		}
		rooms := []M{}
		for _, r := range rs {
			v := M{"id": r["id"], "name": r["name"], "capacity": r["capacity"], "description": r["description"]}
			for k, x := range crewQuote(r) {
				v[k] = x
			}
			rooms = append(rooms, v)
		}
		ld, _, _ := leadDays(s)
		return c.JSON(M{"enabled": true, "business": biz, "currency": s["currency"], "leadDays": ld, "rooms": rooms})
	})
	rt.pub("GET /api/public/rooms/{id}/taken", func(c *C) error {
		d := c.Q("date")
		if !opsDateRE.MatchString(d) {
			return c.JSON([]any{})
		}
		rows, err := c.All(`SELECT start_time, end_time FROM room_bookings WHERE room_id = ? AND date = ? AND status IN ('requested','confirmed')`, c.crewNumParam("id"), d)
		if err != nil {
			return err
		}
		return c.JSON(rows)
	})
	rt.pub("POST /api/public/rooms/book", func(c *C) error {
		s := c.S()
		if s["rooms_online"] != "1" {
			return forbidden("Online room booking is off. Please call us.")
		}
		b, err := c.Body(crewBookSchema)
		if err != nil {
			return err
		}
		if !truthy(b["email"]) {
			return bad("Add your email so we can confirm")
		}
		_, ld, ldRaw := leadDays(s)
		if math.IsNaN(ld) || str(b["date"]) < crewAddDays(opsToday(c), ld) {
			return bad("Book at least " + ldRaw + " days ahead")
		}
		bk, err := c.crewCreateBooking(b, "online")
		if err != nil {
			return err
		}
		if err := c.AuditAs(nil, "room.request", fmt.Sprintf("%s %s %s", str(bk["name"]), str(bk["date"]), str(bk["start_time"])), c.IP()); err != nil {
			return err
		}
		c.Notify("rooms")
		c.alertOwners(s["business_name"]+": event request", fmt.Sprintf("%s asked for %d guests on %s %s–%s.", str(bk["name"]), i64(bk["guests"]), str(bk["date"]), str(bk["start_time"]), str(bk["end_time"])), "rooms")
		return c.JSON(M{"token": bk["token"], "url": "/event-room/" + str(bk["token"]) + c.crewLocQS()})
	}, a.publicLim())
	payEnabled := func(c *C) bool {
		v, err := c.G("onlinePayEnabled")
		return err == nil && truthy(v)
	}
	rt.pub("GET /api/v/{token}", func(c *C) error {
		b, err := c.One(`SELECT * FROM room_bookings WHERE token = ?`, c.Param("token"))
		if err != nil {
			return err
		}
		if b == nil {
			return notFound("Booking not found")
		}
		s := c.S()
		v, err := c.crewBookingView(b)
		if err != nil {
			return err
		}
		st := str(b["status"])
		canPay := i64(b["deposit_cents"]) > i64(b["deposit_paid_cents"]) && (st == "requested" || st == "confirmed") && payEnabled(c)
		return c.JSON(M{"business": M{"name": s["business_name"], "accent": s["accent"]}, "currency": s["currency"],
			"booking": M{"room": v["room"], "name": b["name"], "date": b["date"], "start": b["start_time"], "end": b["end_time"], "guests": b["guests"], "occasion": b["occasion"], "status": b["status"],
				"minSpendCents": b["min_spend_cents"], "feeCents": b["fee_cents"], "depositCents": b["deposit_cents"], "depositPaidCents": b["deposit_paid_cents"]},
			"canPay": canPay})
	})
	rt.pub("POST /api/v/{token}/pay", func(c *C) error {
		b, err := c.One(`SELECT * FROM room_bookings WHERE token = ?`, c.Param("token"))
		if err != nil {
			return err
		}
		if b == nil {
			return notFound("Booking not found")
		}
		owed := i64(b["deposit_cents"]) - i64(b["deposit_paid_cents"])
		if owed <= 0 {
			return conflict("The deposit is already paid")
		}
		if !payEnabled(c) {
			return fail(503, "Online payments are not set up. Please call us.")
		}
		meta, _ := json.Marshal(M{"roomBookingId": b["id"]})
		res, err := c.Run(`INSERT INTO payments (kind, amount_cents, method, label, meta) VALUES ('room', ?, 'card', ?, ?)`, owed, "Event deposit "+str(b["date"]), string(meta))
		if err != nil {
			return err
		}
		base := c.PublicBase()
		back := base + "/event-room/" + str(b["token"]) + c.crewLocQS()
		url, err := c.G("startPay", res.LastID, M{"base": base, "lines": []M{{"name": fmt.Sprintf("%s: event deposit (%s)", c.S()["business_name"], str(b["date"])), "cents": owed}}, "successUrl": back, "cancelUrl": back, "email": b["email"], "descr": "Event deposit"})
		if err != nil {
			return err
		}
		return c.JSON(M{"url": url})
	}, a.publicLim())
	// payHooks.room(paymentRow): an online event deposit came in.
	a.G["payHooks.room"] = func(c *C, args ...any) (any, error) {
		p := crewMap(args[0])
		meta := crewMap(jparse(p["meta"], M{}))
		b, err := c.One(`SELECT * FROM room_bookings WHERE id = ?`, i64(meta["roomBookingId"]))
		if err != nil || b == nil {
			return nil, err
		}
		if _, err := c.Run(`UPDATE room_bookings SET deposit_paid_cents = deposit_paid_cents + ? WHERE id = ?`, p["amount_cents"], b["id"]); err != nil {
			return nil, err
		}
		amt := crewFmt(i64(p["amount_cents"]))
		if err := c.AuditAs(nil, "room.deposit", str(b["name"])+": "+amt, ""); err != nil {
			return nil, err
		}
		c.Notify("rooms")
		c.alertOwners(c.S()["business_name"]+": event deposit", fmt.Sprintf("%s paid %s for %s.", str(b["name"]), amt, str(b["date"])), "rooms")
		return nil, nil
	}
}
