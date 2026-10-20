// Package editorbridge is the server's line to its connected clients (the apps that own an
// Excalidraw engine): server→client over SSE, client→server over plain POSTs routed here by the
// HTTP layer.
//
// The bridge keeps one record per open stream: the boards that client holds and waits for, the
// chats and boards it follows, and the board calls it was asked. One client at a time holds a
// board. A client that takes a held board waits: the holder is asked to release (so it can save
// its pending changes) and loses the board after a short handover delay if it does not answer.
// Events go only to the clients they concern (see Events): the list events of every item, and
// the content events of what a client follows. A client holds a board by its own take; the one
// other way is a board call with Away set, which gives a free board to the away client (the
// headless writer, see SetAway).
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
// it, before it loses the board anyway: its release crosses a network, after the page behind it
// wrote its pending changes.
const handoverDelay = 10 * time.Second

// pingEvery is how often an idle SSE stream gets a comment line.
const pingEvery = 20 * time.Second

// Bridge holds the connected clients, the holder and the waiter of each board, and the board
// calls in flight.
type Bridge struct {
	// SceneRev returns the scene revision of a board, which a grant of the board names. It is
	// called with the bridge's lock held, so it must take no lock. Nil gives 0. Set it before
	// the first request.
	SceneRev func(board string) int64

	// PingEvery is how often an idle stream gets a comment line; 0 means pingEvery. Only a test
	// sets it. Set it before the first request.
	PingEvery time.Duration

	mu      sync.Mutex
	away    string                   // the id of the headless writer's client; "" for none
	followN int64                    // the last follow sequence number given
	clients map[string]*client       // by client id: the open streams
	holders map[string]*client       // by board
	waiters map[string]*waiter       // by board
	freeing map[string]chan struct{} // by board: a FreeBoard waits; closed when the board is let go
	rpcs    map[string]*call         // by rpc id
	logged  map[string]bool          // event types already logged as outside the table
	seq     atomic.Int64
	flush   chan struct{} // poked when a client flushed or its stream ended

	handoverAfter time.Duration // handoverDelay; shorter in tests
}

type client struct {
	id     string
	ch     chan []byte   // buffered 4096
	done   chan struct{} // closed to end its SSE stream
	closed bool          // done is closed; guarded by Bridge.mu

	snap func() any // the snapshot of the stream; nil for none

	holds   map[string]bool  // boards held
	waits   map[string]bool  // boards waited for
	follows map[Item]int64   // chats and boards followed, with the sequence number of the follow
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
	err           error // set when the bridge failed the call (ErrNoClient, ErrTaken, ErrAwayLost); before the reply is queued
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
	// ChatBoard is the calling chat's board. Only a Screen call uses it: it says which window
	// is asked.
	ChatBoard string
	Screen    bool // a call about one screen, not about Board
	// Away says that the call may be given to the away client: when nobody holds Board and the
	// away client is connected, the bridge makes it the holder of Board and asks it. Ignored
	// for a Screen call.
	Away bool
}

// ErrNoClient is returned by CallBoard when there is no client to ask, and given to the calls
// of a window whose stream ends.
var ErrNoClient = errors.New("the board isn't open: the AI Whiteboard window is closed")

// ErrTaken is returned by CallBoard for a call whose board changed hands while it ran: a
// hand-off, an archive or a delete.
var ErrTaken = errors.New("the board was taken over while the call ran")

// ErrAwayLost is returned by CallBoard for a call of the away client whose stream ended.
var ErrAwayLost = errors.New("the board's background editor stopped while the call ran")

// ErrTimeout is wrapped by the error CallBoard returns when the client did not answer in time and
// kept the board (the away client, or a call about one screen); its text is "the board did not
// answer <method> in <timeout>". A window that holds the board and does not answer loses it
// instead, and the error is ErrUnanswered, never ErrTimeout.
var ErrTimeout = errors.New("the board did not answer")

// ErrUnanswered is wrapped by the error CallBoard returns when the window that held the board did
// not answer in time and lost the board for it; its text is "the window that held the board did
// not answer <method> in <timeout>". The same error is given to the other calls of that window
// on the board, with the text of ErrUnanswered alone. The board is free by then, and a person
// who waited for it holds it.
var ErrUnanswered = errors.New("the window that held the board did not answer in time")

// ErrUnknownClient is returned by TakeBoard for an id with no open stream.
var ErrUnknownClient = errors.New("unknown_client")

// New makes a Bridge.
func New() *Bridge {
	return &Bridge{
		clients:       map[string]*client{},
		holders:       map[string]*client{},
		waiters:       map[string]*waiter{},
		freeing:       map[string]chan struct{}{},
		rpcs:          map[string]*call{},
		logged:        map[string]bool{},
		flush:         make(chan struct{}, 1),
		handoverAfter: handoverDelay,
	}
}

// Serve serves the event stream of the client id, which the caller has checked: hello, then
// snapshot() as the snapshot event, then the events the client is sent. snapshot is called once,
// with the bridge's lock held, so it must not call back into the Bridge. A stream with the id of
// one that is open replaces the older one, whose record ends: the new one holds and follows
// nothing.
func (b *Bridge) Serve(w http.ResponseWriter, r *http.Request, id string, snapshot func() any) {
	if id == "" {
		http.Error(w, "missing client", http.StatusBadRequest)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	c := newClient(id)
	c.snap = snapshot
	b.mu.Lock()
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
	every := pingEvery
	if b.PingEvery > 0 {
		every = b.PingEvery
	}
	tick := time.NewTicker(every)
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

func newClient(id string) *client {
	return &client{
		id: id, ch: make(chan []byte, 4096), done: make(chan struct{}),
		holds: map[string]bool{}, waits: map[string]bool{}, follows: map[Item]int64{}, calls: map[string]*call{},
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

// SetAway names the client id of the headless writer ("" for none). The bridge routes the calls
// with Away to it, calls its holding "headless" in the writer events, and keeps the Screen calls
// away from it. Set it before the process opens its stream.
func (b *Bridge) SetAway(clientID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.away = clientID
}

// WriterOf returns the kind of the writer of the board: "headless" when the away client holds
// it, "window" when any other client does, "" when nobody does. A client id is never returned.
func (b *Bridge) WriterOf(board string) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.writerLocked(board)
}

// HoldsAny reports whether the client holds a board.
func (b *Bridge) HoldsAny(clientID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	return c != nil && len(c.holds) > 0
}

// HeldCount returns how many boards the client holds; 0 for an id with no open stream.
func (b *Bridge) HeldCount(clientID string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	if c := b.clients[clientID]; c != nil {
		return len(c.holds)
	}
	return 0
}

// HasCalls reports whether the client has a board call open: an rpc sent and not answered.
func (b *Bridge) HasCalls(clientID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	return c != nil && len(c.calls) > 0
}

// WindowsConnected reports whether a client other than the away one has an open stream.
func (b *Bridge) WindowsConnected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, c := range b.clients {
		if id != b.away && !c.closed {
			return true
		}
	}
	return false
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
	if c == nil {
		return "", 0, ErrUnknownClient
	}
	h := b.holders[board]
	switch {
	case h == nil:
		rev = b.grantLocked(c, board)
		b.writerChangedLocked(board, nil)
		return "held", rev, nil
	case h == c:
		return "held", b.revLocked(board), nil
	case ifFree:
		return "busy", 0, nil
	}
	if w := b.waiters[board]; w != nil {
		if w.c != c {
			b.sendLocked(w.c, roleEvent("superseded", board))
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
		b.sendLocked(h, roleEvent("release_request", board))
	}
	return "waiting", 0, nil
}

// CloseAll ends the stream and the record of every client, and returns how many. What was
// queued for a client is still written before its stream ends.
func (b *Bridge) CloseAll() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, c := range b.clients {
		b.endLocked(c)
		n++
	}
	return n
}

// ReleaseBoard ends the client's hold of the board. It answers "handed" when another client
// (or FreeBoard) was waiting for it: the caller is then sent superseded as well. It answers
// "free" when nobody was, and "none" when the caller did not hold the board.
func (b *Bridge) ReleaseBoard(clientID, board string) string {
	return b.ReleaseBoardIf(clientID, board, false)
}

// ReleaseBoardIf is ReleaseBoard with ifIdle: when it is set, nobody waits for the board (no
// take and no FreeBoard) and the caller has a board call open on it, nothing changes and the
// answer is "kept". Without ifIdle it is ReleaseBoard.
func (b *Bridge) ReleaseBoardIf(clientID, board string, ifIdle bool) string {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	if c == nil || !c.holds[board] {
		return "none"
	}
	if ifIdle && b.waiters[board] == nil && b.freeing[board] == nil {
		for _, k := range c.calls {
			if k.board == board {
				return "kept"
			}
		}
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
		b.sendLocked(h, heldEvent(board, b.revLocked(board)))
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
			b.sendLocked(h, roleEvent("release_request", board))
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

// LoseBoard takes the board from its holder at once, with no release_request: the holder and a
// client waiting for the board are sent superseded, the holder's calls on the board fail, and the
// board is free. With no holder it does nothing.
func (b *Bridge) LoseBoard(board string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.holders[board] == nil {
		return
	}
	if w := b.waiters[board]; w != nil {
		w.timer.Stop()
		delete(b.waiters, board)
		delete(w.c.waits, board)
		b.sendLocked(w.c, roleEvent("superseded", board))
	}
	b.passLocked(board, true)
}

// SendTo sends ev, a role event, to the one client with this id. It reports false, and sends
// nothing, when the id has no open stream. It never blocks.
func (b *Bridge) SendTo(clientID string, ev any) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	c := b.clients[clientID]
	if c == nil || c.closed {
		return false
	}
	b.sendLocked(c, ev)
	return true
}

// CallBoard asks one client to run method (a board tool) and waits for its answer.
//
// A call about spec.Board goes to the board's holder. When nobody holds it and spec.Away is set
// and the away client is connected, the away client is made the holder (it is sent held, then
// the call), and is asked; with Away unset, or no away client, there is no client to ask. A
// Screen call is about no board: it goes to the window that holds spec.ChatBoard if that window
// follows it, else to the window that followed it last, else to the window that holds it, and
// never to the away client. With no such client the call fails with ErrNoClient at once. An
// open call fails when its client loses the board the call is about (ErrTaken), when the stream
// of the away client ends (ErrAwayLost) or when the stream of a window ends (ErrNoClient).
//
// A call not answered within timeout fails. When it was about a board and its client is a window
// that still holds the board, the window loses the board as a holder that does not release does
// (passLocked): it is sent superseded, a client waiting for the board gets it, the followers are
// sent a writer event, and the window's other calls on the board fail too. The error is then
// ErrUnanswered, and the board may be given to the away client by the next call. A call of the
// away client, a Screen call, or a client that no longer holds the board fails with ErrTimeout and
// changes nothing. A call answered or failed while the timer ran has that result.
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
	k := &call{client: c.id, board: board, reply: make(chan RPCReply, 1)}
	b.rpcs[id] = k
	c.calls[id] = k
	b.sendRawLocked(c, msg)
	b.mu.Unlock()

	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case r := <-k.reply:
		return resultOf(k, r)
	case <-t.C:
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.rpcs[id] == nil { // answered or failed as the timer fired: the reply is queued
			select {
			case r := <-k.reply:
				return resultOf(k, r)
			default:
			}
		}
		delete(b.rpcs, id)
		delete(c.calls, id)
		if board != "" && c.id != b.away && b.holders[board] == c {
			// Its other calls on the board fail first, with the error of this one; passLocked then
			// finds none.
			b.failCallsLocked(c, board, false, ErrUnanswered)
			b.passLocked(board, true)
			return nil, &unansweredError{method: spec.Method, after: timeout}
		}
		return nil, &timeoutError{method: spec.Method, after: timeout}
	}
}

// resultOf is the outcome of a call whose reply was queued: the bridge's error, the client's error
// or the result.
func resultOf(k *call, r RPCReply) (json.RawMessage, error) {
	if k.err != nil {
		return nil, k.err
	}
	if r.Error != "" {
		return nil, errors.New(r.Error)
	}
	return r.Result, nil
}

// timeoutError is the error of a call that was not answered in time and changed nothing. It is
// ErrTimeout, with the words of the call.
type timeoutError struct {
	method string
	after  time.Duration
}

func (e *timeoutError) Error() string {
	return fmt.Sprintf("%s %s in %s", ErrTimeout.Error(), e.method, e.after)
}
func (e *timeoutError) Unwrap() error { return ErrTimeout }

// unansweredError is the error of a call whose window did not answer in time and lost the board
// for it. It is ErrUnanswered, with the words of the call.
type unansweredError struct {
	method string
	after  time.Duration
}

func (e *unansweredError) Error() string {
	return fmt.Sprintf("the window that held the board did not answer %s in %s", e.method, e.after)
}
func (e *unansweredError) Unwrap() error { return ErrUnanswered }

// chooseLocked returns the client a call is for, and the board the call is about ("" for a
// call about one screen). See CallBoard for the rules. A free board given to the away client is
// granted here, under the lock that found it free, so that no window can be overtaken.
func (b *Bridge) chooseLocked(spec CallSpec) (c *client, board string) {
	if spec.Screen {
		return b.screenLocked(spec.ChatBoard), ""
	}
	if spec.Board == "" {
		return nil, ""
	}
	board = spec.Board
	if h := b.holders[board]; h != nil {
		return h, board
	}
	if a := b.clients[b.away]; spec.Away && a != nil && !a.closed {
		rev := b.grantLocked(a, board)
		b.sendLocked(a, heldEvent(board, rev))
		b.writerChangedLocked(board, nil)
		return a, board
	}
	return nil, board
}

// screenLocked returns the window a Screen call about the chat's board is for, or nil.
func (b *Bridge) screenLocked(chatBoard string) *client {
	if chatBoard == "" {
		return nil
	}
	it := Board(chatBoard)
	h := b.holders[chatBoard]
	if h != nil && (h.id == b.away || h.closed) {
		h = nil
	}
	if h != nil && h.follows[it] > 0 {
		return h
	}
	var last *client
	for _, f := range b.clients {
		if f.id != b.away && !f.closed && f.follows[it] > 0 && (last == nil || f.follows[it] > last.follows[it]) {
			last = f
		}
	}
	if last != nil {
		return last
	}
	return h
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

// roleEvent is a role event of the board with this id.
func roleEvent(typ, board string) event {
	return event{"type": typ, "board": board}
}

// heldEvent is the held event of the board, at the revision rev.
func heldEvent(board string, rev int64) event {
	ev := roleEvent("held", board)
	ev["rev"] = rev
	return ev
}

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
// The caller sends the writer event (writerChangedLocked) after the held event.
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
// waited. The old holder's calls on the board fail with ErrTaken; it is sent superseded when
// somebody waited, or when tell is set. The followers of the board are sent one writer event
// when the holder changed.
func (b *Bridge) passLocked(board string, tell bool) bool {
	w := b.waiters[board]
	if w != nil {
		w.timer.Stop()
		delete(b.waiters, board)
		delete(w.c.waits, board)
	}
	gone := b.freeing[board]
	old := b.holders[board]
	if old != nil {
		delete(b.holders, board)
		delete(old.holds, board)
		if tell || w != nil || gone != nil {
			b.sendLocked(old, roleEvent("superseded", board))
		}
		b.failCallsLocked(old, board, false, ErrTaken)
	}
	passed := false
	switch {
	case gone != nil:
		delete(b.freeing, board)
		close(gone)
		if w != nil {
			b.sendLocked(w.c, roleEvent("superseded", board))
		}
		passed = true
	case w != nil:
		rev := b.grantLocked(w.c, board)
		b.sendLocked(w.c, heldEvent(board, rev))
		passed = true
	}
	b.writerChangedLocked(board, old)
	return passed
}

// writerLocked is WriterOf.
func (b *Bridge) writerLocked(board string) string {
	h := b.holders[board]
	switch {
	case h == nil:
		return ""
	case h.id == b.away:
		return "headless"
	}
	return "window"
}

// writerChangedLocked sends the followers of the board a writer event when its holder is not
// prev, the holder before the change. Nothing is sent when the holder stayed.
func (b *Bridge) writerChangedLocked(board string, prev *client) {
	if b.holders[board] == prev {
		return
	}
	b.sendFollowersLocked(Board(board), event{"type": "writer", "board": board, "writer": b.writerLocked(board)})
}

// sendFollowersLocked queues ev for every client that follows it.
func (b *Bridge) sendFollowersLocked(it Item, ev any) {
	msg, err := json.Marshal(ev)
	if err != nil {
		return
	}
	for _, c := range b.clients {
		if c.follows[it] > 0 {
			b.sendRawLocked(c, msg)
		}
	}
}

// endLocked ends the record of c, whose stream ended or was replaced: its boards are freed
// (their waiters get them), its waits and follows are dropped and all its calls fail.
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
	// Its calls fail first, with the error of its kind; passLocked then finds none.
	if c.id == b.away {
		b.failCallsLocked(c, "", true, ErrAwayLost)
	} else {
		b.failCallsLocked(c, "", true, ErrNoClient)
	}
	for board := range c.holds {
		b.passLocked(board, false)
	}
	clear(c.follows)
	b.poke()
}

// welcomeLocked sends hello and the snapshot to a newly connected client.
func (b *Bridge) welcomeLocked(c *client) {
	b.sendLocked(c, event{"type": "hello", "client": c.id})
	snap := map[string]json.RawMessage{}
	if c.snap != nil {
		if raw, err := json.Marshal(c.snap()); err == nil {
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

// failCallsLocked ends c's calls about the board with err; with all set, every call of c.
func (b *Bridge) failCallsLocked(c *client, board string, all bool, err error) {
	for id, k := range c.calls {
		if all || k.board == board {
			delete(b.rpcs, id)
			delete(c.calls, id)
			k.err = err
			select {
			case k.reply <- RPCReply{Error: err.Error()}:
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
