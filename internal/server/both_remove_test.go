package server

import (
	"encoding/json"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// Removing the entry (goal 3.12, last bullet; contract 3.8), with both halves real: client 1
// removes the remote server from its list while client 2 and the owner work on. Its pages get
// the list without the entry, no lists of it, no library of it and no tree of it; that server
// is told nothing and everything stays there; and nothing counts what is on it.
func TestBothRemovingTheEntry(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{withB: []func(*Server){withLibrary(t, t.TempDir())}})
	c1 := bo.c[0]
	us := bo.three()
	owner, one, two := us[0], us[1], us[2]
	other := c1.page("Q") // a second page of client 1
	entry := c1.entry

	// What client 1 made on that server and has open: a chat it follows, a board it holds.
	group := l5ID(t, one.want(t, 200, "POST", "/groups", obj{"name": "Work", "parent": ""}))
	chat := l5ID(t, one.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": group}))
	bo.told("the new chat", us, []string{"chat", chat})
	one.want(t, 200, "GET", "/chats/"+chat+"/items", nil)
	board := l5ID(t, one.want(t, 200, "POST", "/boards", obj{"name": "plan", "group": group}))
	c1.holders(board, one.p.ID, bothID1)
	c1.written(one.p, board, 0, drawing("client 1's"))
	bo.same("the set-up", us...)
	before := bo.level("before the removal", us...)
	// Nothing counts what is on that server: the route is gone.
	if status, out := one.p.Do("GET", "/api/servers/"+entry+"/items", nil); status != 404 {
		t.Errorf("GET /api/servers/{id}/items: %d %s", status, out)
	}

	asked := len(bo.fr.requests())
	if status, out := one.p.Do("DELETE", "/api/servers/"+entry, nil); status != 200 {
		t.Fatalf("the removal of the entry: %d %s", status, out)
	}
	// Each page of client 1 is told the four, in whatever order.
	for _, u := range []*user{one, other} {
		missing := map[string]bool{"servers": true, "server_lists": true, "library_removed": true, "section": true}
		for len(missing) > 0 {
			raw := u.p.NextRaw()
			ev := decode[struct {
				Type, Server string
				Lists, Tree  json.RawMessage
				Servers      []servers.View
			}](t, raw)
			switch {
			case ev.Type == "servers" && len(ev.Servers) == 1 && ev.Servers[0].Local,
				ev.Type == "server_lists" && ev.Server == entry && string(ev.Lists) == "null",
				ev.Type == "library_removed" && ev.Server == entry,
				ev.Type == "section" && ev.Server == entry && string(ev.Tree) == "null":
				delete(missing, ev.Type)
			}
		}
	}
	// Client 1 knows nothing of that server any more: no section, no lists, no entry, and its
	// calls are those of no entry.
	c1.wait("the state of client 1 has nothing of the entry", func() bool {
		snap := decode[pageSnapshot](t, string(do(t, one.p, "GET", "/api/state", nil)))
		return len(snap.Sections) == 0 && len(snap.Lists) == 0
	})
	state := string(do(t, one.p, "GET", "/api/state", nil))
	for _, part := range []string{entry, group, chat, board, c1.name} {
		if strings.Contains(state, part) {
			t.Errorf("the state of client 1 after the removal holds %s: %s", part, state)
		}
	}
	if list := listFile(t, c1.root); strings.Contains(list, entry) || strings.Contains(list, testSecret) {
		t.Errorf("the list of client 1 after the removal: %s", list)
	}
	for _, c := range [][2]string{
		{"GET", "/chats/" + chat}, {"GET", "/chats/" + chat + "/items"}, {"POST", "/chats"}, {"DELETE", "/chats/" + chat},
		{"POST", "/boards/" + board + "/take"}, {"PUT", "/boards/" + board + "/scene?rev=1"}, {"DELETE", "/groups/" + group + "?contents=delete"},
	} {
		if text := one.refused(t, 404, "no_server", c[0], c[1], obj{"group": group}); text != "This server is not in the list." {
			t.Errorf("%s %s after the removal: %q", c[0], c[1], text)
		}
	}
	if status, out := one.p.Do("GET", "/api/servers/"+entry+"/items", nil); status != 404 {
		t.Errorf("GET /api/servers/{id}/items after the removal: %d %s", status, out)
	}

	// That server is told nothing: client 1's stream ends, and it is sent no request, not a
	// delete and not a release. Everything stays there, the same tree for the owner and for
	// client 2, and the board is free.
	c1.wait("the remote server has no stream of client 1", func() bool { return !bo.b.s.Bridge.Known(bothID1) })
	for _, r := range bo.fr.requests()[asked:] {
		if r.Client == bothID1 {
			t.Errorf("the remote server was sent %s %s by client 1 at the removal of its entry", r.Method, r.Path)
		}
	}
	rest := []*user{owner, two}
	if evs := bo.same("the removal", rest...); len(evs) != 0 {
		t.Errorf("the removal of client 1's entry told the others %v", evs)
	}
	after := bo.level("after the removal", rest...)
	for _, f := range []string{"groups", "boards", "chats", "states", "defaults"} {
		if !l5SameList(t, after, before, f) {
			t.Errorf("the %s of the remote server after the removal:\n%s\nbefore:\n%s", f, l5Field(t, after, f), l5Field(t, before, f))
		}
	}
	bo.b.stored(board, drawing("client 1's"), 1)
	c2 := bo.c[1]
	c2.holders(board, "", "")

	// Client 2 and the owner work on, with what client 1 made.
	bo.step(rest, two, "the rename of client 1's chat", "PATCH", "/chats/"+chat, obj{"name": "Renamed by client 2"}, "chat", chat, false, `"name":"Renamed by client 2"`)
	bo.step(rest, owner, "the move of client 1's chat", "PATCH", "/chats/"+chat, obj{"group": model.Ungrouped}, "chat", chat, false, `"group":"`+model.Ungrouped+`"`)
	if state, rev := c2.take(two.p, board, true); state != "held" || rev != 1 {
		t.Fatalf("client 2's take of the board client 1 held: %s at %d", state, rev)
	}
	c2.written(two.p, board, 1, drawing("client 2's"))
	bo.step(rest, owner, "a new chat", "POST", "/chats", obj{"agent": "claude", "group": group}, "chat", "", false, `"group":"`+group+`"`)
	// And client 1's pages get nothing of it.
	for _, raw := range one.p.Drain(0) {
		if strings.Contains(raw, `"server":"`+entry+`"`) && typeOf(raw) != "section" && typeOf(raw) != "server_lists" && typeOf(raw) != "library_removed" && typeOf(raw) != "server_state" {
			t.Errorf("after the removal a page of client 1 was sent %s", raw)
		}
	}
}
