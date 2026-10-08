package claude

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// probeKillGrace is how long the probe's process may take to exit after its stdin is closed.
// A variable so that a test can tell a process that ended on its own from one that was killed.
var probeKillGrace = 3 * time.Second

// probeReapGrace is how long the probe waits for a killed process to be reaped; a descendant that
// escaped the process group and holds the pipes open is not waited for beyond it. A variable so
// that a test that waits it out can shorten it.
var probeReapGrace = 500 * time.Millisecond

// ProbeArgs are the arguments of the throwaway process that reads the model list: the stream-JSON
// flags and the two throwaway flags, with no model and no session.
func ProbeArgs() []string {
	return []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--no-session-persistence", "--strict-mcp-config"}
}

// Catalog asks a short-lived `claude` for its model list (the boot refresh). It first runs
// `claude auth status` and gives up if the CLI is signed out (non-zero exit), then starts a
// process in the temp folder whose only stdin line is the `initialize` request, maps the answer
// with CatalogFromInitialize, closes stdin and waits for the exit, killing it after a short
// grace. It sends no prompt. timeout covers the whole call.
func (s *Spawner) Catalog(timeout time.Duration) (*model.Catalog, error) {
	bin := s.Bin
	if bin == "" {
		bin = "claude"
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := signedIn(ctx, bin, timeout); err != nil {
		return nil, err
	}

	cmd := exec.Command(bin, ProbeArgs()...)
	cmd.Dir = os.TempDir()
	cmd.Env = append(os.Environ(), "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1")
	stderr := &bytes.Buffer{}
	cmd.Stderr = &cappedWriter{buf: stderr, max: stderrCap}
	cmd.WaitDelay = probeReapGrace
	stdin, err1 := cmd.StdinPipe()
	stdout, err2 := cmd.StdoutPipe()
	if err := errors.Join(err1, err2); err != nil {
		return nil, err
	}
	if err := agent.StartGroup(cmd); err != nil {
		return nil, fmt.Errorf("cannot start Claude (%s): %w", bin, err)
	}

	id := "probe_" + randHex(4)
	answer := make(chan []byte, 1)
	waited := make(chan struct{})
	go func() { // the one reader of stdout, and the one waiter: Wait only after the reads are done
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
		for sc.Scan() {
			var m struct {
				Type     string `json:"type"`
				Response struct {
					RequestID string `json:"request_id"`
				} `json:"response"`
			}
			if json.Unmarshal(sc.Bytes(), &m) == nil && m.Type == "control_response" && m.Response.RequestID == id {
				select {
				case answer <- append([]byte(nil), sc.Bytes()...):
				default:
				}
			}
		}
		cmd.Wait()
		agent.Exited(cmd)
		close(waited)
	}()
	// A write error is not reported here: the process exiting says why.
	b, _ := json.Marshal(map[string]any{"type": "control_request", "request_id": id,
		"request": map[string]any{"subtype": "initialize"}})
	stdin.Write(append(b, '\n'))

	var line []byte
	var err error
	select {
	case line = <-answer:
	case <-waited:
		select { // an answer that came with the exit still counts
		case line = <-answer:
		default:
			err = exitError(cmd, stderr)
		}
	case <-ctx.Done():
		err = fmt.Errorf("Claude did not report its models within %s", timeout)
	}
	if line != nil {
		stdin.Close()
		select {
		case <-waited:
		case <-time.After(probeKillGrace):
			reap(cmd, stdout, waited)
		}
		return CatalogFromInitialize(line)
	}
	stdin.Close()
	reap(cmd, stdout, waited)
	return nil, err
}

// reap kills cmd's whole process group and waits for the reader goroutine, which ends when the
// pipes close; it gives up after probeReapGrace, closing stdout to release the reader. The group
// is then forgotten, which the reader's own call may have been too early for (a descendant was
// still alive when the process was waited for).
func reap(cmd *exec.Cmd, stdout io.Closer, waited <-chan struct{}) {
	defer forgetGroup(cmd)
	killGroup(cmd)
	select {
	case <-waited:
		return
	case <-time.After(probeReapGrace):
	}
	stdout.Close()
	select {
	case <-waited:
	case <-time.After(probeReapGrace):
	}
}

// forgetGroup calls agent.Exited for cmd's group once the kill has taken effect (the killed
// processes are gone when the group no longer answers a signal), waiting at most a moment for it.
func forgetGroup(cmd *exec.Cmd) {
	for deadline := time.Now().Add(200 * time.Millisecond); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if errors.Is(syscall.Kill(-cmd.Process.Pid, 0), syscall.ESRCH) {
			break
		}
	}
	agent.Exited(cmd)
}

// killGroup kills the process group cmd leads (started by agent.StartGroup), else just cmd.
func killGroup(cmd *exec.Cmd) {
	if syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) != nil {
		cmd.Process.Kill()
	}
}

// signedIn runs the CLI's sign-in status command, which exits non-zero when signed out. It runs in
// a registered group, so stopping the server ends it, and ctx ends it with its descendants.
func signedIn(ctx context.Context, bin string, timeout time.Duration) error {
	cmd := exec.Command(bin, "auth", "status")
	cmd.Dir = os.TempDir()
	cmd.Env = os.Environ()
	var stderr bytes.Buffer
	cmd.Stderr = &cappedWriter{buf: &stderr, max: stderrCap}
	cmd.WaitDelay = probeReapGrace
	if err := agent.StartGroup(cmd); err != nil {
		return fmt.Errorf("cannot start Claude (%s): %w", bin, err)
	}
	done := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) // nothing of the check is left behind
		forgetGroup(cmd)
		done <- err
	}()
	var err error
	select {
	case err = <-done:
	case <-ctx.Done():
		killGroup(cmd)
		select {
		case <-done:
		case <-time.After(2 * probeReapGrace):
		}
		return fmt.Errorf("claude auth status: no answer within %s", timeout)
	}
	if err == nil || errors.Is(err, exec.ErrWaitDelay) && cmd.ProcessState.Success() {
		return nil // a descendant still holding stderr does not make a success a failure
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if msg := firstLine(stderr.String()); msg != "" {
			return fmt.Errorf("claude auth status: %s (%v)", msg, err)
		}
		return fmt.Errorf("claude auth status: %w", err)
	}
	return fmt.Errorf("claude auth status: %w", err)
}

// exitError describes a probe process that ended without answering: its exit status and the first
// line of its stderr.
func exitError(cmd *exec.Cmd, stderr *bytes.Buffer) error {
	status := "ended"
	if cmd.ProcessState != nil {
		status = cmd.ProcessState.String()
	}
	if msg := firstLine(stderr.String()); msg != "" {
		return fmt.Errorf("claude %s without its model list: %s", status, msg)
	}
	return fmt.Errorf("claude %s without its model list", status)
}
