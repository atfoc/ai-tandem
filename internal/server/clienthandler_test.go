package server

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
)

const (
	testSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testHost   = "mac.local:4748"
	// testAPIClient is the client id the tests' client states: another server's instance id.
	testAPIClient = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
)

// withClients gives the server a client listener on port 4748 with two names, for the tests that
// ask ClientHandler directly (on an env made by newRawEnv).
func withClients(s *Server) {
	s.Clients = NewClientListener(4748, []string{"mac.local", "192.168.1.20"}, "AB:CD", testSecret)
}

// clientDo sends one request to h as the client listener would get it from the client
// testAPIClient; secret "" sends no secret header.
func clientDo(h http.Handler, method, path, host, secret string) *httptest.ResponseRecorder {
	return clientDoAs(h, testAPIClient, method, path, host, secret, "")
}

// clientDoAs is clientDo for the client with this id ("" sends no client header) and with a body.
// The client states the server's own level, as every client of the tests does.
func clientDoAs(h http.Handler, client, method, path, host, secret, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = host
	if secret != "" {
		req.Header.Set(SecretHeader, secret)
	}
	if client != "" {
		req.Header.Set(ClientHeader, client)
	}
	req.Header.Set(LevelHeader, testLevel)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func wantReply(t *testing.T, w *httptest.ResponseRecorder, what string, status int, errText string) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("%s: status %d, want %d (%s)", what, w.Code, status, w.Body)
	}
	if errText != "" && strings.TrimSpace(w.Body.String()) != `{"error":"`+errText+`"}` {
		t.Fatalf("%s: body %q, want the error %q", what, w.Body, errText)
	}
}

// Hello is the one route answered without the secret, to whoever asks with a right Host, and it
// says the app, the version, the feature level and the instance id, and nothing else.
func TestHelloWithoutTheSecret(t *testing.T) {
	t.Parallel()
	const id = "3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c"
	e := newRawEnv(t, withClients, func(s *Server) { s.InstanceID = id })
	h := e.s.ClientHandler()
	for _, host := range []string{testHost, "192.168.1.20:4748", "MAC.local:4748", "127.0.0.1:4748", "localhost:4748"} {
		w := clientDoAs(h, "", "GET", "/api/hello", host, "", "")
		wantReply(t, w, "hello with host "+host, 200, "")
		out := decode[map[string]any](t, w.Body.String())
		if len(out) != 4 || out["app"] != "ai-whiteboard" || out["version"] == nil || out["featureLevel"] != float64(FeatureLevel) || out["instanceId"] != id {
			t.Fatalf("hello with host %s: %v", host, out)
		}
	}
	// No client id and no level are asked of it either, and a wrong secret is no matter.
	w := clientDoAs(h, "", "GET", "/api/hello", testHost, "wrong", "")
	wantReply(t, w, "hello with a wrong secret", 200, "")
	for _, host := range []string{"evil.example:4748", "mac.local", "mac.local:4749", "mac.local:443", "", "192.168.1.21:4748", "127.0.0.1:4749"} {
		wantReply(t, clientDoAs(h, "", "GET", "/api/hello", host, "", ""), "hello with host "+host, 403, "bad host")
	}
	// A server without an instance id leaves it out; another method is not hello.
	e = newRawEnv(t, withClients)
	out := decode[map[string]any](t, clientDoAs(e.s.ClientHandler(), "", "GET", "/api/hello", testHost, "", "").Body.String())
	if _, ok := out["instanceId"]; ok || len(out) != 3 {
		t.Fatalf("hello of a server without an instance id: %v", out)
	}
	wantReply(t, clientDoAs(e.s.ClientHandler(), "", "POST", "/api/hello", testHost, "", ""), "POST /api/hello", 401, "unauthorized")
}

func TestSecretAndHost(t *testing.T) {
	t.Parallel()
	e := newRawEnv(t, withClients)
	h := e.s.ClientHandler()

	wrong := strings.Replace(testSecret, "0", "f", 1)
	for _, secret := range []string{"", wrong, testSecret[:63], testSecret + "0"} {
		for _, rq := range [][2]string{{"GET", "/api/state"}, {"GET", "/"}, {"GET", "/index.html"},
			{"GET", "/api/events"}, {"POST", "/api/boards"}, {"OPTIONS", "/api/state"}} {
			for _, host := range []string{testHost, "evil.example:4748", "127.0.0.1:4748"} {
				what := fmt.Sprintf("%s %s host %s secret %q", rq[0], rq[1], host, secret)
				wantReply(t, clientDo(h, rq[0], rq[1], host, secret), what, 401, "unauthorized")
			}
		}
	}

	// The Host is checked after the secret and before the table: a route that is not served says
	// 403 too. The loopback names are Hosts of every server (the app reaches this machine's
	// server by one), and the set-up's names are the others.
	for _, host := range []string{testHost, "192.168.1.20:4748", "MAC.local:4748", "127.0.0.1:4748", "localhost:4748", "LOCALHOST:4748"} {
		wantReply(t, clientDo(h, "GET", "/api/state", host, testSecret), "state with host "+host, 200, "")
	}
	for _, host := range []string{"evil.example:4748", "mac.local", "mac.local:4749", "mac.local:443", "", "192.168.1.21:4748",
		"127.0.0.1", "127.0.0.1:4749", "localhost", "[::1]:4748"} {
		wantReply(t, clientDo(h, "GET", "/api/state", host, testSecret), "state with host "+host, 403, "bad host")
		wantReply(t, clientDo(h, "GET", "/api/mcp/status", host, testSecret), "mcp status with host "+host, 403, "bad host")
	}

	// The bare name is a Host only on port 443.
	e.s.Clients = NewClientListener(443, []string{"mac.local"}, "AB:CD", testSecret)
	h = e.s.ClientHandler()
	wantReply(t, clientDo(h, "GET", "/api/state", "mac.local", testSecret), "bare name on 443", 200, "")
	wantReply(t, clientDo(h, "GET", "/api/state", "mac.local:443", testSecret), "name:443", 200, "")
	wantReply(t, clientDo(h, "GET", "/api/state", "127.0.0.1:443", testSecret), "loopback:443", 200, "")
	wantReply(t, clientDo(h, "GET", "/api/state", "other.local", testSecret), "other bare name", 403, "bad host")

	// Without a secret, or without a listener's identity at all, nothing is served.
	e.s.Clients = NewClientListener(4748, []string{"mac.local"}, "AB:CD", "")
	wantReply(t, clientDo(e.s.ClientHandler(), "GET", "/api/state", testHost, ""), "empty secret", 401, "unauthorized")
	e.s.Clients = nil
	wantReply(t, clientDo(e.s.ClientHandler(), "GET", "/api/state", testHost, testSecret), "no listener", 401, "unauthorized")
}

// The client id and the level are checked after the secret and the Host, on every path but hello.
func TestClientIDAndLevel(t *testing.T) {
	t.Parallel()
	const own = "3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c"
	e := newRawEnv(t, withClients, func(s *Server) { s.InstanceID = own })
	h := e.s.ClientHandler()
	code := func(w *httptest.ResponseRecorder) string {
		return decode[map[string]string](t, w.Body.String())["code"]
	}
	for _, id := range []string{"", "A", strings.ToUpper(testAPIClient), "7c9e6679-7425-30de-944b-e07fc1f90ae7", testAPIClient + "0"} {
		for _, path := range []string{"/api/state", "/api/mcp/status", "/index.html"} {
			w := clientDoAs(h, id, "GET", path, testHost, testSecret, "")
			if w.Code != 400 || code(w) != "bad_client" {
				t.Errorf("%s as %q: %d %s", path, id, w.Code, w.Body)
			}
		}
	}
	// The server's own id is no client's, on every route but hello.
	if w := clientDoAs(h, own, "GET", "/api/state", testHost, testSecret, ""); w.Code != 400 || code(w) != "own_client" {
		t.Errorf("the server's own id: %d %s", w.Code, w.Body)
	}
	wantReply(t, clientDoAs(h, own, "GET", "/api/hello", testHost, "", ""), "hello with the server's own id", 200, "")

	// A level below the server's, or none, is refused with the sentence; hello still answers.
	for _, level := range []string{"", "5", "0", "-1", "six", "6.5", " 6"} {
		req := httptest.NewRequest("GET", "/api/state", nil)
		req.Host = testHost
		req.Header.Set(SecretHeader, testSecret)
		req.Header.Set(ClientHeader, testAPIClient)
		if level != "" {
			req.Header.Set(LevelHeader, level)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 400 || code(w) != "client_too_old" || !strings.Contains(w.Body.String(), "This app is too old for this server") {
			t.Errorf("level %q: %d %s", level, w.Code, w.Body)
		}
	}
	// A client of level 5 is refused on the stream, while its hello is answered.
	req := httptest.NewRequest("GET", "/api/events", nil)
	req.Host = testHost
	req.Header.Set(SecretHeader, testSecret)
	req.Header.Set(ClientHeader, testAPIClient)
	req.Header.Set(LevelHeader, "5")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 400 || code(w) != "client_too_old" {
		t.Errorf("a client of level 5 on /api/events: %d %s", w.Code, w.Body)
	}
	wantReply(t, clientDoAs(h, "", "GET", "/api/hello", testHost, "", ""), "hello for a client of level 5", 200, "")
	for _, level := range []string{"6", "7", "100"} {
		req := httptest.NewRequest("GET", "/api/state", nil)
		req.Host = testHost
		req.Header.Set(SecretHeader, testSecret)
		req.Header.Set(ClientHeader, testAPIClient)
		req.Header.Set(LevelHeader, level)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Errorf("level %s: %d %s", level, w.Code, w.Body)
		}
	}
}

// The secret does not travel on to the route's handler.
func TestSecretHeaderIsDropped(t *testing.T) {
	t.Parallel()
	e := newRawEnv(t, withClients)
	req := httptest.NewRequest("GET", "/api/state", nil)
	req.Host = testHost
	req.Header.Set(SecretHeader, testSecret)
	req.Header.Set(ClientHeader, testAPIClient)
	req.Header.Set(LevelHeader, testLevel)
	w := httptest.NewRecorder()
	e.s.ClientHandler().ServeHTTP(w, req)
	if w.Code != 200 || req.Header.Get(SecretHeader) != "" {
		t.Fatalf("status %d, secret header %q after the request", w.Code, req.Header.Get(SecretHeader))
	}
}

// relayPrefix is the path under which the local API of before passed a call on to another server.
// No route is there now, and every request for it is refused.
const relayPrefix = "/api/" + "on"

var pathWildcard = regexp.MustCompile(`\{[^}]*\}`)

// wantRoutes is the client API as the plan spells it (C1.4), in its order. ClientRoutes and the
// routes the server registers must equal it; packages/conn/core/routes.json holds the same list.
var wantRoutes = []string{
	"GET /api/hello", "GET /api/events", "GET /api/state", "POST /api/client/flushed",
	"POST /api/groups", "PATCH /api/groups/{id}", "POST /api/groups/{id}/move", "DELETE /api/groups/{id}",
	"POST /api/groups/{id}/archive", "POST /api/groups/{id}/unarchive",
	"POST /api/chats", "GET /api/chats/{id}", "GET /api/chats/{id}/items", "GET /api/chats/{id}/tree", "GET /api/chats/{id}/context",
	"GET /api/chats/{id}/subagents/{sid}/items", "PATCH /api/chats/{id}", "POST /api/chats/{id}/messages",
	"POST /api/chats/{id}/interrupt", "POST /api/chats/{id}/permission", "PUT /api/chats/{id}/label", "PUT /api/chats/{id}/draft",
	"POST /api/chats/{id}/images", "GET /api/chats/{id}/images/{image}", "POST /api/chats/{id}/open", "POST /api/chats/{id}/fork",
	"POST /api/chats/{id}/archive", "POST /api/chats/{id}/unarchive", "DELETE /api/chats/{id}", "POST /api/chats/{id}/unfollow",
	"GET /api/dirs", "GET /api/usage/{agent}",
	"POST /api/boards", "GET /api/boards/{id}/scene", "PUT /api/boards/{id}/scene", "POST /api/boards/{id}/take",
	"POST /api/boards/{id}/release", "POST /api/boards/{id}/rename", "PATCH /api/boards/{id}", "POST /api/boards/{id}/archive",
	"POST /api/boards/{id}/unarchive", "POST /api/boards/{id}/seen", "DELETE /api/boards/{id}",
	"POST /api/rpc-reply",
	"GET /api/library", "POST /api/library/{server}/groups", "PATCH /api/library/{server}/groups/{id}",
	"DELETE /api/library/{server}/groups/{id}", "POST /api/library/{server}/prompts",
	"PATCH /api/library/{server}/prompts/{id}", "DELETE /api/library/{server}/prompts/{id}",
}

// What the local API had and the client API has not: no page file, no list of servers, no relay,
// no restart, no status route, no order of the groups, no reveal. Each is 401 without the secret
// and 404 with it.
var goneRoutes = []struct{ method, path string }{
	{"GET", "/"}, {"GET", "/index.html"}, {"GET", "/app.js"}, {"GET", "/version.json"},
	{"GET", "/api/servers"}, {"POST", "/api/servers"}, {"GET", "/api/servers/s_1/items"}, {"POST", "/api/servers/test"},
	{"GET", "" + relayPrefix + "/s_000000000001/api/state"}, {"POST", "" + relayPrefix + "/s_000000000001/chats"},
	{"POST", "/api/restart"}, {"GET", "/api/mcp/status"}, {"GET", "/api/remote/status"},
	{"PUT", "/api/groups/order"}, {"POST", "/api/boards/b_aaaa1111/reveal"},
	{"PUT", "/api/chats/c1"}, {"PUT", "/api/boards/b_aaaa1111"}, {"POST", "/mcp"},
}

// The table of the client listener against the routes the server has: the table is the plan's, a
// route of it is served and is registered, every registered route is in it, and nothing else is
// served: no page file at any address.
func TestClientAPIIsTheTable(t *testing.T) {
	t.Parallel()
	e := newRawEnv(t, withClients)
	h := e.s.ClientHandler()

	if !slices.Equal(ClientRoutes, wantRoutes) {
		t.Fatalf("ClientRoutes:\n%v\nwant\n%v", ClientRoutes, wantRoutes)
	}
	patterns := e.s.routes().patterns
	if len(patterns) != len(ClientRoutes) {
		t.Errorf("%d routes registered, the table has %d: %v", len(patterns), len(ClientRoutes), patterns)
	}
	for _, p := range patterns {
		if !slices.Contains(ClientRoutes, p) {
			t.Errorf("the route %q is registered and is not in the table", p)
		}
	}
	for i, p := range ClientRoutes {
		if !slices.Contains(patterns, p) {
			t.Errorf("table entry %q is not a registered route", p)
		}
		if slices.Index(ClientRoutes, p) != i {
			t.Errorf("table entry %q is there twice", p)
		}
	}

	// Without the secret, and with a wrong one, every route answers 401: one of the table, one
	// outside it and one that is no route alike.
	all := slices.Clone(ClientRoutes)
	for _, g := range goneRoutes {
		all = append(all, g.method+" "+g.path)
	}
	for _, p := range all {
		method, path, _ := strings.Cut(p, " ")
		path = pathWildcard.ReplaceAllString(path, "x")
		for _, secret := range []string{"", strings.Repeat("0", len(testSecret)), testSecret + "0", testSecret[:len(testSecret)-1]} {
			if p == "GET /api/hello" {
				continue // answered without it
			}
			wantReply(t, clientDo(h, method, path, testHost, secret), p+" with the secret "+strconv.Quote(secret), 401, "unauthorized")
		}
	}

	const gate = `{"error":"not found"}`
	served := 0
	for _, p := range all {
		method, path, _ := strings.Cut(p, " ")
		path = pathWildcard.ReplaceAllString(path, "x")
		// The stream never returns by itself: its request is cancelled before it is made, so the
		// handler writes the stream's first bytes and ends.
		req := httptest.NewRequest(method, path, nil)
		if p == "GET /api/events" {
			ctx, cancel := context.WithCancel(req.Context())
			cancel()
			req = req.WithContext(ctx)
		}
		req.Host = testHost
		req.Header.Set(SecretHeader, testSecret)
		req.Header.Set(ClientHeader, testAPIClient)
		req.Header.Set(LevelHeader, testLevel)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		// The gate's answer is told by its body: a route of the table may answer 404 itself, as
		// the read of a chat that is not there does.
		isGate := w.Code == 404 && strings.TrimSpace(w.Body.String()) == gate
		if slices.Contains(ClientRoutes, p) {
			served++
			if isGate {
				t.Errorf("%s (%s %s): the gate's 404 for a route of the table", p, method, path)
			}
			continue
		}
		if !isGate {
			t.Errorf("%s (%s %s): status %d body %q, want 404 not found", p, method, path, w.Code, w.Body)
		}
	}
	if served != len(ClientRoutes) || served != 51 {
		t.Errorf("%d routes of the table were asked for, the table has %d, want 51", served, len(ClientRoutes))
	}
	if n := len(e.s.Bridge.Followers(editorbridge.Chat("x"))); n != 0 {
		t.Errorf("%d followers of the chat the reads named: a read with no open stream follows nothing", n)
	}
	if n := len(e.a.Chats.Views()) + len(e.a.Boards.List()); n != 0 {
		t.Errorf("the routes that were asked for made %d chats and boards", n)
	}

	// A listed path with another method is 404 too, not 405.
	for _, method := range []string{"POST", "PUT", "DELETE", "OPTIONS"} {
		wantReply(t, clientDo(h, method, "/api/state", testHost, testSecret), method+" /api/state", 404, "not found")
	}
}

func TestRefusedLog(t *testing.T) {
	t.Parallel()
	e := newRawEnv(t, withClients)
	rm := e.s.Clients
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	var lines []string
	rm.now = func() time.Time { return now }
	rm.logf = func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
	h := e.s.ClientHandler()
	wrong := strings.Replace(testSecret, "0", "f", 1)

	level := testLevel // what the caller states; "" states none
	do := func(addr, method, path, host, secret string) int {
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr, req.Host = addr, host
		req.Header.Set(ClientHeader, testAPIClient)
		if level != "" {
			req.Header.Set(LevelHeader, level)
		}
		if secret != "" {
			req.Header.Set(SecretHeader, secret)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}
	want := func(what string, n int, last string) {
		t.Helper()
		if len(lines) != n {
			t.Fatalf("%s: %d log lines, want %d: %q", what, len(lines), n, lines)
		}
		if n > 0 && lines[n-1] != last {
			t.Fatalf("%s: logged %q, want %q", what, lines[n-1], last)
		}
	}

	long := "/" + strings.Repeat("a", 200)
	do("10.0.0.1:5000", "GET", long+"?token="+wrong, testHost, wrong)
	l1 := `remote listener: refused 401 from 10.0.0.1: GET "/` + strings.Repeat("a", 79) + `"`
	want("first refusal", 1, l1)
	// The same address within the minute, from another port, 401 or 403: nothing more.
	do("10.0.0.1:5001", "GET", "/api/state", testHost, "")
	do("10.0.0.1:5002", "GET", "/api/state", "evil.example:4748", testSecret)
	now = now.Add(59 * time.Second)
	do("10.0.0.1:5003", "POST", "/api/boards", testHost, wrong)
	want("the same address within a minute", 1, l1)
	// Another address has its own line; a 403 names the Host.
	do("10.0.0.2:5000", "POST", "/api/boards", "Evil.example:4748", testSecret)
	l2 := `remote listener: refused 403 from 10.0.0.2: POST "/api/boards" host="Evil.example:4748"`
	want("another address", 2, l2)
	// Served and 404 requests are not logged, and nor is a hello.
	if do("10.0.0.3:5000", "GET", "/api/hello", testHost, "") != 200 || do("10.0.0.3:5000", "GET", "/api/state", testHost, testSecret) != 200 ||
		do("10.0.0.3:5000", "GET", "/api/mcp/status", testHost, testSecret) != 404 {
		t.Fatal("hello, state or a route outside the table with the secret: unexpected status")
	}
	want("served requests", 2, l2)
	// A hello with a wrong Host is a refusal like any other.
	do("10.0.0.8:5000", "GET", "/api/hello", "evil.example:4748", "")
	want("a hello with a wrong Host", 3, `remote listener: refused 403 from 10.0.0.8: GET "/api/hello" host="evil.example:4748"`)
	// After the minute the first address is logged again.
	now = now.Add(time.Second)
	do("10.0.0.1:5004", "GET", "/api/state", testHost, "")
	want("after a minute", 4, `remote listener: refused 401 from 10.0.0.1: GET "/api/state"`)

	// A long method is cut, in a 401 and in a 403.
	method := strings.Repeat("M", 1<<20)
	do("10.0.0.4:5000", method, "/api/state", testHost, wrong)
	want("a long method", 5, `remote listener: refused 401 from 10.0.0.4: `+strings.Repeat("M", 16)+` "/api/state"`)
	do("10.0.0.5:5000", method, "/api/state", "evil.example:4748", testSecret)
	want("a long method and a bad host", 6, `remote listener: refused 403 from 10.0.0.5: `+strings.Repeat("M", 16)+` "/api/state" host="evil.example:4748"`)

	// A client that is too old, or states no level, is logged as a refused request is: one line
	// per address per minute, with the sentence it was answered. Its hello is served and not logged.
	for _, level = range []string{"", "5"} {
		if do("10.0.0.6:5000", "GET", "/api/hello", testHost, testSecret) != 200 {
			t.Fatalf("hello of a client of the level %q was not served", level)
		}
	}
	want("the hello of a client that is too old", 6, lines[5])
	level = ""
	if do("10.0.0.6:5000", "GET", "/api/state", testHost, testSecret) != 400 {
		t.Fatal("a client that states no level was not refused")
	}
	const tooOld = `remote listener: refused 400 from 10.0.0.6: GET "/api/state": This app is too old for this server: update AI Whiteboard on the machine that connects.`
	want("a client that states no level", 7, tooOld)
	level = "5"
	if do("10.0.0.6:5001", "POST", "/api/chats", testHost, testSecret) != 400 || do("10.0.0.6:5002", "GET", "/api/mcp/status", testHost, testSecret) != 400 {
		t.Fatal("a client of level 5 was not refused, on a route of the table and on one outside it")
	}
	want("the same address within a minute", 7, tooOld)
	do("10.0.0.7:5000", "POST", "/api/chats", testHost, testSecret)
	want("a client of level 5 at another address", 8, `remote listener: refused 400 from 10.0.0.7: POST "/api/chats": This app is too old for this server: update AI Whiteboard on the machine that connects.`)
	level = testLevel

	for _, l := range lines {
		if strings.Contains(l, testSecret) || strings.Contains(l, wrong) {
			t.Fatalf("a log line holds a secret: %q", l)
		}
	}

	// A flood of addresses does not grow the log's memory without end.
	for i := 0; i < 3*refusedLogMax; i++ {
		do(fmt.Sprintf("10.1.%d.%d:1", i/250, i%250), "GET", "/", testHost, "")
	}
	if n := len(rm.refused); n > refusedLogMax {
		t.Fatalf("the refused log remembers %d addresses, want at most %d", n, refusedLogMax)
	}
}

func TestSetSecret(t *testing.T) {
	t.Parallel()
	e := newRawEnv(t, withClients)
	h := e.s.ClientHandler()
	next := strings.Repeat("ab", 32)
	wantReply(t, clientDo(h, "GET", "/api/state", testHost, testSecret), "old secret", 200, "")
	wantReply(t, clientDo(h, "GET", "/api/state", testHost, next), "new secret before the change", 401, "unauthorized")
	e.s.Clients.SetSecret(next)
	wantReply(t, clientDo(h, "GET", "/api/state", testHost, next), "new secret", 200, "")
	wantReply(t, clientDo(h, "GET", "/api/state", testHost, testSecret), "old secret after the change", 401, "unauthorized")
	e.s.Clients.SetSecret("")
	wantReply(t, clientDo(h, "GET", "/api/state", testHost, ""), "empty secret", 401, "unauthorized")
}

func TestServeClients(t *testing.T) {
	t.Parallel()
	ts := httptest.NewTLSServer(nil)
	pair := ts.TLS.Certificates[0]
	ts.Close()

	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	var mu sync.Mutex
	var lines []string
	e := newRawEnv(t, func(s *Server) {
		s.Clients = NewClientListener(port, []string{"127.0.0.1"}, "AB:CD", testSecret)
		s.Clients.logf = func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			lines = append(lines, fmt.Sprintf(format, args...))
		}
	})
	done := make(chan error, 1)
	go func() { done <- e.s.ServeClients(ln, pair) }()
	t.Cleanup(func() {
		ln.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("ServeClients did not return after its listener was closed")
		}
		if e.s.Clients.serving.Load() {
			t.Error("the listener still counts as serving")
		}
	})

	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, ForceAttemptHTTP2: true}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr, Timeout: 10 * time.Second}
	get := func(url, secret string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set(ClientHeader, testAPIClient)
		req.Header.Set(LevelHeader, testLevel)
		if secret != "" {
			req.Header.Set(SecretHeader, secret)
		}
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}
	base := fmt.Sprintf("https://127.0.0.1:%d", port)

	resp, body := get(base+"/api/hello", "")
	if resp.StatusCode != 200 || resp.ProtoMajor != 2 {
		t.Fatalf("hello over HTTPS: status %d, %s (%s), want 200 over HTTP/2", resp.StatusCode, resp.Proto, body)
	}
	out := decode[map[string]any](t, body)
	if _, ok := out["pid"]; ok || out["app"] != "ai-whiteboard" {
		t.Fatalf("hello over HTTPS: %v", out)
	}
	if resp, _ := get(base+"/api/state", ""); resp.StatusCode != 401 {
		t.Fatalf("state without the secret: status %d, want 401", resp.StatusCode)
	}
	if resp, _ := get(base+"/api/state", testSecret); resp.StatusCode != 200 {
		t.Fatalf("state with the secret: status %d, want 200", resp.StatusCode)
	}
	if resp, _ := get(base+"/api/mcp/status", testSecret); resp.StatusCode != 404 {
		t.Fatalf("a route outside the table over HTTPS: status %d, want 404", resp.StatusCode)
	}
	if resp, _ := get(base+"/", testSecret); resp.StatusCode != 404 {
		t.Fatalf("the root over HTTPS: status %d, want 404: no page", resp.StatusCode)
	}
	if resp, _ := get(fmt.Sprintf("https://localhost:%d/api/state", port), testSecret); resp.StatusCode != 200 {
		t.Fatalf("state by the name localhost: status %d, want 200", resp.StatusCode)
	}

	// Plain HTTP gets 400, and the listener's own error log is at most one line a minute.
	for i := 0; i < 3; i++ {
		req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/api/state", port), nil)
		req.Header.Set(SecretHeader, testSecret)
		req.Header.Set(ClientHeader, testAPIClient)
		resp, err := (&http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("plain HTTP: status %d, want 400", resp.StatusCode)
		}
	}
	// A TLS client is still served after them.
	if resp, _ := get(base+"/api/state", testSecret); resp.StatusCode != 200 {
		t.Fatalf("state after plain HTTP: status %d", resp.StatusCode)
	}
	mu.Lock()
	defer mu.Unlock()
	errs := 0
	for _, l := range lines {
		if strings.Contains(l, testSecret) {
			t.Fatalf("a log line holds the secret: %q", l)
		}
		if !strings.Contains(l, "refused") {
			errs++
		}
	}
	if errs > 1 {
		t.Fatalf("%d lines of the listener's error log within a minute, want at most 1: %q", errs, lines)
	}
}

// ServeClients without a listener's identity fails instead of serving an open listener.
func TestServeClientsNeedsClients(t *testing.T) {
	t.Parallel()
	e := newRawEnv(t)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := e.s.ServeClients(ln, tls.Certificate{}); err == nil {
		t.Fatal("ServeClients without a ClientListener returned no error")
	}
}

// A wildcard entry of the table does not open a more specific route outside it: the gate asks the
// routes themselves which pattern serves the request.
//
// Not parallel: the table is the package's, one for every server of the process. A serial test
// ends (and its cleanup puts the table back) before the parallel tests go on.
func TestWildcardEntryServesNoOtherRoute(t *testing.T) {
	old := ClientRoutes
	ClientRoutes = []string{"GET /api/hello", "GET /api/{x}"}
	t.Cleanup(func() { ClientRoutes = old })
	e := newRawEnv(t, withClients)
	h := e.s.ClientHandler()
	wantReply(t, clientDo(h, "GET", "/api/state", testHost, testSecret), "a route outside the table", 404, "not found")
	wantReply(t, clientDo(h, "GET", "/api/boards/b1/scene", testHost, testSecret), "a deeper route outside the table", 404, "not found")
	wantReply(t, clientDo(h, "GET", "/api/hello", testHost, ""), "hello", 200, "")
	wantReply(t, clientDo(h, "GET", "/api//hello", testHost, testSecret), "a path to clean", 301, "")
}

// A path in another form than a route's serves nothing: the two with a doubled slash are
// redirected with no data, the others are not found.
func TestPathFormsServeNothing(t *testing.T) {
	t.Parallel()
	e := newRawEnv(t, withClients)
	h := e.s.ClientHandler()
	v, err := e.a.Chats.CreateChat(chats.NewChat{Agent: model.Claude, Group: model.Ungrouped})
	if err != nil {
		t.Fatal(err)
	}
	leaks := func(what, body string) {
		t.Helper()
		for _, s := range []string{v.ID, `"chats"`, `"agents"`, `"listening"`, `"featureLevel"`} {
			if strings.Contains(body, s) {
				t.Errorf("%s: the answer holds data: %s", what, body)
			}
		}
	}
	for _, path := range []string{"//api/state", "/api//state"} {
		w := clientDo(h, "GET", path, testHost, testSecret)
		if w.Code != 301 || w.Header().Get("Location") != "/api/state" {
			t.Errorf("GET %s: %d to %q, want 301 to /api/state (%s)", path, w.Code, w.Header().Get("Location"), w.Body)
		}
		leaks("GET "+path, w.Body.String())
		// Without the secret the redirect is not given either.
		wantReply(t, clientDo(h, "GET", path, testHost, ""), "GET "+path+" with no secret", 401, "unauthorized")
	}
	for _, rq := range [][2]string{
		{"GET", "/api/state/"}, {"GET", "/API/STATE"}, {"GET", "/api/hello/"}, {"GET", "/api"}, {"GET", "/api/"},
		{"GET", "//api/remote/status"}, {"GET", "/api/remote%2fstatus"}, {"HEAD", "/api/remote/status"}, {"OPTIONS", "/api/state"},
	} {
		w := clientDo(h, rq[0], rq[1], testHost, testSecret)
		what := rq[0] + " " + rq[1]
		if rq[0] == "HEAD" { // an answer to HEAD is read by its status
			if w.Code != 404 {
				t.Errorf("%s: status %d, want 404", what, w.Code)
			}
		} else if w.Code != 404 && w.Code != 301 {
			t.Errorf("%s: status %d %s, want 404", what, w.Code, w.Body)
		}
		leaks(what, w.Body.String())
	}
	// A chat id that is a path: no chat, and no file outside the chats folder is looked for.
	w := clientDo(h, "GET", "/api/chats/..%2F..%2Fetc/items", testHost, testSecret)
	if w.Code != 404 || strings.TrimSpace(w.Body.String()) != `{"code":"not_found","error":"no such chat"}` {
		t.Errorf("a chat id that is a path: %d %s", w.Code, w.Body)
	}
	// The routes themselves are served.
	if w := clientDo(h, "GET", "/api/state", testHost, testSecret); w.Code != 200 {
		t.Errorf("GET /api/state: %d %s", w.Code, w.Body)
	}
}
