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
		ID:               "c1",
		Agent:            Cursor,
		Name:             "My chat",
		Board:            "b_abc",
		Cwd:              "/tmp",
		Model:            "sonnet",
		SessionID:        "sess-SECRET-1",
		Locked:           true,
		Token:            "tok-SECRET-2",
		Created:          time.Unix(0, 0).UTC(),
		TurnActive:       true,
		InstructionsSent: true,
		Usage:            Usage{Turns: 3},
	}
	v := ViewOf(m, StatusTool, "Bash", "", true)
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, bad := range []string{"tok-SECRET-2", "sess-SECRET-1", "token", "sessionId", "turnActive", "instructionsSent"} {
		if strings.Contains(s, bad) {
			t.Errorf("view JSON contains %q: %s", bad, s)
		}
	}
	for _, want := range []string{`"id":"c1"`, `"agent":"cursor"`, `"board":"b_abc"`, `"locked":true`, `"status":"tool"`, `"statusTool":"Bash"`, `"folderMissing":true`, `"turns":3`} {
		if !strings.Contains(s, want) {
			t.Errorf("view JSON missing %s: %s", want, s)
		}
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
