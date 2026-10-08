package chats

import (
	"errors"
	"os"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// stateOfBranch is the state record States gives for the branch of the chat; it fails unless
// there is exactly one.
func (e *env) stateOfBranch(chat, branch string) model.BranchState {
	e.t.Helper()
	var found []model.BranchState
	for _, st := range e.m.States() {
		if st.Chat == chat && st.Branch == branch {
			found = append(found, st)
		}
	}
	if len(found) != 1 {
		e.t.Fatalf("States has %d records of %s %s", len(found), chat, branch)
	}
	return found[0]
}

// working fails unless the chat's two counts over its branches are working and approvals wherever
// a client gets them: the chat's view, the views a snapshot is built from, and the last chat view
// broadcast since the previous check. changed says the step changed a count, so a view must have
// been broadcast.
func (e *env) working(when string, evs *events, id string, working, approvals int, changed bool) {
	e.t.Helper()
	if v := e.view(id); v.Working != working || v.Approvals != approvals {
		e.t.Fatalf("%s: the view has %d working, %d waiting for approval; want %d, %d", when, v.Working, v.Approvals, working, approvals)
	}
	for _, v := range e.m.Views() {
		if v.ID == id && (v.Working != working || v.Approvals != approvals) {
			e.t.Fatalf("%s: Views has %d working, %d waiting for approval; want %d, %d", when, v.Working, v.Approvals, working, approvals)
		}
	}
	// The mirrors the counts are made of agree with the records clients have.
	n, a := 0, 0
	for _, st := range e.m.States() {
		if st.Chat != id {
			continue
		}
		switch st.Status {
		case model.StatusThinking, model.StatusWriting, model.StatusTool:
			n++
		case model.StatusApproval:
			n++
			a++
		}
	}
	if n != working || a != approvals {
		e.t.Fatalf("%s: the state records have %d working, %d waiting for approval; want %d, %d", when, n, a, working, approvals)
	}
	sent := chatViews(e.t, evs.drain(e.t, e.br), id)
	if changed && len(sent) == 0 {
		e.t.Fatalf("%s: no chat view was broadcast", when)
	}
	if n := len(sent); n > 0 && (sent[n-1].Working != working || sent[n-1].Approvals != approvals) {
		e.t.Fatalf("%s: the last chat view broadcast has %d working, %d waiting for approval; want %d, %d",
			when, sent[n-1].Working, sent[n-1].Approvals, working, approvals)
	}
}

// The state record of a change is sent ahead of the chat event of the same change, for the
// current branch and for another one, and it is the record every read gives.
func TestBranchStateEvents(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	evs := e.listen()

	// A new chat: its record, as the branch "main", then its view.
	v := e.create(model.Claude, gOne, "")
	got := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat"}) {
		t.Fatalf("events of a new chat %v", got)
	}
	if st := stateIn(t, got[0]); st != model.StateOf(v.ID, model.MainBranch, v) || st.Status != model.StatusReady || st.Locked {
		t.Fatalf("the state record of a new chat %+v", st)
	}
	// The wire names.
	js := got[0]["state"].(map[string]any)
	for _, k := range []string{"chat", "branch", "cwd", "model", "locked", "usage", "status"} {
		if _, ok := js[k]; !ok {
			t.Fatalf("the state record has no %q: %v", k, js)
		}
	}
	for _, k := range []string{"statusTool", "error", "folderMissing", "subsRunning", "subsOwed", "draft"} {
		if _, ok := js[k]; ok {
			t.Fatalf("the state record of a new chat has %q: %v", k, js)
		}
	}

	// A turn of an unsplit chat: each change of the record, then the view.
	if err := e.m.Rename(v.ID, "Named", true); err != nil { // no auto namer: no chat event of the name
		t.Fatal(err)
	}
	evs.drain(t, e.br)
	e.send(v.ID, "one", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"})
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	got = evs.drain(t, e.br)
	var seq []model.Status
	for i, ev := range got {
		switch ev["type"] {
		case "branch_state":
			st := stateIn(t, ev)
			if st.Chat != v.ID || st.Branch != model.MainBranch {
				t.Fatalf("state record %+v", st)
			}
			if i+1 >= len(got) || got[i+1]["type"] != "chat" || chatOf(t, got[i+1])["status"] != string(st.Status) {
				t.Fatalf("the state record at %d is not followed by its chat event: %v", i, typesOf(got))
			}
			seq = append(seq, st.Status)
		case "chat":
			if i == 0 || got[i-1]["type"] != "branch_state" {
				t.Fatalf("the chat event at %d has no state record ahead of it: %v", i, typesOf(got))
			}
		}
	}
	if !reflect.DeepEqual(seq, []model.Status{model.StatusThinking, model.StatusTool, model.StatusReady}) {
		t.Fatalf("the statuses of the state records %v", seq)
	}
	last := statesOf(t, got, v.ID, model.MainBranch)[2]
	if !last.Locked || last.Usage.Turns != 1 || last.StatusTool != "" {
		t.Fatalf("the state record after the turn %+v", last)
	}
	if st := statesOf(t, got, v.ID, model.MainBranch)[1]; st.StatusTool != "Bash" {
		t.Fatalf("the state record during the tool call %+v", st)
	}
	// What was sent last is what the reads give: the snapshot's list and the thread's answer.
	if st := e.stateOfBranch(v.ID, model.MainBranch); st != last {
		t.Fatalf("States %+v, the last event %+v", st, last)
	}
	th, err := e.m.ThreadOf(v.ID, "")
	if err != nil || th.Branch != model.MainBranch || th.State != last || len(th.Items) != 3 {
		t.Fatalf("ThreadOf: %+v, %v", th, err)
	}
	if th, err := e.m.ThreadOf(v.ID, model.MainBranch); err != nil || th.State != last {
		t.Fatalf("ThreadOf main: %+v, %v", th, err)
	}

	// A branch's draft is in its record: a change of it sends the record, then the chat's view.
	if err := e.setDraft(v.ID, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}
	got = evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat"}) {
		t.Fatalf("events of a draft %v", got)
	}
	if st := stateIn(t, got[0]); st.Draft == nil || st.Draft.Text != "typed" || st.Status != model.StatusReady {
		t.Fatalf("the state record with the draft %+v", st)
	}

	// A chat with two branches, the branch current, both with a process.
	id, _ := e.branched(model.Claude, "", "")
	mainAg, branchAg := e.bothRunning(id)
	evs = e.listen()

	// The current branch. Its agent starts to work with it: the branch's part of the tree
	// comes last.
	branchAg.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "w"})
	got = evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"chat_items", "branch_state", "chat", "tree"}) {
		t.Fatalf("events of the current branch %v", got)
	}
	treeIn(t, got[3]).branchPart(t, exBranch)
	cur := stateIn(t, got[1])
	if cur.Chat != id || cur.Branch != exBranch || cur.Status != model.StatusWriting || chatOf(t, got[2])["status"] != string(model.StatusWriting) {
		t.Fatalf("the current branch: record %+v, chat event %v", cur, got[2])
	}

	// Another branch: its record is not the chat's view, and comes ahead of it all the same.
	mainAg.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t9", ToolName: "Read"})
	got = evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"chat_items", "branch_state", "chat", "tree"}) {
		t.Fatalf("events of the other branch %v", got)
	}
	treeIn(t, got[3]).branchPart(t, model.MainBranch)
	other := stateIn(t, got[1])
	if other.Chat != id || other.Branch != model.MainBranch || other.Status != model.StatusTool || other.StatusTool != "Read" || other.Usage.Turns != 3 {
		t.Fatalf("the other branch's record %+v", other)
	}
	if c := chatViews(t, got, id)[0]; c.Status != model.StatusWriting || c.StatusTool != "" || c.Branch != exBranch || c.Working != 2 {
		t.Fatalf("the chat event of the other branch's change %+v", c)
	}
	// A change of it that leaves the chat's counts alone: the record, and no chat event.
	mainAg.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t10", ToolName: "Grep"})
	got = evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"chat_items", "branch_state"}) || stateIn(t, got[1]).StatusTool != "Grep" {
		t.Fatalf("events of the other branch's second tool call %v", got)
	}

	// Each read gives each branch's own record.
	if st := e.stateOfBranch(id, exBranch); st != cur {
		t.Fatalf("States for the current branch %+v, its last event %+v", st, cur)
	}
	if st := e.stateOfBranch(id, model.MainBranch); st != stateIn(t, got[1]) {
		t.Fatalf("States for main %+v, its last event %+v", st, got[1])
	}
	if th, err := e.m.ThreadOf(id, ""); err != nil || th.Branch != exBranch || th.State != cur {
		t.Fatalf("ThreadOf the current branch: %+v, %v", th.State, err)
	}
	if th, err := e.m.ThreadOf(id, model.MainBranch); err != nil || th.Branch != model.MainBranch || th.State != stateIn(t, got[1]) {
		t.Fatalf("ThreadOf main: %+v, %v", th.State, err)
	}
	if _, err := e.m.ThreadOf(id, "nope"); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("ThreadOf an unknown branch: %v", err)
	}
}

// States is what a snapshot lists: one record per registered branch of every listed chat, main
// included, also for what was not loaded since the start.
func TestStatesInSnapshot(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if sts := e.m.States(); sts == nil || len(sts) != 0 {
		t.Fatalf("States with no chat: %#v", sts)
	}
	plain := e.create(model.Cursor, gTwo, "")
	gone := e.create(model.Claude, gOne, "")
	id, bid := e.branched(model.Claude, "", "") // restarts the manager: nothing is loaded

	// The branch's turn was cut by a restart; main's folder is its own. Each has a draft.
	b := e.meta(bid)
	b.TurnActive, b.Model, b.Effort, b.Cwd = true, "opus", "max", t.TempDir()
	b.Usage = model.Usage{Turns: 1, CtxIn: 77, CtxWindow: 200}
	e.writeMeta(b)
	top := e.meta(id)
	top.Drafts = map[string]*model.Draft{model.MainBranch: {Text: "typed"}, exBranch: {Text: "typed on the branch"}}
	e.writeMeta(top)
	// A chat whose items.jsonl can't be read shows its error once it was opened.
	if err := os.Mkdir(e.m.itemsPath(gone.ID), 0o700); err != nil {
		t.Fatal(err)
	}
	e.boot()

	sts := e.m.States()
	if len(sts) != 4 {
		t.Fatalf("States %+v", sts)
	}
	for i := 1; i < len(sts); i++ {
		if sts[i-1].Chat > sts[i].Chat || (sts[i-1].Chat == sts[i].Chat && sts[i-1].Branch != model.MainBranch) {
			t.Fatalf("States is not by chat, main first: %+v", sts)
		}
	}
	if e.loaded(id) || e.loaded(bid) || e.loaded(plain.ID) {
		t.Fatal("States loaded a thread")
	}
	want := model.BranchState{Chat: id, Branch: model.MainBranch, Cwd: top.Cwd, Model: top.Model, Effort: top.Effort,
		Locked: true, Usage: top.Usage, Status: model.StatusReady}
	st := e.stateOfBranch(id, model.MainBranch)
	if st.Draft == nil || st.Draft.Text != "typed" {
		t.Fatalf("main's record has no draft: %+v", st)
	}
	st.Draft = nil
	if st != want {
		t.Fatalf("main's record\n got %+v\nwant %+v", st, want)
	}
	want = model.BranchState{Chat: id, Branch: exBranch, Cwd: b.Cwd, Model: "opus", Effort: "max",
		Locked: true, Usage: b.Usage, Status: model.StatusStopped}
	st = e.stateOfBranch(id, exBranch)
	if st.Draft == nil || st.Draft.Text != "typed on the branch" {
		t.Fatalf("the branch's record has no draft: %+v", st)
	}
	st.Draft = nil
	if st != want {
		t.Fatalf("the interrupted branch's record\n got %+v\nwant %+v", st, want)
	}
	if st := e.stateOfBranch(plain.ID, model.MainBranch); st.Status != model.StatusReady || st.Locked || st.Model != plain.Model || st.Cwd != plain.Cwd {
		t.Fatalf("the record of an unsplit chat %+v", st)
	}
	// Every record is of a chat in Views, and every chat in Views has main's.
	views := e.m.Views()
	if len(views) != 3 {
		t.Fatalf("Views %+v", views)
	}
	for _, v := range views {
		main := e.stateOfBranch(v.ID, model.MainBranch)
		if v.Branch == "" && main != model.StateOf(v.ID, model.MainBranch, v) {
			t.Fatalf("main's record %+v is not the session side of the view %+v", main, v)
		}
	}
	if v := e.view(id); v.Branch != "" || v.Working != 0 || v.Approvals != 0 {
		t.Fatalf("view %+v", v)
	}

	// Once read: the interrupted branch is stopped for good, the broken chat shows its error.
	if _, err := e.m.ThreadOf(id, exBranch); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.ThreadOf(gone.ID, ""); err == nil {
		t.Fatal("the broken thread was read")
	}
	if st := e.stateOfBranch(id, exBranch); st.Status != model.StatusStopped {
		t.Fatalf("the interrupted branch's record once loaded %+v", st)
	}
	if st := e.stateOfBranch(gone.ID, model.MainBranch); st.Status != model.StatusError || st.Error == "" {
		t.Fatalf("the record of a chat whose thread can't be read %+v", st)
	}

	// A branch being made is in no list until it is listed (see TestNewBranchStateSentWhenListed);
	// a deleted chat's records go with it.
	if err := e.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	if sts := e.m.States(); len(sts) != 2 || sts[0].Chat == id || sts[1].Chat == id {
		t.Fatalf("States after the delete %+v", sts)
	}
}

// Working and Approvals count the branches of a chat that work and that wait for approval,
// whichever is current, after each way a turn starts and ends.
func TestAggregateCounts(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", "")
	mainAg, branchAg := e.bothRunning(id) // the branch is current; both are idle
	evs := e.listen()
	e.working("both idle", evs, id, 0, 0, false)

	// A turn start: on the current branch by a message, on the other by its agent.
	e.send(id, "go", "")
	e.working("the current branch's turn started", evs, id, 1, 0, true)
	mainAg.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "by itself"})
	e.working("the other branch's turn started", evs, id, 2, 0, true)
	branchAg.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "w"})
	e.working("the current branch writes", evs, id, 2, 0, true)

	// An approval request, on each; an answer leaves the branch working.
	mainAg.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "t1"})
	e.working("the other branch asks", evs, id, 2, 1, true)
	branchAg.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r2", ToolName: "Bash", ToolID: "t2"})
	e.working("the current branch asks", evs, id, 2, 2, true)
	if err := e.m.Decide(id, "", "r2", true); err != nil {
		t.Fatal(err)
	}
	e.working("the current branch was answered", evs, id, 2, 1, true)

	// A turn end.
	branchAg.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "q3"})
	e.working("the current branch's turn ended", evs, id, 1, 1, true)

	// An error: the other branch's turn ends with one, and its open request with it.
	mainAg.emit(t, agent.Event{Kind: agent.EvTurnEnd, Error: "the provider said no"})
	e.working("the other branch's turn ended with an error", evs, id, 0, 0, true)
	if st := e.stateOfBranch(id, model.MainBranch); st.Status != model.StatusReady {
		t.Fatalf("main's record after the error %+v", st)
	}

	// An error: the process of a working branch ends.
	mainAg.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "again"})
	e.working("the other branch works again", evs, id, 1, 0, true)
	mainAg.exit(t)
	e.working("the other branch's process ended", evs, id, 0, 0, true)
	if st := e.stateOfBranch(id, model.MainBranch); st.Status != model.StatusStopped {
		t.Fatalf("main's record after the exit %+v", st)
	}

	// A stop: the user's on the current branch, with the aborted turn end that follows.
	e.send(id, "more", "")
	e.working("the current branch works", evs, id, 1, 0, true)
	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	e.working("the stop was asked for", evs, id, 1, 0, false)
	branchAg.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
	e.working("the current branch was stopped", evs, id, 0, 0, true)

	// A stop: of one branch (a move, an archive), while it waits for approval.
	e.send(id, "and more", "")
	branchAg.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r3", ToolName: "Bash", ToolID: "t3"})
	e.working("the current branch asks again", evs, id, 1, 1, true)
	e.m.stopBranch(bid)
	e.working("the branch was stopped", evs, id, 0, 0, true)

	// The counts are the chat's: another chat's stay its own.
	other := e.create(model.Claude, gOne, "")
	e.send(other.ID, "hi", "")
	e.working("another chat works", evs, id, 0, 0, false)
	if v := e.view(other.ID); v.Working != 1 || v.Approvals != 0 || v.Branches != 0 {
		t.Fatalf("the other chat's view %+v", v)
	}

	// A start that fails: nothing works, and the error is the branch's.
	if err := os.RemoveAll(e.meta(bid).Cwd); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Send(id, "nowhere", "", nil); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("Send without the folder: %v", err)
	}
	e.working("the start failed", evs, id, 0, 0, false)
	if st := e.stateOfBranch(id, exBranch); st.Status != model.StatusError || !st.FolderMissing {
		t.Fatalf("the branch's record after the failed start %+v", st)
	}
}

// Nothing is sent of a new branch while it is unlisted; once it is listed its first state record
// is sent, ahead of the chat event that names it.
func TestNewBranchStateSentWhenListed(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, a := e.talked(model.Claude, "", 2)
	evs := e.listen()

	b, res := e.block(e.claude, func() error { return e.m.SendTo(id, newAt(3), "another way", "", nil) })
	bid := b.opts.ChatID
	branch := splitBranch(bid)
	// During the start: no event, and no record in the snapshot's list.
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("events during the start %v", got)
	}
	if sts := e.m.States(); len(sts) != 1 || sts[0].Branch != model.MainBranch {
		t.Fatalf("States during the start %+v", sts)
	}
	if v := e.view(id); v.Working != 0 || v.Branches != 0 {
		t.Fatalf("view during the start %+v", v)
	}
	if err := b.release(res, nil); err != nil {
		t.Fatal(err)
	}
	if a.isClosed() || a.interrupted() != 0 {
		t.Fatal("main was stopped by the new branch")
	}

	// The listing is three events: the branch's record, then the chat's view, then the tree's
	// new branch. Nothing is sent of main, which the Send did not touch.
	got := evs.drain(t, e.br)
	if namesChat(got, "/branches/") || !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat", "tree"}) {
		t.Fatalf("the events of the listing: %v", got)
	}
	if p := treeIn(t, got[2]); p.Branch == nil || p.Branch.ID != branch || p.Current == nil || *p.Current != branch {
		t.Fatalf("the tree event of the listing %s", p)
	}
	// The first event that names the branch is its record, with the message already on it.
	sts := statesOf(t, got, id, branch)
	if len(sts) != 1 {
		t.Fatalf("state records of the new branch %+v", sts)
	}
	want := model.BranchState{Chat: id, Branch: branch, Cwd: sts[0].Cwd, Model: sts[0].Model, Effort: sts[0].Effort,
		Locked: true, Usage: sts[0].Usage, Status: model.StatusThinking}
	if sts[0] != want || sts[0].Cwd != e.meta(id).Cwd || sts[0].Model != e.meta(id).Model {
		t.Fatalf("the new branch's first record\n got %+v\nwant %+v", sts[0], want)
	}
	at := -1
	for i, ev := range got {
		if ev["type"] == "branch_state" && stateIn(t, ev).Branch == branch {
			at = i
			continue
		}
		if at < 0 && (ev["branch"] == branch || (ev["type"] == "chat" && chatOf(t, ev)["branch"] == branch)) {
			t.Fatalf("the event at %d names the branch ahead of its record: %v", i, typesOf(got))
		}
	}
	chatEvs := chatViews(t, got[at+1:], id)
	if len(chatEvs) != 1 || len(ofType(got, "chat")) != 1 {
		t.Fatalf("chat events after the branch's record %+v, of %v", chatEvs, typesOf(got))
	}
	if c := chatEvs[0]; c.Branch != branch || c.Branches != 2 || c.Status != model.StatusThinking || c.Working != 1 || c.Approvals != 0 {
		t.Fatalf("the chat event that lists the branch %+v", c)
	}
	// It is in the snapshot's list from then on, and the reads agree.
	if st := e.stateOfBranch(id, branch); st != sts[0] {
		t.Fatalf("States for the new branch %+v", st)
	}
	if th, err := e.m.ThreadOf(id, branch); err != nil || th.State != sts[0] || len(th.Items) != 4 {
		t.Fatalf("ThreadOf the new branch: %+v, %v", th, err)
	}
	if v := e.view(id); v.Working != 1 || v.Branch != branch {
		t.Fatalf("view %+v", v)
	}

	// A new branch at the start of the chat has no fork start: its record is sent the same way.
	e.claude.lastFork(t).emit(t, reply("q1")...)
	evs.drain(t, e.br)
	e.sendTo(id, newAt(0), "from the start")
	got = evs.drain(t, e.br)
	second := e.cur(id)
	sts = statesOf(t, got, id, second)
	if second == branch || len(sts) != 1 || sts[0].Status != model.StatusThinking || len(ofType(got, "chat")) != 1 {
		t.Fatalf("the second branch %q: records %+v, events %v", second, sts, typesOf(got))
	}
	if c := chatViews(t, got, id)[0]; c.Branch != second || c.Branches != 3 || c.Working != 1 {
		t.Fatalf("the chat event that lists the second branch %+v", c)
	}
	if n := len(e.m.States()); n != 3 {
		t.Fatalf("States has %d records", n)
	}
}

// The chat's view says fresh of its current branch, as it says locked: a branch started in a fresh
// fork has a message of its own, while the fork's main still has none.
func TestViewFreshIsTheCurrentBranchs(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	src, _ := e.talked(model.Claude, "", 2)
	id := e.fork(src, 6).ID

	// The plain case: a fresh fork on main.
	if v, st := e.view(id), e.stateOfBranch(id, model.MainBranch); !v.Fresh || !v.Locked || !st.Fresh {
		t.Fatalf("a fresh fork: the view %+v, main's state record %+v", v, st)
	}

	// A branch from a point inside the fork's prefix becomes current.
	evs := e.listen()
	b, bid, _ := e.branchTo(id, newAt(3), "aside")
	if v := e.view(id); v.Branch != b || v.Fresh || !v.Locked {
		t.Fatalf("the view with the branch current %+v", v)
	}
	if st := e.stateOfBranch(id, model.MainBranch); !st.Fresh || !st.Locked {
		t.Fatalf("main's state record %+v", st)
	}
	if st := e.stateOfBranch(id, b); st.Fresh || !st.Locked {
		t.Fatalf("the branch's state record %+v", st)
	}
	if m, bm := e.meta(id), e.meta(bid); !m.Fresh || bm.Fresh {
		t.Fatalf("fresh in chat.json: main %v, the branch %v", m.Fresh, bm.Fresh)
	}
	views := chatViews(t, evs.drain(t, e.br), id)
	if len(views) == 0 {
		t.Fatal("no chat event for the new branch")
	}
	if last := views[len(views)-1]; last.Branch != b || last.Fresh || !last.Locked {
		t.Fatalf("the last chat event %+v", last)
	}
}
