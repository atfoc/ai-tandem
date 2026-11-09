package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/aliases"
	"ai-whiteboard/internal/aliases/aliasestest"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/container"
)

var _ AliasAPI = (*aliases.Service)(nil)

// isAliasRoute reports whether route is one of the Claude accounts' routes (aliases.go).
func isAliasRoute(route string) bool {
	_, path, _ := strings.Cut(route, " ")
	return path == "/api/aliases" || strings.HasPrefix(path, "/api/aliases/")
}

// aliasEnv is a server whose accounts are a real *aliases.Service on the aliasestest fakes,
// asked through ClientHandler with the secret.
type aliasEnv struct {
	t       *testing.T
	h       http.Handler
	svc     *aliases.Service
	root    string
	home    string
	cont    *aliasestest.Containers
	work    *aliasestest.Work
	claudes *aliasestest.Claudes
	ev      *aliasestest.Events
}

func newAliasEnv(t *testing.T) *aliasEnv {
	t.Helper()
	e := &aliasEnv{
		t: t, root: t.TempDir(), home: t.TempDir(),
		cont: aliasestest.NewContainers(), work: aliasestest.NewWork(),
		claudes: aliasestest.NewClaudes(), ev: &aliasestest.Events{},
	}
	svc, err := aliases.New(aliases.Options{
		Root: e.root, Home: e.home, Containers: e.cont, Work: e.work,
		Claude: e.claudes.Factory(), Broadcast: e.ev.Broadcast, Logf: t.Logf,
		Waits: aliases.Waits{Stale: time.Hour},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(svc.Shutdown)
	e.svc = svc
	raw := newRawEnv(t, withClients, func(s *Server) { s.Aliases = svc })
	e.h = raw.s.ClientHandler()
	return e
}

// do sends one request with the secret and answers the recorder.
func (e *aliasEnv) do(method, path, body string) *httptest.ResponseRecorder {
	return clientDoAs(e.h, testAPIClient, method, path, testHost, testSecret, body)
}

// want sends one request, checks its status, and decodes its body as T.
func want[T any](e *aliasEnv, method, path, body string, status int) T {
	e.t.Helper()
	w := e.do(method, path, body)
	if w.Code != status {
		e.t.Fatalf("%s %s %s: status %d, want %d (%s)", method, path, body, w.Code, status, w.Body)
	}
	return decode[T](e.t, w.Body.String())
}

// aliasRefusal is the body of an error answer.
type aliasRefusal struct {
	Error string `json:"error"`
	Code  string `json:"code"`
}

// wantRefusal sends one request and checks its status, its code and that its error has text.
func (e *aliasEnv) wantRefusal(method, path, body string, status int, code, text string) aliasRefusal {
	e.t.Helper()
	r := want[aliasRefusal](e, method, path, body, status)
	if r.Code != code || !strings.Contains(r.Error, text) {
		e.t.Fatalf("%s %s %s: %+v, want code %q and an error with %q", method, path, body, r, code, text)
	}
	return r
}

// add adds the account name with mounts through the API.
func (e *aliasEnv) add(name string, mounts ...string) aliases.View {
	e.t.Helper()
	return want[aliases.View](e, "POST", "/api/aliases", jsonOf(e.t, aliases.Input{Name: &name, Mounts: &mounts}), 200)
}

// changed runs f and checks that it sent at least one aliases event.
func (e *aliasEnv) changed(what string, f func()) {
	e.t.Helper()
	before := e.ev.Count()
	f()
	if e.ev.Count() <= before {
		e.t.Fatalf("%s: no aliases event", what)
	}
}

// spec is the spec of the account's record now.
func (e *aliasEnv) spec(id string) container.Spec {
	e.t.Helper()
	for _, v := range e.svc.List().Aliases {
		if v.ID == id {
			return v.Alias.Spec(e.root)
		}
	}
	e.t.Fatalf("no account %s", id)
	return container.Spec{}
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	return mustJSON(t, v)
}

func TestAliasListRoute(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	w := e.do("GET", "/api/aliases", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"aliases":[]`) {
		t.Fatalf("empty list: %d %s", w.Code, w.Body)
	}
	l := decode[aliases.List](t, w.Body.String())
	if !l.Docker.OK || l.Docker.Reason != "" || l.DefaultImage != container.DefaultImage() || l.Aliases == nil {
		t.Fatalf("empty list: %+v", l)
	}

	v := e.add("Work")
	e.cont.SetAvailable(&container.Unavailable{Kind: container.NotRunning, Reason: "Docker is not running"})
	l = want[aliases.List](e, "GET", "/api/aliases", "", 200)
	if l.Docker.OK || l.Docker.Kind != container.NotRunning || l.Docker.Reason != "Docker is not running" {
		t.Fatalf("docker with Docker down: %+v", l.Docker)
	}
	if len(l.Aliases) != 1 || l.Aliases[0].ID != v.ID || l.Aliases[0].Container.State != aliases.ContainerUnavailable {
		t.Fatalf("accounts with Docker down: %+v", l.Aliases)
	}
}

func TestAliasAddRoute(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	dir := t.TempDir()
	var v aliases.View
	e.changed("add", func() { v = e.add("Work", dir) })
	if !strings.HasPrefix(v.ID, "a_") || string(v.Kind) != "claude:"+v.ID || v.Name != "Work" ||
		v.Container.State != aliases.ContainerNone || v.Pending == nil || len(v.Pending) != 0 ||
		!slices.Equal(v.Mounts, []string{dir}) {
		t.Fatalf("added: %+v", v)
	}
	w := e.do("POST", "/api/aliases", `{"name":"Work"}`)
	if !strings.Contains(w.Body.String(), `"pending":[]`) {
		t.Fatalf("pending is not []: %s", w.Body)
	}

	e.wantRefusal("POST", "/api/aliases", `{}`, 400, aliases.CodeBadName, "")
	e.wantRefusal("POST", "/api/aliases", `{"name":"  "}`, 400, aliases.CodeBadName, "")
	missing := filepath.Join(dir, "nope")
	e.wantRefusal("POST", "/api/aliases", jsonOf(t, map[string]any{"name": "X", "mounts": []string{missing}}),
		400, aliases.CodeBadFolder, missing+" does not exist")
	e.wantRefusal("POST", "/api/aliases", jsonOf(t, map[string]any{"name": "X", "mounts": []string{dir, dir}}),
		400, aliases.CodeBadFolder, dir+" is listed twice")
	dotClaude := filepath.Join(e.home, ".claude")
	if err := os.MkdirAll(dotClaude, 0o755); err != nil {
		t.Fatal(err)
	}
	e.wantRefusal("POST", "/api/aliases", jsonOf(t, map[string]any{"name": "X", "mounts": []string{dotClaude}}),
		400, aliases.CodeBadFolder, dotClaude)
	e.wantRefusal("POST", "/api/aliases", jsonOf(t, map[string]any{"name": "X", "mounts": []string{e.home}}),
		400, aliases.CodeBadFolder, "~/.claude")

	inner := filepath.Join(dir, "inner")
	if err := os.Mkdir(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	if v := e.add("Nested", dir, inner); !slices.Equal(v.Mounts, []string{dir, inner}) {
		t.Fatalf("nested: %+v", v.Mounts)
	}
	if n := len(e.svc.List().Aliases); n != 3 {
		t.Fatalf("%d accounts after the refusals, want 3", n)
	}
}

func TestAliasMalformedBodies(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	v := e.add("Work")
	for _, rq := range [][2]string{
		{"POST", "/api/aliases"},
		{"PATCH", "/api/aliases/" + v.ID},
		{"POST", "/api/aliases/" + v.ID + "/restart"},
		{"POST", "/api/aliases/" + v.ID + "/stop"},
	} {
		if w := e.do(rq[0], rq[1], `{"name":`); w.Code != 400 {
			t.Fatalf("%s %s with a malformed body: %d %s", rq[0], rq[1], w.Code, w.Body)
		}
	}
	if n := len(e.svc.List().Aliases); n != 1 {
		t.Fatalf("%d accounts, want 1", n)
	}
}

func TestAliasEditRoute(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	v := e.add("Work")
	path := "/api/aliases/" + v.ID

	var c aliases.Change
	e.changed("rename", func() { c = want[aliases.Change](e, "PATCH", path, `{"name":"Job"}`, 200) })
	if c.Restart != aliases.RestartUnchanged || c.Alias.Name != "Job" {
		t.Fatalf("rename: %+v", c)
	}
	e.wantRefusal("PATCH", "/api/aliases/a_nothere", `{"name":"X"}`, 404, "not_found", "")

	// No container: the folders are taken at its next start.
	d1 := t.TempDir()
	e.changed("folders with no container", func() {
		c = want[aliases.Change](e, "PATCH", path, jsonOf(t, map[string]any{"mounts": []string{d1}}), 200)
	})
	if c.Restart != aliases.RestartDeferred || !slices.Equal(c.Alias.Mounts, []string{d1}) {
		t.Fatalf("deferred: %+v", c)
	}

	// Running and idle: recreated now.
	e.cont.SetState(v.ID, container.StateRunning, e.spec(v.ID))
	d2 := t.TempDir()
	e.changed("folders of an idle container", func() {
		c = want[aliases.Change](e, "PATCH", path, jsonOf(t, map[string]any{"mounts": []string{d1, d2}}), 200)
	})
	if c.Restart != aliases.RestartDone || c.Alias.RestartNeeded || c.Alias.Container.State != aliases.ContainerRunning {
		t.Fatalf("done: %+v", c)
	}
	if sp, _ := e.cont.Spec(v.ID); !slices.Equal(sp.Mounts, []string{d1, d2}) || e.cont.Count("recreate "+v.ID) != 1 {
		t.Fatalf("container after the recreate: %+v, calls %v", sp, e.cont.Calls())
	}
}

func TestAliasEditBusyAndRestartRoute(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	v := e.add("Work")
	path := "/api/aliases/" + v.ID
	// The container is made through the account's runner, as a chat's first message makes it,
	// so that its spec is recorded applied and a later change of folders shows as pending.
	run, err := e.svc.RunnerFor(v.Kind).Command(context.Background(), "", nil, []string{"true"})
	if err != nil {
		t.Fatal(err)
	}
	run.Kill()

	e.work.SetBusy(v.Kind, 2)
	d := t.TempDir()
	var c aliases.Change
	e.changed("folders of a busy container", func() {
		c = want[aliases.Change](e, "PATCH", path, jsonOf(t, map[string]any{"mounts": []string{d}}), 200)
	})
	if c.Restart != aliases.RestartBusy || c.Busy != 2 || !c.Alias.RestartNeeded || !slices.Equal(c.Alias.Pending, []string{d}) {
		t.Fatalf("busy: %+v", c)
	}
	if e.cont.Count("recreate "+v.ID) != 0 || len(e.work.Stopped()) != 0 {
		t.Fatalf("a busy container was touched: %v, stopped %v", e.cont.Calls(), e.work.Stopped())
	}

	e.changed("restart of a busy container", func() { c = want[aliases.Change](e, "POST", path+"/restart", `{}`, 200) })
	if c.Restart != aliases.RestartBusy || c.Busy != 2 {
		t.Fatalf("restart busy: %+v", c)
	}
	e.changed("forced restart", func() { c = want[aliases.Change](e, "POST", path+"/restart", `{"force":true}`, 200) })
	if c.Restart != aliases.RestartDone || c.Alias.RestartNeeded || len(c.Alias.Pending) != 0 || !slices.Contains(e.work.Stopped(), v.Kind) {
		t.Fatalf("forced restart: %+v, stopped %v", c, e.work.Stopped())
	}
	if sp, _ := e.cont.Spec(v.ID); !slices.Equal(sp.Mounts, []string{d}) {
		t.Fatalf("container after the forced restart: %+v", sp)
	}
	e.wantRefusal("POST", "/api/aliases/a_nothere/restart", "", 404, "not_found", "")
}

func TestAliasStopRoute(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	v := e.add("Work")
	path := "/api/aliases/" + v.ID + "/stop"
	running := func() { e.cont.SetState(v.ID, container.StateRunning, e.spec(v.ID)) }

	running()
	var c aliases.Change
	e.changed("stop", func() { c = want[aliases.Change](e, "POST", path, `{}`, 200) })
	if c.Restart != aliases.RestartDone || e.cont.State(v.ID) != container.StateStopped || c.Alias.Container.State != aliases.ContainerStopped {
		t.Fatalf("stop idle: %+v, container %s", c, e.cont.State(v.ID))
	}

	running()
	e.work.SetBusy(v.Kind, 1)
	if c = want[aliases.Change](e, "POST", path, "", 200); c.Restart != aliases.RestartBusy || c.Busy != 1 || e.cont.State(v.ID) != container.StateRunning {
		t.Fatalf("stop busy with no body: %+v, container %s", c, e.cont.State(v.ID))
	}
	if c = want[aliases.Change](e, "POST", path, `{"force":false}`, 200); c.Restart != aliases.RestartBusy {
		t.Fatalf("stop busy, force false: %+v", c)
	}
	if c = want[aliases.Change](e, "POST", path, `{"force":true}`, 200); c.Restart != aliases.RestartDone || e.cont.State(v.ID) != container.StateStopped {
		t.Fatalf("forced stop: %+v, container %s", c, e.cont.State(v.ID))
	}
	if !slices.Contains(e.work.Stopped(), v.Kind) {
		t.Fatalf("a forced stop did not stop the agents: %v", e.work.Stopped())
	}

	e.cont.SetAvailable(&container.Unavailable{Kind: container.NotRunning, Reason: "Docker is not running"})
	e.wantRefusal("POST", path, "", 409, aliases.CodeDocker, "Docker is not running")
	e.wantRefusal("POST", "/api/aliases/a_nothere/stop", "", 404, "not_found", "")
}

func TestAliasDeleteRoute(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	v := e.add("Work")
	if _, err := os.Stat(aliases.Dir(e.root, v.ID)); err != nil {
		t.Fatalf("the account's folder: %v", err)
	}
	e.changed("delete", func() {
		if w := e.do("DELETE", "/api/aliases/"+v.ID, ""); w.Code != 200 || strings.TrimSpace(w.Body.String()) != "{}" {
			t.Fatalf("delete: %d %s", w.Code, w.Body)
		}
	})
	if l := want[aliases.List](e, "GET", "/api/aliases", "", 200); len(l.Aliases) != 0 {
		t.Fatalf("after the delete: %+v", l.Aliases)
	}
	if _, err := os.Stat(aliases.Dir(e.root, v.ID)); !os.IsNotExist(err) {
		t.Fatalf("the account's folder after the delete: %v", err)
	}
	e.wantRefusal("DELETE", "/api/aliases/"+v.ID, "", 404, "not_found", "")
}

func TestAliasLogoutRoute(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	v := e.add("Work")
	fake := e.claudes.For(v.ID)
	fake.SetAuth(claude.Auth{LoggedIn: true, Email: "work@example.com"}, nil)
	var got aliases.View
	e.changed("logout", func() { got = want[aliases.View](e, "POST", "/api/aliases/"+v.ID+"/logout", "", 200) })
	if got.ID != v.ID || !got.Login.Known || got.Login.LoggedIn || fake.LogoutCalls() != 1 {
		t.Fatalf("logout: %+v, %d logout calls", got, fake.LogoutCalls())
	}
	e.wantRefusal("POST", "/api/aliases/a_nothere/logout", "", 404, "not_found", "")
}

// The login routes (goal §1.3, §3.6): start → waiting with the URL, a second start joins, a wrong
// code → waiting with Claude's error, the good code → logged in; the URL and the code are in the
// answers only, never in an event.
func TestAliasLoginRoutes(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	v := e.add("Work")
	fake := e.claudes.For(v.ID)
	fake.SetLogin("https://claude.ai/oauth/authorize?state=secret-url", "good-code-123", "work@example.com")
	base := "/api/aliases/" + v.ID + "/login"

	l := want[aliases.LoginAnswer](e, "POST", base, "", 200)
	if l.State != aliases.LoginWaiting || l.URL != "https://claude.ai/oauth/authorize?state=secret-url" {
		t.Fatalf("start: %+v", l)
	}
	if j := want[aliases.LoginAnswer](e, "POST", base, "", 200); j.State != aliases.LoginWaiting || j.URL != l.URL || len(fake.Logins()) != 1 {
		t.Fatalf("join: %+v, %d runs", j, len(fake.Logins()))
	}
	e.ev.WaitFor(t, 5*time.Second, func(l aliases.List) bool { return len(l.Aliases) == 1 && l.Aliases[0].Login.InFlight })

	w := want[aliases.LoginAnswer](e, "POST", base+"/code", `{"code":"wrong-code-456"}`, 200)
	if w.State != aliases.LoginWaiting || w.Error == "" || w.URL != l.URL {
		t.Fatalf("wrong code: %+v", w)
	}
	g := want[aliases.LoginAnswer](e, "POST", base+"/code", `{"code":" good-code-123 "}`, 200)
	if g.State != aliases.LoginLoggedIn || g.Email != "work@example.com" {
		t.Fatalf("good code: %+v", g)
	}
	e.ev.WaitFor(t, 5*time.Second, func(l aliases.List) bool {
		return len(l.Aliases) == 1 && l.Aliases[0].Login.LoggedIn && !l.Aliases[0].Login.InFlight
	})
	list := want[aliases.List](e, "GET", "/api/aliases", "", 200)
	if lg := list.Aliases[0].Login; !lg.LoggedIn || lg.Email != "work@example.com" {
		t.Fatalf("list after login: %+v", lg)
	}
	for _, raw := range e.ev.Raw() {
		for _, secret := range []string{"secret-url", "good-code-123", "wrong-code-456"} {
			if strings.Contains(raw, secret) {
				t.Fatalf("an event holds %q: %s", secret, raw)
			}
		}
	}

	// A code with no login open, and the unknown account.
	if n := want[aliases.LoginAnswer](e, "POST", base+"/code", `{"code":"x"}`, 200); n.State != aliases.LoginFailed || n.Error == "" {
		t.Fatalf("code with no login: %+v", n)
	}
	e.wantRefusal("POST", "/api/aliases/a_nothere/login", "", 404, "not_found", "")
	e.wantRefusal("POST", "/api/aliases/a_nothere/login/code", `{"code":"x"}`, 404, "not_found", "")
	e.wantRefusal("DELETE", "/api/aliases/a_nothere/login", "", 404, "not_found", "")
}

// DELETE …/login ends the run and leaves the account as it was; with Docker unavailable a start is
// refused with its reason (409 docker_unavailable).
func TestAliasLoginCancelAndDocker(t *testing.T) {
	t.Parallel()
	e := newAliasEnv(t)
	v := e.add("Work")
	base := "/api/aliases/" + v.ID + "/login"
	if l := want[aliases.LoginAnswer](e, "POST", base, "", 200); l.State != aliases.LoginWaiting {
		t.Fatalf("start: %+v", l)
	}
	e.changed("cancel", func() { want[map[string]any](e, "DELETE", base, "", 200) })
	runs := e.claudes.For(v.ID).Logins()
	if len(runs) != 1 || !runs[0].Cancelled() {
		t.Fatalf("cancel: %d runs, cancelled %v", len(runs), len(runs) == 1 && runs[0].Cancelled())
	}
	if lg := want[aliases.List](e, "GET", "/api/aliases", "", 200).Aliases[0].Login; lg.LoggedIn || lg.InFlight {
		t.Fatalf("after cancel: %+v", lg)
	}
	want[map[string]any](e, "DELETE", base, "", 200) // no login open: no error

	e.cont.SetAvailable(&container.Unavailable{Kind: container.NotRunning, Reason: "Docker is not running"})
	e.wantRefusal("POST", base, "", 409, "docker_unavailable", "Docker is not running")
}
