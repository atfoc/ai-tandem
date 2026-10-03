package claude

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// initFake sets up the fake to answer every initialize request with the named testdata fixture.
func initFake(t *testing.T, fixture string, lines ...string) *fake {
	t.Helper()
	f := newFake(t, lines...)
	path, err := filepath.Abs(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(envInit, path)
	return f
}

// firstCatalog spawns a chat process and returns the catalog of its first event, which must be
// the catalog event; the process is then closed and must end with nothing else (stdinLines).
func firstCatalog(t *testing.T, f *fake, o agent.SpawnOptions) *model.Catalog {
	t.Helper()
	o.SessionID, o.Cwd = "s1", t.TempDir()
	a, err := f.spawner().Spawn(o)
	if err != nil {
		t.Fatal(err)
	}
	ev := next(t, a)
	if ev.Kind != agent.EvCatalog || ev.Catalog == nil {
		t.Fatalf("first event %+v, want the catalog event", ev)
	}
	f.stdinLines(t, a) // fails on any further event: one catalog event per process
	return ev.Catalog
}

func TestChatProcessEmitsCatalogEvent(t *testing.T) {
	f := initFake(t, "initialize.json")
	got := firstCatalog(t, f, agent.SpawnOptions{Model: "sonnet", Effort: "high"})
	want := mapped(t, fixtureLine(t, "initialize.json"))
	if !reflect.DeepEqual(got, want) {
		t.Errorf("event catalog %+v\nwant %+v", got, want)
	}
	if len(got.Models) != 11 || got.Default.Model != "sonnet" || got.Default.Effort != "high" {
		t.Errorf("catalog: %d rows, default %+v", len(got.Models), got.Default)
	}
}

// A resumed process emits it too.
func TestResumedChatProcessEmitsCatalogEvent(t *testing.T) {
	f := initFake(t, "initialize.json")
	got := firstCatalog(t, f, agent.SpawnOptions{Resume: true, Model: "sonnet"})
	if len(got.Models) != 11 {
		t.Errorf("%d rows", len(got.Models))
	}
}

// Acceptance 10b: the entry the CLI made up for an unlisted model is not in the event, whether or
// not the process's own model is that one.
func TestCatalogEventDropsSynthesizedEntry(t *testing.T) {
	want := mapped(t, fixtureLine(t, "initialize.json"))
	for _, m := range []string{"p0-unlisted-model-xyz", "sonnet", ""} {
		f := initFake(t, "initialize_synthesized.json")
		got := firstCatalog(t, f, agent.SpawnOptions{Model: m})
		for _, id := range ids(got) {
			if id == "p0-unlisted-model-xyz" {
				t.Errorf("model %q: the synthesized entry is in the event: %v", m, ids(got))
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("model %q: event catalog %v, want %v", m, ids(got), ids(want))
		}
	}
}

// One catalog event per process: a second answer with the same id is not another event.
func TestCatalogEventOncePerProcess(t *testing.T) {
	f := initFake(t, "initialize.json")
	t.Setenv(envDup, "1")
	firstCatalog(t, f, agent.SpawnOptions{Model: "sonnet"}) // fails on any further event
}

// A model that is in the list keeps its row.
func TestCatalogEventKeepsListedModel(t *testing.T) {
	f := initFake(t, "initialize_synthesized.json")
	got := firstCatalog(t, f, agent.SpawnOptions{Model: "haiku"})
	for _, r := range got.Models {
		if r.ID == "haiku" {
			return
		}
	}
	t.Errorf("haiku is not in the event: %v", ids(got))
}

// noCatalogEvent runs a process to its end and fails on any event but the exit.
func noCatalogEvent(t *testing.T, f *fake) {
	t.Helper()
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir(), Model: "sonnet"})
	if err != nil {
		t.Fatal(err)
	}
	skipInit(t, f.stdinLines(t, a))
}

// Nothing waits for the answer: a process that does not answer sends and ends as before (the spawn
// and send tests cover the rest).
func TestNoInitializeAnswerNoCatalogEvent(t *testing.T) {
	noCatalogEvent(t, newFake(t))
}

func TestCatalogEventOnlyForOwnInitializeAnswer(t *testing.T) {
	t.Run("another request id", func(t *testing.T) {
		f := initFake(t, "initialize.json")
		t.Setenv(envWrong, "1")
		noCatalogEvent(t, f)
	})
	t.Run("interrupt and unrelated answers", func(t *testing.T) {
		f := newFake(t,
			`{"type":"control_response","response":{"subtype":"success","request_id":"int_1","response":{"still_queued":[]}}}`,
			`{"type":"control_response","response":{"subtype":"success","request_id":"ctx_9","response":{"models":[{"value":"x","displayName":"X"}]}}}`,
			`{"type":"control_response","response":{"subtype":"success","request_id":"init_zz","response":{"models":[{"value":"x","displayName":"X"}]}}}`,
		)
		noCatalogEvent(t, f)
	})
	t.Run("error answer and unusable lists", func(t *testing.T) {
		for name, answer := range map[string]string{
			"error":     `{"type":"control_response","response":{"subtype":"error","request_id":"x","error":"nope"}}`,
			"empty":     `{"type":"control_response","response":{"subtype":"success","request_id":"x","response":{"models":[]}}}`,
			"no models": `{"type":"control_response","response":{"subtype":"success","request_id":"x","response":{}}}`,
			"no value":  `{"type":"control_response","response":{"subtype":"success","request_id":"x","response":{"models":[{"displayName":"X"}]}}}`,
			"only made": `{"type":"control_response","response":{"subtype":"success","request_id":"x","response":{"models":[{"value":"y","displayName":"y"}]}}}`,
		} {
			t.Run(name, func(t *testing.T) {
				f := newFake(t)
				bad := filepath.Join(f.dir, "bad.json")
				if err := os.WriteFile(bad, []byte(answer), 0o644); err != nil {
					t.Fatal(err)
				}
				t.Setenv(envInit, bad)
				noCatalogEvent(t, f)
			})
		}
	})
}

// The initialize answer does not stand in the way of a context-usage answer.
func TestCatalogEventAndContextSplitTogether(t *testing.T) {
	f := initFake(t, "initialize.json")
	ctxAnswers(t, f, string(readFixture(t)))
	a, err := f.spawner().Spawn(agent.SpawnOptions{SessionID: "s1", Cwd: t.TempDir(), Model: "sonnet"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.(*proc).ContextSplit(); err != nil {
		t.Fatal(err)
	}
	if ev := next(t, a); ev.Kind != agent.EvCatalog {
		t.Fatalf("event %+v, want the catalog event", ev)
	}
	f.stdinLines(t, a)
}
