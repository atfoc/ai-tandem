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
		for _, body := range []string{`{"agent":"claude"}`, `{"agent":"cursor"}`} {
			if msg := e.refusedWith(409, "", "PATCH", path, body); !strings.Contains(msg, "has not started") {
				t.Fatalf("%s, PATCH %s: %q", what, body, msg)
			}
		}
		// The server is fixed for every chat, a fork and a branch among them.
		if msg := e.refusedWith(409, "server_fixed", "PATCH", path, `{"server":"local"}`); !strings.Contains(msg, "chosen when the chat is made") {
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

// A server of this build is at the level that serves a client as the server's own page, and it
// serves no client below that level.
func TestFeatureLevel(t *testing.T) {
	t.Parallel()
	if FeatureLevel != 5 || MinClientLevel != 5 || servers.LevelHeader != "X-AIWB-Level" {
		t.Fatalf("the level %d, the lowest client level served %d, in the header %q; want 5, 5 and X-AIWB-Level", FeatureLevel, MinClientLevel, servers.LevelHeader)
	}
}

// A server of this build is one this build connects to, and the stand-in of the suites is such
// a server.
func TestFeatureLevelOfBothHalves(t *testing.T) {
	t.Parallel()
	if servers.MinFeatureLevel != FeatureLevel {
		t.Fatalf("the level %d, the lowest level connected to %d", FeatureLevel, servers.MinFeatureLevel)
	}
	if standin.DefaultFeatureLevel != FeatureLevel {
		t.Fatalf("the stand-in reports the level %d, a server of this build %d", standin.DefaultFeatureLevel, FeatureLevel)
	}
}

// Nothing of a server that is "too old" can be reached from this app: nothing is made on it,
// started on it, opened from it or changed on it. Its section has no tree, every call for a
// thing of it is refused here with the sentence that says why, and nothing is sent, the hello
// the entry asks again by itself apart. Once that server is updated the entry connects by
// itself, with nothing done here, and all of it opens (AC5).
func TestNothingReachesATooOldServer(t *testing.T) {
	t.Parallel()
	const tooOld = "Studio is too old: update the server on that machine."
	for name, level := range map[string]*int{"lower": standin.Level(servers.MinFeatureLevel - 1), "missing": nil} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			f := newFar(t, farOpt{
				chats: []model.ChatView{viewThere(farChatA)}, boards: []model.Board{boardThere(farBoardA)},
				tooOld: 40 * time.Millisecond,
			})
			p := f.page("P")
			chat, board := f.on("/chats/"+farChatA), f.on("/boards/"+farBoardA)
			own := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", model.Ungrouped)))

			gone := f.nulls.Load() + 1
			f.st.SetFeatureLevel(level)
			f.st.DropStreams()
			f.wait("the entry is too old, and its tree is gone", func() bool {
				return f.state() == servers.StateTooOld && f.nulls.Load() >= gone
			})
			before := len(f.st.Requests())

			f.untouched("a server that is too old", func() {
				for _, c := range [][3]string{
					// Nothing is made on it.
					{"POST", f.on("/chats"), form("group", farGroup)}, {"POST", f.on("/boards"), form("name", "New", "group", farGroup)}, {"POST", f.on("/groups"), form("name", "New", "parent", "")},
					// Its chats.
					{"GET", chat, ""}, {"GET", chat + "/items", ""}, {"GET", chat + "/tree", ""}, {"GET", chat + "/context", ""}, {"POST", chat + "/open", ""},
					{"POST", chat + "/messages", `{"text":"hi"}`}, {"POST", chat + "/fork", `{"at":1}`},
					{"PUT", chat + "/draft?rev=0", `{"text":"typed"}`}, {"PATCH", chat, form("model", "standin-model")},
					// Its whiteboards: no board is taken, and no drawing is read or stored.
					{"POST", board + "/take", ""}, {"GET", board + "/scene", ""}, {"PUT", board + "/scene?rev=0", `{}`},
					{"POST", board + "/rename", form("name", "Later")},
					// What it would offer for a new chat.
					{"GET", "/api/dirs?server=" + f.entry, ""}, {"GET", "/api/usage/claude?server=" + f.entry, ""},
				} {
					if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", c[0], c[1], c[2]); text != tooOld {
						t.Errorf("%s %s: %q", c[0], c[1], text)
					}
				}
				// The calls that are answered in every state: a page lets go of what it
				// showed, and a board on another machine has no file here.
				f.good(p, "POST", chat+"/unfollow", "")
				if got := f.good(p, "POST", board+"/release", ""); got["state"] != "none" {
					t.Errorf("the release of a board while its server is too old: %v", got)
				}
				f.refuses(p, http.StatusBadRequest, "not_here", "POST", board+"/reveal", "")
				// A chat of this server is not put on it.
				f.refuses(p, http.StatusConflict, "server_fixed", "PATCH", "/api/chats/"+own.ID, form("server", f.entry))
				// Its section has no tree, and this server's own lists hold nothing of it.
				if snap := f.snapshotOf(p); len(snap.Sections) != 0 || len(snap.Chats) != 1 || len(snap.Boards) != 0 {
					t.Errorf("the snapshot while the server is too old: sections %v, own chats %d, boards %d",
						snap.Sections, len(snap.Chats), len(snap.Boards))
				}
			})
			// The entry asked again meanwhile, and stayed too old: hello alone went out.
			f.wait("the entry asks again", func() bool { return len(f.st.Requests()) >= before+2 })
			for _, r := range f.st.Requests()[before:] {
				if r.Path != servers.HelloPath {
					t.Fatalf("the too old server was sent %s %s", r.Method, r.Path)
				}
			}
			if f.state() != servers.StateTooOld {
				t.Fatalf("the entry while its server is too old: %s", f.state())
			}

			// That server is updated. Nothing is done here.
			f.st.SetFeatureLevel(standin.Level(standin.DefaultFeatureLevel))
			f.returned(2)
			f.wait("the entry is connected", func() bool { return f.state() == servers.StateConnected })
			f.good(p, "GET", chat+"/items", "")
			if status, out := f.call(p, "GET", board+"/scene", ""); status != http.StatusOK {
				t.Errorf("the drawing after the update: %d %s", status, out)
			}
			if made := decode[model.ChatView](t, mustOK(t, f, p, "POST", f.on("/chats"), form("group", farGroup))); made.ID == "" || made.Locked {
				t.Errorf("a new chat after the update: %+v", made)
			}
			if sec := f.section(p); sec == nil || len(sec.Chats) != 1 || len(sec.Boards) != 1 {
				t.Errorf("the section after the update: %+v", sec)
			}
		})
	}
}
