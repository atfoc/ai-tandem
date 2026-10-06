package chats

import (
	"bytes"
	"errors"
	"os"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// The "Stopped." note of a branch that is stopped while it waits on its subagents: no turn of its
// agent runs, so the note is all that says in its thread why a subagent's card reads "Stopped".

// ---- fixtures -------------------------------------------------------------

// waiting gives the chat object with server id id, the idle current branch of its chat, a running
// app subagent.
func (e *env) waiting(id string) (model.Subagent, *fakeAgent) {
	e.t.Helper()
	n := e.claude.count()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "runs on"})
	child := waitChild(e.t, e.claude, n+1)
	chat, _ := splitID(id)
	if s := e.subFile(id, sa.ID); e.m.Busy(chat) || s.Status != model.SubRunning {
		e.t.Fatalf("not idle with a running subagent: %+v", s)
	}
	return sa, child
}

// stopNotes is the muted notes of the thread of the chat object with server id id. The thread is
// read from its items.jsonl, and what the app serves for that branch has to be the same.
func (e *env) stopNotes(id string) []string {
	e.t.Helper()
	items := e.diskItems(id)
	chat, b := splitID(id)
	if b == "" {
		b = model.MainBranch
	}
	_, _, served, _, err := e.m.ItemsOf(chat, b)
	if err != nil {
		e.t.Fatal(err)
	}
	if !reflect.DeepEqual(notes(served, "muted"), notes(items, "muted")) {
		e.t.Fatalf("the notes served %q, on disk %q", notes(served, "muted"), notes(items, "muted"))
	}
	return notes(items, "muted")
}

// noted fails unless the thread of the chat object id ends with its only muted note, "Stopped.".
func (e *env) noted(when, id string) {
	e.t.Helper()
	items := e.diskItems(id)
	if n := e.stopNotes(id); len(n) != 1 || n[0] != "Stopped." || items[len(items)-1].Kind != "note" {
		e.t.Fatalf("%s: notes %q, the thread ends with %+v", when, n, items[len(items)-1])
	}
}

// unnoted fails unless the thread of the chat object id has no muted note.
func (e *env) unnoted(when, id string) {
	e.t.Helper()
	if n := e.stopNotes(id); len(n) != 0 {
		e.t.Fatalf("%s: notes %q", when, n)
	}
}

// stoppedUnowed fails unless the subagent sid of the chat object id was stopped and nothing of it
// is owed to its parent: its process is closed, and no turn was started for it.
func (e *env) stoppedUnowed(id, sid string, child *fakeAgent) {
	e.t.Helper()
	waitFor(e.t, "the subagent closed", func() bool { return agentClosed(child) })
	e.m.handoffs.Wait()
	if s := e.subFile(id, sid); s.Status != model.SubStopped || s.Delivery != model.SubNotOwed {
		e.t.Fatalf("subagent.json %+v", s)
	}
	if rows := resultRows(e.diskItems(id)); len(rows) != 0 {
		e.t.Fatalf("result rows %v", rows)
	}
}

// branchWaiting is a chat with two turns on main and a branch from its first turn's end that is
// current and has finished one turn of its own: six items, the last its end mark.
func (e *env) branchWaiting() (id, b, bid string, branchAg *fakeAgent) {
	e.t.Helper()
	id, _ = e.talked(model.Claude, "", 2)
	b, bid, branchAg = e.branchTo(id, newAt(3), "aside")
	branchAg.emit(e.t, reply("b1")...)
	return id, b, bid, branchAg
}

// ---- a Send that leaves the branch ----------------------------------------

func TestNewBranchNotesTheStoppedSubagents(t *testing.T) {
	for name, at := range map[string]int{"at an earlier point": 3, "from the start": 0, "at the end": 6} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			id, mainAg := e.talked(model.Claude, "", 2)
			sa, child := e.waiting(id)
			evs := e.listen()

			_, bid, _ := e.branchTo(id, Target{Branch: model.MainBranch, At: at, New: true}, "another way")
			if !mainAg.isClosed() {
				t.Fatal("the branch left still runs")
			}
			e.stoppedUnowed(id, sa.ID, child)
			e.noted("the branch left", id)
			if got := e.diskItems(id); len(got) != 7 {
				t.Fatalf("the items of the branch left %+v", got)
			}
			e.unnoted("the new branch", bid)
			// Clients are told, and of that branch.
			var told bool
			for _, ev := range ofType(evs.drain(t, e.br), "chat_items") {
				for _, u := range updatesOf(t, ev) {
					if u.Item.Kind == "note" && u.Item.Text == "Stopped." {
						told = ev["chat"] == id && ev["branch"] == model.MainBranch
					}
				}
			}
			if !told {
				t.Fatal("clients were not sent the note of the branch left")
			}
		})
	}
}

func TestCarryOnNotesTheStoppedSubagents(t *testing.T) {
	e := newEnv(t)
	id, b, bid, branchAg := e.branchWaiting()
	sa, child := e.waiting(bid)
	mainItems := e.file(id, "items.jsonl")

	e.sendTo(id, mainAt(6), "back on main")
	if e.cur(id) != model.MainBranch || !branchAg.isClosed() {
		t.Fatalf("current %q, the branch left closed %v", e.cur(id), branchAg.isClosed())
	}
	e.stoppedUnowed(bid, sa.ID, child)
	e.noted("the branch left", bid)
	if got := e.diskItems(bid); len(got) != 7 {
		t.Fatalf("the items of the branch left %+v", got)
	}
	// The branch carried on has the message and nothing else.
	e.unnoted("the branch carried on", id)
	if got := e.diskItems(id); len(got) != 7 || got[6].Text != "back on main" || !bytes.HasPrefix(e.file(id, "items.jsonl"), mainItems) {
		t.Fatalf("main's items %+v", got)
	}
	if rec, _ := e.treeFile(id); len(rec.Branches) != 1 || rec.Branches[0].ID != b {
		t.Fatalf("tree record %+v", rec)
	}
}

// A branch left that waits on nothing is stopped without a word, as before.
func TestBranchLeftIdleGetsNoNote(t *testing.T) {
	t.Run("a new branch", func(t *testing.T) {
		e := newEnv(t)
		id, _ := e.talked(model.Claude, "", 2)
		mainItems := e.file(id, "items.jsonl")
		_, bid, _ := e.branchTo(id, newAt(3), "aside")
		e.unnoted("the branch left", id)
		e.unnoted("the new branch", bid)
		if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) {
			t.Fatal("the thread of the branch left changed")
		}
	})

	t.Run("a carry-on", func(t *testing.T) {
		e := newEnv(t)
		id, _, bid, _ := e.branchWaiting()
		branchItems := e.file(bid, "items.jsonl")
		e.sendTo(id, mainAt(6), "back on main")
		e.unnoted("the branch left", bid)
		e.unnoted("the branch carried on", id)
		if !bytes.Equal(e.file(bid, "items.jsonl"), branchItems) {
			t.Fatal("the thread of the branch left changed")
		}
	})

	// Its subagent was stopped before, by its own Stop: nothing is stopped by leaving.
	t.Run("a subagent that ended before", func(t *testing.T) {
		e := newEnv(t)
		id, _ := e.talked(model.Claude, "", 2)
		sa, child := e.waiting(id)
		if err := e.m.StopSubagent(id, sa.ID); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "the subagent closed", func() bool { return agentClosed(child) })
		mainItems := e.file(id, "items.jsonl")
		e.branchTo(id, newAt(3), "aside")
		e.unnoted("the branch left", id)
		if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) {
			t.Fatal("the thread of the branch left changed")
		}
	})
}

// A carry-on whose target fails to start leaves the chat on the branch the user was on, which is
// not stopped: its subagent runs on and nothing is noted.
func TestFailedCarryOnNotesNothing(t *testing.T) {
	e := newEnv(t)
	id, b, bid, branchAg := e.branchWaiting()
	sa, child := e.waiting(bid)
	branchItems := e.file(bid, "items.jsonl")

	// Main's process was stopped when the branch became current; its folder is gone.
	cwd := e.meta(id).Cwd
	if err := os.Rename(cwd, cwd+".gone"); err != nil {
		t.Fatal(err)
	}
	if err := e.m.SendTo(id, mainAt(6), "back on main", "", nil); !errors.Is(err, agent.ErrFolderMissing) {
		t.Fatalf("SendTo with main's folder gone: %v", err)
	}
	e.m.handoffs.Wait()
	if e.cur(id) != b || branchAg.isClosed() || branchAg.interrupted() != 0 {
		t.Fatalf("current %q, the branch's process closed %v", e.cur(id), branchAg.isClosed())
	}
	if s := e.subFile(bid, sa.ID); s.Status != model.SubRunning || agentClosed(child) {
		t.Fatalf("the subagent was stopped: %+v", s)
	}
	e.unnoted("the branch the chat stays on", bid)
	e.unnoted("the branch that did not start", id)
	if !bytes.Equal(e.file(bid, "items.jsonl"), branchItems) {
		t.Fatal("the thread of the branch the chat stays on changed")
	}

	// With the folder back the same Send moves, and then the branch is left.
	if err := os.Rename(cwd+".gone", cwd); err != nil {
		t.Fatal(err)
	}
	e.sendTo(id, mainAt(6), "back on main")
	e.stoppedUnowed(bid, sa.ID, child)
	e.noted("the branch left", bid)
	e.unnoted("the branch carried on", id)
}

// ---- Stop -----------------------------------------------------------------

// A branch with an open turn is not left by a Send (ErrBusy); the chat's Stop ends it. Its thread
// gets one note for the turn and its subagents together.
func TestStopWithTurnOpenNotesOnce(t *testing.T) {
	// turnOpen is a chat whose branch is current and in its first turn.
	turnOpen := func(e *env) (id, bid string, branchAg *fakeAgent) {
		e.t.Helper()
		id, _ = e.talked(model.Claude, "", 2)
		_, bid, branchAg = e.branchTo(id, newAt(3), "aside")
		if !e.m.Busy(id) {
			e.t.Fatal("the branch's turn is not open")
		}
		return id, bid, branchAg
	}
	refused := func(e *env, id, bid string) {
		e.t.Helper()
		if err := e.sendToErr(id, mainAt(6)); !errors.Is(err, ErrBusy) {
			e.t.Fatalf("a Send to another branch while the chat is busy: %v", err)
		}
		e.unnoted("after the refused Send", bid)
	}

	t.Run("no subagent", func(t *testing.T) {
		e := newEnv(t)
		id, bid, branchAg := turnOpen(e)
		refused(e, id, bid)
		e.m.Stop(id)
		if !branchAg.isClosed() {
			t.Fatal("the branch's process is not closed")
		}
		e.noted("after Stop", bid)
		e.unnoted("the other branch", id)
	})

	t.Run("a running subagent", func(t *testing.T) {
		e := newEnv(t)
		id, bid, branchAg := turnOpen(e)
		n := e.claude.count()
		sa := e.spawn(bid, SpawnSubRequest{Prompt: "runs on"})
		child := waitChild(t, e.claude, n+1)
		refused(e, id, bid)
		if agentClosed(child) {
			t.Fatal("a refused Send stopped the subagent")
		}
		e.m.Stop(id)
		if !branchAg.isClosed() {
			t.Fatal("the branch's process is not closed")
		}
		e.stoppedUnowed(bid, sa.ID, child)
		e.noted("after Stop", bid)
		e.unnoted("the other branch", id)
	})

	// No turn of the agent, but the chat is in approval for its subagent's request.
	t.Run("held in approval by a subagent's request", func(t *testing.T) {
		e := newEnv(t)
		id, _, bid, _ := e.branchWaiting()
		sa, child := e.waiting(bid)
		ask(t, child, "", "p1")
		if st := e.status(id); st != model.StatusApproval {
			t.Fatalf("status %q", st)
		}
		refused(e, id, bid)
		e.m.Stop(id)
		e.stoppedUnowed(bid, sa.ID, child)
		e.noted("after Stop", bid)
		e.unnoted("the other branch", id)
	})
}

// Archiving a chat stops every branch of it; the note goes to the one that waited on a subagent.
func TestArchiveNotesTheWaitingBranchOnly(t *testing.T) {
	archive := func(e *env, id string) {
		e.t.Helper()
		if err := e.m.SetArchive(id, model.Archive{Archived: true}); err != nil {
			e.t.Fatal(err)
		}
		e.m.Stop(id)
	}

	t.Run("the branch waits", func(t *testing.T) {
		e := newEnv(t)
		id, b, bid, branchAg := e.branchWaiting()
		sa, child := e.waiting(bid)
		mainItems := e.file(id, "items.jsonl")

		archive(e, id)
		if !branchAg.isClosed() || e.cur(id) != b {
			t.Fatalf("current %q, the branch's process closed %v", e.cur(id), branchAg.isClosed())
		}
		e.stoppedUnowed(bid, sa.ID, child)
		e.noted("the branch that waited", bid)
		e.unnoted("the other branch", id)
		if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) {
			t.Fatal("the thread of the other branch changed")
		}

		// A second Stop stops nothing: no second note.
		e.m.Stop(id)
		e.noted("after a second Stop", bid)
		if got := e.diskItems(bid); len(got) != 7 {
			t.Fatalf("the branch's items %+v", got)
		}
	})

	t.Run("main waits", func(t *testing.T) {
		e := newEnv(t)
		id, _, bid, _ := e.branchWaiting()
		e.sendTo(id, mainAt(6), "back on main")
		mainAg := e.claude.last(t)
		mainAg.emit(t, reply("p3")...)
		sa, child := e.waiting(id)
		branchItems := e.file(bid, "items.jsonl")

		archive(e, id)
		if !mainAg.isClosed() {
			t.Fatal("main's process is not closed")
		}
		e.stoppedUnowed(id, sa.ID, child)
		e.noted("the branch that waited", id)
		e.unnoted("the other branch", bid)
		if !bytes.Equal(e.file(bid, "items.jsonl"), branchItems) {
			t.Fatal("the thread of the other branch changed")
		}
	})
}

// A native subagent of Claude's that runs in the background outlives its turn: the chat object is
// idle and waits on it. Leaving the branch, or archiving the chat, stops it as it stops an app
// subagent, and the thread says so.
func TestStoppedNativeSubagentIsNoted(t *testing.T) {
	for _, how := range []string{"a new branch", "archive"} {
		t.Run(how, func(t *testing.T) {
			e := newEnv(t)
			id, a := e.subStart()
			subRun(t, a, "t1")
			a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
			sid := e.onlySub(id)
			if s := e.subs(id)[0]; s.Status != model.SubRunning || s.Kind != "" || e.m.Busy(id) {
				t.Fatalf("not idle with a running native subagent: %+v", s)
			}
			e.unnoted("while it runs", id)
			if how == "archive" {
				if err := e.m.SetArchive(id, model.Archive{Archived: true}); err != nil {
					t.Fatal(err)
				}
				e.m.Stop(id)
			} else {
				e.sendTo(id, newAt(0), "elsewhere")
			}
			if s := e.subFile(id, sid); s.Status != model.SubStopped || s.Delivery != model.SubNotOwed {
				t.Fatalf("subagent.json %+v", s)
			}
			e.noted("after "+how, id)

			// A second stop stops nothing: no second note.
			e.m.Stop(id)
			e.noted("after a second Stop", id)
		})
	}
}

// ---- after the note -------------------------------------------------------

// The note is not something said in the session: the branch left still ends at its last end mark.
// A Send to that point, or to the end of its thread, carries it on in its own session, and a new
// branch may start there.
func TestStopNoteKeepsTheBranchsEnd(t *testing.T) {
	// left is a chat that is back on main, whose branch was left while it waited on a subagent:
	// its thread is six items and the note. Main has finished the turn that left it.
	left := func(e *env) (id, b, bid string, mainAg *fakeAgent) {
		e.t.Helper()
		id, b, bid, _ = e.branchWaiting()
		sa, child := e.waiting(bid)
		e.sendTo(id, mainAt(6), "back on main")
		mainAg = e.claude.last(e.t)
		mainAg.emit(e.t, reply("p3")...)
		e.stoppedUnowed(bid, sa.ID, child)
		e.noted("the branch left", bid)
		if got := e.diskItems(bid); len(got) != 7 || got[5].Kind != "end" {
			e.t.Fatalf("the items of the branch left %+v", got)
		}
		return id, b, bid, mainAg
	}

	for name, at := range map[string]int{"right after its end mark": 6, "after the note": 7} {
		t.Run("carried on "+name, func(t *testing.T) {
			e := newEnv(t)
			id, b, bid, mainAg := left(e)
			session, spawns := e.meta(bid).SessionID, e.claude.count()

			e.sendTo(id, Target{Branch: b, At: at}, "back on the branch")
			if e.cur(id) != b || !mainAg.isClosed() || e.claude.count() != spawns+1 || len(e.claude.forkCalls()) != 1 {
				t.Fatalf("current %q, %d spawns, %d fork starts", e.cur(id), e.claude.count(), len(e.claude.forkCalls()))
			}
			if rec, _ := e.treeFile(id); len(rec.Branches) != 1 || rec.Current != b {
				t.Fatalf("tree record %+v", rec)
			}
			a := e.claude.last(t)
			if o := a.opts; o.ChatID != bid || o.SessionID != session || !o.Resume {
				t.Fatalf("spawn options %+v", o)
			}
			if sent := a.sent(); len(sent) != 1 || !reflect.DeepEqual(texts(sent[0]), []string{"back on the branch"}) {
				t.Fatalf("the branch's process got %v", sent)
			}
			got := e.diskItems(bid)
			if len(got) != 8 || got[6].Text != "Stopped." || got[7].Kind != "user" || got[7].Text != "back on the branch" {
				t.Fatalf("the branch's items %+v", got)
			}
			if n := e.stopNotes(bid); len(n) != 1 {
				t.Fatalf("notes %q", n)
			}
			// Main waited on nothing when it was left.
			e.unnoted("main", id)
		})
	}

	t.Run("a new branch at its end mark", func(t *testing.T) {
		e := newEnv(t)
		id, b, bid, _ := left(e)
		session := e.meta(bid).SessionID

		e.sendTo(id, Target{Branch: b, At: 6, New: true}, "from the branch's end")
		rec, _ := e.treeFile(id)
		if len(rec.Branches) != 2 || rec.Branches[1].From != b || rec.Branches[1].At != 6 || rec.Current != rec.Branches[1].ID {
			t.Fatalf("tree record %+v", rec)
		}
		calls := e.claude.forkCalls()
		if want := (agent.ForkSource{ChatID: bid, Dir: e.st.P.ChatDir(bid), SessionID: session, Point: "b1", End: true}); calls[len(calls)-1].src != want {
			t.Fatalf("fork source %+v, want %+v", calls[len(calls)-1].src, want)
		}
		nid := branchChatID(id, rec.Branches[1].ID)
		if got := e.diskItems(nid); len(got) != 7 || !reflect.DeepEqual(got[:6], e.diskItems(bid)[:6]) || got[6].Text != "from the branch's end" {
			t.Fatalf("the new branch's items %+v", got)
		}
		e.unnoted("the new branch", nid)
		e.noted("the branch it starts from", bid)
	})
}
