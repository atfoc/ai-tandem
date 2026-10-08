package main

import (
	"os"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/usable"
)

// clock is how a test of real server processes shortens the waits it would sit out: the
// production waits it names are divided by it in its servers (the hidden AIWB_TEST_WAITS, see
// testWaits), and the test divides its own times, the 60 s of an outage, by it too. So the test
// crosses the same waits in the same order, on a smaller clock.
//
// With AIWB_TEST_REAL_WAITS=1 nothing is divided: the servers keep the production waits and the
// tests take their full times (some four minutes for the slowest), for a check against the real
// values:
//
//	AIWB_TEST_REAL_WAITS=1 AIWB_TEST_FULL=1 go test -timeout 30m -run 'TestRemoteChatOutage' ./cmd/ai-whiteboard
type clock int

// fast is the clock of most tests: an outage of 60 s is one of 6 s, the 35 s of silence are 3.5 s.
// slower is for a test that crosses a wait which stays as it is (see TestRemoteRunNoAnswer), and
// fastest for a wait that stands alone, with no other wait to keep its distance to: the look-up
// of the agents' programs, every second for every 30 s.
const (
	slower  clock = 5
	fast    clock = 10
	fastest clock = 30
)

// realWaits says that the tests run on the production clock.
func realWaits() bool { return os.Getenv("AIWB_TEST_REAL_WAITS") == "1" }

// of is the production time d on this clock.
func (c clock) of(d time.Duration) time.Duration {
	if realWaits() {
		return d
	}
	return d / time.Duration(c)
}

// lowered are the production values of the waits a test can name. The ping is not divided by the
// clock but set to half a second: the silence of a few seconds must stay several pings long on a
// loaded machine, as the 35 s are not even two.
var lowered = map[string]time.Duration{
	"silence": servers.DefaultTiming.Silence,
	"backoff": servers.DefaultTiming.Backoff[len(servers.DefaultTiming.Backoff)-1],
	"start":   remotes.DefaultLimits.Start,
	"agents":  usable.Every,
}

// env is the AIWB_TEST_WAITS of a server whose named waits run on this clock, for instance.setenv
// and the environment of a pair. "silence" brings the ping with it.
func (c clock) env(t *testing.T, names ...string) string {
	t.Helper()
	var parts []string
	for _, name := range names {
		d, ok := lowered[name]
		if !ok {
			t.Fatalf("clock.env: no wait %q", name)
		}
		parts = append(parts, name+"="+c.of(d).String())
		if name == "silence" && !realWaits() {
			parts = append(parts, "ping=500ms")
		}
	}
	if realWaits() {
		parts = nil
	}
	return "AIWB_TEST_WAITS=" + strings.Join(parts, ",")
}

// The hidden AIWB_TEST_WAITS override: unset or empty it changes nothing, so the Timing and the
// Limits are zero (the defaults) and the agents are looked up every usable.Every; a wait that is
// named takes its value, and the back-off keeps its steps' shares.
func TestTestWaits(t *testing.T) {
	t.Parallel()
	for _, v := range []string{"", "  "} {
		w, err := parseTestWaits(v)
		if err != nil || w != (testWaits{}) {
			t.Fatalf("%q: %+v, %v, want the zero value", v, w, err)
		}
		if tm := w.timing(); tm.Silence != 0 || tm.Backoff != nil || tm.Stable != 0 || tm.Call != 0 {
			t.Fatalf("%q: the timing %+v, want zero", v, tm)
		}
		if l := w.limits(); l != (remotes.Limits{}) {
			t.Fatalf("%q: the limits %+v, want zero", v, l)
		}
		if got := w.agentsEvery(); got != usable.Every {
			t.Fatalf("%q: the agents are looked up every %v, want %v", v, got, usable.Every)
		}
	}

	w, err := parseTestWaits(" ping=500ms, silence=3.5s,backoff=3s,start=4500ms,agents=1s ")
	if err != nil || w != (testWaits{ping: 500 * time.Millisecond, silence: 3500 * time.Millisecond, backoff: 3 * time.Second, start: 4500 * time.Millisecond, agents: time.Second}) {
		t.Fatalf("all five waits: %+v, %v", w, err)
	}
	tm := w.timing()
	want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 500 * time.Millisecond, time.Second, 3 * time.Second}
	if tm.Silence != w.silence || tm.Stable != 3*time.Second || len(tm.Backoff) != len(want) {
		t.Fatalf("the timing: %+v", tm)
	}
	for i, d := range want {
		if tm.Backoff[i] != d {
			t.Fatalf("the back-off %v, want %v", tm.Backoff, want)
		}
	}
	if tm.Call != 0 || tm.Hello != 0 || tm.Dial != 0 {
		t.Fatalf("the timing has waits that were not named: %+v", tm)
	}
	if l := w.limits(); l != (remotes.Limits{Start: w.start}) {
		t.Fatalf("the limits: %+v", l)
	}
	if got := w.agentsEvery(); got != time.Second {
		t.Fatalf("the agents are looked up every %v, want 1 s", got)
	}
	if len(servers.DefaultTiming.Backoff) != 5 || servers.DefaultTiming.Backoff[4] != 30*time.Second {
		t.Fatalf("the production back-off changed under the override: %v", servers.DefaultTiming.Backoff)
	}

	// One wait alone leaves the others as they are.
	if w, err := parseTestWaits("start=2s"); err != nil || w != (testWaits{start: 2 * time.Second}) || w.timing().Backoff != nil {
		t.Fatalf("start alone: %+v, %v", w, err)
	}
	for _, bad := range []string{"silence", "silence=", "silence=soon", "silence=0s", "silence=-1s", "call=1s", "silence=1s,", "silence=1s;start=2s"} {
		if w, err := parseTestWaits(bad); err == nil || w != (testWaits{}) {
			t.Fatalf("%q was read as %+v", bad, w)
		}
	}

	// What the tests pass is read as they mean it.
	if w, err := parseTestWaits(strings.TrimPrefix(fast.env(t, "silence", "backoff", "start", "agents"), "AIWB_TEST_WAITS=")); err != nil ||
		!realWaits() && w != (testWaits{ping: 500 * time.Millisecond, silence: 3500 * time.Millisecond, backoff: 3 * time.Second, start: 4500 * time.Millisecond, agents: 3 * time.Second}) {
		t.Fatalf("the waits of the fast clock: %+v, %v", w, err)
	}
}
