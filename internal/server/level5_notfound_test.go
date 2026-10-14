package server

import (
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// The code "not_found" (contract 2.4): on both listeners, a 404 whose cause is that the chat,
// the board or the group the call names is not there carries it, and a 404 for a part
// of a thing that is there keeps what it had. It is how a client and a page tell "the thing is
// gone" from "a part of it is missing".

// The ids of things no server of a test has.
const (
	l5NoChat  = chat3
	l5NoBoard = "b_nothere1"
	l5NoGroup = "g_nothere1"
	l5NoImage = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)

// l5Bodies is, for the routes that read a body or a query before they look the thing up, a
// query and a body that pass that reading.
var l5Bodies = map[string][2]string{
	"PATCH /api/groups/{id}":          {"", `{"name":"Renamed"}`},
	"POST /api/groups/{id}/move":      {"", `{"parent":"","before":""}`},
	"DELETE /api/groups/{id}":         {"?contents=keep", ""},
	"PATCH /api/chats/{id}":           {"", `{"name":"Renamed"}`},
	"POST /api/chats/{id}/messages":   {"", `{"text":"hello"}`},
	"POST /api/chats/{id}/permission": {"", `{"requestId":"perm-1","allow":true}`},
	"PUT /api/chats/{id}/label":       {"", `{"branch":"main","item":0,"text":"label"}`},
	"PUT /api/chats/{id}/draft":       {"?rev=0", `{"text":"typed"}`},
	"POST /api/chats/{id}/images":     {"?name=dot.png", `not an image`},
	"POST /api/chats/{id}/fork":       {"", `{"branch":"main","at":1}`},
	"PUT /api/boards/{id}/scene":      {"?rev=0", `{"type":"excalidraw","elements":[]}`},
	"POST /api/boards/{id}/rename":    {"", `{"name":"renamed"}`},
	"PATCH /api/boards/{id}":          {"", `{"group":"` + model.Ungrouped + `"}`},
}

// l5NotLookups is the routes with an {id} that look nothing up: each ends something for the
// caller, and there is nothing to end for a thing that is not there.
var l5NotLookups = map[string]string{
	"POST /api/chats/{id}/unfollow": `{"ok":true}`,
	"POST /api/boards/{id}/release": `{"state":"none"}`,
}

// l5Kind is what a route with an {id} names: its path's word after /api/, the id of a thing of
// that kind that is not there, and the sentence of its refusal.
func l5Kind(route string) (id, sentence string, named bool) {
	_, path, _ := strings.Cut(route, " ")
	switch {
	case !strings.Contains(path, "{id}"):
	case strings.HasPrefix(path, "/api/chats/"):
		return l5NoChat, "no such chat", true
	case strings.HasPrefix(path, "/api/boards/"):
		return l5NoBoard, "no such board", true
	case strings.HasPrefix(path, "/api/groups/"):
		return l5NoGroup, `no such group \"` + l5NoGroup + `\"`, true
	}
	return "", "", false
}

// Every route that names a chat, a board or a group by its id answers 404 "not_found"
// when there is none, on the remote port and on the server's own, with the same body.
func TestLevel5NotFoundOnEveryRouteWithAnID(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	before := l5Want(t, s.p, 200, "GET", "/api/state", nil)
	asked := 0
	for _, route := range s.s.routes().patterns {
		id, sentence, named := l5Kind(route)
		if !named || strings.HasSuffix(route, "/reveal") { // the reveal opens this machine's file manager
			continue
		}
		method, path, _ := strings.Cut(route, " ")
		path = strings.NewReplacer("{id}", id, "{sid}", "s1", "{image}", l5NoImage, "{tid}", "t1", "{n}", "1", "{v}", "1").Replace(path)
		var body any
		if b := l5Bodies[route][1]; b != "" {
			body = b
		}
		path += l5Bodies[route][0]
		want := `{"code":"not_found","error":"` + sentence + `"}`
		for _, c := range s.all() {
			if c != s.p && !slices.Contains(ClientRoutes, route) {
				continue // outside the table: the owner's alone
			}
			status, out := l5Call(c, method, path, body)
			if answer, plain := l5NotLookups[route]; plain {
				l5Is(t, route+" for a thing that is not there, by "+s.who(c), status, out, 200, answer)
				continue
			}
			l5Is(t, route+" for a thing that is not there, by "+s.who(c), status, out, 404, want)
			asked++
		}
	}
	if asked < 90 { // some thirty routes, each asked by the three
		t.Errorf("only %d calls were asked: the routes with an {id} are not what the test thinks", asked)
	}
	// A thing named in the body: the board a new chat is for.
	for _, c := range s.all() {
		for body, sentence := range map[string]string{
			`{"agent":"claude","board":"` + l5NoBoard + `"}`: "no such board",
		} {
			status, out := l5Call(c, "POST", "/api/chats", body)
			l5Is(t, "POST /api/chats "+body+" by "+s.who(c), status, out, 404, `{"code":"not_found","error":"`+sentence+`"}`)
		}
	}
	// Nothing was made by any of it, and nobody follows what is not there.
	if after := l5Want(t, s.p, 200, "GET", "/api/state", nil); after != before {
		t.Errorf("the calls for things that are not there changed the server:\nbefore %s\nafter  %s", before, after)
	}
	if got := s.s.Bridge.Followers(editorbridge.Chat(l5NoChat)); len(got) != 0 {
		t.Errorf("the followers of the chat that is not there: %v", got)
	}
	for i, evs := range s.reach(s.all()...) {
		if len(evs) != 0 {
			t.Errorf("the calls for things that are not there sent %s %v", s.who(s.all()[i]), evs)
		}
	}
}

// A 404 for a part that is missing of a thing that is there keeps its own answer: a branch, a
// subagent, an image. None of them says "not_found".
func TestLevel5MissingPartIsNotNotFound(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	chat := l5ID(t, l5Want(t, s.p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+model.Ungrouped+`"}`))

	for _, c := range []struct {
		what, method, path, body string
		answer                   string
	}{
		{"a draft for a branch the chat does not have", "PUT", "/api/chats/" + chat + "/draft?rev=0&branch=nothere", `{"text":"typed"}`, `{"code":"no_branch","error":"no such branch"}`},
		{"the thread of a branch the chat does not have", "GET", "/api/chats/" + chat + "/items?branch=nothere", ``, `{"error":"no such branch"}`},
		{"the open of a branch the chat does not have", "POST", "/api/chats/" + chat + "/open?branch=nothere", ``, `{"error":"no such branch"}`},
		{"a message to a branch the chat does not have", "POST", "/api/chats/" + chat + "/messages?branch=nothere", `{"text":"hello"}`, `{"error":"no such branch"}`},
		{"a subagent the chat does not have", "GET", "/api/chats/" + chat + "/subagents/s1/items", ``, `{"error":"no such subagent"}`},
		{"an image the chat does not hold", "GET", "/api/chats/" + chat + "/images/" + l5NoImage, ``, `{"error":"no such image"}`},
	} {
		var body any
		if c.body != "" {
			body = c.body
		}
		for _, by := range s.all() {
			status, out := l5Call(by, c.method, c.path, body)
			l5Is(t, c.what+", by "+s.who(by), status, out, 404, c.answer)
			if strings.Contains(out, "not_found") {
				t.Errorf("%s: a part that is missing is answered as a thing that is gone: %s", c.what, out)
			}
		}
	}
	// A read of a part that is missing leaves the follow of the thing, which is there.
	if got := s.s.Bridge.Followers(editorbridge.Chat(chat)); len(got) != 3 {
		t.Errorf("the followers of the chat after the reads of a subagent it does not have: %v", got)
	}
}

// After one client deleted a thing, the other client's call for it, and the owner's, is 404
// "not_found": the thing is gone for everyone, and each was told so.
func TestLevel5DeletedByOneIsGoneForAll(t *testing.T) {
	t.Parallel()
	s := l5NewSite(t)
	group := l5ID(t, s.step(s.x, "a group", "POST", "/api/groups", `{"name":"Short-lived"}`, "groups", ""))
	chat := l5ID(t, s.step(s.x, "a chat", "POST", "/api/chats", `{"agent":"claude","group":"`+group+`"}`, "chat", ""))
	board := l5ID(t, s.step(s.x, "a board", "POST", "/api/boards", `{"name":"board","group":"`+group+`"}`, "board", ""))
	l5Want(t, s.x, 200, "POST", "/api/boards/"+board+"/release", nil)
	// The other client and the owner have the chat open, and read the rest.
	for _, c := range []*bridgetest.Page{s.y, s.p} {
		l5Want(t, c, 200, "GET", "/api/chats/"+chat+"/items", nil)
		l5Want(t, c, 200, "GET", "/api/boards/"+board+"/scene", nil)
	}

	s.step(s.x, "the delete of the chat", "DELETE", "/api/chats/"+chat, nil, "chat_removed", chat)
	s.step(s.x, "the delete of the board", "DELETE", "/api/boards/"+board, nil, "board_removed", board)
	l5Want(t, s.x, 200, "DELETE", "/api/groups/"+group+"?contents=delete", nil)
	s.told("the delete of the group", "defaults")

	gone := func(sentence string) string { return `{"code":"not_found","error":"` + sentence + `"}` }
	for _, c := range []struct {
		method, path, body string
		answer             string
	}{
		{"GET", "/api/chats/" + chat, ``, gone("no such chat")},
		{"GET", "/api/chats/" + chat + "/items", ``, gone("no such chat")},
		{"GET", "/api/chats/" + chat + "/tree", ``, gone("no such chat")},
		{"POST", "/api/chats/" + chat + "/messages", `{"text":"hello"}`, gone("no such chat")},
		{"PUT", "/api/chats/" + chat + "/draft?rev=0", `{"text":"typed"}`, gone("no such chat")},
		{"PATCH", "/api/chats/" + chat, `{"name":"Renamed"}`, gone("no such chat")},
		{"DELETE", "/api/chats/" + chat, ``, gone("no such chat")},
		{"GET", "/api/boards/" + board + "/scene", ``, gone("no such board")},
		{"POST", "/api/boards/" + board + "/take", ``, gone("no such board")},
		{"PUT", "/api/boards/" + board + "/scene?rev=0", `{"elements":[]}`, gone("no such board")},
		{"POST", "/api/boards/" + board + "/rename", `{"name":"renamed"}`, gone("no such board")},
		{"DELETE", "/api/boards/" + board, ``, gone("no such board")},
		{"POST", "/api/chats", `{"agent":"claude","board":"` + board + `"}`, gone("no such board")},
		{"PATCH", "/api/groups/" + group, `{"name":"Renamed"}`, gone(`no such group \"` + group + `\"`)},
		{"POST", "/api/groups/" + group + "/archive", ``, gone(`no such group \"` + group + `\"`)},
		{"DELETE", "/api/groups/" + group + "?contents=keep", ``, gone(`no such group \"` + group + `\"`)},
		{"POST", "/api/groups", `{"name":"Nested","parent":"` + group + `"}`, gone(`no such group \"` + group + `\"`)},
	} {
		var body any
		if c.body != "" {
			body = c.body
		}
		for _, by := range s.all() { // the one that deleted it too
			status, out := l5Call(by, c.method, c.path, body)
			l5Is(t, c.method+" "+c.path+" after the delete, by "+s.who(by), status, out, 404, c.answer)
		}
	}
	// The follows of the chat ended with it, and nothing is listed any more.
	if got := s.s.Bridge.Followers(editorbridge.Chat(chat)); len(got) != 0 {
		t.Errorf("the followers of the deleted chat: %v", got)
	}
	for _, c := range s.all() {
		state := l5Want(t, c, 200, "GET", "/api/state", nil)
		for _, id := range []string{chat, board, group} {
			if strings.Contains(state, id) {
				t.Errorf("the state of %s still holds %s", s.who(c), id)
			}
		}
	}
}
