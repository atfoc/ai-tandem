package remotes

import (
	"context"
	"net/http"
	"reflect"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// noSection fails unless the relay holds no tree of the server and a page's snapshot has no key
// for it.
func noSection(t *testing.T, f *far, when string) {
	t.Helper()
	if _, ok := f.treeOf(); ok {
		t.Errorf("%s: the relay holds a tree of %s", when, f.name)
	}
	_, snapshot := f.rg.page("page-" + model.NewID("p"))
	sections, isMap := snapshot["sections"].(map[string]any)
	if _, has := sections[f.entry]; !isMap || has {
		t.Errorf("%s: the snapshot's sections: %v", when, snapshot["sections"])
	}
}

// nullSection reads the page's events up to the section event of the server, which must say
// that no tree is held.
func nullSection(t *testing.T, p *bridgetest.Page, f *far) {
	t.Helper()
	ev := next(t, p, "section")
	if tree, has := ev["tree"]; ev["server"] != f.entry || !has || tree != nil || len(ev) != 3 {
		t.Fatalf("the section event of a tree that is gone: %v", ev)
	}
}

// TestSectionStates: a section in each state. No tree while the entry connects; a tree once its
// snapshot was read; none again, and a section event with null, when the server drops; its tree
// as that server has it now when it is back. The follows of the entry end with the tree, and
// every call for a thing of it is refused while there is none.
func TestSectionStates(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree()), hold: true})
	rg.serveReads()
	label := rg.script("PUT /api/chats/{id}/label")
	label.answer(http.StatusOK, map[string]any{"ok": true})
	ctx := context.Background()
	p, _ := rg.page("page-1")
	call := func() Reply {
		return rg.r.Pass(ctx, rg.entry, http.MethodPut, chatPath(chatA, "/label"), []byte(`{"label":"x"}`), rg.r.Limits().Call)
	}
	unreachable := map[string]any{"code": "server_unreachable", "error": "Studio is not connected."}

	// Connecting: no tree, and nothing is sent.
	noSection(t, rg.far, "while connecting")
	wantReply(t, "a call while connecting", call(), http.StatusServiceUnavailable, unreachable)
	wantReply(t, "a read while connecting", rg.r.FollowChat(ctx, rg.entry, p.ID, chatA, chatPath(chatA, "/items")), http.StatusServiceUnavailable, unreachable)
	if rg.b.Followed(editorbridge.ChatOn(rg.entry, chatA)) {
		t.Error("a read that was not sent left a follow")
	}

	// Connected: the tree, and the calls work.
	rg.start()
	if ev := next(t, p, "section"); ev["server"] != rg.entry || field(ev, "tree", "chats") == nil {
		t.Fatalf("the section event of the connect: %v", ev)
	}
	wantReply(t, "a call while connected", call(), http.StatusOK, map[string]any{"ok": true})
	rg.readChat(p, chatA)

	// The server drops.
	rg.offline()
	nullSection(t, p, rg.far)
	noSection(t, rg.far, "after the drop")
	if it := editorbridge.ChatOn(rg.entry, chatA); rg.b.Followed(it) {
		t.Errorf("%v is still followed after its tree went", it)
	}
	asked := len(rg.calls())
	wantReply(t, "a call after the drop", call(), http.StatusServiceUnavailable, unreachable)
	if got := rg.calls(); len(got) != asked {
		t.Errorf("the server that is away was asked: %v", got[asked:])
	}
	if got := rg.requests(http.MethodPost, "/unfollow"); got != nil {
		t.Errorf("the follows that ended with the tree were ended there: %v", got)
	}

	// It is back, with another tree: the section is that server's tree as it is now.
	now := tree{chats: []model.ChatView{farChat(chatB, model.StatusThinking)}, groups: []model.Group{farGroup("g_later", "Later")}}
	rg.s.SetSnapshot(snapshotOf(now))
	rg.s.Restart()
	rg.returned(2)
	ev := next(t, p, "section")
	held, _ := rg.treeOf()
	if ev["server"] != rg.entry || !sameJSON(t, ev["tree"], held) {
		t.Errorf("the section event of the return: %v", ev)
	}
	if len(held.Chats) != 1 || held.Chats[0].ID != chatB || len(held.Boards) != 0 || held.Groups[0].ID != "g_later" {
		t.Errorf("the tree after the return: %s", mustJSON(t, held))
	}
	wantReply(t, "a call after the return", call(), http.StatusOK, map[string]any{"ok": true})
}

// TestSectionOfAServerThatIsTooOld: an entry whose server reports a level below the one this
// app connects to has no tree, and a call for it says that the server must be updated. Once
// that server is updated the entry connects by itself and its tree arrives.
func TestSectionOfAServerThatIsTooOld(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree()), timing: func(tm *servers.Timing) { tm.TooOld = 30 * time.Millisecond }})
	p, _ := rg.page("page-1")
	label := rg.script("PUT /api/chats/{id}/label")
	label.answer(http.StatusOK, map[string]any{"ok": true})

	rg.s.SetFeatureLevel(standin.Level(servers.MinFeatureLevel - 1))
	rg.s.DropStreams()
	rg.state(servers.StateTooOld)
	rg.away()
	nullSection(t, p, rg.far)
	noSection(t, rg.far, "too old")
	rep := rg.r.Pass(context.Background(), rg.entry, http.MethodPut, chatPath(chatA, "/label"), nil, rg.r.Limits().Call)
	wantReply(t, "a call for a server that is too old", rep, http.StatusServiceUnavailable,
		map[string]any{"code": "server_unreachable", "error": "Studio is too old: update the server on that machine."})
	wantReply(t, "a take on a server that is too old", rg.r.TakeBoard(rg.entry, p.ID, boardA, false), http.StatusServiceUnavailable,
		map[string]any{"error": "Studio is too old: update the server on that machine."})
	if label.count() != 0 {
		t.Errorf("a server that is too old was asked: %v", label.calls())
	}

	rg.s.SetFeatureLevel(standin.Level(testLevel))
	rg.returned(2)
	if ev := next(t, p, "section"); ev["server"] != rg.entry || field(ev, "tree", "chats") == nil {
		t.Errorf("the section event after the update: %v", ev)
	}
}

// TestSectionOfAnEntryThatIsRemoved: with its entry a section goes. The pages are told that no
// tree is held, also for an entry that had none, and that the entry has no lists; its follows
// end; a call that names it finds no server. That server is told nothing.
func TestSectionOfAnEntryThatIsRemoved(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree())})
	rg.serveReads()
	away := rg.server("Loft", snapshotOf(fullTree()))
	away.returned(1)
	p, _ := rg.page("page-1")
	rg.readChat(p, chatA)
	away.offline()
	nullSection(t, p, away)

	for _, f := range []*far{rg.far, away} {
		asked := len(f.calls())
		if err := rg.m.Remove(f.entry); err != nil {
			t.Fatal(err)
		}
		var types []any
		for {
			ev := p.Next()
			if ev["server"] != f.entry {
				continue
			}
			types = append(types, ev["type"])
			if ev["type"] == "server_lists" {
				if lists, has := ev["lists"]; !has || lists != nil {
					t.Errorf("the lists of a removed entry: %v", ev)
				}
				break
			}
			if tree, has := ev["tree"]; ev["type"] != "section" || !has || tree != nil {
				t.Errorf("an event of a removed entry: %v", ev)
			}
		}
		if !reflect.DeepEqual(types, []any{"section", "server_lists"}) {
			t.Errorf("%s: the events of the removal: %v", f.name, types)
		}
		if _, ok := f.treeOf(); ok {
			t.Errorf("%s: a tree of a removed entry is held", f.name)
		}
		rep := rg.r.Pass(context.Background(), f.entry, http.MethodGet, chatPath(chatA, ""), nil, rg.r.Limits().Call)
		wantReply(t, f.name+": a call for a removed entry", rep, http.StatusNotFound,
			map[string]any{"code": "no_server", "error": "This server is not in the list."})
		if got := f.calls(); len(got) != asked {
			t.Errorf("%s was told of its removal: %v", f.name, got[asked:])
		}
	}
	if rg.b.Followed(editorbridge.ChatOn(rg.entry, chatA)) {
		t.Error("a chat of a removed entry is still followed")
	}
	if got := rg.r.Sections(); len(got) != 0 {
		t.Errorf("the sections after the removals: %v", got)
	}
}

// TestSectionSnapshotThatCannotBeRead: a snapshot whose tree is not what a tree is leaves the
// entry with no section, and is logged; the next one that can be read gives one.
func TestSectionSnapshotThatCannotBeRead(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree())})
	p, _ := rg.page("page-1")
	rg.h.Snapshot(rg.entry, []byte(`{"groups":"not a list","chats":[]}`))
	rg.away()
	nullSection(t, p, rg.far)
	noSection(t, rg.far, "a tree that cannot be read")
	if rg.logs.count("cannot be read") != 1 {
		t.Errorf("the log: %v", rg.logs.all())
	}
	rg.s.DropStreams()
	rg.returned(3)
	if ev := next(t, p, "section"); field(ev, "tree", "chats") == nil {
		t.Errorf("the section event of the next snapshot: %v", ev)
	}
}
