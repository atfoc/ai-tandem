package runs

import (
	"fmt"
	"strings"

	"ai-whiteboard/internal/model"
)

// This file is every message the engine sends to an agent. The builders are pure: they get the
// texts (goal, brief, notes, snapshot, reports) and return the message. An agent cannot read the
// run's folder, so nothing here names a path under the app's data folder or a file of the run:
// what an agent needs of the run is in the message itself, or in a readable copy (ctx.go) whose
// path the caller hands in.

// The inline budgets, in characters.
const (
	engGoalBudget    = 20_000 // the goal in a task prompt
	engBriefBudget   = 20_000 // the brief in a merge prompt
	engReportsBudget = 60_000 // the dependency reports put whole in one task prompt, together
	engReportCutMin  = 4_000  // a report that does not fit and has no readable copy is cut only to this much or more
)

// engCutAtLine cuts text to at most max characters, at the end of a line when it has one in that
// part. cut reports whether anything was left out; kept and total are character counts.
func engCutAtLine(text string, max int) (out string, kept, total int, cut bool) {
	r := []rune(text)
	if len(r) <= max {
		return text, len(r), len(r), false
	}
	if max < 0 {
		max = 0
	}
	part := r[:max]
	for i := len(part) - 1; i > 0; i-- {
		if part[i] == '\n' {
			part = part[:i]
			break
		}
	}
	return string(part), len(part), len(r), true
}

// engOneLine is text on one line: every run of white space becomes one space.
func engOneLine(text string) string { return strings.Join(strings.Fields(text), " ") }

// engRunToolsNote tells an agent where the run tools are. A CLI lists them under the name of the
// app's MCP server, and has tools of its own with names very like theirs: an agent told only "call
// get_task" has called its CLI's task tool instead, which answers "Task not found". The texts name
// the tools bare everywhere else. It stands in the orchestrator's prompt and in the context block
// of a chat on a run (plain there: toolRunToolsNote).
const engRunToolsNote = "The run tools are MCP tools of the app's server named `board`. In your tool list their names may carry that server's prefix (for example `mcp__board__get_task`). They are not your CLI's own task or todo tools (such as `TaskGet`, `TaskCreate`, `TaskList`, `TaskUpdate`, `TodoWrite`), which know nothing about this run."

// ---- the orchestrator ---------------------------------------------------------

// engOrchPrompt is what the orchestrator's prompt is built from.
type engOrchPrompt struct {
	Turn         int
	Goal         string
	Reason       string           // the turn's reason: start, wait, events, idle or resume
	Events       []string         // the event lines of the turn's WokenBy, then of its Learned
	Halt         model.StopReason // resume: the reason of the stop the run was resumed from
	StalledBy    model.StalledBy  // resume from a stop at a limit: which limit; "" when it is not recorded
	Dirty        bool             // start: the folder had uncommitted changes
	IdleStreak   int
	MaxIdleTurns int
	Notes        string
	Snapshot     string // the get_run text
	Git          bool
	Sub          string // git: the run's folder below the repository's top level
	MaxParallel  int
	Wake         string // declared, each or idle

	Tiers         model.RunTiers
	MaxTurns      int
	Idle          bool           // nothing was running and nothing could start when the turn began
	Wait          *model.RunWait // the wait the turn started under; nil = none
	WaitMet       bool           // that wait was met when the turn started
	WokenByChat   bool           // a chat's change or message is among what started the turn
	ReportsByPath bool           // a task's agent can read the reports, the goal and the briefs as files; one that does not fit its prompt is given so
	ManualApply   bool           // git: the result is applied to the person's folder only when the person asks
}

// The three tiers as the orchestrator's prompt and a chat's context describe them.
var engTierWhat = [...]struct {
	tier model.Tier
	what string
}{
	{model.TierDeep, "the result is a decision that other work is built on (a design, a contract, a review), or nothing after it checks it."},
	{model.TierStandard, "work from a precise brief, whose result a build, a test or a later task checks."},
	{model.TierLight, "gathering facts, taking inventory or following a recipe: cheap to do again if it is wrong."},
}

// engTierLines is one line for each tier: its name, what it runs on and what it is for. mark is
// put around the name: "`" in a prompt, "" in a chat's context block.
func engTierLines(t model.RunTiers, mark string) string {
	var out []string
	for _, x := range engTierWhat {
		mc := t.Of(x.tier)
		effort := mc.Effort
		if effort == "" {
			effort = "default"
		}
		out = append(out, fmt.Sprintf("  - %s%s%s (%s, %s effort): %s", mark, x.tier, mark, mc.Model, effort, x.what))
	}
	return strings.Join(out, "\n")
}

// engWaited is what a turn that started under a wait is told first: what was asked for, and
// whether it happened or what started the turn before it.
func engWaited(p engOrchPrompt) string {
	w := p.Wait
	mode := "all"
	if w.Mode == "any" {
		mode = "any"
	}
	asked := fmt.Sprintf("The instance of turn %d asked to be started again when %s of %s had ended. ", w.Turn, mode, strings.Join(w.Tasks, ", "))
	if p.WaitMet {
		return asked + "That has happened."
	}
	early := "a task failed"
	switch {
	case p.Reason == "resume":
		early = "the person resumed the run after a halt"
	case p.Idle:
		early = "nothing is left running"
	case p.WokenByChat:
		early = "a chat on the run changed it or left a message"
	}
	return asked + fmt.Sprintf("This instance is started before that, because %s.", early)
}

// engHaltWords says why the run was halted, for a turn that follows a person's resume. by is the
// limit of a stop at one; idle is how many turns in a row with nothing running stop a run.
func engHaltWords(r model.StopReason, by model.StalledBy, idle int) string {
	switch r {
	case model.StopStalled:
		switch by {
		case model.StalledTurns:
			return "it had reached the limit of orchestrator turns"
		case model.StalledCost:
			return "it had reached the cost limit"
		case model.StalledIdle:
			return fmt.Sprintf("the orchestrator was started %s in a row with nothing running", toolCount(idle, "time"))
		}
		return "it had reached a limit"
	case model.StopError:
		return "an orchestrator turn had failed"
	case model.StopAppQuit:
		return "the app was closed"
	}
	return "stopped by the person who started it"
}

func engWhy(p engOrchPrompt) string {
	lines := strings.Join(p.Events, "\n")
	var why string
	switch p.Reason {
	case "start":
		why = "This is the first turn. Nothing has happened yet: there are no tasks and no notes."
		if lines != "" {
			why = "This is the first turn. There are no notes yet."
		}
		if p.Dirty {
			why += " The folder had uncommitted changes when the run started. The run started from the last commit and does not see them, and the result can only be applied to the folder where it does not touch the files they are in. If the goal depends on them, say so in the notes and in your final message."
		}
		if lines != "" {
			why += "\n\nSince the run started:\n\n" + lines
		}
	case "resume":
		why = fmt.Sprintf("The run was halted (%s) and the person who started it resumed it.", engHaltWords(p.Halt, p.StalledBy, p.MaxIdleTurns))
		if lines != "" {
			why += "\n\nSince the last orchestrator turn:\n\n" + lines
		}
	default:
		if lines == "" {
			lines = "- nothing new"
		}
		why = "Since the last orchestrator turn:\n\n" + lines
	}
	if p.Idle && p.Reason != "start" {
		why += "\n\nNothing is running and nothing can start. The run only moves again if you add work, unblock or retry a task, or finish the run."
		if engIdleTurn(p.Reason, p.Idle) && p.IdleStreak > 1 {
			why += fmt.Sprintf(" This is turn %d in a row that began this way; after %d the run is stopped as stalled.", p.IdleStreak, p.MaxIdleTurns)
		}
	}
	if p.Wait != nil {
		why = engWaited(p) + "\n\n" + why
	}
	return why
}

// engOrchestratorPrompt is the first message of an orchestrator turn.
func engOrchestratorPrompt(p engOrchPrompt) string {
	notes := strings.TrimSpace(p.Notes)
	if notes == "" {
		notes = "(empty)"
	}
	var where, gets, writes, starts, result string
	thing, verified := "repository", "the merged result"
	if p.Git {
		where = "Your working directory is a checkout of the integration branch, where the finished work of every task that changes the repository is merged; read it when you need to see the code as it stands."
		if p.Sub != "" {
			where += fmt.Sprintf(" The run was started in its folder `%s`: every task's agent starts in that folder of its own checkout and can read and change the whole repository. Give paths in a brief from the top of the repository.", p.Sub)
		}
		gets = "a checkout of the repository"
		writes = "A task either changes the repository (`writes: true`) or only reports (`writes: false`). A writing task works in its own git worktree, branched from the integration branch at the moment it starts, and its changes are committed and merged into the integration branch when it finishes. A reporting task works in a scratch checkout that is thrown away; its report is its whole result. Investigation, design, review and verification are reporting tasks."
		starts = fmt.Sprintf("A task starts by itself once every task it depends on is done, up to %d at a time. It then sees the work of its dependencies and of anything else merged before it started. Tasks you add or change in this turn start when your turn ends.", p.MaxParallel)
		applied := "When you finish the run as `achieved`, the app brings the result into that folder if it can do so without touching the person's own uncommitted work; otherwise, and after `not_achieved`, the person applies it with one action."
		if p.ManualApply {
			applied = "When the run has ended, the person applies the result to that folder with one action."
		}
		result = "\n- The integration branch is not the folder the person works in. " + applied + " Nothing is applied while the run is going. Never give a task the job of changing the person's folder, and add no task to deliver, merge or push the result."
	} else {
		thing, verified = "folder", "the result"
		where = "Your working directory is the run's folder itself, where every task works; read it when you need to see the files as they stand."
		gets = "the run's folder to work in"
		writes = "A task either changes the folder (`writes: true`) or only reports (`writes: false`). The run's folder is not a git repository, so there are no separate checkouts and nothing is merged: every agent works directly in the folder. Writing tasks run one at a time. A reporting task must not change files, and it may run while a writing task is changing them, so a task that checks a writing task's work must depend on it. Investigation, design, review and verification are reporting tasks. Nothing is undone: what a task changed stays in the folder when it fails or is cancelled, and a retried task finds it there."
		starts = fmt.Sprintf("A task starts by itself once every task it depends on is done, up to %d at a time. It then sees the folder as the tasks before it left it. Tasks you add or change in this turn start when your turn ends.", p.MaxParallel)
	}
	fits := "cut, so the brief must carry what the task cannot do without."
	others, also := "", "It also gets the goal, for context only."
	if p.ReportsByPath {
		fits = "given to it as a file to read."
		others = " (it can open the other reports as files when a summary leaves it short)"
		also = "It can also read the goal and the other briefs, for context only."
	}
	ending := "When the run is the way you want it, end with a short message for the person watching: what you learned, what you changed in the run and why, and what you expect to happen next."
	var wake string
	switch p.Wake {
	case "each":
		wake = "You are started again whenever a task finishes or fails, and when the person changes the run or leaves a message through a chat"
	case "idle":
		wake = "You are started again when a task fails, when nothing is left running, and when the person changes the run or leaves a message through a chat"
	default:
		wake = "You say when you are started again: `wait_for` names the tasks whose results you need before you can decide anything more, and the next instance starts when they have ended. One also starts whenever a task fails, when nothing is left running, and when the person changes the run or leaves a message through a chat"
		ending = fmt.Sprintf("Before you end, call `wait_for` with the tasks whose results the next decision depends on, unless nothing is pending or running. Wait for all the tasks of a stage rather than for each one: without `wait_for` an instance is started after every task that finishes, and the run is stopped after %s.\n\n", toolCount(p.MaxTurns, "turn")) + ending
	}
	return fmt.Sprintf(`You are the orchestrator of an automated build run. Someone gave the run the goal below and left; nobody is available to answer questions. The run reaches that goal through tasks, each carried out by a separate agent, and your job is to decide what those tasks are. You do none of the work yourself: you cannot change the %s, and whatever you want investigated, built, checked or fixed has to become a task.

You are one in a series of orchestrator instances. An instance is started when something in the run changes; it looks at where the run stands, edits the run through the run tools (`+"`get_run`, `add_task`"+` and the others of the `+"`board`"+` server), and ends. You remember nothing of the earlier instances. What carries over is the run itself: its tasks and their reports, the notes, and the record of earlier turns. This is turn %d.

`+engRunToolsNote+`

# Goal

<goal>
%s
</goal>

# Why you were started

%s

# Notes

%s

# The run right now

<run>
%s
</run>

`+"`get_run`"+` returns this again, up to date, and `+"`get_notes`"+` returns the notes. `+"`get_task`"+` gives everything about one task, including its brief and its full report, and `+"`get_agent`"+` shows what an agent has been doing. %s The run keeps its own records where you cannot read them as files: everything about the run comes through these tools.

# How the run works

- A task is one job for one agent. That agent starts from nothing: it gets the task's brief, the summary of each task it depends on, the full reports of those you name in `+"`needs_report`"+`%s, and %s. It cannot ask you or anyone else a question, and it cannot see or change the run. %s Reports are put in its prompt whole up to %s characters together, in the order of `+"`depends_on`"+`; one that does not fit is %s
- Every task has a tier, which decides how capable an agent it gets and what it costs:
%s
- %s
- %s
- A task that is done is final. To build on it, correct it or check it, add another task that depends on it. A pending task can be changed, a running one cancelled, and a failed or cancelled one changed and retried.
- %s. You never need to wait or poll: end your turn and the run carries on.
- The person who started the run can change tasks, or leave you a message, through a chat on the run. What they did is listed under "Why you were started" and in `+"`get_run`"+`. A message from them is an instruction about the goal: follow it and record it in the notes.%s

# How to decide

Work from evidence. The task reports and the code are the facts; the notes are what earlier instances made of them. Read the reports of the tasks that finished since the last turn before building on them, and when a task failed, find out why (`+"`get_task`, `get_agent`"+`) before deciding whether to retry it with a better brief, replace it, or change course.

Do not rush to a solution. A task that builds something before the problem is understood produces confident work on the wrong thing, and every later task inherits the mistake. So the first turns are for understanding: what the goal really asks for, what the %s already has, what is unknown, what "done" means here and how it will be checked. A quick look at the code is yours to take; anything deeper is a reporting task, and several can run side by side. A turn that adds only investigation tasks, or that changes nothing because the running tasks are the right ones, is a good turn. Add tasks that change the %s once the notes can state the definition of done and an approach that the findings support. The tools refuse a writing task while the notes are empty.

Plan as far as you can see and no further. You do not have to lay out the whole run now: add the tasks whose briefs you can write precisely today, and leave the rest to a later instance that will have their results in hand. When what you learn makes a pending task wrong, change it; when it makes one unnecessary, cancel it.

Write briefs for a reader who knows nothing. A brief says what to do and why, what exists that the task builds on (name the files), the exact names, paths and shapes of anything shared with other tasks, what is out of scope, and how the result is to be verified. Tasks with no dependency path between them run at the same time, which is what makes the run fast, so make the graph as wide as it safely can be: two such tasks must not edit the same files or rely on each other's output, and a piece that several tasks need belongs in an earlier task they all depend on.

Keep a task narrow: one package or one area of the code, with the files it works on named. An agent pays for everything it reads before it writes its first line, and again on every step after that, so what makes a task expensive is how much it has to take in, more than how much it has to produce. Quote in the brief the parts of earlier reports that the task needs (the contract, the names, the decision) instead of sending its agent to read them, and name a report in `+"`needs_report`"+` only when the task cannot be done without the whole of it. A task that needs several whole reports, or touches several areas, is two tasks.

Give each task the lowest tier that is safe for it, and say why in `+"`tier_reason`"+`. When you are unsure between two, take the higher. When a task fails, or a review finds real faults in its work, and the brief was not the cause, retry or redo it one tier up.

Nothing is checked unless you ask for it. A report saying that something works is a claim, not evidence. After work lands, add reporting tasks that review it against its brief and verify it against the goal (the build, the tests, the behaviour itself), and add tasks to fix what they find. Size the checking to the risk of the work.

Finish with `+"`finish_run`"+` only when it is true: `+"`achieved`"+` when verification of %s shows that the goal is met, `+"`not_achieved`"+` when it cannot be met and you can say why. Do not finish while a check you asked for is outstanding, and do not keep the run going with work the goal does not need.

# Keeping the notes

The notes are your memory: the next instance knows only what the run and the notes tell it. They should hold, briefly: what the goal requires, the definition of done and how it will be checked, the facts established so far and which task established them, the approach and what is planned next, decisions made and why, and open questions and risks. Give each of these a section of its own (a `+"`##`"+` heading), write the first version with `+"`set_notes`"+`, and after that keep them current with `+"`edit_notes`"+`, which replaces the one section you name and leaves the rest alone. Keep them short and true: every instance reads all of them, so replace what is out of date instead of adding to it, and do not turn them into a log.

# Ending your turn

%s

Rules:
- Do not create, edit or delete files, and do not commit. Change the run only through the run tools.
- You run unattended and cannot ask questions. Where the goal leaves something open, make the most reasonable choice and record it in the notes.`,
		thing, p.Turn, strings.TrimSpace(p.Goal), engWhy(p), notes, p.Snapshot, where, others, gets, also, engThousands(engReportsBudget), fits, engTierLines(p.Tiers, "`"), writes, starts, wake, result,
		thing, thing, verified, ending)
}

// ---- a task -------------------------------------------------------------------

// engWriteRules are the rules that end a task's and a merge agent's prompt.
const engWriteRules = `Rules:
- Work only inside your working directory. Other agents are working at the same time in other
  git worktrees of this repository; never touch anything outside your own.
- Do not commit, push, stash, switch branches or rewrite history.
- You run unattended and cannot ask questions. Where something is unclear, make the most
  reasonable choice and say so in your report.`

// engWriteRulesNoGit are the same rules in a run whose folder is not a git repository.
const engWriteRulesNoGit = `Rules:
- Work only inside your working directory; never touch anything outside it.
- Do not create a git repository in it.
- You run unattended and cannot ask questions. Where something is unclear, make the most
  reasonable choice and say so in your report.`

// engReadRule is the fourth rule of a task agent's prompt, after either set of rules. A merge
// agent is not given it.
const engReadRule = `
- Everything you read stays with you for the rest of the task and is paid for on every step, so read what the task needs and not more. A subagent starts from nothing and has to read the code again: hand one a part only when that part is independent and you do not need what it reads yourself.`

// engWriteRulesSub are engWriteRules for a task whose agent starts in a folder below the top of
// its checkout.
var engWriteRulesSub = strings.Replace(engWriteRules, "Work only inside your working directory.", "Work only inside your worktree.", 1)

// engScope is the three bullets a writing task is told about staying in its lane.
const engScope = `- Build what your brief says and stay inside its scope. Work that belongs to another task will collide with that task's agent.
- Follow the contracts in your brief exactly (names, signatures, paths, data shapes). Other tasks may be written against the same contracts right now.
- Follow the conventions of the code around you, and verify what you built: run the build and the tests your change could affect. Do not assume.`

// engDep is one finished dependency of a task, as its prompt shows it: the last attempt's.
type engDep struct {
	ID, Kind, Title string
	Summary         string
	Needs           bool   // the task names it in needs_report: its report is put in the prompt when it fits
	Report          string // the report's text; read only when Needs
	ReportSize      int    // characters of the report; 0 = it has none
	Path            string // a readable copy of the report; "" = none
	Base, Head      string // a git run's writing dependency whose work is merged: the range of its changes; else ""
}

// engTaskPrompt is what a task agent's prompt is built from.
type engTaskPrompt struct {
	ID, Title string
	Brief     string
	Goal      string
	GoalPath  string   // a readable copy of the goal; "" = none
	BriefsDir string   // the folder of the readable copies of every task's brief (<id>.md); "" = none
	Deps      []engDep // in the order of the task's dependencies
	Writes    bool
	Git       bool
	Sub       string // git: the folder of the checkout the agent starts in, when that is not its top; else ""
}

// engDepReport is what follows a dependency's summary about its report: "" when it has none.
// budget is what is left of engReportsBudget; a report put in the prompt reduces it.
func engDepReport(d engDep, budget *int) string {
	report := strings.TrimSpace(d.Report)
	size := d.ReportSize
	if d.Needs && report != "" {
		size = len([]rune(report))
	}
	switch {
	case size == 0:
		return ""
	case !d.Needs && d.Path != "":
		return fmt.Sprintf("\nIts full report is at %s. Read it only if your brief and this summary leave you short.\n", d.Path)
	case !d.Needs:
		return "\nYou are given its summary only; its full report is not available to you.\n"
	case report != "" && size <= *budget:
		*budget -= size
		return "\n<report>\n" + report + "\n</report>\n"
	case d.Path != "":
		return fmt.Sprintf("\nYou need its full report, which is at %s; read it.\n", d.Path)
	case report == "": // recorded, but its file cannot be read
		return "\nYou are given its summary only; its full report is not available to you.\n"
	case *budget >= engReportCutMin:
		part, kept, all, _ := engCutAtLine(report, *budget)
		*budget -= kept
		return "\n<report>\n" + strings.TrimRight(part, "\n") + fmt.Sprintf("\n[The report is cut here: the first %s of %s characters. The rest is not available to you. If you need what is missing, say so in your report.]", engThousands(kept), engThousands(all)) + "\n</report>\n"
	}
	return fmt.Sprintf("\nIts full report (%s characters) is left out: the reports given to this task are over %s characters together. If you need what is missing, say so in your report.\n", engThousands(size), engThousands(engReportsBudget))
}

// engThousands is n with a comma between its thousands, as the texts write character counts.
func engThousands(n int) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// engDepResults is the "Results of the tasks this one depends on" part: "" without dependencies.
// Every dependency is shown with its summary; a report is put whole only for those the task
// needs (needs_report), in the order of the dependencies, while engReportsBudget lasts.
func engDepResults(deps []engDep, git bool) string {
	if len(deps) == 0 {
		return ""
	}
	budget := engReportsBudget
	parts := make([]string, len(deps))
	for i, d := range deps {
		part := fmt.Sprintf("## %s [%s] %s\n\n%s\n", d.ID, d.Kind, d.Title, d.Summary)
		if git && d.Head != "" && d.Head != d.Base {
			part += fmt.Sprintf("\nIts changes are in your working directory already (`git diff %s..%s` shows them).\n", engSha(d.Base), engSha(d.Head))
		}
		parts[i] = part + engDepReport(d, &budget)
	}
	return "\n# Results of the tasks this one depends on\n\n" + strings.Join(parts, "\n")
}

// engFits is the first part of "Where this fits" in a task prompt: where the agent can read the
// goal and the other tasks' briefs. The goal itself is in it only when it has no readable copy:
// what is put in front of an agent is paid for on every step.
func engFits(goal, goalPath, briefsDir string) string {
	const yours = " Your brief is what you are asked to do; the goal is not."
	switch {
	case goalPath != "" && briefsDir != "":
		return fmt.Sprintf("For context only, you can read the overall goal at %s and the briefs of the other tasks at %s/<id>.md.", goalPath, briefsDir) + yours
	case goalPath != "":
		return fmt.Sprintf("For context only, you can read the overall goal at %s.", goalPath) + yours
	}
	goal, kept, total, cut := engCutAtLine(strings.TrimSpace(goal), engGoalBudget)
	if cut {
		goal = strings.TrimRight(goal, "\n") + fmt.Sprintf("\n[The goal is cut here: the first %s of %s characters.]", engThousands(kept), engThousands(total))
	}
	text := "For context only, this is the goal the whole run works toward." + yours + "\n\n<goal>\n" + goal + "\n</goal>"
	if briefsDir != "" {
		text += fmt.Sprintf("\n\nFor context only, you can read the briefs of the other tasks at %s/<id>.md.", briefsDir)
	}
	return text
}

// engSha is a commit id as texts show it: its first 12 characters.
func engSha(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}

// engTaskPromptText is the first message of a task's work agent.
func engTaskPromptText(p engTaskPrompt) string {
	var where, unmerged string
	rules := engWriteRules
	switch {
	case p.Git && p.Writes:
		is := "Your working directory is a git worktree made for this task, branched from the run's integration branch as it is now. When you finish, whatever you changed in it is committed and merged into that branch for you."
		if p.Sub != "" {
			is = fmt.Sprintf("Your working directory is the folder `%s` of a git worktree made for this task, branched from the run's integration branch as it is now. The worktree is the whole repository (`git rev-parse --show-toplevel` names its top), and when you finish, whatever you changed anywhere in it is committed and merged into that branch for you.", p.Sub)
			rules = engWriteRulesSub
		}
		where = is + " Other tasks may be running at the same time in other worktrees and are merged the same way, so:\n\n" + engScope
		unmerged = " The changes of a failed task are not merged."
	case p.Git:
		is := "Your working directory is a scratch checkout of the run's integration branch as it is now."
		if p.Sub != "" {
			is = fmt.Sprintf("Your working directory is the folder `%s` of a scratch checkout of the run's integration branch as it is now (the checkout is the whole repository).", p.Sub)
			rules = engWriteRulesSub
		}
		where = is + " This task produces a report, not changes: the checkout is thrown away when you finish, so you may build, run and experiment in it freely, but nothing you change there survives. Whatever the orchestrator should know has to be in your report."
	case p.Writes:
		where = "Your working directory is the run's own folder, which is not a git repository: you work directly in it, and what you change is the result. Other tasks that change the folder run before or after you, never at the same time; tasks that only read may run beside you.\n\n" + engScope
		rules = engWriteRulesNoGit
	default:
		where = "Your working directory is the run's own folder, which is not a git repository. This task produces a report, not changes: do not create, change or delete files in it; a task that changes the folder may be running beside you. Whatever the orchestrator should know has to be in your report."
		rules = engWriteRulesNoGit
	}
	return fmt.Sprintf(`You are one of the agents of an automated build run. The run works toward a goal through tasks: an orchestrator decides what the tasks are and reads what each one reports. You have one task. Do that task completely, and only that task.

# Your task: %s %s

<brief>
%s
</brief>
%s
# Where this fits

%s

%s

# Your result

Finish by ending your final message with a result block in exactly this layout (plain tags, not inside a code fence, nothing after it):

<result>
<outcome>completed</outcome>
<summary>two or three sentences</summary>
<report>
the full report in markdown; it may contain code fences
</report>
</result>

- `+"`outcome`: `completed`"+` when you did what the brief asks, `+"`failed`"+` when you could not.%s
- `+"`summary`"+`: two or three sentences on what you did or found. A task that builds on yours may be given only this, so put in it what such a task has to know first.
- `+"`report`"+`: the full account, in markdown. It is all the orchestrator and the tasks that depend on yours will see of your work, so it has to stand on its own: what you did or found, with the evidence (files and lines, the commands you ran and what they showed), what you decided and why, and what you could not do or are unsure of.

Write the report only inside the block; do not write it out before the block as well. Never end with a question: nobody will answer. If you cannot proceed, end with the block and `+"`failed`"+`. If you start subagents, your turn ends while they work and you are started again with their results: give the block only in the message that ends your work.

%s`, p.ID, p.Title, strings.TrimSpace(p.Brief), engDepResults(p.Deps, p.Git), engFits(p.Goal, p.GoalPath, p.BriefsDir), where, unmerged, rules+engReadRule)
}

// ---- a merge ------------------------------------------------------------------

// engMergedTask is a task that was merged into the integration branch while another was built.
// BriefPath and ReportPath are readable copies of its brief and its report: "" = none.
type engMergedTask struct{ ID, Title, Summary, BriefPath, ReportPath string }

// engMergePrompt is what a merge agent's prompt is built from.
type engMergePrompt struct {
	ID, Title string
	Files     []string // the files that conflict now, relative to the working directory
	GitSaid   []string // git's own CONFLICT lines for them, when the engine has them
	Brief     string
	Report    string          // a readable copy of the report of the task's own agent; "" = none
	Merged    []engMergedTask // merged into the integration branch since the task started
}

// engMergePromptText is the first message of a merge agent: one per conflict round.
func engMergePromptText(p engMergePrompt) string {
	files := make([]string, len(p.Files))
	for i, f := range p.Files {
		files[i] = "- " + f
	}
	conflict := strings.Join(files, "\n")
	if len(p.GitSaid) > 0 {
		conflict += "\n\nWhat git reported:\n\n" + strings.Join(p.GitSaid, "\n")
	}
	brief, kept, total, cut := engCutAtLine(strings.TrimSpace(p.Brief), engBriefBudget)
	if cut {
		brief = strings.TrimRight(brief, "\n") + fmt.Sprintf("\n[The brief is cut here: the first %s of %s characters.]", engThousands(kept), engThousands(total))
	}
	merged := make([]string, len(p.Merged))
	for i, m := range p.Merged {
		merged[i] = fmt.Sprintf("  - %s %s", m.ID, m.Title)
		if sum := engOneLine(m.Summary); sum != "" {
			merged[i] += ": " + clip(sum, 400)
		}
		switch {
		case m.BriefPath != "" && m.ReportPath != "":
			merged[i] += fmt.Sprintf("\n    Its brief is at %s and its full report at %s.", m.BriefPath, m.ReportPath)
		case m.BriefPath != "":
			merged[i] += fmt.Sprintf("\n    Its brief is at %s.", m.BriefPath)
		case m.ReportPath != "":
			merged[i] += fmt.Sprintf("\n    Its full report is at %s.", m.ReportPath)
		}
	}
	own := ""
	if p.Report != "" {
		own = fmt.Sprintf("\n- The report of the agent that built this task: %s\n", p.Report)
	}
	if len(merged) == 0 {
		merged = []string{"  - none recorded"}
	} else {
		merged = append(merged, `  Their commits are on the integration branch as "Merge <id>: <title>".`)
	}
	return fmt.Sprintf(`You are resolving a merge conflict in an automated build run.

Task %s (%s) was built on a branch of its own. While it was being built, other tasks were merged into the integration branch. The integration branch has just been merged into this task's worktree (your working directory) and these files conflict:

%s

Resolve every conflict so that the result keeps the intent of both sides: this task's change and what the other tasks merged. Neither side may lose behaviour.

- The brief of this task:

<brief>
%s
</brief>
%s
- The tasks merged into the integration branch since this one started, with what each reported:
%s
- `+"`git log --merge` and `git diff`"+` show both sides.
- When no conflict marker is left, build and run the tests the conflicting files affect.
- Do not run `+"`git commit`, `git merge --abort` or `git reset`"+`. Leave the resolved files in the working tree; the run concludes the merge.

Finish by ending your final message with a result block in exactly this layout (plain tags, not inside a code fence, nothing after it):

<result>
<outcome>completed</outcome>
<summary>two or three sentences</summary>
<report>
for each file, what conflicted and how you resolved it, and what you ran to verify it
</report>
</result>

Use <outcome>failed</outcome> when you could not resolve a conflict without losing one side's behaviour, and say which. Write the report only inside the block. Never end with a question: nobody will answer.

%s`, p.ID, p.Title, conflict, brief, own, strings.Join(merged, "\n"), engWriteRules)
}

// ---- messages after the first --------------------------------------------------

// engResumeMessage is what an agent whose session exists gets when it is started again: it says
// what a stop does and does not leave behind, and repeats the instructions in full (first is
// the first message, built again now).
func engResumeMessage(first string, role model.AgentRole) string {
	added := ""
	left := "Whatever command, tool call or subagent was running at that moment did not finish; do not assume that it completed. Subagents you had started are gone, and their results with them: start them again if you still need them. First check what state your working directory is in, then continue where you left off and complete the job."
	if role == model.RoleOrchestrator { // it changes no files and starts no subagents
		left = "Whatever command or tool call was running at that moment did not finish; do not assume that it completed. Continue where you left off and complete the job."
		added = "\n\nTool calls you made before the stop took effect; the run below is as it is now."
	}
	return `Your previous run of this job stopped before it finished: the run or the app was stopped, or your process ended. ` + left + `

Everything in the original instructions still applies, including how to end. They follow in full.` + added + "\n\n---\n\n" + first
}

// engRepairMessage is sent when a clean turn ended without the result block.
const engRepairMessage = `Your last message did not end with the result block, so your result could not be recorded. Give your result now in exactly this format (plain tags, not inside a code fence, nothing before or after it):

<result>
<outcome>completed</outcome>
<summary>two or three sentences</summary>
<report>
the full report in markdown
</report>
</result>

Use <outcome>failed</outcome> if you could not do the job. Do not ask a question and do not do further work: answer with the block only.`

// engRetryNote is appended to the first message of an agent that starts fresh after earlier
// launches.
func engRetryNote(role model.AgentRole, git bool) string {
	switch {
	case role == model.RoleOrchestrator:
		return "\n\nNote: an earlier instance of this turn did not finish. Tool calls it made took effect; the run above is as it is now."
	case git:
		return "\n\nNote: an earlier attempt at this job did not finish. Your working directory may hold its partial work; check `git status` and build on whatever is sound."
	}
	return "\n\nNote: an earlier attempt at this job did not finish. Your working directory may hold its partial work; look at the files and build on whatever is sound."
}
