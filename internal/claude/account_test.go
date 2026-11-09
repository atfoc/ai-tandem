//go:build !windows

package claude

import (
	"bytes"
	"context"
	"errors"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
)

// accountSpawner is a spawner of the fake claude through a HostRunner, whose runs get
// CLAUDE_CONFIG_DIR = the returned folder (the HostRunner hands down this process's environment).
func accountSpawner(t *testing.T) (*Spawner, *agenttest.HostRunner, string) {
	t.Helper()
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH")
	}
	dir := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", dir)
	hr := &agenttest.HostRunner{}
	return &Spawner{Bin: agenttest.FakeClaude(t), Runner: hr}, hr, dir
}

func writeLogin(t *testing.T, dir, email string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "fake-login.json"), []byte(`{"loggedIn":true,"email":"`+email+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func shortCtx(t *testing.T, d time.Duration) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}

func TestAuthStatusLoggedOut(t *testing.T) {
	sp, hr, _ := accountSpawner(t)
	a, err := sp.AuthStatus(shortCtx(t, 20*time.Second))
	if err != nil || a.LoggedIn || a.Email != "" {
		t.Fatalf("AuthStatus = %+v, %v; want logged out with no error (exit 1 with JSON is an answer)", a, err)
	}
	calls := hr.Calls()
	if len(calls) != 1 || calls[0].Dir != "/tmp" || !slices.Equal(calls[0].Argv, []string{sp.Bin, "auth", "status"}) {
		t.Fatalf("runner calls: %+v", calls)
	}
}

func TestAuthStatusLoggedIn(t *testing.T) {
	sp, _, dir := accountSpawner(t)
	writeLogin(t, dir, "someone@example.com")
	a, err := sp.AuthStatus(shortCtx(t, 20*time.Second))
	if err != nil || !a.LoggedIn || a.Email != "someone@example.com" {
		t.Fatalf("AuthStatus = %+v, %v", a, err)
	}
}

// The computer's own claude (no Runner, no CLAUDE_CONFIG_DIR) is signed in as the fake's default.
func TestAuthStatusOnTheHost(t *testing.T) {
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH")
	}
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	sp := &Spawner{Bin: agenttest.FakeClaude(t)}
	a, err := sp.AuthStatus(shortCtx(t, 20*time.Second))
	if err != nil || !a.LoggedIn || a.Email != "fake@example.com" {
		t.Fatalf("AuthStatus = %+v, %v", a, err)
	}
}

func TestAuthStatusGarbled(t *testing.T) {
	sp, _, _ := accountSpawner(t)
	t.Setenv("FAKE_CLAUDE_AUTH", "garbled")
	a, err := sp.AuthStatus(shortCtx(t, 20*time.Second))
	if err == nil || !strings.Contains(err.Error(), "cannot read") || !strings.Contains(err.Error(), "exit status 1") {
		t.Fatalf("AuthStatus = %+v, %v; want an error naming the exit status", a, err)
	}
}

func TestAuthStatusNoAnswer(t *testing.T) {
	sp, hr, _ := accountSpawner(t)
	t.Setenv("FAKE_CLAUDE_AUTH", "slow")
	start := time.Now()
	_, err := sp.AuthStatus(shortCtx(t, 500*time.Millisecond))
	if err == nil || !strings.Contains(err.Error(), "claude auth status: no answer within") {
		t.Fatalf("err = %v", err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Errorf("AuthStatus took %s", took)
	}
	if n := hr.Kills(0); n != 1 {
		t.Errorf("Kill called %d times, want 1", n)
	}
}

func TestAuthStatusRunnerError(t *testing.T) {
	sp, hr, _ := accountSpawner(t)
	hr.Err = errors.New("Docker is not running")
	if _, err := sp.AuthStatus(shortCtx(t, 5*time.Second)); !errors.Is(err, hr.Err) {
		t.Fatalf("err = %v, want the Runner's", err)
	}
	if err := sp.Logout(shortCtx(t, 5*time.Second)); !errors.Is(err, hr.Err) {
		t.Fatalf("Logout err = %v, want the Runner's", err)
	}
}

func TestLogout(t *testing.T) {
	sp, hr, dir := accountSpawner(t)
	writeLogin(t, dir, "someone@example.com")
	if err := sp.Logout(shortCtx(t, 20*time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "fake-login.json")); !os.IsNotExist(err) {
		t.Fatalf("the login file is still there: %v", err)
	}
	if err := sp.Logout(shortCtx(t, 20*time.Second)); err != nil {
		t.Fatalf("a second logout: %v", err)
	}
	if a, err := sp.AuthStatus(shortCtx(t, 20*time.Second)); err != nil || a.LoggedIn {
		t.Fatalf("AuthStatus after logout = %+v, %v", a, err)
	}
	if c := hr.Calls()[0]; c.Dir != "/tmp" || !slices.Equal(c.Argv, []string{sp.Bin, "auth", "logout"}) {
		t.Fatalf("runner call: %+v", c)
	}
}

func TestLogoutFails(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(bin, []byte("#!/bin/sh\necho 'Error: cannot reach the config' >&2\nexit 3\n"), 0o755)
	sp := &Spawner{Bin: bin, Runner: &agenttest.HostRunner{}}
	err := sp.Logout(shortCtx(t, 10*time.Second))
	if err == nil || !strings.Contains(err.Error(), "Error: cannot reach the config") || !strings.Contains(err.Error(), "exit status 3") {
		t.Fatalf("err = %v", err)
	}
}

const fakeState = "0123456789abcdef"
const fakeURL = "https://claude.example/oauth/authorize?code=true&state=" + fakeState

// startLogin starts a login of sp; the run is cancelled when the test ends.
func startLogin(t *testing.T, sp *Spawner) *Login {
	t.Helper()
	t.Setenv("FAKE_CLAUDE_LOGIN_STATE", fakeState)
	l, err := sp.StartLogin(shortCtx(t, 20*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		l.Cancel()
		<-l.Done()
	})
	return l
}

func waitDone(t *testing.T, l *Login) {
	t.Helper()
	select {
	case <-l.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("Done was not closed")
	}
}

func TestLoginURL(t *testing.T) {
	for _, tc := range []struct{ name, ansi, wrap string }{
		{"plain", "", ""},
		{"ansi", "1", ""},
		{"wrapped", "", "60"},
		{"ansi wrapped", "1", "48"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sp, hr, _ := accountSpawner(t)
			t.Setenv("FAKE_CLAUDE_LOGIN_ANSI", tc.ansi)
			t.Setenv("FAKE_CLAUDE_LOGIN_WRAP", tc.wrap)
			l := startLogin(t, sp)
			if l.URL() != fakeURL {
				t.Fatalf("URL = %q, want %q", l.URL(), fakeURL)
			}
			c := hr.Calls()[0]
			if c.Dir != "/tmp" || c.Argv[0] != "/bin/sh" || c.Argv[len(c.Argv)-1] != sp.Bin {
				t.Fatalf("runner call: %+v", c)
			}
		})
	}
}

func TestLoginGoodCode(t *testing.T) {
	sp, _, dir := accountSpawner(t)
	t.Setenv("FAKE_CLAUDE_LOGIN_EMAIL", "second@example.com")
	l := startLogin(t, sp)
	r, err := l.Code(shortCtx(t, 20*time.Second), " good#code\n")
	if err != nil || r.State != LoginLoggedIn || r.Error != "" {
		t.Fatalf("Code = %+v, %v", r, err)
	}
	waitDone(t, l)
	if fi, err := os.Stat(filepath.Join(dir, "fake-login.json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("the login file: %v, %v", fi, err)
	}
	if a, err := sp.AuthStatus(shortCtx(t, 20*time.Second)); err != nil || !a.LoggedIn || a.Email != "second@example.com" {
		t.Fatalf("AuthStatus = %+v, %v", a, err)
	}
	// A code after the end is not written; the answer is how the run ended.
	if r, err := l.Code(shortCtx(t, time.Second), "other#code"); err != nil || r.State != LoginLoggedIn {
		t.Fatalf("Code after the end = %+v, %v", r, err)
	}
}

func TestLoginInvalidThenGoodCode(t *testing.T) {
	sp, _, dir := accountSpawner(t)
	defer func(d time.Duration) { codeSettle = d }(codeSettle)
	codeSettle = 200 * time.Millisecond
	l := startLogin(t, sp)
	r, err := l.Code(shortCtx(t, 20*time.Second), "abc")
	if err != nil || r.State != LoginWaiting || r.Error != "Invalid code. Please make sure the full code was copied." {
		t.Fatalf("Code(malformed) = %+v, %v", r, err)
	}
	select {
	case <-l.Done():
		t.Fatal("the run ended on a malformed code")
	default:
	}
	r, err = l.Code(shortCtx(t, 20*time.Second), "good#code")
	if err != nil || r.State != LoginLoggedIn {
		t.Fatalf("Code(good) = %+v, %v", r, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "fake-login.json")); err != nil {
		t.Fatal(err)
	}
}

func TestLoginWrongCode(t *testing.T) {
	sp, _, dir := accountSpawner(t)
	t.Setenv("FAKE_CLAUDE_LOGIN_ANSI", "1")
	l := startLogin(t, sp)
	r, err := l.Code(shortCtx(t, 20*time.Second), "abcdef#ghijkl")
	if err != nil || r.State != LoginFailed || r.Error != "Login failed: That code wasn't accepted." {
		t.Fatalf("Code = %+v, %v", r, err)
	}
	waitDone(t, l)
	if _, err := os.Stat(filepath.Join(dir, "fake-login.json")); !os.IsNotExist(err) {
		t.Fatalf("a login file: %v", err)
	}
	if r2, err := l.Code(shortCtx(t, time.Second), "good#code"); err != nil || r2 != r {
		t.Fatalf("Code after the end = %+v, %v; want %+v", r2, err, r)
	}
}

func TestLoginCancel(t *testing.T) {
	sp, hr, dir := accountSpawner(t)
	l := startLogin(t, sp)
	l.Cancel()
	waitDone(t, l)
	l.Cancel()
	if n := hr.Kills(0); n != 1 {
		t.Fatalf("Kill called %d times, want 1", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "fake-login.json")); !os.IsNotExist(err) {
		t.Fatalf("a login file: %v", err)
	}
	if r, err := l.Code(shortCtx(t, time.Second), "good#code"); err != nil || r.State != LoginFailed || r.Error != "The login was cancelled." {
		t.Fatalf("Code after Cancel = %+v, %v", r, err)
	}
}

// Cancel from another goroutine while a Code waits ends that Code with the run.
func TestLoginCancelDuringCode(t *testing.T) {
	sp, hr, _ := accountSpawner(t)
	defer func(d time.Duration) { codeSettle = d }(codeSettle)
	codeSettle = time.Minute
	l := startLogin(t, sp)
	go func() {
		time.Sleep(200 * time.Millisecond)
		l.Cancel()
	}()
	r, err := l.Code(shortCtx(t, 20*time.Second), "abc")
	if err != nil || r.State != LoginFailed || r.Error != "The login was cancelled." {
		t.Fatalf("Code = %+v, %v", r, err)
	}
	waitDone(t, l)
	if n := hr.Kills(0); n != 1 {
		t.Fatalf("Kill called %d times, want 1", n)
	}
}

// ctx of a Code ending is its error, and the run goes on.
func TestLoginCodeContext(t *testing.T) {
	sp, hr, _ := accountSpawner(t)
	defer func(d time.Duration) { codeSettle = d }(codeSettle)
	codeSettle = time.Minute
	l := startLogin(t, sp)
	if _, err := l.Code(shortCtx(t, 300*time.Millisecond), "abc"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	select {
	case <-l.Done():
		t.Fatal("the run ended")
	case <-time.After(100 * time.Millisecond):
	}
	if n := hr.Kills(0); n != 0 {
		t.Fatalf("Kill called %d times", n)
	}
	codeSettle = 200 * time.Millisecond
	if r, err := l.Code(shortCtx(t, 20*time.Second), "good#code"); err != nil || r.State != LoginLoggedIn {
		t.Fatalf("Code(good) = %+v, %v", r, err)
	}
	if _, err := l.Code(context.Background(), "a\nb"); err == nil {
		t.Fatal("a code of two lines was taken")
	}
}

// The limit counts from the start of the run, so it covers the fake's Node start too. A limit
// short enough to keep the test quick can run out before the URL under the load of the whole
// suite ("ended without a login URL"); then the test tries again with twice the limit, so that
// what it checks is the limit ending a run that is waiting for its code.
func TestLoginTimeLimit(t *testing.T) {
	sp, hr, _ := accountSpawner(t)
	defer func(d time.Duration) { loginLimit = d }(loginLimit)
	t.Setenv("FAKE_CLAUDE_LOGIN_STATE", fakeState)
	var l *Login
	for limit := time.Second; l == nil; limit *= 2 {
		if limit > 16*time.Second {
			t.Fatal("the login never printed its URL within its time limit")
		}
		loginLimit = limit
		var err error
		l, err = sp.StartLogin(shortCtx(t, 20*time.Second))
		if err != nil && !strings.Contains(err.Error(), "without a login URL") {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		l.Cancel()
		<-l.Done()
	})
	waitDone(t, l)
	if n := hr.Kills(len(hr.Calls()) - 1); n != 1 { // the run of the last try
		t.Fatalf("Kill called %d times, want 1", n)
	}
	if r, _ := l.Code(shortCtx(t, time.Second), "good#code"); r.State != LoginFailed || !strings.Contains(r.Error, "longer than") {
		t.Fatalf("Code after the limit = %+v", r)
	}
}

func TestLoginRunnerError(t *testing.T) {
	sp, hr, _ := accountSpawner(t)
	hr.Err = errors.New("Docker is not running")
	if l, err := sp.StartLogin(shortCtx(t, 5*time.Second)); !errors.Is(err, hr.Err) || l != nil {
		t.Fatalf("StartLogin = %v, %v", l, err)
	}
}

func TestLoginEndsWithoutURL(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(bin, []byte("#!/bin/sh\necho 'Opening browser to sign in…'\necho 'Error: no network' >&2\nexit 1\n"), 0o755)
	sp := &Spawner{Bin: bin, Runner: &agenttest.HostRunner{}}
	l, err := sp.StartLogin(shortCtx(t, 10*time.Second))
	if err == nil || l != nil || !strings.Contains(err.Error(), "Error: no network") {
		t.Fatalf("StartLogin = %v, %v", l, err)
	}
}

func TestLoginNoURLWithinContext(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "claude")
	os.WriteFile(bin, []byte("#!/bin/sh\necho 'Opening browser to sign in…'\nexec sleep 30\n"), 0o755)
	hr := &agenttest.HostRunner{}
	sp := &Spawner{Bin: bin, Runner: hr}
	start := time.Now()
	l, err := sp.StartLogin(shortCtx(t, 300*time.Millisecond))
	if err == nil || l != nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("StartLogin = %v, %v", l, err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Errorf("StartLogin took %s", took)
	}
	if n := hr.Kills(0); n != 1 {
		t.Fatalf("Kill called %d times, want 1", n)
	}
}

// Nothing of the URL or of a code reaches the log, whatever happens.
func TestLoginLogsNothing(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	defer func(d time.Duration) { codeSettle = d }(codeSettle)
	codeSettle = 200 * time.Millisecond

	sp, _, _ := accountSpawner(t)
	t.Setenv("FAKE_CLAUDE_LOGIN_ANSI", "1")
	t.Setenv("FAKE_CLAUDE_LOGIN_CODE", "secret#good")
	l := startLogin(t, sp)
	l.Code(shortCtx(t, 20*time.Second), "secretbad")
	l.Code(shortCtx(t, 20*time.Second), "secret#wrong")
	l2 := startLogin(t, sp)
	l2.Code(shortCtx(t, 20*time.Second), "secret#good")
	sp.AuthStatus(shortCtx(t, 20*time.Second))
	for _, s := range []string{fakeState, "claude.example", "secret"} {
		if strings.Contains(buf.String(), s) {
			t.Errorf("the log holds %q:\n%s", s, buf.String())
		}
	}
}

func TestCleanTerminal(t *testing.T) {
	for _, tc := range []struct{ name, in, want string }{
		{"plain", "a b\nc", "a b\nc"},
		{"crlf", "one\r\ntwo\r\n", "one\ntwo\n"},
		{"csi", "\x1b[?25l\x1b[2Ka\x1b[1;32mb\x1b[0m\x1b[?25h", "ab"},
		{"osc8 bel", "go: \x1b]8;;https://x.example/a\x07https://x.example/a\x1b]8;;\x07 now", "go: https://x.example/a now"},
		{"osc8 st", "go: \x1b]8;;https://x.example/a\x1b\\https://x.example/a\x1b]8;;\x1b\\\n", "go: https://x.example/a\n"},
		{"cut csi", "ab\x1b[?2", "ab"},
		{"cut osc", "ab\x1b]8;;https://x", "ab"},
		{"charset and others", "\x1b(Ba\x1b7b\x1b=c\x07\x08", "abc"},
		{"utf-8 and tab", "sign in…\tok", "sign in…\tok"},
	} {
		if got := cleanTerminal([]byte(tc.in)); got != tc.want {
			t.Errorf("%s: cleanTerminal(%q) = %q, want %q", tc.name, tc.in, got, tc.want)
		}
	}
}

func TestFindLoginURL(t *testing.T) {
	const u = "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&state=Ab-_9"
	for _, tc := range []struct {
		name, in string
		ended    bool
		url      string
		complete bool
	}{
		{"none", "Opening browser to sign in…\n", false, "", false},
		{"then prompt", "visit: " + u + "\nPaste code here if prompted > ", false, u, true},
		{"text after on its line", "visit: " + u + " (or paste)", false, u, true},
		{"newline not yet followed", "visit: " + u + "\n", false, u, false},
		{"its line still written", "visit: " + u, false, u, false},
		{"ended", "visit: " + u, true, u, true},
		{"wrapped", "visit: " + u[:30] + "\n" + u[30:60] + "\n" + u[60:] + "\nPaste code here if prompted > ", false, u, true},
		{"wrapped, padded", "visit: " + u[:30] + "   \n" + u[30:] + "  \n\n", false, u, true},
		{"wrapped, rest not ended", "visit: " + u[:30] + "\n" + u[30:], false, u, false},
		{"not joined: text with spaces", "visit: " + u + "\nPaste code here", false, u, true},
		{"not joined: after an empty line", "visit: " + u + "\n\nabc\n", false, u, true},
	} {
		url, complete := findLoginURL(tc.in, tc.ended)
		if url != tc.url || complete != tc.complete {
			t.Errorf("%s: findLoginURL = %q, %v; want %q, %v", tc.name, url, complete, tc.url, tc.complete)
		}
	}
	// A cleaned terminal stream with an OSC 8 link around a wrapped URL.
	raw := "visit: \x1b]8;;" + u + "\x07" + u[:20] + "\r\n" + u[20:] + "\x1b]8;;\x1b\\\r\n\x1b[?25hPaste code here if prompted > "
	if url, ok := findLoginURL(cleanTerminal([]byte(raw)), false); url != u || !ok {
		t.Errorf("from a terminal: %q, %v", url, ok)
	}
}

func TestLastLine(t *testing.T) {
	for _, tc := range []struct{ in, skip, want string }{
		{"\nInvalid code. Please make sure the full code was copied.\n", "abc", "Invalid code. Please make sure the full code was copied."},
		{"abc\nInvalid code.\n\n", "abc", "Invalid code."},
		{"Invalid code.\nabc\n", "abc", "Invalid code."},
		{"Paste code here if prompted > Login failed: no.\n", "", "Login failed: no."},
		{"Paste code here if prompted > ", "", ""},
		{"", "", ""},
	} {
		if got := lastLine(tc.in, tc.skip); got != tc.want {
			t.Errorf("lastLine(%q, %q) = %q, want %q", tc.in, tc.skip, got, tc.want)
		}
	}
}

func TestShQuote(t *testing.T) {
	if got := shQuote("/opt/my tools/it's claude"); got != `'/opt/my tools/it'\''s claude'` {
		t.Fatalf("shQuote = %s", got)
	}
}

// The login command, run by sh: util-linux `script` around the program when `script` is
// util-linux's, else the program itself; a path with a space and a quote reaches it intact.
func TestLoginArgv(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "my tools", "it's claude")
	os.MkdirAll(filepath.Dir(bin), 0o755)
	os.WriteFile(bin, []byte("#!/bin/sh\necho \"ran: $*\"\n"), 0o755)

	argv := loginArgv(bin, false)
	if argv[0] != "/bin/sh" || argv[1] != "-c" || argv[3] != "sh" || argv[4] != bin {
		t.Fatalf("argv = %q", argv)
	}
	want := `if script --version 2>/dev/null | grep -q util-linux; then exec script -qfec 'stty cols 2000 -echo 2>/dev/null; exec '\''` +
		strings.ReplaceAll(bin, "'", `'\''\'\'''\''`) + `'\'' auth login' /dev/null; fi; exec "$1" auth login`
	if argv[2] != want {
		t.Fatalf("script:\n%s\nwant:\n%s", argv[2], want)
	}
	if d := loginArgv(bin, true); !slices.Equal(d, []string{bin, "auth", "login"}) {
		t.Fatalf("direct argv = %q", d)
	}

	run := func(scriptStub string) string {
		t.Helper()
		stubs := t.TempDir()
		os.WriteFile(filepath.Join(stubs, "script"), []byte(scriptStub), 0o755)
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Env = append(os.Environ(), "PATH="+stubs+":"+os.Getenv("PATH"))
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		return string(out)
	}
	// util-linux: `script -qfec CMD /dev/null` runs CMD with a shell, as the stub does.
	utilLinux := "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'script from util-linux 2.39.3'; exit 0; fi\n" +
		"[ \"$1\" = -qfec ] && [ \"$3\" = /dev/null ] || { echo \"bad args: $*\"; exit 9; }\necho via-script\nexec /bin/sh -c \"$2\"\n"
	if got := run(utilLinux); got != "via-script\nran: auth login\n" {
		t.Errorf("with util-linux script: %q", got)
	}
	bsd := "#!/bin/sh\necho 'script: illegal option -- -' >&2\nexit 1\n"
	if got := run(bsd); got != "ran: auth login\n" {
		t.Errorf("with another script: %q", got)
	}
}
