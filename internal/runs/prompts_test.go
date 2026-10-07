package runs

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// engGolden compares text with testdata/prompts/<name>.txt. ENG_UPDATE_GOLDEN=1 writes the files.
func engGolden(t *testing.T, name, text string) {
	t.Helper()
	path := filepath.Join("testdata", "prompts", name+".txt")
	if os.Getenv("ENG_UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v (run with ENG_UPDATE_GOLDEN=1 to write it)", name, err)
	}
	if string(want) != text {
		t.Errorf("%s differs from %s:\n%s", name, path, engFirstDiff(string(want), text))
	}
}

func engFirstDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	for i := 0; i < len(w) || i < len(g); i++ {
		var a, b string
		if i < len(w) {
			a = w[i]
		}
		if i < len(g) {
			b = g[i]
		}
		if a != b {
			return fmt.Sprintf("line %d\n want: %q\n  got: %q", i+1, a, b)
		}
	}
	return "(no difference found)"
}

const engSnapshot = `Run the run: running. Turn 3. Tasks: 1 done, 1 running. Spent $1.25 (orchestrator $0.40).
Limits: turn 3 of 60, 1 of 8 task slots busy.
Integration branch aiwb/r_x/integration at 0123456789ab, 2 commit(s) since the run started from ba9876543210.

## Notes

Version 2, 31 characters, written in turn 2. ` + "`get_notes`" + ` returns them.

## Tasks

T01 [research, reports only, light] done: Look at the code
    result: The code is small.
T02 [build, writes, standard] running for 5m27s (agent T02-work): Add the flag`

// engSnapshotNoGit is engSnapshot in a run without git: it has no integration branch.
var engSnapshotNoGit = strings.Replace(engSnapshot, "Integration branch aiwb/r_x/integration at 0123456789ab, 2 commit(s) since the run started from ba9876543210.\n", "", 1)

// engTestTiers is the tier map of the prompts' and the chat contexts' cases.
var engTestTiers = model.RunTiers{Deep: model.ModelChoice{Model: "opus", Effort: "high"}, Standard: model.ModelChoice{Model: "opus", Effort: "medium"},
	Light: model.ModelChoice{Model: "sonnet", Effort: "medium"}}

// engPromptCases is every message the engine can send, by the name of its golden file.
func engPromptCases() map[string]string {
	goal := "# The goal\n\nAdd a --verbose flag to the tool and document it.\n"
	events := []string{"- T01 finished. The code is small.", "- T03 failed. agent T03-work failed: timed out after 3h00m", "- A chat on the run added T04."}
	orch := engOrchPrompt{Turn: 3, Goal: goal, Reason: "events", Events: events, MaxIdleTurns: 3, Notes: "Done means: the flag works.\nApproach: one task.\n",
		Snapshot: engSnapshot, Git: true, MaxParallel: 8, Wake: "each", MaxTurns: 60, ReportsByPath: true, Tiers: engTestTiers}
	// The first turn, in the wake mode a run has unless it is set otherwise.
	start := orch
	start.Turn, start.Reason, start.Events, start.Notes, start.Wake = 1, "start", nil, "", "declared"
	dirty := start
	dirty.Dirty = true
	manual := start
	manual.ManualApply = true
	plain := start // a kind whose models have no effort levels
	plain.Tiers = model.RunTiers{Deep: model.ModelChoice{Model: "gpt-5"}, Standard: model.ModelChoice{Model: "gpt-5"}, Light: model.ModelChoice{Model: "gpt-5-mini"}}
	sub := orch
	sub.Sub, sub.Wake, sub.Events = "services/api", "idle", nil
	idle := orch
	idle.Git, idle.Snapshot, idle.Reason, idle.Events, idle.IdleStreak, idle.Idle = false, engSnapshotNoGit, "idle", nil, 2, true
	nogitStart := start // wake mode declared in a run without git
	nogitStart.Git, nogitStart.Snapshot = false, engSnapshotNoGit
	startEvents := start // a chat changed the run before its first turn
	startEvents.Events = events[2:]
	resume := orch
	resume.Reason, resume.Halt, resume.StalledBy, resume.Events, resume.Idle = "resume", model.StopStalled, model.StalledTurns, events[:1], true
	// Wake mode declared: a turn whose wait was met, and one started before that for each cause.
	wait := &model.RunWait{Tasks: []string{"T01", "T02"}, Mode: "all", Turn: 2}
	met := orch
	met.Wake, met.Reason, met.Wait, met.WaitMet, met.Events = "declared", "wait", wait, true, events[:1]
	failed := orch
	failed.Wake, failed.Wait, failed.Events = "declared", wait, events[:2]
	chat := orch
	chat.Wake, chat.Wait, chat.WokenByChat = "declared", &model.RunWait{Tasks: []string{"T02"}, Mode: "any", Turn: 2}, true
	resumed := resume
	resumed.Wake, resumed.Wait, resumed.Halt, resumed.StalledBy = "declared", wait, model.StopUser, ""
	metIdle := met // the wait was met and nothing is running: the second such turn in a row
	metIdle.Idle, metIdle.IdleStreak = true, 2
	stuck := orch
	stuck.Wake, stuck.Wait, stuck.Reason, stuck.Idle, stuck.IdleStreak, stuck.Events = "declared", wait, "idle", true, 1, events[1:2]

	ctx := "/work/aiwb-run-work/r_x/ctx"
	deps := []engDep{
		{ID: "T01", Kind: "research", Title: "Look at the code", Summary: "The code is small.", Needs: true, Report: "# What is there\n\nOne file, `main.go`.\n"},
		{ID: "T02", Kind: "build", Title: "Add the flag", Summary: "The flag is in.", ReportSize: 45, Path: ctx + "/reports/T02.a1.md",
			Base: "ba9876543210ffffffffffffffffffffffffffff", Head: "0123456789abffffffffffffffffffffffffffff"},
		{ID: "T05", Kind: "review", Title: "No report", Summary: "Nothing to say."},
	}
	task := engTaskPrompt{ID: "T06", Title: "Document the flag", Brief: "Write the README section for `--verbose`.\n", Goal: goal, Deps: deps, Writes: true, Git: true,
		GoalPath: ctx + "/goal.md", BriefsDir: ctx + "/briefs"}
	// The six ways a dependency's report reaches the prompt, in one task: the fourth and the
	// fifth do not fit what the third left of the budget, the sixth finds under 4,000 left.
	big := strings.Repeat("0123456789 the quick brown fox jumps over it\n", 1500) // 67,500 characters
	needs := task
	needs.Deps = []engDep{
		{ID: "T01", Kind: "research", Title: "Not needed, readable", Summary: "One.", ReportSize: 1200, Path: ctx + "/reports/T01.a2.md"},
		{ID: "T02", Kind: "research", Title: "Not needed, not readable", Summary: "Two.", ReportSize: 1200},
		{ID: "T03", Kind: "design", Title: "Needed, fits", Summary: "Three.", Needs: true, Report: "The design.\n", Path: ctx + "/reports/T03.a1.md"},
		{ID: "T04", Kind: "design", Title: "Needed, too long, readable", Summary: "Four.", Needs: true, Report: big, Path: ctx + "/reports/T04.a1.md"},
		{ID: "T07", Kind: "design", Title: "Needed, too long, not readable", Summary: "Five.", Needs: true, Report: big},
		{ID: "T08", Kind: "design", Title: "Needed, nothing left", Summary: "Six.", Needs: true, Report: big},
		{ID: "T09", Kind: "review", Title: "Needed, no report", Summary: "Seven.", Needs: true},
	}
	reports := task
	reports.Writes, reports.Deps, reports.GoalPath, reports.BriefsDir = false, nil, "", ""
	nogitW := task
	nogitW.Git = false
	nogitR := reports
	nogitR.Git = false
	// A run started in a folder below the repository's top: the agent starts in that folder.
	subW := task
	subW.Sub = "services/api"
	subR := reports
	subR.Sub = "services/api"
	// No readable copy of the goal, and a goal over its budget: it is in the prompt, cut.
	cut := reports
	cut.Goal = "# The goal\n\n" + strings.Repeat("Add a --verbose flag to the tool and document it.\n", 500) // 25,012 characters

	merge := engMergePrompt{ID: "T06", Title: "Document the flag", Files: []string{"README.md", "cmd/main.go"},
		GitSaid: []string{"CONFLICT (content): Merge conflict in README.md", "CONFLICT (modify/delete): cmd/main.go deleted in aiwb/r_x/integration and modified in HEAD."},
		Brief:   "Write the README section for `--verbose`.\n",
		Report:  ctx + "/reports/T06.a1.md",
		Merged: []engMergedTask{{ID: "T02", Title: "Add the flag", Summary: "The flag is in.\nIt is documented in the help text.",
			BriefPath: ctx + "/briefs/T02.md", ReportPath: ctx + "/reports/T02.a1.md"},
			{ID: "T07", Title: "Rename main", Summary: "", BriefPath: ctx + "/briefs/T07.md"}, {ID: "T08", Title: "Fix the help", Summary: "Fixed."}}}
	later := merge
	later.GitSaid, later.Merged, later.Files, later.Report = nil, nil, []string{"README.md"}, ""

	taskText := engTaskPromptText(task)
	orchText := engOrchestratorPrompt(orch)
	return map[string]string{
		"orchestrator_git_start":    engOrchestratorPrompt(start),
		"orchestrator_nogit_start":  engOrchestratorPrompt(nogitStart),
		"orchestrator_start_events": engOrchestratorPrompt(startEvents),
		"orchestrator_wait_idle":    engOrchestratorPrompt(metIdle),
		"task_git_sub_writes":       engTaskPromptText(subW),
		"task_git_sub_reports":      engTaskPromptText(subR),
		"task_goal_cut":             engTaskPromptText(cut),
		"orchestrator_git_dirty":    engOrchestratorPrompt(dirty),
		"orchestrator_git_manual":   engOrchestratorPrompt(manual),
		"orchestrator_no_effort":    engOrchestratorPrompt(plain),
		"orchestrator_wait_met":     engOrchestratorPrompt(met),
		"orchestrator_early_failed": engOrchestratorPrompt(failed),
		"orchestrator_early_chat":   engOrchestratorPrompt(chat),
		"orchestrator_early_resume": engOrchestratorPrompt(resumed),
		"orchestrator_early_idle":   engOrchestratorPrompt(stuck),
		"orchestrator_git_events":   orchText,
		"orchestrator_git_sub":      engOrchestratorPrompt(sub),
		"orchestrator_nogit_idle":   engOrchestratorPrompt(idle),
		"orchestrator_git_resume":   engOrchestratorPrompt(resume),
		"task_git_writes":           taskText,
		"task_git_reports":          engTaskPromptText(reports),
		"task_git_needs":            engTaskPromptText(needs),
		"task_nogit_writes":         engTaskPromptText(nogitW),
		"task_nogit_reports":        engTaskPromptText(nogitR),
		"merge_round1":              engMergePromptText(merge),
		"merge_later":               engMergePromptText(later),
		"resume_task":               engResumeMessage(taskText, model.RoleTask),
		"resume_orchestrator":       engResumeMessage(orchText, model.RoleOrchestrator),
		"repair":                    engRepairMessage,
		"retry_task_git":            taskText + engRetryNote(model.RoleTask, true),
		"retry_task_nogit":          engTaskPromptText(nogitW) + engRetryNote(model.RoleTask, false),
		"retry_merge":               engMergePromptText(merge) + engRetryNote(model.RoleMerge, true),
		"retry_orchestrator_start":  engOrchestratorPrompt(start) + engRetryNote(model.RoleOrchestrator, true),
	}
}

func TestPromptsGolden(t *testing.T) {
	for name, text := range engPromptCases() {
		engGolden(t, name, text)
	}
}

// What every prompt must say, whatever its wording: checked apart from the golden files so that
// a careless update of them does not lose it.
func TestPromptsSayWhatTheyMust(t *testing.T) {
	c := engPromptCases()
	has := func(name string, parts ...string) {
		t.Helper()
		for _, p := range parts {
			if !strings.Contains(c[name], p) {
				t.Errorf("%s does not contain %q", name, p)
			}
		}
	}
	hasNot := func(name string, parts ...string) {
		t.Helper()
		for _, p := range parts {
			if strings.Contains(c[name], p) {
				t.Errorf("%s contains %q", name, p)
			}
		}
	}
	has("orchestrator_git_start", "This is turn 1.", "# Why you were started\n\nThis is the first turn. Nothing has happened yet: there are no tasks and no notes.\n\n# Notes\n\n(empty)",
		"# Keeping the notes", "the others of the `board` server", "up to 8 at a time", "a checkout of the repository",
		"the full reports of those you name in `needs_report`", "whole up to 60,000 characters together, in the order of `depends_on`; one that does not fit is given to it as a file to read.\n",
		"- Every task has a tier, which decides how capable an agent it gets and what it costs:\n  - `deep` (opus, high effort): the result is a decision",
		"\n  - `standard` (opus, medium effort): work from a precise brief", "\n  - `light` (sonnet, medium effort): gathering facts",
		"- You say when you are started again: `wait_for` names the tasks", "One also starts whenever a task fails, when nothing is left running, and when the person changes the run or leaves a message through a chat. You never need to wait or poll",
		"When you finish the run as `achieved`, the app brings the result into that folder if it can do so without touching the person's own uncommitted work; otherwise, and after `not_achieved`, the person applies it with one action. Nothing is applied while the run is going.",
		"add no task to deliver, merge or push the result.\n\n# How to decide", "\n\nKeep a task narrow: one package", "\n\nGive each task the lowest tier that is safe for it",
		"keep them current with `edit_notes`",
		"\n\n# Planning work so it runs side by side\n\nThe run is as long as its longest chain of tasks that wait on each other", "have a design task fix the contracts between them",
		"Build tasks then depend on the design, not on each other", "Only the task that joins the parts depends on them.", "more than about 30 minutes",
		"\n\n# Checking\n\nNothing is checked unless you ask for it.", "Split a full verification into separate tasks by what they run",
		"Review tasks and verification tasks do not depend on each other.", "a test that fails only sometimes, add a task to fix it in that same turn",
		"\n\n# When you are started again\n\nCall `wait_for` in mode `any`, naming every design, review and verification task that is still open.",
		"Do not wait for build tasks", "act on the result that arrived: add the tasks it calls for at once, without waiting for the other checks of the stage",
		"the run is stopped after 60 turns.\n\n# Keeping the notes",
		"# Ending your turn\n\nBefore you end, call `wait_for` as described above, unless nothing is pending or running.\n\nWhen the run is the way you want it")
	hasNot("orchestrator_git_start", "Wait for all the tasks of a stage")
	hasNot("orchestrator_git_start", "Keep one task to one coherent piece of work", "120,000", "The folder had uncommitted changes")
	has("orchestrator_git_dirty", "no tasks and no notes. The folder had uncommitted changes when the run started. The run started from the last commit and does not see them, and the result can only be applied to the folder where it does not touch the files they are in. If the goal depends on them, say so in the notes and in your final message.\n\n# Notes")
	has("orchestrator_git_manual", "The integration branch is not the folder the person works in. When the run has ended, the person applies the result to that folder with one action. Nothing is applied while the run is going.")
	hasNot("orchestrator_git_manual", "the app brings the result")
	has("orchestrator_no_effort", "`deep` (gpt-5, default effort):", "`standard` (gpt-5, default effort):", "`light` (gpt-5-mini, default effort):")
	asked := "# Why you were started\n\nThe instance of turn 2 asked to be started again when all of T01, T02 had ended. "
	has("orchestrator_wait_met", asked+"That has happened.\n\nSince the last orchestrator turn:\n\n- T01 finished.")
	hasNot("orchestrator_wait_met", "Nothing is running and nothing can start")
	has("orchestrator_early_failed", asked+"This instance is started before that, because a task failed.\n\nSince the last orchestrator turn:")
	has("orchestrator_early_chat", "when any of T02 had ended. This instance is started before that, because a chat on the run changed it or left a message.\n\nSince")
	has("orchestrator_early_resume", asked+"This instance is started before that, because the person resumed the run after a halt.\n\nThe run was halted (stopped by the person who started it) and",
		"Nothing is running and nothing can start.")
	has("orchestrator_early_idle", asked+"This instance is started before that, because nothing is left running.\n\nSince the last orchestrator turn:", "Nothing is running and nothing can start.")
	hasNot("orchestrator_early_idle", "in a row that began this way")
	// Only wake mode declared has wait_for; a run without git has no folder to apply a result to.
	for _, name := range []string{"orchestrator_git_events", "orchestrator_git_sub", "orchestrator_nogit_idle"} {
		hasNot(name, "wait_for", "You say when you are started again", "# When you are started again")
		has(name, "# Planning work so it runs side by side", "# Checking")
	}
	has("orchestrator_git_events", "- You are started again whenever a task finishes or fails, and when the person changes the run or leaves a message through a chat. You never need to wait or poll")
	hasNot("orchestrator_nogit_idle", "The integration branch is not the folder", "apply")
	// The run tools are named bare in the texts; one passage says how a CLI lists them and which
	// tools of its own they are not.
	for _, name := range []string{"orchestrator_git_start", "orchestrator_git_events", "orchestrator_git_sub", "orchestrator_nogit_idle", "orchestrator_git_resume"} {
		has(name, "(for example `mcp__board__get_task`)", "`TaskGet`, `TaskCreate`, `TaskList`, `TaskUpdate`, `TodoWrite`")
	}
	if n := strings.Count(c["orchestrator_git_start"], "\n# Notes\n"); n != 1 {
		t.Errorf("the orchestrator's prompt has %d headings \"# Notes\"", n)
	}
	has("orchestrator_git_events", "Since the last orchestrator turn:\n\n- T01 finished. The code is small.\n- T03 failed.", "<run>\n"+engSnapshot+"\n</run>",
		"Done means: the flag works.")
	hasNot("orchestrator_git_events", "Nothing is running and nothing can start")
	has("orchestrator_git_sub", "The run was started in its folder `services/api`: every task's agent starts in that folder of its own checkout and can read and change the whole repository. Give paths in a brief from the top of the repository.", "Since the last orchestrator turn:\n\n- nothing new",
		"You are started again when a task fails, when nothing is left running, and when the person changes the run or leaves a message through a chat")
	has("orchestrator_nogit_idle", "Nothing is running and nothing can start.", "This is turn 2 in a row that began this way; after 3 the run is stopped as stalled.",
		"Your working directory is the run's folder itself", "Writing tasks run one at a time", "the run's folder to work in", "Nothing is undone")
	hasNot("orchestrator_nogit_idle", "git worktree", "integration branch,")
	has("orchestrator_git_resume", "The run was halted (it had reached the limit of orchestrator turns) and the person who started it resumed it.\n\nSince the last orchestrator turn:\n\n- T01 finished.",
		"Nothing is running and nothing can start.")
	hasNot("orchestrator_git_resume", "in a row that began this way")

	has("task_git_writes", "# Your task: T06 Document the flag", "<brief>\nWrite the README section for `--verbose`.\n</brief>\n\n# Results of the tasks this one depends on\n\n## T01 [research] Look at the code\n\nThe code is small.\n\n<report>\n# What is there",
		"Its changes are in your working directory already (`git diff ba9876543210..0123456789ab` shows them).", "## T05 [review] No report\n\nNothing to say.\n\n# Where this fits",
		"shows them).\n\nIts full report is at /work/aiwb-run-work/r_x/ctx/reports/T02.a1.md. Read it only if your brief and this summary leave you short.\n",
		"# Where this fits\n\nFor context only, you can read the overall goal at /work/aiwb-run-work/r_x/ctx/goal.md and the briefs of the other tasks at /work/aiwb-run-work/r_x/ctx/briefs/<id>.md. Your brief is what you are asked to do; the goal is not.\n\nYour working directory",
		"A task that builds on yours may be given only this, so put in it what such a task has to know first.",
		"say so in your report.\n- Everything you read stays with you for the rest of the task and is paid for on every step",
		"git worktree made for this task", "The changes of a failed task are not merged.", "plain tags, not inside a code fence, nothing after it",
		"Do not commit, push, stash, switch branches or rewrite history.")
	hasNot("task_git_writes", "<goal>", "Add a --verbose flag") // the goal has a readable copy: it is not in the prompt
	has("task_git_reports", "</brief>\n\n# Where this fits\n\nFor context only, this is the goal the whole run works toward. Your brief is what you are asked to do; the goal is not.\n\n<goal>\n# The goal",
		"scratch checkout", "</goal>\n\nYour working directory")
	hasNot("task_git_reports", "The changes of a failed task are not merged.", "# Results of the tasks", "For context only, you can")
	has("task_git_needs",
		"One.\n\nIts full report is at /work/aiwb-run-work/r_x/ctx/reports/T01.a2.md. Read it only if your brief and this summary leave you short.\n\n## T02",
		"Two.\n\nYou are given its summary only; its full report is not available to you.\n\n## T03",
		"Three.\n\n<report>\nThe design.\n</report>\n\n## T04",
		"Four.\n\nYou need its full report, which is at /work/aiwb-run-work/r_x/ctx/reports/T04.a1.md; read it.\n\n## T07",
		"Five.\n\n<report>\n0123456789 the quick",
		"jumps over it\n[The report is cut here: the first 59,984 of 67,499 characters. The rest is not available to you. If you need what is missing, say so in your report.]\n</report>\n\n## T08",
		"Six.\n\nIts full report (67,499 characters) is left out: the reports given to this task are over 60,000 characters together. If you need what is missing, say so in your report.\n\n## T09",
		"Seven.\n\n# Where this fits")
	has("task_nogit_writes", "the run's own folder, which is not a git repository: you work directly in it", "Do not create a git repository in it.",
		"say so in your report.\n- Everything you read stays with you", "Its full report is at /work/aiwb-run-work/r_x/ctx/reports/T02.a1.md.")
	hasNot("task_nogit_writes", "git worktree", "git diff", "The changes of a failed task are not merged.")
	has("task_nogit_reports", "do not create, change or delete files in it")
	has("task_git_sub_writes", "Your working directory is the folder `services/api` of a git worktree made for this task, branched from the run's integration branch as it is now. The worktree is the whole repository (`git rev-parse --show-toplevel` names its top), and when you finish, whatever you changed anywhere in it is committed and merged into that branch for you. Other tasks may be running",
		"Rules:\n- Work only inside your worktree. Other agents are working at the same time in other\n  git worktrees of this repository; never touch anything outside your own.")
	has("task_git_sub_reports", "Your working directory is the folder `services/api` of a scratch checkout of the run's integration branch as it is now (the checkout is the whole repository). This task produces a report, not changes",
		"Rules:\n- Work only inside your worktree.")
	for _, name := range []string{"task_git_sub_writes", "task_git_sub_reports"} {
		hasNot(name, "Work only inside your working directory")
	}
	has("task_goal_cut", "document it.\n[The goal is cut here: the first 19,961 of 25,011 characters.]\n</goal>\n\nYour working directory")
	has("orchestrator_nogit_start", "you cannot change the folder, and whatever", "what the folder already has", "Add tasks that change the folder once", "when verification of the result shows",
		"it may run while a writing task is changing them, so a task that checks a writing task's work must depend on it.", "`wait_for` names the tasks")
	hasNot("orchestrator_nogit_start", "change the repository,", "the repository already has", "change the repository", "the merged result", "Integration branch", "integration branch")
	has("orchestrator_git_start", "you cannot change the repository, and whatever", "what the repository already has", "Add tasks that change the repository once", "when verification of the merged result shows",
		"the full reports of those you name in `needs_report` (it can open the other reports as files when a summary leaves it short), and a checkout of the repository.",
		"It can also read the goal and the other briefs, for context only.")
	has("orchestrator_start_events", "# Why you were started\n\nThis is the first turn. There are no notes yet.\n\nSince the run started:\n\n- A chat on the run added T04.\n\n# Notes")
	hasNot("orchestrator_start_events", "Nothing has happened yet")
	has("orchestrator_wait_idle", asked+"That has happened.\n\nSince the last orchestrator turn:\n\n- T01 finished. The code is small.\n\nNothing is running and nothing can start.")

	has("merge_round1", "Task T06 (Document the flag)", "- README.md\n- cmd/main.go\n\nWhat git reported:\n\nCONFLICT (content): Merge conflict in README.md",
		"</brief>\n\n- The report of the agent that built this task: /work/aiwb-run-work/r_x/ctx/reports/T06.a1.md\n\n- The tasks merged",
		"  - T02 Add the flag: The flag is in. It is documented in the help text.\n    Its brief is at /work/aiwb-run-work/r_x/ctx/briefs/T02.md and its full report at /work/aiwb-run-work/r_x/ctx/reports/T02.a1.md.\n"+
			"  - T07 Rename main\n    Its brief is at /work/aiwb-run-work/r_x/ctx/briefs/T07.md.\n  - T08 Fix the help: Fixed.\n  Their commits are on the integration branch as \"Merge <id>: <title>\".\n- `git log --merge`",
		"<brief>\nWrite the README section", "Use <outcome>failed</outcome> when you could not resolve a conflict")
	has("merge_later", "these files conflict:\n\n- README.md\n\nResolve every conflict", "  - none recorded\n")
	hasNot("merge_later", "What git reported", "/ctx/", "The report of the agent", "Their commits are on the integration branch")
	for _, name := range []string{"merge_round1", "merge_later", "retry_merge"} {
		hasNot(name, "Everything you read stays with you") // the fourth rule is the task agent's
	}

	has("resume_task", "Your previous run of this job stopped before it finished", "Subagents you had started are gone", "First check what state your working directory is in", "They follow in full.\n\n---\n\nYou are one of the agents")
	hasNot("resume_orchestrator", "Subagents you had started", "your working directory is in")
	has("resume_orchestrator", "did not finish; do not assume that it completed. Continue where you left off and complete the job.\n\nEverything in the original instructions", "They follow in full.\n\nTool calls you made before the stop took effect; the run below is as it is now.\n\n---\n\nYou are the orchestrator")
	has("retry_task_git", "you do not need what it reads yourself.\n\nNote: an earlier attempt at this job did not finish.", "check `git status`")
	has("retry_task_nogit", "look at the files and build on whatever is sound.")
	hasNot("retry_task_nogit", "git status")
	has("retry_orchestrator_start", "Note: an earlier instance of this turn did not finish. Tool calls it made took effect; the run above is as it is now.")
	hasNot("retry_orchestrator_start", "git status")
}

// No message may name a path under the app's data folder or a file of the run: an agent cannot
// read them, and must not be sent looking. The prompts are built here the way the engine builds
// them, for a real run in a temp data folder.
func TestPromptsHaveNoRunPath(t *testing.T) {
	for _, c := range [][2]bool{{true, true}, {true, false}, {false, true}, {false, false}} {
		git, needs := c[0], c[1]
		e := newEngEnv(t, git)
		r := e.run("r_paths", nil)
		a := e.add(r, 0, "First task", true)
		b := e.add(r, 0, "Second task", false, a)
		e.must(r, KOp, func(tx *Tx) error {
			tx.AddNotes(model.NotesVersion{V: 1, At: tx.Now(), Size: 5})
			tx.File(notesRel(1), []byte("notes"))
			return nil
		})
		// Turn 1 with an event, and T01 done with a report.
		e.must(r, KTurnStarted, func(tx *Tx) error {
			tx.AddTurn(Turn{N: 1, Agent: AgentChatID(r.id, TurnAgentName(1)), Reason: "events", Status: "running", StartedAt: tx.Now(),
				WokenBy: []model.RunEvent{{Seq: 1, Type: "task_done", Task: a, Text: "done"}}})
			t := tx.Task(a)
			at := &t.Attempts[0]
			at.Result, at.WorkDone, at.Outcome = &model.AttemptResult{Outcome: "completed", Summary: "First is in."}, true, model.TaskDone
			at.Base, at.Head, at.Merged = "aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"
			at.Result.ReportSize = 29
			tx.File(reportRel(a, 1), []byte("The report of the first task.\n"))
			if needs {
				tx.Task(b).NeedsReport = []string{a}
			}
			return nil
		})
		eng := &engine{r: r} // the builders read the run; no scheduler is needed

		orch, err := eng.orchPrompt(t.Context(), 1)
		if err != nil {
			t.Fatal(err)
		}
		task, err := eng.taskPrompt(b, "")
		if err != nil {
			t.Fatal(err)
		}
		merge, err := eng.mergePrompt(b, []string{"f.txt"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(orch, "\n# Notes\n\nnotes\n") || !strings.Contains(orch, "Build the thing.") || !strings.Contains(task, "Do this: Second task.") {
			t.Fatalf("the prompts were not built from the run's files:\n%s", task)
		}
		// The only paths of the run a prompt names are the readable copies, which are outside
		// the data folder and exist.
		dir := r.ctxDir()
		if e.s.Store.P.Contains(dir) {
			t.Fatalf("the readable copies %s are inside the data folder", dir)
		}
		report := filepath.Join(dir, "reports", a+".a1.md")
		// The goal has a readable copy, so the task prompt names it and does not carry the goal.
		if copied, err := os.ReadFile(filepath.Join(dir, "goal.md")); err != nil || !strings.Contains(string(copied), "Build the thing.") || strings.Contains(task, "Build the thing.") {
			t.Errorf("git %v: the goal is in the task prompt, or its readable copy is not the goal (%v):\n%s", git, err, task)
		}
		wantTask := []string{"you can read the overall goal at " + filepath.Join(dir, "goal.md") + " and the briefs of the other tasks at " + filepath.Join(dir, "briefs") + "/<id>.md."}
		if needs {
			wantTask = append(wantTask, "\n\n<report>\nThe report of the first task.\n</report>\n")
		} else {
			wantTask = append(wantTask, "\n\nIts full report is at "+report+". Read it only if your brief and this summary leave you short.\n")
		}
		for _, w := range wantTask {
			if !strings.Contains(task, w) {
				t.Errorf("git %v, needs %v: the task prompt does not contain %q:\n%s", git, needs, w, task)
			}
		}
		if needs == strings.Contains(task, report) || !needs == strings.Contains(task, "The report of the first task.") {
			t.Errorf("git %v, needs %v: the task prompt has the report both ways or neither", git, needs)
		}
		if w := "    Its brief is at " + filepath.Join(dir, "briefs", a+".md") + " and its full report at " + report + "."; !strings.Contains(merge, w) {
			t.Errorf("git %v: the merge prompt does not contain %q:\n%s", git, w, merge)
		}
		for _, f := range []string{"goal.md", "briefs/" + a + ".md", "briefs/" + b + ".md", "reports/" + a + ".a1.md"} {
			if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(f))); err != nil {
				t.Errorf("git %v: a prompt names a copy that is not there: %v", git, err)
			}
		}
		all := map[string]string{"orchestrator": orch, "task": task, "merge": merge, "resume": engResumeMessage(task, model.RoleTask),
			"resume orchestrator": engResumeMessage(orch, model.RoleOrchestrator), "repair": engRepairMessage,
			"retry": task + engRetryNote(model.RoleTask, git), "retry orchestrator": orch + engRetryNote(model.RoleOrchestrator, git)}
		for name, text := range engPromptCases() {
			all["case "+name] = text
		}
		bad := []string{e.root, filepath.Base(e.root) + "/runs", r.dir, "/runs/" + r.id, fileGoal, fileJournal, fileState, fileTasks, fileTurns, fileAgents, fileMeta,
			"brief.r1", ".report.md", ".changes.json", ".setup.log", "notes/v", "tasks/T0"}
		// The readable copies are the paths a message may name: they are taken out, and what is
		// left is checked. Anything else under their folder stays in and is caught as a path.
		copies := regexp.MustCompile("(" + regexp.QuoteMeta(dir) + `|/work/aiwb-run-work/r_x/ctx)/(goal\.md|briefs/(T\d+|<id>)\.md|reports/T\d+\.a\d+\.md)`)
		bad = append(bad, dir, "aiwb-run-work", "/ctx")
		for name, text := range all {
			text = copies.ReplaceAllString(text, "(a readable copy)")
			for _, b := range bad {
				if strings.Contains(text, b) {
					t.Errorf("git %v: the %s message names %q", git, name, b)
				}
			}
		}
	}
}

// The reports a task needs share one budget of 60,000 characters, spent in the order of its
// dependencies: one that fits is whole, one that does not is named by its path, and without a
// path it is cut at a line end to what is left, or left out when little is left.
func TestDependencyBudget(t *testing.T) {
	if engReportsBudget != 60_000 {
		t.Fatalf("the budget is %d", engReportsBudget)
	}
	lines := func(n int) string { return strings.Repeat("0123456789 the quick brown fox jumps over it\n", n) } // 45 characters a line
	count := func(s string) int { return len([]rune(s)) }
	dep := func(id string, n int, path string) engDep {
		return engDep{ID: id, Kind: "k", Title: "t", Summary: "Summary of " + id + ".", Needs: true, Report: lines(n), Path: path}
	}
	// after is what follows the summary of id, up to the next dependency.
	after := func(text, id string) string {
		t.Helper()
		_, rest, ok := strings.Cut(text, "Summary of "+id+".\n")
		if !ok {
			t.Fatalf("no summary of %s", id)
		}
		rest, _, _ = strings.Cut(rest, "\n## ")
		return strings.TrimSuffix(rest, "\n")
	}
	whole := func(n int) string { return "\n<report>\n" + strings.TrimSpace(lines(n)) + "\n</report>" }
	cutNote := "\n[The report is cut here: the first %d of %d characters. The rest is not available to you. If you need what is missing, say so in your report.]\n</report>"
	const path = "/w/ctx/reports/T02.a1.md"

	// All fit: 3 x 20,000 less the last newline of each is under the budget.
	got := engDepResults([]engDep{dep("T01", 444, ""), dep("T02", 444, ""), dep("T03", 444, "")}, true)
	for _, id := range []string{"T01", "T02", "T03"} {
		if after(got, id) != whole(444) {
			t.Errorf("%s fits the budget and is not whole", id)
		}
	}

	// The order of depends_on decides who is whole: the first 40,000 fit, the second do not.
	// With a path the second is named and costs nothing, so the third still fits.
	got = engDepResults([]engDep{dep("T01", 889, ""), dep("T02", 889, path), dep("T03", 400, "")}, true)
	if after(got, "T01") != whole(889) || after(got, "T03") != whole(400) {
		t.Error("a report that fits what is left is not whole")
	}
	if a := after(got, "T02"); a != "\nYou need its full report, which is at "+path+"; read it." {
		t.Errorf("a report that does not fit, with a path: %q", clip(a, 200))
	}
	// Without a path it is cut to what the first left, at a line end, and the third gets the rest.
	got = engDepResults([]engDep{dep("T01", 889, ""), dep("T02", 889, ""), dep("T03", 400, "")}, true)
	left := engReportsBudget - (889*45 - 1)
	a := after(got, "T02")
	body, tail, ok := strings.Cut(a, "\n[The report is cut here")
	var kept, all int
	// The note writes its numbers with a comma between the thousands.
	plain := regexp.MustCompile(`(\d),(\d)`).ReplaceAllString(tail, "$1$2")
	if _, err := fmt.Sscanf("\n[The report is cut here"+plain, cutNote, &kept, &all); !ok || err != nil {
		t.Fatalf("the cut report does not end with the note: %q (%v)", a[max(0, len(a)-200):], err)
	}
	if all != 889*45-1 || kept > left || kept < left-45 || count(body) != count("\n<report>\n")+kept {
		t.Errorf("the cut report kept %d of %d characters (the text has %d), want the %d the first left, cut at a line end", kept, all, count(body), left)
	}
	if !strings.HasSuffix(body, "jumps over it") {
		t.Errorf("the report is not cut at a line end: %q", body[len(body)-30:])
	}
	if a := after(got, "T03"); a != "\nIts full report (17,999 characters) is left out: the reports given to this task are over 60,000 characters together. If you need what is missing, say so in your report." {
		t.Errorf("a report with under 4,000 characters left: %q", clip(a, 300))
	}
	// The other order: the short one and one long one are whole, and the 2,001 characters they
	// leave are too few to cut the last one to.
	got = engDepResults([]engDep{dep("T03", 400, ""), dep("T01", 889, ""), dep("T02", 889, "")}, true)
	if after(got, "T03") != whole(400) || after(got, "T01") != whole(889) {
		t.Error("the first two of the other order are not whole")
	}
	if a := after(got, "T02"); !strings.HasPrefix(a, "\nIts full report (40,004 characters) is left out") {
		t.Errorf("the last of the other order: %q", clip(a, 300))
	}

	// Exactly at the limits: a report of what is left fits; 4,000 left is cut, 3,999 is left out.
	exact := engDep{ID: "T01", Kind: "k", Title: "t", Summary: "Summary of T01.", Needs: true, Report: strings.Repeat("x", engReportsBudget)}
	over := exact
	over.Report += "y"
	if a := after(engDepResults([]engDep{exact}, true), "T01"); !strings.HasSuffix(a, "x\n</report>") || strings.Contains(a, "cut here") {
		t.Error("a report of exactly the budget is not whole")
	}
	if a := after(engDepResults([]engDep{over}, true), "T01"); !strings.Contains(a, "[The report is cut here: the first 60,000 of 60,001 characters.") {
		t.Errorf("a report one over the budget: %q", a[max(0, len(a)-200):])
	}
	fill := func(n int) engDep {
		return engDep{ID: "T00", Kind: "k", Title: "t", Summary: "Summary of T00.", Needs: true, Report: strings.Repeat("x", n)}
	}
	if a := after(engDepResults([]engDep{fill(engReportsBudget - 4000), dep("T02", 889, "")}, true), "T02"); !strings.Contains(a, "[The report is cut here: the first 3,959 of 40,004 characters.") {
		t.Errorf("4,000 left: %q", a[max(0, len(a)-200):])
	}
	if a := after(engDepResults([]engDep{fill(engReportsBudget - 3999), dep("T02", 889, "")}, true), "T02"); !strings.HasPrefix(a, "\nIts full report (40,004 characters) is left out") {
		t.Errorf("3,999 left: %q", clip(a, 200))
	}

	// Not needed: the report is never in the prompt and costs nothing, whatever its size.
	quiet := engDep{ID: "T01", Kind: "k", Title: "t", Summary: "Summary of T01.", Report: lines(10), ReportSize: 500_000, Path: path}
	got = engDepResults([]engDep{quiet, dep("T02", 1333, "")}, true)
	if a := after(got, "T01"); a != "\nIts full report is at "+path+". Read it only if your brief and this summary leave you short." {
		t.Errorf("a report that is not needed, with a path: %q", clip(a, 200))
	}
	if after(got, "T02") != whole(1333) {
		t.Error("a report that is not needed took from the budget")
	}
	quiet.Path = ""
	if a := after(engDepResults([]engDep{quiet}, true), "T01"); a != "\nYou are given its summary only; its full report is not available to you." {
		t.Errorf("a report that is not needed, without a path: %q", clip(a, 200))
	}
	// A dependency without a report adds nothing, needed or not, and a path changes nothing.
	for _, d := range []engDep{{}, {Needs: true}, {Path: path}, {Needs: true, Path: path, Report: " \n"}} {
		d.ID, d.Kind, d.Title, d.Summary = "T01", "k", "t", "Summary of T01."
		if a := after(engDepResults([]engDep{d}, true), "T01"); a != "" {
			t.Errorf("a dependency without a report (%+v): %q", d, a)
		}
	}

	// In a prompt: the summary is whole whatever happens to the report.
	p := engTaskPromptText(engTaskPrompt{ID: "T09", Title: "x", Brief: "b", Goal: "g", Git: true, Deps: []engDep{
		{ID: "T01", Kind: "k", Title: "giant", Summary: strings.Repeat("summary ", 100), Needs: true, Report: lines(10_000)},
		{ID: "T02", Kind: "k", Title: "empty", Summary: "nothing"}}})
	if !strings.Contains(p, strings.Repeat("summary ", 100)) || !strings.Contains(p, "The rest is not available to you.") {
		t.Error("the prompt lost the summary or the cut note")
	}
	if strings.Count(p, "<report>") != 2 { // the cut report and the example in the result block
		t.Errorf("the prompt has %d <report> tags", strings.Count(p, "<report>"))
	}
	if n := count(p); n > engReportsBudget+10_000 {
		t.Errorf("the prompt is %d characters", n)
	}

	// The goal's own budget in a task prompt.
	long := engTaskPromptText(engTaskPrompt{ID: "T09", Title: "x", Brief: "b", Goal: lines(1000)})
	if !strings.Contains(long, "jumps over it\n[The goal is cut here: the first 19,979 of 44,999 characters.]\n</goal>") {
		i := strings.Index(long, "[The goal is cut here")
		t.Errorf("the goal is not cut as it should be: %q", long[max(0, i-40):min(len(long), i+90)])
	}
}

// orchPrompt fills the prompt from the run's record: the wait the turn started under and what
// started it early, the wake mode, the turn limit, the tiers and the apply setting.
func TestOrchPromptFromRecord(t *testing.T) {
	e := newEngEnv(t, true)
	r := e.run("r_orch", func(m *model.RunMeta) {
		m.Tiers, m.Settings.Wake, m.Settings.MaxTurns, m.Settings.ApplyResult = engTestTiers, "", 45, "manual"
	})
	a := e.add(r, 0, "First task", true)
	turn := func(n int, mod func(t *Turn)) string {
		t.Helper()
		e.must(r, KTurnStarted, func(tx *Tx) error {
			for i := range tx.L().Turns {
				tx.L().Turns[i].Status = "done"
			}
			tn := Turn{N: n, Agent: AgentChatID(r.id, TurnAgentName(n)), Reason: "events", Status: "running", StartedAt: tx.Now(),
				Wait: &model.RunWait{Tasks: []string{a}, Mode: "all", Turn: n - 1}}
			mod(&tn)
			tx.AddTurn(tn)
			return nil
		})
		text, err := (&engine{r: r}).orchPrompt(t.Context(), n)
		if err != nil {
			t.Fatal(err)
		}
		return text
	}
	asked := "# Why you were started\n\nThe instance of turn 1 asked to be started again when all of " + a + " had ended. "
	chat := turn(2, func(t *Turn) { t.WokenBy = []model.RunEvent{{Seq: 1, Type: "chat_op", Chat: "c_1", Text: "changed"}} })
	for _, want := range []string{asked + "This instance is started before that, because a chat on the run changed it or left a message.",
		"`deep` (opus, high effort)", "`light` (sonnet, medium effort)", "You say when you are started again: `wait_for`", "the run is stopped after 45 turns.",
		"one that does not fit is given to it as a file to read.", "When the run has ended, the person applies the result to that folder with one action."} {
		if !strings.Contains(chat, want) {
			t.Errorf("the prompt of a turn a chat started does not contain %q", want)
		}
	}
	asked = strings.Replace(asked, "turn 1", "turn 2", 1)
	if failed := turn(3, func(t *Turn) { t.WokenBy = []model.RunEvent{{Seq: 2, Type: "task_failed", Task: a, Text: "failed"}} }); !strings.Contains(failed, asked+"This instance is started before that, because a task failed.") {
		t.Errorf("a turn a failure started:\n%s", failed)
	}
	asked = strings.Replace(asked, "turn 2", "turn 3", 1)
	if met := turn(4, func(t *Turn) { t.Reason, t.WaitMet = "wait", true }); !strings.Contains(met, asked+"That has happened.") || strings.Contains(met, "Nothing is running and nothing can start") {
		t.Errorf("a turn whose wait was met:\n%s", met)
	}
	asked = strings.Replace(asked, "turn 3", "turn 4", 1)
	if idle := turn(5, func(t *Turn) { t.Reason, t.Idle = "idle", true }); !strings.Contains(idle, asked+"This instance is started before that, because nothing is left running.") ||
		!strings.Contains(idle, "Nothing is running and nothing can start.") {
		t.Errorf("a turn started with nothing running:\n%s", idle)
	}
	if none := turn(6, func(t *Turn) { t.Wait = nil }); strings.Contains(none, "asked to be started again") {
		t.Errorf("a turn without a wait:\n%s", none)
	}
}
