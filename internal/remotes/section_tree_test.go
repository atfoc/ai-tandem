package remotes

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// serveReads makes the stand-in answer the reads that follow, of every chat, and the unfollow
// call.
func (f *far) serveReads() {
	for _, pattern := range []string{"GET /api/chats/{id}/items", "GET /api/chats/{id}/tree"} {
		f.s.Handle(pattern, func(w http.ResponseWriter, r *http.Request) {
			writeAnswer(w, http.StatusOK, map[string]any{"version": 1, "of": r.PathValue("id")})
		})
	}
	f.s.Handle("POST /api/chats/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		writeAnswer(w, http.StatusOK, map[string]any{"ok": true})
	})
}

// readChat makes the page read the chat's items through the relay, which makes it a follower.
func (f *far) readChat(p *bridgetest.Page, id string) {
	f.rg.t.Helper()
	if rep := f.rg.r.FollowChat(context.Background(), f.entry, p.ID, id, chatPath(id, "/items")); rep.Status != http.StatusOK {
		f.rg.t.Fatalf("the read of the chat %s on %s: %d %s", id, f.name, rep.Status, rep.Body)
	}
}

// fullTree is a snapshot's tree with one of everything, a second chat and a nested group.
func fullTree() tree {
	archived := farChat(chatB, model.StatusReady)
	archived.Archived, archived.Op = true, "a_1"
	return tree{
		groups: []model.Group{farGroup("g_there", "Work"), {ID: "g_in", Name: "Inner", Parent: "g_there"}},
		boards: []model.Board{farBoard(boardA)},
		chats:  []model.ChatView{farChat(chatA, model.StatusReady), archived},
	}
}

// TestSectionTreeFromSnapshot: the relay takes the tree of an entry from the snapshot of its
// stream's start, as that server has it and in its order, and adds nothing. It drops "collapsed"
// from every group and the state of a chat that is in no list. What
// Sections gives, what a page's snapshot holds and what the section event carried are the same.
func TestSectionTreeFromSnapshot(t *testing.T) {
	t.Parallel()
	tr := fullTree()
	snap := snapshotOf(tr)
	groups := append([]model.Group(nil), tr.groups...)
	groups[1].Collapsed = true
	snap["groups"] = groups
	snap["states"] = append(snap["states"].([]model.BranchState), model.StateOf(agent1, mainBranch, farChat(agent1, model.StatusThinking)))
	snap["defaults"] = map[string]any{"groups": map[string]any{
		"g_there": map[string]any{"servers": map[string]any{"local": map[string]any{"agent": "claude", "cwd": "/home/standin/work"}}},
	}}
	rg := newRig(t, rigOpt{snapshot: snap, hold: true})
	early, first := rg.page("page-early")
	if got := first["sections"]; !reflect.DeepEqual(got, map[string]any{}) {
		t.Fatalf("the sections before the entry connected: %v", got)
	}
	rg.start()

	held, ok := rg.treeOf()
	if !ok {
		t.Fatal("the relay holds no tree of a connected entry")
	}
	want := map[string]any{
		"groups": tr.groups, "boards": tr.boards, "chats": tr.chats,
		"states":   []model.BranchState{model.StateOf(chatA, mainBranch, tr.chats[0]), model.StateOf(chatB, mainBranch, tr.chats[1])},
		"defaults": snap["defaults"],
	}
	if !sameJSON(t, held, want) {
		t.Errorf("the tree the relay holds:\n%s\nwant\n%s", mustJSON(t, held), mustJSON(t, want))
	}
	raw := string(mustJSON(t, held))
	for _, never := range []string{"collapsed", agent1, `"server"`} {
		if strings.Contains(raw, never) {
			t.Errorf("the tree holds %q: %s", never, raw)
		}
	}
	// The order is that server's.
	if held.Groups[0].ID != "g_there" || held.Groups[1].ID != "g_in" || held.Chats[0].ID != chatA || held.Chats[1].ID != chatB {
		t.Errorf("the order of the tree: %s", raw)
	}

	// The section event of the connect, and the snapshot of a page that connects after it.
	ev := next(t, early, "section")
	if ev["server"] != rg.entry || !sameJSON(t, ev["tree"], held) {
		t.Errorf("the section event: %v", ev)
	}
	_, later := rg.page("page-later")
	if got := field(later, "sections", rg.entry); !sameJSON(t, got, held) {
		t.Errorf("the snapshot's section:\n%s\nwant\n%s", mustJSON(t, got), raw)
	}
	if n := len(later["sections"].(map[string]any)); n != 1 {
		t.Errorf("the snapshot has %d sections", n)
	}
}

// TestSectionOfAnEmptyServer: a connected server with nothing on it has a tree, and none of its
// lists is null.
func TestSectionOfAnEmptyServer(t *testing.T) {
	t.Parallel()
	// A server that leaves a list out altogether still gives an empty one.
	snap := emptySnapshot()
	delete(snap, "groups")
	delete(snap, "defaults")
	rg := newRig(t, rigOpt{snapshot: snap})
	const empty = `{"groups":[],"boards":[],"chats":[],"states":[],"defaults":{"groups":{}}}`
	held, ok := rg.treeOf()
	if got := string(mustJSON(t, held)); !ok || got != empty {
		t.Errorf("the tree of an empty server: %s, held %v", got, ok)
	}
	_, snapshot := rg.page("page-1")
	if got := field(snapshot, "sections", rg.entry); !sameJSON(t, got, json.RawMessage(empty)) {
		t.Errorf("the snapshot's section of an empty server: %s", mustJSON(t, got))
	}
}

// TestSectionEvents: every event of a server that changes its tree is applied to the tree the
// relay holds and passed on to every page with the entry's id as "server", in that server's
// order: a thing made, renamed, moved, archived and deleted by anyone shows without a read.
func TestSectionEvents(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree())})
	p1, _ := rg.page("page-1")
	p2, _ := rg.page("page-2")

	made := farChat("2c000000-0000-4000-8000-00000000000c", model.StatusReady)
	made.Locked = false
	renamed := made
	renamed.Name, renamed.UserNamed = "Renamed by the owner", true
	moved := renamed
	moved.Group = "g_in"
	archived := moved
	archived.Archived, archived.Op = true, "a_2"
	working := model.StateOf(chatA, mainBranch, farChat(chatA, model.StatusThinking))
	side := model.StateOf(chatA, "b_side", farChat(chatA, model.StatusReady))
	board := farBoard(boardB)
	boardMoved := board
	boardMoved.Name, boardMoved.Group = "Plan", "g_in"
	groups := []model.Group{{ID: "g_new", Name: "Made by a client"}, farGroup("g_there", "Work renamed"), {ID: "g_in", Name: "Inner", Parent: "g_new"}}
	collapsed := append([]model.Group(nil), groups...)
	collapsed[0].Collapsed = true
	defaults := model.Defaults{Groups: map[string]model.GroupDefaults{"g_new": model.LocalDefaults(model.ServerDefaults{Agent: model.Pi})}}

	sent := []map[string]any{
		{"type": "groups", "groups": collapsed},
		{"type": "defaults", "defaults": defaults},
		{"type": "chat", "chat": made},
		{"type": "chat", "chat": renamed},
		{"type": "chat", "chat": moved},
		{"type": "chat", "chat": archived},
		{"type": "branch_state", "state": working},
		{"type": "branch_state", "state": side},
		{"type": "board", "board": board},
		{"type": "board", "board": boardMoved},
		{"type": "chat_removed", "id": chatB},
		{"type": "board_removed", "id": boardA},
	}
	for _, ev := range sent {
		rg.s.Send(ev)
	}
	// What a page gets is what was sent with "server", but for "collapsed".
	want := make([]map[string]any, len(sent))
	for i, ev := range sent {
		w := map[string]any{"server": rg.entry}
		for k, v := range ev {
			w[k] = v
		}
		want[i] = w
	}
	want[0]["groups"] = groups
	for i, got := range rg.barrier(p1, p2) {
		if len(got) != len(want) {
			t.Fatalf("page %d got %d events, want %d: %v", i+1, len(got), len(want), got)
		}
		for j := range want {
			if !sameJSON(t, got[j], want[j]) {
				t.Errorf("page %d, event %d:\n%s\nwant\n%s", i+1, j, mustJSON(t, got[j]), mustJSON(t, want[j]))
			}
		}
	}

	held, _ := rg.treeOf()
	wantTree := map[string]any{
		"groups": groups, "defaults": defaults,
		"boards": []model.Board{boardMoved},
		"chats":  []model.ChatView{farChat(chatA, model.StatusReady), archived},
		"states": []model.BranchState{working, side},
	}
	if !sameJSON(t, held, wantTree) {
		t.Errorf("the tree after the events:\n%s\nwant\n%s", mustJSON(t, held), mustJSON(t, wantTree))
	}
	if raw := string(mustJSON(t, held)); strings.Contains(raw, "collapsed") {
		t.Errorf("the tree holds collapsed: %s", raw)
	}
	// A page that connects now gets the same tree.
	_, snapshot := rg.page("page-3")
	if got := field(snapshot, "sections", rg.entry); !sameJSON(t, got, held) {
		t.Errorf("the snapshot's section after the events: %s", mustJSON(t, got))
	}

	// An event that cannot be read, one that names nothing and one of an unknown type change
	// nothing and reach no page.
	rg.s.Send(map[string]any{"type": "chat", "chat": "no object"})
	rg.s.Send(map[string]any{"type": "chat", "chat": map[string]any{}})
	rg.s.Send(map[string]any{"type": "board_removed"})
	rg.s.Send(map[string]any{"type": "servers", "servers": []any{}})
	rg.s.Send(map[string]any{"type": "section", "server": "s_000000000000", "tree": nil})
	for i, got := range rg.barrier(p1, p2) {
		if len(got) != 0 {
			t.Errorf("page %d got %v", i+1, got)
		}
	}
	if after, _ := rg.treeOf(); !sameJSON(t, after, held) {
		t.Errorf("the tree changed: %s", mustJSON(t, after))
	}
}

// TestSectionStateBeforeItsChat: a server sends the state of a new chat's branch before the
// chat's view. The state joins the tree with the view, and the pages get both, the state first.
func TestSectionStateBeforeItsChat(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{})
	p, _ := rg.page("page-1")
	v := farChat(chatA, model.StatusReady)
	st := model.StateOf(chatA, mainBranch, v)
	rg.s.Send(map[string]any{"type": "branch_state", "state": st})
	if got := rg.barrier(p)[0]; len(got) != 0 {
		t.Fatalf("the state of a chat that is in no list reached a page that does not follow it: %v", got)
	}
	if held, _ := rg.treeOf(); len(held.States) != 0 || len(held.Chats) != 0 {
		t.Fatalf("the tree before the chat's view: %s", mustJSON(t, held))
	}
	rg.s.Send(map[string]any{"type": "chat", "chat": v})
	got := rg.barrier(p)[0]
	if len(got) != 2 || got[0]["type"] != "branch_state" || got[1]["type"] != "chat" ||
		got[0]["server"] != rg.entry || !sameJSON(t, got[0]["state"], st) || !sameJSON(t, got[1]["chat"], v) {
		t.Fatalf("the events of a new chat: %v", got)
	}
	held, _ := rg.treeOf()
	if !sameJSON(t, held.States, []model.BranchState{st}) || !sameJSON(t, held.Chats, []model.ChatView{v}) {
		t.Errorf("the tree with the new chat: %s", mustJSON(t, held))
	}
	// The states that wait are bounded.
	for i := range 3 * maxEarly {
		rg.s.Send(map[string]any{"type": "branch_state", "state": model.BranchState{Chat: chatN(i), Branch: mainBranch}})
	}
	rg.barrier(p)
	rg.r.change(rg.entry, func(sec *section) {
		if len(sec.early) > maxEarly {
			t.Errorf("%d chats have states that wait for their view", len(sec.early))
		}
	})
}

// chatN is the id of the n-th chat of a test.
func chatN(n int) string { return fmt.Sprintf("2%07d-0000-4000-8000-000000000000", n) }

// TestSectionContentEvents: the content events of a chat are passed on as they came, with the
// entry's id as "server", to the pages that follow the chat and to no other. One that names its
// type or its chat twice, or a server of its own, is dropped.
func TestSectionContentEvents(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree())})
	rg.serveReads()
	chatPage, _ := rg.page("page-chat")
	other, _ := rg.page("page-other")
	rg.readChat(chatPage, chatA)

	sent := []string{
		`{"type":"tree","chat":"` + chatA + `","version":3,"nodes":[{"id":"n1"}],"more":{"kept":"as it came"}}`,
		`{"type":"chat_items","chat":"` + chatA + `","branch":"main","version":4,"updates":[{"i":0}]}`,
		`{"type":"sub","chat":"` + chatA + `","branch":"main","sub":{"id":"s1"}}`,
		`{"type":"sub_items","chat":"` + chatA + `","branch":"main","sub":"s1","version":1,"updates":[]}`,
		// Of a chat nobody follows.
		`{"type":"chat_items","chat":"` + chatB + `","branch":"main","version":1,"updates":[]}`,
		// Not passed on: what a page would read is not what the event was routed by.
		`{"type":"chat_items","type":"tree","chat":"` + chatA + `"}`,
		`{"type":"chat_items","chat":"` + chatB + `","chat":"` + chatA + `"}`,
		`{"type":"chat_items","chat":"` + chatA + `","server":"s_000000000000"}`,
		`{"type":"chat_items","chat":7}`,
	}
	for _, ev := range sent {
		rg.s.Send(json.RawMessage(ev))
	}
	got := rg.barrier(chatPage, other)
	check := func(what string, got []map[string]any, want []string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("%s got %d events, want %d: %v", what, len(got), len(want), got)
		}
		for i, raw := range want {
			var w map[string]any
			if err := json.Unmarshal([]byte(raw), &w); err != nil {
				t.Fatal(err)
			}
			w["server"] = rg.entry
			if !reflect.DeepEqual(got[i], w) {
				t.Errorf("%s, event %d: %v, want %v", what, i, got[i], w)
			}
		}
	}
	check("the page that follows the chat", got[0], sent[:4])
	check("the page that follows nothing", got[1], nil)
	if n := rg.logs.count("cannot be passed on as it is"); n != 1 {
		t.Errorf("%d log lines for the events that were dropped, want one a minute: %v", n, rg.logs.all())
	}
}
