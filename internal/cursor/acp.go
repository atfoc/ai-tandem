package cursor

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"ai-whiteboard/internal/agent"
)

// msg is one JSON-RPC 2.0 message (request, notification or response).
type msg struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  json.RawMessage `json:"error,omitempty"`
}

// Conn is a JSON-RPC 2.0 client over the stdio of one `agent acp` process.
// Set OnNotify and OnRequest before the first Call, Notify or Wait: reading starts then.
type Conn struct {
	cmd     *exec.Cmd
	w       io.WriteCloser
	r       io.ReadCloser
	wmu     sync.Mutex
	seq     atomic.Int64
	pending sync.Map // int64 id → chan msg

	deadline atomic.Int64 // Unix nanoseconds; 0 = a Call waits without limit (SetDeadline)

	OnNotify  func(method string, params json.RawMessage)
	OnRequest func(id json.RawMessage, method string, params json.RawMessage)

	// EndStarted: Close also ends the process groups the process's descendants lead (Cursor starts
	// each shell command as the leader of a group of its own). Set before Close.
	EndStarted bool

	start   sync.Once
	ending  sync.Once
	stderr  *tailBuffer
	done    chan struct{} // closed once the process has exited and stdout is drained
	waitErr error
}

// Start runs bin with args in dir, in a process group of its own (agent.StartGroup).
// extraEnv is "KEY=value" entries appended to os.Environ() so the rest of the environment is
// kept; pass none to inherit the server environment unchanged (Catalog/probe). App-spawned chats
// pass CURSOR_DATA_DIR. Do not pass HOME (redirection breaks login) or CURSOR_CONFIG_DIR (it does
// not move the ACP hook path).
func Start(bin string, args []string, dir string, extraEnv ...string) (*Conn, error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	w, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	r, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	c := &Conn{cmd: cmd, w: w, r: r, stderr: &tailBuffer{max: 4096}, done: make(chan struct{})}
	cmd.Stderr = c.stderr
	// Once the process has exited, Wait gives its stderr this long to end: something the process
	// left behind may hold it open.
	cmd.WaitDelay = outputGrace
	if err := agent.StartGroup(cmd); err != nil {
		return nil, err
	}
	return c, nil
}

// run starts the read loop once. Starting it lazily (from the first write or Wait) orders the
// handler fields' assignment before any read of them.
func (c *Conn) run() { c.start.Do(func() { go c.readLoop() }) }

func (c *Conn) readLoop() {
	sc := bufio.NewScanner(c.r)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		recordACP("<-", sc.Bytes())
		var m msg
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			continue
		}
		hasID := len(m.ID) > 0 && string(m.ID) != "null"
		switch {
		case m.Method != "" && hasID:
			if c.OnRequest != nil {
				c.OnRequest(m.ID, m.Method, m.Params)
			} else {
				c.Reply(m.ID, nil, map[string]any{"code": -32601, "message": "method not found"})
			}
		case m.Method != "":
			if c.OnNotify != nil {
				c.OnNotify(m.Method, m.Params)
			}
		case hasID:
			id, err := strconv.ParseInt(string(m.ID), 10, 64)
			if err != nil {
				continue
			}
			if ch, ok := c.pending.LoadAndDelete(id); ok {
				ch.(chan msg) <- m
			}
		}
	}
	io.Copy(io.Discard, c.r)
	err := c.cmd.Wait()
	agent.Exited(c.cmd)
	if errors.Is(err, exec.ErrWaitDelay) {
		err = nil // the process itself exited without an error; only its stderr was still held
	}
	if err != nil {
		if tail := c.stderr.lastLine(); tail != "" {
			err = fmt.Errorf("%w: %s", err, tail)
		}
	}
	c.waitErr = err
	close(c.done)
}

func (c *Conn) write(m map[string]any) error {
	c.run()
	m["jsonrpc"] = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	recordACP("->", b)
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.w.Write(append(b, '\n'))
	return err
}

// SetDeadline puts a time limit on the calls started from now on: a Call with no response at t
// fails. The request is not withdrawn, so the caller then closes the connection. The zero time
// removes the limit; ordinary chat calls have none (a turn is one call).
func (c *Conn) SetDeadline(t time.Time) {
	if t.IsZero() {
		c.deadline.Store(0)
		return
	}
	c.deadline.Store(t.UnixNano())
}

// Call sends a request and waits for its response, until the deadline when one is set.
func (c *Conn) Call(method string, params any) (json.RawMessage, error) {
	var late <-chan time.Time
	if d := c.deadline.Load(); d != 0 {
		t := time.NewTimer(time.Until(time.Unix(0, d)))
		defer t.Stop()
		late = t.C
	}
	id := c.seq.Add(1)
	ch := make(chan msg, 1)
	c.pending.Store(id, ch)
	if err := c.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		c.pending.Delete(id)
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	select {
	case <-late:
		c.pending.Delete(id)
		return nil, fmt.Errorf("%s: Cursor did not answer in time", method)
	case m := <-ch:
		if len(m.Error) > 0 && string(m.Error) != "null" {
			return nil, fmt.Errorf("%s: %s", method, rpcErrorText(m.Error))
		}
		return m.Result, nil
	case <-c.done:
		c.pending.Delete(id)
		return nil, fmt.Errorf("%s: Cursor exited", method)
	}
}

// Notify sends a notification.
func (c *Conn) Notify(method string, params any) error {
	return c.write(map[string]any{"method": method, "params": params})
}

// Reply answers a request from the agent with a result, or with rpcErr when it is not nil.
func (c *Conn) Reply(id json.RawMessage, result any, rpcErr any) error {
	m := map[string]any{"id": id}
	if rpcErr != nil {
		m["error"] = rpcErr
	} else {
		m["result"] = result
	}
	return c.write(m)
}

// Wait waits for the process to exit and returns its exit error (with the last stderr line).
func (c *Conn) Wait() error {
	c.run()
	<-c.done
	return c.waitErr
}

// How long Close waits at each step. `agent acp` rarely exits when its stdin closes, so that
// wait is short; a SIGTERM ends it within a fraction of a second.
var (
	closeStdinGrace = 300 * time.Millisecond // for the process to exit by itself once stdin is closed
	closeTermGrace  = 3 * time.Second        // for the process to exit after SIGTERM
	closeRestGrace  = 300 * time.Millisecond // for the rest of its group once the process has exited
	closeKillGrace  = time.Second            // for everything to be gone after SIGKILL
)

// outputGrace is how long the stderr of a process that has exited is still read: a process it
// started and Close did not reach can hold the pipe open for as long as it runs.
const outputGrace = time.Second

// Close ends the process and everything in its process group, and waits for it: stdin is closed;
// what is still there a moment later gets SIGTERM, and what outlives that SIGKILL. The group is
// signalled, not the process alone: Cursor's worker-server and its language servers run in it and
// would otherwise stay for minutes. With EndStarted the groups led by the process's descendants
// (shell commands, also ones running in the background) get the same signals.
//
// Only groups this process started are signalled: its own through agent.SignalGroup, which knows
// the groups StartGroup made and forgets them when they are empty, and its descendants' as they
// were found while the process was still there (agent.StartedGroups): when Close begins, and
// again before each of the two signals, since a turn that is still running starts commands until
// the process ends. A command that detached itself from the process is not found and stays.
//
// Close does not wait for such a survivor: if the process was killed and its output has still not
// ended a moment later, the output is given up, so that the exit is reported.
func (c *Conn) Close() {
	c.run()
	c.ending.Do(c.end)
	<-c.done
}

func (c *Conn) end() {
	var started []int
	// collect adds the groups the process's descendants lead now. Once the process has been waited
	// for it finds none, so what was found earlier stays.
	collect := func() {
		if !c.EndStarted {
			return
		}
		for _, pgid := range agent.StartedGroups(c.cmd, c.done) {
			if !slices.Contains(started, pgid) {
				started = append(started, pgid)
			}
		}
	}
	collect()
	// signal reports whether anything it signalled is still there (signal 0 only asks).
	signal := func(sig syscall.Signal) bool {
		own := agent.SignalGroup(c.cmd, sig)
		return agent.SignalStarted(started, sig) || own
	}
	exited := func() bool {
		select {
		case <-c.done:
			return true
		default:
			return false
		}
	}
	// until waits for cond, at most d.
	until := func(d time.Duration, cond func() bool) {
		for deadline := time.Now().Add(d); !cond() && time.Now().Before(deadline); {
			time.Sleep(10 * time.Millisecond)
		}
	}

	c.wmu.Lock()
	c.w.Close()
	c.wmu.Unlock()
	until(closeStdinGrace, exited)
	collect()
	if !signal(syscall.SIGTERM) && exited() {
		return // the process exited by itself and left nothing
	}
	until(closeTermGrace, exited)
	until(closeRestGrace, func() bool { return exited() && !signal(0) })
	collect()
	killed := signal(syscall.SIGKILL)
	if killed {
		until(closeKillGrace, func() bool { return exited() && !signal(0) })
	}
	if exited() {
		return
	}
	// Not ended yet: no signal reached its group, or its output is held open. The process itself
	// is killed, as before.
	c.cmd.Process.Kill()
	if !killed {
		until(closeKillGrace, exited)
	}
	if !exited() {
		// The process is killed, but something it started that no signal here reached still holds
		// its output open. Nothing the process wrote is lost by not reading on: the read loop
		// ends, and the process is waited for.
		c.r.Close()
	}
}

// recordACP appends one redacted ACP line ("->" sent, "<-" received) to the file named by
// AIWB_CURSOR_ACP_LOG, when that variable is set. It is a debug/trace aid used by the e2e suite
// to prove what the adapter sent Cursor; it is off in normal runs and never records anything by
// default.
//
// Only a safe projection is written: the method of each frame (so method order is provable) and,
// for an outgoing session/prompt, its prompt text. A frame's raw params are never written, so the
// board token in a session/new or session/load mcpServers Authorization header cannot reach the
// file. The file is opened and closed per write, keyed by the path in the environment, so a later
// path (as tests change it) can never be served by a stale handle.
var acpLogMu sync.Mutex

func recordACP(direction string, line []byte) {
	path := os.Getenv("AIWB_CURSOR_ACP_LOG")
	if path == "" {
		return
	}
	out, ok := redactACP(direction, line)
	if !ok {
		return
	}
	acpLogMu.Lock()
	defer acpLogMu.Unlock()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_ = f.Chmod(0o600) // OpenFile's mode only applies on creation
	_, _ = f.Write(out)
}

// redactACP projects one ACP frame to the safe trace line "direction {json}". It keeps the
// frame's method and, for an outgoing prompt, the prompt text; the raw params (which carry the
// Authorization header on a board handshake) are dropped. It reports false for a frame that is
// not JSON, has no method, or cannot be projected.
func redactACP(direction string, line []byte) ([]byte, bool) {
	var m msg
	if err := json.Unmarshal(line, &m); err != nil || m.Method == "" {
		return nil, false
	}
	out := map[string]any{"method": m.Method}
	if m.Method == "session/prompt" {
		var p struct {
			Prompt json.RawMessage `json:"prompt"`
		}
		if json.Unmarshal(m.Params, &p) == nil && len(p.Prompt) > 0 {
			out["params"] = map[string]any{"prompt": p.Prompt}
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil, false
	}
	return append(append([]byte(direction+" "), b...), '\n'), true
}

// rpcErrorText turns a JSON-RPC error object into its message (plus data when present).
func rpcErrorText(raw json.RawMessage) string {
	var e struct {
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &e) != nil || e.Message == "" {
		return string(raw)
	}
	if len(e.Data) > 0 && string(e.Data) != "null" {
		return e.Message + " " + string(e.Data)
	}
	return e.Message
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = t.b[len(t.b)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) lastLine() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(string(t.b)), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

var errNotReady = errors.New("Cursor session is not ready yet")
