package server

import (
	"net/http"
	"path/filepath"
	"testing"
)

// What the review T88 found: the refusal of a missing folder at a chat's configure without its
// code.

// A chat's configure with a cwd that is no folder is refused with the code of the first
// message's refusal. Status and sentence are what they were.
func TestConfigureRefusesAMissingFolderWithItsCode(t *testing.T) {
	t.Parallel()
	type refusal struct{ Error, Code string }
	e := newEnv(t)
	c := e.chat(`{"agent":"claude","group":"__ungrouped__"}`)
	gone := filepath.Join(t.TempDir(), "gone")
	// The chat manager's refusal is a 400 with the sentence of the folder check.
	got := decode[refusal](t, e.expect(http.StatusBadRequest, "PATCH", "/api/chats/"+c.ID, form("cwd", gone)))
	if got.Code != "folder_missing" || got.Error != gone+" is not a directory" {
		t.Fatalf("the refusal: %+v", got)
	}
	// Another refusal of the same call has no code.
	if got := decode[refusal](t, e.expect(http.StatusBadRequest, "PATCH", "/api/chats/"+c.ID, form("cwd", t.TempDir(), "model", "no-such-model"))); got.Code != "" {
		t.Fatalf("a refusal that is not about the folder: %+v", got)
	}
}
