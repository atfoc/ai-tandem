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
		{"at the end", agent.ForkSource{SessionID: "S", Point: "U", End: true},
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
func TestSpawnForkStartupFailure(t *testing.T) {
	for _, reason := range []string{
		"No message found with message.uuid of: U",
		"No conversation found with session ID: S",
	} {
		t.Run(reason, func(t *testing.T) {
			f, runs := forkFake(t, false, startupFailure(reason))
			s := f.spawner()
			s.forkTimeout = 30 * time.Second
			start := time.Now()
			a, _, err := s.SpawnFork(agent.SpawnOptions{SessionID: "N", Cwd: t.TempDir()}, agent.ForkSource{SessionID: "S", Point: "U"})
			if a != nil || err == nil || err.Error() != "claude: "+reason {
				t.Fatalf("SpawnFork = %v, %v; want the reason", a, err)
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
