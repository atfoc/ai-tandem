package boardapi

import (
	"os"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

type fakeAgent struct {
	opts agent.SpawnOptions
	ch   chan agent.Event

	mu     sync.Mutex
	sends  [][]agent.ContentBlock
	closed bool
}

func (a *fakeAgent) Events() <-chan agent.Event { return a.ch }

func (a *fakeAgent) Send(b []agent.ContentBlock) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.sends = append(a.sends, b)
	return nil
}

func (a *fakeAgent) Interrupt() error { return nil }

func (a *fakeAgent) Decide(string, bool) error { return nil }

func (a *fakeAgent) Close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
}

func (a *fakeAgent) sent() [][]agent.ContentBlock {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([][]agent.ContentBlock(nil), a.sends...)
}

func (a *fakeAgent) isClosed() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closed
}

// syncEv is ignored by both the pump and the transcript. Sending it after an event proves the
// pump has finished with that event (the channel is unbuffered).
var syncEv = agent.Event{Kind: agent.EvToolInputDelta, ToolID: "__sync__"}

func (a *fakeAgent) emit(t *testing.T, evs ...agent.Event) {
	t.Helper()
	for _, ev := range append(evs, syncEv) {
		select {
		case a.ch <- ev:
		case <-time.After(5 * time.Second):
			t.Fatalf("pump did not take event %v", ev.Kind)
		}
	}
}

type fakeSpawner struct {
	mu     sync.Mutex
	agents []*fakeAgent
}

func (s *fakeSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if _, err := os.Stat(o.Cwd); err != nil {
		return nil, agent.ErrFolderMissing
	}
	a := &fakeAgent{opts: o, ch: make(chan agent.Event)}
	s.mu.Lock()
	s.agents = append(s.agents, a)
	s.mu.Unlock()
	return a, nil
}

func (s *fakeSpawner) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.agents)
}

func (s *fakeSpawner) last(t *testing.T) *fakeAgent {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.agents) == 0 {
		t.Fatal("nothing spawned")
	}
	return s.agents[len(s.agents)-1]
}

func (s *fakeSpawner) at(t *testing.T, i int) *fakeAgent {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if i < 0 || i >= len(s.agents) {
		t.Fatalf("agent %d of %d", i, len(s.agents))
	}
	return s.agents[i]
}

type gatedSpawner struct {
	inner agent.Spawner
	enter chan struct{}
	gate  chan struct{}
}

func (s *gatedSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	s.enter <- struct{}{}
	<-s.gate
	return s.inner.Spawn(o)
}
