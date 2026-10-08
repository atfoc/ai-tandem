package server

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
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
		for _, body := range []string{`{"agent":"claude"}`, `{"agent":"cursor"}`, `{"server":"local"}`} {
			if msg := e.refusedWith(409, "", "PATCH", path, body); !strings.Contains(msg, "has not started") {
				t.Fatalf("%s, PATCH %s: %q", what, body, msg)
			}
		}
	}
	fixed("the fork", at)
	fixed("the fork with its branch named", at+"?branch=main")
	fixed("the new branch", chat+"?branch="+sent.Branch)
	fixed("the branch that was there", chat+"?branch=a1b2c3d4")
	// (The example's main branch is written by hand without the mark of a first message; what a
	// chat's own first message fixes is in TestChatCreateAndConfigureRoutes.)
	for _, c := range []string{id, fork.ID} {
		if got := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+c, "")); got.Agent != model.Claude || got.Server != "" {
			t.Fatalf("the chat %s after the refused changes: %+v", c, got)
		}
	}
	// What is not fixed still changes: the fork's model and name.
	if p := decode[patched](t, e.expect(200, "PATCH", at, `{"name":"mine","model":"opus"}`)); p.Chat.Name != "mine" || p.Chat.Model != "opus" || p.Chat.Agent != model.Claude {
		t.Fatalf("the fork, configured: %+v", p)
	}
}

// AC5: on a server that is "too old" no chat and no run can be started. The entry was connected,
// so this server has a chat and a draft run that wait on it; then that server answers hello with
// a level below the minimum, or with none. Every way to put something on it or to start what
// waits there is refused, and nothing is sent to it.
func TestNothingStartsOnATooOldServer(t *testing.T) {
	t.Parallel()
	for name, level := range map[string]*int{"lower": standin.Level(servers.MinFeatureLevel - 1), "missing": nil} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			f := newFar(t, farOpt{local: true})
			p := f.page("P")
			g := f.group(p, "Work", "")
			there := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", g, "server", f.entry)))
			own := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", g, "server", "local")))
			d := f.remoteDraft(p, g)
			ld := decode[model.RunView](t, mustOK(t, f, p, "POST", "/api/runs", form("group", g)))
			if there.Server != f.entry || d.Server != f.entry || d.Status != model.RunDraft {
				t.Fatalf("what waits on the entry: the chat %+v, the draft %+v", there, d)
			}

			f.st.SetFeatureLevel(level)
			f.st.DropStreams()
			f.wait("the entry is too old", func() bool {
				v, _ := f.m.View(f.entry)
				return v.State == servers.StateTooOld
			})
			before := len(f.st.Requests())

			f.untouched("a server that is too old", func() {
				f.refuses(p, http.StatusConflict, "server_unusable", "POST", "/api/chats", form("group", g, "server", f.entry))
				f.refuses(p, http.StatusConflict, "server_unusable", "PATCH", "/api/chats/"+own.ID, form("server", f.entry))
				f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "POST", "/api/chats/"+there.ID+"/messages", `{"text":"hello"}`)
				f.refuses(p, http.StatusConflict, "server_unusable", "PATCH", "/api/runs/"+ld.ID, form("server", f.entry))
				f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "POST", "/api/runs/"+d.ID+"/start", form("goal", "Write the note"))
				time.Sleep(300 * time.Millisecond)
			})
			if got := f.st.Requests(); len(got) != before {
				t.Errorf("the too old server was sent %+v", got[before:])
			}

			// Nothing started, and nothing moved.
			if cv, ok := f.chatNow(p, there.ID); !ok || cv.Locked || cv.Server != f.entry {
				t.Errorf("the chat on the entry after the refused message: %+v, %v", cv, ok)
			}
			if _, waits := f.a.Chats.RemoteUnstarted(there.ID); !waits || f.rm.Has(there.ID) {
				t.Error("the chat on the entry no longer waits for its first message")
			}
			if cv, ok := f.chatNow(p, own.ID); !ok || cv.Locked || cv.Server == f.entry {
				t.Errorf("the chat of this server after the refused change: %+v, %v", cv, ok)
			}
			if rv, ok := f.runNow(p, d.ID); !ok || rv.Status != model.RunDraft || rv.Server != f.entry || !rv.Started.IsZero() || f.rm.HasRun(d.ID) {
				t.Errorf("the draft on the entry after the refused start: %+v, %v", rv, ok)
			}
			if rv, ok := f.runNow(p, ld.ID); !ok || rv.Status != model.RunDraft || rv.Server == f.entry {
				t.Errorf("the draft of this server after the refused change: %+v, %v", rv, ok)
			}
		})
	}
}
