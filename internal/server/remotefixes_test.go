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
	"ai-whiteboard/internal/model"
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
	// The folder of the runs' checkouts is outside the data folder, and its names are run ids.
	work := e.st.P.RunWork
	if err := os.MkdirAll(filepath.Join(work, "r_x", "int"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(work) })
	workLink := filepath.Join(outside, "work")
	if err := os.Symlink(work, workLink); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{work, filepath.Join(work, "r_x"), filepath.Join(work, "r_x", "int"), workLink, filepath.Join(workLink, "r_x")} {
		status, out := l.call(apiX, testSecret, "GET", q(p), "")
		if got := decode[obj](t, out); status != 400 || got["error"] != chats.ErrAppFolder.Error() || len(got) != 1 {
			t.Errorf("the API client's list of %s: %d %s", p, status, out)
		}
		if strings.Contains(out, "r_x") {
			t.Errorf("the refusal for %s names a run: %s", p, out)
		}
		if got := decode[obj](t, e.expect(200, "GET", q(p), "")); got["dirs"] == nil {
			t.Errorf("the page's list of %s: %v", p, got)
		}
	}
	if got := decode[struct{ Dirs []string }](t, e.expect(200, "GET", q(work), "")); !slices.Contains(got.Dirs, "r_x") {
		t.Errorf("the page's list of the runs' work folder: %v", got.Dirs)
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

// The fork of a chat on a board is refused for an API client: it would make a chat on a board.
func TestRemoteForkOfABoardChatIsRefused(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p := e.page("P")
	x, _ := l.api(apiX)
	bd, _ := e.boardChat(p)
	id := e.a.Chats.ChatsOfBoard(bd.ID)[0].ID
	do(t, p, "POST", "/api/chats/"+id+"/messages", map[string]any{"text": "the first message"})
	reply(t, &sp.of(t, id).fakeAgent, "done", "p1")
	items := decode[struct{ Items []model.Item }](t, e.expect(200, "GET", "/api/chats/"+id+"/items", ""))
	if len(items.Items) < 2 {
		t.Fatalf("the items of the chat on the board: %+v", items.Items)
	}
	body := `{"branch":"main","at":` + itoa(len(items.Items)) + `}`
	folders := func() []string {
		t.Helper()
		ents, err := os.ReadDir(e.st.P.Chats)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, en := range ents {
			names = append(names, en.Name())
		}
		return names
	}
	e.reach(p, x)
	chatsBefore, foldersBefore, programs := len(e.a.Chats.Views()), folders(), sp.count()

	status, out := x.Do("POST", "/api/chats/"+id+"/fork", body)
	got := decode[obj](t, string(out))
	if status != 400 || got["code"] != "board_refused" || got["error"] != boardRefused || len(got) != 2 {
		t.Fatalf("the API client's fork of a chat on a board: %d %s", status, out)
	}
	// The creation call's refusal has the same text.
	if made := start(t, x, 400, startBody(chat1, t.TempDir(), "board", bd.ID)); made.Code != "board_refused" || made.Error != got["error"] {
		t.Fatalf("the creation call's refusal: %+v", made)
	}
	if n, names := len(e.a.Chats.Views()), folders(); n != chatsBefore || !slices.Equal(names, foldersBefore) || sp.count() != programs {
		t.Fatalf("the refused fork left %d chats (%d before), the folders %v (%v before), %d programs (%d before)", n, chatsBefore, names, foldersBefore, sp.count(), programs)
	}
	if n := len(e.a.Chats.ChatsOfBoard(bd.ID)); n != 1 {
		t.Fatalf("%d chats on the board after the refused fork", n)
	}
	if evs := e.reach(p, x); len(evs[0]) != 0 || len(evs[1]) != 0 {
		t.Fatalf("the refused fork sent the page %v and the API client %v", evs[0], evs[1])
	}
	// A chat that is not there is answered as before, by the fork itself.
	if status, out := x.Do("POST", "/api/chats/"+chat3+"/fork", body); status != 404 {
		t.Fatalf("the fork of a chat that is not there: %d %s", status, out)
	}

	// The page's fork of the same chat is made, on the board.
	fork := decode[model.ChatView](t, string(do(t, p, "POST", "/api/chats/"+id+"/fork", body)))
	if fork.ID == id || fork.Board != bd.ID || len(e.a.Chats.ChatsOfBoard(bd.ID)) != 2 {
		t.Fatalf("the page's fork: %+v", fork)
	}
}

// ---- a read during a creation call ------------------------------------------------------

// An API client's read of a chat waits for a creation call of that id that is under way, and
// then finds what the call made. A page's read does not wait.
func TestRemoteChatReadWaitsForACreationCall(t *testing.T) {
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	in, release := make(chan struct{}), make(chan struct{})
	started := make(chan error, 1)
	go func() {
		_, err := e.a.Chats.Start(chats.StartReq{ID: chat1, Client: apiX, Agent: model.Claude, Cwd: t.TempDir(), Text: "the first message",
			Place: func() (string, error) {
				close(in)
				<-release
				return e.a.RemoteGroup()
			}})
		started <- err
	}()
	<-in
	type answer struct {
		status int
		body   string
	}
	read := make(chan answer, 1)
	go func() {
		status, out := l.try(apiX, testSecret, "GET", "/api/chats/"+chat1)
		read <- answer{status, out}
	}()
	// The page's read is answered at once, and so is the API client's read of another id and of
	// a string that is no chat id.
	e.expect(404, "GET", "/api/chats/"+chat1, "")
	for _, id := range []string{chat2, "nope"} {
		if status, out := l.call(apiX, testSecret, "GET", "/api/chats/"+id, ""); status != 404 {
			t.Fatalf("the read of %s during the creation call of another id: %d %s", id, status, out)
		}
	}
	select {
	case a := <-read:
		t.Fatalf("the read did not wait for the creation call: %d %s", a.status, a.body)
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	if err := <-started; err != nil {
		t.Fatalf("the creation call: %v", err)
	}
	select {
	case a := <-read:
		if v := decode[model.ChatView](t, a.body); a.status != 200 || v.ID != chat1 {
			t.Fatalf("the read after the creation call: %d %s", a.status, a.body)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the read was not answered after the creation call")
	}
}

// ---- a take of a board that is archived under it ---------------------------------------

// An archive or a delete of the board between the take's check and its grant finds no holder to
// ask. The take then gives the hold back and answers as it does for such a board.
func TestTakeOfABoardArchivedUnderIt(t *testing.T) {
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
	wantReply(t, remoteDo(h, "GET", "/api/chats/..%2F..%2Fetc/items", testHost, testSecret), "a chat id that is a path", 404, chats.ErrNotFound.Error())
	// The routes themselves are served.
	if w := remoteDo(h, "GET", "/api/state", testHost, testSecret); w.Code != 200 {
		t.Errorf("GET /api/state: %d %s", w.Code, w.Body)
	}
}
