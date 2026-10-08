package chats

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// Branches of one chat that work at the same time (4.5 and phase 1 of the concurrent branches
// plan): busy is a branch's, a Send stops nothing, and the current branch is the one a message
// last got onto.

// decided is the answers a's process got to its permission requests.
func decided(a *fakeAgent) []decision {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]decision(nil), a.decides...)
}

// Two branches of a chat in a turn at once: each takes no message while it works, and each is
// approved and stopped by its own name, the other one not touched. The chat's view counts them.
func TestTwoBranchesBusyAtOnce(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	evs := e.listen()
	b, bid, fa := e.branchTo(id, newAt(3), "aside")
	e.working("the branch works", evs, id, 1, 0, true)
	e.sendTo(id, Target{Branch: model.MainBranch, End: true}, "on main")
	if !e.m.BusyOf(id, model.MainBranch) || !e.m.BusyOf(id, b) || mainAg.isClosed() || fa.isClosed() {
		t.Fatal("the two branches do not both work")
	}
	e.working("both work", evs, id, 2, 0, true)
	if rec, _ := e.treeFile(id); e.cur(id) != model.MainBranch || rec.Current != model.MainBranch {
		t.Fatalf("current %q, the record's %q", e.cur(id), rec.Current)
	}
	if len(mainAg.sent()) != 3 || len(fa.sent()) != 1 || mainAg.interrupted()+fa.interrupted() != 0 {
		t.Fatalf("main's process got %d messages, the branch's %d", len(mainAg.sent()), len(fa.sent()))
	}

	// Busy is each branch's own.
	for _, to := range []string{model.MainBranch, b} {
		if err := e.sendToErr(id, Target{Branch: to, End: true}); !errors.Is(err, ErrBusy) {
			t.Fatalf("a message to the end of %s while it works: %v", to, err)
		}
	}
	if err := e.m.Send(id, "never sent", "", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("a plain Send while the current branch works: %v", err)
	}

	// Approval. Both ask with the same request id: the branch named says whose it is.
	ask(t, fa, "", "r1")
	e.working("the branch asks", evs, id, 2, 1, true)
	ask(t, mainAg, "", "r1")
	e.working("both ask", evs, id, 2, 2, true)
	if err := e.m.DecideOf(id, b, "", "r1", true); err != nil {
		t.Fatal(err)
	}
	if got := decided(fa); !reflect.DeepEqual(got, []decision{{"r1", true}}) || len(decided(mainAg)) != 0 {
		t.Fatalf("the branch's process was answered %v, main's %v", got, decided(mainAg))
	}
	e.working("the branch's request is answered", evs, id, 2, 1, true)
	if st := e.stateOfBranch(id, model.MainBranch); st.Status != model.StatusApproval {
		t.Fatalf("main's record after the branch's answer %+v", st)
	}
	if st := e.stateOfBranch(id, b); st.Status == model.StatusApproval {
		t.Fatalf("the branch's record after its answer %+v", st)
	}
	// The branch has no open request left; main's is not reached through it.
	if err := e.m.DecideOf(id, b, "", "r1", false); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("a second answer on the branch: %v", err)
	}
	if len(decided(mainAg)) != 0 {
		t.Fatal("an answer on the branch reached main's process")
	}
	if err := e.m.DecideOf(id, model.MainBranch, "", "r1", false); err != nil {
		t.Fatal(err)
	}
	if got := decided(mainAg); !reflect.DeepEqual(got, []decision{{"r1", false}}) || len(decided(fa)) != 1 {
		t.Fatalf("main's process was answered %v, the branch's %v", got, decided(fa))
	}
	e.working("both requests are answered", evs, id, 2, 0, true)

	// Stop. The branch that is not current first.
	if err := e.m.InterruptOf(id, b); err != nil {
		t.Fatal(err)
	}
	if fa.interrupted() != 1 || mainAg.interrupted() != 0 {
		t.Fatalf("interrupts: the branch's process %d, main's %d", fa.interrupted(), mainAg.interrupted())
	}
	fa.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
	e.working("the branch was stopped", evs, id, 1, 0, true)
	if e.m.BusyOf(id, b) || !e.m.BusyOf(id, model.MainBranch) || e.meta(bid).TurnActive || !e.meta(id).TurnActive {
		t.Fatal("the stop of the branch did not end its turn alone")
	}
	if err := e.m.InterruptOf(id, model.MainBranch); err != nil {
		t.Fatal(err)
	}
	if fa.interrupted() != 1 || mainAg.interrupted() != 1 {
		t.Fatalf("interrupts: the branch's process %d, main's %d", fa.interrupted(), mainAg.interrupted())
	}
	mainAg.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
	e.working("both were stopped", evs, id, 0, 0, true)
	if mainAg.isClosed() || fa.isClosed() || e.cur(id) != model.MainBranch {
		t.Fatalf("after the stops: main's process closed %v, the branch's %v, current %q", mainAg.isClosed(), fa.isClosed(), e.cur(id))
	}

	// Each goes on in the process it has.
	e.sendTo(id, Target{Branch: b, End: true}, "again")
	if len(fa.sent()) != 2 || len(mainAg.sent()) != 3 || e.cur(id) != b {
		t.Fatalf("the branch's process got %d messages, main's %d", len(fa.sent()), len(mainAg.sent()))
	}
}

// A subagent of a branch that is not the current one finishes: its result reaches that branch,
// and the turn that carries it starts there. The current branch is not touched and stays current.
func TestDeliveryToANonCurrentBranch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	sa, child := e.waiting(id)
	b, bid, fa := e.branchTo(id, newAt(3), "aside")
	branchItems := e.file(bid, "items.jsonl")
	if e.cur(id) != b || e.m.BusyOf(id, model.MainBranch) {
		t.Fatalf("current %q, main busy %v", e.cur(id), e.m.BusyOf(id, model.MainBranch))
	}
	evs := e.listen()

	e.finish(child, "42 files")
	sent := mainAg.sent()
	if len(sent) != 3 {
		t.Fatalf("main's process got %d messages, want the two of the human and one delivery", len(sent))
	}
	if block := sent[2][0].Text; !strings.Contains(block, sidTag(sa.ID)) || !strings.Contains(block, "<report>42 files</report>") {
		t.Fatalf("the delivery block:\n%s", block)
	}
	th, err := e.m.ThreadOf(id, model.MainBranch)
	if err != nil {
		t.Fatal(err)
	}
	if rows := resultRows(th.Items); len(rows) != 1 || rows[0] != sa.ID || th.State.Status != model.StatusThinking || !e.meta(id).TurnActive {
		t.Fatalf("main after the delivery: rows %v, record %+v", rows, th.State)
	}
	// The current branch is as it was, and still the current one.
	if rec, _ := e.treeFile(id); e.cur(id) != b || rec.Current != b {
		t.Fatalf("current %q, the record's %q", e.cur(id), rec.Current)
	}
	if len(fa.sent()) != 1 || fa.isClosed() || fa.interrupted() != 0 || !bytes.Equal(e.file(bid, "items.jsonl"), branchItems) {
		t.Fatal("the delivery to main touched the current branch")
	}
	if v := e.view(id); v.Branch != b || v.Working != 2 || v.Status != model.StatusThinking {
		t.Fatalf("view %+v", v)
	}
	// Clients: main's items and its record, under main's name, and the chat's view with the
	// new count, which still names the branch.
	got := evs.drain(t, e.br)
	rows := 0
	for _, ev := range ofType(got, "chat_items") {
		if ev["chat"] != id || ev["branch"] != model.MainBranch {
			t.Fatalf("chat_items of another branch: %v", ev)
		}
		for _, u := range updatesOf(t, ev) {
			if u.Item.Kind == "subresult" {
				rows++
			}
		}
	}
	if sts := statesOf(t, got, id, model.MainBranch); rows != 1 || len(sts) == 0 || sts[len(sts)-1].Status != model.StatusThinking {
		t.Fatalf("%d result rows sent, main's records %+v", rows, sts)
	}
	if vs := chatViews(t, got, id); len(vs) == 0 || vs[len(vs)-1].Working != 2 || vs[len(vs)-1].Branch != b {
		t.Fatalf("the chat views sent %+v", vs)
	}
	if namesChat(got, "/branches/") {
		t.Fatalf("an event names a branch's server id: %v", got)
	}

	// The turn ends on main, and the result is delivered.
	mainAg.emit(t, reply("p3")...)
	e.m.handoffs.Wait()
	th, err = e.m.ThreadOf(id, model.MainBranch)
	if err != nil {
		t.Fatal(err)
	}
	if th.State.Status != model.StatusReady || th.State.SubsOwed != 0 || len(th.Subagents) != 1 || th.Subagents[0].Delivery != model.SubSent {
		t.Fatalf("main after its turn: record %+v, subagents %+v", th.State, th.Subagents)
	}
	if v := e.view(id); v.Branch != b || v.Working != 1 {
		t.Fatalf("view after main's turn %+v", v)
	}
}

// A new branch starts at a finished boundary of a branch whose turn is running, the boundary
// right before that turn included, for every agent kind (liveFork). A point inside or after the
// running turn is no point, and the source runs on.
func TestBranchFromARunningSource(t *testing.T) {
	t.Parallel()
	for _, kind := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		t.Run(string(kind), func(t *testing.T) {
			e := newEnv(t)
			id, a := e.talked(kind, "", 2)
			sp := e.spawner(kind)
			e.send(id, "a long job", "")
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "half a rep"})
			main, mainItems := e.meta(id), e.file(id, "items.jsonl")
			n := len(e.items(id)) // six of the two turns, the message and the reply so far
			if n != 8 || !e.m.BusyOf(id, model.MainBranch) {
				t.Fatalf("%d items, busy %v", n, e.m.BusyOf(id, model.MainBranch))
			}

			// Inside or after the running turn: no point, with the flag or without.
			for at := 7; at <= n; at++ {
				if err := e.sendToErr(id, newAt(at)); !errors.Is(err, ErrBadPoint) {
					t.Fatalf("a new branch at %d, in the running turn: %v", at, err)
				}
			}
			if err := e.sendToErr(id, mainAt(7)); !errors.Is(err, ErrBadPoint) {
				t.Fatalf("a message at 7, in the running turn: %v", err)
			}
			// Its end takes no message: the branch is busy.
			for _, tg := range []Target{mainAt(n), {Branch: model.MainBranch, End: true}} {
				if err := e.sendToErr(id, tg); !errors.Is(err, ErrBusy) {
					t.Fatalf("a message to the end of the running branch, %+v: %v", tg, err)
				}
			}
			e.unsplit(id)
			if len(sp.forkCalls()) != 0 || sp.count() != 1 {
				t.Fatalf("refused points: %d fork starts, %d spawns", len(sp.forkCalls()), sp.count())
			}

			// The boundary right before the running turn. No mark follows it, and the session
			// does not end there: it is forked at the id of the mark before it.
			b, bid, fa := e.branchTo(id, newAt(6), "aside")
			if want := (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: main.SessionID, Point: "p2"}); sp.forkCalls()[0].src != want {
				t.Fatalf("fork source %+v, want %+v", sp.forkCalls()[0].src, want)
			}
			if got := e.diskItems(bid); len(got) != 7 || !reflect.DeepEqual(got[:6], e.diskItems(id)[:6]) || got[6].Kind != "user" || got[6].Text != "aside" {
				t.Fatalf("the branch's items %+v", got)
			}
			if rec, _ := e.treeFile(id); !reflect.DeepEqual(rec.Branches, []model.TreeBranch{{ID: b, From: model.MainBranch, At: 6}}) || rec.Current != b {
				t.Fatalf("tree record %+v", rec)
			}
			// The source keeps running: its process, its turn, its thread.
			if a.isClosed() || a.interrupted() != 0 || len(a.sent()) != 3 || !e.m.BusyOf(id, model.MainBranch) || !e.meta(id).TurnActive {
				t.Fatal("the new branch disturbed the running source")
			}
			if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) {
				t.Fatal("the thread of the running source changed")
			}
			if v := e.view(id); v.Branch != b || v.Working != 2 || !e.m.BusyOf(id, b) {
				t.Fatalf("view %+v", v)
			}

			// An earlier boundary: pi forks it with the id on the next turn's mark.
			_, bid2, _ := e.branchTo(id, newAt(3), "earlier")
			if want := (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: main.SessionID, Point: "p1", Next: "p2"}); sp.forkCalls()[1].src != want {
				t.Fatalf("fork source of the earlier boundary %+v, want %+v", sp.forkCalls()[1].src, want)
			}
			if got := e.diskItems(bid2); len(got) != 4 || got[3].Text != "earlier" {
				t.Fatalf("the items of the branch at the earlier boundary %+v", got)
			}
			// The start of the chat has nothing to fork.
			_, bid3, _ := e.branchTo(id, newAt(0), "start over")
			if got := e.diskItems(bid3); len(got) != 1 || len(sp.forkCalls()) != 2 || sp.count() != 2 {
				t.Fatalf("the branch from the start %+v, %d fork starts, %d spawns", got, len(sp.forkCalls()), sp.count())
			}
			if v := e.view(id); v.Branches != 4 || v.Working != 4 || a.isClosed() {
				t.Fatalf("view %+v, the source's process closed %v", v, a.isClosed())
			}

			// The two turns end each in its own thread.
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "the rest"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p3"})
			fa.emit(t, reply("q1")...)
			if got := e.diskItems(id); len(got) != 10 || got[7].Text != "half a rep" || got[8].Text != "the rest" || got[9].Kind != "end" || got[9].Point != "p3" {
				t.Fatalf("the source's items after its turn %+v", got[6:])
			}
			if got := e.diskItems(bid); len(got) != 9 || got[7].Text != "reply q1" || got[8].Point != "q1" {
				t.Fatalf("the branch's items after its turn %+v", got)
			}
			if v := e.view(id); v.Working != 2 || e.m.BusyOf(id, model.MainBranch) || e.m.BusyOf(id, b) {
				t.Fatalf("view after the two turns %+v", v)
			}
		})
	}

	// The source's turn starts while the branch's process does: the branch is made all the same.
	t.Run("a turn that starts during the start", func(t *testing.T) {
		e := newEnv(t)
		id, mainAg := e.talked(model.Claude, "", 2)
		blk, res := e.block(e.claude, func() error { return e.m.SendTo(id, newAt(3), "aside", "", nil) })
		e.send(id, "meanwhile", "")
		if err := blk.release(res, nil); err != nil {
			t.Fatalf("SendTo: %v", err)
		}
		b := e.cur(id)
		fa := e.claude.lastFork(t)
		if rec, _ := e.treeFile(id); b == model.MainBranch || rec.Current != b || len(rec.Branches) != 1 {
			t.Fatalf("current %q, tree record %+v", b, rec)
		}
		if got := e.items(id); len(got) != 4 || got[3].Text != "aside" || len(fa.sent()) != 1 {
			t.Fatalf("the branch's items %+v", got)
		}
		if _, _, items, _, err := e.m.ItemsOf(id, model.MainBranch); err != nil || len(items) != 7 || items[6].Text != "meanwhile" {
			t.Fatalf("main's items %+v (%v)", items, err)
		}
		if mainAg.isClosed() || len(mainAg.sent()) != 3 || e.view(id).Working != 2 {
			t.Fatalf("main's process: closed %v, %d messages; view %+v", mainAg.isClosed(), len(mainAg.sent()), e.view(id))
		}
	})
}

// The app is closed while two branches of a chat are in a turn. After the restart both show as
// stopped, each on its own: reading one gives it its note and leaves the other as it is, and a
// Send on one continues that one only.
func TestRestartWithTwoInterruptedBranches(t *testing.T) {
	t.Parallel()
	const closed = "Stopped: the app was closed while the agent was working."
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	b, bid, fa := e.branchTo(id, newAt(3), "aside")
	fa.emit(t, reply("q1")...)
	e.sendTo(id, Target{Branch: model.MainBranch, End: true}, "on main")
	e.sendTo(id, Target{Branch: b, End: true}, "on the branch")
	if !e.meta(id).TurnActive || !e.meta(bid).TurnActive || e.view(id).Working != 2 || e.cur(id) != b {
		t.Fatalf("before the restart: view %+v", e.view(id))
	}
	session := e.meta(bid).SessionID

	e.m.Shutdown()
	e.boot()
	if e.loaded(id) || e.loaded(bid) {
		t.Fatal("a branch was loaded by the restart")
	}
	for _, br := range []string{model.MainBranch, b} {
		if st := e.stateOfBranch(id, br); st.Status != model.StatusStopped || st.Error != "" {
			t.Fatalf("the record of %s after the restart %+v", br, st)
		}
	}
	if v := e.view(id); v.Branch != b || v.Status != model.StatusStopped || v.Working != 0 || v.Approvals != 0 {
		t.Fatalf("view after the restart %+v", v)
	}

	// Reading the branch gives it its note. Main is not loaded for it, and keeps its turn mark.
	mainItems := e.file(id, "items.jsonl")
	th, err := e.m.ThreadOf(id, b)
	if err != nil {
		t.Fatal(err)
	}
	if last := th.Items[len(th.Items)-1]; last.Kind != "note" || last.Text != closed || th.State.Status != model.StatusStopped {
		t.Fatalf("the branch read after the restart: last item %+v, record %+v", last, th.State)
	}
	if e.loaded(id) || !bytes.Equal(e.file(id, "items.jsonl"), mainItems) || !e.meta(id).TurnActive || e.meta(bid).TurnActive {
		t.Fatal("reading the branch touched main")
	}
	if st := e.stateOfBranch(id, model.MainBranch); st.Status != model.StatusStopped {
		t.Fatalf("main's record after the branch was read %+v", st)
	}

	// A Send on the branch continues the branch only: its session is resumed, and main is still
	// stopped, not loaded and without a process.
	evs := e.listen()
	e.sendTo(id, Target{Branch: b, End: true}, "carry on")
	if o := e.claude.last(t).opts; e.claude.count() != 1 || len(e.claude.forkCalls()) != 0 || o.ChatID != bid || o.SessionID != session || !o.Resume {
		t.Fatalf("%d spawns, %d fork starts, spawn options %+v", e.claude.count(), len(e.claude.forkCalls()), o)
	}
	if e.loaded(id) || !bytes.Equal(e.file(id, "items.jsonl"), mainItems) {
		t.Fatal("the Send on the branch touched main")
	}
	if st := e.stateOfBranch(id, model.MainBranch); st.Status != model.StatusStopped {
		t.Fatalf("main's record after the Send on the branch %+v", st)
	}
	if st := e.stateOfBranch(id, b); st.Status != model.StatusThinking {
		t.Fatalf("the branch's record after its Send %+v", st)
	}
	e.working("the branch goes on", evs, id, 1, 0, true)
	if v := e.view(id); v.Branch != b || v.Status != model.StatusThinking {
		t.Fatalf("view %+v", v)
	}

	// And main on its own: its note, then the message, in a process of its own.
	e.sendTo(id, Target{Branch: model.MainBranch, End: true}, "and main")
	got := e.diskItems(id)
	if n := len(got); n < 2 || got[n-2].Text != closed || got[n-1].Kind != "user" || got[n-1].Text != "and main" {
		t.Fatalf("main's items after its Send %+v", got)
	}
	if o := e.claude.last(t).opts; e.claude.count() != 2 || o.ChatID != id || !o.Resume {
		t.Fatalf("%d spawns, spawn options %+v", e.claude.count(), o)
	}
	e.working("both go on", evs, id, 2, 0, true)
	if n := len(notes(e.diskItems(bid), "error")); n != 1 {
		t.Fatalf("the branch has %d notes of the restart", n)
	}
}

// The current branch is the one a message last got onto. The tree record and memory name the
// same branch after every Send, also when Sends to several branches run at once, and a Send
// that does not get onto its branch changes neither.
func TestCurrentIsTheBranchLastSentTo(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, mainAg := e.talked(model.Claude, "", 2)
	b1, _, a1 := e.branchTo(id, newAt(3), "one")
	a1.emit(t, reply("q1")...)
	b2, _, a2 := e.branchTo(id, newAt(6), "two")
	a2.emit(t, reply("r1")...)
	agents := map[string]*fakeAgent{model.MainBranch: mainAg, b1: a1, b2: a2}
	// current is the chat's current branch, which the record and memory must agree on.
	current := func(when string) string {
		t.Helper()
		rec, _ := e.treeFile(id)
		if rec.Current == "" {
			rec.Current = model.MainBranch
		}
		cur := e.cur(id)
		if rec.Current != cur {
			t.Fatalf("%s: the record's current branch is %q, memory's %q", when, rec.Current, cur)
		}
		return cur
	}
	toEnd := func(b string) Target { return Target{Branch: b, End: true} }

	if cur := current("after the second branch"); cur != b2 {
		t.Fatalf("current %q after the branch %q was made", cur, b2)
	}
	// One after the other, to a branch that is not current each time.
	for _, to := range []string{b1, model.MainBranch, b2, b1} {
		e.sendTo(id, toEnd(to), "go")
		if cur := current("after a Send to " + to); cur != to {
			t.Fatalf("current %q after a Send to %q", cur, to)
		}
		agents[to].emit(t, reply("x")...)
	}
	// A plain Send goes to the current branch and leaves it so.
	e.send(id, "plain", "")
	if cur := current("after a plain Send"); cur != b1 || len(a1.sent()) != 4 {
		t.Fatalf("current %q after a plain Send, %d messages to its process", cur, len(a1.sent()))
	}
	// A Send that is refused changes nothing: b1 works, b2 becomes current, b1 is refused.
	e.sendTo(id, toEnd(b2), "go")
	if err := e.sendToErr(id, toEnd(b1)); !errors.Is(err, ErrBusy) {
		t.Fatalf("a Send to a busy branch: %v", err)
	}
	if cur := current("after a refused Send"); cur != b2 {
		t.Fatalf("current %q after a refused Send to %q", cur, b1)
	}
	a1.emit(t, reply("y")...)
	a2.emit(t, reply("y")...)

	// At once, to all three branches, again and again.
	for round := 0; round < 25; round++ {
		res := make(chan error, len(agents))
		for to := range agents {
			go func() { res <- e.m.SendTo(id, toEnd(to), "at once", "", nil) }()
		}
		for range agents {
			if err := <-res; err != nil {
				t.Fatalf("round %d: %v", round, err)
			}
		}
		if cur := current("after Sends at once"); agents[cur] == nil {
			t.Fatalf("round %d: current %q", round, cur)
		}
		if v := e.view(id); v.Working != 3 {
			t.Fatalf("round %d: view %+v", round, v)
		}
		for _, a := range agents {
			a.emit(t, reply("z")...)
		}
	}
	for to, a := range agents {
		if a.isClosed() || a.interrupted() != 0 {
			t.Fatalf("the process of %s: closed %v, %d interrupts", to, a.isClosed(), a.interrupted())
		}
	}

	// The chat opens on that branch after a restart.
	cur := current("before the restart")
	e.m.Shutdown()
	e.boot()
	if got := current("after the restart"); got != cur {
		t.Fatalf("current %q after the restart, was %q", got, cur)
	}
}

// A fork to a new chat starts at a finished boundary of a branch whose turn is running, the
// boundary right before that turn included, for every agent kind (liveFork). A point inside the
// running turn is no point, its end is a session that is still going, and the source runs on.
func TestForkFromARunningSource(t *testing.T) {
	t.Parallel()
	for _, kind := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		t.Run(string(kind), func(t *testing.T) {
			e := newEnv(t)
			id, a := e.talked(kind, "", 2)
			sp := e.spawner(kind)
			e.send(id, "a long job", "")
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "half a rep"})
			main, mainItems := e.meta(id), e.file(id, "items.jsonl")
			n := len(e.items(id)) // six of the two turns, the message and the reply so far
			if n != 8 || !e.m.Busy(id) {
				t.Fatalf("%d items, busy %v", n, e.m.Busy(id))
			}

			if err := e.forkErr(id, 7); !errors.Is(err, ErrBadPoint) {
				t.Fatalf("a fork at 7, in the running turn: %v", err)
			}
			if err := e.forkErr(id, n); !errors.Is(err, ErrBusy) {
				t.Fatalf("a fork of the end of the running branch: %v", err)
			}
			msg := 6 // the running turn's message: Fork and edit of it is the boundary before it
			if _, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 7, Message: &msg}); !errors.Is(err, ErrBadPoint) {
				t.Fatalf("fork and edit with a point in the running turn: %v", err)
			}
			if len(sp.forkCalls()) != 0 || sp.count() != 1 || len(e.chatDirs()) != 1 {
				t.Fatalf("refused points: %d fork starts, %d spawns, folders %v", len(sp.forkCalls()), sp.count(), e.chatDirs())
			}

			// The boundary right before the running turn. No mark follows it, and the session
			// does not end there: it is forked at the id of the mark before it.
			f := e.fork(id, 6)
			fa := sp.lastFork(t)
			if got, want := sp.forkCalls()[0].src, (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: main.SessionID, Point: "p2"}); got != want {
				t.Fatalf("fork source %+v, want %+v", got, want)
			}
			if got := e.diskItems(f.ID); len(got) != 6 || !reflect.DeepEqual(got, e.diskItems(id)[:6]) {
				t.Fatalf("the fork's items %+v", got)
			}
			if f.ForkedFrom != id || f.ForkedBranch != model.MainBranch || f.ForkedAt != 6 || f.Status != model.StatusReady || f.Usage.Turns != 2 {
				t.Fatalf("the fork's view %+v", f)
			}
			// The source keeps running: its process, its turn, its thread.
			if a.isClosed() || a.interrupted() != 0 || len(a.sent()) != 3 || !e.m.Busy(id) || !e.meta(id).TurnActive {
				t.Fatal("the fork disturbed the running source")
			}
			if !bytes.Equal(e.file(id, "items.jsonl"), mainItems) {
				t.Fatal("the thread of the running source changed")
			}
			if v := e.view(id); v.Working != 1 || v.Branches != 0 {
				t.Fatalf("the source's view %+v", v)
			}

			// An earlier boundary: pi forks it with the id on the next turn's mark.
			f2 := e.fork(id, 3)
			if got, want := sp.forkCalls()[1].src, (agent.ForkSource{ChatID: id, Dir: e.st.P.ChatDir(id), SessionID: main.SessionID, Point: "p1", Next: "p2"}); got != want {
				t.Fatalf("fork source of the earlier boundary %+v, want %+v", got, want)
			}
			if got := e.diskItems(f2.ID); len(got) != 3 || f2.ForkedAt != 3 {
				t.Fatalf("the items of the fork at the earlier boundary %+v, view %+v", got, f2)
			}
			// Fork and edit of the running turn's own message: its draft, at the boundary before it.
			fe, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 6, Message: &msg})
			if err != nil {
				t.Fatal(err)
			}
			if fe.Draft == nil || fe.Draft.Text != "a long job" || len(e.diskItems(fe.ID)) != 6 {
				t.Fatalf("fork and edit of the running turn's message %+v", fe)
			}
			// The start of the chat has nothing to fork.
			f0 := e.fork(id, 0)
			if got := e.diskItems(f0.ID); len(got) != 0 || len(sp.forkCalls()) != 3 || sp.count() != 1 {
				t.Fatalf("the fork from the start %+v, %d fork starts, %d spawns", got, len(sp.forkCalls()), sp.count())
			}

			// The source's turn ends as it would have.
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "the rest"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p3"})
			got := e.items(id)
			if len(got) != 10 || got[8].Text != "the rest" || got[9].Kind != "end" || got[9].Point != "p3" {
				t.Fatalf("the source's items after its turn %+v", got)
			}
			if v := e.view(id); v.Status != model.StatusReady || v.Working != 0 || v.Usage.Turns != 3 || e.meta(id).TurnActive {
				t.Fatalf("the source's view after its turn %+v", v)
			}
			if a.isClosed() || a.interrupted() != 0 || len(e.diskItems(f.ID)) != 6 {
				t.Fatal("the source's turn end reached the fork, or the fork the source")
			}
			// The fork is a chat of its own: it takes a message on the process of its start.
			e.send(f.ID, "elsewhere", "")
			if len(fa.sent()) != 1 || len(a.sent()) != 3 || len(e.items(f.ID)) != 7 {
				t.Fatalf("the fork's message: %d to its process, %d to the source's", len(fa.sent()), len(a.sent()))
			}
		})
	}
}

// A fork records where it was made: the branch of its source and the point, in chat.json and in
// its view. A chat that is no fork has neither, nor has a fork made before they were recorded.
func TestForkOrigin(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", "")
	for _, tc := range []struct {
		branch string
		at     int
	}{{model.MainBranch, 3}, {exBranch, 6}, {exBranch, 3}, {model.MainBranch, 0}} {
		v, err := e.m.Fork(id, ForkReq{Branch: tc.branch, At: tc.at})
		if err != nil {
			t.Fatalf("Fork of %s at %d: %v", tc.branch, tc.at, err)
		}
		if meta := e.meta(v.ID); meta.ForkedFrom != id || meta.ForkedBranch != tc.branch || meta.ForkedAt != tc.at {
			t.Fatalf("chat.json of the fork of %s at %d: %+v", tc.branch, tc.at, meta)
		}
		if v.ForkedBranch != tc.branch || v.ForkedAt != tc.at || e.view(v.ID) != v {
			t.Fatalf("view of the fork of %s at %d: %+v", tc.branch, tc.at, v)
		}
		raw := string(e.file(v.ID, "chat.json"))
		if !strings.Contains(raw, `"forkedBranch"`) || strings.Contains(raw, `"forkedAt"`) != (tc.at > 0) {
			t.Fatalf("chat.json of the fork of %s at %d: %s", tc.branch, tc.at, raw)
		}
		// They survive a restart.
		e.boot()
		if got := e.view(v.ID); got.ForkedBranch != tc.branch || got.ForkedAt != tc.at {
			t.Fatalf("view after a restart %+v", got)
		}
	}

	// No fork: nothing in the file, nothing in the view.
	for _, c := range []string{id, e.create(model.Claude, gOne, "").ID} {
		view, _ := json.Marshal(e.view(c))
		for _, raw := range []string{string(e.file(c, "chat.json")), string(view)} {
			if strings.Contains(raw, "forkedBranch") || strings.Contains(raw, "forkedAt") {
				t.Fatalf("a chat that is no fork: %s", raw)
			}
		}
	}
}
