package main

import (
	"errors"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

func TestContainerMCPURL(t *testing.T) {
	for port, want := range map[int]string{
		boardapi.MCPPort: "http://host.docker.internal:6006/mcp",
		41234:            "http://host.docker.internal:41234/mcp",
	} {
		if got := containerMCPURL(port); got != want {
			t.Errorf("containerMCPURL(%d) = %q, want %q", port, got, want)
		}
	}
}

func TestAliasClaude(t *testing.T) {
	t.Setenv("AIWB_TEST_ALIAS_CLAUDE", "")
	if got := aliasClaude(); got != "claude" {
		t.Errorf("without the variable: %q, want claude", got)
	}
	t.Setenv("AIWB_TEST_ALIAS_CLAUDE", " /tmp/fake claude ")
	if got := aliasClaude(); got != "/tmp/fake claude" {
		t.Errorf("with the variable: %q, want /tmp/fake claude", got)
	}
}

// usageWorld is the state an accountsUsage of a test reads: Docker, the containers' states, and
// the fetches made.
type usageWorld struct {
	mu      sync.Mutex
	docker  error
	states  map[model.AgentKind]string
	fetches map[model.AgentKind]int
}

func (w *usageWorld) usage() *accountsUsage {
	return &accountsUsage{
		docker: func() error { w.mu.Lock(); defer w.mu.Unlock(); return w.docker },
		state: func(kind model.AgentKind) (string, bool) {
			w.mu.Lock()
			defer w.mu.Unlock()
			s, ok := w.states[kind]
			return s, ok
		},
		fetch: func(kind model.AgentKind) (model.PlanUsage, error) {
			w.mu.Lock()
			defer w.mu.Unlock()
			w.fetches[kind]++
			return model.PlanUsage{FetchedAt: time.Now()}, nil
		},
	}
}

func (w *usageWorld) set(f func()) { w.mu.Lock(); defer w.mu.Unlock(); f() }

func TestAccountsUsage(t *testing.T) {
	work, home := model.AliasKind("a_work0001"), model.AliasKind("a_home0001")
	w := &usageWorld{
		states:  map[model.AgentKind]string{work: aliases.ContainerRunning, home: aliases.ContainerStopped},
		fetches: map[model.AgentKind]int{},
	}
	u := w.usage()

	// No usage call for a kind that is no account, nor for a removed account.
	if u.For(model.Claude) != nil || u.For(model.Cursor) != nil {
		t.Error("a kind that is no account has a usage call")
	}
	if u.For(model.AliasKind("a_gone0001")) != nil {
		t.Error("an account that is not there has a usage call")
	}

	// A running container: read once, then from the cache for a minute; fresh reads again.
	get := u.For(work)
	if get == nil {
		t.Fatal("no usage call for a running account")
	}
	for range 2 {
		if _, err := get(false); err != nil {
			t.Fatalf("usage of a running account: %v", err)
		}
	}
	if _, err := u.For(work)(true); err != nil {
		t.Fatalf("fresh usage: %v", err)
	}
	if n := w.fetches[work]; n != 2 {
		t.Errorf("fetches of the running account = %d, want 2 (one cached read, one fresh)", n)
	}

	// A stopped container: refused, and nothing is read (no container is started for it).
	if _, err := u.For(home)(false); !errors.Is(err, aliases.ErrStopped) {
		t.Errorf("usage of a stopped account: %v, want %v", err, aliases.ErrStopped)
	}
	for _, s := range []string{aliases.ContainerNone, aliases.ContainerPreparing, aliases.ContainerError} {
		w.set(func() { w.states[home] = s })
		if _, err := u.For(home)(true); !errors.Is(err, aliases.ErrStopped) {
			t.Errorf("usage of an account whose container is %s: %v, want %v", s, err, aliases.ErrStopped)
		}
	}
	if n := w.fetches[home]; n != 0 {
		t.Errorf("fetches of the account that does not run = %d, want 0", n)
	}

	// Docker unavailable: its reason, even with a fresh cache.
	why := &container.Unavailable{Kind: container.NotRunning, Reason: "Docker is not running"}
	w.set(func() { w.docker = why })
	if _, err := get(false); !errors.Is(err, why) {
		t.Errorf("usage without Docker: %v, want Docker's reason", err)
	}
	w.set(func() { w.docker = nil })

	// An account removed after its call was given: refused as removed.
	w.set(func() { delete(w.states, work) })
	if _, err := get(false); !errors.Is(err, aliases.ErrRemoved) {
		t.Errorf("usage of a removed account: %v, want %v", err, aliases.ErrRemoved)
	}
	if u.For(work) != nil {
		t.Error("a removed account still has a usage call")
	}
}
