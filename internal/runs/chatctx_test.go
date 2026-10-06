package runs

import (
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// engChatCases is the context block of a chat on a run in each state of the run and of its
// result's delivery, by the name of its golden file.
func engChatCases() map[string]string {
	g := svcGit{git: true, branch: "aiwb/r_x/integration", repo: "/repo", integration: "/work/aiwb-run-work/r_x/integration"}
	cost := 1.25
	live := model.RunView{ID: "r_x", Name: "Add the flag", Cwd: "/repo", Agent: model.Claude, Status: model.RunRunning, Turns: 2, Tiers: engTestTiers,
		Counts: model.RunCounts{Work: 1, Done: 1}, Cost: &cost}
	manual := live
	manual.Settings.ApplyResult = "manual"
	halted := live
	halted.Status, halted.Reason = model.RunStopped, "stopped by the user"
	done := live
	done.Status, done.Counts = model.RunCompleted, model.RunCounts{Done: 2}
	plain := live
	plain.Agent, plain.Cost = model.Cursor, nil // a kind that reports no cost
	plain.Tiers = model.RunTiers{Deep: model.ModelChoice{Model: "gpt-5"}, Standard: model.ModelChoice{Model: "gpt-5"}, Light: model.ModelChoice{Model: "gpt-5-mini"}}
	draft := model.RunView{ID: "r_x", Name: "Add the flag", Cwd: "/repo", Status: model.RunDraft, Tiers: engTestTiers}
	const result = "0123456789abffffffffffffffffffffffffffff"
	not := func(state model.RunDeliveryState, reason string) *model.RunDelivery {
		return &model.RunDelivery{State: state, Reason: reason, Result: result}
	}
	out := map[string]string{
		"chat_draft":       svcChatContext(draft, svcGit{}, false, false, nil),
		"chat_git_live":    svcChatContext(live, g, true, true, nil),
		"chat_git_manual":  svcChatContext(manual, g, true, true, nil),
		"chat_git_halted":  svcChatContext(halted, g, true, true, nil),
		"chat_git_applied": svcChatContext(done, g, true, false, &model.RunDelivery{State: model.DeliveryApplied, Result: result, Commit: result, How: "ff"}),
		"chat_git_none":    svcChatContext(done, g, true, false, &model.RunDelivery{State: model.DeliveryNone, Reason: "no_changes"}),
		"chat_no_effort":   svcChatContext(plain, g, true, true, nil),
		"chat_nogit":       svcChatContext(live, svcGit{}, true, false, nil),
	}
	gaveUp := done
	gaveUp.Status = model.RunGaveUp
	out["chat_git_pending_not_achieved"] = svcChatContext(gaveUp, g, true, false, not(model.DeliveryPending, "not_achieved"))
	for _, reason := range []string{"manual", "other_branch", "history_changed"} {
		out["chat_git_pending_"+reason] = svcChatContext(done, g, true, false, not(model.DeliveryPending, reason))
	}
	out["chat_git_pending_halted"] = svcChatContext(halted, g, true, true, not(model.DeliveryPending, "halted"))
	for _, reason := range []string{"local_changes", "conflict", "busy", "folder_missing", "not_repo", "result_missing", "git"} {
		out["chat_git_blocked_"+reason] = svcChatContext(done, g, true, false, not(model.DeliveryBlocked, reason))
	}
	return out
}

func TestPromptsGoldenChatContext(t *testing.T) {
	c := engChatCases()
	for name, text := range c {
		engGolden(t, name, text)
		if !strings.HasPrefix(text, "<ui-context>\n") || !strings.HasSuffix(text, "\n</ui-context>") || strings.Contains(text, "`") {
			t.Errorf("%s is not a plain context block:\n%s", name, text)
		}
	}
	has := func(name string, parts ...string) {
		t.Helper()
		for _, p := range parts {
			if !strings.Contains(c[name], p) {
				t.Errorf("%s does not contain %q", name, p)
			}
		}
	}
	tiers := "\nEvery task has a tier, which decides how capable an agent it gets and what it costs:\n  - deep (opus, high effort): the result is a decision"
	work := "The run's merged work is on branch aiwb/r_x/integration of /repo"
	has("chat_git_live", tiers, "\n  - standard (opus, medium effort): work from", "\n  - light (sonnet, medium effort): gathering facts",
		work+", checked out at /work/aiwb-run-work/r_x/integration: read it there",
		"because the run merges into it. Your working folder is the person's own checkout. The run does not change it while it is going; when the run completes, the app applies the result to it unless that would touch uncommitted changes.\n</ui-context>")
	has("chat_git_manual", "The run does not change it while it is going; the person applies the result from the run view when the run has ended.\n</ui-context>")
	has("chat_git_halted", "when the run completes, the app applies the result to it unless that would touch uncommitted changes.")
	has("chat_no_effort", "  - deep (gpt-5, default effort):", "  - light (gpt-5-mini, default effort):")
	has("chat_git_applied", tiers, work+". The run's result (commit 0123456789ab) was applied to your working folder: its work is in the files you see.\n</ui-context>")
	has("chat_git_pending_manual", work+". The run's result is commit 0123456789ab on branch aiwb/r_x/integration of /repo. It has not been applied to your working folder: automatic applying is off for this run. "+
		"The person can apply it with Apply in the run view. If they ask you to do it, run git merge aiwb/r_x/integration in your working folder and resolve any conflict with them; never use force, reset or stash for it.\n</ui-context>")
	for name, why := range map[string]string{
		"pending_not_achieved": "the run did not reach its goal", "pending_halted": "the run is stopped",
		"pending_other_branch":    "the folder is on another branch than the run started on",
		"pending_history_changed": "the branch no longer contains the commit the run started from, and applying it brings that commit back",
		"blocked_local_changes":   "uncommitted changes or files are in the way", "blocked_conflict": "the person's own commits conflict with it",
		"blocked_busy": "a git operation is in progress in the folder", "blocked_folder_missing": "the folder is missing",
		"blocked_not_repo": "the folder is no longer a git repository", "blocked_result_missing": "the result's commit could not be found",
		"blocked_git": "git refused it",
	} {
		has("chat_git_"+name, "It has not been applied to your working folder: "+why+". The person can apply it")
	}
	has("chat_nogit", tiers, "\nThe run's agents work directly in /repo, which is also your working folder.\n</ui-context>")
	if strings.Contains(c["chat_draft"], "tier") || strings.Contains(c["chat_nogit"], "appl") {
		t.Error("a draft's chat is told of tiers, or a chat on a run without git of applying a result")
	}
}
