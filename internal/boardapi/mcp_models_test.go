package boardapi

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/model"
)

// createChat makes a plain chat of kind and returns its id and token.
func (e *env) createChat(kind model.AgentKind) (id, token string) {
	e.t.Helper()
	v, err := e.relay.Chats.Create(kind, model.Ungrouped, "")
	if err != nil {
		e.t.Fatal(err)
	}
	return v.ID, e.chatToken(v.ID)
}

// storeCatalog stores cat as the list kind reported.
func (e *env) storeCatalog(kind model.AgentKind, cat *model.Catalog) {
	e.t.Helper()
	if err := e.relay.Chats.Store.Update(func(s *model.State) error { s.SetCatalog(kind, cat); return nil }); err != nil {
		e.t.Fatal(err)
	}
}

// listModels calls list_subagent_models with the JSON arguments args.
func (e *env) listModels(token, args string) (text string, isErr bool) {
	e.t.Helper()
	text, isErr, status := e.toolsCall(token, "list_subagent_models", args)
	if status != 200 {
		e.t.Fatalf("list_subagent_models %s: status %d", args, status)
	}
	return text, isErr
}

// modelLines is a list_subagent_models answer that is not an error, as lines. No line of any
// answer prints an empty value.
func (e *env) modelLines(token, args string) []string {
	e.t.Helper()
	text, isErr := e.listModels(token, args)
	if isErr {
		e.t.Fatalf("list_subagent_models %s: error %q", args, text)
	}
	if text == "" || strings.HasSuffix(text, "\n") {
		e.t.Fatalf("list_subagent_models %s: text %q", args, text)
	}
	lines := strings.Split(text, "\n")
	for _, l := range lines {
		for _, bad := range []string{"-> ,", "effort .", "()"} {
			if l == "" || strings.Contains(l, bad) {
				e.t.Fatalf("list_subagent_models %s: line %q prints an empty value", args, l)
			}
		}
	}
	return lines
}

var kinds = []model.AgentKind{model.Claude, model.Cursor, model.Pi}

// A Cursor list: a model without efforts, one with efforts and a default, one whose efforts
// include "none" and that names no default.
var cursorModels = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "gpt-5.4-mini", Label: "GPT 5.4 mini"},
		{ID: "composer-2", Label: "Composer 2", Efforts: []string{"low", "high"}, DefaultEffort: "high"},
		{ID: "gpt-5.5", Label: "GPT 5.5", Efforts: []string{"none", "low", "xhigh"}, EffortLabels: map[string]string{"xhigh": "Extra High"}},
	},
	Default: model.ModelChoice{Model: "composer-2", Effort: "high"},
}

// A pi list: ids with a provider path, "off" as an effort value, a default effort the model does
// not offer, a model without a label.
var piModels = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "openrouter/openai/gpt-5", Label: "GPT-5", Provider: "openrouter", Note: "via OpenRouter", Efforts: []string{"off", "minimal", "medium"}, DefaultEffort: "medium", ContextWindow: 400_000},
		{ID: "anthropic/claude-opus-5-5", Label: "Claude Opus 5.5", Provider: "anthropic", Efforts: []string{"off", "high"}, DefaultEffort: "auto"},
		{ID: "local/llama", Provider: "local"},
		{ID: "local/qwen", Provider: "local", Efforts: []string{"low"}, DefaultEffort: "low"},
	},
	Default: model.ModelChoice{Model: "openrouter/openai/gpt-5", Effort: "medium"},
}

const (
	effortRuleHigh = "Effort omitted with a model named -> this chat's effort (high) if the model offers it, else the model's default effort."
	effortRuleNone = "Effort omitted with a model named -> the model's default effort (this chat has no effort of its own)."
)

var claudeRows = []string{
	"opus (Opus 5.5): low, medium, high, xhigh, max; default high",
	"claude-fable-5-1 (Fable 5.1): low, medium, high, xhigh, max; default high",
	"sonnet (Sonnet 5.5): low, medium, high, xhigh, max; default high",
	"haiku (Haiku 4.5): takes no effort; omit effort",
}

func TestListModelsListed(t *testing.T) {
	e := newEnv(t)
	last := func(names []string) string { return names[len(names)-1] }
	if got := e.listNames(e.token); len(got) != 10 || last(got) != "list_subagent_models" {
		t.Fatalf("board chat: %v", got)
	}
	for _, kind := range kinds {
		_, tok := e.createChat(kind)
		if got := e.listNames(tok); !joinEq(got, []string{"spawn_subagent", "stop_subagent", "list_subagent_models"}) {
			t.Fatalf("plain %s chat: %v", kind, got)
		}
	}
	for _, tl := range e.listSchemas(e.token) {
		if tl["name"] != "list_subagent_models" {
			continue
		}
		props := tl["inputSchema"].(map[string]any)["properties"].(map[string]any)
		if len(props) != 2 || props["agent"] == nil || props["filter"] == nil {
			t.Fatalf("arguments %v", props)
		}
		if _, ok := tl["inputSchema"].(map[string]any)["required"]; ok {
			t.Fatal("list_subagent_models requires an argument")
		}
	}
}

// Each of the three chat kinds can ask about each of the three agents, with no window open.
func TestListModelsEveryChatKindAndAgent(t *testing.T) {
	e := newEnv(t)
	e.storeCatalog(model.Cursor, cursorModels)
	e.storeCatalog(model.Pi, piModels)
	cats := map[model.AgentKind]*model.Catalog{model.Claude: &claude.Catalog, model.Cursor: cursorModels, model.Pi: piModels}
	// What a spawn that names the agent alone uses: the chat's own model and effort for its own
	// kind, the new-chat defaults for another kind.
	choice := map[model.AgentKind][2]string{
		model.Claude: {"sonnet", "high"},
		model.Cursor: {"composer-2", "high"},
		model.Pi:     {"openrouter/openai/gpt-5", "medium"},
	}
	chatEffort := map[model.AgentKind]string{model.Claude: "high", model.Cursor: "high", model.Pi: "medium"}

	for _, from := range kinds {
		id, tok := e.createChat(from)
		for _, to := range kinds {
			name := fmt.Sprintf("%s chat asks for %s", from, to)
			lines := e.modelLines(tok, fmt.Sprintf(`{"agent":%q}`, to))
			cat := cats[to]
			if want := fmt.Sprintf("%s: %d models.", to, len(cat.Models)); lines[0] != want {
				t.Fatalf("%s: header %q, want %q", name, lines[0], want)
			}
			if len(lines) != 3+len(cat.Models) {
				t.Fatalf("%s: %d lines: %q", name, len(lines), lines)
			}
			for i, m := range cat.Models {
				if row := lines[3+i]; row != modelRow(m) || !strings.HasPrefix(row, m.ID) {
					t.Fatalf("%s: row %d %q, want %q", name, i, row, modelRow(m))
				}
				for _, effort := range m.Efforts {
					if !strings.Contains(lines[3+i], effort) {
						t.Fatalf("%s: row %q lacks effort %s", name, lines[3+i], effort)
					}
				}
			}

			// The defaults line is what SpawnDefaults resolves.
			k, dModel, dEffort, err := e.relay.Chats.SpawnDefaults(id, to)
			if err != nil || k != to || dModel != choice[to][0] || dEffort != choice[to][1] {
				t.Fatalf("%s: SpawnDefaults %s %q %q, %v", name, k, dModel, dEffort, err)
			}
			if want := fmt.Sprintf("Model omitted -> %s, effort %s.", dModel, dEffort); lines[1] != want {
				t.Fatalf("%s: defaults line %q, want %q", name, lines[1], want)
			}
			if want := fmt.Sprintf("Effort omitted with a model named -> this chat's effort (%s) if the model offers it, else the model's default effort.", chatEffort[from]); lines[2] != want {
				t.Fatalf("%s: effort rule %q, want %q", name, lines[2], want)
			}
		}

		// An omitted agent is the chat's own.
		own := e.modelLines(tok, `{"agent":"`+string(from)+`"}`)
		for _, args := range []string{`{}`, `null`, `{"agent":""}`, `{"filter":""}`} {
			if got := e.modelLines(tok, args); !reflect.DeepEqual(got, own) {
				t.Fatalf("%s chat, arguments %s: %q, want %q", from, args, got, own)
			}
		}
		if !strings.HasPrefix(own[0], string(from)+": ") {
			t.Fatalf("%s chat, own agent: header %q", from, own[0])
		}

		// For a Claude target (the one kind this env can start), a spawn that names the agent
		// alone records what the defaults line says.
		text, isErr, _ := e.toolsCall(tok, "spawn_subagent", `{"prompt":"x","agent":"claude"}`)
		if isErr {
			t.Fatalf("%s chat: spawn %q", from, text)
		}
		sa := e.sub(id, receiptSid(t, text))
		want := fmt.Sprintf("Model omitted -> %s, effort %s.", sa.Model, sa.Effort)
		if got := e.modelLines(tok, `{"agent":"claude"}`)[1]; sa.Kind != model.Claude || got != want {
			t.Fatalf("%s chat: spawn recorded %s %q %q, defaults line %q", from, sa.Kind, sa.Model, sa.Effort, got)
		}
	}
}

func TestListModelsArguments(t *testing.T) {
	e := newEnv(t)
	before := e.claude.count()
	want := append([]string{
		"claude: 4 models.",
		"Model omitted -> sonnet, effort high.",
		effortRuleHigh,
	}, claudeRows...)
	for _, args := range []string{`{}`, `null`, `{"agent":"claude"}`, `{"agent":null,"filter":null}`} {
		if got := e.modelLines(e.token, args); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: %q, want %q", args, got, want)
		}
	}
	// A request without arguments at all.
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_subagent_models"}}`)
	if text, isErr := callResult(t, out); isErr || text != strings.Join(want, "\n") {
		t.Fatalf("no arguments: %q isErr=%v", text, isErr)
	}

	for args, wantErr := range map[string]string{
		`"opus"`:              "invalid list_subagent_models arguments",
		`[]`:                  "invalid list_subagent_models arguments",
		`{"agent":7}`:         "invalid list_subagent_models arguments",
		`{"filter":["opus"]}`: "invalid list_subagent_models arguments",
		`{"agent":"gemini"}`:  `unknown agent "gemini"`,
		`{"agent":"Claude"}`:  `unknown agent "Claude"`,
		`{"agent":"all"}`:     `unknown agent "all"`,
		`{"agent":"cl\"x"}`:   `unknown agent "cl\"x"`,
	} {
		if text, isErr := e.listModels(e.token, args); !isErr || text != wantErr {
			t.Fatalf("%s: %q isErr=%v, want error %q", args, text, isErr, wantErr)
		}
	}
	// The same text spawn_subagent gives for an unknown agent.
	if text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"x","agent":"gemini"}`); !isErr || text != `unknown agent "gemini"` {
		t.Fatalf("spawn_subagent: %q isErr=%v", text, isErr)
	}
	if e.claude.count() != before {
		t.Fatal("list_subagent_models started a process")
	}
}

func TestListModelsRows(t *testing.T) {
	for _, tc := range []struct {
		name string
		m    model.CatalogModel
		want string
	}{
		{"efforts and a default", model.CatalogModel{ID: "composer-2", Label: "Composer 2", Efforts: []string{"low", "medium", "high"}, DefaultEffort: "high"},
			"composer-2 (Composer 2): low, medium, high; default high"},
		{"efforts, no default", model.CatalogModel{ID: "composer-2", Label: "Composer 2", Efforts: []string{"low", "medium", "high"}},
			"composer-2 (Composer 2): low, medium, high"},
		{"a default the model does not offer", model.CatalogModel{ID: "composer-2", Label: "Composer 2", Efforts: []string{"low", "high"}, DefaultEffort: "auto"},
			"composer-2 (Composer 2): low, high"},
		{"no efforts", model.CatalogModel{ID: "gpt-5.4-mini", Label: "GPT 5.4 mini"},
			"gpt-5.4-mini (GPT 5.4 mini): takes no effort; omit effort"},
		{"no efforts, a default named", model.CatalogModel{ID: "gpt-5.4-mini", Label: "GPT 5.4 mini", DefaultEffort: "high"},
			"gpt-5.4-mini (GPT 5.4 mini): takes no effort; omit effort"},
		{"no label", model.CatalogModel{ID: "local/llama", Efforts: []string{"low"}, DefaultEffort: "low"},
			"local/llama: low; default low"},
		{"no label, no efforts", model.CatalogModel{ID: "local/llama"},
			"local/llama: takes no effort; omit effort"},
		{"none is an effort", model.CatalogModel{ID: "gpt-5.5", Label: "GPT 5.5", Efforts: []string{"none", "low"}, DefaultEffort: "none"},
			"gpt-5.5 (GPT 5.5): none, low; default none"},
		{"off is an effort", model.CatalogModel{ID: "openrouter/openai/gpt-5", Label: "GPT-5", Efforts: []string{"off", "minimal"}, DefaultEffort: "minimal"},
			"openrouter/openai/gpt-5 (GPT-5): off, minimal; default minimal"},
		{"only the id, the label and the efforts are printed", model.CatalogModel{ID: "a/b", Label: "A B", Note: "a note", Provider: "prov", ContextWindow: 1000,
			Efforts: []string{"xhigh"}, DefaultEffort: "xhigh", EffortLabels: map[string]string{"xhigh": "Extra High"}},
			"a/b (A B): xhigh; default xhigh"},
	} {
		if got := modelRow(tc.m); got != tc.want {
			t.Errorf("%s: %q, want %q", tc.name, got, tc.want)
		}
	}
	// A model without efforts is never worded with an effort value.
	row := modelRow(model.CatalogModel{ID: "m", Label: "M"})
	for _, word := range []string{"none", "off"} {
		if strings.Contains(row, word) {
			t.Fatalf("row %q uses %q", row, word)
		}
	}

	// The same rows through the tool, in catalog order.
	e := newEnv(t)
	e.storeCatalog(model.Cursor, cursorModels)
	e.storeCatalog(model.Pi, piModels)
	want := []string{
		"cursor: 3 models.",
		"Model omitted -> composer-2, effort high.",
		effortRuleHigh,
		"gpt-5.4-mini (GPT 5.4 mini): takes no effort; omit effort",
		"composer-2 (Composer 2): low, high; default high",
		"gpt-5.5 (GPT 5.5): none, low, xhigh",
	}
	if got := e.modelLines(e.token, `{"agent":"cursor"}`); !reflect.DeepEqual(got, want) {
		t.Fatalf("cursor: %q, want %q", got, want)
	}
	want = []string{
		"pi: 4 models.",
		"Model omitted -> openrouter/openai/gpt-5, effort medium.",
		effortRuleHigh,
		"openrouter/openai/gpt-5 (GPT-5): off, minimal, medium; default medium",
		"anthropic/claude-opus-5-5 (Claude Opus 5.5): off, high",
		"local/llama: takes no effort; omit effort",
		"local/qwen: low; default low",
	}
	if got := e.modelLines(e.token, `{"agent":"pi"}`); !reflect.DeepEqual(got, want) {
		t.Fatalf("pi: %q, want %q", got, want)
	}
}

// The example of the brief: Cursor asked from a Claude chat on effort high.
func TestListModelsExample(t *testing.T) {
	e := newEnv(t)
	e.storeCatalog(model.Cursor, &model.Catalog{Models: cursorModels.Models[:2], Default: cursorModels.Default})
	text, isErr := e.listModels(e.token, `{"agent":"cursor"}`)
	want := "cursor: 2 models.\n" +
		"Model omitted -> composer-2, effort high.\n" +
		"Effort omitted with a model named -> this chat's effort (high) if the model offers it, else the model's default effort.\n" +
		"gpt-5.4-mini (GPT 5.4 mini): takes no effort; omit effort\n" +
		"composer-2 (Composer 2): low, high; default high"
	if isErr || text != want {
		t.Fatalf("isErr=%v\n%s\nwant\n%s", isErr, text, want)
	}

	one := &model.Catalog{Models: cursorModels.Models[1:2], Default: cursorModels.Default}
	e.storeCatalog(model.Cursor, one)
	if got := e.modelLines(e.token, `{"agent":"cursor"}`)[0]; got != "cursor: 1 model." {
		t.Fatalf("one model: %q", got)
	}
	if got := e.modelLines(e.token, `{"agent":"cursor","filter":"composer"}`)[0]; got != `cursor: 1 of 1 model match filter "composer".` {
		t.Fatalf("one model, filtered: %q", got)
	}
	if got := e.modelLines(e.token, `{"agent":"cursor","filter":"zzz"}`)[0]; got != `cursor: none of the 1 model match filter "zzz". The whole list follows.` {
		t.Fatalf("one model, no match: %q", got)
	}
}

func TestListModelsDefaultsAndEffortRule(t *testing.T) {
	e := newEnv(t)
	e.storeCatalog(model.Pi, piModels)

	// A Claude chat on a model without efforts has no effort of its own.
	if err := e.relay.Chats.Configure(e.chat, chats.ConfigReq{Model: "haiku"}); err != nil {
		t.Fatal(err)
	}
	lines := e.modelLines(e.token, `{}`)
	if lines[1] != "Model omitted -> haiku, which takes no effort." || lines[2] != effortRuleNone {
		t.Fatalf("haiku chat: %q", lines[:3])
	}
	text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"x"}`)
	if isErr {
		t.Fatalf("spawn %q", text)
	}
	if sa := e.sub(e.chat, receiptSid(t, text)); sa.Model != "haiku" || sa.Effort != "" {
		t.Fatalf("the spawn recorded %+v", sa)
	}
	// Across kinds the other list's default applies; the effort rule is still the chat's.
	lines = e.modelLines(e.token, `{"agent":"pi"}`)
	if lines[1] != "Model omitted -> openrouter/openai/gpt-5, effort medium." || lines[2] != effortRuleNone {
		t.Fatalf("haiku chat asks for pi: %q", lines[:3])
	}

	// The resolved model offers efforts but none is resolved: it names no default effort.
	e.storeCatalog(model.Cursor, &model.Catalog{Models: cursorModels.Models, Default: model.ModelChoice{Model: "gpt-5.5"}})
	if got := e.modelLines(e.token, `{"agent":"cursor"}`)[1]; got != "Model omitted -> gpt-5.5, with no effort named, so cursor uses its own default effort." {
		t.Fatalf("no effort resolved: %q", got)
	}
	// The resolved model takes no effort.
	e.storeCatalog(model.Cursor, &model.Catalog{Models: cursorModels.Models, Default: model.ModelChoice{Model: "gpt-5.4-mini"}})
	if got := e.modelLines(e.token, `{"agent":"cursor"}`)[1]; got != "Model omitted -> gpt-5.4-mini, which takes no effort." {
		t.Fatalf("model without efforts: %q", got)
	}
	// A list that names no default model: no model is resolved.
	e.storeCatalog(model.Cursor, &model.Catalog{Models: cursorModels.Models})
	lines = e.modelLines(e.token, `{"agent":"cursor"}`)
	if lines[1] != "Model omitted -> no model is named, so cursor uses its own default." || len(lines) != 6 {
		t.Fatalf("no default model: %q", lines)
	}
	for _, a := range kinds {
		_, dModel, dEffort, err := e.relay.Chats.SpawnDefaults(e.chat, a)
		if err != nil {
			t.Fatal(err)
		}
		want := defaultsLine(a, e.relay.Chats.SpawnCatalog(a), dModel, dEffort)
		if got := e.modelLines(e.token, `{"agent":"`+string(a)+`"}`)[1]; got != want {
			t.Fatalf("%s: %q, SpawnDefaults gives %q", a, got, want)
		}
	}

	if got := defaultsLine(model.Pi, piModels, "local/llama", "high"); got != "Model omitted -> local/llama, which takes no effort." {
		t.Fatalf("an effort for a model without efforts: %q", got)
	}
	if got := defaultsLine(model.Pi, piModels, "unlisted", "high"); got != "Model omitted -> unlisted, effort high." {
		t.Fatalf("a model the list lacks: %q", got)
	}
	if got := effortRuleLine("xhigh"); got != "Effort omitted with a model named -> this chat's effort (xhigh) if the model offers it, else the model's default effort." {
		t.Fatalf("effort rule: %q", got)
	}
}

func TestListModelsNotKnown(t *testing.T) {
	e := newEnv(t) // no Cursor or pi list stored
	for _, a := range []model.AgentKind{model.Cursor, model.Pi} {
		want := []string{
			fmt.Sprintf("%s: the model list is not known to the app yet. It becomes known when the app reads it at start or when a %s chat starts.", a, a),
			fmt.Sprintf("Until then spawn_subagent does not check model or effort for %s: it passes them on as given, unchecked.", a),
			"Model omitted -> this chat's model sonnet and effort high are passed on unchecked.",
		}
		// The filter is ignored.
		for _, args := range []string{`{"agent":%q}`, `{"agent":%q,"filter":"gpt"}`} {
			got := e.modelLines(e.token, fmt.Sprintf(args, a))
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("%s from a Claude chat: %q, want %q", a, got, want)
			}
			if strings.Contains(strings.Join(got, "\n"), "Effort omitted") {
				t.Fatalf("%s: effort rule in %q", a, got)
			}
		}

		// A chat of that kind, created while the list was not known: no model, no effort.
		id, tok := e.createChat(a)
		if _, dModel, dEffort, err := e.relay.Chats.SpawnDefaults(id, a); err != nil || dModel != "" || dEffort != "" {
			t.Fatalf("%s chat: SpawnDefaults %q %q, %v", a, dModel, dEffort, err)
		}
		want[2] = fmt.Sprintf("Model omitted -> no model or effort is named, so %s uses its own defaults.", a)
		if got := e.modelLines(tok, `{}`); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s chat: %q, want %q", a, got, want)
		}
	}

	// A chat with a model and no effort.
	if err := e.relay.Chats.Configure(e.chat, chats.ConfigReq{Model: "haiku"}); err != nil {
		t.Fatal(err)
	}
	if got := e.modelLines(e.token, `{"agent":"pi"}`)[2]; got != "Model omitted -> this chat's model haiku is passed on unchecked; no effort is named, so pi uses its own default effort." {
		t.Fatalf("model, no effort: %q", got)
	}
	// A chat with an effort and no model.
	if got := unknownListLines(model.Cursor, "", "high")[2]; got != "Model omitted -> no model is named, so cursor uses its own default model; this chat's effort high is passed on unchecked." {
		t.Fatalf("effort, no model: %q", got)
	}

	// The list becomes known: the same call answers with rows.
	e.storeCatalog(model.Pi, piModels)
	if got := e.modelLines(e.token, `{"agent":"pi"}`); got[0] != "pi: 4 models." || len(got) != 7 {
		t.Fatalf("pi once known: %q", got)
	}
}

// Discovery reads the list spawn_subagent validates against: Claude's built-in list when nothing
// is stored, the stored one after.
func TestListModelsSameListAsSpawn(t *testing.T) {
	e := newEnv(t)
	if got := e.modelLines(e.token, `{}`)[3:]; !reflect.DeepEqual(got, claudeRows) {
		t.Fatalf("built-in: %q", got)
	}
	e.storeCatalog(model.Claude, &model.Catalog{
		Models: []model.CatalogModel{
			{ID: "cl-only", Label: "Claude only", Efforts: []string{"low", "high"}, DefaultEffort: "low"},
			{ID: "plain", Label: "Plain"},
		},
		Default: model.ModelChoice{Model: "cl-only", Effort: "low"},
	})
	want := []string{
		"claude: 2 models.",
		"Model omitted -> cl-only, effort low.", // the chat's sonnet is not listed any more
		effortRuleHigh,
		"cl-only (Claude only): low, high; default low",
		"plain (Plain): takes no effort; omit effort",
	}
	if got := e.modelLines(e.token, `{}`); !reflect.DeepEqual(got, want) {
		t.Fatalf("stored: %q, want %q", got, want)
	}
	// Each listed id and effort is one spawn_subagent takes; an id of the built-in list is not.
	for _, args := range []string{
		`{"prompt":"x","model":"cl-only"}`, `{"prompt":"x","model":"cl-only","effort":"low"}`,
		`{"prompt":"x","model":"cl-only","effort":"high"}`, `{"prompt":"x","model":"plain"}`,
	} {
		if text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", args); isErr {
			t.Fatalf("spawn %s: %q", args, text)
		}
	}
	if text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"x","model":"opus"}`); !isErr {
		t.Fatalf("spawn on an unlisted id: %q", text)
	}
	text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"x"}`)
	if isErr {
		t.Fatalf("spawn %q", text)
	}
	if sa := e.sub(e.chat, receiptSid(t, text)); sa.Model != "cl-only" || sa.Effort != "low" {
		t.Fatalf("the spawn recorded %+v", sa)
	}
}

func TestListModelsFilter(t *testing.T) {
	e := newEnv(t)
	e.storeCatalog(model.Pi, piModels)
	all := e.modelLines(e.token, `{}`)
	head := all[1:3]
	opus, fable, sonnet := claudeRows[0], claudeRows[1], claudeRows[2]

	for _, tc := range []struct {
		filter string
		header string
		rows   []string
	}{
		{"opus", `claude: 1 of 4 models match filter "opus".`, []string{opus}},
		{"OPUS", `claude: 1 of 4 models match filter "OPUS".`, []string{opus}},                  // letter case
		{"opus 5.5", `claude: 1 of 4 models match filter "opus 5.5".`, []string{opus}},          // id and label
		{"5.5 Opus", `claude: 1 of 4 models match filter "5.5 Opus".`, []string{opus}},          // any order
		{"  oPuS \t 5.5\n", `claude: 1 of 4 models match filter "oPuS 5.5".`, []string{opus}},   // spacing
		{"5.5", `claude: 2 of 4 models match filter "5.5".`, []string{opus, sonnet}},            // label only
		{"claude-fable", `claude: 1 of 4 models match filter "claude-fable".`, []string{fable}}, // id only
		{"u", `claude: 3 of 4 models match filter "u".`, []string{opus, fable, claudeRows[3]}},
		{"opus opus", `claude: 1 of 4 models match filter "opus opus".`, []string{opus}},
		// Neither the note nor a single field holding both words apart: every word must occur.
		{"complex", `claude: none of the 4 models match filter "complex". The whole list follows.`, claudeRows},
		{"opus haiku", `claude: none of the 4 models match filter "opus haiku". The whole list follows.`, claudeRows},
		{"zzz", `claude: none of the 4 models match filter "zzz". The whole list follows.`, claudeRows},
	} {
		args := fmt.Sprintf(`{"filter":%q}`, tc.filter)
		want := append(append([]string{tc.header}, head...), tc.rows...)
		if got := e.modelLines(e.token, args); !reflect.DeepEqual(got, want) {
			t.Fatalf("filter %q: %q, want %q", tc.filter, got, want)
		}
	}
	for _, filter := range []string{"", " ", " \t\n "} {
		if got := e.modelLines(e.token, fmt.Sprintf(`{"filter":%q}`, filter)); !reflect.DeepEqual(got, all) {
			t.Fatalf("filter %q: %q, want the unfiltered %q", filter, got, all)
		}
	}

	// Ids with a path; the provider field is not searched.
	lines := e.modelLines(e.token, `{"agent":"pi","filter":"OpenRouter/OpenAI"}`)
	if lines[0] != `pi: 1 of 4 models match filter "OpenRouter/OpenAI".` || len(lines) != 4 || lines[3] != modelRow(piModels.Models[0]) {
		t.Fatalf("path filter: %q", lines)
	}
	lines = e.modelLines(e.token, `{"agent":"pi","filter":"local"}`)
	if lines[0] != `pi: 2 of 4 models match filter "local".` || len(lines) != 5 {
		t.Fatalf("local: %q", lines)
	}
	lines = e.modelLines(e.token, `{"agent":"pi","filter":"anthropic opus"}`)
	if lines[0] != `pi: 1 of 4 models match filter "anthropic opus".` || lines[3] != modelRow(piModels.Models[1]) {
		t.Fatalf("anthropic opus: %q", lines)
	}

	withProvider := []model.CatalogModel{{ID: "a", Label: "A", Provider: "acme", Note: "fast"}, {ID: "b", Label: "Acme B"}}
	if got := matchModels(withProvider, "acme"); len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("provider searched: %+v", got)
	}
	if got := matchModels(withProvider, "fast"); len(got) != 0 {
		t.Fatalf("note searched: %+v", got)
	}
	if got := matchModels(withProvider, "  "); !reflect.DeepEqual(got, withProvider) {
		t.Fatalf("no words: %+v", got)
	}
	if got := matchModels(withProvider, "B a"); len(got) != 1 || got[0].ID != "b" {
		t.Fatalf("order: %+v", got)
	}
}

func TestListModelsRefusals(t *testing.T) {
	e := newEnv(t)
	if text, isErr := e.listModels("nope", `{}`); !isErr || text != "unknown board token" {
		t.Fatalf("unknown token: %q isErr=%v", text, isErr)
	}
	if text, isErr := e.listModels("", `{}`); !isErr || text != "unknown board token" {
		t.Fatalf("no token: %q isErr=%v", text, isErr)
	}

	if err := e.relay.Chats.SetArchive(e.chat, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	if text, isErr := e.listModels(e.token, `{}`); !isErr || text != "this chat is archived" {
		t.Fatalf("archived: %q isErr=%v", text, isErr)
	}

	e2 := newEnv(t)
	markLegacyAndReload(t, e2)
	if text, isErr := e2.listModels(e2.token, `{}`); !isErr || text != "this chat used the old board connection" {
		t.Fatalf("legacy: %q isErr=%v", text, isErr)
	}
}

// A chat without a board can call it, and it never waits for a window.
func TestListModelsNoClient(t *testing.T) {
	e := newEnv(t)
	_, plainTok := e.createPlain()
	for _, tok := range []string{e.token, plainTok} {
		start := time.Now()
		text, isErr := e.listModels(tok, `{}`)
		if isErr || text == NoClientText || !strings.HasPrefix(text, "claude: 4 models.\n") {
			t.Fatalf("got %q isErr=%v", text, isErr)
		}
		if time.Since(start) > time.Second {
			t.Fatal("did not return at once")
		}
	}
	if e.claude.count() != 0 {
		t.Fatal("list_subagent_models started a process")
	}
	if items := e.items(e.chat); len(items) != 0 {
		t.Fatalf("items %+v", items)
	}
}

// bigPiCatalog is a list of the scale and the id shapes of pi's recorded one: about 450 models
// over more than 50 id prefixes, in an order that is not the prefixes'. It has
//   - openrouter/openai with 98 models, more than the cap inside one prefix;
//   - openrouter/auto, the one model directly under openrouter;
//   - openrouter/meta with 7 models next to openrouter/meta-llama with 20;
//   - 16 models with opus in the id, 4 under each of 4 prefixes, every one with efforts.
//
// Every third model of the others takes no effort.
func bigPiCatalog() *model.Catalog {
	efforts := []string{"off", "low", "medium", "high"}
	var models []model.CatalogModel
	add := func(id, label string, withEfforts bool) {
		m := model.CatalogModel{ID: id, Label: label}
		if withEfforts {
			m.Efforts, m.DefaultEffort = efforts, "medium"
		}
		models = append(models, m)
	}
	// fill adds count models under prefix, labelled after its last segment.
	fill := func(prefix string, count int) {
		vendor := strings.ToUpper(prefix[strings.LastIndexByte(prefix, '/')+1:])
		for i := 1; i <= count; i++ {
			add(fmt.Sprintf("%s/m-%03d", prefix, i), fmt.Sprintf("%s M%d", vendor, i), i%3 != 0)
		}
	}
	opus := func(prefix string) {
		for _, v := range []string{"4", "4-1", "5", "5-5"} {
			add(prefix+"/claude-opus-"+v, "Claude Opus "+strings.ReplaceAll(v, "-", "."), true)
		}
	}

	fill("openrouter/openai", 98)
	add("openrouter/auto", "Auto Router", true)
	fill("openrouter/meta-llama", 20)
	fill("openrouter/meta", 7)
	opus("openrouter/anthropic")
	for _, vendor := range []string{
		"google", "mistralai", "deepseek", "qwen", "x-ai", "cohere", "nvidia", "microsoft", "amazon", "perplexity",
		"moonshotai", "z-ai", "minimax", "baidu", "tencent", "inception", "liquid", "ai21", "nousresearch", "thedrummer",
		"sao10k", "arcee-ai", "alibaba", "bytedance", "stepfun", "upstage", "writer", "morph",
	} {
		fill("openrouter/"+vendor, 6)
	}
	for _, provider := range []string{"anthropic", "google-vertex", "amazon-bedrock"} {
		opus(provider)
	}
	for _, provider := range []string{
		"openai", "google", "groq", "xai", "mistral", "cerebras", "deepseek", "azure", "zai", "huggingface",
		"fireworks", "together", "ollama", "lmstudio", "vercel", "minimax", "moonshot", "kimi", "opencode", "llamacpp",
	} {
		fill(provider, 7)
	}
	return &model.Catalog{Models: models, Default: model.ModelChoice{Model: "anthropic/claude-opus-5-5", Effort: "medium"}}
}

// flatCatalog is a list of n models over the given id prefixes in turn; "" is an id without one.
func flatCatalog(n int, prefixes ...string) *model.Catalog {
	var models []model.CatalogModel
	for i := range n {
		id := fmt.Sprintf("m-%03d", i)
		if p := prefixes[i%len(prefixes)]; p != "" {
			id = p + "/" + id
		}
		models = append(models, model.CatalogModel{ID: id, Label: fmt.Sprintf("Model %d", i), Efforts: []string{"low", "high"}, DefaultEffort: "low"})
	}
	return &model.Catalog{Models: models, Default: model.ModelChoice{Model: models[0].ID, Effort: "low"}}
}

// allRows is every model of cat as a row.
func allRows(cat *model.Catalog) []string {
	var rows []string
	for _, m := range cat.Models {
		rows = append(rows, modelRow(m))
	}
	return rows
}

// isModelRow reports whether a line of an answer is a model row.
func isModelRow(line string) bool {
	return strings.Contains(line, "; default ") || strings.Contains(line, "takes no effort")
}

const (
	overviewTail = "Call again with filter set to a prefix, or to an id shown above, to list those models with their efforts."
	idsOnlyTail  = "Call again with a narrower filter, for example one id from this list, to see labels and efforts."
)

func TestListModelsFormRule(t *testing.T) {
	if modelListCap != 60 {
		t.Fatalf("cap %d", modelListCap)
	}
	for id, want := range map[string]string{
		"openrouter/openai/gpt-5": "openrouter/openai",
		"openrouter/auto":         "openrouter",
		"gpt-5":                   "",
		"":                        "",
		"a/":                      "a",
		"/a":                      "",
	} {
		if got := idPrefix(id); got != want {
			t.Errorf("idPrefix(%q) = %q, want %q", id, got, want)
		}
	}

	two, one, none := flatCatalog(200, "a", "b").Models, flatCatalog(200, "a").Models, flatCatalog(200, "").Models
	mixed := flatCatalog(200, "", "a").Models // the empty prefix counts as one
	for _, tc := range []struct {
		name     string
		n        int
		matches  []model.CatalogModel
		filtered bool
		want     answerForm
	}{
		{"an empty list", 0, nil, false, formRows},
		{"at the cap", 60, two[:60], false, formRows},
		{"at the cap, one prefix", 60, one[:60], false, formRows},
		{"filtered to the cap", 200, two[:60], true, formRows},
		{"one match", 200, two[:1], true, formRows},
		{"no match, list at the cap", 60, nil, true, formWholeList},
		{"no match, list over the cap", 61, nil, true, formNoneMatch},
		{"over the cap, two prefixes", 61, two[:61], false, formOverview},
		{"filtered, over the cap, two prefixes", 200, two[:61], true, formOverview},
		{"over the cap, with and without a prefix", 61, mixed[:61], false, formOverview},
		{"over the cap, one prefix", 61, one[:61], false, formIDsOnly},
		{"filtered, over the cap, one prefix", 200, one[:61], true, formIDsOnly},
		{"over the cap, no prefix", 61, none[:61], false, formIDsOnly},
	} {
		if got := listForm(tc.n, len(tc.matches), tc.matches, tc.filtered); got != tc.want {
			t.Errorf("%s: form %d, want %d", tc.name, got, tc.want)
		}
	}
}

func TestListModelsOverview(t *testing.T) {
	e := newEnv(t)
	big := bigPiCatalog()
	e.storeCatalog(model.Pi, big)
	n := len(big.Models)
	prefixes := map[string]int{}
	for _, m := range big.Models {
		prefixes[idPrefix(m.ID)]++
	}
	if n < 440 || n > 460 || len(prefixes) <= 50 {
		t.Fatalf("the catalog has %d models over %d prefixes", n, len(prefixes))
	}
	// The lines 2 and 3 of a rows answer for the same chat and agent.
	head := e.modelLines(e.token, `{"agent":"pi","filter":"opus"}`)[1:3]
	if head[0] != "Model omitted -> anthropic/claude-opus-5-5, effort medium." || head[1] != effortRuleHigh {
		t.Fatalf("rows answer: %q", head)
	}

	// Unfiltered: one line per prefix, no rows, a small fraction of the rows' size.
	text, _ := e.listModels(e.token, `{"agent":"pi"}`)
	lines := e.modelLines(e.token, `{"agent":"pi"}`)
	if want := fmt.Sprintf("pi: %d models, more than 60, so they are not listed here. Models per id prefix:", n); lines[0] != want {
		t.Fatalf("header %q, want %q", lines[0], want)
	}
	if !reflect.DeepEqual(lines[1:3], head) {
		t.Fatalf("lines 2 and 3 %q, want %q", lines[1:3], head)
	}
	if len(lines) != 3+len(prefixes)+1 || lines[len(lines)-1] != overviewTail {
		t.Fatalf("%d lines for %d prefixes, last %q", len(lines), len(prefixes), lines[len(lines)-1])
	}
	if rows := strings.Join(allRows(big), "\n"); len(text)*5 >= len(rows) {
		t.Fatalf("the overview has %d characters, the rows %d", len(text), len(rows))
	}
	groups := lines[3 : len(lines)-1]
	total := 0
	for i, l := range groups {
		if isModelRow(l) {
			t.Fatalf("model row %q", l)
		}
		name, rest, _ := strings.Cut(l, ": ")
		count, ids, withIDs := strings.Cut(rest, ": ")
		if count != countModels(prefixes[name]) || prefixes[name] == 0 {
			t.Fatalf("group line %q, the catalog has %d models under %q", l, prefixes[name], name)
		}
		if i > 0 && strings.Split(groups[i-1], ": ")[0] >= name {
			t.Fatalf("group %q after %q", name, groups[i-1])
		}
		// The ids are shown for a prefix that begins another one, and only for it.
		begins := false
		for q := range prefixes {
			begins = begins || q != name && strings.HasPrefix(q, name)
		}
		if withIDs != begins || withIDs && len(strings.Split(ids, ", ")) != prefixes[name] {
			t.Fatalf("group line %q: ids shown %v, the prefix begins another %v", l, withIDs, begins)
		}
		total += prefixes[name]
	}
	if total != n {
		t.Fatalf("the groups hold %d of %d models", total, n)
	}
	for _, want := range []string{
		"anthropic: 4 models",
		"google: 7 models: google/m-001, google/m-002, google/m-003, google/m-004, google/m-005, google/m-006, google/m-007",
		"google-vertex: 4 models",
		"openrouter: 1 model: openrouter/auto",
		"openrouter/anthropic: 4 models",
		"openrouter/meta: 7 models: openrouter/meta/m-001, openrouter/meta/m-002, openrouter/meta/m-003, openrouter/meta/m-004, openrouter/meta/m-005, openrouter/meta/m-006, openrouter/meta/m-007",
		"openrouter/meta-llama: 20 models",
		"openrouter/openai: 98 models",
	} {
		if !slices.Contains(groups, want) {
			t.Fatalf("no group line %q in %q", want, groups)
		}
	}

	// An empty filter is no filter.
	for _, args := range []string{`{"agent":"pi","filter":""}`, `{"agent":"pi","filter":"   "}`, `{"agent":"pi","filter":" \t\n"}`} {
		if got, isErr := e.listModels(e.token, args); isErr || got != text {
			t.Fatalf("%s: %q, want the unfiltered %q", args, got, text)
		}
	}

	// A filter over the cap across several prefixes: the overview again, of the matches.
	k := 0
	for p, c := range prefixes {
		if strings.HasPrefix(p, "openrouter") {
			k += c
		}
	}
	lines = e.modelLines(e.token, `{"agent":"pi","filter":" OpenRouter "}`)
	if want := fmt.Sprintf(`pi: %d of %d models match filter "OpenRouter", more than 60, so they are not listed here. Matches per id prefix:`, k, n); lines[0] != want {
		t.Fatalf("header %q, want %q", lines[0], want)
	}
	if !reflect.DeepEqual(lines[1:3], head) || lines[len(lines)-1] != overviewTail {
		t.Fatalf("filter openrouter: %q", lines)
	}
	if lines[3] != "openrouter: 1 model: openrouter/auto" || lines[4] != "openrouter/ai21: 6 models" {
		t.Fatalf("filter openrouter: first groups %q", lines[3:5])
	}
	for _, l := range lines[3 : len(lines)-1] {
		if isModelRow(l) || !strings.HasPrefix(l, "openrouter") {
			t.Fatalf("filter openrouter: line %q", l)
		}
	}
	if !slices.Contains(lines, "openrouter/meta: 7 models: openrouter/meta/m-001, openrouter/meta/m-002, openrouter/meta/m-003, openrouter/meta/m-004, openrouter/meta/m-005, openrouter/meta/m-006, openrouter/meta/m-007") ||
		!slices.Contains(lines, "openrouter/meta-llama: 20 models") {
		t.Fatalf("filter openrouter: meta groups in %q", lines)
	}

	// An id an overview line shows is a filter that lists that model.
	want := []string{
		fmt.Sprintf(`pi: 1 of %d models match filter "openrouter/auto".`, n), head[0], head[1],
		"openrouter/auto (Auto Router): off, low, medium, high; default medium",
	}
	if got := e.modelLines(e.token, `{"agent":"pi","filter":"openrouter/auto"}`); !reflect.DeepEqual(got, want) {
		t.Fatalf("filter openrouter/auto: %q, want %q", got, want)
	}
	lines = e.modelLines(e.token, `{"agent":"pi","filter":"openrouter/meta/m-003"}`)
	if len(lines) != 4 || lines[3] != "openrouter/meta/m-003 (META M3): takes no effort; omit effort" {
		t.Fatalf("filter openrouter/meta/m-003: %q", lines)
	}
	// A prefix that begins another one does not isolate its models; within the cap they are rows.
	if lines = e.modelLines(e.token, `{"agent":"pi","filter":"openrouter/meta"}`); lines[0] != fmt.Sprintf(`pi: 27 of %d models match filter "openrouter/meta".`, n) || len(lines) != 30 {
		t.Fatalf("filter openrouter/meta: %q", lines)
	}

	// A family within the cap, spread over several prefixes: rows with efforts.
	lines = e.modelLines(e.token, `{"agent":"pi","filter":"opus"}`)
	if want := fmt.Sprintf(`pi: 16 of %d models match filter "opus".`, n); lines[0] != want || len(lines) != 19 {
		t.Fatalf("filter opus: header %q, want %q; %d lines", lines[0], want, len(lines))
	}
	families := map[string]bool{}
	for _, row := range lines[3:] {
		if !strings.Contains(row, "opus") || !strings.HasSuffix(row, "): off, low, medium, high; default medium") {
			t.Fatalf("filter opus: row %q", row)
		}
		families[idPrefix(strings.Fields(row)[0])] = true
	}
	if len(families) != 4 {
		t.Fatalf("filter opus: prefixes %v", families)
	}

	// Ids without a prefix form the first group, which always shows its ids.
	withLocal := &model.Catalog{Default: big.Default, Models: append([]model.CatalogModel{
		{ID: "local-0", Label: "Local 0"}, {ID: "local-1", Label: "Local 1"},
	}, append(big.Models[:len(big.Models):len(big.Models)], model.CatalogModel{ID: "local-2", Label: "Local 2"})...)}
	e.storeCatalog(model.Pi, withLocal)
	lines = e.modelLines(e.token, `{"agent":"pi"}`)
	if lines[0] != fmt.Sprintf("pi: %d models, more than 60, so they are not listed here. Models per id prefix:", n+3) ||
		lines[3] != "(no prefix): 3 models: local-0, local-1, local-2" || lines[4] != "amazon-bedrock: 4 models" || len(lines) != 3+len(prefixes)+2 {
		t.Fatalf("with ids without a prefix: %q", lines[:5])
	}
	if lines = e.modelLines(e.token, `{"agent":"pi","filter":"local-1"}`); len(lines) != 4 || lines[3] != "local-1 (Local 1): takes no effort; omit effort" {
		t.Fatalf("filter local-1: %q", lines)
	}
}

func TestListModelsIDsOnly(t *testing.T) {
	e := newEnv(t)
	big := bigPiCatalog()
	e.storeCatalog(model.Pi, big)
	n := len(big.Models)
	head := e.modelLines(e.token, `{"agent":"pi","filter":"opus"}`)[1:3]

	// More than the cap inside one prefix.
	lines := e.modelLines(e.token, `{"agent":"pi","filter":"openrouter/openai"}`)
	if want := fmt.Sprintf(`pi: 98 of %d models match filter "openrouter/openai", more than 60, so only their ids are listed here.`, n); lines[0] != want {
		t.Fatalf("header %q, want %q", lines[0], want)
	}
	if !reflect.DeepEqual(lines[1:3], head) {
		t.Fatalf("lines 2 and 3 %q, want %q", lines[1:3], head)
	}
	if len(lines) != 3+98+1 || lines[len(lines)-1] != idsOnlyTail {
		t.Fatalf("%d lines, last %q", len(lines), lines[len(lines)-1])
	}
	for i, l := range lines[3 : len(lines)-1] {
		if l != big.Models[i].ID || idPrefix(l) != "openrouter/openai" { // the catalog begins with them
			t.Fatalf("id line %d %q, want %q", i, l, big.Models[i].ID)
		}
	}
	// One of those ids as the filter: its row.
	id := lines[3+41]
	want := []string{fmt.Sprintf(`pi: 1 of %d models match filter %q.`, n, id), head[0], head[1], "openrouter/openai/m-042 (OPENAI M42): takes no effort; omit effort"}
	if got := e.modelLines(e.token, fmt.Sprintf(`{"agent":"pi","filter":%q}`, id)); !reflect.DeepEqual(got, want) {
		t.Fatalf("filter %s: %q, want %q", id, got, want)
	}
	// A narrower filter inside the prefix: rows.
	lines = e.modelLines(e.token, `{"agent":"pi","filter":"openrouter/openai m-04"}`)
	if lines[0] != fmt.Sprintf(`pi: 10 of %d models match filter "openrouter/openai m-04".`, n) || len(lines) != 13 || !isModelRow(lines[3]) {
		t.Fatalf("narrower filter: %q", lines)
	}

	// A list over the cap whose ids have no prefix, whichever agent it is.
	flat := flatCatalog(75, "")
	e.storeCatalog(model.Cursor, flat)
	text, _ := e.listModels(e.token, `{"agent":"cursor"}`)
	lines = e.modelLines(e.token, `{"agent":"cursor"}`)
	if lines[0] != "cursor: 75 models, more than 60, so only their ids are listed here." ||
		lines[1] != "Model omitted -> m-000, effort low." || lines[2] != effortRuleHigh {
		t.Fatalf("cursor: %q", lines[:3])
	}
	if len(lines) != 3+75+1 || lines[len(lines)-1] != idsOnlyTail {
		t.Fatalf("cursor: %d lines, last %q", len(lines), lines[len(lines)-1])
	}
	for i, l := range lines[3 : len(lines)-1] {
		if l != flat.Models[i].ID {
			t.Fatalf("cursor: id line %d %q", i, l)
		}
	}
	for _, args := range []string{`{"agent":"cursor","filter":""}`, `{"agent":"cursor","filter":"  "}`} {
		if got, _ := e.listModels(e.token, args); got != text {
			t.Fatalf("%s: %q, want the unfiltered %q", args, got, text)
		}
	}
	// The label is searched as before; a filter that keeps more than the cap keeps the form.
	lines = e.modelLines(e.token, `{"agent":"cursor","filter":"model"}`)
	if lines[0] != `cursor: 75 of 75 models match filter "model", more than 60, so only their ids are listed here.` || len(lines) != 79 {
		t.Fatalf("cursor, filter model: %q", lines[:3])
	}
}

func TestListModelsCapBoundaries(t *testing.T) {
	e := newEnv(t)
	header := func(cat *model.Catalog, args string) (string, []string) {
		e.storeCatalog(model.Cursor, cat)
		lines := e.modelLines(e.token, args)
		if lines[1] != "Model omitted -> "+cat.Models[0].ID+", effort low." || lines[2] != effortRuleHigh {
			t.Fatalf("%s: lines 2 and 3 %q", args, lines[1:3])
		}
		return lines[0], lines[3:]
	}

	// Exactly the cap: rows, also over two prefixes.
	at := flatCatalog(60, "a", "b")
	if h, body := header(at, `{"agent":"cursor"}`); h != "cursor: 60 models." || !reflect.DeepEqual(body, allRows(at)) {
		t.Fatalf("60 models: %q %q", h, body)
	}
	// A filter that matches nothing in a list within the cap: the whole list.
	if h, body := header(at, `{"agent":"cursor","filter":"zzz"}`); h != `cursor: none of the 60 models match filter "zzz". The whole list follows.` || !reflect.DeepEqual(body, allRows(at)) {
		t.Fatalf("60 models, no match: %q %q", h, body)
	}

	// One more: no rows.
	over := flatCatalog(61, "a", "b")
	h, body := header(over, `{"agent":"cursor"}`)
	if want := []string{"a: 31 models", "b: 30 models", overviewTail}; h != "cursor: 61 models, more than 60, so they are not listed here. Models per id prefix:" || !reflect.DeepEqual(body, want) {
		t.Fatalf("61 models over two prefixes: %q %q", h, body)
	}
	if h, body := header(over, `{"agent":"cursor","filter":"zzz  yyy"}`); h != `cursor: none of the 61 models match filter "zzz yyy". Call again without filter for an overview of the list.` || len(body) != 0 {
		t.Fatalf("61 models, no match: %q %q", h, body)
	}
	// A filter set to a prefix of the overview: rows.
	if h, body := header(over, `{"agent":"cursor","filter":"a/"}`); h != `cursor: 31 of 61 models match filter "a/".` || len(body) != 31 || !isModelRow(body[0]) {
		t.Fatalf("61 models, filter a/: %q %q", h, body)
	}
	// 60 of 61 match: rows. All 61 match: not rows.
	if h, body := header(over, `{"agent":"cursor","filter":"m-0"}`); h != `cursor: 61 of 61 models match filter "m-0", more than 60, so they are not listed here. Matches per id prefix:` || len(body) != 3 {
		t.Fatalf("61 matches: %q %q", h, body)
	}
	sixty := &model.Catalog{Default: over.Default, Models: append(over.Models[:60:60], model.CatalogModel{ID: "b/other", Label: "Other"})}
	if h, body := header(sixty, `{"agent":"cursor","filter":"m-0"}`); h != `cursor: 60 of 61 models match filter "m-0".` || !reflect.DeepEqual(body, allRows(sixty)[:60]) {
		t.Fatalf("60 matches: %q %q", h, body)
	}

	for _, tc := range []struct {
		name string
		cat  *model.Catalog
		want string
	}{
		{"61 models without a prefix", flatCatalog(61, ""), "m-000"},
		{"61 models under one prefix", flatCatalog(61, "a/b"), "a/b/m-000"},
	} {
		h, body := header(tc.cat, `{"agent":"cursor"}`)
		if h != "cursor: 61 models, more than 60, so only their ids are listed here." || len(body) != 62 || body[0] != tc.want || body[61] != idsOnlyTail {
			t.Fatalf("%s: %q %q", tc.name, h, body)
		}
	}
}

func TestListModelsNoneMatch(t *testing.T) {
	e := newEnv(t)
	big := bigPiCatalog()
	e.storeCatalog(model.Pi, big)
	head := e.modelLines(e.token, `{"agent":"pi","filter":"opus"}`)[1:3]
	want := []string{
		fmt.Sprintf(`pi: none of the %d models match filter "no such model". Call again without filter for an overview of the list.`, len(big.Models)),
		head[0], head[1],
	}
	if got := e.modelLines(e.token, `{"agent":"pi","filter":" no  such\tmodel "}`); !reflect.DeepEqual(got, want) {
		t.Fatalf("over the cap: %q, want %q", got, want)
	}

	// Within the cap the whole list follows, as before.
	want = append([]string{`claude: none of the 4 models match filter "no such model". The whole list follows.`, "Model omitted -> sonnet, effort high.", effortRuleHigh}, claudeRows...)
	if got := e.modelLines(e.token, `{"filter":"no such model"}`); !reflect.DeepEqual(got, want) {
		t.Fatalf("within the cap: %q, want %q", got, want)
	}

	// The not-known answer has no list, whatever the filter.
	if got := e.modelLines(e.token, `{"agent":"cursor","filter":"no such model"}`); len(got) != 3 || !strings.HasPrefix(got[0], "cursor: the model list is not known to the app yet.") ||
		strings.Contains(strings.Join(got, "\n"), "Effort omitted") {
		t.Fatalf("not known: %q", got)
	}
}
