// Package agent defines what the chat manager needs from an agent CLI adapter (Claude, Cursor, pi).
package agent

import (
	"encoding/json"
	"errors"

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
// its own running: Claude starts a process on a fork of the session just to answer, Cursor reads
// its session store.
type SplitReader interface {
	ReadContextSplit(o SpawnOptions) (model.ContextSplit, error)
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
	EvTurnEnd                         // Aborted, Error
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
