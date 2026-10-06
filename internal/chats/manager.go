// Package chats owns the chats: one agent per branch of a chat, the agent's events turned into items,
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
	// capMu makes the admission of a turn one step: counting the chat objects that work and
	// reserving a slot (see cap.go). It protects every Chat.reserved. It is taken with one chat's
	// mu held or none, and only Manager.mu is taken under it: a chat's mu → capMu → Manager.mu.
	capMu sync.Mutex
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
	deleted       bool               // removed by Delete: nothing more is written or emitted for it (see gone)
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
	// The cap on running turns (see cap.go). reserved says that a turn admitted on this chat
	// object is starting and pub does not show it yet; Manager.capMu guards it, not mu. noTurn
	// says that pub shows as working what is no turn: a message of the human's that the agent
	// refused, with nothing from the agent since (see sendRefused). It is written with mu held
	// and read without it, for the count.
	reserved bool
	noTurn   atomic.Bool

	// pub mirrors the status clients were last told of: idle, working or waiting for approval
	// (see pubOf). emitChat writes it with mu held; it is read without any lock, for the counts
	// over a chat's branches (see chatView).
	pub atomic.Uint32

	// gone is deleted for send, which holds no chat's mu: it is set with deleted when the chat
	// object is retired, and never cleared.
	gone atomic.Bool

	// goneMu makes "check that the chat is still there, broadcast" one step (see cast), so that
	// no state record and no view of a top-level chat follows its chat_removed, which Delete
	// broadcasts under it. It is a top-level chat's only and a leaf: only the bridge's lock is
	// taken under it, and it is never taken with a chat's mu or Manager.mu held.
	goneMu sync.Mutex

	// drafts publishes meta.Drafts of a top-level chat, which stays what is saved: a branch's
	// view reads its own draft here, without this chat's mu (see view). It is stored wherever
	// meta.Drafts is assigned (see setDrafts); nil when none was, which is no draft for a branch.
	drafts atomic.Pointer[map[string]*model.Draft]

	// sendMu makes "compose the view, broadcast it" one step for the chat events of a top-level
	// chat (see send): the counts over its branches are read when an event is sent, so two
	// events must reach clients in the order their counts were read. It is a top-level chat's
	// only, taken where no chat's mu, no treeMu and not Manager.mu is held (moveMu may be), and
	// held for nothing but chatView and the broadcast: under it come the chats' mu (one at a
	// time), Manager.mu, goneMu and the bridge's lock, and nothing that sends. A state record is
	// not sent under it: chatView waits for chats' locks, and a branch's records must not.
	sendMu sync.Mutex

	// treeMu serialises the changes of tree.json (see updateTree). It is taken before mu, never
	// while mu is held.
	treeMu sync.Mutex

	// treeOutMu makes "read the part, broadcast it" one step for the tree events of a top-level
	// chat (see emitTree), so that they reach clients in the order their parts were read and the
	// last one of a part is the newest. It is a top-level chat's only, taken where no chat's mu,
	// no treeMu, no sendMu and not Manager.mu is held (moveMu may be): under it come the chats'
	// mu (one at a time), Manager.mu, goneMu and the bridge's lock, and nothing that sends. The
	// tree record is read under it without treeMu, as Tree reads it.
	treeOutMu sync.Mutex

	// treeDirty says that a change of this chat object's part of the tree waits to be sent (see
	// emitTreePart): the tree event that sends the part clears it, and those queued behind it
	// for changes it has already told send nothing.
	treeDirty atomic.Bool

	// moveMu makes one step of the change of the chat's current branch: the tree record's Current
	// and cur change together, so the two never name different branches once a change is done.
	// It is taken by setCurrent and by the listing of a new branch (SendTo), for the write of the
	// record and the change in memory and nothing else. It does not decide whether a message may
	// go: that is decided under the mu of the branch the message goes to, where sendOn refuses a
	// busy branch, and a change of the current branch stops nothing. Send and SendTo do not hold
	// it while they send. It is taken before treeMu and any chat's mu, with none of the chat's
	// other locks held, and never held during the start of a process or an agent's Send.
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

// send broadcasts the queued events. No chat's mu may be held, and no treeMu nor Manager.mu: a
// chat event is composed here, under its top-level chat's sendMu. The tree events are built and
// sent after all the others, wherever they were queued, each under its top-level chat's
// treeOutMu with no sendMu held: a part of the tree follows the state record and the view of the
// change it is of. None of them, and no state record, is sent once its chat was deleted (see
// cast). The events of a run agent's chat go out only while a client watches it (see Watch), and
// no state record and no tree event of it ever: it has main alone, and its view tells its state.
func (m *Manager) send(out outbox) {
	var trees []treeEvent
	for _, ev := range out {
		switch e := ev.(type) {
		case chatEvent:
			top := topOf(e.c)
			top.sendMu.Lock()
			if v, ok := m.chatView(e); ok && (v.Role == "" || m.watching(v.ID)) {
				m.cast(top, map[string]any{"type": "chat", "chat": v})
			}
			top.sendMu.Unlock()
		case stateEvent:
			if e.c.role == "" {
				m.cast(e.c, map[string]any{"type": "branch_state", "state": e.state})
			}
		case treeEvent:
			if e.c.role == "" {
				trees = append(trees, e)
			}
		case agentEvent:
			if m.watching(e.chat) {
				m.Bridge.Broadcast(e.ev)
			}
		default:
			m.Bridge.Broadcast(ev)
		}
	}
	for _, e := range trees {
		m.emitTree(e.chat, topOf(e.c), e.c, false, false, true)
	}
}

// cast broadcasts ev, an event of the chat object c, unless c or its top-level chat was deleted.
// Delete retires the chat objects and then sends chat_removed under the same goneMu, so ev goes
// out before chat_removed or not at all. No chat's mu may be held.
func (m *Manager) cast(c *Chat, ev any) {
	top := topOf(c)
	top.goneMu.Lock()
	defer top.goneMu.Unlock()
	if !c.gone.Load() && !top.gone.Load() {
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

// The values of Chat.pub.
const (
	pubIdle uint32 = iota
	pubWorking
	pubApproval
)

// pubOf is the value of Chat.pub for the status st.
func pubOf(st model.Status) uint32 {
	switch st {
	case model.StatusThinking, model.StatusWriting, model.StatusTool:
		return pubWorking
	case model.StatusApproval:
		return pubApproval
	}
	return pubIdle
}

// stateEvent is a "branch_state" event waiting in an outbox: the state record of the chat object
// c, taken under its lock. It is sent as {type:"branch_state", state: <the record>}, unless c or
// its chat was deleted meanwhile (see send).
type stateEvent struct {
	c     *Chat
	state model.BranchState
}

// stateEventOf is the event of c's state record, v being c's own view. c.mu held.
func stateEventOf(c *Chat, v model.ChatView) stateEvent {
	chat, branch := splitID(c.meta.ID)
	return stateEvent{c: c, state: model.StateOf(chat, branch, v)}
}

// emitChat queues the two events of a change of c's session side (status, error, usage,
// settings): c's state record (see stateEvent), then {type:"chat", chat: <the chat's view>}. The
// chat event is sent when c is its chat's current branch, and for another branch only when the
// chat's counts of working branches changed with it (see chatView). When c started or stopped
// being busy, c's part of the tree follows them (see emitTreePart). c.mu held.
//
// It also writes c.pub, for an unlisted chat as well: every change of a chat object's status is
// followed by a call under the same hold of c.mu, which is what keeps the mirror right. Nothing
// is queued for an unlisted chat, here and in the other emit functions.
func (o *outbox) emitChat(c *Chat) {
	v := view(c)
	if v.Status != model.StatusThinking {
		c.noTurn.Store(false) // the flag lives only while a refused message's "thinking" shows
	}
	pub := pubOf(v.Status)
	old := c.pub.Swap(pub)
	if c.unlisted {
		return
	}
	c.shown = subCounts{v.SubsRunning, v.SubsOwed}
	*o = append(*o, stateEventOf(c, v), chatEvent{c: c, v: v, session: true, agg: old != pub})
	if (old == pubIdle) != (pub == pubIdle) {
		o.emitTreePart(c) // a turn started or ended: the tree shows it on the branch's points
	}
}

// emitRecord queues c's state record alone, for a change of it that is not one of c's session
// side: its draft, which the top-level chat holds for it, and the listing of a new branch. c.pub
// is left alone: only emitChat writes it. c.mu held.
func (o *outbox) emitRecord(c *Chat) {
	if c.unlisted {
		return
	}
	*o = append(*o, stateEventOf(c, view(c)))
}

// emitState sends the state record of the chat object c as it is now. It sends no chat event: its
// callers send the chat's view next (emitView), which has the counts. No chat's mu may be held.
func (m *Manager) emitState(c *Chat) {
	var out outbox
	c.mu.Lock()
	if !c.deleted {
		out.emitRecord(c)
	}
	c.mu.Unlock()
	m.send(out)
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
// archive, whether a branch has a draft), whatever its current branch is. c.mu held.
func (o *outbox) emitIdentity(c *Chat) {
	if c.unlisted {
		return
	}
	*o = append(*o, chatEvent{c: c, v: view(c)})
}

// emitItems queues the changed items, if any, under the top-level chat's id and the branch's.
// When c is not busy its part of the tree follows them (see emitTreePart): the items of a running
// turn are in the part its end sends. c.mu held.
func (o *outbox) emitItems(c *Chat, ups []transcript.Update) {
	if len(ups) == 0 || c.tr == nil || c.unlisted {
		return
	}
	chat, branch := splitID(c.meta.ID)
	o.threadEvent(c, chat, map[string]any{"type": "chat_items", "chat": chat, "branch": branch, "version": c.tr.Version(), "updates": ups})
	if !busy(c) {
		o.emitTreePart(c)
	}
}

// treeEvent is a "tree" event waiting in an outbox: the part of the tree that is the chat object
// c's branch, in the top-level chat with the id chat. Nothing of the part is held: it is read
// when the event is sent (see emitTree).
type treeEvent struct {
	c    *Chat
	chat string
}

// emitTreePart queues the tree event of c's own part of its chat's tree, for a change of what the
// tree shows of the branch: its items, or whether its agent is working. It marks the part as
// waiting (Chat.treeDirty), so that of several events queued for it the first one sent tells them
// all. c.mu held.
func (o *outbox) emitTreePart(c *Chat) {
	if c.unlisted {
		return
	}
	c.treeDirty.Store(true)
	chat, _ := splitID(c.meta.ID)
	*o = append(*o, treeEvent{c: c, chat: chat})
}

// view is what clients see of the chat object c alone: of a chat with branches, only the half c
// holds (see compose). Its draft is that of the branch c is. c.mu held. For a branch the draft is
// read from what its top-level chat publishes (Chat.drafts), not under that chat's mu: a branch's
// events never wait for its top-level chat, which may be starting a process.
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
	if c.top != nil { // main's draft is in its own meta; the others' are in their top-level chat's
		v.Draft = draftsOf(c.top)[c.branch]
	}
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
//
// A chat.json from before drafts were per branch has one draft for the chat. It becomes the draft
// of the chat's current branch, and chat.json is written at once: left to the next save, a change
// of the current branch before that save would give the draft to another branch after a restart.
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
		setDrafts(c, meta.Drafts)
		m.chats[meta.ID] = c
		m.registerChatToken(meta.Token)
		m.loadBranches(c, meta.ID)
		if d := c.meta.Draft; d != nil {
			cur := model.MainBranch
			if c.cur != nil {
				cur = c.cur.branch
			}
			if c.meta.Drafts[cur] == nil { // else the new form has one already: it stays
				setDrafts(c, withDraft(c.meta.Drafts, cur, d))
			}
			c.meta.Draft = nil
			m.logSave(c)
		}
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

// States returns the state record of every registered branch of every listed chat, main included
// and no run agent's chat,
// by chat id and then main first and the others in the tree record's order. Nothing is loaded for
// it: a branch whose thread has not been read since the server started has the status its
// chat.json gives (ready, or stopped after a turn cut by a restart) and no counts. One chat object
// is locked at a time.
func (m *Manager) States() []model.BranchState {
	out := []model.BranchState{}
	for _, top := range m.all() {
		if top.top != nil || top.role != "" {
			continue
		}
		for i, c := range m.branchesOf(top) {
			c.mu.Lock()
			hidden := c.unlisted || c.deleted
			chat, branch := splitID(c.meta.ID)
			st := model.StateOf(chat, branch, view(c))
			c.mu.Unlock()
			if hidden {
				if i == 0 {
					break // the chat itself: none of its branches is listed
				}
				continue
			}
			out = append(out, st)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Chat < out[j].Chat })
	return out
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
// history and shows a missing folder before the user types. It acts on the chat's current branch.
// Of a run agent's chat it only reads the history: the checkout a finished task agent worked in
// is removed by design.
func (m *Manager) Open(id string) error { return m.OpenOf(id, "") }

// OpenOf is Open for a branch of the chat; branch "" is the current one.
func (m *Manager) OpenOf(id, branch string) error {
	var out outbox
	defer func() { m.send(out) }()
	c, _, err := m.lockBranch(id, branch)
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
// the chat is busy (thinking), so a second Send gets ErrBusy; a fork is made only at a finished
// boundary, through this chat's fork source (see forkEntry). A failed or refused start
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
		switch {
		case ev.Kind == agent.EvThinking, ev.Kind == agent.EvPermRequest, ev.Kind == agent.EvTurnEnd,
			ev.Kind == agent.EvExit, modelOutput(ev):
			c.noTurn.Store(false) // the agent is in a turn after all, or ends one (see sendRefused)
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
// the text, and the user item keeps them. The message goes to the chat's current branch, the one
// a message last got onto: the other branches of the chat are not looked at, busy or not. An
// accepted Send releases that branch's hold and carries the subagent results the agent is owed,
// unless their delivery failed before: their rows go ahead of the user item and their block ahead
// of the text, after a board chat's context. With nothing owed the message is what it always was.
func (m *Manager) Send(id, text, context string, refs []model.Reference) error {
	_, err := m.SendBranch(id, text, context, refs)
	return err
}

// SendBranch is Send, and returns the id of the branch the message was put on ("main" for main):
// the one that was current when it was sent. It is "" with an error.
func (m *Manager) SendBranch(id, text, context string, refs []model.Reference) (branch string, err error) {
	if err := m.person(id); err != nil {
		return "", err
	}
	c, err := m.lockCur(id)
	if err != nil {
		return "", err
	}
	_, branch = splitID(c.meta.ID)
	if _, err := m.sendOn(c, text, context, refs); err != nil {
		return "", err
	}
	return branch, nil
}

// sendOn is Send on the chat object c, which may still be unlisted. c.mu is held on entry and
// released. Whether the message may go is decided here: ErrBusy says that c is busy, whatever the
// chat's other branches do, and ErrChatCap or ErrAppCap that too many chat objects work already
// (see cap.go). A message refused so leaves nothing: no item, the draft and what c owes its agent
// as they were. On a branch the first-send effects (group defaults, auto-naming) never run. The
// draft cleared is c's own alone (see dropDraft): another branch's stays.
//
// A chat on a run feeds no sticky defaults, and every message of it starts with the run's
// context block (RunOwner.ChatContext), as a board chat's does with its board's. For a run
// agent's chat it is SendOwned's: the wait of that message starts here, and nothing of the
// human's (the namer, quotes, the draft) is touched.
//
// on says that the message is in c's thread. It is false with every error but the refusal of the
// agent's own Send, which leaves the message there as a turn that failed (see sendRefused).
func (m *Manager) sendOn(c *Chat, text, context string, refs []model.Reference) (on bool, err error) {
	var out outbox
	if m.down.Load() {
		// In the hold of c.mu that would start the process (see Manager.down).
		c.mu.Unlock()
		return false, ErrShutdown
	}
	p := m.parentOf(c)
	if p.Archived {
		c.mu.Unlock()
		return false, ErrArchived
	}
	if p.InstructionsSent {
		c.mu.Unlock()
		return false, ErrLegacy
	}
	if c.meta.Run != "" {
		if _, err := m.openRun(c.meta.Run); err != nil {
			c.mu.Unlock()
			return false, err
		}
	}
	// A chat not read since the app started has no transcript loaded yet; the checks read it.
	if _, err := m.trOf(c, &out); err != nil {
		c.mu.Unlock()
		m.send(out)
		return false, err
	}
	// The three refusals below leave nothing, but the load above may have: out holds what it sends.
	if busy(c) {
		c.mu.Unlock()
		m.send(out)
		return false, ErrBusy
	}
	if c.role == "" && !validReferences(c.tr, refs) {
		c.mu.Unlock()
		m.send(out)
		return false, ErrBadReference
	}
	// The cap, last of the refusals that leave nothing: no process is started for a turn that
	// may not run. The slot is reserved until c shows as working, below.
	if err := m.reserveTurn(c); err != nil {
		c.mu.Unlock()
		m.send(out)
		return false, err
	}
	if c.meta.ForkSource != nil && c.ag == nil {
		err = m.spawnFork(c, &out)
	} else {
		err = m.spawn(c, &out)
	}
	if err != nil {
		m.releaseTurn(c) // no turn: c shows what the failed start left, which is not working
		c.mu.Unlock()
		m.send(out)
		return false, err
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
		m.recordDefaults(c, c.meta.Cwd, defaultsChoice(c, model.ModelChoice{Model: c.meta.Model, Effort: c.meta.Effort}), &out)
	}
	c.meta.Locked = true
	c.meta.Fresh, c.meta.SourceCtx = false, 0 // a fork has its own message from here, also one its agent refuses
	c.meta.TurnActive = true                  // in the hold of c.mu that started the process: its first tools/list finds a running turn
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
	notice, told := c.meta.NoticeOwed, false
	if notice {
		// A copy's first message: its agent is told what was running in the source and is not here.
		c.meta.NoticeOwed = false
		if gone := notCarried(c); len(gone) > 0 {
			blocks = append(blocks, agent.ContentBlock{Text: notCarriedBlock(gone)})
			told = true
		}
	}
	d, taken, ups := m.carryOwed(c, true, &out)
	if d != nil {
		blocks = append(blocks, agent.ContentBlock{Text: subResultsBlock(taken, runningAppSubs(c), true)})
		c.carry = d
	}
	blocks = append(blocks, agent.ContentBlock{Text: withReferences(refs, text)})
	ups = append(ups, c.tr.AddUser(text, context, refs)...)
	if told {
		// A copy cut before this point is forked from the session as it was before the notice.
		_, items := c.tr.Snapshot()
		c.meta.NoticeAt = len(items)
	}
	if err := c.tr.Flush(false); err != nil {
		log.Printf("chats: flush %s: %v", c.meta.ID, err)
	}
	if c.role == "" {
		m.dropDraft(c) // the message is the draft, sent
	}
	m.logSave(c)
	name, userNamed := c.meta.Name, c.meta.UserNamed
	id, kind := c.meta.ID, c.meta.Agent
	ag := c.ag
	c.sentGen = c.gen
	sent, turns := c.tr.Sent(), c.meta.Usage.Turns
	out.emitItems(c, ups)
	out.emitChat(c)
	m.releaseTurn(c) // c shows as working: the mirror holds the slot from here
	c.mu.Unlock()
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
		m.sendRefused(c, d, sent, turns, notice)
	}
	return true, err
}

// Configure changes the folder, model or effort before the first message; after it, only a
// new folder for a chat whose folder is missing, and the model or effort of a fork that has had
// no message of its own, whose process is then started again (see configureFresh): it returns
// once that start is over. It acts on the chat's current branch. A new folder for a missing one
// is the chat's: it is also written to every other branch that has the missing folder (see
// fixFolder). A branch with another folder keeps it.
func (m *Manager) Configure(id string, req ConfigReq) error { return m.ConfigureOf(id, "", req) }

// ConfigureOf is Configure for a branch of the chat; branch "" is the current one. All of req is
// the branch's: the chat's name and group are not in it (see Rename and Move).
func (m *Manager) ConfigureOf(id, branch string, req ConfigReq) error {
	if err := m.person(id); err != nil {
		return err
	}
	var out outbox
	c, _, err := m.lockBranch(id, branch)
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
	if c.meta.Fresh && !onlyFolderFix {
		// A fork that has had no message of its own: its model and effort can still be changed.
		err := m.configureFresh(c, req, &out)
		unlock()
		return err
	}
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
	mc, _, err := m.choose(c.meta.Agent, model.ModelChoice{Model: next.Model, Effort: next.Effort}, req.Model, req.Effort)
	if err != nil {
		unlock()
		return err
	}
	next.Model, next.Effort = mc.Model, mc.Effort
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
		m.recordDefaults(c, abs, defaultsChoice(c, model.ModelChoice{Model: req.Model, Effort: req.Effort}), &out)
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
// when the branch next starts. Each branch changed sends its state record, and the chat's view
// when it is the current branch (c is not, when Configure named another). One branch is locked
// at a time; no chat's mu may be held.
func (m *Manager) fixFolder(c *Chat, gone, cwd string) {
	for _, b := range m.branchesOf(topOf(c)) {
		if b == c {
			continue
		}
		var out outbox
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
			out.emitChat(b)
		}
		b.mu.Unlock()
		m.send(out)
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

// defaultsChoice is what recordDefaults gets of the choice mc made on c: nothing for a branch and
// for a fork, whose model and effort are never a new chat's defaults. c.mu held.
func defaultsChoice(c *Chat, mc model.ModelChoice) model.ModelChoice {
	if c.top != nil || c.meta.ForkedFrom != "" {
		return model.ModelChoice{}
	}
	return mc
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

// SetDraft stores the message typed in the composer of the chat's current branch; empty text and
// no quotes clear it.
func (m *Manager) SetDraft(id string, d model.Draft) error { return m.SetDraftOf(id, "", d) }

// SetDraftOf is SetDraft for the branch named ("" = the current one): each branch has its own
// draft, and all of them are kept with the top-level chat. The branch's state record is sent, then
// the chat's view.
func (m *Manager) SetDraftOf(id, branch string, d model.Draft) error {
	if err := m.person(id); err != nil {
		return err
	}
	top, err := m.topChat(id)
	if err != nil {
		return err
	}
	b := m.current(top)
	if branch != "" {
		if b, err = m.branchObj(id, branch); err != nil {
			return err
		}
	}
	bid := model.MainBranch
	if b != top {
		bid = b.branch
	}
	if _, err := m.lockTop(id); err != nil { // top, locked
		return err
	}
	var draft *model.Draft
	if d.Text != "" || len(d.References) > 0 {
		draft = &d
	}
	setDrafts(top, withDraft(top.meta.Drafts, bid, draft))
	err = m.save(top)
	top.mu.Unlock()
	m.emitState(b)
	m.emitView(top)
	return err
}

// withDraft is the drafts ds with d as the draft of branch, or with none for it when d is nil: a
// new map, since one that is in a chat's meta is never changed (see ChatMeta.Drafts), and nil
// when no draft is left.
func withDraft(ds map[string]*model.Draft, branch string, d *model.Draft) map[string]*model.Draft {
	if _, has := ds[branch]; d == nil && !has {
		return ds
	}
	out := make(map[string]*model.Draft, len(ds)+1)
	for b, x := range ds {
		if b != branch {
			out[b] = x
		}
	}
	if d != nil {
		out[branch] = d
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// setDrafts makes ds the drafts of the top-level chat top: in its meta, which is what is saved,
// and published for its branches' views (see Chat.drafts). Every assignment of a chat object's
// meta.Drafts goes through it. top.mu held, or top is not shared yet.
func setDrafts(top *Chat, ds map[string]*model.Draft) {
	top.meta.Drafts = ds
	top.drafts.Store(&ds)
}

// draftsOf is the drafts the top-level chat top publishes: its meta.Drafts as of the last
// assignment, never changed afterwards (see withDraft). No lock is needed.
func draftsOf(top *Chat) map[string]*model.Draft {
	if p := top.drafts.Load(); p != nil {
		return *p
	}
	return nil
}

// dropDraft removes the stored draft of the branch c is: a message was sent on it. Main's is in
// its own meta, which the caller saves. Another branch's is in its top-level chat's, which is
// locked for it (a branch's mu, then its top-level chat's) and saved here; a branch that is still
// unlisted has none. c.mu held.
func (m *Manager) dropDraft(c *Chat) {
	if c.top == nil {
		setDrafts(c, withDraft(c.meta.Drafts, model.MainBranch, nil))
		return
	}
	if c.unlisted {
		return
	}
	top := c.top
	top.mu.Lock()
	defer top.mu.Unlock()
	if _, has := top.meta.Drafts[c.branch]; top.deleted || !has {
		return
	}
	setDrafts(top, withDraft(top.meta.Drafts, c.branch, nil))
	m.logSave(top)
}

// Interrupt asks the running agent to stop its turn, and holds the chat: the app starts no turn on
// it until the user sends. App-spawned subagents are terminated immediately; native ones wait for
// the aborted turn end, as they always have. With no turn running no aborted end follows, so the
// "Stopped." note for the subagents it stopped is written here. A turn carrying subagent results
// is marked as stopped by the human: if it ends with no model output, they are owed again.
//
// While subagent results are being handed to the agent (handOff), the agent is signalled only once
// it has the message, and Interrupt does not wait for that.
//
// It acts on the chat's current branch.
func (m *Manager) Interrupt(id string) error { return m.InterruptOf(id, "") }

// InterruptOf is Interrupt for a branch of the chat; branch "" is the current one.
func (m *Manager) InterruptOf(id, branch string) error {
	if err := m.person(id); err != nil {
		return err
	}
	return m.interrupt(id, branch)
}

// interrupt is InterruptOf for whoever drives the chat: a person, or the run that owns it
// (StopOwned).
func (m *Manager) interrupt(id, branch string) error {
	var out outbox
	c, _, err := m.lockBranch(id, branch)
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
// It acts on the chat's current branch.
func (m *Manager) Decide(id, asker, requestID string, allow bool) error {
	return m.DecideOf(id, "", asker, requestID, allow)
}

// DecideOf is Decide for a branch of the chat; branch "" is the current one.
func (m *Manager) DecideOf(id, branch, asker, requestID string, allow bool) error {
	var out outbox
	var d *carry
	c, _, err := m.lockBranch(id, branch)
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
		top.goneMu.Lock() // what is still queued for the chat is dropped from here on (see cast)
		m.Bridge.Broadcast(map[string]any{"type": "chat_removed", "id": id})
		top.goneMu.Unlock()
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

// Busy reports whether the agent of the chat's current branch is thinking, writing, running a
// tool or waiting for approval. It says nothing of the chat's other branches, each of which may
// be working: BusyOf asks for one of them, and the chat's view counts them (ChatView.Working).
func (m *Manager) Busy(id string) bool { return m.BusyOf(id, "") }

// BusyOf is Busy for a branch of the chat; branch "" is the current one. It is false for a branch
// the chat does not have.
func (m *Manager) BusyOf(id, branch string) bool {
	c, _, err := m.lockBranch(id, branch)
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
