package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// Level 5 (plans/remote-server-sections-contract.md, section 2): what the tests of the files
// level5_*_test.go share. The owner is a stand-in page on the loopback listener, a client is a
// stand-in API client on the remote listener with the secret, its client id and its level, and
// the two listeners are the real handlers of one server.

const (
	// l5Z is the id of a third API client: one that connects after the others.
	l5Z = "6c1d8e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f"
	// l5Owner and l5Owner2 are the ids of the owner's pages.
	l5Owner  = "owner-page"
	l5Owner2 = "owner-page-2"

	// l5Sentence is what a client below level 5 is told, and l5TooOld the whole answer.
	l5Sentence = "This app is too old for this server: update AI Whiteboard on the machine that connects."
	l5TooOld   = `{"code":"client_too_old","error":"` + l5Sentence + `"}`
	// l5Gate is the remote listener's answer for a route outside its table.
	l5Gate = `{"error":"not found"}`
)

// l5List is the event types that tell a change of the tree: every client and every page of the
// server is sent each of them.
var l5List = []string{"groups", "defaults", "board", "board_removed", "chat", "chat_removed", "branch_state"}

// l5PageOnly is the event types no API client is ever sent.
var l5PageOnly = []string{"servers", "server_state", "server_lists", "server_back", "library", "library_removed", "section", "chat_reload"}

// l5Env is a server with a remote listener on stand-in agents, and a plain folder to work in.
type l5Env struct {
	*env
	l   *listener
	sp  *apiSpawner
	cwd string
}

func newL5Env(t *testing.T) *l5Env {
	t.Helper()
	sp := &apiSpawner{}
	cwd, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e, l := remoteEnv(t, withAgents(sp), func(s *Server) { s.App.DefaultCwd, s.App.Chats.DefaultCwd = cwd, cwd })
	return &l5Env{env: e, l: l, sp: sp, cwd: cwd}
}

// l5Req is one request to the remote listener's handler, asked without a connection. A field
// left empty sends nothing for it; the Host is the listener's unless host names another.
type l5Req struct {
	method, path, body          string
	secret, client, level, host string
	addr                        string // the source address; "" = httptest's
}

// l5Ask asks the handler and returns the status and the body, without its line end.
func l5Ask(h http.Handler, l *listener, rq l5Req) (int, string) {
	req := httptest.NewRequest(rq.method, rq.path, strings.NewReader(rq.body))
	req.Host = l.host
	if rq.host != "" {
		req.Host = rq.host
	}
	if rq.addr != "" {
		req.RemoteAddr = rq.addr
	}
	for name, v := range map[string]string{SecretHeader: rq.secret, ClientHeader: rq.client, LevelHeader: rq.level} {
		if v != "" {
			req.Header.Set(name, v)
		}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Code, strings.TrimSpace(w.Body.String())
}

// l5Call is a call of the page or the client c: the status and the body, without its line end.
func l5Call(c *bridgetest.Page, method, path string, body any) (int, string) {
	status, out := c.Do(method, path, body)
	return status, strings.TrimSpace(string(out))
}

// l5Raw is a call of the API client id over the listener with a body of this content type, for a
// body that is no JSON (an image). It returns the status and the body.
func l5Raw(l *listener, id, method, path, ctype string, body []byte) (int, string) {
	l.t.Helper()
	req, err := http.NewRequest(method, l.base+path, bytes.NewReader(body))
	if err != nil {
		l.t.Fatal(err)
	}
	for name, v := range map[string]string{SecretHeader: testSecret, ClientHeader: id, LevelHeader: testLevel, "Content-Type": ctype} {
		req.Header.Set(name, v)
	}
	resp, err := l.http.Do(req)
	if err != nil {
		l.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, strings.TrimSpace(string(out))
}

// l5Want is a call of c that must be answered with this status. It returns the body.
func l5Want(t *testing.T, c *bridgetest.Page, want int, method, path string, body any) string {
	t.Helper()
	status, out := l5Call(c, method, path, body)
	if status != want {
		t.Fatalf("%s %s by %s: status %d, want %d (%s)", method, path, c.ID, status, want, out)
	}
	return out
}

// l5Is fails unless an answer has this status and exactly this body.
func l5Is(t *testing.T, what string, status int, out string, want int, body string) {
	t.Helper()
	if status != want || out != body {
		t.Errorf("%s: %d %s, want %d %s", what, status, out, want, body)
	}
}

// l5Code is a call of c that must be refused with this status and this code, in a body that
// holds the code and the sentence and nothing else. It returns the sentence.
func l5Code(t *testing.T, c *bridgetest.Page, want int, code, method, path string, body any) string {
	t.Helper()
	status, out := l5Call(c, method, path, body)
	got := map[string]any{}
	json.Unmarshal([]byte(out), &got)
	text, _ := got["error"].(string)
	if status != want || got["code"] != code || text == "" || len(got) != 2 {
		t.Fatalf("%s %s by %s: %d %s, want %d with the code %q", method, path, c.ID, status, out, want, code)
	}
	return text
}

// l5Count is how many of the events are of this type and hold every one of has.
func l5Count(evs []string, typ string, has ...string) (n int) {
	for _, raw := range evs {
		if typeOf(raw) == typ && !slices.ContainsFunc(has, func(s string) bool { return !strings.Contains(raw, s) }) {
			n++
		}
	}
	return n
}

// l5Types is the types of the events, in order.
func l5Types(evs []string) []string {
	out := make([]string, len(evs))
	for i, raw := range evs {
		out[i] = typeOf(raw)
	}
	return out
}

// l5UpTo reads the events of c up to the first of this type that holds every one of has, and
// returns them, that one last.
func l5UpTo(t *testing.T, c *bridgetest.Page, typ string, has ...string) []string {
	t.Helper()
	var got []string
	for {
		raw := c.NextRaw()
		got = append(got, raw)
		if l5Count(got[len(got)-1:], typ, has...) == 1 {
			return got
		}
	}
}

// l5Started is how many agent programs the spawner has started.
func l5Started(sp *apiSpawner) int {
	sp.mu.Lock()
	defer sp.mu.Unlock()
	return len(sp.agents)
}

// l5NoPageEvents fails when an API client was sent an event of a type that is a page's alone,
// or of any type outside the list and content types of the contract's 2.6.
func l5NoPageEvents(t *testing.T, c *bridgetest.Page, evs []string) {
	t.Helper()
	allowed := append(slices.Clone(l5List), "catalog", "agents", "own_library", "tree", "chat_items", "sub", "sub_items", "held",
		"release_request", "superseded", "rpc", "server_stopping")
	for _, raw := range evs {
		if typ := typeOf(raw); slices.Contains(l5PageOnly, typ) || !slices.Contains(allowed, typ) {
			t.Errorf("the API client %s was sent %s: %s", c.ID, typ, raw)
		}
	}
}

// l5Keys returns every key of the JSON value raw, at any depth, with the path it is at.
func l5Keys(t *testing.T, raw string) map[string]string {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("no JSON: %s", raw)
	}
	out := map[string]string{}
	var walk func(v any, at string)
	walk = func(v any, at string) {
		switch x := v.(type) {
		case map[string]any:
			for k, sub := range x {
				out[k] = at + "." + k
				walk(sub, at+"."+k)
			}
		case []any:
			for _, sub := range x {
				walk(sub, at+"[]")
			}
		}
	}
	walk(v, "")
	return out
}

// l5Unmarked fails when the JSON value raw says anywhere who made a thing: no view and no event
// has a "client" or an "origin".
func l5Unmarked(t *testing.T, what, raw string) {
	t.Helper()
	keys := l5Keys(t, raw)
	for _, k := range []string{"client", "origin"} {
		if at, ok := keys[k]; ok {
			t.Errorf("%s says who made a thing, at %s: %s", what, at, raw)
		}
	}
}

// l5Same reports whether two JSON values are the same, whatever the order of their keys.
func l5Same(t *testing.T, a, b string) bool {
	t.Helper()
	var x, y any
	if json.Unmarshal([]byte(a), &x) != nil || json.Unmarshal([]byte(b), &y) != nil {
		t.Fatalf("no JSON: %s / %s", a, b)
	}
	return reflect.DeepEqual(x, y)
}

// l5SameList reports whether the field of two JSON objects is the same, a list in the same order
// too: what one server gives its own page and each of its clients, at every read, and what the
// local server of a client gives a page for the section of that server (goal 3.3), which it
// keeps in the order of its server, wherever a new thing goes in it.
func l5SameList(t *testing.T, a, b, field string) bool {
	t.Helper()
	return l5Same(t, l5Field(t, a, field), l5Field(t, b, field))
}

// l5Field is the field of a JSON object, as it is in raw; "" when the object has none.
func l5Field(t *testing.T, raw, field string) string {
	t.Helper()
	return string(decode[map[string]json.RawMessage](t, raw)[field])
}

// l5ID is the "id" of a JSON object.
func l5ID(t *testing.T, raw string) string {
	t.Helper()
	id := decode[struct{ ID string }](t, raw).ID
	if id == "" {
		t.Fatalf("no id in %s", raw)
	}
	return id
}
