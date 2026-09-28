package cursor

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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
	r       io.Reader
	wmu     sync.Mutex
	seq     atomic.Int64
	pending sync.Map // int64 id → chan msg

	OnNotify  func(method string, params json.RawMessage)
	OnRequest func(id json.RawMessage, method string, params json.RawMessage)

	start   sync.Once
	stderr  *tailBuffer
	done    chan struct{} // closed once the process has exited and stdout is drained
	waitErr error
}

// Start runs bin with args in dir, with the server's environment unchanged, in a process group of
// its own (agent.StartGroup).
func Start(bin string, args []string, dir string) (*Conn, error) {
	cmd := exec.Command(bin, args...)
	cmd.Dir = dir
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
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.w.Write(append(b, '\n'))
	return err
}

// Call sends a request and waits for its response.
func (c *Conn) Call(method string, params any) (json.RawMessage, error) {
	id := c.seq.Add(1)
	ch := make(chan msg, 1)
	c.pending.Store(id, ch)
	if err := c.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		c.pending.Delete(id)
		return nil, fmt.Errorf("%s: %w", method, err)
	}
	select {
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

// Close closes stdin, kills the process if it has not exited after 3 s, and waits for it.
func (c *Conn) Close() {
	c.run()
	c.wmu.Lock()
	c.w.Close()
	c.wmu.Unlock()
	select {
	case <-c.done:
	case <-time.After(3 * time.Second):
		c.cmd.Process.Kill()
		<-c.done
	}
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
