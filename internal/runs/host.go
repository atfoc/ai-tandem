package runs

import (
	"context"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/usable"
)

// ChatHost is what runs need from the chat manager: chats.Manager implements it (the …Owned
// methods and the others of its API for runs, and four it has had all along). A run's agents are
// chat objects it drives through this interface; the tests of this package use a fake.
//
// Lock rule: no method of ChatHost is called with a run's lock (run.mu) held. The chat manager
// calls back into the service (chats.RunOwner) with a chat's lock held, so the other order would
// deadlock.
type ChatHost interface {
	// CreateOnRun makes a person's chat on a run: no group, no board, no role; folder = the run's
	// folder; model and effort of the run's deep tier for a chat of the run's agent kind, else from
	// defaults.Resolve with the run's group. The run must exist
	// (chats.ErrNoRun) and not be archived (chats.ErrRunArchived). It lives in
	// runs/<run>/chats/<id> and is listed like any chat.
	CreateOnRun(a model.AgentKind, run string) (model.ChatView, error)
	// ChatsOfRun lists the top-level chats of a run: the ones people talk to, and its agents.
	ChatsOfRun(run string) (people, agents []model.ChatMeta)

	// CreateOwned makes the chat object of a run agent in runs/<run>/agents/<id>, or finds it: a
	// chat with this id, run and role is returned as it is (created false); the same id with
	// another run or role is an error. Nothing of a person's chat happens to it: no group, no
	// namer, no sticky defaults, not in Views. No process starts.
	CreateOwned(s chats.OwnedSpec) (created bool, err error)
	// SendOwned sends one message of the engine to a run agent's chat and returns when the
	// adapter has taken it. It starts the process when there is none: a resume when the chat has
	// had a message (with NeedHistory), else a new session. chats.ErrBusy while a turn runs. An
	// error for which errors.Is(err, agent.ErrNoSession) holds means the session to resume does
	// not exist. chats.ErrShutdown once the chat manager has begun to shut down: nothing starts.
	SendOwned(id, text string, o chats.OwnedSend) error
	// WaitOwned blocks until the chat is settled: a turn has ended since the last SendOwned, the
	// chat is not busy, no app-spawned subagent of it runs, and no result is owed that the app
	// would still deliver by itself. The answer is computed from the chat as it is at that
	// moment, so a chat that became busy again (a turn the agent started itself, a delivery) is
	// not settled until that turn has ended too. chats.ErrNothingSent, chats.ErrSuperseded,
	// chats.ErrNotFound, or ctx's error.
	WaitOwned(ctx context.Context, id string) (chats.Settled, error)
	// StopOwned ends a run agent's process: it interrupts a running turn, waits up to grace for
	// the turn to end (so its cost is reported and Claude ends its background commands), then
	// closes the process, stops its subagents and revokes their tokens. The chat and its thread
	// stay.
	StopOwned(id string, grace time.Duration)
	// DeleteOwned stops and removes a run agent's chat and its folder. No event is sent.
	DeleteOwned(id string) error
	// OwnedState is what a restarted engine can read of a run agent's chat without starting
	// anything.
	OwnedState(id string) (chats.OwnedState, error)
	// CostOf is what a chat's agent and its subagents have cost so far.
	CostOf(id string) (chats.Cost, error)
	// Activity is the live state of a chat's thread, for the run view.
	Activity(id string) (chats.Activity, error)
	// Idle reports whether the chat (its current branch) is settled now: not busy, no running
	// subagent, nothing the app would still deliver. A chat that does not exist is idle.
	Idle(id string) bool
	// TurnRunning reports whether the chat has a process and a turn of it is running.
	TurnRunning(id string) bool

	// The chat manager's methods as they are today.

	// ItemsOf returns a branch's thread ("" = the current one): get_agent reads an agent's steps
	// from it.
	ItemsOf(id, branch string) (served string, version int, items []model.Item, subs []model.Subagent, err error)
	// Delete stops and removes a person's chat with its history and sends chat_removed.
	Delete(id string) error
	// SetArchive sets a person's chat's archive state.
	SetArchive(id string, a model.Archive) error
	// Stop ends the agent of a person's chat.
	Stop(id string)
}

// Clock is the time the service and the engine run on: timestamps, backoff, timeouts, the ticker
// and the coalescing timer. Tests give one they move by hand (agenttest.Clock).
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

// RealClock is the wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time                         { return time.Now() }
func (RealClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// Emitter sends an event to the clients; editorbridge.Bridge is one. SendRun sends an event of
// the run with this id to the clients it concerns: the list events to every client that lists the
// run, the content events to those that follow it. Neither is called with a run's lock held.
type Emitter interface {
	Broadcast(ev any)
	SendRun(run string, ev any)
}

// Deps is what a Service is made of.
type Deps struct {
	Store      *store.Store
	Emit       Emitter
	DefaultCwd string
	Clock      Clock                      // nil = RealClock
	Bins       map[model.AgentKind]string // the agents' programs, as the adapters start them: a missing one blocks a run
	// Agents is the look-up of the agents this server can use: a draft run takes and accepts only
	// those. nil = every kind is usable.
	Agents *usable.Set
	// GitEnv is added to the environment of every git command the service and the engine run
	// ("KEY=value"). The server leaves it empty; tests give agenttest.Repo.Env().
	GitEnv []string
	// HaltWait is how long an archive and a delete wait for a run's workers to let go. 0 = 30 s;
	// the server leaves it so, tests shorten it.
	HaltWait time.Duration
	// Mark tells whoever routes the events the client mark of a run; "" removes it. nil = nobody.
	// It is called with no run's lock held, and before the run's first event: when the runs are
	// loaded, and by a start call before the run's first `run` event (entry 1's `run_detail`, which
	// goes to followers and not by the mark, is sent before it). Nothing calls it with "": a mark
	// is dropped by whoever keeps it, after the run's `run_removed`.
	Mark func(run, client string)
}

// nowMs is the clock's time in unix milliseconds, the unit of every recorded time.
func (d Deps) nowMs() int64 {
	if d.Clock == nil {
		return time.Now().UnixMilli()
	}
	return d.Clock.Now().UnixMilli()
}

// openRepo opens the git repository dir is in, with the service's git environment: the one way
// the service and the engine get a rungit.Repo. rungit.ErrNotRepo: the folder is not inside a
// work tree (the run works without git); rungit.ErrNoCommits: nothing is committed yet.
func (d Deps) openRepo(ctx context.Context, dir string) (*rungit.Repo, error) {
	return rungit.Open(ctx, dir, rungit.WithEnv(d.GitEnv...))
}
