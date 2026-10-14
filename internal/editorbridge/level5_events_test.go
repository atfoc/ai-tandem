package editorbridge

import (
	"slices"
	"sort"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
)

// What a client is sent, type by type: the list types of the server's whole tree go to every
// client, the content types to the clients that follow the chat, and the types of nobody's (the
// role types, the types of other servers that went with the page) to none. A client that made
// nothing and follows nothing gets every list event of a chat and a board, and of the groups and
// the defaults.
func TestEventsOfAClient(t *testing.T) {
	t.Parallel()
	list := []string{"groups", "defaults", "board", "board_removed", "chat", "chat_removed", "branch_state",
		"catalog", "agents", "own_library"}
	content := []string{"tree", "chat_items", "sub", "sub_items"}
	never := []string{"servers", "server_state", "server_lists", "library", "library_removed", "section", "server_back", "chat_reload",
		"hello", "snapshot", "held", "release_request", "superseded", "rpc", "server_stopping"}

	var allowed []string
	for typ, rule := range Events {
		if rule.Class == List || rule.Class == Content {
			allowed = append(allowed, typ)
		}
	}
	want := slices.Concat(list, content)
	sort.Strings(allowed)
	sort.Strings(want)
	if !slices.Equal(allowed, want) {
		t.Fatalf("the list and content rows of Events are %v, want %v", allowed, want)
	}

	b, srv := newTestServer(t, nil)
	y, f := open(t, srv, "Y"), open(t, srv, "F")
	s := &sentinel{b: b}
	// send sends an event of the type as its sender would: of the chat c1, the board b1, or
	// of no item.
	send := func(typ string) {
		ev := map[string]any{"type": typ}
		switch Events[typ].Per {
		case PerChat:
			b.SendChat("c1", ev)
		case PerBoard:
			b.SendBoard("b1", ev)
		default:
			b.Broadcast(ev)
		}
	}
	got := func(c *bridgetest.Page) []string { return s.until(t, c) }
	for _, typ := range list {
		send(typ)
		s.send()
		if ys, fs := got(y), got(f); !slices.Equal(ys, []string{typ}) || !slices.Equal(fs, []string{typ}) {
			t.Errorf("%s: the client that follows nothing got %v, the follower %v, want it for both", typ, ys, fs)
		}
	}
	// F follows the chat from here on: its removal above would have ended it.
	if !b.Follow("F", Chat("c1")) {
		t.Fatal("Follow refused a connected client")
	}
	for _, typ := range content {
		send(typ)
		s.send()
		if ys, fs := got(y), got(f); len(ys) != 0 || !slices.Equal(fs, []string{typ}) {
			t.Errorf("%s: the client that follows nothing got %v, the follower %v, want it for the follower alone", typ, ys, fs)
		}
	}
	for _, typ := range never {
		send(typ)
		s.send()
		if ys, fs := got(y), got(f); len(ys)+len(fs) != 0 {
			t.Errorf("%s: clients got %v and %v, want it for none", typ, ys, fs)
		}
	}
}
