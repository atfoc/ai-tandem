package server

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
)

// No chain (goal, section 5): a remote server never passes a client's call on to a third server.
// The server A is a client of B and has a page that holds a board of B; an agent on B asks for
// the board, and A passes the call on to its page under an id of its own. A is a remote server
// too. A client of A that states that page's id answers the call by no route: its answer is
// refused, and its answer above the size limit, which fails the call it names when a page sends
// it, fails nothing. B is told nothing for it: the call stays open, and the agent gets the
// answer of the page.
func TestLevel5AClientAnswersNoCallOfAnotherServer(t *testing.T) {
	t.Parallel()
	pr := newPair(t, remotes.Limits{})
	p := pr.a.page(pageUUID)
	bd, _ := pr.create(p, "Untitled")
	pr.holders(bd.ID, pageUUID, testLocalID)
	_, token := pr.boardChat(p, bd.ID)

	type result struct {
		text  string
		isErr bool
	}
	called := make(chan result, 1)
	go func() {
		text, isErr := pr.b.tool(token, "read_board")
		called <- result{text, isErr}
	}()
	id, _ := pr.event(p, "rpc", func(map[string]any) bool { return true })["id"].(string)
	if !pr.a.s.Remotes.IsBoardCall(id) {
		t.Fatalf("the call A's page was asked has the id %q, not one of a call that was passed on", id)
	}

	// A's remote port, asked as its own handler is: the secret, the Host, the level, and the id
	// of the page as the client's.
	const host = "a.test:4748"
	pr.a.s.Remote = NewRemote(4748, []string{"a.test"}, "", testSecret)
	remote := pr.a.s.RemoteHandler()
	ask := func(body string) (int, string) {
		req := httptest.NewRequest("POST", "/api/rpc-reply", strings.NewReader(body))
		req.Host = host
		for name, v := range map[string]string{SecretHeader: testSecret, ClientHeader: pageUUID, servers.LevelHeader: testLevel} {
			req.Header.Set(name, v)
		}
		w := httptest.NewRecorder()
		remote.ServeHTTP(w, req)
		return w.Code, strings.TrimSpace(w.Body.String())
	}
	status, out := ask(`{"id":"` + id + `","result":"a client's"}`)
	l5Is(t, "a client's answer to a call of another server", status, out, 409, `{"error":"not_asked"}`)
	status, out = ask(`{"id":"` + id + `","error":"a client's"}`)
	l5Is(t, "a client's error for a call of another server", status, out, 409, `{"error":"not_asked"}`)
	if status, out = ask(`{"id":"` + id + `","result":"` + strings.Repeat("a", rpcReplyMax) + `"}`); status != 413 || !strings.Contains(out, "larger than 32 MB") {
		t.Fatalf("a client's answer above the limit: %d %s", status, out)
	}

	// The call is the page's still: its answer is taken, and it is the one the agent gets.
	if got := decode[obj](t, string(do(t, p, "POST", "/api/rpc-reply", obj{"id": id, "result": "the page's own"}))); got["ok"] != true {
		t.Fatalf("the page's answer: %v", got)
	}
	select {
	case r := <-called:
		if r.isErr || r.text != "the page's own" {
			t.Fatalf("the agent's call was answered %q (error %v), want the page's answer", r.text, r.isErr)
		}
	case <-time.After(waitLimit):
		t.Fatal("the agent's call did not end with the page's answer")
	}
}
