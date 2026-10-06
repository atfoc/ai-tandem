package chats

// No process starts once Shutdown has begun, and one whose start was under way is closed.

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// heldSpawner is a spawner whose start can be made to wait, inside Spawn and before the process
// exists.
type heldSpawner struct {
	inner   agent.Spawner
	mu      sync.Mutex
	reached chan struct{}
	gate    chan struct{}
}

// hold makes the next Spawn wait until release is called. reached is closed when it waits.
func (s *heldSpawner) hold() (reached <-chan struct{}, release func()) {
	r, g := make(chan struct{}), make(chan struct{})
	s.mu.Lock()
	s.reached, s.gate = r, g
	s.mu.Unlock()
	return r, sync.OnceFunc(func() { close(g) })
}

func (s *heldSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	s.mu.Lock()
	reached, gate := s.reached, s.gate
	s.reached, s.gate = nil, nil
	s.mu.Unlock()
	if gate != nil {
		close(reached)
		<-gate
	}
	return s.inner.Spawn(o)
}

// shutdownBegun runs Shutdown in the background and returns once it has begun; done is closed when
// it has returned.
func (e *env) shutdownBegun() (done <-chan struct{}) {
	e.t.Helper()
	d := make(chan struct{})
	go func() { defer close(d); e.m.Shutdown() }()
	waitFor(e.t, "Shutdown to begin", e.m.down.Load)
	return d
}

func within(t *testing.T, what string, c <-chan struct{}) {
	t.Helper()
	select {
	case <-c:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// After Shutdown the engine's message to a run agent's chat is refused with ErrShutdown and starts
// nothing: for a chat that never had a process, one whose process Shutdown closed in its turn
// (ErrShutdown, not ErrBusy), one made after Shutdown, and with Fresh. Nor can a run agent start a
// subagent, or a person's chat a process. Shutdown can be called again.
func TestNoProcessStartsAfterShutdown(t *testing.T) {
	e, _ := runEnv(t)
	idle := e.agentChat("agent-idle", model.RoleTask, model.Claude)
	working := e.agentChat("agent-working", model.RoleOrchestrator, model.Claude)
	e.sendOwned(working, "the brief")
	ag := e.claude.last(t)
	person := e.create(model.Claude, gOne, "")

	e.m.Shutdown()
	if !ag.isClosed() {
		t.Fatal("Shutdown left the run agent's process")
	}
	late := e.agentChat("agent-late", model.RoleMerge, model.Claude) // a chat object is no process
	before := e.claude.count()
	for _, c := range []struct {
		id string
		o  OwnedSend
	}{{idle, OwnedSend{}}, {idle, OwnedSend{Fresh: true}}, {working, OwnedSend{}}, {working, OwnedSend{Fresh: true}}, {late, OwnedSend{}}} {
		if err := e.m.SendOwned(c.id, "go on", c.o); !errors.Is(err, ErrShutdown) {
			t.Fatalf("SendOwned %s %+v after Shutdown: %v", c.id, c.o, err)
		}
	}
	if err := ErrShutdown.Error(); err != "the server is shutting down" {
		t.Fatalf("ErrShutdown reads %q", err)
	}
	if _, err := e.m.SpawnSubagent(working, SpawnSubRequest{Prompt: "child work", Description: "child"}); !errors.Is(err, ErrShutdown) {
		t.Fatalf("SpawnSubagent of a run agent after Shutdown: %v", err)
	}
	if err := e.m.Send(person.ID, "hi", "", nil); !errors.Is(err, ErrShutdown) {
		t.Fatalf("Send to a person's chat after Shutdown: %v", err)
	}
	if n := e.claude.count(); n != before {
		t.Fatalf("%d processes started after Shutdown", n-before)
	}
	if subs := e.subs(working); len(subs) != 0 {
		t.Fatalf("a subagent was recorded after Shutdown: %+v", subs)
	}
	if _, err := e.m.WaitOwned(t.Context(), idle); !errors.Is(err, ErrNothingSent) {
		t.Fatalf("a refused message left a wait on the chat: %v", err)
	}

	e.m.Shutdown() // again: nothing to do, and still nothing starts
	if err := e.m.SendOwned(idle, "go on", OwnedSend{}); !errors.Is(err, ErrShutdown) {
		t.Fatalf("SendOwned after the second Shutdown: %v", err)
	}
	if n := e.claude.count(); n != before {
		t.Fatalf("%d processes started after the second Shutdown", n-before)
	}
}

// A message of the engine that is held just before its process starts, in the hold of the chat's
// lock, while Shutdown begins: Shutdown waits for that lock, finds the process on the chat and
// closes it through its adapter before it returns. Nothing is left alive, and the next message is
// refused.
func TestShutdownClosesAProcessThatWasStarting(t *testing.T) {
	e, _ := runEnv(t)
	log := &loggingSpawner{inner: e.claude}
	held := &heldSpawner{inner: log}
	e.m.Spawners[model.Claude] = held
	id := e.agentChat("agent-1", model.RoleTask, model.Claude)

	reached, release := held.hold()
	sent := make(chan struct{})
	go func() { defer close(sent); _ = e.m.SendOwned(id, "the brief", OwnedSend{}) }()
	within(t, "the start of the process", reached)
	done := e.shutdownBegun()
	select {
	case <-done:
		t.Fatal("Shutdown returned while the start it has to close was under way")
	case <-time.After(50 * time.Millisecond):
	}
	if n := e.claude.count(); n != 0 {
		t.Fatalf("%d processes before the start was let go", n)
	}
	release()
	within(t, "Shutdown", done)
	// Shutdown has returned: the close is done, not merely started.
	if n := e.claude.count(); n != 1 {
		t.Fatalf("%d processes started, want the one that was under way", n)
	}
	if got := strings.Join(log.last(t).ended(), ","); got != "interrupt,close" {
		t.Fatalf("the process that was starting, at Shutdown: %q", got)
	}
	within(t, "the message to return", sent)

	if err := e.m.SendOwned(id, "again", OwnedSend{}); !errors.Is(err, ErrShutdown) {
		t.Fatalf("SendOwned after Shutdown: %v", err)
	}
	if n := e.claude.count(); n != 1 {
		t.Fatalf("%d processes after the refused message", n)
	}
}

// The same for a subagent a run agent starts: its start runs without the chat's lock. Shutdown
// ends the subagent it finds recorded, and the process that starts afterwards is closed at once.
func TestShutdownClosesARunAgentsSubagentThatWasStarting(t *testing.T) {
	e, _ := runEnv(t)
	held := &heldSpawner{inner: e.claude}
	e.m.Spawners[model.Claude] = held
	id := e.agentChat("agent-1", model.RoleTask, model.Claude)
	e.sendOwned(id, "the brief")
	parent := e.claude.last(t)

	reached, release := held.hold()
	spawned := make(chan struct{})
	go func() {
		defer close(spawned)
		_, _ = e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "child work", Description: "child"})
	}()
	within(t, "the start of the subagent's process", reached)
	e.m.Shutdown()
	if !parent.isClosed() {
		t.Fatal("Shutdown left the run agent's process")
	}
	subs := e.subs(id)
	if len(subs) != 1 || subs[0].Status != model.SubStopped {
		t.Fatalf("the subagent after Shutdown: %+v", subs)
	}
	release()
	within(t, "SpawnSubagent to return", spawned)
	if n := e.claude.count(); n != 2 {
		t.Fatalf("%d processes, want the agent's and the subagent's", n)
	}
	child := e.claude.last(t)
	waitFor(t, "the subagent's process to be closed", child.isClosed)
	if n := len(child.sent()); n != 0 {
		t.Fatalf("the subagent started after Shutdown was sent %d messages", n)
	}
}

// A fork of a person's chat whose start is under way when Shutdown begins: the chat's lock is not
// held during that start, so Shutdown finds no process on the new chat. The one that then starts
// is closed and the fork refused.
func TestShutdownClosesAForkThatWasStarting(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	b, res := e.block(e.claude, func() error { return e.forkErr(id, 3) })
	e.m.Shutdown()
	if err := b.release(res, nil); !errors.Is(err, ErrShutdown) {
		t.Fatalf("the fork that was starting at Shutdown: %v", err)
	}
	waitFor(t, "the fork's process to be closed", e.claude.lastFork(t).isClosed)
	if err := e.forkErr(id, 3); !errors.Is(err, ErrShutdown) {
		t.Fatalf("Fork after Shutdown: %v", err)
	}
	var n int
	e.claude.set(func(s *fakeSpawner) { n = len(s.forks) })
	if n != 1 {
		t.Fatalf("%d fork starts, want the one that was under way", n)
	}
}
