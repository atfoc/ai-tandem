package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

func TestSteerWithoutTurnIsDefinitelyUnavailable(t *testing.T) {
	p := &proc{}
	if err := p.Steer("s1", []agent.ContentBlock{{Text: "hello"}}); !errors.Is(err, agent.ErrSteerUnavailable) {
		t.Fatalf("Steer = %v", err)
	}
}

func TestMain(m *testing.M) {
	if os.Getenv("AIWB_TEST_CODEX_SERVER") == "1" && len(os.Args) == 2 && os.Args[1] == "app-server" {
		os.Exit(fakeServer())
	}
	os.Exit(m.Run())
}

// Exercise the real stdio protocol and adapter together. An approval arrives
// before the turn/start response, as can happen with unsolicited server messages.
func TestTurnApprovalAndFork(t *testing.T) {
	t.Setenv("AIWB_TEST_CODEX_SERVER", "1")
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	s := &Spawner{Bin: bin, AppRoot: t.TempDir(), Prompt: "Use the board."}
	o := agent.SpawnOptions{
		Cwd: t.TempDir(), BoardID: "test-board", Model: "test-model", Effort: "low",
		MCP: &agent.BoardAccess{MCPURL: "http://127.0.0.1:6006/mcp", Token: "test-token"},
	}
	a, err := s.Spawn(o)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	if ev := nextEvent(t, a, agent.EvSession); ev.SessionID != "thread-original" {
		t.Fatalf("session = %q", ev.SessionID)
	}

	sent := make(chan error, 1)
	go func() {
		sent <- a.Send([]agent.ContentBlock{
			{Text: "edit this"}, {Image: &agent.Image{Type: "image/png", Data: []byte{1, 2, 3}}},
		})
	}()
	tool := nextEvent(t, a, agent.EvToolStart)
	if tool.ToolName != "Bash" || !strings.Contains(string(tool.Input), "printf hello") {
		t.Fatalf("tool = %+v", tool)
	}
	req := nextEvent(t, a, agent.EvPermRequest)
	if req.ToolID != tool.ToolID || !strings.Contains(string(req.Input), "printf hello") {
		t.Fatalf("approval = %+v", req)
	}
	if err := a.(agent.Steerer).Steer("steer-1", []agent.ContentBlock{{Text: "change direction"}}); err != nil {
		t.Fatalf("steer: %v", err)
	}
	if ev := nextEvent(t, a, agent.EvSteerConsumed); ev.MsgID != "steer-1" {
		t.Fatalf("steer receipt = %+v", ev)
	}
	if err := a.Decide(req.PermID, true); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-sent:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("turn/start did not return")
	}
	if ev := nextEvent(t, a, agent.EvToolResult); ev.Result != "hello" || ev.IsError {
		t.Fatalf("tool result = %+v", ev)
	}
	for _, decision := range []struct {
		allow, session bool
	}{{true, true}, {false, true}, {true, false}} {
		req := nextEvent(t, a, agent.EvPermRequest)
		var input struct{ Description string }
		if req.ToolName != "mcp__board__spawn_subagent" ||
			json.Unmarshal(req.Input, &input) != nil ||
			!strings.Contains(input.Description, "Allow the board MCP server") ||
			!strings.Contains(input.Description, `"git":true`) ||
			strings.Contains(input.Description, "future subagent spawns") != decision.session {
			t.Fatalf("Git worker spawn approval = %+v, description = %q", req, input.Description)
		}
		if err := a.Decide(req.PermID, decision.allow); err != nil {
			t.Fatal(err)
		}
	}
	if ev := nextEvent(t, a, agent.EvToolStart); ev.ToolName != "mcp__board__read_board" {
		t.Fatalf("board tool = %+v", ev)
	}
	if ev := nextEvent(t, a, agent.EvToolResult); ev.Result != "board contents" || ev.IsError {
		t.Fatalf("board result = %+v", ev)
	}
	if ev := nextEvent(t, a, agent.EvTextDelta); ev.Text != "Done" {
		t.Fatalf("text = %+v", ev)
	}
	if ev := nextEvent(t, a, agent.EvUsage); ev.CtxIn != 80 || ev.CtxOut != 20 || ev.CtxWindow != 1024 {
		t.Fatalf("usage = %+v", ev)
	}
	point := nextEvent(t, a, agent.EvTurnEnd)
	if point.Point != "turn-1" || point.Aborted || point.Error != "" {
		t.Fatalf("turn end = %+v", point)
	}
	a.Close()
	nextEvent(t, a, agent.EvExit)

	o.SessionID, o.Resume = "thread-original", true
	resumed, err := s.Spawn(o)
	if err != nil {
		t.Fatal(err)
	}
	defer resumed.Close()
	if ev := nextEvent(t, resumed, agent.EvSession); ev.SessionID != o.SessionID {
		t.Fatalf("resumed session = %q", ev.SessionID)
	}
	if ev := nextEvent(t, resumed, agent.EvUsage); ev.CtxIn != 80 || ev.CtxWindow != 1024 {
		t.Fatalf("resumed usage = %+v", ev)
	}
	fork, id, err := s.SpawnFork(o, agent.ForkSource{SessionID: o.SessionID, Point: point.Point})
	if err != nil {
		t.Fatal(err)
	}
	defer fork.Close()
	if id != "thread-fork" {
		t.Fatalf("fork session = %q", id)
	}
}

func TestTaggedProviderFailureEndsTurn(t *testing.T) {
	p := &proc{
		conn: &rpcConn{ctx: context.Background()}, threadID: "thread",
		events: make(chan agent.Event, 1), active: &activeTurn{id: "turn"},
	}
	p.onNotification("turn/completed", json.RawMessage(`{
		"threadId":"thread",
		"turn":{"id":"turn","status":"failed","error":{
			"message":"stream disconnected",
			"codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":503}}
		}}
	}`))
	if ev := nextEvent(t, p, agent.EvTurnEnd); ev.Point != "turn" || ev.Error != "stream disconnected" || ev.Temporary != agent.TempServer {
		t.Fatalf("turn end = %+v", ev)
	}
	if p.active != nil {
		t.Fatal("failed turn is still active")
	}
}

// Codex rebuilds its config when it sets up a model request; a config that defines the profile but
// names no default fails there ("failed to load workspace requirements: invalid input parameter"),
// after thread/start has already succeeded. The profile must be defined, selected and the default.
func TestThreadParamsDefineSelectAndDefaultTheProfile(t *testing.T) {
	s := &Spawner{AppRoot: "/data/store"}
	params := s.threadParams(agent.SpawnOptions{Cwd: "/work"})
	config := params["config"].(map[string]any)
	if params["permissions"] != permissionProfile || config["default_permissions"] != permissionProfile {
		t.Fatalf("selected %v, default %v, want %q for both", params["permissions"], config["default_permissions"], permissionProfile)
	}
	profile := config["permissions"].(map[string]any)[permissionProfile].(map[string]any)
	if profile["extends"] != ":workspace" || profile["filesystem"].(map[string]string)["/data/store"] != "deny" {
		t.Fatalf("profile = %v, want the workspace denying the app root", profile)
	}
	if _, ok := params["sandbox"]; ok {
		t.Fatal("a named profile cannot be combined with sandbox")
	}

	plain := (&Spawner{}).threadParams(agent.SpawnOptions{Cwd: "/work"})
	pc := plain["config"].(map[string]any)
	if _, ok := pc["default_permissions"]; ok || plain["sandbox"] != "workspace-write" {
		t.Fatalf("without an app root: config %v, sandbox %v", pc, plain["sandbox"])
	}
}

func TestGitWorkerThreadParams(t *testing.T) {
	s := &Spawner{AppRoot: "/data/store"}
	binding := model.GitWorkspace{
		Path: "/data/store-workers/codex-1", SourceRoot: "/src/worktree",
		SourceGitDir: "/src/project/.git/worktrees/worktree", SourceCommonDir: "/src/project/.git",
	}
	params := s.threadParams(agent.SpawnOptions{Cwd: binding.Path, GitWorkspace: binding, Subagent: true})
	config := params["config"].(map[string]any)
	profile := config["permissions"].(map[string]any)[gitWorkerProfile].(map[string]any)
	want := map[string]string{
		s.AppRoot: "deny", binding.SourceRoot: "read", binding.SourceGitDir: "deny",
		binding.SourceCommonDir: "deny", filepath.Join(binding.SourceRoot, ".git"): "deny",
		filepath.Join(binding.Path, ".git"): "write",
	}
	if profile["extends"] != ":workspace" || len(profile) != 2 || !maps.Equal(profile["filesystem"].(map[string]string), want) {
		t.Fatalf("unexpected Git worker profile: %+v", profile)
	}
	if params["permissions"] != gitWorkerProfile || config["default_permissions"] != gitWorkerProfile {
		t.Fatalf("Git worker profile must be active and default: %+v", params)
	}
	if params["cwd"] != binding.Path || !slices.Equal(params["runtimeWorkspaceRoots"].([]string), []string{binding.Path}) {
		t.Fatalf("Git worker cwd and runtime roots must use the clone: %+v", params)
	}
}

func TestTurnErrorKeepsCodexAdditionalDetails(t *testing.T) {
	p := &proc{
		conn: &rpcConn{ctx: context.Background()}, threadID: "thread",
		events: make(chan agent.Event, 1), active: &activeTurn{id: "turn"},
	}
	p.onNotification("turn/completed", json.RawMessage(`{
		"threadId":"thread",
		"turn":{"id":"turn","status":"failed","error":{
			"message":"stream disconnected before completion",
			"additionalDetails":"unexpected status 403 Forbidden, url: wss://example.test/responses",
			"codexErrorInfo":"other"
		}}
	}`))
	want := "stream disconnected before completion: unexpected status 403 Forbidden, url: wss://example.test/responses"
	if ev := nextEvent(t, p, agent.EvTurnEnd); ev.Error != want {
		t.Fatalf("error = %q, want %q", ev.Error, want)
	}
	for _, c := range []struct{ message, details, want string }{
		{"failed", "", "failed"},
		{"failed", "  ", "failed"},
		{"failed: disk full", "disk full", "failed: disk full"},
	} {
		if got := turnErrorText(c.message, c.details); got != c.want {
			t.Fatalf("turnErrorText(%q, %q) = %q, want %q", c.message, c.details, got, c.want)
		}
	}
}

func nextEvent(t *testing.T, a agent.Agent, kind agent.EventKind) agent.Event {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case e, ok := <-a.Events():
			if !ok || e.Kind == agent.EvExit && kind != agent.EvExit {
				t.Fatalf("Codex exited waiting for event %d: %s", kind, e.ExitErr)
			}
			if e.Kind == kind {
				return e
			}
		case <-timer.C:
			t.Fatalf("no event of kind %d", kind)
		}
	}
}

func fakeServer() int {
	in := bufio.NewScanner(os.Stdin)
	var startID json.RawMessage
	send := func(v any) { _ = json.NewEncoder(os.Stdout).Encode(v) }
	frame := func(method, params string) {
		fmt.Fprintf(os.Stdout, "{\"method\":%q,\"params\":%s}\n", method, params)
	}
	mcpApproval := func(id, persist string) {
		send(map[string]any{
			"id": id, "method": "mcpServer/elicitation/request",
			"params": json.RawMessage(fmt.Sprintf(`{
				"threadId":"thread-original","turnId":null,"serverName":"board",
				"mode":"form","message":"Allow the board MCP server to run tool \"spawn_subagent\"?",
				"requestedSchema":{"type":"object","properties":{}},
				"_meta":{"codex_approval_kind":"mcp_tool_call","tool_name":"spawn_subagent","persist":%s,
					"tool_params":{"agent":"codex","git":true,"prompt":"Make a commit"}}
			}`, persist)),
		})
	}
	for in.Scan() {
		var m rpcMessage
		if json.Unmarshal(in.Bytes(), &m) != nil {
			return 1
		}
		reply := func(result string) {
			send(map[string]any{"id": m.ID, "result": json.RawMessage(result)})
		}
		switch m.Method {
		case "initialize":
			reply("{}")
		case "initialized":
		case "thread/start", "thread/resume", "thread/fork":
			var opts struct {
				ThreadID, LastTurnID, Permissions, ApprovalPolicy, DeveloperInstructions string
				Config                                                                   map[string]json.RawMessage
			}
			if json.Unmarshal(m.Params, &opts) != nil ||
				opts.Permissions != "tandem" || opts.ApprovalPolicy != "on-request" ||
				opts.DeveloperInstructions != "Use the board." ||
				!strings.Contains(string(opts.Config["mcp_servers.board"]), "Bearer test-token") ||
				string(opts.Config["features.multi_agent"]) != "false" ||
				string(opts.Config["default_permissions"]) != `"tandem"` {
				return 2
			}
			switch m.Method {
			case "thread/start":
				reply(`{"thread":{"id":"thread-original"},"activePermissionProfile":{"id":"tandem"}}`)
			case "thread/resume":
				if opts.ThreadID != "thread-original" {
					return 3
				}
				frame("thread/tokenUsage/updated", `{"threadId":"thread-original","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":80,"outputTokens":20},"modelContextWindow":1024}}`)
				reply(`{"thread":{"id":"thread-original"},"activePermissionProfile":{"id":"tandem"}}`)
			case "thread/fork":
				if opts.ThreadID != "thread-original" || opts.LastTurnID != "turn-1" {
					return 4
				}
				reply(`{"thread":{"id":"thread-fork"},"activePermissionProfile":{"id":"tandem"}}`)
			}
		case "thread/name/set":
			reply("{}")
		case "turn/start":
			if !strings.Contains(string(m.Params), "data:image/png;base64,AQID") {
				return 5
			}
			startID = m.ID
			frame("turn/started", `{"threadId":"thread-original","turn":{"id":"turn-1"}}`)
			frame("item/started", `{"threadId":"thread-original","turnId":"turn-1","item":{"id":"cmd","type":"commandExecution","command":"printf hello"}}`)
			fmt.Fprintln(os.Stdout, `{"id":"permission","method":"item/commandExecution/requestApproval","params":{"threadId":"thread-original","turnId":"turn-1","itemId":"cmd","availableDecisions":["accept","decline"]}}`)
		case "turn/steer":
			if !strings.Contains(string(m.Params), `"expectedTurnId":"turn-1"`) || !strings.Contains(string(m.Params), `"clientUserMessageId":"steer-1"`) || !strings.Contains(string(m.Params), "change direction") {
				return 8
			}
			frame("item/completed", `{"threadId":"thread-original","turnId":"turn-1","item":{"type":"userMessage","id":"u2","clientId":"steer-1","content":[{"type":"text","text":"change direction"}]}}`)
			reply(`{"turnId":"turn-1"}`)
		case "":
			switch string(m.ID) {
			case `"permission"`:
				if string(m.Result) != `{"decision":"accept"}` {
					return 6
				}
				send(map[string]any{"id": startID, "result": json.RawMessage(`{"turn":{"id":"turn-1"}}`)})
				frame("item/completed", `{"threadId":"thread-original","turnId":"turn-1","item":{"id":"cmd","type":"commandExecution","command":"printf hello","status":"completed","aggregatedOutput":"hello"}}`)
				send(map[string]any{
					"id": "mcp-form", "method": "mcpServer/elicitation/request",
					"params": json.RawMessage(`{"threadId":"thread-original","serverName":"board","mode":"form",
						"message":"Enter a value","requestedSchema":{"type":"object","properties":{"value":{"type":"string"}}}}`),
				})
				continue
			case `"mcp-form"`:
				if m.Error == nil || m.Error.Code != -32601 {
					return 6
				}
				mcpApproval("mcp-allow", `["session","always"]`)
				continue
			case `"mcp-allow"`:
				if string(m.Result) != `{"_meta":{"persist":"session"},"action":"accept","content":{}}` {
					return 6
				}
				mcpApproval("mcp-deny", `"session"`)
				continue
			case `"mcp-deny"`:
				if string(m.Result) != `{"action":"decline","content":null}` {
					return 6
				}
				mcpApproval("mcp-once", "null")
				continue
			case `"mcp-once"`:
				if string(m.Result) != `{"action":"accept","content":{}}` {
					return 6
				}
			default:
				return 6
			}
			frame("item/started", `{"threadId":"thread-original","turnId":"turn-1","item":{"id":"mcp","type":"mcpToolCall","server":"board","tool":"read_board","arguments":{},"status":"inProgress"}}`)
			frame("item/completed", `{"threadId":"thread-original","turnId":"turn-1","item":{"id":"mcp","type":"mcpToolCall","server":"board","tool":"read_board","arguments":{},"status":"completed","result":{"content":[{"type":"text","text":"board contents"}]}}}`)
			frame("item/agentMessage/delta", `{"threadId":"thread-original","turnId":"turn-1","itemId":"msg","delta":"Done"}`)
			frame("item/completed", `{"threadId":"thread-original","turnId":"turn-1","item":{"id":"msg","type":"agentMessage","text":"Done"}}`)
			frame("thread/tokenUsage/updated", `{"threadId":"thread-original","turnId":"turn-1","tokenUsage":{"last":{"inputTokens":80,"outputTokens":20},"total":{"inputTokens":80,"outputTokens":20},"modelContextWindow":1024}}`)
			frame("turn/completed", `{"threadId":"thread-original","turn":{"id":"turn-1","status":"completed"}}`)
		default:
			return 7
		}
	}
	return 0
}
