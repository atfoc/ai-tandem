package pi

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/chats"
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

// A handshake that pi answered with a failure leaves pi running, so no turn would ever end. Send
// ends the turn itself, with the error it returns, and closes the process: its exit follows and
// says nothing more.
func TestFailedHandshakeEndsTurn(t *testing.T) {
	f := newFake(t)
	f.replies(t, map[string]fakeReply{"set_model": {Fail: true, Error: "Model not found: gone/model"}})
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir(), Model: "gone/model"})
	err := a.Send([]agent.ContentBlock{{Text: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "Model not found: gone/model") {
		t.Fatalf("Send = %v, want the handshake error", err)
	}
	if ev := next(t, a); ev.Kind != agent.EvTurnEnd || ev.Error != err.Error() || ev.Aborted {
		t.Fatalf("event %+v, want a turn end with the error Send returned", ev)
	}
	if ev := next(t, a); ev.Kind != agent.EvExit || ev.ExitErr != "" {
		t.Fatalf("event %+v, want the exit of the closed process with no error text", ev)
	}
	if _, ok := <-a.Events(); ok {
		t.Error("events not closed after EvExit")
	}
	if got := commandTypes(f.recorded(t)); contains(got, "prompt") {
		t.Fatalf("commands %q, want no prompt", got)
	}
}

// A prompt pi does not answer in time ends the turn the same way.
func TestUnansweredPromptEndsTurn(t *testing.T) {
	f := newFake(t)
	f.replies(t, map[string]fakeReply{"prompt": {Silent: true}})
	s := f.spawner()
	s.promptTimeout = 200 * time.Millisecond
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	err := a.Send([]agent.ContentBlock{{Text: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "did not answer prompt") {
		t.Fatalf("Send = %v, want the timeout", err)
	}
	if ev := next(t, a); ev.Kind != agent.EvThinking {
		t.Fatalf("event %+v, want EvThinking", ev)
	}
	if ev := next(t, a); ev.Kind != agent.EvTurnEnd || ev.Error != err.Error() {
		t.Fatalf("event %+v, want a turn end with the error Send returned", ev)
	}
	if ev := next(t, a); ev.Kind != agent.EvExit || ev.ExitErr != "" {
		t.Fatalf("event %+v, want the exit of the closed process with no error text", ev)
	}
}

// A prompt pi runs to its settle without answering the command in time was taken: Send returns
// nil, the turn's one end is pi's own, and the process stays for the next message.
func TestSettledPromptWithLateAnswerIsTaken(t *testing.T) {
	t.Setenv(envEvery, "1")
	f := newFake(t, `{"type":"agent_settled"}`)
	f.replies(t, map[string]fakeReply{"prompt#1": {Silent: true}})
	s := f.spawner()
	s.promptTimeout = time.Second
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	if err := a.Send([]agent.ContentBlock{{Text: "one"}}); err != nil {
		t.Errorf("Send = %v, want nil: pi ran the turn", err)
	}
	if ev := waitKind(t, a, agent.EvTurnEnd); ev.Error != "" {
		t.Errorf("turn end %+v, want pi's own with no error", ev)
	}
	if a.(*proc).closing.Load() {
		t.Error("the process was closed")
	}
	// The second prompt is answered: it reaches the same process, and its turn ends once too.
	if err := a.Send([]agent.ContentBlock{{Text: "two"}}); err != nil {
		t.Fatalf("second Send = %v", err)
	}
	if ev := waitKind(t, a, agent.EvTurnEnd); ev.Error != "" {
		t.Errorf("second turn end %+v, want no error", ev)
	}
	a.Close()
	for ev := next(t, a); ev.Kind != agent.EvExit; ev = next(t, a) {
		if ev.Kind == agent.EvTurnEnd {
			t.Errorf("a third turn end for two Sends: %+v", ev)
		}
	}
	var prompts []string
	for _, l := range f.recorded(t) {
		if l["type"] == "prompt" {
			prompts = append(prompts, str(l["message"]))
		}
	}
	if !equalStrings(prompts, []string{"one", "two"}) {
		t.Errorf("prompts %q, want both written to the one process", prompts)
	}
}

// A settle that reaches the adapter after Send ended the turn itself (the fake prints it when its
// stdin closes, as a pi that is being closed can) adds no second turn end.
func TestSettleAfterSendFailedEmitsNothing(t *testing.T) {
	t.Setenv(envAtEOF, "1")
	f := newFake(t, `{"type":"agent_settled"}`)
	f.replies(t, map[string]fakeReply{"prompt": {Silent: true}})
	s := f.spawner()
	s.promptTimeout = 200 * time.Millisecond
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	err := a.Send([]agent.ContentBlock{{Text: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "did not answer prompt") {
		t.Fatalf("Send = %v, want the timeout", err)
	}
	var ends []agent.Event
	ev := next(t, a)
	for ; ev.Kind != agent.EvExit; ev = next(t, a) {
		if ev.Kind == agent.EvTurnEnd {
			ends = append(ends, ev)
		}
	}
	if len(ends) != 1 || ends[0].Error != err.Error() {
		t.Fatalf("turn ends %s, want one, with the error Send returned", dump(ends))
	}
	if ev.ExitErr != "" {
		t.Errorf("exit text %q, want none for the closed process", ev.ExitErr)
	}
}

// When pi has exited by itself, its exit is the one end of the turn and carries what pi said on
// stderr: Send adds no turn end of its own.
func TestSendToExitedProcessLeavesTheExit(t *testing.T) {
	f := newFake(t)
	t.Setenv(envExit, "1")
	t.Setenv(envStderr, "No API key found for test")
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	if err := a.Send([]agent.ContentBlock{{Text: "hi"}}); err == nil {
		t.Fatal("Send to an exited process succeeded")
	}
	if ev := next(t, a); ev.Kind != agent.EvExit || ev.ExitErr != "No API key found for test" {
		t.Fatalf("event %+v, want only EvExit with pi's stderr", ev)
	}
	if _, ok := <-a.Events(); ok {
		t.Error("events not closed after EvExit")
	}
}

// Through the chat manager, which marks the chat busy before the adapter's Send: a handshake that
// failed with pi still running must leave the chat ready, with the error as its one note, and the
// next message must be taken.
func TestFailedHandshakeLeavesChatReady(t *testing.T) {
	for name, tc := range map[string]struct {
		replies map[string]fakeReply
		model   string
		want    string
	}{
		"model no longer offered": {map[string]fakeReply{"set_model": {Fail: true, Error: "Model not found: gone/model"}},
			"gone/model", "Model not found: gone/model"},
		"no models": {map[string]fakeReply{"get_available_models": {Data: json.RawMessage(`{"models":[]}`)}},
			"", "pi reported no models"},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			f.replies(t, tc.replies)
			m := newE2EPiManager(t, f.spawner(), t.TempDir())
			v := e2eCreatePi(t, m)
			if tc.model != "" {
				if err := m.Configure(v.ID, chats.ConfigReq{Model: tc.model}); err != nil {
					t.Fatal(err)
				}
			}
			// settle waits for the chat to stop being busy and returns its error notes.
			settle := func() []string {
				t.Helper()
				for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(20 * time.Millisecond) {
					cv, err := m.View(v.ID)
					if err != nil {
						t.Fatal(err)
					}
					if !e2eBusy(cv.Status) {
						break
					}
					if time.Now().After(deadline) {
						t.Fatalf("the chat is still %s: no turn runs and none will end", cv.Status)
					}
				}
				_, items, _, err := m.Items(v.ID)
				if err != nil {
					t.Fatal(err)
				}
				var notes []string
				for _, it := range items {
					if it.Kind == "note" && it.Tone == "error" {
						notes = append(notes, it.Text)
					}
				}
				return notes
			}
			if err := m.Send(v.ID, "hello", "", nil); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Send = %v, want the handshake error", err)
			}
			if notes := settle(); len(notes) != 1 || !strings.Contains(notes[0], tc.want) {
				t.Fatalf("error notes %q, want the handshake error once", notes)
			}
			if err := m.Send(v.ID, "again", "", nil); errors.Is(err, chats.ErrBusy) {
				t.Fatal("the next message is refused: the chat is busy")
			}
			if notes := settle(); len(notes) != 2 {
				t.Fatalf("error notes %q, want one for each failed message", notes)
			}
		})
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
	if inv.MCPConfig != "" || inv.MCPFile != "" {
		t.Errorf("board chat without MCP access got AIWB_MCP_CONFIG %q, AIWB_MCP_CONFIG_FILE %q", inv.MCPConfig, inv.MCPFile)
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
	// Contract (D16): the board token is only in the file AIWB_MCP_CONFIG_FILE names, which only
	// the user can read: never in the child env, and never in argv.
	raw := inv.mcpFileConfig(t, filepath.Join(f.root, "chats", "c1", "mcp.json"), boardToken)
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("mcp.json %q is not JSON: %v", raw, err)
	}
	if len(cfg.MCPServers) != 1 {
		t.Fatalf("MCP servers %+v, want only the board server", cfg.MCPServers)
	}
	srv, ok := cfg.MCPServers["board"]
	if !ok || srv.Type != "http" || srv.URL != "http://localhost:6006/mcp" ||
		srv.Headers["Authorization"] != "Bearer "+boardToken {
		t.Fatalf("board server %+v, want the fixed URL and the bearer header", srv)
	}
	f.stdinLines(t, a)
}

// TestSpawnBoardChatMCPConfigExtraSeam pins the test-only A6 seam: extra non-board servers are
// merged into the board chat's MCP config file while the app-owned "board" key can never be
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
	raw := inv.mcpFileConfig(t, filepath.Join(f.root, "chats", "c1", "mcp.json"), boardToken)
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatalf("mcp.json %q is not JSON: %v", raw, err)
	}
	if got := cfg.MCPServers["board"].URL; got != "http://localhost:6006/mcp" {
		t.Fatalf("board server URL = %q, want the fixed app URL", got)
	}
	if got := cfg.MCPServers["other"]; got.Type != "http" || got.URL != "http://127.0.0.1:1/mcp/other" {
		t.Fatalf("extra server = %+v, want the merged test-only entry", got)
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
	if inv.MCPConfig != "" || inv.MCPFile != "" {
		t.Fatalf("MCP unset got AIWB_MCP_CONFIG %q, AIWB_MCP_CONFIG_FILE %q", inv.MCPConfig, inv.MCPFile)
	}
	if _, err := os.Stat(filepath.Join(f.root, "chats", "c1", "mcp.json")); err == nil {
		t.Fatal("MCP unset: an MCP config file was written")
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
	if got := inv.mcpFileConfig(t, filepath.Join(f.root, "chats", "c1", "mcp.json"), tok); got != want {
		t.Fatalf("MCP set: mcp.json = %q\nwant %q", got, want)
	}
	f.stdinLines(t, a)
}

// An app-spawned subagent has its own folder (SpawnOptions.Dir) and its own token: its config file
// is in that folder, and the parent's file is not touched.
func TestSpawnSubagentMCPConfigInItsOwnFolder(t *testing.T) {
	const parentTok, subTok = "parent-mcp-token", "subagent-mcp-token"
	f := newFake(t)
	s := f.spawner()
	s.Bridge = &fakeRegistry{}
	parentDir := filepath.Join(f.root, "chats", "c1")
	parent := agent.SpawnOptions{ChatID: "c1", Dir: parentDir, Cwd: t.TempDir(),
		MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: parentTok}}
	if ok, err := s.writeMCPConfig(parent); err != nil || !ok {
		t.Fatalf("the parent's config file: %v, %v", ok, err)
	}

	subDir := filepath.Join(parentDir, "subagents", "s1")
	a := spawn(t, s, agent.SpawnOptions{ChatID: "c1", Dir: subDir, Cwd: t.TempDir(), Subagent: true,
		MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: subTok}})
	waitKind(t, a, agent.EvCatalog)
	inv := f.invocation(t)
	if got := inv.mcpFileConfig(t, filepath.Join(subDir, "mcp.json"), subTok); !strings.Contains(got, "Bearer "+subTok) {
		t.Fatalf("the subagent's mcp.json = %q", got)
	}
	assertNoToken(t, parentTok, inv.Args, inv.Env)
	if got := readMCPFile(t, filepath.Join(parentDir, "mcp.json")); !strings.Contains(got, "Bearer "+parentTok) {
		t.Fatalf("the parent's mcp.json after the subagent's start = %q", got)
	}
}

// A process whose config file cannot be written is not started: it would run without its tools, or
// the token would have to travel another way.
func TestSpawnRefusesWhenMCPConfigCannotBeWritten(t *testing.T) {
	reg := &fakeRegistry{}
	f := newFake(t)
	s := f.spawner()
	s.Bridge = reg
	dir := filepath.Join(f.root, "chats", "c1")
	// mcp.json is a folder that is not empty: the rename onto it fails.
	if err := os.MkdirAll(filepath.Join(dir, "mcp.json", "x"), 0o700); err != nil {
		t.Fatal(err)
	}
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir(),
		MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "tok"}})
	if err == nil {
		a.Close()
		t.Fatal("Spawn started a process without its MCP config file")
	}
	if !strings.Contains(err.Error(), "pi mcp config") {
		t.Errorf("error %q, want it to name the MCP config", err)
	}
	if _, statErr := os.Stat(f.args); statErr == nil {
		t.Error("a pi process was started")
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "mcp-*.tmp")); len(left) != 0 {
		t.Errorf("temp files left: %q", left)
	}
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

// piStartWarning is what real pi prints on stderr whenever it starts a chat with a new session id.
const piStartWarning = "Warning: No project session found with id 'x'; creating a new session with that id."

// An exit the app asked for is no failure: what pi printed while it ran is not its reason.
func TestExitAskedForHasNoText(t *testing.T) {
	f := newFake(t)
	t.Setenv(envStartErr, piStartWarning)
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	a.Close()
	if ev := waitKind(t, a, agent.EvExit); ev.ExitErr != "" {
		t.Fatalf("exit text %q, want none for an exit the app asked for", ev.ExitErr)
	}
}

// An exit pi made by itself reports the end of its stderr, where the reason is, however much it
// printed before.
func TestExitTextIsStderrEnd(t *testing.T) {
	var noise strings.Builder
	for i := 0; noise.Len() <= stderrCap; i++ {
		fmt.Fprintf(&noise, "debug line %d\n", i)
	}
	for name, start := range map[string]string{
		"after the start warning": piStartWarning,
		"after more than the cap": noise.String(),
	} {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			t.Setenv(envStartErr, start)
			t.Setenv(envExit, "1")
			t.Setenv(envStderr, "Error: the session file is corrupt")
			a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
			ev := next(t, a)
			if ev.Kind != agent.EvExit || !strings.HasSuffix(ev.ExitErr, "Error: the session file is corrupt") {
				t.Fatalf("event kind %v with exit text %.200q, want EvExit ending with pi's last stderr line", ev.Kind, ev.ExitErr)
			}
			if n := strings.Count(ev.ExitErr, "\n") + 1; n > exitLines {
				t.Fatalf("exit text has %d lines, want at most %d", n, exitLines)
			}
		})
	}
}

// A signal ends pi before it can say why, so the exit names the signal ahead of what stderr has.
func TestExitTextNamesSignal(t *testing.T) {
	f := newFake(t)
	t.Setenv(envStartErr, piStartWarning)
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	pid := a.(*proc).cmd.Process.Pid
	if pid <= 1 {
		t.Fatalf("fake pi pid %d", pid)
	}
	syscall.Kill(pid, syscall.SIGKILL)
	if ev := waitKind(t, a, agent.EvExit); ev.ExitErr != "signal: killed: "+piStartWarning {
		t.Fatalf("exit text %q, want the signal ahead of stderr", ev.ExitErr)
	}
}

// What the thread of a chat shows when its pi ends during a turn: no text of pi's when the app
// closed it, the reason when pi ended by itself.
func TestExitDuringTurnNote(t *testing.T) {
	for name, tc := range map[string]struct {
		end  func(m *chats.Manager, pid int)
		want string
	}{
		"the app closes pi": {func(m *chats.Manager, pid int) { m.Shutdown() }, "The agent stopped: process ended"},
		"pi is killed": {func(m *chats.Manager, pid int) { syscall.Kill(pid, syscall.SIGKILL) },
			"The agent stopped: signal: killed: " + piStartWarning},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFake(t)
			pidFile := filepath.Join(f.dir, "child.json")
			t.Setenv(envChildPid, pidFile)
			t.Setenv(envStartErr, piStartWarning)
			m := newE2EPiManager(t, f.spawner(), t.TempDir())
			v := e2eCreatePi(t, m)
			if err := m.Send(v.ID, "hello", "", nil); err != nil {
				t.Fatal(err)
			}
			pid, child := childPids(t, pidFile)
			tc.end(m, pid)
			var notes []string
			for deadline := time.Now().Add(5 * time.Second); len(notes) == 0; time.Sleep(20 * time.Millisecond) {
				_, items, _, err := m.Items(v.ID)
				if err != nil {
					t.Fatal(err)
				}
				for _, it := range items {
					if it.Kind == "note" {
						notes = append(notes, it.Text)
					}
				}
				if time.Now().After(deadline) {
					t.Fatal("no note in the thread: the turn did not end")
				}
			}
			if len(notes) != 1 || notes[0] != tc.want {
				t.Fatalf("notes %q, want only %q", notes, tc.want)
			}
			if cv, err := m.View(v.ID); err != nil || e2eBusy(cv.Status) {
				t.Fatalf("chat status %q, %v: the turn did not end", cv.Status, err)
			}
			waitPidsGone(t, pid, child)
		})
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

// TestTurnEndPoint: after every agent_settled the adapter asks for the stats and the fork
// messages, and the turn end carries the last user message's entry id, or none when the turn
// added no user message or the request failed.
func TestTurnEndPoint(t *testing.T) {
	t.Setenv(envEvery, "1")
	f := newFake(t, `{"type":"agent_settled"}`)
	f.replies(t, map[string]fakeReply{
		"get_fork_messages":   {Data: json.RawMessage(`{"messages":[{"entryId":"0efdb07e","text":"one"},{"entryId":"b85ebc6a","text":"two"}]}`)},
		"get_fork_messages#3": {Fail: true, Error: "nope"},
		"get_fork_messages#4": {Data: json.RawMessage(`{"messages":[]}`)},
		"get_fork_messages#5": {Data: json.RawMessage(`{"messages":[{"entryId":"0efdb07e","text":"one"},{"entryId":"b85ebc6a","text":"two"},{"entryId":"59b265f9","text":"three"}]}`)},
	})
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	for i, want := range []string{"b85ebc6a", "", "", "", "59b265f9"} {
		if err := a.Send([]agent.ContentBlock{{Text: "hi"}}); err != nil {
			t.Fatal(err)
		}
		if ev := next(t, a); ev.Kind != agent.EvThinking {
			t.Fatalf("turn %d: event %+v, want EvThinking", i+1, ev)
		}
		if ev := next(t, a); ev.Kind != agent.EvUsage || ev.CtxIn != 300 {
			t.Fatalf("turn %d: event %+v, want the usage before the turn end", i+1, ev)
		}
		if ev := next(t, a); ev.Kind != agent.EvTurnEnd || ev.Point != want || ev.Aborted || ev.Error != "" {
			t.Fatalf("turn %d: event %+v, want one turn end with Point %q", i+1, ev, want)
		}
	}
	turn := []string{"prompt", "get_session_stats", "get_fork_messages"}
	want := []string{"get_state", "get_available_models"}
	for i := 0; i < 5; i++ {
		want = append(want, turn...)
	}
	if got := commandTypes(f.stdinLines(t, a)); !equalStrings(got, want) {
		t.Fatalf("commands %q\nwant %q", got, want)
	}
}

// A turn the user stopped keeps Aborted and gets its fork-point id like any other.
func TestAbortedTurnEndPoint(t *testing.T) {
	f := newFake(t, `{"type":"agent_settled"}`)
	f.replies(t, map[string]fakeReply{
		"get_fork_messages": {Data: json.RawMessage(`{"messages":[{"entryId":"0efdb07e","text":"one"}]}`)},
	})
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	if err := a.Interrupt(); err != nil {
		t.Fatal(err)
	}
	if ev := waitKind(t, a, agent.EvTurnEnd); !ev.Aborted || ev.Point != "0efdb07e" {
		t.Fatalf("turn end %+v, want aborted with the point", ev)
	}
	f.stdinLines(t, a)
}

// A prompt pi rejected ends the turn with the error and no point, and asks pi nothing.
func TestRejectedPromptHasNoPoint(t *testing.T) {
	t.Setenv(envPromptOnly, "1")
	f := newFake(t)
	f.replies(t, map[string]fakeReply{"prompt": {Fail: true, Error: "busy"}})
	a := spawn(t, f.spawner(), agent.SpawnOptions{ChatID: "c1", Cwd: t.TempDir()})
	waitKind(t, a, agent.EvCatalog)
	if err := a.Send([]agent.ContentBlock{{Text: "hi"}}); err == nil || !strings.Contains(err.Error(), "busy") {
		t.Fatalf("Send = %v, want the rejection", err)
	}
	if ev := waitKind(t, a, agent.EvTurnEnd); ev.Point != "" || !strings.Contains(ev.Error, "busy") {
		t.Fatalf("turn end %+v, want the error and no point", ev)
	}
	if got := commandTypes(f.stdinLines(t, a)); !equalStrings(got, []string{"get_state", "get_available_models", "prompt"}) {
		t.Fatalf("commands %q", got)
	}
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
