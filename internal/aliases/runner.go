package aliases

import (
	"context"
	"errors"
	"slices"
	"sync"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/container"
)

// accountRunner is the agent.Runner of one account: every claude process of the account runs in
// its container, through `docker exec`, with the account's own CLAUDE_CONFIG_DIR and HOME.
type accountRunner struct {
	s  *Service
	id string
	// own: the runner of the service's own Claude runs (auth status, login, logout), which are
	// not refused while the account restarts (claudeOf).
	own bool
	// mode is how far it goes to make the container run: ensureQuick for a chat's process (its
	// chat's lock is held), ensureFull for a login or a logout, ensureRunning for what only reads
	// in a running container (auth status, the catalog probe, the usage).
	mode ensureMode
}

var _ agent.Runner = (*accountRunner)(nil)

// Command makes the account's container run (as its mode allows; under the account's op lock)
// and returns the `docker exec` of argv in dir, not started. dir "" is the account's folder. A
// removed account is ErrRemoved; after the service's Shutdown, errShuttingDown; Docker's reason
// and a create failure are returned as they are; a chat's run whose container is not ready
// within Waits.Run is ErrPreparing; a read-only run on a container that does not run is
// ErrStopped. A folder the running container does not have is a *MountError (the chat manager
// checks first: this is the safety net of D8). While the account restarts (Restart, Edit, Stop)
// it is ErrRestarting, looked at before the ensure and again after it, which may have waited for
// the recreate (Check refuses first: this is the safety net). No lock is held once it returns.
//
// The run is kept, to be killed at the account's removal or the service's Shutdown, until its
// Kill or its Release is called.
func (r *accountRunner) Command(ctx context.Context, dir string, env []string, argv []string) (*agent.Run, error) {
	s := r.s
	if s.isClosed() {
		return nil, errShuttingDown
	}
	if _, ok := s.store.Get(r.id); !ok {
		return nil, ErrRemoved
	}
	if !r.own && s.restarting(r.id) {
		return nil, ErrRestarting
	}
	if dir == "" {
		dir = Dir(s.root, r.id)
	}
	info, err := s.ensure(ctx, r.id, r.mode)
	if errors.Is(err, ErrNotFound) {
		return nil, ErrRemoved
	}
	if err != nil {
		return nil, err
	}
	if !r.own && s.restarting(r.id) {
		return nil, ErrRestarting
	}
	a, ok := s.store.Get(r.id)
	if !ok {
		return nil, ErrRemoved
	}
	if info.Spec != a.Spec(s.root).Hash() && !Under([]string{Dir(s.root, r.id)}, dir) &&
		(a.Applied == nil || !Under(a.Applied.Mounts, dir)) {
		return nil, &MountError{Account: a.Name, Folder: dir, Pending: Under(a.Mounts, dir)}
	}

	runID := container.NewRunID()
	// The adapter's vars first, ours after: a later -e wins, so the adapter cannot undo the
	// account's isolation (D12).
	full := append(slices.Clone(env),
		"CLAUDE_CONFIG_DIR="+ClaudeDir(s.root, r.id),
		"HOME="+HomeDir(s.root, r.id),
		"CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
		"DISABLE_AUTOUPDATER=1",
		"AIWB_RUN="+runID,
	)
	cmd := s.cont.Exec(r.id, container.ExecOptions{Dir: dir, Env: full, RunID: runID, Argv: slices.Clone(argv)})

	id := r.id
	var key uint64 // set below, before kill or release can be called
	var once sync.Once
	forget := func() { once.Do(func() { s.unregister(id, key) }) }
	kill := func() error {
		forget()
		ctx, cancel := context.WithTimeout(context.Background(), container.QuickTimeout)
		defer cancel()
		return s.cont.KillRun(ctx, id, runID)
	}
	// Registered in the hold of mu that Shutdown takes to collect the runs: a run made after
	// Shutdown has collected them is refused, never left behind.
	key, ok = s.register(id, &run{id: runID, kill: kill})
	if !ok {
		return nil, errShuttingDown
	}
	return &agent.Run{Cmd: cmd, ID: runID, Kill: kill, Release: forget}, nil
}

// isClosed reports whether Shutdown was called.
func (s *Service) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// register records a live run of account id and returns its key; false (nothing recorded) once
// Shutdown was called.
func (s *Service) register(id string, rn *run) (uint64, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, false
	}
	s.runSeq++
	s.rtLocked(id).runs[s.runSeq] = rn
	return s.runSeq, true
}

// unregister forgets the run key of account id.
func (s *Service) unregister(id string, key uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r := s.rt[id]; r != nil {
		delete(r.runs, key)
	}
}
