package server

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/testset"
)

// The routes of this server's own things, with a section connected: they serve this server's
// things alone, and what they refuse of another server.

// A call on /api/chats/…, /api/boards/… or /api/groups/… with the id of a thing of
// a section is a call for a thing this server does not have: it is not found, and the entry's
// server is sent nothing.
func TestLocalRoutesReachNoOtherServer(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}, boards: []model.Board{boardThere(farBoardA)}})
	p := f.page("P")
	chat, board, group := "/api/chats/"+farChatA, "/api/boards/"+farBoardA, "/api/groups/"+farGroup
	image := imageIDOf(png("a"))
	sent := len(f.st.Requests())
	f.untouched("a local route with the id of a section's thing", func() {
		for _, c := range [][3]string{
			{"GET", chat, ""}, {"GET", chat + "/items", ""}, {"GET", chat + "/tree", ""}, {"GET", chat + "/context", ""},
			{"GET", chat + "/subagents/s1/items", ""}, {"POST", chat + "/messages", `{"text":"hello"}`}, {"PUT", chat + "/draft?rev=0", `{"text":"typed"}`},
			{"PATCH", chat, `{"name":"Mine"}`}, {"PATCH", chat, `{"group":"` + model.Ungrouped + `"}`}, {"PATCH", chat, `{"model":"sonnet"}`},
			{"POST", chat + "/interrupt", ""}, {"POST", chat + "/open", ""}, {"POST", chat + "/fork", `{"branch":"main","at":0}`},
			{"PUT", chat + "/label", `{"branch":"main","item":0,"text":"x"}`}, {"POST", chat + "/archive", ""}, {"POST", chat + "/unarchive", ""},
			{"DELETE", chat, ""}, {"POST", chat + "/images?name=a.png", string(png("a"))}, {"GET", chat + "/images/" + image, ""},
			{"POST", "/api/chats", `{"board":"` + farBoardA + `"}`},

			{"GET", board + "/scene", ""}, {"POST", board + "/take", ""}, {"PUT", board + "/scene?rev=3", `{"elements":[]}`},
			{"POST", board + "/rename", `{"name":"Mine"}`}, {"PATCH", board, `{"group":"` + model.Ungrouped + `"}`}, {"POST", board + "/archive", ""},
			{"POST", board + "/seen", ""}, {"POST", board + "/reveal", ""}, {"DELETE", board, ""},

			{"PATCH", group, `{"name":"Mine"}`}, {"POST", group + "/move", `{"parent":"","before":""}`}, {"POST", group + "/archive", ""},
			{"POST", group + "/unarchive", ""}, {"DELETE", group + "?contents=delete", ""}, {"POST", "/api/groups", `{"name":"x","parent":"` + farGroup + `"}`},
		} {
			status, out := f.call(p, c[0], c[1], c[2])
			if status != http.StatusNotFound || decode[map[string]any](t, out)["error"] == "" {
				t.Errorf("%s %s %s: %d %s, want 404", c[0], c[1], c[2], status, out)
			}
		}
		// A chat or a board made in a group this server does not have is refused as it is for
		// any id that is no group's.
		for _, path := range []string{"/api/chats", "/api/boards"} {
			if status, out := f.call(p, "POST", path, `{"name":"x","group":"`+farGroup+`"}`); status != http.StatusBadRequest || !strings.Contains(out, "no such group") {
				t.Errorf("POST %s in a group of the section: %d %s", path, status, out)
			}
		}
		// The two that answer whatever the id is: an unfollow ends what is there to end, and a
		// release by a page that holds nothing lets nothing go.
		f.good(p, "POST", chat+"/unfollow", "")
		if got := f.good(p, "POST", board+"/release", ""); got["state"] != "none" {
			t.Errorf("the release of a board this server does not have: %v", got)
		}
	})
	if got := f.st.Requests(); len(got) != sent {
		t.Errorf("the stand-in was sent %+v", got[sent:])
	}
	// Nothing was made here by any of it, and the section is as it was.
	snap := f.snapshotOf(p)
	if len(snap.Chats) != 0 || len(snap.Boards) != 0 || len(snap.Groups) != 0 {
		t.Errorf("this server's lists after the calls: %+v", snap)
	}
	if sec := snap.Sections[f.entry]; sec == nil || len(sec.Chats) != 1 || len(sec.Boards) != 1 || len(sec.Groups) != 1 {
		t.Errorf("the section after the calls: %+v", sec)
	}

	// A group of this server holds this server's things alone: its archive, its unarchive and
	// its delete with what is in it send that server nothing.
	g := f.group(p, "Mine", "")
	own := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", g)))
	f.untouched("the cascades of a group of this server", func() {
		f.good(p, "POST", "/api/groups/"+g+"/archive", "")
		f.good(p, "POST", "/api/groups/"+g+"/unarchive", "")
		f.good(p, "DELETE", "/api/groups/"+g+"?contents=delete", "")
	})
	if _, err := f.a.Chats.View(own.ID); !errors.Is(err, chats.ErrNotFound) {
		t.Errorf("the chat of the deleted group: %v", err)
	}
}

// What the routes of this server's own things refuse of another server: a body that names one
// where a thing is made (400 "server_refused"), a server for a chat
// (409 "server_fixed"), and a delete of a record alone (400 "no_record"). Nothing is made,
// changed, deleted or sent by any of them.
func TestLocalRoutesRefuseAnotherServer(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}})
	p := f.page("P")
	g := f.group(p, "Mine", "")
	own := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", g, "server", "local")))
	bd := decode[model.Board](t, mustOK(t, f, p, "POST", "/api/boards", form("name", "Own", "group", g, "server", "local")))
	counts := func() [2]int { return [2]int{len(f.a.Chats.Views()), len(f.a.Boards.List())} }
	before := counts()

	sent := len(f.st.Requests())
	f.untouched("what names another server", func() {
		for _, server := range []string{f.entry, noSuchServer, "Studio", "LOCAL", "s_"} {
			for _, c := range [][3]string{
				{"POST", "/api/chats", form("group", g, "server", server)},
				{"POST", "/api/chats", form("id", farNewID, "agent", "claude", "group", g, "server", server)},
				{"POST", "/api/chats", form("board", bd.ID, "server", server)},
				{"POST", "/api/chats", form("server", server)}, // refused for the server before the place is looked at
				{"POST", "/api/boards", form("name", "There", "group", g, "server", server)},
			} {
				if text := f.refuses(p, http.StatusBadRequest, "server_refused", c[0], c[1], c[2]); !strings.Contains(text, sectionPrefix) {
					t.Errorf("%s %s %s: %q", c[0], c[1], c[2], text)
				}
			}
			// A chat's server is the one it was made on: 409, and nothing else of the body is taken.
			for _, id := range []string{own.ID, farChatA} {
				f.refuses(p, http.StatusConflict, "server_fixed", "PATCH", "/api/chats/"+id, form("server", server, "name", "Renamed"))
			}
		}
		f.refuses(p, http.StatusConflict, "server_fixed", "PATCH", "/api/chats/"+own.ID, form("server", "local"))
		// No record is removed alone: the thing stays, whichever server it is on.
		for _, path := range []string{"/api/chats/" + own.ID, "/api/boards/" + bd.ID, "/api/chats/" + farChatA, "/api/chats/nowhere",
			"/api/boards/" + farBoardA} {
			if text := f.refuses(p, http.StatusBadRequest, "no_record", "DELETE", path+"?local=1", ""); text == "" {
				t.Errorf("DELETE %s?local=1: no sentence", path)
			}
		}
		// The count of an entry's things is no route any more.
		for _, id := range []string{f.entry, "local", noSuchServer} {
			if status, out := f.call(p, "GET", "/api/servers/"+id+"/items", ""); status != http.StatusNotFound {
				t.Errorf("GET /api/servers/%s/items: %d %s", id, status, out)
			}
		}
	})
	if got := f.st.Requests(); len(got) != sent {
		t.Errorf("the stand-in was sent %+v", got[sent:])
	}
	if after := counts(); after != before {
		t.Fatalf("the refused calls left %v chats and boards, %v before", after, before)
	}
	if v, err := f.a.Chats.View(own.ID); err != nil || v.Name != "" {
		t.Errorf("the chat after the refused changes: %+v, %v", v, err)
	}
	if _, err := f.a.Chats.View(farNewID); !errors.Is(err, chats.ErrNotFound) {
		t.Errorf("a chat was made by a refused call: %v", err)
	}

	// "local" and no server are this server: made and deleted here.
	release(t, p, bd.ID) // the page that made the board holds it: a delete would wait for it
	for _, path := range []string{"/api/chats/" + own.ID, "/api/boards/" + bd.ID} {
		f.good(p, "DELETE", path+"?local=0", "")
	}
	if _, err := f.a.Chats.View(own.ID); !errors.Is(err, chats.ErrNotFound) {
		t.Errorf("the chat after its delete: %v", err)
	}
	if _, ok := f.a.Boards.Get(bd.ID); ok {
		t.Errorf("the board after its delete is still there")
	}

	// Without a relay the refusals are the same: there is no other server to name.
	e := newEnv(t)
	for _, c := range [][2]string{{"/api/chats", form("group", model.Ungrouped, "server", noSuchServer)}, {"/api/boards", form("name", "x", "group", model.Ungrouped, "server", noSuchServer)}} {
		if got := decode[struct{ Code string }](t, e.expect(400, "POST", c[0], c[1])); got.Code != "server_refused" {
			t.Errorf("without a relay, POST %s: %+v", c[0], got)
		}
	}
	local := e.chat(form("group", model.Ungrouped))
	if got := decode[struct{ Code string }](t, e.expect(400, "DELETE", "/api/chats/"+local.ID+"?local=1", "")); got.Code != "no_record" {
		t.Errorf("without a relay, a delete of a record alone: %+v", got)
	}
}

// The draft of a chat of a section is its server's, with its counter: two pages of this server
// type in the one draft, and that server's counter decides between them, as it does between its
// own pages. While that server is away the draft cannot be saved, and the save is taken, on the
// counter that server has, when it is back. (With that server's own page as the other writer:
// TestTwoPagesInOneDraftOfAChatOnAnotherServer.)
func TestTwoPagesInOneDraftOfASectionsChat(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(farChatA)}})
	p, q := f.page("P"), f.page("Q")
	at := f.on("/chats/" + farChatA + "/draft")
	save := func(page *bridgetest.Page, want int, rev int64, text string) saved {
		t.Helper()
		status, out := f.call(page, "PUT", fmt.Sprintf("%s?rev=%d", at, rev), mustJSON(t, obj{"text": text}))
		if status != want {
			t.Fatalf("the save of %s on %d: %d %s, want %d", page.ID, rev, status, out, want)
		}
		return decode[saved](t, out)
	}
	// told sends what that server tells its clients of the draft it has now.
	told := func() {
		f.mu.Lock()
		d := f.drafts[farChatA]
		f.mu.Unlock()
		v := viewThere(farChatA)
		v.Draft, v.DraftRev, v.HasDraft = d.Draft, d.Rev, d.Draft != nil
		f.st.Send(map[string]any{"type": "branch_state", "state": model.StateOf(farChatA, "main", v)})
		f.st.Send(map[string]any{"type": "chat", "chat": v})
	}
	var lastP, lastQ int64 // the highest draft counter each page was told

	if got := save(p, 200, 0, "typed by P"); got.Rev != 1 {
		t.Fatalf("P's save: %+v", got)
	}
	told()
	for _, c := range []struct {
		page *bridgetest.Page
		last *int64
	}{{p, &lastP}, {q, &lastQ}} {
		if st := draftSeen(t, c.page, f.entry, farChatA, 1, c.last); draftOf(st.Draft) != "typed by P" {
			t.Fatalf("the page %s was told %+v", c.page.ID, st)
		}
	}
	// Q typed on the counter before: refused by that server, with the draft that is there.
	if got := save(q, 409, 0, "typed by Q"); got.Code != "stale" || got.Rev != 1 || draftOf(got.Draft) != "typed by P" {
		t.Fatalf("Q's save on the counter before: %+v", got)
	}
	if got := save(q, 200, 1, "typed by P, and by Q"); got.Rev != 2 {
		t.Fatalf("Q's save: %+v", got)
	}
	told()
	if st := draftSeen(t, p, f.entry, farChatA, 2, &lastP); draftOf(st.Draft) != "typed by P, and by Q" {
		t.Fatalf("P was told %+v", st)
	}
	if got := save(p, 409, 1, "typed by P, more"); got.Code != "stale" || got.Rev != 2 || draftOf(got.Draft) != "typed by P, and by Q" {
		t.Fatalf("P's save on the counter before: %+v", got)
	}
	if sec := f.section(p); len(sec.Chats) != 1 || draftOf(sec.Chats[0].Draft) != "typed by P, and by Q" || sec.Chats[0].DraftRev != 2 || !sec.Chats[0].HasDraft {
		t.Fatalf("the chat in the section: %+v", sec.Chats)
	}

	// Both save on the same counter at once: one is stored, and the other is refused with the
	// stored one's text and counter. Never both, never neither.
	rounds := 5
	if testset.Full() {
		rounds = 50
	}
	rev := int64(2)
	for round := 0; round < rounds; round++ {
		texts := [2]string{fmt.Sprintf("P %d", round), fmt.Sprintf("Q %d", round)}
		var got [2]saved
		var status [2]int
		var wg sync.WaitGroup
		for i, page := range []*bridgetest.Page{p, q} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				var out []byte
				status[i], out = page.Do("PUT", fmt.Sprintf("%s?rev=%d", at, rev), obj{"text": texts[i]})
				got[i] = decode[saved](t, string(out))
			}()
		}
		wg.Wait()
		won := 0
		if status[1] == 200 {
			won = 1
		}
		lost := 1 - won
		if status[won] != 200 || got[won].Rev != rev+1 || status[lost] != 409 || got[lost].Code != "stale" || got[lost].Rev != rev+1 || draftOf(got[lost].Draft) != texts[won] {
			t.Fatalf("round %d: P got %d %+v, Q %d %+v", round, status[0], got[0], status[1], got[1])
		}
		rev++
		// Each page is told every change, on a counter that never goes down.
		told()
		if st := draftSeen(t, p, f.entry, farChatA, rev, &lastP); draftOf(st.Draft) != texts[won] {
			t.Fatalf("round %d: P was told %+v, want %q", round, st, texts[won])
		}
		if st := draftSeen(t, q, f.entry, farChatA, rev, &lastQ); draftOf(st.Draft) != texts[won] {
			t.Fatalf("round %d: Q was told %+v, want %q", round, st, texts[won])
		}
	}

	// The server is away: the save fails with the code the page keeps its text by, and nothing
	// of the draft is kept here. It is back: the save is taken on the counter that server has.
	f.down()
	for _, page := range []*bridgetest.Page{p, q} {
		if got := save(page, 503, rev, "typed while it was away"); got.Code != "server_unreachable" {
			t.Fatalf("a save while the server is away: %+v", got)
		}
	}
	f.up(2)
	if sec := f.section(p); sec == nil {
		t.Fatal("no section after the return")
	}
	if got := save(p, 200, rev, "typed while it was away"); got.Rev != rev+1 {
		t.Fatalf("the save after the return: %+v", got)
	}
	if got := save(q, 409, rev, "typed while it was away, by Q"); got.Code != "stale" || draftOf(got.Draft) != "typed while it was away" {
		t.Fatalf("Q's save after the return, on the counter before: %+v", got)
	}
	if _, err := f.a.Chats.View(farChatA); !errors.Is(err, chats.ErrNotFound) {
		t.Fatalf("the section's chat is a chat of this server: %v", err)
	}
}
