package server

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// The answer of a section's call by the state of its entry, through the real handler: one route
// of each kind, in every state the contract's table names.

// stateCall is one route of a kind, as a page calls it for the things the stand-in has.
type stateCall struct {
	kind    string
	pattern string // the route as the entry's server has it
	method  string
	rest    string // the path under the prefix, with the query
	body    string
}

// stateCalls are a read, a write, a read that follows, a message, a board's take, its drawing
// read and saved, and an image's upload and fetch.
func stateCalls() []stateCall {
	const chat, board = "/chats/" + farChatA, "/boards/" + farBoardA
	return []stateCall{
		{"a read", "GET /api/chats/{id}", "GET", chat, ""},
		{"a write", "PATCH /api/chats/{id}", "PATCH", chat, `{"name":"Mine"}`},
		{"a make", "POST /api/chats", "POST", "/chats", `{"group":"` + farGroup + `"}`},
		{"a read that follows", "GET /api/chats/{id}/items", "GET", chat + "/items", ""},
		{"a run's read that follows", "GET /api/runs/{id}/detail", "GET", "/runs/" + farRunA + "/detail", ""},
		{"a message", "POST /api/chats/{id}/messages", "POST", chat + "/messages", `{"text":"hello"}`},
		{"a draft save", "PUT /api/chats/{id}/draft", "PUT", chat + "/draft?rev=0", `{"text":"typed"}`},
		{"a board's take", "POST /api/boards/{id}/take", "POST", board + "/take", ""},
		{"a drawing's read", "GET /api/boards/{id}/scene", "GET", board + "/scene", ""},
		{"a drawing's save", "PUT /api/boards/{id}/scene", "PUT", board + "/scene?rev=3", `{"elements":[]}`},
		{"an image's upload", imagePatterns[0], "POST", chat + "/images?name=a.png", string(png("a"))},
		{"an image's fetch", imagePatterns[1], "GET", chat + "/images/" + imageIDOf(png("a")), ""},
	}
}

// do makes the call for the entry, as the page p.
func (c stateCall) do(f *far, p *bridgetest.Page, entry string) (int, string) {
	f.t.Helper()
	return f.call(p, c.method, sectionPrefix+entry+c.rest, c.body)
}

// refused is a call that must be refused with the status, the code and the sentence.
func (c stateCall) refused(f *far, p *bridgetest.Page, entry, when string, status int, code, sentence string) {
	f.t.Helper()
	got, out := c.do(f, p, entry)
	r := decode[struct{ Error, Code string }](f.t, out)
	if got != status || r.Code != code || r.Error != sentence {
		f.t.Errorf("%s, %s: %d %s, want %d %s %q", when, c.kind, got, out, status, code, sentence)
	}
}

// An id that is no entry of the list, and the local entry: 404 "no_server", and nothing is sent.
// An entry that is not connected, whatever the reason: 503 "server_unreachable" with its name,
// and nothing is sent.
func TestSectionCallsOfAnEntryThatCannotBeAsked(t *testing.T) {
	t.Parallel()
	f := newRowsFar(t, remotes.Limits{})
	p := f.page("P")

	sent := len(f.st.Requests())
	f.untouched("an id that is no entry", func() {
		for _, entry := range []string{noSuchServer, "local", "Studio", standin.DefaultInstanceID, "s_"} {
			for _, c := range stateCalls() {
				c.refused(f, p, entry, "the entry "+entry, http.StatusNotFound, "no_server", "This server is not in the list.")
			}
		}
	})
	if got := f.st.Requests(); len(got) != sent {
		t.Errorf("the stand-in was sent %+v", got[sent:])
	}

	// A second entry whose first connection is still being made: its server keeps its hello back.
	mini := standin.Start(t, standin.Options{InstanceID: "5e000000-0000-4000-8000-00000000000e"})
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	mini.SetHello(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	v, saved, _, err := f.m.Add(context.Background(), servers.Input{Name: "Mini", Address: mini.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: mini.Fingerprint()}, true)
	if err != nil || !saved {
		t.Fatalf("the second entry is not saved: %v", err)
	}
	state := func() servers.State {
		now, _ := f.m.View(v.ID)
		return now.State
	}
	// The attempt ends by itself after the hello's limit, so a round counts only when the entry
	// was in its first attempt before and after it; else the entry is made to connect anew.
	for try := 1; ; try++ {
		before := state()
		var got []string
		for _, c := range stateCalls() {
			status, out := c.do(f, p, v.ID)
			r := decode[struct{ Error, Code string }](t, out)
			if status != http.StatusServiceUnavailable || r.Code != "server_unreachable" || r.Error != "Mini is not connected." {
				got = append(got, c.kind+": "+out)
			}
		}
		if before == servers.StateConnecting && state() == servers.StateConnecting {
			if len(got) != 0 {
				t.Errorf("an entry that is connecting: %q", got)
			}
			break
		}
		if try == 5 {
			t.Fatalf("the entry never stayed in its first attempt over the calls: %s", state())
		}
		secret := standin.DefaultSecret
		if _, _, _, err := f.m.Edit(context.Background(), v.ID, servers.Patch{Secret: &secret}, true); err != nil {
			t.Fatal(err)
		}
	}
	for _, r := range mini.Requests() {
		if r.Path != servers.HelloPath {
			t.Errorf("the server that was connecting was sent %s %s", r.Method, r.Path)
		}
	}
	if sec := f.snapshotOf(p).Sections; len(sec) != 1 || sec[f.entry] == nil {
		t.Errorf("the sections with one entry connecting: %v", sec)
	}

	// The entry waits for the user: its server no longer takes the secret.
	f.st.SetSecret(strings.Repeat("b", 64))
	gone := f.nulls.Load() + 1
	f.st.DropStreams()
	f.wait("the entry's secret is not accepted", func() bool {
		return f.state() == servers.StateSecretNotAccepted && f.nulls.Load() >= gone
	})
	f.untouched("an entry whose secret is not accepted", func() {
		for _, c := range stateCalls() {
			c.refused(f, p, f.entry, "the secret is not accepted", http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
		}
	})
	f.st.SetSecret(standin.DefaultSecret)
	secret := standin.DefaultSecret
	if _, _, _, err := f.m.Edit(context.Background(), f.entry, servers.Patch{Secret: &secret}, true); err != nil {
		t.Fatal(err)
	}
	f.returned(2)

	// The entry's server is unreachable.
	f.down()
	sent = len(f.st.Requests())
	for _, c := range stateCalls() {
		c.refused(f, p, f.entry, "not connected", http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	}
	if got := f.st.Requests(); len(got) != sent {
		t.Errorf("the stand-in that is down was sent %+v", got[sent:])
	}
	if f.s.Bridge.Followed(editorbridge.ChatOn(f.entry, farChatA)) || f.s.Bridge.Followed(editorbridge.RunOn(f.entry, farRunA)) {
		t.Error("a read that was not sent left a follow")
	}
	if _, held := f.s.Bridge.HolderOf(editorbridge.BoardOn(f.entry, farBoardA)); held {
		t.Error("a take that was not sent gave the board")
	}

	// It is back: the same calls are made.
	f.up(3)
	for _, c := range stateCalls() {
		if status, out := c.do(f, p, f.entry); status != http.StatusOK {
			t.Errorf("after the return, %s: %d %s", c.kind, status, out)
		}
	}
}

// A connected entry: what its server answers is the page's as it came, that the thing is gone
// there among it. Three answers are not handed on: a 401, which is the entry's matter; one
// that is no JSON; and none at all.
func TestSectionCallsOfAConnectedEntry(t *testing.T) {
	t.Parallel()
	f := newRowsFar(t, remotes.Limits{})
	p := f.page("P")
	// before sets the board up for a call of its hold: a take goes to the board's server only
	// while no page here holds the board, and a drawing is saved by the page that holds it.
	before := func(c stateCall) {
		t.Helper()
		switch c.kind {
		case "a board's take":
			f.good(p, "POST", f.on("/boards/"+farBoardA+"/release"), "")
		case "a drawing's save":
			if got := f.good(p, "POST", f.on("/boards/"+farBoardA+"/take"), ""); got["state"] != "held" {
				t.Fatalf("the take: %v", got)
			}
		}
	}
	f.good(p, "POST", f.on("/chats/"+farChatA+"/images?name=a.png"), string(png("a"))) // the image the fetch names

	// The thing is gone there: that server's 404 with the code "not_found", and no follow is
	// left of a read that found nothing.
	gone := map[string]any{"error": "no such thing there", "code": "not_found"}
	for _, c := range stateCalls() {
		if c.kind == "a make" {
			continue // it names no thing
		}
		before(c)
		f.answer(c.pattern, http.StatusNotFound, gone)
		c.refused(f, p, f.entry, "the thing is gone there", http.StatusNotFound, "not_found", "no such thing there")
		f.handle(c.pattern, nil)
	}
	if f.s.Bridge.Followed(editorbridge.ChatOn(f.entry, farChatA)) || f.s.Bridge.Followed(editorbridge.RunOn(f.entry, farRunA)) {
		t.Error("a read of a thing that is gone left a follow")
	}

	// An answer that is no JSON: 502 "bad_answer".
	for _, c := range stateCalls() {
		before(c)
		f.handle(c.pattern, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			w.Write([]byte("<!doctype html><p>Something else</p>"))
		})
		c.refused(f, p, f.entry, "an answer that is no JSON", http.StatusBadGateway, "bad_answer", "Studio gave an answer that cannot be read.")
		f.handle(c.pattern, nil)
	}

	// A 401 there is the entry's matter: the page gets 503, and the entry waits for its secret.
	// The entry is given the secret again after each.
	n := f.trees.Load()
	for _, c := range stateCalls() {
		before(c)
		f.answer(c.pattern, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		c.refused(f, p, f.entry, "a 401 there", http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
		f.handle(c.pattern, nil)
		f.wait("the entry's secret is not accepted", func() bool { return f.state() == servers.StateSecretNotAccepted })
		secret := standin.DefaultSecret
		if _, _, _, err := f.m.Edit(context.Background(), f.entry, servers.Patch{Secret: &secret}, true); err != nil {
			t.Fatal(err)
		}
		n++
		f.returned(n)
	}
}

// A call that was sent and got no answer in time is 504 "no_answer", and a message 504
// "send_unknown": it may have arrived. So is one whose connection ended while it waited.
func TestSectionCallsThatGetNoAnswer(t *testing.T) {
	t.Parallel()
	answers := func(c stateCall) (code, sentence string) {
		if c.kind == "a message" {
			return "send_unknown", "Studio did not answer: it is not known whether the message arrived."
		}
		return "no_answer", "Studio did not answer."
	}
	// A call counts once the entry's server got it. On a loaded machine a short limit can end a
	// call before it was sent: that call is made again with a longer limit, on a rig of that
	// limit, and only the longest one decides.
	t.Run("in time", func(t *testing.T) {
		t.Parallel()
		limits := []time.Duration{100 * time.Millisecond, time.Second, 5 * time.Second}
		rigs, pages := make([]*far, len(limits)), make([]*bridgetest.Page, len(limits))
		for _, c := range stateCalls() {
			for i, limit := range limits {
				if rigs[i] == nil {
					rigs[i] = newRowsFar(t, remotes.Limits{Call: limit, Start: limit, Scene: limit, Image: limit})
					pages[i] = rigs[i].page("P")
				}
				f, p := rigs[i], pages[i]
				if c.kind == "a drawing's save" { // of the page that holds the board
					f.handle("POST /api/boards/{id}/take", nil)
					f.wait("the board is the page's", func() bool {
						status, out := f.call(p, "POST", f.on("/boards/"+farBoardA+"/take"), "")
						return status == 200 && strings.Contains(out, "held")
					})
				}
				before := len(f.sent(c.pattern))
				f.hang(c.pattern)
				code, sentence := answers(c)
				c.refused(f, p, f.entry, "no answer", http.StatusGatewayTimeout, code, sentence)
				// The limit ends the call here; the entry's server may note it a moment later.
				sent := func() bool { return len(f.sent(c.pattern)) > before }
				if i == len(limits)-1 {
					f.wait(c.kind+" was sent", sent)
				}
				for end := time.Now().Add(2 * time.Second); !sent() && time.Now().Before(end); {
					time.Sleep(2 * time.Millisecond)
				}
				if sent() {
					break
				}
				t.Logf("%s was not sent within %s: again with a longer limit", c.kind, limit)
			}
		}
	})
	// The entry's server stops in the middle of the call: every kind at once, each from a page
	// of its own.
	t.Run("the connection ends", func(t *testing.T) {
		t.Parallel()
		f := newRowsFar(t, remotes.Limits{})
		calls := stateCalls()
		pages := make([]*bridgetest.Page, len(calls))
		for i, c := range calls {
			pages[i] = f.page("P" + string(rune('a'+i)))
			if c.kind == "a drawing's save" {
				if got := f.good(pages[i], "POST", f.on("/boards/"+farBoardA+"/take"), ""); got["state"] != "held" {
					t.Fatalf("the take: %v", got)
				}
			}
		}
		type answer struct {
			status int
			out    string
		}
		got := make([]chan answer, len(calls))
		for i, c := range calls {
			if c.kind == "a board's take" {
				continue // the board is held by the page that saves: its take is this server's own
			}
			f.hang(c.pattern)
			got[i] = make(chan answer, 1)
			go func() {
				var body any
				if c.body != "" {
					body = c.body
				}
				status, out := pages[i].Do(c.method, f.on(c.rest), body)
				got[i] <- answer{status, string(out)}
			}()
		}
		for i, c := range calls {
			if got[i] != nil {
				f.wait(c.kind+" is sent", func() bool { return len(f.sent(c.pattern)) > 0 })
			}
		}
		f.st.Stop()
		for i, c := range calls {
			if got[i] == nil {
				continue
			}
			select {
			case a := <-got[i]:
				code, sentence := answers(c)
				if r := decode[struct{ Error, Code string }](t, a.out); a.status != http.StatusGatewayTimeout || r.Code != code || r.Error != sentence {
					t.Errorf("%s, cut by the end of the connection: %d %s", c.kind, a.status, a.out)
				}
			case <-time.After(waitLimit):
				t.Errorf("%s was not answered after the connection ended", c.kind)
			}
		}
		// The page that held the board holds it still, here.
		if holder, _ := f.s.Bridge.HolderOf(editorbridge.BoardOn(f.entry, farBoardA)); holder == "" {
			t.Error("the end of the connection took the board from its page")
		}
	})
}

// The folders and the plan usage of another server are asked there, under their own routes,
// and those of this one are not.
func TestDirsAndUsageOfAServer(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{})
	p := f.page("P")
	here := t.TempDir()

	dirs := map[string]any{"path": "/home/standin/work", "parent": "/home/standin", "dirs": []any{"a", "b"}, "git": true}
	f.answer("GET /api/dirs", http.StatusOK, dirs)
	sameJSON(t, "the folders there", f.good(p, "GET", "/api/dirs?path=~%2Fwork&server="+f.entry, ""), mustJSON(t, dirs))
	if c := f.last("GET /api/dirs"); c.Path != "/api/dirs" || !sameQuery(c.Query, "path=~%2Fwork") {
		t.Fatalf("the folders were asked with %+v", c)
	}
	use := map[string]any{"plan": "there", "windows": []any{}}
	f.answer("GET /api/usage/{agent}", http.StatusOK, use)
	sameJSON(t, "the plan usage there", f.good(p, "GET", "/api/usage/pi?fresh=1&server="+f.entry, ""), mustJSON(t, use))
	if c := f.last("GET /api/usage/{agent}"); c.Path != "/api/usage/pi" || c.Query != "fresh=1" {
		t.Fatalf("the plan usage was asked with %+v", c)
	}
	// A refusal there goes to the page as it came.
	f.answer("GET /api/dirs", http.StatusBadRequest, map[string]string{"error": "/nowhere is not a directory"})
	if status, out := f.call(p, "GET", "/api/dirs?path=/nowhere&server="+f.entry, ""); status != http.StatusBadRequest || !strings.Contains(out, "/nowhere is not a directory") {
		t.Fatalf("a folder that is none there: %d %s", status, out)
	}
	f.answer("GET /api/usage/{agent}", http.StatusNotFound, map[string]string{"error": "usage not available"})
	if status, out := f.call(p, "GET", "/api/usage/cursor?server="+f.entry, ""); status != http.StatusNotFound || !strings.Contains(out, "usage not available") {
		t.Fatalf("an agent without usage there: %d %s", status, out)
	}
	if n := f.usage[model.Claude].Load(); n != 0 {
		t.Fatalf("this server's usage was read %d times for another server", n)
	}

	// "local" and no server are this machine: the stand-in is not asked.
	f.untouched("this computer's folders and usage", func() {
		for _, q := range []string{"", "&server=local"} {
			if got := f.good(p, "GET", "/api/dirs?path="+here+q, ""); got["dirs"] == nil || !strings.HasSuffix(got["path"].(string), here[strings.LastIndex(here, "/"):]) {
				t.Errorf("the folders here with %q: %v", q, got)
			}
			f.good(p, "GET", "/api/usage/claude?fresh=1"+q, "")
		}
		if n := f.usage[model.Claude].Load(); n != 2 {
			t.Errorf("this server's usage was read %d times, want 2", n)
		}
		// An entry that is not in the list.
		for _, path := range []string{"/api/dirs?server=" + noSuchServer, "/api/usage/claude?server=" + noSuchServer} {
			if status, out := f.call(p, "GET", path, ""); status != http.StatusNotFound || !strings.Contains(out, "no such server") {
				t.Errorf("%s: %d %s", path, status, out)
			}
		}
	})
	// An entry that is not connected.
	f.down()
	for _, path := range []string{"/api/dirs?server=" + f.entry, "/api/usage/claude?server=" + f.entry} {
		if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "GET", path, ""); text != "Studio is not connected." {
			t.Errorf("%s while the server is away: %q", path, text)
		}
	}

	// A server without a relay knows no entry but its own.
	e := newEnv(t)
	for _, path := range []string{"/api/dirs?server=" + noSuchServer, "/api/usage/claude?server=" + noSuchServer} {
		if status, out := e.do("GET", path, ""); status != http.StatusNotFound || !strings.Contains(out, "no such server") {
			t.Errorf("without a relay, %s: %d %s", path, status, out)
		}
	}
	if status, out := e.do("GET", "/api/dirs?server=local&path="+here, ""); status != http.StatusOK {
		t.Errorf("without a relay, this computer's folders: %d %s", status, out)
	}
}

// A call that changes something on the entry's server is not ended by the page that asked: the
// page goes away while that server works, and the call is made whole all the same. A read is
// the page's alone, and ends with it.
func TestSectionWriteOutlivesThePageThatAsked(t *testing.T) {
	t.Parallel()
	f := newRowsFar(t, remotes.Limits{})
	p := f.page("P")
	for _, c := range []struct {
		what, pattern, method, rest, body string
		outlives                          bool
	}{
		{"the start of a run", "POST /api/runs/{id}/start", "POST", "/runs/" + farRunA + "/start", `{"goal":"Write the note"}`, true},
		{"a message", "POST /api/chats/{id}/messages", "POST", "/chats/" + farChatA + "/messages", `{"text":"hello"}`, true},
		{"the delete of a group", "DELETE /api/groups/{id}", "DELETE", "/groups/" + farGroup + "?contents=delete", "", true},
		{"a new board", "POST /api/boards", "POST", "/boards", `{"name":"Plans","group":"` + farGroup + `"}`, true},
		{"a read", "GET /api/chats/{id}", "GET", "/chats/" + farChatA, "", false},
		{"a read that follows", "GET /api/chats/{id}/items", "GET", "/chats/" + farChatA + "/items", "", false},
	} {
		arrived, cut, finish := make(chan struct{}), make(chan struct{}), make(chan struct{})
		f.handle(c.pattern, func(w http.ResponseWriter, r *http.Request) {
			close(arrived)
			select {
			case <-r.Context().Done():
				close(cut)
			case <-finish:
				ok(w)
			}
		})
		ctx, leave := context.WithCancel(context.Background())
		req, _ := http.NewRequestWithContext(ctx, c.method, f.url+f.on(c.rest), strings.NewReader(c.body))
		req.Header.Set(ClientHeader, p.ID)
		gone := make(chan struct{})
		go func() {
			defer close(gone)
			if resp, err := http.DefaultClient.Do(req); err == nil {
				resp.Body.Close()
			}
		}()
		select {
		case <-arrived:
		case <-time.After(waitLimit):
			t.Fatalf("%s did not reach the entry's server", c.what)
		}
		leave() // the page goes away
		<-gone
		if c.outlives {
			select {
			case <-cut:
				t.Errorf("%s was ended by the page that left", c.what)
			case <-time.After(200 * time.Millisecond):
			}
			close(finish)
		} else {
			select {
			case <-cut:
			case <-time.After(waitLimit):
				t.Errorf("%s went on after the page that asked had left", c.what)
			}
		}
		f.handle(c.pattern, nil)
	}
}
