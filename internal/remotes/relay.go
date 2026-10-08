package remotes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers"
)

// Local is what the relay asks of the chat manager: the chats that have a server and have not
// started yet, whether an id is one of its own (Known: a record that another server names is
// never made under such an id), and the removal of the unstarted chats on a run that was
// deleted (DeleteOnRun) or on a board whose record went with its entry (DeleteOnBoard).
// *chats.Manager is one.
type Local interface {
	Known(id string) bool
	DeleteOnRun(run string)
	DeleteOnBoard(board string)
	RemoteUnstarted(id string) (meta model.ChatMeta, ok bool)
	SetRemoteStart(id, state string) error
	HandOver(id string) (model.ChatMeta, error)
	UnstartedOn(entry string) []model.ChatMeta
	ServerUp(entry string)
	ResetServer(id string) error
}

// Options configures Open. Servers and Bridge are required.
type Options struct {
	Root    string
	Servers *servers.Manager
	Bridge  *editorbridge.Bridge
	Local   Local                                   // the chat manager
	Runs    LocalRuns                               // the run service; nil: no runs, and no run record is kept
	Group   func(id string) (exists, archived bool) // a group of this server
	Limits  Limits                                  // zero fields take DefaultLimits
	Logf    func(format string, args ...any)        // nil = log.Printf
}

// Limits are the time limits of the calls passed on to a remote server, and Flush, the time
// between two writes of the records whose view changed. Start is for a call that can wait for
// an agent's start: the creation call, a send, a fork and open. Check is for the check of a
// draft run, RunDelete for the delete of a run, which waits there for the run's agents and
// checkouts. Call is for the rest.
type Limits struct {
	Call, Start, Settle, Dirs, Usage, Unfollow, Flush time.Duration
	Check, RunDelete                                  time.Duration
	BoardCall, Scene                                  time.Duration
}

// DefaultLimits is what a zero Limits means.
var DefaultLimits = Limits{Call: 15 * time.Second, Start: 45 * time.Second, Settle: 15 * time.Second,
	Dirs: 10 * time.Second, Usage: 30 * time.Second, Unfollow: 5 * time.Second, Flush: 2 * time.Second,
	Check: 5 * time.Second, RunDelete: 3 * time.Minute,
	BoardCall: 25 * time.Second, Scene: 60 * time.Second}

// withDefaults fills every zero field from DefaultLimits.
func (l Limits) withDefaults() Limits {
	for _, f := range []struct{ v, def *time.Duration }{
		{&l.Call, &DefaultLimits.Call}, {&l.Start, &DefaultLimits.Start}, {&l.Settle, &DefaultLimits.Settle},
		{&l.Dirs, &DefaultLimits.Dirs}, {&l.Usage, &DefaultLimits.Usage}, {&l.Unfollow, &DefaultLimits.Unfollow},
		{&l.Flush, &DefaultLimits.Flush}, {&l.Check, &DefaultLimits.Check}, {&l.RunDelete, &DefaultLimits.RunDelete},
		{&l.BoardCall, &DefaultLimits.BoardCall}, {&l.Scene, &DefaultLimits.Scene},
	} {
		if *f.v <= 0 {
			*f.v = *f.def
		}
	}
	return l
}

var (
	ErrUnreachable = errors.New("the server is not connected")
	ErrNoAnswer    = errors.New("the server did not answer")
	ErrGone        = errors.New("the chat is no longer on its server")
	ErrConnected   = errors.New("the server is connected: delete the chat there")
)

// errTooLong is call's error for an answer above the size limit of package servers: the call
// was sent and answered, and the answer cannot be used (502 bad_answer).
var errTooLong = errors.New("the server's answer is too long")

// The errors of adopt: no record was made.
var (
	errBadRecord = errors.New("remotes: a record needs an id of the known form and its server's entry")
	errTaken     = errors.New("remotes: a record with this id exists")
	errNoEntry   = errors.New("remotes: the record's server is not in the list")
)

// record is a Record in memory, with its locks.
type record struct {
	id, entry string // d.ID and d.Entry: they never change

	// mu is the record's lock: d and the fields below. It is held over a change with its file
	// write and its events, never over a call to the record's server.
	mu      sync.Mutex
	d       Record
	dirty   bool   // the file is older than d: written at the next flush
	failed  bool   // the last write failed, and that was logged
	removed bool   // dropped: no write and no event follows
	applied uint64 // counts the views and states of the chat that were taken from its server (see take)
	capped  bool   // a branch state above maxStates was dropped, and that was logged
	lost    int    // the archive calls in a row that got no answer (see passArchive)

	// followMu orders the follows of the chat: a read that follows holds it shared while it is
	// passed on, the unfollow call holds it alone. So an unfollow never overtakes a read.
	followMu sync.RWMutex

	pub atomic.Pointer[shown] // what Views and States hand out: set by keep
}

// shown is a record as the pages get it, built at its last change.
type shown struct {
	view   model.ChatView
	states []model.BranchState
}

func newRecord(d Record) *record {
	if d.States == nil {
		d.States = []model.BranchState{}
	}
	rec := &record{id: d.ID, entry: d.Entry, d: d}
	rec.publish()
	return rec
}

// publish sets what Views and States hand out. rec.mu held, or the record is not shared yet.
func (rec *record) publish() {
	rec.pub.Store(&shown{view: viewOf(rec.d), states: statesOf(rec.d)})
}

// stamp is the mark of a read of the chat's view that is about to be sent: what take is given.
func (rec *record) stamp() uint64 {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.applied
}

// take takes the view v, which a read of the chat sent at the mark since answered. An answer
// and an event of one chat can cross: the view is taken only if no view of the chat was taken
// since the read was sent, so an answer never puts an older view over a newer one. durable is
// what apply reports; the caller keeps the record and sends its events. rec.mu held.
func (rec *record) take(since uint64, v model.ChatView) (taken, durable bool) {
	if rec.removed || rec.applied != since {
		return false, false
	}
	rec.applied++
	return true, rec.d.apply(v, false)
}

// The kinds of a worker's items.
const (
	itemSnapshot = iota
	itemEvent
	itemRemoved
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

// maxDropLog bounds the list of the ids whose dropped events were logged.
const maxDropLog = 1024

// Relay keeps the records and passes a remote server's events on to the pages.
type Relay struct {
	o          Options // Limits and Logf with their defaults
	files      *files
	runFiles   *runFiles
	boardFiles *boardFiles
	ctx        context.Context // ends the workers, the flushes and the calls the relay makes itself
	cancel     context.CancelFunc
	wg         sync.WaitGroup

	mu     sync.Mutex              // the six below; never held over I/O or a call of the bridge
	recs   map[string]*record      // by chat id
	runs   map[string]*runRecord   // by run id
	boards map[string]*boardRecord // by board id
	making map[string]int          // the board ids whose creation call is on its way (see makingBoard)
	agents map[string]string       // the chat id of a learned agent of a run record -> the run's id
	left   map[string]bool         // the entries that were removed: no record is adopted for one

	boardIdx sync.Map // boards again, board id -> *boardRecord: what BoardRev reads with no lock

	// What the operations on a board keep: see boardhold.go, boardcall.go and boardops.go.
	holds boardHolds
	calls boardCalls
	bops  boardOps

	qmu     sync.Mutex // the workers and their queues: all that a hook takes
	workers map[string]*worker
	stopped bool // Close was called: nothing is queued and no goroutine starts

	dropped     atomic.Int64 // the events dropped for a chat without a record
	droppedRuns atomic.Int64 // the events dropped for a run without a record
	dmu         sync.Mutex
	dropLog     map[string]time.Time // by chat id, or "run " and a run id: when a dropped event of it was last logged

	// The two steps of a snapshot that belong to the operations on a chat, which set them in
	// Open; nil does nothing. settle is step 3: every unstarted chat on the entry whose first
	// message may have left is settled from the snapshot, on the entry's worker. pending is
	// step 8: every archive change of the entry that is not confirmed is passed on, in a
	// goroutine of its own, with a context that ends at Close.
	settle  func(entry string, snap *snapshot)
	pending func(ctx context.Context, entry string)

	// The same two steps for runs, set by the operations on a run; nil does nothing. settleRuns
	// is step 3, after settle: every draft run on the entry is settled from the snapshot's runs,
	// on the entry's worker. pendingRuns is step 8: the archive changes
	// of the entry's run records that are not confirmed, in a goroutine of its own.
	settleRuns  func(entry string, snap *snapshot)
	pendingRuns func(ctx context.Context, entry string)

	locks opLocks // of the operations on a chat: see ops.go

	// Waits that are fixed outside the tests, which lower them. again is the wait before an
	// archive change that got no answer is passed on again (see archiveLost): Limits.Call.
	// agentEvery and agentWait are those of a read of a run agent's chat (see agentRead).
	again      time.Duration
	agentEvery time.Duration
	agentWait  time.Duration

	fmu    sync.Mutex
	firsts map[string]firstText // by chat id: the text of the creation calls sent for it (see start.go)
	goals  map[string]goalSent  // by run id: the goal of the start call sent last for it (see runstart.go)
}

// Open reads the records of o.Root. A record whose entry is not in the server list is removed
// with its file. Nothing is sent and no hook is set: see Hooks.
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
		o: o, files: newFiles(o.Root), runFiles: newRunFiles(o.Root), boardFiles: newBoardFiles(o.Root), ctx: ctx, cancel: cancel,
		recs: map[string]*record{}, runs: map[string]*runRecord{}, boards: map[string]*boardRecord{}, making: map[string]int{}, agents: map[string]string{}, left: map[string]bool{},
		workers: map[string]*worker{}, dropLog: map[string]time.Time{},
		firsts: map[string]firstText{}, goals: map[string]goalSent{},
		again: o.Limits.Call, agentEvery: agentEvery, agentWait: agentWait,
	}
	r.settle, r.pending = r.settleStarts, r.passPending
	r.settleRuns, r.pendingRuns = r.settleRunStarts, r.passPendingRuns
	for _, d := range r.files.load(o.Logf) {
		if _, ok := o.Servers.View(d.Entry); !ok || d.Entry == servers.LocalID {
			o.Logf("remotes: the chat %s is removed: its server is no longer in the list", d.ID)
			if err := r.files.remove(d.ID); err != nil {
				o.Logf("remotes: the file of the chat %s is not removed: %v", d.ID, err)
			}
			continue
		}
		r.recs[d.ID] = newRecord(d)
	}
	r.loadRuns()
	r.loadBoards()
	r.wg.Add(1)
	go r.flusher()
	return r, nil
}

// Hooks are the relay's hooks for Manager.SetHooks, before Start. Each one only adds to the
// queue of its entry: it does no I/O and takes no lock that is held over any. Back is not set:
// the work of a return hangs on Snapshot, which every stream's start calls, the first too.
// State is not set either: the pages get server_state from the manager.
func (r *Relay) Hooks() servers.Hooks {
	return servers.Hooks{
		Snapshot: func(entry string, raw json.RawMessage) {
			r.enqueue(entry, item{kind: itemSnapshot, raw: bytes.Clone(raw)})
		},
		Event: func(entry, typ string, raw json.RawMessage) {
			r.enqueue(entry, item{kind: itemEvent, typ: typ, raw: bytes.Clone(raw)})
		},
		Removed: func(entry string) { r.enqueue(entry, item{kind: itemRemoved}) },
	}
}

// Close ends the workers and the calls the relay makes itself, waits for them and writes the
// records whose view changed since their last write. Call it after the manager's Close. What a
// hook gives after it is dropped.
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
	r.flush()
}

// ---- the records ----

// rec is the record of the chat id, nil for none.
func (r *Relay) rec(id string) *record {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.recs[id]
}

// of is the record of the chat id when it is a chat of the server entry, nil otherwise: no
// server changes the record of another one's chat.
func (r *Relay) of(entry, id string) *record {
	if rec := r.rec(id); rec != nil && rec.entry == entry {
		return rec
	}
	return nil
}

// on are the records of the entry, by id.
func (r *Relay) on(entry string) []*record {
	r.mu.Lock()
	var out []*record
	for _, rec := range r.recs {
		if rec.entry == entry {
			out = append(out, rec)
		}
	}
	r.mu.Unlock()
	byID(out)
	return out
}

// all are the records, by id.
func (r *Relay) all() []*record {
	r.mu.Lock()
	out := make([]*record, 0, len(r.recs))
	for _, rec := range r.recs {
		out = append(out, rec)
	}
	r.mu.Unlock()
	byID(out)
	return out
}

// Has reports whether a record with this chat id exists.
func (r *Relay) Has(id string) bool { return r.rec(id) != nil }

// Counts is the number of chat records and of run records of the entry.
func (r *Relay) Counts(entry string) (chats, runs int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, rec := range r.recs {
		if rec.entry == entry {
			chats++
		}
	}
	for _, rec := range r.runs {
		if rec.entry == entry {
			runs++
		}
	}
	return chats, runs
}

// Views are the views of every record as a page gets them, for the snapshot. Never nil.
func (r *Relay) Views() []model.ChatView {
	recs := r.all()
	out := make([]model.ChatView, 0, len(recs))
	for _, rec := range recs {
		out = append(out, r.pageView(rec.pub.Load().view))
	}
	return out
}

// States are the branch states of every record, with their drafts, for the snapshot. Never nil.
func (r *Relay) States() []model.BranchState {
	out := []model.BranchState{}
	for _, rec := range r.all() {
		out = append(out, rec.pub.Load().states...)
	}
	return out
}

// adopt makes the record d: it is listed, and its file is written before any other use of it.
// It sends no event. An error means that no record was made: an id or entry that cannot be a
// record's, an id that has a record, an entry that is not in the list.
func (r *Relay) adopt(d Record) (*record, error) {
	if !validID(d.ID) || d.Entry == "" || d.Entry == servers.LocalID {
		return nil, errBadRecord
	}
	if _, ok := r.o.Servers.View(d.Entry); !ok {
		return nil, errNoEntry
	}
	rec := newRecord(d)
	rec.mu.Lock()
	defer rec.mu.Unlock()
	r.mu.Lock()
	var err error
	switch {
	case r.left[d.Entry]:
		err = errNoEntry
	case r.recs[d.ID] != nil:
		err = errTaken
	default:
		r.recs[d.ID] = rec
	}
	r.mu.Unlock()
	if err != nil {
		return nil, err
	}
	r.write(rec)
	return rec, nil
}

// drop removes the record with its file. It sends no event: see emitRemoved. rec.mu held.
func (r *Relay) drop(rec *record) {
	if rec.removed {
		return
	}
	rec.removed = true
	// The file goes first: a new record of the id can be adopted only once this one is unlisted.
	if err := r.files.remove(rec.id); err != nil {
		r.o.Logf("remotes: the file of the chat %s is not removed: %v", rec.id, err)
	}
	r.mu.Lock()
	if r.recs[rec.id] == rec {
		delete(r.recs, rec.id)
	}
	r.mu.Unlock()
}

// keep is called after every change of rec.d: what Views and States hand out is set, and the
// file is written at once when durable is set, else at the next flush. rec.mu held.
func (r *Relay) keep(rec *record, durable bool) {
	if rec.removed {
		return
	}
	rec.publish()
	if durable {
		r.write(rec)
	} else {
		rec.dirty = true
	}
}

// write writes the record's file. A write that fails is logged once and tried again at every
// flush; a record above the size limit is not written (see files.save). rec.mu held.
func (r *Relay) write(rec *record) {
	if err := r.files.save(rec.d); err != nil {
		if !rec.failed {
			r.o.Logf("remotes: the chat %s is not written: %v", rec.id, err)
		}
		// A record that is too large is not tried again until it changes.
		rec.dirty, rec.failed = !errors.Is(err, errTooLarge), true
		return
	}
	rec.dirty, rec.failed = false, false
}

// flusher writes the records whose view changed, every Limits.Flush.
func (r *Relay) flusher() {
	defer r.wg.Done()
	t := time.NewTicker(r.o.Limits.Flush)
	defer t.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-t.C:
			r.flush()
		}
	}
}

func (r *Relay) flush() {
	for _, rec := range r.all() {
		rec.mu.Lock()
		if rec.dirty && !rec.removed {
			r.write(rec)
		}
		rec.mu.Unlock()
	}
	r.flushRuns()
	r.flushBoards()
}

// ---- events for the pages ----

// emitChat sends the record's view to every page. rec.mu held, as for every emit of a record:
// the events of one chat leave in the order of its changes.
func (r *Relay) emitChat(rec *record) {
	r.o.Bridge.SendChat(rec.id, false, map[string]any{"type": "chat", "chat": r.pageView(viewOf(rec.d))})
}

// pageView is a record's view as a page gets it, in events and in answers alike: a chat on a
// board keeps its board, whose id is the same here and there, when this server has a record of
// that board, and is then shown under it. A board this server has no record of is none a page
// can show the chat under. It takes no lock.
func (r *Relay) pageView(v model.ChatView) model.ChatView {
	if _, ok := r.boardIdx.Load(v.Board); !ok {
		v.Board = ""
	}
	return v
}

// emitBoardChats sends the views of the records of the chats on the board again: a record of
// the board was made after theirs, and their views name it from now on.
func (r *Relay) emitBoardChats(board string) {
	for _, rec := range r.all() {
		rec.mu.Lock()
		if !rec.removed && rec.d.View.Board == board {
			r.emitChat(rec)
		}
		rec.mu.Unlock()
	}
}

// emitState sends the state of one branch of the record, with that branch's draft. It sends
// nothing for a branch the record has no state of. rec.mu held.
func (r *Relay) emitState(rec *record, branch string) {
	for _, st := range rec.d.States {
		if st.Branch == branch {
			r.o.Bridge.SendChat(rec.id, false, map[string]any{"type": "branch_state", "state": stateOf(rec.d, st)})
			return
		}
	}
}

// emit sends the state of every branch of the record, then its view. rec.mu held.
func (r *Relay) emit(rec *record) {
	for _, st := range statesOf(rec.d) {
		r.o.Bridge.SendChat(rec.id, false, map[string]any{"type": "branch_state", "state": st})
	}
	r.emitChat(rec)
}

// emitRemoved tells every page that the chat id is no more, after its record was dropped. The
// bridge then forgets the chat's follows.
func (r *Relay) emitRemoved(id string) {
	r.o.Bridge.SendChat(id, false, map[string]any{"type": "chat_removed", "id": id})
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
// them, and ends with the entry's removal or with Close.
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

// event takes one event of the entry's server.
func (r *Relay) event(entry, typ string, raw json.RawMessage) {
	switch typ {
	case "chat":
		r.chatEvent(entry, raw)
	case "branch_state":
		r.stateEvent(entry, raw)
	case "chat_items", "tree", "sub", "sub_items":
		r.contentEvent(entry, typ, raw)
	case "chat_removed":
		r.removedEvent(entry, raw)
	case "catalog", "agents":
		// Not passed on as they come: the manager has taken the change into the entry's lists.
		r.sendLists(entry)
	case "run":
		r.runEvent(entry, raw)
	case "run_removed":
		r.runRemovedEvent(entry, raw)
	case "run_detail", "run_activity":
		r.runContentEvent(entry, typ, raw)
	case "board", "board_removed", "held", "release_request", "superseded", "rpc":
		r.boardEvent(entry, typ, raw)
	default:
		// Dropped: a type this build does not know.
	}
}

// chatEvent takes a chat's view: the record keeps it, and the pages get the record's view.
func (r *Relay) chatEvent(entry string, raw json.RawMessage) {
	var ev struct {
		Chat model.ChatView `json:"chat"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	rec := r.of(entry, ev.Chat.ID)
	if rec == nil {
		if r.agentOn(entry, ev.Chat.ID) != nil {
			r.agentEvent("chat", "chat", ev.Chat.ID, raw)
		} else if !r.startedEvent(entry, ev.Chat) {
			r.unknown(entry, "chat", ev.Chat.ID)
		}
		return
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return
	}
	rec.applied++
	r.keep(rec, rec.d.apply(ev.Chat, false))
	r.emitChat(rec)
}

// stateEvent takes the state of one branch, and sends it with the branch's draft.
func (r *Relay) stateEvent(entry string, raw json.RawMessage) {
	var ev struct {
		State model.BranchState `json:"state"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	st := ev.State
	rec := r.of(entry, st.Chat)
	if rec == nil {
		if r.agentOn(entry, st.Chat) != nil {
			r.agentEvent("branch_state", "state", st.Chat, raw)
		} else {
			r.unknown(entry, "branch_state", st.Chat)
		}
		return
	}
	if st.Branch == "" {
		st.Branch = mainBranch
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return
	}
	rec.applied++ // an answer that was sent before this state must not put an older one over it
	if !rec.d.setState(st) {
		if !rec.capped {
			rec.capped = true
			r.o.Logf("remotes: the chat %s has %d branch states here: the states of more branches are dropped", rec.id, maxStates)
		}
		return
	}
	r.keep(rec, false)
	r.emitState(rec, st.Branch)
}

// contentEvent hands a content event on as it came: the bridge gives it to the chat's
// followers alone. The pages read "type" and "chat" themselves, so an event that names either
// twice, or otherwise than it was routed by, is dropped: what the bridge routes by and what a
// page reads are then the same. The chat is one with a record, or the chat of a learned agent
// of a run record.
func (r *Relay) contentEvent(entry, typ string, raw json.RawMessage) {
	f, ok := fields(raw, "type", "chat")
	if !ok || text(f["type"]) != typ {
		return
	}
	id := text(f["chat"])
	if r.of(entry, id) == nil {
		if r.agentOn(entry, id) != nil {
			r.o.Bridge.SendChat(id, true, raw) // in nobody's list
		} else {
			r.unknown(entry, typ, id)
		}
		return
	}
	r.o.Bridge.SendChat(id, false, raw)
}

// removedEvent takes a chat's removal on its server. It is not passed on: the record stays,
// marked gone, until the user removes it here.
func (r *Relay) removedEvent(entry string, raw json.RawMessage) {
	var ev struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return
	}
	rec := r.of(entry, ev.ID)
	if rec == nil {
		if r.agentOn(entry, ev.ID) == nil { // the removal of a run agent's chat is dropped: its run tells
			r.unknown(entry, "chat_removed", ev.ID)
		}
		return
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.removed {
		return
	}
	rec.applied++
	durable := !rec.d.Gone
	rec.d.Gone = true
	r.keep(rec, durable)
	r.emitChat(rec)
}

// unknown counts an event of a chat the entry has no record of, and logs it once a minute per
// id. Nothing is logged for a chat whose first message may be on its way to the entry: its
// events come before its record, on every first message.
func (r *Relay) unknown(entry, typ, id string) {
	r.dropped.Add(1)
	if r.starting(entry, id) {
		return
	}
	if len(id) > 64 {
		id = id[:64]
	}
	if r.tell(id) {
		r.o.Logf("remotes: an event %q of the chat %q from the server %s is dropped: it has no record here", typ, id, entry)
	}
}

// tell reports whether a dropped event of key is to be logged now: once a minute per key.
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

// snapshot takes the snapshot of a stream's start: the entry has connected, for the first time
// in this process or again. The eight steps are in a fixed order; in each one the chats come
// before the runs.
func (r *Relay) snapshot(entry string, raw json.RawMessage) {
	// Before all else, the board holds of the stream before end: see boardsNewStream.
	r.boardsNewStream(entry)
	// 1. The entry's lists.
	r.sendLists(entry)

	var snap snapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		// The chats cannot be read: no record is marked from it, and the rest goes on.
		r.o.Logf("remotes: the chats of the snapshot of the server %s cannot be read: %v", entry, err)
	} else {
		// 2. Every record of the entry takes what the snapshot tells of its chat or its run.
		for _, rec := range r.on(entry) {
			rec.mu.Lock()
			if !rec.removed {
				rec.applied++
				if v, ok := snap.chat(rec.id); ok {
					durable := rec.d.apply(v, true)
					rec.d.States = snap.states(rec.id, v)
					r.keep(rec, durable)
				} else {
					durable := !rec.d.Gone
					rec.d.Gone = true
					r.keep(rec, durable)
				}
			}
			rec.mu.Unlock()
		}
		r.snapshotRuns(entry, &snap)
		// 3. The unstarted chats whose first message may have left, then the draft runs whose
		// start got no answer.
		if r.settle != nil {
			r.settle(entry, &snap)
		}
		if r.settleRuns != nil {
			r.settleRuns(entry, &snap)
		}
	}
	recs, runs := r.on(entry), r.runsOn(entry) // with the records step 3 made

	// 4. The pages' follows end: the server follows nothing for this one on its new stream.
	for _, rec := range recs {
		r.o.Bridge.Forget(editorbridge.Chat(rec.id))
	}
	r.forgetRuns(runs)
	// 5. Every page drops what it holds of the entry's chats and runs, and loads what it shows again.
	r.o.Bridge.Broadcast(map[string]any{"type": "server_back", "server": entry})
	// 6. The states and the view of every record, then the view of every run record.
	for _, rec := range recs {
		rec.mu.Lock()
		if !rec.removed {
			r.emit(rec)
		}
		rec.mu.Unlock()
	}
	r.emitRuns(runs)
	// The boards: their records, their events and what the hooks of boardrelay.go do.
	r.boardSnapshot(entry, raw)
	// 7. The unstarted chats on the entry get an agent of its lists, then its draft runs.
	if r.o.Local != nil {
		r.o.Local.ServerUp(entry)
	}
	if r.o.Runs != nil {
		r.o.Runs.ServerUp(entry)
	}
	// 8. The archive changes that are not confirmed are passed on.
	if r.pending != nil {
		r.spawn(func() { r.pending(r.ctx, entry) })
	}
	if r.pendingRuns != nil {
		r.spawn(func() { r.pendingRuns(r.ctx, entry) })
	}
}

// removed takes the removal of an entry: its records go with their files, the chats' before
// the runs', and its unstarted chats and its draft runs go back to this computer. An unstarted
// chat on one of its boards cannot: the board is nowhere now, so the chat is deleted, as the
// chats on a deleted run are. Nothing is sent to that server.
func (r *Relay) removed(entry string) {
	r.mu.Lock()
	r.left[entry] = true
	r.mu.Unlock()
	for _, rec := range r.on(entry) {
		rec.mu.Lock()
		if !rec.removed {
			r.drop(rec)
			r.emitRemoved(rec.id)
		}
		rec.mu.Unlock()
	}
	r.removedRuns(entry)
	boards := r.boardsOn(entry)
	r.removedBoards(entry)
	r.sendNoLists(entry)
	r.forgetFirsts(entry, true)
	if r.o.Local != nil {
		for _, rec := range boards {
			r.o.Local.DeleteOnBoard(rec.id)
		}
		for _, meta := range r.o.Local.UnstartedOn(entry) {
			if meta.Board != "" {
				continue // on a board of the entry: deleted, not put back
			}
			if err := r.o.Local.ResetServer(meta.ID); err != nil {
				r.o.Logf("remotes: the chat %s is not put back on this computer: %v", meta.ID, err)
			}
		}
	}
	r.resetDrafts(entry)
}

// ---- calls to a remote server ----

// call passes one call on to the entry's server and returns its answer, whatever its status.
// ErrUnreachable means that nothing was sent: the entry is not connected, and is made to try
// now if it waits. errTooLong means that the answer was above the size limit. ErrNoAnswer means
// that the call was sent and no answer came within limit.
func (r *Relay) call(ctx context.Context, entry, method, path string, body []byte, limit time.Duration) (servers.Reply, error) {
	rep, err := r.o.Servers.Do(ctx, entry, method, path, body, limit)
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

// connected reports whether the entry's state is connected. A call may still find it otherwise:
// what call returns is what holds.
func (r *Relay) connected(entry string) bool {
	v, ok := r.o.Servers.View(entry)
	return ok && !v.Local && v.State == servers.StateConnected
}

// chatPath is the path of the chat id on its server, with rest after it ("" or "/…").
func chatPath(id, rest string) string { return "/api/chats/" + url.PathEscape(id) + rest }

// follow passes a read of the record's chat on for the page client, which follows the chat from
// here on: the record's follow lock is held shared over the follow and the call. The read makes
// this server a follower there. When client has no stream here, so that no page's follow will
// ever end, the follow there is ended after the read, unless a page follows the chat.
func (r *Relay) follow(ctx context.Context, rec *record, client, method, path string, limit time.Duration) (servers.Reply, error) {
	rec.followMu.RLock()
	followed := r.o.Bridge.FollowAs(editorbridge.KindPage, client, editorbridge.Chat(rec.id))
	rep, err := r.call(ctx, rec.entry, method, path, nil, limit)
	rec.followMu.RUnlock()
	if !followed && !errors.Is(err, ErrUnreachable) {
		r.spawn(func() { r.unfollow(rec) })
	}
	return rep, err
}

// Unfollowed is the function for Bridge.OnUnfollowed: items lost their last follower here. For
// each one that is a chat with a record, a run with a record or the chat of a learned agent of
// such a run, its server is told to end this server's follow, unless a page follows the item
// again by then. So this server follows an item there exactly while one of its pages does.
func (r *Relay) Unfollowed(items []editorbridge.Item) {
	for _, it := range items {
		if it == editorbridge.Chat(it.ID) {
			if rec := r.rec(it.ID); rec != nil {
				r.spawn(func() { r.unfollow(rec) })
				continue
			}
		}
		r.unfollowedRun(it)
	}
}

// unfollow makes the unfollow call for the record's chat, with the follow lock held alone.
func (r *Relay) unfollow(rec *record) {
	rec.followMu.Lock()
	defer rec.followMu.Unlock()
	if r.o.Bridge.Followed(editorbridge.Chat(rec.id)) || rec.pub.Load().view.Gone {
		return // followed again, or no longer there: nothing follows a chat that is gone
	}
	// Not through call: an entry that is not connected follows nothing, and is not woken for this.
	rep, err := r.o.Servers.Do(r.ctx, rec.entry, http.MethodPost, chatPath(rec.id, "/unfollow"), nil, r.o.Limits.Unfollow)
	switch {
	case err == nil && (rep.Status == http.StatusOK || rep.Status == http.StatusNotFound),
		errors.Is(err, servers.ErrNotConnected), errors.Is(err, servers.ErrNotFound), r.ctx.Err() != nil:
	case err != nil:
		r.o.Logf("remotes: the unfollow of the chat %s got no answer", rec.id)
	default:
		r.o.Logf("remotes: the unfollow of the chat %s was answered with %d", rec.id, rep.Status)
	}
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
