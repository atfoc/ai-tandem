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
	"time"

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
	if _, _, err := s.SceneAt("b_missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
	a, _ := s.Create("a", model.Ungrouped, false)
	body := `{"type":"excalidraw","elements":[{"id":"x"}]}`
	if _, err := s.SaveAt(a.ID, 0, []byte(body)); err != nil {
		t.Fatal(err)
	}
	if got, _, err := s.SceneAt(a.ID); err != nil || string(got) != body {
		t.Errorf("scene %q %v", got, err)
	}
	if err := os.Remove(st.P.BoardFile(a.ID)); err != nil {
		t.Fatal(err)
	}
	if got, _, err := s.SceneAt(a.ID); err != nil || string(got) != EmptyScene {
		t.Errorf("missing file: %q %v", got, err)
	}
}

func TestSave(t *testing.T) {
	s, st, _ := setup(t)
	a, _ := s.Create("a", model.Ungrouped, false)
	before, _ := os.ReadFile(filepath.Join(st.P.BoardDir(a.ID), "board.json"))

	if _, err := s.SaveAt(a.ID, 0, []byte("{not json")); err == nil {
		t.Error("invalid JSON accepted")
	}
	if got, _ := os.ReadFile(st.P.BoardFile(a.ID)); string(got) != EmptyScene {
		t.Errorf("drawing changed by a rejected save: %q", got)
	}
	if _, err := s.SaveAt("b_missing", 0, []byte("{}")); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}

	if err := s.SetArchive(a.ID, model.Archive{Archived: true, Op: "a_1"}); err != nil {
		t.Fatal(err)
	}
	archived, _ := os.ReadFile(filepath.Join(st.P.BoardDir(a.ID), "board.json"))
	if _, err := s.SaveAt(a.ID, 0, []byte(`{"elements":[]}`)); !errors.Is(err, ErrArchived) {
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
	if _, err := s.SaveAt(a.ID, 0, []byte(`{"elements":[]}`)); err != nil {
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
	if _, _, err := s.SceneAt(a.ID); !errors.Is(err, ErrNotFound) {
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

func readRevFile(t *testing.T, st *store.Store, id string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(st.P.BoardDir(id), "scene.rev"))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestSaveAt(t *testing.T) {
	s, st, r := setup(t)
	a, _ := s.Create("a", model.Ungrouped, false)
	if got := s.Rev(a.ID); got != 0 {
		t.Errorf("new board at revision %d", got)
	}
	if _, err := os.Stat(filepath.Join(st.P.BoardDir(a.ID), "scene.rev")); !os.IsNotExist(err) {
		t.Errorf("create wrote scene.rev: %v", err)
	}
	if raw, rev, err := s.SceneAt(a.ID); err != nil || rev != 0 || string(raw) != EmptyScene {
		t.Errorf("new board: %q %d %v", raw, rev, err)
	}
	events := r.count()

	one, two := `{"elements":[{"id":"one"}]}`, `{"elements":[{"id":"two"}]}`
	if rev, err := s.SaveAt(a.ID, 0, []byte(one)); err != nil || rev != 1 {
		t.Fatalf("first write: %d %v", rev, err)
	}
	if rev, err := s.SaveAt(a.ID, 1, []byte(two)); err != nil || rev != 2 {
		t.Fatalf("second write: %d %v", rev, err)
	}
	if got := readRevFile(t, st, a.ID); got != "2" {
		t.Errorf("scene.rev %q", got)
	}

	// A late write on an older base is refused and changes nothing.
	for _, base := range []int64{0, 1, 3, -1} {
		rev, err := s.SaveAt(a.ID, base, []byte(one))
		var stale StaleError
		if !errors.As(err, &stale) || stale.Rev != 2 || rev != 0 {
			t.Errorf("base %d: %d %v", base, rev, err)
		}
	}
	if raw, rev, err := s.SceneAt(a.ID); err != nil || rev != 2 || string(raw) != two {
		t.Errorf("after stale writes: %q %d %v", raw, rev, err)
	}
	if got := readRevFile(t, st, a.ID); got != "2" || s.Rev(a.ID) != 2 {
		t.Errorf("after stale writes: scene.rev %q, Rev %d", got, s.Rev(a.ID))
	}

	// Refusals that come before the check leave the revision too.
	if _, err := s.SaveAt(a.ID, 2, []byte("{not json")); err == nil {
		t.Error("invalid JSON accepted")
	}
	if _, err := s.SaveAt("b_missing", 0, []byte("{}")); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
	if _, _, err := s.SceneAt("b_missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
	if s.Rev("b_missing") != 0 {
		t.Error("unknown id has a revision")
	}
	s.SetArchive(a.ID, model.Archive{Archived: true, Op: "a_1"})
	if _, err := s.SaveAt(a.ID, 2, []byte(one)); !errors.Is(err, ErrArchived) {
		t.Errorf("archived save: %v", err)
	}
	s.SetArchive(a.ID, model.Archive{})
	if raw, rev, _ := s.SceneAt(a.ID); rev != 2 || string(raw) != two {
		t.Errorf("after refusals: %q %d", raw, rev)
	}
	if got := r.count(); got != events+2 { // the two SetArchive calls
		t.Errorf("a save sent an event: %d, want %d", got, events+2)
	}
}

func TestRevSurvivesReload(t *testing.T) {
	s, st, _ := setup(t)
	a, _ := s.Create("a", model.Ungrouped, false)
	b, _ := s.Create("b", model.Ungrouped, false)
	body := `{"elements":[{"id":"x"}]}`
	for i := int64(0); i < 3; i++ {
		if _, err := s.SaveAt(a.ID, i, []byte(body)); err != nil {
			t.Fatal(err)
		}
	}

	fresh := New(st, &recorder{})
	if err := fresh.Load(); err != nil {
		t.Fatal(err)
	}
	if raw, rev, err := fresh.SceneAt(a.ID); err != nil || rev != 3 || string(raw) != body {
		t.Errorf("reloaded: %q %d %v", raw, rev, err)
	}
	if got := fresh.Rev(a.ID); got != 3 {
		t.Errorf("Rev after reload: %d", got)
	}
	if got := fresh.Rev(b.ID); got != 0 {
		t.Errorf("unwritten board after reload: %d", got)
	}
	if _, err := fresh.SaveAt(a.ID, 2, []byte(`{}`)); !errors.As(err, new(StaleError)) {
		t.Errorf("stale write after reload: %v", err)
	}
	if rev, err := fresh.SaveAt(a.ID, 3, []byte(`{}`)); err != nil || rev != 4 {
		t.Errorf("write after reload: %d %v", rev, err)
	}
}

// A board from before the revisions has a drawing and no scene.rev.
func TestBoardWithoutRevFile(t *testing.T) {
	s, st, _ := setup(t)
	a, _ := s.Create("a", model.Ungrouped, false)
	old := `{"elements":[{"id":"old"}]}`
	if err := os.WriteFile(st.P.BoardFile(a.ID), []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}

	fresh := New(st, &recorder{})
	if err := fresh.Load(); err != nil {
		t.Fatal(err)
	}
	if raw, rev, err := fresh.SceneAt(a.ID); err != nil || rev != 0 || string(raw) != old {
		t.Errorf("read: %q %d %v", raw, rev, err)
	}
	if rev, err := fresh.SaveAt(a.ID, 0, []byte(`{}`)); err != nil || rev != 1 {
		t.Errorf("write on base 0: %d %v", rev, err)
	}
	if got := readRevFile(t, st, a.ID); got != "1" {
		t.Errorf("scene.rev %q", got)
	}

	// An unreadable scene.rev counts as 0 and the board still loads.
	if err := os.WriteFile(filepath.Join(st.P.BoardDir(a.ID), "scene.rev"), []byte("nonsense"), 0o644); err != nil {
		t.Fatal(err)
	}
	fresh = New(st, &recorder{})
	if err := fresh.Load(); err != nil {
		t.Fatal(err)
	}
	if _, ok := fresh.Get(a.ID); !ok || fresh.Rev(a.ID) != 0 {
		t.Errorf("bad scene.rev: Rev %d, board loaded %v", fresh.Rev(a.ID), ok)
	}
}

func TestFailedDrawingWriteLeavesRev(t *testing.T) {
	s, st, _ := setup(t)
	a, _ := s.Create("a", model.Ungrouped, false)
	b, _ := s.Create("b", model.Ungrouped, false)
	if _, err := s.SaveAt(a.ID, 0, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	// A folder in the drawing's place: the rename onto it fails.
	for _, id := range []string{a.ID, b.ID} {
		if err := os.Remove(st.P.BoardFile(id)); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(st.P.BoardFile(id), 0o700); err != nil {
			t.Fatal(err)
		}
	}

	if rev, err := s.SaveAt(a.ID, 1, []byte(`{"elements":[]}`)); err == nil || errors.As(err, new(StaleError)) || rev != 0 {
		t.Fatalf("write onto a folder: %d %v", rev, err)
	}
	if got := readRevFile(t, st, a.ID); got != "1" || s.Rev(a.ID) != 1 {
		t.Errorf("after a failed write: scene.rev %q, Rev %d", got, s.Rev(a.ID))
	}
	// A board never written: the revision put back is 0.
	if _, err := s.SaveAt(b.ID, 0, []byte(`{}`)); err == nil {
		t.Fatal("write onto a folder succeeded")
	}
	if got := readRevFile(t, st, b.ID); got != "0" || s.Rev(b.ID) != 0 {
		t.Errorf("never written: scene.rev %q, Rev %d", got, s.Rev(b.ID))
	}

	// The same base is still good once the drawing can be written, and after a reload.
	fresh := New(st, &recorder{})
	if err := fresh.Load(); err != nil {
		t.Fatal(err)
	}
	for _, svc := range []*Service{fresh, s} {
		if got := svc.Rev(a.ID); got != 1 {
			t.Errorf("Rev %d", got)
		}
	}
	if err := os.Remove(st.P.BoardFile(a.ID)); err != nil {
		t.Fatal(err)
	}
	if rev, err := s.SaveAt(a.ID, 1, []byte(`{"elements":[]}`)); err != nil || rev != 2 {
		t.Errorf("write after the failure: %d %v", rev, err)
	}
}

func TestDeleteThenNewBoardStartsAtZero(t *testing.T) {
	s, st, _ := setup(t)
	a, _ := s.Create("a", model.Ungrouped, false)
	if _, err := s.SaveAt(a.ID, 0, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(a.ID); err != nil {
		t.Fatal(err)
	}
	if got := s.Rev(a.ID); got != 0 {
		t.Errorf("deleted board at revision %d", got)
	}
	if _, err := s.SaveAt(a.ID, 0, []byte(`{}`)); !errors.Is(err, ErrNotFound) {
		t.Errorf("write to a deleted board: %v", err)
	}
	if _, err := os.Stat(st.P.BoardDir(a.ID)); !os.IsNotExist(err) {
		t.Errorf("folder back after a refused write: %v", err)
	}
	b, _ := s.Create("a", model.Ungrouped, false)
	if raw, rev, err := s.SceneAt(b.ID); err != nil || rev != 0 || string(raw) != EmptyScene {
		t.Errorf("new board: %q %d %v", raw, rev, err)
	}
	if rev, err := s.SaveAt(b.ID, 0, []byte(`{}`)); err != nil || rev != 1 {
		t.Errorf("first write of the new board: %d %v", rev, err)
	}
}

func TestGroups(t *testing.T) {
	s, st, _ := setup(t)
	if err := st.Update(func(st *model.State) error {
		st.Groups = append(st.Groups,
			model.Group{ID: "g_two", Name: "Two", Parent: groupID},
			model.Group{ID: "g_three", Name: "Three", Parent: "g_two"},
			model.Group{ID: "g_loop", Name: "Loop", Parent: "g_loop"},
			model.Group{ID: "g_orphan", Name: "Orphan", Parent: "g_gone"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if got := s.Groups(); len(got) != 0 {
		t.Errorf("no boards: %v", got)
	}
	want := map[string][]string{}
	for group, path := range map[string][]string{
		model.Ungrouped: {},
		groupID:         {"One"},
		"g_three":       {"One", "Two", "Three"},
		"g_loop":        {"Loop"},
		"g_orphan":      {"Orphan"},
	} {
		bd, err := s.Create("x", group, false)
		if err != nil {
			t.Fatal(err)
		}
		want[bd.ID] = path
	}
	if got := s.Groups(); !reflect.DeepEqual(got, want) {
		t.Errorf("groups %v\nwant %v", got, want)
	}
}

// listing is a bridge that reads the boards while it sends, as the real one does for a snapshot.
type listing struct {
	s    *Service
	mu   sync.Mutex
	seen []string // the event's type and how many boards List gave inside the send
}

func (l *listing) Broadcast(ev any) {
	n := len(l.s.List())
	l.s.Groups()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seen = append(l.seen, ev.(map[string]any)["type"].(string)+" "+string(rune('0'+n)))
}

func TestBroadcastOutsideTheLock(t *testing.T) {
	st, err := store.Open(store.NewPaths(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	l := &listing{}
	s := New(st, l)
	l.s = s

	done := make(chan struct{})
	go func() {
		defer close(done)
		a, err := s.Create("a", model.Ungrouped, false)
		if err != nil {
			t.Error(err)
			return
		}
		if _, err := s.Rename(a.ID, "b"); err != nil {
			t.Error(err)
		}
		if err := s.Delete(a.ID); err != nil {
			t.Error(err)
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Broadcast is called with the boards lock held: List inside it never returned")
	}
	want := []string{"board 1", "board 1", "board_removed 0"}
	if !reflect.DeepEqual(l.seen, want) {
		t.Errorf("seen %v, want %v", l.seen, want)
	}
}

// ordered is a bridge with a lock of its own that reads the boards under it, in both directions.
type ordered struct {
	s     *Service
	mu    sync.Mutex
	names []string
}

func (o *ordered) Broadcast(ev any) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if bd, ok := ev.(map[string]any)["board"].(model.Board); ok {
		o.names = append(o.names, bd.Name)
	}
}

// snapshot is the bridge's connect: its lock first, then the boards.
func (o *ordered) snapshot() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.s.List()
}

func TestEventsKeepOrderUnderConnects(t *testing.T) {
	st, err := store.Open(store.NewPaths(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	o := &ordered{}
	s := New(st, o)
	o.s = s
	a, _ := s.Create("start", model.Ungrouped, false)

	const writers, each = 4, 25
	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		stop := make(chan struct{})
		for i := 0; i < 3; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for {
					select {
					case <-stop:
						return
					default:
						o.snapshot()
						s.Rev(a.ID)
					}
				}
			}()
		}
		var ww sync.WaitGroup
		for w := 0; w < writers; w++ {
			ww.Add(1)
			go func(w int) {
				defer ww.Done()
				for i := 0; i < each; i++ {
					name := string(rune('a'+w)) + "-" + strings.Repeat("x", i+1)
					if _, err := s.Rename(a.ID, name); err != nil {
						t.Error(err)
					}
					// Another writer may save between the read of the revision and the save:
					// the save is then refused as stale and made again.
					for {
						_, err := s.SaveAt(a.ID, s.Rev(a.ID), []byte(`{}`))
						var stale StaleError
						if errors.As(err, &stale) {
							continue
						}
						if err != nil {
							t.Error(err)
						}
						break
					}
				}
			}(w)
		}
		ww.Wait()
		close(stop)
		wg.Wait()
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("deadlock between the boards lock and the bridge's lock")
	}

	// The last event names the board as it is stored: the events went out in the order of the
	// changes.
	o.mu.Lock()
	defer o.mu.Unlock()
	bd, _ := s.Get(a.ID)
	if len(o.names) != 1+writers*each || o.names[len(o.names)-1] != bd.Name {
		t.Errorf("%d events, last %q, stored %q", len(o.names), o.names[len(o.names)-1], bd.Name)
	}
	if got := s.Rev(a.ID); got != writers*each {
		t.Errorf("revision %d after %d saves", got, writers*each)
	}
}
