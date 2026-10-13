package remotes

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers/standin"
)

// TestSectionFollows: a read that follows makes the page a follower here before it is passed
// on, and this server a follower there for all its pages together. Content events reach the
// followers alone; the last page that unfollows here ends this server's follow there, by its
// own call or by the end of its stream.
func TestSectionFollows(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree())})
	chat := editorbridge.ChatOn(rg.entry, chatA)
	// The page follows by the time its read is at the server.
	var early atomic.Int32
	items := rg.script("GET /api/chats/{id}/items")
	items.set(func(w http.ResponseWriter, r *http.Request) {
		if !rg.b.Followed(chat) {
			early.Add(1)
		}
		writeAnswer(w, http.StatusOK, map[string]any{"version": 1, "items": []any{}, "state": map[string]any{"draftRev": 3}})
	})
	rg.s.Handle("POST /api/chats/{id}/unfollow", func(w http.ResponseWriter, r *http.Request) {
		writeAnswer(w, http.StatusOK, map[string]any{"ok": true})
	})
	ctx := context.Background()
	first, _ := rg.page("page-first")
	second, _ := rg.page("page-second")

	// The read is passed on as it came, and answered as that server answered.
	rep := rg.r.FollowChat(ctx, rg.entry, first.ID, chatA, chatPath(chatA, "/items")+"?branch=main")
	if rep.Status != http.StatusOK || !sameJSON(t, json.RawMessage(rep.Body), map[string]any{"version": 1, "items": []any{}, "state": map[string]any{"draftRev": 3}}) {
		t.Fatalf("the read: %d %s", rep.Status, rep.Body)
	}
	if g := items.last(t); g.Method != "GET" || g.URI != "/api/chats/"+chatA+"/items?branch=main" || early.Load() != 0 {
		t.Fatalf("the read at the server: %+v, before the follow %d times", g, early.Load())
	}
	if got := rg.requests("GET", "/items"); len(got) != 1 || got[0].Client != testLocalID || got[0].Secret != standin.DefaultSecret {
		t.Fatalf("the read at the server: %+v", got)
	}

	contents := map[string]any{"type": "chat_items", "chat": chatA, "version": 2, "updates": []any{}}
	rg.s.Send(contents)
	rg.s.Send(map[string]any{"type": "chat", "chat": farChat(chatA, model.StatusWriting)})
	got := rg.barrier(first, second)
	if len(got[0]) != 2 || got[0][0]["type"] != "chat_items" || got[0][0]["server"] != rg.entry || got[0][1]["type"] != "chat" {
		t.Errorf("the follower got %v", got[0])
	}
	if len(got[1]) != 1 || got[1][0]["type"] != "chat" { // list events only
		t.Errorf("the page that does not follow got %v", got[1])
	}

	// A second follower: the first one's stream ends, and the server is told nothing.
	rg.readChat(second, chatA)
	first.Close()
	rg.until("the first page's follow has ended", func() bool {
		return reflect.DeepEqual(rg.b.Followers(chat), []string{second.ID})
	})
	time.Sleep(quiet)
	if got := rg.requests("POST", "/unfollow"); len(got) != 0 {
		t.Fatalf("an unfollow while a page follows: %+v", got)
	}
	rg.s.Send(contents)
	if got := rg.barrier(second)[0]; len(got) != 1 || got[0]["type"] != "chat_items" {
		t.Errorf("the second follower got %v", got)
	}

	// The last follower's stream ends: one unfollow call, as this server.
	second.Close()
	rg.until("the unfollow call", func() bool { return len(rg.requests("POST", "/unfollow")) > 0 })
	time.Sleep(quiet)
	if got := rg.requests("POST", "/unfollow"); len(got) != 1 || got[0].Path != "/api/chats/"+chatA+"/unfollow" || got[0].Client != testLocalID {
		t.Errorf("the unfollow calls: %+v", got)
	}

	// An unfollow by the page's own call does the same.
	third, _ := rg.page("page-third")
	rg.readChat(third, chatA)
	wantReply(t, "unfollow of the chat", rg.r.UnfollowChat(rg.entry, third.ID, chatA), http.StatusOK, map[string]any{"ok": true})
	rg.until("the chat's unfollow call", func() bool { return len(rg.requests("POST", "/api/chats/"+chatA+"/unfollow")) == 2 })
	if rg.b.Followed(chat) {
		t.Error("a follow is left after its unfollow")
	}

	// A read that is answered "not found" leaves no follow here; one that misses a part of the
	// thing does, and so does one that got no answer.
	items.answer(http.StatusNotFound, map[string]any{"error": "no such chat", "code": "not_found"})
	rep = rg.r.FollowChat(ctx, rg.entry, third.ID, chatA, chatPath(chatA, "/items"))
	wantReply(t, "a read of a chat that is gone", rep, http.StatusNotFound, map[string]any{"error": "no such chat", "code": "not_found"})
	if rg.b.Followed(chat) {
		t.Error("a chat that is gone there is followed here")
	}
	sub := rg.script("GET /api/chats/{id}/subagents/{sid}/items")
	sub.answer(http.StatusNotFound, map[string]any{"error": "no such subagent"})
	rep = rg.r.FollowChat(ctx, rg.entry, third.ID, chatA, chatPath(chatA, "/subagents/s1/items"))
	if rep.Status != http.StatusNotFound || !rg.b.Followed(chat) {
		t.Errorf("a read of a part that is missing: %d, followed %v", rep.Status, rg.b.Followed(chat))
	}

	// The answer of an unfollow is the same in every state of the entry. An id that is no entry
	// has no follow to end: it is answered as every call that names it.
	n := len(rg.requests("POST", "/unfollow"))
	rg.offline()
	wantReply(t, "unfollow of a chat while not connected", rg.r.UnfollowChat(rg.entry, third.ID, chatA), http.StatusOK, map[string]any{"ok": true})
	noServer := map[string]any{"code": "no_server", "error": "This server is not in the list."}
	for _, entry := range []string{"s_000000000000", "local", ""} {
		wantReply(t, "unfollow of a chat on "+entry, rg.r.UnfollowChat(entry, third.ID, chatA), http.StatusNotFound, noServer)
	}
	if got := rg.requests("POST", "/unfollow"); len(got) != n {
		t.Errorf("a server that is not connected was told of an unfollow: %+v", got[n:])
	}
}

// TestSectionUnfollowNeverOvertakesARead: the lock of a thing's follows. While a read is passed
// on the unfollow call waits, and while the unfollow call is out a read waits.
func TestSectionUnfollowNeverOvertakesARead(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree())})
	var mu sync.Mutex
	var order []string
	note := func(s string) {
		mu.Lock()
		defer mu.Unlock()
		order = append(order, s)
	}
	noted := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), order...)
	}
	hold := make(chan struct{}, 2)
	var fast atomic.Bool // answer without waiting
	slow := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			note(name + " in")
			if !fast.Load() {
				<-hold
			}
			note(name + " out")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		}
	}
	rg.s.Handle("GET /api/chats/{id}/items", slow("read"))
	rg.s.Handle("POST /api/chats/{id}/unfollow", slow("unfollow"))
	p, _ := rg.page("page-1")
	read := func(client string) chan struct{} {
		done := make(chan struct{})
		go func() {
			defer close(done)
			rg.r.FollowChat(context.Background(), rg.entry, client, chatA, chatPath(chatA, "/items"))
		}()
		return done
	}
	chat := editorbridge.ChatOn(rg.entry, chatA)

	// A read is out and the page leaves the chat at once: the unfollow waits for the read's answer.
	done := read(p.ID)
	rg.until("the read is at the server", func() bool { return len(noted()) == 1 })
	rg.r.UnfollowChat(rg.entry, p.ID, chatA)
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, []string{"read in"}) {
		t.Fatalf("while the read is out: %v", got)
	}
	hold <- struct{}{}
	<-done
	rg.until("the unfollow is at the server", func() bool { return len(noted()) == 3 })

	// The unfollow is out: a read waits for its answer.
	done = read(p.ID)
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, []string{"read in", "read out", "unfollow in"}) {
		t.Fatalf("while the unfollow is out: %v", got)
	}
	hold <- struct{}{}
	rg.until("the read is at the server", func() bool { return len(noted()) == 5 })
	hold <- struct{}{}
	<-done
	time.Sleep(quiet)
	want := []string{"read in", "read out", "unfollow in", "unfollow out", "read in", "read out"}
	if got := noted(); !reflect.DeepEqual(got, want) {
		t.Errorf("the order at the server: %v", got)
	}
	if !rg.b.Followed(chat) {
		t.Error("the page does not follow after its second read")
	}

	// A chat that a page follows by the time the hook runs is not unfollowed; an item of this
	// server, which has no entry, is not the relay's, and nor is a board.
	fast.Store(true)
	rg.r.Unfollowed([]editorbridge.Item{chat, editorbridge.Chat(chatA), {Kind: "board", ID: boardA, Server: rg.entry}})
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, want) {
		t.Errorf("an unfollow call for a chat that is followed, or is not of a section: %v", got)
	}

	// A read for a caller that has no stream here follows nothing here: the follow it made there
	// is ended after it, unless a page follows the chat.
	<-read("page-without-a-stream")
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, append(want, "read in", "read out")) {
		t.Errorf("a read without a stream while a page follows: %v", got)
	}
	rg.r.UnfollowChat(rg.entry, p.ID, chatA)
	rg.until("the page's unfollow is at the server", func() bool { return len(noted()) == 10 })
	<-read("page-without-a-stream")
	rg.until("the unfollow after the read is at the server", func() bool { return len(noted()) == 14 })
	want = append(want, "read in", "read out", "unfollow in", "unfollow out", "read in", "read out", "unfollow in", "unfollow out")
	if got := noted(); !reflect.DeepEqual(got, want) {
		t.Errorf("a read without a stream: %v", got)
	}
	if rg.b.Followed(chat) {
		t.Error("a read without a stream left a follow here")
	}
}
