package cursor

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func costFixture(t *testing.T) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/cost.json")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseCost(t *testing.T) {
	u, err := ParseCost(costFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if !u.Plan || u.Note != "" || len(u.Limits) != 1 {
		t.Fatalf("usage %+v", u)
	}
	l := u.Limits[0]
	if l.Kind != "individual.overall" || l.Label != "Your usage" || l.Detail != "$413.89 of $1,101" || !l.Active ||
		l.Percent < 37.59 || l.Percent > 37.6 || !l.ResetsAt.Equal(time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("limit %+v", l)
	}
	if u.FetchedAt.IsZero() || !u.FetchedAt.Equal(time.Date(2026, 9, 27, 11, 17, 22, 594086000, time.UTC)) {
		t.Fatalf("fetchedAt %v: want the cache's updated_at", u.FetchedAt)
	}
}

// A failed status keeps the last good numbers, with the error as the note.
func TestParseCostError(t *testing.T) {
	u, err := ParseCost([]byte(`{"status":"error","bucket":"individual.overall","used":10,"limit":20,
		"buckets":[{"key":"individual.overall","used":10,"limit":20},{"key":"team.onDemand","used":0,"limit":null}],
		"updated_at":"2026-09-27T13:10:11+02:00","error":"refresh failed: 401"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !u.Plan || u.Note != "refresh failed: 401" || len(u.Limits) != 1 || u.Limits[0].Percent != 50 {
		t.Fatalf("usage %+v", u)
	}
}

func TestParseCostNoPlan(t *testing.T) {
	cases := []struct{ out, note string }{
		{`{"status":"no_cache","used":null,"limit":null,"error":"no cache file (is cursor-cost-refresh running?)"}`,
			"no cache file (is cursor-cost-refresh running?)"},
		{`{"status":"not_logged_in","used":null,"limit":null}`, "cursor-cost: not logged in"},
		{`{"status":"ok","unlimited":true,"used":5,"limit":null,"buckets":[{"key":"individual.overall","used":5,"limit":null}]}`,
			"Your Cursor plan has no usage limit."},
		{`{"status":"ok","used":null,"limit":null}`, "Cursor reported no usage limits."},
	}
	for _, c := range cases {
		u, err := ParseCost([]byte(c.out))
		if err != nil {
			t.Fatal(err)
		}
		if u.Plan || u.Note != c.note || u.Limits == nil || len(u.Limits) != 0 {
			t.Errorf("%s: usage %+v", c.out, u)
		}
	}
	for _, out := range []string{``, `not json`, `{}`} {
		if _, err := ParseCost([]byte(out)); err == nil {
			t.Errorf("%q: want an error", out)
		}
	}
}

func TestBucketLabel(t *testing.T) {
	for key, want := range map[string]string{
		"individual.overall":  "Your usage",
		"individual.onDemand": "Your usage (on demand)",
		"team.onDemand":       "Team on demand",
		"other.fooBar":        "Foo bar",
	} {
		if got := bucketLabel(key); got != want {
			t.Errorf("bucketLabel(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestDollars(t *testing.T) {
	for v, want := range map[float64]string{0: "$0", 413.89: "$413.89", 1101: "$1,101", 1234567.5: "$1,234,567.50", -3: "-$3"} {
		if got := dollars(v); got != want {
			t.Errorf("dollars(%v) = %q, want %q", v, got, want)
		}
	}
}

// fakeCost writes a cursor-cost that records its arguments and prints the fixture.
func fakeCost(t *testing.T, dir, name string) (bin, args string) {
	t.Helper()
	fixture, _ := filepath.Abs("testdata/cost.json")
	args = filepath.Join(t.TempDir(), "args")
	bin = filepath.Join(dir, name)
	script := "#!/bin/sh\necho \"$@\" > '" + args + "'\ncat '" + fixture + "'\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, args
}

func TestCostReaderUsage(t *testing.T) {
	bin, args := fakeCost(t, t.TempDir(), "cursor-cost")
	u, err := (&CostReader{Bin: bin}).Usage()
	if err != nil {
		t.Fatal(err)
	}
	if !u.Plan || len(u.Limits) != 1 {
		t.Fatalf("usage %+v", u)
	}
	got, _ := os.ReadFile(args)
	if !slices.Equal(strings.Fields(string(got)), CostArgs()) {
		t.Fatalf("ran with %q", got)
	}
}

// Not on PATH: ~/bin/<Bin>.
func TestCostReaderHomeBin(t *testing.T) {
	home := t.TempDir()
	os.Mkdir(filepath.Join(home, "bin"), 0o755)
	fakeCost(t, filepath.Join(home, "bin"), "cursor-cost-test-only")
	if _, err := (&CostReader{Bin: "cursor-cost-test-only", Home: home}).Usage(); err != nil {
		t.Fatal(err)
	}
	_, err := (&CostReader{Bin: "cursor-cost-test-only", Home: t.TempDir()}).Usage()
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err %v", err)
	}
}
