package boards

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// The list of the boards has one order (goal 3.3: a section shows the server's tree in the same
// order): oldest first, and two boards of the same moment by their id. It is the same at every
// call, after a change of a board, and after the boards are loaded again.
func TestLevel5ListIsOldestFirst(t *testing.T) {
	s, st, _ := setup(t)
	ids := func(l []model.Board) []string {
		out := make([]string, len(l))
		for i, bd := range l {
			out[i] = bd.ID
		}
		return out
	}
	// More boards than one bucket of a map holds, in the order they are made.
	var made []string
	for i := 0; i < 24; i++ {
		bd, err := s.Create("board", model.Ungrouped, false)
		if err != nil {
			t.Fatal(err)
		}
		made = append(made, bd.ID)
	}
	// Boards of one moment, as two servers of before could have written them, come by their id.
	// The moment is the oldest of all, so they are first.
	moment := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	same := []string{"b_cccccccccccc", "b_aaaaaaaaaaaa", "b_bbbbbbbbbbbb"}
	for _, id := range same {
		if err := os.MkdirAll(st.P.BoardDir(id), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := store.WriteJSONAtomic(filepath.Join(st.P.BoardDir(id), "board.json"), model.Board{ID: id, Name: "same", Group: model.Ungrouped, Created: moment}, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	slices.Sort(same)
	want := append(same, made...)

	fresh := New(st, &recorder{})
	if err := fresh.Load(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if got := ids(fresh.List()); !slices.Equal(got, want) {
			t.Fatalf("the list at call %d:\n%v\nwant the boards of one moment by id, then the others as they were made:\n%v", i, got, want)
		}
	}
	if got := ids(s.List()); !slices.Equal(got, made) {
		t.Errorf("the list of the service that made the boards:\n%v\nwant\n%v", got, made)
	}
	// A change of a board leaves it where it is: its place is its age, not its last change.
	if _, err := fresh.Rename(made[20], "renamed"); err != nil {
		t.Fatal(err)
	}
	if err := fresh.Move(made[3], groupID); err != nil {
		t.Fatal(err)
	}
	if err := fresh.SetArchive(made[7], model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	if got := ids(fresh.List()); !slices.Equal(got, want) {
		t.Errorf("the list after a rename, a move and an archive:\n%v\nwant\n%v", got, want)
	}
	// A deleted board leaves the list, and the others stay as they were.
	if err := fresh.Delete(made[0]); err != nil {
		t.Fatal(err)
	}
	if got := ids(fresh.List()); !slices.Equal(got, append(slices.Clone(same), made[1:]...)) {
		t.Errorf("the list after a delete:\n%v", got)
	}
}
