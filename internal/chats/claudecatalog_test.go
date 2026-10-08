package chats

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
)

var levels = []string{"low", "high"}

// A Claude list as a refresh would store it: it shares "shared" with sharedCursorCatalog and has
// nothing in common with the built-in list.
var storedClaude = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "cl-only", Label: "Claude only", Efforts: levels, DefaultEffort: "low"},
		{ID: "shared", Label: "Shared", Efforts: levels, DefaultEffort: "high"},
		{ID: "saved", Label: "Saved", Efforts: levels, DefaultEffort: "high"},
		{ID: "plain", Label: "Plain"},
	},
	Default: model.ModelChoice{Model: "cl-only", Effort: "low"},
}

var sharedCursorCatalog = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "cu-only", Label: "Cursor only", Efforts: levels, DefaultEffort: "high"},
		{ID: "shared", Label: "Shared", Efforts: levels, DefaultEffort: "high"},
	},
	Default: model.ModelChoice{Model: "cu-only", Effort: "high"},
}

func (e *env) storeCatalog(a model.AgentKind, c *model.Catalog) {
	e.t.Helper()
	if err := e.st.Update(func(s *model.State) error { s.SetCatalog(a, c); return nil }); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) configure(id string, req ConfigReq) {
	e.t.Helper()
	if err := e.m.Configure(id, req); err != nil {
		e.t.Fatal(err)
	}
}

func TestClaudeCatalogBuiltInAndStored(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	builtIn := claude.Catalog
	builtIn.Models = append([]model.CatalogModel(nil), claude.Catalog.Models...)
	if got := e.m.catalog(model.Claude); got == nil || !reflect.DeepEqual(*got, claude.Catalog) {
		t.Fatalf("nothing stored: %+v", got)
	}
	v := e.create(model.Claude, gOne, "")
	if m := e.meta(v.ID); m.Model != "sonnet" || m.Effort != "high" {
		t.Fatalf("built-in new chat %+v", m)
	}

	e.storeCatalog(model.Claude, storedClaude)
	if got := e.m.catalog(model.Claude); got == nil || !reflect.DeepEqual(*got, *storedClaude) {
		t.Fatalf("stored list not returned: %+v", got)
	}
	if !reflect.DeepEqual(claude.Catalog, builtIn) {
		t.Fatalf("built-in list changed: %+v", claude.Catalog)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Model: "opus"}); err == nil || !strings.Contains(err.Error(), "unknown model") {
		t.Fatalf("an id only the built-in list has: %v", err)
	}
	// A new chat resolves the stored default (before any pick records a choice).
	v2 := e.create(model.Claude, gTwo, "")
	if m := e.meta(v2.ID); m.Model != "cl-only" || m.Effort != "low" {
		t.Fatalf("new chat on the stored default: %+v", m)
	}
	e.configure(v.ID, ConfigReq{Model: "cl-only"})
	if m := e.meta(v.ID); m.Model != "cl-only" || m.Effort != "high" {
		t.Fatalf("after cl-only: %+v", m)
	}

	// spawn_subagent validates against the stored list; a stored model without efforts gets none
	// (the fitting in resolveSubSpawn).
	if _, err := e.m.SpawnSubagent(v2.ID, SpawnSubRequest{Prompt: "x", Model: "opus"}); err == nil || !strings.Contains(err.Error(), "unknown model") {
		t.Fatalf("subagent with an id only the built-in list has: %v", err)
	}
	if sa := e.spawn(v2.ID, SpawnSubRequest{Prompt: "x", Model: "plain"}); sa.Model != "plain" || sa.Effort != "" {
		t.Fatalf("subagent on a stored id %+v", sa)
	}
	if got := waitChild(t, e.claude, 1).opts; got.Model != "plain" || got.Effort != "" {
		t.Fatalf("subagent options %+v", got)
	}
}

// U1 cases 3 and 4: with no listed Claude choice recorded, a Claude subagent nobody picked a
// model for lands on the stored list's default model and effort.
func TestClaudeSubagentStoredDefault(t *testing.T) {
	t.Parallel()
	for _, from := range []model.AgentKind{model.Cursor, model.Pi} {
		e := newEnv(t)
		e.storeCatalog(model.Claude, storedClaude)
		e.storeCatalog(model.Pi, &model.Catalog{Models: []model.CatalogModel{{ID: "p/m"}}, Default: model.ModelChoice{Model: "p/m"}})
		v := e.create(from, gOne, "")
		if sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "x", Kind: model.Claude}); sa.Kind != model.Claude || sa.Model != "cl-only" || sa.Effort != "low" {
			t.Fatalf("%s chat: %+v", from, sa)
		}
	}

	// Case 4: a Claude chat whose own model (the built-in default) the stored list lacks.
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.storeCatalog(model.Claude, storedClaude)
	if sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "x"}); sa.Model != "cl-only" || sa.Effort != "low" {
		t.Fatalf("claude chat on a model the list lacks: %+v", sa)
	}
	if got := waitChild(t, e.claude, 1).opts; got.Model != "cl-only" || got.Effort != "low" {
		t.Fatalf("options %+v", got)
	}
}

// §7.3 situation 2 / U1 case 5: a listed model that no longer offers the chat's effort.
func TestClaudeSubagentEffortRoute(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "") // sonnet at high
	narrowed := &model.Catalog{
		Models: []model.CatalogModel{
			{ID: "sonnet", Label: "Sonnet", Efforts: []string{"low", "medium"}, DefaultEffort: "medium"},
			{ID: "cl-only", Label: "Claude only", Efforts: levels, DefaultEffort: "low"},
		},
		Default: model.ModelChoice{Model: "cl-only", Effort: "low"},
	}
	e.storeCatalog(model.Claude, narrowed)
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "x"})
	if sa.Model != "cl-only" || sa.Effort != "low" {
		t.Fatalf("not rebased onto new-chat defaults: %+v", sa)
	}
	if got := waitChild(t, e.claude, 1).opts; got.Model != "cl-only" || got.Effort != "low" {
		t.Fatalf("options %+v", got)
	}
	// A named model keeps nothing it lacks: it takes its own default effort.
	sa = e.spawn(v.ID, SpawnSubRequest{Prompt: "y", Model: "sonnet"})
	if sa.Model != "sonnet" || sa.Effort != "medium" {
		t.Fatalf("named model: %+v", sa)
	}
}

// D22: a model is inherited only by a subagent of the chat's own kind, also when the other
// kind lists the same id.
func TestSubagentSharedIDAcrossKinds(t *testing.T) {
	t.Parallel()
	setup := func() *env {
		e := newEnv(t)
		e.storeCatalog(model.Claude, storedClaude)
		e.storeCatalog(model.Cursor, sharedCursorCatalog)
		return e
	}

	e := setup()
	cu := e.create(model.Cursor, gOne, "")
	e.configure(cu.ID, ConfigReq{Model: "shared", Effort: "low"})
	sa := e.spawn(cu.ID, SpawnSubRequest{Prompt: "x", Kind: model.Claude})
	if sa.Model != "cl-only" || sa.Effort != "low" {
		t.Fatalf("Cursor chat -> Claude subagent: %+v", sa)
	}
	if got := waitChild(t, e.claude, 1).opts; got.Model != "cl-only" || got.Effort != "low" {
		t.Fatalf("options %+v", got)
	}

	// With a saved Claude choice for the chat's group, that choice wins.
	if err := e.st.Update(func(s *model.State) error {
		defaults.RecordChange(&s.Defaults, gOne, model.LocalServer, model.Claude, "", model.ModelChoice{Model: "saved", Effort: "low"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sa = e.spawn(cu.ID, SpawnSubRequest{Prompt: "x", Kind: model.Claude})
	if sa.Model != "saved" || sa.Effort != "low" {
		t.Fatalf("Cursor chat -> Claude subagent with a saved choice: %+v", sa)
	}

	// The shared id named in the request is used as named, with the chat's effort kept.
	sa = e.spawn(cu.ID, SpawnSubRequest{Prompt: "x", Kind: model.Claude, Model: "shared"})
	if sa.Model != "shared" || sa.Effort != "low" {
		t.Fatalf("shared id named: %+v", sa)
	}

	// The reverse: a Claude chat on the shared id, a Cursor subagent without a model.
	e = setup()
	cl := e.create(model.Claude, gOne, "")
	e.configure(cl.ID, ConfigReq{Model: "shared", Effort: "low"})
	sa = e.spawn(cl.ID, SpawnSubRequest{Prompt: "x", Kind: model.Cursor})
	if sa.Kind != model.Cursor || sa.Model != "cu-only" || sa.Effort != "high" {
		t.Fatalf("Claude chat -> Cursor subagent: %+v", sa)
	}
	sa = e.spawn(cl.ID, SpawnSubRequest{Prompt: "x", Kind: model.Cursor, Model: "shared"})
	if sa.Model != "shared" || sa.Effort != "low" {
		t.Fatalf("shared id named for Cursor: %+v", sa)
	}

	// Same kind: the chat's model and effort are inherited.
	sa = e.spawn(cl.ID, SpawnSubRequest{Prompt: "x"})
	if sa.Kind != model.Claude || sa.Model != "shared" || sa.Effort != "low" {
		t.Fatalf("same kind: %+v", sa)
	}
	if got := waitChild(t, e.claude, 1).opts; got.Model != "shared" || got.Effort != "low" {
		t.Fatalf("same kind options %+v", got)
	}
}

func TestEffortFittingOnModelSwitch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.configure(v.ID, ConfigReq{Model: "haiku"})
	if m := e.meta(v.ID); m.Effort != "" {
		t.Fatalf("haiku kept an effort: %+v", m)
	}
	e.configure(v.ID, ConfigReq{Model: "sonnet"})
	if m := e.meta(v.ID); m.Model != "sonnet" || m.Effort != "high" {
		t.Fatalf("haiku -> sonnet: %+v", m)
	}
	e.configure(v.ID, ConfigReq{Model: "claude-fable-5-1", Effort: "max"})
	e.configure(v.ID, ConfigReq{Model: "opus"})
	if m := e.meta(v.ID); m.Model != "opus" || m.Effort != "max" {
		t.Fatalf("an offered effort is kept: %+v", m)
	}

	// A model without the current effort takes its default effort.
	e.storeCatalog(model.Claude, &model.Catalog{
		Models:  []model.CatalogModel{{ID: "opus", Efforts: levels, DefaultEffort: "high"}, {ID: "mid", Efforts: []string{"medium", "low"}, DefaultEffort: "medium"}},
		Default: model.ModelChoice{Model: "opus", Effort: "high"},
	})
	e.configure(v.ID, ConfigReq{Model: "mid"})
	if m := e.meta(v.ID); m.Model != "mid" || m.Effort != "medium" {
		t.Fatalf("model lacking the effort: %+v", m)
	}
}

// D11: a process starts without an effort when the catalog lists its model with none.
func TestProcessStartsWithoutEffortForNoEffortModel(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.configure(v.ID, ConfigReq{Model: "haiku"})
	e.send(v.ID, "hi", "")
	if got := e.claude.last(t).opts; got.Model != "haiku" || got.Effort != "" {
		t.Fatalf("haiku chat started with %+v", got)
	}

	// A chat that already holds an effort its (listed, effortless) model lacks.
	e = newEnv(t)
	v = e.create(model.Claude, gOne, "")
	e.storeCatalog(model.Claude, &model.Catalog{
		Models:  []model.CatalogModel{{ID: "sonnet", Label: "Sonnet"}},
		Default: model.ModelChoice{Model: "sonnet"},
	})
	if m := e.meta(v.ID); m.Effort != "high" {
		t.Fatalf("setup: %+v", m)
	}
	e.send(v.ID, "hi", "")
	if got := e.claude.last(t).opts; got.Model != "sonnet" || got.Effort != "" {
		t.Fatalf("effortless model started with %+v", got)
	}

	// A model the catalog does not know keeps its stored effort.
	if got := e.m.effortFor(model.Claude, "unlisted", "high"); got != "high" {
		t.Fatalf("unknown model: %q", got)
	}
	if got := e.m.effortFor(model.Pi, "anything", "high"); got != "high" {
		t.Fatalf("unknown list: %q", got)
	}
}

// D11 is for Claude only: a Cursor or pi chat keeps its stored effort on a model its list shows
// without efforts, for the chat process (the subagent path is not exercised here).
func TestEffortGateOnlyForClaude(t *testing.T) {
	t.Parallel()
	withEfforts := &model.Catalog{
		Models:  []model.CatalogModel{{ID: "p/m", Efforts: []string{"medium"}, DefaultEffort: "medium"}},
		Default: model.ModelChoice{Model: "p/m", Effort: "medium"},
	}
	without := &model.Catalog{
		Models:  []model.CatalogModel{{ID: "p/m"}},
		Default: model.ModelChoice{Model: "p/m"},
	}
	for _, a := range []model.AgentKind{model.Cursor, model.Pi} {
		e := newEnv(t)
		sp := map[model.AgentKind]*fakeSpawner{model.Cursor: e.cursor, model.Pi: e.pi}[a]
		e.storeCatalog(a, withEfforts)
		v := e.create(a, gOne, "")
		e.configure(v.ID, ConfigReq{Model: "p/m", Effort: "medium"})
		e.storeCatalog(a, without)
		if got := e.m.effortFor(a, "p/m", "medium"); got != "medium" {
			t.Fatalf("%s: effortFor %q", a, got)
		}
		e.send(v.ID, "hi", "")
		if got := sp.last(t).opts; got.Model != "p/m" || got.Effort != "medium" {
			t.Fatalf("%s chat started with %+v", a, got)
		}
	}
}

// D22 with a kind whose list is not known: the chat's model and effort still do not pass to a
// cross-agent subagent that names no model. With no model picked for that kind it gets none.
func TestSubagentUnknownListDropsChatModel(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if err := e.st.Update(func(s *model.State) error { s.Cursor = nil; s.SetCatalog(model.Cursor, nil); return nil }); err != nil {
		t.Fatal(err)
	}
	if e.m.catalog(model.Cursor) != nil {
		t.Fatal("setup: Cursor list still known")
	}
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "x", Kind: model.Cursor})
	if sa.Kind != model.Cursor || sa.Model != "" || sa.Effort != "" {
		t.Fatalf("unknown Cursor list: %+v", sa)
	}
}

// D22 with a named effort: on a cross-agent spawn without a model, the effort is validated against
// the rebased model, not the chat's model that the other kind happens to list too.
func TestSubagentSharedIDNamedEffort(t *testing.T) {
	t.Parallel()
	xl := append(append([]string(nil), levels...), "xhigh")
	setup := func() *env {
		e := newEnv(t)
		e.storeCatalog(model.Claude, &model.Catalog{
			Models: []model.CatalogModel{
				{ID: "cl-only", Label: "Claude only", Efforts: xl, DefaultEffort: "low"},
				{ID: "shared", Label: "Shared", Efforts: levels, DefaultEffort: "high"},
				{ID: "saved", Label: "Saved", Efforts: xl, DefaultEffort: "high"},
			},
			Default: model.ModelChoice{Model: "cl-only", Effort: "low"},
		})
		e.storeCatalog(model.Cursor, &model.Catalog{
			Models: []model.CatalogModel{
				{ID: "cu-only", Label: "Cursor only", Efforts: xl, DefaultEffort: "high"},
				{ID: "shared", Label: "Shared", Efforts: levels, DefaultEffort: "high"},
			},
			Default: model.ModelChoice{Model: "cu-only", Effort: "high"},
		})
		return e
	}

	// (a) Cursor chat on the shared id -> Claude subagent.
	e := setup()
	cu := e.create(model.Cursor, gOne, "")
	e.configure(cu.ID, ConfigReq{Model: "shared", Effort: "low"})
	sa := e.spawn(cu.ID, SpawnSubRequest{Prompt: "x", Kind: model.Claude, Effort: "xhigh"})
	if sa.Model != "cl-only" || sa.Effort != "xhigh" {
		t.Fatalf("Cursor chat -> Claude subagent: %+v", sa)
	}
	if got := waitChild(t, e.claude, 1).opts; got.Model != "cl-only" || got.Effort != "xhigh" {
		t.Fatalf("options %+v", got)
	}
	if err := e.st.Update(func(s *model.State) error {
		defaults.RecordChange(&s.Defaults, gOne, model.LocalServer, model.Claude, "", model.ModelChoice{Model: "saved", Effort: "low"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sa = e.spawn(cu.ID, SpawnSubRequest{Prompt: "x", Kind: model.Claude, Effort: "xhigh"})
	if sa.Model != "saved" || sa.Effort != "xhigh" {
		t.Fatalf("with a saved Claude choice: %+v", sa)
	}

	// (c) The rebased model itself lacks the effort: still rejected, naming that model.
	if _, err := e.m.SpawnSubagent(cu.ID, SpawnSubRequest{Prompt: "x", Kind: model.Claude, Effort: "max"}); err == nil || !strings.Contains(err.Error(), `saved has no effort "max"`) {
		t.Fatalf("effort the rebased model lacks: %v", err)
	}

	// (b) Claude chat on the shared id -> Cursor subagent.
	e = setup()
	cl := e.create(model.Claude, gOne, "")
	e.configure(cl.ID, ConfigReq{Model: "shared", Effort: "low"})
	sa = e.spawn(cl.ID, SpawnSubRequest{Prompt: "x", Kind: model.Cursor, Effort: "xhigh"})
	if sa.Kind != model.Cursor || sa.Model != "cu-only" || sa.Effort != "xhigh" {
		t.Fatalf("Claude chat -> Cursor subagent: %+v", sa)
	}
	if _, err := e.m.SpawnSubagent(cl.ID, SpawnSubRequest{Prompt: "x", Kind: model.Cursor, Effort: "max"}); err == nil || !strings.Contains(err.Error(), `cu-only has no effort "max"`) {
		t.Fatalf("effort the rebased Cursor model lacks: %v", err)
	}

	// (d) Same kind: the chat's own model is still checked.
	if _, err := e.m.SpawnSubagent(cl.ID, SpawnSubRequest{Prompt: "x", Effort: "xhigh"}); err == nil || !strings.Contains(err.Error(), `shared has no effort "xhigh"`) {
		t.Fatalf("same-kind effort the chat's model lacks: %v", err)
	}
}

// A pi list as pi reports it: ids with a provider path, "off" as an effort value.
var storedPi = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "openrouter/openai/gpt-5", Label: "GPT-5", Provider: "openrouter", Efforts: []string{"off", "low", "high"}, DefaultEffort: "low"},
		{ID: "anthropic/claude-opus", Label: "Claude Opus", Provider: "anthropic", Efforts: []string{"off", "high"}},
		{ID: "local/llama", Label: "Llama", Provider: "local"},
	},
	Default: model.ModelChoice{Model: "openrouter/openai/gpt-5", Effort: "low"},
}

// A Cursor list with "none" as an effort value.
var storedCursor = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "gpt-5.4-mini", Label: "GPT 5.4 mini"},
		{ID: "composer-2", Label: "Composer 2", Efforts: []string{"none", "low", "high"}, DefaultEffort: "high"},
	},
	Default: model.ModelChoice{Model: "composer-2", Effort: "high"},
}

func (e *env) forgetCursorCatalog() {
	e.t.Helper()
	if err := e.st.Update(func(s *model.State) error { s.Cursor = nil; s.SetCatalog(model.Cursor, nil); return nil }); err != nil {
		e.t.Fatal(err)
	}
}

// Discovery reads the list spawn_subagent validates against: SpawnCatalog is catalog.
func TestSpawnCatalog(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if got := e.m.SpawnCatalog(model.Claude); got == nil || !reflect.DeepEqual(*got, claude.Catalog) {
		t.Fatalf("Claude, nothing stored: %+v", got)
	}
	e.storeCatalog(model.Claude, storedClaude)
	if got := e.m.SpawnCatalog(model.Claude); got == nil || !reflect.DeepEqual(*got, *storedClaude) {
		t.Fatalf("Claude, stored: %+v", got)
	}

	if got := e.m.SpawnCatalog(model.Pi); got != nil {
		t.Fatalf("pi before a list is stored: %+v", got)
	}
	e.storeCatalog(model.Pi, storedPi)
	if got := e.m.SpawnCatalog(model.Pi); got == nil || !reflect.DeepEqual(*got, *storedPi) {
		t.Fatalf("pi, stored: %+v", got)
	}

	if got := e.m.SpawnCatalog(model.Cursor); got == nil || !reflect.DeepEqual(*got, *cursorCatalog) {
		t.Fatalf("Cursor, the legacy field: %+v", got)
	}
	e.forgetCursorCatalog()
	if got := e.m.SpawnCatalog(model.Cursor); got != nil {
		t.Fatalf("Cursor after its list is cleared: %+v", got)
	}
	for _, a := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		if got, want := e.m.SpawnCatalog(a), e.m.catalog(a); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: SpawnCatalog %+v, catalog %+v", a, got, want)
		}
	}
}

// Every model and every effort SpawnCatalog returns is one spawn_subagent accepts for that kind,
// in the same state; so is every model with no effort named.
func TestSpawnCatalogListsWhatSpawnAccepts(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		kind   model.AgentKind
		stored *model.Catalog // nil: Claude's built-in list
	}{
		{"built-in Claude", model.Claude, nil},
		{"stored Claude", model.Claude, storedClaude},
		{"stored Cursor", model.Cursor, storedCursor},
		{"stored pi", model.Pi, storedPi},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t)
			v := e.create(model.Claude, gOne, "")
			if tc.stored != nil {
				e.storeCatalog(tc.kind, tc.stored)
			}
			cat := e.m.SpawnCatalog(tc.kind)
			if cat == nil || len(cat.Models) == 0 {
				t.Fatalf("no list: %+v", cat)
			}
			for _, cm := range cat.Models {
				sa, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "x", Kind: tc.kind, Model: cm.ID})
				if err != nil || sa.Kind != tc.kind || sa.Model != cm.ID {
					t.Fatalf("%s with no effort named: %+v, %v", cm.ID, sa, err)
				}
				for _, effort := range cm.Efforts {
					sa, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "x", Kind: tc.kind, Model: cm.ID, Effort: effort})
					if err != nil || sa.Kind != tc.kind || sa.Model != cm.ID || sa.Effort != effort {
						t.Fatalf("%s at %s: %+v, %v", cm.ID, effort, sa, err)
					}
				}
			}
		})
	}
}

// SpawnDefaults is what a spawn that names the agent alone records, in the same state.
func TestSpawnDefaultsMatchSpawn(t *testing.T) {
	t.Parallel()
	check := func(t *testing.T, e *env, chat string, kind model.AgentKind, wantKind model.AgentKind, wantModel, wantEffort string) {
		t.Helper()
		k, mo, ef, err := e.m.SpawnDefaults(chat, kind)
		if err != nil {
			t.Fatal(err)
		}
		if k != wantKind || mo != wantModel || ef != wantEffort {
			t.Fatalf("SpawnDefaults(%q) = %s %q %q, want %s %q %q", kind, k, mo, ef, wantKind, wantModel, wantEffort)
		}
		sa := e.spawn(chat, SpawnSubRequest{Prompt: "x", Kind: kind})
		if sa.Kind != k || sa.Model != mo || sa.Effort != ef {
			t.Fatalf("SpawnDefaults(%q) = %s %q %q, the spawn recorded %s %q %q", kind, k, mo, ef, sa.Kind, sa.Model, sa.Effort)
		}
	}

	t.Run("same kind on the built-in list", func(t *testing.T) {
		e := newEnv(t)
		v := e.create(model.Claude, gOne, "")
		check(t, e, v.ID, "", model.Claude, "sonnet", "high")
		check(t, e, v.ID, model.Claude, model.Claude, "sonnet", "high")
		e.configure(v.ID, ConfigReq{Model: "haiku"})
		check(t, e, v.ID, model.Claude, model.Claude, "haiku", "")
	})

	t.Run("a Claude chat whose model the stored list lacks", func(t *testing.T) {
		e := newEnv(t)
		v := e.create(model.Claude, gOne, "") // sonnet at high
		e.storeCatalog(model.Claude, storedClaude)
		check(t, e, v.ID, "", model.Claude, "cl-only", "low")
	})

	t.Run("cross-kind", func(t *testing.T) {
		e := newEnv(t)
		e.storeCatalog(model.Claude, storedClaude)
		e.storeCatalog(model.Cursor, sharedCursorCatalog)
		e.storeCatalog(model.Pi, storedPi)
		cu := e.create(model.Cursor, gOne, "")
		e.configure(cu.ID, ConfigReq{Model: "shared", Effort: "low"})
		check(t, e, cu.ID, model.Claude, model.Claude, "cl-only", "low")
		check(t, e, cu.ID, model.Pi, model.Pi, "openrouter/openai/gpt-5", "low")
		check(t, e, cu.ID, "", model.Cursor, "shared", "low")

		// With a saved Claude choice for the chat's group, that choice wins.
		if err := e.st.Update(func(s *model.State) error {
			defaults.RecordChange(&s.Defaults, gOne, model.LocalServer, model.Claude, "", model.ModelChoice{Model: "saved", Effort: "low"})
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		check(t, e, cu.ID, model.Claude, model.Claude, "saved", "low")
	})

	t.Run("a kind whose list is not known", func(t *testing.T) {
		e := newEnv(t)
		v := e.create(model.Claude, gOne, "")
		e.forgetCursorCatalog()
		check(t, e, v.ID, model.Cursor, model.Cursor, "", "")
		check(t, e, v.ID, model.Pi, model.Pi, "", "")
		// A chat created while its own list was not known has no model and no effort.
		cu := e.create(model.Cursor, gOne, "")
		check(t, e, cu.ID, "", model.Cursor, "", "")
	})
}

func TestSpawnDefaultsStartsNothing(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	before := e.meta(v.ID)
	files := func() []string {
		t.Helper()
		ents, err := os.ReadDir(e.st.P.ChatDir(v.ID))
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, ent := range ents {
			names = append(names, ent.Name())
		}
		return names
	}
	filesBefore := files()
	evs.drain(t, e.br)

	for _, kind := range []model.AgentKind{"", model.Claude, model.Cursor, model.Pi} {
		if _, _, _, err := e.m.SpawnDefaults(v.ID, kind); err != nil {
			t.Fatalf("%q: %v", kind, err)
		}
	}
	if _, _, _, err := e.m.SpawnDefaults("nope", model.Claude); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown chat: %v", err)
	}
	if _, _, _, err := e.m.SpawnDefaults(v.ID, "gemini"); err == nil || err.Error() != `unknown agent "gemini"` {
		t.Fatalf("unknown kind: %v", err)
	}

	if n := e.claude.count() + e.cursor.count() + e.pi.count(); n != 0 {
		t.Fatalf("%d processes started", n)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("messages %v", got)
	}
	if items := e.items(v.ID); len(items) != 0 {
		t.Fatalf("items %+v", items)
	}
	if subs := e.subs(v.ID); len(subs) != 0 {
		t.Fatalf("subagents %+v", subs)
	}
	if _, err := os.Stat(filepath.Join(e.st.P.ChatDir(v.ID), "subagents")); !os.IsNotExist(err) {
		t.Fatalf("subagents folder: %v", err)
	}
	if got := files(); !reflect.DeepEqual(got, filesBefore) {
		t.Fatalf("chat folder %v, was %v", got, filesBefore)
	}
	if after := e.meta(v.ID); !reflect.DeepEqual(after, before) {
		t.Fatalf("chat.json changed: %+v, was %+v", after, before)
	}
	// The chat is not left locked.
	e.configure(v.ID, ConfigReq{Model: "opus"})
}
