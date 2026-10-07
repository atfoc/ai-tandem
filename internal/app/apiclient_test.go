package app

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/store"
)

const (
	clientX = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
	clientY = "0e5ac1f3-6d2b-4b7a-8f10-9a1b2c3d4e5f"
)

// started makes the chat of an API client as its creation call does, in the group "Remote".
func (e *env) started(client, id string) model.ChatView {
	e.t.Helper()
	res, err := e.a.Chats.Start(chats.StartReq{ID: id, Client: client, Agent: model.Claude, Cwd: e.t.TempDir(), Text: "go", Place: e.a.RemoteGroup})
	if err != nil || !res.Exists || !res.Started {
		e.t.Fatalf("start of %s: %+v, %v", id, res, err)
	}
	return res.Chat
}

// groups is the state's group list.
func (e *env) groups() []model.Group {
	var gs []model.Group
	e.st.Read(func(s *model.State) { gs = append(gs, s.Groups...) })
	return gs
}

// named is the groups with this name.
func (e *env) named(name string) (ids []string) {
	for _, g := range e.groups() {
		if g.Name == name {
			ids = append(ids, g.ID)
		}
	}
	return ids
}

// The API snapshot holds a client's own chats and the server's lists, under its own seven keys,
// and nothing of what the page's snapshot holds beyond them.
func TestAPISnapshot(t *testing.T) {
	e := newEnv(t)
	e.a.Home, e.a.DefaultCwd = "/home/owner", "/home/owner/work"
	m, err := servers.Open(servers.Options{Root: t.TempDir(), LocalID: "11111111-2222-4333-8444-555555555555", Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close) // never started: nothing is dialed
	pin := strings.TrimSuffix(strings.Repeat("AB:", 32), ":")
	if _, saved, _, err := m.Add(t.Context(), servers.Input{Name: "Studio", Address: "https://127.0.0.1:1", Secret: "not-for-a-client", SelfSigned: true, Pin: pin}, true); err != nil || !saved {
		t.Fatalf("add: %v, saved %v", err, saved)
	}
	e.a.Servers = m

	// A client nobody has seen: the lists, and empty lists of its own, none of them null.
	empty := e.a.APISnapshot(clientX)
	raw, err := json.Marshal(empty)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	var names []string
	for k := range keys {
		names = append(names, k)
	}
	sort.Strings(names)
	if want := []string{"agents", "catalogs", "chats", "defaultCwd", "home", "runs", "states"}; !slices.Equal(names, want) {
		t.Fatalf("keys %v, want %v", names, want)
	}
	for _, k := range []string{"chats", "states", "runs"} {
		if string(keys[k]) != "[]" {
			t.Errorf("%s of a new client: %s, want []", k, keys[k])
		}
	}
	if string(keys["agents"]) != `["claude","cursor","pi"]` {
		t.Errorf("agents: %s", keys["agents"])
	}

	// The lists are the page's snapshot's.
	page := e.a.Snapshot()
	if !reflect.DeepEqual(empty.Agents, page.Agents) || !reflect.DeepEqual(empty.Catalogs, page.Catalogs) ||
		empty.Home != "/home/owner" || empty.DefaultCwd != "/home/owner/work" {
		t.Fatalf("lists %+v, want those of the page's snapshot %+v", empty, page)
	}
	if c := empty.Catalogs; len(c) != 3 || c[model.Claude] == nil || c[model.Cursor] != nil || c[model.Pi] != nil {
		t.Fatalf("catalogs before any was reported: %v", c)
	}
	// A catalog an agent reported is in both, as a copy.
	e.must(e.st.Update(func(s *model.State) error {
		s.Catalogs = map[model.AgentKind]*model.Catalog{model.Pi: {Models: []model.CatalogModel{{ID: "pi-one"}}}}
		return nil
	}))
	got := e.a.APISnapshot(clientX)
	if c := got.Catalogs[model.Pi]; c == nil || len(c.Models) != 1 || c.Models[0].ID != "pi-one" || !reflect.DeepEqual(got.Catalogs, e.a.Snapshot().Catalogs) {
		t.Fatalf("catalogs after pi reported: %v", got.Catalogs)
	}
	got.Catalogs[model.Pi].Models = nil
	if c := e.a.APISnapshot(clientX).Catalogs[model.Pi]; len(c.Models) != 1 {
		t.Fatal("the snapshot's catalog is the store's own record")
	}

	// Each client is given its own chats, with their branches' states; the owner's are in neither.
	owner := e.chat(model.Ungrouped, "")
	bd := e.board(model.Ungrouped)
	const one, two, three = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"
	e.started(clientX, one)
	e.started(clientX, two)
	e.started(clientY, three)
	ids := func(s APISnapshot) (chats, states []string) {
		for _, c := range s.Chats {
			chats = append(chats, c.ID)
		}
		for _, st := range s.States {
			states = append(states, st.Chat)
		}
		sort.Strings(chats)
		sort.Strings(states)
		return chats, states
	}
	x, y := e.a.APISnapshot(clientX), e.a.APISnapshot(clientY)
	if c, s := ids(x); !slices.Equal(c, []string{one, two}) || !slices.Equal(s, []string{one, two}) {
		t.Fatalf("X's chats %v and states %v", c, s)
	}
	if c, s := ids(y); !slices.Equal(c, []string{three}) || !slices.Equal(s, []string{three}) {
		t.Fatalf("Y's chats %v and states %v", c, s)
	}
	if c, s := ids(e.a.APISnapshot("")); len(c) != 0 || len(s) != 0 {
		t.Fatalf("the snapshot of no client: chats %v, states %v", c, s)
	}
	if len(e.a.Snapshot().Chats) != 4 {
		t.Fatalf("the page's snapshot lists %d chats, want 4", len(e.a.Snapshot().Chats))
	}

	// Nothing of the page's snapshot beyond the seven keys: no group list, board, defaults, data
	// folder or server list, and no value of them either.
	raw, err = json.Marshal(x)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{`"groups"`, `"boards"`, `"defaults"`, `"dataDir"`, `"servers"`, `"lists"`, e.a.DataDir, owner, bd, three, clientY,
		"Studio", "https://127.0.0.1:1", pin, "not-for-a-client", remoteGroupName} {
		if strings.Contains(string(raw), s) {
			t.Errorf("X's snapshot holds %s: %s", s, raw)
		}
	}
	if !strings.Contains(string(raw), one) {
		t.Fatalf("X's snapshot lacks its chat: %s", raw)
	}
}

// The group "Remote" is made by the first call, remembered by its id, and made again when it is
// gone or archived.
func TestRemoteGroup(t *testing.T) {
	e := newEnv(t)
	other := e.group("Mine")
	// The ungrouped group's values, which a new top-level group starts with.
	e.must(e.st.Update(func(s *model.State) error {
		s.Defaults.Groups = map[string]model.GroupDefaults{model.Ungrouped: model.LocalDefaults(model.ServerDefaults{Agent: model.Cursor})}
		return nil
	}))
	p := e.page("P")
	if len(e.named(remoteGroupName)) != 0 || e.a.Snapshot().Groups[0].ID != other {
		t.Fatalf("groups before any call: %+v", e.groups())
	}

	id, err := e.a.RemoteGroup()
	e.must(err)
	gs := e.groups()
	if len(gs) != 2 || gs[1] != (model.Group{ID: id, Name: "Remote"}) || !strings.HasPrefix(id, "g_") {
		t.Fatalf("groups after the first call: %+v", gs)
	}
	var kept string
	var seeded model.GroupDefaults
	e.st.Read(func(s *model.State) { kept, seeded = s.RemoteGroup, s.Defaults.Groups[id] })
	if kept != id || seeded.On(model.LocalServer).Agent != model.Cursor {
		t.Fatalf("remembered %q, want %q; the group's defaults %+v, want a copy of the ungrouped group's", kept, id, seeded)
	}
	// The page is told of the group and of its defaults, once.
	if ev := p.Expect("groups"); !strings.Contains(string(mustJSON(t, ev)), id) {
		t.Fatalf("the groups event: %v", ev)
	}
	if ev := p.Expect("defaults"); !strings.Contains(string(mustJSON(t, ev)), id) {
		t.Fatalf("the defaults event: %v", ev)
	}

	// A second call makes nothing, writes nothing and tells nobody.
	before, err := os.ReadFile(e.st.P.State)
	e.must(err)
	again, err := e.a.RemoteGroup()
	e.must(err)
	after, err := os.ReadFile(e.st.P.State)
	e.must(err)
	if again != id || len(e.groups()) != 2 || string(before) != string(after) {
		t.Fatalf("a second call: id %q, want %q; %d groups", again, id, len(e.groups()))
	}
	p.ExpectNone(50 * time.Millisecond)

	// The id is in state.json, so a server that starts again finds the group.
	st2, err := store.Open(store.NewPaths(e.a.DataDir))
	e.must(err)
	st2.Read(func(s *model.State) { kept = s.RemoteGroup })
	if kept != id {
		t.Fatalf("state.json remembers %q, want %q", kept, id)
	}

	// The owner renames, collapses and nests it: it is still the group.
	name, yes := "Guests", true
	e.must(e.a.UpdateGroup(id, &name, &yes))
	e.must(e.a.MoveGroup(id, other, ""))
	if again, err = e.a.RemoteGroup(); err != nil || again != id || len(e.named(remoteGroupName)) != 0 {
		t.Fatalf("after a rename and a move: %q, %v, want %q and no second group", again, err, id)
	}

	// Each of these ends the group for new items: the next call makes a new one, at the top
	// level, with a new id.
	last := id
	next := func(what string) string {
		t.Helper()
		got, err := e.a.RemoteGroup()
		e.must(err)
		if got == last {
			t.Fatalf("%s: the same group %q", what, got)
		}
		i := groupIndex(e.groups(), got)
		if i < 0 || e.groups()[i] != (model.Group{ID: got, Name: "Remote"}) {
			t.Fatalf("%s: the new group is %+v", what, e.groups())
		}
		if same, err := e.a.RemoteGroup(); err != nil || same != got {
			t.Fatalf("%s: a second call gave %q, %v, want %q", what, same, err, got)
		}
		last = got
		return got
	}
	// Archived with the group it is nested in: its own mark says so.
	e.must(e.a.Archive(KindGroup, other))
	if !e.groupArchive(id).Archived {
		t.Fatal("the nested group is not marked archived")
	}
	g2 := next("archived with its parent")
	// Archived by itself.
	e.must(e.a.Archive(KindGroup, g2))
	g3 := next("archived")
	// Deleted alone: what it held moves to the ungrouped group.
	const one = "11111111-1111-4111-8111-111111111111"
	if cv := e.started(clientX, one); cv.Group != g3 {
		t.Fatalf("the chat is in %q, want the group %q", cv.Group, g3)
	}
	e.must(e.a.DeleteGroup(g3, false))
	if got := e.groupOf(one); got != model.Ungrouped {
		t.Fatalf("after the group's delete the chat is in %q", got)
	}
	g4 := next("deleted alone")
	// Deleted with its contents.
	const two = "22222222-2222-4222-8222-222222222222"
	e.started(clientX, two)
	e.must(e.a.DeleteGroup(g4, true))
	if _, err := e.a.Chats.View(two); err == nil {
		t.Fatal("the chat of the deleted group is still there")
	}
	g5 := next("deleted with its contents")
	// Unarchiving an older one does not make it the group again.
	e.must(e.a.Unarchive(KindGroup, g2))
	if got, err := e.a.RemoteGroup(); err != nil || got != g5 {
		t.Fatalf("after an older group came back: %q, %v, want %q", got, err, g5)
	}
	// A remembered id that names no group, as an older build's rewrite of the file leaves it.
	e.must(e.st.Update(func(s *model.State) error { s.RemoteGroup = ""; return nil }))
	next("forgotten")
}

// Many first calls at once make one group.
func TestRemoteGroupManyAtOnce(t *testing.T) {
	e := newEnv(t)
	var wg sync.WaitGroup
	ids := make([]string, 24)
	for i := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, err := e.a.RemoteGroup()
			if err != nil {
				t.Error(err)
			}
			ids[i] = id
		}()
	}
	wg.Wait()
	if got := e.named(remoteGroupName); len(got) != 1 || slices.ContainsFunc(ids, func(id string) bool { return id != got[0] }) {
		t.Fatalf("groups named Remote: %v; the calls' answers: %v", got, ids)
	}
}

// What API clients make sits in the one group "Remote", their forks too, and feeds no defaults:
// not after the owner moved an item out either (AC45).
func TestItemsOfAPIClientsSitInTheRemoteGroup(t *testing.T) {
	e := newEnv(t)
	mine := e.group("Mine")
	if len(e.named(remoteGroupName)) != 0 {
		t.Fatal("a group Remote before any creation")
	}
	const one, two = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	a, b := e.started(clientX, one), e.started(clientY, two)
	rg := e.named(remoteGroupName)
	if len(rg) != 1 || a.Group != rg[0] || b.Group != rg[0] {
		t.Fatalf("groups named Remote %v; the chats are in %q and %q", rg, a.Group, b.Group)
	}
	if i := groupIndex(e.groups(), rg[0]); e.groups()[i].Parent != "" {
		t.Fatalf("the group is nested: %+v", e.groups()[i])
	}
	for _, c := range e.a.Snapshot().Chats {
		if c.Group == model.Ungrouped {
			t.Fatalf("the chat %s is in the ungrouped group", c.ID)
		}
	}

	// The owner moves an item out, configures it and sends to it: the defaults stay as they
	// were. The item is a chat with a mark that has had no message, as a failed start leaves it.
	const three = "33333333-3333-4333-8333-333333333333"
	if _, err := e.a.Chats.CreateChat(chats.NewChat{ID: three, Client: clientX, Agent: model.Claude, Group: rg[0], Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	read := func() string {
		var d model.Defaults
		e.st.Read(func(s *model.State) { d = defaults.Copy(s.Defaults) })
		return string(mustJSON(t, d))
	}
	before := read()
	for _, id := range []string{one, three} {
		e.must(e.a.MoveChat(id, mine))
		if got := e.groupOf(id); got != mine {
			t.Fatalf("the moved chat %s is in %q", id, got)
		}
	}
	dir := t.TempDir()
	e.must(e.a.Chats.ConfigureOf(three, "", chats.ConfigReq{Agent: model.Cursor}))
	e.must(e.a.Chats.ConfigureOf(three, "", chats.ConfigReq{Agent: model.Claude, Model: "sonnet", Cwd: dir}))
	if _, err := e.a.Chats.SendBranch(three, "first", "", nil); err != nil {
		t.Fatal(err)
	}
	if v, err := e.a.Chats.View(three); err != nil || !v.Locked || v.Cwd != dir || v.Model != "sonnet" || v.Group != mine {
		t.Fatalf("the chat after the owner's changes: %+v, %v", v, err)
	}
	if got := read(); got != before {
		t.Fatalf("the defaults changed:\n%s\nwant\n%s", got, before)
	}
	for id, want := range map[string]string{one: clientX, two: clientY, three: clientX} {
		if mark, err := e.a.Chats.ClientOf(id); err != nil || mark != want {
			t.Fatalf("the mark of %s: %q, %v, want %q", id, mark, err, want)
		}
	}
	// The same steps on a chat of the owner's do record: the check above can fail.
	own := e.chat(mine, "")
	e.must(e.a.Chats.ConfigureOf(own, "", chats.ConfigReq{Cwd: dir}))
	if read() == before {
		t.Fatal("the owner's own chat recorded no defaults")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
