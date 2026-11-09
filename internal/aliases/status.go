package aliases

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"ai-whiteboard/internal/container"
)

// What the accounts look like to the clients (List), and the cache behind it: each container's
// state from the last inspect or op, each login from the last auth status, the host's login.
// List never waits on Docker or Claude: a stale cache is refreshed in the background, and the
// fresh List goes out as an "aliases" event when it differs.

// List is the accounts as every client sees them (GET /api/aliases, the snapshot). It answers
// from the cache; when the cache is older than Waits.Stale it also starts a refresh (one at a
// time), whose result is broadcast when it changes the List.
func (s *Service) List() List {
	l := s.list()
	s.mu.Lock()
	stale := !s.closed && !s.refreshing && time.Since(s.checked) > s.waits.Stale
	if stale {
		s.refreshing = true
	}
	s.mu.Unlock()
	if stale {
		before, _ := json.Marshal(l)
		s.goBg(func() {
			defer func() {
				s.mu.Lock()
				s.refreshing = false
				s.mu.Unlock()
			}()
			s.refresh(true)
			after, _ := json.Marshal(s.list())
			if !bytes.Equal(before, after) {
				s.changed()
			}
		})
		// goBg does nothing after Shutdown: then nobody clears refreshing, which is fine.
	}
	return l
}

// list is List without the refresh. It takes mu only to copy the cache.
func (s *Service) list() List {
	avail := s.cont.Available()
	records := s.store.List()
	s.mu.Lock()
	host := s.host
	s.mu.Unlock()
	views := s.views(records, avail)
	return List{Docker: dockerState(avail), DefaultImage: container.DefaultImage(), Host: host, Aliases: views}
}

// view is the account id as List shows it; false when there is no such account.
func (s *Service) view(id string) (View, bool) {
	a, ok := s.store.Get(id)
	if !ok {
		return View{}, false
	}
	return s.views([]Alias{a}, s.cont.Available())[0], true
}

// dockerState is Docker's state of the answer of Available.
func dockerState(avail error) DockerState {
	if avail == nil {
		return DockerState{OK: true}
	}
	if u, ok := container.IsUnavailable(avail); ok {
		return DockerState{Kind: u.Kind, Reason: u.Reason}
	}
	return DockerState{Kind: container.Failed, Reason: avail.Error()}
}

// cached is a copy of what the runtime entry of one account holds for its view.
type cached struct {
	state container.State
	err   string
	login Login
}

// views are the records as List shows them; never nil. Building, Busy and the login run's state
// are asked with no lock held.
func (s *Service) views(records []Alias, avail error) []View {
	docker := dockerState(avail)
	caches := make([]cached, len(records))
	s.mu.Lock()
	for i, a := range records {
		r := s.rt[a.ID]
		caches[i].login = loginOf(a, r)
		if r != nil {
			caches[i].state, caches[i].err = r.state, r.err
		}
	}
	s.mu.Unlock()

	out := make([]View, 0, len(records))
	for i, a := range records {
		c := caches[i]
		v := View{Alias: a, Kind: a.Kind(), Login: c.login, Pending: []string{}}
		v.Alias.LastLogin = nil
		if v.Mounts == nil {
			v.Mounts = []string{}
		}
		v.Login.InFlight = s.loginInFlight(a.ID)
		v.Container = ContainerView{Name: container.Name(a.ID)}
		switch {
		case avail != nil:
			v.Container.State, v.Container.Reason = ContainerUnavailable, docker.Reason
		case c.state != container.StateRunning && s.cont.Building(a.EffectiveImage()):
			v.Container.State = ContainerPreparing
		case c.err != "":
			v.Container.State, v.Container.Reason = ContainerError, c.err
		case c.state == container.StateRunning:
			v.Container.State = ContainerRunning
		case c.state == container.StateStopped:
			v.Container.State = ContainerStopped
		default:
			v.Container.State = ContainerNone
		}
		if v.Container.State == ContainerRunning && a.SpecDiffers() {
			v.RestartNeeded = true
			if p := a.Pending(); p != nil {
				v.Pending = p
			}
		}
		v.Busy = s.busy(a.Kind())
		out = append(out, v)
	}
	return out
}

// loginOf is the account's login as known: the last auth status of this run, else the one kept
// in the record (LastLogin), else not known. r may be nil. InFlight is left false.
func loginOf(a Alias, r *entry) Login {
	if r != nil && r.login != nil {
		l := *r.login
		l.InFlight = false
		return l
	}
	if a.LastLogin != nil {
		return Login{Known: true, LoggedIn: a.LastLogin.LoggedIn, Email: a.LastLogin.Email}
	}
	return Login{}
}

// refresh inspects every account's container and, withLogins, asks the auth status of every
// running one and of the host (no container is started just to ask, D22). The containers are
// looked at only while Docker is available. A container seen running for the first time in this
// run goes Ready (and has its login asked when withLogins is false).
func (s *Service) refresh(withLogins bool) {
	records := s.store.List()
	var running []string
	if s.cont.Available() == nil {
		var mu sync.Mutex
		var wg sync.WaitGroup
		for _, a := range records {
			wg.Add(1)
			go func() {
				defer wg.Done()
				// The op lock is waited for no longer than an inspect: an account that is being
				// changed is looked at by the next refresh.
				ctx, cancel := context.WithTimeout(s.base, container.QuickTimeout)
				defer cancel()
				unlock, err := s.lockOpCtx(ctx, a.ID)
				if err != nil {
					return
				}
				info, err := s.inspect(ctx, a.ID)
				unlock()
				if err != nil {
					if _, ok := container.IsUnavailable(err); !ok && s.base.Err() == nil {
						s.logf("accounts: inspect of %s: %v", container.Name(a.ID), err)
					}
					return
				}
				if info.State == container.StateRunning {
					mu.Lock()
					running = append(running, a.ID)
					mu.Unlock()
					s.noteRunning(a.ID, !withLogins)
				}
			}()
		}
		wg.Wait()
	}
	if !withLogins {
		return
	}
	var wg sync.WaitGroup
	for _, id := range running {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.refreshLogin(id)
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		s.refreshHost()
	}()
	wg.Wait()
	s.mu.Lock()
	s.checked = time.Now()
	s.mu.Unlock()
}

// refreshLogin asks the account's auth status (Waits.Status) and caches the answer. The record's
// LastLogin is written only when the answer differs from it. A failure keeps the last known
// login with the error's text. When runs overlap, the answer of the one asked last wins (an
// answer asked before a logout must not undo it). It does not broadcast.
func (s *Service) refreshLogin(id string) error {
	// Only in a container that runs (D22): one the person stopped meanwhile is not started again.
	c, err := s.claudeOf(id, ensureRunning)
	if err != nil {
		return err
	}
	s.mu.Lock()
	r := s.rtLocked(id)
	r.loginAsked++
	ticket := r.loginAsked
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(s.base, s.waits.Status)
	auth, err := c.AuthStatus(ctx)
	cancel()
	a, ok := s.store.Get(id)
	if !ok {
		return ErrNotFound
	}
	// keep caches l unless a run asked later has answered already; mu is held.
	keep := func(r *entry, l Login) bool {
		if ticket < r.loginKept {
			return false
		}
		r.loginKept, r.login = ticket, &l
		return true
	}
	if errors.Is(err, ErrStopped) {
		return nil // stopped since: its last known login stays, with no error
	}
	s.mu.Lock()
	r = s.rtLocked(id)
	if err != nil {
		l := loginOf(a, r)
		l.Error = err.Error()
		keep(r, l)
		s.mu.Unlock()
		if s.base.Err() == nil {
			s.logf("accounts: auth status of account %s: %v", id, err)
		}
		return err
	}
	kept := keep(r, Login{Known: true, LoggedIn: auth.LoggedIn, Email: auth.Email})
	s.mu.Unlock()
	if !kept {
		return nil
	}

	unlock := s.lockOp(id)
	defer unlock()
	s.mu.Lock()
	latest := s.rt[id] != nil && s.rt[id].loginKept == ticket
	s.mu.Unlock()
	a, ok = s.store.Get(id)
	if !ok || !latest {
		return nil
	}
	if a.LastLogin != nil && a.LastLogin.LoggedIn == auth.LoggedIn && a.LastLogin.Email == auth.Email {
		return nil
	}
	a.LastLogin = &LastLogin{LoggedIn: auth.LoggedIn, Email: auth.Email, Checked: time.Now().UTC()}
	if err := s.store.Put(a); err != nil {
		s.logf("accounts: %s: recording the login state: %v", id, err)
	}
	return nil
}

// refreshHost asks the computer's own Claude Code its auth status (Waits.Status), for the first
// row. A failure keeps the last known login with the error's text.
func (s *Service) refreshHost() {
	if s.o.Host == nil {
		return
	}
	ctx, cancel := context.WithTimeout(s.base, s.waits.Status)
	auth, err := s.o.Host.AuthStatus(ctx)
	cancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.host.Error = err.Error()
		return
	}
	s.host = Login{Known: true, LoggedIn: auth.LoggedIn, Email: auth.Email}
}
