package chats

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// copyPrefix calls Manager.copyPrefix as its callers do: the source locked, its transcript loaded.
func (e *env) copyPrefix(id, dstID string, count int) error {
	e.t.Helper()
	var out outbox
	c, err := e.m.lock(id)
	if err != nil {
		e.t.Fatal(err)
	}
	defer c.mu.Unlock()
	if _, err := e.m.trOf(c, &out); err != nil {
		e.t.Fatal(err)
	}
	return e.m.copyPrefix(c, dstID, count)
}

// folder reads everything under dir: slash path → content. A folder is listed with a trailing
// "/". Files must be 0600 and folders 0700 when modes is set.
func folder(t *testing.T, dir string, modes bool) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == dir {
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		rel = filepath.ToSlash(rel)
		fi, err := d.Info()
		if err != nil {
			return err
		}
		if d.IsDir() {
			out[rel+"/"] = ""
			if modes && fi.Mode().Perm() != 0o700 {
				t.Errorf("folder %s has mode %v", rel, fi.Mode().Perm())
			}
			return nil
		}
		raw, err := os.ReadFile(path)
		out[rel] = string(raw)
		if modes && fi.Mode().Perm() != 0o600 {
			t.Errorf("file %s has mode %v", rel, fi.Mode().Perm())
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func names(files map[string]string) []string {
	out := make([]string, 0, len(files))
	for n := range files {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// lineIndexes returns the "i" of every line of an items.jsonl, in file order.
func lineIndexes(t *testing.T, raw string) []int {
	t.Helper()
	var out []int
	for _, l := range strings.Split(strings.TrimSuffix(raw, "\n"), "\n") {
		var ln struct {
			I int `json:"i"`
		}
		if err := json.Unmarshal([]byte(l), &ln); err != nil {
			t.Fatalf("line %q: %v", l, err)
		}
		out = append(out, ln.I)
	}
	return out
}

func noFolder(t *testing.T, dir string) {
	t.Helper()
	if _, err := os.Lstat(dir); !os.IsNotExist(err) {
		t.Fatalf("%s was left behind: %v", dir, err)
	}
}

// rewritten is an items.jsonl in write order: the tool item is written, written again with its
// result, and once more with a late subagent link; index 5 was never written (a hole).
const rewritten = `{"i":0,"item":{"kind":"user","text":"count the files"}}
{"i":1,"item":{"kind":"tool","toolId":"t1","name":"Agent"}}
{"i":2,"item":{"kind":"text","text":"42","done":true}}
{"i":1,"item":{"kind":"tool","toolId":"t1","name":"Agent","result":"42 files"}}
{"i":3,"item":{"kind":"end","point":"p1"}}
{"i":1,"item":{"kind":"tool","toolId":"t1","name":"Agent","result":"42 files","subagent":"aaaaaaaaaaaa"}}
{"i":4,"item":{"kind":"user","text":"more"}}
{"i":6,"item":{"kind":"text","text":"later","done":true}}
{"i":7,"item":{"kind":"end","point":"p2"}}
`

func TestCopyPrefixRewrittenLines(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if err := os.WriteFile(filepath.Join(e.st.P.ChatDir(v.ID), "items.jsonl"), []byte(rewritten), 0o600); err != nil {
		t.Fatal(err)
	}
	e.boot() // the chat's thread is read from the file
	before := folder(t, e.st.P.ChatDir(v.ID), false)
	src := e.items(v.ID)

	if err := e.copyPrefix(v.ID, "dst4", 4); err != nil {
		t.Fatal(err)
	}
	got := folder(t, e.st.P.ChatDir("dst4"), true)
	// The linked subagent has no folder in the source: the row is skipped, nothing else is made.
	if !reflect.DeepEqual(names(got), []string{"items.jsonl"}) {
		t.Fatalf("copy holds %v", names(got))
	}
	if idx := lineIndexes(t, got["items.jsonl"]); !reflect.DeepEqual(idx, []int{0, 1, 2, 3}) {
		t.Fatalf("line indexes %v:\n%s", idx, got["items.jsonl"])
	}
	items := diskItems(t, filepath.Join(e.st.P.ChatDir("dst4"), "items.jsonl"))
	if !reflect.DeepEqual(items, src[:4]) {
		t.Fatalf("copied %+v\nwant %+v", items, src[:4])
	}
	if it := items[1]; it.Result == nil || *it.Result != "42 files" || it.Subagent != "aaaaaaaaaaaa" {
		t.Fatalf("tool item is not in its final state: %+v", it)
	}
	if items[3].Kind != "end" || items[3].Point != "p1" {
		t.Fatalf("end mark %+v", items[3])
	}

	// A hole stays a hole: no line for it, and the items after it keep their indexes.
	if err := e.copyPrefix(v.ID, "dst7", 7); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(e.st.P.ChatDir("dst7"), "items.jsonl"))
	if idx := lineIndexes(t, string(raw)); !reflect.DeepEqual(idx, []int{0, 1, 2, 3, 4, 6}) {
		t.Fatalf("line indexes %v:\n%s", idx, raw)
	}
	if items := diskItems(t, filepath.Join(e.st.P.ChatDir("dst7"), "items.jsonl")); !reflect.DeepEqual(items, src[:7]) {
		t.Fatalf("copied %+v\nwant %+v", items, src[:7])
	}

	if after := folder(t, e.st.P.ChatDir(v.ID), false); !reflect.DeepEqual(after, before) {
		t.Fatalf("the source changed:\n%v\nwas\n%v", after, before)
	}
}

func TestCopyPrefixLiveItems(t *testing.T) {
	e := newEnv(t)
	id, _ := e.subStart() // the tool call t1 has no result and was never written
	if disk := diskItems(t, filepath.Join(e.st.P.ChatDir(id), "items.jsonl")); len(disk) != 1 {
		t.Fatalf("source items.jsonl %+v", disk)
	}
	before := folder(t, e.st.P.ChatDir(id), false)
	if err := e.copyPrefix(id, "dst", 2); err != nil {
		t.Fatal(err)
	}
	items := diskItems(t, filepath.Join(e.st.P.ChatDir("dst"), "items.jsonl"))
	if !reflect.DeepEqual(items, e.items(id)) {
		t.Fatalf("copied %+v\nwant %+v", items, e.items(id))
	}
	if it := items[1]; it.Kind != "tool" || it.ToolID != "t1" || it.Result != nil {
		t.Fatalf("open tool item %+v", it)
	}
	if after := folder(t, e.st.P.ChatDir(id), false); !reflect.DeepEqual(after, before) {
		t.Fatalf("the source changed:\n%v\nwas\n%v", after, before)
	}
}

// subTree builds a Claude chat with four subagent folders and returns the point after its first
// turn: A is started by the turn's tool call t1, B by a tool call in A's thread, C by a tool call
// of the second turn, and D holds only a pi/ folder (a pi-native child's).
func (e *env) subTree() (id string, count int, a, b, c string) {
	e.t.Helper()
	id, ag := e.subStart()
	subRun(e.t, ag, "t1")
	a = e.onlySub(id)
	ag.emit(e.t, agent.Event{Kind: agent.EvToolStart, Sub: "t1", ToolID: "t2", ToolName: "Agent"})
	subRun(e.t, ag, "t2")
	for _, s := range e.subs(id) {
		if s.Parent == a {
			b = s.ID
		}
	}
	ag.emit(e.t,
		agent.Event{Kind: agent.EvText, Sub: "t2", Text: "inner work"},
		agent.Event{Kind: agent.EvSub, Sub: "t2", SubInfo: &agent.SubInfo{Status: model.SubCompleted}},
		agent.Event{Kind: agent.EvToolResult, Sub: "t1", ToolID: "t2", Result: "inner done"},
		agent.Event{Kind: agent.EvText, Sub: "t1", Text: "outer work"},
		agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubCompleted}},
		agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "42 files"},
		agent.Event{Kind: agent.EvText, Text: "There are 42."},
		agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	count = len(e.items(id))

	e.send(id, "again", "")
	ag.emit(e.t, agent.Event{Kind: agent.EvToolStart, ToolID: "t3", ToolName: "Agent"})
	subRun(e.t, ag, "t3")
	for _, s := range e.subs(id) {
		if s.Tool == "t3" {
			c = s.ID
		}
	}
	if b == "" || c == "" {
		e.t.Fatalf("subagents %+v", e.subs(id))
	}

	// What a copy must leave behind: pi session folders, the tree record, other branches.
	dir := e.st.P.ChatDir(id)
	for _, f := range []string{"pi/session.jsonl", "subagents/" + a + "/pi/session.jsonl",
		"subagents/dddddddddddd/pi/session.jsonl", "tree.json", "branches/0a1b2c3d/chat.json"} {
		path := filepath.Join(dir, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			e.t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
			e.t.Fatal(err)
		}
	}
	return id, count, a, b, c
}

func TestCopyPrefixSubagents(t *testing.T) {
	e := newEnv(t)
	id, count, a, b, c := e.subTree()
	if items := e.items(id); count != 4 || items[1].Subagent != a || items[5].Subagent != c {
		t.Fatalf("source items (count %d) %+v", count, items)
	}
	before := folder(t, e.st.P.ChatDir(id), false)

	if err := e.copyPrefix(id, "dst", count); err != nil {
		t.Fatal(err)
	}
	got := folder(t, e.st.P.ChatDir("dst"), true)
	want := []string{"items.jsonl", "subagents/",
		"subagents/" + a + "/", "subagents/" + a + "/items.jsonl", "subagents/" + a + "/subagent.json",
		"subagents/" + b + "/", "subagents/" + b + "/items.jsonl", "subagents/" + b + "/subagent.json"}
	sort.Strings(want)
	if !reflect.DeepEqual(names(got), want) {
		t.Fatalf("copy holds %v\nwant %v", names(got), want)
	}
	for _, f := range want[1:] {
		if !strings.HasSuffix(f, "/") && got[f] != before[f] {
			t.Errorf("%s differs from the source's:\n%s\nsource:\n%s", f, got[f], before[f])
		}
	}
	if items := diskItems(t, filepath.Join(e.st.P.ChatDir("dst"), "items.jsonl")); !reflect.DeepEqual(items, e.items(id)[:count]) {
		t.Fatalf("copied %+v\nwant %+v", items, e.items(id)[:count])
	}
	if after := folder(t, e.st.P.ChatDir(id), false); !reflect.DeepEqual(after, before) {
		t.Fatalf("the source changed:\n%v\nwas\n%v", after, before)
	}

	// The copy loads as a chat's subagents do.
	dst := &Chat{meta: model.ChatMeta{ID: "dst"}}
	e.m.loadSubs(dst)
	if len(dst.subs) != 2 || dst.subs[a] == nil || dst.subs[b] == nil || dst.subs[b].meta.Parent != a ||
		dst.subByTool["t1"] != a || dst.subByTool["t2"] != b {
		t.Fatalf("loaded subagents %+v, by tool %+v", dst.subs, dst.subByTool)
	}
}

func TestCopyPrefixBranchFolder(t *testing.T) {
	e := newEnv(t)
	id, count, a, b, _ := e.subTree()
	before := folder(t, e.st.P.ChatDir(id), false)

	dstID := id + "/branches/1f2e3d4c"
	if err := e.copyPrefix(id, dstID, count); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(e.root, "chats", id, "branches", "1f2e3d4c")
	got := folder(t, dir, true)
	want := []string{"items.jsonl", "subagents/",
		"subagents/" + a + "/", "subagents/" + a + "/items.jsonl", "subagents/" + a + "/subagent.json",
		"subagents/" + b + "/", "subagents/" + b + "/items.jsonl", "subagents/" + b + "/subagent.json"}
	sort.Strings(want)
	if !reflect.DeepEqual(names(got), want) {
		t.Fatalf("branch folder holds %v\nwant %v", names(got), want)
	}
	if got["subagents/"+b+"/items.jsonl"] != before["subagents/"+b+"/items.jsonl"] {
		t.Fatalf("nested thread %q", got["subagents/"+b+"/items.jsonl"])
	}

	// Apart from the new branch's folder, the source is as it was.
	after := folder(t, e.st.P.ChatDir(id), false)
	for f := range after {
		if strings.HasPrefix(f, "branches/1f2e3d4c/") {
			delete(after, f)
		}
	}
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("the source changed:\n%v\nwas\n%v", after, before)
	}
}

func TestCopyPrefixPermSubagent(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"}) // no tool item links it
	child := waitChild(t, e.claude, 1)
	child.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "s1"})
	items := e.items(v.ID)
	if len(items) != 1 || items[0].Kind != "perm" || items[0].Subagent != sa.ID {
		t.Fatalf("source items %+v", items)
	}

	if err := e.copyPrefix(v.ID, "dst", 1); err != nil {
		t.Fatal(err)
	}
	got := folder(t, e.st.P.ChatDir("dst"), true)
	want := []string{"items.jsonl", "subagents/", "subagents/" + sa.ID + "/", "subagents/" + sa.ID + "/subagent.json"}
	if !reflect.DeepEqual(names(got), want) {
		t.Fatalf("copy holds %v\nwant %v", names(got), want)
	}
	// The undecided permission is copied as it is: the file has it open. Loading the copy closes
	// it, as loading any thread does.
	raw, err := os.ReadFile(filepath.Join(e.st.P.ChatDir("dst"), "items.jsonl"))
	if err != nil || !strings.Contains(string(raw), `"requestId":"r1"`) || strings.Contains(string(raw), `"decided"`) {
		t.Fatalf("copied file %q %v", raw, err)
	}
	if items := diskItems(t, filepath.Join(e.st.P.ChatDir("dst"), "items.jsonl")); len(items) != 1 ||
		items[0].RequestID != "r1" || items[0].Decided != "deny" || items[0].Subagent != sa.ID {
		t.Fatalf("copied %+v", items)
	}
}

func TestCopyPrefixFlushesRunningSubagent(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	emitSpawnItem(t, parent, "t1", "mcp__board__spawn_subagent", `{"prompt":"go"}`)
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	child.emit(t, agent.Event{Kind: agent.EvTextDelta, Text: "partial"})
	thread := filepath.Join(e.subDir(id, sa.ID), "items.jsonl")
	if _, err := os.Stat(thread); !os.IsNotExist(err) {
		t.Fatalf("the open text is on disk before the copy: %v", err)
	}
	before := folder(t, e.st.P.ChatDir(id), false)

	if err := e.copyPrefix(id, "dst", 2); err != nil {
		t.Fatal(err)
	}
	items := diskItems(t, filepath.Join(e.subDir("dst", sa.ID), "items.jsonl"))
	if len(items) != 1 || items[0].Text != "partial" || items[0].Done {
		t.Fatalf("copied thread %+v", items)
	}
	got, after := folder(t, e.st.P.ChatDir("dst"), true), folder(t, e.st.P.ChatDir(id), false)
	for _, f := range []string{"items.jsonl", "subagent.json"} {
		f = "subagents/" + sa.ID + "/" + f
		if got[f] == "" || got[f] != after[f] {
			t.Errorf("%s differs from the source's after the flush:\n%s\nsource:\n%s", f, got[f], after[f])
		}
		delete(after, f)
		delete(before, f)
	}
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("the source changed beyond the subagent's flush:\n%v\nwas\n%v", after, before)
	}
	if f := e.subFile("dst", sa.ID); f.Status != model.SubRunning || f.Tool != "t1" {
		t.Fatalf("copied subagent.json %+v", f)
	}

	// Still running in the source; the copy shows it stopped once it is loaded.
	if s := e.subs(id); len(s) != 1 || s[0].Status != model.SubRunning {
		t.Fatalf("source subagents %+v", s)
	}
	dst := &Chat{meta: model.ChatMeta{ID: "dst"}}
	e.m.loadSubs(dst)
	if s := dst.subs[sa.ID]; s == nil || s.meta.Status != model.SubStopped {
		t.Fatalf("loaded copy %+v", dst.subs)
	}
}

func TestCopyPrefixNothing(t *testing.T) {
	e := newEnv(t)
	id, _, _, _, _ := e.subTree()
	before := folder(t, e.st.P.ChatDir(id), false)
	if err := e.copyPrefix(id, "dst", 0); err != nil {
		t.Fatal(err)
	}
	if got := folder(t, e.st.P.ChatDir("dst"), true); len(got) != 0 {
		t.Fatalf("copy holds %v", names(got))
	}
	if after := folder(t, e.st.P.ChatDir(id), false); !reflect.DeepEqual(after, before) {
		t.Fatalf("the source changed:\n%v\nwas\n%v", after, before)
	}
}

func TestCopyPrefixFailureLeavesNothing(t *testing.T) {
	e := newEnv(t)
	id, count, a, _, _ := e.subTree()
	n := len(e.items(id))

	// A count outside the thread.
	for _, bad := range []int{-1, n + 1} {
		if err := e.copyPrefix(id, "dst", bad); !errors.Is(err, ErrBadPoint) {
			t.Fatalf("count %d: %v", bad, err)
		}
		noFolder(t, e.st.P.ChatDir("dst"))
	}

	// A destination that cannot be made: its parent is a file.
	if err := os.WriteFile(e.st.P.ChatDir("blocked"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := e.copyPrefix(id, "blocked/branches/1f2e3d4c", count); err == nil {
		t.Fatal("copy into a file succeeded")
	}
	if fi, err := os.Lstat(e.st.P.ChatDir("blocked")); err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("blocked: %v %v", fi, err)
	}

	// A failure halfway (a subagent's thread that cannot be read) removes the items already
	// written and the folder with them.
	thread := filepath.Join(e.subDir(id, a), "items.jsonl")
	if err := os.Remove(thread); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(thread, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := e.copyPrefix(id, "dst", count); err == nil {
		t.Fatal("copy of an unreadable thread succeeded")
	}
	noFolder(t, e.st.P.ChatDir("dst"))
	branch := id + "/branches/1f2e3d4c"
	if err := e.copyPrefix(id, branch, count); err == nil {
		t.Fatal("copy of an unreadable thread succeeded")
	}
	noFolder(t, e.st.P.ChatDir(branch))

	// A folder that was there before the call keeps what it had and loses only what the copy made.
	old := e.st.P.ChatDir("old")
	if err := os.MkdirAll(old, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(old, "keep"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := e.copyPrefix(id, "old", count); err == nil {
		t.Fatal("copy of an unreadable thread succeeded")
	}
	if got := folder(t, old, false); !reflect.DeepEqual(got, map[string]string{"keep": "x"}) {
		t.Fatalf("the folder holds %v", got)
	}
}
