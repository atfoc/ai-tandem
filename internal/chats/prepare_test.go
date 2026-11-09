package chats

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

// The account's container is made ready (Accounts.Prepare) before a start takes the chat's lock:
// a wait for it, minutes the first time an image is built, holds no lock of the manager, and its
// error refuses the call as an account gate's refusal does.

// promptWait is how long a call that must not wait for Prepare may take.
const promptWait = 5 * time.Second

// prompt runs f and fails the test when it has not returned within promptWait.
func prompt(t *testing.T, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() { defer close(done); f() }()
	select {
	case <-done:
	case <-time.After(promptWait):
		t.Fatalf("%s waited for the account's container", what)
	}
}

// reachedPrepare waits until a Prepare of kind waits in the fake.
func reachedPrepare(t *testing.T, reached <-chan model.AgentKind, kind model.AgentKind) {
	t.Helper()
	select {
	case k := <-reached:
		if k != kind {
			t.Fatalf("Prepare of %q, want %q", k, kind)
		}
	case <-time.After(promptWait):
		t.Fatalf("no Prepare of %q", kind)
	}
}

// result waits for the error a call sends on errc.
func result(t *testing.T, errc <-chan error) error {
	t.Helper()
	select {
	case err := <-errc:
		return err
	case <-time.After(promptWait):
		t.Fatal("the call did not return once Prepare did")
		return nil
	}
}

// While a message on an account waits for its container, the manager is not held: the views, the
// account's work, another chat's message and reads of the waiting chat go on. Once the container
// is ready the message starts the process, once.
func TestPrepareHoldsNoLock(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	e.f.Script(func(tn *agenttest.Turn) { tn.Say("ok") })
	v := e.create(acct, gOne, "")
	w := e.create(model.Claude, gOne, "")
	reached, release := e.acc.holdPrepare()
	defer release()

	errc := make(chan error, 1)
	go func() { errc <- e.m.Send(v.ID, "hello", "", nil) }()
	reachedPrepare(t, reached, acct)

	prompt(t, "Views", func() { e.m.Views() })
	prompt(t, "BusyKind", func() { e.m.BusyKind(acct) })
	prompt(t, "StopKind of another account", func() { e.m.StopKind(acct2) })
	prompt(t, "View of the waiting chat", func() { e.m.View(v.ID) })
	prompt(t, "Items of the waiting chat", func() { e.m.Items(v.ID) })
	prompt(t, "a message to a chat of a fixed kind", func() {
		if err := e.m.Send(w.ID, "hello", "", nil); err != nil {
			t.Errorf("message to the Claude chat: %v", err)
		}
	})
	if e.claude.count() != 1 {
		t.Fatalf("the Claude chat's process: %d spawns", e.claude.count())
	}
	if n := len(e.f.Spawns()); n != 0 {
		t.Fatalf("%d processes started before the container was ready", n)
	}

	release()
	if err := result(t, errc); err != nil {
		t.Fatalf("message once the container is ready: %v", err)
	}
	e.turnsAre(v.ID, 1)
	if n := len(e.f.Spawns()); n != 1 {
		t.Fatalf("%d spawns on the account", n)
	}
	if got := e.acc.preparedKinds(); !slices.Equal(got, []model.AgentKind{acct}) {
		t.Fatalf("Prepare called for %v (a fixed kind's message must not ask)", got)
	}
}

// A container that cannot be made ready refuses the message with its reason, as it came, and the
// message leaves nothing: no item, no start, the draft as it was, nothing shown on the chat.
func TestPrepareFailureRefusesTheMessage(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	e.f.Script(func(tn *agenttest.Turn) { tn.Say("ok") })
	n := e.create(acct, gOne, "")
	if _, _, err := e.m.SetDraft(n.ID, 0, model.Draft{Text: "draft"}); err != nil {
		t.Fatal(err)
	}
	why := errors.New("The image could not be built: no space left on device")
	e.acc.failPrepare(acct, why)

	if err := e.m.Send(n.ID, "draft", "", nil); err != why {
		t.Fatalf("message while the container cannot be made ready: %v, want Prepare's error as it came", err)
	}
	if items := e.items(n.ID); len(items) != 0 || e.meta(n.ID).Locked || e.draftsOf(n.ID)["main"] != "draft" {
		t.Fatalf("the refused message left items %s, locked %v, drafts %v", kindsOf(items), e.meta(n.ID).Locked, e.draftsOf(n.ID))
	}
	if v := e.view(n.ID); v.Status == model.StatusError || v.Status == model.StatusThinking || v.Error != "" {
		t.Fatalf("the refused message shows on the chat: %q %q", v.Status, v.Error)
	}
	if len(e.f.Spawns()) != 0 {
		t.Fatal("a process was started")
	}
	if _, err := e.m.SendToBranch(n.ID, Target{Branch: model.MainBranch, End: true}, "draft", "", nil); err != why {
		t.Fatalf("message to the branch while the container cannot be made ready: %v", err)
	}
	if len(e.items(n.ID)) != 0 || len(e.f.Spawns()) != 0 {
		t.Fatal("the refused message to the branch left something")
	}

	// Once it can, the chat starts.
	e.acc.failPrepare(acct, nil)
	e.send(n.ID, "draft", "")
	e.turnsAre(n.ID, 1)
	if len(e.f.Spawns()) != 1 {
		t.Fatalf("%d spawns", len(e.f.Spawns()))
	}
}

// A fork, a new branch, a subagent, the resume of a subagent and the restart of a fresh fork on an
// account wait for the container before they start anything; a failure refuses them with
// nothing made.
func TestPrepareBeforeForkAndSubagents(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	sp := &fakeSpawner{}
	e.acc.setSpawner(acct, sp)
	v := e.create(acct, gOne, "")
	e.send(v.ID, "one", "")
	sp.last(t).emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	at := len(e.items(v.ID))
	waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Status == model.StatusReady })

	// held calls call while Prepare waits: it must wait in Prepare of acct with nothing started
	// (started is unchanged), and go on to start once released.
	held := func(what string, started func() int, call func() error) {
		t.Helper()
		before := started()
		reached, release := e.acc.holdPrepare()
		defer release()
		errc := make(chan error, 1)
		go func() { errc <- call() }()
		reachedPrepare(t, reached, acct)
		if started() != before {
			t.Fatalf("%s started before the container was ready", what)
		}
		release()
		if err := result(t, errc); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		waitFor(t, what+" to start", func() bool { return started() == before+1 })
	}
	forks := func() int { return len(sp.forkCalls()) }
	spawns := sp.count

	var fork model.ChatView
	held("the fork", forks, func() (err error) {
		fork, err = e.m.Fork(v.ID, ForkReq{Branch: model.MainBranch, At: at})
		return err
	})
	held("the new branch", forks, func() error {
		_, err := e.m.SendToBranch(v.ID, Target{Branch: model.MainBranch, At: at, New: true}, "branch", "", nil)
		return err
	})
	var sa model.Subagent
	held("the subagent", spawns, func() (err error) {
		sa, err = e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "child"})
		return err
	})
	if err := e.m.StopSubagent(v.ID, sa.ID); err != nil {
		t.Fatal(err)
	}
	held("the resume of the subagent", spawns, func() error {
		_, err := e.m.ResumeSubagent(v.ID, sa.ID)
		return err
	})
	w := e.create(model.Claude, gOne, "")
	held("a subagent on the account of a Claude chat", spawns, func() error {
		_, err := e.m.SpawnSubagent(w.ID, SpawnSubRequest{Prompt: "child", Kind: acct})
		return err
	})

	// Refused: nothing is made, nothing started.
	why := errors.New("Docker could not start the container")
	e.acc.failPrepare(acct, why)
	nForks, nSpawns, views, subs := forks(), spawns(), len(e.m.Views()), len(e.subs(v.ID))
	if _, err := e.m.Fork(v.ID, ForkReq{Branch: model.MainBranch, At: at}); err != why {
		t.Fatalf("fork: %v", err)
	}
	if _, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "child"}); err != why {
		t.Fatalf("subagent: %v", err)
	}
	if err := e.m.StopSubagent(v.ID, sa.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.ResumeSubagent(v.ID, sa.ID); err != why {
		t.Fatalf("resume: %v", err)
	}
	if s := e.subFile(v.ID, sa.ID); s.Status != model.SubStopped {
		t.Fatalf("the refused resume changed the subagent: %+v", s)
	}
	if err := e.m.Configure(fork.ID, ConfigReq{Model: "opus"}); err != why {
		t.Fatalf("the fresh fork's model change: %v", err)
	}
	if e.view(fork.ID).Model == "opus" || sp.lastFork(t).isClosed() {
		t.Fatal("the refused model change changed the fork")
	}
	if forks() != nForks || spawns() != nSpawns || len(e.m.Views()) != views || len(e.subs(v.ID)) != subs {
		t.Fatalf("refused calls left: %d forks (was %d), %d spawns (was %d), %d chats (was %d), %d subagents (was %d)",
			forks(), nForks, spawns(), nSpawns, len(e.m.Views()), views, len(e.subs(v.ID)), subs)
	}
}

// Shutdown does not wait for a message that waits for the container, and the message, once the
// container is ready, is refused with ErrShutdown and starts nothing.
func TestShutdownDuringPrepare(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	v := e.create(acct, gOne, "")
	reached, release := e.acc.holdPrepare()
	defer release()
	errc := make(chan error, 1)
	go func() { errc <- e.m.Send(v.ID, "hello", "", nil) }()
	reachedPrepare(t, reached, acct)

	prompt(t, "Shutdown", e.m.Shutdown)
	release()
	if err := result(t, errc); !errors.Is(err, ErrShutdown) {
		t.Fatalf("message after Shutdown: %v", err)
	}
	if len(e.f.Spawns()) != 0 || len(e.items(v.ID)) != 0 {
		t.Fatalf("after Shutdown: %d spawns, items %s", len(e.f.Spawns()), kindsOf(e.items(v.ID)))
	}
	// Once down, nothing more asks for a container.
	if err := e.m.Send(v.ID, "again", "", nil); !errors.Is(err, ErrShutdown) {
		t.Fatalf("message once down: %v", err)
	}
	if got := e.acc.preparedKinds(); len(got) != 1 {
		t.Fatalf("Prepare called %d times", len(got))
	}
}

// A retry's attempt on an account makes the container ready first: when it cannot be, the attempt
// could not start, which shows as a failed start of the chat's agent, or fails the subagent.
func TestPrepareFailureFailsARetry(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	fastRetries(e.env)
	why := errors.New("Docker could not start the container")
	e.f.Script(func(tn *agenttest.Turn) {
		if strings.Contains(tn.Text, "flaky") {
			e.acc.failPrepare(acct, why) // before the attempt
			tn.FailTemp(agent.TempOverloaded, "Overloaded")
		}
	})

	v := e.create(acct, gOne, "")
	e.send(v.ID, "flaky", "")
	waitFor(t, "the attempt to fail", func() bool { return e.view(v.ID).Status == model.StatusError })
	if got := e.view(v.ID); got.Error != why.Error() || len(spawnsOf(e.f, v.ID)) != 1 || e.meta(v.ID).TurnActive {
		t.Fatalf("after the attempt: error %q, %d spawns, turn active %v", got.Error, len(spawnsOf(e.f, v.ID)), e.meta(v.ID).TurnActive)
	}

	e.acc.failPrepare(acct, nil)
	w := e.create(model.Claude, gOne, "")
	sa := e.spawn(w.ID, SpawnSubRequest{Prompt: "flaky", Kind: acct})
	waitFor(t, "the subagent to fail", func() bool { return e.subFile(w.ID, sa.ID).Status == model.SubFailed })
	if s := e.subFile(w.ID, sa.ID); !strings.Contains(s.Error, why.Error()) || len(spawnsOf(e.f, w.ID+"/subagents/"+sa.ID)) != 1 {
		t.Fatalf("subagent after the attempt: %+v, %d spawns", s, len(spawnsOf(e.f, w.ID+"/subagents/"+sa.ID)))
	}
}
