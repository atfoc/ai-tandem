package runs

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/model"
)

// wait_for end to end: the tool is called by the orchestrator's agent while its turn runs, and
// the engine starts the next turn by what the call recorded.

// waitToolHost is the engine tests' host for a test that calls a tool from a turn's script: the
// script runs while the turn does, so the orchestrator's process is in a turn.
type waitToolHost struct{ ChatHost }

func (waitToolHost) TurnRunning(string) bool { return true }

// call calls a run tool as the orchestrator of turn n, and fails the test when it is refused.
func (e *engEnv) call(r *run, n int, name, args string) string {
	e.t.Helper()
	text, isErr := e.s.Call(boardapi.RunCaller{Run: r.id, Chat: AgentChatID(r.id, TurnAgentName(n)), Role: model.RoleOrchestrator}, name, json.RawMessage(args))
	if isErr {
		e.t.Errorf("%s %s in turn %d is refused: %s", name, args, n, text)
	}
	return text
}

// A turn calls wait_for on two tasks: no turn starts when the first of them ends, and one starts,
// for the reason `wait`, when the second has ended.
func TestWaitForToolHoldsTheNextTurn(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	e.s.Chats = waitToolHost{e.host}
	r := e.run("r_waittool", nil)
	e.gates.block("T01-work", "T02-work", "T03-work")
	e.play(r, func() {
		for _, title := range []string{"one", "two", "three"} {
			e.add(r, 1, title, false)
		}
		if got := e.call(r, 1, "wait_for", `{"tasks":["T01","T02","T01"]}`); got != "After this turn the next instance starts when all of T01, T02 ended, or earlier if a task fails, nothing is left running, or a chat on the run changes it." {
			t.Errorf("wait_for answers %q", got)
		}
	}, nil)
	r.startEngine()
	engTask(t, r, "T03", model.TaskWork)
	want := &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: "all", Turn: 1}
	if st := r.engState(); !reflect.DeepEqual(st.Wait, want) {
		t.Fatalf("the wait after turn 1: %+v", st.Wait)
	}
	if ops := r.engTurns()[0].Ops; len(ops) != 1 || ops[0].Op != "wait_for" || !reflect.DeepEqual(ops[0].Tasks, want.Tasks) || ops[0].Mode != "all" || ops[0].Error != "" {
		t.Fatalf("the ops of turn 1: %+v", ops)
	}

	e.gates.open("T01-work")
	engTask(t, r, "T01", model.TaskDone)
	time.Sleep(50 * time.Millisecond)
	if n := len(r.engTurns()); n != 1 {
		t.Fatalf("a turn started when the first of two finished (%d turns)", n)
	}

	e.gates.open("T02-work")
	engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) == 2 && ts[1].Status == "done" })
	if tn := r.engTurns()[1]; tn.Reason != "wait" || !tn.WaitMet || !reflect.DeepEqual(tn.Wait, want) || len(tn.WokenBy) != 2 {
		t.Errorf("turn 2: %+v", tn)
	}
	if st := r.engState(); st.Wait != nil {
		t.Errorf("the wait is still there: %+v", st.Wait)
	}
	r.stopEngine(10 * time.Second)
}

// Two wait_for calls in one turn: the last one holds. The first named T02 alone; the turn starts
// when T01 ends, which the second call asked for.
func TestWaitForToolLastCallWins(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	e.s.Chats = waitToolHost{e.host}
	r := e.run("r_waitlast", nil)
	e.gates.block("T01-work", "T02-work")
	e.play(r, func() {
		e.add(r, 1, "one", false)
		e.add(r, 1, "two", false)
		e.call(r, 1, "wait_for", `{"tasks":["T02"]}`)
		e.call(r, 1, "wait_for", `{"tasks":["T01"],"mode":"any"}`)
	}, nil)
	r.startEngine()
	engTask(t, r, "T02", model.TaskWork)
	want := &model.RunWait{Tasks: []string{"T01"}, Mode: "any", Turn: 1}
	if st := r.engState(); !reflect.DeepEqual(st.Wait, want) {
		t.Fatalf("the wait after turn 1: %+v", st.Wait)
	}
	e.gates.open("T01-work")
	engUntil(t, "turn 2", func() bool { ts := r.engTurns(); return len(ts) == 2 && ts[1].Status == "done" })
	if tn := r.engTurns()[1]; tn.Reason != "wait" || !tn.WaitMet || !reflect.DeepEqual(tn.Wait, want) || len(tn.WokenBy) != 1 || tn.WokenBy[0].Task != "T01" {
		t.Errorf("turn 2: %+v", tn)
	}
	if st := r.engTaskState("T02"); st != model.TaskWork {
		t.Errorf("T02 is %s", st)
	}
	r.stopEngine(10 * time.Second)
}
