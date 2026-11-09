package aliasestest

import (
	"context"
	"sync"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/claude"
)

var (
	_ aliases.Claude   = (*Claude)(nil)
	_ aliases.HostAuth = (*Claude)(nil)
	_ aliases.LoginRun = (*Login)(nil)
)

// Claude is a fake aliases.Claude for one account. It also serves as the host's
// aliases.HostAuth.
type Claude struct {
	mu          sync.Mutex
	auth        claude.Auth
	authErr     error
	statusCalls int
	logoutCalls int
	logoutErr   error
	url         string
	goodCode    string
	email       string
	startErr    error
	startBlock  chan struct{}
	logins      []*Login
}

// NewClaude returns a Claude that is logged out.
func NewClaude() *Claude {
	return &Claude{
		url:      "https://claude.ai/oauth/authorize?state=fake",
		goodCode: "good-code",
		email:    "work@example.com",
	}
}

// SetAuth sets what AuthStatus answers.
func (c *Claude) SetAuth(a claude.Auth, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.auth, c.authErr = a, err
}

// AuthStatus answers the SetAuth values and counts the call.
func (c *Claude) AuthStatus(ctx context.Context) (claude.Auth, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.statusCalls++
	return c.auth, c.authErr
}

// StatusCalls is how many times AuthStatus was called.
func (c *Claude) StatusCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.statusCalls
}

// Logout counts the call and logs out, or returns the FailLogout error.
func (c *Claude) Logout(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.logoutCalls++
	if c.logoutErr != nil {
		return c.logoutErr
	}
	c.auth, c.authErr = claude.Auth{}, nil
	return nil
}

// LogoutCalls is how many times Logout was called.
func (c *Claude) LogoutCalls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.logoutCalls
}

// FailLogout makes Logout fail with err, until FailLogout(nil).
func (c *Claude) FailLogout(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.logoutErr = err
}

// SetLogin sets the URL of later logins, the code they accept and the email it logs in.
func (c *Claude) SetLogin(url, goodCode, email string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.url, c.goodCode, c.email = url, goodCode, email
}

// FailStart makes StartLogin fail with err, until FailStart(nil).
func (c *Claude) FailStart(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.startErr = err
}

// BlockStart makes StartLogin wait until release is called (or its ctx ends). release may be
// called more than once.
func (c *Claude) BlockStart() (release func()) {
	ch := make(chan struct{})
	c.mu.Lock()
	c.startBlock = ch
	c.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			if c.startBlock == ch {
				c.startBlock = nil
			}
			c.mu.Unlock()
			close(ch)
		})
	}
}

// StartLogin starts a new fake login run, or returns the FailStart error.
func (c *Claude) StartLogin(ctx context.Context) (aliases.LoginRun, error) {
	c.mu.Lock()
	block := c.startBlock
	c.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.startErr != nil {
		return nil, c.startErr
	}
	l := &Login{c: c, url: c.url, goodCode: c.goodCode, email: c.email, done: make(chan struct{})}
	c.logins = append(c.logins, l)
	return l, nil
}

// Logins is every run StartLogin started, in order.
func (c *Claude) Logins() []*Login {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*Login(nil), c.logins...)
}

// Login is a fake aliases.LoginRun, made by Claude.StartLogin.
type Login struct {
	c        *Claude
	url      string
	goodCode string
	email    string

	mu        sync.Mutex
	done      chan struct{}
	ended     bool
	cancelled bool
	codes     []string
	delay     time.Duration
}

// URL is the SetLogin URL at the time the run started.
func (l *Login) URL() string { return l.url }

// Code tries code. The good code logs the Claude in and ends the run; another code is refused
// with "Invalid code"; after the run ended, the answer is failed.
func (l *Login) Code(ctx context.Context, code string) (claude.LoginResult, error) {
	l.mu.Lock()
	l.codes = append(l.codes, code)
	delay := l.delay
	l.mu.Unlock()
	if delay > 0 {
		t := time.NewTimer(delay)
		defer t.Stop()
		select {
		case <-t.C:
		case <-ctx.Done():
			return claude.LoginResult{}, ctx.Err()
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ended {
		return claude.LoginResult{State: claude.LoginFailed, Error: "The login has ended"}, nil
	}
	if code != l.goodCode {
		return claude.LoginResult{State: claude.LoginWaiting, Error: "Invalid code"}, nil
	}
	l.c.SetAuth(claude.Auth{LoggedIn: true, Email: l.email}, nil)
	l.endLocked()
	return claude.LoginResult{State: claude.LoginLoggedIn}, nil
}

func (l *Login) endLocked() {
	if !l.ended {
		l.ended = true
		close(l.done)
	}
}

// Cancel ends the run; Cancelled is then true. It may be called more than once.
func (l *Login) Cancel() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.ended {
		l.cancelled = true
	}
	l.endLocked()
}

// Done is closed once the run has ended.
func (l *Login) Done() <-chan struct{} { return l.done }

// Cancelled reports whether Cancel ended the run.
func (l *Login) Cancelled() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cancelled
}

// Codes is every code tried, in order.
func (l *Login) Codes() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.codes...)
}

// End ends the run by itself, as when Claude exits; it is not cancelled.
func (l *Login) End() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.endLocked()
}

// SetCodeDelay makes Code wait d before it answers.
func (l *Login) SetCodeDelay(d time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.delay = d
}

// Claudes makes and keeps one fake Claude per account id, for aliases.Options.Claude.
type Claudes struct {
	mu       sync.Mutex
	claudes  map[string]*Claude
	spawners map[string]*claude.Spawner
}

// NewClaudes returns an empty Claudes.
func NewClaudes() *Claudes {
	return &Claudes{claudes: map[string]*Claude{}, spawners: map[string]*claude.Spawner{}}
}

// For is the Claude of account id, made on first ask.
func (cs *Claudes) For(id string) *Claude {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	c := cs.claudes[id]
	if c == nil {
		c = NewClaude()
		cs.claudes[id] = c
	}
	return c
}

// Factory is a function for aliases.Options.Claude: it returns For(a.ID) and remembers sp.
func (cs *Claudes) Factory() func(a aliases.Alias, sp *claude.Spawner) aliases.Claude {
	return func(a aliases.Alias, sp *claude.Spawner) aliases.Claude {
		cs.mu.Lock()
		cs.spawners[a.ID] = sp
		cs.mu.Unlock()
		return cs.For(a.ID)
	}
}

// Spawner is the last spawner Factory was given for id; nil if none.
func (cs *Claudes) Spawner(id string) *claude.Spawner {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.spawners[id]
}
