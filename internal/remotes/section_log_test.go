package remotes

import (
	"net/http"
	"strings"
	"testing"
)

// TestSectionLogNamesNothingOfThatServer: the relay's log is a file of this machine, which keeps
// nothing of another server (goal 3.12). What the relay logs of an entry names the entry and
// what failed, and nothing that is on that server: no id of a chat, a group or a prompt,
// and no word of what it sent.
func TestSectionLogNamesNothingOfThatServer(t *testing.T) {
	t.Parallel()
	snapshot := snapshotOf(fullTree())
	snapshot["library"] = gitLibrary()
	rg := newRig(t, rigOpt{snapshot: snapshot})
	p, _ := rg.page("page-1")
	const said = "words-of-that-server"

	// An unfollow that server refuses.
	rg.script("GET /api/chats/{id}/items").answer(http.StatusOK, map[string]any{"version": 1})
	rg.script("POST /api/chats/{id}/unfollow").answer(http.StatusInternalServerError, map[string]any{"error": said})
	rg.readChat(p, chatA)
	rg.r.UnfollowChat(rg.entry, p.ID, chatA)
	rg.until("the unfollow is logged", func() bool { return rg.logs.count("the unfollow of a") == 1 })

	// A prompt library that breaks a rule: the rule's sentence names the prompt.
	rg.s.Send(map[string]any{"type": "own_library", "groups": []any{map[string]any{"id": groupGit, "name": said, "parent": ""}},
		"prompts": []any{map[string]any{"id": promptReview, "name": "a/" + said, "parent": groupGit, "text": said}}})
	rg.until("the library is logged", func() bool { return rg.logs.count("prompt library") == 1 })

	// A tree that cannot be read: the decoder's sentence quotes what it met.
	rg.h.Snapshot(rg.entry, []byte(`{"groups":[{"id":"g_there","name":"`+said+`","created":20261006}],"chats":`+said+`}`))
	rg.h.Snapshot(rg.entry, []byte(`{"groups":[{"id":20261006}],"chats":[]}`))
	rg.until("the trees are logged", func() bool { return rg.logs.count("cannot be read") == 2 })

	for _, line := range rg.logs.all() {
		if !strings.Contains(line, rg.entry) {
			t.Errorf("a log line does not name the entry: %s", line)
		}
		for _, theirs := range []string{chatA, groupGit, promptReview, "g_there", said, "20261006"} {
			if strings.Contains(line, theirs) {
				t.Errorf("a log line holds %q of that server: %s", theirs, line)
			}
		}
	}
}
