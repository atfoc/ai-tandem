package server

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
)

// Several clients and the owner in one thing, with both halves real (goal 3.6; contract 2.7): a
// chat that the owner's page and a page of each client have open, a board that one window holds
// at a time among all of them.

// open makes each user a follower of the chat, as an open chat view does: by a read of its
// thread and of its tree.
func (bo *both) open(chat string, us ...*user) {
	bo.t.Helper()
	for _, u := range us {
		u.want(bo.t, 200, "GET", "/chats/"+chat+"/items", nil)
		u.want(bo.t, 200, "GET", "/chats/"+chat+"/tree", nil)
	}
}

// alike reads what the users were sent (reach) and fails unless every one of them was sent the
// same events of the tree and of the content, in the same order: all of them follow the thing.
// It returns the first user's.
func (bo *both) alike(what string, us ...*user) []string {
	bo.t.Helper()
	got := bo.reach(us...)
	for i := range us[1:] {
		if !slices.Equal(got[i+1], got[0]) {
			bo.t.Fatalf("%s: %s was sent\n%s\nand %s\n%s", what, us[i+1].who, strings.Join(got[i+1], "\n"), us[0].who, strings.Join(got[0], "\n"))
		}
	}
	for _, raw := range got[0] {
		l5Unmarked(bo.t, "an event of "+what, raw)
	}
	return got[0]
}

// One thread for all: the owner's page and a page of each client have the chat open. Each sees
// what any of them sends, the working state and what the agent answers; a branch that works
// takes no message, whoever sent the one before; a permission request reaches every follower,
// the first answer decides and a later one is refused; anyone stops the turn.
func TestBothOneThreadForAll(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{})
	us := bo.three()
	owner, one, two := us[0], us[1], us[2]
	chat := l5ID(t, owner.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": model.Ungrouped}))
	path := "/chats/" + chat
	// A page opens a chat it was told of: one that reads a chat before its event has come is
	// sent the state of the chat's branch once as its follower and once more with the chat.
	bo.told("the new chat", us, []string{"chat", chat})
	bo.open(chat, us...)
	// On the remote server the followers are its own page and the two clients, each client one
	// follower whatever the number of its pages; on a local server, its page.
	got := bo.b.s.Bridge.Followers(editorbridge.Chat(chat))
	slices.Sort(got)
	if !slices.Equal(got, []string{bothID1, bothID2, owner.p.ID}) {
		t.Fatalf("the followers of the chat on the remote server: %v", got)
	}

	// sent is a message by one of the three that must be taken, and then told to all of them:
	// the message in the thread and in the tree, and that the chat works.
	sent := func(by *user, text string) {
		t.Helper()
		if out := by.want(t, 200, "POST", path+"/messages", obj{"text": text}); out != `{"branch":"main","ok":true}` {
			t.Fatalf("the message %q by %s: %s", text, by.who, out)
		}
		evs := bo.alike("the message "+text, us...)
		if l5Count(evs, "chat_items", chat, `"kind":"user"`, text) != 1 || l5Count(evs, "tree", chat, text) != 1 || l5Count(evs, "chat", chat, `"working":`) == 0 {
			t.Fatalf("the message %q by %s told %v", text, by.who, evs)
		}
	}
	// replied ends the turn with an answer, which all three must see, and the chat is ready.
	replied := func(ag *apiAgent, text, point string) {
		t.Helper()
		reply(t, &ag.fakeAgent, text, point)
		evs := bo.alike("the reply "+text, us...)
		if l5Count(evs, "chat_items", chat, `"kind":"text"`, text) != 1 || l5Count(evs, "tree", chat, text) != 1 || l5Count(evs, "branch_state", chat, `"status":"ready"`) == 0 {
			t.Fatalf("the reply %q told %v", text, evs)
		}
	}
	// refusedAlike is a call that the remote server refuses for each of the three with the same
	// status and body: a client's page is handed that server's answer as it came.
	refusedAlike := func(what string, status int, code, method, rest string, body any) {
		t.Helper()
		var first string
		for i, u := range []*user{two, owner, one} {
			got, out := u.call(method, rest, body)
			if i == 0 {
				first = out
			}
			if r := decode[refusal](t, out); got != status || r.Code != code || out != first {
				t.Errorf("%s by %s: %d %s, want %d %s", what, u.who, got, out, status, first)
			}
		}
	}

	// Client 1 sends the first message of the owner's chat. While the branch works it takes no
	// message: not from the other client, not from the owner, not from the one who sent.
	sent(one, "the first, by client 1")
	ag := bo.sp.of(t, chat)
	refusedAlike("a message to a working branch", 409, "busy", "POST", path+"/messages", obj{"text": "while it works"})
	refusedAlike("a message to the working branch by name", 409, "busy", "POST", path+"/messages?branch=main", obj{"text": "while it works"})
	if ag.sends.Load() != 1 || bo.sp.count() != 1 {
		t.Errorf("the refused messages reached the agent: %d sends, %d agents", ag.sends.Load(), bo.sp.count())
	}
	if evs := bo.alike("the refused messages", us...); len(evs) != 0 {
		t.Errorf("the refused messages told %v", evs)
	}

	// A permission request: every follower gets the card; client 2, which did not send the
	// message, answers first and decides; a later answer is refused, whoever gives it.
	ag.ask("perm-1")
	for _, u := range us {
		if evs := u.upTo(t, "chat", chat, `"approvals":1`); l5Count(evs, "chat_items", chat, `"kind":"perm"`, "perm-1") != 1 {
			t.Fatalf("the permission request told %s %v", u.who, evs)
		}
	}
	if out := two.want(t, 200, "POST", path+"/permission", obj{"requestId": "perm-1", "allow": true}); out != `{"ok":true}` {
		t.Errorf("the first answer: %s", out)
	}
	if evs := bo.alike("the first answer", us...); l5Count(evs, "chat_items", chat, "perm-1", `"decided":"allow"`) != 1 {
		t.Errorf("the first answer told %v", evs)
	}
	refusedAlike("a later answer", 400, "", "POST", path+"/permission", obj{"requestId": "perm-1", "allow": false})
	// The owner is first for the next one, and denies.
	ag.ask("perm-2")
	for _, u := range us {
		u.upTo(t, "chat", chat, `"approvals":1`)
	}
	owner.want(t, 200, "POST", path+"/permission", obj{"requestId": "perm-2", "allow": false})
	refusedAlike("a later answer to the second request", 400, "", "POST", path+"/permission", obj{"requestId": "perm-2", "allow": true})
	if got := ag.answered(); !slices.Equal(got, []string{"perm-1 true", "perm-2 false"}) {
		t.Errorf("the agent was answered %v", got)
	}
	if evs := bo.alike("the second request's answers", us...); l5Count(evs, "chat_items", chat, "perm-2", `"decided":"deny"`) != 1 {
		t.Errorf("the answers to the second request told %v", evs)
	}
	// Anyone stops the turn.
	if out := two.want(t, 200, "POST", path+"/interrupt", nil); out != `{"ok":true}` {
		t.Errorf("the stop by another client: %s", out)
	}
	replied(ag, "the first answer", "point-1")

	// Now the branch is ready: the next message is whoever's comes first.
	sent(two, "the second, by client 2")
	one.refused(t, 409, "busy", "POST", path+"/messages", obj{"text": "too late"})
	replied(ag, "the second answer", "point-2")
	sent(owner, "the third, by the owner")
	two.refused(t, 409, "busy", "POST", path+"/messages", obj{"text": "too late"})
	replied(ag, "the third answer", "point-3")
	if ag.sends.Load() != 3 || bo.sp.count() != 1 {
		t.Errorf("three messages to main were %d sends to %d agents", ag.sends.Load(), bo.sp.count())
	}
	// Each reads the same thread, level with the remote server.
	thread := owner.want(t, 200, "GET", path+"/items", nil)
	for _, u := range []*user{one, two} {
		if got := u.want(t, 200, "GET", path+"/items", nil); !l5Same(t, got, thread) {
			t.Errorf("%s reads the thread as %s, the owner as %s", u.who, got, thread)
		}
	}

	// A follow ends with the unfollow, which a client's page is answered by its own server
	// (contract 3.7). While another page of that server follows the chat, the remote server is
	// told nothing, and the page that let go gets the list events of the chat and no more of
	// its thread.
	extra := bo.c[1].page("P2b")
	extra.want(t, 200, "GET", path+"/items", nil)
	bo.untouched("the unfollow of one of the two pages of a server that follow the chat", func() {
		if out := two.want(t, 200, "POST", path+"/unfollow", nil); out != `{"ok":true}` {
			t.Errorf("the unfollow: %s", out)
		}
	})
	if out := one.want(t, 200, "POST", path+"/messages", obj{"text": "the fourth, by client 1"}); out != `{"branch":"main","ok":true}` {
		t.Fatalf("the fourth message: %s", out)
	}
	evs := bo.reach(owner, one, two, extra)
	for i, u := range []*user{owner, one, extra} {
		if l5Count(evs[[]int{0, 1, 3}[i]], "chat_items", "the fourth, by client 1") != 1 {
			t.Errorf("%s, which follows the chat, was sent %v", u.who, l5Types(evs[[]int{0, 1, 3}[i]]))
		}
	}
	if got := only(evs[2], bothContent...); len(got) != 0 || len(only(evs[2], "chat")) == 0 {
		t.Errorf("after its unfollow %s was sent %v", two.who, l5Types(evs[2]))
	}
	// The last page of that server lets go: its server ends its follow on the remote server,
	// and the other client's follow is its own.
	extra.want(t, 200, "POST", path+"/unfollow", nil)
	bo.c[1].wait("the remote server has no follow of client 2", func() bool {
		return !slices.Contains(bo.b.s.Bridge.Followers(editorbridge.Chat(chat)), bothID2)
	})
	reply(t, &ag.fakeAgent, "the fourth answer", "point-4")
	if got := bo.alike("the reply after client 2 let go", owner, one); l5Count(got, "chat_items", chat, "the fourth answer") != 1 {
		t.Errorf("the owner and client 1, which still follow the chat, were sent %v", l5Types(got))
	}
}

// The draft of a branch is one draft for the owner and every client (goal 3.6 and the bound "the
// draft counter decides between writers"; contract 2.7.2 and 2.4): a save names the counter it
// was typed on; on another one it is refused 409 "stale" with the stored counter and draft; the
// counter a page is shown never goes down; and nothing replaces a draft on any path.
func TestBothTwoWritersInOneDraft(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{})
	us := bo.three()
	owner, one, two := us[0], us[1], us[2]
	chat := l5ID(t, one.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": model.Ungrouped}))
	path := "/chats/" + chat + "/draft"
	bo.told("the new chat", us, []string{"chat", chat})
	bo.open(chat, us...)
	var all [3][]string // every event each of the three was sent
	// told reads what the three were sent, which must be the same: the chat and its branch state
	// with the draft and the counter.
	told := func(what, text string, rev int) {
		t.Helper()
		evs := bo.reach(us...)
		for i := range all {
			all[i] = append(all[i], evs[i]...)
			if !slices.Equal(evs[i], evs[0]) {
				t.Fatalf("%s: %s was sent %v and %s %v", what, us[i].who, evs[i], us[0].who, evs[0])
			}
		}
		has := []string{chat, fmt.Sprintf(`"draftRev":%d`, rev)}
		if text != "" {
			has = append(has, `"draft":{"text":"`+text+`"}`)
		}
		if got := evs[0]; l5Count(got, "chat", has...) != 1 || l5Count(got, "branch_state", has...) != 1 || len(got) != 2 {
			t.Errorf("%s told %v, want the chat and its branch state with %v", what, got, has)
		}
	}
	save := func(by *user, rev int, text string) (int, string) {
		return by.call("PUT", fmt.Sprintf("%s?rev=%d", path, rev), obj{"text": text})
	}
	stale := func(what string, by *user, rev int, text string, stored int, has string) {
		t.Helper()
		status, out := save(by, rev, text)
		got := decode[struct {
			Code  string
			Rev   int
			Draft *model.Draft
		}](t, out)
		if status != 409 || got.Code != "stale" || got.Rev != stored || got.Draft == nil || got.Draft.Text != has {
			t.Errorf("%s by %s: %d %s, want 409 stale with the counter %d and the draft %q", what, by.who, status, out, stored, has)
		}
	}
	stored := func(what, text string, rev int64) {
		t.Helper()
		for _, u := range us {
			v := decode[model.ChatView](t, u.want(t, 200, "GET", "/chats/"+chat, nil))
			got := ""
			if v.Draft != nil {
				got = v.Draft.Text
			}
			if got != text || v.DraftRev != rev {
				t.Errorf("%s: %s reads the draft %q at the counter %d, want %q at %d", what, u.who, got, v.DraftRev, text, rev)
			}
		}
	}

	// The two clients type at once on the same counter: the first save is taken, the second is
	// told what is stored and stores nothing.
	if status, out := save(one, 0, "typed by client 1"); status != 200 || out != `{"ok":true,"rev":1}` {
		t.Fatalf("the first save: %d %s", status, out)
	}
	told("the first save", "typed by client 1", 1)
	stale("a save on the counter of before", two, 0, "typed by client 2", 1, "typed by client 1")
	stored("a refused save", "typed by client 1", 1)
	// On the counter it was told, the second writer's save is taken.
	if status, out := save(two, 1, "typed by client 2, over client 1"); status != 200 || out != `{"ok":true,"rev":2}` {
		t.Fatalf("the save on the stored counter: %d %s", status, out)
	}
	told("the second writer's save", "typed by client 2, over client 1", 2)
	// The owner's page is one more writer in the same draft.
	stale("the owner's save on an old counter", owner, 1, "typed by the owner", 2, "typed by client 2, over client 1")
	stale("the first writer's save on an old counter", one, 1, "typed by client 1 again", 2, "typed by client 2, over client 1")
	if status, out := save(owner, 2, "typed by the owner"); status != 200 || out != `{"ok":true,"rev":3}` {
		t.Fatalf("the owner's save: %d %s", status, out)
	}
	told("the owner's save", "typed by the owner", 3)
	// A counter that is ahead of the stored one is as stale as one behind.
	stale("a save on a counter that never was", two, 7, "from the future", 3, "typed by the owner")
	stored("the refused saves", "typed by the owner", 3)

	// ?replace= is refused on every path, with or without a counter, and stores nothing: for a
	// chat of a section by the client's own server, which sends nothing; on the remote server's
	// own port and on its remote listener; and for a chat of a client's own.
	local := l5ID(t, string(do(t, one.p, "POST", "/api/chats", obj{"agent": "claude", "group": model.Ungrouped})))
	for _, q := range []string{"?replace=3", "?replace=0", "?rev=3&replace=3", "?replace=3&rev=3", "?replace=", "?rev=3&replace"} {
		bo.untouched("a client's PUT draft"+q, func() {
			for _, u := range []*user{one, two} {
				u.refused(t, 400, "replace_refused", "PUT", path+q, obj{"text": "replaced"})
			}
			status, out := one.p.Do("PUT", "/api/chats/"+local+"/draft"+q, obj{"text": "replaced"})
			bo.c[0].refusal("PUT draft"+q+" of a client's own chat", 400, "replace_refused", status, out)
		})
		owner.refused(t, 400, "replace_refused", "PUT", path+q, obj{"text": "replaced"})
		status, out := bo.l.call(bothThird, testSecret, "PUT", "/api/chats/"+chat+"/draft"+q, `{"text":"replaced"}`)
		bo.c[0].refusal("PUT draft"+q+" on the remote listener", 400, "replace_refused", status, []byte(out))
	}
	stored("the refused replaces", "typed by the owner", 3)
	if evs := bo.alike("the refused saves and replaces", us...); len(evs) != 0 {
		t.Errorf("the refused saves told %v", evs)
	}

	// An empty draft is none: the counter goes on.
	if status, out := save(two, 3, ""); status != 200 || out != `{"ok":true,"rev":4}` {
		t.Fatalf("the save of an empty draft: %d %s", status, out)
	}
	told("the empty draft", "", 4)
	if status, out := save(one, 4, "typed after"); status != 200 || out != `{"ok":true,"rev":5}` {
		t.Fatalf("a save after the empty draft: %d %s", status, out)
	}
	told("the save after", "typed after", 5)
	stored("the last save", "typed after", 5)

	// The counter anyone was shown never went down.
	for i, u := range us {
		revs := l5DraftRevs(t, all[i], chat)
		if len(revs) != 10 || !slices.IsSorted(revs) || revs[0] != 1 || revs[len(revs)-1] != 5 {
			t.Errorf("%s was shown the counters %v", u.who, revs)
		}
	}
	// A page that connects now is handed the draft with its counter in the section.
	late := bo.c[1].page("late")
	if tree := late.tree(t); !strings.Contains(tree, `"draft":{"text":"typed after"}`) || !strings.Contains(tree, `"draftRev":5`) {
		t.Errorf("the section of a page that connects later: %s", tree)
	}
	// Nothing of the draft is on a client's disk.
	for _, sd := range bo.c {
		noFileHolds(t, sd.a.a.DataDir, "typed after")
		noFileHolds(t, sd.root, "typed after")
	}
}

// Before the first message the settings of a chat are anyone's to change (contract 2.7.5): the
// last change wins, and every change is told to all by the chat and its branch state.
func TestBothSettingsBeforeTheFirstMessage(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{})
	us := bo.three()
	owner, one, two := us[0], us[1], us[2]
	chat := l5ID(t, two.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": model.Ungrouped}))
	bo.told("the new chat", us, []string{"chat", chat})
	bo.open(chat, us...)
	for i, c := range []struct {
		by   *user
		body obj
		has  []string // what the chat and its branch state hold afterwards
	}{
		{one, obj{"model": "opus"}, []string{`"model":"opus"`}},
		{two, obj{"model": "claude-fable-5-1", "effort": "max"}, []string{`"model":"claude-fable-5-1"`, `"effort":"max"`}},
		{owner, obj{"effort": "low"}, []string{`"model":"claude-fable-5-1"`, `"effort":"low"`}},
		{one, obj{"model": "sonnet", "effort": "medium"}, []string{`"model":"sonnet"`, `"effort":"medium"`}},
		{two, obj{"model": "opus"}, []string{`"model":"opus"`, `"effort":"medium"`}},
	} {
		what := fmt.Sprintf("the change %d by %s", i, c.by.who)
		out := c.by.want(t, 200, "PATCH", "/chats/"+chat, c.body)
		evs := bo.alike(what, us...)
		for _, part := range c.has {
			if !strings.Contains(l5Field(t, out, "chat"), part) || l5Count(evs, "chat", chat, part) == 0 || l5Count(evs, "branch_state", chat, part) == 0 {
				t.Errorf("%s: answered %s and told %v; want %s in the answer, the chat and the branch state", what, out, evs, part)
			}
		}
	}
	for _, u := range us {
		if v := decode[model.ChatView](t, u.want(t, 200, "GET", "/chats/"+chat, nil)); v.Model != "opus" || v.Effort != "medium" || v.Locked {
			t.Errorf("%s reads the chat as %+v", u.who, v)
		}
	}
	// A client names no server for it: the remote server's refusal, as it came.
	one.refused(t, 400, "server_refused", "PATCH", "/chats/"+chat, obj{"model": "sonnet", "server": "local"})
	if evs := bo.alike("the refused change", us...); len(evs) != 0 {
		t.Errorf("the refused change told %v", evs)
	}
}

// A board has one holder among the owner's pages and the pages of every client (goal 3.6;
// contract 2.7.7, 2.7.8 and 3.6): take, the request to let go, the grant with the remote
// server's revision, and "superseded" for who lost the board or its place in the line. To the
// remote server a client is one user of the board, whatever the number of its windows. A board
// tool call of an agent goes to the window that holds the board.
func TestBothOneHolderOfABoard(t *testing.T) {
	t.Parallel()
	bo := newBoth(t, bothOpt{})
	c1, c2 := bo.c[0], bo.c[1]
	o := bo.b.page("O")
	p1, q1, p2 := c1.a.page("P1"), c1.a.page("Q1"), c2.a.page("P2")
	board := newBoard(t, o, "plan").ID
	// holders waits until the board is held by this page of client 1, this page of client 2 and
	// this one on the remote server ("" = nobody).
	holders := func(on1, on2, onB string) {
		t.Helper()
		c1.holders(board, on1, onB)
		c2.holders(board, on2, onB)
	}
	// The owner's page made the board and holds it. A client reads the drawing all the same,
	// and does not write it.
	holders("", "", "O")
	written(t, o, board, 0, drawing("the owner's"))
	if status, out := p1.Do("GET", c1.on("/boards/"+board+"/scene"), nil); status != 200 || !l5Same(t, string(out), drawing("the owner's")) {
		t.Fatalf("a client's read of the owner's drawing: %d %s", status, out)
	}
	status, out := c1.write(p1, board, 1, drawing("not the holder's"))
	c1.refusal("the write of a client that does not hold the board", 409, "not_holder", status, out)
	if state, _ := c1.take(p1, board, true); state != "busy" {
		t.Fatalf("a client's take, if free, of the board the owner holds: %s", state)
	}

	// The hand-over to a client: the owner's page is asked, writes what it has and lets go; the
	// client's page is told it holds the board, with the revision of that last write.
	if state, _ := c1.take(p1, board, false); state != "waiting" {
		t.Fatalf("a client's take of the board the owner holds: %s", state)
	}
	if ev := until(t, o, "release_request", board); ev["server"] != nil {
		t.Fatalf("the request to the owner's page: %v", ev)
	}
	written(t, o, board, 1, drawing("the owner's last"))
	if got := release(t, o, board); got != "handed" {
		t.Fatalf("the owner's release to the client that waits: %s", got)
	}
	if ev := c1.until(p1, "held", board); ev["rev"] != 2.0 {
		t.Fatalf("the grant to the client's page: %v", ev)
	}
	until(t, o, "superseded", board)
	holders("P1", "", bothID1)

	// A second window of the same client: the hand-over is its own server's, at the remote
	// server's revision, and the remote server is asked for no take and told of no release.
	asked := len(bo.fr.requests())
	if state, _ := c1.take(q1, board, false); state != "waiting" {
		t.Fatalf("the take of the client's second window: %s", state)
	}
	c1.until(p1, "release_request", board)
	c1.written(p1, board, 2, drawing("P1's"))
	if got := c1.release(p1, board); got != "handed" {
		t.Fatalf("P1's release to Q1: %s", got)
	}
	if ev := c1.until(q1, "held", board); ev["rev"] != 3.0 {
		t.Fatalf("Q1's grant: %v, want the remote server's revision 3", ev)
	}
	c1.until(p1, "superseded", board)
	holders("Q1", "", bothID1)
	for _, r := range bo.fr.requests()[asked:] {
		if strings.HasSuffix(r.Path, "/take") || strings.HasSuffix(r.Path, "/release") {
			t.Errorf("the hand-over between two windows of one client asked the remote server %s %s", r.Method, r.Path)
		}
	}

	// The other client: one holder among all. Its take is asked of the window that holds the
	// board, on the other client's server, which saves and lets go.
	if state, _ := c2.take(p2, board, true); state != "busy" {
		t.Fatalf("the other client's take, if free: %s", state)
	}
	status, out = c2.write(p2, board, 3, drawing("P2's, too early"))
	c2.refusal("the write of the client that does not hold the board", 409, "not_holder", status, out)
	if state, _ := c2.take(p2, board, false); state != "waiting" {
		t.Fatalf("the other client's take: %s", state)
	}
	c1.until(q1, "release_request", board)
	c1.written(q1, board, 3, drawing("Q1's"))
	if got := c1.release(q1, board); got != "handed" {
		t.Fatalf("Q1's release to the other client: %s", got)
	}
	if ev := c2.until(p2, "held", board); ev["rev"] != 4.0 {
		t.Fatalf("P2's grant: %v", ev)
	}
	c1.until(q1, "superseded", board)
	holders("", "P2", bothID2)
	status, out = c1.write(q1, board, 4, drawing("late"))
	c1.refusal("the write of the window that lost the board", 409, "not_holder", status, out)
	c2.written(p2, board, 4, drawing("P2's"))
	bo.b.stored(board, drawing("P2's"), 5)

	// Two wait for one board: the later one takes the place of the earlier, which is told so.
	// "Use here" on the owner's page is that later take.
	if state, _ := c1.take(p1, board, false); state != "waiting" {
		t.Fatalf("P1's take of the board the other client holds: %s", state)
	}
	c2.until(p2, "release_request", board)
	if state, _ := take(t, o, board, false); state != "waiting" {
		t.Fatalf("the owner's take while a client waits: %s", state)
	}
	c1.until(p1, "superseded", board)
	if got := c2.release(p2, board); got != "handed" {
		t.Fatalf("P2's release to the owner's page: %s", got)
	}
	if ev := until(t, o, "held", board); ev["rev"] != 5.0 || ev["server"] != nil {
		t.Fatalf("the grant to the owner's page: %v", ev)
	}
	c2.until(p2, "superseded", board)
	holders("", "", "O")

	// A board tool call of an agent on the remote server goes to the window that holds the
	// board: to the owner's page as a call of its own server's.
	chat := l5ID(t, string(do(t, p2, "POST", c2.on("/chats"), obj{"agent": "claude", "board": board})))
	do(t, p2, "POST", c2.on("/chats/"+chat+"/messages"), obj{"text": "look at the board"})
	token := bo.b.a.Chats.ChatsOfBoard(board)[0].Token
	type result struct {
		text  string
		isErr bool
	}
	call := func() <-chan result {
		done := make(chan result, 1)
		go func() {
			text, isErr := bo.b.tool(token, "read_board")
			done <- result{text, isErr}
		}()
		return done
	}
	done := call()
	ev := c2.event(o, "rpc", func(map[string]any) bool { return true })
	if id, _ := ev["id"].(string); ev["server"] != nil || strings.HasPrefix(id, "far_") || field(ev, "params", "board") != board {
		t.Fatalf("the tool call the owner's page was sent: %v", ev)
	}
	do(t, o, "POST", "/api/rpc-reply", obj{"id": ev["id"], "result": "what the owner shows"})
	if got := <-done; got.isErr || got.text != "what the owner shows" {
		t.Fatalf("the board tool, answered by the owner's page: %+v", got)
	}
	// And to a client's window when that one holds the board: with the entry's id, an id that
	// starts with "far_", and the board's id as the remote server has it.
	if state, _ := c2.take(p2, board, false); state != "waiting" {
		t.Fatalf("P2's take of the owner's board: %s", state)
	}
	until(t, o, "release_request", board)
	release(t, o, board)
	c2.until(p2, "held", board)
	holders("", "P2", bothID2)
	done = call()
	ev = c2.event(p2, "rpc", func(map[string]any) bool { return true })
	id, _ := ev["id"].(string)
	if ev["server"] != c2.entry || !strings.HasPrefix(id, "far_") || field(ev, "params", "board") != board || field(ev, "params", "chat") != chat || field(ev, "params", "name") != "read_board" {
		t.Fatalf("the tool call the client's window was sent: %v", ev)
	}
	do(t, p2, "POST", "/api/rpc-reply", obj{"id": id, "result": "what P2 shows"})
	if got := <-done; got.isErr || got.text != "what P2 shows" {
		t.Fatalf("the board tool, answered by the client's window: %+v", got)
	}
	// No other window was asked: not the other client's, not the owner's.
	for _, p := range []*struct {
		id  string
		evs []string
	}{{"P1", p1.Drain(0)}, {"Q1", q1.Drain(0)}, {"O", o.Drain(0)}} {
		if n := count(p.evs, "rpc"); n != 0 {
			t.Errorf("the window %s, which does not hold the board, was sent %d tool calls", p.id, n)
		}
	}
	holders("", "P2", bothID2)
}
