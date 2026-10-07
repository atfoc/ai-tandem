package runs

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

func svcPtr[T any](v T) *T { return &v }

// svcGroupAdd makes a group in the store.
func svcGroupAdd(t testing.TB, s *Service, g model.Group) {
	t.Helper()
	if err := s.Store.Update(func(st *model.State) error { st.Groups = append(st.Groups, g); return nil }); err != nil {
		t.Fatal(err)
	}
}

func svcMetaOnDisk(t testing.TB, r *run) model.RunMeta {
	t.Helper()
	m, err := readMeta(r.dir)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestSvcCreate(t *testing.T) {
	e := newSvcEnv(t)
	svcGroupAdd(t, e.s, model.Group{ID: "g_one", Name: "One"})
	svcGroupAdd(t, e.s, model.Group{ID: "g_old", Name: "Old", Archive: model.Archive{Archived: true, Op: "a1"}})

	if _, err := e.s.Create("", ""); err == nil || !strings.Contains(err.Error(), "group is empty") {
		t.Fatalf("no group: %v", err)
	}
	if _, err := e.s.Create("g_nope", ""); !errors.Is(err, ErrGroup) {
		t.Fatalf("a group that does not exist: %v", err)
	}
	if _, err := e.s.Create("g_old", ""); !errors.Is(err, ErrGroupArchived) {
		t.Fatalf("an archived group: %v", err)
	}
	if _, err := e.s.Create("g_one", strings.Repeat("n", 81)); !errors.Is(err, errLongName) {
		t.Fatalf("a long name: %v", err)
	}
	if len(e.s.Views()) != 0 {
		t.Fatal("a refused create made a run")
	}

	v, err := e.s.Create("g_one", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(v.ID, "r_") || len(v.ID) != 10 || v.Name != DefaultName || v.UserNamed || v.Group != "g_one" || v.Status != model.RunDraft ||
		v.Agent != model.Claude || v.Tiers != svcClaudeTiers || v.TierDefaults == nil || *v.TierDefaults != svcClaudeTiers || v.Cwd != e.cwd || v.Settings != model.DefaultRunSettings() || !v.Created.Equal(e.clock.Now()) ||
		v.Git || v.FolderMissing || v.Blocked != "" || !v.Started.IsZero() {
		t.Fatalf("the new run: %+v", v)
	}
	r, _ := e.s.run(v.ID)
	if m := svcMetaOnDisk(t, r); m.ID != v.ID || m.Tiers != v.Tiers || m.Group != "g_one" {
		t.Fatalf("run.json: %+v", m)
	}
	if ents, _ := os.ReadDir(r.dir); len(ents) != 1 {
		t.Fatalf("a draft's folder holds %d files", len(ents))
	}
	named, err := e.s.Create(model.Ungrouped, "  The   importer run ")
	if err != nil || named.Name != "The importer run" || !named.UserNamed {
		t.Fatalf("a run made with a name: %+v %v", named, err)
	}
	if got := svcKinds(e.events()); fmt.Sprint(got) != "[run run]" {
		t.Fatalf("events: %v", got)
	}
	if vs := e.s.Views(); len(vs) != 2 || vs[0].ID != v.ID && vs[1].ID != v.ID {
		t.Fatalf("views: %+v", vs)
	}
	if ms := e.s.List(); len(ms) != 2 {
		t.Fatalf("list: %+v", ms)
	}

	// What the run started last in the group used, on the local server: its agent and the
	// settings the composer shows; the setup command only for the folder it was used in. What a
	// run on another server used is that server's.
	other := t.TempDir()
	svcGroupAdd(t, e.s, model.Group{ID: "g_two", Name: "Two"})
	svcGroupAdd(t, e.s, model.Group{ID: "g_three", Name: "Three"})
	far := &model.RunDefaults{Agent: model.Claude, MaxParallel: 4, MaxTurns: 44, MaxCost: 4, Setup: "far", SetupCwd: e.cwd}
	if err := e.s.Store.Update(func(st *model.State) error {
		st.Defaults.Groups = map[string]model.GroupDefaults{
			"g_one": {Servers: map[string]model.ServerDefaults{
				model.LocalServer: {Run: &model.RunDefaults{Agent: model.Pi, MaxParallel: 2, MaxTurns: 90, MaxCost: 12.5, Setup: "npm ci", SetupCwd: e.cwd},
					ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: {Model: "deepseek-flash", Effort: "high"}}},
				"srv_far": {Run: far},
			}},
			"g_two": {Servers: map[string]model.ServerDefaults{"srv_far": {Run: far}}},
			model.Ungrouped: model.LocalDefaults(model.ServerDefaults{
				Run: &model.RunDefaults{Agent: model.Cursor, MaxParallel: 99, MaxTurns: 30, Setup: "make", SetupCwd: other}}),
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	v, _ = e.s.Create("g_one", "")
	want := model.DefaultRunSettings()
	want.MaxParallel, want.MaxTurns, want.MaxCost, want.Setup = 2, 90, 12.5, "npm ci"
	if v.Agent != model.Pi || v.Tiers != tiersAll("deepseek-flash", "") || v.Settings != want {
		t.Fatalf("a run in a group with run defaults: %+v", v)
	}
	// No run record in the group for the local server: the ungrouped group's; a value out of range
	// and a setup command of another folder are not taken over.
	for _, g := range []string{"g_two", "g_three"} {
		v, _ = e.s.Create(g, "")
		if v.Agent != model.Cursor || v.Settings != model.DefaultRunSettings() {
			t.Fatalf("a run in %s, a group without run defaults: %+v", g, v)
		}
	}
	// The ungrouped group takes its own.
	v, _ = e.s.Create(model.Ungrouped, "")
	if v.Agent != model.Cursor || v.Settings != model.DefaultRunSettings() {
		t.Fatalf("a run in the ungrouped group: %+v", v)
	}
	// There is no "last used": with no record of its own the ungrouped group has the built-in
	// ones, whatever another group holds.
	if err := e.s.Store.Update(func(st *model.State) error {
		delete(st.Defaults.Groups, model.Ungrouped)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, g := range []string{model.Ungrouped, "g_two"} {
		v, _ = e.s.Create(g, "")
		if v.Agent != model.Claude || v.Settings != model.DefaultRunSettings() {
			t.Fatalf("a run in %s with no run defaults anywhere but in g_one: %+v", g, v)
		}
	}
}

func TestSvcPatch(t *testing.T) {
	e := newSvcEnv(t)
	svcGroupAdd(t, e.s, model.Group{ID: "g_one", Name: "One"})
	v, _ := e.s.Create(model.Ungrouped, "")
	r, _ := e.s.run(v.ID)
	other := t.TempDir()
	e.events()

	// Everything at once, in the order of the request's fields.
	got, err := e.s.Patch(v.ID, PatchReq{Name: svcPtr("  Port   it "), Group: svcPtr("g_one"), Tiers: svcTier("light", "opus", "high"), Cwd: svcPtr(other),
		Settings: &SettingsPatch{MaxParallel: svcPtr(8), MaxTurns: svcPtr(120), MaxCost: svcPtr(25.0), Setup: svcPtr(" npm ci "), Wake: svcPtr("idle")}})
	if err != nil {
		t.Fatal(err)
	}
	set := model.DefaultRunSettings()
	set.MaxParallel, set.MaxTurns, set.MaxCost, set.Setup, set.Wake = 8, 120, 25, "npm ci", "idle"
	if got.Name != "Port it" || !got.UserNamed || got.Group != "g_one" || got.Tiers.Light != (model.ModelChoice{Model: "opus", Effort: "high"}) || got.Tiers.Deep != svcClaudeTiers.Deep || got.Cwd != other || got.Settings != set {
		t.Fatalf("patched: %+v", got)
	}
	if m := svcMetaOnDisk(t, r); m.Name != "Port it" || m.Settings != set || m.Cwd != other {
		t.Fatalf("run.json: %+v", m)
	}
	if kinds := svcKinds(e.events()); fmt.Sprint(kinds) != "[run]" {
		t.Fatalf("events: %v", kinds)
	}

	// A refused part changes nothing, also not the parts before it.
	before := svcMetaOnDisk(t, r)
	for name, req := range map[string]PatchReq{
		"an empty name":             {Name: svcPtr("  ")},
		"a group that is not":       {Name: svcPtr("x"), Group: svcPtr("g_nope")},
		"an agent that is not":      {Name: svcPtr("x"), Agent: svcPtr(model.AgentKind("gemini"))},
		"a model that is not":       {Name: svcPtr("x"), Tiers: svcTier("deep", "gpt-9", "")},
		"an empty model":            {Tiers: &TiersPatch{Standard: &TierPatch{Model: svcPtr("")}}},
		"an effort the model lacks": {Name: svcPtr("x"), Tiers: svcTier("standard", "", "ludicrous")},
		"a folder that is not":      {Name: svcPtr("x"), Cwd: svcPtr(filepath.Join(other, "nope"))},
		"the app's own folder":      {Name: svcPtr("x"), Cwd: svcPtr(e.root)},
		"too many at once":          {Name: svcPtr("x"), Settings: &SettingsPatch{MaxParallel: svcPtr(17)}},
		"none at once":              {Settings: &SettingsPatch{MaxParallel: svcPtr(0)}},
		"too many turns":            {Settings: &SettingsPatch{MaxTurns: svcPtr(501)}},
		"no turn":                   {Settings: &SettingsPatch{MaxTurns: svcPtr(0)}},
		"a negative cost limit":     {Settings: &SettingsPatch{MaxCost: svcPtr(-1.0)}},
		"a setup of two lines":      {Settings: &SettingsPatch{Setup: svcPtr("a\nb")}},
		"a setup that is too long":  {Settings: &SettingsPatch{Setup: svcPtr(strings.Repeat("x", 2001))}},
		"a wake mode that is not":   {Settings: &SettingsPatch{MaxTurns: svcPtr(5), Wake: svcPtr("never")}},
	} {
		if _, err := e.s.Patch(v.ID, req); err == nil {
			t.Fatalf("%s was accepted", name)
		}
		if after := svcMetaOnDisk(t, r); !svcSameJSON(after, before) || r.viewNow().Name != "Port it" {
			t.Fatalf("%s changed the run: %+v", name, after)
		}
	}
	if _, err := e.s.Patch(v.ID, PatchReq{Group: svcPtr("g_nope")}); !errors.Is(err, ErrGroup) {
		t.Fatalf("a group that does not exist: %v", err)
	}
	if _, err := e.s.Patch(v.ID, PatchReq{Cwd: svcPtr(e.root)}); !errors.Is(err, chats.ErrAppFolder) {
		t.Fatalf("the app's folder: %v", err)
	}
	if _, err := e.s.Patch("r_nope", PatchReq{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a run that does not exist: %v", err)
	}

	// A new model keeps the effort only when it has it; a cost limit of 0 is no limit.
	got, _ = e.s.Patch(v.ID, PatchReq{Tiers: svcTier("light", "haiku", ""), Settings: &SettingsPatch{MaxCost: svcPtr(0.0)}})
	if got.Tiers.Light != (model.ModelChoice{Model: "haiku"}) || got.Settings.MaxCost != 0 {
		t.Fatalf("after a model without efforts: %+v", got)
	}
	// A new agent brings its own model for the group; the folder and the settings stay.
	if err := e.s.Store.Update(func(st *model.State) error {
		st.Defaults.Groups = map[string]model.GroupDefaults{"g_one": model.LocalDefaults(model.ServerDefaults{ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: {Model: "deepseek-flash", Effort: "low"}}})}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	got, err = e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Pi)})
	if err != nil || got.Agent != model.Pi || got.Tiers != tiersAll("deepseek-flash", "") || *got.TierDefaults != got.Tiers || got.Cwd != other || got.Settings.MaxTurns != 120 {
		t.Fatalf("after a new agent: %+v %v", got, err)
	}
	// An agent with no model known yet: the choice may be empty, and the start asks for one.
	got, _ = e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Cursor)})
	if got.Agent != model.Cursor || got.Tiers != (model.RunTiers{}) {
		t.Fatalf("after an agent with no known models: %+v", got)
	}
	if _, err := e.s.Start(v.ID, "Do it."); !errors.Is(err, ErrNoModel) {
		t.Fatalf("a start without a model: %v", err)
	}

	// Move is the group alone.
	if err := e.s.Move(v.ID, model.Ungrouped); err != nil || r.viewNow().Group != model.Ungrouped {
		t.Fatalf("move: %v", err)
	}
	if err := e.s.Move(v.ID, "g_nope"); !errors.Is(err, ErrGroup) {
		t.Fatalf("move to a group that does not exist: %v", err)
	}

	// An archived draft: its name and group can change, its setup cannot.
	if err := e.s.Archive(v.ID, model.Archive{Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Patch(v.ID, PatchReq{Settings: &SettingsPatch{MaxTurns: svcPtr(5)}}); !errors.Is(err, ErrArchived) {
		t.Fatalf("settings of an archived draft: %v", err)
	}
	if got, err := e.s.Patch(v.ID, PatchReq{Name: svcPtr("Kept")}); err != nil || got.Name != "Kept" || !got.Archived {
		t.Fatalf("the name of an archived draft: %+v %v", got, err)
	}
}

func svcSameJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func TestSvcSetDraft(t *testing.T) {
	e := newSvcEnv(t)
	r := e.draft("r_draft")
	e.events()
	// The sender sends the view as it is when it gets to a change, so saves that follow each other
	// faster than it sends reach the clients as fewer events. The test lets it get to each save
	// before the next: one `run` event per save, with the draft as that save left it.
	sent := func(what string, want *model.Draft) {
		t.Helper()
		evs := e.events()
		views := svcRunEvents(evs, "r_draft")
		if len(evs) != 1 || len(views) != 1 || !svcSameJSON(views[0].Draft, want) {
			t.Fatalf("%s: events %v, views %+v", what, svcKinds(evs), views)
		}
	}
	d := model.Draft{Text: "Port the imp"}
	if err := e.s.SetDraft("r_draft", d); err != nil {
		t.Fatal(err)
	}
	if v := r.viewNow(); v.Draft == nil || v.Draft.Text != "Port the imp" || svcMetaOnDisk(t, r).Draft == nil {
		t.Fatalf("the draft: %+v", v.Draft)
	}
	sent("the first save", &d)
	first := r.viewNow().Draft
	if err := e.s.SetDraft("r_draft", model.Draft{Text: "Port the importer"}); err != nil || first.Text != "Port the imp" || r.viewNow().Draft.Text != "Port the importer" {
		t.Fatalf("a second save changed the first in place, or was not kept: %v", err)
	}
	sent("the second save", &model.Draft{Text: "Port the importer"})
	if err := e.s.SetDraft("r_draft", model.Draft{}); err != nil || r.viewNow().Draft != nil || svcMetaOnDisk(t, r).Draft != nil {
		t.Fatalf("an empty draft did not clear it: %v", err)
	}
	sent("the empty save", nil)
	// Saves that do not wait for the sender: however many events they become, the last one is the
	// draft as the last save left it.
	for i := 1; i <= 40; i++ {
		if err := e.s.SetDraft("r_draft", model.Draft{Text: fmt.Sprintf("Port the importer, %d", i)}); err != nil {
			t.Fatal(err)
		}
	}
	if views := svcRunEvents(e.events(), "r_draft"); len(views) == 0 || len(views) > 40 || views[len(views)-1].Draft == nil || views[len(views)-1].Draft.Text != "Port the importer, 40" {
		t.Fatalf("after 40 saves in a row the clients have: %+v", views)
	}
	if err := e.s.SetDraft("r_nope", d); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a run that does not exist: %v", err)
	}
}

// The table "what a mutating route does per status" of the contract (T13 §6), at service level:
// every mutation in every status of a run.
func TestSvcStatusMatrix(t *testing.T) {
	halted := func(s model.RunStatus) bool {
		return s == model.RunStopped || s == model.RunStalled || s == model.RunError
	}
	n := 0
	each := func(name string, check func(t *testing.T, e *svcEnv, r *run, st model.RunStatus)) {
		for _, st := range svcStatuses {
			n++
			id := fmt.Sprintf("r_m%03d", n)
			t.Run(name+"/"+string(st), func(t *testing.T) {
				e := newSvcEnv(t)
				r := e.in(id, st)
				if got := r.viewNow().Status; got != st {
					t.Fatalf("the run is %s", got)
				}
				e.events()
				check(t, e, r, st)
			})
		}
	}

	each("patch name and group", func(t *testing.T, e *svcEnv, r *run, st model.RunStatus) {
		svcGroupAdd(t, e.s, model.Group{ID: "g_one", Name: "One"})
		v, err := e.s.Patch(r.id, PatchReq{Name: svcPtr("Renamed"), Group: svcPtr("g_one")})
		if err != nil || v.Name != "Renamed" || !v.UserNamed || v.Group != "g_one" || v.Status != st {
			t.Fatalf("%+v %v", v, err)
		}
	})
	each("patch agent, model, effort, folder, settings", func(t *testing.T, e *svcEnv, r *run, st model.RunStatus) {
		reqs := []PatchReq{{Agent: svcPtr(model.Pi)}, {Tiers: svcTier("deep", "opus", "")}, {Tiers: svcTier("deep", "", "high")}, {Cwd: svcPtr(t.TempDir())}, {Settings: &SettingsPatch{MaxTurns: svcPtr(9)}}}
		for i, req := range reqs {
			_, err := e.s.Patch(r.id, req)
			if st == model.RunDraft && err != nil {
				t.Fatalf("request %d on a draft: %v", i, err)
			}
			if st != model.RunDraft && !errors.Is(err, ErrStarted) {
				t.Fatalf("request %d on a started run: %v", i, err)
			}
		}
		if st != model.RunDraft && !svcSameJSON(svcMetaOnDisk(t, r).Settings, model.DefaultRunSettings()) {
			t.Fatal("a refused patch changed run.json")
		}
	})
	each("put draft", func(t *testing.T, e *svcEnv, r *run, st model.RunStatus) {
		if err := e.s.SetDraft(r.id, model.Draft{Text: "typed late"}); err != nil {
			t.Fatal(err)
		}
		saved := r.viewNow().Draft != nil && svcMetaOnDisk(t, r).Draft != nil
		if saved != (st == model.RunDraft) {
			t.Fatalf("saved: %v", saved)
		}
		if got := len(e.events()); (got == 1) != (st == model.RunDraft) || got > 1 {
			t.Fatalf("%d events", got)
		}
	})
	each("start", func(t *testing.T, e *svcEnv, r *run, st model.RunStatus) {
		v, err := e.s.Start(r.id, "Port the importer.")
		if st != model.RunDraft {
			if !errors.Is(err, ErrStarted) || len(e.fake.called()) != 0 {
				t.Fatalf("%v; the engine: %v", err, e.fake.called())
			}
			return
		}
		if err != nil || v.Status != model.RunRunning || v.Started.IsZero() || v.Draft != nil || fmt.Sprint(e.fake.called()) != "[start "+r.id+"]" {
			t.Fatalf("%+v %v; the engine: %v", v, err, e.fake.called())
		}
	})
	each("stop", func(t *testing.T, e *svcEnv, r *run, st model.RunStatus) {
		e.fake.set(func(f *svcFake) { f.stay = true })
		v, err := e.s.Stop(r.id)
		switch {
		case st == model.RunDraft:
			if !errors.Is(err, ErrNotStarted) {
				t.Fatal(err)
			}
		case st == model.RunRunning:
			if err != nil || v.Status != model.RunStopping || fmt.Sprint(e.fake.called()) != `[halt `+r.id+` stopped "stopped by the user" user]` {
				t.Fatalf("%+v %v; the engine: %v", v, err, e.fake.called())
			}
			// Asked again while it stops: the same answer, and the engine is not asked twice.
			if v, err := e.s.Stop(r.id); err != nil || v.Status != model.RunStopping || len(e.fake.called()) != 1 {
				t.Fatalf("a second stop: %+v %v", v, err)
			}
		case st == model.RunStopping:
			if err != nil || v.Status != model.RunStopping || len(e.fake.called()) != 0 || len(e.events()) != 0 {
				t.Fatalf("%+v %v; the engine: %v", v, err, e.fake.called())
			}
		default:
			if !errors.Is(err, ErrNotRunning) || len(e.fake.called()) != 0 {
				t.Fatal(err)
			}
		}
	})
	each("resume", func(t *testing.T, e *svcEnv, r *run, st model.RunStatus) {
		v, err := e.s.Resume(r.id, ResumeReq{})
		want := map[model.RunStatus]error{model.RunDraft: ErrNotStarted, model.RunRunning: ErrNotHalted, model.RunStopping: ErrStopping,
			model.RunCompleted: ErrFinished, model.RunGaveUp: ErrFinished}[st]
		if halted(st) {
			if err != nil || v.Status != model.RunRunning || v.Reason != "" || v.StalledBy != "" || fmt.Sprint(e.fake.called()) != "[resume "+r.id+"]" {
				t.Fatalf("%+v %v; the engine: %v", v, err, e.fake.called())
			}
			if stops := svcState(t, r).Stops; len(stops) != 1 || stops[0].ResumedAt == 0 {
				t.Fatalf("stops: %+v", stops)
			}
			return
		}
		if !errors.Is(err, want) || len(e.fake.called()) != 0 {
			t.Fatalf("%v, want %v", err, want)
		}
	})
	each("archive", func(t *testing.T, e *svcEnv, r *run, st model.RunStatus) {
		e.host.people[r.id] = []model.ChatMeta{{ID: "c1", Run: r.id}}
		if st == model.RunStopping { // it waits for the stop, which comes
			go func() {
				time.Sleep(30 * time.Millisecond)
				e.fake.halted(r)
			}()
		}
		if err := e.s.Archive(r.id, model.Archive{Op: "op7"}); err != nil {
			t.Fatal(err)
		}
		v := r.viewNow()
		if !v.Archived || v.Op != "op7" || v.Status.Live() || !svcMetaOnDisk(t, r).Archived {
			t.Fatalf("archived: %+v", v)
		}
		if st == model.RunRunning { // stopped first, by the user
			if v.Status != model.RunStopped || fmt.Sprint(e.fake.called()) != `[halt `+r.id+` stopped "the run was archived" user]` {
				t.Fatalf("%s; the engine: %v", v.Status, e.fake.called())
			}
			if stops := svcState(t, r).Stops; len(stops) != 1 || stops[0].Reason != model.StopUser {
				t.Fatalf("stops: %+v", stops)
			}
		} else if len(e.fake.called()) != 0 {
			t.Fatalf("the engine: %v", e.fake.called())
		}
		if fmt.Sprint(e.host.called()) != "[SetArchive c1 true op7 Stop c1]" {
			t.Fatalf("the chats: %v", e.host.called())
		}
	})
	each("delete", func(t *testing.T, e *svcEnv, r *run, st model.RunStatus) {
		e.host.people[r.id] = []model.ChatMeta{{ID: "c1", Run: r.id}}
		e.host.agents[r.id] = []model.ChatMeta{{ID: "a1", Run: r.id, Role: model.RoleOrchestrator}}
		if err := e.s.Delete(r.id); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(r.dir); !os.IsNotExist(err) {
			t.Fatalf("the folder: %v", err)
		}
		if _, err := e.s.View(r.id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("the run is still there: %v", err)
		}
		// Everything is stopped first, the agents' chats go before the people's, the checkouts last.
		if fmt.Sprint(e.fake.called()) != "[stop "+r.id+" removeCheckouts "+r.id+"]" || fmt.Sprint(e.host.called()) != "[DeleteOwned a1 Delete c1]" {
			t.Fatalf("the engine: %v; the chats: %v", e.fake.called(), e.host.called())
		}
		if kinds := svcKinds(e.events()); kinds[len(kinds)-1] != "run_removed" {
			t.Fatalf("events: %v", kinds)
		}
	})
}

// A run that keeps stopping cannot be archived: ErrStopping after the wait, and nothing changes.
func TestSvcArchiveOfARunThatDoesNotStop(t *testing.T) {
	e := newSvcEnv(t)
	e.fake.set(func(f *svcFake) { f.stay = true })
	r := e.in("r_slow", model.RunRunning)
	e.host.people[r.id] = []model.ChatMeta{{ID: "c1", Run: r.id}}
	start := time.Now()
	if err := e.s.Archive(r.id, model.Archive{Op: "op1"}); !errors.Is(err, ErrStopping) {
		t.Fatalf("archive: %v", err)
	}
	if time.Since(start) < e.s.haltWait {
		t.Fatal("it did not wait")
	}
	if v := r.viewNow(); v.Archived || v.Status != model.RunStopping || svcMetaOnDisk(t, r).Archived || len(e.host.called()) != 0 {
		t.Fatalf("something changed: %+v, chats %v", v, e.host.called())
	}
}

func TestSvcArchiveAndUnarchive(t *testing.T) {
	e := newSvcEnv(t)
	r := e.in("r_arch", model.RunStopped)
	e.host.people[r.id] = []model.ChatMeta{{ID: "c1", Run: r.id}, {ID: "c2", Run: r.id, Archive: model.Archive{Archived: true, Op: "earlier"}}, {ID: "c3", Run: r.id}}
	e.host.agents[r.id] = []model.ChatMeta{{ID: "a1", Run: r.id, Role: model.RoleTask}}
	e.events()
	if err := e.s.Archive(r.id, model.Archive{Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	// The chats that were not archived get the run's action and their agents are ended; the
	// run's own agents are left alone.
	if fmt.Sprint(e.host.called()) != "[SetArchive c1 true op1 Stop c1 SetArchive c3 true op1 Stop c3]" {
		t.Fatalf("the chats: %v", e.host.called())
	}
	if kinds := svcKinds(e.events()); fmt.Sprint(kinds) != "[run]" {
		t.Fatalf("events: %v", kinds)
	}
	if info, ok := e.s.RunOf(r.id); !ok || !info.Archived {
		t.Fatalf("RunOf: %+v", info)
	}
	// Archived again: nothing happens, and the first action stays.
	if err := e.s.Archive(r.id, model.Archive{Op: "op2"}); err != nil || r.viewNow().Op != "op1" || len(e.host.called()) != 4 {
		t.Fatalf("a second archive: %v, op %s", err, r.viewNow().Op)
	}
	// Changes and a resume are refused while it is archived.
	if _, err := e.s.Resume(r.id, ResumeReq{}); !errors.Is(err, ErrArchived) {
		t.Fatalf("resume of an archived run: %v", err)
	}
	// Unarchive brings back the chats of the same action, and does not resume the run.
	if err := e.s.Unarchive(r.id); err != nil {
		t.Fatal(err)
	}
	if v := r.viewNow(); v.Archived || v.Op != "" || v.Status != model.RunStopped || svcMetaOnDisk(t, r).Archived {
		t.Fatalf("unarchived: %+v", v)
	}
	if got := e.host.called()[4:]; fmt.Sprint(got) != "[SetArchive c1 false  SetArchive c3 false ]" {
		t.Fatalf("the chats: %v", got)
	}
	if len(e.fake.called()) != 0 {
		t.Fatalf("the engine: %v", e.fake.called())
	}
	if err := e.s.Unarchive(r.id); err != nil || len(e.host.called()) != 6 {
		t.Fatalf("unarchive of a run that is not archived: %v", err)
	}
	if e.s.Archive("r_nope", model.Archive{}) != ErrNotFound || e.s.Unarchive("r_nope") != ErrNotFound || e.s.Delete("r_nope") != ErrNotFound {
		t.Fatal("a run that does not exist")
	}
}

// From the first step of a delete nothing can be written to the run, so a worker that has not
// let go in time writes nothing into the folder that is being removed.
func TestSvcDeleteWhileAWorkerHangs(t *testing.T) {
	e := newSvcEnv(t)
	r := e.in("r_gone", model.RunRunning)
	e.fake.set(func(f *svcFake) { f.stops = false })
	var late error
	stop := e.s.engine.stop
	e.s.engine.stop = func(r *run, wait time.Duration) bool {
		_, late = r.commit(KTaskWait, func(tx *Tx) error { return nil }) // a worker on its way
		return stop(r, wait)
	}
	if err := e.s.Delete(r.id); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(late, ErrNotFound) {
		t.Fatalf("a commit during the delete: %v", late)
	}
	if _, err := r.commit(KTaskWait, func(tx *Tx) error { return nil }); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a commit after the delete: %v", err)
	}
	if _, err := os.Stat(r.dir); !os.IsNotExist(err) {
		t.Fatalf("the folder is back: %v", err)
	}
	if err := e.s.SetDraft(r.id, model.Draft{Text: "x"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a draft for a deleted run: %v", err)
	}
	if kinds := svcKinds(e.events()); kinds[len(kinds)-1] != "run_removed" || strings.Count(fmt.Sprint(kinds), "run_removed") != 1 {
		t.Fatalf("events: %v", kinds)
	}
}

// ---- start -------------------------------------------------------------------------------

// svcStartIn makes a draft whose folder is dir and starts it.
func svcStartIn(t *testing.T, e *svcEnv, dir, goal string) (model.RunView, *run, error) {
	t.Helper()
	v, err := e.s.Create(model.Ungrouped, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Patch(v.ID, PatchReq{Cwd: &dir}); err != nil {
		t.Fatal(err)
	}
	r, _ := e.s.run(v.ID)
	started, err := e.s.Start(v.ID, goal)
	return started, r, err
}

const svcGoal = "# Port the importer\n\nThe old importer reads CSV in three passes. Make it one.\n"

func TestSvcStartInAGitRepository(t *testing.T) {
	repo := agenttest.NewRepo(t)
	repo.Write("README.md", "hello\n")
	head := repo.Commit("first")
	e := newSvcEnv(t)
	e.s.GitEnv = repo.Env()
	e.events()

	draft, _ := e.s.Create(model.Ungrouped, "")
	if v, _ := e.s.Patch(draft.ID, PatchReq{Cwd: svcPtr(repo.Dir())}); !v.Git || v.Blocked != "" {
		t.Fatalf("a draft in a repository: git %v, blocked %q", v.Git, v.Blocked)
	}
	if err := e.s.SetDraft(draft.ID, model.Draft{Text: "Port the"}); err != nil {
		t.Fatal(err)
	}
	e.events()
	before := e.clock.Now()
	e.clock.Advance(3 * time.Second)
	v, err := e.s.Start(draft.ID, svcGoal)
	if err != nil {
		t.Fatal(err)
	}
	r, _ := e.s.run(draft.ID)
	if v.Status != model.RunRunning || !v.Git || v.Draft != nil || !v.Started.Equal(before.Add(3*time.Second)) || v.Name != "Port the importer" || v.UserNamed ||
		v.AsOf != e.clock.Now().UnixMilli() || v.Turns != 0 {
		t.Fatalf("the started run: %+v", v)
	}
	// run.json is the commit point: started, git, the name, no draft.
	if m := svcMetaOnDisk(t, r); m.Started.IsZero() || !m.Git || m.Draft != nil || m.Name != "Port the importer" {
		t.Fatalf("run.json: %+v", m)
	}
	if goal, err := e.s.Goal(v.ID); err != nil || goal.Text != svcGoal {
		t.Fatalf("goal.md: %q %v", goal.Text, err)
	}
	// Entry 1: the commit it starts from, the repository, where its checkouts will be.
	es := readEntries(t, r.dir)
	if len(es) != 1 || es[0].Kind != KRunStarted || es[0].V != 1 {
		t.Fatalf("the journal: %+v", es)
	}
	st := svcState(t, r).State
	work := e.s.Store.P.RunWorkDir(v.ID)
	want := Git{RunGit: model.RunGit{BaseRef: head, IntegrationBranch: "aiwb/" + v.ID + "/integration", Branch: "main"}, Repo: repo.Dir(),
		Integration: filepath.Join(work, "int"), Orchestrator: filepath.Join(work, "orch")}
	if st.Git == nil || *st.Git != want || st.Status != model.RunRunning || st.StartedAt != e.clock.Now().UnixMilli() || st.GoalSize != toolChars(svcGoal) {
		t.Fatalf("entry 1: %+v, git %+v", st, st.Git)
	}
	if _, err := os.Stat(filepath.Join(r.dir, fileState)); err != nil {
		t.Fatalf("no checkpoint: %v", err)
	}
	// Nothing was made in the repository or beside the data folder: that is the engine's.
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Fatalf("the start made %s", work)
	}
	if got := repo.Git("branch", "--list", "aiwb/*"); got != "" {
		t.Fatalf("the start made a branch: %s", got)
	}
	// The detail of a run that has just started.
	d, err := e.s.Detail(v.ID)
	if err != nil || d.Version != 1 || d.Status != model.RunRunning || d.Git == nil || d.Git.BaseRef != head || d.GoalSize != toolChars(svcGoal) ||
		d.Turns == nil || d.Tasks == nil || d.Agents == nil {
		t.Fatalf("detail: %+v %v", d, err)
	}
	// The events: the entry, the run as started, the defaults; and the engine was started last.
	// (Between the entry and run.json the run is still a draft; its view may be sent as that. A
	// view of the draft that was queued before the start, and is sent late, comes before the entry.)
	evs := e.events()
	kinds := svcKinds(evs)
	entry := slices.Index(kinds, "run_detail 1")
	if n := len(kinds); n < 3 || entry < 0 || kinds[n-1] != "defaults" ||
		strings.Trim(strings.Join(kinds[:entry], " ")+" "+strings.Join(kinds[entry+1:n-1], " "), "run ") != "" {
		t.Fatalf("events: %v", kinds)
	}
	if runs := svcRunEvents(evs, v.ID); runs[len(runs)-1].Status != model.RunRunning || runs[len(runs)-1].Started.IsZero() || runs[len(runs)-1].Name != "Port the importer" {
		t.Fatalf("the last `run` event: %+v", runs[len(runs)-1])
	}
	if fmt.Sprint(e.fake.called()) != "[start "+v.ID+"]" {
		t.Fatalf("the engine: %v", e.fake.called())
	}
	// The group remembers what the run was started with.
	var defs model.Defaults
	e.s.Store.Read(func(s *model.State) { defs = s.Defaults })
	own := defs.Groups[model.Ungrouped].On(model.LocalServer)
	rd := own.Run
	if rd == nil || rd.Agent != model.Claude || rd.MaxParallel != 8 || rd.MaxTurns != 60 || rd.SetupCwd != repo.Dir() || len(defs.Groups) != 1 || len(defs.Groups[model.Ungrouped].Servers) != 1 ||
		rd.Tiers == nil || *rd.Tiers != v.Tiers || own.Cwd != repo.Dir() || len(own.ByAgent) != 0 || own.Agent != "" {
		t.Fatalf("defaults: %+v, run %+v", defs.Groups, rd)
	}
	// And the server it started on: the group's next chat or run starts there.
	if got := defs.Groups[model.Ungrouped].Server; got != "local" {
		t.Fatalf("the group's sticky server after the start: %q", got)
	}
	// A second start is refused, and so is every change of what the start fixed.
	if _, err := e.s.Start(v.ID, svcGoal); !errors.Is(err, ErrStarted) {
		t.Fatalf("a second start: %v", err)
	}
	// The chat context of the run names its branch; the checkout is named once it exists.
	ctx := e.s.ChatContext(v.ID)
	if !strings.Contains(ctx, "The run's merged work is on branch aiwb/"+v.ID+"/integration of "+repo.Dir()+". Your working folder is the person's own checkout. The run does not change it while it is going; when the run completes, the app applies the result to it unless that would touch uncommitted changes.") {
		t.Fatalf("chat context:\n%s", ctx)
	}
}

func TestSvcStartFolders(t *testing.T) {
	t.Run("a repository with no commit", func(t *testing.T) {
		repo := agenttest.NewRepo(t)
		e := newSvcEnv(t)
		e.s.GitEnv = repo.Env()
		_, r, err := svcStartIn(t, e, repo.Dir(), svcGoal)
		var be *BlockedError
		if !errors.As(err, &be) || be.Reason != svcNoCommit {
			t.Fatalf("start: %v", err)
		}
		// Still a draft, and its view says why; nothing of a start is left.
		v := r.viewNow()
		if v.Status != model.RunDraft || v.Blocked != be.Reason || !v.Git || !svcMetaOnDisk(t, r).Started.IsZero() || len(e.fake.called()) != 0 {
			t.Fatalf("after the refused start: %+v", v)
		}
		if ents, _ := os.ReadDir(r.dir); len(ents) != 1 {
			t.Fatalf("the folder holds %d files", len(ents))
		}
		// With a first commit it starts.
		repo.Commit("first")
		if v, err := e.s.Start(r.id, svcGoal); err != nil || v.Status != model.RunRunning || v.Blocked != "" {
			t.Fatalf("after a first commit: %+v %v", v, err)
		}
	})
	t.Run("a plain folder", func(t *testing.T) {
		e := newSvcEnv(t)
		dir := t.TempDir()
		v, r, err := svcStartIn(t, e, dir, "fix the build")
		if err != nil || v.Status != model.RunRunning || v.Git || v.Name != "Fix the build" {
			t.Fatalf("start: %+v %v", v, err)
		}
		if st := svcState(t, r).State; st.Git != nil || svcMetaOnDisk(t, r).Git {
			t.Fatalf("a run without git has %+v", st.Git)
		}
		if d, _ := e.s.Detail(v.ID); d.Git != nil {
			t.Fatalf("detail: %+v", d.Git)
		}
		if ctx := e.s.ChatContext(v.ID); !strings.Contains(ctx, "The run's agents work directly in "+dir+", which is also your working folder.") {
			t.Fatalf("chat context:\n%s", ctx)
		}
	})
	t.Run("a repository with uncommitted changes", func(t *testing.T) {
		repo := agenttest.NewRepo(t)
		repo.Write("a.txt", "one\n")
		head := repo.Commit("first")
		repo.Write("a.txt", "two\n")
		repo.Write("new.txt", "untracked\n")
		e := newSvcEnv(t)
		e.s.GitEnv = repo.Env()
		_, r, err := svcStartIn(t, e, repo.Dir(), svcGoal)
		if err != nil {
			t.Fatal(err)
		}
		if g := svcState(t, r).State.Git; g == nil || !g.DirtyAtStart || g.BaseRef != head || g.Sub != "" {
			t.Fatalf("git: %+v", g)
		}
		// The client is told: the detail's git says so, once, and the record keeps its shape (a
		// run stored before the field moved into the wire type loads with the value).
		d, err := e.s.Detail(r.id)
		if err != nil || d.Git == nil || !d.Git.DirtyAtStart {
			t.Fatalf("the detail's git: %+v %v", d.Git, err)
		}
		if b, _ := json.Marshal(d); !strings.Contains(string(b), `"dirtyAtStart":true`) {
			t.Fatalf("the detail on the wire: %s", b)
		}
		if b, _ := json.Marshal(svcState(t, r).State.Git); strings.Count(string(b), `"dirtyAtStart":true`) != 1 {
			t.Fatalf("the recorded git: %s", b)
		}
		var old Git
		if err := json.Unmarshal([]byte(`{"baseRef":"aaaa","integrationBranch":"b","repo":"/repo","dirtyAtStart":true}`), &old); err != nil || !old.DirtyAtStart || old.Repo != "/repo" {
			t.Fatalf("a stored git: %+v %v", old, err)
		}
		// The start touched nothing.
		if b, _ := os.ReadFile(filepath.Join(repo.Dir(), "a.txt")); string(b) != "two\n" {
			t.Fatalf("a.txt: %q", b)
		}
	})
	t.Run("a folder below the top of a repository", func(t *testing.T) {
		repo := agenttest.NewRepo(t)
		repo.Write("services/api/main.go", "package main\n")
		repo.Commit("first")
		e := newSvcEnv(t)
		e.s.GitEnv = repo.Env()
		_, r, err := svcStartIn(t, e, filepath.Join(repo.Dir(), "services", "api"), svcGoal)
		if err != nil {
			t.Fatal(err)
		}
		if g := svcState(t, r).State.Git; g == nil || g.Repo != repo.Dir() || g.Sub != filepath.Join("services", "api") || g.DirtyAtStart {
			t.Fatalf("git: %+v", g)
		}
		// A clean start says nothing of uncommitted changes.
		if d, err := e.s.Detail(r.id); err != nil || d.Git == nil || d.Git.DirtyAtStart {
			t.Fatalf("the detail's git: %+v %v", d.Git, err)
		} else if b, _ := json.Marshal(d); strings.Contains(string(b), "dirtyAtStart") {
			t.Fatalf("the detail on the wire: %s", b)
		}
	})
	t.Run("the name the user gave is kept", func(t *testing.T) {
		e := newSvcEnv(t)
		v, _ := e.s.Create(model.Ungrouped, "")
		if _, err := e.s.Patch(v.ID, PatchReq{Name: svcPtr("My run")}); err != nil {
			t.Fatal(err)
		}
		if got, err := e.s.Start(v.ID, svcGoal); err != nil || got.Name != "My run" || !got.UserNamed {
			t.Fatalf("start: %+v %v", got, err)
		}
		// So is a name given when the run was made.
		v, _ = e.s.Create(model.Ungrouped, "Named at creation")
		if got, err := e.s.Start(v.ID, svcGoal); err != nil || got.Name != "Named at creation" || !got.UserNamed {
			t.Fatalf("start of a run made with a name: %+v %v", got, err)
		}
		// A goal that names nothing leaves the name alone, too.
		v, _ = e.s.Create(model.Ungrouped, "")
		if got, err := e.s.Start(v.ID, "---\n\n!!\n"); err != nil || got.Name != DefaultName {
			t.Fatalf("start with a goal that says nothing: %+v %v", got, err)
		}
	})
	t.Run("what a start is refused for", func(t *testing.T) {
		e := newSvcEnv(t)
		v, _ := e.s.Create(model.Ungrouped, "")
		if _, err := e.s.Start(v.ID, " \n"); !errors.Is(err, ErrNoGoal) {
			t.Fatalf("no goal: %v", err)
		}
		if _, err := e.s.Start("r_nope", "x"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("no run: %v", err)
		}
		// The folder is gone.
		gone := filepath.Join(t.TempDir(), "gone")
		os.Mkdir(gone, 0o755)
		e.s.Patch(v.ID, PatchReq{Cwd: &gone})
		os.Remove(gone)
		var be *BlockedError
		if _, err := e.s.Start(v.ID, "x"); !errors.As(err, &be) || !strings.HasPrefix(be.Reason, "Folder not found: "+gone) {
			t.Fatalf("a missing folder: %v", err)
		}
		if got, _ := e.s.View(v.ID); !got.FolderMissing || got.Status != model.RunDraft {
			t.Fatalf("the view: %+v", got)
		}
		// The agent's program is not installed.
		e.s.Patch(v.ID, PatchReq{Cwd: svcPtr(t.TempDir())})
		e.s.Bins = map[model.AgentKind]string{model.Claude: filepath.Join(t.TempDir(), "no-such-claude")}
		if _, err := e.s.Start(v.ID, "x"); !errors.As(err, &be) || be.Reason != "Claude's program was not found: install it, then start the run" {
			t.Fatalf("a missing program: %v", err)
		}
		if got, _ := e.s.View(v.ID); got.Blocked != be.Reason {
			t.Fatalf("the view: %+v", got)
		}
		e.s.Bins = nil
		// The folder's path has the data folder's name in it: agents refuse every command there.
		inside := filepath.Join(t.TempDir(), "my-data-here")
		os.Mkdir(inside, 0o755)
		e.s.Patch(v.ID, PatchReq{Cwd: &inside})
		if _, err := e.s.Start(v.ID, "x"); !errors.As(err, &be) ||
			be.Reason != "the data folder's name (data) is part of this run's folder or of the place its checkouts go ("+inside+"); agents could not work there" {
			t.Fatalf("a folder with the data folder's name: %v", err)
		}
		// An archived draft.
		e.s.Patch(v.ID, PatchReq{Cwd: svcPtr(t.TempDir())})
		e.s.Archive(v.ID, model.Archive{Op: "op1"})
		if _, err := e.s.Start(v.ID, "x"); !errors.Is(err, ErrArchived) {
			t.Fatalf("an archived draft: %v", err)
		}
		if len(e.fake.called()) != 0 {
			t.Fatalf("the engine: %v", e.fake.called())
		}
	})
}

// ---- resume ---------------------------------------------------------------------------------

// svcStall halts a started run as stalled by a limit.
func svcStall(t *testing.T, e *svcEnv, r *run, by model.StalledBy, reason string) {
	t.Helper()
	e.must(r, KRunStopping, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.Halting = model.RunStopping, &Halting{Status: model.RunStalled, Reason: reason, StalledBy: by, Stop: model.StopStalled}
		return nil
	})
	if err := e.fake.halted(r); err != nil {
		t.Fatal(err)
	}
}

func TestSvcResumeNeedsAHigherLimit(t *testing.T) {
	x := newToolRun(t, false)
	e, r := x.svcEnv, x.r
	x.turnStart("start")
	x.turnEnd("One.", 2.5)
	x.turnStart("idle")
	x.turnEnd("Two.", 3.75)
	svcStall(t, e, r, model.StalledTurns, "reached the limit of 60 orchestrator turns")

	var le *LimitError
	_, err := e.s.Resume(r.id, ResumeReq{})
	if !errors.As(err, &le) || !errors.Is(err, ErrLimit) || err.Error() != "the run reached its limit of 60 orchestrator turns: raise it to resume" {
		t.Fatalf("stalled by turns, no value: %v", err)
	}
	if _, err := e.s.Resume(r.id, ResumeReq{MaxCost: svcPtr(100.0)}); !errors.As(err, &le) {
		t.Fatalf("stalled by turns, the other limit raised: %v", err)
	}
	for _, n := range []int{2, 1, 0, -4} {
		if _, err := e.s.Resume(r.id, ResumeReq{MaxTurns: &n}); err == nil || errors.Is(err, ErrLimit) || err.Error() != "the run has used 2 turns: the limit must be higher" {
			t.Fatalf("maxTurns %d: %v", n, err)
		}
	}
	if _, err := e.s.Resume(r.id, ResumeReq{MaxTurns: svcPtr(501)}); err == nil {
		t.Fatal("maxTurns 501 was accepted")
	}
	if len(e.fake.called()) != 0 || r.viewNow().Settings.MaxTurns != 60 || svcMetaOnDisk(t, r).Settings.MaxTurns != 60 {
		t.Fatalf("a refused resume changed something: %v", e.fake.called())
	}
	v, err := e.s.Resume(r.id, ResumeReq{MaxTurns: svcPtr(80)})
	if err != nil || v.Status != model.RunRunning || v.Settings.MaxTurns != 80 || svcMetaOnDisk(t, r).Settings.MaxTurns != 80 || v.StalledBy != "" {
		t.Fatalf("resumed with a higher limit: %+v %v", v, err)
	}

	// The cost limit.
	r.mu.Lock()
	r.meta.Settings.MaxCost = 5
	r.mu.Unlock()
	svcStall(t, e, r, model.StalledCost, "spent $6.25, over the limit of $5.00")
	if _, err := e.s.Resume(r.id, ResumeReq{}); !errors.As(err, &le) || err.Error() != "the run reached its cost limit of $5.00: raise it to resume" {
		t.Fatalf("stalled by cost, no value: %v", err)
	}
	if _, err := e.s.Resume(r.id, ResumeReq{MaxTurns: svcPtr(90)}); !errors.As(err, &le) {
		t.Fatalf("stalled by cost, the other limit raised: %v", err)
	}
	for _, c := range []float64{6.25, 5, 0.01, -1} {
		if _, err := e.s.Resume(r.id, ResumeReq{MaxCost: &c}); err == nil || errors.Is(err, ErrLimit) {
			t.Fatalf("maxCost %v: %v", c, err)
		}
	}
	if _, err := e.s.Resume(r.id, ResumeReq{MaxCost: svcPtr(6.0)}); err == nil || err.Error() != "the run has spent $6.25: the limit must be higher" {
		t.Fatalf("maxCost below what is spent: %v", err)
	}
	if v, err := e.s.Resume(r.id, ResumeReq{MaxCost: svcPtr(10.0)}); err != nil || v.Status != model.RunRunning || v.Settings.MaxCost != 10 || v.Settings.MaxTurns != 80 {
		t.Fatalf("resumed with a higher cost limit: %+v %v", v, err)
	}
	// No limit at all is a higher limit too.
	svcStall(t, e, r, model.StalledCost, "spent $6.25, over the limit of $10.00")
	if v, err := e.s.Resume(r.id, ResumeReq{MaxCost: svcPtr(0.0)}); err != nil || v.Settings.MaxCost != 0 {
		t.Fatalf("resumed with no cost limit: %+v %v", v, err)
	}
	// Stalled on idle turns: nothing to raise.
	svcStall(t, e, r, model.StalledIdle, "the orchestrator was started 3 times in a row with nothing running")
	if v, err := e.s.Resume(r.id, ResumeReq{}); err != nil || v.Status != model.RunRunning {
		t.Fatalf("resume of a run stalled on idle turns: %+v %v", v, err)
	}
}

func TestSvcResumeBlocked(t *testing.T) {
	repo := agenttest.NewRepo(t)
	repo.Commit("first")
	e := newSvcEnv(t)
	e.s.GitEnv = repo.Env()
	v, r, err := svcStartIn(t, e, repo.Dir(), svcGoal)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Stop(v.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := e.s.Resume(v.ID, ResumeReq{}); err != nil || got.Status != model.RunRunning {
		t.Fatalf("resume in the same repository: %+v %v", got, err)
	}
	e.s.Stop(v.ID)

	// The agent's program is gone.
	var be *BlockedError
	e.s.Bins = map[model.AgentKind]string{model.Claude: filepath.Join(t.TempDir(), "no-such-claude")}
	if _, err := e.s.Resume(v.ID, ResumeReq{}); !errors.As(err, &be) || !strings.HasPrefix(be.Reason, "Claude's program was not found") {
		t.Fatalf("resume without the program: %v", err)
	}
	if got := r.viewNow(); got.Blocked != be.Reason || got.Status != model.RunStopped {
		t.Fatalf("the view: %+v", got)
	}
	e.s.Bins = nil
	// The folder is no longer the repository the run started in.
	if err := os.Rename(filepath.Join(repo.Dir(), ".git"), filepath.Join(repo.Dir(), "dot-git")); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Resume(v.ID, ResumeReq{}); !errors.As(err, &be) || be.Reason != repo.Dir()+" is no longer the git repository this run started in" {
		t.Fatalf("resume in a folder that is no repository any more: %v", err)
	}
	if got, _ := e.s.View(v.ID); got.Blocked != be.Reason || !got.Git {
		t.Fatalf("the view: %+v", got)
	}
	os.Rename(filepath.Join(repo.Dir(), "dot-git"), filepath.Join(repo.Dir(), ".git"))
	// The folder is gone.
	moved := repo.Dir() + "-moved"
	if err := os.Rename(repo.Dir(), moved); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Resume(v.ID, ResumeReq{}); !errors.As(err, &be) || !strings.HasPrefix(be.Reason, "Folder not found: ") {
		t.Fatalf("resume with the folder gone: %v", err)
	}
	if got, _ := e.s.View(v.ID); !got.FolderMissing {
		t.Fatalf("the view: %+v", got)
	}
	os.Rename(moved, repo.Dir())
	if got, err := e.s.Resume(v.ID, ResumeReq{}); err != nil || got.Status != model.RunRunning || got.Blocked != "" || got.FolderMissing {
		t.Fatalf("resume once everything is back: %+v %v", got, err)
	}
	if n := strings.Count(fmt.Sprint(e.fake.called()), "resume "); n != 2 {
		t.Fatalf("the engine resumed %d times: %v", n, e.fake.called())
	}
}

// ---- load and the reads -------------------------------------------------------------------------

// A run folder written by one Service is read by a new one with the same views and detail.
func TestSvcLoad(t *testing.T) {
	e := newSvcEnv(t)
	p := playRun(e.testEnv, "r_played") // every kind of record, through to the end of the run
	live := newToolRunOn(e, "r_live001")
	live.turnStart("start")
	live.ok("orchestrator", "set_notes", toolNotes)
	live.ok("orchestrator", "add_task", toolAdd("Read the old importer", "research", false))
	live.turnEnd("One task.", 0.2)
	live.taskRuns("T01")
	draft, _ := e.s.Create(model.Ungrouped, "A draft")
	e.s.SetDraft(draft.ID, model.Draft{Text: "Port the"})
	if err := os.MkdirAll(filepath.Join(e.s.Store.P.Runs, "r_norunjson", "chats"), 0o700); err != nil { // a folder that is no run
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.s.Store.P.Runs, "stray.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	ids := []string{p.r.id, live.id, draft.ID}
	snapshot := func() string {
		var out []string
		for _, id := range ids {
			if _, err := e.s.View(id); err != nil { // the facts found out, on both sides
				t.Fatal(err)
			}
		}
		b, _ := json.MarshalIndent(e.s.Views(), "", " ")
		out = append(out, string(b))
		for _, id := range ids[:2] {
			d, err := e.s.Detail(id)
			if err != nil {
				t.Fatal(err)
			}
			b, _ := json.MarshalIndent(d, "", " ")
			out = append(out, string(b))
			for _, read := range []func() (any, error){
				func() (any, error) { return e.s.Goal(id) },
				func() (any, error) { return e.s.Notes(id, 0) },
				func() (any, error) { return e.s.Brief(id, "T01", 0) },
			} {
				v, err := read()
				b, _ := json.Marshal(v)
				out = append(out, string(b)+fmt.Sprint(err))
			}
		}
		out = append(out, e.s.ChatContext(live.id), fmt.Sprint(e.s.RunOf(live.id)))
		return strings.Join(out, "\n")
	}
	want := snapshot()
	if len(e.s.Views()) != 3 {
		t.Fatalf("%d runs", len(e.s.Views()))
	}

	e.restart()
	if got := len(e.s.Views()); got != 3 {
		t.Fatalf("%d runs after the restart", got)
	}
	// Before anything asks for its detail, a run is shown from its checkpoint alone.
	r, _ := e.s.run(live.id)
	if v := r.viewNow(); v.Status != model.RunRunning || v.Counts.Work != 1 || v.Turns != 1 {
		t.Fatalf("the view right after the load: %+v", v)
	}
	if got := snapshot(); got != want {
		t.Fatalf("after the restart:\n%s\nbefore:\n%s", got, want)
	}
	// And the loaded run goes on where it was: the next entry has the next number.
	x := &toolRun{svcEnv: e, id: live.id, r: r}
	before := x.state().Version
	x.turnStart("idle")
	if text, isErr := x.orch("get_run", `{}`); isErr || !strings.Contains(text, "T01 [research, reports only, standard] running for ") {
		t.Fatalf("get_run after the restart: %s", text)
	}
	if got := x.state().Version; got != before+2 {
		t.Fatalf("version %d → %d", before, got)
	}
	// A second restart, with entries past the checkpoint.
	want = snapshot()
	e.restart()
	if got := snapshot(); got != want {
		t.Fatalf("after the second restart:\n%s\nbefore:\n%s", got, want)
	}
}

// newToolRunOn starts a run by hand on an env that exists.
func newToolRunOn(e *svcEnv, id string) *toolRun {
	x := &toolRun{svcEnv: e, id: id}
	x.r = x.startRun(id, "Port the importer", false)
	return x
}

func TestSvcReads(t *testing.T) {
	x := toolUpdateRun(t)
	e, id := x.svcEnv, x.id
	x.ok("orchestrator", "update_task", `{"id":"T06","brief":"Remove the old importer once the new one is merged, with its tests and its fixtures."}`)
	x.taskDone("T02")
	draft := e.draft("r_draft")

	// The detail: what clients get, never an engine field.
	d, err := e.s.Detail(id)
	if err != nil || d.Run != id || d.Version != x.state().Version || len(d.Tasks) != 6 || len(d.Turns) != 2 || len(d.Agents) != 6 || len(d.Notes) != 1 {
		t.Fatalf("detail: %d tasks, %d turns, %d agents; %v", len(d.Tasks), len(d.Turns), len(d.Agents), err)
	}
	if b, _ := json.Marshal(d); strings.Contains(string(b), "heldBy") || strings.Contains(string(b), "worktree") || strings.Contains(string(b), `"repo"`) {
		t.Fatalf("an engine field in the detail")
	}
	if _, err := e.s.Detail(draft.id); !errors.Is(err, ErrNotStarted) {
		t.Fatalf("the detail of a draft: %v", err)
	}
	if _, err := e.s.Detail("r_nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the detail of no run: %v", err)
	}
	if g, err := e.s.Goal(id); err != nil || g.Text != "Port the importer.\n" {
		t.Fatalf("goal: %+v %v", g, err)
	}
	if _, err := e.s.Goal(draft.id); !errors.Is(err, ErrNotStarted) {
		t.Fatalf("the goal of a draft: %v", err)
	}

	// Briefs: the one in force, an earlier one, one that is not.
	b, err := e.s.Brief(id, "T06", 0)
	if err != nil || b.Rev != 2 || b.Task != "T06" || !strings.HasPrefix(b.Text, "Remove the old importer") || b.Turn != 2 || b.Size != toolChars(strings.TrimSpace(b.Text)) {
		t.Fatalf("brief in force: %+v %v", b, err)
	}
	if b, err := e.s.Brief(id, "T06", 1); err != nil || b.Rev != 1 || b.Text != toolBrief+"\n" || b.Turn != 1 {
		t.Fatalf("brief 1: %+v %v", b, err)
	}
	if _, err := e.s.Brief(id, "T06", 3); !errors.Is(err, ErrNoVersion) {
		t.Fatalf("brief 3: %v", err)
	}
	for _, task := range []string{"T99", "", "../T01"} {
		if _, err := e.s.Brief(id, task, 0); !errors.Is(err, ErrNoTask) {
			t.Fatalf("brief of %q: %v", task, err)
		}
	}
	if _, err := e.s.Brief(draft.id, "T01", 0); !errors.Is(err, ErrNoTask) {
		t.Fatalf("a brief of a draft: %v", err)
	}

	// Reports and changes.
	rep, err := e.s.Report(id, "T01", 1)
	if err != nil || rep.Outcome != "completed" || rep.Summary != "The old importer reads CSV in three passes." || !strings.HasPrefix(rep.Report, "# Report") || rep.Attempt != 1 {
		t.Fatalf("report: %+v %v", rep, err)
	}
	if _, err := e.s.Report(id, "T05", 1); !errors.Is(err, ErrNoText) { // running: no result yet
		t.Fatalf("the report of a running task: %v", err)
	}
	if _, err := e.s.Report(id, "T01", 2); !errors.Is(err, ErrNoAttempt) {
		t.Fatalf("the report of attempt 2: %v", err)
	}
	if _, err := e.s.Report(id, "T01", 0); !errors.Is(err, ErrNoAttempt) {
		t.Fatalf("the report of attempt 0: %v", err)
	}
	if _, err := e.s.Report(id, "T77", 1); !errors.Is(err, ErrNoTask) {
		t.Fatalf("the report of no task: %v", err)
	}
	ch, err := e.s.Changes(id, "T02", 1)
	if err != nil || ch.Add != 29 || len(ch.Files) != 2 || ch.Merged == "" || ch.Commits == nil {
		t.Fatalf("changes: %+v %v", ch, err)
	}
	if _, err := e.s.Changes(id, "T01", 1); !errors.Is(err, ErrNoText) { // it only reports
		t.Fatalf("the changes of a task that only reports: %v", err)
	}
	if _, err := e.s.Changes(id, "T02", 4); !errors.Is(err, ErrNoAttempt) {
		t.Fatalf("the changes of attempt 4: %v", err)
	}

	// Notes.
	nt, err := e.s.Notes(id, 1)
	if err != nil || nt.V != 1 || nt.Turn != 1 || !strings.HasPrefix(nt.Text, "# Goal") {
		t.Fatalf("notes: %+v %v", nt, err)
	}
	if latest, err := e.s.Notes(id, 0); err != nil || latest.V != 1 {
		t.Fatalf("the latest notes: %+v %v", latest, err)
	}
	if _, err := e.s.Notes(id, 2); !errors.Is(err, ErrNoVersion) {
		t.Fatalf("notes 2: %v", err)
	}
	if _, err := e.s.Notes(draft.id, 0); !errors.Is(err, ErrNoVersion) {
		t.Fatalf("the notes of a draft: %v", err)
	}
}

// What the chat manager asks: asked with a chat's lock held, so answered without the run's.
func TestSvcRunOfAndChatContext(t *testing.T) {
	x := toolUpdateRun(t)
	e := x.svcEnv
	if _, ok := e.s.RunOf("r_nope"); ok || e.s.ChatContext("r_nope") != "" {
		t.Fatal("a run that does not exist")
	}
	draft, _ := e.s.Create(model.Ungrouped, "")
	if info, ok := e.s.RunOf(draft.ID); !ok || info != (chats.RunInfo{Group: model.Ungrouped, Cwd: e.cwd, Agent: model.Claude, Model: "opus", Effort: "high", Draft: true}) {
		t.Fatalf("RunOf a draft: %+v", info)
	}
	want := "<ui-context>\n" +
		`This chat belongs to the run "New run" (id ` + draft.ID + `) in AI Whiteboard: an automated build run in which an orchestrator agent adds tasks and task agents carry them out. ` +
		"Run New run has not started: its goal is still being written in the app. There is nothing to read yet.\n" +
		"You are not one of the run's agents: you talk with the person about the run. Read it with get_run, get_task, get_agent and get_notes. Change tasks only when the person asks (add_task, update_task, cancel_task, retry_task), and pass the person's guidance on with tell_orchestrator. A task you add or change starts after your reply ends.\n" +
		"The run tools are MCP tools of the app's server named board. In your tool list their names may carry that server's prefix (for example mcp__board__get_task). They are not your CLI's own task or todo tools (such as TaskGet, TaskCreate, TaskList, TaskUpdate, TodoWrite), which know nothing about this run.\n" +
		"</ui-context>"
	if got := e.s.ChatContext(draft.ID); got != want {
		t.Fatalf("the context of a chat on a draft:\n%s", got)
	}
	if !strings.Contains(e.s.ChatContext(x.id), "mcp__board__") {
		t.Fatal("the context of a chat on a started run does not say how the run tools are named")
	}

	// A started run with git: its first line as get_run has it, and the integration checkout
	// only while it is there.
	head := "Run Port the importer: running. Turn 2. Tasks: 2 pending, 1 running, 1 merging, 1 done, 1 failed. Spent $2.00 (some agents reported no cost)."
	git := "The run's merged work is on branch aiwb/r_tools001/integration of /repo"
	rest := ". Your working folder is the person's own checkout. The run does not change it while it is going; when the run completes, the app applies the result to it unless that would touch uncommitted changes."
	if got := e.s.ChatContext(x.id); !strings.Contains(got, "carry them out. "+head+"\nYou are not one of") || !strings.Contains(got, "\n"+git+rest+"\n</ui-context>") {
		t.Fatalf("the context of a chat on a running run:\n%s", got)
	}
	checkout := t.TempDir()
	e.s.mu.Lock()
	g := e.s.git[x.id]
	g.integration = checkout
	e.s.git[x.id] = g
	e.s.mu.Unlock()
	if got := e.s.ChatContext(x.id); !strings.Contains(got, "\n"+git+", checked out at "+checkout+": read it there, and never change, commit or check out anything in that folder, because the run merges into it"+rest+"\n") {
		t.Fatalf("with the integration checkout:\n%s", got)
	}

	// Neither takes the run's lock: both answer while it is held.
	x.r.mu.Lock()
	done := make(chan struct{})
	go func() {
		e.s.RunOf(x.id)
		e.s.ChatContext(x.id)
		e.s.Views()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("RunOf, ChatContext or Views waits for the run's lock")
	}
	x.r.mu.Unlock()
}

// svcClaudeTiers is what a new Claude run gets from the built-in catalogue.
var svcClaudeTiers = model.RunTiers{Deep: model.ModelChoice{Model: "opus", Effort: "high"},
	Standard: model.ModelChoice{Model: "opus", Effort: "medium"}, Light: model.ModelChoice{Model: "sonnet", Effort: "medium"}}

// svcTier is a patch of one tier; an empty model or effort is left out.
func svcTier(tier, id, effort string) *TiersPatch {
	tp := &TierPatch{}
	if id != "" {
		tp.Model = &id
	}
	if effort != "" {
		tp.Effort = &effort
	}
	switch tier {
	case "deep":
		return &TiersPatch{Deep: tp}
	case "light":
		return &TiersPatch{Light: tp}
	}
	return &TiersPatch{Standard: tp}
}
