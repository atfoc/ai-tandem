package aliases

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

// The login of an account (goal §3.6, D21, D29): one `claude auth login` run per account, in its
// container. A login session is opened by Login and lives in a goroutine of its own: it makes
// the container run (its image built, when need be), starts the run, waits for the URL, then
// waits for the run to end. Codes are handed to the run by LoginCode, one at a time. Cancel,
// the time limit (Waits.LoginLimit), a stop or a removal of the account and the server's
// shutdown end it.
//
// Nothing of the URL or of a code is logged or put in an event: Login's answer is the only place
// the URL appears, and List says only that a session is open (Login.InFlight).

// The sentences of a login's answers.
const (
	noLoginText     = "No login is open for this account; start it again"
	codeTimeoutText = "Claude did not answer in time; try again"
)

// Why a login session ended without a login.
var (
	errLoginCancelled = errors.New("The login was cancelled")
	errLoginTooLong   = errors.New("The login took too long; start it again")
	errLoginEnded     = errors.New("The login ended; start it again")
	errLoginFailed    = errors.New("The login failed; start it again")
	errShuttingDown   = errors.New("The server is shutting down")
)

// loginTick is how often a Login call that waits for the URL also looks whether the image is
// being built (Building has no signal of its own).
const loginTick = 50 * time.Millisecond

// loginSession is the open login of one account. Its fields but id, cancel and codeMu are
// guarded by the service's mu.
type loginSession struct {
	id     string
	cancel context.CancelFunc // ends the session's goroutine (its ensure, its StartLogin, its wait)

	run    LoginRun // nil until StartLogin has answered
	url    string   // the run's URL, once waiting
	ended  bool     // the session is over (and out of the service's map)
	final  LoginAnswer
	err    error         // with ended: the error Login returns as such (Docker, ErrNotFound), else nil
	notify chan struct{} // closed, then made anew, at each change of the session

	codeMu sync.Mutex // serializes the codes of the session
}

// wakeLocked tells the callers waiting on the session that it changed. mu is held.
func (ls *loginSession) wakeLocked() {
	close(ls.notify)
	ls.notify = make(chan struct{})
}

// Login starts the account's login run, or joins the one that is open, and answers its state:
// waiting with the URL; preparing while the container's image is built (the login goes on by
// itself: the client calls Login again later and joins it) or when the URL took longer than
// Waits.LoginStart; failed with the reason. Docker unavailable, and an account that is gone,
// are errors.
func (s *Service) Login(id string) (LoginAnswer, error) {
	a, err := s.account(id)
	if err != nil {
		return LoginAnswer{}, err
	}
	if err := s.cont.Available(); err != nil {
		return LoginAnswer{}, err
	}
	s.mu.Lock()
	ls := s.logins[id]
	opened := false
	if ls == nil {
		if s.closed {
			s.mu.Unlock()
			return LoginAnswer{}, errShuttingDown
		}
		ctx, cancel := context.WithCancel(s.base)
		ls = &loginSession{id: id, cancel: cancel, notify: make(chan struct{})}
		s.logins[id] = ls
		opened = true
		// Added under mu while not closed: Shutdown waits for it.
		s.bg.Add(1)
		go func() {
			defer s.bg.Done()
			s.runLogin(ctx, ls)
		}()
	}
	s.mu.Unlock()
	if opened {
		s.changed()
	}
	ans, err := s.awaitLogin(ls, a.EffectiveImage())
	if err == nil && ans.State == LoginPreparing {
		// The image build starts inside the session's ensure, after the broadcast above: the
		// list is sent again, so that every client shows the container preparing.
		s.changed()
	}
	return ans, err
}

// awaitLogin waits until the session has its URL or has ended, the account's image is being
// built, or Waits.LoginStart has passed, and answers its state then.
func (s *Service) awaitLogin(ls *loginSession, image string) (LoginAnswer, error) {
	limit := time.NewTimer(s.waits.LoginStart)
	defer limit.Stop()
	tick := time.NewTicker(loginTick)
	defer tick.Stop()
	for {
		s.mu.Lock()
		ended, final, err := ls.ended, ls.final, ls.err
		url, notify := ls.url, ls.notify
		s.mu.Unlock()
		switch {
		case ended && err != nil:
			return LoginAnswer{}, err
		case ended:
			return final, nil
		case url != "":
			return LoginAnswer{State: LoginWaiting, URL: url}, nil
		case s.cont.Building(image):
			return LoginAnswer{State: LoginPreparing}, nil
		}
		select {
		case <-notify:
		case <-tick.C:
		case <-limit.C:
			return LoginAnswer{State: LoginPreparing}, nil
		}
	}
}

// runLogin is the life of session ls, in a goroutine of its own: the container made to run
// (Waits.Prepare), the run started (Waits.LoginStart), then the wait for its end, which
// Waits.LoginLimit bounds. A session ended by a code, a cancel or the shutdown is left to them.
func (s *Service) runLogin(ctx context.Context, ls *loginSession) {
	defer ls.cancel()
	id := ls.id

	pctx, pcancel := context.WithTimeout(ctx, s.waits.Prepare)
	_, err := s.ensure(pctx, id, ensureFull)
	pcancel()
	if err != nil {
		s.failLogin(ls, err)
		return
	}
	if ctx.Err() != nil {
		// Cancelled, or the shutdown, while the container was made ready: no run is started.
		return
	}
	c, err := s.claudeOf(id, ensureFull)
	if err != nil {
		s.failLogin(ls, err)
		return
	}
	sctx, scancel := context.WithTimeout(ctx, s.waits.LoginStart)
	run, err := c.StartLogin(sctx)
	scancel()
	if err != nil {
		if ctx.Err() == nil {
			// Not err itself: what Claude printed may hold the URL.
			s.logf("accounts: the login of account %s could not start", id)
		}
		s.failLogin(ls, err)
		return
	}

	s.mu.Lock()
	if ls.ended {
		s.mu.Unlock()
		run.Cancel()
		return
	}
	ls.run, ls.url = run, run.URL()
	ls.wakeLocked()
	s.mu.Unlock()

	limit := time.NewTimer(s.waits.LoginLimit)
	defer limit.Stop()
	why := errLoginEnded
	select {
	case <-run.Done():
	case <-ctx.Done():
		// Cancelled, or the shutdown: whoever did it ended the session.
		run.Cancel()
		return
	case <-limit.C:
		run.Cancel()
		why = errLoginTooLong
	}
	if !s.endLogin(ls, LoginAnswer{State: LoginFailed, Error: why.Error()}, nil) {
		return
	}
	s.refreshLogin(id)
	s.changed()
}

// failLogin ends session ls with err, unless it ended already, and broadcasts. Docker
// unavailable and a gone account are kept as errors for Login; any other error is a failed
// answer with its text.
func (s *Service) failLogin(ls *loginSession, err error) {
	var asErr error
	if _, unavailable := container.IsUnavailable(err); unavailable || errors.Is(err, ErrNotFound) || errors.Is(err, ErrRemoved) {
		asErr = err
	}
	if s.endLogin(ls, LoginAnswer{State: LoginFailed, Error: err.Error()}, asErr) {
		s.changed()
	}
}

// endLogin ends session ls with the answer final (and err, for Login), and takes it out of the
// service's map; false when it had ended already. It does not stop the goroutine nor the run.
func (s *Service) endLogin(ls *loginSession, final LoginAnswer, err error) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.endLoginLocked(ls, final, err)
}

// endLoginLocked is endLogin with mu held.
func (s *Service) endLoginLocked(ls *loginSession, final LoginAnswer, err error) bool {
	if ls.ended {
		return false
	}
	ls.ended, ls.final, ls.err = true, final, err
	if s.logins[ls.id] == ls {
		delete(s.logins, ls.id)
	}
	ls.wakeLocked()
	return true
}

// LoginCode hands code to the account's login run and answers what Claude did with it: logged
// in (with the email auth status gives), waiting (Claude refused the code, or did not answer in
// Waits.Code: another may be tried), or failed (the run ended without a login). With no run
// waiting for a code it answers failed with noLoginText.
func (s *Service) LoginCode(id, code string) (LoginAnswer, error) {
	if _, err := s.account(id); err != nil {
		return LoginAnswer{}, err
	}
	s.mu.Lock()
	ls := s.logins[id]
	s.mu.Unlock()
	if ls == nil {
		return LoginAnswer{State: LoginFailed, Error: noLoginText}, nil
	}
	ls.codeMu.Lock()
	defer ls.codeMu.Unlock()

	s.mu.Lock()
	run, url, ended, final := ls.run, ls.url, ls.ended, ls.final
	s.mu.Unlock()
	switch {
	case ended && final.State == LoginLoggedIn:
		// A code sent twice: the first one logged in.
		return final, nil
	case ended, run == nil:
		return LoginAnswer{State: LoginFailed, Error: noLoginText}, nil
	}

	ctx, cancel := context.WithTimeout(s.base, s.waits.Code)
	res, err := run.Code(ctx, strings.TrimSpace(code))
	cancel()
	if err != nil {
		s.mu.Lock()
		ended = ls.ended
		s.mu.Unlock()
		if ended {
			return LoginAnswer{State: LoginFailed, Error: noLoginText}, nil
		}
		return LoginAnswer{State: LoginWaiting, URL: url, Error: codeTimeoutText}, nil
	}

	switch res.State {
	case claude.LoginWaiting:
		return LoginAnswer{State: LoginWaiting, URL: url, Error: res.Error}, nil
	case claude.LoginLoggedIn:
		// Ended by Claude: a cancel that came while it took the code changes nothing of that.
		s.endLogin(ls, LoginAnswer{State: LoginLoggedIn}, nil)
		s.refreshLogin(id)
		s.mu.Lock()
		email := ""
		if r := s.rt[id]; r != nil && r.login != nil {
			email = r.login.Email
		}
		ls.final.Email = email
		s.mu.Unlock()
		if s.o.Ready != nil {
			kind := model.AliasKind(id)
			s.goBg(func() { s.o.Ready(kind) })
		}
		s.changed()
		return LoginAnswer{State: LoginLoggedIn, Email: email}, nil
	default:
		msg := res.Error
		if msg == "" {
			msg = errLoginFailed.Error()
		}
		ans := LoginAnswer{State: LoginFailed, Error: msg}
		ended := s.endLogin(ls, ans, nil)
		ls.cancel()
		run.Cancel()
		if ended {
			s.refreshLogin(id)
			s.changed()
		}
		return ans, nil
	}
}

// CancelLogin ends the account's login run, if one is open; the login is left as it was.
func (s *Service) CancelLogin(id string) error {
	if _, err := s.account(id); err != nil {
		return err
	}
	if s.cancelLogin(id) {
		s.changed()
	}
	return nil
}

// loginInFlight reports whether a login session of account id is open.
func (s *Service) loginInFlight(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.logins[id] != nil
}

// cancelLogin ends the login session of account id, if one is open, and reports whether one
// was. It does not broadcast.
func (s *Service) cancelLogin(id string) bool {
	s.mu.Lock()
	ls := s.logins[id]
	var run LoginRun
	if ls != nil {
		s.endLoginLocked(ls, LoginAnswer{State: LoginFailed, Error: errLoginCancelled.Error()}, nil)
		run = ls.run
	}
	s.mu.Unlock()
	if ls == nil {
		return false
	}
	ls.cancel()
	if run != nil {
		run.Cancel()
	}
	return true
}

// endLogins ends every login session (the server's shutdown). It does not broadcast.
func (s *Service) endLogins() {
	s.mu.Lock()
	var ids []string
	for id := range s.logins {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.cancelLogin(id)
	}
}
