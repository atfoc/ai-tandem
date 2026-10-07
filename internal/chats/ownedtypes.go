package chats

import (
	"errors"

	"ai-whiteboard/internal/model"
)

// This file declares the types of the chat manager's API for runs: the chats a run's engine
// drives (its agents) and the chats people open on a run. The manager's methods that use them are
// CreateOnRun, ChatsOfRun, CreateOwned, SendOwned, WaitOwned, StopOwned, DeleteOwned, OwnedState,
// CostOf, Activity, Idle and TurnRunning. The events of a run agent's chat go through the bridge's
// SendChat as unlisted: only to the clients that follow the chat (editorbridge.Follow, at a read
// of its thread), which the manager asks with Followed and ends with Forget when the chat goes.

// RunOwner is what the chat manager needs to know about runs. runs.Service implements it;
// nil means the server has no runs (tests).
//
// RunOf and ChatContext are called with a chat's lock held, so they must not call the chat
// manager. The chat manager calls nothing else of runs under a chat's lock, and never holds its
// own lock (Manager.mu) across either.
type RunOwner interface {
	// RunOf returns the facts of a run that its chats depend on; ok is false when there is none.
	RunOf(id string) (RunInfo, bool)
	// ChatContext is the block put in front of every message of a person's chat on the run.
	ChatContext(id string) string
}

// RunInfo is what a run's chats depend on.
type RunInfo struct {
	Group    string // the group of the run: GroupOf of its chats
	Archived bool
	Cwd      string          // the run's folder: where a new chat on it works
	Agent    model.AgentKind // the run's agent kind
	Model    string          // what its deep tier runs on: a new chat of that kind starts on it
	Effort   string
	// Server is the server the run is on: the id of an entry of the server list, "" for this
	// computer. A chat on the run is on that server.
	Server string
	Draft  bool // the run has not started
}

var (
	// ErrRunAgent is what every call a person can make to change a chat answers for a run agent's chat.
	ErrRunAgent = errors.New("this chat is one of a run's agents: the run drives it")
	// ErrTurnOver is what SpawnSubagent answers for a run agent's chat that has no turn running.
	ErrTurnOver = errors.New("this agent's turn is over: it can no longer start a subagent")
	// ErrNothingSent: WaitOwned was asked about a chat that got no SendOwned since the server started.
	ErrNothingSent = errors.New("nothing was sent to this chat since the server started")
	// ErrSuperseded: another SendOwned came before the one a WaitOwned waited for had settled.
	ErrSuperseded = errors.New("another message was sent to the chat before it settled")
	// ErrNoRun: the run a chat is on, or is asked to be made on, does not exist.
	ErrNoRun = errors.New("no such run")
	// ErrRunArchived: that run is archived (ErrArchived is about the chat itself).
	ErrRunArchived = errors.New("the run is archived")
)

// OwnedSpec describes the chat of one run agent.
type OwnedSpec struct {
	ID     string          // chosen by the engine (runs.AgentChatID): creating twice finds the first
	Run    string          // the run's id
	Role   model.AgentRole // orchestrator, task or merge
	Name   string          // "turn-007", "T03-work", "T03-a2-merge"
	Agent  model.AgentKind
	Model  string
	Effort string
	Cwd    string // an existing folder outside the app's own
}

// OwnedSend says how SendOwned starts the agent.
type OwnedSend struct {
	Fresh bool // forget the session: end the process, take a new session id, start without resume
}

// How the last turn since a SendOwned ended (Settled.Outcome).
const (
	EndClean   = "clean"   // the turn ended with no error
	EndError   = "error"   // the turn ended with an error (Settled.Error)
	EndAborted = "aborted" // the turn was interrupted, or the chat was stopped
	EndExit    = "exit"    // the process ended in the turn
)

// Settled is the state of a run agent's chat that has nothing more coming after the last SendOwned.
type Settled struct {
	Outcome   string // EndClean, EndError, EndAborted or EndExit: how the last turn since the message ended
	Error     string
	NoSession bool   // the last turn end said the session to resume does not exist (Claude)
	Text      string // the last text item added since the message; "" when those turns wrote none
	From, To  int    // the thread's item range of the message and what followed
	Turns     int    // turn ends since the message
	// Owed: subagent results the agent did not get. The next SendOwned carries those not yet
	// tried; one whose delivery failed once is delivered by the app after that message's turn
	// ends cleanly, and WaitOwned waits for that turn too.
	Owed int
}

// OwnedState is what a restarted engine can read of a run agent's chat without starting anything.
type OwnedState struct {
	Exists     bool
	Locked     bool // it has had a message: the next SendOwned resumes its session
	WasActive  bool // a turn runs now, or chat.json says one ran when the server last stopped
	HasProcess bool
	Text       string // the last text item after the last user item ("" if none)
}

// Cost is what a chat's agent and its subagents have cost so far.
type Cost struct {
	USD     float64
	Known   bool // a cost was reported at least once (never for Cursor)
	Partial bool // something was spent that no report covers (a process killed in a turn)
	// Tokens is what the agent and its subagents used, counted as USD is.
	Tokens      model.TokenCount
	TokensKnown bool // tokens were reported at least once (never for Cursor)
	Peak        int  // the largest context a request of the chat's own agent was made with; 0 = not known
}

// Activity is the live state of a chat's thread, for the run view.
type Activity struct {
	Tools int        // tool items in the thread
	Last  model.Item // the last tool item; Kind "" when there is none
}
