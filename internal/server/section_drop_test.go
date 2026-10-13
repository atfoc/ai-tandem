package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// A server that drops and comes back, through the routes, with a chat a page follows and with a
// board a page holds. What the page has open is its own matter; here it is told that
// the section has no tree, every call is 503 until the tree is back, and then the page reads
// again what it shows.

// sectionOf reads the page's events up to the next section event of the rig's entry, and
// returns its tree; nil for one with null.
func (f *far) sectionEvent(p *bridgetest.Page) *pageSnapshot {
	f.t.Helper()
	evs := f.throughIf(p, func(raw string) bool {
		return typeOf(raw) == "section" && strings.Contains(raw, `"server":"`+f.entry+`"`)
	})
	var ev struct{ Tree *pageSnapshot }
	if err := json.Unmarshal([]byte(evs[len(evs)-1]), &ev); err != nil {
		f.t.Fatal(err)
	}
	return ev.Tree
}

func TestServerDropsWithAChatFollowed(t *testing.T) {
	t.Parallel()
	for _, back := range []string{"unchanged", "changed", "deleted"} {
		t.Run(back, func(t *testing.T) {
			t.Parallel()
			f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}})
			p, q := f.page("P"), f.page("Q")
			chat := f.on("/chats/" + farChatA)
			chatItem := editorbridge.ChatOn(f.entry, farChatA)
			content := func() {
				f.st.Send(map[string]any{"type": "chat_items", "chat": farChatA, "branch": "main", "version": 9, "items": []any{}})
			}
			f.good(p, "GET", chat+"/items", "")
			f.good(p, "GET", chat+"/tree", "")
			// contents are the content events each of the two pages got since the last call.
			contents := func() (follower, other []string) {
				got := f.events(p, q)
				return only(got[0], "chat_items"), only(got[1], "chat_items")
			}
			content()
			if follower, other := contents(); len(follower) != 1 || len(other) != 0 {
				t.Fatalf("before the drop the follower got %q and the other page %q", follower, other)
			}

			// The server drops: every page is told, the follows end with the tree, and nothing
			// of the section can be read or changed.
			f.down()
			for _, page := range []*bridgetest.Page{p, q} {
				if tree := f.sectionEvent(page); tree != nil {
					t.Fatalf("the section event at the drop has a tree: %+v", tree)
				}
			}
			if f.s.Bridge.Followed(chatItem) {
				t.Fatal("a follow outlived the tree")
			}
			for _, c := range [][3]string{
				{"GET", chat, ""}, {"GET", chat + "/items", ""}, {"GET", chat + "/tree", ""},
				{"POST", chat + "/messages", `{"text":"hello"}`}, {"PUT", chat + "/draft?rev=0", `{"text":"typed"}`}, {"POST", chat + "/interrupt", ""},
				{"DELETE", chat, ""}, {"POST", f.on("/chats"), `{"group":"` + farGroup + `"}`},
			} {
				if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", c[0], c[1], c[2]); text != "Studio is not connected." {
					t.Errorf("%s %s while the server is away: %q", c[0], c[1], text)
				}
			}
			// The page lets go of what it shows no longer: answered here.
			f.good(q, "POST", chat+"/unfollow", "")
			if sec := f.section(p); sec != nil {
				t.Fatalf("the section while the server is away: %+v", sec)
			}

			// What that server has when it is back.
			renamed := viewThere(farChatA)
			renamed.Name = "Renamed meanwhile"
			switch back {
			case "changed":
				f.change(func(tr *thereTree) { tr.chats = []model.ChatView{renamed} })
			case "deleted":
				f.change(func(tr *thereTree) { tr.chats = nil })
			}
			f.up(2)
			for _, page := range []*bridgetest.Page{p, q} {
				tree := f.sectionEvent(page)
				switch {
				case tree == nil:
					t.Fatal("the section event at the return has no tree")
				case back == "deleted" && len(tree.Chats) != 0:
					t.Fatalf("the tree at the return: %+v", tree)
				case back == "changed" && (len(tree.Chats) != 1 || tree.Chats[0].Name != "Renamed meanwhile"):
					t.Fatalf("the tree at the return: %+v", tree)
				case back == "unchanged" && (len(tree.Chats) != 1 || tree.Chats[0].Name != "Chat 2a"):
					t.Fatalf("the tree at the return: %+v", tree)
				}
			}
			// Nothing is followed until a page reads again: that server forgot the follows.
			if back != "deleted" {
				content()
			}
			if follower, other := contents(); len(follower) != 0 || len(other) != 0 {
				t.Fatalf("after the return, before a read, the pages got %q and %q", follower, other)
			}

			// The page reads again what it shows.
			if back == "deleted" {
				for _, path := range []string{chat, chat + "/items", chat + "/tree"} {
					f.refuses(p, http.StatusNotFound, "not_found", "GET", path, "")
				}
				if f.s.Bridge.Followed(chatItem) {
					t.Fatal("a read of a thing that is gone left a follow")
				}
				return
			}
			view := f.good(p, "GET", chat, "")
			thread := f.good(p, "GET", chat+"/items", "")
			if want := map[string]string{"unchanged": "Chat 2a", "changed": "Renamed meanwhile"}[back]; view["name"] != want || thread["version"] != 3.0 {
				t.Fatalf("the reads after the return: %v, %v", view, thread)
			}
			if !f.s.Bridge.Followed(chatItem) {
				t.Fatal("the reads after the return follow nothing")
			}
			content()
			if follower, other := contents(); len(follower) != 1 || len(other) != 0 {
				t.Fatalf("after the reads the follower got %q and the other page %q", follower, other)
			}
		})
	}
}

// A page holds a board and has saved to it when the board's server drops. It keeps holding the
// board here, a save is 503 and no other page gets the board. When the server is back, this
// server takes the board there again for that page: "held" with that server's revision, at
// which the page saves its edit or drops it, or "superseded" when the board is another's there
// or is gone.
func TestServerDropsWithABoardHeld(t *testing.T) {
	t.Parallel()
	for _, back := range []string{"same revision", "another revision", "held by another", "deleted"} {
		t.Run(back, func(t *testing.T) {
			t.Parallel()
			f := newFar(t, farOpt{boards: []model.Board{boardThere(farBoardA)}})
			p, q := f.page("P"), f.page("Q")
			const takes = "POST /api/boards/{id}/take"
			if state, rev := f.takeOn(p, farBoardA, false); state != "held" || rev != 3 {
				t.Fatalf("P's take: %s at %d", state, rev)
			}
			if status, out := f.writeOn(p, farBoardA, 3, drawing("before the drop")); status != 200 {
				t.Fatalf("P's save: %d %s", status, out)
			}

			f.down()
			f.sectionEvent(p)
			f.holderOn(farBoardA, "P")
			kept := drawing("drawn while the server was away")
			for _, c := range []struct {
				what, method, rest, body string
				by                       *bridgetest.Page
			}{
				{"the holder's save", "PUT", "/scene?rev=4", kept, p},
				{"the holder's take", "POST", "/take", "", p},
				{"another page's take", "POST", "/take", "", q},
				{"another page's take, if free", "POST", "/take", `{"ifFree":true}`, q},
				{"a read of the drawing", "GET", "/scene", "", q},
				{"a rename", "POST", "/rename", `{"name":"Later"}`, p},
				{"a delete", "DELETE", "", "", p},
			} {
				if text := f.refuses(c.by, http.StatusServiceUnavailable, "server_unreachable", c.method, f.on("/boards/"+farBoardA+c.rest), c.body); text != "Studio is not connected." {
					t.Errorf("%s while the server is away: %q", c.what, text)
				}
			}
			f.holderOn(farBoardA, "P")
			if got := f.releaseOn(q, farBoardA); got != "none" {
				t.Fatalf("the release of a page that holds nothing, while the server is away: %s", got)
			}

			// What that server has when it is back.
			switch back {
			case "another revision":
				f.mu.Lock()
				f.revs[farBoardA] = 9
				f.mu.Unlock()
			case "held by another":
				f.answer(takes, 200, map[string]string{"state": "busy"})
			case "deleted":
				f.change(func(tr *thereTree) { tr.boards = nil })
			}
			n := len(f.sent(takes))
			f.up(2)
			if tree := f.sectionEvent(p); tree == nil || (back == "deleted") != (len(tree.Boards) == 0) {
				t.Fatalf("the tree at the return: %+v", tree)
			}
			switch back {
			case "same revision":
				if ev := f.role(p, "held", farBoardA); ev["rev"] != 4.0 {
					t.Fatalf("the grant at the return: %v", ev)
				}
				f.holderOn(farBoardA, "P")
				if status, out := f.writeOn(p, farBoardA, 4, kept); status != 200 || decode[map[string]any](t, out)["rev"] != 5.0 {
					t.Fatalf("the save of the kept edit: %d %s", status, out)
				}
				if c := f.last("PUT /api/boards/{id}/scene"); c.Body != kept || c.Query != "rev=4" {
					t.Fatalf("the save that was passed on: %+v", c)
				}
			case "another revision":
				if ev := f.role(p, "held", farBoardA); ev["rev"] != 9.0 {
					t.Fatalf("the grant at the return: %v", ev)
				}
				f.holderOn(farBoardA, "P")
				status, out := f.writeOn(p, farBoardA, 4, kept)
				if got := decode[map[string]any](t, out); status != 409 || got["code"] != "stale" || got["rev"] != 9.0 {
					t.Fatalf("the save of the edit on the revision before the outage: %d %s", status, out)
				}
				if status, out := f.writeOn(p, farBoardA, 9, drawing("drawn anew")); status != 200 {
					t.Fatalf("a save on that server's revision: %d %s", status, out)
				}
			default: // the board is another's there, or is gone: the page has lost it
				f.role(p, "superseded", farBoardA)
				f.holderOn(farBoardA, "")
				f.refuses(p, http.StatusConflict, "not_holder", "PUT", f.on("/boards/"+farBoardA+"/scene?rev=4"), kept)
				if back == "deleted" {
					f.refuses(p, http.StatusNotFound, "not_found", "POST", f.on("/boards/"+farBoardA+"/take"), "")
					f.refuses(p, http.StatusNotFound, "not_found", "GET", f.on("/boards/"+farBoardA+"/scene"), "")
				} else if state, _ := f.takeOn(p, farBoardA, true); state != "busy" {
					t.Fatalf("a take, if free, of the board that is another's there: %s", state)
				}
			}
			// The take at the return is this server's own, and takes the board only if it is free.
			if got := f.sent(takes); len(got) <= n || got[n].Body != `{"ifFree":true}` || got[n].Path != "/api/boards/"+farBoardA+"/take" {
				t.Fatalf("the take at the return: %+v", got[n:])
			}
		})
	}
}
