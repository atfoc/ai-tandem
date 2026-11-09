package container

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Error is a call to Docker that Docker answered with an error which is none of the reasons of
// an *Unavailable: a container or image it does not have, a folder Docker Desktop does not share,
// a create or start it refused. Its text is Docker's own (its lines joined, the "Run 'docker …
// --help'" hints left out), so that a "mounts denied: The path /x is not shared" names the folder.
type Error struct {
	Op   string // the docker command: "create", "start", "inspect", "image inspect", "build", "pull", …
	Line string // what Docker said

	stderr string // all Docker wrote on stderr (build: its output)
}

func (e *Error) Error() string { return e.Line }

// The messages of a docker program whose daemon does not answer (lower case).
var notRunningLines = []string{
	"cannot connect to the docker daemon",
	"failed to connect to the docker api",
	"is the docker daemon running",
	"error during connect",
}

// waitDelay is how long a docker program that was killed (its time limit, or its caller gave
// up) may keep its output open before we stop waiting for it.
const waitDelay = 500 * time.Millisecond

// stopGrace is what `docker stop -t 3` and `docker rm -f` are given beyond the quick limit: the
// 3 s stop waits for the container's processes before it kills them, and the time a kill and a
// removal may take.
const stopGrace = 3 * time.Second

var (
	errUnsupported    = Unavailable{Kind: Unsupported, Reason: "Claude accounts need a macOS or Linux server"}
	errNotInstalled   = Unavailable{Kind: NotInstalled, Reason: "Docker is not installed"}
	errNotRunning     = Unavailable{Kind: NotRunning, Reason: "Docker is not running"}
	errNotLookedAtYet = Unavailable{Kind: NotRunning, Reason: "Docker has not been looked at yet"}
)

func unavailable(u Unavailable) *Unavailable { return &u }

func windows() bool { return runtime.GOOS == "windows" }

func (m *Manager) bin() string {
	if m.Bin == "" {
		return "docker"
	}
	return m.Bin
}

func (m *Manager) quickLimit() time.Duration {
	if m.Timeout > 0 {
		return m.Timeout
	}
	return QuickTimeout
}

// docker runs the docker program with args (stdin, when not nil, on its standard input) and
// returns its standard output. A quick call is bounded by the quick limit (Timeout); the others
// (create, build and pull) only by ctx.
//
// The error is ctx's when ctx ended first; an *Unavailable when Docker cannot be used (stored
// as Available, as a success, or an answer such as "No such container", stores nil); else an
// *Error with Docker's line.
func (m *Manager) docker(ctx context.Context, quick bool, stdin []byte, args ...string) ([]byte, error) {
	out, err := m.run(ctx, quick, stdin, args)
	var u *Unavailable
	var de *Error
	switch {
	case err == nil:
		m.setAvailable(nil)
	case errors.As(err, &u):
		m.setAvailable(u)
	case len(args) > 0 && args[0] == "version" && errors.As(err, &de):
		u = &Unavailable{Kind: Failed, Reason: de.Line}
		m.setAvailable(u)
		err = u
	case answered(err):
		m.setAvailable(nil)
	}
	return out, err
}

// run runs docker and classifies its failure; it stores nothing.
func (m *Manager) run(ctx context.Context, quick bool, stdin []byte, args []string) ([]byte, error) {
	if windows() {
		return nil, unavailable(errUnsupported)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cctx := ctx
	if quick {
		limit := m.quickLimit()
		if len(args) > 0 && (args[0] == "stop" || args[0] == "rm") {
			limit += stopGrace
		}
		var cancel context.CancelFunc
		cctx, cancel = context.WithTimeout(ctx, limit)
		defer cancel()
	}
	cmd := exec.CommandContext(cctx, m.bin(), args...)
	cmd.Env = os.Environ()
	cmd.WaitDelay = waitDelay
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err == nil {
		return stdout.Bytes(), nil
	}
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		return nil, unavailable(errNotInstalled)
	}
	if ctx.Err() != nil {
		return stdout.Bytes(), ctx.Err()
	}
	if quick && errors.Is(cctx.Err(), context.DeadlineExceeded) {
		return stdout.Bytes(), unavailable(errNotRunning)
	}
	low := strings.ToLower(stderr.String())
	for _, l := range notRunningLines {
		if strings.Contains(low, l) {
			return stdout.Bytes(), unavailable(errNotRunning)
		}
	}
	op := ""
	if len(args) > 0 {
		op = args[0]
		if op == "image" && len(args) > 1 {
			op += " " + args[1]
		}
	}
	line := dockerLine(stderr.String())
	if line == "" {
		line = fmt.Sprintf("docker %s: %v", op, err)
	}
	return stdout.Bytes(), &Error{Op: op, Line: line, stderr: stderr.String()}
}

// dockerLine is what Docker wrote on stderr as one line: its non-empty lines joined by spaces,
// without the hints to run `docker … --help`, at most 1000 bytes.
func dockerLine(stderr string) string {
	var keep []string
	for _, l := range strings.Split(stderr, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "Run 'docker") || strings.HasPrefix(l, "See 'docker") {
			continue
		}
		keep = append(keep, l)
	}
	s := strings.Join(keep, " ")
	if len(s) > 1000 {
		s = s[:1000] + "…"
	}
	return s
}

// answeredLines are the errors of Docker that the Manager's calls take as an answer (no container,
// a stopped one, no image): Docker can be used.
var answeredLines = []string{"No such container", "is not running", "No such image"}

func answered(err error) bool {
	for _, l := range answeredLines {
		if hasLine(err, l) {
			return true
		}
	}
	return false
}

// hasLine reports whether err is an *Error whose text holds s (case-insensitive).
func hasLine(err error, s string) bool {
	var de *Error
	return errors.As(err, &de) && strings.Contains(strings.ToLower(de.Line), strings.ToLower(s))
}

func sameAvailable(a, b error) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	ua, _ := IsUnavailable(a)
	ub, _ := IsUnavailable(b)
	if ua == nil || ub == nil {
		return a.Error() == b.Error()
	}
	return ua.Kind == ub.Kind && ua.Reason == ub.Reason
}

// setAvailable stores what a call found (nil or an *Unavailable) and, when that changes what
// Available returns, wakes every Watch.
func (m *Manager) setAvailable(u *Unavailable) {
	m.mu.Lock()
	before := m.availableLocked()
	m.looked = true
	if u == nil {
		m.avail = nil
	} else {
		c := *u
		m.avail = &c
	}
	after := m.availableLocked()
	var wake []chan struct{}
	if !sameAvailable(before, after) {
		for ch := range m.watchers {
			wake = append(wake, ch)
		}
	}
	m.mu.Unlock()
	for _, ch := range wake {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

func (m *Manager) availableLocked() error {
	switch {
	case windows():
		return unavailable(errUnsupported)
	case !m.looked:
		return unavailable(errNotLookedAtYet)
	case m.avail == nil:
		return nil
	}
	c := *m.avail
	return &c
}

// Available is whether Docker can be used, as last looked (nil, or an *Unavailable). It never
// waits on Docker: the look is made by Refresh, by Watch every so often, and by any call to
// Docker (one that ended for want of Docker stores why, one that succeeded stores nil). Before
// the first look it is &Unavailable{Kind: NotRunning, Reason: "Docker has not been looked at
// yet"}; on Windows it is always the Unsupported one.
func (m *Manager) Available() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.availableLocked()
}

// Refresh looks now (`docker version`, within the quick limit) and returns what Available
// returns from then on. When ctx ends first nothing is stored and Available's answer is returned.
func (m *Manager) Refresh(ctx context.Context) error {
	m.docker(ctx, true, nil, "version", "--format", "{{.Server.Version}}")
	return m.Available()
}

// Watch looks at once and then every `every` until stop is closed, and calls changed (from its
// own goroutine, no lock held) with the new answer of Available after each change of it,
// whoever found it (a look of its own, Refresh, or any other call to Docker); the first answer
// is compared with Available's when Watch was called. Changes that follow each other quickly
// may be told once, with the latest answer. Several Watch may run at once. It returns once stop
// is closed.
func (m *Manager) Watch(every time.Duration, stop <-chan struct{}, changed func(error)) {
	wake := make(chan struct{}, 1)
	m.mu.Lock()
	if m.watchers == nil {
		m.watchers = map[chan struct{}]struct{}{}
	}
	m.watchers[wake] = struct{}{}
	last := m.availableLocked()
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.watchers, wake)
		m.mu.Unlock()
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	tell := func() {
		now := m.Available()
		if !sameAvailable(now, last) {
			last = now
			changed(now)
		}
	}
	look := func() {
		m.Refresh(ctx)
		select {
		case <-stop:
		default:
			tell()
		}
	}

	look()
	if every <= 0 {
		every = time.Minute
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			look()
		case <-wake:
			select {
			case <-stop:
				return
			default:
				tell()
			}
		}
	}
}

// lock takes the account's lock and returns its unlock.
func (m *Manager) lock(alias string) func() {
	m.mu.Lock()
	if m.locks == nil {
		m.locks = map[string]*sync.Mutex{}
	}
	l := m.locks[alias]
	if l == nil {
		l = &sync.Mutex{}
		m.locks[alias] = l
	}
	m.mu.Unlock()
	l.Lock()
	return l.Unlock
}
