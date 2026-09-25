package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"ai-whiteboard/internal/store"
)

func portOf(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

// freePort returns a port nothing listens on.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

func paths(t *testing.T) store.Paths {
	t.Helper()
	p := store.NewPaths(t.TempDir())
	return p
}

func writeServerFile(t *testing.T, p store.Paths, port int) {
	t.Helper()
	if err := store.WriteServerFile(p, port); err != nil {
		t.Fatal(err)
	}
}

func hello(app string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/hello" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"app":%q,"version":"dev","pid":%d}`, app, os.Getpid())
	}))
}

func TestFindRunningOurServerViaServerFile(t *testing.T) {
	srv := hello("ai-whiteboard")
	defer srv.Close()
	p := paths(t)
	port := portOf(t, srv)
	writeServerFile(t, p, port)

	url, ok := findRunning(p, freePort(t))
	if !ok {
		t.Fatal("findRunning = false, want true")
	}
	if want := fmt.Sprintf("http://127.0.0.1:%d/", port); url != want {
		t.Fatalf("url = %q, want %q", url, want)
	}
}

func TestFindRunningOurServerViaPortFlag(t *testing.T) {
	srv := hello("ai-whiteboard")
	defer srv.Close()
	p := paths(t) // no server.json
	if _, ok := findRunning(p, portOf(t, srv)); !ok {
		t.Fatal("findRunning = false, want true")
	}
}

func TestFindRunningStaleServerFile(t *testing.T) {
	p := paths(t)
	writeServerFile(t, p, freePort(t))
	if url, ok := findRunning(p, freePort(t)); ok {
		t.Fatalf("findRunning = %q, true; want false for a stale server.json", url)
	}
}

func TestFindRunningOtherProgram(t *testing.T) {
	other := hello("something-else")
	defer other.Close()
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, "<html>hi</html>")
	}))
	defer plain.Close()

	p := paths(t)
	writeServerFile(t, p, portOf(t, other))
	if _, ok := findRunning(p, portOf(t, plain)); ok {
		t.Fatal("findRunning = true, want false for another program on the port")
	}
	if _, ok := findRunning(paths(t), portOf(t, other)); ok {
		t.Fatal("findRunning = true, want false for another program answering /api/hello")
	}
}

func TestExpand(t *testing.T) {
	for in, want := range map[string]string{"~": "/h", "~/.x": "/h/.x", "/abs": "/abs", "rel": "rel"} {
		if got := expand(in, "/h"); got != want {
			t.Errorf("expand(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCommand(t *testing.T) {
	for _, c := range []struct {
		args      []string
		resources string
		cmd       string
		rest      int
	}{
		{nil, "", "serve", 0},
		{nil, "/A.app/Contents/Resources", "launch", 0}, // Spotlight or Finder
		{[]string{"-port", "1"}, "/A.app/Contents/Resources", "serve", 2},
		{[]string{"serve", "-no-open"}, "", "serve", 1},
		{[]string{"launch"}, "", "launch", 0},
		{[]string{"stop", "-home", "/x"}, "", "stop", 2},
	} {
		cmd, rest := command(c.args, c.resources)
		if cmd != c.cmd || len(rest) != c.rest {
			t.Errorf("command(%q, %q) = %q, %q; want %q with %d args", c.args, c.resources, cmd, rest, c.cmd, c.rest)
		}
	}
}

func TestResourcesFor(t *testing.T) {
	for exe, want := range map[string]string{
		"/Applications/AI Whiteboard.app/Contents/MacOS/ai-whiteboard": "/Applications/AI Whiteboard.app/Contents/Resources",
		"/repo/bin/ai-whiteboard":                                      "",
		"/x/Contents/MacOS/ai-whiteboard":                              "", // not inside a .app
		"/x/A.app/Contents/bin/ai-whiteboard":                          "",
	} {
		if got := resourcesFor(exe); got != want {
			t.Errorf("resourcesFor(%q) = %q, want %q", exe, got, want)
		}
	}
}

func TestUsePath(t *testing.T) {
	t.Setenv("PATH", "/usr/bin:/bin:/extra")
	usePath("/opt/homebrew/bin:/usr/bin")
	if got, want := os.Getenv("PATH"), "/opt/homebrew/bin:/usr/bin:/bin:/extra"; got != want {
		t.Errorf("PATH = %q, want %q", got, want)
	}
	usePath("")
	if got, want := os.Getenv("PATH"), "/opt/homebrew/bin:/usr/bin:/bin:/extra"; got != want {
		t.Errorf("empty login PATH changed PATH to %q", got)
	}
}
