//go:build !windows

package claude

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
)

// Every run the spawner gets from its Runner is ended with exactly one of Kill (cut short) and
// Release (never started, or waited for and ended by itself), so that an account's runner, which
// keeps its live runs until then, forgets each of them.

// endRunner is an agenttest.HostRunner that also counts each run's Release beside its Kill. The
// runs from the badFrom-th Command on (0 = none) get a program that does not exist, so their
// start fails.
type endRunner struct {
	h       agenttest.HostRunner
	badFrom int

	mu   sync.Mutex
	ends []*runEnds
}

type runEnds struct{ kills, releases int }

func (r *endRunner) Command(ctx context.Context, dir string, env, argv []string) (*agent.Run, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, err := r.h.Command(ctx, dir, env, argv)
	if err != nil {
		return nil, err
	}
	e := &runEnds{}
	r.ends = append(r.ends, e)
	if r.badFrom > 0 && len(r.ends) >= r.badFrom {
		run.Cmd.Path = filepath.Join(os.TempDir(), "aiwb-no-such-program")
	}
	kill := run.Kill
	run.Kill = func() error {
		r.mu.Lock()
		e.kills++
		r.mu.Unlock()
		return kill()
	}
	run.Release = func() {
		r.mu.Lock()
		e.releases++
		r.mu.Unlock()
	}
	return run, nil
}

// got is how each run so far was ended.
func (r *endRunner) got() []runEnds {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]runEnds, len(r.ends))
	for i, e := range r.ends {
		out[i] = *e
	}
	return out
}

// want checks that there were n runs, each ended as want says ("kill" or "release") and once.
func (r *endRunner) want(t *testing.T, want ...string) {
	t.Helper()
	got := r.got()
	if len(got) != len(want) {
		t.Fatalf("%d runs %+v, want %d", len(got), got, len(want))
	}
	for i, w := range want {
		k, rel := 0, 1
		if w == "kill" {
			k, rel = 1, 0
		}
		if got[i].kills != k || got[i].releases != rel {
			t.Errorf("run %d: %d kills, %d releases; want it ended by %s once", i, got[i].kills, got[i].releases, w)
		}
	}
}

// waitEnds waits until the n-th run (from 0) has been ended at all, for ends that come on a
// goroutine after the call returned (a login's).
func (r *endRunner) waitEnds(t *testing.T, i int) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if g := r.got(); len(g) > i && g[i].kills+g[i].releases > 0 {
			return
		}
	}
}

// AuthStatus that exits by itself is released, not killed.
func TestReleaseAuthStatus(t *testing.T) {
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH")
	}
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	r := &endRunner{}
	s := &Spawner{Bin: agenttest.FakeClaude(t), Runner: r}
	if _, err := s.AuthStatus(shortCtx(t, 20*time.Second)); err != nil {
		t.Fatal(err)
	}
	r.want(t, "release")
}

// A run whose start fails is released, whichever command it was.
func TestReleaseStartFailure(t *testing.T) {
	f, _ := probeFake(t)
	cases := []struct {
		name string
		do   func(s *Spawner) error
		runs []string
	}{
		{"chat", func(s *Spawner) error {
			_, err := s.Spawn(agent.SpawnOptions{ChatID: "c_1", SessionID: "s1", Cwd: t.TempDir()})
			return err
		}, []string{"release"}},
		{"auth status", func(s *Spawner) error { _, err := s.AuthStatus(shortCtx(t, 10*time.Second)); return err }, []string{"release"}},
		{"logout", func(s *Spawner) error { return s.Logout(shortCtx(t, 10*time.Second)) }, []string{"release"}},
		{"catalog sign-in check", func(s *Spawner) error { _, err := s.Catalog(10 * time.Second); return err }, []string{"release"}},
		{"usage", func(s *Spawner) error { _, err := s.Usage(); return err }, []string{"release"}},
		{"login", func(s *Spawner) error { _, err := s.StartLogin(shortCtx(t, 10*time.Second)); return err }, []string{"release"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := &endRunner{badFrom: 1}
			s := f.spawner()
			s.Runner = r
			if err := c.do(s); err == nil {
				t.Fatal("no error")
			}
			r.want(t, c.runs...)
		})
	}
	t.Run("catalog probe", func(t *testing.T) { // the sign-in check ended by itself; the probe never started
		r := &endRunner{badFrom: 2}
		s := f.spawner()
		s.Runner = r
		if _, err := s.Catalog(10 * time.Second); err == nil || !strings.Contains(err.Error(), "cannot start") {
			t.Fatalf("err %v, want the probe's start failure", err)
		}
		r.want(t, "release", "release")
	})
}

// A catalog probe that answers ends each of its runs once: the sign-in check by itself
// (released), the probe by itself after its stdin closes (released) or by its Kill after the grace.
func TestReleaseCatalog(t *testing.T) {
	f, _ := probeFake(t)
	r := &endRunner{}
	s := f.spawner()
	s.Runner = r
	if _, err := s.Catalog(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	got := r.got()
	if len(got) != 2 {
		t.Fatalf("%d runs, want 2", len(got))
	}
	if got[0] != (runEnds{releases: 1}) {
		t.Errorf("sign-in check: %+v, want released once", got[0])
	}
	if p := got[1]; p.kills+p.releases != 1 {
		t.Errorf("probe: %+v, want exactly one of Kill and Release", p)
	}
}

// A probe that exits without answering (by itself) is released too.
func TestReleaseCatalogExitWithoutAnswer(t *testing.T) {
	f, _ := probeFake(t)
	t.Setenv(envExit, "3")
	r := &endRunner{}
	s := f.spawner()
	s.Runner = r
	if _, err := s.Catalog(10 * time.Second); err == nil {
		t.Fatal("no error")
	}
	r.want(t, "release", "release")
}

// Usage that ends by itself is released.
func TestReleaseUsage(t *testing.T) {
	newFake(t, strings.Split(strings.TrimSpace(string(usageFixture(t))), "\n")...)
	r := &endRunner{}
	if _, err := (&Spawner{Bin: os.Args[0], Runner: r}).Usage(); err != nil {
		t.Fatal(err)
	}
	r.want(t, "release")
}

// A login that ends by itself (a good code) is released; a cancelled one is killed.
func TestReleaseLogin(t *testing.T) {
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH")
	}
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	t.Run("ends by itself", func(t *testing.T) {
		r := &endRunner{}
		l := startLogin(t, &Spawner{Bin: agenttest.FakeClaude(t), Runner: r})
		if res, err := l.Code(shortCtx(t, 20*time.Second), "good#code"); err != nil || res.State != LoginLoggedIn {
			t.Fatalf("Code = %+v, %v", res, err)
		}
		waitDone(t, l)
		l.Cancel() // after the end: no kill
		r.want(t, "release")
	})
	t.Run("cancelled", func(t *testing.T) {
		r := &endRunner{}
		l := startLogin(t, &Spawner{Bin: agenttest.FakeClaude(t), Runner: r})
		l.Cancel()
		waitDone(t, l)
		r.waitEnds(t, 0)
		r.want(t, "kill")
	})
}

// A chat's run is killed at its end, never released as well.
func TestReleaseChatIsKilled(t *testing.T) {
	newFake(t)
	shortClose(t, 100*time.Millisecond)
	r := &endRunner{}
	s := &Spawner{Bin: os.Args[0], AppRoot: "/Users/me/.ai-whiteboard", Prompt: "P", Runner: r}
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "c_1", SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	drain(t, a)
	r.want(t, "kill")
}

// #10: the --mcp-config file is written only once the Runner gave a run: a Runner that fails
// (a removed account) leaves no file and makes no folder, MCPDir or the chat's.
func TestMCPConfigNotWrittenWhenCommandFails(t *testing.T) {
	root := t.TempDir()
	mcpDir := filepath.Join(root, "aliases", "a_1", "mcp")
	chatDir := filepath.Join(root, "chats", "c_1")
	reason := errors.New("the account was removed")
	board := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "tok"}
	for _, s := range []*Spawner{
		{Bin: "claude", AppRoot: root, Runner: &agenttest.HostRunner{Err: reason}, MCPDir: mcpDir, MCPURL: "http://host.docker.internal:6006/mcp"},
		{Bin: "claude", AppRoot: root, Runner: &agenttest.HostRunner{Err: reason}},
	} {
		_, err := s.Spawn(agent.SpawnOptions{ChatID: "c_1", Dir: chatDir, SessionID: "s1", Cwd: t.TempDir(), MCP: board})
		if !errors.Is(err, reason) && (err == nil || err.Error() != reason.Error()) {
			t.Errorf("Spawn: %v, want %v", err, reason)
		}
	}
	for _, d := range []string{filepath.Join(root, "aliases"), filepath.Join(root, "chats")} {
		if _, err := os.Stat(d); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s was made (%v)", d, err)
		}
	}
}

// #10: a spawner whose MCPDir is gone (its account was removed) fails the start, does not make
// the folder again, starts nothing and releases the run.
func TestMCPDirMissingFailsStart(t *testing.T) {
	f := newFake(t)
	runs := filepath.Join(f.dir, "runs.jsonl")
	t.Setenv(envRuns, runs)
	root := t.TempDir()
	mcpDir := filepath.Join(root, "aliases", "a_1", "mcp")
	r := &endRunner{}
	s := &Spawner{Bin: os.Args[0], AppRoot: root, Prompt: "P", Runner: r, MCPDir: mcpDir,
		MCPURL: "http://host.docker.internal:6006/mcp"}
	_, err := s.Spawn(agent.SpawnOptions{ChatID: "c_1", SessionID: "s1", Cwd: t.TempDir(),
		MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "tok"}})
	if err == nil || !strings.Contains(err.Error(), "removed") {
		t.Fatalf("Spawn: %v, want the account's folder gone", err)
	}
	if _, err := os.Stat(filepath.Join(root, "aliases")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the account's folder was made again (%v)", err)
	}
	if rs := readRuns(t, runs); len(rs) != 0 {
		t.Errorf("processes started: %+v", rs)
	}
	r.want(t, "release")
}
