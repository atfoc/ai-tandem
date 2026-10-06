package server

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// A message that would start a turn beyond the cap on running turns is refused with 429 and the
// code "cap", in each form of POST /messages, and changes nothing. The caps are lowered as the
// app's start lowers them from AIWB_CHAT_CAP and AIWB_APP_CAP (chats.SetCaps).
func TestMessagesRefusedAtTheCap(t *testing.T) {
	e := newEnv(t)
	sp := &stopSpawner{}
	e.a.Chats.Spawners[model.Cursor] = sp
	id := e.branchedChat() // main and a1b2c3d4, which is current and has a session
	const other = "a1b2c3d4"
	path := "/api/chats/" + id + "/messages"
	t.Cleanup(func() { chats.SetCaps("4", "12") })
	refused := func(want int, q, body string, err error, code string) {
		t.Helper()
		out := decode[map[string]string](t, e.expect(want, "POST", path+q, body))
		if !reflect.DeepEqual(out, map[string]string{"error": err.Error(), "code": code}) {
			t.Fatalf("POST %s %s: %v", path+q, body, out)
		}
	}
	const newBranch = `{"text":"x","target":{"branch":"main","at":3,"new":true}}`
	untouched := func() {
		t.Helper()
		if len(e.thread(id, "main").Items) != 8 || len(e.thread(id, other).Items) != 6 {
			t.Fatal("a refused message is in a thread")
		}
		if ents, err := os.ReadDir(filepath.Join(e.st.P.ChatDir(id), "branches")); err != nil || len(ents) != 1 {
			t.Fatalf("the branches folder after refused messages: %v (%v)", ents, err)
		}
		if v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+id, "")); v.Working != 0 || v.Branch != other {
			t.Fatalf("view after refused messages %+v", v)
		}
	}

	// The app's cap, at one: another chat works.
	if c, a := chats.SetCaps("", "1"); c != 4 || a != 1 {
		t.Fatalf("the caps are %d and %d", c, a)
	}
	busy := decode[model.ChatView](t, e.expect(200, "POST", "/api/chats", `{"agent":"cursor","group":"`+model.Ungrouped+`"}`))
	e.expect(200, "POST", "/api/chats/"+busy.ID+"/messages", `{"text":"go"}`)
	if chats.ErrAppCap.Error() != "1 agent is already working; wait for it to finish or stop it" {
		t.Fatalf("the text at the cap of one: %q", chats.ErrAppCap)
	}
	refused(429, "", `{"text":"x"}`, chats.ErrAppCap, "cap")             // the end of the current branch
	refused(429, "?branch=main", `{"text":"x"}`, chats.ErrAppCap, "cap") // the end of a branch named
	refused(429, "", newBranch, chats.ErrAppCap, "cap")                  // a target: a new branch
	untouched()

	// The turn ends: the slot is free, and the message is taken.
	if sp.count() != 1 {
		t.Fatalf("%d processes of the other chat", sp.count())
	}
	sp.agents[0].ch <- agent.Event{Kind: agent.EvTurnEnd}
	for deadline := time.Now().Add(2 * time.Second); ; time.Sleep(5 * time.Millisecond) {
		if v := decode[model.ChatView](t, e.expect(200, "GET", "/api/chats/"+busy.ID, "")); v.Working == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the other chat's turn did not end")
		}
	}
	e.expect(200, "POST", path, `{"text":"go"}`)
	if got := e.thread(id, other); len(got.Items) != 7 || got.State.Status != model.StatusThinking {
		t.Fatalf("the current branch after its message: %d items, %+v", len(got.Items), got.State)
	}

	// The chat's cap, at one: its current branch works.
	if c, a := chats.SetCaps("1", "12"); c != 1 || a != 12 {
		t.Fatalf("the caps are %d and %d", c, a)
	}
	refused(429, "?branch=main", `{"text":"x"}`, chats.ErrChatCap, "cap")
	refused(429, "", newBranch, chats.ErrChatCap, "cap")
	// The branch that works is busy, whatever the cap: 409, which a client waits out.
	refused(409, "", `{"text":"x"}`, chats.ErrBusy, "busy")
	refused(409, "?branch="+other, `{"text":"x"}`, chats.ErrBusy, "busy")
	if len(e.thread(id, "main").Items) != 8 || len(e.thread(id, other).Items) != 7 {
		t.Fatal("a refused message is in a thread")
	}
	// Another chat is not held back by this one's cap.
	e.expect(200, "POST", "/api/chats/"+busy.ID+"/messages", `{"text":"more"}`)
}
