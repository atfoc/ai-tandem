package boards

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// A tl board's board.json names its kind and nothing else is written; a classic board's
// board.json has no "kind" key, and its drawing is there as before.
func TestCreateKinds(t *testing.T) {
	s, st, r := setup(t)
	tl, err := s.Create("new", model.Ungrouped, false, model.KindTL)
	if err != nil {
		t.Fatal(err)
	}
	r.wantBoardEvent(t, tl)
	if tl.Kind != model.KindTL || readBoardJSON(t, st, tl.ID).Kind != model.KindTL {
		t.Fatalf("tl board kind %q", tl.Kind)
	}
	raw, _ := os.ReadFile(filepath.Join(st.P.BoardDir(tl.ID), "board.json"))
	if !strings.Contains(string(raw), `"kind": "tl"`) {
		t.Fatalf("tl board.json %s", raw)
	}
	ents, _ := os.ReadDir(st.P.BoardDir(tl.ID))
	if len(ents) != 1 || ents[0].Name() != "board.json" {
		t.Fatalf("tl board folder holds %v, want board.json only", ents)
	}

	c, err := s.Create("old", model.Ungrouped, false, model.KindClassic)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(filepath.Join(st.P.BoardDir(c.ID), "board.json"))
	if strings.Contains(string(raw), `"kind"`) {
		t.Fatalf("classic board.json has a kind: %s", raw)
	}
	if got, _ := os.ReadFile(st.P.BoardFile(c.ID)); string(got) != EmptyScene {
		t.Fatalf("classic drawing %q", got)
	}

	n := r.count()
	if _, err := s.Create("x", model.Ungrouped, false, "excalidraw"); !errors.Is(err, ErrBadKind) {
		t.Fatalf("bad kind: %v", err)
	}
	if r.count() != n || len(s.List()) != 2 {
		t.Fatal("a refused kind made a board")
	}
}

// Load reads a tl board's kind back.
func TestLoadKeepsKind(t *testing.T) {
	s, st, _ := setup(t)
	tl, _ := s.Create("new", model.Ungrouped, false, model.KindTL)
	s2 := New(st, &recorder{})
	if err := s2.Load(); err != nil {
		t.Fatal(err)
	}
	if bd, ok := s2.Get(tl.ID); !ok || bd.Kind != model.KindTL || !s2.IsTL(tl.ID) {
		t.Fatalf("loaded %+v %v", bd, ok)
	}
}

func TestSnapshotRoundTrip(t *testing.T) {
	s, st, _ := setup(t)
	tl, _ := s.Create("new", model.Ungrouped, false, model.KindTL)
	raw, exists, err := s.SnapshotAt(tl.ID)
	if raw != nil || exists || err != nil {
		t.Fatalf("no snapshot yet: %q %v %v", raw, exists, err)
	}
	for _, body := range []string{`{"clock":1,"documents":[]}`, `{"clock":2,"documents":[{"x":1}]}`} {
		if err := s.SaveSnapshot(tl.ID, []byte(body)); err != nil {
			t.Fatal(err)
		}
		raw, exists, err = s.SnapshotAt(tl.ID)
		if string(raw) != body || !exists || err != nil {
			t.Fatalf("snapshot %q %v %v, want %q", raw, exists, err, body)
		}
	}
	// Atomic: no temp file is left beside it, and nothing but board.json and the snapshot is there.
	ents, _ := os.ReadDir(st.P.BoardDir(tl.ID))
	var names []string
	for _, e := range ents {
		names = append(names, e.Name())
	}
	if strings.Join(names, ",") != "board.json,snapshot.tl.json" {
		t.Fatalf("folder holds %v", names)
	}
	if err := s.Delete(tl.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(st.P.BoardSnapshot(tl.ID)); !os.IsNotExist(err) {
		t.Fatalf("snapshot after delete: %v", err)
	}
	if err := s.SaveSnapshot(tl.ID, []byte(`{}`)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("save after delete: %v", err)
	}
}

func TestSnapshotRefusals(t *testing.T) {
	s, st, _ := setup(t)
	tl, _ := s.Create("new", model.Ungrouped, false, model.KindTL)
	c, _ := s.Create("old", model.Ungrouped, false, model.KindClassic)

	if _, _, err := s.SnapshotAt("b_nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("SnapshotAt unknown: %v", err)
	}
	if err := s.SaveSnapshot("b_nope", []byte(`{}`)); !errors.Is(err, ErrNotFound) {
		t.Errorf("SaveSnapshot unknown: %v", err)
	}
	if _, _, err := s.SnapshotAt(c.ID); !errors.Is(err, ErrNotTL) {
		t.Errorf("SnapshotAt classic: %v", err)
	}
	if err := s.SaveSnapshot(c.ID, []byte(`{}`)); !errors.Is(err, ErrNotTL) {
		t.Errorf("SaveSnapshot classic: %v", err)
	}
	if _, err := os.Stat(st.P.BoardSnapshot(c.ID)); !os.IsNotExist(err) {
		t.Errorf("classic board got a snapshot: %v", err)
	}
	if err := s.SaveSnapshot(tl.ID, []byte(`{"clock":`)); !errors.Is(err, ErrBadSnapshot) {
		t.Errorf("SaveSnapshot invalid: %v", err)
	}
	if _, exists, _ := s.SnapshotAt(tl.ID); exists {
		t.Error("an invalid snapshot was written")
	}
	if _, _, err := s.SceneAt(tl.ID); !errors.Is(err, ErrTLBoard) {
		t.Errorf("SceneAt tl: %v", err)
	}
	if _, err := s.SaveAt(tl.ID, 0, []byte(EmptyScene)); !errors.Is(err, ErrTLBoard) {
		t.Errorf("SaveAt tl: %v", err)
	}
	if _, err := os.Stat(st.P.BoardFile(tl.ID)); !os.IsNotExist(err) {
		t.Errorf("tl board got a drawing: %v", err)
	}
	if _, err := os.Stat(s.revFile(tl.ID)); !os.IsNotExist(err) {
		t.Errorf("tl board got a scene.rev: %v", err)
	}
}

// A last save may arrive after an archive: SaveSnapshot does not look at the flag.
func TestSaveSnapshotArchived(t *testing.T) {
	s, _, _ := setup(t)
	tl, _ := s.Create("new", model.Ungrouped, false, model.KindTL)
	if err := s.SetArchive(tl.ID, model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveSnapshot(tl.ID, []byte(`{"clock":3}`)); err != nil {
		t.Fatalf("save on an archived tl board: %v", err)
	}
	if raw, exists, err := s.SnapshotAt(tl.ID); string(raw) != `{"clock":3}` || !exists || err != nil {
		t.Fatalf("snapshot %q %v %v", raw, exists, err)
	}
}
