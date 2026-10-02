// This file is the frozen contract between the pi adapter (internal/pi), the app-owned board
// bridge (internal/pibridge) and the app's pi extension (internal/pibridge/extension).
// None of the three may change it alone.
//
// Bridge env (set by the pi adapter on the pi process; child pi processes inherit it):
//
//	AIWB_BRIDGE_SOCKET  the app server's Unix socket path
//	AIWB_BRIDGE_RUN     the run token minted by RegisterRun (the only credential pi sees)
//	AIWB_CHAT_ID        the chat's id
//	AIWB_CHAT_DIR       the chat's data folder (chats/<id>)
//	AIWB_PI_BIN         the absolute pi binary path, for spawning child runs
//	AIWB_MODEL          the parent run's provider-qualified model id
//	AIWB_THINKING       the parent run's thinking level
//	AIWB_APPEND_PROMPT  path of the board system-prompt file (board chats only; children reuse it)
//	AIWB_MCP_CONFIG     board chats only: a Claude-compatible MCP config object
//	                    {"mcpServers":{"board":{"type":"http","url":"…/mcp/<run>"}}} whose URL is
//	                    run-scoped (the board token never appears in it); inherited by subagent runs
//	AIWB_SUB_PARENT     child runs only: the parent's subagent tool-call id
//	AIWB_SUB_DEPTH      child runs only: 0 for a direct child of the chat
//	AIWB_SUB_CHILD      child runs only: the child run's pi session id
//
// Wire format: one frame per LF-terminated line of UTF-8 JSON. The extension opens a connection
// per ask (one request frame, one response line) and keeps one control connection open for hello
// and abort pushes. Requests use kind "ask" (name, input), "activity" (event, a SubActivity),
// "hello" or "notice" (error carries a non-fatal message). Responses echo id and carry ok; ask
// responses add allow and reason, notice responses carry only ok. A notice is sent one-shot like
// an ask request so it does not depend on the asynchronous control connection. An abort push is
// {"kind":"abort","run":"…"}; the extension kills the run's child process trees when it sees one.
// There is no "tool" frame: board tools are served over the app's HTTP MCP route.
package agent

import "encoding/json"

// Bridge frame kinds.
const (
	FrameAsk      = "ask"
	FrameActivity = "activity"
	FrameHello    = "hello"
	FrameAbort    = "abort"
	FrameNotice   = "notice"
)

// SubIdentity tags a frame or delivery as coming from a subagent run. Parent is the tool-call id
// of the subagent tool call that started it, Depth is 0 for a direct child of the chat, Child is
// the child's pi session id.
type SubIdentity struct {
	Parent string `json:"parent"`
	Depth  int    `json:"depth"`
	Child  string `json:"child"`
}

// BridgeFrame is the NDJSON envelope on the bridge socket, one frame per line.
type BridgeFrame struct {
	Kind   string          `json:"kind"`            // FrameAsk | FrameActivity | FrameHello | FrameAbort | FrameNotice
	Run    string          `json:"run,omitempty"`   // run token on every request
	ID     string          `json:"id,omitempty"`    // ask id, or a frame id for activity/hello/notice
	Name   string          `json:"name,omitempty"`  // built-in tool name (ask)
	Sub    *SubIdentity    `json:"sub,omitempty"`   // set by child runs
	Input  json.RawMessage `json:"input,omitempty"` // ask input
	Event  json.RawMessage `json:"event,omitempty"` // a SubActivity for FrameActivity
	OK     *bool           `json:"ok,omitempty"`
	Error  string          `json:"error,omitempty"` // the FrameNotice message
	Allow  *bool           `json:"allow,omitempty"`
	Reason string          `json:"reason,omitempty"`
}

// SubActivity is one child-activity event in a FrameActivity's Event field. Type is one of:
// "start" (Description, Prompt, AgentType, Model, Background, ID = child session id),
// "thinking", "text" (ID = message id, Text), "tool_start"/"tool_input" (ID = tool call id,
// Name, Input), "tool_result" (ID, Name, Result, IsError), "usage" (Tokens, Window, ToolUses),
// "progress" (Text), "done" (Status = completed|failed|stopped, Summary, Error).
type SubActivity struct {
	Type        string          `json:"type"`
	ID          string          `json:"id,omitempty"`
	Name        string          `json:"name,omitempty"`
	Text        string          `json:"text,omitempty"`
	Input       json.RawMessage `json:"input,omitempty"`
	Result      string          `json:"result,omitempty"`
	IsError     bool            `json:"isError,omitempty"`
	Description string          `json:"description,omitempty"`
	Prompt      string          `json:"prompt,omitempty"`
	AgentType   string          `json:"agentType,omitempty"`
	Model       string          `json:"model,omitempty"`
	Background  bool            `json:"background,omitempty"`
	Tokens      int             `json:"tokens,omitempty"`
	Window      int             `json:"window,omitempty"`
	ToolUses    int             `json:"toolUses,omitempty"`
	Status      string          `json:"status,omitempty"`
	Summary     string          `json:"summary,omitempty"`
	Error       string          `json:"error,omitempty"`
}

// RunHandler is implemented by the pi adapter to serve one registered chat run. pibridge calls it
// from its per-connection goroutines; it must never block forever.
type RunHandler interface {
	// Permission answers the extension's tool_call ask. It may block until a decision arrives
	// or answer at once (the pi adapter always approves) and must never block forever; reason
	// is shown to the model when allow is false. sub is nil when the chat's own model asked.
	Permission(toolCallID, toolName string, input json.RawMessage, sub *SubIdentity) (allow bool, reason string)
	// Activity delivers one child-activity event for the run.
	Activity(sub *SubIdentity, activity SubActivity)
	// Notice reports a non-fatal extension-side failure for the run (for example an MCP
	// server that could not be reached or discovered). It is log-surfacing only and must
	// not panic; the app has no chat card for it in v1.
	Notice(message string)
}

// BridgeRegistry is the app-owned Unix-socket bridge (internal/pibridge) as the pi adapter sees
// it. main attaches an implementation after construction; nil means no bridge (plain chats only).
type BridgeRegistry interface {
	// RegisterRun mints a per-run token for a chat run and returns the socket path the extension
	// must use. boardToken is "" for plain chats. Registering the same chat id again replaces the
	// previous registration.
	RegisterRun(chatID, boardToken string, handler RunHandler) (socketPath, runToken string, err error)
	// DeregisterRun forgets a run and closes its connections.
	DeregisterRun(runToken string)
	// AbortRun tells the run's live extension connections to kill their child process trees.
	AbortRun(runToken string)
}
