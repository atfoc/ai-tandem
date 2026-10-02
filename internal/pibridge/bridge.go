// Package pibridge is the app-owned board bridge: one owner-only Unix-socket
// listener per app server, a run registry keyed by random per-run bridge
// handles, and routing of extension frames to the owning run handler.
//
// The wire contract is frozen in internal/agent/bridge.go; the pi extension
// asset lives in internal/pibridge/extension and is embedded by embed.go. The
// per-run handle is an internal, non-secret identifier for frame routing,
// permissions/notices, subagent-tree abort and run lifecycle; it is not an MCP
// credential and is not mapped to the board token. Board tool calls carry the
// chat's durable board token in the Authorization header of the HTTP MCP
// endpoint.
package pibridge

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"

	"ai-whiteboard/internal/agent"
)

// Bridge is the app-owned single-listener bridge. Create it with New, Start it
// once, and Close it on shutdown. Register/DeregisterRun are called by the pi
// adapter per run.
type Bridge struct {
	path string

	mu     sync.Mutex
	runs   map[string]*run
	ln     net.Listener
	closed bool
}

// run is one registered chat run. Its connections (ask/activity calls and live
// control connections) are tracked for abort pushes and deregistration.
type run struct {
	chatID  string
	handler agent.RunHandler

	mu    sync.Mutex
	conns map[*bridgeConn]struct{}
}

// bridgeConn is one accepted extension connection. Writes are serialized; the
// connection may be attached to at most one run at a time.
type bridgeConn struct {
	net.Conn

	writeMu sync.Mutex
	runMu   sync.Mutex
	run     *run
}

var _ agent.BridgeRegistry = (*Bridge)(nil)

// maxFrameBytes bounds one LF-delimited frame. Larger frames close the
// connection.
const maxFrameBytes = 16 << 20 // 16 MiB

// SocketPath returns the bridge socket path under the app data root. Unix
// socket paths must fit in sockaddr_un.sun_path: 104 bytes on macOS (including
// the terminating NUL, so ~103 usable) and 108 on Linux. When <root>/bridge.sock
// would exceed 100 bytes it falls back to a short owner-only directory under
// os.TempDir() keyed by a hash of root, so restarts reuse the same path.
func SocketPath(root string) string {
	path := filepath.Join(root, "bridge.sock")
	if len(path) <= 100 {
		return path
	}
	sum := sha256.Sum256([]byte(root))
	return filepath.Join(os.TempDir(), "aiwb-"+hex.EncodeToString(sum[:8]), "bridge.sock")
}

// New returns an unstarted bridge that listens on socketPath (see SocketPath).
func New(socketPath string) *Bridge {
	return &Bridge{
		path: socketPath,
		runs: map[string]*run{},
	}
}

// Start creates the parent directory (0700), removes a stale socket file,
// listens on the Unix socket (0600) and accepts connections until Close.
func (b *Bridge) Start() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return errors.New("pibridge: bridge is closed")
	}
	if b.ln != nil {
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()

	dir := filepath.Dir(b.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	if err := os.Remove(b.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	ln, err := net.Listen("unix", b.path)
	if err != nil {
		return err
	}
	if err := os.Chmod(b.path, 0o600); err != nil {
		ln.Close()
		return err
	}

	b.mu.Lock()
	if b.closed { // Close won the race.
		b.mu.Unlock()
		ln.Close()
		os.Remove(b.path)
		return errors.New("pibridge: bridge is closed")
	}
	b.ln = ln
	b.mu.Unlock()

	go b.acceptLoop(ln)
	return nil
}

// Close stops accepting, closes every connection and removes the socket file.
// It is safe to call twice.
func (b *Bridge) Close() {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	ln := b.ln
	b.ln = nil
	runs := make([]*run, 0, len(b.runs))
	for _, r := range b.runs {
		runs = append(runs, r)
	}
	b.runs = map[string]*run{}
	b.mu.Unlock()

	if ln != nil {
		ln.Close()
	}
	for _, r := range runs {
		r.closeConns()
	}
	if b.path != "" {
		os.Remove(b.path)
	}
}

func (b *Bridge) acceptLoop(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go b.serveConn(c)
	}
}

func (b *Bridge) lookup(token string) *run {
	if token == "" {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.runs[token]
}

// RegisterRun mints a random 32-hex per-run bridge handle, records the run and
// returns the socket path and handle. Registering the same chat id again
// deregisters the previous run and closes its connections.
func (b *Bridge) RegisterRun(chatID string, handler agent.RunHandler) (socketPath, runToken string, err error) {
	token, err := newRunToken()
	if err != nil {
		return "", "", err
	}
	r := &run{chatID: chatID, handler: handler, conns: map[*bridgeConn]struct{}{}}

	b.mu.Lock()
	var old *run
	for tok, existing := range b.runs {
		if existing.chatID == chatID {
			old = existing
			delete(b.runs, tok)
			break
		}
	}
	b.runs[token] = r
	path := b.path
	b.mu.Unlock()

	if old != nil {
		old.closeConns()
	}
	return path, token, nil
}

// DeregisterRun forgets a run and closes its connections.
func (b *Bridge) DeregisterRun(runToken string) {
	b.mu.Lock()
	r := b.runs[runToken]
	delete(b.runs, runToken)
	b.mu.Unlock()
	if r != nil {
		r.closeConns()
	}
}

// AbortRun pushes an abort frame to every live connection of the run.
func (b *Bridge) AbortRun(runToken string) {
	r := b.lookup(runToken)
	if r == nil {
		return
	}
	for _, c := range r.snapshotConns() {
		c.writeJSON(map[string]any{"kind": agent.FrameAbort, "run": runToken})
	}
}

func newRunToken() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

func (r *run) addConn(c *bridgeConn) {
	r.mu.Lock()
	r.conns[c] = struct{}{}
	r.mu.Unlock()
}

func (r *run) removeConn(c *bridgeConn) {
	r.mu.Lock()
	delete(r.conns, c)
	r.mu.Unlock()
}

func (r *run) snapshotConns() []*bridgeConn {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]*bridgeConn, 0, len(r.conns))
	for c := range r.conns {
		out = append(out, c)
	}
	return out
}

func (r *run) closeConns() {
	r.mu.Lock()
	conns := make([]*bridgeConn, 0, len(r.conns))
	for c := range r.conns {
		conns = append(conns, c)
	}
	r.conns = map[*bridgeConn]struct{}{}
	r.mu.Unlock()
	for _, c := range conns {
		c.Conn.Close()
	}
}

func (c *bridgeConn) setRun(r *run) {
	c.runMu.Lock()
	old := c.run
	c.run = r
	c.runMu.Unlock()
	if old == r {
		return
	}
	if old != nil {
		old.removeConn(c)
	}
	if r != nil {
		r.addConn(c)
	}
}

func (c *bridgeConn) detach() {
	c.runMu.Lock()
	old := c.run
	c.run = nil
	c.runMu.Unlock()
	if old != nil {
		old.removeConn(c)
	}
}

func (c *bridgeConn) writeJSON(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.Conn.Write(append(data, '\n'))
	return err
}

// serveConn reads LF-delimited frames until the peer closes, a frame is too
// large, or a frame carries an unknown bridge handle (then the connection is
// closed without dispatch). Every frame must name a registered run.
func (b *Bridge) serveConn(conn net.Conn) {
	c := &bridgeConn{Conn: conn}
	defer func() {
		c.detach()
		conn.Close()
	}()

	br := bufio.NewReaderSize(conn, 64<<10)
	for {
		line, err := readFrame(br)
		if err != nil {
			return
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var frame agent.BridgeFrame
		if err := json.Unmarshal(line, &frame); err != nil {
			c.writeJSON(map[string]any{"ok": false, "error": "bad frame"})
			continue
		}
		r := b.lookup(frame.Run)
		if r == nil {
			return
		}
		c.setRun(r)
		b.dispatch(c, r, frame)
	}
}

// dispatch answers one frame. It never holds the registry lock while calling a
// handler.
func (b *Bridge) dispatch(c *bridgeConn, r *run, frame agent.BridgeFrame) {
	switch frame.Kind {
	case agent.FrameAsk:
		if r.handler == nil {
			c.writeJSON(map[string]any{"id": frame.ID, "ok": false, "error": "no run handler"})
			return
		}
		allow, reason := r.handler.Permission(frame.ID, frame.Name, frame.Input, frame.Sub)
		c.writeJSON(map[string]any{"id": frame.ID, "ok": true, "allow": allow, "reason": reason})

	case agent.FrameActivity:
		if r.handler == nil {
			c.writeJSON(map[string]any{"id": frame.ID, "ok": false, "error": "no run handler"})
			return
		}
		var act agent.SubActivity
		if len(frame.Event) > 0 {
			if err := json.Unmarshal(frame.Event, &act); err != nil {
				c.writeJSON(map[string]any{"id": frame.ID, "ok": false, "error": "bad activity: " + err.Error()})
				return
			}
		}
		r.handler.Activity(frame.Sub, act)
		c.writeJSON(map[string]any{"id": frame.ID, "ok": true})

	case agent.FrameHello:
		c.writeJSON(map[string]any{"id": frame.ID, "ok": true})

	case agent.FrameNotice:
		if r.handler == nil {
			c.writeJSON(map[string]any{"id": frame.ID, "ok": false, "error": "no run handler"})
			return
		}
		r.handler.Notice(frame.Error)
		c.writeJSON(map[string]any{"id": frame.ID, "ok": true})

	default:
		c.writeJSON(map[string]any{"id": frame.ID, "ok": false, "error": "unknown kind " + frame.Kind})
	}
}

// readFrame reads one LF-terminated frame, accumulating slices so the buffer
// size stays bounded by maxFrameBytes.
func readFrame(br *bufio.Reader) ([]byte, error) {
	var line []byte
	for {
		chunk, err := br.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > maxFrameBytes {
			return nil, errors.New("pibridge: frame too large")
		}
		if err == nil {
			return line, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		return nil, err
	}
}
