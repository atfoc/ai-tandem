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
	req.Header.Set(LevelHeader, testLevel)
	resp, err := l.http.Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// ---- a follow is of the listener's kind ------------------------------------------

// A read starts the follow of the client that makes it, an unfollow ends its own and no other's,
// and a failed read ends the follow of its own client only.
func TestFollowsAreEachClients(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	e.page(pageUUID)
	l.api(apiX)
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	path := "/api/chats/" + c.ID
	followers := func(what string, want ...string) {
		t.Helper()
		slices.Sort(want)
		if got := e.s.Bridge.Followers(editorbridge.Chat(c.ID)); !slices.Equal(got, want) {
			t.Fatalf("followers after %s: %v, want %v", what, got, want)
		}
	}
	call := func(client, method, sub string) {
		t.Helper()
		if status, out := l.call(client, testSecret, method, path+sub, ""); status != 200 {
			t.Fatalf("%s %s as %s: %d %s", method, sub, client, status, out)
		}
	}
	followers("no read")
	call(pageUUID, "GET", "/items")
	followers("the first client's read", pageUUID)
	call(apiX, "GET", "/tree")
	followers("the second client's read", pageUUID, apiX)
	call(apiX, "POST", "/unfollow")
	followers("the second client's unfollow", pageUUID)
	call(apiX, "POST", "/unfollow") // nothing to end
	followers("a second unfollow", pageUUID)

	// A failed read ends the follow of its own client only.
	gone := "/api/chats/" + chat3
	e.s.Bridge.Follow(apiX, editorbridge.Chat(chat3))
	e.s.Bridge.Follow(pageUUID, editorbridge.Chat(chat3))
	if status, _ := l.call(apiX, testSecret, "GET", gone+"/items", ""); status != 404 {
		t.Fatalf("the read of a chat that is not there: %d", status)
	}
	if got := e.s.Bridge.Followers(editorbridge.Chat(chat3)); !slices.Equal(got, []string{pageUUID}) {
		t.Fatalf("followers after the failed read: %v", got)
	}
	call(pageUUID, "POST", "/unfollow")
	followers("the first client's unfollow")
}

// ---- the folder list ---------------------------------------------------------------

// A client does not list the data folder or a folder inside it.
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
	}
	// A folder outside is listed.
	for _, p := range []string{outside, filepath.Join(outside, "sub"), filepath.Dir(data)} {
		status, out := l.call(apiX, testSecret, "GET", q(p), "")
		if status != 200 || decode[obj](t, out)["dirs"] == nil {
			t.Errorf("the API client's list of %s: %d %s", p, status, out)
		}
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
			req.Header.Set(LevelHeader, testLevel)
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
