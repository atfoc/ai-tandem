package agenttest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"ai-whiteboard/internal/agent"
)

// HostRunner is an agent.Runner that runs argv straight on this machine, in place of a
// container, for tests of an adapter that runs through a Runner: it records every Command and
// every Kill. argv[0] is run as given, so a test gives the spawner the stand-in's path as its Bin.
// Kill ends the process group of the run's command (the caller starts it with agent.StartGroup,
// as it does every agent process) and counts.
type HostRunner struct {
	// Err, when set, is what Command answers instead of a process (Docker not running).
	Err error

	mu    sync.Mutex
	calls []HostCall
}

// HostCall is one Command: where, with what added to the environment, and what.
type HostCall struct {
	Dir   string
	Env   []string
	Argv  []string
	ID    string // the run's ID, also in the process's environment as AIWB_RUN
	run   *agent.Run
	kills int
}

// Command implements agent.Runner.
func (h *HostRunner) Command(ctx context.Context, dir string, env []string, argv []string) (*agent.Run, error) {
	if h.Err != nil {
		return nil, h.Err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	b := make([]byte, 6)
	rand.Read(b)
	id := "r_" + hex.EncodeToString(b)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(append(os.Environ(), env...), "AIWB_RUN="+id)
	run := &agent.Run{Cmd: cmd, ID: id}
	h.mu.Lock()
	i := len(h.calls)
	h.calls = append(h.calls, HostCall{Dir: dir, Env: append([]string(nil), env...), Argv: append([]string(nil), argv...), ID: id, run: run})
	h.mu.Unlock()
	run.Kill = func() error {
		h.mu.Lock()
		h.calls[i].kills++
		h.mu.Unlock()
		if cmd.Process == nil {
			return nil
		}
		if err := agent.KillGroup(cmd.Process.Pid, syscall.SIGKILL); err != nil {
			cmd.Process.Kill()
		}
		return nil
	}
	return run, nil
}

// Calls are the Commands so far, in order.
func (h *HostRunner) Calls() []HostCall {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]HostCall(nil), h.calls...)
}

// Kills is how many times the Kill of the i-th Command was called.
func (h *HostRunner) Kills(i int) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.calls[i].kills
}
