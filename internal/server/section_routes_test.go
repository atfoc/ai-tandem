package server

import (
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers/standin"
)

// The table of a section's routes, through the real handler: what each row sends to the entry's
// server, what it hands the page, and what is no row at all.

// sectionRow is one row of the table as a page calls it.
type sectionRow struct {
	pattern string // the route as it is for a thing of this server, without /api
	path    string // a path of it, after the prefix and the entry's id
	query   string
	body    string
	limit   string // the time limit of its call: "call", "start", "delete", "scene" or "image"; "" = none is made
	how     string // "" = passed on with nothing looked at; else what this server has a part in
}

// method is the row's method.
func (r sectionRow) method() string {
	m, _, _ := strings.Cut(r.pattern, " ")
	return m
}

// there is the row's route as the entry's server has it.
func (r sectionRow) there() string {
	m, path, _ := strings.Cut(r.pattern, " ")
	return m + " /api" + path
}

// sectionRows is the table: every route under the prefix, each once.
func sectionRows() []sectionRow {
	const (
		chat  = "/chats/" + farChatA
		board = "/boards/" + farBoardA
	)
	return []sectionRow{
		{"POST /groups", "/groups", "", `{"name":"New","parent":""}`, "call", ""},
		{"PATCH /groups/{id}", "/groups/g_1", "", `{"name":"Renamed"}`, "call", "collapsed"},
		{"POST /groups/{id}/move", "/groups/g_1/move", "", `{"parent":"","before":"g_2"}`, "call", ""},
		{"DELETE /groups/{id}", "/groups/g_1", "contents=delete", "", "delete", ""},
		{"POST /groups/{id}/archive", "/groups/g_1/archive", "", "", "start", ""},
		{"POST /groups/{id}/unarchive", "/groups/g_1/unarchive", "", "", "call", ""},

		{"POST /chats", "/chats", "", `{"id":"` + farNewID + `","agent":"claude","group":"g_1"}`, "call", ""},
		{"GET /chats/{id}", chat, "", "", "call", ""},
		{"GET /chats/{id}/context", chat + "/context", "branch=b1&fresh=1", "", "start", ""},
		{"GET /chats/{id}/items", chat + "/items", "branch=b1", "", "call", "follow"},
		{"GET /chats/{id}/tree", chat + "/tree", "", "", "call", "follow"},
		{"GET /chats/{id}/subagents/{sid}/items", chat + "/subagents/sub-1/items", "branch=b1", "", "call", "follow"},
		{"POST /chats/{id}/unfollow", chat + "/unfollow", "", "", "", "here"},
		{"PATCH /chats/{id}", chat, "branch=b1", `{"name":"mine","group":"g_2","model":"standin-model","subDepth":2}`, "call", ""},
		{"POST /chats/{id}/interrupt", chat + "/interrupt", "branch=b1", "", "call", ""},
		{"POST /chats/{id}/permission", chat + "/permission", "branch=b1", `{"requestId":"r1","allow":true}`, "call", ""},
		{"POST /chats/{id}/open", chat + "/open", "branch=b1", "", "start", ""},
		{"POST /chats/{id}/fork", chat + "/fork", "", `{"branch":"main","at":2,"message":2}`, "start", ""},
		{"POST /chats/{id}/archive", chat + "/archive", "", "", "call", ""},
		{"POST /chats/{id}/unarchive", chat + "/unarchive", "", "", "call", ""},
		{"PUT /chats/{id}/label", chat + "/label", "", `{"branch":"main","item":1,"text":"a name"}`, "call", ""},
		{"DELETE /chats/{id}", chat, "", "", "call", ""},
		{"POST /chats/{id}/messages", chat + "/messages", "branch=b1", `{"text":"go on","context":"","references":[{"quote":"q","item":1,"start":0,"end":1}],"target":null}`, "start", "images"},
		{"PUT /chats/{id}/draft", chat + "/draft", "rev=4&branch=b1", `{"text":"typing","mentions":[{"name":"Plan","id":"b_there"}],"later":{"field":[1]}}`, "call", "images"},
		{"POST /chats/{id}/images", chat + "/images", "name=a.png", "", "image", "image"},
		{"GET /chats/{id}/images/{image}", chat + "/images/" + strings.Repeat("a", 64), "", "", "image", "image"},

		{"POST /boards", "/boards", "", `{"name":"Plans","group":"g_1","new":true}`, "call", "board"},
		{"POST /boards/{id}/take", board + "/take", "", `{"ifFree":true}`, "call", "board"},
		{"POST /boards/{id}/release", board + "/release", "", "", "", "here"},
		{"GET /boards/{id}/scene", board + "/scene", "", "", "scene", "board"},
		{"PUT /boards/{id}/scene", board + "/scene", "rev=3", `{"elements":[{"id":"e1"}]}`, "scene", "board"},
		{"POST /boards/{id}/rename", board + "/rename", "", `{"name":"Plans"}`, "call", ""},
		{"POST /boards/{id}/archive", board + "/archive", "", "", "call", ""},
		{"POST /boards/{id}/unarchive", board + "/unarchive", "", "", "call", ""},
		{"POST /boards/{id}/seen", board + "/seen", "", "", "call", ""},
		{"PATCH /boards/{id}", board, "", `{"group":"g_2"}`, "call", ""},
		{"DELETE /boards/{id}", board, "", "", "call", ""},
		{"POST /boards/{id}/reveal", board + "/reveal", "", "", "", "here"},
	}
}

// at is the row's path for the rig's entry, with its query.
func (f *far) at(r sectionRow) string {
	if r.query == "" {
		return f.on(r.path)
	}
	return f.on(r.path) + "?" + r.query
}

// newRowsFar is a far whose stand-in has the things the rows name.
func newRowsFar(t *testing.T, limits remotes.Limits) *far {
	t.Helper()
	return newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)},
		boards: []model.Board{boardThere(farBoardA)}, limits: limits})
}

// The table the handler serves under the prefix is the table of the contract, row for row: a
// route that is added to one and not to the other is found here.
func TestSectionTableIsTheContracts(t *testing.T) {
	t.Parallel()
	var want []string
	for _, r := range sectionRows() {
		m, path, _ := strings.Cut(r.pattern, " ")
		want = append(want, m+" "+sectionPrefix+"{server}"+path)
	}
	got := slices.Clone((&Server{}).sectionRoutes().patterns)
	sort.Strings(want)
	sort.Strings(got)
	if !slices.Equal(got, want) {
		t.Fatalf("the handler has the rows\n%s\nand the contract\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if len(got) != 38 {
		t.Fatalf("%d rows, want the 38 of the contract's table", len(got))
	}
	// The limits of production are the contract's.
	if l := remotes.DefaultLimits; l.Call != 15*time.Second || l.Start != 45*time.Second || l.Scene != 60*time.Second ||
		l.Image != 60*time.Second || l.Delete != 3*time.Minute {
		t.Fatalf("the limits in production: %+v", l)
	}
}

// Every row that is passed on: the entry's server gets the method, the path after the prefix
// with /api in front, the query and the body as they came, and the page gets what that server
// answered as it came, a refusal with its status, its code and its sentence too. All of it goes
// over the entry's one connection.
func TestSectionRoutesPassOn(t *testing.T) {
	t.Parallel()
	f := newRowsFar(t, remotes.Limits{})
	p := f.page("P")
	handshakes := f.st.Handshakes()
	for i, row := range sectionRows() {
		if row.how == "here" || row.how == "image" || row.how == "board" {
			continue // TestSectionRoutesAnsweredHere, TestImageCallsOfASectionArePassedOn, TestBoardOfASectionThroughTheRoutes
		}
		for _, status := range []int{http.StatusOK, http.StatusConflict, http.StatusNotFound, http.StatusInternalServerError} {
			want := map[string]any{"row": float64(i), "status": float64(status), "id": farChatA}
			switch status {
			case http.StatusConflict:
				want["error"], want["code"] = "refused there", "busy"
			case http.StatusNotFound:
				want["error"], want["code"] = "no such thing", "not_found"
			case http.StatusInternalServerError:
				want["error"] = "that server's own failure"
			}
			f.answer(row.there(), status, want)
			got, out := f.call(p, row.method(), f.at(row), row.body)
			if got != status || !reflect.DeepEqual(decode[map[string]any](t, out), want) {
				t.Errorf("%s: %d %s, want %d %v", row.pattern, got, out, status, want)
			}
			c := f.last(row.there())
			if c.Method != row.method() || c.Path != "/api"+row.path || !sameQuery(c.Query, row.query) || c.Body != row.body {
				t.Errorf("%s: the stand-in got %+v", row.pattern, c)
			}
			if row.body != "" && c.Type != "application/json" {
				t.Errorf("%s: the body was sent as %q", row.pattern, c.Type)
			}
		}
		f.handle(row.there(), nil)
	}

	// What a body holds is that server's to judge: one that is no JSON goes on as it came, and so
	// does an id of whatever form, and a query this server does not know.
	odd := "/chats/" + farChatA
	for _, c := range []struct{ method, pat, rest, query, body string }{
		{"POST", "POST /api/chats/{id}/permission", "/permission", "", "{"},
		{"PUT", "PUT /api/chats/{id}/label", "/label", "later=1&branch=b%201", `[1,2]`},
		{"PATCH", "PATCH /api/chats/{id}", "", "", `"words"`},
	} {
		path := f.on(odd + c.rest)
		if c.query != "" {
			path += "?" + c.query
		}
		f.good(p, c.method, path, c.body)
		if got := f.last(c.pat); got.Body != c.body || got.Query != c.query {
			t.Errorf("%s with the body %s: the stand-in got %+v", c.pat, c.body, got)
		}
	}
	for _, id := range []string{"b%20c", "..%2F..%2Fstate", "%2e%2e", "a%3Fb=c"} {
		f.call(p, "GET", f.on("/chats/"+id), "")
		if got := f.last("GET /api/chats/{id}"); got.Path != "/api/chats/"+id {
			t.Errorf("the chat id %q was passed on as %+v", id, got)
		}
	}
	// Nothing of it is kept here.
	if own := f.snapshotOf(p); len(own.Chats) != 0 || len(own.Boards) != 0 || len(own.Groups) != 0 {
		t.Errorf("this server's own lists after the calls: %+v", own)
	}
	// One connection carries everything of the entry: the stream, and every call that was passed
	// on beside it.
	if got := f.st.Handshakes(); got != handshakes || f.st.Streams() != 1 {
		t.Errorf("the calls made %d connections more to the entry's server, which has %d streams; want none and one", got-handshakes, f.st.Streams())
	}
}

// The rows that are answered here in every state of the entry: the unfollow of a chat, the
// release of a board no page holds, and the reveal of a board's file. Nothing is sent
// for them. An id that is no entry is answered as in every other row: 404 "no_server".
func TestSectionRoutesAnsweredHere(t *testing.T) {
	t.Parallel()
	f := newRowsFar(t, remotes.Limits{})
	p := f.page("P")
	rows := []string{"/chats/" + farChatA + "/unfollow", "/boards/" + farBoardA + "/release", "/boards/" + farBoardA + "/reveal"}
	check := func(when string) {
		t.Helper()
		if got := f.good(p, "POST", f.on(rows[0]), ""); !reflect.DeepEqual(got, map[string]any{"ok": true}) {
			t.Errorf("%s, %s: %v", when, rows[0], got)
		}
		if got := f.good(p, "POST", f.on(rows[1]), ""); !reflect.DeepEqual(got, map[string]any{"state": "none"}) {
			t.Errorf("%s, the release of a board no page holds: %v", when, got)
		}
		if text := f.refuses(p, http.StatusBadRequest, "not_here", "POST", f.on(rows[2]), ""); !strings.Contains(text, "no file on this computer") {
			t.Errorf("%s, the reveal: %q", when, text)
		}
	}
	f.untouched("the rows that are answered here", func() {
		check("connected")
		// An id that is no entry, and the local one: a follow of it never began, and it has no board.
		for _, entry := range []string{noSuchServer, "local", "Studio", standin.DefaultInstanceID, "s_"} {
			for _, rest := range rows {
				if text := f.refuses(p, http.StatusNotFound, "no_server", "POST", sectionPrefix+entry+rest, ""); text != "This server is not in the list." {
					t.Errorf("the entry %s, %s: %q", entry, rest, text)
				}
			}
		}
	})
	sent := len(f.st.Requests())
	f.down()
	check("not connected")
	for _, r := range f.st.Requests()[sent:] {
		t.Errorf("the stand-in was sent %s %s", r.Method, r.Path)
	}

	// Without a relay no entry but the local one is known: no id is an entry.
	e := newEnv(t)
	for _, path := range []string{"/chats/c/unfollow", "/boards/b/release", "/boards/b/reveal", "/boards/b/take", "/chats/c", "/nothing"} {
		method, code := "POST", "no_server"
		if path == "/chats/c" || path == "/nothing" {
			method = "GET"
		}
		if path == "/nothing" {
			code = "" // no row
		}
		status, out := e.do(method, sectionPrefix+noSuchServer+path, "")
		if got := decode[struct{ Code string }](t, out); status != http.StatusNotFound || got.Code != code {
			t.Errorf("without a relay, %s %s: %d %s, want 404 %q", method, path, status, out, code)
		}
	}
}

// Each row's call gets the time limit of its kind: with that one limit short and every other
// one long, a call the entry's server does not answer ends soon, as one that got no answer.
func TestSectionLimits(t *testing.T) {
	t.Parallel()
	const short, long = 150 * time.Millisecond, time.Minute
	limits := map[string]remotes.Limits{
		"call":   {Call: short, Start: long, Delete: long, Scene: long, Image: long},
		"start":  {Call: long, Start: short, Delete: long, Scene: long, Image: long},
		"delete": {Call: long, Start: long, Delete: short, Scene: long, Image: long},
		"scene":  {Call: long, Start: long, Delete: long, Scene: short, Image: long},
		"image":  {Call: long, Start: long, Delete: long, Scene: long, Image: short},
	}
	counted := map[string]int{}
	for _, row := range sectionRows() {
		counted[row.limit]++
	}
	if want := map[string]int{"call": 25, "start": 5, "delete": 1, "scene": 2, "image": 2, "": 3}; !reflect.DeepEqual(counted, want) {
		t.Fatalf("the rows by their limit: %v, want %v", counted, want)
	}
	for kind, l := range limits {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			f := newRowsFar(t, l)
			p := f.page("P")
			if kind == "scene" { // a drawing is saved by the page that holds the board
				if got := f.good(p, "POST", f.on("/boards/"+farBoardA+"/take"), ""); got["state"] != "held" {
					t.Fatalf("the take: %v", got)
				}
			}
			var wg sync.WaitGroup
			for _, row := range sectionRows() {
				if row.limit != kind {
					continue
				}
				f.hang(row.there())
				wg.Add(1)
				go func() {
					defer wg.Done()
					start := time.Now()
					body := any(nil)
					if row.body != "" {
						body = row.body
					}
					status, out := p.Do(row.method(), f.at(row), body)
					code := "no_answer"
					if row.pattern == "POST /chats/{id}/messages" {
						code = "send_unknown"
					}
					r := decode[struct{ Error, Code string }](t, string(out))
					if status != http.StatusGatewayTimeout || r.Code != code || !strings.HasPrefix(r.Error, "Studio did not answer") {
						t.Errorf("%s: %d %s, want 504 %s", row.pattern, status, out, code)
					}
					if took := time.Since(start); took > long/3 {
						t.Errorf("%s was ended after %v: by another limit than the one of a %s", row.pattern, took, kind)
					}
				}()
			}
			wg.Wait()
		})
	}
}

// A path under the prefix that is no row of the table is 404 {"error":"not found"}, whatever
// the entry is, and nothing is sent: a route the entry's server has and a section has not (the
// server list, the settings, a call's answer), a row's path with another method, and a path the
// mux would redirect.
func TestAnythingElseUnderThePrefixIsNotFound(t *testing.T) {
	t.Parallel()
	f := newRowsFar(t, remotes.Limits{})
	p := f.page("P")
	chat, run, board := "/chats/"+farChatA, "/runs/r_aaaa0001", "/boards/"+farBoardA
	none := [][2]string{
		{"GET", ""}, {"GET", "/"}, {"POST", ""},
		// What a remote server serves a client, or its own page, and no section has.
		{"GET", "/state"}, {"GET", "/events"}, {"GET", "/hello"}, {"GET", "/dirs"}, {"GET", "/usage/claude"},
		{"POST", "/rpc-reply"}, {"GET", "/library"}, {"POST", "/library/groups"}, {"POST", "/restart"},
		{"GET", "/servers"}, {"POST", "/servers"}, {"DELETE", "/servers/" + f.entry}, {"GET", "/remote/status"},
		{"GET", "/mcp/status"}, {"POST", "/client/flushed"},
		// A section of that server is no part of its tree.
		{"GET", "/on/" + f.entry + chat}, {"POST", "/on/" + f.entry + "/chats"},
		// Groups.
		{"GET", "/groups"}, {"PUT", "/groups/order"}, {"GET", "/groups/g_1"}, {"PUT", "/groups/g_1"}, {"POST", "/groups/g_1"},
		{"GET", "/groups/g_1/move"}, {"DELETE", "/groups/g_1/archive"},
		// Chats: the make of a client, and a row's path with another method or one segment more.
		{"GET", "/chats"}, {"DELETE", "/chats"}, {"PUT", chat}, {"POST", chat}, {"GET", chat + "/messages"}, {"PUT", chat + "/messages"},
		{"GET", chat + "/draft"}, {"POST", chat + "/draft"}, {"GET", chat + "/unfollow"}, {"POST", chat + "/items"}, {"GET", chat + "/nothing"},
		{"GET", chat + "/items/1"}, {"GET", chat + "/images"}, {"POST", chat + "/images/" + strings.Repeat("a", 64)}, {"GET", chat + "/subagents/s1"},
		// Runs: this server has none, a server built with runs has them.
		{"POST", "/runs"}, {"GET", run}, {"PATCH", run}, {"GET", run + "/detail"}, {"POST", run + "/start"}, {"POST", run + "/unfollow"},
		// Boards: the creation call of a client.
		{"GET", "/boards"}, {"PUT", board}, {"GET", board}, {"GET", board + "/take"}, {"DELETE", board + "/scene"}, {"POST", board + "/scene"},
		{"GET", board + "/reveal"}, {"GET", board + "/release"},
		// Paths in another form.
		{"GET", "//chats/" + farChatA}, {"GET", "/chats//items"}, {"GET", chat + "/"}, {"GET", chat + "/../" + farChatA + "/items"},
		{"GET", "/./chats/" + farChatA},
	}
	sent := len(f.st.Requests())
	f.untouched("a path that is no row", func() {
		for _, entry := range []string{f.entry, noSuchServer, "local"} {
			for _, c := range none {
				path := sectionPrefix + entry + c[1]
				if c[1] == "" {
					path = strings.TrimSuffix(sectionPrefix, "/")
					if c[0] == "POST" {
						path = sectionPrefix
					}
				}
				status, out := f.call(p, c[0], path, "")
				if status != http.StatusNotFound || strings.TrimSpace(out) != `{"error":"not found"}` {
					t.Errorf("%s %s: %d %s", c[0], path, status, out)
				}
			}
		}
	})
	if got := f.st.Requests(); len(got) != sent {
		t.Errorf("the stand-in was sent %+v", got[sent:])
	}
	// A path beside the prefix is not the table's.
	if status, out := f.call(p, "GET", "/api/once", ""); status != http.StatusNotFound || strings.Contains(out, `"error"`) {
		t.Errorf("a path beside the prefix: %d %s", status, out)
	}
}

// Every write under the prefix needs a known client, as every write on this port: a call
// without the header, or with an id that has no stream, is refused before the table, whatever
// the entry and the path are, and nothing is sent. A read needs none.
func TestSectionWritesNeedAKnownClient(t *testing.T) {
	t.Parallel()
	f := newRowsFar(t, remotes.Limits{})
	p := f.page("P")
	writes := 0
	sent := len(f.st.Requests())
	f.untouched("a call of no known client", func() {
		for _, row := range sectionRows() {
			if row.method() == "GET" {
				continue
			}
			writes++
			for _, client := range []string{"", "nobody"} {
				for _, entry := range []string{f.entry, noSuchServer} {
					path := sectionPrefix + entry + row.path
					if row.query != "" {
						path += "?" + row.query
					}
					status, out := f.doAs(client, row.method(), path, row.body)
					if status != http.StatusConflict || decode[map[string]string](t, out)["error"] != "unknown_client" {
						t.Errorf("%s of the client %q on %s: %d %s", row.pattern, client, entry, status, out)
					}
				}
			}
		}
		// A path that is no row is refused the same way: the guard does not know the table.
		if status, _ := f.doAs("", "POST", f.on("/nothing"), ""); status != http.StatusConflict {
			t.Errorf("a write on a path that is no row, of no client: %d", status)
		}
	})
	if writes != 31 {
		t.Fatalf("%d rows that are no read, want 31", writes)
	}
	if got := f.st.Requests(); len(got) != sent {
		t.Errorf("the stand-in was sent %+v", got[sent:])
	}
	if _, held := f.s.Bridge.HolderOf(editorbridge.BoardOn(f.entry, farBoardA)); held {
		t.Error("a take of no known client gave the board")
	}
	// A read is served to whoever asks on this port, and follows nothing for a client that has
	// no stream.
	if status, out := f.doAs("", "GET", f.on("/chats/"+farChatA), ""); status != 200 {
		t.Errorf("a read without a client: %d %s", status, out)
	}
	if status, out := f.doAs("nobody", "GET", f.on("/chats/"+farChatA+"/items"), ""); status != 200 {
		t.Errorf("a read that follows, of a client with no stream: %d %s", status, out)
	}
	if f.s.Bridge.Followed(editorbridge.ChatOn(f.entry, farChatA)) {
		t.Error("a client with no stream follows the chat")
	}
	// The same calls of a known client are taken.
	f.good(p, "POST", f.on("/chats/"+farChatA+"/interrupt"), "")
}

// What is refused here, with nothing sent: "collapsed" in the change of a group, whatever its
// value and however the key is spelled; a draft call with ?replace=; and a drawing that is too
// large, or is saved on no revision.
func TestSectionRefusalsHere(t *testing.T) {
	t.Parallel()
	f := newRowsFar(t, remotes.Limits{})
	p := f.page("P")
	group := f.on("/groups/" + farGroup)
	const patch = "PATCH /api/groups/{id}"
	f.untouched("a change of a group that names collapsed", func() {
		for _, body := range []string{`{"collapsed":true}`, `{"collapsed":false}`, `{"name":"Mine","collapsed":null}`, `{"Collapsed":true}`,
			`{"COLLAPSED":1,"name":"Mine"}`, `{"collapsed":"yes"}`, `{"name":"a","collapsed":true,"collapsed":false}`} {
			if text := f.refuses(p, http.StatusBadRequest, "collapsed_refused", "PATCH", group, body); text == "" {
				t.Errorf("PATCH %s: no sentence", body)
			}
		}
	})
	// Without the key the change goes on as it came: "collapsed" as a value, or below the top, is none.
	for _, body := range []string{`{"name":"Mine"}`, `{"name":"collapsed"}`, `{"name":"x","later":{"collapsed":true}}`, `["collapsed"]`} {
		f.good(p, "PATCH", group, body)
		if got := f.last(patch); got.Body != body || got.Path != "/api/groups/"+farGroup {
			t.Errorf("PATCH %s was passed on as %+v", body, got)
		}
	}

	draft := f.on("/chats/" + farChatA + "/draft")
	f.untouched("a draft call with a replace", func() {
		for _, query := range []string{"replace=4", "replace=", "replace=4&rev=4", "rev=4&branch=main&replace=x"} {
			f.refuses(p, http.StatusBadRequest, "replace_refused", "PUT", draft+"?"+query, `{"text":"x"}`)
		}
	})

	scene := f.on("/boards/" + farBoardA + "/scene")
	f.good(p, "POST", f.on("/boards/"+farBoardA+"/take"), "")
	f.untouched("a drawing that is not saved", func() {
		// One byte over the limit, with its length stated and without.
		for _, stated := range []bool{true, false} {
			var body io.Reader = io.LimitReader(zeros{}, sectionSceneMax+1)
			if !stated {
				body = noLength{body}
			}
			req, _ := http.NewRequest("PUT", f.url+scene+"?rev=3", body)
			if stated {
				req.ContentLength = sectionSceneMax + 1
			}
			req.Header.Set(ClientHeader, p.ID)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatalf("a drawing over the limit: %v", err)
			}
			out, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if r := decode[struct{ Error, Code string }](t, string(out)); resp.StatusCode != http.StatusRequestEntityTooLarge || r.Code != "too_large" || !strings.Contains(r.Error, "32 MB") {
				t.Errorf("a drawing over the limit (length stated: %v): %d %s", stated, resp.StatusCode, out)
			}
		}
		for query, part := range map[string]string{"": "rev is missing", "?rev=x": "rev is not a number", "?rev=-1": "rev is not a number"} {
			if status, out := f.call(p, "PUT", scene+query, `{"elements":[]}`); status != http.StatusBadRequest || !strings.Contains(out, part) {
				t.Errorf("a save with the query %q: %d %s", query, status, out)
			}
		}
		// A take whose body cannot be read.
		if status, out := f.call(p, "POST", f.on("/boards/"+farBoardB+"/take"), `{"ifFree":`); status != http.StatusBadRequest {
			t.Errorf("a take with a cut body: %d %s", status, out)
		}
	})
	// A drawing of exactly the limit is passed on.
	big := `{"elements":[],"pad":"` + strings.Repeat("a", sectionSceneMax-len(`{"elements":[],"pad":""}`)) + `"}`
	if len(big) != sectionSceneMax {
		t.Fatalf("the drawing has %d bytes", len(big))
	}
	if got := f.good(p, "PUT", scene+"?rev=3", big); got["rev"] != 4.0 {
		t.Fatalf("a drawing of the limit: %v", got)
	}
	if got := f.last("PUT /api/boards/{id}/scene"); len(got.Body) != sectionSceneMax || got.Query != "rev=3" {
		t.Fatalf("the drawing that was passed on: %d bytes with %q", len(got.Body), got.Query)
	}
}

// On the remote listener there is no section: this server passes nothing on for its own API
// clients, tells them nothing of the trees it holds, and asks no other server for folders or
// usage.
func TestRemoteListenerHasNoSection(t *testing.T) {
	t.Parallel()
	l := newListener(t)
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}, boards: []model.Board{boardThere(farBoardA)},
		with: []func(*Server){l.set, func(s *Server) { s.App.Home = "/home/owner" }}})
	l.serve(f.s)
	p := f.page("P")
	f.good(p, "GET", f.on("/chats/"+farChatA+"/items"), "") // a page is served the section
	here := t.TempDir()

	sent := len(f.st.Requests())
	f.untouched("an API client", func() {
		for _, row := range sectionRows() {
			path := f.on(row.path)
			if row.query != "" {
				path += "?" + row.query
			}
			if status, out := l.call(apiX, testSecret, row.method(), path, row.body); status != http.StatusNotFound || strings.TrimSpace(out) != `{"error":"not found"}` {
				t.Errorf("an API client's %s: %d %s", row.pattern, status, out)
			}
		}
		// The things of a section are no things of this server, for a client as for a page.
		for _, c := range [][2]string{{"GET", "/api/chats/" + farChatA}, {"GET", "/api/chats/" + farChatA + "/items"},
			{"GET", "/api/boards/" + farBoardA + "/scene"}} {
			if status, out := l.call(apiX, testSecret, c[0], c[1], ""); status != http.StatusNotFound {
				t.Errorf("an API client's %s %s: %d %s", c[0], c[1], status, out)
			}
		}
		// Its snapshot is this server's own: no section, no list of the entry, nothing of its tree.
		status, out := l.call(apiX, testSecret, "GET", "/api/state", "")
		if status != 200 || strings.Contains(out, f.entry) || strings.Contains(out, farChatA) || strings.Contains(out, `"sections"`) || strings.Contains(out, `"servers"`) {
			t.Errorf("an API client's snapshot: %d %s", status, out)
		}
		// "server" in a client's query is ignored: the folders and the usage are this machine's.
		status, out = l.call(apiX, testSecret, "GET", "/api/dirs?server="+f.entry+"&path="+here, "")
		if got := decode[map[string]any](t, out); status != 200 || got["dirs"] == nil {
			t.Errorf("an API client's folders with a server named: %d %s", status, out)
		}
		if status, out = l.call(apiX, testSecret, "GET", "/api/usage/claude?server="+f.entry, ""); status != 200 {
			t.Errorf("an API client's usage with a server named: %d %s", status, out)
		}
	})
	if got := f.st.Requests(); len(got) != sent {
		t.Errorf("the stand-in was sent %+v", got[sent:])
	}
	if n := f.usage[model.Claude].Load(); n != 1 {
		t.Errorf("this server's usage was read %d times for the client, want 1", n)
	}
	var snap map[string]json.RawMessage
	json.Unmarshal([]byte(mustOK(t, f, p, "GET", "/api/state", "")), &snap)
	if _, has := snap["sections"]; !has {
		t.Error("a page's snapshot has no sections")
	}
}
