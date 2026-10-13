package main

import (
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
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

// lowered are the production values of the waits a test can name. The ping is not divided by the
// clock but set to half a second: the silence of a few seconds must stay several pings long on a
// loaded machine, as the 35 s are not even two.
var lowered = map[string]time.Duration{
	"silence": servers.DefaultTiming.Silence,
	"backoff": servers.DefaultTiming.Backoff[len(servers.DefaultTiming.Backoff)-1],
	"start":   remotes.DefaultLimits.Start,
	"agents":  usable.Every,
	"tooold":  servers.DefaultTiming.TooOld,
	// An upload and a fetch of an image between servers.
	"imagecall": remotes.DefaultLimits.Image,
	"images":    chats.DefaultImageWait,
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
		if tm := w.timing(); tm.Silence != 0 || tm.Backoff != nil || tm.Stable != 0 || tm.Call != 0 || tm.TooOld != 0 {
			t.Fatalf("%q: the timing %+v, want zero", v, tm)
		}
		if l := w.limits(); l != (remotes.Limits{}) {
			t.Fatalf("%q: the limits %+v, want zero", v, l)
		}
		if got := w.agentsEvery(); got != usable.Every {
			t.Fatalf("%q: the agents are looked up every %v, want %v", v, got, usable.Every)
		}
	}

	w, err := parseTestWaits(" ping=500ms, silence=3.5s,backoff=3s,start=4500ms,agents=1s,tooold=30s ")
	if err != nil || w != (testWaits{ping: 500 * time.Millisecond, silence: 3500 * time.Millisecond, backoff: 3 * time.Second, start: 4500 * time.Millisecond, agents: time.Second, tooOld: 30 * time.Second}) {
		t.Fatalf("all six waits: %+v, %v", w, err)
	}
	tm := w.timing()
	want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 500 * time.Millisecond, time.Second, 3 * time.Second}
	if tm.Silence != w.silence || tm.Stable != 3*time.Second || len(tm.Backoff) != len(want) || tm.TooOld != 30*time.Second {
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
	if servers.DefaultTiming.TooOld != 5*time.Minute {
		t.Fatalf("a server that is too old is asked again every %v in production, want five minutes", servers.DefaultTiming.TooOld)
	}

	// One wait alone leaves the others as they are.
	// The hour an image nobody uses is kept: named alone, it changes no other wait.
	if w, err := parseTestWaits("images=2s"); err != nil || w != (testWaits{images: 2 * time.Second}) {
		t.Fatalf("the images wait alone: %+v, %v", w, err)
	}
	if w, err := parseTestWaits("start=2s"); err != nil || w != (testWaits{start: 2 * time.Second}) || w.timing().Backoff != nil {
		t.Fatalf("start alone: %+v, %v", w, err)
	}
	if w, err := parseTestWaits("tooold=50ms"); err != nil || w != (testWaits{tooOld: 50 * time.Millisecond}) || w.timing().TooOld != 50*time.Millisecond ||
		w.timing().Silence != 0 || w.timing().Backoff != nil {
		t.Fatalf("tooold alone: %+v, %v", w, err)
	}
	// A wait that no longer exists is no name of the list.
	if _, err := parseTestWaits("move=1500ms"); err == nil {
		t.Fatal("move was taken as a wait")
	}
	// The 60 seconds of an upload and a fetch of an image between servers: named alone, it is
	// the relay's limit for those two calls and no other wait.
	if w, err := parseTestWaits("imagecall=6s"); err != nil || w != (testWaits{imageCall: 6 * time.Second}) ||
		w.limits() != (remotes.Limits{Image: 6 * time.Second}) || w.timing().Silence != 0 {
		t.Fatalf("imagecall alone: %+v, %v", w, err)
	}
	if remotes.DefaultLimits.Image != 60*time.Second || remotes.DefaultLimits.Image != remotes.DefaultLimits.Scene {
		t.Fatalf("an image goes between servers within %v in production, want the 60 s of a board's scene", remotes.DefaultLimits.Image)
	}
	if got := strings.TrimPrefix(fast.env(t, "imagecall"), "AIWB_TEST_WAITS="); !realWaits() && got != "imagecall=6s" {
		t.Fatalf("the image call on the fast clock: %q", got)
	}
	for _, bad := range []string{"silence", "silence=", "silence=soon", "silence=0s", "silence=-1s", "call=1s", "silence=1s,", "silence=1s;start=2s"} {
		if w, err := parseTestWaits(bad); err == nil || w != (testWaits{}) {
			t.Fatalf("%q was read as %+v", bad, w)
		}
	}

	// What the tests pass is read as they mean it.
	if w, err := parseTestWaits(strings.TrimPrefix(fast.env(t, "silence", "backoff", "start", "agents", "tooold"), "AIWB_TEST_WAITS=")); err != nil ||
		!realWaits() && w != (testWaits{ping: 500 * time.Millisecond, silence: 3500 * time.Millisecond, backoff: 3 * time.Second, start: 4500 * time.Millisecond, agents: 3 * time.Second, tooOld: 30 * time.Second}) {
		t.Fatalf("the waits of the fast clock: %+v, %v", w, err)
	}
}

// The waits between this server and another one are the production ones unless a test names
// them. A program that was started with no override passes a call on within 15 seconds, one
// that can wait for an agent's start within 45, a drawing and an image within 60 and a delete
// within 3 minutes, and gives the connections a Timing of zero, which asks a server that is too
// old again every five minutes (servers.DefaultTiming; that a zero Timing means it is
// TestTiming, internal/servers). The README states these values. A wait that is named is
// lowered, and no other with it.
func TestSectionWaitsAreTheProductionOnesUnlessNamed(t *testing.T) {
	t.Parallel()
	unset, err := parseTestWaits("")
	if err != nil {
		t.Fatal(err)
	}
	pr := wiredWaits(t, t.TempDir(), unset)
	if l := pr.srv.Remotes.Limits(); l.Call != 15*time.Second || l.Start != 45*time.Second || l.Scene != 60*time.Second ||
		l.Image != 60*time.Second || l.Delete != 3*time.Minute || l != remotes.DefaultLimits {
		t.Errorf("the limits of a program with no override: %+v", l)
	}
	if tm := unset.timing(); tm.TooOld != 0 || tm.Call != 0 || servers.DefaultTiming.TooOld != 5*time.Minute || servers.DefaultTiming.Call != 15*time.Second {
		t.Errorf("the timing of a program with no override: %+v, and in production %+v", tm, servers.DefaultTiming)
	}
	pr.stop()

	named, err := parseTestWaits("start=4500ms,imagecall=6s,tooold=30s")
	if err != nil {
		t.Fatal(err)
	}
	pr = wiredWaits(t, t.TempDir(), named)
	want := remotes.DefaultLimits
	want.Start, want.Image = 4500*time.Millisecond, 6*time.Second
	if l := pr.srv.Remotes.Limits(); l != want {
		t.Errorf("the limits with start and imagecall lowered: %+v, want %+v", l, want)
	}
	if tm := named.timing(); tm.TooOld != 30*time.Second || tm.Call != 0 || tm.Silence != 0 || tm.Backoff != nil {
		t.Errorf("the timing with tooold lowered: %+v", tm)
	}
	if remotes.DefaultLimits.Start != 45*time.Second || servers.DefaultTiming.TooOld != 5*time.Minute {
		t.Errorf("the production values changed under the override: %+v, %+v", remotes.DefaultLimits, servers.DefaultTiming)
	}
}

// The names AGENTS.md lists for AIWB_TEST_WAITS are the ones the server reads: each of them is
// taken, and the server's own list, in its refusal of a name it does not know, is the same.
func TestSectionWaitNamesAreTheOnesOfAgentsMD(t *testing.T) {
	t.Parallel()
	doc, err := os.ReadFile("../../AGENTS.md")
	if err != nil {
		t.Fatal(err)
	}
	// "…, with the names `ping`, `silence`, … and `imagecall`; unset, …"
	_, after, found := strings.Cut(string(doc), "with the names")
	list, _, ended := strings.Cut(after, ";")
	if !found || !ended {
		t.Fatal("AGENTS.md has no list of the names of AIWB_TEST_WAITS")
	}
	var listed []string
	for _, m := range regexp.MustCompile("`([a-z]+)`").FindAllStringSubmatch(list, -1) {
		listed = append(listed, m[1])
	}
	_, err = parseTestWaits("nosuchwait=1s")
	if err == nil {
		t.Fatal("a name that is no wait was taken")
	}
	_, own, _ := strings.Cut(err.Error(), "one of the names ")
	read := strings.Split(own, ", ")
	if !slices.Equal(listed, read) || len(listed) != len(lowered)+1 {
		t.Fatalf("AGENTS.md lists the waits %v, the server reads %v, and the tests lower %d of them and the ping", listed, read, len(lowered))
	}
	for _, name := range listed {
		if w, err := parseTestWaits(name + "=1s"); err != nil || w == (testWaits{}) {
			t.Errorf("the wait %s of AGENTS.md: %+v, %v", name, w, err)
		}
		if _, ok := lowered[name]; !ok && name != "ping" {
			t.Errorf("no test can lower the wait %s by its clock", name)
		}
	}
}
