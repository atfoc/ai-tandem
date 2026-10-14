package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/store"
)

// The stand-ins are servers as the commands see them, without a server process: a control socket
// that answers hello and status for a server of this build, and a loopback port that answers the
// local API's hello and state for a server of the build before. The pid they state is a `sleep`
// process of the test, which is what a command signals and what ends them: when it is gone the
// stand-in no longer answers, as a server that has exited.

// standInID is the instance id the stand-in servers state in hello.
const standInID = "0d9f1c52-6a3e-4b7f-8c21-5e4d3c2b1a09"

// otherID is the instance id of some other data folder's server.
const otherID = "7b1e9d40-2c5a-4f38-a6d7-0e1f2a3b4c5d"

// asThisFolders writes id as home's instance id, as the folder's first start does: a server that
// states it in hello then counts as this data folder's.
func asThisFolders(t *testing.T, home, id string) {
	t.Helper()
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(remote.FilesIn(home).InstanceID, []byte(id+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// child starts a process of the test's own (a long sleep) and returns its pid and a function that
// reports whether it still runs. It is the pid a stand-in hello states: a command that must
// signal nothing leaves it running, and SIGTERM and SIGUSR1 end it.
func child(t *testing.T) (pid int, alive func() bool) {
	t.Helper()
	cmd := exec.Command("sleep", "600")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		close(done)
	}()
	t.Cleanup(func() {
		cmd.Process.Kill()
		<-done
	})
	return cmd.Process.Pid, func() bool {
		select {
		case <-done:
			return false
		default:
			return true
		}
	}
}

// standIn describes a stand-in server. The zero value of a field is the usual one.
type standIn struct {
	home       string // the data folder it states; the instance folder's when ""
	instanceID string // standInID when ""
	version    string // "dev" when ""
	level      int    // 6 for this build, 5 for the one before, when 0
	listening  bool   // this build: the client listener serves
	reloadsOn  bool   // this build: the secret reloads count rises with the signal that ended the pid
	pid        int
	alive      func() bool

	port        int // the client port it states (this build) or its own port (the build before)
	fingerprint string
	names       []string

	hit atomic.Int64 // the requests it got
}

// this starts the stand-in of a server of this build on the control socket of root, and writes
// server.json for it when serverFile is true. It stops answering when its pid is gone.
func (s *standIn) this(t *testing.T, root string, serverFile bool) string {
	t.Helper()
	s.defaults(root)
	path := store.ControlSocketPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	reloads := func() int {
		if s.reloadsOn && !s.alive() {
			return 1
		}
		return 0
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /hello", func(w http.ResponseWriter, r *http.Request) {
		s.hit.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"app": "ai-whiteboard", "version": s.version, "featureLevel": s.level,
			"instanceId": s.instanceID, "pid": s.pid, "dataDir": s.home})
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		s.hit.Add(1)
		client := map[string]any{"listening": s.listening}
		if s.listening {
			client = map[string]any{"listening": true, "address": fmt.Sprintf("https://127.0.0.1:%d", s.port), "port": s.port,
				"names": s.names, "fingerprint": s.fingerprint, "secretReloads": reloads()}
		}
		json.NewEncoder(w).Encode(map[string]any{"client": client, "mcp": map[string]any{
			"listener": map[string]any{"port": 6006, "url": "http://localhost:6006/mcp", "up": true}, "chats": []any{}}})
	})
	srv := &http.Server{Handler: s.whileAlive(mux)}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	if serverFile {
		if err := store.WriteJSONAtomic(store.NewPaths(root).Server, store.ServerFile{PID: os.Getpid(), Port: s.port, Control: path, Started: time.Now()}, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

// older starts the stand-in of a server of the build before, on a port of its own: it answers
// /api/hello with the pid, the instance id and, from level 1, the feature level, /api/state with
// its data folder and /api/remote/status with whether it listens. serverFile writes a server.json
// that has no control socket, as that build did; without it the stand-in is where legacyPort
// says. The returned function sets legacyPort for the test's length.
func (s *standIn) older(t *testing.T, root string, serverFile bool) (port int) {
	t.Helper()
	if s.level == 0 {
		s.level = 5
	}
	s.defaults(root)
	reloads := func() int {
		if s.reloadsOn && !s.alive() {
			return 1
		}
		return 0
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/hello", func(w http.ResponseWriter, r *http.Request) {
		s.hit.Add(1)
		out := map[string]any{"app": "ai-whiteboard", "version": s.version, "pid": s.pid, "instanceId": s.instanceID, "webVersion": s.version}
		if s.level > 0 {
			out["featureLevel"] = s.level
		}
		json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		s.hit.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"dataDir": s.home})
	})
	mux.HandleFunc("GET /api/remote/status", func(w http.ResponseWriter, r *http.Request) {
		s.hit.Add(1)
		json.NewEncoder(w).Encode(map[string]any{"listening": s.listening, "secretReloads": reloads()})
	})
	srv := httptest.NewServer(s.whileAlive(mux))
	t.Cleanup(srv.Close)
	port = portOf(t, srv)
	if serverFile {
		if err := store.WriteJSONAtomic(store.NewPaths(root).Server, store.ServerFile{PID: os.Getpid(), Port: port, Started: time.Now()}, 0o600); err != nil {
			t.Fatal(err)
		}
	} else {
		prev := legacyPort
		legacyPort = port
		t.Cleanup(func() { legacyPort = prev })
	}
	return port
}

func (s *standIn) defaults(root string) {
	if s.home == "" {
		s.home = root
	}
	if s.instanceID == "" {
		s.instanceID = standInID
	}
	if s.version == "" {
		s.version = "dev"
	}
	if s.level == 0 {
		s.level = 6
	}
	if s.port == 0 {
		s.port = 4748
	}
	if s.fingerprint == "" {
		s.fingerprint = "AB:CD:EF"
	}
	if s.names == nil {
		s.names = []string{"mac.local"}
	}
}

// whileAlive answers while the pid the stand-in states is a process, and drops the connection
// after that, as a port nobody listens on. A stand-in with reloadsOn answers after it too: it
// stands for a server that took the signal that ended the pid and went on, and counts it.
func (s *standIn) whileAlive(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.alive != nil && !s.alive() && !s.reloadsOn {
			panic(http.ErrAbortHandler)
		}
		h.ServeHTTP(w, r)
	})
}

// withPid gives the stand-in a process of the test's own: the pid it states.
func (s *standIn) withPid(t *testing.T) *standIn {
	t.Helper()
	s.pid, s.alive = child(t)
	return s
}

func portOf(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	return srv.Listener.Addr().(*net.TCPAddr).Port
}

// roundTrip is an http.RoundTripper made of a function.
type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// serveRaw answers every request on the Unix socket at path with body, and returns the function
// that stops it.
func serveRaw(t *testing.T, path, body string) (stop func()) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) })}
	go srv.Serve(ln)
	return func() { srv.Close() }
}
