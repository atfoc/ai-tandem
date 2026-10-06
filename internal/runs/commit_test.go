package runs

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// record is everything of a run that a failed commit must leave alone.
type record struct {
	state   string
	version int64
	journal string
	files   string // state.json, tasks.json, turns.json, agents.json
	sum     Summary
	view    model.RunView
}

func recordOf(t *testing.T, r *run) record {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	rec := record{state: dump(t, r.L), version: r.L.Version, sum: r.sum, view: r.viewNow()}
	b, _ := os.ReadFile(filepath.Join(r.dir, fileJournal))
	rec.journal = string(b)
	for _, name := range []string{fileState, fileTasks, fileTurns, fileAgents} {
		b, _ := os.ReadFile(filepath.Join(r.dir, name))
		rec.files += name + ":" + string(b)
	}
	return rec
}

func sameRecord(t *testing.T, what string, got, want record) {
	t.Helper()
	if got.state != want.state || got.version != want.version {
		t.Errorf("%s: the state in memory changed (version %d, was %d)", what, got.version, want.version)
	}
	if got.journal != want.journal {
		t.Errorf("%s: the journal changed (%d bytes, was %d)", what, len(got.journal), len(want.journal))
	}
	if got.files != want.files {
		t.Errorf("%s: a checkpoint file changed", what)
	}
	if asJSON(got.sum) != asJSON(want.sum) || asJSON(got.view) != asJSON(want.view) {
		t.Errorf("%s: the summary or the view changed", what)
	}
}

func asJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// addTask is a build that adds a task held by turn 1, with its brief file.
func addTask(id string, deps ...string) func(tx *Tx) error {
	return func(tx *Tx) error {
		tx.Head(Entry{Op: "add_task", Task: id})
		tx.AddTask(Task{ID: id, Title: "task " + id, Kind: "implement", Writes: true, DependsOn: deps, CreatedAt: tx.Now(), BriefRev: 1,
			Briefs:   []model.BriefRev{{Rev: 1, At: tx.Now(), Size: 5}},
			Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, QueuedAt: tx.Now()}}}})
		tx.File(briefRel(id, 1), []byte("brief"))
		return nil
	}
}

// A build that returns an error, a text file that cannot be written and a journal append that
// fails each leave memory, the journal and the files of record as they were.
func TestCommitFailureChangesNothing(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("file permissions do not stop root")
	}
	e := newTestEnv(t)
	r := e.started("r_fail")
	e.must(r, KOp, addTask("T01"))
	if err := r.checkpoint(); err != nil {
		t.Fatal(err)
	}
	e.must(r, KOp, addTask("T02", "T01"))
	var events []detailEvent
	afterRan := 0
	r.onDetail = func(ev detailEvent) { events = append(events, ev) }
	<-r.wake // the signal of the entries so far
	before := recordOf(t, r)

	// 1. build returns an error, after it has asked for copies and changed them.
	boom := errors.New("refused")
	v, err := r.commit(KOp, func(tx *Tx) error {
		tx.State().IdleStreak = 9
		tx.Task("T01").Title = "changed"
		tx.AddTask(Task{ID: "T09", Attempts: []Attempt{{}}})
		tx.Event(model.RunEvent{Type: "chat_op", Text: "x"})
		tx.File(notesRel(1), []byte("notes"))
		tx.After(func() { afterRan++ })
		return boom
	})
	if v != 0 || err != boom {
		t.Fatalf("a failing build: v %d, err %v", v, err)
	}
	sameRecord(t, "a failing build", recordOf(t, r), before)
	if _, err := os.Stat(filepath.Join(r.dir, notesRel(1))); !os.IsNotExist(err) {
		t.Errorf("a failing build wrote its file: %v", err)
	}

	// 2. a text file that cannot be written: "notes" is a file, so notes/v0001.md has no folder.
	if err := os.WriteFile(filepath.Join(r.dir, "notes"), []byte("in the way"), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err = r.commit(KOp, func(tx *Tx) error {
		tx.State().IdleStreak = 9
		tx.AddNotes(model.NotesVersion{V: 1, At: tx.Now(), Size: 5})
		tx.File(briefRel("T01", 2), []byte("this one can be written"))
		tx.File(notesRel(1), []byte("notes"))
		tx.After(func() { afterRan++ })
		return nil
	})
	if v != 0 || err == nil || !strings.Contains(err.Error(), "notes/v0001.md") {
		t.Fatalf("an unwritable file: v %d, err %v", v, err)
	}
	sameRecord(t, "an unwritable file", recordOf(t, r), before)
	if err := os.Remove(filepath.Join(r.dir, "notes")); err != nil {
		t.Fatal(err)
	}

	// 3. the journal cannot be appended to.
	journal := filepath.Join(r.dir, fileJournal)
	if err := os.Chmod(journal, 0o400); err != nil {
		t.Fatal(err)
	}
	build := func(tx *Tx) error {
		tx.Head(Entry{Op: "set_notes"})
		tx.State().IdleStreak = 9
		tx.AddNotes(model.NotesVersion{V: 1, At: tx.Now(), Size: 5})
		tx.File(notesRel(1), []byte("notes"))
		tx.After(func() { afterRan++ })
		return nil
	}
	v, err = r.commit(KOp, build)
	if v != 0 || err == nil || !strings.Contains(err.Error(), "journal") {
		t.Fatalf("a failing append: v %d, err %v", v, err)
	}
	sameRecord(t, "a failing append", recordOf(t, r), before)
	// The crash point between the two writes: the text file is there, its entry is not. A restart
	// reads the state of the last whole entry and takes no notice of the file.
	if _, err := os.Stat(filepath.Join(r.dir, notesRel(1))); err != nil {
		t.Fatalf("the text file of the entry that failed is not there: %v", err)
	}
	if got, info, err := loadRecord(r.dir); err != nil || dump(t, got) != before.state || len(got.Notes) != 0 || info.Torn {
		t.Errorf("a load with a text file that has no entry: %v", err)
	}
	if len(events) != 0 || afterRan != 0 {
		t.Errorf("failed commits queued %d events and ran %d After functions", len(events), afterRan)
	}
	select {
	case <-r.wake:
		t.Error("a failed commit woke the scheduler")
	default:
	}

	// The same change made again succeeds, with the next version, over the file left behind.
	if err := os.Chmod(journal, 0o600); err != nil {
		t.Fatal(err)
	}
	v, err = r.commit(KOp, build)
	if err != nil || v != before.version+1 {
		t.Fatalf("the commit made again: v %d (want %d), err %v", v, before.version+1, err)
	}
	if text, err := readNotes(r.dir, 1); err != nil || text != "notes" {
		t.Errorf("notes file: %q, %v", text, err)
	}
	if len(events) != 1 || events[0].Version != v || afterRan != 1 {
		t.Errorf("after the good commit: %d events, After ran %d times", len(events), afterRan)
	}
	// And a restart reads exactly what is in memory.
	want := dump(t, r.L)
	if got, _, err := loadRecord(r.dir); err != nil || dump(t, got) != want {
		t.Errorf("what a restart reads differs from memory (%v)", err)
	}
}

// A write that fails part way leaves nothing of itself in the journal.
func TestAppendJournalCutsBack(t *testing.T) {
	dir := t.TempDir()
	size, err := appendJournal(dir, 0, Entry{V: 1, Kind: KRunStarted})
	if err != nil {
		t.Fatal(err)
	}
	// Bytes past the recorded end (a torn line, the rest of a failed write) are cut off first.
	path := filepath.Join(dir, fileJournal)
	whole, _ := os.ReadFile(path)
	if err := os.WriteFile(path, append(append([]byte(nil), whole...), []byte(`{"v":2,"t":17,"ki`)...), 0o600); err != nil {
		t.Fatal(err)
	}
	size2, err := appendJournal(dir, size, Entry{V: 2, Kind: KOp})
	if err != nil {
		t.Fatal(err)
	}
	es, end, torn, err := readJournal(dir, 0)
	if err != nil || torn || len(es) != 2 || es[1].V != 2 || es[1].Kind != KOp || end != size2 {
		t.Fatalf("after an append over a torn line: %d entries, end %d of %d, torn %v, %v", len(es), end, size2, torn, err)
	}
	// A journal that lost bytes it had is never appended to blindly.
	if _, err := appendJournal(dir, size2+10, Entry{V: 3}); err == nil {
		t.Error("an append past the end of the file succeeded")
	}
	if journalSize(dir) != size2 {
		t.Error("a refused append changed the file")
	}
	// Reading from an offset, and from one past the end.
	if es, end, _, _ := readJournal(dir, size); len(es) != 1 || es[0].V != 2 || end != size2 {
		t.Errorf("read from %d: %d entries, end %d", size, len(es), end)
	}
	if es, end, _, _ := readJournal(dir, size2+100); len(es) != 0 || end != size2 {
		t.Errorf("read from past the end: %d entries, end %d", len(es), end)
	}
	if es, end, torn, err := readJournal(t.TempDir(), 0); len(es) != 0 || end != 0 || torn || err != nil {
		t.Errorf("a missing journal: %d entries, end %d, torn %v, %v", len(es), end, torn, err)
	}
}

// Versions rise by one per entry, a skipped commit takes none, and every entry queues one
// `run_detail` event in the order of the entries.
func TestCommitVersionsSkipAndEvents(t *testing.T) {
	e := newTestEnv(t)
	r := e.draft("r_ver")
	var events []detailEvent
	locked := true
	r.onDetail = func(ev detailEvent) {
		events = append(events, ev)
		if r.mu.TryLock() { // queued under the run's lock, so the order is the entries'
			locked = false
			r.mu.Unlock()
		}
	}

	// Nothing but the start can be committed to a run that has not started.
	if _, err := r.commit(KOp, addTask("T01")); err != ErrNotStarted {
		t.Fatalf("an entry of a draft: %v", err)
	}
	e.clock.Advance(time.Second)
	v, err := r.commit(KRunStarted, func(tx *Tx) error {
		if tx.L().Version != 0 || len(tx.L().Tasks) != 0 {
			t.Error("the first entry is not built on an empty state")
		}
		st := tx.State()
		st.Status, st.StartedAt, st.AsOf, st.GoalSize = model.RunRunning, tx.Now(), tx.Now(), 5
		st.Git = &Git{RunGit: model.RunGit{BaseRef: "aaaa", IntegrationBranch: "aiwb/r_ver/integration"}, Repo: "/repo"}
		return nil
	})
	if err != nil || v != 1 {
		t.Fatalf("the first entry: v %d, %v", v, err)
	}
	if _, err := r.commit(KRunStarted, func(tx *Tx) error { return nil }); err != ErrStarted {
		t.Fatalf("a second start: %v", err)
	}
	if v := e.must(r, KOp, addTask("T01")); v != 2 {
		t.Fatalf("second entry has version %d", v)
	}
	ran := false
	if v, err := r.commit(KOp, func(tx *Tx) error {
		tx.State().IdleStreak = 5
		tx.File(notesRel(1), []byte("x"))
		tx.After(func() { ran = true })
		tx.Skip()
		return nil
	}); v != 0 || err != nil || ran {
		t.Fatalf("a skipped commit: v %d, %v, After ran %v", v, err, ran)
	}
	if _, err := os.Stat(filepath.Join(r.dir, notesRel(1))); !os.IsNotExist(err) {
		t.Error("a skipped commit wrote its file")
	}
	e.clock.Advance(time.Second)
	if v := e.must(r, KOp, func(tx *Tx) error {
		if got := tx.L().Version; got != 2 {
			t.Errorf("tx.L() is at version %d, want 2", got)
		}
		tx.Head(Entry{Turn: 3, Task: "T01", Attempt: 1, Chat: "c", Op: "update_task", Error: "no"})
		tx.Task("T01").Title = "renamed"
		if tx.L().Tasks[0].Title != "task T01" || tx.Task("T01").Title != "renamed" {
			t.Error("tx.L() shows the change, or tx.Task does not keep it")
		}
		if tx.Task("T77") != nil || tx.Turn(4) != nil || tx.Agent("nobody") != nil {
			t.Error("a record that does not exist is not nil")
		}
		tx.After(func() {
			ran = true
			if r.L.Version != 3 || r.L.Tasks[0].Title != "renamed" || r.mu.TryLock() {
				t.Error("After did not run on the applied state with the lock held")
			}
		})
		return nil
	}); v != 3 || !ran {
		t.Fatalf("third entry: version %d, After ran %v", v, ran)
	}

	entries := readEntries(t, r.dir)
	if len(entries) != 3 || len(events) != 3 || !locked {
		t.Fatalf("%d entries, %d events, queued under the lock %v", len(entries), len(events), locked)
	}
	for i, ev := range events {
		en := entries[i]
		if ev.Type != "run_detail" || ev.Run != "r_ver" || ev.Version != int64(i+1) || en.V != ev.Version {
			t.Errorf("event %d: %+v (entry %d)", i, ev, en.V)
		}
	}
	// The entry: its time, its kind, its head, whole records.
	en := entries[2]
	if en.T != e.clock.Now().UnixMilli() || en.Kind != KOp || en.Turn != 3 || en.Task != "T01" || en.Attempt != 1 || en.Chat != "c" ||
		en.Op != "update_task" || en.Error != "no" {
		t.Errorf("entry 3: %+v", en)
	}
	if len(en.Patch.Tasks) != 1 || en.Patch.Tasks[0].Title != "renamed" || len(en.Patch.Tasks[0].Briefs) != 1 || en.Patch.State != nil {
		t.Errorf("entry 3's patch: %+v", en.Patch)
	}
	// The events are the wire patches: scalars only when they changed, tasks as clients get them.
	if p := events[0].Patch; p.Status != model.RunRunning || p.StartedAt == 0 || p.GoalSize != 5 || p.Git == nil || p.Git.BaseRef != "aaaa" {
		t.Errorf("first patch: %+v", p)
	}
	if p := events[1].Patch; p.Status != "" || p.StartedAt != 0 || p.Git != nil || len(p.Tasks) != 1 || p.Tasks[0].ID != "T01" || len(p.Tasks[0].Attempts[0].Phases) != 1 {
		t.Errorf("second patch: %+v", p)
	}
	// The scheduler was woken, once however many entries there were.
	select {
	case <-r.wake:
	default:
		t.Error("commit did not wake the scheduler")
	}
	select {
	case <-r.wake:
		t.Error("two wake signals are queued")
	default:
	}
	// The view follows every entry without a lock.
	if v := r.viewNow(); v.Status != model.RunDraft || v.Counts.Slot != 1 {
		// run.json has no Started yet (the service writes it after entry 1): still a draft to clients.
		t.Errorf("view before run.json says started: status %q, counts %+v", v.Status, v.Counts)
	}
	r.mu.Lock()
	r.meta.Started, r.meta.Git = e.clock.Now(), true
	r.mu.Unlock()
	r.refresh()
	if v := r.viewNow(); v.Status != model.RunRunning || v.Counts.Slot != 1 || v.Cost == nil || !v.Git {
		t.Errorf("view: %+v", v)
	}
}

// What Tx hands out are copies: changing them, or the records given to Add…, never reaches the
// state in memory except through the entry.
func TestTxCopies(t *testing.T) {
	e := newTestEnv(t)
	r := e.started("r_copy")
	deps := []string{"T00"}
	given := Task{ID: "T01", DependsOn: deps, Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, Phases: []model.RunPhase{{K: model.TaskDeps, On: []string{"T00"}}}}}}}
	var kept *Task
	e.must(r, KOp, func(tx *Tx) error {
		kept = tx.AddTask(given)
		kept.Title = "set through the pointer"
		if tx.Task("T01") != kept {
			t.Error("tx.Task of an added task is another copy")
		}
		ag := tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: "a1", Launches: []model.RunLaunch{{N: 1}}}})
		if tx.Agent("a1") != ag {
			t.Error("tx.Agent of an added agent is another copy")
		}
		tn := tx.AddTurn(Turn{N: 1})
		if tx.Turn(1) != tn || tn.Ops == nil || tn.WokenBy == nil || tn.Learned == nil {
			t.Error("AddTurn: another copy, or a null list")
		}
		op := tx.AddChatOp(model.RunOp{Op: "add_task", DependsOn: deps})
		op2 := tx.AddChatOp(model.RunOp{Op: "tell_orchestrator", T: 5})
		if op.I != 0 || op2.I != 1 || op.T != tx.Now() || op2.T != 5 {
			t.Errorf("chat ops: %+v %+v", op, op2)
		}
		tx.Event(model.RunEvent{Type: "chat_op", Text: "one"})
		tx.Event(model.RunEvent{Type: "chat_op", Text: "two", T: 7})
		return nil
	})
	if r.L.Tasks[0].Title != "set through the pointer" {
		t.Fatal("a change through the returned pointer is not in the entry")
	}
	if in := r.L.State.Inbox; len(in) != 2 || in[0].Seq != 1 || in[1].Seq != 2 || in[0].T == 0 || in[1].T != 7 || r.L.State.EventSeq != 2 {
		t.Errorf("events: %+v, seq %d", in, r.L.State.EventSeq)
	}
	// After the commit, neither the caller's record nor the pointer build got reaches memory.
	deps[0] = "CHANGED"
	given.Attempts[0].Phases[0].On[0] = "CHANGED"
	kept.DependsOn[0] = "ALSO"
	if got := r.L.Tasks[0]; got.DependsOn[0] != "T00" && got.DependsOn[0] != "ALSO" {
		t.Errorf("dependsOn in memory: %v", got.DependsOn)
	}
	if got := r.L.Tasks[0].Attempts[0].Phases[0].On[0]; got != "T00" {
		t.Errorf("the caller's record is shared with memory: %q", got)
	}
	if got := r.L.ChatOps[0].DependsOn[0]; got != "T00" {
		t.Errorf("the caller's op is shared with memory: %q", got)
	}
	// A later build changes its copies; memory keeps the old values until the entry is applied,
	// and for good when the build fails.
	before := dump(t, r.L)
	_, err := r.commit(KOp, func(tx *Tx) error {
		tk := tx.Task("T01")
		tk.DependsOn[0] = "X"
		tk.Attempts[0].Phases[0].On[0] = "X"
		tk.Attempts[0].Phases = append(tk.Attempts[0].Phases, model.RunPhase{K: model.TaskSlot})
		tx.Agent("a1").Launches[0].Error = "X"
		tx.Turn(1).Ops = append(tx.Turn(1).Ops, model.RunOp{Op: "x"})
		tx.State().Inbox[0].Text = "X"
		return errors.New("no")
	})
	if err == nil || dump(t, r.L) != before {
		t.Error("a failed build changed the state in memory through a copy")
	}
}

// Stops are changed on a copy and replaced whole.
func TestTxStops(t *testing.T) {
	e := newTestEnv(t)
	r := e.started("r_stops")
	e.must(r, KRunHalted, func(tx *Tx) error {
		if len(tx.Stops()) != 0 {
			t.Error("a run that never halted has stops")
		}
		tx.SetStops(append(tx.Stops(), model.RunStop{At: tx.Now(), Reason: model.StopAppQuit}))
		if got := tx.Stops(); len(got) != 1 || len(tx.L().Stops) != 0 {
			t.Errorf("Stops after SetStops: %+v; before the change: %+v", got, tx.L().Stops)
		}
		return nil
	})
	_, err := r.commit(KRunResumed, func(tx *Tx) error {
		stops := tx.Stops()
		stops[0].ResumedAt = 99
		tx.SetStops(stops)
		return errors.New("no")
	})
	if err == nil || r.L.Stops[0].ResumedAt != 0 {
		t.Fatal("a failed build closed the stop in memory")
	}
	e.must(r, KRunResumed, func(tx *Tx) error {
		stops := tx.Stops()
		stops[0].ResumedAt = 99
		tx.SetStops(stops)
		return nil
	})
	if len(r.L.Stops) != 1 || r.L.Stops[0].ResumedAt != 99 || r.L.Stops[0].Reason != model.StopAppQuit {
		t.Errorf("stops: %+v", r.L.Stops)
	}
	es := readEntries(t, r.dir)
	if p := es[len(es)-1].Patch; len(p.Stops) != 1 || p.State != nil {
		t.Errorf("the entry of a change of stops alone: %+v", p)
	}
}

// A snapshot stays what it was while the run goes on.
func TestSnapshotIsStable(t *testing.T) {
	e := newTestEnv(t)
	r := e.started("r_snap")
	e.must(r, KOp, addTask("T01"))
	r.mu.Lock()
	snap := r.L.snapshot()
	want := dump(t, snap)
	detail := r.L.Detail(r.id, nil)
	r.mu.Unlock()
	for i := 2; i < 6; i++ {
		e.must(r, KOp, addTask(TaskID(i)))
		e.must(r, KOp, func(tx *Tx) error { tx.Task("T01").Title += "!"; tx.State().IdleStreak++; return nil })
	}
	if dump(t, snap) != want || len(snap.Tasks) != 1 || snap.Tasks[0].Title != "task T01" {
		t.Error("the snapshot changed with the run")
	}
	if len(detail.Tasks) != 1 || detail.Tasks[0].Title != "task T01" || detail.Version != 2 {
		t.Errorf("the detail changed with the run: %d tasks, version %d", len(detail.Tasks), detail.Version)
	}
	var none *Loaded
	if none.snapshot() != nil {
		t.Error("the snapshot of no state is not nil")
	}
}

// After a restart a run is shown from its checkpoint alone; its state is read when it is first
// needed, and the next entry continues the numbering.
func TestOpenLoadAndContinue(t *testing.T) {
	e := newTestEnv(t)
	p := playRun(e, "r_open")
	if err := p.r.checkpoint(); err != nil {
		t.Fatal(err)
	}
	final, last, view := p.dumps[len(p.dumps)-1], p.r.L.Version, p.r.viewNow()

	// 1. The journal holds nothing past the checkpoint: state.json is enough.
	r := e.reopen("r_open")
	if r.L != nil || r.head == nil {
		t.Fatal("open read the whole record though the checkpoint was current")
	}
	if got := r.viewNow(); asJSON(got) != asJSON(view) {
		t.Errorf("the view from the checkpoint differs:\n%s\n%s", asJSON(got), asJSON(view))
	}
	if err := r.load(); err != nil {
		t.Fatal(err)
	}
	if dump(t, r.L) != final || r.head != nil {
		t.Error("load did not read the state")
	}
	// 2. Entries past the checkpoint: open applies them again and writes a checkpoint.
	r = e.reopen("r_open")
	v := e.must(r, KTaskWait, func(tx *Tx) error { tx.State().IdleStreak = 4; return nil }) // loads by itself
	if v != last+1 {
		t.Fatalf("the entry after a restart has version %d, want %d", v, last+1)
	}
	want := dump(t, r.L)
	if sf, _, _ := readHead(r.dir); sf.Version != last {
		t.Fatalf("state.json is at version %d before the restart, want %d", sf.Version, last)
	}
	r = e.reopen("r_open")
	if r.L == nil || dump(t, r.L) != want || r.L.Version != v {
		t.Fatal("open did not apply the entry past the checkpoint")
	}
	if sf, _, _ := readHead(r.dir); sf.Version != v || sf.JournalOffset != journalSize(r.dir) || sf.State.IdleStreak != 4 {
		t.Errorf("open wrote no checkpoint: state.json at version %d, offset %d", sf.Version, sf.JournalOffset)
	}
	// 3. No state.json at all (the start crashed before its checkpoint): everything is read.
	os.Remove(filepath.Join(r.dir, fileState))
	r = e.reopen("r_open")
	if r.L == nil || dump(t, r.L) != want {
		t.Error("open without state.json did not rebuild the state from the journal")
	}
	if _, ok, _ := readHead(r.dir); !ok {
		t.Error("open without state.json wrote none")
	}
	// A draft needs nothing, and has no state to load.
	d := e.draft("r_draft")
	if err := d.open(); err != nil || d.L != nil {
		t.Errorf("open of a draft: %v", err)
	}
	if err := d.load(); err != ErrNotStarted {
		t.Errorf("load of a draft: %v", err)
	}
	if err := d.checkpoint(); err != nil {
		t.Errorf("checkpoint of a draft: %v", err)
	}
	if _, err := os.Stat(filepath.Join(d.dir, fileState)); !os.IsNotExist(err) {
		t.Error("a draft got a state.json")
	}
}

// A checkpoint is written by itself every 200 entries, and writes only the collection files that
// changed.
func TestCheckpointByItself(t *testing.T) {
	e := newTestEnv(t)
	r := e.started("r_auto") // entry 1 and a checkpoint
	e.must(r, KOp, addTask("T01"))
	for i := 0; i < checkpointEntries-2; i++ {
		e.must(r, KTaskWait, func(tx *Tx) error { tx.State().IdleStreak++; return nil })
	}
	if sf, _, _ := readHead(r.dir); sf.Version != 1 {
		t.Fatalf("a checkpoint came early: version %d after %d entries", sf.Version, r.L.Version)
	}
	if _, err := os.Stat(filepath.Join(r.dir, fileTasks)); !os.IsNotExist(err) {
		t.Fatal("tasks.json exists before any checkpoint with tasks")
	}
	e.must(r, KTaskWait, func(tx *Tx) error { tx.State().IdleStreak++; return nil }) // the 200th since the checkpoint
	sf, ok, err := readHead(r.dir)
	if err != nil || !ok || sf.Version != int64(checkpointEntries)+1 || sf.JournalOffset != journalSize(r.dir) {
		t.Fatalf("no checkpoint after %d entries: version %d, offset %d of %d (%v)", checkpointEntries, sf.Version, sf.JournalOffset, journalSize(r.dir), err)
	}
	if sf.Summary.Counts.Slot != 1 || sf.State.IdleStreak != checkpointEntries-1 {
		t.Errorf("the checkpoint's head: %+v", sf)
	}
	var tf TasksFile
	if ok, err := readJSON(filepath.Join(r.dir, fileTasks), &tf); !ok || err != nil || tf.Version != sf.Version || len(tf.Tasks) != 1 {
		t.Errorf("tasks.json: %+v, %v", tf, err)
	}
	// Turns and agents did not change: their files were not written.
	for _, name := range []string{fileTurns, fileAgents} {
		if _, err := os.Stat(filepath.Join(r.dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s was written though nothing in it changed", name)
		}
	}
	// A checkpoint with nothing new writes nothing.
	fi, _ := os.Stat(filepath.Join(r.dir, fileState))
	if err := r.checkpoint(); err != nil {
		t.Fatal(err)
	}
	if fi2, _ := os.Stat(filepath.Join(r.dir, fileState)); !fi2.ModTime().Equal(fi.ModTime()) {
		t.Error("a checkpoint with nothing new wrote state.json again")
	}
	// The size limit: one large entry is enough.
	big := strings.Repeat("x", checkpointBytes)
	v := e.must(r, KOp, func(tx *Tx) error { tx.Task("T01").Title = big; return nil })
	if sf, _, _ := readHead(r.dir); sf.Version != v {
		t.Errorf("no checkpoint after %d journal bytes", checkpointBytes)
	}
	// What a restart reads from these files is the state in memory.
	if got, info, err := loadRecord(r.dir); err != nil || dump(t, got) != dump(t, r.L) || info.Replayed != 0 {
		t.Errorf("load after the checkpoints: replayed %d, %v", info.Replayed, err)
	}
}

// A start that did not get to write run.json leaves a journal behind: the next start begins a
// new one.
func TestStartOverLeftovers(t *testing.T) {
	e := newTestEnv(t)
	r := e.draft("r_left")
	if _, err := appendJournal(r.dir, 0, Entry{V: 1, Kind: KRunStarted, Patch: Patch{State: &State{GoalSize: 999}}}); err != nil {
		t.Fatal(err)
	}
	v := e.must(r, KRunStarted, func(tx *Tx) error { tx.State().GoalSize = 7; return nil })
	es := readEntries(t, r.dir)
	if v != 1 || len(es) != 1 || es[0].Patch.State.GoalSize != 7 {
		t.Errorf("the journal after a start over leftovers: %d entries", len(es))
	}
	if err := removeRecord(r.dir); err != nil {
		t.Fatal(err)
	}
	if journalSize(r.dir) != 0 {
		t.Error("removeRecord left the journal")
	}
	if err := removeRecord(r.dir); err != nil {
		t.Errorf("removeRecord with nothing to remove: %v", err)
	}
}

// Commits from many goroutines are one after the other: every entry has its own version, the
// journal has them in order, the events come in the same order, and the view can be read all the
// while without a lock.
func TestCommitConcurrent(t *testing.T) {
	e := newTestEnv(t)
	r := e.started("r_conc")
	var versions []int64
	r.onDetail = func(ev detailEvent) { versions = append(versions, ev.Version) } // under r.mu
	const workers, each = 8, 25
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			default:
				_ = r.viewNow().Counts
			}
		}
	}()
	errs := make(chan error, workers)
	for w := 0; w < workers; w++ {
		go func(w int) {
			for i := 0; i < each; i++ {
				_, err := r.commit(KOp, func(tx *Tx) error {
					n := len(tx.L().Tasks) + 1
					tx.AddTask(Task{ID: TaskID(n), CreatedAt: tx.Now(), Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1}}}})
					tx.State().IdleStreak = n
					return nil
				})
				if err != nil {
					errs <- err
					return
				}
				if i%10 == 0 {
					if err := r.checkpoint(); err != nil {
						errs <- err
						return
					}
				}
			}
			errs <- nil
		}(w)
	}
	for w := 0; w < workers; w++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
	close(done)
	const total = workers * each
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.L.Version != total+1 || len(r.L.Tasks) != total || r.L.State.IdleStreak != total || len(versions) != total {
		t.Fatalf("version %d, %d tasks, idle streak %d, %d events; want %d entries on top of the start", r.L.Version, len(r.L.Tasks), r.L.State.IdleStreak, len(versions), total)
	}
	for i, v := range versions {
		if v != int64(i+2) {
			t.Fatalf("event %d has version %d", i, v)
		}
	}
	for i, tk := range r.L.Tasks {
		if tk.ID != TaskID(i+1) {
			t.Fatalf("task %d is %s: tasks are not in creation order", i, tk.ID)
		}
	}
	es := readEntries(t, r.dir)
	for i, en := range es {
		if en.V != int64(i+1) {
			t.Fatalf("journal line %d has version %d", i+1, en.V)
		}
	}
	if got, _, err := loadRecord(r.dir); err != nil || len(es) != total+1 || dump(t, got) != dump(t, r.L) {
		t.Errorf("a restart reads something else than memory (%v)", err)
	}
	if v := r.viewNow(); v.Counts.Slot != total {
		t.Errorf("the view counts %d tasks waiting for a slot, want %d", v.Counts.Slot, total)
	}
}
