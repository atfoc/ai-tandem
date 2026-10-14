package server

import (
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// Tests of acceptance criteria whose clauses the other files leave open.

// AC30: the agent and the server are fixed for a fork, which has no message of its own, and for
// a branch, at the routes. The chat is the worked example: started, idle, with one branch.
func TestAgentAndServerAreFixedForAForkAndABranch(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id := e.branchedChat()
	chat := "/api/chats/" + id

	// A fork at the start of the chat: a chat with no item, whose model the page may still choose.
	fork := decode[model.ChatView](t, e.expect(200, "POST", chat+"/fork", `{"branch":"main","at":0}`))
	if fork.ID == "" || fork.ID == id || fork.ForkedFrom != id || fork.Agent != model.Claude || fork.Locked {
		t.Fatalf("the fork: %+v", fork)
	}
	at := "/api/chats/" + fork.ID
	if n := len(decode[struct{ Items []any }](t, e.expect(200, "GET", at+"/items", "")).Items); n != 0 {
		t.Fatalf("the fork at the start has %d items", n)
	}
	// A new branch of the chat at its start: the branch the message is put on. The example has
	// no folder, and a process starts in one.
	e.expect(200, "PATCH", chat+"?branch=main", `{"cwd":"`+e.a.DefaultCwd+`"}`)
	sent := decode[struct{ Branch string }](t, e.expect(200, "POST", chat+"/messages", `{"text":"aside","target":{"branch":"main","at":0,"new":true}}`))
	if sent.Branch == "" || sent.Branch == model.MainBranch || sent.Branch == "a1b2c3d4" {
		t.Fatalf("the message made no branch: %+v", sent)
	}
	fixed := func(what, path string) {
		t.Helper()
		for _, body := range []string{`{"agent":"claude"}`, `{"agent":"cursor"}`} {
			if msg := e.refusedWith(409, "", "PATCH", path, body); !strings.Contains(msg, "has not started") {
				t.Fatalf("%s, PATCH %s: %q", what, body, msg)
			}
		}
		// The server is fixed for every chat, a fork and a branch among them: a body that names
		// one is refused.
		if msg := e.refusedWith(400, "server_refused", "PATCH", path, `{"server":"local"}`); !strings.Contains(msg, "cannot name a server") {
			t.Fatalf("%s, a server: %q", what, msg)
		}
	}
	fixed("the fork", at)
	fixed("the fork with its branch named", at+"?branch=main")
	fixed("the new branch", chat+"?branch="+sent.Branch)
	fixed("the branch that was there", chat+"?branch=a1b2c3d4")
	// (The example's main branch is written by hand without the mark of a first message; what a
	// chat's own first message fixes is in TestChatCreateAndConfigureRoutes.)
	for _, c := range []string{id, fork.ID} {
		if got := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c, "")); got.Agent != model.Claude {
			t.Fatalf("the chat %s after the refused changes: %+v", c, got)
		}
	}
	// What is not fixed still changes: the fork's model and name.
	if p := decode[patched](t, e.expect(200, "PATCH", at, `{"name":"mine","model":"opus"}`)); p.Chat.Name != "mine" || p.Chat.Model != "opus" || p.Chat.Agent != model.Claude {
		t.Fatalf("the fork, configured: %+v", p)
	}
}

// A server of this build is at level 6, and it serves no client below that level.
func TestFeatureLevel(t *testing.T) {
	t.Parallel()
	if FeatureLevel != 6 || MinClientLevel != 6 || LevelHeader != "X-AIWB-Level" {
		t.Fatalf("the level %d, the lowest client level served %d, in the header %q; want 6, 6 and X-AIWB-Level", FeatureLevel, MinClientLevel, LevelHeader)
	}
}
