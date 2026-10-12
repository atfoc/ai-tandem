package app

import (
	"encoding/json"
	"strings"
	"testing"

	"ai-whiteboard/internal/servers"
)

// Without a library the list of libraries is empty; with this computer's it is that library,
// under the local entry's id and name and connected, as the snapshot's "libraries".
func TestLibraries(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if got := e.a.Libraries(); got == nil || len(got) != 0 {
		t.Fatalf("without a library: %+v", got)
	}
	if e.a.OpenLibrary("") == nil || e.a.Library != nil {
		t.Fatal("a library without a data folder was opened")
	}
	e.must(e.a.OpenLibrary(t.TempDir()))
	g, err := e.a.Library.CreateGroup("git", "")
	e.must(err)
	_, err = e.a.Library.CreatePrompt("review", g.ID, "Look at it.")
	e.must(err)

	got := e.a.Snapshot().Libraries
	if len(got) != 1 || got[0].Server != servers.LocalID || got[0].Name != servers.LocalName || !got[0].Connected || got[0].Notice != "" ||
		len(got[0].Groups) != 1 || got[0].Groups[0] != g || len(got[0].Prompts) != 1 || got[0].Prompts[0].Text != "Look at it." {
		t.Fatalf("libraries: %+v", got)
	}
	raw, err := json.Marshal(e.a.Snapshot())
	want := `"libraries":[{"server":"local","name":"This computer","connected":true,"groups":[{"id":"` + g.ID + `","name":"git","parent":""}],"prompts":[{"id":"`
	if err != nil || !strings.Contains(string(raw), want) {
		t.Fatalf("the snapshot: %s, %v", raw, err)
	}

	// An API client gets this computer's library alone, without the notice.
	api, err := json.Marshal(e.a.APISnapshot("0e5ac1f3-6d2b-4b7a-8f10-9a1b2c3d4e5f"))
	if err != nil || !strings.Contains(string(api), `"library":{"groups":[{"id":"`+g.ID+`","name":"git","parent":""}],"prompts":[{"id":"`) || strings.Contains(string(api), "notice") {
		t.Fatalf("the API snapshot: %s, %v", api, err)
	}
	if own, ok := e.a.OwnLibrary(); !ok || own.Server != servers.LocalID || len(own.Prompts) != 1 {
		t.Fatalf("the own library: %+v, %v", own, ok)
	}
}

// Without a library an API client is told so, and the list of the libraries is empty.
func TestNoLibrary(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	api, err := json.Marshal(e.a.APISnapshot("0e5ac1f3-6d2b-4b7a-8f10-9a1b2c3d4e5f"))
	if err != nil || !strings.Contains(string(api), `"library":null`) {
		t.Fatalf("the API snapshot: %s, %v", api, err)
	}
	if _, ok := e.a.OwnLibrary(); ok {
		t.Fatal("an own library")
	}
}
