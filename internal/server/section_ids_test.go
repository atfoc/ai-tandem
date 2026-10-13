package server

import (
	"net/http"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
)

// An id is unique on one server only. A chat and a board of this server and of a section
// that have the same id are two things everywhere a page or this server names one: the local
// route and the section's route each reach their own, the follows and the holds do not mix, and
// the events are told apart by "server".
func TestSameIDHereAndInASection(t *testing.T) {
	t.Parallel()
	f := newFar(t, farOpt{})
	p, q := f.page("P"), f.page("Q")

	// This server's things. The page that made the board holds it.
	chat := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", `{"id":"`+farChatA+`","group":"`+model.Ungrouped+`"}`)).ID
	board := decode[model.Board](t, mustOK(t, f, p, "POST", "/api/boards", form("name", "Here", "group", model.Ungrouped))).ID
	// That server has a chat and a board with the same ids: its tree comes anew.
	there, boardThereView := viewThere(chat), boardThere(board)
	there.Name = "There"
	f.change(func(tr *thereTree) {
		tr.chats, tr.boards = []model.ChatView{there}, []model.Board{boardThereView}
	})
	f.st.DropStreams()
	f.returned(2)
	f.events(p, q)

	// ---- the lists: each thing once in its own, and no thing in the other's.
	snap := f.snapshotOf(p)
	sec := snap.Sections[f.entry]
	if len(snap.Chats) != 1 || snap.Chats[0].Locked || snap.Chats[0].Name == "There" || len(snap.Boards) != 1 || snap.Boards[0].Name != "Here" {
		t.Fatalf("this server's lists: %+v, %+v", snap.Chats, snap.Boards)
	}
	if sec == nil || len(sec.Chats) != 1 || sec.Chats[0].Name != "There" || len(sec.Boards) != 1 || sec.Boards[0].Name != boardThereView.Name {
		t.Fatalf("the section's lists: %+v", sec)
	}

	// ---- the reads and the writes: a local route sends that server nothing, and a section's
	// route changes nothing here.
	f.untouched("the routes of this server's things", func() {
		if v := f.good(p, "GET", "/api/chats/"+chat, ""); v["locked"] != false || v["name"] == "There" {
			t.Errorf("this server's chat: %v", v)
		}
		f.good(p, "PATCH", "/api/chats/"+chat, `{"name":"Renamed here"}`)
		f.good(p, "POST", "/api/boards/"+board+"/rename", `{"name":"Renamed"}`)
		f.good(p, "PUT", "/api/chats/"+chat+"/draft?rev=0", `{"text":"typed here"}`)
	})
	if v := f.good(p, "GET", f.on("/chats/"+chat), ""); v["locked"] != true || v["name"] != "There" {
		t.Errorf("the section's chat: %v", v)
	}
	f.good(p, "PATCH", f.on("/chats/"+chat), `{"name":"Renamed there"}`)
	f.good(p, "POST", f.on("/boards/"+board+"/rename"), `{"name":"Renamed there"}`)
	f.good(p, "PUT", f.on("/chats/"+chat+"/draft?rev=0"), `{"text":"typed there"}`)
	for pat, want := range map[string]string{"PATCH /api/chats/{id}": `{"name":"Renamed there"}`,
		"POST /api/boards/{id}/rename": `{"name":"Renamed there"}`, "PUT /api/chats/{id}/draft": `{"text":"typed there"}`} {
		if got := f.sent(pat); len(got) != 1 || got[0].Body != want {
			t.Errorf("%s: the stand-in got %+v", pat, got)
		}
	}
	if v, err := f.a.Chats.View(chat); err != nil || v.Name != "Renamed here" || v.Draft == nil || v.Draft.Text != "typed here" || v.DraftRev != 1 {
		t.Errorf("this server's chat after the section's calls: %+v, %v", v, err)
	}
	if bd, _ := f.a.Boards.Get(board); bd.Name != "Renamed" {
		t.Errorf("this server's board after the section's calls: %+v", bd)
	}
	f.events(p, q)

	// ---- the follows: P follows this server's chat, Q the section's. Each gets the content of
	// its own, and the end of one follow is not the end of the other.
	f.good(p, "GET", "/api/chats/"+chat+"/items", "")
	f.good(q, "GET", f.on("/chats/"+chat+"/items"), "")
	content := func(what string, pHas, qHas int) {
		t.Helper()
		f.s.Bridge.SendChat(chat, map[string]any{"type": "chat_items", "chat": chat, "branch": "main", "version": 7, "items": []any{}})
		f.st.Send(map[string]any{"type": "chat_items", "chat": chat, "branch": "main", "version": 8, "items": []any{}})
		got := f.events(p, q)
		for i := range got {
			got[i] = only(got[i], "chat_items")
		}
		for _, raw := range got[0] {
			if strings.Contains(raw, `"server"`) || !strings.Contains(raw, `"version":7`) {
				t.Errorf("%s: the page that follows this server's things got %s", what, raw)
			}
		}
		for _, raw := range got[1] {
			if !strings.Contains(raw, `"server":"`+f.entry+`"`) || !strings.Contains(raw, `"version":8`) {
				t.Errorf("%s: the page that follows the section's things got %s", what, raw)
			}
		}
		if len(got[0]) != pHas || len(got[1]) != qHas {
			t.Errorf("%s: the pages got %q and %q", what, got[0], got[1])
		}
	}
	content("both follow", 1, 1)
	// A page's unfollow of the one is no unfollow of the other, whoever it is.
	f.good(p, "POST", f.on("/chats/"+chat+"/unfollow"), "")
	f.good(q, "POST", "/api/chats/"+chat+"/unfollow", "")
	content("after an unfollow of the thing the page does not follow", 1, 1)
	f.good(q, "POST", f.on("/chats/"+chat+"/unfollow"), "")
	content("after the end of the section's follow", 1, 0)
	if b := f.s.Bridge; !b.Followed(editorbridge.Chat(chat)) || b.Followed(editorbridge.ChatOn(f.entry, chat)) {
		t.Error("the follows after the unfollow are not the one that is left")
	}

	// ---- the holds: P holds this server's board, and Q takes the section's, which is free.
	here, on := board, editorbridge.BoardOn(f.entry, board)
	if state, rev := f.takeOn(q, board, true); state != "held" || rev != 3 {
		t.Fatalf("Q's take of the section's board while P holds this server's: %s at %d", state, rev)
	}
	holders := func(what, wantHere, wantOn string) {
		t.Helper()
		gotHere, _ := f.s.Bridge.HolderOf(here)
		gotOn, _ := f.s.Bridge.HolderOf(on)
		if gotHere != wantHere || gotOn != wantOn {
			t.Fatalf("%s: this server's board is held by %q and the section's by %q, want %q and %q", what, gotHere, gotOn, wantHere, wantOn)
		}
	}
	holders("after the takes", "P", "Q")
	// Each saves its own, at its own revision, and is no holder of the other.
	f.untouched("the save of this server's board", func() { written(t, p, board, 0, drawing("here")) })
	if status, out := f.writeOn(q, board, 3, drawing("there")); status != 200 {
		t.Fatalf("Q's save of the section's board: %d %s", status, out)
	}
	if c := f.last("PUT /api/boards/{id}/scene"); c.Body != drawing("there") {
		t.Fatalf("the save that was passed on: %+v", c)
	}
	f.stored(board, drawing("here"), 1)
	if status, out := write(q, board, 1, drawing("Q's")); status != 409 || !strings.Contains(string(out), "not_holder") {
		t.Fatalf("Q's save of this server's board: %d %s", status, out)
	}
	f.refuses(p, http.StatusConflict, "not_holder", "PUT", f.on("/boards/"+board+"/scene?rev=4"), drawing("P's"))
	// A role event of the one is not the other's.
	f.events(p, q)
	f.st.Send(map[string]any{"type": "release_request", "board": board})
	f.role(q, "release_request", board)
	if got := only(f.events(p)[0], "release_request", "held", "superseded"); len(got) != 0 {
		t.Fatalf("the holder of this server's board got %q", got)
	}
	// A release of the one leaves the other.
	if got := release(t, p, board); got != "free" {
		t.Fatalf("P's release of this server's board: %s", got)
	}
	holders("after P let this server's board go", "", "Q")
	if got := f.releaseOn(p, board); got != "none" {
		t.Fatalf("P's release of the section's board, which it does not hold: %s", got)
	}
	holders("after a release by a page that holds nothing", "", "Q")

	// ---- the events of the lists: with "server" for the section's thing, without for this one's.
	f.events(p, q)
	f.good(p, "PATCH", "/api/chats/"+chat, `{"name":"Told here"}`)
	told := viewThere(chat)
	told.Name = "Told there"
	f.st.Send(map[string]any{"type": "chat", "chat": told})
	var ours, theirs int
	for _, ev := range seenOf(t, f.events(q)[0]) {
		switch {
		case ev.Type != "chat":
		case ev.Server == "" && strings.Contains(ev.raw, "Told here"):
			ours++
		case ev.Server == f.entry && strings.Contains(ev.raw, "Told there"):
			theirs++
		default:
			t.Errorf("a chat event that is neither: %s", ev.raw)
		}
	}
	if ours != 1 || theirs != 1 {
		t.Errorf("the chat events: %d of this server, %d of the section", ours, theirs)
	}

	// ---- a delete of the one leaves the other.
	f.untouched("the delete of this server's things", func() {
		f.good(p, "DELETE", "/api/chats/"+chat, "")
		f.good(p, "DELETE", "/api/boards/"+board, "")
		for _, path := range []string{"/api/chats/" + chat, "/api/chats/" + chat + "/items", "/api/boards/" + board + "/scene"} {
			if status, out := f.call(p, "GET", path, ""); status != http.StatusNotFound {
				t.Errorf("GET %s after the delete: %d %s", path, status, out)
			}
		}
	})
	if v := f.good(p, "GET", f.on("/chats/"+chat), ""); v["name"] != "There" {
		t.Errorf("the section's chat after the delete of this server's: %v", v)
	}
	holders("after the delete of this server's board", "", "Q")
	if sec := f.section(p); sec == nil || len(sec.Chats) != 1 || len(sec.Boards) != 1 {
		t.Errorf("the section after the delete of this server's things: %+v", sec)
	}
	f.good(p, "DELETE", f.on("/chats/"+chat), "")
	if c := f.last("DELETE /api/chats/{id}"); c.Path != "/api/chats/"+chat {
		t.Errorf("the delete of the section's chat: %+v", c)
	}
}
