// Branches in the manager (D3, D6 and D10 of the chat forking plan, and 4.5 of the concurrent
// branches plan). A branch other than main is a chat object of its own, under the server id
// <chat id>/branches/<branch id>, linked to its top-level chat and never listed. The client names
// the chat by its top-level id only: the session-side operations go to the branch it names with
// it (the …Of methods, through lockBranch), or to the chat's current branch when it names none,
// the others to the top-level chat.
//
// Every branch has its own process and its own turn: any number of a chat's branches work at the
// same time, and busy is a branch's, never the chat's. The current branch is the one a human
// message last got onto (see setCurrent): the branch the chat opens on and the one an unnamed
// call goes to. It says nothing about which branches have a process, and changing it stops
// nothing.
//
// Locks: a branch's mu may be held while its top-level chat's mu is taken (for the flags and the
// identity only the top-level chat has), never the other way round, and never two branches' at
// once. The registry (Chat.kids and Chat.cur) is guarded by Manager.mu, which is taken last.
//
// The order over one chat, each lock taken only with those before it held: the top-level chat's
// moveMu; its treeMu, its sendMu or its treeOutMu, never two of them; a branch's mu; the
// top-level chat's mu; Manager.mu. moveMu (see Chat.moveMu) is held only for one change of the
// current branch, never while a process starts or a message goes to an agent. sendMu (see
// Chat.sendMu) is held only while a chat event is composed and broadcast (see send), treeOutMu
// (see Chat.treeOutMu) only while a tree event is (see emitTree). The top-level chat's goneMu is
// a leaf, taken with sendMu or treeOutMu held or with none of these (see cast). The bridge's lock
// comes under sendMu, treeOutMu and goneMu, and the bridge reads the chats (their mu, Manager.mu)
// under its own: so no chat's mu, no treeMu and not Manager.mu is held when an event is sent.
package chats

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/transcript"
)

// ---- ids and links --------------------------------------------------------

// splitID is the top-level chat id and the branch id a server id names: (id, "main") for a
// top-level chat's own id.
func splitID(id string) (chat, branch string) {
	if chat, branch, ok := strings.Cut(id, "/branches/"); ok {
		return chat, branch
	}
	return id, model.MainBranch
}

// validBranchID reports whether id can be the id of a branch other than main: one path segment.
func validBranchID(id string) bool {
	return id != "" && id != model.MainBranch && id != "." && id != ".." &&
		!strings.ContainsAny(id, `/\`)
}

// topOf is the top-level chat of the chat object c: c itself unless c is a branch. Chat.top is
// set before c is in the map and never changes, so no lock is needed.
func topOf(c *Chat) *Chat {
	if c.top != nil {
		return c.top
	}
	return c
}

// linkBranch sets, on a chat object made for a branch's server id, the link to its top-level
// chat. m.mu held; c is not in the map yet. Without the top-level chat in the map c stays
// unlinked.
func (m *Manager) linkBranch(c *Chat, id string) {
	chat, branch := splitID(id)
	if branch == model.MainBranch {
		return
	}
	if top, ok := m.chats[chat]; ok && top.top == nil {
		c.top, c.branch = top, branch
	}
}

// ---- the registry ---------------------------------------------------------

// addBranch puts the chat object of a branch in the registry of its chat: the map entry, the
// link to the top-level chat and the count. id is the branch's server id, c.meta.ID. An entry
// that is already in the map (an unlisted one, see addUnlisted) keeps its place there. The branch
// is not made current (setCurrent) and c.unlisted is left as it is.
func (m *Manager) addBranch(c *Chat, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if in, ok := m.chats[id]; ok && in != c {
		return fmt.Errorf("the branch %s is already there", id)
	} else if !ok {
		m.linkBranch(c, id)
	}
	if c.top == nil {
		return ErrNoBranch // not a branch's id, or its chat is gone
	}
	m.chats[id] = c
	if !containsChat(c.top.kids, c) {
		c.top.kids = append(c.top.kids, c)
	}
	return nil
}

func containsChat(cs []*Chat, c *Chat) bool {
	for _, k := range cs {
		if k == c {
			return true
		}
	}
	return false
}

// loadBranches is Load for the branches of the top-level chat top, with the id id: the branches
// its tree record names are registered, in the record's order, and the record's current branch
// becomes the current one. A recorded branch without a readable chat.json, or split from a branch
// that is not registered, is logged and skipped; a branches/ folder the record does not name is
// never looked at. An unreadable record leaves the chat with one branch. Nothing is written.
// m.mu held.
func (m *Manager) loadBranches(top *Chat, id string) {
	t, err := m.readTree(id)
	if err != nil {
		log.Printf("chats: %s: %v", id, err)
		return
	}
	known := map[string]*Chat{model.MainBranch: top}
	for _, b := range t.Branches {
		if _, dup := known[b.ID]; dup || !validBranchID(b.ID) || b.At < 0 {
			continue
		}
		if _, ok := known[b.From]; !ok {
			log.Printf("chats: skipping branch %s of %s: it split from %q, which is not there", b.ID, id, b.From)
			continue
		}
		sid := branchChatID(id, b.ID)
		var meta model.ChatMeta
		raw, err := os.ReadFile(filepath.Join(m.chatDir(sid), "chat.json"))
		if err == nil {
			err = json.Unmarshal(raw, &meta)
		}
		if err == nil && meta.ID != sid {
			err = fmt.Errorf("its id is %q", meta.ID)
		}
		if err != nil {
			log.Printf("chats: skipping branch %s of %s: %v", b.ID, id, err)
			continue
		}
		c := &Chat{meta: meta, interrupted: meta.TurnActive, top: top, branch: b.ID}
		countInterrupted(c)
		m.chats[sid] = c
		top.kids = append(top.kids, c)
		m.registerChatToken(meta.Token)
		known[b.ID] = c
	}
	if c, ok := known[t.Current]; ok && c != top {
		top.cur = c
	}
}

// current is the chat object of the current branch of the top-level chat top.
func (m *Manager) current(top *Chat) *Chat {
	m.mu.Lock()
	defer m.mu.Unlock()
	if top.cur != nil {
		return top.cur
	}
	return top
}

// branchesOf is every registered branch of the top-level chat top, main (top itself) first.
func (m *Manager) branchesOf(top *Chat) []*Chat {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]*Chat{top}, top.kids...)
}

// topChat returns the top-level chat with the id id, not locked: ErrNotFound for an unknown id
// and for a branch's server id, which no client-facing call may name.
func (m *Manager) topChat(id string) (*Chat, error) {
	c, err := m.get(id)
	if err != nil {
		return nil, err
	}
	if c.top != nil {
		return nil, ErrNotFound
	}
	return c, nil
}

// branchObj looks a branch of the top-level chat id up by its branch id ("main" is the chat
// itself): ErrNotFound for an unknown chat, ErrNoBranch for a branch that is not registered.
// Nothing is locked.
func (m *Manager) branchObj(id, branch string) (*Chat, error) {
	top, err := m.topChat(id)
	if err != nil {
		return nil, err
	}
	if branch == model.MainBranch {
		return top, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range top.kids {
		if k.branch == branch {
			return k, nil
		}
	}
	return nil, ErrNoBranch
}

// lockTop returns the top-level chat id with its mu held, as lock does: the chat-level
// operations (name, group, archive) act on it whatever the current branch is, and it keeps the
// drafts of all its branches.
func (m *Manager) lockTop(id string) (*Chat, error) {
	if _, err := m.topChat(id); err != nil {
		return nil, err
	}
	return m.lock(id)
}

// lockCur returns the current branch of the top-level chat id with its mu held: the session-side
// operations act on it when no branch is named, and the plain Send always. It is the branch a
// message last got onto, which need not be the only one with a process, nor have one.
func (m *Manager) lockCur(id string) (*Chat, error) {
	top, err := m.topChat(id)
	if err != nil {
		return nil, err
	}
	for {
		c := m.current(top)
		c.mu.Lock()
		if c.deleted || c.unlisted {
			c.mu.Unlock()
			return nil, ErrNotFound
		}
		if m.current(top) == c {
			return c, nil
		}
		c.mu.Unlock() // another branch became current meanwhile
	}
}

// lockBranch returns a branch of the top-level chat id with its mu held; branch "" is the
// current one. served is the id of the branch returned. Every session-side operation that takes
// a branch (InterruptOf, DecideOf, ConfigureOf, OpenOf, BusyOf, ContextSplitOf, ThreadOf) gets
// its chat object here: ErrNoBranch for a branch the chat does not have.
func (m *Manager) lockBranch(id, branch string) (c *Chat, served string, err error) {
	if branch == "" {
		c, err = m.lockCur(id)
	} else {
		c, err = m.branchChat(id, branch)
	}
	if err != nil {
		return nil, "", err
	}
	_, served = splitID(c.meta.ID)
	return c, served, nil
}

// setCurrent makes a registered branch of the top-level chat id the current one, as one step
// under the chat's moveMu: the tree record first (left alone when it names the branch already),
// then memory. The chat's view is sent when the current branch changed, and the tree event that
// names the branch after it. It is called once a human message is in the branch's thread, and
// stops nothing: the branch that was current keeps its process and its turn. No chat's mu may be
// held.
func (m *Manager) setCurrent(id, branch string) error {
	c, err := m.branchObj(id, branch)
	if err != nil {
		return err
	}
	top := topOf(c)
	top.moveMu.Lock()
	was := m.current(top)
	err = m.updateTree(id, func(t *model.Tree) error {
		if t.Current == branch || (t.Current == "" && branch == model.MainBranch) {
			return errTreeSame
		}
		t.Current = branch
		return nil
	})
	if err != nil && !errors.Is(err, errTreeSame) {
		top.moveMu.Unlock()
		return err
	}
	m.makeCurrent(top, c)
	top.moveMu.Unlock()
	if was != c {
		m.emitView(top)
		m.emitTree(id, top, nil, false, true, false)
	}
	return nil
}

// makeCurrent is the memory half of setCurrent: the chat object c, top itself or one of its
// registered branches, is the current branch of top from now on. The tree record is the caller's
// to write, under the same hold of top's moveMu.
func (m *Manager) makeCurrent(top, c *Chat) {
	m.mu.Lock()
	defer m.mu.Unlock()
	top.cur = nil
	if c != top {
		top.cur = c
	}
}

// emitView sends the view of the top-level chat top as it is now. No chat's mu may be held.
func (m *Manager) emitView(top *Chat) {
	var out outbox
	top.mu.Lock()
	if !top.deleted {
		out.emitIdentity(top)
	}
	top.mu.Unlock()
	m.send(out)
}

// ---- what a branch takes from its top-level chat --------------------------

// parentOf is the meta of c's top-level chat: what holds the chat's name, group, board, drafts,
// archive state and legacy flag (a branch's own chat.json has none of them). c.mu held.
func (m *Manager) parentOf(c *Chat) model.ChatMeta {
	if c.top == nil {
		return c.meta
	}
	c.top.mu.Lock()
	defer c.top.mu.Unlock()
	return c.top.meta
}

// ---- the composed view ----------------------------------------------------

// chatEvent is a "chat" event waiting in an outbox. It holds the view of the chat object that
// queued it, taken under its lock; the half another chat object holds is read when the event is
// sent (see chatView).
type chatEvent struct {
	c       *Chat
	v       model.ChatView
	session bool // c's session side changed; else the top-level chat c's identity did
	agg     bool // with session: c started or stopped working or waiting for approval (c.pub changed)
}

// compose is the view of a chat: identity (name, group, board, archive, whether a branch has a
// draft, ...) from its top-level chat's view, the session side (settings, whether they can still
// be changed: Locked and Fresh, usage, status, draft) from its current branch's. The counts over all its branches (Working, Approvals) are in
// neither half: chatView sets them.
func compose(identity, session model.ChatView) model.ChatView {
	v := identity
	v.Cwd, v.Model, v.Effort, v.Locked, v.Usage = session.Cwd, session.Model, session.Effort, session.Locked, session.Usage
	v.Status, v.StatusTool, v.Error, v.FolderMissing = session.Status, session.StatusTool, session.Error, session.FolderMissing
	v.SubsRunning, v.SubsOwed = session.SubsRunning, session.SubsOwed
	v.Fresh = session.Fresh
	v.Draft = session.Draft
	return v
}

// chatView is the view a queued chat event carries: one per top-level chat, composed. ok is false
// when nothing is to be sent: the session side of a branch that is not current changed, and the
// chat's counts of working branches did not change with it. No chat's mu may be held.
//
// Working and Approvals are counted here from the mirrors (Chat.pub) of the chat's branches: no
// branch is locked for them, so never two at once, and they are as of the moment the event is
// sent. send holds the chat's sendMu from here to the broadcast, so the last chat event clients
// get has the counts of the last change. Whether a branch other than main has a draft is read
// the same way, from what the top-level chat publishes (Chat.drafts).
func (m *Manager) chatView(e chatEvent) (v model.ChatView, ok bool) {
	top := topOf(e.c)
	m.mu.Lock()
	cur, all := top.cur, append([]*Chat{top}, top.kids...)
	m.mu.Unlock()
	if cur == nil {
		cur = top
	}
	var own model.ChatView           // top's own view: the identity half, with main's draft
	other := e.session && e.c != cur // the session side of a branch that is not current
	switch {
	case other && !e.agg:
		return model.ChatView{}, false
	case other: // only the counts changed: neither half of the view is e.c's
		top.mu.Lock()
		gone := top.deleted
		own = view(top)
		top.mu.Unlock()
		if gone {
			return model.ChatView{}, false
		}
		v = own
		if cur != top {
			cur.mu.Lock()
			v = compose(own, view(cur))
			cur.mu.Unlock()
		}
	case e.c == cur && cur == top:
		own, v = e.v, e.v
	case e.c == top: // its identity changed; the current branch has the rest
		own = e.v
		cur.mu.Lock()
		v = compose(own, view(cur))
		cur.mu.Unlock()
	default: // the current branch changed; its top-level chat has the rest
		top.mu.Lock()
		gone := top.deleted
		own = view(top)
		top.mu.Unlock()
		if gone {
			return model.ChatView{}, false
		}
		v = compose(own, e.v)
	}
	if n := len(all); n > 1 {
		v.Branches = n
	}
	if cur != top {
		v.Branch = cur.branch
	}
	// HasDraft is over the registered branches only. A draft stored under another id (a branch
	// that was skipped at load) is left in the file and not counted: no branch shows it, and no
	// call can clear it.
	drafts := draftsOf(top)
	v.HasDraft = own.Draft != nil
	for _, b := range all {
		switch b.pub.Load() {
		case pubWorking:
			v.Working++
		case pubApproval:
			v.Working++
			v.Approvals++
		}
		if b != top && drafts[b.branch] != nil {
			v.HasDraft = true
		}
	}
	return v, true
}

// composed is the view of the top-level chat top, whose own view (taken under its lock) is own.
// No chat's mu may be held.
func (m *Manager) composed(top *Chat, own model.ChatView) model.ChatView {
	v, _ := m.chatView(chatEvent{c: top, v: own})
	return v
}

// ---- reading a branch -----------------------------------------------------

// Thread is what a client reads of one branch of a chat: its history with its version, its
// subagents, sorted by Started, then ID, and its state record, all taken under one hold of the
// branch's lock.
type Thread struct {
	Branch    string // the branch id the answer is for
	Version   int
	Items     []model.Item
	Subagents []model.Subagent
	State     model.BranchState
}

// ThreadOf reads one branch of the chat, reading items.jsonl the first time; branch "" means the
// current branch.
func (m *Manager) ThreadOf(id, branch string) (Thread, error) {
	var out outbox
	c, served, err := m.lockBranch(id, branch)
	if err != nil {
		return Thread{}, err
	}
	t := Thread{Branch: served}
	tr, err := m.trOf(c, &out)
	if err == nil {
		t.Version, t.Items = tr.Snapshot()
		t.Subagents = make([]model.Subagent, 0, len(c.subs))
		for _, s := range c.subs {
			t.Subagents = append(t.Subagents, s.meta)
		}
		sort.Slice(t.Subagents, func(i, j int) bool {
			if t.Subagents[i].Started != t.Subagents[j].Started {
				return t.Subagents[i].Started < t.Subagents[j].Started
			}
			return t.Subagents[i].ID < t.Subagents[j].ID
		})
	}
	chat, _ := splitID(c.meta.ID)
	t.State = model.StateOf(chat, served, view(c)) // with the error of a thread that could not be read
	c.mu.Unlock()
	m.send(out)
	return t, err
}

// ItemsOf is Items for one branch of the chat; branch "" means the current branch. served is the
// branch id the answer is for.
func (m *Manager) ItemsOf(id, branch string) (served string, version int, items []model.Item, subs []model.Subagent, err error) {
	t, err := m.ThreadOf(id, branch)
	return t.Branch, t.Version, t.Items, t.Subagents, err
}

// SubItemsOf is SubItems for one branch of the chat; branch "" means the current branch.
func (m *Manager) SubItemsOf(id, branch, sid string) (int, []model.Item, error) {
	var out outbox
	c, _, err := m.lockBranch(id, branch)
	if err != nil {
		return 0, nil, err
	}
	defer func() { c.mu.Unlock(); m.send(out) }()
	if _, err := m.trOf(c, &out); err != nil {
		return 0, nil, err
	}
	s, ok := c.subs[sid]
	if !ok {
		return 0, nil, ErrNoSubagent
	}
	tr, err := m.subTr(c, s)
	if err != nil {
		return 0, nil, err
	}
	v, items := tr.Snapshot()
	return v, items, nil
}

// ---- the two stops --------------------------------------------------------

// stopBranch is "stop one branch": the agent of the one chat object with the server id id is
// ended, with its subagents and their tokens; no other branch of its chat is touched.
func (m *Manager) stopBranch(id string) {
	if c, err := m.get(id); err == nil {
		m.stopOne(c)
	}
}

// stopOne ends the agent of the chat object c: pending approvals are answered "no", its subagents
// are stopped and their tokens revoked. Its thread gets one "Stopped." note when a turn was running
// or a running subagent was stopped, app-spawned or native: a chat object that only waited on its
// subagents says so too. A turn carrying subagent results is settled as stopped by the human, and
// the chat object is held.
//
// The process of a run's agent is closed after c.mu is released, on a goroutine of its own
// (closeAgents): an adapter's Close can wait for the process without limit, and the pump, which
// takes c.mu for every event, must go on draining what the closing process still says.
func (m *Manager) stopOne(c *Chat) {
	var out outbox
	c.mu.Lock()
	var toClose []agent.Agent
	defer func() { c.mu.Unlock(); m.send(out); closeAgents(toClose) }()
	if c.deleted || c.unlisted {
		return
	}
	setHold(c)
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
			ups = append(ups, tr.Decided(it.Subagent, it.RequestID, false)...)
		}
	}
	if c.ag != nil {
		if turnRunning(c) {
			costLost(c, c.meta.Agent) // the turn it is in reports no cost any more
		}
		c.gen++
		if c.role != "" {
			toClose = append(toClose, c.ag)
		} else {
			_ = c.ag.Interrupt()
			c.ag.Close()
		}
		c.ag = nil
	}
	c.wait.stopped()
	wakeOwned(c)
	if c.carry != nil { // its turn ends here: the pump drops what the old process still says
		c.carry.human = true
		m.endCarry(c, false, &out)
	}
	stopped := 0 // stopSubs stops every running subagent, a native one too
	for _, s := range c.subs {
		if s.meta.Status == model.SubRunning {
			stopped++
		}
	}
	toClose = append(toClose, m.stopSubs(c, &out)...)
	m.revokeChatExtras(c.meta.ID)
	if wasBusy || stopped > 0 {
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

// retire takes a chat object that is being deleted out of the manager: nothing more is written
// or emitted for it, a process a late Send gave it is closed, its tokens stop resolving and it
// leaves the map. Its folder is the caller's to remove. It reports false, having done nothing,
// for a chat object that was retired before.
func (m *Manager) retire(c *Chat) bool {
	c.mu.Lock()
	if c.deleted {
		c.mu.Unlock()
		return false
	}
	c.deleted = true
	c.gone.Store(true)
	c.gen++
	wakeOwned(c) // a WaitOwned answers ErrNotFound
	id, tok := c.meta.ID, c.meta.Token
	var toClose []agent.Agent
	if c.ag != nil { // a Send that came in after Stop
		if c.role != "" {
			toClose = append(toClose, c.ag) // as stopOne closes it
		} else {
			c.ag.Close()
		}
		c.ag = nil
	}
	c.carry = nil
	c.mu.Unlock()
	closeAgents(toClose)
	m.revokeChatExtras(id)
	m.unregisterChatToken(tok)
	m.mu.Lock()
	if m.chats[id] == c {
		delete(m.chats, id)
	}
	m.mu.Unlock()
	return true
}
