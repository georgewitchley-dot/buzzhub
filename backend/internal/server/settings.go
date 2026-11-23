package server

import (
	"encoding/json"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/georgewitchley-dot/buzzhub/backend/internal/valid"
)

// Business settings: the same fields and rules as the Node server's PUT /api/staff/settings.

func bit() valid.Schema { return valid.Union(valid.Literal("0"), valid.Literal("1")) }

func jsonList(max int) valid.Schema {
	return valid.String().Max(max).Refine(func(v string) bool { var a []any; return json.Unmarshal([]byte(v), &a) == nil && a != nil }, "Must be a list")
}

var looseEmail = regexp.MustCompile(`^\S+@\S+\.\S+$`)

func jsNumber(x any) (float64, bool) {
	switch v := x.(type) {
	case float64:
		return v, true
	case string:
		if strings.TrimSpace(v) == "" {
			return 0, true
		}
		var f float64
		if err := json.Unmarshal([]byte(v), &f); err == nil {
			return f, true
		}
	case bool:
		if v {
			return 1, true
		}
		return 0, true
	case nil:
		return 0, true
	}
	return 0, false
}

func feePair(r any) bool {
	a, ok := r.([]any)
	if !ok || len(a) != 2 {
		return false
	}
	for _, n := range a {
		f, ok := n.(float64)
		if !ok || f < 0 || f >= 100 {
			return false
		}
	}
	return true
}

type field struct {
	k string
	s valid.Schema
}

var settingsFields = []field{
	{"business_name", valid.String().Trim().Min(1).Max(60)},
	{"business_type", valid.Enum("restaurant", "cafe", "service")},
	{"unit_label", valid.String().Trim().Min(1).Max(20)},
	{"accent", valid.String().Regex(`^#[0-9a-fA-F]{6}$`)},
	{"currency", valid.String().Regex(`^[A-Z]{3}$`)},
	{"tax_rate", valid.Coerce().Min(0).Max(30)},
	{"avg_turn_minutes", valid.Coerce().Int().Min(1).Max(240)},
	{"idle_lock_minutes", valid.Coerce().Int().Min(1).Max(60)},
	{"self_checkin", bit()},
	{"welcome_message", valid.String().Trim().Max(240)},
	{"preorder_enabled", bit()},
	{"preorder_open_minutes", valid.Coerce().Int().Min(0).Max(240)},
	{"heads_up_minutes", valid.Coerce().Int().Min(0).Max(240)},
	{"sign_headline", valid.String().Trim().Min(1).Max(60)},
	{"timezone", valid.String().Refine(func(tz string) bool { _, err := time.LoadLocation(tz); return err == nil && tz != "" && tz != "Local" }, "Unknown time zone")},
	{"booking_enabled", bit()},
	{"booking_open", valid.String().Regex(`^([01]\d|2[0-3]):[0-5]\d$`)},
	{"booking_close", valid.String().Regex(`^([01]\d|2[0-3]):[0-5]\d$`)},
	{"booking_days", valid.String().Regex(`^[01]{7}$`)},
	{"booking_slot_minutes", valid.Coerce().Int().Min(5).Max(480)},
	{"booking_capacity", valid.Coerce().Int().Min(1).Max(50)},
	{"booking_days_ahead", valid.Coerce().Int().Min(1).Max(120)},
	{"booking_reminder_minutes", valid.Coerce().Int().Min(0).Max(1440)},
	{"kds_late_minutes", valid.Coerce().Int().Min(1).Max(120)},
	{"smart_waits", bit()},
	{"loyalty_enabled", bit()},
	{"loyalty_visits", valid.Coerce().Int().Min(2).Max(50)},
	{"loyalty_reward", valid.String().Trim().Min(1).Max(60)},
	{"feedback_enabled", bit()},
	{"feedback_delay_minutes", valid.Coerce().Int().Min(5).Max(1440)},
	{"feedback_review_threshold", valid.Coerce().Int().Min(3).Max(5)},
	{"review_url", valid.String().Trim().Max(300).Refine(func(u string) bool { return u == "" || strings.HasPrefix(u, "https://") }, "Review link must start with https://")},
	{"online_enabled", bit()},
	{"online_pickup", bit()},
	{"online_delivery", bit()},
	{"delivery_fee_cents", valid.Coerce().Int().Min(0).Max(10000)},
	{"delivery_min_cents", valid.Coerce().Int().Min(0).Max(100000)},
	{"delivery_area", valid.String().Trim().Max(120)},
	{"online_prep_minutes", valid.Coerce().Int().Min(1).Max(180)},
	{"online_pay_later", bit()},
	{"table_ordering", bit()},
	{"tip_pool_enabled", bit()},
	{"tip_pool_managers", bit()},
	{"forecast_city", valid.String().Trim().Max(80)},
	{"forecast_rain_pct", valid.Coerce().Int().Min(-60).Max(60)},
	{"staff_sales_per_hour_cents", valid.Coerce().Int().Min(1000).Max(1000000)},
	{"staff_min", valid.Coerce().Int().Min(0).Max(20)},
	{"booking_deposit_cents", valid.Coerce().Int().Min(0).Max(100000)},
	{"deposit_refund_hours", valid.Coerce().Int().Min(0).Max(168)},
	{"auto_birthday", bit()},
	{"auto_winback", bit()},
	{"auto_welcome", bit()},
	{"insights_summary", bit()},
	{"insights_alerts", bit()},
	{"auto_birthday_pct", valid.Coerce().Int().Min(1).Max(100)},
	{"auto_winback_pct", valid.Coerce().Int().Min(1).Max(100)},
	{"auto_welcome_pct", valid.Coerce().Int().Min(1).Max(100)},
	{"auto_winback_days", valid.Coerce().Int().Min(14).Max(365)},
	{"insights_hour", valid.Coerce().Int().Min(0).Max(23)},
	{"ot_weekly_hours", valid.Coerce().Int().Min(20).Max(80)},
	{"payroll_week_start", valid.Coerce().Int().Min(0).Max(6)},
	{"ot_alerts", bit()},
	{"break_after_hours", valid.Coerce().Min(2).Max(12)},
	{"food_cost_target", valid.Coerce().Int().Min(5).Max(80)},
	{"kiosk_reader_id", valid.String().Regex(`^(tmr_[A-Za-z0-9]+)?$`)},
	{"kiosk_message", valid.String().Trim().Max(120)},
	{"business_address", valid.String().Trim().Max(160)},
	{"chat_enabled", bit()},
	{"upsell_enabled", bit()},
	{"referral_enabled", bit()},
	{"recovery_enabled", bit()},
	{"screen_message", valid.String().Trim().Max(120)},
	{"sales_goals", valid.String().Max(200).Refine(func(v string) bool {
		var a []any
		if json.Unmarshal([]byte(v), &a) != nil || len(a) > 7 {
			return false
		}
		for _, x := range a {
			f, ok := jsNumber(x)
			if !ok || f != math.Trunc(f) || f < 0 {
				return false
			}
		}
		return true
	}, "Goals must be a list of 7 amounts")},
	{"table_long_minutes", valid.Coerce().Int().Min(0).Max(600)},
	{"labor_target_pct", valid.Coerce().Int().Min(5).Max(80)},
	{"catering_followup", bit()},
	{"app_punch", bit()},
	{"ot_guard", bit()},
	{"punch_geofence", bit()},
	{"punch_radius_m", valid.String().Regex(`^\d{2,4}$`)},
	{"biz_lat", valid.String().Regex(`^-?\d{1,2}(\.\d+)?$|^$`)},
	{"biz_lng", valid.String().Regex(`^-?\d{1,3}(\.\d+)?$|^$`)},
	{"punch_photo", bit()},
	{"handoff_notes", bit()},
	{"adp_company_code", valid.String().Trim().Max(10)},
	{"kds_expo", bit()},
	{"kds_pack", bit()},
	{"board_categories", jsonList(2000)},
	{"board_title", valid.String().Trim().Max(60)},
	{"board_rotate_seconds", valid.String().Regex(`^\d{1,3}$`)},
	{"board_cols", valid.Enum("1", "2", "3", "4")},
	{"board_photos", bit()},
	{"rooms_online", bit()},
	{"curbside", bit()},
	{"booking_preorder", bit()},
	{"preorder_reminder", bit()},
	{"booking_preorder_pay", bit()},
	{"auto_join_tables", bit()},
	{"prep_labels", bit()},
	{"print_tickets_auto", bit()},
	{"eod_print", bit()},
	{"eod_print_hour", valid.Coerce().Int().Min(0).Max(23)},
	{"receipt_qr", bit()},
	{"display_idle", bit()},
	{"prep_learn", bit()},
	{"remake_alerts", bit()},
	{"remake_alert_count", valid.Coerce().Int().Min(2).Max(20)},
	{"prep_split_hour", valid.Coerce().Int().Min(0).Max(23)},
	{"leftover_rollover", bit()},
	{"vip_arrival_alert", bit()},
	{"fire_reminders", bit()},
	{"auto_vip", bit()},
	{"auto_vip_members", bit()},
	{"auto_vip_spend_cents", valid.Coerce().Int().Min(0).Max(100000000)},
	{"pace_default_minutes", valid.Coerce().Int().Min(1).Max(120)},
	{"preorder_reminder_hour", valid.Coerce().Int().Min(0).Max(23)},
	{"delivery_signature_cents", valid.Coerce().Int().Min(0).Max(10000000)},
	{"photo_check", valid.Enum("off", "allergy", "special", "all")},
	{"course_gap_minutes", valid.String().Regex(`^\d{1,2}$`)},
	{"ingredient_86", bit()},
	{"makegood_minutes", valid.String().Regex(`^\d{1,3}$`)},
	{"makegood_item_id", valid.String().Regex(`^\d*$`)},
	{"makegood_pct", valid.String().Regex(`^\d{1,3}$`)},
	{"batch_radius_km", valid.String().Regex(`^\d{1,2}(\.\d)?$`)},
	{"batch_window_minutes", valid.String().Regex(`^\d{1,3}$`)},
	{"bar_tabs", bit()},
	{"area_alerts", bit()},
	{"area_alert_high", valid.String().Regex(`^\d{1,3}$`)},
	{"area_alert_quiet_minutes", valid.String().Regex(`^\d{1,3}$`)},
	{"pass_alert_minutes", valid.String().Regex(`^\d{1,2}$`)},
	{"slot_capacity", valid.String().Regex(`^\d{1,3}$`)},
	{"pickup_shelves", valid.String().Trim().Max(200)},
	{"kds_quick_messages", jsonList(1000)},
	{"dish_ratings", bit()},
	{"schedule_by_area", bit()},
	{"area_sales_per_hour_cents", valid.String().Regex(`^\d{3,7}$`)},
	{"smart_quotes", bit()},
	{"kitchen_parallel", valid.String().Regex(`^\d{1,2}$`)},
	{"rush_mode", valid.Enum("off", "auto")},
	{"rush_busy_tickets", valid.String().Regex(`^\d{1,3}$`)},
	{"rush_busy_late", valid.String().Regex(`^\d{1,3}$`)},
	{"rush_pause_tickets", valid.String().Regex(`^\d{1,3}$`)},
	{"rush_pause_late", valid.String().Regex(`^\d{1,3}$`)},
	{"rush_extra_minutes", valid.String().Regex(`^\d{1,3}$`)},
	{"shift_pulse", bit()},
	{"pulse_anonymous", bit()},
	{"tipout_at_clockout", bit()},
	{"curbside_prompt", valid.String().Trim().Max(60)},
	{"kds_allergy_check", bit()},
	{"kds_pacing", bit()},
	{"declare_tips", bit()},
	{"break_minutes_planned", valid.String().Regex(`^\d{1,3}$`)},
	{"rooms_lead_days", valid.String().Regex(`^\d{1,2}$`)},
	{"clock_message", valid.String().Trim().Max(120)},
	{"required_certs", jsonList(4000)},
	{"fixed_costs", jsonList(4000)},
	{"cash_balance_cents", valid.Coerce().Int().Min(-100000000).Max(1000000000)},
	{"cash_balance_on", valid.String().Regex(`^(\d{4}-\d{2}-\d{2})?$`)},
	{"payroll_dow", valid.Coerce().Int().Min(0).Max(6)},
	{"payroll_every", valid.Enum("weekly", "biweekly")},
	{"show_calories", bit()},
	{"pay_bank_enabled", bit()},
	{"menu_photos", bit()},
	{"catering_online", bit()},
	{"safe_log_enabled", bit()},
	{"safe_two_person", bit()},
	{"pay_bank_min_cents", valid.Coerce().Int().Min(1000).Max(10000000)},
	{"catering_lead_hours", valid.Coerce().Int().Min(1).Max(720)},
	{"catering_deposit_pct", valid.Coerce().Int().Min(0).Max(100)},
	{"catering_delivery_cents", valid.Coerce().Int().Min(0).Max(100000)},
	{"catering_min_cents", valid.Coerce().Int().Min(0).Max(10000000)},
	{"table_calls", bit()},
	{"weekly_report", bit()},
	{"auto_reorder", bit()},
	{"weekly_report_hour", valid.Coerce().Int().Min(0).Max(23)},
	{"report_email", valid.String().Trim().Max(300).Refine(func(v string) bool {
		if v == "" {
			return true
		}
		for _, e := range strings.Split(v, ",") {
			if !looseEmail.MatchString(strings.TrimSpace(e)) {
				return false
			}
		}
		return true
	}, "Enter email addresses separated by commas")},
	{"loyalty_tiers", jsonList(4000)},
	{"tipout_rules", jsonList(4000)},
	{"languages", valid.String().Max(200).Refine(func(v string) bool {
		var a []any
		if json.Unmarshal([]byte(v), &a) != nil {
			return false
		}
		en := false
		for _, x := range a {
			s, _ := x.(string)
			switch s {
			case "en":
				en = true
			case "es", "fr", "zh", "vi":
			default:
				return false
			}
		}
		return en
	}, "Pick the languages to offer")},
	{"labor_alerts", bit()},
	{"online_schedule", bit()},
	{"online_schedule_days", valid.Coerce().Int().Min(1).Max(60)},
	{"booking_duration_minutes", valid.Coerce().Int().Min(15).Max(600)},
	{"kitchen_stations", valid.String().Max(400).Refine(func(v string) bool {
		var a []any
		if json.Unmarshal([]byte(v), &a) != nil || len(a) < 1 || len(a) > 8 {
			return false
		}
		for _, x := range a {
			s, ok := x.(string)
			if !ok || strings.TrimSpace(s) == "" || utf8.RuneCountInString(s) > 20 {
				return false
			}
		}
		return true
	}, "Stations must be 1 to 8 names")},
	{"station_map", valid.String().Max(4000).Refine(func(v string) bool { var o map[string]any; return json.Unmarshal([]byte(v), &o) == nil && o != nil }, "Bad station map")},
	{"label_shelf_days", valid.Coerce().Int().Min(0).Max(365)},
	{"kitchen_slow_minutes", valid.Coerce().Int().Min(0).Max(240)},
	{"price_watch_pct", valid.Coerce().Int().Min(1).Max(100)},
	{"prep_buffer_pct", valid.Coerce().Int().Min(0).Max(100)},
	{"referral_reward_cents", valid.Coerce().Int().Min(100).Max(10000)},
	{"referral_min_cents", valid.Coerce().Int().Min(0).Max(100000)},
	{"recovery_max_rating", valid.Coerce().Int().Min(1).Max(3)},
	{"recovery_kind", valid.Enum("pct", "amount")},
	{"recovery_value", valid.Coerce().Int().Min(1).Max(100)},
	{"recovery_days", valid.Coerce().Int().Min(7).Max(180)},
	{"recovery_message", valid.String().Trim().Max(200)},
	{"chat_quick", valid.String().Max(1200).Refine(func(v string) bool {
		var a []any
		if json.Unmarshal([]byte(v), &a) != nil || len(a) > 8 {
			return false
		}
		for _, x := range a {
			s, ok := x.(string)
			if !ok || utf8.RuneCountInString(s) > 120 {
				return false
			}
		}
		return true
	}, "Quick replies look wrong")},
	{"business_phone", valid.String().Trim().Max(30)},
	{"acct_map", valid.String().Max(1500).Refine(func(v string) bool {
		var o map[string]any
		if json.Unmarshal([]byte(v), &o) != nil {
			var arr []any
			return json.Unmarshal([]byte(v), &arr) == nil && len(arr) == 0
		}
		for _, x := range o {
			s, ok := x.(string)
			if !ok || utf8.RuneCountInString(s) > 60 {
				return false
			}
		}
		return true
	}, "Account names look wrong")},
	{"pay_handles_enabled", bit()},
	{"pay_cashapp", valid.String().Trim().RegexMsg(`^(\$[A-Za-z][A-Za-z0-9_-]{0,20})?$`, "Cash App $cashtag looks wrong")},
	{"pay_venmo", valid.String().Trim().RegexMsg(`^(@?[A-Za-z0-9_-]{3,30})?$`, "Venmo username looks wrong")},
	{"pay_paypalme", valid.String().Trim().RegexMsg(`^([A-Za-z0-9]{1,20})?$`, "PayPal.me name looks wrong")},
	{"pay_zelle", valid.String().Trim().Max(80)},
	{"card_provider", valid.Enum("auto", "square", "stripe")},
	{"cash_discount_pct", valid.Coerce().Min(0).Max(4)},
	{"fee_rates", valid.String().Max(600).Refine(func(v string) bool {
		var o map[string]any
		if json.Unmarshal([]byte(v), &o) != nil {
			var arr []any
			if json.Unmarshal([]byte(v), &arr) != nil {
				return false
			}
			for _, r := range arr {
				if !feePair(r) {
					return false
				}
			}
			return true
		}
		for _, r := range o {
			if !feePair(r) {
				return false
			}
		}
		return true
	}, "Fee rates look wrong")},
	{"insights_void_limit", valid.Coerce().Int().Min(1).Max(50)},
	{"insights_refund_cents", valid.Coerce().Int().Min(100).Max(10000000)},
}

var settingsSchema = func() *valid.ObjectS {
	pairs := []any{}
	for _, f := range settingsFields {
		pairs = append(pairs, f.k, f.s)
	}
	return valid.Ordered(pairs...).Partial()
}()

// settingString stores a validated value the way JavaScript's String() prints it.
func settingString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case int64:
		return itoa(x)
	case float64:
		return fmtJSNum(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func fmtJSNum(f float64) string {
	if f == math.Trunc(f) && math.Abs(f) < 1e21 {
		return itoa(int64(f))
	}
	b, _ := json.Marshal(f)
	return string(b)
}

func (a *App) putSettings(c *C) error {
	body, err := c.Body(settingsSchema)
	if err != nil {
		return err
	}
	kv := map[string]string{}
	keys := []string{}
	for _, k := range settingsSchema.Keys() {
		if v, ok := body[k]; ok {
			kv[k] = settingString(v)
			keys = append(keys, k)
		}
	}
	if err := c.Tx.SetSettings(c.Ctx, kv); err != nil {
		return err
	}
	if tz, ok := kv["timezone"]; ok {
		if _, err := c.Run(`SELECT set_config('buzzhub.tz', ?, true)`, tz); err != nil {
			return err
		}
	}
	if err := c.Audit("settings.update", strings.Join(keys, ", ")); err != nil {
		return err
	}
	c.Refresh()
	all := c.settingsOut()
	c.Emit("all", "settings", all)
	if err := c.pushAllWaiting(); err != nil {
		return err
	}
	return c.JSON(all)
}

// settingsOut is getSettings() as JSON (plain settings, no extras).
func (c *C) settingsOut() M {
	out := M{}
	for k, v := range c.S() {
		out[k] = v
	}
	return out
}

var _ = time.Now
var _ = utf8.RuneLen
