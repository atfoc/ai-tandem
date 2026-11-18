package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

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
				string(opts.Config["features.multi_agent"]) != "false" {
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
		case "":
			if string(m.ID) != `"permission"` || string(m.Result) != `{"decision":"accept"}` {
				return 6
			}
			send(map[string]any{"id": startID, "result": json.RawMessage(`{"turn":{"id":"turn-1"}}`)})
			frame("item/completed", `{"threadId":"thread-original","turnId":"turn-1","item":{"id":"cmd","type":"commandExecution","command":"printf hello","status":"completed","aggregatedOutput":"hello"}}`)
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
