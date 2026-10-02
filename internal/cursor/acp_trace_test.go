package cursor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
)

// TestACPTraceRedactsBoardToken proves the debug ACP trace the e2e reads never carries the board
// token, while still recording the method order and the first session/prompt text. It runs a real
// board-chat handshake plus a board MCP call through the fake ACP harness with the trace hook on.
func TestACPTraceRedactsBoardToken(t *testing.T) {
	trace := filepath.Join(t.TempDir(), "cursor-acp.log")
	t.Setenv("AIWB_CURSOR_ACP_LOG", trace)

	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "b1", "title": "board: apply",
			"rawInput": mcpRawInput("board", "apply", map[string]any{"board": "b1"})}),
		endTurn,
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{Board: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}})
	const prompt = "add a cache next to the server"
	send(t, a, prompt)
	until(t, a, isKind(agent.EvTurnEnd))

	b, err := os.ReadFile(trace)
	if err != nil {
		t.Fatalf("read trace: %v", err)
	}
	got := string(b)
	if strings.Contains(got, boardToken) {
		t.Fatalf("the trace contains the board token:\n%s", got)
	}
	for _, secret := range []string{"Authorization", "Bearer", "\"headers\"", "\"value\""} {
		if strings.Contains(got, secret) {
			t.Fatalf("the trace contains %q:\n%s", secret, got)
		}
	}
	// The e2e reads the first outgoing session/prompt text from the trace.
	if first := firstTracePrompt(t, got); first != prompt {
		t.Fatalf("first trace prompt = %q, want %q; trace:\n%s", first, prompt, got)
	}
	// Method order survives the projection.
	methods := traceMethods(t, got)
	pos := func(name string) int {
		for i, m := range methods {
			if m == name {
				return i
			}
		}
		return -1
	}
	for _, name := range []string{"initialize", "authenticate", "session/new", "cursor/list_available_models", "session/prompt"} {
		if pos(name) < 0 {
			t.Fatalf("%s missing from trace methods %v", name, methods)
		}
	}
	for _, p := range [][2]string{{"initialize", "authenticate"}, {"authenticate", "session/new"}, {"session/new", "session/prompt"}} {
		if pos(p[0]) >= pos(p[1]) {
			t.Fatalf("%s is not before %s in trace methods %v", p[0], p[1], methods)
		}
	}
	if methods[0] != "initialize" {
		t.Fatalf("first trace method = %q, want initialize; trace:\n%s", methods[0], got)
	}
}

// TestRecordACPTraceFollowsTheEnvironmentPath proves the trace hook opens the path currently in
// the environment, not a stale handle from a previous path, and that the file is 0600.
func TestRecordACPTraceFollowsTheEnvironmentPath(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.log")
	b := filepath.Join(dir, "b.log")

	t.Setenv("AIWB_CURSOR_ACP_LOG", a)
	recordACP("->", raw(`{"method":"session/prompt","params":{"prompt":[{"type":"text","text":"first"}]}}`))
	t.Setenv("AIWB_CURSOR_ACP_LOG", b)
	recordACP("->", raw(`{"method":"session/prompt","params":{"prompt":[{"type":"text","text":"second"}]}}`))

	first, err := os.ReadFile(a)
	if err != nil {
		t.Fatalf("read %s: %v", a, err)
	}
	second, err := os.ReadFile(b)
	if err != nil {
		t.Fatalf("read %s: %v", b, err)
	}
	if !strings.Contains(string(first), "first") || strings.Contains(string(first), "second") {
		t.Fatalf("first path trace = %q", first)
	}
	if !strings.Contains(string(second), "second") || strings.Contains(string(second), "first") {
		t.Fatalf("second path trace = %q", second)
	}
	fi, err := os.Stat(b)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("trace permissions = %o, want 0600", perm)
	}
}

// traceMethods returns the method of every trace line, in file order.
func traceMethods(t *testing.T, trace string) []string {
	t.Helper()
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(trace), "\n") {
		if !strings.HasPrefix(line, "-> ") && !strings.HasPrefix(line, "<- ") {
			t.Fatalf("bad trace line %q", line)
		}
		var m msg
		if err := json.Unmarshal([]byte(line[3:]), &m); err != nil {
			t.Fatalf("bad trace line %q: %v", line, err)
		}
		if m.Method != "" {
			out = append(out, m.Method)
		}
	}
	return out
}

// firstTracePrompt returns the text of the first outgoing session/prompt line, as the e2e's
// firstCursorPrompt does.
func firstTracePrompt(t *testing.T, trace string) string {
	t.Helper()
	for _, line := range strings.Split(trace, "\n") {
		if !strings.HasPrefix(line, "-> ") {
			continue
		}
		var m struct {
			Method string `json:"method"`
			Params struct {
				Prompt []struct {
					Text string `json:"text"`
				} `json:"prompt"`
			} `json:"params"`
		}
		if json.Unmarshal([]byte(line[3:]), &m) != nil || m.Method != "session/prompt" {
			continue
		}
		var b strings.Builder
		for _, p := range m.Params.Prompt {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	return ""
}
