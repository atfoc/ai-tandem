package boardtools

import (
	"reflect"
	"strings"
	"testing"
)

func agentProp(t Tool) (map[string]any, bool) {
	p, ok := t.Schema["properties"].(map[string]any)["agent"].(map[string]any)
	return p, ok
}

// SpawnFamilyFor names only the given agents in the two tools that take one, leaves the parameter
// out with none, and leaves SpawnFamily as it is.
func TestSpawnFamilyFor(t *testing.T) {
	summaries := map[string][]string{}
	for _, tc := range []struct {
		agents []string
		desc   string
		spawn  string
		list   string
	}{
		{[]string{"claude", "cursor", "pi"}, "claude, cursor, or pi; omit for this chat's agent", SpawnFamily[0].Summary, SpawnFamily[2].Summary},
		{[]string{"claude", "pi"}, "claude, or pi; omit for this chat's agent",
			`{"prompt": "...", "description"?: "...", "agent"?: "claude|pi", "model"?: "...", "effort"?: "..."}`, `{"agent"?: "claude|pi", "filter"?: "..."}`},
		{[]string{"cursor"}, "cursor; omit for this chat's agent",
			`{"prompt": "...", "description"?: "...", "agent"?: "cursor", "model"?: "...", "effort"?: "..."}`, `{"agent"?: "cursor", "filter"?: "..."}`},
		{nil, "", `{"prompt": "...", "description"?: "...", "model"?: "...", "effort"?: "..."}`, `{"filter"?: "..."}`},
	} {
		got := SpawnFamilyFor(tc.agents)
		if len(got) != len(SpawnFamily) {
			t.Fatalf("%v: %d tools", tc.agents, len(got))
		}
		for i, tool := range got {
			if tool.Name != SpawnFamily[i].Name || tool.Description != SpawnFamily[i].Description {
				t.Fatalf("%v: tool %d is %q", tc.agents, i, tool.Name)
			}
			p, ok := agentProp(tool)
			if tool.Name == "stop_subagent" {
				if ok || tool.Summary != SpawnFamily[i].Summary {
					t.Fatalf("%v: stop_subagent changed: %+v", tc.agents, tool)
				}
				continue
			}
			if len(tc.agents) == 0 {
				if ok {
					t.Fatalf("%v: %s still has the agent parameter", tc.agents, tool.Name)
				}
				continue
			}
			want := make([]any, len(tc.agents))
			for j, a := range tc.agents {
				want[j] = a
			}
			if !ok || !reflect.DeepEqual(p["enum"], want) || p["description"] != tc.desc || p["type"] != "string" {
				t.Fatalf("%v: %s agent parameter = %v", tc.agents, tool.Name, p)
			}
		}
		if got[0].Summary != tc.spawn || got[2].Summary != tc.list {
			t.Fatalf("%v: summaries %q, %q", tc.agents, got[0].Summary, got[2].Summary)
		}
		if req, _ := got[0].Schema["required"].([]string); !reflect.DeepEqual(req, []string{"prompt"}) {
			t.Fatalf("%v: required = %v", tc.agents, got[0].Schema["required"])
		}
		summaries[got[0].Summary] = tc.agents
	}
	// The package's own list is not touched by any of the calls.
	for _, i := range []int{0, 2} {
		p, ok := agentProp(SpawnFamily[i])
		if !ok || !reflect.DeepEqual(p["enum"], []any{"claude", "cursor", "pi"}) {
			t.Fatalf("SpawnFamily[%d] agent parameter = %v", i, p)
		}
	}
	if len(summaries) != 4 {
		t.Fatalf("summaries: %v", summaries)
	}
}

// What a subagent that may spawn is listed: the same tools and parameters, in words that are
// true of it. Nothing of it says "this chat", and what the chat's agent is listed is unchanged.
func TestSpawnFamilyForSub(t *testing.T) {
	agents := []string{"claude", "pi"}
	chat, sub := SpawnFamilyFor(agents), SpawnFamilyForSub(agents)
	if len(sub) != len(chat) {
		t.Fatalf("%d tools for a subagent, %d for the chat's agent", len(sub), len(chat))
	}
	texts := func(tl Tool) []string {
		out := []string{tl.Description}
		for _, p := range tl.Schema["properties"].(map[string]any) {
			out = append(out, p.(map[string]any)["description"].(string))
		}
		return out
	}
	for i, tl := range sub {
		if tl.Name != chat[i].Name || tl.Summary != chat[i].Summary {
			t.Fatalf("tool %d: %s %q, the chat's %s %q", i, tl.Name, tl.Summary, chat[i].Name, chat[i].Summary)
		}
		got, want := tl.Schema["properties"].(map[string]any), chat[i].Schema["properties"].(map[string]any)
		if len(got) != len(want) || !reflect.DeepEqual(tl.Schema["required"], chat[i].Schema["required"]) {
			t.Fatalf("%s: parameters %v, the chat's %v", tl.Name, got, want)
		}
		for _, text := range texts(tl) {
			if strings.Contains(text, "this chat") {
				t.Errorf("%s tells a subagent of \"this chat\": %q", tl.Name, text)
			}
		}
	}
	if d := sub[0].Description; sub[0].Name != "spawn_subagent" || !strings.HasPrefix(d, chat[0].Description) || !strings.HasSuffix(d, subNote) {
		t.Errorf("spawn_subagent for a subagent: %q", d)
	}
	ps := sub[0].Schema["properties"].(map[string]any)
	for name, want := range map[string]string{
		"agent":  "claude, or pi; omit for your own agent",
		"model":  "omit for your own model when the agent is your own and that model and your own effort still fit its list",
		"effort": "omit with a model named for your own effort, or the model's default effort when you have none",
	} {
		if d := ps[name].(map[string]any)["description"].(string); !strings.Contains(d, want) {
			t.Errorf("%s for a subagent: %q", name, d)
		}
	}
	if e := ps["agent"].(map[string]any)["enum"]; !reflect.DeepEqual(e, []any{"claude", "pi"}) {
		t.Errorf("the agent enum for a subagent: %v", e)
	}
	// The lists it was made from are as they were.
	if !reflect.DeepEqual(chat, SpawnFamilyFor(agents)) || strings.Contains(SpawnFamily[0].Description, "You are a subagent") {
		t.Error("making a subagent's list changed the chat's")
	}
}
