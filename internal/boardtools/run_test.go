package boardtools

import (
	"encoding/json"
	"os"
	"testing"
)

func TestRunToolNames(t *testing.T) {
	seen := map[string]bool{}
	for _, list := range [][]Tool{Tools, SpawnFamily, RunTools} {
		for _, tl := range list {
			if seen[tl.Name] {
				t.Errorf("tool name %q is used twice", tl.Name)
			}
			seen[tl.Name] = true
			if n := len("mcp__board__" + tl.Name); n > 64 || len(tl.Name) > 52 {
				t.Errorf("%q is too long (%d)", tl.Name, n)
			}
			if tl.Description == "" || tl.Schema == nil || tl.Summary == "" {
				t.Errorf("%q lacks a description, schema or summary", tl.Name)
			}
		}
	}
	if len(RunTools) != 13 || len(RunToolsFor(true, true)) != 12 || len(RunToolsFor(true, false)) != 11 || len(RunToolsFor(false, true)) != 9 || len(RunToolsFor(false, false)) != 9 {
		t.Errorf("lists: %d all, %d and %d orchestrator, %d and %d chat", len(RunTools), len(RunToolsFor(true, true)), len(RunToolsFor(true, false)),
			len(RunToolsFor(false, true)), len(RunToolsFor(false, false)))
	}
	if out := os.Getenv("RUN_TOOLS_JSON"); out != "" {
		var list []map[string]any
		for _, tl := range RunTools {
			who := "orchestrator, run chats"
			if orchestratorOnly[tl.Name] {
				who = "orchestrator"
			} else if chatOnly[tl.Name] {
				who = "run chats"
			}
			list = append(list, map[string]any{"name": tl.Name, "for": who, "description": tl.Description, "inputSchema": tl.Schema})
		}
		b, _ := json.MarshalIndent(list, "", "  ")
		os.WriteFile(out, b, 0o644)
	}
}

func TestRunToolLists(t *testing.T) {
	names := func(list []Tool) map[string]bool {
		out := map[string]bool{}
		for _, tl := range list {
			out[tl.Name] = true
		}
		return out
	}
	// The complete lists, in the order they are listed in.
	list := func(l []Tool) string {
		out := ""
		for _, tl := range l {
			out += " " + tl.Name
		}
		return out[1:]
	}
	const chatList = "get_run get_task get_agent get_notes add_task update_task cancel_task retry_task tell_orchestrator"
	for _, c := range []struct {
		what      string
		got, want string
	}{
		{"the orchestrator, wake mode declared", list(RunToolsFor(true, true)), "get_run get_task get_agent get_notes set_notes edit_notes add_task update_task cancel_task retry_task wait_for finish_run"},
		{"the orchestrator, another wake mode", list(RunToolsFor(true, false)), "get_run get_task get_agent get_notes set_notes edit_notes add_task update_task cancel_task retry_task finish_run"},
		{"a chat on a run, wake mode declared", list(RunToolsFor(false, true)), chatList},
		{"a chat on a run, another wake mode", list(RunToolsFor(false, false)), chatList},
		{"OrchestratorTools", list(OrchestratorTools()), list(RunToolsFor(true, true))},
		{"RunChatTools", list(RunChatTools()), chatList},
	} {
		if c.got != c.want {
			t.Errorf("%s:\n got %s\nwant %s", c.what, c.got, c.want)
		}
	}
	orch, chat := names(OrchestratorTools()), names(RunChatTools())
	for _, tl := range RunTools {
		if !IsRunTool(tl.Name) {
			t.Errorf("IsRunTool(%q) is false", tl.Name)
		}
		if IsTool(tl.Name) || IsSpawnFamily(tl.Name) {
			t.Errorf("%q is also a board tool", tl.Name)
		}
		if read := tl.Name[:4] == "get_"; IsRunRead(tl.Name) != read {
			t.Errorf("IsRunRead(%q) = %v", tl.Name, !read)
		}
		if !orch[tl.Name] && !chat[tl.Name] {
			t.Errorf("%q is in neither list", tl.Name)
		}
	}
	for _, n := range []string{"spawn_subagent", "read_board", "", "get_runs"} {
		if IsRunTool(n) {
			t.Errorf("IsRunTool(%q) is true", n)
		}
	}
	// The lists are in RunTools' order and are copies: changing one changes nothing else.
	a := OrchestratorTools()
	a[0].Name = "x"
	if RunTools[0].Name != "get_run" || OrchestratorTools()[0].Name != "get_run" {
		t.Error("OrchestratorTools hands out RunTools' own storage")
	}
}
