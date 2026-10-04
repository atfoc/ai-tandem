package model

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestViewOfHidesSecrets(t *testing.T) {
	m := ChatMeta{
		ID:                  "c1",
		Agent:               Cursor,
		Name:                "My chat",
		Board:               "b_abc",
		Cwd:                 "/tmp",
		Model:               "sonnet",
		SessionID:           "sess-SECRET-1",
		Locked:              true,
		Token:               "tok-SECRET-2",
		Created:             time.Unix(0, 0).UTC(),
		TurnActive:          true,
		InstructionsSent:    true,
		McpInstructionsSent: true,
		Usage:               Usage{Turns: 3},
	}
	v := ViewOf(m, StatusTool, "Bash", "", true)
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, bad := range []string{"tok-SECRET-2", "sess-SECRET-1", "token", "sessionId", "turnActive", "mcpInstructionsSent"} {
		if strings.Contains(s, bad) {
			t.Errorf("view JSON contains %q: %s", bad, s)
		}
	}
	for _, want := range []string{`"id":"c1"`, `"agent":"cursor"`, `"board":"b_abc"`, `"locked":true`, `"status":"tool"`, `"statusTool":"Bash"`, `"folderMissing":true`, `"turns":3`, `"instructionsSent":true`} {
		if !strings.Contains(s, want) {
			t.Errorf("view JSON missing %s: %s", want, s)
		}
	}
}

// The two subagent counts go to clients under the names the web reads, and are left out when zero,
// so a view without subagents is the view it was before they existed.
func TestViewSubCountsJSON(t *testing.T) {
	b, err := json.Marshal(ChatView{ID: "c1", Status: StatusReady, SubsRunning: 2, SubsOwed: 1})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"subsRunning":2`, `"subsOwed":1`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("view JSON missing %s: %s", want, b)
		}
	}
	b, err = json.Marshal(ViewOf(ChatMeta{ID: "c1"}, StatusReady, "", "", false))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "subs") {
		t.Errorf("view JSON has counts for a chat with no subagents: %s", b)
	}
}

func TestStateCatalogLegacyFallback(t *testing.T) {
	legacy := &Catalog{Models: []CatalogModel{{ID: "composer-2", Label: "Composer 2", Provider: "cursor"}}, Default: ModelChoice{Model: "legacy"}}
	generic := &Catalog{Models: []CatalogModel{{ID: "deepseek-flash", Label: "DeepSeek Flash", Provider: "deepseek"}}, Default: ModelChoice{Model: "generic"}}
	s := &State{Cursor: legacy}
	if got := s.Catalog(Cursor); got != legacy {
		t.Fatalf("Cursor catalog = %+v, want the legacy field", got)
	}
	if got := s.Catalog(Pi); got != nil {
		t.Fatalf("Pi catalog before it is stored: %+v", got)
	}
	s.SetCatalog(Pi, generic)
	if got := s.Catalog(Pi); got != generic {
		t.Fatalf("Pi catalog = %+v, want the stored one", got)
	}
	if got := s.Catalog(Cursor); got != legacy {
		t.Fatalf("SetCatalog(Pi) changed Cursor: %+v", got)
	}
	s.SetCatalog(Cursor, generic)
	if got := s.Catalog(Cursor); got != generic {
		t.Fatalf("Cursor catalog = %+v, want the generic map to win", got)
	}
	var nilState *State
	if got := nilState.Catalog(Pi); got != nil {
		t.Fatalf("nil State.Catalog = %+v, want nil", got)
	}

	// A state written through the legacy field carries the provider across JSON.
	raw, err := json.Marshal(State{Version: 1, Cursor: legacy})
	if err != nil {
		t.Fatal(err)
	}
	var back State
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if got := back.Catalog(Cursor); got == nil || len(got.Models) != 1 || got.Models[0].Provider != "cursor" {
		t.Fatalf("legacy Cursor catalog after round trip: %+v", got)
	}
}

func TestStateCatalogJSON(t *testing.T) {
	cat := &Catalog{Models: []CatalogModel{{ID: "deepseek-flash", Label: "DeepSeek Flash", Provider: "deepseek"}}, Default: ModelChoice{Model: "deepseek-flash"}}
	var s State
	s.SetCatalog(Pi, cat)
	raw, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"catalogs":{`) {
		t.Errorf("State JSON lacks the catalogs map: %s", raw)
	}
	var back State
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if got := back.Catalog(Pi); got == nil || got.Default.Model != "deepseek-flash" || got.Models[0].Provider != "deepseek" {
		t.Fatalf("Pi catalog after round trip: %+v", got)
	}

	// The legacy cursorCatalog field still decodes.
	var legacy State
	if err := json.Unmarshal([]byte(`{"version":1,"cursorCatalog":{"models":[{"id":"composer-2","label":"Composer 2","provider":"cursor"}],"default":{"model":"composer-2"}}}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if got := legacy.Catalog(Cursor); got == nil || got.Default.Model != "composer-2" || got.Models[0].Provider != "cursor" {
		t.Fatalf("legacy Cursor catalog: %+v", got)
	}
	if got := legacy.Catalog(Pi); got != nil {
		t.Fatalf("legacy state reported a pi catalog: %+v", got)
	}

	// A version-1 state.json written before the provider existed has no key and decodes
	// with an empty provider.
	var old State
	if err := json.Unmarshal([]byte(`{"version":1,"catalogs":{"pi":{"models":[{"id":"deepseek-flash","label":"DeepSeek Flash"}],"default":{"model":"deepseek-flash"}}}}`), &old); err != nil {
		t.Fatal(err)
	}
	if got := old.Catalog(Pi); got == nil || len(got.Models) != 1 || got.Models[0].Provider != "" {
		t.Fatalf("version-1 pi catalog without provider: %+v", got)
	}
}

func TestNewID(t *testing.T) {
	re := regexp.MustCompile(`^b_[0-9a-z]{8}$`)
	seen := map[string]bool{}
	for range 100 {
		id := NewID("b_")
		if !re.MatchString(id) {
			t.Fatalf("bad id %q", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = true
	}
}

func TestCatalogModelProviderJSON(t *testing.T) {
	b, err := json.Marshal(CatalogModel{ID: "deepseek/deepseek-chat", Label: "DeepSeek Chat", Provider: "deepseek"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"provider":"deepseek"`) {
		t.Errorf("JSON lacks the literal provider key: %s", b)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got["provider"] != "deepseek" {
		t.Errorf("provider = %v, want deepseek; json %s", got["provider"], b)
	}

	// A provider-less model (Claude, Cursor) omits the key entirely.
	b, err = json.Marshal(CatalogModel{ID: "sonnet", Label: "Sonnet"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "provider") {
		t.Errorf("provider-less model JSON has a provider key: %s", b)
	}
	got = nil
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if _, present := got["provider"]; present {
		t.Errorf("provider key present in %s, want absent", b)
	}
}

func TestCatalogModelEffortFieldsJSON(t *testing.T) {
	full := CatalogModel{
		ID:            "gpt-5.4",
		Label:         "GPT-5.4",
		DefaultEffort: "medium",
		EffortLabels:  map[string]string{"xhigh": "Extra High"},
	}
	b, err := json.Marshal(full)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got["defaultEffort"] != "medium" {
		t.Errorf("defaultEffort = %v, want medium; json %s", got["defaultEffort"], b)
	}
	labels, ok := got["effortLabels"].(map[string]any)
	if !ok || labels["xhigh"] != "Extra High" {
		t.Errorf("effortLabels = %v, want {xhigh: Extra High}; json %s", got["effortLabels"], b)
	}

	b, err = json.Marshal(CatalogModel{ID: "sonnet", Label: "Sonnet"})
	if err != nil {
		t.Fatal(err)
	}
	got = nil
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"defaultEffort", "effortLabels"} {
		if _, present := got[k]; present {
			t.Errorf("key %q present in %s, want absent", k, b)
		}
	}
}

// Owed and owed after one failed attempt are the owed states; a given-up result is not owed.
func TestSubDeliveryOwed(t *testing.T) {
	for d, want := range map[SubDelivery]bool{
		SubNotOwed: false, SubOwed: true, SubOwedAgain: true, SubSent: false, SubGivenUp: false, "queued": false,
	} {
		if d.Owed() != want {
			t.Errorf("%q.Owed() = %v, want %v", d, d.Owed(), want)
		}
	}
	// The states are stored and sent to clients as these strings.
	b, err := json.Marshal([]SubDelivery{SubOwed, SubOwedAgain, SubSent, SubGivenUp})
	if err != nil || string(b) != `["owed","retry","sent","given-up"]` {
		t.Fatalf("%s %v", b, err)
	}
}
