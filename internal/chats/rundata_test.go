package chats

// What a data folder holds under runs/ is not this manager's: it is not loaded, its folder names
// are no chat ids, and nothing there is written or removed.

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"ai-whiteboard/internal/model"
)

const (
	runChatID  = "6a000000-0000-4000-8000-00000000000a"
	runAgentID = "6b000000-0000-4000-8000-00000000000b"
	runChatTok = "tok-of-the-chat-on-the-run"
	runAgentTk = "tok-of-the-run-agent"
)

// runData writes what a run with one chat and one agent's chat leaves in the data folder, and
// returns every file under runs/ with its content, by its path under the data folder.
func (e *env) runData() map[string]string {
	e.t.Helper()
	files := map[string]string{
		"runs/r_one/run.json": `{"id":"r_one","goal":"ship it","group":"` + gOne + `"}`,
		"runs/r_one/chats/" + runChatID + "/chat.json": `{"id":"` + runChatID + `","agent":"claude","run":"r_one","cwd":"` + e.cwd +
			`","model":"sonnet","sessionId":"7a000000-0000-4000-8000-00000000000a","locked":true,"token":"` + runChatTok +
			`","created":"2026-01-02T03:04:05Z","usage":{"turns":1}}` + "\n",
		"runs/r_one/chats/" + runChatID + "/items.jsonl": `{"kind":"user","text":"how far is it?"}` + "\n",
		"runs/r_one/agents/" + runAgentID + "/chat.json": `{"id":"` + runAgentID + `","agent":"claude","name":"T01-work","userNamed":true,"run":"r_one","role":"task","cwd":"` + e.cwd +
			`","model":"sonnet","sessionId":"7b000000-0000-4000-8000-00000000000b","locked":true,"token":"` + runAgentTk +
			`","created":"2026-01-02T03:04:06Z","turnActive":true,"usage":{"turns":2}}` + "\n",
		"runs/r_one/agents/" + runAgentID + "/items.jsonl": `{"kind":"user","text":"the brief"}` + "\n",
	}
	for rel, body := range files {
		p := filepath.Join(e.root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			e.t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			e.t.Fatal(err)
		}
	}
	return files
}

// runDataIs fails unless the files under runs/ are the ones of want, each with its content.
func (e *env) runDataIs(when string, want map[string]string) {
	e.t.Helper()
	got := map[string]string{}
	runs := filepath.Join(e.root, "runs")
	err := filepath.WalkDir(runs, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(e.root, p)
		got[filepath.ToSlash(rel)] = string(raw)
		return nil
	})
	if err != nil {
		e.t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		e.t.Fatalf("%s the files under runs/ are\n%v\nwant\n%v", when, got, want)
	}
}

// Load reads nothing under runs/: the chat of a run and the chat of a run's agent are no chats of
// the manager, their tokens resolve to nobody, and their files stay as they were. A chat's view
// names no run and no role.
func TestLoadLeavesRunDataAlone(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	plain := e.create(model.Claude, gOne, "")
	files := e.runData()
	e.boot() // fails the test when Load returns an error
	e.runDataIs("after a load", files)

	views := e.m.Views()
	if len(views) != 1 || views[0].ID != plain.ID {
		t.Fatalf("the chats after a load: %+v, want the one in chats/", views)
	}
	raw, err := json.Marshal(views[0])
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"run", "role"} {
		if _, ok := keys[k]; ok {
			t.Errorf("a chat's view has the key %q: %s", k, raw)
		}
	}
	if len(e.m.States()) != 1 {
		t.Errorf("the state records after a load: %+v", e.m.States())
	}
	for id, tok := range map[string]string{runChatID: runChatTok, runAgentID: runAgentTk} {
		if _, err := e.m.get(id); err == nil {
			t.Errorf("%s, a folder under runs/, is known", id)
		}
		if _, err := e.m.View(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("View of %s: %v, want ErrNotFound", id, err)
		}
		if _, _, _, err := e.m.Items(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Items of %s: %v, want ErrNotFound", id, err)
		}
		if c, ok := e.m.ResolveToken(tok); ok {
			t.Errorf("the token in the chat.json of %s resolves to %+v", id, c)
		}
		if err := e.m.Delete(id); !errors.Is(err, ErrNotFound) {
			t.Errorf("Delete of %s: %v, want ErrNotFound", id, err)
		}
	}
	// A shutdown writes nothing there either.
	e.m.Shutdown()
	e.runDataIs("after a shutdown", files)
}

// The name of a folder under runs/ is free as a chat id: the chat is made in chats/, by the page's
// creation, with a first message sent or not, and what is under runs/ stays.
func TestAFolderUnderRunsTakesNoChatID(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	files := e.runData()

	v, err := e.m.CreateChat(NewChat{ID: runChatID, Agent: model.Claude, Group: gOne})
	if err != nil || v.ID != runChatID || v.Locked {
		t.Fatalf("CreateChat with the name of a folder of a run's chats: %+v, %v", v, err)
	}
	w, err := e.m.CreateChat(NewChat{ID: runAgentID, Agent: model.Claude, Group: gOne})
	if err != nil || w.ID != runAgentID || w.Locked {
		t.Fatalf("CreateChat with the name of a folder of a run's agents: %+v, %v", w, err)
	}
	e.send(runAgentID, "hello", "")
	e.m.naming.Wait()
	for _, id := range []string{runChatID, runAgentID} {
		m := e.meta(id) // chat.json in chats/<id>
		if m.ID != id || m.Token == "" || m.Token == runChatTok || m.Token == runAgentTk {
			t.Errorf("chat.json of the new chat %s: %+v", id, m)
		}
		if _, err := e.m.get(id); !e.listed(id) || err != nil {
			t.Errorf("the new chat %s is not listed or not known", id)
		}
	}
	if a := e.claude.last(t); a.opts.ChatID != runAgentID || a.opts.Dir != e.st.P.ChatDir(runAgentID) || a.opts.Resume {
		t.Errorf("the started chat's process: %+v", a.opts)
	}
	if got := e.chatFolders(); !reflect.DeepEqual(got, []string{e.st.P.ChatDir(runChatID), e.st.P.ChatDir(runAgentID)}) {
		t.Errorf("the chat folders: %v", got)
	}
	e.runDataIs("after the chats were made", files)

	// Deleting the new chats takes their folders in chats/, and nothing under runs/.
	for _, id := range []string{runChatID, runAgentID} {
		if err := e.m.Delete(id); err != nil {
			t.Fatalf("Delete of %s: %v", id, err)
		}
	}
	if got := e.chatFolders(); len(got) != 0 {
		t.Errorf("the chat folders after the deletes: %v", got)
	}
	e.runDataIs("after the deletes", files)
}
