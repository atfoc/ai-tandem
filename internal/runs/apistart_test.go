package runs

import (
	"errors"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// Tests of the model's error of a start, and of two deletes of one run. They run on the
// package's test doubles (svcEnv): a model of the engine, a recording emitter.

// The model's error names the sentinel and keeps its text.
func TestUnknownModelIsASentinel(t *testing.T) {
	t.Parallel()
	_, err := svcModel(&model.Catalog{Models: []model.CatalogModel{{ID: "a"}}}, "x")
	if !errors.Is(err, ErrUnknownModel) || err.Error() != `unknown model "x"` {
		t.Fatalf("svcModel: %v", err)
	}
}

// Two deletes of one run, the second while the first stops the run's engine: the first removes
// the run, the second waits for it and finds the run gone, not half removed.
func TestTwoDeletesOfOneRun(t *testing.T) {
	t.Parallel()
	e := newSvcEnv(t)
	const id = "r_start001"
	e.started(id)
	stop := e.s.engine.stop
	inStop, release := make(chan struct{}), make(chan struct{})
	e.s.engine.stop = func(r *run, wait time.Duration) bool {
		close(inStop)
		<-release
		return stop(r, wait)
	}
	first, second := make(chan error, 1), make(chan error, 1)
	go func() { first <- e.s.Delete(id) }()
	<-inStop
	go func() { second <- e.s.Delete(id) }()
	select {
	case err := <-second:
		t.Fatalf("the second delete did not wait for the first: %v", err)
	case err := <-first:
		t.Fatalf("the delete did not wait in the engine's stop: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatalf("the first delete: %v", err)
	}
	if err := <-second; !errors.Is(err, ErrNotFound) {
		t.Fatalf("the second delete: %v, want ErrNotFound", err)
	}
	if _, err := e.s.View(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a read after the deletes: %v, want ErrNotFound", err)
	}
	if err := e.s.Delete(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a delete of no run: %v", err)
	}
}
