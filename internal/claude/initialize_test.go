package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// fixtureLine is a testdata fixture as the one line the CLI emits.
func fixtureLine(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	line, _ := json.Marshal(v)
	return line
}

// initLine builds an initialize answer from model entries given as JSON objects.
func initLine(entries ...string) []byte {
	return []byte(`{"type":"control_response","response":{"subtype":"success","request_id":"r","response":{"models":[` +
		strings.Join(entries, ",") + `]}}}`)
}

// entry builds one entry: value, resolvedModel, displayName, and the effort levels (none: no keys).
func entry(value, resolved, name string, efforts ...string) string {
	m := map[string]any{"value": value}
	if resolved != "" {
		m["resolvedModel"] = resolved
	}
	if name != "" {
		m["displayName"] = name
		m["description"] = "about " + name
	}
	if len(efforts) > 0 {
		m["supportedEffortLevels"] = efforts
	}
	b, _ := json.Marshal(m)
	return string(b)
}

var allEfforts = []string{"low", "medium", "high", "xhigh", "max"}

func mapped(t *testing.T, line []byte) *model.Catalog {
	t.Helper()
	cat, err := CatalogFromInitialize(line)
	if err != nil {
		t.Fatalf("CatalogFromInitialize: %v", err)
	}
	return cat
}

func ids(cat *model.Catalog) []string {
	var out []string
	for _, m := range cat.Models {
		out = append(out, m.ID)
	}
	return out
}

func TestCatalogFromInitializeFixture(t *testing.T) {
	cat := mapped(t, fixtureLine(t, "initialize.json"))
	want := []string{"opus", "claude-fable-5-1", "sonnet", "haiku"}
	if len(cat.Models) != 11 {
		t.Fatalf("%d rows: %v", len(cat.Models), ids(cat))
	}
	// CLI order, no default row, ids are the CLI's values.
	var raw struct {
		Response struct {
			Response struct {
				Models []initModel `json:"models"`
			} `json:"response"`
		} `json:"response"`
	}
	json.Unmarshal(fixtureLine(t, "initialize.json"), &raw)
	var order []string
	for _, m := range raw.Response.Response.Models {
		if m.Value != "default" {
			order = append(order, m.Value)
		}
	}
	if !reflect.DeepEqual(ids(cat), order) {
		t.Errorf("ids %v, want %v", ids(cat), order)
	}
	byID := map[string]model.CatalogModel{}
	for _, m := range cat.Models {
		byID[m.ID] = m
		if m.ContextWindow != 0 {
			t.Errorf("%s has a context window", m.ID)
		}
		if len(m.Efforts) > 0 && m.DefaultEffort == "" {
			t.Errorf("%s has efforts and no default effort", m.ID)
		}
		if len(m.Efforts) == 0 && m.DefaultEffort != "" {
			t.Errorf("%s has a default effort and no efforts", m.ID)
		}
		if m.Label == "" || m.Label == m.ID {
			t.Errorf("%s label %q", m.ID, m.Label)
		}
	}
	for _, id := range want {
		if _, ok := byID[id]; !ok {
			t.Errorf("no row %s", id)
		}
	}
	if len(byID["haiku"].Efforts) != 0 {
		t.Errorf("haiku efforts %v", byID["haiku"].Efforts)
	}
	for _, id := range []string{"claude-opus-4-6", "claude-sonnet-4-6"} {
		m, ok := byID[id]
		if !ok {
			t.Fatalf("no row %s", id)
		}
		for _, e := range m.Efforts {
			if e == "xhigh" {
				t.Errorf("%s offers xhigh", id)
			}
		}
		if len(m.Efforts) == 0 {
			t.Errorf("%s has no efforts", id)
		}
	}
	if byID["opus"].DefaultEffort != "high" {
		t.Errorf("opus default effort %q", byID["opus"].DefaultEffort)
	}
	// In the captured fixture `default` resolves to the same model as `sonnet`.
	if cat.Default != (model.ModelChoice{Model: "sonnet", Effort: "high"}) {
		t.Errorf("default %+v", cat.Default)
	}
}

func TestCatalogFromInitializeDropsSynthesizedEntry(t *testing.T) {
	plain := mapped(t, fixtureLine(t, "initialize.json"))
	synth := mapped(t, fixtureLine(t, "initialize_synthesized.json"))
	if !reflect.DeepEqual(plain, synth) {
		t.Errorf("synthesized fixture maps to %v, plain to %v", ids(synth), ids(plain))
	}
}

func TestCatalogFromInitializeUnusable(t *testing.T) {
	cases := map[string][]byte{
		"error subtype":    []byte(`{"type":"control_response","response":{"subtype":"error","request_id":"r","error":"nope"}}`),
		"no models":        []byte(`{"type":"control_response","response":{"subtype":"success","request_id":"r","response":{}}}`),
		"empty models":     initLine(),
		"no value":         initLine(entry("opus", "", "Opus"), `{"displayName":"Nameless"}`),
		"only synthesized": initLine(entry("x", "x", "x"), entry("y", "y", "y")),
		"not json":         []byte(`nope`),
	}
	for name, line := range cases {
		if cat, err := CatalogFromInitialize(line); err == nil {
			t.Errorf("%s: usable: %+v", name, cat)
		}
	}
}

func TestCatalogFromInitializeDefaultRules(t *testing.T) {
	sonnet := entry("sonnet", "m-sonnet", "Sonnet", allEfforts...)
	opus := entry("opus", "m-opus", "Opus", allEfforts...)
	haiku := entry("haiku", "m-haiku", "Haiku")
	def := func(resolved string) string {
		return entry("default", resolved, "Default (recommended)", allEfforts...)
	}
	builtin := Catalog.Default.Model

	t.Run("twin other than the built-in default", func(t *testing.T) {
		cat := mapped(t, initLine(def("m-opus"), sonnet, opus, haiku))
		if cat.Default.Model != "opus" || cat.Default.Effort != "high" {
			t.Errorf("default %+v", cat.Default)
		}
		if !reflect.DeepEqual(ids(cat), []string{"sonnet", "opus", "haiku"}) {
			t.Errorf("rows %v", ids(cat))
		}
	})
	t.Run("no default entry, built-in default among rows", func(t *testing.T) {
		cat := mapped(t, initLine(opus, entry(builtin, "m-b", "B", allEfforts...)))
		if cat.Default.Model != builtin {
			t.Errorf("default %+v", cat.Default)
		}
	})
	t.Run("no default entry, built-in default missing", func(t *testing.T) {
		cat := mapped(t, initLine(opus, haiku))
		if cat.Default.Model != "opus" {
			t.Errorf("default %+v", cat.Default)
		}
	})
	t.Run("default without a twin is a row, skipped for the default", func(t *testing.T) {
		cat := mapped(t, initLine(def("m-other"), opus, haiku))
		if !reflect.DeepEqual(ids(cat), []string{"default", "opus", "haiku"}) {
			t.Errorf("rows %v", ids(cat))
		}
		if cat.Default.Model != "opus" {
			t.Errorf("default %+v", cat.Default)
		}
		// even when the built-in default is not among the rows, the kept default row is skipped
		cat = mapped(t, initLine(def("m-other"), haiku))
		if cat.Default.Model != "haiku" {
			t.Errorf("default %+v", cat.Default)
		}
	})
	t.Run("default as the only row is the default", func(t *testing.T) {
		cat := mapped(t, initLine(def("m-other")))
		if cat.Default != (model.ModelChoice{Model: "default", Effort: "high"}) {
			t.Errorf("default %+v", cat.Default)
		}
	})
	t.Run("several rows share the default's model", func(t *testing.T) {
		dup := entry("opus-copy", "m-opus", "Opus copy", allEfforts...)
		cat := mapped(t, initLine(def("m-opus"), haiku, opus, dup))
		if cat.Default.Model != "opus" {
			t.Errorf("default %+v", cat.Default)
		}
		if !reflect.DeepEqual(ids(cat), []string{"haiku", "opus", "opus-copy"}) {
			t.Errorf("rows %v", ids(cat))
		}
	})
	t.Run("only twin is synthesized", func(t *testing.T) {
		cat := mapped(t, initLine(def("m-x"), opus, entry("m-x", "m-x", "m-x", allEfforts...)))
		if !reflect.DeepEqual(ids(cat), []string{"default", "opus"}) {
			t.Errorf("rows %v", ids(cat))
		}
		if cat.Default.Model != "opus" {
			t.Errorf("default %+v", cat.Default)
		}
	})
	t.Run("no resolvedModel", func(t *testing.T) {
		cat := mapped(t, initLine(def(""), entry("opus", "", "Opus", allEfforts...), entry("plain", "", "Plain")))
		if !reflect.DeepEqual(ids(cat), []string{"default", "opus", "plain"}) {
			t.Errorf("rows %v", ids(cat))
		}
		if cat.Default.Model != "opus" {
			t.Errorf("default %+v", cat.Default)
		}
	})
	t.Run("default lands on a row without efforts", func(t *testing.T) {
		cat := mapped(t, initLine(entry("default", "m-haiku", "Default"), opus, haiku))
		if cat.Default != (model.ModelChoice{Model: "haiku"}) {
			t.Errorf("default %+v", cat.Default)
		}
	})
}

func TestCatalogFromInitializeRows(t *testing.T) {
	cat := mapped(t, initLine(
		entry("bare", "", ""),
		entry("same", "same", "same"),
		entry("med", "", "Med", "low", "medium"),
		entry("odd", "", "Odd", "fast", "slow"),
		entry("hi", "", "Hi", "max", "high", "low"),
	))
	if !reflect.DeepEqual(ids(cat), []string{"bare", "med", "odd", "hi"}) {
		t.Fatalf("rows %v", ids(cat))
	}
	if cat.Models[0].Label != "bare" {
		t.Errorf("label %q, want the id", cat.Models[0].Label)
	}
	for i, want := range []string{"", "medium", "fast", "high"} {
		if got := cat.Models[i].DefaultEffort; got != want {
			t.Errorf("%s default effort %q, want %q", cat.Models[i].ID, got, want)
		}
	}
}

func TestCatalogFromInitializeFreshValue(t *testing.T) {
	line := fixtureLine(t, "initialize.json")
	builtin := model.Catalog{Default: Catalog.Default, Models: append([]model.CatalogModel(nil), Catalog.Models...)}
	for i := range builtin.Models {
		builtin.Models[i].Efforts = append([]string(nil), Catalog.Models[i].Efforts...)
	}
	a, b := mapped(t, line), mapped(t, line)
	a.Models[0].Efforts[0] = "changed"
	a.Models[0].ID = "changed"
	if b.Models[0].Efforts[0] == "changed" {
		t.Error("two catalogs share an efforts slice")
	}
	if len(Catalog.Models) != 4 || Catalog.Models[0].ID != "opus" {
		t.Errorf("built-in list changed: %+v", Catalog.Models)
	}
	if !reflect.DeepEqual(Catalog, builtin) {
		t.Errorf("built-in list changed:\n got %+v\nwant %+v", Catalog, builtin)
	}
}

// An error answer without text still gives a reason.
func TestCatalogFromInitializeErrorWithoutText(t *testing.T) {
	_, err := CatalogFromInitialize([]byte(`{"type":"control_response","response":{"subtype":"error","request_id":"r"}}`))
	if err == nil || !strings.Contains(err.Error(), "no reason") {
		t.Errorf("err = %v", err)
	}
}
