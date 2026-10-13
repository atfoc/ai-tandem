package chats

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// What is left of the calls an API client had before level 5: the locks per chat id, which a
// creation with an id (CreateChat) and a delete of that id hold, and the group "Remote" in the
// state. The creation with an id has its own tests in start_test.go; here is what those leave out.

// defaultsRaw is the store's defaults as they are written.
func (e *env) defaultsRaw() string {
	e.t.Helper()
	var raw []byte
	var err error
	e.st.Read(func(s *model.State) { raw, err = json.Marshal(s.Defaults) })
	if err != nil {
		e.t.Fatal(err)
	}
	return string(raw)
}

const (
	idA = "0b8f3c1e-5a4d-4e2b-9c7a-1f2e3d4c5b6a"
	idB = "7d1c9a52-3b6e-4f80-a1d4-9e8c7b6a5f40"
)

// ---- a creation with an id --------------------------------------------------

// The id of a run agent's chat, loaded or not, and of a folder among a run's chats is taken, as
// the id of a chat is (TestCreateWithATakenID): the creation makes nothing and leaves no lock.
func TestCreateWithTheIDOfARunAgentsChat(t *testing.T) {
	t.Parallel()
	e, _ := runEnv(t)
	const agentID, unloaded, strayOnRun = "1f2e3d4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f", "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
		"3b4c5d6e-7f8a-4b9c-8d0e-2f3a4b5c6d7e"
	e.agentChat(agentID, model.RoleTask, model.Claude)
	for _, dir := range []string{e.st.P.RunChatDir("r_two", true, unloaded), e.st.P.RunChatDir("r_two", false, strayOnRun)} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	folders, tokens := e.chatFolders(), e.tokens()
	for _, id := range []string{agentID, unloaded, strayOnRun} {
		for _, n := range []NewChat{{ID: id, Agent: model.Claude, Group: gOne}, {ID: id, Run: ownRun}} {
			if _, err := e.m.CreateChat(n); !errors.Is(err, ErrIDTaken) {
				t.Fatalf("CreateChat %+v: %v, want ErrIDTaken", n, err)
			}
		}
	}
	if got := e.chatFolders(); !reflect.DeepEqual(got, folders) || e.tokens() != tokens || len(e.m.Views()) != 0 || e.m.ids.held() != 0 {
		t.Fatalf("the refused creations left folders %v (were %v), %d tokens (were %d), %d chats, %d locks",
			got, folders, e.tokens(), tokens, len(e.m.Views()), e.m.ids.held())
	}
}

// ---- a delete that crosses a creation ------------------------------------------

// A creation with the id of a chat that is being deleted waits until the delete has sent
// chat_removed: a client that was told of the new chat first would drop it with that event. The
// id is then free, and the creation makes the chat.
func TestCreateWaitsForADeleteOfItsID(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.newChat(NewChat{ID: idA, Agent: model.Claude, Group: gOne})
	// After a restart the chat is not loaded: its stop sends nothing, so chat_removed is the
	// delete's only event.
	e.boot()
	evs := e.listen()
	old := e.chatObj(idA)

	// The delete is held just before it sends chat_removed, which goes out under the chat's
	// goneMu: the chat is out of the map and its folder is gone.
	old.goneMu.Lock()
	held := true
	release := func() {
		if held {
			held = false
			old.goneMu.Unlock()
		}
	}
	defer release()
	deleted := make(chan error, 1)
	go func() { deleted <- e.m.Delete(idA) }()
	waitFor(t, "the chat to leave the map and its folder to go", func() bool {
		_, gerr := e.m.get(idA)
		_, serr := os.Stat(e.st.P.ChatDir(idA))
		return gerr != nil && os.IsNotExist(serr)
	})

	type answer struct {
		v   model.ChatView
		err error
	}
	made := make(chan answer, 1)
	go func() {
		v, err := e.m.CreateChat(NewChat{ID: idA, Agent: model.Claude, Group: gTwo})
		made <- answer{v, err}
	}()
	select {
	case a := <-made:
		t.Fatalf("the creation did not wait for the delete: %+v, %v", a.v, a.err)
	case err := <-deleted:
		t.Fatalf("the delete got past its chat_removed: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if _, err := e.m.get(idA); err == nil {
		t.Fatal("while the delete waits, a chat with its id is there")
	}

	release()
	if err := <-deleted; err != nil {
		t.Fatal(err)
	}
	a := <-made
	if a.err != nil || a.v.ID != idA || a.v.Group != gTwo || a.v.Locked {
		t.Fatalf("the creation after the delete: %+v, %v", a.v, a.err)
	}
	// The old chat's chat_removed went out before anything of the new chat.
	removed, first := -1, -1
	for i, ev := range evs.drain(t, e.br) {
		c, _ := ev["chat"].(map[string]any)
		switch {
		case ev["type"] == "chat_removed" && ev["id"] == idA:
			if removed >= 0 {
				t.Fatal("chat_removed was sent twice")
			}
			removed = i
		case ev["type"] == "chat" && c["id"] == idA && first < 0:
			first = i
		}
	}
	if removed < 0 || first < 0 || removed > first {
		t.Fatalf("chat_removed is event %d, the new chat's first event %d", removed, first)
	}
	if n := e.m.ids.held(); n != 0 {
		t.Fatalf("%d creation locks are left", n)
	}
}

// ---- the group "Remote" in the state ---------------------------------------------

// The store keeps the group state.json names in remoteGroup, across a save and a restart: the
// change-over of a server from before level 5 reads it once, and removes that group.
func TestRemoteGroupIsKeptInTheState(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	stateFile := func() map[string]any {
		t.Helper()
		raw, err := os.ReadFile(e.st.P.State)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	if _, ok := stateFile()["remoteGroup"]; ok {
		t.Fatal("state.json names a group \"Remote\" before any was made")
	}
	if err := e.st.Update(func(s *model.State) error { s.RemoteGroup = gTwo; return nil }); err != nil {
		t.Fatal(err)
	}
	if got := stateFile()["remoteGroup"]; got != gTwo {
		t.Fatalf("state.json has remoteGroup %v", got)
	}
	e.boot()
	var got string
	e.st.Read(func(s *model.State) { got = s.RemoteGroup })
	if got != gTwo {
		t.Fatalf("after a restart the state's RemoteGroup is %q", got)
	}
}

// ---- the creation locks ---------------------------------------------------------

func TestIDLocksLeaveNothing(t *testing.T) {
	t.Parallel()
	var l idLocks
	if l.held() != 0 {
		t.Fatal("a new set of locks holds one")
	}
	unlock := l.lock("a")
	other := l.lock("b") // another id does not wait
	if l.held() != 2 {
		t.Fatalf("%d locks with two held", l.held())
	}
	const waiters = 24
	var in, most atomic.Int32
	done := make(chan struct{}, waiters)
	for i := 0; i < waiters; i++ {
		go func() {
			u := l.lock("a")
			if n := in.Add(1); n > most.Load() {
				most.Store(n)
			}
			time.Sleep(time.Millisecond)
			in.Add(-1)
			u()
			done <- struct{}{}
		}()
	}
	waitFor(t, "the waiters", func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.m["a"].n == waiters+1
	})
	if in.Load() != 0 {
		t.Fatal("a waiter got the lock while it was held")
	}
	other()
	unlock()
	for i := 0; i < waiters; i++ {
		<-done
	}
	if most.Load() != 1 || l.held() != 0 {
		t.Fatalf("%d held the lock of one id at once; %d locks are left", most.Load(), l.held())
	}
}
