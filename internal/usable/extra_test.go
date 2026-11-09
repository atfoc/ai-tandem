package usable

import (
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

var (
	work = model.AliasKind("a_00000001")
	home = model.AliasKind("a_00000002")
	team = model.AliasKind("a_00000003")
)

// fakeExtra is an Extra whose accounts a test adds, removes, names and refuses.
type fakeExtra struct {
	mu    sync.Mutex
	kinds []model.AgentKind
	why   map[model.AgentKind]error
	names map[model.AgentKind]string
}

func newFakeExtra(kinds ...model.AgentKind) *fakeExtra {
	x := &fakeExtra{why: map[model.AgentKind]error{}, names: map[model.AgentKind]string{}}
	for i, a := range kinds {
		x.kinds = append(x.kinds, a)
		x.names[a] = fmt.Sprintf("Claude · %d", i+1)
	}
	return x
}

// refuse makes a unusable for why; nil makes it usable again.
func (x *fakeExtra) refuse(a model.AgentKind, why error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.why[a] = why
}

func (x *fakeExtra) setKinds(kinds ...model.AgentKind) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.kinds = append([]model.AgentKind{}, kinds...)
}

func (x *fakeExtra) rename(a model.AgentKind, name string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.names[a] = name
}

func (x *fakeExtra) Kinds() []model.AgentKind {
	x.mu.Lock()
	defer x.mu.Unlock()
	return append([]model.AgentKind{}, x.kinds...)
}

func (x *fakeExtra) Check(a model.AgentKind) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	for _, k := range x.kinds {
		if k == a {
			return x.why[a]
		}
	}
	return errRemoved
}

func (x *fakeExtra) Name(a model.AgentKind) string {
	x.mu.Lock()
	defer x.mu.Unlock()
	for _, k := range x.kinds {
		if k == a {
			return x.names[a]
		}
	}
	return ""
}

// errRemoved stands for aliases.ErrRemoved, a sentinel reason a caller tells apart.
var errRemoved = errors.New("This account was removed")

func TestAccountsComeAfterTheFixedKinds(t *testing.T) {
	t.Parallel()
	f := newFakeLook("claude", "pi")
	s := NewWith(testBins, f.look)
	x := newFakeExtra(home, work, team) // an order that is not the ids'
	x.refuse(work, errors.New("Not logged in"))
	s.SetExtra(x)

	wantList(t, s.List(), kinds(model.Claude, model.Pi, home, team))
	wantList(t, s.Accounts(), kinds(home, work, team)) // the unusable one too
	if !s.Has(home) || s.Has(work) || s.First() != model.Claude {
		t.Fatalf("Has(home) = %v, Has(work) = %v, First = %q", s.Has(home), s.Has(work), s.First())
	}

	// The account becomes usable: it takes its place in the accounts' order at the next look-up.
	x.refuse(work, nil)
	wantList(t, s.List(), kinds(model.Claude, model.Pi, home, team))
	wantList(t, s.Refresh(), kinds(model.Claude, model.Pi, home, work, team))

	// No fixed kind is usable: the accounts alone, and First is the first of them.
	f.set("claude", false)
	f.set("pi", false)
	wantList(t, s.Refresh(), kinds(home, work, team))
	if s.First() != home {
		t.Fatalf("First = %q, want the first account", s.First())
	}

	// A kind of Extra's that is no account's (Claude's own, a fixed kind, garbage) is left out.
	x.setKinds(model.Claude, work, "claude:nope", model.Pi)
	wantList(t, s.Refresh(), kinds(work))
	wantList(t, s.Accounts(), kinds(work))

	// No Extra: no account.
	s.SetExtra(nil)
	wantList(t, s.List(), kinds())
	wantList(t, s.Accounts(), kinds())
	var none *Set
	wantList(t, none.Accounts(), kinds())
}

func TestCheckAccount(t *testing.T) {
	t.Parallel()
	s := NewWith(testBins, newFakeLook("claude").look)
	x := newFakeExtra(work, home)
	notLoggedIn := errors.New("Not logged in")
	x.refuse(home, notLoggedIn)
	s.SetExtra(x)

	if err := s.Check(work); err != nil {
		t.Fatalf("Check(work) = %v, want nil", err)
	}

	err := s.Check(home)
	var ue *UnusableError
	if !errors.As(err, &ue) || ue.Agent != home {
		t.Fatalf("Check(home) = %#v, want an UnusableError for home", err)
	}
	if err.Error() != "Not logged in" {
		t.Fatalf("Check(home) text = %q, want the reason's", err.Error())
	}
	if !errors.Is(err, ErrMissing) || !errors.Is(err, notLoggedIn) || errors.Is(err, ErrNone) {
		t.Fatalf("Check(home) = %v: Is(ErrMissing) = %v, Is(reason) = %v, Is(ErrNone) = %v",
			err, errors.Is(err, ErrMissing), errors.Is(err, notLoggedIn), errors.Is(err, ErrNone))
	}
	if errors.As(err, new(*MissingError)) {
		t.Fatal("an account's refusal is a MissingError")
	}

	// A removed account: Extra's own reason, which errors.Is sees through the UnusableError.
	gone := model.AliasKind("a_0000000z")
	err = s.Check(gone)
	if !errors.As(err, &ue) || ue.Agent != gone || !errors.Is(err, errRemoved) || !errors.Is(err, ErrMissing) {
		t.Fatalf("Check(removed) = %#v", err)
	}

	// An account that turns usable is usable at once: Check looks again.
	x.refuse(home, nil)
	if err := s.Check(home); err != nil {
		t.Fatalf("Check(home) once usable = %v", err)
	}
	if !s.Has(home) {
		t.Fatal("Check did not store the list it looked up")
	}
}

func TestCheckAccountWithoutExtra(t *testing.T) {
	t.Parallel()
	s := NewWith(testBins, newFakeLook("claude").look)
	err := s.Check(work)
	var ue *UnusableError
	if !errors.As(err, &ue) || ue.Agent != work || !errors.Is(err, ErrMissing) {
		t.Fatalf("Check(work) with no Extra = %#v, want an UnusableError", err)
	}
	if err.Error() != "This account was removed" {
		t.Fatalf("Check(work) text = %q", err.Error())
	}
}

func TestNameOfAccounts(t *testing.T) {
	t.Parallel()
	s := NewWith(testBins, newFakeLook().look)
	unknown := model.AliasKind("a_0000000z")
	fixed := map[model.AgentKind]string{model.Claude: "Claude Code", model.Cursor: "Cursor", model.Pi: "pi"}

	check := func(what string) {
		t.Helper()
		for a, want := range fixed {
			if got := s.Name(a); got != want {
				t.Errorf("%s: Name(%s) = %q, want %q", what, a, got, want)
			}
		}
	}
	check("no Extra")
	if got := s.Name(work); got != string(work) {
		t.Errorf("no Extra: Name(work) = %q, want its kind", got)
	}

	x := newFakeExtra(work)
	x.rename(work, "Claude · Work")
	s.SetExtra(x)
	check("with Extra")
	if got := s.Name(work); got != "Claude · Work" {
		t.Errorf("Name(work) = %q", got)
	}
	if got := s.Name(unknown); got != string(unknown) {
		t.Errorf("Name(unknown account) = %q, want its kind", got)
	}
	// A name is read when asked, with no look-up needed.
	x.rename(work, "Claude · Job")
	if got := s.Name(work); got != "Claude · Job" {
		t.Errorf("Name(work) after a rename = %q", got)
	}
	var none *Set
	if got := none.Name(work); got != string(work) {
		t.Errorf("nil set: Name(work) = %q", got)
	}
}

func TestWatchSeesAccountChanges(t *testing.T) {
	t.Parallel()
	s := NewWith(testBins, newFakeLook("claude").look)
	x := newFakeExtra(work, home)
	calls, _ := watch(t, s, time.Hour) // only a wake makes Watch call
	wantNoCall(t, calls)

	s.SetExtra(x)
	wantCall(t, calls, kinds(model.Claude, work, home))
	wantNoCall(t, calls)

	// Whoever changes the Extra's answer calls Refresh.
	x.refuse(home, errors.New("Docker is not running"))
	wantNoCall(t, calls) // nobody looked yet
	s.Refresh()
	wantCall(t, calls, kinds(model.Claude, work))
	wantNoCall(t, calls)

	x.setKinds(home)
	s.Refresh()
	wantCall(t, calls, kinds(model.Claude))

	// SetExtra counts as a change even when the list stays the same: the names are the new
	// Extra's.
	y := newFakeExtra(team)
	y.refuse(team, errors.New("Not logged in"))
	s.SetExtra(y)
	wantCall(t, calls, kinds(model.Claude))
	wantNoCall(t, calls)
}

func TestWatchLooksAtAccountsOnItsTick(t *testing.T) {
	t.Parallel()
	s := NewWith(testBins, newFakeLook("claude").look)
	x := newFakeExtra(work)
	x.refuse(work, errors.New("Not logged in"))
	s.SetExtra(x) // before Watch: reported at once
	calls, _ := watch(t, s, 10*time.Millisecond)
	wantCall(t, calls, kinds(model.Claude))
	wantNoCall(t, calls)

	x.refuse(work, nil) // nobody calls Refresh: Watch's own look finds it
	wantCall(t, calls, kinds(model.Claude, work))
	wantNoCall(t, calls)
}

func TestSetWithAccountsUnderRace(t *testing.T) {
	t.Parallel()
	f := newFakeLook("claude", "pi")
	s := NewWith(testBins, f.look)
	x, y := newFakeExtra(work, home), newFakeExtra(team)
	s.SetExtra(x)

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		s.Watch(time.Millisecond, stop, func([]model.AgentKind) {})
		close(done)
	}()

	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range 200 {
				switch (i + j) % 7 {
				case 0:
					s.Refresh()
				case 1:
					_ = s.Check(work)
				case 2:
					_ = s.List()
				case 3:
					_ = s.Name(home)
				case 4:
					if j%2 == 0 {
						s.SetExtra(y)
					} else {
						s.SetExtra(x)
					}
				case 5:
					x.refuse(home, errors.New("Not logged in"))
					_ = s.Accounts()
				case 6:
					x.refuse(home, nil)
					_ = s.Has(home)
					f.set("pi", j%3 == 0)
				}
			}
		}()
	}
	wg.Wait()
	close(stop)
	<-done
}
