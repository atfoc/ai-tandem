package boardapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
)

// fixed posts one JSON-RPC message to the fixed POST /mcp handler with the given Authorization
// header (empty = no header) and returns the response and, for 200, the decoded body.
func (e *env) fixed(auth, body string) (*http.Response, map[string]any) {
	e.t.Helper()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	w := httptest.NewRecorder()
	e.relay.ServeFixedMCP(w, req)
	resp := w.Result()
	var out map[string]any
	if resp.StatusCode == http.StatusOK {
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			e.t.Fatal(err)
		}
	}
	return resp, out
}

// fixedMethod sends an arbitrary method to the fixed handler and returns the status.
func (e *env) fixedMethod(method string) int {
	e.t.Helper()
	req := httptest.NewRequest(method, "/mcp", nil)
	w := httptest.NewRecorder()
	e.relay.ServeFixedMCP(w, req)
	return w.Code
}

// initialize and tools/list are permissive even without a credential (D8).
func TestFixedMCPInitializeAndToolsListPermissive(t *testing.T) {
	e := newEnv(t)
	resp, out := e.fixed("", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"probe","version":"1.2"}}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initialize status %d", resp.StatusCode)
	}
	res := out["result"].(map[string]any)
	if res["serverInfo"].(map[string]any)["name"] != "board" || res["protocolVersion"] != "2025-06-18" {
		t.Fatalf("initialize result %v", res)
	}

	resp, out = e.fixed("Bearer definitely-not-a-token", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tools/list status %d", resp.StatusCode)
	}
	if n := len(out["result"].(map[string]any)["tools"].([]any)); n != len(mcpTools()) {
		t.Fatalf("tools/list returned %d tools", n)
	}
}

// A valid bearer token reaches the chat's browser client through Relay.Call.
func TestFixedMCPToolsCallValidToken(t *testing.T) {
	e := newEnv(t)
	got := make(chan map[string]any, 1)
	e.client(func(p map[string]any) editorbridge.RPCReply {
		got <- p
		return editorbridge.RPCReply{Result: json.RawMessage(`"rect r1 at 0,0"`)}
	})
	_, out := e.fixed("Bearer "+e.token, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_board","arguments":{"board":"b_x"}}}`)
	text, isErr := callResult(t, out)
	if isErr || text != "rect r1 at 0,0" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
	p := <-got
	if p["chat"] != e.chat || p["board"] != e.board.ID || p["name"] != "read_board" {
		t.Fatalf("rpc params %v", p)
	}
}

func TestFixedMCPToolsCallMissingOrBadHeader(t *testing.T) {
	e := newEnv(t)
	for _, auth := range []string{"", "Bearer ", "Token " + e.token, e.token} {
		_, out := e.fixed(auth, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
		text, isErr := callResult(t, out)
		if !isErr || text != "unknown board token" {
			t.Fatalf("auth %q: got %q isError=%v", auth, text, isErr)
		}
	}
}

func TestFixedMCPToolsCallUnknownToken(t *testing.T) {
	e := newEnv(t)
	_, out := e.fixed("Bearer "+strings.Repeat("0", 32), `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != "unknown board token" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
}

func TestFixedMCPToolsCallArchivedChat(t *testing.T) {
	e := newEnv(t)
	if err := e.relay.Chats.SetArchive(e.chat, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	_, out := e.fixed("Bearer "+e.token, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != "this chat is archived" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
}

func TestFixedMCPToolsCallLegacyChat(t *testing.T) {
	e := newEnv(t)
	markLegacyAndReload(t, e)
	_, out := e.fixed("Bearer "+e.token, `{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != "this chat used the old board connection" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
}

func TestFixedMCPToolsCallUnknownTool(t *testing.T) {
	e := newEnv(t)
	_, out := e.fixed("Bearer "+e.token, `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"rm_rf","arguments":{}}}`)
	text, isErr := callResult(t, out)
	if !isErr || text != "unknown tool rm_rf" {
		t.Fatalf("got %q isError=%v", text, isErr)
	}
}

func TestFixedMCPProtocolBits(t *testing.T) {
	e := newEnv(t)
	resp, _ := e.fixed("Bearer "+e.token, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("notification status %d", resp.StatusCode)
	}
	if got := e.fixedMethod("GET"); got != http.StatusMethodNotAllowed {
		t.Fatalf("GET status %d", got)
	}
	resp, _ = e.fixed("Bearer "+e.token, `{nope`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad json status %d", resp.StatusCode)
	}
}
