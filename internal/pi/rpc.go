// Package pi is the agent adapter for the pi coding agent (pi --mode rpc), one process per chat,
// spoken to over LF-delimited JSONL on stdio.
package pi

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

// readerSize is the read buffer. ReadBytes accumulates across buffer refills, so lines larger
// than this still work; the size only bounds how often the buffer is refilled.
const readerSize = 1 << 20

// rpcResponse is one `{"type":"response",...}` line of pi's RPC protocol.
type rpcResponse struct {
	Command string          `json:"command"`
	ID      string          `json:"id"`
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
}

// rpcPending is one in-flight command: a blocking call's channel, or a read-loop handler (the
// settled-stats request, which must not block the read loop).
type rpcPending struct {
	ch chan rpcResponse
	fn func(rpcResponse)
}

// rpcClient is the stdio JSONL client of one pi RPC process. The read loop is the only goroutine
// that resolves responses; callers write commands and wait on their pending entry.
type rpcClient struct {
	w       io.WriteCloser
	writeMu sync.Mutex

	mu      sync.Mutex
	pending map[string]rpcPending
	seq     uint64

	onEvent  func([]byte)  // called by the read loop for every non-response line
	readDone chan struct{} // closed when the read loop ends (stdout EOF)
}

func newRPC(w io.WriteCloser, onEvent func([]byte)) *rpcClient {
	return &rpcClient{w: w, pending: map[string]rpcPending{}, onEvent: onEvent, readDone: make(chan struct{})}
}

// nextID returns a unique command id with a readable prefix.
func (c *rpcClient) nextID(prefix string) string {
	c.mu.Lock()
	c.seq++
	n := c.seq
	c.mu.Unlock()
	return fmt.Sprintf("%s-%d", prefix, n)
}

// writeJSON writes one compact JSON line under the write mutex.
func (c *rpcClient) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.w.Write(append(b, '\n'))
	return err
}

// send writes a command with an id and no waiting. It is used for commands whose response is
// irrelevant (abort).
func (c *rpcClient) send(command string, fields map[string]any) error {
	id := c.nextID(command)
	m := commandFields(command, id, fields)
	return c.writeJSON(m)
}

// call writes a command and waits for its response, the read loop ending, or the timeout.
func (c *rpcClient) call(command string, fields map[string]any, timeout time.Duration) (rpcResponse, error) {
	id := c.nextID(command)
	ch := make(chan rpcResponse, 1)
	c.mu.Lock()
	c.pending[id] = rpcPending{ch: ch}
	c.mu.Unlock()
	if err := c.writeJSON(commandFields(command, id, fields)); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return rpcResponse{}, err
	}
	var timer <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		timer = t.C
	}
	select {
	case r := <-ch:
		return r, nil
	case <-c.readDone:
		return rpcResponse{}, errors.New("pi exited before answering")
	case <-timer:
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return rpcResponse{}, fmt.Errorf("pi did not answer %s within %s", command, timeout)
	}
}

// expect writes a command and runs fn in the read loop when its response arrives. It never
// blocks: the settled handler uses it so the reader is not stalled on a round trip.
func (c *rpcClient) expect(command string, fields map[string]any, fn func(rpcResponse)) error {
	id := c.nextID(command)
	c.mu.Lock()
	c.pending[id] = rpcPending{fn: fn}
	c.mu.Unlock()
	if err := c.writeJSON(commandFields(command, id, fields)); err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return err
	}
	return nil
}

// commandFields builds the JSON object of one command: type and id, then the caller's fields.
func commandFields(command, id string, fields map[string]any) map[string]any {
	m := make(map[string]any, len(fields)+2)
	m["type"] = command
	m["id"] = id
	for k, v := range fields {
		m[k] = v
	}
	return m
}

// readLoop reads LF-delimited lines until stdout ends. Splitting only on '\n' is deliberate:
// pi's framing forbids treating U+2028/U+2029 as newlines. Malformed lines and unknown ids are
// ignored, never fatal.
func (c *rpcClient) readLoop(stdout io.Reader) {
	defer close(c.readDone)
	br := bufio.NewReaderSize(stdout, readerSize)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			c.handleLine(line)
		}
		if err != nil {
			return
		}
	}
}

// handleLine dispatches one wire line: responses go to their pending entry, everything else to
// onEvent. Only the read loop calls it.
func (c *rpcClient) handleLine(raw []byte) {
	line := trimLine(raw)
	if len(line) == 0 {
		return
	}
	var head struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(line, &head) != nil {
		return // a malformed line is skipped, never breaks the stream
	}
	if head.Type != "response" {
		if c.onEvent != nil {
			c.onEvent(line)
		}
		return
	}
	var resp rpcResponse
	if json.Unmarshal(line, &resp) != nil || resp.ID == "" {
		return // an unknown response shape is ignored
	}
	c.mu.Lock()
	p, ok := c.pending[resp.ID]
	if ok {
		delete(c.pending, resp.ID)
	}
	c.mu.Unlock()
	if !ok {
		return
	}
	if p.fn != nil {
		p.fn(resp)
		return
	}
	if p.ch != nil {
		p.ch <- resp // buffered: never blocks the read loop
	}
}

// trimLine strips one trailing LF and one CR, leaving the rest of the bytes alone.
func trimLine(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\n' {
		b = b[:n-1]
	}
	if n := len(b); n > 0 && b[n-1] == '\r' {
		b = b[:n-1]
	}
	return b
}
