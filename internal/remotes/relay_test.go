package remotes

import (
	"encoding/json"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// TestHooksDoNotBlock: a hook only queues. While the relay's worker cannot go on, the reader of
// the entry's stream still gives every event to its hook at once, the entry stays connected,
// and the pages get the events in order once the worker goes on.
func TestHooksDoNotBlock(t *testing.T) {
	t.Parallel()
	const events = 300
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
	rg := newRig(t, rigOpt{
		snapshot: snapshotOf(fullTree()),
		hooks: func(h *servers.Hooks) {
			snapshot, event := h.Snapshot, h.Event
			h.Snapshot = func(entry string, raw json.RawMessage) { timed(func() { snapshot(entry, raw) }) }
			h.Event = func(entry, typ string, raw json.RawMessage) { timed(func() { event(entry, typ, raw) }) }
		},
	})
	rg.serveReads()
	p, _ := rg.page("page-slow") // it reads nothing until the end
	rg.readChat(p, chatA)

	// The worker needs the relay's lock for the first event, and waits for it.
	rg.r.mu.Lock()
	before := calls.Load()
	rg.s.Send(map[string]any{"type": "chat", "chat": farChat(chatA, model.StatusThinking)})
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
	p.ExpectNone(quiet) // nothing was handed on yet
	rg.r.mu.Unlock()

	p.Expect("chat")
	for i := range events {
		if ev := p.Expect("chat_items"); ev["version"] != float64(i) || ev["server"] != rg.entry {
			t.Fatalf("event %d: version %v of %v", i, ev["version"], ev["server"])
		}
	}
}

// TestAgentsReachPages: a change of what a server offers for a new chat reaches the pages as
// that entry's lists.
func TestAgentsReachPages(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{})
	p, snap := rg.page("page-1")
	if got := field(snap, "lists", rg.entry, "agents"); !reflect.DeepEqual(got, []any{"claude", "pi"}) {
		t.Fatalf("the agents in the page's snapshot: %v", got)
	}
	if got := field(snap, "lists", rg.entry, "home"); got != "/home/standin" {
		t.Errorf("the home folder in the page's snapshot: %v", got)
	}
	rg.s.Send(map[string]any{"type": "agents", "agents": []string{"cursor"}})
	ev := p.Expect("server_lists")
	if ev["server"] != rg.entry || !reflect.DeepEqual(field(ev, "lists", "agents"), []any{"cursor"}) {
		t.Errorf("server_lists: %v", ev)
	}
	if got := rg.r.Lists()[rg.entry].Agents; !reflect.DeepEqual(got, []model.AgentKind{model.Cursor}) {
		t.Errorf("Lists: %v", got)
	}
	// None usable: an empty list, not null.
	rg.s.Send(map[string]any{"type": "agents", "agents": []string{}})
	if raw := p.NextRaw(); !strings.Contains(raw, `"agents":[]`) {
		t.Errorf("server_lists with no agent: %s", raw)
	}
	// The lists stay while the entry is not connected, and its tree does not.
	rg.offline()
	if _, ok := rg.r.Lists()[rg.entry]; !ok {
		t.Error("the lists went with the connection")
	}
	if _, ok := rg.treeOf(); ok {
		t.Error("the tree stayed without the connection")
	}
}

// TestListsBeforeTheFirstConnect: an entry that has not connected has no lists.
func TestListsBeforeTheFirstConnect(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{hold: true})
	if got := rg.r.Lists(); got == nil || len(got) != 0 {
		t.Errorf("the lists before the first connect: %v", got)
	}
	if got := rg.r.Sections(); got == nil || len(got) != 0 {
		t.Errorf("the sections before the first connect: %v", got)
	}
}

// TestClose: after Close nothing is taken from a hook, nothing is sent and no call is made.
func TestClose(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{snapshot: snapshotOf(fullTree())})
	p, _ := rg.page("page-1")
	rg.r.Close()
	rg.r.Close()
	rg.s.Send(map[string]any{"type": "chat", "chat": farChat(chatA, model.StatusThinking)})
	rg.s.Send(map[string]any{"type": "agents", "agents": []string{"pi"}})
	p.ExpectNone(quiet)
	if rg.r.spawn(func() { t.Error("a goroutine started after Close") }) {
		t.Error("spawn after Close")
	}
	rg.r.Unfollowed([]editorbridge.Item{editorbridge.ChatOn(rg.entry, chatA)})
	time.Sleep(50 * time.Millisecond)
	if got := rg.requests("POST", "/unfollow"); len(got) != 0 {
		t.Errorf("unfollow calls after Close: %+v", got)
	}
	if held, _ := rg.treeOf(); len(held.Chats) != 2 || held.Chats[0].Status != model.StatusReady {
		t.Errorf("the tree after Close: %s", mustJSON(t, held))
	}
}

// TestOpenNeedsItsParts: Open refuses to run without the server list or the bridge. The limits
// outside the tests are the ones the pages were promised.
func TestOpenNeedsItsParts(t *testing.T) {
	t.Parallel()
	if _, err := Open(Options{}); err == nil {
		t.Error("Open without a server list and a bridge")
	}
	l := Limits{Call: time.Second}.withDefaults()
	want := DefaultLimits
	want.Call = time.Second
	if l != want {
		t.Errorf("the limits with their defaults: %+v", l)
	}
	if DefaultLimits != (Limits{Call: 15 * time.Second, Start: 45 * time.Second,
		Dirs: 10 * time.Second, Usage: 30 * time.Second, Unfollow: 5 * time.Second,
		Delete:    3 * time.Minute,
		BoardCall: 25 * time.Second, Scene: 60 * time.Second,
		Image: 60 * time.Second}) {
		t.Errorf("DefaultLimits: %+v", DefaultLimits)
	}
	rg := newRig(t, rigOpt{limits: Limits{Scene: time.Second}, hold: true})
	if got := rg.r.Limits(); got.Scene != time.Second || got.Call != DefaultLimits.Call || got.Delete != DefaultLimits.Delete {
		t.Errorf("Limits: %+v", got)
	}
}
