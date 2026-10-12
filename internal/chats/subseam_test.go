package chats

import (
	"errors"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// The settings as a change of them stores them (Configure) are what the chat's process starts
// with and what a spawn is checked against: off gives a process without the spawn family and a
// refused spawn; depth 2 with a cap of 2 gives level 1 the family, level 2 none, and refuses a
// third subagent.
func TestSubSettingsReachTheProcessAndTheSpawn(t *testing.T) {
	t.Parallel()
	e := newEnv(t)

	off := e.create(model.Claude, gOne, "")
	e.configure(off.ID, ConfigReq{SubDepth: numPtr(0)})
	e.send(off.ID, "hello", "")
	e.m.naming.Wait()
	pa := e.claude.last(t)
	if !pa.opts.NoSpawn || e.callerOf(pa.opts.MCP.Token).MaySpawn() {
		t.Fatalf("a chat set to off started with %+v", pa.opts)
	}
	var de *SubDepthError
	if _, err := e.m.SpawnSubagent(off.ID, SpawnSubRequest{Prompt: "x"}); !errors.As(err, &de) {
		t.Fatalf("a spawn at depth off: %v", err)
	}

	deep := e.create(model.Claude, gOne, "")
	e.configure(deep.ID, ConfigReq{SubDepth: numPtr(2), SubCap: numPtr(2)})
	e.send(deep.ID, "hello", "")
	e.m.naming.Wait()
	if top := e.claude.last(t); top.opts.NoSpawn {
		t.Fatalf("the agent of a chat at depth 2 started without the spawn family")
	}
	a, pA := e.child(deep.ID, "", "one")
	if pA.opts.NoSpawn || !e.callerOf(pA.opts.MCP.Token).MaySpawn() {
		t.Fatalf("level 1 at depth 2: %+v", pA.opts)
	}
	if _, pB := e.child(deep.ID, a.ID, "two"); !pB.opts.NoSpawn {
		t.Fatalf("level 2 at depth 2: %+v", pB.opts)
	}
	var ce *SubCapError
	if _, err := e.m.SpawnSubagent(deep.ID, SpawnSubRequest{Prompt: "three"}); !errors.As(err, &ce) || ce.Cap != 2 {
		t.Fatalf("a third subagent at a cap of 2: %v", err)
	}
}

// A fork and a branch of a chat whose depth is off start their processes without the spawn
// family, and a spawn in them is refused: they carry the settings of their source.
func TestSubSettingsOfACopyReachItsProcess(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.configure(v.ID, ConfigReq{SubDepth: numPtr(0)})
	a := e.turn(v.ID, nil, 1)
	e.turn(v.ID, a, 2)
	e.m.naming.Wait()

	var de *SubDepthError
	fork := e.fork(v.ID, 3)
	if fa := e.claude.lastFork(t); !fa.opts.NoSpawn {
		t.Errorf("the fork started with the spawn family: %+v", fa.opts)
	}
	if _, err := e.m.SpawnSubagent(fork.ID, SpawnSubRequest{Prompt: "x"}); !errors.As(err, &de) {
		t.Errorf("a spawn in the fork: %v", err)
	}
	_, bid, ba := e.branchTo(v.ID, newAt(3), "aside")
	if !ba.opts.NoSpawn {
		t.Errorf("the branch started with the spawn family: %+v", ba.opts)
	}
	if _, err := e.m.SpawnSubagent(bid, SpawnSubRequest{Prompt: "x"}); !errors.As(err, &de) {
		t.Errorf("a spawn in the branch: %v", err)
	}
}

// While a chat's first message may have arrived on its server, its subagent settings are fixed
// like its server and its agent: the chat may be running there with what it was sent with.
func TestSubSettingsAreFixedWhileTheStartIsUnconfirmed(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	v := e.newChat(NewChat{Group: gOne})
	e.configure(v.ID, ConfigReq{Server: entB, SubDepth: numPtr(2)})
	if err := e.m.SetRemoteStart(v.ID, model.RemoteUnconfirmed); err != nil {
		t.Fatal(err)
	}
	sticky := e.stickySub(gOne, keyB)
	if err := e.m.Configure(v.ID, ConfigReq{SubDepth: numPtr(0), SubCap: numPtr(5)}); !errors.Is(err, ErrStartUnconfirmed) {
		t.Fatalf("a change of the settings: %v, want ErrStartUnconfirmed", err)
	}
	e.subIs("after the refusal", v.ID, model.SubLimits{Depth: 2, Cap: model.DefaultSubCap})
	if now := e.stickySub(gOne, keyB); (now == nil) != (sticky == nil) || now != nil && *now != *sticky {
		t.Fatalf("the refused change was recorded: %+v, was %+v", now, sticky)
	}
}

// Every way a waiting subagent at level 1 can end takes the levels below it: all processes are
// closed, their tokens no longer resolve, none is left running or waiting, and no result stays
// owed to a subagent that has ended.
func TestWaitingChainEndsWhole(t *testing.T) {
	t.Parallel()
	type ending struct {
		name    string
		end     func(e *env, id string, parent, pa *fakeAgent, a model.Subagent)
		deleted bool
	}
	cases := []ending{
		{"stop_subagent by the chat's agent", func(e *env, id string, _, _ *fakeAgent, a model.Subagent) {
			if err := e.m.StopSubagent(id, a.ID); err != nil {
				e.t.Fatal(err)
			}
		}, false},
		{"interrupt", func(e *env, id string, _, _ *fakeAgent, _ model.Subagent) { _ = e.m.Interrupt(id) }, false},
		{"stop", func(e *env, id string, _, _ *fakeAgent, _ model.Subagent) { e.m.Stop(id) }, false},
		{"shutdown", func(e *env, _ string, _, _ *fakeAgent, _ model.Subagent) { e.m.Shutdown() }, false},
		{"delete", func(e *env, id string, _, _ *fakeAgent, _ model.Subagent) {
			if err := e.m.Delete(id); err != nil {
				e.t.Fatal(err)
			}
		}, true},
		{"its process exits", func(e *env, _ string, _, pa *fakeAgent, _ model.Subagent) {
			pa.emit(e.t, agent.Event{Kind: agent.EvExit})
		}, false},
		{"a turn of its own ends with an error", func(e *env, _ string, _, pa *fakeAgent, _ model.Subagent) {
			pa.emit(e.t, agent.Event{Kind: agent.EvText, Text: "again"}, agent.Event{Kind: agent.EvTurnEnd, Error: "overloaded"})
		}, false},
		{"the chat's agent exits", func(e *env, _ string, parent, _ *fakeAgent, _ model.Subagent) {
			parent.emit(e.t, agent.Event{Kind: agent.EvExit})
		}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t)
			id, parent := e.nested(3)
			a, pa := e.child(id, "", "level one")
			b, pb := e.child(id, a.ID, "level two")
			_, pc := e.child(id, b.ID, "level three")
			e.finish(pb, "b waits")
			e.finish(pa, "a waits")
			if !e.sub(id, a.ID).Waiting || !e.sub(id, b.ID).Waiting {
				t.Fatalf("levels 1 and 2 do not wait: %+v, %+v", e.sub(id, a.ID), e.sub(id, b.ID))
			}
			c.end(e, id, parent, pa, a)
			e.m.handoffs.Wait()
			closed(t, "all three processes", pa, pb, pc)
			for i, ag := range []*fakeAgent{pa, pb, pc} {
				if !e.revoked(ag) {
					t.Errorf("the token of level %d still resolves", i+1)
				}
			}
			if c.deleted {
				return
			}
			for _, s := range e.subs(id) {
				if s.Status == model.SubRunning || s.Waiting {
					t.Errorf("still running: %+v", s)
				}
				if s.Parent != "" && s.Delivery.Owed() {
					t.Errorf("a result is owed to a subagent that has ended: %+v", s)
				}
			}
			if n := e.view(id).SubsRunning; n != 0 {
				t.Errorf("%d subagents count as running", n)
			}
		})
	}
}

// The cap is counted per branch: a subagent that runs on main does not count on a branch of the
// chat, which has the same cap for its own.
func TestSubCapIsPerBranch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.configure(v.ID, ConfigReq{SubCap: numPtr(1)})
	a := e.turn(v.ID, nil, 1)
	e.turn(v.ID, a, 2)
	e.m.naming.Wait()

	var ce *SubCapError
	e.spawn(v.ID, SpawnSubRequest{Prompt: "on main"})
	if _, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "a second on main"}); !errors.As(err, &ce) || ce.Cap != 1 {
		t.Fatalf("a second subagent on main at a cap of 1: %v", err)
	}
	_, bid, _ := e.branchTo(v.ID, newAt(3), "aside")
	if _, err := e.m.SpawnSubagent(bid, SpawnSubRequest{Prompt: "on the branch"}); err != nil {
		t.Fatalf("a subagent on the branch while one runs on main: %v", err)
	}
	if _, err := e.m.SpawnSubagent(bid, SpawnSubRequest{Prompt: "a second on the branch"}); !errors.As(err, &ce) || ce.Cap != 1 {
		t.Fatalf("a second subagent on the branch at a cap of 1: %v", err)
	}
}
