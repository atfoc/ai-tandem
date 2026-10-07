package remotes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// types are the types of events.
func types(evs []map[string]any) []string {
	out := []string{}
	for _, ev := range evs {
		out = append(out, fmt.Sprint(ev["type"]))
	}
	return out
}

// TestEventTable: every row of the table of a remote server's events, as two pages see it: one
// that read the chat and one that did not.
func TestEventTable(t *testing.T) {
	seed := seedOf(chatA)
	seed.Drafts = map[string]*model.Draft{mainBranch: {Text: "for main"}, "b1": {Text: "for b1"}}
	seed.DraftRevs = map[string]int64{mainBranch: 3, "b1": 5}
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}})
	rg.serveItems()
	reader, snap := rg.page("page-reader")
	other, _ := rg.page("page-other")
	rg.read(reader, chatA)

	// The page's snapshot is built from the relay with the bridge's lock held.
	if got := field(snap, "chats").([]any); len(got) != 1 || field(got[0], "server") != rg.entry || field(got[0], "group") != "g_here" {
		t.Errorf("the snapshot's chats: %v", got)
	}
	if got := field(snap, "states").([]any); len(got) != 1 || field(got[0], "draft", "text") != "for main" {
		t.Errorf("the snapshot's states: %v", got)
	}
	if field(snap, "lists", rg.entry, "home") != "/home/standin" {
		t.Errorf("the snapshot's lists: %v", field(snap, "lists"))
	}
	var seen []string // every event of both pages, as it came
	next := func(p *bridgetest.Page) map[string]any {
		t.Helper()
		raw := p.NextRaw()
		seen = append(seen, raw)
		var ev map[string]any
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			t.Fatal(err)
		}
		return ev
	}

	// chat: the record's place, the entry, no mark's action and no board of the remote server, the drafts.
	view := remoteView(chatA, model.StatusThinking)
	view.Board, view.Server, view.Start = "b_there", "s_there", "unconfirmed"
	view.Archive = model.Archive{Archived: true, Op: "a_there"}
	view.Draft, view.HasDraft = &model.Draft{Text: "typed there"}, true
	rg.s.Send(map[string]any{"type": "chat", "chat": view})
	for _, p := range []*bridgetest.Page{reader, other} {
		ev := next(p)
		c, _ := ev["chat"].(map[string]any)
		if ev["type"] != "chat" || c["id"] != chatA || c["group"] != "g_here" || c["server"] != rg.entry ||
			c["status"] != "thinking" || c["archived"] != true || field(c, "draft", "text") != "for main" ||
			c["draftRev"] != float64(3) || c["hasDraft"] != true {
			t.Errorf("page %s: chat event %v", p.ID, ev)
		}
		for _, k := range []string{"archiveOp", "board", "start", "gone", "run"} {
			if _, has := c[k]; has {
				t.Errorf("page %s: the chat has %q: %v", p.ID, k, c[k])
			}
		}
	}

	// branch_state: with the branch's draft.
	rg.s.Send(map[string]any{"type": "branch_state", "state": model.BranchState{
		Chat: chatA, Branch: "b1", Status: model.StatusTool, StatusTool: "Bash", Draft: &model.Draft{Text: "typed there"},
	}})
	for _, p := range []*bridgetest.Page{reader, other} {
		ev := next(p)
		if ev["type"] != "branch_state" || field(ev, "state", "chat") != chatA || field(ev, "state", "branch") != "b1" ||
			field(ev, "state", "statusTool") != "Bash" || field(ev, "state", "draft", "text") != "for b1" || field(ev, "state", "draftRev") != float64(5) {
			t.Errorf("page %s: branch_state event %v", p.ID, ev)
		}
	}

	// The four content types: the bytes that came, to the page that read alone.
	for _, ev := range []map[string]any{
		{"type": "chat_items", "chat": chatA, "branch": "main", "version": 4, "updates": []any{map[string]any{"id": "i1", "text": "<b>a & b</b> ünï  "}}},
		{"type": "tree", "chat": chatA, "nodes": []any{map[string]any{"id": "main", "group": "g_there"}}},
		{"type": "sub", "chat": chatA, "branch": "main", "subagent": map[string]any{"id": "sa1", "status": "running"}},
		{"type": "sub_items", "chat": chatA, "branch": "main", "sub": "sa1", "version": 2, "updates": []any{}},
	} {
		want, _ := json.Marshal(ev)
		rg.s.Send(ev)
		got := reader.NextRaw()
		seen = append(seen, got)
		if got != string(want) {
			t.Errorf("%s: the reader got\n%s\nwant\n%s", ev["type"], got, want)
		}
	}

	// chat_removed: not passed on; the chat is gone, and stays listed.
	rg.s.Send(map[string]any{"type": "chat_removed", "id": chatA})
	for _, p := range []*bridgetest.Page{reader, other} {
		ev := next(p)
		if ev["type"] != "chat" || field(ev, "chat", "id") != chatA || field(ev, "chat", "gone") != true {
			t.Errorf("page %s: after chat_removed: %v", p.ID, ev)
		}
	}
	if !rg.file(chatA).Gone || !rg.r.Has(chatA) {
		t.Error("the gone mark is not written at once, or the record is no more")
	}

	// catalog and agents: server_lists, never as they came.
	rg.s.Send(map[string]any{"type": "catalog", "agent": "claude", "catalog": model.Catalog{
		Models: []model.CatalogModel{{ID: "new-model", Label: "New"}}, Default: model.ModelChoice{Model: "new-model"},
	}})
	for _, p := range []*bridgetest.Page{reader, other} {
		ev := next(p)
		if ev["type"] != "server_lists" || ev["server"] != rg.entry || field(ev, "lists", "catalogs", "claude", "default", "model") != "new-model" ||
			field(ev, "lists", "home") != "/home/standin" || field(ev, "lists", "defaultCwd") != "/home/standin/work" {
			t.Errorf("page %s: after catalog: %v", p.ID, ev)
		}
	}
	rg.s.Send(map[string]any{"type": "agents", "agents": []string{"pi"}})
	for _, p := range []*bridgetest.Page{reader, other} {
		ev := next(p)
		if ev["type"] != "server_lists" || !reflect.DeepEqual(field(ev, "lists", "agents"), []any{"pi"}) {
			t.Errorf("page %s: after agents: %v", p.ID, ev)
		}
	}

	// The events of a run without a record and a type this build does not know are dropped:
	// nothing comes before the barrier's event, and the page that did not read got no content
	// event at all.
	for _, typ := range []string{"run", "run_removed", "run_detail", "run_activity", "weather"} {
		rg.s.Send(map[string]any{"type": typ, "id": "r1", "run": map[string]any{"id": "r1"}, "chat": chatA})
	}
	for i, got := range rg.barrier(reader, other) {
		if len(got) != 0 {
			t.Errorf("page %d got %v", i, got)
		}
	}
	if n := rg.r.dropped.Load(); n != 0 {
		t.Errorf("%d events were counted as dropped for a chat without a record", n)
	}
	if n := rg.r.droppedRuns.Load(); n != 4 {
		t.Errorf("%d events were counted as dropped for a run without a record, want 4", n)
	}

	// No secret reached a page or the file.
	file, _ := os.ReadFile(rg.r.files.path(chatA))
	for _, s := range append(seen, string(file), strings.Join(rg.logs.all(), "\n")) {
		if strings.Contains(s, standin.DefaultSecret) {
			t.Errorf("the secret is in %s", s)
		}
	}
}

// TestUnknownChatDropped: an event of a chat without a record is dropped and counted, and
// logged once for its id. A server's event never reaches the record of another server's chat.
func TestUnknownChatDropped(t *testing.T) {
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}})
	rg.serveItems()
	p, _ := rg.page("page-1")
	rg.read(p, chatA)
	rg.b.FollowAs(editorbridge.KindPage, p.ID, editorbridge.Chat(chatB)) // it would get what is handed on

	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatB, model.StatusThinking)})
	rg.s.Send(map[string]any{"type": "branch_state", "state": model.BranchState{Chat: chatB, Branch: mainBranch}})
	rg.s.Send(map[string]any{"type": "chat_items", "chat": chatB, "version": 1, "updates": []any{}})
	rg.s.Send(map[string]any{"type": "chat_removed", "id": chatB})
	if got := rg.barrier(p)[0]; len(got) != 0 {
		t.Errorf("the page got %v", got)
	}
	if n := rg.r.dropped.Load(); n != 4 {
		t.Errorf("%d events counted as dropped, want 4", n)
	}
	if n := rg.logs.count(chatB); n != 1 {
		t.Errorf("%d log lines for the id, want one a minute: %v", n, rg.logs.all())
	}

	// The same events from another entry, for the chat of this one: dropped, the record untouched.
	raw, _ := json.Marshal(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusError)})
	rg.r.event("s_other", "chat", raw)
	raw, _ = json.Marshal(map[string]any{"type": "chat_removed", "id": chatA})
	rg.r.event("s_other", "chat_removed", raw)
	raw, _ = json.Marshal(map[string]any{"type": "chat_items", "chat": chatA})
	rg.r.event("s_other", "chat_items", raw)
	if n := rg.r.dropped.Load(); n != 7 {
		t.Errorf("%d events counted as dropped, want 7", n)
	}
	if v := rg.r.Views()[0]; v.Status != model.StatusReady || v.Gone {
		t.Errorf("another server changed the record: %+v", v)
	}

	// A content event that names its type or its chat twice is not handed on: a page would read
	// another event than the one that was routed.
	for _, raw := range []string{
		`{"type":"chat_items","chat":"` + chatA + `","chat":"local-chat","updates":[]}`,
		`{"type":"chat_items","type":"servers","chat":"` + chatA + `","servers":[]}`,
		`{"type":"servers","Type":"chat_items","chat":"` + chatA + `","servers":[]}`,
	} {
		rg.r.event(rg.entry, "chat_items", json.RawMessage(raw))
	}
	p.ExpectNone(quiet)
}

// TestFollows: content events go to the page that read alone; the remote server is told to end
// the follow when the last page's stream ends, and not while another page follows.
func TestFollows(t *testing.T) {
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}})
	rg.serveItems()
	first, _ := rg.page("page-first")
	second, _ := rg.page("page-second")
	rg.read(first, chatA)
	if got := rg.requests("GET", "/api/chats/"+chatA+"/items"); len(got) != 1 || got[0].Client != testLocalID || got[0].Secret != standin.DefaultSecret {
		t.Fatalf("the read at the server: %+v", got)
	}

	items := map[string]any{"type": "chat_items", "chat": chatA, "version": 2, "updates": []any{}}
	rg.s.Send(items)
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusWriting)})
	first.Expect("chat_items")
	first.Expect("chat")
	second.Expect("chat") // list events only

	// A second follower: the first one's stream ends, and the server is told nothing.
	rg.read(second, chatA)
	first.Close()
	rg.until("the first page's follow has ended", func() bool {
		return reflect.DeepEqual(rg.b.Followers(editorbridge.Chat(chatA)), []string{second.ID})
	})
	time.Sleep(quiet)
	if got := rg.requests("POST", "/unfollow"); len(got) != 0 {
		t.Fatalf("an unfollow while a page follows: %+v", got)
	}
	rg.s.Send(items)
	second.Expect("chat_items")

	// The last follower's stream ends: one unfollow call, as this server.
	second.Close()
	rg.until("the unfollow call", func() bool { return len(rg.requests("POST", "/unfollow")) > 0 })
	time.Sleep(quiet)
	got := rg.requests("POST", "/unfollow")
	if len(got) != 1 || got[0].Path != "/api/chats/"+chatA+"/unfollow" || got[0].Client != testLocalID {
		t.Errorf("the unfollow calls: %+v", got)
	}

	// An unfollow by the page's own call does the same.
	third, _ := rg.page("page-third")
	rg.read(third, chatA)
	rg.b.UnfollowAs(editorbridge.KindPage, third.ID, editorbridge.Chat(chatA))
	rg.until("the second unfollow call", func() bool { return len(rg.requests("POST", "/unfollow")) == 2 })
}

// TestUnfollowNeverOvertakesARead: the follow lock. While a read is passed on the unfollow call
// waits, and while the unfollow call is out a read waits.
func TestUnfollowNeverOvertakesARead(t *testing.T) {
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}})
	rec := rg.r.rec(chatA)
	var mu sync.Mutex
	var order []string
	note := func(s string) {
		mu.Lock()
		defer mu.Unlock()
		order = append(order, s)
	}
	noted := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), order...)
	}
	hold := make(chan struct{}, 2)
	var fast atomic.Bool // answer without waiting
	slow := func(name string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			note(name + " in")
			if !fast.Load() {
				<-hold
			}
			note(name + " out")
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{}`))
		}
	}
	rg.s.Handle("GET /api/chats/{id}/items", slow("read"))
	rg.s.Handle("POST /api/chats/{id}/unfollow", slow("unfollow"))
	p, _ := rg.page("page-1")
	read := func(client string) chan struct{} {
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _ = rg.r.follow(context.Background(), rec, client, http.MethodGet, chatPath(chatA, "/items"), wait)
		}()
		return done
	}
	chat := editorbridge.Chat(chatA)

	// A read is out and the page leaves the chat at once: the unfollow waits for the read's answer.
	done := read(p.ID)
	rg.until("the read is at the server", func() bool { return len(noted()) == 1 })
	rg.b.UnfollowAs(editorbridge.KindPage, p.ID, chat)
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, []string{"read in"}) {
		t.Fatalf("while the read is out: %v", got)
	}
	hold <- struct{}{}
	<-done
	rg.until("the unfollow is at the server", func() bool { return len(noted()) == 3 })

	// The unfollow is out: a read waits for its answer.
	done = read(p.ID)
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, []string{"read in", "read out", "unfollow in"}) {
		t.Fatalf("while the unfollow is out: %v", got)
	}
	hold <- struct{}{}
	rg.until("the read is at the server", func() bool { return len(noted()) == 5 })
	hold <- struct{}{}
	<-done
	time.Sleep(quiet)
	want := []string{"read in", "read out", "unfollow in", "unfollow out", "read in", "read out"}
	if got := noted(); !reflect.DeepEqual(got, want) {
		t.Errorf("the order at the server: %v", got)
	}
	if !rg.b.Followed(chat) {
		t.Error("the page does not follow after its second read")
	}

	// A chat that a page follows by the time the hook runs is not unfollowed; a run and a chat
	// without a record are passed over.
	fast.Store(true)
	rg.r.Unfollowed([]editorbridge.Item{chat, editorbridge.Run(chatA), editorbridge.Chat("no-record")})
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, want) {
		t.Errorf("an unfollow call for a chat that is followed: %v", got)
	}

	// A read for a client that has no stream here follows nothing here: the follow it made there
	// is ended after it, unless a page follows the chat.
	<-read("page-without-a-stream")
	time.Sleep(quiet)
	if got := noted(); !reflect.DeepEqual(got, append(want, "read in", "read out")) {
		t.Errorf("a read without a stream while a page follows: %v", got)
	}
	rg.b.UnfollowAs(editorbridge.KindPage, p.ID, chat)
	rg.until("the page's unfollow is at the server", func() bool { return len(noted()) == 10 })
	<-read("page-without-a-stream")
	rg.until("the unfollow after the read is at the server", func() bool { return len(noted()) == 14 })
	want = append(want, "read in", "read out", "unfollow in", "unfollow out", "read in", "read out", "unfollow in", "unfollow out")
	if got := noted(); !reflect.DeepEqual(got, want) {
		t.Errorf("a read without a stream: %v", got)
	}

	// A chat that is gone there is not unfollowed.
	raw, _ := json.Marshal(map[string]any{"type": "chat_removed", "id": chatA})
	rg.r.event(rg.entry, "chat_removed", raw)
	rg.r.Unfollowed([]editorbridge.Item{chat})
	time.Sleep(quiet)
	if got := noted(); len(got) != len(want) {
		t.Errorf("an unfollow call for a gone chat: %v", got[len(want):])
	}
}

// TestSnapshotSteps: the steps of a stream's start, in their order, as a page and the two hook
// points see them. A chat that the snapshot does not have is gone.
func TestSnapshotSteps(t *testing.T) {
	there := remoteView(chatA, model.StatusThinking)
	snap := snapshotWith(there)
	snap["states"] = []model.BranchState{
		model.StateOf(chatA, mainBranch, there),
		{Chat: chatA, Branch: "b1", Status: model.StatusTool},
		{Chat: "another-chat", Branch: mainBranch},
	}
	a, b := seedOf(chatA), seedOf(chatB)
	a.Drafts, a.DraftRevs = map[string]*model.Draft{"b1": {Text: "for b1"}}, map[string]int64{"b1": 2}

	var mu sync.Mutex
	var steps []string
	note := func(s string) {
		mu.Lock()
		defer mu.Unlock()
		steps = append(steps, s)
	}
	var pending sync.WaitGroup
	pending.Add(1)
	rg := newRig(t, rigOpt{snapshot: snap, seed: []Record{a, b}, hold: true, wire: func(rg *rig) {
		followed := func() bool { return rg.b.Followed(editorbridge.Chat(chatA)) }
		rg.r.settle = func(entry string, s *snapshot) {
			v, has := s.chat(chatA)
			_, hasB := s.chat(chatB)
			note(fmt.Sprintf("settle %v: the record is %s, gone %v; the snapshot has %v %s with %d states, %v; followed %v",
				entry == rg.entry, rg.r.Views()[0].Status, rg.r.Views()[1].Gone, has, v.Status, len(s.states(chatA, v)), hasB, followed()))
		}
		rg.local.onUp = func(entry string) { note(fmt.Sprintf("up %v: followed %v", entry == rg.entry, followed())) }
		rg.r.pending = func(ctx context.Context, entry string) {
			defer pending.Done()
			note(fmt.Sprintf("pending %v %v", entry == rg.entry, ctx.Err() == nil))
		}
	}})
	p, first := rg.page("page-1")
	if got := field(first, "chats").([]any); len(got) != 2 || field(got[0], "status") != "ready" {
		t.Fatalf("the page's snapshot before the connect: %v", got)
	}
	rg.b.FollowAs(editorbridge.KindPage, p.ID, editorbridge.Chat(chatA))
	rg.b.FollowAs(editorbridge.KindPage, p.ID, editorbridge.Chat(chatB))
	rg.start()
	pending.Wait()

	// 1 and 5, then 6: the lists, server_back, then states and views, record by record.
	ev := p.Expect("server_lists")
	if ev["server"] != rg.entry || !reflect.DeepEqual(field(ev, "lists", "agents"), []any{"claude", "pi"}) {
		t.Errorf("server_lists: %v", ev)
	}
	if ev = p.Expect("server_back"); ev["server"] != rg.entry {
		t.Errorf("server_back: %v", ev)
	}
	if ev = p.Expect("branch_state"); field(ev, "state", "chat") != chatA || field(ev, "state", "branch") != "main" || field(ev, "state", "status") != "thinking" {
		t.Errorf("the state of main: %v", ev)
	}
	if ev = p.Expect("branch_state"); field(ev, "state", "branch") != "b1" || field(ev, "state", "status") != "tool" || field(ev, "state", "draft", "text") != "for b1" {
		t.Errorf("the state of b1: %v", ev)
	}
	ev = p.Expect("chat")
	if c := ev["chat"].(map[string]any); c["id"] != chatA || c["status"] != "thinking" || c["group"] != "g_here" || c["gone"] != nil || c["hasDraft"] != true {
		t.Errorf("the chat that is there: %v", ev)
	}
	if ev = p.Expect("branch_state"); field(ev, "state", "chat") != chatB {
		t.Errorf("the state of the chat that is not there: %v", ev)
	}
	if ev = p.Expect("chat"); field(ev, "chat", "id") != chatB || field(ev, "chat", "gone") != true {
		t.Errorf("the chat that is not there: %v", ev)
	}
	p.ExpectNone(quiet)

	// 2 before 3, 4 before 7, 8 last.
	want := []string{
		"settle true: the record is thinking, gone true; the snapshot has true thinking with 2 states, false; followed true",
		"up true: followed false",
		"pending true true",
	}
	mu.Lock()
	if !reflect.DeepEqual(steps, want) {
		t.Errorf("the steps:\n%s\nwant\n%s", strings.Join(steps, "\n"), strings.Join(want, "\n"))
	}
	mu.Unlock()

	// 4: the follows are gone, and the remote server was told nothing about them.
	if rg.b.Followed(editorbridge.Chat(chatA)) || rg.b.Followed(editorbridge.Chat(chatB)) {
		t.Error("a follow outlived the return")
	}
	if got := rg.requests("POST", "/unfollow"); len(got) != 0 {
		t.Errorf("unfollow calls at a return: %+v", got)
	}
	// The gone mark is written at once; the view waits for the flush.
	if !rg.file(chatB).Gone {
		t.Error("the gone mark is not in the file")
	}
	if got := rg.r.States(); len(got) != 3 || got[1].Branch != "b1" || got[1].Draft == nil || got[2].Chat != chatB {
		t.Errorf("States: %+v", got)
	}
}

// TestGoneAndBack: a chat that a snapshot does not have is gone, and is back when a later
// snapshot has it. Each return is the same steps again.
func TestGoneAndBack(t *testing.T) {
	a, b := seedOf(chatA), seedOf(chatB)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(a.View, b.View), seed: []Record{a, b}})
	p, _ := rg.page("page-1")
	gone := func() (out []bool) {
		for _, v := range rg.r.Views() {
			out = append(out, v.Gone)
		}
		return out
	}
	// turn makes the server start a new stream with these chats, and returns the page's events.
	turns := 1
	turn := func(views ...model.ChatView) []map[string]any {
		t.Helper()
		rg.s.SetSnapshot(snapshotWith(views...))
		rg.s.DropStreams()
		turns++
		rg.returned(turns)
		var evs []map[string]any
		for range 6 {
			evs = append(evs, p.Next())
		}
		if got, want := types(evs), []string{"server_lists", "server_back", "branch_state", "chat", "branch_state", "chat"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("the events of a return: %v", got)
		}
		return evs
	}
	if got := gone(); !reflect.DeepEqual(got, []bool{false, false}) {
		t.Fatalf("gone at the start: %v", got)
	}

	b.View.Status = model.StatusWriting
	evs := turn(b.View)
	if field(evs[3], "chat", "id") != chatA || field(evs[3], "chat", "gone") != true || field(evs[5], "chat", "gone") != nil || field(evs[5], "chat", "status") != "writing" {
		t.Errorf("after a snapshot without the first chat: %v", evs)
	}
	if got := gone(); !reflect.DeepEqual(got, []bool{true, false}) || !rg.file(chatA).Gone {
		t.Errorf("gone: %v, in the file %v", got, rg.file(chatA).Gone)
	}
	// A gone chat keeps its last view.
	if v := rg.r.Views()[0]; v.Name != a.View.Name || v.Group != "g_here" {
		t.Errorf("the gone chat's view: %+v", v)
	}

	a.View.Status = model.StatusApproval
	evs = turn(a.View, b.View)
	if field(evs[3], "chat", "gone") != nil || field(evs[3], "chat", "status") != "approval" || field(evs[2], "state", "status") != "approval" {
		t.Errorf("after a snapshot with the chat again: %v", evs)
	}
	if got := gone(); !reflect.DeepEqual(got, []bool{false, false}) || rg.file(chatA).Gone {
		t.Errorf("gone: %v, in the file %v", got, rg.file(chatA).Gone)
	}

	// A chat event of a gone chat brings it back too.
	turn(b.View)
	rg.s.Send(map[string]any{"type": "chat", "chat": a.View})
	if ev := p.Expect("chat"); field(ev, "chat", "gone") != nil {
		t.Errorf("a chat event of a gone chat: %v", ev)
	}
	if rg.file(chatA).Gone {
		t.Error("the file still says gone")
	}
}

// TestHooksDoNotBlock: a file write that hangs and a page that reads nothing do not hold the
// stream's reader: every hook returns at once, and the events wait in the entry's queue.
func TestHooksDoNotBlock(t *testing.T) {
	const events = 300
	seed := seedOf(chatA)
	var calls atomic.Int64
	var longest atomic.Int64
	timed := func(f func()) {
		start := time.Now()
		f()
		calls.Add(1)
		if d := int64(time.Since(start)); d > longest.Load() {
			longest.Store(d) // one reader calls the hooks: no two at once
		}
	}
	var block atomic.Bool
	release := make(chan struct{})
	var writes atomic.Int64
	rg := newRig(t, rigOpt{
		snapshot: snapshotWith(seed.View), seed: []Record{seed},
		wire: func(rg *rig) {
			write := rg.r.files.write
			rg.r.files.write = func(path string, b []byte) error {
				writes.Add(1)
				if block.Load() {
					<-release
				}
				return write(path, b)
			}
		},
		hooks: func(h *servers.Hooks) {
			snapshot, event := h.Snapshot, h.Event
			h.Snapshot = func(entry string, raw json.RawMessage) { timed(func() { snapshot(entry, raw) }) }
			h.Event = func(entry, typ string, raw json.RawMessage) { timed(func() { event(entry, typ, raw) }) }
		},
	})
	rg.serveItems()
	p, _ := rg.page("page-slow") // it reads nothing until the end
	rg.read(p, chatA)

	// The first event changes the mark, which is written at once: the worker hangs in that write.
	rec := rg.r.rec(chatA)
	rg.until("the record is written", func() bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		return !rec.dirty
	})
	block.Store(true)
	before, wrote := calls.Load(), writes.Load()
	view := seed.View
	view.Archived = true
	rg.s.Send(map[string]any{"type": "chat", "chat": view})
	rg.until("the worker is in the write", func() bool { return writes.Load() > wrote })
	for i := range events {
		rg.s.Send(map[string]any{"type": "chat_items", "chat": chatA, "version": i, "updates": []any{strings.Repeat("x", 2000)}})
	}
	rg.until("the reader has given every event to its hook", func() bool { return calls.Load() == before+1+events })
	if d := time.Duration(longest.Load()); d > 250*time.Millisecond {
		t.Errorf("a hook took %v", d)
	}
	if v, _ := rg.m.View(rg.entry); v.State != servers.StateConnected {
		t.Errorf("the entry is %s", v.State)
	}
	// Nothing was handed on yet, and what Views gives does not wait for the write.
	p.ExpectNone(quiet)
	if !rg.r.Views()[0].Archived {
		t.Error("Views does not have the change that is being written")
	}

	close(release)
	block.Store(false)
	p.Expect("chat")
	for i := range events {
		if ev := p.Expect("chat_items"); ev["version"] != float64(i) {
			t.Fatalf("event %d has version %v", i, ev["version"])
		}
	}
}

// TestCountsAndRemoved: the counts of an entry, and its removal: the records and their files
// go, the pages are told, the unstarted chats go back to this computer, and the server is sent
// nothing.
func TestCountsAndRemoved(t *testing.T) {
	a, b := seedOf(chatA), seedOf(chatB)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(a.View, b.View), seed: []Record{a, b}})
	rg.serveItems()
	rg.local.unstarted[rg.entry] = []string{"unstarted-1", "unstarted-2"}
	rg.local.unstarted["s_other"] = []string{"unstarted-3"}
	p, _ := rg.page("page-1")
	rg.read(p, chatA)

	if chats, runs := rg.r.Counts(rg.entry); chats != 2 || runs != 0 {
		t.Errorf("Counts: %d, %d", chats, runs) // with runs: TestRunCountsAndRemoved
	}
	if chats, runs := rg.r.Counts("s_other"); chats != 0 || runs != 0 {
		t.Errorf("Counts of another entry: %d, %d", chats, runs)
	}
	if chats, _ := rg.r.Counts(servers.LocalID); chats != 0 {
		t.Errorf("Counts of the local entry: %d", chats)
	}
	if !rg.r.Has(chatA) || !rg.r.Has(chatB) || rg.r.Has("unstarted-1") || len(rg.r.Views()) != 2 {
		t.Error("Has and Views before the removal")
	}
	for _, id := range []string{chatA, chatB} {
		if _, err := os.Stat(rg.r.files.path(id)); err != nil {
			t.Fatal(err)
		}
	}

	sent := len(rg.s.Requests())
	if err := rg.m.Remove(rg.entry); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{chatA, chatB} {
		if ev := p.Expect("chat_removed"); ev["id"] != id {
			t.Errorf("chat_removed: %v, want %s", ev, id)
		}
	}
	ev := p.Expect("server_lists")
	if lists, has := ev["lists"]; ev["server"] != rg.entry || !has || lists != nil {
		t.Errorf("server_lists at a removal: %v", ev)
	}
	rg.until("the unstarted chats are put back", func() bool {
		rg.local.mu.Lock()
		defer rg.local.mu.Unlock()
		return len(rg.local.resets) == 2
	})
	p.ExpectNone(quiet)
	rg.local.mu.Lock()
	if got := rg.local.resets; !reflect.DeepEqual(got, []string{"unstarted-1", "unstarted-2"}) {
		t.Errorf("ResetServer for %v", got)
	}
	rg.local.mu.Unlock()
	if chats, _ := rg.r.Counts(rg.entry); chats != 0 || rg.r.Has(chatA) || rg.r.Has(chatB) || len(rg.r.Views()) != 0 || len(rg.r.States()) != 0 {
		t.Error("records are left after the removal")
	}
	if left, err := os.ReadDir(rg.r.files.dir); err != nil || len(left) != 0 {
		t.Errorf("files left after the removal: %v, %v", left, err)
	}
	if rg.b.Followed(editorbridge.Chat(chatA)) {
		t.Error("a follow of a removed chat is left")
	}
	if got := rg.s.Requests()[sent:]; len(got) != 0 {
		t.Errorf("the removed server was sent %+v", got)
	}
	if _, ok := rg.r.Lists()[rg.entry]; ok {
		t.Error("Lists has the removed entry")
	}
	// No record is made for an entry that left.
	if _, err := rg.r.adopt(seedWith(chatA, rg.entry)); err == nil || rg.r.Has(chatA) {
		t.Errorf("a record was adopted for a removed entry: %v", err)
	}
	rg.r.mu.Lock()
	left := rg.r.left[rg.entry]
	rg.r.mu.Unlock()
	if !left {
		t.Error("the removed entry is not noted")
	}
}

// seedWith is seedOf on an entry.
func seedWith(id, entry string) Record {
	d := seedOf(id)
	d.Entry = entry
	return d
}

// TestAgentsReachPages: AC44. A change of the remote server's usable agents reaches the pages
// as server_lists, and is what the chat manager is told of the entry.
func TestAgentsReachPages(t *testing.T) {
	rg := newRig(t, rigOpt{})
	p, snap := rg.page("page-1")
	if got := field(snap, "lists", rg.entry, "agents"); !reflect.DeepEqual(got, []any{"claude", "pi"}) {
		t.Fatalf("the agents in the page's snapshot: %v", got)
	}
	rg.s.Send(map[string]any{"type": "agents", "agents": []string{"cursor"}})
	ev := p.Expect("server_lists")
	if ev["server"] != rg.entry || !reflect.DeepEqual(field(ev, "lists", "agents"), []any{"cursor"}) {
		t.Errorf("server_lists: %v", ev)
	}
	if got := rg.r.Lists()[rg.entry].Agents; !reflect.DeepEqual(got, []model.AgentKind{model.Cursor}) {
		t.Errorf("Lists: %v", got)
	}
	if e, _ := rg.r.Entry(rg.entry); !reflect.DeepEqual(e.Agents, []model.AgentKind{model.Cursor}) {
		t.Errorf("Entry: %v", e.Agents)
	}
	// None usable: an empty list, not null.
	rg.s.Send(map[string]any{"type": "agents", "agents": []string{}})
	raw := p.NextRaw()
	if !strings.Contains(raw, `"agents":[]`) {
		t.Errorf("server_lists with no agent: %s", raw)
	}
}

// TestEntryAndLists: what the chat manager is told of an entry, by id and by key, and the lists
// by server.
func TestEntryAndLists(t *testing.T) {
	rg := newRig(t, rigOpt{hold: true})
	// Before the first connect: no key, no lists.
	e, ok := rg.r.Entry(rg.entry)
	if !ok || e.ID != rg.entry || e.Name != "Studio" || e.Key != "" || e.Connected || e.Stopped || e.HasLists || e.Agents != nil {
		t.Errorf("Entry before the connect: %+v, %v", e, ok)
	}
	if _, ok := rg.r.ByKey(standin.DefaultInstanceID); ok {
		t.Error("ByKey before the entry's first hello")
	}
	if got := rg.r.Lists(); got == nil || len(got) != 0 {
		t.Errorf("Lists before the connect: %#v", got)
	}

	rg.start()
	rg.state(servers.StateConnected)
	e, ok = rg.r.Entry(rg.entry)
	want := standin.DefaultSnapshot()
	if !ok || e.Key != standin.DefaultInstanceID || !e.Connected || e.Stopped || !e.HasLists ||
		!reflect.DeepEqual(e.Agents, want["agents"]) || e.Home != "/home/standin" || e.DefaultCwd != "/home/standin/work" ||
		e.Catalogs[model.Claude] == nil || e.Catalogs[model.Claude].Default.Model != "standin-model" {
		t.Errorf("Entry when connected: %+v, %v", e, ok)
	}
	byKey, ok := rg.r.ByKey(standin.DefaultInstanceID)
	if !ok || !reflect.DeepEqual(byKey, e) {
		t.Errorf("ByKey: %+v, %v", byKey, ok)
	}
	for _, id := range []string{servers.LocalID, "s_000000000000", ""} {
		if _, ok := rg.r.Entry(id); ok {
			t.Errorf("Entry(%q)", id)
		}
	}
	for _, key := range []string{testLocalID, model.LocalServer, "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f", ""} {
		if _, ok := rg.r.ByKey(key); ok {
			t.Errorf("ByKey(%q)", key)
		}
	}
	lists := rg.r.Lists()
	if l := lists[rg.entry]; len(lists) != 1 || !reflect.DeepEqual(l.Agents, e.Agents) || l.Home != e.Home || l.DefaultCwd != e.DefaultCwd || l.Catalogs[model.Claude] == nil {
		t.Errorf("Lists: %+v", lists)
	}
	b, _ := json.Marshal(lists)
	if strings.Contains(string(b), standin.DefaultSecret) || strings.Contains(strings.ToLower(string(b)), "secret") {
		t.Errorf("the lists on the wire: %s", b)
	}

	// An entry that waits for the user is stopped; its lists stay.
	rg.s.SetSecret("another-secret")
	rg.s.DropStreams()
	rg.state(servers.StateSecretNotAccepted)
	if e, _ := rg.r.Entry(rg.entry); e.Connected || !e.Stopped || !e.HasLists || len(e.Agents) != 2 {
		t.Errorf("Entry with a refused secret: %+v", e)
	}
	if _, ok := rg.r.Lists()[rg.entry]; !ok {
		t.Error("the lists went with the connection")
	}
}

// TestOutageAndReturn: while the server is away its records stay listed with their last view
// and a call answers at once that nothing was sent. The return is the steps of a snapshot.
func TestOutageAndReturn(t *testing.T) {
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}})
	rg.serveItems()
	p, _ := rg.page("page-1")
	rg.read(p, chatA)
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusTool)})
	p.Expect("chat")

	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	if rg.r.connected(rg.entry) {
		t.Error("connected while the server is away")
	}
	sent := len(rg.s.Requests())
	start := time.Now()
	_, err := rg.r.call(context.Background(), rg.entry, http.MethodGet, chatPath(chatA, "/items"), nil, wait)
	if !errors.Is(err, ErrUnreachable) || time.Since(start) > time.Second {
		t.Errorf("a call while the server is away: %v after %v", err, time.Since(start))
	}
	if _, err := rg.r.follow(context.Background(), rg.r.rec(chatA), p.ID, http.MethodGet, chatPath(chatA, "/items"), wait); !errors.Is(err, ErrUnreachable) {
		t.Errorf("a read while the server is away: %v", err)
	}
	if v := rg.r.Views(); len(v) != 1 || v[0].Status != model.StatusTool || v[0].Gone || !rg.r.Has(chatA) {
		t.Errorf("the record while the server is away: %+v", v)
	}
	if chats, _ := rg.r.Counts(rg.entry); chats != 1 {
		t.Errorf("Counts while the server is away: %d", chats)
	}
	p.ExpectNone(quiet) // the relay tells the pages nothing of the outage: server_state is the manager's

	view := remoteView(chatA, model.StatusStopped)
	rg.s.SetSnapshot(snapshotWith(view))
	rg.s.Restart()
	rg.returned(2)
	if got := rg.s.Requests()[sent:]; len(got) == 0 {
		t.Error("the entry did not connect again")
	}
	var evs []map[string]any
	for range 4 {
		evs = append(evs, p.Next())
	}
	if got, want := types(evs), []string{"server_lists", "server_back", "branch_state", "chat"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the events of the return: %v", got)
	}
	if field(evs[3], "chat", "status") != "stopped" || field(evs[2], "state", "status") != "stopped" {
		t.Errorf("the view after the return: %v", evs)
	}
	if rg.b.Followed(editorbridge.Chat(chatA)) {
		t.Error("the page's follow outlived the return")
	}
	rg.state(servers.StateConnected)
	if !rg.r.connected(rg.entry) {
		t.Error("not connected after the return")
	}
	// A content event after the return reaches no page until one reads again.
	rg.s.Send(map[string]any{"type": "chat_items", "chat": chatA, "version": 1, "updates": []any{}})
	if got := rg.barrier(p)[0]; len(got) != 0 {
		t.Errorf("after the return the page got %v", got)
	}
	rg.read(p, chatA)
	rg.s.Send(map[string]any{"type": "chat_items", "chat": chatA, "version": 2, "updates": []any{}})
	p.Expect("chat_items")
}

// TestCall: the three ends of a call that is passed on.
func TestCall(t *testing.T) {
	rg := newRig(t, rigOpt{})
	never := make(chan struct{})
	t.Cleanup(func() { close(never) })
	rg.s.Handle("GET /api/chats/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"no such chat"}`))
	})
	rg.s.Handle("POST /api/chats/{id}/messages", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-never:
		case <-r.Context().Done():
		}
	})
	ctx := context.Background()
	rep, err := rg.r.call(ctx, rg.entry, http.MethodGet, chatPath(chatA, ""), nil, wait)
	if err != nil || rep.Status != http.StatusNotFound || !strings.Contains(string(rep.Body), "no such chat") {
		t.Errorf("an answer of 404: %+v, %v", rep, err)
	}
	start := time.Now()
	_, err = rg.r.call(ctx, rg.entry, http.MethodPost, chatPath(chatA, "/messages"), []byte(`{"text":"hi"}`), 100*time.Millisecond)
	if !errors.Is(err, ErrNoAnswer) || time.Since(start) > 2*time.Second {
		t.Errorf("a call without an answer: %v after %v", err, time.Since(start))
	}
	for _, entry := range []string{"s_000000000000", servers.LocalID} {
		if _, err := rg.r.call(ctx, entry, http.MethodGet, chatPath(chatA, ""), nil, wait); !errors.Is(err, ErrUnreachable) {
			t.Errorf("a call to %s: %v", entry, err)
		}
	}
	// An answer above the size limit was sent and answered: it is no "did not answer".
	rg.s.Handle("GET /api/dirs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(append([]byte(`{"path":"`), bytes.Repeat([]byte("x"), 32<<20)...))
	})
	if _, err := rg.r.call(ctx, rg.entry, http.MethodGet, "/api/dirs", nil, wait); !errors.Is(err, errTooLong) || errors.Is(err, ErrNoAnswer) {
		t.Errorf("a call with an answer that is too long: %v", err)
	}
	rep2 := rg.r.Dirs(ctx, rg.entry, "")
	if rep2.Status != http.StatusBadGateway || !strings.Contains(string(rep2.Body), `"code":"bad_answer"`) {
		t.Errorf("a route with an answer that is too long: %d %s", rep2.Status, rep2.Body)
	}
	if got := chatPath("a/b?c", "/items"); got != "/api/chats/a%2Fb%3Fc/items" {
		t.Errorf("chatPath: %s", got)
	}
	if got := servers.ErrNotConnected.Error(); got != ErrUnreachable.Error() {
		t.Errorf("ErrUnreachable reads %q, the manager's %q", ErrUnreachable, got)
	}
}

// TestStatesAreBounded: the other server names the branches of a chat. A record keeps the state
// of maxStates of them; the state of a further one is dropped, and that is logged once.
func TestStatesAreBounded(t *testing.T) {
	seed := seedOf(chatA)
	for i := 1; i < maxStates; i++ {
		seed.States = append(seed.States, model.BranchState{Chat: chatA, Branch: fmt.Sprintf("b%d", i), Status: model.StatusReady})
	}
	rg := newRig(t, rigOpt{seed: []Record{seed}, hold: true})
	p, _ := rg.page("page-1")
	for _, st := range []model.BranchState{
		{Chat: chatA, Branch: "one-more", Status: model.StatusTool},
		{Chat: chatA, Branch: "and-another", Status: model.StatusTool},
		{Chat: chatA, Branch: "b7", Status: model.StatusThinking}, // a branch the record has
	} {
		raw, _ := json.Marshal(map[string]any{"type": "branch_state", "state": st})
		rg.r.event(rg.entry, "branch_state", raw)
	}
	if ev := p.Expect("branch_state"); field(ev, "state", "branch") != "b7" || field(ev, "state", "status") != "thinking" {
		t.Errorf("the page got %v", ev)
	}
	p.ExpectNone(quiet)
	states := rg.r.States()
	if len(states) != maxStates || states[7].Status != model.StatusThinking {
		t.Errorf("%d states, and that of b7 is %q", len(states), states[7].Status)
	}
	for _, st := range states {
		if st.Branch == "one-more" || st.Branch == "and-another" {
			t.Errorf("a state above the bound was kept: %+v", st)
		}
	}
	if n := rg.logs.count("branch states"); n != 1 {
		t.Errorf("%d log lines for the dropped states, want 1: %v", n, rg.logs.all())
	}

	// A snapshot's states of one chat are bounded the same way.
	snap := snapshot{}
	for i := range maxStates + 5 {
		snap.States = append(snap.States, model.BranchState{Chat: chatA, Branch: fmt.Sprintf("s%d", i)})
	}
	if got := snap.states(chatA, seed.View); len(got) != maxStates || got[0].Branch != "s0" {
		t.Errorf("%d states of a snapshot", len(got))
	}
}

// TestTake: an answer and an event of one chat can cross. A view that was read is taken only
// if no view of the chat was taken since the read was sent.
func TestTake(t *testing.T) {
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}})
	rec := rg.r.rec(chatA)
	take := func(since uint64, status model.Status) bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		taken, durable := rec.take(since, remoteView(chatA, status))
		if taken {
			rg.r.keep(rec, durable)
		}
		return taken
	}
	status := func() model.Status { return rg.r.Views()[0].Status }

	// The event came while the read was out: the read's older view is not taken.
	sent := rec.stamp()
	raw, _ := json.Marshal(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusApproval)})
	rg.r.event(rg.entry, "chat", raw)
	if take(sent, model.StatusThinking) || status() != model.StatusApproval {
		t.Errorf("an answer older than an event was taken: %s", status())
	}
	// No event since: the answer is taken, and a second answer of the same moment is not.
	sent = rec.stamp()
	if !take(sent, model.StatusWriting) || status() != model.StatusWriting {
		t.Errorf("an answer with no event since was not taken: %s", status())
	}
	if take(sent, model.StatusTool) || status() != model.StatusWriting {
		t.Errorf("a second answer of the same moment was taken: %s", status())
	}
	// The state of a branch counts as a view taken: the answer may be older than it.
	sent = rec.stamp()
	raw, _ = json.Marshal(map[string]any{"type": "branch_state", "state": model.BranchState{Chat: chatA, Branch: mainBranch, Status: model.StatusTool}})
	rg.r.event(rg.entry, "branch_state", raw)
	if take(sent, model.StatusReady) || status() != model.StatusWriting || rg.r.States()[0].Status != model.StatusTool {
		t.Errorf("an answer older than a branch's state was taken: %s, state %s", status(), rg.r.States()[0].Status)
	}
	// A removal on the server and a snapshot count as a view taken.
	sent = rec.stamp()
	raw, _ = json.Marshal(map[string]any{"type": "chat_removed", "id": chatA})
	rg.r.event(rg.entry, "chat_removed", raw)
	if take(sent, model.StatusReady) || !rg.r.Views()[0].Gone {
		t.Error("an answer older than the chat's removal was taken")
	}
	sent = rec.stamp()
	snap, _ := json.Marshal(snapshotWith(remoteView(chatA, model.StatusStopped)))
	rg.r.snapshot(rg.entry, snap)
	if take(sent, model.StatusReady) || status() != model.StatusStopped {
		t.Errorf("an answer older than a snapshot was taken: %s", status())
	}
	// A record that was dropped takes nothing.
	sent = rec.stamp()
	rec.mu.Lock()
	rg.r.drop(rec)
	rec.mu.Unlock()
	if take(sent, model.StatusReady) || rg.r.Has(chatA) {
		t.Error("a dropped record took a view")
	}
}

// TestSnapshotThatCannotBeRead: a snapshot whose chats are no list marks no record gone, and
// the rest of the return goes on.
func TestSnapshotThatCannotBeRead(t *testing.T) {
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}})
	p, _ := rg.page("page-1")
	rg.r.snapshot(rg.entry, json.RawMessage(`{"agents":[],"chats":"none"}`))
	var evs []map[string]any
	for range 4 {
		evs = append(evs, p.Next())
	}
	if got, want := types(evs), []string{"server_lists", "server_back", "branch_state", "chat"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the events: %v", got)
	}
	if field(evs[3], "chat", "gone") != nil || rg.r.Views()[0].Gone {
		t.Errorf("the record was marked from a snapshot that cannot be read: %v", evs[3])
	}
	if rg.logs.count("cannot be read") != 1 {
		t.Errorf("the log: %v", rg.logs.all())
	}
}

// TestClose: after Close no hook does anything, no goroutine starts, and a second Close is safe.
func TestClose(t *testing.T) {
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}})
	p, _ := rg.page("page-1")
	rg.r.Close()
	rg.r.Close()
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusThinking)})
	rg.s.Send(map[string]any{"type": "agents", "agents": []string{"pi"}})
	p.ExpectNone(quiet)
	if rg.r.spawn(func() { t.Error("a goroutine started after Close") }) {
		t.Error("spawn after Close")
	}
	rg.r.Unfollowed([]editorbridge.Item{editorbridge.Chat(chatA)})
	time.Sleep(50 * time.Millisecond)
	if got := rg.requests("POST", "/unfollow"); len(got) != 0 {
		t.Errorf("unfollow calls after Close: %+v", got)
	}
	if v := rg.r.Views(); len(v) != 1 || v[0].Status != model.StatusReady {
		t.Errorf("Views after Close: %+v", v)
	}
}

// TestOpenNeedsItsParts: Open refuses to run without the server list or the bridge, so that no
// record is taken for one of an unknown entry.
func TestOpenNeedsItsParts(t *testing.T) {
	if _, err := Open(Options{Root: t.TempDir()}); err == nil {
		t.Error("Open without a server list and a bridge")
	}
	l := Limits{Call: time.Second}.withDefaults()
	want := DefaultLimits
	want.Call = time.Second
	if l != want {
		t.Errorf("the limits with their defaults: %+v", l)
	}
	if DefaultLimits != (Limits{Call: 15 * time.Second, Start: 45 * time.Second, Settle: 15 * time.Second,
		Dirs: 10 * time.Second, Usage: 30 * time.Second, Unfollow: 5 * time.Second, Flush: 2 * time.Second,
		Check: 5 * time.Second, RunDelete: 3 * time.Minute}) {
		t.Errorf("DefaultLimits: %+v", DefaultLimits)
	}
}
