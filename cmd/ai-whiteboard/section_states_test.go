package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// shownEntry is what a page reads of one entry in its snapshot: the entry's view, and its tree
// when "sections" has a key for it.
type shownEntry struct {
	listed bool // the entry is in "servers"
	view   servers.View
	tree   *remotes.Tree
	parts  map[string]json.RawMessage // the snapshot, by its fields
}

// shown reads the page's snapshot over the routes and takes the entry's part of it.
func (pr *program) shown(t *testing.T, entry string) shownEntry {
	t.Helper()
	got := pr.call(t, "", "GET", "/api/state", nil)
	var snap struct {
		Servers  []servers.View
		Sections map[string]*remotes.Tree
	}
	var out shownEntry
	if got.Status != http.StatusOK || json.Unmarshal([]byte(got.Raw), &snap) != nil || json.Unmarshal([]byte(got.Raw), &out.parts) != nil {
		t.Fatalf("the snapshot: %s", got)
	}
	if snap.Sections == nil {
		t.Fatalf("the snapshot's sections are null: %s", got.Raw)
	}
	for _, v := range snap.Servers {
		if v.ID == entry {
			out.listed, out.view = true, v
		}
	}
	out.tree = snap.Sections[entry]
	return out
}

// A section in each state, through the program as startServers wires it. While the entry
// connects, and after its server dropped, a page is handed no tree of it and a call for a thing
// of it is refused with the entry's name. Connected, the page is sent the server's whole tree,
// which for a server with nothing on it is a tree of empty lists; this computer's own lists hold
// nothing of it. With the entry removed, the tree is gone, its lists are gone, a call finds no
// server, and that server is told nothing. (A server that is too old:
// TestStartServersTooOldEntryConnectsAfterTheUpdate.)
func TestSectionInEachState(t *testing.T) {
	t.Parallel()
	const entry = savedEntryID
	st := standin.Start(t, standin.Options{}) // a server with nothing on it
	// Its hello waits until the test lets it answer: until then the entry connects.
	answer := make(chan struct{})
	st.SetHello(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-answer:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"app": "ai-whiteboard", "version": standin.DefaultVersion, "webVersion": standin.DefaultVersion,
			"instanceId": standin.DefaultInstanceID, "featureLevel": servers.MinFeatureLevel})
	})
	st.Handle("GET /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(farView(r.PathValue("id"), "Read there"))
	})
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, servers.FileName), []byte(savedEntry(st)), 0o600); err != nil {
		t.Fatal(err)
	}
	w, err := parseTestWaits("backoff=200ms") // the tries after a drop come within 200 ms
	if err != nil {
		t.Fatal(err)
	}
	pr := wiredWaits(t, root, w)
	page := pr.page(t, "page")
	read := "/api/on/" + entry + "/chats/" + farChat
	// refused checks that a read and a write for a thing of the entry are refused with the
	// sentence, and that the page is handed no tree.
	refused := func(when string, state servers.State, status int, code, sentence string) {
		t.Helper()
		for _, c := range []struct {
			method, path string
			body         any
		}{{"GET", read, nil}, {"POST", "/api/on/" + entry + "/chats", map[string]any{"group": model.Ungrouped}}} {
			if got := pr.call(t, "page", c.method, c.path, c.body); got.Status != status || got.Code != code || got.Error != sentence {
				t.Fatalf("%s: %s %s: %s, want %d %s %q", when, c.method, c.path, got, status, code, sentence)
			}
		}
		if s := pr.shown(t, entry); s.tree != nil || string(s.parts["sections"]) != "{}" || (s.listed && s.view.State != state) {
			t.Fatalf("%s: the entry is %q and the sections are %s, want %q and no tree", when, s.view.State, s.parts["sections"], state)
		}
	}
	// tree waits for the section event of the entry that carries a tree, after the mark.
	tree := func(mark int, what string) seenEvent {
		t.Helper()
		return page.await(t, mark, 10*time.Second, "section event with "+what, func(e seenEvent) bool { return e.holds("section", entry, `"tree":{`) })
	}
	// none waits for the section event of the entry with null, after the mark.
	none := func(mark int) {
		t.Helper()
		page.await(t, mark, 10*time.Second, "section event with null", func(e seenEvent) bool { return e.holds("section", entry, `"tree":null`) })
	}

	// Connecting: the hello is on its way.
	until(t, "the entry's hello reached its server", func() bool { return len(st.Requests()) > 0 })
	refused("while the entry connects", servers.StateConnecting, http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")
	if evs := page.of(0, "section"); len(evs) != 0 {
		t.Fatalf("the page was sent a section event while the entry connects: %v", evs)
	}

	// Connected, to a server with nothing on it: a tree, and no list of it is null.
	close(answer)
	empty := tree(0, "the tree of the server with nothing on it")
	for _, list := range []string{`"groups":[]`, `"boards":[]`, `"chats":[]`, `"states":[]`, `"defaults":{`} {
		if !strings.Contains(empty.Raw, list) {
			t.Fatalf("the tree of a server with nothing on it lacks %s: %s", list, empty.Raw)
		}
	}
	until(t, "the entry is connected", func() bool { return pr.shown(t, entry).view.State == servers.StateConnected })
	if s := pr.shown(t, entry); s.tree == nil || s.tree.Groups == nil || s.tree.Boards == nil || s.tree.Chats == nil || s.tree.States == nil ||
		len(s.tree.Groups)+len(s.tree.Boards)+len(s.tree.Chats)+len(s.tree.States) != 0 {
		t.Fatalf("the section of a server with nothing on it: %s", s.parts["sections"])
	}
	if got := pr.call(t, "page", "GET", read, nil); got.Status != http.StatusOK || !strings.Contains(got.Raw, "Read there") {
		t.Fatalf("a call for a thing of the connected entry: %s", got)
	}

	// Not connected: the server is gone. It has a tree when it is back.
	mark := page.mark()
	st.SetSnapshot(farTree())
	st.Stop()
	none(mark)
	until(t, "the entry is unreachable", func() bool { return pr.shown(t, entry).view.State == servers.StateUnreachable })
	refused("after the drop", servers.StateUnreachable, http.StatusServiceUnavailable, "server_unreachable", "Studio is not connected.")

	// Connected again: the tree as that server has it now, and nothing of it in this computer's lists.
	mark = page.mark()
	st.Restart()
	back := tree(mark, "the tree of the server that is back")
	if !strings.Contains(back.Raw, farChat) || !strings.Contains(back.Raw, farDraft) || strings.Contains(back.Raw, "collapsed") {
		t.Fatalf("the tree of the server that is back: %s", back.Raw)
	}
	until(t, "the entry is connected again", func() bool { return pr.shown(t, entry).view.State == servers.StateConnected })
	s := pr.shown(t, entry)
	if s.tree == nil || len(s.tree.Groups) != 1 || s.tree.Groups[0].Name != farGroupName || len(s.tree.Boards) != 1 || s.tree.Boards[0].ID != farBoard ||
		len(s.tree.Chats) != 2 || s.tree.Chats[1].Draft == nil || s.tree.Chats[1].Draft.Text != farDraft || len(s.tree.States) != 2 || len(s.tree.Defaults.Groups) != 1 {
		t.Fatalf("the section of the server that is back: %s", s.parts["sections"])
	}
	for _, list := range []string{"groups", "boards", "chats", "states", "defaults"} {
		for _, mark := range farMarks() {
			if bytes.Contains(s.parts[list], []byte(mark)) {
				t.Errorf("this computer's %s hold %s of the entry's server: %s", list, mark, s.parts[list])
			}
		}
	}
	// A page that connects now is handed the tree in its stream's snapshot.
	late := pr.page(t, "late")
	if snap := late.awaitEvent(t, 0, 10*time.Second, "snapshot"); !snap.holds("snapshot", `"sections":{"`+entry+`":{`, farChat) {
		t.Fatalf("the snapshot of a page that connects while the entry is connected: %s", snap.Raw)
	}
	late.close()
	if got := pr.call(t, "page", "GET", read, nil); got.Status != http.StatusOK {
		t.Fatalf("a call for a thing of the entry that is back: %s", got)
	}

	// Removed: no tree, no lists, no server for a call; and that server is told nothing.
	mark, sent := page.mark(), len(st.Requests())
	if got := pr.call(t, "page", "DELETE", "/api/servers/"+entry, nil); got.Status != http.StatusOK {
		t.Fatalf("the removal of the entry: %s", got)
	}
	none(mark)
	page.awaitEvent(t, mark, 10*time.Second, "server_lists", entry, `"lists":null`)
	page.awaitEvent(t, mark, 10*time.Second, "servers")
	if s := pr.shown(t, entry); s.listed {
		t.Fatalf("the removed entry is still listed: %s", s.parts["servers"])
	}
	refused("after the removal", "", http.StatusNotFound, "no_server", "This server is not in the list.")
	if got := st.Requests(); len(got) != sent {
		t.Fatalf("the removed entry's server was sent %+v", got[sent:])
	}
}
