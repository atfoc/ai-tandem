package runs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// sectionOldRun writes the run.json of a run that has not started as an earlier version of the app
// kept it, with the fields more that RunMeta no longer has, and returns the file.
func sectionOldRun(t *testing.T, e *svcEnv, meta model.RunMeta, more map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for k, v := range more {
		m[k] = v
	}
	if raw, err = json.MarshalIndent(m, "", "  "); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(e.s.Store.P.RunDir(meta.ID), fileMeta)
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return file
}

// sectionNoServer fails when the JSON of what names a field of a thing on another server.
func sectionNoServer(t *testing.T, what string, v any) {
	t.Helper()
	raw, ok := v.([]byte)
	if !ok {
		var err error
		if raw, err = json.Marshal(v); err != nil {
			t.Fatal(err)
		}
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("%s: %v", what, err)
	}
	for _, k := range []string{"server", "remoteStart", "start", "gone", "was"} {
		if _, has := m[k]; has {
			t.Errorf("%s has %q: %s", what, k, raw)
		}
	}
}

// A run that has not started and named another server becomes a run of this computer that has
// not started: with what a new run in its group begins with here, and with its goal, name and
// archive mark. What was known of a start there goes. A run of this computer is not touched, and
// a second call finds nothing to do.
func TestSectionRunOfAnotherServerBecomesLocal(t *testing.T) {
	e := newSvcEnv(t)
	svcGroupAdd(t, e.s, model.Group{ID: "g_one", Name: "One"})
	if err := e.s.Store.Update(func(st *model.State) error {
		st.Defaults.Groups = map[string]model.GroupDefaults{"g_one": model.LocalDefaults(model.ServerDefaults{
			Run:     &model.RunDefaults{Agent: model.Pi, MaxParallel: 2, MaxTurns: 90, MaxCost: 12.5, Setup: "npm ci", SetupCwd: e.cwd},
			ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: {Model: "deepseek-flash", Effort: "high"}}})}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	const far, unconfirmed, own = "r_far00001", "r_far00002", "r_own00001"
	there := model.RunMeta{ID: far, Name: "Port the importer", UserNamed: true, Group: "g_one", Created: e.clock.Now(), Agent: model.Claude,
		Tiers: tiersAll("far-1", "low"), Cwd: "/home/bee/work", Settings: model.DefaultRunSettings(),
		Draft: &model.Draft{Text: "the goal, typed for the other server"}, Archive: model.Archive{Archived: true, Op: "a_1"}}
	there.Settings.Setup, there.Settings.Wake = "make far", "each"
	sectionOldRun(t, e, there, map[string]any{"server": "s_bbbbbbbbbbbb"})
	sent := there
	sent.ID, sent.Name, sent.UserNamed, sent.Group, sent.Archive = unconfirmed, DefaultName, false, model.Ungrouped, model.Archive{}
	sentFile := sectionOldRun(t, e, sent, map[string]any{"server": "s_bbbbbbbbbbbb", "remoteStart": "unconfirmed"})
	here := model.RunMeta{ID: own, Name: DefaultName, Group: "g_one", Created: e.clock.Now(), Agent: model.Claude,
		Tiers: tiersAll("sonnet", ""), Cwd: e.cwd, Settings: model.DefaultRunSettings(), Draft: &model.Draft{Text: "a goal of this computer"}}
	ownFile := sectionOldRun(t, e, here, nil)
	ownBefore, err := os.ReadFile(ownFile)
	if err != nil {
		t.Fatal(err)
	}

	e.restart()
	e.events()
	local, err := e.s.LocalOnly()
	if err != nil || !reflect.DeepEqual(local, []string{far, unconfirmed}) {
		t.Fatalf("LocalOnly: %v, %v", local, err)
	}

	// The run in a group: that group's run defaults, on this computer's folder.
	v, err := e.s.View(far)
	if err != nil {
		t.Fatal(err)
	}
	want := model.DefaultRunSettings()
	want.MaxParallel, want.MaxTurns, want.MaxCost, want.Setup, want.Wake = 2, 90, 12.5, "npm ci", "each"
	if v.Status != model.RunDraft || v.Agent != model.Pi || v.Tiers != tiersAll("deepseek-flash", "") || v.Cwd != e.cwd || v.Settings != want ||
		v.FolderMissing || !v.Started.IsZero() {
		t.Fatalf("the run put on this computer: %+v", v)
	}
	if v.Name != "Port the importer" || !v.UserNamed || v.Group != "g_one" || !v.Archived || v.Op != "a_1" ||
		v.Draft == nil || v.Draft.Text != "the goal, typed for the other server" {
		t.Fatalf("what the run keeps: %+v", v)
	}
	// The one whose start may have arrived: a run that has not started, with its goal.
	w, err := e.s.View(unconfirmed)
	if err != nil {
		t.Fatal(err)
	}
	if w.Status != model.RunDraft || w.Agent != model.Claude || w.Tiers != svcClaudeTiers || w.Cwd != e.cwd || w.Settings.Setup != "" ||
		w.Draft == nil || w.Draft.Text != "the goal, typed for the other server" || !w.Started.IsZero() {
		t.Fatalf("the run whose start got no answer: %+v", w)
	}
	for id, view := range map[string]model.RunView{far: v, unconfirmed: w} {
		sectionNoServer(t, "the view of "+id, view)
		raw, err := os.ReadFile(filepath.Join(e.s.Store.P.RunDir(id), fileMeta))
		if err != nil {
			t.Fatal(err)
		}
		sectionNoServer(t, "run.json of "+id, raw)
	}
	if evs := svcRunEvents(e.events(), far); len(evs) == 0 || evs[len(evs)-1].Agent != model.Pi {
		t.Fatalf("the `run` events of the run put here: %+v", evs)
	}
	// A run of this computer is as it was, byte for byte.
	if got, _ := os.ReadFile(ownFile); string(got) != string(ownBefore) {
		t.Fatalf("run.json of a run of this computer: %s\nwas: %s", got, ownBefore)
	}
	if u, err := e.s.View(own); err != nil || u.Agent != model.Claude || u.Tiers != tiersAll("sonnet", "") || u.Draft == nil {
		t.Fatalf("the run of this computer: %+v, %v", u, err)
	}

	// Again, and after a restart: nothing to do, and nothing is written.
	before, err := os.Stat(sentFile)
	if err != nil {
		t.Fatal(err)
	}
	for _, again := range []string{"at once", "after a restart"} {
		if again == "after a restart" {
			e.restart()
		}
		e.events()
		if local, err := e.s.LocalOnly(); err != nil || len(local) != 0 {
			t.Fatalf("LocalOnly again, %s: %v, %v", again, local, err)
		}
		if after, err := os.Stat(sentFile); err != nil || !after.ModTime().Equal(before.ModTime()) {
			t.Fatalf("run.json was written again, %s: %v", again, err)
		}
		if evs := e.events(); len(svcRunEvents(evs, far))+len(svcRunEvents(evs, unconfirmed)) != 0 {
			t.Fatalf("events of a call with nothing to do, %s: %v", again, svcKinds(evs))
		}
	}
	// It is a run of this computer in every way: its folder and its agent can be changed here.
	other := t.TempDir()
	claude := model.Claude
	if got, err := e.s.Patch(unconfirmed, PatchReq{Cwd: &other, Agent: &claude}); err != nil || got.Cwd != other {
		t.Fatalf("a change of the run put here: %+v, %v", got, err)
	}
}

// A new run is a run of this computer, whatever a group's defaults hold: it does not follow a
// server, and neither its run.json nor its view names one.
func TestSectionNewRunIsLocal(t *testing.T) {
	e := newSvcEnv(t)
	svcGroupAdd(t, e.s, model.Group{ID: "g_one", Name: "One"})
	if err := e.s.Store.Update(func(st *model.State) error {
		st.Defaults.Groups = map[string]model.GroupDefaults{"g_one": {Servers: map[string]model.ServerDefaults{
			"inst-far": {Agent: model.Pi, Cwd: "/home/bee/work", Run: &model.RunDefaults{Agent: model.Pi, MaxParallel: 4, MaxTurns: 44}},
		}}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	v, err := e.s.Create("g_one", "")
	if err != nil {
		t.Fatal(err)
	}
	if v.Agent != model.Claude || v.Tiers != svcClaudeTiers || v.Cwd != e.cwd || v.Settings != model.DefaultRunSettings() || v.Blocked != "" {
		t.Fatalf("a new run in a group that holds another server's values: %+v", v)
	}
	sectionNoServer(t, "the view of a new run", v)
	raw, err := os.ReadFile(filepath.Join(e.s.Store.P.RunDir(v.ID), fileMeta))
	if err != nil {
		t.Fatal(err)
	}
	sectionNoServer(t, "run.json of a new run", raw)
	// A patch has no server to name: a body that names one is read without it.
	var p PatchReq
	if err := json.Unmarshal([]byte(`{"server":"s_bbbbbbbbbbbb"}`), &p); err != nil || !reflect.DeepEqual(p, PatchReq{}) {
		t.Fatalf("a patch that names a server: %+v, %v", p, err)
	}
	if b, _ := json.Marshal(PatchReq{}); strings.Contains(string(b), "server") {
		t.Fatalf("a patch names a server: %s", b)
	}
	// The chat manager is told of a run and of nothing else.
	if _, ok := e.s.RunOf("r_nowhere1"); ok {
		t.Fatal("RunOf knows a run this service does not have")
	}
}
