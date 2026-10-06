// Send with a target: the one place a branch comes to exist (D5, D7, D8 and D11 of the chat
// forking plan; 4.5 of the concurrent branches plan for what a Send does to the other branches,
// which is nothing). Choosing a point changes nothing on the server; the next Send carries the
// point, and either carries the branch it is on further or starts a new branch there.
package chats

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// Target is where a message is sent: a point of one of the chat's branches. New asks for a new
// branch even at the end of that branch. End names the end of Branch whatever its length, and At
// and New are ignored: the message carries the branch on and never makes a new one, which an At
// that the branch has grown past since the client read it would.
//
// Model and Effort are the choice for a new branch, "" for those of Branch (see choose). A target
// that carries a branch on takes none: the branch is locked (ErrLocked).
type Target struct {
	Branch string
	At     int
	New    bool
	End    bool
	Model  string
	Effort string
}

// SendTo is Send to a point of the chat id. At the end of a branch (t.End, or t.At there), unless
// t.New is set, the branch is carried on in its own session: the message is sent on it as Send
// does. At every other point a new branch is made, holding the first t.At items of t.Branch in a
// session forked there, with the message as its first own item.
//
// Whether the message may go is the matter of the branch it goes to alone. ErrBusy says that this
// branch is busy; a new branch may start at a finished boundary of a branch whose turn is
// running, and a point inside or after that turn is ErrBadPoint. No other branch is looked at,
// and none is stopped: the branch that was current keeps its process and its turn.
//
// The branch the message got onto becomes the chat's current branch, once the message is in its
// thread. A new branch is made in Fork's order (D8): unlisted while its process starts, visible
// only once the message is on it and it is in the tree record. When the message does not get onto
// its branch nothing is left of the Send: the tree record and the current branch are as before.
// So a branch that is carried on and whose process does not start is not made current, and the
// error of the start stays on the branch's own record. When its process refused the message, the
// message is in its thread as after a refused Send: the error is returned and the branch is the
// current one.
func (m *Manager) SendTo(id string, t Target, text, context string, refs []model.Reference) error {
	_, err := m.SendToBranch(id, t, text, context, refs)
	return err
}

// SendToBranch is SendTo, and returns the id of the branch the message was put on ("main" for
// main): t.Branch when it is carried on, else the id of the new branch. It is "" with an error.
func (m *Manager) SendToBranch(id string, t Target, text, context string, refs []model.Reference) (branch string, err error) {
	if err := m.person(id); err != nil {
		return "", err
	}
	top, err := m.topChat(id)
	if err != nil {
		return "", err
	}
	c, from, made, err := m.sendTarget(id, t, refs)
	if err != nil {
		return "", err
	}
	if !made {
		// Carrying on: the branch's session goes on, by a resume or, while D9 keeps its source,
		// by the fork capability. No id is needed.
		c.mu.Lock()
		if c.deleted {
			c.mu.Unlock()
			return "", ErrNotFound
		}
		on, err := m.sendOn(c, text, context, refs)
		if on {
			// The record first could not be undone when the start fails; after the message, a
			// record that cannot be written leaves the chat opening on the branch it did before.
			if cerr := m.setCurrent(id, t.Branch); cerr != nil && !errors.Is(cerr, ErrNotFound) {
				log.Printf("chats: current branch of %s: %v", id, cerr)
			}
		}
		if err != nil {
			return "", err
		}
		return t.Branch, nil
	}

	sid := branchChatID(id, c.branch)
	forked := false
	fail := func(err error) (string, error) {
		m.dropUnlisted(c, forked)
		os.Remove(filepath.Dir(m.chatDir(sid))) // branches/, when nothing else is in it
		return "", err
	}

	// Step 2. The start of a chat (D7) has nothing to fork: the branch stays unlocked, and the
	// Send below starts its process as a new session.
	if t.At > 0 {
		if err := m.startFork(c, from, t.At); err != nil {
			return fail(err)
		}
		forked = true
	}

	// Step 3. The message goes to the process step 2 attached; only the empty branch, and one
	// whose process exited meanwhile, starts one here.
	if err := m.sourceLive(id); err != nil {
		return fail(err)
	}
	c.mu.Lock()
	if c.deleted { // with its chat
		c.mu.Unlock()
		return fail(ErrNotFound)
	}
	if _, err := m.sendOn(c, text, context, refs); err != nil {
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

	// Step 4. The listing, one step of the change of the current branch (see Chat.moveMu): the
	// record gets the branch and names it as current, then memory does.
	top.moveMu.Lock()
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
		top.moveMu.Unlock()
		return fail(err)
	}
	c.mu.Lock()
	if c.deleted {
		c.mu.Unlock()
		top.moveMu.Unlock()
		return fail(ErrNotFound)
	}
	if err := m.addBranch(c, sid); err != nil {
		c.mu.Unlock()
		top.moveMu.Unlock()
		return fail(err)
	}
	c.unlisted = false
	m.logSave(c) // what its process reported while it was unlisted
	m.makeCurrent(top, c)
	archived := m.parentOf(c).Archived
	c.mu.Unlock()
	top.moveMu.Unlock()
	if archived {
		// Archived while the message went to the branch's process: the Stop of the archive
		// found no branch to stop, since an unlisted one is not yet the chat's. One that comes
		// after this check finds it.
		m.stopOne(c)
	}
	m.emitState(c) // its first: nothing was sent of the branch while it was unlisted
	m.emitView(top)
	m.emitTree(id, top, c, false, true, false) // the tree gets the branch, and names it as current
	return c.branch, nil
}

// sendTarget checks that a message may be sent to the point t of the top-level chat id, with the
// quotes refs. Only the branch t names is looked at: the chat's current branch may be busy. When
// the message carries the branch on, it returns that branch's chat object and made false; a busy
// branch is not carried on (ErrBusy). Else it is D8 step 1: the unlisted entry of a new branch,
// holding the first t.At items of t.Branch, is made and returned with the session it is forked
// from, and made is true. The branch it starts from may be busy: the point must then be a
// finished boundary of it (pointOK), and the cap on running turns must leave the new branch a slot
// (ErrChatCap, ErrAppCap). A new branch takes the model and effort t names (see choose), which
// the window guard may refuse (ErrWindow); a branch that is carried on takes none (ErrLocked,
// before ErrBusy). Nothing is created when an error is returned. The branch
// named is resolved before anything else is checked: an unknown one is ErrNoBranch whatever the
// state of the chat.
func (m *Manager) sendTarget(id string, t Target, refs []model.Reference) (c *Chat, from agent.ForkSource, made bool, err error) {
	none := agent.ForkSource{}
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
	switch parent := m.parentOf(src); {
	case parent.Archived:
		return nil, none, false, ErrArchived
	case parent.InstructionsSent:
		return nil, none, false, ErrLegacy
	}
	tr, err := m.trOf(src, &loaded)
	if err != nil {
		return nil, none, false, err
	}
	running := busy(src)
	_, items := tr.Snapshot()
	if !t.End && (t.At < 0 || t.At > len(items)) {
		return nil, none, false, ErrBadPoint
	}
	if t.End || (!t.New && sessionEnd(items, t.At)) {
		if t.Model != "" || t.Effort != "" {
			return nil, none, false, ErrLocked // also the branch's own: nothing is chosen for a branch that is there
		}
		if running {
			return nil, none, false, ErrBusy
		}
		if !refsIn(items, refs) {
			return nil, none, false, ErrBadReference
		}
		return src, none, false, nil
	}

	// A new branch. The "fork only at an end" rule is not for branches. Of a branch whose turn is
	// running only the finished boundaries pass.
	if !pointOK(src.meta.Agent, items, t.At, running) {
		return nil, none, false, ErrBadPoint
	}
	if !refsIn(items[:t.At], refs) { // a quote of what the branch lacks would name another item there
		return nil, none, false, ErrBadReference
	}
	// The branch's model and effort: those of the branch it starts from, unless the target names
	// others. Before the cap: a model that cannot take the conversation never will, and a slot
	// comes free.
	mc, cm, err := m.choose(src.meta.Agent, model.ModelChoice{Model: src.meta.Model, Effort: src.meta.Effort}, t.Model, t.Effort)
	if err != nil {
		return nil, none, false, err
	}
	if t.At > 0 { // at the start of the chat nothing is handed to the model
		if err := windowGuard(src.meta.Agent, ctxOf(src.meta), src.meta.Model, mc.Model, cm); err != nil {
			return nil, none, false, err
		}
	}
	// At the cap the message would be refused once the branch's process is there (sendOn): no
	// branch is made and no fork started for it.
	if err := m.capCheck(src); err != nil {
		return nil, none, false, err
	}
	tree, err := m.readTree(id)
	if err != nil {
		return nil, none, false, err // an unreadable record is never written over: no branch can be added
	}
	// D11: the agent, its folder and the board are the branch's it starts from, and so are its
	// model and effort unless the target chose others; name, group
	// and archive state stay the top-level chat's. It has no draft: the one of the branch it
	// starts from stays that branch's.
	meta := prefixMeta(src.meta, items, t.At, mc, windowOf(cm))
	meta.ID = branchChatID(id, m.newBranchID(id, tree))
	c, err = m.addUnlisted(src, meta, t.At)
	if err != nil {
		return nil, none, false, err
	}
	return c, forkSourceOf(src.meta, items, t.At, running), true, nil
}

// newBranchID is a branch id that neither the tree record t of the chat nor a folder under its
// branches/ has: a folder the record does not name is what a crash left of a branch being made.
func (m *Manager) newBranchID(chat string, t model.Tree) string {
	for {
		b := randHex(4)
		if _, taken := branchOf(t, b); taken {
			continue
		}
		if _, err := os.Lstat(m.chatDir(branchChatID(chat, b))); err == nil {
			continue
		}
		return b
	}
}
