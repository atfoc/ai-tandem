package boardtools

import (
	"reflect"
	"strings"
	"testing"
)

// kindsOf are the given kinds as agents without names.
func kindsOf(kinds ...string) []Agent {
	var out []Agent
	for _, k := range kinds {
		out = append(out, Agent{Kind: k})
	}
	return out
}

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
		got := SpawnFamilyFor(kindsOf(tc.agents...))
		if len(got) != len(SpawnFamily) {
			t.Fatalf("%v: %d tools", tc.agents, len(got))
		}
		for i, tool := range got {
			if tool.Name != SpawnFamily[i].Name || tool.Description != SpawnFamily[i].Description {
				t.Fatalf("%v: tool %d is %q", tc.agents, i, tool.Name)
			}
			p, ok := agentProp(tool)
			if tool.Name == "stop_subagent" || tool.Name == "resume_subagent" {
				if ok || tool.Summary != SpawnFamily[i].Summary {
					t.Fatalf("%v: %s changed: %+v", tc.agents, tool.Name, tool)
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
	agents := kindsOf("claude", "pi")
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

// A Claude account is named by its kind in the enum and the summary, and by its kind and its name
// in the description; the fixed kinds read as they do without accounts.
func TestSpawnFamilyForAccounts(t *testing.T) {
	work := Agent{Kind: "claude:a_k3j2m9x0", Name: "Claude · Work"}
	home := Agent{Kind: "claude:a_h0m3h0m3", Name: "Claude · Home"}
	for _, tc := range []struct {
		agents []Agent
		enum   []any
		desc   string
		kinds  string
	}{
		{append(kindsOf("claude", "cursor", "pi"), work), []any{"claude", "cursor", "pi", "claude:a_k3j2m9x0"},
			`claude, cursor, pi, or claude:a_k3j2m9x0 ("Claude · Work"); omit for this chat's agent`, "claude|cursor|pi|claude:a_k3j2m9x0"},
		{append(kindsOf("claude"), work, home), []any{"claude", "claude:a_k3j2m9x0", "claude:a_h0m3h0m3"},
			`claude, claude:a_k3j2m9x0 ("Claude · Work"), or claude:a_h0m3h0m3 ("Claude · Home"); omit for this chat's agent`,
			"claude|claude:a_k3j2m9x0|claude:a_h0m3h0m3"},
		{[]Agent{work}, []any{"claude:a_k3j2m9x0"}, `claude:a_k3j2m9x0 ("Claude · Work"); omit for this chat's agent`, "claude:a_k3j2m9x0"},
	} {
		got := SpawnFamilyFor(tc.agents)
		for _, i := range []int{0, 2} {
			p, ok := agentProp(got[i])
			if !ok || !reflect.DeepEqual(p["enum"], tc.enum) || p["description"] != tc.desc {
				t.Errorf("%s: agent parameter = %v", got[i].Name, p)
			}
		}
		if want := `"agent"?: "` + tc.kinds + `"`; !strings.Contains(got[0].Summary, want) || !strings.Contains(got[2].Summary, want) {
			t.Errorf("summaries %q, %q, want %s", got[0].Summary, got[2].Summary, want)
		}
		sub := SpawnFamilyForSub(tc.agents)
		p, _ := agentProp(sub[0])
		if want := strings.Replace(tc.desc, "this chat's", "your own", 1); p["description"] != want {
			t.Errorf("for a subagent: %q, want %q", p["description"], want)
		}
	}
}
