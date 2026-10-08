package runs

import (
	"errors"
	"os/exec"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// svcAgents is a look-up of usable agents over a fake PATH: the programs named in have are found.
// The map can be changed between calls.
func svcAgents(have map[string]bool) *usable.Set {
	bins := map[model.AgentKind]string{model.Claude: "claude", model.Cursor: "agent", model.Pi: "pi"}
	return usable.NewWith(bins, func(bin string) (string, error) {
		if have[bin] {
			return "/bin/" + bin, nil
		}
		return "", exec.ErrNotFound
	})
}

// A draft run's agent can be changed only to one the server can use.
func TestSvcAgentOutsideTheList(t *testing.T) {
	t.Parallel()
	e := newSvcEnv(t)
	have := map[string]bool{"claude": true, "pi": true}
	e.s.Agents = svcAgents(have)
	v, err := e.s.Create(model.Ungrouped, "")
	if err != nil || v.Agent != model.Claude {
		t.Fatalf("the new run: %+v %v", v, err)
	}
	r, _ := e.s.run(v.ID)
	before := svcMetaOnDisk(t, r)
	e.events()

	var me *usable.MissingError
	_, err = e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Cursor), Settings: &SettingsPatch{MaxParallel: svcPtr(3)}})
	if !errors.Is(err, usable.ErrMissing) || !errors.As(err, &me) || me.Agent != model.Cursor || me.Bin != "agent" {
		t.Fatalf("an agent the server lacks: %v", err)
	}
	if got, _ := e.s.View(v.ID); got.Agent != model.Claude || got.Tiers != v.Tiers || got.Settings != v.Settings || got.Blocked != "" {
		t.Fatalf("the view after a refused patch: %+v", got)
	}
	if m := svcMetaOnDisk(t, r); !svcSameJSON(m, before) {
		t.Fatalf("run.json after a refused patch: %+v", m)
	}
	if evs := e.events(); len(evs) != 0 {
		t.Fatalf("a refused patch sent %v", svcKinds(evs))
	}
	// An unknown kind is refused as before, and so is no agent.
	for _, a := range []model.AgentKind{"nobody", ""} {
		if _, err := e.s.Patch(v.ID, PatchReq{Agent: &a}); err == nil || errors.Is(err, usable.ErrMissing) || errors.Is(err, usable.ErrNone) {
			t.Fatalf("agent %q: %v", a, err)
		}
	}
	// One that is usable is taken, and the look-up is done at the patch: a program installed
	// since is found, one removed since is not.
	if got, err := e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Pi)}); err != nil || got.Agent != model.Pi {
		t.Fatalf("a usable agent: %+v %v", got, err)
	}
	have["agent"] = true
	if got, err := e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Cursor)}); err != nil || got.Agent != model.Cursor {
		t.Fatalf("an agent installed since: %+v %v", got, err)
	}
	delete(have, "claude")
	if _, err := e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Claude)}); !errors.Is(err, usable.ErrMissing) {
		t.Fatalf("an agent removed since: %v", err)
	}
	if got, _ := e.s.View(v.ID); got.Agent != model.Cursor {
		t.Fatalf("the view: %+v", got)
	}
}

// Run defaults whose agent the server lacks give the first usable agent with that agent's base
// tiers, not the tiers recorded for the other kind.
func TestSvcCreateFallsBackToAUsableAgent(t *testing.T) {
	t.Parallel()
	e := newSvcEnv(t)
	stored := tiersAll("gpt-5", "high")
	if err := e.s.Store.Update(func(st *model.State) error {
		st.Defaults.Groups = map[string]model.GroupDefaults{model.Ungrouped: model.LocalDefaults(model.ServerDefaults{
			Run: &model.RunDefaults{Agent: model.Cursor, MaxParallel: 3, MaxTurns: 70, Tiers: &stored}})}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	want := model.DefaultRunSettings()
	want.MaxParallel, want.MaxTurns = 3, 70

	// With no look-up, and with one that finds Cursor, the stored agent is taken.
	for _, set := range []*usable.Set{nil, svcAgents(map[string]bool{"claude": true, "agent": true})} {
		e.s.Agents = set
		if v, err := e.s.Create(model.Ungrouped, ""); err != nil || v.Agent != model.Cursor || v.Tiers != stored || v.Settings != want {
			t.Fatalf("the stored agent is usable: %+v %v", v, err)
		}
	}
	// Only Claude is usable.
	e.s.Agents = svcAgents(map[string]bool{"claude": true})
	v, err := e.s.Create(model.Ungrouped, "")
	if err != nil {
		t.Fatal(err)
	}
	if v.Agent != model.Claude || v.Tiers != svcClaudeTiers || v.TierDefaults == nil || *v.TierDefaults != svcClaudeTiers || v.Settings != want || v.Blocked != "" {
		t.Fatalf("a run whose stored agent is missing: %+v", v)
	}
	r, _ := e.s.run(v.ID)
	if m := svcMetaOnDisk(t, r); m.Agent != model.Claude || m.Tiers != svcClaudeTiers {
		t.Fatalf("run.json: %+v", m)
	}
	// The first usable one of the fixed order, also with no run defaults at all.
	e.s.Agents = svcAgents(map[string]bool{"pi": true, "agent": true})
	if err := e.s.Store.Update(func(st *model.State) error { st.Defaults.Groups = nil; return nil }); err != nil {
		t.Fatal(err)
	}
	if v, err := e.s.Create(model.Ungrouped, ""); err != nil || v.Agent != model.Cursor {
		t.Fatalf("a run where Claude is missing: %+v %v", v, err)
	}
}

// With no usable agent a run is still made: it has no agent and no tiers, says why it is blocked,
// and cannot start until an agent is picked.
func TestSvcCreateWithNoUsableAgent(t *testing.T) {
	t.Parallel()
	e := newSvcEnv(t)
	have := map[string]bool{}
	e.s.Agents = svcAgents(have)
	v, err := e.s.Create(model.Ungrouped, "")
	if err != nil {
		t.Fatal(err)
	}
	if v.Agent != "" || v.Tiers != (model.RunTiers{}) || v.Blocked != usable.ErrNone.Error() || v.Status != model.RunDraft || v.Cwd != e.cwd {
		t.Fatalf("a run with no usable agent: %+v", v)
	}
	r, _ := e.s.run(v.ID)
	if m := svcMetaOnDisk(t, r); m.Agent != "" || m.Tiers != (model.RunTiers{}) {
		t.Fatalf("run.json: %+v", m)
	}
	// The start says why, not "pick a model first".
	var be *BlockedError
	if _, err := e.s.Start(v.ID, "do it"); !errors.As(err, &be) || be.Reason != usable.ErrNone.Error() || errors.Is(err, ErrNoModel) {
		t.Fatalf("the start of a run with no agent: %v", err)
	}
	if got, _ := e.s.View(v.ID); got.Status != model.RunDraft || !got.Started.IsZero() || got.Blocked != be.Reason {
		t.Fatalf("the view after the refused start: %+v", got)
	}
	if len(e.fake.called()) != 0 {
		t.Fatalf("the engine: %v", e.fake.called())
	}
	// It stays without an agent when one appears, and says so: no longer "none was found", but
	// "choose one". The person picks one, and then the run can start.
	have["claude"] = true
	e.s.Agents.Refresh()
	if got, err := e.s.View(v.ID); err != nil || got.Agent != "" || got.Blocked != usable.ErrUnchosen.Error() || got.Blocked == usable.ErrNone.Error() {
		t.Fatalf("the draft after an agent appeared: %+v %v", got, err)
	}
	if _, err := e.s.Start(v.ID, "do it"); !errors.As(err, &be) || be.Reason != usable.ErrUnchosen.Error() || errors.Is(err, ErrNoModel) {
		t.Fatalf("the start after an agent appeared: %v", err)
	}
	got, err := e.s.Patch(v.ID, PatchReq{Agent: svcPtr(model.Claude)})
	if err != nil || got.Agent != model.Claude || got.Tiers != svcClaudeTiers || got.Blocked != "" {
		t.Fatalf("an agent picked: %+v %v", got, err)
	}
	if got, err := e.s.Start(v.ID, "do it"); err != nil || got.Status != model.RunRunning {
		t.Fatalf("the start with an agent: %+v %v", got, err)
	}
}
