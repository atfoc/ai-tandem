package aliases

import (
	"context"
	"os/exec"
	"time"

	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

// Store keeps the accounts' records in <data>/aliases.json (File), mode 0600, written whole
// through a temp file and a rename. Its methods may be called from any goroutine; what they
// return is a copy.
type Store interface {
	List() []Alias // in the order they were added
	Get(id string) (Alias, bool)
	// Put adds a, or replaces the record with its ID, and returns once the file is written.
	Put(a Alias) error
	// Delete removes the record id from the file; no such record is no error.
	Delete(id string) error
}

// Containers is what the accounts need of Docker: *container.Manager has it. Tests of this
// package may give a fake of their own.
type Containers interface {
	Available() error
	Refresh(ctx context.Context) error
	Watch(every time.Duration, stop <-chan struct{}, changed func(error))
	Inspect(ctx context.Context, alias string) (container.Info, error)
	// EnsureImage makes image there (the default built, another pulled), waiting no longer than
	// ctx; the build or pull goes on when ctx ends first.
	EnsureImage(ctx context.Context, image string) error
	Ensure(ctx context.Context, spec container.Spec) (container.Info, bool, error)
	Recreate(ctx context.Context, spec container.Spec) (container.Info, error)
	Stop(ctx context.Context, alias string) error
	Remove(ctx context.Context, alias string) error
	Exec(alias string, o container.ExecOptions) *exec.Cmd
	KillRun(ctx context.Context, alias, runID string) error
	Building(image string) bool
}

var _ Containers = (*container.Manager)(nil)

// Work is what the accounts need of the chat manager: who works in an account's container, and
// stopping them before the container is recreated or stopped. *chats.Manager itself does not
// have it (its Busy is a chat's); its view (*chats.Manager).AccountWork() does
// (internal/chats/work.go).
type Work interface {
	// Busy is the number of chat objects (chats, branches, subagents) of kind a whose agent is
	// working now: a turn running, or background work it waits on. An idle live process does not
	// count: it is ended without a question.
	Busy(a model.AgentKind) int
	// StopKind ends every live process of kind a as Stop does (their chats can be continued
	// later, a subagent is stopped as by stop_subagent), and returns once they have ended.
	StopKind(a model.AgentKind)
}
