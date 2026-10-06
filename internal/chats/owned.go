// The chats of a run. Every agent of a run (its orchestrator turns, its task and merge agents) is
// a chat object of this manager: hidden from the chat list, kept in runs/<run>/agents/<id>, and
// driven by the run's engine through the …Owned methods instead of by a person. The chats people
// open on a run are ordinary chats kept in runs/<run>/chats/<id>. The types are in ownedtypes.go.
//
// What a person can do to a chat is refused for a run agent's chat (person): the calls that
// change one answer ErrRunAgent, the calls that read one work.
package chats

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/transcript"
)

// ---- the folder resolver ---------------------------------------------------

// chatDir is the folder of the chat object with the server id id: a top-level chat's, a branch's
// (<id>/branches/<b>) or a subagent's (<id>/subagents/<sid>). The first segment names the
// top-level chat: one with a registered root lives there, any other in chats/<id>. It takes only
// rootsMu, so it can be called with any lock held.
func (m *Manager) chatDir(id string) string {
	top, rest, _ := strings.Cut(id, "/")
	m.rootsMu.Lock()
	root, ok := m.roots[top]
	m.rootsMu.Unlock()
	if !ok {
		return m.Store.P.ChatDir(id)
	}
	return filepath.Join(root, rest)
}

// setRoot registers where the top-level chat meta names lives, when that is under its run and
// not in chats/<id>. It must run before anything makes the chat's folder and before the chat
// object is in the map. A branch's id has no root of its own: it resolves through its chat's.
func (m *Manager) setRoot(meta model.ChatMeta) {
	if meta.Run == "" || strings.Contains(meta.ID, "/") {
		return
	}
	m.rootsMu.Lock()
	m.roots[meta.ID] = m.Store.P.RunChatDir(meta.Run, meta.Role != "", meta.ID)
	m.rootsMu.Unlock()
}

// dropRoot forgets a top-level chat's root, once its folder is gone.
func (m *Manager) dropRoot(id string) {
	m.rootsMu.Lock()
	delete(m.roots, id)
	m.rootsMu.Unlock()
}

// safeSegment reports whether s can be one folder name: an id of a run or of a run agent's chat.
func safeSegment(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.ContainsAny(s, `/\`)
}

// loadRunChats is Load for the chats kept under the runs: runs/<run>/chats/<id> (the ones people
// talk to) and runs/<run>/agents/<id> (the run's agents). A folder whose name, chat.json id, run
// and role do not agree with where it is, is logged and skipped. m.mu held.
func (m *Manager) loadRunChats() {
	runs, err := os.ReadDir(m.Store.P.Runs)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Printf("chats: runs: %v", err)
		}
		return
	}
	for _, r := range runs {
		if !r.IsDir() {
			continue
		}
		for _, agents := range []bool{false, true} {
			dir := filepath.Dir(m.Store.P.RunChatDir(r.Name(), agents, "x"))
			ents, err := os.ReadDir(dir)
			if err != nil {
				continue // a run without chats of this kind
			}
			for _, e := range ents {
				if !e.IsDir() {
					continue
				}
				var meta model.ChatMeta
				raw, err := os.ReadFile(filepath.Join(dir, e.Name(), "chat.json"))
				if err == nil {
					err = json.Unmarshal(raw, &meta)
				}
				if err == nil && (meta.ID != e.Name() || meta.Run != r.Name() || (meta.Role != "") != agents) {
					err = fmt.Errorf("its chat.json says id %q, run %q, role %q", meta.ID, meta.Run, meta.Role)
				}
				if err == nil && m.chats[meta.ID] != nil {
					err = errors.New("a chat with its id is already loaded")
				}
				if err != nil {
					log.Printf("chats: skipping %s: %v", filepath.Join(dir, e.Name()), err)
					continue
				}
				m.setRoot(meta) // before loadBranches reads the tree record
				c := &Chat{meta: meta, interrupted: meta.TurnActive, role: meta.Role}
				countInterrupted(c)
				m.chats[meta.ID] = c
				m.registerChatToken(meta.Token)
				m.loadBranches(c, meta.ID)
			}
		}
	}
}

// ---- what the manager asks about a run --------------------------------------

// runOf is RunOwner.RunOf for a manager that may have no runs. It may be called with a chat's
// lock held, never with m.mu.
func (m *Manager) runOf(run string) (RunInfo, bool) {
	if m.Runs == nil {
		return RunInfo{}, false
	}
	return m.Runs.RunOf(run)
}

// openRun returns the run a chat is made on or sent a message on: ErrNoRun when there is none,
// ErrRunArchived for an archived one.
func (m *Manager) openRun(run string) (RunInfo, error) {
	ri, ok := m.runOf(run)
	if !ok {
		return RunInfo{}, ErrNoRun
	}
	if ri.Archived {
		return RunInfo{}, ErrRunArchived
	}
	return ri, nil
}

// runContext is the block every message of a person's chat on a run starts with; "" for any other
// chat object. c.mu held.
func (m *Manager) runContext(c *Chat) string {
	if c.meta.Run == "" || c.role != "" || m.Runs == nil {
		return ""
	}
	return m.Runs.ChatContext(c.meta.Run)
}

// toolNames are the bare names of ts, with more appended.
func toolNames(ts []boardtools.Tool, more ...boardtools.Tool) []string {
	names := make([]string, 0, len(ts)+len(more))
	for _, t := range append(ts[:len(ts):len(ts)], more...) {
		names = append(names, t.Name)
	}
	return names
}

// runOptions sets what the process of a run's chat object c starts with, on top of what every
// chat's does; sub says the process is an app-spawned subagent of c. Which tools a process may
// call is decided by the MCP endpoint, per token; MCPTools only says which of them need no asking.
// c.mu held.
//
//	                          Unattended  ReadOnly  MCPTools                        NeedHistory
//	orchestrator              yes         yes       the orchestrator's run tools    with Resume
//	task, merge               yes         no        the spawn family                with Resume
//	  their subagents         yes         no        none
//	a person's chat on a run  no          no        its run tools, the spawn family no
//	  its subagents           no          no        none
//	any other chat            no          no        nil: derived by the adapter     no
func runOptions(c *Chat, o *agent.SpawnOptions, sub bool) {
	if c.meta.Run == "" {
		return
	}
	o.Unattended = c.role != ""
	switch {
	case sub:
		o.MCPTools = []string{}
	case c.role == model.RoleOrchestrator:
		o.ReadOnly = true
		o.MCPTools = toolNames(boardtools.OrchestratorTools())
		o.NeedHistory = o.Resume
	case c.role != "":
		o.MCPTools = toolNames(boardtools.SpawnFamily)
		o.NeedHistory = o.Resume
	default:
		o.MCPTools = toolNames(boardtools.RunChatTools(), boardtools.SpawnFamily...)
	}
}

// ---- the guard ---------------------------------------------------------------

// person is the first statement of every call a person can make to change a chat: ErrRunAgent
// for a run agent's chat, which only its run changes. An id that names no chat passes: the call
// says so itself.
func (m *Manager) person(id string) error {
	if c, err := m.get(id); err == nil && c.role != "" {
		return ErrRunAgent
	}
	return nil
}

// owned returns the chat object of the run agent's chat id, not locked: ErrNotFound for an
// unknown id and for a chat that is not a run agent's.
func (m *Manager) owned(id string) (*Chat, error) {
	c, err := m.get(id)
	if err != nil {
		return nil, err
	}
	if c.role == "" {
		return nil, ErrNotFound
	}
	return c, nil
}

// denyAtOnce answers asker's permission request requestID "no" and records it on its card. A
// run's agents and their subagents start unattended, so their adapters raise no request; one that
// comes all the same must not leave the chat waiting for an answer nobody gives. The asker's
// process is told directly (Manager.Decide takes the chat's lock). c.mu held; the caller writes
// the thread.
func denyAtOnce(c *Chat, asker, requestID string) []transcript.Update {
	if ag := permAgent(c, asker); ag != nil {
		_ = ag.Decide(requestID, false)
	}
	return c.tr.Decided(asker, requestID, false)
}

// ---- chats people open on a run ---------------------------------------------

// CreateOnRun makes a person's chat on a run: no group, no board, no role; its folder is the
// run's, its model and effort those of the run's deep tier when a is the run's agent
// kind, else the new-chat defaults of the run's group. The run must exist
// (ErrNoRun) and not be archived (ErrRunArchived). The chat lives in runs/<run>/chats/<id> and is
// listed like any chat, with Run set. No agent starts.
func (m *Manager) CreateOnRun(a model.AgentKind, run string) (model.ChatView, error) {
	none := model.ChatView{}
	if a != model.Claude && a != model.Cursor && a != model.Pi {
		return none, fmt.Errorf("unknown agent %q", a)
	}
	if !safeSegment(run) {
		return none, ErrNoRun
	}
	ri, err := m.openRun(run)
	if err != nil {
		return none, err
	}
	var d model.Defaults
	m.Store.Read(func(s *model.State) { d = s.Defaults })
	cwd, mc := defaults.Resolve(d, ri.Group, a, m.DefaultCwd, m.catalog(a))
	if ri.Cwd != "" {
		cwd = ri.Cwd
	}
	// A chat of the run's agent kind starts on what the orchestrator runs on: its changes of the
	// plan are decisions that nothing checks, as the orchestrator's are.
	if a == ri.Agent && ri.Model != "" {
		mc = model.ModelChoice{Model: ri.Model, Effort: ri.Effort}
	}
	meta := model.ChatMeta{ID: uuid(), Agent: a, Run: run, Cwd: cwd, Model: mc.Model, Effort: mc.Effort, Created: time.Now()}
	c, err := m.addRunChat(meta)
	if err != nil {
		return none, err
	}
	var out outbox
	c.mu.Lock()
	out.emitChat(c)
	v := view(c)
	c.mu.Unlock()
	m.send(out)
	return v, nil
}

// addRunChat makes the chat object of a new chat of a run, as Create makes one in chats/: its
// token and session id, its folder under the run, an empty thread, chat.json, the map entry.
func (m *Manager) addRunChat(meta model.ChatMeta) (*Chat, error) {
	m.extrasMu.Lock()
	meta.Token = m.uniqueTokenLocked()
	m.extrasMu.Unlock()
	if meta.Agent == model.Claude || meta.Agent == model.Pi {
		meta.SessionID = uuid() // the app assigns it; pi starts/resumes with it
	}
	m.setRoot(meta) // before the folder is made
	fail := func(err error) (*Chat, error) {
		dir := m.chatDir(meta.ID)
		os.RemoveAll(dir)
		os.Remove(filepath.Dir(dir))
		m.dropRoot(meta.ID)
		m.unregisterChatToken(meta.Token)
		return nil, err
	}
	if err := os.MkdirAll(m.chatDir(meta.ID), 0o700); err != nil {
		return fail(err)
	}
	c := &Chat{meta: meta, role: meta.Role, subs: map[string]*sub{}, subByTool: map[string]string{}}
	tr, err := transcript.Load(m.itemsPath(meta.ID)) // no file yet: empty
	if err != nil {
		return fail(err)
	}
	c.tr = tr
	if err := m.save(c); err != nil {
		return fail(err)
	}
	m.mu.Lock()
	m.chats[meta.ID] = c
	m.mu.Unlock()
	return c, nil
}

// ChatsOfRun lists the top-level chats of a run, oldest first: the ones people talk to, and its
// agents. The metas hold the chats' MCP tokens: they are for server code and must never be
// serialised to a client.
func (m *Manager) ChatsOfRun(run string) (people, agents []model.ChatMeta) {
	if run == "" {
		return nil, nil
	}
	for _, c := range m.all() {
		if c.top != nil {
			continue
		}
		c.mu.Lock()
		meta, hidden := c.meta, c.unlisted || c.deleted
		c.mu.Unlock()
		switch {
		case meta.Run != run || hidden:
		case meta.Role != "":
			agents = append(agents, meta)
		default:
			people = append(people, meta)
		}
	}
	for _, l := range [][]model.ChatMeta{people, agents} {
		sort.Slice(l, func(i, j int) bool {
			if !l[i].Created.Equal(l[j].Created) {
				return l[i].Created.Before(l[j].Created)
			}
			return l[i].ID < l[j].ID
		})
	}
	return people, agents
}

// ---- a run's agents ----------------------------------------------------------

// CreateOwned makes the chat object of a run agent in runs/<run>/agents/<id>, or finds it: a chat
// with this id, run and role is left as it is (created false); the same id with another run or
// role is an error. Nothing of a person's chat happens to it: no group, no namer, no sticky
// defaults, not in Views, no event. The model and effort are taken as given. The run must exist
// (ErrNoRun) and not be archived (ErrRunArchived). No process starts.
func (m *Manager) CreateOwned(s OwnedSpec) (created bool, err error) {
	if !safeSegment(s.ID) || !safeSegment(s.Run) {
		return false, fmt.Errorf("bad id %q or run %q", s.ID, s.Run)
	}
	switch s.Role {
	case model.RoleOrchestrator, model.RoleTask, model.RoleMerge:
	default:
		return false, fmt.Errorf("unknown role %q", s.Role)
	}
	if s.Agent != model.Claude && s.Agent != model.Cursor && s.Agent != model.Pi {
		return false, fmt.Errorf("unknown agent %q", s.Agent)
	}
	if _, err := m.openRun(s.Run); err != nil {
		return false, err
	}
	m.ownedMu.Lock()
	defer m.ownedMu.Unlock()
	if c, err := m.get(s.ID); err == nil {
		c.mu.Lock()
		run, role, gone := c.meta.Run, c.meta.Role, c.deleted
		c.mu.Unlock()
		if run != s.Run || role != s.Role || gone {
			return false, fmt.Errorf("the chat %s is already there, with run %q and role %q", s.ID, run, role)
		}
		return false, nil
	}
	cwd, err := expandDir(s.Cwd)
	if err != nil {
		return false, err
	}
	if m.Store.P.Contains(cwd) {
		return false, ErrAppFolder
	}
	meta := model.ChatMeta{ID: s.ID, Agent: s.Agent, Run: s.Run, Role: s.Role, Name: s.Name, UserNamed: s.Name != "",
		Cwd: cwd, Model: s.Model, Effort: s.Effort, Created: time.Now()}
	if _, err := m.addRunChat(meta); err != nil {
		return false, err
	}
	return true, nil
}

// SendOwned sends one message of the engine to a run agent's chat and returns when the adapter
// has taken it. It starts the process when there is none: a resume when the chat has had a
// message (with NeedHistory), else a new session. ErrBusy while a turn runs. An error for which
// errors.Is(err, agent.ErrNoSession) holds means the session to resume does not exist.
// ErrShutdown once Shutdown has begun: no process is started, then or later.
//
// On any error other than ErrBusy the chat is left not busy and without a process: when the
// adapter refuses the message (its Send returns an error), the process is ended before the error
// is returned. So the engine never calls WaitOwned after an error other than ErrBusy.
//
// The adapter's Send can wait (Cursor's for its handshake, with no limit). The chat's lock is not
// held meanwhile: StopOwned ends the process, and this call then returns the adapter's error.
func (m *Manager) SendOwned(id, text string, o OwnedSend) error {
	c, err := m.owned(id)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if c.deleted {
		c.mu.Unlock()
		return ErrNotFound
	}
	if m.down.Load() {
		// Ahead of ErrBusy: the process Shutdown is closing may still have its turn. sendOn looks
		// again, in the hold of the lock that would start the process.
		c.mu.Unlock()
		return ErrShutdown
	}
	if busy(c) {
		c.mu.Unlock()
		return ErrBusy
	}
	if o.Fresh {
		c.mu.Unlock()
		m.stopOne(c) // the process of the session that is left, if it still has one
		c.mu.Lock()
		if c.deleted {
			c.mu.Unlock()
			return ErrNotFound
		}
		if m.down.Load() {
			c.mu.Unlock()
			return ErrShutdown // before the session is given up: a refused message changes nothing
		}
		// Resume comes from Locked: the next start is of a new session.
		c.meta.Locked, c.meta.ForkSource, c.meta.ContextSplit = false, nil, nil
		c.meta.SessionID = ""
		if c.meta.Agent == model.Claude || c.meta.Agent == model.Pi {
			c.meta.SessionID = uuid()
		}
		if k := costOf(c); k != nil {
			costFresh(k)
		}
		m.logSave(c)
	}
	_, err = m.sendOn(c, text, "", nil) // releases c.mu
	if err == nil || errors.Is(err, ErrBusy) {
		return err
	}
	c.mu.Lock()
	left := !c.deleted && (c.ag != nil || busy(c))
	c.mu.Unlock()
	if left {
		m.stopOne(c) // the adapter refused the message: no turn follows, and the chat must not stay busy
	}
	return err
}

// ownedWait is what has happened to a run agent's chat since the last SendOwned. c.mu guards it.
// Its methods do nothing on a nil receiver: a chat nobody waits on records nothing.
type ownedWait struct {
	from      int    // the thread's length before the message
	end       string // how the last turn since the message ended; "" = none has
	err       string
	noSession bool
	turns     int
}

// turnEnded records a turn end of the chat's own agent (the pump).
func (w *ownedWait) turnEnded(ev agent.Event) {
	if w == nil {
		return
	}
	w.turns++
	switch {
	case ev.Aborted:
		w.end, w.err = EndAborted, ""
	case ev.Error != "":
		w.end, w.err = EndError, ev.Error
	default:
		w.end, w.err = EndClean, ""
	}
	w.noSession = w.noSession || ev.NoSession
}

// exited records the end of the chat's process (the pump). inWork says it cut something off: a
// turn, or the wait for app-spawned subagents, which end with it. A process that ends while the
// chat rests after a turn changes nothing of how that turn ended (Claude's exit after it reported
// "no session", an idle process that goes away); when no turn has ended since the message, the
// exit is all that will come. The exit of a process the manager closed itself never gets here:
// the pump drops it.
func (w *ownedWait) exited(text string, inWork bool) {
	if w == nil || (!inWork && w.end != "") {
		return
	}
	w.end, w.err = EndExit, text
}

// stopped records that the chat was stopped (stopOne): whatever ran ended there.
func (w *ownedWait) stopped() {
	if w != nil {
		w.end, w.err = EndAborted, "stopped"
	}
}

// refused records a turn the app started (a delivery of subagent results) that the adapter did
// not accept, so no turn end follows it.
func (w *ownedWait) refused(text string) {
	if w != nil {
		w.turns++
		w.end, w.err = EndError, text
	}
}

// wakeOwned makes a WaitOwned on c look again. c.mu held.
func wakeOwned(c *Chat) {
	if c.wake != nil {
		close(c.wake)
		c.wake = nil
	}
}

// idleNow reports whether nothing more is coming on c by itself: it is not busy, none of its
// app-spawned subagents runs, and no result is owed that the app would still deliver (deliver has
// run, in the hold of c.mu that made it possible, whenever it could: a result still owed waits
// for the next message, because the chat is held or has no process). c.mu held.
func idleNow(c *Chat) bool {
	if busy(c) {
		return false
	}
	n := countSubs(c)
	return n.running == 0 && !(n.owed > 0 && deliverable(c))
}

// settledNow reports whether c is settled after the last SendOwned: a turn has ended since, and
// nothing more is coming. c.mu held.
func settledNow(c *Chat) bool {
	return c.wait != nil && c.wait.end != "" && c.tr != nil && !c.deleted && idleNow(c)
}

// waitBackstop is how often a WaitOwned looks at the chat when nothing woke it: a path that
// changes the chat without waking its waiter costs this long, never a hang.
const waitBackstop = 200 * time.Millisecond

// WaitOwned blocks until the chat is settled: a turn has ended since the last SendOwned, the chat
// is not busy, no app-spawned subagent of it runs, and no result is owed that the app would still
// deliver by itself. The answer is computed from the chat as it is at that moment, so a chat that
// became busy again (a turn the agent started itself, a delivery) is not settled until that turn
// has ended too, and asking again later can give another answer. ErrNothingSent when no SendOwned
// came since the server started, ErrSuperseded when another came while this call waited,
// ErrNotFound for a chat that is deleted or not a run agent's, or ctx's error.
func (m *Manager) WaitOwned(ctx context.Context, id string) (Settled, error) {
	c, err := m.owned(id)
	if err != nil {
		return Settled{}, err
	}
	tick := time.NewTicker(waitBackstop)
	defer tick.Stop()
	var first *ownedWait
	for {
		c.mu.Lock()
		w := c.wait
		switch {
		case c.deleted || c.removing:
			c.mu.Unlock()
			return Settled{}, ErrNotFound
		case w == nil:
			c.mu.Unlock()
			return Settled{}, ErrNothingSent
		case first != nil && w != first:
			c.mu.Unlock()
			return Settled{}, ErrSuperseded
		}
		first = w
		if settledNow(c) {
			s := Settled{Outcome: w.end, Error: w.err, NoSession: w.noSession, Text: c.tr.LastTextSince(w.from),
				From: w.from, To: c.tr.Len(), Turns: w.turns, Owed: countSubs(c).owed}
			c.mu.Unlock()
			return s, nil
		}
		if c.wake == nil {
			c.wake = make(chan struct{})
		}
		wake := c.wake
		c.mu.Unlock()
		select {
		case <-wake:
		case <-tick.C:
		case <-ctx.Done():
			return Settled{}, ctx.Err()
		}
	}
}

// StopOwned ends a run agent's process: it interrupts a running turn and waits up to grace for
// the turn to end (so its cost is reported and Claude ends its background commands), then closes
// the process, stops its subagents and revokes their tokens. The chat and its thread stay. With
// no grace it closes at once. It works while a SendOwned of the chat is inside the adapter, which
// then returns an error, and it never waits for an adapter's Close.
func (m *Manager) StopOwned(id string, grace time.Duration) {
	c, err := m.owned(id)
	if err != nil {
		return
	}
	running := func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return !c.deleted && turnRunning(c)
	}
	if grace > 0 && running() {
		if err := m.interrupt(id, ""); err != nil {
			log.Printf("chats: interrupt %s: %v", id, err)
		}
		for end := time.Now().Add(grace); running() && time.Now().Before(end); {
			time.Sleep(10 * time.Millisecond)
		}
	}
	m.stopOne(c)
}

// DeleteOwned stops and removes a run agent's chat and its folder. No event is sent.
func (m *Manager) DeleteOwned(id string) error {
	if _, err := m.owned(id); err != nil {
		return err
	}
	return m.remove(id, false)
}

// OwnedState is what a restarted engine can read of a run agent's chat without starting or
// changing anything: a thread that is not in memory is read from its file and not kept. A chat
// that does not exist, or is not a run agent's, has Exists false and no error.
func (m *Manager) OwnedState(id string) (OwnedState, error) {
	c, err := m.owned(id)
	if err != nil {
		return OwnedState{}, nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.deleted {
		return OwnedState{}, nil
	}
	st := OwnedState{Exists: true, Locked: c.meta.Locked, WasActive: turnRunning(c) || c.interrupted, HasProcess: c.ag != nil}
	tr, err := m.threadOf(c)
	if err != nil {
		return st, err
	}
	_, items := tr.Snapshot()
	for i := len(items) - 1; i >= 0 && items[i].Kind != "user"; i-- {
		if items[i].Kind == "text" {
			st.Text = items[i].Text
			break
		}
	}
	return st, nil
}

// threadOf is c's thread for a caller that only reads it: the one in memory, else items.jsonl
// read for this call alone, as Tree reads a branch. Nothing is loaded into the manager, so none
// of what a chat's first load does happens (see trOf). c.mu held.
func (m *Manager) threadOf(c *Chat) (*transcript.Transcript, error) {
	if c.tr != nil {
		return c.tr, nil
	}
	return transcript.Load(m.itemsPath(c.meta.ID))
}

// CostOf is what the agent of the top-level chat id and its subagents have cost so far, over all
// its branches. The cost is kept for the chats of a run; any other chat has none (Known false).
// It starts nothing and changes nothing.
func (m *Manager) CostOf(id string) (Cost, error) {
	top, err := m.topChat(id)
	if err != nil {
		return Cost{}, err
	}
	var sum Cost
	for _, c := range m.branchesOf(top) {
		c.mu.Lock()
		k := costTotal(c.meta.Cost)
		c.mu.Unlock()
		sum.USD += k.USD
		sum.Known = sum.Known || k.Known
		sum.Partial = sum.Partial || k.Partial
		sum.Tokens = tokAdd(sum.Tokens, k.Tokens)
		sum.TokensKnown = sum.TokensKnown || k.TokensKnown
		sum.Peak = max(sum.Peak, k.Peak)
	}
	return sum, nil
}

// Activity is the live state of the thread of the chat id (its current branch), for the run view.
// It starts nothing and changes nothing.
func (m *Manager) Activity(id string) (Activity, error) {
	c, err := m.lockCur(id)
	if err != nil {
		return Activity{}, err
	}
	defer c.mu.Unlock()
	tr, err := m.threadOf(c)
	if err != nil {
		return Activity{}, err
	}
	n, last := tr.LastTool()
	return Activity{Tools: n, Last: last}, nil
}

// Idle reports whether the chat (its current branch) is settled now: not busy, no running
// subagent, nothing the app would still deliver. A chat that does not exist is idle.
func (m *Manager) Idle(id string) bool {
	c, err := m.lockCur(id)
	if err != nil {
		return true
	}
	defer c.mu.Unlock()
	return idleNow(c)
}

// TurnRunning reports whether the chat (its current branch) has a process and a turn of it is
// running.
func (m *Manager) TurnRunning(id string) bool {
	c, err := m.lockCur(id)
	if err != nil {
		return false
	}
	defer c.mu.Unlock()
	return turnRunning(c)
}

// ---- watching a run's agent ---------------------------------------------------

// Watch makes the manager send the chat, chat_items, sub and sub_items events of a run agent's
// chat to the client, from now on: call it before reading the thread (ItemsOf), or a change
// between the two is missed. It does nothing for any other chat, whose events are always sent.
func (m *Manager) Watch(id string) {
	if _, err := m.owned(id); err != nil {
		return
	}
	m.watchMu.Lock()
	m.watched[id] = true
	m.watchMu.Unlock()
}

// ClearWatches forgets every watch: a new snapshot was built, and its client watches nothing yet.
// It is called with the bridge's lock held and takes only the watch lock.
func (m *Manager) ClearWatches() {
	m.watchMu.Lock()
	clear(m.watched)
	m.watchMu.Unlock()
}

func (m *Manager) watching(id string) bool {
	m.watchMu.Lock()
	defer m.watchMu.Unlock()
	return m.watched[id]
}

func (m *Manager) unwatch(id string) {
	m.watchMu.Lock()
	delete(m.watched, id)
	m.watchMu.Unlock()
}

// ---- closing a run's processes -------------------------------------------------

// ownedCloseWait is how long Shutdown waits for the adapters to close the processes of the runs'
// agents.
const ownedCloseWait = 2 * time.Second

// closeAndWait interrupts and closes ags, each on a goroutine of its own, and waits for the
// closes to return, no longer than wait.
func closeAndWait(ags []agent.Agent, wait time.Duration) {
	if len(ags) == 0 {
		return
	}
	done := make(chan struct{}, len(ags))
	for _, ag := range ags {
		go func(ag agent.Agent) {
			_ = ag.Interrupt()
			ag.Close()
			done <- struct{}{}
		}(ag)
	}
	timeout := time.After(wait)
	for range ags {
		select {
		case <-done:
		case <-timeout:
			return
		}
	}
}
