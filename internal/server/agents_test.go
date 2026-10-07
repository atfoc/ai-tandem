package server

import (
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// fakePath is a look-up of programs a test changes while the server runs.
type fakePath struct {
	mu   sync.Mutex
	have map[string]bool
}

func (p *fakePath) look(bin string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.have[bin] {
		return "", errors.New("not found")
	}
	return "/bin/" + bin, nil
}

func (p *fakePath) set(bins ...string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.have = map[string]bool{}
	for _, b := range bins {
		p.have[b] = true
	}
}

// agentsOf is a set over a fakePath that has the given programs; each kind's program is its name.
func agentsOf(bins ...string) (*usable.Set, *fakePath) {
	p := &fakePath{}
	p.set(bins...)
	return usable.NewWith(map[model.AgentKind]string{model.Claude: "claude", model.Cursor: "cursor", model.Pi: "pi"}, p.look), p
}

type refusal struct{ Error, Code string }

// refusedWith expects the status and the refusal's code, and returns the error text.
func (e *env) refusedWith(status int, code, method, path, body string) string {
	e.t.Helper()
	r := decode[refusal](e.t, e.expect(status, method, path, body))
	if r.Code != code || r.Error == "" {
		e.t.Fatalf("%s %s: code %q, error %q, want code %q", method, path, r.Code, r.Error, code)
	}
	return r.Error
}

type patched struct {
	OK   bool
	Chat model.ChatView
}

// A chat is made without an agent or with a given id, and its agent and server are chosen with
// PATCH until its first message (AC30).
func TestChatCreateAndConfigureRoutes(t *testing.T) {
	e := newEnv(t)
	group := `"group":"` + model.Ungrouped + `"`

	cv := decode[model.ChatView](t, e.expect(200, "POST", "/api/chats", `{`+group+`}`))
	if cv.Agent != model.Claude || cv.ID == "" {
		t.Fatalf("a chat made without an agent: %+v", cv)
	}
	chat := "/api/chats/" + cv.ID

	p := decode[patched](t, e.expect(200, "PATCH", chat, `{"agent":"cursor"}`))
	if !p.OK || p.Chat.ID != cv.ID || p.Chat.Agent != model.Cursor {
		t.Fatalf("PATCH agent answered %+v", p)
	}
	if got := decode[model.ChatView](t, e.expect(200, "GET", chat, "")); got.Agent != model.Cursor {
		t.Fatalf("agent after PATCH = %q", got.Agent)
	}
	// The local server is the only one, and naming it changes nothing.
	if p := decode[patched](t, e.expect(200, "PATCH", chat, `{"server":"local"}`)); p.Chat.Agent != model.Cursor {
		t.Fatalf("PATCH server answered %+v", p)
	}
	// A change of the name alone answers with the chat too.
	if p := decode[patched](t, e.expect(200, "PATCH", chat, `{"name":"mine"}`)); !p.OK || p.Chat.Name != "mine" {
		t.Fatalf("PATCH name answered %+v", p)
	}
	e.refusedWith(400, "", "PATCH", chat, `{"agent":"nobody"}`)
	if msg := e.refusedWith(400, "", "PATCH", chat, `{"server":"elsewhere"}`); !strings.Contains(msg, `unknown server "elsewhere"`) {
		t.Fatalf("unknown server: %q", msg)
	}
	e.refusedWith(400, "", "POST", "/api/chats", `{`+group+`,"agent":"nobody"}`)

	// A given id: a lowercase version 4 UUID that no chat has.
	const id = "0b0e6a52-3c1f-4d7a-9e55-0123456789ab"
	if got := decode[model.ChatView](t, e.expect(200, "POST", "/api/chats", `{`+group+`,"id":"`+id+`","agent":"cursor"}`)); got.ID != id || got.Agent != model.Cursor {
		t.Fatalf("a chat made with an id: %+v", got)
	}
	e.refusedWith(409, "", "POST", "/api/chats", `{`+group+`,"id":"`+id+`"}`)
	for _, bad := range []string{"../../etc", "a/b", strings.ToUpper(id), "0b0e6a52-3c1f-1d7a-9e55-0123456789ab"} {
		e.refusedWith(400, "", "POST", "/api/chats", `{`+group+`,"id":"`+bad+`"}`)
	}
	if n := len(e.a.Chats.Views()); n != 2 {
		t.Fatalf("%d chats after the refused creations, want 2", n)
	}

	// After the first message the agent and the server are fixed; the name is not.
	e.expect(200, "POST", chat+"/messages", `{"text":"hello"}`)
	for _, body := range []string{`{"agent":"claude"}`, `{"server":"local"}`} {
		if msg := e.refusedWith(409, "", "PATCH", chat, body); !strings.Contains(msg, "has not started") {
			t.Fatalf("PATCH %s after a message: %q", body, msg)
		}
	}
	if got := decode[model.ChatView](t, e.expect(200, "GET", chat, "")); got.Agent != model.Cursor {
		t.Fatalf("agent after the refused PATCH = %q", got.Agent)
	}
	e.expect(200, "PATCH", chat, `{"name":"still mine"}`)
}

// An agent whose program the server does not find is refused with 409 and "agent_missing" at
// creation, configuration, a draft run's patch and the first message; a chat with no agent is
// refused with "no_agent". The look-up changes while the server runs (AC44).
func TestAgentOutsideTheUsableOnes(t *testing.T) {
	e := newRunEnv(t)
	set, path := agentsOf("claude")
	e.cm.Agents, e.rs.Agents, e.a.Agents = set, set, set
	group := `"group":"` + model.Ungrouped + `"`
	snapAgents := func() []model.AgentKind {
		return decode[struct{ Agents []model.AgentKind }](t, e.expect(200, "GET", "/api/state", "")).Agents
	}
	if got := snapAgents(); !slices.Equal(got, []model.AgentKind{model.Claude}) {
		t.Fatalf("snapshot agents = %v", got)
	}

	cv := decode[model.ChatView](t, e.expect(200, "POST", "/api/chats", `{`+group+`}`))
	if cv.Agent != model.Claude {
		t.Fatalf("a new chat's agent = %q", cv.Agent)
	}
	chat := "/api/chats/" + cv.ID
	run := e.newRun()

	msg := e.refusedWith(409, "agent_missing", "POST", "/api/chats", `{`+group+`,"agent":"cursor"}`)
	if !strings.Contains(msg, "Cursor") || !strings.Contains(msg, "not found") {
		t.Fatalf("creation: %q", msg)
	}
	e.refusedWith(409, "agent_missing", "PATCH", chat, `{"agent":"cursor"}`)
	e.refusedWith(409, "agent_missing", "PATCH", "/api/runs/"+run.ID, `{"agent":"cursor"}`)
	runs := decode[struct{ Runs []model.RunView }](t, e.expect(200, "GET", "/api/state", "")).Runs
	if len(runs) != 1 || runs[0].Agent != model.Claude {
		t.Fatalf("the runs after the refused patch: %+v", runs)
	}
	if n := len(e.cm.Views()); n != 1 {
		t.Fatalf("%d chats after the refused creation, want 1", n)
	}

	// Cursor is installed: the same calls pass.
	path.set("claude", "cursor")
	if p := decode[patched](t, e.expect(200, "PATCH", chat, `{"agent":"cursor"}`)); p.Chat.Agent != model.Cursor {
		t.Fatalf("PATCH agent answered %+v", p)
	}
	if v := e.view(200, "PATCH", "/api/runs/"+run.ID, `{"agent":"cursor"}`); v.Agent != model.Cursor {
		t.Fatalf("the run's agent = %q", v.Agent)
	}
	if got := snapAgents(); !slices.Equal(got, []model.AgentKind{model.Claude, model.Cursor}) {
		t.Fatalf("snapshot agents = %v", got)
	}

	// Cursor is removed again: the chat keeps it and its first message is refused, with nothing left.
	path.set("claude")
	e.refusedWith(409, "agent_missing", "POST", chat+"/messages", `{"text":"hello"}`)
	if got := decode[model.ChatView](t, e.expect(200, "GET", chat, "")); got.Agent != model.Cursor || got.Locked {
		t.Fatalf("the chat after the refused message: %+v", got)
	}

	// No program at all: a chat is still made, with no agent, and its message answers "no_agent".
	path.set()
	set.Refresh() // what Watch does every usable.Every
	if got := snapAgents(); got == nil || len(got) != 0 {
		t.Fatalf("snapshot agents = %#v, want an empty array", got)
	}
	none := decode[model.ChatView](t, e.expect(200, "POST", "/api/chats", `{`+group+`}`))
	if none.Agent != "" || none.Model != "" {
		t.Fatalf("a chat made with no usable agent: %+v", none)
	}
	e.refusedWith(409, "no_agent", "POST", "/api/chats/"+none.ID+"/messages", `{"text":"hello"}`)
	e.refusedWith(409, "agent_missing", "PATCH", "/api/chats/"+none.ID, `{"agent":"claude"}`)

	// Claude is back: the chat with no agent takes it by a PATCH.
	path.set("claude")
	if p := decode[patched](t, e.expect(200, "PATCH", "/api/chats/"+none.ID, `{"agent":"claude"}`)); p.Chat.Agent != model.Claude {
		t.Fatalf("PATCH agent answered %+v", p)
	}
}

// What main gives Watch: a change of the usable agents reaches a connected client as an "agents"
// event with the new list.
func TestAgentsEventReachesAClient(t *testing.T) {
	e := newRunEnv(t)
	set, path := agentsOf("claude")
	e.cm.Agents, e.rs.Agents, e.a.Agents = set, set, set
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		set.Watch(10*time.Millisecond, stop, func(l []model.AgentKind) {
			e.s.Bridge.Broadcast(map[string]any{"type": "agents", "agents": l})
		})
	}()
	t.Cleanup(func() { close(stop); <-done })

	last := func(evs []runTestEvent) string {
		for i := len(evs) - 1; i >= 0; i-- {
			if evs[i].Type == "agents" {
				return evs[i].Raw
			}
		}
		return ""
	}
	path.set("claude", "pi")
	e.await("the agents event with pi", func(evs []runTestEvent) bool {
		return last(evs) == `{"agents":["claude","pi"],"type":"agents"}`
	})
	path.set()
	e.await("the agents event with none", func(evs []runTestEvent) bool {
		return last(evs) == `{"agents":[],"type":"agents"}`
	})
}
