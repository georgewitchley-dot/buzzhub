// Package valid checks request bodies the way the Node server's zod schemas do, with the same
// rules and error messages ("name: Too small: expected string to have >=1 characters"), so the
// React client sees identical answers from either backend.
package valid

import (
	"encoding/json"
	"fmt"
	"math"
	"net/mail"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Schema parses one value. present=false means the key was absent (undefined in JS).
type Schema interface {
	parse(v any, present bool, path string, errs *[]string) (out any, outPresent bool, ok bool)
}

func add(errs *[]string, path, msg string) {
	if path == "" {
		path = "input"
	}
	*errs = append(*errs, path+": "+msg)
}
func join(path, k string) string {
	if path == "" {
		return k
	}
	return path + "." + k
}

func typeName(v any, present bool) string {
	if !present {
		return "undefined"
	}
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64, int64, int, json.Number:
		_ = x
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	}
	return "unknown"
}

// Parse validates data (a decoded JSON body) and returns the cleaned value or an error message.
func Parse(s Schema, data any) (any, error) {
	var errs []string
	out, _, ok := s.parse(data, data != nil || true, "", &errs)
	if !ok || len(errs) > 0 {
		return nil, fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return out, nil
}

// Obj is Parse for object schemas.
func Obj(s *ObjectS, data any) (M, error) {
	if data == nil {
		data = map[string]any{}
	}
	v, err := Parse(s, data)
	if err != nil {
		return nil, err
	}
	return v.(M), nil
}

// Undefined is used with Catch to drop a bad value (zod's .catch(undefined)).
var Undefined any = &struct{ undefined bool }{true}

// M is a validated object; getters return zero values for absent keys.
type M = map[string]any

/* ---------- wrappers shared by every type: optional / nullable / default / catch / refine ---------- */

type mods struct {
	optional, nullable bool
	hasDef             bool
	def                any
	hasCatch           bool
	catch              any
	refines            []refine
	or                 []Schema
}
type refine struct {
	fn  func(any) bool
	msg string
}

func (m *mods) wrap(v any, present bool, path string, errs *[]string, inner func(any, string, *[]string) (any, bool)) (any, bool, bool) {
	if m.hasCatch {
		var local []string
		out, p, ok := m.wrapNoCatch(v, present, path, &local, inner)
		if !ok || len(local) > 0 {
			if m.catch == Undefined {
				return nil, false, true
			}
			return m.catch, true, true
		}
		return out, p, true
	}
	return m.wrapNoCatch(v, present, path, errs, inner)
}

func (m *mods) wrapNoCatch(v any, present bool, path string, errs *[]string, inner func(any, string, *[]string) (any, bool)) (any, bool, bool) {
	if len(m.or) > 0 {
		var local []string
		out, p, ok := m.base(v, present, path, &local, inner)
		if ok && len(local) == 0 {
			return out, p, true
		}
		for _, alt := range m.or {
			var l2 []string
			o2, p2, ok2 := alt.parse(v, present, path, &l2)
			if ok2 && len(l2) == 0 {
				return o2, p2, true
			}
		}
		*errs = append(*errs, local...)
		return nil, false, false
	}
	return m.base(v, present, path, errs, inner)
}

func (m *mods) base(v any, present bool, path string, errs *[]string, inner func(any, string, *[]string) (any, bool)) (any, bool, bool) {
	if !present {
		if m.hasDef {
			return m.def, true, true
		}
		if m.optional {
			return nil, false, true
		}
	}
	if present && v == nil && m.nullable {
		return nil, true, true
	}
	n := len(*errs)
	out, ok := inner(v, path, errs)
	if !ok || len(*errs) > n {
		return nil, false, false
	}
	for _, r := range m.refines {
		if !r.fn(out) {
			msg := r.msg
			if msg == "" {
				msg = "Invalid input"
			}
			add(errs, path, msg)
			return nil, false, false
		}
	}
	return out, true, true
}

/* ---------- strings ---------- */

type StringS struct {
	mods
	trim, lower, upper bool
	min, max, length   int
	hasMin, hasMax     bool
	hasLen             bool
	re                 []*regexp.Regexp
	reMsg              []string
	email, url         bool
	emailMsg           string
}

func String() *StringS                { return &StringS{} }
func (s *StringS) Trim() *StringS     { s.trim = true; return s }
func (s *StringS) Lower() *StringS    { s.lower = true; return s }
func (s *StringS) Upper() *StringS    { s.upper = true; return s }
func (s *StringS) Min(n int) *StringS { s.min, s.hasMin = n, true; return s }
func (s *StringS) Max(n int) *StringS { s.max, s.hasMax = n, true; return s }
func (s *StringS) Len(n int) *StringS { s.length, s.hasLen = n, true; return s }
func (s *StringS) Regex(p string) *StringS {
	s.re = append(s.re, regexp.MustCompile(p))
	s.reMsg = append(s.reMsg, "")
	return s
}

// RegexMsg is .regex(pattern, message).
func (s *StringS) RegexMsg(p, msg string) *StringS {
	s.re = append(s.re, regexp.MustCompile(p))
	s.reMsg = append(s.reMsg, msg)
	return s
}
func (s *StringS) Email(msg ...string) *StringS {
	s.email = true
	if len(msg) > 0 {
		s.emailMsg = msg[0]
	}
	return s
}
func (s *StringS) URL() *StringS             { s.url = true; return s }
func (s *StringS) Optional() *StringS        { s.optional = true; return s }
func (s *StringS) Nullable() *StringS        { s.nullable = true; return s }
func (s *StringS) Default(v string) *StringS { s.hasDef, s.def = true, v; return s }
func (s *StringS) Catch(v any) *StringS      { s.hasCatch, s.catch = true, v; return s }
func (s *StringS) Or(o ...Schema) *StringS   { s.or = append(s.or, o...); return s }
func (s *StringS) Refine(f func(string) bool, msg string) *StringS {
	s.refines = append(s.refines, refine{func(v any) bool { x, _ := v.(string); return f(x) }, msg})
	return s
}

var emailRe = regexp.MustCompile(`^(?i)[a-z0-9_'+\-]+(?:\.[a-z0-9_'+\-]+)*@(?:[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?\.)+[a-z]{2,}$`)

func (s *StringS) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	return s.wrap(v, present, path, errs, func(v any, path string, errs *[]string) (any, bool) {
		str, ok := v.(string)
		if !ok {
			add(errs, path, "Invalid input: expected string, received "+typeName(v, present))
			return nil, false
		}
		if s.trim {
			str = strings.TrimSpace(str)
		}
		if s.lower {
			str = strings.ToLower(str)
		}
		if s.upper {
			str = strings.ToUpper(str)
		}
		n := utf16Len(str)
		if s.hasLen && n != s.length {
			if n > s.length {
				add(errs, path, fmt.Sprintf("Too big: expected string to have exactly %d characters", s.length))
			} else {
				add(errs, path, fmt.Sprintf("Too small: expected string to have exactly %d characters", s.length))
			}
		}
		if s.hasMin && n < s.min {
			add(errs, path, fmt.Sprintf("Too small: expected string to have >=%d characters", s.min))
		}
		if s.hasMax && n > s.max {
			add(errs, path, fmt.Sprintf("Too big: expected string to have <=%d characters", s.max))
		}
		for i, re := range s.re {
			if !re.MatchString(str) {
				if s.reMsg[i] != "" {
					add(errs, path, s.reMsg[i])
				} else {
					add(errs, path, "Invalid string: must match pattern /"+re.String()+"/")
				}
			}
		}
		if s.email {
			if _, err := mail.ParseAddress(str); err != nil || !emailRe.MatchString(str) {
				if s.emailMsg != "" {
					add(errs, path, s.emailMsg)
				} else {
					add(errs, path, "Invalid email address")
				}
			}
		}
		if s.url {
			if u, err := url.Parse(str); err != nil || u.Scheme == "" || (u.Host == "" && u.Opaque == "") {
				add(errs, path, "Invalid URL")
			}
		}
		return str, true
	})
}

// utf16Len counts like JavaScript's string.length.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	_ = utf8.RuneError
	return n
}

/* ---------- numbers ---------- */

type NumberS struct {
	mods
	isInt, coerce  bool
	min, max       float64
	hasMin, hasMax bool
	gt, hasGt      bool
	minExcl        float64
}

func Number() *NumberS { return &NumberS{} }
func Int() *NumberS    { return &NumberS{isInt: true} }

// Coerce is z.coerce.number(): strings and booleans are turned into numbers first.
func Coerce() *NumberS                        { return &NumberS{coerce: true} }
func (s *NumberS) Int() *NumberS              { s.isInt = true; return s }
func (s *NumberS) Min(n float64) *NumberS     { s.min, s.hasMin = n, true; return s }
func (s *NumberS) Max(n float64) *NumberS     { s.max, s.hasMax = n, true; return s }
func (s *NumberS) Positive() *NumberS         { s.minExcl, s.hasGt = 0, true; return s }
func (s *NumberS) NonNegative() *NumberS      { return s.Min(0) }
func (s *NumberS) Optional() *NumberS         { s.optional = true; return s }
func (s *NumberS) Nullable() *NumberS         { s.nullable = true; return s }
func (s *NumberS) Default(v float64) *NumberS { s.hasDef, s.def = true, s.num(v); return s }
func (s *NumberS) Catch(v any) *NumberS       { s.hasCatch, s.catch = true, v; return s }
func (s *NumberS) Or(o ...Schema) *NumberS    { s.or = append(s.or, o...); return s }
func (s *NumberS) Refine(f func(float64) bool, msg string) *NumberS {
	s.refines = append(s.refines, refine{func(v any) bool { return f(ToFloat(v)) }, msg})
	return s
}

func (s *NumberS) num(f float64) any {
	if f == math.Trunc(f) && math.Abs(f) < 1<<53 {
		return int64(f)
	}
	return f
}

func (s *NumberS) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	return s.wrap(v, present, path, errs, func(v any, path string, errs *[]string) (any, bool) {
		var f float64
		switch x := v.(type) {
		case float64:
			f = x
		case int64:
			f = float64(x)
		case int:
			f = float64(x)
		case json.Number:
			f, _ = x.Float64()
		default:
			if s.coerce {
				switch y := v.(type) {
				case string:
					t := strings.TrimSpace(y)
					if t == "" {
						f = 0
					} else if p, err := strconv.ParseFloat(t, 64); err == nil {
						f = p
					} else {
						f = math.NaN()
					}
				case bool:
					if y {
						f = 1
					}
				case nil:
					if present {
						f = 0
					} else {
						f = math.NaN()
					}
				default:
					f = math.NaN()
				}
				if math.IsNaN(f) {
					add(errs, path, "Invalid input: expected number, received NaN")
					return nil, false
				}
			} else {
				add(errs, path, "Invalid input: expected number, received "+typeName(v, present))
				return nil, false
			}
		}
		if math.IsInf(f, 0) || math.IsNaN(f) {
			add(errs, path, "Invalid input: expected number, received number")
			return nil, false
		}
		if s.isInt && (f != math.Trunc(f) || math.Abs(f) > 9007199254740991) {
			add(errs, path, "Invalid input: expected int, received number")
			return nil, false
		}
		if s.hasGt && f <= s.minExcl {
			add(errs, path, "Too small: expected number to be >"+fmtNum(s.minExcl))
		}
		if s.hasMin && f < s.min {
			add(errs, path, "Too small: expected number to be >="+fmtNum(s.min))
		}
		if s.hasMax && f > s.max {
			add(errs, path, "Too big: expected number to be <="+fmtNum(s.max))
		}
		return s.num(f), true
	})
}

func fmtNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

/* ---------- booleans, enums, literals ---------- */

type BoolS struct{ mods }

func Bool() *BoolS                     { return &BoolS{} }
func (s *BoolS) Optional() *BoolS      { s.optional = true; return s }
func (s *BoolS) Nullable() *BoolS      { s.nullable = true; return s }
func (s *BoolS) Default(v bool) *BoolS { s.hasDef, s.def = true, v; return s }
func (s *BoolS) Catch(v any) *BoolS    { s.hasCatch, s.catch = true, v; return s }
func (s *BoolS) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	return s.wrap(v, present, path, errs, func(v any, path string, errs *[]string) (any, bool) {
		b, ok := v.(bool)
		if !ok {
			add(errs, path, "Invalid input: expected boolean, received "+typeName(v, present))
			return nil, false
		}
		return b, true
	})
}

type EnumS struct {
	mods
	vals []string
}

func Enum(vals ...string) *EnumS         { return &EnumS{vals: vals} }
func (s *EnumS) Optional() *EnumS        { s.optional = true; return s }
func (s *EnumS) Nullable() *EnumS        { s.nullable = true; return s }
func (s *EnumS) Default(v string) *EnumS { s.hasDef, s.def = true, v; return s }
func (s *EnumS) Catch(v any) *EnumS      { s.hasCatch, s.catch = true, v; return s }
func (s *EnumS) Or(o ...Schema) *EnumS   { s.or = append(s.or, o...); return s }
func (s *EnumS) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	return s.wrap(v, present, path, errs, func(v any, path string, errs *[]string) (any, bool) {
		str, ok := v.(string)
		if ok {
			for _, e := range s.vals {
				if e == str {
					return str, true
				}
			}
		}
		q := make([]string, len(s.vals))
		for i, e := range s.vals {
			q[i] = strconv.Quote(e)
		}
		if len(q) == 1 {
			add(errs, path, "Invalid input: expected "+q[0])
		} else {
			add(errs, path, "Invalid option: expected one of "+strings.Join(q, "|"))
		}
		return nil, false
	})
}

type LiteralS struct {
	mods
	val any
}

func Literal(v any) *LiteralS           { return &LiteralS{val: v} }
func (s *LiteralS) Optional() *LiteralS { s.optional = true; return s }
func (s *LiteralS) Nullable() *LiteralS { s.nullable = true; return s }
func (s *LiteralS) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	return s.wrap(v, present, path, errs, func(v any, path string, errs *[]string) (any, bool) {
		if present && equal(v, s.val) {
			return s.val, true
		}
		b, _ := json.Marshal(s.val)
		add(errs, path, "Invalid input: expected "+string(b))
		return nil, false
	})
}

func equal(a, b any) bool {
	if fa, ok := numeric(a); ok {
		fb, ok2 := numeric(b)
		return ok2 && fa == fb
	}
	return a == b
}
func numeric(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int64:
		return float64(x), true
	case int:
		return float64(x), true
	}
	return 0, false
}

/* ---------- arrays, objects, unions ---------- */

type ArrayS struct {
	mods
	el             Schema
	min, max       int
	hasMin, hasMax bool
}

func Array(el Schema) *ArrayS             { return &ArrayS{el: el} }
func (s *ArrayS) Min(n int) *ArrayS       { s.min, s.hasMin = n, true; return s }
func (s *ArrayS) Max(n int) *ArrayS       { s.max, s.hasMax = n, true; return s }
func (s *ArrayS) Optional() *ArrayS       { s.optional = true; return s }
func (s *ArrayS) Nullable() *ArrayS       { s.nullable = true; return s }
func (s *ArrayS) Default(v []any) *ArrayS { s.hasDef, s.def = true, v; return s }
func (s *ArrayS) Catch(v any) *ArrayS     { s.hasCatch, s.catch = true, v; return s }
func (s *ArrayS) Refine(f func([]any) bool, msg string) *ArrayS {
	s.refines = append(s.refines, refine{func(v any) bool { x, _ := v.([]any); return f(x) }, msg})
	return s
}
func (s *ArrayS) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	return s.wrap(v, present, path, errs, func(v any, path string, errs *[]string) (any, bool) {
		arr, ok := v.([]any)
		if !ok {
			add(errs, path, "Invalid input: expected array, received "+typeName(v, present))
			return nil, false
		}
		if s.hasMin && len(arr) < s.min {
			add(errs, path, fmt.Sprintf("Too small: expected array to have >=%d items", s.min))
		}
		if s.hasMax && len(arr) > s.max {
			add(errs, path, fmt.Sprintf("Too big: expected array to have <=%d items", s.max))
			return nil, false
		}
		out := make([]any, 0, len(arr))
		for i, el := range arr {
			o, _, _ := s.el.parse(el, true, join(path, strconv.Itoa(i)), errs)
			out = append(out, o)
		}
		return out, true
	})
}

type ObjectS struct {
	mods
	fields map[string]Schema
	order  []string
}

// Object takes the field schemas. Unknown keys are dropped, as zod does by default.
func Object(fields map[string]Schema) *ObjectS {
	o := &ObjectS{fields: fields}
	for k := range fields {
		o.order = append(o.order, k)
	}
	sort.Strings(o.order)
	return o
}
func (s *ObjectS) Optional() *ObjectS   { s.optional = true; return s }
func (s *ObjectS) Nullable() *ObjectS   { s.nullable = true; return s }
func (s *ObjectS) Default(v M) *ObjectS { s.hasDef, s.def = true, v; return s }
func (s *ObjectS) Catch(v any) *ObjectS { s.hasCatch, s.catch = true, v; return s }
func (s *ObjectS) Refine(f func(M) bool, msg string) *ObjectS {
	s.refines = append(s.refines, refine{func(v any) bool { x, _ := v.(M); return f(x) }, msg})
	return s
}

// Ordered creates an object whose output keeps this key order (pairs of name, schema).
func Ordered(pairs ...any) *ObjectS {
	o := &ObjectS{fields: map[string]Schema{}}
	for i := 0; i+1 < len(pairs); i += 2 {
		k := pairs[i].(string)
		o.fields[k] = pairs[i+1].(Schema)
		o.order = append(o.order, k)
	}
	return o
}

// Keys lists the schema's keys in order.
func (s *ObjectS) Keys() []string { return s.order }

// Partial makes every field optional (z.object().partial()).
func (s *ObjectS) Partial() *ObjectS {
	n := &ObjectS{fields: map[string]Schema{}, order: s.order}
	for k, f := range s.fields {
		n.fields[k] = optional{f}
	}
	return n
}

// Extend returns a copy with more fields.
func (s *ObjectS) Extend(fields map[string]Schema) *ObjectS {
	all := map[string]Schema{}
	for k, f := range s.fields {
		all[k] = f
	}
	for k, f := range fields {
		all[k] = f
	}
	return Object(all)
}

type optional struct{ Schema }

func (o optional) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	if !present {
		return nil, false, true
	}
	return o.Schema.parse(v, present, path, errs)
}

// Opt makes any schema optional.
func Opt(s Schema) Schema { return optional{s} }

func (s *ObjectS) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	return s.wrap(v, present, path, errs, func(v any, path string, errs *[]string) (any, bool) {
		obj, ok := v.(map[string]any)
		if !ok {
			add(errs, path, "Invalid input: expected object, received "+typeName(v, present))
			return nil, false
		}
		out := M{}
		for _, k := range s.order {
			raw, has := obj[k]
			o, p, _ := s.fields[k].parse(raw, has, join(path, k), errs)
			if p {
				out[k] = o
			}
		}
		return out, true
	})
}

type UnionS struct {
	mods
	opts []Schema
}

func Union(opts ...Schema) *UnionS      { return &UnionS{opts: opts} }
func (s *UnionS) Optional() *UnionS     { s.optional = true; return s }
func (s *UnionS) Nullable() *UnionS     { s.nullable = true; return s }
func (s *UnionS) Default(v any) *UnionS { s.hasDef, s.def = true, v; return s }
func (s *UnionS) Catch(v any) *UnionS   { s.hasCatch, s.catch = true, v; return s }
func (s *UnionS) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	return s.wrap(v, present, path, errs, func(v any, path string, errs *[]string) (any, bool) {
		for _, o := range s.opts {
			var local []string
			out, _, ok := o.parse(v, present, path, &local)
			if ok && len(local) == 0 {
				return out, true
			}
		}
		add(errs, path, "Invalid input")
		return nil, false
	})
}

// Any accepts anything (z.any()).
type AnyS struct{ mods }

func Any() *AnyS { return &AnyS{} }
func (s *AnyS) parse(v any, present bool, path string, errs *[]string) (any, bool, bool) {
	return v, present, true
}

/* ---------- reading validated values ---------- */

func ToFloat(v any) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case int64:
		return float64(x)
	case int:
		return float64(x)
	case bool:
		if x {
			return 1
		}
	case string:
		f, _ := strconv.ParseFloat(x, 64)
		return f
	}
	return 0
}
