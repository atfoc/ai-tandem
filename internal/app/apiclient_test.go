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
	"ai-whiteboard/internal/servers"
)

// groups is the state's group list.
func (e *env) groups() []model.Group {
	var gs []model.Group
	e.st.Read(func(s *model.State) { gs = append(gs, s.Groups...) })
	return gs
}

// The API snapshot holds the server's whole tree and the server's lists, under its own eleven
// keys: every group, board, chat, branch state and run, archived ones included, as the page's
// snapshot has them, and the defaults. It is the same for every client. Nothing of the servers
// this one connects to is in it, and no data folder.
func TestAPISnapshot(t *testing.T) {
	t.Parallel()
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
	if want := []string{"agents", "boards", "catalogs", "chats", "defaultCwd", "defaults", "groups", "home", "library", "runs", "states"}; !slices.Equal(names, want) {
		t.Fatalf("keys %v, want %v", names, want)
	}
	for _, k := range []string{"groups", "boards", "chats", "states", "runs"} {
		if string(keys[k]) != "[]" {
			t.Errorf("%s of a server with nothing on it: %s, want []", k, keys[k])
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
	got := e.a.APISnapshot()
	if c := got.Catalogs[model.Pi]; c == nil || len(c.Models) != 1 || c.Models[0].ID != "pi-one" || !reflect.DeepEqual(got.Catalogs, e.a.Snapshot().Catalogs) {
		t.Fatalf("catalogs after pi reported: %v", got.Catalogs)
	}
	got.Catalogs[model.Pi].Models = nil
	if c := e.a.APISnapshot().Catalogs[model.Pi]; len(c.Models) != 1 {
		t.Fatal("the snapshot's catalog is the store's own record")
	}

	// A tree: groups, one nested, one archived with what is in it and one shown collapsed; a
	// board with a chat on it; plain chats, one of them started and one archived.
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
	collapsed := true
	e.must(e.a.UpdateGroup(work, nil, &collapsed))
	e.must(e.st.Update(func(s *model.State) error {
		defaults.RecordChange(&s.Defaults, work, model.Claude, "/home/owner/work/api", model.ModelChoice{Model: "sonnet", Effort: "high"})
		return nil
	}))

	x := e.a.APISnapshot()
	page = e.a.Snapshot()
	byID := func(bs []model.Board) []model.Board {
		bs = slices.Clone(bs)
		sort.Slice(bs, func(i, j int) bool { return bs[i].ID < bs[j].ID })
		return bs
	}
	for what, same := range map[string]bool{
		"groups":   reflect.DeepEqual(x.Groups, page.Groups),
		"defaults": reflect.DeepEqual(x.Defaults, page.Defaults),
		"boards":   reflect.DeepEqual(byID(x.Boards), byID(page.Boards)),
		"chats":    reflect.DeepEqual(x.Chats, page.Chats),
		"states":   reflect.DeepEqual(x.States, page.States),
		"runs":     reflect.DeepEqual(x.Runs, page.Runs),
	} {
		if !same {
			t.Errorf("%s of the API snapshot are not the page's:\nAPI  %s\npage %s", what, mustJSON(t, x), mustJSON(t, page))
		}
	}
	// What is in it, by name: the order of the groups, the nesting, the archive marks and the
	// collapse as the server has them; every chat with one state per branch.
	var groups []string
	for _, g := range x.Groups {
		groups = append(groups, g.ID)
		switch g.ID {
		case work:
			if g.Parent != "" || !g.Collapsed || g.Archived {
				t.Errorf("the group Work: %+v", g)
			}
		case infra:
			if g.Parent != work || g.Collapsed || g.Archived {
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

	// Nothing of the page's snapshot beyond the eleven keys: no data folder, no server list, no
	// lists or libraries of other servers, no sections, and no value of them either. No view
	// says who made the thing.
	raw := mustJSON(t, e.a.APISnapshot())
	for _, s := range []string{`"dataDir"`, `"servers":[`, `"lists"`, `"libraries"`, `"sections"`, e.a.DataDir,
		"Studio", "https://127.0.0.1:1", pin, "not-for-a-client", `"client"`, `"origin"`} {
		if strings.Contains(string(raw), s) {
			t.Errorf("the API snapshot holds %s: %s", s, raw)
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
