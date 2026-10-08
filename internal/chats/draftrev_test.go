package chats

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// setDraft is SetDraft on the counter the draft has now, which is what a page that is up to date
// sends: for the tests that are about the draft and not about its counter.
func (e *env) setDraft(id string, d model.Draft) error { return e.setDraftOf(id, "", d) }

// setDraftOf is setDraft for the branch named ("" = the current one).
func (e *env) setDraftOf(id, branch string, d model.Draft) error {
	_, _, err := e.m.SetDraftOf(id, branch, e.draftRev(id, branch), d)
	return err
}

// draftRev is the counter of the draft of a branch ("" = the current one) as the manager has it;
// 0 for a chat or a branch it does not have.
func (e *env) draftRev(id, branch string) int64 {
	top, err := e.m.topChat(id)
	if err != nil {
		return 0
	}
	if branch == "" {
		branch = model.MainBranch
		if b := e.m.current(top); b != top {
			branch = b.branch
		}
	}
	_, rev := draftAt(top, branch)
	return rev
}

// A write that names the counter the draft has is stored and raises it; one that names another
// is refused with the stored counter and the stored draft, and changes nothing.
func TestDraftCounter(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if v.DraftRev != 0 || strings.Contains(string(e.file(v.ID, "chat.json")), "draftRevs") {
		t.Fatalf("a new chat has a draft counter: %+v", v)
	}
	rev, stored, err := e.m.SetDraft(v.ID, 0, model.Draft{Text: "one"})
	if err != nil || rev != 1 || stored != nil {
		t.Fatalf("the first write: rev %d, stored %+v, err %v", rev, stored, err)
	}
	rev, stored, err = e.m.SetDraftOf(v.ID, model.MainBranch, 1, model.Draft{Text: "two"})
	if err != nil || rev != 2 || stored != nil {
		t.Fatalf("the second write: rev %d, stored %+v, err %v", rev, stored, err)
	}
	if got := e.view(v.ID); got.DraftRev != 2 || draftIn(got.Draft) != "two" {
		t.Fatalf("view %+v", got)
	}
	if st := e.stateOfBranch(v.ID, model.MainBranch); st.DraftRev != 2 || draftIn(st.Draft) != "two" {
		t.Fatalf("state record %+v", st)
	}
	if m := e.meta(v.ID); !reflect.DeepEqual(m.DraftRevs, map[string]int64{model.MainBranch: 2}) {
		t.Fatalf("chat.json counters %+v", m.DraftRevs)
	}

	// A late write, typed on the first draft.
	evs := e.listen()
	for _, base := range []int64{0, 1, 3} {
		rev, stored, err = e.m.SetDraft(v.ID, base, model.Draft{Text: "late"})
		if !errors.Is(err, ErrStaleDraft) || rev != 2 || draftIn(stored) != "two" {
			t.Fatalf("a write on %d: rev %d, stored %+v, err %v", base, rev, stored, err)
		}
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("events of a refused write %v", got)
	}
	if m := e.meta(v.ID); draftIn(m.Drafts[model.MainBranch]) != "two" || m.DraftRevs[model.MainBranch] != 2 {
		t.Fatalf("chat.json after a refused write %+v %+v", m.Drafts, m.DraftRevs)
	}

	// A clear keeps the counter, and so does a restart: the write typed before the clear is
	// still refused, now with no stored draft.
	if rev, _, err = e.m.SetDraft(v.ID, 2, model.Draft{}); err != nil || rev != 3 {
		t.Fatalf("the clear: rev %d, err %v", rev, err)
	}
	if m := e.meta(v.ID); m.Drafts != nil || !reflect.DeepEqual(m.DraftRevs, map[string]int64{model.MainBranch: 3}) {
		t.Fatalf("chat.json after the clear %+v %+v", m.Drafts, m.DraftRevs)
	}
	e.boot()
	if got := e.view(v.ID); got.DraftRev != 3 || got.Draft != nil {
		t.Fatalf("view after the restart %+v", got)
	}
	rev, stored, err = e.m.SetDraft(v.ID, 2, model.Draft{Text: "late"})
	if !errors.Is(err, ErrStaleDraft) || rev != 3 || stored != nil {
		t.Fatalf("a late write after the restart: rev %d, stored %+v, err %v", rev, stored, err)
	}
	// A clear of a draft that is not there changes nothing, so it counts nothing.
	if rev, _, err = e.m.SetDraft(v.ID, 3, model.Draft{}); err != nil || rev != 3 {
		t.Fatalf("a clear of no draft: rev %d, err %v", rev, err)
	}
	if rev, _, err = e.m.SetDraft(v.ID, 3, model.Draft{Text: "three"}); err != nil || rev != 4 {
		t.Fatalf("a write after the restart: rev %d, err %v", rev, err)
	}
	e.boot() // a load only publishes the drafts: it counts nothing
	if got := e.view(v.ID); got.DraftRev != 4 || draftIn(got.Draft) != "three" {
		t.Fatalf("view after the second restart %+v", got)
	}
	if m := e.meta(v.ID); m.DraftRevs[model.MainBranch] != 4 {
		t.Fatalf("chat.json after the second restart %+v", m.DraftRevs)
	}
}

// A Send clears the draft of its branch, which is a change of it: the counter goes up, so a
// save of the text that was just sent, still on its way, is refused.
func TestSendRaisesDraftCounter(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if rev, _, err := e.m.SetDraft(v.ID, 0, model.Draft{Text: "one"}); err != nil || rev != 1 {
		t.Fatalf("rev %d, err %v", rev, err)
	}
	e.send(v.ID, "one", "")
	if got := e.view(v.ID); got.DraftRev != 2 || got.Draft != nil {
		t.Fatalf("view after the Send %+v", got)
	}
	if m := e.meta(v.ID); m.Drafts != nil || m.DraftRevs[model.MainBranch] != 2 {
		t.Fatalf("chat.json after the Send %+v %+v", m.Drafts, m.DraftRevs)
	}
	rev, stored, err := e.m.SetDraft(v.ID, 1, model.Draft{Text: "one"})
	if !errors.Is(err, ErrStaleDraft) || rev != 2 || stored != nil {
		t.Fatalf("the late save: rev %d, stored %+v, err %v", rev, stored, err)
	}
}

// Each branch has its own counter, kept with the top-level chat, and a Send on a branch raises
// that branch's alone.
func TestDraftCounterPerBranch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, bid := e.branched(model.Claude, "", exBranch)
	branchFile := e.file(bid, "chat.json")
	if rev, _, err := e.m.SetDraftOf(id, model.MainBranch, 0, model.Draft{Text: "A"}); err != nil || rev != 1 {
		t.Fatalf("main: rev %d, err %v", rev, err)
	}
	for i, text := range []string{"B", "B2"} {
		if rev, _, err := e.m.SetDraftOf(id, exBranch, int64(i), model.Draft{Text: text}); err != nil || rev != int64(i)+1 {
			t.Fatalf("the branch: rev %d, err %v", rev, err)
		}
	}
	rev, stored, err := e.m.SetDraftOf(id, model.MainBranch, 2, model.Draft{Text: "late"}) // the branch's counter
	if !errors.Is(err, ErrStaleDraft) || rev != 1 || draftIn(stored) != "A" {
		t.Fatalf("main on the branch's counter: rev %d, stored %+v, err %v", rev, stored, err)
	}
	if m := e.meta(id); !reflect.DeepEqual(m.DraftRevs, map[string]int64{model.MainBranch: 1, exBranch: 2}) {
		t.Fatalf("chat.json counters %+v", m.DraftRevs)
	}
	if string(e.file(bid, "chat.json")) != string(branchFile) {
		t.Fatalf("the branch's own chat.json changed: %s", e.file(bid, "chat.json"))
	}
	a, b := e.stateOfBranch(id, model.MainBranch), e.stateOfBranch(id, exBranch)
	if a.DraftRev != 1 || b.DraftRev != 2 {
		t.Fatalf("state records %+v, %+v", a, b)
	}
	if got := e.view(id); got.Branch != exBranch || got.DraftRev != 2 || draftIn(got.Draft) != "B2" { // the current branch's
		t.Fatalf("view %+v", got)
	}

	e.send(id, "B2", "") // on the current branch
	e.boot()
	a, b = e.stateOfBranch(id, model.MainBranch), e.stateOfBranch(id, exBranch)
	if a.DraftRev != 1 || draftIn(a.Draft) != "A" || b.DraftRev != 3 || b.Draft != nil {
		t.Fatalf("state records after the Send and a restart %+v, %+v", a, b)
	}
	if m := e.meta(id); !reflect.DeepEqual(m.DraftRevs, map[string]int64{model.MainBranch: 1, exBranch: 3}) {
		t.Fatalf("chat.json counters after the Send %+v", m.DraftRevs)
	}
}

// A draft saved while a Send is starting the agent is a new draft, not the message: the Send
// leaves it and its counter alone. The first message of a fork whose process is gone (here by a
// restart) is such a Send: the chat is not locked while the agent makes the fork again.
func TestSendKeepsDraftSavedSince(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	v, err := e.forkWith(id, 3, "", "")
	if err != nil {
		t.Fatal(err)
	}
	w, err := e.forkWith(id, 3, "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{v.ID, w.ID} {
		if rev, _, err := e.m.SetDraft(f, 0, model.Draft{Text: "sent"}); err != nil || rev != 1 {
			t.Fatalf("the draft that is sent: rev %d, err %v", rev, err)
		}
	}
	e.boot()
	evs := e.listen()
	b, res := e.block(e.claude, func() error { return e.m.Send(v.ID, "sent", "", nil) })
	// The start shows with the draft that is being sent still there.
	if st := statesOf(t, evs.drain(t, e.br), v.ID, model.MainBranch); len(st) != 1 || st[0].Status != model.StatusThinking || st[0].DraftRev != 1 || draftIn(st[0].Draft) != "sent" {
		t.Fatalf("state records of the start %+v", st)
	}
	rev, stored, err := e.m.SetDraft(v.ID, 1, model.Draft{Text: "next"})
	if err != nil || rev != 2 || stored != nil {
		t.Fatalf("the save during the start: rev %d, stored %+v, err %v", rev, stored, err)
	}
	if st := statesOf(t, evs.drain(t, e.br), v.ID, model.MainBranch); len(st) != 1 || st[0].DraftRev != 2 || draftIn(st[0].Draft) != "next" {
		t.Fatalf("state records of the save %+v", st)
	}
	if err := b.release(res, nil); err != nil {
		t.Fatal(err)
	}
	// The message is in the thread, and the draft is the one saved since, on the counter that
	// save gave it: no state record says otherwise.
	if items := e.items(v.ID); len(items) == 0 || items[len(items)-1].Text != "sent" {
		t.Fatalf("the fork's thread after the Send %+v", items)
	}
	st := statesOf(t, evs.drain(t, e.br), v.ID, model.MainBranch)
	if len(st) == 0 {
		t.Fatal("the Send sent no state record")
	}
	for _, s := range st {
		if s.DraftRev != 2 || draftIn(s.Draft) != "next" {
			t.Fatalf("a state record of the Send %+v", s)
		}
	}
	if got := e.view(v.ID); got.DraftRev != 2 || draftIn(got.Draft) != "next" {
		t.Fatalf("view after the Send %+v", got)
	}
	if m := e.meta(v.ID); draftIn(m.Drafts[model.MainBranch]) != "next" || m.DraftRevs[model.MainBranch] != 2 {
		t.Fatalf("chat.json after the Send %+v %+v", m.Drafts, m.DraftRevs)
	}
	// The page that typed "next" goes on from its counter.
	if rev, _, err = e.m.SetDraft(v.ID, 2, model.Draft{Text: "next thought"}); err != nil || rev != 3 {
		t.Fatalf("the save after the Send: rev %d, err %v", rev, err)
	}

	// With no save in between, the same Send takes the draft and counts once.
	evs.drain(t, e.br)
	b, res = e.block(e.claude, func() error { return e.m.Send(w.ID, "sent", "", nil) })
	if err := b.release(res, nil); err != nil {
		t.Fatal(err)
	}
	st = statesOf(t, evs.drain(t, e.br), w.ID, model.MainBranch)
	if last := st[len(st)-1]; last.DraftRev != 2 || last.Draft != nil {
		t.Fatalf("the last state record of a Send with no save since %+v", last)
	}
	if m := e.meta(w.ID); m.Drafts != nil || m.DraftRevs[model.MainBranch] != 2 {
		t.Fatalf("chat.json after a Send with no save since %+v %+v", m.Drafts, m.DraftRevs)
	}
}

// The same on a branch, whose draft is with its top-level chat: the drop takes the draft only on
// the counter the message was taken at.
func TestDropDraftOnItsCounter(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.branched(model.Claude, "", exBranch)
	if rev, _, err := e.m.SetDraftOf(id, exBranch, 0, model.Draft{Text: "sent"}); err != nil || rev != 1 {
		t.Fatalf("the branch's draft: rev %d, err %v", rev, err)
	}
	b, err := e.m.branchObj(id, exBranch)
	if err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	taken := e.m.draftRevOf(b)
	b.mu.Unlock()
	if taken != 1 {
		t.Fatalf("the counter the message is taken at: %d", taken)
	}
	if rev, _, err := e.m.SetDraftOf(id, exBranch, 1, model.Draft{Text: "next"}); err != nil || rev != 2 {
		t.Fatalf("the save since: rev %d, err %v", rev, err)
	}
	drop := func(rev int64) {
		b.mu.Lock()
		e.m.dropDraft(b, rev)
		b.mu.Unlock()
	}
	drop(taken)
	if st := e.stateOfBranch(id, exBranch); st.DraftRev != 2 || draftIn(st.Draft) != "next" {
		t.Fatalf("after a drop on an old counter %+v", st)
	}
	drop(2)
	if st := e.stateOfBranch(id, exBranch); st.DraftRev != 3 || st.Draft != nil {
		t.Fatalf("after a drop on the draft's counter %+v", st)
	}
	if m := e.meta(id); m.Drafts != nil || m.DraftRevs[exBranch] != 3 {
		t.Fatalf("chat.json after the drop %+v %+v", m.Drafts, m.DraftRevs)
	}
}
