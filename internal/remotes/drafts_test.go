package remotes

import (
	"net/http"
	"reflect"
	"testing"

	"ai-whiteboard/internal/model"
)

// TestDrafts: a record's drafts are kept here, by branch, under the rule of a local chat's.
func TestDrafts(t *testing.T) {
	t.Parallel()
	seed := seedOf(chatA)
	seed.View.Branch = "b1" // the chat's current branch
	seed.States = append(seed.States, model.StateOf(chatA, "b1", seed.View))
	snap := snapshotWith(seed.View)
	snap["states"] = seed.States
	rg := newRig(t, rigOpt{snapshot: snap, seed: []Record{seed}})
	p, _ := rg.page("page-1")
	sent := len(rg.s.Requests())

	// Accepted: the counter after the write, and the events.
	rep := rg.r.SetDraft(chatA, mainBranch, 0, model.Draft{Text: "first"})
	if rep.Status != http.StatusOK || !reflect.DeepEqual(body(t, rep), map[string]any{"ok": true, "rev": float64(1)}) {
		t.Errorf("a first draft: %d %s", rep.Status, rep.Body)
	}
	st, chat := p.Expect("branch_state"), p.Expect("chat")
	if field(st, "state", "branch") != mainBranch || field(st, "state", "draft", "text") != "first" || field(st, "state", "draftRev") != float64(1) {
		t.Errorf("the state: %v", st)
	}
	// The view shows the draft of the current branch, b1, which has none; the chat has one.
	if field(chat, "chat", "draft") != nil || field(chat, "chat", "hasDraft") != true {
		t.Errorf("the view: %v", chat)
	}
	if d := rg.file(chatA); d.Drafts[mainBranch] == nil || d.Drafts[mainBranch].Text != "first" || d.DraftRevs[mainBranch] != 1 {
		t.Errorf("the file was not written at once: %+v", d)
	}

	// A stale base: nothing is written, and the answer holds what is stored.
	rep = rg.r.SetDraft(chatA, mainBranch, 0, model.Draft{Text: "typed on the old one"})
	b := body(t, rep)
	if rep.Status != http.StatusConflict || b["code"] != "stale" || b["error"] != "the draft was changed elsewhere" ||
		b["rev"] != float64(1) || field(b, "draft", "text") != "first" {
		t.Errorf("a stale save: %d %s", rep.Status, rep.Body)
	}
	p.ExpectNone(quiet)

	// Per branch: "" is the current one, and each has its own counter.
	rep = rg.r.SetDraft(chatA, "", 0, model.Draft{References: []model.Reference{{Quote: "q"}}})
	if rep.Status != http.StatusOK || body(t, rep)["rev"] != float64(1) {
		t.Errorf("a draft of the current branch: %d %s", rep.Status, rep.Body)
	}
	st, chat = p.Expect("branch_state"), p.Expect("chat")
	if field(st, "state", "branch") != "b1" || field(chat, "chat", "draftRev") != float64(1) || field(chat, "chat", "draft") == nil {
		t.Errorf("the events: %v %v", st, chat)
	}
	if rep := rg.r.SetDraft(chatA, mainBranch, 1, model.Draft{Text: "second"}); body(t, rep)["rev"] != float64(2) {
		t.Errorf("a second draft of main: %d %s", rep.Status, rep.Body)
	}
	p.Expect("branch_state")
	p.Expect("chat")
	// A stale save of a branch whose draft is gone answers null as the draft.
	if rep := rg.r.SetDraft(chatA, "b1", 1, model.Draft{}); rep.Status != http.StatusOK || body(t, rep)["rev"] != float64(2) {
		t.Errorf("the draft of b1 removed: %d %s", rep.Status, rep.Body)
	}
	p.Expect("branch_state")
	p.Expect("chat")
	rep = rg.r.SetDraft(chatA, "b1", 1, model.Draft{Text: "late"})
	if b := body(t, rep); rep.Status != http.StatusConflict || b["rev"] != float64(2) || b["draft"] != nil {
		t.Errorf("a stale save of a branch without a draft: %d %s", rep.Status, rep.Body)
	}

	// The counters are never removed; a branch that has no draft and gets none counts nothing.
	if rep := rg.r.SetDraft(chatA, "b1", 2, model.Draft{}); rep.Status != http.StatusOK || body(t, rep)["rev"] != float64(2) {
		t.Errorf("no draft for a branch that has none: %d %s", rep.Status, rep.Body)
	}
	p.ExpectNone(quiet)
	if rep := rg.r.SetDraft(chatA, mainBranch, 2, model.Draft{}); body(t, rep)["rev"] != float64(3) {
		t.Errorf("the last draft removed: %d %s", rep.Status, rep.Body)
	}
	p.Expect("branch_state")
	if ev := p.Expect("chat"); field(ev, "chat", "hasDraft") != nil {
		t.Errorf("the view with no draft left: %v", ev)
	}
	if d := rg.file(chatA); len(d.Drafts) != 0 || !reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 3, "b1": 2}) {
		t.Errorf("the file: drafts %v, counters %v", d.Drafts, d.DraftRevs)
	}

	// A branch the chat does not have, and a chat without a record.
	if rep := rg.r.SetDraft(chatA, "b9", 0, model.Draft{Text: "x"}); rep.Status != http.StatusNotFound || body(t, rep)["error"] != "no such branch" {
		t.Errorf("an unknown branch: %d %s", rep.Status, rep.Body)
	}
	if rep := rg.r.SetDraft(chatB, "", 0, model.Draft{Text: "x"}); rep.Status != http.StatusNotFound {
		t.Errorf("no record: %d %s", rep.Status, rep.Body)
	}
	// A draft that was handed out is never changed: the one a view holds stays what it was.
	rg.r.SetDraft(chatA, mainBranch, 3, model.Draft{Text: "kept"})
	held := rg.r.States()[0].Draft
	rg.r.SetDraft(chatA, mainBranch, 4, model.Draft{Text: "newer"})
	if held == nil || held.Text != "kept" || rg.r.States()[0].Draft.Text != "newer" {
		t.Errorf("a draft that was handed out changed: %v", held)
	}
	if got := len(rg.s.Requests()); got != sent {
		t.Errorf("the drafts sent %d requests to the chat's server", got-sent)
	}
}
