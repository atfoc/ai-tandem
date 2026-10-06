package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

func TestRunPaths(t *testing.T) {
	base := t.TempDir()
	p := NewPaths(filepath.Join(base, "data"))
	for got, want := range map[string]string{
		p.Runs:                               filepath.Join(base, "data", "runs"),
		p.RunWork:                            filepath.Join(base, "aiwb-run-work"),
		p.RunDir("r_1"):                      filepath.Join(base, "data", "runs", "r_1"),
		p.RunChatDir("r_1", true, "c-agent"): filepath.Join(base, "data", "runs", "r_1", "agents", "c-agent"),
		p.RunChatDir("r_1", false, "c-chat"): filepath.Join(base, "data", "runs", "r_1", "chats", "c-chat"),
		p.RunWorkDir("r_1"):                  filepath.Join(base, "aiwb-run-work", "r_1"),
	} {
		if got != want {
			t.Errorf("got %s, want %s", got, want)
		}
	}
	// A root with a trailing slash has the same parent.
	if q := NewPaths(filepath.Join(base, "data") + "/"); q.RunWork != p.RunWork {
		t.Errorf("RunWork of a root with a trailing slash: %s", q.RunWork)
	}
	// A run's folders are inside the data folder; its checkouts never are.
	if !p.Contains(p.RunChatDir("r_1", true, "c")) || !p.Contains(p.RunDir("r_1")) {
		t.Error("a run's folder is not inside Root")
	}
	if p.Contains(p.RunWork) || p.Contains(p.RunWorkDir("r_1")) || strings.HasPrefix(p.RunWork, p.Root+string(filepath.Separator)) {
		t.Errorf("RunWork %s is inside Root %s", p.RunWork, p.Root)
	}
}

func TestOpenCreatesRunsNotRunWork(t *testing.T) {
	p := NewPaths(filepath.Join(t.TempDir(), "data"))
	if _, err := Open(p); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(p.Runs)
	if err != nil || !fi.IsDir() {
		t.Fatalf("runs/ not created: %v", err)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Errorf("runs/ mode %v, want 0700", fi.Mode().Perm())
	}
	if _, err := os.Stat(p.RunWork); !os.IsNotExist(err) {
		t.Errorf("Open made RunWork (or it cannot be read): %v", err)
	}
	// A data folder made before runs existed gets runs/ at the next Open, and keeps its state.
	if err := os.Remove(p.Runs); err != nil {
		t.Fatal(err)
	}
	st, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.Runs); err != nil {
		t.Errorf("runs/ not created in an existing data folder: %v", err)
	}
	st.Read(func(s *model.State) {
		if s.Version != 1 {
			t.Errorf("state: %+v", s)
		}
	})
}

// GroupDefaults.Run is kept in state.json and is absent from it until a run was started.
func TestRunDefaultsPersist(t *testing.T) {
	p := NewPaths(t.TempDir())
	st, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Update(func(s *model.State) error {
		s.Defaults.Groups[model.Ungrouped] = model.GroupDefaults{Cwd: "/tmp"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p.State); strings.Contains(string(b), `"run"`) {
		t.Errorf("state.json names run defaults nobody set: %s", b)
	}
	want := model.RunDefaults{Agent: model.Cursor, MaxParallel: 3, MaxTurns: 40, MaxCost: 2.5, Setup: "npm ci", SetupCwd: "/tmp"}
	if err := st.Update(func(s *model.State) error {
		g := s.Defaults.Groups[model.Ungrouped]
		g.Run = &want
		s.Defaults.Groups[model.Ungrouped] = g
		s.Defaults.Last.Run = &want
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	st2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	st2.Read(func(s *model.State) {
		g := s.Defaults.Groups[model.Ungrouped]
		if g.Run == nil || *g.Run != want || s.Defaults.Last.Run == nil || *s.Defaults.Last.Run != want || g.Cwd != "/tmp" {
			b, _ := json.Marshal(s.Defaults)
			t.Errorf("defaults after reopen: %s", b)
		}
	})
}
