package boardapi

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

type env struct {
	t      *testing.T
	relay  *Relay
	mux    *http.ServeMux
	board  model.Board
	token  string
	chat   string
	claude *fakeSpawner
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
	claude := &fakeSpawner{}
	m := chats.New(chats.Deps{
		Store: st, Bridge: br, Boards: bds, DefaultCwd: t.TempDir(),
		MCPURL:   "http://localhost:6006/mcp",
		Spawners: map[model.AgentKind]agent.Spawner{model.Claude: claude},
	})
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
	mux.HandleFunc("POST /mcp", r.ServeFixedMCP) // the only MCP route (header credential)
	mux.HandleFunc("GET /api/events", br.ServeSSE)
	return &env{t: t, relay: r, mux: mux, board: bd, token: metas[0].Token, chat: v.ID, claude: claude}
}

// mcp posts one JSON-RPC message to the fixed /mcp route with the token as the bearer
// credential and returns the response.
func (e *env) mcp(token, body string) (*http.Response, map[string]any) {
	e.t.Helper()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
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
	want := append(append([]boardtools.Tool{}, boardtools.Tools...), boardtools.SpawnFamily...)
	if len(tools) != len(want) || len(boardtools.Tools) != 7 {
		t.Fatalf("%d tools, boardtools.Tools=%d", len(tools), len(boardtools.Tools))
	}
	for i, x := range tools {
		tl := x.(map[string]any)
		if tl["name"] != want[i].Name || tl["description"] != want[i].Description {
			t.Fatalf("tool %d = %v, want %v", i, tl["name"], want[i].Name)
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
	req := httptest.NewRequest("GET", "/mcp", nil)
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

func TestRelayCallLegacyChat(t *testing.T) {
	e := newEnv(t)
	markLegacyAndReload(t, e)
	text, isErr := e.relay.Call(e.token, "list_boards", nil)
	if !isErr || text != "this chat used the old board connection" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
}

// markLegacyAndReload persists instructionsSent on the test chat and reloads the chats manager,
// matching a restart of a curl-era Cursor board chat (there is no setter).
func markLegacyAndReload(t *testing.T, e *env) {
	t.Helper()
	m := e.relay.Chats
	path := filepath.Join(m.Store.P.ChatDir(e.chat), "chat.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var meta model.ChatMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	meta.InstructionsSent = true
	if err := store.WriteJSONAtomic(path, meta, 0o600); err != nil {
		t.Fatal(err)
	}
	nm := chats.New(chats.Deps{Store: m.Store, Bridge: e.relay.Bridge, Boards: e.relay.Boards, DefaultCwd: m.DefaultCwd})
	if err := nm.Load(); err != nil {
		t.Fatal(err)
	}
	e.relay.Chats = nm
}

func TestRelayCallUnknownTool(t *testing.T) {
	e := newEnv(t)
	text, isErr := e.relay.Call(e.token, "rm_rf", nil)
	if !isErr || text != "unknown tool rm_rf" {
		t.Fatalf("got %q isErr=%v", text, isErr)
	}
}
