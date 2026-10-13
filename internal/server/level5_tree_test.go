package server

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// One tree for everyone (contract 2.5, 2.6 and 2.7.1; goal 3.3, 3.6 and 3.11): the owner's page
// and two clients on one server. Whatever one of them makes or changes, the other two are told
// by the same list events, and a client that connects later is sent all of it.

// l5Site is one server with runs, the owner's page on its own port and the two API clients X
// and Y on the remote port, each with its stream. The page "A" of the env makes no call.
type l5Site struct {
	*apiRunEnv
	t       *testing.T
	p, x, y *bridgetest.Page
}

func l5NewSite(t *testing.T) *l5Site {
	t.Helper()
	e := newAPIRunEnv(t)
	s := &l5Site{apiRunEnv: e, t: t, p: e.page(l5Owner)}
	s.x, _ = e.l.api(apiX)
	s.y, _ = e.l.api(apiY)
	return s
}

// all is the three who use the server, the owner's page first.
func (s *l5Site) all() []*bridgetest.Page { return []*bridgetest.Page{s.p, s.x, s.y} }

// who names one of the three in a failure.
func (s *l5Site) who(c *bridgetest.Page) string {
	return map[*bridgetest.Page]string{s.p: "the owner's page", s.x: "the client X", s.y: "the client Y"}[c]
}

// told reads, for each of the three, the events up to the first of this type that holds has,
// and what was sent besides. It fails unless all three were sent the same list events, each
// exactly as the owner's page was sent it, in the same order, and unless the clients were sent
// nothing a page alone is sent. It returns those list events.
func (s *l5Site) told(what, typ string, has ...string) []string {
	s.t.Helper()
	return s.toldEach(what, append([]string{typ}, has...))
}

// toldEach is told for a change that several events tell, in an order that is not fixed: the
// events of a run come from the run service's own queue, before or after what the call itself
// sends. Each of waits is a type and what the event holds; each of the three is read until it
// was sent every one of them.
func (s *l5Site) toldEach(what string, waits ...[]string) []string {
	s.t.Helper()
	got := make([][]string, 3)
	for i, c := range s.all() {
		left := slices.Clone(waits)
		for len(left) > 0 {
			raw := c.NextRaw()
			got[i] = append(got[i], raw)
			left = slices.DeleteFunc(left, func(w []string) bool { return l5Count([]string{raw}, w[0], w[1:]...) == 1 })
		}
	}
	for i, rest := range s.reach(s.all()...) {
		got[i] = append(got[i], rest...)
	}
	lists := make([][]string, 3)
	for i, c := range s.all() {
		lists[i] = only(got[i], l5List...)
		if c != s.p {
			l5NoPageEvents(s.t, c, got[i])
		}
		for _, raw := range got[i] {
			l5Unmarked(s.t, "an event "+s.who(c)+" was sent", raw)
		}
	}
	for i, c := range s.all()[1:] {
		if !slices.Equal(lists[i+1], lists[0]) {
			s.t.Fatalf("%s: %s was sent\n%s\nand the owner's page\n%s", what, s.who(c), strings.Join(lists[i+1], "\n"), strings.Join(lists[0], "\n"))
		}
	}
	return lists[0]
}

// last is the last of the events that is of this type and holds has; the test fails without one.
func (s *l5Site) last(what string, evs []string, typ string, has ...string) string {
	s.t.Helper()
	for i := len(evs) - 1; i >= 0; i-- {
		if l5Count(evs[i:i+1], typ, has...) == 1 {
			return evs[i]
		}
	}
	s.t.Fatalf("%s: no %s event with %v among %v", what, typ, has, evs)
	return ""
}

// step is one change of the tree by one of the three: the call, which must be answered 200,
// and then the event that tells it, which all three must get: of this type, naming the thing
// and holding state. No event of the step may tell the thing is removed unless typ says so.
func (s *l5Site) step(by *bridgetest.Page, what, method, path string, body any, typ, id string, state ...string) string {
	s.t.Helper()
	what = what + " by " + s.who(by)
	out := l5Want(s.t, by, 200, method, path, body)
	if id == "" { // a make: the thing is named by the answer
		id = l5ID(s.t, out)
	}
	evs := s.told(what, typ, id)
	final := s.last(what, evs, typ, id)
	for _, part := range state {
		part, without := strings.CutPrefix(part, "!")
		if strings.Contains(final, part) == without {
			s.t.Errorf("%s: the %s event is %s; want it with %q: %v", what, typ, final, part, !without)
		}
	}
	if !strings.HasSuffix(typ, "_removed") {
		for _, removed := range []string{"chat_removed", "board_removed", "run_removed"} {
			if l5Count(evs, removed) != 0 {
				s.t.Errorf("%s: sent %v", what, l5Types(evs))
			}
		}
	}
	return out
}

// Each of the three makes a group, a chat, a board and a run; the next one renames each, the
// third moves it to another group, and so on through archive, unarchive and delete, so that
// over the three rounds everyone has made every change to every kind of thing. Every change is
// told to all three by the same events.
func TestLevel5EveryoneFollowsEveryChange(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	all := s.all()
	for round := range all {
		a, b, c := all[round], all[(round+1)%3], all[(round+2)%3]
		name := fmt.Sprintf("round-%d", round)
		// Two groups to make things in and to move them to.
		from := l5ID(t, s.step(a, "a new group", "POST", "/api/groups", `{"name":"From `+name+`"}`, "groups", "", `"name":"From `+name+`"`))
		to := l5ID(t, s.step(b, "a second group", "POST", "/api/groups", `{"name":"To `+name+`"}`, "groups", "", `"name":"To `+name+`"`))
		in := func(g string) string { return `"group":"` + g + `"` }

		// A chat.
		chat := l5ID(t, s.step(a, "a new chat", "POST", "/api/chats", `{"agent":"claude","group":"`+from+`"}`, "chat", "", in(from), `"locked":false`))
		path := "/api/chats/" + chat
		s.step(b, "the rename of a chat", "PATCH", path, `{"name":"Chat of `+name+`"}`, "chat", chat, `"name":"Chat of `+name+`"`, in(from))
		s.step(c, "the move of a chat", "PATCH", path, `{"group":"`+to+`"}`, "chat", chat, in(to))
		s.step(a, "the archive of a chat", "POST", path+"/archive", nil, "chat", chat, `"archived":true`)
		s.step(b, "the unarchive of a chat", "POST", path+"/unarchive", nil, "chat", chat, `!"archived"`, in(to))
		s.step(c, "the delete of a chat", "DELETE", path, nil, "chat_removed", chat)

		// A board. Who makes it holds it, and lets it go at once: an archive or a delete of a
		// board that is held waits for its holder.
		board := l5ID(t, s.step(a, "a new board", "POST", "/api/boards", `{"name":"board-of-`+name+`","group":"`+from+`"}`, "board", "", in(from), `"name":"board-of-`+name+`"`))
		path = "/api/boards/" + board
		if out := l5Want(t, a, 200, "POST", path+"/release", nil); out != `{"state":"free"}` {
			t.Fatalf("the release of the board %s made: %s", s.who(a), out)
		}
		s.step(b, "the rename of a board", "POST", path+"/rename", `{"name":"renamed-in-`+name+`"}`, "board", board, `"name":"renamed-in-`+name+`"`)
		s.step(c, "the move of a board", "PATCH", path, `{"group":"`+to+`"}`, "board", board, in(to))
		s.step(a, "the archive of a board", "POST", path+"/archive", nil, "board", board, `"archived":true`)
		s.step(b, "the unarchive of a board", "POST", path+"/unarchive", nil, "board", board, `!"archived"`, in(to))
		s.step(c, "the delete of a board", "DELETE", path, nil, "board_removed", board)

		// A run, which has not started.
		run := l5ID(t, s.step(a, "a new run", "POST", "/api/runs", `{"group":"`+from+`","name":"Run of `+name+`"}`, "run", "", in(from), `"status":"draft"`))
		path = "/api/runs/" + run
		s.step(b, "the rename of a run", "PATCH", path, `{"name":"Renamed in `+name+`"}`, "run", run, `"name":"Renamed in `+name+`"`)
		s.step(c, "the move of a run", "PATCH", path, `{"group":"`+to+`"}`, "run", run, in(to))
		s.step(a, "the archive of a run", "POST", path+"/archive", nil, "run", run, `"archived":true`)
		s.step(b, "the unarchive of a run", "POST", path+"/unarchive", nil, "run", run, `!"archived"`, in(to))
		s.step(c, "the delete of a run", "DELETE", path, nil, "run_removed", run)

		// A group: every change of one is told by the whole list.
		group := l5ID(t, s.step(a, "a third group", "POST", "/api/groups", `{"name":"Third of `+name+`"}`, "groups", "", `"name":"Third of `+name+`"`))
		path = "/api/groups/" + group
		s.step(b, "the rename of a group", "PATCH", path, `{"name":"Renamed in `+name+`"}`, "groups", group, `"name":"Renamed in `+name+`"`)
		s.step(c, "the move of a group", "POST", path+"/move", `{"parent":"`+to+`","before":""}`, "groups", group, `"parent":"`+to+`"`)
		s.step(a, "the archive of a group", "POST", path+"/archive", nil, "groups", group, `"archived":true`)
		s.step(b, "the unarchive of a group", "POST", path+"/unarchive", nil, "groups", group, `!"archived"`)
		// The delete is told by a list that no longer has the group.
		l5Want(t, c, 200, "DELETE", path+"?contents=keep", nil)
		evs := s.told("the delete of a group by "+s.who(c), "defaults")
		if final := s.last("the delete of a group", evs, "groups", from, to); strings.Contains(final, group) {
			t.Errorf("the groups after the delete of %s by %s: %s", group, s.who(c), final)
		}
		if final := s.last("the delete of a group", evs, "defaults", from, to); strings.Contains(final, group) {
			t.Errorf("the defaults after the delete of %s by %s: %s", group, s.who(c), final)
		}
	}
	// What is left is the six groups of the three rounds, for the owner and for a client alike.
	for _, c := range all {
		snap := decode[struct {
			Groups              []model.Group
			Boards, Chats, Runs []struct{ ID string }
		}](t, l5Want(t, c, 200, "GET", "/api/state", nil))
		if len(snap.Groups) != 6 || len(snap.Boards)+len(snap.Chats)+len(snap.Runs) != 0 {
			t.Errorf("the state of %s after the rounds: %+v", s.who(c), snap)
		}
	}
}

// Changes that nobody reads in between arrive in the order they were made, the same for all:
// the three take turns at one chat, one board, one group and one run.
func TestLevel5ChangesArriveInTheirOrder(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	all := s.all()
	group := l5ID(t, s.step(s.p, "a new group", "POST", "/api/groups", `{"name":"g0"}`, "groups", ""))
	chat := l5ID(t, s.step(s.x, "a new chat", "POST", "/api/chats", `{"agent":"claude","group":"`+group+`"}`, "chat", ""))
	board := l5ID(t, s.step(s.y, "a new board", "POST", "/api/boards", `{"name":"b0","group":"`+group+`"}`, "board", ""))
	l5Want(t, s.y, 200, "POST", "/api/boards/"+board+"/release", nil)
	run := l5ID(t, s.step(s.p, "a new run", "POST", "/api/runs", `{"group":"`+group+`","name":"r0"}`, "run", ""))

	const turns = 9
	var want []string // the type and the name of each change of the chat, the board and the group
	for i := 1; i <= turns; i++ {
		by := all[i%3]
		n := fmt.Sprint(i)
		l5Want(t, by, 200, "PATCH", "/api/chats/"+chat, `{"name":"c`+n+`"}`)
		l5Want(t, all[(i+1)%3], 200, "POST", "/api/boards/"+board+"/rename", `{"name":"b`+n+`"}`)
		l5Want(t, all[(i+2)%3], 200, "PATCH", "/api/groups/"+group, `{"name":"g`+n+`"}`)
		l5Want(t, by, 200, "PATCH", "/api/runs/"+run, `{"name":"r`+n+`"}`)
		want = append(want, "chat c"+n, "board b"+n, "groups g"+n)
	}
	evs := s.told("the turns", "run", run, fmt.Sprintf(`"name":"r%d"`, turns))
	var got, runs []string
	for _, raw := range evs {
		ev := decode[struct {
			Type   string
			Chat   struct{ Name string }
			Board  struct{ Name string }
			Run    struct{ Name string }
			Groups []struct{ Name string }
		}](t, raw)
		switch ev.Type {
		case "chat":
			got = append(got, "chat "+ev.Chat.Name)
		case "board":
			got = append(got, "board "+ev.Board.Name)
		case "groups":
			got = append(got, "groups "+ev.Groups[0].Name)
		case "run":
			runs = append(runs, ev.Run.Name)
		default:
			t.Errorf("the turns sent %s", raw)
		}
	}
	if !slices.Equal(got, want) {
		t.Errorf("the changes of the chat, the board and the group arrived as\n%v\nwant\n%v", got, want)
	}
	// The run service sends from its own queue: its events are in their own order.
	var wantRuns []string
	for i := 1; i <= turns; i++ {
		wantRuns = append(wantRuns, fmt.Sprint("r", i))
	}
	if !slices.Equal(runs, wantRuns) {
		t.Errorf("the changes of the run arrived as %v, want %v", runs, wantRuns)
	}
}

// A client is sent no event that is a page's alone, whatever the server sends its pages.
func TestLevel5PageOnlyEventsReachNoClient(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	for _, typ := range l5PageOnly {
		s.s.Bridge.Broadcast(map[string]any{"type": typ, "server": "s_0123456789ab", "servers": []string{}, "tree": nil})
	}
	// A list event after them: everyone is sent it, and the clients nothing before it.
	l5Want(t, s.p, 200, "POST", "/api/groups", `{"name":"After"}`)
	evs := s.reach(s.all()...)
	if got := l5Types(evs[0]); !slices.Equal(got, append(slices.Clone(l5PageOnly), "groups", "defaults")) {
		t.Errorf("the owner's page was sent %v", got)
	}
	for i, c := range s.all()[1:] {
		if got := l5Types(evs[i+1]); !slices.Equal(got, []string{"groups", "defaults"}) {
			t.Errorf("%s was sent %v", s.who(c), got)
		}
	}
}

// l5SnapshotFields is the fields of a client's snapshot (contract 2.5), sorted.
var l5SnapshotFields = []string{"agents", "boards", "catalogs", "chats", "defaultCwd", "defaults", "groups", "home", "library", "runs", "states"}

// A client that connects later is sent the whole tree in its snapshot, whoever made what is in
// it, archived things included; GET /api/state on the remote port is the same; and the lists
// are the ones the owner's page gets, each in the same order.
func TestLevel5SnapshotIsTheWholeTree(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	// A client of a server with nothing on it: every list is there and empty.
	first, empty := e.l.api(apiX)
	if got := keysOf(t, empty); !slices.Equal(got, append(slices.Clone(l5SnapshotFields), "type")) {
		t.Fatalf("the snapshot of a client has the fields %v", got)
	}
	for _, list := range []string{"groups", "boards", "chats", "states", "runs"} {
		if got := l5Field(t, empty, list); got != "[]" {
			t.Errorf("%q in the snapshot of an empty server: %s", list, got)
		}
	}
	if got := l5Field(t, empty, "defaults"); !l5Same(t, got, `{"groups":{}}`) {
		t.Errorf("the defaults in the snapshot of an empty server: %s", got)
	}
	p := e.page(l5Owner)
	second, _ := e.l.api(apiY)

	// Each of the three makes a group with a group nested in it, and a chat, a board and a run
	// in each of the two. What is in the nested group is archived with it, by somebody else.
	var kept, archived []string // ids
	makers := []*bridgetest.Page{p, first, second}
	for i, c := range makers {
		outer := l5ID(t, l5Want(t, c, 200, "POST", "/api/groups", fmt.Sprintf(`{"name":"Outer %d"}`, i)))
		inner := l5ID(t, l5Want(t, c, 200, "POST", "/api/groups", fmt.Sprintf(`{"name":"Inner %d","parent":"%s"}`, i, outer)))
		for _, g := range []string{outer, inner} {
			chat := l5ID(t, l5Want(t, c, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+g+`"}`))
			board := l5ID(t, l5Want(t, c, 200, "POST", "/api/boards", `{"name":"board","group":"`+g+`"}`))
			l5Want(t, c, 200, "POST", "/api/boards/"+board+"/release", nil)
			run := l5ID(t, l5Want(t, c, 200, "POST", "/api/runs", `{"group":"`+g+`","name":"Run"}`))
			if g == outer {
				kept = append(kept, g, chat, board, run)
			} else {
				archived = append(archived, g, chat, board, run)
			}
		}
		l5Want(t, makers[(i+1)%3], 200, "POST", "/api/groups/"+inner+"/archive", nil)
	}
	// One chat with a draft and a setting of its own, by a client.
	l5Want(t, first, 200, "PUT", "/api/chats/"+kept[1]+"/draft?rev=0", `{"text":"typed by a client"}`)
	l5Want(t, second, 200, "PATCH", "/api/chats/"+kept[1], `{"effort":"low"}`)
	l5UpTo(t, p, "run", archived[len(archived)-1], `"archived":true`) // the run service has sent what it queued

	z, snap := e.l.api(l5Z)
	if got := keysOf(t, snap); !slices.Equal(got, append(slices.Clone(l5SnapshotFields), "type")) {
		t.Fatalf("the snapshot of a client has the fields %v", got)
	}
	// Everything is in it, the archived things with their mark.
	type item struct {
		ID       string
		Archived bool
	}
	lists := decode[struct{ Groups, Boards, Chats, Runs []item }](t, snap)
	if len(lists.Groups) != 6 || len(lists.Boards) != 6 || len(lists.Chats) != 6 || len(lists.Runs) != 6 {
		t.Fatalf("the snapshot has %d groups, %d boards, %d chats and %d runs, want 6 of each", len(lists.Groups), len(lists.Boards), len(lists.Chats), len(lists.Runs))
	}
	marks := map[string]bool{}
	for _, it := range slices.Concat(lists.Groups, lists.Boards, lists.Chats, lists.Runs) {
		marks[it.ID] = it.Archived
	}
	for _, id := range kept {
		if mark, found := marks[id]; !found || mark {
			t.Errorf("%s in the snapshot: found %v, archived %v; want it, not archived", id, found, mark)
		}
	}
	for _, id := range archived {
		if mark, found := marks[id]; !found || !mark {
			t.Errorf("%s in the snapshot: found %v, archived %v; want it, archived", id, found, mark)
		}
	}
	if states := decode[struct {
		States []struct{ Chat, Branch string }
	}](t, snap).States; len(states) != 6 {
		t.Errorf("the snapshot has %d branch states, want one per chat: %+v", len(states), states)
	}
	if !strings.Contains(l5Field(t, snap, "chats"), "typed by a client") || !strings.Contains(l5Field(t, snap, "chats"), `"effort":"low"`) {
		t.Errorf("the chats of the snapshot lack the draft or the setting: %s", l5Field(t, snap, "chats"))
	}
	if got := l5Field(t, snap, "defaults"); !strings.Contains(got, `"local":{"byAgent":{"claude":{"model":"","effort":"low"}}}`) {
		t.Errorf("the defaults of the snapshot lack what the group remembers: %s", got)
	}

	// GET /api/state on the remote port is the snapshot event, field by field.
	state := l5Want(t, z, 200, "GET", "/api/state", nil)
	if got := keysOf(t, state); !slices.Equal(got, l5SnapshotFields) {
		t.Fatalf("GET /api/state on the remote port has the fields %v", got)
	}
	for _, f := range l5SnapshotFields {
		if !l5SameList(t, state, snap, f) {
			t.Errorf("%q of GET /api/state and of the snapshot event differ:\n%s\n%s", f, l5Field(t, state, f), l5Field(t, snap, f))
		}
	}
	// The same for everyone: another client's state, and the lists of the owner's page.
	other := l5Want(t, first, 200, "GET", "/api/state", nil)
	for _, f := range l5SnapshotFields {
		if !l5SameList(t, other, state, f) {
			t.Errorf("%q for two clients differ:\n%s\n%s", f, l5Field(t, other, f), l5Field(t, state, f))
		}
	}
	owner := l5Want(t, p, 200, "GET", "/api/state", nil)
	for _, f := range []string{"groups", "defaults", "boards", "chats", "states", "runs", "agents", "catalogs", "home", "defaultCwd"} {
		if !l5SameList(t, owner, snap, f) {
			t.Errorf("%q for the owner's page and for a client differ:\n%s\n%s", f, l5Field(t, owner, f), l5Field(t, snap, f))
		}
	}

	// Never in it: the server's own server list, the lists and libraries of the servers it
	// connects to, its sections, its data folder. The owner's page has them.
	for _, f := range []string{"servers", "lists", "libraries", "dataDir"} {
		if l5Field(t, owner, f) == "" {
			t.Errorf("the owner's state has no %q", f)
		}
	}
	for _, raw := range []string{snap, state} {
		for _, f := range []string{"servers", "lists", "libraries", "sections", "dataDir"} {
			if l5Field(t, raw, f) != "" {
				t.Errorf("a client is given %q: %s", f, l5Field(t, raw, f))
			}
		}
		if at, found := l5Keys(t, raw)["dataDir"]; found || strings.Contains(raw, e.a.DataDir) {
			t.Errorf("a client is given the data folder (%s)", at)
		}
		l5Unmarked(t, "what a client is given", raw)
	}
	l5Unmarked(t, "the owner's state", owner)
}
