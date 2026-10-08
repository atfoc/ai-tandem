package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/usable"
)

// testWaits is the hidden test-only AIWB_TEST_WAITS override: waits of the server that a test of
// real server processes lowers, so that it need not sit them out. Like AIWB_MCP_PORT and
// AIWB_TEST_DIAL_VIA it is deliberately not a flag. Its value is a list of name=duration, with
// commas between them, as in "silence=3.5s,ping=500ms"; a wait that is not named keeps its value,
// and without the variable every field is 0 and every wait is the production one.
//
//	ping     how often an idle event stream gets a comment line (the bridge's 20 s)
//	silence  servers.Timing.Silence
//	backoff  the last step of servers.Timing.Backoff, which is Stable too; the steps before it
//	         keep their share of it
//	start    remotes.Limits.Start
//	agents   how often the agents' programs are looked up again (usable.Every)
type testWaits struct {
	ping, silence, backoff, start, agents time.Duration
}

// readTestWaits is the AIWB_TEST_WAITS of this process; a value that cannot be read ends it.
func readTestWaits() testWaits {
	w, err := parseTestWaits(os.Getenv("AIWB_TEST_WAITS"))
	if err != nil {
		log.Fatalf("AIWB_TEST_WAITS: %v", err)
	}
	return w
}

// parseTestWaits reads the value of AIWB_TEST_WAITS. "" is the zero testWaits.
func parseTestWaits(v string) (w testWaits, err error) {
	if strings.TrimSpace(v) == "" {
		return w, nil
	}
	fields := map[string]*time.Duration{"ping": &w.ping, "silence": &w.silence, "backoff": &w.backoff, "start": &w.start, "agents": &w.agents}
	for _, part := range strings.Split(v, ",") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		f := fields[name]
		if !ok || f == nil {
			return testWaits{}, fmt.Errorf("%q is not name=duration with one of the names ping, silence, backoff, start, agents", part)
		}
		d, err := time.ParseDuration(value)
		if err != nil || d <= 0 {
			return testWaits{}, fmt.Errorf("%q is not a duration above 0", part)
		}
		*f = d
	}
	return w, nil
}

// timing is the Timing of the connections to other servers: zero, which is DefaultTiming, but
// for the waits that were lowered.
func (w testWaits) timing() servers.Timing {
	t := servers.Timing{Silence: w.silence}
	if w.backoff > 0 {
		steps := servers.DefaultTiming.Backoff
		last := steps[len(steps)-1]
		for _, d := range steps {
			t.Backoff = append(t.Backoff, time.Duration(float64(d)*float64(w.backoff)/float64(last)))
		}
		t.Stable = w.backoff
	}
	return t
}

// limits is the Limits of the relay: zero, which is DefaultLimits, but for the lowered ones.
func (w testWaits) limits() remotes.Limits {
	return remotes.Limits{Start: w.start}
}

// agentsEvery is how often the agents' programs are looked up again.
func (w testWaits) agentsEvery() time.Duration {
	if w.agents > 0 {
		return w.agents
	}
	return usable.Every
}
