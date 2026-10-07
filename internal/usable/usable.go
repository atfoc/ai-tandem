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
	// ErrUnchosen is Check's answer for a == "" while some agent can be used: the chat or run has no
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

	mu   sync.Mutex
	list []model.AgentKind // in defaults.AgentOrder, never nil
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
	return list
}

// List returns the usable agents as last looked up, in defaults.AgentOrder. It is never nil.
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

// Check looks now and says whether a can be used: nil, a *MissingError, or for a == "" (a chat or
// run that has no agent, because none was usable when it was made) ErrNone while none is usable
// and ErrUnchosen once one is.
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
	if !slices.Contains(list, a) {
		return &MissingError{Agent: a, Bin: s.bins[a]}
	}
	return nil
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
