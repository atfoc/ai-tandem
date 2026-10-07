package store

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/defaults"
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
		p.RemoteRuns:                         filepath.Join(base, "data", "remote", "runs"),
		p.RemoteRunFile("r_1"):               filepath.Join(base, "data", "remote", "runs", "r_1.json"),
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

// The run defaults are kept in state.json, per group and per server, and are absent from it until a
// run was started.
func TestRunDefaultsPersist(t *testing.T) {
	p := NewPaths(t.TempDir())
	st, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Update(func(s *model.State) error {
		s.Defaults.Groups[model.Ungrouped] = model.LocalDefaults(model.ServerDefaults{Cwd: "/tmp"})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(p.State); strings.Contains(string(b), `"run"`) {
		t.Errorf("state.json names run defaults nobody set: %s", b)
	}
	want := model.RunDefaults{Agent: model.Cursor, MaxParallel: 3, MaxTurns: 40, MaxCost: 2.5, Setup: "npm ci", SetupCwd: "/tmp",
		Tiers: &model.RunTiers{Deep: model.ModelChoice{Model: "gpt-5.4", Effort: "high"}, Standard: model.ModelChoice{Model: "auto"}, Light: model.ModelChoice{Model: "auto"}}}
	far := model.RunDefaults{Agent: model.Pi, MaxParallel: 1, MaxTurns: 5, Setup: "make", SetupCwd: "/srv/far"}
	if err := st.Update(func(s *model.State) error {
		defaults.RecordRun(&s.Defaults, model.Ungrouped, model.LocalServer, want)
		defaults.RecordRun(&s.Defaults, model.Ungrouped, "srv_far", far)
		defaults.RecordRun(&s.Defaults, "g_one", "srv_far", far)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p.State)
	before, err := os.Stat(p.State)
	if err != nil {
		t.Fatal(err)
	}
	st2, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	st2.Read(func(s *model.State) {
		// Per server: each part has its own, and a group's part for one server says nothing of another.
		g := s.Defaults.Groups[model.Ungrouped]
		if got := g.On(model.LocalServer); !reflect.DeepEqual(got.Run, &want) || got.Cwd != "/tmp" {
			t.Errorf("the local part after reopen: %+v", got)
		}
		if got := g.On("srv_far"); !reflect.DeepEqual(got.Run, &far) || got.Cwd != "" {
			t.Errorf("the other server's part after reopen: %+v", got)
		}
		if got := defaults.Run(s.Defaults, "g_one", model.LocalServer); !reflect.DeepEqual(got, &want) {
			t.Errorf("g_one on the local server: %+v, want the ungrouped group's", got)
		}
		if got := defaults.Run(s.Defaults, "g_one", "srv_far"); !reflect.DeepEqual(got, &far) {
			t.Errorf("g_one on the other server: %+v, want its own", got)
		}
		if got := defaults.Run(s.Defaults, "g_two", "srv_none"); got != nil {
			t.Errorf("a server nobody ran on: %+v, want none", got)
		}
	})
	// A file in today's shape is not written again at the load.
	if b2, _ := os.ReadFile(p.State); string(b2) != string(b) || strings.Contains(string(b), `"last"`) {
		t.Errorf("state.json after reopen: %s\nwas: %s", b2, b)
	}
	if after, err := os.Stat(p.State); err != nil || !after.ModTime().Equal(before.ModTime()) {
		t.Errorf("state.json was written at the reopen: %v -> %v (%v)", before.ModTime(), after, err)
	}
}
