package aliases_test

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/aliases/aliasestest"
	"ai-whiteboard/internal/container"
	"ai-whiteboard/internal/model"
)

// The fake Claude's login: what NewClaude sets.
const (
	fakeURL   = "https://claude.ai/oauth/authorize?state=fake"
	goodCode  = "good-code"
	fakeEmail = "work@example.com"
)

// noLogin is the answer of a code with no login open.
var noLogin = aliases.LoginAnswer{State: aliases.LoginFailed, Error: "No login is open for this account; start it again"}

// loginEnv is a service on fakes with one account, Work, and the account's fake Claude.
func loginEnv(t *testing.T, edit ...func(o *aliases.Options)) (*env, aliases.View, *aliasestest.Claude) {
	t.Helper()
	e := newSvc(t, edit...)
	v := e.add("Work", e.folder())
	return e, v, e.claudes.For(v.ID)
}

// login calls Login, failing the test on an error.
func (e *env) login(id string) aliases.LoginAnswer {
	e.t.Helper()
	got, err := e.svc.Login(id)
	if err != nil {
		e.t.Fatalf("Login: %v", err)
	}
	return got
}

// code calls LoginCode, failing the test on an error.
func (e *env) code(id, code string) aliases.LoginAnswer {
	e.t.Helper()
	got, err := e.svc.LoginCode(id, code)
	if err != nil {
		e.t.Fatalf("LoginCode: %v", err)
	}
	return got
}

// waitingOn opens the account's login and checks that it waits on the fake URL; it returns the
// fake run.
func (e *env) waitingOn(v aliases.View, c *aliasestest.Claude) *aliasestest.Login {
	e.t.Helper()
	got := e.login(v.ID)
	if want := (aliases.LoginAnswer{State: aliases.LoginWaiting, URL: fakeURL}); got != want {
		e.t.Fatalf("Login = %+v, want %+v", got, want)
	}
	runs := c.Logins()
	if len(runs) != 1 {
		e.t.Fatalf("%d login runs, want 1", len(runs))
	}
	return runs[0]
}

// eventAfter waits until an aliases event after the first n satisfies pred, and returns it.
func (e *env) eventAfter(n int, pred func(aliases.List) bool) aliases.List {
	e.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		lists := e.ev.Lists()
		for _, l := range lists[min(n, len(lists)):] {
			if pred(l) {
				return l
			}
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("no aliases event after the first %d matched (%d events)", n, len(lists))
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// inFlight reports whether l shows a login run of the first account.
func inFlight(l aliases.List) bool { return len(l.Aliases) > 0 && l.Aliases[0].Login.InFlight }

// gone waits until the account's view shows no login run, and an event after the first n says
// so too.
func (e *env) gone(id string, n int) {
	e.t.Helper()
	e.eventAfter(n, func(l aliases.List) bool { return len(l.Aliases) > 0 && !inFlight(l) })
	if e.viewOf(id).Login.InFlight {
		e.t.Error("the view still shows a login run")
	}
}

func TestLoginStartsAndJoins(t *testing.T) {
	e, v, c := loginEnv(t)
	n := e.ev.Count()
	run := e.waitingOn(v, c)
	e.eventAfter(n, inFlight)
	if !e.viewOf(v.ID).Login.InFlight {
		t.Error("the view shows no login run")
	}
	if got := e.login(v.ID); got.State != aliases.LoginWaiting || got.URL != fakeURL {
		t.Errorf("second Login = %+v", got)
	}
	if k := len(c.Logins()); k != 1 {
		t.Errorf("%d login runs after a join, want 1", k)
	}
	if run.Cancelled() {
		t.Error("the run was cancelled")
	}
}

func TestLoginConcurrentStartsJoin(t *testing.T) {
	e, v, c := loginEnv(t)
	release := c.BlockStart()
	answers := make(chan aliases.LoginAnswer, 2)
	for range 2 {
		go func() {
			got, err := e.svc.Login(v.ID)
			if err != nil {
				t.Errorf("Login: %v", err)
			}
			answers <- got
		}()
	}
	e.eventAfter(0, inFlight)
	release()
	for range 2 {
		if got := <-answers; got.State != aliases.LoginWaiting || got.URL != fakeURL {
			t.Errorf("Login = %+v", got)
		}
	}
	if k := len(c.Logins()); k != 1 {
		t.Errorf("%d login runs, want 1", k)
	}
}

func TestLoginGoodCode(t *testing.T) {
	ready := make(chan model.AgentKind, 8)
	e, v, c := loginEnv(t, func(o *aliases.Options) { o.Ready = func(k model.AgentKind) { ready <- k } })
	e.waitingOn(v, c)
	n := e.ev.Count()

	got := e.code(v.ID, "  "+goodCode+"\n")
	if want := (aliases.LoginAnswer{State: aliases.LoginLoggedIn, Email: fakeEmail}); got != want {
		t.Fatalf("LoginCode = %+v, want %+v", got, want)
	}
	if codes := c.Logins()[0].Codes(); len(codes) != 1 || codes[0] != goodCode {
		t.Errorf("codes handed to Claude %q, want the trimmed code", codes)
	}
	if l := e.viewOf(v.ID).Login; l != (aliases.Login{Known: true, LoggedIn: true, Email: fakeEmail}) {
		t.Errorf("view login = %+v", l)
	}
	e.eventAfter(n, func(l aliases.List) bool {
		a := l.Aliases[0].Login
		return a.LoggedIn && a.Email == fakeEmail && !a.InFlight
	})
	rec, _ := e.record(v.ID)
	if rec.LastLogin == nil || !rec.LastLogin.LoggedIn || rec.LastLogin.Email != fakeEmail {
		t.Errorf("last login = %+v", rec.LastLogin)
	}
	// Once for the container's first start in this run, once for the login.
	for i := range 2 {
		select {
		case k := <-ready:
			if k != v.Kind {
				t.Errorf("Ready(%s)", k)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%d Ready calls, want 2", i)
		}
	}
	if err := e.svc.Check(v.Kind); err != nil {
		t.Errorf("Check: %v", err)
	}
	if st := e.cont.State(v.ID); st != container.StateRunning {
		t.Errorf("container %s", st)
	}
	if got := e.code(v.ID, goodCode); got != noLogin {
		t.Errorf("a code after the login = %+v", got)
	}
}

func TestLoginWrongCodeThenGood(t *testing.T) {
	e, v, c := loginEnv(t)
	run := e.waitingOn(v, c)
	got := e.code(v.ID, "wrong-code")
	if want := (aliases.LoginAnswer{State: aliases.LoginWaiting, URL: fakeURL, Error: "Invalid code"}); got != want {
		t.Fatalf("wrong code = %+v, want %+v", got, want)
	}
	if !e.viewOf(v.ID).Login.InFlight || run.Cancelled() {
		t.Fatal("the session did not stay")
	}
	if got := e.code(v.ID, goodCode); got.State != aliases.LoginLoggedIn || got.Email != fakeEmail {
		t.Errorf("good code = %+v", got)
	}
}

func TestLoginCodeWithoutSession(t *testing.T) {
	e, v, _ := loginEnv(t)
	if got := e.code(v.ID, goodCode); got != noLogin {
		t.Errorf("LoginCode = %+v", got)
	}
	if _, err := e.svc.LoginCode("a_00000000", goodCode); !errors.Is(err, aliases.ErrNotFound) {
		t.Errorf("unknown account: %v", err)
	}
}

func TestLoginCancel(t *testing.T) {
	e, v, c := loginEnv(t)
	run := e.waitingOn(v, c)
	n := e.ev.Count()
	if err := e.svc.CancelLogin(v.ID); err != nil {
		t.Fatal(err)
	}
	if !run.Cancelled() {
		t.Error("the run was not cancelled")
	}
	if e.viewOf(v.ID).Login.InFlight {
		t.Error("the view still shows a login run")
	}
	e.gone(v.ID, n)
	if err := e.svc.Check(v.Kind); !errors.Is(err, aliases.ErrNotLoggedIn) {
		t.Errorf("Check after a cancel: %v", err)
	}
	if got := e.code(v.ID, goodCode); got != noLogin {
		t.Errorf("a code after the cancel = %+v", got)
	}
	if err := e.svc.CancelLogin(v.ID); err != nil {
		t.Errorf("CancelLogin with no login: %v", err)
	}
	if err := e.svc.CancelLogin("a_00000000"); !errors.Is(err, aliases.ErrNotFound) {
		t.Errorf("unknown account: %v", err)
	}
}

func TestLoginCancelWhilePreparing(t *testing.T) {
	e, v, c := loginEnv(t)
	release := e.cont.BlockEnsure()
	defer release()
	e.cont.SetBuilding(container.DefaultImage(), true)
	if got := e.login(v.ID); got.State != aliases.LoginPreparing {
		t.Fatalf("Login = %+v", got)
	}
	if err := e.svc.CancelLogin(v.ID); err != nil {
		t.Fatal(err)
	}
	if e.viewOf(v.ID).Login.InFlight {
		t.Error("the view still shows a login run")
	}
	release()
	e.svc.Shutdown() // waits for the session's goroutine
	if k := len(c.Logins()); k != 0 {
		t.Errorf("%d login runs started after a cancel", k)
	}
}

func TestLoginRunEndsByItself(t *testing.T) {
	e, v, c := loginEnv(t)
	run := e.waitingOn(v, c)
	// The first start of the container asks the login once; wait for it.
	e.ev.WaitFor(t, 2*time.Second, func(l aliases.List) bool { return l.Aliases[0].Login.Known })
	asked := c.StatusCalls()
	n := e.ev.Count()
	run.End()
	e.gone(v.ID, n)
	if c.StatusCalls() <= asked {
		t.Error("the login was not asked again")
	}
	if got := e.code(v.ID, goodCode); got != noLogin {
		t.Errorf("a code after the end = %+v", got)
	}
}

func TestLoginTimeLimit(t *testing.T) {
	e, v, c := loginEnv(t, func(o *aliases.Options) { o.Waits.LoginLimit = 50 * time.Millisecond })
	run := e.waitingOn(v, c)
	n := e.ev.Count()
	e.gone(v.ID, n)
	if !run.Cancelled() {
		t.Error("the run was not cancelled")
	}
}

func TestLoginPreparing(t *testing.T) {
	e, v, c := loginEnv(t)
	release := e.cont.BlockEnsure()
	defer release()
	e.cont.SetBuilding(container.DefaultImage(), true)

	start := time.Now()
	got := e.login(v.ID)
	if got != (aliases.LoginAnswer{State: aliases.LoginPreparing}) {
		t.Fatalf("Login = %+v", got)
	}
	if d := time.Since(start); d > time.Second {
		t.Errorf("Login took %v while the image is built", d)
	}
	if vw := e.viewOf(v.ID); !vw.Login.InFlight || vw.Container.State != aliases.ContainerPreparing {
		t.Errorf("view login %+v, container %+v", vw.Login, vw.Container)
	}

	n := e.ev.Count()
	e.cont.SetBuilding(container.DefaultImage(), false)
	release()
	e.eventAfter(n, func(l aliases.List) bool {
		return l.Aliases[0].Container.State == aliases.ContainerRunning && inFlight(l)
	})
	if got := e.login(v.ID); got.State != aliases.LoginWaiting || got.URL != fakeURL {
		t.Errorf("Login after the build = %+v", got)
	}
	if k := len(c.Logins()); k != 1 {
		t.Errorf("%d login runs, want 1", k)
	}
}

func TestLoginPreparingIsBroadcast(t *testing.T) {
	e, v, _ := loginEnv(t)
	release := e.cont.BlockEnsure()
	defer release()
	// The build starts after the login is opened (and its first broadcast made), as in the
	// container manager, where the image is built inside Ensure.
	n := e.ev.Count()
	go func() {
		time.Sleep(100 * time.Millisecond)
		e.cont.SetBuilding(container.DefaultImage(), true)
	}()
	if got := e.login(v.ID); got.State != aliases.LoginPreparing {
		t.Fatalf("Login = %+v", got)
	}
	e.eventAfter(n, func(l aliases.List) bool {
		return l.Aliases[0].Container.State == aliases.ContainerPreparing && inFlight(l)
	})
	e.cont.SetBuilding(container.DefaultImage(), false)
}

func TestLoginSlowStartAnswersPreparing(t *testing.T) {
	e, v, c := loginEnv(t, func(o *aliases.Options) { o.Waits.LoginStart = 50 * time.Millisecond })
	release := c.BlockStart()
	defer release()
	if got := e.login(v.ID); got.State != aliases.LoginPreparing {
		t.Errorf("Login = %+v", got)
	}
}

func TestLoginDockerUnavailable(t *testing.T) {
	e, v, c := loginEnv(t)
	e.cont.SetAvailable(notRunning)
	_, err := e.svc.Login(v.ID)
	if u, ok := container.IsUnavailable(err); !ok || u != notRunning {
		t.Errorf("Login: %v", err)
	}
	if e.viewOf(v.ID).Login.InFlight || len(c.Logins()) != 0 {
		t.Error("a login was opened")
	}
	if _, err := e.svc.Login("a_00000000"); !errors.Is(err, aliases.ErrNotFound) {
		t.Errorf("unknown account: %v", err)
	}
}

func TestLoginDockerGoesDownWhilePreparing(t *testing.T) {
	e, v, _ := loginEnv(t)
	release := e.cont.BlockEnsure()
	answer := make(chan error, 1)
	go func() {
		_, err := e.svc.Login(v.ID)
		answer <- err
	}()
	e.eventAfter(0, inFlight)
	e.cont.SetAvailable(notRunning)
	release()
	if err := <-answer; !errors.Is(err, notRunning) {
		t.Errorf("Login: %v", err)
	}
	if e.viewOf(v.ID).Login.InFlight {
		t.Error("the view still shows a login run")
	}
}

func TestLoginStartFails(t *testing.T) {
	e, v, c := loginEnv(t)
	c.FailStart(errors.New("claude printed no login URL"))
	n := e.ev.Count()
	got := e.login(v.ID)
	if want := (aliases.LoginAnswer{State: aliases.LoginFailed, Error: "claude printed no login URL"}); got != want {
		t.Errorf("Login = %+v, want %+v", got, want)
	}
	e.gone(v.ID, n)
}

func TestLoginCodeTimeout(t *testing.T) {
	e, v, c := loginEnv(t, func(o *aliases.Options) { o.Waits.Code = 50 * time.Millisecond })
	run := e.waitingOn(v, c)
	run.SetCodeDelay(5 * time.Second)
	got := e.code(v.ID, goodCode)
	want := aliases.LoginAnswer{State: aliases.LoginWaiting, URL: fakeURL, Error: "Claude did not answer in time; try again"}
	if got != want {
		t.Errorf("LoginCode = %+v, want %+v", got, want)
	}
	if !e.viewOf(v.ID).Login.InFlight {
		t.Error("the session did not stay")
	}
}

func TestLoginCodesAreSerialized(t *testing.T) {
	e, v, c := loginEnv(t)
	run := e.waitingOn(v, c)
	run.SetCodeDelay(100 * time.Millisecond)
	first := make(chan aliases.LoginAnswer, 1)
	codeTo := func(code string, out chan<- aliases.LoginAnswer) {
		got, err := e.svc.LoginCode(v.ID, code)
		if err != nil {
			t.Errorf("LoginCode: %v", err)
		}
		out <- got
	}
	go codeTo("wrong-code", first)
	for len(run.Codes()) == 0 {
		time.Sleep(time.Millisecond)
	}
	second := make(chan aliases.LoginAnswer, 1)
	go codeTo(goodCode, second)
	time.Sleep(20 * time.Millisecond)
	if k := len(run.Codes()); k != 1 {
		t.Errorf("%d codes with Claude at once, want 1", k)
	}
	if got := <-first; got.State != aliases.LoginWaiting {
		t.Errorf("first code = %+v", got)
	}
	if got := <-second; got.State != aliases.LoginLoggedIn {
		t.Errorf("second code = %+v", got)
	}
}

func TestStopCancelsLogin(t *testing.T) {
	e, v, c := loginEnv(t)
	run := e.waitingOn(v, c)
	if _, err := e.svc.Stop(v.ID, true); err != nil {
		t.Fatal(err)
	}
	if !run.Cancelled() {
		t.Error("the run was not cancelled")
	}
	if e.viewOf(v.ID).Login.InFlight {
		t.Error("the view still shows a login run")
	}
}

func TestRemoveCancelsLogin(t *testing.T) {
	e, v, c := loginEnv(t)
	run := e.waitingOn(v, c)
	if err := e.svc.Remove(v.ID); err != nil {
		t.Fatal(err)
	}
	if !run.Cancelled() {
		t.Error("the run was not cancelled")
	}
	if _, err := e.svc.LoginCode(v.ID, goodCode); !errors.Is(err, aliases.ErrNotFound) {
		t.Errorf("a code after the removal: %v", err)
	}
}

func TestShutdownCancelsLogin(t *testing.T) {
	e, v, c := loginEnv(t)
	run := e.waitingOn(v, c)
	e.svc.Shutdown()
	if !run.Cancelled() {
		t.Error("the run was not cancelled")
	}
	if _, err := e.svc.Login(v.ID); err == nil {
		t.Error("Login after the shutdown opened a login")
	}
}

func TestShutdownWhilePreparing(t *testing.T) {
	e, v, c := loginEnv(t)
	e.cont.BlockEnsure() // never released: the shutdown must end the wait
	e.cont.SetBuilding(container.DefaultImage(), true)
	if got := e.login(v.ID); got.State != aliases.LoginPreparing {
		t.Fatalf("Login = %+v", got)
	}
	done := make(chan struct{})
	go func() {
		e.svc.Shutdown()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Shutdown did not end a preparing login")
	}
	if k := len(c.Logins()); k != 0 {
		t.Errorf("%d login runs", k)
	}
}

func TestLoginLeaksNothing(t *testing.T) {
	const (
		url   = "https://claude.ai/oauth/authorize?state=secret-state-4711"
		wrong = "wrong-code-0815"
		good  = "good-code-1337"
	)
	var mu sync.Mutex
	var logs []string
	e, v, c := loginEnv(t, func(o *aliases.Options) {
		o.Logf = func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			logs = append(logs, fmt.Sprintf(format, args...))
		}
	})
	c.SetLogin(url, good, fakeEmail)

	if got := e.login(v.ID); got.URL != url {
		t.Fatalf("Login = %+v", got)
	}
	if got := e.code(v.ID, wrong); got.State != aliases.LoginWaiting {
		t.Fatalf("wrong code = %+v", got)
	}
	if got := e.code(v.ID, good); got.State != aliases.LoginLoggedIn {
		t.Fatalf("good code = %+v", got)
	}
	// A second login, cancelled, and a third whose start fails.
	e.login(v.ID)
	e.code(v.ID, wrong)
	if err := e.svc.CancelLogin(v.ID); err != nil {
		t.Fatal(err)
	}
	c.FailStart(errors.New("claude printed no login URL"))
	e.login(v.ID)
	e.svc.Shutdown()

	mu.Lock()
	all := append([]string(nil), logs...)
	mu.Unlock()
	all = append(all, e.ev.Raw()...)
	for _, line := range all {
		for _, secret := range []string{url, "secret-state-4711", wrong, good} {
			if strings.Contains(line, secret) {
				t.Errorf("%q is in %q", secret, line)
			}
		}
	}
	if len(e.ev.Raw()) == 0 {
		t.Error("no events")
	}
}
