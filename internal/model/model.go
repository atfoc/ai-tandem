// Package model holds the types shared by the server's packages and mirrored by the web client.
package model

import (
	"crypto/rand"
	"encoding/json"
	"math/big"
	"time"
)

type AgentKind string

const (
	Claude AgentKind = "claude"
	Cursor AgentKind = "cursor"
	Pi     AgentKind = "pi"
)

// Ungrouped is the group id of the ungrouped area. It is a group of its own for defaults.
// It is a named sentinel, never "", so an unset group can't be mistaken for ungrouped.
// Real group ids start with "g_", so it can't clash.
const Ungrouped = "__ungrouped__"

const base36 = "0123456789abcdefghijklmnopqrstuvwxyz"

// NewID returns prefix followed by 8 random base36 characters ("b_", "g_", "a_").
func NewID(prefix string) string {
	b := make([]byte, 8)
	max := big.NewInt(int64(len(base36)))
	for i := range b {
		n, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic(err)
		}
		b[i] = base36[n.Int64()]
	}
	return prefix + string(b)
}

type Group struct {
	ID        string `json:"id"` // "g_" + 8 random base36 chars
	Name      string `json:"name"`
	Parent    string `json:"parent,omitempty"` // the group it is nested in; "" at the top level
	Collapsed bool   `json:"collapsed,omitempty"`
	Archive          // embedded, see below
}

// Board is board.json.
type Board struct {
	ID      string    `json:"id"`    // "b_" + 8 random base36 chars; stable across renames; the folder name
	Name    string    `json:"name"`  // label only; not unique, not on disk
	Group   string    `json:"group"` // group id or Ungrouped
	Created time.Time `json:"created"`
	New     bool      `json:"new,omitempty"` // made by an agent and not opened by the user yet
	Archive
}

// Archive marks an archived item. Op is the id of the archive action that archived it: every
// item archived by one click shares it, so unarchiving puts back exactly what went together.
type Archive struct {
	Archived bool   `json:"archived,omitempty"`
	Op       string `json:"archiveOp,omitempty"`
}

type State struct {
	Version  int                    `json:"version"`
	Groups   []Group                `json:"groups"` // in the user's order; subgroups keep this order among their siblings
	Defaults Defaults               `json:"defaults"`
	Catalogs map[AgentKind]*Catalog `json:"catalogs,omitempty"` // last model list each agent reported (Cursor, pi)
	// Cursor is the legacy Cursor catalog slot, kept for backward-compatible reads of older
	// state.json files. It is never written after the generic Catalogs map exists.
	Cursor *Catalog `json:"cursorCatalog,omitempty"`
}

// Catalog returns the last model list an agent reported, or nil when none is known. It is nil-receiver
// safe. For Cursor it falls back to the legacy cursorCatalog field, which is still read but no
// longer written.
func (s *State) Catalog(a AgentKind) *Catalog {
	if s == nil {
		return nil
	}
	if c := s.Catalogs[a]; c != nil {
		return c
	}
	if a == Cursor {
		return s.Cursor
	}
	return nil
}

// SetCatalog stores c as the last model list an agent reported. It initializes and writes the generic
// Catalogs map only; the legacy cursorCatalog field is left alone.
func (s *State) SetCatalog(a AgentKind, c *Catalog) {
	if s.Catalogs == nil {
		s.Catalogs = map[AgentKind]*Catalog{}
	}
	s.Catalogs[a] = c
}

type ModelChoice struct {
	Model  string `json:"model"`
	Effort string `json:"effort,omitempty"`
}

type GroupDefaults struct {
	Cwd     string                    `json:"cwd,omitempty"`
	ByAgent map[AgentKind]ModelChoice `json:"byAgent,omitempty"`
}

type Defaults struct {
	Last   GroupDefaults            `json:"last"`   // most recent choices anywhere
	Groups map[string]GroupDefaults `json:"groups"` // key: group id, or Ungrouped ("__ungrouped__")
}

type Catalog struct {
	Models  []CatalogModel `json:"models"`
	Default ModelChoice    `json:"default"`
}

type CatalogModel struct {
	ID            string            `json:"id"` // "sonnet", or Cursor's base id "gpt-5.4-mini"
	Label         string            `json:"label"`
	Note          string            `json:"note,omitempty"`
	Provider      string            `json:"provider,omitempty"` // pi only: the provider id pi reported; empty when unknown
	Efforts       []string          `json:"efforts,omitempty"`  // empty: no effort picker
	ContextWindow int               `json:"contextWindow,omitempty"`
	DefaultEffort string            `json:"defaultEffort,omitempty"` // the effort value the model uses by default
	EffortLabels  map[string]string `json:"effortLabels,omitempty"`  // effort value -> Cursor's display name, e.g. "xhigh" -> "Extra High"
}

type Usage struct {
	CtxIn     int    `json:"ctxIn"`              // Claude: last model call's input + cache tokens; pi: last message's input tokens; Cursor: the session store's used_tokens
	CtxOut    int    `json:"ctxOut"`             // Claude and pi: last model call's output tokens
	CtxWindow int    `json:"ctxWindow"`          // Claude and pi: the model's context window; Cursor: the session store's max_tokens
	CtxError  string `json:"ctxError,omitempty"` // Cursor only: why the context usage could not be read; cleared by the next good read
	Turns     int    `json:"turns"`
}

// ContextSplit is what fills a chat's context window, by category, as the agent reports it:
// Claude's get_context_usage, Cursor's session store, pi's get_session_stats. It is the last
// context split taken between turns; Claude's and live pi's are kept in chat.json.
type ContextSplit struct {
	AtMessage  int               `json:"atMessage"` // messages sent when it was taken
	AtTurn     int               `json:"atTurn"`    // turns ended when it was taken (Usage.Turns)
	Total      int               `json:"total"`     // tokens in the context
	Window     int               `json:"window"`
	Categories []ContextCategory `json:"categories"`      // in the agent's order
	Facts      []ContextFact     `json:"facts,omitempty"` // Claude: model, auto-compact, listed skills and commands
}

type ContextCategory struct {
	ID     string            `json:"id"` // Cursor's id ("system_prompt"); Claude's name in snake case
	Label  string            `json:"label"`
	Tokens int               `json:"tokens"`
	Kind   string            `json:"kind"`            // "used"; Claude also "deferred" (not in the context), "buffer" (kept free); "free"
	Chars  int               `json:"chars,omitempty"` // Cursor
	Parts  []ContextCategory `json:"parts,omitempty"` // Claude's Messages: tool calls, tool results, attachments, …
	Items  []ContextItem     `json:"items,omitempty"` // per skill, MCP tool, memory file, agent, tool or attachment type
}

type ContextItem struct {
	Name   string `json:"name"`
	Tokens int    `json:"tokens"`
	Note   string `json:"note,omitempty"` // Claude: a skill's or agent's source, an MCP tool's server, a memory file's type
}

type ContextFact struct {
	Label string `json:"label"`
	Value string `json:"value"`
}

// PlanUsage is an agent's plan usage limits: Claude's as `claude -p /usage` reports them,
// Cursor's as `cursor-cost` does. It is fetched when the client asks and never stored.
type PlanUsage struct {
	Plan      bool         `json:"plan"`           // false: no limits were reported (API-key login, logged out)
	Note      string       `json:"note,omitempty"` // Plan false: why (Claude: the first line /usage printed); true: a warning about the limits
	Limits    []UsageLimit `json:"limits"`
	FetchedAt time.Time    `json:"fetchedAt"` // when the numbers are from
}

type UsageLimit struct {
	Kind     string    `json:"kind"`               // "session", "weekly_all", "weekly_scoped", Cursor's bucket key, or as reported
	Label    string    `json:"label"`              // "Current session", "Current week (all models)", "Current week (Fable)"
	Percent  float64   `json:"percent"`            // 0–100
	Detail   string    `json:"detail,omitempty"`   // Cursor: "$413.89 of $1,101"
	ResetsAt time.Time `json:"resetsAt,omitzero"`  // zero: not reported
	Severity string    `json:"severity,omitempty"` // "normal", …
	Active   bool      `json:"active,omitempty"`   // the limit that binds right now
}

// ChatMeta is chat.json.
type ChatMeta struct {
	ID                  string    `json:"id"` // uuid v4
	Agent               AgentKind `json:"agent"`
	Name                string    `json:"name,omitempty"`
	UserNamed           bool      `json:"userNamed,omitempty"`
	Group               string    `json:"group,omitempty"` // plain chats (a group id or Ungrouped); empty for board chats, which use the board's group
	Board               string    `json:"board,omitempty"` // board id for board chats
	Cwd                 string    `json:"cwd"`
	Model               string    `json:"model"`
	Effort              string    `json:"effort,omitempty"`
	SessionID           string    `json:"sessionId,omitempty"` // Claude and pi: chosen by the app; Cursor: from session/new
	Locked              bool      `json:"locked"`              // first message sent: folder, model, effort fixed
	Token               string    `json:"token,omitempty"`     // durable MCP credential, sent in the Authorization header (every chat)
	Created             time.Time `json:"created"`
	TurnActive          bool      `json:"turnActive,omitempty"`          // a turn was running at the last write
	InstructionsSent    bool      `json:"instructionsSent,omitempty"`    // curl-era Cursor board chats; those chats are disabled
	McpInstructionsSent bool      `json:"mcpInstructionsSent,omitempty"` // Cursor board chats — whiteboard MCP instructions already injected
	Usage               Usage     `json:"usage"`
	Draft               *Draft    `json:"draft,omitempty"` // the unsent message in the composer
	// ContextSplit is the last context split taken between turns; Claude's and live pi's are kept
	// in chat.json and asked for again once messages or turns have moved past it.
	ContextSplit *ContextSplit `json:"contextSplit,omitempty"`
	Archive
}

// Draft is the message typed in a chat's composer and not sent yet. Cleared when a message is sent.
type Draft struct {
	Text     string    `json:"text"`               // the composer's value: the text with its reference tags
	Mentions []Mention `json:"mentions,omitempty"` // boards picked from the @ menu
	// the quotes the message will carry (⌘L on text in a message), with their comments
	References []Reference `json:"references,omitempty"`
}

// Reference is part of an earlier message in the chat's thread that the user quoted (⌘L), with
// their comment on it. The agent gets only the quote and the comment. Positions are in the
// message's displayed text, not its markdown source.
type Reference struct {
	Quote   string `json:"quote"`
	Comment string `json:"comment,omitempty"`
	Item    int    `json:"item"`  // index of the quoted item in this chat's thread
	Start   int    `json:"start"` // selection position in the item's displayed text
	End     int    `json:"end"`
}

// Mention is a board picked from the composer's @ menu, so the name still resolves if boards share it.
type Mention struct {
	Name string `json:"name"`
	ID   string `json:"id"`
}

type Status string

const (
	StatusReady    Status = "ready" // "Ready" before the first turn, "Idle" after
	StatusThinking Status = "thinking"
	StatusWriting  Status = "writing"
	StatusTool     Status = "tool"
	StatusApproval Status = "approval"
	StatusStopped  Status = "stopped" // the agent ended mid-turn (server stop, crash)
	StatusError    Status = "error"   // cannot start: see ChatView.Error
)

// ChatView is what clients see: the metadata without the token, plus live state.
// It is written out field by field (not embedded) so the token can never leak.
type ChatView struct {
	ID               string    `json:"id"`
	Agent            AgentKind `json:"agent"`
	Name             string    `json:"name,omitempty"`
	UserNamed        bool      `json:"userNamed,omitempty"`
	Group            string    `json:"group,omitempty"`
	Board            string    `json:"board,omitempty"`
	Cwd              string    `json:"cwd"`
	Model            string    `json:"model"`
	Effort           string    `json:"effort,omitempty"`
	Locked           bool      `json:"locked"`
	InstructionsSent bool      `json:"instructionsSent,omitempty"` // curl-era Cursor board chats; those chats are disabled
	Created          time.Time `json:"created"`
	Usage            Usage     `json:"usage"`
	Draft            *Draft    `json:"draft,omitempty"`
	Archive

	Status        Status `json:"status"`
	StatusTool    string `json:"statusTool,omitempty"`
	Error         string `json:"error,omitempty"`
	FolderMissing bool   `json:"folderMissing,omitempty"`
}

// ViewOf builds the client view of a chat. Token, SessionID, TurnActive and McpInstructionsSent
// are left out; InstructionsSent is included because it is the curl-era disable marker.
func ViewOf(m ChatMeta, status Status, tool, errText string, folderMissing bool) ChatView {
	return ChatView{
		ID:               m.ID,
		Agent:            m.Agent,
		Name:             m.Name,
		UserNamed:        m.UserNamed,
		Group:            m.Group,
		Board:            m.Board,
		Cwd:              m.Cwd,
		Model:            m.Model,
		Effort:           m.Effort,
		Locked:           m.Locked,
		InstructionsSent: m.InstructionsSent,
		Created:          m.Created,
		Usage:            m.Usage,
		Draft:            m.Draft,
		Archive:          m.Archive,
		Status:           status,
		StatusTool:       tool,
		Error:            errText,
		FolderMissing:    folderMissing,
	}
}

// Item is one entry of a chat's thread (the prototype's chat.ts Item, moved to the server).
type Item struct {
	Kind string `json:"kind"` // "user" | "text" | "tool" | "perm" | "note"
	// user
	Text    string `json:"text,omitempty"`    // user, text, note
	Context string `json:"context,omitempty"` // user: the <ui-context> sent with it (not shown)
	// user: parts of earlier messages in this chat the user quoted, with a comment on each
	References []Reference `json:"references,omitempty"`
	// text
	Done bool `json:"done,omitempty"`
	// tool
	ToolID  string          `json:"toolId,omitempty"`
	Name    string          `json:"name,omitempty"` // Claude tool name, or mcp__board__<tool> for board tools of both agents
	Input   json.RawMessage `json:"input,omitempty"`
	Partial string          `json:"partial,omitempty"`
	Result  *string         `json:"result,omitempty"` // nil while running
	IsError bool            `json:"isError,omitempty"`
	Denied  bool            `json:"denied,omitempty"`
	// perm
	RequestID string `json:"requestId,omitempty"`
	ToolName  string `json:"toolName,omitempty"`
	Decided   string `json:"decided,omitempty"` // "", "allow", "deny"
	// note
	Tone string `json:"tone,omitempty"` // "muted" | "error"
	// subagents
	Subagent string `json:"subagent,omitempty"` // tool (Agent/Task): the sid it started; perm: the sid that asked
}

// SubStatus is a subagent's lifecycle state. Every state but running is final.
type SubStatus string

const (
	SubRunning   SubStatus = "running"
	SubCompleted SubStatus = "completed"
	SubFailed    SubStatus = "failed"
	SubStopped   SubStatus = "stopped"
)

// Subagent is a subagent's state: chats/<chat>/subagents/<ID>/subagent.json. Its own thread is the
// items.jsonl next to it, in the same format as a chat's. It is not an Item: the parent's thread
// only links it from the Agent/Task tool item that started it.
type Subagent struct {
	ID          string    `json:"id"`                    // the app's id, the folder's name
	Tool        string    `json:"tool"`                  // the Agent/Task tool call that started it
	Parent      string    `json:"parent,omitempty"`      // the subagent whose thread holds that call; "" = the chat's
	AgentID     string    `json:"agentId,omitempty"`     // Claude task_id, Cursor subagentSessionId
	Type        string    `json:"type,omitempty"`        // as reported: "general-purpose", "generalPurpose", "Explore", a custom name
	Description string    `json:"description,omitempty"` // the name the parent gave it
	Prompt      string    `json:"prompt,omitempty"`      // what the parent asked it
	Model       string    `json:"model,omitempty"`       // as reported: "claude-haiku-4-5-20251001", "gpt-5.4-mini-medium"
	Kind        AgentKind `json:"kind,omitempty"`        // "claude" | "cursor" | "pi"; app-spawned only
	Effort      string    `json:"effort,omitempty"`
	Background  bool      `json:"background,omitempty"`
	Status      SubStatus `json:"status"`
	Error       string    `json:"error,omitempty"`
	Summary     string    `json:"summary,omitempty"`  // the final report, when the agent reports one (Claude)
	Progress    string    `json:"progress,omitempty"` // Claude's latest model-written progress line
	Last        string    `json:"last,omitempty"`     // the last text of its thread, kept when it ends
	Tokens      int       `json:"tokens,omitempty"`   // context fill
	Window      int       `json:"window,omitempty"`   // the subagent model's context window
	ToolUses    int       `json:"toolUses,omitempty"` // Claude's own count
	Started     int64     `json:"started,omitempty"`  // unix ms, set by the app when it first hears of it
	Ended       int64     `json:"ended,omitempty"`    // unix ms, set when Status leaves running
}
