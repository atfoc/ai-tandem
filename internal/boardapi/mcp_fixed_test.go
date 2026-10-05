package boardapi

import (
	"encoding/json"
	"io"
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
	if n := len(out["result"].(map[string]any)["tools"].([]any)); n != 0 {
		t.Fatalf("tools/list returned %d tools, want empty", n)
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

// A body over the cap is refused with 413 and nothing of it is logged or recorded, also from a
// caller without a token. Under the cap, the names a caller supplies (client name, client
// version, tool name) are cut before they reach the log and the contact table.
func TestMCPBodyIsBounded(t *testing.T) {
	e := newEnv(t)
	buf := captureLog(t)
	initialize := func(name, version string) string {
		return `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"` + name + `","version":"` + version + `"}}}`
	}
	// padded is body with spaces after it up to size bytes; they are valid JSON.
	padded := func(body string, size int) string { return body + strings.Repeat(" ", size-len(body)) }

	for name, body := range map[string]string{
		"a client name as long as the cap": initialize(strings.Repeat("A", maxBodyBytes), "1"),
		"one byte over the cap":            padded(initialize("probe", "1"), maxBodyBytes+1),
	} {
		for _, auth := range []string{"", "Bearer " + e.token} {
			resp, _ := e.fixed(auth, body)
			text, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusRequestEntityTooLarge || string(text) != "request too large\n" {
				t.Errorf("%s: status %d, a body of %d bytes; want 413 and a short message", name, resp.StatusCode, len(text))
			}
		}
	}
	if buf.Len() != 0 || len(e.relay.Contacts.Snapshot()) != 0 {
		t.Fatalf("the refused requests left %d bytes in the log and %d contacts", buf.Len(), len(e.relay.Contacts.Snapshot()))
	}

	// At the cap the request is served.
	if resp, _ := e.fixed("", padded(initialize("probe", "1"), maxBodyBytes)); resp.StatusCode != http.StatusOK {
		t.Fatalf("a body of exactly the cap: status %d", resp.StatusCode)
	}

	// Long names are served, and cut where they are kept: to the limit, and before a character
	// the limit would split ("€" is 3 bytes, so 128 falls inside the 43rd).
	long := 100 << 10
	if resp, _ := e.fixed("", initialize(strings.Repeat("A", long), strings.Repeat("9", long))); resp.StatusCode != http.StatusOK {
		t.Fatalf("a long client name: status %d", resp.StatusCode)
	}
	e.fixed("Bearer "+e.token, initialize(strings.Repeat("€", long/3), "1"))
	e.toolsCall(e.token, strings.Repeat("T", long), `{}`)
	want := map[string]Contact{
		unknownContact: {Client: strings.Repeat("A", maxNameBytes), ClientVersion: strings.Repeat("9", maxNameBytes), Method: "initialize"},
		short(e.chat):  {Client: strings.Repeat("€", 42), ClientVersion: "1", Method: "tools/call", Tool: strings.Repeat("T", maxNameBytes), Outcome: "error"},
	}
	contacts := e.relay.Contacts.Snapshot()
	if len(contacts) != len(want) {
		t.Fatalf("%d contacts, want %d", len(contacts), len(want))
	}
	for _, c := range contacts {
		w := want[c.Chat]
		if c.Client != w.Client || c.ClientVersion != w.ClientVersion || c.Method != w.Method || c.Tool != w.Tool || c.Outcome != w.Outcome {
			t.Errorf("contact %s (%s): client of %d bytes, version of %d, tool of %d; want %d, %d and %d",
				c.Chat, c.Method, len(c.Client), len(c.ClientVersion), len(c.Tool), len(w.Client), len(w.ClientVersion), len(w.Tool))
		}
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 4 {
		t.Fatalf("%d log lines, want 4", len(lines))
	}
	for i, l := range lines {
		if len(l) > 3*maxNameBytes {
			t.Errorf("log line %d has %d bytes", i, len(l))
		}
	}
	if !strings.HasSuffix(lines[3], `tool="`+strings.Repeat("T", maxNameBytes)+`" outcome=error`) {
		t.Errorf("the tools/call line of %d bytes does not end with the cut tool name", len(lines[3]))
	}
}
