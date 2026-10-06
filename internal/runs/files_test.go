package runs

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
	"ai-whiteboard/internal/store"
)

func TestRunFiles(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "runs", "r_1")
	meta := model.RunMeta{ID: "r_1", Name: "A run", Group: model.Ungrouped, Created: time.UnixMilli(1000).UTC(), Agent: model.Pi,
		Tiers: tiersAll("m", ""), Cwd: "/work", Settings: model.DefaultRunSettings(), Draft: &model.Draft{Text: "the goal so far"}}
	if _, err := readMeta(dir); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("readMeta of no folder: %v", err)
	}
	if err := writeMeta(dir, meta); err != nil { // makes the folder
		t.Fatal(err)
	}
	if got, err := readMeta(dir); err != nil || got.ID != "r_1" || got.Draft == nil || got.Draft.Text != "the goal so far" || !got.Started.IsZero() {
		t.Fatalf("run.json round trip: %+v, %v", got, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "run.json")); strings.Contains(string(b), `"started"`) || strings.Contains(string(b), `"git"`) {
		t.Errorf("a draft's run.json names started or git: %s", b)
	}

	// Nothing recorded yet: every reader says so the same way.
	if _, err := readGoal(dir); err != ErrNoText {
		t.Errorf("readGoal: %v", err)
	}
	if _, err := readBrief(dir, "T01", 1); err != ErrNoText {
		t.Errorf("readBrief: %v", err)
	}
	if _, err := readNotes(dir, 1); err != ErrNoText {
		t.Errorf("readNotes: %v", err)
	}
	if _, err := readReport(dir, "T01", 1); err != ErrNoText {
		t.Errorf("readReport: %v", err)
	}
	if _, err := readChanges(dir, "T01", 1); err != ErrNoText {
		t.Errorf("readChanges: %v", err)
	}

	changes := model.AttemptChanges{Task: "T01", Attempt: 2, Branch: "aiwb/r_1/T01-a2", Base: "aaa", Head: "bbb",
		Files: []model.ChangedFile{{Path: "a.go", Add: 3, Del: 1}}, Add: 3, Del: 1, Commits: []model.Commit{{SHA: "bbb", Subject: "T01: x", At: 5}}}
	for name, err := range map[string]error{
		"goal":    writeGoal(dir, "# Goal\n\nbuild it"),
		"brief 1": writeBrief(dir, "T01", 1, "first brief"),
		"brief 2": writeBrief(dir, "T01", 2, "second brief"),
		"notes":   writeNotes(dir, 12, "the notes"),
		"report":  writeReport(dir, "T01", 2, "the report"),
		"changes": writeChanges(dir, "T01", 2, changes),
	} {
		if err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	// The layout of the contract.
	for rel, want := range map[string]string{
		"goal.md": "# Goal\n\nbuild it", "tasks/T01/brief.r1.md": "first brief", "tasks/T01/brief.r2.md": "second brief",
		"notes/v0012.md": "the notes", "tasks/T01/a2.report.md": "the report",
	} {
		b, err := os.ReadFile(filepath.Join(dir, rel))
		if err != nil || string(b) != want {
			t.Errorf("%s: %q, %v", rel, b, err)
		}
		if fi, err := os.Stat(filepath.Join(dir, rel)); err != nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("%s: mode %v", rel, fi.Mode().Perm())
		}
	}
	for _, d := range []string{"", "tasks", "tasks/T01", "notes"} {
		if fi, err := os.Stat(filepath.Join(dir, d)); err != nil || fi.Mode().Perm() != 0o700 {
			t.Errorf("folder %q: mode %v, %v", d, fi.Mode().Perm(), err)
		}
	}
	if got, err := readGoal(dir); err != nil || got != "# Goal\n\nbuild it" {
		t.Errorf("readGoal: %q, %v", got, err)
	}
	if got, err := readBrief(dir, "T01", 2); err != nil || got != "second brief" {
		t.Errorf("readBrief: %q, %v", got, err)
	}
	if got, err := readNotes(dir, 12); err != nil || got != "the notes" {
		t.Errorf("readNotes: %q, %v", got, err)
	}
	if got, err := readReport(dir, "T01", 2); err != nil || got != "the report" {
		t.Errorf("readReport: %q, %v", got, err)
	}
	got, err := readChanges(dir, "T01", 2)
	if err != nil || got.Head != "bbb" || len(got.Files) != 1 || got.Files[0].Path != "a.go" || len(got.Commits) != 1 || got.Add != 3 {
		t.Errorf("readChanges: %+v, %v", got, err)
	}
	// A changes file with no files or commits has lists, not null.
	if b := changesData(model.AttemptChanges{Task: "T02", Attempt: 1}); !strings.Contains(string(b), `"files": []`) || !strings.Contains(string(b), `"commits": []`) {
		t.Errorf("changesData: %s", b)
	}
	var back model.AttemptChanges
	if err := json.Unmarshal(changesData(changes), &back); err != nil || back.Branch != changes.Branch {
		t.Errorf("changesData does not read back: %v", err)
	}

	// The setup log: appended to, its folder made.
	if got, want := setupLogPath(dir, "T05", 3), filepath.Join(dir, "tasks", "T05", "a3.setup.log"); got != want {
		t.Errorf("setupLogPath %s, want %s", got, want)
	}
	for _, line := range []string{"one\n", "two\n"} {
		f, err := openSetupLog(dir, "T05", 3)
		if err != nil {
			t.Fatal(err)
		}
		f.WriteString(line)
		f.Close()
	}
	if b, _ := os.ReadFile(setupLogPath(dir, "T05", 3)); string(b) != "one\ntwo\n" {
		t.Errorf("setup log: %q", b)
	}

	// A task id that is not a folder name never becomes a path.
	for _, bad := range []string{"", ".", "..", "../x", "a/b", `a\b`, "/abs"} {
		if err := writeBrief(dir, bad, 1, "x"); err != ErrNoTask {
			t.Errorf("writeBrief(%q): %v", bad, err)
		}
		if _, err := readReport(dir, bad, 1); err != ErrNoTask {
			t.Errorf("readReport(%q): %v", bad, err)
		}
		if _, err := readChanges(dir, bad, 1); err != ErrNoTask {
			t.Errorf("readChanges(%q): %v", bad, err)
		}
		if _, err := openSetupLog(dir, bad, 1); err != ErrNoTask {
			t.Errorf("openSetupLog(%q): %v", bad, err)
		}
	}
	if err := writeText(dir, "../escape.md", []byte("x")); err == nil {
		t.Error("writeText outside the run's folder succeeded")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escape.md")); !os.IsNotExist(err) {
		t.Error("a file was written outside the run's folder")
	}
	// A file named through Tx.File with a path outside the folder fails the commit.
	e := newTestEnv(t)
	r := e.started("r_esc")
	if _, err := r.commit(KOp, func(tx *Tx) error { tx.File("../../x.md", []byte("x")); return nil }); err == nil {
		t.Error("a commit with a file outside the run's folder succeeded")
	}
}

// The stubs of the service, the tools and the engine have the signatures the three of them were
// agreed to have: a change of one of them does not compile here.
var (
	_ func(Deps) *Service                                         = New
	_ func(*Service, string) (*run, error)                        = (*Service).run
	_ func(*Service) []*run                                       = (*Service).all
	_ func(*Service, *run)                                        = (*Service).add
	_ func(*Service, string)                                      = (*Service).remove
	_ func(*Service, string, any)                                 = (*Service).queue
	_ func(*run)                                                  = (*run).changed
	_ func(model.RunMeta, *Loaded, gitFacts) string               = snapshotText
	_ func(model.RunEvent) string                                 = eventLine
	_ func(*engines, *Service)                                    = (*engines).init
	_ func(*run)                                                  = (*run).startEngine
	_ func(*run, Halting) error                                   = (*run).halt
	_ func(*run) error                                            = (*run).resume
	_ func(*run, time.Duration) bool                              = (*run).stopEngine
	_ func(*run, string, model.AttemptCancel) string              = (*run).cancelActive
	_ func(*run, context.Context) error                           = (*run).removeCheckouts
	_ func(*run) map[string]Live                                  = (*run).live
	_ func(*run, context.Context) (gitFacts, error)               = (*run).gitFacts
	_ func(*Service)                                              = (*Service).Boot
	_ func(*Service, time.Duration)                               = (*Service).Shutdown
	_ func(*run, EntryKind, func(*Tx) error) (int64, error)       = (*run).commit
	_ func(*run) error                                            = (*run).checkpoint
	_ func(*run) error                                            = (*run).load
	_ func(*run) error                                            = (*run).open
	_ func(*run)                                                  = (*run).refresh
	_ func(*run, Facts)                                           = (*run).setFacts
	_ func(*run) model.RunView                                    = (*run).viewNow
	_ func(*Service, model.RunMeta) *run                          = newRun
	_ func(Deps, context.Context, string) (*rungit.Repo, error)   = Deps.openRepo
	_ func(gitFacts) (string, int)                                = func(g gitFacts) (string, int) { return g.Head, g.Commits }
	_ func(chats.RunInfo) (string, bool, string, model.AgentKind) = func(i chats.RunInfo) (string, bool, string, model.AgentKind) {
		return i.Group, i.Archived, i.Cwd, i.Agent
	}
	_ func() []boardtools.Tool = boardtools.OrchestratorTools
	_ func() []boardtools.Tool = boardtools.RunChatTools
)

// pinFields: a run's engine and the service's engine state are where the engine was told they are.
func pinFields(r *run, s *Service) (**engine, *engines) { return &r.eng, &s.eng }

func TestServiceAndDeps(t *testing.T) {
	st, err := store.Open(store.NewPaths(filepath.Join(t.TempDir(), "data")))
	if err != nil {
		t.Fatal(err)
	}
	s := New(Deps{Store: st})
	if _, ok := s.Clock.(RealClock); !ok {
		t.Errorf("a Service with no clock got %T", s.Clock)
	}
	if d := time.Since(time.UnixMilli(s.nowMs())); d < 0 || d > time.Minute {
		t.Errorf("nowMs is %v away from now", d)
	}
	select {
	case <-s.Clock.After(time.Millisecond):
	case <-time.After(5 * time.Second):
		t.Error("RealClock.After did not fire")
	}
	if _, err := s.run("r_none"); err != ErrNotFound {
		t.Errorf("run of an unknown id: %v", err)
	}
	a := newRun(s, model.RunMeta{ID: "r_a", Agent: model.Cursor})
	b := newRun(s, model.RunMeta{ID: "r_b"})
	s.add(a)
	s.add(b)
	if got, err := s.run("r_a"); err != nil || got != a {
		t.Errorf("run(r_a): %v", err)
	}
	if len(s.all()) != 2 {
		t.Errorf("all: %d runs", len(s.all()))
	}
	s.remove("r_a")
	if _, err := s.run("r_a"); err != ErrNotFound || len(s.all()) != 1 {
		t.Errorf("after remove: %v, %d runs", err, len(s.all()))
	}
	if a.dir != st.P.RunDir("r_a") || !a.noCost() || b.noCost() || cap(a.wake) != 1 {
		t.Errorf("newRun: dir %s", a.dir)
	}
	if v := a.viewNow(); v.ID != "r_a" || v.Status != model.RunDraft {
		t.Errorf("a new run's view: %+v", v)
	}
	a.setFacts(Facts{Git: true, Blocked: "why"})
	if v := a.viewNow(); !v.Git || v.Blocked != "why" {
		t.Errorf("view after setFacts: %+v", v)
	}
	// A clock a test moves is the service's time.
	c := agenttest.NewClock(testStart)
	s2 := New(Deps{Store: st, Clock: c})
	c.Advance(time.Hour)
	if s2.nowMs() != testStart.Add(time.Hour).UnixMilli() {
		t.Error("nowMs is not the clock's")
	}
}

// openRepo is how the service and the engine reach git: with the service's git environment.
func TestOpenRepo(t *testing.T) {
	repo := agenttest.NewRepo(t)
	d := Deps{GitEnv: repo.Env()}
	ctx := context.Background()
	if _, err := d.openRepo(ctx, repo.Dir()); !errors.Is(err, rungit.ErrNoCommits) {
		t.Fatalf("a repository with no commit: %v", err)
	}
	repo.Write("sub/a.txt", "a\n")
	head := repo.Commit("first")
	r, err := d.openRepo(ctx, filepath.Join(repo.Dir(), "sub"))
	if err != nil {
		t.Fatal(err)
	}
	if r.Root() != repo.Dir() {
		t.Errorf("root %s, want %s", r.Root(), repo.Dir())
	}
	if got, err := r.Resolve(ctx, "HEAD"); err != nil || got != head {
		t.Errorf("HEAD %s, want %s (%v)", got, head, err)
	}
	if _, err := d.openRepo(ctx, t.TempDir()); !errors.Is(err, rungit.ErrNotRepo) {
		t.Errorf("a plain folder: %v", err)
	}
}
