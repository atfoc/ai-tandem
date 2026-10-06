package runs

import (
	"math"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// One equality over a run with a cost, while an agent still works: the run's total is the sum of
// what get_run says each task has cost (toolTaskCosts: every attempt's agents, a running one's
// live value) and the cost of the orchestrator's agents; and a turn that has ended cost what its
// agent did.
func TestUsageRunTotalIsItsTasksAndItsTurns(t *testing.T) {
	t.Parallel()
	e := newEngEnv(t, false)
	r := e.run("r_usage", nil)
	// T01 fails, is retried by turn 2 and is done, which starts turn 3; T02 works all the while.
	costs := map[string]float64{"turn-001": 0.10, "T01-work": 0.20, "turn-002": 0.05, "T01-a2-work": 0.25, "turn-003": 0.15}
	const live = 0.40
	e.gates.block("T02-work")
	e.play(r, func() {
		e.add(r, 1, "one", false)
		e.add(r, 1, "two", false)
	}, func(m *engMsg) bool {
		if c, ok := costs[m.Name]; ok {
			e.host.setCost(m.ID, c)
		}
		switch m.Name {
		case "T01-work":
			m.Block("failed", "Could not do one.", "why")
			return true
		case "turn-002":
			e.retry(r, 2, "T01")
		}
		return false
	})
	r.startEngine()
	engUntil(t, "turn 3", func() bool { ts := r.engTurns(); return len(ts) == 3 && ts[2].Status == "done" })
	engUntil(t, "the message of T02's agent", func() bool { return len(e.host.sent("T02-work")) == 1 })
	e.host.setCost(AgentChatID(r.id, "T02-work"), live)
	same := func(a, b float64) bool { return math.Abs(a-b) < 1e-9 }
	const total = 0.10 + 0.20 + 0.05 + 0.25 + 0.15 + live
	engUntil(t, "the live cost of T02's agent in the run's total", func() bool {
		e.clock.Advance(16 * time.Second) // the ticker reads the running agents' cost
		time.Sleep(5 * time.Millisecond)
		v := r.viewNow()
		return v.Cost != nil && same(*v.Cost, total)
	})
	if s := r.engTaskState("T02"); s != model.TaskWork || r.engSt() != model.RunRunning {
		t.Fatalf("T02 is %s and the run %s", s, r.engSt())
	}

	r.mu.Lock()
	l, lv := r.L.snapshot(), r.live()
	r.mu.Unlock()
	view := r.viewNow()
	if a, ok := r.engAgentNamed("T02-work"); !ok || a.Status != model.AgentRunning || a.Cost != nil || lv[a.ID].Cost == nil || *lv[a.ID].Cost != live {
		t.Fatalf("T02's agent is not the one whose cost is live: %+v, live %+v", a.RunAgent, lv[a.ID])
	}
	tasks := toolTaskCosts(l, lv)
	if len(tasks) != 2 || !same(tasks["T01"], 0.45) || !same(tasks["T02"], live) {
		t.Errorf("the tasks' costs: %v", tasks)
	}
	sum, orch := 0.0, 0.0
	for _, c := range tasks {
		sum += c
	}
	agents := map[string]Agent{}
	for _, a := range l.Agents {
		agents[a.ID] = a
		if a.Task == "" {
			if a.Role != model.RoleOrchestrator || a.Cost == nil {
				t.Errorf("an agent of no task: %+v", a.RunAgent)
				continue
			}
			orch += *a.Cost
		}
	}
	if view.Cost == nil || !same(*view.Cost, sum+orch) || !same(orch, 0.30) {
		t.Errorf("the run's total is %v; its tasks cost %v and its orchestrator %v", view.Cost, sum, orch)
	}
	for _, tn := range l.Turns {
		a := agents[tn.Agent]
		if tn.Status != "done" || tn.Cost == nil || a.Cost == nil || *tn.Cost != *a.Cost || *tn.Cost != costs[a.Name] {
			t.Errorf("turn %d (%s) cost %v, its agent %s %v", tn.N, tn.Status, tn.Cost, a.Name, a.Cost)
		}
	}
	r.stopEngine(10 * time.Second)
}
