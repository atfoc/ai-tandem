// Package usable keeps the list of the agents a server can use: the kinds whose programs it finds.
// The list is looked up at the start, before an agent is used (Check) and every so often (Watch),
// so an agent installed or removed while the server runs is noticed.
package usable

import (
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"sync"
	"time"

	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
)

// Every is how often the server looks again for the agents' programs.
const Every = 30 * time.Second

var (
	// ErrMissing is what a *MissingError is to errors.Is.
	ErrMissing = errors.New("the agent's program was not found")
	ErrNone    = errors.New("no agent can be used on this server: none of the programs of Claude Code, Cursor and pi was found")
	// ErrUnchosen is Check's answer for a == "" while some agent can be used: the chat has no
	// agent and one can be chosen. errors.Is(ErrUnchosen, ErrNone) is true, so a caller that tests
	// for ErrNone (status 409, code no_agent) keeps working; only the text differs.
	ErrUnchosen error = unchosenError{}
)

type unchosenError struct{}

func (unchosenError) Error() string {
	return "no agent is chosen: choose one of the agents this server can use"
}

func (unchosenError) Is(target error) bool { return target == ErrNone }

// MissingError says that the program of one agent was not found. Bin is the program as configured.
type MissingError struct {
	Agent model.AgentKind
	Bin   string
}

func (e *MissingError) Error() string {
	if e.Bin == "" {
		return fmt.Sprintf("%s's program was not found on this server: install it, or choose another agent", name(e.Agent))
	}
	return fmt.Sprintf("%s's program (%q) was not found on this server: install it, or choose another agent", name(e.Agent), e.Bin)
}

func (e *MissingError) Is(target error) bool { return target == ErrMissing }

// UnusableError says that the Claude account of kind Agent cannot be used now. Its text is Err's,
// the reason the person reads (Extra.Check: "Not logged in", Docker's reason, "This account was
// removed"); errors.Is and errors.As see through it to Err. It is ErrMissing to errors.Is too, so
// a caller that treats a missing agent's program as "this agent cannot start now" (status 409,
// the message stays in the box) treats an unusable account the same; a caller that tells the
// reasons apart (the account's refusals, their codes) asks of Err first.
type UnusableError struct {
	Agent model.AgentKind
	Err   error
}

func (e *UnusableError) Error() string { return e.Err.Error() }

func (e *UnusableError) Unwrap() error { return e.Err }

func (e *UnusableError) Is(target error) bool { return target == ErrMissing }

// errNoAccounts is the reason of an account kind on a Set that has no Extra: no account is known.
var errNoAccounts = errors.New("This account was removed")

func name(a model.AgentKind) string {
	switch a {
	case model.Claude:
		return "Claude Code"
	case model.Cursor:
		return "Cursor"
	case model.Pi:
		return "pi"
	}
	return string(a)
}

// Set is the list of usable agents of one server. A nil *Set means "no look-up configured":
// every kind is usable.
type Set struct {
	bins map[model.AgentKind]string
	look func(string) (string, error)

	lookMu sync.Mutex // serialises look-ups, so that the stored list is always the newest one

	extra Extra // the Claude accounts; nil = none. Set by SetExtra, read under lookMu or mu

	mu   sync.Mutex
	list []model.AgentKind // defaults.AgentOrder's usable kinds, then the usable account kinds; never nil
	gen  int               // counts the changes of list
	wake chan struct{}     // tells Watch that list changed
}

// New makes a set that finds programs as the agents' start does (exec.LookPath: a name on PATH,
// or a path). bins gives each kind's program; a kind with no program is not usable. It looks once.
func New(bins map[model.AgentKind]string) *Set { return NewWith(bins, exec.LookPath) }

// NewWith is New with the look-up given: look returns an error for a program that is not there.
func NewWith(bins map[model.AgentKind]string, look func(string) (string, error)) *Set {
	s := &Set{bins: map[model.AgentKind]string{}, look: look, wake: make(chan struct{}, 1)}
	for a, bin := range bins {
		s.bins[a] = bin
	}
	s.list = s.find()
	return s
}

// SetExtra makes x the source of the Set's account kinds (nil: none) and looks again at once. It
// always counts as a change Watch reports, even when the list stays the same: the accounts and
// their names (Accounts, Name) are x's from now on. x's methods are called by List's look-ups
// (Refresh, Check, Watch, SetExtra) with the Set's look-up lock held: they must never call back
// into the Set, and whoever calls Refresh or Check must not hold a lock x's methods take.
func (s *Set) SetExtra(x Extra) {
	if s == nil {
		return
	}
	s.lookMu.Lock()
	defer s.lookMu.Unlock()
	s.mu.Lock()
	s.extra = x
	s.mu.Unlock()
	list := s.find()

	s.mu.Lock()
	defer s.mu.Unlock()
	s.list = list
	s.gen++
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// find looks the fixed kinds' programs up, then asks the Extra which account kinds can be used.
// lookMu held.
func (s *Set) find() []model.AgentKind {
	list := []model.AgentKind{}
	for _, a := range defaults.AgentOrder {
		bin := s.bins[a]
		if bin == "" {
			continue
		}
		if _, err := s.look(bin); err == nil {
			list = append(list, a)
		}
	}
	if s.extra != nil {
		for _, a := range s.extra.Kinds() {
			if model.IsAlias(a) && !slices.Contains(list, a) && s.extra.Check(a) == nil {
				list = append(list, a)
			}
		}
	}
	return list
}

// Accounts is every Claude account's kind, usable or not, in the order the accounts were added
// (Extra.Kinds); none without an Extra. It is never nil.
func (s *Set) Accounts() []model.AgentKind {
	if s == nil {
		return []model.AgentKind{}
	}
	s.mu.Lock()
	x := s.extra
	s.mu.Unlock()
	if x == nil {
		return []model.AgentKind{}
	}
	out := []model.AgentKind{}
	for _, a := range x.Kinds() {
		if model.IsAlias(a) {
			out = append(out, a)
		}
	}
	return out
}

// List returns the usable agents as last looked up: the fixed kinds in defaults.AgentOrder, then
// the usable Claude accounts in the order they were added. It is never nil.
func (s *Set) List() []model.AgentKind {
	if s == nil {
		return slices.Clone(defaults.AgentOrder)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.list)
}

// Has reports whether a was usable at the last look-up.
func (s *Set) Has(a model.AgentKind) bool {
	if s == nil {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Contains(s.list, a)
}

// First returns the first usable agent of the fixed order, "" when there is none.
func (s *Set) First() model.AgentKind {
	if l := s.List(); len(l) > 0 {
		return l[0]
	}
	return ""
}

// Refresh looks now and returns the list. On a change it stores the list and wakes Watch; it never
// calls Watch's changed itself, so it is safe to call with locks held.
func (s *Set) Refresh() []model.AgentKind {
	if s == nil {
		return slices.Clone(defaults.AgentOrder)
	}
	s.lookMu.Lock()
	defer s.lookMu.Unlock()
	list := s.find()

	s.mu.Lock()
	defer s.mu.Unlock()
	if !slices.Equal(list, s.list) {
		s.list = list
		s.gen++
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
	return slices.Clone(s.list)
}

// Check looks now and says whether a can be used: nil, a *MissingError (a fixed kind whose
// program is not found), an *UnusableError (a Claude account that cannot be used now, with
// Extra.Check's reason), or for a == "" (a chat that has no agent, because none was usable when
// it was made) ErrNone while none is usable and ErrUnchosen once one is.
func (s *Set) Check(a model.AgentKind) error {
	if s == nil {
		return nil
	}
	list := s.Refresh()
	if a == "" {
		if len(list) == 0 {
			return ErrNone
		}
		return ErrUnchosen
	}
	if slices.Contains(list, a) {
		return nil
	}
	if model.IsAlias(a) {
		s.mu.Lock()
		x := s.extra
		s.mu.Unlock()
		why := errNoAccounts
		if x != nil {
			if why = x.Check(a); why == nil {
				return nil // usable since the look-up just made
			}
		}
		return &UnusableError{Agent: a, Err: why}
	}
	return &MissingError{Agent: a, Bin: s.bins[a]}
}

// Watch blocks until stop is closed. It looks every `every` and calls changed with the newest list
// after each change of the list, whoever found it (its own look, Refresh or Check). changed is
// called from Watch's goroutine only, with no lock held. A change made between New and the start of
// Watch counts: it is reported at once.
func (s *Set) Watch(every time.Duration, stop <-chan struct{}, changed func([]model.AgentKind)) {
	if s == nil {
		<-stop
		return
	}
	t := time.NewTicker(every)
	defer t.Stop()
	seen := 0 // the list New found
	for {
		s.mu.Lock()
		gen, list := s.gen, slices.Clone(s.list)
		s.mu.Unlock()
		if gen != seen {
			seen = gen
			changed(list)
		}
		select {
		case <-stop:
			return
		case <-t.C:
			s.Refresh()
		case <-s.wake:
		}
	}
}

// Name is the name the person reads for the agent kind a: "Claude Code", "Cursor", "pi", or a
// Claude account's own name ("Claude · Work", Extra.Name). An account kind no Extra names (a
// removed account, or a nil *Set) is named by its kind.
func (s *Set) Name(a model.AgentKind) string {
	if s != nil && model.IsAlias(a) {
		s.mu.Lock()
		x := s.extra
		s.mu.Unlock()
		if x != nil {
			if n := x.Name(a); n != "" {
				return n
			}
		}
	}
	return name(a)
}
