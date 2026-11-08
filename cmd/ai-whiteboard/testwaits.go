package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"ai-whiteboard/internal/headless"
	"ai-whiteboard/internal/usable"
)

// testWaits is the hidden test-only AIWB_TEST_WAITS override: waits of the server that a test of
// real server processes lowers, so that it need not sit them out. Like AIWB_MCP_PORT it is
// deliberately not a flag. Its value is a list of name=duration, with commas between them, as in
// "ping=500ms,images=2s"; a wait that is not named keeps its value, and without the variable
// every field is 0 and every wait is the production one.
//
//	ping     how often an idle event stream gets a comment line (the bridge's 20 s)
//	agents   how often the agents' programs are looked up again (usable.Every)
//	images   how long an image of a chat that was never sent and that no draft names is kept
//	         after its last use (chats.Deps.ImageWait, an hour); the cleanup that takes such
//	         images by itself looks twelve times in it (chats.Manager.CleanImages)
//	quiet    how long the headless writer keeps a board after an agent's last call on it
//	         (-headless-quiet, headless.QuietDefault); it wins over the flag. It is also the board
//	         host's process quiet (-boardhost-quiet, 60 s), and half of it its room quiet (30 s)
//	hstart   how long a start of the headless writer (and of the board host) may take until its
//	         stream is open (headless.Options.StartLimit, 20 s)
//	linger   how often the headless writer (and the board host) is looked at for the idle stop
//	         (headless.Options.Linger, 5 s)
//	handover how long the holder of a board has to release it after another client took it
//	         (the bridge's 10 s); the headless writer gets four fifths of it, as its 8 s are of 10 s
//	calls    how long an agent's board call waits for the answer of the client it was given to
//	         (boardapi's 30 s); it is also how long a window that holds a board may stay silent
//	         before it loses the board
//	retry    the first pause of the retry of an agent after a temporary error
//	         (chats.Deps.RetryFirst, 20 s); the other three keep their ratio to it
type testWaits struct {
	ping, agents, images       time.Duration
	quiet, hstart, linger, hov time.Duration
	calls, retry               time.Duration
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
	fields := map[string]*time.Duration{"ping": &w.ping, "agents": &w.agents, "images": &w.images,
		"quiet": &w.quiet, "hstart": &w.hstart, "linger": &w.linger, "handover": &w.hov, "calls": &w.calls, "retry": &w.retry}
	for _, part := range strings.Split(v, ",") {
		name, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		f := fields[name]
		if !ok || f == nil {
			return testWaits{}, fmt.Errorf("%q is not name=duration with one of the names ping, agents, images, quiet, hstart, linger, handover, calls, retry", part)
		}
		d, err := time.ParseDuration(value)
		if err != nil || d <= 0 {
			return testWaits{}, fmt.Errorf("%q is not a duration above 0", part)
		}
		*f = d
	}
	return w, nil
}

// agentsEvery is how often the agents' programs are looked up again.
func (w testWaits) agentsEvery() time.Duration {
	if w.agents > 0 {
		return w.agents
	}
	return usable.Every
}

// headlessOptions are the manager's options: the flags, and the test waits where they are set.
func (w testWaits) headlessOptions(o options) headless.Options {
	h := headless.Options{Node: o.headlessNode, Dir: o.headlessDir, Quiet: o.headlessQuiet,
		StartLimit: w.hstart, Linger: w.linger}
	if w.quiet > 0 {
		h.Quiet = w.quiet
	}
	if w.hov > 0 {
		h.Handover = w.hov * 4 / 5
	}
	return h
}

// The board host's waits (better-board design 5.1, 5.2).
const (
	// boardhostQuietDefault is -boardhost-quiet's default: how long after its last session or tool
	// call the board host counts as busy, so that its process is not stopped.
	boardhostQuietDefault = 60 * time.Second
	// boardhostRoomQuiet is the board host's own quiet time: how long a room with no session and no
	// agent call stays loaded before it is saved and closed (its config line's quietMs). It is
	// shorter than the process quiet, so the rooms are normally saved before the process stops.
	boardhostRoomQuiet = 30 * time.Second
)

// boardhostQuiet is the relay's process quiet: the flag's, or quiet of the test waits when set.
func (w testWaits) boardhostQuiet(o options) time.Duration {
	if w.quiet > 0 {
		return w.quiet
	}
	return o.boardhostQuiet
}

// boardhostOptions are the board host's manager's options: the headless writer's manager made with
// the board host's program, folder, name and variable, the flags, the room quiet, and the test
// waits where they are set (quiet= lowers the room quiet to half of it).
func (w testWaits) boardhostOptions(o options) headless.Options {
	h := headless.Options{Program: "boardhost.mjs", Folder: "boardhost", Name: "board host", NodeEnv: "AIWB_BOARDHOST_NODE",
		Node: o.boardhostNode, Dir: o.boardhostDir, Quiet: boardhostRoomQuiet, StartLimit: w.hstart, Linger: w.linger}
	if w.quiet > 0 {
		h.Quiet = w.quiet / 2
	}
	return h
}
