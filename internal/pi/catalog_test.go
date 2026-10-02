package pi

import (
	"encoding/json"
	"testing"
)

func TestCatalogFrom(t *testing.T) {
	state := json.RawMessage(`{"sessionId":"s","model":{"provider":"deepseek","id":"flash"}}`)
	models := json.RawMessage(`{"models":[
		{"id":"flash","name":"Flash","provider":"deepseek","reasoning":true,
		 "thinkingLevelMap":{"minimal":null,"medium":null,"max":"max"},"contextWindow":1000000},
		{"id":"plain","provider":"deepseek","reasoning":false,"contextWindow":1000},
		{"id":"bare","name":"","reasoning":true}
	]}`)
	cat := catalogFrom(state, models)
	if cat == nil || len(cat.Models) != 3 {
		t.Fatalf("catalog %+v", cat)
	}

	flash := cat.Models[0]
	if flash.ID != "deepseek/flash" || flash.Label != "Flash" || flash.Provider != "deepseek" || flash.ContextWindow != 1000000 {
		t.Errorf("flash %+v", flash)
	}
	if !equalStrings(flash.Efforts, []string{"off", "low", "high", "max"}) {
		t.Errorf("flash efforts %q, want off/low/high/max", flash.Efforts)
	}
	if flash.DefaultEffort != "low" {
		t.Errorf("flash default effort %q, want low", flash.DefaultEffort)
	}

	plain := cat.Models[1]
	if plain.ID != "deepseek/plain" || plain.Label != "plain" || plain.Provider != "deepseek" {
		t.Errorf("plain %+v", plain)
	}
	if len(plain.Efforts) != 0 || plain.DefaultEffort != "" {
		t.Errorf("non-reasoning plain %+v, want no efforts", plain)
	}

	bare := cat.Models[2]
	if bare.ID != "bare" || bare.Label != "bare" || bare.Provider != "" {
		t.Errorf("bare %+v", bare)
	}
	if !equalStrings(bare.Efforts, []string{"off", "minimal", "low", "medium", "high"}) {
		t.Errorf("bare efforts %q", bare.Efforts)
	}
	if bare.DefaultEffort != "medium" {
		t.Errorf("bare default effort %q, want medium", bare.DefaultEffort)
	}

	if cat.Default.Model != "deepseek/flash" || cat.Default.Effort != "low" {
		t.Errorf("default %+v, want the current state model", cat.Default)
	}
}

func TestCatalogFromTwoProviders(t *testing.T) {
	models := json.RawMessage(`{"models":[
		{"id":"flash","name":"Flash","provider":"deepseek","contextWindow":1000},
		{"id":"gpt","name":"GPT","provider":"openai-codex","contextWindow":2000},
		{"id":"bare","name":"Bare"}
	]}`)
	cat := catalogFrom(nil, models)
	if cat == nil || len(cat.Models) != 3 {
		t.Fatalf("catalog %+v", cat)
	}
	want := []string{"deepseek", "openai-codex", ""}
	for i, w := range want {
		if cat.Models[i].Provider != w {
			t.Errorf("model %d provider %q, want %q", i, cat.Models[i].Provider, w)
		}
	}
	if cat.Models[0].ID != "deepseek/flash" || cat.Models[1].ID != "openai-codex/gpt" || cat.Models[2].ID != "bare" {
		t.Errorf("ids %+v", []string{cat.Models[0].ID, cat.Models[1].ID, cat.Models[2].ID})
	}
}

func TestCatalogFromFallbacks(t *testing.T) {
	// A state model that is not offered falls back to the first model.
	state := json.RawMessage(`{"model":{"provider":"gone","id":"model"}}`)
	models := json.RawMessage(`{"models":[{"id":"one","provider":"p","reasoning":false}]}`)
	cat := catalogFrom(state, models)
	if cat == nil || cat.Default.Model != "p/one" || cat.Default.Effort != "" {
		t.Fatalf("fallback catalog %+v", cat)
	}

	// xhigh and max are only added when the map defines them non-null.
	models = json.RawMessage(`{"models":[{"id":"m","provider":"p","reasoning":true,"thinkingLevelMap":{"xhigh":null,"max":"max"}}]}`)
	cat = catalogFrom(nil, models)
	if cat == nil || !equalStrings(cat.Models[0].Efforts, []string{"off", "minimal", "low", "medium", "high", "max"}) {
		t.Fatalf("xhigh/max efforts %+v", cat)
	}

	// All non-off levels null: the only effort is off, and it is the default.
	models = json.RawMessage(`{"models":[{"id":"m","provider":"p","reasoning":true,"thinkingLevelMap":{"minimal":null,"low":null,"medium":null,"high":null}}]}`)
	cat = catalogFrom(nil, models)
	if cat == nil || !equalStrings(cat.Models[0].Efforts, []string{"off"}) || cat.Models[0].DefaultEffort != "off" {
		t.Fatalf("off-only efforts %+v", cat)
	}

	// No models at all.
	if cat := catalogFrom(nil, json.RawMessage(`{"models":[]}`)); cat != nil {
		t.Fatalf("empty catalog %+v", cat)
	}
	if cat := catalogFrom(nil, nil); cat != nil {
		t.Fatalf("nil catalog %+v", cat)
	}
}

func TestQualifiedID(t *testing.T) {
	if got := qualifiedID("p", "m"); got != "p/m" {
		t.Errorf("qualifiedID(p, m) = %q", got)
	}
	if got := qualifiedID("", "m"); got != "m" {
		t.Errorf("qualifiedID(\"\", m) = %q", got)
	}
}
