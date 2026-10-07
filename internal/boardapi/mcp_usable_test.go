package boardapi

import (
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// agentEnums is tools/list's enum of the agent parameter per tool that has the parameter.
func (e *env) agentEnums(token string) map[string][]any {
	e.t.Helper()
	out := map[string][]any{}
	for _, tool := range e.listSchemas(token) {
		props, _ := tool["inputSchema"].(map[string]any)["properties"].(map[string]any)
		if p, ok := props["agent"].(map[string]any); ok {
			out[tool["name"].(string)], _ = p["enum"].([]any)
		}
	}
	return out
}

// tools/list names only the agents the server can start in spawn_subagent and
// list_subagent_models, and both tools refuse another one.
func TestSpawnToolsNameOnlyUsableAgents(t *testing.T) {
	e := newEnv(t)
	var mu sync.Mutex
	have := map[string]bool{"claude": true, "pi": true}
	look := func(bin string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if !have[bin] {
			return "", errors.New("not found")
		}
		return "/bin/" + bin, nil
	}
	set := usable.NewWith(map[model.AgentKind]string{model.Claude: "claude", model.Cursor: "cursor", model.Pi: "pi"}, look)
	e.relay.Chats.Agents = set
	_, plain := e.createPlain()

	// A plain chat and a chat on a board list the same spawn tools.
	for _, token := range []string{plain, e.token} {
		want := map[string][]any{"spawn_subagent": {"claude", "pi"}, "list_subagent_models": {"claude", "pi"}}
		if got := e.agentEnums(token); !reflect.DeepEqual(got, want) {
			t.Fatalf("agent enums = %v, want %v", got, want)
		}
	}
	for _, name := range []string{"spawn_subagent", "list_subagent_models"} {
		args := `{"agent":"cursor"}`
		if name == "spawn_subagent" {
			args = `{"prompt":"do it","agent":"cursor"}`
		}
		text, isErr, status := e.toolsCall(plain, name, args)
		if status != 200 || !isErr || !strings.Contains(text, `agent "cursor" cannot be used on this server`) || !strings.Contains(text, "Usable: claude, pi") {
			t.Fatalf("%s for an agent outside the list: status %d, isErr %v, %q", name, status, isErr, text)
		}
	}

	// With no usable agent the parameter is left out; the tools stay listed.
	mu.Lock()
	have = map[string]bool{}
	mu.Unlock()
	set.Refresh()
	if got := e.agentEnums(plain); len(got) != 0 {
		t.Fatalf("agent enums with no usable agent = %v", got)
	}
	names := e.listNames(plain)
	if !joinEq(names, []string{"spawn_subagent", "stop_subagent", "list_subagent_models"}) {
		t.Fatalf("tools with no usable agent = %v", names)
	}
}
