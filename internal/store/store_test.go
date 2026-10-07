package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

func TestOpenEmpty(t *testing.T) {
	p := NewPaths(filepath.Join(t.TempDir(), "data"))
	st, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{p.Boards, p.Chats} {
		if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
			t.Errorf("%s not created: %v", d, err)
		}
	}
	if fi, err := os.Stat(p.Root); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("root mode: %v %v", fi.Mode(), err)
	}
	b, err := os.ReadFile(p.State)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"version": 1`) {
		t.Errorf("state.json: %s", b)
	}
	st.Read(func(s *model.State) {
		if s.Version != 1 || s.Defaults.Groups == nil {
			t.Errorf("state: %+v", s)
		}
	})
}

func TestUpdatePersists(t *testing.T) {
	p := NewPaths(t.TempDir())
	st, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	err = st.Update(func(s *model.State) error {
		s.Groups = append(s.Groups, model.Group{ID: "g_1", Name: "One"})
		s.Defaults.Groups[model.Ungrouped] = model.LocalDefaults(model.ServerDefaults{Cwd: "/tmp",
			ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "sonnet", Effort: "high"}}})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	st2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	st2.Read(func(s *model.State) {
		if len(s.Groups) != 1 || s.Groups[0].Name != "One" {
			t.Errorf("groups: %+v", s.Groups)
		}
		if s.Defaults.Groups[model.Ungrouped].On(model.LocalServer).ByAgent[model.Claude].Effort != "high" {
			t.Errorf("defaults: %+v", s.Defaults)
		}
	})
}

// oldState is the state file of a build that kept "last" and every group's defaults flat.
const oldState = `{"version":1,"defaults":{
 "last":{"cwd":"/last","byAgent":{"claude":{"model":"opus","effort":"max"},"pi":{"model":"p"}},
         "run":{"agent":"cursor","maxParallel":2,"maxTurns":10,"maxCost":0}},
 "groups":{"__ungrouped__":{"cwd":"/own","byAgent":{"claude":{"model":"haiku"}}},
           "g_one":{"cwd":"/one","run":{"agent":"claude","maxParallel":8,"maxTurns":60,"maxCost":0,"setup":"make","setupCwd":"/one"}},
           "g_empty":{}}}}`

const migratedDefaults = `{"groups":{
 "__ungrouped__":{"servers":{"local":{"cwd":"/own","byAgent":{"claude":{"model":"haiku"},"pi":{"model":"p"}},
                  "run":{"agent":"cursor","maxParallel":2,"maxTurns":10,"maxCost":0}}}},
 "g_empty":{},
 "g_one":{"servers":{"local":{"cwd":"/one","run":{"agent":"claude","maxParallel":8,"maxTurns":60,"maxCost":0,"setup":"make","setupCwd":"/one"}}}}}}`

// AC32: the "last" of an old state file is merged into the ungrouped group once, at the load, in
// the per-server shape, and is then gone from the file. The file is written at that load and at
// no later one.
func TestOpenMigratesOldDefaults(t *testing.T) {
	p := NewPaths(filepath.Join(t.TempDir(), "data"))
	if err := os.MkdirAll(p.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p.State, []byte(oldState), 0o600); err != nil {
		t.Fatal(err)
	}
	st, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	var want model.Defaults
	if err := json.Unmarshal([]byte(migratedDefaults), &want); err != nil {
		t.Fatal(err)
	}
	st.Read(func(s *model.State) {
		if !reflect.DeepEqual(s.Defaults, want) || s.Version != 1 {
			t.Errorf("the loaded defaults: %+v, want %+v", s.Defaults, want)
		}
	})

	// The disk holds what runs, with no write other than the load's.
	b, err := os.ReadFile(p.State)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), `"last"`) {
		t.Errorf("state.json still holds last: %s", b)
	}
	var onDisk struct {
		Defaults map[string]json.RawMessage `json:"defaults"`
	}
	if err := json.Unmarshal(b, &onDisk); err != nil {
		t.Fatal(err)
	}
	if len(onDisk.Defaults) != 1 || onDisk.Defaults["groups"] == nil {
		t.Errorf("the defaults of state.json hold more than groups: %s", b)
	}
	var got, wantAny any
	if err := json.Unmarshal(onDisk.Defaults["groups"], &got); err != nil {
		t.Fatal(err)
	}
	wantGroups, _ := json.Marshal(want.Groups)
	if err := json.Unmarshal(wantGroups, &wantAny); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, wantAny) {
		t.Errorf("state.json's groups: %s\nwant: %s", onDisk.Defaults["groups"], wantGroups)
	}
	var local struct {
		Defaults struct {
			Groups map[string]struct {
				Servers map[string]struct {
					Cwd string `json:"cwd"`
				} `json:"servers"`
				Cwd string `json:"cwd"`
			} `json:"groups"`
		} `json:"defaults"`
	}
	if err := json.Unmarshal(b, &local); err != nil {
		t.Fatal(err)
	}
	for g, cwd := range map[string]string{model.Ungrouped: "/own", "g_one": "/one"} {
		if e := local.Defaults.Groups[g]; e.Servers[model.LocalServer].Cwd != cwd || e.Cwd != "" {
			t.Errorf("state.json's %s: %+v, want its folder under servers.local", g, e)
		}
	}
	if fi, err := os.Stat(p.State); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("state.json after the migration: %v, %v", fi, err)
	}

	// A second load changes nothing and writes nothing: the bytes and the time stay.
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	if err := os.Chtimes(p.State, old, old); err != nil {
		t.Fatal(err)
	}
	st2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	st2.Read(func(s *model.State) {
		if !reflect.DeepEqual(s.Defaults, want) {
			t.Errorf("the defaults of a second load: %+v, want %+v", s.Defaults, want)
		}
	})
	if b2, err := os.ReadFile(p.State); err != nil || string(b2) != string(b) {
		t.Errorf("state.json after a second load: %s (%v)\nwas: %s", b2, err, b)
	}
	if fi, err := os.Stat(p.State); err != nil || !fi.ModTime().Equal(old) {
		t.Errorf("state.json was written at the second load: %v, want %v (%v)", fi.ModTime(), old, err)
	}
	if _, err := os.Stat(p.State + ".tmp"); err == nil {
		t.Error("a temporary file was left beside state.json")
	}

	// A later write keeps the shape.
	if err := st2.Update(func(s *model.State) error {
		s.Groups = append(s.Groups, model.Group{ID: "g_one", Name: "One"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	st3, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	st3.Read(func(s *model.State) {
		if !reflect.DeepEqual(s.Defaults, want) || len(s.Groups) != 1 {
			t.Errorf("after a later write: %+v", s)
		}
	})
}

// The rest of an old file is kept by the migration's write, and a migration that cannot be
// written fails the load, as the first write of a new state file does.
func TestOpenMigrationWrite(t *testing.T) {
	p := NewPaths(filepath.Join(t.TempDir(), "data"))
	if _, err := Open(p); err != nil { // makes the folders
		t.Fatal(err)
	}
	const file = `{"version":1,"groups":[{"id":"g_one","name":"One","collapsed":true}],
	 "defaults":{"last":{"cwd":"/last"},"groups":{"g_one":{"cwd":"/one"}}}}`
	if err := os.WriteFile(p.State, []byte(file), 0o600); err != nil {
		t.Fatal(err)
	}
	if os.Getuid() != 0 {
		if err := os.Chmod(p.Root, 0o500); err != nil {
			t.Fatal(err)
		}
		_, err := Open(p)
		if cerr := os.Chmod(p.Root, 0o700); cerr != nil {
			t.Fatal(cerr)
		}
		if err == nil {
			t.Error("Open with a migration that could not be written: no error")
		}
		if b, _ := os.ReadFile(p.State); string(b) != file {
			t.Errorf("state.json after the failed write: %s", b)
		}
	}
	st, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	st.Read(func(s *model.State) {
		if len(s.Groups) != 1 || s.Groups[0].Name != "One" || !s.Groups[0].Collapsed {
			t.Errorf("groups after the migration: %+v", s.Groups)
		}
		if s.Defaults.Groups["g_one"].On(model.LocalServer).Cwd != "/one" || s.Defaults.Groups[model.Ungrouped].On(model.LocalServer).Cwd != "/last" {
			t.Errorf("defaults after the migration: %+v", s.Defaults)
		}
	})
	b, _ := os.ReadFile(p.State)
	if strings.Contains(string(b), `"last"`) || !strings.Contains(string(b), `"name": "One"`) {
		t.Errorf("state.json after the migration: %s", b)
	}
}

func TestOpenCorruptState(t *testing.T) {
	p := NewPaths(t.TempDir())
	if err := os.MkdirAll(p.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	bad := []byte("{not json")
	if err := os.WriteFile(p.State, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(p); err == nil {
		t.Fatal("Open succeeded on a corrupt state.json")
	}
	b, _ := os.ReadFile(p.State)
	if string(b) != string(bad) {
		t.Errorf("state.json overwritten: %s", b)
	}
}

func TestWriteFileAtomic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "drawing.excalidraw")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteFileAtomic(path, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if string(b) != "new" {
		t.Errorf("content %q", b)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("tmp file left: %s", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("entries: %v", entries)
	}
}

func TestServerFile(t *testing.T) {
	p := NewPaths(t.TempDir())
	if _, _, ok := ReadServerFile(p); ok {
		t.Fatal("ok with no file")
	}
	if err := WriteServerFile(p, 4747); err != nil {
		t.Fatal(err)
	}
	pid, port, ok := ReadServerFile(p)
	if !ok || pid != os.Getpid() || port != 4747 {
		t.Errorf("got %d %d %v", pid, port, ok)
	}
	RemoveServerFile(p)
	if _, err := os.Stat(p.Server); !os.IsNotExist(err) {
		t.Errorf("server.json not removed: %v", err)
	}
}

func TestContains(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "data")
	if err := os.MkdirAll(filepath.Join(root, "boards"), 0o700); err != nil {
		t.Fatal(err)
	}
	p := NewPaths(root)
	link := filepath.Join(base, "link")
	if err := os.Symlink(filepath.Join(root, "boards"), link); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		path string
		want bool
	}{
		{root, true},
		{root + "/", true},
		{filepath.Join(root, "boards"), true},
		{filepath.Join(root, "boards", "missing.excalidraw"), true},
		{root + "/../x", false},
		{root + "x", false},
		{base, false},
		{link, true},
		{filepath.Join(link, "b_1"), true},
	}
	for _, c := range cases {
		if got := p.Contains(c.path); got != c.want {
			t.Errorf("Contains(%q) = %v, want %v", c.path, got, c.want)
		}
	}

	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home folder")
	}
	hp := NewPaths(filepath.Join(home, ".ai-whiteboard"))
	for _, s := range []string{"~/.ai-whiteboard", "~/.ai-whiteboard/boards/b_1/drawing.excalidraw"} {
		if !hp.Contains(s) {
			t.Errorf("Contains(%q) = false", s)
		}
	}
	if hp.Contains("~/Documents") {
		t.Errorf("Contains(~/Documents) = true")
	}
}
