// Package remotes is the local server's side of the servers of the server list: it holds, in
// memory only, the tree of every entry that is connected (a section), passes that server's
// events on to the pages, and passes a page's calls for a thing of a section on to its server.
//
// Nothing of another server is kept on disk: the relay reads and writes no file. A thing of a
// section is named by two values, the id of its entry and its id on that server, since an id is
// unique on one server only; the relay keys everything it keeps by both.
package remotes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/servers"
)

// Options configures Open. Servers and Bridge are required.
type Options struct {
	Servers *servers.Manager
	Bridge  *editorbridge.Bridge
	Limits  Limits                           // zero fields take DefaultLimits
	Logf    func(format string, args ...any) // nil = log.Printf
}

// Limits are the time limits of the calls passed on to a remote server. Call is for a call that
// starts nothing. Start is for one that can wait for an agent's start: a message, a fork, an
// open and the start of a run. Delete is for the delete of a run, which waits there for the
// run's agents and checkouts, and of a group with what is in it. Scene is for a board's drawing
// and Image for an upload and a fetch of an image of a chat, which carry megabytes. BoardCall is
// how long a page has to answer a tool call of an agent on another server.
type Limits struct {
	Call, Start, Dirs, Usage, Unfollow time.Duration
	Delete                             time.Duration
	BoardCall, Scene                   time.Duration
	Image                              time.Duration
}

// DefaultLimits is what a zero Limits means.
var DefaultLimits = Limits{Call: 15 * time.Second, Start: 45 * time.Second,
	Dirs: 10 * time.Second, Usage: 30 * time.Second, Unfollow: 5 * time.Second,
	Delete:    3 * time.Minute,
	BoardCall: 25 * time.Second, Scene: 60 * time.Second,
	Image: 60 * time.Second}

// withDefaults fills every zero field from DefaultLimits.
func (l Limits) withDefaults() Limits {
	for _, f := range []struct{ v, def *time.Duration }{
		{&l.Call, &DefaultLimits.Call}, {&l.Start, &DefaultLimits.Start},
		{&l.Dirs, &DefaultLimits.Dirs}, {&l.Usage, &DefaultLimits.Usage}, {&l.Unfollow, &DefaultLimits.Unfollow},
		{&l.Delete, &DefaultLimits.Delete},
		{&l.BoardCall, &DefaultLimits.BoardCall}, {&l.Scene, &DefaultLimits.Scene},
		{&l.Image, &DefaultLimits.Image},
	} {
		if *f.v <= 0 {
			*f.v = *f.def
		}
	}
	return l
}

// The causes of an *Error for a call that could not be made.
var (
	ErrUnreachable = errors.New("the server is not connected")
	ErrNoAnswer    = errors.New("the server did not answer")
)

// errTooLong is call's error for an answer above the size limit of package servers: the call
// was sent and answered, and the answer cannot be used (502 bad_answer).
var errTooLong = errors.New("the server's answer is too long")

// The kinds of a worker's items.
const (
	itemSnapshot = iota
	itemEvent
	itemRemoved
	itemDown // the entry's connection is in a state other than connected
)

// item is one call of a hook, as the entry's worker takes it.
type item struct {
	kind int
	typ  string // itemEvent: the event's type
	raw  json.RawMessage
}

// worker is the queue of one entry and its wake-up. Its goroutine takes the items in order.
type worker struct {
	queue []item
	wake  chan struct{} // capacity 1: the queue is not empty
}

// maxDropLog bounds the list of the keys whose log lines are held back.
const maxDropLog = 1024

// Relay holds the sections and passes a remote server's events on to the pages.
type Relay struct {
	o      Options         // Limits and Logf with their defaults
	ctx    context.Context // ends the workers and the calls the relay makes itself
	cancel context.CancelFunc
	wg     sync.WaitGroup

	// mu guards the two below. It is never held over I/O or over a call of the bridge: the page's
	// snapshot reads Sections with the bridge's lock held.
	mu       sync.Mutex
	sections map[string]*section // by entry id: the trees that are held
	streams  map[string]uint64   // by entry id: counts the trees that came and went (see stream)

	// What the boards of the sections keep: see boards.go, boardhold.go and boardcall.go.
	boards sync.Map // board key (editorbridge.BoardOn) -> *board
	calls  boardCalls

	reads itemLocks // orders the follows of an item on its server: see follows.go

	libs libraries // the copies of the entries' prompt libraries: see library.go

	qmu     sync.Mutex // the workers and their queues: all that a hook takes
	workers map[string]*worker
	stopped bool // Close was called: nothing is queued and no goroutine starts

	dmu     sync.Mutex
	dropLog map[string]time.Time // by key: when a line about it was last logged (see tell)

	// again is the wait before a take or a release of a board that got no answer is made again
	// (boardhold.go). It is Limits.Call outside the tests, which lower it.
	again time.Duration
}

// Open makes the relay. Nothing is sent and no hook is set: see Hooks.
func Open(o Options) (*Relay, error) {
	if o.Servers == nil || o.Bridge == nil {
		return nil, errors.New("remotes: the server list and the bridge are required")
	}
	o.Limits = o.Limits.withDefaults()
	if o.Logf == nil {
		o.Logf = log.Printf
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Relay{
		o: o, ctx: ctx, cancel: cancel,
		sections: map[string]*section{}, streams: map[string]uint64{},
		workers: map[string]*worker{}, dropLog: map[string]time.Time{},
		again: o.Limits.Call,
	}
	r.libs.of, r.libs.offers, r.libs.waiters, r.libs.wait = map[string]keptLibrary{}, map[string]bool{}, map[string][]*libraryWaiter{}, libraryWait
	return r, nil
}

// Limits are the relay's time limits, every one set: what a caller of Pass gives it.
func (r *Relay) Limits() Limits { return r.o.Limits }

// Hooks are the relay's hooks for Manager.SetHooks, before Start. Each one only adds to the
// queue of its entry: it does no I/O and takes no lock that is held over any. Back is not set:
// the work of a return hangs on Snapshot, which every stream's start calls, the first too.
// State tells the entry's worker that the connection is not up: the entry's tree goes. Only an
// entry that has a worker is told, since one that never connected has no tree and no copy of a
// library.
func (r *Relay) Hooks() servers.Hooks {
	return servers.Hooks{
		State: func(entry string, _, to servers.State) {
			if to != servers.StateConnected {
				r.enqueueKnown(entry, item{kind: itemDown})
			}
		},
		Snapshot: func(entry string, raw json.RawMessage) {
			r.enqueue(entry, item{kind: itemSnapshot, raw: bytes.Clone(raw)})
		},
		Event: func(entry, typ string, raw json.RawMessage) {
			r.enqueue(entry, item{kind: itemEvent, typ: typ, raw: bytes.Clone(raw)})
		},
		Removed: func(entry string) { r.enqueue(entry, item{kind: itemRemoved}) },
	}
}

// Close ends the workers and the calls the relay makes itself, and waits for them. Call it
// after the manager's Close. What a hook gives after it is dropped.
func (r *Relay) Close() {
	r.qmu.Lock()
	if r.stopped {
		r.qmu.Unlock()
		return
	}
	r.stopped = true
	r.qmu.Unlock()
	r.cancel()
	r.wg.Wait()
}

// ---- the workers ----

// enqueue adds an item to the entry's queue and starts the entry's worker with the first one.
// It is all a hook does.
func (r *Relay) enqueue(entry string, it item) {
	r.qmu.Lock()
	defer r.qmu.Unlock()
	if r.stopped {
		return
	}
	w := r.workers[entry]
	if w == nil {
		w = &worker{wake: make(chan struct{}, 1)}
		r.workers[entry] = w
		r.wg.Add(1)
		go r.work(entry, w)
	}
	w.queue = append(w.queue, it)
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// enqueueKnown is enqueue for an entry that has a worker; for any other the item is dropped.
func (r *Relay) enqueueKnown(entry string, it item) {
	r.qmu.Lock()
	defer r.qmu.Unlock()
	w := r.workers[entry]
	if r.stopped || w == nil {
		return
	}
	w.queue = append(w.queue, it)
	select {
	case w.wake <- struct{}{}:
	default:
	}
}

// spawn runs f in a goroutine that Close waits for. It reports false, and runs nothing, after Close.
func (r *Relay) spawn(f func()) bool {
	r.qmu.Lock()
	defer r.qmu.Unlock()
	if r.stopped {
		return false
	}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		f()
	}()
	return true
}

// work is the goroutine of one entry: it takes the entry's items in the order the hooks gave
// them, and ends with the entry's removal or with Close. It calls no server: what an item has to
// ask of the entry's server runs in a goroutine of spawn.
func (r *Relay) work(entry string, w *worker) {
	defer r.wg.Done()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-w.wake:
		}
		r.qmu.Lock()
		batch := w.queue
		w.queue = nil
		r.qmu.Unlock()
		for _, it := range batch {
			if r.ctx.Err() != nil {
				return
			}
			switch it.kind {
			case itemSnapshot:
				r.snapshot(entry, it.raw)
			case itemEvent:
				r.event(entry, it.typ, it.raw)
			case itemDown:
				r.down(entry)
			case itemRemoved:
				r.removed(entry)
				r.qmu.Lock()
				if r.workers[entry] == w {
					delete(r.workers, entry)
				}
				r.qmu.Unlock()
				return // the last call for the entry
			}
		}
	}
}

// snapshot takes the snapshot of a stream's start: the entry has connected, for the first time
// in this process or again. Its lists and its prompt library hang on nothing of the rest. Its
// tree replaces the one that was held, and the pages get it whole (section). What a stream
// before left ends first: see streamEnded. The boards that pages here hold are taken there
// again after the pages were told.
func (r *Relay) snapshot(entry string, raw json.RawMessage) {
	r.sendLists(entry)
	r.librarySnapshot(entry, raw)

	sec, err := sectionOf(raw)
	if err != nil {
		// The entry is connected and its tree cannot be read: there is no section to show.
		// Not the decoder's words, which can quote what that server sent: the log is a file of
		// this machine.
		r.o.Logf("remotes: the tree of the server %s cannot be read: it is not what a tree is", entry)
		r.endSection(entry, false)
		return
	}
	held := r.streamEnded(entry)
	if held {
		r.o.Bridge.ForgetServer(entry)
	}
	r.mu.Lock()
	r.sections[entry] = sec
	shown := sec.tree.clone()
	r.mu.Unlock()
	r.o.Bridge.Broadcast(sectionEvent{Type: "section", Server: entry, Tree: &shown})
	r.boardsBack(entry)
}

// down takes the end of the entry's connection: its tree goes, and its library is marked not
// connected.
func (r *Relay) down(entry string) {
	r.endSection(entry, false)
	r.libraryDown(entry)
}

// removed takes the removal of an entry: its tree, its lists and its library go, and what its
// boards kept here. Nothing is sent to that server: everything stays there.
func (r *Relay) removed(entry string) {
	r.endSection(entry, true)
	r.dropBoards(entry)
	r.sendNoLists(entry)
	r.dropLibrary(entry, nil, false)
	r.mu.Lock()
	delete(r.streams, entry)
	r.mu.Unlock()
}

// endSection ends the tree of the entry: the pages' follows of its things end, since that
// server forgot them with the stream, and every page is told that the section has no tree
// (section with null). With always the pages are told whether or not a tree was held.
func (r *Relay) endSection(entry string, always bool) {
	if held := r.streamEnded(entry); !held && !always {
		return
	}
	r.o.Bridge.ForgetServer(entry)
	r.o.Bridge.Broadcast(sectionEvent{Type: "section", Server: entry})
}

// streamEnded ends what the entry's stream carried, and reports whether a tree was held: the
// tree is no longer held, the stream is counted (stream), and the boards and the tool calls of
// the entry are told (boardsStreamEnded).
func (r *Relay) streamEnded(entry string) (held bool) {
	r.mu.Lock()
	_, held = r.sections[entry]
	delete(r.sections, entry)
	r.streams[entry]++
	r.mu.Unlock()
	r.boardsStreamEnded(entry)
	return held
}

// stream is the count of the entry's trees that came and went. What a call was told of a hold on
// the entry's server lasts as long as the stream the call was sent under, so an answer that
// comes after the count changed tells nothing of the hold.
func (r *Relay) stream(entry string) uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.streams[entry]
}

// event takes one event of the entry's server.
func (r *Relay) event(entry, typ string, raw json.RawMessage) {
	switch typ {
	case "groups", "defaults",
		"board", "board_removed",
		"chat", "chat_removed", "branch_state",
		"run", "run_removed":
		r.listEvent(entry, typ, raw)
	case "chat_items", "tree", "sub", "sub_items":
		r.contentEvent(entry, typ, "chat", raw)
	case "run_detail", "run_activity":
		r.contentEvent(entry, typ, "run", raw)
	case "catalog", "agents":
		// Not passed on as they come: the manager has taken the change into the entry's lists.
		r.sendLists(entry)
	case "held", "release_request", "superseded":
		r.boardRoleEvent(entry, typ, raw)
	case "rpc":
		r.boardCallEvent(entry, raw)
	case library.EventOwn:
		r.libraryEvent(entry, raw)
	default:
		// Dropped: a type this build does not know.
	}
}

// tell reports whether a line about key is to be logged now: once a minute per key.
func (r *Relay) tell(key string) bool {
	now := time.Now()
	r.dmu.Lock()
	defer r.dmu.Unlock()
	if last, seen := r.dropLog[key]; seen && now.Sub(last) < time.Minute {
		return false
	}
	if len(r.dropLog) >= maxDropLog {
		for k, at := range r.dropLog {
			if now.Sub(at) >= time.Minute {
				delete(r.dropLog, k)
			}
		}
		if len(r.dropLog) >= maxDropLog {
			clear(r.dropLog)
		}
	}
	r.dropLog[key] = now
	return true
}

// ---- calls to a remote server ----

// call passes one call on to the entry's server and returns its answer, whatever its status.
// ErrUnreachable means that nothing was sent: the entry is not connected, and is made to try
// now if it waits. errTooLong means that the answer was above the size limit. ErrNoAnswer means
// that the call was sent and no answer came within limit, or the connection ended.
func (r *Relay) call(ctx context.Context, entry, method, path string, body []byte, limit time.Duration) (servers.Reply, error) {
	return r.callAs(ctx, entry, method, path, "application/json", body, limit)
}

// callAs is call for a body that is sent with the type stated, or with none for "".
func (r *Relay) callAs(ctx context.Context, entry, method, path, stated string, body []byte, limit time.Duration) (servers.Reply, error) {
	rep, err := r.o.Servers.DoAs(ctx, entry, method, path, stated, body, limit)
	switch {
	case err == nil:
		return rep, nil
	case errors.Is(err, servers.ErrNotConnected), errors.Is(err, servers.ErrNotFound), errors.Is(err, servers.ErrLocalEntry):
		r.o.Servers.Retry(entry)
		return servers.Reply{}, ErrUnreachable
	case errors.Is(err, servers.ErrTooLong):
		return servers.Reply{}, errTooLong
	}
	return servers.Reply{}, ErrNoAnswer
}

// ---- reading an event ----

// fields reads the members of the JSON object raw that are named in keys. ok is false when raw
// is no object or names one of the keys more than once.
func fields(raw []byte, keys ...string) (found map[string]json.RawMessage, ok bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, false
	}
	found = make(map[string]json.RawMessage, len(keys))
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, false
		}
		key, _ := t.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, false
		}
		for _, k := range keys {
			if k != key {
				continue
			}
			if _, twice := found[k]; twice {
				return nil, false
			}
			found[k] = v
		}
	}
	return found, true
}

// text is the JSON string raw, "" for anything else.
func text(raw json.RawMessage) string {
	var s string
	if len(raw) == 0 || json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}
