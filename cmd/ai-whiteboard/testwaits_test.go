package main

import (
	"os"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/headless"
	"ai-whiteboard/internal/usable"
)

// clock is how a test of real server processes shortens the waits it would sit out: the
// production waits it names are divided by it in its servers (the hidden AIWB_TEST_WAITS, see
// testWaits), and the test divides its own times by it too. So the test crosses the same waits in
// the same order, on a smaller clock.
//
// With AIWB_TEST_REAL_WAITS=1 nothing is divided: the servers keep the production waits and the
// tests take their full times, for a check against the real values.
type clock int

// fast is the clock of a test with several waits that keep their distance to each other.
// fastest is for a wait that stands alone, with no other wait to keep its distance to: the
// look-up of the agents' programs, every second for every 30 s. hourly is for the one wait that
// is an hour and stands alone too, the hour an image nobody uses is kept: two seconds.
const (
	fast    clock = 10
	fastest clock = 30
	hourly  clock = 1800
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

// lowered are the production values of the waits a test can name.
var lowered = map[string]time.Duration{
	"agents": usable.Every,
	"images": chats.DefaultImageWait,
	// The headless writer's: the quiet time, the look for the idle stop (headless.Options.Linger) and
	// the bridge's hand-off. (Its start limit, hstart, is no wait a test sits out.)
	"quiet":    headless.QuietDefault,
	"linger":   5 * time.Second,
	"handover": 10 * time.Second,
	// How long an agent's board call waits for a client's answer (boardapi.SetCallTimeout).
	"calls": 30 * time.Second,
}

// env is the AIWB_TEST_WAITS of a server whose named waits run on this clock, for instance.setenv.
func (c clock) env(t *testing.T, names ...string) string {
	t.Helper()
	var parts []string
	for _, name := range names {
		d, ok := lowered[name]
		if !ok {
			t.Fatalf("clock.env: no wait %q", name)
		}
		parts = append(parts, name+"="+c.of(d).String())
	}
	if realWaits() {
		parts = nil
	}
	return "AIWB_TEST_WAITS=" + strings.Join(parts, ",")
}

// The hidden AIWB_TEST_WAITS override: unset or empty it changes nothing, so the agents are looked
// up every usable.Every; a wait that is named takes its value. The waits of the relay between
// servers are gone with it: a server has none, and the app's own are AIWB_APP_WAITS.
func TestTestWaits(t *testing.T) {
	t.Parallel()
	for _, v := range []string{"", "  "} {
		w, err := parseTestWaits(v)
		if err != nil || w != (testWaits{}) {
			t.Fatalf("%q: %+v, %v, want the zero value", v, w, err)
		}
		if got := w.agentsEvery(); got != usable.Every {
			t.Fatalf("%q: the agents are looked up every %v, want %v", v, got, usable.Every)
		}
	}

	w, err := parseTestWaits(" ping=500ms, agents=1s,images=2s ")
	if err != nil || w != (testWaits{ping: 500 * time.Millisecond, agents: time.Second, images: 2 * time.Second}) {
		t.Fatalf("all three waits: %+v, %v", w, err)
	}
	if got := w.agentsEvery(); got != time.Second {
		t.Fatalf("the agents are looked up every %v, want 1 s", got)
	}
	// One wait alone leaves the others as they are.
	if w, err := parseTestWaits("images=2s"); err != nil || w != (testWaits{images: 2 * time.Second}) {
		t.Fatalf("the images wait alone: %+v, %v", w, err)
	}
	// The time of an agent's board call is a name of the list, and the fast clock writes a tenth of it.
	if w, err := parseTestWaits("calls=3s"); err != nil || w != (testWaits{calls: 3 * time.Second}) {
		t.Fatalf("the calls wait alone: %+v, %v", w, err)
	}
	if w, err := parseTestWaits(strings.TrimPrefix(fast.env(t, "calls"), "AIWB_TEST_WAITS=")); err != nil || !realWaits() && w != (testWaits{calls: 3 * time.Second}) {
		t.Fatalf("the calls wait of the fast clock: %+v, %v", w, err)
	}
	// The waits of the relay are no names of the list any more.
	for _, gone := range []string{"silence=3s", "backoff=3s", "start=4s", "tooold=30s", "imagecall=6s"} {
		if w, err := parseTestWaits(gone); err == nil || w != (testWaits{}) {
			t.Fatalf("%q was read as %+v", gone, w)
		}
	}
	for _, bad := range []string{"ping", "ping=", "ping=soon", "ping=0s", "ping=-1s", "call=1s", "ping=1s,", "ping=1s;agents=2s"} {
		if w, err := parseTestWaits(bad); err == nil || w != (testWaits{}) {
			t.Fatalf("%q was read as %+v", bad, w)
		}
	}
	if _, err := parseTestWaits("nosuchwait=1s"); err == nil || !strings.Contains(err.Error(), "one of the names ping, agents, images") {
		t.Fatalf("a name that is no wait: %v", err)
	}

	// What the tests pass is read as they mean it.
	if w, err := parseTestWaits(strings.TrimPrefix(fastest.env(t, "agents"), "AIWB_TEST_WAITS=")); err != nil || !realWaits() && w != (testWaits{agents: time.Second}) {
		t.Fatalf("the waits of the fastest clock: %+v, %v", w, err)
	}
}
