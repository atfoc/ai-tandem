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
	Version  int      `json:"version"`
	Groups   []Group  `json:"groups"` // in the user's order
	Defaults Defaults `json:"defaults"`
	Cursor   *Catalog `json:"cursorCatalog,omitempty"` // last model list Cursor reported
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
	Values  []string       `json:"values,omitempty"` // Cursor only: exact ACP option values
}

type CatalogModel struct {
	ID            string   `json:"id"` // "sonnet", or Cursor's base id "gpt-5.4-mini"
	Label         string   `json:"label"`
	Note          string   `json:"note,omitempty"`
	Efforts       []string `json:"efforts,omitempty"` // empty: no effort picker
	ContextWindow int      `json:"contextWindow,omitempty"`
}

type Usage struct {
	CtxIn     int    `json:"ctxIn"`              // Claude: last model call's input + cache tokens; Cursor: the session store's used_tokens
	CtxOut    int    `json:"ctxOut"`             // Claude only
	CtxWindow int    `json:"ctxWindow"`          // Claude: from modelUsage; Cursor: the session store's max_tokens
	CtxError  string `json:"ctxError,omitempty"` // Cursor only: why the context usage could not be read; cleared by the next good read
	Turns     int    `json:"turns"`
}

// ChatMeta is chat.json.
type ChatMeta struct {
	ID               string    `json:"id"` // uuid v4
	Agent            AgentKind `json:"agent"`
	Name             string    `json:"name,omitempty"`
	UserNamed        bool      `json:"userNamed,omitempty"`
	Group            string    `json:"group,omitempty"` // plain chats (a group id or Ungrouped); empty for board chats, which use the board's group
	Board            string    `json:"board,omitempty"` // board id for board chats
	Cwd              string    `json:"cwd"`
	Model            string    `json:"model"`
	Effort           string    `json:"effort,omitempty"`
	SessionID        string    `json:"sessionId,omitempty"` // Claude: chosen by us; Cursor: from session/new
	Locked           bool      `json:"locked"`              // first message sent: folder, model, effort fixed
	Token            string    `json:"token,omitempty"`     // board chats: secret for /mcp and /agent URLs
	Created          time.Time `json:"created"`
	TurnActive       bool      `json:"turnActive,omitempty"`       // a turn was running at the last write
	InstructionsSent bool      `json:"instructionsSent,omitempty"` // Cursor board chats
	Usage            Usage     `json:"usage"`
	Archive
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
	ID        string    `json:"id"`
	Agent     AgentKind `json:"agent"`
	Name      string    `json:"name,omitempty"`
	UserNamed bool      `json:"userNamed,omitempty"`
	Group     string    `json:"group,omitempty"`
	Board     string    `json:"board,omitempty"`
	Cwd       string    `json:"cwd"`
	Model     string    `json:"model"`
	Effort    string    `json:"effort,omitempty"`
	Locked    bool      `json:"locked"`
	Created   time.Time `json:"created"`
	Usage     Usage     `json:"usage"`
	Archive

	Status        Status `json:"status"`
	StatusTool    string `json:"statusTool,omitempty"`
	Error         string `json:"error,omitempty"`
	FolderMissing bool   `json:"folderMissing,omitempty"`
}

// ViewOf builds the client view of a chat. Token, SessionID, TurnActive and InstructionsSent
// are left out.
func ViewOf(m ChatMeta, status Status, tool, errText string, folderMissing bool) ChatView {
	return ChatView{
		ID:            m.ID,
		Agent:         m.Agent,
		Name:          m.Name,
		UserNamed:     m.UserNamed,
		Group:         m.Group,
		Board:         m.Board,
		Cwd:           m.Cwd,
		Model:         m.Model,
		Effort:        m.Effort,
		Locked:        m.Locked,
		Created:       m.Created,
		Usage:         m.Usage,
		Archive:       m.Archive,
		Status:        status,
		StatusTool:    tool,
		Error:         errText,
		FolderMissing: folderMissing,
	}
}

// Item is one entry of a chat's thread (the prototype's chat.ts Item, moved to the server).
type Item struct {
	Kind string `json:"kind"` // "user" | "text" | "tool" | "perm" | "note"
	// user
	Text    string `json:"text,omitempty"`    // user, text, note
	Context string `json:"context,omitempty"` // user: the <ui-context> sent with it (not shown)
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
}
