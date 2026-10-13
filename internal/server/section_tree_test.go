package server

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// What a page is handed of a section, through the real handler: its tree in the snapshot, the
// tree whole when its server connects, the events of its things with the entry's id, and no
// tree when the server drops or its entry is removed.

// seen is an event as a page reads it: its type, the entry its "server" names (none for an
// event of this server, and for server_state, whose "server" is the entry itself), and the rest.
type seen struct {
	Type   string
	Server string `json:"-"`
	Tree   json.RawMessage
	ID     string
	Board  json.RawMessage
	Chat   json.RawMessage
	State  json.RawMessage
	Groups []model.Group
	raw    string
}

func seenOf(t *testing.T, raws []string) (out []seen) {
	t.Helper()
	for _, raw := range raws {
		ev := decode[seen](t, raw)
		ev.raw = raw
		var named struct{ Server json.RawMessage }
		json.Unmarshal([]byte(raw), &named)
		json.Unmarshal(named.Server, &ev.Server) // a string, or nothing
		out = append(out, ev)
	}
	return out
}

// idOf is the id of the thing a list event carries.
func (s seen) idOf() string {
	var c struct{ ID string }
	if json.Unmarshal(s.Chat, &c) == nil && c.ID != "" {
		return c.ID
	}
	var b struct{ ID string }
	if json.Unmarshal(s.Board, &b) == nil && b.ID != "" {
		return b.ID // a list event's board; a role event's is a plain id
	}
	var st struct{ Chat string }
	if json.Unmarshal(s.State, &st) == nil && st.Chat != "" {
		return st.Chat
	}
	return s.ID
}

// The snapshot, as GET /api/state and as a stream's second event: "sections" has the tree of
// the connected entry, as its server has it but for "collapsed", and this server's own lists
// hold nothing of it. Without a relay, and for an entry whose tree is not held, there is no key.
func TestSnapshotHasSections(t *testing.T) {
	t.Parallel()
	there := groupThere(farGroup, "There")
	there.Collapsed = true
	inner := model.Group{ID: "g_inner", Name: "Inner", Parent: farGroup, Archive: model.Archive{Archived: true, Op: "a_there"}}
	archived := viewThere(farChatB)
	archived.Archived = true
	f := newFar(t, farOpt{groups: []model.Group{there, inner}, chats: []model.ChatView{viewThere(farChatA), archived},
		boards: []model.Board{boardThere(farBoardA)}})
	p := f.page("P")
	// This server has things of its own, one of them in a group with the id of that server's.
	own := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", `{"group":"`+model.Ungrouped+`","server":"local"}`))
	group := f.group(p, "Mine", "")
	bd := decode[model.Board](t, mustOK(t, f, p, "POST", "/api/boards", form("name", "Own", "group", group)))

	check := func(what, raw string) {
		t.Helper()
		var keys map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &keys); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		var sections map[string]map[string]json.RawMessage
		if err := json.Unmarshal(keys["sections"], &sections); err != nil || len(sections) != 1 || sections[f.entry] == nil {
			t.Fatalf("%s: sections %s", what, keys["sections"])
		}
		sec := sections[f.entry]
		var parts []string
		for k := range sec {
			parts = append(parts, k)
		}
		if len(parts) != 5 || sec["groups"] == nil || sec["boards"] == nil || sec["chats"] == nil || sec["states"] == nil || sec["defaults"] == nil {
			t.Fatalf("%s: the tree has the parts %v", what, parts)
		}
		if strings.Contains(string(sec["groups"]), "collapsed") {
			t.Errorf("%s: a group of the section says whether it is collapsed: %s", what, sec["groups"])
		}
		snap := decode[pageSnapshot](t, raw)
		tree := snap.Sections[f.entry]
		want := []model.Group{{ID: farGroup, Name: "There"}, inner}
		if !reflect.DeepEqual(tree.Groups, want) {
			t.Errorf("%s: the section's groups %+v, want %+v", what, tree.Groups, want)
		}
		if len(tree.Chats) != 2 || tree.Chats[0].ID != farChatA || tree.Chats[1].ID != farChatB || !tree.Chats[1].Archived || tree.Chats[0].Group != farGroup ||
			len(tree.States) != 2 || len(tree.Boards) != 1 || tree.Boards[0].ID != farBoardA {
			t.Errorf("%s: the section's tree %+v", what, tree)
		}
		// This server's own lists are its own things, and nothing else.
		if len(snap.Chats) != 1 || snap.Chats[0].ID != own.ID || len(snap.States) != 1 || snap.States[0].Chat != own.ID ||
			len(snap.Boards) != 1 || snap.Boards[0].ID != bd.ID || len(snap.Groups) != 1 || snap.Groups[0].ID != group {
			t.Errorf("%s: this server's own lists: chats %+v, boards %+v, groups %+v", what, snap.Chats, snap.Boards, snap.Groups)
		}
		for _, list := range []string{"groups", "boards", "chats", "states", "defaults"} {
			for _, word := range []string{`"server"`, `"gone"`, `"unmoved"`, `"moveError"`, `"was"`, f.entry, farChatA, farBoardA, farGroup} {
				if strings.Contains(string(keys[list]), word) {
					t.Errorf("%s: this server's %s have %s: %s", what, list, word, keys[list])
				}
			}
		}
		if _, ok := snap.Lists[f.entry]; !ok || len(snap.Lists) != 1 {
			t.Errorf("%s: the lists %v", what, snap.Lists)
		}
	}
	check("GET /api/state", mustOK(t, f, p, "GET", "/api/state", ""))
	raw, _ := json.Marshal(bridgetest.Connect(t, f.url, "Q").Welcome())
	check("the stream's snapshot", string(raw))

	// The entry's tree is not held: no key, whatever the entry's state, and its lists stay.
	f.down()
	keys := decode[map[string]json.RawMessage](t, mustOK(t, f, p, "GET", "/api/state", ""))
	if string(keys["sections"]) != "{}" || !strings.Contains(string(keys["lists"]), f.entry) || !strings.Contains(string(keys["servers"]), f.entry) {
		t.Fatalf("the snapshot while the entry is not connected: sections %s, lists %s", keys["sections"], keys["lists"])
	}
	// Without a relay the sections are there and empty.
	keys = decode[map[string]json.RawMessage](t, newEnv(t).expect(200, "GET", "/api/state", ""))
	if string(keys["sections"]) != "{}" || string(keys["lists"]) != "{}" {
		t.Fatalf("without a relay: sections %s, lists %s", keys["sections"], keys["lists"])
	}
}

// The events of a section: a change of the tree, by whoever made it there, reaches every page
// with the entry's id as "server" and is in the tree a page is handed next; the content of a
// chat reaches the pages that follow it; and an event of a thing of this server has no
// "server".
func TestSectionEventsHaveTheServer(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}, boards: []model.Board{boardThere(farBoardA)}})
	p, q := f.page("P"), f.page("Q")
	// P follows the chat; Q follows nothing.
	f.good(p, "GET", f.on("/chats/"+farChatA+"/items"), "")
	f.events(p, q)

	renamed := viewThere(farChatA)
	renamed.Name = "Renamed there"
	made := viewThere(farChatB)
	made.Locked, made.Name = false, ""
	state := model.StateOf(farChatA, "main", renamed)
	state.DraftRev = 4
	bd := boardThere(farBoardB)
	groups := []model.Group{{ID: farGroup, Name: "There", Collapsed: true}, {ID: "g_new", Name: "New"}}
	sent := []map[string]any{
		{"type": "groups", "groups": groups},
		{"type": "defaults", "defaults": model.Defaults{Groups: map[string]model.GroupDefaults{"g_new": {}}}},
		{"type": "chat", "chat": renamed},
		{"type": "branch_state", "state": state},
		{"type": "chat", "chat": made},
		{"type": "board", "board": bd},
		{"type": "chat_items", "chat": farChatA, "branch": "main", "version": 4, "items": []any{map[string]any{"kind": "assistant", "text": "more"}}},
		{"type": "tree", "chat": farChatA, "version": 5},
		{"type": "sub", "chat": farChatA, "branch": "main", "subagent": map[string]any{"id": "s1"}},
		{"type": "sub_items", "chat": farChatA, "branch": "main", "sub": "s1", "version": 2, "items": []any{}},
		{"type": "chat_removed", "id": farChatB},
		{"type": "board_removed", "id": farBoardB},
		// What no page is to get of that server: its own server list, and a type of a later build.
		{"type": "servers", "servers": []any{}},
		{"type": "server_state", "id": "s_000000000000", "state": "connected"},
		{"type": "section", "server": "s_000000000000", "tree": nil},
		{"type": "later", "chat": farChatA},
	}
	for _, ev := range sent {
		f.st.Send(ev)
	}
	got := f.events(p, q)
	types := func(evs []seen) (out []string) {
		for _, ev := range evs {
			if ev.Server != f.entry {
				t.Errorf("an event of the section names the server %q: %s", ev.Server, ev.raw)
			}
			out = append(out, ev.Type+" "+ev.idOf())
		}
		return out
	}
	list := []string{"groups ", "defaults ", "chat " + farChatA, "branch_state " + farChatA, "chat " + farChatB, "board " + farBoardB,
		"chat_removed " + farChatB, "board_removed " + farBoardB}
	follower := []string{"groups ", "defaults ", "chat " + farChatA, "branch_state " + farChatA, "chat " + farChatB, "board " + farBoardB,
		"chat_items ", "tree ", "sub ", "sub_items ",
		"chat_removed " + farChatB, "board_removed " + farBoardB}
	// ofSection are the events but this server's own word on the entry's connection, which
	// comes whenever it comes.
	ofSection := func(raws []string) (out []seen) {
		for _, ev := range seenOf(t, raws) {
			if ev.Type != "server_state" || !strings.Contains(ev.raw, `"id":"`+f.entry+`"`) {
				out = append(out, ev)
			}
		}
		return out
	}
	pGot, qGot := ofSection(got[0]), ofSection(got[1])
	if !reflect.DeepEqual(types(pGot), follower) {
		t.Errorf("the page that follows got\n%q\nwant\n%q", types(pGot), follower)
	}
	if !reflect.DeepEqual(types(qGot), list) {
		t.Errorf("the page that follows nothing got\n%q\nwant\n%q", types(qGot), list)
	}
	// The groups come without "collapsed", and a content event as it came but for the server.
	if g := pGot[0].Groups; len(g) != 2 || g[0].Collapsed || strings.Contains(pGot[0].raw, "collapsed") {
		t.Errorf("the groups event: %s", pGot[0].raw)
	}
	sameJSON(t, "a content event", decode[any](t, pGot[6].raw),
		`{"server":"`+f.entry+`","type":"chat_items","chat":"`+farChatA+`","branch":"main","version":4,"items":[{"kind":"assistant","text":"more"}]}`)
	// The tree a page is handed has what the events said.
	tree := f.section(p)
	if len(tree.Groups) != 2 || tree.Groups[1].ID != "g_new" || len(tree.Chats) != 1 || tree.Chats[0].Name != "Renamed there" ||
		len(tree.States) != 1 || tree.States[0].DraftRev != 4 || len(tree.Boards) != 1 {
		t.Errorf("the tree after the events: %+v", tree)
	}

	// An event of a thing of this server names no server, the same kinds among them.
	own := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", `{"id":"`+farChatA+`","group":"`+model.Ungrouped+`"}`))
	g := f.group(p, "Mine", "")
	mustOK(t, f, p, "POST", "/api/boards", form("name", "Own", "group", g))
	if own.ID != farChatA {
		t.Fatalf("the chat of this server: %+v", own)
	}
	// Each kind is read as it comes.
	missing := map[string]bool{"chat": true, "branch_state": true, "groups": true, "board": true}
	f.throughIf(q, func(raw string) bool {
		ev := seenOf(t, []string{raw})[0]
		if ev.Server != "" || strings.Contains(raw, `"server"`) {
			t.Errorf("an event of this server names a server: %s", raw)
		}
		delete(missing, ev.Type)
		return len(missing) == 0
	})
}

// The section event: with the tree when the entry's server connects, the first time and again,
// whole and as it is then; with null when the connection ends and when the entry is removed.
// Removing the entry tells its server nothing, and its calls are those of no entry from then on.
func TestSectionEventAtConnectDropAndRemoval(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}, boards: []model.Board{boardThere(farBoardA)}})
	p, q := f.page("P"), f.page("Q")
	f.good(p, "GET", f.on("/chats/"+farChatA+"/items"), "")
	section := func(page *bridgetest.Page) seen {
		t.Helper()
		evs := seenOf(t, f.through(page, "section"))
		for _, ev := range evs[:len(evs)-1] {
			if ev.Server == f.entry && ev.Type != "server_lists" && ev.Type != "library" {
				t.Errorf("before the section event the page %s got %s", page.ID, ev.raw)
			}
		}
		last := evs[len(evs)-1]
		if last.Server != f.entry {
			t.Fatalf("the section event of the page %s: %s", page.ID, last.raw)
		}
		return last
	}

	// The stream ends: every page is told that the section has no tree.
	f.st.DropStreams()
	for _, page := range []*bridgetest.Page{p, q} {
		if ev := section(page); string(ev.Tree) != "null" {
			t.Fatalf("the section event at the end of the stream: %s", ev.raw)
		}
	}
	// The entry connects again, by itself, to a server whose tree is another now.
	f.change(func(tr *thereTree) {
		tr.chats = []model.ChatView{viewThere(farChatB)}
	})
	for _, page := range []*bridgetest.Page{p, q} {
		ev := section(page)
		var tree struct {
			Chats  []model.ChatView
			Boards []model.Board
			Groups []model.Group
		}
		if err := json.Unmarshal(ev.Tree, &tree); err != nil || len(tree.Chats) != 1 || tree.Chats[0].ID != farChatB ||
			len(tree.Boards) != 1 || len(tree.Groups) != 1 {
			t.Fatalf("the section event at the return: %s", ev.raw)
		}
		for _, part := range []string{`"groups"`, `"boards"`, `"chats"`, `"states"`, `"defaults"`} {
			if !strings.Contains(string(ev.Tree), part) {
				t.Errorf("the tree of the section event lacks %s: %s", part, ev.Tree)
			}
		}
	}
	f.returned(2)
	// From the event on the entry's calls work, and the tree is the one of the event.
	f.good(p, "GET", f.on("/chats/"+farChatB), "")
	if sec := f.section(q); sec == nil || len(sec.Chats) != 1 || sec.Chats[0].ID != farChatB {
		t.Fatalf("the section after the return: %+v", sec)
	}

	// The entry is removed: the pages get the list without it, no lists and no tree of it, and
	// its server is sent nothing.
	sent := len(f.st.Requests())
	f.untouched("the removal of the entry", func() {
		f.good(p, "DELETE", "/api/servers/"+f.entry, "")
		// Each page is told the three, in whatever order: the list without the entry, no lists
		// of it, and no tree of it.
		for _, page := range []*bridgetest.Page{p, q} {
			missing := map[string]bool{"servers": true, "server_lists": true, "section": true}
			f.throughIf(page, func(raw string) bool {
				ev := seenOf(t, []string{raw})[0]
				switch {
				case ev.Type == "servers" && !strings.Contains(raw, f.entry),
					ev.Type == "server_lists" && ev.Server == f.entry && strings.Contains(raw, `"lists":null`),
					ev.Type == "section" && ev.Server == f.entry && string(ev.Tree) == "null":
					delete(missing, ev.Type)
				}
				return len(missing) == 0
			})
		}
		// The lists of the entry go too: before the section event or after it.
		f.wait("the snapshot has nothing of the entry", func() bool {
			snap := f.snapshotOf(q)
			return len(snap.Sections) == 0 && len(snap.Lists) == 0
		})
		for _, c := range stateCalls() {
			c.refused(f, p, f.entry, "the entry is removed", http.StatusNotFound, "no_server", "This server is not in the list.")
		}
	})
	time.Sleep(50 * time.Millisecond) // a call that the removal started would be on its way by now
	for _, r := range f.st.Requests()[sent:] {
		t.Errorf("the server of the removed entry was sent %s %s", r.Method, r.Path)
	}
	if v, ok := f.m.View(f.entry); ok || v.State == servers.StateConnected {
		t.Errorf("the entry after its removal: %+v", v)
	}
}
