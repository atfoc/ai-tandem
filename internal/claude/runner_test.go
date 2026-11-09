//go:build !windows

package claude

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
)

// Tests of the spawner with a Runner (a Claude account's, whose processes run in its container):
// agenttest.HostRunner stands in for the container and runs each argv on this machine.

const noMemory = "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1"

// shortClose shortens Close's grace for the test.
func shortClose(t *testing.T, d time.Duration) {
	t.Helper()
	old := closeGraceNanos.Load()
	closeGraceNanos.Store(int64(d))
	t.Cleanup(func() { closeGraceNanos.Store(old) })
}

// drain reads a's events until they close (the process has exited and the read loop has ended)
// and returns them.
func drain(t *testing.T, a agent.Agent) []agent.Event {
	t.Helper()
	var evs []agent.Event
	timeout := time.After(15 * time.Second)
	for {
		select {
		case ev, ok := <-a.Events():
			if !ok {
				return evs
			}
			evs = append(evs, ev)
		case <-timeout:
			t.Fatal("events not closed within 15 s")
			return evs
		}
	}
}

// reply sends text and returns the text of the turn it answers.
func reply(t *testing.T, a agent.Agent, text string) string {
	t.Helper()
	if err := a.Send([]agent.ContentBlock{{Text: text}}); err != nil {
		t.Fatal(err)
	}
	var sb strings.Builder
	for _, ev := range turnEvents(t, a) {
		if ev.Kind == agent.EvTextDelta || ev.Kind == agent.EvText {
			sb.WriteString(ev.Text)
		}
	}
	return sb.String()
}

// recordingClaude is a program that writes its folder and the AIWB_RUN of its environment to
// file and then runs the stand-in claude with its arguments: it tells what the Runner gave the
// process, which start must not overwrite.
func recordingClaude(t *testing.T, file string) string {
	t.Helper()
	fake := agenttest.FakeClaude(t)
	path := filepath.Join(t.TempDir(), "claude")
	script := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n%%s\\n' \"$(pwd -P)\" \"$AIWB_RUN\" > %q\nexec %q \"$@\"\n", file, fake)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// A chat through a Runner: the Runner gets today's arguments, the chat's folder and the one
// variable the adapter adds; the process keeps the Runner's folder and environment, and talks.
func TestRunnerChat(t *testing.T) {
	if !agenttest.HasNode() {
		t.Skip("the stand-in claude needs node")
	}
	rec := filepath.Join(t.TempDir(), "rec")
	h := &agenttest.HostRunner{}
	s := &Spawner{Bin: recordingClaude(t, rec), AppRoot: "/Users/me/.ai-whiteboard", Home: "/Users/me", Prompt: "P", Runner: h}
	cwd, _ := filepath.EvalSymlinks(t.TempDir())
	o := agent.SpawnOptions{ChatID: "c_ab12cd34", SessionID: "s1", Cwd: cwd, Model: "opus", Effort: "high"}
	a, err := s.Spawn(o)
	if err != nil {
		t.Fatal(err)
	}
	if got := reply(t, a, "hello there"); !strings.Contains(got, "FAKE(opus): hello there") {
		t.Errorf("reply %q, want the stand-in's answer", got)
	}
	calls := h.Calls()
	if len(calls) != 1 {
		t.Fatalf("%d Runner commands, want 1", len(calls))
	}
	c := calls[0]
	if c.Argv[0] != s.Bin || !slices.Equal(c.Argv[1:], s.Args(o)) {
		t.Errorf("argv %q\nwant %q and %q", c.Argv, s.Bin, s.Args(o))
	}
	if c.Dir != cwd {
		t.Errorf("dir %q, want %q", c.Dir, cwd)
	}
	if !slices.Equal(c.Env, []string{noMemory}) {
		t.Errorf("env %q, want only %s", c.Env, noMemory)
	}
	b, _ := os.ReadFile(rec)
	if lines := strings.Split(strings.TrimSpace(string(b)), "\n"); len(lines) != 2 || lines[0] != cwd || lines[1] != c.ID {
		t.Errorf("the process ran with %q, want its folder %s and AIWB_RUN=%s (the Runner's)", lines, cwd, c.ID)
	}
	a.Close()
	drain(t, a)
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times, want 1", n)
	}
}

// Close ends a process through the run's Kill once, when it exits after its stdin closes too;
// a later Close calls it no more.
func TestRunnerCloseKillsOnce(t *testing.T) {
	if !agenttest.HasNode() {
		t.Skip("the stand-in claude needs node")
	}
	shortClose(t, 100*time.Millisecond)
	h := &agenttest.HostRunner{}
	s := &Spawner{Bin: agenttest.FakeClaude(t), AppRoot: "/Users/me/.ai-whiteboard", Runner: h}
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "c_1", SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	drain(t, a)
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times after the exit, want 1", n)
	}
	a.Close()
	time.Sleep(300 * time.Millisecond) // past Close's grace
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times, want 1", n)
	}
}

// A process that exits by itself is ended through the run's Kill too (its detached shells may
// still run in the container), once, also when it is closed afterwards.
func TestRunnerSelfExitKillsOnce(t *testing.T) {
	if !agenttest.HasNode() {
		t.Skip("the stand-in claude needs node")
	}
	shortClose(t, 100*time.Millisecond)
	h := &agenttest.HostRunner{}
	s := &Spawner{Bin: agenttest.FakeClaude(t), AppRoot: "/Users/me/.ai-whiteboard", Runner: h}
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "c_1", SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Send([]agent.ContentBlock{{Text: "[[exit 3]]"}}); err != nil {
		t.Fatal(err)
	}
	evs := drain(t, a)
	if len(evs) == 0 || evs[len(evs)-1].Kind != agent.EvExit {
		t.Fatalf("events %v, want the exit last", kinds(evs))
	}
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times after the exit, want 1", n)
	}
	a.Close()
	time.Sleep(300 * time.Millisecond)
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times after a Close, want 1", n)
	}
}

// A process that does not exit when its stdin closes is ended by the run's Kill after Close's
// grace (ending the host's client would leave it running in the container), once.
func TestRunnerCloseKillsAStuckProcess(t *testing.T) {
	shortClose(t, 200*time.Millisecond)
	f := newFake(t)
	t.Setenv(envDeaf, "1") // reads nothing and stays 30 s
	h := &agenttest.HostRunner{}
	s := f.spawner()
	s.Runner = h
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "c_1", SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	a.Close()
	drain(t, a)
	if d := time.Since(start); d > 10*time.Second {
		t.Errorf("the process ended after %s", d)
	}
	time.Sleep(300 * time.Millisecond)
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times, want 1", n)
	}
}

// With MCPDir and MCPURL the --mcp-config file of each chat object is in MCPDir, holds MCPURL with
// the process's token, and nothing is written in the chat object's folder. MCPDir is left as the
// account made it.
func TestRunnerMCPConfigInMCPDir(t *testing.T) {
	newFake(t)
	root := t.TempDir()
	mcpDir := filepath.Join(root, "aliases", "a_1", "mcp") // the account's, made with it
	if err := os.MkdirAll(mcpDir, 0o700); err != nil {
		t.Fatal(err)
	}
	h := &agenttest.HostRunner{}
	s := &Spawner{Bin: os.Args[0], AppRoot: root, Prompt: "P", Runner: h,
		MCPDir: mcpDir, MCPURL: "http://host.docker.internal:6006/mcp"}
	chatDir := filepath.Join(t.TempDir(), "c_ab12cd34")
	cases := []struct {
		o    agent.SpawnOptions
		file string
		gone string // the chat object's folder, which must not be made
	}{
		{agent.SpawnOptions{ChatID: "c_ab12cd34", Dir: chatDir, SessionID: "s1", Cwd: t.TempDir(),
			MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "tok-chat"}},
			"c_ab12cd34.json", chatDir},
		{agent.SpawnOptions{ChatID: "c_ab12cd34/subagents/s_ef56gh78", SessionID: "s2", Cwd: t.TempDir(), Subagent: true,
			MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "tok-sub"}},
			"c_ab12cd34-subagents-s_ef56gh78.json", filepath.Join(root, "chats", "c_ab12cd34", "subagents", "s_ef56gh78")},
	}
	for i, c := range cases {
		a, err := s.Spawn(c.o)
		if err != nil {
			t.Fatal(err)
		}
		a.Close()
		drain(t, a)
		want := filepath.Join(mcpDir, c.file)
		if v, _ := flag(h.Calls()[i].Argv, "--mcp-config"); v != want {
			t.Errorf("--mcp-config = %q, want %q", v, want)
		}
		fi, err := os.Stat(want)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s: mode %o, want 600", c.file, fi.Mode().Perm())
		}
		b, _ := os.ReadFile(want)
		body := `{"mcpServers":{"board":{"type":"http","url":"http://host.docker.internal:6006/mcp","headers":{"Authorization":"Bearer ` + c.o.MCP.Token + `"}}}}`
		if string(b) != body {
			t.Errorf("%s holds %s\nwant %s", c.file, b, body)
		}
		if _, err := os.Stat(c.gone); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("the chat object's folder %s was made (%v)", c.gone, err)
		}
	}
	if fi, err := os.Stat(mcpDir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("MCPDir: %v, %v; want mode 700", fi, err)
	}
	if left, _ := filepath.Glob(filepath.Join(mcpDir, "*.tmp")); len(left) > 0 {
		t.Errorf("temporary files left: %q", left)
	}
	if _, err := os.Stat(filepath.Join(root, "chats")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a chats folder was made: %v", err)
	}
}

// Every chat object gets a file of its own: the flattening of a ChatID cannot meet another's.
func TestMCPFileName(t *testing.T) {
	ids := []string{"c_ab12cd34", "c_ab12cd34/subagents/s_ef56gh78", "c_ab12cd34_subagents_s_ef56gh78",
		"c_ab12cd34/subagents/s_ef56gh78/subagents/s_0123abcd"}
	seen := map[string]string{}
	for _, id := range ids {
		n := mcpFileName(id)
		if strings.Contains(n, "/") || !strings.HasSuffix(n, ".json") {
			t.Errorf("%q → %q", id, n)
		}
		if other, ok := seen[n]; ok {
			t.Errorf("%q and %q both → %q", id, other, n)
		}
		seen[n] = id
	}
	if n := mcpFileName("c_ab12cd34/subagents/s_ef56gh78"); n != "c_ab12cd34-subagents-s_ef56gh78.json" {
		t.Errorf("name %q", n)
	}
}

// What the Runner fails with is the start's error, as it is, and nothing is started.
func TestRunnerCommandError(t *testing.T) {
	f := newFake(t)
	runs := filepath.Join(f.dir, "runs.jsonl")
	t.Setenv(envRuns, runs)
	reason := errors.New("Docker is not running")
	s := f.spawner()
	s.Runner = &agenttest.HostRunner{Err: reason}
	if _, err := s.Spawn(agent.SpawnOptions{ChatID: "c_1", SessionID: "s1", Cwd: t.TempDir()}); err == nil || err.Error() != reason.Error() {
		t.Errorf("Spawn: %v, want %v", err, reason)
	}
	if _, err := s.Catalog(5 * time.Second); err == nil || err.Error() != reason.Error() {
		t.Errorf("Catalog: %v, want %v", err, reason)
	}
	if _, err := s.Usage(); err == nil || err.Error() != reason.Error() {
		t.Errorf("Usage: %v, want %v", err, reason)
	}
	if rs := readRuns(t, runs); len(rs) != 0 {
		t.Errorf("processes started: %+v", rs)
	}
}

// waitRunner makes its place ready until ctx ends.
type waitRunner struct{ deadline chan bool }

func (w waitRunner) Command(ctx context.Context, dir string, env, argv []string) (*agent.Run, error) {
	_, ok := ctx.Deadline()
	w.deadline <- ok
	<-ctx.Done()
	return nil, fmt.Errorf("the container did not start: %w", ctx.Err())
}

// start bounds the Runner's preparation (runnerWaitNanos).
func TestRunnerPreparationIsBounded(t *testing.T) {
	old := runnerWaitNanos.Load()
	runnerWaitNanos.Store(int64(100 * time.Millisecond))
	t.Cleanup(func() { runnerWaitNanos.Store(old) })
	w := waitRunner{deadline: make(chan bool, 1)}
	s := &Spawner{Bin: "claude", AppRoot: "/Users/me/.ai-whiteboard", Runner: w}
	_, err := s.Spawn(agent.SpawnOptions{ChatID: "c_1", SessionID: "s1", Cwd: t.TempDir()})
	if err == nil || err.Error() != "the container did not start: context deadline exceeded" {
		t.Errorf("err %v", err)
	}
	if !<-w.deadline {
		t.Error("the Runner's ctx has no deadline")
	}
}

// D20: an account's spawner has Home "": its rules name the app's folder by its absolute path
// (the container's ~ is not the host's), and a tool input with that path is refused.
func TestRunnerAppDirRulesAbsolute(t *testing.T) {
	root := "/Users/me/.ai-whiteboard"
	s := &Spawner{AppRoot: root, Home: "", Runner: &agenttest.HostRunner{}}
	v, _ := flag(s.Args(agent.SpawnOptions{SessionID: "s1"}), "--disallowedTools")
	want := "Read(//Users/me/.ai-whiteboard/**),Edit(//Users/me/.ai-whiteboard/**),Write(//Users/me/.ai-whiteboard/**),Bash(*.ai-whiteboard*),Task,Agent"
	if v != want {
		t.Errorf("--disallowedTools %q\nwant %q", v, want)
	}
	if strings.Contains(v, "~") {
		t.Errorf("a rule under ~: %q", v)
	}
	if !agent.TouchesAppDir([]byte(`{"file_path":"/Users/me/.ai-whiteboard/aliases/a_1/claude/.credentials.json"}`), s.AppRoot, s.Home) {
		t.Error("a path in the app's folder is not refused")
	}
}

// A fork goes through the Runner, with the source's resume arguments and the fork's, and is
// ended there once it is closed.
func TestRunnerFork(t *testing.T) {
	f, _ := forkFake(t, true)
	h := &agenttest.HostRunner{}
	s := f.spawner()
	s.Runner = h
	cwd := t.TempDir()
	o := agent.SpawnOptions{ChatID: "c_1", SessionID: "N", Cwd: cwd, Model: "sonnet"}
	a, _, err := s.SpawnFork(o, agent.ForkSource{ChatID: "c_0", SessionID: "S", Point: "U"})
	if err != nil {
		t.Fatal(err)
	}
	onlyInitialize(t, f, a)
	calls := h.Calls()
	if len(calls) != 1 {
		t.Fatalf("%d Runner commands, want 1", len(calls))
	}
	o.SessionID, o.Resume = "S", true
	want := append(append([]string{s.Bin}, s.Args(o)...), "--fork-session", "--resume-session-at", "U", "--session-id", "N")
	if !slices.Equal(calls[0].Argv, want) || calls[0].Dir != cwd || !slices.Equal(calls[0].Env, []string{noMemory}) {
		t.Errorf("command %+v\nwant argv %q in %s", calls[0], want, cwd)
	}
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times, want 1", n)
	}
}

// The context-split reader goes through the Runner and is ended there.
func TestRunnerReadContextSplit(t *testing.T) {
	f := newFake(t)
	ctxAnswers(t, f, string(readFixture(t)))
	h := &agenttest.HostRunner{}
	s := f.spawner()
	s.Runner = h
	cwd := t.TempDir()
	split, err := s.ReadContextSplit(agent.SpawnOptions{ChatID: "c_1", SessionID: "s1", Cwd: cwd, Model: "opus"})
	if err != nil {
		t.Fatal(err)
	}
	if split.Total != 47894 {
		t.Errorf("total %d", split.Total)
	}
	calls := h.Calls()
	if len(calls) != 1 || calls[0].Dir != cwd || !slices.Contains(calls[0].Argv, "--fork-session") {
		t.Fatalf("commands %+v, want the fork reader in %s", calls, cwd)
	}
	if v, _ := flag(calls[0].Argv, "--resume"); v != "s1" {
		t.Errorf("argv %q, want --resume s1", calls[0].Argv)
	}
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times, want 1", n)
	}
}

// The catalog probe and its sign-in check go through the Runner, in /tmp; runs that ended by
// themselves are not killed.
func TestRunnerCatalog(t *testing.T) {
	f, _ := probeFake(t)
	h := &agenttest.HostRunner{}
	s := f.spawner()
	s.Runner = h
	cat, err := s.Catalog(10 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Models) == 0 {
		t.Error("no models")
	}
	calls := h.Calls()
	if len(calls) != 2 {
		t.Fatalf("%d Runner commands, want the sign-in check and the probe", len(calls))
	}
	if c := calls[0]; !slices.Equal(c.Argv, []string{s.Bin, "auth", "status"}) || c.Dir != "/tmp" || len(c.Env) != 0 {
		t.Errorf("sign-in check %+v", c)
	}
	if c := calls[1]; !slices.Equal(c.Argv[1:], ProbeArgs()) || c.Dir != "/tmp" || !slices.Equal(c.Env, []string{noMemory}) {
		t.Errorf("probe %+v", c)
	}
	if h.Kills(0) != 0 || h.Kills(1) != 0 {
		t.Errorf("kills %d, %d; want none", h.Kills(0), h.Kills(1))
	}
}

// A probe cut short by the timeout is ended through the run's Kill too.
func TestRunnerCatalogTimeoutKills(t *testing.T) {
	f, runsFile := probeFake(t)
	t.Setenv(envInit, "") // the probe never answers
	h := &agenttest.HostRunner{}
	s := f.spawner()
	s.Runner = h
	_, err := s.Catalog(3 * time.Second)
	if err == nil || !(strings.Contains(err.Error(), "did not report its models") || signInTimedOut(err)) {
		t.Fatalf("err %v, want a timeout", err)
	}
	switch calls := h.Calls(); {
	case len(calls) == 2: // the probe was cut short
		if h.Kills(0) != 0 || h.Kills(1) != 1 {
			t.Errorf("kills %d, %d; want 0, 1", h.Kills(0), h.Kills(1))
		}
	case len(calls) == 1: // a busy machine: the sign-in check was
		if h.Kills(0) != 1 {
			t.Errorf("kills %d, want 1", h.Kills(0))
		}
	default:
		t.Fatalf("%d Runner commands", len(calls))
	}
	noneAlive(t, readRuns(t, runsFile))
}

// A sign-in check cut short by the timeout is ended through the run's Kill.
func TestRunnerAuthStatusTimeoutKills(t *testing.T) {
	f, _ := probeFake(t)
	pidFile := filepath.Join(f.dir, "hold.pid")
	t.Setenv(envHold, pidFile) // auth status hangs, with a child holding its output
	h := &agenttest.HostRunner{}
	s := f.spawner()
	s.Runner = h
	_, err := s.Catalog(time.Second)
	if !signInTimedOut(err) {
		t.Fatalf("err %v, want the sign-in check's timeout", err)
	}
	if calls := h.Calls(); len(calls) != 1 || calls[0].Dir != "/tmp" {
		t.Fatalf("commands %+v, want the sign-in check alone", calls)
	}
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times, want 1", n)
	}
}

// Usage goes through the Runner, in /tmp.
func TestRunnerUsage(t *testing.T) {
	newFake(t, strings.Split(strings.TrimSpace(string(usageFixture(t))), "\n")...)
	h := &agenttest.HostRunner{}
	s := &Spawner{Bin: os.Args[0], Runner: h}
	u, err := s.Usage()
	if err != nil {
		t.Fatal(err)
	}
	if !u.Plan || len(u.Limits) != 3 {
		t.Fatalf("usage %+v", u)
	}
	calls := h.Calls()
	if len(calls) != 1 || calls[0].Dir != "/tmp" || !slices.Equal(calls[0].Argv[1:], UsageArgs()) || !slices.Equal(calls[0].Env, []string{noMemory}) {
		t.Fatalf("commands %+v", calls)
	}
	if n := h.Kills(0); n != 0 {
		t.Errorf("Kill called %d times for a run that ended by itself", n)
	}
}

// A usage run that does not answer in time is killed, there and on the host.
func TestRunnerUsageTimeoutKills(t *testing.T) {
	newFake(t)
	t.Setenv(envDeaf, "1") // prints nothing and stays 30 s
	old := usageTimeout
	usageTimeout = 300 * time.Millisecond
	t.Cleanup(func() { usageTimeout = old })
	h := &agenttest.HostRunner{}
	start := time.Now()
	_, err := (&Spawner{Bin: os.Args[0], Runner: h}).Usage()
	if err == nil || err.Error() != "claude /usage: no answer within 300ms" {
		t.Fatalf("err %v", err)
	}
	if d := time.Since(start); d > 10*time.Second {
		t.Errorf("took %s", d)
	}
	if n := h.Kills(0); n != 1 {
		t.Errorf("Kill called %d times, want 1", n)
	}
}
