// Branches in the manager (D3, D4, D6 and D10 of the chat forking plan). A branch other than main
// is a chat object of its own, under the server id <chat id>/branches/<branch id>, linked to its
// top-level chat and never listed. The client names the chat by its top-level id only: the
// session-side operations go to the chat's current branch, the others to the top-level chat.
//
// Locks: a branch's mu may be held while its top-level chat's mu is taken (for the flags and the
// identity only the top-level chat has), never the other way round, and never two branches' at
// once. The registry (Chat.kids and Chat.cur) is guarded by Manager.mu, which is taken last.
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
		raw, err := os.ReadFile(filepath.Join(m.Store.P.ChatDir(sid), "chat.json"))
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
// operations (name, group, draft, archive) act on it whatever the current branch is.
func (m *Manager) lockTop(id string) (*Chat, error) {
	if _, err := m.topChat(id); err != nil {
		return nil, err
	}
	return m.lock(id)
}

// lockCur returns the current branch of the top-level chat id with its mu held: the session-side
// operations act on it.
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
// current one. served is the id of the branch returned.
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

// setCurrent makes a registered branch of the top-level chat id the current one: the tree record
// first (left alone when it names the branch already), then memory, and the chat's view is sent.
// It stops nothing (see stopBranch). No chat's mu may be held.
func (m *Manager) setCurrent(id, branch string) error {
	c, err := m.branchObj(id, branch)
	if err != nil {
		return err
	}
	top := topOf(c)
	err = m.updateTree(id, func(t *model.Tree) error {
		if t.Current == branch || (t.Current == "" && branch == model.MainBranch) {
			return errTreeSame
		}
		t.Current = branch
		return nil
	})
	if err != nil && !errors.Is(err, errTreeSame) {
		return err
	}
	m.makeCurrent(top, c)
	m.emitView(top)
	return nil
}

// makeCurrent is the memory half of setCurrent: the chat object c, top itself or one of its
// registered branches, is the current branch of top from now on. The tree record is the caller's
// to write.
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

// parentOf is the meta of c's top-level chat: what holds the chat's name, group, board, draft,
// archive state and legacy flag (a branch's own chat.json has none of them). c.mu held.
func (m *Manager) parentOf(c *Chat) model.ChatMeta {
	if c.top == nil {
		return c.meta
	}
	c.top.mu.Lock()
	defer c.top.mu.Unlock()
	return c.top.meta
}

// clearDraft drops the draft of the top-level chat top: a message was sent on one of its
// branches. No chat's mu may be held. The view is sent by the caller.
func (m *Manager) clearDraft(top *Chat) {
	top.mu.Lock()
	defer top.mu.Unlock()
	if top.deleted || top.meta.Draft == nil {
		return
	}
	top.meta.Draft = nil
	m.logSave(top)
}

// ---- the composed view ----------------------------------------------------

// chatEvent is a "chat" event waiting in an outbox. It holds the view of the chat object that
// queued it, taken under its lock; the half another chat object holds is read when the event is
// sent (see chatView).
type chatEvent struct {
	c       *Chat
	v       model.ChatView
	session bool // c's session side changed; else the top-level chat c's identity did
}

// compose is the view of a chat: identity (name, group, board, draft, archive, ...) from its
// top-level chat's view, the session side (settings, usage, status) from its current branch's.
func compose(identity, session model.ChatView) model.ChatView {
	v := identity
	v.Cwd, v.Model, v.Effort, v.Locked, v.Usage = session.Cwd, session.Model, session.Effort, session.Locked, session.Usage
	v.Status, v.StatusTool, v.Error, v.FolderMissing = session.Status, session.StatusTool, session.Error, session.FolderMissing
	v.SubsRunning, v.SubsOwed = session.SubsRunning, session.SubsOwed
	return v
}

// chatView is the view a queued chat event carries: one per top-level chat, composed. ok is false
// when nothing is to be sent: the session side of a branch that is not current changed. No
// chat's mu may be held.
func (m *Manager) chatView(e chatEvent) (v model.ChatView, ok bool) {
	top := topOf(e.c)
	m.mu.Lock()
	cur, n := top.cur, len(top.kids)
	m.mu.Unlock()
	if cur == nil {
		cur = top
	}
	switch {
	case e.session && e.c != cur:
		return model.ChatView{}, false
	case e.c == cur && cur == top:
		v = e.v
	case e.c == top: // its identity changed; the current branch has the rest
		cur.mu.Lock()
		v = compose(e.v, view(cur))
		cur.mu.Unlock()
	default: // the current branch changed; its top-level chat has the rest
		top.mu.Lock()
		gone := top.deleted
		v = compose(view(top), e.v)
		top.mu.Unlock()
		if gone {
			return model.ChatView{}, false
		}
	}
	if n > 0 {
		v.Branches = n + 1
	}
	if cur != top {
		v.Branch = cur.branch
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

// ItemsOf is Items for one branch of the chat; branch "" means the current branch. served is the
// branch id the answer is for.
func (m *Manager) ItemsOf(id, branch string) (served string, version int, items []model.Item, subs []model.Subagent, err error) {
	var out outbox
	c, served, err := m.lockBranch(id, branch)
	if err != nil {
		return "", 0, nil, nil, err
	}
	tr, err := m.trOf(c, &out)
	if err == nil {
		version, items = tr.Snapshot()
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
	return served, version, items, subs, err
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

// stopBranch is "stop one branch" (D4): the agent of the one chat object with the server id id
// is ended, with its subagents and their tokens; no other branch of its chat is touched.
func (m *Manager) stopBranch(id string) {
	if c, err := m.get(id); err == nil {
		m.stopOne(c)
	}
}

// stopOne ends the agent of the chat object c: pending approvals are answered "no", a running
// turn gets a "Stopped." note, its subagents are stopped and their tokens revoked. A turn carrying
// subagent results is settled as stopped by the human, and the chat object is held.
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
		c.gen++
		_ = c.ag.Interrupt()
		c.ag.Close()
		c.ag = nil
	}
	if c.carry != nil { // its turn ends here: the pump drops what the old process still says
		c.carry.human = true
		m.endCarry(c, false, &out)
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
	c.gen++
	id, tok := c.meta.ID, c.meta.Token
	if c.ag != nil { // a Send that came in after Stop
		c.ag.Close()
		c.ag = nil
	}
	c.carry = nil
	c.mu.Unlock()
	m.revokeChatExtras(id)
	m.unregisterChatToken(tok)
	m.mu.Lock()
	if m.chats[id] == c {
		delete(m.chats, id)
	}
	m.mu.Unlock()
	return true
}
