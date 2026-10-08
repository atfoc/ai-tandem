package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/store"
)

// The chats of other servers in the snapshot and in the cascades of a group: a stand-in
// (loopback, TLS) is the other server, reached through a real servers.Manager and a real relay.

const (
	recA = "3a000000-0000-4000-8000-00000000000a"
	recB = "3b000000-0000-4000-8000-00000000000b"
	recC = "3c000000-0000-4000-8000-00000000000c"
)

// upCounter is the chat manager as the relay's Local, counting the snapshots the relay took.
type upCounter struct {
	*chats.Manager
	ups *atomic.Int64
}

func (l upCounter) ServerUp(entry string) {
	l.Manager.ServerUp(entry)
	l.ups.Add(1)
}

// seed is a record to start with: its chat as its server has it, and its place here. With run
// it is a run record (see remoterun_test.go), which needs an app with runs.
type seed struct {
	id, group string
	archived  bool // archived on its own server, by nobody here
	run       bool
}

// far is an env whose app has one entry "Studio" in its server list, the stand-in, and a relay
// with the records of the seeds.
type far struct {
	*env
	st    *standin.Server
	m     *servers.Manager
	entry string
	ups   atomic.Int64

	mu     sync.Mutex
	calls  []string       // "POST /api/chats/<id>/archive", … in the order the stand-in got them
	refuse map[string]int // such a call → the status it is refused with
}

func (e *env) far(seeds ...seed) *far {
	t := e.t
	t.Helper()
	f := &far{env: e, refuse: map[string]int{}}
	views, states := []model.ChatView{}, []model.BranchState{}
	var runSeeds []seed
	for _, s := range seeds {
		if s.run {
			runSeeds = append(runSeeds, s)
			continue
		}
		v := model.ChatView{ID: s.id, Agent: model.Claude, Name: "Chat " + s.id[:2], Group: "g_there", Cwd: "/home/standin/work",
			Model: "standin-model", Locked: true, Status: model.StatusReady}
		v.Archived = s.archived
		views, states = append(views, v), append(states, model.StateOf(s.id, "main", v))
	}
	snap := standin.DefaultSnapshot()
	snap["chats"], snap["states"] = views, states
	snap["runs"] = runViews(runSeeds)
	f.st = standin.Start(t, standin.Options{Snapshot: snap})
	for _, pat := range []string{"POST /api/chats/{id}/archive", "POST /api/chats/{id}/unarchive", "DELETE /api/chats/{id}",
		"POST /api/runs/{id}/archive", "POST /api/runs/{id}/unarchive", "DELETE /api/runs/{id}"} {
		f.st.Handle(pat, func(w http.ResponseWriter, r *http.Request) {
			call := r.Method + " " + r.URL.Path
			f.mu.Lock()
			f.calls = append(f.calls, call)
			status := f.refuse[call]
			f.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			if status != 0 {
				w.WriteHeader(status)
				json.NewEncoder(w).Encode(map[string]string{"error": "refused there"})
				return
			}
			w.Write([]byte(`{"ok":true}`))
		})
	}

	root := t.TempDir()
	const limit = 3 * time.Second
	m, err := servers.Open(servers.Options{Root: root, LocalID: "11111111-2222-4333-8444-555555555555", Version: "test",
		Notify: e.a.Bridge.Broadcast, Timing: servers.Timing{
			Dial: limit, Handshake: limit, Headers: limit, Hello: limit, FirstEvent: limit, Call: limit, TestStep: limit, Silence: limit,
			Backoff: []time.Duration{20 * time.Millisecond, 40 * time.Millisecond}, Jitter: -1,
		}})
	if err != nil {
		t.Fatal(err)
	}
	v, saved, _, err := m.Add(context.Background(), servers.Input{
		Name: "Studio", Address: f.st.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: f.st.Fingerprint(),
	}, true)
	if err != nil || !saved {
		t.Fatalf("the entry is not saved: %v", err)
	}
	f.m, f.entry = m, v.ID
	paths := store.NewPaths(root)
	e.must(os.MkdirAll(paths.RemoteChats, 0o700))
	i := 0
	for _, s := range seeds {
		if s.run {
			continue
		}
		rec := remotes.Record{ID: s.id, Entry: f.entry, Group: s.group, Archived: s.archived, View: views[i], States: states[i : i+1]}
		raw, _ := json.Marshal(rec)
		e.must(os.WriteFile(paths.RemoteChatFile(s.id), raw, 0o600))
		i++
	}
	var local remotes.LocalRuns // the run service, when the app has one
	if e.a.Runs != nil {
		local = e.a.Runs
	} else if len(runSeeds) > 0 {
		t.Fatal("a run record needs an app with runs")
	}
	e.must(os.MkdirAll(paths.RemoteRuns, 0o700))
	for i, v := range runViews(runSeeds) {
		rec := remotes.RunRecord{ID: v.ID, Entry: f.entry, Group: runSeeds[i].group, Archived: v.Archived, View: v}
		raw, _ := json.Marshal(rec)
		e.must(os.WriteFile(paths.RemoteRunFile(v.ID), raw, 0o600))
	}
	rm, err := remotes.Open(remotes.Options{Root: root, Servers: m, Bridge: e.a.Bridge, Local: upCounter{e.a.Chats, &f.ups},
		Group: e.a.GroupState, Runs: local, Limits: remotes.Limits{Flush: 20 * time.Millisecond}, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	if e.a.Runs != nil {
		e.a.Runs.Remote = rm
	}
	e.a.Chats.Servers = rm
	e.a.Servers, e.a.Remotes = m, rm
	m.SetHooks(rm.Hooks())
	t.Cleanup(func() { // the order of a shutdown
		m.Close()
		rm.Close()
	})
	m.Start()
	f.wait("the first snapshot is taken", func() bool { return f.ups.Load() >= 1 })
	return f
}

func (f *far) wait(what string, good func() bool) {
	f.t.Helper()
	for end := time.Now().Add(10 * time.Second); !good(); time.Sleep(2 * time.Millisecond) {
		if time.Now().After(end) {
			f.t.Fatalf("waited in vain: %s", what)
		}
	}
}

// down stops the stand-in and waits until the entry is no longer connected.
func (f *far) down() {
	f.t.Helper()
	f.st.Stop()
	f.wait("the entry is not connected", func() bool {
		v, _ := f.m.View(f.entry)
		return v.State != servers.StateConnected
	})
}

// rec is the record's view; ok is false when there is no such record.
func (f *far) rec(id string) (model.ChatView, bool) {
	for _, v := range f.a.Remotes.Views() {
		if v.ID == id {
			return v, true
		}
	}
	return model.ChatView{}, false
}

// sent are the calls the stand-in got since the last call of sent, sorted.
func (f *far) sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.calls
	f.calls = nil
	sort.Strings(out)
	return out
}

func (f *far) refuseWith(call string, status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refuse[call] = status
}

func chatCall(method, id, rest string) string { return method + " /api/chats/" + id + rest }

// The snapshot of a page has these keys, "lists" among them; without a relay the lists are an
// empty object and the chats are this server's own.
func TestSnapshotKeys(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.chat(model.Ungrouped, "")
	var keys map[string]json.RawMessage
	e.must(json.Unmarshal(mustJSON(t, e.a.Snapshot()), &keys))
	var names []string
	for k := range keys {
		names = append(names, k)
	}
	sort.Strings(names)
	want := []string{"agents", "boards", "catalogs", "chats", "dataDir", "defaultCwd", "defaults", "groups", "home", "lists", "runs", "servers", "states"}
	if !slices.Equal(names, want) {
		t.Fatalf("keys %v, want %v", names, want)
	}
	if string(keys["lists"]) != "{}" || len(e.a.Snapshot().Chats) != 1 {
		t.Fatalf("lists %s, %d chats", keys["lists"], len(e.a.Snapshot().Chats))
	}
}

// With a relay the snapshot holds the entry's lists, and the records with their states among
// the chats. An id that is a record's and a chat's of this server, as it is for a moment while
// a chat starts on its server, is listed once: as the record.
func TestSnapshotWithRecords(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	g := e.group("G")
	own := e.chat(g, "")
	f := e.far(seed{id: recA, group: g}, seed{id: recB, group: model.Ungrouped})
	if _, err := e.a.Chats.CreateChat(chats.NewChat{ID: recB, Agent: model.Claude, Group: g}); err != nil {
		t.Fatal(err)
	}
	if len(e.a.Chats.Views()) != 2 {
		t.Fatalf("the chat manager has %d chats, want 2", len(e.a.Chats.Views()))
	}

	snap := e.a.Snapshot()
	l, ok := snap.Lists[f.entry]
	if len(snap.Lists) != 1 || !ok || !slices.Equal(l.Agents, []model.AgentKind{model.Claude, model.Pi}) || l.Home != "/home/standin" || l.DefaultCwd != "/home/standin/work" {
		t.Fatalf("lists: %+v", snap.Lists)
	}
	chatsByID := map[string][]model.ChatView{}
	for _, c := range snap.Chats {
		chatsByID[c.ID] = append(chatsByID[c.ID], c)
	}
	if len(snap.Chats) != 3 || len(chatsByID[own]) != 1 || chatsByID[own][0].Server != "" ||
		len(chatsByID[recA]) != 1 || chatsByID[recA][0].Server != f.entry || chatsByID[recA][0].Group != g || !chatsByID[recA][0].Locked ||
		len(chatsByID[recB]) != 1 || chatsByID[recB][0].Server != f.entry || chatsByID[recB][0].Group != model.Ungrouped {
		t.Fatalf("chats: %+v", snap.Chats)
	}
	states := map[string]int{}
	for _, st := range snap.States {
		states[st.Chat+"/"+st.Branch]++
	}
	if len(states) != 3 || states[own+"/main"] != 1 || states[recA+"/main"] != 1 || states[recB+"/main"] != 1 {
		t.Fatalf("states: %v", states)
	}
	// An API client's snapshot holds no record and no lists of another server.
	api := mustJSON(t, e.a.APISnapshot("0e5ac1f3-6d2b-4b7a-8f10-9a1b2c3d4e5f"))
	for _, s := range []string{recA, recB, `"lists"`, "standin", f.entry} {
		if strings.Contains(string(api), s) {
			t.Errorf("the API snapshot holds %s: %s", s, api)
		}
	}
	if raw := mustJSON(t, snap); strings.Contains(string(raw), standin.DefaultSecret) {
		t.Fatalf("the snapshot holds the entry's secret: %s", raw)
	}

	// GroupState is what the relay asks before it moves a record.
	e.must(e.a.Archive(KindGroup, e.group("Old")))
	old := e.named("Old")[0]
	for id, want := range map[string][2]bool{g: {true, false}, old: {true, true}, "g_none": {false, false}, "": {false, false}} {
		if exists, archived := e.a.GroupState(id); exists != want[0] || archived != want[1] {
			t.Errorf("GroupState(%q) = %v, %v", id, exists, archived)
		}
	}
}

// A group's archive archives the records in it and below it that are not archived, with the
// group's action, and fails for none; its unarchive brings back exactly those. A record that was
// archived on its own server belongs to no action here and stays as it is (AC33).
func TestArchiveGroupWithRecords(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	g := e.group("G")
	sub := e.subgroup("Sub", g)
	own := e.chat(g, "")
	f := e.far(seed{id: recA, group: g}, seed{id: recB, group: sub}, seed{id: recC, group: g, archived: true},
		seed{id: "3d000000-0000-4000-8000-00000000000d", group: model.Ungrouped})
	outside := "3d000000-0000-4000-8000-00000000000d"
	f.sent()

	e.must(e.a.Archive(KindGroup, g))
	ga := e.groupArchive(g)
	a, _ := f.rec(recA)
	b, _ := f.rec(recB)
	c, _ := f.rec(recC)
	o, _ := f.rec(outside)
	if !ga.Archived || a.Archive != ga || b.Archive != ga || e.chatArchive(own) != ga || e.groupArchive(sub) != ga {
		t.Fatalf("after the archive: group %+v, records %+v and %+v", ga, a.Archive, b.Archive)
	}
	if !c.Archived || c.Op != "" || o.Archived {
		t.Fatalf("the record archived there %+v, the one outside %+v", c.Archive, o.Archive)
	}
	if got, want := f.sent(), []string{chatCall("POST", recA, "/archive"), chatCall("POST", recB, "/archive")}; !slices.Equal(got, want) {
		t.Fatalf("the stand-in got %v, want %v", got, want)
	}
	if got := e.a.Remotes.ArchivedWith(ga.Op); !slices.Equal(got, []string{recA, recB}) {
		t.Fatalf("archived with the group's action: %v", got)
	}

	e.must(e.a.Unarchive(KindGroup, g))
	a, _ = f.rec(recA)
	b, _ = f.rec(recB)
	c, _ = f.rec(recC)
	if a.Archived || b.Archived || !c.Archived || e.chatArchive(own).Archived || e.groupArchive(g).Archived || e.groupArchive(sub).Archived {
		t.Fatalf("after the unarchive: %+v, %+v, %+v", a.Archive, b.Archive, c.Archive)
	}
	if got, want := f.sent(), []string{chatCall("POST", recA, "/unarchive"), chatCall("POST", recB, "/unarchive")}; !slices.Equal(got, want) {
		t.Fatalf("the stand-in got %v, want %v", got, want)
	}

	// A server that refuses one chat's archive does not stop the group's: that chat stays as it
	// is, the rest is archived.
	f.refuseWith(chatCall("POST", recB, "/archive"), http.StatusConflict)
	e.must(e.a.Archive(KindGroup, g))
	a, _ = f.rec(recA)
	b, _ = f.rec(recB)
	if !e.groupArchive(g).Archived || !a.Archived || b.Archived || !e.chatArchive(own).Archived {
		t.Fatalf("after an archive one chat's server refused: %+v, %+v", a.Archive, b.Archive)
	}
	e.must(e.a.Unarchive(KindGroup, g))
	f.refuseWith(chatCall("POST", recB, "/archive"), 0)
	f.sent()

	// A server that is away does not stop it either: the marks show, and are passed on when it
	// is back. A record moved out of the group while archived stays archived at the unarchive.
	f.down()
	e.must(e.a.Archive(KindGroup, g))
	a, _ = f.rec(recA)
	b, _ = f.rec(recB)
	if ga = e.groupArchive(g); !ga.Archived || a.Archive != ga || b.Archive != ga {
		t.Fatalf("after an archive with the server away: %+v, %+v", a.Archive, b.Archive)
	}
	f.st.Restart()
	f.wait("the archives are passed on", func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		return slices.Contains(f.calls, chatCall("POST", recA, "/archive")) && slices.Contains(f.calls, chatCall("POST", recB, "/archive"))
	})
	e.must(e.a.Remotes.Move(recB, model.Ungrouped))
	e.must(e.a.Unarchive(KindGroup, g))
	a, _ = f.rec(recA)
	b, _ = f.rec(recB)
	if a.Archived || !b.Archived || b.Op != ga.Op {
		t.Fatalf("after the unarchive: %+v, and the record that was moved away %+v", a.Archive, b.Archive)
	}
}

// The unarchive of one record brings back the archived groups it is nested in, as that of a
// chat of this server does, and nothing else in them.
func TestUnarchiveRecordBringsBackItsGroups(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	g := e.group("G")
	sub := e.subgroup("Sub", g)
	own := e.chat(g, "")
	f := e.far(seed{id: recA, group: sub}, seed{id: recB, group: g})
	e.must(e.a.Archive(KindGroup, g))

	e.must(e.a.UnarchiveRecord(context.Background(), recA))
	a, _ := f.rec(recA)
	b, _ := f.rec(recB)
	if a.Archived || !b.Archived || e.groupArchive(g).Archived || e.groupArchive(sub).Archived || !e.chatArchive(own).Archived {
		t.Fatalf("after the unarchive of one record: %+v, %+v, groups %+v %+v", a.Archive, b.Archive, e.groupArchive(g), e.groupArchive(sub))
	}
	// The user's own archive of one record is an action of its own.
	e.must(e.a.ArchiveRecord(context.Background(), recA))
	if a, _ = f.rec(recA); !a.Archived || a.Op == "" || a.Op == b.Op || e.groupArchive(sub).Archived {
		t.Fatalf("after the archive of one record: %+v", a.Archive)
	}
	// No record with the id.
	for _, err := range []error{e.a.ArchiveRecord(context.Background(), own), e.a.UnarchiveRecord(context.Background(), own)} {
		if !errors.Is(err, chats.ErrNotFound) {
			t.Errorf("a chat of this server as a record: %v", err)
		}
	}
	// The chat routes of this server do not reach a record: an API client calls them too.
	if err := e.a.Archive(KindChat, recB); !errors.Is(err, chats.ErrNotFound) {
		t.Errorf("Archive(KindChat) of a record: %v", err)
	}
	if err := e.a.Unarchive(KindChat, recB); !errors.Is(err, chats.ErrNotFound) {
		t.Errorf("Unarchive(KindChat) of a record: %v", err)
	}
	if b, _ = f.rec(recB); !b.Archived {
		t.Error("the record was unarchived through the route of this server's chats")
	}
}

// The delete of a group with its contents deletes the chats of its records on their servers
// first, then what is this server's; without its contents the records move up (AC33).
func TestDeleteGroupWithRecords(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	top := e.group("Top")
	g := e.subgroup("G", top)
	sub := e.subgroup("Sub", g)
	own := e.chat(g, "")
	f := e.far(seed{id: recA, group: g}, seed{id: recB, group: sub}, seed{id: recC, group: top})

	// A chat that cannot be deleted there: nothing of this server is deleted.
	f.refuseWith(chatCall("DELETE", recA, ""), http.StatusInternalServerError)
	err := e.a.DeleteGroup(g, true)
	var re *remotes.Error
	if !errors.As(err, &re) || re.Status != http.StatusInternalServerError {
		t.Fatalf("a delete one server refused: %v", err)
	}
	if _, err := e.a.Chats.View(own); err != nil {
		t.Fatalf("this server's chat after the refused delete: %v", err)
	}
	if _, ok := f.rec(recA); !ok || len(e.named("G")) != 1 || len(e.named("Sub")) != 1 {
		t.Fatal("something was deleted although the first record's server refused")
	}
	f.refuseWith(chatCall("DELETE", recA, ""), 0)
	f.sent()

	// Without the contents: the group's records move to its parent, and nothing is sent.
	e.must(e.a.DeleteGroup(sub, false))
	if b, _ := f.rec(recB); b.Group != g || len(f.sent()) != 0 || len(e.named("Sub")) != 0 {
		t.Fatalf("after the delete of the subgroup alone: the record is in %q", b.Group)
	}

	// With the contents: the chats are deleted there, the records go, then the rest.
	e.must(e.a.DeleteGroup(g, true))
	if got, want := f.sent(), []string{chatCall("DELETE", recA, ""), chatCall("DELETE", recB, "")}; !slices.Equal(got, want) {
		t.Fatalf("the stand-in got %v, want %v", got, want)
	}
	_, hasA := f.rec(recA)
	_, hasB := f.rec(recB)
	if _, err := e.a.Chats.View(own); hasA || hasB || !errors.Is(err, chats.ErrNotFound) || len(e.named("G")) != 0 {
		t.Fatalf("after the delete: records %v %v, the chat %v", hasA, hasB, err)
	}
	// A top-level group without its contents: its records are ungrouped.
	e.must(e.a.DeleteGroup(top, false))
	if c, ok := f.rec(recC); !ok || c.Group != model.Ungrouped || len(f.sent()) != 0 {
		t.Fatalf("after the delete of the top group alone: %+v, %v", c, ok)
	}
}

// While the server of one record is not connected, the delete of a group with its contents
// deletes nothing: not the chats of the servers that are connected, and nothing here.
func TestDeleteGroupWithAServerAway(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	g := e.group("G")
	sub := e.subgroup("Sub", g)
	own := e.chat(sub, "")
	b := e.board(g)
	f := e.far(seed{id: recA, group: sub})
	f.down()

	err := e.a.DeleteGroup(g, true)
	var re *remotes.Error
	if !errors.As(err, &re) || re.Status != http.StatusConflict || re.Code != "server_unreachable" ||
		re.Text != "Nothing was deleted: “Chat 3a” is on Studio, which is not connected." || !errors.Is(err, remotes.ErrUnreachable) {
		t.Fatalf("the delete: %v", err)
	}
	if _, err := e.a.Chats.View(own); err != nil {
		t.Fatalf("this server's chat: %v", err)
	}
	if _, ok := e.a.Boards.Get(b); !ok || len(e.named("G")) != 1 || len(e.named("Sub")) != 1 {
		t.Fatal("something of this server was deleted")
	}
	if _, ok := f.rec(recA); !ok {
		t.Fatal("the record was deleted")
	}
	// Without the contents nothing is asked of the server: the record moves up.
	e.must(e.a.DeleteGroup(sub, false))
	if a, _ := f.rec(recA); a.Group != g {
		t.Fatalf("the record is in %q after its group was deleted alone", a.Group)
	}
	// A record whose chat is gone there stands in nobody's way; here the server is back and
	// has the chat no more.
	f.st.SetSnapshot(standin.DefaultSnapshot())
	f.st.Restart()
	f.wait("the record is gone", func() bool { a, _ := f.rec(recA); return a.Gone })
	f.sent()
	e.must(e.a.DeleteGroup(g, true))
	if _, ok := f.rec(recA); ok || len(f.sent()) != 0 || len(e.named("G")) != 0 {
		t.Fatal("after the delete with a gone record: the record or the group is there, or the server was asked")
	}
}
