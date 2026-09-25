package store

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

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
		s.Defaults.Groups[model.Ungrouped] = model.GroupDefaults{Cwd: "/tmp",
			ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "sonnet", Effort: "high"}}}
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
		if s.Defaults.Groups[model.Ungrouped].ByAgent[model.Claude].Effort != "high" {
			t.Errorf("defaults: %+v", s.Defaults)
		}
	})
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
