package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// The folder remote/ of the data folder goes with everything in it, and nothing else does. A
// second call, and a call in a data folder that never had one, find nothing to remove.
func TestSectionRemoveRemote(t *testing.T) {
	p := NewPaths(filepath.Join(t.TempDir(), "data"))
	if _, err := Open(p); err != nil {
		t.Fatal(err)
	}
	if removed, err := RemoveRemote(p); removed || err != nil {
		t.Fatalf("a data folder with no remote/: removed %v, %v", removed, err)
	}
	remote := filepath.Join(p.Root, "remote")
	files := []string{"chats/c1.json", "chats/c1.draft.json", "runs/r_1.json", "boards/b_1.json", "makes.json"}
	for _, f := range files {
		path := filepath.Join(remote, f)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	kept := []string{p.State, filepath.Join(p.Root, "servers.json"), filepath.Join(p.ChatDir("c1"), "chat.json")}
	for _, path := range kept[1:] {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if removed, err := RemoveRemote(p); !removed || err != nil {
		t.Fatalf("removed %v, %v", removed, err)
	}
	if _, err := os.Lstat(remote); !os.IsNotExist(err) {
		t.Errorf("remote/ is still there: %v", err)
	}
	for _, path := range append(kept, p.Boards, p.Chats) {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("%s went with it: %v", path, err)
		}
	}
	if removed, err := RemoveRemote(p); removed || err != nil {
		t.Errorf("a second call: removed %v, %v", removed, err)
	}
	// Nothing makes the folder again.
	if _, err := Open(p); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(remote); !os.IsNotExist(err) {
		t.Errorf("Open made remote/: %v", err)
	}
}

// A state file that holds something for another server is brought to "local" alone at the load,
// and written once: the file then names no other server, and a later load does not write it.
func TestSectionOpenKeepsLocalDefaultsAlone(t *testing.T) {
	p := NewPaths(filepath.Join(t.TempDir(), "data"))
	if err := os.MkdirAll(p.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	const file = `{"version":1,"groups":[{"id":"g_one","name":"One"}],"remoteGroup":"g_one","defaults":{"groups":{
	 "__ungrouped__":{"server":"inst-far","servers":{"local":{"agent":"pi","cwd":"/w"},"inst-far":{"agent":"cursor","cwd":"/far"}}},
	 "g_one":{"server":"inst-far","servers":{"inst-far":{"cwd":"/far"}}}}}}`
	if err := os.WriteFile(p.State, []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	st.Read(func(s *model.State) {
		if got := s.Defaults.Groups[model.Ungrouped]; len(got.Servers) != 1 || got.Local().Agent != model.Pi || got.Local().Cwd != "/w" {
			t.Errorf("the ungrouped group: %+v", got)
		}
		if got, ok := s.Defaults.Groups["g_one"]; !ok || len(got.Servers) != 0 {
			t.Errorf("g_one: %+v (%v), want an empty entry", got, ok)
		}
		if len(s.Groups) != 1 || s.RemoteGroup != "g_one" {
			t.Errorf("the rest of the state: %+v", s)
		}
	})
	b, err := os.ReadFile(p.State)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "inst-far") || strings.Contains(string(b), `"server"`) {
		t.Errorf("state.json still names another server: %s", b)
	}
	var onDisk struct {
		Defaults struct {
			Groups map[string]map[string]map[string]json.RawMessage `json:"groups"`
		} `json:"defaults"`
	}
	if err := json.Unmarshal(b, &onDisk); err != nil {
		t.Fatal(err)
	}
	for g, entry := range onDisk.Defaults.Groups {
		for key, servers := range entry {
			if key != "servers" || len(servers) != 1 || servers["local"] == nil {
				t.Errorf("%s of state.json: %q holds %v, want servers.local alone", g, key, servers)
			}
		}
	}
	before, err := os.Stat(p.State)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(p); err != nil {
		t.Fatal(err)
	}
	if after, err := os.Stat(p.State); err != nil || !after.ModTime().Equal(before.ModTime()) {
		t.Errorf("state.json was written at the second load: %v -> %v (%v)", before.ModTime(), after, err)
	}
	if b2, _ := os.ReadFile(p.State); string(b2) != string(b) {
		t.Errorf("state.json after the second load: %s\nwas: %s", b2, b)
	}
}
