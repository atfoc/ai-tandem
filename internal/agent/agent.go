// Package agent defines what the chat manager needs from an agent CLI adapter (Claude, Cursor, pi).
package agent

import (
	"encoding/json"
	"errors"
	"time"

	"ai-whiteboard/internal/model"
)

// ErrFolderMissing is returned by Spawn when the chat's working folder does not exist.
// The chat manager re-exports it as chats.ErrFolderMissing.
var ErrFolderMissing = errors.New("folder not found")

type SpawnOptions struct {
	ChatID    string
	SessionID string // Claude: the id to create or resume; Cursor: the id to load ("" = new session)
	Resume    bool
	Cwd       string
	Model     string // the model id from the agent's catalog (Claude: the id passed to --model)
	Effort    string
	MCP       *BoardAccess // URL+token; set whenever the process should speak MCP (plain chats included)
	BoardID   string       // non-empty → board extras on (whiteboard prompt, board-tool allow/auto-approve)
	Subagent  bool         // app-spawned child: Claude --allowedTools omits the spawn family
	Point     string       // Claude's ReadContextSplit only: the fork-point id the session is read up to ("" = all of it)
}

type BoardAccess struct {
	MCPURL string // the fixed MCP endpoint, http://localhost:6006/mcp (Claude, Cursor and pi)
	Token  string // the MCP credential, never a URL segment
}

type Spawner interface {
	// Spawn starts the process and returns at once; a handshake may continue in the background.
	Spawn(o SpawnOptions) (Agent, error)
}

// SplitReader is a Spawner that can report a started chat's context split with no process of
// its own running: Claude starts a process on a fork of the session just to answer (up to
// o.Point when it is set), Cursor reads its session store.
type SplitReader interface {
	ReadContextSplit(o SpawnOptions) (model.ContextSplit, error)
}

// ForkTimeout bounds a fork start (SpawnFork) for every provider.
const ForkTimeout = 60 * time.Second

// ForkSource names the session a new process is forked from, and where.
type ForkSource struct {
	ChatID    string // server id of the chat or branch whose session is forked
	SessionID string // the session to fork
	Point     string // the id on the end mark at the fork point; "" = none recorded
	Next      string // the id on the first end mark after the fork point; "" = none
	// End: the fork point is the end of the source session; known only when the fork is first
	// made. The source may take a message after the end was found, so Claude and pi still stop
	// the fork at Point when one is recorded.
	End bool
}

// Forker is a Spawner that can start a chat's process on a fork of another session. Found by
// type assertion on the Spawner, like SplitReader.
type Forker interface {
	// SpawnFork starts the process of o on a fork of src and returns only when the provider has
	// confirmed the fork, or with an error. It waits for the confirmation no longer than
	// ForkTimeout. sessionID is the forked session's id (the app's choice in o.SessionID for
	// Claude; chosen by the adapter or the provider for Cursor and pi).
	//
	// When it returns an error the process has been closed, and whatever the start created
	// outside the app's folder has been removed. Whether the process has exited by then differs:
	// Claude does not wait for it (it is killed if it is still there 3 s after the close). Cursor
	// waits only while ForkTimeout lasts, so not at all after a time-out: the process may live a
	// few seconds longer, and its store copy is removed again once it has ended. pi returns only
	// when its process has exited, which after a time-out takes up to its two close grace
	// periods on top of ForkTimeout.
	SpawnFork(o SpawnOptions, src ForkSource) (ag Agent, sessionID string, err error)
	// DiscardFork removes what a successful SpawnFork created outside the app's folder for a fork
	// that is given up after its process was closed (Cursor: the store copy; Claude, pi: nothing).
	DiscardFork(sessionID string)
}

// ContextSplitter is an Agent that can report its context split while it runs (Claude).
type ContextSplitter interface {
	ContextSplit() (model.ContextSplit, error)
}

type ContentBlock struct{ Text string }

type Agent interface {
	Events() <-chan Event             // closed after EvExit
	Send(blocks []ContentBlock) error // one user turn; waits for the handshake if needed
	Interrupt() error
	Decide(requestID string, allow bool) error
	Close() // ends the process (graceful, then kill after 3 s)
}

type EventKind int

const (
	EvSession        EventKind = iota // SessionID known (Cursor after session/new)
	EvCatalog                         // the agent reported its models (Catalog)
	EvThinking                        // model is thinking / request started
	EvTextStart                       // a new text item begins (MsgID)
	EvTextDelta                       // Text appended to the open text item
	EvText                            // a whole text block that was not streamed (MsgID, Text)
	EvToolStart                       // ToolID, ToolName, Input (may be null)
	EvToolInputDelta                  // ToolID, Text = partial JSON
	EvToolInput                       // ToolID, ToolName, Input (final)
	EvToolResult                      // ToolID, Result, IsError
	EvToolDenied                      // ToolID
	EvPermRequest                     // PermID, ToolName, ToolID, Input
	EvUsage                           // CtxIn/CtxOut/CtxWindow (any may be 0 = unchanged), or CtxError
	EvTurnEnd                         // Aborted, Error, Point
	EvExit                            // ExitErr
	EvSub                             // SubInfo: a subagent appeared or changed (a patch; zero fields are unchanged)
)

type Event struct {
	Kind                     EventKind
	SessionID                string
	Catalog                  *model.Catalog
	MsgID                    string
	Text                     string
	ToolID                   string
	ToolName                 string
	Input                    json.RawMessage
	Result                   string
	IsError                  bool
	PermID                   string
	CtxIn, CtxOut, CtxWindow int
	CtxError                 string // EvUsage: context usage could not be read (the numbers are then all 0)
	Aborted                  bool
	Error                    string
	Point                    string // EvTurnEnd: the provider's fork-point id for the end of this turn; "" = none
	ExitErr                  string
	// Sub is the parent's tool call id (Claude's Agent tool_use, Cursor's Task tool_call) of the
	// subagent this event belongs to. EvText*, EvTool*, EvThinking and EvSub with Sub set belong to
	// that subagent's own thread; EvPermRequest with Sub set was asked by it and stays in the
	// parent's thread.
	Sub     string
	SubInfo *SubInfo // EvSub
}

// SubInfo is a patch of a subagent's state. Empty strings, zero numbers and a nil Background leave
// a field unchanged. A Status is applied only while the subagent is running.
type SubInfo struct {
	ID          string
	Type        string
	Description string
	Prompt      string
	Model       string
	Background  *bool
	Status      model.SubStatus
	Error       string
	Summary     string
	Progress    string
	Tokens      int
	Window      int
	ToolUses    int
}
