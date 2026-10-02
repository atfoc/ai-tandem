package pi

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

func TestHandshakeAppliesModelAndEmitsCatalog(t *testing.T) {
	f := newFake(t)
	f.replies(t, map[string]fakeReply{
		"get_state":            {Data: json.RawMessage(`{"sessionId":"s1","sessionFile":"/tmp/s1.jsonl","model":{"provider":"deepseek","id":"flash","contextWindow":1000000}}`)},
		"get_available_models": {Data: json.RawMessage(`{"models":[{"id":"flash","name":"Flash","provider":"deepseek","reasoning":true,"thinkingLevelMap":{"minimal":null,"low":"low","medium":null,"high":"high"},"contextWindow":1000000}]}`)},
		"set_model":            {Data: json.RawMessage(`{"id":"flash","provider":"deepseek","contextWindow":1000000}`)},
	})
	s := f.spawner()
	s.Extension = "/ext/index.ts"
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", SessionID: "s1", Cwd: t.TempDir(),
		Model: "deepseek/flash", Effort: "high"})

	ev := waitKind(t, a, agent.EvCatalog)
	cat := ev.Catalog
	if cat == nil || len(cat.Models) != 1 {
		t.Fatalf("catalog %+v", cat)
	}
	m := cat.Models[0]
	if m.ID != "deepseek/flash" || m.Label != "Flash" || m.Provider != "deepseek" || m.ContextWindow != 1000000 {
		t.Errorf("model %+v", m)
	}
	if !equalStrings(m.Efforts, []string{"off", "low", "high"}) {
		t.Errorf("efforts %q, want off/low/high (minimal and medium are null)", m.Efforts)
	}
	if m.DefaultEffort != "low" {
		t.Errorf("default effort %q, want low", m.DefaultEffort)
	}
	if cat.Default.Model != "deepseek/flash" || cat.Default.Effort != "low" {
		t.Errorf("catalog default %+v", cat.Default)
	}

	lines := f.stdinLines(t, a)
	if got := commandTypes(lines); !equalStrings(got, []string{"get_state", "get_available_models", "set_model", "set_thinking_level"}) {
		t.Fatalf("commands %q", got)
	}
	set := lines[2]
	if set["provider"] != "deepseek" || set["modelId"] != "flash" {
		t.Errorf("set_model %v", set)
	}
	if th := lines[3]; th["level"] != "high" {
		t.Errorf("set_thinking_level %v", th)
	}
}

func TestHandshakeReadyErr(t *testing.T) {
	f := newFake(t)
	f.replies(t, map[string]fakeReply{"get_state": {Fail: true, Error: "no auth"}})
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	err := a.Send([]agent.ContentBlock{{Text: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "no auth") {
		t.Fatalf("Send = %v, want the handshake error", err)
	}
	lines := f.stdinLines(t, a)
	if got := commandTypes(lines); !equalStrings(got, []string{"get_state"}) {
		t.Fatalf("commands %q, want only get_state (no prompt)", got)
	}
}

func TestSessionReconcile(t *testing.T) {
	t.Run("different id emits EvSession", func(t *testing.T) {
		f := newFake(t)
		f.replies(t, map[string]fakeReply{
			"get_state": {Data: json.RawMessage(`{"sessionId":"pi-real","sessionFile":"/tmp/pi-real.jsonl","model":{"provider":"test","id":"test-model"}}`)},
		})
		a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", SessionID: "app-id", Cwd: t.TempDir()})
		ev := next(t, a)
		if ev.Kind != agent.EvSession || ev.SessionID != "pi-real" {
			t.Fatalf("first event %+v, want EvSession pi-real", ev)
		}
		if ev := next(t, a); ev.Kind != agent.EvCatalog {
			t.Fatalf("second event %+v, want EvCatalog", ev)
		}
		f.stdinLines(t, a)
	})
	t.Run("same id emits nothing", func(t *testing.T) {
		f := newFake(t)
		f.replies(t, map[string]fakeReply{
			"get_state": {Data: json.RawMessage(`{"sessionId":"app-id","sessionFile":"/tmp/app-id.jsonl","model":{"provider":"test","id":"test-model"}}`)},
		})
		a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", SessionID: "app-id", Cwd: t.TempDir()})
		if ev := next(t, a); ev.Kind != agent.EvCatalog {
			t.Fatalf("first event %+v, want EvCatalog", ev)
		}
		f.stdinLines(t, a)
	})
}

func TestSendJoinsBlocks(t *testing.T) {
	f := newFake(t)
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	if err := a.Send([]agent.ContentBlock{{Text: "one"}, {}, {Text: "two"}}); err != nil {
		t.Fatal(err)
	}
	if ev := next(t, a); ev.Kind != agent.EvThinking {
		t.Fatalf("event %+v, want EvThinking", ev)
	}
	lines := f.stdinLines(t, a)
	if got := commandTypes(lines); !equalStrings(got, []string{"get_state", "get_available_models", "prompt"}) {
		t.Fatalf("commands %q", got)
	}
	if msg := lines[2]["message"]; msg != "one\n\ntwo" {
		t.Errorf("prompt message %q, want the non-empty blocks joined", msg)
	}
}

func TestSpawnBoardPromptEnvAndSessionDir(t *testing.T) {
	t.Setenv("PI_SUBAGENT", "1")
	f := newFake(t)
	s := f.spawner()
	s.Prompt = "BOARD-PROMPT"
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", SessionID: "app-1", Cwd: t.TempDir(),
		Model: "test/test-model", BoardID: "board"})
	waitKind(t, a, agent.EvCatalog)
	inv := f.invocation(t)

	sessionDir := filepath.Join(f.root, "chats", "c1", "pi")
	promptFile := filepath.Join(sessionDir, "append-prompt.md")
	if got := flagValue(inv.Args, "--session-dir"); got != sessionDir {
		t.Errorf("--session-dir %q, want %q", got, sessionDir)
	}
	if got := flagValue(inv.Args, "--append-system-prompt"); got != promptFile {
		t.Errorf("--append-system-prompt %q, want %q", got, promptFile)
	}
	if inv.ChatID != "c1" || inv.ChatDir != filepath.Join(f.root, "chats", "c1") {
		t.Errorf("chat env %+v", inv)
	}
	if inv.BridgeSocket != "" || inv.BridgeRun != "" {
		t.Errorf("bridge env set without a bridge: %+v", inv)
	}
	if inv.MCPConfig != "" {
		t.Errorf("board chat without a registered run got AIWB_MCP_CONFIG %q", inv.MCPConfig)
	}
	if inv.Model != "test/test-model" || inv.AppendPrompt != promptFile {
		t.Errorf("env %+v", inv)
	}
	if inv.PiSubagent != "" {
		t.Errorf("PI_SUBAGENT leaked into the child: %q", inv.PiSubagent)
	}
	if inv.PiBin == "" || !filepath.IsAbs(inv.PiBin) {
		t.Errorf("AIWB_PI_BIN %q, want the absolute binary", inv.PiBin)
	}
	body, err := os.ReadFile(promptFile)
	if err != nil || strings.TrimSpace(string(body)) != "BOARD-PROMPT" {
		t.Fatalf("append-prompt.md = %q, %v", body, err)
	}
	f.stdinLines(t, a)
}

func TestSpawnBoardChatMCPConfig(t *testing.T) {
	const boardToken = "board-secret-token"
	reg := &fakeRegistry{}
	f := newFake(t)
	s := f.spawner()
	s.Bridge = reg
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", SessionID: "app-1", Cwd: t.TempDir(),
		Model: "test/test-model", MCP: &agent.BoardAccess{
			MCPURL: "http://localhost:6006/mcp",
			Token:  boardToken,
		}})
	waitKind(t, a, agent.EvCatalog)
	inv := f.invocation(t)

	if inv.BridgeRun != "run-7" {
		t.Fatalf("AIWB_BRIDGE_RUN = %q, want the minted run handle", inv.BridgeRun)
	}
	var cfg struct {
		MCPServers map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(inv.MCPConfig), &cfg); err != nil {
		t.Fatalf("AIWB_MCP_CONFIG %q is not JSON: %v", inv.MCPConfig, err)
	}
	if len(cfg.MCPServers) != 1 {
		t.Fatalf("MCP servers %+v, want only the board server", cfg.MCPServers)
	}
	srv, ok := cfg.MCPServers["board"]
	if !ok || srv.Type != "http" || srv.URL != "http://localhost:6006/mcp" ||
		srv.Headers["Authorization"] != "Bearer "+boardToken {
		t.Fatalf("board server %+v, want the fixed URL and the bearer header", srv)
	}
	// Contract (D16): the board token appears only inside AIWB_MCP_CONFIG, never
	// elsewhere in the child env, and never in argv.
	for _, kv := range inv.Env {
		if strings.Contains(kv, boardToken) && !strings.HasPrefix(kv, "AIWB_MCP_CONFIG=") {
			t.Fatalf("board token leaked outside AIWB_MCP_CONFIG: %q", kv)
		}
	}
	if strings.Contains(strings.Join(inv.Args, " "), boardToken) {
		t.Fatalf("board token leaked into argv: %q", inv.Args)
	}
	f.stdinLines(t, a)
}

// TestSpawnBoardChatMCPConfigExtraSeam pins the test-only A6 seam: extra non-board servers are
// merged into the board chat's AIWB_MCP_CONFIG while the app-owned "board" key can never be
// replaced by it.
func TestSpawnBoardChatMCPConfigExtraSeam(t *testing.T) {
	const boardToken = "board-secret-token"
	reg := &fakeRegistry{}
	f := newFake(t)
	s := f.spawner()
	s.Bridge = reg
	s.mcpConfigExtra = map[string]mcpServerConfig{
		"other": {Type: "http", URL: "http://127.0.0.1:1/mcp/other"},
		"board": {Type: "http", URL: "http://evil.invalid/mcp/hijack"},
	}
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir(), MCP: &agent.BoardAccess{
		MCPURL: "http://localhost:6006/mcp", Token: boardToken}})
	waitKind(t, a, agent.EvCatalog)
	inv := f.invocation(t)

	var cfg mcpConfig
	if err := json.Unmarshal([]byte(inv.MCPConfig), &cfg); err != nil {
		t.Fatalf("AIWB_MCP_CONFIG %q is not JSON: %v", inv.MCPConfig, err)
	}
	if got := cfg.MCPServers["board"].URL; got != "http://localhost:6006/mcp" {
		t.Fatalf("board server URL = %q, want the fixed app URL", got)
	}
	if got := cfg.MCPServers["other"]; got.Type != "http" || got.URL != "http://127.0.0.1:1/mcp/other" {
		t.Fatalf("extra server = %+v, want the merged test-only entry", got)
	}
	for _, kv := range inv.Env {
		if strings.Contains(kv, boardToken) && !strings.HasPrefix(kv, "AIWB_MCP_CONFIG=") {
			t.Fatalf("board token leaked outside AIWB_MCP_CONFIG: %q", kv)
		}
	}
	f.stdinLines(t, a)
}

func TestSpawnPlainChatNoMCPConfig(t *testing.T) {
	reg := &fakeRegistry{}
	f := newFake(t)
	s := f.spawner()
	s.Bridge = reg
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	inv := f.invocation(t)
	if inv.MCPConfig != "" {
		t.Fatalf("MCP unset got AIWB_MCP_CONFIG %q", inv.MCPConfig)
	}
	if inv.BridgeRun != "run-7" {
		t.Fatalf("plain chat AIWB_BRIDGE_RUN = %q, want the minted bridge run handle", inv.BridgeRun)
	}
	f.stdinLines(t, a)
}

func TestSpawnPlainChatWithMCPConfig(t *testing.T) {
	const tok = "plain-mcp-token"
	reg := &fakeRegistry{}
	f := newFake(t)
	s := f.spawner()
	s.Bridge = reg
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir(),
		MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: tok}})
	waitKind(t, a, agent.EvCatalog)
	inv := f.invocation(t)
	want := `{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer plain-mcp-token"}}}}`
	if inv.MCPConfig != want {
		t.Fatalf("MCP set: AIWB_MCP_CONFIG = %q\nwant %q", inv.MCPConfig, want)
	}
	f.stdinLines(t, a)
}

func TestExitStderrOnce(t *testing.T) {
	f := newFake(t)
	t.Setenv(envExit, "1")
	t.Setenv(envStderr, "  something broke  ")
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	ev := next(t, a)
	if ev.Kind != agent.EvExit || ev.ExitErr != "something broke" {
		t.Fatalf("event %+v, want EvExit with the trimmed stderr", ev)
	}
	if _, ok := <-a.Events(); ok {
		t.Error("events not closed after EvExit")
	}
}

func TestMissingFolderAndBinary(t *testing.T) {
	f := newFake(t)
	s := f.spawner()
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "c1", Cwd: filepath.Join(t.TempDir(), "gone")})
	if !errors.Is(err, agent.ErrFolderMissing) || a != nil {
		t.Fatalf("Spawn = %v, %v; want nil, ErrFolderMissing", a, err)
	}
	s2 := &Spawner{Bin: filepath.Join(t.TempDir(), "no-pi"), AppRoot: f.root, Home: f.dir}
	if _, err := s2.Spawn(agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()}); err == nil || !strings.Contains(err.Error(), "pi binary") {
		t.Fatalf("missing binary error %v", err)
	}
	if _, err := os.ReadFile(f.args); err == nil {
		t.Error("a process was started")
	}
}

func TestPermissionAlwaysApproved(t *testing.T) {
	f := newFake(t)
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	p := a.(*proc)

	// Every tool is approved at once — a subagent identity changes nothing — and no card is
	// emitted.
	sub := &agent.SubIdentity{Parent: "tool-9", Depth: 0, Child: "child-1"}
	allow, reason := p.Permission("call-1", "bash", json.RawMessage(`{"command":"ls"}`), sub)
	if !allow || reason != "" {
		t.Fatalf("Permission = %v, %q; want true with no reason", allow, reason)
	}

	// The app's own folder is still denied, also without a card.
	allow, reason = p.Permission("call-2", "bash", json.RawMessage(`{"command":"cat `+f.root+`/state.json"}`), nil)
	if allow || reason != agent.AppDirDenied {
		t.Fatalf("app-dir answer %v %q", allow, reason)
	}
	for _, ev := range drainEvents(p) {
		if ev.Kind == agent.EvPermRequest || ev.Kind == agent.EvToolDenied {
			t.Fatalf("permission handling produced an event: %+v", ev)
		}
	}

	// No asks are pending anymore, so every decision is unknown.
	if err := p.Decide("call-1", true); err == nil {
		t.Error("Decide on an unknown request did not fail")
	}

	f.stdinLines(t, a)
}

// fakeRegistry records the adapter's bridge lifecycle calls.
type fakeRegistry struct {
	mu      sync.Mutex
	regsV   []string
	deregsV []string
	abortsV []string
}

func (r *fakeRegistry) RegisterRun(chatID string, h agent.RunHandler) (string, string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.regsV = append(r.regsV, chatID)
	return "/tmp/pi.sock", "run-7", nil
}

func (r *fakeRegistry) DeregisterRun(token string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deregsV = append(r.deregsV, token)
}

func (r *fakeRegistry) AbortRun(token string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.abortsV = append(r.abortsV, token)
}

func (r *fakeRegistry) regs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.regsV...)
}
func (r *fakeRegistry) deregs() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.deregsV...)
}
func (r *fakeRegistry) aborts() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.abortsV...)
}

func TestCloseDeregistersAndAbortPushes(t *testing.T) {
	reg := &fakeRegistry{}
	f := newFake(t)
	s := f.spawner()
	s.Bridge = reg
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	if got := reg.regs(); !equalStrings(got, []string{"c1"}) {
		t.Fatalf("registered %q", got)
	}
	if err := a.Interrupt(); err != nil {
		t.Fatal(err)
	}
	if got := reg.aborts(); !equalStrings(got, []string{"run-7"}) {
		t.Fatalf("aborts %q", got)
	}
	a.Close()
	if got := reg.deregs(); len(got) == 0 || got[0] != "run-7" {
		t.Fatalf("deregs %q", got)
	}
}

func TestContextSplit(t *testing.T) {
	f := newFake(t)
	f.replies(t, map[string]fakeReply{
		"get_session_stats": {Data: json.RawMessage(`{"contextUsage":{"tokens":300,"contextWindow":1000}}`)},
	})
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	split, err := a.(*proc).ContextSplit()
	if err != nil {
		t.Fatal(err)
	}
	if split.Total != 300 || split.Window != 1000 || len(split.Categories) != 2 {
		t.Fatalf("split %+v", split)
	}
	if c := split.Categories[0]; c.ID != "messages" || c.Kind != "used" || c.Tokens != 300 {
		t.Errorf("messages category %+v", c)
	}
	if c := split.Categories[1]; c.ID != "free" || c.Kind != "free" || c.Tokens != 700 {
		t.Errorf("free category %+v", c)
	}
	f.stdinLines(t, a)
}

func TestContextSplitMissingUsage(t *testing.T) {
	f := newFake(t)
	f.replies(t, map[string]fakeReply{
		"get_session_stats": {Data: json.RawMessage(`{"contextUsage":{"tokens":null,"contextWindow":1000}}`)},
	})
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	if _, err := a.(*proc).ContextSplit(); err == nil || !strings.Contains(err.Error(), "context usage") {
		t.Fatalf("ContextSplit error %v, want a missing-usage error", err)
	}
	f.stdinLines(t, a)
}

func TestSendClearsIdleAbort(t *testing.T) {
	// The script only answers prompts, so the idle Interrupt does not itself produce a settle.
	t.Setenv(envPromptOnly, "1")
	f := newFake(t, `{"type":"agent_settled"}`)
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	if err := a.Interrupt(); err != nil {
		t.Fatal(err)
	}
	if err := a.Send([]agent.ContentBlock{{Text: "hi"}}); err != nil {
		t.Fatal(err)
	}
	if ev := waitKind(t, a, agent.EvTurnEnd); ev.Aborted {
		t.Fatalf("turn end %+v: a normal turn after an idle Interrupt was marked aborted", ev)
	}
	f.stdinLines(t, a)
}

func TestCloseReapsChildGroup(t *testing.T) {
	f := newFake(t)
	pidFile := filepath.Join(f.dir, "child.json")
	t.Setenv(envChildPid, pidFile)
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	parent, child := childPids(t, pidFile)
	if syscall.Kill(parent, 0) != nil || syscall.Kill(child, 0) != nil {
		t.Fatalf("fake pi %d or its child %d is not running before Close", parent, child)
	}
	a.Close()
	if ev := waitKind(t, a, agent.EvExit); ev.Kind != agent.EvExit {
		t.Fatalf("event %+v, want EvExit", ev)
	}
	waitPidsGone(t, parent, child)
}

func TestCloseReapsGroupWhenLeaderHoldsStdin(t *testing.T) {
	old := killGrace()
	killGraceNanos.Store(int64(150 * time.Millisecond))
	t.Cleanup(func() { killGraceNanos.Store(int64(old)) })

	f := newFake(t)
	pidFile := filepath.Join(f.dir, "child.json")
	t.Setenv(envChildPid, pidFile)
	t.Setenv(envHold, "1")
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	parent, child := childPids(t, pidFile)
	a.Close()
	if ev := waitKind(t, a, agent.EvExit); ev.Kind != agent.EvExit {
		t.Fatalf("event %+v, want EvExit", ev)
	}
	waitPidsGone(t, parent, child)
}

func TestPlainChatRegistersRun(t *testing.T) {
	reg := &fakeRegistry{}
	f := newFake(t)
	s := f.spawner()
	s.Bridge = reg
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	if got := reg.regs(); !equalStrings(got, []string{"c1"}) {
		t.Fatalf("registered %q, want the chat id only", got)
	}
	f.stdinLines(t, a)
}

func TestBootCatalog(t *testing.T) {
	f := newFake(t)
	f.replies(t, map[string]fakeReply{
		"get_state":            {Data: json.RawMessage(`{"sessionId":"probe","model":{"provider":"deepseek","id":"flash"}}`)},
		"get_available_models": {Data: json.RawMessage(`{"models":[{"id":"flash","name":"Flash","provider":"deepseek","reasoning":true,"contextWindow":1000000},{"id":"plain","provider":"other","reasoning":false,"contextWindow":8000}]}`)},
	})
	s := f.spawner()
	cat, err := s.Catalog(5 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Models) != 2 || cat.Models[0].ID != "deepseek/flash" || cat.Models[1].ID != "other/plain" {
		t.Fatalf("catalog %+v", cat.Models)
	}
	if cat.Models[0].Provider != "deepseek" || cat.Models[1].Provider != "other" {
		t.Errorf("providers %q, %q", cat.Models[0].Provider, cat.Models[1].Provider)
	}
	if cat.Default.Model != "deepseek/flash" {
		t.Errorf("default %+v, want the state model", cat.Default)
	}
	inv := f.invocation(t)
	for _, want := range []string{"--mode", "rpc", "--no-session", "--no-extensions"} {
		if !contains(inv.Args, want) {
			t.Errorf("probe args %q missing %q", inv.Args, want)
		}
	}
	if contains(inv.Args, "-e") {
		t.Errorf("probe loaded an extension: %q", inv.Args)
	}
	if inv.ChatID != "" || inv.BridgeRun != "" {
		t.Errorf("probe got run env: %+v", inv)
	}
}

func TestBootCatalogErrorIncludesStderr(t *testing.T) {
	f := newFake(t)
	t.Setenv(envStderr, "no authenticated models")
	f.replies(t, map[string]fakeReply{"get_state": {Fail: true, Error: "boom"}})
	if _, err := f.spawner().Catalog(5 * time.Second); err == nil || !strings.Contains(err.Error(), "no authenticated models") {
		t.Fatalf("Catalog error %v, want the stderr tail", err)
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
