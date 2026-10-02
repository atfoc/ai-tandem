package boardapi

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/pibridge"
	"ai-whiteboard/internal/store"
)

type env struct {
	t     *testing.T
	relay *Relay
	mux   *http.ServeMux
	board model.Board
	token string
	chat  string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st, err := store.Open(store.NewPaths(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	br := editorbridge.New(nil)
	bds := boards.New(st, br)
	if err := bds.Load(); err != nil {
		t.Fatal(err)
	}
	m := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bds, DefaultCwd: t.TempDir(),
		BaseURL: "http://127.0.0.1:4747"})
	if err := m.Load(); err != nil {
		t.Fatal(err)
	}
	bd, err := bds.Create("arch", model.Ungrouped, false)
	if err != nil {
		t.Fatal(err)
	}
	v, err := m.Create(model.Claude, "", bd.ID)
	if err != nil {
		t.Fatal(err)
	}
	metas := m.ChatsOfBoard(bd.ID)
	if len(metas) != 1 || metas[0].Token == "" {
		t.Fatalf("board chats %+v", metas)
	}
	r := &Relay{Bridge: br, Chats: m, Boards: bds}
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp/{token}", r.ServeMCP)
	mux.HandleFunc("/agent/{token}/{tool}", r.ServeCommand)
	mux.HandleFunc("GET /api/events", br.ServeSSE)
	return &env{t: t, relay: r, mux: mux, board: bd, token: metas[0].Token, chat: v.ID}
}

// fakeRuns is a RunResolver backed by a fixed run-token -> board-token map.
type fakeRuns map[string]string

func (f fakeRuns) ResolveBoardToken(runToken string) (string, bool) {
	boardToken, ok := f[runToken]
	return boardToken, ok
}

var _ RunResolver = fakeRuns{}

// mcp posts one JSON-RPC message to /mcp/{token} and returns the response.
func (e *env) mcp(token, body string) (*http.Response, map[string]any) {
	e.t.Helper()
	req := httptest.NewRequest("POST", "/mcp/"+token, strings.NewReader(body))
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, req)
	resp := w.Result()
	var out map[string]any
	if resp.StatusCode == 200 {
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			e.t.Fatal(err)
		}
	}
	return resp, out
}

func (e *env) command(token, tool, body string) (*http.Response, string) {
	e.t.Helper()
	req := httptest.NewRequest("POST", "/agent/"+token+"/"+tool, strings.NewReader(body))
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, req)
	resp := w.Result()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

// callResult checks a tools/call response and returns its text and isError.
func callResult(t *testing.T, out map[string]any) (string, bool) {
	t.Helper()
	res, ok := out["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %v", out)
	}
	content := res["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("content %v", content)
	}
	c := content[0].(map[string]any)
	if c["type"] != "text" {
		t.Fatalf("content %v", c)
	}
	isErr, _ := res["isError"].(bool)
	return c["text"].(string), isErr
}

// client connects an SSE client that answers every rpc with answer(params).
func (e *env) client(answer func(params map[string]any) editorbridge.RPCReply) {
	e.t.Helper()
	srv := httptest.NewServer(e.mux)
	e.t.Cleanup(srv.Close)
	ctx, cancel := context.WithCancel(context.Background())
	e.t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/api/events?client=A", nil)
	resp, err := srv.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	active := make(chan struct{})
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 1<<20)
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data: ")
			if !ok {
				continue
			}
			var ev map[string]any
			if json.Unmarshal([]byte(line), &ev) != nil {
				continue
			}
			switch ev["type"] {
			case "hello":
				close(active)
			case "rpc":
				p, _ := ev["params"].(map[string]any)
				e.relay.Bridge.Reply(ev["id"].(string), answer(p))
			}
		}
	}()
	select {
	case <-active:
	case <-time.After(2 * time.Second):
		e.t.Fatal("client not active")
	}
}

func TestInitializeEchoesProtocolVersion(t *testing.T) {
	e := newEnv(t)
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
	res := out["result"].(map[string]any)
	if res["protocolVersion"] != "2025-06-18" {
		t.Fatalf("protocolVersion %v", res["protocolVersion"])
	}
	if res["serverInfo"].(map[string]any)["name"] != "board" {
		t.Fatalf("serverInfo %v", res["serverInfo"])
	}
	if out["id"] != float64(1) || out["jsonrpc"] != "2.0" {
		t.Fatalf("envelope %v", out)
	}
}

func TestToolsList(t *testing.T) {
	e := newEnv(t)
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	tools := out["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 7 || len(boardtools.Tools) != 7 {
		t.Fatalf("%d tools", len(tools))
	}
	for i, x := range tools {
		tl := x.(map[string]any)
		if tl["name"] != boardtools.Tools[i].Name || tl["description"] != boardtools.Tools[i].Description {
			t.Fatalf("tool %d = %v", i, tl["name"])
		}
		if s, ok := tl["inputSchema"].(map[string]any); !ok || s["type"] != "object" {
			t.Fatalf("tool %v inputSchema %v", tl["name"], tl["inputSchema"])
		}
	}
}

func TestMCPProtocolBits(t *testing.T) {
	e := newEnv(t)
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":3,"method":"ping"}`)
	if _, ok := out["result"].(map[string]any); !ok {
		t.Fatalf("ping %v", out)
	}
	_, out = e.mcp(e.token, `{"jsonrpc":"2.0","id":4,"method":"resources/list"}`)
	if out["error"].(map[string]any)["code"] != float64(-32601) {
		t.Fatalf("unknown method %v", out)
	}
	resp, _ := e.mcp(e.token, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("notification status %d", resp.StatusCode)
	}
	req := httptest.NewRequest("GET", "/mcp/"+e.token, nil)
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, req)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status %d", w.Code)
	}
	resp, _ = e.mcp(e.token, `{nope`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad json status %d", resp.StatusCode)
	}
}

func TestToolsCallUnknownToken(t *testing.T) {
	e := newEnv(t)
	_, out := e.mcp(strings.Repeat("0", 32), `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != "unknown board token" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
}

func TestToolsCallRunTokenResolvesToBoardToken(t *testing.T) {
	e := newEnv(t)
	got := make(chan map[string]any, 1)
	e.client(func(p map[string]any) editorbridge.RPCReply {
		got <- p
		return editorbridge.RPCReply{Result: json.RawMessage(`"rect r1 at 0,0"`)}
	})
	e.relay.Runs = fakeRuns{"run-1": e.token}

	_, out := e.mcp("run-1", `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"read_board","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if isErr || text != "rect r1 at 0,0" {
		t.Fatalf("run token: got %q isError=%v", text, isErr)
	}
	p := <-got
	if p["chat"] != e.chat || p["board"] != e.board.ID || p["name"] != "read_board" {
		t.Fatalf("rpc params %v", p)
	}

	// A board token is not a registered run token: the credential passes
	// through unchanged (Claude/Cursor fallback).
	_, out = e.mcp(e.token, `{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"read_board","arguments":{}}}`)
	text, isErr = callResult(t, out)
	if isErr || text != "rect r1 at 0,0" {
		t.Fatalf("board-token fallback: got %q isError=%v", text, isErr)
	}
	<-got
}

func TestToolsCallRunTokenUnknownOrEmpty(t *testing.T) {
	e := newEnv(t)
	e.relay.Runs = fakeRuns{"run-plain": ""}

	_, out := e.mcp(strings.Repeat("0", 32), `{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != "unknown board token" {
		t.Fatalf("unknown run token: got %q isError=%v", text, isErr)
	}

	// A plain-chat run resolves ok with an empty board token; the relay then
	// reports an unknown board token like any other empty/unknown token.
	_, out = e.mcp("run-plain", `{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	text, isErr = callResult(t, out)
	if !isErr || text != "unknown board token" {
		t.Fatalf("empty board token: got %q isError=%v", text, isErr)
	}
}

func TestToolsCallRunTokenArchivedChat(t *testing.T) {
	e := newEnv(t)
	e.relay.Runs = fakeRuns{"run-arch": e.token}
	if err := e.relay.Chats.SetArchive(e.chat, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	_, out := e.mcp("run-arch", `{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != "this chat is archived" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
}

// TestMCPRunTokenRealBridgeArchiveAndDeregister wires a real pibridge.Bridge
// into the relay's RunResolver: a registered run token resolves to the chat's
// board token and the call reaches the browser client; an archived chat yields
// the existing archived text over the run token; and after deregistration the
// run token stops resolving and is treated as a board token, failing safely
// (A12).
func TestMCPRunTokenRealBridgeArchiveAndDeregister(t *testing.T) {
	e := newEnv(t)
	got := make(chan map[string]any, 1)
	e.client(func(p map[string]any) editorbridge.RPCReply {
		got <- p
		return editorbridge.RPCReply{Result: json.RawMessage(`"rect r1 at 0,0"`)}
	})

	pb := pibridge.New(pibridge.SocketPath(t.TempDir()))
	if err := pb.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pb.Close)
	_, runToken, err := pb.RegisterRun(e.chat, e.token, nil)
	if err != nil {
		t.Fatal(err)
	}
	e.relay.Runs = pb

	// A registered run token resolves through the real bridge and the call
	// reaches the fake browser client.
	_, out := e.mcp(runToken, `{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"read_board","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if isErr || text != "rect r1 at 0,0" {
		t.Fatalf("run token call: got %q isError=%v", text, isErr)
	}
	if p := <-got; p["chat"] != e.chat || p["board"] != e.board.ID {
		t.Fatalf("rpc params %v", p)
	}

	// Archiving the chat yields the existing archived text over the run token.
	if err := e.relay.Chats.SetArchive(e.chat, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	_, out = e.mcp(runToken, `{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"read_board","arguments":{}}}`)
	text, isErr = callResult(t, out)
	if !isErr || text != "this chat is archived" {
		t.Fatalf("archived run token: got %q isError=%v", text, isErr)
	}

	// After deregistration the run token stops resolving; it is treated as a
	// board token and fails safely as unknown (A12).
	pb.DeregisterRun(runToken)
	_, out = e.mcp(runToken, `{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"read_board","arguments":{}}}`)
	text, isErr = callResult(t, out)
	if !isErr || text != "unknown board token" {
		t.Fatalf("deregistered run token: got %q isError=%v", text, isErr)
	}
}

func TestToolsCallRunTokenWithoutResolver(t *testing.T) {
	e := newEnv(t)
	if e.relay.Runs != nil {
		t.Fatal("newEnv relay should have a nil RunResolver")
	}
	_, out := e.mcp("run-1", `{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != "unknown board token" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
}

func TestToolsCallNoClient(t *testing.T) {
	e := newEnv(t)
	start := time.Now()
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_board","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != NoClientText {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
	if !strings.HasPrefix(text, "The board isn't open") {
		t.Fatalf("text %q", text)
	}
	if time.Since(start) > time.Second {
		t.Fatal("did not fail at once")
	}
}

func TestToolsCallThroughClient(t *testing.T) {
	e := newEnv(t)
	got := make(chan map[string]any, 1)
	e.client(func(p map[string]any) editorbridge.RPCReply {
		got <- p
		return editorbridge.RPCReply{Result: json.RawMessage(`"rect r1 at 0,0"`)}
	})
	_, out := e.mcp(e.token, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"read_board","arguments":{"board":"b_x"}}}`)
	text, isErr := callResult(t, out)
	if isErr || text != "rect r1 at 0,0" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
	p := <-got
	if p["chat"] != e.chat || p["board"] != e.board.ID || p["name"] != "read_board" ||
		p["args"].(map[string]any)["board"] != "b_x" {
		t.Fatalf("rpc params %v", p)
	}
}

func TestRelayCallObjectAndErrorResults(t *testing.T) {
	e := newEnv(t)
	e.client(func(p map[string]any) editorbridge.RPCReply {
		if p["name"] == "get_view" {
			return editorbridge.RPCReply{Result: json.RawMessage(`{"board":"b_1"}`)}
		}
		return editorbridge.RPCReply{Error: "no such board"}
	})
	if text, isErr := e.relay.Call(e.token, "get_view", nil); isErr || text != `{"board":"b_1"}` {
		t.Fatalf("get_view: %q %v", text, isErr)
	}
	if text, isErr := e.relay.Call(e.token, "read_board", json.RawMessage(`{}`)); !isErr || text != "no such board" {
		t.Fatalf("read_board: %q %v", text, isErr)
	}
}

func TestRelayCallArchivedChat(t *testing.T) {
	e := newEnv(t)
	if err := e.relay.Chats.SetArchive(e.chat, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	text, isErr := e.relay.Call(e.token, "list_boards", nil)
	if !isErr || text != "this chat is archived" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
}

func TestRelayCallUnknownTool(t *testing.T) {
	e := newEnv(t)
	text, isErr := e.relay.Call(e.token, "rm_rf", nil)
	if !isErr || text != "unknown tool rm_rf" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
}

func TestServeCommandErrors(t *testing.T) {
	e := newEnv(t)
	cases := []struct {
		name, token, tool, body, want string
	}{
		{"unknown token", strings.Repeat("0", 32), "list_boards", `{}`, "ERROR: unknown board token"},
		{"unknown tool", e.token, "nope", `{}`, "ERROR: unknown tool nope"},
		{"bad json", e.token, "read_board", `{nope`, "ERROR: the arguments are not valid JSON"},
		{"no client", e.token, "read_board", `{}`, "ERROR: " + NoClientText},
	}
	for _, c := range cases {
		resp, body := e.command(c.token, c.tool, c.body)
		if resp.StatusCode != 200 {
			t.Errorf("%s: status %d", c.name, resp.StatusCode)
		}
		if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/plain") {
			t.Errorf("%s: content type %q", c.name, resp.Header.Get("Content-Type"))
		}
		if strings.TrimSuffix(body, "\n") != c.want {
			t.Errorf("%s: body %q, want %q", c.name, body, c.want)
		}
	}
}

func TestServeCommandSuccess(t *testing.T) {
	e := newEnv(t)
	got := make(chan map[string]any, 1)
	e.client(func(p map[string]any) editorbridge.RPCReply {
		got <- p
		return editorbridge.RPCReply{Result: json.RawMessage(`"created db"`)}
	})
	resp, body := e.command(e.token, "apply", "{\"create\":[{\"type\":\"rectangle\",\"key\":\"db\"}]}\n")
	if resp.StatusCode != 200 || body != "created db\n" {
		t.Fatalf("status %d body %q", resp.StatusCode, body)
	}
	p := <-got
	if p["name"] != "apply" || p["args"].(map[string]any)["create"] == nil {
		t.Fatalf("rpc params %v", p)
	}
}
