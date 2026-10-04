package boardtools

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTools(t *testing.T) {
	want := []string{"list_boards", "read_board", "get_view", "apply", "delete_elements", "create_board", "show_board"}
	if len(Tools) != len(want) {
		t.Fatalf("len(Tools) = %d, want %d", len(Tools), len(want))
	}
	for i, tool := range Tools {
		if tool.Name != want[i] {
			t.Errorf("Tools[%d].Name = %q, want %q", i, tool.Name, want[i])
		}
		if tool.Description == "" {
			t.Errorf("%s: empty Description", tool.Name)
		}
		if tool.Summary == "" {
			t.Errorf("%s: empty Summary", tool.Name)
		}
		if tool.Schema == nil || tool.Schema["type"] != "object" {
			t.Errorf("%s: schema is not an object schema", tool.Name)
		}
		if _, err := json.Marshal(tool.Schema); err != nil {
			t.Errorf("%s: schema does not marshal: %v", tool.Name, err)
		}
		if !IsTool(tool.Name) {
			t.Errorf("%s: IsTool says no", tool.Name)
		}
	}
	if IsTool("rm_rf") {
		t.Error("IsTool accepted an unknown tool")
	}
	for _, tname := range []string{"spawn_subagent", "stop_subagent", "list_subagent_models"} {
		if IsTool(tname) {
			t.Errorf("IsTool(%q) = true, spawn-family names are not board tools", tname)
		}
	}
}

func TestSpawnFamily(t *testing.T) {
	want := []string{"spawn_subagent", "stop_subagent", "list_subagent_models"}
	if len(SpawnFamily) != len(want) {
		t.Fatalf("len(SpawnFamily) = %d, want %d", len(SpawnFamily), len(want))
	}
	for i, tool := range SpawnFamily {
		if tool.Name != want[i] {
			t.Errorf("SpawnFamily[%d].Name = %q, want %q", i, tool.Name, want[i])
		}
		if tool.Description == "" {
			t.Errorf("%s: empty Description", tool.Name)
		}
		if tool.Schema == nil || tool.Schema["type"] != "object" {
			t.Errorf("%s: schema is not an object schema", tool.Name)
		}
		if _, err := json.Marshal(tool.Schema); err != nil {
			t.Errorf("%s: schema does not marshal: %v", tool.Name, err)
		}
		if !IsSpawnFamily(tool.Name) {
			t.Errorf("%s: IsSpawnFamily says no", tool.Name)
		}
		if IsTool(tool.Name) {
			t.Errorf("%s: IsTool should be false", tool.Name)
		}
	}
	if IsSpawnFamily("apply") {
		t.Error("IsSpawnFamily accepted a board tool")
	}
	// The polling tool is gone: results are pushed to the agent.
	if IsSpawnFamily("wait_subagents") || IsTool("wait_subagents") {
		t.Error("wait_subagents is still a tool")
	}

	var spawn Tool
	for _, tool := range SpawnFamily {
		if tool.Name == "spawn_subagent" {
			spawn = tool
			break
		}
	}
	if spawn.Name == "" {
		t.Fatal("spawn_subagent missing")
	}
	props, _ := spawn.Schema["properties"].(map[string]any)
	if props == nil {
		t.Fatal("spawn_subagent has no properties")
	}
	if _, ok := props["background"]; ok {
		t.Error("spawn_subagent schema has a background property")
	}
	if _, ok := props["prompt"]; !ok {
		t.Error("spawn_subagent schema missing prompt")
	}
	if !strings.Contains(spawn.Description, "distinct description") {
		t.Error("spawn_subagent description does not tell callers to give parallel spawns distinct descriptions")
	}
	// The description is the only steering Cursor and pi chats get: the result arrives as a message
	// from the app, the agent ends its turn, and it neither polls nor sleeps.
	for _, want := range []string{
		"the app sends you the result as a message",
		"<subagent-results>",
		"end your turn when you have nothing else to do",
		"do not poll, sleep",
	} {
		if !strings.Contains(spawn.Description, want) {
			t.Errorf("spawn_subagent description lacks %q: %q", want, spawn.Description)
		}
	}
	for _, tool := range SpawnFamily {
		if strings.Contains(tool.Description, "wait_subagents") || strings.Contains(tool.Summary, "wait_subagents") {
			t.Errorf("%s still names wait_subagents: %q", tool.Name, tool.Description)
		}
	}
}

// TestSpawnPointsToModelList: spawn_subagent names list_subagent_models where an agent picks a
// model or effort, and the pointer changes neither the earlier text nor the arguments.
func TestSpawnPointsToModelList(t *testing.T) {
	var spawn Tool
	for _, tool := range SpawnFamily {
		if tool.Name == "spawn_subagent" {
			spawn = tool
			break
		}
	}
	if spawn.Name == "" {
		t.Fatal("spawn_subagent missing")
	}
	const before = "Start one subagent run and return immediately with a receipt naming its sid. " +
		"The run continues in the background, and there is nothing to call for its result: " +
		"when the subagent finishes, the app sends you the result as a message, in a " +
		"<subagent-results> block written by the app, not by the user. " +
		"After spawning, end your turn when you have nothing else to do; " +
		"do not poll, sleep or run commands to wait for a subagent. " +
		"Parallel spawn_subagent calls need distinct descriptions so their arguments differ. " +
		"Every spawn is asynchronous: there is no background parameter."
	const pointer = " To name a model or effort, first call list_subagent_models: it lists the model ids and efforts each agent accepts."
	if spawn.Description != before+pointer {
		t.Errorf("spawn_subagent description = %q, want the earlier text followed by %q", spawn.Description, pointer)
	}

	props, _ := spawn.Schema["properties"].(map[string]any)
	for _, name := range []string{"model", "effort"} {
		p, _ := props[name].(map[string]any)
		desc, _ := p["description"].(string)
		if !strings.Contains(desc, "list_subagent_models") {
			t.Errorf("%s description does not name list_subagent_models: %q", name, desc)
		}
	}
	for _, name := range []string{"prompt", "description", "agent", "model", "effort"} {
		if _, ok := props[name]; !ok {
			t.Errorf("spawn_subagent schema missing %s", name)
		}
	}
	if len(props) != 5 {
		t.Errorf("spawn_subagent schema has %d properties, want 5: %v", len(props), props)
	}
	if req, _ := spawn.Schema["required"].([]string); len(req) != 1 || req[0] != "prompt" {
		t.Errorf("spawn_subagent required = %v, want [prompt]", spawn.Schema["required"])
	}
	const summary = `{"prompt": "...", "description"?: "...", "agent"?: "claude|cursor|pi", "model"?: "...", "effort"?: "..."}`
	if spawn.Summary != summary {
		t.Errorf("spawn_subagent summary = %q, want %q", spawn.Summary, summary)
	}
}
