// Forking a chat to a new chat: a copy of the source up to a point, running in its own agent
// session forked from the source's (D7, D8, D9 and D11 of the chat forking plan).
package chats

import (
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/transcript"
)

type ForkReq struct {
	Branch  string // the branch the point is on: "main" or a branch id
	At      int    // the point: an item count of that branch
	Message *int   // Fork and edit: the index of the user message that becomes the new chat's draft
}

// closeWait is how long a fork that is given up waits for its process to close before what the
// start created is discarded. Cursor's Close can wait forever; its process is killed after 3 s.
const closeWait = 10 * time.Second

func errNoForker(a model.AgentKind) error {
	return fmt.Errorf("forking is not available for %s chats", a)
}

// errForkGone refuses the start of a fork that has no session of its own yet and no id to cut its
// source's session at, once that session no longer ends where the fork's thread does: made now,
// the fork's agent would know turns its thread does not show (see sourceKept).
var errForkGone = errors.New("this fork was made at a point Claude has no id for, and the chat it was forked from has gone on since: it can no longer be started")

// Fork makes a new chat holding the first req.At items of a branch of the chat id, in a session
// forked from that branch's at that point. The source chat is not stopped, changed or re-emitted.
//
// The new chat is in the manager's map from the start, unlisted: its agent finds its MCP token
// while it starts, but no client sees the chat, and nothing is saved or emitted for it, until the
// provider has confirmed the fork. When anything fails nothing is left of it.
func (m *Manager) Fork(id string, req ForkReq) (model.ChatView, error) {
	if err := m.person(id); err != nil {
		return model.ChatView{}, err
	}
	var loaded outbox // what loading the source's transcript sends
	// Only the current branch has a process (D4): a chat is busy when that branch is.
	curBusy := m.Busy(id)
	src, err := m.branchChat(id, req.Branch)
	if err != nil {
		return model.ChatView{}, err
	}
	c, from, err := m.forkEntry(src, id, curBusy, req, &loaded)
	// A fork that goes through src's own fork source (see forkSourceOf) at a place no id names is
	// made of the whole session of that source: ends is the item count that session must end at.
	ends := -1
	if fs := src.meta.ForkSource; err == nil && fs != nil && from.ChatID == fs.Chat && from.Point == "" {
		ends = fs.Items
	}
	src.mu.Unlock()
	m.send(loaded)
	if err != nil {
		return model.ChatView{}, err
	}
	forked := false
	fail := func(err error) (model.ChatView, error) {
		m.dropUnlisted(c, forked)
		return model.ChatView{}, err
	}

	// The start of a chat (D7) has nothing to fork: the new chat stays unlocked, with a fresh
	// session and no process.
	if req.At > 0 {
		if ends >= 0 && !m.sourceKept(from.ChatID, ends) {
			return fail(errForkGone) // as the start of src itself is refused (see spawnFork)
		}
		if err := m.startFork(c, from, req.At); err != nil {
			return fail(err)
		}
		forked = true
		if ends >= 0 {
			// The record keeps the count of the source's thread, which a later start checks the
			// source with: src's own thread may be longer by what its start added (an end mark),
			// never by a message.
			c.mu.Lock()
			if c.meta.ForkSource != nil {
				c.meta.ForkSource.Items = ends
			}
			c.mu.Unlock()
		}
	}

	if err := m.sourceLive(id); err != nil {
		return fail(err)
	}
	t, err := m.readTree(id)
	if err != nil {
		log.Printf("chats: fork %s: %v", id, err) // an unreadable record: one branch, no labels
		t = model.Tree{}
	}
	// The labels of the copied path are the new chat's own from now on.
	labels := labelsOnPath(t, req.Branch, req.At)
	c.mu.Lock()
	err = nil
	if len(labels) > 0 {
		err = store.WriteJSONAtomic(m.treePath(c.meta.ID), model.Tree{Branches: []model.TreeBranch{}, Labels: labels}, 0o600)
	}
	if err == nil {
		err = m.writeMeta(c) // last: a restart skips a folder without chat.json
	}
	if err != nil {
		c.mu.Unlock()
		return fail(err)
	}
	var out outbox
	c.unlisted = false
	out.emitChat(c)
	v := view(c)
	c.mu.Unlock()
	m.send(out)
	return v, nil
}

// branchChat returns the chat object of a branch of the top-level chat id, with its mu held:
// ErrNotFound for an unknown chat, ErrNoBranch for a branch that is not registered.
func (m *Manager) branchChat(id, branch string) (*Chat, error) {
	c, err := m.branchObj(id, branch)
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

// forkEntry checks that the chat top, whose branch src is, may be forked as req asks, and makes
// the unlisted entry of the new chat. It also returns the session the fork is made from. curBusy
// says that the chat's current branch is busy. What the new chat takes from the chat itself
// (title, group, board) is the top-level chat's. src.mu held.
func (m *Manager) forkEntry(src *Chat, top string, curBusy bool, req ForkReq, out *outbox) (*Chat, agent.ForkSource, error) {
	none := agent.ForkSource{}
	parent := m.parentOf(src)
	if parent.Archived {
		return nil, none, ErrArchived
	}
	if parent.InstructionsSent {
		return nil, none, ErrLegacy
	}
	tr, err := m.trOf(src, out)
	if err != nil {
		return nil, none, err
	}
	if busy(src) || curBusy {
		return nil, none, ErrBusy
	}
	_, items := tr.Snapshot()
	// A fork, unlike a new branch, may also start at the end of an idle branch, whatever its marks.
	// Without an id on its last mark the fork is made of the whole session, and Claude's can be
	// made again only while the branch has said nothing since (see spawnFork).
	if !pointOK(src.meta.Agent, items, req.At) && (req.At == 0 || req.At != len(items)) {
		return nil, none, ErrBadPoint
	}
	var draft *model.Draft
	if req.Message != nil {
		if at, ok := cutBefore(items, *req.Message); !ok || at != req.At {
			return nil, none, ErrBadPoint
		}
		// The quotes of what the copy lacks would name other items there.
		msg := items[*req.Message]
		draft = &model.Draft{Text: msg.Text}
		for _, r := range msg.References {
			if r.Item < req.At {
				draft.References = append(draft.References, r)
			}
		}
	}
	if parent.Board != "" {
		bd, ok := m.Boards.Get(parent.Board)
		if !ok {
			return nil, none, boards.ErrNotFound
		}
		if bd.Archived {
			return nil, none, boards.ErrArchived
		}
	}
	if parent.Run != "" { // the fork is a chat on the same run
		if _, err := m.openRun(parent.Run); err != nil {
			return nil, none, err
		}
	}

	title := titleOf(parent, items)
	meta := prefixMeta(src.meta, items, req.At)
	meta.ID = uuid()
	meta.Board = parent.Board
	meta.Run = parent.Run
	meta.Group = parent.Group // empty for a board chat and for a chat on a run
	meta.Name = title + " (fork)"
	meta.Draft = draft
	meta.ForkedFrom, meta.ForkedFromTitle = top, title
	c, err := m.addUnlisted(src, meta, req.At)
	if err != nil {
		return nil, none, err
	}
	return c, forkSourceOf(src.meta, items, req.At), nil
}

// titleOf is the chat's title as the client shows it (chatTitle in web/src/store.ts): its name,
// else its first message cut to 40 characters, else "New chat".
func titleOf(meta model.ChatMeta, items []model.Item) string {
	if meta.Name != "" {
		return meta.Name
	}
	for _, it := range items {
		if it.Kind != "user" {
			continue
		}
		t := strings.Join(strings.Fields(PlainText(it.Text)), " ")
		if t == "" {
			break
		}
		if r := []rune(t); len(r) > 42 {
			t = string(r[:40]) + "…"
		}
		return t
	}
	return "New chat"
}

// prefixMeta is what the chat.json of a new chat or branch that starts with the first at items
// of the chat (src, items) takes from it (D11): the agent and its settings, a session id of its
// own, and what follows from the prefix. It is never a copy of the file. The caller sets the id
// and what differs between a fork and a branch; addUnlisted gives the token. A fork or branch of
// a chat on a run is on that run.
func prefixMeta(src model.ChatMeta, items []model.Item, at int) model.ChatMeta {
	meta := model.ChatMeta{Agent: src.Agent, Board: src.Board, Run: src.Run, Cwd: src.Cwd, Model: src.Model,
		Effort: src.Effort, Created: time.Now()}
	if src.Agent == model.Claude || src.Agent == model.Pi {
		meta.SessionID = uuid() // Cursor's comes from the fork start, or from session/new
	}
	for _, it := range items[:at] {
		switch it.Kind {
		case "user":
			meta.Locked = true
		case "end":
			meta.Usage.Turns++
		}
	}
	if meta.Locked && meta.Usage.Turns == 0 {
		meta.Usage.Turns = 1 // turns ended before there were marks: 0 would read as a chat never used
	}
	meta.Usage.CtxWindow = src.Usage.CtxWindow
	if at == len(items) { // the context numbers are the last turn's only
		meta.Usage.CtxIn, meta.Usage.CtxOut = src.Usage.CtxIn, src.Usage.CtxOut
	}
	if at > 0 {
		meta.McpInstructionsSent = src.McpInstructionsSent
	}
	return meta
}

// forkSourceOf picks the session a fork of the chat (meta, items) at count at is made from (D9).
// While the chat still has its own fork source and nothing was sent past the prefix it started
// with, it has no session of its own to fork yet: the fork goes through that source, whose ids
// the copied marks kept. Else it is the chat's own session.
//
// Through a source, a fork with no point is of the whole source session: the caller starts it
// only while that session still ends where the chat's prefix does (Fork checks it with
// sourceKept). A new branch never gets there: it needs the id of the mark before it (pointOK).
func forkSourceOf(meta model.ChatMeta, items []model.Item, at int) agent.ForkSource {
	point := ""
	if at > 0 && items[at-1].Kind == "end" {
		point = items[at-1].Point
	}
	next, _ := nextMark(items, at) // pi forks the end of a turn with the id on the next turn's mark
	if fs := meta.ForkSource; fs != nil && !sentPast(items, fs.Items) {
		if point == "" {
			point = fs.Point
		}
		return agent.ForkSource{ChatID: fs.Chat, SessionID: fs.Session, Point: point, Next: next.Point}
	}
	return agent.ForkSource{ChatID: meta.ID, SessionID: meta.SessionID, Point: point, Next: next.Point,
		End: sessionEnd(items, at)}
}

// sentPast reports whether a user message lies at an index >= count.
func sentPast(items []model.Item, count int) bool {
	for i := max(count, 0); i < len(items); i++ {
		if items[i].Kind == "user" {
			return true
		}
	}
	return false
}

// addUnlisted is D8 step 1: it copies the first at items of src into the folder of the new chat
// object meta names, gives it a token, and puts it in the map unlisted, its transcript and
// subagents loaded. Its token resolves from now on; no chat.json is written. src.mu held, src's
// transcript loaded.
//
// A subagent's record is copied as it is now, not as it was at the point. A result that was
// carried in src (handed to its agent, to be retried, or given up) and whose row the copy lacks
// was never carried in the copy's thread: the copy's agent is owed it, and gets it with the
// copy's first human message. So is one whose row the copy has but which was last taken for a
// turn at or past the point (Carried): the row is from an earlier attempt that did not reach the
// agent, and the turn that carried it again is not in the copy. A record that owes nothing stays
// so. The new chat object is held, so the app starts no turn on it before the human has sent.
func (m *Manager) addUnlisted(src *Chat, meta model.ChatMeta, at int) (*Chat, error) {
	m.setRoot(meta) // before the copy makes the folder; a branch's id resolves through its chat's
	if err := m.copyPrefix(src, meta.ID, at); err != nil {
		m.dropRoot(meta.ID)
		return nil, err
	}
	tr, err := transcript.Load(m.itemsPath(meta.ID))
	if err != nil {
		os.RemoveAll(m.chatDir(meta.ID))
		m.dropRoot(meta.ID)
		return nil, err
	}
	m.extrasMu.Lock()
	meta.Token = m.uniqueTokenLocked()
	m.extrasMu.Unlock()
	c := &Chat{meta: meta, tr: tr, unlisted: true}
	m.loadSubs(c)
	for _, s := range c.subs {
		if s.meta.Delivery != model.SubNotOwed && s.meta.Delivery != model.SubOwed &&
			(!tr.HasSubResult(s.meta.ID) || s.meta.Carried >= at) {
			s.meta.Delivery = model.SubOwed
			m.saveSub(c, s)
		}
	}
	setHold(c)
	m.mu.Lock()
	m.linkBranch(c, meta.ID) // an entry made under a branch's server id is its chat's from the start
	m.chats[meta.ID] = c
	m.mu.Unlock()
	return c, nil
}

// startFork is D8 step 2: it starts the process of the unlisted chat c on a fork of src and, once
// the provider has confirmed the fork, attaches it to c at once, so that a Send to c goes to this
// process and starts no other. at is the item count of c's prefix. No chat lock is held during the
// start: the starting process looks its token up, which locks every chat.
func (m *Manager) startFork(c *Chat, src agent.ForkSource, at int) error {
	c.mu.Lock()
	opts := m.spawnOptions(c)
	kind := c.meta.Agent
	c.mu.Unlock()
	fk, ok := m.Spawners[kind].(agent.Forker)
	if !ok {
		return errNoForker(kind)
	}
	if m.down.Load() {
		return ErrShutdown
	}
	src.Dir = m.chatDir(src.ChatID)
	ag, sid, err := fk.SpawnFork(opts, src)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if m.down.Load() {
		// Shutdown began during the start and may have been at this chat already (see Manager.down).
		c.mu.Unlock()
		go ag.Close()
		return ErrShutdown
	}
	c.meta.SessionID = sid
	if kind == model.Claude {
		// Claude's fork is only durable once it has had a message: until then every launch makes
		// it again from the source. pi's and Cursor's exist from now on.
		c.meta.ForkSource = &model.ForkSource{Chat: src.ChatID, Session: src.SessionID, Point: src.Point,
			Next: src.Next, Items: at}
	}
	m.attach(c, ag)
	c.mu.Unlock()
	return nil
}

// sourceLive is the check of D8 step 3: the chat a fork was started from must still be there and
// not archived when the fork is done.
func (m *Manager) sourceLive(id string) error {
	src, err := m.lock(id)
	if err != nil {
		return err
	}
	defer src.mu.Unlock()
	if src.meta.Archived {
		return ErrArchived
	}
	return nil
}

// sourceKept reports whether the session of the chat object id (a chat's or a branch's server id)
// still ends where a fork that holds its first count items does: the chat object is there, and
// nothing was said in its thread past them. A fork with no id to cut at is the whole session, so
// it may be made only while this holds. No chat's mu may be held.
func (m *Manager) sourceKept(id string, count int) bool {
	var loaded outbox // what loading the source's transcript sends
	src, err := m.lock(id)
	if err != nil {
		return false
	}
	kept := false
	if tr, err := m.trOf(src, &loaded); err == nil {
		_, items := tr.Snapshot()
		kept = sessionEnd(items, count)
	}
	src.mu.Unlock()
	m.send(loaded)
	return kept
}

// dropUnlisted is D8's failure row: nothing is left of the unlisted chat c. Its process, if it
// has one, is closed in the background (Cursor's Close can block); the entry is retired as Delete
// does, so that no late write or flush makes its folder again; its token and folder are removed.
// forked says that the fork start had succeeded: what it created outside the app's folder is
// then discarded, once the process is closed.
func (m *Manager) dropUnlisted(c *Chat, forked bool) {
	var out outbox // never sent: nothing is emitted for an unlisted chat
	c.mu.Lock()
	toClose := m.stopSubs(c, &out)
	c.deleted = true
	c.gen++
	ag := c.ag
	c.ag = nil
	id, tok, kind, sid := c.meta.ID, c.meta.Token, c.meta.Agent, c.meta.SessionID
	c.mu.Unlock()
	closeAgents(toClose)
	m.revokeChatExtras(id)
	m.unregisterChatToken(tok)
	m.mu.Lock()
	delete(m.chats, id)
	m.mu.Unlock()
	if err := os.RemoveAll(m.chatDir(id)); err != nil {
		log.Printf("chats: remove %s: %v", id, err)
	}
	m.dropRoot(id) // a branch's id has none
	fk, _ := m.Spawners[kind].(agent.Forker)
	if !forked || fk == nil {
		closeAgents([]agent.Agent{ag})
		return
	}
	go func() {
		closed := make(chan struct{})
		go func() {
			if ag != nil {
				ag.Close()
			}
			close(closed)
		}()
		select {
		case <-closed:
		case <-time.After(closeWait):
		}
		fk.DiscardFork(sid)
	}()
}
