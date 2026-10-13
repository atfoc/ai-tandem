package remotes

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// named is the tree of fullTree with every name ending in suffix: the same ids on another server.
func named(suffix string) tree {
	tr := fullTree()
	for i := range tr.chats {
		tr.chats[i].Name += suffix
	}
	for i := range tr.boards {
		tr.boards[i].Name += suffix
	}
	for i := range tr.runs {
		tr.runs[i].Name += suffix
	}
	return tr
}

// TestSectionSameIDsInTwoSections: an id is unique on one server only. A chat, a run and a
// board with the same ids in two sections, and on this server, are told apart everywhere: in
// the trees, in the events, in the follows, in the board holds, in the tool calls and in the
// calls that are passed on.
func TestSectionSameIDsInTwoSections(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(named(" of Studio")), hold: true})
	studio := rg.far
	loft := rg.server("Loft", snapshotOf(named(" of Loft")))
	ths := map[*far]*there{studio: boardRoutes(studio), loft: boardRoutes(loft)}
	for _, f := range []*far{studio, loft} {
		f.serveReads()
	}
	rg.start()
	loft.returned(1)
	ctx := context.Background()

	// The trees.
	sections := rg.r.Sections()
	if len(sections) != 2 || sections[studio.entry].Chats[0].Name != "Chat 1a of Studio" || sections[loft.entry].Chats[0].Name != "Chat 1a of Loft" ||
		sections[studio.entry].Chats[0].ID != sections[loft.entry].Chats[0].ID {
		t.Fatalf("the sections: %s", mustJSON(t, sections))
	}
	onStudio, _ := rg.page("page-studio")
	onLoft, _ := rg.page("page-loft")
	local, snapshot := rg.page("page-local")
	if got := snapshot["sections"].(map[string]any); len(got) != 2 || !sameJSON(t, got[studio.entry], sections[studio.entry]) || !sameJSON(t, got[loft.entry], sections[loft.entry]) {
		t.Fatalf("the snapshot's sections: %v", got)
	}
	pages := []*bridgetest.Page{onStudio, onLoft, local}

	// The follows: one page per place, each of the thing with the same id.
	studio.readChat(onStudio, chatA)
	studio.readRun(onStudio, runA)
	loft.readChat(onLoft, chatA)
	loft.readRun(onLoft, runA)
	for _, it := range []editorbridge.Item{editorbridge.Chat(chatA), editorbridge.Run(runA)} {
		if !rg.b.FollowAs(editorbridge.KindPage, local.ID, it) {
			t.Fatal("the page of this server's chat does not follow")
		}
	}
	// The content events of the thing in one place reach the page that follows it there, and no
	// other: got is what each page got of them, by the place they named.
	contents := func(got [][]map[string]any) (out [3][]any) {
		for i, events := range got {
			for _, ev := range events {
				if ev["type"] == "chat_items" || ev["type"] == "run_detail" {
					out[i] = append(out[i], ev["server"])
				}
			}
		}
		return out
	}
	for i, f := range []*far{studio, loft} {
		f.s.Send(map[string]any{"type": "chat_items", "chat": chatA, "version": 2, "updates": []any{}})
		f.s.Send(map[string]any{"type": "run_detail", "run": runA, "version": 2})
		var want [3][]any
		want[i] = []any{f.entry, f.entry}
		if got := contents(f.barrier(pages...)); !reflect.DeepEqual(got, want) {
			t.Errorf("the content events of %s reached %v, want %v", f.name, got, want)
		}
	}
	rg.b.SendChat(chatA, false, map[string]any{"type": "chat_items", "chat": chatA, "version": 9, "updates": []any{}})
	rg.b.SendRun(runA, map[string]any{"type": "run_detail", "run": runA, "version": 9})
	if got, want := contents(studio.barrier(pages...)), ([3][]any{nil, nil, {nil, nil}}); !reflect.DeepEqual(got, want) {
		t.Errorf("the content events of this server's chat and run reached %v, want %v", got, want)
	}

	// A change of the chat on one server changes that server's tree alone, and every page is
	// told which.
	renamed := farChat(chatA, model.StatusThinking)
	renamed.Name = "Renamed on Studio"
	studio.s.Send(map[string]any{"type": "chat", "chat": renamed})
	for i, got := range studio.barrier(pages...) {
		if len(got) != 1 || got[0]["server"] != studio.entry || field(got[0], "chat", "name") != "Renamed on Studio" {
			t.Errorf("page %d got %v", i, got)
		}
	}
	sections = rg.r.Sections()
	if sections[studio.entry].Chats[0].Name != "Renamed on Studio" || sections[loft.entry].Chats[0].Name != "Chat 1a of Loft" {
		t.Errorf("the chats after a change on one server: %q and %q", sections[studio.entry].Chats[0].Name, sections[loft.entry].Chats[0].Name)
	}

	// A call for the thing goes to the server that is named, with the id as it is.
	labels := map[*far]*script{studio: studio.script("PUT /api/chats/{id}/label"), loft: loft.script("PUT /api/chats/{id}/label")}
	for f, s := range labels {
		s.answer(http.StatusOK, map[string]any{"on": f.name})
	}
	rep := rg.r.Pass(ctx, loft.entry, http.MethodPut, chatPath(chatA, "/label"), []byte(`{}`), rg.r.Limits().Call)
	wantReply(t, "a call for the chat on Loft", rep, http.StatusOK, map[string]any{"on": "Loft"})
	if labels[studio].count() != 0 || labels[loft].last(t).URI != "/api/chats/"+chatA+"/label" {
		t.Errorf("the calls: Studio %v, Loft %v", labels[studio].calls(), labels[loft].calls())
	}

	// The boards: three pages hold three boards with one id, each at its own revision.
	ths[studio].set(func() { ths[studio].take = func(string, bool) thereAnswer { return heldThereAt(3) } })
	ths[loft].set(func() { ths[loft].take = func(string, bool) thereAnswer { return heldThereAt(7) } })
	wantReply(t, "take on Studio", rg.r.TakeBoard(studio.entry, onStudio.ID, boardA, false), http.StatusOK, map[string]any{"state": "held", "rev": 3.0})
	wantReply(t, "take on Loft", rg.r.TakeBoard(loft.entry, onLoft.ID, boardA, false), http.StatusOK, map[string]any{"state": "held", "rev": 7.0})
	if state, rev, err := rg.b.TakeBoard(local.ID, boardA, false); err != nil || state != "held" || rev != 0 {
		t.Errorf("the take of this server's board: %s at %d, %v", state, rev, err)
	}
	if holder(studio, boardA) != onStudio.ID || holder(loft, boardA) != onLoft.ID {
		t.Errorf("the holders: %q on Studio, %q on Loft", holder(studio, boardA), holder(loft, boardA))
	}
	if h, _ := rg.b.HolderOf(boardA); h != local.ID {
		t.Errorf("this server's board is held by %q", h)
	}
	for f, rev := range map[*far]int64{studio: 3, loft: 7} {
		if got, ok := rg.r.BoardRev(editorbridge.BoardOn(f.entry, boardA)); got != rev || !ok {
			t.Errorf("the revision of the board on %s: %d, %v", f.name, got, ok)
		}
	}
	// A save is the holder's of that section alone, and goes to that server alone.
	scene := []byte(`{"elements":[]}`)
	wantReply(t, "a save on Studio by the holder on Loft", rg.r.SaveScene(studio.entry, onLoft.ID, boardA, 3, scene), http.StatusConflict, map[string]any{"code": "not_holder"})
	wantReply(t, "a save on Studio by the holder of this server's board", rg.r.SaveScene(studio.entry, local.ID, boardA, 3, scene), http.StatusConflict, map[string]any{"code": "not_holder"})
	wantReply(t, "a save on Loft", rg.r.SaveScene(loft.entry, onLoft.ID, boardA, 7, scene), http.StatusOK, map[string]any{"rev": 8.0})
	if got := ths[studio].calls("put"); got != nil || len(ths[loft].calls("put")) != 1 {
		t.Errorf("the saves: Studio %v, Loft %v", got, ths[loft].calls("put"))
	}
	// A tool call of an agent on one server reaches the page that holds that server's board.
	studio.s.Send(toolCall("rpc_1", "draw", boardA, ""))
	loft.s.Send(toolCall("rpc_1", "draw", boardA, ""))
	for p, f := range map[*bridgetest.Page]*far{onStudio: studio, onLoft: loft} {
		ev := role(t, p, "rpc")
		id, _ := ev["id"].(string)
		if ev["server"] != f.entry || field(ev, "params", "board") != boardA {
			t.Errorf("the tool call of %s: %v", f.name, ev)
		}
		wantReply(t, "the answer of the page", rg.r.ReplyBoardCall(ctx, p.ID, id, []byte(`{"result":"`+f.name+`"}`)), http.StatusOK, nil)
	}
	for f, th := range ths {
		if got := answers(t, th, 1); !reflect.DeepEqual(got[0], map[string]any{"id": "rpc_1", "result": f.name}) {
			t.Errorf("the answer %s got: %v", f.name, got)
		}
	}
	noRole(t, studio, local)

	// One server removes the chat and the board, and then drops: nothing of the other section,
	// and nothing of this server, is touched.
	studio.s.Send(map[string]any{"type": "chat_removed", "id": chatA})
	studio.s.Send(map[string]any{"type": "board_removed", "id": boardA})
	role(t, onStudio, "superseded")
	studio.barrier(onStudio)
	if rg.b.Followed(editorbridge.ChatOn(studio.entry, chatA)) || !rg.b.Followed(editorbridge.ChatOn(loft.entry, chatA)) || !rg.b.Followed(editorbridge.Chat(chatA)) {
		t.Error("the removal of a chat on one server ended a follow of another's, or kept its own")
	}
	studio.offline()
	sections = rg.r.Sections()
	if _, ok := sections[studio.entry]; ok || len(sections[loft.entry].Chats) != 2 || len(sections[loft.entry].Boards) != 1 {
		t.Errorf("the sections after the drop of one server: %s", mustJSON(t, sections))
	}
	if !rg.b.Followed(editorbridge.RunOn(loft.entry, runA)) || !rg.b.Followed(editorbridge.Run(runA)) || rg.b.Followed(editorbridge.RunOn(studio.entry, runA)) {
		t.Error("the drop of one server ended a follow of another's, or kept its own")
	}
	if h, _ := rg.b.HolderOf(boardA); holder(loft, boardA) != onLoft.ID || h != local.ID || holder(studio, boardA) != "" {
		t.Errorf("the holders after the drop: %q on Loft, %q here, %q on Studio", holder(loft, boardA), h, holder(studio, boardA))
	}
	wantReply(t, "a save on Loft after Studio dropped", rg.r.SaveScene(loft.entry, onLoft.ID, boardA, 8, scene), http.StatusOK, map[string]any{"rev": 9.0})
	// The last unfollow of the chat on Loft is told to Loft, and to nobody else.
	rg.r.UnfollowChat(loft.entry, onLoft.ID, chatA)
	rg.until("the unfollow at Loft", func() bool { return len(loft.requests("POST", "/api/chats/"+chatA+"/unfollow")) == 1 })
	if got := studio.requests("POST", "/unfollow"); got != nil || !rg.b.Followed(editorbridge.Chat(chatA)) {
		t.Errorf("the unfollow on Loft reached Studio, or this server's chat: %v", got)
	}
}

// files are the files under root, by their path from it.
func files(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if rel, _ := filepath.Rel(root, path); rel != "." {
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// TestSectionNothingOnDisk: the relay keeps nothing on disk. After a server connected, things
// were made, changed, followed, drawn on and deleted on it, and it dropped and came back, the
// data folder holds the server list and nothing else.
func TestSectionNothingOnDisk(t *testing.T) {
	t.Parallel()
	rg, th := holdRig(t, rigOpt{}, boardA)
	rg.serveReads()
	ctx := context.Background()
	p, _ := rg.page("page-1")
	create := rg.script("POST /api/chats")
	create.answer(http.StatusOK, farChat(chatA, model.StatusReady))
	message := rg.script("POST /api/chats/{id}/messages")
	message.answer(http.StatusOK, map[string]any{"ok": true})
	upload := rg.script("POST /api/chats/{id}/images")
	upload.answer(http.StatusOK, map[string]any{"id": "x", "name": "a.png", "type": "image/png", "size": 8})

	wantReply(t, "a chat is made", rg.r.Pass(ctx, rg.entry, http.MethodPost, "/api/chats", []byte(`{"group":"g_there"}`), rg.r.Limits().Call), http.StatusOK, nil)
	rg.s.Send(map[string]any{"type": "branch_state", "state": model.StateOf(chatA, mainBranch, farChat(chatA, model.StatusReady))})
	rg.s.Send(map[string]any{"type": "chat", "chat": farChat(chatA, model.StatusReady)})
	rg.s.Send(map[string]any{"type": "run", "run": farRun(runA, model.RunDraft)})
	rg.s.Send(map[string]any{"type": "groups", "groups": []model.Group{farGroup("g_there", "Work")}})
	rg.s.Send(map[string]any{"type": "own_library", "groups": []any{}, "prompts": []any{}})
	rg.readChat(p, chatA)
	rg.readRun(p, runA)
	wantReply(t, "a message", rg.r.PassMessage(ctx, rg.entry, chatPath(chatA, "/messages"), []byte(`{"text":"hi"}`)), http.StatusOK, nil)
	wantReply(t, "an image", rg.r.UploadImage(ctx, rg.entry, chatA, "a.png", "image/png", []byte("\x89PNG\r\n\x1a\n")), http.StatusOK, nil)
	take(t, rg, p, boardA)
	wantReply(t, "a save", rg.r.SaveScene(rg.entry, p.ID, boardA, 1, []byte(`{"elements":[1]}`)), http.StatusOK, nil)
	rg.barrier(p)

	rg.s.DropStreams()
	rg.returned(2)
	role(t, p, "held")
	rg.s.Send(map[string]any{"type": "chat_removed", "id": chatA})
	rg.s.Send(map[string]any{"type": "board_removed", "id": boardA})
	rg.barrier(p)
	rg.offline()
	if len(th.calls("put")) != 1 {
		t.Errorf("the saves at the server: %v", th.calls("put"))
	}

	// The shutdown writes nothing either.
	rg.m.Close()
	rg.r.Close()
	if got := files(t, rg.root); !reflect.DeepEqual(got, []string{servers.FileName}) {
		t.Errorf("the data folder holds %v, want the server list alone", got)
	}
}
