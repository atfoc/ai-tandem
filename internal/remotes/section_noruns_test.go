package remotes

import (
	"encoding/json"
	"maps"
	"slices"
	"testing"

	"ai-whiteboard/internal/model"
)

// A server may be a build that still has runs: its snapshot lists them, and its chats on a run
// and its run agents' chats are among its chats. This build has no runs, so none of it is taken.

// viewMap is the view of a chat as such a server sends it, with the members it adds.
func viewMap(t *testing.T, v model.ChatView, extra map[string]any) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(mustJSON(t, v), &m); err != nil {
		t.Fatal(err)
	}
	for k, x := range extra {
		m[k] = x
	}
	return m
}

// withRuns is the snapshot of a server with runs: an ordinary chat, a chat on a run and a run
// agent's chat, each with its state, and the run.
func withRuns(t *testing.T) (snap map[string]any, ordinary model.ChatView) {
	t.Helper()
	ordinary = farChat(chatA, model.StatusReady)
	onRun := farChat(chatB, model.StatusThinking)
	agent := farChat(agent1, model.StatusThinking)
	snap = snapshotOf(tree{})
	snap["chats"] = []any{
		viewMap(t, ordinary, nil),
		viewMap(t, onRun, map[string]any{"run": runA}),
		viewMap(t, agent, map[string]any{"run": runA, "role": "task"}),
	}
	snap["states"] = []model.BranchState{
		model.StateOf(chatA, mainBranch, ordinary),
		model.StateOf(chatB, mainBranch, onRun),
		model.StateOf(agent1, mainBranch, agent),
	}
	snap["runs"] = []any{map[string]any{
		"id": runA, "name": "A run", "group": "g_there", "agent": "claude", "cwd": "/home/standin/work", "git": true,
		"created": ordinary.Created, "status": "running", "turns": 1,
	}}
	return snap, ordinary
}

// hasKey reports whether the JSON value v has a member named key at any depth.
func hasKey(v any, key string) bool {
	switch v := v.(type) {
	case map[string]any:
		for k, x := range v {
			if k == key || hasKey(x, key) {
				return true
			}
		}
	case []any:
		for _, x := range v {
			if hasKey(x, key) {
				return true
			}
		}
	}
	return false
}

// TestSectionSnapshotWithRuns: the tree of a server with runs holds its ordinary chats alone: no
// run, no chat on a run, no run agent's chat and no state of one, and nothing of it in the JSON
// of the tree, in the page's snapshot or in the section event.
func TestSectionSnapshotWithRuns(t *testing.T) {
	t.Parallel()
	snap, ordinary := withRuns(t)
	rg := newRig(t, rigOpt{snapshot: snap, hold: true})
	early, _ := rg.page("page-early")
	rg.start()

	held, ok := rg.treeOf()
	if !ok {
		t.Fatal("the relay holds no tree of a connected entry")
	}
	if len(held.Chats) != 1 || held.Chats[0].ID != chatA || !sameJSON(t, held.Chats[0], ordinary) ||
		len(held.States) != 1 || held.States[0].Chat != chatA {
		t.Errorf("the tree holds more or less than the ordinary chat: %s", mustJSON(t, held))
	}
	ev := next(t, early, "section")
	_, later := rg.page("page-later")
	for what, v := range map[string]any{"the tree": held, "the section event": ev["tree"], "the snapshot": later["sections"]} {
		generic := mustAny(t, v)
		for _, key := range []string{"runs", "run", "role"} {
			if hasKey(generic, key) {
				t.Errorf("%s has the key %q: %s", what, key, mustJSON(t, v))
			}
		}
	}
	if got := rg.logs.all(); len(got) != 0 {
		t.Errorf("the log: %v", got)
	}
}

// TestSectionEventsOfRunsDropped: after such a snapshot, the events of the runs of that server
// reach no page and change nothing in the tree, and nor does the view of a chat on a run or of a
// run agent's chat. The chats that are this build's go on.
func TestSectionEventsOfRunsDropped(t *testing.T) {
	t.Parallel()
	snap, ordinary := withRuns(t)
	rg := newRig(t, rigOpt{snapshot: snap})
	p1, _ := rg.page("page-1")
	p2, _ := rg.page("page-2")
	before, _ := rg.treeOf()

	onRun := viewMap(t, farChat(chatB, model.StatusWriting), map[string]any{"run": runA})
	agent := viewMap(t, farChat(agent1, model.StatusWriting), map[string]any{"run": runA, "role": "task"})
	moved := viewMap(t, ordinary, map[string]any{"run": runA}) // the ordinary chat, said to be on a run now
	for _, ev := range []map[string]any{
		{"type": "run", "run": map[string]any{"id": runA, "name": "A run", "group": "g_there", "status": "running"}},
		{"type": "run", "run": map[string]any{"id": "r_new", "name": "Another", "group": "g_there", "status": "draft"}},
		{"type": "run_detail", "run": runA, "version": 2, "tasks": []any{}},
		{"type": "run_activity", "run": runA, "agents": map[string]any{}},
		{"type": "run_removed", "id": runA},
		{"type": "chat", "chat": onRun},
		{"type": "chat", "chat": agent},
		{"type": "chat", "chat": moved},
	} {
		rg.s.Send(ev)
	}
	for i, got := range rg.barrier(p1, p2) {
		if len(got) != 0 {
			t.Errorf("page %d got %v", i+1, got)
		}
	}
	if after, _ := rg.treeOf(); !sameJSON(t, after, before) {
		t.Errorf("the tree changed:\n%s\nwas\n%s", mustJSON(t, after), mustJSON(t, before))
	}

	// A chat that is this build's goes on: the tree takes its view and the pages get it.
	renamed := farChat(chatA, model.StatusThinking)
	renamed.Name = "Renamed"
	rg.s.Send(map[string]any{"type": "chat", "chat": renamed})
	for i, got := range rg.barrier(p1, p2) {
		if len(got) != 1 || got[0]["type"] != "chat" || got[0]["server"] != rg.entry || !sameJSON(t, got[0]["chat"], renamed) {
			t.Errorf("page %d got %v", i+1, got)
		}
	}
	after, _ := rg.treeOf()
	if len(after.Chats) != 1 || after.Chats[0].Name != "Renamed" || after.Chats[0].Status != model.StatusThinking {
		t.Errorf("the tree after the event of the ordinary chat: %s", mustJSON(t, after))
	}
	if hasKey(mustAny(t, after), "runs") {
		t.Errorf("the tree has runs: %s", mustJSON(t, after))
	}
}

// TestSectionStatesOfDroppedChatsNotKept: the branch states of a chat whose view was dropped, as
// it is not this build's, are not kept to wait for a view that will not come: they leave early
// empty and reach no page. The state of a new chat of this build that comes before its view still
// joins the tree with the view, however many states of dropped chats came first.
func TestSectionStatesOfDroppedChatsNotKept(t *testing.T) {
	t.Parallel()
	snap, _ := withRuns(t)
	rg := newRig(t, rigOpt{snapshot: snap})
	p1, _ := rg.page("page-1")
	p2, _ := rg.page("page-2")
	before, _ := rg.treeOf()
	waiting := func() (ids []string) {
		rg.r.change(rg.entry, func(sec *section) { ids = slices.Sorted(maps.Keys(sec.early)) })
		return ids
	}

	// A chat on a run whose view came after the snapshot, and the two the snapshot dropped.
	fresh := farChat(chatN(1), model.StatusWriting)
	rg.s.Send(map[string]any{"type": "chat", "chat": viewMap(t, fresh, map[string]any{"run": runA})})
	dropped := []string{chatN(1), chatB, agent1}
	for round := 0; round < 3*maxEarly; round++ {
		for _, id := range dropped {
			rg.s.Send(map[string]any{"type": "branch_state", "state": model.StateOf(id, mainBranch, fresh)})
		}
	}
	for i, got := range rg.barrier(p1, p2) {
		if len(got) != 0 {
			t.Errorf("page %d got %v", i+1, got)
		}
	}
	if ids := waiting(); len(ids) != 0 {
		t.Errorf("the states of dropped chats wait for a view: %v", ids)
	}
	if after, _ := rg.treeOf(); !sameJSON(t, after, before) {
		t.Errorf("the tree changed:\n%s\nwas\n%s", mustJSON(t, after), mustJSON(t, before))
	}

	// A new chat of this build: its state waits, and joins the tree with its view.
	v := farChat(chatN(2), model.StatusReady)
	st := model.StateOf(v.ID, mainBranch, v)
	rg.s.Send(map[string]any{"type": "branch_state", "state": st})
	for i, got := range rg.barrier(p1, p2) {
		if len(got) != 0 {
			t.Errorf("page %d got %v", i+1, got)
		}
	}
	if ids := waiting(); len(ids) != 1 || ids[0] != v.ID {
		t.Fatalf("the chats whose states wait: %v", ids)
	}
	rg.s.Send(map[string]any{"type": "chat", "chat": v})
	for i, got := range rg.barrier(p1, p2) {
		if len(got) != 2 || got[0]["type"] != "branch_state" || got[1]["type"] != "chat" ||
			!sameJSON(t, got[0]["state"], st) || !sameJSON(t, got[1]["chat"], v) {
			t.Errorf("page %d got %v", i+1, got)
		}
	}
	after, _ := rg.treeOf()
	if len(after.Chats) != len(before.Chats)+1 || len(after.States) != len(before.States)+1 || !slices.Contains(after.States, st) {
		t.Errorf("the tree with the new chat: %s", mustJSON(t, after))
	}
	if ids := waiting(); len(ids) != 0 {
		t.Errorf("the chats whose states wait: %v", ids)
	}

	// The chat on a run is removed, and its id is free: a chat of this build may take it.
	rg.s.Send(map[string]any{"type": "chat_removed", "id": fresh.ID})
	rg.barrier(p1, p2)
	again := farChat(fresh.ID, model.StatusReady)
	rg.s.Send(map[string]any{"type": "branch_state", "state": model.StateOf(again.ID, mainBranch, again)})
	rg.barrier(p1, p2)
	if ids := waiting(); len(ids) != 1 || ids[0] != again.ID {
		t.Errorf("the chats whose states wait after the id was freed: %v", ids)
	}
}

// mustAny is v as generic JSON.
func mustAny(t *testing.T, v any) any {
	t.Helper()
	var out any
	if err := json.Unmarshal(mustJSON(t, v), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
