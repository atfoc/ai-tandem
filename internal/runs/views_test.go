package runs

import (
	"encoding/json"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// tenStates is a state with one task in each of the ten task states.
func tenStates() *Loaded {
	l := &Loaded{Version: 5, State: State{Status: model.RunRunning, StartedAt: 100, AsOf: 200, ActiveMs: 50, GoalSize: 9, IdleStreak: 2}}
	for i, s := range []model.TaskState{model.TaskHeld, model.TaskDeps, model.TaskBlocked, model.TaskSlot, model.TaskSetup,
		model.TaskWork, model.TaskMerge, model.TaskDone, model.TaskFailed, model.TaskCancelled} {
		l.Tasks = append(l.Tasks, taskIn(TaskID(i+1), s))
	}
	return l
}

func TestSummarize(t *testing.T) {
	l := tenStates()
	s := l.Summarize(false)
	if s.Counts != (model.RunCounts{Held: 1, Deps: 1, Blocked: 1, Slot: 1, Setup: 1, Work: 1, Merge: 1, Done: 1, Failed: 1, Cancelled: 1}) {
		t.Errorf("counts: %+v", s.Counts)
	}
	if s.Attention != 2 || s.Turns != 0 || s.TurnRunning != 0 {
		t.Errorf("attention %d (want blocked + failed = 2), turns %d, running %d", s.Attention, s.Turns, s.TurnRunning)
	}
	if s.Cost == nil || *s.Cost != 0 || s.CostPartial {
		t.Errorf("no agents: cost %v, partial %v", s.Cost, s.CostPartial)
	}

	// Turns: the last one running, with refused calls in it; an earlier turn's refusals do not count.
	l.Turns = []Turn{{N: 1, Status: "done", Ops: []model.RunOp{{Op: "add_task", Error: "no"}}},
		{N: 2, Status: "running", Ops: []model.RunOp{{Op: "get_run"}, {Op: "finish_run", Error: "no"}, {Op: "add_task", Error: "no"}}}}
	if s = l.Summarize(false); s.Turns != 2 || s.TurnRunning != 2 || s.Attention != 4 {
		t.Errorf("turns %d, running %d, attention %d (want 2, 2, 4)", s.Turns, s.TurnRunning, s.Attention)
	}
	l.Turns[1].Status = "done"
	if s = l.Summarize(false); s.TurnRunning != 0 {
		t.Errorf("no turn runs, TurnRunning is %d", s.TurnRunning)
	}

	// Cost: the sum of what the agents reported.
	agent := func(id string, st model.RunAgentStatus, cost *float64) Agent {
		return Agent{RunAgent: model.RunAgent{ID: id, Status: st, Cost: cost}}
	}
	l.Agents = []Agent{agent("a", model.AgentDone, f64(1.25)), agent("b", model.AgentFailed, f64(0.5)), agent("c", model.AgentRunning, f64(0.25))}
	if s = l.Summarize(false); *s.Cost != 2 || s.CostPartial {
		t.Errorf("cost %v, partial %v; want 2, false", *s.Cost, s.CostPartial)
	}
	// A running agent with no cost yet is not a gap; an ended one is.
	l.Agents = append(l.Agents, agent("d", model.AgentRunning, nil))
	if s = l.Summarize(false); *s.Cost != 2 || s.CostPartial {
		t.Errorf("a running agent with no cost: cost %v, partial %v", *s.Cost, s.CostPartial)
	}
	for _, st := range []model.RunAgentStatus{model.AgentDone, model.AgentFailed, model.AgentInterrupted, model.AgentCancelled} {
		l.Agents[3] = agent("d", st, nil)
		if s = l.Summarize(false); *s.Cost != 2 || !s.CostPartial {
			t.Errorf("an agent that ended %s with no cost: cost %v, partial %v", st, *s.Cost, s.CostPartial)
		}
	}
	// CostLost: a cost is known and known to be incomplete, whatever the agent's status.
	for _, st := range []model.RunAgentStatus{model.AgentDone, model.AgentRunning, model.AgentInterrupted} {
		l.Agents = []Agent{agent("a", model.AgentDone, f64(1)), {RunAgent: model.RunAgent{ID: "b", Status: st, Cost: f64(2)}, CostLost: true}}
		if s = l.Summarize(false); *s.Cost != 3 || !s.CostPartial {
			t.Errorf("CostLost on a %s agent: cost %v, partial %v; want 3, true", st, *s.Cost, s.CostPartial)
		}
	}
	// An agent kind that reports no cost: null, and nothing is partial.
	if s = l.Summarize(true); s.Cost != nil || s.CostPartial {
		t.Errorf("no-cost kind: cost %v, partial %v", s.Cost, s.CostPartial)
	}
	if got := (Task{}).State(); got != model.TaskHeld {
		t.Errorf("a task with no attempt is %q", got)
	}
}

func TestViewOf(t *testing.T) {
	l := tenStates()
	l.Agents = []Agent{{RunAgent: model.RunAgent{ID: "a", Status: model.AgentDone, Cost: f64(1.5)}}}
	l.Turns = []Turn{{N: 1, Status: "running"}}
	created, started := time.UnixMilli(1000).UTC(), time.UnixMilli(2000).UTC()
	meta := model.RunMeta{ID: "r_1", Name: "A run", UserNamed: true, Group: "g_1", Created: created, Agent: model.Claude, Tiers: tiersAll("sonnet", "high"),
		Cwd: "/work", Settings: model.DefaultRunSettings(), Draft: &model.Draft{Text: "goal"}}

	// A draft: nothing of the state, git from what the server found in the folder.
	v := ViewOf(meta, nil, Summary{}, Facts{FolderMissing: true, Git: true, Blocked: "no commit yet"})
	if v.Status != model.RunDraft || !v.Git || !v.FolderMissing || v.Blocked != "no commit yet" || v.Draft == nil || !v.Started.IsZero() ||
		v.ID != "r_1" || v.Name != "A run" || !v.UserNamed || v.Group != "g_1" || !v.Created.Equal(created) || v.Tiers != tiersAll("sonnet", "high") ||
		v.Cwd != "/work" || v.Settings.MaxParallel != 8 || v.Cost != nil || v.Turns != 0 {
		t.Errorf("draft view: %+v", v)
	}
	// A state without Started in run.json is still a draft to clients (the start's last write).
	if v := ViewOf(meta, &l.State, l.Summarize(false), Facts{}); v.Status != model.RunDraft || v.ActiveMs != 0 {
		t.Errorf("state without started: %+v", v)
	}

	// Started, with cost.
	meta.Started, meta.Git, meta.Draft = started, true, nil
	meta.Archive = model.Archive{Archived: true, Op: "op1"}
	l.State.Reason, l.State.StalledBy = "why", model.StalledTurns
	v = ViewOf(meta, &l.State, l.Summarize(false), Facts{Git: false, Blocked: "claude not found"})
	if v.Status != model.RunRunning || !v.Git || v.Blocked != "claude not found" || !v.Started.Equal(started) || !v.Archived || v.Op != "op1" ||
		v.Reason != "why" || v.StalledBy != model.StalledTurns || v.ActiveMs != 50 || v.AsOf != 200 || v.IdleStreak != 2 ||
		v.Turns != 1 || v.TurnRunning != 1 || v.Attention != 2 || v.Counts.Work != 1 || v.Counts.Cancelled != 1 ||
		v.Cost == nil || *v.Cost != 1.5 || v.CostPartial || v.Outcome != "" {
		t.Errorf("started view: %+v", v)
	}
	// Without cost (Cursor), and with a lost cost.
	if v = ViewOf(meta, &l.State, l.Summarize(true), Facts{}); v.Cost != nil || v.CostPartial {
		t.Errorf("no-cost view: cost %v partial %v", v.Cost, v.CostPartial)
	}
	b, _ := json.Marshal(v)
	if !strings.Contains(string(b), `"cost":null`) {
		t.Errorf("a run with no cost does not say cost null: %s", b)
	}
	l.Agents[0].CostLost = true
	if v = ViewOf(meta, &l.State, l.Summarize(false), Facts{}); v.Cost == nil || *v.Cost != 1.5 || !v.CostPartial {
		t.Errorf("lost cost: cost %v partial %v", v.Cost, v.CostPartial)
	}
	// The outcome shows only once the run has ended (finish_run sets the result a turn earlier).
	l.State.Result = &model.RunResult{Outcome: model.Achieved, Summary: "done", Turn: 1}
	if v = ViewOf(meta, &l.State, l.Summarize(false), Facts{}); v.Outcome != "" {
		t.Errorf("outcome before the run ended: %q", v.Outcome)
	}
	l.State.Status = model.RunCompleted
	if v = ViewOf(meta, &l.State, l.Summarize(false), Facts{}); v.Outcome != model.Achieved || v.Status != model.RunCompleted {
		t.Errorf("ended view: status %q outcome %q", v.Status, v.Outcome)
	}
}

// The view's cost counts a running agent's live cost in place of its recorded one.
func TestWithLiveCost(t *testing.T) {
	l := &Loaded{Agents: []Agent{{RunAgent: model.RunAgent{ID: "a", Cost: f64(1)}}, {RunAgent: model.RunAgent{ID: "b", Status: model.AgentRunning}},
		{RunAgent: model.RunAgent{ID: "c", Status: model.AgentRunning, Cost: f64(0.5)}}}}
	sum := l.Summarize(false)
	if got := withLiveCost(sum, l, nil); *got.Cost != 1.5 {
		t.Errorf("no live values: %v", *got.Cost)
	}
	got := withLiveCost(sum, l, map[string]Live{"b": {Cost: f64(0.25)}, "c": {Cost: f64(2), Tools: 3}, "zz": {Cost: f64(100)}})
	if *got.Cost != 3.25 || *sum.Cost != 1.5 {
		t.Errorf("live cost %v (want 3.25), the recorded sum is now %v (want 1.5)", *got.Cost, *sum.Cost)
	}
	if got := withLiveCost(l.Summarize(true), l, map[string]Live{"b": {Cost: f64(1)}}); got.Cost != nil {
		t.Error("a no-cost run got a cost from live values")
	}
}

// fill sets every field of v, at every depth, to something that is not its zero value.
func fill(v reflect.Value) {
	switch v.Kind() {
	case reflect.Pointer:
		v.Set(reflect.New(v.Type().Elem()))
		fill(v.Elem())
	case reflect.Struct:
		if v.Type() == reflect.TypeOf(time.Time{}) {
			v.Set(reflect.ValueOf(time.UnixMilli(1_700_000_000_000).UTC()))
			return
		}
		for i := 0; i < v.NumField(); i++ {
			fill(v.Field(i))
		}
	case reflect.Slice:
		s := reflect.MakeSlice(v.Type(), 2, 2)
		fill(s.Index(0))
		fill(s.Index(1))
		v.Set(s)
	case reflect.Map:
		m := reflect.MakeMap(v.Type())
		val := reflect.New(v.Type().Elem()).Elem()
		fill(val)
		key := reflect.New(v.Type().Key()).Elem()
		fill(key)
		m.SetMapIndex(key, val)
		v.Set(m)
	case reflect.String:
		v.SetString("x" + v.Type().Name())
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int64, reflect.Int32:
		v.SetInt(7)
	case reflect.Float64:
		v.SetFloat(1.5)
	}
}

// keysOf collects every object key in v's JSON.
func keysOf(t *testing.T, v any) map[string]bool {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := json.Unmarshal(b, &decoded); err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	var walk func(x any, isAgents bool)
	walk = func(x any, isAgents bool) {
		switch x := x.(type) {
		case map[string]any:
			for k, e := range x {
				if !isAgents { // the keys of the agents map are chat ids
					keys[k] = true
				}
				walk(e, k == "agents" && !isAgents)
			}
		case []any:
			for _, e := range x {
				walk(e, false)
			}
		}
	}
	walk(decoded, false)
	return keys
}

// What the engine records beyond the wire types (T13's engine fields and T18's additions A1–A4)
// never reaches a client: not in a `run_detail` patch, not in the detail, not in a task's or an
// agent's view.
func TestEngineFieldsStayOffTheWire(t *testing.T) {
	var p Patch
	fill(reflect.ValueOf(&p).Elem())
	p.Tasks[1].ID, p.Agents[1].ID, p.Turns[1].N, p.Notes[1].V, p.ChatOps[1].I = "T02", "agent-2", 8, 8, 8
	engineOnly := []string{
		"halting", "stop", // A1 (stop is Halting's own; a RunStop names its reason "reason")
		"mergeRound", "mergeAgentDone", // A2
		"retryAt", "costLost", // A3
		"sub", // A4 (dirtyAtStart is a wire field: RunGit)
		"worktree", "setupDone", "workDone", "heldBy", "failures", "resumable", "repo", "integration", "orchestrator",
		"inbox", "idleStreak", "eventSeq", "asOf", "activeMs",
	} // not "state": the patch's own key is also the wire name of a delivery's state
	recorded := keysOf(t, p)
	for _, k := range engineOnly {
		if !recorded[k] {
			t.Errorf("the recorded patch has no key %q: the test's list is out of date", k)
		}
	}
	l := &Loaded{}
	l.Apply(9, p)
	live := map[string]Live{"agent-2": {Tools: 4, Activity: "ran ls", Cost: f64(9)}}
	task, agent := p.Tasks[0].View(), p.Agents[1].View(live["agent-2"])
	for what, v := range map[string]any{
		"WirePatch": WirePatch(State{}, p, live), "Detail": l.Detail("r_1", live), "Task.View": task, "Agent.View": agent,
	} {
		wire := keysOf(t, v)
		for _, k := range engineOnly {
			if wire[k] {
				t.Errorf("%s sends the engine's field %q", what, k)
			}
		}
		// Every key it sends is a key of the wire types.
		var names []string
		for k := range wire {
			names = append(names, k)
		}
		sort.Strings(names)
		for _, k := range names {
			if !wireKeys[k] {
				t.Errorf("%s sends %q, which no wire type of a run's detail has", what, k)
			}
		}
	}
	// The wire patch carries what the recorded one has of the wire fields, and the live values.
	w := WirePatch(State{}, p, live)
	if w.Status != p.State.Status || w.StartedAt != 7 || w.EndedAt != 7 || w.GoalSize != 7 || w.Git == nil || w.Git.BaseRef == "" || w.Result == nil ||
		len(w.Stops) != 2 || len(w.Turns) != 2 || len(w.Tasks) != 2 || len(w.ChatOps) != 2 || len(w.Notes) != 2 || len(w.Agents) != 2 {
		t.Errorf("wire patch: %+v", w)
	}
	if a := w.Agents["agent-2"]; a.Tools != 4 || a.Activity != "ran ls" || a.Cost == nil || *a.Cost != 9 {
		t.Errorf("an agent's live values in the patch: %+v", a)
	}
	if a := w.Agents[p.Agents[0].ID]; a.Tools != 0 || a.Activity != "" || a.Cost == nil || *a.Cost != 1.5 {
		t.Errorf("an agent without live values: %+v", a)
	}
	// Scalars are sent only when they changed.
	if w := WirePatch(*p.State, p, nil); w.Status != "" || w.StartedAt != 0 || w.EndedAt != 0 || w.GoalSize != 0 || w.Git != nil || w.Result != nil {
		t.Errorf("an unchanged state is in the patch: %+v", w)
	}
	if w := WirePatch(State{}, Patch{}, nil); !reflect.DeepEqual(w, model.RunPatch{}) {
		t.Errorf("an empty patch is not empty on the wire: %+v", w)
	}
	// The detail has lists where the state has none.
	b, _ := json.Marshal((&Loaded{}).Detail("r_1", nil))
	for _, k := range []string{`"stops":[]`, `"turns":[]`, `"tasks":[]`, `"chatOps":[]`, `"agents":{}`, `"notes":[]`} {
		if !strings.Contains(string(b), k) {
			t.Errorf("an empty detail lacks %s: %s", k, b)
		}
	}
}

// wireKeys is every JSON key of the wire types a run's detail is made of.
var wireKeys = func() map[string]bool {
	keys := map[string]bool{}
	var add func(t reflect.Type)
	add = func(t reflect.Type) {
		switch t.Kind() {
		case reflect.Pointer, reflect.Slice, reflect.Map:
			add(t.Elem())
		case reflect.Struct:
			for i := 0; i < t.NumField(); i++ {
				f := t.Field(i)
				if name, _, _ := strings.Cut(f.Tag.Get("json"), ","); name != "" && name != "-" {
					keys[name] = true
				}
				add(f.Type)
			}
		}
	}
	add(reflect.TypeOf(model.RunDetail{}))
	add(reflect.TypeOf(model.RunPatch{}))
	return keys
}()

// The copies Tx hands out share no memory with what they were made from: every slice and pointer
// in them, at every depth, is their own.
func TestClonesShareNothing(t *testing.T) {
	var st State
	var tk Task
	var tn Turn
	var ag Agent
	var op model.RunOp
	for _, v := range []any{&st, &tk, &tn, &ag, &op} {
		fill(reflect.ValueOf(v).Elem())
	}
	check := func(name string, orig, clone any) {
		t.Helper()
		if !reflect.DeepEqual(orig, clone) {
			t.Errorf("%s: the clone is not equal to the original", name)
		}
		var walk func(path string, a, b reflect.Value)
		walk = func(path string, a, b reflect.Value) {
			switch a.Kind() {
			case reflect.Pointer:
				if a.IsNil() {
					return
				}
				if a.Pointer() == b.Pointer() {
					t.Errorf("%s: %s is shared with the original", name, path)
				}
				walk(path, a.Elem(), b.Elem())
			case reflect.Slice:
				if a.Len() == 0 {
					return
				}
				if a.Pointer() == b.Pointer() {
					t.Errorf("%s: %s is shared with the original", name, path)
				}
				for i := 0; i < a.Len(); i++ {
					walk(path+"[]", a.Index(i), b.Index(i))
				}
			case reflect.Struct:
				for i := 0; i < a.NumField(); i++ {
					walk(path+"."+a.Type().Field(i).Name, a.Field(i), b.Field(i))
				}
			case reflect.Map:
				t.Errorf("%s: %s is a map; the clone functions do not copy maps", name, path)
			}
		}
		walk(name, reflect.ValueOf(orig), reflect.ValueOf(clone))
	}
	check("State", st, cloneState(st))
	check("Task", tk, cloneTask(tk))
	check("Turn", tn, cloneTurn(tn))
	check("Agent", ag, cloneAgent(ag))
	check("RunOp", op, cloneOp(op))
}

func TestAgentChatID(t *testing.T) {
	a := AgentChatID("r_abc", "T03-work")
	if a != AgentChatID("r_abc", "T03-work") {
		t.Error("the id is not stable")
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).MatchString(a) {
		t.Errorf("%q is not written as a UUID", a)
	}
	// sha256("r_abc/T03-work"), its first 16 bytes.
	if want := "058e8149-1daa-bac1-3685-fb6359a97736"; a != want {
		t.Errorf("id %s, want %s", a, want)
	}
	seen := map[string]string{}
	for _, run := range []string{"r_abc", "r_abd"} {
		for _, name := range []string{"T03-work", "T03-merge", "T03-a2-work", "T04-work", "turn-003", "turn-004"} {
			id := AgentChatID(run, name)
			if other, dup := seen[id]; dup {
				t.Errorf("%s/%s and %s have the same id", run, name, other)
			}
			seen[id] = run + "/" + name
		}
	}
	// The run and the name are joined with a slash: the two cannot run into each other.
	if AgentChatID("r_a", "b/c") != AgentChatID("r_a/b", "c") {
		t.Error("the id is not sha256(run + \"/\" + name)")
	}
}

func TestAgentAndTaskNames(t *testing.T) {
	for got, want := range map[string]string{
		TaskID(1): "T01", TaskID(9): "T09", TaskID(10): "T10", TaskID(100): "T100",
		AttemptPrefix("T03", 1): "T03", AttemptPrefix("T03", 2): "T03-a2", AttemptPrefix("T03", 0): "T03",
		TurnAgentName(7): "turn-007", TurnAgentName(123): "turn-123",
		WorkAgentName("T03", 1): "T03-work", WorkAgentName("T03", 3): "T03-a3-work",
		MergeAgentName("T03", 1): "T03-merge", MergeAgentName("T12", 2): "T12-a2-merge",
	} {
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	}
}

func TestClip(t *testing.T) {
	for _, c := range []struct {
		in   string
		max  int
		want string
	}{
		{"short", 10, "short"}, {"exactly10!", 10, "exactly10!"}, {"eleven chars", 10, "eleven ch…"},
		{"тёмная тема", 6, "тёмна…"}, {"x", 0, ""}, {"", 5, ""}, {"ab", 1, "…"},
	} {
		if got := clip(c.in, c.max); got != c.want {
			t.Errorf("clip(%q, %d) = %q, want %q", c.in, c.max, got, c.want)
		}
	}
}
