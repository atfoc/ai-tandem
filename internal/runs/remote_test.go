package runs

import (
	"errors"
	"fmt"
	"os"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// These tests are of a draft run that will start on another server (remote.go), with a fake of
// the other servers: nothing of them is on a disk of the test's.

// The two other servers: Bee can use Claude and Cursor and has a list of models for both; Sea can
// use pi and has reported no list.
const (
	remB, remKeyB = "s_bbbbbbbb", "inst-bee"
	remC, remKeyC = "s_cccccccc", "inst-sea"
	remWork       = "/home/bee/work" // folders that are on no disk of the test's
	remProj       = "/home/bee/proj"
	remApp        = "/srv/far/app"
	remGroup      = "g_far"
)

var (
	remClaude = &model.Catalog{
		Models: []model.CatalogModel{
			{ID: "far-opus-9", Efforts: []string{"low", "medium", "high"}, DefaultEffort: "medium"},
			{ID: "far-sonnet-9", Efforts: []string{"medium"}, DefaultEffort: "medium"},
		},
		Default: model.ModelChoice{Model: "far-sonnet-9", Effort: "medium"},
	}
	remCursor = &model.Catalog{
		Models: []model.CatalogModel{
			{ID: "far-gpt"},
			{ID: "far-gpt-mini", Efforts: []string{"low", "high"}, DefaultEffort: "low"},
		},
		Default: model.ModelChoice{Model: "far-gpt-mini", Effort: "low"},
	}
	// What a new run of Claude on Bee runs on when nothing was recorded.
	remClaudeTiers = model.RunTiers{Deep: model.ModelChoice{Model: "far-opus-9", Effort: "high"},
		Standard: model.ModelChoice{Model: "far-opus-9", Effort: "medium"}, Light: model.ModelChoice{Model: "far-sonnet-9", Effort: "medium"}}
	// And one of Cursor: its catalogue names no opus model, so the base is the catalogue's default.
	remCursorTiers = model.RunTiers{Deep: model.ModelChoice{Model: "far-gpt-mini", Effort: "high"},
		Standard: model.ModelChoice{Model: "far-gpt-mini", Effort: "low"}, Light: model.ModelChoice{Model: "far-gpt-mini", Effort: "low"}}
)

// fakeRemote is the other servers of a test: the entries of the list, what the draft check of
// each answers, and what the service asked.
type fakeRemote struct {
	mu      sync.Mutex
	entries map[string]chats.RemoteEntry
	folders map[string]DraftFacts // by "entry folder"; a folder that is not named is missing
	fails   map[string]error      // by entry: what its draft check fails with
	asked   []string              // "entry agent folder" of every draft check, in order
	hold    chan struct{}         // the next draft check waits until it is closed
	waiting chan string           // gets every draft check that waits
	infos   map[string]chats.RunInfo
	dropped []string
	onDrop  func(entry, run string)
	busy    map[string]bool // the runs whose start is being made right now
}

func newFakeRemote() *fakeRemote {
	return &fakeRemote{
		entries: map[string]chats.RemoteEntry{
			remB: {ID: remB, Name: "Bee", Key: remKeyB, Connected: true, HasLists: true,
				Agents:   []model.AgentKind{model.Claude, model.Cursor},
				Catalogs: map[model.AgentKind]*model.Catalog{model.Claude: remClaude, model.Cursor: remCursor},
				Home:     "/home/bee", DefaultCwd: remWork},
			remC: {ID: remC, Name: "Sea", Key: remKeyC, Connected: true, HasLists: true,
				Agents: []model.AgentKind{model.Pi}, Home: "/home/sea", DefaultCwd: "/home/sea"},
		},
		folders: map[string]DraftFacts{
			remB + " " + remWork:     {Cwd: remWork},
			remB + " ~/proj":         {Cwd: remProj, Git: true, Dirty: true},
			remB + " " + remProj:     {Cwd: remProj, Git: true, Dirty: true},
			remB + " " + remApp:      {Cwd: remApp, Git: true},
			remC + " /home/sea":      {Cwd: "/home/sea"},
			remC + " ~/proj":         {Cwd: "/home/sea/proj", Git: true},
			remC + " /home/sea/proj": {Cwd: "/home/sea/proj", Git: true},
		},
		fails:   map[string]error{},
		waiting: make(chan string, 16),
		infos:   map[string]chats.RunInfo{},
	}
}

func (f *fakeRemote) Entry(id string) (chats.RemoteEntry, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e, ok := f.entries[id]
	return e, ok
}

func (f *fakeRemote) ByKey(key string) (chats.RemoteEntry, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, e := range f.entries {
		if e.Key == key && key != "" {
			return e, true
		}
	}
	return chats.RemoteEntry{}, false
}

func (f *fakeRemote) CheckDraft(entry string, a model.AgentKind, cwd string) (DraftFacts, error) {
	call := fmt.Sprintf("%s %s %s", entry, a, cwd)
	f.mu.Lock()
	f.asked = append(f.asked, call)
	hold := f.hold
	f.hold = nil
	f.mu.Unlock()
	if hold != nil {
		f.waiting <- call
		<-hold
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch e, ok := f.entries[entry]; {
	case !ok || !e.Connected:
		return DraftFacts{}, chats.ErrServerUnreachable
	case f.fails[entry] != nil:
		return DraftFacts{}, f.fails[entry]
	}
	if facts, ok := f.folders[entry+" "+cwd]; ok {
		if a == "" && facts.Blocked == "" {
			facts.Blocked = "No agent can be used on this server: install one."
		}
		return facts, nil
	}
	return DraftFacts{Cwd: cwd, FolderMissing: true}, nil
}

func (f *fakeRemote) RunInfo(run string) (chats.RunInfo, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ri, ok := f.infos[run]
	return ri, ok
}

func (f *fakeRemote) Starting(id string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.busy[id]
}

// starting sets whether the start of the run id is being made right now.
func (f *fakeRemote) starting(id string, on bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.busy == nil {
		f.busy = map[string]bool{}
	}
	f.busy[id] = on
}

func (f *fakeRemote) DropRun(entry, run string) {
	f.mu.Lock()
	f.dropped = append(f.dropped, entry+" "+run)
	on := f.onDrop
	f.mu.Unlock()
	if on != nil {
		on(entry, run)
	}
}

// change changes the entry id of the list.
func (f *fakeRemote) change(id string, g func(e *chats.RemoteEntry)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.entries[id]
	g(&e)
	f.entries[id] = e
}

// checks returns the draft checks made since it was last called.
func (f *fakeRemote) checks() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := f.asked
	f.asked = nil
	return out
}

// holdNext makes the next draft check wait; the returned function lets it go.
func (f *fakeRemote) holdNext() (release func()) {
	ch := make(chan struct{})
	f.mu.Lock()
	f.hold = ch
	f.mu.Unlock()
	return func() { close(ch) }
}

// awaitCheck returns the draft check that waits.
func (f *fakeRemote) awaitCheck(t testing.TB) string {
	t.Helper()
	select {
	case call := <-f.waiting:
		return call
	case <-time.After(5 * time.Second):
		t.Fatal("no draft check was made")
		return ""
	}
}

// remEnv is a svcEnv whose Service knows the other servers of fakeRemote, and has the group
// remGroup.
type remEnv struct {
	*svcEnv
	far *fakeRemote
}

func newRemEnv(t testing.TB) *remEnv {
	t.Helper()
	e := &remEnv{svcEnv: newSvcEnv(t), far: newFakeRemote()}
	e.s.Remote = e.far
	svcGroupAdd(t, e.s, model.Group{ID: remGroup, Name: "Far"})
	return e
}

// restart is a server restart with the same other servers (remote nil: with none).
func (e *remEnv) restart(remote Remote) {
	e.t.Helper()
	e.boot()
	e.wire()
	e.s.Remote = remote
	if err := e.s.Load(); err != nil {
		e.t.Fatal(err)
	}
}

// defaults changes the sticky defaults.
func (e *remEnv) defaults(change func(g map[string]model.GroupDefaults)) {
	e.t.Helper()
	if err := e.s.Store.Update(func(st *model.State) error {
		if st.Defaults.Groups == nil {
			st.Defaults.Groups = map[string]model.GroupDefaults{}
		}
		change(st.Defaults.Groups)
		return nil
	}); err != nil {
		e.t.Fatal(err)
	}
}

func (e *remEnv) groupDefaults(g string) model.GroupDefaults {
	var out model.GroupDefaults
	e.s.Store.Read(func(st *model.State) {
		b := st.Defaults.Groups[g]
		out = model.GroupDefaults{Server: b.Server, Servers: map[string]model.ServerDefaults{}}
		for k, v := range b.Servers {
			out.Servers[k] = v
		}
	})
	return out
}

// on makes a draft on Bee as a start there would find it: Claude, Bee's default tiers, the folder
// remWork. change may change its run.json before it is written.
func (e *remEnv) on(id string, change func(m *model.RunMeta)) *run {
	e.t.Helper()
	meta := model.RunMeta{ID: id, Name: DefaultName, Group: remGroup, Created: e.clock.Now(), Agent: model.Claude,
		Tiers: remClaudeTiers, Cwd: remWork, Settings: model.DefaultRunSettings(), Server: remB}
	if change != nil {
		change(&meta)
	}
	if err := writeMeta(e.s.Store.P.RunDir(id), meta); err != nil {
		e.t.Fatal(err)
	}
	r := newRun(e.s, meta)
	e.s.add(r)
	return r
}

func (e *remEnv) patch(id string, p PatchReq) model.RunView {
	e.t.Helper()
	v, err := e.s.Patch(id, p)
	if err != nil {
		e.t.Fatalf("Patch %+v: %v", p, err)
	}
	return v
}

func (e *remEnv) view(id string) model.RunView {
	e.t.Helper()
	v, err := e.s.View(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return v
}

// quiet waits for the draft checks ServerUp makes in the background.
func (e *remEnv) quiet() { e.s.asks.Wait() }

// ---- AC31: the sticky server ---------------------------------------------------------------------

// "New run" in a group whose sticky server is an entry's makes the draft on that entry, with
// that server's lists and its part of the defaults; nothing is checked on this computer and that
// server is asked nothing.
func TestRemoteCreateOnTheStickyServer(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	e.s.Agents = svcAgents(map[string]bool{}) // this computer can use no agent
	was := tiersAll("far-gpt", "")
	e.defaults(func(g map[string]model.GroupDefaults) {
		g[remGroup] = model.GroupDefaults{Server: remKeyB, Servers: map[string]model.ServerDefaults{
			remKeyB: {Cwd: remApp, ByAgent: map[model.AgentKind]model.ModelChoice{model.Cursor: {Model: "far-gpt-mini", Effort: "high"}},
				Run: &model.RunDefaults{Agent: model.Cursor, MaxParallel: 7, MaxTurns: 40, MaxCost: 12.5, Setup: "make deps", SetupCwd: remApp, Tiers: &was}},
			model.LocalServer: {Cwd: e.cwd, Run: &model.RunDefaults{Agent: model.Claude, MaxParallel: 2, MaxTurns: 9, Setup: "local", SetupCwd: e.cwd}},
		}}
	})
	v, err := e.s.Create(remGroup, "")
	if err != nil {
		t.Fatal(err)
	}
	want := model.DefaultRunSettings()
	want.MaxParallel, want.MaxTurns, want.MaxCost, want.Setup = 7, 40, 12.5, "make deps"
	if v.Server != remB || v.Agent != model.Cursor || v.Tiers != was || v.Cwd != remApp || v.Settings != want {
		t.Fatalf("the new run: %+v", v)
	}
	if v.FolderMissing || v.Blocked != "" || v.Start != "" {
		t.Errorf("a folder that is only there: missing %v, blocked %q, start %q", v.FolderMissing, v.Blocked, v.Start)
	}
	if v.TierDefaults == nil || *v.TierDefaults != remCursorTiers {
		t.Errorf("the tier defaults: %+v", v.TierDefaults)
	}
	r, _ := e.s.run(v.ID)
	if m := svcMetaOnDisk(t, r); m.Server != remB || m.Cwd != remApp || m.Agent != model.Cursor {
		t.Errorf("run.json: %+v", m)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("Create asked %v", got)
	}

	// Nothing recorded for Bee in the group: the first agent of Bee's list, its default tiers
	// from Bee's catalogue, Bee's default folder, the default limits.
	e.defaults(func(g map[string]model.GroupDefaults) { g[remGroup] = model.GroupDefaults{Server: remKeyB} })
	v, err = e.s.Create(remGroup, "Named")
	if err != nil {
		t.Fatal(err)
	}
	if v.Server != remB || v.Agent != model.Claude || v.Tiers != remClaudeTiers || v.Cwd != remWork || v.Settings != model.DefaultRunSettings() || v.Name != "Named" {
		t.Fatalf("a new run with nothing recorded: %+v", v)
	}

	// An agent Bee's list lacks is replaced by its first; tiers whose model Bee's catalogue
	// lacks are replaced by the defaults; a set-up command of another folder is not taken.
	gone := tiersAll("sonnet", "")
	e.defaults(func(g map[string]model.GroupDefaults) {
		g[remGroup] = model.GroupDefaults{Server: remKeyB, Servers: map[string]model.ServerDefaults{
			remKeyB: {Run: &model.RunDefaults{Agent: model.Pi, MaxParallel: 3, MaxTurns: 20, Setup: "x", SetupCwd: "/elsewhere", Tiers: &gone}}}}
	})
	if v, err = e.s.Create(remGroup, ""); err != nil || v.Agent != model.Claude || v.Tiers != remClaudeTiers || v.Settings.Setup != "" || v.Settings.MaxParallel != 3 {
		t.Fatalf("a new run after one of pi: %+v %v", v, err)
	}
	e.defaults(func(g map[string]model.GroupDefaults) {
		g[remGroup] = model.GroupDefaults{Server: remKeyB, Servers: map[string]model.ServerDefaults{
			remKeyB: {Run: &model.RunDefaults{Agent: model.Claude, MaxParallel: 3, MaxTurns: 20, Tiers: &gone}}}}
	})
	if v, err = e.s.Create(remGroup, ""); err != nil || v.Agent != model.Claude || v.Tiers != remClaudeTiers {
		t.Fatalf("a new run after one on models Bee lacks: %+v %v", v, err)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("Create asked %v", got)
	}
}

// A sticky key of no entry, or of an entry that waits for the user, falls back to this computer;
// so does everything while the service knows no other servers.
func TestRemoteCreateFallsBackToThisComputer(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	local := func(what string) {
		t.Helper()
		v, err := e.s.Create(remGroup, "")
		if err != nil || v.Server != "" || v.Agent != model.Claude || v.Cwd != e.cwd || v.Blocked != "" || v.FolderMissing {
			t.Fatalf("%s: %+v %v", what, v, err)
		}
	}
	e.defaults(func(g map[string]model.GroupDefaults) {
		g[remGroup] = model.GroupDefaults{Server: "inst-nobody", Servers: map[string]model.ServerDefaults{"inst-nobody": {Cwd: remApp}}}
	})
	local("a key of no entry")
	e.defaults(func(g map[string]model.GroupDefaults) { g[remGroup] = model.GroupDefaults{Server: remKeyB} })
	e.far.change(remB, func(en *chats.RemoteEntry) { en.Stopped = true })
	local("an entry that waits for the user")
	e.far.change(remB, func(en *chats.RemoteEntry) { en.Stopped = false })
	if v, err := e.s.Create(remGroup, ""); err != nil || v.Server != remB {
		t.Fatalf("the entry again: %+v %v", v, err)
	}
	// The ungrouped group's sticky server is a group's when the group has none.
	e.defaults(func(g map[string]model.GroupDefaults) {
		delete(g, remGroup)
		g[model.Ungrouped] = model.GroupDefaults{Server: remKeyC}
	})
	if v, err := e.s.Create(remGroup, ""); err != nil || v.Server != remC || v.Agent != model.Pi || v.Cwd != "/home/sea" {
		t.Fatalf("the ungrouped group's server: %+v %v", v, err)
	}
	e.s.Remote = nil
	local("no other servers")
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("Create asked %v", got)
	}
}

// HandOver records the server, the folder and the run defaults under the server's key, and the
// next "New run" in the group begins with them.
func TestRemoteHandOverRecordsDefaults(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	v, err := e.s.Create(remGroup, "")
	if err != nil || v.Server != "" {
		t.Fatalf("%+v %v", v, err)
	}
	id := v.ID
	e.patch(id, PatchReq{Server: svcPtr(remB)})
	v = e.patch(id, PatchReq{Agent: svcPtr(model.Cursor), Cwd: svcPtr("~/proj"),
		Settings: &SettingsPatch{MaxParallel: svcPtr(5), MaxTurns: svcPtr(33), MaxCost: svcPtr(4.0), Setup: svcPtr("npm ci")}})
	if v.Cwd != remProj || v.Agent != model.Cursor {
		t.Fatalf("the draft: %+v", v)
	}
	localBefore := e.groupDefaults(remGroup).Servers[model.LocalServer]
	e.events()

	there := v
	there.Group, there.Status, there.Started = "g_remote", model.RunRunning, e.clock.Now()
	there.Tiers = tiersAll("far-gpt", "") // as that server fixed them
	meta, err := e.s.HandOver(id, remB, there)
	if err != nil || meta.ID != id || meta.Server != remB || meta.Group != remGroup || meta.Cwd != remProj {
		t.Fatalf("HandOver: %+v %v", meta, err)
	}
	gd := e.groupDefaults(remGroup)
	sd := gd.Servers[remKeyB]
	tiers := tiersAll("far-gpt", "")
	wantRun := &model.RunDefaults{Agent: model.Cursor, MaxParallel: 5, MaxTurns: 33, MaxCost: 4, Setup: "npm ci", SetupCwd: remProj, Tiers: &tiers}
	if gd.Server != remKeyB || sd.Cwd != remProj || !reflect.DeepEqual(sd.Run, wantRun) {
		t.Fatalf("the defaults after: server %q, %+v, run %+v", gd.Server, sd, sd.Run)
	}
	if _, ok := gd.Servers["g_remote"]; ok || !reflect.DeepEqual(gd.Servers[model.LocalServer], localBefore) {
		t.Errorf("the local part changed: %+v", gd.Servers)
	}
	if kinds := svcKinds(e.events()); !slices.Equal(kinds, []string{"defaults"}) {
		t.Errorf("events of HandOver: %v", kinds)
	}

	n, err := e.s.Create(remGroup, "")
	want := model.DefaultRunSettings()
	want.MaxParallel, want.MaxTurns, want.MaxCost, want.Setup = 5, 33, 4, "npm ci"
	if err != nil || n.Server != remB || n.Agent != model.Cursor || n.Tiers != tiers || n.Cwd != remProj || n.Settings != want {
		t.Fatalf("the next new run: %+v %v", n, err)
	}
}

// HandOver retires the draft with no run_removed, and takes nothing but a draft of another server.
func TestRemoteHandOver(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	r := e.on("r_handover", func(m *model.RunMeta) { m.Draft = &model.Draft{Text: "the goal"} })
	e.far.change(remB, func(en *chats.RemoteEntry) { en.Key = "" }) // it has not said who it is
	e.patch(r.id, PatchReq{Name: svcPtr("Kept")})
	e.events()
	dir := r.dir
	// A draft on Bee is not handed over as one on another server: it was moved meanwhile.
	for _, entry := range []string{remC, "", model.LocalServer, "s_nobody"} {
		if _, err := e.s.HandOver(r.id, entry, model.RunView{ID: r.id}); !errors.Is(err, ErrNotFound) {
			t.Errorf("HandOver as a draft on %q: %v", entry, err)
		}
	}
	if _, ok := e.s.RemoteDraft(r.id); !ok || len(e.events()) != 0 {
		t.Fatal("a refused HandOver changed the draft")
	}
	if gd := e.groupDefaults(remGroup); gd.Server != "" || len(gd.Servers) != 0 {
		t.Errorf("a refused HandOver recorded defaults: %+v", gd)
	}
	meta, err := e.s.HandOver(r.id, remB, model.RunView{ID: r.id, Cwd: remWork, Tiers: remClaudeTiers})
	if err != nil || meta.Name != "Kept" || meta.Draft == nil || meta.Draft.Text != "the goal" {
		t.Fatalf("HandOver: %+v %v", meta, err)
	}
	if evs := e.events(); len(evs) != 0 {
		t.Errorf("HandOver with no key sent %v", svcKinds(evs))
	}
	if gd := e.groupDefaults(remGroup); gd.Server != "" || len(gd.Servers) != 0 {
		t.Errorf("recorded with no key: %+v", gd)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the draft's folder: %v", err)
	}
	if _, ok := e.s.RemoteDraft(r.id); ok {
		t.Error("the draft is still one")
	}
	if _, err := e.s.View(r.id); !errors.Is(err, ErrNotFound) {
		t.Errorf("View after: %v", err)
	}
	if len(e.s.Views()) != 0 || len(e.s.DraftsOn(remB)) != 0 {
		t.Errorf("still listed: %v %v", e.s.Views(), e.s.DraftsOn(remB))
	}
	if _, err := e.s.HandOver(r.id, remB, model.RunView{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("a second HandOver: %v", err)
	}
	// What was written with the old run in hand writes nothing.
	if err := e.s.svcSetMeta(r, func(m *model.RunMeta) error { m.Name = "late"; return nil }); !errors.Is(err, ErrNotFound) {
		t.Errorf("a late write: %v", err)
	}

	local := e.draft("r_local000")
	started := e.in("r_started0", model.RunStopped)
	for _, id := range []string{local.id, started.id, "r_nobody00"} {
		for _, entry := range []string{remB, ""} {
			if _, err := e.s.HandOver(id, entry, model.RunView{}); !errors.Is(err, ErrNotFound) {
				t.Errorf("HandOver of %s on %q: %v", id, entry, err)
			}
		}
	}
	if _, err := e.s.View(local.id); err != nil {
		t.Errorf("the local draft after: %v", err)
	}
	if _, err := os.Stat(started.dir); err != nil {
		t.Errorf("the started run's folder: %v", err)
	}
}

// ---- AC43: the draft's server, folder, agent and tiers ---------------------------------------------

// A server change sets agent, tiers, folder, limits and set-up command from that server's run
// defaults and lists, and the view's folder facts are that server's answer.
func TestRemotePatchServer(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	e.s.Agents = svcAgents(map[string]bool{"claude": true})
	was := tiersAll("far-gpt", "")
	e.defaults(func(g map[string]model.GroupDefaults) {
		g[remGroup] = model.GroupDefaults{Servers: map[string]model.ServerDefaults{
			remKeyB: {Cwd: remApp, Run: &model.RunDefaults{Agent: model.Cursor, MaxParallel: 7, MaxTurns: 40, MaxCost: 12.5, Setup: "make deps", SetupCwd: remApp, Tiers: &was}}}}
	})
	v, err := e.s.Create(remGroup, "Mine")
	if err != nil || v.Server != "" || v.Agent != model.Claude {
		t.Fatalf("%+v %v", v, err)
	}
	id := v.ID
	if err := e.s.SetDraft(id, model.Draft{Text: "typed so far"}); err != nil {
		t.Fatal(err)
	}
	local := e.patch(id, PatchReq{Settings: &SettingsPatch{Wake: svcPtr("each"), ApplyResult: svcPtr("manual"), Setup: svcPtr("here"), MaxParallel: svcPtr(2)}})
	e.events()

	v = e.patch(id, PatchReq{Server: svcPtr(remB)})
	want := local.Settings
	want.MaxParallel, want.MaxTurns, want.MaxCost, want.Setup = 7, 40, 12.5, "make deps"
	if v.Server != remB || v.Agent != model.Cursor || v.Tiers != was || v.Cwd != remApp || v.Settings != want {
		t.Fatalf("after the server change: %+v", v)
	}
	if v.Name != "Mine" || !v.UserNamed || v.Group != remGroup || v.Draft == nil || v.Draft.Text != "typed so far" || v.Settings.Wake != "each" || v.Settings.ApplyResult != "manual" {
		t.Errorf("what must stay: %+v", v)
	}
	if !v.Git || v.Dirty || v.FolderMissing || v.Blocked != "" {
		t.Errorf("the facts are not Bee's answer: git %v dirty %v missing %v blocked %q", v.Git, v.Dirty, v.FolderMissing, v.Blocked)
	}
	if v.TierDefaults == nil || *v.TierDefaults != remCursorTiers {
		t.Errorf("the tier defaults: %+v", v.TierDefaults)
	}
	if got := e.far.checks(); !slices.Equal(got, []string{remB + " cursor " + remApp}) {
		t.Errorf("draft checks: %v", got)
	}
	runs := svcRunEvents(e.events(), id)
	if len(runs) == 0 || !reflect.DeepEqual(runs[len(runs)-1], v) {
		t.Errorf("the last run event is not the answer: %+v", runs)
	}
	r, _ := e.s.run(id)
	onDisk := svcMetaOnDisk(t, r)

	// The same server changes nothing and asks nothing.
	if same := e.patch(id, PatchReq{Server: svcPtr(remB)}); !reflect.DeepEqual(same, v) || !reflect.DeepEqual(svcMetaOnDisk(t, r), onDisk) {
		t.Errorf("the same server changed the run: %+v", same)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("the same server asked %v", got)
	}

	// Another entry: its first agent, and with no catalogue and nothing recorded no model.
	v = e.patch(id, PatchReq{Server: svcPtr(remC)})
	if v.Server != remC || v.Agent != model.Pi || v.Cwd != "/home/sea" || v.Tiers != (model.RunTiers{}) || v.Settings.Setup != "" {
		t.Fatalf("on Sea: %+v", v)
	}

	// Back to this computer, by either of its names: what a new run here begins with.
	e.far.checks()
	v = e.patch(id, PatchReq{Server: svcPtr(model.LocalServer)})
	if v.Server != "" || v.Agent != model.Claude || v.Cwd != e.cwd || v.Tiers.Deep.Model == "" || v.FolderMissing || v.Blocked != "" || v.Git {
		t.Fatalf("back on this computer: %+v", v)
	}
	if m := svcMetaOnDisk(t, r); m.Server != "" {
		t.Errorf("run.json: %+v", m)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("this computer's folder was asked of %v", got)
	}
}

// A folder of a draft on another server is asked of that server alone: its answer is the folder
// and the facts.
func TestRemotePatchFolder(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	r := e.on("r_folder00", nil)
	before := svcMetaOnDisk(t, r)

	v := e.patch(r.id, PatchReq{Cwd: svcPtr("~/proj")})
	if v.Cwd != remProj || !v.Git || !v.Dirty || v.FolderMissing || v.Blocked != "" {
		t.Fatalf("the folder: %+v", v)
	}
	if got := e.far.checks(); !slices.Equal(got, []string{remB + " claude ~/proj"}) {
		t.Errorf("draft checks: %v", got)
	}
	// A folder that is only there, with that server's reason against a start.
	e.far.folders[remB+" /srv/only/there"] = DraftFacts{Cwd: "/srv/only/there", Blocked: "this repository has no commit yet"}
	v = e.patch(r.id, PatchReq{Cwd: svcPtr("/srv/only/there")})
	if v.Cwd != "/srv/only/there" || v.Git || v.Dirty || v.Blocked != "this repository has no commit yet" {
		t.Fatalf("a folder only there: %+v", v)
	}
	now := svcMetaOnDisk(t, r)

	refused := func(what string, p PatchReq, is error) {
		t.Helper()
		_, err := e.s.Patch(r.id, p)
		if err == nil || is != nil && !errors.Is(err, is) {
			t.Errorf("%s: %v", what, err)
		}
		if got := svcMetaOnDisk(t, r); !reflect.DeepEqual(got, now) {
			t.Errorf("%s changed run.json: %+v", what, got)
		}
	}
	// A folder that exists here and not there is missing, with the path as that server reads it.
	refused("a folder of this computer", PatchReq{Cwd: svcPtr(e.cwd), Settings: &SettingsPatch{MaxParallel: svcPtr(9)}}, chats.ErrFolderMissing)
	if _, err := e.s.Patch(r.id, PatchReq{Cwd: svcPtr(e.cwd)}); err == nil || !strings.HasSuffix(err.Error(), ": "+e.cwd) {
		t.Errorf("the missing folder's sentence: %v", err)
	}
	refused("a blank folder", PatchReq{Cwd: svcPtr("  ")}, nil)
	e.far.checks()
	e.far.fails[remB] = ErrRunsUnsupported
	refused("a server without run routes", PatchReq{Cwd: svcPtr("~/proj")}, ErrRunsUnsupported)
	delete(e.far.fails, remB)
	e.far.checks()
	e.far.change(remB, func(en *chats.RemoteEntry) { en.Connected = false })
	refused("an entry that is not connected", PatchReq{Cwd: svcPtr("~/proj")}, chats.ErrServerUnreachable)
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("an entry that is not connected was asked %v", got)
	}
	// The sentence names the entry, as a call for a started run on it does.
	if _, err := e.s.Patch(r.id, PatchReq{Cwd: svcPtr("~/proj")}); err == nil || err.Error() != "Bee is not connected." {
		t.Errorf("the sentence of an entry that is not connected: %v", err)
	}
	if reflect.DeepEqual(before, now) {
		t.Fatal("the test changed nothing")
	}
}

// The agent is checked against the entry's list and the tiers against its catalogue; default
// tiers take their base from that server's defaults and catalogue (AC44, and T90's finding 4).
func TestRemotePatchAgentAndTiers(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	e.s.Agents = svcAgents(map[string]bool{"pi": true}) // this computer can use pi alone
	r := e.on("r_agent000", nil)
	before := svcMetaOnDisk(t, r)

	var me *usable.MissingError
	_, err := e.s.Patch(r.id, PatchReq{Agent: svcPtr(model.Pi), Settings: &SettingsPatch{MaxParallel: svcPtr(3)}})
	if !errors.Is(err, usable.ErrMissing) || !errors.As(err, &me) || me.Agent != model.Pi {
		t.Fatalf("an agent Bee lacks: %v", err)
	}
	if _, err := e.s.Patch(r.id, PatchReq{Agent: svcPtr(model.AgentKind("nobody"))}); err == nil || errors.Is(err, usable.ErrMissing) {
		t.Fatalf("an unknown agent: %v", err)
	}
	if got := svcMetaOnDisk(t, r); !reflect.DeepEqual(got, before) {
		t.Fatalf("a refused agent changed run.json: %+v", got)
	}
	e.far.checks()

	// Cursor, which this computer cannot use: tiers from Bee's catalogue default, none empty.
	v := e.patch(r.id, PatchReq{Agent: svcPtr(model.Cursor)})
	if v.Agent != model.Cursor || v.Tiers != remCursorTiers || v.TierDefaults == nil || *v.TierDefaults != remCursorTiers {
		t.Fatalf("Cursor on Bee: %+v defaults %+v", v.Tiers, v.TierDefaults)
	}
	if got := e.far.checks(); !slices.Equal(got, []string{remB + " cursor " + remWork}) {
		t.Errorf("draft checks after an agent change: %v", got)
	}
	// The group's choice for Bee is the base, when there is one.
	e.defaults(func(g map[string]model.GroupDefaults) {
		g[remGroup] = model.GroupDefaults{Servers: map[string]model.ServerDefaults{
			remKeyB:           {ByAgent: map[model.AgentKind]model.ModelChoice{model.Cursor: {Model: "far-gpt"}}},
			model.LocalServer: {ByAgent: map[model.AgentKind]model.ModelChoice{model.Cursor: {Model: "local-only"}}}}}
	})
	e.patch(r.id, PatchReq{Agent: svcPtr(model.Claude)})
	if v = e.patch(r.id, PatchReq{Agent: svcPtr(model.Cursor)}); v.Tiers != tiersAll("far-gpt", "") {
		t.Fatalf("Cursor with a choice recorded for Bee: %+v", v.Tiers)
	}

	// A tier: a model of Bee's catalogue that this computer does not know, and its efforts.
	v = e.patch(r.id, PatchReq{Tiers: &TiersPatch{Deep: &TierPatch{Model: svcPtr("far-gpt-mini"), Effort: svcPtr("high")}}})
	if v.Tiers.Deep != (model.ModelChoice{Model: "far-gpt-mini", Effort: "high"}) {
		t.Fatalf("a tier on Bee: %+v", v.Tiers)
	}
	for _, p := range []*TiersPatch{
		{Light: &TierPatch{Model: svcPtr("sonnet")}},
		{Light: &TierPatch{Model: svcPtr("local-only")}},
		{Deep: &TierPatch{Effort: svcPtr("medium")}},
	} {
		if _, err := e.s.Patch(r.id, PatchReq{Tiers: p}); err == nil {
			t.Errorf("a tier Bee's catalogue lacks was taken: %+v", p)
		}
	}
	if _, err := e.s.Patch(r.id, PatchReq{Tiers: &TiersPatch{Light: &TierPatch{Model: svcPtr("sonnet")}}}); !errors.Is(err, ErrUnknownModel) {
		t.Errorf("a model Bee lacks: %v", err)
	}

	// Sea reported no catalogue: the base is the group's choice for Sea, and every model is taken.
	e.defaults(func(g map[string]model.GroupDefaults) {
		g[remGroup] = model.GroupDefaults{Servers: map[string]model.ServerDefaults{
			remKeyC: {ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: {Model: "pi-far", Effort: "low"}}}}}
	})
	v = e.patch(r.id, PatchReq{Server: svcPtr(remC)})
	if v.Agent != model.Pi || v.Tiers.Deep.Model != "pi-far" || v.Tiers.Standard.Model != "pi-far" || v.Tiers.Light.Model != "pi-far" {
		t.Fatalf("pi on Sea: %+v", v.Tiers)
	}
	v = e.patch(r.id, PatchReq{Tiers: &TiersPatch{Standard: &TierPatch{Model: svcPtr("anything"), Effort: svcPtr("max")}}})
	if v.Tiers.Standard != (model.ModelChoice{Model: "anything", Effort: "max"}) {
		t.Fatalf("a tier with no catalogue: %+v", v.Tiers)
	}
}

// The refusals of Patch, in their order (AC5 among them: an entry that waits for the user).
func TestRemotePatchRefusals(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	e.far.entries["s_old00000"] = chats.RemoteEntry{ID: "s_old00000", Name: "Old", Key: "inst-old", Stopped: true}
	server := func(id string) PatchReq { return PatchReq{Server: svcPtr(id)} }
	refused := func(what string, r *run, p PatchReq, want error) {
		t.Helper()
		before := svcMetaOnDisk(t, r)
		if _, err := e.s.Patch(r.id, p); !errors.Is(err, want) {
			t.Errorf("%s: %v, want %v", what, err, want)
		}
		if got := svcMetaOnDisk(t, r); !reflect.DeepEqual(got, before) {
			t.Errorf("%s changed run.json", what)
		}
	}

	started := e.in("r_started0", model.RunStopped)
	refused("a started run", started, server("s_nobody00"), ErrStarted)

	archived := e.on("r_archived", func(m *model.RunMeta) {
		m.Archive, m.RemoteStart = model.Archive{Archived: true, Op: "a_1"}, model.RemoteUnconfirmed
	})
	refused("an archived run", archived, server("s_nobody00"), ErrArchived)

	unc := e.on("r_unconfir", func(m *model.RunMeta) { m.RemoteStart = model.RemoteUnconfirmed })
	e.host.people[unc.id] = []model.ChatMeta{{ID: "c1"}}
	for what, p := range map[string]PatchReq{
		"the server":      server("s_nobody00"),
		"the same server": server(remB),
		"local":           server(model.LocalServer),
		"the agent":       {Agent: svcPtr(model.Cursor)},
		"a tier":          {Tiers: &TiersPatch{Deep: &TierPatch{Model: svcPtr("far-sonnet-9")}}},
		"the folder":      {Cwd: svcPtr("~/proj")},
		"a setting":       {Settings: &SettingsPatch{MaxTurns: svcPtr(9)}},
	} {
		refused(what+" while the start may have arrived", unc, p, ErrStartUnconfirmed)
	}
	if v := e.patch(unc.id, PatchReq{Name: svcPtr("Renamed"), Group: svcPtr(model.Ungrouped)}); v.Name != "Renamed" || v.Group != model.Ungrouped || v.Start != model.RemoteUnconfirmed {
		t.Errorf("name and group while unconfirmed: %+v", v)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("a refused patch asked %v", got)
	}

	// Not unconfirmed, with a chat: the server is looked at before the chats.
	busy := e.on("r_haschats", nil)
	e.host.people[busy.id] = []model.ChatMeta{{ID: "c2"}}
	refused("an unknown server", busy, server("s_nobody00"), chats.ErrServerUnknown)
	refused("an entry that waits for the user", busy, server("s_old00000"), chats.ErrServerUnusable)
	refused("another entry, with chats", busy, server(remC), ErrRunHasChats)
	refused("this computer, with chats", busy, server(model.LocalServer), ErrRunHasChats)
	refused("another entry with a folder, with chats", busy, PatchReq{Server: svcPtr(remC), Cwd: svcPtr("~/proj")}, ErrRunHasChats)
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("a refused patch asked %v", got)
	}
	// Its own server is no change, chats or not; everything else of it can still be set.
	if v := e.patch(busy.id, PatchReq{Server: svcPtr(remB), Agent: svcPtr(model.Cursor)}); v.Server != remB || v.Agent != model.Cursor {
		t.Errorf("the same server with chats: %+v", v)
	}
	// A local draft with a chat cannot go to another server either.
	local := e.draft("r_local000")
	e.host.people[local.id] = []model.ChatMeta{{ID: "c3"}}
	refused("a local draft with chats", local, server(remB), ErrRunHasChats)
	delete(e.host.people, local.id)
	refused("a local draft to an entry that waits", local, server("s_old00000"), chats.ErrServerUnusable)
	if v := e.patch(local.id, server(remB)); v.Server != remB {
		t.Errorf("a local draft without chats: %+v", v)
	}

	// A draft that is on an entry that waits for the user already keeps it.
	e.far.change(remB, func(en *chats.RemoteEntry) { en.Stopped = true })
	if _, err := e.s.Patch(busy.id, server(remB)); err != nil {
		t.Errorf("the draft's own entry, stopped: %v", err)
	}
}

// ---- the facts ---------------------------------------------------------------------------------

// What the view says of a draft on another server, row by row.
func TestRemoteDraftFacts(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	r := e.on("r_facts000", nil)
	e.far.folders[remB+" "+remWork] = DraftFacts{Cwd: remWork, Git: true, Dirty: true}

	v := e.view(r.id)
	if !v.Git || !v.Dirty || v.FolderMissing || v.Blocked != "" || v.TierDefaults == nil || *v.TierDefaults != remClaudeTiers {
		t.Fatalf("as answered: %+v defaults %+v", v, v.TierDefaults)
	}
	e.far.folders[remB+" "+remWork] = DraftFacts{Cwd: remWork, Git: true, Blocked: "Claude's program was not found: install it, then start the run"}
	if v = e.view(r.id); !v.Git || v.Dirty || v.Blocked != "Claude's program was not found: install it, then start the run" {
		t.Errorf("that server's sentence: %+v", v)
	}
	delete(e.far.folders, remB+" "+remWork)
	if v = e.view(r.id); !v.FolderMissing || v.Git || v.Dirty || v.Blocked != "" {
		t.Errorf("a folder that is missing there: %+v", v)
	}
	e.far.fails[remB] = ErrRunsUnsupported
	if v = e.view(r.id); v.Blocked != "Bee cannot run runs: update it." || v.FolderMissing || v.Git {
		t.Errorf("a server without run routes: %+v", v)
	}
	e.far.fails[remB] = errors.New("Bee did not answer.")
	if v = e.view(r.id); !strings.HasPrefix(v.Blocked, "Bee could not check the folder: ") {
		t.Errorf("another failure: %+v", v)
	}
	delete(e.far.fails, remB)
	e.far.checks()

	e.far.change(remB, func(en *chats.RemoteEntry) { en.Connected = false })
	if v = e.view(r.id); v.Blocked != "Bee is not connected: the folder cannot be checked and the run cannot start." || v.FolderMissing {
		t.Errorf("not connected: %+v", v)
	}
	if v.TierDefaults == nil || *v.TierDefaults != remClaudeTiers {
		t.Errorf("the tier defaults of a server whose lists are known: %+v", v.TierDefaults)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("an entry that is not connected was asked %v", got)
	}

	const gone = "The run's server is no longer in the list: choose another."
	delete(e.far.entries, remB)
	if v = e.view(r.id); v.Blocked != gone || v.Server != remB {
		t.Errorf("no such entry: %+v", v)
	}
	// With no other servers at all a stored draft with a server is blocked the same way, from
	// the load on; a local one is as it was.
	local := e.draft("r_local000")
	e.restart(nil)
	for _, v := range e.s.Views() {
		switch v.ID {
		case r.id:
			if v.Blocked != gone || v.Server != remB {
				t.Errorf("loaded with no other servers: %+v", v)
			}
		case local.id:
			if v.Blocked != "" || v.FolderMissing || v.Server != "" {
				t.Errorf("the local draft: %+v", v)
			}
		}
	}
	if v = e.view(r.id); v.Blocked != gone {
		t.Errorf("read with no other servers: %+v", v)
	}
	if _, err := e.s.Patch(r.id, PatchReq{Server: svcPtr(remB)}); !errors.Is(err, chats.ErrServerUnknown) {
		t.Errorf("an entry with no other servers: %v", err)
	}
	if _, err := e.s.Patch(r.id, PatchReq{Agent: svcPtr(model.Cursor)}); !errors.Is(err, chats.ErrServerUnknown) {
		t.Errorf("an agent for a server that is gone: %v", err)
	}
	if _, err := e.s.Start(r.id, "go"); !errors.Is(err, ErrRemoteStart) {
		t.Errorf("a start with no other servers: %v", err)
	}
	if v = e.patch(r.id, PatchReq{Server: svcPtr(model.LocalServer)}); v.Server != "" || v.Blocked != "" || v.Cwd != e.cwd || v.Agent != model.Claude {
		t.Errorf("chosen back to this computer: %+v", v)
	}
}

// The draft check is asked at a read, after a patch of server or agent, and when the server is
// up; not at "New run", at load, or while the start may have arrived.
func TestRemoteDraftCheckWhenAsked(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	e.defaults(func(g map[string]model.GroupDefaults) { g[remGroup] = model.GroupDefaults{Server: remKeyB} })
	asked := func(what string, want ...string) {
		t.Helper()
		e.quiet()
		if got := e.far.checks(); !slices.Equal(got, want) {
			t.Errorf("%s: draft checks %v, want %v", what, got, want)
		}
	}
	v, err := e.s.Create(remGroup, "")
	if err != nil || v.Server != remB {
		t.Fatalf("%+v %v", v, err)
	}
	id := v.ID
	asked("Create")
	e.restart(e.far)
	asked("Load")
	e.s.Views()
	e.s.List()
	if err := e.s.SetDraft(id, model.Draft{Text: "x"}); err != nil {
		t.Fatal(err)
	}
	e.patch(id, PatchReq{Name: svcPtr("N"), Group: svcPtr(model.Ungrouped), Settings: &SettingsPatch{MaxTurns: svcPtr(7)},
		Tiers: &TiersPatch{Light: &TierPatch{Model: svcPtr("far-opus-9")}}})
	asked("the lists, the goal draft, name, group, tiers and settings")

	e.view(id)
	asked("View", remB+" claude "+remWork)
	e.patch(id, PatchReq{Agent: svcPtr(model.Cursor)})
	asked("a patch of the agent", remB+" cursor "+remWork)
	e.patch(id, PatchReq{Server: svcPtr(remC)})
	asked("a patch of the server", remC+" pi /home/sea")
	e.patch(id, PatchReq{Server: svcPtr(remB), Cwd: svcPtr("~/proj")})
	asked("a patch of server and folder", remB+" claude ~/proj")
	e.s.ServerUp(remB)
	asked("ServerUp", remB+" claude "+remProj)
	e.s.ServerUp(remC)
	asked("ServerUp of another entry")

	// While the start may have arrived nothing is asked and the facts stay.
	before := e.view(id)
	e.far.checks()
	if err := e.s.SetRemoteStart(id, model.RemoteUnconfirmed); err != nil {
		t.Fatal(err)
	}
	delete(e.far.folders, remB+" "+remProj)
	v = e.view(id)
	e.s.ServerUp(remB)
	asked("unconfirmed")
	if v.Start != model.RemoteUnconfirmed || v.Git != before.Git || v.Dirty != before.Dirty || v.FolderMissing || v.Blocked != "" || !before.Git {
		t.Errorf("the facts while unconfirmed: %+v, before %+v", v, before)
	}
	// Not even when the entry is no longer connected: the facts stay.
	e.far.change(remB, func(en *chats.RemoteEntry) { en.Connected = false })
	if v = e.view(id); v.Blocked != "" || !v.Git {
		t.Errorf("unconfirmed and not connected: %+v", v)
	}
	e.far.change(remB, func(en *chats.RemoteEntry) { en.Connected = true })
	if err := e.s.SetRemoteStart(id, ""); err != nil {
		t.Fatal(err)
	}
	asked("the state of the start")
	if v = e.view(id); !v.FolderMissing || v.Start != "" {
		t.Errorf("asked again once it is known: %+v", v)
	}
	asked("View after", remB+" claude "+remProj)
}

// remProbe makes the calls that need the run's op lock, its creation lock and its own lock, and
// fails when one of them does not return: a draft check is waiting meanwhile.
func remProbe(t *testing.T, e *remEnv, id, during string) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		if err := e.s.SetDraft(id, model.Draft{Text: during}); err != nil { // the op lock
			done <- err
			return
		}
		if _, err := e.s.Patch(id, PatchReq{Name: svcPtr("During")}); err != nil { // the op lock, a write
			done <- err
			return
		}
		e.s.AwaitStart(id)                     // the creation lock
		if _, ok := e.s.RemoteDraft(id); !ok { // the run's lock
			done <- errors.New("not a remote draft")
			return
		}
		e.s.Views()
		e.s.List()
		e.s.DraftsOn(remB)
		e.s.RunOf(id)
		done <- nil
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("during %s: %v", during, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("a lock of the run is held over the draft check of %s", during)
	}
}

// No lock of the run is held while its server is asked: the fake holds every kind of check back.
func TestRemoteDraftCheckHoldsNoLock(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	r := e.on("r_nolock00", nil)
	id := r.id
	during := func(what, call string, do func() error) {
		t.Helper()
		release := e.far.holdNext()
		done := make(chan error, 1)
		go func() { done <- do() }()
		if got := e.far.awaitCheck(t); got != call {
			t.Fatalf("%s asked %q, want %q", what, got, call)
		}
		remProbe(t, e, id, what)
		select {
		case err := <-done:
			t.Fatalf("%s returned before its check was answered: %v", what, err)
		default:
		}
		release()
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("%s: %v", what, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s did not return", what)
		}
	}
	during("View", remB+" claude "+remWork, func() error { _, err := e.s.View(id); return err })
	during("a patch of the folder", remB+" claude ~/proj", func() error {
		_, err := e.s.Patch(id, PatchReq{Cwd: svcPtr("~/proj")})
		return err
	})
	if m, _ := e.s.RemoteDraft(id); m.Cwd != remProj || m.Name != "During" {
		t.Fatalf("after the folder: %+v", m)
	}
	during("a patch of the agent", remB+" cursor "+remProj, func() error {
		_, err := e.s.Patch(id, PatchReq{Agent: svcPtr(model.Cursor)})
		return err
	})
	during("a patch of the server", remC+" pi /home/sea", func() error {
		_, err := e.s.Patch(id, PatchReq{Server: svcPtr(remC)})
		return err
	})
	e.patch(id, PatchReq{Server: svcPtr(remB)})
	e.far.checks()
	during("ServerUp", remB+" claude "+remWork, func() error { e.s.ServerUp(remB); e.quiet(); return nil })
}

// A folder is applied only if the draft is still on the server that was asked: when it is not,
// the folder is looked at where the draft is by then.
func TestRemotePatchFolderOnAnotherServerByThen(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	r := e.on("r_moved000", nil)
	here := t.TempDir()
	patch := func(cwd string) chan error {
		done := make(chan error, 1)
		go func() {
			_, err := e.s.Patch(r.id, PatchReq{Cwd: svcPtr(cwd)})
			done <- err
		}()
		return done
	}
	wait := func(done chan error) {
		t.Helper()
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the patch did not return")
		}
	}

	// Asked of Bee, which says the folder is missing; the draft is on this computer by then,
	// where the folder exists.
	release := e.far.holdNext()
	done := patch(here)
	e.far.awaitCheck(t)
	if err := e.s.ResetServer(r.id); err != nil {
		t.Fatal(err)
	}
	release()
	wait(done)
	if v := e.view(r.id); v.Server != "" || v.Cwd != here || v.FolderMissing {
		t.Fatalf("after the reset: %+v", v)
	}
	if got := e.far.checks(); !slices.Equal(got, []string{remB + " claude " + here}) {
		t.Errorf("draft checks: %v", got)
	}

	// Asked of Bee; the draft is on Sea by then: Sea is asked, and its answer is the folder.
	e.patch(r.id, PatchReq{Server: svcPtr(remB)})
	e.far.checks()
	release = e.far.holdNext()
	done = patch("~/proj")
	e.far.awaitCheck(t)
	e.patch(r.id, PatchReq{Server: svcPtr(remC)})
	release()
	wait(done)
	if v := e.view(r.id); v.Server != remC || v.Cwd != "/home/sea/proj" || !v.Git {
		t.Fatalf("after the move: %+v", v)
	}
	got := e.far.checks()
	if len(got) < 3 || got[0] != remB+" claude ~/proj" || !slices.Contains(got, remC+" pi ~/proj") {
		t.Errorf("draft checks: %v", got)
	}
}

// ---- AC44: the agent when the server is up ----------------------------------------------------------

func TestRemoteServerUp(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	e.defaults(func(g map[string]model.GroupDefaults) { g[remGroup] = model.GroupDefaults{Server: remKeyB} })
	// Bee is in the list, has said who it is, and is not connected: nothing of it is known.
	e.far.change(remB, func(en *chats.RemoteEntry) {
		en.Connected, en.HasLists, en.Agents, en.Catalogs, en.DefaultCwd = false, false, nil, nil, ""
	})
	v, err := e.s.Create(remGroup, "")
	if err != nil {
		t.Fatal(err)
	}
	const offline = "Bee is not connected: the folder cannot be checked and the run cannot start."
	if v.Server != remB || v.Agent != "" || v.Tiers != (model.RunTiers{}) || v.Cwd != "" || v.Blocked != offline {
		t.Fatalf("a draft on a server nothing is known of: %+v", v)
	}
	if _, err := e.s.Start(v.ID, "the goal"); !errors.Is(err, ErrRemoteStart) {
		t.Fatalf("Start: %v", err)
	}
	none := v.ID
	stale := e.on("r_stale000", func(m *model.RunMeta) { m.Agent, m.Tiers = model.Pi, tiersAll("pi-x", "") })
	fine := e.on("r_fine0000", func(m *model.RunMeta) { m.Agent, m.Tiers, m.Cwd = model.Cursor, tiersAll("far-gpt", ""), remApp })
	sent := e.on("r_sent0000", func(m *model.RunMeta) {
		m.Agent, m.Tiers, m.RemoteStart = model.Pi, tiersAll("pi-x", ""), model.RemoteUnconfirmed
	})
	other := e.on("r_other000", func(m *model.RunMeta) { m.Server, m.Agent, m.Cwd = remC, model.Claude, "/home/sea" })
	e.s.ServerUp(remB) // still nothing known: nothing changes
	e.quiet()
	if m, _ := e.s.RemoteDraft(none); m.Agent != "" || m.Cwd != "" {
		t.Fatalf("ServerUp with no lists: %+v", m)
	}
	e.far.checks()
	e.events()

	e.far.change(remB, func(en *chats.RemoteEntry) {
		en.Connected, en.HasLists, en.Agents, en.DefaultCwd = true, true, []model.AgentKind{model.Claude, model.Cursor}, remWork
		en.Catalogs = map[model.AgentKind]*model.Catalog{model.Claude: remClaude, model.Cursor: remCursor}
	})
	e.s.ServerUp(remB)
	e.quiet()
	meta := func(id string) model.RunMeta {
		t.Helper()
		m, ok := e.s.RemoteDraft(id)
		if !ok {
			t.Fatalf("%s is no remote draft", id)
		}
		return m
	}
	if m := meta(none); m.Agent != model.Claude || m.Tiers != remClaudeTiers || m.Cwd != remWork {
		t.Errorf("the draft with no agent: %+v", m)
	}
	if m := meta(stale.id); m.Agent != model.Claude || m.Tiers != remClaudeTiers || m.Cwd != remWork {
		t.Errorf("the draft with an agent Bee lacks: %+v", m)
	}
	if m := meta(fine.id); m.Agent != model.Cursor || m.Tiers != tiersAll("far-gpt", "") || m.Cwd != remApp {
		t.Errorf("the draft with an agent Bee has: %+v", m)
	}
	if m := meta(sent.id); m.Agent != model.Pi || m.Tiers != tiersAll("pi-x", "") || m.RemoteStart != model.RemoteUnconfirmed {
		t.Errorf("the draft whose start may have arrived: %+v", m)
	}
	if m := meta(other.id); m.Agent != model.Claude {
		t.Errorf("a draft on another entry: %+v", m)
	}
	got := e.far.checks()
	slices.Sort(got)
	want := []string{remB + " claude " + remWork, remB + " claude " + remWork, remB + " cursor " + remApp}
	if !slices.Equal(got, want) {
		t.Errorf("draft checks of ServerUp: %v, want %v", got, want)
	}
	evs := e.events()
	if last := svcRunEvents(evs, none); len(last) == 0 || last[len(last)-1].Agent != model.Claude || last[len(last)-1].Blocked != "" {
		t.Errorf("the run events of the draft with no agent: %+v", last)
	}
	if last := svcRunEvents(evs, fine.id); len(last) == 0 || !last[len(last)-1].Git {
		t.Errorf("the run events of the draft whose facts changed: %+v", last)
	}
	if again := svcRunEvents(evs, sent.id); len(again) != 0 {
		t.Errorf("run events of the draft whose start may have arrived: %+v", again)
	}

	// Bee can use no agent any more: no agent, no tiers, and that server's reason in `blocked`.
	e.far.change(remB, func(en *chats.RemoteEntry) { en.Agents = nil })
	e.s.ServerUp(remB)
	e.quiet()
	if m := meta(fine.id); m.Agent != "" || m.Tiers != (model.RunTiers{}) || m.Cwd != remApp {
		t.Errorf("with no agent usable there: %+v", m)
	}
	if v := e.s.Views(); len(v) == 0 {
		t.Fatal("no runs")
	}
	fv, _ := e.s.run(fine.id)
	if v := fv.viewNow(); v.Blocked != "No agent can be used on this server: install one." {
		t.Errorf("blocked with no agent: %q", v.Blocked)
	}
	if _, err := e.s.Start(fine.id, "the goal"); !errors.Is(err, ErrRemoteStart) {
		t.Errorf("Start: %v", err)
	}
	// A new run there, which asks nothing, says so in the words of the start.
	n, err := e.s.Create(remGroup, "")
	if err != nil || n.Agent != "" || n.Blocked != "The run has no agent: choose one of Bee." {
		t.Errorf("a new run with no agent usable there: %+v %v", n, err)
	}
	e.s.ServerUp("s_nobody00") // no such entry: nothing happens
}

// ---- the relay's other calls -------------------------------------------------------------------

func TestRemoteDraftsOnAndResetServer(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	second := e.on("r_second00", func(m *model.RunMeta) { m.Created = testStart.Add(2 * time.Hour) })
	first := e.on("r_first000", func(m *model.RunMeta) {
		m.Created, m.RemoteStart, m.Draft = testStart.Add(time.Hour), model.RemoteUnconfirmed, &model.Draft{Text: "kept"}
		m.Settings.Wake, m.Settings.Setup, m.Settings.MaxTurns = "idle", "far setup", 77
		m.Archive = model.Archive{Archived: true, Op: "a_1"}
	})
	e.host.people[first.id] = []model.ChatMeta{{ID: "c1"}}
	onSea := e.on("r_onsea000", func(m *model.RunMeta) { m.Server = remC })
	local := e.draft("r_local000")
	started := e.in("r_started0", model.RunStopped)

	ids := func(ms []model.RunMeta) []string {
		out := []string{}
		for _, m := range ms {
			out = append(out, m.ID)
		}
		return out
	}
	if got := ids(e.s.DraftsOn(remB)); !slices.Equal(got, []string{first.id, second.id}) {
		t.Fatalf("DraftsOn(Bee): %v", got)
	}
	if got := ids(e.s.DraftsOn(remC)); !slices.Equal(got, []string{onSea.id}) {
		t.Fatalf("DraftsOn(Sea): %v", got)
	}
	if got := e.s.DraftsOn(""); len(got) != 0 {
		t.Fatalf("DraftsOn of this computer: %v", ids(got))
	}
	for _, id := range []string{local.id, started.id} {
		if _, ok := e.s.RemoteDraft(id); ok {
			t.Errorf("%s is reported as a remote draft", id)
		}
	}
	if m, ok := e.s.RemoteDraft(first.id); !ok || m.RemoteStart != model.RemoteUnconfirmed || m.Server != remB {
		t.Errorf("RemoteDraft: %+v %v", m, ok)
	}
	if _, ok := e.s.RemoteDraft("r_nobody00"); ok {
		t.Error("RemoteDraft of no run")
	}

	// ResetServer: on this computer whole, whatever the draft's state; nothing is asked.
	e.events()
	e.far.checks()
	if err := e.s.ResetServer(first.id); err != nil {
		t.Fatal(err)
	}
	m := svcMetaOnDisk(t, first)
	want := model.DefaultRunSettings()
	want.Wake = "idle"
	if m.Server != "" || m.RemoteStart != "" || m.Agent != model.Claude || m.Cwd != e.cwd || m.Tiers.Deep.Model == "" || m.Settings != want ||
		m.Draft == nil || m.Draft.Text != "kept" || !m.Archived {
		t.Fatalf("after ResetServer: %+v", m)
	}
	runs := svcRunEvents(e.events(), first.id)
	if len(runs) == 0 || runs[len(runs)-1].Server != "" || runs[len(runs)-1].Start != "" || runs[len(runs)-1].Blocked != "" || runs[len(runs)-1].FolderMissing {
		t.Errorf("the run events of ResetServer: %+v", runs)
	}
	if got := ids(e.s.DraftsOn(remB)); !slices.Equal(got, []string{second.id}) {
		t.Errorf("DraftsOn(Bee) after: %v", got)
	}
	before := svcMetaOnDisk(t, local)
	for _, id := range []string{local.id, started.id, first.id} {
		if err := e.s.ResetServer(id); err != nil {
			t.Errorf("ResetServer of %s: %v", id, err)
		}
	}
	if got := svcMetaOnDisk(t, local); !reflect.DeepEqual(got, before) {
		t.Errorf("ResetServer changed a local draft: %+v", got)
	}
	if err := e.s.ResetServer("r_nobody00"); !errors.Is(err, ErrNotFound) {
		t.Errorf("ResetServer of no run: %v", err)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("ResetServer asked %v", got)
	}
}

func TestRemoteSetRemoteStart(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	r := e.on("r_start000", nil)
	e.events()
	if err := e.s.SetRemoteStart(r.id, model.RemoteUnconfirmed); err != nil {
		t.Fatal(err)
	}
	if m := svcMetaOnDisk(t, r); m.RemoteStart != model.RemoteUnconfirmed {
		t.Fatalf("run.json: %+v", m)
	}
	runs := svcRunEvents(e.events(), r.id)
	if len(runs) != 1 || runs[0].Start != model.RemoteUnconfirmed || runs[0].Server != remB {
		t.Fatalf("the run event: %+v", runs)
	}
	if err := e.s.SetRemoteStart(r.id, model.RemoteUnconfirmed); err != nil {
		t.Fatal(err)
	}
	if evs := e.events(); len(evs) != 0 {
		t.Errorf("the same state sent %v", svcKinds(evs))
	}
	if err := e.s.SetRemoteStart(r.id, ""); err != nil {
		t.Fatal(err)
	}
	if m := svcMetaOnDisk(t, r); m.RemoteStart != "" {
		t.Fatalf("run.json: %+v", m)
	}
	if runs := svcRunEvents(e.events(), r.id); len(runs) != 1 || runs[0].Start != "" {
		t.Fatalf("the run event: %+v", runs)
	}
	if err := e.s.SetRemoteStart(r.id, model.RemoteLeft); err == nil {
		t.Error("a state a run does not have was taken")
	}
	local := e.draft("r_local000")
	for _, id := range []string{local.id, "r_nobody00", e.in("r_started0", model.RunStopped).id} {
		if err := e.s.SetRemoteStart(id, model.RemoteUnconfirmed); !errors.Is(err, ErrNotFound) {
			t.Errorf("SetRemoteStart of %s: %v", id, err)
		}
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("SetRemoteStart asked %v", got)
	}
}

// Reissue: a new id, the folder renamed, `run` with `was` and then `run_removed`; the goal draft
// and every value kept.
func TestRemoteReissue(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	r := e.on("r_reissue0", func(m *model.RunMeta) {
		m.Name, m.UserNamed, m.Draft, m.RemoteStart = "Mine", true, &model.Draft{Text: "the goal so far"}, model.RemoteUnconfirmed
		m.Cwd, m.Settings.MaxTurns, m.Settings.Setup = remProj, 12, "make"
	})
	old := r.id
	shown := e.view(old) // unconfirmed: the facts as loaded
	e.events()

	v, err := e.s.Reissue(old)
	if err != nil {
		t.Fatal(err)
	}
	if v.ID == old || !ValidID(v.ID) || v.Was != old || v.Start != "" {
		t.Fatalf("the answer: %+v", v)
	}
	want := shown
	want.ID, want.Was, want.Start = v.ID, old, ""
	if !reflect.DeepEqual(v, want) {
		t.Errorf("the answer is not the draft with a new id:\n got %+v\nwant %+v", v, want)
	}
	evs := e.events()
	if kinds := svcKinds(evs); !slices.Equal(kinds, []string{"run", "run_removed"}) {
		t.Fatalf("events of Reissue: %v", kinds)
	}
	if first := evs[0].(svcRunEvent); !reflect.DeepEqual(first.Run, v) {
		t.Errorf("the run event: %+v", first.Run)
	}
	if rm := evs[1].(svcRemovedEvent); rm.ID != old {
		t.Errorf("run_removed of %s", rm.ID)
	}
	if as := e.emit.sentAs(); !slices.Equal(as[len(as)-2:], []string{v.ID, old}) {
		t.Errorf("the events were sent as events of %v", as[len(as)-2:])
	}
	if _, err := os.Stat(e.s.Store.P.RunDir(old)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the old folder: %v", err)
	}
	m, err := readMeta(e.s.Store.P.RunDir(v.ID))
	if err != nil || m.ID != v.ID || m.RemoteStart != "" || m.Name != "Mine" || !m.UserNamed || m.Draft == nil || m.Draft.Text != "the goal so far" ||
		m.Cwd != remProj || m.Settings.MaxTurns != 12 || m.Settings.Setup != "make" || m.Server != remB || m.Tiers != remClaudeTiers || m.Group != remGroup {
		t.Fatalf("run.json under the new id: %+v %v", m, err)
	}
	if _, ok := e.s.RemoteDraft(old); ok {
		t.Error("the old id is still a draft")
	}
	if _, err := e.s.View(old); !errors.Is(err, ErrNotFound) {
		t.Errorf("View of the old id: %v", err)
	}
	if err := e.s.SetDraft(old, model.Draft{Text: "late"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("a late goal draft for the old id: %v", err)
	}
	if got, ok := e.s.RemoteDraft(v.ID); !ok || !reflect.DeepEqual(got, m) {
		t.Errorf("the new id: %+v %v", got, ok)
	}
	// What follows is an event of the new id, without `was`.
	if err := e.s.SetDraft(v.ID, model.Draft{Text: "more"}); err != nil {
		t.Fatal(err)
	}
	if runs := svcRunEvents(e.events(), v.ID); len(runs) != 1 || runs[0].Was != "" || runs[0].Draft.Text != "more" {
		t.Errorf("the next run event: %+v", runs)
	}
	e.restart(e.far)
	if got, ok := e.s.RemoteDraft(v.ID); !ok || got.Draft.Text != "more" {
		t.Errorf("the new id after a restart: %+v %v", got, ok)
	}
	if len(e.s.Views()) != 1 {
		t.Errorf("runs after a restart: %+v", e.s.Views())
	}

	local := e.draft("r_local000")
	for _, id := range []string{local.id, old, "r_nobody00"} {
		if _, err := e.s.Reissue(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Reissue of %s: %v", id, err)
		}
	}
}

// RunOf says where a run is and whether it has started, and asks the records for a run the
// service does not have.
func TestRemoteRunOf(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	far := e.on("r_far00000", nil)
	local := e.draft("r_local000")
	started := e.in("r_started0", model.RunStopped)
	if ri, ok := e.s.RunOf(far.id); !ok || ri.Server != remB || !ri.Draft || ri.Cwd != remWork || ri.Group != remGroup || ri.Model != "far-opus-9" {
		t.Errorf("a draft on Bee: %+v %v", ri, ok)
	}
	if ri, ok := e.s.RunOf(local.id); !ok || ri.Server != "" || !ri.Draft {
		t.Errorf("a draft here: %+v %v", ri, ok)
	}
	if ri, ok := e.s.RunOf(started.id); !ok || ri.Server != "" || ri.Draft {
		t.Errorf("a started run: %+v %v", ri, ok)
	}
	rec := chats.RunInfo{Group: remGroup, Cwd: remProj, Agent: model.Cursor, Model: "far-gpt", Server: remB}
	e.far.infos["r_record00"] = rec
	if ri, ok := e.s.RunOf("r_record00"); !ok || ri != rec {
		t.Errorf("a run record: %+v %v", ri, ok)
	}
	if _, ok := e.s.RunOf("r_nobody00"); ok {
		t.Error("RunOf of no run")
	}
	e.s.Remote = nil
	if _, ok := e.s.RunOf("r_record00"); ok {
		t.Error("RunOf of a record with no other servers")
	}
}

// A draft whose start may have arrived is deleted on its server too, once it is gone here.
func TestRemoteDeleteDropsAnUnconfirmedDraft(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	unc := e.on("r_unconfir", func(m *model.RunMeta) { m.RemoteStart = model.RemoteUnconfirmed })
	plain := e.on("r_plain000", nil)
	local := e.draft("r_local000")
	var state []string
	e.far.onDrop = func(entry, run string) {
		_, err := e.s.run(run)
		_, dirErr := os.Stat(e.s.Store.P.RunDir(run))
		e.s.AwaitStart(run) // the creation lock is free
		e.s.svcLock(run)()  // and so is the op lock
		state = append(state, fmt.Sprintf("%s gone=%v folder=%v", run, errors.Is(err, ErrNotFound), errors.Is(dirErr, os.ErrNotExist)))
	}
	for _, r := range []*run{unc, plain, local} {
		if err := e.s.Delete(r.id); err != nil {
			t.Fatal(err)
		}
	}
	e.far.mu.Lock()
	dropped := slices.Clone(e.far.dropped)
	e.far.mu.Unlock()
	if !slices.Equal(dropped, []string{remB + " " + unc.id}) {
		t.Errorf("DropRun calls: %v", dropped)
	}
	if !slices.Equal(state, []string{unc.id + " gone=true folder=true"}) {
		t.Errorf("at the DropRun call: %v", state)
	}
	if kinds := svcKinds(e.events()); !slices.Equal(kinds, []string{"run_removed", "run_removed", "run_removed"}) {
		t.Errorf("events: %v", kinds)
	}
}

// While the start of a draft on another server is being made, what the start sends is fixed and
// the draft cannot be deleted; its name, its group and the goal that is typed stay free.
func TestRemoteDraftWhileItsStartIsMade(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	svcGroupAdd(t, e.s, model.Group{ID: "g_other", Name: "Other"})
	r := e.on("r_starting", nil)
	local := e.draft("r_local000")
	e.far.starting(r.id, true)
	e.far.starting(local.id, true) // never asked: a draft of this computer has no start elsewhere
	e.far.checks()
	before := svcMetaOnDisk(t, r)
	for what, p := range map[string]PatchReq{
		"the server":   {Server: svcPtr(model.LocalServer)},
		"another":      {Server: svcPtr(remC)},
		"the agent":    {Agent: svcPtr(model.Cursor)},
		"the tiers":    {Tiers: &TiersPatch{Deep: &TierPatch{Model: svcPtr("far-sonnet-9")}}},
		"the folder":   {Cwd: svcPtr("~/proj")},
		"the settings": {Settings: &SettingsPatch{MaxParallel: svcPtr(9)}},
		"with a name":  {Name: svcPtr("Not taken"), Settings: &SettingsPatch{MaxTurns: svcPtr(9)}},
	} {
		if _, err := e.s.Patch(r.id, p); !errors.Is(err, ErrStarting) {
			t.Errorf("a change of %s while the start is made: %v", what, err)
		}
	}
	if err := e.s.Delete(r.id); !errors.Is(err, ErrStarting) {
		t.Fatalf("a delete while the start is made: %v", err)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("a refused change asked %v", got)
	}
	if got := svcMetaOnDisk(t, r); !reflect.DeepEqual(got, before) {
		t.Fatalf("a refused change wrote run.json: %+v", got)
	}
	if _, ok := e.s.RemoteDraft(r.id); !ok || len(e.far.dropped) != 0 {
		t.Fatalf("the refused delete: a draft %v, dropped %v", ok, e.far.dropped)
	}
	if ErrStarting.Error() != "The run is being started." {
		t.Errorf("the sentence: %q", ErrStarting)
	}
	// What the start does not send stays free.
	if v := e.patch(r.id, PatchReq{Name: svcPtr("Renamed"), Group: svcPtr("g_other")}); v.Name != "Renamed" || v.Group != "g_other" {
		t.Errorf("a rename and a move while the start is made: %+v", v)
	}
	if err := e.s.SetDraft(r.id, model.Draft{Text: "typed on"}); err != nil {
		t.Errorf("the goal's draft text while the start is made: %v", err)
	}
	// A draft of this computer is not asked about.
	if v := e.patch(local.id, PatchReq{Settings: &SettingsPatch{MaxParallel: svcPtr(9)}}); v.Settings.MaxParallel != 9 {
		t.Errorf("a draft of this computer: %+v", v)
	}
	if err := e.s.Delete(local.id); err != nil {
		t.Errorf("the delete of a draft of this computer: %v", err)
	}
	// The start has ended with nothing started: everything is free again.
	e.far.starting(r.id, false)
	if v := e.patch(r.id, PatchReq{Settings: &SettingsPatch{MaxParallel: svcPtr(9)}}); v.Settings.MaxParallel != 9 {
		t.Errorf("after the start: %+v", v)
	}
	if err := e.s.Delete(r.id); err != nil {
		t.Errorf("the delete after the start: %v", err)
	}
}

// After a restart the runs are loaded before the other servers are known (Remote is nil): every
// draft on one of them then says that its server is gone. RemoteReady, called when Remote is set,
// puts that right with no server asked.
func TestRemoteReadyAfterARestart(t *testing.T) {
	t.Parallel()
	const offline = "Bee is not connected: the folder cannot be checked and the run cannot start."
	e := newRemEnv(t)
	away := e.on("r_away0000", nil)
	up := e.on("r_up000000", func(m *model.RunMeta) {
		m.Server, m.Agent, m.Tiers, m.Cwd = remC, model.Pi, tiersAll("pi-x", ""), "/home/sea"
	})
	bare := e.on("r_bare0000", func(m *model.RunMeta) { m.Server, m.Agent, m.Tiers, m.Cwd = remC, "", model.RunTiers{}, "/home/sea" })
	sent := e.on("r_sent0000", func(m *model.RunMeta) { m.RemoteStart = model.RemoteUnconfirmed })
	lost := e.on("r_lost0000", func(m *model.RunMeta) { m.Server = "s_removed" })
	local := e.draft("r_local000")
	e.far.change(remB, func(en *chats.RemoteEntry) { en.Connected = false })

	// The program's order: Load with no other servers, then they are set.
	e.restart(nil)
	blocked := func() map[string]string {
		out := map[string]string{}
		for _, v := range e.s.Views() {
			out[v.ID] = v.Blocked
		}
		return out
	}
	for id, b := range blocked() {
		if id != local.id && b != svcServerGone {
			t.Fatalf("%s before the other servers are known: %q", id, b)
		}
	}
	e.events()
	e.s.Remote = e.far
	e.far.checks()
	e.s.RemoteReady()
	want := map[string]string{
		away.id:  offline,
		up.id:    "",
		bare.id:  "The run has no agent: choose one of Sea.",
		sent.id:  "",
		lost.id:  svcServerGone,
		local.id: blocked()[local.id],
	}
	if got := blocked(); !reflect.DeepEqual(got, want) {
		t.Errorf("after RemoteReady:\n got %q\nwant %q", got, want)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("RemoteReady asked %v", got)
	}
	for _, v := range e.s.Views() {
		if v.ID == sent.id && v.Start != model.RemoteUnconfirmed {
			t.Errorf("the draft whose start may have arrived: %+v", v)
		}
	}
	// The pages are told of every draft that says something else now, and of no other run.
	told := map[string]bool{}
	for _, ev := range e.events() {
		if re, ok := ev.(svcRunEvent); ok {
			told[re.Run.ID] = true
		}
	}
	if !reflect.DeepEqual(told, map[string]bool{away.id: true, up.id: true, bare.id: true, sent.id: true}) {
		t.Errorf("the runs with a `run` event: %v", told)
	}
	// A second call changes nothing.
	e.s.RemoteReady()
	if evs := e.events(); len(evs) != 0 || !reflect.DeepEqual(blocked(), want) {
		t.Errorf("a second RemoteReady: %v", svcKinds(evs))
	}
}

// Start makes no start of a draft that will start on another server, and leaves it as it is.
func TestRemoteStartIsNotMadeHere(t *testing.T) {
	t.Parallel()
	e := newRemEnv(t)
	r := e.on("r_start000", func(m *model.RunMeta) { m.Draft = &model.Draft{Text: "the goal"} })
	before := svcMetaOnDisk(t, r)
	for _, goal := range []string{"the goal", ""} {
		if _, err := e.s.Start(r.id, goal); !errors.Is(err, ErrRemoteStart) {
			t.Errorf("Start(%q): %v", goal, err)
		}
	}
	if got := svcMetaOnDisk(t, r); !reflect.DeepEqual(got, before) {
		t.Errorf("run.json after: %+v", got)
	}
	if ents, _ := os.ReadDir(r.dir); len(ents) != 1 {
		t.Errorf("the draft's folder after: %v", ents)
	}
	if calls := e.fake.called(); len(calls) != 0 {
		t.Errorf("the engine was called: %v", calls)
	}
	if got := e.far.checks(); len(got) != 0 {
		t.Errorf("Start asked %v", got)
	}
}
