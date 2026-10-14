package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/model"
)

// With this server's library the snapshot holds it whole, and GET /api/library's view of it is
// under the id "local" and the name of this computer, connected and with no notice.
func TestLibrary(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if _, ok := e.a.OwnLibrary(); ok {
		t.Fatal("an own library without one")
	}
	if e.a.OpenLibrary("") == nil || e.a.Library != nil {
		t.Fatal("a library without a data folder was opened")
	}
	e.must(e.a.OpenLibrary(t.TempDir()))
	g, err := e.a.Library.CreateGroup("git", "")
	e.must(err)
	_, err = e.a.Library.CreatePrompt("review", g.ID, "Look at it.")
	e.must(err)

	api, err := json.Marshal(e.a.APISnapshot())
	if err != nil || !strings.Contains(string(api), `"library":{"groups":[{"id":"`+g.ID+`","name":"git","parent":""}],"prompts":[{"id":"`) ||
		strings.Contains(string(api), "otice") {
		t.Fatalf("the snapshot: %s, %v", api, err)
	}
	own, ok := e.a.OwnLibrary()
	if !ok || own.Server != model.LocalServer || own.Name != "This computer" || !own.Connected || len(own.Groups) != 1 || own.Groups[0] != g ||
		len(own.Prompts) != 1 || own.Prompts[0].Text != "Look at it." {
		t.Fatalf("the own library: %+v, %v", own, ok)
	}
}

// Without a library the snapshot says so.
func TestNoLibrary(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	api, err := json.Marshal(e.a.APISnapshot())
	if err != nil || !strings.Contains(string(api), `"library":null`) || strings.Contains(string(api), "libraryNotice") {
		t.Fatalf("the snapshot: %s, %v", api, err)
	}
	if _, ok := e.a.OwnLibrary(); ok {
		t.Fatal("an own library")
	}
}

// A library file that was set aside at the start is told in the snapshot's "libraryNotice", which
// names the file; a library that opened is not.
func TestLibraryNotice(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	root := t.TempDir()
	path := filepath.Join(root, library.FileName)
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	e.must(e.a.OpenLibrary(root))
	notice := e.a.APISnapshot().LibraryNotice
	if !strings.Contains(notice, path) || !strings.Contains(notice, "set aside") {
		t.Fatalf("the notice: %q", notice)
	}
	raw, err := json.Marshal(e.a.APISnapshot())
	if err != nil || !strings.Contains(string(raw), `"libraryNotice":"`) {
		t.Fatalf("the snapshot: %s, %v", raw, err)
	}

	f := newEnv(t)
	f.must(f.a.OpenLibrary(t.TempDir()))
	if n := f.a.APISnapshot().LibraryNotice; n != "" {
		t.Fatalf("the notice of a library that opened: %q", n)
	}
}
