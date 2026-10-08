package cursor

import (
	"encoding/json"
	"fmt"
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
	for v, want := range map[float64]string{0: "$0", 413.89: "$413.89", 1101: "$1,101", 1234567.5: "$1,234,567.50", -3: "-$3"} {
		if got := dollars(v); got != want {
			t.Errorf("dollars(%v) = %q, want %q", v, got, want)
		}
	}
}

// fakeCost puts a cursor-cost at dir/name that records its arguments and prints the fixture. It
// is a link to the test binary, as the fake agent is (fake_test.go), not a script: macOS checks a
// newly written script on its first run, one at a time for the whole machine, and on a loaded
// machine that alone took longer than costTimeout.
func fakeCost(t *testing.T, dir, name string, vars map[string]string) (bin, args string) {
	t.Helper()
	fixture, err := filepath.Abs("testdata/cost.json")
	if err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args = filepath.Join(t.TempDir(), "args")
	bin = filepath.Join(dir, name)
	if err := os.Symlink(self, bin); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"FAKE_COST_ARGS": args, "FAKE_COST_OUT": fixture}
	for k, v := range vars {
		env[k] = v
	}
	b, err := json.Marshal(env)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, fakeEnvFile), b, 0o644); err != nil {
		t.Fatal(err)
	}
	return bin, args
}

// runFakeCost is the test binary as cursor-cost (FAKE_COST_ARGS is set): it writes its arguments
// to that file, one per line, and prints the file FAKE_COST_OUT. With FAKE_COST_HANG it then
// never answers: it stays for fakeStays.
func runFakeCost(argsFile string) {
	os.WriteFile(argsFile, []byte(strings.Join(os.Args[1:], "\n")), 0o644)
	if os.Getenv("FAKE_COST_HANG") != "" {
		time.Sleep(fakeStays)
		os.Exit(0)
	}
	b, err := os.ReadFile(os.Getenv("FAKE_COST_OUT"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake: ", err)
		os.Exit(2)
	}
	os.Stdout.Write(b)
	os.Exit(0)
}

// The tests give Usage mustHappen for the start of the fake: the 10 s of costTimeout are for a
// program that reads one small file, not for a process start on a machine busy starting others.
func TestCostReaderUsage(t *testing.T) {
	t.Parallel()
	bin, args := fakeCost(t, t.TempDir(), "cursor-cost", nil)
	u, err := (&CostReader{Bin: bin, timeout: mustHappen}).Usage()
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
	t.Parallel()
	home := t.TempDir()
	os.Mkdir(filepath.Join(home, "bin"), 0o755)
	_, args := fakeCost(t, filepath.Join(home, "bin"), "cursor-cost-test-only", nil)
	if _, err := (&CostReader{Bin: "cursor-cost-test-only", Home: home, timeout: mustHappen}).Usage(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(args); err != nil {
		t.Fatalf("the program in ~/bin was not run: %v", err)
	}
	_, err := (&CostReader{Bin: "cursor-cost-test-only", Home: t.TempDir(), timeout: mustHappen}).Usage()
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("err %v", err)
	}
}

// A cursor-cost that does not answer is given up after the time Usage has for it, and ended.
// The time is short here; what the fake does inside it decides nothing, started or not.
func TestCostReaderNoAnswer(t *testing.T) {
	t.Parallel()
	bin, _ := fakeCost(t, t.TempDir(), "cursor-cost", map[string]string{"FAKE_COST_HANG": "1"})
	answered := make(chan error, 1)
	go func() {
		_, err := (&CostReader{Bin: bin, timeout: 300 * time.Millisecond}).Usage()
		answered <- err
	}()
	select {
	case err := <-answered:
		if err == nil || err.Error() != "cursor-cost: no answer within 300ms" {
			t.Fatalf("err %v", err)
		}
	case <-time.After(mustHappen):
		t.Fatal("Usage did not return")
	}
}
