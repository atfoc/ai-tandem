package usable

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
)

var testBins = map[model.AgentKind]string{model.Claude: "claude", model.Cursor: "agent", model.Pi: "pi"}

func kinds(a ...model.AgentKind) []model.AgentKind { return append([]model.AgentKind{}, a...) }

func putProgram(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func wantList(t *testing.T, got, want []model.AgentKind) {
	t.Helper()
	if got == nil {
		t.Fatalf("list is nil, want %v", want)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("list = %v, want %v", got, want)
	}
}

// fakeLook is a look-up whose programs a test puts in and removes.
type fakeLook struct {
	mu   sync.Mutex
	have map[string]bool
}

func newFakeLook(bins ...string) *fakeLook {
	f := &fakeLook{have: map[string]bool{}}
	for _, b := range bins {
		f.have[b] = true
	}
	return f
}

func (f *fakeLook) set(bin string, there bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.have[bin] = there
}

func (f *fakeLook) look(bin string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.have[bin] {
		return "/bin/" + bin, nil
	}
	return "", errors.New("not found")
}

func TestListFollowsThePath(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)

	// The files are made in an order that is not the fixed one.
	putProgram(t, dir, "pi")
	s := New(testBins)
	wantList(t, s.List(), kinds(model.Pi))
	if s.First() != model.Pi || !s.Has(model.Pi) || s.Has(model.Claude) {
		t.Fatalf("First = %q, Has(pi) = %v, Has(claude) = %v", s.First(), s.Has(model.Pi), s.Has(model.Claude))
	}

	// A program installed while the server runs is seen at the next look-up, not before.
	putProgram(t, dir, "claude")
	wantList(t, s.List(), kinds(model.Pi))
	wantList(t, s.Refresh(), kinds(model.Claude, model.Pi))
	wantList(t, s.List(), kinds(model.Claude, model.Pi))
	if s.First() != model.Claude {
		t.Fatalf("First = %q, want claude", s.First())
	}

	putProgram(t, dir, "agent")
	wantList(t, s.Refresh(), kinds(model.Claude, model.Cursor, model.Pi))

	// A file that cannot be run is not a program.
	if err := os.Chmod(filepath.Join(dir, "agent"), 0o644); err != nil {
		t.Fatal(err)
	}
	wantList(t, s.Refresh(), kinds(model.Claude, model.Pi))

	for _, name := range []string{"claude", "agent", "pi"} {
		if err := os.Remove(filepath.Join(dir, name)); err != nil {
			t.Fatal(err)
		}
	}
	wantList(t, s.Refresh(), kinds())
	if s.First() != "" || s.Has(model.Claude) {
		t.Fatalf("First = %q, Has(claude) = %v, want none", s.First(), s.Has(model.Claude))
	}
}

func TestListIsACopy(t *testing.T) {
	t.Parallel()
	s := NewWith(testBins, newFakeLook("claude", "pi").look)
	l := s.List()
	l[0] = model.Cursor
	wantList(t, s.List(), kinds(model.Claude, model.Pi))

	var none *Set
	none.List()[0] = model.Pi
	wantList(t, defaults.AgentOrder, kinds(model.Claude, model.Cursor, model.Pi))
}

func TestProgramGivenAsAPath(t *testing.T) {
	t.Setenv("PATH", t.TempDir()) // nothing is on PATH
	dir := t.TempDir()
	p := filepath.Join(dir, "my-cursor")

	s := New(map[model.AgentKind]string{model.Claude: "claude", model.Cursor: p})
	wantList(t, s.List(), kinds())

	putProgram(t, dir, "my-cursor")
	wantList(t, s.Refresh(), kinds(model.Cursor))

	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	wantList(t, s.Refresh(), kinds())
}

func TestEmptyProgramNameIsNotUsable(t *testing.T) {
	t.Parallel()
	// A look-up that finds everything, the empty name included.
	all := func(bin string) (string, error) { return bin, nil }

	s := NewWith(map[model.AgentKind]string{model.Claude: "claude", model.Cursor: ""}, all)
	wantList(t, s.List(), kinds(model.Claude)) // Cursor: empty name; pi: not in the map
	wantList(t, s.Refresh(), kinds(model.Claude))
	if s.Has(model.Cursor) || s.Has(model.Pi) {
		t.Fatal("a kind with no program is usable")
	}
	if err := s.Check(model.Cursor); !errors.Is(err, ErrMissing) {
		t.Fatalf("Check(cursor) = %v, want ErrMissing", err)
	}

	wantList(t, NewWith(nil, all).List(), kinds())
}

func TestCheck(t *testing.T) {
	t.Parallel()
	f := newFakeLook("claude")
	s := NewWith(testBins, f.look)

	if err := s.Check(model.Claude); err != nil {
		t.Fatalf("Check(claude) = %v, want nil", err)
	}

	err := s.Check(model.Cursor)
	var me *MissingError
	if !errors.As(err, &me) || me.Agent != model.Cursor || me.Bin != "agent" {
		t.Fatalf("Check(cursor) = %#v, want a MissingError for cursor and \"agent\"", err)
	}
	if !errors.Is(err, ErrMissing) || errors.Is(err, ErrNone) {
		t.Fatalf("Check(cursor) = %v: Is(ErrMissing) = %v, Is(ErrNone) = %v", err, errors.Is(err, ErrMissing), errors.Is(err, ErrNone))
	}
	want := `Cursor's program ("agent") was not found on this server: install it, or choose another agent`
	if err.Error() != want {
		t.Fatalf("text = %q, want %q", err.Error(), want)
	}

	if err := s.Check("nobody"); !errors.Is(err, ErrMissing) {
		t.Fatalf("Check(nobody) = %v, want ErrMissing", err)
	}

	// Check looks now: it sees a program installed or removed since the last look-up.
	f.set("agent", true)
	if err := s.Check(model.Cursor); err != nil {
		t.Fatalf("Check(cursor) after the install = %v, want nil", err)
	}
	wantList(t, s.List(), kinds(model.Claude, model.Cursor))
	f.set("claude", false)
	if err := s.Check(model.Claude); !errors.Is(err, ErrMissing) {
		t.Fatalf("Check(claude) after the removal = %v, want ErrMissing", err)
	}
	wantList(t, s.List(), kinds(model.Cursor))
}

// No agent: ErrNone while none is usable, ErrUnchosen once one is. Both are ErrNone to errors.Is,
// and Check looks now.
func TestCheckNoAgent(t *testing.T) {
	t.Parallel()
	f := newFakeLook()
	s := NewWith(testBins, f.look)
	err := s.Check("")
	if err != ErrNone || errors.Is(err, ErrUnchosen) || errors.Is(err, ErrMissing) {
		t.Fatalf(`Check("") with no program = %v, want ErrNone`, err)
	}
	if want := "no agent can be used on this server: none of the programs of Claude Code, Cursor and pi was found"; err.Error() != want {
		t.Fatalf("text = %q, want %q", err.Error(), want)
	}

	f.set("pi", true)
	err = s.Check("")
	if err != ErrUnchosen || !errors.Is(err, ErrUnchosen) {
		t.Fatalf(`Check("") with pi installed = %v, want ErrUnchosen`, err)
	}
	if !errors.Is(err, ErrNone) || errors.Is(err, ErrMissing) {
		t.Fatalf("ErrUnchosen: Is(ErrNone) = %v, Is(ErrMissing) = %v", errors.Is(err, ErrNone), errors.Is(err, ErrMissing))
	}
	if want := "no agent is chosen: choose one of the agents this server can use"; err.Error() != want {
		t.Fatalf("text = %q, want %q", err.Error(), want)
	}
	if wrapped := fmt.Errorf("start: %w", err); !errors.Is(wrapped, ErrNone) || !errors.Is(wrapped, ErrUnchosen) {
		t.Fatalf("wrapped: Is(ErrNone) = %v, Is(ErrUnchosen) = %v", errors.Is(wrapped, ErrNone), errors.Is(wrapped, ErrUnchosen))
	}
	if errors.Is(ErrNone, ErrUnchosen) {
		t.Fatal("ErrNone is ErrUnchosen")
	}
	wantList(t, s.List(), kinds(model.Pi)) // the look of Check is stored

	f.set("pi", false)
	if err := s.Check(""); err != ErrNone {
		t.Fatalf(`Check("") after the removal = %v, want ErrNone`, err)
	}

	// No look-up configured: nothing is refused here.
	var none *Set
	if err := none.Check(""); err != nil {
		t.Fatalf(`Check("") of a nil set = %v, want nil`, err)
	}
}

func TestMissingErrorNames(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		e    MissingError
		want string
	}{
		{MissingError{model.Claude, "claude"}, `Claude Code's program ("claude") was not found on this server: install it, or choose another agent`},
		{MissingError{model.Pi, "/opt/pi"}, `pi's program ("/opt/pi") was not found on this server: install it, or choose another agent`},
		{MissingError{model.Cursor, ""}, `Cursor's program was not found on this server: install it, or choose another agent`},
	} {
		if got := c.e.Error(); got != c.want {
			t.Errorf("text = %q, want %q", got, c.want)
		}
	}
}

func TestNilSet(t *testing.T) {
	t.Parallel()
	var s *Set
	all := kinds(model.Claude, model.Cursor, model.Pi)
	wantList(t, s.List(), all)
	wantList(t, s.Refresh(), all)
	if s.First() != model.Claude {
		t.Fatalf("First = %q, want claude", s.First())
	}
	for _, a := range []model.AgentKind{model.Claude, model.Cursor, model.Pi, ""} {
		if !s.Has(a) {
			t.Errorf("Has(%q) = false", a)
		}
		if err := s.Check(a); err != nil {
			t.Errorf("Check(%q) = %v, want nil", a, err)
		}
	}

	// Watch has nothing to watch: it blocks until the stop and never calls changed.
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		s.Watch(time.Millisecond, stop, func([]model.AgentKind) { t.Error("changed was called") })
		close(done)
	}()
	time.Sleep(20 * time.Millisecond)
	close(stop)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Watch did not return after the stop")
	}
}

// watch starts Watch and returns the channel its calls arrive on and a function that stops it and
// waits for its end.
func watch(t *testing.T, s *Set, every time.Duration) (<-chan []model.AgentKind, func()) {
	t.Helper()
	calls := make(chan []model.AgentKind, 16)
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		s.Watch(every, stop, func(l []model.AgentKind) { calls <- l })
		close(done)
	}()
	var once sync.Once
	end := func() {
		once.Do(func() {
			close(stop)
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("Watch did not return after the stop")
			}
		})
	}
	t.Cleanup(end)
	return calls, end
}

func wantCall(t *testing.T, calls <-chan []model.AgentKind, want []model.AgentKind) {
	t.Helper()
	select {
	case got := <-calls:
		wantList(t, got, want)
	case <-time.After(5 * time.Second):
		t.Fatalf("changed was not called, want %v", want)
	}
}

func wantNoCall(t *testing.T, calls <-chan []model.AgentKind) {
	t.Helper()
	select {
	case got := <-calls:
		t.Fatalf("changed was called with %v without a change", got)
	case <-time.After(100 * time.Millisecond): // ten intervals
	}
}

func TestWatchCallsOncePerChange(t *testing.T) {
	t.Parallel()
	f := newFakeLook("claude")
	s := NewWith(testBins, f.look)
	calls, end := watch(t, s, 10*time.Millisecond)

	wantNoCall(t, calls) // the list at the start is not a change

	f.set("pi", true)
	wantCall(t, calls, kinds(model.Claude, model.Pi))
	wantNoCall(t, calls)
	wantList(t, s.List(), kinds(model.Claude, model.Pi))

	f.set("claude", false)
	wantCall(t, calls, kinds(model.Pi))
	wantNoCall(t, calls)

	f.set("pi", false)
	wantCall(t, calls, kinds())
	wantNoCall(t, calls)

	end()
	f.set("agent", true)
	wantNoCall(t, calls) // stopped: nobody looks
	wantList(t, s.List(), kinds())
}

func TestRefreshWakesWatch(t *testing.T) {
	t.Parallel()
	f := newFakeLook("claude")
	s := NewWith(testBins, f.look)
	// The interval never comes in this test: only a wake can make Watch call.
	calls, _ := watch(t, s, time.Hour)

	// Refresh and Check return before changed runs: they never call it themselves. The callback
	// here would block for ever if they did, since nobody reads calls until they have returned.
	f.set("agent", true)
	refreshed := make(chan []model.AgentKind)
	go func() { refreshed <- s.Refresh() }()
	select {
	case l := <-refreshed:
		wantList(t, l, kinds(model.Claude, model.Cursor))
	case <-time.After(5 * time.Second):
		t.Fatal("Refresh did not return")
	}
	wantCall(t, calls, kinds(model.Claude, model.Cursor))

	// A Refresh that finds no change wakes nobody.
	s.Refresh()
	wantNoCall(t, calls)

	// Check looks too.
	f.set("claude", false)
	if err := s.Check(model.Claude); !errors.Is(err, ErrMissing) {
		t.Fatalf("Check(claude) = %v, want ErrMissing", err)
	}
	wantCall(t, calls, kinds(model.Cursor))
	wantNoCall(t, calls)
}

func TestWatchReportsAChangeMadeBeforeItStarted(t *testing.T) {
	t.Parallel()
	f := newFakeLook("claude")
	s := NewWith(testBins, f.look)
	f.set("pi", true)
	s.Refresh()
	calls, _ := watch(t, s, time.Hour)
	wantCall(t, calls, kinds(model.Claude, model.Pi))
	wantNoCall(t, calls)
}

func TestRefreshNeverCallsChanged(t *testing.T) {
	t.Parallel()
	f := newFakeLook()
	s := NewWith(testBins, f.look)

	// changed blocks on a lock that the caller of Refresh and Check holds, as a broadcast under a
	// chat's lock would.
	var held sync.Mutex
	got := make(chan []model.AgentKind, 4)
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		s.Watch(time.Hour, stop, func(l []model.AgentKind) {
			held.Lock()
			defer held.Unlock()
			got <- l
		})
		close(done)
	}()
	defer func() { close(stop); <-done }()

	held.Lock()
	f.set("pi", true)
	wantList(t, s.Refresh(), kinds(model.Pi))
	f.set("claude", true)
	if err := s.Check(model.Claude); err != nil {
		t.Fatalf("Check(claude) = %v, want nil", err)
	}
	held.Unlock()

	// Two changes, both before changed could run: one call or two, the last with the newest list.
	want := kinds(model.Claude, model.Pi)
	select {
	case l := <-got:
		if !slices.Equal(l, want) {
			wantList(t, l, kinds(model.Pi))
			wantCall(t, got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("changed was not called")
	}
	wantNoCall(t, got)
}

func TestConcurrentUse(t *testing.T) {
	t.Parallel()
	f := newFakeLook("claude")
	s := NewWith(testBins, f.look)

	var mu sync.Mutex
	var last []model.AgentKind
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		s.Watch(time.Millisecond, stop, func(l []model.AgentKind) {
			mu.Lock()
			defer mu.Unlock()
			last = l
		})
		close(done)
	}()

	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range 200 {
				f.set("pi", (i+j)%2 == 0)
				s.Refresh()
				s.List()
				s.Has(model.Pi)
				s.First()
				_ = s.Check(model.Claude)
			}
		}()
	}
	wg.Wait()

	// After the last change the last call carries the newest list.
	f.set("pi", false)
	s.Refresh()
	f.set("pi", true)
	want := kinds(model.Claude, model.Pi)
	wantList(t, s.Refresh(), want)
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		l := last
		mu.Unlock()
		if slices.Equal(l, want) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the last call had %v, want %v", l, want)
		}
		time.Sleep(time.Millisecond)
	}
	close(stop)
	<-done
}
