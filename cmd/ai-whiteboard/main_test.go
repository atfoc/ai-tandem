package main

import (
	"bytes"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"ai-whiteboard/internal/store"
)

// TestMain points CURSOR_CONFIG_DIR at a temp folder for the whole run: every server a test starts
// adds deny rules for its data folder to the Cursor CLI config, and must not add them to the user's.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "aiwb-cmd-cursor-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Setenv("CURSOR_CONFIG_DIR", dir)
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

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

// No command means serve, inside an app bundle too: the Electron app always passes launch.
func TestCommand(t *testing.T) {
	for _, c := range []struct {
		args []string
		cmd  string
		rest int
	}{
		{nil, "serve", 0},
		{[]string{}, "serve", 0},
		{[]string{"-port", "1"}, "serve", 2},
		{[]string{"serve", "-port", "1"}, "serve", 2},
		{[]string{"launch"}, "launch", 0},
		{[]string{"relaunch", "-port", "1"}, "relaunch", 2},
		{[]string{"stop", "-home", "/x"}, "stop", 2},
	} {
		cmd, rest := command(c.args)
		if cmd != c.cmd || len(rest) != c.rest {
			t.Errorf("command(%q) = %q, %q; want %q with %d args", c.args, cmd, rest, c.cmd, c.rest)
		}
	}
}

func TestLaunchPrintsRunningServerURL(t *testing.T) {
	srv := hello("ai-whiteboard")
	defer srv.Close()
	port := portOf(t, srv)
	var out bytes.Buffer
	launch(options{port: port, paths: paths(t)}, nil, &out)
	if got, want := out.String(), fmt.Sprintf("http://127.0.0.1:%d/\n", port); got != want {
		t.Fatalf("launch wrote %q, want %q", got, want)
	}
}

// launch never stops a server, whatever its version: the page offers the restart.
func TestLaunchKeepsServerOfAnotherVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"app":"ai-whiteboard","version":"v0.0.1-old","webVersion":"v9.9.9-new","pid":%d}`, os.Getpid())
	}))
	defer srv.Close()
	port := portOf(t, srv)
	var out bytes.Buffer
	launch(options{port: port, paths: paths(t)}, nil, &out)
	if got, want := out.String(), fmt.Sprintf("http://127.0.0.1:%d/\n", port); got != want {
		t.Fatalf("launch wrote %q, want %q", got, want)
	}
	if h, ok := helloOf(httpClient(), srv.URL); !ok || h.Version != "v0.0.1-old" {
		t.Fatalf("server no longer answers: %+v %v", h, ok)
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
