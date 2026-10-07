package chats

import (
	"errors"
	"os"
	"testing"

	"ai-whiteboard/internal/model"
)

// DeleteOnRun takes the chats people made on one run, and nothing else.
func TestDeleteOnRun(t *testing.T) {
	const otherRun = "r_two"
	e, fr := runEnv(t)
	fr.mu.Lock()
	fr.runs[otherRun] = fr.runs[ownRun]
	fr.mu.Unlock()
	a, b := e.onRun(model.Claude), e.onRun(model.Claude)
	other, err := e.m.CreateOnRun(model.Claude, otherRun)
	if err != nil {
		t.Fatal(err)
	}
	plain := e.create(model.Claude, gOne, "")
	agent := e.agentChat("agent-1", model.RoleTask, model.Claude)
	dirs := map[string]string{a.ID: e.st.P.RunChatDir(ownRun, false, a.ID), b.ID: e.st.P.RunChatDir(ownRun, false, b.ID),
		other.ID: e.st.P.RunChatDir(otherRun, false, other.ID), agent: e.st.P.RunChatDir(ownRun, true, agent)}
	for id, dir := range dirs {
		if _, err := os.Stat(dir); err != nil {
			t.Fatalf("the folder of %s before: %v", id, err)
		}
	}

	evs := e.listen()
	e.m.DeleteOnRun("")
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("DeleteOnRun of no run sent %v", got)
	}
	e.m.DeleteOnRun(ownRun)
	removed := map[any]int{}
	for _, ev := range evs.drain(t, e.br) {
		if ev["type"] == "chat_removed" {
			removed[ev["id"]]++
		}
	}
	if len(removed) != 2 || removed[a.ID] != 1 || removed[b.ID] != 1 {
		t.Fatalf("chat_removed events: %v", removed)
	}
	for _, id := range []string{a.ID, b.ID} {
		if _, err := e.m.View(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("View of %s after DeleteOnRun: %v", id, err)
		}
		if _, err := os.Stat(dirs[id]); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("the folder of %s after DeleteOnRun: %v", id, err)
		}
	}
	for _, id := range []string{other.ID, plain.ID, agent} {
		if _, err := e.m.View(id); err != nil {
			t.Errorf("View of %s after DeleteOnRun: %v", id, err)
		}
	}
	for _, id := range []string{other.ID, agent} {
		if _, err := os.Stat(dirs[id]); err != nil {
			t.Errorf("the folder of %s after DeleteOnRun: %v", id, err)
		}
	}
	if people, agents := e.m.ChatsOfRun(ownRun); len(people) != 0 || len(agents) != 1 || agents[0].ID != agent {
		t.Errorf("the chats of the run after: %v %v", people, agents)
	}
	if people, _ := e.m.ChatsOfRun(otherRun); len(people) != 1 || people[0].ID != other.ID {
		t.Errorf("the chats of the other run after: %v", people)
	}
	e.m.DeleteOnRun(ownRun) // nothing left: nothing happens
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("a second DeleteOnRun sent %v", got)
	}
}
