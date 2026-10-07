// The creation call of an API client: one call that finds the chat with an id or makes it, gives
// it the values the call names and sends its first message. And what else a client mark needs of
// the manager: the locks per chat id, and the reads by mark.
package chats

import (
	"errors"
	"fmt"
	"strings"
	"sync"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// ErrStartValue is what a creation call answers when a value it needs is missing.
var ErrStartValue = errors.New("a creation call needs id, agent, cwd and text")

// StartReq is the creation call of an API client.
type StartReq struct {
	ID            string          // required: a lowercase version 4 UUID
	Client        string          // required: the caller's client id, the chat's mark
	Run           string          // "" = a plain chat in the group Place gives; else the chat sits on this run
	Agent         model.AgentKind // required
	Cwd           string          // required without Run; with Run the folder is the run's and Cwd is ignored
	Model, Effort string          // "" = the agent's default from its catalog
	Name          string
	UserNamed     bool
	Text          string // required, not blank: the first message
	// Place is asked once, only when the chat is made and Run is "": for the group the chat goes
	// in. It is called with the creation lock of the id held, so it must not wait for a delete of
	// a chat. nil = the ungrouped group.
	Place func() (group string, err error)
}

// StartResult is the chat's state after the call, with an error too.
type StartResult struct {
	Exists  bool           // a chat with this id and the caller's mark is there
	Started bool           // it is locked: a first message got as far as the agent
	Sent    bool           // this call put the message into the thread
	Tried   bool           // the call got as far as the send: its error is the send's
	Chat    model.ChatView // set when Exists
}

// Start is the creation call: it finds the caller's chat with the id req.ID or makes it, and
// sends it req.Text as its first message. It returns when the agent has taken the message.
//
//   - No chat has the id: the chat is made with the caller's mark and the values of req (see
//     CreateChat), in the group req.Place gives or on the run req.Run, and sent the message. A
//     creation that is refused leaves nothing, and asks for no group.
//   - The caller's chat, not started (a call before made it and its send failed before the agent
//     took the message): it is given the agent, folder, model, effort and name of req, as a new
//     chat would get them, and sent the message.
//   - The caller's chat, started: nothing is changed and nothing is sent; Sent is false.
//   - Any other chat with the id is ErrIDTaken: one without the caller's mark, a fork, a chat of
//     another run than req.Run (or of one, when req names none), a run agent's chat, and a chat
//     folder that holds no chat that is loaded. The id of a chat that was deleted is free.
//
// The whole call holds the creation lock of the id: a repeat that arrives meanwhile waits, and
// then finds the chat as this call left it. So of many calls with one id one sends.
//
// ErrBadID and ErrStartValue are answered before anything is looked at, with the zero result. A
// folder that is no directory is agent.ErrFolderMissing to errors.Is, one inside the app's own is
// ErrAppFolder. With every other outcome but ErrIDTaken the result says what there is after the
// call: Exists and Chat when the caller's chat is there, Started when it has had its first
// message. Tried says the error is the send's: with Sent false the chat is left unstarted, with
// Sent true the agent itself refused the message, which stays in the thread as a turn that
// failed, and the chat is started.
func (m *Manager) Start(req StartReq) (res StartResult, err error) {
	if !chatID.MatchString(req.ID) {
		return res, ErrBadID
	}
	if req.Client == "" || req.Agent == "" || strings.TrimSpace(req.Text) == "" ||
		req.Run == "" && strings.TrimSpace(req.Cwd) == "" {
		return res, ErrStartValue
	}
	defer m.ids.lock(req.ID)()
	defer func() {
		if errors.Is(err, ErrIDTaken) {
			return // the chat there is not the caller's to be told of
		}
		if v, started, ok := m.startedOf(req.ID, req.Client); ok {
			res.Exists, res.Started, res.Chat = true, started, v
		}
	}()

	cwd := ""
	if req.Run == "" {
		if cwd, err = expandDir(req.Cwd); err != nil {
			return res, fmt.Errorf("%w: %v", agent.ErrFolderMissing, err)
		}
		if m.Store.P.Contains(cwd) {
			return res, ErrAppFolder
		}
	}

	c, err := m.get(req.ID)
	if err != nil {
		n := NewChat{ID: req.ID, Client: req.Client, Run: req.Run, Agent: req.Agent, Group: model.Ungrouped,
			Cwd: cwd, Model: req.Model, Effort: req.Effort, Name: req.Name, UserNamed: req.UserNamed}
		if _, err := m.create(n, req.Place); err != nil {
			return res, err
		}
	} else {
		c.mu.Lock()
		meta, hidden, leaving := c.meta, c.unlisted || c.deleted, c.removing
		c.mu.Unlock()
		switch {
		case hidden || c.top != nil || c.role != "" || meta.Client != req.Client || meta.ForkedFrom != "" || meta.Run != req.Run:
			return res, ErrIDTaken
		case leaving:
			return res, ErrNotFound // a delete of the chat is under way
		case meta.Locked:
			return res, nil
		}
		if err := m.restart(req, cwd); err != nil {
			return res, err
		}
	}

	c, err = m.lockCur(req.ID)
	if err != nil {
		return res, err
	}
	// In the hold of c.mu that starts the process: a delete that has begun either stopped the chat
	// before this hold, and is seen here, or stops it after, and so ends the agent's wait below.
	// Its remove waits for the lock this call holds.
	if leavingNow(c) {
		c.mu.Unlock()
		return res, ErrNotFound
	}
	res.Tried = true
	res.Sent, err = m.sendOn(c, req.Text, "", nil) // releases c.mu
	return res, err
}

// restart gives the caller's chat req.ID, which has not started, the values of req, as a new chat
// would get them (see create): the agent, the folder cwd (none on a run, whose folder stays the
// run's), the model and effort req names or else the default of the agent's catalog, and the
// name with its mark. The chat's event is sent for what changed.
func (m *Manager) restart(req StartReq, cwd string) error {
	a := req.Agent
	if a != model.Claude && a != model.Cursor && a != model.Pi {
		return fmt.Errorf("unknown agent %q", a)
	}
	var ri *RunInfo
	if req.Run != "" {
		r, err := m.openRun(req.Run)
		if err != nil {
			return err
		}
		ri = &r
	}
	_, mc := m.startChoice("", a, ri, true)
	mc, _, err := m.choose(a, mc, req.Model, req.Effort)
	if err != nil {
		return err
	}
	if err := m.ConfigureOf(req.ID, "", ConfigReq{Agent: a, Model: mc.Model, Effort: mc.Effort, Cwd: cwd}); err != nil {
		return err
	}
	var out outbox
	c, err := m.lockTop(req.ID)
	if err != nil {
		return err
	}
	name := strings.TrimSpace(req.Name)
	// ConfigureOf keeps a model or an effort that is not named. Here none is none, as for a new
	// chat: with a catalog that is not known yet the choice may hold neither.
	choice := !c.meta.Locked && (c.meta.Model != mc.Model || c.meta.Effort != mc.Effort)
	if c.meta.Name != name || c.meta.UserNamed != req.UserNamed || choice {
		c.meta.Name, c.meta.UserNamed = name, req.UserNamed
		if choice {
			c.meta.Model, c.meta.Effort = mc.Model, mc.Effort
		}
		err = m.save(c)
		out.emitChat(c)
	}
	c.mu.Unlock()
	m.send(out)
	return err
}

// startedOf reads the chat id for the answer of a creation call: its view and whether it has
// started, when it is there, is a chat people have and has the mark client. A chat that is being
// deleted is not there.
func (m *Manager) startedOf(id, client string) (v model.ChatView, started, ok bool) {
	c, err := m.lockTop(id)
	if err != nil {
		return v, false, false
	}
	own, mark, started, leaving := view(c), c.meta.Client, c.meta.Locked, c.removing
	c.mu.Unlock()
	if c.role != "" || mark != client || leaving {
		return v, false, false
	}
	return m.composed(c, own), started, true
}

// leavingNow reports whether the chat c is of is being deleted. c.mu held.
func leavingNow(c *Chat) bool {
	if c.top == nil {
		return c.removing
	}
	c.top.mu.Lock()
	defer c.top.mu.Unlock()
	return c.top.removing
}

// ---- the reads by mark ------------------------------------------------------

// ClientOf is the client mark of the top-level chat id: the client id of the API client that
// made it, or made the chat it was forked from; "" for a chat made on this server.
func (m *Manager) ClientOf(id string) (string, error) {
	c, err := m.lockTop(id)
	if err != nil {
		return "", err
	}
	defer c.mu.Unlock()
	return c.meta.Client, nil
}

// ViewsOf is Views of the chats whose client mark is client. It is never nil, and empty for "":
// the chats made on this server are no client's.
func (m *Manager) ViewsOf(client string) []model.ChatView {
	if client == "" {
		return []model.ChatView{}
	}
	return m.views(true, client)
}

// StatesOf is States of the chats whose client mark is client. It is never nil, and empty for "".
func (m *Manager) StatesOf(client string) []model.BranchState {
	if client == "" {
		return []model.BranchState{}
	}
	return m.states(true, client)
}

// ---- the creation locks -----------------------------------------------------

// idLocks are the creation locks: one mutex per chat id, which exists only while somebody holds
// it or waits for it. Ids come from whoever holds the secret, so no entry outlives its use. The
// zero value is ready.
type idLocks struct {
	mu sync.Mutex
	m  map[string]*idLock
}

// idLock is the lock of one id; n counts its holders and waiters, under idLocks.mu.
type idLock struct {
	sync.Mutex
	n int
}

// lock takes the lock of id, waiting for whoever holds it, and returns what releases it.
func (l *idLocks) lock(id string) (unlock func()) {
	l.mu.Lock()
	if l.m == nil {
		l.m = map[string]*idLock{}
	}
	k := l.m[id]
	if k == nil {
		k = &idLock{}
		l.m[id] = k
	}
	k.n++
	l.mu.Unlock()
	k.Lock()
	return func() {
		k.Unlock()
		l.mu.Lock()
		if k.n--; k.n == 0 {
			delete(l.m, id)
		}
		l.mu.Unlock()
	}
}

// held is how many ids have a lock that is held or waited for.
func (l *idLocks) held() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.m)
}
