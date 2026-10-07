package defaults

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

func claudeCat() *model.Catalog {
	return &model.Catalog{
		Models: []model.CatalogModel{
			{ID: "sonnet", Label: "Sonnet", Efforts: []string{"low", "medium", "high", "max"}},
			{ID: "opus", Label: "Opus", Efforts: []string{"low", "medium", "high", "max"}},
			{ID: "haiku", Label: "Haiku"},
		},
		Default: model.ModelChoice{Model: "sonnet", Effort: "high"},
	}
}

func cursorCat() *model.Catalog {
	return &model.Catalog{
		Models: []model.CatalogModel{
			{ID: "auto", Label: "Auto"},
			{ID: "gpt-5.4-mini", Label: "GPT-5.4 Mini", Efforts: []string{"low", "medium", "high"}},
		},
		Default: model.ModelChoice{Model: "auto"},
	}
}

const local = model.LocalServer

type dirs struct{ fallback, a, b string }

func mkdirs(t *testing.T) dirs {
	t.Helper()
	root := t.TempDir()
	d := dirs{filepath.Join(root, "fallback"), filepath.Join(root, "a"), filepath.Join(root, "b")}
	for _, p := range []string{d.fallback, d.a, d.b} {
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return d
}

func check(t *testing.T, what, gotCwd string, gotMC model.ModelChoice, wantCwd string, wantMC model.ModelChoice) {
	t.Helper()
	if gotCwd != wantCwd || gotMC != wantMC {
		t.Errorf("%s: got (%q, %+v), want (%q, %+v)", what, gotCwd, gotMC, wantCwd, wantMC)
	}
}

func TestResolveNothingRecorded(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	cwd, mc := Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	check(t, "claude", cwd, mc, ds.fallback, model.ModelChoice{Model: "sonnet", Effort: "high"})
	cwd, mc = Resolve(d, "g1", local, model.Cursor, ds.fallback, cursorCat())
	check(t, "cursor", cwd, mc, ds.fallback, model.ModelChoice{Model: "auto"})
	pi := &model.Catalog{Models: []model.CatalogModel{{ID: "deepseek-flash", Label: "DeepSeek Flash"}}, Default: model.ModelChoice{Model: "deepseek-flash"}}
	cwd, mc = Resolve(d, "g1", local, model.Pi, ds.fallback, pi)
	check(t, "pi", cwd, mc, ds.fallback, model.ModelChoice{Model: "deepseek-flash"})
}

func TestRecordChangeThenResolve(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", local, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})

	cwd, mc := Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})

	// Folder is shared across agents; model is per agent.
	cwd, mc = Resolve(d, "g1", local, model.Cursor, ds.fallback, cursorCat())
	check(t, "g1 cursor", cwd, mc, ds.a, model.ModelChoice{Model: "auto"})

	// The change is the group's only: g2 was never set and the ungrouped group has nothing either.
	cwd, mc = Resolve(d, "g2", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g2 claude", cwd, mc, ds.fallback, model.ModelChoice{Model: "sonnet", Effort: "high"})
	if len(d.Groups) != 1 {
		t.Errorf("groups = %+v, want g1 alone", d.Groups)
	}

	// Another server's part of the same group is its own.
	cwd, mc = Resolve(d, "g1", "srv_other", model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude elsewhere", cwd, mc, ds.fallback, model.ModelChoice{Model: "sonnet", Effort: "high"})
}

func TestRecordChangeEmptyFieldsLeftAlone(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", local, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordChange(&d, "g1", local, model.Claude, "", model.ModelChoice{Effort: "low"})
	RecordChange(&d, "g1", local, model.Claude, ds.b, model.ModelChoice{})

	cwd, mc := Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude", cwd, mc, ds.b, model.ModelChoice{Model: "opus", Effort: "low"})

	// A folder-only change in a group doesn't hide the ungrouped group's model for that group.
	RecordChange(&d, model.Ungrouped, local, model.Claude, "", model.ModelChoice{Model: "opus", Effort: "low"})
	RecordChange(&d, "g2", local, model.Claude, ds.a, model.ModelChoice{})
	cwd, mc = Resolve(d, "g2", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g2 claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "low"})
	if got := d.Groups["g2"].On(local); got.ByAgent != nil {
		t.Errorf("g2 = %+v, want no choice stored", got)
	}

	// A change of nothing stores no part for the server.
	RecordChange(&d, "g3", local, model.Claude, "", model.ModelChoice{})
	if got := d.Groups["g3"]; got.Servers != nil {
		t.Errorf("g3 = %+v, want no server part", got)
	}
}

func runDefaults(agent model.AgentKind, deep string) model.RunDefaults {
	return model.RunDefaults{Agent: agent, MaxParallel: 3, MaxTurns: 20, MaxCost: 1.5, Setup: "make", SetupCwd: "/w",
		Tiers: &model.RunTiers{Deep: model.ModelChoice{Model: deep, Effort: "max"}, Standard: model.ModelChoice{Model: "sonnet"}, Light: model.ModelChoice{Model: "haiku"}}}
}

// sharesNothing fails when a and b share a map or a pointer: a write to one would reach the other.
func sharesNothing(t *testing.T, what string, a, b model.GroupDefaults) {
	t.Helper()
	if len(a.Servers) > 0 && reflect.ValueOf(a.Servers).Pointer() == reflect.ValueOf(b.Servers).Pointer() {
		t.Errorf("%s: the servers map is shared", what)
	}
	for k, sa := range a.Servers {
		sb := b.Servers[k]
		if len(sa.ByAgent) > 0 && reflect.ValueOf(sa.ByAgent).Pointer() == reflect.ValueOf(sb.ByAgent).Pointer() {
			t.Errorf("%s: %s's choices are shared", what, k)
		}
		if sa.Run != nil && sa.Run == sb.Run {
			t.Errorf("%s: %s's run defaults are shared", what, k)
		}
		if sa.Run != nil && sb.Run != nil && sa.Run.Tiers != nil && sa.Run.Tiers == sb.Run.Tiers {
			t.Errorf("%s: %s's tiers are shared", what, k)
		}
	}
}

// AC32: a new top-level group is a copy of the ungrouped group's whole entry, the sticky server and
// every server's run defaults and tiers included; a subgroup is a copy of its parent's.
func TestSeedGroup(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordServer(&d, model.Ungrouped, "srv_far")
	RecordAgent(&d, model.Ungrouped, local, model.Pi)
	RecordChange(&d, model.Ungrouped, local, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordRun(&d, model.Ungrouped, local, runDefaults(model.Claude, "opus"))
	RecordChange(&d, model.Ungrouped, "srv_far", model.Cursor, "/far", model.ModelChoice{Model: "auto"})
	RecordRun(&d, model.Ungrouped, "srv_far", runDefaults(model.Cursor, "auto"))
	// Another group's values are nobody's source.
	RecordChange(&d, "g1", local, model.Claude, ds.b, model.ModelChoice{Model: "haiku"})

	SeedGroup(&d, "g3", "")
	rd, far := runDefaults(model.Claude, "opus"), runDefaults(model.Cursor, "auto")
	want := model.GroupDefaults{Server: "srv_far", Servers: map[string]model.ServerDefaults{
		local:     {Agent: model.Pi, Cwd: ds.a, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "max"}}, Run: &rd},
		"srv_far": {Cwd: "/far", ByAgent: map[model.AgentKind]model.ModelChoice{model.Cursor: {Model: "auto"}}, Run: &far},
	}}
	if got := d.Groups["g3"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("g3 = %+v, want %+v", got, want)
	}
	sharesNothing(t, "g3 and ungrouped", d.Groups["g3"], d.Groups[model.Ungrouped])

	// A subgroup takes its parent's entry, not the ungrouped group's.
	RecordChange(&d, "g3", local, model.Claude, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})
	RecordAgent(&d, "g3", local, model.Cursor)
	SeedGroup(&d, "g3a", "g3")
	if got := d.Groups["g3a"]; !reflect.DeepEqual(got, d.Groups["g3"]) {
		t.Fatalf("g3a = %+v, want a copy of g3 %+v", got, d.Groups["g3"])
	}
	sharesNothing(t, "g3a and g3", d.Groups["g3a"], d.Groups["g3"])
	if got := Agent(d, "g3a", local, nil); got != model.Cursor {
		t.Errorf("g3a agent = %q, want the parent's cursor", got)
	}

	// A parent with no entry counts as the ungrouped group.
	SeedGroup(&d, "g9a", "g9")
	if got := d.Groups["g9a"]; !reflect.DeepEqual(got, d.Groups[model.Ungrouped]) {
		t.Fatalf("g9a = %+v, want a copy of ungrouped %+v", got, d.Groups[model.Ungrouped])
	}
	sharesNothing(t, "g9a and ungrouped", d.Groups["g9a"], d.Groups[model.Ungrouped])

	// With nothing anywhere a new group has an empty entry.
	var none model.Defaults
	SeedGroup(&none, "g1", "")
	if got, ok := none.Groups["g1"]; !ok || !reflect.DeepEqual(got, model.GroupDefaults{}) {
		t.Fatalf("seed from nothing = %+v (%v), want an empty entry", got, ok)
	}
}

// AC31: a seeded group is a copy. A later change in its source does not reach it, and a change in
// it does not reach its source.
func TestSeededGroupIsACopy(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordServer(&d, model.Ungrouped, local)
	RecordAgent(&d, model.Ungrouped, local, model.Claude)
	RecordChange(&d, model.Ungrouped, local, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordRun(&d, model.Ungrouped, local, runDefaults(model.Claude, "opus"))
	SeedGroup(&d, "g1", "")
	was := Copy(d).Groups["g1"]

	RecordAgent(&d, model.Ungrouped, local, model.Cursor)
	RecordChange(&d, model.Ungrouped, local, model.Claude, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})
	RecordRun(&d, model.Ungrouped, local, runDefaults(model.Cursor, "auto"))
	d.Groups[model.Ungrouped].Servers[local].Run.Tiers.Deep.Model = "changed"
	if got := d.Groups["g1"]; !reflect.DeepEqual(got, was) {
		t.Fatalf("g1 after a change in ungrouped = %+v, want %+v", got, was)
	}
	cwd, mc := Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	if got := Agent(d, "g1", local, nil); got != model.Claude {
		t.Errorf("g1 agent = %q, want claude", got)
	}
	if got := Run(d, "g1", local); got == nil || got.Agent != model.Claude || got.Tiers.Deep.Model != "opus" {
		t.Errorf("g1 run = %+v, want the seeded one", got)
	}

	// The other way round: the group's own changes stay in the group.
	ungrouped := Copy(d).Groups[model.Ungrouped]
	RecordChange(&d, "g1", local, model.Claude, ds.b, model.ModelChoice{Model: "haiku"})
	d.Groups["g1"].Servers[local].Run.Tiers.Deep.Model = "mine"
	if got := d.Groups[model.Ungrouped]; !reflect.DeepEqual(got, ungrouped) {
		t.Fatalf("ungrouped after a change in g1 = %+v, want %+v", got, ungrouped)
	}

	// A subgroup is a copy of its parent in the same way.
	SeedGroup(&d, "g1a", "g1")
	RecordChange(&d, "g1", local, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "low"})
	cwd, mc = Resolve(d, "g1a", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1a claude", cwd, mc, ds.b, model.ModelChoice{Model: "haiku"})
}

func TestSeedSubgroupFromParent(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", local, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordChange(&d, model.Ungrouped, local, model.Claude, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})
	SeedGroup(&d, "g1a", "g1")
	cwd, mc := Resolve(d, "g1a", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1a claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})

	// a deep copy: changing the parent later leaves the subgroup alone
	RecordChange(&d, "g1", local, model.Claude, ds.b, model.ModelChoice{Model: "haiku"})
	cwd, mc = Resolve(d, "g1a", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1a claude after", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
}

func TestUngroupedIsItsOwnGroup(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, model.Ungrouped, local, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordChange(&d, "g1", local, model.Claude, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})

	cwd, mc := Resolve(d, model.Ungrouped, local, model.Claude, ds.fallback, claudeCat())
	check(t, "ungrouped", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	cwd, mc = Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1", cwd, mc, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})
}

func TestMissingFolderFallsBack(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", local, model.Claude, ds.a, model.ModelChoice{})
	if err := os.Remove(ds.a); err != nil {
		t.Fatal(err)
	}
	cwd, _ := Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	if cwd != ds.fallback {
		t.Errorf("cwd = %q, want fallback %q", cwd, ds.fallback)
	}
}

func TestModelNotInCatalogAndEffortCleared(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", local, model.Claude, ds.a, model.ModelChoice{Model: "gone-model", Effort: "max"})
	_, mc := Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	if mc != (model.ModelChoice{Model: "sonnet", Effort: "high"}) {
		t.Errorf("missing model: got %+v, want catalog default", mc)
	}

	RecordChange(&d, "g1", local, model.Claude, "", model.ModelChoice{Model: "haiku"})
	_, mc = Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	if mc != (model.ModelChoice{Model: "haiku"}) {
		t.Errorf("haiku: got %+v, want effort cleared", mc)
	}
}

func TestAgentOrder(t *testing.T) {
	want := []model.AgentKind{model.Claude, model.Cursor, model.Pi}
	if !reflect.DeepEqual(AgentOrder, want) {
		t.Fatalf("AgentOrder = %v, want %v", AgentOrder, want)
	}
	// Using Cursor last changes nothing about the order.
	var d model.Defaults
	RecordChange(&d, "g1", local, model.Cursor, "", model.ModelChoice{Model: "gpt-5.4-mini"})
	if !reflect.DeepEqual(AgentOrder, want) {
		t.Fatalf("AgentOrder after using Cursor = %v, want %v", AgentOrder, want)
	}
	// Nor does pi.
	RecordChange(&d, "g1", local, model.Pi, "", model.ModelChoice{Model: "deepseek-flash"})
	if !reflect.DeepEqual(AgentOrder, want) {
		t.Fatalf("AgentOrder after using pi = %v, want %v", AgentOrder, want)
	}
}

func effortCat() *model.Catalog {
	return &model.Catalog{
		Models: []model.CatalogModel{
			{ID: "claude-opus-5-5", Efforts: []string{"low", "medium", "high", "xhigh", "max"}, DefaultEffort: "medium"},
			{ID: "glm-5.2", Efforts: []string{"high", "max"}, DefaultEffort: "high"},
			{ID: "gpt-5.4-mini", Efforts: []string{"none", "low", "medium", "high", "xhigh"}, DefaultEffort: "medium"},
			{ID: "plain"},
		},
		Default: model.ModelChoice{Model: "glm-5.2", Effort: "max"},
	}
}

func TestResolveEffortFitsModel(t *testing.T) {
	ds := mkdirs(t)
	cases := []struct {
		what   string
		stored model.ModelChoice
		want   model.ModelChoice
	}{
		{"effort not in model's efforts -> its default", model.ModelChoice{Model: "gpt-5.4-mini", Effort: "max"}, model.ModelChoice{Model: "gpt-5.4-mini", Effort: "medium"}},
		{"effort in model's efforts -> unchanged", model.ModelChoice{Model: "claude-opus-5-5", Effort: "xhigh"}, model.ModelChoice{Model: "claude-opus-5-5", Effort: "xhigh"}},
		{"model with no efforts -> cleared", model.ModelChoice{Model: "plain", Effort: "high"}, model.ModelChoice{Model: "plain"}},
		{"no effort stored -> model's default", model.ModelChoice{Model: "glm-5.2"}, model.ModelChoice{Model: "glm-5.2", Effort: "high"}},
		{"model missing from catalog -> cat.Default, effort kept when valid", model.ModelChoice{Model: "gone", Effort: "low"}, model.ModelChoice{Model: "glm-5.2", Effort: "max"}},
	}
	for _, c := range cases {
		var d model.Defaults
		RecordChange(&d, "g1", local, model.Cursor, ds.a, c.stored)
		_, mc := Resolve(d, "g1", local, model.Cursor, ds.fallback, effortCat())
		if mc != c.want {
			t.Errorf("%s: got %+v, want %+v", c.what, mc, c.want)
		}
	}

	// A catalog default whose effort its model lacks is checked the same way.
	cat := effortCat()
	cat.Default = model.ModelChoice{Model: "glm-5.2", Effort: "low"}
	var d model.Defaults
	RecordChange(&d, "g1", local, model.Cursor, ds.a, model.ModelChoice{Model: "gone", Effort: "low"})
	if _, mc := Resolve(d, "g1", local, model.Cursor, ds.fallback, cat); mc != (model.ModelChoice{Model: "glm-5.2", Effort: "high"}) {
		t.Errorf("missing model, bad default effort: got %+v", mc)
	}

	// With no catalog, the stored choice is returned as is.
	d = model.Defaults{}
	RecordChange(&d, "g1", local, model.Cursor, ds.a, model.ModelChoice{Model: "gpt-5.4-mini", Effort: "max"})
	if _, mc := Resolve(d, "g1", local, model.Cursor, ds.fallback, nil); mc != (model.ModelChoice{Model: "gpt-5.4-mini", Effort: "max"}) {
		t.Errorf("no catalog: got %+v", mc)
	}
}

// AC31: a group that has no value of its own takes the ungrouped group's, live, value by value;
// a group that has one is not affected by a change in another group.
func TestGroupWithoutValueFollowsUngrouped(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordAgent(&d, model.Ungrouped, local, model.Cursor)
	RecordChange(&d, model.Ungrouped, local, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordRun(&d, model.Ungrouped, local, runDefaults(model.Cursor, "auto"))

	cwd, mc := Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	if got := Agent(d, "g1", local, nil); got != model.Cursor {
		t.Errorf("g1 agent = %q, want ungrouped's cursor", got)
	}
	if got := Run(d, "g1", local); got == nil || got.Agent != model.Cursor {
		t.Errorf("g1 run = %+v, want ungrouped's", got)
	}
	if _, ok := d.Groups["g1"]; ok {
		t.Errorf("reading made an entry for g1: %+v", d.Groups["g1"])
	}

	// Live: a later change in the ungrouped group reaches the group that has none.
	RecordAgent(&d, model.Ungrouped, local, model.Pi)
	RecordChange(&d, model.Ungrouped, local, model.Claude, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})
	cwd, mc = Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude, later", cwd, mc, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})
	if got := Agent(d, "g1", local, nil); got != model.Pi {
		t.Errorf("g1 agent, later = %q, want pi", got)
	}

	// Value by value: a folder of its own leaves the model to the ungrouped group, and an own
	// model for one agent leaves the other agent's to it.
	RecordChange(&d, "g1", local, model.Cursor, ds.a, model.ModelChoice{Model: "gpt-5.4-mini", Effort: "high"})
	cwd, mc = Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude, own folder", cwd, mc, ds.a, model.ModelChoice{Model: "sonnet", Effort: "low"})
	cwd, mc = Resolve(d, "g1", local, model.Cursor, ds.fallback, cursorCat())
	check(t, "g1 cursor, own model", cwd, mc, ds.a, model.ModelChoice{Model: "gpt-5.4-mini", Effort: "high"})
	if got := Agent(d, "g1", local, nil); got != model.Pi {
		t.Errorf("g1 agent with an own folder = %q, want ungrouped's pi", got)
	}

	// A group with its own values is not affected by a change in another group, the ungrouped one included.
	RecordAgent(&d, "g1", local, model.Claude)
	RecordRun(&d, "g1", local, runDefaults(model.Claude, "opus"))
	RecordChange(&d, "g1", local, model.Claude, "", model.ModelChoice{Model: "haiku"})
	was := Copy(d).Groups["g1"]
	RecordAgent(&d, model.Ungrouped, local, model.Cursor)
	RecordChange(&d, model.Ungrouped, local, model.Claude, ds.b, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordRun(&d, model.Ungrouped, local, runDefaults(model.Pi, "p"))
	RecordChange(&d, "g2", local, model.Claude, ds.b, model.ModelChoice{Model: "opus", Effort: "low"})
	RecordAgent(&d, "g2", local, model.Pi)
	if got := d.Groups["g1"]; !reflect.DeepEqual(got, was) {
		t.Fatalf("g1 = %+v, want %+v", got, was)
	}
	cwd, mc = Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude, own model", cwd, mc, ds.a, model.ModelChoice{Model: "haiku"})
	if got := Agent(d, "g1", local, nil); got != model.Claude {
		t.Errorf("g1 agent = %q, want its own claude", got)
	}
	if got := Run(d, "g1", local); got == nil || got.Agent != model.Claude {
		t.Errorf("g1 run = %+v, want its own", got)
	}

	// Agent, folder, model and effort are kept per server: nothing of the local part is another server's.
	cwd, mc = Resolve(d, "g1", "srv_far", model.Claude, "/home/far", claudeCat())
	check(t, "g1 claude on another server", cwd, mc, "/home/far", model.ModelChoice{Model: "sonnet", Effort: "high"})
	if got := Run(d, "g1", "srv_far"); got != nil {
		t.Errorf("g1 run on another server = %+v, want none", got)
	}
}

// AC31: the agent is the group's, then the ungrouped group's, then the first of the fixed order;
// a kind the server cannot run is skipped at every step, and with none usable there is none.
func TestAgentOrderOfFallback(t *testing.T) {
	all := []model.AgentKind{model.Claude, model.Cursor, model.Pi}
	var d model.Defaults
	if got := Agent(d, "g1", local, nil); got != model.Claude {
		t.Errorf("nothing stored = %q, want claude", got)
	}
	if got := Agent(d, "g1", local, []model.AgentKind{model.Pi, model.Cursor}); got != model.Cursor {
		t.Errorf("nothing stored, no claude = %q, want cursor (the fixed order, not the list's)", got)
	}

	RecordAgent(&d, model.Ungrouped, local, model.Pi)
	if got := Agent(d, "g1", local, all); got != model.Pi {
		t.Errorf("ungrouped's = %q, want pi", got)
	}
	RecordAgent(&d, "g1", local, model.Cursor)
	if got := Agent(d, "g1", local, all); got != model.Cursor {
		t.Errorf("the group's = %q, want cursor", got)
	}
	if got := Agent(d, "g2", local, nil); got != model.Pi {
		t.Errorf("another group = %q, want ungrouped's pi", got)
	}

	// Unusable ones are skipped: the group's, then the ungrouped group's, then the order.
	if got := Agent(d, "g1", local, []model.AgentKind{model.Claude, model.Pi}); got != model.Pi {
		t.Errorf("group's unusable = %q, want ungrouped's pi", got)
	}
	if got := Agent(d, "g1", local, []model.AgentKind{model.Claude}); got != model.Claude {
		t.Errorf("both unusable = %q, want claude", got)
	}
	if got := Agent(d, "g1", local, []model.AgentKind{}); got != "" {
		t.Errorf("none usable = %q, want none", got)
	}

	// Per server: another server's part has no agent stored.
	if got := Agent(d, "g1", "srv_far", []model.AgentKind{model.Cursor, model.Pi}); got != model.Cursor {
		t.Errorf("another server = %q, want the first usable of the order", got)
	}
	RecordAgent(&d, "g1", "srv_far", model.Pi)
	if got := Agent(d, "g1", "srv_far", nil); got != model.Pi {
		t.Errorf("another server, stored = %q, want pi", got)
	}
	if got := Agent(d, "g1", local, nil); got != model.Cursor {
		t.Errorf("local after a record elsewhere = %q, want cursor", got)
	}

	// No agent is not recorded, and a stored kind nobody knows is skipped.
	RecordAgent(&d, "g1", local, "")
	if got := d.Groups["g1"].On(local).Agent; got != model.Cursor {
		t.Errorf("after recording none = %q, want cursor kept", got)
	}
	RecordAgent(&d, "g3", local, "nobody")
	if got := Agent(d, "g3", local, nil); got != model.Pi {
		t.Errorf("unknown kind stored = %q, want ungrouped's pi", got)
	}
	var e model.Defaults
	RecordAgent(&e, "g1", local, "")
	if e.Groups != nil {
		t.Errorf("recording none made an entry: %+v", e.Groups)
	}
}

// AC31: the server is the group's, then the ungrouped group's, then the local one; a stored
// server that is not known falls back the same way.
func TestServerFallsBackToLocal(t *testing.T) {
	var d model.Defaults
	if got := Server(d, "g1", nil); got != local {
		t.Errorf("nothing stored = %q, want local", got)
	}
	known := func(ids ...string) func(string) bool {
		return func(s string) bool { return slices.Contains(ids, s) }
	}

	RecordServer(&d, model.Ungrouped, "srv_a")
	RecordServer(&d, "g1", "srv_b")
	if got := Server(d, "g1", known(local, "srv_a", "srv_b")); got != "srv_b" {
		t.Errorf("the group's = %q, want srv_b", got)
	}
	if got := Server(d, "g2", known(local, "srv_a", "srv_b")); got != "srv_a" {
		t.Errorf("a group without one = %q, want ungrouped's srv_a", got)
	}
	if got := Server(d, "g1", known(local, "srv_a")); got != "srv_a" {
		t.Errorf("the group's is gone = %q, want ungrouped's srv_a", got)
	}
	if got := Server(d, "g1", known(local)); got != local {
		t.Errorf("both gone = %q, want local", got)
	}
	// With no list of servers only the local one is known.
	if got := Server(d, "g1", nil); got != local {
		t.Errorf("known nil = %q, want local", got)
	}
	RecordServer(&d, "g1", local)
	if got := Server(d, "g1", nil); got != local {
		t.Errorf("local stored = %q, want local", got)
	}
	// Recording the server touches nothing else, and none is not recorded.
	RecordAgent(&d, "g1", local, model.Pi)
	RecordServer(&d, "g1", "srv_b")
	RecordServer(&d, "g1", "")
	if got, want := d.Groups["g1"], (model.GroupDefaults{Server: "srv_b", Servers: map[string]model.ServerDefaults{local: {Agent: model.Pi}}}); !reflect.DeepEqual(got, want) {
		t.Errorf("g1 = %+v, want %+v", got, want)
	}
}

func TestResolveOnAnotherServerAndWithNoAgent(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	// A folder of another machine is not looked for on this one.
	RecordChange(&d, "g1", "srv_far", model.Claude, "/nowhere/on/this/machine", model.ModelChoice{Model: "opus", Effort: "max"})
	cwd, mc := Resolve(d, "g1", "srv_far", model.Claude, "/home/far", claudeCat())
	check(t, "remote folder", cwd, mc, "/nowhere/on/this/machine", model.ModelChoice{Model: "opus", Effort: "max"})
	// The same folder stored for the local server is checked, and falls back.
	RecordChange(&d, "g1", local, model.Claude, "/nowhere/on/this/machine", model.ModelChoice{})
	cwd, _ = Resolve(d, "g1", local, model.Claude, ds.fallback, claudeCat())
	if cwd != ds.fallback {
		t.Errorf("local folder = %q, want the fallback", cwd)
	}

	// No agent: the folder only, whatever the catalog says.
	RecordChange(&d, "g2", local, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	cwd, mc = Resolve(d, "g2", local, "", ds.fallback, claudeCat())
	check(t, "no agent", cwd, mc, ds.a, model.ModelChoice{})
}

func TestRunDefaultsPerServer(t *testing.T) {
	var d model.Defaults
	if got := Run(d, "g1", local); got != nil {
		t.Fatalf("nothing stored = %+v, want nil", got)
	}
	rd := runDefaults(model.Claude, "opus")
	RecordRun(&d, model.Ungrouped, local, rd)
	// What is stored is a copy: the caller's value can change afterwards.
	rd.Tiers.Deep.Model, rd.Setup = "changed", "changed"
	want := runDefaults(model.Claude, "opus")
	if got := Run(d, "g1", local); !reflect.DeepEqual(got, &want) {
		t.Fatalf("g1 = %+v, want ungrouped's %+v", got, want)
	}
	// What is read is a copy too.
	got := Run(d, "g1", local)
	got.Tiers.Deep.Model, got.Agent = "changed", model.Pi
	if again := Run(d, model.Ungrouped, local); !reflect.DeepEqual(again, &want) {
		t.Fatalf("after a change of the answer = %+v, want %+v", again, want)
	}

	own := runDefaults(model.Cursor, "auto")
	RecordRun(&d, "g1", local, own)
	if got := Run(d, "g1", local); !reflect.DeepEqual(got, &own) {
		t.Fatalf("g1 own = %+v, want %+v", got, own)
	}
	if got := Run(d, "g2", local); !reflect.DeepEqual(got, &want) {
		t.Fatalf("g2 = %+v, want ungrouped's", got)
	}
	// Per server: the local part's run defaults are not another server's.
	if got := Run(d, "g1", "srv_far"); got != nil {
		t.Fatalf("g1 on another server = %+v, want nil", got)
	}
	far := runDefaults(model.Pi, "p")
	RecordRun(&d, "g1", "srv_far", far)
	if got := Run(d, "g1", "srv_far"); !reflect.DeepEqual(got, &far) {
		t.Fatalf("g1 on srv_far = %+v, want %+v", got, far)
	}
	if got := Run(d, "g1", local); !reflect.DeepEqual(got, &own) {
		t.Fatalf("g1 local after a record elsewhere = %+v, want %+v", got, own)
	}
	// Recording the run defaults keeps the rest of the part.
	RecordAgent(&d, "g1", local, model.Pi)
	RecordRun(&d, "g1", local, far)
	if got := d.Groups["g1"].On(local); got.Agent != model.Pi || !reflect.DeepEqual(got.Run, &far) {
		t.Fatalf("g1 local = %+v, want pi with the new run defaults", got)
	}
}

func TestCopy(t *testing.T) {
	var d model.Defaults
	if got := Copy(d); got.Groups == nil || len(got.Groups) != 0 {
		t.Fatalf("copy of nothing = %+v, want an empty map", got)
	}
	RecordServer(&d, "g1", local)
	RecordAgent(&d, "g1", local, model.Pi)
	RecordChange(&d, "g1", local, model.Claude, "/w", model.ModelChoice{Model: "opus", Effort: "max"})
	RecordRun(&d, "g1", local, runDefaults(model.Claude, "opus"))
	RecordRun(&d, "g1", "srv_far", runDefaults(model.Pi, "p"))
	d.Groups["g_empty"] = model.GroupDefaults{}
	cp := Copy(d)
	if !reflect.DeepEqual(cp, d) {
		t.Fatalf("copy = %+v, want %+v", cp, d)
	}
	for g := range d.Groups {
		sharesNothing(t, g, cp.Groups[g], d.Groups[g])
	}
	if reflect.ValueOf(cp.Groups).Pointer() == reflect.ValueOf(d.Groups).Pointer() {
		t.Error("the groups map is shared")
	}
}

// before is the state file of an older build: "last", and every group's values flat.
const before = `{"version":1,"defaults":{
 "last":{"cwd":"/last","byAgent":{"claude":{"model":"opus","effort":"max"},"pi":{"model":"p"}},
         "run":{"agent":"cursor","maxParallel":2,"maxTurns":10,"maxCost":0}},
 "groups":{"__ungrouped__":{"cwd":"/own","byAgent":{"claude":{"model":"haiku"}}},
           "g_one":{"cwd":"/one","run":{"agent":"claude","maxParallel":8,"maxTurns":60,"maxCost":0,"setup":"make","setupCwd":"/one"}},
           "g_empty":{}}}}`

const after = `{"version":1,"defaults":{"groups":{
 "__ungrouped__":{"servers":{"local":{"cwd":"/own","byAgent":{"claude":{"model":"haiku"},"pi":{"model":"p"}},
                  "run":{"agent":"cursor","maxParallel":2,"maxTurns":10,"maxCost":0}}}},
 "g_empty":{},
 "g_one":{"servers":{"local":{"cwd":"/one","run":{"agent":"claude","maxParallel":8,"maxTurns":60,"maxCost":0,"setup":"make","setupCwd":"/one"}}}}}}}`

// load reads a state file's defaults as store.Open does, and migrates them.
func load(t *testing.T, raw string) (d model.Defaults, changed bool) {
	t.Helper()
	var s model.State
	if err := json.Unmarshal([]byte(raw), &s); err != nil {
		t.Fatal(err)
	}
	if s.Defaults.Groups == nil {
		s.Defaults.Groups = map[string]model.GroupDefaults{}
	}
	changed = Migrate([]byte(raw), &s.Defaults)
	return s.Defaults, changed
}

func sameJSON(t *testing.T, what string, got any, want string) {
	t.Helper()
	b, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var g, w any
	if err := json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Errorf("%s:\n got %s\nwant %s", what, b, want)
	}
}

// AC32: the "last" of an old state file is merged into the ungrouped group once, in the per-server
// shape, run defaults too, and every group's flat values move under the local server.
func TestMigrate(t *testing.T) {
	// The ungrouped group keeps its own values and takes the missing ones; flat groups move; an
	// empty group stays empty.
	d, changed := load(t, before)
	if !changed {
		t.Fatal("an old file: changed = false")
	}
	var want model.State
	if err := json.Unmarshal([]byte(after), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(d, want.Defaults) {
		t.Fatalf("migrated = %+v, want %+v", d, want.Defaults)
	}
	sameJSON(t, "migrated", d, strings.TrimSuffix(strings.TrimPrefix(after, `{"version":1,"defaults":`), "}"))
	if _, ok := d.Groups["g_empty"]; !ok {
		t.Error("the empty group lost its entry")
	}
	u := d.Groups[model.Ungrouped].On(local)
	if u.Cwd != "/own" || u.ByAgent[model.Claude] != (model.ModelChoice{Model: "haiku"}) {
		t.Errorf("ungrouped's own values were overwritten: %+v", u)
	}
	if u.ByAgent[model.Pi] != (model.ModelChoice{Model: "p"}) || u.Run == nil || u.Run.Agent != model.Cursor {
		t.Errorf("ungrouped did not take the missing values: %+v", u)
	}

	// The migrated file is in the new shape: a second load changes nothing.
	b, err := json.Marshal(model.State{Version: 1, Defaults: d})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), `"last"`) {
		t.Errorf("the migrated file holds last: %s", b)
	}
	again, changed := load(t, string(b))
	if changed {
		t.Error("a new-shape file: changed = true")
	}
	if !reflect.DeepEqual(again, d) {
		t.Errorf("second load = %+v, want %+v", again, d)
	}
	if _, changed := load(t, `{"version":1,"defaults":{"groups":{}}}`); changed {
		t.Error("an empty new file: changed = true")
	}
	if _, changed := load(t, `{"version":1}`); changed {
		t.Error("a file with no defaults: changed = true")
	}

	// No ungrouped entry: last becomes it, tiers included.
	d, changed = load(t, `{"version":1,"defaults":{"last":{"cwd":"/last","byAgent":{"claude":{"model":"opus","effort":"max"}},
	 "run":{"agent":"claude","maxParallel":4,"maxTurns":30,"maxCost":2.5,"tiers":{"deep":{"model":"opus","effort":"max"},"standard":{"model":"sonnet"},"light":{"model":"haiku"}}}},
	 "groups":{}}}`)
	if !changed {
		t.Fatal("last alone: changed = false")
	}
	sameJSON(t, "last alone", d, `{"groups":{"__ungrouped__":{"servers":{"local":{"cwd":"/last","byAgent":{"claude":{"model":"opus","effort":"max"}},
	 "run":{"agent":"claude","maxParallel":4,"maxTurns":30,"maxCost":2.5,"tiers":{"deep":{"model":"opus","effort":"max"},"standard":{"model":"sonnet"},"light":{"model":"haiku"}}}}}}}}`)

	// An empty last holds nothing, but the file has to lose it.
	d, changed = load(t, `{"version":1,"defaults":{"last":{},"groups":{}}}`)
	if !changed || len(d.Groups) != 0 {
		t.Errorf("empty last: changed = %v, groups = %+v; want true and no entry", changed, d.Groups)
	}
	// A state file made before the groups had defaults.
	d, changed = load(t, `{"version":1,"defaults":{"last":{"cwd":"/last"}}}`)
	if !changed {
		t.Error("last without groups: changed = false")
	}
	sameJSON(t, "last without groups", d, `{"groups":{"__ungrouped__":{"servers":{"local":{"cwd":"/last"}}}}}`)

	// Flat groups with no last move all the same.
	d, changed = load(t, `{"version":1,"defaults":{"groups":{"g_one":{"byAgent":{"cursor":{"model":"auto"}}}}}}`)
	if !changed {
		t.Error("a flat group: changed = false")
	}
	sameJSON(t, "a flat group", d, `{"groups":{"g_one":{"servers":{"local":{"byAgent":{"cursor":{"model":"auto"}}}}}}}`)

	// Never an overwrite: what the new shape already holds stays, flat values and last fill the rest.
	d, changed = load(t, `{"version":1,"defaults":{
	 "last":{"cwd":"/last","byAgent":{"claude":{"model":"opus"},"cursor":{"model":"auto"}},"run":{"agent":"pi","maxParallel":1,"maxTurns":1,"maxCost":0}},
	 "groups":{"__ungrouped__":{"server":"local","cwd":"/flat","byAgent":{"claude":{"model":"sonnet"},"pi":{"model":"p"}},
	   "servers":{"local":{"agent":"pi","cwd":"/new","byAgent":{"claude":{"model":"haiku"}},"run":{"agent":"claude","maxParallel":8,"maxTurns":60,"maxCost":0}},
	              "srv_far":{"cwd":"/far"}}}}}}`)
	if !changed {
		t.Error("a mixed file: changed = false")
	}
	sameJSON(t, "a mixed file", d, `{"groups":{"__ungrouped__":{"server":"local","servers":{
	 "local":{"agent":"pi","cwd":"/new","byAgent":{"claude":{"model":"haiku"},"pi":{"model":"p"},"cursor":{"model":"auto"}},"run":{"agent":"claude","maxParallel":8,"maxTurns":60,"maxCost":0}},
	 "srv_far":{"cwd":"/far"}}}}}`)

	// A choice that holds an effort only has no model: the one with a model takes its place, as
	// it did when the choice was read.
	d, _ = load(t, `{"version":1,"defaults":{"last":{"byAgent":{"claude":{"model":"opus","effort":"max"},"pi":{"model":"","effort":"low"}}},
	 "groups":{"__ungrouped__":{"byAgent":{"claude":{"model":"","effort":"low"},"pi":{"model":"","effort":"high"}}}}}}`)
	sameJSON(t, "effort only", d, `{"groups":{"__ungrouped__":{"servers":{"local":{"byAgent":{"claude":{"model":"opus","effort":"max"},"pi":{"model":"","effort":"high"}}}}}}}`)

	// One group whose flat values cannot be read stops nothing: it has none to move and keeps its
	// empty entry, and the others and last move all the same.
	d, changed = load(t, `{"version":1,"defaults":{"last":{"cwd":"/last","byAgent":{"claude":{"model":"opus"}}},
	 "groups":{"g_bad":{"cwd":5},"g_one":{"cwd":"/one","byAgent":{"pi":{"model":"p"}}}}}}`)
	if !changed {
		t.Error("a file with one malformed group: changed = false")
	}
	sameJSON(t, "one malformed group", d, `{"groups":{"g_bad":{},
	 "g_one":{"servers":{"local":{"cwd":"/one","byAgent":{"pi":{"model":"p"}}}}},
	 "__ungrouped__":{"servers":{"local":{"cwd":"/last","byAgent":{"claude":{"model":"opus"}}}}}}}`)
	b, err = json.Marshal(model.State{Version: 1, Defaults: d})
	if err != nil {
		t.Fatal(err)
	}
	if again, changed := load(t, string(b)); changed || !reflect.DeepEqual(again, d) {
		t.Errorf("one malformed group, second load: changed = %v, %+v, want %+v", changed, again, d)
	}
	// A malformed group alone: nothing to move, and nothing to write.
	if d, changed = load(t, `{"version":1,"defaults":{"groups":{"g_bad":{"byAgent":[]}}}}`); changed {
		t.Error("a malformed group alone: changed = true")
	}
	sameJSON(t, "a malformed group alone", d, `{"groups":{"g_bad":{}}}`)

	// What cannot be read changes nothing.
	var none model.Defaults
	if Migrate([]byte(`{"version":1,"defaults":`), &none) || none.Groups != nil {
		t.Errorf("a broken file: groups = %+v, want no change", none.Groups)
	}
}
