package headless

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/testset"
	"ai-whiteboard/internal/version"
)

func ensure(t *testing.T, r *rig) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	id, err := r.m.Ensure(ctx)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	return id
}

// The process gets its credentials as one JSON line on its stdin, and nowhere else (D32); the bridge is told
// its client id before it starts (D30); Ensure again is the same process; Close ends it and clears the id.
func TestConfigLineAndLife(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{Quiet: 90 * time.Second, Handover: 7 * time.Second})
	id := ensure(t, r)
	if len(id) != 36 || id[14] != '4' {
		t.Fatalf("the client id %q is not a version 4 UUID", id)
	}
	c := r.config()
	want := config{Address: "127.0.0.1:4747", Fingerprint: "ab:cd", Secret: "s3cret-value", ClientID: id,
		InstanceID: "inst-1", QuietMs: 90000, HandoverMs: 7000, Version: version.Version}
	if c != want {
		t.Fatalf("configuration line = %+v, want %+v", c, want)
	}
	for _, f := range []string{"env", "args"} {
		b, err := os.ReadFile(filepath.Join(r.out, f))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "s3cret-value") {
			t.Errorf("the secret is in the process's %s:\n%s", f, b)
		}
	}
	if args, _ := os.ReadFile(filepath.Join(r.out, "args")); !strings.Contains(string(args), filepath.Join(r.bundle, BundleFile)) {
		t.Errorf("the process was started as %q, want it to run the bundle's %s", args, BundleFile)
	}
	r.b.mu.Lock()
	first, atSet := r.b.setAway[0], r.b.atSet[0]
	r.b.mu.Unlock()
	if first != id || atSet {
		t.Errorf("SetAway(%q) with the process already configured = %v, want SetAway(%q) before it starts", first, atSet, id)
	}
	if id2 := ensure(t, r); id2 != id || len(r.starts()) != 1 {
		t.Fatalf("Ensure again = %q after %d starts, want the same process %q", id2, len(r.starts()), id)
	}
	if st := r.m.Status(); !st.Available || !st.Running || st.PID == 0 || st.Boards != 0 {
		t.Errorf("Status = %+v, want available and running with no board", st)
	}

	pid := r.starts()[0]
	r.m.Close()
	if alive(pid) {
		t.Errorf("process %s is still there after Close", pid)
	}
	if got := r.b.awayNow(); got != "" {
		t.Errorf("the away client after the exit is %q, want none", got)
	}
	if b, _ := os.ReadFile(filepath.Join(r.out, "exits")); string(b) != "saved\n" {
		t.Errorf("the process was not ended by its stdin closing: exits = %q", b)
	}
	if _, err := r.m.Ensure(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Errorf("Ensure after Close = %v, want ErrUnavailable", err)
	}
}

// Callers at the same time share one start (D31).
func TestSharedStart(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{})
	const n = 8
	ids := make([]string, n)
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := r.m.Ensure(context.Background())
			if err != nil {
				t.Errorf("Ensure: %v", err)
			}
			ids[i] = id
		}()
	}
	wg.Wait()
	for _, id := range ids {
		if id == "" || id != ids[0] {
			t.Fatalf("ids = %q, want the same one for all", ids)
		}
	}
	if s := r.starts(); len(s) != 1 {
		t.Fatalf("%d processes started for %d callers, want 1", len(s), n)
	}
}

// A process that does not open its stream within the start limit is stopped, and the reason is kept (D31).
func TestStartLimit(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{StartLimit: 300 * time.Millisecond})
	r.mode("silent")
	_, err := r.m.Ensure(context.Background())
	if !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "did not connect within 300ms") {
		t.Fatalf("Ensure = %v, want ErrUnavailable: did not connect within 300ms", err)
	}
	pid := r.starts()[0]
	eventually(t, "the silent process to be stopped", func() bool { return !alive(pid) })
	eventually(t, "the away client to be cleared", func() bool { return r.b.awayNow() == "" })
	if st := r.m.Status(); st.Available || st.Running || !strings.Contains(st.Reason, "did not connect") {
		t.Errorf("Status = %+v, want unavailable with the reason", st)
	}
}

// A start that exits early keeps the reason the process printed, with its exit status; the failure is logged once
// and remembered for the retry wait, then tried again (D31).
func TestEarlyExitAndRetryWait(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{Retry: time.Minute})
	r.mode("exit3")
	_, err := r.m.Ensure(context.Background())
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Ensure = %v, want ErrUnavailable", err)
	}
	for _, want := range []string{"exit status 3", "the board engine is not built"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the reason %q lacks %q", err, want)
		}
	}
	if n := r.logs.count("headless writer: not started"); n != 1 {
		t.Errorf("%d log lines for the failure, want 1: %q", n, r.logs.all())
	}
	if n := r.logs.count("headless: the board engine is not built"); n != 1 {
		t.Errorf("the process's line was logged %d times, want once: %q", n, r.logs.all())
	}

	// Inside the retry wait: at once, the same error, no new process, no new log line.
	r.mode("") // it would start now
	r.clock.advance(59 * time.Second)
	_, err2 := r.m.Ensure(context.Background())
	if err2 == nil || err2.Error() != err.Error() || len(r.starts()) != 1 {
		t.Fatalf("Ensure inside the wait = %v after %d starts, want the same error and no start", err2, len(r.starts()))
	}
	if st := r.m.Status(); st.Available || st.Reason != reasonOf(err) {
		t.Errorf("Status in the wait = %+v, want the remembered reason", st)
	}
	if n := r.logs.count("not started"); n != 1 {
		t.Errorf("%d failure lines, want still 1", n)
	}

	// After the wait: it is tried again.
	r.clock.advance(2 * time.Second)
	id := ensure(t, r)
	if id == "" || len(r.starts()) != 2 {
		t.Fatalf("after the wait: id %q after %d starts, want a second start", id, len(r.starts()))
	}
}

// A lookup that fails (no runtime) is remembered the same way, and nothing is started.
func TestNoRuntime(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{Node: "/nonexistent/node"})
	_, err := r.m.Ensure(context.Background())
	if !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), "-headless-node") {
		t.Fatalf("Ensure = %v, want ErrUnavailable naming -headless-node", err)
	}
	if len(r.b.setAway) != 0 {
		t.Errorf("SetAway was called %q for a process that was never started", r.b.setAway)
	}
}

// A running process that holds nothing and has no call open at two looks in a row is stopped (D28).
func TestIdleStop(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{Linger: 20 * time.Millisecond})
	id := ensure(t, r)
	pid := r.starts()[0]
	eventually(t, "the idle process to be stopped", func() bool { return !alive(pid) })
	eventually(t, "the away client to be cleared", func() bool { return r.b.awayNow() == "" })
	r.b.mu.Lock()
	looks := r.b.looks
	r.b.mu.Unlock()
	if looks < 2 {
		t.Errorf("stopped after %d looks, want at least 2", looks)
	}
	if b, _ := os.ReadFile(filepath.Join(r.out, "exits")); string(b) != "saved\n" {
		t.Errorf("the process was not asked to go by its stdin closing: exits = %q", b)
	}
	// The next call starts a new one, with an id of its own.
	id2 := ensure(t, r)
	if id2 == id || len(r.starts()) != 2 {
		t.Fatalf("after the idle stop: id %q (was %q) after %d starts, want a new process", id2, id, len(r.starts()))
	}
}

// A process that holds a board, or has a call open, is not stopped; it is once it holds nothing.
func TestBusyIsNotStopped(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name string
		set  func(b *fakeBridge, on bool)
	}{
		{"holds a board", func(b *fakeBridge, on bool) { b.set(func(b *fakeBridge) { b.holds = on }) }},
		{"has a call", func(b *fakeBridge, on bool) { b.set(func(b *fakeBridge) { b.calls = on }) }},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			r := newRig(t, Options{Linger: 10 * time.Millisecond})
			c.set(r.b, true)
			ensure(t, r)
			pid := r.starts()[0]
			r.b.mu.Lock()
			from := r.b.looks
			r.b.mu.Unlock()
			// Let it be looked at many times.
			eventually(t, "ten looks", func() bool {
				r.b.mu.Lock()
				defer r.b.mu.Unlock()
				return r.b.looks >= from+10
			})
			if !alive(pid) {
				t.Fatal("the process was stopped while busy")
			}
			c.set(r.b, false)
			eventually(t, "the process to be stopped once idle", func() bool { return !alive(pid) })
		})
	}
}

// Ensure counts as use: a process is not stopped by looks made before it.
func TestEnsureResetsIdle(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{Linger: time.Hour})
	id := ensure(t, r)
	r.m.mu.Lock()
	p := r.m.cur
	p.idle = 1
	r.m.mu.Unlock()
	ensure(t, r)
	r.m.mu.Lock()
	idle := p.idle
	r.m.mu.Unlock()
	if idle != 0 {
		t.Fatalf("idle looks after Ensure = %d, want 0 (process %s)", idle, id)
	}
}

// CallTimedOut kills the process; the next Ensure starts another (D29).
func TestCallTimedOutKills(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{})
	r.mode("stubborn")
	id := ensure(t, r)
	pid := r.starts()[0]
	r.m.CallTimedOut()
	eventually(t, "the process to be killed", func() bool { return !alive(pid) })
	eventually(t, "the away client to be cleared", func() bool { return r.b.awayNow() == "" })
	r.mode("")
	id2 := ensure(t, r)
	if id2 == id || len(r.starts()) != 2 {
		t.Fatalf("after the kill: %q (was %q) after %d starts, want a new process", id2, id, len(r.starts()))
	}
	r.m.CallTimedOut() // nothing wrong with calling it twice, or with no process
	r.m.CallTimedOut()
}

// A process that ignores its stdin closing and SIGTERM is killed at the end of the stop sequence (D35).
func TestStopEscalates(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{})
	r.m.stopGrace, r.m.termGrace = 100*time.Millisecond, 100*time.Millisecond
	r.mode("stubborn")
	ensure(t, r)
	pid := r.starts()[0]
	r.m.Close()
	if alive(pid) {
		t.Fatalf("process %s survived Close", pid)
	}
	if r.b.awayNow() != "" {
		t.Errorf("the away client is %q after the exit", r.b.awayNow())
	}
}

// A process that is up but whose stream is gone is ending: Ensure starts another instead of giving it out.
func TestStreamGone(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{})
	id := ensure(t, r)
	r.b.set(func(b *fakeBridge) { b.dropped[id] = true })
	id2 := ensure(t, r)
	if id2 == id {
		t.Fatalf("Ensure gave out %q, whose stream is gone", id)
	}
	pid := r.starts()[0]
	eventually(t, "the old process to be stopped", func() bool { return !alive(pid) })
	// The old process's exit must not clear the new one's id.
	if got := r.b.awayNow(); got != id2 {
		t.Errorf("the away client = %q after the old process exited, want the new one %q", got, id2)
	}
}

// A caller that gives up does not end the start the others wait for.
func TestEnsureContext(t *testing.T) {
	t.Parallel()
	r := newRig(t, Options{})
	r.mode("silent")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := r.m.Ensure(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Ensure with a cancelled context = %v, want context.Canceled", err)
	}
}

func TestStatus(t *testing.T) {
	t.Parallel()
	t.Run("unavailable", func(t *testing.T) {
		t.Parallel()
		r := newRig(t, Options{Dir: t.TempDir()}) // a folder with no bundle
		st := r.m.Status()
		if st.Available || st.Running || st.PID != 0 || !strings.Contains(st.Reason, BundleFile) {
			t.Fatalf("Status = %+v, want unavailable because %s is missing", st, BundleFile)
		}
	})
	t.Run("available, not running", func(t *testing.T) {
		t.Parallel()
		r := newRig(t, Options{})
		if st := r.m.Status(); !st.Available || st.Running || st.Reason != "" {
			t.Fatalf("Status = %+v, want available and not running", st)
		}
		if len(r.starts()) != 0 {
			t.Fatal("Status started the process")
		}
	})
	t.Run("boards", func(t *testing.T) {
		t.Parallel()
		r := newRig(t, Options{})
		ensure(t, r)
		r.b.set(func(b *fakeBridge) { b.holds = true })
		if st := r.m.Status(); st.Boards != 1 {
			t.Errorf("Boards without a counter = %d, want 1 for a client that holds any", st.Boards)
		}
		r.m.b = countingBridge{r.b, 3}
		if st := r.m.Status(); st.Boards != 3 {
			t.Errorf("Boards with a counter = %d, want 3", st.Boards)
		}
	})
}

// A bundle of another version than the server is not used (D34).
func TestBundleVersionMismatch(t *testing.T) {
	r := newRig(t, Options{})
	old := version.Version
	version.Version = "1.2.3"
	defer func() { version.Version = old }()
	writeBundle(t, r.bundle, "9.9.9", standIn)
	_, err := r.m.Ensure(context.Background())
	if !errors.Is(err, ErrUnavailable) || !strings.Contains(err.Error(), `"9.9.9"`) {
		t.Fatalf("Ensure = %v, want ErrUnavailable naming the bundle's version", err)
	}
	if len(r.starts()) != 0 {
		t.Error("a bundle of another version was started")
	}
}

// The desktop app's Electron is run as Node (ELECTRON_RUN_AS_NODE=1) (D33.2).
func TestElectronRuntime(t *testing.T) {
	t.Parallel()
	if os.Getenv("ELECTRON_RUN_AS_NODE") != "" {
		t.Skip("ELECTRON_RUN_AS_NODE is set in the environment of the test")
	}
	root := t.TempDir()
	macos := filepath.Join(root, "AI Whiteboard.app", "Contents", "MacOS")
	if err := os.MkdirAll(macos, 0o755); err != nil {
		t.Fatal(err)
	}
	// "Electron": a program that runs its arguments with sh.
	if err := os.WriteFile(filepath.Join(macos, ElectronProgram), []byte("#!/bin/sh\necho electron >> \"$STANDIN_OUT/electron\"\nexec /bin/sh \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	r := newRig(t, Options{})
	r.m.o.Node = ""
	r.m.look.Executable = func() (string, error) { return filepath.Join(macos, "ai-whiteboard"), nil }
	r.m.look.Getenv = func(string) string { return "" }
	r.m.o.Dir = ""
	writeBundle(t, filepath.Join(macos, "..", "Resources", "headless"), "dev", standIn)
	ensure(t, r)
	if _, err := os.Stat(filepath.Join(r.out, "electron")); err != nil {
		t.Fatalf("the desktop app's program was not run: %v", err)
	}
	env, _ := os.ReadFile(filepath.Join(r.out, "env"))
	if !strings.Contains(string(env), "ELECTRON_RUN_AS_NODE=1\n") {
		t.Errorf("ELECTRON_RUN_AS_NODE=1 is not in the process's environment")
	}
	if st := r.m.Status(); !st.Running {
		t.Errorf("Status = %+v", st)
	}
}

// Start, kill and idle stop again and again, as the server does over days. Rounds thinned in the default set.
func TestRestartLoop(t *testing.T) {
	t.Parallel()
	rounds := 3
	if testset.Full() {
		rounds = 25
	}
	r := newRig(t, Options{})
	var last string
	for i := 0; i < rounds; i++ {
		id := ensure(t, r)
		if id == last {
			t.Fatalf("round %d: the id %q is the one of the process before", i, id)
		}
		last = id
		r.m.CallTimedOut()
	}
	if got := len(r.starts()); got != rounds {
		t.Fatalf("%d processes for %d rounds", got, rounds)
	}
	for _, pid := range r.starts() {
		eventually(t, "process "+pid+" to be gone", func() bool { return !alive(pid) })
	}
}
