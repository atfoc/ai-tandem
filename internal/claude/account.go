package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"ai-whiteboard/internal/agent"
)

// What Claude Code's own login commands do for a Claude account (and, for AuthStatus, for the
// computer's own Claude Code too). Each runs through the spawner's Runner when it has one, so an
// account's run inside its container, with the account's CLAUDE_CONFIG_DIR; in the scratch folder.
// Each process is the leader of a group of its own (agent.StartGroup), so the server's stop ends it.
// Nothing Claude writes (the login URL above all) and no code is logged, and none of it goes to
// the server's own output.

// loginLimit is how long a login run may last before it is cancelled by itself. A variable so
// that a test can shorten it.
var loginLimit = 10 * time.Minute

// codeSettle is how long Code waits, after Claude has answered a code with a line and still runs,
// before it takes that line as a refusal of the code (Claude waits for another). A variable so
// that a test can shorten it.
var codeSettle = time.Second

// urlSettle is how long StartLogin waits, after a URL has reached the end of what Claude wrote
// with nothing after it, for more of it on the next line (a terminal that wraps it) before taking
// it as it is. A variable for tests.
var urlSettle = 500 * time.Millisecond

// loginOutCap is how much of a login run's output is kept; what comes after is dropped.
const loginOutCap = 64 * 1024

// Auth is what `claude auth status` reports of a login.
type Auth struct {
	LoggedIn bool   `json:"loggedIn"`
	Email    string `json:"email,omitempty"`
}

// AuthStatus runs `claude auth status` and reads its answer. A run that cannot start, does not
// answer within ctx, or answers what cannot be read is an error; a logged-out answer is not.
// Nothing of it is cached here.
//
// Claude prints its answer as JSON on stdout and exits 1 when logged out: the JSON is read
// whatever the exit status.
func (s *Spawner) AuthStatus(ctx context.Context) (Auth, error) {
	res, err := s.authRun(ctx, "status")
	if err != nil {
		return Auth{}, err
	}
	var a struct {
		LoggedIn *bool  `json:"loggedIn"`
		Email    string `json:"email"`
	}
	if !readJSON(res.stdout, &a) || a.LoggedIn == nil {
		why := firstLine(res.stderr)
		if why == "" {
			why = res.status
		}
		return Auth{}, fmt.Errorf("claude auth status: cannot read its answer (%s)", why)
	}
	return Auth{LoggedIn: *a.LoggedIn, Email: a.Email}, nil
}

// readJSON decodes the JSON object out holds into v: the whole of it, else what lies from its
// first "{" to its last "}" (a warning printed around it). It reports whether it could.
func readJSON(out string, v any) bool {
	out = strings.TrimSpace(out)
	if json.Unmarshal([]byte(out), v) == nil {
		return true
	}
	i, j := strings.IndexByte(out, '{'), strings.LastIndexByte(out, '}')
	return i >= 0 && j > i && json.Unmarshal([]byte(out[i:j+1]), v) == nil
}

// Logout runs `claude auth logout`: it removes the login of the spawner's config folder only.
// Claude exits 0 also when there was no login; any other exit is an error with Claude's line.
func (s *Spawner) Logout(ctx context.Context) error {
	res, err := s.authRun(ctx, "logout")
	if err != nil {
		return err
	}
	if res.ok {
		return nil
	}
	msg := firstLine(res.stderr)
	if msg == "" {
		msg = firstLine(res.stdout)
	}
	if msg == "" {
		return fmt.Errorf("claude auth logout: %s", res.status)
	}
	return fmt.Errorf("claude auth logout: %s (%s)", msg, res.status)
}

// authResult is what a `claude auth …` run left: whether it exited 0, its exit status as text,
// and what it wrote (capped).
type authResult struct {
	ok             bool
	status         string
	stdout, stderr string
}

// authRun runs `claude auth <what>` in the scratch folder and waits for its exit. A run that
// does not end within ctx is killed, where it runs and on the host, and is an error; one that
// ends by itself, or is never started, is released (agent.Run.Release).
func (s *Spawner) authRun(ctx context.Context, what string) (authResult, error) {
	within := "the time given"
	if dl, ok := ctx.Deadline(); ok {
		within = roundDuration(time.Until(dl)).String()
	}
	cmd, run, err := s.command(ctx, s.scratchDir(), nil, "auth", what)
	if err != nil {
		return authResult{}, err // the Runner's reason, which the person reads
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &cappedWriter{buf: &stdout, max: stderrCap}
	cmd.Stderr = &cappedWriter{buf: &stderr, max: stderrCap}
	cmd.WaitDelay = probeReapGrace
	if err := agent.StartGroup(cmd); err != nil {
		agent.ReleaseRun(run) // never started
		return authResult{}, fmt.Errorf("cannot start Claude (%s): %w", s.bin(), err)
	}
	done := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		agent.KillGroupAfterExit(cmd.Process.Pid, syscall.SIGKILL) // nothing of it is left behind
		forgetGroup(cmd)
		done <- err
	}()
	select {
	case err = <-done:
		agent.ReleaseRun(run) // waited for, ended by itself
	case <-ctx.Done():
		killRun(run)
		killHost(cmd)
		select {
		case <-done:
		case <-time.After(2 * probeReapGrace):
		}
		return authResult{}, fmt.Errorf("claude auth %s: no answer within %s", what, within)
	}
	res := authResult{stdout: stdout.String(), stderr: stderr.String(), status: "ended"}
	if cmd.ProcessState != nil {
		res.status = cmd.ProcessState.String()
		// a descendant still holding a pipe does not make a success a failure
		res.ok = cmd.ProcessState.Success() && (err == nil || errors.Is(err, exec.ErrWaitDelay))
	}
	if res.status == "ended" && err != nil {
		res.status = err.Error()
	}
	return res, nil
}

// roundDuration is d as the person reads it: whole seconds, or tenths below a second.
func roundDuration(d time.Duration) time.Duration {
	if d >= time.Second {
		return d.Round(time.Second)
	}
	return max(d.Round(100*time.Millisecond), 0)
}

// killHost ends the host process cmd started by agent.StartGroup, with its group while the
// group is remembered (it is gone, or not yet waited for). Safe once cmd was waited for.
func killHost(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	agent.SignalGroup(cmd, syscall.SIGKILL)
	cmd.Process.Kill()
}

// LoginState is where a login run is.
type LoginState string

const (
	LoginWaiting  LoginState = "waiting"   // the URL is out; Claude waits for the code
	LoginLoggedIn LoginState = "logged_in" // the run ended with success
	LoginFailed   LoginState = "failed"    // the run ended without a login
)

// LoginResult is the outcome of a step of a login run.
type LoginResult struct {
	State LoginState
	// Error is Claude's own line when it refused a code (State waiting: another code may be
	// tried) or when the run ended without a login (State failed).
	Error string
}

// Login is one run of `claude auth login`, in a pseudo-terminal where it runs, until it ends.
// Nothing of its URL or of a code is logged. Its methods may be called from any goroutine.
type Login struct {
	url   string
	cmd   *exec.Cmd
	run   *agent.Run
	stdin io.WriteCloser
	limit *time.Timer

	mu      sync.Mutex
	out     []byte        // what the run wrote (stdout and stderr), up to loginOutCap
	changed chan struct{} // closed, and replaced, when out grows or the run ends
	ended   bool          // the process was waited for
	ok      bool          // it exited 0
	status  string        // its exit status, as text
	reason  string        // why it was ended from here (Cancel, the time limit); "" = by itself

	codes  chan struct{} // holds a token while a Code runs
	cancel sync.Once
	done   chan struct{}
}

// loginOut is where a login run writes, stdout and stderr alike (one value, so one pipe).
type loginOut struct{ l *Login }

func (w loginOut) Write(b []byte) (int, error) {
	l := w.l
	l.mu.Lock()
	defer l.mu.Unlock()
	if room := loginOutCap - len(l.out); room > 0 {
		l.out = append(l.out, b[:min(len(b), room)]...)
		l.notifyLocked()
	}
	return len(b), nil
}

// notifyLocked wakes whoever waits for what the run does. l.mu held.
func (l *Login) notifyLocked() {
	close(l.changed)
	l.changed = make(chan struct{})
}

// StartLogin starts `claude auth login` and returns once Claude has printed its URL, or with
// the reason it did not (ctx bounds the wait). The run lives on until it ends by itself, Cancel,
// or ctx of the caller's Code calls; it is not bound to ctx after StartLogin returns.
//
// With a Runner the run is util-linux `script` around `claude auth login`, a pseudo-terminal
// inside the container (D21), and plain pipes where there is no such `script`; loginArgv. It is
// cancelled by itself after loginLimit.
func (s *Spawner) StartLogin(ctx context.Context) (*Login, error) {
	cmd, run, err := s.commandArgv(ctx, s.scratchDir(), nil, loginArgv(s.bin(), s.Runner == nil && runtime.GOOS == "windows"))
	if err != nil {
		return nil, err // the Runner's reason, which the person reads
	}
	l := &Login{cmd: cmd, run: run, changed: make(chan struct{}), codes: make(chan struct{}, 1), done: make(chan struct{})}
	w := loginOut{l}
	cmd.Stdout, cmd.Stderr = w, w
	cmd.WaitDelay = probeReapGrace
	if l.stdin, err = cmd.StdinPipe(); err != nil {
		agent.ReleaseRun(run) // never started
		return nil, err
	}
	if err := agent.StartGroup(cmd); err != nil {
		agent.ReleaseRun(run)
		return nil, fmt.Errorf("cannot start Claude (%s): %w", s.bin(), err)
	}
	limit := loginLimit
	l.limit = time.AfterFunc(limit, func() { l.end(fmt.Sprintf("The login took longer than %s.", limit)) })
	go l.wait()

	var quiet <-chan time.Time
	var candidate string
	for {
		l.mu.Lock()
		text, ended, changed := cleanTerminal(l.out), l.ended, l.changed
		l.mu.Unlock()
		url, complete := findLoginURL(text, ended)
		if url != "" && complete {
			l.url = url
			return l, nil
		}
		if ended {
			msg := lastLine(text, "")
			if msg == "" {
				msg = l.exitStatus()
			}
			return nil, fmt.Errorf("claude auth login ended without a login URL: %s", msg)
		}
		if url != candidate { // more of it: wait for its end afresh
			candidate, quiet = url, nil
			if url != "" {
				quiet = time.After(urlSettle)
			}
		}
		select {
		case <-changed:
		case <-quiet:
			l.url = candidate
			return l, nil
		case <-ctx.Done():
			l.Cancel()
			return nil, fmt.Errorf("claude auth login: no login URL (%w)", ctx.Err())
		}
	}
}

// wait waits for the run's process, ends what it left in its group on the host, and records the
// end: the one waiter of the process. A run that ended by itself (end did not kill it, and no
// longer will: it sees ended) is released (agent.Run.Release); a killed one was ended by its Kill.
func (l *Login) wait() {
	err := l.cmd.Wait()
	l.limit.Stop()
	agent.KillGroupAfterExit(l.cmd.Process.Pid, syscall.SIGKILL)
	l.mu.Lock()
	l.ended = true
	byItself := l.reason == "" // end sets reason, under l.mu, only before ended
	if ps := l.cmd.ProcessState; ps != nil {
		l.status = ps.String()
		l.ok = ps.Success() && (err == nil || errors.Is(err, exec.ErrWaitDelay))
	} else if err != nil {
		l.status = err.Error()
	}
	l.notifyLocked()
	l.mu.Unlock()
	if byItself {
		agent.ReleaseRun(l.run)
	}
	forgetGroup(l.cmd)
	close(l.done)
}

// exitStatus is the run's exit status as text ("exit status 1"), or "ended".
func (l *Login) exitStatus() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.status == "" {
		return "ended"
	}
	return l.status
}

// URL is the login URL Claude printed, to open in the person's browser.
func (l *Login) URL() string { return l.url }

// Code writes code and a newline to the login's terminal and waits (within ctx) for what Claude
// does with it: the run ends with a login (LoginLoggedIn), Claude refuses the code and asks for
// another (LoginWaiting with its error line), or the run ends otherwise (LoginFailed).
//
// Claude refusing a code is a line it writes after the code while it keeps running for
// codeSettle. ctx ending is ctx's error, and leaves the run as it is. Calls are served one at a
// time. A code given once the run has ended is not written anywhere: the answer is how the run
// ended (LoginLoggedIn, or LoginFailed with its last line or why it was ended), with no error.
// A code of more than one line is an error, and is not written.
func (l *Login) Code(ctx context.Context, code string) (LoginResult, error) {
	code = strings.TrimSpace(code)
	if strings.ContainsAny(code, "\r\n") {
		return LoginResult{}, errors.New("the code must be a single line")
	}
	select {
	case l.codes <- struct{}{}:
	case <-ctx.Done():
		return LoginResult{}, ctx.Err()
	}
	defer func() { <-l.codes }()

	l.mu.Lock()
	before := cleanTerminal(l.out)
	if l.ended {
		r := l.resultLocked(before, "")
		l.mu.Unlock()
		return r, nil
	}
	l.mu.Unlock()
	// A write error is not reported: the run ending says what happened.
	l.stdin.Write([]byte(code + "\n"))

	var settle <-chan time.Time
	var seen string
	for {
		l.mu.Lock()
		text, changed := cleanTerminal(l.out), l.changed
		after := text
		if strings.HasPrefix(text, before) {
			after = text[len(before):]
		}
		if l.ended {
			r := l.resultLocked(text, lastLine(after, code))
			l.mu.Unlock()
			return r, nil
		}
		l.mu.Unlock()
		if line := lastLine(after, code); line != seen {
			seen, settle = line, nil
			if line != "" && !soundsLoggedIn(line) { // a success line is followed by the exit
				settle = time.After(codeSettle)
			}
		}
		select {
		case <-changed:
		case <-settle:
			return LoginResult{State: LoginWaiting, Error: seen}, nil
		case <-ctx.Done():
			return LoginResult{}, ctx.Err()
		}
	}
}

// soundsLoggedIn reports whether line reads as Claude's success line, after which the run exits
// by itself: it is not taken as the refusal of a code however long the exit takes.
func soundsLoggedIn(line string) bool {
	l := strings.ToLower(line)
	return strings.Contains(l, "success") || strings.Contains(l, "logged in")
}

// resultLocked is how the ended run ended: logged in, or failed with why it was ended from here,
// else last (Claude's line after the code), else the last line of all of text, else the exit
// status. l.mu held.
func (l *Login) resultLocked(text, last string) LoginResult {
	if l.ok {
		return LoginResult{State: LoginLoggedIn}
	}
	msg := l.reason
	if msg == "" {
		msg = last
	}
	if msg == "" {
		msg = lastLine(text, "")
	}
	if msg == "" {
		msg = "Claude " + l.status
	}
	return LoginResult{State: LoginFailed, Error: msg}
}

// Cancel ends the run, inside the container too, and leaves the login as it was. Again is a no-op.
// It returns once the kill is delivered; Done is closed once the process is waited for.
func (l *Login) Cancel() { l.end("The login was cancelled.") }

// end kills the run, once, unless it has ended by itself; reason is what Code answers after.
func (l *Login) end(reason string) {
	l.cancel.Do(func() {
		l.mu.Lock()
		ended := l.ended
		if !ended {
			l.reason = reason
		}
		l.mu.Unlock()
		if ended {
			return
		}
		killRun(l.run)
		killHost(l.cmd)
	})
}

// Done is closed once the run has ended, whatever ended it.
func (l *Login) Done() <-chan struct{} { return l.done }

// loginArgv is the command of a login run of the program bin. It is sh, which runs bin under
// util-linux `script` (a pseudo-terminal of the place where it runs, its echo off and wide enough
// for the URL on one line) when there is one, else with plain pipes, as Claude also prints its URL
// and reads a code then. bin is quoted into the command `script` runs, and is sh's $1 for the
// other. direct (a host with no sh) is bin itself with plain pipes.
func loginArgv(bin string, direct bool) []string {
	if direct {
		return []string{bin, "auth", "login"}
	}
	inner := "stty cols 2000 -echo 2>/dev/null; exec " + shQuote(bin) + " auth login"
	script := "if script --version 2>/dev/null | grep -q util-linux; then exec script -qfec " +
		shQuote(inner) + " /dev/null; fi; exec \"$1\" auth login"
	return []string{"/bin/sh", "-c", script, "sh", bin}
}

// shQuote is s as one word of a POSIX shell command.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// commandArgv is command for a whole argv, whose argv[0] is not the spawner's program: through
// s.Runner when it has one, else on the host with this process's environment.
func (s *Spawner) commandArgv(ctx context.Context, dir string, env, argv []string) (*exec.Cmd, *agent.Run, error) {
	if s.Runner == nil {
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), env...)
		return cmd, &agent.Run{Cmd: cmd}, nil
	}
	run, err := s.Runner.Command(ctx, dir, env, argv)
	if err != nil {
		return nil, nil, err
	}
	return run.Cmd, run, nil
}
