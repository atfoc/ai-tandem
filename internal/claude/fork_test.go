package claude

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

// forkFake sets up the fake for a fork start: its invocations are recorded and, with answer, it
// answers initialize from the plain fixture.
func forkFake(t *testing.T, answer bool, lines ...string) (f *fake, runs string) {
	t.Helper()
	f = newFake(t, lines...)
	runs = filepath.Join(f.dir, "runs.jsonl")
	t.Setenv(envRuns, runs)
	if answer {
		fixture, _ := filepath.Abs(filepath.Join("testdata", "initialize.json"))
		t.Setenv(envInit, fixture)
	}
	return f, runs
}

// pointGone is the error text (after "claude: ") of a fork at a point the CLI no longer finds.
const pointGone = "this point can no longer be branched or forked from: Claude has compacted the conversation since then"

// startupFailure is the one stdout line of a process that cannot start its session.
func startupFailure(reason string) string {
	return `{"type":"result","subtype":"error_during_execution","duration_ms":0,"is_error":true,"num_turns":0,"session_id":"N","errors":["` + reason + `"],"result_index":0}`
}

// onlyInitialize checks that the confirmed process's one event so far is its catalog event and
// that nothing but the initialize request was written to it; it closes the process.
func onlyInitialize(t *testing.T, f *fake, a agent.Agent) {
	t.Helper()
	if ev := next(t, a); ev.Kind != agent.EvCatalog || ev.Catalog == nil {
		t.Fatalf("first event %+v, want the catalog event", ev)
	}
	if lines := skipInit(t, f.stdinLines(t, a)); len(lines) != 0 { // fails on any further event too
		t.Errorf("stdin after the initialize request: %v, want nothing", lines)
	}
}

func TestSpawnForkArgs(t *testing.T) {
	cases := []struct {
		name string
		src  agent.ForkSource
		tail []string // the arguments after the chat's own
	}{
		{"at a point", agent.ForkSource{ChatID: "c", SessionID: "S", Point: "U", Next: "V"},
			[]string{"--fork-session", "--resume-session-at", "U", "--session-id", "N"}},
		// The end is cut at its point too: the source may take a message while the fork starts.
		{"at the end", agent.ForkSource{SessionID: "S", Point: "U", End: true},
			[]string{"--fork-session", "--resume-session-at", "U", "--session-id", "N"}},
		{"at the end, no point recorded", agent.ForkSource{SessionID: "S", End: true},
			[]string{"--fork-session", "--session-id", "N"}},
		{"no point recorded", agent.ForkSource{SessionID: "S"},
			[]string{"--fork-session", "--session-id", "N"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, runs := forkFake(t, true)
			s := f.spawner()
			o := agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir(), Model: "sonnet", Effort: "high"}
			a, id, err := s.SpawnFork(o, c.src)
			if err != nil {
				t.Fatal(err)
			}
			if id != "N" {
				t.Errorf("session id %q, want N", id)
			}
			onlyInitialize(t, f, a)
			rs := readRuns(t, runs)
			if len(rs) != 1 {
				t.Fatalf("%d processes started, want 1", len(rs))
			}
			// the source's resume arguments, then the fork's
			o.SessionID, o.Resume = "S", true
			if want := append(s.Args(o), c.tail...); !slices.Equal(rs[0].Args, want) {
				t.Errorf("args %q\nwant %q", rs[0].Args, want)
			}
			if v, _ := flag(rs[0].Args, "--resume"); v != "S" {
				t.Errorf("--resume %q, want the source session", v)
			}
		})
	}
}

// A18: once the fork's session file exists the fork launch is refused, and a plain resume of the
// fork's own session follows.
func TestSpawnForkAlreadyInUse(t *testing.T) {
	f, runs := forkFake(t, true)
	t.Setenv(envForkEr, "Error: Session ID N is already in use.")
	s := f.spawner()
	o := agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir(), Model: "sonnet"}
	a, id, err := s.SpawnFork(o, agent.ForkSource{SessionID: "S", Point: "U"})
	if err != nil {
		t.Fatal(err)
	}
	if id != "N" {
		t.Errorf("session id %q, want N", id)
	}
	onlyInitialize(t, f, a) // the process returned is the second: the first never read stdin
	rs := readRuns(t, runs)
	if len(rs) != 2 {
		t.Fatalf("%d processes started, want the fork launch and the resume", len(rs))
	}
	if !slices.Contains(rs[0].Args, "--fork-session") {
		t.Errorf("first args %q, want the fork launch", rs[0].Args)
	}
	o.Resume = true
	if want := s.Args(o); !slices.Equal(rs[1].Args, want) {
		t.Errorf("second args %q\nwant the plain resume %q", rs[1].Args, want)
	}
	if v, _ := flag(rs[1].Args, "--resume"); v != "N" {
		t.Errorf("second --resume %q, want N", v)
	}
	for _, name := range []string{"--fork-session", "--resume-session-at", "--session-id"} {
		if slices.Contains(rs[1].Args, name) {
			t.Errorf("second args have %s: %q", name, rs[1].Args)
		}
	}
	waitDead(t, rs[0].Pid)
}

// The resume after "already in use" is waited for the same way: its failure is the fork's.
func TestSpawnForkResumeFails(t *testing.T) {
	f, runs := forkFake(t, false, startupFailure("No conversation found with session ID: N"))
	t.Setenv(envForkEr, "Error: Session ID N is already in use.")
	a, _, err := f.spawner().SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S", Point: "U"})
	if a != nil || err == nil || err.Error() != "claude: No conversation found with session ID: N" {
		t.Fatalf("SpawnFork = %v, %v; want the resume's reason", a, err)
	}
	rs := readRuns(t, runs)
	if len(rs) != 2 {
		t.Fatalf("%d processes started, want 2", len(rs))
	}
	waitDead(t, rs[1].Pid)
}

// A source session or a point that is gone: one result line, no initialize answer, and the
// process stays until its stdin is closed. The fork fails at that line.
//
// A point that is gone is one before a compaction (the CLI no longer loads those messages): the
// error says so in place of the CLI's text.
func TestSpawnForkStartupFailure(t *testing.T) {
	for _, c := range []struct{ reason, want string }{
		{"No message found with message.uuid of: U", pointGone},
		{"No conversation found with session ID: S", "No conversation found with session ID: S"},
	} {
		t.Run(c.reason, func(t *testing.T) {
			f, runs := forkFake(t, false, startupFailure(c.reason))
			s := f.spawner()
			s.forkTimeout = 30 * time.Second
			start := time.Now()
			a, _, err := s.SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S", Point: "U"})
			if a != nil || err == nil || err.Error() != "claude: "+c.want {
				t.Fatalf("SpawnFork = %v, %v; want %q", a, err, "claude: "+c.want)
			}
			if d := time.Since(start); d > 10*time.Second {
				t.Errorf("failed after %s: the time box was waited out", d)
			}
			rs := readRuns(t, runs)
			if len(rs) != 1 {
				t.Fatalf("%d processes started, want 1 (no resume for this failure)", len(rs))
			}
			waitDead(t, rs[0].Pid) // closed
			if b, _ := os.ReadFile(f.stdin); strings.Contains(string(b), `"type":"user"`) {
				t.Error("a message was sent")
			}
		})
	}
}

// A result line with no errors[]: the reason is on stderr once the closed process has ended.
func TestSpawnForkStartupFailureStderr(t *testing.T) {
	cases := []struct{ stderr, want string }{
		{"something broke\nmore", "claude: something broke"},
		{"Error: No message found with message.uuid of: U", "claude: " + pointGone},
		{"", "claude: the fork failed"},
	}
	for _, c := range cases {
		f, runs := forkFake(t, false, `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0}`)
		t.Setenv(envStderr, c.stderr)
		a, _, err := f.spawner().SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S"})
		if a != nil || err == nil || err.Error() != c.want {
			t.Errorf("stderr %q: SpawnFork = %v, %v; want %q", c.stderr, a, err, c.want)
		}
		if rs := readRuns(t, runs); len(rs) != 1 {
			t.Errorf("stderr %q: %d processes started, want 1", c.stderr, len(rs))
		}
	}
}

func TestSpawnForkTimeout(t *testing.T) {
	f, runs := forkFake(t, false) // never answers initialize
	s := f.spawner()
	s.forkTimeout = 300 * time.Millisecond
	start := time.Now()
	a, _, err := s.SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S", Point: "U"})
	if a != nil || err == nil || err.Error() != "claude: the fork did not start within 300ms" {
		t.Fatalf("SpawnFork = %v, %v; want the time-out", a, err)
	}
	if d := time.Since(start); d < 300*time.Millisecond || d > 10*time.Second {
		t.Errorf("failed after %s, want the time box", d)
	}
	rs := readRuns(t, runs)
	if len(rs) != 1 {
		t.Fatalf("%d processes started, want 1", len(rs))
	}
	waitDead(t, rs[0].Pid)
}

// A process that exits before answering, for another reason than "already in use".
func TestSpawnForkExit(t *testing.T) {
	cases := []struct{ stderr, want string }{
		{"Error: boom\nat x", "claude: Error: boom"},
		{"", "claude: the fork failed"},
	}
	for _, c := range cases {
		f, runs := forkFake(t, true)
		t.Setenv(envStderr, c.stderr)
		t.Setenv(envExit, "1")
		a, _, err := f.spawner().SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S", Point: "U"})
		if a != nil || err == nil || err.Error() != c.want {
			t.Errorf("stderr %q: SpawnFork = %v, %v; want %q", c.stderr, a, err, c.want)
		}
		if rs := readRuns(t, runs); len(rs) != 1 {
			t.Errorf("stderr %q: %d processes started, want 1 (no resume)", c.stderr, len(rs))
		}
	}
}

// The confirmed process is a chat process like any other; what it reported before the
// confirmation is still in its events.
func TestSpawnForkAgentWorks(t *testing.T) {
	f, _ := forkFake(t, true, `{"type":"system","subtype":"status","status":"requesting"}`)
	a, _, err := f.spawner().SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S", Point: "U"})
	if err != nil {
		t.Fatal(err)
	}
	if ev := next(t, a); ev.Kind != agent.EvThinking {
		t.Fatalf("event %+v, want EvThinking", ev)
	}
	if ev := next(t, a); ev.Kind != agent.EvCatalog {
		t.Fatalf("event %+v, want the catalog event", ev)
	}
	if err := a.Send([]agent.ContentBlock{{Text: "hello"}}); err != nil {
		t.Fatal(err)
	}
	if err := a.Interrupt(); err != nil {
		t.Fatal(err)
	}
	lines := skipInit(t, f.stdinLines(t, a)) // fails on a second catalog event
	if len(lines) != 2 || lines[0]["type"] != "user" || obj(lines[1]["request"])["subtype"] != "interrupt" {
		t.Errorf("stdin = %v, want the message and the interrupt", lines)
	}
}

func TestSpawnForkRefusals(t *testing.T) {
	f, runs := forkFake(t, true)
	s := f.spawner()
	a, _, err := s.SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: filepath.Join(t.TempDir(), "gone")}, agent.ForkSource{SessionID: "S"})
	if !errors.Is(err, agent.ErrFolderMissing) || a != nil {
		t.Errorf("missing folder: SpawnFork = %v, %v; want nil, ErrFolderMissing", a, err)
	}
	if a, _, err := s.SpawnFork(agent.SpawnOptions{Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S"}); err == nil || a != nil {
		t.Errorf("no session id: SpawnFork = %v, %v; want an error", a, err)
	}
	time.Sleep(200 * time.Millisecond)
	if rs := readRuns(t, runs); len(rs) != 0 {
		t.Errorf("%d processes started, want none", len(rs))
	}
	s.DiscardFork("N") // nothing to do
}

// The lines of a start whose session lost background tasks (CLI 2.1.284): a "stopped" notice per
// task with no task_type, and after the initialize answer and system/init one empty result each.
const (
	lostNotice  = `{"type":"system","subtype":"task_notification","task_id":"%s","status":"stopped","summary":"Background shell command didn't finish before the previous session ended","session_id":"N","uuid":"uuid-%s"}`
	lostResult  = `{"type":"result","subtype":"success","is_error":false,"duration_ms":0,"num_turns":0,"result":"","total_cost_usd":0,"session_id":"N","terminal_reason":"completed","origin":{"kind":"task-notification"},"uuid":"uuid-lost-result"}`
	systemInit  = `{"type":"system","subtype":"init","session_id":"N","model":"claude-haiku-4-5-20251001"}`
	turnText    = `{"type":"assistant","message":{"id":"msg_%[1]s","content":[{"type":"text","text":"%[1]s"}]},"parent_tool_use_id":null,"session_id":"N","uuid":"uuid-%[1]s"}`
	turnResult  = `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"terminal_reason":"completed","origin":{"kind":"human"},"modelUsage":{"claude-haiku-4-5-20251001":{"contextWindow":200000}},"uuid":"uuid-result"}`
	turnToolUse = `{"type":"assistant","message":{"id":"msg_tool","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"python3 slow.py"}}]},"parent_tool_use_id":null,"session_id":"S","uuid":"uuid-tool-use"}`
	turnToolRes = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"SLEPT"}]},"parent_tool_use_id":null,"session_id":"S","uuid":"uuid-tool-result"}`
)

// lostNotices are n notices of lost tasks.
func lostNotices(n int) []string {
	var lines []string
	for i := range n {
		id := "lost" + string(rune('a'+i))
		lines = append(lines, strings.ReplaceAll(lostNotice, "%s", id))
	}
	return lines
}

// times is n copies of line.
func times(n int, line string) []string {
	return slices.Repeat([]string{line}, n)
}

// text is a turn's assistant line with the given text; its uuid is "uuid-<text>".
func text(s string) string { return strings.ReplaceAll(turnText, "%[1]s", s) }

// A fork or a resume whose session lost background tasks: every notice's empty result is dropped,
// however many there are, and the first message's turn is the first that ends.
func TestLostTaskResultsDropped(t *testing.T) {
	for _, path := range []string{"fork", "resume"} {
		for _, n := range []int{1, 2, 3} {
			t.Run(path+"/"+string(rune('0'+n)), func(t *testing.T) {
				f, _ := forkFake(t, true, lostNotices(n)...)
				f.setAfter(t, append([]string{systemInit}, times(n, lostResult)...)...)
				f.setTurns(t, []string{text("hello"), turnResult})
				var a agent.Agent
				var err error
				o := agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir(), Model: "haiku"}
				if path == "fork" {
					a, _, err = f.spawner().SpawnFork(o, agent.ForkSource{SessionID: "S", Point: "U"})
				} else {
					o.Resume = true
					a, err = f.spawner().Spawn(o)
				}
				if err != nil {
					t.Fatal(err)
				}
				if err := a.Send([]agent.ContentBlock{{Text: "hi"}}); err != nil {
					t.Fatal(err)
				}
				evs := turnEvents(t, a)
				want := []agent.EventKind{agent.EvCatalog, agent.EvText, agent.EvUsage, agent.EvTurnEnd}
				if !slices.Equal(kinds(evs), want) {
					t.Fatalf("events %+v, want only the catalog and the message's turn", evs)
				}
				if end := evs[len(evs)-1]; end.Point != "uuid-hello" || end.Error != "" || evs[2].CtxWindow != 200000 {
					t.Errorf("turn end %+v after usage %+v, want the turn's point and window", end, evs[2])
				}
				if lines := skipInit(t, f.stdinLines(t, a)); len(lines) != 1 || lines[0]["type"] != "user" { // fails on any further event
					t.Errorf("stdin = %v, want the one message", lines)
				}
			})
		}
	}
}

// The empty result of a lost task before the initialize answer is no failed start; an errored
// result there still is.
func TestSpawnForkEarlyLostTaskResult(t *testing.T) {
	early := append(lostNotices(2), lostResult, lostResult)
	t.Run("ignored", func(t *testing.T) {
		f, runs := forkFake(t, true, early...)
		f.setTurns(t, []string{text("hello"), turnResult})
		a, _, err := f.spawner().SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S", Point: "U"})
		if err != nil {
			t.Fatal(err)
		}
		if err := a.Send([]agent.ContentBlock{{Text: "hi"}}); err != nil {
			t.Fatal(err)
		}
		evs := turnEvents(t, a)
		if want := []agent.EventKind{agent.EvCatalog, agent.EvText, agent.EvUsage, agent.EvTurnEnd}; !slices.Equal(kinds(evs), want) {
			t.Fatalf("events %+v, want only the catalog and the message's turn", evs)
		}
		if p := evs[len(evs)-1].Point; p != "uuid-hello" {
			t.Errorf("point %q, want the turn's", p)
		}
		a.Close()
		if rs := readRuns(t, runs); len(rs) != 1 {
			t.Errorf("%d processes started, want 1", len(rs))
		}
	})
	t.Run("an errored result fails", func(t *testing.T) {
		f, runs := forkFake(t, false, append(early, startupFailure("No conversation found with session ID: S"))...)
		a, _, err := f.spawner().SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S", Point: "U"})
		if a != nil || err == nil || err.Error() != "claude: No conversation found with session ID: S" {
			t.Fatalf("SpawnFork = %v, %v; want the errored result's reason", a, err)
		}
		rs := readRuns(t, runs)
		if len(rs) != 1 {
			t.Fatalf("%d processes started, want 1", len(rs))
		}
		waitDead(t, rs[0].Pid)
	})
}

// A fork from a running source: the source is in its second turn (a tool call that has not
// returned), the fork starts at the first turn's point and takes a turn, and the source's turn
// then ends as it would have.
func TestSpawnForkFromRunningSource(t *testing.T) {
	src := newFake(t)
	gate := filepath.Join(src.dir, "gate")
	t.Setenv(envGate, gate)
	src.setTurns(t,
		[]string{text("one"), turnResult},
		[]string{turnToolUse, `"gate"`, turnToolRes, text("two"), turnResult})
	s := src.spawner()
	cwd := t.TempDir()
	source, err := s.Spawn(agent.SpawnOptions{SessionID: "S", Cwd: cwd, Model: "haiku"})
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	if err := source.Send([]agent.ContentBlock{{Text: "first"}}); err != nil {
		t.Fatal(err)
	}
	evs := turnEvents(t, source)
	point := evs[len(evs)-1].Point
	if point != "uuid-one" {
		t.Fatalf("turn 1 ended with %+v, want the point uuid-one", evs[len(evs)-1])
	}
	if err := source.Send([]agent.ContentBlock{{Text: "second"}}); err != nil {
		t.Fatal(err)
	}
	if ev := next(t, source); ev.Kind != agent.EvToolInput || ev.ToolID != "toolu_1" {
		t.Fatalf("event %+v, want turn 2's tool call", ev)
	}

	f, runs := forkFake(t, true)
	f.setTurns(t, []string{text("forked"), turnResult})
	o := agent.SpawnOptions{SessionID: "N", Cwd: cwd, Model: "haiku"}
	fork, id, err := s.SpawnFork(o, agent.ForkSource{SessionID: "S", Point: point})
	if err != nil {
		t.Fatal(err)
	}
	defer fork.Close()
	if id != "N" {
		t.Errorf("session id %q, want N", id)
	}
	rs := readRuns(t, runs)
	if len(rs) != 1 {
		t.Fatalf("%d processes started for the fork, want 1", len(rs))
	}
	o.SessionID, o.Resume = "S", true
	if want := append(s.Args(o), "--fork-session", "--resume-session-at", "uuid-one", "--session-id", "N"); !slices.Equal(rs[0].Args, want) {
		t.Errorf("args %q\nwant %q", rs[0].Args, want)
	}
	if v, _ := flag(rs[0].Args, "--resume"); v != "S" {
		t.Errorf("--resume %q, want the source session", v)
	}
	if err := fork.Send([]agent.ContentBlock{{Text: "in the fork"}}); err != nil {
		t.Fatal(err)
	}
	evs = turnEvents(t, fork)
	if want := []agent.EventKind{agent.EvCatalog, agent.EvText, agent.EvUsage, agent.EvTurnEnd}; !slices.Equal(kinds(evs), want) {
		t.Fatalf("fork events %+v, want the catalog and one turn", evs)
	}
	if end := evs[len(evs)-1]; end.Point != "uuid-forked" || end.Error != "" || end.Aborted {
		t.Errorf("fork's turn end %+v, want its own point", end)
	}

	// The source is still in turn 2: nothing has come from it since the tool call.
	select {
	case ev := <-source.Events():
		t.Fatalf("source event %+v while its tool call is running", ev)
	default:
	}
	if b, _ := os.ReadFile(src.stdin); strings.Contains(string(b), "in the fork") {
		t.Error("the fork's message reached the source")
	}
	if err := os.WriteFile(gate, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	evs = turnEvents(t, source)
	if want := []agent.EventKind{agent.EvToolResult, agent.EvText, agent.EvUsage, agent.EvTurnEnd}; !slices.Equal(kinds(evs), want) {
		t.Fatalf("source events %+v, want the rest of turn 2", evs)
	}
	if end := evs[len(evs)-1]; end.Point != "uuid-two" || end.Error != "" || end.Aborted {
		t.Errorf("source's turn 2 ended with %+v, want a normal end at uuid-two", end)
	}
}
