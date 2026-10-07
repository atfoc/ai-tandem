package runs

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/model"
)

func tierChoice(id, effort string) model.ModelChoice {
	return model.ModelChoice{Model: id, Effort: effort}
}

func TestSvcDefaultTiers(t *testing.T) {
	cc := claude.Catalog
	levels := []string{"low", "medium", "high"}
	one := &model.Catalog{Models: []model.CatalogModel{{ID: "composer-2", Efforts: levels, DefaultEffort: "high"}}}
	plain := &model.Catalog{Models: []model.CatalogModel{{ID: "flash"}}}
	odd := &model.Catalog{Models: []model.CatalogModel{{ID: "odd", Efforts: []string{"off", "max"}, DefaultEffort: "max"},
		{ID: "lost", Efforts: []string{"off"}, DefaultEffort: "auto"}}}
	for name, c := range map[string]struct {
		kind model.AgentKind
		cat  *model.Catalog
		base model.ModelChoice
		want model.RunTiers
	}{
		// Claude: opus for deep and standard, sonnet for light, whatever the group's chat model is.
		"claude": {model.Claude, &cc, tierChoice("haiku", ""),
			model.RunTiers{Deep: tierChoice("opus", "high"), Standard: tierChoice("opus", "medium"), Light: tierChoice("sonnet", "medium")}},
		"claude, ids that contain the family": {model.Claude, &model.Catalog{Models: []model.CatalogModel{
			{ID: "claude-sonnet-5-5", Efforts: levels, DefaultEffort: "high"}, {ID: "claude-opus-5-5", Efforts: levels, DefaultEffort: "high"}, {ID: "opus"}}},
			tierChoice("x", ""),
			model.RunTiers{Deep: tierChoice("claude-opus-5-5", "high"), Standard: tierChoice("claude-opus-5-5", "medium"), Light: tierChoice("claude-sonnet-5-5", "medium")}},
		"claude without an opus": {model.Claude, &model.Catalog{Models: []model.CatalogModel{{ID: "sonnet", Efforts: levels, DefaultEffort: "high"}, {ID: "haiku"}}},
			tierChoice("haiku", ""),
			model.RunTiers{Deep: tierChoice("haiku", ""), Standard: tierChoice("haiku", ""), Light: tierChoice("sonnet", "medium")}},
		// A kind with one model: the tiers differ only in effort.
		"one model": {model.Cursor, one, tierChoice("composer-2", "low"),
			model.RunTiers{Deep: tierChoice("composer-2", "high"), Standard: tierChoice("composer-2", "medium"), Light: tierChoice("composer-2", "medium")}},
		// Another kind is never looked through for an opus.
		"pi with an opus in its list": {model.Pi, &model.Catalog{Models: []model.CatalogModel{{ID: "anthropic/opus"}, {ID: "flash", Efforts: levels}}},
			tierChoice("flash", "low"),
			model.RunTiers{Deep: tierChoice("flash", "high"), Standard: tierChoice("flash", "medium"), Light: tierChoice("flash", "medium")}},
		"no effort levels": {model.Pi, plain, tierChoice("flash", ""), tiersAll("flash", "")},
		// Levels without the wanted ones: the model's default, when it has that.
		"other levels":     {model.Pi, odd, tierChoice("odd", "off"), tiersAll("odd", "max")},
		"a lost default":   {model.Pi, odd, tierChoice("lost", "off"), tiersAll("lost", "")},
		"no catalogue":     {model.Cursor, nil, tierChoice("gpt-5", "high"), tiersAll("gpt-5", "")},
		"nothing is known": {model.Cursor, nil, model.ModelChoice{}, model.RunTiers{}},
	} {
		if got := svcDefaultTiers(c.kind, c.cat, c.base); got != c.want {
			t.Errorf("%s: %+v, want %+v", name, got, c.want)
		}
	}
	if svcTierEffort(nil, "high") != "" || svcTierEffort(&one.Models[0], "medium") != "medium" || svcTierEffort(&one.Models[0], "xhigh") != "high" ||
		svcTierEffort(&plain.Models[0], "high") != "" {
		t.Error("svcTierEffort")
	}
	if !model.ValidTier("deep") || !model.ValidTier("standard") || !model.ValidTier("light") || model.ValidTier("") || model.ValidTier("Deep") {
		t.Error("ValidTier")
	}
	ts := model.RunTiers{Deep: tierChoice("d", ""), Standard: tierChoice("s", ""), Light: tierChoice("l", "")}
	if ts.Of(model.TierDeep).Model != "d" || ts.Of(model.TierLight).Model != "l" || ts.Of(model.TierStandard).Model != "s" || ts.Of("").Model != "s" || ts.Of("huge").Model != "s" ||
		ts.Of(model.TierOrchestrator).Model != "d" || ts.OrchestratorTier() != model.TierDeep || ts.Of(model.MergeTier).Model != "s" {
		t.Error("RunTiers.Of")
	}
	// The orchestrator's own choice: its turns run on it and are recorded with its tier, which no task can have.
	ts.Orchestrator = tierChoice("o", "max")
	if ts.Of(model.TierOrchestrator) != tierChoice("o", "max") || ts.OrchestratorTier() != model.TierOrchestrator || ts.Of(model.TierDeep).Model != "d" ||
		model.ValidTier("orchestrator") {
		t.Error("RunTiers.Orchestrator")
	}
}

func TestSvcCheckTiers(t *testing.T) {
	cc := claude.Catalog
	good := model.RunTiers{Deep: tierChoice("opus", "high"), Standard: tierChoice("opus", "medium"), Light: tierChoice("haiku", "")}
	if got, err := svcCheckTiers(&cc, good); err != nil || got != good {
		t.Fatalf("a good map: %+v %v", got, err)
	}
	// An effort the model lacks, or none on a model with levels, becomes the model's default.
	in := model.RunTiers{Deep: tierChoice("opus", "ludicrous"), Standard: tierChoice("sonnet", ""), Light: tierChoice("haiku", "high")}
	want := model.RunTiers{Deep: tierChoice("opus", "high"), Standard: tierChoice("sonnet", "high"), Light: tierChoice("haiku", "")}
	if got, err := svcCheckTiers(&cc, in); err != nil || got != want {
		t.Fatalf("normalised: %+v %v", got, err)
	}
	// A nil catalogue accepts every model and effort as it is.
	if got, err := svcCheckTiers(nil, in); err != nil || got != in {
		t.Fatalf("no catalogue: %+v %v", got, err)
	}
	for _, cat := range []*model.Catalog{&cc, nil} {
		noLight := good
		noLight.Light.Model = ""
		if _, err := svcCheckTiers(cat, noLight); !errors.Is(err, ErrNoModel) {
			t.Errorf("an empty model: %v", err)
		}
	}
	if _, err := svcCheckTiers(nil, model.RunTiers{}); !errors.Is(err, ErrNoModel) {
		t.Errorf("an empty map: %v", err)
	}
	gone := good
	gone.Light.Model = "gpt-9"
	if _, err := svcCheckTiers(&cc, gone); err == nil || err.Error() != `unknown model "gpt-9" (tier light)` {
		t.Errorf("an unknown model: %v", err)
	}
	gone = good
	gone.Deep.Model = "gpt-9"
	if _, err := svcCheckTiers(&cc, gone); err == nil || err.Error() != `unknown model "gpt-9" (tier deep)` {
		t.Errorf("an unknown deep model: %v", err)
	}
}

// PATCH tiers: only the tiers and fields that are set change, and each refusal changes nothing.
func TestSvcPatchTiers(t *testing.T) {
	e := newSvcEnv(t)
	v, _ := e.s.Create(model.Ungrouped, "")
	if v.Tiers != svcClaudeTiers {
		t.Fatalf("the new run's tiers: %+v", v.Tiers)
	}
	for body, want := range map[string]string{
		`{"tiers":{"light":{"model":"haiku"},"deep":{"model":""}}}`:   "the model is empty",
		`{"tiers":{"light":{"model":"haiku"},"deep":{"model":"x"}}}`:  `unknown model "x"`,
		`{"tiers":{"deep":{"effort":"high"},"light":{"effort":"x"}}}`: `sonnet has no effort "x"`,
		`{"tiers":{"standard":{"model":"haiku","effort":"high"}}}`:    `haiku has no effort "high"`,
	} {
		var req PatchReq
		if err := json.Unmarshal([]byte(body), &req); err != nil {
			t.Fatal(err)
		}
		if _, err := e.s.Patch(v.ID, req); err == nil || err.Error() != want {
			t.Errorf("%s: %v, want %s", body, err, want)
		}
		if got, _ := e.s.View(v.ID); got.Tiers != svcClaudeTiers {
			t.Fatalf("%s changed the tiers: %+v", body, got.Tiers)
		}
	}
	var req PatchReq
	// One tier's effort; another tier's model, which keeps its effort (opus has medium); an empty
	// effort is ignored.
	if err := json.Unmarshal([]byte(`{"tiers":{"deep":{"effort":"max"},"light":{"model":"opus","effort":""}}}`), &req); err != nil {
		t.Fatal(err)
	}
	got, err := e.s.Patch(v.ID, req)
	want := model.RunTiers{Deep: tierChoice("opus", "max"), Standard: tierChoice("opus", "medium"), Light: tierChoice("opus", "medium")}
	if err != nil || got.Tiers != want {
		t.Fatalf("patched: %+v %v", got.Tiers, err)
	}
	// A model without levels drops the effort; a model with levels then takes its default.
	got, _ = e.s.Patch(v.ID, PatchReq{Tiers: svcTier("deep", "haiku", "")})
	if got.Tiers.Deep != tierChoice("haiku", "") {
		t.Fatalf("a model without levels: %+v", got.Tiers)
	}
	got, _ = e.s.Patch(v.ID, PatchReq{Tiers: svcTier("deep", "sonnet", "")})
	if got.Tiers.Deep != tierChoice("sonnet", "high") || got.Tiers.Standard != want.Standard {
		t.Fatalf("a model with levels after one without: %+v", got.Tiers)
	}
	r, _ := e.s.run(v.ID)
	if m := svcMetaOnDisk(t, r); m.Tiers != got.Tiers {
		t.Fatalf("run.json: %+v", m.Tiers)
	}
	// The view always carries the three keys, and the defaults only while the run is a draft.
	raw, _ := json.Marshal(got)
	var wire struct {
		Tiers        map[string]model.ModelChoice `json:"tiers"`
		TierDefaults map[string]model.ModelChoice `json:"tierDefaults"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil || len(wire.Tiers) != 3 || len(wire.TierDefaults) != 3 || wire.TierDefaults["light"] != svcClaudeTiers.Light ||
		strings.Contains(string(raw), `"model":"sonnet","effort"`) == false {
		t.Fatalf("the view's JSON: %s", raw)
	}
}

// A change of agent rebuilds the tier map; the start refuses a map it cannot run and records the
// one it ran; the next run begins with that.
func TestSvcTiersAcrossAgentsAndRuns(t *testing.T) {
	e := newSvcEnv(t)
	levels := []string{"low", "medium", "high"}
	if err := e.s.Store.Update(func(st *model.State) error {
		st.SetCatalog(model.Pi, &model.Catalog{Models: []model.CatalogModel{{ID: "flash", Efforts: levels, DefaultEffort: "low"}, {ID: "big"}},
			Default: tierChoice("flash", "low")})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	v, _ := e.s.Create(model.Ungrouped, "")
	piTiers := model.RunTiers{Deep: tierChoice("flash", "high"), Standard: tierChoice("flash", "medium"), Light: tierChoice("flash", "medium")}
	got, err := e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Pi)})
	if err != nil || got.Tiers != piTiers || got.TierDefaults == nil || *got.TierDefaults != piTiers {
		t.Fatalf("pi: %+v %+v %v", got.Tiers, got.TierDefaults, err)
	}
	// The same agent again changes nothing of what the person set.
	got, _ = e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Pi), Tiers: svcTier("light", "big", "")})
	if got.Tiers.Light != tierChoice("big", "") {
		t.Fatalf("pi, light on big: %+v", got.Tiers)
	}
	got, _ = e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Pi)})
	if got.Tiers.Light != tierChoice("big", "") || *got.TierDefaults != piTiers {
		t.Fatalf("the same agent again: %+v", got)
	}
	// Cursor has no catalogue and no recorded choice: nothing to run on, and the start says so.
	got, _ = e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Cursor)})
	if got.Tiers != (model.RunTiers{}) {
		t.Fatalf("cursor: %+v", got.Tiers)
	}
	if _, err := e.s.Start(v.ID, svcGoal); !errors.Is(err, ErrNoModel) {
		t.Fatalf("a start with no model: %v", err)
	}
	// One empty tier is enough.
	e.s.Patch(v.ID, PatchReq{Tiers: &TiersPatch{Deep: &TierPatch{Model: svcPtr("gpt-5")}, Standard: &TierPatch{Model: svcPtr("gpt-5")}}})
	if _, err := e.s.Start(v.ID, svcGoal); !errors.Is(err, ErrNoModel) {
		t.Fatalf("a start with no light model: %v", err)
	}
	got, _ = e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Claude)})
	if got.Tiers != svcClaudeTiers {
		t.Fatalf("back on claude: %+v", got.Tiers)
	}

	// A model that left the catalogue since it was picked: the start is refused and names the tier.
	r, _ := e.s.run(v.ID)
	if err := e.s.svcSetMeta(r, func(m *model.RunMeta) error {
		m.Tiers.Light, m.Tiers.Standard.Effort = tierChoice("sonnet-3", "medium"), "ludicrous"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Start(v.ID, svcGoal); err == nil || err.Error() != `unknown model "sonnet-3" (tier light)` {
		t.Fatalf("a start with an unknown model: %v", err)
	}
	if e.s.View(v.ID); r.viewNow().Status != model.RunDraft {
		t.Fatal("the refused start started the run")
	}
	// An effort that is gone is replaced by the model's default at the start, and that is what is
	// recorded: in run.json, in the view (which has no defaults any more) and for the next run.
	e.s.Patch(v.ID, PatchReq{Tiers: svcTier("light", "haiku", "")})
	started, err := e.s.Start(v.ID, svcGoal)
	want := model.RunTiers{Deep: tierChoice("opus", "high"), Standard: tierChoice("opus", "high"), Light: tierChoice("haiku", "")}
	if err != nil || started.Tiers != want || started.TierDefaults != nil {
		t.Fatalf("started: %+v %+v %v", started.Tiers, started.TierDefaults, err)
	}
	if m := svcMetaOnDisk(t, r); m.Tiers != want {
		t.Fatalf("run.json: %+v", m.Tiers)
	}
	if raw, _ := json.Marshal(started); strings.Contains(string(raw), "tierDefaults") || !strings.Contains(string(raw), `"tiers":{"deep":`) {
		t.Fatalf("the started view: %s", raw)
	}
	var defs model.Defaults
	e.s.Store.Read(func(s *model.State) { defs = s.Defaults })
	if own := defs.Groups[model.Ungrouped].On(model.LocalServer); own.Run == nil || own.Run.Tiers == nil || *own.Run.Tiers != want ||
		len(own.ByAgent) != 0 || len(defs.Groups) != 1 {
		t.Fatalf("defaults: %+v", defs)
	}
	// A tier patch on the started run is refused.
	if _, err := e.s.Patch(v.ID, PatchReq{Tiers: svcTier("light", "sonnet", "")}); !errors.Is(err, ErrStarted) {
		t.Fatalf("tiers of a started run: %v", err)
	}
	// A chat on the run is told the deep tier.
	if info, ok := e.s.RunOf(v.ID); !ok || info.Agent != model.Claude || info.Model != "opus" || info.Effort != "high" {
		t.Fatalf("RunOf: %+v", info)
	}

	// The next run begins with the recorded map, and offers the kind's defaults for a reset.
	next, _ := e.s.Create(model.Ungrouped, "")
	if next.Tiers != want || next.TierDefaults == nil || *next.TierDefaults != svcClaudeTiers {
		t.Fatalf("the next run: %+v %+v", next.Tiers, next.TierDefaults)
	}
	// Of another kind, the recorded map is not used: on create it is the kind that is recorded,
	// so on a change of agent.
	got, _ = e.s.Patch(next.ID, PatchReq{Agent: svcPtr(model.Pi)})
	if got.Tiers != piTiers {
		t.Fatalf("the next run on pi: %+v", got.Tiers)
	}
	got, _ = e.s.Patch(next.ID, PatchReq{Agent: svcPtr(model.Claude)})
	if got.Tiers != want {
		t.Fatalf("the next run back on claude: %+v", got.Tiers)
	}
	// A recorded map with a model that is gone is not used.
	if err := e.s.Store.Update(func(st *model.State) error {
		st.Defaults.Groups[model.Ungrouped].Servers[model.LocalServer].Run.Tiers.Deep.Model = "opus-1"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if third, _ := e.s.Create(model.Ungrouped, ""); third.Tiers != svcClaudeTiers {
		t.Fatalf("a run after a recorded map that no longer fits: %+v", third.Tiers)
	}
}

// run.json of before the tiers had one model and effort: every tier runs on them.
func TestReadMetaBeforeTiers(t *testing.T) {
	e := newTestEnv(t)
	r := e.draft("r_old")
	old := `{"id":"r_old","name":"Old","group":"` + model.Ungrouped + `","created":"2026-01-01T00:00:00Z","agent":"claude","model":"sonnet","effort":"high","cwd":"/work","settings":{"maxParallel":4,"maxTurns":60,"maxCost":0,"wake":"each","maxIdleTurns":3,"agentTimeoutSec":10800,"agentRetries":2}}`
	engWrite(t, r.dir, fileMeta, old)
	m, err := readMeta(r.dir)
	if err != nil || m.Tiers != tiersAll("sonnet", "high") || m.Settings.Wake != "each" || m.Settings.MaxParallel != 4 {
		t.Fatalf("%+v %v", m, err)
	}
}

// The task and the agent on the wire: the new fields are always there, lists never null.
func TestTierFieldsOnTheWire(t *testing.T) {
	task := Task{ID: "T01", Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1}}, {RunAttempt: model.RunAttempt{N: 2, Tier: model.TierDeep}}}}
	raw, _ := json.Marshal(task.View())
	for _, want := range []string{`"needsReport":[]`, `"tier":"standard"`, `"tierReason":""`, `"n":2`, `"tier":"deep"`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("a task without a tier lacks %s: %s", want, raw)
		}
	}
	task.Tier, task.TierReason, task.NeedsReport = model.TierLight, "A recipe.", []string{"T00"}
	v := task.View()
	if v.Tier != model.TierLight || v.TierReason != "A recipe." || len(v.NeedsReport) != 1 || v.Attempts[0].Tier != model.TierLight || v.Attempts[1].Tier != model.TierDeep {
		t.Errorf("the task's view: %+v", v)
	}
	a := Agent{RunAgent: model.RunAgent{ID: "a", Tier: model.TierDeep, Model: "opus", Effort: "high", PeakContext: 900}}
	raw, _ = json.Marshal(a.View(Live{PeakContext: 500}))
	for _, want := range []string{`"tier":"deep"`, `"model":"opus"`, `"effort":"high"`, `"tokens":null`, `"peakContext":900`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("an agent lacks %s: %s", want, raw)
		}
	}
	if got := a.View(Live{PeakContext: 1200}); got.PeakContext != 1200 {
		t.Errorf("the live peak context: %d", got.PeakContext)
	}
	// The run's wait is in the view of a started run, and absent without one.
	meta := model.RunMeta{ID: "r_1", Tiers: tiersAll("m", ""), Started: time.UnixMilli(2000).UTC()}
	st := State{Status: model.RunRunning, Wait: &model.RunWait{Tasks: []string{"T01"}, Mode: "all", Turn: 2}}
	rv := ViewOf(meta, &st, Summary{}, Facts{TierDefaults: tiersAll("x", "")})
	if rv.Wait == nil || rv.Wait.Turn != 2 || rv.TierDefaults != nil || rv.Tiers != tiersAll("m", "") {
		t.Errorf("the started view: %+v", rv)
	}
	raw, _ = json.Marshal(rv)
	if !strings.Contains(string(raw), `"wait":{"tasks":["T01"],"mode":"all","turn":2}`) {
		t.Errorf("the wait on the wire: %s", raw)
	}
	st.Wait = nil
	if raw, _ = json.Marshal(ViewOf(meta, &st, Summary{}, Facts{})); strings.Contains(string(raw), `"wait"`) {
		t.Errorf("no wait: %s", raw)
	}
	if dv := ViewOf(model.RunMeta{ID: "r_2"}, nil, Summary{}, Facts{TierDefaults: tiersAll("x", "")}); dv.TierDefaults == nil || *dv.TierDefaults != tiersAll("x", "") || dv.Wait != nil {
		t.Errorf("the draft view: %+v", dv)
	}
}

// Each agent's record is made with its tier and what the tier runs on, and its chat is made on
// that model and effort: the orchestrator deep, a task without a tier standard, a merge standard,
// a task with a tier that one.
func TestAgentRecordsCarryTheTier(t *testing.T) {
	t.Parallel()
	e, r := engConflictRun(t, "r_tiers", 2, nil)
	tiers := model.RunTiers{Deep: tierChoice("opus", "high"), Standard: tierChoice("sonnet", "medium"), Light: tierChoice("haiku", "")}
	if err := e.s.svcSetMeta(r, func(m *model.RunMeta) error { m.Tiers = tiers; return nil }); err != nil {
		t.Fatal(err)
	}
	r.startEngine()
	engTask(t, r, "T01", model.TaskWork)
	engTask(t, r, "T02", model.TaskWork)
	// Two tasks added by hand: one with a tier, one whose attempt has another tier than the task.
	e.host.wrapOn(func(on func(m *engMsg)) func(m *engMsg) {
		return func(m *engMsg) {
			if m.Name == "T03-work" || m.Name == "T04-work" {
				m.Block("completed", "Looked.", "r")
				return
			}
			on(m)
		}
	})
	e.must(r, KOp, func(tx *Tx) error {
		tx.AddTask(Task{ID: "T03", Title: "Look", Kind: "research", CreatedAt: tx.Now(), BriefRev: 1, Tier: model.TierLight,
			Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, QueuedAt: tx.Now()}}}})
		tx.File(briefRel("T03", 1), []byte("brief"))
		tx.AddTask(Task{ID: "T04", Title: "Decide", Kind: "design", CreatedAt: tx.Now(), BriefRev: 1, Tier: model.TierLight,
			Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, QueuedAt: tx.Now(), Tier: model.TierDeep}}}})
		tx.File(briefRel("T04", 1), []byte("brief"))
		return nil
	})
	engTask(t, r, "T03", model.TaskDone)
	engTask(t, r, "T04", model.TaskDone)
	e.gates.open("T01-work")
	engTask(t, r, "T01", model.TaskDone)
	e.gates.open("T02-work")
	engTask(t, r, "T02", model.TaskDone)
	for name, tier := range map[string]model.Tier{"turn-001": model.TierDeep, "T01-work": model.TierStandard, "T02-work": model.TierStandard, "T02-merge": model.TierStandard,
		"T03-work": model.TierLight, "T04-work": model.TierDeep} {
		a, ok := r.engAgentNamed(name)
		mc := tiers.Of(tier)
		if !ok || a.Tier != tier || a.Model != mc.Model || a.Effort != mc.Effort || a.Tokens != nil {
			t.Errorf("the record of %s: %+v", name, a.RunAgent)
		}
		e.host.mu.Lock()
		c := e.host.chats[AgentChatID(r.id, name)]
		e.host.mu.Unlock()
		if c == nil || c.spec.Model != mc.Model || c.spec.Effort != mc.Effort {
			t.Errorf("the chat of %s: %+v", name, c)
		}
	}
}

// The orchestrator's choice in a tier map: checked like a tier when it has a model, absent
// otherwise, set and taken away by a patch.
func TestSvcOrchestratorChoice(t *testing.T) {
	levels := []string{"low", "medium", "high"}
	cat := &model.Catalog{Models: []model.CatalogModel{{ID: "big", Efforts: levels, DefaultEffort: "medium"}, {ID: "plain"}}}
	base := tiersAll("big", "high")
	str := func(s string) *string { return &s }

	if got, err := svcCheckTiers(cat, base); err != nil || got != base {
		t.Errorf("no choice: %+v, %v", got, err)
	}
	with := base
	with.Orchestrator = tierChoice("", "high") // an effort without a model is no choice
	if got, err := svcCheckTiers(cat, with); err != nil || got != base {
		t.Errorf("an effort alone: %+v, %v", got, err)
	}
	with.Orchestrator = tierChoice("plain", "high")
	if got, err := svcCheckTiers(cat, with); err != nil || got.Orchestrator != tierChoice("plain", "") {
		t.Errorf("an effort the model lacks: %+v, %v", got, err)
	}
	with.Orchestrator = tierChoice("gone", "")
	if _, err := svcCheckTiers(cat, with); err == nil || !strings.Contains(err.Error(), "(tier orchestrator)") {
		t.Errorf("an unknown model: %v", err)
	}

	ts := base
	if err := (TiersPatch{Orchestrator: &TierPatch{Model: str("plain")}}).apply(cat, &ts); err != nil || ts.Orchestrator != tierChoice("plain", "") || ts.Deep != base.Deep {
		t.Errorf("a model: %+v, %v", ts, err)
	}
	if err := (TiersPatch{Orchestrator: &TierPatch{Model: str("big")}}).apply(cat, &ts); err != nil || ts.Orchestrator != tierChoice("big", "medium") {
		t.Errorf("another model: %+v, %v", ts, err)
	}
	if err := (TiersPatch{Orchestrator: &TierPatch{Model: str("")}}).apply(cat, &ts); err != nil || ts != base {
		t.Errorf("taken away: %+v, %v", ts, err)
	}
	// An effort alone, for an orchestrator on the deep tier: the deep tier's model at that effort.
	if err := (TiersPatch{Orchestrator: &TierPatch{Effort: str("low")}}).apply(cat, &ts); err != nil || ts.Orchestrator != tierChoice("big", "low") || ts.Deep != base.Deep {
		t.Errorf("an effort: %+v, %v", ts, err)
	}
	if err := (TiersPatch{Orchestrator: &TierPatch{Model: str("gone")}}).apply(cat, &ts); err == nil {
		t.Error("an unknown model was taken")
	}
}

// An orchestrator with a model of its own: its turn's record and chat are on that model, under
// the orchestrator's tier, and the tasks keep theirs.
func TestOrchestratorRunsOnItsOwnModel(t *testing.T) {
	t.Parallel()
	e, r := engConflictRun(t, "r_orchm", 2, nil)
	tiers := model.RunTiers{Deep: tierChoice("opus", "high"), Standard: tierChoice("sonnet", "medium"), Light: tierChoice("haiku", ""),
		Orchestrator: tierChoice("fable", "max")}
	if err := e.s.svcSetMeta(r, func(m *model.RunMeta) error { m.Tiers = tiers; return nil }); err != nil {
		t.Fatal(err)
	}
	r.startEngine()
	engTask(t, r, "T01", model.TaskWork)
	for name, tier := range map[string]model.Tier{"turn-001": model.TierOrchestrator, "T01-work": model.TierStandard} {
		a, ok := r.engAgentNamed(name)
		mc := tiers.Of(tier)
		if !ok || a.Tier != tier || a.Model != mc.Model || a.Effort != mc.Effort {
			t.Errorf("the record of %s: %+v", name, a.RunAgent)
		}
		e.host.mu.Lock()
		c := e.host.chats[AgentChatID(r.id, name)]
		e.host.mu.Unlock()
		if c == nil || c.spec.Model != mc.Model || c.spec.Effort != mc.Effort {
			t.Errorf("the chat of %s: %+v", name, c)
		}
	}
}
