package boards

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

type recorder struct {
	mu  sync.Mutex
	evs []map[string]any
}

func (r *recorder) Broadcast(ev any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.evs = append(r.evs, ev.(map[string]any))
}

func (r *recorder) last(t *testing.T) map[string]any {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.evs) == 0 {
		t.Fatal("no event broadcast")
	}
	return r.evs[len(r.evs)-1]
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.evs)
}

// wantBoardEvent checks the last event is {type:"board", board} with board == want.
func (r *recorder) wantBoardEvent(t *testing.T, want model.Board) {
	t.Helper()
	ev := r.last(t)
	if ev["type"] != "board" {
		t.Fatalf("event type %v", ev["type"])
	}
	got, ok := ev["board"].(model.Board)
	if !ok || !reflect.DeepEqual(got, want) {
		t.Fatalf("event board %+v, want %+v", ev["board"], want)
	}
}

const groupID = "g_one"

func setup(t *testing.T) (*Service, *store.Store, *recorder) {
	t.Helper()
	st, err := store.Open(store.NewPaths(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Update(func(s *model.State) error {
		s.Groups = append(s.Groups, model.Group{ID: groupID, Name: "One"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	r := &recorder{}
	return New(st, r), st, r
}

func readBoardJSON(t *testing.T, st *store.Store, id string) model.Board {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(st.P.BoardDir(id), "board.json"))
	if err != nil {
		t.Fatal(err)
	}
	var bd model.Board
	if err := json.Unmarshal(raw, &bd); err != nil {
		t.Fatal(err)
	}
	return bd
}

func TestCleanName(t *testing.T) {
	ok := map[string]string{
		"my board":              "my-board",
		"  plan  ":              "plan",
		"notes.excalidraw":      "notes",
		"a b.excalidraw":        "a-b",
		strings.Repeat("x", 80): strings.Repeat("x", 80),
	}
	for in, want := range ok {
		got, err := CleanName(in)
		if err != nil || got != want {
			t.Errorf("CleanName(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "   ", ".x", "a/b", `a\b`, "a\x01b", strings.Repeat("x", 81), ".excalidraw"} {
		if got, err := CleanName(in); err == nil {
			t.Errorf("CleanName(%q) = %q, want error", in, got)
		}
	}
}

func TestCreate(t *testing.T) {
	s, st, r := setup(t)
	a, err := s.Create("", model.Ungrouped, false)
	if err != nil {
		t.Fatal(err)
	}
	r.wantBoardEvent(t, a)
	b, err := s.Create("", groupID, true)
	if err != nil {
		t.Fatal(err)
	}
	r.wantBoardEvent(t, b)
	if a.Name != "whiteboard" || b.Name != "whiteboard" {
		t.Errorf("names %q %q", a.Name, b.Name)
	}
	if a.ID == b.ID || !strings.HasPrefix(a.ID, "b_") || !strings.HasPrefix(b.ID, "b_") {
		t.Errorf("ids %q %q", a.ID, b.ID)
	}
	if a.Group != model.Ungrouped || b.Group != groupID || a.New || !b.New || a.Created.IsZero() {
		t.Errorf("boards %+v %+v", a, b)
	}
	for _, bd := range []model.Board{a, b} {
		scene, err := os.ReadFile(st.P.BoardFile(bd.ID))
		if err != nil || string(scene) != EmptyScene {
			t.Errorf("drawing of %s: %q %v", bd.ID, scene, err)
		}
		if got := readBoardJSON(t, st, bd.ID); !got.Created.Equal(bd.Created) || got.ID != bd.ID || got.Name != bd.Name || got.Group != bd.Group || got.New != bd.New {
			t.Errorf("board.json %+v, want %+v", got, bd)
		}
	}
	if len(s.List()) != 2 {
		t.Errorf("list %+v", s.List())
	}
	if got, ok := s.Get(a.ID); !ok || got.ID != a.ID {
		t.Errorf("Get %+v %v", got, ok)
	}
}

func TestCreateUnknownGroup(t *testing.T) {
	s, st, r := setup(t)
	if _, err := s.Create("x", "g_missing", false); err == nil {
		t.Fatal("created in an unknown group")
	}
	if _, err := s.Create("x", "", false); err == nil {
		t.Fatal("created with an empty group")
	}
	if r.count() != 0 || len(s.List()) != 0 {
		t.Errorf("events %d, boards %d", r.count(), len(s.List()))
	}
	if ents, _ := os.ReadDir(st.P.Boards); len(ents) != 0 {
		t.Errorf("folders left: %v", ents)
	}
}

func TestRename(t *testing.T) {
	s, st, r := setup(t)
	a, _ := s.Create("alpha", model.Ungrouped, false)
	b, _ := s.Create("beta", model.Ungrouped, false)
	got, err := s.Rename(b.ID, "alpha")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != b.ID || got.Name != "alpha" {
		t.Errorf("renamed %+v", got)
	}
	r.wantBoardEvent(t, got)
	if bj := readBoardJSON(t, st, b.ID); bj.Name != "alpha" {
		t.Errorf("board.json name %q", bj.Name)
	}
	if _, err := os.Stat(st.P.BoardFile(b.ID)); err != nil {
		t.Errorf("folder moved: %v", err)
	}
	if first, _ := s.Get(a.ID); first.Name != "alpha" {
		t.Errorf("other board changed: %+v", first)
	}
	n := r.count()
	if same, err := s.Rename(b.ID, "alpha"); err != nil || same.Name != "alpha" || r.count() != n {
		t.Errorf("no-op rename: %+v %v, events %d->%d", same, err, n, r.count())
	}
	if _, err := s.Rename(b.ID, "a/b"); err == nil {
		t.Error("bad name accepted")
	}
	if _, err := s.Rename("b_missing", "x"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
}

func TestMoveSeenArchiveBroadcast(t *testing.T) {
	s, st, r := setup(t)
	a, _ := s.Create("a", model.Ungrouped, true)

	if err := s.Move(a.ID, groupID); err != nil {
		t.Fatal(err)
	}
	a.Group = groupID
	r.wantBoardEvent(t, a)
	if err := s.Move(a.ID, "g_missing"); err == nil {
		t.Error("moved to an unknown group")
	}

	if err := s.Seen(a.ID); err != nil {
		t.Fatal(err)
	}
	a.New = false
	r.wantBoardEvent(t, a)

	arch := model.Archive{Archived: true, Op: "a_12345678"}
	if err := s.SetArchive(a.ID, arch); err != nil {
		t.Fatal(err)
	}
	a.Archive = arch
	r.wantBoardEvent(t, a)
	if bj := readBoardJSON(t, st, a.ID); bj.Archive != arch || bj.Group != groupID || bj.New {
		t.Errorf("board.json %+v", bj)
	}
}

func TestScene(t *testing.T) {
	s, st, _ := setup(t)
	if _, err := s.Scene("b_missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
	a, _ := s.Create("a", model.Ungrouped, false)
	body := `{"type":"excalidraw","elements":[{"id":"x"}]}`
	if err := s.Save(a.ID, []byte(body)); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Scene(a.ID); err != nil || string(got) != body {
		t.Errorf("scene %q %v", got, err)
	}
	if err := os.Remove(st.P.BoardFile(a.ID)); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Scene(a.ID); err != nil || string(got) != EmptyScene {
		t.Errorf("missing file: %q %v", got, err)
	}
}

func TestSave(t *testing.T) {
	s, st, _ := setup(t)
	a, _ := s.Create("a", model.Ungrouped, false)
	before, _ := os.ReadFile(filepath.Join(st.P.BoardDir(a.ID), "board.json"))

	if err := s.Save(a.ID, []byte("{not json")); err == nil {
		t.Error("invalid JSON accepted")
	}
	if got, _ := os.ReadFile(st.P.BoardFile(a.ID)); string(got) != EmptyScene {
		t.Errorf("drawing changed by a rejected save: %q", got)
	}
	if err := s.Save("b_missing", []byte("{}")); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}

	if err := s.SetArchive(a.ID, model.Archive{Archived: true, Op: "a_1"}); err != nil {
		t.Fatal(err)
	}
	archived, _ := os.ReadFile(filepath.Join(st.P.BoardDir(a.ID), "board.json"))
	if err := s.Save(a.ID, []byte(`{"elements":[]}`)); !errors.Is(err, ErrArchived) {
		t.Errorf("archived save: %v", err)
	}
	if got, _ := os.ReadFile(st.P.BoardFile(a.ID)); string(got) != EmptyScene {
		t.Errorf("archived drawing changed: %q", got)
	}
	if after, _ := os.ReadFile(filepath.Join(st.P.BoardDir(a.ID), "board.json")); string(after) != string(archived) {
		t.Errorf("board.json changed by save: %s", after)
	}

	// A good save never touches board.json either.
	s.SetArchive(a.ID, model.Archive{})
	unarchived, _ := os.ReadFile(filepath.Join(st.P.BoardDir(a.ID), "board.json"))
	if string(unarchived) != string(before) {
		t.Errorf("board.json after unarchive: %s want %s", unarchived, before)
	}
	if err := s.Save(a.ID, []byte(`{"elements":[]}`)); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(filepath.Join(st.P.BoardDir(a.ID), "board.json")); string(after) != string(before) {
		t.Errorf("board.json changed by save: %s", after)
	}
}

func TestDelete(t *testing.T) {
	s, st, r := setup(t)
	a, _ := s.Create("a", model.Ungrouped, false)
	b, _ := s.Create("b", model.Ungrouped, false)
	if err := s.Delete(a.ID); err != nil {
		t.Fatal(err)
	}
	ev := r.last(t)
	if ev["type"] != "board_removed" || ev["id"] != a.ID || len(ev) != 2 {
		t.Errorf("event %+v", ev)
	}
	if _, err := os.Stat(st.P.BoardDir(a.ID)); !os.IsNotExist(err) {
		t.Errorf("folder still there: %v", err)
	}
	if _, ok := s.Get(a.ID); ok {
		t.Error("record still there")
	}
	if _, err := s.Scene(a.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("scene after delete: %v", err)
	}
	if list := s.List(); len(list) != 1 || list[0].ID != b.ID {
		t.Errorf("list %+v", list)
	}
	if err := s.Delete(a.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
}

func TestLoad(t *testing.T) {
	s, st, _ := setup(t)
	a, _ := s.Create("a", model.Ungrouped, true)
	b, _ := s.Create("b", groupID, false)
	c, _ := s.Create("c", model.Ungrouped, false)
	if _, err := s.Rename(a.ID, "renamed"); err != nil {
		t.Fatal(err)
	}
	if err := s.Move(c.ID, groupID); err != nil {
		t.Fatal(err)
	}
	if err := s.SetArchive(b.ID, model.Archive{Archived: true, Op: "a_x"}); err != nil {
		t.Fatal(err)
	}
	if err := s.Seen(a.ID); err != nil {
		t.Fatal(err)
	}

	stray := filepath.Join(st.P.Boards, "b_stray")
	if err := os.MkdirAll(stray, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stray, "drawing.excalidraw"), []byte(EmptyScene), 0o644); err != nil {
		t.Fatal(err)
	}

	fresh := New(st, &recorder{})
	if err := fresh.Load(); err != nil {
		t.Fatal(err)
	}
	norm := func(l []model.Board) []model.Board {
		sort.Slice(l, func(i, j int) bool { return l[i].ID < l[j].ID })
		for i := range l {
			l[i].Created = l[i].Created.Round(0).UTC()
		}
		return l
	}
	want, got := norm(s.List()), norm(fresh.List())
	if !reflect.DeepEqual(got, want) {
		t.Errorf("loaded %+v\nwant %+v", got, want)
	}
	if _, err := os.Stat(stray); err != nil {
		t.Errorf("stray folder removed: %v", err)
	}
	if _, ok := fresh.Get("b_stray"); ok {
		t.Error("stray folder registered")
	}
}
