package boardapi

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// imageCall posts a real JSON-RPC tools/call for tool over HTTP to a server that has a stand-in
// page connected, which answers every rpc with reply (a JSON value, or an error text), and
// returns the decoded response result.
func (e *env) imageCall(token, tool, args string, reply any, errText string) (res map[string]any, asked map[string]any) {
	e.t.Helper()
	srv := httptest.NewServer(e.mux)
	e.t.Cleanup(srv.Close)
	page := bridgetest.Connect(e.t, srv.URL, "P1")
	page.Welcome()
	seen := make(chan map[string]any, 4)
	page.OnRPC(func(params map[string]any) (any, string) {
		seen <- params
		return reply, errText
	})
	e.relay.Bridge.Acted("P1")
	body := fmt.Sprintf(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":%q,"arguments":%s}}`, tool, args)
	req, _ := http.NewRequest("POST", srv.URL+"/mcp", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := srv.Client().Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		e.t.Fatalf("status %d", resp.StatusCode)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		e.t.Fatal(err)
	}
	res, ok := out["result"].(map[string]any)
	if !ok {
		e.t.Fatalf("no result: %v", out)
	}
	select {
	case asked = <-seen:
	default:
	}
	return res, asked
}

func parts(t *testing.T, res map[string]any) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, x := range res["content"].([]any) {
		out = append(out, x.(map[string]any))
	}
	return out
}

func pngB64(n int) string {
	raw := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, n)...)
	return base64.StdEncoding.EncodeToString(raw)
}

func imageReply(mime, data string) map[string]any {
	return map[string]any{"text": "bounds x=0 y=0 w=10 h=10 (board coordinates), 1 elements", "image": map[string]any{"mimeType": mime, "data": data}}
}

// A page that answers get_image with text and an image makes tools/call return the text part
// first and the image part second, with the same base64 and mime type, and no isError.
func TestGetImageReturnsTextThenImage(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	data := pngB64(2000)
	res, asked := e.imageCall(e.token, "get_image", `{"scope":"all","scale":2}`, imageReply("image/png", data), "")
	if _, has := res["isError"]; has {
		t.Fatalf("isError set: %v", res)
	}
	got := parts(t, res)
	if len(got) != 2 {
		t.Fatalf("content %v", got)
	}
	if got[0]["type"] != "text" || got[0]["text"] != "bounds x=0 y=0 w=10 h=10 (board coordinates), 1 elements" {
		t.Fatalf("part 0 %v", got[0])
	}
	if got[1]["type"] != "image" || got[1]["mimeType"] != "image/png" || got[1]["data"] != data {
		t.Fatalf("part 1 has type %v mimeType %v, data equal %v", got[1]["type"], got[1]["mimeType"], got[1]["data"] == data)
	}
	if asked["name"] != "get_image" || asked["target"] != e.board.ID {
		t.Fatalf("rpc params %v", asked)
	}
	if args, _ := json.Marshal(asked["args"]); string(args) != `{"scale":2,"scope":"all"}` {
		t.Fatalf("args %s", args)
	}
}

// A board-owning subagent is handed the picture too.
func TestGetImageForASubagent(t *testing.T) {
	e := newEnv(t)
	if text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"look"}`); isErr {
		t.Fatalf("spawn %q", text)
	}
	waitFor(t, "child", func() bool { return e.claude.count() >= 1 })
	sub := e.claude.last(t).opts.MCP.Token
	res, _ := e.imageCall(sub, "get_image", `{}`, imageReply("image/webp", pngB64(10)), "")
	if got := parts(t, res); len(got) != 2 || got[1]["type"] != "image" || got[1]["mimeType"] != "image/webp" {
		t.Fatalf("content %v", got)
	}
}

// A plain JSON string, an object without an image and an error behave as for every other tool.
func TestGetImageTextOnlyAndErrors(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name    string
		reply   any
		errText string
		text    string
		isErr   bool
	}{
		{"string", "just text", "", "just text", false},
		{"object without image", map[string]any{"text": "only text"}, "", "only text", false},
		{"error", nil, "EMPTY: nothing to draw", "EMPTY: nothing to draw", true},
		{"object without text", map[string]any{"a": 1}, "", `{"a":1}`, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			res, _ := e.imageCall(e.token, "get_image", `{}`, c.reply, c.errText)
			got := parts(t, res)
			if len(got) != 1 || got[0]["type"] != "text" || got[0]["text"] != c.text {
				t.Fatalf("content %v, want text %q", got, c.text)
			}
			if isErr, _ := res["isError"].(bool); isErr != c.isErr {
				t.Fatalf("isError %v, want %v", isErr, c.isErr)
			}
		})
	}
}

// An image the server cannot hand on is an error with text only, never a broken image part.
func TestGetImageMalformed(t *testing.T) {
	t.Parallel()
	text := "bounds"
	for name, reply := range map[string]any{
		"no data":         map[string]any{"text": text, "image": map[string]any{"mimeType": "image/png"}},
		"empty data":      imageReply("image/png", ""),
		"no mime type":    map[string]any{"text": text, "image": map[string]any{"data": pngB64(4)}},
		"gif":             imageReply("image/gif", pngB64(4)),
		"svg":             imageReply("image/svg+xml", pngB64(4)),
		"not base64":      imageReply("image/png", "not base64!!"),
		"image is a text": map[string]any{"text": text, "image": "x"},
	} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			res, _ := e.imageCall(e.token, "get_image", `{}`, reply, "")
			got := parts(t, res)
			if isErr, _ := res["isError"].(bool); !isErr || len(got) != 1 || got[0]["type"] != "text" || !strings.HasPrefix(got[0]["text"].(string), "get_image: ") {
				t.Fatalf("isError %v content %v", res["isError"], got)
			}
		})
	}
}

// An image over the cap is replaced by the size error; one at the cap passes.
func TestGetImageOversize(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	big := strings.Repeat("A", maxImageBase64+4)
	res, _ := e.imageCall(e.token, "get_image", `{}`, imageReply("image/png", big), "")
	got := parts(t, res)
	want := "get_image: the image is larger than 24 MB; ask for a smaller scope or scale"
	if isErr, _ := res["isError"].(bool); !isErr || len(got) != 1 || got[0]["text"] != want {
		t.Fatalf("isError %v content %v", res["isError"], got)
	}
	if pageResult("get_image", mustJSON(t, imageReply("image/png", strings.Repeat("A", maxImageBase64)))).Image == nil {
		t.Fatal("an image at the cap was refused")
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Relay.Call keeps its text-and-flag result: a picture is left out, CallResult has it.
func TestCallKeepsTextOnlyAndCallResultHasImage(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	pages, _ := e.pages("P1")
	e.relay.Bridge.Acted("P1")
	data := pngB64(50)
	pages[0].OnRPC(func(map[string]any) (any, string) { return imageReply("image/png", data), "" })
	text, isErr := e.relay.Call(e.token, "get_image", nil)
	if isErr || text == "" {
		t.Fatalf("Call: %q %v", text, isErr)
	}
	res := e.relay.CallResult(e.token, "get_image", nil)
	if res.IsErr || res.Text != text || res.Image == nil || res.Image.MimeType != "image/png" || res.Image.Data != data {
		t.Fatalf("CallResult %+v", res)
	}
}

// get_image is listed for a board chat and a board-owning subagent, with the schema the page reads.
func TestGetImageListed(t *testing.T) {
	e := newEnv(t)
	check := func(who, token string) {
		t.Helper()
		for _, tl := range e.listSchemas(token) {
			if tl["name"] != "get_image" {
				continue
			}
			sch := tl["inputSchema"].(map[string]any)
			props := sch["properties"].(map[string]any)
			for _, k := range []string{"board", "scope", "refs", "rect", "scale", "background"} {
				if props[k] == nil {
					t.Fatalf("%s: get_image has no %s", who, k)
				}
			}
			if _, req := sch["required"]; req {
				t.Fatalf("%s: get_image requires %v", who, sch["required"])
			}
			return
		}
		t.Fatalf("%s: get_image not listed", who)
	}
	check("board chat", e.token)
	if text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"x"}`); isErr {
		t.Fatalf("spawn %q", text)
	}
	waitFor(t, "child", func() bool { return e.claude.count() >= 1 })
	check("subagent", e.claude.last(t).opts.MCP.Token)
	// A chat on no board is listed no board tool.
	_, tok := e.createChat(model.Claude)
	for _, n := range e.listNames(tok) {
		if n == "get_image" {
			t.Fatal("a plain chat is listed get_image")
		}
	}
}
