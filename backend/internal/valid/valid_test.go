package valid

import (
	"encoding/json"
	"testing"
)

func run(t *testing.T, s Schema, in string, want string) {
	t.Helper()
	var d any
	_ = json.Unmarshal([]byte(in), &d)
	out, err := Parse(s, d)
	got := ""
	if err != nil {
		got = "ERR " + err.Error()
	} else {
		b, _ := json.Marshal(out)
		got = string(b)
	}
	if got != want {
		t.Errorf("%s: got %s want %s", in, got, want)
	}
}

func TestLikeZod(t *testing.T) {
	o := func(f Schema) *ObjectS { return Object(map[string]Schema{"a": f}) }
	run(t, o(String().Trim().Min(1).Max(3)), `{"a":"  "}`, `ERR a: Too small: expected string to have >=1 characters`)
	run(t, o(String().Trim().Max(3)), `{"a":" ab "}`, `{"a":"ab"}`)
	run(t, o(Int().Min(1)), `{"a":0}`, `ERR a: Too small: expected number to be >=1`)
	run(t, o(Int()), `{"a":1.5}`, `ERR a: Invalid input: expected int, received number`)
	run(t, o(String()), `{}`, `ERR a: Invalid input: expected string, received undefined`)
	run(t, o(String().Optional()), `{"b":1}`, `{}`)
	run(t, o(Enum("x", "y")), `{"a":"q"}`, `ERR a: Invalid option: expected one of "x"|"y"`)
	run(t, o(Int().Default(2)), `{}`, `{"a":2}`)
	run(t, o(Int().Catch(Undefined)), `{"a":"z"}`, `{}`)
	run(t, o(Coerce().Int()), `{"a":"7"}`, `{"a":7}`)
	run(t, o(String().Trim().Email().Max(120).Optional().Or(Literal(""))), `{"a":""}`, `{"a":""}`)
	run(t, o(String().Trim().Email().Max(120).Optional().Or(Literal(""))), `{"a":"bad"}`, `ERR a: Invalid email address`)
	run(t, o(Array(Object(map[string]Schema{"b": String()})).Max(2)), `{"a":[{}]}`, `ERR a.0.b: Invalid input: expected string, received undefined`)
	run(t, o(Number().Nullable()), `{"a":null}`, `{"a":null}`)
	run(t, o(String().Regex(`^a$`)), `{"a":"b"}`, `ERR a: Invalid string: must match pattern /^a$/`)
}
