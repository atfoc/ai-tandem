package chats

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// ---- fixtures -------------------------------------------------------------

// writeItems writes items as the lines of items.jsonl in the folder of the chat or branch with
// server id id, making the folder.
func (e *env) writeItems(id string, items []model.Item) {
	e.t.Helper()
	dir := e.st.P.ChatDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		e.t.Fatal(err)
	}
	var buf bytes.Buffer
	for i, it := range items {
		b, err := json.Marshal(map[string]any{"i": i, "item": it})
		if err != nil {
			e.t.Fatal(err)
		}
		buf.Write(b)
		buf.WriteByte('\n')
	}
	if err := os.WriteFile(filepath.Join(dir, "items.jsonl"), buf.Bytes(), 0o600); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) writeTree(chat string, t model.Tree) {
	e.t.Helper()
	if err := store.WriteJSONAtomic(e.m.treePath(chat), t, 0o600); err != nil {
		e.t.Fatal(err)
	}
}

// treeFile is the tree record on disk; ok is false when there is no file.
func (e *env) treeFile(chat string) (t model.Tree, ok bool) {
	e.t.Helper()
	raw, err := os.ReadFile(e.m.treePath(chat))
	if errors.Is(err, os.ErrNotExist) {
		return model.Tree{}, false
	}
	if err != nil {
		e.t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &t); err != nil {
		e.t.Fatal(err)
	}
	return t, true
}

func (e *env) tree(chat string) model.TreeView {
	e.t.Helper()
	tv, err := e.m.Tree(chat)
	if err != nil {
		e.t.Fatal(err)
	}
	return tv
}

const exBranch = "a1b2c3d4"

func exampleMain() []model.Item {
	res := "ok"
	return []model.Item{
		{Kind: "user", Text: "ask"},
		{Kind: "text", Text: "options", Done: true},
		{Kind: "end", Point: "p1"},
		{Kind: "user", Text: "redis"},
		{Kind: "text", Text: "looking", Done: true},
		{Kind: "tool", ToolID: "t1", Name: "Read", Result: &res},
		{Kind: "text", Text: "lua", Done: true},
		{Kind: "end", Point: "p2"},
	}
}

func exampleBranch() []model.Item {
	return append(exampleMain()[:3],
		model.Item{Kind: "user", Text: "memory"},
		model.Item{Kind: "text", Text: "map", Done: true},
		model.Item{Kind: "end"})
}

var exampleTree = model.Tree{
	Branches: []model.TreeBranch{{ID: exBranch, From: model.MainBranch, At: 3}},
	Labels: []model.TreeLabel{
		{Branch: model.MainBranch, Item: 1, Text: "options"},
		{Branch: exBranch, Item: 3, Text: "mem"},
	},
	Current: exBranch,
}

// The tree.json and the answer of the worked example, as the brief gives them.
const exampleTreeJSON = `{"branches":[{"id":"a1b2c3d4","from":"main","at":3}],"labels":[{"branch":"main","item":1,"text":"options"},{"branch":"a1b2c3d4","item":3,"text":"mem"}],"current":"a1b2c3d4"}`

const exampleViewJSON = `{
  "current": "a1b2c3d4",
  "branches": [
    {"id": "main", "at": 0, "len": 8, "items": [
      {"i": 0, "kind": "user", "text": "ask", "before": 0, "ok": true},
      {"i": 1, "kind": "text", "text": "options", "done": true, "end": 3, "ok": true},
      {"i": 3, "kind": "user", "text": "redis", "before": 3, "ok": true},
      {"i": 4, "kind": "text", "text": "looking", "done": true},
      {"i": 6, "kind": "text", "text": "lua", "done": true, "end": 8, "ok": true}
    ]},
    {"id": "a1b2c3d4", "from": "main", "at": 3, "len": 6, "items": [
      {"i": 3, "kind": "user", "text": "memory", "before": 3, "ok": true},
      {"i": 4, "kind": "text", "text": "map", "done": true, "end": 6}
    ]}
  ],
  "labels": [
    {"branch": "main", "item": 1, "text": "options"},
    {"branch": "a1b2c3d4", "item": 3, "text": "mem"}
  ]
}`

// example makes a chat of agent a holding the worked example's two branches on disk, without a
// tree record, and restarts the manager, so that nothing of the chat is loaded.
func (e *env) example(a model.AgentKind) string {
	e.t.Helper()
	v := e.create(a, gOne, "")
	e.writeItems(v.ID, exampleMain())
	e.writeItems(branchChatID(v.ID, exBranch), exampleBranch())
	e.boot()
	return v.ID
}

// asJSON is v through JSON, for comparing what a client would decode.
func asJSON(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// oks is the indexes of the tree items of a branch that carry ok.
func oks(b model.TreeBranchView) []int {
	out := []int{}
	for _, it := range b.Items {
		if it.OK {
			out = append(out, it.I)
		}
	}
	return out
}

// ---- the record -----------------------------------------------------------

func TestTreeHelpers(t *testing.T) {
	tr := exampleTree
	tr.Branches = append([]model.TreeBranch{}, tr.Branches...)
	tr.Branches = append(tr.Branches, model.TreeBranch{ID: "deadbeef", From: exBranch, At: 5})

	if got := branchChatID("c1", model.MainBranch); got != "c1" {
		t.Fatalf("main's chat id %q", got)
	}
	if got := branchChatID("c1", exBranch); got != "c1/branches/"+exBranch {
		t.Fatalf("branch chat id %q", got)
	}
	if b, ok := branchOf(tr, model.MainBranch); !ok || b != (model.TreeBranch{ID: model.MainBranch}) {
		t.Fatalf("branchOf main: %+v %v", b, ok)
	}
	if b, ok := branchOf(tr, exBranch); !ok || b != tr.Branches[0] {
		t.Fatalf("branchOf %s: %+v %v", exBranch, b, ok)
	}
	if _, ok := branchOf(tr, "nope"); ok {
		t.Fatal("branchOf found an unknown branch")
	}
	if _, ok := branchOf(model.Tree{}, ""); ok {
		t.Fatal(`branchOf found ""`)
	}
	for _, c := range []struct {
		branch string
		item   int
		want   string
	}{
		{model.MainBranch, 0, model.MainBranch},
		{model.MainBranch, 7, model.MainBranch},
		{exBranch, 2, model.MainBranch},
		{exBranch, 3, exBranch},
		{exBranch, 5, exBranch},
		{"deadbeef", 1, model.MainBranch},
		{"deadbeef", 4, exBranch},
		{"deadbeef", 5, "deadbeef"},
	} {
		if got := ownerOf(tr, c.branch, c.item); got != c.want {
			t.Errorf("ownerOf(%s, %d) = %s, want %s", c.branch, c.item, got, c.want)
		}
	}
	// A record whose branches name each other does not loop.
	loop := model.Tree{Branches: []model.TreeBranch{{ID: "a", From: "b", At: 5}, {ID: "b", From: "a", At: 5}}}
	if got := ownerOf(loop, "a", 1); got != model.MainBranch {
		t.Fatalf("ownerOf in a loop = %s", got)
	}
}

func TestLabelsOnPath(t *testing.T) {
	onMain := model.TreeLabel{Branch: model.MainBranch, Item: 1, Text: "options"}
	for _, c := range []struct {
		branch string
		count  int
		want   []model.TreeLabel
	}{
		{exBranch, 3, []model.TreeLabel{onMain}},
		{exBranch, 4, []model.TreeLabel{onMain, {Branch: model.MainBranch, Item: 3, Text: "mem"}}},
		{model.MainBranch, 8, []model.TreeLabel{onMain}},
		{model.MainBranch, 1, nil},
	} {
		if got := labelsOnPath(exampleTree, c.branch, c.count); !reflect.DeepEqual(got, c.want) {
			t.Errorf("labelsOnPath(%s, %d) = %+v, want %+v", c.branch, c.count, got, c.want)
		}
	}
}

func TestReadAndUpdateTree(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if tr, err := e.m.readTree(v.ID); err != nil || !reflect.DeepEqual(tr, model.Tree{}) {
		t.Fatalf("readTree without a file: %+v %v", tr, err)
	}

	// A function that fails writes nothing.
	boom := errors.New("boom")
	if err := e.m.updateTree(v.ID, func(*model.Tree) error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("updateTree with a failing function: %v", err)
	}
	if _, ok := e.treeFile(v.ID); ok {
		t.Fatal("tree.json written after a failed update")
	}

	if err := e.m.updateTree(v.ID, func(tr *model.Tree) error { *tr = exampleTree; return nil }); err != nil {
		t.Fatal(err)
	}
	if tr, err := e.m.readTree(v.ID); err != nil || !reflect.DeepEqual(tr, exampleTree) {
		t.Fatalf("readTree after an update: %+v %v", tr, err)
	}
	st, err := os.Stat(e.m.treePath(v.ID))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("tree.json mode %v %v", st.Mode(), err)
	}
	// The file is the brief's.
	var want model.Tree
	if err := json.Unmarshal([]byte(exampleTreeJSON), &want); err != nil {
		t.Fatal(err)
	}
	if got, _ := e.treeFile(v.ID); !reflect.DeepEqual(got, want) {
		t.Fatalf("tree.json %+v, want %+v", got, want)
	}

	if err := e.m.updateTree("nope", func(*model.Tree) error { return nil }); !errors.Is(err, ErrNotFound) {
		t.Fatalf("updateTree on an unknown chat: %v", err)
	}
}

// ---- Tree -----------------------------------------------------------------

func TestTreeExample(t *testing.T) {
	e := newEnv(t)
	id := e.example(model.Claude)
	if err := os.WriteFile(e.m.treePath(id), []byte(exampleTreeJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	var want any
	if err := json.Unmarshal([]byte(exampleViewJSON), &want); err != nil {
		t.Fatal(err)
	}
	if got := asJSON(t, e.tree(id)); !reflect.DeepEqual(got, want) {
		t.Fatalf("tree\n got %v\nwant %v", got, want)
	}
	if _, err := e.m.Tree("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Tree of an unknown chat: %v", err)
	}
	if _, err := e.m.Tree(branchChatID(id, exBranch)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Tree of a branch's server id: %v", err)
	}
	if err := e.m.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.Tree(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Tree of a deleted chat: %v", err)
	}
}

// Tree reads the files itself: a chat not opened in this run stays unloaded, with its
// interrupted turn and its running subagent as they were.
func TestTreeLoadsNothing(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	dir := e.st.P.ChatDir(v.ID)
	e.writeItems(v.ID, []model.Item{{Kind: "user", Text: "ask"}, {Kind: "text", Text: "options", Done: true}})
	meta := e.meta(v.ID)
	meta.TurnActive = true
	if err := store.WriteJSONAtomic(filepath.Join(dir, "chat.json"), meta, 0o600); err != nil {
		t.Fatal(err)
	}
	subFile := filepath.Join(dir, "subagents", "s1", "subagent.json")
	if err := os.MkdirAll(filepath.Dir(subFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteJSONAtomic(subFile, model.Subagent{ID: "s1", Status: model.SubRunning}, 0o600); err != nil {
		t.Fatal(err)
	}
	e.boot()
	evs := listen(t, e.br)
	evs.drain(t, e.br) // the client's hello and snapshot
	files := []string{filepath.Join(dir, "items.jsonl"), filepath.Join(dir, "chat.json"), subFile}
	read := func() [][]byte {
		var out [][]byte
		for _, f := range files {
			b, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			out = append(out, b)
		}
		return out
	}
	before := read()

	tv := e.tree(v.ID)
	zero := 0
	want := model.TreeView{Current: model.MainBranch, Labels: []model.TreeLabel{},
		Branches: []model.TreeBranchView{{ID: model.MainBranch, Len: 2, Items: []model.TreeItem{
			{I: 0, Kind: "user", Text: "ask", Before: &zero},
			{I: 1, Kind: "text", Text: "options", Done: true},
		}}}}
	if !reflect.DeepEqual(tv, want) {
		t.Fatalf("tree %+v", tv)
	}
	if got := asJSON(t, tv).(map[string]any); !reflect.DeepEqual(got["labels"], []any{}) || got["current"] != "main" {
		t.Fatalf("tree on the wire %v", got)
	}
	if !reflect.DeepEqual(read(), before) {
		t.Fatal("Tree changed the chat's files")
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("Tree sent events: %v", got)
	}
	c, err := e.m.get(v.ID)
	if err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	loaded, interrupted := c.tr != nil, c.interrupted
	c.mu.Unlock()
	if loaded || !interrupted {
		t.Fatalf("after Tree: loaded %v, interrupted %v", loaded, interrupted)
	}
	if _, ok := e.treeFile(v.ID); ok {
		t.Fatal("Tree wrote tree.json")
	}

	// A chat with nothing said yet.
	if tv := e.tree(e.create(model.Claude, gOne, "").ID); len(tv.Branches) != 1 || tv.Branches[0].Len != 0 ||
		tv.Branches[0].Items == nil || len(tv.Branches[0].Items) != 0 {
		t.Fatalf("tree of an empty chat %+v", tv)
	}
}

func TestTreeUnreadableRecord(t *testing.T) {
	e := newEnv(t)
	id := e.example(model.Claude)
	bad := []byte(`{"branches":[{"id":"a1b2c3d4","from":"main","at":3}`)
	if err := os.WriteFile(e.m.treePath(id), bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.readTree(id); !errors.Is(err, errTreeUnreadable) {
		t.Fatalf("readTree: %v", err)
	}
	tv := e.tree(id)
	if len(tv.Branches) != 1 || tv.Branches[0].ID != model.MainBranch || tv.Branches[0].Len != 8 ||
		tv.Current != model.MainBranch || len(tv.Labels) != 0 {
		t.Fatalf("tree %+v", tv)
	}
	if _, err := e.m.SetLabel(id, model.MainBranch, 1, "options"); !errors.Is(err, errTreeUnreadable) {
		t.Fatalf("SetLabel: %v", err)
	}
	called := false
	err := e.m.updateTree(id, func(*model.Tree) error { called = true; return nil })
	if !errors.Is(err, errTreeUnreadable) || called {
		t.Fatalf("updateTree: %v, function called %v", err, called)
	}
	if got, err := os.ReadFile(e.m.treePath(id)); err != nil || !bytes.Equal(got, bad) {
		t.Fatalf("tree.json changed: %q %v", got, err)
	}
	if _, err := os.Stat(e.m.treePath(id) + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("tree.json.tmp left behind: %v", err)
	}
}

func TestTreeLeavesOutUnreadableBranches(t *testing.T) {
	e := newEnv(t)
	id := e.example(model.Claude)
	tr := model.Tree{
		Branches: []model.TreeBranch{
			{ID: "00000001", From: model.MainBranch, At: 3},  // no folder
			{ID: "00000002", From: "00000001", At: 4},        // its parent is left out
			{ID: exBranch, From: model.MainBranch, At: 3},    // readable
			{ID: "00000003", From: "ffffffff", At: 3},        // split from a branch nobody recorded
			{ID: "00000004", From: model.MainBranch, At: 3},  // items.jsonl cannot be read
			{ID: exBranch, From: model.MainBranch, At: 0},    // recorded twice
			{ID: "00000005", From: model.MainBranch, At: -1}, // no such split
		},
		Labels: []model.TreeLabel{
			{Branch: model.MainBranch, Item: 1, Text: "options"},
			{Branch: model.MainBranch, Item: 2, Text: "an end mark"},
			{Branch: model.MainBranch, Item: 5, Text: "a tool call"},
			{Branch: model.MainBranch, Item: 8, Text: "past the end"},
			{Branch: "00000001", Item: 3, Text: "gone"},
			{Branch: exBranch, Item: 3, Text: "mem"},
			{Branch: "00000004", Item: 3, Text: "unreadable"},
		},
		Current: "00000001",
	}
	e.writeTree(id, tr)
	for _, b := range []string{"00000002", "00000003", "00000005"} {
		e.writeItems(branchChatID(id, b), exampleBranch())
	}
	if err := os.MkdirAll(filepath.Join(e.st.P.ChatDir(branchChatID(id, "00000004")), "items.jsonl"), 0o700); err != nil {
		t.Fatal(err)
	}

	tv := e.tree(id)
	var ids []string
	for _, b := range tv.Branches {
		ids = append(ids, b.ID)
	}
	if !reflect.DeepEqual(ids, []string{model.MainBranch, exBranch}) {
		t.Fatalf("branches %v", ids)
	}
	if tv.Current != model.MainBranch {
		t.Fatalf("current %q", tv.Current)
	}
	if want := []model.TreeLabel{tr.Labels[0], tr.Labels[5]}; !reflect.DeepEqual(tv.Labels, want) {
		t.Fatalf("labels %+v", tv.Labels)
	}
	if _, err := e.m.SetLabel(id, "00000001", 1, "x"); !errors.Is(err, ErrNoBranch) {
		t.Fatalf("SetLabel on a branch without a folder: %v", err)
	}
	if got, _ := e.treeFile(id); !reflect.DeepEqual(got, tr) {
		t.Fatalf("tree.json changed: %+v", got)
	}
}

func TestTreePiPoints(t *testing.T) {
	// The turn at 3 was cut without a mark.
	items := []model.Item{
		{Kind: "user", Text: "one"},
		{Kind: "text", Text: "first", Done: true},
		{Kind: "end", Point: "p1"},
		{Kind: "user", Text: "two"},
		{Kind: "note", Tone: "muted", Text: "Stopped."},
		{Kind: "user", Text: "three"},
		{Kind: "text", Text: "third", Done: true},
		{Kind: "end", Point: "p3"},
	}
	for _, c := range []struct {
		agent model.AgentKind
		want  []int
	}{
		{model.Pi, []int{0, 6}},
		{model.Claude, []int{0, 1, 3, 5, 6}},
	} {
		e := newEnv(t)
		v := e.create(c.agent, gOne, "")
		e.writeItems(v.ID, items)
		e.boot()
		tv := e.tree(v.ID)
		var shown []int
		for _, it := range tv.Branches[0].Items {
			shown = append(shown, it.I)
		}
		if !reflect.DeepEqual(shown, []int{0, 1, 3, 5, 6}) {
			t.Fatalf("%s: items %v", c.agent, shown)
		}
		if got := oks(tv.Branches[0]); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: ok on %v, want %v", c.agent, got, c.want)
		}
	}
}

// A message that is only quotes is named in the tree by its first quote: the comment, else the
// quoted words. A message with text keeps its text.
func TestTreeQuotesOnlyMessage(t *testing.T) {
	e := newEnv(t)
	id, a := e.talked(model.Claude, "", 1)
	for _, refs := range [][]model.Reference{
		{{Quote: "reply", Comment: " make it longer ", Item: 1, Start: 0, End: 5}, {Quote: "1", Comment: "second", Item: 1, Start: 6, End: 7}},
		{{Quote: "reply 1", Item: 1, Start: 0, End: 7}},
	} {
		if err := e.m.Send(id, "", "", refs); err != nil {
			t.Fatal(err)
		}
		a.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	}
	if err := e.m.Send(id, "with text", "", []model.Reference{{Quote: "reply", Comment: "c", Item: 1, Start: 0, End: 5}}); err != nil {
		t.Fatal(err)
	}
	got := map[int]string{}
	for _, it := range e.tree(id).Branches[0].Items {
		if it.Kind == "user" {
			got[it.I] = it.Text
		}
	}
	want := map[int]string{0: "ask 1", 3: "❝ make it longer", 6: "❝ reply 1", 9: "with text"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("the tree's messages\n got %v\nwant %v", got, want)
	}
	if it := e.items(id)[3]; it.Text != "" || len(it.References) != 2 {
		t.Fatalf("the message itself changed: %+v", it)
	}
}

// ---- SetLabel -------------------------------------------------------------

func TestSetLabel(t *testing.T) {
	e := newEnv(t)
	id := e.example(model.Claude)
	e.writeTree(id, model.Tree{Branches: exampleTree.Branches, Current: exBranch})
	evs := listen(t, e.br)
	evs.drain(t, e.br) // the client's hello and snapshot

	// The owner is resolved and the text trimmed.
	onMain := model.TreeLabel{Branch: model.MainBranch, Item: 1, Text: "options"}
	labels, err := e.m.SetLabel(id, exBranch, 1, " options ")
	if err != nil || !reflect.DeepEqual(labels, []model.TreeLabel{onMain}) {
		t.Fatalf("SetLabel: %+v %v", labels, err)
	}
	if got, _ := e.treeFile(id); !reflect.DeepEqual(got.Labels, []model.TreeLabel{onMain}) ||
		!reflect.DeepEqual(got.Branches, exampleTree.Branches) || got.Current != exBranch {
		t.Fatalf("tree.json %+v", got)
	}

	// Labels stay sorted by branch (main first), then item; the answer lists them all.
	onBranch := model.TreeLabel{Branch: exBranch, Item: 3, Text: "mem"}
	if _, err := e.m.SetLabel(id, exBranch, 3, "mem"); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.SetLabel(id, model.MainBranch, 6, "lua"); err != nil {
		t.Fatal(err)
	}
	labels, err = e.m.SetLabel(id, exBranch, 0, "first")
	want := []model.TreeLabel{{Branch: model.MainBranch, Item: 0, Text: "first"}, onMain,
		{Branch: model.MainBranch, Item: 6, Text: "lua"}, onBranch}
	if err != nil || !reflect.DeepEqual(labels, want) {
		t.Fatalf("labels %+v %v", labels, err)
	}
	if got, _ := e.treeFile(id); !reflect.DeepEqual(got.Labels, want) {
		t.Fatalf("tree.json labels %+v", got.Labels)
	}

	// Setting replaces; the same index of another branch's own part is another label.
	labels, err = e.m.SetLabel(id, model.MainBranch, 3, "cache")
	if err != nil || len(labels) != 5 {
		t.Fatalf("labels %+v %v", labels, err)
	}
	labels, err = e.m.SetLabel(id, model.MainBranch, 1, "choices")
	if err != nil || len(labels) != 5 || labels[1] != (model.TreeLabel{Branch: model.MainBranch, Item: 1, Text: "choices"}) {
		t.Fatalf("labels %+v %v", labels, err)
	}
	tv := e.tree(id)
	if !reflect.DeepEqual(tv.Labels, labels) {
		t.Fatalf("tree labels %+v", tv.Labels)
	}

	// Blank text removes, through any branch that shows the item.
	for _, l := range [][2]any{{exBranch, 1}, {model.MainBranch, 0}, {model.MainBranch, 6}, {model.MainBranch, 3}} {
		if labels, err = e.m.SetLabel(id, l[0].(string), l[1].(int), "  "); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(labels, []model.TreeLabel{onBranch}) {
		t.Fatalf("labels after removing %+v", labels)
	}
	labels, err = e.m.SetLabel(id, exBranch, 3, "")
	if err != nil || labels == nil || len(labels) != 0 {
		t.Fatalf("labels after removing all %#v %v", labels, err)
	}
	if got, _ := e.treeFile(id); len(got.Labels) != 0 || !reflect.DeepEqual(got.Branches, exampleTree.Branches) {
		t.Fatalf("tree.json %+v", got)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("SetLabel sent events: %v", got)
	}
}

func TestSetLabelUnsplitChatSurvivesRestart(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.writeItems(v.ID, exampleMain())
	e.boot()

	// Removing a label that is not there writes nothing.
	if labels, err := e.m.SetLabel(v.ID, model.MainBranch, 1, ""); err != nil || labels == nil || len(labels) != 0 {
		t.Fatalf("removing nothing: %#v %v", labels, err)
	}
	if _, ok := e.treeFile(v.ID); ok {
		t.Fatal("tree.json written for a label that was not there")
	}

	want := []model.TreeLabel{{Branch: model.MainBranch, Item: 1, Text: "options"}}
	if labels, err := e.m.SetLabel(v.ID, model.MainBranch, 1, "options"); err != nil || !reflect.DeepEqual(labels, want) {
		t.Fatalf("SetLabel: %+v %v", labels, err)
	}
	raw, err := os.ReadFile(e.m.treePath(v.ID))
	if err != nil {
		t.Fatal(err)
	}
	var file map[string]any
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(file, map[string]any{"branches": []any{},
		"labels": []any{map[string]any{"branch": "main", "item": 1.0, "text": "options"}}}) {
		t.Fatalf("tree.json %s", raw)
	}

	e.boot()
	tv := e.tree(v.ID)
	if !reflect.DeepEqual(tv.Labels, want) || len(tv.Branches) != 1 || tv.Current != model.MainBranch {
		t.Fatalf("tree after a restart %+v", tv)
	}
}

func TestSetLabelErrors(t *testing.T) {
	e := newEnv(t)
	note := append(exampleMain(), model.Item{Kind: "note", Tone: "muted", Text: "Stopped."})

	unsplit := e.create(model.Claude, gOne, "")
	e.writeItems(unsplit.ID, note)
	split := e.create(model.Claude, gOne, "")
	e.writeItems(split.ID, note)
	e.writeItems(branchChatID(split.ID, exBranch), exampleBranch())
	e.boot()
	e.writeTree(split.ID, exampleTree)
	before, err := os.ReadFile(e.m.treePath(split.ID))
	if err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		chat, branch string
		item         int
		want         error
	}{
		{"nope", model.MainBranch, 1, ErrNotFound},
		{branchChatID(split.ID, exBranch), model.MainBranch, 1, ErrNotFound},
		{unsplit.ID, exBranch, 1, ErrNoBranch},
		{unsplit.ID, "", 1, ErrNoBranch},
		{split.ID, "ffffffff", 1, ErrNoBranch},
		{unsplit.ID, model.MainBranch, 5, ErrBadLabel},  // a tool call
		{unsplit.ID, model.MainBranch, 8, ErrBadLabel},  // a note
		{unsplit.ID, model.MainBranch, 2, ErrBadLabel},  // an end mark
		{unsplit.ID, model.MainBranch, 9, ErrBadLabel},  // past the end
		{unsplit.ID, model.MainBranch, -1, ErrBadLabel}, // before the start
		{split.ID, exBranch, 5, ErrBadLabel},            // the branch's end mark
		{split.ID, exBranch, 6, ErrBadLabel},            // past the branch's end, a reply in main
	} {
		for _, text := range []string{"x", ""} {
			if labels, err := e.m.SetLabel(c.chat, c.branch, c.item, text); !errors.Is(err, c.want) || labels != nil {
				t.Errorf("SetLabel(%s, %s, %d, %q) = %v, %v; want %v", c.chat, c.branch, c.item, text, labels, err, c.want)
			}
		}
	}
	if _, ok := e.treeFile(unsplit.ID); ok {
		t.Fatal("tree.json written by a refused label")
	}
	if after, err := os.ReadFile(e.m.treePath(split.ID)); err != nil || !bytes.Equal(after, before) {
		t.Fatalf("tree.json changed by a refused label: %s %v", after, err)
	}
}

// A label is one clean line of at most 200 characters: control characters become spaces, and a
// longer label is refused and changes nothing.
func TestSetLabelCleanAndBounded(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.writeItems(v.ID, exampleMain())
	e.boot()

	for _, c := range [][2]string{
		{"a\nb\x00c\x1b[31m", "a b c [31m"},
		{"\x00 options\r\n", "options"},
		{"one\ttwo\u0085three", "one two three"},
		{strings.Repeat("é", 200), strings.Repeat("é", 200)},
		{" " + strings.Repeat("x", 200) + "\n", strings.Repeat("x", 200)},
	} {
		want := []model.TreeLabel{{Branch: model.MainBranch, Item: 1, Text: c[1]}}
		if labels, err := e.m.SetLabel(v.ID, model.MainBranch, 1, c[0]); err != nil || !reflect.DeepEqual(labels, want) {
			t.Errorf("SetLabel(%q) = %+v, %v; want %q", c[0], labels, err, c[1])
		}
	}
	// Only control characters: blank, so the label is removed.
	if labels, err := e.m.SetLabel(v.ID, model.MainBranch, 1, "\x00\n\x1b"); err != nil || labels == nil || len(labels) != 0 {
		t.Errorf("a label of control characters: %#v %v", labels, err)
	}

	kept := []model.TreeLabel{{Branch: model.MainBranch, Item: 1, Text: "options"}}
	if _, err := e.m.SetLabel(v.ID, model.MainBranch, 1, "options"); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{strings.Repeat("x", 201), strings.Repeat("é", 201), strings.Repeat("x", 200_000)} {
		for _, item := range []int{1, 3} { // a labeled message, and one without a label
			if labels, err := e.m.SetLabel(v.ID, model.MainBranch, item, text); !errors.Is(err, ErrBadLabel) || labels != nil {
				t.Errorf("SetLabel(item %d, %d bytes) = %d labels, %v; want ErrBadLabel", item, len(text), len(labels), err)
			}
		}
	}
	if got, _ := e.treeFile(v.ID); !reflect.DeepEqual(got.Labels, kept) {
		t.Fatalf("tree.json labels after refused labels: %d", len(got.Labels))
	}
}

// A reply the thread shows as done can be labeled before the pump has written it: the tree and
// the label read the loaded list, which is ahead of items.jsonl.
func TestSetLabelWhileBusy(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "ask", "")
	a := e.claude.last(t)
	a.emit(t, agent.Event{Kind: agent.EvText, Text: "options"},
		agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Read"})
	if !e.m.Busy(v.ID) {
		t.Fatal("the chat is not busy")
	}
	raw, err := os.ReadFile(e.m.itemsPath(v.ID))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("options")) {
		t.Fatalf("the reply is in items.jsonl already: %s", raw)
	}

	want := []model.TreeLabel{{Branch: model.MainBranch, Item: 1, Text: "opts"}}
	if labels, err := e.m.SetLabel(v.ID, model.MainBranch, 1, "opts"); err != nil || !reflect.DeepEqual(labels, want) {
		t.Fatalf("SetLabel on an unflushed reply: %+v %v", labels, err)
	}
	if _, err := e.m.SetLabel(v.ID, model.MainBranch, 2, "tool"); !errors.Is(err, ErrBadLabel) {
		t.Fatalf("SetLabel on the running tool call: %v", err)
	}
	tv := e.tree(v.ID)
	zero := 0
	wantItems := []model.TreeItem{
		{I: 0, Kind: "user", Text: "ask", Before: &zero},
		{I: 1, Kind: "text", Text: "options", Done: true},
	}
	if tv.Branches[0].Len != 3 || !reflect.DeepEqual(tv.Branches[0].Items, wantItems) || !reflect.DeepEqual(tv.Labels, want) {
		t.Fatalf("tree while busy %+v", tv)
	}
}

func TestSetLabelArchivedAndLegacy(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.writeItems(v.ID, exampleMain())
	meta := e.meta(v.ID)
	meta.InstructionsSent = true // a legacy chat
	if err := store.WriteJSONAtomic(filepath.Join(e.st.P.ChatDir(v.ID), "chat.json"), meta, 0o600); err != nil {
		t.Fatal(err)
	}
	e.boot()
	if err := e.m.SetArchive(v.ID, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Send(v.ID, "more", "", nil); !errors.Is(err, ErrArchived) {
		t.Fatalf("Send on the archived chat: %v", err)
	}
	if labels, err := e.m.SetLabel(v.ID, model.MainBranch, 1, "options"); err != nil || len(labels) != 1 {
		t.Fatalf("SetLabel on an archived chat: %+v %v", labels, err)
	}
	if tv := e.tree(v.ID); len(tv.Labels) != 1 {
		t.Fatalf("tree of an archived chat %+v", tv)
	}
}

func TestSetLabelConcurrent(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	const n = 24
	items := make([]model.Item, n)
	for i := range items {
		items[i] = model.Item{Kind: "user", Text: fmt.Sprint("message ", i)}
	}
	e.writeItems(v.ID, items)
	e.boot()

	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := e.m.SetLabel(v.ID, model.MainBranch, i, fmt.Sprint("label ", i)); err != nil {
				t.Error(err)
			}
			if _, err := e.m.Tree(v.ID); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	got, _ := e.treeFile(v.ID)
	if len(got.Labels) != n {
		t.Fatalf("%d labels in tree.json, want %d", len(got.Labels), n)
	}
	for i, l := range got.Labels {
		if l != (model.TreeLabel{Branch: model.MainBranch, Item: i, Text: fmt.Sprint("label ", i)}) {
			t.Fatalf("label %d: %+v", i, l)
		}
	}
}
