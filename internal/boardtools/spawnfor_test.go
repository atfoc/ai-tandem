package boardtools

import (
	"reflect"
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
