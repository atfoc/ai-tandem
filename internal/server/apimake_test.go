package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/testset"
)

// What an API client does with a chat before its first message: the settings, the draft with its
// counter, and then the first message as an ordinary Send. On the real remote listener, beside a
// page of the server's own.

// The make (PUT /api/chats/{id}) left at level 5: its route is named here for the tests that
// show it gone.
const (
	makeRoute  = "PUT /api/chats/{id}"
	draftRoute = "PUT /api/chats/{id}/draft"
)

// saved is the answer of a draft call.
type saved struct {
	OK    bool         `json:"ok"`
	Rev   int64        `json:"rev"`
	Error string       `json:"error"`
	Code  string       `json:"code"`
	Draft *model.Draft `json:"draft"`
}

// draft is a draft call of the client c: query is what follows "draft?".
func draft(t *testing.T, c *bridgetest.Page, want int, id, query, text string) saved {
	t.Helper()
	status, out := c.Do("PUT", "/api/chats/"+id+"/draft?"+query, map[string]any{"text": text})
	if status != want {
		t.Fatalf("PUT draft?%s of %s by %s: status %d, want %d (%s)", query, id, c.ID, status, want, out)
	}
	return decode[saved](t, string(out))
}

// draftOf is the text of a draft; "" for none.
func draftOf(d *model.Draft) string {
	if d == nil {
		return ""
	}
	return d.Text
}

// draftEvents is the draft and the counter each chat and branch_state event of the chat id says,
// in the order sent: "chat <text> <counter>".
func draftEvents(t *testing.T, evs []string, id string) (out []string) {
	t.Helper()
	for _, raw := range only(evs, "chat", "branch_state") {
		ev := decode[struct {
			Type  string
			Chat  json.RawMessage
			State *model.BranchState
		}](t, raw)
		switch {
		case ev.Type == "branch_state" && ev.State != nil && ev.State.Chat == id:
			out = append(out, fmt.Sprintf("branch_state %q %d", draftOf(ev.State.Draft), ev.State.DraftRev))
		case ev.Type == "chat":
			if v := decode[model.ChatView](t, string(ev.Chat)); v.ID == id {
				out = append(out, fmt.Sprintf("chat %q %d", draftOf(v.Draft), v.DraftRev))
			}
		}
	}
	return out
}

// The life of an unstarted chat of an API client: its settings are changed as a page changes
// those of a chat of its own, and are what the next chat in its group starts with, whoever makes
// it. Its draft is saved with the counter, the events and the snapshot give every client the
// draft and the counter, and its first message is an ordinary Send that starts the agent,
// removes the draft and raises the counter.
func TestUnstartedChatOfAnAPIClient(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	p := e.page("P")
	cwd2 := t.TempDir()
	gone := filepath.Join(t.TempDir(), "gone")
	mine := decode[model.Group](t, e.expect(200, "POST", "/api/groups", `{"name":"Mine"}`))
	unstartedBy(t, x, chat1, "group", mine.ID)
	path := "/api/chats/" + chat1
	// defaultsNow is the defaults in the server's own state, as sent.
	defaultsNow := func() string {
		t.Helper()
		d := decode[struct{ Defaults json.RawMessage }](t, e.expect(200, "GET", "/api/state", "")).Defaults
		if len(d) == 0 {
			t.Fatal("the server's state has no defaults")
		}
		return string(d)
	}
	defaults := defaultsNow()
	e.reach(x, y, p)

	// The settings: agent, model, effort, folder, subagent settings and name.
	set := decode[patched](t, string(do(t, x, "PATCH", path, obj{"agent": "cursor", "cwd": cwd2, "subDepth": 3, "subCap": 9, "name": "named there"})))
	if v := set.Chat; !set.OK || v.Agent != model.Cursor || v.Cwd != cwd2 || v.SubDepth != 3 || v.SubCap != 9 || v.Name != "named there" || !v.UserNamed || v.Locked {
		t.Fatalf("the settings of the unstarted chat: %+v", set)
	}
	set = decode[patched](t, string(do(t, x, "PATCH", path+"?branch=main", obj{"agent": "claude", "model": "opus", "effort": "low", "subDepth": 0})))
	if v := set.Chat; v.Agent != model.Claude || v.Model != "opus" || v.Effort != "low" || !v.SubOff || v.SubCap != 9 || v.Cwd != cwd2 {
		t.Fatalf("the agent, model and effort of the unstarted chat: %+v", set.Chat)
	}
	// What a page's change is refused for, an API client's is too, and one thing more: a server.
	for what, r := range map[string]struct {
		status int
		code   string
		body   obj
	}{
		"a folder that is not there": {400, "folder_missing", obj{"cwd": gone}},
		"a model the catalog lacks":  {400, "", obj{"model": "no-such-model"}},
		"a depth outside the range":  {400, "", obj{"subDepth": 4}},
		"a cap outside the range":    {400, "", obj{"subCap": 101}},
		"an agent nobody knows":      {400, "", obj{"agent": "nobody"}},
		"a group that is not there":  {400, "", obj{"group": "g_nowhere1"}},
		"a server":                   {400, "server_refused", obj{"name": "renamed", "server": "local"}},
		"the server's own id":        {400, "server_refused", obj{"name": "renamed", "model": "sonnet", "server": ownID}},
	} {
		if got := decode[refusal](t, string(mustStatus(t, x, r.status, "PATCH", path, r.body))); got.Code != r.code || got.Error == "" {
			t.Fatalf("a change with %s: %+v, want the code %q", what, got, r.code)
		}
	}
	if v, _ := e.a.Chats.View(chat1); !sameView(v, set.Chat) {
		t.Fatalf("the refused changes changed the chat: %+v, was %+v", v, set.Chat)
	}
	// Everyone is told of the settings, and of what the server now remembers for the group: an
	// API client's choices are defaults of this server as a page's are.
	evs := e.reach(x, y, p)
	for i, c := range []*bridgetest.Page{x, y, p} {
		if count(evs[i], "chat", chat1, `"model":"opus"`) == 0 || count(evs[i], "branch_state", chat1) == 0 || count(evs[i], "defaults", mine.ID, cwd2) == 0 {
			t.Errorf("after the settings %s was sent %v", c.ID, types(evs[i]))
		}
		if i < 2 {
			apiOnly(t, c, evs[i])
		}
	}
	if now := defaultsNow(); now == defaults || !strings.Contains(now, cwd2) {
		t.Fatalf("the server's defaults after the settings:\n%s\nwere\n%s", now, defaults)
	}
	// The next chat in the group starts with them, whoever makes it and whatever it names: here
	// another client, and no agent.
	if next := unstartedBy(t, y, chat2, "group", mine.ID, "agent", nil); next.Agent != model.Claude || next.Cwd != cwd2 || next.Model != "opus" || next.Effort != "low" ||
		!next.SubOff || next.SubCap != 9 {
		t.Fatalf("the next chat in the group: %+v", next)
	}
	// A client puts the chat into another place of the tree, as a page does.
	if got := decode[patched](t, string(do(t, x, "PATCH", path, obj{"group": model.Ungrouped}))); got.Chat.Group != model.Ungrouped {
		t.Fatalf("the chat's move out of its group: %+v", got.Chat)
	}
	if got := decode[patched](t, string(do(t, y, "PATCH", path, obj{"group": mine.ID}))); got.Chat.Group != mine.ID {
		t.Fatalf("the chat's move back, by another client: %+v", got.Chat)
	}
	e.reach(x, y, p)

	// The draft: saved on the counter it was typed on, refused as stale on another.
	if got := draft(t, x, 200, chat1, "rev=0", "typed afar"); !got.OK || got.Rev != 1 {
		t.Fatalf("the first save: %+v", got)
	}
	if got := draft(t, x, 200, chat1, "rev=1&branch=main", "typed afar, more"); got.Rev != 2 {
		t.Fatalf("the second save: %+v", got)
	}
	for _, base := range []string{"0", "1", "3"} {
		if got := draft(t, x, 409, chat1, "rev="+base, "late"); got.Code != "stale" || got.Rev != 2 || draftOf(got.Draft) != "typed afar, more" || got.Error == "" {
			t.Fatalf("a save on %s: %+v", base, got)
		}
	}
	for what, r := range map[string]struct {
		status      int
		code, query string
	}{
		"no counter":                  {400, "", "branch=main"},
		"a counter that is no number": {400, "", "rev=x"},
		"a counter below zero":        {400, "", "rev=-1"},
		"a branch the chat lacks":     {404, "no_branch", "rev=2&branch=b_nowhere"},
		"a replace":                   {400, "replace_refused", "replace=2"},
		"a replace beside a counter":  {400, "replace_refused", "rev=2&replace=2"},
	} {
		if got := draft(t, x, r.status, chat1, r.query, "x"); got.Code != r.code || got.Error == "" {
			t.Fatalf("a draft call with %s: %+v", what, got)
		}
	}
	if got := draft(t, x, 404, chat3, "rev=0", "x"); got.Code != "not_found" || got.Error != chats.ErrNotFound.Error() {
		t.Fatalf("a save in a chat that is not there: %+v", got)
	}
	// The events give every client the draft and the counter of the unstarted chat, and so do
	// the snapshot, the read of the chat and the read of its thread. The page gets the same events.
	evs = e.reach(x, y, p)
	want := []string{`branch_state "typed afar" 1`, `chat "typed afar" 1`, `branch_state "typed afar, more" 2`, `chat "typed afar, more" 2`}
	for i, c := range []*bridgetest.Page{x, y, p} {
		if got := draftEvents(t, evs[i], chat1); !equal(got, want) {
			t.Errorf("the draft events of %s: %q, want %q", c.ID, got, want)
		}
	}
	shown := func(when, text string, rev int64, locked bool) {
		t.Helper()
		snap := decode[struct {
			Chats  []model.ChatView
			States []model.BranchState
		}](t, string(do(t, y, "GET", "/api/state", nil)))
		ci := slices.IndexFunc(snap.Chats, func(v model.ChatView) bool { return v.ID == chat1 })
		si := slices.IndexFunc(snap.States, func(st model.BranchState) bool { return st.Chat == chat1 })
		if ci < 0 || si < 0 || len(snap.Chats) != 2 || len(snap.States) != 2 {
			t.Fatalf("%s: the snapshot of Y has %d chats and %d state records", when, len(snap.Chats), len(snap.States))
		}
		v, st := snap.Chats[ci], snap.States[si]
		read := decode[model.ChatView](t, string(do(t, x, "GET", path, nil)))
		thread := decode[struct{ State model.BranchState }](t, string(do(t, x, "GET", path+"/items", nil)))
		for what, got := range map[string]struct {
			draft  *model.Draft
			rev    int64
			locked bool
		}{
			"the snapshot's chat":         {v.Draft, v.DraftRev, v.Locked},
			"the snapshot's state record": {st.Draft, st.DraftRev, st.Locked},
			"the read of the chat":        {read.Draft, read.DraftRev, read.Locked},
			"the read of the thread":      {thread.State.Draft, thread.State.DraftRev, thread.State.Locked},
		} {
			if draftOf(got.draft) != text || got.rev != rev || got.locked != locked {
				t.Fatalf("%s: %s has %q on %d, started %v; want %q on %d, started %v", when, what, draftOf(got.draft), got.rev, got.locked, text, rev, locked)
			}
		}
		if v.HasDraft != (text != "") {
			t.Fatalf("%s: hasDraft is %v", when, v.HasDraft)
		}
	}
	shown("after the saves", "typed afar, more", 2, false)
	// The stream of a client that connects now starts with them too.
	_, snap := l.api(apiX)
	if !strings.Contains(snap, `"draft":{"text":"typed afar, more"}`) || strings.Count(snap, `"draftRev":2`) != 2 {
		t.Fatalf("the snapshot a new stream of X starts with: %s", snap)
	}
	x, _ = l.api(apiX) // the one that reads from here on
	e.reach(x, y, p)

	// The first message: an ordinary Send. The agent starts here, with the chat's values.
	if got := decode[obj](t, string(do(t, x, "POST", path+"/messages", obj{"text": "typed afar, more"}))); got["ok"] != true || got["branch"] != "main" {
		t.Fatalf("the first message: %v", got)
	}
	a := sp.of(t, chat1)
	if sp.count() != 1 || a.sends.Load() != 1 || sp.opts[0].Cwd != cwd2 || sp.opts[0].Model != "opus" {
		t.Fatalf("%d programs, %d messages, options %+v", sp.count(), a.sends.Load(), sp.opts[0])
	}
	shown("after the first message", "", 3, true)
	evs = e.reach(x, y, p)
	for i, c := range []*bridgetest.Page{x, y, p} {
		got := draftEvents(t, evs[i], chat1)
		if len(got) == 0 || got[len(got)-1] != `chat "" 3` || count(evs[i], "chat", chat1, `"locked":true`) == 0 {
			t.Errorf("after the first message %s was sent %q", c.ID, got)
		}
	}
	// The save of the text that was just sent, still on its way, is stale and brings nothing back.
	if got := draft(t, x, 409, chat1, "rev=2", "typed afar, more"); got.Code != "stale" || got.Rev != 3 || got.Draft != nil {
		t.Fatalf("the late save of the sent text: %+v", got)
	}
	// From here the settings a first message fixes are refused, as for a page.
	for what, body := range map[string]obj{"the agent": {"agent": "cursor"}, "the model": {"model": "sonnet"}, "the subagent settings": {"subDepth": 1}} {
		if status, out := x.Do("PATCH", path, body); status != 409 {
			t.Errorf("%s of the started chat: %d %s", what, status, out)
		}
	}
	// A next message is typed and saved as before.
	if got := draft(t, x, 200, chat1, "rev=3", "the next one"); got.Rev != 4 {
		t.Fatalf("a save in the started chat: %+v", got)
	}
	shown("in the started chat", "the next one", 4, true)
}

// A draft is saved on the counter it was typed on, and nothing replaces one whatever its counter
// is: a draft call with ?replace= is refused on both listeners, for a chat a client made, for the
// owner's and for one that is not there, and nothing is stored.
func TestDraftReplaceIsRefusedOnBothListeners(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	x, _ := l.api(apiX)
	p := e.page("P")
	unstartedBy(t, x, chat1)
	owner := e.chat(`{"agent":"claude","group":"` + model.Ungrouped + `"}`)
	// Each chat has a draft, typed on the other listener.
	if got := draft(t, p, 200, chat1, "rev=0", "typed on this server"); got.Rev != 1 {
		t.Fatalf("the page's save: %+v", got)
	}
	if got := draft(t, x, 200, owner.ID, "rev=0", "typed afar"); got.Rev != 1 {
		t.Fatalf("the client's save: %+v", got)
	}
	e.reach(x, p)

	const want = `{"code":"replace_refused","error":"a draft is not replaced: save it on the counter it was typed on"}`
	for _, c := range []*bridgetest.Page{x, p} {
		for _, id := range []string{chat1, owner.ID, chat3} {
			for _, query := range []string{"replace=5", "replace=1", "replace=0", "replace=5&rev=1", "rev=1&replace=5", "replace=5&branch=main",
				"replace=5&branch=b_nowhere", "replace=", "replace", "replace=x", "replace=-1"} {
				status, out := c.Do("PUT", "/api/chats/"+id+"/draft?"+query, obj{"text": "replaced"})
				if status != 400 || strings.TrimSpace(string(out)) != want {
					t.Fatalf("a draft call with ?%s for %s by %s: %d %s, want 400 %s", query, id, c.ID, status, out, want)
				}
			}
		}
	}
	// Nothing is stored and nobody is told: each draft is what it was, on its counter, and the
	// chat that is not there was not made.
	for id, text := range map[string]string{chat1: "typed on this server", owner.ID: "typed afar"} {
		if v, err := e.a.Chats.View(id); err != nil || draftOf(v.Draft) != text || v.DraftRev != 1 {
			t.Fatalf("the refused replaces changed the draft of %s: %+v on %d, %v", id, v.Draft, v.DraftRev, err)
		}
	}
	if _, err := e.a.Chats.View(chat3); !errors.Is(err, chats.ErrNotFound) {
		t.Fatalf("the chat the refused replaces named: %v", err)
	}
	if evs := e.reach(x, p); len(evs[0])+len(evs[1]) != 0 {
		t.Errorf("the refused replaces sent %v", evs)
	}
	// The save on the counter goes on, for both.
	if got := draft(t, x, 200, chat1, "rev=1", "typed on this server, and afar"); got.Rev != 2 {
		t.Fatalf("the client's save on the counter: %+v", got)
	}
	if got := draft(t, p, 200, owner.ID, "rev=1", "typed afar, and here"); got.Rev != 2 {
		t.Fatalf("the page's save on the counter: %+v", got)
	}
	if sp.count() != 0 {
		t.Fatalf("%d programs started", sp.count())
	}
}

// A draft is stored and handed on as it came: its text, its mentions and its quotes reach the
// other client, in an answer, an event and a snapshot, as the JSON that was saved. A draft of
// quotes alone is a draft.
func TestDraftIsHandedOnAsItCame(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t, withAgents(&apiSpawner{}))
	x, _ := l.api(apiX)
	p := e.page("P")
	unstartedBy(t, x, chat1)
	e.reach(x, p)
	path := "/api/chats/" + chat1
	const typed = `{"text":"see @Plan and this","mentions":[{"name":"Plan","id":"b_aaaa1111"}],` +
		`"references":[{"quote":"a quote","comment":"why","item":0,"start":3,"end":10}]}`
	const quotes = `{"text":"","references":[{"quote":"alone","item":2,"start":0,"end":5}]}`
	same := func(what, want string, got json.RawMessage) {
		t.Helper()
		var a, b any
		if json.Unmarshal([]byte(want), &a) != nil || json.Unmarshal(got, &b) != nil || !reflect.DeepEqual(a, b) {
			t.Fatalf("%s: the draft %s, want %s", what, got, want)
		}
	}
	// holder is whatever holds a draft: a view, a state record, the answer to a stale save.
	type holder struct{ Draft json.RawMessage }
	for i, tc := range []struct{ query, body string }{{"rev=0", typed}, {"rev=1", quotes}} {
		do(t, x, "PUT", path+"/draft?"+tc.query, tc.body)
		what := fmt.Sprintf("after the client's call %d", i)
		// The page of the chat's own server: its events, its read, and the answer to its stale save.
		for _, raw := range only(e.reach(x, p)[1], "chat", "branch_state") {
			if typeOf(raw) == "chat" {
				same(what+", the page's chat event", tc.body, decode[struct{ Chat holder }](t, raw).Chat.Draft)
			} else {
				same(what+", the page's branch_state event", tc.body, decode[struct{ State holder }](t, raw).State.Draft)
			}
		}
		same(what+", the page's read", tc.body, decode[holder](t, e.expect(200, "GET", path, "")).Draft)
		same(what+", the page's stale save", tc.body, decode[holder](t, string(mustStatus(t, p, 409, "PUT", path+"/draft?rev=99", `{"text":"x"}`))).Draft)
		// The client: its snapshot and its read of the thread.
		snap := decode[struct {
			Chats  []holder
			States []holder
		}](t, string(do(t, x, "GET", "/api/state", nil)))
		same(what+", the client's snapshot", tc.body, snap.Chats[0].Draft)
		same(what+", the client's state record", tc.body, snap.States[0].Draft)
		same(what+", the client's read of the thread", tc.body, decode[struct{ State holder }](t, string(do(t, x, "GET", path+"/items", nil))).State.Draft)
	}
}

// Two clients in one draft: a page of the chat's own server and an API client (the page behind
// another server) save into the same draft. The counter decides: a save on an old counter is
// refused and told the draft that is there, so neither replaces what the other typed without
// being told.
func TestTwoClientsInOneDraft(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	x, _ := l.api(apiX)
	p := e.page("P")
	unstartedBy(t, x, chat1)
	e.reach(x, p)

	// The page types first; the client, which was shown no draft yet, is refused and told it.
	if got := draft(t, p, 200, chat1, "rev=0", "the page's"); got.Rev != 1 {
		t.Fatalf("the page's save: %+v", got)
	}
	if got := draft(t, x, 409, chat1, "rev=0", "the client's"); got.Code != "stale" || got.Rev != 1 || draftOf(got.Draft) != "the page's" {
		t.Fatalf("the client's save on the counter before: %+v", got)
	}
	// Its events brought it the page's draft with the counter: it types on that, and now the
	// page's next save is the stale one.
	evs := e.reach(x, p)
	if got, want := draftEvents(t, evs[0], chat1), []string{`branch_state "the page's" 1`, `chat "the page's" 1`}; !equal(got, want) {
		t.Fatalf("the client was sent %q, want %q", got, want)
	}
	if got := draft(t, x, 200, chat1, "rev=1", "the page's, and the client's"); got.Rev != 2 {
		t.Fatalf("the client's save on the page's counter: %+v", got)
	}
	if got := draft(t, p, 409, chat1, "rev=1", "the page's, more"); got.Code != "stale" || got.Rev != 2 || draftOf(got.Draft) != "the page's, and the client's" {
		t.Fatalf("the page's save on the counter before: %+v", got)
	}
	evs = e.reach(x, p)
	if got, want := draftEvents(t, evs[1], chat1), []string{`branch_state "the page's, and the client's" 2`, `chat "the page's, and the client's" 2`}; !equal(got, want) {
		t.Fatalf("the page was sent %q, want %q", got, want)
	}

	// Both save on the same counter at once: one is stored, and the other is refused with the
	// stored one's text and counter. Never both, never neither, never a mix.
	rounds := 10
	if testset.Full() {
		rounds = 100
	}
	rev := int64(2)
	for round := 0; round < rounds; round++ {
		texts := [2]string{fmt.Sprintf("the page's %d", round), fmt.Sprintf("the client's %d", round)}
		var got [2]saved
		var status [2]int
		var wg sync.WaitGroup
		for i, c := range []*bridgetest.Page{p, x} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				var out []byte
				status[i], out = c.Do("PUT", fmt.Sprintf("/api/chats/%s/draft?rev=%d", chat1, rev), obj{"text": texts[i]})
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
			t.Fatalf("round %d: the page got %d %+v, the client %d %+v", round, status[0], got[0], status[1], got[1])
		}
		rev++
		if v, _ := e.a.Chats.View(chat1); draftOf(v.Draft) != texts[won] || v.DraftRev != rev {
			t.Fatalf("round %d: stored %q on %d, want %q on %d", round, draftOf(v.Draft), v.DraftRev, texts[won], rev)
		}
	}
	// Each was told of every change, in the order they were stored: the last event has what is
	// stored, and no counter came twice or went down.
	last, _ := e.a.Chats.View(chat1)
	for i, evs := range e.reach(x, p) {
		var before int64
		told := draftEvents(t, evs, chat1)
		for _, line := range told {
			var kind, text string
			var n int64
			if _, err := fmt.Sscanf(line, "%s %q %d", &kind, &text, &n); err != nil || n < before {
				t.Fatalf("client %d: the counter went down, or %q: %q", i, line, told)
			}
			before = n
		}
		if want := fmt.Sprintf("chat %q %d", draftOf(last.Draft), last.DraftRev); len(told) != 2*rounds || told[len(told)-1] != want {
			t.Fatalf("client %d was sent %d draft events, the last %q; want %d, the last %q", i, len(told), told[len(told)-1], 2*rounds, want)
		}
	}
	// The first message, by either, takes the draft away for both, with a higher counter.
	do(t, p, "POST", "/api/chats/"+chat1+"/messages", obj{"text": draftOf(last.Draft)})
	if got := draft(t, x, 409, chat1, fmt.Sprintf("rev=%d", rev), "typed while it was sent"); got.Code != "stale" || got.Rev != rev+1 || got.Draft != nil {
		t.Fatalf("the client's save on the counter of the sent draft: %+v", got)
	}
	if got := draft(t, x, 200, chat1, fmt.Sprintf("rev=%d", rev+1), "typed while it was sent"); got.Rev != rev+2 {
		t.Fatalf("the client's save after the message: %+v", got)
	}
	if sp.count() != 1 {
		t.Fatalf("%d programs started", sp.count())
	}
}

// mustStatus is a call of the client that must be answered with this status.
func mustStatus(t *testing.T, c *bridgetest.Page, want int, method, path string, body any) []byte {
	t.Helper()
	status, out := c.Do(method, path, body)
	if status != want {
		t.Fatalf("%s %s by %s: %d %s, want %d", method, path, c.ID, status, out, want)
	}
	return out
}

// sameView says whether two views of a chat are the same as a client gets them, which is as JSON:
// a view that was read from an answer has lost what a time holds beside its date.
func sameView(a, b model.ChatView) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// equal says whether two lists of lines are the same.
func equal(a, b []string) bool {
	return strings.Join(a, "\n") == strings.Join(b, "\n") && len(a) == len(b)
}
