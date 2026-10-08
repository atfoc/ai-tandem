package chats

import (
	"errors"
	"reflect"
	"sort"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// What a copy (a new branch or a fork) does not carry over from a source that has things running:
// the running subagents, which its agent is told of once, and open items.

// runningLinked is spawnLinked whose parent has ended its turn: the chat is idle and its one
// subagent runs. It returns the end of the thread, a point a copy can start at.
func (e *env) runningLinked() (id string, parent *fakeAgent, sa model.Subagent, child *fakeAgent, at int) {
	e.t.Helper()
	id, parent, sa, child = e.spawnLinked()
	parent.emit(e.t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	return id, parent, sa, child, len(e.items(id))
}

// notices returns the blocks of msg that are the notice of what was not carried over.
func notices(msg []agent.ContentBlock) []string {
	var got []string
	for _, b := range msg {
		if strings.HasPrefix(b.Text, "<"+notCarriedTag+">") {
			got = append(got, b.Text)
		}
	}
	return got
}

// noticeAhead checks that msg is the notice naming sids and then text, and nothing else.
func noticeAhead(t *testing.T, msg []agent.ContentBlock, text string, sids ...string) {
	t.Helper()
	got := texts(msg)
	if len(got) != 2 || got[1] != text || len(notices(msg)) != 1 || !strings.HasSuffix(got[0], "</"+notCarriedTag+">") {
		t.Fatalf("the message is %q, want the notice and %q", got, text)
	}
	for _, sid := range sids {
		if !strings.Contains(got[0], "<sid>"+sid+"</sid>") {
			t.Fatalf("the notice does not name %s: %s", sid, got[0])
		}
	}
	if strings.Count(got[0], "<subagent>") != len(sids) {
		t.Fatalf("the notice lists other subagents than %v: %s", sids, got[0])
	}
}

// subOn is sub for the chat object with server id id: a chat's main branch, or a branch.
func (e *env) subOn(id, sid string) model.Subagent {
	e.t.Helper()
	top, branch := splitID(id)
	th, err := e.m.ThreadOf(top, branch)
	if err != nil {
		e.t.Fatal(err)
	}
	for _, s := range th.Subagents {
		if s.ID == sid {
			return s
		}
	}
	e.t.Fatalf("no subagent %s on %s", sid, id)
	return model.Subagent{}
}

// itemsOn is items for the chat object with server id id.
func (e *env) itemsOn(id string) []model.Item {
	e.t.Helper()
	top, branch := splitID(id)
	th, err := e.m.ThreadOf(top, branch)
	if err != nil {
		e.t.Fatal(err)
	}
	return th.Items
}

// marked checks the copy's record of a subagent that was running in the source: stopped, marked,
// nothing owed for it, in memory and in its file, and not counted as running.
func (e *env) marked(when, id, sid string) {
	e.t.Helper()
	top, branch := splitID(id)
	for _, s := range []model.Subagent{e.subOn(id, sid), e.subFile(id, sid)} {
		if s.ID != sid || s.Status != model.SubStopped || !s.NotCarried || s.Delivery != model.SubNotOwed {
			e.t.Fatalf("%s: the copy's record is %+v", when, s)
		}
	}
	if st := e.stateOfBranch(top, branch); st.SubsRunning != 0 {
		e.t.Fatalf("%s: the copy's state %+v", when, st)
	}
}

func TestNotCarriedBlock(t *testing.T) {
	t.Parallel()
	got := notCarriedBlock([]model.Subagent{
		{ID: "aaa", Description: "look <up> & report"},
		{ID: "bbb"},
	})
	want := "<subagents-not-carried-over>\n" +
		"This block was written by the app, not by the user; the user's message follows it. " +
		"This chat is a copy of another chat. The subagents below were running in the chat this one " +
		"was copied from when the copy was made. They do not run here, and no result will come from " +
		"them in this chat: do not wait for them. Spawn a subagent again if you need its work.\n" +
		"\n<subagent>\n<sid>aaa</sid>\n<description>look &lt;up&gt; &amp; report</description>\n</subagent>\n" +
		"\n<subagent>\n<sid>bbb</sid>\n</subagent>\n" +
		"\nBackground commands and workflows started before this point belong to the chat this one " +
		"was copied from: they may still run there, and they are not running here. A message that " +
		"says such a task stopped is about this copy only.\n" +
		"</subagents-not-carried-over>"
	if got != want {
		t.Fatalf("block:\n%s\nwant:\n%s", got, want)
	}
}

// The notice goes with one accepted message: the first.
func TestNotCarriedNoticeGoesOnce(t *testing.T) {
	t.Parallel()
	t.Run("fork", func(t *testing.T) {
		e := newEnv(t)
		id, _, sa, _, at := e.runningLinked()
		f := e.fork(id, at)
		fa := e.claude.lastFork(t)
		e.marked("made", f.ID, sa.ID)
		if !e.meta(f.ID).NoticeOwed || e.meta(id).NoticeOwed {
			t.Fatalf("notice owed: fork %v, source %v", e.meta(f.ID).NoticeOwed, e.meta(id).NoticeOwed)
		}
		e.send(f.ID, "one", "")
		noticeAhead(t, fa.sent()[0], "one", sa.ID)
		if e.meta(f.ID).NoticeOwed {
			t.Fatal("the notice is still owed after the message that carried it")
		}
		fa.emit(t, reply("f1")...)
		e.send(f.ID, "two", "")
		if got := texts(fa.sent()[1]); !reflect.DeepEqual(got, []string{"two"}) {
			t.Fatalf("the second message is %q", got)
		}
		e.marked("after two messages", f.ID, sa.ID)
	})

	t.Run("new branch", func(t *testing.T) {
		e := newEnv(t)
		id, parent, sa, child, at := e.runningLinked()
		b, bid, ba := e.branchTo(id, newAt(at), "one")
		noticeAhead(t, ba.sent()[0], "one", sa.ID)
		e.marked("made", bid, sa.ID)
		if e.meta(bid).NoticeOwed || e.meta(id).NoticeOwed {
			t.Fatalf("notice owed: branch %v, main %v", e.meta(bid).NoticeOwed, e.meta(id).NoticeOwed)
		}
		if e.cur(id) != b {
			t.Fatalf("the current branch is %s", e.cur(id))
		}
		ba.emit(t, reply("b1")...)
		e.send(id, "two", "") // the branch is the current one
		if got := texts(ba.sent()[1]); !reflect.DeepEqual(got, []string{"two"}) {
			t.Fatalf("the second message is %q", got)
		}
		// The source's subagent runs on, and its result goes to the source only.
		if s := e.subOn(id, sa.ID); agentClosed(child) || s.Status != model.SubRunning || s.NotCarried {
			t.Fatalf("the source's subagent: %+v", s)
		}
		ba.emit(t, reply("b2")...)
		e.finish(child, "the report")
		if got := deliveredSids(parent.sent()[len(parent.sent())-1]); !reflect.DeepEqual(got, []string{sa.ID}) {
			t.Fatalf("the source's agent got %v", got)
		}
		if len(ba.sent()) != 2 {
			t.Fatalf("the branch's agent was sent %q", ba.sent())
		}
		e.marked("after the source's result", bid, sa.ID)
	})

	// A message the adapter refused did not reach the agent: the next one carries the notice.
	t.Run("refused", func(t *testing.T) {
		const rejected = "rejected the prompt"
		e := newEnv(t)
		id, _, sa, _, at := e.runningLinked()
		f := e.fork(id, at)
		fa := e.claude.lastFork(t)
		fa.failSends(errors.New(rejected), agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd, Error: rejected})
		if err := e.m.Send(f.ID, "one", "", nil); err == nil || err.Error() != rejected {
			t.Fatalf("Send: %v", err)
		}
		if len(fa.sent()) != 0 || !e.meta(f.ID).NoticeOwed {
			t.Fatalf("after the refusal: %d sent, notice owed %v", len(fa.sent()), e.meta(f.ID).NoticeOwed)
		}
		fa.failSends(nil)
		e.send(f.ID, "two", "")
		noticeAhead(t, fa.sent()[0], "two", sa.ID)
		fa.emit(t, reply("f1")...)
		e.send(f.ID, "three", "")
		if got := texts(fa.sent()[1]); !reflect.DeepEqual(got, []string{"three"}) || e.meta(f.ID).NoticeOwed {
			t.Fatalf("the message after is %q, notice owed %v", got, e.meta(f.ID).NoticeOwed)
		}
	})

	t.Run("restart before the first message", func(t *testing.T) {
		e := newEnv(t)
		id, _, sa, _, at := e.runningLinked()
		f := e.fork(id, at)
		e.boot()
		if !e.meta(f.ID).NoticeOwed {
			t.Fatal("the notice is not owed after the restart")
		}
		e.send(f.ID, "one", "")
		fa := e.claude.lastFork(t)
		noticeAhead(t, fa.sent()[0], "one", sa.ID)
		e.marked("after the restart", f.ID, sa.ID)
		fa.emit(t, reply("f1")...)
		e.send(f.ID, "two", "")
		if got := texts(fa.sent()[1]); !reflect.DeepEqual(got, []string{"two"}) {
			t.Fatalf("the second message is %q", got)
		}
	})

	// Ahead of the results the copy is owed, after the board's context.
	t.Run("order", func(t *testing.T) {
		e := newEnv(t)
		id, parent := e.startSpawnParent()
		emitSpawnItem(t, parent, "t1", "mcp__board__spawn_subagent", `{"prompt":"a"}`)
		a := e.spawn(id, SpawnSubRequest{Prompt: "a"})
		ca := waitChild(t, e.claude, 2)
		parent.emit(t, agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "receipt"})
		emitSpawnItem(t, parent, "t2", "mcp__board__spawn_subagent", `{"prompt":"b","description":"the second"}`)
		b := e.spawn(id, SpawnSubRequest{Prompt: "b", Description: "the second"})
		parent.emit(t, agent.Event{Kind: agent.EvToolResult, ToolID: "t2", Result: "receipt"})
		e.finish(ca, "report a") // owed: the parent's turn is running
		parent.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
		at := turnEnd(e.items(id), itemAt(e.items(id), "text", "spawned"))

		f := e.fork(id, at)
		fa := e.claude.lastFork(t)
		e.marked("made", f.ID, b.ID)
		e.send(f.ID, "one", "")
		got := texts(fa.sent()[0])
		if len(got) != 3 || !strings.HasPrefix(got[0], "<"+notCarriedTag+">") || !strings.HasPrefix(got[1], "<"+subResultsTag+">") || got[2] != "one" {
			t.Fatalf("the first message is %q", got)
		}
		if !strings.Contains(got[0], "<sid>"+b.ID+"</sid>\n<description>the second</description>") || strings.Contains(got[0], a.ID) {
			t.Fatalf("the notice: %s", got[0])
		}
		if sids := deliveredSids(fa.sent()[0]); !reflect.DeepEqual(sids, []string{a.ID}) {
			t.Fatalf("results carried: %v", sids)
		}
	})

	// A copy of a copy whose agent was never told is owed the notice as well.
	t.Run("copy of an untold copy", func(t *testing.T) {
		e := newEnv(t)
		id, _, sa, _, at := e.runningLinked()
		f := e.fork(id, at)
		g := e.fork(f.ID, at)
		ga := e.claude.lastFork(t)
		e.marked("copy of the copy", g.ID, sa.ID)
		e.send(g.ID, "one", "")
		noticeAhead(t, ga.sent()[0], "one", sa.ID)
	})

	// A source with nothing running owes its copy no notice.
	t.Run("nothing running", func(t *testing.T) {
		e := newEnv(t)
		id, _, sa, at := e.deliveredLinked()
		for _, at := range []int{len(e.items(id)), at} {
			c := e.fork(id, at)
			if e.meta(c.ID).NoticeOwed || e.sub(c.ID, sa.ID).NotCarried {
				t.Fatalf("notice owed %v, record %+v", e.meta(c.ID).NoticeOwed, e.sub(c.ID, sa.ID))
			}
			e.send(c.ID, "one", "")
			if n := notices(e.claude.lastFork(t).sent()[0]); len(n) != 0 {
				t.Fatalf("a notice was sent: %q", n)
			}
		}
	})
}

// A copy of a copy that was told is forked from the copy's session as it was at the point: before
// the message that carried the notice the session has none, and the second copy's agent is told.
func TestNoticeOnACopyOfACopyInsideThePrefix(t *testing.T) {
	t.Parallel()
	t.Run("branch from a branch", func(t *testing.T) {
		e := newEnv(t)
		id, _, sa, _, at := e.runningLinked()
		b1, bid1, a1 := e.branchTo(id, newAt(at), "one")
		noticeAhead(t, a1.sent()[0], "one", sa.ID)
		if n := e.meta(bid1).NoticeAt; n != at+1 {
			t.Fatalf("the notice is recorded at %d, want %d", n, at+1)
		}
		a1.emit(t, reply("b1")...)
		// From b1, at the same point: inside b1's prefix, before the message that carried the notice.
		e.sendTo(id, Target{Branch: b1, At: at, New: true}, "two")
		bid2 := branchChatID(id, e.cur(id))
		a2 := e.claude.lastFork(t)
		e.marked("copy of the copy", bid2, sa.ID)
		noticeAhead(t, a2.sent()[0], "two", sa.ID)
		if m := e.meta(bid2); m.NoticeOwed || m.NoticeAt != at+1 {
			t.Fatalf("b2 after its first message: notice owed %v, at %d", m.NoticeOwed, m.NoticeAt)
		}
	})

	t.Run("fork of a fork", func(t *testing.T) {
		e := newEnv(t)
		id, _, sa, _, at := e.runningLinked()
		f := e.fork(id, at)
		fa := e.claude.lastFork(t)
		e.send(f.ID, "one", "")
		fa.emit(t, reply("f1")...)
		g := e.fork(f.ID, at)
		ga := e.claude.lastFork(t)
		e.marked("copy of the copy", g.ID, sa.ID)
		if !e.meta(g.ID).NoticeOwed {
			t.Fatal("the second fork is not owed the notice")
		}
		e.send(g.ID, "two", "")
		noticeAhead(t, ga.sent()[0], "two", sa.ID)
	})

	// Cut after the message that carried the notice, the copy's session has it: no second one,
	// for that copy and for a copy of it.
	t.Run("after the notice", func(t *testing.T) {
		e := newEnv(t)
		id, _, sa, _, at := e.runningLinked()
		b1, bid1, a1 := e.branchTo(id, newAt(at), "one")
		noticeAhead(t, a1.sent()[0], "one", sa.ID)
		a1.emit(t, reply("b1")...)
		end := len(e.itemsOn(bid1))
		for _, from := range []string{b1, ""} { // from b1, then from the copy of b1
			if from == "" {
				from = e.cur(id)
			}
			e.sendTo(id, Target{Branch: from, At: end, New: true}, "two")
			bid := branchChatID(id, e.cur(id))
			a := e.claude.lastFork(t)
			if got := texts(a.sent()[0]); !reflect.DeepEqual(got, []string{"two"}) {
				t.Fatalf("the first message of a copy from %s is %q", from, got)
			}
			if m := e.meta(bid); m.NoticeOwed || m.NoticeAt != at+1 {
				t.Fatalf("a copy from %s: notice owed %v, at %d", from, m.NoticeOwed, m.NoticeAt)
			}
			e.marked("a copy from "+from, bid, sa.ID)
			a.emit(t, reply("b2")...)
		}

		f, err := e.m.Fork(id, ForkReq{Branch: b1, At: end})
		if err != nil {
			t.Fatal(err)
		}
		fa := e.claude.lastFork(t)
		if e.meta(f.ID).NoticeOwed {
			t.Fatal("a fork past the notice is owed it")
		}
		e.send(f.ID, "three", "")
		if got := texts(fa.sent()[0]); !reflect.DeepEqual(got, []string{"three"}) {
			t.Fatalf("the fork's first message is %q", got)
		}
	})

	// A message the adapter refused carried no notice: none is recorded, so a copy is told.
	t.Run("after a refused message", func(t *testing.T) {
		const rejected = "rejected the prompt"
		e := newEnv(t)
		id, _, _, _, at := e.runningLinked()
		f := e.fork(id, at)
		fa := e.claude.lastFork(t)
		fa.failSends(errors.New(rejected), agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvTurnEnd, Error: rejected})
		if err := e.m.Send(f.ID, "one", "", nil); err == nil {
			t.Fatal("the rejected Send returned no error")
		}
		if m := e.meta(f.ID); !m.NoticeOwed || m.NoticeAt != 0 {
			t.Fatalf("after the refusal: notice owed %v, at %d", m.NoticeOwed, m.NoticeAt)
		}
	})
}

// subIDs is the sorted ids of the subagents the chat object with server id id holds.
func (e *env) subIDs(id string) []string {
	e.t.Helper()
	top, branch := splitID(id)
	th, err := e.m.ThreadOf(top, branch)
	if err != nil {
		e.t.Fatal(err)
	}
	ids := []string{}
	for _, s := range th.Subagents {
		ids = append(ids, s.ID)
	}
	sort.Strings(ids)
	return ids
}

// A copy of a running source, made at the finished boundary before the running turn (plan 4.3):
// a subagent of an earlier turn that still runs is in the copy, marked and named in the notice;
// one spawned in the running turn is past the point and is not. The source keeps both running.
func TestCopyOfARunningSourceWithSubagents(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, a, _, at := e.runningLinked()
	e.send(id, "more", "")
	emitSpawnItem(t, parent, "t2", "mcp__board__spawn_subagent", `{"prompt":"b"}`)
	b := e.spawn(id, SpawnSubRequest{Prompt: "b"})
	waitChild(t, e.claude, 3)
	parent.emit(t, agent.Event{Kind: agent.EvToolResult, ToolID: "t2", Result: "receipt"})
	if b.Tool != "t2" || e.view(id).Working != 1 {
		t.Fatalf("the source: second subagent %+v, view %+v", b, e.view(id))
	}
	source := func(when string) {
		t.Helper()
		for _, sid := range []string{a.ID, b.ID} {
			if s := e.subOn(id, sid); s.Status != model.SubRunning || s.NotCarried {
				t.Fatalf("%s: the source's subagent %+v", when, s)
			}
		}
		if st := e.stateOfBranch(id, model.MainBranch); st.SubsRunning != 2 {
			t.Fatalf("%s: the source's state %+v", when, st)
		}
	}

	_, bid, ba := e.branchTo(id, newAt(at), "one")
	if got := e.subIDs(bid); !reflect.DeepEqual(got, []string{a.ID}) {
		t.Fatalf("the branch holds subagents %v, want %s alone", got, a.ID)
	}
	e.marked("the branch", bid, a.ID)
	noticeAhead(t, ba.sent()[0], "one", a.ID)
	source("after the branch")

	f := e.fork(id, at)
	fa := e.claude.lastFork(t)
	if got := e.subIDs(f.ID); !reflect.DeepEqual(got, []string{a.ID}) {
		t.Fatalf("the fork holds subagents %v, want %s alone", got, a.ID)
	}
	e.marked("the fork", f.ID, a.ID)
	e.send(f.ID, "one", "")
	noticeAhead(t, fa.sent()[0], "one", a.ID)
	source("after the fork")
}

// open returns the indexes of the items that are not closed: unfinished text, a tool call with
// neither result nor denial, an undecided permission request.
func open(items []model.Item) []int {
	var idx []int
	for i, it := range items {
		switch {
		case it.Kind == "text" && !it.Done,
			it.Kind == "tool" && it.Result == nil && !it.Denied,
			it.Kind == "perm" && it.Decided == "":
			idx = append(idx, i)
		}
	}
	return idx
}

// A copy made at the boundary before a running turn has no open item, whatever the prefix holds:
// here a turn that was cut with text unfinished and a tool call unanswered. The source's own items
// stay as they are.
func TestCopyClosesOpenItems(t *testing.T) {
	t.Parallel()
	done := "ok"
	prefix := []model.Item{
		{Kind: "user", Text: "ask 1"},
		{Kind: "tool", ToolID: "t0", Name: "Read", Result: &done},
		{Kind: "tool", ToolID: "t1", Name: "Bash"},
		{Kind: "tool", ToolID: "t2", Name: "Write", Denied: true},
		{Kind: "text", Text: "cut he"},
		{Kind: "end", Point: "p1"},
	}
	// closed checks the copy's thread, in memory and in its file.
	closed := func(t *testing.T, e *env, id string) {
		t.Helper()
		for name, items := range map[string][]model.Item{"memory": e.itemsOn(id)[:len(prefix)], "file": e.diskItems(id)[:len(prefix)]} {
			if idx := open(items); len(idx) != 0 {
				t.Fatalf("%s: the copy has open items at %v: %+v", name, idx, items)
			}
			if it := items[2]; it.Result == nil || *it.Result != "" || !it.IsError || it.Denied {
				t.Fatalf("%s: the cut tool call is %+v", name, it)
			}
			if it := items[4]; !it.Done || it.Text != "cut he" {
				t.Fatalf("%s: the unfinished text is %+v", name, it)
			}
			want := append([]model.Item(nil), prefix...)
			want[2], want[4] = items[2], items[4]
			if !reflect.DeepEqual(items, want) {
				t.Fatalf("%s: the copy's other items changed: %+v", name, items)
			}
		}
	}
	// source makes the chat, with a turn running after the prefix.
	source := func(t *testing.T) (*env, string, *fakeAgent) {
		e := newEnv(t)
		id := e.stored(model.Claude, prefix)
		e.send(id, "ask 2", "")
		a := e.claude.last(t)
		a.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t3", ToolName: "Bash"})
		if !e.m.Busy(id) || !reflect.DeepEqual(open(e.items(id)), []int{2, 4, 7}) {
			t.Fatalf("source: busy %v, open %v", e.m.Busy(id), open(e.items(id)))
		}
		return e, id, a
	}
	untouched := func(t *testing.T, e *env, id string, a *fakeAgent) {
		t.Helper()
		if !e.m.Busy(id) || !reflect.DeepEqual(open(e.items(id)), []int{2, 4, 7}) {
			t.Fatalf("the source after the copy: busy %v, open %v", e.m.Busy(id), open(e.items(id)))
		}
		if !reflect.DeepEqual(e.items(id)[:len(prefix)], prefix) || a.isClosed() {
			t.Fatalf("the source's items changed: %+v", e.items(id))
		}
	}

	t.Run("fork", func(t *testing.T) {
		e, id, a := source(t)
		f := e.fork(id, len(prefix))
		closed(t, e, f.ID)
		untouched(t, e, id, a)
		e.send(f.ID, "hello fork", "")
		closed(t, e, f.ID)
		if n := notices(e.claude.lastFork(t).sent()[0]); len(n) != 0 {
			t.Fatalf("a notice without a subagent: %q", n)
		}
	})

	t.Run("new branch", func(t *testing.T) {
		e, id, a := source(t)
		_, bid, ba := e.branchTo(id, newAt(len(prefix)), "hello branch")
		closed(t, e, bid)
		if th, err := e.m.ThreadOf(id, model.MainBranch); err != nil || th.State.Status != model.StatusTool ||
			!reflect.DeepEqual(open(th.Items), []int{2, 4, 7}) || !reflect.DeepEqual(th.Items[:len(prefix)], prefix) || a.isClosed() {
			t.Fatalf("main after the branch: %+v, %v", th, err)
		}
		if got := texts(ba.sent()[0]); !reflect.DeepEqual(got, []string{"hello branch"}) {
			t.Fatalf("the branch's first message is %q", got)
		}
	})

	// Inside the running turn there is no point to copy at.
	t.Run("inside the turn", func(t *testing.T) {
		e, id, _ := source(t)
		if err := e.forkErr(id, len(prefix)+1); !errors.Is(err, ErrBadPoint) {
			t.Fatalf("Fork inside the running turn: %v", err)
		}
	})
}
