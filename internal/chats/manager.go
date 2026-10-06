// Package chats owns the chats: one agent per chat, the agent's events turned into items,
// persistence (chat.json, items.jsonl, subagents/<sid>/) and the sticky defaults a chat's settings feed.
// (The prototype's Chats and Chat in chats.go.)
package chats

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/prompts"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/transcript"
)

type Deps struct {
	Store      *store.Store
	Bridge     *editorbridge.Bridge
	Boards     *boards.Service
	Spawners   map[model.AgentKind]agent.Spawner
	Namers     map[model.AgentKind]Namer // per-agent auto namers; a missing entry means chats of that agent are not named
	DefaultCwd string
	MCPURL     string // the fixed MCP endpoint handed to every chat, http://localhost:6006/mcp
	// Runs is what the manager asks about runs: for the chats people open on a run and for the
	// run's agents, which are chats too (see owned.go). nil = the server has no runs.
	Runs RunOwner
}

type Manager struct {
	Deps
	mu       sync.Mutex
	chats    map[string]*Chat
	naming   sync.WaitGroup   // the auto namer goroutines Send starts
	handoffs sync.WaitGroup   // the deliveries of subagent results being given to an agent (handOff)
	now      func() time.Time // the clock subagents' times come from; tests replace it

	// extrasMu protects extras, extraBySID and used. Never take Chat.mu while holding extrasMu
	// (issue/revoke run with Chat.mu then extrasMu).
	extrasMu   sync.Mutex
	extras     map[string]extraCaller // extra token → caller (in memory only)
	extraBySID map[string]string      // chatID+"/"+sid → extra token
	used       map[string]struct{}    // live chat tokens and extra tokens, for uniqueness

	// rootsMu protects roots: top-level chat id → its folder, for the chats that do not live in
	// chats/<id> (a run's, see chatDir). A leaf lock: taken with any other lock held, and nothing
	// is taken under it.
	rootsMu sync.Mutex
	roots   map[string]string

	// watchMu protects watched: the run agents' chats whose events clients are sent (see Watch).
	// A leaf lock too: ClearWatches runs with the bridge's lock held.
	watchMu sync.Mutex
	watched map[string]bool

	ownedMu sync.Mutex // makes CreateOwned's "find it or make it" one step

	// down is set when Shutdown begins, before it visits any chat: from then on no process is
	// started. Every start reads it with the chat's lock held, which Shutdown takes for each chat
	// after setting it. So a start either came first and has its process on the chat when Shutdown
	// gets there, which closes it, or is refused with ErrShutdown.
	down atomic.Bool
}

type Chat struct {
	mu            sync.Mutex
	meta          model.ChatMeta
	tr            *transcript.Transcript // nil until first needed (see trOf)
	ag            agent.Agent            // nil when no process
	gen           int                    // bumped on every spawn; events of an older process are dropped
	errText       string
	folderMissing bool
	interrupted   bool               // TurnActive was true at boot; the "Stopped" note is added when tr loads
	deleted       bool               // removed by Delete: nothing more is written or emitted for it
	unlisted      bool               // being made by Fork: only the token lookup sees it; never listed, saved or emitted
	sentGen       int                // the gen of the process the last Send went to; 0 = none yet
	subs          map[string]*sub    // sid → subagent; loaded with tr (see trOf)
	subByTool     map[string]string  // Agent/Task tool call id → sid
	pendingLinks  []pendingSpawnLink // unlinked app-spawned subs waiting for a matching spawn tool item
	splitRun      *splitRun          // the context split being taken now (see ContextSplit)
	shown         subCounts          // the subagent counts of the chat view clients were last sent (see emitCounts)
	carry         *carry             // the turn carrying subagent results to the agent; nil once it ended
	lateEnd       string             // the error of a refused delivery whose own turn end may still come (see lateEvent)
	hold          bool               // the app starts no turn until the user sends (see setHold); not saved

	// A run agent's chat (see owned.go). role is set before the chat object is in the map and
	// never changes, so the guard of the calls people make and the event filter read it with no
	// lock; "" for every other chat object, a branch included.
	role      model.AgentRole
	wait      *ownedWait    // what has happened since the last SendOwned; nil = none since the server started
	wake      chan struct{} // closed, and dropped, when a WaitOwned should look again; nil while none waits
	removing  bool          // being deleted: a WaitOwned answers ErrNotFound from now on
	costFirst bool          // the next cost report is the first of its process (see costSample)

	// treeMu serialises the changes of tree.json (see updateTree). It is taken before mu, never
	// while mu is held.
	treeMu sync.Mutex

	// moveMu makes a Send with a target one step for its top-level chat: the check that the
	// current branch is idle, the change of the current branch and the Send (see SendTo). A
	// plain Send takes it as well, until it has locked the current branch (see sendCur): it
	// waits for a Send with a target to be done, so its message never goes to a branch that
	// Send is about to stop. It is taken before treeMu and before any chat's mu, and never held
	// during a fork start: a Send that carries a branch on gives it up before the branch's
	// process starts. The one exception is a new branch whose process exited before its first
	// message: step 3 of SendTo starts it again.
	moveMu sync.Mutex

	// The branches (see branches.go). top and branch are set before the chat object is in the
	// map and never change; kids and cur are a top-level chat's, guarded by Manager.mu.
	top    *Chat   // a branch: its top-level chat; nil for a top-level chat
	branch string  // a branch: its branch id; "" for a top-level chat, which is the branch "main"
	kids   []*Chat // the registered branches other than main, in the tree record's order
	cur    *Chat   // the current branch; nil = main
}

var (
	ErrNotFound      = errors.New("no such chat")
	ErrArchived      = errors.New("the chat is archived")
	ErrLegacy        = errors.New("this chat used the old board connection; start a new chat")
	ErrLocked        = errors.New("folder, model and effort are fixed once the chat has started")
	ErrFolderMissing = agent.ErrFolderMissing
	ErrAppFolder     = errors.New("the app's own folder can't be used as a working folder")
	ErrBusy          = errors.New("the agent is still working; wait for it to finish or stop it")
	ErrNotStarted    = errors.New("the context split shows after the first message")
	ErrBadReference  = errors.New("a quote must be part of an earlier message or reply in this chat")
	ErrNoRequest     = errors.New("this permission request is no longer open; reload the page if it still looks open")
	// ErrShutdown is what a call that would start a process answers once Shutdown has begun.
	ErrShutdown = errors.New("the server is shutting down")
)

type ConfigReq struct {
	Model, Effort, Cwd string // empty = unchanged
}

func New(d Deps) *Manager {
	return &Manager{
		Deps:       d,
		chats:      map[string]*Chat{},
		extras:     map[string]extraCaller{},
		extraBySID: map[string]string{},
		used:       map[string]struct{}{},
		roots:      map[string]string{},
		watched:    map[string]bool{},
		now:        time.Now,
	}
}

func (m *Manager) nowMs() int64 { return m.now().UnixMilli() }

// ---- emitting -------------------------------------------------------------

// outbox collects the events built while a chat is locked; they are broadcast after unlocking,
// so the bridge's lock is never taken under a chat's lock (the bridge's snapshot reads chats).
type outbox []any

// send broadcasts the queued events. No chat's mu may be held: a chat event is composed here.
// The events of a run agent's chat go out only while a client watches it (see Watch).
func (m *Manager) send(out outbox) {
	for _, ev := range out {
		switch e := ev.(type) {
		case chatEvent:
			v, ok := m.chatView(e)
			if !ok || (v.Role != "" && !m.watching(v.ID)) {
				continue
			}
			ev = map[string]any{"type": "chat", "chat": v}
		case agentEvent:
			if !m.watching(e.chat) {
				continue
			}
			ev = e.ev
		}
		m.Bridge.Broadcast(ev)
	}
}

// agentEvent is an items or subagent event of a run agent's chat waiting in an outbox: whether it
// is sent is decided when the outbox is (send).
type agentEvent struct {
	chat string
	ev   map[string]any
}

// threadEvent queues ev, an event about c's thread or its subagents that names the top-level chat
// as chat. c.mu held.
func (o *outbox) threadEvent(c *Chat, chat string, ev map[string]any) {
	if c.role != "" {
		*o = append(*o, agentEvent{chat: chat, ev: ev})
		return
	}
	*o = append(*o, ev)
}

// emitChat queues the chat event of a change of c's session side (status, error, usage,
// settings): {type:"chat", chat: <the chat's view>}, sent only when c is its chat's current
// branch. c.mu held. Nothing is queued for an unlisted chat, here and in the other emit functions.
func (o *outbox) emitChat(c *Chat) {
	if c.unlisted {
		return
	}
	v := view(c)
	c.shown = subCounts{v.SubsRunning, v.SubsOwed}
	*o = append(*o, chatEvent{c: c, v: v, session: true})
}

// emitCounts queues the chat's view when its subagent counts are not the ones clients were last
// sent. A subagent's lifecycle and its result's delivery change them with only a sub event, and a
// client shows what an idle chat waits on from the view alone, so whatever may have changed them
// calls this before it unlocks. It queues nothing when a view was queued after the change, or when
// the counts are back where they were (a result owed and taken under one lock). c.mu held.
func (o *outbox) emitCounts(c *Chat) {
	wakeOwned(c) // whatever may have changed the counts may have settled the chat
	if !c.deleted && countSubs(c) != c.shown {
		o.emitChat(c)
	}
}

// emitIdentity queues the chat event of a change of the top-level chat c's own (name, group,
// draft, archive), whatever its current branch is. c.mu held.
func (o *outbox) emitIdentity(c *Chat) {
	if c.unlisted {
		return
	}
	*o = append(*o, chatEvent{c: c, v: view(c)})
}

// emitItems queues the changed items, if any, under the top-level chat's id and the branch's.
// c.mu held.
func (o *outbox) emitItems(c *Chat, ups []transcript.Update) {
	if len(ups) == 0 || c.tr == nil || c.unlisted {
		return
	}
	chat, branch := splitID(c.meta.ID)
	o.threadEvent(c, chat, map[string]any{"type": "chat_items", "chat": chat, "branch": branch, "version": c.tr.Version(), "updates": ups})
}

// view is what clients see of the chat object c alone: of a chat with branches, only the half c
// holds (see compose). c.mu held.
func view(c *Chat) model.ChatView {
	var st model.Status
	var tool string
	switch {
	case c.tr != nil:
		st, tool = c.tr.Status()
	case c.errText != "":
		st = model.StatusError
	case c.interrupted:
		st = model.StatusStopped
	default:
		st = model.StatusReady
	}
	v := model.ViewOf(c.meta, st, tool, c.errText, c.folderMissing)
	n := countSubs(c)
	v.SubsRunning, v.SubsOwed = n.running, n.owed
	return v
}

// subCounts are the two numbers of a chat's view that come from its subagents' records.
type subCounts struct {
	running int // app-spawned subagents still running
	owed    int // results the agent has not received
}

// countSubs counts them. A chat whose subagents are not loaded has none of either: a restart
// leaves no subagent running, and what is owed is known once the chat is opened. c.mu held.
func countSubs(c *Chat) subCounts {
	var n subCounts
	for _, s := range c.subs {
		if s.app && s.meta.Status == model.SubRunning {
			n.running++
		}
		if s.meta.Delivery.Owed() {
			n.owed++
		}
	}
	return n
}

// save writes chat.json. c.mu held. An unlisted chat has none yet and is not written: Fork writes
// it (writeMeta) once the chat is sure to exist.
func (m *Manager) save(c *Chat) error {
	if c.unlisted {
		return nil
	}
	return m.writeMeta(c)
}

// writeMeta writes chat.json, also for an unlisted chat. c.mu held.
func (m *Manager) writeMeta(c *Chat) error {
	return store.WriteJSONAtomic(filepath.Join(m.chatDir(c.meta.ID), "chat.json"), c.meta, 0o600)
}

func (m *Manager) logSave(c *Chat) {
	if err := m.save(c); err != nil {
		log.Printf("chats: save %s: %v", c.meta.ID, err)
	}
}

func (m *Manager) itemsPath(id string) string {
	return filepath.Join(m.chatDir(id), "items.jsonl")
}

// trOf returns the chat's transcript, reading items.jsonl the first time. c.mu held.
func (m *Manager) trOf(c *Chat, out *outbox) (*transcript.Transcript, error) {
	if c.tr != nil {
		return c.tr, nil
	}
	tr, err := transcript.Load(m.itemsPath(c.meta.ID))
	if err != nil {
		c.errText = err.Error()
		out.emitChat(c)
		return nil, err
	}
	c.tr = tr
	m.loadSubs(c)
	// Load closed the permission requests the file had open (the app was closed over them).
	if err := tr.Flush(false); err != nil {
		log.Printf("chats: flush %s: %v", c.meta.ID, err)
	}
	if c.interrupted {
		c.interrupted = false
		c.meta.TurnActive = false
		ups := tr.AddNote("error", "Stopped: the app was closed while the agent was working.")
		tr.SetStatus(model.StatusStopped)
		if err := tr.Flush(false); err != nil {
			log.Printf("chats: flush %s: %v", c.meta.ID, err)
		}
		m.logSave(c)
		out.emitItems(c, ups)
		out.emitChat(c)
	}
	// Until now the chat's view had no counts: clients learn here what a restart left owed.
	out.emitCounts(c)
	return tr, nil
}

// busy reports whether the chat's agent is working. c.mu held. An unloaded chat is never busy.
func busy(c *Chat) bool {
	if c.tr == nil {
		return false
	}
	st, _ := c.tr.Status()
	switch st {
	case model.StatusThinking, model.StatusWriting, model.StatusTool, model.StatusApproval:
		return true
	}
	return false
}

func (m *Manager) get(id string) (*Chat, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c, ok := m.chats[id]
	if !ok {
		return nil, ErrNotFound
	}
	return c, nil
}

// lock returns the chat object with the server id id, c.mu held, or ErrNotFound (also for a chat
// being deleted, so a late call, such as the auto namer's Rename, never writes its folder back,
// and for an unlisted one, which no caller can name yet). It is never re-routed to the current
// branch: the client-facing calls use lockCur or lockTop.
func (m *Manager) lock(id string) (*Chat, error) {
	c, err := m.get(id)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.deleted || c.unlisted {
		c.mu.Unlock()
		return nil, ErrNotFound
	}
	return c, nil
}

func (m *Manager) all() []*Chat {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Chat, 0, len(m.chats))
	for _, c := range m.chats {
		out = append(out, c)
	}
	return out
}

// ---- loading and reading --------------------------------------------------

// Load reads every chats/<id>/chat.json at boot, and the branches each chat's tree record names
// (see loadBranches), then the chats of the runs (see loadRunChats). items.jsonl is not read here.
// A folder without a readable chat.json is logged and skipped (never deleted).
func (m *Manager) Load() error {
	ents, err := os.ReadDir(m.Store.P.Chats)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(m.chatDir(e.Name()), "chat.json"))
		if err != nil {
			log.Printf("chats: skipping %s: %v", e.Name(), err)
			continue
		}
		var meta model.ChatMeta
		if err := json.Unmarshal(raw, &meta); err != nil || meta.ID == "" {
			if err == nil {
				err = errors.New("no id")
			}
			log.Printf("chats: skipping %s: %v", e.Name(), err)
			continue
		}
		c := &Chat{meta: meta, interrupted: meta.TurnActive}
		m.chats[meta.ID] = c
		m.registerChatToken(meta.Token)
		m.loadBranches(c, meta.ID)
	}
	m.loadRunChats()
	return nil
}

// Views returns every chat's view, oldest first: one per top-level chat, never one for a branch
// or for a run agent's chat.
func (m *Manager) Views() []model.ChatView {
	cs := m.all()
	out := make([]model.ChatView, 0, len(cs))
	for _, c := range cs {
		if c.top != nil || c.role != "" {
			continue
		}
		c.mu.Lock()
		v, unlisted := view(c), c.unlisted
		c.mu.Unlock()
		if !unlisted {
			out = append(out, m.composed(c, v))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Created.Equal(out[j].Created) {
			return out[i].Created.Before(out[j].Created)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// View is the view of the top-level chat id: its own identity, the settings and state of its
// current branch.
func (m *Manager) View(id string) (model.ChatView, error) {
	c, err := m.lockTop(id)
	if err != nil {
		return model.ChatView{}, err
	}
	v := view(c)
	c.mu.Unlock()
	return m.composed(c, v), nil
}

// Items returns the history of the chat's current branch and its version, reading items.jsonl
// the first time, and that branch's subagents, sorted by Started, then ID.
func (m *Manager) Items(id string) (int, []model.Item, []model.Subagent, error) {
	_, v, items, subs, err := m.ItemsOf(id, "")
	return v, items, subs, err
}

// ---- creating and configuring ---------------------------------------------

// catalog is the model list for a: the stored one, else (Claude only) the built-in one. Claude's
// is never nil; Cursor's and pi's are nil until the agent has reported its list. The result is
// a shallow copy; callers must not modify its slices.
func (m *Manager) catalog(a model.AgentKind) *model.Catalog {
	var cat *model.Catalog
	m.Store.Read(func(s *model.State) {
		if c := s.Catalog(a); c != nil {
			cp := *c
			cat = &cp
		}
	})
	if cat == nil && a == model.Claude {
		cp := claude.Catalog
		cat = &cp
	}
	return cat
}

// effortFor is the effort a process of model modelID starts with: for Claude, none when the
// catalog lists the model without efforts; else the stored effort (also for a model the catalog
// does not know, and always for Cursor and pi).
func (m *Manager) effortFor(a model.AgentKind, modelID, effort string) string {
	if a != model.Claude {
		return effort
	}
	if cm, _ := findModel(m.catalog(a), modelID); cm != nil && len(cm.Efforts) == 0 {
		return ""
	}
	return effort
}

func (m *Manager) groupExists(g string) bool {
	if g == model.Ungrouped {
		return true
	}
	found := false
	m.Store.Read(func(s *model.State) {
		for _, gr := range s.Groups {
			if gr.ID == g {
				found = true
				return
			}
		}
	})
	return found
}

// Create makes a chat. No agent starts: it starts on the first Send.
func (m *Manager) Create(a model.AgentKind, group, board string) (model.ChatView, error) {
	if a != model.Claude && a != model.Cursor && a != model.Pi {
		return model.ChatView{}, fmt.Errorf("unknown agent %q", a)
	}
	if board != "" {
		bd, ok := m.Boards.Get(board)
		if !ok {
			return model.ChatView{}, boards.ErrNotFound
		}
		if bd.Archived {
			return model.ChatView{}, boards.ErrArchived
		}
		group = bd.Group
	} else if !m.groupExists(group) {
		return model.ChatView{}, fmt.Errorf("no such group %q", group)
	}
	var d model.Defaults
	m.Store.Read(func(s *model.State) { d = s.Defaults })
	cwd, mc := defaults.Resolve(d, group, a, m.DefaultCwd, m.catalog(a))

	meta := model.ChatMeta{ID: uuid(), Agent: a, Board: board, Cwd: cwd,
		Model: mc.Model, Effort: mc.Effort, Created: time.Now()}
	if board == "" {
		meta.Group = group
	}
	m.extrasMu.Lock()
	meta.Token = m.uniqueTokenLocked()
	m.extrasMu.Unlock()
	if a == model.Claude || a == model.Pi {
		meta.SessionID = uuid() // the app assigns it; pi starts/resumes with it
	}
	if err := os.MkdirAll(m.chatDir(meta.ID), 0o700); err != nil {
		return model.ChatView{}, err
	}
	c := &Chat{meta: meta, subs: map[string]*sub{}, subByTool: map[string]string{}}
	tr, err := transcript.Load(m.itemsPath(meta.ID)) // no file yet: empty
	if err != nil {
		return model.ChatView{}, err
	}
	c.tr = tr
	if err := m.save(c); err != nil {
		return model.ChatView{}, err
	}
	m.mu.Lock()
	m.chats[meta.ID] = c
	m.mu.Unlock()

	var out outbox
	c.mu.Lock()
	out.emitChat(c)
	v := view(c)
	c.mu.Unlock()
	m.send(out)
	return v, nil
}

// Open is called when the client selects the chat. It never starts an agent; it only reads the
// history and shows a missing folder before the user types. Of a run agent's chat it only reads
// the history: the checkout a finished task agent worked in is removed by design.
func (m *Manager) Open(id string) error {
	var out outbox
	defer func() { m.send(out) }()
	c, err := m.lockCur(id)
	if err != nil {
		return err
	}
	defer c.mu.Unlock()
	tr, err := m.trOf(c, &out)
	if err != nil {
		return err
	}
	if c.role == "" && c.meta.Locked && !m.parentOf(c).Archived && c.ag == nil {
		if _, err := os.Stat(c.meta.Cwd); err != nil {
			c.folderMissing = true
			c.errText = folderMissingText(c.meta.Cwd)
			tr.SetStatus(model.StatusError)
			out.emitChat(c)
		}
	}
	return nil
}

func folderMissingText(cwd string) string {
	return "Folder not found: " + cwd + ". Pick another folder to continue."
}

// spawn starts the chat's agent if it has none: a resume when the chat is locked, else a new
// session. c.mu held; only Send calls it, and not for a chat that still has its fork source and
// no process (see spawnFork).
func (m *Manager) spawn(c *Chat, out *outbox) error {
	tr, err := m.trOf(c, out)
	if err != nil {
		return err
	}
	if p := m.parentOf(c); p.Archived {
		return ErrArchived
	} else if p.InstructionsSent {
		return ErrLegacy
	}
	if c.ag != nil {
		return nil
	}
	opts := m.spawnOptions(c)
	sp := m.Spawners[c.meta.Agent]
	if sp == nil {
		err = fmt.Errorf("no spawner for agent %q", c.meta.Agent)
	} else {
		var ag agent.Agent
		ag, err = sp.Spawn(opts)
		if err == nil {
			m.attach(c, ag)
			return nil
		}
	}
	m.spawnFailed(c, tr, err, out)
	return err
}

// attach makes ag the chat's process and starts its pump. c.mu held.
func (m *Manager) attach(c *Chat, ag agent.Agent) {
	c.folderMissing = false
	c.errText = ""
	c.gen++
	c.ag = ag
	c.lateEnd = ""
	c.costFirst = true
	go m.pump(c, ag, c.gen)
}

// spawnFailed shows on the chat that its agent could not be started. c.mu held.
func (m *Manager) spawnFailed(c *Chat, tr *transcript.Transcript, err error, out *outbox) {
	if errors.Is(err, ErrFolderMissing) {
		c.folderMissing = true
		c.errText = folderMissingText(c.meta.Cwd)
	} else {
		c.errText = err.Error()
	}
	tr.SetStatus(model.StatusError)
	out.emitChat(c)
}

// spawnFork starts the agent of a chat that still has its fork source and no process (D9 of the
// chat forking plan): through the fork capability, with the chat's own session id. Claude then
// makes the forked session again or, when it already exists, resumes it.
//
// Made again, the fork is cut at the id of its point. A fork made at a place no id names (the end
// of a chat whose last turn has no id) can only be made of the whole source session, which is the
// fork's prefix only while the source has said nothing since: once it has, or is gone, the start
// is refused with errForkGone. A fork that was sent a message is not looked at: it has a session
// of its own, which the start resumes.
//
// c.mu is held on entry and on return, but not during the look at the source, which locks that
// chat, or the start: the starting process looks its token up, which locks every chat. Meanwhile
// the chat is busy (thinking), so a second Send or a fork gets ErrBusy. A failed or refused start
// is shown as a failed spawn is. Only Send calls it, after its own checks.
func (m *Manager) spawnFork(c *Chat, out *outbox) error {
	tr, err := m.trOf(c, out)
	if err != nil {
		return err
	}
	fk, ok := m.Spawners[c.meta.Agent].(agent.Forker)
	if !ok {
		err = errNoForker(c.meta.Agent)
		m.spawnFailed(c, tr, err, out)
		return err
	}
	fs := *c.meta.ForkSource
	_, items := tr.Snapshot()
	whole := fs.Point == "" && !sentPast(items, fs.Items) // made of the whole source, with nothing to cut at
	opts := m.spawnOptions(c)
	was, _ := tr.Status()
	tr.SetStatus(model.StatusThinking)
	out.emitChat(c)
	c.mu.Unlock()
	m.send(*out)
	*out = nil
	var ag agent.Agent
	var sid string
	if whole && !m.sourceKept(fs.Chat, fs.Items) {
		err = errForkGone
	} else {
		ag, sid, err = fk.SpawnFork(opts, agent.ForkSource{ChatID: fs.Chat, Dir: m.chatDir(fs.Chat), SessionID: fs.Session, Point: fs.Point, Next: fs.Next})
	}
	c.mu.Lock()
	if err == nil && (c.deleted || m.parentOf(c).Archived || m.down.Load()) {
		// Deleted or archived during the start, or the server began to shut down and may have
		// been at this chat already: the message goes nowhere.
		go ag.Close()
		if st, _ := tr.Status(); st == model.StatusThinking && !c.deleted {
			tr.SetStatus(was)
			out.emitChat(c)
		}
		if c.deleted {
			return ErrNotFound
		}
		if m.down.Load() {
			return ErrShutdown
		}
		return ErrArchived
	}
	if err != nil {
		if !c.deleted {
			m.spawnFailed(c, tr, err, out)
		}
		return err
	}
	c.meta.SessionID = sid
	m.attach(c, ag)
	return nil
}

// spawnOptions are the options c's agent starts with. c.mu held.
// MCP URL+token and the chat object's folder are set for every chat; board extras only when the
// chat belongs to a board; what a chat on a run and a run's agent start with is in runOptions.
func (m *Manager) spawnOptions(c *Chat) agent.SpawnOptions {
	m.ensureToken(c)
	opts := agent.SpawnOptions{ChatID: c.meta.ID, SessionID: c.meta.SessionID, Resume: c.meta.Locked,
		Cwd: c.meta.Cwd, Model: c.meta.Model, Effort: m.effortFor(c.meta.Agent, c.meta.Model, c.meta.Effort),
		MCP: &agent.BoardAccess{MCPURL: m.MCPURL, Token: c.meta.Token}, BoardID: c.meta.Board,
		Dir: m.chatDir(c.meta.ID)}
	if c.meta.Agent == model.Cursor && !c.meta.Locked {
		opts.SessionID = ""
	}
	runOptions(c, &opts, false)
	return opts
}

// pump turns one agent process's events into items and chat changes.
func (m *Manager) pump(c *Chat, ag agent.Agent, gen int) {
	for ev := range ag.Events() {
		var out outbox
		c.mu.Lock()
		if gen != c.gen || c.tr == nil || c.deleted {
			c.mu.Unlock()
			continue // replaced by Stop
		}
		before := view(c)
		wasBusy := busy(c)
		wasTurn, subsRan := turnRunning(c), runningAppSubs(c) > 0
		if ev.Sub != "" && ev.Kind != agent.EvPermRequest {
			d := m.routeSub(c, ev, &out)
			out.emitCounts(c)
			c.mu.Unlock()
			m.send(out)
			m.handOff(c, d)
			continue
		}
		if late, counts := lateEvent(c, ev); late {
			if counts {
				c.meta.Usage.Turns++
				m.logSave(c)
				out.emitChat(c)
			}
			c.mu.Unlock()
			m.send(out)
			continue
		}
		if c.carry != nil && modelOutput(ev) {
			c.carry.settled = true // the results it carries are delivered
		}
		if ev.Kind == agent.EvPermRequest && ev.Sub != "" {
			ev.Sub = c.subByTool[ev.Sub] // the perm item names the sid ("" if unknown)
		}
		switch ev.Kind {
		case agent.EvSession:
			c.meta.SessionID = ev.SessionID
		case agent.EvCatalog:
			if ev.Catalog != nil {
				cat := *ev.Catalog
				if err := m.Store.Update(func(s *model.State) error { s.SetCatalog(c.meta.Agent, &cat); return nil }); err != nil {
					log.Printf("chats: store %s catalog: %v", c.meta.Agent, err)
				}
				out = append(out, map[string]any{"type": "catalog", "agent": string(c.meta.Agent), "catalog": cat})
			}
		case agent.EvUsage:
			u := &c.meta.Usage
			if ev.CtxError != "" {
				u.CtxError = ev.CtxError // the numbers keep their last good values
			} else {
				if ev.CtxIn != 0 {
					u.CtxIn = ev.CtxIn
					// The peak of a run's chat; chat.json gets it with the turn end's write.
					if k := costOf(c); k != nil && ev.CtxIn > k.Peak {
						k.Peak = ev.CtxIn
					}
				}
				if ev.CtxOut != 0 {
					u.CtxOut = ev.CtxOut
				}
				if ev.CtxWindow != 0 {
					u.CtxWindow = ev.CtxWindow
				}
				u.CtxError = ""
			}
		case agent.EvTurnEnd:
			u := &c.meta.Usage
			u.Turns++
			c.meta.TurnActive = false
			c.wait.turnEnded(ev)
			costTurnEnd(c, ev)
			if c.sentGen == gen {
				// The forked session has had a turn of its own and can be resumed from now on.
				// A turn end before any Send to this process drops nothing.
				c.meta.ForkSource = nil
			}
		case agent.EvExit:
			c.ag = nil
			c.wait.exited(ev.ExitErr, wasBusy || subsRan)
			if wasTurn {
				costLost(c, c.meta.Agent) // the turn it was in reports no cost any more
			}
		}
		ups := c.tr.Apply(ev)
		if ev.Kind == agent.EvTurnEnd {
			// The end mark of the turn, after its "Stopped." or error note.
			ups = append(ups, c.tr.AddEnd(ev.Point)...)
		}
		if ev.Kind == agent.EvPermRequest && c.role != "" {
			// Nobody answers for a run's agent (see denyAtOnce).
			ups = append(ups, denyAtOnce(c, ev.Sub, ev.PermID)...)
			if err := c.tr.Flush(false); err != nil {
				log.Printf("chats: flush %s: %v", c.meta.ID, err)
			}
		}
		if len(c.pendingLinks) > 0 {
			m.reconcileSpawnLinks(c, &out)
		}
		// Ahead of the cards stopSubs closes below: a client drops an update whose version it has.
		out.emitItems(c, ups)
		var toClose []agent.Agent
		if (ev.Kind == agent.EvTurnEnd && ev.Aborted) || ev.Kind == agent.EvExit {
			// An interrupt or cancel stops every subagent; background ones die with the process.
			// A normal turn end leaves them alone: Claude's background subagents outlive it.
			toClose = m.stopSubs(c, &out)
		}
		if st, _ := c.tr.Status(); !wasBusy && busy(c) && st != model.StatusApproval && !c.meta.TurnActive {
			// A turn the agent started by itself (Claude, when a background subagent finishes).
			c.meta.TurnActive = true
			m.logSave(c)
		}
		switch ev.Kind {
		case agent.EvTurnEnd, agent.EvToolResult, agent.EvToolDenied, agent.EvExit, agent.EvSession:
			if err := c.tr.Flush(false); err != nil {
				log.Printf("chats: flush %s: %v", c.meta.ID, err)
			}
			m.logSave(c)
		}
		if view(c) != before {
			out.emitChat(c)
		}
		var d *carry
		if ev.Kind == agent.EvTurnEnd || ev.Kind == agent.EvExit {
			d = m.turnOver(c, ev, &out)
		}
		out.emitCounts(c)
		c.mu.Unlock()
		m.send(out)
		closeAgents(toClose)
		m.handOff(c, d)
	}
}

// Send posts one user turn, starting (or resuming) the agent if it has no process. refs are the
// parts of earlier messages the user quoted: the agent gets them as <reference> blocks in front of
// the text, and the user item keeps them. The message goes to the chat's current branch. An
// accepted Send releases that branch's hold and carries the subagent results the agent is owed,
// unless their delivery failed before: their rows go ahead of the user item and their block ahead
// of the text, after a board chat's context. With nothing owed the message is what it always was.
//
// It waits for a Send with a target that is changing the chat's current branch (see moveMu): the
// message goes to the branch that is current after it, never to the one it stops.
func (m *Manager) Send(id, text, context string, refs []model.Reference) error {
	if err := m.person(id); err != nil {
		return err
	}
	top, err := m.topChat(id)
	if err != nil {
		return err
	}
	top.moveMu.Lock()
	return m.sendCur(top, id, text, context, refs)
}

// sendCur is Send on the current branch of the top-level chat top, whose id is id. top.moveMu is
// held on entry and released once that branch is locked, ahead of the start of its process. That
// is enough: sendOn releases the branch's lock only when the branch is busy or the message
// refused, and a Send with a target checks under moveMu that the current branch is idle.
func (m *Manager) sendCur(top *Chat, id, text, context string, refs []model.Reference) error {
	c, err := m.lockCur(id)
	top.moveMu.Unlock()
	if err != nil {
		return err
	}
	return m.sendOn(c, text, context, refs)
}

// sendOn is Send on the chat object c, which may still be unlisted. c.mu is held on entry and
// released. On a branch the first-send effects (group defaults, auto-naming) never run, and the
// draft cleared is the top-level chat's, once the branch is listed.
//
// A chat on a run feeds no sticky defaults, and every message of it starts with the run's
// context block (RunOwner.ChatContext), as a board chat's does with its board's. For a run
// agent's chat it is SendOwned's: the wait of that message starts here, and nothing of the
// human's (the namer, quotes, the draft) is touched.
func (m *Manager) sendOn(c *Chat, text, context string, refs []model.Reference) error {
	var out outbox
	var err error
	if m.down.Load() {
		// In the hold of c.mu that would start the process (see Manager.down).
		c.mu.Unlock()
		return ErrShutdown
	}
	p := m.parentOf(c)
	if p.Archived {
		c.mu.Unlock()
		return ErrArchived
	}
	if p.InstructionsSent {
		c.mu.Unlock()
		return ErrLegacy
	}
	if c.meta.Run != "" {
		if _, err := m.openRun(c.meta.Run); err != nil {
			c.mu.Unlock()
			return err
		}
	}
	if busy(c) {
		c.mu.Unlock()
		return ErrBusy
	}
	if c.role == "" && !validReferences(c.tr, refs) {
		c.mu.Unlock()
		return ErrBadReference
	}
	if c.meta.ForkSource != nil && c.ag == nil {
		err = m.spawnFork(c, &out)
	} else {
		err = m.spawn(c, &out)
	}
	if err != nil {
		c.mu.Unlock()
		m.send(out)
		return err
	}
	if c.role != "" {
		// After the start, so a start that failed leaves the wait of the message before; ahead of
		// everything the message adds to the thread.
		c.wait = &ownedWait{from: c.tr.Len()}
		wakeOwned(c) // a WaitOwned of the message before answers ErrSuperseded
	}
	releaseHold(c)
	first := !c.meta.Locked && c.top == nil
	if first && c.meta.Run == "" {
		// Sending the first message confirms the chat's settings as chosen, changed or not.
		m.recordDefaults(c, c.meta.Cwd, model.ModelChoice{Model: c.meta.Model, Effort: c.meta.Effort}, &out)
	}
	c.meta.Locked = true
	c.meta.TurnActive = true // in the hold of c.mu that started the process: its first tools/list finds a running turn
	if c.role == "" {
		c.meta.Draft = nil // the message is the draft, sent
	}
	var blocks []agent.ContentBlock
	if rc := m.runContext(c); rc != "" {
		context = rc
		blocks = append(blocks, agent.ContentBlock{Text: context})
	} else if c.meta.Board != "" {
		if c.meta.Agent == model.Cursor && !c.meta.McpInstructionsSent && !c.meta.InstructionsSent {
			// Cursor has no system-prompt slot; inject the same whiteboard body Claude and pi get.
			blocks = append(blocks, agent.ContentBlock{Text: prompts.Claude()})
			c.meta.McpInstructionsSent = true
		}
		if context == "" { // every board chat message names its board
			name := c.meta.Board
			if bd, ok := m.Boards.Get(c.meta.Board); ok {
				name = bd.Name
			}
			context = prompts.BoardContext(name, c.meta.Board)
		}
		blocks = append(blocks, agent.ContentBlock{Text: context})
	} else {
		context = "" // plain chats never get board context
	}
	d, taken, ups := m.carryOwed(c, true, &out)
	if d != nil {
		blocks = append(blocks, agent.ContentBlock{Text: subResultsBlock(taken, runningAppSubs(c), true)})
		c.carry = d
	}
	blocks = append(blocks, agent.ContentBlock{Text: withReferences(refs, text)})
	ups = append(ups, c.tr.AddUser(text, context, refs)...)
	if err := c.tr.Flush(false); err != nil {
		log.Printf("chats: flush %s: %v", c.meta.ID, err)
	}
	m.logSave(c)
	name, userNamed := c.meta.Name, c.meta.UserNamed
	id, kind := c.meta.ID, c.meta.Agent
	ag := c.ag
	c.sentGen = c.gen
	sent := c.tr.Sent()
	out.emitItems(c, ups)
	out.emitChat(c)
	listed := !c.unlisted
	c.mu.Unlock()
	if c.top != nil && listed {
		m.clearDraft(c.top) // one draft per chat; the chat event above is composed after it
	}
	m.send(out)
	if first && name == "" && !userNamed && c.role == "" {
		if namer := m.Namers[kind]; namer != nil {
			m.naming.Add(1)
			go func() {
				defer m.naming.Done()
				if t, err := namer.Name(PlainText(text)); err == nil {
					m.Rename(id, t, false)
				}
			}()
		}
	}
	err = ag.Send(blocks)
	if err != nil {
		m.sendRefused(c, d, sent)
	}
	return err
}

// Configure changes the folder, model or effort before the first message; after it, only a
// new folder for a chat whose folder is missing. It acts on the chat's current branch. A new
// folder for a missing one is the chat's: it is also written to every other branch that has the
// missing folder (see fixFolder). A branch with another folder keeps it.
func (m *Manager) Configure(id string, req ConfigReq) error {
	if err := m.person(id); err != nil {
		return err
	}
	var out outbox
	c, err := m.lockCur(id)
	if err != nil {
		return err
	}
	unlock := func() { c.mu.Unlock(); m.send(out) }
	p := m.parentOf(c)
	if p.Archived {
		unlock()
		return ErrArchived
	}
	if p.InstructionsSent {
		unlock()
		return ErrLegacy
	}
	onlyFolderFix := c.meta.Locked && c.folderMissing && req.Model == "" && req.Effort == "" && req.Cwd != ""
	if c.meta.Locked && !onlyFolderFix {
		unlock()
		return ErrLocked
	}
	next := c.meta
	abs := ""
	if req.Cwd != "" {
		abs, err = expandDir(req.Cwd)
		if err != nil {
			unlock()
			return err
		}
		if m.Store.P.Contains(abs) {
			unlock()
			return ErrAppFolder
		}
		next.Cwd = abs
	}
	cat := m.catalog(c.meta.Agent)
	if req.Model != "" {
		cm, err := findModel(cat, req.Model)
		if err != nil {
			unlock()
			return err
		}
		next.Model = req.Model
		if cm != nil && !slices.Contains(cm.Efforts, next.Effort) {
			// The chat must never hold an effort its model lacks: fall back to the model's
			// default effort, or none when the model has no efforts.
			next.Effort = ""
			if len(cm.Efforts) > 0 {
				next.Effort = cm.DefaultEffort
			}
		}
	}
	if req.Effort != "" {
		cm, err := findModel(cat, next.Model)
		if err != nil {
			unlock()
			return err
		}
		if cm != nil && !slices.Contains(cm.Efforts, req.Effort) {
			unlock()
			return fmt.Errorf("%s has no effort %q", next.Model, req.Effort)
		}
		next.Effort = req.Effort
	}
	// The folder fix: a new folder for the missing one, gone.
	fix, gone := req.Cwd != "" && c.folderMissing, c.meta.Cwd
	c.meta = next
	if fix {
		c.folderMissing = false
		c.errText = ""
		if tr, err := m.trOf(c, &out); err == nil {
			tr.SetStatus(model.StatusReady)
		}
	}
	if err := m.save(c); err != nil {
		unlock()
		return err
	}
	if c.meta.Run == "" { // a chat on a run feeds no sticky defaults
		m.recordDefaults(c, abs, model.ModelChoice{Model: req.Model, Effort: req.Effort}, &out)
	}
	out.emitChat(c)
	unlock()
	if fix {
		m.fixFolder(c, gone, abs)
	}
	return nil
}

// fixFolder gives the folder cwd to every branch of c's chat, other than c, whose folder is the
// missing one, gone, and takes back the error a failed start for that folder left on it. Nothing
// else of the branch is touched: a process it has runs on where it is, and the folder is used
// when the branch next starts. Clients are sent nothing: the chat's view holds the folder of the
// current branch, which Configure has sent. One branch is locked at a time; no chat's mu may be
// held.
func (m *Manager) fixFolder(c *Chat, gone, cwd string) {
	for _, b := range m.branchesOf(topOf(c)) {
		if b == c {
			continue
		}
		b.mu.Lock()
		if !b.deleted && b.meta.Cwd == gone {
			b.meta.Cwd = cwd
			if b.folderMissing {
				b.folderMissing = false
				b.errText = ""
				if b.tr != nil {
					b.tr.SetStatus(model.StatusReady)
				}
			}
			m.logSave(b)
		}
		b.mu.Unlock()
	}
}

// recordDefaults stores cwd and mc as the chosen defaults for c's group and "last", and queues a
// defaults event. Empty fields are left alone. c.mu held.
func (m *Manager) recordDefaults(c *Chat, cwd string, mc model.ModelChoice, out *outbox) {
	group := m.GroupOf(c.meta)
	var defs json.RawMessage
	if err := m.Store.Update(func(s *model.State) error {
		defaults.RecordChange(&s.Defaults, group, c.meta.Agent, cwd, mc)
		defs, _ = json.Marshal(s.Defaults) // a copy, taken under the store's lock
		return nil
	}); err != nil {
		log.Printf("chats: record defaults: %v", err)
	}
	if defs != nil {
		*out = append(*out, map[string]any{"type": "defaults", "defaults": defs})
	}
}

// findModel looks id up in cat. A nil catalog (Cursor's or pi's list not known yet) accepts any
// model.
func findModel(cat *model.Catalog, id string) (*model.CatalogModel, error) {
	if cat == nil {
		return nil, nil
	}
	for i := range cat.Models {
		if cat.Models[i].ID == id {
			return &cat.Models[i], nil
		}
	}
	return nil, fmt.Errorf("unknown model %q", id)
}

// expandDir resolves ~ and relative paths and checks the result is a directory (prototype).
func expandDir(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		return "", fmt.Errorf("%s is not a directory", abs)
	}
	return abs, nil
}

// ---- other changes --------------------------------------------------------

// Rename sets the chat's name. An automatic name never overwrites the user's.
func (m *Manager) Rename(id, name string, byUser bool) error {
	if err := m.person(id); err != nil {
		return err
	}
	var out outbox
	c, err := m.lockTop(id)
	if err != nil {
		return err
	}
	if !byUser && c.meta.UserNamed {
		c.mu.Unlock()
		return nil
	}
	c.meta.Name = strings.TrimSpace(name)
	c.meta.UserNamed = c.meta.UserNamed || byUser
	err = m.save(c)
	out.emitIdentity(c)
	c.mu.Unlock()
	m.send(out)
	return err
}

// validReferences reports whether every quote is non-empty and points to a user message or an
// agent reply in the chat's thread.
func validReferences(tr *transcript.Transcript, refs []model.Reference) bool {
	if len(refs) == 0 {
		return true
	}
	_, items := tr.Snapshot()
	return refsIn(items, refs)
}

// refsIn is validReferences for an item list: the thread, or the part of it a new branch keeps.
func refsIn(items []model.Item, refs []model.Reference) bool {
	for _, r := range refs {
		if strings.TrimSpace(r.Quote) == "" || r.Item < 0 || r.Item >= len(items) {
			return false
		}
		if k := items[r.Item].Kind; k != "user" && k != "text" {
			return false
		}
	}
	return true
}

var xmlEscape = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")

// withReferences is the message the agent gets: a <reference> block for each quote, in order,
// then the text. It has no positions, and no <comment> for a quote without one.
func withReferences(refs []model.Reference, text string) string {
	var parts []string
	for _, r := range refs {
		b := "<reference>\n<quote>" + xmlEscape.Replace(r.Quote) + "</quote>\n"
		if strings.TrimSpace(r.Comment) != "" {
			b += "<comment>" + xmlEscape.Replace(r.Comment) + "</comment>\n"
		}
		parts = append(parts, b+"</reference>")
	}
	if text != "" || len(parts) == 0 {
		parts = append(parts, text)
	}
	return strings.Join(parts, "\n\n")
}

// SetDraft stores the message typed in the chat's composer; empty text and no quotes clear it.
func (m *Manager) SetDraft(id string, d model.Draft) error {
	if err := m.person(id); err != nil {
		return err
	}
	var out outbox
	c, err := m.lockTop(id)
	if err != nil {
		return err
	}
	if d.Text == "" && len(d.References) == 0 {
		c.meta.Draft = nil
	} else {
		c.meta.Draft = &d
	}
	err = m.save(c)
	out.emitIdentity(c)
	c.mu.Unlock()
	m.send(out)
	return err
}

// Interrupt asks the running agent to stop its turn, and holds the chat: the app starts no turn on
// it until the user sends. App-spawned subagents are terminated immediately; native ones wait for
// the aborted turn end, as they always have. With no turn running no aborted end follows, so the
// "Stopped." note for the subagents it stopped is written here. A turn carrying subagent results
// is marked as stopped by the human: if it ends with no model output, they are owed again.
//
// While subagent results are being handed to the agent (handOff), the agent is signalled only once
// it has the message, and Interrupt does not wait for that.
func (m *Manager) Interrupt(id string) error {
	if err := m.person(id); err != nil {
		return err
	}
	return m.interrupt(id)
}

// interrupt is Interrupt for whoever drives the chat: a person, or the run that owns it
// (StopOwned).
func (m *Manager) interrupt(id string) error {
	var out outbox
	c, err := m.lockCur(id)
	if err != nil {
		return err
	}
	setHold(c)
	ag := c.ag
	stopped := runningAppSubs(c)
	toClose := m.stopAppSubs(c, &out)
	if stopped > 0 && c.tr != nil {
		if !turnRunning(c) {
			out.emitItems(c, c.tr.AddNote("muted", "Stopped."))
		}
		if err := c.tr.Flush(false); err != nil {
			log.Printf("chats: flush %s: %v", c.meta.ID, err)
		}
	}
	late := false
	if d := c.carry; d != nil {
		d.human = true
		if late = d.handing; late {
			d.stop = true
		}
	}
	out.emitCounts(c)
	c.mu.Unlock()
	m.send(out)
	closeAgents(toClose)
	if ag == nil || late {
		return nil
	}
	return ag.Interrupt()
}

// Decide answers a permission request. The request is named by who asked together with its id:
// asker is the subagent on its card, "" for the chat's own agent. The answer goes to the asker's
// process and to that request's card, and to nothing when the request is not open (ErrNoRequest).
func (m *Manager) Decide(id, asker, requestID string, allow bool) error {
	var out outbox
	var d *carry
	c, err := m.lockCur(id)
	if err != nil {
		return err
	}
	defer func() { c.mu.Unlock(); m.send(out); m.handOff(c, d) }()
	tr, err := m.trOf(c, &out)
	if err != nil {
		return err
	}
	if !tr.PermOpen(asker, requestID) {
		return ErrNoRequest
	}
	ag := permAgent(c, asker)
	if ag == nil {
		return errors.New("the agent is not running")
	}
	if err := ag.Decide(requestID, allow); err != nil {
		return err
	}
	before := view(c)
	if m.permsClosed(c, before, tr.Decided(asker, requestID, allow), &out) {
		d = m.deliver(c, &out)
	}
	return nil
}

// permAgent is the process that holds asker's permission requests: an app-spawned subagent's own,
// else the chat's, which holds its own and its native subagents'. nil when that process is gone.
// c.mu held.
func permAgent(c *Chat, asker string) agent.Agent {
	if s := c.subs[asker]; s != nil && s.app {
		return s.ag
	}
	return c.ag
}

// permsClosed writes and sends ups, the thread's changes after permission requests were answered
// (Decide) or closed because the subagent that asked reached a final status (endSub), and the
// chat's view when that changed it; before is the view from before. These two are how a chat
// leaves approval while no turn of its own agent is running; it reports whether the chat left
// approval, which is when a caller that may start a turn checks for owed results (deliver).
// c.mu held.
func (m *Manager) permsClosed(c *Chat, before model.ChatView, ups []transcript.Update, out *outbox) bool {
	if len(ups) == 0 {
		return false
	}
	if err := c.tr.Flush(false); err != nil {
		log.Printf("chats: flush %s: %v", c.meta.ID, err)
	}
	out.emitItems(c, ups)
	now := view(c)
	if now != before {
		out.emitChat(c)
	}
	return before.Status == model.StatusApproval && now.Status != model.StatusApproval
}

// Move puts a plain chat in another group. Its settings are unchanged.
func (m *Manager) Move(id, group string) error {
	if err := m.person(id); err != nil {
		return err
	}
	if !m.groupExists(group) {
		return fmt.Errorf("no such group %q", group)
	}
	var out outbox
	c, err := m.lockTop(id)
	if err != nil {
		return err
	}
	if c.meta.Board != "" {
		c.mu.Unlock()
		return errors.New("a board chat moves with its board")
	}
	if c.meta.Run != "" {
		c.mu.Unlock()
		return errors.New("a run's chat moves with its run")
	}
	c.meta.Group = group
	err = m.save(c)
	out.emitIdentity(c)
	c.mu.Unlock()
	m.send(out)
	return err
}

// Stop ends the chat's agent (archive, delete, board delete): every branch of the chat that is
// loaded or has a process is stopped, main included (see stopOne). It does nothing to a run
// agent's chat, which only its run stops (StopOwned).
func (m *Manager) Stop(id string) {
	if m.person(id) != nil {
		return
	}
	if top, err := m.topChat(id); err == nil {
		m.stopAll(top)
	}
}

// stopAll stops every branch of the top-level chat top.
func (m *Manager) stopAll(top *Chat) {
	for _, c := range m.branchesOf(top) {
		m.stopOne(c)
	}
}

// SetArchive sets the chat's archive state, which is the top-level chat's alone: its branches
// read it from there.
func (m *Manager) SetArchive(id string, a model.Archive) error {
	if err := m.person(id); err != nil {
		return err
	}
	var out outbox
	c, err := m.lockTop(id)
	if err != nil {
		return err
	}
	c.meta.Archive = a
	err = m.save(c)
	out.emitIdentity(c)
	c.mu.Unlock()
	m.send(out)
	return err
}

// Delete stops the chat and removes it and its history, its branches included: each is stopped
// and taken out of the manager, then the whole folder goes and one chat_removed is sent. The
// agent CLIs' own session files are left alone.
func (m *Manager) Delete(id string) error {
	if err := m.person(id); err != nil {
		return err
	}
	return m.remove(id, true)
}

// remove is Delete for whoever owns the chat: a person, or the run whose agent it is
// (DeleteOwned), which has chat_removed left out (announce false). The folder of a run's chat is
// under the run's: the agents/ or chats/ folder it was in goes with it when nothing else is there.
func (m *Manager) remove(id string, announce bool) error {
	top, err := m.topChat(id)
	if err != nil {
		return err
	}
	top.mu.Lock()
	top.removing = true
	top.mu.Unlock()
	m.stopAll(top)
	top, err = m.lockTop(id)
	if err != nil {
		return err
	}
	inRun := top.meta.Run != ""
	top.mu.Unlock()
	if !m.retire(top) {
		return ErrNotFound // deleted meanwhile
	}
	m.mu.Lock()
	var branches []*Chat // the registered ones, and one a Send is still making
	for _, b := range m.chats {
		if b.top == top {
			branches = append(branches, b)
		}
	}
	m.mu.Unlock()
	for _, b := range branches {
		m.retire(b)
	}
	dir := m.chatDir(id)
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if inRun {
		os.Remove(filepath.Dir(dir)) // fails, as it should, while another chat is in it
	}
	m.dropRoot(id) // after the folder: a late lookup never falls back to chats/<id>
	m.unwatch(id)
	if announce {
		m.Bridge.Broadcast(map[string]any{"type": "chat_removed", "id": id})
	}
	return nil
}

// ChatsOfBoard lists the top-level chats of a board.
func (m *Manager) ChatsOfBoard(boardID string) []model.ChatMeta {
	var out []model.ChatMeta
	for _, c := range m.all() {
		if c.top != nil {
			continue
		}
		c.mu.Lock()
		meta, unlisted := c.meta, c.unlisted
		c.mu.Unlock()
		if boardID != "" && meta.Board == boardID && !unlisted {
			out = append(out, meta)
		}
	}
	return out
}

// GroupOf is the board's group for board chats and the run's for a run's chats, else meta.Group.
// A chat whose board or run is gone counts as ungrouped. A branch's meta has no group: it is its
// top-level chat's (whose mu must not be held).
func (m *Manager) GroupOf(meta model.ChatMeta) string {
	if meta.Board != "" {
		if bd, ok := m.Boards.Get(meta.Board); ok {
			return bd.Group
		}
		return model.Ungrouped
	}
	if meta.Run != "" {
		if ri, ok := m.runOf(meta.Run); ok {
			return ri.Group
		}
		return model.Ungrouped
	}
	if chat, branch := splitID(meta.ID); branch != model.MainBranch {
		if top, err := m.get(chat); err == nil {
			top.mu.Lock()
			defer top.mu.Unlock()
			return top.meta.Group
		}
	}
	return meta.Group
}

// Busy reports whether the chat's agent (its current branch's) is thinking, writing, running a
// tool or waiting for approval.
func (m *Manager) Busy(id string) bool {
	c, err := m.lockCur(id)
	if err != nil {
		return false
	}
	defer c.mu.Unlock()
	return busy(c)
}

// Shutdown writes everything still open and ends every agent without waiting (the caller then
// ends what is left with agent.EndAll). A running turn keeps TurnActive, so the chat shows as
// Stopped next time. A turn carrying subagent results is settled here, as stopped by the human, so
// the closing process's exit, handled or not before the server ends, changes nothing. Every chat is
// held: a turn end the closing process still reports starts no delivery, and what is owed stays
// owed for the next run.
//
// From its first step on no process is started (see Manager.down): a message, a fork or a
// subagent that comes later is refused with ErrShutdown, and a process whose start had the chat's
// lock first is on the chat when Shutdown gets to it. It can be called again.
//
// The processes of a run's agents and of their subagents are the exception to "without waiting":
// nobody watches them, so what they started (shell commands in process groups of their own) is
// ended only by their adapters' Close, which agent.EndAll does not stand in for. Each is
// interrupted and closed, all at once, and Shutdown waits for those closes, no longer than
// ownedCloseWait.
func (m *Manager) Shutdown() {
	m.down.Store(true) // before the chats are listed: see Manager.down
	var owned []agent.Agent
	for _, c := range m.all() {
		var out outbox
		c.mu.Lock()
		setHold(c)
		if c.tr != nil && !c.unlisted { // nothing is written for an unlisted chat; its process is still closed
			if c.carry != nil {
				c.carry.human = true
				m.endCarry(c, false, &out)
			}
			if err := c.tr.Flush(true); err != nil {
				log.Printf("chats: flush %s: %v", c.meta.ID, err)
			}
			for _, s := range c.subs {
				m.flushSub(c, s, true) // native running ones stay running; the next load marks them stopped
			}
			m.logSave(c)
		}
		toClose := m.stopAppSubs(c, &out) // app-spawned processes must not outlive the server
		m.revokeChatExtras(c.meta.ID)
		if c.role != "" {
			if c.ag != nil {
				owned = append(owned, c.ag)
			}
			owned, toClose = append(owned, toClose...), nil
		} else if c.ag != nil {
			go c.ag.Close() // Cursor's Close waits for the process, forever when its children hold its output
		}
		out.emitCounts(c)
		c.mu.Unlock()
		m.send(out)
		closeAgents(toClose)
	}
	closeAndWait(owned, ownedCloseWait)
}

func uuid() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
