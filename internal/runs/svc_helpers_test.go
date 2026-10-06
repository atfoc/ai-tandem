package runs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/model"
)

// Test support of the service, the events and the tools. The engine is not part of what these
// tests check: a small model of it (svcFake) stands where the service calls it, so the tests say
// the same whether engine.go holds the stubs or the real engine.

// svcHost is the chat manager as these tests need it: the chats of a run, what the service asked
// it to do, whether an agent's turn runs, and an agent's thread.
type svcHost struct {
	nopHost
	mu      sync.Mutex
	people  map[string][]model.ChatMeta // by run
	agents  map[string][]model.ChatMeta
	calls   []string
	stopped map[string]bool // chats whose process is in no turn
	items   map[string][]model.Item
	asked   func(id string) // called by TurnRunning, with no lock held
}

func newSvcHost() *svcHost {
	return &svcHost{people: map[string][]model.ChatMeta{}, agents: map[string][]model.ChatMeta{}, stopped: map[string]bool{},
		items: map[string][]model.Item{}}
}

func (h *svcHost) note(format string, args ...any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls = append(h.calls, fmt.Sprintf(format, args...))
}

func (h *svcHost) called() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.calls)
}

func (h *svcHost) ChatsOfRun(run string) (people, agents []model.ChatMeta) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.people[run]), slices.Clone(h.agents[run])
}

func (h *svcHost) SetArchive(id string, a model.Archive) error {
	h.mu.Lock()
	for _, list := range h.people {
		for i := range list {
			if list[i].ID == id {
				list[i].Archive = a
			}
		}
	}
	h.mu.Unlock()
	h.note("SetArchive %s %v %s", id, a.Archived, a.Op)
	return nil
}

func (h *svcHost) Stop(id string)              { h.note("Stop %s", id) }
func (h *svcHost) Delete(id string) error      { h.note("Delete %s", id); return nil }
func (h *svcHost) DeleteOwned(id string) error { h.note("DeleteOwned %s", id); return nil }
func (h *svcHost) TurnRunning(id string) bool {
	h.mu.Lock()
	asked, running := h.asked, !h.stopped[id]
	h.mu.Unlock()
	if asked != nil {
		asked(id)
	}
	return running
}

func (h *svcHost) setStopped(id string, v bool) { h.mu.Lock(); defer h.mu.Unlock(); h.stopped[id] = v }

func (h *svcHost) ItemsOf(id, branch string) (string, int, []model.Item, []model.Subagent, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return "main", 1, slices.Clone(h.items[id]), nil, nil
}

// svcFake is a model of the engine, as far as the service and the tools call it: it writes the
// entries engine.go's comments say the engine writes, and starts nothing.
type svcFake struct {
	mu     sync.Mutex
	calls  []string
	stay   bool     // a halt stays `stopping`: the workers have not let go yet
	git    gitFacts // what gitFacts answers
	gitErr error
	cancel string // what cancelActive answers; "" = it ends the attempt as cancelled
	stops  bool   // what stopEngine answers
}

func (f *svcFake) note(format string, args ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fmt.Sprintf(format, args...))
}

func (f *svcFake) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *svcFake) set(change func(f *svcFake)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

// halted is the end of a halt: run_halted with the target of the halt that is under way.
func (f *svcFake) halted(r *run) error {
	_, err := r.commit(KRunHalted, func(tx *Tx) error {
		st := tx.State()
		h := st.Halting
		if st.Status != model.RunStopping || h == nil {
			return ErrNotRunning
		}
		st.Status, st.Reason, st.StalledBy, st.Halting = h.Status, h.Reason, h.StalledBy, nil
		st.ActiveMs += tx.Now() - st.AsOf
		st.AsOf = tx.Now()
		tx.SetStops(append(tx.Stops(), model.RunStop{At: tx.Now(), Reason: h.Stop}))
		return nil
	})
	return err
}

func (f *svcFake) engine() svcEngine {
	return svcEngine{
		start: func(r *run) { f.note("start %s", r.id) },
		halt: func(r *run, h Halting) error {
			f.note("halt %s %s %q %s", r.id, h.Status, h.Reason, h.Stop)
			_, err := r.commit(KRunStopping, func(tx *Tx) error {
				if tx.L().State.Status != model.RunRunning {
					return ErrNotRunning
				}
				st := tx.State()
				st.Status, st.Halting = model.RunStopping, &h
				return nil
			})
			f.mu.Lock()
			stay := f.stay
			f.mu.Unlock()
			if err != nil || stay {
				return err
			}
			return f.halted(r)
		},
		resume: func(r *run) error {
			f.note("resume %s", r.id)
			_, err := r.commit(KRunResumed, func(tx *Tx) error {
				st := tx.State()
				if s := st.Status; s != model.RunStopped && s != model.RunStalled && s != model.RunError {
					return ErrNotHalted
				}
				if st.StalledBy == model.StalledIdle {
					st.IdleStreak = 0
				}
				st.Status, st.Reason, st.StalledBy, st.AsOf = model.RunRunning, "", "", tx.Now()
				stops := tx.Stops()
				if n := len(stops); n > 0 && stops[n-1].ResumedAt == 0 {
					stops[n-1].ResumedAt = tx.Now()
				}
				tx.SetStops(stops)
				return nil
			})
			return err
		},
		stop: func(r *run, wait time.Duration) bool {
			f.note("stop %s", r.id)
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.stops
		},
		cancelActive: func(r *run, tid string, c model.AttemptCancel) string {
			f.note("cancelActive %s %s", r.id, tid)
			f.mu.Lock()
			answer := f.cancel
			f.mu.Unlock()
			if answer != "" {
				return answer
			}
			if _, err := r.commit(KTaskEnded, func(tx *Tx) error {
				t := tx.Task(tid)
				a := &t.Attempts[len(t.Attempts)-1]
				tx.Head(Entry{Task: tid, Attempt: a.N})
				a.Outcome, a.Cancel, a.EndedAt = model.TaskCancelled, &c, tx.Now()
				t.HeldBy = nil
				return nil
			}); err != nil {
				return err.Error()
			}
			return ""
		},
		removeCheckouts: func(r *run, ctx context.Context) error { f.note("removeCheckouts %s", r.id); return nil },
		gitFacts: func(r *run, ctx context.Context) (gitFacts, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.git, f.gitErr
		},
	}
}

// svcEnv is a testEnv whose Service has the fake chat manager and the model of the engine.
type svcEnv struct {
	*testEnv
	host *svcHost
	fake *svcFake
	seen int // how many of the broadcast events events() has returned
}

func newSvcEnv(t testing.TB) *svcEnv {
	t.Helper()
	e := &svcEnv{testEnv: newTestEnv(t), host: newSvcHost(), fake: &svcFake{stops: true}}
	e.wire()
	return e
}

// wire puts the fakes into the Service the env has now.
func (e *svcEnv) wire() {
	e.s.Chats = e.host
	e.s.engine = e.fake.engine()
	e.s.haltWait = 150 * time.Millisecond
}

// restart is a server restart: a fresh Service on the same data folder, with the runs loaded.
func (e *svcEnv) restart() {
	e.t.Helper()
	e.boot()
	e.wire()
	if err := e.s.Load(); err != nil {
		e.t.Fatal(err)
	}
}

// allEvents is what the Service has broadcast so far, the queue sent first.
func (e *svcEnv) allEvents() []any {
	e.s.svcFlush()
	return e.emit.events()
}

// events is what the Service has broadcast since events was last called.
func (e *svcEnv) events() []any {
	all := e.allEvents()
	fresh := all[min(e.seen, len(all)):]
	e.seen = len(all)
	return fresh
}

// svcKinds names events for a comparison: "run", "run_detail 3", "run_removed", "defaults".
func svcKinds(evs []any) []string {
	out := make([]string, 0, len(evs))
	for _, ev := range evs {
		switch x := ev.(type) {
		case svcRunEvent:
			out = append(out, "run")
		case detailEvent:
			out = append(out, fmt.Sprintf("run_detail %d", x.Version))
		case svcRemovedEvent:
			out = append(out, "run_removed")
		case map[string]any:
			out = append(out, fmt.Sprint(x["type"]))
		default:
			out = append(out, fmt.Sprintf("%T", ev))
		}
	}
	return out
}

// svcRunEvents is the views of the `run` events of one run among evs, in order.
func svcRunEvents(evs []any, id string) []model.RunView {
	var out []model.RunView
	for _, ev := range evs {
		if x, ok := ev.(svcRunEvent); ok && x.Run.ID == id {
			out = append(out, x.Run)
		}
	}
	return out
}

// svcWait waits until ok holds, for at most five seconds.
func svcWait(t testing.TB, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// svcState reads the run's recorded state.
func svcState(t testing.TB, r *run) *Loaded {
	t.Helper()
	if err := r.load(); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.L.snapshot()
}

// in puts a started run into a status, by the entries that lead there.
func (e *svcEnv) in(id string, status model.RunStatus) *run {
	e.t.Helper()
	if status == model.RunDraft {
		return e.draft(id)
	}
	r := e.started(id)
	halt := func(h Halting) {
		e.must(r, KRunStopping, func(tx *Tx) error {
			st := tx.State()
			st.Status, st.Halting = model.RunStopping, &h
			return nil
		})
	}
	switch status {
	case model.RunRunning:
	case model.RunStopping:
		halt(Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser})
	case model.RunStopped:
		halt(Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser})
		if err := e.fake.halted(r); err != nil {
			e.t.Fatal(err)
		}
	case model.RunStalled:
		halt(Halting{Status: model.RunStalled, Reason: "the orchestrator was started 3 times in a row with nothing running and neither added work nor finished the run", StalledBy: model.StalledIdle, Stop: model.StopStalled})
		if err := e.fake.halted(r); err != nil {
			e.t.Fatal(err)
		}
	case model.RunError:
		halt(Halting{Status: model.RunError, Reason: "orchestrator turn 1: agent turn-001 failed", Stop: model.StopError})
		if err := e.fake.halted(r); err != nil {
			e.t.Fatal(err)
		}
	case model.RunCompleted, model.RunGaveUp:
		e.must(r, KRunFinished, func(tx *Tx) error {
			st := tx.State()
			outcome := model.Achieved
			if status == model.RunGaveUp {
				outcome = model.NotAchieved
			}
			st.Status, st.EndedAt, st.Result = status, tx.Now(), &model.RunResult{Outcome: outcome, Summary: "Done.", At: tx.Now()}
			return nil
		})
	default:
		e.t.Fatalf("no way to status %q", status)
	}
	return r
}

// svcStatuses is every run status, in the order of the contract's table.
var svcStatuses = []model.RunStatus{model.RunDraft, model.RunRunning, model.RunStopping, model.RunStopped, model.RunStalled,
	model.RunError, model.RunCompleted, model.RunGaveUp}

// ---- a run for the tools' tests ------------------------------------------------------------

// toolRun is a started run that a test plays: the engine's steps are entries made by hand, the
// tools are called as the MCP endpoint calls them, and what they answer is kept as a transcript
// for a golden file.
type toolRun struct {
	*svcEnv
	r   *run
	id  string
	out strings.Builder
}

const (
	toolBase = "87220658d4c8f1a2b3c4d5e6f708192a3b4c5d6e" // the commit a git run of these tests starts from
	toolChat = "chat-1"                                   // the person's chat on the run
)

// newToolRun starts a run by hand, with or without git, on a fresh env.
func newToolRun(t testing.TB, git bool) *toolRun {
	t.Helper()
	x := &toolRun{svcEnv: newSvcEnv(t), id: "r_tools001"}
	x.r = x.startRun(x.id, "Port the importer", git)
	return x
}

// startRun makes a started run the way the service's Start does, with made-up git facts.
func (x *toolRun) startRun(id, name string, git bool) *run {
	x.t.Helper()
	r := x.draft(id)
	if err := writeGoal(r.dir, "Port the importer.\n"); err != nil {
		x.t.Fatal(err)
	}
	x.must(r, KRunStarted, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.StartedAt, st.AsOf, st.GoalSize = model.RunRunning, tx.Now(), tx.Now(), 19
		if git {
			st.Git = &Git{RunGit: model.RunGit{BaseRef: toolBase, IntegrationBranch: svcIntegrationBranch(id)}, Repo: "/repo",
				Integration: "/work/" + id + "/int", Orchestrator: "/work/" + id + "/orch"}
		}
		return nil
	})
	r.mu.Lock()
	r.meta.Name, r.meta.Started, r.meta.Git = name, x.clock.Now(), git
	err := writeMeta(r.dir, r.meta)
	r.refreshView()
	r.mu.Unlock()
	if err != nil {
		x.t.Fatal(err)
	}
	x.s.svcNoteGit(r)
	return r
}

// tick moves the clock. What is queued is sent first, so that every event has the time it was
// made at, not the one the clock is moved to.
func (x *toolRun) tick(d time.Duration) {
	x.s.svcFlush()
	x.clock.Advance(d)
}

func (x *toolRun) state() *Loaded { return svcState(x.t, x.r) }

// turn is the number of the run's last turn.
func (x *toolRun) turn() int { return len(x.state().Turns) }

func (x *toolRun) orchChat(turn int) string { return AgentChatID(x.id, TurnAgentName(turn)) }

// turnStart is the engine starting a turn: it takes the inbox.
func (x *toolRun) turnStart(reason string) int {
	x.t.Helper()
	n := x.turn() + 1
	x.must(x.r, KTurnStarted, func(tx *Tx) error {
		tx.Head(Entry{Turn: n})
		st := tx.State()
		tx.AddTurn(Turn{N: n, Agent: x.orchChat(n), Reason: reason, Status: "running", StartedAt: tx.Now(), WokenBy: st.Inbox})
		st.Inbox = nil
		tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: x.orchChat(n), Name: TurnAgentName(n), Role: model.RoleOrchestrator, Turn: n,
			Status: model.AgentRunning, StartedAt: tx.Now(), Launches: []model.RunLaunch{{N: 1, StartedAt: tx.Now()}}}, Resumable: true})
		return nil
	})
	return n
}

// turnEnd is the engine ending the running turn: its holds go.
func (x *toolRun) turnEnd(summary string, cost float64) {
	x.t.Helper()
	n := x.turn()
	x.must(x.r, KTurnEnded, func(tx *Tx) error {
		tx.Head(Entry{Turn: n})
		t := tx.Turn(n)
		t.Status, t.EndedAt, t.Summary, t.Cost = "done", tx.Now(), summary, &cost
		a := tx.Agent(x.orchChat(n))
		a.Status, a.EndedAt, a.Cost = model.AgentDone, tx.Now(), &cost
		a.Launches[0].EndedAt = tx.Now()
		for _, task := range tx.L().Tasks {
			if slices.Contains(task.HeldBy, Holder{Turn: n}) {
				w := tx.Task(task.ID)
				w.HeldBy = slices.DeleteFunc(w.HeldBy, func(h Holder) bool { return h.Turn == n })
			}
		}
		return nil
	})
}

// chatIdle is the engine seeing that the chat's reply ended: its holds go.
func (x *toolRun) chatIdle(chat string) {
	x.t.Helper()
	x.must(x.r, KTaskWait, func(tx *Tx) error {
		for _, task := range tx.L().Tasks {
			if slices.Contains(task.HeldBy, Holder{Chat: chat}) {
				w := tx.Task(task.ID)
				w.HeldBy = slices.DeleteFunc(w.HeldBy, func(h Holder) bool { return h.Chat == chat })
			}
		}
		return nil
	})
}

func (x *toolRun) last(tid string) Attempt {
	t, ok := toolTask(x.state(), tid)
	if !ok {
		x.t.Fatalf("no task %s", tid)
	}
	return toolLastAttempt(t)
}

// taskStart is the engine giving the task a slot; taskWork its agent starting.
func (x *toolRun) taskStart(tid string) {
	x.t.Helper()
	git := x.state().State.Git != nil
	x.must(x.r, KTaskStarted, func(tx *Tx) error {
		t := tx.Task(tid)
		a := &t.Attempts[len(t.Attempts)-1]
		tx.Head(Entry{Task: tid, Attempt: a.N})
		a.StartedAt = tx.Now()
		if git {
			a.Base, a.Worktree = toolBase, "/work/"+x.id+"/"+AttemptPrefix(tid, a.N)
			if t.Writes {
				a.Branch = "aiwb/" + x.id + "/" + AttemptPrefix(tid, a.N)
			}
		}
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskSetup, T: tx.Now()})
		return nil
	})
}

func (x *toolRun) taskWork(tid string) {
	x.t.Helper()
	x.r.mu.Lock()
	tiers := x.r.meta.Tiers
	x.r.mu.Unlock()
	x.must(x.r, KTaskStep, func(tx *Tx) error {
		t := tx.Task(tid)
		a := &t.Attempts[len(t.Attempts)-1]
		tx.Head(Entry{Task: tid, Attempt: a.N})
		name := WorkAgentName(tid, a.N)
		a.SetupDone, a.Agents.Work = true, AgentChatID(x.id, name)
		a.Phases = append(a.Phases, model.RunPhase{K: model.TaskWork, T: tx.Now()})
		on := tiers.Of(a.Tier)
		tx.AddAgent(Agent{RunAgent: model.RunAgent{ID: a.Agents.Work, Name: name, Role: model.RoleTask, Task: tid, Attempt: a.N,
			Tier: a.Tier, Model: on.Model, Effort: on.Effort,
			Status: model.AgentRunning, StartedAt: tx.Now(), Launches: []model.RunLaunch{{N: 1, StartedAt: tx.Now()}}}, Resumable: true})
		return nil
	})
}

// taskRuns is taskStart and taskWork.
func (x *toolRun) taskRuns(tid string) {
	x.t.Helper()
	x.taskStart(tid)
	x.tick(4 * time.Second)
	x.taskWork(tid)
}

// taskResult is the task's agent returning its result: a writing task of a git run is merged next.
func (x *toolRun) taskResult(tid, outcome, summary, report string, cost float64) {
	x.t.Helper()
	x.must(x.r, KTaskStep, func(tx *Tx) error {
		t := tx.Task(tid)
		a := &t.Attempts[len(t.Attempts)-1]
		tx.Head(Entry{Task: tid, Attempt: a.N})
		a.WorkDone, a.Result = true, &model.AttemptResult{Outcome: outcome, Summary: summary, ReportSize: toolChars(report)}
		if report != "" {
			tx.File(reportRel(tid, a.N), []byte(report+"\n"))
		}
		if outcome == "completed" && t.Writes && a.Branch != "" {
			a.Phases = append(a.Phases, model.RunPhase{K: model.TaskMerge, T: tx.Now()})
		}
		g := tx.Agent(a.Agents.Work)
		g.Status, g.EndedAt, g.Cost = model.AgentDone, tx.Now(), &cost
		g.Launches[0].EndedAt = tx.Now()
		a.Cost = &cost
		return nil
	})
}

// taskDone is the task ending well, with its event; a writing task of a git run has commits.
func (x *toolRun) taskDone(tid string) {
	x.t.Helper()
	x.must(x.r, KTaskEnded, func(tx *Tx) error {
		t := tx.Task(tid)
		a := &t.Attempts[len(t.Attempts)-1]
		tx.Head(Entry{Task: tid, Attempt: a.N})
		if a.Branch != "" {
			a.Head, a.Merged, a.MergedAt = "fd8c08d45948aaaabbbbccccddddeeeeffff0000", "9018a1c8e5f6aaaabbbbccccddddeeeeffff0000", tx.Now()
			tx.File(changesRel(tid, a.N), changesData(model.AttemptChanges{Task: tid, Attempt: a.N, Branch: a.Branch, Base: a.Base, Head: a.Head,
				Merged: a.Merged, MergedAt: a.MergedAt, Add: 29, Del: 4,
				Files: []model.ChangedFile{{Path: "internal/importer/importer.go", Add: 24, Del: 2}, {Path: "internal/importer/importer_test.go", Add: 5, Del: 2}}}))
		}
		a.Outcome, a.EndedAt, a.Worktree = model.TaskDone, tx.Now(), ""
		tx.Event(model.RunEvent{Type: "task_done", Task: tid, Text: clip(a.Result.Summary, 600)})
		return nil
	})
}

// taskFail is the task failing, with its event.
func (x *toolRun) taskFail(tid, msg string) {
	x.t.Helper()
	x.must(x.r, KTaskEnded, func(tx *Tx) error {
		t := tx.Task(tid)
		a := &t.Attempts[len(t.Attempts)-1]
		tx.Head(Entry{Task: tid, Attempt: a.N})
		a.Outcome, a.Error, a.EndedAt, a.Worktree = model.TaskFailed, msg, tx.Now(), ""
		if g := tx.Agent(a.Agents.Work); g != nil && g.Status == model.AgentRunning {
			g.Status, g.EndedAt, g.Error = model.AgentFailed, tx.Now(), msg
			g.Launches[0].EndedAt, g.Launches[0].Error = tx.Now(), msg
		}
		tx.Event(model.RunEvent{Type: "task_failed", Task: tid, Text: clip(msg, 600)})
		return nil
	})
}

// orch calls a tool as the orchestrator of the run's last turn; chat as the person's chat.
func (x *toolRun) orch(name, args string) (string, bool) {
	return x.orchOf(x.turn(), name, args)
}

func (x *toolRun) orchOf(turn int, name, args string) (string, bool) {
	return x.s.Call(boardapi.RunCaller{Run: x.id, Chat: x.orchChat(turn), Role: model.RoleOrchestrator}, name, json.RawMessage(args))
}

func (x *toolRun) chat(name, args string) (string, bool) {
	return x.s.Call(boardapi.RunCaller{Run: x.id, Chat: toolChat}, name, json.RawMessage(args))
}

// ok calls a tool and fails the test when it is refused.
func (x *toolRun) ok(who, name, args string) string {
	x.t.Helper()
	call := x.orch
	if who == "chat" {
		call = x.chat
	}
	text, isErr := call(name, args)
	if isErr {
		x.t.Fatalf("%s %s %s: refused: %s", who, name, args, text)
	}
	return text
}

// say calls a tool and writes the call and its answer into the transcript.
func (x *toolRun) say(title, who, name, args string) (string, bool) {
	x.t.Helper()
	call := x.orch
	if who == "chat" {
		call = x.chat
	}
	text, isErr := call(name, args)
	x.write(title, who, name, args, text, isErr)
	return text, isErr
}

func (x *toolRun) write(title, who, name, args, text string, isErr bool) {
	kind := "answer"
	if isErr {
		kind = "refusal"
	}
	fmt.Fprintf(&x.out, "=== %s\n%s: %s %s\n%s:\n%s\n\n", title, who, name, args, kind, text)
}

// note writes a line that is not a call into the transcript.
func (x *toolRun) note(title, text string) { fmt.Fprintf(&x.out, "=== %s\n%s\n\n", title, text) }

// golden compares the transcript with testdata/tools/<name>.txt. AIWB_UPDATE_TOOL_GOLDEN=1
// writes the file instead.
func (x *toolRun) golden(name string) { x.t.Helper(); toolGolden(x.t, name, x.out.String()) }

func toolGolden(t testing.TB, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "tools", name+".txt")
	if os.Getenv("AIWB_UPDATE_TOOL_GOLDEN") != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run the test with AIWB_UPDATE_TOOL_GOLDEN=1 to write it)", err)
	}
	if got == string(want) {
		return
	}
	g, w := strings.Split(got, "\n"), strings.Split(string(want), "\n")
	for i := 0; i < len(g) || i < len(w); i++ {
		var gl, wl string
		if i < len(g) {
			gl = g[i]
		}
		if i < len(w) {
			wl = w[i]
		}
		if gl != wl {
			t.Fatalf("%s differs at line %d:\n got: %s\nwant: %s", path, i+1, clip(gl, 400), clip(wl, 400))
		}
	}
}

// toolArgsJSON is a tool's arguments from a value.
func toolArgsJSON(t testing.TB, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// toolBrief is a brief long enough to be accepted.
const toolBrief = "Read the old importer and write down what it does, step by step, with the files it touches."
