package main

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// controlPost reaches a handler over a Unix socket and returns the status it answers, a refused
// route's status as it is, and an error when nothing listens.
func TestControlPost(t *testing.T) {
	t.Parallel()
	dir, err := os.MkdirTemp("", "aiwb")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "c.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Skipf("no Unix sockets here: %v", err)
	}
	posts := 0
	mux := http.NewServeMux()
	mux.HandleFunc("POST /stop", func(w http.ResponseWriter, r *http.Request) { posts++; w.WriteHeader(http.StatusAccepted) })
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })

	if status, err := controlPost(path, "/stop", 5*time.Second); err != nil || status != http.StatusAccepted || posts != 1 {
		t.Fatalf("POST /stop: %d, %v (%d posts)", status, err, posts)
	}
	if status, err := controlPost(path, "/nothing", 5*time.Second); err != nil || status != http.StatusNotFound {
		t.Fatalf("POST /nothing: %d, %v", status, err)
	}
	srv.Close()
	if _, err := controlPost(path, "/stop", 5*time.Second); err == nil {
		t.Fatal("POST to a socket nobody listens on succeeded")
	}
}
