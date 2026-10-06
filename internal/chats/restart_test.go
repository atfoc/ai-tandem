package chats

import (
	"bytes"
	"errors"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// ---- fixtures -------------------------------------------------------------

// callLog is what a restart asks of an adapter, in the order it asked.
type callLog struct {
	mu    sync.Mutex
	calls []string
}

func (l *callLog) add(call string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = append(l.calls, call)
}

// take returns the calls so far and forgets them.
func (l *callLog) take() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	got := l.calls
	l.calls = nil
	return got
}

func (l *callLog) len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.calls)
}

// forkSeq numbers the sessions loggedSpawner's fork starts make, across the spawners of a test: a
// fork made before a restart of the app and one made after it never share an id.
var forkSeq atomic.Int64

// loggedSpawner is a fakeSpawner that logs its calls and its agents' closes in one list: "spawn"
// and "fork" when a start is asked for, "close <session>" and "discard <session>".
type loggedSpawner struct {
	*fakeSpawner
	log callLog

	mu        sync.Mutex
	spawnErr  error         // non-nil: Spawn fails with it
	spawnGate chan struct{} // non-nil: Spawn waits for it to close
	spawning  chan struct{} // non-nil: closed when a Spawn is waiting
}

// tracedAgent logs its Close under the id of its session.
type tracedAgent struct {
	agent.Agent
	log *callLog
	sid string
}

func (a *tracedAgent) Close() {
	a.log.add("close " + a.sid)
	a.Agent.Close()
}

func (s *loggedSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	s.log.add("spawn")
	s.mu.Lock()
	err, gate, spawning := s.spawnErr, s.spawnGate, s.spawning
	s.spawning = nil
	s.mu.Unlock()
	if gate != nil {
		if spawning != nil {
			close(spawning)
		}
		<-gate
	}
	if err != nil {
		return nil, err
	}
	ag, err := s.fakeSpawner.Spawn(o)
	if err != nil {
		return nil, err
	}
	return &tracedAgent{ag, &s.log, o.SessionID}, nil
}

// SpawnFork gives a session the app chose no id for (Cursor) one of its own.
func (s *loggedSpawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	s.log.add("fork")
	ag, sid, err := s.fakeSpawner.SpawnFork(o, src)
	if err != nil {
		return nil, "", err
	}
	if o.SessionID == "" {
		sid = "store-" + strconv.FormatInt(forkSeq.Add(1), 10)
	}
	return &tracedAgent{ag, &s.log, sid}, sid, nil
}

func (s *loggedSpawner) DiscardFork(sid string) {
	s.log.add("discard " + sid)
	s.fakeSpawner.DiscardFork(sid)
}

// failSpawns makes every later Spawn fail with err (nil: start again).
func (s *loggedSpawner) failSpawns(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.spawnErr = err
}

// holdSpawn makes the next Spawn wait until release is called; waiting is closed once it does.
func (s *loggedSpawner) holdSpawn() (waiting <-chan struct{}, release func()) {
	gate, spawning := make(chan struct{}), make(chan struct{})
	s.mu.Lock()
	s.spawnGate, s.spawning = gate, spawning
	s.mu.Unlock()
	return spawning, sync.OnceFunc(func() {
		s.mu.Lock()
		s.spawnGate = nil
		s.mu.Unlock()
		close(gate)
	})
}

// logged puts a loggedSpawner in front of the fake spawner of kind, as it is now (a boot makes
// new fakes).
func (e *env) logged(kind model.AgentKind) *loggedSpawner {
	sp := &loggedSpawner{fakeSpawner: e.spawner(kind)}
	e.m.Spawners[kind] = sp
	return sp
}

// started is the process the adapter of kind started last: pi's restart is a spawn, the others'
// a fork start.
func (e *env) started(kind model.AgentKind) *fakeAgent {
	e.t.Helper()
	if kind == model.Pi {
		return e.pi.last(e.t)
	}
	return e.spawner(kind).lastFork(e.t)
}

// freshFork makes a chat of kind with two finished turns and a fork of it at the end of the first,
// which no message was sent on: its process is the one its start made. pi's source is piTalked's.
// sp is the logged spawner of kind, its log empty.
func (e *env) freshFork(kind model.AgentKind) (src, id string, sp *loggedSpawner) {
	e.t.Helper()
	sp = e.logged(kind)
	if kind == model.Pi {
		src, _ = e.piTalked()
	} else {
		src, _ = e.talked(kind, "", 2)
	}
	id = e.fork(src, 3).ID
	if m := e.meta(id); !m.Fresh || !m.Locked || m.SessionID == "" {
		e.t.Fatalf("the fork %+v", m)
	}
	sp.log.take()
	return src, id, sp
}

// another is a choice that differs from the one freshFork's fork of kind has, what it resolves
// to, and the context window the record then has.
func another(kind model.AgentKind) (req ConfigReq, want model.ModelChoice, window int) {
	switch kind {
	case model.Pi: // big, low: the window of a model that is not sized is not known
		return ConfigReq{Model: "unsized"}, model.ModelChoice{Model: "unsized"}, 0
	case model.Cursor: // composer-2, high: the other model has no efforts
		return ConfigReq{Model: "gpt-5.4-mini"}, model.ModelChoice{Model: "gpt-5.4-mini"}, 0
	}
	return ConfigReq{Model: "opus", Effort: "max"}, model.ModelChoice{Model: "opus", Effort: "max"}, 1_000_000
}

// idle fails unless the fork id holds no slot of the cap and no flag of a turn: a restart is no turn.
func (e *env) idle(when, id string) {
	e.t.Helper()
	c, err := e.m.get(id)
	if err != nil {
		e.t.Fatal(err)
	}
	if chat, _ := e.slots(id); chat != 0 || e.reserved() != 0 || c.noTurn.Load() || e.m.Busy(id) {
		e.t.Fatalf("%s: %d slots held, %d reservations, noTurn %v, busy %v", when, chat, e.reserved(), c.noTurn.Load(), e.m.Busy(id))
	}
	if m := e.meta(id); m.TurnActive {
		e.t.Fatalf("%s: a turn is recorded as active", when)
	}
}

var forkKinds = []model.AgentKind{model.Pi, model.Claude, model.Cursor}

// ---- the restart ----------------------------------------------------------

// A fork that has had no message takes another model and effort: its process is started again on
// them, in the order each agent needs.
func TestConfigureFreshFork(t *testing.T) {
	for _, kind := range forkKinds {
		t.Run(string(kind), func(t *testing.T) {
			e := newEnv(t)
			src, id, sp := e.freshFork(kind)
			was, defs := e.meta(id), e.defaultsOf()
			srcFile := e.file(src, "chat.json")
			first := e.started(kind)
			if kind == model.Pi {
				first = e.pi.lastFork(t) // a fork's first process is a fork start for every agent
			}
			forks, spawns, n := len(sp.forkCalls()), sp.count(), len(e.items(id))
			req, want, window := another(kind)

			evs := e.listen()
			if err := e.m.Configure(id, req); err != nil {
				t.Fatal(err)
			}
			got := evs.drain(t, e.br)

			// The adapter calls, in order.
			var calls []string
			opts := e.started(kind).opts
			switch kind {
			case model.Pi:
				// Closed, then an ordinary resume of the fork's own session.
				calls = []string{"close " + was.SessionID, "spawn"}
				if sp.count() != spawns+1 || len(sp.forkCalls()) != forks || opts.SessionID != was.SessionID || !opts.Resume {
					t.Fatalf("%d spawns (were %d), %d fork starts (were %d), options %+v", sp.count(), spawns, len(sp.forkCalls()), forks, opts)
				}
			case model.Claude:
				// Closed, then made again from its fork source under the same id.
				calls = []string{"close " + was.SessionID, "fork"}
				fc := sp.forkCalls()
				if len(fc) != forks+1 || sp.count() != spawns || opts.SessionID != was.SessionID || !opts.Resume || fc[forks].src != fc[forks-1].src {
					t.Fatalf("%d fork starts (were %d), %d spawns (were %d), the last %+v, the first %+v", len(fc), forks, sp.count(), spawns, fc[forks], fc[forks-1])
				}
			case model.Cursor:
				// A new fork of the same place first; then the old process and store go.
				waitFor(t, "the old store to be discarded", func() bool { return sp.log.len() == 3 })
				calls = []string{"fork", "close " + was.SessionID, "discard " + was.SessionID}
				fc := sp.forkCalls()
				if len(fc) != forks+1 || sp.count() != spawns || opts.SessionID != "" || fc[forks].src != fc[forks-1].src {
					t.Fatalf("%d fork starts (were %d), %d spawns (were %d), the last %+v, the first %+v", len(fc), forks, sp.count(), spawns, fc[forks], fc[forks-1])
				}
				if want := (agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: e.meta(src).SessionID, Point: "p1", Next: "p2"}); fc[forks].src != want {
					t.Fatalf("the new fork's source %+v, want %+v", fc[forks].src, want)
				}
			}
			if log := sp.log.take(); !reflect.DeepEqual(log, calls) {
				t.Fatalf("the adapter calls %v, want %v", log, calls)
			}
			if opts.ChatID != id || opts.Model != want.Model || opts.Effort != want.Effort || opts.MCP == nil || opts.MCP.Token != was.Token {
				t.Fatalf("the new process was started with %+v", opts)
			}
			if !first.isClosed() || e.started(kind).isClosed() || e.started(kind) == first {
				t.Fatalf("closed: the old process %v, the new one %v", first.isClosed(), e.started(kind).isClosed())
			}

			// The record: the new choice, still fresh, the same chat otherwise.
			m := e.meta(id)
			if m.Model != want.Model || m.Effort != want.Effort || m.Usage.CtxWindow != window || !m.Fresh || !m.Locked || m.SourceCtx != was.SourceCtx {
				t.Fatalf("chat.json after the change %+v", m)
			}
			if kind == model.Cursor {
				if m.SessionID == was.SessionID || !strings.HasPrefix(m.SessionID, "store-") {
					t.Fatalf("the Cursor fork's session %q, was %q", m.SessionID, was.SessionID)
				}
			} else if m.SessionID != was.SessionID {
				t.Fatalf("the fork's session %q, was %q", m.SessionID, was.SessionID)
			}
			if !reflect.DeepEqual(m.ForkSource, was.ForkSource) || (kind == model.Claude) != (m.ForkSource != nil) {
				t.Fatalf("the fork source %+v, was %+v", m.ForkSource, was.ForkSource)
			}
			if v := e.view(id); v.Status != model.StatusReady || v.Error != "" || !v.Fresh || v.Model != want.Model || v.Effort != want.Effort {
				t.Fatalf("view after the change %+v", v)
			}
			if len(e.items(id)) != n {
				t.Fatalf("the change added items: %+v", e.items(id)[n:])
			}
			e.idle("after the change", id)

			// The events: thinking where the lock is released for the start, then ready.
			status := []model.Status{model.StatusThinking, model.StatusReady}
			if kind == model.Pi {
				status = status[1:]
			}
			sts, chatEvs := statesOf(t, got, id, model.MainBranch), chatEventsOf(got, id)
			if len(sts) != len(status) || len(chatEvs) != len(status) {
				t.Fatalf("%d state records and %d chat events, want %d of each: %+v", len(sts), len(chatEvs), len(status), got)
			}
			for i, st := range sts {
				cv := chatEvs[i]["chat"].(map[string]any)
				if st.Status != status[i] || st.Model != want.Model || st.Effort != want.Effort || !st.Fresh ||
					cv["status"] != string(status[i]) || cv["model"] != want.Model || cv["fresh"] != true {
					t.Fatalf("event %d: the state record %+v, the view %v; want %s on %+v", i, st, cv, status[i], want)
				}
			}
			if len(ofType(got, "defaults")) != 0 || !reflect.DeepEqual(e.defaultsOf(), defs) {
				t.Fatalf("the fork's choice became a default: %+v", e.defaultsOf())
			}
			if !bytes.Equal(e.file(src, "chat.json"), srcFile) {
				t.Fatal("the source's chat.json changed")
			}

			// What the new process says first clears nothing; the fork's message goes to it.
			e.started(kind).emit(t, agent.Event{Kind: agent.EvCatalog}, agent.Event{Kind: agent.EvTurnEnd})
			if m := e.meta(id); !m.Fresh || m.TurnActive || !reflect.DeepEqual(m.ForkSource, was.ForkSource) {
				t.Fatalf("chat.json after the new process's first events %+v", m)
			}
			e.send(id, "on the fork", "")
			if kind != model.Pi {
				forks++ // the restart's
			}
			if sent := e.started(kind).sent(); len(sent) != 1 || len(first.sent()) != 0 || len(sp.forkCalls()) != forks {
				t.Fatalf("the new process got %v, the old one %v; %d fork starts", sent, first.sent(), len(sp.forkCalls()))
			}
		})
	}
}

// A choice that resolves to the one the fork has starts nothing.
func TestConfigureFreshForkSameChoice(t *testing.T) {
	e := newEnv(t)
	_, id, sp := e.freshFork(model.Claude)
	file := e.file(id, "chat.json")
	evs := e.listen()
	for _, req := range []ConfigReq{{Model: "sonnet"}, {Effort: "high"}, {Model: "sonnet", Effort: "high"}, {}} {
		if err := e.m.Configure(id, req); err != nil {
			t.Fatalf("Configure %+v: %v", req, err)
		}
	}
	if log := sp.log.take(); len(log) != 0 || e.started(model.Claude).isClosed() {
		t.Fatalf("the same choice asked the adapter for %v", log)
	}
	if got := evs.drain(t, e.br); len(got) != 0 || !bytes.Equal(e.file(id, "chat.json"), file) {
		t.Fatalf("the same choice sent %+v", got)
	}
	// A choice that cannot be is refused as everywhere, and starts nothing either.
	for req, text := range map[ConfigReq]string{
		{Model: "nope"}:                  `unknown model "nope"`,
		{Effort: "bogus"}:                `sonnet has no effort "bogus"`,
		{Model: "haiku", Effort: "high"}: `haiku has no effort "high"`,
	} {
		if err := e.m.Configure(id, req); !errors.Is(err, ErrBadChoice) || err.Error() != text {
			t.Fatalf("Configure %+v: %v", req, err)
		}
	}
	if log := sp.log.take(); len(log) != 0 || !bytes.Equal(e.file(id, "chat.json"), file) {
		t.Fatalf("a refused choice asked the adapter for %v", log)
	}
	e.send(id, "on the fork", "")
	if sent := e.started(model.Claude).sent(); len(sent) != 1 || len(sp.forkCalls()) != 1 {
		t.Fatalf("the fork's first process got %v; %d fork starts", sent, len(sp.forkCalls()))
	}
}

// A fresh fork's folder is fixed as a started chat's is: only a missing one is replaced.
func TestConfigureFreshForkFolderRefused(t *testing.T) {
	e := newEnv(t)
	_, id, sp := e.freshFork(model.Claude)
	file := e.file(id, "chat.json")
	dir := t.TempDir()
	for _, req := range []ConfigReq{{Cwd: dir}, {Cwd: dir, Model: "opus"}, {Cwd: dir, Effort: "low"}} {
		if err := e.m.Configure(id, req); !errors.Is(err, ErrLocked) {
			t.Fatalf("Configure %+v: %v", req, err)
		}
	}
	if log := sp.log.take(); len(log) != 0 || !bytes.Equal(e.file(id, "chat.json"), file) {
		t.Fatalf("a refused folder asked the adapter for %v", log)
	}

	// The folder fix, after a restart of the app: the folder alone, and nothing is started for it.
	if err := os.RemoveAll(e.cwd); err != nil {
		t.Fatal(err)
	}
	e.boot()
	sp = e.logged(model.Claude)
	if err := e.m.Open(id); err != nil {
		t.Fatal(err)
	}
	if v := e.view(id); !v.FolderMissing || !v.Fresh {
		t.Fatalf("view with the folder gone %+v", v)
	}
	if err := e.m.Configure(id, ConfigReq{Cwd: dir, Model: "opus"}); !errors.Is(err, ErrLocked) {
		t.Fatalf("a folder with a model for the missing folder: %v", err)
	}
	if err := e.m.Configure(id, ConfigReq{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	if v := e.view(id); v.FolderMissing || v.Cwd != dir || !v.Fresh || v.Model != "sonnet" || v.Status != model.StatusReady {
		t.Fatalf("view after the fix %+v", v)
	}
	if log := sp.log.take(); len(log) != 0 {
		t.Fatalf("the folder fix asked the adapter for %v", log)
	}
	// The model is still open, and the start uses the new folder.
	if err := e.m.Configure(id, ConfigReq{Model: "opus"}); err != nil {
		t.Fatal(err)
	}
	if o := e.started(model.Claude).opts; o.Cwd != dir || o.Model != "opus" {
		t.Fatalf("the process was started with %+v", o)
	}
}

// After a restart of the app the fork has no process: the change starts one the same way, with
// nothing to close.
func TestConfigureFreshForkNoProcess(t *testing.T) {
	for _, kind := range forkKinds {
		t.Run(string(kind), func(t *testing.T) {
			e := newEnv(t)
			_, id, _ := e.freshFork(kind)
			was := e.meta(id)
			e.m.naming.Wait()
			e.boot()
			sp := e.logged(kind)
			if kind == model.Pi {
				e.storeCatalog(model.Pi, piCatalog)
			}
			req, want, window := another(kind)
			if err := e.m.Configure(id, req); err != nil {
				t.Fatal(err)
			}
			calls := []string{"fork"}
			switch kind {
			case model.Pi:
				calls = []string{"spawn"}
			case model.Cursor: // the store the fork had is discarded all the same
				waitFor(t, "the old store to be discarded", func() bool { return sp.log.len() == 2 })
				calls = []string{"fork", "discard " + was.SessionID}
			}
			if log := sp.log.take(); !reflect.DeepEqual(log, calls) {
				t.Fatalf("the adapter calls %v, want %v", log, calls)
			}
			m, o := e.meta(id), e.started(kind).opts
			if m.Model != want.Model || m.Effort != want.Effort || m.Usage.CtxWindow != window || !m.Fresh {
				t.Fatalf("chat.json after the change %+v", m)
			}
			if o.ChatID != id || o.Model != want.Model || o.Effort != want.Effort || !o.Resume ||
				(kind != model.Cursor && o.SessionID != was.SessionID) || (kind == model.Cursor) != (m.SessionID != was.SessionID) {
				t.Fatalf("the process was started with %+v; the fork's session %q, was %q", o, m.SessionID, was.SessionID)
			}
			if v := e.view(id); v.Status != model.StatusReady || !v.Fresh || v.Model != want.Model {
				t.Fatalf("view after the change %+v", v)
			}
			e.idle("after the change", id)
			// The message goes to the process the change started: no other is started for it.
			forks, spawns := len(sp.forkCalls()), sp.count()
			e.send(id, "on the fork", "")
			if sent := e.started(kind).sent(); len(sent) != 1 || len(sp.forkCalls()) != forks || sp.count() != spawns {
				t.Fatalf("the process got %v; %d fork starts (were %d), %d spawns (were %d)", sent, len(sp.forkCalls()), forks, sp.count(), spawns)
			}
		})
	}
}

// The process a change starts is there before the human has written in the fork, as the fork's
// first one was: the fork is held, also after a restart of the app, which holds nothing. A turn
// end of the new process starts no turn for a result the fork owes; the human's message carries it.
func TestConfigureFreshForkStartsNoTurn(t *testing.T) {
	e := newEnv(t)
	id, parent, sa, child := e.spawnLinked()
	e.finish(child, "the report")
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"},
		agent.Event{Kind: agent.EvTurnEnd, Error: "rate limited", Point: "p1"})
	e.m.handoffs.Wait()
	f := e.fork(id, len(e.items(id))).ID
	e.m.naming.Wait()
	e.boot()
	if e.holding(f) {
		t.Fatal("the fork is held after a restart of the app")
	}

	e.configure(f, ConfigReq{Model: "opus"})
	a := e.claude.lastFork(t)
	if !e.holding(f) || a.opts.Model != "opus" {
		t.Fatalf("after the change: held %v, the process on %q", e.holding(f), a.opts.Model)
	}
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if n := len(a.sent()); n != 0 {
		t.Fatalf("the fork's agent was sent %d message(s) with no human message", n)
	}
	if v := e.view(f); v.SubsOwed != 1 || v.Status != model.StatusReady || !v.Fresh || e.meta(f).TurnActive {
		t.Fatalf("fork view %+v", v)
	}
	e.idle("after the new process's turn end", f)

	e.send(f, "hello fork", "")
	carriedAhead(t, a.sent()[0], "hello fork", sa.ID)
	e.delivery("the fork's message", f, sa.ID, model.SubSent)
}

// The fork's first accepted message fixes its model and effort, also one its agent refuses.
func TestConfigureFreshForkLocksAtFirstMessage(t *testing.T) {
	e := newEnv(t)
	src, id, sp := e.freshFork(model.Claude)
	e.configure(id, ConfigReq{Model: "haiku"})
	sp.log.take()
	e.send(id, "on the fork", "")
	locked := func(when, id string) {
		t.Helper()
		for _, req := range []ConfigReq{{Model: "opus"}, {Effort: "low"}, {Model: "haiku"}, {Cwd: t.TempDir()}} {
			if err := e.m.Configure(id, req); !errors.Is(err, ErrLocked) {
				t.Fatalf("%s, Configure %+v: %v", when, req, err)
			}
		}
		if log := sp.log.take(); len(log) != 0 {
			t.Fatalf("%s: a refused change asked the adapter for %v", when, log)
		}
	}
	locked("during the fork's first turn", id)
	e.started(model.Claude).emit(t, reply("f1")...)
	locked("after the fork's first turn", id)
	if m := e.meta(id); m.Model != "haiku" || m.Fresh {
		t.Fatalf("chat.json %+v", m)
	}

	other := e.fork(src, 3).ID
	sp.log.take()
	e.started(model.Claude).failSends(errors.New("refused"))
	if err := e.m.Send(other, "never taken", "", nil); err == nil {
		t.Fatal("the refusing agent took the message")
	}
	locked("after a message the agent refused", other)
}

// A start that fails leaves the record with the previous choice, and the answer is the failure.
func TestConfigureFreshForkRestartFails(t *testing.T) {
	boom := errors.New("the start failed")
	for _, kind := range forkKinds {
		t.Run(string(kind), func(t *testing.T) {
			e := newEnv(t)
			_, id, sp := e.freshFork(kind)
			was, file := e.meta(id), e.file(id, "chat.json")
			first := e.started(kind)
			if kind == model.Pi {
				first = e.pi.lastFork(t)
			}
			req, want, _ := another(kind)
			sp.failSpawns(boom)
			sp.set(func(s *fakeSpawner) { s.forkErr = boom })
			evs := e.listen()
			if err := e.m.Configure(id, req); !errors.Is(err, boom) {
				t.Fatalf("Configure with a failing start: %v", err)
			}
			got := evs.drain(t, e.br)

			// The previous choice is back, in memory, in the file and in what clients saw last.
			if !bytes.Equal(e.file(id, "chat.json"), file) {
				t.Fatalf("chat.json after the failed start:\n%s\nwas:\n%s", e.file(id, "chat.json"), file)
			}
			v := e.view(id)
			if v.Model != was.Model || v.Effort != was.Effort || v.Usage.CtxWindow != was.Usage.CtxWindow || !v.Fresh {
				t.Fatalf("view after the failed start %+v", v)
			}
			sts := statesOf(t, got, id, model.MainBranch)
			if len(sts) == 0 || sts[len(sts)-1].Model != was.Model || sts[len(sts)-1].Effort != was.Effort || sts[len(sts)-1].Status != v.Status {
				t.Fatalf("the state records of the failed start %+v", sts)
			}
			e.idle("after the failed start", id)
			if kind == model.Cursor {
				// Started first: the fork is as it was, with its process and its store.
				if log := sp.log.take(); !reflect.DeepEqual(log, []string{"fork"}) || first.isClosed() || len(sp.discarded()) != 0 {
					t.Fatalf("the adapter calls %v; the old process closed %v; discarded %v", log, first.isClosed(), sp.discarded())
				}
				if v.Status != model.StatusReady || v.Error != "" {
					t.Fatalf("view after the failed start %+v", v)
				}
			} else {
				// Closed first: the fork shows the failed start and has no process.
				calls := []string{"close " + was.SessionID, map[model.AgentKind]string{model.Pi: "spawn", model.Claude: "fork"}[kind]}
				if log := sp.log.take(); !reflect.DeepEqual(log, calls) || !first.isClosed() {
					t.Fatalf("the adapter calls %v, want %v; the old process closed %v", log, calls, first.isClosed())
				}
				if v.Status != model.StatusError || v.Error != boom.Error() {
					t.Fatalf("view after the failed start %+v", v)
				}
			}

			// The next change starts a process on its choice.
			sp.failSpawns(nil)
			sp.set(func(s *fakeSpawner) { s.forkErr = nil })
			if err := e.m.Configure(id, req); err != nil {
				t.Fatal(err)
			}
			if v := e.view(id); v.Status != model.StatusReady || v.Error != "" || v.Model != want.Model || v.Effort != want.Effort || !v.Fresh {
				t.Fatalf("view after the next change %+v", v)
			}
			if o := e.started(kind).opts; o.Model != want.Model || e.started(kind).isClosed() {
				t.Fatalf("the process of the next change %+v", o)
			}
		})
	}

	// A Cursor fork is made again from its source: once that is gone, or has gone on past a place
	// no id names, there is nothing to make it of, and the fork keeps what it has.
	t.Run("cursor, the source deleted", func(t *testing.T) {
		e := newEnv(t)
		src, id, sp := e.freshFork(model.Cursor)
		file, first := e.file(id, "chat.json"), e.started(model.Cursor)
		if err := e.m.Delete(src); err != nil {
			t.Fatal(err)
		}
		sp.log.take() // the source's own process was closed
		evs := e.listen()
		if err := e.m.Configure(id, ConfigReq{Model: "gpt-5.4-mini"}); !errors.Is(err, errOriginGone) {
			t.Fatalf("Configure with the source deleted: %v", err)
		}
		if log := sp.log.take(); len(log) != 0 || first.isClosed() || !bytes.Equal(e.file(id, "chat.json"), file) {
			t.Fatalf("the adapter calls %v; the old process closed %v", log, first.isClosed())
		}
		if v := e.view(id); v.Status != model.StatusReady || v.Model != "composer-2" || !v.Fresh {
			t.Fatalf("view after the refusal %+v", v)
		}
		if sts := statesOf(t, evs.drain(t, e.br), id, model.MainBranch); len(sts) != 2 || sts[1].Status != model.StatusReady || sts[1].Model != "composer-2" {
			t.Fatalf("the state records of the refusal %+v", sts)
		}
		e.send(id, "on the fork", "")
		if len(first.sent()) != 1 {
			t.Fatal("the message did not go to the fork's own process")
		}
	})
	t.Run("cursor, the source went on", func(t *testing.T) {
		e := newEnv(t)
		sp := e.logged(model.Cursor)
		src := e.create(model.Cursor, gOne, "").ID
		e.send(src, "ask 1", "")
		a := e.cursor.last(t)
		a.emit(t, agent.Event{Kind: agent.EvSession, SessionID: "cur-1"}, agent.Event{Kind: agent.EvText, Text: "reply 1"},
			agent.Event{Kind: agent.EvTurnEnd}) // a turn end no id names
		id := e.fork(src, len(e.items(src))).ID
		// While the source ends where the fork was made, the fork is made of the whole of it.
		e.configure(id, ConfigReq{Model: "gpt-5.4-mini"})
		fc := sp.forkCalls()
		if len(fc) != 2 || !fc[1].src.End || fc[1].src != fc[0].src {
			t.Fatalf("the fork starts %+v", fc)
		}
		waitFor(t, "the old store to be discarded", func() bool { return len(sp.discarded()) == 1 })
		sp.log.take()
		file, second := e.file(id, "chat.json"), e.started(model.Cursor)
		e.send(src, "ask 2", "")
		for _, when := range []string{"while the source's next turn runs", "after it"} {
			if err := e.m.Configure(id, ConfigReq{Model: "composer-2"}); !errors.Is(err, errOriginGone) {
				t.Fatalf("Configure %s: %v", when, err)
			}
			if log := sp.log.take(); len(log) != 0 || second.isClosed() || !bytes.Equal(e.file(id, "chat.json"), file) {
				t.Fatalf("%s: the adapter calls %v; the fork's process closed %v", when, log, second.isClosed())
			}
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "reply 2"}, agent.Event{Kind: agent.EvTurnEnd})
		}
	})
}

// A Claude fork made at a place no id names can be made again only of its whole source: once that
// has gone on, or is gone, the change is refused before the fork's process is closed, and the fork
// is as it was. While the source still ends there, the fork is made again of it.
func TestConfigureFreshForkNoPoint(t *testing.T) {
	gone := map[string]func(e *env, src string){
		"the source went on": func(e *env, src string) { e.turn(src, nil, 2) },
		"the source deleted": func(e *env, src string) {
			if err := e.m.Delete(src); err != nil {
				e.t.Fatal(err)
			}
		},
	}
	for name, lose := range gone {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			src, id := e.oldFork()
			sp := e.logged(model.Claude)
			first := e.claude.lastFork(t)
			lose(e, src)
			e.m.naming.Wait()
			sp.log.take()
			was, file, forks, n := e.view(id), e.file(id, "chat.json"), len(sp.forkCalls()), len(e.items(id))
			if m := e.meta(id); !m.Fresh || m.ForkSource == nil || m.ForkSource.Point != "" || was.Status != model.StatusReady {
				t.Fatalf("the fork %+v, view %+v", m, was)
			}
			req, want, _ := another(model.Claude)

			evs := e.listen()
			if err := e.m.Configure(id, req); !errors.Is(err, errForkGone) {
				t.Fatalf("Configure of a fork that cannot be made again: %v", err)
			}
			got := evs.drain(t, e.br)

			// Nothing was asked of the adapter: the fork has the process it had.
			if log := sp.log.take(); len(log) != 0 || first.isClosed() || len(sp.forkCalls()) != forks {
				t.Fatalf("the adapter calls %v; the fork's process closed %v; %d fork starts (were %d)", log, first.isClosed(), len(sp.forkCalls()), forks)
			}
			if !bytes.Equal(e.file(id, "chat.json"), file) {
				t.Fatalf("chat.json after the refusal:\n%s\nwas:\n%s", e.file(id, "chat.json"), file)
			}
			v := e.view(id)
			if v.Model != was.Model || v.Effort != was.Effort || v.Usage.CtxWindow != was.Usage.CtxWindow || !v.Fresh ||
				v.Status != model.StatusReady || v.Error != "" || len(e.items(id)) != n {
				t.Fatalf("view after the refusal %+v, was %+v", v, was)
			}
			// Thinking during the look at the source, on the choice asked for; then as before.
			sts := statesOf(t, got, id, model.MainBranch)
			if len(sts) != 2 || sts[0].Status != model.StatusThinking || sts[0].Model != want.Model ||
				sts[1].Status != model.StatusReady || sts[1].Model != was.Model || sts[1].Effort != was.Effort || !sts[1].Fresh {
				t.Fatalf("the state records of the refusal %+v", sts)
			}
			e.idle("after the refusal", id)

			// The fork still works, and stays refused.
			if err := e.m.Configure(id, req); !errors.Is(err, errForkGone) || first.isClosed() {
				t.Fatalf("a second change: %v; the fork's process closed %v", err, first.isClosed())
			}
			e.send(id, "on the fork", "")
			if sent := first.sent(); len(sent) != 1 || len(sp.forkCalls()) != forks || len(sp.log.take()) != 0 {
				t.Fatalf("the fork's first process got %v; %d fork starts (were %d)", sent, len(sp.forkCalls()), forks)
			}
		})
	}

	t.Run("the source kept", func(t *testing.T) {
		e := newEnv(t)
		src, id := e.oldFork()
		sp := e.logged(model.Claude)
		first, was := e.claude.lastFork(t), e.meta(id)
		req, want, window := another(model.Claude)
		evs := e.listen()
		if err := e.m.Configure(id, req); err != nil {
			t.Fatal(err)
		}
		got := evs.drain(t, e.br)

		// Closed, then made again of the whole source under the same id.
		fc, a := sp.forkCalls(), e.claude.lastFork(t)
		if log := sp.log.take(); !reflect.DeepEqual(log, []string{"fork"}) || len(fc) != 2 || !first.isClosed() || a == first || a.isClosed() {
			t.Fatalf("the adapter calls %v; %d fork starts; closed: the old process %v, the new one %v", log, len(fc), first.isClosed(), a.isClosed())
		}
		if wantSrc := (agent.ForkSource{ChatID: src, Dir: e.st.P.ChatDir(src), SessionID: e.meta(src).SessionID}); fc[1].src != wantSrc {
			t.Fatalf("the new fork's source %+v, want %+v", fc[1].src, wantSrc)
		}
		if o := a.opts; o.ChatID != id || o.SessionID != was.SessionID || !o.Resume || o.Model != want.Model || o.Effort != want.Effort {
			t.Fatalf("the new process was started with %+v", o)
		}
		m := e.meta(id)
		if m.Model != want.Model || m.Effort != want.Effort || m.Usage.CtxWindow != window || !m.Fresh || m.SessionID != was.SessionID ||
			!reflect.DeepEqual(m.ForkSource, was.ForkSource) {
			t.Fatalf("chat.json after the change %+v", m)
		}
		if v := e.view(id); v.Status != model.StatusReady || v.Error != "" || !v.Fresh || v.Model != want.Model || v.Effort != want.Effort {
			t.Fatalf("view after the change %+v", v)
		}
		// Thinking for the look at the source and again for the start, then ready: all on the new choice.
		sts := statesOf(t, got, id, model.MainBranch)
		if len(sts) != 3 || sts[0].Status != model.StatusThinking || sts[1].Status != model.StatusThinking || sts[2].Status != model.StatusReady {
			t.Fatalf("the state records of the change %+v", sts)
		}
		for _, st := range sts {
			if st.Model != want.Model || st.Effort != want.Effort || !st.Fresh {
				t.Fatalf("the state records of the change %+v", sts)
			}
		}
		e.idle("after the change", id)
		e.send(id, "on the fork", "")
		if sent := a.sent(); len(sent) != 1 || len(first.sent()) != 0 || len(sp.forkCalls()) != 2 {
			t.Fatalf("the new process got %v, the old one %v; %d fork starts", sent, first.sent(), len(sp.forkCalls()))
		}
	})
}

// A Cursor fork's new session id is in chat.json before its old store is given up: when that save
// fails the fork keeps its process, its store and its choice, and the new fork is given up instead.
func TestConfigureFreshForkSaveFails(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes in a read-only folder")
	}
	e := newEnv(t)
	_, id, sp := e.freshFork(model.Cursor)
	was, file, first := e.meta(id), e.file(id, "chat.json"), e.started(model.Cursor)
	req, _, _ := another(model.Cursor)
	dir := e.st.P.ChatDir(id)
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	writable := func() {
		if err := os.Chmod(dir, info.Mode().Perm()); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(writable)
	if err := os.Chmod(dir, 0o500); err != nil { // no chat.json can be written
		t.Fatal(err)
	}
	evs := e.listen()
	err = e.m.Configure(id, req)
	writable()
	if !errors.Is(err, os.ErrPermission) {
		t.Fatalf("Configure with a save that fails: %v", err)
	}
	got := evs.drain(t, e.br)

	// The new fork was started, and is given up: its process closed, its store discarded.
	waitFor(t, "the new store to be discarded", func() bool { return len(sp.discarded()) == 1 })
	started, d := e.started(model.Cursor), sp.discarded()[0]
	if d == was.SessionID || !strings.HasPrefix(d, "store-") || started == first || !started.isClosed() || first.isClosed() {
		t.Fatalf("discarded %q, the fork's own session is %q; closed: the new process %v, the fork's own %v", d, was.SessionID, started.isClosed(), first.isClosed())
	}
	if log := sp.log.take(); !reflect.DeepEqual(log, []string{"fork", "close " + d, "discard " + d}) {
		t.Fatalf("the adapter calls %v", log)
	}
	// The fork is as it was: in the file, in memory and in what clients saw last.
	if !bytes.Equal(e.file(id, "chat.json"), file) || e.meta(id).SessionID != was.SessionID {
		t.Fatalf("chat.json after the failed save:\n%s\nwas:\n%s", e.file(id, "chat.json"), file)
	}
	v := e.view(id)
	if v.Model != was.Model || v.Effort != was.Effort || v.Usage.CtxWindow != was.Usage.CtxWindow || !v.Fresh || v.Status != model.StatusReady || v.Error != "" {
		t.Fatalf("view after the failed save %+v", v)
	}
	sts := statesOf(t, got, id, model.MainBranch)
	if len(sts) != 2 || sts[1].Status != model.StatusReady || sts[1].Model != was.Model || sts[1].Effort != was.Effort || !sts[1].Fresh {
		t.Fatalf("the state records of the failed save %+v", sts)
	}
	e.idle("after the failed save", id)

	// The message goes to the fork's own process, on its own session.
	forks, spawns := len(sp.forkCalls()), sp.count()
	e.send(id, "on the fork", "")
	if sent := first.sent(); len(sent) != 1 || len(sp.forkCalls()) != forks || sp.count() != spawns || e.meta(id).SessionID != was.SessionID {
		t.Fatalf("the fork's own process got %v; %d fork starts (were %d), %d spawns (were %d)", sent, len(sp.forkCalls()), forks, sp.count(), spawns)
	}

	// With the folder writable again the next fork of the kind takes the change: the old store goes.
	_, id2, sp2 := e.freshFork(model.Cursor)
	old := e.meta(id2).SessionID
	e.configure(id2, req)
	waitFor(t, "the old store to be discarded", func() bool { return len(sp2.discarded()) == 2 })
	if ds := sp2.discarded(); ds[1] != old || e.meta(id2).SessionID == old {
		t.Fatalf("discarded %v, the fork's old session is %q, its new one %q", ds, old, e.meta(id2).SessionID)
	}
}

// What the closed process still says is dropped: the fork is the new process's from the close on.
func TestConfigureFreshForkLateEvents(t *testing.T) {
	e := newEnv(t)
	_, id, sp := e.freshFork(model.Claude)
	first, n := e.started(model.Claude), len(e.items(id))
	req, want, _ := another(model.Claude)
	b, res := e.block(sp.fakeSpawner, func() error { return e.m.Configure(id, req) })
	if !first.isClosed() {
		t.Fatal("the old process is open during the start")
	}
	// The closed process ends in its own time: a last text, then its exit.
	first.emit(t, agent.Event{Kind: agent.EvText, Text: "late"})
	first.exit(t)
	items, v := e.items(id), e.view(id)
	if err := b.release(res, nil); err != nil {
		t.Fatal(err)
	}
	if len(items) != n || v.Status != model.StatusThinking || v.Error != "" {
		t.Fatalf("the closed process's last events: %d items (were %d), view %+v", len(items), n, v)
	}
	if v := e.view(id); v.Status != model.StatusReady || v.Model != want.Model || !v.Fresh || len(e.items(id)) != n {
		t.Fatalf("view after the start %+v; %d items (were %d)", v, len(e.items(id)), n)
	}
	e.send(id, "on the fork", "")
	if a := e.started(model.Claude); len(a.sent()) != 1 || a.isClosed() {
		t.Fatalf("the new process got %v", a.sent())
	}
}

// pi fails a session whose conversation does not fit the model's window: the change is refused
// before anything is closed, by the context the fork got from its source.
func TestConfigureFreshForkWindow(t *testing.T) {
	e := newEnv(t)
	sp := e.logged(model.Pi)
	src, _ := e.piTalked()
	for _, made := range []string{"", "unsized"} { // on the source's model, and on another
		v, err := e.forkWith(src, 3, made, "")
		if err != nil {
			t.Fatal(err)
		}
		if m := e.meta(v.ID); m.Usage.CtxIn != 0 || m.SourceCtx != piCtx {
			t.Fatalf("the fork's chat.json %+v", m)
		}
		sp.log.take()
		file := e.file(v.ID, "chat.json")
		err = e.m.Configure(v.ID, ConfigReq{Model: "small"})
		if !errors.Is(err, ErrWindow) || !strings.Contains(err.Error(), "Small takes 32000 tokens and the conversation holds about 20000") {
			t.Fatalf("a fork made on %q, changed to a model too small: %v", made, err)
		}
		if log := sp.log.take(); len(log) != 0 || !bytes.Equal(e.file(v.ID, "chat.json"), file) || e.pi.lastFork(t).isClosed() {
			t.Fatalf("the refused change asked the adapter for %v", log)
		}
		// A model with room, and one whose window is not known, pass.
		next, window := "unsized", 0
		if made == "unsized" {
			next, window = "big", 200_000
		}
		if err := e.m.Configure(v.ID, ConfigReq{Model: next}); err != nil {
			t.Fatal(err)
		}
		if m := e.meta(v.ID); m.Model != next || m.Usage.CtxWindow != window || m.SourceCtx != piCtx {
			t.Fatalf("chat.json after the change to %q: %+v", next, m)
		}
		// The guard still has the source's context after a change.
		if err := e.m.Configure(v.ID, ConfigReq{Model: "small"}); !errors.Is(err, ErrWindow) {
			t.Fatalf("a changed fork, changed to a model too small: %v", err)
		}
	}
}

// ---- at once --------------------------------------------------------------

// While the lock is released for the start (Claude, Cursor) the fork is busy: a second change and
// a Send are refused, a Stop does nothing, and a fork deleted or archived meanwhile gets no
// process.
func TestConfigureFreshForkAtOnce(t *testing.T) {
	for _, kind := range []model.AgentKind{model.Claude, model.Cursor} {
		t.Run(string(kind), func(t *testing.T) {
			e := newEnv(t)
			src, id, sp := e.freshFork(kind)
			was := e.meta(id)
			first := e.started(kind)
			req, want, _ := another(kind)
			n := len(e.items(id))
			change := func(id string) func() error {
				return func() error { return e.m.Configure(id, req) }
			}

			b, res := e.block(sp.fakeSpawner, change(id))
			if v := e.view(id); v.Status != model.StatusThinking || v.Model != want.Model || !v.Fresh {
				t.Fatalf("view during the start %+v", v)
			}
			// It counts as working, as a Send's fork start does, but holds no reservation.
			if chat, _ := e.slots(id); chat != 1 || e.reserved() != 0 {
				t.Fatalf("during the start: %d slots held, %d reservations", chat, e.reserved())
			}
			for _, r := range []ConfigReq{req, {Model: was.Model}, {Effort: "low"}, {}} {
				if err := e.m.Configure(id, r); !errors.Is(err, ErrBusy) {
					t.Fatalf("Configure %+v during the start: %v", r, err)
				}
			}
			if err := e.m.Send(id, "too soon", "", nil); !errors.Is(err, ErrBusy) {
				t.Fatalf("Send during the start: %v", err)
			}
			if err := e.m.Interrupt(id); err != nil {
				t.Fatalf("Stop during the start: %v", err)
			}
			if v := e.view(id); v.Status != model.StatusThinking || len(e.items(id)) != n || len(sp.forkCalls()) != 2 {
				t.Fatalf("after a Stop during the start: view %+v, %d items, %d fork starts", v, len(e.items(id)), len(sp.forkCalls()))
			}
			if err := b.release(res, nil); err != nil {
				t.Fatalf("the change a second one, a Send and a Stop came in during: %v", err)
			}
			if v := e.view(id); v.Status != model.StatusReady || v.Model != want.Model || v.Effort != want.Effort || !v.Fresh || len(e.items(id)) != n {
				t.Fatalf("view after the start %+v", v)
			}
			e.idle("after the start", id)
			if kind == model.Cursor {
				waitFor(t, "the old store to be discarded", func() bool { return len(sp.discarded()) == 1 })
			}
			if !first.isClosed() || e.started(kind).isClosed() {
				t.Fatalf("closed: the old process %v, the new one %v", first.isClosed(), e.started(kind).isClosed())
			}

			// Archived during the start: the new process is closed, the choice is the previous one.
			arch := e.fork(src, 3).ID
			old, oldMeta := e.started(kind), e.meta(arch)
			sp.log.take()
			discards := len(sp.discarded())
			b, res = e.block(sp.fakeSpawner, change(arch))
			if err := e.m.SetArchive(arch, model.Archive{Archived: true}); err != nil {
				t.Fatal(err)
			}
			if err := b.release(res, nil); !errors.Is(err, ErrArchived) {
				t.Fatalf("the change of a fork archived during the start: %v", err)
			}
			started := e.started(kind)
			waitFor(t, "the new process to close", started.isClosed)
			m := e.meta(arch)
			if m.Model != oldMeta.Model || m.Effort != oldMeta.Effort || m.SessionID != oldMeta.SessionID || !m.Fresh {
				t.Fatalf("chat.json of the archived fork %+v, was %+v", m, oldMeta)
			}
			if v := e.view(arch); v.Status != model.StatusReady || v.Model != oldMeta.Model {
				t.Fatalf("view of the archived fork %+v", v)
			}
			e.idle("archived during the start", arch)
			if kind == model.Cursor {
				// Its store goes with it; the fork keeps its own process and store.
				waitFor(t, "the new store to be discarded", func() bool { return len(sp.discarded()) == discards+1 })
				if d := sp.discarded()[discards]; d == oldMeta.SessionID || old.isClosed() {
					t.Fatalf("discarded %q, the fork's own session is %q; its process closed %v", d, oldMeta.SessionID, old.isClosed())
				}
				if log := sp.log.take(); !reflect.DeepEqual(log, []string{"fork", "close " + sp.discarded()[discards], "discard " + sp.discarded()[discards]}) {
					t.Fatalf("the adapter calls %v", log)
				}
			}

			// Deleted during the start: the same, and nothing is written.
			gone := e.fork(src, 3).ID
			goneSID := e.meta(gone).SessionID
			sp.log.take()
			discards = len(sp.discarded())
			b, res = e.block(sp.fakeSpawner, change(gone))
			if err := e.m.Delete(gone); err != nil {
				t.Fatal(err)
			}
			if err := b.release(res, nil); !errors.Is(err, ErrNotFound) {
				t.Fatalf("the change of a fork deleted during the start: %v", err)
			}
			started = e.started(kind)
			waitFor(t, "the new process to close", started.isClosed)
			if _, err := os.Stat(e.st.P.ChatDir(gone)); !os.IsNotExist(err) {
				t.Fatalf("the deleted fork's folder: %v", err)
			}
			if kind == model.Cursor {
				waitFor(t, "the new store to be discarded", func() bool { return len(sp.discarded()) == discards+1 })
				if d := sp.discarded()[discards]; d == goneSID {
					t.Fatalf("discarded the fork's own session %q", d)
				}
			}
			if _, all := e.slots(id); all != 0 || e.reserved() != 0 {
				t.Fatalf("after the three starts: %d slots held, %d reservations", all, e.reserved())
			}
		})
	}

	// A Stop of the whole chat (archive, delete) ends the wait of a Cursor fork's start, so a
	// Send can get in before the new fork is there: the message stays where it went, on the
	// choice the record had then, and the new fork is given up.
	t.Run("cursor, a message during the start", func(t *testing.T) {
		e := newEnv(t)
		_, id, sp := e.freshFork(model.Cursor)
		was, first := e.meta(id), e.started(model.Cursor)
		b, res := e.block(sp.fakeSpawner, func() error { return e.m.Configure(id, ConfigReq{Model: "gpt-5.4-mini"}) })
		e.m.Stop(id)
		e.send(id, "on the fork", "")
		a := e.cursor.last(t)
		if o := a.opts; !first.isClosed() || !o.Resume || o.SessionID != was.SessionID || o.Model != "gpt-5.4-mini" || len(a.sent()) != 1 {
			t.Fatalf("the process the message went to was started with %+v and got %v", o, a.sent())
		}
		if err := b.release(res, nil); !errors.Is(err, ErrLocked) {
			t.Fatalf("the change of a fork that got a message during the start: %v", err)
		}
		waitFor(t, "the new store to be discarded", func() bool { return len(sp.discarded()) == 1 })
		if d := sp.discarded()[0]; d == was.SessionID || !e.started(model.Cursor).isClosed() || a.isClosed() {
			t.Fatalf("discarded %q, the fork's own session is %q; closed: the new fork %v, the message's process %v",
				d, was.SessionID, e.started(model.Cursor).isClosed(), a.isClosed())
		}
		m := e.meta(id)
		if m.SessionID != was.SessionID || m.Model != "gpt-5.4-mini" || m.Fresh || !m.TurnActive {
			t.Fatalf("chat.json %+v", m)
		}
		if v := e.view(id); v.Status != model.StatusThinking || v.Model != "gpt-5.4-mini" {
			t.Fatalf("view %+v", v)
		}
		a.emit(t, reply("f1")...)
		if v := e.view(id); v.Status != model.StatusReady {
			t.Fatalf("view after the turn %+v", v)
		}
	})

	// pi's start holds the fork's lock: what comes in meanwhile waits for it, and then finds the
	// fork restarted.
	t.Run("pi", func(t *testing.T) {
		e := newEnv(t)
		_, id, sp := e.freshFork(model.Pi)
		waiting, release := sp.holdSpawn()
		first := make(chan error, 1)
		go func() { first <- e.m.Configure(id, ConfigReq{Model: "unsized"}) }()
		select {
		case <-waiting:
		case <-time.After(5 * time.Second):
			t.Fatal("the restart did not reach the spawn")
		}
		second, sent := make(chan error, 1), make(chan error, 1)
		go func() { second <- e.m.Configure(id, ConfigReq{Effort: "high", Model: "big"}) }()
		go func() { sent <- e.m.Send(id, "on the fork", "", nil) }()
		select {
		case err := <-second:
			t.Fatalf("a second change did not wait for the start: %v", err)
		case err := <-sent:
			t.Fatalf("a Send did not wait for the start: %v", err)
		case <-time.After(50 * time.Millisecond):
		}
		release()
		for what, res := range map[string]chan error{"the change": first, "the Send": sent} {
			select {
			case err := <-res:
				if err != nil {
					t.Fatalf("%s: %v", what, err)
				}
			case <-time.After(5 * time.Second):
				t.Fatalf("%s did not return", what)
			}
		}
		// The second change came before the Send, and restarted once more, or after it.
		var err error
		select {
		case err = <-second:
		case <-time.After(5 * time.Second):
			t.Fatal("the second change did not return")
		}
		m := e.meta(id)
		switch {
		case err == nil && m.Model == "big" && m.Effort == "high" && sp.count() == 3:
		case errors.Is(err, ErrLocked) && m.Model == "unsized" && sp.count() == 2:
		default:
			t.Fatalf("the second change: %v; chat.json %+v; %d spawns", err, m, sp.count())
		}
		a := e.pi.last(t)
		if sent := a.sent(); len(sent) != 1 || a.opts.Model != m.Model || a.isClosed() || m.Fresh {
			t.Fatalf("the last process, on %q, got %v; chat.json %+v", a.opts.Model, sent, m)
		}
		if err := e.m.Configure(id, ConfigReq{Model: "big"}); !errors.Is(err, ErrLocked) {
			t.Fatalf("a change after the fork's first message: %v", err)
		}
	})
}
