package server

import (
	"net/http"
	"path/filepath"
	"testing"

	"ai-whiteboard/internal/model"
)

// What the review T88 found: the refusal of a missing folder at a chat's configure without its
// code.

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
	t.Run("an unstarted chat of a section", func(t *testing.T) {
		t.Parallel()
		f := newFar(t, farOpt{})
		p := f.page("P")
		// The chat is on that server, which refuses the folder: its answer, as it came.
		there := decode[model.ChatView](t, mustOK(t, f, p, "POST", f.on("/chats"), form("group", farGroup)))
		f.answer("PATCH /api/chats/{id}", http.StatusBadRequest, map[string]any{"error": "/srv/gone is not a directory", "code": "folder_missing"})
		if text := f.refuses(p, http.StatusBadRequest, "folder_missing", "PATCH", f.on("/chats/"+there.ID), form("cwd", "/srv/gone")); text != "/srv/gone is not a directory" {
			t.Fatalf("the refusal's sentence: %q", text)
		}
	})
}
