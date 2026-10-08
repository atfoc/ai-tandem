package chats

import (
	"os"
	"path/filepath"
	"testing"

	"ai-whiteboard/internal/model"
)

// TestKnown: an id is known when a chat object has it or a chat folder is named by it, and
// not otherwise; an id that is a path names no folder.
func TestKnown(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	if !e.m.Known(v.ID) {
		t.Error("a chat of this manager is not known")
	}
	const free = "5a000000-0000-4000-8000-00000000000a"
	if e.m.Known(free) {
		t.Error("an id nobody has is known")
	}

	// A folder that holds no chat that is loaded: its id is taken all the same.
	const skipped = "5b000000-0000-4000-8000-00000000000b"
	if err := os.MkdirAll(e.st.P.ChatDir(skipped), 0o700); err != nil {
		t.Fatal(err)
	}
	if !e.m.Known(skipped) {
		t.Error("a chat folder that is not loaded is not known")
	}
	// The folder of a run's chat.
	const onRun = "5c000000-0000-4000-8000-00000000000c"
	if err := os.MkdirAll(e.st.P.RunChatDir("r_one", false, onRun), 0o700); err != nil {
		t.Fatal(err)
	}
	if !e.m.Known(onRun) {
		t.Error("the folder of a run's chat is not known")
	}

	// A deleted chat's id is free again.
	if err := e.m.Delete(v.ID); err != nil {
		t.Fatal(err)
	}
	if e.m.Known(v.ID) {
		t.Error("a deleted chat is still known")
	}

	// An id that is a path is looked up as a chat object alone: it never names a folder.
	outside := filepath.Join(e.root, "outside")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", ".", "..", "../outside", "../" + skipped, skipped + "/..", `..\outside`, outside} {
		if e.m.Known(id) {
			t.Errorf("the id %q is known", id)
		}
	}
}
