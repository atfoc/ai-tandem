# Implementation spec: the AI Whiteboard app

**Status.** Implementation spec for `docs/features/app.md`. Written 2026-09-24.

**Built from.**
- The feature definition `docs/features/app.md`. Every part of it is covered here.
- The UX prototype on branch `app-ux` (commit `a9f8874`, variant 4, with variant 3's composer). The
  code there is the starting point. This spec names every prototype file that is moved, changed or
  dropped.
- `docs/research/claude-rpc.md` and `docs/research/cursor-rpc.md` for how the two CLIs are driven.
- `docs/research/cursor-context-usage.md` for where Cursor keeps a session's context usage.

**How to read this spec.**
- Paths are relative to the repository root.
- Go code is Go 1.25 (`go.mod` already says `module ai-whiteboard`, `go 1.25.1`). It uses the
  standard library only, as the prototype does. (Cursor's session store is read through the
  `sqlite3` command-line tool, not a Go driver; section 4.6.)
- The client is TypeScript + React 19 + `@excalidraw/excalidraw` 0.18.1, bundled with esbuild, as
  in the prototype.
- **Resolved:** marks a place where the input conflicted with itself, with the research, or with
  the prototype, and says how this spec settles it.

---

## 1. Overview

Two programs:

```
 web client (web/, built with esbuild, opened in a browser tab)
   │  HTTP JSON  (commands)         ▲ SSE /api/events (state, chat items, rpc calls)
   ▼                                │
 Go server (cmd/ai-whiteboard + internal/…)
   ├─ store      ~/.ai-whiteboard: state.json, boards/<id>/{board.json,drawing.excalidraw}, chats/<id>/{chat.json,items.jsonl}
   ├─ editorbridge  the one active client; takeover; rpc calls into the client's board engine
   ├─ chats      one agent per chat; transcript → items; persistence; sticky defaults
   │    ├─ claude adapter   claude -p stream-json (one process per chat)
   │    └─ cursor adapter   agent acp (JSON-RPC over stdio, one process per chat)
   ├─ boardtools the board tool list and the Cursor command parser (no dependencies; shared by adapters, prompts, boardapi)
   ├─ boardapi   MCP at /mcp/{token} (Claude), command endpoint /agent/{token}/{tool} (Cursor)
   └─ app        groups, archive/unarchive/delete cascades, moves
```

- The server owns chats, groups, settings and the board **files**. The client owns the **open
  board** (the Excalidraw engine) and is the only thing that changes a scene. This is the prototype's
  split, kept.
- Every board tool call goes server → active client (`rpc` event) → answer (`POST /api/rpc-reply`).
  With no active client, the call fails at once with a clear message.
- The server's public interface is the HTTP API in section 4.10. It is plain HTTP + JSON + SSE, so a
  React Native client can use it later. The server never assumes a browser: opening one is only a
  convenience of `main`, and serving the web client's files is optional (`-client ""` turns it off).

---

## 2. Repository layout

### 2.1 Files after this feature

```
cmd/ai-whiteboard/main.go            new (replaces the prototype's main.go)
internal/model/model.go              new: shared types (groups, boards, chats, items, defaults, catalog)
internal/store/paths.go              new: the data folder layout
internal/store/store.go              new: state.json load/save, atomic JSON writes, server.json
internal/boards/boards.go            new (from prototype pages.go)
internal/defaults/defaults.go        new: sticky per-group defaults
internal/transcript/transcript.go    new (Go port of prototype web/src/chat.ts's reducer)
internal/agent/agent.go              new: Agent / Spawner interfaces, Event type
internal/agent/appdir.go             new: app-folder guard shared by both adapters
internal/claude/claude.go            new (from prototype chats.go's spawn/readLoop/handleControl)
internal/claude/translate.go         new (Claude stream-json line → agent.Event)
internal/claude/catalog.go           new: Claude's static model list
internal/cursor/acp.go               new: JSON-RPC 2.0 stdio client (from cursor-rpc branch acp.go)
internal/cursor/cursor.go            new: the Cursor adapter
internal/cursor/catalog.go           new: Cursor model list parsing
internal/cursor/probe.go             new: fetch the Cursor model list at server start
internal/cursor/config.go            new: deny rules in the user's Cursor config
internal/cursor/ctxusage.go          new: context usage read from Cursor's session store (sqlite3)
internal/chats/manager.go            new (from prototype chats.go's Chats/Chat)
internal/chats/namer.go              new (from prototype autoName)
internal/editorbridge/bridge.go      new (from prototype hub.go)
internal/boardtools/tools.go         new (from prototype mcp.go's tool list)
internal/boardtools/command.go       new: Cursor command parser
internal/boardapi/mcp.go             new (from prototype mcp.go)
internal/boardapi/command.go         new: Cursor command endpoint
internal/prompts/prompts.go          new
internal/prompts/whiteboard.md       new (replaces prototype prompt.md and prompt-append.md)
internal/app/app.go                  new: groups, moves, archive, unarchive, delete
internal/server/server.go            new: HTTP routes (from prototype main.go's handlers)
internal/server/guard.go             new: Host check and active-client check

web/package.json                     from prototype, unchanged except a "test" script
web/build.mjs                        from prototype; also copies web/public into dist
web/index.html                       from prototype; adds the favicon links
web/public/                          favicon.ico, favicon.png, apple-touch-icon.png (made by make-icons.py)
assets/icon/artwork.png              icon artwork (full-bleed, generated)
scripts/make-icons.py                builds AppIcon.png/.icns and web/public from the artwork
assets/icon/AppIcon.icns             macOS app icon for the .app bundle (Contents/Resources)
web/src/main.tsx                     changed
web/src/api.ts                       new (from prototype conn.ts's `api` object)
web/src/conn.ts                      changed: SSE, active-client handling, rpc answers
web/src/store.ts                     changed
web/src/types.ts                     new: TypeScript mirror of internal/model
web/src/board.ts                     changed: scenes by board id, autosave, board tools, context
web/src/apply.ts                     changed: clean defaults for new elements (section 6)
web/src/format.ts                    unchanged
web/src/logic/labels.ts              new: tool card labels (moved out of ui.tsx, DOM-free)
web/src/logic/context.ts             new: the <ui-context> text (moved out of board.ts, DOM-free)
web/src/logic/tree.ts                new: sidebar tree building (moved out of v4.tsx, DOM-free)
web/src/logic/mentions.ts            new: @name parsing (moved out of ui.tsx, DOM-free)
web/src/App.tsx                      new (from prototype v4.tsx's Grouped)
web/src/Sidebar.tsx                  new (from prototype v4.tsx's sidebar parts)
web/src/Canvas.tsx                   changed
web/src/ChatView.tsx                 new (from prototype ui.tsx Thread/ItemView/ToolCard/PermCard/Rich and v2.tsx ChatHeader)
web/src/Composer.tsx                 new (from prototype ui.tsx Composer and v2.tsx Toolbar/Picker/DirPicker/DirBrowser/ContextMeter)
web/src/Dialogs.tsx                  new: confirm dialog, takeover screen
web/src/icons.tsx                    new (glyphs and icons from ui.tsx, v2.tsx, v4.tsx)
web/src/styles.css                   changed
web/test/*.test.ts                   new

docs/PROJECT.md                      changed (section 9)
.gitignore                           changed
```

### 2.2 Removed from the prototype (not brought over)

- `web/src/variants.tsx`, the variant switch and ⌥V (**Removes**: variants 1–3 and the switch).
- `web/src/v2.tsx` and `web/src/v4.tsx` as files (their parts move as listed above); variant 1's
  `Docked`, `PageTabs`, `SessionList`, `NewChatButton`, `NoChats`; variant 2's `Rail`, `ChatList`,
  the icon rail.
- The sandboxed chat spawn path of variants 1–2 (`--system-prompt prompt.md`, `--tools ""`,
  `--strict-mcp-config`, `--setting-sources ""`) and `prompt.md`.
- `ChatInfo.Configurable`, `AutoApprove`, `Full`, `Plain` flags: every chat is now full and
  configurable; "plain" is simply "has no board".
- The delete approval card and its canvas preview (`previewDelete`, the "Delete?" flash).
- `cursorMock` and everything marked mock.
- `Layout` / `.layout.json`, `pages_changed`, page tabs, `unseen` badges, `open_tabs` in the context.
- The workspace directory argument.

### 2.3 Build and run

```
cd web && npm install && node build.mjs        # builds web/dist
go build -o bin/ai-whiteboard ./cmd/ai-whiteboard
bin/ai-whiteboard                              # starts the server (or finds the running one) and opens the client
```

- `.gitignore` gets `bin/`, `web/node_modules/`, `web/dist/`.
- `web/package.json` gets `"test": "node --test --experimental-strip-types 'test/*.test.ts'"`.

---

## 3. The data folder

### 3.1 Layout

```
~/.ai-whiteboard/
  server.json                 {"pid": 1234, "port": 4747, "started": "..."}  (only while running)
  state.json                  groups, defaults, catalogs
  boards/<id>/board.json      board metadata
  boards/<id>/drawing.excalidraw  the drawing
  chats/<chatId>/chat.json    chat metadata
  chats/<chatId>/items.jsonl  chat history
```

- Created on first start with mode 0700 (the folder) and 0600/0644 (files as below).
- Boards and chats follow one pattern: one folder per item, named by its id, holding a small
  metadata file and the content. `state.json` only indexes groups and defaults; the lists of boards
  and chats are the folders themselves.
- The drawing is a plain `.excalidraw` file. The folder is named by the board's id
  (`boards/b_x7k2m9qa/`), so names need not be unique and a rename never touches the disk layout.
  Reveal in Finder shows `drawing.excalidraw` inside the board's folder.
- Nothing is imported from the prototype's `boards/` folder (**feature: nothing is carried over**).

### 3.2 `internal/store/paths.go`

```go
package store

// Paths is where everything lives. Root is ~/.ai-whiteboard unless -home says otherwise (tests).
type Paths struct {
	Root   string // ~/.ai-whiteboard
	Boards string // Root/boards
	Chats  string // Root/chats
	State  string // Root/state.json
	Server string // Root/server.json
}

func NewPaths(root string) Paths {
	return Paths{Root: root, Boards: filepath.Join(root, "boards"), Chats: filepath.Join(root, "chats"),
		State: filepath.Join(root, "state.json"), Server: filepath.Join(root, "server.json")}
}

func (p Paths) BoardDir(id string) string   { return filepath.Join(p.Boards, id) }
func (p Paths) BoardFile(id string) string  { return filepath.Join(p.Boards, id, "drawing.excalidraw") }
func (p Paths) ChatDir(id string) string    { return filepath.Join(p.Chats, id) }

// Contains reports whether path is Root or inside it, after resolving ~, symlinks and "..".
func (p Paths) Contains(path string) bool
```

`Contains` pseudo code:

```
abs := expandHome(path); abs = filepath.Clean(abs)
if r, err := filepath.EvalSymlinks(abs); err == nil { abs = r }
root := EvalSymlinks(p.Root) or p.Root
return abs == root || strings.HasPrefix(abs, root+"/")
```

### 3.3 `internal/store/store.go`

```go
// WriteJSONAtomic marshals v (indented) to path.tmp and renames it over path.
func WriteJSONAtomic(path string, v any, perm os.FileMode) error

// WriteFileAtomic writes b to "."+base+".tmp" in the same folder and renames it over path.
// (The prototype's Pages.Put, moved here.)
func WriteFileAtomic(path string, b []byte, perm os.FileMode) error

// Store holds state.json in memory and writes it back after every change.
type Store struct {
	P  Paths
	mu sync.Mutex
	s  model.State
}

// Open creates the folders if needed and loads state.json (or starts empty with Version 1).
func Open(p Paths) (*Store, error)

// Read runs f with the state locked. f must not keep references past the call.
func (st *Store) Read(f func(s *model.State))

// Update runs f with the state locked; if f returns nil the state is written to disk.
func (st *Store) Update(f func(s *model.State) error) error

// Server file: written after listen succeeds, removed on shutdown.
func WriteServerFile(p Paths, port int) error
func ReadServerFile(p Paths) (pid, port int, ok bool)
func RemoveServerFile(p Paths)
```

`Open`:

```
mkdir -p p.Root (0700), p.Boards, p.Chats
b, err := os.ReadFile(p.State)
if not exist: st.s = model.State{Version: 1, Defaults: model.Defaults{Groups: map{}}}; return st, WriteJSONAtomic(...)
json.Unmarshal(b, &st.s)            // an unreadable state.json is a fatal error, never overwritten
if st.s.Defaults.Groups == nil { st.s.Defaults.Groups = map{} }
```

### 3.4 Shared types: `internal/model/model.go`

```go
package model

type AgentKind string

const (
	Claude AgentKind = "claude"
	Cursor AgentKind = "cursor"
)

// Ungrouped is the group id of the ungrouped area. It is a group of its own for defaults.
// It is a named sentinel, never "", so an unset group can't be mistaken for ungrouped.
// Real group ids start with "g_", so it can't clash.
const Ungrouped = "__ungrouped__"

type Group struct {
	ID        string `json:"id"`   // "g_" + 8 random base36 chars
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
	Version  int        `json:"version"`
	Groups   []Group    `json:"groups"` // in the user's order
	Defaults Defaults   `json:"defaults"`
	Cursor   *Catalog   `json:"cursorCatalog,omitempty"` // last model list Cursor reported
}

type ModelChoice struct {
	Model  string `json:"model"`
	Effort string `json:"effort,omitempty"`
}

type GroupDefaults struct {
	Cwd       string                    `json:"cwd,omitempty"`
	ByAgent   map[AgentKind]ModelChoice `json:"byAgent,omitempty"`
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
	ID            string   `json:"id"`              // "sonnet", or Cursor's base id "gpt-5.4-mini"
	Label         string   `json:"label"`
	Note          string   `json:"note,omitempty"`
	Efforts       []string `json:"efforts,omitempty"` // empty: no effort picker
	ContextWindow int      `json:"contextWindow,omitempty"`
}

type Usage struct {
	CtxIn        int     `json:"ctxIn"`        // Claude: last model call's input + cache tokens; Cursor: the session store's used_tokens
	CtxOut       int     `json:"ctxOut"`       // Claude only
	CtxWindow    int     `json:"ctxWindow"`    // Claude: from modelUsage; Cursor: the session store's max_tokens
	CtxError     string  `json:"ctxError,omitempty"` // Cursor only: why the context usage could not be read; cleared by the next good read
	Turns        int     `json:"turns"`
}

// ChatMeta is chat.json.
type ChatMeta struct {
	ID        string    `json:"id"` // uuid v4
	Agent     AgentKind `json:"agent"`
	Name      string    `json:"name,omitempty"`
	UserNamed bool      `json:"userNamed,omitempty"`
	Group     string    `json:"group,omitempty"` // plain chats (a group id or Ungrouped); empty for board chats, which use the board's group
	Board     string    `json:"board,omitempty"` // board id for board chats
	Cwd       string    `json:"cwd"`
	Model     string    `json:"model"`
	Effort    string    `json:"effort,omitempty"`
	SessionID string    `json:"sessionId,omitempty"` // Claude: chosen by us; Cursor: from session/new
	Locked    bool      `json:"locked"`              // first message sent: folder, model, effort fixed
	Token     string    `json:"token,omitempty"`     // board chats: secret for /mcp and /agent URLs
	Created   time.Time `json:"created"`
	TurnActive       bool `json:"turnActive,omitempty"`       // a turn was running at the last write
	InstructionsSent bool `json:"instructionsSent,omitempty"` // Cursor board chats
	Usage     Usage     `json:"usage"`
	Archive
}

type Status string

const (
	StatusReady    Status = "ready"    // "Ready" before the first turn, "Idle" after
	StatusThinking Status = "thinking"
	StatusWriting  Status = "writing"
	StatusTool     Status = "tool"
	StatusApproval Status = "approval"
	StatusStopped  Status = "stopped"  // the agent ended mid-turn (server stop, crash)
	StatusError    Status = "error"    // cannot start: see ChatView.Error
)

// ChatView is what clients see: the metadata without the token, plus live state.
type ChatView struct {
	ID, Name        string
	// ... every ChatMeta field except Token, SessionID, TurnActive, InstructionsSent,
	// with the same json names ...
	Status        Status `json:"status"`
	StatusTool    string `json:"statusTool,omitempty"`
	Error         string `json:"error,omitempty"`
	FolderMissing bool   `json:"folderMissing,omitempty"`
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
	Name    string          `json:"name,omitempty"`  // Claude tool name, or mcp__board__<tool> for board tools of both agents
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
```

`ChatView` is written out in full in the code (not embedded), so the token can never leak:

```go
func ViewOf(m ChatMeta, status Status, tool, errText string, folderMissing bool) ChatView
```

`web/src/types.ts` mirrors every type above field for field (json names), as TypeScript `type`s.
It also exports `UNGROUPED = "__ungrouped__"` and `AGENT_ORDER = ["claude", "cursor"]`.

### 3.5 `board.json`, `chat.json` and `items.jsonl`

- `board.json` is `Board`, written with `WriteJSONAtomic(…, 0644)` after every change to it.
  `drawing.excalidraw` is written only by `Save` (and once by `Create`).
- `chat.json` is `ChatMeta`, written with `WriteJSONAtomic(…, 0600)` after every change to it.
- `items.jsonl` is append-only. Each line is `{"i": <index>, "item": <Item>}`. Loading applies the
  lines in order; a later line for the same index replaces the earlier one.
- A line is written when an item is **settled** (user item, finished text, tool with a result or
  denial, decided permission, note) and, for items still open, on shutdown. Stream deltas are never
  written one by one.
- **Resolved:** the prototype kept the raw CLI events in memory and replayed them to each tab. The
  feature needs history across restarts and a client-neutral interface, so the server now turns
  agent events into items (section 4.4) and stores items. Clients only render items.

---

## 4. Server

### 4.1 Boards: `internal/boards/boards.go`

From the prototype's `pages.go` (`cleanName`, `Create`, `Rename`, `Put`, `emptyScene`), keyed by
board id and backed by one folder per board (`boards/<id>/`), the same pattern as the chat manager.
All boards' metadata is held in memory, loaded at boot.

```go
type Emitter interface{ Broadcast(ev any) }

type Service struct {
	st     *store.Store // for P and the group list
	bridge Emitter
	mu     sync.Mutex // guards boards and serializes file operations
	boards map[string]*model.Board
}

func New(st *store.Store, bridge Emitter) *Service

const EmptyScene = `{"type":"excalidraw","version":2,"source":"ai-whiteboard","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}`

var ErrArchived = errors.New("the board is archived")
var ErrNotFound = errors.New("no such board")

// CleanName turns user input into a board name (a label; duplicates allowed).
func CleanName(s string) (string, error)

// Load reads every boards/<id>/board.json at boot.
func (b *Service) Load() error
func (b *Service) List() []model.Board
func (b *Service) Get(id string) (model.Board, bool)
func (b *Service) Create(name, group string, isNew bool) (model.Board, error)
func (b *Service) Scene(id string) ([]byte, error)
func (b *Service) Save(id string, body []byte) error
func (b *Service) Rename(id, name string) (model.Board, error)
func (b *Service) Move(id, group string) error
func (b *Service) Seen(id string) error
func (b *Service) SetArchive(id string, a model.Archive) error
func (b *Service) Delete(id string) error
func (b *Service) Reveal(id string) error
```

Pseudo code:

```
CleanName(s):
  s = strings.TrimSpace(s); s = strings.TrimSuffix(s, ".excalidraw")
  s = strings.ReplaceAll(s, " ", "-")                       // prototype rule
  reject if s == "" or starts with "." or contains "/" or "\\" or any control char, or len > 80
  return s

save(bd):     WriteJSONAtomic(BoardDir(bd.ID)/board.json, bd, 0644)

Load():
  for dir in P.Boards: bd := read board.json; register
  a folder without a readable board.json is logged and skipped (never deleted)

List(): every registered board (the client sorts)

Create(name, group, isNew):
  if name == "" { name = "whiteboard" }                     // prototype v4 default
  base := CleanName(name); lock
  check group exists (or Ungrouped), else error
  bd := Board{ID: newID("b_"), Name: base, Group: group, Created: now, New: isNew}
  mkdir BoardDir(bd.ID)
  WriteFileAtomic(P.BoardFile(bd.ID), EmptyScene, 0644)      // saved the moment it is created
  save(bd); register                                         // board.json last: a folder without it is not a board
  bridge.Broadcast({type:"board", board: bd}); return bd

Scene(id):
  board must be registered, else ErrNotFound                // never an empty scene for an unknown id
  return os.ReadFile(P.BoardFile(id)); a known board with a missing file → EmptyScene

Save(id, body):
  board must exist and not be archived (ErrArchived)
  json.Valid(body) else error
  WriteFileAtomic(P.BoardFile(id), body, 0644)

Rename(id, name):
  n := CleanName(name); if n == board.Name return board
  board.Name = n; save; broadcast board                      // the folder keeps its id name

Move(id, group): check group; board.Group = group; save; broadcast board
Seen(id): board.New = false; save; broadcast board
SetArchive(id, a): board.Archive = a; save; broadcast board
Delete(id): os.RemoveAll(BoardDir(id)); unregister; broadcast {type:"board_removed", id}
Reveal(id): exec.Command("open", "-R", P.BoardFile(id)).Run()
```

**Resolved:** there is no import. Boards are only made by `Create`; an existing `.excalidraw`
file can't be brought into the app. Nothing needed it: the prototype's boards are not carried over,
and Reveal in Finder is enough to reach a board's file.

**Resolved (updated):** board names are **not** unique. Two boards may share a name, in the same
group or not; create and rename never add `-2`, `-3` and never fail on a clash. The id is the
board's identity everywhere: the folder is `boards/<id>/`, the `@` picker records the id,
`<ui-context>` shows `name (id)`, and the board tools take **only ids**. When the user names a
board the agent has no id for, it calls `list_boards` first; if several boards share that name, it
picks by group or asks the user. There is no name lookup anywhere in the board tools.

### 4.2 Sticky defaults: `internal/defaults/defaults.go`

```go
// Resolve returns the folder, model and effort for a new chat of agent a in group g.
// fallbackCwd is the server's default folder; cat is the agent's catalog (its Default is the last resort).
func Resolve(d model.Defaults, g string, a model.AgentKind, fallbackCwd string, cat *model.Catalog) (cwd string, mc model.ModelChoice)

// RecordChange stores what the user just changed in a chat's composer, for group g and "last".
// Empty fields in the change are left alone.
func RecordChange(d *model.Defaults, g string, a model.AgentKind, cwd string, change model.ModelChoice)

// SeedGroup gives a new group the defaults used most recently anywhere.
func SeedGroup(d *model.Defaults, g string)

// AgentOrder is the fixed order agents are offered in, everywhere: Claude, then Cursor.
// It never depends on what was used last.
var AgentOrder = []model.AgentKind{model.Claude, model.Cursor}
```

```
Resolve:
  gd, ok := d.Groups[g]
  cwd = first non-empty of gd.Cwd, d.Last.Cwd, fallbackCwd
  if cwd no longer exists on disk: cwd = fallbackCwd
  mc = gd.ByAgent[a] if its Model is set, else d.Last.ByAgent[a] if its Model is set, else cat.Default (Claude: sonnet/high)
  if cat != nil and mc.Model not in cat.Models: mc = cat.Default
  if mc.Model's CatalogModel has no Efforts: mc.Effort = ""

RecordChange:
  for target in [&d.Groups[g] (created if missing), &d.Last]:
     if cwd != "": target.Cwd = cwd
     cur := target.ByAgent[a]
     if change.Model != "": cur.Model = change.Model
     if change.Effort != "": cur.Effort = change.Effort
     if cur.Model != "": target.ByAgent[a] = cur      // never store an empty choice: it would hide "last"

SeedGroup:   d.Groups[g] = deep copy of d.Last
```

- Folder is per group for all agents; model and effort per group and per agent (feature, *Sticky
  defaults*).
- Board chats use the board's group (the caller passes the board's group).
- Nothing here touches existing chats; moving a chat never calls these.
- When a new chat is created, the resolved values are **not** recorded. They are recorded when the
  chat's first message is sent (`Send` calls `RecordChange` with the chat's folder, model and effort),
  so sending confirms them as chosen even if the user changed nothing.
- The agent order in menus is fixed (Claude, then Cursor); nothing records which agent was used
  last.

### 4.3 The agent interface: `internal/agent/agent.go`

```go
package agent

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
	Events() <-chan Event                 // closed after EvExit
	Send(blocks []ContentBlock) error     // one user turn; waits for the handshake if needed
	Interrupt() error
	Decide(requestID string, allow bool) error
	Close()                               // ends the process (graceful, then kill after 3 s)
}

type EventKind int

const (
	EvSession    EventKind = iota // SessionID known (Cursor after session/new)
	EvCatalog                     // Cursor reported its models (Catalog)
	EvThinking                    // model is thinking / request started
	EvTextStart                   // a new text item begins (MsgID)
	EvTextDelta                   // Text appended to the open text item
	EvText                        // a whole text block that was not streamed (MsgID, Text)
	EvToolStart                   // ToolID, ToolName, Input (may be null)
	EvToolInputDelta              // ToolID, Text = partial JSON
	EvToolInput                   // ToolID, ToolName, Input (final)
	EvToolResult                  // ToolID, Result, IsError
	EvToolDenied                  // ToolID
	EvPermRequest                 // PermID, ToolName, ToolID, Input
	EvUsage                       // CtxIn/CtxOut/CtxWindow (any may be 0 = unchanged), or CtxError
	EvTurnEnd                     // Aborted, Error
	EvExit                        // ExitErr
)

type Event struct {
	Kind      EventKind
	SessionID string
	Catalog   *model.Catalog
	MsgID     string
	Text      string
	ToolID    string
	ToolName  string
	Input     json.RawMessage
	Result    string
	IsError   bool
	PermID    string
	CtxIn, CtxOut, CtxWindow int
	CtxError  string // EvUsage: context usage could not be read (the numbers are then all 0)
	Aborted   bool
	Error     string
	ExitErr   string
}
```

`internal/agent/appdir.go`, used by both adapters:

```go
// TouchesAppDir reports whether a tool input (command, path, url…) refers to the app's folder.
// root is the absolute data folder. It checks the raw JSON text for root, for "~/"+rel(home, root),
// and for the folder's base name (".ai-whiteboard").
func TouchesAppDir(input json.RawMessage, root, home string) bool

const AppDirDenied = "AI Whiteboard does not allow agents to touch its own folder. Use the board tools."
```

### 4.4 Transcript: `internal/transcript/transcript.go`

The Go port of the prototype's `web/src/chat.ts` reducer, over `agent.Event` instead of raw
Claude lines.

```go
type Transcript struct {
	path    string // items.jsonl
	items   []model.Item
	version int              // bumped on every change
	open    int              // index of the open text item, -1 if none
	tools   map[string]int   // tool id → item index
	perms   map[string]int   // request id → item index
	dirty   map[int]bool     // settled items not yet written
	status  model.Status
	tool    string           // tool name behind StatusTool
}

type Update struct {
	Index int        `json:"index"`
	Item  model.Item `json:"item"`
}

func Load(path string) (*Transcript, error)
func (t *Transcript) Snapshot() (version int, items []model.Item)
func (t *Transcript) AddUser(text, context string) []Update
func (t *Transcript) AddNote(tone, text string) []Update
func (t *Transcript) Apply(ev agent.Event) []Update
func (t *Transcript) Decided(requestID string, allow bool) []Update
func (t *Transcript) Status() (model.Status, string)
func (t *Transcript) SetStatus(s model.Status)
func (t *Transcript) Flush(all bool) error // all: also write open items (shutdown)
func (t *Transcript) Version() int
```

```
Load: read lines; items[i] = item (grow slice as needed); open = -1; rebuild tools/perms maps;
      status = ready

set(i, item): items[i] = item; version++; return Update{i, item}
push(item): append; version++; return Update{len-1, item}

AddUser: close open text; status = thinking; u := push({kind:user,text,context}); dirty[u.Index]=true

Apply(ev):
  switch ev.Kind:
  EvThinking:   if status != approval { status = thinking }; return nil
  EvTextStart:  close open text; status = writing; u := push({kind:text, text:""}); open = u.Index
  EvTextDelta:  if open < 0 { Apply(EvTextStart) }; set(open, text += ev.Text); status = writing
  EvText:       close open; u := push({kind:text,text:ev.Text,done:true}); dirty
  EvToolStart:  close open; status = tool; tool = ev.ToolName
                i := push({kind:tool, toolId, name, input: ev.Input}); tools[ev.ToolID] = i
  EvToolInputDelta: i := tools[id]; set(i, partial += ev.Text)
  EvToolInput:  i, ok := tools[id]; if !ok { treat as EvToolStart }; set(i, input = ev.Input, name = ev.ToolName)
  EvToolResult: i := tools[id]; set(i, result=&ev.Result, isError); dirty[i]; status = thinking
  EvToolDenied: i := tools[id]; set(i, denied=true); dirty[i]
  EvPermRequest: status = approval; i := push({kind:perm, requestId, toolName, toolId, input}); perms[id]=i
  EvTurnEnd:
     close open text (done=true, dirty)
     if ev.Aborted { push note(muted,"Stopped.") } else if ev.Error != "" { push note(error, ev.Error) }
     status = ready
  EvExit:
     close open text
     if status is busy (thinking|writing|tool|approval): push note(error, "The agent stopped: "+ev.ExitErr or "process ended"); status = stopped
     for every perm item not decided: set(decided = "deny"), dirty
     else status unchanged (an idle process ending is not shown)

Decided(id, allow): i := perms[id]; set(decided = allow?"allow":"deny"); dirty; if status == approval { status = tool }

close open text: if open >= 0 { set(open, done=true); dirty[open]=true; open = -1 }

Flush(all): lines for each dirty index (and, if all, every item not settled) → append to file; clear dirty
```

Usage (`EvUsage`, and the turn count from `EvTurnEnd`) is not kept here; the chat manager applies it to
`ChatMeta.Usage`.

### 4.5 Claude adapter: `internal/claude/`

From the prototype's `Chat.spawn` (variant 3 "full" branch), `start`, `readLoop`, `handleControl`,
`write`, `Interrupt`, `Close`.

```go
type Spawner struct {
	Bin     string // -claude flag, default "claude"
	AppRoot string // data folder
	Home    string
	Prompt  string // prompts.Claude()
}

func (s *Spawner) Spawn(o agent.SpawnOptions) (agent.Agent, error)

type proc struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	writeMu   sync.Mutex
	events    chan agent.Event   // buffered 1024
	perms     sync.Map           // request id → struct{} (pending)
	stderr    *bytes.Buffer
	s         *Spawner
}
```

`Args` (a separate function so it can be tested):

```go
func (s *Spawner) Args(o agent.SpawnOptions) []string {
	args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--include-partial-messages", "--permission-mode", "auto", "--permission-prompt-tool", "stdio"}
	if o.Resume { args = append(args, "--resume", o.SessionID) } else { args = append(args, "--session-id", o.SessionID) }
	if o.Model != "" { args = append(args, "--model", o.Model) }
	if o.Effort != "" && o.Model != "haiku" { args = append(args, "--effort", o.Effort) }
	args = append(args, "--disallowedTools", strings.Join(AppDirRules(s.AppRoot, s.Home), ","))
	if o.Board != nil {
		mcp := fmt.Sprintf(`{"mcpServers":{"board":{"type":"http","url":%q}}}`, o.Board.MCPURL)
		allowed := []string{}
		for _, t := range boardtools.Tools { allowed = append(allowed, "mcp__board__"+t.Name) }
		args = append(args, "--append-system-prompt", s.Prompt, "--mcp-config", mcp,
			"--allowedTools", strings.Join(allowed, ","))
	}
	return args
}

// AppDirRules are Claude permission rules that deny the app's folder.
// Under the home folder they use "~/" paths, otherwise "//" absolute paths (Claude's rule syntax).
func AppDirRules(root, home string) []string {
	p := "//" + strings.TrimPrefix(root, "/")
	if rel, ok := under(home, root); ok { p = "~/" + rel }
	base := filepath.Base(root)
	return []string{"Read(" + p + "/**)", "Edit(" + p + "/**)", "Write(" + p + "/**)", "Bash(*" + base + "*)"}
}
```

- No isolation flags (`--strict-mcp-config`, `--setting-sources`, `--disable-slash-commands`): the
  chat is the user's own Claude Code session (variant 3, **feature: the research's isolation flags
  no longer apply**).
- **Resolved:** every chat runs with `--permission-mode auto`, whatever `defaultMode` the user has
  set. Auto mode's classifier approves routine tool calls; what it escalates still arrives as
  `can_use_tool` over `--permission-prompt-tool stdio` and shows as an approval card. The
  app-folder guard (`--disallowedTools`, `TouchesAppDir`) applies in every mode.
- Plain chats get none of `--append-system-prompt`, `--mcp-config`, `--allowedTools`.
- **Resolved:** Claude snapshots the system prompt per session. A resumed chat keeps the
  whiteboard instructions it started with; `--system-prompt-snapshot` is left at its default.

`Spawn`:

```
if _, err := os.Stat(o.Cwd); err != nil → return nil, ErrFolderMissing (agent.ErrFolderMissing)
cmd := exec.Command(s.Bin, s.Args(o)...); cmd.Dir = o.Cwd; cmd.Stderr = p.stderr (capped 64 KB)
stdin, stdout pipes; cmd.Start()
go p.readLoop(stdout)
return p
```

`readLoop` (prototype `readLoop`, with translation):

```
sc := bufio.NewScanner(stdout); sc.Buffer(1 MB, 64 MB)
for sc.Scan():
  var m map[string]any; if json.Unmarshal fails: continue
  switch m["type"]:
   "control_request": p.handleControl(m); continue
   "control_response": continue
  for _, ev := range p.translate(m) { p.events <- ev }
err := cmd.Wait()
p.events <- Event{Kind: EvExit, ExitErr: trimmed stderr or err text}
close(p.events)
```

`translate` (`internal/claude/translate.go`), the prototype's `chat.ts` `event()` mapped to events:

```
if m["parent_tool_use_id"] != nil → no events (subagent chatter)
switch type:
 "system":
   subtype "status", status "requesting" → [EvThinking]
   subtype "permission_denied"           → [EvToolDenied{ToolID: tool_use_id}]
 "stream_event": e := m["event"]
   "message_start": u := e.message.usage → [EvUsage{CtxIn: input+cache_creation+cache_read, CtxOut: output}];
                    remember curMsg = e.message.id; streamed[curMsg] = true; blocks = {}
   "message_delta": if e.usage.output_tokens → [EvUsage{CtxOut}]
   "content_block_start":
      text     → blocks[index] = "text"; [EvTextStart{MsgID: curMsg}] (+ EvTextDelta if initial text)
      tool_use → blocks[index] = id; [EvToolStart{ToolID: id, ToolName: name}]
      thinking → [EvThinking]
   "content_block_delta":
      text_delta       → [EvTextDelta{Text}]
      input_json_delta → [EvToolInputDelta{ToolID: blocks[index], Text: partial_json}]
 "assistant": for each content block b:
      tool_use → EvToolInput{ToolID: b.id, ToolName: b.name, Input: b.input}
      text and message id not in streamed → EvText{MsgID, Text}
 "user": for each tool_result b → EvToolResult{ToolID: b.tool_use_id, Result: text of b.content, IsError: b.is_error}
 "result":
      win := max(modelUsage[*].contextWindow)
      events: [EvUsage{CtxWindow: win}, EvTurnEnd{
               Aborted: terminal_reason == "aborted_streaming",
               Error: is_error && not aborted ? (result or "Error: "+terminal_reason) : ""}]
```

`handleControl` (prototype, plus the app-folder guard):

```
id := m.request_id; req := m.request
if req.subtype != "can_use_tool": write control_response error "unsupported control request"; return
input := req.input
if agent.TouchesAppDir(input, s.AppRoot, s.Home):
   write deny(id, agent.AppDirDenied); return                // no card
p.perms.Store(id, req)
p.events <- EvPermRequest{PermID: id, ToolName: req.tool_name, ToolID: req.tool_use_id, Input: input}
```

`Decide(id, allow)`:

```
req, ok := p.perms.LoadAndDelete(id); if !ok → error "no such request"
allow → write {"type":"control_response","response":{"subtype":"success","request_id":id,
                "response":{"behavior":"allow","updatedInput": req.input}}}
deny  → ... {"behavior":"deny","message":"The user said no in AI Whiteboard."}
```

`Send(blocks)` writes `{"type":"user","message":{"role":"user","content":[{"type":"text","text":…},…]}}`
with `json.Marshal`, one line (prototype `Send`). `Interrupt` writes the prototype's interrupt
control request. `Close` closes stdin, then kills after 3 s (prototype `Close`).

`internal/claude/catalog.go`:

```go
var Catalog = model.Catalog{
	Models: []model.CatalogModel{
		{ID: "sonnet", Label: "Sonnet 5", Note: "Balanced · 1M context", Efforts: efforts, ContextWindow: 1_000_000},
		{ID: "opus", Label: "Opus 5.5", Note: "Most capable · 1M context", Efforts: efforts, ContextWindow: 1_000_000},
		{ID: "haiku", Label: "Haiku 4.5", Note: "Fastest · 200k context", ContextWindow: 200_000},
	},
	Default: model.ModelChoice{Model: "sonnet", Effort: "high"},
}
var efforts = []string{"low", "medium", "high", "xhigh", "max"}
```

(The prototype's `MODELS2` / `EFFORTS`, moved to the server so every client gets the same list.)

### 4.6 Cursor adapter: `internal/cursor/`

A real integration over ACP (`agent acp`), per `docs/research/cursor-rpc.md`.

**Resolved (isolation):** the research recommends a server-owned `CURSOR_CONFIG_DIR`. The feature
says Cursor runs with the user's own settings and accepts that a model change may change the user's
global default. So the process gets the user's environment unchanged, and ACP sessions live in the
default config folder (`~/.cursor/acp-sessions`), which is stable, so `session/load` finds them.

**Resolved (instructions):** the research recommends writing `AGENTS.md` / `.cursor/rules` into the
chat's folder. The feature forbids writing into the folder. The whiteboard instructions go into the
first message of a board chat as a text block (section 4.8), and the board API address goes into
every message.

**Resolved (MCP):** no MCP servers are passed (`mcpServers: []`); team policy blocks them, and a
board chat uses commands instead.

`internal/cursor/acp.go` — the JSON-RPC client from branch `cursor-rpc` (`cmd/acpprobe/acp.go`),
moved and trimmed:

```go
type Conn struct {
	cmd     *exec.Cmd
	w       io.WriteCloser
	wmu     sync.Mutex
	seq     atomic.Int64
	pending sync.Map // id → chan response
	OnNotify  func(method string, params json.RawMessage)
	OnRequest func(id json.RawMessage, method string, params json.RawMessage)
	done    chan struct{}
}

func Start(bin string, args []string, dir string) (*Conn, error)
func (c *Conn) Call(method string, params any) (json.RawMessage, error) // waits for the response
func (c *Conn) Notify(method string, params any) error
func (c *Conn) Reply(id json.RawMessage, result any, rpcErr any) error
func (c *Conn) Wait() error
```

Read loop: one JSON object per line; a message with `id` and `method` → `OnRequest`; with `id` and
no `method` → the pending call; with `method` and no `id` → `OnNotify`. Scanner buffer as in Claude.

`internal/cursor/cursor.go`:

```go
type Spawner struct {
	Bin     string // -cursor flag, default "agent"
	SQLite  string // sqlite3 binary for the context meter, default "sqlite3"
	AppRoot string
	Home    string

	// OnCatalog is not used; catalogs come back as EvCatalog.
}

type proc struct {
	conn      *Conn
	o         agent.SpawnOptions
	events    chan agent.Event
	ready     chan struct{}  // closed when the session is usable
	readyErr  error
	sessionID string
	loading   atomic.Bool    // true during session/load: its replayed updates are dropped
	inText    bool           // a text item is open
	msgSeq    int
	perms     sync.Map       // our request id string → jsonrpc id + options
	tools     map[string]string // toolCallId → normalized tool name
	ctx       ctxPoller         // context usage reads (ctxusage.go)
	s         *Spawner
}
```

`Spawn`:

```
check o.Cwd exists → ErrFolderMissing
conn := Start(s.Bin, []string{"acp"}, o.Cwd)
p.conn.OnNotify = p.onUpdate; p.conn.OnRequest = p.onRequest
go p.handshake()
go func(){ err := conn.Wait(); p.events <- EvExit{ExitErr}; close(p.events) }()
return p
```

`handshake` (research: initialize → authenticate → session/new or session/load):

```
conn.Call("initialize", {protocolVersion: 1,
    clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false},
    clientInfo: {name: "ai-whiteboard", version: version.Version}})
conn.Call("authenticate", {methodId: "cursor_login"})
if o.Resume:
   p.loading = true
   conn.Call("session/load", {sessionId: o.SessionID, cwd: o.Cwd, mcpServers: []})
   p.loading = false; p.sessionID = o.SessionID
   p.readCtx()                        // a resumed chat shows its meter before the next turn
else:
   res := conn.Call("session/new", {cwd: o.Cwd, mcpServers: []})
   p.sessionID = res.sessionId
   cat := ParseCatalog(res)
   p.events <- EvSession{SessionID}; if cat != nil { p.events <- EvCatalog{Catalog: cat} }
if o.Model != "":
   v := ValueFor(catalog (from res, or the last known), o.Model, o.Effort)
   if v != "": conn.Call("session/set_config_option", {sessionId, configId: "model", value: v})
               (on error: conn.Call("session/set_model", {sessionId, modelId: v}))
on any error: p.readyErr = err
close(p.ready)
```

`Send(blocks)`:

```
<-p.ready; if p.readyErr → return it
prompt := [{type:"text", text: b.Text} for b in blocks]
p.inText = false; p.events <- EvThinking
p.ctx.startPolling()                  // re-reads the store every second during the turn
go func():
   res, err := conn.Call("session/prompt", {sessionId, prompt})
   p.ctx.stopPolling(); p.readCtx()    // one final read after every turn, errors included
   if err: p.events <- EvTurnEnd{Error: err.Error()}; return
   p.inText = false
   p.events <- EvTurnEnd{Aborted: res.stopReason == "cancelled",
                         Error: stopReason not in {end_turn, cancelled, max_tokens}? "Cursor stopped: "+stopReason : ""}
```

`Interrupt`: `conn.Notify("session/cancel", {sessionId})`.

`onUpdate(method, params)` (only `session/update`; dropped while `p.loading`):

```
u := params.update
switch u.sessionUpdate:
 "agent_thought_chunk": EvThinking
 "agent_message_chunk":
     if !p.inText { p.msgSeq++; EvTextStart{MsgID: "c"+msgSeq}; p.inText = true }
     EvTextDelta{Text: u.content.text}
 "tool_call":
     p.inText = false
     name, input := normalizeTool(u)        // below
     EvToolStart{ToolID: u.toolCallId, ToolName: name, Input: input}
     if status in {completed, failed}: emit result as for tool_call_update
 "tool_call_update":
     if u.rawInput present: EvToolInput{ToolID, ToolName: normalizeTool(u).name, Input}
     if u.status == "completed": EvToolResult{ToolID, Result: resultText(u), IsError: exitCode != 0}
     if u.status == "failed":    EvToolResult{ToolID, Result: resultText(u), IsError: true}
 other kinds: ignored (session_info_update, available_commands_update, plan, modes, subagents)
```

```
normalizeTool(u):
  cmd := u.rawInput.command (string) if kind == "execute", else from u.title with backticks trimmed
  if kind == "execute":
     if tok, tool, args, ok := boardtools.ParseCommand(cmd); ok && tok == p.o.Board.Token:
         return "mcp__board__"+tool, args                      // shows as a board card
     return "Bash", {"command": cmd}                            // same card as Claude's shell
  kind "read":   return "Read",  {"file_path": u.locations[0].path}
  kind "edit":   return "Edit",  {"file_path": u.locations[0].path}
  kind "search": return "Grep",  {"pattern": u.title}
  kind "fetch":  return "WebFetch", {"url": u.rawInput.url}
  default:       return u.title, u.rawInput
resultText(u): rawOutput.stdout (plus stderr when non-empty) for execute; else the text of u.content[*]; else ""
```

So a Cursor board edit gives the same `mcp__board__apply` card, with the same label and result, as
Claude's (feature: *the results, the tool cards and the edits on the board are the same*).

`onRequest(id, method, params)`:

```
if method != "session/request_permission": conn.Reply(id, nil, {code:-32601, message:"method not found"}); return
tc := params.toolCall
cmd := tc.rawInput.command or title without backticks
allowOpt := option with kind "allow_once"; rejectOpt := option with kind "reject_once"
if p.o.Board != nil:
   if tok, _, _, ok := boardtools.ParseCommand(cmd); ok && tok == p.o.Board.Token:
       conn.Reply(id, {outcome:{outcome:"selected", optionId: allowOpt}}); return     // board commands never ask
if agent.TouchesAppDir(raw params, s.AppRoot, s.Home):
   conn.Reply(id, {outcome:{outcome:"selected", optionId: rejectOpt}}); return
rid := "p" + counter
p.perms.Store(rid, {id, allowOpt, rejectOpt})
name, input := normalizeTool(tc)
p.events <- EvPermRequest{PermID: rid, ToolName: name, ToolID: tc.toolCallId, Input: input}
```

**Resolved (open problem 3):** Cursor's board commands are allowed for board chats without widening
anything: the server answers Cursor's own permission request for a command that is exactly a board
command with that chat's token, and nothing else. If the user's Cursor settings already allow the
command, no request arrives and nothing is needed.

`Decide(rid, allow)`: `conn.Reply(jsonrpcID, {outcome:{outcome:"selected", optionId: allow ? allowOpt : rejectOpt}})`.

`Close`: close stdin, kill after 3 s.

Usage: ACP reports no tokens (research: every `session/prompt` result is only
`{stopReason}`, and Cursor never sends `usage_update`). The context meter reads Cursor's own session store instead
(`internal/cursor/ctxusage.go`, below).

**Resolved (context meter):** the Cursor context meter comes **only** from Cursor's session store,
read with `sqlite3`. The app never estimates context from the streamed text: a count from the
stream misses Cursor's fixed ~16k tokens (system prompt, tools, skills) and goes wrong after
Cursor compacts the conversation (research: `cursor-context-usage.md`). If the store cannot be
read, the meter shows an error in its place; it never falls back to a guess.

`internal/cursor/ctxusage.go`:

```go
// ContextUsage is ConversationStateStructure.token_details of a session's latest root blob.
type ContextUsage struct{ Used, Max int }

// StorePath is where `agent acp` keeps a session:
// $CURSOR_CONFIG_DIR/acp-sessions/<id>/store.db when that variable is set in the server's
// environment (the agent gets the same environment), else <home>/.cursor/acp-sessions/<id>/store.db.
// <id> is the ACP sessionId from session/new (ChatMeta.SessionID).
func StorePath(home, sessionID string) string

// ReadContextUsage reads the store with the sqlite3 CLI. Every failure is an error whose text is
// shown in the meter; there is no fallback.
func ReadContextUsage(sqlite, home, sessionID string) (ContextUsage, error)

type ctxPoller struct{ … } // a 1 s ticker goroutine; at most one read at a time (a tick is skipped while one runs)
func (p *proc) readCtx()   // ReadContextUsage → p.events <- EvUsage{CtxIn: Used, CtxWindow: Max}
                           //                 or p.events <- EvUsage{CtxError: err text}
                           // during polling, an event is sent only when the result changed
```

The store is a SQLite database with two tables: `meta(key TEXT PRIMARY KEY, value TEXT)` and
`blobs(id TEXT PRIMARY KEY, data BLOB)`. It is created by the session's first `session/prompt`.
`ReadContextUsage` runs two queries, each as its own process with a 2 s timeout:

```
db := StorePath(home, sessionID)
if stat(db) fails: return error "Cursor session store not found"

1. exec sqlite3 <db> "SELECT value FROM meta WHERE key = '0';"
   stdout (trimmed) is the hex encoding of a JSON object; hex-decode it, parse it, take
   latestRootBlobId. It must match ^[0-9a-f]{64}$ before it goes into query 2.
2. exec sqlite3 <db> "SELECT hex(data) FROM blobs WHERE id = '<latestRootBlobId>';"
   stdout (trimmed) is the hex of a protobuf message ConversationStateStructure; hex-decode it.

decode (protobuf wire format, a small hand-written reader; no .proto files):
   token_details := the first field 5 of wire type 2 (bytes) in the root blob
   Used := token_details field 1 (varint, used_tokens)
   Max  := token_details field 2 (varint, max_tokens: the context window of the session's model)
```

- `sqlite3` is run **without** `-readonly`: in WAL mode a read-only open fails once the agent has
  exited, because SQLite cannot create the `-shm` file. Only `SELECT`s are ever sent.
- `sqlite3` comes from `Spawner.SQLite` (default `"sqlite3"`, found on `PATH`; macOS ships
  `/usr/bin/sqlite3`). No Go SQLite driver is used, so the server keeps to the standard library.
- The store is read after `session/load`, every second while a turn runs, and once after every
  `session/prompt` response (end, cancel or error). It is not read between `session/new` and the
  first prompt, since the store does not exist yet; the meter stays empty until then.

Errors (the text becomes `Usage.CtxError`, shown in the meter):

| failure | `CtxError` |
|---|---|
| `sqlite3` not found (`exec.ErrNotFound`) | `sqlite3 not found; the context meter needs it` |
| `store.db` missing | `Cursor session store not found` |
| `sqlite3` exits non-zero or times out | `Cannot read Cursor session store: <first line of stderr, or "timed out">` |
| no `meta` row, bad hex, bad JSON, bad blob id, no blob row | `Cursor session store has an unexpected format` |
| no field 5, or `Used` or `Max` is 0 | `Cursor session store has an unexpected format` |

The format is Cursor's own and undocumented, so a Cursor update can change it. Then the meter
shows the format error until this reader is updated.

`internal/cursor/catalog.go`:

```go
// ParseCatalog reads session/new's result. The "model" config option's values look like
// "gpt-5.4-mini[reasoning=medium]"; models.availableModels gives display names.
func ParseCatalog(res json.RawMessage) *model.Catalog

// ValueFor picks the exact option value for a base model and effort.
func ValueFor(c *model.Catalog, base, effort string) string

// split("gpt-5.4-mini[reasoning=medium]") → ("gpt-5.4-mini", map{"reasoning":"medium"})
func split(v string) (string, map[string]string)
```

```
ParseCatalog:
  opt := configOptions[*] where id == "model"; values := opt.options[*].value (fallback: models.availableModels[*].modelId)
  names := models.availableModels: modelId → name
  for v in values: base, params := split(v); add base once (Label: names[v] or names[base] or base,
                   stripping a trailing reasoning word from the label); e := effortOf(params): the first non-empty of
                   params.reasoning, params.reasoning_effort, params.effort (Cursor's name varies by model;
                   `thinking` is not an effort); if e: add to base.Efforts
  Default: split(opt.currentValue or models.currentModelId) → {Model: base, Effort: effortOf(params)}
  Values = values
ValueFor:
  first v in c.Values with split(v).base == base and effortOf(params) == effort
  else first v with that base; else ""
```

Catalogs are stored in `state.json` (`cursorCatalog`) whenever a new one arrives, and sent to the
client (`catalog` event), so the pickers can list Cursor's models without a running agent.

Since no agent starts before a chat's first message, the server fetches the list itself at start
(`internal/cursor/probe.go`):

```go
// Catalog runs a short-lived `agent acp` in os.TempDir() only to read the model list.
func (s *Spawner) Catalog(timeout time.Duration) (*model.Catalog, error)
```

```
conn := Start(s.Bin, ["acp"], os.TempDir()); defer close stdin, kill after 3 s
initialize (as in handshake); authenticate {methodId: "cursor_login"}
res := session/new {cwd: os.TempDir(), mcpServers: []}   // no prompt is sent
cat := ParseCatalog(res); nil → error "Cursor reported no models"
whole call bounded by timeout (20 s)
```

`main` runs it in the background after `cm.Load()`; on success `Store.Update(s.Cursor = cat)` and
`Bridge.Broadcast({type:"catalog", agent:"cursor", catalog})`; on failure (Cursor missing, not logged
in, timeout) it logs and the last stored catalog stays. Until a catalog exists (first run, fetch not
done) the Cursor pickers show "Loading models…".

**Resolved:** `session/new` is the only way to get the model values ACP accepts (`agent models`
uses a different id syntax, research *Model*). The fetch leaves one unused session in
`~/.cursor/acp-sessions` per server start; that is accepted. It never calls `set_config_option`,
so it does not change the user's default Cursor model.

`internal/cursor/config.go`:

```go
// EnsureDenyRules adds deny rules for the app's folder to the user's Cursor CLI config
// (~/.cursor/cli-config.json, or $CURSOR_CONFIG_DIR/cli-config.json), keeping every other key.
func EnsureDenyRules(root string) error
```

```
path := cursor config file; b, err := ReadFile; not exist → return nil (Cursor not set up; nothing to add)
var cfg map[string]any; json.Unmarshal (error → return err, never overwrite)
perms := cfg["permissions"] as map (create {"allow": [], "deny": []} if missing; "deny" must exist — research gotcha)
rules := ["Read(" + root + "/**)", "Write(" + root + "/**)"]
add each rule not already in perms.deny; if nothing added → return nil
WriteFileAtomic(path, indented JSON, original file mode)
```

**Resolved (feature: the app blocks agents' file and shell access to `~/.ai-whiteboard` for every
chat):** Cursor runs with the user's own settings and nothing may be written into the chat's folder,
so the only place for Cursor deny rules is the user's global Cursor config. The server adds the two
rules once at start. This only narrows what Cursor may do. Shell access is guarded by the
permission handler above (`TouchesAppDir`) and by the instructions (feature, open problem 4).

### 4.7 The chat manager: `internal/chats/`

From the prototype's `Chats` and `Chat` (`chats.go`).

```go
type Deps struct {
	Store      *store.Store
	Bridge     *editorbridge.Bridge
	Boards     *boards.Service
	Spawners   map[model.AgentKind]agent.Spawner
	Namer      Namer
	DefaultCwd string
	BaseURL    string // http://127.0.0.1:<port>
}

type Manager struct {
	Deps
	mu    sync.Mutex
	chats map[string]*Chat
}

type Chat struct {
	mu      sync.Mutex
	meta    model.ChatMeta
	tr      *transcript.Transcript // nil until first needed (see "Loading transcripts lazily")
	ag      agent.Agent // nil when no process
	gen     int         // bumped on every spawn; events of an older process are dropped
	errText string
	folderMissing bool
	interrupted   bool // TurnActive was true at boot; the "Stopped" note is added when tr loads
}

var (
	ErrNotFound      = errors.New("no such chat")
	ErrArchived      = errors.New("the chat is archived")
	ErrLocked        = errors.New("folder, model and effort are fixed once the chat has started")
	ErrFolderMissing = agent.ErrFolderMissing
	ErrAppFolder     = errors.New("the app's own folder can't be used as a working folder")
	ErrBusy          = errors.New("the agent is still working; wait for it to finish or stop it")
)

func New(d Deps) *Manager
func (m *Manager) Load() error
func (m *Manager) Views() []model.ChatView
func (m *Manager) View(id string) (model.ChatView, error)
func (m *Manager) Items(id string) (int, []model.Item, error)
func (m *Manager) Create(a model.AgentKind, group, board string) (model.ChatView, error)
func (m *Manager) Open(id string) error
func (m *Manager) Send(id, text, context string) error
func (m *Manager) Configure(id string, c ConfigReq) error
func (m *Manager) Rename(id, name string, byUser bool) error
func (m *Manager) Interrupt(id string) error
func (m *Manager) Decide(id, requestID string, allow bool) error
func (m *Manager) Move(id, group string) error
func (m *Manager) Stop(id string)
func (m *Manager) SetArchive(id string, a model.Archive) error
func (m *Manager) Delete(id string) error
func (m *Manager) ByToken(token string) (model.ChatMeta, bool)
func (m *Manager) ChatsOfBoard(boardID string) []model.ChatMeta
func (m *Manager) GroupOf(meta model.ChatMeta) string
func (m *Manager) Busy(id string) bool
func (m *Manager) Shutdown()

type ConfigReq struct {
	Model, Effort, Cwd string // empty = unchanged
}
```

Emitting: every change calls

```
emitChat(c):  bridge.Broadcast({type:"chat", chat: view(c)})
emitItems(c, ups): if len(ups) > 0 { bridge.Broadcast({type:"chat_items", chat: id, version: tr.Version(), updates: ups}) }
save(c):      WriteJSONAtomic(ChatDir/chat.json, c.meta, 0600)
```

`Load` (server start):

```
for dir in P.Chats: meta := read chat.json                   // items.jsonl is not read here
  c := &Chat{meta: meta, tr: nil, interrupted: meta.TurnActive}   // mid-turn when the server stopped
  register
```

**Loading transcripts lazily.** Boot reads only `chat.json` for every chat; `items.jsonl` is read
the first time a chat's history is needed, and the transcript then stays in memory until the server
stops. Every place below that uses `c.tr` goes through one helper (with `c.mu` held):

```
trOf(c):
  if c.tr != nil → return c.tr
  c.tr, err = transcript.Load(ChatDir/items.jsonl); if err → return
  if c.interrupted:
     c.interrupted = false; c.meta.TurnActive = false
     c.tr.AddNote("error", "Stopped: the app was closed while the agent was working.")
     c.tr.SetStatus(stopped); c.tr.Flush(false); save; emitItems; emitChat
  return c.tr
```

- Callers that load: `Items`, `Open`, `Send` (through `spawn`), `Configure` (folder fix), `Decide`,
  and `pump` (always already loaded, since only `Send` spawns). A load error is returned to the
  caller (HTTP 500) and the chat shows status error with the message.
- Callers that skip an unloaded chat: `Shutdown` touches `tr` only when it is non-nil, and `Stop`
  too unless `c.interrupted` (then it calls `trOf`, so archiving or deleting such a chat still
  records the note). An unloaded chat has no agent, no open items and nothing unflushed, so there is
  nothing to stop, decide or write. An interrupted chat never opened keeps `TurnActive = true` on
  disk through shutdown and is found again on the next boot.
- `view(c)` for an unloaded chat uses no tool and status `stopped` if `c.interrupted`, else `ready`
  (without an agent it cannot be busy). The sidebar shows Stopped before the history is read.
- Chats created in this run start with an empty in-memory transcript (`Create`), so they never load.

**Resolved (lazy load):** the first draft loaded every transcript at boot and kept all of them in
memory, including archived chats. Start time and memory then grow with the total history, although
the user reads one chat at a time. Metadata stays eager, because the sidebar, grouping, `ByToken` and
`ChatsOfBoard` need every chat's `ChatMeta`. Transcripts are never unloaded: one opened chat costs
what it did before, and unloading would need to be coordinated with running agents. A chat stopped
mid-turn is only marked at boot (`interrupted`, from `TurnActive` in `chat.json`); its note is
written when its history first loads, so boot never reads `items.jsonl`.

`Create(a, group, board)`:

```
if board != "": bd := Boards.Get(board) (must exist, not archived); group = bd.Group
else: check group exists (or Ungrouped)
var cat *model.Catalog = claude.Catalog or state.Cursor
cwd, mc := defaults.Resolve(state.Defaults, group, a, DefaultCwd, cat)
meta := ChatMeta{ID: uuid(), Agent: a, Group: group (plain only), Board: board, Cwd: cwd,
                 Model: mc.Model, Effort: mc.Effort, Created: now}
if board != "": meta.Token = 32 random hex chars
if a == Claude: meta.SessionID = uuid()
mkdir ChatDir; save; tr := empty transcript; register
emitChat
return view                         // no agent yet: it starts on the first Send
```

`spawn(c)` (with `c.mu` held):

```
if c.meta.Archived → return ErrArchived
if c.ag != nil → return nil
opts := SpawnOptions{ChatID, SessionID: c.meta.SessionID, Resume: c.meta.Locked, Cwd, Model, Effort}
if c.meta.Agent == Cursor && !c.meta.Locked { opts.SessionID = "" }
if c.meta.Board != "": opts.Board = &BoardAccess{MCPURL: BaseURL+"/mcp/"+Token, CommandURL: BaseURL+"/agent/"+Token, Token}
ag, err := Spawners[agent].Spawn(opts)
if errors.Is(err, ErrFolderMissing):
   c.folderMissing = true; c.errText = "Folder not found: "+Cwd+". Pick another folder to continue."
   tr.SetStatus(error); emitChat; return err
if err: c.errText = err.Error(); tr.SetStatus(error); emitChat; return err
c.folderMissing = false; c.errText = ""
c.gen++; c.ag = ag; go m.pump(c, ag, c.gen)
```

`pump(c, ag, gen)`:

```
for ev := range ag.Events():
  c.mu.Lock()
  if gen != c.gen { c.mu.Unlock(); continue }          // replaced by Stop
  switch ev.Kind:
   EvSession: c.meta.SessionID = ev.SessionID; save
   EvCatalog: Store.Update(s.Cursor = ev.Catalog); Bridge.Broadcast({type:"catalog", agent:"cursor", catalog})
   EvUsage:   if ev.CtxError != "": c.meta.Usage.CtxError = ev.CtxError       // numbers keep their last good values
              else: apply non-zero fields to c.meta.Usage (CtxIn/CtxOut/CtxWindow); c.meta.Usage.CtxError = ""
   EvTurnEnd: c.meta.Usage.Turns++
              c.meta.TurnActive = false
   EvExit:    c.ag = nil
  ups := c.tr.Apply(ev)
  if ev.Kind in {EvTurnEnd, EvToolResult, EvToolDenied, EvExit, EvSession}: c.tr.Flush(false); save
  c.mu.Unlock()
  emitItems(c, ups); emitChat(c) when status, usage or meta changed
```

`Open(id)` (the client selected the chat) never starts an agent, so the user can read an old
chat's history without one running. It only checks the folder: if the chat is locked, not
archived, `c.ag == nil` and `os.Stat(c.meta.Cwd)` fails, set `folderMissing`, `errText` and status
error as `spawn` does, and emit, so the missing folder shows before the user types.

**Resolved (agents start on the first message):** `Create`, `Open` and `Configure` never spawn.
The only caller of `spawn` is `Send`, which starts a new session on a chat's first message and
resumes it on any later message after the process has gone (restart, Stop, exit). The first reply
pays for the agent's start (Cursor: `session/new` plus `set_config_option`, a few seconds); in
exchange, picker changes cost nothing, no unused sessions are created, and opening a chat only reads.

`Send(id, text, context)`:

```
c.mu.Lock()
if Archived → ErrArchived
if busy(c) → ErrBusy                                      // one turn at a time; nothing is queued or written
if err := spawn(c); err != nil → return err            // resume if needed; 409 for folder missing
first := !c.meta.Locked
if first: Store.Update(defaults.RecordChange(&s.Defaults, GroupOf(meta), agent, meta.Cwd, {meta.Model, meta.Effort})); queue {type:"defaults"}
c.meta.Locked = true; c.meta.TurnActive = true
blocks := []
if c.meta.Board != "":
   if c.meta.Agent == Cursor:
      if !c.meta.InstructionsSent { blocks += prompts.CursorInstructions(); c.meta.InstructionsSent = true }
      blocks += "<board-api>" + BaseURL + "/agent/" + Token + "</board-api>"
   if context != "": blocks += context
else:
   context = ""                                          // plain chats never get board context
blocks += text
ups := c.tr.AddUser(text, context); c.tr.Flush(false); save
name := c.meta.Name; userNamed := c.meta.UserNamed
ag := c.ag
c.mu.Unlock()
emitItems; emitChat
if first && name == "" && !userNamed { go func(){ if t, err := Namer.Name(text); err == nil { m.Rename(id, t, false) } }() }
return ag.Send(blocks)
```

A Claude chat's session id is made in `Create` and first used by the first `Send`
(`--session-id`). From then on it is fixed and every later spawn resumes it.

`Configure(id, c)`:

```
lock
if Archived → ErrArchived
onlyFolderFix := c.meta.Locked && c.folderMissing && c.Model == "" && c.Effort == "" && c.Cwd != ""
if c.meta.Locked && !onlyFolderFix → ErrLocked
if c.Cwd != "": abs := expandDir(c.Cwd) (prototype); if P.Contains(abs) → ErrAppFolder; c.meta.Cwd = abs
if c.Model != "": validate against the catalog; c.meta.Model = c.Model; if the model has no efforts: c.meta.Effort = ""
if c.Effort != "": validate; c.meta.Effort = c.Effort
if c.Cwd != "" && c.folderMissing: c.folderMissing = false; c.errText = ""; tr.SetStatus(ready)
save                                                    // no agent runs before the first Send: nothing to restart
Store.Update(defaults.RecordChange(&s.Defaults, GroupOf(meta), agent, c.Cwd, {c.Model, c.Effort}))
unlock; emitChat; Bridge.Broadcast({type:"defaults", defaults})
```

`Rename(id, name, byUser)` — the prototype's `Rename`: an auto name never overwrites a user's name;
`UserNamed` is persisted.

`Decide(id, rid, allow)`: `c.ag.Decide(rid, allow)`; `ups := c.tr.Decided(rid, allow)`; flush;
emit.

`Stop(id)` (archive, delete, board delete, shutdown of one chat):

```
lock
for each undecided perm item: c.ag.Decide(requestID, false) (errors ignored); tr.Decided(requestID, false)
if c.ag != nil { c.gen++; c.ag.Interrupt(); c.ag.Close(); c.ag = nil }
if busy: tr.AddNote("muted", "Stopped.")
c.meta.TurnActive = false; tr.SetStatus(ready); tr.Flush(false); save
unlock; emit
```

(Feature: archiving a chat stops its agent, and any approval it was waiting on is answered "no".)

`Move(id, group)`: plain chats only (`Board == ""`, else error); group must exist; `meta.Group =
group`; save; emit. Settings are unchanged (feature: *moving a chat doesn't change its settings*).

`SetArchive(id, a)`: `meta.Archive = a`; save; emit.

`Delete(id)`: `Stop(id)`; remove from the map; `os.RemoveAll(ChatDir(id))`; broadcast
`{type:"chat_removed", id}`. The agent's own session files (`~/.claude/projects/…`,
`~/.cursor/acp-sessions/…`) belong to the agent CLIs and are left alone; the chat and its history in
the app are gone.

`Busy(id)`: status is thinking, writing, tool or approval. `busy(c)` is the same check with `c.mu`
held; an unloaded chat is never busy (it has no agent).

**Resolved (no send while busy):** a message sent while the agent is still working is refused with
`ErrBusy` (409); it is not queued. Claude's CLI and Cursor's ACP would each handle a second turn
mid-turn differently (Cursor's is undefined), and the first `EvTurnEnd` would clear `TurnActive`
while the second turn still runs. The client greys out send while the chat is busy (section 5.7);
the server check covers a stale client. To send now, the user stops the agent first.

`GroupOf(meta)`: the board's group for board chats, else `meta.Group`.

`Shutdown()`: for every chat: lock; if `tr != nil`: `tr.Flush(true)`; save (a running turn keeps `TurnActive =
true`, so it shows as Stopped next time); `ag.Close()` without waiting.

`internal/chats/namer.go` (the prototype's `autoName`, unchanged in behaviour):

```go
type Namer interface{ Name(firstMessage string) (string, error) }

type ClaudeNamer struct{ Bin string }

func (n ClaudeNamer) Name(text string) (string, error)
```

Runs `claude -p --model haiku --no-session-persistence --tools "" --strict-mcp-config
--setting-sources "" --disable-slash-commands --system-prompt <prototype text> <request>` in
`os.TempDir()`, keeps the first line, trims quotes and `Title:`, rejects empty or over 60
characters. It names Claude and Cursor chats alike. If `claude` is missing, the error is ignored and
the row keeps showing the first message.

### 4.8 Prompts: `internal/prompts/`

`whiteboard.md` is one text with two placeholders, `{{ACCESS}}` and `{{TOOLS}}`. It replaces the
prototype's `prompt-append.md` and variant 4's `boardNote`.

```markdown
# AI Whiteboard

You are running inside AI Whiteboard, a local app where the user keeps Excalidraw whiteboards and
chats with coding agents. This chat belongs to one whiteboard. You keep every ability you normally
have; in addition you can read and edit whiteboards {{ACCESS}}. The user reads your replies in a
narrow panel beside the board, so keep them short and plain.

## Your board

Every user message starts with a `<ui-context>` block written by the app, not by the user. It names
`active_board` (this chat's board), `referenced_boards` (boards the user pointed at with @name),
each as `name (id)`,
what the user has selected, and the visible area. "The board", "this", "here" and "the diagram" mean
the active board. Work on it unless the user points at another board with @name. Never quote the
block back.

Don't create boards or switch the user's view (`show_board`) unless the user asks. A board you
create goes into the same group as your board, with no chats of its own; keep working on it with its
id. The board tools take board ids only. Board names are not unique: when the user names a board
you have no id for, call `list_boards` first; if several share the name, pick by group or ask.

## Working on a board

1. Read before you write: `read_board` for each board you will touch; `get_view` for a fresher
   selection and viewport.
2. One `apply` call per coherent change: it is one undo step for the user. Give every element you
   create a short, stable `key` (e.g. `api`, `db`, `api-db`) and refer to your own elements by key.
   Refer to the user's elements by their full `id`.
3. Layout: place new things in empty space near what they relate to, never on top of existing
   elements. Leave 60–100px gaps; a typical box is 160×70; align rows and columns. Arrows connect
   with `start`/`end` refs and route themselves. One arrow per relationship: never two arrows between
   the same pair; describe a two-way flow in one label like "HTTP / JSON". Arrow labels are one or
   two words, only when they add meaning.
4. Style: draw clean, technical diagrams unless the user asks for another look.
   - Sharp corners and sharp, straight arrows: leave `roundness` unset or `"sharp"`.
   - The lowest sloppiness: leave `roughness` unset or `0`.
   - The normal font: leave `fontFamily` unset or `"normal"`; never `"hand"` unless asked.
   - No fill by default; soft colours (`#a5d8ff`, `#b2f2bb`, `#ffec99`, `#ffc9c9`, `#d0bfff`) with
     `fillStyle: "solid"` only when grouping or highlighting helps.
   This holds on boards drawn by hand too: what you add is clean unless the user says otherwise.
   Don't restyle existing elements unless asked.
5. The user draws at the same time as you. Never move, restyle or delete what the user drew unless
   they asked. If `apply` reports conflicts, re-read and try again, or tell the user.
6. `delete_elements` removes elements; give a short `reason`.
7. If a board tool says the board isn't open, stop working on the board and tell the user in one
   sentence that the AI Whiteboard window must be open for board work.

## The app's own files

AI Whiteboard keeps its boards and chats in `~/.ai-whiteboard`. Never read, list, write or run
anything in that folder, by any means: no file tools, no shell commands, no scripts, no symlinks.
Only the board tools touch boards.

After a board edit, say in a sentence or two what you changed.

{{TOOLS}}
```

```go
//go:embed whiteboard.md
var whiteboard string

// Claude is the --append-system-prompt text for Claude board chats.
func Claude() string // ACCESS = "with the `board` MCP tools", TOOLS = ""

// CursorInstructions is the first-message block for Cursor board chats.
func CursorInstructions() string // "<whiteboard-instructions>\n" + text + "\n</whiteboard-instructions>"
                                 // ACCESS = "by running board commands", TOOLS = cursorTools()
```

`cursorTools()` renders a section from `boardtools.Tools` (so both agents get the same tool list):

```markdown
## How to call the board tools

You have no board MCP server. Call a board tool by running exactly this shell command, with the
tool's arguments as JSON between the markers, and nothing else in the command:

    curl -s --data-binary @- <BOARD_API>/<tool> <<'JSON'
    {"board": "b_x7k2m9qa", "create": [ … ]}
    JSON

`<BOARD_API>` is the URL in the `<board-api>` block of the latest message. Run one tool per command.
Never chain commands with `;`, `&&` or `|`, and never add flags. The command prints the result.

Tools (name — arguments — what it does):
- list_boards — {} — …                    (one line per boardtools.Tools entry: name, schema summary, description)
- …
```

### 4.9 The editor bridge: `internal/editorbridge/bridge.go`

From the prototype's `hub.go`, changed to one active client with takeover (feature: *One client at
a time*). This fixes the prototype bug where every open tab answered board calls.

```go
type Bridge struct {
	mu       sync.Mutex
	active   *client
	pending  *client
	rpcs     sync.Map // rpc id → *call
	seq      atomic.Int64
	snapshot func() any // the full state for a newly active client
	flushed  chan struct{}
	handover *time.Timer
}

type client struct {
	id   string
	ch   chan []byte   // buffered 4096
	done chan struct{} // closed to end its SSE stream
}

type call struct {
	client string
	reply  chan RPCReply
}

type RPCReply struct {
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

var ErrNoClient = errors.New("the board isn't open: the AI Whiteboard window is closed")

func New(snapshot func() any) *Bridge
func (b *Bridge) ServeSSE(w http.ResponseWriter, r *http.Request) // GET /api/events?client=<id>
func (b *Bridge) Release(clientID string)                          // POST /api/client/release
func (b *Bridge) IsActive(clientID string) bool
func (b *Bridge) Broadcast(ev any)                                 // to the active client only
func (b *Bridge) Call(method string, params any, timeout time.Duration) (json.RawMessage, error)
func (b *Bridge) Reply(id string, r RPCReply)
func (b *Bridge) StopAndFlush(timeout time.Duration)               // server shutdown
func (b *Bridge) Flushed()                                          // POST /api/client/flushed
```

`ServeSSE`:

```
id := r.URL.Query().Get("client"); require non-empty
c := &client{id, make(chan []byte, 4096), make(chan struct{})}
b.mu.Lock()
switch:
 b.active == nil:
    b.active = c; send(c, {type:"hello", active:true}); send(c, {type:"snapshot", ...b.snapshot()})
 b.active.id == id:                                     // the same tab reconnecting
    close(b.active.done); b.active = c; hello(active) + snapshot
 default:                                               // another tab: take over
    if b.pending != nil { send(b.pending, {type:"superseded"}); close(b.pending.done) }
    b.pending = c; send(c, {type:"hello", active:false, waiting:true})
    send(b.active, {type:"release_request"})
    b.handover = time.AfterFunc(3s, b.promote)
b.mu.Unlock()
stream loop (prototype): write "data: …\n\n" for each message; ": ping" every 20 s;
  return on r.Context().Done() or c.done
on return (under lock):
  if b.active == c: b.active = nil; failCalls(c.id); if b.pending != nil { promoteLocked() }
  if b.pending == c: b.pending = nil
```

`promote` (under lock): if `b.pending == nil` return; `old := b.active`; if `old != nil { send(old,
{type:"superseded"}); failCalls(old.id); close(old.done) }`; `b.active = b.pending; b.pending = nil`;
hello(active) + snapshot to the new one.

`Release(id)`: under lock, if `b.active != nil && b.active.id == id && b.pending != nil` → stop the
timer and promote.

`Broadcast(ev)`: marshal once; send to `b.active` only; never block (a full buffer drops the message
and closes the stream, so the client reconnects and gets a fresh snapshot).

`Call` (prototype `Call`, to the active client only):

```
b.mu.Lock(); c := b.active; b.mu.Unlock()
if c == nil → ErrNoClient
id := "rpc_" + seq; k := &call{client: c.id, reply: make(chan, 1)}; b.rpcs.Store(id, k); defer Delete
send(c, {type:"rpc", id, method, params})
select reply → error string → errors.New; result → result
       timeout → fmt.Errorf("the board did not answer %s in %s", method, timeout)
failCalls(clientID): every call of that client gets RPCReply{Error: ErrNoClient.Error()}
```

`StopAndFlush(timeout)`: broadcast `{type:"server_stopping"}`; wait for `Flushed()` or the timeout.

**Resolved (feature: a second tab can take over, and the first saves its pending changes first):**
the newest tab always takes over. The old tab gets `release_request`, writes its pending saves, then
calls `POST /api/client/release`; if it does not answer within 3 s it is cut off anyway. "Take it
back" in the old tab simply reconnects, which is a takeover the other way.

### 4.10 The board API for agents: `internal/boardtools/` and `internal/boardapi/`

**Resolved (package split):** the tool list and the command parser live in their own package,
`internal/boardtools`, which imports nothing from this project. The Claude and Cursor adapters and
`prompts` import `boardtools`; `boardapi` imports `boardtools`, `chats`, `boards` and
`editorbridge`. This keeps the import graph acyclic (`chats` → `claude`/`cursor`/`prompts` →
`boardtools`, never back to `boardapi`).

`boardtools/tools.go` — the prototype's `mcpTools`, renamed from pages to boards (feature: *read a board, look
at the user's view and selection, edit, delete, and show a board*; *boards an agent creates*):

```go
type Tool struct {
	Name        string
	Description string
	Schema      map[string]any // JSON schema of the arguments
	Summary     string         // one-line argument summary for the Cursor instructions
}

var Tools = []Tool{
	{Name: "list_boards", Description: "List the whiteboards: name, id, group, which one is this chat's board and which one is on screen. Names are not unique; the other tools take the id."},
	{Name: "read_board", Description: "Read a board as text: one line per element with type, key, id, label, position/size, and for arrows what they connect.",
		Schema: obj(props{"board": str("board id (from list_boards or <ui-context>); omit for this chat's board")})},
	{Name: "get_view", Description: "What the user sees right now: the board on screen, the visible area and the selected elements."},
	{Name: "apply", Description: <prototype apply text> + " New elements default to sharp corners, roughness 0 and the normal font.",
		Schema: obj(props{"board": str(...), "create": arr(object), "update": arr(refObj)}) // create items also take roughness and fontFamily: hand|normal|code
	},
	{Name: "delete_elements", Description: "Delete elements from a board. cascade: also delete arrows bound to them.",
		Schema: obj(props{"board", "refs" (required), "cascade", "reason"})},
	{Name: "create_board", Description: "Create a new empty board in the same group as this chat's board. Only when the user asks for a new board. Returns its name and id.",
		Schema: obj(props{"name": str}, required "name")},
	{Name: "show_board", Description: "Bring a board to the user's screen and scroll to some elements. Only when the user asked to see something.",
		Schema: obj(props{"board", "refs"})},
}
```

**Resolved:** the prototype's tools took a required `page`. `board` is optional now and defaults to
the chat's own board, which fits "a board chat works on its own board unless the user points at
another". It is always a board id, never a name (names are not unique; see 4.1).

`Relay` — the one path from an agent to the client, shared by MCP and commands:

```go
type Relay struct {
	Bridge *editorbridge.Bridge
	Chats  *chats.Manager
	Boards *boards.Service
}

// Call runs a board tool for the chat with this token and returns the text for the agent.
// Errors come back as text too (isErr = true), so the agent can tell the user.
func (r *Relay) Call(token, tool string, args json.RawMessage) (text string, isErr bool)
```

```
meta, ok := Chats.ByToken(token); if !ok → ("unknown board token", true)
if meta.Archived → ("this chat is archived", true)
if tool not in boardtools.Tools → ("unknown tool "+tool, true)
bd, _ := Boards.Get(meta.Board)
out, err := Bridge.Call("tool", {chat: meta.ID, board: bd.ID, name: tool, args}, 30s)
if errors.Is(err, editorbridge.ErrNoClient) → ("The board isn't open: the AI Whiteboard window is closed. " +
      "Board work needs the window open. Tell the user, and don't retry until they ask again.", true)
if err → (err.Error(), true)
text := out as JSON string, else raw out
return text, false
```

`mcp.go` — the prototype's `mcp` handler at `POST /mcp/{token}`, unchanged in protocol (initialize
echoes `protocolVersion`, `tools/list`, `tools/call`, `ping`, 202 for notifications, 405 for GET,
-32601 for anything else), with `tools/call` going through `Relay.Call` and `isError` set from it.
`serverInfo.name` stays `"board"` so tool names stay `mcp__board__<tool>`.

`boardapi/command.go` — the Cursor command endpoint:

```go
// POST /agent/{token}/{tool}: the body is the JSON arguments. Always 200 with a text/plain body;
// errors start with "ERROR: " so the agent sees them in the command output.
func (r *Relay) ServeCommand(w http.ResponseWriter, req *http.Request)
```

`boardtools/command.go` — the Cursor command parser, used by the Cursor adapter (to show board
commands as board cards and allow them without asking) and by tests:

```go
// ParseCommand accepts exactly the form the instructions teach:
//   curl -s --data-binary @- http://127.0.0.1:<port>/agent/<token>/<tool> <<'JSON'
//   <json>
//   JSON
// and nothing else (no other flags, no chaining, one heredoc, valid JSON inside).
func ParseCommand(cmd string) (token, tool string, args json.RawMessage, ok bool)
```

```
ParseCommand:
  re := ^curl -s --data-binary @- http://127\.0\.0\.1:(\d+)/agent/([0-9a-f]{32})/([a-z_]+) <<'JSON'\n([\s\S]*?)\nJSON\s*$
  m := re.FindStringSubmatch(strings.TrimSpace(cmd)); no match → false
  tool must be in Tools; json.Valid(m[4]) else false
  the first line (before "<<'JSON'") must not contain any of ; & | ` $( > < (belt and braces)
  return m[2], m[3], m[4], true
```

### 4.11 App orchestration: `internal/app/app.go`

Groups, moves, and the archive / unarchive / delete cascades across boards and chats.

```go
type App struct {
	St     *store.Store
	Boards *boards.Service
	Chats  *chats.Manager
	Bridge *editorbridge.Bridge
}

type Snapshot struct {
	Groups     []model.Group            `json:"groups"`
	Boards     []model.Board            `json:"boards"`
	Chats      []model.ChatView         `json:"chats"`
	Defaults   model.Defaults           `json:"defaults"`
	Catalogs   map[model.AgentKind]*model.Catalog `json:"catalogs"`
	Home       string                   `json:"home"`
	DefaultCwd string                   `json:"defaultCwd"`
	DataDir    string                   `json:"dataDir"`
}

// Snapshot: groups, defaults and catalogs from the store; boards from Boards.List; chats from Chats.
func (a *App) Snapshot() Snapshot

func (a *App) CreateGroup(name string) (model.Group, error)
func (a *App) UpdateGroup(id string, name *string, collapsed *bool) error
func (a *App) ReorderGroups(ids []string) error
func (a *App) MoveBoard(id, group string) error
func (a *App) MoveChat(id, group string) error

type Kind string // "group" | "board" | "chat"

func (a *App) Archive(k Kind, id string) error
func (a *App) Unarchive(k Kind, id string) error
func (a *App) DeleteChat(id string) error
func (a *App) DeleteBoard(id string) error
func (a *App) DeleteGroup(id string, deleteContents bool) error
```

```
CreateGroup(name):
  g := Group{ID: newID("g_"), Name: name or "New group"}
  St.Update(append g; defaults.SeedGroup(&s.Defaults, g.ID))
  Bridge.Broadcast({type:"groups", groups}); Bridge.Broadcast({type:"defaults", ...}); return g

UpdateGroup: rename (trimmed, non-empty) / collapse; broadcast groups
ReorderGroups(ids): ids must be a permutation of the group ids; reorder; broadcast groups
MoveBoard: Boards.Move (its chats follow, since their group is the board's)
MoveChat:  Chats.Move

Archive(k, id):
  op := newID("a_"); ar := Archive{Archived: true, Op: op}
  chat:  Chats.Stop(id); Chats.SetArchive(id, ar)
  board: for c in Chats.ChatsOfBoard(id) where !c.Archived: Chats.Stop(c.ID); Chats.SetArchive(c.ID, ar)
         Boards.SetArchive(id, ar)
  group: for boards b in group where !b.Archived: archive b's chats and b with ar
         for plain chats c in group where !c.Archived: Stop + SetArchive(ar)
         St.Update(group.Archive = ar); broadcast groups

Unarchive(k, id):
  clear := Archive{}
  chat:  op := chat.Op; Chats.SetArchive(id, clear)
         if board chat and board archived: Boards.SetArchive(board, clear)           // board back, its other chats stay
         group := GroupOf(chat); if group archived: unarchive the group record only
  board: op := board.Op; Boards.SetArchive(id, clear)
         for c in ChatsOfBoard(id) where c.Op == op: Chats.SetArchive(c.ID, clear)   // what went with it
         if its group is archived: unarchive the group record only
  group: op := group.Op; group record cleared
         every board and chat in the group with Op == op: cleared
```

(Feature: unarchive puts the item back where it was; unarchiving a board chat whose board is
archived brings the board back too and leaves the board's other archived chats archived.)
**Resolved:** the definition does not say what unarchiving a board or a group brings back. The
archive op id answers it: exactly what was archived together with it comes back; items archived on
their own earlier stay archived.

```
DeleteChat(id): Chats.Delete(id)
DeleteBoard(id): for c in ChatsOfBoard(id): Chats.Delete(c.ID); Boards.Delete(id)
DeleteGroup(id, deleteContents):
  if deleteContents: every board in it → DeleteBoard; every plain chat → DeleteChat
  else: every board → Boards.Move(b, Ungrouped); every plain chat → Chats.Move(c, Ungrouped)
  St.Update(remove group; delete(s.Defaults.Groups, id)); broadcast groups
```

Agents on a board being archived or deleted are stopped by the cascade; the board keeps its last
saved edit (feature). Confirmations are asked by the client (section 5.8).

### 4.12 HTTP API: `internal/server/`

All bodies are JSON. Errors are `{"error": "..."}` with the status given. `{id}` is a board, chat or
group id. A `group` field in a body is a group id or `"__ungrouped__"` for the ungrouped area;
`""` is rejected (400).

| Method and path | Body → result | Notes |
|---|---|---|
| `GET /api/hello` | → `{app:"ai-whiteboard", version, pid}` | used by `main` to find a running server |
| `GET /api/events?client=<id>` | SSE | section 4.9 |
| `POST /api/client/release` | `{client}` | old tab has saved; hand over |
| `POST /api/client/flushed` | `{client}` | answer to `server_stopping` |
| `POST /api/rpc-reply` | `{id, result?, error?}` | answer to an `rpc` event |
| `GET /api/state` | → `Snapshot` | same as the `snapshot` event |
| `POST /api/groups` | `{name?}` → `Group` | |
| `PATCH /api/groups/{id}` | `{name?, collapsed?}` | |
| `PUT /api/groups/order` | `{ids}` | |
| `POST /api/groups/{id}/archive` / `unarchive` | | |
| `DELETE /api/groups/{id}?contents=delete\|ungroup` | | |
| `POST /api/boards` | `{name?, group, new?}` → `Board` | file written before the answer; `new` from `create_board` |
| `GET /api/boards/{id}/scene` | → the `.excalidraw` JSON | 404 when the board is unknown |
| `PUT /api/boards/{id}/scene` | the `.excalidraw` JSON | 409 when archived |
| `POST /api/boards/{id}/rename` | `{name}` → `Board` | names are not unique; never a clash |
| `PATCH /api/boards/{id}` | `{group}` | move |
| `POST /api/boards/{id}/seen` | | clears "new" |
| `POST /api/boards/{id}/archive` / `unarchive` | | |
| `DELETE /api/boards/{id}` | | file and all its chats |
| `POST /api/boards/{id}/reveal` | | `open -R` |
| `POST /api/chats` | `{agent, group?, board?}` → `ChatView` | sticky defaults applied |
| `GET /api/chats/{id}/items` | → `{version, items}` | |
| `POST /api/chats/{id}/open` | | checks the folder; never starts the agent |
| `GET /api/chats/{id}` | → `ChatView` | |
| `POST /api/chats/{id}/messages` | `{text, context}` | 409 archived, busy or folder missing |
| `PATCH /api/chats/{id}` | `{name?, model?, effort?, cwd?, group?}` | 409 locked; 400 bad folder |
| `POST /api/chats/{id}/interrupt` | | |
| `POST /api/chats/{id}/permission` | `{requestId, allow}` | |
| `POST /api/chats/{id}/archive` / `unarchive` | | |
| `DELETE /api/chats/{id}` | | |
| `GET /api/dirs?path=` | → `{path, parent, dirs, git}` | prototype, unchanged |
| `POST /mcp/{token}` | MCP JSON-RPC | Claude board tools |
| `POST /agent/{token}/{tool}` | JSON args → text | Cursor board commands |
| `GET /` and files | the built client | only when `-client` is set |

Server → client SSE events (`{type, …}`):

| type | fields |
|---|---|
| `hello` | `active`, `waiting` |
| `snapshot` | the `Snapshot` fields |
| `release_request`, `superseded`, `server_stopping` | — |
| `rpc` | `id`, `method: "tool"`, `params: {chat, board, name, args}` |
| `groups` | `groups` |
| `board` / `board_removed` | `board` / `id` |
| `chat` / `chat_removed` | `chat` (a `ChatView`) / `id` |
| `chat_items` | `chat`, `version`, `updates: [{index, item}]` |
| `defaults` | `defaults` |
| `catalog` | `agent`, `catalog` |

`server.go`:

```go
type Server struct {
	App    *app.App
	Relay  *boardapi.Relay
	Bridge *editorbridge.Bridge
	Client string // static client folder, "" = none
	Port   int
}

func (s *Server) Handler() http.Handler // builds the mux above, wrapped in guard()
```

Handlers are thin: decode (the prototype's `readJSON`), call `App` / `Chats` / `Boards`, encode
(the prototype's `writeJSON`). Error mapping: `ErrNotFound` → 404; `ErrArchived`, `ErrLocked`,
`ErrFolderMissing`, `ErrBusy` → 409; validation → 400; others → 500.

`guard.go`:

```go
// guard rejects requests that could come from a web page other than the client:
// - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding);
// - every /api request except GET and the /api/client/* and /api/rpc-reply routes must carry
//   X-AIWB-Client equal to the active client's id (409 {"error":"not_active"} otherwise).
//   A custom header also forces a CORS preflight, which the server never answers.
// /mcp and /agent are guarded by their token instead.
func guard(b *editorbridge.Bridge, port int, next http.Handler) http.Handler
```

`/api/client/*` and `/api/rpc-reply` check that the `client` in the body (or the header) is the
active or pending client.

### 4.13 Entry point: `cmd/ai-whiteboard/main.go`

```
flags:
  -port 4747            listen port
  -home ~/.ai-whiteboard data folder
  -client web/dist      built web client to serve ("" = serve none)
  -no-open              don't open the browser
  -cwd <start folder>   default working folder for new chats (the prototype's -cwd)
  -claude claude        Claude Code binary
  -cursor agent         Cursor agent binary
```

```go
func main() {
	parse flags; home, _ := os.UserHomeDir()
	p := store.NewPaths(expand(*homeFlag))
	if url, ok := findRunning(p, *port); ok {                 // "connects to the server already running"
		fmt.Println("AI Whiteboard is already running at", url)
		if !*noOpen { openBrowser(url) }
		return
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port)); fatal on error ("port in use by another program")
	port := actual port
	st := store.Open(p)
	var a *app.App
	br := editorbridge.New(func() any { return a.Snapshot() })
	bs := boards.New(st, br)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	cursorSpawner := &cursor.Spawner{Bin: *cursorBin, AppRoot: p.Root, Home: home}
	cm := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bs, DefaultCwd: *cwd, BaseURL: base,
		Namer: chats.ClaudeNamer{Bin: *claudeBin},
		Spawners: map[model.AgentKind]agent.Spawner{
			model.Claude: &claude.Spawner{Bin: *claudeBin, AppRoot: p.Root, Home: home, Prompt: prompts.Claude()},
			model.Cursor: cursorSpawner,
		}})
	bs.Load()                                                  // before chats: board chats look up their board
	cm.Load()
	go refreshCursorCatalog(cursorSpawner, st, br)             // Cursor model list for the pickers (4.6)
	a = &app.App{St: st, Boards: bs, Chats: cm, Bridge: br}
	if err := cursor.EnsureDenyRules(p.Root); err != nil { log.Printf("cursor deny rules: %v", err) }
	srv := &server.Server{App: a, Relay: &boardapi.Relay{Bridge: br, Chats: cm, Boards: bs}, Bridge: br, Client: *client, Port: port}
	store.WriteServerFile(p, port)
	go onSignal(SIGINT, SIGTERM, func() {
		br.StopAndFlush(2 * time.Second)                        // the client writes pending board changes
		cm.Shutdown()                                          // history written; agents end
		store.RemoveServerFile(p)
		os.Exit(0)
	})
	if *client != "" && !*noOpen { openBrowser(base + "/") }
	log.Printf("AI Whiteboard: %s  (data in %s)", base, p.Root)
	log.Fatal(http.Serve(ln, srv.Handler()))
}

// findRunning: read server.json (or try -port); GET http://127.0.0.1:<port>/api/hello with a 1 s timeout;
// ok when app == "ai-whiteboard". A stale server.json is ignored.
func findRunning(p store.Paths, port int) (string, bool)

// refreshCursorCatalog: cat, err := sp.Catalog(20 s); err → log only (the stored catalog stays);
// else st.Update(s.Cursor = cat) and br.Broadcast({type:"catalog", agent:"cursor", catalog: cat}).
func refreshCursorCatalog(sp *cursor.Spawner, st *store.Store, br *editorbridge.Bridge)

func openBrowser(url string) { exec.Command("open", url).Start() } // prototype
```

- Closing the tab does not stop the server; running chats keep working (feature, *Starting*).
- Stopping the server ends the agents; their chats resume later (section 4.7).
- **Resolved:** the feature says server and client are separate programs and the client is built
  separately. The server still serves the client's built folder as static files, so one command
  starts everything; the client uses only the API above, and `-client ""` runs the server on its
  own.

---

## 5. Client (`web/`)

### 5.1 Files and where they come from

| File | From | What changes |
|---|---|---|
| `main.tsx` | prototype `main.tsx` | renders `<App />`; calls `connect()`; no `loadWorkspace` |
| `types.ts` | new | mirror of `internal/model` |
| `api.ts` | prototype `conn.ts` `api` | every route of 4.12; sends `X-AIWB-Client` |
| `conn.ts` | prototype `conn.ts` | SSE with client id; hello/snapshot/takeover; `rpc` answers |
| `store.ts` | prototype `store.ts` | new state shape (5.3) |
| `board.ts` | prototype `board.ts` | board ids, autosave queue, tools renamed, archived checks |
| `apply.ts` | prototype | clean defaults (section 6) |
| `format.ts` | prototype | unchanged |
| `logic/labels.ts` | `ui.tsx` `genericTool`/`toolVerb`/`toolDone`/`statusText` | board wording |
| `logic/context.ts` | `board.ts` `buildContext` | DOM-free |
| `logic/tree.ts` | `v4.tsx` sidebar grouping | archived filtering |
| `logic/mentions.ts` | `ui.tsx` `resolvePage` and mention regex | board ids; picked mentions keep the id |
| `App.tsx` | `v4.tsx` `Grouped`, `BoardBar`, `Home` | |
| `Sidebar.tsx` | `v4.tsx` `Sidebar`, `GroupNode`, `BoardNode`, `ChatRow`, `DropZone`, `InlineName`, `AgentItems` | menus, archived view |
| `Canvas.tsx` | prototype `Canvas.tsx` | one board, style defaults, read-only |
| `ChatView.tsx` | `ui.tsx` `Thread`/`EmptyThread`/`ItemView`/`ToolCard`/`PermCard`/`Rich`, `v2.tsx` `ChatHeader`/`NameInput` | items from the server |
| `Composer.tsx` | `ui.tsx` `Composer`/`sendMessage`, `v2.tsx` `Toolbar`/`Picker`/`DirPicker`/`DirBrowser`/`ContextMeter` | catalogs from the server |
| `Dialogs.tsx` | new | `ConfirmDialog`, `TakeoverScreen` |
| `icons.tsx` | `ui.tsx` `AgentGlyph`; `v2.tsx`/`v4.tsx` icons | |

### 5.2 `api.ts` and `conn.ts`

```ts
// api.ts
export const clientId: string = crypto.randomUUID(); // one per tab load

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: { "Content-Type": "application/json", "X-AIWB-Client": clientId },
                                body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error);
  return r.status === 204 ? (undefined as T) : r.json();
}

export const api = {
  state: () => call<Snapshot>("GET", "/api/state"),
  release: () => call("POST", "/api/client/release", { client: clientId }),
  flushed: () => call("POST", "/api/client/flushed", { client: clientId }),
  rpcReply: (id: string, reply: { result?: unknown; error?: string }) => call("POST", "/api/rpc-reply", { id, ...reply }),
  newGroup: (name?: string) => call<Group>("POST", "/api/groups", { name }),
  updateGroup: (id: string, p: { name?: string; collapsed?: boolean }) => call("PATCH", `/api/groups/${id}`, p),
  reorderGroups: (ids: string[]) => call("PUT", "/api/groups/order", { ids }),
  archive: (k: "groups" | "boards" | "chats", id: string) => call("POST", `/api/${k}/${id}/archive`),
  unarchive: (k: "groups" | "boards" | "chats", id: string) => call("POST", `/api/${k}/${id}/unarchive`),
  deleteGroup: (id: string, contents: "delete" | "ungroup") => call("DELETE", `/api/groups/${id}?contents=${contents}`),
  newBoard: (group: string, name?: string, isNew = false) => call<Board>("POST", "/api/boards", { name, group, new: isNew }),
  scene: (id: string) => call<any>("GET", `/api/boards/${id}/scene`),
  saveScene: (id: string, scene: unknown) => call("PUT", `/api/boards/${id}/scene`, scene),
  renameBoard: (id: string, name: string) => call<Board>("POST", `/api/boards/${id}/rename`, { name }),
  moveBoard: (id: string, group: string) => call("PATCH", `/api/boards/${id}`, { group }),
  seenBoard: (id: string) => call("POST", `/api/boards/${id}/seen`),
  deleteBoard: (id: string) => call("DELETE", `/api/boards/${id}`),
  reveal: (id: string) => call("POST", `/api/boards/${id}/reveal`),
  newChat: (agent: AgentKind, where: { group: string } | { board: string }) => call<ChatView>("POST", "/api/chats", { agent, ...where }),
  items: (id: string) => call<{ version: number; items: Item[] }>("GET", `/api/chats/${id}/items`),
  chat: (id: string) => call<ChatView>("GET", `/api/chats/${id}`),
  openChat: (id: string) => call("POST", `/api/chats/${id}/open`),
  send: (id: string, text: string, context: string) => call("POST", `/api/chats/${id}/messages`, { text, context }),
  configure: (id: string, p: { model?: string; effort?: string; cwd?: string }) => call("PATCH", `/api/chats/${id}`, p),
  renameChat: (id: string, name: string) => call("PATCH", `/api/chats/${id}`, { name }),
  moveChat: (id: string, group: string) => call("PATCH", `/api/chats/${id}`, { group }),
  interrupt: (id: string) => call("POST", `/api/chats/${id}/interrupt`),
  decide: (id: string, requestId: string, allow: boolean) => call("POST", `/api/chats/${id}/permission`, { requestId, allow }),
  deleteChat: (id: string) => call("DELETE", `/api/chats/${id}`),
  dirs: (path: string) => call<{ path: string; parent: string; dirs: string[]; git: boolean }>("GET", `/api/dirs?path=${encodeURIComponent(path)}`),
};
```

```ts
// conn.ts
export function connect() {
  setState({ role: "connecting" });
  const es = new EventSource(`/api/events?client=${clientId}`);
  es.onerror = () => setState({ connected: false });           // EventSource reconnects by itself
  es.onmessage = (e) => handle(JSON.parse(e.data), es);
}

async function handle(m: any, es: EventSource) {
  switch (m.type) {
    case "hello": setState({ connected: true, role: m.active ? "active" : "waiting" }); return;
    case "snapshot": applySnapshot(m); return;
    case "release_request": await flushAll(); await api.release().catch(() => {}); return;
    case "superseded": es.close(); setState({ role: "superseded" }); return;   // TakeoverScreen
    case "server_stopping": await flushAll(); await api.flushed().catch(() => {}); return;
    case "rpc": return answer(m);
    case "groups": setState({ groups: m.groups }); return;
    case "board": upsertBoard(m.board); return;
    case "board_removed": removeBoard(m.id); return;
    case "chat": upsertChat(m.chat); return;
    case "chat_removed": removeChat(m.id); return;
    case "chat_items": applyItems(m.chat, m.version, m.updates); return;
    case "defaults": setState({ defaults: m.defaults }); return;
    case "catalog": setState((s) => ({ catalogs: { ...s.catalogs, [m.agent]: m.catalog } })); return;
  }
}

async function answer(m: any) {                                    // prototype answer()
  let reply;
  try {
    if (m.method !== "tool") throw new Error(`unknown method ${m.method}`);
    reply = { result: await runTool(m.params) };
  } catch (err: any) { reply = { error: `${err.code ? err.code + ": " : ""}${err.message ?? String(err)}` }; }
  await api.rpcReply(m.id, reply);
}

export function takeBack() { connect(); }                          // "Use here" button
```

`applyItems(chat, version, updates)`: if the chat's items are loaded and `version > loaded.version`,
set `items[u.index] = u.item` for each update and store `version`; otherwise ignore (the chat's items
are fetched in full when it is opened).

`loadItems(chat)`: `api.items(chat)` → store `{version, items}` (called by `select` when a chat is
shown). Updates that arrive during the fetch with a higher version are applied after it.

### 5.3 `store.ts`

The prototype's store mechanics (`getState`, `setState`, `useStore`, `safeGet`, `safeSet`, `flash`,
`unflash`, `markBusy`) are kept. The state becomes:

```ts
export type Sel = { board: string | null; chat: string | null }; // board id, chat id

export type State = {
  connected: boolean;
  role: "connecting" | "active" | "waiting" | "superseded";
  home: string; defaultCwd: string; dataDir: string;
  groups: Group[];
  boards: Record<string, Board>;
  chats: Record<string, ChatView>;
  items: Record<string, { version: number; items: Item[] }>;
  defaults: Defaults;
  catalogs: Partial<Record<AgentKind, Catalog>>;
  sel: Sel;                       // persisted in localStorage "aiwb.sel"
  panel: boolean;                 // board chat panel shown (⌘J)
  showArchived: boolean;          // persisted in localStorage "aiwb.archived"
  selection: Selection;           // prototype
  view: View;                     // prototype
  flashes: Flash[];               // prototype, keyed by board id
  busyOn: Record<string, { chat: string; agent: AgentKind; until: number }>; // by board id
  confirm: ConfirmRequest | null; // Dialogs.tsx
};
```

Removed from the prototype state: `dir`, `cwd`, `pages`, `tabs`, `active`, `unseen`, `chatOrder`,
`activeChat`, `sidebar`, `variant`, `layout`, `sel4`.

```ts
export function applySnapshot(s: Snapshot) // replaces groups, boards, chats, defaults, catalogs, home, …; drops sel entries that no longer exist
export function upsertBoard(b: Board)
export function removeBoard(id: string)      // clears sel.board, scenes, busyOn for it
export function upsertChat(c: ChatView)
export function removeChat(id: string)       // clears sel.chat and items
export const lastChat: { get(board: string): string | undefined; set(board: string, chat: string): void } // localStorage "aiwb.lastChat"
```

### 5.4 `board.ts`: scenes, autosave, board tools, context

Kept from the prototype: `scenes`, `liveApi`/`livePage` (renamed `liveBoard`), `toFmt`,
`selectionLines`, `engineFor`, `bbox`, `expandIds`, `afterEdit` (flash part), the cascade-label fix
in delete. Changed as follows.

```ts
export type Scene = { elements: El[]; appState: any; files: any; version: number; rev: number };
export const scenes = new Map<string, Scene>();   // key: board id

export async function loadScene(id: string): Promise<Scene>   // api.scene(id), restoreElements (prototype)
export function sceneChanged(id: string, elements: readonly El[], appState: any, files: any) // prototype; calls saveSoon(id)
```

Autosave (feature: debounced, around half a second; always written before close, rename, archive,
quit):

```ts
const SAVE_DEBOUNCE = 500;
type SaveState = { timer?: number; running?: Promise<void>; again?: boolean };
const saving = new Map<string, SaveState>();

export function saveSoon(id: string, ms = SAVE_DEBOUNCE) {
  const s = saving.get(id) ?? {}; saving.set(id, s);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { s.timer = undefined; void runSave(id); }, ms);
}

async function runSave(id: string) {                    // one write in flight per board, in order
  const s = saving.get(id)!;
  if (s.running) { s.again = true; return s.running; }
  s.running = (async () => {
    do {
      s.again = false;
      const sc = scenes.get(id); const b = getState().boards[id];
      if (!sc || !b || b.archived) break;
      sc.rev++;
      await api.saveScene(id, { type: "excalidraw", version: 2, source: "ai-whiteboard", elements: sc.elements,
        appState: { viewBackgroundColor: sc.appState.viewBackgroundColor ?? "#ffffff" }, files: sc.files ?? {} });
    } while (s.again);
  })().finally(() => { s.running = undefined; });
  return s.running;
}

export async function flush(id: string) {             // write now if anything is pending, and wait
  const s = saving.get(id);
  if (!s) return;
  if (s.timer) { clearTimeout(s.timer); s.timer = undefined; await runSave(id); }
  else if (s.running) await s.running;
}

export async function flushAll() { await Promise.all([...saving.keys()].map(flush)); }
export const hasPendingSaves = () => [...saving.values()].some((s) => s.timer || s.running);
```

`main.tsx` installs the quit guards:

```ts
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flushAll(); });
window.addEventListener("pagehide", () => { void flushAll(); });
window.addEventListener("beforeunload", (e) => { if (hasPendingSaves()) { void flushAll(); e.preventDefault(); } });
```

The board tools (`runTool`, the prototype's, renamed):

```ts
type ToolCall = { chat: string; board: string; name: string; args: any }; // board = the chat's own board id

function resolveBoard(call: ToolCall): string {        // → board id
  const ref = call.args?.board;
  if (!ref) return call.board;
  const id = String(ref);                               // ids only, no name lookup
  if (!getState().boards[id]) throw new RpcError("NO_BOARD", `no board with id ${id}; call list_boards to find ids`);
  if (getState().boards[id].archived) throw new RpcError("ARCHIVED", `${getState().boards[id].name} is archived`);
  return id;
}

export async function runTool(call: ToolCall): Promise<string> {
  const s = getState();
  switch (call.name) {
    case "list_boards":
      return Object.values(s.boards).filter((b) => !b.archived).sort(byName).map((b) =>
        `${b.name}  (${b.id})  [${groupName(b.group)}]${b.id === call.board ? "  (this chat's board)" : ""}${b.id === s.sel.board ? "  (on screen)" : ""}`).join("\n") || "(no boards)";
    case "read_board": { const id = resolveBoard(call); await loadScene(id); markBusy(id, call.chat); /* prototype read_page body */ }
    case "get_view": { /* prototype, with: */ const on = s.sel.board;
      if (on !== call.board) return `The user is looking at ${on ? s.boards[on].name : "no board"}, not ${s.boards[call.board].name}.`;
      /* else the prototype's view + selection lines, with active_board */ }
    case "apply": { const id = resolveBoard(call); await loadScene(id); markBusy(id, call.chat);
      const args = expandIds(id, call.args);
      const res = applyChanges(engineFor(id), { create: args.create, update: args.update }, hooks(id));
      afterEdit(id, call.chat, [...Object.values(res.created), ...res.updated]);
      return JSON.stringify({ board: s.boards[id].name, id, ...res }); }
    case "delete_elements": { /* prototype body keyed by id; the red "Removed" flash is always shown
                                 (no approval any more); cascade label removal kept */ }
    case "create_board": {
      const own = s.boards[call.board];
      const b = await api.newBoard(own.group, call.args?.name, true); // marked new, see below
      return `created ${b.name} (${b.id}) in ${groupName(b.group)} (the user is still on ${s.sel.board ? s.boards[s.sel.board].name : "no board"})`; }
    case "show_board": { const id = resolveBoard(call);
      select(id === call.board ? { board: id, chat: s.sel.chat } : { board: id, chat: null });
      /* prototype: scroll to refs after 150 ms */ return `showing ${s.boards[id].name}`; }
  }
  throw new RpcError("UNKNOWN_TOOL", `unknown tool ${call.name}`);
}
```

- `create_board` creates the board as **new** (`new: true`, passed to `Boards.Create`), in the
  group of the chat's board, with no chats. The sidebar shows a "new" marker until the user opens it
  (`api.seenBoard` in `select`).
- **Resolved:** `show_board` on another board opens that board without a chat panel (the chat is
  not that board's), since the feature allows switching the view only when asked.
- `afterEdit(id, chat, ids)`: `saveSoon(id, 50)`; if the board is on screen, flash its box (prototype);
  the prototype's `unseen` badge is gone.
- `hooks(id)`: the prototype's no-op hooks with `rev: () => scenes.get(id)!.rev + 1`.
- Undo: `applyChanges` already calls `updateScene` with `CaptureUpdateAction.IMMEDIATELY` on the live
  canvas, so each agent edit is one undo step (feature, *Undo*). Boards not on screen are edited in
  their stored scene, as in the prototype.

`logic/context.ts` (from `buildContext`):

```ts
export function contextBlock(o: { board: string; referenced: string[]; selection: string[]; viewport: FmtViewport }): string {
  const lines = [`active_board: ${o.board}`];
  if (o.referenced.length) lines.push(`referenced_boards: ${o.referenced.join(", ")}`);
  if (o.selection.length) { lines.push(`selection (${o.selection.length}):`); for (const l of o.selection) lines.push("  " + l); }
  else lines.push("selection: none");
  lines.push(formatViewport(o.viewport));
  return `<ui-context>\n${lines.join("\n")}\n</ui-context>`;
}
```

`board.ts` `buildContext(chat)` fills it from the store: the chat's board as `name (id)`, `@`
references resolved by `logic/mentions.ts` also as `name (id)` (a mention picked from the `@` list
carries its board's id; a typed `@name` matching several boards lists all of them), and the selection and viewport only when the chat's board is the
one on screen (else `selection: none` and the last viewport saved in the scene's appState).

### 5.5 `Canvas.tsx`

The prototype's canvas, for the selected board only:

```tsx
export function Canvas({ board }: { board: string }) {
  const b = useStore((s) => s.boards[board]);
  // load (prototype effect) keyed by board id; on unmount: flush(board); setLive(null, null)
  return (
    <div className="canvas" onDropCapture={blockSceneDrop}>
      <Excalidraw key={board}
        viewModeEnabled={!!b.archived}
        UIOptions={{ canvasActions: {
          loadScene: false,                      // no Open / ⌘O
          saveToActiveFile: false,               // no Save / ⌘S
          export: { saveFileToDisk: false } } }} // no Save to disk / ⌘⇧S; image export stays
        initialData={{ elements: scene.elements, files: scene.files,
          appState: { viewBackgroundColor: …, scrollX: …, scrollY: …, zoom: …, ...styleMemory } }}
        excalidrawAPI={(api) => setLive(board, api)}
        onChange={(els, appState, files) => {
          if (!b.archived) sceneChanged(board, els, appState, files);
          rememberStyle(appState);
          /* prototype selection / view updates */ }} />
      <FlashLayer board={board} />
      <Presence board={board} />
    </div>
  );
}
```

The board's file is owned by the app, so Excalidraw's own file actions are off: Open would
replace the board and autosave would write it over the file, and Save / Save to disk only make a
copy that is never linked back. Export image stays. Excalidraw also loads a scene when a
`.excalidraw` file is dropped on the canvas, which the options above don't cover, so the wrapper
blocks that drop before Excalidraw sees it:

```ts
function blockSceneDrop(e: React.DragEvent) {
  const f = e.dataTransfer.files[0];
  if (f && (/\.(excalidraw|json)$/i.test(f.name) || f.type === "application/vnd.excalidraw+json")) {
    e.preventDefault(); e.stopPropagation();   // image and library drops still go through
  }
}
```

`styleMemory` and `rememberStyle` are section 6. `Presence` shows "<Agent> is working on <board>"
while any of the board's own chats is busy, or `busyOn[board]` is fresh (an `@name` edit from
another chat), with the agent's glyph and colour (prototype `Presence`).

### 5.6 `Sidebar.tsx`

The variant 4 sidebar (264px), with these changes.

- **Header:** brand, "Reconnecting…" when disconnected, and a `+` menu:
  *Claude Code chat*, *Cursor chat* (always this order), *New whiteboard*,
  separator, *New group*.
- **Tree** (built by `logic/tree.ts`):

  ```ts
  export type Tree = {
    loose: { boards: Board[]; chats: ChatView[] };
    groups: { group: Group; boards: Board[]; chats: ChatView[] }[];
  };
  export function buildTree(s: { groups: Group[]; boards: Record<string, Board>; chats: Record<string, ChatView> }, showArchived: boolean): Tree
  export function boardChats(chats: Record<string, ChatView>, board: string, showArchived: boolean): ChatView[]
  ```

  - Boards sorted by name; chats newest first (the prototype's order).
  - Plain chats are placed by `chat.group`; board chats only under their board.
  - Archived groups, boards and chats are left out unless `showArchived`; when shown they stay in
    place, with the class `archived` (greyed, an "Archived" tag).
  - A chat or board whose group id is unknown falls into `loose`.
- **Groups** (`GroupNode`): click toggles `collapsed` (`api.updateGroup`); double-click renames
  inline; collapsed shows the count and a live dot when any chat inside (or on a board inside) is
  busy. Hover shows `+` (*Claude Code chat*, *Cursor chat*, always in this order,
  *Whiteboard*) and `⋯` (*Rename*, *Archive*, *Delete*). The prototype's `×` is
  gone. A group created with *New group* opens with its name in edit mode.
- **Group order:** group headers are draggable (`text/x-aiwb-group`). Dropping on another group's
  header moves the dragged group before it; the new order goes to `api.reorderGroups`.
- **Moving:** chat rows (plain chats) and board rows are draggable (`text/x-aiwb` =
  `board:<id>` or `chat:<id>`, prototype); dropping on a group or on the ungrouped area calls
  `api.moveBoard` / `api.moveChat`. A board's chats move with it (their group is the board's).
  Board chats are not draggable (prototype).
- **Board rows** (`BoardNode`): caret, board icon (the agent's glyph while one of its chats is
  busy), name, a "new" dot when `board.new`, count when collapsed. Click → `openBoard(id)`;
  double-click → inline rename (`flush(id)` first, then `api.renameBoard`; an error shows under the
  row). Hover shows `+` (*Claude Code chat*, *Cursor chat* on this board) and `⋯` (*Rename*,
  *Reveal in Finder*, *Archive*, *Delete*).
- **Chat rows** (`ChatRow`): glyph with status dot, name (or the first message, greyed, until
  named), and the second line: `subline` (model · effort, from the catalog labels) or the live
  status while busy, "Stopped" when stopped, the error when `status === "error"`. Double-click
  renames. Hover `⋯`: *Rename*, *Archive*, *Delete*.
- **Archived items** (when shown): their `⋯` has only *Unarchive* and *Delete*. They open read-only.
- **Footer:** a *Show archived* switch (`showArchived`, persisted).

Selection helpers (from `v4.tsx`):

```ts
export function select(sel: Sel) {
  const prev = getState().sel;
  if (prev.board && prev.board !== sel.board) void flush(prev.board);          // closing a board writes it
  setState({ sel }); safeSet("aiwb.sel", JSON.stringify(sel));
  if (sel.board && getState().boards[sel.board]?.new) void api.seenBoard(sel.board);
  if (sel.board && sel.chat) lastChat.set(sel.board, sel.chat);
  if (sel.chat) { setState({ panel: true }); void api.openChat(sel.chat); void loadItems(sel.chat); focusComposer(); }
}
export function openBoard(id: string)   // last chat opened on it if it still exists, else its newest chat, else none
export function openChat(c: ChatView)   // board chat → {board, chat}; plain → {board: null, chat}
export async function newChat(agent: AgentKind, where: { group: string } | { board: string })
export async function newBoard(group: string): Promise<string> // returns id; the row opens in rename mode
export async function newGroup(): Promise<string>              // the header opens in rename mode
```

### 5.7 `App.tsx`, `ChatView.tsx`, `Composer.tsx`

`App.tsx` — variant 4's `Grouped`:

- `role === "superseded"` → `TakeoverScreen` ("Opened in another window" + *Use here* → `takeBack()`).
- `role === "waiting"` → a quiet "Taking over from the other window…" screen.
- Otherwise the sidebar plus:
  - a board selected → `[chat panel (400px, if a board chat is selected and panel)] + [board bar +
    canvas]`. The board bar shows `Group / ▭ board`, *Chats (n)* when the board has chats and the
    panel is hidden or no chat is open, and *+ Chat on this board* (agent menu). An archived board
    shows "Archived — read-only" in the bar and no *+ Chat*.
  - a plain chat selected → the centred column (max 780px): header, thread, composer.
  - nothing → `Home` (prototype, with *New chat* and *New whiteboard*).
- Keys (from `VariantHost`): ⌘J toggles `panel`. ⌥V is gone.

`ChatView.tsx`:

- `ChatHeader` (v2): glyph, name (click to rename), and the second line: `▭ board ·` for board
  chats, *Claude Code* or *Cursor*, the folder (`tildify`), the status. Actions: `×` for board
  chats (hides the panel).
- `Thread` (prototype) renders `items[chat].items` with `ItemView`.
- `EmptyThread` (prototype): plain chats "The same session you get in a terminal, started in
  <folder>"; board chats "Ask about or change <board>. Type @ to point at other boards." The mock
  notes are gone.
- `ToolCard` (prototype) uses `logic/labels.ts`; its *Show* link calls `select` for the board it
  names.
- `PermCard` (prototype) without the delete branch: "Allow <tool>?", the description, the command,
  file or URL, and *Allow* / *Don't*.
- A `note` item renders as in the prototype.
- An archived chat shows its history with a bar "Archived — unarchive to continue" instead of the
  composer.

`logic/labels.ts` — `genericTool`, `toolVerb`, `toolDone`, `statusText` from `ui.tsx`, with
`list_pages`… renamed to the board tools (`Listing boards`, `Reading <board>`, `Looking at your
view`, `Editing <board>`, `Deleting on <board>`, `Creating <name>`, `Showing <board>`), board names
from the `board` argument or "this board". `statusText` adds `stopped` → "Stopped" and `error` →
"Can't start".

`Composer.tsx`:

- `Composer` (prototype) with: the context chip and `@` mentions only for board chats (plain chats
  have neither, variant 4); mentions list non-archived boards by name with their group, and a picked mention keeps the board's id; the placeholder no longer says
  the agent has stopped — a stopped chat takes a new message and resumes.
- `sendMessage(chat, text)`: plain → `api.send(chat, text, "")`; board → `api.send(chat, text,
  buildContext(chat, text))`. A 409 "folder" error is shown under the composer.
- **No send while busy:** while the chat's status is thinking, writing, tool or approval, the send
  button is greyed out and Enter does not send (it does nothing; Shift+Enter still adds a line).
  The text box stays editable, so the user can write the next message while the agent works; the
  Stop button stays available. Send comes back when the status leaves busy.
- If the server still answers 409 busy (the tab's status was stale): the composer shows the error
  under it, refreshes the chat (`api.chat(id)` → `upsertChat`, `api.items(id)` → replace its items)
  and puts the text back in the box, so nothing typed is lost.
- `Toolbar` (v2), driven by `catalogs[chat.agent]`:
  - Folder chip (`DirPicker`/`DirBrowser`, v2) first; unlocked until the first message, and again
    while `chat.folderMissing`.
  - Model and effort `Picker`s until locked; then one static chip with a lock. Effort is hidden when
    the model has no `efforts`. Cursor's pickers read "Loading models…" until its catalog exists.
  - `ContextMeter` (v2) for both agents, from `chat.usage` (`ctxIn + ctxOut` of `ctxWindow`, falling
    back to the catalog's `contextWindow`). Before any usage arrives (both 0, no error) it is
    empty. When `chat.usage.ctxError` is set, the meter is replaced in the same spot by an error
    state: a warning glyph and "Context unavailable", with `ctxError` as its tooltip. It never shows
    a number then.
  - Each change calls `api.configure`, which only saves the settings on the server (no agent runs
    before the first message). Once the first message is sent, folder, model and effort are locked.
- `recentDirs` stays in localStorage (prototype); the default folder now comes from the server's
  sticky defaults.

### 5.8 `Dialogs.tsx`

```ts
export type ConfirmRequest = {
  title: string; body?: string;
  actions: { label: string; tone?: "danger" | "primary"; run: () => Promise<void> | void }[]; // plus Cancel
};
export function confirm(req: ConfirmRequest): void          // setState({ confirm: req })
export function ConfirmDialog(): JSX.Element | null          // modal; Esc = Cancel
export function TakeoverScreen(): JSX.Element
```

Used by the sidebar menus:

| Action | Dialog |
|---|---|
| Archive chat | none |
| Archive board | none, unless one of its chats is busy: "An agent is working on this board. Stop it and archive?" |
| Archive group | none |
| Delete chat | "Delete <chat>? Its history is removed. This can't be undone." — *Delete* |
| Delete board | "Delete <board>? The board file and all its chats are removed. This can't be undone." — *Delete*; if an agent is working: "An agent is working on this board. Stop it and delete?" first line |
| Delete group | "Delete <group>?" — *Delete everything in it* / *Move contents to ungrouped* |

Before archive, delete and rename of a board, the client calls `flush(board)` (feature, *Autosave*).
Delete asks every time (feature).

### 5.9 Styles

`styles.css` keeps the prototype's tokens and the classes used by the kept components (`.btn`,
`.menu*`, `.v4-*` renamed to `.side-*`/`.board-*`, `.thread`, `.tool*`, `.perm*`, `.composer*`,
`.tchip`, `.ctx-meter`, `.flash*`, `.presence`), drops `.topbar`, `.tabs`, `.tab*`, `.sessions`,
`.session*`, `.chatlist*`, `.vswitch*`, `.v-docked`, `.v-rail`, `.side2`, and adds `.archived`
(opacity .55, italic tag), `.new-dot`, `.dialog*`, `.takeover`.

---

## 6. Drawing style

Feature: *boards default to a clean, technical look*.

**Agents' instructions.** Section 4.8, item 4.

**Editor defaults** (`Canvas.tsx`):

```ts
import { FONT_FAMILY, ROUNDNESS } from "@excalidraw/excalidraw";

const CLEAN = {
  currentItemRoughness: 0,              // "architect"
  currentItemRoundness: "sharp",
  currentItemArrowType: "sharp",
  currentItemFontFamily: FONT_FAMILY.Nunito, // Excalidraw's normal font
};

// Excalidraw keeps the user's style choices in appState only while the component lives; the canvas
// remounts per board, so the choices are carried here for the rest of the session (page lifetime).
let styleMemory: Record<string, unknown> = { ...CLEAN };

export function rememberStyle(appState: any) {
  for (const k of Object.keys(appState)) if (k.startsWith("currentItem")) styleMemory[k] = appState[k];
}
```

`styleMemory` is spread into every board's `initialData.appState` (section 5.5), so the user's own
changes persist across boards until the page is reloaded.

**Engine defaults** (`apply.ts`), for elements an agent creates:

```ts
const CLEAN_CREATE = { roughness: 0, roundness: null, fontFamily: FONT_FAMILY.Nunito };

// in toSkeleton, before styleOf(rest) is spread:
const s: any = { ...CLEAN_CREATE, ...styleOf(rest), ...rest, id: _id ?? rid() };
// roundness is given only when the agent asks: styleOf maps "round" → { type: ROUNDNESS.ADAPTIVE_RADIUS }, "sharp" → null
// labels: if (label) s.label = { fontFamily: s.fontFamily, ...(typeof label === "string" ? { text: label } : label) }
// arrows and lines: s.elbowed = false; s.roundness stays null unless asked
```

- `styleOf` gains `roughness` passthrough (it already maps `fontFamily` hand/normal/code and
  `roundness`).
- Updates never get these defaults, so existing elements keep their style (feature).
- **Resolved:** `apply.ts`'s header says it is "moved across unchanged in behaviour". The feature's
  "new elements are clean unless the user says otherwise" needs this one change; the header comment
  is updated to say so.

---

## 7. Tests

### 7.1 Go (`go test ./...`)

Every package gets `_test.go` files next to it. Agents are faked with the helper-process pattern:
the test binary re-runs itself as a fake `claude` or `agent` (`TestHelperProcess`, selected by an
environment variable) that plays a scripted list of stdout lines and records stdin.

`internal/store`
- `Open` on an empty folder creates `boards/`, `chats/`, and `state.json` with version 1.
- `Update` persists; a second `Open` reads the same state.
- `WriteFileAtomic` leaves no `.tmp` file behind and replaces the target.
- `Open` with a corrupt `state.json` returns an error and does not overwrite the file.
- `Paths.Contains`: root, a child, `root/../x` (false), a symlink into root (true), `~/.ai-whiteboard`.

`internal/boards`
- `CleanName`: spaces → `-`; `.excalidraw` stripped; `""`, `.x`, `a/b`, 81 chars rejected.
- `Create("", g)` → `whiteboard`, again → a second `whiteboard` with another id; each has its own
  `boards/<id>/` with `board.json` and `drawing.excalidraw` (`EmptyScene`) **before** `Create` returns.
- `Create` in an unknown group fails.
- `Rename` keeps the id and the folder and rewrites `board.json`; renaming onto an existing name is allowed.
- `Scene` of an unknown id → `ErrNotFound`; of a known board whose drawing file is gone → `EmptyScene`.
- `Save` on an archived board → `ErrArchived`; invalid JSON rejected; `board.json` untouched.
- `Delete` removes the board's folder and the record.
- `Load` after `Create`, `Rename`, `Move`, `SetArchive` in a fresh `Service` returns the same boards;
  a folder with no `board.json` is skipped and left on disk.

`internal/defaults`
- `Resolve` with nothing recorded → fallback folder and the catalog default.
- `RecordChange(g1, claude, cwd=/a, {opus, max})` then `Resolve(g1, claude)` → `/a`, opus/max;
  `Resolve(g1, cursor)` → `/a` and Cursor's default (folder shared, model per agent).
- `Resolve(g2, claude)` after the above → the `last` values (g2 never set).
- `SeedGroup(g3)` copies `last`; a later change in g1 doesn't change g3.
- Ungrouped (`"__ungrouped__"`) behaves as its own group.
- A remembered folder that no longer exists → fallback folder.
- A remembered model missing from the catalog → catalog default; haiku → effort cleared.
- `AgentOrder` is Claude, Cursor, whatever was used last.

`internal/transcript`
- Claude-shaped sequence (thinking, text start, 3 deltas, tool start, input deltas, tool input,
  tool result, turn end) → items `text(done)`, `tool(result)`; status goes thinking → writing →
  tool → thinking → ready.
- `EvText` for a message that was not streamed adds a done text item.
- Permission request → status approval; `Decided` → item decided, status tool.
- Aborted turn → note "Stopped."; error turn → error note.
- `EvExit` while busy → status stopped, error note, open perms denied.
- `Flush` then `Load` → same items; a later line for the same index wins; open text written only on
  `Flush(true)`.

`internal/claude`
- `Args`: plain chat has no `--append-system-prompt`/`--mcp-config`/`--allowedTools`; board chat
  has all three with every `mcp__board__*` tool; `--resume` vs `--session-id`; haiku gets no
  `--effort`; `--disallowedTools` contains the four app-folder rules; `--permission-mode auto` is
  always present; none of the isolation flags.
- `AppDirRules` for a root under home (`~/…`) and outside it (`//…`).
- `translate` over the research's sample lines (claude-rpc report, section 2) gives the expected
  events; a `result` gives the largest `modelUsage` context window; subagent lines give none.
- Fake process: a `can_use_tool` for `touch ~/.ai-whiteboard/x` is denied without an
  `EvPermRequest`; a `can_use_tool` for `touch a.txt` yields `EvPermRequest`, and `Decide(true)`
  writes an allow `control_response` with `updatedInput`.
- A missing folder → `ErrFolderMissing` without starting a process.

`internal/cursor`
- Fake ACP process: the handshake sends `initialize`, `authenticate`, `session/new` in order with
  `mcpServers: []` and the chat's cwd; emits `EvSession` and `EvCatalog`; with a model set, sends
  `session/set_config_option` with the exact value.
- Resume sends `session/load`; its replayed `session/update`s produce no events.
- `Catalog` sends `initialize`, `authenticate`, `session/new` in a temp folder, returns the parsed
  catalog, sends no prompt and no `set_config_option`, and ends the process; no models or a timeout
  → error.
- `agent_message_chunk`s → one text item per stretch between tool calls.
- A `tool_call` whose command is this chat's board command → `EvToolStart{ToolName: "mcp__board__apply", Input: <args>}`; its completed update → `EvToolResult` with stdout.
- `session/request_permission` for this chat's board command → answered `allow-once` with no event;
  for another chat's token → an `EvPermRequest`; for a command with `.ai-whiteboard` → answered
  `reject-once` with no event.
- `Interrupt` sends `session/cancel`; a prompt response `stopReason: "cancelled"` → `EvTurnEnd{Aborted}`.
- `ParseCatalog` over a sample `session/new` result; `ValueFor("gpt-5.4-mini", "low")` picks the
  exact value or falls back to the first with that base.
- `EnsureDenyRules`: adds both rules once (idempotent), keeps unrelated keys, creates `deny` when
  missing, leaves a missing config file alone, refuses to touch invalid JSON.
- `ReadContextUsage` over a temp `store.db` built in the test with `sqlite3` (the test is skipped
  when `sqlite3` is missing): a sample root blob with token_details 15989 / 272000 → `{15989,
  272000}`. Error cases, each giving the table's text: no `store.db`; `SQLite: "/nonexistent"`;
  no `meta` row; a meta value that is not hex; a blob id with a quote in it (not queried); no blob
  row; a blob without field 5; a field 5 with `used_tokens` 0.
- `StorePath` honours `CURSOR_CONFIG_DIR`, else `<home>/.cursor`.
- Fake ACP process + temp store: after a `session/prompt` response the adapter emits
  `EvUsage{CtxIn, CtxWindow}` from the store; with the store removed it emits
  `EvUsage{CtxError: "Cursor session store not found"}` and no numbers.

`internal/boardtools`
- `ParseCommand` accepts the exact form; rejects: another host, a missing heredoc, extra flags,
  `; rm`, `&&`, `|`, `$(…)` in the first line, invalid JSON, an unknown tool.

`internal/boardapi`
- MCP: `initialize` echoes the protocol version; `tools/list` returns the 7 board tools;
  `tools/call` with an unknown token → `isError`; with no active client → the "board isn't open"
  text and `isError`.
- `ServeCommand` returns `ERROR: …` bodies with 200.
- `Relay.Call` for an archived chat → error text.

`internal/editorbridge`
- First client gets `hello{active}` and `snapshot`.
- A second client gets `hello{waiting}`; the first gets `release_request`; `Release` from the first
  → first gets `superseded` and its stream ends; second gets `hello{active}` + `snapshot`.
- No `Release` within 3 s → promoted anyway.
- The same client id reconnecting replaces its own stream without a takeover.
- `Broadcast` reaches only the active client.
- `Call` with no client → `ErrNoClient` at once; the active client disconnecting fails its pending
  calls at once; a reply resolves the call; a timeout returns the timeout error.

`internal/chats` (fake spawners that record `SpawnOptions` and expose an event channel)
- `Create` in a group applies that group's defaults and records the agent; a board chat gets a
  token and the board's group defaults; Claude gets a session id; nothing is spawned.
- `Open` never spawns; on a locked chat whose folder is gone it sets `folderMissing` and status error.
- `Configure` before the first message changes the settings without spawning, keeps the Claude
  session id, and records the defaults for the chat's group and agent.
- The first `Send` spawns once with `Resume: false` and the chat's settings; a Claude chat uses the
  session id made in `Create`.
- `Configure` after `Send` → `ErrLocked`; `Configure{Cwd}` inside the data folder → `ErrAppFolder`.
- `Send` on a plain chat drops the context; on a Claude board chat sends `[context, text]`; on a
  Cursor board chat sends `[instructions, board-api, context, text]` the first time and
  `[board-api, context, text]` after; the first send starts naming.
- `Send` after the process exited spawns with `Resume: true` and the same session id.
- `Send` while the chat is busy → `ErrBusy`; no user item is added, `chat.json` is unchanged and
  the agent gets nothing. After `EvTurnEnd` the next `Send` goes through.
- `Load` does not read `items.jsonl` (a corrupt one doesn't fail boot); `Items` reads it once, then
  serves from memory.
- `Load` with `turnActive: true` → view status stopped before `Items`; the first `Items` adds the
  note once, clears `turnActive` on disk; a restart before `Items` still finds it; the next `Send`
  resumes.
- Missing folder: status error, `folderMissing`; `Configure{Cwd}` on the locked chat is allowed,
  clears it, and the next spawn resumes in the new folder.
- `Stop` denies a pending permission (the fake records `Decide(false)`), closes the agent, clears
  `turnActive`.
- `Delete` removes the chat folder and broadcasts `chat_removed`.
- Usage: two turn ends give `usage.turns` 2 and clear `turnActive`.
- `EvUsage{CtxError}` sets `usage.ctxError` and keeps `ctxIn`/`ctxWindow`; the next `EvUsage` with
  numbers clears it.
- An event from a replaced process (old gen) is ignored.

`internal/app`
- Archive board → board and its chats archived with one op; their agents stopped.
- Unarchive one chat of an archived board → the chat and the board come back, the board's other
  chats stay archived.
- Archive a chat, then archive its board; unarchive the board → the board and the chats archived
  with it come back, the chat archived earlier stays archived.
- Archive group → everything inside with one op; unarchive group → all of it back.
- Delete group with `delete` → boards' files and chats gone; with `ungroup` → contents in
  ungrouped, group and its defaults removed.
- `CreateGroup` seeds defaults from `last`.
- `MoveBoard` changes the group reported for its chats (`GroupOf`).

`internal/server`
- A request with `Host: evil.example` → 403.
- `POST /api/boards` without `X-AIWB-Client`, or from a non-active client → 409 `not_active`.
- `POST /api/boards` → 200 and the file exists; `PUT` scene then `GET` scene round-trips.
- Error mapping (404 / 409 / 400) for each error kind.

`cmd/ai-whiteboard`
- `findRunning` returns true for an `httptest` server answering `/api/hello` like ours and false
  for a stale `server.json` or another program on the port.

### 7.2 Client (`cd web && npm test`)

Only DOM-free modules are unit-tested (`node --test --experimental-strip-types`):

- `logic/context.ts`: the block for a board with and without selection and references matches the
  expected text exactly.
- `logic/mentions.ts`: `@arch`, `@arch.`, `@arch.excalidraw`, unknown names, archived boards
  excluded, a picked mention resolving by id, a typed name shared by two boards giving both.
- `logic/labels.ts`: every board tool's running and done label; `apply` result `+3 ~1`; Claude's
  own tools (Bash with and without description, Read, Edit, Grep, WebFetch, Task); other MCP servers.
- `logic/tree.ts`: grouping; unknown groups fall into loose; archived items hidden and shown in
  place; board chats only under their board; order of boards and chats.

### 7.3 Verification by running it

As the prototype was verified: a headless Chrome (Playwright) script against a server started with
`-home <temp dir> -port 4749 -no-open`, real Claude on Haiku, and real Cursor on its cheapest
model. It is kept as `web/e2e/app.e2e.mjs` and run with `node web/e2e/app.e2e.mjs`, by an agent
or by hand, using the Claude and Cursor logins already on the machine. It is not part of `npm test`,
since it spends money and needs those logins.

1. Start the server; running it a second time prints "already running" and exits 0.
2. New group "Research" opens in rename mode; rename it. New plain Claude chat in it: pickers
   change (no `claude` process runs yet, checked with `pgrep -f`), first message starts one and
   locks them; asking
   "Do you have any tools containing board?" → "No". The chat gets a name.
3. Change folder to another folder in a second chat of the group; a third new chat in the group
   starts in that folder with the same model and effort. A new chat in ungrouped does not.
4. New whiteboard in Research: `boards/<id>/board.json` and `drawing.excalidraw` exist at once.
   Rename it to `arch` → same folder, `board.json` has the new name.
5. Claude board chat on `arch`: "Draw client → server → database". The canvas shows sharp,
   non-rough rectangles in the normal font; the agent outline and working pill show; its
   `drawing.excalidraw` on disk contains the elements within about a second.
6. Draw a rectangle by hand: it is sharp, roughness 0, normal font. Change the stroke style by hand,
   open another board, draw again: the change is kept.
7. Cursor board chat on `arch`: "Add a cache next to the server". The edit lands, the tool card
   reads "Edited arch · +2", no approval card appears, the chat's folder has no new files. The
   context meter shows a non-zero share of the model's window after the turn. Restart the
   server with `sqlite3` off the `PATH` and send again: the meter shows "Context unavailable"
   with "sqlite3 not found; the context meter needs it" and no number.
8. Ask the Claude board chat to "read ~/.ai-whiteboard/boards/<arch id>/drawing.excalidraw with cat" → refused
   or denied; no approval card for it.
9. Open a second tab: the first shows "Opened in another window"; pending edits from the first are
   in the file. *Use here* takes it back.
10. Close all tabs; ask a board chat (through the API) to read the board → the reply says the
    board isn't open.
11. Stop the server during a Claude turn; restart: the chat is in its group with its history,
    shows Stopped; a new message continues the same session (it remembers an earlier codeword).
12. Rename the folder of a locked plain chat on disk; opening it shows the folder error; picking
    another folder and sending continues the session.
13. Archive the board: its chats disappear; *Show archived* shows them greyed in place; opening
    the board is read-only. Unarchive one chat → it and the board come back, the other chat stays
    archived.
14. Delete the group with *Move contents to ungrouped*, then delete a board with confirmation: its
    file and chats are gone.
15. *Reveal in Finder* on a board opens Finder at its file.
16. `~/.cursor/cli-config.json` (of the test machine) contains the two deny rules once after two
    server starts.
17. While an agent is working, send is greyed out and Enter does nothing, but the box still takes
    text; once the turn ends, that text sends. A `curl` to `/messages` mid-turn gets 409.

---

## 8. Build order

Not a task split; the order in which the parts depend on each other:

1. `model`, `store`, `boards`, `defaults`, `transcript`, `agent` (no processes).
2. `claude`, `cursor` adapters with their fake-process tests.
3. `boardtools`, `editorbridge`, `chats`, `boardapi`, `app`, `server`, `main`.
4. Client: move the prototype files as in 5.1, then the changes.
5. Remove the prototype-only code listed in 2.2; update `docs/PROJECT.md`.

---

## 9. Changes to existing documents

`docs/PROJECT.md`:

- "A single Go binary … opens a browser tab" → a local Go **server** and a separately built
  **client** (a web app in a browser tab for now, a React Native macOS app later) that talks to the
  server only through its HTTP API.
- *Core ideas*: replace *Pages (boards) in tabs* and *Chats sit on top of pages* with: the app is a
  list of chats in user-made groups; a chat is a full coding-agent session; a whiteboard lives in a
  group and has its own chats, which see and draw on it; other chats know nothing of whiteboards.
- `ai-whiteboard [files or dir...]` → `ai-whiteboard` with data in `~/.ai-whiteboard`.
- *Rough architecture*: replace the diagram with section 1's.
- *Open questions*: mark the protocol, board-editing, context and engine questions as answered by
  the research and this feature, pointing to `docs/features/app.md` and this spec.
- *Findings*: the isolation paragraph gets "no longer used: every chat runs with the user's own
  settings"; the Cursor system-prompt paragraph gets "instructions travel in the conversation; no
  files are written into the chat's folder".

`.gitignore`: add `bin/`, `web/node_modules/`, `web/dist/`.

---

## 10. Risks to check during implementation

Not unresolved (each part is specified), but not yet proven by running code. The tests and the
verification run in section 7 cover each one.

- Claude's `Bash(*.ai-whiteboard*)` rule relies on wildcards inside Bash rules. The permission
  handler guard and the instructions back it up (feature, open problem 4).
- Cursor's `Read(<path>/**)` / `Write(<path>/**)` deny syntax in `cli-config.json`.
- Cursor `session/load` with a different `cwd` (the folder-moved case). If Cursor refuses, the chat
  shows the error and the user can start a new chat in the new folder.
- The exact shape of Cursor's `session/new` result (`configOptions` vs `models`); `ParseCatalog`
  reads both.
- Cursor's session store format (`meta` key `'0'`, `latestRootBlobId`, token_details as field 5) is
  undocumented and was seen in CLI v2026.09.23. A change shows as the meter's format error, not as
  a wrong number. The `CURSOR_CONFIG_DIR` store path and `max_tokens` after a model change are not
  yet proven by running code.
- `FONT_FAMILY.Nunito` and `currentItemArrowType` in Excalidraw 0.18.1's public exports and
  appState.

---

## Unresolved

None.
