package server

import (
	"errors"
	"os"
	"testing"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
)

// Removing an entry removes the unstarted chats on its boards with the board records: such a
// chat would be a chat on a board that is nowhere. An unstarted chat of the entry that is on no
// board is put back on this computer, as before.
func TestEntryRemovalTakesTheChatsOnItsBoards(t *testing.T) {
	t.Parallel()
	pr := newPair(t, remotes.Limits{})
	a := pr.a
	p := a.page("P")
	bd, group := pr.create(p, "Untitled")
	on := decode[model.ChatView](t, string(do(t, p, "POST", "/api/chats", obj{"agent": "claude", "board": bd.ID})))
	free := decode[model.ChatView](t, string(do(t, p, "POST", "/api/chats", obj{"agent": "claude", "group": group, "server": pr.entry})))
	if on.Board != bd.ID || on.Server != pr.entry || free.Board != "" || free.Server != pr.entry {
		t.Fatalf("the chats before: %+v, %+v", on, free)
	}
	dir := a.st.P.ChatDir(on.ID)
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("the folder of the chat on the board before: %v", err)
	}

	do(t, p, "DELETE", "/api/servers/"+pr.entry, nil)
	pr.wait("the chat on no board is back on this computer", func() bool {
		cv, err := a.a.Chats.View(free.ID)
		return err == nil && cv.Server != pr.entry
	})
	if pr.rm.HasBoard(bd.ID) {
		t.Error("the board record of the removed entry is left")
	}
	if _, err := a.a.Chats.View(on.ID); !errors.Is(err, chats.ErrNotFound) {
		t.Errorf("View of the chat on the removed board: %v", err)
	}
	if left := a.a.Chats.ChatsOfBoard(bd.ID); len(left) != 0 {
		t.Errorf("the chat manager still has %+v", left)
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("the folder of the chat on the removed board: %v", err)
	}
	if cv, err := a.a.Chats.View(free.ID); err != nil || cv.Board != "" || cv.Group != group {
		t.Errorf("the chat on no board after: %+v, %v", cv, err)
	}
}
