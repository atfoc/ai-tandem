package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/store"
)

// An id is unique on one server only (goal, section 5, and section 7; contract V5), with real
// halves: one local server with two sections, each a real remote server, and a chat with the
// same id, in a group with the same id, on all three. Everywhere a page or the local server
// names one of them, the entry's id tells them apart: in a path after /api/on/, and as "server"
// in an event.

const (
	// sameGroup is the id of a group that each of the three servers has.
	sameGroup = "g_samesame"
	// twinID is the instance id of the second remote server of a twin.
	twinID = "4a3c9d2f-8b5e-4f0a-ad66-1e2f3a4b5c6d"
)

// twin is one local server whose list has two entries, each a real remote server.
type twin struct {
	t     *testing.T
	a     *env // the local server
	m     *servers.Manager
	rm    *remotes.Relay
	b     [2]*env        // the remote servers
	sp    [3]*apiSpawner // the agents of the local server and of the two remote servers
	entry [2]string      // the two entries of the local server's list
	place [3]string      // what the path of a call for a thing of each server starts with
	name  [3]string      // what a failure calls each server
	marks atomic.Int64
}

// seeded gives a server the group every server of a twin has, under this name: its state is
// as a data folder has it in which that group was made.
func seeded(t *testing.T, name string) func(*Server) {
	return func(s *Server) {
		if err := s.App.St.Update(func(st *model.State) error {
			st.Groups = append(st.Groups, model.Group{ID: sameGroup, Name: name})
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
}

// newTwin starts the three servers. Each of with sets every one of them up, by the name a
// failure calls it, after its group was made.
func newTwin(t *testing.T, with ...func(name string) func(*Server)) *twin {
	t.Helper()
	tw := &twin{t: t, name: [3]string{"this server", "Studio", "Atelier"}}
	for i := range tw.sp {
		tw.sp[i] = &apiSpawner{}
	}
	more := func(i int) func(*Server) {
		return func(s *Server) {
			for _, f := range with {
				f(tw.name[i])(s)
			}
		}
	}
	var ls [2]*listener
	for i := range tw.b {
		// Each remote server is an instance of its own: a list has no two entries for one.
		instance := func(s *Server) { s.InstanceID = []string{ownID, twinID}[i] }
		tw.b[i], ls[i] = remoteEnv(t, withAgents(tw.sp[i+1]), seeded(t, "Group of "+tw.name[i+1]), more(i+1), instance)
	}
	tw.a = newEnv(t, withAgents(tw.sp[0]), seeded(t, "Group of "+tw.name[0]), more(0), func(s *Server) {
		tw.m, tw.rm = wiring{root: t.TempDir(), id: bothID1}.wire(t, s)
		for i, l := range ls {
			tw.entry[i] = entryFor(t, tw.m, tw.name[i+1], l)
		}
		tw.m.Start()
	})
	tw.place = [3]string{"/api", strings.TrimSuffix(sectionPrefix+tw.entry[0], "/"), strings.TrimSuffix(sectionPrefix+tw.entry[1], "/")}
	for end := time.Now().Add(waitLimit); len(tw.rm.Sections()) != 2; time.Sleep(2 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("the local server holds the trees %v, want those of both entries", tw.rm.Sections())
		}
	}
	return tw
}

// server is what an event of each server has as "server" on a page: none for the local one.
func (tw *twin) server(i int) string {
	if i == 0 {
		return ""
	}
	return tw.entry[i-1]
}

// of is which server an event a page got is about: 0 for the local one, 1 and 2 for the
// entries. An event that names any other server fails the test.
func (tw *twin) of(raw string) int {
	tw.t.Helper()
	server := decode[struct{ Server string }](tw.t, raw).Server
	for i := range tw.place {
		if tw.server(i) == server {
			return i
		}
	}
	tw.t.Fatalf("an event names the server %q: %s", server, raw)
	return -1
}

// reach returns, for each page, the events it was sent and has not read yet, by the server
// they are about. Each of the three servers sends a mark of this call's own (the local one an
// agents event, a remote one a model list, which a page gets as the lists of its entry): what a
// server sent before is in front of its mark, and a page is read until it has all three.
func (tw *twin) reach(pages ...*bridgetest.Page) [][3][]string {
	tw.t.Helper()
	mark := fmt.Sprintf("twin-mark-%d", tw.marks.Add(1))
	tw.a.s.Bridge.Broadcast(map[string]any{"type": "agents", "agents": tw.a.a.Agents.List(), "mark": mark})
	for _, b := range tw.b {
		b.s.Bridge.Broadcast(map[string]any{"type": "catalog", "agent": model.Pi,
			"catalog": model.Catalog{Models: []model.CatalogModel{{ID: mark, Label: mark}}, Default: model.ModelChoice{Model: mark}}})
	}
	out := make([][3][]string, len(pages))
	for i, p := range pages {
		for seen := 0; seen < 3; {
			raw := p.NextRaw()
			typ := typeOf(raw)
			switch {
			case strings.Contains(raw, mark):
				seen++
			case typ == "agents", typ == "server_lists", typ == "server_state", typ == "servers", typ == "library":
			default:
				at := tw.of(raw)
				out[i][at] = append(out[i][at], raw)
			}
		}
	}
	return out
}

func TestBothSameIDHereAndInTwoSections(t *testing.T) {
	t.Parallel()
	tw := newTwin(t)
	p, q, r := tw.a.page("P"), tw.a.page("Q"), tw.a.page("R")
	pages := []*bridgetest.Page{p, q, r} // P follows the local chat, Q the first entry's, R the second's
	const id, loose = chat1, chat2
	want := func(what string, status int, method, path string, body any) string {
		t.Helper()
		got, out := p.Do(method, path, body)
		if got != status {
			t.Fatalf("%s: %s %s: %d %s, want %d", what, method, path, got, out, status)
		}
		return string(out)
	}

	// ---- the make: a chat with the same id on each server, in the group that has the same id
	// on each, and one more in "__ungrouped__", which every server has.
	for i, at := range tw.place {
		v := decode[model.ChatView](t, want("the make on "+tw.name[i], 200, "POST", at+"/chats", obj{"id": id, "agent": "claude", "group": sameGroup}))
		if v.ID != id || v.Group != sameGroup || v.Locked {
			t.Fatalf("the chat made on %s: %+v", tw.name[i], v)
		}
		v = decode[model.ChatView](t, want("the make in no group on "+tw.name[i], 200, "POST", at+"/chats", obj{"id": loose, "agent": "claude", "group": model.Ungrouped}))
		if v.ID != loose || v.Group != model.Ungrouped {
			t.Fatalf("the chat made in no group on %s: %+v", tw.name[i], v)
		}
	}
	// Each server has its own two, and a second make of the id is refused by the one that has it.
	for i, e := range []*env{tw.a, tw.b[0], tw.b[1]} {
		if n := len(e.a.Chats.Views()); n != 2 {
			t.Fatalf("%s has %d chats, want its own two", tw.name[i], n)
		}
		if status, out := p.Do("POST", tw.place[i]+"/chats", obj{"id": id, "agent": "claude", "group": sameGroup}); status < 400 {
			t.Errorf("a second chat with the id on %s: %d %s", tw.name[i], status, out)
		}
	}
	tw.reach(pages...)

	// ---- the lists: each chat once in its own, in its own group of that id.
	lists := func(what string) [3][]model.ChatView {
		t.Helper()
		snap := decode[pageSnapshot](t, string(do(t, p, "GET", "/api/state", nil)))
		if len(snap.Sections) != 2 || snap.Sections[tw.entry[0]] == nil || snap.Sections[tw.entry[1]] == nil {
			t.Fatalf("%s: the sections of the state: %v", what, snap.Sections)
		}
		for i, groups := range [][]model.Group{snap.Groups, snap.Sections[tw.entry[0]].Groups, snap.Sections[tw.entry[1]].Groups} {
			if len(groups) > 1 || len(groups) == 1 && groups[0].ID != sameGroup {
				t.Errorf("%s: the groups of %s: %+v", what, tw.name[i], groups)
			}
		}
		return [3][]model.ChatView{snap.Chats, snap.Sections[tw.entry[0]].Chats, snap.Sections[tw.entry[1]].Chats}
	}
	for i, chats := range lists("after the makes") {
		if len(chats) != 2 {
			t.Fatalf("the chats of %s after the makes: %+v", tw.name[i], chats)
		}
	}

	// ---- the group of that id, and the chat of that id: a change of one is a change of that
	// server's, told with that server, and no other's.
	for i, at := range tw.place {
		want("the rename of the group on "+tw.name[i], 200, "PATCH", at+"/groups/"+sameGroup, obj{"name": "Renamed on " + tw.name[i]})
		want("the rename of the chat on "+tw.name[i], 200, "PATCH", at+"/chats/"+id, obj{"name": "Chat of " + tw.name[i]})
		want("the draft on "+tw.name[i], 200, "PUT", at+"/chats/"+id+"/draft?rev=0&branch=main", obj{"text": "typed on " + tw.name[i]})
	}
	for n, got := range tw.reach(pages...) {
		for i, evs := range got {
			// Every event of a server names that server's things only.
			for j := range tw.place {
				if j == i {
					continue
				}
				for _, raw := range evs {
					if strings.Contains(raw, "Renamed on "+tw.name[j]) || strings.Contains(raw, "Chat of "+tw.name[j]) || strings.Contains(raw, "typed on "+tw.name[j]) {
						t.Errorf("the page %s got, as an event of %s, what is of %s: %s", pages[n].ID, tw.name[i], tw.name[j], raw)
					}
				}
			}
			// The whole group list, the chat and the state of its first branch, "main", which
			// every chat of every server has.
			if count(evs, "groups", `"id":"`+sameGroup+`","name":"Renamed on `+tw.name[i]+`"`) != 1 ||
				count(evs, "chat", id, `"name":"Chat of `+tw.name[i]+`"`, `"draft":{"text":"typed on `+tw.name[i]+`"}`, `"draftRev":1`) != 1 ||
				count(evs, "branch_state", id, `"branch":"main"`, `"draft":{"text":"typed on `+tw.name[i]+`"}`) != 1 {
				t.Errorf("the page %s got of %s: %v", pages[n].ID, tw.name[i], evs)
			}
		}
	}
	for i, chats := range lists("after the changes") {
		for _, v := range chats {
			if v.ID == id && (v.Name != "Chat of "+tw.name[i] || v.Draft == nil || v.Draft.Text != "typed on "+tw.name[i] || v.DraftRev != 1 || v.Group != sameGroup) {
				t.Errorf("the chat of %s after the changes: %+v", tw.name[i], v)
			}
			if v.ID == loose && (v.Name != "" || v.Draft != nil || v.Group != model.Ungrouped) {
				t.Errorf("the chat in no group of %s after the changes: %+v", tw.name[i], v)
			}
		}
	}

	// ---- the follows and the messages: each page follows one of the three, each chat gets its
	// own message, and each page gets the thread of the one it follows, and of no other.
	for i, at := range tw.place {
		do(t, pages[i], "GET", at+"/chats/"+id+"/items", nil)
		if out := want("the message on "+tw.name[i], 200, "POST", at+"/chats/"+id+"/messages?branch=main", obj{"text": "hello, " + tw.name[i]}); out != `{"branch":"main","ok":true}`+"\n" && out != `{"branch":"main","ok":true}` {
			t.Errorf("the message on %s: %s", tw.name[i], out)
		}
	}
	for i := range tw.place {
		if ag := tw.sp[i].of(t, id); ag.sends.Load() != 1 || tw.sp[i].count() != 1 {
			t.Errorf("the agents of %s: %d started, %d messages to the chat's", tw.name[i], tw.sp[i].count(), ag.sends.Load())
		}
		reply(t, &tw.sp[i].of(t, id).fakeAgent, "the answer of "+tw.name[i], "point-1")
	}
	threads := func(what string, follows [3]bool) {
		t.Helper()
		for n, got := range tw.reach(pages...) {
			for i, evs := range got {
				content := only(evs, "chat_items", "tree")
				if (len(content) > 0) != (n == i && follows[n]) {
					t.Errorf("%s: the page %s, which follows the chat of %s: %v, got of %s: %v", what, pages[n].ID, tw.name[n], follows[n], tw.name[i], types(content))
				}
				for _, raw := range content {
					if !strings.Contains(raw, id) || strings.Contains(raw, "hello, ") && !strings.Contains(raw, "hello, "+tw.name[i]) ||
						strings.Contains(raw, "the answer of ") && !strings.Contains(raw, "the answer of "+tw.name[i]) {
						t.Errorf("%s: an event of %s is not that server's thread: %s", what, tw.name[i], raw)
					}
				}
			}
		}
	}
	threads("after the messages", [3]bool{true, true, true})
	for i, at := range tw.place {
		thread := want("the thread on "+tw.name[i], 200, "GET", at+"/chats/"+id+"/items", nil)
		for j := range tw.place {
			if strings.Contains(thread, "hello, "+tw.name[j]) != (i == j) || strings.Contains(thread, "the answer of "+tw.name[j]) != (i == j) {
				t.Errorf("the thread on %s holds the message of %s: %v\n%s", tw.name[i], tw.name[j], i != j, thread)
			}
		}
	}
	// The follows are three, each keyed by its server.
	b := tw.a.s.Bridge
	for i, it := range []editorbridge.Item{editorbridge.Chat(id), editorbridge.ChatOn(tw.entry[0], id), editorbridge.ChatOn(tw.entry[1], id)} {
		// P read every thread just now, so it follows all three; Q and R each follow their own.
		if got := b.Followers(it); len(got) != []int{1, 2, 2}[i] {
			t.Errorf("the followers of the chat of %s: %v", tw.name[i], got)
		}
	}
	// An unfollow of the one is no unfollow of another, whoever it is: P lets go of all three,
	// and each of the others of a chat it does not follow.
	for _, at := range tw.place {
		do(t, p, "POST", at+"/chats/"+id+"/unfollow", nil)
	}
	do(t, q, "POST", tw.place[0]+"/chats/"+id+"/unfollow", nil)
	do(t, q, "POST", tw.place[2]+"/chats/"+id+"/unfollow", nil)
	do(t, r, "POST", tw.place[1]+"/chats/"+id+"/unfollow", nil)
	say := func(text string) {
		t.Helper()
		for i := range tw.place {
			emit(t, &tw.sp[i].of(t, id).fakeAgent)
			want("a message on "+tw.name[i], 200, "POST", tw.place[i]+"/chats/"+id+"/messages", obj{"text": "hello, " + tw.name[i] + ", " + text})
			reply(t, &tw.sp[i].of(t, id).fakeAgent, "the answer of "+tw.name[i]+", "+text, "point-2")
		}
	}
	say("again")
	threads("after the unfollows of chats a page does not follow", [3]bool{false, true, true})
	do(t, q, "POST", tw.place[1]+"/chats/"+id+"/unfollow", nil)
	say("once more")
	threads("after the unfollow of the first entry's chat", [3]bool{false, false, true})

	// ---- the images: an image is in the chat of the server it was uploaded to, under the id
	// of its bytes, and in no other chat of that id.
	data := png("the same bytes")
	status, out := tw.a.uploadAt("P", tw.place[1]+"/chats/"+id, "a.png", "image/png", bytes.NewReader(data))
	if status != 200 || decode[model.Image](t, out).ID != imageIDOf(data) {
		t.Fatalf("the upload to the chat of %s: %d %s", tw.name[1], status, out)
	}
	for i, at := range tw.place {
		resp, err := http.Get(tw.a.url + at + "/chats/" + id + "/images/" + imageIDOf(data))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if wantStatus := map[bool]int{true: 200, false: 404}[i == 1]; resp.StatusCode != wantStatus {
			t.Errorf("the image of the chat of %s, fetched from %s: %d, want %d", tw.name[1], tw.name[i], resp.StatusCode, wantStatus)
		}
	}
	// A message with the image is taken by the chat that has it, and refused by the others.
	for i, at := range tw.place {
		emit(t, &tw.sp[i].of(t, id).fakeAgent)
		status, out := p.Do("POST", at+"/chats/"+id+"/messages", obj{"text": "look", "images": []obj{{"id": imageIDOf(data), "name": "a.png", "type": "image/png", "size": len(data)}}})
		if (status == 200) != (i == 1) {
			t.Errorf("a message with the image of the chat of %s, sent on %s: %d %s", tw.name[1], tw.name[i], status, out)
		}
	}
	reply(t, &tw.sp[1].of(t, id).fakeAgent, "seen", "point-3")
	tw.reach(pages...)

	// ---- the delete: of the first entry's chat, then of the local one, then of the second
	// entry's group with what is in it. Each leaves the others.
	gone := func(what string, chatGone, groupGone [3]bool) {
		t.Helper()
		for i, at := range tw.place {
			status, out := p.Do("GET", at+"/chats/"+id, nil)
			if chatGone[i] && (status != 404 || decode[refusal](t, string(out)).Code != "not_found") || !chatGone[i] && status != 200 {
				t.Errorf("%s: the chat of %s: %d %s; gone: %v", what, tw.name[i], status, out, chatGone[i])
			}
			status, out = p.Do("PATCH", at+"/groups/"+sameGroup, obj{"name": "Renamed on " + tw.name[i]})
			if groupGone[i] && (status != 404 || decode[refusal](t, string(out)).Code != "not_found") || !groupGone[i] && status != 200 {
				t.Errorf("%s: the group of %s: %d %s; gone: %v", what, tw.name[i], status, out, groupGone[i])
			}
		}
		tw.reach(pages...)
	}
	want("the delete of the first entry's chat", 200, "DELETE", tw.place[1]+"/chats/"+id, nil)
	for n, got := range tw.reach(pages...) {
		if count(got[1], "chat_removed", `"id":"`+id+`"`) != 1 || count(got[0], "chat_removed")+count(got[2], "chat_removed") != 0 {
			t.Errorf("the delete of the first entry's chat told the page %s: %v", pages[n].ID, got)
		}
	}
	gone("after the delete of the first entry's chat", [3]bool{false, true, false}, [3]bool{})
	want("the delete of the local chat", 200, "DELETE", tw.place[0]+"/chats/"+id, nil)
	gone("after the delete of the local chat", [3]bool{true, true, false}, [3]bool{})
	want("the delete of the second entry's group", 200, "DELETE", tw.place[2]+"/groups/"+sameGroup+"?contents=delete", nil)
	gone("after the delete of the second entry's group", [3]bool{true, true, true}, [3]bool{false, false, true})
	// What is left: on each server the chat in no group, and the group but on the second entry.
	for i, chats := range lists("after the deletes") {
		if len(chats) != 1 || chats[0].ID != loose {
			t.Errorf("the chats of %s after the deletes: %+v", tw.name[i], chats)
		}
	}
	for i, e := range []*env{tw.a, tw.b[0], tw.b[1]} {
		if n := len(e.a.Chats.Views()); n != 1 {
			t.Errorf("%s has %d chats after the deletes, want the one in no group", tw.name[i], n)
		}
	}
}

// sameBoard is the id of a board that each of the three servers has. A server makes such an id
// itself, so no call gives two servers the same one: each data folder holds the board from
// before the server reads it, as the folders of two machines can.
const sameBoard = "b_samesame"

// withSameThings gives a server the board every server of the twin has, in the group every one
// has, under this name.
func withSameThings(t *testing.T) func(name string) func(*Server) {
	return func(name string) func(*Server) {
		return func(s *Server) {
			path := filepath.Join(s.App.St.P.BoardDir(sameBoard), "board.json")
			board := model.Board{ID: sameBoard, Name: "Board of " + name, Group: sameGroup, Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC)}
			if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := store.WriteJSONAtomic(path, board, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := s.App.Boards.Load(); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// The same for a board: one board with the same id on this server and in two sections. Each is
// listed once, in its own tree; a page holds and draws on each board at the same time, and reads
// back its own drawing; a change of one is told with its server and changes no other; and a
// delete of one leaves the other two.
func TestBothSameBoardHereAndInTwoSections(t *testing.T) {
	t.Parallel()
	tw := newTwin(t, withSameThings(t))
	p, q, r := tw.a.page("P"), tw.a.page("Q"), tw.a.page("R")
	pages := []*bridgetest.Page{p, q, r} // P draws on the local board, Q on the first entry's, R on the second's
	holds := []string{sameBoard, editorbridge.BoardOn(tw.entry[0], sameBoard), editorbridge.BoardOn(tw.entry[1], sameBoard)}
	want := func(what string, c *bridgetest.Page, status int, method, path string, body any) string {
		t.Helper()
		got, out := c.Do(method, path, body)
		if got != status {
			t.Fatalf("%s: %s %s by %s: %d %s, want %d", what, method, path, c.ID, got, out, status)
		}
		return string(out)
	}

	// ---- the lists: each board once, in its own tree, under its own name.
	listed := func(what string) [3][]model.Board {
		t.Helper()
		snap := decode[pageSnapshot](t, string(do(t, p, "GET", "/api/state", nil)))
		if len(snap.Sections) != 2 || snap.Sections[tw.entry[0]] == nil || snap.Sections[tw.entry[1]] == nil {
			t.Fatalf("%s: the sections of the state: %v", what, snap.Sections)
		}
		one, two := snap.Sections[tw.entry[0]], snap.Sections[tw.entry[1]]
		return [3][]model.Board{snap.Boards, one.Boards, two.Boards}
	}
	named := func(what string, board [3]string) {
		t.Helper()
		for i, l := range listed(what) {
			if len(l) != 1 || l[0].ID != sameBoard || l[0].Name != board[i] || l[0].Group != sameGroup {
				t.Errorf("%s: the boards of %s: %+v, want the one named %q", what, tw.name[i], l, board[i])
			}
		}
	}
	var boards [3]string
	for i, name := range tw.name {
		boards[i] = "Board of " + name
	}
	named("at the start", boards)
	tw.reach(pages...)

	// ---- a change of one is that server's, told with that server, and no other's.
	for i, at := range tw.place {
		// A board's name is one word: the server joins the words of another.
		want("the rename of the board on "+tw.name[i], p, 200, "POST", at+"/boards/"+sameBoard+"/rename", obj{"name": "drawn-on-" + strconv.Itoa(i)})
		boards[i] = "drawn-on-" + strconv.Itoa(i)
	}
	for n, got := range tw.reach(pages...) {
		for i, evs := range got {
			for j := range tw.place {
				for _, raw := range evs {
					if j != i && strings.Contains(raw, boards[j]) {
						t.Errorf("the page %s got, as an event of %s, what is of %s: %s", pages[n].ID, tw.name[i], tw.name[j], raw)
					}
				}
			}
			if count(evs, "board", sameBoard, `"name":"`+boards[i]+`"`) != 1 {
				t.Errorf("the page %s got of %s: %v", pages[n].ID, tw.name[i], evs)
			}
		}
	}
	named("after the changes", boards)

	// ---- the holds: three pages hold the three boards at the same time, each draws on its
	// own, and no page is the holder of another's.
	for i, at := range tw.place {
		got := decode[struct {
			State string
			Rev   int64
		}](t, want("the take on "+tw.name[i], pages[i], 200, "POST", at+"/boards/"+sameBoard+"/take", obj{"ifFree": true}))
		if got.State != "held" || got.Rev != 0 {
			t.Fatalf("the take of the board of %s by %s: %+v", tw.name[i], pages[i].ID, got)
		}
	}
	holders := func(what string, wantHolders [3]string) {
		t.Helper()
		for i, key := range holds {
			if got, _ := tw.a.s.Bridge.HolderOf(key); got != wantHolders[i] {
				t.Errorf("%s: the board of %s is held here by %q, want %q", what, tw.name[i], got, wantHolders[i])
			}
		}
	}
	holders("after the takes", [3]string{"P", "Q", "R"})
	scene := func(at string, rev int64) string {
		return at + "/boards/" + sameBoard + "/scene?rev=" + strconv.FormatInt(rev, 10)
	}
	for i, at := range tw.place {
		want("the save on "+tw.name[i], pages[i], 200, "PUT", scene(at, 0), drawing("element-of-"+strconv.Itoa(i)))
		// The holder of another server's board is no holder of this one.
		other := pages[(i+1)%3]
		if out := want("a save on "+tw.name[i]+" by the holder of another board", other, 409, "PUT", scene(at, 1), drawing("not-mine")); decode[refusal](t, out).Code != "not_holder" {
			t.Errorf("a save on %s by %s: %s", tw.name[i], other.ID, out)
		}
	}
	for i, at := range tw.place {
		got := want("the drawing of "+tw.name[i], p, 200, "GET", at+"/boards/"+sameBoard+"/scene", nil)
		for j := range tw.place {
			if strings.Contains(got, "element-of-"+strconv.Itoa(j)) != (i == j) {
				t.Errorf("the drawing of %s holds what was drawn on %s: %v\n%s", tw.name[i], tw.name[j], i != j, got)
			}
		}
		if strings.Contains(got, "not-mine") {
			t.Errorf("the drawing of %s holds a save that was refused: %s", tw.name[i], got)
		}
	}
	for i, e := range []*env{tw.a, tw.b[0], tw.b[1]} {
		if raw, rev, err := e.a.Boards.SceneAt(sameBoard); err != nil || rev != 1 || !strings.Contains(string(raw), "element-of-"+strconv.Itoa(i)) {
			t.Errorf("%s stores the drawing %s at revision %d: %v", tw.name[i], raw, rev, err)
		}
	}
	// A release of one leaves the other two.
	if out := want("Q's release of the first entry's board", q, 200, "POST", tw.place[1]+"/boards/"+sameBoard+"/release", nil); !strings.Contains(out, `"free"`) {
		t.Errorf("Q's release of the first entry's board: %s", out)
	}
	if out := want("Q's release of the local board, which P holds", q, 200, "POST", tw.place[0]+"/boards/"+sameBoard+"/release", nil); !strings.Contains(out, `"none"`) {
		t.Errorf("Q's release of the local board: %s", out)
	}
	holders("after Q let the first entry's board go", [3]string{"P", "", "R"})
	tw.reach(pages...)

	// ---- the delete: of the first entry's board. It is told with its server, and leaves the
	// others, which are still held and still listed.
	want("the delete of the first entry's board", p, 200, "DELETE", tw.place[1]+"/boards/"+sameBoard, nil)
	for n, got := range tw.reach(pages...) {
		if count(got[1], "board_removed", `"id":"`+sameBoard+`"`) != 1 || count(got[0], "board_removed")+count(got[2], "board_removed") != 0 {
			t.Errorf("the delete told the page %s: %v", pages[n].ID, got)
		}
	}
	for i, l := range listed("after the delete") {
		if len(l) != map[bool]int{true: 0, false: 1}[i == 1] {
			t.Errorf("after the delete %s has the boards %+v", tw.name[i], l)
		}
	}
	for i, at := range tw.place {
		status, out := p.Do("GET", at+"/boards/"+sameBoard+"/scene", nil)
		if i == 1 && (status != 404 || decode[refusal](t, string(out)).Code != "not_found") || i != 1 && status != 200 {
			t.Errorf("the drawing of %s after the delete of the first entry's board: %d %s", tw.name[i], status, out)
		}
	}
	holders("after the delete", [3]string{"P", "", "R"})
	want("a save on the local board after the delete", p, 200, "PUT", scene(tw.place[0], 1), drawing("element-of-0-again"))
	want("a save on the second entry's board after the delete", r, 200, "PUT", scene(tw.place[2], 1), drawing("element-of-2-again"))
}

// Nothing moves between servers (goal 3.5 and 7; contract 3.10): a move names one server, in
// its path, and the group it names is looked up on that server alone. So a chat, a board and a
// group of one server that are moved into a group only another server has, from this
// server's part into a section, from a section into this server's part and from one section
// into another, are refused by the server that was asked, and no tree changes.
func TestBothNothingMovesBetweenServers(t *testing.T) {
	t.Parallel()
	tw := newTwin(t, withSameThings(t))
	p := tw.a.page("P")
	// On each server a chat, beside its board, and a group no other server has.
	var own [3]string
	const chat = chat1
	for i, at := range tw.place {
		do(t, p, "POST", at+"/chats", obj{"id": chat, "agent": "claude", "group": sameGroup})
		own[i] = decode[model.Group](t, string(do(t, p, "POST", at+"/groups", obj{"name": "Only on " + tw.name[i], "parent": ""}))).ID
	}
	for i := range own {
		if own[i] == own[(i+1)%3] {
			t.Fatalf("two servers made a group with the id %s", own[i])
		}
	}
	trees := func() [3]string {
		t.Helper()
		type lists struct{ Groups, Boards, Chats json.RawMessage }
		snap := decode[struct {
			lists
			Sections map[string]lists
		}](t, string(do(t, p, "GET", "/api/state", nil)))
		out := [3]string{string(snap.Groups) + string(snap.Boards) + string(snap.Chats)}
		for i, entry := range tw.entry {
			sec := snap.Sections[entry]
			out[i+1] = string(sec.Groups) + string(sec.Boards) + string(sec.Chats)
		}
		return out
	}
	tw.reach(p)
	before := trees()
	for i, tree := range before {
		for _, has := range []string{chat, sameBoard, own[i], sameGroup} {
			if !strings.Contains(tree, has) {
				t.Fatalf("the tree of %s lacks %s: %s", tw.name[i], has, tree)
			}
		}
	}

	for from, at := range tw.place {
		for to := range tw.place {
			if to == from {
				continue
			}
			what := "from " + tw.name[from] + " into the group of " + tw.name[to]
			for _, c := range []struct {
				kind, method, path string
				body               obj
			}{
				{"chat", "PATCH", "/chats/" + chat, obj{"group": own[to]}},
				{"board", "PATCH", "/boards/" + sameBoard, obj{"group": own[to]}},
				{"group", "POST", "/groups/" + own[from] + "/move", obj{"parent": own[to], "before": ""}},
				{"new chat", "POST", "/chats", obj{"agent": "claude", "group": own[to]}},
				{"new board", "POST", "/boards", obj{"name": "moved", "group": own[to]}},
				{"new group", "POST", "/groups", obj{"name": "moved", "parent": own[to]}},
			} {
				if status, out := p.Do(c.method, at+c.path, c.body); status < 400 || status >= 500 {
					t.Errorf("a %s %s: %s %s: %d %s, want a refusal", c.kind, what, c.method, at+c.path, status, out)
				}
			}
		}
	}
	// No tree changed, and no page was told of a change of one.
	for i, evs := range tw.reach(p)[0] {
		if got := only(evs, "chat", "board", "groups", "chat_removed", "board_removed"); len(got) != 0 {
			t.Errorf("the refused moves told a change of %s: %v", tw.name[i], got)
		}
	}
	if after := trees(); after != before {
		for i := range after {
			if after[i] != before[i] {
				t.Errorf("the tree of %s after the refused moves:\n%s\nwant\n%s", tw.name[i], after[i], before[i])
			}
		}
	}
	// A move inside one server is taken by each, so the refusals were for the group alone.
	for i, at := range tw.place {
		do(t, p, "PATCH", at+"/chats/"+chat, obj{"group": own[i]})
		do(t, p, "PATCH", at+"/boards/"+sameBoard, obj{"group": own[i]})
	}
	for i, e := range []*env{tw.a, tw.b[0], tw.b[1]} {
		v, err := e.a.Chats.View(chat)
		bd, _ := e.a.Boards.Get(sameBoard)
		if err != nil || v.Group != own[i] || bd.Group != own[i] {
			t.Errorf("after the moves inside %s its chat and board are in %q and %q, want %q: %v", tw.name[i], v.Group, bd.Group, own[i], err)
		}
	}
}
