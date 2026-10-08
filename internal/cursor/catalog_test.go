package cursor

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"ai-whiteboard/internal/model"
)

func loadModelList(t *testing.T) (json.RawMessage, *model.Catalog) {
	t.Helper()
	raw, err := os.ReadFile("testdata/models.json")
	if err != nil {
		t.Fatal(err)
	}
	c := ParseModelList(raw)
	if c == nil {
		t.Fatal("ParseModelList returned nil")
	}
	return raw, c
}

func findModel(t *testing.T, c *model.Catalog, id string) model.CatalogModel {
	t.Helper()
	for _, m := range c.Models {
		if m.ID == id {
			return m
		}
	}
	t.Fatalf("model %q not in catalog", id)
	return model.CatalogModel{}
}

func TestParseModelList(t *testing.T) {
	t.Parallel()
	raw, c := loadModelList(t)

	// Every model in the file appears once, in file order; Default is left empty.
	var file struct {
		Models []struct {
			Value string `json:"value"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	var want, got []string
	for _, m := range file.Models {
		want = append(want, m.Value)
	}
	for _, m := range c.Models {
		got = append(got, m.ID)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("model ids = %v, want %v", got, want)
	}
	if c.Default != (model.ModelChoice{}) {
		t.Errorf("Default = %+v, want empty", c.Default)
	}

	opus := findModel(t, c, "claude-opus-5-5")
	if opus.Label != "Claude Opus 5.5" {
		t.Errorf("opus Label = %q", opus.Label)
	}
	if !reflect.DeepEqual(opus.Efforts, []string{"low", "medium", "high", "xhigh", "max"}) {
		t.Errorf("opus Efforts = %v", opus.Efforts)
	}
	if opus.DefaultEffort != "medium" {
		t.Errorf("opus DefaultEffort = %q", opus.DefaultEffort)
	}
	wantLabels := map[string]string{"low": "Low", "medium": "Medium", "high": "High", "xhigh": "Extra High", "max": "Max"}
	if !reflect.DeepEqual(opus.EffortLabels, wantLabels) {
		t.Errorf("opus EffortLabels = %v", opus.EffortLabels)
	}
	if opus.ContextWindow != 1_000_000 {
		t.Errorf("opus ContextWindow = %d", opus.ContextWindow)
	}

	// A model that also has a "thinking" thought_level option still gets its effort option.
	opus5 := findModel(t, c, "claude-opus-5")
	if len(opus5.Efforts) == 0 || opus5.Efforts[0] != "low" || opus5.DefaultEffort != "high" {
		t.Errorf("claude-opus-5 Efforts = %v, DefaultEffort = %q", opus5.Efforts, opus5.DefaultEffort)
	}

	mini := findModel(t, c, "gpt-5.4-mini")
	if mini.Label != "GPT-5.4 Mini" {
		t.Errorf("mini Label = %q", mini.Label)
	}
	if len(mini.Efforts) == 0 || mini.Efforts[0] != "none" {
		t.Errorf("mini Efforts = %v", mini.Efforts)
	}
	if mini.DefaultEffort != "medium" {
		t.Errorf("mini DefaultEffort = %q", mini.DefaultEffort)
	}
	if mini.ContextWindow != 0 {
		t.Errorf("mini ContextWindow = %d", mini.ContextWindow)
	}

	gpt55 := findModel(t, c, "gpt-5.5")
	if !contains(gpt55.Efforts, "extra-high") {
		t.Errorf("gpt-5.5 Efforts = %v", gpt55.Efforts)
	}

	for _, id := range []string{"claude-sonnet-4", "auto-smart"} {
		m := findModel(t, c, id)
		if len(m.Efforts) != 0 || m.EffortLabels != nil || m.DefaultEffort != "" {
			t.Errorf("%s: Efforts = %v, EffortLabels = %v, DefaultEffort = %q", id, m.Efforts, m.EffortLabels, m.DefaultEffort)
		}
	}
}

func TestParseModelListStripsTrailingEffort(t *testing.T) {
	t.Parallel()
	c := ParseModelList(json.RawMessage(`{"models":[{"value":"g","name":"Gemini 3.8 Flash High"},{"value":"h","name":"High"}]}`))
	if c == nil {
		t.Fatal("nil catalog")
	}
	if c.Models[0].Label != "Gemini 3.8 Flash" {
		t.Errorf("Label = %q", c.Models[0].Label)
	}
	if c.Models[1].Label != "High" {
		t.Errorf("Label = %q, want the name kept when stripping leaves nothing", c.Models[1].Label)
	}
}

func TestParseModelListInvalid(t *testing.T) {
	t.Parallel()
	for _, in := range []string{`not json`, `{"models":[]}`} {
		if c := ParseModelList(json.RawMessage(in)); c != nil {
			t.Errorf("ParseModelList(%s) = %+v, want nil", in, c)
		}
	}
}

func TestContextSize(t *testing.T) {
	t.Parallel()
	cases := []struct {
		in   string
		want int
		ok   bool
	}{
		{"200k", 200_000, true},
		{"272k", 272_000, true},
		{"300k", 300_000, true},
		{"1m", 1_000_000, true},
		{"1M", 1_000_000, true},
		{"big", 0, false},
		{"", 0, false},
		{"k", 0, false},
	}
	for _, tc := range cases {
		got, ok := contextSize(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("contextSize(%q) = %d, %v; want %d, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestLargestContext(t *testing.T) {
	t.Parallel()
	for _, in := range [][]string{{"1m", "300k"}, {"300k", "1m"}} {
		if v, n := largestContext(in); v != "1m" || n != 1_000_000 {
			t.Errorf("largestContext(%v) = %q, %d; want 1m", in, v, n)
		}
	}
	if v, n := largestContext([]string{"x"}); v != "" || n != 0 {
		t.Errorf("largestContext([x]) = %q, %d", v, n)
	}
}
