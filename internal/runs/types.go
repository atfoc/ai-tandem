// Package runs owns the runs: their folders under {home}/runs, their recorded state and the
// engine that drives them. This file is the recorded state: what is in a run's folder besides
// run.json (model.RunMeta), and how it becomes the views clients get.
//
// A run's recorded state changes only by committing a journal Entry: one line appended to
// journal.jsonl that carries every record the change touched, whole. state.json, tasks.json,
// turns.json and agents.json are a checkpoint of the same records, written now and then; after a
// crash the journal entries past the checkpoint are applied again.
package runs

import (
	"crypto/sha256"
	"fmt"
	"reflect"
	"slices"

	"ai-whiteboard/internal/model"
)

// ---- records ----------------------------------------------------------------

// State is the run-level record: small, and replaced whole by an entry that changes it.
type State struct {
	Status    model.RunStatus `json:"status"`
	Reason    string          `json:"reason,omitempty"`    // stopped, stalled, error: why
	StalledBy model.StalledBy `json:"stalledBy,omitempty"` //
	StartedAt int64           `json:"startedAt"`
	EndedAt   int64           `json:"endedAt,omitempty"` // completed, gave_up
	ActiveMs  int64           `json:"activeMs"`          // working time up to AsOf
	AsOf      int64           `json:"asOf"`
	GoalSize  int             `json:"goalSize"`
	Git       *Git            `json:"git,omitempty"` // nil: the run does not use git
	// Counters that must survive a restart.
	IdleStreak int `json:"idleStreak"` // idle turns in a row; reset when a task starts
	EventSeq   int `json:"eventSeq"`   // the Seq of the last event made
	// Inbox holds the events no turn was told about yet, in Seq order. Starting a turn moves them
	// to its WokenBy, a get_run of the running turn to its Learned.
	Inbox []model.RunEvent `json:"inbox,omitempty"`
	// Wait is what the orchestrator said it waits for: set by wait_for, cleared when a turn starts.
	Wait   *model.RunWait   `json:"wait,omitempty"`
	Result *model.RunResult `json:"result,omitempty"` // set by finish_run; the run ends when that turn does
	// Delivery is the last attempt to apply the result to the person's folder: nil until the run
	// has ended or halted and one was made. Clients get it only while the run is not live.
	Delivery *model.RunDelivery `json:"delivery,omitempty"`
	// Halting is set while Status is stopping: where the halt is going. A run that dies while it
	// stops ends as the halt intended, and does not continue by itself. Not on the wire.
	Halting *Halting `json:"halting,omitempty"`
}

// Halting is the target of a halt that is under way: the status the run gets when every worker
// has let go, why, and the reason of the stop that opens then.
type Halting struct {
	Status    model.RunStatus  `json:"status"` // stopped, stalled or error
	Reason    string           `json:"reason,omitempty"`
	StalledBy model.StalledBy  `json:"stalledBy,omitempty"`
	Stop      model.StopReason `json:"stop"`
}

// Git is where the run's work lives in the user's repository. The paths are the engine's.
type Git struct {
	model.RunGit
	Repo         string `json:"repo"`                   // the work tree's top level
	Integration  string `json:"integration,omitempty"`  // the integration checkout
	Orchestrator string `json:"orchestrator,omitempty"` // the orchestrator's read-only checkout
	Sub          string `json:"sub,omitempty"`          // the run's folder below Repo ("" = the top level): an agent works there in its checkout
}

// Holder is what a waiting task is held by: a running turn, or a chat whose reply is not over.
type Holder struct {
	Turn int    `json:"turn,omitempty"`
	Chat string `json:"chat,omitempty"`
}

// Task is a task's definition and all its attempts.
type Task struct {
	ID           string           `json:"id"`
	Title        string           `json:"title"`
	Kind         string           `json:"kind"`
	Writes       bool             `json:"writes"`
	DependsOn    []string         `json:"dependsOn"`
	AddedTurn    int              `json:"addedTurn"`
	AddedBy      string           `json:"addedBy,omitempty"`
	CreatedAt    int64            `json:"createdAt"`
	ChangedTurns []int            `json:"changedTurns"`
	BriefRev     int              `json:"briefRev"`
	Briefs       []model.BriefRev `json:"briefs"`
	HeldBy       []Holder         `json:"heldBy,omitempty"` // not on the wire: who must end before it may start
	Attempts     []Attempt        `json:"attempts"`
	Tier         model.Tier       `json:"tier"`       // "" (a task made before tiers): standard
	TierReason   string           `json:"tierReason"` // why that tier is enough
	NeedsReport  []string         `json:"needsReport"`
}

// Attempt is one attempt of a task: the wire record plus the step flags a restart needs. A step is
// recorded in the same entry that records its effect, so a restart never repeats a finished step:
// Base set = started (checkout to be made or made); SetupDone; WorkDone (Result set); Head set =
// committed; Merged set = merged; Conflicts set and Merged empty = a conflict resolution is under way.
type Attempt struct {
	model.RunAttempt
	Worktree  string `json:"worktree,omitempty"` // its checkout; empty once removed
	SetupDone bool   `json:"setupDone,omitempty"`
	WorkDone  bool   `json:"workDone,omitempty"`
	// The merge loop's restart flags: MergeRound is the conflict round under way (1, 2, 3; 0 = no
	// conflict yet), MergeAgentDone the last round whose merge agent returned its result.
	MergeRound     int `json:"mergeRound,omitempty"`
	MergeAgentDone int `json:"mergeAgentDone,omitempty"`
}

// Turn is recorded exactly as it is sent.
type Turn = model.RunTurn

// Agent is one agent of the run: the wire record (Tools and Activity stay empty here) plus what
// the engine needs to launch it again.
type Agent struct {
	model.RunAgent
	Failures  int   `json:"failures,omitempty"`  // counted failed launches since its last good one; survives a restart
	Resumable bool  `json:"resumable,omitempty"` // its session exists: the next launch resumes it
	RetryAt   int64 `json:"retryAt,omitempty"`   // no launch before this time (the backoff after a counted failure)
	CostLost  bool  `json:"costLost,omitempty"`  // something it spent is in no report (a process killed in a turn): Cost is incomplete
}

// ---- journal ----------------------------------------------------------------

// EntryKind names what an entry records.
type EntryKind string

const (
	KRunStarted  EntryKind = "run_started"  // the goal was sent
	KRunStopping EntryKind = "run_stopping" // a stop was asked for
	KRunHalted   EntryKind = "run_halted"   // stopped, stalled or error: a stop opens
	KRunResumed  EntryKind = "run_resumed"  // the open stop closes; a limit may be raised
	KRunFinished EntryKind = "run_finished" // completed or gave_up
	KRunDelivery EntryKind = "run_delivery" // a person's attempt to apply the result: its State holds the Delivery
	KTurnStarted EntryKind = "turn_started" // the turn, its agent, the inbox it took
	KTurnEnded   EntryKind = "turn_ended"   // done or failed; the tasks it held are released
	KOp          EntryKind = "op"           // one tool call, with everything it changed
	KLearned     EntryKind = "learned"      // a get_run of the running turn took the inbox
	KTaskWait    EntryKind = "task_wait"    // waiting tasks changed phase (a hold ended, a dependency ended)
	KTaskStarted EntryKind = "task_started" // a slot was taken: base, branch, checkout path
	KTaskStep    EntryKind = "task_step"    // setup done, result recorded, merging, head, conflicts, merged
	KTaskEnded   EntryKind = "task_ended"   // done, failed or cancelled, with its event in the same entry
	KAgent       EntryKind = "agent"        // an agent was made, launched, ended, or reported cost
)

// Entry is one line of journal.jsonl: one committed change. V rises by one per entry and is the
// run detail's version. The header fields say what happened; Patch holds the records as they are
// after it.
type Entry struct {
	V       int64     `json:"v"`
	T       int64     `json:"t"`
	Kind    EntryKind `json:"kind"`
	Turn    int       `json:"turn,omitempty"`
	Task    string    `json:"task,omitempty"`
	Attempt int       `json:"attempt,omitempty"`
	Chat    string    `json:"chat,omitempty"`  // the chat that made the call (op), or the agent's chat id (agent)
	Op      string    `json:"op,omitempty"`    // op: the tool's name
	Error   string    `json:"error,omitempty"` // op: it was refused
	Patch   Patch     `json:"patch"`
}

// Patch holds whole records. Applying it replaces State, Stops and each named record; it is
// idempotent, so applying an entry twice, or again after later ones up to the last, ends the same.
type Patch struct {
	State   *State               `json:"state,omitempty"`
	Stops   []model.RunStop      `json:"stops,omitempty"`   // the whole list
	Notes   []model.NotesVersion `json:"notes,omitempty"`   // by V
	Turns   []Turn               `json:"turns,omitempty"`   // by N
	Tasks   []Task               `json:"tasks,omitempty"`   // by ID
	ChatOps []model.RunOp        `json:"chatOps,omitempty"` // by I
	Agents  []Agent              `json:"agents,omitempty"`  // by ID
}

// ---- checkpoint files ---------------------------------------------------------

// StateFile is state.json, written last of a checkpoint: everything up to entry Version is in the
// checkpoint files, and the journal is read again from byte JournalOffset. Summary lets the
// server show the run without loading the other files.
type StateFile struct {
	Version       int64                `json:"version"`
	JournalOffset int64                `json:"journalOffset"`
	State         State                `json:"state"`
	Stops         []model.RunStop      `json:"stops"`
	Notes         []model.NotesVersion `json:"notes"`
	Summary       Summary              `json:"summary"`
}

// TasksFile, TurnsFile and AgentsFile are tasks.json, turns.json and agents.json.
type TasksFile struct {
	Version int64  `json:"version"`
	Tasks   []Task `json:"tasks"` // in creation order
}

type TurnsFile struct {
	Version int64         `json:"version"`
	Turns   []Turn        `json:"turns"`
	ChatOps []model.RunOp `json:"chatOps"`
}

type AgentsFile struct {
	Version int64   `json:"version"`
	Agents  []Agent `json:"agents"` // in creation order
}

// Summary is the part of a RunView that is counted from the tasks, turns and agents.
type Summary struct {
	Turns       int             `json:"turns"`
	TurnRunning int             `json:"turnRunning,omitempty"`
	Counts      model.RunCounts `json:"counts"`
	Cost        *float64        `json:"cost"`
	CostPartial bool            `json:"costPartial,omitempty"`
	Attention   int             `json:"attention"`
	// DeliveryStale: the recorded delivery is of a result the run has moved on from (see
	// Loaded.deliveryStale). Clients are not given that delivery.
	DeliveryStale bool `json:"deliveryStale,omitempty"`
}

// ---- the run in memory ---------------------------------------------------------

// Loaded is a run's recorded state in memory.
type Loaded struct {
	Version int64
	State   State
	Stops   []model.RunStop
	Notes   []model.NotesVersion
	Turns   []Turn
	Tasks   []Task
	ChatOps []model.RunOp
	Agents  []Agent
}

// Apply applies a patch: the one way recorded state changes, when committing and when the journal
// is read again after a crash.
func (l *Loaded) Apply(v int64, p Patch) {
	if p.State != nil {
		l.State = *p.State
	}
	if p.Stops != nil {
		l.Stops = p.Stops
	}
	for _, n := range p.Notes {
		l.Notes = put(l.Notes, n, func(x model.NotesVersion) int { return x.V })
	}
	for _, t := range p.Turns {
		l.Turns = put(l.Turns, t, func(x Turn) int { return x.N })
	}
	for _, t := range p.Tasks {
		l.Tasks = put(l.Tasks, t, func(x Task) string { return x.ID })
	}
	for _, o := range p.ChatOps {
		l.ChatOps = put(l.ChatOps, o, func(x model.RunOp) int { return x.I })
	}
	for _, a := range p.Agents {
		l.Agents = put(l.Agents, a, func(x Agent) string { return x.ID })
	}
	l.Version = v
}

// put replaces the record of list with r's key, or appends r.
func put[T any, K comparable](list []T, r T, key func(T) K) []T {
	k := key(r)
	for i := range list {
		if key(list[i]) == k {
			list[i] = r
			return list
		}
	}
	return append(list, r)
}

// ---- views ---------------------------------------------------------------------

// State is the task's state: its last attempt's outcome, else that attempt's last phase.
func (t Task) State() model.TaskState {
	if len(t.Attempts) == 0 {
		return model.TaskHeld
	}
	a := t.Attempts[len(t.Attempts)-1]
	if a.Outcome != "" {
		return a.Outcome
	}
	if len(a.Phases) == 0 {
		return model.TaskHeld
	}
	return a.Phases[len(a.Phases)-1].K
}

// View is the task as clients get it.
func (t Task) View() model.RunTask {
	v := model.RunTask{ID: t.ID, Title: t.Title, Kind: t.Kind, Writes: t.Writes,
		DependsOn: orEmpty(t.DependsOn), AddedTurn: t.AddedTurn, AddedBy: t.AddedBy, CreatedAt: t.CreatedAt,
		ChangedTurns: orEmpty(t.ChangedTurns), BriefRev: t.BriefRev, Briefs: orEmpty(t.Briefs),
		Attempts: make([]model.RunAttempt, 0, len(t.Attempts)),
		Tier:     tierOr(t.Tier), TierReason: t.TierReason, NeedsReport: orEmpty(t.NeedsReport)}
	for _, a := range t.Attempts {
		w := a.RunAttempt
		w.Phases = orEmpty(w.Phases)
		if w.Tier == "" {
			w.Tier = v.Tier
		}
		v.Attempts = append(v.Attempts, w)
	}
	return v
}

// tierOr is t, and the standard tier for a record that names none.
func tierOr(t model.Tier) model.Tier {
	if t == "" {
		return model.TierStandard
	}
	return t
}

// Live is what a running agent says of itself; it is never recorded.
type Live struct {
	Tools    int
	Activity string
	Cost     *float64 // nil: nothing newer than the record
	// The agent's peak context so far, in tokens; 0 = not known.
	PeakContext int
}

// View is the agent as clients get it, with its live values.
func (a Agent) View(live Live) model.RunAgent {
	v := a.RunAgent
	v.Launches = orEmpty(v.Launches)
	v.Tools, v.Activity = live.Tools, live.Activity
	if live.Cost != nil {
		v.Cost = live.Cost
	}
	if live.PeakContext > v.PeakContext {
		v.PeakContext = live.PeakContext
	}
	return v
}

// Detail is the run's detail as clients get it. live: by agent chat id. The lists are the
// detail's own (the records in them are shared, and never change in place), so it can be sent
// after the run's lock is released.
func (l *Loaded) Detail(run string, live map[string]Live) model.RunDetail {
	d := model.RunDetail{Run: run, Version: l.Version, Status: l.State.Status, StartedAt: l.State.StartedAt,
		EndedAt: l.State.EndedAt, GoalSize: l.State.GoalSize, Stops: copyOf(l.Stops), Turns: copyOf(l.Turns),
		Tasks: make([]model.RunTask, 0, len(l.Tasks)), ChatOps: copyOf(l.ChatOps),
		Agents: make(map[string]model.RunAgent, len(l.Agents)), Notes: copyOf(l.Notes), Result: l.State.Result,
		Delivery: deliveryOf(l.State)}
	if l.deliveryStale() {
		d.Delivery = nil
	}
	if g := l.State.Git; g != nil {
		rg := g.RunGit
		d.Git = &rg
	}
	for _, t := range l.Tasks {
		d.Tasks = append(d.Tasks, t.View())
	}
	for _, a := range l.Agents {
		d.Agents[a.ID] = a.View(live[a.ID])
	}
	return d
}

// WirePatch is an entry's patch as the `run_detail` event carries it. before is the state before
// the entry: the scalar fields are sent only when they changed.
func WirePatch(before State, p Patch, live map[string]Live) model.RunPatch {
	w := model.RunPatch{Stops: p.Stops, Notes: p.Notes, Turns: p.Turns, ChatOps: p.ChatOps}
	if s := p.State; s != nil {
		if s.Status != before.Status {
			w.Status = s.Status
		}
		if s.StartedAt != before.StartedAt {
			w.StartedAt = s.StartedAt
		}
		if s.EndedAt != before.EndedAt {
			w.EndedAt = s.EndedAt
		}
		if s.GoalSize != before.GoalSize {
			w.GoalSize = s.GoalSize
		}
		if s.Git != nil && (before.Git == nil || s.Git.RunGit != before.Git.RunGit) {
			rg := s.Git.RunGit
			w.Git = &rg
		}
		if s.Result != nil && (before.Result == nil || *s.Result != *before.Result) {
			w.Result = s.Result
		}
		// A run that halts again after a resume sends the delivery it had before again.
		if d := deliveryOf(*s); d != nil && !reflect.DeepEqual(d, deliveryOf(before)) {
			w.Delivery = d
		}
	}
	for _, t := range p.Tasks {
		w.Tasks = append(w.Tasks, t.View())
	}
	if len(p.Agents) > 0 {
		w.Agents = make(map[string]model.RunAgent, len(p.Agents))
		for _, a := range p.Agents {
			w.Agents[a.ID] = a.View(live[a.ID])
		}
	}
	return w
}

// deliveryOf is the delivery as clients get it: a copy of the state's, nil for a run that is live
// (its result is still moving) and for one that has none.
func deliveryOf(s State) *model.RunDelivery {
	if s.Delivery == nil || s.Status.Live() {
		return nil
	}
	return cloneDelivery(s.Delivery)
}

// deliveryStale reports whether the recorded delivery is of a result that is no longer the run's:
// an attempt was merged after it was made. That is a halted run whose partial result a person
// applied, and which was resumed and has halted again with more merged; the record keeps the
// delivery (a resume does not clear it), and clients are not given it: the detail and the view
// have none then, as for a halted run nobody tried to apply, and Service.Delivery says what is
// true now. The end of a run records a new delivery, so a run that has ended is never stale.
func (l *Loaded) deliveryStale() bool {
	d := l.State.Delivery
	if d == nil || d.At == 0 {
		return false
	}
	for _, t := range l.Tasks {
		for _, a := range t.Attempts {
			if a.Merged != "" && a.MergedAt > d.At {
				return true
			}
		}
	}
	return false
}

func cloneDelivery(d *model.RunDelivery) *model.RunDelivery {
	if d == nil {
		return nil
	}
	c := *d
	c.Files = slices.Clone(d.Files)
	return &c
}

// Summarize counts the Summary. noCost: this agent kind reports no cost.
func (l *Loaded) Summarize(noCost bool) Summary {
	s := Summary{Turns: len(l.Turns), DeliveryStale: l.deliveryStale()}
	for _, t := range l.Tasks {
		switch t.State() {
		case model.TaskHeld:
			s.Counts.Held++
		case model.TaskDeps:
			s.Counts.Deps++
		case model.TaskBlocked:
			s.Counts.Blocked++
			s.Attention++
		case model.TaskSlot:
			s.Counts.Slot++
		case model.TaskSetup:
			s.Counts.Setup++
		case model.TaskWork:
			s.Counts.Work++
		case model.TaskMerge:
			s.Counts.Merge++
		case model.TaskDone:
			s.Counts.Done++
		case model.TaskFailed:
			s.Counts.Failed++
			s.Attention++
		case model.TaskCancelled:
			s.Counts.Cancelled++
		}
	}
	if n := len(l.Turns); n > 0 {
		last := l.Turns[n-1]
		if last.Status == "running" {
			s.TurnRunning = last.N
		}
		for _, o := range last.Ops {
			if o.Error != "" {
				s.Attention++
			}
		}
	}
	if !noCost {
		sum := 0.0
		for _, a := range l.Agents {
			if a.Cost != nil {
				sum += *a.Cost
			} else if a.Status != model.AgentRunning {
				s.CostPartial = true
			}
			if a.CostLost {
				s.CostPartial = true
			}
		}
		s.Cost = &sum
	}
	return s
}

// Facts is what the server finds out about a run's folder when it builds the view.
type Facts struct {
	FolderMissing bool
	Git           bool   // cwd is inside a git work tree
	Blocked       string // why the run cannot start or resume
	Dirty         bool   // a run that has not started, in a git folder: it has uncommitted changes or untracked files
	// What svcDefaultTiers gives a run of this kind and group now; a run that has not started only.
	TierDefaults model.RunTiers
}

// ViewOf is the run as the sidebar and the meters get it. st is nil for a run that has not started.
func ViewOf(m model.RunMeta, st *State, sum Summary, f Facts) model.RunView {
	v := model.RunView{ID: m.ID, Name: m.Name, UserNamed: m.UserNamed, Group: m.Group, Created: m.Created,
		Agent: m.Agent, Tiers: m.Tiers, Cwd: m.Cwd, FolderMissing: f.FolderMissing,
		Git: f.Git, Blocked: f.Blocked, Settings: m.Settings, Draft: m.Draft, Started: m.Started,
		Archive: m.Archive, Status: model.RunDraft, Turns: sum.Turns, TurnRunning: sum.TurnRunning,
		Counts: sum.Counts, Cost: sum.Cost, CostPartial: sum.CostPartial, Attention: sum.Attention}
	if m.Started.IsZero() {
		td := f.TierDefaults
		v.TierDefaults = &td
		v.Dirty = f.Dirty
	}
	if st == nil || m.Started.IsZero() {
		return v
	}
	v.Git = m.Git
	v.Wait = st.Wait
	v.Status, v.Reason, v.StalledBy = st.Status, st.Reason, st.StalledBy
	v.ActiveMs, v.AsOf, v.IdleStreak = st.ActiveMs, st.AsOf, st.IdleStreak
	if st.Result != nil && st.Status.Final() {
		v.Outcome = st.Result.Outcome
	}
	if d := deliveryOf(*st); d != nil && !sum.DeliveryStale {
		v.Delivery = d.State
	}
	return v
}

func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// copyOf is a copy of s that is never nil.
func copyOf[T any](s []T) []T {
	if len(s) == 0 {
		return []T{}
	}
	return slices.Clone(s)
}

// ---- names -----------------------------------------------------------------------

// AgentChatID is the id of the chat of the run's agent called name ("turn-007", "T03-work",
// "T03-a2-merge"): sha256(run + "/" + name), its first 16 bytes written as a UUID. The same run
// and name give the same id for ever, so making an agent's chat twice finds the first.
func AgentChatID(run, name string) string {
	h := sha256.Sum256([]byte(run + "/" + name))
	return fmt.Sprintf("%x-%x-%x-%x-%x", h[0:4], h[4:6], h[6:8], h[8:10], h[10:16])
}

// TaskID is the id of the n-th task of a run, from 1: "T01", "T02", …, "T100".
func TaskID(n int) string { return fmt.Sprintf("T%02d", n) }

// AttemptPrefix names an attempt in agent names, checkouts and branches: the task's id for
// attempt 1, "<id>-a<n>" from attempt 2 on.
func AttemptPrefix(task string, attempt int) string {
	if attempt <= 1 {
		return task
	}
	return fmt.Sprintf("%s-a%d", task, attempt)
}

// The names of a run's agents. An agent's chat id is AgentChatID(run, name).
func TurnAgentName(turn int) string                  { return fmt.Sprintf("turn-%03d", turn) }
func WorkAgentName(task string, attempt int) string  { return AttemptPrefix(task, attempt) + "-work" }
func MergeAgentName(task string, attempt int) string { return AttemptPrefix(task, attempt) + "-merge" }
