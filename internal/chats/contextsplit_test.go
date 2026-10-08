package chats

import (
	"errors"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

func (e *env) split(id string, fresh bool) model.ContextSplit {
	e.t.Helper()
	s, err := e.m.ContextSplit(id, fresh)
	if err != nil {
		e.t.Fatal(err)
	}
	return s
}

func wantCalls(t *testing.T, sp *fakeSpawner, live, reads int) {
	t.Helper()
	if l, r := sp.splitCalls(); l != live || r != reads {
		t.Fatalf("splits asked: %d of the agent, %d of the spawner; want %d and %d", l, r, live, reads)
	}
}

func TestContextSplitNotStarted(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	for _, a := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		v := e.create(a, gOne, "")
		if _, err := e.m.ContextSplit(v.ID, false); !errors.Is(err, ErrNotStarted) {
			t.Errorf("%s: err %v, want ErrNotStarted", a, err)
		}
	}
	if _, err := e.m.ContextSplit("nope", false); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown chat: err %v", err)
	}
}

func TestContextSplitKeptUntilMessagesOrTurnsMove(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})

	// Between turns, the running process answers and the split is kept.
	s := e.split(v.ID, false)
	wantCalls(t, e.claude, 1, 0)
	if s.AtMessage != 1 || s.AtTurn != 1 || s.Total != 1 {
		t.Fatalf("split %+v", s)
	}
	if got := e.meta(v.ID).ContextSplit; got == nil || got.Total != 1 || got.AtMessage != 1 || got.AtTurn != 1 {
		t.Fatalf("chat.json split %+v", got)
	}
	// Nothing moved: the kept one, without asking.
	if s := e.split(v.ID, false); s.Total != 1 {
		t.Fatalf("second split %+v, want the kept one", s)
	}
	wantCalls(t, e.claude, 1, 0)
	// fresh asks anyway.
	if s := e.split(v.ID, true); s.Total != 2 {
		t.Fatalf("fresh split %+v", s)
	}
	wantCalls(t, e.claude, 2, 0)

	// A new message moves it on.
	e.send(v.ID, "two", "")
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if s := e.split(v.ID, false); s.Total != 3 || s.AtMessage != 2 || s.AtTurn != 2 {
		t.Fatalf("split after a message %+v", s)
	}
	wantCalls(t, e.claude, 3, 0)

	// So does a turn the agent started by itself (a background subagent finished).
	a.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd})
	if s := e.split(v.ID, false); s.Total != 4 || s.AtMessage != 2 || s.AtTurn != 3 {
		t.Fatalf("split after an agent's own turn %+v", s)
	}
	wantCalls(t, e.claude, 4, 0)
}

func TestContextSplitPiKept(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Pi, gOne, "")
	e.send(v.ID, "one", "")
	a := e.pi.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})

	// Between turns, the running process answers and the split is kept in chat.json.
	s := e.split(v.ID, false)
	wantCalls(t, e.pi, 1, 0)
	if s.AtMessage != 1 || s.AtTurn != 1 || s.Total != 1 {
		t.Fatalf("split %+v", s)
	}
	if got := e.meta(v.ID).ContextSplit; got == nil || got.Total != 1 || got.AtMessage != 1 || got.AtTurn != 1 {
		t.Fatalf("chat.json split %+v", got)
	}
	// Nothing moved: the kept one, without asking.
	if s := e.split(v.ID, false); s.Total != 1 {
		t.Fatalf("second split %+v, want the kept one", s)
	}
	wantCalls(t, e.pi, 1, 0)
	// A new message moves it on.
	e.send(v.ID, "two", "")
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if s := e.split(v.ID, false); s.Total != 2 || s.AtMessage != 2 || s.AtTurn != 2 {
		t.Fatalf("split after a message %+v", s)
	}
	wantCalls(t, e.pi, 2, 0)
}

func TestContextSplitDuringTurnNotKept(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.split(v.ID, false) // kept at message 1

	e.send(v.ID, "two", "")
	a.emit(t, agent.Event{Kind: agent.EvThinking})
	if s := e.split(v.ID, false); s.Total != 2 || s.AtMessage != 2 {
		t.Fatalf("split during the turn %+v", s)
	}
	if got := e.meta(v.ID).ContextSplit; got == nil || got.Total != 1 {
		t.Fatalf("chat.json split %+v, want the one from message 1", got)
	}
	// Asked again while the turn runs: the kept one is stale, so the process answers each time.
	e.split(v.ID, false)
	wantCalls(t, e.claude, 3, 0)
}

func TestContextSplitWithoutProcess(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	bd, err := e.bds.Create("board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	v := e.create(model.Claude, "", bd.ID)
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	a.exit(t)

	// No process: the spawner answers, with the chat's own options, and the split is kept.
	if s := e.split(v.ID, false); s.Total != 1 || s.AtMessage != 1 {
		t.Fatalf("split %+v", s)
	}
	wantCalls(t, e.claude, 0, 1)
	o := e.claude.splitReads[0]
	if o.SessionID != e.meta(v.ID).SessionID || !o.Resume || o.MCP == nil || o.MCP.MCPURL == "" || o.Cwd != v.Cwd {
		t.Errorf("options %+v", o)
	}
	if e.claude.count() != 1 {
		t.Errorf("%d agents spawned, want only the chat's", e.claude.count())
	}

	// After a restart the kept split is still current: nothing is started.
	e.boot()
	if s := e.split(v.ID, false); s.Total != 1 {
		t.Fatalf("split after restart %+v", s)
	}
	wantCalls(t, e.claude, 0, 0)
}

func TestContextSplitAfterInterruptedTurn(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.split(v.ID, false)
	// The app closes mid-turn: no turn end, but the message counts.
	e.send(v.ID, "two", "")
	e.m.Shutdown()
	e.boot()
	if s := e.split(v.ID, false); s.Total != 1 || s.AtMessage != 2 {
		t.Fatalf("split %+v, want a new one at message 2", s)
	}
	wantCalls(t, e.claude, 0, 1)
}

func TestContextSplitCursorNotKept(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Cursor, gOne, "")
	e.send(v.ID, "one", "")
	a := e.cursor.last(t)
	a.emit(t, agent.Event{Kind: agent.EvSession, SessionID: "cur-1"}, agent.Event{Kind: agent.EvTurnEnd})

	for i := 1; i <= 2; i++ {
		if s := e.split(v.ID, false); s.Total != i {
			t.Fatalf("split %d: %+v", i, s)
		}
	}
	wantCalls(t, e.cursor, 0, 2)
	if o := e.cursor.splitReads[0]; o.SessionID != "cur-1" {
		t.Errorf("options %+v", o)
	}
	if e.meta(v.ID).ContextSplit != nil {
		t.Error("Cursor's split was kept in chat.json")
	}
}

func TestContextSplitSharedRun(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	a.exit(t)

	gate := make(chan struct{})
	e.claude.mu.Lock()
	e.claude.splitGate = gate
	e.claude.mu.Unlock()
	var wg sync.WaitGroup
	got := make([]model.ContextSplit, 3)
	for i := range got {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got[i], _ = e.m.ContextSplit(v.ID, false)
		}()
	}
	waitFor(t, "the first split to start", func() bool { _, r := e.claude.splitCalls(); return r == 1 })
	// The chat is not held while its split is taken.
	if _, err := e.m.View(v.ID); err != nil {
		t.Fatal(err)
	}
	close(gate)
	wg.Wait()
	wantCalls(t, e.claude, 0, 1)
	for i, s := range got {
		if s.Total != 1 {
			t.Errorf("call %d got %+v", i, s)
		}
	}
}

// A Claude fork has no session of its own until its first message was accepted. With no process
// (after a restart) its split is read from its source's session cut at the fork point, as the
// fork itself is started, and kept as the fork's own.
func TestContextSplitOfUnsentFork(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	src, id := e.claudeFork()
	srcSID := e.meta(src).SessionID
	e.boot()
	if e.meta(id).ForkSource == nil {
		t.Fatal("the fork lost its fork source")
	}
	if s := e.split(id, true); s.Total != 1 || s.AtMessage != 1 {
		t.Fatalf("split %+v", s)
	}
	wantCalls(t, e.claude, 0, 1)
	o := e.claude.splitReads[0]
	if o.SessionID != srcSID || o.Point != "p1" || !o.Resume {
		t.Errorf("read from session %q at %q (resume %v), want the source's %q at p1", o.SessionID, o.Point, o.Resume, srcSID)
	}
	if o.ChatID != id || o.MCP == nil || o.MCP.Token != e.meta(id).Token {
		t.Errorf("options %+v, want the fork's own but for the session", o)
	}
	if len(e.claude.forkCalls()) != 0 || e.claude.count() != 0 {
		t.Errorf("the fork's process was started: %d fork starts, %d spawns", len(e.claude.forkCalls()), e.claude.count())
	}
	if got := e.meta(id); got.ContextSplit == nil || got.ContextSplit.Total != 1 || got.SessionID == srcSID {
		t.Errorf("chat.json: split %+v, session %q", got.ContextSplit, got.SessionID)
	}
	// The kept one is current: nothing is read again.
	if s := e.split(id, false); s.Total != 1 {
		t.Fatalf("kept split %+v", s)
	}
	wantCalls(t, e.claude, 0, 1)
}

// With no id to cut the source at, reading it would show whatever it holds by now: the split is
// refused, and nothing is started. One kept from the fork's process is still returned.
func TestContextSplitOfUnsentForkWithoutPoint(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	_, id := e.oldFork()
	if s := e.split(id, false); s.Total != 1 { // the fork's process answers while it runs
		t.Fatalf("split of the running fork %+v", s)
	}
	wantCalls(t, e.claude, 1, 0)
	e.boot()
	if s := e.split(id, false); s.Total != 1 {
		t.Fatalf("kept split %+v", s)
	}
	for i := 0; i < 2; i++ {
		if _, err := e.m.ContextSplit(id, true); err == nil ||
			err.Error() != "the context split of this fork is available after its first message" {
			t.Fatalf("split %d of a fork with no point: %v", i, err)
		}
	}
	wantCalls(t, e.claude, 0, 0)
	if len(e.claude.forkCalls()) != 0 || e.claude.count() != 0 {
		t.Errorf("a process was started: %d fork starts, %d spawns", len(e.claude.forkCalls()), e.claude.count())
	}
	if got := e.meta(id).ContextSplit; got == nil || got.Total != 1 {
		t.Errorf("chat.json split %+v, want the kept one", got)
	}
}

// A fork whose first message was accepted has its own session, though it keeps its fork source
// until that turn ends: its split is read from its own session, with or without a point.
func TestContextSplitOfSentFork(t *testing.T) {
	t.Parallel()
	for _, point := range []bool{true, false} {
		e := newEnv(t)
		var id string
		if point {
			_, id = e.claudeFork()
		} else {
			_, id = e.oldFork()
		}
		e.send(id, "first", "") // accepted by the fork's process; the app closes during the turn
		e.boot()
		if e.meta(id).ForkSource == nil {
			t.Fatalf("point %v: the fork lost its fork source without a turn end", point)
		}
		e.split(id, true)
		wantCalls(t, e.claude, 0, 1)
		if o := e.claude.splitReads[0]; o.SessionID != e.meta(id).SessionID || o.Point != "" {
			t.Errorf("point %v: read from session %q at %q, want the fork's own %q", point, o.SessionID, o.Point, e.meta(id).SessionID)
		}
	}
}

// While the fork's process runs it answers itself, whatever the fork source.
func TestContextSplitOfRunningFork(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	_, id := e.claudeFork()
	e.split(id, true)
	wantCalls(t, e.claude, 1, 0)
}
