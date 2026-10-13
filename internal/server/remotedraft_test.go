package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/testset"
)

// A chat of a section between two real stacks (see boardpair_test.go): A is the user's own
// server, B the server the chat is on. The chat is made on B from A's page, and from then on two
// pages type in its one draft: A's page, whose calls A passes on, and B's own page. The draft
// and its counter are B's, and B's counter decides between the two. What A's half does of it
// alone, against a stand-in, is in section_draft_test.go.

// draftSeen reads the page's events up to the state of the first branch of the chat of the
// section server ("" for a chat of the page's own server) with the draft counter want, and
// returns that state. On the way no state and no view of the chat may tell a lower counter than
// one told before: last is the highest the page was told so far.
func draftSeen(t *testing.T, p *bridgetest.Page, server, id string, want int64, last *int64) model.BranchState {
	t.Helper()
	for end := time.Now().Add(waitLimit); time.Now().Before(end); {
		raw := p.NextRaw()
		ev := decode[struct {
			Type   string
			Server string
			Chat   *model.ChatView
			State  *model.BranchState
		}](t, raw)
		var rev int64
		switch {
		case ev.Server != server:
			continue
		case ev.Type == "branch_state" && ev.State != nil && ev.State.Chat == id:
			rev = ev.State.DraftRev
		case ev.Type == "chat" && ev.Chat != nil && ev.Chat.ID == id:
			rev = ev.Chat.DraftRev
		default:
			continue
		}
		if rev < *last {
			t.Fatalf("the page %s was told the counter %d after %d: %s", p.ID, rev, *last, raw)
		}
		*last = rev
		if ev.Type == "branch_state" && rev == want {
			return *ev.State
		}
	}
	t.Fatalf("the page %s was not told the draft counter %d of the chat", p.ID, want)
	return model.BranchState{}
}

// draftOn is draft for a page of A and a chat of B's section.
func (pr *pair) draftOn(p *bridgetest.Page, want int, id, query, text string) saved {
	pr.t.Helper()
	status, out := p.Do("PUT", pr.on("/chats/"+id+"/draft?"+query), obj{"text": text})
	if status != want {
		pr.t.Fatalf("the draft save of %s with %s: %d %s, want %d", p.ID, query, status, out, want)
	}
	return decode[saved](pr.t, string(out))
}

// chatsOn are the chats of B's section as A's page is handed them.
func (pr *pair) chatsOn(p *bridgetest.Page) []model.ChatView {
	pr.t.Helper()
	snap := decode[pageSnapshot](pr.t, string(do(pr.t, p, "GET", "/api/state", nil)))
	if len(snap.Chats) != 0 {
		pr.t.Fatalf("A lists chats of its own: %+v", snap.Chats)
	}
	if sec := snap.Sections[pr.entry]; sec != nil {
		return sec.Chats
	}
	return nil
}

func TestTwoPagesInOneDraftOfAChatOnAnotherServer(t *testing.T) {
	t.Parallel()
	pr := newPair(t, remotes.Limits{})
	a, b := pr.a, pr.b
	p := a.page("P")   // this app's page
	own := b.page("O") // the page of the server the chat is on
	group := decode[obj](t, string(do(t, p, "POST", pr.on("/groups"), obj{"name": "Work", "parent": ""})))["id"].(string)

	cv := decode[model.ChatView](t, string(do(t, p, "POST", pr.on("/chats"), obj{"agent": "claude", "group": group})))
	id := cv.ID
	if cv.Locked || cv.Group != group || cv.Draft != nil || cv.DraftRev != 0 {
		t.Fatalf("the new chat: %+v", cv)
	}
	// It is on B at once, before any message, for B's own page too, in the group it was made
	// in; A keeps no chat.
	there, err := b.a.Chats.View(id)
	if err != nil || there.Locked || there.Group != group {
		t.Fatalf("the chat on B: %+v, %v", there, err)
	}
	if _, err := a.a.Chats.View(id); !errors.Is(err, chats.ErrNotFound) {
		t.Fatalf("the chat is a chat of A: %v", err)
	}
	var last int64 // the highest draft counter A's page was told

	// This app's page types first: the draft is saved on B, with B's counter.
	if got := pr.draftOn(p, 200, id, "rev=0", "typed here"); got.Rev != 1 {
		t.Fatalf("the save of A's page: %+v", got)
	}
	if v, _ := b.a.Chats.View(id); draftOf(v.Draft) != "typed here" || v.DraftRev != 1 {
		t.Fatalf("the draft on B: %q on %d", draftOf(v.Draft), v.DraftRev)
	}
	if st := draftSeen(t, p, pr.entry, id, 1, &last); draftOf(st.Draft) != "typed here" {
		t.Fatalf("A's page was told %+v", st)
	}
	// A keeps nothing of the draft on disk: no folder of the things of other servers, and none
	// of the chat.
	if _, err := os.Stat(filepath.Join(pr.root, "remote")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("A keeps a folder of the things of other servers: %v", err)
	}
	if _, err := os.Stat(a.st.P.ChatDir(id)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("A has a folder for the chat: %v", err)
	}

	// B's own page typed on the counter before: it is refused, and told the draft that is there.
	if got := draft(t, own, 409, id, "rev=0", "typed there"); got.Code != "stale" || got.Rev != 1 || draftOf(got.Draft) != "typed here" {
		t.Fatalf("the save of B's page on the counter before: %+v", got)
	}
	// It types on that draft. A's page gets B's draft and counter with B's events, and its own
	// next save, on the counter it had, is the stale one: the answer is B's, through A.
	if got := draft(t, own, 200, id, "rev=1", "typed here, and there"); got.Rev != 2 {
		t.Fatalf("the save of B's page: %+v", got)
	}
	if st := draftSeen(t, p, pr.entry, id, 2, &last); draftOf(st.Draft) != "typed here, and there" {
		t.Fatalf("A's page was told %+v", st)
	}
	if got := pr.draftOn(p, 409, id, "rev=1", "typed here, more"); got.Code != "stale" || got.Rev != 2 || draftOf(got.Draft) != "typed here, and there" {
		t.Fatalf("the save of A's page on the counter before: %+v", got)
	}
	if listed := pr.chatsOn(p); len(listed) != 1 ||
		draftOf(listed[0].Draft) != "typed here, and there" || listed[0].DraftRev != 2 || !listed[0].HasDraft {
		t.Fatalf("A's snapshot: %+v", listed)
	}

	// Both save on the same counter at once: one is stored, and the other is refused with the
	// stored one's text and counter. Never both, never neither, never a mix.
	rounds := 5
	if testset.Full() {
		rounds = 50
	}
	rev := int64(2)
	for round := 0; round < rounds; round++ {
		texts := [2]string{fmt.Sprintf("A's page %d", round), fmt.Sprintf("B's page %d", round)}
		var got [2]saved
		var status [2]int
		var wg sync.WaitGroup
		paths := [2]string{pr.on("/chats/" + id), "/api/chats/" + id} // the chat for A's page, and for B's own
		for i, c := range []*bridgetest.Page{p, own} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				var out []byte
				status[i], out = c.Do("PUT", fmt.Sprintf("%s/draft?rev=%d", paths[i], rev), obj{"text": texts[i]})
				if err := json.Unmarshal(out, &got[i]); err != nil {
					t.Errorf("round %d: %s", round, out)
				}
			}()
		}
		wg.Wait()
		won := 0
		if status[1] == 200 {
			won = 1
		}
		lost := 1 - won
		if status[won] != 200 || got[won].Rev != rev+1 || status[lost] != 409 || got[lost].Code != "stale" || got[lost].Rev != rev+1 || draftOf(got[lost].Draft) != texts[won] {
			t.Fatalf("round %d: A's page got %d %+v, B's page %d %+v", round, status[0], got[0], status[1], got[1])
		}
		rev++
		if v, _ := b.a.Chats.View(id); draftOf(v.Draft) != texts[won] || v.DraftRev != rev {
			t.Fatalf("round %d: B stored %q on %d, want %q on %d", round, draftOf(v.Draft), v.DraftRev, texts[won], rev)
		}
		// A's page is told every change, on a counter that never goes down.
		if st := draftSeen(t, p, pr.entry, id, rev, &last); draftOf(st.Draft) != texts[won] {
			t.Fatalf("round %d: A's page was told %+v, want %q", round, st, texts[won])
		}
	}

	// The settings before the first message are changed on B, from A's page.
	if ans := decode[struct{ Chat model.ChatView }](t, string(do(t, p, "PATCH", pr.on("/chats/"+id), obj{"effort": "low"}))); ans.Chat.Effort != "low" || ans.Chat.Locked {
		t.Fatalf("the effort, changed from A's page: %+v", ans.Chat)
	}
	if v, _ := b.a.Chats.View(id); v.Effort != "low" || v.DraftRev != rev {
		t.Fatalf("the chat on B after the change: %+v", v)
	}

	// The first message, from A's page, is an ordinary message: B starts its agent, removes the
	// draft and raises the counter, and both pages are told. A save of the text that was sent,
	// still on its way, is refused as stale, with no draft.
	stored, _ := b.a.Chats.View(id)
	do(t, p, "POST", pr.on("/chats/"+id+"/messages"), obj{"text": draftOf(stored.Draft)})
	if st := draftSeen(t, p, pr.entry, id, rev+1, &last); st.Draft != nil {
		t.Fatalf("A's page after the first message: %+v", st)
	}
	if got := pr.draftOn(p, 409, id, fmt.Sprintf("rev=%d", rev), "typed while it was sent"); got.Code != "stale" || got.Rev != rev+1 || got.Draft != nil {
		t.Fatalf("the save of A's page on the counter of the sent draft: %+v", got)
	}
	if got := draft(t, own, 200, id, fmt.Sprintf("rev=%d", rev+1), "typed after the message"); got.Rev != rev+2 {
		t.Fatalf("the save of B's page after the message: %+v", got)
	}
	if st := draftSeen(t, p, pr.entry, id, rev+2, &last); draftOf(st.Draft) != "typed after the message" {
		t.Fatalf("A's page after B's page typed again: %+v", st)
	}
	pr.wait("B's section on A lists the chat as started", func() bool {
		listed := pr.chatsOn(p)
		return len(listed) == 1 && listed[0].Locked
	})
	if _, items, _, err := b.a.Chats.Items(id); err != nil || len(items) == 0 || items[0].Kind != "user" || items[0].Text != draftOf(stored.Draft) {
		t.Fatalf("the first message on B: %+v, %v", items, err)
	}
	if pr.sp.count() != 1 {
		t.Fatalf("%d programs started on B", pr.sp.count())
	}
	if _, err := a.a.Chats.View(id); !errors.Is(err, chats.ErrNotFound) {
		t.Fatalf("the started chat is a chat of A: %v", err)
	}
}

// While the chat's server cannot be reached its draft cannot be saved: the save fails, with a
// code the page keeps its text by, and is taken again when the server is back. Nothing of that
// server is listed meanwhile, and nothing can be made on it.
func TestDraftOfAChatWhoseServerIsAway(t *testing.T) {
	t.Parallel()
	pr := newPair(t, remotes.Limits{})
	a, b := pr.a, pr.b
	p := a.page("P")
	group := decode[obj](t, string(do(t, p, "POST", pr.on("/groups"), obj{"name": "Work", "parent": ""})))["id"].(string)
	started := decode[model.ChatView](t, string(do(t, p, "POST", pr.on("/chats"), obj{"agent": "claude", "group": group})))
	fresh := decode[model.ChatView](t, string(do(t, p, "POST", pr.on("/chats"), obj{"agent": "claude", "group": group})))
	do(t, p, "POST", pr.on("/chats/"+started.ID+"/messages"), obj{"text": "hello"})
	if got := pr.draftOn(p, 200, fresh.ID, "rev=0", "typed before"); got.Rev != 1 {
		t.Fatalf("the save before the outage: %+v", got)
	}

	pr.cut()
	for _, id := range []string{started.ID, fresh.ID} {
		status, out := p.Do("PUT", pr.on("/chats/"+id+"/draft?rev=1"), obj{"text": "typed while it was away"})
		pr.refusal("a draft save while the server is away", 503, "server_unreachable", status, out)
		status, out = p.Do("POST", pr.on("/chats/"+id+"/messages"), obj{"text": "sent while it was away"})
		pr.refusal("a message while the server is away", 503, "server_unreachable", status, out)
	}
	// No chat can be made on it either.
	status, out := p.Do("POST", pr.on("/chats"), obj{"agent": "claude", "group": group})
	pr.refusal("a new chat while the server is away", 503, "server_unreachable", status, out)
	if v, _ := b.a.Chats.View(fresh.ID); draftOf(v.Draft) != "typed before" || v.DraftRev != 1 {
		t.Fatalf("the draft on B after the refused saves: %q on %d", draftOf(v.Draft), v.DraftRev)
	}
	if snap := decode[pageSnapshot](t, string(do(t, p, "GET", "/api/state", nil))); len(snap.Sections) != 0 || len(snap.Chats) != 0 {
		t.Fatalf("A's snapshot while the server is away: sections %v, chats %+v", snap.Sections, snap.Chats)
	}

	// The server is back: the pages are told its tree (section), and the save is taken, on the
	// counter B has.
	n := pr.ups.Load()
	pr.link.Uncut()
	pr.event(p, "section", func(ev map[string]any) bool { return ev["server"] == pr.entry && ev["tree"] != nil })
	pr.returned(n + 1)
	if got := pr.draftOn(p, 200, fresh.ID, "rev=1", "typed while it was away"); got.Rev != 2 {
		t.Fatalf("the save after the return: %+v", got)
	}
	if v, _ := b.a.Chats.View(fresh.ID); draftOf(v.Draft) != "typed while it was away" || v.DraftRev != 2 {
		t.Fatalf("the draft on B after the return: %q on %d", draftOf(v.Draft), v.DraftRev)
	}
	_ = a
}
