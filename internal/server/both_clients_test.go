package server

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/testset"
)

// Two clients and the owner on one server, with both halves real (goal 3.3, 3.4, 3.5, 3.6 and
// 3.11; contract 2.6, 2.7 and 3.3): what one of the three makes or changes, the other two see
// without a reload, by events on the streams they had open, and in a fresh GET /api/state.

// bothKind is one kind of thing of a tree, as a page makes and changes it: each call is a
// method, the path after /api and a body.
type bothKind struct {
	name string
	told string // the type of the event that tells a change of one
	gone string // the type of the event that tells its removal; "" = the event of a change
	// make is the call that makes one with this name in this group.
	make func(name, group string) (rest string, body obj)
	path func(id string) string
	// rename and move are the calls that name it and put it into another group.
	rename func(id, name string) (method, rest string, body obj)
	move   func(id, group string) (method, rest string, body obj)
	// del is the path of the delete, with its query.
	del func(id string) string
}

var bothKinds = []bothKind{
	{
		name: "chat", told: "chat", gone: "chat_removed",
		make:   func(name, group string) (string, obj) { return "/chats", obj{"agent": "claude", "group": group} },
		path:   func(id string) string { return "/chats/" + id },
		rename: func(id, name string) (string, string, obj) { return "PATCH", "/chats/" + id, obj{"name": name} },
		move:   func(id, group string) (string, string, obj) { return "PATCH", "/chats/" + id, obj{"group": group} },
		del:    func(id string) string { return "/chats/" + id },
	},
	{
		name: "board", told: "board", gone: "board_removed",
		make: func(name, group string) (string, obj) { return "/boards", obj{"name": name, "group": group} },
		path: func(id string) string { return "/boards/" + id },
		rename: func(id, name string) (string, string, obj) {
			return "POST", "/boards/" + id + "/rename", obj{"name": name}
		},
		move: func(id, group string) (string, string, obj) { return "PATCH", "/boards/" + id, obj{"group": group} },
		del:  func(id string) string { return "/boards/" + id },
	},
	{ // every change of a group is told by the whole list
		name: "group", told: "groups",
		make:   func(name, group string) (string, obj) { return "/groups", obj{"name": name, "parent": ""} },
		path:   func(id string) string { return "/groups/" + id },
		rename: func(id, name string) (string, string, obj) { return "PATCH", "/groups/" + id, obj{"name": name} },
		move: func(id, group string) (string, string, obj) {
			return "POST", "/groups/" + id + "/move", obj{"parent": group, "before": ""}
		},
		del: func(id string) string { return "/groups/" + id + "?contents=keep" },
	},
}

// step is one change of the remote server's tree by one of the users: the call, which must be
// answered 200; then the event that tells it, of this type, naming the thing and holding state
// (a part with "!" in front must not be in it), which every user gets on the stream it had
// open, with the same events in the same order; and then a fresh state of each, which is the
// same tree for all. A type that ends in "_removed", and gone, say that the thing is in no
// tree afterwards. It returns the call's answer.
func (bo *both) step(us []*user, by *user, what, method, rest string, body any, typ, id string, gone bool, state ...string) string {
	bo.t.Helper()
	what = what + " by " + by.who
	out := by.want(bo.t, 200, method, rest, body)
	if id == "" { // a make: the thing is named by the answer
		id = l5ID(bo.t, out)
	}
	wait := []string{typ, id}
	if gone && !strings.HasSuffix(typ, "_removed") {
		wait = []string{typ} // a list that no longer has the thing
	}
	evs := bo.told(what, us, wait)
	final := bo.last(what, evs, wait[0], wait[1:]...)
	for _, part := range state {
		part, without := strings.CutPrefix(part, "!")
		if strings.Contains(final, part) == without {
			bo.t.Errorf("%s: the %s event is %s; want it with %q: %v", what, typ, final, part, !without)
		}
	}
	if !strings.HasSuffix(typ, "_removed") {
		for _, removed := range []string{"chat_removed", "board_removed"} {
			if l5Count(evs, removed) != 0 {
				bo.t.Errorf("%s: sent %v", what, l5Types(evs))
			}
		}
	}
	if tree := bo.level(what, us...); strings.Contains(tree, `"`+id+`"`) == gone {
		bo.t.Errorf("%s: the thing %s is in the tree: %v\n%s", what, id, !gone, tree)
	}
	return out
}

// The table {who acts} x {kind} x {action}: the owner, client 1 and client 2; a chat, a board
// and a group; make, rename, move to another group, archive, unarchive
// and delete. In each round the three take turns, so that a thing one of them made is renamed
// by the next and moved by the third. The default set runs one round, in which every kind
// meets every action and each of the three acts on every kind; the full set runs the three
// rounds, in which every one of the three does every action to every kind.
func TestBothEveryoneFollowsEveryChange(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{})
	us := bo.three()
	rounds := 1
	if testset.Full() {
		rounds = len(us)
	}
	var kept []string // the groups that are left
	for round := range rounds {
		name := fmt.Sprintf("round-%d", round)
		// Two groups to make things in and to move them to, by two of the three.
		from := l5ID(t, bo.step(us, us[round%3], "a group to make things in", "POST", "/groups", obj{"name": "From " + name, "parent": ""}, "groups", "", false))
		to := l5ID(t, bo.step(us, us[(round+1)%3], "a group to move things to", "POST", "/groups", obj{"name": "To " + name, "parent": ""}, "groups", "", false))
		kept = append(kept, from, to)
		in := func(g string) string { return `"group":"` + g + `"` }
		for k, kind := range bothKinds {
			by := func(action int) *user { return us[(round+k+action)%3] }
			group := kind.name == "group"
			made := kind.name + "-of-" + name

			// Make: the thing is in the group it was made in, for all three, with one id.
			rest, body := kind.make(made, from)
			state := []string{in(from)}
			if group {
				state = []string{`"name":"` + made + `"`}
			}
			id := l5ID(t, bo.step(us, by(0), "a new "+kind.name, "POST", rest, body, kind.told, "", false, state...))
			if kind.name == "board" {
				// Who makes a board holds it, and lets it go at once: an archive or a delete of a
				// board that is held waits for its holder.
				if out := by(0).want(t, 200, "POST", kind.path(id)+"/release", nil); out != `{"state":"free"}` {
					t.Fatalf("the release of the board %s made: %s", by(0).who, out)
				}
			}

			// Rename, by the next one.
			renamed := "renamed-in-" + name // a name a board keeps as it is
			method, rest, body := kind.rename(id, renamed)
			bo.step(us, by(1), "the rename of a "+kind.name, method, rest, body, kind.told, id, false, `"name":"`+renamed+`"`)

			// Move to the other group, by the third.
			method, rest, body = kind.move(id, to)
			state = []string{in(to)}
			if group {
				state = []string{`"parent":"` + to + `"`}
			}
			bo.step(us, by(2), "the move of a "+kind.name, method, rest, body, kind.told, id, false, state...)

			// Archive and unarchive: the mark is the thing's own, and it stays where it is.
			bo.step(us, by(3), "the archive of a "+kind.name, "POST", kind.path(id)+"/archive", nil, kind.told, id, false, `"archived":true`)
			bo.step(us, by(4), "the unarchive of a "+kind.name, "POST", kind.path(id)+"/unarchive", nil, kind.told, id, false, `!"archived"`)

			// Delete: it leaves every tree at once.
			typ := kind.gone
			if group {
				typ = kind.told
			}
			bo.step(us, by(5), "the delete of a "+kind.name, "DELETE", kind.del(id), nil, typ, id, true)
		}
	}
	// What is left is the groups of the rounds, in the order they were made, for all three.
	tree := bo.level("after the rounds", us...)
	var ids []string
	for _, g := range decode[struct{ Groups []model.Group }](t, tree).Groups {
		ids = append(ids, g.ID)
	}
	if !slices.Equal(ids, kept) || l5Field(t, tree, "boards") != "[]" || l5Field(t, tree, "chats") != "[]" {
		t.Errorf("the tree after the rounds: %s, want the groups %v and nothing else", tree, kept)
	}
	// Nothing of the remote server is among a client's own things, and nothing of it on its disk.
	for _, sd := range bo.c {
		if snap := decode[pageSnapshot](t, string(do(t, sd.a.page("after"), "GET", "/api/state", nil))); len(snap.Groups)+len(snap.Boards)+len(snap.Chats) != 0 {
			t.Errorf("%s has things of its own after the rounds: %+v", sd.who, snap)
		}
		noFileHolds(t, sd.a.a.DataDir, kept[0])
		noFileHolds(t, sd.root, kept[0])
	}
}

// Every group action from a client, and that the owner's page and the other client follow it
// (goal 3.5 and D7; contract 2.4): make, rename, move, nest, archive, unarchive, and delete
// with what is in the group kept and with everything in it. The rules are the local group's:
// what breaks one is refused for the client as the remote server refuses it for its own page.
func TestBothGroupActionsOfAClient(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{})
	us := bo.three()
	owner, one, two := us[0], us[1], us[2]
	groups := func(what string) []model.Group {
		t.Helper()
		return decode[struct{ Groups []model.Group }](t, bo.level(what, us...)).Groups
	}
	order := func(what string) (ids []string) {
		for _, g := range groups(what) {
			ids = append(ids, g.ID)
		}
		return ids
	}
	group := func(what, id string) model.Group {
		t.Helper()
		for _, g := range groups(what) {
			if g.ID == id {
				return g
			}
		}
		t.Fatalf("%s: no group %s", what, id)
		return model.Group{}
	}

	// Make: at the top level, and nested in a group, from the section's head and from a group.
	a := l5ID(t, bo.step(us, one, "a new group", "POST", "/groups", obj{"name": "A", "parent": ""}, "groups", "", false, `"name":"A"`))
	b := l5ID(t, bo.step(us, one, "a second group", "POST", "/groups", obj{"name": "B", "parent": ""}, "groups", "", false))
	c := l5ID(t, bo.step(us, one, "a group in a group", "POST", "/groups", obj{"name": "C", "parent": a}, "groups", "", false, `"parent":"`+a+`"`))
	// Rename.
	bo.step(us, one, "the rename", "PATCH", "/groups/"+b, obj{"name": "B, renamed"}, "groups", b, false, `"name":"B, renamed"`)
	// Move: before another group of the same level.
	bo.step(us, one, "the move before another", "POST", "/groups/"+b+"/move", obj{"parent": "", "before": a}, "groups", b, false)
	if got := order("after the move"); !slices.Equal(got, []string{b, a, c}) {
		t.Errorf("the order after the move of B before A: %v, want %v", got, []string{b, a, c})
	}
	// Nest: into another group, and out of it again.
	bo.step(us, one, "the nesting", "POST", "/groups/"+b+"/move", obj{"parent": a, "before": c}, "groups", b, false, `"parent":"`+a+`"`)
	if g := group("after the nesting", b); g.Parent != a {
		t.Errorf("the nested group: %+v", g)
	}
	bo.step(us, one, "the move to the top level", "POST", "/groups/"+b+"/move", obj{"parent": "", "before": ""}, "groups", b, false)
	if g := group("after the move out", b); g.Parent != "" {
		t.Errorf("the group that was moved out: %+v", g)
	}
	// Archive and unarchive: the group nested in it goes along.
	bo.step(us, one, "the archive", "POST", "/groups/"+a+"/archive", nil, "groups", a, false, `"archived":true`)
	if !group("after the archive", a).Archived {
		t.Error("the archived group is not archived")
	}
	bo.step(us, one, "the unarchive", "POST", "/groups/"+a+"/unarchive", nil, "groups", a, false)
	if group("after the unarchive", a).Archived || group("after the unarchive", c).Archived {
		t.Error("the unarchived group is still archived")
	}

	// What breaks a rule of a group is refused, and the client gets the remote server's own
	// answer as it came: the same status and body its own page gets for the same call.
	for _, r := range []struct{ what, method, rest, body string }{
		{"a group into itself", "POST", "/groups/" + a + "/move", `{"parent":"` + a + `"}`},
		{"a group into a group nested in it", "POST", "/groups/" + a + "/move", `{"parent":"` + c + `"}`},
		{"a rename to nothing", "PATCH", "/groups/" + a, `{"name":"  "}`},
		{"a group in a group that is not there", "POST", "/groups", `{"name":"n","parent":"g_nothere"}`},
		{"a delete that does not say what happens to the contents", "DELETE", "/groups/" + a, ``},
		{"the delete of a group that is not there", "DELETE", "/groups/g_nothere?contents=delete", ``},
	} {
		var body any
		if r.body != "" {
			body = r.body
		}
		status, out := one.call(r.method, r.rest, body)
		own, ownOut := owner.call(r.method, r.rest, body)
		if status != own || out != ownOut || status < 400 {
			t.Errorf("%s: the client is answered %d %s, the owner's page %d %s", r.what, status, out, own, ownOut)
		}
		if status == 404 && decode[map[string]string](t, out)["code"] != "not_found" {
			t.Errorf("%s: a 404 without the code not_found: %s", r.what, out)
		}
	}
	if evs := bo.same("the refused calls", us...); len(evs) != 0 {
		t.Errorf("the refused calls told %v", evs)
	}

	// fill makes a chat and a board in the group, by the client, and lets the board go.
	fill := func(g string) (ids []string) {
		t.Helper()
		for _, kind := range bothKinds[:2] {
			rest, body := kind.make("in "+g, g)
			id := l5ID(t, bo.step(us, one, "a new "+kind.name, "POST", rest, body, kind.told, "", false, `"group":"`+g+`"`))
			if kind.name == "board" {
				one.want(t, 200, "POST", "/boards/"+id+"/release", nil)
			}
			ids = append(ids, id)
		}
		return ids
	}
	// Delete with what is in the group kept: the group is gone, and its things and the group
	// nested in it are where the remote server put them, the same for all three.
	inA, inC := fill(a), fill(c)
	one.want(t, 200, "DELETE", "/groups/"+a+"?contents=keep", nil)
	evs := bo.same("the delete of a group, its contents kept", us...)
	if final := bo.last("the delete of a group, its contents kept", evs, "groups"); strings.Contains(final, a) || !strings.Contains(final, c) {
		t.Errorf("the groups after the delete of %s: %s", a, final)
	}
	tree := bo.level("after the delete of a group, its contents kept", us...)
	for _, id := range slices.Concat(inA, inC) {
		if !strings.Contains(tree, id) {
			t.Errorf("%s is gone with its group, which was deleted with its contents kept", id)
		}
	}
	if g := group("after the delete of its parent", c); g.Parent != "" {
		t.Errorf("the group that was nested in the deleted one: %+v", g)
	}
	if strings.Contains(tree, `"group":"`+a+`"`) {
		t.Errorf("a thing is still in the deleted group: %s", tree)
	}

	// Delete with everything in it: the group, the group nested in it and what is in both. The
	// other client and the owner are told each removed thing, and then the groups.
	d := l5ID(t, bo.step(us, one, "a group to delete", "POST", "/groups", obj{"name": "D", "parent": ""}, "groups", "", false))
	e := l5ID(t, bo.step(us, one, "a group in it", "POST", "/groups", obj{"name": "E", "parent": d}, "groups", "", false))
	inD, inE := fill(d), fill(e)
	if out := one.want(t, 200, "DELETE", "/groups/"+d+"?contents=delete", nil); out != `{"ok":true}` {
		t.Errorf("the delete of a group with everything in it: %s", out)
	}
	evs = bo.told("the delete of a group with everything in it", us, []string{"defaults"})
	told := only(evs, "groups", "defaults", "chat_removed", "board_removed")
	if types := l5Types(told); !slices.Equal(types[max(len(types)-2, 0):], []string{"groups", "defaults"}) || len(types) != 6 {
		t.Fatalf("the delete of a group with everything in it told %v: the groups and the defaults come after the removals", l5Types(evs))
	}
	for i, id := range slices.Concat(inD, inE) {
		typ := []string{"chat_removed", "board_removed"}[i%2]
		if n := l5Count(evs, typ, `"id":"`+id+`"`); n != 1 {
			t.Errorf("the removal of %s was told %d times: %v", id, n, l5Types(evs))
		}
	}
	if final := told[len(told)-2]; strings.Contains(final, d) || strings.Contains(final, e) || !strings.Contains(final, c) {
		t.Errorf("the groups after the delete with everything in it: %s", final)
	}
	tree = bo.level("after the delete of a group with everything in it", us...)
	for _, id := range slices.Concat(inD, inE, []string{d, e}) {
		if strings.Contains(tree, id) {
			t.Errorf("%s is still in the tree after the delete of its group", id)
		}
	}
	for _, id := range slices.Concat(inA, inC) {
		if !strings.Contains(tree, id) {
			t.Errorf("%s, of another group, is gone", id)
		}
	}
	// It is gone for everyone: the other client's call for a deleted thing is that server's 404.
	two.refused(t, 404, "not_found", "GET", "/chats/"+inD[0], nil)
	two.refused(t, 404, "not_found", "PATCH", "/groups/"+d, obj{"name": "late"})
}

// Whether a group shows collapsed is the owner's own matter (goal 3.11 and 3.13, D13; contract
// 2.4, 3.2 and 3.4): a client's change that names "collapsed" is refused by its own server and
// nothing is sent, and what the owner collapses changes nothing in a client's section.
func TestBothCollapsedIsNoPartOfASection(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{})
	us := bo.three()
	owner, one, two := us[0], us[1], us[2]
	g := l5ID(t, bo.step(us, two, "a new group", "POST", "/groups", obj{"name": "G", "parent": ""}, "groups", "", false))
	before := [2]string{one.tree(t), two.tree(t)}

	// A client: refused here, whatever the value is and whatever else the body holds.
	bo.untouched("a change of a group that names collapsed", func() {
		for _, body := range []string{`{"collapsed":true}`, `{"collapsed":false}`, `{"name":"Mine","collapsed":true}`, `{"collapsed":null}`} {
			for _, u := range []*user{one, two} {
				u.refused(t, 400, "collapsed_refused", "PATCH", "/groups/"+g, body)
			}
		}
	})
	if evs := bo.same("the refused changes", us...); len(evs) != 0 {
		t.Errorf("the refused changes told %v", evs)
	}
	if name := decode[struct{ Groups []model.Group }](t, bo.level("after the refused changes", us...)).Groups[0].Name; name != "G" {
		t.Errorf("a refused change renamed the group: %q", name)
	}

	// The owner collapses the group on its own page. Its own state has it; no section does, and
	// no event of a section (user.plain and user.tree fail on one that has "collapsed").
	owner.want(t, 200, "PATCH", "/groups/"+g, obj{"collapsed": true})
	bo.same("the owner's collapse", us...)
	if state := string(do(t, owner.p, "GET", "/api/state", nil)); !strings.Contains(state, `"collapsed":true`) {
		t.Fatalf("the owner's state after its collapse: %s", state)
	}
	for i, u := range []*user{one, two} {
		if after := u.tree(t); after != before[i] {
			t.Errorf("the owner's collapse changed the section of %s:\nbefore %s\nafter  %s", u.who, before[i], after)
		}
	}
	// And a page that connects now is handed no "collapsed" either.
	if tree := bo.c[0].page("late").tree(t); tree != before[0] {
		t.Errorf("the section of a page that connects after the owner's collapse: %s", tree)
	}
	// A change by a client leaves the owner's collapse as it is.
	bo.step(us, one, "a client's rename", "PATCH", "/groups/"+g, obj{"name": "Renamed"}, "groups", g, false, `"name":"Renamed"`)
	if state := string(do(t, owner.p, "GET", "/api/state", nil)); !strings.Contains(state, `"collapsed":true`) {
		t.Errorf("the owner's state after a client's rename: %s", state)
	}
}

// The defaults of a group in a section are that server's, shared by all who use it (goal 3.4,
// D15): what the first message of client 1 in a group started with is what the next new chat
// of client 2 and of the owner starts with in that group, and the change of the defaults is
// told to the other client with the entry's id.
func TestBothDefaultsAreTheServers(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{})
	us := bo.three()
	owner, one, two := us[0], us[1], us[2]
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	g := l5ID(t, bo.step(us, owner, "a new group", "POST", "/groups", obj{"name": "G", "parent": ""}, "groups", "", false))
	other := l5ID(t, bo.step(us, owner, "another group", "POST", "/groups", obj{"name": "Other", "parent": ""}, "groups", "", false))

	// Client 1 makes a chat in the group, sets it up and sends its first message.
	chat := l5ID(t, one.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": g}))
	one.want(t, 200, "PATCH", "/chats/"+chat, obj{"model": "opus", "effort": "low", "cwd": dir, "subDepth": 3, "subCap": 9})
	bo.same("the set-up", us...)
	one.want(t, 200, "POST", "/chats/"+chat+"/messages", obj{"text": "the first message"})
	evs := bo.told("the first message", us, []string{"defaults", `"model":"opus"`})
	told := bo.last("the first message", evs, "defaults")
	for _, part := range []string{`"` + g + `":{"servers":{"local":{`, `"model":"opus"`, `"effort":"low"`, `"cwd":"` + dir + `"`} {
		if !strings.Contains(told, part) {
			t.Errorf("the defaults event after the first message lacks %s: %s", part, told)
		}
	}
	// A section's defaults name no server but that one: "local" there is the remote server.
	keys := decode[struct {
		Defaults struct {
			Groups map[string]struct{ Servers map[string]any }
		}
	}](t, told).Defaults.Groups[g].Servers
	if len(keys) != 1 || keys["local"] == nil {
		t.Errorf("the servers of the group's defaults: %v", keys)
	}

	// The next new chat in that group starts with it, whoever makes it; a chat in another group
	// does not.
	for _, u := range []*user{two, owner, one} {
		v := decode[model.ChatView](t, u.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": g}))
		if v.Model != "opus" || v.Effort != "low" || v.Cwd != dir || v.SubDepth != 3 || v.SubCap != 9 || v.Group != g || v.Locked {
			t.Errorf("the new chat of %s in the group: %+v", u.who, v)
		}
		v = decode[model.ChatView](t, u.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": other}))
		if v.Model == "opus" || v.Cwd == dir {
			t.Errorf("the new chat of %s in another group: %+v", u.who, v)
		}
	}
	bo.same("the new chats", us...)
	tree := bo.level("after the new chats", us...)
	if !strings.Contains(l5Field(t, tree, "defaults"), `"cwd":"`+dir+`"`) {
		t.Errorf("the defaults of the tree: %s", l5Field(t, tree, "defaults"))
	}
	// A client's own server remembers none of it.
	for _, sd := range bo.c {
		if state := string(do(t, sd.a.page("own"), "GET", "/api/state", nil)); strings.Contains(l5Field(t, state, "defaults"), dir) {
			t.Errorf("%s remembers the remote server's defaults as its own: %s", sd.who, l5Field(t, state, "defaults"))
		}
		noFileHolds(t, sd.a.a.DataDir, dir)
	}
}
