package server

import (
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// The level of a client: hello is open to every app, every other route refuses a client that
// states no level or one below 6, and the refusal has its place among the listener's checks and
// its line in the log.

// l5Old is what a client that is refused states as its level: nothing, a level below 6, and
// values that are no integer.
var l5Old = []string{"", "5", "4", "1", "0", "-5", "5.9", "6.0", "six", "v6", "6x"}

// l5Tree makes one group with a board and a chat, as the owner, and returns the three ids. Their
// names are ones no other answer holds by chance.
func l5Tree(e *env) (group, board, chat string) {
	e.t.Helper()
	group = l5ID(e.t, e.expect(200, "POST", "/api/groups", `{"name":"The owners group"}`))
	board = l5ID(e.t, e.expect(200, "POST", "/api/boards", `{"name":"The owners board","group":"`+group+`"}`))
	e.expect(200, "POST", "/api/boards/"+board+"/release", "")
	chat = l5ID(e.t, e.expect(200, "POST", "/api/chats", `{"agent":"claude","group":"`+group+`"}`))
	e.expect(200, "PATCH", "/api/chats/"+chat, `{"name":"The owners chat"}`)
	return group, board, chat
}

// l5PathOf is the path of a route of the table with its wildcards filled: a chat's id under
// /api/chats, a board's under /api/boards, a group's under /api/groups, and a made-up value for
// every other wildcard.
func l5PathOf(route, group, board, chat string) (method, path string) {
	method, path, _ = strings.Cut(route, " ")
	id := "r_nothere1"
	switch {
	case strings.HasPrefix(path, "/api/chats/"):
		id = chat
	case strings.HasPrefix(path, "/api/boards/"):
		id = board
	case strings.HasPrefix(path, "/api/groups/"):
		id = group
	}
	path = strings.Replace(path, "{id}", id, 1)
	for _, kv := range [][2]string{{"{sid}", "s1"}, {"{image}", "img1"}, {"{agent}", "claude"}, {"{tid}", "t1"}, {"{n}", "1"}, {"{v}", "1"}, {"{server}", "local"}} {
		path = strings.Replace(path, kv[0], kv[1], 1)
	}
	return method, path
}

func TestLevel5HelloIsOpenToEveryLevel(t *testing.T) {
	t.Parallel()
	_, l := remoteEnv(t)
	if FeatureLevel != 6 || MinClientLevel != 6 || LevelHeader != "X-AIWB-Level" {
		t.Fatalf("the level is %d, the lowest client level %d, the header %q", FeatureLevel, MinClientLevel, LevelHeader)
	}
	for _, level := range append(slices.Clone(l5Old), "6", "7", "40") {
		for _, id := range []string{apiX, ownID, "", "client-1"} { // any id, and none, may ask hello
			for _, secret := range []string{testSecret, ""} { // and no secret is needed
				status, out := l.callAt(level, id, secret, "GET", "/api/hello", "")
				if status != 200 || !strings.Contains(out, `"featureLevel":6`) {
					t.Fatalf("hello for a client that states the level %q: %d %s", level, status, out)
				}
				if got := keysOf(t, out); !slices.Equal(got, []string{"app", "featureLevel", "instanceId", "version"}) {
					t.Fatalf("hello for a client that states the level %q has the fields %v", level, got)
				}
				if got := decode[map[string]any](t, out); got["app"] != "ai-whiteboard" || got["instanceId"] != ownID {
					t.Fatalf("hello: %s", out)
				}
			}
		}
	}
	// Hello is the GET alone: another method on its path is no route of the table.
	status, out := l.callAt("4", apiX, testSecret, "POST", "/api/hello", "")
	l5Is(t, "POST /api/hello of an older client", status, strings.TrimSpace(out), 400, l5TooOld)
}

func TestLevel5RefusesAnOlderClient(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	group, board, chat := l5Tree(e)
	h := e.s.ClientHandler()
	before := e.expect(200, "GET", "/api/state", "")

	// Every route of the table but hello, and routes outside it: the same answer, whatever the
	// method, and whether or not the thing named is there.
	routes := append(slices.Clone(ClientRoutes[1:]), "GET /api/mcp/status", "GET /api/remote/status", "POST /api/restart", "PUT /api/groups/order",
		"GET /api/servers", "POST /api/servers", "GET "+relayPrefix+"/s_0123456789ab/chats/"+chat, "POST /api/client/flushed", "GET /", "GET /index.html",
		"PUT /api/chats/{id}", "PUT /api/boards/{id}", "GET /api/nothing", "DELETE /api/state")
	if ClientRoutes[0] != "GET /api/hello" {
		t.Fatalf("the table's first route is %q", ClientRoutes[0])
	}
	for _, level := range l5Old {
		for _, route := range routes {
			method, path := l5PathOf(route, group, board, chat)
			body := ""
			if method != "GET" && method != "DELETE" {
				body = `{"name":"By an older app","group":"` + group + `","agent":"claude","text":"hello"}`
			}
			status, out := l5Ask(h, l, l5Req{method: method, path: path, body: body, secret: testSecret, client: apiX, level: level})
			l5Is(t, fmt.Sprintf("%s for a client that states the level %q", route, level), status, out, 400, l5TooOld)
		}
	}
	if !strings.Contains(l5TooOld, `"code":"client_too_old"`) || !strings.Contains(l5TooOld, `"error":"This app is too old for this server: update AI Whiteboard on the machine that connects."`) {
		t.Fatalf("the refusal the test asks for is %s", l5TooOld)
	}
	// Nothing was made, changed or deleted by any of them.
	if after := e.expect(200, "GET", "/api/state", ""); after != before {
		t.Errorf("the refused calls changed the server:\nbefore %s\nafter  %s", before, after)
	}

	// Over the real listener: the state and the stream. Nothing of the tree is in the answer,
	// and the stream opens no record of the client.
	for _, level := range []string{"", "4", "garbage"} {
		for _, path := range []string{"/api/state", "/api/events", "/api/chats/" + chat, "/api/chats/" + chat + "/items", "/api/boards/" + board + "/scene"} {
			status, out := l.callAt(level, apiX, testSecret, "GET", path, "")
			l5Is(t, fmt.Sprintf("GET %s for a client that states the level %q", path, level), status, strings.TrimSpace(out), 400, l5TooOld)
			for _, part := range []string{group, board, chat, "The owners", "groups", "chats", "boards"} {
				if strings.Contains(out, part) {
					t.Errorf("the refusal of GET %s holds %q: %s", path, part, out)
				}
			}
		}
	}
	if e.s.Bridge.Known(apiX) {
		t.Error("the refused stream made the client a known one")
	}

	// Level 6 and above are served: the state holds the tree, the stream opens, and a route
	// outside the table is the listener's 404.
	for _, level := range []string{"6", "7", "40"} {
		status, out := l.callAt(level, apiX, testSecret, "GET", "/api/state", "")
		if status != 200 || !strings.Contains(out, group) || !strings.Contains(out, board) || !strings.Contains(out, chat) {
			t.Errorf("the state for a client of level %s: %d %s", level, status, out)
		}
		if status, out := l.callAt(level, apiX, testSecret, "GET", "/api/events", ""); status != 200 {
			t.Errorf("the stream for a client of level %s: %d %s", level, status, out)
		}
		status, out = l.callAt(level, apiX, testSecret, "GET", "/api/mcp/status", "")
		l5Is(t, "a route outside the table for a client of level "+level, status, strings.TrimSpace(out), 404, l5Gate)
	}
}

// The checks of the client listener come in one order: the secret, the Host, the client id, the
// server's own id, the level, the table. Each request below fails every check after the one
// that answers it.
func TestLevel5OrderOfTheChecks(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	_, _, chat := l5Tree(e)
	h := e.s.ClientHandler()
	const (
		evil     = "evil.example:4748"
		noSecret = `{"error":"unauthorized"}`
		badHost  = `{"error":"bad host"}`
		badID    = `{"code":"bad_client","error":"bad client id"}`
		ownsID   = `{"code":"own_client","error":"this is the server's own id"}`
	)
	wrong := strings.Replace(testSecret, "0", "f", 1)
	// In the table, outside it, and hello.
	paths := [][2]string{{"GET", "/api/state"}, {"GET", "/api/events"}, {"GET", "/api/chats/" + chat}, {"POST", "/api/chats"},
		{"GET", "/api/mcp/status"}, {"GET", "/"}, {"PUT", "/api/chats/" + chat}}
	for _, p := range paths {
		what := p[0] + " " + p[1]
		ask := func(rq l5Req) (int, string) {
			rq.method, rq.path = p[0], p[1]
			return l5Ask(h, l, rq)
		}
		// 1. No secret, or a wrong one: 401, with a bad Host, a bad client id and no level.
		for _, secret := range []string{"", wrong} {
			status, out := ask(l5Req{secret: secret, host: evil, client: "client-1"})
			l5Is(t, what+" without the secret, and everything else wrong", status, out, 401, noSecret)
			status, out = ask(l5Req{secret: secret, client: apiX, level: testLevel})
			l5Is(t, what+" without the secret, and everything else right", status, out, 401, noSecret)
		}
		// 2. The Host: 403, with a bad client id and no level.
		status, out := ask(l5Req{secret: testSecret, host: evil, client: "client-1"})
		l5Is(t, what+" with a bad Host, a bad client id and no level", status, out, 403, badHost)
		status, out = ask(l5Req{secret: testSecret, host: evil, client: ownID, level: "4"})
		l5Is(t, what+" with a bad Host, the server's own id and an old level", status, out, 403, badHost)
		// 3. The client id: 400 bad_client, with no level, and outside the table too.
		for _, id := range []string{"", "client-1", strings.ToUpper(apiX)} {
			for _, level := range []string{"", "4", testLevel} {
				status, out = ask(l5Req{secret: testSecret, client: id, level: level})
				l5Is(t, fmt.Sprintf("%s with the client id %q and the level %q", what, id, level), status, out, 400, badID)
			}
		}
		// 4. The server's own id: 400 own_client before the level is looked at.
		for _, level := range []string{"", "4", testLevel} {
			status, out = ask(l5Req{secret: testSecret, client: ownID, level: level})
			l5Is(t, fmt.Sprintf("%s with the server's own id and the level %q", what, level), status, out, 400, ownsID)
		}
		// 5. The level: 400 client_too_old, for a route outside the table too.
		status, out = ask(l5Req{secret: testSecret, client: apiX, level: "4"})
		l5Is(t, what+" with an old level", status, out, 400, l5TooOld)
	}
	// 6. The table: with everything right, a route outside it is 404.
	for _, p := range paths[4:] {
		status, out := l5Ask(h, l, l5Req{method: p[0], path: p[1], secret: testSecret, client: apiX, level: testLevel})
		l5Is(t, p[0]+" "+p[1]+" with everything right", status, out, 404, l5Gate)
	}
	// Hello needs the Host and nothing else: no secret, no client id, no level.
	hello := func(rq l5Req) (int, string) {
		rq.method, rq.path = "GET", "/api/hello"
		return l5Ask(h, l, rq)
	}
	status, out := hello(l5Req{host: evil, client: "client-1"})
	l5Is(t, "hello with a bad Host and no secret", status, out, 403, badHost)
	status, out = hello(l5Req{secret: testSecret, host: evil, client: "client-1"})
	l5Is(t, "hello with a bad Host", status, out, 403, badHost)
	for _, rq := range []l5Req{{client: "client-1"}, {secret: testSecret, client: "client-1"}, {client: ownID}, {}} {
		if status, out = hello(rq); status != 200 || !strings.Contains(out, `"featureLevel":6`) {
			t.Errorf("hello with %+v: %d %s", rq, status, out)
		}
	}
	if _, err := os.Stat(e.st.P.ChatDir(chat)); err != nil {
		t.Errorf("the chat after the refused calls: %v", err)
	}
	if n := len(e.a.Chats.Views()); n != 1 {
		t.Errorf("%d chats after the refused calls, want the one", n)
	}
}

// The refusal of an older client is logged like a refused request: one line per source address
// per minute, with the method, the path and the sentence, and nothing the caller chose beyond
// them.
func TestLevel5RefusalIsLoggedOncePerAddressAMinute(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	rm := e.s.Clients
	now := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	rm.now = func() time.Time { return now }
	h := e.s.ClientHandler()
	ask := func(addr, level, method, path string) int {
		status, _ := l5Ask(h, l, l5Req{method: method, path: path, secret: testSecret, client: apiX, level: level, addr: addr})
		return status
	}
	want := func(what string, lines ...string) {
		t.Helper()
		if got := l.logged(); !slices.Equal(got, lines) {
			t.Fatalf("%s: logged %q, want %q", what, got, lines)
		}
	}
	line := func(ip, method, path string) string {
		return "remote listener: refused 400 from " + ip + ": " + method + ` "` + path + `": ` + l5Sentence
	}

	if ask("10.0.0.1:5000", "", "GET", "/api/state") != 400 {
		t.Fatal("a client with no level was not refused")
	}
	l1 := line("10.0.0.1", "GET", "/api/state")
	want("the first refusal", l1)
	// The same address within the minute, from another port, on another route, with another
	// level, and refused for its secret or its Host: nothing more.
	ask("10.0.0.1:5001", "4", "GET", "/api/events")
	ask("10.0.0.1:5002", "garbage", "POST", "/api/chats")
	l5Ask(h, l, l5Req{method: "GET", path: "/api/state", client: apiX, level: testLevel, addr: "10.0.0.1:5003"})
	l5Ask(h, l, l5Req{method: "GET", path: "/api/state", secret: testSecret, host: "evil.example:1", client: apiX, level: testLevel, addr: "10.0.0.1:5004"})
	now = now.Add(59 * time.Second)
	ask("10.0.0.1:5005", "", "DELETE", "/api/chats/"+chat1)
	want("the same address within a minute", l1)
	// Another address has its own line, which names its method and its path.
	ask("10.0.0.2:5000", "4", "POST", "/api/chats/"+chat1+"/messages")
	l2 := line("10.0.0.2", "POST", "/api/chats/"+chat1+"/messages")
	want("another address", l1, l2)
	// What is served is not logged: hello for an older client, a call and a 404 at level 5. Nor
	// is a refusal for the client id.
	if ask("10.0.0.3:5000", "4", "GET", "/api/hello") != 200 || ask("10.0.0.3:5000", testLevel, "GET", "/api/state") != 200 ||
		ask("10.0.0.3:5000", testLevel, "GET", "/api/mcp/status") != 404 {
		t.Fatal("hello, the state or a route outside the table: unexpected status")
	}
	l5Ask(h, l, l5Req{method: "GET", path: "/api/state", secret: testSecret, client: "client-1", addr: "10.0.0.3:5001"})
	l5Ask(h, l, l5Req{method: "GET", path: "/api/state", secret: testSecret, client: ownID, addr: "10.0.0.3:5002"})
	want("served requests and a bad client id", l1, l2)
	// After the minute the first address is logged again.
	now = now.Add(time.Second)
	ask("10.0.0.1:5006", "", "GET", "/api/events")
	l3 := line("10.0.0.1", "GET", "/api/events")
	want("after a minute", l1, l2, l3)
	// A refusal for the secret counts for the same minute of its address.
	l5Ask(h, l, l5Req{method: "GET", path: "/api/state", client: apiX, addr: "10.0.0.4:5000"})
	ask("10.0.0.4:5001", "", "GET", "/api/state")
	want("an address refused for its secret first", l1, l2, l3, `remote listener: refused 401 from 10.0.0.4: GET "/api/state"`)
	// A long path is cut, and a level is never in the line.
	long := "/api/" + strings.Repeat("a", 200)
	ask("10.0.0.5:5000", "level-of-the-caller", "GET", long)
	want("a long path", l1, l2, l3, `remote listener: refused 401 from 10.0.0.4: GET "/api/state"`, line("10.0.0.5", "GET", long[:80]))
	for _, got := range l.logged() {
		if strings.Contains(got, testSecret) || strings.Contains(got, apiX) || strings.Contains(got, "level-of-the-caller") {
			t.Errorf("a log line holds the secret, the client id or the level: %q", got)
		}
	}
}

// The same over the real listener: two refused requests of one address leave one line.
func TestLevel5RefusalIsLoggedOverTheListener(t *testing.T) {
	t.Parallel()
	_, l := remoteEnv(t)
	for _, path := range []string{"/api/state", "/api/events", "/api/chats/" + chat1} {
		status, out := l.callAt("4", apiX, testSecret, "GET", path, "")
		l5Is(t, "GET "+path+" of an older client", status, strings.TrimSpace(out), 400, l5TooOld)
	}
	want := []string{`remote listener: refused 400 from 127.0.0.1: GET "/api/state": ` + l5Sentence}
	if got := l.logged(); !slices.Equal(got, want) {
		t.Fatalf("logged %q, want %q", got, want)
	}
	// A client of level 5 on the same address is served and adds nothing.
	if status, out := l.call(apiX, testSecret, "GET", "/api/state", ""); status != 200 || !strings.Contains(out, `"groups":[]`) {
		t.Fatalf("the state of a client of level 5: %d %s", status, out)
	}
	if got := l.logged(); !slices.Equal(got, want) {
		t.Fatalf("logged %q, want %q", got, want)
	}
}
