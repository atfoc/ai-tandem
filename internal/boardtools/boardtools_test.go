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
	for _, tname := range []string{"spawn_subagent", "wait_subagents", "stop_subagent"} {
		if IsTool(tname) {
			t.Errorf("IsTool(%q) = true, spawn-family names are not board tools", tname)
		}
	}
}

func TestSpawnFamily(t *testing.T) {
	want := []string{"spawn_subagent", "wait_subagents", "stop_subagent"}
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
	if !strings.Contains(spawn.Description, "wait_subagents") {
		t.Error("spawn_subagent description does not point at wait_subagents for results")
	}
}
