package runs

import (
	"fmt"
	"log"
	"slices"
	"sync"
	"sync/atomic"
	"unicode/utf8"

	"ai-whiteboard/internal/model"
)

// run is one run in memory. Its recorded state changes only through commit.
//
// Locks. mu is the run's one lock. It is a short lock: nothing that can take long or call back
// happens under it, so with mu held never call the chat manager (ChatHost), git, the store, the
// bridge (Emit) or another run. What commit itself does under mu is write the entry's files and
// its journal line. mergeMu is taken before mu, never while mu is held, and never held while an
// agent works. The service's map lock (Service.mu) is never held while a run's mu is taken.
type run struct {
	svc *Service
	id  string
	dir string // store.Paths.RunDir(id)

	mu    sync.Mutex    // the run's one lock: meta, L, head, sum, facts, the journal counters, eng
	meta  model.RunMeta // run.json
	L     *Loaded       // nil: not started, or started and not read from disk yet (load reads it)
	head  *State        // a started run whose L is not read yet: the State of its last checkpoint; else nil
	sum   Summary       // counted from L after every entry; from the checkpoint while L is nil
	facts Facts         // what the service last found out about the folder (setFacts)
	jsize int64         // the journal's size after the last whole entry: where the next one goes
	cp    checkpointMark

	wake chan struct{} // buffered 1; commit signals the scheduler
	eng  *engine       // nil when no scheduler runs
	gone bool          // the run is being deleted (Service.Delete): commit writes nothing more

	// view is what Views() and the snapshot read: no lock taken. refreshView stores it.
	view atomic.Pointer[model.RunView]
	// delivery is the delivery as clients get it (deliveryOf), for a chat's context block, which
	// takes no lock either; nil when there is none. refreshView stores it.
	delivery atomic.Pointer[model.RunDelivery]

	// mergeMu serialises merges and the reset of the orchestrator's checkout; taken before mu,
	// never while mu is held, never held while an agent works.
	mergeMu sync.Mutex

	// onDetail, when set, sees every `run_detail` event commit queues, in order and with r.mu
	// held. Tests of the record layer set it; nothing else does.
	onDetail func(detailEvent)
}

// checkpointMark is what changed since the last checkpoint.
type checkpointMark struct {
	entries              int   // journal entries
	bytes                int64 // and their size
	tasks, turns, agents bool  // the collection files that are out of date
	written              bool  // the run has a checkpoint (state.json)
}

// newRun makes the run of a run.json in memory. Nothing else is read: open does that for a run
// that has started.
func newRun(s *Service, meta model.RunMeta) *run {
	r := &run{svc: s, id: meta.ID, dir: s.Store.P.RunDir(meta.ID), meta: meta, wake: make(chan struct{}, 1)}
	r.refreshView()
	return r
}

// noCost reports whether the run's agent kind reports no cost (Cursor): its cost is null.
func (r *run) noCost() bool { return r.meta.Agent == model.Cursor }

// open reads what the server needs to show a started run, when the server starts. When the
// journal holds nothing past the last checkpoint, that is state.json alone: the run is shown from
// its Summary and the other files are read when first needed (load). Otherwise the whole record
// is read, the journal's entries past the checkpoint are applied again, a torn last line is
// dropped, and a checkpoint is written. A run that has not started needs nothing.
func (r *run) open() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.meta.Started.IsZero() {
		r.refreshView()
		return nil
	}
	sf, ok, err := readHead(r.dir)
	if err != nil {
		return err
	}
	if size := journalSize(r.dir); ok && size <= sf.JournalOffset {
		st := sf.State
		r.head, r.sum, r.jsize = &st, sf.Summary, size
		r.refreshView()
		return nil
	}
	if err := r.loadLocked(); err != nil {
		return err
	}
	return r.checkpointLocked()
}

// load makes sure the recorded state of a started run is in memory (r.L). ErrNotStarted for a
// run whose goal was not sent.
func (r *run) load() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.loadLocked()
}

// loadLocked is load with r.mu held.
func (r *run) loadLocked() error {
	if r.L != nil {
		return nil
	}
	if r.meta.Started.IsZero() {
		return ErrNotStarted
	}
	l, info, err := loadRecord(r.dir)
	if err != nil {
		return err
	}
	r.L, r.head, r.jsize = l, nil, info.Size
	r.sum = l.Summarize(r.noCost())
	// What the journal held past the checkpoint is not in the checkpoint files yet. Which of them
	// that is, is not worth finding out: the next checkpoint writes all three.
	stale := info.Replayed > 0 || info.NoHead || info.Leftovers || info.Short
	r.cp = checkpointMark{entries: info.Replayed, bytes: info.Bytes, tasks: stale, turns: stale, agents: stale, written: !info.NoHead}
	r.refreshView()
	if info.Short {
		// The checkpoint points past the journal's end. The next entry must not be appended
		// before a checkpoint says where the journal ends now: a later load would otherwise
		// start reading in the middle of it.
		return r.checkpointLocked()
	}
	return nil
}

// checkpoint writes a checkpoint now: at a turn's end, a halt, the run's end, the server's
// shutdown. It locks r.mu itself. Nothing happens for a run with no state in memory.
func (r *run) checkpoint() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.checkpointLocked()
}

// checkpointLocked is checkpoint with r.mu held.
func (r *run) checkpointLocked() error {
	if r.L == nil {
		return nil
	}
	c := r.cp
	if c.written && c.entries == 0 && !c.tasks && !c.turns && !c.agents {
		return nil // nothing was committed since the last one
	}
	// Only the collection files that changed since the last checkpoint are written again.
	if err := writeCheckpoint(r.dir, r.L, r.sum, r.jsize, c.tasks, c.turns, c.agents); err != nil {
		return err
	}
	r.cp = checkpointMark{written: true}
	return nil
}

// setFacts records what the service found out about the run's folder (does it exist, is it in a
// git work tree, why the run cannot start or resume) and rebuilds the view. The facts are found
// out without r.mu held: they stat the folder and run git.
func (r *run) setFacts(f Facts) {
	r.mu.Lock()
	r.facts = f
	r.refreshView()
	r.mu.Unlock()
	r.changed()
}

// refresh rebuilds the view from the state as it is (after run.json changed, or when a running
// agent's cost moved) and tells the sender that it may have changed. It locks r.mu itself.
func (r *run) refresh() {
	r.mu.Lock()
	r.refreshView()
	r.mu.Unlock()
	r.changed()
}

// refreshView builds the run's view and stores it where Views and the snapshot read it without a
// lock. r.mu held (or the run not shared yet). The cost is the recorded one with the live cost
// of running agents in its place where the engine has one (r.live).
func (r *run) refreshView() {
	var st *State
	sum := r.sum
	switch {
	case r.L != nil:
		st = &r.L.State
		sum = withLiveCost(sum, r.L, r.live())
	case r.head != nil:
		st = r.head
	}
	v := ViewOf(r.meta, st, sum, r.facts)
	r.view.Store(&v)
	var d *model.RunDelivery
	if st != nil && !r.meta.Started.IsZero() && !sum.DeliveryStale {
		d = deliveryOf(*st)
	}
	r.delivery.Store(d)
}

// isGone reports whether the run is being deleted or is deleted.
func (r *run) isGone() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.gone
}

// viewNow is the run's view as last built. No lock is taken.
func (r *run) viewNow() model.RunView { return *r.view.Load() }

// withLiveCost is sum with the cost counted again from the agents as clients see them: an
// agent's live cost, where there is one, in place of its recorded one.
func withLiveCost(sum Summary, l *Loaded, live map[string]Live) Summary {
	if sum.Cost == nil || len(live) == 0 {
		return sum
	}
	total := 0.0
	for _, a := range l.Agents {
		if c := a.View(live[a.ID]).Cost; c != nil {
			total += *c
		}
	}
	sum.Cost = &total
	return sum
}

// snapshot is a copy of the recorded state to read after r.mu is released (a prompt, a tool's
// text): its lists are its own; the records in them are shared and never change in place. nil
// when the state is not in memory. r.mu held.
func (l *Loaded) snapshot() *Loaded {
	if l == nil {
		return nil
	}
	c := *l
	c.State = cloneState(l.State)
	c.Stops, c.Notes, c.Turns = slices.Clone(l.Stops), slices.Clone(l.Notes), slices.Clone(l.Turns)
	c.Tasks, c.ChatOps, c.Agents = slices.Clone(l.Tasks), slices.Clone(l.ChatOps), slices.Clone(l.Agents)
	return &c
}

// ---- commit ----------------------------------------------------------------

// detailEvent is the `run_detail` event: one per committed entry of a started run. Version is the
// entry's number and rises by exactly one per event.
type detailEvent struct {
	Type    string         `json:"type"` // "run_detail"
	Run     string         `json:"run"`
	Version int64          `json:"version"`
	Patch   model.RunPatch `json:"patch"`
}

// commit makes one change of the run's recorded state. build runs with r.mu held and describes
// the change on tx; when it returns an error, or a file or the journal cannot be written, nothing
// has changed. Otherwise: the files named with tx.File are written, the entry is appended as one
// line, the patch is applied (Loaded.Apply), the summary is counted again, the scheduler is woken
// and the entry's events are queued. commit locks and unlocks r.mu itself: never call it with
// r.mu held. v is the entry's number; 0 with a nil error when build called tx.Skip.
//
// After build, rule A2 is applied to every waiting task in the state as it will be, and the
// tasks whose phase changed go into the same entry: a task's end, its event and the release of
// its dependents are one line.
//
// The first entry of a run is KRunStarted, built on an empty state (tx.L() has nothing, tx.State
// gives a zero State to fill); it is refused (ErrStarted) for a run that has entries. Every other
// kind needs a started run (ErrNotStarted) and reads its state from disk when it is not in
// memory yet.
func (r *run) commit(kind EntryKind, build func(tx *Tx) error) (v int64, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.gone { // a worker that is still on its way must not write into a folder that is being removed
		return 0, ErrNotFound
	}

	base := r.L
	first := false
	switch {
	case kind == KRunStarted:
		if base == nil && !r.meta.Started.IsZero() {
			if err := r.loadLocked(); err != nil {
				return 0, err
			}
			base = r.L
		}
		if base != nil && base.Version > 0 {
			return 0, ErrStarted
		}
		base, first = &Loaded{}, true
	case base == nil:
		if err := r.loadLocked(); err != nil {
			return 0, err
		}
		base = r.L
	}

	tx := &Tx{r: r, base: base, now: r.svc.nowMs()}
	if err := build(tx); err != nil {
		return 0, err
	}
	if tx.skip {
		return 0, nil
	}
	tx.applyWaiting()
	patch := tx.patch()

	// 1. the text files the entry refers to
	for _, f := range tx.files {
		if err := writeText(r.dir, f.rel, f.data); err != nil {
			return 0, fmt.Errorf("write %s: %w", f.rel, err)
		}
	}
	// 2. the entry, as one line
	e := tx.head
	e.V, e.T, e.Kind, e.Patch = base.Version+1, tx.now, kind, patch
	at := r.jsize
	if first {
		at = 0 // whatever an earlier start left in the journal goes
	}
	size, err := appendJournal(r.dir, at, e)
	if err != nil {
		return 0, fmt.Errorf("append to the journal: %w", err)
	}
	// 3. memory
	before := base.State
	base.Apply(e.V, patch)
	r.L, r.head = base, nil
	r.sum = base.Summarize(r.noCost())
	r.cp.entries++
	r.cp.bytes += size - at
	r.jsize = size
	if first {
		r.cp = checkpointMark{entries: 1, bytes: size}
	}
	r.cp.tasks = r.cp.tasks || len(patch.Tasks) > 0
	r.cp.turns = r.cp.turns || len(patch.Turns)+len(patch.ChatOps) > 0
	r.cp.agents = r.cp.agents || len(patch.Agents) > 0
	r.refreshView()
	for _, f := range tx.after {
		f()
	}
	r.ctxMirror(tx.files) // the copies agents can read: best effort
	// 4. the scheduler
	select {
	case r.wake <- struct{}{}:
	default:
	}
	// 5. the events, in the order of the entries: the queue is a leaf lock
	ev := detailEvent{Type: "run_detail", Run: r.id, Version: e.V, Patch: WirePatch(before, patch, r.live())}
	if r.sum.DeliveryStale {
		ev.Patch.Delivery = nil // the halt after a resume that merged something: see Loaded.deliveryStale
	}
	if r.onDetail != nil {
		r.onDetail(ev)
	}
	r.svc.queue(r.id, ev)
	r.changed()

	if r.cp.entries >= checkpointEntries || r.cp.bytes >= checkpointBytes {
		if err := r.checkpointLocked(); err != nil {
			log.Printf("runs: checkpoint of %s: %v", r.id, err) // the entry is committed all the same
		}
	}
	return e.V, nil
}

// Tx describes one change of a run's recorded state, inside commit's build. Every record it hands
// out is a copy: the state in memory changes only when the entry has been written. A record asked
// for twice is the same copy, so changes add up. The copies are for build alone: once build has
// returned they belong to the entry, and nothing may change them any more.
type Tx struct {
	r    *run
	base *Loaded
	now  int64
	head Entry

	state   *State
	tasks   map[string]*Task
	added   []*Task // new tasks, in the order they were added
	turns   map[int]*Turn
	agents  map[string]*Agent
	chatOps []*model.RunOp
	notes   []model.NotesVersion
	stops   []model.RunStop
	setStop bool
	files   []txFile
	after   []func()
	skip    bool
}

type txFile struct {
	rel  string
	data []byte
}

// Now is the entry's time, unix milliseconds: every time the change records.
func (tx *Tx) Now() int64 { return tx.now }

// L is the state before the change; read only.
func (tx *Tx) L() *Loaded { return tx.base }

// Head sets what the entry says happened: Turn, Task, Attempt, Chat, Op and Error of h.
func (tx *Tx) Head(h Entry) {
	tx.head = Entry{Turn: h.Turn, Task: h.Task, Attempt: h.Attempt, Chat: h.Chat, Op: h.Op, Error: h.Error}
}

// State is a copy of the run-level record to change; it goes into the patch.
func (tx *Tx) State() *State {
	if tx.state == nil {
		s := cloneState(tx.base.State)
		tx.state = &s
	}
	return tx.state
}

// Task is a deep copy of a task to change, nil when there is none. It goes into the patch.
func (tx *Tx) Task(id string) *Task {
	if t, ok := tx.tasks[id]; ok {
		return t
	}
	for i := range tx.base.Tasks {
		if tx.base.Tasks[i].ID == id {
			t := cloneTask(tx.base.Tasks[i])
			if tx.tasks == nil {
				tx.tasks = map[string]*Task{}
			}
			tx.tasks[id] = &t
			return &t
		}
	}
	return nil
}

// AddTask puts a new task into the patch and returns it to change. A task with the same id is
// replaced.
func (tx *Tx) AddTask(t Task) *Task {
	c := cloneTask(t)
	if tx.tasks == nil {
		tx.tasks = map[string]*Task{}
	}
	if _, ok := tx.tasks[t.ID]; !ok && !tx.base.hasTask(t.ID) {
		tx.added = append(tx.added, &c)
	} else {
		for i, a := range tx.added {
			if a.ID == t.ID {
				tx.added[i] = &c
			}
		}
	}
	tx.tasks[t.ID] = &c
	return &c
}

// Turn is a deep copy of turn n to change, nil when there is none. It goes into the patch.
func (tx *Tx) Turn(n int) *Turn {
	if t, ok := tx.turns[n]; ok {
		return t
	}
	for i := range tx.base.Turns {
		if tx.base.Turns[i].N == n {
			t := cloneTurn(tx.base.Turns[i])
			if tx.turns == nil {
				tx.turns = map[int]*Turn{}
			}
			tx.turns[n] = &t
			return &t
		}
	}
	return nil
}

// AddTurn puts a new turn into the patch and returns it to change. WokenBy, Learned and Ops are
// made lists when they are nil (they are never null on the wire).
func (tx *Tx) AddTurn(t Turn) *Turn {
	c := cloneTurn(t)
	c.WokenBy, c.Learned, c.Ops = orEmpty(c.WokenBy), orEmpty(c.Learned), orEmpty(c.Ops)
	if tx.turns == nil {
		tx.turns = map[int]*Turn{}
	}
	tx.turns[t.N] = &c
	return &c
}

// Agent is a deep copy of an agent's record (by chat id) to change, nil when there is none. It
// goes into the patch.
func (tx *Tx) Agent(id string) *Agent {
	if a, ok := tx.agents[id]; ok {
		return a
	}
	for i := range tx.base.Agents {
		if tx.base.Agents[i].ID == id {
			a := cloneAgent(tx.base.Agents[i])
			if tx.agents == nil {
				tx.agents = map[string]*Agent{}
			}
			tx.agents[id] = &a
			return &a
		}
	}
	return nil
}

// AddAgent puts a new agent record into the patch and returns it to change. A record with the
// same id is replaced: ask Agent first when the record may exist.
func (tx *Tx) AddAgent(a Agent) *Agent {
	c := cloneAgent(a)
	if tx.agents == nil {
		tx.agents = map[string]*Agent{}
	}
	tx.agents[a.ID] = &c
	return &c
}

// AddChatOp appends a call a chat on the run made outside a turn to the run's chatOps and returns
// it to change. Its index I is set; T is the entry's time when it is 0.
func (tx *Tx) AddChatOp(op model.RunOp) *model.RunOp {
	c := cloneOp(op)
	c.I = len(tx.base.ChatOps) + len(tx.chatOps)
	if c.T == 0 {
		c.T = tx.now
	}
	tx.chatOps = append(tx.chatOps, &c)
	return &c
}

// AddNotes adds a notes version to the run's index (its text is a file: tx.File(notesRel(v), …)).
func (tx *Tx) AddNotes(n model.NotesVersion) { tx.notes = append(tx.notes, n) }

// Stops is a copy of the run's list of stops, to change (open a stop, close the open one) and
// give to SetStops. tx.L().Stops itself is read only, like everything of tx.L().
func (tx *Tx) Stops() []model.RunStop {
	if tx.setStop {
		return slices.Clone(tx.stops)
	}
	return slices.Clone(tx.base.Stops)
}

// SetStops replaces the run's list of stops, whole.
func (tx *Tx) SetStops(s []model.RunStop) { tx.stops, tx.setStop = orEmpty(slices.Clone(s)), true }

// Event makes an event for the orchestrator: it gets the next number (State.EventSeq), the
// entry's time when its T is 0, and goes to the end of the inbox.
func (tx *Tx) Event(e model.RunEvent) {
	st := tx.State()
	st.EventSeq++
	e.Seq = st.EventSeq
	if e.T == 0 {
		e.T = tx.now
	}
	st.Inbox = append(st.Inbox, e)
}

// File names a text file under the run's folder that belongs to the change (a brief revision, a
// notes version, a report, a changes file): rel is its path below the folder (briefRel, notesRel,
// reportRel, changesRel). The files are written before the entry; when one cannot be written the
// commit fails and nothing has changed.
func (tx *Tx) File(rel string, data []byte) { tx.files = append(tx.files, txFile{rel, data}) }

// After names something to do once the entry is written and applied, still in the same hold of
// r.mu (registering the worker of a task that was just started; reading the state the entry
// made). It does not run when the commit fails or is skipped. It must not call commit or
// anything else that takes r.mu.
func (tx *Tx) After(f func()) { tx.after = append(tx.after, f) }

// Skip makes the commit do nothing: no file, no entry, no event. commit returns 0 and nil.
func (tx *Tx) Skip() { tx.skip = true }

// task is the task as it will be: the copy the change holds, else the recorded one.
func (tx *Tx) task(id string) (Task, bool) {
	if t, ok := tx.tasks[id]; ok {
		return *t, true
	}
	for i := range tx.base.Tasks {
		if tx.base.Tasks[i].ID == id {
			return tx.base.Tasks[i], true
		}
	}
	return Task{}, false
}

// applyWaiting applies rule A2 to every waiting task in the state as it will be: a task whose
// waiting phase is not its last phase gets the new one, and so becomes part of the change.
func (tx *Tx) applyWaiting() {
	ids := make([]string, 0, len(tx.base.Tasks)+len(tx.added))
	for i := range tx.base.Tasks {
		ids = append(ids, tx.base.Tasks[i].ID)
	}
	for _, t := range tx.added {
		ids = append(ids, t.ID)
	}
	state := func(id string) (model.TaskState, bool) {
		t, ok := tx.task(id)
		if !ok {
			return "", false
		}
		return t.State(), true
	}
	for _, id := range ids {
		t, _ := tx.task(id)
		if !t.State().Waiting() || len(t.Attempts) == 0 {
			continue
		}
		p := waitingPhase(t, state)
		a := t.Attempts[len(t.Attempts)-1]
		if n := len(a.Phases); n > 0 && samePhase(a.Phases[n-1], p) {
			continue
		}
		p.T = tx.now
		w := tx.Task(id) // a copy to change
		last := &w.Attempts[len(w.Attempts)-1]
		last.Phases = append(last.Phases, p)
	}
}

// waitingPhase is rule A2: what a waiting task waits for. Held by anything in HeldBy: held (by
// the first holder: a turn, or a chat). Else a dependency failed or was cancelled: blocked, on
// those. Else dependencies are not done: deps, on those. Else: slot. state gives a task's state;
// a dependency that does not exist counts as not done.
func waitingPhase(t Task, state func(id string) (model.TaskState, bool)) model.RunPhase {
	if len(t.HeldBy) > 0 {
		h := t.HeldBy[0]
		return model.RunPhase{K: model.TaskHeld, Turn: h.Turn, Chat: h.Chat}
	}
	var bad, open []string
	for _, d := range t.DependsOn {
		switch s, _ := state(d); s {
		case model.TaskDone:
		case model.TaskFailed, model.TaskCancelled:
			bad = append(bad, d)
		default:
			open = append(open, d)
		}
	}
	switch {
	case len(bad) > 0:
		return model.RunPhase{K: model.TaskBlocked, On: bad}
	case len(open) > 0:
		return model.RunPhase{K: model.TaskDeps, On: open}
	}
	return model.RunPhase{K: model.TaskSlot}
}

// samePhase reports whether two phases say the same thing, whenever they began.
func samePhase(a, b model.RunPhase) bool {
	return a.K == b.K && a.Turn == b.Turn && a.Chat == b.Chat && slices.Equal(a.On, b.On)
}

// patch is the change as the entry records it: every record whole, tasks in creation order.
func (tx *Tx) patch() Patch {
	var p Patch
	p.State = tx.state
	if tx.setStop {
		p.Stops = tx.stops
	}
	p.Notes = tx.notes
	for _, t := range tx.turns {
		p.Turns = append(p.Turns, *t)
	}
	slices.SortFunc(p.Turns, func(a, b Turn) int { return a.N - b.N })
	for i := range tx.base.Tasks {
		if t, ok := tx.tasks[tx.base.Tasks[i].ID]; ok {
			p.Tasks = append(p.Tasks, *t)
		}
	}
	for _, t := range tx.added {
		p.Tasks = append(p.Tasks, *t)
	}
	for _, o := range tx.chatOps {
		p.ChatOps = append(p.ChatOps, *o)
	}
	for i := range tx.base.Agents { // recorded agents in their order, then the new ones by id
		if a, ok := tx.agents[tx.base.Agents[i].ID]; ok {
			p.Agents = append(p.Agents, *a)
		}
	}
	var fresh []Agent
	for id, a := range tx.agents {
		if !tx.base.hasAgent(id) {
			fresh = append(fresh, *a)
		}
	}
	slices.SortFunc(fresh, func(a, b Agent) int {
		if a.StartedAt != b.StartedAt {
			return int(a.StartedAt - b.StartedAt)
		}
		if a.ID < b.ID {
			return -1
		}
		return 1
	})
	p.Agents = append(p.Agents, fresh...)
	return p
}

func (l *Loaded) hasTask(id string) bool {
	return slices.ContainsFunc(l.Tasks, func(t Task) bool { return t.ID == id })
}

func (l *Loaded) hasAgent(id string) bool {
	return slices.ContainsFunc(l.Agents, func(a Agent) bool { return a.ID == id })
}

// ---- copies ----------------------------------------------------------------

// cloneWait is a copy of a wait with its own task list.
func cloneWait(w *model.RunWait) *model.RunWait {
	c := clonePtr(w)
	if c != nil {
		c.Tasks = slices.Clone(c.Tasks)
	}
	return c
}

func clonePtr[T any](p *T) *T {
	if p == nil {
		return nil
	}
	c := *p
	return &c
}

func cloneState(s State) State {
	s.Git, s.Result, s.Halting = clonePtr(s.Git), clonePtr(s.Result), clonePtr(s.Halting)
	s.Delivery = cloneDelivery(s.Delivery)
	s.Inbox, s.Wait = slices.Clone(s.Inbox), cloneWait(s.Wait)
	return s
}

func cloneTask(t Task) Task {
	t.DependsOn, t.ChangedTurns = slices.Clone(t.DependsOn), slices.Clone(t.ChangedTurns)
	t.Briefs, t.HeldBy = slices.Clone(t.Briefs), slices.Clone(t.HeldBy)
	t.NeedsReport = slices.Clone(t.NeedsReport)
	t.Attempts = slices.Clone(t.Attempts)
	for i := range t.Attempts {
		a := &t.Attempts[i]
		a.Phases = slices.Clone(a.Phases)
		for j := range a.Phases {
			a.Phases[j].On = slices.Clone(a.Phases[j].On)
		}
		a.Cancel, a.Result, a.Cost = clonePtr(a.Cancel), clonePtr(a.Result), clonePtr(a.Cost)
		a.Conflicts = slices.Clone(a.Conflicts)
	}
	return t
}

func cloneOp(o model.RunOp) model.RunOp {
	o.Writes = clonePtr(o.Writes)
	o.DependsOn, o.Changed = slices.Clone(o.DependsOn), slices.Clone(o.Changed)
	o.NeedsReport, o.Tasks = slices.Clone(o.NeedsReport), slices.Clone(o.Tasks)
	return o
}

func cloneTurn(t Turn) Turn {
	t.WokenBy, t.Learned = slices.Clone(t.WokenBy), slices.Clone(t.Learned)
	t.Ops = slices.Clone(t.Ops)
	for i := range t.Ops {
		t.Ops[i] = cloneOp(t.Ops[i])
	}
	t.Cost, t.Wait = clonePtr(t.Cost), cloneWait(t.Wait)
	return t
}

func cloneAgent(a Agent) Agent {
	a.Launches = slices.Clone(a.Launches)
	a.Cost, a.Tokens = clonePtr(a.Cost), clonePtr(a.Tokens)
	return a
}

// ---- small things the service, the tools and the engine share ---------------

// clip cuts s to at most max characters: a longer text keeps its first max-1 and ends with "…".
// It is the one way recorded texts are shortened (an event's text: 600, a refusal: 400).
func clip(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max-1]) + "…"
}
