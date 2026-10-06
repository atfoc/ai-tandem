package runs

import (
	"reflect"
	"testing"

	"ai-whiteboard/internal/model"
)

// taskIn makes a task whose last attempt is in the given state.
func taskIn(id string, s model.TaskState, deps ...string) Task {
	a := Attempt{RunAttempt: model.RunAttempt{N: 1}}
	if s.Final() {
		a.Outcome = s
		a.Phases = []model.RunPhase{{K: model.TaskSlot, T: 1}}
	} else {
		a.Phases = []model.RunPhase{{K: s, T: 1}}
	}
	return Task{ID: id, DependsOn: deps, Attempts: []Attempt{a}}
}

// Rule A2 against hand-made states.
func TestWaitingPhaseRule(t *testing.T) {
	others := map[string]Task{
		"D1": taskIn("D1", model.TaskDone), "D2": taskIn("D2", model.TaskDone),
		"F1": taskIn("F1", model.TaskFailed), "C1": taskIn("C1", model.TaskCancelled),
		"W1": taskIn("W1", model.TaskWork), "S1": taskIn("S1", model.TaskSlot), "M1": taskIn("M1", model.TaskMerge),
		"H1": taskIn("H1", model.TaskHeld), "B1": taskIn("B1", model.TaskBlocked),
	}
	// A failed task that was retried is not failed any more: its new attempt waits.
	retried := taskIn("R1", model.TaskFailed)
	retried.Attempts = append(retried.Attempts, Attempt{RunAttempt: model.RunAttempt{N: 2}})
	others["R1"] = retried
	state := func(id string) (model.TaskState, bool) {
		tk, ok := others[id]
		if !ok {
			return "", false
		}
		return tk.State(), true
	}
	for _, c := range []struct {
		name string
		task Task
		want model.RunPhase
	}{
		{"free, no dependencies", Task{}, model.RunPhase{K: model.TaskSlot}},
		{"free, every dependency done", Task{DependsOn: []string{"D1", "D2"}}, model.RunPhase{K: model.TaskSlot}},
		{"held by a turn", Task{HeldBy: []Holder{{Turn: 4}}}, model.RunPhase{K: model.TaskHeld, Turn: 4}},
		{"held by a chat", Task{HeldBy: []Holder{{Chat: "c9"}}}, model.RunPhase{K: model.TaskHeld, Chat: "c9"}},
		{"held by a turn and a chat: the first holder", Task{HeldBy: []Holder{{Turn: 2}, {Chat: "c9"}}}, model.RunPhase{K: model.TaskHeld, Turn: 2}},
		{"held comes before a failed dependency", Task{HeldBy: []Holder{{Turn: 4}}, DependsOn: []string{"F1"}}, model.RunPhase{K: model.TaskHeld, Turn: 4}},
		{"held comes before open dependencies", Task{HeldBy: []Holder{{Chat: "c9"}}, DependsOn: []string{"W1"}}, model.RunPhase{K: model.TaskHeld, Chat: "c9"}},
		{"a failed dependency", Task{DependsOn: []string{"D1", "F1"}}, model.RunPhase{K: model.TaskBlocked, On: []string{"F1"}}},
		{"a cancelled dependency", Task{DependsOn: []string{"C1"}}, model.RunPhase{K: model.TaskBlocked, On: []string{"C1"}}},
		{"failed and cancelled, with one not done: blocked on the two", Task{DependsOn: []string{"W1", "F1", "D1", "C1"}}, model.RunPhase{K: model.TaskBlocked, On: []string{"F1", "C1"}}},
		{"dependencies not done", Task{DependsOn: []string{"D1", "W1", "S1", "M1", "H1", "B1"}}, model.RunPhase{K: model.TaskDeps, On: []string{"W1", "S1", "M1", "H1", "B1"}}},
		{"a retried dependency is not done, and not failed", Task{DependsOn: []string{"R1"}}, model.RunPhase{K: model.TaskDeps, On: []string{"R1"}}},
		{"a dependency that does not exist is not done", Task{DependsOn: []string{"T99"}}, model.RunPhase{K: model.TaskDeps, On: []string{"T99"}}},
	} {
		if got := waitingPhase(c.task, state); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
	if !samePhase(model.RunPhase{K: model.TaskDeps, On: []string{"a"}, T: 1}, model.RunPhase{K: model.TaskDeps, On: []string{"a"}, T: 9}) ||
		samePhase(model.RunPhase{K: model.TaskDeps, On: []string{"a"}}, model.RunPhase{K: model.TaskDeps, On: []string{"a", "b"}}) ||
		samePhase(model.RunPhase{K: model.TaskHeld, Turn: 1}, model.RunPhase{K: model.TaskHeld, Chat: "c"}) ||
		samePhase(model.RunPhase{K: model.TaskSlot}, model.RunPhase{K: model.TaskDeps}) {
		t.Error("samePhase")
	}
}

func phasesOf(r *run, id string) []model.RunPhase {
	for _, tk := range r.L.Tasks {
		if tk.ID == id {
			return tk.Attempts[len(tk.Attempts)-1].Phases
		}
	}
	return nil
}

func kinds(ps []model.RunPhase) string {
	s := ""
	for _, p := range ps {
		s += string(p.K) + " "
	}
	return s
}

// commit applies the rule after every build, to every waiting task, and puts the tasks whose
// phase changed into the same entry.
func TestCommitAppliesWaitingRule(t *testing.T) {
	e := newTestEnv(t)
	r := e.started("r_a2")
	held := func(id string, turn int, deps ...string) func(tx *Tx) error {
		return func(tx *Tx) error {
			tx.AddTask(Task{ID: id, DependsOn: deps, CreatedAt: tx.Now(), HeldBy: []Holder{{Turn: turn}},
				Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, QueuedAt: tx.Now()}}}})
			return nil
		}
	}
	e.must(r, KOp, held("T01", 1))
	e.must(r, KOp, held("T02", 1, "T01"))
	e.must(r, KOp, held("T03", 1, "T02"))
	for _, id := range []string{"T01", "T02", "T03"} {
		if ps := phasesOf(r, id); len(ps) != 1 || ps[0].K != model.TaskHeld || ps[0].Turn != 1 || ps[0].T == 0 {
			t.Fatalf("%s after it was added: %+v", id, ps)
		}
	}
	// The turn ends: one entry releases all three, each to what it waits for now.
	v := e.must(r, KTurnEnded, func(tx *Tx) error {
		for _, id := range []string{"T01", "T02", "T03"} {
			tx.Task(id).HeldBy = nil
		}
		return nil
	})
	if got := kinds(phasesOf(r, "T01")) + "| " + kinds(phasesOf(r, "T02")) + "| " + kinds(phasesOf(r, "T03")); got != "held slot | held deps | held deps " {
		t.Fatalf("after the turn: %s", got)
	}
	if ps := phasesOf(r, "T02"); !reflect.DeepEqual(ps[1].On, []string{"T01"}) || ps[1].T != e.clock.Now().UnixMilli() {
		t.Errorf("T02's deps phase: %+v", ps[1])
	}
	// An entry that changes nothing about them adds no phase and does not carry them.
	e.must(r, KTaskWait, func(tx *Tx) error { tx.State().IdleStreak = 1; return nil })
	es := readEntries(t, r.dir)
	if last := es[len(es)-1]; len(last.Patch.Tasks) != 0 {
		t.Errorf("an entry about nothing carries %d tasks", len(last.Patch.Tasks))
	}
	if en := es[v-1]; len(en.Patch.Tasks) != 3 {
		t.Errorf("the turn's end carries %d tasks, want 3", len(en.Patch.Tasks))
	}
	// T01 starts (the engine's phase, not the rule's): the others stay as they are.
	e.must(r, KTaskStarted, func(tx *Tx) error {
		a := &tx.Task("T01").Attempts[0]
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskSetup, T: tx.Now()}, model.RunPhase{K: model.TaskWork, T: tx.Now()})
		return nil
	})
	if got := kinds(phasesOf(r, "T01")) + "| " + kinds(phasesOf(r, "T02")); got != "held slot setup work | held deps " {
		t.Fatalf("after T01 started: %s", got)
	}
	// T01 is done: its end and the release of T02 are one entry; T03 still waits on T02.
	v = e.must(r, KTaskEnded, func(tx *Tx) error {
		a := &tx.Task("T01").Attempts[0]
		a.Outcome, a.EndedAt = model.TaskDone, tx.Now()
		tx.Event(model.RunEvent{Type: "task_done", Task: "T01", Text: "ok"})
		return nil
	})
	en := readEntries(t, r.dir)[v-1]
	if len(en.Patch.Tasks) != 2 || en.Patch.Tasks[0].ID != "T01" || en.Patch.Tasks[1].ID != "T02" || en.Patch.State == nil || len(en.Patch.State.Inbox) != 1 {
		t.Fatalf("T01's end is not one entry with its event and the release of T02: %+v", en.Patch)
	}
	if got := kinds(phasesOf(r, "T01")) + "| " + kinds(phasesOf(r, "T02")) + "| " + kinds(phasesOf(r, "T03")); got != "held slot setup work | held deps slot | held deps " {
		t.Fatalf("after T01 was done: %s", got)
	}
	// T02 fails: T03 is blocked on it. A done task and a failed one get no phase.
	e.must(r, KTaskEnded, func(tx *Tx) error {
		a := &tx.Task("T02").Attempts[0]
		a.Outcome, a.Error = model.TaskFailed, "boom"
		return nil
	})
	if ps := phasesOf(r, "T03"); kinds(ps) != "held deps blocked " || !reflect.DeepEqual(ps[2].On, []string{"T02"}) {
		t.Fatalf("T03 after T02 failed: %+v", ps)
	}
	if got := kinds(phasesOf(r, "T01")) + "| " + kinds(phasesOf(r, "T02")); got != "held slot setup work | held deps slot " {
		t.Errorf("ended tasks got a phase: %s", got)
	}
	// A retry of T02 held by a chat: T03 goes back to deps; the hold ends: T02 gets a slot.
	e.must(r, KOp, func(tx *Tx) error {
		tk := tx.Task("T02")
		tk.Attempts = append(tk.Attempts, Attempt{RunAttempt: model.RunAttempt{N: 2, QueuedBy: "c1"}})
		tk.HeldBy = []Holder{{Chat: "c1"}}
		return nil
	})
	if ps := phasesOf(r, "T02"); len(ps) != 1 || ps[0].K != model.TaskHeld || ps[0].Chat != "c1" || ps[0].Turn != 0 {
		t.Fatalf("T02's second attempt: %+v", ps)
	}
	if got := kinds(phasesOf(r, "T03")); got != "held deps blocked deps " {
		t.Fatalf("T03 after the retry: %s", got)
	}
	e.must(r, KTaskWait, func(tx *Tx) error { tx.Task("T02").HeldBy = nil; return nil })
	if got := kinds(phasesOf(r, "T02")); got != "held slot " {
		t.Fatalf("T02 after the chat's hold ended: %s", got)
	}
	// T02 is cancelled: T03 is blocked again, on the cancelled one.
	e.must(r, KOp, func(tx *Tx) error {
		a := &tx.Task("T02").Attempts[1]
		a.Outcome, a.Cancel = model.TaskCancelled, &model.AttemptCancel{T: tx.Now(), Reason: "no"}
		return nil
	})
	if got := kinds(phasesOf(r, "T03")); got != "held deps blocked deps blocked " {
		t.Fatalf("T03 after the cancel: %s", got)
	}
	// What a restart reads has the same phases.
	if got, _, err := loadRecord(r.dir); err != nil || dump(t, got) != dump(t, r.L) {
		t.Errorf("the phases in the journal differ from memory (%v)", err)
	}
	if r.sum.Counts != (model.RunCounts{Done: 1, Cancelled: 1, Blocked: 1}) || r.sum.Attention != 1 {
		t.Errorf("the summary after all that: %+v", r.sum)
	}
}
