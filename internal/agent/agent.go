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
	Subagent  bool         // app-spawned child (a subagent of ChatID's chat)
	// NoSpawn: the process has no spawn family (spawn_subagent, stop_subagent,
	// list_subagent_models): the agent of a chat whose subagents are off, or a subagent at the
	// chat's deepest level. The adapters leave the family out of what the process may call unasked
	// and of what it is told. The MCP endpoint decides, per token, what is listed and what runs.
	NoSpawn bool
	Point   string // Claude's ReadContextSplit only: the fork-point id the session is read up to ("" = all of it)

	// Dir is the folder of the chat object ChatID names; "" = <AppRoot>/chats/<ChatID>.
	// (pi keeps its session files in <Dir>/pi and passes Dir as AIWB_CHAT_DIR.)
	Dir string
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
	Dir       string // that chat object's folder; "" = <AppRoot>/chats/<ChatID>
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

// ContentBlock is one part of a user turn: a text, or with Image set an image the user attached
// (Text is then not looked at). Each adapter hands an image on in the way that reaches its model.
type ContentBlock struct {
	Text  string
	Image *Image
}

// Image is an attached image as an agent gets it, for the one Send only.
type Image struct {
	Name string // as the user sees it; only for a text that names the image
	Type string // one of model.ImageTypes
	Data []byte
}

type Agent interface {
	Events() <-chan Event             // closed after EvExit
	Send(blocks []ContentBlock) error // one user turn; waits for the handshake if needed
	Interrupt() error
	Decide(requestID string, allow bool) error
	// Close ends the process: its input is closed, and what has not exited by itself after a grace
	// period is signalled. Claude's Close ends what the process started too: the groups of its
	// detached shells get SIGTERM at once, its own group is killed after 3 s, and once the process
	// has exited, by Close or by itself, what is left of its tree gets SIGTERM and SIGKILL 2 s
	// later (EndTree); Close does not wait for any of that. pi's group
	// gets SIGTERM after 3 s and SIGKILL 3 s later; Close does not wait either. Cursor's group gets
	// SIGTERM after 0.3 s and SIGKILL 3 s later, and Close returns only when the process has ended
	// (within about 7 s).
	// A Send that has not returned when Close is called returns an error.
	Close()
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
	EvTurnEnd                         // Aborted, Error, Point, and the cost fields below
	EvExit                            // ExitErr
	EvSub                             // SubInfo: a subagent appeared or changed (a patch; zero fields are unchanged)
	EvBackground                      // Background: the agent's background work changed (Claude only)
)

// Background is what an adapter knows of the background work of its process: commands the agent
// started that run on after the turn that started them (Claude: a Bash command run in the
// background, a Monitor). Only Claude reports it; for Cursor and pi it is always the zero value.
type Background struct {
	Running int  // background tasks the process reports live (Claude: background_tasks_changed, ambient ones and native subagents left out)
	Unread  bool // a background task ended after the process's last request to the model: a turn that reads its notice may be to come
}

// Temporary is the class of an error that can pass, as the agent's CLI reports it on a failed turn
// (goal 1.1). "" is an error that is not temporary, or one the adapter cannot tell.
type Temporary string

const (
	TempLogin      Temporary = "login"        // the login failed (Claude authentication_failed, cloud_credential_error)
	TempRate       Temporary = "rate_limit"   // rate or usage limited (Claude rate_limit)
	TempOverloaded Temporary = "overloaded"   // the provider is overloaded (Claude overloaded)
	TempServer     Temporary = "server_error" // the provider or the connection failed (Claude server_error)
	TempRetried    Temporary = "retried"      // no class, but the CLI retried it itself before it gave up (Claude api_retry, pi auto_retry_end)
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
	// Temporary, EvTurnEnd with Error: the error can pass (see Temporary); "" = not temporary, or
	// not known. Never set with Aborted.
	Temporary Temporary
	Point     string // EvTurnEnd: the provider's fork-point id for the end of this turn; "" = none
	// SelfBegun, EvTurnEnd: the agent began this turn itself, not with a message it was sent
	// (Claude, when a background command or task of its own ended). A message sent meanwhile is
	// not known to have been read in it. Only Claude reports it; pi and Cursor begin no turn
	// themselves.
	SelfBegun bool
	// Background, EvTurnEnd: the background work at the end of the turn; EvBackground: its new
	// state. Zero for Cursor and pi.
	Background Background
	// EvTurnEnd only, as far as the provider reports them: Claude from its result line, pi from
	// get_session_stats, Cursor nothing. The numbers are raw: nothing is summed or subtracted here.
	//
	// CostUSD: dollars. Claude: total_cost_usd, cumulative for this process; a resumed process
	// starts from what an earlier process of the session had reached when it exited in an orderly
	// way, and from 0 when that one was killed. pi: the cost of the whole session so far, across
	// processes.
	CostUSD float64
	HasCost bool // CostUSD was reported (never for Cursor)
	// NumTurns: Claude's num_turns of this turn. OutTokens: Claude's usage.output_tokens of this
	// turn. CumOutTokens: Claude's sum of modelUsage.*.outputTokens, cumulative like CostUSD;
	// CumOutTokens - OutTokens on a process's first turn end is what the session had put out before
	// this process, which names the earlier CostUSD this process started from.
	NumTurns     int
	OutTokens    int
	CumOutTokens int
	// CumTokens: the tokens so far, counted as CostUSD is. Claude: the sums of modelUsage.*'s
	// inputTokens, outputTokens, cacheReadInputTokens and cacheCreationInputTokens, cumulative for
	// this process, its Agent-tool subagents included. pi: get_session_stats.tokens, the whole
	// session's across processes. HasTokens: they were reported (never for Cursor; for Claude when a
	// model's entry carries at least one of the four counts).
	CumTokens model.TokenCount
	HasTokens bool
	Final     string // Claude: the result line's result text (the turn's final message)
	ExitErr   string
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
