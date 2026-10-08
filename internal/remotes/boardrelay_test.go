package remotes

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/store"
)

// TestBoardViewOf: a board record as a page gets it. The id, the place, the mark and the action
// are this server's, a pending change wins over the mark, and what only the board's server
// needs is cleared.
func TestBoardViewOf(t *testing.T) {
	t.Parallel()
	there := remoteBoard(boardA)
	there.ID, there.Origin, there.New = "b_other000", boardB, true
	there.Archived, there.Op = true, "op_there"
	rec := BoardRecord{ID: boardA, Entry: "s_0123456789ab", Group: "g_here", View: there}

	v := boardViewOf(rec)
	want := model.Board{ID: boardA, Name: there.Name, Group: "g_here", Created: there.Created, New: true, Server: "s_0123456789ab"}
	if !reflect.DeepEqual(v, want) {
		t.Errorf("the view is %+v, want %+v", v, want)
	}
	b, _ := json.Marshal(v)
	var keys map[string]any
	_ = json.Unmarshal(b, &keys)
	for _, k := range []string{"client", "origin", "archived", "archiveOp", "gone"} {
		if _, has := keys[k]; has {
			t.Errorf("the view has %q: %s", k, b)
		}
	}

	rec.Archived, rec.Op, rec.Gone = true, "op_here", true
	if v := boardViewOf(rec); !v.Archived || v.Op != "op_here" || !v.Gone {
		t.Errorf("the mark, the action and gone: %+v", v)
	}
	rec.Pending = pendingUnarchive
	if v := boardViewOf(rec); v.Archived {
		t.Error("a pending unarchive does not win over the mark")
	}
	rec.Archived, rec.Pending = false, pendingArchive
	if v := boardViewOf(rec); !v.Archived {
		t.Error("a pending archive does not win over the mark")
	}
}

// TestBoardRecordApply: what a record takes of a board its server sends, in an event and at a
// snapshot.
func TestBoardRecordApply(t *testing.T) {
	t.Parallel()
	archived := remoteBoard(boardA)
	archived.Archived = true
	plain := remoteBoard(boardA)

	rec := BoardRecord{ID: boardA, Gone: true, View: plain}
	renamed := plain
	renamed.Name = "Plan"
	if !rec.apply(renamed, false) || rec.Gone || rec.View.Name != "Plan" {
		t.Errorf("a board that is there again: %+v", rec)
	}
	if rec.apply(plain, false) {
		t.Error("a view alone is durable")
	}
	if !rec.apply(archived, false) || !rec.Archived {
		t.Errorf("the server's mark is not taken: %+v", rec)
	}
	// A pending change is confirmed by an event that equals it, and stays at a snapshot.
	rec = BoardRecord{ID: boardA, Pending: pendingArchive, Op: "op_1", View: plain}
	if rec.apply(plain, true) || rec.Pending != pendingArchive || rec.Archived || rec.Op != "op_1" {
		t.Errorf("a pending change at a snapshot: %+v", rec)
	}
	if !rec.apply(archived, false) || rec.Pending != "" || !rec.Archived || rec.Op != "op_1" {
		t.Errorf("a pending change that an event confirms: %+v", rec)
	}
	if !rec.apply(plain, false) || rec.Archived || rec.Op != "" {
		t.Errorf("the action is not over with the mark: %+v", rec)
	}
}

// TestBoardFiles: where a board record's file is, its mode, and when it is written: at once for
// the adoption, the mark and the gone mark; a view alone waits for the flush, and Close writes
// what waits. A relay on the same folder then has the records again, and the page's snapshot
// has their views.
func TestBoardFiles(t *testing.T) {
	t.Parallel()
	seed := boardSeedOf(boardA)
	rg := newRig(t, rigOpt{
		snapshot: snapshotWithBoards(seed.View), boardSeed: []BoardRecord{seed},
		limits: Limits{Flush: time.Hour}, // no flush but Close's
	})
	p, _ := rg.page("page-1")
	rec := rg.r.boardRec(boardA)
	dirty := func() bool {
		rec.mu.Lock()
		defer rec.mu.Unlock()
		return rec.dirty
	}

	path := store.NewPaths(rg.root).RemoteBoardFile(boardA)
	if rg.r.boardFiles.path(boardA) != path || path != filepath.Join(rg.root, "remote", "boards", boardA+".json") {
		t.Errorf("the file is %s", rg.r.boardFiles.path(boardA))
	}
	if got := mode(t, path); got != 0o600 {
		t.Errorf("the file's mode is %o", got)
	}
	if got := mode(t, filepath.Dir(path)); got != 0o700 {
		t.Errorf("the folder's mode is %o", got)
	}
	if d := rg.boardFile(boardA); d.ID != boardA || d.Entry != rg.entry || d.Group != "g_here" || d.View.Group != "g_remote" || d.View.Client != testLocalID {
		t.Errorf("the file after the adoption: %+v", d)
	}

	// A view alone waits for the flush.
	renamed := remoteBoard(boardA)
	renamed.Name = "Plan"
	rg.s.Send(map[string]any{"type": "board", "board": renamed})
	if ev := p.Expect("board"); field(ev, "board", "name") != "Plan" {
		t.Errorf("the page's event: %v", ev)
	}
	rg.barrier(p)
	if d := rg.boardFile(boardA); d.View.Name == "Plan" || !dirty() {
		t.Errorf("a view was written before the flush: %+v, dirty %v", d, dirty())
	}
	// The mark is written at once, with the view of that moment.
	renamed.Archived = true
	rg.s.Send(map[string]any{"type": "board", "board": renamed})
	rg.barrier(p)
	if d := rg.boardFile(boardA); !d.Archived || d.View.Name != "Plan" || dirty() {
		t.Errorf("the mark is not written at once: %+v, dirty %v", d, dirty())
	}
	// Close writes what waits.
	renamed.Name = "Plan B"
	rg.s.Send(map[string]any{"type": "board", "board": renamed})
	rg.barrier(p)
	if d := rg.boardFile(boardA); d.View.Name != "Plan" || !dirty() {
		t.Errorf("before Close: %+v, dirty %v", d, dirty())
	}
	rg.m.Close()
	rg.r.Close()
	if d := rg.boardFile(boardA); d.View.Name != "Plan B" || dirty() {
		t.Errorf("after Close: %+v, dirty %v", d, dirty())
	}
	if got := names(t, filepath.Dir(path)); !reflect.DeepEqual(got, []string{boardA + ".json"}) {
		t.Errorf("the folder holds %v", got)
	}
	noSecret(t, "the file", string(mustRead(t, path)))

	// The round trip: a relay on the same folder has the record as it was written.
	again := newRig(t, rigOpt{root: rg.root, snapshot: snapshotWithBoards(renamed), hold: true})
	want := model.Board{ID: boardA, Name: "Plan B", Group: "g_here", Created: seed.View.Created, Server: rg.entry}
	want.Archived = true
	if got := again.r.BoardViews(); !reflect.DeepEqual(got, []model.Board{want}) {
		t.Errorf("the views after a load: %+v", got)
	}
	if entry, group, archived, ok := again.r.BoardOn(boardA); entry != rg.entry || group != "g_here" || !archived || !ok {
		t.Errorf("BoardOn after a load: %q %q %v %v", entry, group, archived, ok)
	}
	if rev, ok := again.r.BoardRev(boardA); rev != 0 || !ok {
		t.Errorf("BoardRev after a load: %d, %v", rev, ok)
	}
	_, snap := again.page("page-2")
	if list, _ := snap["boards"].([]any); len(list) != 1 || field(list[0], "id") != boardA || field(list[0], "server") != rg.entry {
		t.Errorf("the page's snapshot has the boards %v", snap["boards"])
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestBoardFlush: a view that changed is in the file within the flush's time, with no other change.
func TestBoardFlush(t *testing.T) {
	t.Parallel()
	seed := boardSeedOf(boardA)
	rg := newRig(t, rigOpt{snapshot: snapshotWithBoards(seed.View), boardSeed: []BoardRecord{seed}})
	renamed := remoteBoard(boardA)
	renamed.Name = "Plan"
	rg.s.Send(map[string]any{"type": "board", "board": renamed})
	rg.until("the view is flushed", func() bool { return rg.boardFile(boardA).View.Name == "Plan" })
}

// TestBoardLoad: what Open makes of the folder. The record of an entry that is not in the list
// goes with its file; a file that is no record is skipped, logged and left; what a cut write
// left is removed.
func TestBoardLoad(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	dir := store.NewPaths(root).RemoteBoards
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	put := func(name string, v any) {
		b, _ := json.Marshal(v)
		if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	missing := boardSeedOf(boardA)
	missing.Entry = "s_000000000000"
	local := boardSeedOf(boardB)
	local.Entry = servers.LocalID
	put(boardA+".json", missing)
	put(boardB+".json", local)
	put(boardC+".json", map[string]any{"id": boardA, "entry": "s_000000000000"}) // another record's
	put("b_dddd0004.json", map[string]any{"id": "b_dddd0004"})                   // no server
	put("notaboard.json", boardSeedOf(boardA))
	put("b_eeee0005.json.tmp", "cut")

	rg := newRig(t, rigOpt{root: root, hold: true})
	if rg.r.HasBoard(boardA) || rg.r.HasBoard(boardB) || rg.r.HasBoard(boardC) || len(rg.r.BoardViews()) != 0 {
		t.Errorf("records were loaded: %+v", rg.r.BoardViews())
	}
	if got, want := names(t, dir), []string{boardC + ".json", "b_dddd0004.json", "notaboard.json"}; !sameSet(got, want) {
		t.Errorf("the folder holds %v, want %v", got, want)
	}
	if n := rg.logs.count("its server is no longer in the list"); n != 2 {
		t.Errorf("%d records were logged as removed: %v", n, rg.logs.all())
	}
	if n := rg.logs.count("is skipped"); n != 3 {
		t.Errorf("%d files were logged as skipped: %v", n, rg.logs.all())
	}
	if _, _, _, ok := rg.r.BoardOn(boardA); ok {
		t.Error("BoardOn knows a board without a record")
	}
	if _, ok := rg.r.BoardView(boardA); ok {
		t.Error("BoardView knows a board without a record")
	}
	if _, ok := rg.r.BoardRev(boardA); ok {
		t.Error("BoardRev knows a board without a record")
	}
}

// TestBoardEvents: a board event of the record's server updates the record and reaches the
// pages as this server's view; board_removed drops the record with its file. A board of
// another entry's record is not touched.
func TestBoardEvents(t *testing.T) {
	t.Parallel()
	seed := boardSeedOf(boardA)
	rg := newRig(t, rigOpt{snapshot: snapshotWithBoards(seed.View), boardSeed: []BoardRecord{seed}})
	p, snap := rg.page("page-1")
	if list, _ := snap["boards"].([]any); len(list) != 1 {
		t.Fatalf("the page's snapshot has the boards %v", snap["boards"])
	}

	renamed := remoteBoard(boardA)
	renamed.Name, renamed.New, renamed.Origin = "Plan", true, boardB
	rg.s.Send(map[string]any{"type": "board", "board": renamed})
	ev := p.Expect("board")
	want := map[string]any{"id": boardA, "name": "Plan", "group": "g_here", "created": "2026-10-06T09:00:00Z", "new": true, "server": rg.entry}
	if !reflect.DeepEqual(ev["board"], want) {
		t.Errorf("the page's event is %v, want %v", ev["board"], want)
	}
	if v, ok := rg.r.BoardView(boardA); !ok || v.Name != "Plan" || v.Group != "g_here" || v.Client != "" || v.Origin != "" {
		t.Errorf("BoardView: %+v", v)
	}

	// The record of another entry is not this server's to change or to remove.
	rec := rg.r.boardRec(boardA)
	rg.r.boardEvent("s_other", "board", mustJSON(t, map[string]any{"board": remoteBoard(boardA)}))
	rg.r.boardEvent("s_other", "board_removed", mustJSON(t, map[string]any{"id": boardA}))
	if v, _ := rg.r.BoardView(boardA); v.Name != "Plan" || rg.r.boardRec(boardA) != rec {
		t.Errorf("another entry changed the record: %+v", v)
	}
	// Events that cannot be read, and the removal of a board without a record, do nothing.
	rg.r.boardEvent(rg.entry, "board", json.RawMessage(`{"board":7}`))
	rg.r.boardEvent(rg.entry, "board_removed", json.RawMessage(`{"id":"b_zzzz9999"}`))
	rg.r.boardEvent(rg.entry, "board", json.RawMessage(`{"board":{"id":"../x"}}`))
	if rg.barrier(p)[0] != nil || len(rg.r.BoardViews()) != 1 {
		t.Errorf("an event that is none had an effect: %+v", rg.r.BoardViews())
	}

	rg.s.Send(map[string]any{"type": "board_removed", "id": boardA})
	if ev := p.Expect("board_removed"); ev["id"] != boardA || len(ev) != 2 {
		t.Errorf("board_removed: %v", ev)
	}
	if rg.r.HasBoard(boardA) || len(rg.r.BoardViews()) != 0 {
		t.Error("the record is left after board_removed")
	}
	if _, ok := rg.r.BoardRev(boardA); ok {
		t.Error("BoardRev knows the removed board")
	}
	if left := names(t, rg.r.boardFiles.dir); len(left) != 0 {
		t.Errorf("files left: %v", left)
	}
	// The role events and a tool call of a board without a record give the pages nothing.
	for _, typ := range []string{"held", "release_request", "superseded", "rpc"} {
		rg.s.Send(map[string]any{"type": typ, "board": boardA, "id": "rpc_1"})
	}
	if got := rg.barrier(p)[0]; got != nil {
		t.Errorf("the pages got %v", got)
	}
}

func mustJSON(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestBoardAdoption: a board event of a board without a record makes one: in the group of the
// record its Origin names, else in the ungrouped area. No record is made under an id whose
// creation is on its way, or for an entry that was removed.
func TestBoardAdoption(t *testing.T) {
	t.Parallel()
	seed := boardSeedOf(boardA)
	rg := newRig(t, rigOpt{snapshot: snapshotWithBoards(seed.View), boardSeed: []BoardRecord{seed}})
	p, _ := rg.page("page-1")

	child := remoteBoard(boardB)
	child.Origin, child.New = boardA, true
	rg.s.Send(map[string]any{"type": "board", "board": child})
	if ev := p.Expect("board"); field(ev, "board", "id") != boardB || field(ev, "board", "group") != "g_here" || field(ev, "board", "server") != rg.entry || field(ev, "board", "new") != true {
		t.Errorf("the adopted board with an origin: %v", ev)
	}
	if d := rg.boardFile(boardB); d.Entry != rg.entry || d.Group != "g_here" || d.View.Origin != boardA {
		t.Errorf("its file: %+v", d)
	}

	orphan := remoteBoard(boardC)
	orphan.Origin, orphan.Archived = "b_zzzz9999", true // an origin without a record
	rg.s.Send(map[string]any{"type": "board", "board": orphan})
	if ev := p.Expect("board"); field(ev, "board", "id") != boardC || field(ev, "board", "group") != model.Ungrouped || field(ev, "board", "archived") != true {
		t.Errorf("the adopted board without an origin: %v", ev)
	}
	if d := rg.boardFile(boardC); d.Group != model.Ungrouped || !d.Archived {
		t.Errorf("its file: %+v", d)
	}
	// The next event of an adopted board is an event of its record.
	child.Name = "Sketch"
	rg.s.Send(map[string]any{"type": "board", "board": child})
	if ev := p.Expect("board"); field(ev, "board", "name") != "Sketch" || field(ev, "board", "group") != "g_here" {
		t.Errorf("the second event: %v", ev)
	}

	// While a creation of the id is on its way its event makes no record: the creation does.
	done := rg.r.makingBoard("b_dddd0004")
	rg.s.Send(map[string]any{"type": "board", "board": remoteBoard("b_dddd0004")})
	if got := rg.barrier(p)[0]; got != nil || rg.r.HasBoard("b_dddd0004") {
		t.Errorf("a board that is being created was adopted: %v", got)
	}
	done()
	rg.s.Send(map[string]any{"type": "board", "board": remoteBoard("b_dddd0004")})
	if ev := p.Expect("board"); field(ev, "board", "id") != "b_dddd0004" {
		t.Errorf("after the creation: %v", ev)
	}
	// An id that is no board's gets no record, and that is logged.
	rg.s.Send(map[string]any{"type": "board", "board": remoteBoard("B_UPPER001")})
	if got := rg.barrier(p)[0]; got != nil || rg.logs.count("gets no record here") != 1 {
		t.Errorf("a bad id: %v, %v", got, rg.logs.all())
	}
	if _, err := rg.r.adoptBoard(BoardRecord{ID: boardA, Entry: rg.entry}); !errors.Is(err, errTaken) {
		t.Errorf("a second record of an id: %v", err)
	}
	if _, err := rg.r.adoptBoard(BoardRecord{ID: boardA, Entry: servers.LocalID}); !errors.Is(err, errBadRecord) {
		t.Errorf("a record on this computer: %v", err)
	}
	if _, err := rg.r.adoptBoard(BoardRecord{ID: "b_ffff0006", Entry: "s_000000000000"}); !errors.Is(err, errNoEntry) {
		t.Errorf("a record of an entry that is not in the list: %v", err)
	}
}

// TestBoardSnapshot: the board steps of a snapshot. Every record takes the snapshot's board,
// where a pending archive change stays; a record the snapshot lacks is marked gone; a board
// without a record is adopted; and after server_back the pages get every record's view.
func TestBoardSnapshot(t *testing.T) {
	t.Parallel()
	a, b, c := boardSeedOf(boardA), boardSeedOf(boardB), boardSeedOf(boardC)
	c.Pending, c.Op = pendingArchive, "op_1"
	rg := newRig(t, rigOpt{snapshot: snapshotWithBoards(a.View, b.View, c.View), boardSeed: []BoardRecord{a, b, c}, hold: true})
	// The pending change is passed on at every snapshot; this server cannot say, so it stays.
	rg.script("POST /api/boards/{id}/archive").answer(http.StatusServiceUnavailable, map[string]string{"error": "busy"})
	rg.start()
	p, _ := rg.page("page-1")

	renamed := remoteBoard(boardA)
	renamed.Name = "Plan"
	child, orphan := remoteBoard("b_dddd0004"), remoteBoard("b_eeee0005")
	child.Origin = boardA
	rg.s.SetSnapshot(snapshotWithBoards(renamed, c.View, child, orphan)) // boardB is no longer there
	rg.s.DropStreams()
	rg.returned(2)

	p.Expect("server_lists")
	p.Expect("server_back")
	want := []struct {
		id, name, group string
		gone, archived  bool
	}{
		{boardA, "Plan", "g_here", false, false},
		{boardB, "Board bb", "g_here", true, false},
		{boardC, "Board cc", "g_here", false, true}, // the pending change wins over the server's mark
		{"b_dddd0004", "Board dd", "g_here", false, false},
		{"b_eeee0005", "Board ee", model.Ungrouped, false, false},
	}
	for _, w := range want {
		ev := p.Expect("board")
		v, _ := ev["board"].(map[string]any)
		if v["id"] != w.id || v["name"] != w.name || v["group"] != w.group || (v["gone"] == true) != w.gone || (v["archived"] == true) != w.archived || v["server"] != rg.entry {
			t.Errorf("the event of %s: %v", w.id, v)
		}
	}
	if got := rg.barrier(p)[0]; got != nil {
		t.Errorf("more events after the snapshot: %v", got)
	}
	if d := rg.boardFile(boardB); !d.Gone {
		t.Errorf("the gone mark is not written: %+v", d)
	}
	if d := rg.boardFile(boardC); d.Pending != pendingArchive || d.Archived || d.Op != "op_1" {
		t.Errorf("the pending change did not stay: %+v", d)
	}
	if d := rg.boardFile("b_dddd0004"); d.Group != "g_here" || d.Entry != rg.entry {
		t.Errorf("the adopted board: %+v", d)
	}

	// A board that is there again is no longer gone.
	rg.s.SetSnapshot(snapshotWithBoards(renamed, b.View, c.View, child, orphan))
	rg.s.DropStreams()
	rg.returned(3)
	if v, _ := rg.r.BoardView(boardB); v.Gone {
		t.Error("the board is still gone")
	}
	// A snapshot that names no boards, of a server that serves none, changes no record.
	p.Drain(quiet)
	rg.s.SetSnapshot(snapshotWith())
	rg.s.DropStreams()
	rg.returned(4)
	p.Expect("server_lists")
	p.Expect("server_back")
	for range want {
		if ev := p.Expect("board"); field(ev, "board", "gone") == true {
			t.Errorf("a board is gone after a snapshot without boards: %v", ev)
		}
	}
}

// TestBoardEntryRemoved: the removal of an entry drops its board records with their files and
// tells the pages; no record is adopted for the entry after it.
func TestBoardEntryRemoved(t *testing.T) {
	t.Parallel()
	a, b := boardSeedOf(boardA), boardSeedOf(boardB)
	rg := newRig(t, rigOpt{snapshot: snapshotWithBoards(a.View, b.View), boardSeed: []BoardRecord{a, b}})
	p, _ := rg.page("page-1")

	sent := len(rg.s.Requests())
	if err := rg.m.Remove(rg.entry); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{boardA, boardB} {
		if ev := p.Expect("board_removed"); ev["id"] != id {
			t.Errorf("board_removed: %v, want %s", ev, id)
		}
	}
	p.Expect("server_lists")
	if rg.r.HasBoard(boardA) || rg.r.HasBoard(boardB) || len(rg.r.BoardViews()) != 0 {
		t.Error("records are left after the removal")
	}
	if left, err := os.ReadDir(rg.r.boardFiles.dir); err != nil || len(left) != 0 {
		t.Errorf("files left after the removal: %v, %v", left, err)
	}
	if got := rg.s.Requests()[sent:]; len(got) != 0 {
		t.Errorf("the removed server was sent %+v", got)
	}
	if _, err := rg.r.adoptBoard(BoardRecord{ID: boardC, Entry: rg.entry}); !errors.Is(err, errNoEntry) {
		t.Errorf("a record of the removed entry: %v", err)
	}
}

// TestBoardDeletable: the check before a group is deleted with its contents counts the board
// records: one that is not gone and whose server is not connected stands in the way.
func TestBoardDeletable(t *testing.T) {
	t.Parallel()
	inside, unnamed, outside, goneRec := boardSeedOf(boardA), boardSeedOf(boardB), boardSeedOf(boardC), boardSeedOf("b_dddd0004")
	inside.Group, inside.View.Name = "g_sub", "Floor plan"
	unnamed.Group, unnamed.View.Name = "g_top", ""
	outside.Group = "g_else"
	goneRec.Group, goneRec.Gone = "g_gone", true
	rg := newRig(t, rigOpt{boardSeed: []BoardRecord{inside, unnamed, outside, goneRec}}) // a snapshot without boards
	tree := map[string]bool{"g_top": true, "g_sub": true}

	if err := rg.r.Deletable(tree); err != nil {
		t.Errorf("with the server connected: %v", err)
	}
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	err := rg.r.Deletable(tree)
	var e *Error
	if !errors.As(err, &e) || e.Status != http.StatusConflict || e.Code != "server_unreachable" || !errors.Is(err, ErrUnreachable) ||
		e.Text != "Nothing was deleted: “Floor plan” is on Studio, which is not connected." {
		t.Errorf("with the server away: %v", err)
	}
	if err := rg.r.Deletable(map[string]bool{"g_top": true}); err == nil ||
		err.Error() != "Nothing was deleted: “Untitled” is on Studio, which is not connected." {
		t.Errorf("an unnamed board: %v", err)
	}
	// Records outside the groups, and gone ones, do not stand in the way.
	if err := rg.r.Deletable(map[string]bool{"g_other": true, "g_gone": true}); err != nil {
		t.Errorf("groups without a record that counts: %v", err)
	}
}
