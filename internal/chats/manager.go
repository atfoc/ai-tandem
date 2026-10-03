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
}

type Manager struct {
	Deps
	mu     sync.Mutex
	chats  map[string]*Chat
	naming sync.WaitGroup   // the auto namer goroutines Send starts
	now    func() time.Time // the clock subagents' times come from; tests replace it

	// extrasMu protects extras, extraBySID and used. Never take Chat.mu while holding extrasMu
	// (issue/revoke run with Chat.mu then extrasMu).
	extrasMu   sync.Mutex
	extras     map[string]extraCaller // extra token → caller (in memory only)
	extraBySID map[string]string      // chatID+"/"+sid → extra token
	used       map[string]struct{}    // live chat tokens and extra tokens, for uniqueness
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
	subs          map[string]*sub    // sid → subagent; loaded with tr (see trOf)
	subByTool     map[string]string  // Agent/Task tool call id → sid
	pendingLinks  []pendingSpawnLink // unlinked app-spawned subs waiting for a matching spawn tool item
	splitRun      *splitRun          // the context split being taken now (see ContextSplit)
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
		now:        time.Now,
	}
}

func (m *Manager) nowMs() int64 { return m.now().UnixMilli() }

// ---- emitting -------------------------------------------------------------

// outbox collects the events built while a chat is locked; they are broadcast after unlocking,
// so the bridge's lock is never taken under a chat's lock (the bridge's snapshot reads chats).
type outbox []any

func (m *Manager) send(out outbox) {
	for _, ev := range out {
		m.Bridge.Broadcast(ev)
	}
}

// emitChat queues {type:"chat", chat: view(c)}. c.mu held.
func (o *outbox) emitChat(c *Chat) {
	*o = append(*o, map[string]any{"type": "chat", "chat": view(c)})
}

// emitItems queues the changed items, if any. c.mu held.
func (o *outbox) emitItems(c *Chat, ups []transcript.Update) {
	if len(ups) == 0 || c.tr == nil {
		return
	}
	*o = append(*o, map[string]any{"type": "chat_items", "chat": c.meta.ID, "version": c.tr.Version(), "updates": ups})
}

// view is what clients see of c. c.mu held.
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
	return model.ViewOf(c.meta, st, tool, c.errText, c.folderMissing)
}

// save writes chat.json. c.mu held.
func (m *Manager) save(c *Chat) error {
	return store.WriteJSONAtomic(filepath.Join(m.Store.P.ChatDir(c.meta.ID), "chat.json"), c.meta, 0o600)
}

func (m *Manager) logSave(c *Chat) {
	if err := m.save(c); err != nil {
		log.Printf("chats: save %s: %v", c.meta.ID, err)
	}
}

func (m *Manager) itemsPath(id string) string {
	return filepath.Join(m.Store.P.ChatDir(id), "items.jsonl")
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

// lock returns the chat with c.mu held, or ErrNotFound (also for a chat being deleted, so a
// late call, such as the auto namer's Rename, never writes its folder back).
func (m *Manager) lock(id string) (*Chat, error) {
	c, err := m.get(id)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.deleted {
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

// Load reads every chats/<id>/chat.json at boot. items.jsonl is not read here. A folder without
// a readable chat.json is logged and skipped (never deleted).
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
		raw, err := os.ReadFile(filepath.Join(m.Store.P.ChatDir(e.Name()), "chat.json"))
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
		m.chats[meta.ID] = &Chat{meta: meta, interrupted: meta.TurnActive}
		m.registerChatToken(meta.Token)
	}
	return nil
}

// Views returns every chat's view, oldest first.
func (m *Manager) Views() []model.ChatView {
	cs := m.all()
	out := make([]model.ChatView, 0, len(cs))
	for _, c := range cs {
		c.mu.Lock()
		out = append(out, view(c))
		c.mu.Unlock()
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Created.Equal(out[j].Created) {
			return out[i].Created.Before(out[j].Created)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (m *Manager) View(id string) (model.ChatView, error) {
	c, err := m.lock(id)
	if err != nil {
		return model.ChatView{}, err
	}
	defer c.mu.Unlock()
	return view(c), nil
}

// Items returns the chat's history and its version, reading items.jsonl the first time, and the
// chat's subagents, sorted by Started, then ID.
func (m *Manager) Items(id string) (int, []model.Item, []model.Subagent, error) {
	var out outbox
	c, err := m.lock(id)
	if err != nil {
		return 0, nil, nil, err
	}
	tr, err := m.trOf(c, &out)
	var v int
	var items []model.Item
	var subs []model.Subagent
	if err == nil {
		v, items = tr.Snapshot()
		subs = make([]model.Subagent, 0, len(c.subs))
		for _, s := range c.subs {
			subs = append(subs, s.meta)
		}
		sort.Slice(subs, func(i, j int) bool {
			if subs[i].Started != subs[j].Started {
				return subs[i].Started < subs[j].Started
			}
			return subs[i].ID < subs[j].ID
		})
	}
	c.mu.Unlock()
	m.send(out)
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
	if err := os.MkdirAll(m.Store.P.ChatDir(meta.ID), 0o700); err != nil {
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
// history and shows a missing folder before the user types.
func (m *Manager) Open(id string) error {
	var out outbox
	defer func() { m.send(out) }()
	c, err := m.lock(id)
	if err != nil {
		return err
	}
	defer c.mu.Unlock()
	tr, err := m.trOf(c, &out)
	if err != nil {
		return err
	}
	if c.meta.Locked && !c.meta.Archived && c.ag == nil {
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

// spawn starts the chat's agent if it has none. c.mu held; only Send calls it.
func (m *Manager) spawn(c *Chat, out *outbox) error {
	tr, err := m.trOf(c, out)
	if err != nil {
		return err
	}
	if c.meta.Archived {
		return ErrArchived
	}
	if c.meta.InstructionsSent {
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
			c.folderMissing = false
			c.errText = ""
			c.gen++
			c.ag = ag
			go m.pump(c, ag, c.gen)
			return nil
		}
	}
	if errors.Is(err, ErrFolderMissing) {
		c.folderMissing = true
		c.errText = folderMissingText(c.meta.Cwd)
	} else {
		c.errText = err.Error()
	}
	tr.SetStatus(model.StatusError)
	out.emitChat(c)
	return err
}

// spawnOptions are the options c's agent starts with. c.mu held.
// MCP URL+token is set for every chat; board extras only when the chat belongs to a board.
func (m *Manager) spawnOptions(c *Chat) agent.SpawnOptions {
	m.ensureToken(c)
	opts := agent.SpawnOptions{ChatID: c.meta.ID, SessionID: c.meta.SessionID, Resume: c.meta.Locked,
		Cwd: c.meta.Cwd, Model: c.meta.Model, Effort: m.effortFor(c.meta.Agent, c.meta.Model, c.meta.Effort),
		MCP: &agent.BoardAccess{MCPURL: m.MCPURL, Token: c.meta.Token}, BoardID: c.meta.Board}
	if c.meta.Agent == model.Cursor && !c.meta.Locked {
		opts.SessionID = ""
	}
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
		if ev.Sub != "" && ev.Kind != agent.EvPermRequest {
			m.routeSub(c, ev, &out)
			c.mu.Unlock()
			m.send(out)
			continue
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
		case agent.EvExit:
			c.ag = nil
		}
		ups := c.tr.Apply(ev)
		if len(c.pendingLinks) > 0 {
			m.reconcileSpawnLinks(c, &out)
		}
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
		out.emitItems(c, ups)
		if view(c) != before {
			out.emitChat(c)
		}
		c.mu.Unlock()
		m.send(out)
		closeAgents(toClose)
	}
}

// Send posts one user turn, starting (or resuming) the agent if it has no process. refs are the
// parts of earlier messages the user quoted: the agent gets them as <reference> blocks in front of
// the text, and the user item keeps them.
func (m *Manager) Send(id, text, context string, refs []model.Reference) error {
	var out outbox
	c, err := m.lock(id)
	if err != nil {
		return err
	}
	if c.meta.Archived {
		c.mu.Unlock()
		return ErrArchived
	}
	if c.meta.InstructionsSent {
		c.mu.Unlock()
		return ErrLegacy
	}
	if busy(c) {
		c.mu.Unlock()
		return ErrBusy
	}
	if !validReferences(c.tr, refs) {
		c.mu.Unlock()
		return ErrBadReference
	}
	if err := m.spawn(c, &out); err != nil {
		c.mu.Unlock()
		m.send(out)
		return err
	}
	first := !c.meta.Locked
	if first {
		// Sending the first message confirms the chat's settings as chosen, changed or not.
		m.recordDefaults(c, c.meta.Cwd, model.ModelChoice{Model: c.meta.Model, Effort: c.meta.Effort}, &out)
	}
	c.meta.Locked = true
	c.meta.TurnActive = true
	c.meta.Draft = nil // the message is the draft, sent
	var blocks []agent.ContentBlock
	if c.meta.Board != "" {
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
	blocks = append(blocks, agent.ContentBlock{Text: withReferences(refs, text)})
	ups := c.tr.AddUser(text, context, refs)
	if err := c.tr.Flush(false); err != nil {
		log.Printf("chats: flush %s: %v", c.meta.ID, err)
	}
	m.logSave(c)
	name, userNamed := c.meta.Name, c.meta.UserNamed
	kind := c.meta.Agent
	ag := c.ag
	out.emitItems(c, ups)
	out.emitChat(c)
	c.mu.Unlock()
	m.send(out)
	if first && name == "" && !userNamed {
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
	return ag.Send(blocks)
}

// Configure changes the folder, model or effort before the first message; after it, only a
// new folder for a chat whose folder is missing.
func (m *Manager) Configure(id string, req ConfigReq) error {
	var out outbox
	c, err := m.lock(id)
	if err != nil {
		return err
	}
	unlock := func() { c.mu.Unlock(); m.send(out) }
	if c.meta.Archived {
		unlock()
		return ErrArchived
	}
	if c.meta.InstructionsSent {
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
	c.meta = next
	if req.Cwd != "" && c.folderMissing {
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
	m.recordDefaults(c, abs, model.ModelChoice{Model: req.Model, Effort: req.Effort}, &out)
	out.emitChat(c)
	unlock()
	return nil
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
	var out outbox
	c, err := m.lock(id)
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
	out.emitChat(c)
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
	var out outbox
	c, err := m.lock(id)
	if err != nil {
		return err
	}
	if d.Text == "" && len(d.References) == 0 {
		c.meta.Draft = nil
	} else {
		c.meta.Draft = &d
	}
	err = m.save(c)
	out.emitChat(c)
	c.mu.Unlock()
	m.send(out)
	return err
}

// Interrupt asks the running agent to stop its turn. App-spawned subagents are terminated
// immediately; native ones wait for the aborted turn end, as they always have.
func (m *Manager) Interrupt(id string) error {
	var out outbox
	c, err := m.lock(id)
	if err != nil {
		return err
	}
	ag := c.ag
	toClose := m.stopAppSubs(c, &out)
	if len(toClose) > 0 && c.tr != nil {
		if err := c.tr.Flush(false); err != nil {
			log.Printf("chats: flush %s: %v", c.meta.ID, err)
		}
	}
	c.mu.Unlock()
	m.send(out)
	closeAgents(toClose)
	if ag == nil {
		return nil
	}
	return ag.Interrupt()
}

// Decide answers a permission request.
func (m *Manager) Decide(id, requestID string, allow bool) error {
	var out outbox
	c, err := m.lock(id)
	if err != nil {
		return err
	}
	defer func() { c.mu.Unlock(); m.send(out) }()
	tr, err := m.trOf(c, &out)
	if err != nil {
		return err
	}
	ag := c.ag
	_, items := tr.Snapshot()
	for _, it := range items {
		if it.Kind == "perm" && it.RequestID == requestID && it.Subagent != "" {
			if s, ok := c.subs[it.Subagent]; ok && s.ag != nil {
				ag = s.ag // app-spawned: the child asked; native still uses c.ag
			}
			break
		}
	}
	if ag == nil {
		return errors.New("the agent is not running")
	}
	if err := ag.Decide(requestID, allow); err != nil {
		return err
	}
	ups := tr.Decided(requestID, allow)
	if err := tr.Flush(false); err != nil {
		log.Printf("chats: flush %s: %v", c.meta.ID, err)
	}
	out.emitItems(c, ups)
	out.emitChat(c)
	return nil
}

// Move puts a plain chat in another group. Its settings are unchanged.
func (m *Manager) Move(id, group string) error {
	if !m.groupExists(group) {
		return fmt.Errorf("no such group %q", group)
	}
	var out outbox
	c, err := m.lock(id)
	if err != nil {
		return err
	}
	if c.meta.Board != "" {
		c.mu.Unlock()
		return errors.New("a board chat moves with its board")
	}
	c.meta.Group = group
	err = m.save(c)
	out.emitChat(c)
	c.mu.Unlock()
	m.send(out)
	return err
}

// Stop ends the chat's agent (archive, delete, board delete): pending approvals are answered
// "no", a running turn gets a "Stopped." note.
func (m *Manager) Stop(id string) {
	var out outbox
	c, err := m.lock(id)
	if err != nil {
		return
	}
	var toClose []agent.Agent
	defer func() { c.mu.Unlock(); m.send(out); closeAgents(toClose) }()
	if c.tr == nil && !c.interrupted {
		return // unloaded: no agent, nothing open
	}
	tr, err := m.trOf(c, &out)
	if err != nil {
		return
	}
	wasBusy := busy(c)
	var ups []transcript.Update
	_, items := tr.Snapshot()
	for _, it := range items {
		if it.Kind == "perm" && it.Decided == "" {
			if it.Subagent != "" {
				if s, ok := c.subs[it.Subagent]; ok && s.ag != nil {
					continue // stopSubs denies these on the child process
				}
			}
			if c.ag != nil {
				_ = c.ag.Decide(it.RequestID, false)
			}
			ups = append(ups, tr.Decided(it.RequestID, false)...)
		}
	}
	if c.ag != nil {
		c.gen++
		_ = c.ag.Interrupt()
		c.ag.Close()
		c.ag = nil
	}
	toClose = m.stopSubs(c, &out)
	m.revokeChatExtras(c.meta.ID)
	if wasBusy {
		ups = append(ups, tr.AddNote("muted", "Stopped.")...)
	}
	c.meta.TurnActive = false
	tr.SetStatus(model.StatusReady)
	if err := tr.Flush(false); err != nil {
		log.Printf("chats: flush %s: %v", c.meta.ID, err)
	}
	m.logSave(c)
	out.emitItems(c, ups)
	out.emitChat(c)
}

func (m *Manager) SetArchive(id string, a model.Archive) error {
	var out outbox
	c, err := m.lock(id)
	if err != nil {
		return err
	}
	c.meta.Archive = a
	err = m.save(c)
	out.emitChat(c)
	c.mu.Unlock()
	m.send(out)
	return err
}

// Delete stops the chat and removes it and its history. The agent CLIs' own session files are
// left alone.
func (m *Manager) Delete(id string) error {
	if _, err := m.get(id); err != nil {
		return err
	}
	m.Stop(id)
	c, err := m.lock(id)
	if err != nil {
		return err
	}
	c.deleted = true
	tok := c.meta.Token
	if c.ag != nil { // a Send that came in after Stop
		c.gen++
		c.ag.Close()
		c.ag = nil
	}
	c.mu.Unlock()
	m.revokeChatExtras(id)
	m.unregisterChatToken(tok)
	m.mu.Lock()
	delete(m.chats, id)
	m.mu.Unlock()
	if err := os.RemoveAll(m.Store.P.ChatDir(id)); err != nil {
		return err
	}
	m.Bridge.Broadcast(map[string]any{"type": "chat_removed", "id": id})
	return nil
}

func (m *Manager) ChatsOfBoard(boardID string) []model.ChatMeta {
	var out []model.ChatMeta
	for _, c := range m.all() {
		c.mu.Lock()
		meta := c.meta
		c.mu.Unlock()
		if boardID != "" && meta.Board == boardID {
			out = append(out, meta)
		}
	}
	return out
}

// GroupOf is the board's group for board chats, else meta.Group. A board chat whose board is
// gone counts as ungrouped.
func (m *Manager) GroupOf(meta model.ChatMeta) string {
	if meta.Board != "" {
		if bd, ok := m.Boards.Get(meta.Board); ok {
			return bd.Group
		}
		return model.Ungrouped
	}
	return meta.Group
}

// Busy reports whether the chat's agent is thinking, writing, running a tool or waiting for approval.
func (m *Manager) Busy(id string) bool {
	c, err := m.lock(id)
	if err != nil {
		return false
	}
	defer c.mu.Unlock()
	return busy(c)
}

// Shutdown writes everything still open and ends every agent without waiting (the caller then
// ends what is left with agent.EndAll). A running turn keeps TurnActive, so the chat shows as
// Stopped next time.
func (m *Manager) Shutdown() {
	for _, c := range m.all() {
		var out outbox
		c.mu.Lock()
		if c.tr != nil {
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
		if c.ag != nil {
			go c.ag.Close() // Cursor's Close waits for the process, forever when its children hold its output
		}
		c.mu.Unlock()
		m.send(out)
		closeAgents(toClose)
	}
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
