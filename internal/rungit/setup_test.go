package rungit

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
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
	dir := t.TempDir()
	start := time.Now()
	err := RunSetup(bg, dir, "echo $$ > pids; sleep 300", nil, 300*time.Millisecond)
	if took := time.Since(start); took > 1500*time.Millisecond {
		t.Errorf("RunSetup took %s with a timeout of 300ms", took)
	}
	var se *SetupError
	if !errors.As(err, &se) || !errors.Is(err, ErrSetupTimeout) || errors.Is(err, context.Canceled) ||
		!strings.Contains(err.Error(), "timed out after 300ms") {
		t.Errorf("RunSetup = %v, want a timeout", err)
	}
	for _, pid := range waitForPids(t, filepath.Join(dir, "pids"), 1) {
		if !gone(pid) {
			t.Errorf("process %d is still alive", pid)
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}

// A command that ignores SIGTERM gets SIGKILL after the grace, with its children.
func TestRunSetupKillsWhatIgnoresSIGTERM(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(bg)
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
