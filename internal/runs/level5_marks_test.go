package runs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// The client mark at level 5 (the contract's 2.8, "The marks"): a run.json from before may hold
// the client id of the API client that started the run ("client"). The file loads and the field
// is not read. So the run is listed like any other run and served without the field, it reads the
// defaults of its group before it starts and records them when it starts, and the next save of
// its run.json writes none.

// svcMarkOnDisk writes the client mark client into the run's run.json, and changes nothing else
// of it: what a server before level 5 left of a run an API client made.
func svcMarkOnDisk(t *testing.T, r *run, client string) {
	t.Helper()
	file := filepath.Join(r.dir, fileMeta)
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["client"], err = json.Marshal(client); err != nil {
		t.Fatal(err)
	}
	if raw, err = json.Marshal(m); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

// svcDiskMark is the client mark the run.json of the run id holds, and whether it holds one.
func svcDiskMark(t *testing.T, s *Service, id string) (mark string, ok bool) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(s.Store.P.RunDir(id), fileMeta))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	v, ok := m["client"]
	mark, _ = v.(string)
	return mark, ok
}

func TestNoRunIsLoadedWithAClientMark(t *testing.T) {
	t.Parallel()
	const (
		client  = "a1a1a1a1-0000-4000-8000-00000000000a"
		group   = "g_one"
		draftID = "r_markdrft"
		runID   = "r_markrun0"
	)
	e := newSvcEnv(t)
	svcGroupAdd(t, e.s, model.Group{ID: group, Name: "One"})
	// The group's choice for Pi is the base of the tiers a Pi run of the group is reset to.
	sticky := model.ModelChoice{Model: "pi-sticky", Effort: "low"}
	if err := e.s.Store.Update(func(st *model.State) error {
		st.Defaults.Groups = map[string]model.GroupDefaults{group: model.LocalDefaults(model.ServerDefaults{
			ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: sticky}})}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	// A run that has not started and one that has, each with a mark in its run.json.
	meta := model.RunMeta{ID: draftID, Name: DefaultName, Group: group, Created: e.clock.Now(), Agent: model.Pi,
		Tiers: tiersAll("some-model", "high"), Cwd: e.cwd, Settings: model.DefaultRunSettings()}
	if err := writeMeta(e.s.Store.P.RunDir(draftID), meta); err != nil {
		t.Fatal(err)
	}
	svcMarkOnDisk(t, newRun(e.s, meta), client)
	svcMarkOnDisk(t, e.started(runID), client)

	// The restart.
	e.boot()
	e.wire()
	if err := e.s.Load(); err != nil {
		t.Fatal(err)
	}
	ids := []string{draftID, runID}
	for _, id := range ids {
		// The load wrote nothing: the mark is still where the server before left it.
		if got, _ := svcDiskMark(t, e.s, id); got != client {
			t.Fatalf("the run.json of %s holds the mark %q before any save", id, got)
		}
		// It is loaded, and served with no mark.
		v, err := e.s.View(id)
		if err != nil {
			t.Fatalf("%s was not loaded: %v", id, err)
		}
		if raw, err := json.Marshal(v); err != nil || strings.Contains(string(raw), `"client"`) || strings.Contains(string(raw), client) {
			t.Fatalf("%s is served with a mark: %s %v", id, raw, err)
		}
	}

	// Both are listed like any other run.
	var listed []string
	for _, v := range e.s.Views() {
		listed = append(listed, v.ID)
		if one, err := e.s.View(v.ID); err != nil || !svcSameJSON(one, v) {
			t.Fatalf("Views gives %+v, View %+v %v", v, one, err)
		}
	}
	slices.Sort(listed)
	if !slices.Equal(listed, ids) {
		t.Fatalf("Views lists %v, want %v", listed, ids)
	}

	// Before it starts the run reads its group's defaults: the tiers it is reset to.
	v, err := e.s.View(draftID)
	if err != nil {
		t.Fatal(err)
	}
	if v.Status != model.RunDraft || v.TierDefaults == nil || v.TierDefaults.Deep.Model != sticky.Model ||
		*v.TierDefaults != e.s.svcBaseTiers(group, model.Pi) {
		t.Fatalf("the draft's tier defaults are not its group's: %+v", v.TierDefaults)
	}

	// When it starts it records them, as any run does.
	if _, err := e.s.Patch(draftID, PatchReq{Settings: &SettingsPatch{MaxParallel: svcPtr(5)}}); err != nil {
		t.Fatal(err)
	}
	e.events()
	if v, err := e.s.Start(draftID, svcGoal); err != nil || v.Status != model.RunRunning || v.TierDefaults != nil {
		t.Fatalf("the start: %+v %v", v, err)
	}
	var gd model.GroupDefaults
	e.s.Store.Read(func(st *model.State) { gd = st.Defaults.Groups[group] })
	if rd := gd.Local().Run; rd == nil || rd.Agent != model.Pi || rd.MaxParallel != 5 ||
		rd.Tiers == nil || *rd.Tiers != tiersAll("some-model", "high") {
		t.Fatalf("the group's defaults after the start: %+v, its run defaults %+v", gd, gd.Local().Run)
	}
	if kinds := svcKinds(e.events()); !slices.Contains(kinds, "defaults") || !slices.Contains(kinds, "run") {
		t.Fatalf("the events of the start: %v", kinds)
	}
	if got := e.fake.called(); !slices.Equal(got, []string{"start " + draftID}) {
		t.Fatalf("engine calls: %v", got)
	}

	// What was saved holds no mark.
	if _, err := e.s.Patch(runID, PatchReq{Name: svcPtr("Renamed")}); err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		if got, ok := svcDiskMark(t, e.s, id); ok {
			t.Fatalf("the run.json of %s was saved with the mark %q", id, got)
		}
	}
}
