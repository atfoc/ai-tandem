package rungit

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// ErrSetupTimeout: the setup command ran longer than it was allowed to.
var ErrSetupTimeout = errors.New("timed out")

// SetupError is a setup command that did not end with exit code 0.
type SetupError struct {
	ExitCode int   // its exit code; -1 when it did not exit by itself
	Err      error // ErrSetupTimeout, the context's error when it was interrupted, else nil
}

func (e *SetupError) Error() string {
	switch {
	case errors.Is(e.Err, ErrSetupTimeout):
		return "the setup command " + e.Err.Error()
	case e.Err != nil:
		return "the setup command was interrupted: " + e.Err.Error()
	case e.ExitCode < 0:
		return "the setup command was ended by a signal"
	}
	return fmt.Sprintf("the setup command failed (exit %d)", e.ExitCode)
}

func (e *SetupError) Unwrap() error { return e.Err }

// RunSetup runs the shell command of a new work tree (sh -c, in dir, with the server's
// environment), appending its stdout and stderr to log. An empty command does nothing.
//
// The command runs as the leader of a process group of its own. When ctx is cancelled, or timeout
// passes (0 means none), the whole group gets SIGTERM, then SIGKILL two seconds later if something
// is left, and RunSetup returns once it is gone. Any failure is a *SetupError: a non-zero exit
// (ExitCode), the timeout (errors.Is ErrSetupTimeout), an interruption (errors.Is the context's
// error, context.Canceled as a rule). A command that could not be started is a plain error.
//
// What the command leaves running in the background when it exits by itself is left alone, as the
// script did; its output is logged for two more seconds at most when log is not an *os.File.
func RunSetup(ctx context.Context, dir, command string, log io.Writer, timeout time.Duration) error {
	if strings.TrimSpace(command) == "" {
		return nil
	}
	if log == nil {
		log = io.Discard
	}
	limited := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		limited, cancel = context.WithTimeoutCause(ctx, timeout, fmt.Errorf("%w after %s", ErrSetupTimeout, timeout))
		defer cancel()
	}
	cmd := exec.Command("/bin/sh", "-c", command)
	cmd.Dir = dir
	cmd.Env = baseEnv()
	cmd.Stdout, cmd.Stderr = log, log
	err := runGroup(limited, cmd, 0)
	var xe *exec.ExitError
	switch {
	case err == nil:
		return nil
	case ctx.Err() != nil:
		return &SetupError{ExitCode: -1, Err: ctx.Err()}
	case limited.Err() != nil:
		return &SetupError{ExitCode: -1, Err: context.Cause(limited)}
	case errors.As(err, &xe):
		return &SetupError{ExitCode: xe.ExitCode()}
	}
	return fmt.Errorf("start the setup command in %s: %w", dir, err)
}
