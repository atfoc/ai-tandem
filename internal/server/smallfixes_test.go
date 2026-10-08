package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/runs"
)

// What the reviews T85 and T88 found: an API client's read that waits for a creation without a
// bound, and the refusal of a missing folder at a chat's configure without its code.

// remoteRead is an API client's GET of path as the routes get it behind the remote listener, with
// ctx as the request's context. It returns the answer and how long it took.
func remoteRead(e *env, ctx context.Context, path string) (*httptest.ResponseRecorder, time.Duration) {
	req := httptest.NewRequest("GET", path, nil).WithContext(context.WithValue(ctx, remoteKey{}, remoteCall{}))
	req.Header.Set(ClientHeader, apiX)
	w, at := httptest.NewRecorder(), time.Now()
	e.s.routes().ServeHTTP(w, req)
	return w, time.Since(at)
}

// shortAwait sets the limit of a read's wait on the test's server.
func shortAwait(e *env, d time.Duration) { e.s.awaitLimit = d }

// An API client's read of a chat whose creation call does not end is answered when the caller
// gives up, and after the limit, with the chat as it is.
func TestRemoteChatReadDoesNotWaitWithoutABound(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, _ := remoteEnv(t, withAgents(sp))
	if awaitStartLimit != 30*time.Second || e.s.awaitLimit != 0 {
		t.Fatalf("the limit of the wait is %v (this server's %v), want 30 s: the settle read of the calling server relies on it", awaitStartLimit, e.s.awaitLimit)
	}
	in, release := make(chan struct{}), make(chan struct{})
	started := make(chan error, 1)
	go func() {
		_, err := e.a.Chats.Start(chats.StartReq{ID: chat1, Client: apiX, Agent: model.Claude, Cwd: t.TempDir(), Text: "the first message",
			Place: func() (string, error) {
				close(in)
				<-release
				return e.a.RemoteGroup()
			}})
		started <- err
	}()
	<-in
	path := "/api/chats/" + chat1

	// The caller gives up.
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	if w, took := remoteRead(e, ctx, path); took > 10*time.Second || w.Code != 404 {
		t.Fatalf("the read of a caller that gave up: %d %s after %v", w.Code, w.Body, took)
	}
	// The limit.
	shortAwait(e, 150*time.Millisecond)
	w, took := remoteRead(e, context.Background(), path)
	if took < 150*time.Millisecond || took > 10*time.Second || w.Code != 404 || !strings.Contains(w.Body.String(), "no such chat") {
		t.Fatalf("the read at the limit: %d %s after %v", w.Code, w.Body, took)
	}

	close(release)
	if err := <-started; err != nil {
		t.Fatalf("the creation call: %v", err)
	}
	if w, _ := remoteRead(e, context.Background(), path); w.Code != 200 || decode[model.ChatView](t, w.Body.String()).ID != chat1 {
		t.Fatalf("the read after the creation call: %d %s", w.Code, w.Body)
	}
}

// The same for a run whose start call does not end.
func TestRemoteRunReadDoesNotWaitWithoutABound(t *testing.T) {
	t.Parallel()
	e := newAPIRunEnv(t)
	req := decode[runs.StartReq](t, runBody(e.cwd))
	req.ID, req.Client = run1, apiX
	in, release := make(chan struct{}), make(chan struct{})
	req.Place = func() (string, error) {
		close(in)
		<-release
		return e.a.RemoteGroup()
	}
	started := make(chan error, 1)
	go func() {
		_, err := e.rs.StartCall(req)
		started <- err
	}()
	<-in
	path := "/api/runs/" + run1

	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	if w, took := remoteRead(e.env, ctx, path); took > 10*time.Second || w.Code != 404 {
		t.Fatalf("the read of a caller that gave up: %d %s after %v", w.Code, w.Body, took)
	}
	shortAwait(e.env, 150*time.Millisecond)
	if w, took := remoteRead(e.env, context.Background(), path); took < 150*time.Millisecond || took > 10*time.Second || w.Code != 404 {
		t.Fatalf("the read at the limit: %d %s after %v", w.Code, w.Body, took)
	}

	close(release)
	if err := <-started; err != nil {
		t.Fatalf("the start call: %v", err)
	}
	if w, _ := remoteRead(e.env, context.Background(), path); w.Code != 200 || decode[model.RunView](t, w.Body.String()).ID != run1 {
		t.Fatalf("the read after the start call: %d %s", w.Code, w.Body)
	}
}

// A chat's configure with a cwd that is no folder is refused with the code of the first
// message's refusal: for a chat on this computer (400) and for an unstarted chat on another
// server (409). Status and sentence are what they were.
func TestConfigureRefusesAMissingFolderWithItsCode(t *testing.T) {
	t.Parallel()
	type refusal struct{ Error, Code string }
	t.Run("a chat on this computer", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t)
		c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
		gone := filepath.Join(t.TempDir(), "gone")
		// Here the chat manager's refusal is a 400 with the sentence of the folder check.
		got := decode[refusal](t, e.expect(http.StatusBadRequest, "PATCH", "/api/chats/"+c.ID, form("cwd", gone)))
		if got.Code != "folder_missing" || got.Error != gone+" is not a directory" {
			t.Fatalf("the refusal: %+v", got)
		}
		// Another refusal of the same call has no code.
		if got := decode[refusal](t, e.expect(http.StatusBadRequest, "PATCH", "/api/chats/"+c.ID, form("cwd", t.TempDir(), "model", "no-such-model"))); got.Code != "" {
			t.Fatalf("a refusal that is not about the folder: %+v", got)
		}
	})
	t.Run("an unstarted chat on another server", func(t *testing.T) {
		t.Parallel()
		f := newFar(t, farOpt{})
		p := f.page("P")
		g := f.group(p, "Work", "")
		there := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("group", g, "server", f.entry)))
		f.answer("GET /api/dirs", http.StatusBadRequest, map[string]any{"error": "/srv/gone is not a directory"})
		text := f.refuses(p, http.StatusConflict, "folder_missing", "PATCH", "/api/chats/"+there.ID, form("cwd", "/srv/gone"))
		if !strings.HasPrefix(text, "folder not found") {
			t.Fatalf("the refusal's sentence: %q", text)
		}
	})
}
