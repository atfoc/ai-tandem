package server

import (
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// The groups of a server for its clients (contract 2.4 "Groups", goal 3.5): a client makes,
// renames, moves, nests, archives and deletes them with the rules of the server's own page, and
// the owner's page follows every one of these. Whether a group shows collapsed is not a
// client's to change.

// groups is the server's groups as the owner's page is given them.
func (s *l5Site) groups() []model.Group {
	s.t.Helper()
	return decode[struct{ Groups []model.Group }](s.t, l5Want(s.t, s.p, 200, "GET", "/api/state", nil)).Groups
}

// order is the ids of the groups, in the server's order.
func (s *l5Site) order() (ids []string) {
	s.t.Helper()
	for _, g := range s.groups() {
		ids = append(ids, g.ID)
	}
	return ids
}

// group is one group of the server.
func (s *l5Site) group(id string) model.Group {
	s.t.Helper()
	for _, g := range s.groups() {
		if g.ID == id {
			return g
		}
	}
	s.t.Fatalf("the server has no group %s", id)
	return model.Group{}
}

// groupsOf is the list of a groups event.
func (s *l5Site) groupsOf(raw string) []model.Group {
	s.t.Helper()
	return decode[struct{ Groups []model.Group }](s.t, raw).Groups
}

func TestLevel5ClientMakesRenamesAndMovesGroups(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)

	// Make: at the top level and nested. The answer is the group; the owner's page is told the
	// whole list, and the defaults with the new group in them.
	out := l5Want(t, s.x, 200, "POST", "/api/groups", `{"name":"  Research  "}`)
	a := decode[model.Group](t, out)
	if got := keysOf(t, out); !slices.Equal(got, []string{"id", "name"}) || !strings.HasPrefix(a.ID, "g_") || a.Name != "Research" {
		t.Fatalf("a group made by a client: %s", out)
	}
	evs := s.told("a group made by a client", "defaults", a.ID)
	if got := l5Types(evs); !slices.Equal(got, []string{"groups", "defaults"}) {
		t.Errorf("a group made by a client told %v", got)
	}
	if got := s.groupsOf(evs[0]); len(got) != 1 || got[0] != a {
		t.Errorf("the groups after the make: %+v", got)
	}
	out = l5Want(t, s.y, 200, "POST", "/api/groups", `{"name":"Papers","parent":"`+a.ID+`"}`)
	nested := decode[model.Group](t, out)
	if got := keysOf(t, out); !slices.Equal(got, []string{"id", "name", "parent"}) || nested.Parent != a.ID || nested.Name != "Papers" {
		t.Fatalf("a nested group made by a client: %s", out)
	}
	evs = s.told("a nested group made by a client", "defaults", nested.ID)
	if got := s.groupsOf(evs[0]); len(got) != 2 || got[0] != a || got[1] != nested {
		t.Errorf("the groups after the nested make: %+v", got)
	}
	// A group with no name has the name a page's group gets.
	if got := decode[model.Group](t, l5Want(t, s.x, 200, "POST", "/api/groups", `{}`)); got.Name != "New group" || got.Parent != "" {
		t.Errorf("a group made with no name: %+v", got)
	}
	b := s.order()[2]
	c := l5ID(t, l5Want(t, s.y, 200, "POST", "/api/groups", `{"name":"C"}`))
	s.told("two more groups", "defaults", c)
	if got := s.order(); !slices.Equal(got, []string{a.ID, nested.ID, b, c}) {
		t.Fatalf("the order of the groups: %v", got)
	}

	// Rename.
	if out := l5Want(t, s.x, 200, "PATCH", "/api/groups/"+nested.ID, `{"name":"  Reading list "}`); out != `{"ok":true}` {
		t.Errorf("the rename of a group by a client: %s", out)
	}
	evs = s.told("the rename of a group by a client", "groups", "Reading list")
	if got := l5Types(evs); !slices.Equal(got, []string{"groups"}) || s.groupsOf(evs[0])[1].Name != "Reading list" {
		t.Errorf("the rename of a group by a client told %v", evs)
	}
	if got := s.group(nested.ID); got.Name != "Reading list" || got.Parent != a.ID {
		t.Errorf("the group after the rename: %+v", got)
	}

	// Move: "before" puts it in the order, "parent" nests it; both in one call.
	move := func(by *bridgetest.Page, id, parent, before string, want ...string) {
		t.Helper()
		if out := l5Want(t, by, 200, "POST", "/api/groups/"+id+"/move", `{"parent":"`+parent+`","before":"`+before+`"}`); out != `{"ok":true}` {
			t.Errorf("the move of a group: %s", out)
		}
		evs := s.told("the move of a group by "+s.who(by), "groups", id)
		var got []string
		for _, g := range s.groupsOf(evs[len(evs)-1]) {
			got = append(got, g.ID)
		}
		if !slices.Equal(got, want) || !slices.Equal(s.order(), want) || len(evs) != 1 {
			t.Errorf("after the move of %s by %s the order is %v in the event and %v on the server, want %v", id, s.who(by), got, s.order(), want)
		}
		if g := s.group(id); g.Parent != parent {
			t.Errorf("after the move the parent of %s is %q, want %q", id, g.Parent, parent)
		}
	}
	move(s.x, c, "", a.ID, c, a.ID, nested.ID, b)        // to the front
	move(s.y, b, a.ID, nested.ID, c, a.ID, b, nested.ID) // into a group, before the group in it
	move(s.x, nested.ID, "", "", c, a.ID, b, nested.ID)  // out to the top level, last
	move(s.y, c, nested.ID, "", a.ID, b, nested.ID, c)   // into what was nested, last
	move(s.x, c, nested.ID, c, a.ID, b, nested.ID, c)    // before itself: where it is
	if g := s.group(b); g.Parent != a.ID {
		t.Errorf("the group nested by a client: %+v", g)
	}

	// The order of all groups at once is not a client's call: it is outside the table.
	want := s.order()
	status, out := l5Call(s.x, "PUT", "/api/groups/order", map[string]any{"ids": []string{c, nested.ID, b, a.ID}})
	l5Is(t, "the order of the groups by a client", status, out, 404, l5Gate)
	if got := s.order(); !slices.Equal(got, want) {
		t.Errorf("the order after a client's call for it: %v, want %v", got, want)
	}
	for i, evs := range s.reach(s.all()...) {
		if len(evs) != 0 {
			t.Errorf("the refused order sent %s %v", s.who(s.all()[i]), evs)
		}
	}
}

// A client archives a group with what is in it as one archive, unarchives it, and deletes
// groups with their contents kept and with their contents deleted.
func TestLevel5ClientArchivesAndDeletesGroups(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	// fill makes a group by the owner with a group nested in it, and a chat, a board and a run
	// in each of the two. It returns the two groups and the three things of each.
	fill := func(name, parent string) (outer, inner string, in, deep []string) {
		t.Helper()
		outer = l5ID(t, l5Want(t, s.p, 200, "POST", "/api/groups", `{"name":"`+name+`","parent":"`+parent+`"}`))
		inner = l5ID(t, l5Want(t, s.p, 200, "POST", "/api/groups", `{"name":"`+name+` inner","parent":"`+outer+`"}`))
		for _, g := range []string{outer, inner} {
			chat := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+g+`"}`))
			board := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/boards", `{"name":"board","group":"`+g+`"}`))
			l5Want(t, s.p, 200, "POST", "/api/boards/"+board+"/release", nil)
			run := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/runs", `{"group":"`+g+`","name":"Run"}`))
			if g == outer {
				in = []string{chat, board, run}
			} else {
				deep = []string{chat, board, run}
			}
		}
		s.told("a filled group", "run", deep[2])
		return outer, inner, in, deep
	}
	// thing is the group, the archive mark and the archive of a chat, a board or a run.
	type thing struct {
		ID, Group, ArchiveOp string
		Archived             bool
	}
	things := func() map[string]thing {
		t.Helper()
		snap := decode[struct{ Boards, Chats, Runs []thing }](t, l5Want(t, s.x, 200, "GET", "/api/state", nil))
		out := map[string]thing{}
		for _, it := range slices.Concat(snap.Boards, snap.Chats, snap.Runs) {
			out[it.ID] = it
		}
		return out
	}

	// Archive, by a client: the group, the group nested in it and everything in both, as one
	// archive. What was archived on its own before keeps its own archive.
	outer, inner, in, deep := fill("Archived", "")
	l5Want(t, s.y, 200, "POST", "/api/chats/"+deep[0]+"/archive", nil)
	own := things()[deep[0]].ArchiveOp
	s.told("a chat archived on its own", "chat", deep[0], `"archived":true`)
	if out := l5Want(t, s.x, 200, "POST", "/api/groups/"+outer+"/archive", nil); out != `{"ok":true}` {
		t.Errorf("the archive of a group by a client: %s", out)
	}
	// The chats and the boards are told before the groups. The runs are told by the run
	// service, from its own queue: before the groups or after, for a page as for a client.
	evs := s.toldEach("the archive of a group by a client", []string{"groups", outer, `"archived":true`},
		[]string{"run", in[2], `"archived":true`}, []string{"run", deep[2], `"archived":true`})
	groupsAt := slices.Index(l5Types(evs), "groups")
	if l5Count(evs[groupsAt:], "chat")+l5Count(evs[groupsAt:], "board") != 0 || l5Count(evs, "groups") != 1 {
		t.Errorf("the archive of a group told %v: the chats and the boards come before the groups", l5Types(evs))
	}
	op := s.group(outer).Op
	if g := s.group(inner); op == "" || !s.group(outer).Archived || !g.Archived || g.Op != op {
		t.Errorf("the groups after the archive: %+v, %+v", s.group(outer), g)
	}
	now := things()
	for _, id := range slices.Concat(in, deep[1:]) {
		if it := now[id]; !it.Archived || it.ArchiveOp != op {
			t.Errorf("%s after the archive of its group: %+v, want the archive %s", id, it, op)
		}
		if l5Count(evs, "chat", id, op)+l5Count(evs, "board", id, op)+l5Count(evs, "run", id, op) == 0 {
			t.Errorf("the archive of %s was not told: %v", id, l5Types(evs))
		}
	}
	if it := now[deep[0]]; !it.Archived || it.ArchiveOp != own || own == op {
		t.Errorf("the chat that was archived before: %+v, want its own archive %s", it, own)
	}
	// An archived group takes nothing new, from a client as from the page.
	status, refusal := l5Call(s.x, "POST", "/api/groups", `{"name":"n","parent":"`+outer+`"}`)
	l5Is(t, "a new group in an archived group by a client", status, refusal, 409, `{"error":"the group is archived: Archived"}`)

	// Unarchive, by the other client: what the archive took comes back, the chat with its own
	// archive stays archived.
	if out := l5Want(t, s.y, 200, "POST", "/api/groups/"+outer+"/unarchive", nil); out != `{"ok":true}` {
		t.Errorf("the unarchive of a group by a client: %s", out)
	}
	evs = s.toldEach("the unarchive of a group by a client", []string{"groups", outer}, []string{"run", in[2]}, []string{"run", deep[2]})
	if g, h := s.group(outer), s.group(inner); g.Archived || h.Archived || g.Op != "" || h.Op != "" {
		t.Errorf("the groups after the unarchive: %+v, %+v", g, h)
	}
	now = things()
	for _, id := range slices.Concat(in, deep[1:]) {
		if it := now[id]; it.Archived || it.ArchiveOp != "" {
			t.Errorf("%s after the unarchive of its group: %+v", id, it)
		}
	}
	if it := now[deep[0]]; !it.Archived || it.ArchiveOp != own {
		t.Errorf("the chat that was archived on its own, after the unarchive of its group: %+v", it)
	}
	if n := l5Count(evs, "chat", deep[0]); n != 0 {
		t.Errorf("the unarchive of the group told the chat with its own archive %d times", n)
	}

	// Delete with the contents kept: the group goes, what was in it goes up to its parent, and
	// the group nested in it too. Here the parent of the inner group is the outer one.
	if out := l5Want(t, s.x, 200, "DELETE", "/api/groups/"+inner+"?contents=keep", nil); out != `{"ok":true}` {
		t.Errorf("the delete of a group by a client: %s", out)
	}
	evs = s.toldEach("the delete of a group with its contents kept", []string{"defaults"}, []string{"run", deep[2], `"group":"` + outer + `"`})
	now = things()
	for _, id := range deep {
		if it, found := now[id]; !found || it.Group != outer {
			t.Errorf("%s after the delete of its group: %+v (found %v), want it in %s", id, it, found, outer)
		}
	}
	if got := s.order(); !slices.Equal(got, []string{outer}) {
		t.Errorf("the groups after the delete: %v", got)
	}
	if l5Count(evs, "chat_removed")+l5Count(evs, "board_removed")+l5Count(evs, "run_removed") != 0 {
		t.Errorf("a delete with the contents kept told a removal: %v", l5Types(evs))
	}
	if got := l5Types(only(evs, "groups", "defaults", "chat", "board")); len(got) < 4 || !slices.Equal(got[len(got)-2:], []string{"groups", "defaults"}) {
		t.Errorf("the delete of a group told %v: the groups and the defaults come after the chat and the board", l5Types(evs))
	}
	// A top-level group: everything goes to no group.
	l5Want(t, s.y, 200, "DELETE", "/api/groups/"+outer+"?contents=keep", nil)
	s.toldEach("the delete of a top-level group with its contents kept", []string{"defaults"},
		[]string{"run", in[2], `"group":"` + model.Ungrouped + `"`}, []string{"run", deep[2], `"group":"` + model.Ungrouped + `"`})
	now = things()
	for _, id := range slices.Concat(in, deep) {
		if it, found := now[id]; !found || it.Group != model.Ungrouped {
			t.Errorf("%s after the delete of the top-level group: %+v (found %v), want it in no group", id, it, found)
		}
	}
	if got := s.order(); len(got) != 0 {
		t.Errorf("the groups after both deletes: %v", got)
	}

	// Delete with the contents: the group, the group nested in it and everything in both. Each
	// removed thing is told, and then the groups, as for a page.
	outer, inner, in, deep = fill("Deleted", "")
	keep := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/groups", `{"name":"Stays"}`))
	stays := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+keep+`"}`))
	s.told("a group that stays", "chat", stays)
	if out := l5Want(t, s.x, 200, "DELETE", "/api/groups/"+outer+"?contents=delete", nil); out != `{"ok":true}` {
		t.Errorf("the delete of a group with its contents by a client: %s", out)
	}
	evs = s.toldEach("the delete of a group with its contents", []string{"defaults"}, []string{"run_removed", in[2]}, []string{"run_removed", deep[2]})
	// The removals of the chats and the boards come before the groups, and the defaults after;
	// the removals of the runs are the run service's, before the groups or after.
	told := only(evs, "groups", "defaults", "chat_removed", "board_removed")
	types := l5Types(told)
	at := slices.Index(types, "groups")
	if at != 4 || !slices.Equal(types[at:], []string{"groups", "defaults"}) {
		t.Fatalf("the delete of a group with its contents told %v: the groups and the defaults come after the removals", l5Types(evs))
	}
	for i, id := range slices.Concat(in, deep) {
		typ := []string{"chat_removed", "board_removed", "run_removed"}[i%3]
		if n := l5Count(evs, typ, `"id":"`+id+`"`); n != 1 {
			t.Errorf("the removal of %s was told %d times: %v", id, n, l5Types(evs))
		}
	}
	evs = told
	if got := s.groupsOf(evs[at]); len(got) != 1 || got[0].ID != keep {
		t.Errorf("the groups after the delete with the contents: %+v", got)
	}
	if strings.Contains(evs[at+1], outer) || strings.Contains(evs[at+1], inner) || !strings.Contains(evs[at+1], keep) {
		t.Errorf("the defaults after the delete with the contents: %s", evs[at+1])
	}
	now = things()
	if _, found := now[stays]; len(now) != 7 || !found { // the six that were kept above, and the chat that stays
		t.Errorf("after the delete with the contents the server has %d things, want 7 with the chat %s", len(now), stays)
	}
	for _, id := range slices.Concat(in, deep) {
		status, _ := l5Call(s.y, "GET", "/api/chats/"+id, nil)
		if _, found := now[id]; found || status != 404 {
			t.Errorf("%s is still there after the delete of its group", id)
		}
	}
}

// The rules of a group are the local group's: a call that breaks one is answered on the remote
// port exactly as on the server's own port, status and body. Each call here is refused and
// changes nothing, so both listeners are asked the same thing of the same state.
func TestLevel5GroupRulesAreThePagesRules(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	mk := func(name, parent string) string {
		return l5ID(t, l5Want(t, s.p, 200, "POST", "/api/groups", `{"name":"`+name+`","parent":"`+parent+`"}`))
	}
	a := mk("A", "")
	nested := mk("Nested", a)
	deep := mk("Deep", nested)
	shut := mk("Shut", "")
	l5Want(t, s.p, 200, "POST", "/api/groups/"+shut+"/archive", nil)
	chat := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+a+`"}`))
	board := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/boards", `{"name":"board","group":"`+a+`"}`))
	l5Want(t, s.p, 200, "POST", "/api/boards/"+board+"/release", nil)
	run := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/runs", `{"group":"`+a+`","name":"Run"}`))
	s.told("the set-up", "run", run)
	before := l5Want(t, s.p, 200, "GET", "/api/state", nil)

	const (
		inside   = `{"error":"a group can't go inside itself"}`
		archived = `{"error":"the group is archived: Shut"}`
		empty    = `{"error":"group name is empty"}`
		contents = `{"error":"contents must be delete or keep"}`
	)
	noGroup := func(id string) string { return `{"code":"not_found","error":"no such group \"` + id + `\""}` }
	for _, c := range []struct {
		what, method, path, body string
		status                   int
		answer                   string
	}{
		{"a group inside itself", "POST", "/api/groups/" + a + "/move", `{"parent":"` + a + `"}`, 400, inside},
		{"a group inside a group nested in it", "POST", "/api/groups/" + a + "/move", `{"parent":"` + nested + `"}`, 400, inside},
		{"a group inside a group nested two deep in it", "POST", "/api/groups/" + a + "/move", `{"parent":"` + deep + `","before":"` + deep + `"}`, 400, inside},
		{"a group into an archived group", "POST", "/api/groups/" + a + "/move", `{"parent":"` + shut + `"}`, 409, archived},
		{"a group into a group that is not there", "POST", "/api/groups/" + a + "/move", `{"parent":"g_nothere"}`, 404, noGroup("g_nothere")},
		{"a group before a group that is not there", "POST", "/api/groups/" + a + "/move", `{"parent":"","before":"g_nothere"}`, 404, noGroup("g_nothere")},
		{"the move of a group that is not there", "POST", "/api/groups/g_nothere/move", `{"parent":""}`, 404, noGroup("g_nothere")},
		{"a move with no body", "POST", "/api/groups/" + a + "/move", ``, 400, `{"error":"EOF"}`},
		{"a new group in an archived group", "POST", "/api/groups", `{"name":"n","parent":"` + shut + `"}`, 409, archived},
		{"a new group in a group that is not there", "POST", "/api/groups", `{"name":"n","parent":"g_nothere"}`, 404, noGroup("g_nothere")},
		{"a rename to nothing", "PATCH", "/api/groups/" + a, `{"name":"   "}`, 400, empty},
		{"the rename of a group that is not there", "PATCH", "/api/groups/g_nothere", `{"name":"n"}`, 404, noGroup("g_nothere")},
		{"the archive of a group that is not there", "POST", "/api/groups/g_nothere/archive", ``, 404, noGroup("g_nothere")},
		{"the unarchive of a group that is not there", "POST", "/api/groups/g_nothere/unarchive", ``, 404, noGroup("g_nothere")},
		{"a delete that does not say what happens to the contents", "DELETE", "/api/groups/" + a, ``, 400, contents},
		{"a delete with another word for the contents", "DELETE", "/api/groups/" + a + "?contents=all", ``, 400, contents},
		{"the delete of a group that is not there", "DELETE", "/api/groups/g_nothere?contents=delete", ``, 404, noGroup("g_nothere")},
		{"the delete of a group that is not there, contents kept", "DELETE", "/api/groups/g_nothere?contents=keep", ``, 404, noGroup("g_nothere")},
		// What names a group in its body: a chat and a board keep the page's answer for a group
		// that is not there, a run has the code.
		{"a chat into a group that is not there", "PATCH", "/api/chats/" + chat, `{"group":"g_nothere"}`, 400, `{"error":"no such group \"g_nothere\""}`},
		{"a new chat in a group that is not there", "POST", "/api/chats", `{"agent":"claude","group":"g_nothere"}`, 400, `{"error":"no such group \"g_nothere\""}`},
		{"a board into a group that is not there", "PATCH", "/api/boards/" + board, `{"group":"g_nothere"}`, 400, `{"error":"no such group \"g_nothere\""}`},
		{"a new board in a group that is not there", "POST", "/api/boards", `{"name":"b","group":"g_nothere"}`, 400, `{"error":"no such group \"g_nothere\""}`},
		{"a run into a group that is not there", "PATCH", "/api/runs/" + run, `{"group":"g_nothere"}`, 404, ""},
		{"a new run in a group that is not there", "POST", "/api/runs", `{"group":"g_nothere","name":"r"}`, 404, ""},
		{"a new run in an archived group", "POST", "/api/runs", `{"group":"` + shut + `","name":"r"}`, 409, ""},
	} {
		var body any
		if c.body != "" {
			body = c.body
		}
		status, out := l5Call(s.x, c.method, c.path, body)
		own, ownOut := l5Call(s.p, c.method, c.path, body)
		if status != own || out != ownOut {
			t.Errorf("%s: the remote port answers %d %s, the server's own port %d %s", c.what, status, out, own, ownOut)
		}
		if status != c.status || (c.answer != "" && out != c.answer) {
			t.Errorf("%s: %d %s, want %d %s", c.what, status, out, c.status, c.answer)
		}
		if status == 404 && decode[map[string]string](t, out)["code"] != "not_found" {
			t.Errorf("%s: a 404 without the code not_found: %s", c.what, out)
		}
	}
	if after := l5Want(t, s.p, 200, "GET", "/api/state", nil); after != before {
		t.Errorf("the refused calls changed the server:\nbefore %s\nafter  %s", before, after)
	}
	for i, evs := range s.reach(s.all()...) {
		if len(evs) != 0 {
			t.Errorf("the refused calls sent %s %v", s.who(s.all()[i]), evs)
		}
	}
}

// Whether a group shows collapsed is the server's own matter: a client's change of a group
// that names "collapsed" is refused whole, and what the owner's page sets is what a client is
// shown.
func TestLevel5CollapsedIsNotAClients(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	g := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/groups", `{"name":"G"}`))
	s.told("the set-up", "defaults", g)
	const refusal = `{"code":"collapsed_refused","error":"an API client cannot collapse a group"}`
	for _, body := range []string{`{"collapsed":true}`, `{"collapsed":false}`, `{"collapsed":null}`, `{"name":"Renamed","collapsed":true}`,
		`{"collapsed":true,"name":"Renamed"}`, `{"Collapsed":true}`, `{"COLLAPSED":false,"name":"Renamed"}`, `{"collapsed":"yes"}`, `{"collapsed":{}}`} {
		for _, c := range []*bridgetest.Page{s.x, s.y} {
			status, out := l5Call(c, "PATCH", "/api/groups/"+g, body)
			l5Is(t, "PATCH of a group with "+body+" by "+s.who(c), status, out, 400, refusal)
		}
		// A group that is not there: the refusal comes first, as it reads no group.
		status, out := l5Call(s.x, "PATCH", "/api/groups/g_nothere", body)
		l5Is(t, "PATCH of a missing group with "+body, status, out, 400, refusal)
	}
	if got := s.group(g); got.Name != "G" || got.Collapsed {
		t.Errorf("the group after the refused changes: %+v", got)
	}
	for i, evs := range s.reach(s.all()...) {
		if len(evs) != 0 {
			t.Errorf("the refused changes sent %s %v", s.who(s.all()[i]), evs)
		}
	}

	// The owner's page collapses the group: every client is shown it as the server has it.
	l5Want(t, s.p, 200, "PATCH", "/api/groups/"+g, `{"collapsed":true}`)
	evs := s.told("the owner's collapse", "groups", g)
	if got := s.groupsOf(evs[0]); len(evs) != 1 || len(got) != 1 || !got[0].Collapsed || !strings.Contains(evs[0], `"collapsed":true`) {
		t.Errorf("the owner's collapse told %v", evs)
	}
	for _, c := range []*bridgetest.Page{s.x, s.y} {
		if groups := l5Field(t, l5Want(t, c, 200, "GET", "/api/state", nil), "groups"); !strings.Contains(groups, `"collapsed":true`) {
			t.Errorf("the groups %s is given: %s", s.who(c), groups)
		}
	}
	// A client's rename leaves it collapsed, and still cannot open it.
	l5Want(t, s.x, 200, "PATCH", "/api/groups/"+g, `{"name":"Renamed by a client"}`)
	evs = s.told("a client's rename of a collapsed group", "groups", "Renamed by a client")
	if got := s.groupsOf(evs[0]); !got[0].Collapsed || got[0].Name != "Renamed by a client" {
		t.Errorf("the group after a client's rename: %+v", got[0])
	}
	status, out := l5Call(s.x, "PATCH", "/api/groups/"+g, `{"collapsed":false}`)
	l5Is(t, "a client that opens a collapsed group", status, out, 400, refusal)
	if !s.group(g).Collapsed {
		t.Error("a client opened a group the owner collapsed")
	}
	// The owner's page opens it again.
	l5Want(t, s.p, 200, "PATCH", "/api/groups/"+g, `{"collapsed":false}`)
	evs = s.told("the owner's expand", "groups", g)
	if strings.Contains(evs[0], "collapsed") || s.group(g).Collapsed {
		t.Errorf("the owner's expand told %v", evs)
	}
}
