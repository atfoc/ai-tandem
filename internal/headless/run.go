package headless

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/version"
)

// config is the one JSON line the process reads on its stdin, and nowhere else: not argv, not the
// environment (D32). The process calls the client API with it like any app.
type config struct {
	Address     string `json:"address"`     // 127.0.0.1:<client port>
	Fingerprint string `json:"fingerprint"` // the certificate's fingerprint to pin
	Secret      string `json:"secret"`
	ClientID    string `json:"clientId"`
	InstanceID  string `json:"instanceId"`
	QuietMs     int64  `json:"quietMs"`
	HandoverMs  int64  `json:"handoverMs"`
	Version     string `json:"version"`
}

// pollEvery is how often a start looks whether the process's stream is open.
const pollEvery = 10 * time.Millisecond

// located is a runtime and a bundle that can be used.
type located struct {
	Runtime Runtime
	Bundle  Bundle
}

// locate finds what a start needs. Its error is the reason the headless writer is not available.
func (m *Manager) locate() (located, error) {
	rt, err := findRuntime(m.o.Node, m.look)
	if err != nil {
		return located{}, err
	}
	b, err := findBundle(m.o.Dir, version.Version, m.look)
	if err != nil {
		return located{}, err
	}
	return located{rt, b}, nil
}

// start runs in its own goroutine for the process p that Ensure put in m.cur. It ends with p.up closed and
// either p.started or p.startErr (which wraps ErrUnavailable) set. A failure is remembered for the retry wait
// and logged once.
func (m *Manager) start(p *proc) {
	err := m.launch(p)
	if err == nil {
		err = m.waitUp(p)
	}
	m.mu.Lock()
	if err != nil {
		p.startErr = unavailable(err.Error())
		if m.cur == p {
			m.cur = nil
		}
		m.failed, m.failedUntil = p.startErr, m.now().Add(m.o.Retry)
		m.o.Logf("headless writer: not started: %s", err)
	} else {
		p.started = true
		m.failed = nil
		go m.watch(p)
	}
	close(p.up)
	m.mu.Unlock()
	if err != nil && p.cmd != nil {
		m.stop(p)
	}
}

// launch finds the runtime and the bundle, makes the client id, tells the bridge, starts the process in a
// group of its own and gives it its configuration (D30–D32, D35).
func (m *Manager) launch(p *proc) error {
	at, err := m.locate()
	if err != nil {
		return err
	}
	id := m.newID()
	line, err := json.Marshal(config{
		Address:     fmt.Sprintf("127.0.0.1:%d", m.l.Port),
		Fingerprint: m.l.Fingerprint,
		Secret:      m.l.Secret(),
		ClientID:    id,
		InstanceID:  m.l.InstanceID,
		QuietMs:     m.o.Quiet.Milliseconds(),
		HandoverMs:  m.o.Handover.Milliseconds(),
		Version:     version.Version,
	})
	if err != nil {
		return err
	}

	cmd := exec.Command(at.Runtime.Path, at.Bundle.Program)
	cmd.Dir = at.Bundle.Dir
	cmd.Env = append(os.Environ(), m.o.Env...)
	if at.Runtime.Electron {
		cmd.Env = append(cmd.Env, "ELECTRON_RUN_AS_NODE=1")
	}
	out := &tail{logf: m.o.Logf}
	cmd.Stdout, cmd.Stderr = out, out
	cmd.WaitDelay = 2 * time.Second // a child that keeps the pipes open does not hold Wait
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return errors.New("the server is stopping")
	}
	m.awayID = id
	p.id = id
	m.b.SetAway(id) // before the start: its stream may open at once
	m.mu.Unlock()

	if err := agent.StartGroup(cmd); err != nil {
		m.clearAway(id)
		return fmt.Errorf("the process could not be started: %v", err)
	}
	p.cmd, p.stdin, p.out = cmd, stdin, out
	p.pid.Store(int64(cmd.Process.Pid))
	go m.reap(p)
	m.o.Logf("headless writer: started %s (pid %d, %s)", at.Runtime.Path, cmd.Process.Pid, at.Runtime.Source)
	// A process that already exited does not read it; its exit is what the start reports.
	stdin.Write(append(line, '\n'))
	return nil
}

// clearAway tells the bridge that id is no longer the headless writer, unless another process has become it.
func (m *Manager) clearAway(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.awayID == id {
		m.awayID = ""
		m.b.SetAway("")
	}
}

// waitUp waits until the stream of the process is open (it opens it only after its engine said ready, so
// open means it can work), the process exits, or the start limit passes.
func (m *Manager) waitUp(p *proc) error {
	limit := time.NewTimer(m.o.StartLimit)
	defer limit.Stop()
	poll := time.NewTicker(pollEvery)
	defer poll.Stop()
	for {
		select {
		case <-p.done:
			return fmt.Errorf("the process exited while starting (%s)%s", exitText(p.exitErr), p.out.last())
		case <-m.quit:
			return errors.New("the server is stopping")
		case <-limit.C:
			return fmt.Errorf("the process did not connect within %s%s", m.o.StartLimit, p.out.last())
		case <-poll.C:
			if m.b.Known(p.id) {
				return nil
			}
		}
	}
}

// reap waits for the process, and then forgets it.
func (m *Manager) reap(p *proc) {
	err := p.cmd.Wait()
	p.out.flush()
	agent.SignalGroup(p.cmd, syscall.SIGKILL) // whatever it left behind
	agent.Exited(p.cmd)
	m.mu.Lock()
	p.exitErr = err
	if m.cur == p {
		m.cur = nil
	}
	if m.awayID == p.id {
		m.awayID = ""
		m.b.SetAway("")
	}
	logIt := p.started && !p.stopping.Load()
	m.mu.Unlock()
	if logIt {
		m.o.Logf("headless writer: the process ended by itself (%s)", exitText(err))
	}
	close(p.done)
}

// stop ends the process: its stdin is closed, which it takes as the order to save and go; then SIGTERM to
// its group, then SIGKILL (D35). It returns when the process has exited.
func (m *Manager) stop(p *proc) {
	p.stopping.Store(true)
	p.stdin.Close()
	if waitFor(p.done, m.stopGrace) {
		return
	}
	agent.SignalGroup(p.cmd, syscall.SIGTERM)
	if waitFor(p.done, m.termGrace) {
		return
	}
	agent.SignalGroup(p.cmd, syscall.SIGKILL)
	waitFor(p.done, 10*time.Second)
}

func waitFor(c <-chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-c:
		return true
	case <-t.C:
		return false
	}
}

func exitText(err error) string {
	if err == nil {
		return "exit status 0"
	}
	return err.Error()
}

// tail is the writer of the process's stdout and stderr: it logs each line, prefixed "headless:", and keeps
// the last few for the reason of a start that failed. The process prints neither the secret nor board
// content (D35); the lines are cut at maxLine in case.
type tail struct {
	logf func(string, ...any)

	mu    sync.Mutex
	part  []byte
	lines []string
}

const (
	maxLine  = 2000
	keepLast = 5
)

func (t *tail) Write(b []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.part = append(t.part, b...)
	for {
		i := bytes.IndexByte(t.part, '\n')
		if i < 0 {
			break
		}
		t.line(string(t.part[:i]))
		t.part = t.part[i+1:]
	}
	if len(t.part) > maxLine {
		t.line(string(t.part))
		t.part = nil
	}
	return len(b), nil
}

// line takes one line; under t.mu.
func (t *tail) line(s string) {
	s = strings.TrimRight(s, "\r")
	if len(s) > maxLine {
		s = s[:maxLine]
	}
	if strings.TrimSpace(s) == "" {
		return
	}
	t.logf("headless: %s", s)
	t.lines = append(t.lines, s)
	if len(t.lines) > keepLast {
		t.lines = t.lines[len(t.lines)-keepLast:]
	}
}

// flush takes the last line that had no newline.
func (t *tail) flush() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.part) > 0 {
		t.line(string(t.part))
		t.part = nil
	}
}

// last is the end of the process's output for a reason: ": line / line", or "" when it printed nothing.
func (t *tail) last() string {
	t.flush()
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.lines) == 0 {
		return ""
	}
	return ": " + strings.Join(t.lines, " / ")
}
