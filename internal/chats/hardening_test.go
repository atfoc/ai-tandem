package chats

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// chatObj is the chat object with the server id id.
func (e *env) chatObj(id string) *Chat {
	e.t.Helper()
	c, err := e.m.get(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

// queued is what an agent event that changed the chat object c leaves in an outbox: c's state
// record, then its chat event.
func (e *env) queued(c *Chat) outbox {
	var out outbox
	c.mu.Lock()
	out.emitChat(c)
	c.mu.Unlock()
	return out
}

// Nothing of a chat is sent after its chat_removed: what was queued for it, or for one of its
// branches, before the chat was deleted is dropped when it is sent.
func TestNothingSentAfterChatRemoved(t *testing.T) {
	e := newEnv(t)
	plain := e.create(model.Claude, gOne, "")
	e.send(plain.ID, "one", "")
	id, bid := e.branched(model.Claude, "", exBranch)
	evs := e.listen()

	// What is queued is sent, while the chat is there.
	top, branch := e.chatObj(id), e.chatObj(bid)
	e.m.send(e.queued(top))
	if got := evs.drain(t, e.br); !reflect.DeepEqual(typesOf(got), []string{"branch_state"}) { // main is not current: no chat event
		t.Fatalf("events of main %v", typesOf(got))
	}
	e.m.send(e.queued(branch))
	got := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat"}) {
		t.Fatalf("events of the branch %v", typesOf(got))
	}
	// The wire shape of a state record.
	if st := stateIn(t, got[0]); st != e.stateOfBranch(id, exBranch) || len(got[0]) != 2 {
		t.Fatalf("the state event %v", got[0])
	}

	for _, tc := range []struct {
		name string
		id   string
		objs []*Chat
	}{
		{"a chat with one branch", plain.ID, []*Chat{e.chatObj(plain.ID)}},
		{"a chat with two", id, []*Chat{top, branch}},
	} {
		var out outbox
		for _, c := range tc.objs {
			out = append(out, e.queued(c)...)
			c.mu.Lock()
			out.emitRecord(c)
			c.mu.Unlock()
		}
		if err := e.m.Delete(tc.id); err != nil {
			t.Fatal(err)
		}
		e.m.send(out)
		got := evs.drain(t, e.br)
		if n := len(got); n == 0 || got[n-1]["type"] != "chat_removed" || got[n-1]["id"] != tc.id {
			t.Fatalf("%s: events sent after chat_removed: %v", tc.name, typesOf(got))
		}
		if n := len(ofType(got, "chat_removed")); n != 1 {
			t.Fatalf("%s: %d chat_removed events", tc.name, n)
		}
	}
}

// Only the drafts of the chat's registered branches count for hasDraft: one stored under another
// id (a branch that was skipped at load) is left in chat.json and not counted.
func TestHasDraftOnlyOfRegisteredBranches(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", "")
	has := func(what string, want bool) {
		t.Helper()
		v := e.view(id)
		if v.HasDraft != want {
			t.Fatalf("%s: hasDraft %v", what, v.HasDraft)
		}
		if vs := e.m.Views(); len(vs) != 1 || vs[0] != v {
			t.Fatalf("%s: Views %+v, view %+v", what, vs, v)
		}
		if _, ok := asJSON(t, v).(map[string]any)["hasDraft"]; ok != want {
			t.Fatalf("%s: hasDraft in the view's JSON: %v", what, ok)
		}
	}
	stored := func(what string, want map[string]string) {
		t.Helper()
		if got := e.draftsOf(id); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: chat.json has the drafts %v, want %v", what, got, want)
		}
	}

	// An entry under an id the chat has no branch of.
	meta := e.meta(id)
	meta.Drafts = map[string]*model.Draft{"ghost": {Text: "lost"}}
	e.writeMeta(meta)
	e.boot()
	has("a draft under an unknown branch id", false)
	stored("after the boot", map[string]string{"ghost": "lost"})

	// A registered branch's counts, and the chat event says so; the other entry stays in the file.
	evs := e.listen()
	if err := e.m.SetDraftOf(id, exBranch, model.Draft{Text: "B"}); err != nil {
		t.Fatal(err)
	}
	has("a draft on a registered branch", true)
	if vs := chatViews(t, evs.drain(t, e.br), id); len(vs) != 1 || !vs[0].HasDraft {
		t.Fatalf("the chat event of the branch's draft %+v", vs)
	}
	stored("with the branch's draft", map[string]string{"ghost": "lost", exBranch: "B"})
	if err := e.m.SetDraftOf(id, "ghost", model.Draft{}); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("clearing the draft of an unknown branch: %v", err)
	}

	// The branch is skipped at the next load: its draft is under no branch now.
	if err := os.Remove(filepath.Join(e.st.P.ChatDir(bid), "chat.json")); err != nil {
		t.Fatal(err)
	}
	e.boot()
	if v := e.view(id); v.Branches != 0 {
		t.Fatalf("the branch was not skipped: %+v", v)
	}
	has("the draft of a branch that was skipped", false)
	stored("after the branch was skipped", map[string]string{"ghost": "lost", exBranch: "B"})

	// Main's counts, and a Send on main ends it; the entries under no branch are still stored.
	evs = e.listen()
	if err := e.m.SetDraftOf(id, model.MainBranch, model.Draft{Text: "A"}); err != nil {
		t.Fatal(err)
	}
	has("a draft on main", true)
	if vs := chatViews(t, evs.drain(t, e.br), id); len(vs) != 1 || !vs[0].HasDraft || draftIn(vs[0].Draft) != "A" {
		t.Fatalf("the chat event of main's draft %+v", vs)
	}
	e.send(id, "on main", "")
	has("after a Send on main", false)
	if vs := chatViews(t, evs.drain(t, e.br), id); len(vs) == 0 || vs[len(vs)-1].HasDraft {
		t.Fatalf("the chat events of the Send %+v", vs)
	}
	stored("after the Send", map[string]string{"ghost": "lost", exBranch: "B"})
}

// published fails unless the drafts the top-level chat id publishes for its branches' views are
// the very map its meta holds.
func (e *env) published(when, id string) {
	e.t.Helper()
	top := e.chatObj(id)
	top.mu.Lock()
	defer top.mu.Unlock()
	pub, meta := draftsOf(top), top.meta.Drafts
	if len(pub) != len(meta) || reflect.ValueOf(pub).Pointer() != reflect.ValueOf(meta).Pointer() {
		e.t.Fatalf("%s: the chat publishes the drafts %v, its meta has %v", when, pub, meta)
	}
}

// Every change of a chat's drafts is published for its branches' views, and a draft's pointer
// stays the same until that draft changes.
func TestDraftsPublished(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	draftOf := func(server string) *model.Draft {
		t.Helper()
		c := e.chatObj(server)
		c.mu.Lock()
		defer c.mu.Unlock()
		return view(c).Draft
	}

	// A load, and the draft from before drafts were per branch.
	e.published("a chat without drafts", id)
	meta := e.meta(id)
	meta.Draft = &model.Draft{Text: "old"}
	e.writeMeta(meta)
	e.boot()
	e.published("after the old draft was moved", id)
	if d := draftOf(bid); draftIn(d) != "old" || draftOf(id) != nil {
		t.Fatalf("the moved draft: the branch has %+v, main %+v", d, draftOf(id))
	}
	e.boot()
	e.published("after a load", id)
	kept := draftOf(bid)
	if draftIn(kept) != "old" {
		t.Fatalf("the branch's draft after a load %+v", kept)
	}

	// A draft set and cleared; another branch's keeps its pointer.
	for _, text := range []string{"A", "A2", ""} {
		if err := e.m.SetDraftOf(id, model.MainBranch, model.Draft{Text: text}); err != nil {
			t.Fatal(err)
		}
		e.published("main's draft "+text, id)
		if d := draftOf(id); draftIn(d) != text {
			t.Fatalf("main's draft %+v, want %q", d, text)
		}
		if d := draftOf(bid); d != kept || d != draftOf(bid) {
			t.Fatalf("the branch's draft changed with main's: %p, was %p", d, kept)
		}
	}
	if err := e.m.SetDraftOf(id, exBranch, model.Draft{Text: "B"}); err != nil {
		t.Fatal(err)
	}
	e.published("the branch's draft", id)
	if d := draftOf(bid); draftIn(d) != "B" || d == kept {
		t.Fatalf("the branch's new draft %+v", d)
	}

	// A Send takes its branch's: the current branch's, then main's.
	if err := e.m.SetDraftOf(id, model.MainBranch, model.Draft{Text: "A"}); err != nil {
		t.Fatal(err)
	}
	e.send(id, "on the branch", "")
	e.published("after a Send on the branch", id)
	if draftOf(bid) != nil || draftIn(draftOf(id)) != "A" {
		t.Fatalf("after a Send on the branch: the branch has %+v, main %+v", draftOf(bid), draftOf(id))
	}
	e.claude.last(t).emit(t, reply("q2")...)
	e.sendTo(id, Target{Branch: model.MainBranch, End: true}, "on main")
	e.published("after a Send on main", id)
	if draftOf(id) != nil || e.meta(id).Drafts != nil {
		t.Fatalf("after a Send on main: main has %+v, chat.json %+v", draftOf(id), e.meta(id).Drafts)
	}
	e.claude.last(t).emit(t, reply("p3")...)

	// A fork made to edit a message starts with that message as main's draft.
	three := 3
	v, err := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 3, Message: &three})
	if err != nil {
		t.Fatal(err)
	}
	e.published("a fork with a draft", v.ID)
	if d := draftOf(v.ID); draftIn(d) != "redis" || len(draftsOf(e.chatObj(v.ID))) != 1 {
		t.Fatalf("the fork's draft %+v", d)
	}
}

// A branch's view and state record wait for nothing its top-level chat holds: its agent's events,
// a read of it and its record go through while the top-level chat's lock is held (as it is for
// the whole start of main's process).
func TestBranchDoesNotWaitForItsChat(t *testing.T) {
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", "")
	_, branchAg := e.bothRunning(id)
	if err := e.m.SetDraftOf(id, exBranch, model.Draft{Text: "typed on the branch"}); err != nil {
		t.Fatal(err)
	}
	e.makeCurrent(id, model.MainBranch)
	branchAg.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "w"}) // its turn: the chat event of the count is sent here
	evs := e.listen()

	top, branch := e.chatObj(id), e.chatObj(bid)
	done := make(chan model.BranchState, 1)
	var thread Thread
	var threadErr error
	func() {
		top.mu.Lock()
		defer top.mu.Unlock()
		go func() {
			// The pump: a tool starts, which changes the branch's record and not the chat's counts.
			branchAg.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"})
			// A client's read of the branch.
			thread, threadErr = e.m.ThreadOf(id, exBranch)
			// The record alone, queued and sent.
			var out outbox
			branch.mu.Lock()
			v := view(branch)
			out.emitRecord(branch)
			branch.mu.Unlock()
			e.m.send(out)
			done <- model.StateOf(id, exBranch, v)
		}()
		select {
		case st := <-done:
			// The draft is the one the top-level chat stores, by pointer.
			if st.Draft == nil || st.Draft != top.meta.Drafts[exBranch] || st.Status != model.StatusTool {
				t.Errorf("the branch's record under its chat's lock %+v", st)
			}
			if threadErr != nil || thread.State != st {
				t.Errorf("the branch read under its chat's lock: %+v, %v; its record %+v", thread.State, threadErr, st)
			}
		case <-time.After(3 * time.Second):
			t.Error("the branch waited for its top-level chat's lock")
		}
	}()
	if t.Failed() {
		return
	}
	got := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"chat_items", "branch_state", "branch_state"}) {
		t.Fatalf("events sent under the chat's lock %v", typesOf(got))
	}
	for _, ev := range got[1:] {
		if st := stateIn(t, ev); !reflect.DeepEqual(st, thread.State) || draftIn(st.Draft) != "typed on the branch" {
			t.Fatalf("the state record sent %+v, want %+v", st, thread.State)
		}
	}
}

// The chat events of one chat are composed and broadcast one at a time, in the order they were
// composed in: the counts of working branches are read when an event is composed, so an event
// must not pass one that read them earlier. Another chat's events are not held up.
//
// The current branch's turn starts while the top-level chat's lock is held: its chat event waits
// for that lock, being composed. A second chat event of the chat, which needs no lock that is
// held, must wait behind it.
func TestChatEventsOfAChatSentInOrder(t *testing.T) {
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", "")
	_, branchAg := e.bothRunning(id) // the branch is current; both are idle
	other := e.create(model.Claude, gOne, "")
	evs := e.listen()
	top := e.chatObj(id)

	var second outbox // the chat's identity, as a rename queues it
	top.mu.Lock()
	second.emitIdentity(top)
	top.mu.Unlock()

	var wg sync.WaitGroup
	passed := make(chan struct{})
	func() {
		top.mu.Lock()
		defer top.mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			branchAg.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "w"})
		}()
		// The pump sent the branch's record and is composing the chat event.
		evs.wait(t, func(ev map[string]any) bool { return ev["type"] == "branch_state" })
		for until := time.Now().Add(2 * time.Second); time.Now().Before(until) && top.sendMu.TryLock(); {
			top.sendMu.Unlock()
			time.Sleep(time.Millisecond)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			e.m.send(second)
			close(passed)
		}()
		e.m.send(e.queued(e.chatObj(other.ID)))
		select {
		case <-passed:
			t.Error("a chat event of the chat was sent while an earlier one was being composed")
		case <-time.After(200 * time.Millisecond):
		}
		got := evs.drain(t, e.br)
		if vs := chatViews(t, got, id); len(vs) != 0 {
			t.Errorf("chat events of the chat sent under its lock: %+v", vs)
		}
		if vs := chatViews(t, got, other.ID); len(vs) != 1 {
			t.Errorf("%d chat events of another chat, want 1", len(vs))
		}
	}()
	wg.Wait()
	if t.Failed() {
		return
	}
	sent := chatViews(t, evs.drain(t, e.br), id)
	if len(sent) != 2 || sent[1].Working != 1 || e.view(id).Working != 1 {
		t.Fatalf("the chat events sent once the lock was free: %+v", sent)
	}
}

// One branch's turn ends as another's starts, on their two pumps, many times over. Each round has
// one true count once both are done (1), and both counts an event sent out of order would carry
// are wrong (0: read after the end and before the start; 2: before the end and after the start).
//
// It is a stress loop, mostly for the race detector and for a deadlock of the two pumps: the gap
// between reading the counts and the broadcast is too short for it to catch a missing sendMu (it
// did not in 2700 rounds without the lock). TestChatEventsOfAChatSentInOrder is the test of the
// lock.
func TestBranchesFlipTogether(t *testing.T) {
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", "")
	mainAg, branchAg := e.bothRunning(id) // the branch is current; both are idle
	evs := e.listen()
	rounds := 40
	if testing.Short() {
		rounds = 10
	}
	for i := 0; i < rounds; i++ {
		ends, starts := mainAg, branchAg
		if i%2 == 1 {
			ends, starts = branchAg, mainAg
		}
		ends.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "w"})
		evs.drain(t, e.br)
		var wg sync.WaitGroup
		wg.Add(2)
		begin := make(chan struct{})
		go func() {
			defer wg.Done()
			<-begin
			ends.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p"})
		}()
		go func() {
			defer wg.Done()
			<-begin
			starts.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "w"})
		}()
		close(begin)
		wg.Wait()
		if t.Failed() {
			return
		}
		if v := e.view(id); v.Working != 1 {
			t.Fatalf("round %d: %d branches work", i, v.Working)
		}
		sent := chatViews(t, evs.drain(t, e.br), id)
		if n := len(sent); n < 2 || sent[n-1].Working != 1 {
			var seq []int
			for _, v := range sent {
				seq = append(seq, v.Working)
			}
			t.Fatalf("round %d: the chat events' counts %v: the last is not the count of working branches (1)", i, seq)
		}
		starts.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p"})
	}
}
