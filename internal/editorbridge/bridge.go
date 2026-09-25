// Package editorbridge is the server's line to the one active client (the
// browser tab that owns the Excalidraw engine): server→client over SSE,
// client→server over plain POSTs routed here by the HTTP layer.
//
// Only one client is active at a time. A newly connecting client takes over:
// the active one is asked to release (so it can save its pending changes) and
// is cut off after a short handover delay if it does not answer.
//
// The package imports nothing from this project.
package editorbridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// handoverDelay is how long the active client has to release after a
// takeover before it is cut off anyway.
const handoverDelay = 3 * time.Second

// pingEvery is how often an idle SSE stream gets a comment line.
const pingEvery = 20 * time.Second

// Bridge holds the active client, a client waiting to take over, and the
// board calls in flight.
type Bridge struct {
	mu       sync.Mutex
	active   *client
	pending  *client
	rpcs     sync.Map // rpc id → *call
	seq      atomic.Int64
	snapshot func() any // the full state for a newly active client
	flushed  chan struct{}
	handover *time.Timer

	handoverAfter time.Duration // handoverDelay; shorter in tests
}

type client struct {
	id     string
	ch     chan []byte   // buffered 4096
	done   chan struct{} // closed to end its SSE stream
	closed bool          // done is closed; guarded by Bridge.mu
}

type call struct {
	client string
	reply  chan RPCReply
}

// RPCReply is a client's answer to an rpc event (POST /api/rpc-reply).
type RPCReply struct {
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// ErrNoClient is returned by Call when no client is active, and given to the
// calls of a client that goes away.
var ErrNoClient = errors.New("the board isn't open: the AI Whiteboard window is closed")

// New makes a Bridge. snapshot returns the full state sent to a newly active
// client; it must marshal to a JSON object (or be nil). It is called with the
// bridge's lock held, so it must not call back into the Bridge.
func New(snapshot func() any) *Bridge {
	return &Bridge{
		snapshot:      snapshot,
		flushed:       make(chan struct{}, 1),
		handoverAfter: handoverDelay,
	}
}

// ServeSSE serves GET /api/events?client=<id>.
func (b *Bridge) ServeSSE(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("client")
	if id == "" {
		http.Error(w, "missing client", http.StatusBadRequest)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	c := &client{id: id, ch: make(chan []byte, 4096), done: make(chan struct{})}
	b.mu.Lock()
	switch {
	case b.active == nil:
		b.active = c
		b.welcomeLocked(c)
	case b.active.id == id: // the same tab reconnecting
		old := b.active
		b.closeLocked(old)
		b.active = c
		b.welcomeLocked(c)
	default: // another tab: take over
		if b.pending != nil {
			b.sendLocked(b.pending, event{"type": "superseded"})
			b.closeLocked(b.pending)
		}
		b.pending = c
		b.sendLocked(c, event{"type": "hello", "active": false, "waiting": true})
		b.sendLocked(b.active, event{"type": "release_request"})
		if b.handover != nil {
			b.handover.Stop()
		}
		b.handover = time.AfterFunc(b.handoverAfter, b.promote)
	}
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.active == c {
			b.active = nil
			b.failCalls(c.id)
			if b.pending != nil {
				b.promoteLocked()
			}
		}
		if b.pending == c {
			b.pending = nil
		}
	}()

	write := func(msg []byte) {
		fmt.Fprintf(w, "data: %s\n\n", msg)
	}
	w.WriteHeader(http.StatusOK)
	fl.Flush()
	tick := time.NewTicker(pingEvery)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-c.done:
			// Deliver what was queued before the close (e.g. "superseded").
			for {
				select {
				case msg := <-c.ch:
					write(msg)
				default:
					fl.Flush()
					return
				}
			}
		case msg := <-c.ch:
			write(msg)
			fl.Flush()
		case <-tick.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// Release serves POST /api/client/release: the active client has saved its
// pending changes and hands over to the waiting client at once.
func (b *Bridge) Release(clientID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active != nil && b.active.id == clientID && b.pending != nil {
		b.promoteLocked()
	}
}

// IsActive reports whether clientID is the active client.
func (b *Bridge) IsActive(clientID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.active != nil && b.active.id == clientID
}

// IsPending reports whether clientID is the client waiting to take over.
func (b *Bridge) IsPending(clientID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.pending != nil && b.pending.id == clientID
}

// Broadcast sends ev to the active client only. It never blocks.
func (b *Bridge) Broadcast(ev any) {
	msg, err := json.Marshal(ev)
	if err != nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active != nil {
		b.sendRawLocked(b.active, msg)
	}
}

// Call asks the active client to run method (a board tool) and waits for its
// answer.
func (b *Bridge) Call(method string, params any, timeout time.Duration) (json.RawMessage, error) {
	id := fmt.Sprintf("rpc_%d", b.seq.Add(1))
	msg, err := json.Marshal(event{"type": "rpc", "id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	c := b.active
	if c == nil {
		b.mu.Unlock()
		return nil, ErrNoClient
	}
	k := &call{client: c.id, reply: make(chan RPCReply, 1)}
	b.rpcs.Store(id, k)
	defer b.rpcs.Delete(id)
	b.sendRawLocked(c, msg)
	b.mu.Unlock()

	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case r := <-k.reply:
		if r.Error != "" {
			return nil, errors.New(r.Error)
		}
		return r.Result, nil
	case <-t.C:
		return nil, fmt.Errorf("the board did not answer %s in %s", method, timeout)
	}
}

// Reply serves POST /api/rpc-reply: it resolves the call with that id.
func (b *Bridge) Reply(id string, r RPCReply) {
	if v, ok := b.rpcs.LoadAndDelete(id); ok {
		select {
		case v.(*call).reply <- r:
		default:
		}
	}
}

// StopAndFlush tells the active client the server is stopping and waits for
// it to report its pending saves written (Flushed) or for the timeout.
func (b *Bridge) StopAndFlush(timeout time.Duration) {
	b.mu.Lock()
	hasClient := b.active != nil
	b.mu.Unlock()
	if !hasClient {
		return
	}
	// Drop a stale signal from before this stop.
	select {
	case <-b.flushed:
	default:
	}
	b.Broadcast(event{"type": "server_stopping"})
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case <-b.flushed:
	case <-t.C:
	}
}

// Flushed serves POST /api/client/flushed.
func (b *Bridge) Flushed() {
	select {
	case b.flushed <- struct{}{}:
	default:
	}
}

type event map[string]any

// promote is the handover timer's callback.
func (b *Bridge) promote() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.promoteLocked()
}

// promoteLocked makes the pending client active, cutting off the old one.
func (b *Bridge) promoteLocked() {
	if b.handover != nil {
		b.handover.Stop()
		b.handover = nil
	}
	if b.pending == nil {
		return
	}
	if old := b.active; old != nil {
		b.sendLocked(old, event{"type": "superseded"})
		b.failCalls(old.id)
		b.closeLocked(old)
	}
	b.active = b.pending
	b.pending = nil
	b.welcomeLocked(b.active)
}

// welcomeLocked sends hello(active) and the snapshot to a newly active client.
func (b *Bridge) welcomeLocked(c *client) {
	b.sendLocked(c, event{"type": "hello", "active": true, "waiting": false})
	snap := map[string]json.RawMessage{}
	if b.snapshot != nil {
		if raw, err := json.Marshal(b.snapshot()); err == nil {
			_ = json.Unmarshal(raw, &snap) // a non-object snapshot is dropped
		}
	}
	if snap == nil {
		snap = map[string]json.RawMessage{}
	}
	snap["type"] = json.RawMessage(`"snapshot"`)
	msg, err := json.Marshal(snap)
	if err != nil {
		return
	}
	b.sendRawLocked(c, msg)
}

func (b *Bridge) sendLocked(c *client, ev any) {
	msg, err := json.Marshal(ev)
	if err != nil {
		return
	}
	b.sendRawLocked(c, msg)
}

// sendRawLocked queues msg without blocking. A full buffer drops the message
// and closes the stream, so the client reconnects and gets a fresh snapshot.
func (b *Bridge) sendRawLocked(c *client, msg []byte) {
	if c.closed {
		return
	}
	select {
	case c.ch <- msg:
	default:
		b.closeLocked(c)
	}
}

func (b *Bridge) closeLocked(c *client) {
	if !c.closed {
		c.closed = true
		close(c.done)
	}
}

// failCalls ends every call waiting on clientID with ErrNoClient.
func (b *Bridge) failCalls(clientID string) {
	b.rpcs.Range(func(key, v any) bool {
		k := v.(*call)
		if k.client == clientID {
			if _, ok := b.rpcs.LoadAndDelete(key); ok {
				select {
				case k.reply <- RPCReply{Error: ErrNoClient.Error()}:
				default:
				}
			}
		}
		return true
	})
}
