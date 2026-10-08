package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

func readFixture(t *testing.T) json.RawMessage {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "context_usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	return json.RawMessage(strings.TrimSpace(string(b)))
}

func TestParseContextUsage(t *testing.T) {
	s, counted, err := ParseContextUsage(readFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if !counted {
		t.Error("counted = false with every MCP tool counted")
	}
	if s.Total != 47894 || s.Window != 1000000 {
		t.Errorf("total %d window %d", s.Total, s.Window)
	}
	var ids, kinds []string
	for _, c := range s.Categories {
		ids, kinds = append(ids, c.ID), append(kinds, c.Kind)
	}
	wantIDs := []string{"system_prompt", "system_tools", "mcp_tools", "mcp_tools_deferred", "system_tools_deferred",
		"custom_agents", "memory_files", "skills", "messages", "autocompact_buffer", "free_space"}
	wantKinds := []string{"used", "used", "used", "deferred", "deferred", "used", "used", "used", "used", "buffer", "free"}
	if !slices.Equal(ids, wantIDs) || !slices.Equal(kinds, wantKinds) {
		t.Fatalf("ids %v kinds %v", ids, kinds)
	}
	byID := map[string]model.ContextCategory{}
	for _, c := range s.Categories {
		byID[c.ID] = c
	}
	items := map[string][]model.ContextItem{
		"mcp_tools":          {{Name: "mcp__docs__batch", Tokens: 166, Note: "docs"}},
		"mcp_tools_deferred": {{Name: "mcp__board__draw", Tokens: 46, Note: "board"}, {Name: "mcp__board__read_board", Tokens: 74, Note: "board"}},
		"custom_agents":      {{Name: "tester", Tokens: 22, Note: "projectSettings"}},
		"memory_files":       {{Name: "/work/app/CLAUDE.md", Tokens: 36, Note: "Project"}},
		"skills":             {{Name: "dataviz", Tokens: 114, Note: "built-in"}, {Name: "prototype", Tokens: 86, Note: "userSettings"}},
	}
	for id, want := range items {
		if got := byID[id].Items; !reflect.DeepEqual(got, want) {
			t.Errorf("%s items %+v, want %+v", id, got, want)
		}
	}
	msg := byID["messages"]
	sum := 0
	var parts []string
	for _, p := range msg.Parts {
		sum += p.Tokens
		parts = append(parts, p.ID)
	}
	if !slices.Equal(parts, []string{"tool_calls", "tool_results", "attachments", "assistant", "user", "redirected", "unattributed"}) {
		t.Errorf("parts %v", parts)
	}
	if sum != msg.Tokens {
		t.Errorf("parts add up to %d, messages are %d", sum, msg.Tokens)
	}
	if got := msg.Parts[0].Items; !reflect.DeepEqual(got, []model.ContextItem{{Name: "Bash", Tokens: 627}}) {
		t.Errorf("tool call items %+v", got)
	}
	if got := msg.Parts[1].Items; !reflect.DeepEqual(got, []model.ContextItem{{Name: "Bash", Tokens: 16699}}) {
		t.Errorf("tool result items %+v", got)
	}
	if got := msg.Parts[2].Items; len(got) != 2 || got[0] != (model.ContextItem{Name: "prompt_snapshot", Tokens: 13914}) {
		t.Errorf("attachment items %+v", got)
	}
	wantFacts := []model.ContextFact{
		{Label: "Model", Value: "claude-opus-5-5"},
		{Label: "Auto-compact", Value: "at 967,000 tokens"},
		{Label: "Skills listed", Value: "2 of 3"},
		{Label: "Slash commands listed", Value: "36 of 36 · 919 tokens"},
	}
	if !reflect.DeepEqual(s.Facts, wantFacts) {
		t.Errorf("facts %+v", s.Facts)
	}
}

func TestParseContextUsageNotCounted(t *testing.T) {
	raw := strings.Replace(string(readFixture(t)), `"tokens":46,`, `"tokens":0,`, 1)
	if _, counted, err := ParseContextUsage(json.RawMessage(raw)); err != nil || counted {
		t.Errorf("counted %v err %v, want false with an MCP tool at 0 tokens", counted, err)
	}
	if _, counted, _ := ParseContextUsage(json.RawMessage(`{"categories":[{"name":"System prompt","tokens":1,"kind":"used"}]}`)); !counted {
		t.Error("counted = false with no MCP tools")
	}
}

func TestParseContextUsageBad(t *testing.T) {
	for _, raw := range []string{`nope`, `{}`, `{"categories":[]}`} {
		if _, _, err := ParseContextUsage(json.RawMessage(raw)); err == nil {
			t.Errorf("%s: no error", raw)
		}
	}
}

func TestParseContextUsageAutoCompactOff(t *testing.T) {
	raw := strings.Replace(string(readFixture(t)), `"isAutoCompactEnabled":true`, `"isAutoCompactEnabled":false`, 1)
	s, _, _ := ParseContextUsage(json.RawMessage(raw))
	if !slices.Contains(s.Facts, model.ContextFact{Label: "Auto-compact", Value: "off"}) {
		t.Errorf("facts %+v", s.Facts)
	}
}

func TestSnakeAndCommas(t *testing.T) {
	for in, want := range map[string]string{"MCP tools (deferred)": "mcp_tools_deferred", "System prompt": "system_prompt", "Skills": "skills"} {
		if got := snake(in); got != want {
			t.Errorf("snake(%q) = %q", in, got)
		}
	}
	for n, want := range map[int]string{0: "0", 919: "919", 1000: "1,000", 967000: "967,000", 1234567: "1,234,567"} {
		if got := commas(n); got != want {
			t.Errorf("commas(%d) = %q", n, got)
		}
	}
}

// ctxAnswers makes the fake answer get_context_usage with these answers, in order.
func ctxAnswers(t *testing.T, f *fake, answers ...string) {
	t.Helper()
	p := filepath.Join(f.dir, "ctx.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(answers, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envCtx, p)
}

func ctxRequests(lines []map[string]any) int {
	n := 0
	for _, l := range lines {
		if l["type"] == "control_request" && obj(l["request"])["subtype"] == "get_context_usage" {
			n++
		}
	}
	return n
}

func TestLiveContextSplit(t *testing.T) {
	// The fake gives its answers in order however soon it is asked again, so the pause is only waited out.
	old := splitRetry
	splitRetry = 10 * time.Millisecond
	t.Cleanup(func() { splitRetry = old })
	f := newFake(t, `{"type":"system","subtype":"status","status":"requesting"}`)
	fixture := string(readFixture(t))
	// Asked early, the MCP tools are not counted yet: it asks again.
	ctxAnswers(t, f, strings.Replace(fixture, `"tokens":46,`, `"tokens":0,`, 1), fixture)
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if ev := next(t, a); ev.Kind != agent.EvThinking {
		t.Fatalf("event %+v", ev)
	}
	s, err := a.(agent.ContextSplitter).ContextSplit()
	if err != nil {
		t.Fatal(err)
	}
	if s.Total != 47894 || s.Categories[3].Items[0].Tokens != 46 {
		t.Errorf("split %+v, want the counted answer", s)
	}
	if n := ctxRequests(skipInit(t, f.stdinLines(t, a))); n != 2 {
		t.Errorf("%d get_context_usage requests, want 2", n)
	}
}

func TestLiveContextSplitError(t *testing.T) {
	f := newFake(t)
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	p := a.(*proc)
	p.reply([]byte(`{"type":"control_response","response":{"subtype":"error","request_id":"other","error":"x"}}`)) // no one waits: dropped
	// Answer our request with an error once it is waiting.
	go func() {
		for {
			var id string
			p.replies.Range(func(k, v any) bool { id = k.(string); return false })
			if id != "" {
				p.reply([]byte(`{"type":"control_response","response":{"subtype":"error","request_id":"` + id + `","error":"not supported here"}}`))
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	if _, err := p.ContextSplit(); err == nil || !strings.Contains(err.Error(), "not supported here") {
		t.Errorf("err %v", err)
	}
	f.stdinLines(t, a)
}

func TestReadContextSplitForks(t *testing.T) {
	f := newFake(t)
	ctxAnswers(t, f, string(readFixture(t)))
	cwd, dir := t.TempDir(), t.TempDir()
	s, err := f.spawner().ReadContextSplit(agent.SpawnOptions{SessionID: "s1", Cwd: cwd, Model: "opus", Dir: dir,
		MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "fork-tok"}})
	if err != nil {
		t.Fatal(err)
	}
	if s.Total != 47894 {
		t.Errorf("total %d", s.Total)
	}
	var rec struct{ Args []string }
	b, _ := os.ReadFile(f.args)
	json.Unmarshal(b, &rec)
	if v, _ := flag(rec.Args, "--resume"); v != "s1" {
		t.Errorf("args %q, want --resume s1", rec.Args)
	}
	if _, ok := flag(rec.Args, "--fork-session"); !ok {
		t.Errorf("args %q, want --fork-session", rec.Args)
	}
	if _, ok := flag(rec.Args, "--resume-session-at"); ok {
		t.Errorf("args %q: no point was given, the whole session is read", rec.Args)
	}
	// The fork inherits the same board config, header included: the chat's own file.
	cfg, ok := flag(rec.Args, "--mcp-config")
	if !ok {
		t.Errorf("args %q, want the chat's own arguments (--mcp-config)", rec.Args)
	} else if cfg != filepath.Join(dir, "mcp.json") {
		t.Errorf("--mcp-config = %q, want the file in the chat's folder", cfg)
	} else if b, _ := os.ReadFile(cfg); string(b) != `{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer fork-tok"}}}}` {
		t.Errorf("the --mcp-config file holds %s, want the fixed URL with the bearer header", b)
	}
	lines, _ := os.ReadFile(f.stdin) // the fake has exited: stdin was closed
	if n := strings.Count(string(lines), "get_context_usage"); n != 1 {
		t.Errorf("%d requests, want 1", n)
	}
	if strings.Contains(string(lines), `"type":"user"`) {
		t.Error("a message was sent")
	}
}

// A split read up to a point (a fork that has no session of its own yet, read from its source)
// starts the process as that fork is started, but for the fork's own session id.
func TestReadContextSplitAtPoint(t *testing.T) {
	f := newFake(t)
	ctxAnswers(t, f, string(readFixture(t)))
	s, err := f.spawner().ReadContextSplit(agent.SpawnOptions{SessionID: "src", Point: "U", Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if s.Total != 47894 {
		t.Errorf("total %d", s.Total)
	}
	var rec struct{ Args []string }
	b, _ := os.ReadFile(f.args)
	json.Unmarshal(b, &rec)
	if v, _ := flag(rec.Args, "--resume"); v != "src" {
		t.Errorf("args %q, want --resume src", rec.Args)
	}
	if _, ok := flag(rec.Args, "--fork-session"); !ok {
		t.Errorf("args %q, want --fork-session", rec.Args)
	}
	if v, _ := flag(rec.Args, "--resume-session-at"); v != "U" {
		t.Errorf("args %q, want --resume-session-at U", rec.Args)
	}
	if _, ok := flag(rec.Args, "--session-id"); ok {
		t.Errorf("args %q: a split read keeps no session, it must not name one", rec.Args)
	}
}

func TestReadContextSplitExitReason(t *testing.T) {
	f := newFake(t)
	t.Setenv(envStderr, "No conversation found with session ID: s1")
	t.Setenv(envExit, "1")
	_, err := f.spawner().ReadContextSplit(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir()})
	if err == nil || err.Error() != "claude: No conversation found with session ID: s1" {
		t.Errorf("err %v, want the process's reason", err)
	}
}
