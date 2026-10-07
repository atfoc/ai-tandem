// Package editorbridge is the server's line to its connected clients (the browser pages that
// own an Excalidraw engine, and the API clients on the remote listener): server→client over SSE,
// client→server over plain POSTs routed here by the HTTP layer.
//
// The bridge keeps one record per open stream: the boards that client holds and waits for, the
// chats and runs it follows, and the board calls it was asked. One client at a time holds a
// board. A client that takes a held board waits: the holder is asked to release (so it can save
// its pending changes) and loses the board after a short handover delay if it does not answer.
// Events go only to the clients they concern (see Events). An API client holds no board and is
// sent the types of APIEvents only, the list events by the client mark of their item (SetMark).
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

// handoverDelay is how long the holder of a board has to release it after another client took
// it, before it loses the board anyway.
const handoverDelay = 3 * time.Second

// pingEvery is how often an idle SSE stream gets a comment line.
const pingEvery = 20 * time.Second

// Kind is a kind of client. Each kind has a row in the bridge's kinds table.
type Kind string

// KindPage is a browser page.
const KindPage Kind = "page"

// KindAPI is an API client: a caller on the remote listener. It holds no board.
const KindAPI Kind = "api"

// kindRule says what the clients of one kind get.
type kindRule struct {
	allow    func(typ string) bool         // the event types a client of this kind is sent
	lists    func(c *client, it Item) bool // whether the item is in c's list
	boards   bool                          // may hold boards and be asked a board call
	snapshot func(c *client) any           // the full state for a newly connected client
}

// Bridge holds the connected clients, the holder and the waiter of each board, and the board
// calls in flight.
type Bridge struct {
	// SceneRev returns the scene revision of a board, which a grant of the board names. It is
	// called with the bridge's lock held, so it must take no lock. Nil gives 0. Set it before
	// the first request.
	SceneRev func(board string) int64

	mu         sync.Mutex
	clients    map[string]*client       // by client id: the open streams
	holders    map[string]*client       // by board
	waiters    map[string]*waiter       // by board
	freeing    map[string]chan struct{} // by board: a FreeBoard waits; closed when the board is let go
	rpcs       map[string]*call         // by rpc id
	marks      map[Item]string          // by item: its client mark, the id of the API client that made it
	kinds      map[Kind]kindRule
	logged     map[string]bool // event types already logged as outside the table
	clock      uint64          // counts the calls stamped by Acted
	seq        atomic.Int64
	snapshot   func() any         // the full state for a newly connected page
	unfollowed func(items []Item) // OnUnfollowed's hook; nil = none
	flush      chan struct{}      // poked when a client flushed or its stream ended

	handoverAfter time.Duration // handoverDelay; shorter in tests
}

type client struct {
	id     string
	kind   Kind
	ch     chan []byte   // buffered 4096
	done   chan struct{} // closed to end its SSE stream
	closed bool          // done is closed; guarded by Bridge.mu

	snap func() any // the snapshot of an API client's stream; nil for a page

	acted   uint64           // the bridge's clock at its last call with the header; 0 = only opened a stream
	holds   map[string]bool  // boards held
	waits   map[string]bool  // boards waited for
	follows map[Item]bool    // chats and runs followed
	calls   map[string]*call // open board calls by rpc id
	flushed bool             // answered server_stopping
}

// waiter is the client waiting for a held board. The timer runs from the first take of the
// board and is not restarted when another client takes the waiter's place.
type waiter struct {
	c     *client
	timer *time.Timer
}

// call is a board call in flight. board is "" for a call about one screen.
type call struct {
	client, board string
	reply         chan RPCReply
	lost          bool // failed by the bridge with ErrNoClient; set before the reply is queued
}

// RPCReply is a client's answer to an rpc event (POST /api/rpc-reply).
type RPCReply struct {
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
}

// CallSpec says what CallBoard asks and which client it asks.
type CallSpec struct {
	Method string
	Params any
	Board  string // the board the call is about: its holder is asked
	// ChatBoard is the calling chat's board. Its holder is asked when nobody holds Board, and
	// is then given Board; it is also who a Screen call asks.
	ChatBoard string
	Screen    bool // a call about one screen, not about Board
}

// ErrNoClient is returned by CallBoard when there is no client to ask, and given to the calls
// of a client that goes away or loses the board they are about.
var ErrNoClient = errors.New("the board isn't open: the AI Whiteboard window is closed")

// ErrUnknownClient is returned by TakeBoard for an id with no open stream.
var ErrUnknownClient = errors.New("unknown_client")

// New makes a Bridge. snapshot returns the full state sent to a newly connected page; it must
// marshal to a JSON object (or be nil). It is called with the bridge's lock held, so it must
// not call back into the Bridge.
func New(snapshot func() any) *Bridge {
	b := &Bridge{
		clients:       map[string]*client{},
		holders:       map[string]*client{},
		waiters:       map[string]*waiter{},
		freeing:       map[string]chan struct{}{},
		rpcs:          map[string]*call{},
		marks:         map[Item]string{},
		logged:        map[string]bool{},
		snapshot:      snapshot,
		flush:         make(chan struct{}, 1),
		handoverAfter: handoverDelay,
	}
	b.kinds = map[Kind]kindRule{
		KindPage: {
			allow:  func(typ string) bool { _, ok := Events[typ]; return ok },
			lists:  func(*client, Item) bool { return true },
			boards: true,
			snapshot: func(*client) any {
				if b.snapshot == nil {
					return nil
				}
				return b.snapshot()
			},
		},
		KindAPI: {
			allow: func(typ string) bool { return APIEvents[typ] },
			lists: func(c *client, it Item) bool { return b.marks[it] == c.id },
			snapshot: func(c *client) any {
				if c.snap == nil {
					return nil
				}
				return c.snap()
			},
		},
	}
	return b
}

// ServeSSE serves GET /api/events?client=<id>: the stream of a page.
func (b *Bridge) ServeSSE(w http.ResponseWriter, r *http.Request) {
	b.serve(w, r, KindPage)
}

// ServeAPI serves the event stream of the API client id, which the caller has checked: hello,
// then snapshot() as the snapshot event, then the events its kind's row lets through. snapshot is
// called once, with the bridge's lock held, so it must not call back into the Bridge.
func (b *Bridge) ServeAPI(w http.ResponseWriter, r *http.Request, id string, snapshot func() any) {
	b.serveAs(w, r, id, KindAPI, snapshot)
}

// serve runs the stream of a client of this kind, whose id is in the query.
func (b *Bridge) serve(w http.ResponseWriter, r *http.Request, kind Kind) {
	b.serveAs(w, r, r.URL.Query().Get("client"), kind, nil)
}

// serveAs runs the stream of the client id of this kind. A stream with a connected id of its
// own kind replaces the older one, whose record ends: the new one holds and follows nothing. An
// id that is connected with another kind is refused with 409: a page's id and an API client's
// have one form, and neither may end or pass as the other's record.
func (b *Bridge) serveAs(w http.ResponseWriter, r *http.Request, id string, kind Kind, snap func() any) {
	if id == "" {
		http.Error(w, "missing client", http.StatusBadRequest)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	c := newClient(id, kind)
	c.snap = snap
	b.mu.Lock()
	if old := b.clients[id]; old != nil && old.kind != kind {
		b.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		fmt.Fprint(w, `{"error":"client id in use","code":"client_in_use"}`)
		return
	}
	b.startLocked(c)
	b.welcomeLocked(c)
	b.mu.Unlock()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	defer func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		b.endLocked(c)
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
			// Deliver what was queued before the close.
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

func newClient(id string, kind Kind) *client {
	return &client{
		id: id, kind: kind, ch: make(chan []byte, 4096), done: make(chan struct{}),
		holds: map[string]bool{}, waits: map[string]bool{}, follows: map[Item]bool{}, calls: map[string]*call{},
	}
}

// startLocked makes c the record of its id, ending an older one.
func (b *Bridge) startLocked(c *client) {
	if old := b.clients[c.id]; old != nil {
		b.endLocked(old)
	}
	b.clients[c.id] = c
}

// Known reports whether clientID has an open stream.
func (b *Bridge) Known(clientID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.clients[clientID] != nil
}

// Acted reports whether clientID has the open stream of a page, and notes that the page made a
// call that only a page of this server can make: an /api request with the client header, which
// the server's guard reports for every method, GET and HEAD included. Only a page that acted is
// given a board or a board call that nobody holds the board of. An API client's id is not a
// known client here and is never the page that acted last: Acted reports false for it and notes
// nothing.
func (b *Bridge) Acted(clientID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	if c == nil || c.kind != KindPage {
		return false
	}
	b.stampLocked(c)
	return true
}

func (b *Bridge) stampLocked(c *client) {
	b.clock++
	c.acted = b.clock
}

// TakeBoard gives the board to the client, or starts the hand-off. state is "held" when the
// board was free or already the client's (rev is then its scene revision), "busy" when ifFree
// is set and another client holds it (nothing is sent), and "waiting" when the hand-off runs:
// an older waiter is sent superseded and replaced, the holder is asked once to release, and
// the client is sent held when the holder released, went away or stayed silent for the
// handover delay. The error is ErrUnknownClient for an id with no open stream.
func (b *Bridge) TakeBoard(clientID, board string, ifFree bool) (state string, rev int64, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	if c == nil || !b.kinds[c.kind].boards {
		return "", 0, ErrUnknownClient
	}
	b.stampLocked(c)
	h := b.holders[board]
	switch {
	case h == nil:
		return "held", b.grantLocked(c, board), nil
	case h == c:
		return "held", b.revLocked(board), nil
	case ifFree:
		return "busy", 0, nil
	}
	if w := b.waiters[board]; w != nil {
		if w.c != c {
			b.sendLocked(w.c, event{"type": "superseded", "board": board})
			delete(w.c.waits, board)
			w.c = c
			c.waits[board] = true
		}
		return "waiting", 0, nil
	}
	w := &waiter{c: c}
	w.timer = time.AfterFunc(b.handoverAfter, func() { b.handover(board, w) })
	b.waiters[board] = w
	c.waits[board] = true
	if b.freeing[board] == nil { // else FreeBoard has asked
		b.sendLocked(h, event{"type": "release_request", "board": board})
	}
	return "waiting", 0, nil
}

// CloseKind ends the stream and the record of every client of this kind, and returns how many.
// What was queued for a client is still written before its stream ends.
func (b *Bridge) CloseKind(kind Kind) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, c := range b.clients {
		if c.kind == kind {
			b.endLocked(c)
			n++
		}
	}
	return n
}

// ReleaseBoard ends the client's hold of the board. It answers "handed" when another client
// (or FreeBoard) was waiting for it: the caller is then sent superseded as well. It answers
// "free" when nobody was, and "none" when the caller did not hold the board.
func (b *Bridge) ReleaseBoard(clientID, board string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	if c == nil || !c.holds[board] {
		return "none"
	}
	if b.passLocked(board, false) {
		return "handed"
	}
	return "free"
}

// HolderOf returns the id of the client that holds the board.
func (b *Bridge) HolderOf(board string) (clientID string, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if h := b.holders[board]; h != nil {
		return h.id, true
	}
	return "", false
}

// Regrant tells the present holder of board the board's revision again, with a new held event,
// when that holder is not the client writer. The scene route calls it after it stored a write
// of a client that lost the board meanwhile: the grant named the revision before that write.
// It does nothing for a free board.
func (b *Bridge) Regrant(board, writer string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if h := b.holders[board]; h != nil && h.id != writer {
		b.sendLocked(h, event{"type": "held", "board": board, "rev": b.revLocked(board)})
	}
}

// Holds reports whether the client holds the board.
func (b *Bridge) Holds(clientID, board string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	return c != nil && c.holds[board]
}

// FreeBoard takes the board from every client, for a board that is archived or deleted. The
// holder is asked to release and has until wait to do so; then, or when it released, it is sent
// superseded and its calls on the board fail, as is a client waiting for the board. With no
// holder it returns at once.
func (b *Bridge) FreeBoard(board string, wait time.Duration) {
	b.mu.Lock()
	h := b.holders[board]
	if h == nil {
		b.mu.Unlock()
		return
	}
	gone := b.freeing[board]
	if gone == nil {
		gone = make(chan struct{})
		b.freeing[board] = gone
		if b.waiters[board] == nil { // else the waiter's take has asked
			b.sendLocked(h, event{"type": "release_request", "board": board})
		}
	}
	b.mu.Unlock()

	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case <-gone:
	case <-t.C:
		b.mu.Lock()
		if b.freeing[board] == gone {
			b.passLocked(board, true)
		}
		b.mu.Unlock()
	}
}

// CallBoard asks one client to run method (a board tool) and waits for its answer.
//
// A call about spec.Board goes to the board's holder. When nobody holds it, the holder of
// spec.ChatBoard is asked, else the page that acted last (see Acted); that client is first
// given the board and sent held. A Screen call goes to the holder of spec.ChatBoard, else to
// the page that acted last, and is about no board. With no such client the call fails with
// ErrNoClient at once. An open call fails with ErrNoClient when its client loses the board the
// call is about, or when its client's stream ends.
func (b *Bridge) CallBoard(spec CallSpec, timeout time.Duration) (json.RawMessage, error) {
	id := fmt.Sprintf("rpc_%d", b.seq.Add(1))
	msg, err := json.Marshal(event{"type": "rpc", "id": id, "method": spec.Method, "params": spec.Params})
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	c, board := b.chooseLocked(spec)
	if c == nil {
		b.mu.Unlock()
		return nil, ErrNoClient
	}
	if board != "" && b.holders[board] == nil {
		rev := b.grantLocked(c, board)
		b.sendLocked(c, event{"type": "held", "board": board, "rev": rev})
	}
	k := &call{client: c.id, board: board, reply: make(chan RPCReply, 1)}
	b.rpcs[id] = k
	c.calls[id] = k
	b.sendRawLocked(c, msg)
	b.mu.Unlock()

	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case r := <-k.reply:
		if k.lost {
			return nil, ErrNoClient
		}
		if r.Error != "" {
			return nil, errors.New(r.Error)
		}
		return r.Result, nil
	case <-t.C:
		b.mu.Lock()
		delete(b.rpcs, id)
		delete(c.calls, id)
		b.mu.Unlock()
		return nil, fmt.Errorf("the board did not answer %s in %s", spec.Method, timeout)
	}
}

// chooseLocked returns the client a call is for, and the board the call is about ("" for a
// call about one screen).
func (b *Bridge) chooseLocked(spec CallSpec) (c *client, board string) {
	if !spec.Screen && spec.Board != "" {
		board = spec.Board
		if h := b.holders[board]; h != nil {
			return h, board
		}
	}
	if spec.ChatBoard != "" {
		if h := b.holders[spec.ChatBoard]; h != nil {
			return h, board
		}
	}
	for _, o := range b.clients {
		if b.kinds[o.kind].boards && !o.closed && o.acted > 0 && (c == nil || o.acted > c.acted) {
			c = o
		}
	}
	return c, board
}

// ReplyFrom serves POST /api/rpc-reply: it resolves the call with that id, and reports true,
// only when clientID is the client that was asked. Otherwise the call stays open.
func (b *Bridge) ReplyFrom(clientID, rpcID string, r RPCReply) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	k := b.rpcs[rpcID]
	if k == nil || k.client != clientID {
		return false
	}
	b.resolveLocked(rpcID, k, r)
	return true
}

// StopAndFlush tells the clients that hold a board the server is stopping and waits until each
// of them reported its pending saves written (FlushedBy) or its stream ended, or for the timeout.
func (b *Bridge) StopAndFlush(timeout time.Duration) {
	b.mu.Lock()
	var asked []*client
	for _, c := range b.clients {
		if len(c.holds) > 0 {
			c.flushed = false
			asked = append(asked, c)
			b.sendLocked(c, event{"type": "server_stopping"})
		}
	}
	b.mu.Unlock()
	if len(asked) == 0 {
		return
	}
	t := time.NewTimer(timeout)
	defer t.Stop()
	for {
		b.mu.Lock()
		left := 0
		for _, c := range asked {
			if !c.flushed && b.clients[c.id] == c {
				left++
			}
		}
		b.mu.Unlock()
		if left == 0 {
			return
		}
		select {
		case <-b.flush:
		case <-t.C:
			return
		}
	}
}

// FlushedBy serves POST /api/client/flushed: the client has written its pending saves.
func (b *Bridge) FlushedBy(clientID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if c := b.clients[clientID]; c != nil {
		c.flushed = true
		b.poke()
	}
}

// ---- internals; b.mu is held by every ...Locked function ----

type event map[string]any

// handover is the hand-off timer's callback: the holder stayed silent, the waiter gets the
// board.
func (b *Bridge) handover(board string, w *waiter) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.waiters[board] == w {
		b.passLocked(board, true)
	}
}

// grantLocked makes c the holder of a board that nobody holds, and returns its scene revision.
func (b *Bridge) grantLocked(c *client, board string) int64 {
	b.holders[board] = c
	c.holds[board] = true
	return b.revLocked(board)
}

func (b *Bridge) revLocked(board string) int64 {
	if b.SceneRev == nil {
		return 0
	}
	return b.SceneRev(board)
}

// passLocked ends the hold of the board, if there is one, and gives the board to who waits for
// it. A waiting client becomes the holder and is sent held. For a waiting FreeBoard the board
// stays free, and a client that waited too is sent superseded. It reports whether somebody
// waited. The old holder's calls on the board fail; it is sent superseded when somebody
// waited, or when tell is set.
func (b *Bridge) passLocked(board string, tell bool) bool {
	w := b.waiters[board]
	if w != nil {
		w.timer.Stop()
		delete(b.waiters, board)
		delete(w.c.waits, board)
	}
	gone := b.freeing[board]
	if h := b.holders[board]; h != nil {
		delete(b.holders, board)
		delete(h.holds, board)
		if tell || w != nil || gone != nil {
			b.sendLocked(h, event{"type": "superseded", "board": board})
		}
		b.failCallsLocked(h, board, false)
	}
	switch {
	case gone != nil:
		delete(b.freeing, board)
		close(gone)
		if w != nil {
			b.sendLocked(w.c, event{"type": "superseded", "board": board})
		}
		return true
	case w != nil:
		rev := b.grantLocked(w.c, board)
		b.sendLocked(w.c, event{"type": "held", "board": board, "rev": rev})
		return true
	}
	return false
}

// endLocked ends the record of c, whose stream ended or was replaced: its boards are freed
// (their waiters get them), its waits and follows are dropped and all its calls fail. The items
// it was the last to follow go to OnUnfollowed's hook.
func (b *Bridge) endLocked(c *client) {
	if b.clients[c.id] != c {
		return
	}
	delete(b.clients, c.id)
	b.closeLocked(c)
	for board := range c.waits {
		if w := b.waiters[board]; w != nil && w.c == c {
			w.timer.Stop()
			delete(b.waiters, board)
		}
	}
	clear(c.waits)
	for board := range c.holds {
		b.passLocked(board, false)
	}
	b.failCallsLocked(c, "", true)
	ended := make([]Item, 0, len(c.follows))
	for it := range c.follows {
		ended = append(ended, it)
	}
	clear(c.follows)
	b.unfollowedLocked(ended)
	b.poke()
}

// welcomeLocked sends hello and the snapshot to a newly connected client.
func (b *Bridge) welcomeLocked(c *client) {
	b.sendLocked(c, event{"type": "hello", "client": c.id})
	snap := map[string]json.RawMessage{}
	if raw, err := json.Marshal(b.kinds[c.kind].snapshot(c)); err == nil {
		_ = json.Unmarshal(raw, &snap) // a non-object snapshot is dropped
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

// sendRawLocked queues msg without blocking. A full buffer drops the message and closes the
// stream, so the client reconnects and gets a fresh snapshot.
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

// resolveLocked gives the call its answer and forgets it.
func (b *Bridge) resolveLocked(id string, k *call, r RPCReply) {
	delete(b.rpcs, id)
	if c := b.clients[k.client]; c != nil {
		delete(c.calls, id)
	}
	select {
	case k.reply <- r:
	default:
	}
}

// failCallsLocked ends c's calls about the board with ErrNoClient; with all set, every call of
// c.
func (b *Bridge) failCallsLocked(c *client, board string, all bool) {
	for id, k := range c.calls {
		if all || k.board == board {
			delete(b.rpcs, id)
			delete(c.calls, id)
			k.lost = true
			select {
			case k.reply <- RPCReply{Error: ErrNoClient.Error()}:
			default:
			}
		}
	}
}

// poke wakes StopAndFlush.
func (b *Bridge) poke() {
	select {
	case b.flush <- struct{}{}:
	default:
	}
}
