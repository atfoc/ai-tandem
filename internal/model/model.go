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

// MainBranch is the id of a chat's first branch, the one that is not listed in tree.json.
const MainBranch = "main"

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
	Catalogs map[AgentKind]*Catalog `json:"catalogs,omitempty"` // last model list each agent reported (Claude, Cursor, pi); Claude falls back to the built-in list when none
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
	Run     *RunDefaults              `json:"run,omitempty"` // what the last run started in the group used
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
	ID            string            `json:"id"` // Claude's id as passed to --model, or Cursor's base id "gpt-5.4-mini"
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
	Run                 string    `json:"run,omitempty"`   // run id: a chat on a run, or (with Role) one of the run's agents; Group stays empty
	Role                AgentRole `json:"role,omitempty"`  // a run agent: "orchestrator" | "task" | "merge"; empty for a user's chat
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
	// Drafts are the unsent messages in the composer, one per branch, by branch id ("main"
	// included). Only a top-level chat's chat.json has them: a branch's own holds none. A map
	// that is in a ChatMeta is never changed: a change puts a new map there, so a copy of the
	// meta stays good, and a draft's pointer stays the same until that draft changes
	// (ChatView is compared with ==).
	Drafts map[string]*Draft `json:"drafts,omitempty"`
	// Draft is the one draft a chat had before its branches had their own. It is read only,
	// never written again: the chat manager moves it to Drafts when it loads the chat.
	Draft *Draft `json:"draft,omitempty"`
	// ContextSplit is the last context split taken between turns; Claude's and live pi's are kept
	// in chat.json and asked for again once messages or turns have moved past it.
	ContextSplit *ContextSplit `json:"contextSplit,omitempty"`
	// ForkSource is set while the forked session may still have to be made again.
	ForkSource      *ForkSource `json:"forkSource,omitempty"`
	ForkedFrom      string      `json:"forkedFrom,omitempty"`      // a fork: the id of the chat it was forked from
	ForkedFromTitle string      `json:"forkedFromTitle,omitempty"` // and that chat's title at the time
	ForkedBranch    string      `json:"forkedBranch,omitempty"`    // the branch of that chat the fork's point is on ("main" for main)
	ForkedAt        int         `json:"forkedAt,omitempty"`        // the point: an item count of that branch
	// NoticeOwed is set on a copy (a new branch or a fork) that holds records of subagents which
	// were still running in its source when it was made (Subagent.NotCarried): its agent has not
	// been told yet that they do not run here. The next human message carries the notice.
	NoticeOwed bool `json:"noticeOwed,omitempty"`
	// NoticeAt is the thread's item count right after the user message that carried the notice,
	// 0 while none has. A copy cut before it is forked from a session that has no notice yet.
	NoticeAt int `json:"noticeAt,omitempty"`
	// Fresh is set on a fork whose prefix holds a user message and which has had no message of
	// its own yet; the first message sent on it clears it. Never set on a branch.
	Fresh bool `json:"fresh,omitempty"`
	// SourceCtx is the context use of the chat a fork was made from, when it was made. It stands
	// for the fork's own until its first message.
	SourceCtx int `json:"sourceCtx,omitempty"`
	// Cost is what the chat's agent and its subagents have cost so far; kept for a run agent's
	// chat (and any chat whose agent reports cost). Never sent to clients.
	Cost *ChatCost `json:"cost,omitempty"`
	Archive
}

// ChatCost is ChatMeta.Cost: what the chat's agent and its subagents have cost. Claude reports a
// total per process that starts again from a baseline when the session is resumed, pi a total
// per session, Cursor nothing; the chat manager keeps the running sum by this record.
type ChatCost struct {
	Sum   float64    `json:"sum"`             // closed processes (Claude) or closed sessions (pi)
	Base  float64    `json:"base,omitempty"`  // Claude: the current process's baseline
	Last  float64    `json:"last,omitempty"`  // the newest reported total of the current process or session
	Subs  float64    `json:"subs,omitempty"`  // finished app-spawned subagents
	Marks []CostMark `json:"marks,omitempty"` // Claude: (cumulative output tokens, total) of every result line of the session
	Known bool       `json:"known,omitempty"` // a cost was reported at least once (never for Cursor)
	Lost  int        `json:"lost,omitempty"`  // processes that ended in a turn without reporting it
	// The token twins of Sum, Base, Last and Subs: what the same reports said of tokens.
	TokSum   TokenCount `json:"tokSum,omitzero"`
	TokBase  TokenCount `json:"tokBase,omitzero"`
	TokLast  TokenCount `json:"tokLast,omitzero"`
	TokSubs  TokenCount `json:"tokSubs,omitzero"`
	TokKnown bool       `json:"tokKnown,omitempty"` // tokens were reported at least once (never for Cursor)
	Peak     int        `json:"peak,omitempty"`     // the largest context a request of the chat's own agent was made with
}

// CostMark is one result line of a Claude session: the session's cumulative output tokens and the
// total cost and cumulative tokens reported with them. A resumed process's baseline is found
// among them.
type CostMark struct {
	Out int        `json:"out"`
	USD float64    `json:"usd"`
	Tok TokenCount `json:"tok,omitzero"`
}

// ForkSource is the session a chat or branch was forked from. It is kept in chat.json while the
// forked session may still have to be made again (Claude, until its first turn ended).
type ForkSource struct {
	Chat    string `json:"chat"`            // server id of the chat or branch whose session is forked
	Session string `json:"session"`         // that session's id
	Point   string `json:"point,omitempty"` // the id on the end mark at the fork point; "" = the end of the session
	Next    string `json:"next,omitempty"`  // the id on the first end mark after the fork point; "" = none
	// Items is the item count of the copied prefix. A fork with no point that was made through
	// another fork's source keeps the count of that source's thread instead.
	Items int `json:"items"`
}

// Draft is the message typed in the composer of one branch of a chat and not sent yet. Cleared
// when a message is sent on that branch.
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
	Run              string    `json:"run,omitempty"`  // a chat on a run, or (with Role) one of the run's agents
	Role             AgentRole `json:"role,omitempty"` // a run agent: never in the snapshot's chats
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

	// The two counts come from the chat's subagent records, so both are zero for a chat whose
	// thread has not been read since the server started. They say what an idle chat waits on.
	SubsRunning int `json:"subsRunning,omitempty"` // app-spawned subagents still running
	SubsOwed    int `json:"subsOwed,omitempty"`    // finished ones whose result the agent has not received (SubDelivery.Owed)
	// Scalars only: ChatView stays comparable with ==.
	Branches        int    `json:"branches,omitempty"` // the number of branches once the chat has split (>= 2); 0 = one branch
	Branch          string `json:"branch,omitempty"`   // the current branch's id; "" = main
	ForkedFrom      string `json:"forkedFrom,omitempty"`
	ForkedFromTitle string `json:"forkedFromTitle,omitempty"`
	ForkedBranch    string `json:"forkedBranch,omitempty"` // the branch of that chat the fork was made on
	ForkedAt        int    `json:"forkedAt,omitempty"`     // and the item count of that branch it starts with
	// The two counts are over every branch of the chat, whichever is current. Like Branches and
	// Branch, the chat manager sets them.
	Working   int `json:"working,omitempty"`   // branches whose status is thinking, writing, tool or approval
	Approvals int `json:"approvals,omitempty"` // of those, the ones waiting for approval
	// Draft above is the current branch's (each branch's own is in its BranchState).
	HasDraft bool `json:"hasDraft,omitempty"` // a branch of the chat has a stored draft
	Fresh    bool `json:"fresh,omitempty"`    // a fork that has had no message of its own (ChatMeta.Fresh)
}

// BranchState is what clients see of one branch of a chat: the session side of its view.
type BranchState struct {
	Chat          string `json:"chat"`   // the top-level chat's id
	Branch        string `json:"branch"` // "main" or a branch id
	Cwd           string `json:"cwd"`
	Model         string `json:"model"`
	Effort        string `json:"effort,omitempty"`
	Locked        bool   `json:"locked"`
	Usage         Usage  `json:"usage"`
	Status        Status `json:"status"`
	StatusTool    string `json:"statusTool,omitempty"`
	Error         string `json:"error,omitempty"`
	FolderMissing bool   `json:"folderMissing,omitempty"`
	SubsRunning   int    `json:"subsRunning,omitempty"`
	SubsOwed      int    `json:"subsOwed,omitempty"`
	Draft         *Draft `json:"draft,omitempty"`
	Fresh         bool   `json:"fresh,omitempty"` // a fork that has had no message of its own (ChatMeta.Fresh)
}

// StateOf is the state record of the branch whose own view is v: the view of that branch's chat
// object alone, not the composed one of its chat.
func StateOf(chat, branch string, v ChatView) BranchState {
	return BranchState{
		Chat:          chat,
		Branch:        branch,
		Cwd:           v.Cwd,
		Model:         v.Model,
		Effort:        v.Effort,
		Locked:        v.Locked,
		Usage:         v.Usage,
		Status:        v.Status,
		StatusTool:    v.StatusTool,
		Error:         v.Error,
		FolderMissing: v.FolderMissing,
		SubsRunning:   v.SubsRunning,
		SubsOwed:      v.SubsOwed,
		Draft:         v.Draft,
		Fresh:         v.Fresh,
	}
}

// ViewOf builds the client view of a chat. Token, SessionID, TurnActive, McpInstructionsSent,
// ForkSource and Cost are left out; InstructionsSent is included because it is the curl-era disable marker.
// Branches, Branch, Working and Approvals stay zero: the chat manager sets them. Draft is the
// draft of main, which is what a top-level chat's meta is the meta of; a branch's meta has none,
// and the chat manager fills it. HasDraft is over every entry of Drafts: the chat manager, which
// knows the chat's branches, leaves out an entry that is under none of them.
func ViewOf(m ChatMeta, status Status, tool, errText string, folderMissing bool) ChatView {
	return ChatView{
		ID:               m.ID,
		Agent:            m.Agent,
		Name:             m.Name,
		UserNamed:        m.UserNamed,
		Group:            m.Group,
		Board:            m.Board,
		Run:              m.Run,
		Role:             m.Role,
		Cwd:              m.Cwd,
		Model:            m.Model,
		Effort:           m.Effort,
		Locked:           m.Locked,
		InstructionsSent: m.InstructionsSent,
		Created:          m.Created,
		Usage:            m.Usage,
		Draft:            m.Drafts[MainBranch],
		HasDraft:         len(m.Drafts) > 0,
		Archive:          m.Archive,
		Status:           status,
		StatusTool:       tool,
		Error:            errText,
		FolderMissing:    folderMissing,
		ForkedFrom:       m.ForkedFrom,
		ForkedFromTitle:  m.ForkedFromTitle,
		ForkedBranch:     m.ForkedBranch,
		ForkedAt:         m.ForkedAt,
		Fresh:            m.Fresh,
	}
}

// Item is one entry of a chat's thread (the prototype's chat.ts Item, moved to the server).
type Item struct {
	// "end" is the end mark of a turn, in a chat's own thread only, never in a subagent's.
	Kind string `json:"kind"` // "user" | "text" | "tool" | "perm" | "note" | "subresult" | "end"
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
	// end
	Point string `json:"point,omitempty"` // the provider's fork-point id for the end of this turn; "" = none recorded
	// subagents
	// tool (Agent/Task): the sid it started; perm: the sid that asked; subresult: the sid whose
	// result the app carried to the agent (its delivery state and report stay on the subagent)
	Subagent string `json:"subagent,omitempty"`
}

// Tree is chats/<chat id>/tree.json. No file = one branch, no labels.
type Tree struct {
	Branches []TreeBranch `json:"branches"` // in creation order; main is not listed
	Labels   []TreeLabel  `json:"labels,omitempty"`
	Current  string       `json:"current,omitempty"` // the current branch's id; "" or "main" = main
}

type TreeBranch struct {
	ID   string `json:"id"`
	From string `json:"from"` // the branch it split from: "main" or a branch id
	At   int    `json:"at"`   // the item count at the split: items 0..At-1 are shared with From
}

type TreeLabel struct {
	Branch string `json:"branch"` // the branch that owns the item
	Item   int    `json:"item"`   // the item's index
	Text   string `json:"text"`
}

// TreeView is the answer of GET /api/chats/{id}/tree.
type TreeView struct {
	Current  string           `json:"current"`  // "main" or a branch id
	Branches []TreeBranchView `json:"branches"` // main first, then creation order
	Labels   []TreeLabel      `json:"labels"`   // never null
}

type TreeBranchView struct {
	ID    string     `json:"id"`
	From  string     `json:"from,omitempty"` // "" for main
	At    int        `json:"at"`             // 0 for main
	Len   int        `json:"len"`            // the branch's item count
	Items []TreeItem `json:"items"`          // its own part (index >= At): user and text items only; never null
}

type TreeItem struct {
	I      int    `json:"i"`
	Kind   string `json:"kind"` // "user" | "text"
	Text   string `json:"text"`
	Done   bool   `json:"done,omitempty"`   // text
	End    int    `json:"end,omitempty"`    // text: turnEnd(items, I); 0 = not its turn's last reply
	Before *int   `json:"before,omitempty"` // user: cutBefore(items, I); absent = none
	OK     bool   `json:"ok,omitempty"`     // pointOK at End (text) or at Before (user)
}

// SubStatus is a subagent's lifecycle state. Every state but running is final.
type SubStatus string

const (
	SubRunning   SubStatus = "running"
	SubCompleted SubStatus = "completed"
	SubFailed    SubStatus = "failed"
	SubStopped   SubStatus = "stopped"
)

// SubDelivery says what the app owes the parent agent for an app-spawned subagent's result. Only
// a finished app-spawned subagent ever leaves SubNotOwed; a record written before the field
// existed reads as SubNotOwed and is never delivered.
type SubDelivery string

const (
	SubNotOwed   SubDelivery = ""         // nothing owed: running, or an ending that does not notify
	SubOwed      SubDelivery = "owed"     // the parent has not received the result
	SubOwedAgain SubDelivery = "retry"    // owed after one failed attempt: the turn that carried it failed before the agent answered
	SubSent      SubDelivery = "sent"     // handed to the parent in a turn
	SubGivenUp   SubDelivery = "given-up" // two attempts failed: not owed, never carried again; the report stays on the record
)

// Owed reports whether the parent has yet to receive the result: owed, or owed after one failed
// attempt.
func (d SubDelivery) Owed() bool { return d == SubOwed || d == SubOwedAgain }

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
	// Delivery is the state of the result's delivery to the parent agent; app-spawned only.
	Delivery SubDelivery `json:"delivery,omitempty"`
	// Carried is the item count of the chat's thread when the result was last taken for a turn,
	// before what that turn added: the result reached the agent, if it did, past that count. 0 in
	// a record that was never taken, or was written before the count was kept.
	Carried int `json:"carried,omitempty"`
	// NotCarried marks a copy's record (a new branch's or a fork's) of a subagent that was still
	// running in the source when the copy was made. It does not run in the copy: its status there
	// is stopped and nothing is owed for it. Its result goes to the source only.
	NotCarried bool `json:"notCarried,omitempty"`
}
