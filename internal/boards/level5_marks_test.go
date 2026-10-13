package boards

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// A board.json from before level 5 may hold the mark of the API client that made the board, and
// the board it came from ("client", "origin"). Neither is read: the file loads, the board is in
// the list like any other and is served without them, the bridge is told nothing but its events,
// and the next write of board.json leaves both out.
func TestLevel5NoMarkAfterLoad(t *testing.T) {
	s, st, _ := setup(t)
	plain, err := s.Create("plain", model.Ungrouped, false)
	if err != nil {
		t.Fatal(err)
	}
	marked, err := s.Create("marked", groupID, true)
	if err != nil {
		t.Fatal(err)
	}
	// The file as a server of before wrote it.
	path := filepath.Join(st.P.BoardDir(marked.ID), "board.json")
	var old map[string]any
	if raw, err := os.ReadFile(path); err != nil || json.Unmarshal(raw, &old) != nil {
		t.Fatalf("board.json: %s %v", raw, err)
	}
	old["client"], old["origin"] = "11111111-1111-4111-8111-111111111111", plain.ID
	if err := store.WriteJSONAtomic(path, old, 0o644); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(path); !strings.Contains(string(raw), `"client"`) || !strings.Contains(string(raw), `"origin"`) {
		t.Fatalf("the file of before: %s", raw)
	}

	bridge := &sender{}
	fresh := New(st, bridge)
	if err := fresh.Load(); err != nil {
		t.Fatal(err)
	}
	got, ok := fresh.Get(marked.ID)
	want := marked
	if !ok || !got.Created.Equal(want.Created) {
		t.Fatalf("loaded %+v %v", got, ok)
	}
	got.Created = want.Created
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("loaded %+v, want %+v: no mark, no origin, the rest as it was", got, want)
	}
	if len(fresh.List()) != 2 {
		t.Errorf("list %+v", fresh.List())
	}
	if served, err := json.Marshal(fresh.List()); err != nil || strings.Contains(string(served), `"client"`) || strings.Contains(string(served), `"origin"`) {
		t.Errorf("the boards as they are served: %s %v", served, err)
	}
	if calls := bridge.take(); len(calls) != 0 {
		t.Errorf("Load told the bridge %v", calls)
	}
	// The file is left as it is until the board is written again.
	if _, err := fresh.Rename(marked.ID, "renamed"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || strings.Contains(string(raw), "client") || strings.Contains(string(raw), "origin") || !strings.Contains(string(raw), "renamed") {
		t.Errorf("board.json after a change: %s %v", raw, err)
	}
	if calls := bridge.take(); !reflect.DeepEqual(calls, []string{"send " + marked.ID + " board"}) {
		t.Errorf("the calls of the change: %v", calls)
	}
}
