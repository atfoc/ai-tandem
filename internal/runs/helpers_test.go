package runs

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// Test support of the record layer, for every test of this package (the service's, the tools' and
// the engine's tests can build on it; none of them should have to change it).

// testStart is the time the test clock starts at.
var testStart = time.UnixMilli(1_800_000_000_000)

// recEmitter keeps what the service sends, and for each event the run it was sent as an event of
// ("" for a Broadcast).
type recEmitter struct {
	mu   sync.Mutex
	evs  []any
	runs []string
}

func (e *recEmitter) Broadcast(ev any) { e.SendRun("", ev) }

func (e *recEmitter) SendRun(run string, ev any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.evs = append(e.evs, ev)
	e.runs = append(e.runs, run)
}

// sentAs returns, for each event sent so far, the run it was sent as an event of.
func (e *recEmitter) sentAs() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.runs...)
}

func (e *recEmitter) events() []any {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]any(nil), e.evs...)
}

// testEnv is a Service on a temp data folder, with a clock the test moves and a recorder as its
// emitter. Chats is nil until a test sets one.
type testEnv struct {
	t     testing.TB
	root  string // the data folder
	cwd   string // an existing folder for runs to work in
	clock *agenttest.Clock
	emit  *recEmitter
	s     *Service
}

func newTestEnv(t testing.TB) *testEnv {
	t.Helper()
	e := &testEnv{t: t, root: filepath.Join(t.TempDir(), "data"), cwd: t.TempDir(), clock: agenttest.NewClock(testStart), emit: &recEmitter{}}
	e.boot()
	return e
}

// boot makes a fresh Service on the same data folder, as a server restart does. No run is in
// it: reopen puts one back.
func (e *testEnv) boot() *Service {
	e.t.Helper()
	st, err := store.Open(store.NewPaths(e.root))
	if err != nil {
		e.t.Fatal(err)
	}
	e.s = New(Deps{Store: st, Emit: e.emit, DefaultCwd: e.cwd, Clock: e.clock})
	return e.s
}

// tiersAll is a tier map with every tier on one model and effort.
func tiersAll(id, effort string) model.RunTiers {
	mc := model.ModelChoice{Model: id, Effort: effort}
	return model.RunTiers{Deep: mc, Standard: mc, Light: mc}
}

// draft makes a run that has not started: its folder, its run.json, and the run in the service.
func (e *testEnv) draft(id string) *run {
	e.t.Helper()
	meta := model.RunMeta{ID: id, Name: DefaultName, Group: model.Ungrouped, Created: e.clock.Now(), Agent: model.Claude,
		Tiers: tiersAll("sonnet", ""), Cwd: e.cwd, Settings: model.DefaultRunSettings()}
	if err := writeMeta(e.s.Store.P.RunDir(id), meta); err != nil {
		e.t.Fatal(err)
	}
	r := newRun(e.s, meta)
	e.s.add(r)
	return r
}

// started makes a run and starts it the way the service's Start does, without git and without
// an engine: leftovers removed, goal.md, entry 1 (run_started), a checkpoint, run.json with
// Started.
func (e *testEnv) started(id string) *run {
	e.t.Helper()
	r := e.draft(id)
	const goal = "Build the thing.\n"
	if err := removeRecord(r.dir); err != nil {
		e.t.Fatal(err)
	}
	if err := writeGoal(r.dir, goal); err != nil {
		e.t.Fatal(err)
	}
	if _, err := r.commit(KRunStarted, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.StartedAt, st.AsOf, st.GoalSize = model.RunRunning, tx.Now(), tx.Now(), len(goal)
		return nil
	}); err != nil {
		e.t.Fatal(err)
	}
	if err := r.checkpoint(); err != nil {
		e.t.Fatal(err)
	}
	r.mu.Lock()
	r.meta.Started = e.clock.Now()
	err := writeMeta(r.dir, r.meta)
	r.refreshView()
	r.mu.Unlock()
	if err != nil {
		e.t.Fatal(err)
	}
	return r
}

// reopen is the run after a server restart: a fresh Service, the run made from its run.json and
// opened as the service's Load does.
func (e *testEnv) reopen(id string) *run {
	e.t.Helper()
	e.boot()
	meta, err := readMeta(e.s.Store.P.RunDir(id))
	if err != nil {
		e.t.Fatal(err)
	}
	r := newRun(e.s, meta)
	if err := r.open(); err != nil {
		e.t.Fatal(err)
	}
	e.s.add(r)
	return r
}

// must commits and fails the test on an error.
func (e *testEnv) must(r *run, kind EntryKind, build func(tx *Tx) error) int64 {
	e.t.Helper()
	v, err := r.commit(kind, build)
	if err != nil {
		e.t.Fatalf("commit %s: %v", kind, err)
	}
	return v
}

// dump is a recorded state as text, to compare two of them: the JSON of everything in it. A nil
// list and an empty one are the same state (a journal line leaves out both).
func dump(t testing.TB, l *Loaded) string {
	t.Helper()
	b, err := json.Marshal(l)
	if err != nil {
		t.Fatal(err)
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	b, _ = json.MarshalIndent(dropEmpty(v), "", " ")
	return string(b)
}

// dropEmpty removes null, empty lists and empty objects from decoded JSON.
func dropEmpty(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			if e = dropEmpty(e); e == nil {
				delete(x, k)
			} else {
				x[k] = e
			}
		}
		if len(x) == 0 {
			return nil
		}
	case []any:
		if len(x) == 0 {
			return nil
		}
		for i := range x {
			x[i] = dropEmpty(x[i])
		}
	}
	return v
}

// readEntries reads a run's whole journal.
func readEntries(t testing.TB, dir string) []Entry {
	t.Helper()
	es, _, torn, err := readJournal(dir, 0)
	if err != nil || torn {
		t.Fatalf("journal of %s: torn %v, %v", dir, torn, err)
	}
	return es
}

// copyDir copies a run's folder (files and folders, not links) into a new temp folder.
func copyDir(t testing.TB, src string) string {
	t.Helper()
	dst := filepath.Join(t.TempDir(), filepath.Base(src))
	err := filepath.Walk(src, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		if fi.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o700)
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(filepath.Join(dst, rel), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, in)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

// nopHost is a ChatHost that does nothing and has nothing: a test's own fake embeds it and
// replaces what it needs.
type nopHost struct{}

var _ ChatHost = nopHost{}

func (nopHost) CreateOnRun(model.AgentKind, string) (model.ChatView, error) {
	return model.ChatView{}, nil
}
func (nopHost) ChatsOfRun(string) (people, agents []model.ChatMeta)      { return nil, nil }
func (nopHost) CreateOwned(chats.OwnedSpec) (bool, error)                { return true, nil }
func (nopHost) SendOwned(string, string, chats.OwnedSend) error          { return nil }
func (nopHost) WaitOwned(context.Context, string) (chats.Settled, error) { return chats.Settled{}, nil }
func (nopHost) StopOwned(string, time.Duration)                          {}
func (nopHost) DeleteOwned(string) error                                 { return nil }
func (nopHost) OwnedState(string) (chats.OwnedState, error)              { return chats.OwnedState{}, nil }
func (nopHost) CostOf(string) (chats.Cost, error)                        { return chats.Cost{}, nil }
func (nopHost) Activity(string) (chats.Activity, error)                  { return chats.Activity{}, nil }
func (nopHost) Idle(string) bool                                         { return true }
func (nopHost) TurnRunning(string) bool                                  { return false }
func (nopHost) Delete(string) error                                      { return nil }
func (nopHost) SetArchive(string, model.Archive) error                   { return nil }
func (nopHost) Stop(string)                                              {}
func (nopHost) ItemsOf(string, string) (string, int, []model.Item, []model.Subagent, error) {
	return "", 0, nil, nil, nil
}
