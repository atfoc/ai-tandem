package chats

import (
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

// The shared scripted spawner (agenttest.Fake) drives a real Manager as the adapters do: these
// tests are the proof that the tests of other packages can build on it.

// fakeEnv is an env whose agents of kind are agenttest.Fake processes.
func fakeEnv(t *testing.T, kind model.AgentKind) (*env, *agenttest.Fake) {
	t.Helper()
	e := newEnv(t)
	f := agenttest.New(kind)
	e.m.Spawners[kind] = f
	// No scripted process outlives its test, and none writes into the data folder while it is
	// removed: Stop drops whatever a closing process still says.
	t.Cleanup(func() {
		for _, v := range e.m.Views() {
			e.m.Stop(v.ID)
		}
	})
	return e, f
}

func kindsOf(items []model.Item) string {
	ks := make([]string, len(items))
	for i, it := range items {
		ks[i] = it.Kind
	}
	return strings.Join(ks, " ")
}

// A plain chat turn: the message, a tool item with its result, a text, a clean end with a cost.
func TestFakeDrivesAPlainTurn(t *testing.T) {
	t.Parallel()
	for _, kind := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		t.Run(string(kind), func(t *testing.T) {
			e, f := fakeEnv(t, kind)
			var got *agenttest.Turn
			f.Script(func(tn *agenttest.Turn) {
				got = tn
				tn.Tool("Bash", map[string]any{"command": "ls"}, "a.txt", false)
				tn.Say("done: " + tn.Text)
				tn.Cost(0.01, 30, 30)
			})
			v := e.create(kind, gOne, "")
			e.send(v.ID, "hello", "")
			waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })

			if st := e.view(v.ID).Status; st != model.StatusReady {
				t.Errorf("status %q after a clean turn", st)
			}
			items := e.items(v.ID)
			if kindsOf(items) != "user tool text end" {
				t.Fatalf("items: %s", kindsOf(items))
			}
			if it := items[1]; it.Name != "Bash" || string(it.Input) != `{"command":"ls"}` || it.Result == nil || *it.Result != "a.txt" || it.IsError {
				t.Errorf("tool item: %+v", it)
			}
			if it := items[2]; it.Text != "done: hello" || !it.Done {
				t.Errorf("text item: %+v", it)
			}
			if m := e.meta(v.ID); m.TurnActive || !m.Locked {
				t.Errorf("chat.json after the turn: turnActive %v locked %v", m.TurnActive, m.Locked)
			}
			// The process was started as the manager starts any chat's, and the script saw it.
			sp := f.Spawns()
			if len(sp) != 1 || sp[0].ChatID != v.ID || sp[0].Resume || sp[0].MCP == nil || sp[0].MCP.Token != e.meta(v.ID).Token {
				t.Fatalf("spawns: %+v", sp)
			}
			if got.N != 1 || got.Opts.ChatID != v.ID || got.Text != "hello" {
				t.Errorf("the turn the script saw: n %d chat %s text %q", got.N, got.Opts.ChatID, got.Text)
			}
			if kind == model.Cursor && e.meta(v.ID).SessionID == "" {
				t.Error("a Cursor chat did not get the session id its process reported")
			}

			// A second message goes to the same process.
			e.send(v.ID, "again", "")
			waitFor(t, "the second turn to end", func() bool { return e.view(v.ID).Usage.Turns == 2 })
			if got.N != 2 || len(f.Spawns()) != 1 || f.Live() != 1 {
				t.Errorf("second turn: n %d, %d spawns, %d live", got.N, len(f.Spawns()), f.Live())
			}
		})
	}
}

// A turn that hangs is ended by the manager's Interrupt: a stopped end, the process stays.
func TestFakeHangEndedByInterrupt(t *testing.T) {
	t.Parallel()
	e, f := fakeEnv(t, model.Claude)
	started := make(chan struct{}, 1)
	f.Script(func(tn *agenttest.Turn) {
		tn.Say("working")
		started <- struct{}{}
		tn.Hang()
		tn.Say("never shown")
	})
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "go", "")
	<-started
	waitFor(t, "the chat to be writing", func() bool { return len(e.items(v.ID)) == 2 })
	if !e.m.Busy(v.ID) {
		t.Fatal("the chat is not busy in a hanging turn")
	}
	if err := e.m.Send(v.ID, "too early", "", nil); err != ErrBusy {
		t.Fatalf("Send in the turn: %v", err)
	}
	if err := e.m.Interrupt(v.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	items := e.items(v.ID)
	if kindsOf(items) != "user text note end" || items[2].Text != "Stopped." {
		t.Fatalf("items after the interrupt: %s (%+v)", kindsOf(items), items)
	}
	if e.view(v.ID).Status != model.StatusReady || f.Live() != 1 {
		t.Errorf("status %q, %d live processes", e.view(v.ID).Status, f.Live())
	}
	// The chat takes the next message on the same process.
	f.Script(func(tn *agenttest.Turn) { tn.Say("back") })
	e.send(v.ID, "continue", "")
	waitFor(t, "the next turn to end", func() bool { return e.view(v.ID).Usage.Turns == 2 })
	if items := e.items(v.ID); items[len(items)-2].Text != "back" || len(f.Spawns()) != 1 {
		t.Errorf("after the interrupt: %s, %d spawns", kindsOf(items), len(f.Spawns()))
	}
}

// A process that ends in its turn: the chat shows it stopped, and the next message resumes the
// session on a new process.
func TestFakeExitInTheTurn(t *testing.T) {
	t.Parallel()
	e, f := fakeEnv(t, model.Claude)
	f.Script(func(tn *agenttest.Turn) {
		tn.Say("about to fail")
		tn.Exit("crashed hard")
	})
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "go", "")
	waitFor(t, "the chat to show the exit", func() bool { return e.view(v.ID).Status == model.StatusStopped })
	items := e.items(v.ID)
	if kindsOf(items) != "user text note" || items[2].Text != "The agent stopped: crashed hard" {
		t.Fatalf("items after the exit: %s (%+v)", kindsOf(items), items)
	}
	if f.Live() != 0 || e.m.Busy(v.ID) {
		t.Errorf("%d live processes, busy %v", f.Live(), e.m.Busy(v.ID))
	}
	f.Script(func(tn *agenttest.Turn) { tn.Say("recovered") })
	e.send(v.ID, "again", "")
	waitFor(t, "the turn on the new process to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	sp := f.Spawns()
	if len(sp) != 2 || !sp[1].Resume || sp[1].SessionID != sp[0].SessionID {
		t.Fatalf("spawns: %+v", sp)
	}
	if e.view(v.ID).Status != model.StatusReady || f.Live() != 1 {
		t.Errorf("status %q, %d live", e.view(v.ID).Status, f.Live())
	}
}

// The manager's Stop closes a process in its turn; a failed turn and a failed start show as the
// real adapters' do.
func TestFakeStopFailAndSpawnError(t *testing.T) {
	t.Parallel()
	e, f := fakeEnv(t, model.Pi)
	started, returned := make(chan struct{}), make(chan struct{})
	f.Script(func(tn *agenttest.Turn) { close(started); tn.Hang(); close(returned) })
	v := e.create(model.Pi, gOne, "")
	e.send(v.ID, "go", "")
	<-started // a process closed before its turn began never runs the script
	e.m.Stop(v.ID)
	waitFor(t, "the process to end", func() bool { return f.Live() == 0 })
	<-returned
	if items := e.items(v.ID); kindsOf(items) != "user note" || items[1].Text != "Stopped." {
		t.Fatalf("items after Stop: %s", kindsOf(items))
	}

	f.Script(func(tn *agenttest.Turn) { tn.Fail("the model refused") })
	e.send(v.ID, "again", "")
	waitFor(t, "the failed turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	if items := e.items(v.ID); items[len(items)-2].Kind != "note" || items[len(items)-2].Text != "the model refused" {
		t.Errorf("items after a failed turn: %s", kindsOf(items))
	}

	e.m.Stop(v.ID)
	waitFor(t, "the process to end", func() bool { return f.Live() == 0 })
	f.FailSpawn(agent.ErrFolderMissing)
	if err := e.m.Send(v.ID, "once more", "", nil); err != ErrFolderMissing {
		t.Fatalf("Send with a failing start: %v", err)
	}
	if !e.view(v.ID).FolderMissing {
		t.Error("the chat does not show the failed start")
	}
}
