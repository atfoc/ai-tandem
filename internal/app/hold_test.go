package app

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// page connects a stand-in page to the env's bridge. It never answers a release request.
func (e *env) page(id string) *bridgetest.Page {
	e.t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/events", e.a.Bridge.ServeSSE)
	srv := httptest.NewServer(mux)
	e.t.Cleanup(srv.Close)
	p := bridgetest.Connect(e.t, srv.URL, id)
	p.Welcome()
	return p
}

// shortFreeWait shortens the wait for a board's holder for the test.
func shortFreeWait(t *testing.T, d time.Duration) {
	old := freeWait
	freeWait = d
	t.Cleanup(func() { freeWait = old })
}

// A page that takes the board while its chats are archived or deleted (the board is free by
// then) does not stay its holder: the board is freed once more at the end.
func TestArchiveAndDeleteBoardLeaveNoHolder(t *testing.T) {
	for _, tc := range []struct {
		name string
		do   func(e *env, board string) error
	}{
		{"archive", func(e *env, board string) error { return e.a.Archive(KindBoard, board) }},
		{"delete", func(e *env, board string) error { return e.a.DeleteBoard(board) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			shortFreeWait(t, 200*time.Millisecond)
			e.page("P1")
			var mu sync.Mutex
			var b string
			taken := 0
			// The page takes the board if it is free each time one of its chats is stopped.
			e.a.Chats.Spawners[model.Claude] = hookSpawner{e.sp, func(string) {
				mu.Lock()
				defer mu.Unlock()
				if state, _, err := e.a.Bridge.TakeBoard("P1", b, true); err != nil {
					t.Error(err)
				} else if state == "held" {
					taken++
				}
			}}
			b = e.board(model.Ungrouped)
			for i := 0; i < 3; i++ {
				e.running("", b)
			}
			e.must(tc.do(e, b))
			mu.Lock()
			defer mu.Unlock()
			if taken == 0 {
				t.Fatal("the page never took the board in between")
			}
			if id, held := e.a.Bridge.HolderOf(b); held {
				t.Fatalf("%s still holds the board", id)
			}
		})
	}
}

// The boards of a group are freed at the same time: a page that holds them all and does not
// answer costs one wait, not one per board.
func TestGroupArchiveAndDeleteFreeBoardsTogether(t *testing.T) {
	const wait = 500 * time.Millisecond
	// Set here and not in the subtests: the two wait at the same time, and the test itself is
	// not parallel, so no other test of the package runs while the wait is short.
	shortFreeWait(t, wait)
	for _, tc := range []struct {
		name string
		do   func(e *env, group string) error
	}{
		{"archive", func(e *env, group string) error { return e.a.Archive(KindGroup, group) }},
		{"delete", func(e *env, group string) error { return e.a.DeleteGroup(group, true) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t)
			e.page("P1")
			g := e.group("G")
			var bs []string
			for i := 0; i < 3; i++ {
				b := e.board(g)
				if state, _, err := e.a.Bridge.TakeBoard("P1", b, false); err != nil || state != "held" {
					t.Fatalf("take of %s: %q %v", b, state, err)
				}
				bs = append(bs, b)
			}
			start := time.Now()
			e.must(tc.do(e, g))
			took := time.Since(start)
			if took < wait {
				t.Errorf("returned after %v: the holder was not given %v", took, wait)
			}
			if took >= 2*wait {
				t.Errorf("took %v for three boards with a wait of %v", took, wait)
			}
			for _, b := range bs {
				if id, held := e.a.Bridge.HolderOf(b); held {
					t.Errorf("%s still holds %s", id, b)
				}
			}
		})
	}
}
