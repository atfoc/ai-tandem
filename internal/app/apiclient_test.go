package app

import (
	"encoding/json"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"

	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
)

// groups is the state's group list.
func (e *env) groups() []model.Group {
	var gs []model.Group
	e.st.Read(func(s *model.State) { gs = append(gs, s.Groups...) })
	return gs
}

// The snapshot holds the server's whole tree and the server's lists, under its own ten keys:
// every group, board, chat and branch state, archived ones included, and the defaults. It is the
// same for every client. No data folder is in it.
func TestAPISnapshot(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.a.Home, e.a.DefaultCwd = "/home/owner", "/home/owner/work"

	// A server with nothing on it: the lists, and empty lists of the tree, none of them null.
	empty := e.a.APISnapshot()
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(mustJSON(t, empty), &keys); err != nil {
		t.Fatal(err)
	}
	var names []string
	for k := range keys {
		names = append(names, k)
	}
	sort.Strings(names)
	if want := []string{"agents", "boards", "catalogs", "chats", "defaultCwd", "defaults", "groups", "home", "library", "states"}; !slices.Equal(names, want) {
		t.Fatalf("keys %v, want %v", names, want)
	}
	for _, k := range []string{"groups", "boards", "chats", "states"} {
		if string(keys[k]) != "[]" {
			t.Errorf("%s of a server with nothing on it: %s, want []", k, keys[k])
		}
	}
	if string(keys["agents"]) != `["claude","cursor","pi"]` {
		t.Errorf("agents: %s", keys["agents"])
	}

	if empty.Home != "/home/owner" || empty.DefaultCwd != "/home/owner/work" {
		t.Fatalf("lists %+v", empty)
	}
	if c := empty.Catalogs; len(c) != 3 || c[model.Claude] == nil || c[model.Cursor] != nil || c[model.Pi] != nil {
		t.Fatalf("catalogs before any was reported: %v", c)
	}
	// A catalog an agent reported is in the snapshot, as a copy.
	e.must(e.st.Update(func(s *model.State) error {
		s.Catalogs = map[model.AgentKind]*model.Catalog{model.Pi: {Models: []model.CatalogModel{{ID: "pi-one"}}}}
		return nil
	}))
	got := e.a.APISnapshot()
	if c := got.Catalogs[model.Pi]; c == nil || len(c.Models) != 1 || c.Models[0].ID != "pi-one" || !reflect.DeepEqual(got.Catalogs, e.a.APISnapshot().Catalogs) {
		t.Fatalf("catalogs after pi reported: %v", got.Catalogs)
	}
	got.Catalogs[model.Pi].Models = nil
	if c := e.a.APISnapshot().Catalogs[model.Pi]; len(c.Models) != 1 {
		t.Fatal("the snapshot's catalog is the store's own record")
	}

	// A tree: groups, one nested, one archived with what is in it; a board with a chat on it; plain chats, one of them started and one archived.
	work := e.group("Work")
	infra := e.subgroup("Infra", work)
	old := e.group("Old")
	loose := e.chat(model.Ungrouped, "")
	bd := e.board(infra)
	onBoard := e.chat("", bd)
	started := e.running(work, "")
	inOld := e.chat(old, "")
	gone := e.chat(model.Ungrouped, "")
	e.must(e.a.Archive(KindGroup, old))
	e.must(e.a.Archive(KindChat, gone))
	e.must(e.st.Update(func(s *model.State) error {
		defaults.RecordChange(&s.Defaults, work, model.Claude, "/home/owner/work/api", model.ModelChoice{Model: "sonnet", Effort: "high"})
		return nil
	}))

	x := e.a.APISnapshot()
	// What is in it, by name: the order of the groups, the nesting and the archive marks as the
	// server has them; every chat with one state per branch.
	var groups []string
	for _, g := range x.Groups {
		groups = append(groups, g.ID)
		switch g.ID {
		case work:
			if g.Parent != "" || g.Archived {
				t.Errorf("the group Work: %+v", g)
			}
		case infra:
			if g.Parent != work || g.Archived {
				t.Errorf("the group Infra: %+v", g)
			}
		case old:
			if !g.Archived || g.Op == "" {
				t.Errorf("the group Old: %+v", g)
			}
		}
	}
	if !slices.Equal(groups, []string{work, infra, old}) {
		t.Fatalf("groups %v, want %v", groups, []string{work, infra, old})
	}
	if len(x.Boards) != 1 || x.Boards[0].ID != bd || x.Boards[0].Group != infra {
		t.Fatalf("boards %+v", x.Boards)
	}
	chats, states := map[string]model.ChatView{}, map[string]int{}
	for _, c := range x.Chats {
		chats[c.ID] = c
	}
	for _, st := range x.States {
		states[st.Chat]++
	}
	for _, id := range []string{loose, onBoard, started, inOld, gone} {
		if _, has := chats[id]; !has || states[id] != 1 {
			t.Errorf("the chat %s: listed %v, %d states", id, has, states[id])
		}
	}
	if len(chats) != 5 || chats[onBoard].Board != bd || !chats[started].Locked || chats[started].Group != work ||
		!chats[inOld].Archived || !chats[gone].Archived || chats[loose].Archived {
		t.Fatalf("chats %+v", x.Chats)
	}
	if d := x.Defaults.Groups[work].Servers[model.LocalServer]; d.Cwd != "/home/owner/work/api" {
		t.Fatalf("the defaults of the group Work: %+v", x.Defaults.Groups[work])
	}
	// The defaults are a copy.
	x.Defaults.Groups[work] = model.GroupDefaults{}
	if d := e.a.APISnapshot().Defaults.Groups[work].Servers[model.LocalServer]; d.Cwd == "" {
		t.Fatal("the snapshot's defaults are the store's own record")
	}

	// No data folder, and no view says who made the thing.
	raw := mustJSON(t, e.a.APISnapshot())
	for _, s := range []string{`"dataDir"`, e.a.DataDir, `"client"`, `"origin"`, `"collapsed"`, `"servers":[`, `"sections"`} {
		if strings.Contains(string(raw), s) {
			t.Errorf("the snapshot holds %s: %s", s, raw)
		}
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
