// Package agent defines what the chat manager needs from an agent CLI adapter (Claude, Cursor).
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
	Model     string // Claude alias or Cursor base id
	Effort    string
	Board     *BoardAccess // nil for plain chats
}

type BoardAccess struct {
	MCPURL     string // Claude: http://127.0.0.1:<port>/mcp/<token>
	CommandURL string // Cursor: http://127.0.0.1:<port>/agent/<token>
	Token      string
}

type Spawner interface {
	// Spawn starts the process and returns at once; a handshake may continue in the background.
	Spawn(o SpawnOptions) (Agent, error)
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
	EvCatalog                         // Cursor reported its models (Catalog)
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
}
