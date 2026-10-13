package remotes

import (
	"slices"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// TestSectionListsKeepTheServersOrder: a section's lists are in the order its server has them
// (goal 3.3), also after the events that add to them. That server lists its boards and chats
// oldest first, and two of one time by id, and its branch states by the id of their chat,
// a chat's own in the order of its branches. A new thing is told by an event and goes where the
// next snapshot will have it; one that is known keeps its place.
func TestSectionListsKeepTheServersOrder(t *testing.T) {
	t.Parallel()
	at := func(minute int) time.Time { return time.Date(2026, 10, 6, 9, minute, 0, 0, time.UTC) }
	chat := func(id string, minute int) model.ChatView { return model.ChatView{ID: id, Created: at(minute)} }
	state := func(chat, branch string) model.BranchState { return model.BranchState{Chat: chat, Branch: branch} }
	sec, err := sectionOf(mustJSON(t, map[string]any{
		"groups": []model.Group{}, "defaults": model.Defaults{},
		"boards": []model.Board{{ID: "b_m", Created: at(1)}, {ID: "b_c", Created: at(3)}},
		"chats":  []model.ChatView{chat("m", 1), chat("c", 3)},
		"states": []model.BranchState{state("c", "main"), state("m", "main"), state("m", "b_2")},
	}))
	if err != nil {
		t.Fatal(err)
	}
	// What the events tell: a newer thing, one of the time of another with a smaller and with a
	// larger id, and an older one; a chat whose id stands in front, in between and behind, each
	// with its state, and one more branch of a chat in the middle.
	for _, id := range []string{"z", "a", "d", "h"} {
		minute := map[string]int{"z": 5, "a": 3, "d": 3, "h": 0}[id]
		sec.putBoard(model.Board{ID: "b_" + id, Created: at(minute)})
		sec.putChat(chat(id, minute))
		sec.putState(state(id, "main"))
	}
	sec.putState(state("c", "b_1"))
	sec.putState(state("m", "b_3"))
	// A change of one that is known leaves it where it is.
	sec.putBoard(model.Board{ID: "b_z", Name: "renamed", Created: at(5)})
	sec.putChat(model.ChatView{ID: "h", Name: "renamed", Created: at(0)})
	sec.putState(model.BranchState{Chat: "m", Branch: "main", Status: model.StatusThinking})

	want := []string{"h", "m", "a", "c", "d", "z"} // oldest first; a, c and d are of one time
	ids := func(prefix string) (out []string) {
		for _, id := range want {
			out = append(out, prefix+id)
		}
		return out
	}
	var boards, chats, states []string
	for _, b := range sec.tree.Boards {
		boards = append(boards, b.ID)
	}
	for _, v := range sec.tree.Chats {
		chats = append(chats, v.ID)
	}
	for _, st := range sec.tree.States {
		states = append(states, st.Chat+"/"+st.Branch)
	}
	wantStates := []string{"a/main", "c/main", "c/b_1", "d/main", "h/main", "m/main", "m/b_2", "m/b_3", "z/main"}
	if !slices.Equal(boards, ids("b_")) || !slices.Equal(chats, ids("")) || !slices.Equal(states, wantStates) {
		t.Errorf("the lists after the events:\nboards %v\nchats  %v\nstates %v\nwant the order %v and the states %v", boards, chats, states, want, wantStates)
	}
	// Every item is found where it is: a change and a removal reach the right one.
	for i, b := range sec.tree.Boards {
		if sec.boards[b.ID] != i || sec.chats[sec.tree.Chats[i].ID] != i {
			t.Errorf("the places of the items at %d are %d and %d", i, sec.boards[b.ID], sec.chats[sec.tree.Chats[i].ID])
		}
	}
	for i, st := range sec.tree.States {
		if sec.states[stateKey{st.Chat, st.Branch}] != i {
			t.Errorf("the place of the state %s/%s is %d, want %d", st.Chat, st.Branch, sec.states[stateKey{st.Chat, st.Branch}], i)
		}
	}
	if sec.tree.Boards[5].Name != "renamed" || sec.tree.Chats[0].Name != "renamed" || sec.tree.States[5].Status != model.StatusThinking {
		t.Errorf("the changes of known items: %+v, %+v, %+v", sec.tree.Boards[5], sec.tree.Chats[0], sec.tree.States[5])
	}
	if !sec.dropChat("c") || len(sec.tree.States) != 7 || sec.states[stateKey{"d", "main"}] != 1 || sec.chats["d"] != 3 {
		t.Errorf("after the removal of a chat in the middle: states %+v, the chat d at %d", sec.tree.States, sec.chats["d"])
	}
}
