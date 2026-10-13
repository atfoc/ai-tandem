package remotes

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"ai-whiteboard/internal/servers"
)

// TestSectionCallPassedOn: a call for a thing of a section goes to that server as it came,
// method, path, query and body, as this server and with no id changed, and that server's answer
// is the page's as it came: its status and its body, its codes and its sentences, the 404 of a
// thing that is gone there among them.
func TestSectionCallPassedOn(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree())})
	ctx := context.Background()
	routes := map[string]*script{}
	for _, pattern := range []string{
		"POST /api/groups", "DELETE /api/groups/{id}", "POST /api/chats", "PATCH /api/chats/{id}",
		"POST /api/chats/{id}/messages", "PUT /api/chats/{id}/draft",
		"POST /api/boards/{id}/rename",
	} {
		routes[pattern] = rg.script(pattern)
	}
	for _, c := range []struct {
		pattern, method, path, body string
		status                      int
		answer                      string
	}{
		{"POST /api/groups", "POST", "/api/groups", `{"name":"New","parent":""}`, 200, `{"id":"g_made","name":"New"}`},
		{"DELETE /api/groups/{id}", "DELETE", "/api/groups/g_there?contents=delete", "", 200, `{"ok":true}`},
		{"POST /api/chats", "POST", "/api/chats", `{"id":"` + chatB + `","group":"__ungrouped__"}`, 200, `{"id":"` + chatB + `","locked":false}`},
		{"POST /api/chats", "POST", "/api/chats", `{"group":"g_x","server":"local"}`, 400, `{"error":"a chat is made on the server it is asked of","code":"server_refused"}`},
		{"PATCH /api/chats/{id}", "PATCH", "/api/chats/" + chatA + "?branch=b_2", `{"group":"g_in"}`, 200, `{"ok":true,"chat":{"id":"` + chatA + `"}}`},
		{"POST /api/chats/{id}/messages", "POST", "/api/chats/" + chatA + "/messages?branch=main", `{"text":"hi","context":{"board":"` + boardA + `"}}`, 409, `{"error":"the agent is working","code":"busy"}`},
		{"PUT /api/chats/{id}/draft", "PUT", "/api/chats/" + chatA + "/draft?rev=3", `{"text":"typed"}`, 409, `{"error":"the draft changed","code":"stale","rev":5,"draft":{"text":"theirs"}}`},
		{"POST /api/boards/{id}/rename", "POST", "/api/boards/" + boardA + "/rename", `{"name":"Plan"}`, 404, `{"error":"no such board","code":"not_found"}`},
	} {
		s := routes[c.pattern]
		s.set(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(c.answer))
		})
		var body []byte
		if c.body != "" {
			body = []byte(c.body)
		}
		rep := rg.r.Pass(ctx, rg.entry, c.method, c.path, body, rg.r.Limits().Call)
		if rep.Status != c.status || string(rep.Body) != c.answer {
			t.Errorf("%s %s: %d %s, want %d %s", c.method, c.path, rep.Status, rep.Body, c.status, c.answer)
		}
		if g := s.last(t); g.Method != c.method || g.URI != c.path || g.Body != c.body {
			t.Errorf("%s %s: that server got %+v", c.method, c.path, g)
		}
	}
	// Every call was made as this server, one client there.
	for _, q := range rg.s.Requests() {
		if q.Client != testLocalID {
			t.Fatalf("a call as %q: %+v", q.Client, q)
		}
	}
}

// TestSectionCallAnswers: what the relay answers itself for a call that is passed on, by the
// state of the entry and by what came back: every row of the table that is not that server's
// own answer.
func TestSectionCallAnswers(t *testing.T) {
	t.Parallel()
	// Only the calls that get no answer have a short limit: none of the others may run into one.
	const short = 200 * time.Millisecond
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree()), limits: Limits{Start: short}})
	ctx := context.Background()
	label := rg.script("PUT /api/chats/{id}/label")
	message := rg.script("POST /api/chats/{id}/messages")
	limits := rg.r.Limits()
	call := func(entry string) Reply {
		return rg.r.Pass(ctx, entry, http.MethodPut, chatPath(chatA, "/label"), []byte(`{"label":"x"}`), limits.Call)
	}
	send := func(entry string) Reply {
		return rg.r.PassMessage(ctx, entry, chatPath(chatA, "/messages")+"?branch=main", []byte(`{"text":"hi"}`))
	}

	// No entry, and the local one: nothing is sent.
	for _, entry := range []string{"s_000000000000", servers.LocalID, "", "Studio", rg.s.URL()} {
		for what, rep := range map[string]Reply{"a call": call(entry), "a message": send(entry)} {
			wantReply(t, what+" for the entry "+entry, rep, http.StatusNotFound, map[string]any{"code": "no_server", "error": "This server is not in the list."})
		}
	}
	if label.count()+message.count() != 0 {
		t.Fatalf("a call for no entry reached a server: %v %v", label.calls(), message.calls())
	}

	// An answer that is no JSON, whatever its status.
	for _, c := range []struct {
		status int
		body   string
	}{{200, "done"}, {200, ""}, {404, "404 page not found\n"}, {500, "<html>"}, {200, `{"ok":true`}} {
		label.set(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(c.body))
		})
		wantReply(t, "an answer that is no JSON: "+c.body, call(rg.entry), http.StatusBadGateway,
			map[string]any{"code": "bad_answer", "error": "Studio gave an answer that cannot be read."})
	}
	// An answer above the size limit was sent and answered: it is no "did not answer".
	label.set(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(append([]byte(`{"label":"`), bytes.Repeat([]byte("x"), 32<<20)...))
	})
	rep := rg.r.Pass(ctx, rg.entry, http.MethodPut, chatPath(chatA, "/label"), nil, wait)
	wantReply(t, "an answer that is too long", rep, http.StatusBadGateway, map[string]any{"code": "bad_answer"})

	// No answer in time, and a connection that ends in the middle of the call.
	noAnswer := map[string]any{"code": "no_answer", "error": "Studio did not answer."}
	unknown := map[string]any{"code": "send_unknown", "error": "Studio did not answer: it is not known whether the message arrived."}
	_, release := label.hang()
	t.Cleanup(release)
	start := time.Now()
	rep = rg.r.Pass(ctx, rg.entry, http.MethodPut, chatPath(chatA, "/label"), nil, short)
	wantReply(t, "a call with no answer in time", rep, http.StatusGatewayTimeout, noAnswer)
	if d := time.Since(start); d > wait {
		t.Errorf("a call with no answer took %v", d)
	}
	label.drop()
	message.drop()
	wantReply(t, "a call whose connection ended", call(rg.entry), http.StatusGatewayTimeout, noAnswer)
	wantReply(t, "a message whose connection ended", send(rg.entry), http.StatusGatewayTimeout, unknown)
	_, releaseSend := message.hang()
	t.Cleanup(releaseSend)
	wantReply(t, "a message with no answer in time", send(rg.entry), http.StatusGatewayTimeout, unknown)
	// The page that asked goes away: the call ends with it.
	gone, cancel := context.WithCancel(ctx)
	cancel()
	rep = rg.r.Pass(gone, rg.entry, http.MethodPut, chatPath(chatA, "/label"), nil, wait)
	wantReply(t, "a call of a page that went away", rep, http.StatusGatewayTimeout, noAnswer)

	// Not connected: nothing is sent, for a message too.
	rg.offline()
	asked := label.count() + message.count()
	unreachable := map[string]any{"code": "server_unreachable", "error": "Studio is not connected."}
	wantReply(t, "a call while not connected", call(rg.entry), http.StatusServiceUnavailable, unreachable)
	wantReply(t, "a message while not connected", send(rg.entry), http.StatusServiceUnavailable, unreachable)
	if got := label.count() + message.count(); got != asked {
		t.Errorf("a server that is not connected was asked %d times", got-asked)
	}
	for _, e := range []*Error{rg.r.Ready(rg.entry), rg.r.unmade(rg.entry, ErrUnreachable)} {
		if !errors.Is(e, ErrUnreachable) || errors.Is(e, ErrNoAnswer) {
			t.Errorf("the cause of %v", e)
		}
	}
}

// TestSectionCallWakesAnEntryThatWaits: an entry that waits for its next try is made to try now
// by a call that finds it not connected. The call itself is refused: nothing was sent.
func TestSectionCallWakesAnEntryThatWaits(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{backoff: []time.Duration{time.Hour}})
	rg.offline()
	rg.state(servers.StateUnreachable)
	rg.s.Restart()
	rep := rg.r.Pass(context.Background(), rg.entry, http.MethodGet, chatPath(chatA, ""), nil, rg.r.Limits().Call)
	wantReply(t, "the call that woke the entry", rep, http.StatusServiceUnavailable, map[string]any{"code": "server_unreachable"})
	rg.returned(2) // an hour sooner than its back-off says

	// An answer of 401 is the entry's matter, not the thing's: the page is told that the server is
	// not connected, and the entry waits for the user from then on. A call does not change that.
	label := rg.script("PUT /api/chats/{id}/label")
	label.answer(http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
	call := func() Reply {
		return rg.r.Pass(context.Background(), rg.entry, http.MethodPut, chatPath(chatA, "/label"), []byte(`{}`), rg.r.Limits().Call)
	}
	unreachable := map[string]any{"code": "server_unreachable", "error": "Studio is not connected."}
	wantReply(t, "an answer of 401", call(), http.StatusServiceUnavailable, unreachable)
	rg.state(servers.StateSecretNotAccepted)
	rg.away()
	wantReply(t, "a call for an entry whose secret is not accepted", call(), http.StatusServiceUnavailable, unreachable)
	if v, _ := rg.m.View(rg.entry); v.State != servers.StateSecretNotAccepted || label.count() != 1 {
		t.Errorf("the entry is %s, and was asked %d times", v.State, label.count())
	}
}

// TestDirsAndUsage: the two routes that name the entry in the query are passed on to it and
// answered as it answers.
func TestDirsAndUsage(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{})
	ctx := context.Background()
	dirs, usage := rg.script("GET /api/dirs"), rg.script("GET /api/usage/{agent}")
	dirs.answer(http.StatusOK, map[string]any{"path": "/home/standin/a b", "dirs": []string{"x"}})
	usage.answer(http.StatusBadRequest, map[string]any{"error": "no such agent"})
	wantReply(t, "the folders", rg.r.Dirs(ctx, rg.entry, "~/a b"), http.StatusOK, map[string]any{"path": "/home/standin/a b"})
	if g := dirs.last(t); g.URI != "/api/dirs?path=~%2Fa+b" {
		t.Errorf("the folders call: %+v", g)
	}
	wantReply(t, "the usage", rg.r.Usage(ctx, rg.entry, "claude", true), http.StatusBadRequest, map[string]any{"error": "no such agent"})
	if g := usage.last(t); g.URI != "/api/usage/claude?fresh=1" {
		t.Errorf("the usage call: %+v", g)
	}
	rg.r.Usage(ctx, rg.entry, "pi", false)
	if g := usage.last(t); g.URI != "/api/usage/pi" {
		t.Errorf("the usage call: %+v", g)
	}
	for _, entry := range []string{"s_000000000000", servers.LocalID} {
		wantReply(t, "the folders of "+entry, rg.r.Dirs(ctx, entry, ""), http.StatusNotFound, map[string]any{"error": "no such server"})
		wantReply(t, "the usage of "+entry, rg.r.Usage(ctx, entry, "claude", false), http.StatusNotFound, map[string]any{"error": "no such server"})
	}
	rg.offline()
	wantReply(t, "the folders while not connected", rg.r.Dirs(ctx, rg.entry, ""), http.StatusServiceUnavailable, map[string]any{"code": "server_unreachable"})
	if got := chatPath("a/b?c", "/items"); got != "/api/chats/a%2Fb%3Fc/items" {
		t.Errorf("chatPath: %s", got)
	}
	if got := servers.ErrNotConnected.Error(); got != ErrUnreachable.Error() {
		t.Errorf("ErrUnreachable reads %q, the manager's %q", ErrUnreachable, got)
	}
}
