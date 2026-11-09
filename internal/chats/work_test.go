package chats

import (
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

// accountsWork is what the accounts need of the chat manager (aliases.Work, which this package
// must not import): AccountWork has it.
type accountsWork interface {
	Busy(a model.AgentKind) int
	StopKind(a model.AgentKind)
}

var _ accountsWork = AccountWork{}

// Busy counts the chat objects of a kind that work, each by its own kind: a turn running, a
// subagent of the kind in a chat of another agent, background work awaited; not an idle process
// nor another kind. StopKind ends every process of the kind, working or idle, and returns once
// they are gone; the chats resume on their next message, and a subagent shows stopped.
func TestBusyAndStopKind(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	e.f.Script(func(tn *agenttest.Turn) {
		if strings.Contains(tn.Text, "hang") {
			tn.Hang()
			return
		}
		tn.Say("ok")
	})
	w := e.m.AccountWork()
	busyIs := func(what string, a model.AgentKind, n int) {
		t.Helper()
		waitFor(t, what, func() bool { return w.Busy(a) == n })
	}

	idle := e.create(acct, gOne, "")
	e.send(idle.ID, "hello", "")
	e.turnsAre(idle.ID, 1)
	if e.f.Live() != 1 || w.Busy(acct) != 0 {
		t.Fatalf("an idle process: %d live, busy %d", e.f.Live(), w.Busy(acct))
	}

	working := e.create(acct, gOne, "")
	e.send(working.ID, "hang on", "")
	busyIs("the turn to count", acct, 1)

	host := e.create(model.Claude, gOne, "")
	e.send(host.ID, "go", "") // its fakeAgent stays in the turn
	sa := e.spawn(host.ID, SpawnSubRequest{Prompt: "hang there", Kind: acct})
	busyIs("the subagent to count", acct, 2)
	if got := w.Busy(model.Claude); got != 1 {
		t.Fatalf("Claude's busy %d, want its one chat", got)
	}
	if got := w.Busy(acct2); got != 0 {
		t.Fatalf("the other account's busy %d", got)
	}

	w.StopKind(acct)
	if n := e.f.Live(); n != 0 {
		t.Fatalf("%d processes of the account left after StopKind", n)
	}
	if got := w.Busy(acct); got != 0 {
		t.Fatalf("busy %d after StopKind", got)
	}
	if s := e.subFile(host.ID, sa.ID); s.Status != model.SubStopped || s.Cause != model.CausePerson {
		t.Fatalf("the subagent after StopKind: %+v", s)
	}
	if e.claude.last(t).isClosed() || w.Busy(model.Claude) != 1 {
		t.Fatal("StopKind of the account touched the computer's Claude")
	}
	if items := e.items(working.ID); items[len(items)-1].Kind != "note" || items[len(items)-1].Text != "Stopped." {
		t.Fatalf("the working chat after StopKind: %s", kindsOf(items))
	}
	if items := e.items(idle.ID); kindsOf(items) != "user text end" {
		t.Fatalf("the idle chat after StopKind: %s", kindsOf(items))
	}

	// Both chats resume on their next message.
	for _, id := range []string{working.ID, idle.ID} {
		before := e.view(id).Usage.Turns
		e.send(id, "again", "")
		e.turnsAre(id, before+1)
		if o := spawnsOf(e.f, id); len(o) != 2 || !o[1].Resume || o[1].SessionID != o[0].SessionID {
			t.Fatalf("the restart of %s: %+v", id, o)
		}
	}
}

// A chat on an account that waits on its background work counts as working, and an idle chat
// with a working subagent of another agent does not count for the account.
func TestBusyCountsBackgroundWork(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	sp := &fakeSpawner{}
	e.acc.setSpawner(acct2, sp)
	v := e.create(acct2, gOne, "")
	e.send(v.ID, "start a server", "")
	ag := sp.last(t)
	ag.emit(t, agent.Event{Kind: agent.EvThinking},
		agent.Event{Kind: agent.EvTurnEnd, Background: agent.Background{Running: 1}})
	if st := e.view(v.ID).Status; st != model.StatusWaiting {
		t.Fatalf("status %q, want waiting", st)
	}
	if got := e.m.AccountWork().Busy(acct2); got != 1 {
		t.Fatalf("busy %d while it waits on background work", got)
	}
	// The work ends and the turn that reads its notice ends cleanly: the chat rests.
	ag.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd})
	if st := e.view(v.ID).Status; st != model.StatusReady {
		t.Fatalf("status %q, want ready", st)
	}
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "on Claude", Kind: model.Claude})
	waitFor(t, "the subagent's process", func() bool { return e.claude.count() == 1 })
	if got := e.m.AccountWork().Busy(acct2); got != 0 {
		t.Fatalf("busy %d for an idle chat whose subagent runs on Claude", got)
	}
	if got := e.m.AccountWork().Busy(model.Claude); got != 1 || e.subFile(v.ID, sa.ID).Status != model.SubRunning {
		t.Fatalf("Claude's busy %d", got)
	}
}
