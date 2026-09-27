package defaults

import (
	"os"
	"path/filepath"
	"reflect"
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
	cwd, mc := Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	check(t, "claude", cwd, mc, ds.fallback, model.ModelChoice{Model: "sonnet", Effort: "high"})
	cwd, mc = Resolve(d, "g1", model.Cursor, ds.fallback, cursorCat())
	check(t, "cursor", cwd, mc, ds.fallback, model.ModelChoice{Model: "auto"})
}

func TestRecordChangeThenResolve(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})

	cwd, mc := Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})

	// Folder is shared across agents; model is per agent.
	cwd, mc = Resolve(d, "g1", model.Cursor, ds.fallback, cursorCat())
	check(t, "g1 cursor", cwd, mc, ds.a, model.ModelChoice{Model: "auto"})

	// g2 was never set: falls back to "last".
	cwd, mc = Resolve(d, "g2", model.Claude, ds.fallback, claudeCat())
	check(t, "g2 claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
}

func TestRecordChangeEmptyFieldsLeftAlone(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordChange(&d, "g1", model.Claude, "", model.ModelChoice{Effort: "low"})
	RecordChange(&d, "g1", model.Claude, ds.b, model.ModelChoice{})

	cwd, mc := Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude", cwd, mc, ds.b, model.ModelChoice{Model: "opus", Effort: "low"})

	// A folder-only change in another group doesn't hide "last"'s model for that group.
	RecordChange(&d, "g2", model.Claude, ds.a, model.ModelChoice{})
	cwd, mc = Resolve(d, "g2", model.Claude, ds.fallback, claudeCat())
	check(t, "g2 claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "low"})
}

func TestSeedGroup(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	SeedGroup(&d, "g3", "")
	if !reflect.DeepEqual(d.Groups["g3"], d.Last) {
		t.Fatalf("g3 = %+v, want copy of last %+v", d.Groups["g3"], d.Last)
	}

	RecordChange(&d, "g1", model.Claude, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})
	cwd, mc := Resolve(d, "g3", model.Claude, ds.fallback, claudeCat())
	check(t, "g3 claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	cwd, mc = Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	check(t, "g1 claude", cwd, mc, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})
}

func TestSeedSubgroupFromParent(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordChange(&d, "g2", model.Claude, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"}) // last is now g2's
	SeedGroup(&d, "g1a", "g1")
	cwd, mc := Resolve(d, "g1a", model.Claude, ds.fallback, claudeCat())
	check(t, "g1a claude", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})

	// a deep copy: changing the parent later leaves the subgroup alone
	RecordChange(&d, "g1", model.Claude, ds.b, model.ModelChoice{Model: "haiku"})
	cwd, mc = Resolve(d, "g1a", model.Claude, ds.fallback, claudeCat())
	check(t, "g1a claude after", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
}

func TestUngroupedIsItsOwnGroup(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, model.Ungrouped, model.Claude, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	RecordChange(&d, "g1", model.Claude, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})

	cwd, mc := Resolve(d, model.Ungrouped, model.Claude, ds.fallback, claudeCat())
	check(t, "ungrouped", cwd, mc, ds.a, model.ModelChoice{Model: "opus", Effort: "max"})
	cwd, mc = Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	check(t, "g1", cwd, mc, ds.b, model.ModelChoice{Model: "sonnet", Effort: "low"})
}

func TestMissingFolderFallsBack(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", model.Claude, ds.a, model.ModelChoice{})
	if err := os.Remove(ds.a); err != nil {
		t.Fatal(err)
	}
	cwd, _ := Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	if cwd != ds.fallback {
		t.Errorf("cwd = %q, want fallback %q", cwd, ds.fallback)
	}
}

func TestModelNotInCatalogAndEffortCleared(t *testing.T) {
	ds := mkdirs(t)
	var d model.Defaults
	RecordChange(&d, "g1", model.Claude, ds.a, model.ModelChoice{Model: "gone-model", Effort: "max"})
	_, mc := Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	if mc != (model.ModelChoice{Model: "sonnet", Effort: "high"}) {
		t.Errorf("missing model: got %+v, want catalog default", mc)
	}

	RecordChange(&d, "g1", model.Claude, "", model.ModelChoice{Model: "haiku"})
	_, mc = Resolve(d, "g1", model.Claude, ds.fallback, claudeCat())
	if mc != (model.ModelChoice{Model: "haiku"}) {
		t.Errorf("haiku: got %+v, want effort cleared", mc)
	}
}

func TestAgentOrder(t *testing.T) {
	want := []model.AgentKind{model.Claude, model.Cursor}
	if !reflect.DeepEqual(AgentOrder, want) {
		t.Fatalf("AgentOrder = %v, want %v", AgentOrder, want)
	}
	// Using Cursor last changes nothing about the order.
	var d model.Defaults
	RecordChange(&d, "g1", model.Cursor, "", model.ModelChoice{Model: "gpt-5.4-mini"})
	if !reflect.DeepEqual(AgentOrder, want) {
		t.Fatalf("AgentOrder after using Cursor = %v, want %v", AgentOrder, want)
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
		RecordChange(&d, "g1", model.Cursor, ds.a, c.stored)
		_, mc := Resolve(d, "g1", model.Cursor, ds.fallback, effortCat())
		if mc != c.want {
			t.Errorf("%s: got %+v, want %+v", c.what, mc, c.want)
		}
	}

	// A catalog default whose effort its model lacks is checked the same way.
	cat := effortCat()
	cat.Default = model.ModelChoice{Model: "glm-5.2", Effort: "low"}
	var d model.Defaults
	RecordChange(&d, "g1", model.Cursor, ds.a, model.ModelChoice{Model: "gone", Effort: "low"})
	if _, mc := Resolve(d, "g1", model.Cursor, ds.fallback, cat); mc != (model.ModelChoice{Model: "glm-5.2", Effort: "high"}) {
		t.Errorf("missing model, bad default effort: got %+v", mc)
	}

	// With no catalog, the stored choice is returned as is.
	d = model.Defaults{}
	RecordChange(&d, "g1", model.Cursor, ds.a, model.ModelChoice{Model: "gpt-5.4-mini", Effort: "max"})
	if _, mc := Resolve(d, "g1", model.Cursor, ds.fallback, nil); mc != (model.ModelChoice{Model: "gpt-5.4-mini", Effort: "max"}) {
		t.Errorf("no catalog: got %+v", mc)
	}
}
