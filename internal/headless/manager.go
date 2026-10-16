// Package headless starts and stops the headless writer: a Node process on the server's machine that
// holds boards like a window does, with no screen, for the agent calls that no window answers
// (architecture D28–D36, plans/headless-board/architecture.md).
//
// The server does not edit scenes itself (goal 4.3): the process is a client of the client API, with the
// server's secret, a client id of its own and its level, like any app. This package only finds a Node and
// the bundle, starts the process when an agent's call needs it, gives it its credentials on its stdin,
// and stops it when it holds nothing. It tells the bridge which client id is the headless writer.
package headless

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"ai-whiteboard/internal/agent"
)

// QuietDefault is how long the process keeps a board after an agent's last call on it, until M1 measures it
// (architecture D26, goal 8).
const QuietDefault = 60 * time.Second

const (
	startLimitDefault = 20 * time.Second
	lingerDefault     = 5 * time.Second
	retryDefault      = 60 * time.Second
	handoverDefault   = 8 * time.Second

	// stopGrace is how long a stopping process has after its stdin is closed, and termGrace after SIGTERM,
	// before the next signal (D35).
	stopGrace = 3 * time.Second
	termGrace = 2 * time.Second

	// startTries bounds how often Ensure starts a process in one call, when each one is gone again as soon as
	// it is up.
	startTries = 3
)

// ErrUnavailable is what Ensure returns when the headless writer cannot run here (no Node, no bundle, a
// start that failed). The error wraps it and says why. The relay tells agents in the words of 2.10.
var ErrUnavailable = errors.New("the headless writer is not available")

// Bridge is what the manager needs of the editor bridge.
type Bridge interface {
	// Known reports whether the client has a stream open.
	Known(clientID string) bool
	// SetAway names the client id of the headless writer, "" for none.
	SetAway(clientID string)
	// HoldsAny reports whether the client holds a board.
	HoldsAny(clientID string) bool
	// HasCalls reports whether a board call is open on the client.
	HasCalls(clientID string) bool
}

// BoardCounter is what a Bridge may offer in addition: how many boards the client holds, for Status. Without
// it Status tells 1 for a client that holds any, and 0 for none.
type BoardCounter interface {
	HeldCount(clientID string) int
}

// Listener is where the process connects, and how it proves itself.
type Listener struct {
	Port        int           // the client port of this server, on 127.0.0.1
	Fingerprint string        // the certificate's fingerprint the process pins
	Secret      func() string // the server's current secret, read at each start
	InstanceID  string        // the server's instance id
}

// Options configures a Manager. A zero duration is the default: Quiet 60 s, StartLimit 20 s, Linger 5 s,
// Retry 60 s, Handover 8 s.
type Options struct {
	Node       string        // -headless-node: the program to run, "" to look for one (D33)
	Dir        string        // -headless-dir: the bundle folder, "" to look for it (D34)
	Quiet      time.Duration // how long the process keeps a board after the last call on it (D26)
	StartLimit time.Duration // how long a start may take until the process's stream is open (D31)
	Linger     time.Duration // how often a running process is looked at for the idle stop (D28)
	Retry      time.Duration // how long a failed start is remembered (D31)
	Handover   time.Duration // what the process may take to yield a board (D17)
	Env        []string      // "KEY=value" entries added to the server's environment for the process
	Logf       func(format string, args ...any)
}

// Status is what `ai-whiteboard status -json` tells under "headless" (D36).
type Status struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason"`
	Running   bool   `json:"running"`
	PID       int    `json:"pid"`
	Boards    int    `json:"boards"`
}

// Manager keeps at most one headless writer process.
type Manager struct {
	b Bridge
	l Listener
	o Options

	look  lookups
	newID func() string
	now   func() time.Time
	// stopGrace and termGrace are the waits of the stop sequence; variables of the manager so that a test
	// need not wait them out.
	stopGrace, termGrace time.Duration

	quit chan struct{} // closed by Close

	mu          sync.Mutex
	cur         *proc // the process that is starting or running, nil for none
	awayID      string
	failed      error // why the last start failed, remembered until failedUntil
	failedUntil time.Time
	closed      bool
}

// proc is one process.
type proc struct {
	id   string
	pid  atomic.Int64
	up   chan struct{} // closed when the start has ended, well or not
	done chan struct{} // closed when the process has exited

	// set by the start goroutine before up is closed / by the waiter before done is closed
	startErr error
	started  bool
	exitErr  error

	cmd      *exec.Cmd
	stdin    io.WriteCloser
	out      *tail
	stopping atomic.Bool // stop or a kill was ordered, so its exit is no surprise
	idle     int         // looks in a row that found it holding nothing; under Manager.mu
}

// New returns a manager. Nothing is looked up or started until Ensure.
func New(b Bridge, l Listener, o Options) *Manager {
	if o.Quiet <= 0 {
		o.Quiet = QuietDefault
	}
	if o.StartLimit <= 0 {
		o.StartLimit = startLimitDefault
	}
	if o.Linger <= 0 {
		o.Linger = lingerDefault
	}
	if o.Retry <= 0 {
		o.Retry = retryDefault
	}
	if o.Handover <= 0 {
		o.Handover = handoverDefault
	}
	if o.Logf == nil {
		o.Logf = log.Printf
	}
	return &Manager{
		b: b, l: l, o: o,
		look:      systemLookups(),
		newID:     newUUID,
		now:       time.Now,
		stopGrace: stopGrace,
		termGrace: termGrace,
		quit:      make(chan struct{}),
	}
}

// Ensure returns the client id of a running headless writer whose stream is open, starting the process when
// none runs (D31). Callers at the same time share one start. A start that failed is remembered for the retry
// wait: until then Ensure fails at once with the same error, which wraps ErrUnavailable and says why.
func (m *Manager) Ensure(ctx context.Context) (string, error) {
	for try := 0; try < startTries; try++ {
		m.mu.Lock()
		if m.closed {
			m.mu.Unlock()
			return "", fmt.Errorf("%w: the server is stopping", ErrUnavailable)
		}
		if m.cur == nil && m.failed != nil && m.now().Before(m.failedUntil) {
			err := m.failed
			m.mu.Unlock()
			return "", err
		}
		p := m.cur
		if p == nil {
			p = &proc{up: make(chan struct{}), done: make(chan struct{})}
			m.cur = p
			go m.start(p)
		}
		m.mu.Unlock()

		select {
		case <-p.up:
		case <-ctx.Done():
			return "", ctx.Err()
		}
		if p.startErr != nil {
			return "", p.startErr
		}
		m.mu.Lock()
		if m.cur == p {
			if m.b.Known(p.id) {
				p.idle = 0 // a call is about to use it
				m.mu.Unlock()
				return p.id, nil
			}
			// Up once, and its stream is gone: it is ending. Let it go and start another.
			m.cur = nil
			m.mu.Unlock()
			go m.stop(p)
			continue
		}
		m.mu.Unlock()
	}
	return "", fmt.Errorf("%w: the process stopped as often as it was started", ErrUnavailable)
}

// CallTimedOut tells the manager that a call on the headless writer did not answer in time: it is stuck,
// and is killed (D29). Its stream ends, the bridge frees its boards and fails its calls, and the next
// Ensure starts a new process.
func (m *Manager) CallTimedOut() {
	m.mu.Lock()
	p := m.cur
	m.cur = nil
	m.mu.Unlock()
	if p == nil {
		return
	}
	<-p.up
	if p.startErr == nil {
		p.stopping.Store(true)
		m.o.Logf("headless writer: a call did not answer in time, the process is killed")
		agent.SignalGroup(p.cmd, syscall.SIGKILL)
	}
}

// Close stops the process, if one runs, and refuses every Ensure from now on. Call it after the bridge's
// StopAndFlush, which gives the process its chance to save (D35).
func (m *Manager) Close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	close(m.quit)
	p := m.cur
	m.cur = nil
	m.mu.Unlock()
	if p == nil {
		return
	}
	<-p.up
	if p.startErr == nil {
		m.stop(p)
	}
}

// Status tells whether the headless writer can run here and whether it does. It starts nothing; it looks for
// the runtime and the bundle when no process runs and no failure is remembered.
func (m *Manager) Status() Status {
	m.mu.Lock()
	p, failed, until := m.cur, m.failed, m.failedUntil
	var id string
	if p != nil {
		id = p.id
	}
	m.mu.Unlock()
	var s Status
	if p != nil {
		s.Available = true
		s.Running = true
		s.PID = int(p.pid.Load())
		if m.b.Known(id) {
			if c, ok := m.b.(BoardCounter); ok {
				s.Boards = c.HeldCount(id)
			} else if m.b.HoldsAny(id) {
				s.Boards = 1
			}
		}
		return s
	}
	if failed != nil && m.now().Before(until) {
		s.Reason = reasonOf(failed)
		return s
	}
	if _, err := m.locate(); err != nil {
		s.Reason = err.Error()
		return s
	}
	s.Available = true
	return s
}

func reasonOf(err error) string {
	return strings.TrimPrefix(err.Error(), ErrUnavailable.Error()+": ")
}

// unavailable wraps reason in ErrUnavailable.
func unavailable(reason string) error { return fmt.Errorf("%w: %s", ErrUnavailable, reason) }

// watch is the idle stop of D28. Every Linger it asks whether the process holds a board or has a call open;
// two looks in a row that find neither stop it. (A look, and no hook on the last release: a process whose
// first call went to a window that took the board meanwhile never holds anything, and must stop too.)
func (m *Manager) watch(p *proc) {
	t := time.NewTicker(m.o.Linger)
	defer t.Stop()
	for {
		select {
		case <-p.done:
			return
		case <-m.quit:
			return
		case <-t.C:
		}
		m.mu.Lock()
		if m.cur != p {
			m.mu.Unlock()
			return
		}
		if m.b.HoldsAny(p.id) || m.b.HasCalls(p.id) {
			p.idle = 0
		} else {
			p.idle++
		}
		stopNow := p.idle >= 2
		if stopNow {
			m.cur = nil
		}
		m.mu.Unlock()
		if stopNow {
			m.o.Logf("headless writer: it holds no board, it is stopped")
			m.stop(p)
			return
		}
	}
}

// newUUID makes a version 4 UUID, the shape of a client id.
func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
