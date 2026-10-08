package testset

import (
	"flag"
	"fmt"
	"os"
	"testing"
)

// short reads the -short flag itself, so that the tests do not check Full against the very call it
// is made of.
func short() bool { return flag.Lookup("test.short").Value.String() == "true" }

// Full is true only for AIWB_TEST_FULL=1, and never with -short.
func TestFull(t *testing.T) {
	for _, c := range []struct {
		name, value string
		set         bool
		want        bool
	}{
		{name: "unset"},
		{name: "empty", set: true},
		{name: "1", value: "1", set: true, want: true},
		{name: "0", value: "0", set: true},
		{name: "true", value: "true", set: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv(Env, c.value) // restores the variable when the subtest ends
			if !c.set {
				os.Unsetenv(Env)
			}
			want := c.want && !short()
			if got := Full(); got != want {
				t.Fatalf("Full() with %s=%q (set: %v, -short: %v) = %v, want %v", Env, c.value, c.set, short(), got, want)
			}
		})
	}
}

// SkipUnlessFull skips in the default set, with the variable and the reason in the message, and
// lets the test run in the full set.
func TestSkipUnlessFull(t *testing.T) {
	t.Run("default set", func(t *testing.T) {
		t.Setenv(Env, "")
		tb := &recorder{TB: t}
		SkipUnlessFull(tb, "node test")
		if want := "full set only (AIWB_TEST_FULL=1): node test"; tb.skipped != want {
			t.Fatalf("skip message = %q, want %q", tb.skipped, want)
		}
	})
	t.Run("full set", func(t *testing.T) {
		if short() {
			t.Skip("-short: the full set never runs")
		}
		t.Setenv(Env, "1")
		tb := &recorder{TB: t}
		SkipUnlessFull(tb, "node test")
		if tb.skipped != "" {
			t.Fatalf("skipped in the full set: %q", tb.skipped)
		}
	})
}

// recorder is a testing.TB that records a skip and does not stop the test.
type recorder struct {
	testing.TB
	skipped string
}

func (r *recorder) Helper() {}

func (r *recorder) Skipf(format string, args ...any) { r.skipped = fmt.Sprintf(format, args...) }
