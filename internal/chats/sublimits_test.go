package chats

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/model"
)

// limits gives the chat the subagent settings, as its first message finds them on its meta.
func (e *env) limits(id string, depth, limit int) {
	e.t.Helper()
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	c.meta.Subagents = &model.SubLimits{Depth: depth, Cap: limit}
	c.mu.Unlock()
}

// callerOf is the caller a token resolves to.
func (e *env) callerOf(token string) Caller {
	e.t.Helper()
	c, ok := e.m.ResolveToken(token)
	if !ok {
		e.t.Fatal("the token resolves to no caller")
	}
	return c
}

// subsRunning counts the chat's subagents that run, as its view does.
func (e *env) subsRunning(id string) int {
	e.t.Helper()
	return e.view(id).SubsRunning
}

// A chat whose subagents are off: its agent's process starts without the spawn family, its
// token has none, and a spawn is refused and leaves nothing.
func TestSubDepthOff(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.limits(v.ID, 0, 100)
	e.send(v.ID, "go", "")
	if o := e.claude.last(t).opts; !o.NoSpawn || o.Subagent {
		t.Fatalf("the agent of a chat with subagents off started with %+v", o)
	}
	c := e.callerOf(e.meta(v.ID).Token)
	if c.MaySpawn() || c.Level != 0 || c.Depth != 0 {
		t.Fatalf("caller %+v", c)
	}
	if got := c.NoSpawnText("stop_subagent"); got != "stop_subagent is not available: subagents are off in this chat" {
		t.Fatalf("refusal %q", got)
	}
	_, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "work"})
	var de *SubDepthError
	if !errors.As(err, &de) || de.Depth != 0 || err.Error() != "spawn_subagent is not available: subagents are off in this chat" {
		t.Fatalf("spawn with subagents off: %v", err)
	}
	if len(e.subs(v.ID)) != 0 || e.claude.count() != 1 {
		t.Fatalf("a refused spawn left %d records and %d processes", len(e.subs(v.ID)), e.claude.count())
	}
}

// A chat without stored settings is at depth 1, as every chat was: its agent has the spawn
// family, and its subagent has none.
func TestSubDepthDefault(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	if parent.opts.NoSpawn {
		t.Fatalf("the chat's agent started with %+v", parent.opts)
	}
	if c := e.callerOf(e.meta(id).Token); !c.MaySpawn() || c.Level != 0 || c.Depth != 1 {
		t.Fatalf("the chat's caller %+v", c)
	}
	e.spawn(id, SpawnSubRequest{Prompt: "work"})
	child := waitChild(t, e.claude, 2)
	if !child.opts.NoSpawn || !child.opts.Subagent {
		t.Fatalf("the subagent started with %+v", child.opts)
	}
	c := e.callerOf(child.opts.MCP.Token)
	if c.MaySpawn() || c.Level != 1 || c.Depth != 1 || !c.Subagent {
		t.Fatalf("the subagent's caller %+v", c)
	}
	if got := c.NoSpawnText("spawn_subagent"); got != "spawn_subagent is not available to a subagent at level 1: this chat's subagent depth is 1" {
		t.Fatalf("refusal %q", got)
	}
}

// The cap on running subagents: a spawn at the cap is refused with the cap in its text and
// leaves no record and no process; one that ended or was stopped gives its place back.
func TestSubCap(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.idleParent()
	e.limits(id, 1, 2)
	a := e.spawn(id, SpawnSubRequest{Prompt: "a"})
	first := waitChild(t, e.claude, 2)
	b := e.spawn(id, SpawnSubRequest{Prompt: "b"})
	waitChild(t, e.claude, 3)

	refused := func(when string) {
		t.Helper()
		records, procs := len(e.subs(id)), e.claude.count()
		_, err := e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "one too many"})
		var ce *SubCapError
		if !errors.As(err, &ce) || ce.Cap != 2 || ce.Running != 2 {
			t.Fatalf("%s: spawn at the cap: %v", when, err)
		}
		for _, want := range []string{"cap on running subagents is 2", "not queued", "stop_subagent", "do the work yourself"} {
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("%s: the refusal %q lacks %q", when, err, want)
			}
		}
		if len(e.subs(id)) != records || e.claude.count() != procs || e.subsRunning(id) != 2 {
			t.Fatalf("%s: a refused spawn left %d records, %d processes, %d running", when, len(e.subs(id)), e.claude.count(), e.subsRunning(id))
		}
	}
	refused("two running")

	// One finishes: its place is free, and the next spawn takes it.
	e.finish(first, "done")
	if e.sub(id, a.ID).Status != model.SubCompleted {
		t.Fatalf("the finished subagent: %+v", e.sub(id, a.ID))
	}
	e.spawn(id, SpawnSubRequest{Prompt: "c"})
	waitChild(t, e.claude, 4)
	refused("after one finished and one more started")

	// One is stopped: the same.
	if err := e.m.StopSubagent(id, b.ID); err != nil {
		t.Fatal(err)
	}
	e.spawn(id, SpawnSubRequest{Prompt: "d"})
	waitChild(t, e.claude, 5)
	refused("after one was stopped and one more started")
}

// Spawns that come at once cannot take the last places twice: counting and recording are one
// step.
func TestSubCapConcurrentSpawns(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.idleParent()
	e.limits(id, 1, 3)
	const n = 12
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "work"})
		}()
	}
	wg.Wait()
	started := 0
	for _, err := range errs {
		var ce *SubCapError
		switch {
		case err == nil:
			started++
		case !errors.As(err, &ce):
			t.Fatalf("spawn: %v", err)
		}
	}
	if started != 3 || len(e.subs(id)) != 3 || e.subsRunning(id) != 3 {
		t.Fatalf("%d spawns went through, %d records, %d running; the cap is 3", started, len(e.subs(id)), e.subsRunning(id))
	}
}
