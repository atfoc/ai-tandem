// Package model holds the types shared by the server's packages and mirrored by the web client.
package model

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
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
	ID      string `json:"id"` // "g_" + 8 random base36 chars
	Name    string `json:"name"`
	Parent  string `json:"parent,omitempty"` // the group it is nested in; "" at the top level
	Archive        // embedded, see below
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
	// RemoteGroup is the id of the group "Remote" of a state.json from before level 5, where what
	// API clients made went. It is read once, by the change-over that removes that group
	// (app.DropRemoteGroup), which clears it; nothing sets it.
	RemoteGroup string `json:"remoteGroup,omitempty"`
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

// LocalServer is the one key of GroupDefaults.Servers: what a group remembers, it remembers for
// the server that keeps it.
const LocalServer = "local"

// ServerDefaults is what a group remembers.
type ServerDefaults struct {
	Agent   AgentKind                 `json:"agent,omitempty"` // the agent a new chat starts with
	Cwd     string                    `json:"cwd,omitempty"`
	ByAgent map[AgentKind]ModelChoice `json:"byAgent,omitempty"`
	// Subagents is the subagent settings a new chat starts with, for all agents; nil = none stored.
	// A value that is in a ServerDefaults is never changed: a change puts a new one there.
	Subagents *SubLimits `json:"subagents,omitempty"`
}

type GroupDefaults struct {
	Servers map[string]ServerDefaults `json:"servers,omitempty"` // key: LocalServer alone
}

type Defaults struct {
	Groups map[string]GroupDefaults `json:"groups"` // key: group id, or Ungrouped ("__ungrouped__")
}

// Local is what the group remembers; the zero value when it remembers nothing.
func (g GroupDefaults) Local() ServerDefaults { return g.Servers[LocalServer] }

// LocalDefaults is a group's entry that holds sd and nothing else.
func LocalDefaults(sd ServerDefaults) GroupDefaults {
	return GroupDefaults{Servers: map[string]ServerDefaults{LocalServer: sd}}
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
	// NoImages: the model takes no images. A model without the mark takes them, so a catalog
	// from a server that does not know the mark reads as before.
	NoImages bool `json:"noImages,omitempty"`
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
	// Drafts are the unsent messages in the composer, one per branch, by branch id ("main"
	// included). Only a top-level chat's chat.json has them: a branch's own holds none. A map
	// that is in a ChatMeta is never changed: a change puts a new map there, so a copy of the
	// meta stays good, and a draft's pointer stays the same until that draft changes
	// (ChatView is compared with ==).
	Drafts map[string]*Draft `json:"drafts,omitempty"`
	// DraftRevs counts the changes of each branch's draft, by branch id like Drafts and in the
	// same chat.json: a save of a draft names the count it was typed on, so a late one cannot
	// replace a newer draft. An entry is never removed: a cleared draft keeps its count. Like
	// Drafts, a map that is in a ChatMeta is never changed.
	DraftRevs map[string]int64 `json:"draftRevs,omitempty"`
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
	// Subagents is the chat's subagent settings, chosen in the composer and fixed at the first
	// message; a branch and a fork carry their source's. nil in a chat made before the settings
	// existed: read it with SubLimits, which gives those the defaults.
	// A value that is in a ChatMeta is never changed: a change puts a new one there.
	Subagents *SubLimits `json:"subagents,omitempty"`
	Archive
}

// SubLimits is a chat's two subagent settings.
type SubLimits struct {
	// Depth is the deepest level a subagent of the chat may be at: a subagent the chat's agent
	// started is at level 1, one that subagent started at level 2. 0 = off: no subagent tools.
	Depth int `json:"depth"`
	// Cap is the most subagents of the chat that may run at the same time, at every level,
	// waiting ones (Subagent.Waiting) included.
	Cap int `json:"cap"`
}

const (
	DefaultSubDepth = 1   // what a chat had before the setting existed
	MaxSubDepth     = 3   // no depth above it, from the composer or from an API client
	DefaultSubCap   = 100 // the default and, as MaxSubCap, the most
	MaxSubCap       = 100
)

// DefaultSubLimits is what a chat without stored settings has.
func DefaultSubLimits() SubLimits { return SubLimits{Depth: DefaultSubDepth, Cap: DefaultSubCap} }

// SubLimits returns the chat's subagent settings: the stored ones, else the defaults.
func (m ChatMeta) SubLimits() SubLimits {
	if m.Subagents == nil {
		return DefaultSubLimits()
	}
	return *m.Subagents
}

// SubLimits returns the subagent settings the view shows: the defaults where it names none.
func (v ChatView) SubLimits() SubLimits {
	l := SubLimits{Depth: v.SubDepth, Cap: v.SubCap}
	if l.Depth == 0 && !v.SubOff {
		l.Depth = DefaultSubDepth
	}
	if v.SubOff {
		l.Depth = 0
	}
	if l.Cap == 0 {
		l.Cap = DefaultSubCap
	}
	return l
}

// Check reports a setting outside its range: a depth not in 0..MaxSubDepth, a cap not in
// 1..MaxSubCap. Such a value is refused where it comes in, never brought into the range.
func (l SubLimits) Check() error {
	if l.Depth < 0 || l.Depth > MaxSubDepth {
		return fmt.Errorf("subagent depth %d is out of range: 0 (off) to %d", l.Depth, MaxSubDepth)
	}
	if l.Cap < 1 || l.Cap > MaxSubCap {
		return fmt.Errorf("subagent cap %d is out of range: 1 to %d", l.Cap, MaxSubCap)
	}
	return nil
}

// TokenCount is the tokens an agent reports at a turn end (agent.Event.CumTokens).
type TokenCount struct {
	In         int64 `json:"in"`
	Out        int64 `json:"out"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
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
	// the images the message will carry; their bytes are in the chat's image store
	Images []Image `json:"images,omitempty"`
}

// Image is a picture the user attached to a message, as a draft and a sent message hold it: by
// id, never with its bytes, which are in the image store of the top-level chat. Not a picture of
// a board (get_image).
type Image struct {
	ID   string `json:"id"`   // the SHA-256 of the bytes, 64 lower-case hex digits
	Name string `json:"name"` // from the page: the file's name, or a fixed one for a pasted picture; only shown
	Type string `json:"type"` // found from the bytes: one of ImageTypes
	Size int64  `json:"size"` // in bytes
}

// The limits on images in chats, and the types taken.
const (
	ImageMaxBytes       = 5 << 20  // one image
	ImagesPerMessage    = 10       // images in one message, and in one draft that can be sent
	ImagesMessageBytes  = 20 << 20 // the images of one message together
	ImagesUnsentPerChat = 50       // images of a top-level chat that were never sent
	// ImageWord stands for the words of a message that is images alone, wherever a message is
	// named by its words (the tree, the move banner, a chat's title).
	ImageWord = "Image"
)

// ImageTypes are the image types a chat takes.
var ImageTypes = []string{"image/png", "image/jpeg", "image/gif", "image/webp"}

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
	StatusWaiting  Status = "waiting"  // the agent's turn has ended but it is not done: its own background work runs or has just ended (Claude); not in a turn, busy for the person
	StatusRetrying Status = "retrying" // the agent's turn failed with a temporary error: it waits to be started again on its session, or is being started; shown as working, takes a message
	StatusStopped  Status = "stopped"  // the agent ended mid-turn (server stop, crash)
	StatusError    Status = "error"    // cannot start: see ChatView.Error
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
	DraftRev         int64     `json:"draftRev,omitempty"` // the count of that draft's changes (ChatMeta.DraftRevs)
	Archive

	Status        Status `json:"status"`
	StatusTool    string `json:"statusTool,omitempty"`
	Error         string `json:"error,omitempty"`
	Retry         Retry  `json:"retry,omitzero"` // the chat's agent is being retried after a temporary error (StatusRetrying); zero otherwise
	FolderMissing bool   `json:"folderMissing,omitempty"`

	// The two counts come from the chat's subagent records, so both are zero for a chat whose
	// thread has not been read since the server started. They say what an idle chat waits on.
	SubsRunning int `json:"subsRunning,omitempty"` // app-spawned subagents still running
	SubsOwed    int `json:"subsOwed,omitempty"`    // finished ones whose result the agent has not received (SubDelivery.Owed)
	// The chat's subagent settings (ChatMeta.SubLimits). A view with none of the three (a zero
	// ChatView, one from a server without the settings) reads as the defaults, so "off" is a
	// field of its own and not a depth of 0: read them with SubLimits.
	SubOff   bool `json:"subOff,omitempty"`   // depth 0: no subagent tools
	SubDepth int  `json:"subDepth,omitempty"` // 1..MaxSubDepth; absent = DefaultSubDepth, and with SubOff
	SubCap   int  `json:"subCap,omitempty"`   // 1..MaxSubCap; absent = DefaultSubCap
	// Scalars only: ChatView stays comparable with ==.
	Branches        int    `json:"branches,omitempty"` // the number of branches once the chat has split (>= 2); 0 = one branch
	Branch          string `json:"branch,omitempty"`   // the current branch's id; "" = main
	ForkedFrom      string `json:"forkedFrom,omitempty"`
	ForkedFromTitle string `json:"forkedFromTitle,omitempty"`
	ForkedBranch    string `json:"forkedBranch,omitempty"` // the branch of that chat the fork was made on
	ForkedAt        int    `json:"forkedAt,omitempty"`     // and the item count of that branch it starts with
	// The two counts are over every branch of the chat, whichever is current. Like Branches and
	// Branch, the chat manager sets them.
	Working   int `json:"working,omitempty"`   // branches whose status is thinking, writing, tool, approval or waiting
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
	DraftRev      int64  `json:"draftRev,omitempty"` // the count of that draft's changes (ChatMeta.DraftRevs)
	Fresh         bool   `json:"fresh,omitempty"`    // a fork that has had no message of its own (ChatMeta.Fresh)
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
		DraftRev:      v.DraftRev,
		Fresh:         v.Fresh,
	}
}

// ViewOf builds the client view of a chat. Token, SessionID, TurnActive, McpInstructionsSent and
// ForkSource are left out; InstructionsSent is included because it is the curl-era disable marker.
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
		Cwd:              m.Cwd,
		Model:            m.Model,
		Effort:           m.Effort,
		SubOff:           m.SubLimits().Depth == 0,
		SubDepth:         m.SubLimits().Depth,
		SubCap:           m.SubLimits().Cap,
		Locked:           m.Locked,
		InstructionsSent: m.InstructionsSent,
		Created:          m.Created,
		Usage:            m.Usage,
		Draft:            m.Drafts[MainBranch],
		DraftRev:         m.DraftRevs[MainBranch],
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
	// user: the images the message carries, shown above its text
	Images []Image `json:"images,omitempty"`
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

// SubStatus is a subagent's lifecycle state. Running is live; paused is neither live nor final;
// every other state is final.
type SubStatus string

const (
	SubRunning   SubStatus = "running"
	SubCompleted SubStatus = "completed"
	SubFailed    SubStatus = "failed"
	SubStopped   SubStatus = "stopped"
	SubPaused    SubStatus = "paused" // its retries ran out: no process, its session kept; neither running nor finished
)

// Retry is the state of an agent that is being retried after a temporary error (goal 2.6).
type Retry struct {
	Attempt int    `json:"attempt"`         // the attempt waited for or running, 1 to Of
	Of      int    `json:"of"`              // how many attempts there are (4)
	At      int64  `json:"at,omitempty"`    // unix ms the attempt is due; in the past once it waits for the limiter or runs
	Kind    string `json:"kind"`            // the agent.Temporary of the failed turn
	Error   string `json:"error,omitempty"` // the failed turn's error text
}

// SubCause says why a subagent is in a status that is not running (stored, for the list of
// messages to its parent).
type SubCause string

const (
	CauseTurn           SubCause = "turn"
	CauseTurnError      SubCause = "turn-error"
	CauseFailed         SubCause = "failed"
	CauseAborted        SubCause = "aborted"
	CauseGone           SubCause = "gone"
	CauseSpawnFailed    SubCause = "spawn-failed"
	CauseStopTool       SubCause = "stop-tool"
	CauseParent         SubCause = "parent"
	CausePerson         SubCause = "person"
	CauseShutdown       SubCause = "shutdown"
	CauseRestart        SubCause = "restart"
	CauseNative         SubCause = "native"
	CauseRetriesFailed  SubCause = "retries-failed"   // paused: its retries ran out
	CauseRetryingAtStop SubCause = "retrying-at-stop" // paused: it was being retried when the server stopped
)

// SubDelivery says what the app owes the parent agent for an app-spawned subagent's result. Only
// a finished app-spawned subagent ever leaves SubNotOwed; a record written before the field
// existed reads as SubNotOwed and is never delivered. The parent is whoever started the subagent
// (Subagent.Parent): the chat's agent, or a subagent, which is handed a result once and never a
// second time.
type SubDelivery string

const (
	SubNotOwed   SubDelivery = ""         // nothing owed: running, or an ending that does not notify
	SubOwed      SubDelivery = "owed"     // the parent has not received the result
	SubOwedAgain SubDelivery = "retry"    // owed after one failed attempt: the turn that carried it failed before the agent answered
	SubSent      SubDelivery = "sent"     // handed to the parent in a turn
	SubGivenUp   SubDelivery = "given-up" // not owed, never carried again: two attempts failed, or a subagent did not get it; the report stays on the record
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
	Parent      string    `json:"parent,omitempty"`      // the subagent that started it, whose thread holds that call and which gets its result; "" = the chat's agent
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
	// a record that was never taken, or was written before the count was kept. For a subagent a
	// subagent started (Parent) the thread is that subagent's.
	Carried int `json:"carried,omitempty"`
	// NotCarried marks a copy's record (a new branch's or a fork's) of a subagent that was still
	// running in the source when the copy was made. It does not run in the copy: its status there
	// is stopped and nothing is owed for it. Its result goes to the source only.
	NotCarried bool `json:"notCarried,omitempty"`
	// Waiting is set on a running app-spawned subagent whose own turn has ended while subagents
	// it started are still running, or while a result is still owed to it. Its Status stays
	// running: it is not finished, counts against the chat's cap, and its own result goes to its
	// parent only after it has had theirs.
	Waiting bool `json:"waiting,omitempty"`
	// BgWaiting is set while the subagent waits (Waiting) and its own background work is part of
	// what it waits on; false whenever Waiting is false.
	BgWaiting bool `json:"bgWaiting,omitempty"`
	// Session is the session its process runs on, recorded when it is started (Claude, pi) or when
	// the agent reports it (Cursor); "" for a record from before, which cannot be resumed.
	Session string `json:"session,omitempty"`
	// Retry is set while it is being retried after a temporary error (running); zero otherwise.
	Retry Retry `json:"retry,omitzero"`
	// ErrorKind is, for a paused subagent, the agent.Temporary of its last failed turn.
	ErrorKind string `json:"errorKind,omitempty"`
	// Cause is why it is in its status when that is not running; "" in a record from before.
	Cause SubCause `json:"cause,omitempty"`
}
