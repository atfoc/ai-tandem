package chats

import (
	"bytes"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// draftsOf is the drafts in the chat.json of the top-level chat id, as texts by branch id.
func (e *env) draftsOf(id string) map[string]string {
	e.t.Helper()
	m := e.meta(id)
	if m.Draft != nil {
		e.t.Fatalf("chat.json has the draft of a chat without branches' drafts: %+v", m.Draft)
	}
	out := map[string]string{}
	for b, d := range m.Drafts {
		if d == nil {
			e.t.Fatalf("chat.json has no draft under %q", b)
		}
		out[b] = d.Text
	}
	return out
}

// draftIn is the text of the draft in a state record or a view; "" for none.
func draftIn(d *model.Draft) string {
	if d == nil {
		return ""
	}
	return d.Text
}

// Each branch of a chat has its own draft, kept with the top-level chat. It reaches clients in the
// branch's state record, and a Send takes the draft of the branch it was sent on alone.
func TestDraftPerBranch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	branchFile := e.file(bid, "chat.json")
	evs := e.listen()

	// A draft for a branch that is not current: its record has it, the chat's view only says that
	// there is one.
	if err := e.setDraftOf(id, model.MainBranch, model.Draft{Text: "for main"}); err != nil {
		t.Fatal(err)
	}
	got := evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat"}) {
		t.Fatalf("events of main's draft %v", got)
	}
	if st := stateIn(t, got[0]); st.Chat != id || st.Branch != model.MainBranch || draftIn(st.Draft) != "for main" {
		t.Fatalf("main's state record %+v", st)
	}
	if vs := chatViews(t, got, id); len(vs) != 1 || vs[0].Draft != nil || !vs[0].HasDraft || vs[0].Branch != exBranch {
		t.Fatalf("the chat event of main's draft %+v", vs)
	}

	// One for the current branch, named and not named: the view has it as well.
	if err := e.setDraftOf(id, exBranch, model.Draft{Text: "for the branch"}); err != nil {
		t.Fatal(err)
	}
	got = evs.drain(t, e.br)
	if !reflect.DeepEqual(typesOf(got), []string{"branch_state", "chat"}) {
		t.Fatalf("events of the branch's draft %v", got)
	}
	if st := stateIn(t, got[0]); st.Chat != id || st.Branch != exBranch || draftIn(st.Draft) != "for the branch" {
		t.Fatalf("the branch's state record %+v", st)
	}
	if vs := chatViews(t, got, id); len(vs) != 1 || draftIn(vs[0].Draft) != "for the branch" || !vs[0].HasDraft {
		t.Fatalf("the chat event of the branch's draft %+v", vs)
	}
	if err := e.setDraft(id, model.Draft{Text: "B"}); err != nil {
		t.Fatal(err)
	}
	if st := statesOf(t, evs.drain(t, e.br), id, exBranch); len(st) != 1 || draftIn(st[0].Draft) != "B" {
		t.Fatalf("the state record of a draft for the current branch %+v", st)
	}
	if err := e.setDraftOf(id, model.MainBranch, model.Draft{Text: "A"}); err != nil {
		t.Fatal(err)
	}
	evs.drain(t, e.br)

	// They are in the top-level chat's chat.json alone, by branch id.
	if ds := e.draftsOf(id); !reflect.DeepEqual(ds, map[string]string{model.MainBranch: "A", exBranch: "B"}) {
		t.Fatalf("drafts %v", ds)
	}
	if !bytes.Equal(e.file(bid, "chat.json"), branchFile) {
		t.Fatal("the branch's chat.json changed")
	}
	// Every read of a branch has its own draft, and the same one until it changes.
	if v := e.view(id); draftIn(v.Draft) != "B" || v != e.view(id) {
		t.Fatalf("view %+v", v)
	}
	if a, b := e.stateOfBranch(id, model.MainBranch), e.stateOfBranch(id, exBranch); draftIn(a.Draft) != "A" || draftIn(b.Draft) != "B" ||
		a != e.stateOfBranch(id, model.MainBranch) || b != e.stateOfBranch(id, exBranch) {
		t.Fatalf("state records %+v, %+v", a, b)
	}
	for b, want := range map[string]string{model.MainBranch: "A", exBranch: "B", "": "B"} {
		if th, err := e.m.ThreadOf(id, b); err != nil || draftIn(th.State.Draft) != want {
			t.Fatalf("the draft read with the thread of %q: %+v, %v", b, th.State, err)
		}
	}
	evs.drain(t, e.br) // what loading the threads sent

	// A Send on B takes B's draft. A's survives it: in chat.json, in main's record, which is not
	// sent again, and in the view's "has a draft".
	e.send(id, "on the branch", "")
	a := e.claude.last(t)
	if ds := e.draftsOf(id); !reflect.DeepEqual(ds, map[string]string{model.MainBranch: "A"}) {
		t.Fatalf("drafts after a Send on the branch %v", ds)
	}
	got = evs.drain(t, e.br)
	if st := statesOf(t, got, id, exBranch); len(st) != 1 || st[0].Draft != nil || st[0].Status != model.StatusThinking {
		t.Fatalf("the branch's state record after its Send %+v", st)
	}
	if st := statesOf(t, got, id, model.MainBranch); len(st) != 0 {
		t.Fatalf("main's state record was sent for a Send on another branch: %+v", st)
	}
	if vs := chatViews(t, got, id); len(vs) != 1 || vs[0].Draft != nil || !vs[0].HasDraft {
		t.Fatalf("the chat event of the Send %+v", vs)
	}
	if st := e.stateOfBranch(id, model.MainBranch); draftIn(st.Draft) != "A" {
		t.Fatalf("main's record after a Send on the branch %+v", st)
	}

	// The next message is typed while the branch works: its record keeps the draft through the
	// events of the turn.
	if err := e.setDraftOf(id, exBranch, model.Draft{Text: "B2"}); err != nil {
		t.Fatal(err)
	}
	evs.drain(t, e.br)
	a.emit(t, reply("q2")...)
	got = evs.drain(t, e.br)
	st := statesOf(t, got, id, exBranch)
	if len(st) == 0 {
		t.Fatalf("no state record for the turn: %v", got)
	}
	for _, s := range st {
		if draftIn(s.Draft) != "B2" {
			t.Fatalf("a state record of the turn without the draft: %+v", st)
		}
	}
	if last := st[len(st)-1]; last.Status != model.StatusReady {
		t.Fatalf("the last state record of the turn %+v", last)
	}

	// A Send to the end of main takes A's and leaves B's; so does a restart.
	e.sendTo(id, Target{Branch: model.MainBranch, End: true}, "on main")
	if ds := e.draftsOf(id); !reflect.DeepEqual(ds, map[string]string{exBranch: "B2"}) {
		t.Fatalf("drafts after a Send on main %v", ds)
	}
	if v := e.view(id); v.Branch != "" || v.Draft != nil || !v.HasDraft {
		t.Fatalf("view after a Send on main %+v", v)
	}
	if st := statesOf(t, evs.drain(t, e.br), id, model.MainBranch); len(st) == 0 || st[len(st)-1].Draft != nil {
		t.Fatalf("main's state records after its Send %+v", st)
	}
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p3"})
	if err := e.setDraftOf(id, model.MainBranch, model.Draft{Text: "A2"}); err != nil {
		t.Fatal(err)
	}
	e.boot()
	if a, b := e.stateOfBranch(id, model.MainBranch), e.stateOfBranch(id, exBranch); draftIn(a.Draft) != "A2" || draftIn(b.Draft) != "B2" {
		t.Fatalf("state records after a restart %+v, %+v", a, b)
	}
	if v := e.view(id); draftIn(v.Draft) != "A2" || !v.HasDraft {
		t.Fatalf("view after a restart %+v", v)
	}

	// Clearing one leaves the other; a branch the chat does not have gets none.
	if err := e.setDraftOf(id, model.MainBranch, model.Draft{}); err != nil {
		t.Fatal(err)
	}
	if err := e.setDraftOf(id, "nope", model.Draft{Text: "x"}); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("SetDraftOf on an unknown branch: %v", err)
	}
	if err := e.setDraftOf(bid, "", model.Draft{Text: "x"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetDraftOf on a branch's server id: %v", err)
	}
	if ds := e.draftsOf(id); !reflect.DeepEqual(ds, map[string]string{exBranch: "B2"}) {
		t.Fatalf("drafts after clearing main's %v", ds)
	}
}

// A chat.json written before drafts were per branch has one draft for the chat: it becomes the
// draft of the chat's current branch when the chat is loaded, and is written at once.
func TestDraftMigration(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	plain := e.create(model.Claude, gOne, "")
	none := e.create(model.Claude, gOne, "")
	for _, c := range []string{id, plain.ID} {
		m := e.meta(c)
		m.Draft = &model.Draft{Text: "typed", Mentions: []model.Mention{{Name: "Plan", ID: "b_1"}}}
		e.writeMeta(m)
		if raw := string(e.file(c, "chat.json")); !strings.Contains(raw, `"draft":`) || strings.Contains(raw, `"drafts"`) {
			t.Fatalf("the old chat.json %s", raw)
		}
	}
	branchFile, noneFile := e.file(bid, "chat.json"), e.file(none.ID, "chat.json")
	e.boot()

	// Written at boot, before anything else happened to the chat.
	want := &model.Draft{Text: "typed", Mentions: []model.Mention{{Name: "Plan", ID: "b_1"}}}
	for c, branch := range map[string]string{id: exBranch, plain.ID: model.MainBranch} {
		m := e.meta(c)
		if !reflect.DeepEqual(m.Drafts, map[string]*model.Draft{branch: want}) || m.Draft != nil {
			t.Fatalf("chat.json after the boot: drafts %+v, draft %+v", m.Drafts, m.Draft)
		}
		if raw := string(e.file(c, "chat.json")); strings.Contains(raw, `"draft":`) {
			t.Fatalf("chat.json still has the old field: %s", raw)
		}
		if v := e.view(c); !reflect.DeepEqual(v.Draft, want) || !v.HasDraft {
			t.Fatalf("view after the boot %+v", v)
		}
		if st := e.stateOfBranch(c, branch); !reflect.DeepEqual(st.Draft, want) {
			t.Fatalf("the record of %s after the boot %+v", branch, st)
		}
	}
	if st := e.stateOfBranch(id, model.MainBranch); st.Draft != nil {
		t.Fatalf("main got the draft of the current branch: %+v", st)
	}
	if !bytes.Equal(e.file(bid, "chat.json"), branchFile) || !bytes.Equal(e.file(none.ID, "chat.json"), noneFile) {
		t.Fatal("a chat.json without a draft changed at the boot")
	}

	// The current branch changes, and nothing else is saved before the next boot: the draft stays
	// the branch's it was given to. A second boot changes nothing.
	e.makeCurrent(id, model.MainBranch)
	topFile, plainFile := e.file(id, "chat.json"), e.file(plain.ID, "chat.json")
	e.boot()
	if !bytes.Equal(e.file(id, "chat.json"), topFile) || !bytes.Equal(e.file(plain.ID, "chat.json"), plainFile) {
		t.Fatal("a second boot changed a chat.json")
	}
	if v := e.view(id); v.Branch != "" || v.Draft != nil || !v.HasDraft {
		t.Fatalf("view after the second boot %+v", v)
	}
	if st := e.stateOfBranch(id, exBranch); !reflect.DeepEqual(st.Draft, want) {
		t.Fatalf("the branch's record after the second boot %+v", st)
	}

	// With a draft of the new form for the current branch, the old one is dropped.
	m := e.meta(id)
	m.Draft = &model.Draft{Text: "older"}
	m.Drafts[model.MainBranch] = &model.Draft{Text: "newer"}
	e.writeMeta(m)
	e.boot()
	if ds := e.draftsOf(id); !reflect.DeepEqual(ds, map[string]string{model.MainBranch: "newer", exBranch: "typed"}) {
		t.Fatalf("drafts %v", ds)
	}
}

// Drafts are typed on both branches while one of them works and the chat is read: a branch's view
// takes its top-level chat's lock for the draft, after its own, and nothing else may take them the
// other way round.
func TestDraftsWhileABranchWorks(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", exBranch)
	e.send(id, "on the branch", "")
	a := e.claude.last(t)
	var wg sync.WaitGroup
	for _, b := range []string{model.MainBranch, exBranch, ""} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				// Two of the three write the current branch's draft: one that lost to the
				// other is refused, which is what the counter is for.
				if err := e.setDraftOf(id, b, model.Draft{Text: strings.Repeat("x", i%3)}); err != nil && !errors.Is(err, ErrStaleDraft) {
					t.Error(err)
				}
			}
		}()
	}
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			e.m.States()
			e.m.Views()
			if _, err := e.m.ThreadOf(id, model.MainBranch); err != nil {
				t.Error(err)
			}
			if err := e.m.Rename(id, "Named", true); err != nil {
				t.Error(err)
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			a.emit(t, agent.Event{Kind: agent.EvText, Text: "x"})
		}
	}()
	wg.Wait()
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "q2"})
	for _, b := range []string{model.MainBranch, exBranch} {
		if err := e.setDraftOf(id, b, model.Draft{Text: "last on " + b}); err != nil {
			t.Fatal(err)
		}
	}
	if ds := e.draftsOf(id); !reflect.DeepEqual(ds, map[string]string{model.MainBranch: "last on main", exBranch: "last on " + exBranch}) {
		t.Fatalf("drafts %v", ds)
	}
	if st := e.stateOfBranch(id, exBranch); draftIn(st.Draft) != "last on "+exBranch || st.Status != model.StatusReady {
		t.Fatalf("the branch's record %+v", st)
	}
}

// The chat's view says whether any of its branches has a draft, whichever is current.
func TestHasDraft(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", exBranch)
	evs := e.listen()
	has := func(what string, want bool, draft string) {
		t.Helper()
		v := e.view(id)
		if v.HasDraft != want || draftIn(v.Draft) != draft {
			t.Fatalf("%s: hasDraft %v, draft %+v", what, v.HasDraft, v.Draft)
		}
		if vs := e.m.Views(); len(vs) != 1 || vs[0] != v {
			t.Fatalf("%s: Views %+v, view %+v", what, vs, v)
		}
		// The last chat event said the same.
		vs := chatViews(t, evs.drain(t, e.br), id)
		if len(vs) == 0 {
			t.Fatalf("%s: no chat event", what)
		}
		if last := vs[len(vs)-1]; last.HasDraft != want || draftIn(last.Draft) != draft {
			t.Fatalf("%s: the chat event has hasDraft %v, draft %+v", what, last.HasDraft, last.Draft)
		}
	}
	set := func(branch, text string) {
		t.Helper()
		if err := e.setDraftOf(id, branch, model.Draft{Text: text}); err != nil {
			t.Fatal(err)
		}
	}

	if v := e.view(id); v.HasDraft || v.Draft != nil {
		t.Fatalf("a chat without drafts: %+v", v)
	}
	if _, ok := asJSON(t, e.view(id)).(map[string]any)["hasDraft"]; ok {
		t.Fatal("the view of a chat without drafts has hasDraft")
	}
	set(model.MainBranch, "A")
	has("a draft on a branch that is not current", true, "")
	set(exBranch, "B")
	has("a draft on each branch", true, "B")
	set(model.MainBranch, "")
	has("main's cleared", true, "B")
	set(exBranch, "")
	has("both cleared", false, "")

	// A change of the current branch changes the draft shown, not whether there is one.
	set(model.MainBranch, "A")
	e.makeCurrent(id, model.MainBranch)
	has("main current, with its draft", true, "A")
	e.makeCurrent(id, exBranch)
	has("the branch current, main with a draft", true, "")

	// A Send on a branch without a draft leaves it; the Send that takes the last draft ends it.
	e.send(id, "on the branch", "")
	has("after a Send on the branch", true, "")
	e.claude.last(t).emit(t, reply("q2")...)
	e.sendTo(id, Target{Branch: model.MainBranch, End: true}, "on main")
	has("after a Send on main", false, "")
}
