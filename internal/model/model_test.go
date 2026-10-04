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
		ForkSource:          &ForkSource{Chat: "c0", Session: "sess-SECRET-3", Point: "point-SECRET-4", Next: "next-SECRET-5", Items: 7},
		ForkedFrom:          "c0",
		ForkedFromTitle:     "Old chat",
	}
	v := ViewOf(m, StatusTool, "Bash", "", true)
	if v != ViewOf(m, StatusTool, "Bash", "", true) { // ChatView is comparable
		t.Error("two views of the same chat differ")
	}
	if v.ForkedFrom != "c0" || v.ForkedFromTitle != "Old chat" || v.Branches != 0 || v.Branch != "" {
		t.Errorf("view %+v", v)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, bad := range []string{"tok-SECRET-2", "sess-SECRET-1", "token", "sessionId", "turnActive", "mcpInstructionsSent",
		"forkSource", "sess-SECRET-3", "point-SECRET-4", "next-SECRET-5", `"branches"`, `"branch"`} {
		if strings.Contains(s, bad) {
			t.Errorf("view JSON contains %q: %s", bad, s)
		}
	}
	for _, want := range []string{`"id":"c1"`, `"agent":"cursor"`, `"board":"b_abc"`, `"locked":true`, `"status":"tool"`, `"statusTool":"Bash"`, `"folderMissing":true`, `"turns":3`, `"instructionsSent":true`,
		`"forkedFrom":"c0"`, `"forkedFromTitle":"Old chat"`} {
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

// The fork and tree types are read by the web client and kept on disk: their JSON is fixed.
func TestForkAndTreeJSON(t *testing.T) {
	before := 3
	for _, tc := range []struct {
		v    any
		want string
	}{
		{Item{Kind: "end"}, `{"kind":"end"}`},
		{Item{Kind: "end", Point: "p1"}, `{"kind":"end","point":"p1"}`},
		{ForkSource{Chat: "c0", Session: "s0"}, `{"chat":"c0","session":"s0","items":0}`},
		{ForkSource{Chat: "c0", Session: "s0", Point: "p1", Next: "p2", Items: 3},
			`{"chat":"c0","session":"s0","point":"p1","next":"p2","items":3}`},
		{ChatMeta{ID: "c1", Agent: Claude, ForkedFrom: "c0", ForkedFromTitle: "Old chat", ForkSource: &ForkSource{Chat: "c0", Session: "s0", Items: 3}},
			`{"id":"c1","agent":"claude","cwd":"","model":"","locked":false,"created":"0001-01-01T00:00:00Z",` +
				`"usage":{"ctxIn":0,"ctxOut":0,"ctxWindow":0,"turns":0},` +
				`"forkSource":{"chat":"c0","session":"s0","items":3},"forkedFrom":"c0","forkedFromTitle":"Old chat"}`},
		{ChatView{ID: "c1", Agent: Claude, Status: StatusReady, Branches: 2, Branch: "br1", ForkedFrom: "c0", ForkedFromTitle: "Old chat"},
			`{"id":"c1","agent":"claude","cwd":"","model":"","locked":false,"created":"0001-01-01T00:00:00Z",` +
				`"usage":{"ctxIn":0,"ctxOut":0,"ctxWindow":0,"turns":0},"status":"ready",` +
				`"branches":2,"branch":"br1","forkedFrom":"c0","forkedFromTitle":"Old chat"}`},
		{Tree{Branches: []TreeBranch{{ID: "br1", From: MainBranch, At: 3}}}, `{"branches":[{"id":"br1","from":"main","at":3}]}`},
		{Tree{Branches: []TreeBranch{{ID: "br1", From: "main", At: 0}}, Labels: []TreeLabel{{Branch: "main", Item: 0, Text: "start"}}, Current: "br1"},
			`{"branches":[{"id":"br1","from":"main","at":0}],"labels":[{"branch":"main","item":0,"text":"start"}],"current":"br1"}`},
		{TreeView{Current: "main", Labels: []TreeLabel{}, Branches: []TreeBranchView{
			{ID: "main", Len: 4, Items: []TreeItem{
				{I: 0, Kind: "user", Text: "hi", Before: new(int), OK: true},
				{I: 1, Kind: "text", Text: "hello", Done: true, End: 3, OK: true},
				{I: 3, Kind: "user", Text: "again", Before: &before},
				{I: 4, Kind: "text", Text: ""}}},
			{ID: "br1", From: "main", At: 3, Len: 3, Items: []TreeItem{}}}},
			`{"current":"main","branches":[{"id":"main","at":0,"len":4,"items":[` +
				`{"i":0,"kind":"user","text":"hi","before":0,"ok":true},` +
				`{"i":1,"kind":"text","text":"hello","done":true,"end":3,"ok":true},` +
				`{"i":3,"kind":"user","text":"again","before":3},` +
				`{"i":4,"kind":"text","text":""}]},` +
				`{"id":"br1","from":"main","at":3,"len":3,"items":[]}],"labels":[]}`},
	} {
		b, err := json.Marshal(tc.v)
		if err != nil {
			t.Fatal(err)
		}
		if string(b) != tc.want {
			t.Errorf("%T:\n got %s\nwant %s", tc.v, b, tc.want)
		}
	}
}
