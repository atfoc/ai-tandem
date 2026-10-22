//go:build !windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// A data folder that a build with runs has used holds what that build kept of them: the folder
// runs/ with a run, its journal and the chats of its agents and of people on it, the records of
// the runs of other servers in remote/runs/, the record of a chat on such a run in remote/chats/,
// the run defaults of a group in state.json, and the runs' checkouts in aiwb-run-work beside the
// folder. A server starts on such a folder and serves the ordinary chat that is in it. It shows
// nothing of the runs: no "runs" in the state, none of their chats, no run defaults, and 404 for
// every route of a run or of one of those chats. After an orderly stop the files of runs/ and of
// aiwb-run-work are there, byte for byte as they were, and nothing was added beside them.
//
// The folder remote/ is the exception, and not because of the runs: the server removes it with
// everything in it at its start, whatever it holds (store.RemoveRemote, the change-over of
// localOnly). So the records in it are written before the start, as part of what such a folder
// holds, and are gone, with the folder, as soon as the server answers; the folder is not made
// again.
//
// This is the test of a whole server that the default set runs too (smokeTest): one server
// process, about half a second. Without a server process the default set has
// TestLoadLeavesRunDataAlone (internal/chats) and TestOpenLeavesRunDataAlone (internal/store).
func TestServeOnADataFolderWithRunData(t *testing.T) {
	smokeTest(t)
	in := newInstance(t)
	srv := &scriptedServer{in: in}
	t.Cleanup(func() { srv.stop(t) })

	const (
		plain   = "5a000000-0000-4000-8000-00000000000a" // an ordinary chat
		onRun   = "5b000000-0000-4000-8000-00000000000b" // a person's chat on the run r_1
		ofAgent = "5c000000-0000-4000-8000-00000000000c" // the chat of a task agent of r_1
		farChat = "5d000000-0000-4000-8000-00000000000d" // the record of a chat on the run r_2 of another server
		tiers   = `{"deep":{"model":"opus","effort":"max"},"standard":{"model":"sonnet"},"light":{"model":"haiku"}}`
	)
	chatMeta := func(id, name, more string) string {
		return fmt.Sprintf(`{"id":%q,"agent":"claude","name":%q,"group":"__ungrouped__","cwd":"/tmp","model":"sonnet","locked":false,"created":"2026-01-02T03:04:05Z","usage":{}%s}`+"\n", id, name, more)
	}
	work := filepath.Join(filepath.Dir(in.dir), "aiwb-run-work")
	remoteDir := filepath.Join(in.dir, "remote")
	// What the earlier build left of its runs, by path.
	kept := map[string]string{
		filepath.Join(in.dir, "runs", "r_1", "run.json"): `{"id":"r_1","name":"Run of an earlier build","group":"__ungrouped__","created":"2026-01-02T03:04:05Z","agent":"claude","tiers":` + tiers +
			`,"cwd":"/tmp","settings":{"maxParallel":3,"maxTurns":40},"started":"2026-01-02T03:05:00Z","git":true}` + "\n",
		filepath.Join(in.dir, "runs", "r_1", "journal.jsonl"): `{"seq":1,"type":"started","goal":"Goal of an earlier build"}` + "\n" +
			`{"seq":2,"type":"task_added","task":"T01"}` + "\n",
		filepath.Join(in.dir, "runs", "r_1", "chats", onRun, "chat.json"):   chatMeta(onRun, "Chat on the run", `,"run":"r_1"`),
		filepath.Join(in.dir, "runs", "r_1", "agents", "a1", "chat.json"):   chatMeta(ofAgent, "Task agent", `,"run":"r_1","role":"task"`),
		filepath.Join(in.dir, "runs", "r_1", "agents", "a1", "items.jsonl"): `{"kind":"text","text":"written by a task agent"}` + "\n",
		filepath.Join(in.dir, "remote", "runs", "r_2.json"): `{"id":"r_2","entry":"s_0123456789ab","group":"__ungrouped__",` +
			`"view":{"id":"r_2","name":"Run of another server","group":"g_there","status":"completed"},"agents":["` + ofAgent + `"]}` + "\n",
		filepath.Join(in.dir, "remote", "chats", farChat+".json"): `{"id":"` + farChat + `","entry":"s_0123456789ab","run":"r_2",` +
			`"view":{"id":"` + farChat + `","agent":"claude","name":"Chat on the run there","run":"r_2","status":"ready"},"states":[]}` + "\n",
		filepath.Join(work, "r_1", "T01", "shared.txt"): "a checkout of the run\n",
	}
	// What the server reads: an ordinary chat, and a state whose defaults hold run defaults.
	files := maps.Clone(kept)
	files[filepath.Join(in.dir, "chats", plain, "chat.json")] = chatMeta(plain, "Plain chat", "")
	files[filepath.Join(in.dir, "state.json")] = `{"version":1,"groups":[{"id":"g_work0001","name":"Work"}],"defaults":{"groups":{"__ungrouped__":{"server":"local","servers":{"local":` +
		`{"agent":"claude","cwd":"/tmp","byAgent":{"claude":{"model":"sonnet","effort":"high"}},` +
		`"run":{"agent":"claude","maxParallel":3,"maxTurns":40,"maxCost":0,"setup":"make deps","setupCwd":"/tmp","tiers":` + tiers + `}}}}}}}` + "\n"
	for path, text := range files {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// under lists the files below the folders the earlier build kept its runs in, remote/ among
	// them; a folder that is not there has none.
	under := func() []string {
		t.Helper()
		var out []string
		for _, dir := range []string{filepath.Join(in.dir, "runs"), remoteDir, work} {
			err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
				if errors.Is(err, fs.ErrNotExist) {
					return nil
				}
				if err == nil && !d.IsDir() {
					out = append(out, path)
				}
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
		}
		slices.Sort(out)
		return out
	}
	before := under()
	if want := slices.Sorted(maps.Keys(kept)); !slices.Equal(before, want) {
		t.Fatalf("the files before the start: %v, want %v", before, want)
	}

	srv.start(t) // the control socket answers with the server's pid, and it serves its clients
	// The change-over of the start is over when the server answers: the folder remote/ is gone
	// with the records in it, and everything else is there.
	if _, err := os.Lstat(remoteDir); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the folder remote/ after the start: %v", err)
	}
	if log := srv.out.String(); !strings.Contains(log, "are removed from "+in.dir) {
		t.Errorf("the server's output does not tell of the removal of remote/:\n%s", log)
	}
	left := slices.DeleteFunc(slices.Clone(before), func(path string) bool { return strings.HasPrefix(path, remoteDir+string(filepath.Separator)) })
	if after := under(); !slices.Equal(after, left) {
		t.Fatalf("the files after the start: %v, want %v", after, left)
	}
	const page = testClient
	status, raw := srv.call(t, page, "GET", "api/state", nil, nil)
	if status != http.StatusOK {
		t.Fatalf("GET /api/state: status %d: %s", status, raw)
	}
	var state struct {
		Runs   json.RawMessage
		Groups []struct{ ID string }
		Chats  []struct {
			ID   string
			Name string
		}
		Defaults struct {
			Groups map[string]struct {
				Servers map[string]map[string]json.RawMessage
			}
		}
	}
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		t.Fatalf("the state: %v in %s", err, clipText(raw, 600))
	}
	if state.Runs != nil {
		t.Errorf("the state has runs: %s", state.Runs)
	}
	if len(state.Chats) != 1 || state.Chats[0].ID != plain || state.Chats[0].Name != "Plain chat" {
		t.Errorf("the chats of the state: %+v, want the plain chat alone", state.Chats)
	}
	if len(state.Groups) != 1 || state.Groups[0].ID != "g_work0001" {
		t.Errorf("the groups of the state: %+v", state.Groups)
	}
	local := state.Defaults.Groups["__ungrouped__"].Servers["local"]
	if string(local["agent"]) != `"claude"` || string(local["cwd"]) != `"/tmp"` || local["byAgent"] == nil {
		t.Errorf("the defaults of the ungrouped group on this computer: %v", local)
	}
	if _, has := local["run"]; has {
		t.Errorf("the defaults hold run defaults: %s", local["run"])
	}
	for _, s := range []string{"Run of an earlier build", "Run of another server", "Goal of an earlier build", onRun, ofAgent, farChat, "Chat on the run", "Task agent", "make deps", "maxParallel"} {
		if strings.Contains(raw, s) {
			t.Errorf("the state holds %q", s)
		}
	}
	for _, path := range []string{"api/runs", "api/runs/r_1", "api/runs/r_1/detail", "api/runs/r_2", "api/chats/" + onRun, "api/chats/" + ofAgent, "api/chats/" + farChat,
		"api/chats/" + onRun + "/items", "api/chats/" + ofAgent + "/items"} {
		if status, raw := srv.call(t, page, "GET", path, nil, nil); status != http.StatusNotFound {
			t.Errorf("GET /%s: status %d: %s, want 404", path, status, clipText(raw, 200))
		}
	}
	if status, raw := srv.call(t, page, "GET", "api/chats/"+plain, nil, nil); status != http.StatusOK {
		t.Errorf("the plain chat: status %d: %s", status, raw)
	}

	srv.stop(t) // an orderly stop: SIGTERM, and the process is gone
	if after := under(); !slices.Equal(after, left) {
		t.Fatalf("the files after the stop: %v, want %v", after, left)
	}
	if _, err := os.Lstat(remoteDir); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("the folder remote/ after the stop: %v", err)
	}
	for path, want := range kept {
		if strings.HasPrefix(path, remoteDir+string(filepath.Separator)) {
			continue // removed at the start
		}
		if got, err := os.ReadFile(path); err != nil || string(got) != want {
			t.Errorf("%s after the stop: %q, %v; want %q", path, got, err, want)
		}
	}
	if b, err := os.ReadFile(filepath.Join(in.dir, "state.json")); err != nil || !json.Valid(b) {
		t.Errorf("state.json after the stop: %v: %s", err, b)
	}
}
