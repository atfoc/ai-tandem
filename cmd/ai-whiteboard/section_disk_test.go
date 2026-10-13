package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// What the program writes into its data folder while it is connected to another server: the
// server list, and nothing else of that server. (The relay alone: TestSectionNothingOnDisk,
// internal/remotes.)

// madeID is an id this server makes for a board or a run: it differs from start to start, so
// two data folders are compared with it left out of their paths.
var madeID = regexp.MustCompile(`\b[br]_[0-9a-z]{8}\b`)

// folderPaths are the paths of the files of a data folder, sorted, with the ids this server
// makes left out: what two folders that went through the same steps have in common.
func folderPaths(files map[string][]byte) []string {
	out := make([]string, 0, len(files))
	for rel := range files {
		out = append(out, madeID.ReplaceAllString(filepath.ToSlash(rel), "*"))
	}
	slices.Sort(out)
	return out
}

// localSteps makes, as the page id of the program, things of this computer: a group, a chat
// with a draft and an image, a board with a drawing, a run with a goal and a prompt of the
// library. Each call must be taken.
func localSteps(t *testing.T, pr *program, id string) {
	t.Helper()
	const chat = "1a000000-0000-4000-8000-00000000000a"
	must := func(method, path string, body any) answer {
		t.Helper()
		got := pr.call(t, id, method, path, body)
		if got.Status != http.StatusOK {
			t.Fatalf("%s %s on this computer: %s", method, path, got)
		}
		return got
	}
	must("POST", "/api/groups", map[string]any{"name": "Here", "parent": ""})
	must("POST", "/api/library/local/prompts", map[string]any{"name": "here", "parent": "", "text": "a prompt of this computer"})
	must("POST", "/api/chats", map[string]any{"id": chat, "group": model.Ungrouped})
	if resp, raw := pr.send(t, id, "POST", "/api/chats/"+chat+"/images?name=here.png", "image/png", testPNG("here")); resp.StatusCode != http.StatusOK {
		t.Fatalf("the upload of an image to a chat of this computer: %d %s", resp.StatusCode, raw)
	}
	must("PUT", "/api/chats/"+chat+"/draft?rev=0", map[string]any{"text": "typed here"})
	var made struct{ ID string }
	json.Unmarshal([]byte(must("POST", "/api/boards", map[string]any{"name": "Here", "group": model.Ungrouped}).Raw), &made)
	must("PUT", "/api/boards/"+made.ID+"/scene?rev=0", json.RawMessage(boardScene("drawn-here")))
	json.Unmarshal([]byte(must("POST", "/api/runs", map[string]any{"group": model.Ungrouped, "name": "Here"}).Raw), &made)
	must("PUT", "/api/runs/"+made.ID+"/draft", map[string]any{"text": "a goal here"})
}

// The data folder of a program that is connected to another server holds what the folder of a
// program with no entry holds after the same local steps, and the server list. The other server
// has groups, what they remember for a new chat, boards, chats with drafts, branch states, runs
// and a prompt library; it tells of a change of each kind and of the content of a chat and a
// run that a page follows; the page saves a draft, sends a message, takes a board and saves its
// drawing, uploads an image and fetches it, makes a group, a chat, a board and a run there,
// types the run's goal, changes what a chat starts with and asks for that server's folders and
// usage; the server drops, with two boards held here, a save of a drawing, of a draft and of an
// image is tried meanwhile, and it comes back; and the program is stopped. No file but the list
// holds an id, a name or a text of anything of that server, its entry or its secret, and from
// the first call for that server to the stop no file but the list is written at all.
func TestSectionNothingOfAnotherServerIsWritten(t *testing.T) {
	t.Parallel()
	const entry = savedEntryID
	const (
		moreGroup, moreBoard, moreRun = "g_more", "b_bbbb0002", "r_bbbb0002"
		moreChat                      = "2c000000-0000-4000-8000-00000000000c"
		// What a page here makes there.
		madeGroup, madeBoard, madeRun = "g_made", "b_cccc0003", "r_cccc0003"
		madeChat                      = "2d000000-0000-4000-8000-00000000000d"
		// That server's prompt library.
		libGroup, libPrompt, libSecond = "g_0000000000c1", "p_0000000000c1", "p_0000000000c2"
	)
	shot := testPNG("a shot of the studio")
	sum := sha256.Sum256(shot)
	image := hex.EncodeToString(sum[:])
	// What was typed, drawn and sent for that server here, and what that server told of.
	marks := append(farMarks(), moreGroup, moreBoard, moreRun, moreChat, "More there", "Second board there", "another draft there",
		"said there", "typed here into a chat there", "sent from here to there", "drawn-here-for-there", "studio-shot", "a shot of the studio", image,
		madeGroup, madeBoard, madeRun, madeChat, "Made from here", "made-from-here", "a goal typed here for a run there", "drawn-here-on-a-new-board-there",
		libGroup, libPrompt, libSecond, "Studio prompts", "studio-review", "Look at the studio's work.", "studio-second", "A second prompt of the studio.",
		"drawn-here-during-the-outage", "typed here during the outage", "a shot during the outage", "studio-folder", "studio-usage",
		// The entry and its server, what that server offers for a new chat, and its folders.
		entry, standin.DefaultInstanceID, "/home/standin", "standin-model", "Stand-in model")

	tree := farTree()
	tree["library"] = map[string]any{
		"groups":  []any{map[string]any{"id": libGroup, "name": "Studio prompts", "parent": ""}},
		"prompts": []any{map[string]any{"id": libPrompt, "name": "studio-review", "parent": libGroup, "text": "Look at the studio's work."}},
	}
	st := standin.Start(t, standin.Options{Snapshot: tree})
	said := func(v any) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(v)
		}
	}
	made := farView(madeChat, "Made from here")
	made.Group, made.Locked = madeGroup, false
	for pattern, v := range map[string]any{
		"GET /api/chats/{id}/items": map[string]any{"branch": "main", "version": 1, "items": []any{map[string]any{"kind": "user", "text": "said there"}},
			"subagents": []any{}, "state": map[string]any{"chat": farChat, "branch": "main", "status": "ready"}},
		"GET /api/runs/{id}/detail":     map[string]any{"run": farRun, "version": 1, "agents": map[string]any{}},
		"PUT /api/chats/{id}/draft":     map[string]any{"ok": true, "rev": 2},
		"POST /api/chats/{id}/messages": map[string]any{"branch": "main"},
		"POST /api/chats/{id}/images":   model.Image{ID: image, Name: "studio-shot.png", Type: "image/png", Size: int64(len(shot))},
		"POST /api/boards/{id}/take":    map[string]any{"state": "held", "rev": 3},
		"PUT /api/boards/{id}/scene":    map[string]any{"ok": true, "rev": 4},
		"POST /api/boards/{id}/release": map[string]any{"state": "free"},
		"POST /api/chats/{id}/unfollow": map[string]any{"ok": true},
		"POST /api/runs/{id}/unfollow":  map[string]any{"ok": true},
		// What a page here makes there, and what it asks that server for.
		"POST /api/groups":          model.Group{ID: madeGroup, Name: "Made from here"},
		"POST /api/chats":           made,
		"PATCH /api/chats/{id}":     map[string]any{"ok": true, "chat": made},
		"POST /api/boards":          model.Board{ID: madeBoard, Name: "made-from-here", Group: madeGroup, Created: farTime},
		"POST /api/runs":            model.RunView{ID: madeRun, Name: "Made from here", Group: madeGroup, Agent: model.Claude, Status: model.RunDraft, Created: farTime},
		"PUT /api/runs/{id}/draft":  map[string]any{"ok": true},
		"GET /api/dirs":             map[string]any{"path": "/home/standin", "dirs": []string{"studio-folder"}},
		"GET /api/usage/{agent}":    map[string]any{"plan": "studio-usage"},
		"POST /api/chats/{id}/open": map[string]any{"ok": true},
	} {
		st.Handle(pattern, said(v))
	}
	st.Handle("GET /api/chats/{id}/images/{image}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(shot)
	})

	waits, err := parseTestWaits("backoff=200ms") // the tries after a drop come within 200 ms
	if err != nil {
		t.Fatal(err)
	}
	// alone is a program with no entry, which goes through the local steps and nothing else.
	aloneRoot, root := t.TempDir(), t.TempDir()
	alone := wiredWaits(t, aloneRoot, true, waits)
	alone.page(t, "page")
	localSteps(t, alone, "page")

	if err := os.WriteFile(filepath.Join(root, servers.FileName), []byte(savedEntry(st)), 0o600); err != nil {
		t.Fatal(err)
	}
	pr := wiredWaits(t, root, true, waits)
	page := pr.page(t, "page")
	localSteps(t, pr, "page")
	until(t, "the relay has the entry's tree", func() bool { _, ok := pr.sectionOf(entry); return ok })
	// The folder as the local steps left it: nothing but the list is written from here on.
	before := folderFiles(t, root)
	on := func(rest string) string { return "/api/on/" + entry + rest }
	must := func(method, path string, body any) answer {
		t.Helper()
		got := pr.call(t, "page", method, path, body)
		if got.Status != http.StatusOK {
			t.Fatalf("%s %s: %s", method, path, got)
		}
		return got
	}

	// The page follows a chat and a run of that server, and that server tells of a change of
	// each kind and of what the two hold.
	must("GET", on("/chats/"+farChat+"/items"), nil)
	must("GET", on("/runs/"+farRun+"/detail"), nil)
	added := farView(moreChat, "Made there")
	added.Locked, added.Draft, added.DraftRev, added.HasDraft = false, &model.Draft{Text: "another draft there"}, 1, true
	mark := page.mark()
	for _, ev := range []map[string]any{
		{"type": "groups", "groups": []model.Group{{ID: farGroup, Name: farGroupName}, {ID: moreGroup, Name: "More there"}}},
		{"type": "defaults", "defaults": model.Defaults{Groups: map[string]model.GroupDefaults{
			moreGroup: model.LocalDefaults(model.ServerDefaults{Agent: model.Claude, Cwd: "/home/standin/more"})}}},
		{"type": "board", "board": model.Board{ID: moreBoard, Name: "Second board there", Group: moreGroup, Created: farTime}},
		{"type": "branch_state", "state": model.StateOf(moreChat, model.MainBranch, added)},
		{"type": "chat", "chat": added},
		{"type": "run", "run": model.RunView{ID: moreRun, Name: "More there", Group: moreGroup, Agent: model.Claude, Status: model.RunDraft, Created: farTime}},
		{"type": "chat_items", "chat": farChat, "branch": "main", "version": 2, "items": []any{map[string]any{"kind": "assistant", "text": "said there"}}},
		{"type": "tree", "chat": farChat, "version": 2, "branches": []any{}},
		{"type": "run_detail", "run": farRun, "detail": map[string]any{"run": farRun, "version": 2}},
		{"type": "run_activity", "run": farRun, "note": "said there"},
		{"type": "board_removed", "id": moreBoard},
		{"type": "run_removed", "id": moreRun},
		{"type": "chat_removed", "id": moreChat},
	} {
		st.Send(ev)
	}
	for _, typ := range []string{"groups", "defaults", "board", "branch_state", "chat", "run", "chat_items", "tree", "run_detail", "run_activity", "board_removed", "run_removed", "chat_removed"} {
		page.awaitEvent(t, mark, 10*time.Second, typ, `"server":"`+entry+`"`)
	}
	if tree, _ := pr.sectionOf(entry); len(tree.Groups) != 2 || len(tree.Chats) != 2 || len(tree.Boards) != 1 || len(tree.Runs) != 1 || tree.Defaults.Groups[moreGroup].Local().Cwd == "" {
		t.Fatalf("the tree after that server's events: %+v", tree)
	}

	// The page's calls for things of that server: each reaches it.
	must("PUT", on("/chats/"+farDrafted+"/draft?rev=1"), map[string]any{"text": "typed here into a chat there"})
	must("POST", on("/chats/"+farChat+"/messages"), map[string]any{"text": "sent from here to there"})
	var held struct {
		State string
		Rev   int
	}
	if json.Unmarshal([]byte(must("POST", on("/boards/"+farBoard+"/take"), map[string]any{"ifFree": true}).Raw), &held); held.State != "held" || held.Rev != 3 {
		t.Fatalf("the take of a board of that server: %+v", held)
	}
	must("PUT", on("/boards/"+farBoard+"/scene?rev="+strconv.Itoa(held.Rev)), json.RawMessage(boardScene("drawn-here-for-there")))
	if resp, raw := pr.send(t, "page", "POST", on("/chats/"+farChat+"/images?name=studio-shot.png"), "image/png", shot); resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), image) {
		t.Fatalf("the upload of an image to a chat of that server: %d %s", resp.StatusCode, raw)
	}
	if resp, raw := pr.send(t, "page", "GET", on("/chats/"+farChat+"/images/"+image), "", nil); resp.StatusCode != http.StatusOK || !bytes.Equal(raw, shot) || resp.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("the fetch of an image of a chat of that server: %d with %d bytes as %q", resp.StatusCode, len(raw), resp.Header.Get("Content-Type"))
	}
	// Things are made there from here: a group, a chat in it, a board, which the page that made
	// it draws on, and a run with its goal. What a chat there starts with is changed, which that
	// server remembers and this one does not, and that server's folders and usage are asked for.
	maker := pr.page(t, "maker")
	mustAs := func(id, method, path string, body any) {
		t.Helper()
		if got := pr.call(t, id, method, path, body); got.Status != http.StatusOK {
			t.Fatalf("%s %s: %s", method, path, got)
		}
	}
	must("POST", on("/groups"), map[string]any{"name": "Made from here", "parent": ""})
	must("POST", on("/chats"), map[string]any{"id": madeChat, "agent": "claude", "group": madeGroup})
	must("PATCH", on("/chats/"+madeChat), map[string]any{"cwd": "/home/standin/elsewhere", "model": "standin-model"})
	mustAs("maker", "POST", on("/boards"), map[string]any{"name": "made-from-here", "group": madeGroup})
	// The page that made the board holds it: its drawing is taken.
	mustAs("maker", "PUT", on("/boards/"+madeBoard+"/scene?rev=3"), json.RawMessage(boardScene("drawn-here-on-a-new-board-there")))
	must("POST", on("/runs"), map[string]any{"group": madeGroup, "name": "Made from here"})
	must("PUT", on("/runs/"+madeRun+"/draft"), map[string]any{"text": "a goal typed here for a run there"})
	if got := must("GET", "/api/dirs?server="+entry+"&path=/home/standin", nil); !strings.Contains(got.Raw, "studio-folder") {
		t.Fatalf("the folders of that server: %s", got)
	}
	if got := must("GET", "/api/usage/claude?server="+entry, nil); !strings.Contains(got.Raw, "studio-usage") {
		t.Fatalf("the usage of an agent of that server: %s", got)
	}

	// That server's prompt library is shown beside this computer's, and a change of it arrives.
	mark = page.mark()
	st.Send(map[string]any{"type": "own_library",
		"groups": []any{map[string]any{"id": libGroup, "name": "Studio prompts", "parent": ""}},
		"prompts": []any{map[string]any{"id": libPrompt, "name": "studio-review", "parent": libGroup, "text": "Look at the studio's work."},
			map[string]any{"id": libSecond, "name": "studio-second", "parent": libGroup, "text": "A second prompt of the studio."}}})
	page.awaitEvent(t, mark, 10*time.Second, "library", entry, "studio-second")
	// libraries checks the libraries a page is given: this computer's with its one prompt, and
	// that server's with its two, connected or not.
	libraries := func(when string, connected bool) {
		t.Helper()
		var l struct {
			Libraries []struct {
				Server    string
				Connected bool
				Prompts   []struct{ Name, Text string }
			}
		}
		got := must("GET", "/api/library", nil)
		if json.Unmarshal([]byte(got.Raw), &l); len(l.Libraries) != 2 || l.Libraries[0].Server != servers.LocalID || len(l.Libraries[0].Prompts) != 1 ||
			l.Libraries[0].Prompts[0].Text != "a prompt of this computer" || l.Libraries[1].Server != entry || l.Libraries[1].Connected != connected ||
			len(l.Libraries[1].Prompts) != 2 || l.Libraries[1].Prompts[1].Text != "A second prompt of the studio." {
			t.Fatalf("%s: the libraries: %s", when, got)
		}
	}
	libraries("connected", true)

	var got []string
	for _, r := range st.Requests() {
		got = append(got, r.Method+" "+r.Path)
	}
	for _, want := range []string{
		"PUT /api/chats/" + farDrafted + "/draft", "POST /api/chats/" + farChat + "/messages", "POST /api/boards/" + farBoard + "/take",
		"PUT /api/boards/" + farBoard + "/scene", "POST /api/chats/" + farChat + "/images", "GET /api/chats/" + farChat + "/images/" + image,
		"POST /api/groups", "POST /api/chats", "PATCH /api/chats/" + madeChat, "POST /api/boards", "POST /api/boards/" + madeBoard + "/take",
		"PUT /api/boards/" + madeBoard + "/scene", "POST /api/runs", "PUT /api/runs/" + madeRun + "/draft", "GET /api/dirs", "GET /api/usage/claude",
	} {
		if !slices.Contains(got, want) {
			t.Fatalf("that server was not sent %s; it was sent %v", want, got)
		}
	}

	// compare holds the folder of the connected program to the folder of the one with no entry,
	// and to what it held itself before the first call for that server.
	compare := func(when string) {
		t.Helper()
		files := folderFiles(t, root)
		if held := holders(files, marks); len(held) != 0 {
			t.Errorf("%s: files that hold something of that server: %v", when, held)
		}
		for rel, b := range files {
			if was, ok := before[rel]; !strings.HasPrefix(rel, servers.FileName) && (!ok || !bytes.Equal(was, b)) {
				t.Errorf("%s: %s was written since the first call for that server", when, rel)
			}
		}
		for rel := range before {
			if _, ok := files[rel]; !ok {
				t.Errorf("%s: %s was removed since the first call for that server", when, rel)
			}
		}
		with, without := folderPaths(files), folderPaths(folderFiles(t, aloneRoot))
		var more []string
		for _, rel := range with {
			if i := slices.Index(without, rel); i >= 0 {
				without = slices.Delete(without, i, i+1)
			} else {
				more = append(more, rel)
			}
		}
		if len(without) != 0 || !slices.Contains(more, servers.FileName) {
			t.Errorf("%s: the folder lacks %v of what a folder with no entry has; it has %v more, want the server list", when, without, more)
		}
		for _, rel := range more {
			if !strings.HasPrefix(rel, servers.FileName) { // the list, and what the list itself keeps beside it
				t.Errorf("%s: %s is in the folder of the connected program and not in one with no entry", when, rel)
			}
		}
	}
	compare("connected")

	// That server drops, with a chat and a run followed and two boards held here. What a page
	// tries meanwhile is refused and kept nowhere: a save of a drawing, of a draft and of an
	// image, and a make. The copy of its library stays in memory, marked as not connected.
	mark = page.mark()
	st.Stop()
	page.await(t, mark, 10*time.Second, "section event with null", func(e seenEvent) bool { return e.holds("section", entry, `"tree":null`) })
	away := func(what string, a answer) {
		t.Helper()
		if a.Status != http.StatusServiceUnavailable || a.Code != "server_unreachable" {
			t.Fatalf("%s while that server is away: %s", what, a)
		}
	}
	away("the save of a drawing", pr.call(t, "page", "PUT", on("/boards/"+farBoard+"/scene?rev=4"), json.RawMessage(boardScene("drawn-here-during-the-outage"))))
	away("the save of a draft", pr.call(t, "page", "PUT", on("/chats/"+farDrafted+"/draft?rev=2"), map[string]any{"text": "typed here during the outage"}))
	away("a new chat", pr.call(t, "page", "POST", on("/chats"), map[string]any{"agent": "claude", "group": madeGroup}))
	if resp, raw := pr.send(t, "page", "POST", on("/chats/"+farChat+"/images?name=studio-shot.png"), "image/png", testPNG("a shot during the outage")); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("the upload of an image while that server is away: %d %s", resp.StatusCode, raw)
	}
	until(t, "the copy of that server's library is marked as not connected", func() bool {
		l := pr.a.Remotes.Libraries()
		return len(l) == 1 && !l[0].Connected
	})
	libraries("during the outage", false)
	compare("during the outage")

	// It comes back: the boards are taken there again for the pages that hold them.
	mark, makerMark := page.mark(), maker.mark()
	st.Restart()
	page.await(t, mark, 10*time.Second, "section event with the tree of the server that is back", func(e seenEvent) bool {
		return e.holds("section", entry, `"tree":{`)
	})
	page.awaitEvent(t, mark, 10*time.Second, "held", farBoard, `"server":"`+entry+`"`)
	maker.awaitEvent(t, makerMark, 10*time.Second, "held", madeBoard, `"server":"`+entry+`"`)
	compare("after the return")
	alone.stop()
	pr.stop()
	compare("after the stop")
	if t.Failed() {
		t.Logf("the folder of the connected program: %v", folderPaths(folderFiles(t, root)))
	}
}
