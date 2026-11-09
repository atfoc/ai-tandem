package chats

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

// namerRunner is a minimal agent.Runner for the namer tests: it records what it is asked and runs
// argv on the host.
type namerRunner struct {
	err    error
	dir    string
	env    []string
	argv   []string
	killed atomic.Int32
}

func (r *namerRunner) Command(ctx context.Context, dir string, env, argv []string) (*agent.Run, error) {
	r.dir, r.env, r.argv = dir, env, argv
	if r.err != nil {
		return nil, r.err
	}
	return &agent.Run{Cmd: exec.Command(argv[0], argv[1:]...), Kill: func() error { r.killed.Add(1); return nil }}, nil
}

func namerScript(t *testing.T, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the stand-in claude is a shell script")
	}
	bin := filepath.Join(t.TempDir(), "claude")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func TestNamerThroughRunner(t *testing.T) {
	bin := namerScript(t, `echo 'Title: "Some title".'`)
	r := &namerRunner{}
	n := ClaudeNamer{Bin: bin, Runner: r}
	title, err := n.Name("fix the login page")
	if err != nil {
		t.Fatal(err)
	}
	if title != "Some title" {
		t.Fatalf("title %q, want %q", title, "Some title")
	}
	if want := append([]string{bin}, n.Args("fix the login page")...); !reflect.DeepEqual(r.argv, want) {
		t.Fatalf("argv %q, want %q", r.argv, want)
	}
	if r.dir != "/tmp" || r.env != nil {
		t.Fatalf("dir %q env %q, want /tmp and no env", r.dir, r.env)
	}
	if r.killed.Load() != 0 {
		t.Fatal("Kill called on a run that ended by itself")
	}
}

func TestNamerThroughRunnerDefaultBin(t *testing.T) {
	r := &namerRunner{err: errors.New("Docker is not running")}
	_, _ = ClaudeNamer{Runner: r}.Name("x")
	if len(r.argv) == 0 || r.argv[0] != "claude" {
		t.Fatalf("argv %q, want claude first (the container's PATH)", r.argv)
	}
}

func TestNamerRunnerError(t *testing.T) {
	r := &namerRunner{err: errors.New("Docker is not running")}
	if _, err := (ClaudeNamer{Bin: "claude", Runner: r}).Name("x"); err == nil || err.Error() != "Docker is not running" {
		t.Fatalf("err %v, want the Runner's", err)
	}
	bin := namerScript(t, "echo nope >&2; exit 3")
	if _, err := (ClaudeNamer{Bin: bin, Runner: &namerRunner{}}).Name("x"); err == nil {
		t.Fatal("a failing run named the chat")
	}
}

func TestNamerRunnerTimeout(t *testing.T) {
	bin := namerScript(t, "exec sleep 30")
	old := namerRunnerTimeout
	namerRunnerTimeout = 200 * time.Millisecond
	t.Cleanup(func() { namerRunnerTimeout = old })
	r := &namerRunner{}
	start := time.Now()
	if _, err := (ClaudeNamer{Bin: bin, Runner: r}).Name("x"); err == nil {
		t.Fatal("a run past the time limit named the chat")
	}
	if d := time.Since(start); d > 10*time.Second {
		t.Fatalf("Name took %v", d)
	}
	if r.killed.Load() != 1 {
		t.Fatalf("Kill called %d times, want 1", r.killed.Load())
	}
}
