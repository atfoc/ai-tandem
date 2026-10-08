package rungit

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRunSetup(t *testing.T) {
	dir := t.TempDir()
	var log bytes.Buffer
	log.WriteString("earlier\n")
	must(t, RunSetup(bg, dir, "echo to stdout; echo to stderr >&2; pwd; touch made-here", &log, 0))
	if got := log.String(); !strings.HasPrefix(got, "earlier\nto stdout\nto stderr\n") || !strings.Contains(got, filepath.Base(dir)) {
		t.Errorf("the log is %q", got)
	}
	if !exists(filepath.Join(dir, "made-here")) {
		t.Errorf("the command did not run in the folder")
	}
	must(t, RunSetup(bg, dir, "  ", nil, 0)) // no command, no log

	// A log file, as the engine will pass one.
	f, err := os.OpenFile(filepath.Join(dir, "setup.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	must(t, err)
	defer f.Close()
	must(t, RunSetup(bg, dir, "echo first", f, time.Minute))
	must(t, RunSetup(bg, dir, "echo second", f, time.Minute))
	if got := read(t, dir, "setup.log"); got != "first\nsecond\n" {
		t.Errorf("the log file is %q", got)
	}

	// A non-zero exit is an error with the code; the output is in the log all the same.
	log.Reset()
	err = RunSetup(bg, dir, "echo broken; exit 3", &log, 0)
	var se *SetupError
	if !errors.As(err, &se) || se.ExitCode != 3 || se.Err != nil || !strings.Contains(err.Error(), "exit 3") {
		t.Errorf("exit 3 = %v", err)
	}
	if log.String() != "broken\n" {
		t.Errorf("the log is %q", log.String())
	}
	if err := RunSetup(bg, filepath.Join(dir, "missing"), "true", nil, 0); err == nil || errors.As(err, &se) {
		t.Errorf("a folder that is not there = %v, want a start error", err)
	}
	// The variables that point git elsewhere do not reach the command.
	t.Setenv("GIT_DIR", "/somewhere/else")
	log.Reset()
	must(t, RunSetup(bg, dir, `echo "[$GIT_DIR]"`, &log, 0))
	if log.String() != "[]\n" {
		t.Errorf("GIT_DIR reached the command: %q", log.String())
	}
}

// Bug B9 of the script: its setup command could not be interrupted. Here a cancel ends the
// command and what it started.
func TestRunSetupCancel(t *testing.T) {
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "pids")
	ctx, cancel := context.WithCancel(bg)
	defer cancel()
	done := make(chan error, 1)
	var log bytes.Buffer
	go func() {
		done <- RunSetup(ctx, dir, "echo started; sleep 300 & echo $! > pids; echo $$ >> pids; sleep 300", &log, time.Hour)
	}()
	pids := waitForPids(t, pidFile, 2)
	cancelled := time.Now()
	cancel()
	var err error
	select {
	case err = <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("RunSetup did not return after the cancel")
	}
	// As a rule the group is gone at once. A process that was being forked when the SIGTERM went
	// to the group does not get it and is ended by the SIGKILL that follows two seconds later:
	// that is RunSetup working as it says, and it happens on a busy machine.
	if took := time.Since(cancelled); took > grace+1500*time.Millisecond {
		t.Errorf("RunSetup returned %s after the cancel", took)
	}
	var se *SetupError
	if !errors.As(err, &se) || !errors.Is(err, context.Canceled) || errors.Is(err, ErrSetupTimeout) || se.ExitCode != -1 {
		t.Errorf("RunSetup = %v, want an interruption", err)
	}
	for _, pid := range pids {
		if !gone(pid) {
			t.Errorf("process %d is still alive", pid)
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	if log.String() != "started\n" {
		t.Errorf("the log is %q", log.String())
	}
	if err := RunSetup(ctx, dir, "touch ran-anyway", nil, 0); !errors.Is(err, context.Canceled) || exists(filepath.Join(dir, "ran-anyway")) {
		t.Errorf("RunSetup with a cancelled context = %v", err)
	}
}

func TestRunSetupTimeout(t *testing.T) {
	// The command has to be running when its time is up, or nothing shows that it was ended. On
	// a busy machine the shell may not have started within 300ms: such a try proves less than
	// the test is for, and it is made again with more time. What RunSetup returns, and when, is
	// checked in every try.
	timeouts := []time.Duration{300 * time.Millisecond, 1200 * time.Millisecond, 5 * time.Second, 20 * time.Second}
	for i, timeout := range timeouts {
		dir := t.TempDir()
		start := time.Now()
		err := RunSetup(bg, dir, "echo $$ > pids; sleep 300", nil, timeout)
		// As in TestRunSetupCancel: a sleep that was being forked when the SIGTERM went to the
		// group is ended by the SIGKILL that follows after the grace.
		if took := time.Since(start); took > timeout+grace+1500*time.Millisecond {
			t.Errorf("RunSetup took %s with a timeout of %s", took, timeout)
		}
		var se *SetupError
		if !errors.As(err, &se) || !errors.Is(err, ErrSetupTimeout) || errors.Is(err, context.Canceled) ||
			!strings.Contains(err.Error(), "timed out after "+timeout.String()) {
			t.Errorf("RunSetup = %v, want a timeout after %s", err, timeout)
		}
		// RunSetup is back, so the shell is ended: what it wrote, it wrote before its time was up.
		b, _ := os.ReadFile(filepath.Join(dir, "pids"))
		pid, perr := strconv.Atoi(strings.TrimSpace(string(b)))
		if perr != nil || !strings.HasSuffix(string(b), "\n") {
			if i == len(timeouts)-1 {
				t.Fatalf("the command had not written its process id after %s: %q", timeout, b)
			}
			t.Logf("the command had not started within %s (pids: %q): once more with %s", timeout, b, timeouts[i+1])
			continue
		}
		if !gone(pid) {
			t.Errorf("process %d is still alive", pid)
			syscall.Kill(pid, syscall.SIGKILL)
		}
		return
	}
}

// A command that ignores SIGTERM gets SIGKILL after the grace, with its children.
func TestRunSetupKillsWhatIgnoresSIGTERM(t *testing.T) {
	dir := t.TempDir()
	// A shorter grace than the package's, so that the test does not wait two seconds.
	const grace = 400 * time.Millisecond
	ctx, cancel := context.WithCancel(withWaits(bg, waits{grace: grace}))
	defer cancel()
	done := make(chan error, 1)
	go func() {
		// The trap is inherited by the sleeps, which ignore SIGTERM too.
		done <- RunSetup(ctx, dir, "trap '' TERM; sleep 300 & echo $! > pids; echo $$ >> pids; while :; do sleep 1; done", nil, 0)
	}()
	pids := waitForPids(t, filepath.Join(dir, "pids"), 2)
	cancelled := time.Now()
	cancel()
	var err error
	select {
	case err = <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("RunSetup did not return after the cancel")
	}
	if took := time.Since(cancelled); took < grace || took > grace+2*time.Second {
		t.Errorf("RunSetup returned %s after the cancel, want just over the grace of %s", took, grace)
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("RunSetup = %v, want an interruption", err)
	}
	for _, pid := range pids {
		if !gone(pid) {
			t.Errorf("process %d is still alive", pid)
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}
