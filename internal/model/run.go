package model

import "time"

// ---- runs -----------------------------------------------------------------
//
// Time format: Created and Started are time.Time (RFC 3339 on the wire), like every sidebar
// record. Every other time is unix milliseconds (fields named T, At, …At, AsOf), like
// Subagent.Started; durations are milliseconds (…Ms).

type RunStatus string

const (
	RunDraft     RunStatus = "draft"     // not started: the composer shows; only run.json exists
	RunRunning   RunStatus = "running"   // the engine works on it
	RunStopping  RunStatus = "stopping"  // a stop was asked for; its agents are being interrupted
	RunStopped   RunStatus = "stopped"   // halted by the user or because the app closed; resumable
	RunStalled   RunStatus = "stalled"   // halted by a limit (StalledBy); resumable
	RunError     RunStatus = "error"     // halted because an orchestrator turn failed; resumable
	RunCompleted RunStatus = "completed" // finish_run with "achieved"; final
	RunGaveUp    RunStatus = "gave_up"   // finish_run with "not_achieved"; final
)

// Started reports whether the goal was sent; Live whether the engine works on it; Final whether
// nothing can change any more.
func (s RunStatus) Started() bool { return s != RunDraft && s != "" }
func (s RunStatus) Live() bool    { return s == RunRunning || s == RunStopping }
func (s RunStatus) Final() bool   { return s == RunCompleted || s == RunGaveUp }

type StalledBy string

const (
	StalledIdle  StalledBy = "idle"
	StalledTurns StalledBy = "turns"
	StalledCost  StalledBy = "cost"
)

type RunOutcome string

const (
	Achieved    RunOutcome = "achieved"
	NotAchieved RunOutcome = "not_achieved"
)

// TaskState is what a task is doing: the kind of its last attempt's last phase, or how that
// attempt ended. The first seven are also the phase kinds.
type TaskState string

const (
	TaskHeld      TaskState = "held"      // waits for the end of the turn (or chat reply) that added or changed it
	TaskDeps      TaskState = "deps"      // waits on dependencies that are not done
	TaskBlocked   TaskState = "blocked"   // a dependency failed or was cancelled
	TaskSlot      TaskState = "slot"      // ready, no free slot
	TaskSetup     TaskState = "setup"     // has a slot: its checkout is made and the setup command runs
	TaskWork      TaskState = "work"      // its agent works
	TaskMerge     TaskState = "merge"     // its work is committed and merged (writing tasks)
	TaskDone      TaskState = "done"      // attempt outcomes: final for the attempt
	TaskFailed    TaskState = "failed"    //
	TaskCancelled TaskState = "cancelled" //
)

// Waiting reports whether s is one of the states before a slot is taken (the script's "pending").
func (s TaskState) Waiting() bool {
	return s == TaskHeld || s == TaskDeps || s == TaskBlocked || s == TaskSlot
}

// Active reports whether s holds a slot (the script's "running" and "merging").
func (s TaskState) Active() bool { return s == TaskSetup || s == TaskWork || s == TaskMerge }

// Final reports whether s is an attempt outcome.
func (s TaskState) Final() bool { return s == TaskDone || s == TaskFailed || s == TaskCancelled }

type AgentRole string

const (
	RoleOrchestrator AgentRole = "orchestrator"
	RoleTask         AgentRole = "task"
	RoleMerge        AgentRole = "merge"
)

type RunAgentStatus string

const (
	AgentRunning     RunAgentStatus = "running"
	AgentDone        RunAgentStatus = "done"
	AgentFailed      RunAgentStatus = "failed"      // its launches are used up, or a launch failed fatally
	AgentInterrupted RunAgentStatus = "interrupted" // the run halted while it worked; a resume continues it
	AgentCancelled   RunAgentStatus = "cancelled"   // its task was cancelled
)

// Tier is how capable an agent a task gets: each tier of a run is a model and an effort.
type Tier string

const (
	TierDeep     Tier = "deep"
	TierStandard Tier = "standard"
	TierLight    Tier = "light"

	// TierOrchestrator is not a tier a task can have: it is what an orchestrator turn is recorded
	// with in a run whose orchestrator has a model of its own (RunTiers.Orchestrator).
	TierOrchestrator Tier = "orchestrator"

	MergeTier = TierStandard // every merge agent
)

// Tiers are the tiers, most capable first.
var Tiers = []Tier{TierDeep, TierStandard, TierLight}

// ValidTier reports whether s names a tier.
func ValidTier(s string) bool {
	for _, t := range Tiers {
		if string(t) == s {
			return true
		}
	}
	return false
}

// RunTiers is what each tier runs on. A struct, so all three keys are always sent.
type RunTiers struct {
	Deep     ModelChoice `json:"deep"`
	Standard ModelChoice `json:"standard"`
	Light    ModelChoice `json:"light"`
	// Orchestrator is what the orchestrator's turns run on. Without a model (as in every run made
	// before it could be chosen) the orchestrator runs on the deep tier.
	Orchestrator ModelChoice `json:"orchestrator,omitzero"`
}

// OrchestratorTier is the tier an orchestrator turn is recorded with: TierOrchestrator when the
// orchestrator has a model of its own, else the deep tier it runs on.
func (t RunTiers) OrchestratorTier() Tier {
	if t.Orchestrator.Model != "" {
		return TierOrchestrator
	}
	return TierDeep
}

// Of is the choice of tier; "" and an unknown tier are the standard one, and the orchestrator's
// is the deep one while it has no model of its own.
func (t RunTiers) Of(tier Tier) ModelChoice {
	switch tier {
	case TierOrchestrator:
		if t.Orchestrator.Model != "" {
			return t.Orchestrator
		}
		return t.Deep
	case TierDeep:
		return t.Deep
	case TierLight:
		return t.Light
	}
	return t.Standard
}

// TokenCount is the tokens of an agent and its subagents.
type TokenCount struct {
	In         int64 `json:"in"`
	Out        int64 `json:"out"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
}

// RunWait is what the orchestrator said it waits for.
type RunWait struct {
	Tasks []string `json:"tasks"` // never null, at least one, no duplicates
	Mode  string   `json:"mode"`  // "all" | "any"
	Turn  int      `json:"turn"`  // the turn that declared it
}

type StopReason string

const (
	StopUser    StopReason = "user"     // Stop, archive
	StopAppQuit StopReason = "app_quit" // the server stopped or died while the run was live
	StopStalled StopReason = "stalled"
	StopError   StopReason = "error"
)

// RunSettings are a run's settings. The composer shows MaxParallel, MaxTurns, MaxCost and Setup;
// the rest keep DefaultRunSettings. All are fixed when the run starts, except that a resume may
// raise MaxTurns or MaxCost.
type RunSettings struct {
	MaxParallel     int     `json:"maxParallel"`             // tasks at once (1–16)
	MaxTurns        int     `json:"maxTurns"`                // orchestrator turns before the run stalls (1–500)
	MaxCost         float64 `json:"maxCost"`                 // USD before the run stalls; 0 = no limit
	Setup           string  `json:"setup,omitempty"`         // shell command run in every new task checkout
	Wake            string  `json:"wake"`                    // "declared": when what the orchestrator waits for ended; "each": after each finished task; "idle": only on a failure and when idle
	MaxIdleTurns    int     `json:"maxIdleTurns"`            // idle turns in a row before the run stalls
	AgentTimeoutSec int     `json:"agentTimeoutSec"`         // one launch of an agent
	AgentRetries    int     `json:"agentRetries"`            // extra counted launches of an agent after a failure
	KeepWorktrees   bool    `json:"keepWorktrees,omitempty"` // keep task checkouts after their task ends
	ApplyResult     string  `json:"applyResult,omitempty"`   // "auto" (default, also ""): apply the result to the folder when the run completes; "manual": only when a person asks
}

// DefaultRunSettings are the script's defaults (T01 §13).
func DefaultRunSettings() RunSettings {
	return RunSettings{MaxParallel: 8, MaxTurns: 60, MaxCost: 0, Wake: "declared", MaxIdleTurns: 3,
		AgentTimeoutSec: 10800, AgentRetries: 2}
}

// RunDefaults is what a new run in a group starts with: the agent and the composer's settings of
// the run started last there. Setup is offered again only for the folder it was used in.
type RunDefaults struct {
	Agent       AgentKind `json:"agent"`
	MaxParallel int       `json:"maxParallel"`
	MaxTurns    int       `json:"maxTurns"`
	MaxCost     float64   `json:"maxCost"`
	Setup       string    `json:"setup,omitempty"`
	SetupCwd    string    `json:"setupCwd,omitempty"`
	Tiers       *RunTiers `json:"tiers,omitempty"` // the tier map of Agent, as the last started run had it
}

// RunMeta is runs/<id>/run.json: the run's identity and what the composer set. A folder without it
// is not a run. Started is the commit point of the start: a run has started exactly when it is set.
type RunMeta struct {
	ID        string      `json:"id"` // "r_" + 8 random base36 chars; the folder name
	Name      string      `json:"name"`
	UserNamed bool        `json:"userNamed,omitempty"`
	Group     string      `json:"group"` // group id or Ungrouped
	Created   time.Time   `json:"created"`
	Agent     AgentKind   `json:"agent"` // one agent kind for every agent of the run
	Tiers     RunTiers    `json:"tiers"` // the model and effort of each tier
	Cwd       string      `json:"cwd"`
	Settings  RunSettings `json:"settings"`
	Draft     *Draft      `json:"draft,omitempty"`  // the goal being typed; cleared by the start
	Started   time.Time   `json:"started,omitzero"` // when the goal was sent
	Git       bool        `json:"git,omitempty"`    // set by the start: the run uses git (cwd was inside a work tree)
	Client    string      `json:"client,omitempty"` // the client mark: the client id of the API client whose start call made the run; never changes
	// Server is a draft's server: the id of an entry of the server list, "" for this computer.
	Server string `json:"server,omitempty"`
	// RemoteStart is "" or RemoteUnconfirmed: the start on the draft's server got no answer.
	RemoteStart string `json:"remoteStart,omitempty"`
	Archive
}

// RunCounts is the run's tasks by state.
type RunCounts struct {
	Held      int `json:"held"`
	Deps      int `json:"deps"`
	Blocked   int `json:"blocked"`
	Slot      int `json:"slot"`
	Setup     int `json:"setup"`
	Work      int `json:"work"`
	Merge     int `json:"merge"`
	Done      int `json:"done"`
	Failed    int `json:"failed"`
	Cancelled int `json:"cancelled"`
}

// RunView is what clients see of a run in the snapshot, in `run` events and in the answer of the
// run routes: enough for the sidebar row, the run bar and the meters. It changes at task and turn
// boundaries, never per agent event.
type RunView struct {
	ID            string      `json:"id"`
	Name          string      `json:"name"`
	UserNamed     bool        `json:"userNamed,omitempty"`
	Group         string      `json:"group"`
	Created       time.Time   `json:"created"`
	Agent         AgentKind   `json:"agent"`
	Tiers         RunTiers    `json:"tiers"`
	TierDefaults  *RunTiers   `json:"tierDefaults,omitempty"` // a draft only: what "Reset to the defaults" sets
	Wait          *RunWait    `json:"wait,omitempty"`         // the run's current wait; absent = none
	Cwd           string      `json:"cwd"`
	FolderMissing bool        `json:"folderMissing,omitempty"`
	Git           bool        `json:"git,omitempty"`     // cwd is inside a git work tree
	Blocked       string      `json:"blocked,omitempty"` // why the run cannot start or resume as set up
	Dirty         bool        `json:"dirty,omitempty"`   // a draft only: the git folder has uncommitted changes
	Settings      RunSettings `json:"settings"`
	Draft         *Draft      `json:"draft,omitempty"`
	Started       time.Time   `json:"started,omitzero"`
	Archive

	Status      RunStatus  `json:"status"`
	Reason      string     `json:"reason,omitempty"`    // stopped, stalled, error: why, one sentence
	StalledBy   StalledBy  `json:"stalledBy,omitempty"` // stalled only
	Outcome     RunOutcome `json:"outcome,omitempty"`   // completed, gave_up
	ActiveMs    int64      `json:"activeMs"`            // working time up to AsOf, stops left out
	AsOf        int64      `json:"asOf"`                // set when the run starts, halts, resumes or ends
	Turns       int        `json:"turns"`
	TurnRunning int        `json:"turnRunning,omitempty"`
	IdleStreak  int        `json:"idleStreak"`
	Counts      RunCounts  `json:"counts"`
	Cost        *float64   `json:"cost"` // nil (null): this agent kind reports no cost
	CostPartial bool       `json:"costPartial,omitempty"`
	Attention   int        `json:"attention"` // failed + blocked tasks + refused calls in the latest turn

	Delivery RunDeliveryState `json:"delivery,omitempty"` // where the result is; absent for a draft and for a live run

	Server string `json:"server,omitempty"` // the entry id of the run's server; absent = this computer
	Start  string `json:"start,omitempty"`  // "unconfirmed": a start got no answer (a draft only)
	Gone   bool   `json:"gone,omitempty"`   // a remote run its server no longer has
	Was    string `json:"was,omitempty"`    // only in the events and the answer of Reissue: the id the draft had
}

// ---- run detail: GET /api/runs/{id}/detail and `run_detail` events ---------

type RunDetail struct {
	Run       string              `json:"run"`
	Version   int64               `json:"version"` // the number of the journal entry it is current to
	Status    RunStatus           `json:"status"`
	StartedAt int64               `json:"startedAt"`
	EndedAt   int64               `json:"endedAt,omitempty"` // completed and gave_up only
	GoalSize  int                 `json:"goalSize"`
	Git       *RunGit             `json:"git,omitempty"`
	Stops     []RunStop           `json:"stops"`   // never null
	Turns     []RunTurn           `json:"turns"`   // by N; never null
	Tasks     []RunTask           `json:"tasks"`   // in creation order; never null
	ChatOps   []RunOp             `json:"chatOps"` // by I; never null
	Agents    map[string]RunAgent `json:"agents"`  // key: chat id; never null
	Notes     []NotesVersion      `json:"notes"`   // by V; never null
	Result    *RunResult          `json:"result,omitempty"`
	Delivery  *RunDelivery        `json:"delivery,omitempty"` // absent for a draft and for a live run
}

// RunPatch is the patch of a `run_detail` event: the records a change touched. Scalars replace;
// Stops is the whole list; Turns, Tasks, ChatOps and Notes replace the record with the same key or
// add it; Agents are merged by id. Nothing is ever removed.
type RunPatch struct {
	Status    RunStatus           `json:"status,omitempty"`
	StartedAt int64               `json:"startedAt,omitempty"`
	EndedAt   int64               `json:"endedAt,omitempty"`
	GoalSize  int                 `json:"goalSize,omitempty"`
	Git       *RunGit             `json:"git,omitempty"`
	Stops     []RunStop           `json:"stops,omitempty"`
	Turns     []RunTurn           `json:"turns,omitempty"`
	Tasks     []RunTask           `json:"tasks,omitempty"`
	ChatOps   []RunOp             `json:"chatOps,omitempty"`
	Agents    map[string]RunAgent `json:"agents,omitempty"`
	Notes     []NotesVersion      `json:"notes,omitempty"`
	Result    *RunResult          `json:"result,omitempty"`
	Delivery  *RunDelivery        `json:"delivery,omitempty"`
}

type RunGit struct {
	BaseRef           string `json:"baseRef"`           // the commit the run started from
	IntegrationBranch string `json:"integrationBranch"` // where finished work is merged
	ResultHead        string `json:"resultHead,omitempty"`
	Branch            string `json:"branch,omitempty"`       // the folder's branch when the run started; "" when detached
	DirtyAtStart      bool   `json:"dirtyAtStart,omitempty"` // the folder had uncommitted changes when the run started; the run does not see them
}

type RunStop struct {
	At        int64      `json:"at"`
	ResumedAt int64      `json:"resumedAt,omitempty"` // 0: the run is halted here
	Reason    StopReason `json:"reason"`
	StalledBy StalledBy  `json:"stalledBy,omitempty"` // a stop at a limit: which one
}

type RunResult struct {
	Outcome RunOutcome `json:"outcome"`
	Summary string     `json:"summary"`
	Turn    int        `json:"turn"`
	At      int64      `json:"at"`
}

// RunEvent is something the orchestrator is told about.
type RunEvent struct {
	Seq  int    `json:"seq"` // 1, 2, …; never reused
	T    int64  `json:"t"`
	Type string `json:"type"`           // "task_done" | "task_failed" | "chat_op"
	Task string `json:"task,omitempty"` //
	Chat string `json:"chat,omitempty"` // chat_op: the chat that made the change
	Text string `json:"text"`           // at most 600 characters; a tell_orchestrator message: 4,000
}

// RunOp is one call of a run tool: by the orchestrator in a turn (RunTurn.Ops; reads included), or
// by a chat on the run outside a turn (RunDetail.ChatOps; changes only).
type RunOp struct {
	I            int        `json:"i"` // its index in RunTurn.Ops or RunDetail.ChatOps
	T            int64      `json:"t"`
	Op           string     `json:"op"`              // the tool's name
	Chat         string     `json:"chat,omitempty"`  // ChatOps only
	Turn         int        `json:"turn,omitempty"`  // ChatOps only: the latest turn at that moment
	Error        string     `json:"error,omitempty"` // refused: the refusal, at most 400 characters
	Task         string     `json:"task,omitempty"`
	Agent        string     `json:"agent,omitempty"` // get_agent: the agent's name
	Title        string     `json:"title,omitempty"`
	Kind         string     `json:"kind,omitempty"`
	Writes       *bool      `json:"writes,omitempty"`
	DependsOn    []string   `json:"dependsOn,omitempty"` // add_task, update_task: the list after the call
	Changed      []string   `json:"changed,omitempty"`
	BriefRev     int        `json:"briefRev,omitempty"`
	Reason       string     `json:"reason,omitempty"`
	Attempt      int        `json:"attempt,omitempty"`
	NotesVersion int        `json:"notesVersion,omitempty"`
	Size         int        `json:"size,omitempty"`
	Outcome      RunOutcome `json:"outcome,omitempty"`
	Text         string     `json:"text,omitempty"`        // tell_orchestrator, finish_run's summary; at most 600 characters
	Tier         Tier       `json:"tier,omitempty"`        // add_task, update_task, retry_task: the tier after the call
	TierReason   string     `json:"tierReason,omitempty"`  // add_task; at most 300 characters
	NeedsReport  []string   `json:"needsReport,omitempty"` // add_task, update_task: the list after the call
	Heading      string     `json:"heading,omitempty"`     // edit_notes; at most 120 characters
	Tasks        []string   `json:"tasks,omitempty"`       // wait_for
	Mode         string     `json:"mode,omitempty"`        // wait_for
}

type RunTurn struct {
	N         int        `json:"n"`
	Agent     string     `json:"agent"`  // its agent's chat id
	Reason    string     `json:"reason"` // "start" | "wait" | "events" | "idle" | "resume"
	Idle      bool       `json:"idle,omitempty"`
	Status    string     `json:"status"` // "running" | "done" | "failed"
	StartedAt int64      `json:"startedAt"`
	EndedAt   int64      `json:"endedAt,omitempty"`
	WokenBy   []RunEvent `json:"wokenBy"` // never null
	Learned   []RunEvent `json:"learned"` // never null
	Ops       []RunOp    `json:"ops"`     // never null
	Summary   string     `json:"summary,omitempty"`
	Error     string     `json:"error,omitempty"`
	Cost      *float64   `json:"cost"`
	Wait      *RunWait   `json:"wait,omitempty"`    // the wait it started under
	WaitMet   bool       `json:"waitMet,omitempty"` // that wait was met when the turn started
}

type BriefRev struct {
	Rev  int    `json:"rev"`
	At   int64  `json:"at"`
	Turn int    `json:"turn,omitempty"`
	Chat string `json:"chat,omitempty"`
	Size int    `json:"size"`
}

type RunTask struct {
	ID           string       `json:"id"` // "T01", "T02", …: "T" + the creation index, at least two digits
	Title        string       `json:"title"`
	Kind         string       `json:"kind"`
	Writes       bool         `json:"writes"`
	DependsOn    []string     `json:"dependsOn"` // never null
	AddedTurn    int          `json:"addedTurn"` // for a task a chat added: the latest turn then
	AddedBy      string       `json:"addedBy,omitempty"`
	CreatedAt    int64        `json:"createdAt"`
	ChangedTurns []int        `json:"changedTurns"` // never null
	BriefRev     int          `json:"briefRev"`
	Briefs       []BriefRev   `json:"briefs"`
	Attempts     []RunAttempt `json:"attempts"`
	Tier         Tier         `json:"tier"`
	TierReason   string       `json:"tierReason"`
	NeedsReport  []string     `json:"needsReport"` // never null; a subset of DependsOn
}

type RunPhase struct {
	K    TaskState `json:"k"` // one of the seven phase kinds
	T    int64     `json:"t"`
	On   []string  `json:"on,omitempty"`   // deps, blocked
	Turn int       `json:"turn,omitempty"` // held
	Chat string    `json:"chat,omitempty"` // held
}

// AttemptResult is the agent's own result block.
type AttemptResult struct {
	Outcome    string `json:"outcome"` // "completed" | "failed"
	Summary    string `json:"summary"`
	ReportSize int    `json:"reportSize"` // characters of the report (tasks/<id>/a<n>.report.md)
}

type AttemptCancel struct {
	T      int64  `json:"t"`
	Reason string `json:"reason"`
	Turn   int    `json:"turn,omitempty"`
	Chat   string `json:"chat,omitempty"`
}

type AttemptAgents struct {
	Work  string `json:"work,omitempty"`  // chat ids
	Merge string `json:"merge,omitempty"` //
}

type RunAttempt struct {
	N          int            `json:"n"`
	QueuedTurn int            `json:"queuedTurn"`
	QueuedBy   string         `json:"queuedBy,omitempty"`
	QueuedAt   int64          `json:"queuedAt"`
	Phases     []RunPhase     `json:"phases"` // never null
	StartedAt  int64          `json:"startedAt,omitempty"`
	EndedAt    int64          `json:"endedAt,omitempty"`
	Outcome    TaskState      `json:"outcome,omitempty"` // "done" | "failed" | "cancelled"
	Error      string         `json:"error,omitempty"`
	Cancel     *AttemptCancel `json:"cancel,omitempty"`
	Result     *AttemptResult `json:"result,omitempty"` // set = the work agent returned its result
	MergedAt   int64          `json:"mergedAt,omitempty"`
	Conflicts  []string       `json:"conflicts,omitempty"`
	Agents     AttemptAgents  `json:"agents"`
	Cost       *float64       `json:"cost"`
	Branch     string         `json:"branch,omitempty"`
	Base       string         `json:"base,omitempty"`   // set = the attempt was started
	Head       string         `json:"head,omitempty"`   // set = its work is committed
	Merged     string         `json:"merged,omitempty"` // set = merged
	Tier       Tier           `json:"tier"`             // the tier it runs or ran on
}

type RunLaunch struct {
	N         int    `json:"n"`
	StartedAt int64  `json:"startedAt"`
	EndedAt   int64  `json:"endedAt,omitempty"`
	Resume    bool   `json:"resume"`
	Error     string `json:"error,omitempty"`
}

// RunAgent is one agent of a run. Its transcript is the chat with this id.
type RunAgent struct {
	ID        string         `json:"id"`   // its chat id
	Name      string         `json:"name"` // "turn-007", "T03-work", "T03-a2-work", "T03-merge"
	Role      AgentRole      `json:"role"`
	Task      string         `json:"task,omitempty"`
	Attempt   int            `json:"attempt,omitempty"`
	Turn      int            `json:"turn,omitempty"`
	Status    RunAgentStatus `json:"status"`
	StartedAt int64          `json:"startedAt"`
	EndedAt   int64          `json:"endedAt,omitempty"`
	Launches  []RunLaunch    `json:"launches"` // never null
	Error     string         `json:"error,omitempty"`
	Cost      *float64       `json:"cost"`
	Tier      Tier           `json:"tier"`
	Model     string         `json:"model"`            // fixed when the record is made
	Effort    string         `json:"effort,omitempty"` //
	Tokens    *TokenCount    `json:"tokens"`           // null: nothing reported (always for Cursor)
	// The largest context a request of the agent was made with, in tokens; 0 = not known.
	PeakContext int `json:"peakContext,omitempty"`
	// Not recorded: filled in from the live agent when a record is sent.
	Tools    int    `json:"tools,omitempty"`
	Activity string `json:"activity,omitempty"`
}

type NotesVersion struct {
	V    int    `json:"v"`
	At   int64  `json:"at"`
	Turn int    `json:"turn,omitempty"`
	Chat string `json:"chat,omitempty"`
	Size int    `json:"size"`
}

// RunActivity is one agent's part of a `run_activity` event.
type RunActivity struct {
	Activity string   `json:"activity,omitempty"`
	Tools    int      `json:"tools,omitempty"`
	Cost     *float64 `json:"cost,omitempty"`
	// The agent's peak context so far, in tokens.
	PeakContext int `json:"peakContext,omitempty"`
}

// ---- loaded on demand ------------------------------------------------------

// RunGoal is the answer of GET /api/runs/{id}/goal.
type RunGoal struct {
	Text string `json:"text"`
}

// TaskBrief is the answer of GET /api/runs/{id}/tasks/{tid}/brief.
type TaskBrief struct {
	BriefRev
	Task string `json:"task"`
	Text string `json:"text"`
}

// AttemptReport is the answer of GET /api/runs/{id}/tasks/{tid}/attempts/{n}/report.
type AttemptReport struct {
	Task    string `json:"task"`
	Attempt int    `json:"attempt"`
	Outcome string `json:"outcome"`
	Summary string `json:"summary"`
	Report  string `json:"report"`
}

// AttemptChanges is tasks/<id>/a<n>.changes.json and the answer of
// GET /api/runs/{id}/tasks/{tid}/attempts/{n}/changes.
type AttemptChanges struct {
	Task      string        `json:"task"`
	Attempt   int           `json:"attempt"`
	Branch    string        `json:"branch"`
	Base      string        `json:"base"`
	Head      string        `json:"head"`
	Merged    string        `json:"merged,omitempty"`
	MergedAt  int64         `json:"mergedAt,omitempty"`
	Files     []ChangedFile `json:"files"`
	Add       int           `json:"add"`
	Del       int           `json:"del"`
	Commits   []Commit      `json:"commits"`
	Conflicts []string      `json:"conflicts,omitempty"`
}

type ChangedFile struct {
	Path   string `json:"path"`
	Add    int    `json:"add"`
	Del    int    `json:"del"`
	Binary bool   `json:"binary,omitempty"`
}

type Commit struct {
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
	At      int64  `json:"at"`
}

// RunNotes is the answer of GET /api/runs/{id}/notes/{v}.
type RunNotes struct {
	NotesVersion
	Text string `json:"text"`
}
