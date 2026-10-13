package server

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/servers"
)

// What the reviews of the remote listener found: a follow by the listener's kind, the data folder
// in the folder list, a fork onto a board, a read during a creation call, a take of a board that
// is archived under it, and the clauses that had no test.

// pageUUID is the id of a page that has the form of an API client's id, so that a request on the
// remote listener can state it.
const pageUUID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a"

// try is one request on the remote listener that fails no test, so it may run on a goroutine of
// its own: status 0 says it could not be sent.
func (l *listener) try(id, secret, method, path string) (int, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, l.base+path, nil)
	if err != nil {
		return 0, err.Error()
	}
	req.Header.Set(ClientHeader, id)
	req.Header.Set(SecretHeader, secret)
	req.Header.Set(servers.LevelHeader, testLevel)
	resp, err := l.http.Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// ---- a follow is of the listener's kind ------------------------------------------

// A read or an unfollow that states the id of a client of the other listener starts and ends
// nothing: the loopback listener acts on pages, the remote one on API clients.
func TestFollowIsOfTheListenersKind(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	e.page(pageUUID)
	l.api(apiX)
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	path := "/api/chats/" + c.ID
	followers := func(what string, want ...string) {
		t.Helper()
		if got := e.s.Bridge.Followers(editorbridge.Chat(c.ID)); !slices.Equal(got, want) {
			t.Fatalf("followers after %s: %v, want %v", what, got, want)
		}
	}
	remote := func(client, method, sub string) {
		t.Helper()
		if status, out := l.call(client, testSecret, method, path+sub, ""); status != 200 {
			t.Fatalf("%s %s on the remote listener as %s: %d %s", method, sub, client, status, out)
		}
	}
	reads := []string{"/items", "/tree"}

	// The API client's id on loopback, the page's id on the remote listener: no follow.
	for _, sub := range reads {
		if status, out := e.doAs(apiX, "GET", path+sub, ""); status != 200 {
			t.Fatalf("GET %s on loopback with the API client's id: %d %s", sub, status, out)
		}
		remote(pageUUID, "GET", sub)
	}
	e.doAs(apiX, "GET", path+"/subagents/nope/items", "")
	l.call(pageUUID, testSecret, "GET", path+"/subagents/nope/items", "")
	followers("the reads that state the other kind's id")

	// The page reads; an API client that states the page's id does not end its follow.
	if status, out := e.doAs(pageUUID, "GET", path+"/items", ""); status != 200 {
		t.Fatalf("the page's read: %d %s", status, out)
	}
	followers("the page's read", pageUUID)
	remote(pageUUID, "POST", "/unfollow")
	followers("a remote unfollow that states the page's id", pageUUID)

	// The API client's own read follows; a loopback unfollow that states its id ends nothing.
	remote(apiX, "GET", "/items")
	want := []string{apiX, pageUUID}
	slices.Sort(want)
	followers("the API client's own read", want...)
	// (The guard of the loopback listener refuses it: an API client is no known client there.)
	if status, out := e.doAs(apiX, "POST", path+"/unfollow", ""); status != 409 {
		t.Fatalf("the loopback unfollow with the API client's id: %d %s", status, out)
	}
	followers("a loopback unfollow that states the API client's id", want...)

	// A failed read ends the follow of its own kind only.
	gone := "/api/chats/" + chat3
	e.s.Bridge.Follow(apiX, editorbridge.Chat(chat3))
	e.s.Bridge.Follow(pageUUID, editorbridge.Chat(chat3))
	if status, _ := e.doAs(apiX, "GET", gone+"/items", ""); status != 404 {
		t.Fatalf("the read of a chat that is not there: %d", status)
	}
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat3)); !slices.Equal(got, want) {
		t.Fatalf("followers after a failed loopback read with the API client's id: %v", got)
	}
	if status, _ := l.call(apiX, testSecret, "GET", gone+"/items", ""); status != 404 {
		t.Fatalf("the remote read of a chat that is not there: %d", status)
	}
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat3)); !slices.Equal(got, []string{pageUUID}) {
		t.Fatalf("followers after the API client's failed read: %v", got)
	}

	// Each ends its own.
	remote(apiX, "POST", "/unfollow")
	followers("the API client's unfollow", pageUUID)
	e.doAs(pageUUID, "POST", path+"/unfollow", "")
	followers("the page's unfollow")
}

// ---- the folder list ---------------------------------------------------------------

// An API client does not list the data folder or a folder inside it; a page does.
func TestRemoteDirsRefuseTheDataFolder(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	data := e.a.DataDir
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(outside, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	// A link to the data folder from outside it is the data folder.
	link := filepath.Join(outside, "link")
	if err := os.Symlink(data, link); err != nil {
		t.Fatal(err)
	}
	q := func(p string) string { return "/api/dirs?path=" + url.QueryEscape(p) }

	for _, p := range []string{data, filepath.Join(data, "chats"), filepath.Join(data, "chats", c.ID), data + string(filepath.Separator),
		filepath.Join(outside, "sub", "..", "..", filepath.Base(outside), "link"), link, filepath.Join(link, "chats")} {
		status, out := l.call(apiX, testSecret, "GET", q(p), "")
		if got := decode[obj](t, out); status != 400 || got["error"] != chats.ErrAppFolder.Error() || len(got) != 1 {
			t.Errorf("the API client's list of %s: %d %s", p, status, out)
		}
		if strings.Contains(out, c.ID) {
			t.Errorf("the refusal for %s names a chat: %s", p, out)
		}
		if got := decode[obj](t, e.expect(200, "GET", q(p), "")); got["dirs"] == nil {
			t.Errorf("the page's list of %s: %v", p, got)
		}
	}
	if got := decode[struct{ Dirs []string }](t, e.expect(200, "GET", q(filepath.Join(data, "chats")), "")); !slices.Contains(got.Dirs, c.ID) {
		t.Errorf("the page's list of the chats folder: %v", got.Dirs)
	}
	// A folder outside is listed for both.
	for _, p := range []string{outside, filepath.Join(outside, "sub"), filepath.Dir(data)} {
		status, out := l.call(apiX, testSecret, "GET", q(p), "")
		if status != 200 || decode[obj](t, out)["dirs"] == nil {
			t.Errorf("the API client's list of %s: %d %s", p, status, out)
		}
		e.expect(200, "GET", q(p), "")
	}
	if status, out := l.call(apiX, testSecret, "GET", q(outside), ""); status != 200 || !slices.Contains(decode[struct{ Dirs []string }](t, out).Dirs, "sub") {
		t.Errorf("the API client's list of a folder outside: %d %s", status, out)
	}
}

// ---- a fork onto a board ---------------------------------------------------------------

// ---- a read during a creation call ------------------------------------------------------

// ---- a take of a board that is archived under it ---------------------------------------

// An archive or a delete of the board between the take's check and its grant finds no holder to
// ask. The take then gives the hold back and answers as it does for such a board.
func TestTakeOfABoardArchivedUnderIt(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var between func(board string)
	e := newEnv(t, func(s *Server) {
		s.beforeTake = func(board string) {
			mu.Lock()
			f := between
			between = nil
			mu.Unlock()
			if f != nil {
				f(board)
			}
		}
	})
	p := e.page("P")
	for _, c := range []struct{ name, method, path string }{
		{"archive", "POST", "/archive"},
		{"delete", "DELETE", ""},
	} {
		bd := newBoard(t, p, c.name)
		if state := release(t, p, bd.ID); state != "free" {
			t.Fatalf("%s: the release of the new board: %s", c.name, state)
		}
		ran := false
		mu.Lock()
		between = func(board string) {
			ran = true
			if board != bd.ID {
				t.Errorf("%s: the take of %s, want %s", c.name, board, bd.ID)
			}
			if status, out := e.do(c.method, "/api/boards/"+bd.ID+c.path, ""); status != 200 {
				t.Errorf("%s between the check and the grant: %d %s", c.name, status, out)
			}
		}
		mu.Unlock()
		status, out := p.Do("POST", "/api/boards/"+bd.ID+"/take", map[string]any{"ifFree": false})
		if !ran {
			t.Fatalf("%s: the take did not reach its grant", c.name)
		}
		if holder, held := e.s.Bridge.HolderOf(bd.ID); held {
			t.Fatalf("%s: %s holds the board after the take (%d %s)", c.name, holder, status, out)
		}
		// The answer is the one of a take that finds the board so at its start.
		again, want := p.Do("POST", "/api/boards/"+bd.ID+"/take", map[string]any{"ifFree": false})
		if status == 200 || status != again || string(out) != string(want) {
			t.Fatalf("%s: the take answered %d %s; a take of such a board answers %d %s", c.name, status, out, again, want)
		}
		if _, held := e.s.Bridge.HolderOf(bd.ID); held {
			t.Fatalf("%s: the board is held after the second take", c.name)
		}
	}
	// With nothing in between the take holds.
	bd := newBoard(t, p, "kept")
	release(t, p, bd.ID)
	if state, _ := take(t, p, bd.ID, false); state != "held" {
		t.Fatalf("the take of a board that stays: %s", state)
	}
	e.holder(bd.ID, "P")
}

// ---- the old secret at a reload -------------------------------------------------------

// ReloadSecret makes the old secret refused before it ends a stream: a client that sees its
// stream end and calls at once with the old secret gets 401.
func TestOldSecretIsRefusedBeforeTheStreamEnds(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	ids := []string{apiX, apiY, apiZ}
	secret := testSecret
	for round := 0; round < 5; round++ {
		type answer struct {
			id     string
			status int
			body   string
		}
		got := make(chan answer, len(ids))
		for _, id := range ids {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, "GET", l.base+"/api/events", nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set(ClientHeader, id)
			req.Header.Set(SecretHeader, secret)
			req.Header.Set(servers.LevelHeader, testLevel)
			resp, err := l.http.Do(req)
			if err != nil || resp.StatusCode != 200 {
				t.Fatalf("round %d: the stream of %s: %v %v", round, id, resp, err)
			}
			go func(old string) {
				io.Copy(io.Discard, resp.Body) // to the stream's end
				resp.Body.Close()
				status, out := l.try(id, old, "GET", "/api/state")
				got <- answer{id, status, out}
			}(secret)
		}
		for deadline := time.Now().Add(5 * time.Second); slices.ContainsFunc(ids, func(id string) bool { return !e.s.Bridge.Known(id) }); time.Sleep(time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("round %d: the API clients did not connect", round)
			}
		}
		next := strings.Repeat(string(rune('a'+round))+"1", 32)
		if n := e.s.ReloadSecret(next); n != len(ids) {
			t.Fatalf("round %d: ReloadSecret ended %d streams, want %d", round, n, len(ids))
		}
		for range ids {
			select {
			case a := <-got:
				if a.status != 401 || strings.TrimSpace(a.body) != `{"error":"unauthorized"}` {
					t.Fatalf("round %d: %s called with the old secret after its stream's end: %d %s", round, a.id, a.status, a.body)
				}
			case <-time.After(10 * time.Second):
				t.Fatalf("round %d: a stream did not end", round)
			}
		}
		if status, out := l.call(apiX, next, "GET", "/api/state", ""); status != 200 {
			t.Fatalf("round %d: the state with the new secret: %d %s", round, status, out)
		}
		secret = next
	}
}

// ---- path forms ---------------------------------------------------------------------

// A path in another form than a route's serves nothing on the remote listener: the two with a
// doubled slash are redirected with no data, the others are not found.
func TestRemotePathForms(t *testing.T) {
	t.Parallel()
	e := newEnv(t, withRemote)
	h := e.s.RemoteHandler()
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	leaks := func(what, body string) {
		t.Helper()
		for _, s := range []string{c.ID, `"chats"`, `"agents"`, `"listening"`, `"featureLevel"`} {
			if strings.Contains(body, s) {
				t.Errorf("%s: the answer holds data: %s", what, body)
			}
		}
	}
	for _, path := range []string{"//api/state", "/api//state"} {
		w := remoteDo(h, "GET", path, testHost, testSecret)
		if w.Code != 301 || w.Header().Get("Location") != "/api/state" {
			t.Errorf("GET %s: %d to %q, want 301 to /api/state (%s)", path, w.Code, w.Header().Get("Location"), w.Body)
		}
		leaks("GET "+path, w.Body.String())
		// Without the secret the redirect is not given either.
		wantReply(t, remoteDo(h, "GET", path, testHost, ""), "GET "+path+" with no secret", 401, "unauthorized")
	}
	for _, rq := range [][2]string{
		{"GET", "/api/state/"}, {"GET", "/API/STATE"}, {"GET", "/api/hello/"}, {"GET", "/api"}, {"GET", "/api/"},
		{"GET", "//api/remote/status"}, {"GET", "/api/remote%2fstatus"}, {"HEAD", "/api/remote/status"}, {"OPTIONS", "/api/state"},
	} {
		w := remoteDo(h, rq[0], rq[1], testHost, testSecret)
		what := rq[0] + " " + rq[1]
		if rq[0] == "HEAD" { // an answer to HEAD is read by its status
			if w.Code != 404 {
				t.Errorf("%s: status %d, want 404", what, w.Code)
			}
		} else {
			wantReply(t, w, what, 404, "not found")
		}
		leaks(what, w.Body.String())
	}
	// A chat id that is a path: no chat, and no file outside the chats folder is looked for.
	if w := remoteDo(h, "GET", "/api/chats/..%2F..%2Fetc/items", testHost, testSecret); w.Code != 404 ||
		strings.TrimSpace(w.Body.String()) != `{"code":"not_found","error":"`+chats.ErrNotFound.Error()+`"}` {
		t.Errorf("a chat id that is a path: %d %s, want 404 not_found", w.Code, w.Body)
	}
	// The routes themselves are served.
	if w := remoteDo(h, "GET", "/api/state", testHost, testSecret); w.Code != 200 {
		t.Errorf("GET /api/state: %d %s", w.Code, w.Body)
	}
}
