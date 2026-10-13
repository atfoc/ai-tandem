package editorbridge

import (
	"reflect"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// A thing of another server is named by the entry id and its id there: a follow, a list event
// and a content event of a chat of a section do not reach who follows the local chat with the
// same id, nor the other way round, and none of them reaches an API client.
func TestSectionItemsAreKeyedByServerToo(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	api := newAPIServer(t, b, nil)
	local, far, other := open(t, srv, "L"), open(t, srv, "F"), open(t, srv, "O")
	x := openAPI(t, api, "X")
	s := &sentinel{b: b}
	b.Follow("L", Chat("c1"))
	b.Follow("X", Chat("c1"))
	b.Follow("F", ChatOn("s_1", "c1"))
	b.Follow("O", ChatOn("s_2", "c1"))
	b.Follow("X", ChatOn("s_1", "c1")) // an API client follows nothing of a section, whatever it asks

	// A content event of the chat c1 of s_1: its follower among the pages, and nobody else.
	b.SendChatOn("s_1", "c1", false, map[string]any{"type": "chat_items", "server": "s_1", "chat": "c1"})
	s.send()
	if ev := far.Expect("chat_items"); ev["server"] != "s_1" {
		t.Fatalf("the follower got %v", ev)
	}
	for _, c := range []*bridgetest.Page{local, far, other, x} {
		if got := s.until(t, c); len(got) != 0 {
			t.Errorf("%s got %v", c.ID, got)
		}
	}
	// The same event of the local chat c1: its followers, the API client among them.
	b.SendChat("c1", map[string]any{"type": "chat_items", "chat": "c1"})
	s.send()
	for _, c := range []*bridgetest.Page{local, x} {
		if got := s.until(t, c); !reflect.DeepEqual(got, []string{"chat_items"}) {
			t.Errorf("%s got %v", c.ID, got)
		}
	}
	for _, c := range []*bridgetest.Page{far, other} {
		if got := s.until(t, c); len(got) != 0 {
			t.Errorf("%s got %v", c.ID, got)
		}
	}

	// The list events of a section go to every page and to no API client, for a chat, a board
	// and for the section's groups.
	b.SendChatOn("s_1", "c1", false, map[string]any{"type": "chat", "server": "s_1"})
	b.SendBoardOn("s_1", "b1", map[string]any{"type": "board", "server": "s_1"})
	b.BroadcastOn("s_1", map[string]any{"type": "groups", "server": "s_1"})
	s.send()
	for _, c := range []*bridgetest.Page{local, far, other} {
		if got := s.until(t, c); !reflect.DeepEqual(got, []string{"chat", "board", "groups"}) {
			t.Errorf("%s got %v", c.ID, got)
		}
	}
	if got := s.until(t, x); len(got) != 0 {
		t.Errorf("the API client got %v", got)
	}

	// The removal of the chat of s_1 ends its follows, and no other chat's.
	b.SendChatOn("s_1", "c1", false, map[string]any{"type": "chat_removed", "server": "s_1", "id": "c1"})
	if b.Followed(ChatOn("s_1", "c1")) || !b.Followed(Chat("c1")) || !b.Followed(ChatOn("s_2", "c1")) {
		t.Fatalf("after the removal: s_1 %v, local %v, s_2 %v", b.Followed(ChatOn("s_1", "c1")), b.Followed(Chat("c1")), b.Followed(ChatOn("s_2", "c1")))
	}
}

// ForgetServer ends every follow of one entry's things, calls no hook, and leaves the others.
func TestForgetServer(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	hook := hookOf(t, b)
	open(t, srv, "P")
	b.Follow("P", ChatOn("s_1", "c1"))
	b.Follow("P", ChatOn("s_2", "c1"))
	b.Follow("P", Chat("c1"))
	b.ForgetServer("s_1")
	b.ForgetServer("")
	if b.Followed(ChatOn("s_1", "c1")) {
		t.Fatal("a follow of s_1 is left")
	}
	if !b.Followed(ChatOn("s_2", "c1")) || !b.Followed(Chat("c1")) {
		t.Fatal("a follow of another server, or of this one, is gone")
	}
	hook.none(100 * time.Millisecond)
}

// A board of a section and a local board with the same id are two boards: each has its own
// holder, and the role events of the section's board name its server and its own id.
func TestSectionBoardIsHeldByKey(t *testing.T) {
	t.Parallel()
	b, srv := newTestServer(t, nil)
	b.SceneRev = func(key string) int64 {
		if key == BoardOn("s_1", "b1") {
			return 7
		}
		return 1
	}
	p, q := open(t, srv, "P"), open(t, srv, "Q")
	b.handoverAfter = time.Hour
	key := BoardOn("s_1", "b1")
	if server, id := SplitBoard(key); server != "s_1" || id != "b1" {
		t.Fatalf("SplitBoard(%q) = %q, %q", key, server, id)
	}
	if server, id := SplitBoard("b1"); server != "" || id != "b1" {
		t.Fatalf("SplitBoard of a local board = %q, %q", server, id)
	}
	if rev := take(t, b, "P", "b1", false, "held"); rev != 1 {
		t.Fatalf("the local board: rev %d", rev)
	}
	if rev := take(t, b, "Q", key, false, "held"); rev != 7 {
		t.Fatalf("the section's board: rev %d", rev)
	}
	if h, _ := b.HolderOf("b1"); h != "P" {
		t.Fatalf("the local board is held by %q", h)
	}
	if h, _ := b.HolderOf(key); h != "Q" {
		t.Fatalf("the section's board is held by %q", h)
	}

	// P takes the section's board: Q is asked to release it, by its own id and its server.
	take(t, b, "P", key, false, "waiting")
	if ev := q.Expect("release_request"); ev["board"] != "b1" || ev["server"] != "s_1" {
		t.Fatalf("release_request: %v", ev)
	}
	if got := b.ReleaseBoard("Q", key); got != "handed" {
		t.Fatalf("release: %q", got)
	}
	if ev := q.Expect("superseded"); ev["board"] != "b1" || ev["server"] != "s_1" {
		t.Fatalf("superseded: %v", ev)
	}
	if ev := p.Expect("held"); ev["board"] != "b1" || ev["server"] != "s_1" || ev["rev"] != float64(7) {
		t.Fatalf("held: %v", ev)
	}
	// A role event of a local board has no "server".
	take(t, b, "Q", "b1", false, "waiting")
	if ev := p.Expect("release_request"); ev["board"] != "b1" || ev["server"] != nil {
		t.Fatalf("release_request of the local board: %v", ev)
	}
}
