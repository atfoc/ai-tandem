// Send with a target: the one place a branch comes to exist (D4, D5, D7, D8 and D11 of the chat
// forking plan). Choosing a point changes nothing on the server; the next Send carries the point,
// and either carries the branch it is on further or starts a new branch there.
package chats

import (
	"fmt"
	"os"
	"path/filepath"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// Target is where a message is sent: a point of one of the chat's branches. New asks for a new
// branch even at the end of that branch.
type Target struct {
	Branch string
	At     int
	New    bool
}

// SendTo is Send to a point of the chat id. At the end of a branch, unless t.New is set, the
// branch is carried on in its own session: it becomes the current branch and the message is sent
// on it as Send does. At every other point a new branch is made, holding the first t.At items of
// t.Branch in a session forked there, with the message as its first own item.
//
// Whichever branch becomes current, the branch left is stopped (D4). A new branch is made in
// Fork's order (D8): unlisted while its process starts, visible only once the message is on it
// and it is in the tree record. When anything fails nothing is left of it: the tree record and
// the current branch are as before, and the branch left still runs.
func (m *Manager) SendTo(id string, t Target, text, context string, refs []model.Reference) error {
	top, err := m.topChat(id)
	if err != nil {
		return err
	}
	top.moveMu.Lock()
	c, from, made, err := m.sendTarget(id, t, refs)
	if err != nil {
		top.moveMu.Unlock()
		return err
	}
	if !made {
		// Carrying on: the branch's session goes on, by a resume or, while D9 keeps its source,
		// by the fork capability. No id is needed.
		defer top.moveMu.Unlock()
		if left := m.current(top); left != c {
			if err := m.setCurrent(id, t.Branch); err != nil {
				return err
			}
			m.stopOne(left)
		}
		return m.Send(id, text, context, refs)
	}
	top.moveMu.Unlock()

	sid := branchChatID(id, c.branch)
	forked := false
	fail := func(err error) error {
		m.dropUnlisted(c, forked)
		os.Remove(filepath.Dir(m.Store.P.ChatDir(sid))) // branches/, when nothing else is in it
		return err
	}

	// Step 2. The start of a chat (D7) has nothing to fork: the branch stays unlocked, and the
	// Send below starts its process as a new session.
	if t.At > 0 {
		if err := m.startFork(c, from, t.At); err != nil {
			return fail(err)
		}
		forked = true
	}

	// Step 3.
	top.moveMu.Lock()
	defer top.moveMu.Unlock()
	if err := m.sourceLive(id); err != nil {
		return fail(err)
	}
	left, err := m.lockCur(id)
	if err != nil {
		return fail(err)
	}
	leftBusy := busy(left)
	left.mu.Unlock()
	if leftBusy {
		return fail(ErrBusy) // a message was sent on it during the start
	}
	c.mu.Lock()
	if c.deleted { // with its chat
		c.mu.Unlock()
		return fail(ErrNotFound)
	}
	// The message goes to the process step 2 attached; only the empty branch starts one here.
	if err := m.sendOn(c, text, context, refs); err != nil {
		return fail(err)
	}
	c.mu.Lock()
	err = ErrNotFound
	if !c.deleted {
		err = m.writeMeta(c) // a restart skips a recorded branch without chat.json
	}
	c.mu.Unlock()
	if err != nil {
		return fail(err)
	}
	err = m.updateTree(id, func(tr *model.Tree) error {
		if _, dup := branchOf(*tr, c.branch); dup {
			return fmt.Errorf("the branch %s is already there", c.branch)
		}
		// The branch splits from the owner of the point: the same place may be named through
		// any branch that shares it.
		owner := model.MainBranch
		if t.At > 0 {
			owner = ownerOf(*tr, t.Branch, t.At-1)
		}
		tr.Branches = append(tr.Branches, model.TreeBranch{ID: c.branch, From: owner, At: t.At})
		tr.Current = c.branch
		return nil
	})
	if err != nil {
		return fail(err)
	}

	// Step 4.
	c.mu.Lock()
	if c.deleted {
		c.mu.Unlock()
		return fail(ErrNotFound)
	}
	if err := m.addBranch(c, sid); err != nil {
		c.mu.Unlock()
		return fail(err)
	}
	c.unlisted = false
	m.logSave(c) // what its process reported while it was unlisted
	m.makeCurrent(top, c)
	c.mu.Unlock()
	m.stopOne(left)
	m.clearDraft(top)
	m.emitView(top)
	return nil
}

// sendTarget checks that a message may be sent to the point t of the top-level chat id, with the
// quotes refs. When the message carries the branch on, it returns that branch's chat object and
// made false. Else it is D8 step 1: the unlisted entry of a new branch, holding the first t.At
// items of t.Branch, is made and returned with the session it is forked from, and made is true.
// Nothing is created when an error is returned. The chat's moveMu held.
func (m *Manager) sendTarget(id string, t Target, refs []model.Reference) (c *Chat, from agent.ForkSource, made bool, err error) {
	none := agent.ForkSource{}
	cur, err := m.lockCur(id)
	if err != nil {
		return nil, none, false, err
	}
	parent, curBusy := m.parentOf(cur), busy(cur)
	cur.mu.Unlock()
	switch {
	case parent.Archived:
		return nil, none, false, ErrArchived
	case parent.InstructionsSent:
		return nil, none, false, ErrLegacy
	case curBusy:
		return nil, none, false, ErrBusy
	}

	var loaded outbox // what loading the branch's transcript sends
	src, err := m.branchChat(id, t.Branch)
	if err != nil {
		return nil, none, false, err
	}
	defer func() {
		src.mu.Unlock()
		m.send(loaded)
		if made && c.top == nil {
			// The chat was deleted meanwhile: the entry found no chat to belong to.
			m.dropUnlisted(c, false)
			c, from, made, err = nil, none, false, ErrNotFound
		}
	}()
	tr, err := m.trOf(src, &loaded)
	if err != nil {
		return nil, none, false, err
	}
	if busy(src) {
		return nil, none, false, ErrBusy
	}
	_, items := tr.Snapshot()
	if t.At < 0 || t.At > len(items) {
		return nil, none, false, ErrBadPoint
	}
	if !t.New && sessionEnd(items, t.At) {
		if !refsIn(items, refs) {
			return nil, none, false, ErrBadReference
		}
		return src, none, false, nil
	}

	// A new branch. The "fork only at an end" rule is not for branches.
	if !pointOK(src.meta.Agent, items, t.At) {
		return nil, none, false, ErrBadPoint
	}
	if !refsIn(items[:t.At], refs) { // a quote of what the branch lacks would name another item there
		return nil, none, false, ErrBadReference
	}
	tree, err := m.readTree(id)
	if err != nil {
		return nil, none, false, err // an unreadable record is never written over: no branch can be added
	}
	// D11: the agent, its settings and the board are the branch's it starts from; name, group,
	// draft and archive state stay the top-level chat's.
	meta := prefixMeta(src.meta, items, t.At)
	meta.ID = branchChatID(id, m.newBranchID(id, tree))
	c, err = m.addUnlisted(src, meta, t.At)
	if err != nil {
		return nil, none, false, err
	}
	return c, forkSourceOf(src.meta, items, t.At), true, nil
}

// newBranchID is a branch id that neither the tree record t of the chat nor a folder under its
// branches/ has: a folder the record does not name is what a crash left of a branch being made.
func (m *Manager) newBranchID(chat string, t model.Tree) string {
	for {
		b := randHex(4)
		if _, taken := branchOf(t, b); taken {
			continue
		}
		if _, err := os.Lstat(m.Store.P.ChatDir(branchChatID(chat, b))); err == nil {
			continue
		}
		return b
	}
}
