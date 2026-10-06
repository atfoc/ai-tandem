// The model and effort of a fork that has had no message of its own (4.6 of the concurrent
// branches plan). Such a fork (ChatMeta.Fresh) is started, but nothing was said on it yet, so its
// choice can still be changed: its process, which was started on the old choice, is started again
// on the new one, on a fork of the same source. Its first message ends that (see sendOn).
package chats

import (
	"errors"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// errOriginGone refuses the change of a Cursor fork's model once the fork cannot be made again:
// the chat or branch it was made from is gone, or its session no longer has the fork's point.
var errOriginGone = errors.New("the chat this fork was made from is gone, or can no longer be forked at that point: the fork's model and effort can't be changed any more")

// configureFresh is Configure for the fresh fork c: req's model and effort are taken, and c's
// process is started again on them (see restartFresh). A folder is not: the fork's session was
// made in the one it has. While c is busy, which a fresh fork is only during a start (this one's
// or a Send's), it is ErrBusy: the choice the record shows then is not settled. A choice that
// resolves to the one c has changes nothing and starts nothing. c.mu is held on entry and on
// return; it may be released in between (see restartFresh).
func (m *Manager) configureFresh(c *Chat, req ConfigReq, out *outbox) error {
	if req.Cwd != "" {
		return ErrLocked
	}
	if busy(c) {
		return ErrBusy
	}
	cur := model.ModelChoice{Model: c.meta.Model, Effort: c.meta.Effort}
	next, cm, err := m.choose(c.meta.Agent, cur, req.Model, req.Effort)
	if err != nil {
		return err
	}
	if next == cur {
		return nil
	}
	if err := windowGuard(c.meta.Agent, ctxOf(c.meta), cur.Model, next.Model, cm); err != nil {
		return err
	}
	return m.restartFresh(c, next, windowOf(cm), out)
}

// restartFresh gives the fresh fork c the choice next and starts its process again on it; window
// is the context window of next's model, 0 when it is not known, and is taken only for another
// model than c has (as prefixMeta does for a new fork). The record has the new choice before the
// start, which reads it there, and the previous one again after any error. On success c is ready,
// still fresh, saved and emitted. A fork with no process (after a restart of the app) is started
// the same way.
//
// The order differs by agent, as each was tried against the real CLI:
//
//   - pi: the old process is detached and closed, then an ordinary resume of the fork's own
//     session (spawn) takes the model. c.mu is held throughout, so a Send or a second change
//     waits. pi's Spawn returns before its handshake: only a start that fails at once is this
//     call's error, and one that fails later is the next Send's.
//   - Claude: the old process is detached and closed, then the fork is made again from its fork
//     source under the same session id (spawnFork), which shows c as thinking and releases c.mu
//     for the start. A fork made at a place no id names is first looked at (remakeable): one that
//     cannot be made again is refused there, with its process untouched. A fork without its fork
//     source is resumed as pi's is.
//   - Cursor: the new fork is started first (restartCursor), and the old process and store are
//     given up only once it is there and its session id is saved.
//
// pi and Claude close first because the new process uses the same session id or file; nothing
// waits for the old process to exit, as for a Stop followed by a Send. After their failed start
// the fork has no process and shows the error, as after any failed start (spawnFailed): the next
// Send or change starts one. A change that is refused before the close (remakeable) and a failed
// change of a Cursor fork leave c as it was, with its process.
//
// The start is no turn: it is not admitted through reserveTurn and never refused at the cap, and
// while it shows as thinking it counts as working, as a Send's fork start does (see cap.go). No
// reservation is made, and the emit that ends it takes c out of the count. Nor does the app
// start a turn on the new process: c is held until the human's first message.
//
// c.mu is held on entry and on return. Where it was released (Claude, Cursor), out was sent and
// emptied, and c may have been deleted or archived meanwhile: the new process is then closed and
// the error is ErrNotFound or ErrArchived. A fork that got its first message meanwhile (only
// after a Stop ended the wait) got it on the choice the record had then, so that one stays.
func (m *Manager) restartFresh(c *Chat, next model.ModelChoice, window int, out *outbox) error {
	// As a new fork is (addUnlisted): its process is there before the human has written in it,
	// and after a restart of the app nothing else held it.
	setHold(c)
	was := c.meta
	c.meta.Model, c.meta.Effort = next.Model, next.Effort
	if next.Model != was.Model {
		c.meta.Usage.CtxWindow = window // never the old model's: the meter would show the wrong one
	}
	var err error
	switch {
	case c.meta.Agent == model.Cursor:
		err = m.restartCursor(c, out)
	case c.meta.Agent == model.Claude && c.meta.ForkSource != nil:
		if err = m.remakeable(c, out); err == nil {
			detach(c)
			err = m.spawnFork(c, out)
		}
	default:
		detach(c)
		err = m.spawn(c, out)
	}
	if err != nil {
		if c.meta.Fresh {
			c.meta.Model, c.meta.Effort, c.meta.Usage.CtxWindow = was.Model, was.Effort, was.Usage.CtxWindow
		}
		if !c.deleted {
			// The failed start showed c with the new choice, and where c.mu was released
			// something else may have saved it.
			m.logSave(c)
			out.emitChat(c)
		}
		return err
	}
	if c.meta.Fresh { // else the status is that of the turn its first message started meanwhile
		c.tr.SetStatus(model.StatusReady)
	}
	if c.meta.Agent != model.Cursor { // restartCursor saved it, before it gave the old store up
		err = m.save(c)
	}
	out.emitChat(c)
	return err
}

// remakeable refuses the restart of the fresh Claude fork c that spawnFork would refuse, while c
// still has its process: a fork made at a place no id names can only be made of its whole source,
// so once that has gone on or is gone the answer is errForkGone, and nothing of c is closed or
// changed. Any other fork is not looked at. spawnFork looks again after the close: a source that
// goes on between the two looks still costs the fork its process.
//
// c.mu is held on entry and on return, but not during the look at the source, which locks that
// chat. Meanwhile c is busy (thinking), so a Send or a second change gets ErrBusy. When c was
// deleted or archived meanwhile, or got a message of its own (a Stop ended the wait, then a Send),
// the error is ErrNotFound, ErrArchived or ErrLocked. c's status is afterwards what it was, unless
// something else set it meanwhile; after an error the caller emits it.
func (m *Manager) remakeable(c *Chat, out *outbox) error {
	tr, err := m.trOf(c, out)
	if err != nil {
		return err
	}
	fs := *c.meta.ForkSource
	if _, items := tr.Snapshot(); fs.Point != "" || sentPast(items, fs.Items) {
		return nil
	}
	was, _ := tr.Status()
	tr.SetStatus(model.StatusThinking)
	out.emitChat(c)
	c.mu.Unlock()
	m.send(*out)
	*out = nil
	kept := m.sourceKept(fs.Chat, fs.Items)
	c.mu.Lock()
	switch {
	case c.deleted:
		err = ErrNotFound
	case m.parentOf(c).Archived:
		err = ErrArchived
	case !c.meta.Fresh:
		err = ErrLocked
	case !kept:
		err = errForkGone
	}
	if st, _ := tr.Status(); st == model.StatusThinking && c.meta.Fresh && !c.deleted {
		tr.SetStatus(was)
	}
	return err
}

// detach takes c's process off c and closes it: what it still says is dropped (see pump). pi's
// and Claude's Close do not wait for the process. c.mu held.
func detach(c *Chat) {
	if c.ag == nil {
		return
	}
	c.gen++
	c.ag.Close()
	c.ag = nil
}

// restartCursor starts the process of the fresh Cursor fork c again, on the choice c.meta has.
// Cursor's fork is a copy of its source's store under a new session id, so the new fork is made
// first, of the place in its source c was made at, and c's own process and store are given up
// only when the new one is there and chat.json names its session: a start that fails (the source
// deleted, its point gone from the store) and a save that fails leave c as it was, with its
// process, its store and its session id, and the new process and store are given up instead. The
// old process is closed in the background, and its store discarded after it (see discardFork).
//
// c.mu is held on entry and on return, but not during the look at the source, which locks that
// chat, or the start: the starting process looks its token up, which locks every chat. Meanwhile
// c is busy (thinking), so a Send or a second change gets ErrBusy. When c was deleted or archived
// meanwhile, or got a message of its own (a Stop ended the wait, then a Send: ErrLocked), the new
// process and its store are given up instead. After an error c's status is what it was, unless
// it is that message's turn's by now; the caller emits it. On success c is saved.
func (m *Manager) restartCursor(c *Chat, out *outbox) error {
	tr, err := m.trOf(c, out)
	if err != nil {
		return err
	}
	fk, ok := m.Spawners[c.meta.Agent].(agent.Forker)
	if !ok {
		return errNoForker(c.meta.Agent)
	}
	opts := m.spawnOptions(c)
	opts.SessionID = "" // the new fork's comes from its start, as the first one's did
	chat, branch, at := c.meta.ForkedFrom, c.meta.ForkedBranch, c.meta.ForkedAt
	was, _ := tr.Status()
	tr.SetStatus(model.StatusThinking)
	out.emitChat(c)
	c.mu.Unlock()
	m.send(*out)
	*out = nil
	var ag agent.Agent
	var sid string
	from, err := m.originOf(chat, branch, at)
	if err == nil {
		from.Dir = m.chatDir(from.ChatID)
		ag, sid, err = fk.SpawnFork(opts, from)
	}
	c.mu.Lock()
	old, oldID := c.ag, c.meta.SessionID
	if err == nil {
		switch {
		case c.deleted:
			err = ErrNotFound
		case m.parentOf(c).Archived:
			err = ErrArchived
		case !c.meta.Fresh:
			err = ErrLocked
		}
		if err == nil {
			// On disk before the old store is given up: after a failed save chat.json still
			// names the old session, which a restart of the app resumes.
			c.meta.SessionID = sid
			if err = m.save(c); err != nil {
				c.meta.SessionID = oldID
			}
		}
		if err != nil {
			discardFork(fk, ag, sid)
		}
	}
	if err != nil {
		if st, _ := tr.Status(); st == model.StatusThinking && c.meta.Fresh && !c.deleted {
			tr.SetStatus(was)
		}
		return err
	}
	m.attach(c, ag)
	if oldID == sid {
		oldID = "" // never the store the new process runs on
	}
	discardFork(fk, old, oldID)
	return nil
}

// originOf is the session a fork holding the first at items of the branch branch of the chat id
// is made from as that branch is now (see forkSourceOf): errOriginGone when the chat or the
// branch is gone, and when there is nothing to make the fork of any more, which is a place no id
// names in a session that has gone on, or is going on, past it. No chat's mu may be held: only
// the source's is taken.
func (m *Manager) originOf(id, branch string, at int) (agent.ForkSource, error) {
	var loaded outbox // what loading the source's transcript sends
	src, err := m.branchChat(id, branch)
	if err != nil {
		return agent.ForkSource{}, errOriginGone
	}
	var from agent.ForkSource
	tr, err := m.trOf(src, &loaded)
	if err == nil {
		if _, items := tr.Snapshot(); at > 0 && at <= len(items) {
			from = forkSourceOf(src.meta, items, at, busy(src))
		}
	}
	src.mu.Unlock()
	m.send(loaded)
	if err != nil {
		return agent.ForkSource{}, err
	}
	if from.Point == "" && !from.End {
		return agent.ForkSource{}, errOriginGone
	}
	return from, nil
}

// discardFork gives up a fork start's process and what the start created outside the app's
// folder, in the background: ag is closed (nil: there is none), waited for no longer than
// closeWait since Cursor's Close can block, and then the store of the session sid is discarded
// ("": none), as dropUnlisted does for a fork that is given up.
func discardFork(fk agent.Forker, ag agent.Agent, sid string) {
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
		if sid != "" {
			fk.DiscardFork(sid)
		}
	}()
}
