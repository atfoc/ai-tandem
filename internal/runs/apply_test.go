package runs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

func f64(v float64) *float64 { return &v }

// played is a small run made through commit, entry by entry, with the state after each.
type played struct {
	e     *testEnv
	r     *run
	dumps []string // dumps[i] is the state after entry i+1
}

// step commits one entry and keeps the state after it.
func (p *played) step(kind EntryKind, build func(tx *Tx) error) {
	p.e.t.Helper()
	p.e.clock.Advance(1500 * time.Millisecond)
	p.e.must(p.r, kind, build)
	p.r.mu.Lock()
	p.dumps = append(p.dumps, dump(p.e.t, p.r.L))
	p.r.mu.Unlock()
}

// playRun makes a run that goes through every kind of record: turns with ops, tasks that are
// held, wait on dependencies, start, finish, fail and block, a retry, a chat's change, notes,
// agents with launches and cost, a halt with a stop, a resume, and the end.
func playRun(e *testEnv, id string) *played {
	e.t.Helper()
	r := e.started(id)
	p := &played{e: e, r: r}
	r.mu.Lock()
	p.dumps = append(p.dumps, dump(e.t, r.L))
	r.mu.Unlock()
	orch1, work1, work2, work2b := AgentChatID(id, TurnAgentName(1)), AgentChatID(id, WorkAgentName("T01", 1)),
		AgentChatID(id, WorkAgentName("T02", 1)), AgentChatID(id, WorkAgentName("T02", 2))
	yes := true

	p.step(KTurnStarted, func(tx *Tx) error {
		tx.Head(Entry{Turn: 1})
		tx.AddTurn(Turn{N: 1, Agent: orch1, Reason: "start", Status: "running", StartedAt: tx.Now()})
		tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: orch1, Name: TurnAgentName(1), Role: model.RoleOrchestrator, Turn: 1,
			Status: model.AgentRunning, StartedAt: tx.Now(), Launches: []model.RunLaunch{{N: 1, StartedAt: tx.Now()}}}, Resumable: true})
		return nil
	})
	p.step(KOp, func(tx *Tx) error {
		tx.Head(Entry{Turn: 1, Op: "set_notes", Chat: orch1})
		t := tx.Turn(1)
		t.Ops = append(t.Ops, model.RunOp{I: len(t.Ops), T: tx.Now(), Op: "set_notes", NotesVersion: 1, Size: 12})
		tx.AddNotes(model.NotesVersion{V: 1, At: tx.Now(), Turn: 1, Size: 12})
		tx.File(notesRel(1), []byte("# Notes\n\none"))
		return nil
	})
	addTask := func(tid, title string, deps []string) func(tx *Tx) error {
		return func(tx *Tx) error {
			tx.Head(Entry{Turn: 1, Op: "add_task", Task: tid, Chat: orch1})
			t := tx.Turn(1)
			t.Ops = append(t.Ops, model.RunOp{I: len(t.Ops), T: tx.Now(), Op: "add_task", Task: tid, Title: title, Kind: "implement",
				Writes: &yes, DependsOn: deps, BriefRev: 1})
			tx.AddTask(Task{ID: tid, Title: title, Kind: "implement", Writes: true, DependsOn: deps, AddedTurn: 1, CreatedAt: tx.Now(),
				BriefRev: 1, Briefs: []model.BriefRev{{Rev: 1, At: tx.Now(), Turn: 1, Size: 40}}, HeldBy: []Holder{{Turn: 1}},
				Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, QueuedTurn: 1, QueuedAt: tx.Now()}}}})
			tx.File(briefRel(tid, 1), []byte("Do "+title+". It has to be forty characters."))
			return nil
		}
	}
	p.step(KOp, addTask("T01", "the first", nil))
	p.step(KOp, addTask("T02", "the second", []string{"T01"}))
	p.step(KOp, addTask("T03", "the third", []string{"T02"}))
	p.step(KOp, func(tx *Tx) error { // a refused call is recorded too
		tx.Head(Entry{Turn: 1, Op: "finish_run", Chat: orch1, Error: "tasks are pending"})
		t := tx.Turn(1)
		t.Ops = append(t.Ops, model.RunOp{I: len(t.Ops), T: tx.Now(), Op: "finish_run", Error: "tasks are pending"})
		return nil
	})
	p.step(KTurnEnded, func(tx *Tx) error {
		tx.Head(Entry{Turn: 1})
		t := tx.Turn(1)
		t.Status, t.EndedAt, t.Summary, t.Cost = "done", tx.Now(), "Three tasks added.", f64(0.25)
		a := tx.Agent(orch1)
		a.Status, a.EndedAt, a.Cost = model.AgentDone, tx.Now(), f64(0.25)
		a.Launches[0].EndedAt = tx.Now()
		for _, tid := range []string{"T01", "T02", "T03"} {
			tx.Task(tid).HeldBy = nil
		}
		return nil
	})
	p.step(KTaskStarted, func(tx *Tx) error {
		tx.Head(Entry{Task: "T01", Attempt: 1})
		a := &tx.Task("T01").Attempts[0]
		a.StartedAt, a.Base, a.Branch, a.Worktree = tx.Now(), "aaaa", "aiwb/"+id+"/T01", "/work/T01"
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskSetup, T: tx.Now()})
		tx.State().IdleStreak = 0
		return nil
	})
	p.step(KTaskStep, func(tx *Tx) error {
		tx.Head(Entry{Task: "T01", Attempt: 1})
		a := &tx.Task("T01").Attempts[0]
		a.SetupDone, a.Agents.Work = true, work1
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskWork, T: tx.Now()})
		tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: work1, Name: WorkAgentName("T01", 1), Role: model.RoleTask, Task: "T01", Attempt: 1,
			Status: model.AgentRunning, StartedAt: tx.Now()}})
		return nil
	})
	p.step(KAgent, func(tx *Tx) error {
		tx.Head(Entry{Chat: work1})
		a := tx.Agent(work1)
		a.Launches = append(a.Launches, model.RunLaunch{N: 1, StartedAt: tx.Now()})
		a.Resumable = true
		return nil
	})
	p.step(KOp, func(tx *Tx) error { // a chat on the run adds a task outside a turn
		tx.Head(Entry{Op: "add_task", Task: "T04", Chat: "chat-1"})
		tx.AddChatOp(model.RunOp{Op: "add_task", Chat: "chat-1", Turn: 1, Task: "T04", Title: "the fourth", Kind: "review", DependsOn: []string{"T03"}})
		tx.AddTask(Task{ID: "T04", Title: "the fourth", Kind: "review", DependsOn: []string{"T03"}, AddedTurn: 1, AddedBy: "chat-1",
			CreatedAt: tx.Now(), BriefRev: 1, Briefs: []model.BriefRev{{Rev: 1, At: tx.Now(), Chat: "chat-1", Size: 40}},
			HeldBy:   []Holder{{Chat: "chat-1"}},
			Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, QueuedTurn: 1, QueuedBy: "chat-1", QueuedAt: tx.Now()}}}})
		tx.File(briefRel("T04", 1), []byte("Review the third. It has to be forty characters."))
		tx.Event(model.RunEvent{Type: "chat_op", Chat: "chat-1", Text: "A chat on the run added T04 [review, reports only]: the fourth."})
		return nil
	})
	p.step(KTaskWait, func(tx *Tx) error { tx.Task("T04").HeldBy = nil; return nil }) // the chat's reply ended
	p.step(KTaskStep, func(tx *Tx) error {
		tx.Head(Entry{Task: "T01", Attempt: 1})
		a := &tx.Task("T01").Attempts[0]
		a.WorkDone, a.Result = true, &model.AttemptResult{Outcome: "completed", Summary: "Built the first.", ReportSize: 9}
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskMerge, T: tx.Now()})
		tx.File(reportRel("T01", 1), []byte("# Report\n"))
		return nil
	})
	p.step(KTaskStep, func(tx *Tx) error {
		tx.Head(Entry{Task: "T01", Attempt: 1})
		a := &tx.Task("T01").Attempts[0]
		a.Head, a.Conflicts, a.MergeRound = "bbbb", []string{"a.go"}, 1
		tx.File(changesRel("T01", 1), changesData(model.AttemptChanges{Task: "T01", Attempt: 1, Head: "bbbb"}))
		return nil
	})
	p.step(KTaskEnded, func(tx *Tx) error { // the end, the event and the release of T02 are one entry
		tx.Head(Entry{Task: "T01", Attempt: 1})
		a := &tx.Task("T01").Attempts[0]
		a.MergeAgentDone, a.Merged, a.MergedAt, a.Outcome, a.EndedAt, a.Cost, a.Worktree = 1, "cccc", tx.Now(), model.TaskDone, tx.Now(), f64(1.5), ""
		ag := tx.Agent(work1)
		ag.Status, ag.EndedAt, ag.Cost = model.AgentDone, tx.Now(), f64(1.5)
		ag.Launches[0].EndedAt = tx.Now()
		tx.Event(model.RunEvent{Type: "task_done", Task: "T01", Text: "Built the first."})
		return nil
	})
	p.step(KTaskStarted, func(tx *Tx) error {
		tx.Head(Entry{Task: "T02", Attempt: 1})
		a := &tx.Task("T02").Attempts[0]
		a.StartedAt, a.Base = tx.Now(), "cccc"
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskSetup, T: tx.Now()}, model.RunPhase{K: model.TaskWork, T: tx.Now()})
		a.Agents.Work = work2
		tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: work2, Name: WorkAgentName("T02", 1), Role: model.RoleTask, Task: "T02", Attempt: 1,
			Status: model.AgentRunning, StartedAt: tx.Now(), Launches: []model.RunLaunch{{N: 1, StartedAt: tx.Now()}}}})
		return nil
	})
	p.step(KAgent, func(tx *Tx) error { // a counted failure with its backoff
		tx.Head(Entry{Chat: work2})
		a := tx.Agent(work2)
		a.Launches[0].EndedAt, a.Launches[0].Error = tx.Now(), "timed out after 3h0m0s"
		a.Failures, a.RetryAt, a.CostLost = 1, tx.Now()+30_000, true
		return nil
	})
	p.step(KTaskEnded, func(tx *Tx) error { // a failure blocks T03 (and T04 behind it stays on deps)
		tx.Head(Entry{Task: "T02", Attempt: 1})
		a := &tx.Task("T02").Attempts[0]
		a.Outcome, a.EndedAt, a.Error = model.TaskFailed, tx.Now(), "agent T02-work failed: timed out"
		ag := tx.Agent(work2)
		ag.Status, ag.EndedAt, ag.Error = model.AgentFailed, tx.Now(), "timed out"
		tx.Event(model.RunEvent{Type: "task_failed", Task: "T02", Text: "agent T02-work failed: timed out"})
		return nil
	})
	p.step(KRunStopping, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.Halting = model.RunStopping, &Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}
		return nil
	})
	p.step(KRunHalted, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.Reason, st.Halting = model.RunStopped, st.Halting.Reason, nil
		st.ActiveMs, st.AsOf = st.ActiveMs+tx.Now()-st.AsOf, tx.Now()
		tx.SetStops(append(tx.L().Stops, model.RunStop{At: tx.Now(), Reason: model.StopUser}))
		return nil
	})
	p.step(KRunResumed, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.Reason, st.AsOf = model.RunRunning, "", tx.Now()
		stops := append([]model.RunStop(nil), tx.L().Stops...)
		stops[len(stops)-1].ResumedAt = tx.Now()
		tx.SetStops(stops)
		return nil
	})
	p.step(KTurnStarted, func(tx *Tx) error {
		tx.Head(Entry{Turn: 2})
		st := tx.State()
		woken := st.Inbox
		st.Inbox = nil
		tx.AddTurn(Turn{N: 2, Agent: AgentChatID(id, TurnAgentName(2)), Reason: "events", Status: "running", StartedAt: tx.Now(), WokenBy: woken})
		return nil
	})
	p.step(KOp, func(tx *Tx) error { // retry: a second attempt, held by the turn
		tx.Head(Entry{Turn: 2, Op: "retry_task", Task: "T02"})
		t := tx.Turn(2)
		t.Ops = append(t.Ops, model.RunOp{I: len(t.Ops), T: tx.Now(), Op: "retry_task", Task: "T02", Reason: "more time", Attempt: 2})
		tk := tx.Task("T02")
		tk.Attempts = append(tk.Attempts, Attempt{RunAttempt: model.RunAttempt{N: 2, QueuedTurn: 2, QueuedAt: tx.Now()}})
		tk.HeldBy = []Holder{{Turn: 2}}
		return nil
	})
	p.step(KOp, func(tx *Tx) error { // cancel a waiting task: its attempt is closed in the op's entry
		tx.Head(Entry{Turn: 2, Op: "cancel_task", Task: "T04"})
		t := tx.Turn(2)
		t.Ops = append(t.Ops, model.RunOp{I: len(t.Ops), T: tx.Now(), Op: "cancel_task", Task: "T04", Reason: "not needed"})
		a := &tx.Task("T04").Attempts[0]
		a.Outcome, a.EndedAt, a.Cancel = model.TaskCancelled, tx.Now(), &model.AttemptCancel{T: tx.Now(), Reason: "not needed", Turn: 2}
		return nil
	})
	p.step(KTurnEnded, func(tx *Tx) error {
		tx.Head(Entry{Turn: 2})
		t := tx.Turn(2)
		t.Status, t.EndedAt = "done", tx.Now()
		tx.Task("T02").HeldBy = nil
		return nil
	})
	p.step(KTaskStarted, func(tx *Tx) error {
		tx.Head(Entry{Task: "T02", Attempt: 2})
		a := &tx.Task("T02").Attempts[1]
		a.StartedAt, a.Base, a.Agents.Work = tx.Now(), "cccc", work2b
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskSetup, T: tx.Now()})
		return nil
	})
	p.step(KTaskEnded, func(tx *Tx) error {
		tx.Head(Entry{Task: "T02", Attempt: 2})
		a := &tx.Task("T02").Attempts[1]
		a.Outcome, a.EndedAt = model.TaskDone, tx.Now()
		tx.Event(model.RunEvent{Type: "task_done", Task: "T02", Text: "Done the second time."})
		return nil
	})
	p.step(KLearned, func(tx *Tx) error {
		st := tx.State()
		t := tx.Turn(2)
		t.Learned, st.Inbox = append(t.Learned, st.Inbox...), nil
		return nil
	})
	p.step(KRunFinished, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.EndedAt = model.RunGaveUp, tx.Now()
		st.Result = &model.RunResult{Outcome: model.NotAchieved, Summary: "T03 never ran.", Turn: 2, At: tx.Now()}
		st.Git = &Git{RunGit: model.RunGit{BaseRef: "aaaa", IntegrationBranch: "aiwb/" + id + "/integration", ResultHead: "cccc", DirtyAtStart: true}, Repo: "/repo", Sub: "web"}
		return nil
	})
	return p
}

// Replaying the recorded entries gives the state the live path had, after every entry.
func TestApplyReplayEqualsLive(t *testing.T) {
	e := newTestEnv(t)
	p := playRun(e, "r_replay")
	entries := readEntries(t, p.r.dir)
	if len(entries) != len(p.dumps) {
		t.Fatalf("%d entries in the journal, %d commits", len(entries), len(p.dumps))
	}
	l := &Loaded{}
	for i, en := range entries {
		if en.V != int64(i+1) {
			t.Fatalf("entry %d has version %d", i+1, en.V)
		}
		l.Apply(en.V, en.Patch)
		if got := dump(t, l); got != p.dumps[i] {
			t.Fatalf("after entry %d (%s) the replayed state differs from the live one:\nreplayed %s\nlive %s", en.V, en.Kind, got, p.dumps[i])
		}
	}
	final := p.dumps[len(p.dumps)-1]
	if !strings.Contains(final, `"T04"`) || !strings.Contains(final, `"gave_up"`) || l.Version != int64(len(entries)) {
		t.Fatalf("the scenario did not end where it should: version %d", l.Version)
	}
	// What a restart reads is the same state.
	got, info, err := loadRecord(p.r.dir)
	if err != nil {
		t.Fatal(err)
	}
	if dump(t, got) != final || info.Torn || info.Size != journalSize(p.r.dir) {
		t.Errorf("loadRecord: torn %v, size %d of %d, state equal %v", info.Torn, info.Size, journalSize(p.r.dir), dump(t, got) == final)
	}
}

// Applying an entry twice changes nothing, and applying older entries again before the newer
// ones ends at the same state: what the checkpoint relies on.
func TestApplyIdempotent(t *testing.T) {
	e := newTestEnv(t)
	p := playRun(e, "r_idem")
	entries := readEntries(t, p.r.dir)
	final := p.dumps[len(p.dumps)-1]

	l := &Loaded{}
	for i, en := range entries {
		l.Apply(en.V, en.Patch)
		l.Apply(en.V, en.Patch)
		if got := dump(t, l); got != p.dumps[i] {
			t.Fatalf("entry %d (%s) applied twice differs from applied once", en.V, en.Kind)
		}
	}
	// The final state with the entries from an earlier point applied over it again, as a load
	// does when the collection files are newer than state.json.
	for _, from := range []int{0, 1, len(entries) / 3, len(entries) / 2, len(entries) - 1} {
		over, _, err := loadRecord(p.r.dir)
		if err != nil {
			t.Fatal(err)
		}
		for _, en := range entries[from:] {
			over.Apply(en.V, en.Patch)
		}
		if dump(t, over) != final {
			t.Errorf("replaying from entry %d over the final state ends somewhere else", from+1)
		}
	}
}

// A crash can cut the journal anywhere: whatever is left loads as the state of the last whole
// entry, the torn line is gone from the file, and the run goes on from there.
func TestJournalCutAnywhere(t *testing.T) {
	e := newTestEnv(t)
	p := playRun(e, "r_cut")
	journal, err := os.ReadFile(filepath.Join(p.r.dir, fileJournal))
	if err != nil {
		t.Fatal(err)
	}
	var ends []int // the byte after each entry
	for i, b := range journal {
		if b == '\n' {
			ends = append(ends, i+1)
		}
	}
	if len(ends) != len(p.dumps) {
		t.Fatalf("%d lines, %d entries", len(ends), len(p.dumps))
	}
	dir := copyDir(t, p.r.dir)
	for _, name := range []string{fileState, fileTasks, fileTurns, fileAgents} {
		os.Remove(filepath.Join(dir, name)) // no checkpoint: everything comes from the journal
	}
	path := filepath.Join(dir, fileJournal)
	// Every place around the end of a line, and every eleventh byte in between.
	cuts := map[int]bool{0: true, len(journal): true}
	for _, end := range ends {
		cuts[end-1], cuts[end], cuts[min(end+1, len(journal))] = true, true, true
	}
	for cut := 0; cut <= len(journal); cut += 11 {
		cuts[cut] = true
	}
	for cut := 0; cut <= len(journal); cut++ {
		if !cuts[cut] {
			continue
		}
		if err := os.WriteFile(path, journal[:cut], 0o600); err != nil {
			t.Fatal(err)
		}
		whole := 0 // entries that are whole at this cut
		for whole < len(ends) && ends[whole] <= cut {
			whole++
		}
		l, info, err := loadRecord(dir)
		if err != nil {
			t.Fatalf("cut at %d: %v", cut, err)
		}
		want, wantSize := dump(t, &Loaded{}), 0
		if whole > 0 {
			want, wantSize = p.dumps[whole-1], ends[whole-1]
		}
		if got := dump(t, l); got != want {
			t.Fatalf("cut at byte %d (%d whole entries): the state is not the one after entry %d", cut, whole, whole)
		}
		if l.Version != int64(whole) || info.Replayed != whole || info.Size != int64(wantSize) || info.Torn != (cut != wantSize) {
			t.Fatalf("cut at %d: version %d, replayed %d, size %d, torn %v; want %d entries ending at %d", cut, l.Version, info.Replayed, info.Size, info.Torn, whole, wantSize)
		}
		if size := journalSize(dir); size != int64(wantSize) {
			t.Fatalf("cut at %d: the torn line was not cut off: the file has %d bytes, want %d", cut, size, wantSize)
		}
	}
}

// A line that is not an entry and is not the last one is damage, not a crash: an error.
func TestJournalDamageInTheMiddle(t *testing.T) {
	e := newTestEnv(t)
	p := playRun(e, "r_damage")
	path := filepath.Join(p.r.dir, fileJournal)
	journal, _ := os.ReadFile(path)
	first := strings.IndexByte(string(journal), '\n') + 1
	bad := append(append(append([]byte(nil), journal[:first]...), []byte("{\"v\":2,\"t\":\n")...), journal[first:]...)
	if err := os.WriteFile(path, bad, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadRecord(p.r.dir); err == nil || !strings.Contains(err.Error(), "not an entry") {
		t.Errorf("a damaged line in the middle: %v", err)
	}
	// The same line as the last one is a torn write.
	if err := os.WriteFile(path, append(append([]byte(nil), journal...), []byte("{\"v\":2,\"t\":\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	l, info, err := loadRecord(p.r.dir)
	if err != nil || !info.Torn || dump(t, l) != p.dumps[len(p.dumps)-1] || journalSize(p.r.dir) != int64(len(journal)) {
		t.Errorf("a bad last line: torn %v, err %v", info.Torn, err)
	}
}

// A checkpoint is several writes. Cut between any two of them, the run loads as the state of the
// last whole entry: collection files that are newer than state.json do no harm.
func TestCheckpointCutBetweenWrites(t *testing.T) {
	e := newTestEnv(t)
	p := playRun(e, "r_cp")
	entries := readEntries(t, p.r.dir)
	final := p.dumps[len(p.dumps)-1]
	journal, _ := os.ReadFile(filepath.Join(p.r.dir, fileJournal))

	// The folder as it was at an earlier checkpoint (after entry k) with the whole journal: the
	// state just before the last checkpoint begins.
	for _, k := range []int{1, 8, 15, len(entries) - 1} {
		old := &Loaded{}
		offset := 0
		for _, en := range entries[:k] {
			old.Apply(en.V, en.Patch)
		}
		for n, i := 0, 0; n < k; i++ {
			if journal[i] == '\n' {
				n++
				offset = i + 1
			}
		}
		before := copyDir(t, p.r.dir)
		if err := writeCheckpoint(before, old, old.Summarize(false), int64(offset), true, true, true); err != nil {
			t.Fatal(err)
		}
		// The new checkpoint, whole, in a folder of its own: the files to copy over one by one.
		after := copyDir(t, before)
		last := &Loaded{}
		for _, en := range entries {
			last.Apply(en.V, en.Patch)
		}
		if err := writeCheckpoint(after, last, last.Summarize(false), int64(len(journal)), true, true, true); err != nil {
			t.Fatal(err)
		}
		// The order a checkpoint writes in: tasks, turns, agents, state.
		order := []string{fileTasks, fileTurns, fileAgents, fileState}
		for done := 0; done <= len(order); done++ {
			dir := copyDir(t, before)
			for _, name := range order[:done] {
				b, err := os.ReadFile(filepath.Join(after, name))
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, name), b, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if done < len(order) {
				// The write that was under way left half a temp file.
				b, _ := os.ReadFile(filepath.Join(after, order[done]))
				os.WriteFile(filepath.Join(dir, "."+order[done]+".tmp"), b[:len(b)/2], 0o600)
			}
			l, info, err := loadRecord(dir)
			if err != nil {
				t.Fatalf("checkpoint after entry %d, cut after %d writes: %v", k, done, err)
			}
			if got := dump(t, l); got != final {
				t.Errorf("checkpoint after entry %d, cut after %d writes: the state is not the last entry's", k, done)
			}
			wantReplay := len(entries) - k
			if done == len(order) {
				wantReplay = 0
			}
			if info.Replayed != wantReplay || info.Leftovers != (done > 0 && done < len(order)) {
				t.Errorf("checkpoint after entry %d, cut after %d writes: replayed %d (want %d), leftovers %v", k, done, info.Replayed, wantReplay, info.Leftovers)
			}
		}
	}
}

// A journal that ends before its checkpoint's offset (its tail did not reach the disk): the
// checkpoint is the state, a new checkpoint says where the journal ends now, and the run goes on.
func TestJournalShorterThanCheckpoint(t *testing.T) {
	e := newTestEnv(t)
	p := playRun(e, "r_short")
	final := p.dumps[len(p.dumps)-1]
	if err := p.r.checkpoint(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(p.r.dir, fileJournal)
	journal, _ := os.ReadFile(path)
	if err := os.WriteFile(path, journal[:len(journal)/2], 0o600); err != nil { // mid-line
		t.Fatal(err)
	}
	r := e.reopen("r_short")
	if err := r.load(); err != nil {
		t.Fatal(err)
	}
	if got := dump(t, r.L); got != final {
		t.Fatal("the state is not the checkpoint's")
	}
	sf, _, _ := readHead(r.dir)
	if sf.JournalOffset != int64(len(journal)/2) || sf.Version != r.L.Version {
		t.Fatalf("the checkpoint after the load: offset %d (journal %d), version %d", sf.JournalOffset, len(journal)/2, sf.Version)
	}
	v := e.must(r, KTaskWait, func(tx *Tx) error { tx.State().IdleStreak = 2; return nil })
	want := dump(t, r.L)
	r2 := e.reopen("r_short")
	if err := r2.load(); err != nil {
		t.Fatal(err)
	}
	if r2.L.Version != v || dump(t, r2.L) != want {
		t.Errorf("after an entry on top and a restart: version %d, want %d", r2.L.Version, v)
	}
}
