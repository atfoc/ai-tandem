package chats

import (
	"errors"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// keepsContextSplit reports whether an agent's between-turns split is persisted in chat.json
// (Claude and pi); Cursor's is read live on every call and never stored.
func keepsContextSplit(a model.AgentKind) bool {
	return a == model.Claude || a == model.Pi
}

// splitRun is a context split being taken; calls that come meanwhile wait for it.
type splitRun struct {
	done  chan struct{}
	split model.ContextSplit
	err   error
}

// ContextSplit returns what fills the chat's context window, by category.
//
// Claude's and pi's are kept in chat.json with the messages sent and turns ended when it was
// taken, and are returned from there while neither has moved and no turn runs. Otherwise, or with
// fresh, it is asked for: the chat's process answers when it runs (pi is live-only); without one,
// a process is started on a fork of the session just to answer and closed. Only a split taken
// between turns is kept.
//
// Cursor's is read from its session store on every call, as it costs no process; it is never
// persisted.
//
// It is the split of the chat's current branch.
func (m *Manager) ContextSplit(id string, fresh bool) (model.ContextSplit, error) {
	var out outbox
	c, err := m.lockCur(id)
	if err != nil {
		return model.ContextSplit{}, err
	}
	tr, err := m.trOf(c, &out)
	if err != nil {
		c.mu.Unlock()
		m.send(out)
		return model.ContextSplit{}, err
	}
	if !c.meta.Locked || c.meta.SessionID == "" {
		c.mu.Unlock()
		m.send(out)
		return model.ContextSplit{}, ErrNotStarted
	}
	sent, turns, wasBusy := tr.Sent(), c.meta.Usage.Turns, busy(c)
	if s := c.meta.ContextSplit; s != nil && keepsContextSplit(c.meta.Agent) && !fresh && !wasBusy &&
		s.AtMessage == sent && s.AtTurn == turns {
		split := *s
		c.mu.Unlock()
		m.send(out)
		return split, nil
	}
	if r := c.splitRun; r != nil {
		c.mu.Unlock()
		m.send(out)
		<-r.done
		return r.split, r.err
	}
	r := &splitRun{done: make(chan struct{})}
	c.splitRun = r
	ag, opts, kind := c.ag, m.spawnOptions(c), c.meta.Agent
	c.mu.Unlock()
	m.send(out)

	// Unlocked: a one-off Claude process connects to the board's MCP, which looks the chat up.
	var split model.ContextSplit
	if live, ok := ag.(agent.ContextSplitter); ok {
		split, err = live.ContextSplit()
	} else if rd, ok := m.Spawners[kind].(agent.SplitReader); ok {
		split, err = rd.ReadContextSplit(opts)
	} else {
		err = errors.New("this agent does not report its context split")
	}

	c.mu.Lock()
	c.splitRun = nil
	if err == nil {
		split.AtMessage, split.AtTurn = sent, turns
		if keepsContextSplit(kind) && !c.deleted && !wasBusy && !busy(c) &&
			c.tr.Sent() == sent && c.meta.Usage.Turns == turns {
			saved := split
			c.meta.ContextSplit = &saved
			m.logSave(c)
		}
	}
	r.split, r.err = split, err
	c.mu.Unlock()
	close(r.done)
	return split, err
}
