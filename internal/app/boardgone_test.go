package app

import (
	"slices"
	"sync"
	"testing"

	"ai-whiteboard/internal/model"
)

// goneLog records the calls of App.BoardGone, with what the store said of the board at that moment.
type goneLog struct {
	mu    sync.Mutex
	calls []string // "<id> <reason> <state>": state is "archived", "missing" or "live"
}

func (e *env) recordGone() *goneLog {
	l := &goneLog{}
	e.a.BoardGone = func(id, reason string) {
		state := "missing"
		if b, ok := e.a.Boards.Get(id); ok {
			state = "live"
			if b.Archived {
				state = "archived"
			}
		}
		l.mu.Lock()
		l.calls = append(l.calls, id+" "+reason+" "+state)
		l.mu.Unlock()
	}
	return l
}

func (l *goneLog) take() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.calls
	l.calls = nil
	slices.Sort(out)
	return out
}

func (e *env) tlBoard(group string) string {
	e.t.Helper()
	b, err := e.a.Boards.Create("new board", group, false, model.KindTL)
	if err != nil {
		e.t.Fatal(err)
	}
	return b.ID
}

// BoardGone is told of every new board that is archived or deleted, after the store's change: alone,
// with its group (and the group's subgroups), and never of a classic board.
func TestBoardGone(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	l := e.recordGone()
	want := func(what string, w ...string) {
		t.Helper()
		slices.Sort(w)
		if got := l.take(); !slices.Equal(got, w) {
			t.Fatalf("%s: BoardGone got %q, want %q", what, got, w)
		}
	}

	// One board, archived and then deleted; a classic board beside it is never named.
	tl, classic := e.tlBoard(model.Ungrouped), e.board(model.Ungrouped)
	e.must(e.a.Archive(KindBoard, tl))
	e.must(e.a.Archive(KindBoard, classic))
	want("archive of a board", tl+" archived archived")
	e.must(e.a.DeleteBoard(tl))
	e.must(e.a.DeleteBoard(classic))
	want("delete of a board", tl+" deleted missing")

	// A group archived: its boards and its subgroup's, but not one archived before.
	g := e.group("g")
	sub := e.subgroup("sub", g)
	inG, inSub, before := e.tlBoard(g), e.tlBoard(sub), e.tlBoard(g)
	e.board(g)
	e.must(e.a.Archive(KindBoard, before))
	want("archive before the group's", before+" archived archived")
	e.must(e.a.Archive(KindGroup, g))
	want("archive of a group", inG+" archived archived", inSub+" archived archived")

	// A group deleted with its contents: every board, archived or not; one moved up is not named.
	h := e.group("h")
	hsub := e.subgroup("hsub", h)
	a, b := e.tlBoard(h), e.tlBoard(hsub)
	e.must(e.a.Archive(KindBoard, b))
	want("archive in h", b+" archived archived")
	e.must(e.a.DeleteGroup(h, true))
	want("delete of a group with its contents", a+" deleted missing", b+" deleted missing")

	k := e.group("k")
	moved := e.tlBoard(k)
	e.must(e.a.DeleteGroup(k, false))
	want("delete of a group whose contents move up")
	if _, ok := e.a.Boards.Get(moved); !ok {
		t.Fatal("the board of a group deleted without its contents is gone")
	}

	// Nobody to tell: nothing breaks.
	e.a.BoardGone = nil
	e.must(e.a.Archive(KindBoard, moved))
	e.must(e.a.DeleteBoard(moved))
}
