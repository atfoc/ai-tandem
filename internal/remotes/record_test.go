package remotes

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// TestViewOf: every row of the table of what a page is handed.
func TestViewOf(t *testing.T) {
	main, side := &model.Draft{Text: "for main"}, &model.Draft{Text: "for b1"}
	there := remoteView(chatA, model.StatusThinking)
	there.Board, there.Run, there.Role = "b_there", "r_there", "worker"
	there.Server, there.Start, there.Gone = "s_there", "unconfirmed", true
	there.Archive = model.Archive{Archived: true, Op: "a_there"}
	there.Draft, there.DraftRev, there.HasDraft = &model.Draft{Text: "typed there"}, 9, true

	rec := Record{
		ID: chatA, Entry: "s_entry", Group: "g_here", View: there,
		Drafts:    map[string]*model.Draft{mainBranch: main, "b1": side},
		DraftRevs: map[string]int64{mainBranch: 3, "b1": 5, "b2": 7},
	}
	v := viewOf(rec)
	if v.Group != "g_here" || v.Run != "" {
		t.Errorf("place: group %q, run %q", v.Group, v.Run)
	}
	if v.Board != "" {
		t.Errorf("board %q", v.Board)
	}
	if v.Role != "" {
		t.Errorf("role %q: a record is never a run agent's chat", v.Role)
	}
	if v.Server != "s_entry" {
		t.Errorf("server %q", v.Server)
	}
	if v.Gone || v.Start != "" {
		t.Errorf("gone %v, start %q", v.Gone, v.Start)
	}
	if v.Archived || v.Op != "" {
		t.Errorf("the remote server's mark and action reached the page: %+v", v.Archive)
	}
	if v.Draft != main || v.DraftRev != 3 || !v.HasDraft {
		t.Errorf("draft of main: %+v, rev %d, hasDraft %v", v.Draft, v.DraftRev, v.HasDraft)
	}
	if v.Status != model.StatusThinking || v.Name != there.Name || v.Cwd != there.Cwd || !v.Locked {
		t.Errorf("the rest is not the view that came: %+v", v)
	}

	// A chat on a run has the run as its place, and no group.
	onRun := rec
	onRun.Group, onRun.Run = "", "r_here"
	if v := viewOf(onRun); v.Group != "" || v.Run != "r_here" {
		t.Errorf("on a run: group %q, run %q", v.Group, v.Run)
	}

	// The draft is the one of the view's current branch; a branch without one has its counter.
	rec.View.Branch = "b1"
	if v := viewOf(rec); v.Draft != side || v.DraftRev != 5 {
		t.Errorf("draft of b1: %+v, rev %d", v.Draft, v.DraftRev)
	}
	rec.View.Branch = "b2"
	if v := viewOf(rec); v.Draft != nil || v.DraftRev != 7 || !v.HasDraft {
		t.Errorf("draft of b2: %+v, rev %d, hasDraft %v", v.Draft, v.DraftRev, v.HasDraft)
	}
	rec.Drafts = nil
	if v := viewOf(rec); v.Draft != nil || v.HasDraft {
		t.Errorf("without drafts: %+v, hasDraft %v", v.Draft, v.HasDraft)
	}

	// The mark: the record's, or the target of a change that is pending.
	for _, c := range []struct {
		archived bool
		pending  string
		want     bool
	}{
		{false, "", false}, {true, "", true},
		{false, pendingArchive, true}, {true, pendingArchive, true},
		{true, pendingUnarchive, false}, {false, pendingUnarchive, false},
	} {
		rec.Archived, rec.Pending, rec.Op = c.archived, c.pending, "a_here"
		if v := viewOf(rec); v.Archived != c.want || v.Op != "a_here" {
			t.Errorf("archived %v, pending %q: the page gets %+v", c.archived, c.pending, v.Archive)
		}
	}

	rec.Gone = true
	if !viewOf(rec).Gone {
		t.Error("a gone record is not gone for the page")
	}
}

// TestStatesOf: each branch state gets its branch's draft and counter.
func TestStatesOf(t *testing.T) {
	main, side := &model.Draft{Text: "for main"}, &model.Draft{Text: "for b1"}
	rec := Record{
		ID: chatA, Entry: "s_entry",
		States: []model.BranchState{
			{Chat: chatA, Branch: mainBranch, Status: model.StatusReady, Draft: &model.Draft{Text: "typed there"}, DraftRev: 9},
			{Chat: chatA, Branch: "b1", Status: model.StatusTool},
			{Chat: chatA, Branch: "b2", Status: model.StatusThinking, Draft: &model.Draft{Text: "typed there"}},
		},
		Drafts:    map[string]*model.Draft{mainBranch: main, "b1": side},
		DraftRevs: map[string]int64{mainBranch: 3, "b1": 5},
	}
	got := statesOf(rec)
	if len(got) != 3 {
		t.Fatalf("%d states", len(got))
	}
	if got[0].Draft != main || got[0].DraftRev != 3 || got[0].Status != model.StatusReady {
		t.Errorf("main: %+v", got[0])
	}
	if got[1].Draft != side || got[1].DraftRev != 5 || got[1].Status != model.StatusTool {
		t.Errorf("b1: %+v", got[1])
	}
	if got[2].Draft != nil || got[2].DraftRev != 0 || got[2].Status != model.StatusThinking {
		t.Errorf("b2: %+v", got[2])
	}
	if got := statesOf(Record{ID: chatA}); got == nil || len(got) != 0 {
		t.Errorf("no states: %#v", got)
	}
	// What was received is left as it came.
	if rec.States[0].Draft.Text != "typed there" || rec.States[0].DraftRev != 9 {
		t.Errorf("the record's own state was changed: %+v", rec.States[0])
	}
}

// TestApply: what a view from the chat's server does to the mark, to a pending change and to
// the gone mark, in an event and in a snapshot.
func TestApply(t *testing.T) {
	view := func(archived bool) model.ChatView {
		v := remoteView(chatA, model.StatusReady)
		v.Archived = archived
		return v
	}
	for _, c := range []struct {
		name                string
		rec                 Record
		archived, snapshot  bool
		wantArchived        bool
		wantOp, wantPending string
		wantDurable         bool
	}{
		{name: "a view alone", rec: Record{}, wantDurable: false},
		{name: "a mark made there", rec: Record{}, archived: true, wantArchived: true, wantDurable: true},
		{name: "a mark taken off there", rec: Record{Archived: true, Op: "a_x"}, wantDurable: true},
		{name: "a kept mark keeps its action", rec: Record{Archived: true, Op: "a_x"}, archived: true, wantArchived: true, wantOp: "a_x"},
		{name: "a pending archive is confirmed", rec: Record{Pending: pendingArchive, Op: "a_x"}, archived: true,
			wantArchived: true, wantOp: "a_x", wantDurable: true},
		{name: "a pending archive is not confirmed yet", rec: Record{Pending: pendingArchive, Op: "a_x"},
			wantOp: "a_x", wantPending: pendingArchive},
		{name: "a pending unarchive is confirmed", rec: Record{Archived: true, Pending: pendingUnarchive}, wantDurable: true},
		{name: "a pending unarchive is not confirmed yet", rec: Record{Archived: true, Pending: pendingUnarchive}, archived: true,
			wantArchived: true, wantPending: pendingUnarchive},
		{name: "a pending archive wins over a snapshot", rec: Record{Pending: pendingArchive, Op: "a_x"}, snapshot: true,
			wantOp: "a_x", wantPending: pendingArchive},
		{name: "a pending archive stays at a snapshot that has it", rec: Record{Pending: pendingArchive, Op: "a_x"}, archived: true, snapshot: true,
			wantOp: "a_x", wantPending: pendingArchive},
		{name: "a pending unarchive wins over a snapshot", rec: Record{Archived: true, Pending: pendingUnarchive}, archived: true, snapshot: true,
			wantArchived: true, wantPending: pendingUnarchive},
		{name: "a snapshot's mark is taken", rec: Record{}, archived: true, snapshot: true, wantArchived: true, wantDurable: true},
		{name: "a gone chat is back", rec: Record{Gone: true}, wantDurable: true},
		{name: "a gone chat is back in a snapshot", rec: Record{Gone: true}, snapshot: true, wantDurable: true},
	} {
		rec := c.rec
		durable := rec.apply(view(c.archived), c.snapshot)
		if rec.Archived != c.wantArchived || rec.Op != c.wantOp || rec.Pending != c.wantPending || rec.Gone || durable != c.wantDurable {
			t.Errorf("%s: archived %v, op %q, pending %q, gone %v, durable %v", c.name, rec.Archived, rec.Op, rec.Pending, rec.Gone, durable)
		}
		if rec.View.Archived != c.archived || rec.View.Status != model.StatusReady {
			t.Errorf("%s: the view is not kept as it came: %+v", c.name, rec.View)
		}
	}
	// While a change is pending the page sees its target, whatever the server's mark is.
	rec := Record{Pending: pendingArchive, Op: "a_x"}
	rec.apply(view(false), true)
	if v := viewOf(rec); !v.Archived || v.Op != "a_x" {
		t.Errorf("the page's mark under a pending archive: %+v", v.Archive)
	}
}

// TestSetState: a state replaces its branch's, a new branch is added.
func TestSetState(t *testing.T) {
	rec := Record{States: []model.BranchState{{Chat: chatA, Branch: mainBranch, Status: model.StatusReady}}}
	rec.setState(model.BranchState{Chat: chatA, Branch: "b1", Status: model.StatusTool})
	rec.setState(model.BranchState{Chat: chatA, Branch: mainBranch, Status: model.StatusThinking})
	rec.setState(model.BranchState{Chat: chatA, Status: model.StatusWriting}) // no branch: main
	if len(rec.States) != 2 || rec.States[0].Status != model.StatusWriting || rec.States[1].Branch != "b1" {
		t.Errorf("states %+v", rec.States)
	}
	// At most maxStates: the state of a further branch is not kept, that of a known one is.
	for i := 2; len(rec.States) < maxStates; i++ {
		if !rec.setState(model.BranchState{Chat: chatA, Branch: fmt.Sprintf("b%d", i)}) {
			t.Fatalf("the state %d was not kept", i)
		}
	}
	if rec.setState(model.BranchState{Chat: chatA, Branch: "one-more"}) || len(rec.States) != maxStates {
		t.Errorf("a state above the bound was kept: %d states", len(rec.States))
	}
	if !rec.setState(model.BranchState{Chat: chatA, Branch: "b1", Status: model.StatusApproval}) || rec.States[1].Status != model.StatusApproval {
		t.Errorf("the state of a known branch was not kept: %+v", rec.States[1])
	}
}

// TestRecordShape: the file's keys are the contract's, and it has no place for a secret.
func TestRecordShape(t *testing.T) {
	rec := Record{
		ID: chatA, Entry: "s_entry", Group: "g", Run: "r", Archived: true, Op: "a_x", Pending: pendingArchive, Gone: true,
		View: remoteView(chatA, model.StatusReady), States: []model.BranchState{{Chat: chatA, Branch: mainBranch}},
		Drafts: map[string]*model.Draft{mainBranch: {Text: "x"}}, DraftRevs: map[string]int64{mainBranch: 1},
	}
	b, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(b, &keys); err != nil {
		t.Fatal(err)
	}
	want := []string{"id", "entry", "group", "run", "archived", "archiveOp", "pending", "gone", "view", "states", "drafts", "draftRevs"}
	if len(keys) != len(want) {
		t.Errorf("the keys of a record: %s", b)
	}
	for _, k := range want {
		if _, ok := keys[k]; !ok {
			t.Errorf("a record has no %q: %s", k, b)
		}
	}
	for _, typ := range []reflect.Type{reflect.TypeOf(Record{}), reflect.TypeOf(ServerLists{})} {
		for i := range typ.NumField() {
			f := typ.Field(i)
			if name := strings.ToLower(f.Name + f.Tag.Get("json")); strings.Contains(name, "secret") || strings.Contains(name, "token") {
				t.Errorf("%s has the field %s", typ.Name(), f.Name)
			}
		}
	}
	if typ := reflect.TypeOf(ServerLists{}); typ.NumField() != 4 {
		t.Errorf("ServerLists has %d fields: agents, catalogs, home and default folder are all it holds", typ.NumField())
	}
}

// TestValidID: an id names a file and a part of a path.
func TestValidID(t *testing.T) {
	for _, id := range []string{chatA, "c_abc123", "A"} {
		if !validID(id) {
			t.Errorf("%q is refused", id)
		}
	}
	for _, id := range []string{"", ".", "..", "../x", "a/b", "a.json", "a b", "-a", "a?b", strings.Repeat("a", 65)} {
		if validID(id) {
			t.Errorf("%q is accepted", id)
		}
	}
}

// TestFields: the members of an event that the relay routes by are read as a page reads them.
func TestFields(t *testing.T) {
	f, ok := fields([]byte(`{"type":"chat_items","chat":"x","version":3,"updates":[{"type":"y","chat":"z"}]}`), "type", "chat")
	if !ok || text(f["type"]) != "chat_items" || text(f["chat"]) != "x" {
		t.Errorf("fields: %v, %v", f, ok)
	}
	if f, ok := fields([]byte(`{"type":"tree"}`), "type", "chat"); !ok || text(f["chat"]) != "" {
		t.Errorf("a missing member: %v, %v", f, ok)
	}
	for _, raw := range []string{
		`{"type":"chat_items","chat":"x","chat":"y"}`,
		`{"type":"chat_items","type":"servers","chat":"x"}`,
		`{"type":"chat_items","type":"servers","chat":"x"}`,
		`["type"]`, `"type"`, ``, `{"type":`,
	} {
		if _, ok := fields([]byte(raw), "type", "chat"); ok {
			t.Errorf("%s is accepted", raw)
		}
	}
	if text(json.RawMessage(`7`)) != "" || text(nil) != "" {
		t.Error("text of what is no string")
	}
}
