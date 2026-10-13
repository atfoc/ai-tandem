package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// The real server process on a data folder as an app of before left it, with a saved entry for
// a stand-in server. The start leaves the folder as the change-over does; the page's snapshot
// over HTTP has the stand-in's tree under the entry's id in "sections", and this computer's own
// lists hold nothing of it; a call under /api/on/{server}/ reaches the stand-in, and every
// request the server sends there states its level, 5; and after the server was stopped, as a
// quit stops it, the data folder holds no file of anything of the stand-in.
func TestSectionServerProcess(t *testing.T) {
	serverTest(t, "TestSectionChangeOverAtTheStart, TestSectionInEachState, TestSectionNothingOfAnotherServerIsWritten (this package)")
	const entry = savedEntryID
	st := standin.Start(t, standin.Options{Snapshot: farTree()})
	said := func(v any) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(v)
		}
	}
	st.Handle("GET /api/chats/{id}", said(farView(farChat, "Read there")))
	st.Handle("PUT /api/chats/{id}/draft", said(map[string]any{"ok": true, "rev": 2}))

	in := newInstance(t)
	list := oldFolder(t, in.dir, t.TempDir(), st)
	srv := &imageServer{in: in}
	srv.start(t)
	// The server answers: the change-over is over, since it comes before the first request.
	changedOver(t, in.dir, list)

	base := strings.TrimSuffix(in.url, "/")
	id, _ := in.helloMap(t)["instanceId"].(string)
	page := watch(t, http.DefaultClient, base, "page", nil)
	var snapshot string
	eventually(t, 30*time.Second, "the page's snapshot has the entry's tree", func() bool {
		got := pageCall(t, base, "page", "GET", "/api/state", nil)
		snapshot = got.Raw
		var snap struct{ Sections map[string]json.RawMessage }
		return got.Status == http.StatusOK && json.Unmarshal([]byte(got.Raw), &snap) == nil && snap.Sections[entry] != nil
	})
	changedOverSnapshot(t, snapshot, "") // this server finds no agent's program: a new chat has none

	// A read and a write for things of the section reach the stand-in.
	on := "/api/on/" + entry + "/chats/"
	if got := pageCall(t, base, "page", "GET", on+farChat, nil); got.Status != http.StatusOK || !strings.Contains(got.Raw, "Read there") {
		t.Fatalf("a read of a chat of the section: %s", got)
	}
	if got := pageCall(t, base, "page", "PUT", on+farDrafted+"/draft?rev=1", map[string]any{"text": "typed here into a chat there"}); got.Status != http.StatusOK {
		t.Fatalf("a draft save in a chat of the section: %s", got)
	}
	var sent []string
	for _, r := range st.Requests() {
		if r.Level != strconv.Itoa(servers.ClientLevel) || r.Level != "5" || r.Client != id || id == "" {
			t.Fatalf("the stand-in was sent %+v, want the level 5 and the client %s", r, id)
		}
		sent = append(sent, r.Method+" "+r.Path)
	}
	for _, want := range []string{"GET " + servers.HelloPath, "GET /api/events", "GET /api/chats/" + farChat, "PUT /api/chats/" + farDrafted + "/draft"} {
		if !slices.Contains(sent, want) {
			t.Fatalf("the stand-in was not sent %s; it was sent %v", want, sent)
		}
	}

	// The server is stopped as a quit stops it, and has exited when the folder is read.
	page.close()
	srv.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-srv.exited:
	case <-time.After(30 * time.Second):
		srv.kill(t)
		t.Fatalf("the server did not exit within 30 s of SIGTERM:\n%s", srv.out.String())
	}
	// What it wrote is read now that it has exited: it told of each step of the change-over.
	if log := srv.out.String(); !strings.Contains(log, "are removed from "+in.dir) || !strings.Contains(log, "the chat "+oldChat) ||
		!strings.Contains(log, "the chat "+oldBoardChat) {
		t.Errorf("the server's log does not tell of the change-over:\n%s", log)
	}
	changedOver(t, in.dir, list)
	files := folderFiles(t, in.dir)
	if held := holders(files, append(farMarks(), "Read there", "typed here into a chat there")); len(held) != 0 {
		t.Errorf("files that hold something of the stand-in after the stop: %v", held)
	}
	// Of chats and boards the folder has the one thing that became this computer's.
	var things []string
	for rel := range files {
		if top, _, _ := strings.Cut(filepath.ToSlash(rel), "/"); top == "chats" || top == "boards" || top == "remote" {
			things = append(things, filepath.ToSlash(rel))
		}
	}
	slices.Sort(things)
	if want := []string{"chats/" + oldChat + "/chat.json"}; !slices.Equal(things, want) {
		t.Errorf("the files of chats and boards after the stop: %v, want %v", things, want)
	}
	if _, err := os.Lstat(filepath.Join(in.dir, "remote")); !os.IsNotExist(err) {
		t.Errorf("the folder remote/ after the stop: %v", err)
	}
}
