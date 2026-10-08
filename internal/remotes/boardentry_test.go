package remotes

import (
	"reflect"
	"testing"

	"ai-whiteboard/internal/model"
)

// TestBoardEntryRemovedChats: at the removal of an entry the unstarted chats on its boards are
// deleted with the records (DeleteOnBoard, once for each record) and are not put back on this
// computer; the unstarted chats on no board are.
func TestBoardEntryRemovedChats(t *testing.T) {
	t.Parallel()
	a, b := boardSeedOf(boardA), boardSeedOf(boardB)
	rg := newRig(t, rigOpt{snapshot: snapshotWithBoards(a.View, b.View), boardSeed: []BoardRecord{a, b}})
	rg.local.mu.Lock()
	rg.local.unstarted[rg.entry] = []string{"unstarted-1"}
	rg.local.chats["on-board"] = model.ChatMeta{ID: "on-board", Server: rg.entry, Board: boardA}
	rg.local.mu.Unlock()

	if err := rg.m.Remove(rg.entry); err != nil {
		t.Fatal(err)
	}
	rg.until("the unstarted chat on no board is put back", func() bool {
		rg.local.mu.Lock()
		defer rg.local.mu.Unlock()
		return len(rg.local.resets) != 0
	})
	rg.local.mu.Lock()
	defer rg.local.mu.Unlock()
	if got := rg.local.onBoards; !reflect.DeepEqual(got, []string{boardA, boardB}) {
		t.Errorf("DeleteOnBoard for %v", got)
	}
	if got := rg.local.resets; !reflect.DeepEqual(got, []string{"unstarted-1"}) {
		t.Errorf("ResetServer for %v", got)
	}
}
