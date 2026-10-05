package chats

import (
	"reflect"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// loggedAgent records the order of the Interrupt and Close calls its process gets.
type loggedAgent struct {
	agent.Agent
	mu    sync.Mutex
	calls []string
}

func (a *loggedAgent) log(call string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, call)
}

func (a *loggedAgent) Interrupt() error { a.log("interrupt"); return a.Agent.Interrupt() }
func (a *loggedAgent) Close()           { a.log("close"); a.Agent.Close() }

func (a *loggedAgent) ended() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.calls...)
}

type loggingSpawner struct {
	inner  agent.Spawner
	mu     sync.Mutex
	agents []*loggedAgent
}

func (s *loggingSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	ag, err := s.inner.Spawn(o)
	if err != nil {
		return nil, err
	}
	a := &loggedAgent{Agent: ag}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.agents = append(s.agents, a)
	return a, nil
}

func (s *loggingSpawner) last(t *testing.T) *loggedAgent {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.agents) == 0 {
		t.Fatal("nothing spawned")
	}
	return s.agents[len(s.agents)-1]
}

// interruptedThenClosed waits for a's process to be closed and checks it was interrupted first,
// once: Claude ends the shell command of a running tool on the interrupt, not when stdin closes.
func interruptedThenClosed(t *testing.T, when string, a *loggedAgent) {
	t.Helper()
	want := []string{"interrupt", "close"}
	waitFor(t, "subagent closed after "+when, func() bool {
		calls := a.ended()
		return len(calls) > 0 && calls[len(calls)-1] == "close"
	})
	if got := a.ended(); !reflect.DeepEqual(got, want) {
		t.Fatalf("after %s the subagent's process got %v, want %v", when, got, want)
	}
}

// A running app subagent that is stopped gets an interrupt before its process is closed, whatever
// stopped it (T11-F1).
func TestStoppedSubagentInterruptedBeforeClose(t *testing.T) {
	cases := []struct {
		name string
		stop func(t *testing.T, e *env, id string, parent *fakeAgent, sa model.Subagent)
	}{
		{"Interrupt", func(t *testing.T, e *env, id string, _ *fakeAgent, _ model.Subagent) {
			if err := e.m.Interrupt(id); err != nil {
				t.Fatal(err)
			}
		}},
		{"StopSubagent", func(t *testing.T, e *env, id string, _ *fakeAgent, sa model.Subagent) {
			if err := e.m.StopSubagent(id, sa.ID); err != nil {
				t.Fatal(err)
			}
		}},
		{"Stop", func(_ *testing.T, e *env, id string, _ *fakeAgent, _ model.Subagent) { e.m.Stop(id) }},
		{"Delete", func(t *testing.T, e *env, id string, _ *fakeAgent, _ model.Subagent) {
			if err := e.m.Delete(id); err != nil {
				t.Fatal(err)
			}
		}},
		{"the parent's aborted turn", func(t *testing.T, e *env, id string, parent *fakeAgent, _ model.Subagent) {
			e.send(id, "more", "")
			parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
		}},
		{"Shutdown", func(_ *testing.T, e *env, _ string, _ *fakeAgent, _ model.Subagent) { e.m.Shutdown() }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			sp := &loggingSpawner{inner: e.claude}
			e.m.Spawners[model.Claude] = sp
			id, parent := e.idleParent()
			sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
			child := waitChild(t, e.claude, 2)
			logged := sp.last(t)

			tc.stop(t, e, id, parent, sa)
			interruptedThenClosed(t, tc.name, logged)
			if !agentClosed(child) || child.interrupted() != 1 {
				t.Fatalf("the subagent's process: closed %v, %d interrupts", agentClosed(child), child.interrupted())
			}
			if tc.name != "Delete" {
				if s := e.subFile(id, sa.ID); s.Status != model.SubStopped || s.Delivery != model.SubNotOwed {
					t.Fatalf("subagent.json %+v", s)
				}
			}
			e.m.handoffs.Wait()
			if e.claude.count() != 2 {
				t.Fatalf("%d processes: stopping the subagent started one", e.claude.count())
			}
		})
	}
}

// A switch to another branch stops the branch that is left, and the subagent running on it gets
// the interrupt before its close as well.
func TestBranchSwitchInterruptsSubagent(t *testing.T) {
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)

	e.branchTo(id, newAt(3), "aside")
	waitFor(t, "subagent closed after the switch", func() bool { return agentClosed(child) })
	if n := child.interrupted(); n != 1 {
		t.Fatalf("the subagent of the branch that was left got %d interrupts before its close", n)
	}
	if s := e.subFile(id, sa.ID); s.Status != model.SubStopped {
		t.Fatalf("after the switch %+v", s)
	}
}

// A subagent that finished by itself has an idle process; it is closed the same way (an interrupt
// does nothing to an idle process).
func TestFinishedSubagentClosed(t *testing.T) {
	e := newEnv(t)
	sp := &loggingSpawner{inner: e.claude}
	e.m.Spawners[model.Claude] = sp
	id, _ := e.startSpawnParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	logged := sp.last(t)

	child.emit(t, agent.Event{Kind: agent.EvText, Text: "done"}, agent.Event{Kind: agent.EvTurnEnd})
	interruptedThenClosed(t, "its turn ended", logged)
	if s := e.subFile(id, sa.ID); s.Status != model.SubCompleted {
		t.Fatalf("subagent.json %+v", s)
	}
}
