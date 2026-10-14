package server

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// Several clients and the owner in one thing (contract 2.7, goal 3.6): a chat that the owner's
// page and two clients have open, and a board that one of them holds at a time.

// l5Open makes each of the three a follower of the chat, as an open chat view does: by a read
// of its thread.
func l5Open(t *testing.T, e *env, chat string, three ...*bridgetest.Page) {
	t.Helper()
	var want []string
	for _, c := range three {
		l5Want(t, c, 200, "GET", "/api/chats/"+chat+"/items", nil)
		want = append(want, c.ID)
	}
	got := e.s.Bridge.Followers(editorbridge.Chat(chat))
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("the followers of the chat after the reads: %v, want %v", got, want)
	}
}

// l5DraftRevs is the draft counters of the chat's chat and branch_state events, in order.
func l5DraftRevs(t *testing.T, evs []string, chat string) (revs []int64) {
	t.Helper()
	for _, raw := range evs {
		switch typeOf(raw) {
		case "chat":
			if ev := decode[struct{ Chat model.ChatView }](t, raw); ev.Chat.ID == chat {
				revs = append(revs, ev.Chat.DraftRev)
			}
		case "branch_state":
			if ev := decode[struct{ State model.BranchState }](t, raw); ev.State.Chat == chat {
				revs = append(revs, ev.State.DraftRev)
			}
		}
	}
	return revs
}

// Before the first message the settings of a chat are anyone's to change: the last change
// wins, and every change is told to all by the chat and its branch state.
func TestLevel5SettingsBeforeTheFirstMessage(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	p, x, y := l5Trio(e, l)
	three := []*bridgetest.Page{p, x, y}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	chat := l5ID(t, l5Want(t, p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+model.Ungrouped+`"}`))
	l5Open(t, e, chat, three...)
	l5AllSame(t, e, "the set-up", three...)
	for i, c := range []struct {
		by   *bridgetest.Page
		body string
		has  []string // what the chat and its branch state hold afterwards
	}{
		{x, `{"model":"opus"}`, []string{`"model":"opus"`}},
		{y, `{"model":"claude-fable-5-1","effort":"max"}`, []string{`"model":"claude-fable-5-1"`, `"effort":"max"`}},
		{p, `{"effort":"low"}`, []string{`"model":"claude-fable-5-1"`, `"effort":"low"`}},
		{x, `{"cwd":"` + dir + `"}`, []string{`"model":"claude-fable-5-1"`, `"effort":"low"`, `"cwd":"` + dir + `"`}},
		{y, `{"model":"sonnet","effort":"medium"}`, []string{`"model":"sonnet"`, `"effort":"medium"`, `"cwd":"` + dir + `"`}},
		{p, `{"model":"opus"}`, []string{`"model":"opus"`, `"cwd":"` + dir + `"`}},
	} {
		what := fmt.Sprintf("the change %d, %s by %s", i, c.body, c.by.ID)
		out := l5Want(t, c.by, 200, "PATCH", "/api/chats/"+chat, c.body)
		evs := l5AllSame(t, e, what, three...)
		for _, part := range c.has {
			if !strings.Contains(l5Field(t, out, "chat"), part) || l5Count(evs, "chat", chat, part) == 0 || l5Count(evs, "branch_state", chat, part) == 0 {
				t.Errorf("%s: answered %s and told %v; want %s in the answer, the chat and the branch state", what, out, evs, part)
			}
		}
	}
	// The subagent settings too, which are the chat's.
	l5Want(t, y, 200, "PATCH", "/api/chats/"+chat, `{"subDepth":3,"subCap":9}`)
	if evs := l5AllSame(t, e, "the subagent settings", three...); l5Count(evs, "chat", chat, `"subDepth":3,"subCap":9`) == 0 {
		t.Errorf("the subagent settings told %v", evs)
	}
	for _, c := range three {
		v := decode[model.ChatView](t, l5Want(t, c, 200, "GET", "/api/chats/"+chat, nil))
		if v.Model != "opus" || v.Cwd != dir || v.SubDepth != 3 || v.SubCap != 9 || v.Locked {
			t.Errorf("%s reads the chat as %+v", c.ID, v)
		}
	}
	// A client names no server for it, whatever the value and whatever else it changes, a chat
	// that is not there too; the page's refusal is its own.
	for _, server := range l5ServerBodies {
		body := `{"model":"sonnet",` + server + `}`
		status, out := l5Call(x, "PATCH", "/api/chats/"+chat, body)
		l5Is(t, "a client's change with "+body, status, out, 400, l5ServerRefused)
	}
	status, out := l5Call(x, "PATCH", "/api/chats/"+chat2, `{"name":"n","server":""}`)
	l5Is(t, "a client's change of a chat that is not there with a server", status, out, 400, l5ServerRefused)
	status, out = l5Call(p, "PATCH", "/api/chats/"+chat, `{"model":"sonnet","server":"local"}`)
	l5Is(t, "the owner's change that names a server", status, out, 400, l5ServerRefused)
	if v := decode[model.ChatView](t, l5Want(t, y, 200, "GET", "/api/chats/"+chat, nil)); v.Model != "opus" {
		t.Errorf("a refused change took: %+v", v)
	}
	if evs := l5AllSame(t, e, "the refused changes", three...); len(evs) != 0 {
		t.Errorf("the refused changes told %v", evs)
	}
}

// The draft of a branch is one draft for the owner and every client. A save names the counter
// it was typed on; on another one it is refused with the stored counter and draft, so nobody
// replaces what another typed without being told. Nothing replaces a draft whatever its counter.
func TestLevel5TwoWritersInOneDraft(t *testing.T) {
	t.Parallel()
	e, l := remoteEnv(t)
	p, x, y := l5Trio(e, l)
	three := []*bridgetest.Page{p, x, y}
	chat := l5ID(t, l5Want(t, p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+model.Ungrouped+`"}`))
	l5Open(t, e, chat, three...)
	l5AllSame(t, e, "the set-up", three...)
	path := "/api/chats/" + chat + "/draft"
	var all [3][]string // every event each of the three was sent
	// told reads what the three were sent, which must be the same, and checks the draft and the
	// counter the chat is told with.
	told := func(what, text string, rev int) {
		t.Helper()
		evs := e.reach(three...)
		for i := range all {
			all[i] = append(all[i], evs[i]...)
		}
		got := l5SameOf(t, what, evs, three...)
		has := []string{fmt.Sprintf(`"draftRev":%d`, rev)}
		if text != "" {
			has = append(has, `"draft":{"text":"`+text+`"}`)
		}
		if l5Count(got, "chat", append(has, chat)...) != 1 || l5Count(got, "branch_state", append(has, chat)...) != 1 || len(got) != 2 {
			t.Errorf("%s told %v, want the chat and its branch state with %v", what, got, has)
		}
		for _, raw := range got {
			if text == "" && strings.Contains(raw, `"draft":`) {
				t.Errorf("%s told a draft: %s", what, raw)
			}
		}
	}
	stale := func(text string, rev int) string {
		return fmt.Sprintf(`{"code":"stale","draft":{"text":"%s"},"error":"the draft was changed elsewhere","rev":%d}`, text, rev)
	}
	save := func(by *bridgetest.Page, rev int, text string) (int, string) {
		return l5Call(by, "PUT", fmt.Sprintf("%s?rev=%d", path, rev), map[string]string{"text": text})
	}
	stored := func(what, text string, rev int64) {
		t.Helper()
		for _, c := range three {
			v := decode[model.ChatView](t, l5Want(t, c, 200, "GET", "/api/chats/"+chat, nil))
			got := ""
			if v.Draft != nil {
				got = v.Draft.Text
			}
			if got != text || v.DraftRev != rev {
				t.Errorf("%s: %s reads the draft %q at the counter %d, want %q at %d", what, c.ID, got, v.DraftRev, text, rev)
			}
		}
	}

	// Two clients type at once on the same counter: the first save is taken, the second is told
	// what is stored and stores nothing.
	status, out := save(x, 0, "typed by X")
	l5Is(t, "the first save", status, out, 200, `{"ok":true,"rev":1}`)
	told("the first save", "typed by X", 1)
	status, out = save(y, 0, "typed by Y")
	l5Is(t, "a save on the counter of before", status, out, 409, stale("typed by X", 1))
	stored("a refused save", "typed by X", 1)
	// On the counter it was told, the second writer's save is taken.
	status, out = save(y, 1, "typed by Y, over X")
	l5Is(t, "the save on the stored counter", status, out, 200, `{"ok":true,"rev":2}`)
	told("the second writer's save", "typed by Y, over X", 2)
	// The owner's page is one more writer in the same draft.
	status, out = save(p, 1, "typed by the owner")
	l5Is(t, "the owner's save on an old counter", status, out, 409, stale("typed by Y, over X", 2))
	status, out = save(x, 1, "typed by X again")
	l5Is(t, "the first writer's save on an old counter", status, out, 409, stale("typed by Y, over X", 2))
	status, out = save(p, 2, "typed by the owner")
	l5Is(t, "the owner's save", status, out, 200, `{"ok":true,"rev":3}`)
	told("the owner's save", "typed by the owner", 3)
	// A counter that is ahead of the stored one is as stale as one behind.
	status, out = save(x, 7, "from the future")
	l5Is(t, "a save on a counter that never was", status, out, 409, stale("typed by the owner", 3))
	stored("the refused saves", "typed by the owner", 3)

	// ?replace= is refused on both listeners, with or without a counter, and stores nothing.
	const refused = `{"code":"replace_refused","error":"a draft is not replaced: save it on the counter it was typed on"}`
	for _, q := range []string{"?replace=3", "?replace=0", "?replace=9", "?rev=3&replace=3", "?replace=3&rev=3", "?replace=", "?rev=3&replace"} {
		for _, c := range three {
			status, out := l5Call(c, "PUT", path+q, `{"text":"replaced"}`)
			l5Is(t, "PUT draft"+q+" by "+c.ID, status, out, 400, refused)
		}
	}
	// A chat that is not there: the refusal comes first, as it reads no chat.
	status, out = l5Call(x, "PUT", "/api/chats/"+chat3+"/draft?replace=1", `{"text":"replaced"}`)
	l5Is(t, "PUT draft?replace= for a missing chat", status, out, 400, refused)
	stored("the refused replaces", "typed by the owner", 3)
	if evs := l5AllSame(t, e, "the refused saves and replaces", three...); len(evs) != 0 {
		t.Errorf("the refused saves told %v", evs)
	}
	if raw := l5Want(t, x, 200, "GET", "/api/chats/"+chat, nil); strings.Contains(raw, "draftReplaced") {
		t.Errorf("the chat's view has draftReplaced: %s", raw)
	}

	// An empty draft is none: the counter goes on.
	status, out = save(y, 3, "")
	l5Is(t, "the save of an empty draft", status, out, 200, `{"ok":true,"rev":4}`)
	told("the empty draft", "", 4)
	stored("the empty draft", "", 4)
	status, out = save(x, 4, "typed after")
	l5Is(t, "a save after the empty draft", status, out, 200, `{"ok":true,"rev":5}`)
	told("the save after", "typed after", 5)

	// The page's refusals are a client's.
	for _, c := range three {
		status, out := l5Call(c, "PUT", path, `{"text":"no counter"}`)
		l5Is(t, "a save with no counter by "+c.ID, status, out, 400, `{"error":"rev is missing"}`)
		status, out = l5Call(c, "PUT", path+"?rev=one", `{"text":"no number"}`)
		l5Is(t, "a save with a counter that is no number by "+c.ID, status, out, 400, `{"error":"rev is not a number"}`)
		status, out = l5Call(c, "PUT", path+"?rev=5&branch=nothere", `{"text":"no branch"}`)
		l5Is(t, "a save for a branch the chat does not have by "+c.ID, status, out, 404, `{"code":"no_branch","error":"no such branch"}`)
	}
	stored("the page's refusals", "typed after", 5)

	// The counter anyone was shown never went down.
	for i, c := range three {
		revs := l5DraftRevs(t, all[i], chat)
		if len(revs) != 10 || !slices.IsSorted(revs) || revs[0] != 1 || revs[len(revs)-1] != 5 {
			t.Errorf("%s was shown the counters %v", c.ID, revs)
		}
	}
}

// One thread for all: the owner's page and two clients have the chat open. Each sees what any
// of them sends and what the agent answers; a branch that works takes no message from anyone; a
// permission request is answered once, by whoever is first; and the chat has one current branch.
func TestLevel5OneThreadForAll(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p, x, y := l5Trio(e, l)
	three := []*bridgetest.Page{p, x, y}
	chat := l5ID(t, l5Want(t, p, 200, "POST", "/api/chats", `{"agent":"claude","group":"`+model.Ungrouped+`"}`))
	l5Open(t, e, chat, three...)
	l5AllSame(t, e, "the set-up", three...)
	path := "/api/chats/" + chat
	const (
		busy = `{"code":"busy","error":"the agent is still working; wait for it to finish or stop it"}`
		late = `{"error":"this permission request is no longer open; reload the page if it still looks open"}`
		done = `{"ok":true}`
	)
	// sent is a message by one of the three that must be taken, and then told to all of them:
	// the message in the thread and in the tree.
	sent := func(by *bridgetest.Page, query, body, text, branch string) {
		t.Helper()
		out := l5Want(t, by, 200, "POST", path+"/messages"+query, body)
		if branch != "" && out != `{"branch":"`+branch+`","ok":true}` {
			t.Fatalf("the message %q by %s: %s", text, by.ID, out)
		}
		evs := l5AllSame(t, e, "the message "+text+" by "+by.ID, three...)
		if l5Count(evs, "chat_items", chat, `"kind":"user"`, text) != 1 || l5Count(evs, "tree", chat, text) != 1 || l5Count(evs, "chat", chat, `"working":`) == 0 {
			t.Fatalf("the message %q by %s told %v", text, by.ID, evs)
		}
	}
	// replied ends the turn with an answer, which all three must see.
	replied := func(ag *apiAgent, text, point string) {
		t.Helper()
		reply(t, &ag.fakeAgent, text, point)
		evs := l5AllSame(t, e, "the reply "+text, three...)
		if l5Count(evs, "chat_items", chat, `"kind":"text"`, text) != 1 || l5Count(evs, "tree", chat, text) != 1 || l5Count(evs, "branch_state", chat, `"status":"ready"`) == 0 {
			t.Fatalf("the reply %q told %v", text, evs)
		}
	}
	// asked makes the agent ask for a permission, and returns when all three have the card.
	asked := func(ag *apiAgent, id string) {
		t.Helper()
		ag.ask(id)
		evs := make([][]string, 3)
		for i, c := range three {
			evs[i] = l5UpTo(t, c, "chat", chat, `"approvals":1`)
		}
		if got := l5SameOf(t, "the permission request "+id, evs, three...); l5Count(got, "chat_items", chat, `"kind":"perm"`, id) != 1 {
			t.Fatalf("the permission request %s told %v", id, got)
		}
	}

	// A client sends the first message of the owner's chat. While the branch works it takes no
	// message: not from the other client, not from the owner, not from the one who sent.
	sent(x, "", `{"text":"the first, by X"}`, "the first, by X", "main")
	ag := sp.of(t, chat) // the agent of main, which every message to main goes to
	for _, c := range []*bridgetest.Page{y, p, x} {
		status, out := l5Call(c, "POST", path+"/messages", `{"text":"while it works"}`)
		l5Is(t, "a message to a working branch by "+c.ID, status, out, 409, busy)
		status, out = l5Call(c, "POST", path+"/messages?branch=main", `{"text":"while it works"}`)
		l5Is(t, "a message to the working branch by name by "+c.ID, status, out, 409, busy)
	}
	if ag.sends.Load() != 1 || l5Started(sp) != 1 {
		t.Errorf("the refused messages reached the agent: %d sends, %d agents", ag.sends.Load(), l5Started(sp))
	}
	if evs := l5AllSame(t, e, "the refused messages", three...); len(evs) != 0 {
		t.Errorf("the refused messages told %v", evs)
	}

	// A permission request: every follower gets the card, anyone answers, the first answer
	// decides, a later one is refused.
	asked(ag, "perm-1")
	l5Is2 := func(what string, c *bridgetest.Page, id string, allow bool, want int, body string) {
		t.Helper()
		status, out := l5Call(c, "POST", path+"/permission", map[string]any{"requestId": id, "allow": allow})
		l5Is(t, what+" by "+c.ID, status, out, want, body)
	}
	l5Is2("the first answer", y, "perm-1", true, 200, done) // not the one who sent the message
	evs := l5AllSame(t, e, "the first answer", three...)
	if l5Count(evs, "chat_items", chat, "perm-1", `"decided":"allow"`) != 1 {
		t.Errorf("the first answer told %v", evs)
	}
	l5Is2("a later answer", x, "perm-1", false, 400, late)
	l5Is2("a later answer", p, "perm-1", false, 400, late)
	l5Is2("the same answer again", y, "perm-1", true, 400, late)
	// The owner's page is first for the next one, and denies.
	asked(ag, "perm-2")
	l5Is2("the owner's answer", p, "perm-2", false, 200, done)
	l5Is2("a client's later answer", x, "perm-2", true, 400, late)
	l5Is2("the other client's later answer", y, "perm-2", true, 400, late)
	l5Is2("an answer to a request that never was", x, "perm-9", true, 400, late)
	if got := ag.answered(); !slices.Equal(got, []string{"perm-1 true", "perm-2 false"}) {
		t.Errorf("the agent was answered %v", got)
	}
	if evs := l5AllSame(t, e, "the second request's answers", three...); l5Count(evs, "chat_items", chat, "perm-2", `"decided":"deny"`) != 1 || l5Count(evs, "chat_items") != 1 {
		t.Errorf("the answers to the second request told %v", evs)
	}
	// Anyone stops the turn.
	if out := l5Want(t, y, 200, "POST", path+"/interrupt", nil); out != done {
		t.Errorf("the stop by another client: %s", out)
	}
	replied(ag, "the first answer", "point-1")

	// Now the branch is ready: the next message is whoever's comes first.
	sent(y, "", `{"text":"the second, by Y"}`, "the second, by Y", "main")
	status, out := l5Call(x, "POST", path+"/messages", `{"text":"too late"}`)
	l5Is(t, "a message after another client's", status, out, 409, busy)
	replied(ag, "the second answer", "point-2")
	sent(p, "", `{"text":"the third, by the owner"}`, "the third, by the owner", "main")
	status, out = l5Call(y, "POST", path+"/messages", `{"text":"too late"}`)
	l5Is(t, "a message after the owner's", status, out, 409, busy)
	replied(ag, "the third answer", "point-3")
	if ag.sends.Load() != 3 || l5Started(sp) != 1 {
		t.Errorf("three messages to main were %d sends to %d agents", ag.sends.Load(), l5Started(sp))
	}

	// The current branch is one per chat. A client starts a branch after the first turn: it is
	// the current one for all. The other branches may work meanwhile.
	at := 0 // the end of main's first turn
	for _, it := range decode[struct {
		Branches []struct{ Items []struct{ End int } }
	}](t, l5Want(t, x, 200, "GET", path+"/tree", nil)).Branches[0].Items {
		if at == 0 && it.End > 0 {
			at = it.End
		}
	}
	out = l5Want(t, x, 200, "POST", path+"/messages", fmt.Sprintf(`{"text":"another way, by X","target":{"branch":"main","at":%d,"new":true}}`, at))
	side := decode[struct{ Branch string }](t, out).Branch
	if side == "" || side == "main" {
		t.Fatalf("the message that starts a branch: %s", out)
	}
	evs = l5AllSame(t, e, "the new branch", three...)
	if l5Count(evs, "tree", chat, `"current":"`+side+`"`, "another way, by X") != 1 || l5Count(evs, "chat", chat, `"branch":"`+side+`"`, `"branches":2`) == 0 ||
		l5Count(evs, "branch_state", chat, `"branch":"`+side+`"`) == 0 {
		t.Fatalf("the new branch told %v", evs)
	}
	current := func(what, want string) {
		t.Helper()
		for _, c := range three {
			if got := decode[struct{ Current string }](t, l5Want(t, c, 200, "GET", path+"/tree", nil)).Current; got != want {
				t.Errorf("%s: %s reads the current branch as %q, want %q", what, c.ID, got, want)
			}
		}
	}
	current("after a client started a branch", side)
	if l5Started(sp) != 2 {
		t.Fatalf("the branch started no agent of its own: %d agents", l5Started(sp))
	}
	sp.mu.Lock()
	sideAgent := sp.agents[1] // the branch's own agent, started for its first message
	sp.mu.Unlock()
	// The new branch works, main does not: main takes the other client's message, and is the
	// current branch from then on. The last message decides.
	status, out = l5Call(p, "POST", path+"/messages?branch="+side, `{"text":"while it works"}`)
	l5Is(t, "a message to the working branch by the owner", status, out, 409, busy)
	sent(y, "?branch=main", `{"text":"the fourth, by Y"}`, "the fourth, by Y", "main")
	current("after the other client's message to main", "main")
	replied(sideAgent, "the answer of the branch", "point-4")
	replied(ag, "the fourth answer", "point-5")
	sent(p, "?branch="+side, `{"text":"on the branch, by the owner"}`, "on the branch, by the owner", side)
	current("after the owner's message to the branch", side)
	replied(sideAgent, "the answer to the owner", "point-6")

	// POST …/open reads a branch for the caller and decides nothing for the others: whichever
	// branch each of the three opens, in whatever order, the chat's current branch stays, and
	// nobody is told anything.
	for _, c := range []struct {
		by     *bridgetest.Page
		branch string
	}{{x, "main"}, {y, side}, {p, "main"}, {y, "main"}, {x, side}, {p, ""}, {x, ""}} {
		q := ""
		if c.branch != "" {
			q = "?branch=" + c.branch
		}
		if out := l5Want(t, c.by, 200, "POST", path+"/open"+q, nil); out != done {
			t.Errorf("open%s by %s: %s", q, c.by.ID, out)
		}
	}
	current("after the opens", side)
	for _, c := range three {
		status, out := l5Call(c, "POST", path+"/open?branch=nothere", nil)
		l5Is(t, "the open of a branch the chat does not have by "+c.ID, status, out, 404, `{"error":"no such branch"}`)
	}
	if evs := l5AllSame(t, e, "the opens", three...); len(evs) != 0 {
		t.Errorf("the opens told %v", evs)
	}

	// A follow ends with the unfollow: that client is told the list events of the chat and no
	// more of its thread.
	l5Want(t, y, 200, "POST", path+"/unfollow", nil)
	l5Want(t, x, 200, "POST", path+"/messages?branch=main", `{"text":"the last, by X"}`)
	got := e.reach(three...)
	if a, b := l5SameOf(t, "the message after the unfollow", got[:2], p, x), only(got[2], "chat_items", "tree"); l5Count(a, "chat_items", "the last, by X") != 1 || len(b) != 0 {
		t.Errorf("after Y's unfollow the followers were sent %v and Y %v", l5Types(a), b)
	}
	if !slices.Equal(only(got[2], l5List...), only(got[0], l5List...)) || len(only(got[2], "chat")) == 0 {
		t.Errorf("after its unfollow Y was sent the list events %v, the owner's page %v", l5Types(only(got[2], l5List...)), l5Types(only(got[0], l5List...)))
	}
}

// A board has one holder among the owner's pages and all clients. Any client reads the drawing
// of a board the owner made and, when it holds the board, writes it.
func TestLevel5OneHolderOfABoard(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	p, x, y := l5Trio(e, l)
	three := []*bridgetest.Page{p, x, y}
	board := l5ID(t, l5Want(t, p, 200, "POST", "/api/boards", `{"name":"plan","group":"`+model.Ungrouped+`","new":true}`))
	l5AllSame(t, e, "the set-up", three...)
	path := "/api/boards/" + board
	drawing := func(n int) string { return fmt.Sprintf(`{"type":"excalidraw","elements":[{"id":"shape-%d"}]}`, n) }
	const (
		elsewhere = `{"code":"not_holder","error":"another window holds this board"}`
		nobody    = `{"code":"not_holder","error":"this window does not hold the board"}`
	)
	stale := func(rev int) string {
		return fmt.Sprintf(`{"code":"stale","error":"the board was changed elsewhere","rev":%d}`, rev)
	}
	holder := func(what, want string) {
		t.Helper()
		if want != "" {
			want = idOf(want)
		}
		if got, _ := e.s.Bridge.HolderOf(board); got != want {
			t.Errorf("%s: the board is held by %q, want %q", what, got, want)
		}
	}
	// roles reads what the three were sent, which must be these role events and nothing else.
	roles := func(what string, want ...[]string) {
		t.Helper()
		for i, evs := range e.reach(three...) {
			var typs []string
			for _, raw := range evs {
				typs = append(typs, typeOf(raw))
				if !strings.Contains(raw, `"board":"`+board+`"`) {
					t.Errorf("%s: %s was sent %s", what, three[i].ID, raw)
				}
			}
			if !slices.Equal(typs, want[i]) {
				t.Errorf("%s: %s was sent %v, want %v", what, three[i].ID, evs, want[i])
			}
		}
	}

	// The owner's page made the board and holds it. A client reads the drawing of it all the
	// same: there is no board of the server it is answered "no such board" for.
	holder("after the owner made the board", l5Owner)
	l5Want(t, p, 200, "PUT", path+"/scene?rev=0", drawing(1))
	for _, c := range []*bridgetest.Page{x, y} {
		if scene := l5Want(t, c, 200, "GET", path+"/scene", nil); !l5Same(t, scene, drawing(1)) {
			t.Errorf("%s reads the owner's drawing as %s", c.ID, scene)
		}
		// It does not hold the board: its write is refused, whatever the revision.
		for _, rev := range []string{"0", "1", "9"} {
			status, out := l5Call(c, "PUT", path+"/scene?rev="+rev, drawing(2))
			l5Is(t, "the write of a client that does not hold the board, on the revision "+rev, status, out, 409, elsewhere)
		}
	}
	// A take "if free" leaves the board where it is and tells nobody.
	if out := l5Want(t, x, 200, "POST", path+"/take", `{"ifFree":true}`); out != `{"state":"busy"}` {
		t.Errorf("a client's take if free of a board the owner holds: %s", out)
	}
	if out := l5Want(t, y, 200, "POST", path+"/release", nil); out != `{"state":"none"}` {
		t.Errorf("the release of a client that holds nothing: %s", out)
	}
	roles("a take if free", nil, nil, nil)
	holder("after a take if free", l5Owner)

	// The hand-over to a client: the owner's page is asked, writes what it has and lets go; the
	// client is told it holds the board, with the revision of that last write.
	if out := l5Want(t, x, 200, "POST", path+"/take", nil); out != `{"state":"waiting"}` {
		t.Errorf("a client's take of a board the owner holds: %s", out)
	}
	roles("a client's take", []string{"release_request"}, nil, nil)
	if out := l5Want(t, p, 200, "PUT", path+"/scene?rev=1", drawing(2)); out != `{"ok":true,"rev":2}` {
		t.Errorf("the owner's last write before it lets go: %s", out)
	}
	if out := l5Want(t, p, 200, "POST", path+"/release", nil); out != `{"state":"handed"}` {
		t.Errorf("the owner's release to the client that waits: %s", out)
	}
	got := e.reach(three...)
	if len(got[0]) != 1 || typeOf(got[0][0]) != "superseded" || len(got[1]) != 1 || !l5Same(t, got[1][0], `{"type":"held","board":"`+board+`","rev":2}`) || len(got[2]) != 0 {
		t.Errorf("the hand-over sent the owner %v, the client that waited %v and the other %v", got[0], got[1], got[2])
	}
	holder("after the hand-over", apiX)
	// The client that holds it writes; a write on a revision of before is refused with the
	// stored one; the owner's page, which no longer holds it, is refused as a client was.
	status, out := l5Call(x, "PUT", path+"/scene?rev=1", drawing(3))
	l5Is(t, "the holder's write on an old revision", status, out, 409, stale(2))
	if out := l5Want(t, x, 200, "PUT", path+"/scene?rev=2", drawing(3)); out != `{"ok":true,"rev":3}` {
		t.Errorf("the write of the client that holds the board: %s", out)
	}
	status, out = l5Call(p, "PUT", path+"/scene?rev=3", drawing(4))
	l5Is(t, "the write of the owner's page, which no longer holds the board", status, out, 409, elsewhere)
	status, out = l5Call(y, "PUT", path+"/scene?rev=3", drawing(4))
	l5Is(t, "the write of the other client", status, out, 409, elsewhere)
	for _, c := range three {
		if scene := l5Want(t, c, 200, "GET", path+"/scene", nil); !l5Same(t, scene, drawing(3)) {
			t.Errorf("%s reads the client's drawing as %s", c.ID, scene)
		}
	}

	// Two wait for one board: the later one takes the place of the earlier, which is told so.
	if out := l5Want(t, y, 200, "POST", path+"/take", nil); out != `{"state":"waiting"}` {
		t.Errorf("the other client's take: %s", out)
	}
	roles("the other client's take", nil, []string{"release_request"}, nil)
	if out := l5Want(t, p, 200, "POST", path+"/take", nil); out != `{"state":"waiting"}` {
		t.Errorf("the owner's take while a client waits: %s", out)
	}
	roles("the owner's take while a client waits", nil, nil, []string{"superseded"})
	if out := l5Want(t, x, 200, "POST", path+"/release", nil); out != `{"state":"handed"}` {
		t.Errorf("the client's release to the owner's page: %s", out)
	}
	got = e.reach(three...)
	if len(got[0]) != 1 || !l5Same(t, got[0][0], `{"type":"held","board":"`+board+`","rev":3}`) || len(got[1]) != 1 || typeOf(got[1][0]) != "superseded" || len(got[2]) != 0 {
		t.Errorf("the hand-over back sent the owner %v, the client that held it %v and the other %v", got[0], got[1], got[2])
	}
	holder("after the hand-over back", l5Owner)
	// A second page of the owner is one more user of the same board.
	p2 := e.page(l5Owner2)
	if out := l5Want(t, p2, 200, "POST", path+"/take", `{"ifFree":true}`); out != `{"state":"busy"}` {
		t.Errorf("the take if free of the owner's second page: %s", out)
	}
	// A free board goes to whoever takes it, at once, with its revision.
	if out := l5Want(t, p, 200, "POST", path+"/release", nil); out != `{"state":"free"}` {
		t.Errorf("the owner's release with nobody waiting: %s", out)
	}
	for _, c := range three {
		status, out := l5Call(c, "PUT", path+"/scene?rev=3", drawing(4))
		l5Is(t, "a write to a board nobody holds by "+c.ID, status, out, 409, nobody)
	}
	if out := l5Want(t, y, 200, "POST", path+"/take", `{"ifFree":true}`); !l5Same(t, out, `{"state":"held","rev":3}`) {
		t.Errorf("a client's take of a free board: %s", out)
	}
	if out := l5Want(t, y, 200, "POST", path+"/take", nil); !l5Same(t, out, `{"state":"held","rev":3}`) {
		t.Errorf("the take of the client that holds the board already: %s", out)
	}
	holder("after a client took the free board", apiY)
	if out := l5Want(t, y, 200, "PUT", path+"/scene?rev=3", drawing(4)); out != `{"ok":true,"rev":4}` {
		t.Errorf("the write of the second client: %s", out)
	}
	roles("the takes of a free board", nil, nil, nil)

	// "New" is one mark per board: the first seen clears it for all, and a second changes nothing.
	if boards := l5Field(t, l5Want(t, x, 200, "GET", "/api/state", nil), "boards"); !strings.Contains(boards, `"new":true`) {
		t.Fatalf("the board before it was seen: %s", boards)
	}
	l5Want(t, x, 200, "POST", path+"/seen", nil)
	evs := l5AllSame(t, e, "the first seen", three...)
	if len(evs) != 1 || l5Count(evs, "board", board) != 1 || strings.Contains(evs[0], `"new"`) {
		t.Errorf("the first seen told %v", evs)
	}
	l5Want(t, p, 200, "POST", path+"/seen", nil)
	l5Want(t, y, 200, "POST", path+"/seen", nil)
	for _, raw := range l5AllSame(t, e, "the later seens", three...) {
		if typeOf(raw) != "board" || strings.Contains(raw, `"new"`) {
			t.Errorf("a later seen told %s", raw)
		}
	}
	for _, c := range three {
		if boards := l5Field(t, l5Want(t, c, 200, "GET", "/api/state", nil), "boards"); strings.Contains(boards, `"new"`) {
			t.Errorf("%s reads the board as new after it was seen: %s", c.ID, boards)
		}
	}

	// A chat on the owner's board, made by the owner; after its first turn a client forks it.
	// The fork is made, on the same board.
	chat := l5ID(t, l5Want(t, p, 200, "POST", "/api/chats", `{"agent":"claude","board":"`+board+`"}`))
	l5Want(t, p, 200, "POST", "/api/chats/"+chat+"/messages", `{"text":"draw a plan"}`)
	reply(t, &sp.of(t, chat).fakeAgent, "Drawn.", "point-1")
	l5AllSame(t, e, "the chat on the board", three...)
	out = l5Want(t, x, 200, "POST", "/api/chats/"+chat+"/fork", `{"branch":"main","at":3}`)
	fork := decode[model.ChatView](t, out)
	if fork.ID == chat || fork.Board != board || fork.Group != "" || !strings.Contains(out, `"forkedFrom":"`+chat+`"`) {
		t.Errorf("a client's fork of a chat on the owner's board: %s", out)
	}
	if evs := l5AllSame(t, e, "a client's fork", three...); l5Count(evs, "chat", fork.ID, `"board":"`+board+`"`) != 1 {
		t.Errorf("a client's fork told %v", evs)
	}
	if items := l5Want(t, p, 200, "GET", "/api/chats/"+fork.ID+"/items", nil); !strings.Contains(items, "draw a plan") || !strings.Contains(items, "Drawn.") {
		t.Errorf("the owner reads the fork as %s", items)
	}
}
