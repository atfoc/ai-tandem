package runs

import (
	"fmt"
	"os"
	"strings"

	"ai-whiteboard/internal/model"
)

// This file is the context block of a person's chat on a run: what its agent is told, with every
// message, about the run it belongs to (as a board chat is told its board).

// ChatContext is the block put in front of every message of a person's chat on the run; "" when
// there is no such run. The chat manager calls it with a chat's lock held: it reads the run's
// published view, its published delivery and what the start fixed about git, takes no run's lock
// and calls nothing of the chat manager.
func (s *Service) ChatContext(id string) string {
	r, err := s.run(id)
	if err != nil {
		return ""
	}
	v := r.viewNow()
	s.mu.Lock()
	g, started := s.git[id]
	s.mu.Unlock()
	// The integration checkout is there from the engine's first act until the run has finished.
	st, err := os.Stat(g.integration)
	return svcChatContext(v, g, started, g.integration != "" && err == nil && st.IsDir(), r.delivery.Load())
}

// svcChatContext is the block from what ChatContext read: the run's view, where its work is in
// git (started: the run has started), whether the integration checkout is there, and the
// delivery as clients get it.
func svcChatContext(v model.RunView, g svcGit, started, checkedOut bool, d *model.RunDelivery) string {
	out := []string{"<ui-context>",
		fmt.Sprintf("This chat belongs to the run %q (id %s) in AI Whiteboard: an automated build run in which an orchestrator agent adds tasks and task agents carry them out. %s", v.Name, v.ID, svcViewLine(v)),
		"You are not one of the run's agents: you talk with the person about the run. Read it with get_run, get_task, get_agent and get_notes. Change tasks only when the person asks (add_task, update_task, cancel_task, retry_task), and pass the person's guidance on with tell_orchestrator. A task you add or change starts after your reply ends.",
		toolRunToolsNote}
	if started && v.Status != model.RunDraft {
		// add_task names a tier, so the chat is told what the three are.
		out = append(out, "Every task has a tier, which decides how capable an agent it gets and what it costs:", engTierLines(v.Tiers, ""),
			"Give a task the lowest tier that is safe for it and say why in tier_reason; keep it to one area of the code, and name in needs_report only the reports its agent cannot work without.")
	}
	switch {
	case !started || v.Status == model.RunDraft:
	case g.git:
		line := fmt.Sprintf("The run's merged work is on branch %s of %s", g.branch, g.repo)
		if checkedOut {
			line += fmt.Sprintf(", checked out at %s: read it there, and never change, commit or check out anything in that folder, because the run merges into it", g.integration)
		}
		out = append(out, line+". "+svcChatDelivery(v, g, d))
	default:
		out = append(out, fmt.Sprintf("The run's agents work directly in %s, which is also your working folder.", v.Cwd))
	}
	return strings.Join(append(out, "</ui-context>"), "\n")
}

// svcChatDelivery tells a chat on a git run where the run's result is with respect to its working
// folder, which is the person's own checkout: what the run will do with it while there is no
// delivery (the run is live, or halted with nothing tried), else what the last attempt came to.
func svcChatDelivery(v model.RunView, g svcGit, d *model.RunDelivery) string {
	short := func(c string) string { return c[:min(len(c), 12)] }
	switch {
	case d == nil:
		then := "when the run completes, the app applies the result to it unless that would touch uncommitted changes."
		if v.Settings.ApplyResult == "manual" {
			then = "the person applies the result from the run view when the run has ended."
		}
		return "Your working folder is the person's own checkout. The run does not change it while it is going; " + then
	case d.State == model.DeliveryApplied:
		if d.Result == "" {
			return "The run's result was applied to your working folder: its work is in the files you see."
		}
		return fmt.Sprintf("The run's result (commit %s) was applied to your working folder: its work is in the files you see.", short(d.Result))
	case d.State == model.DeliveryNone:
		return "Your working folder is the person's own checkout. The run's result has no changes to apply to it."
	}
	result := "The run's result is "
	if d.Result != "" {
		result += fmt.Sprintf("commit %s on ", short(d.Result))
	}
	return result + fmt.Sprintf("branch %s of %s. It has not been applied to your working folder: %s. The person can apply it with Apply in the run view. If they ask you to do it, run git merge %s in your working folder and resolve any conflict with them; never use force, reset or stash for it.",
		g.branch, g.repo, svcNotApplied(d.Reason), g.branch)
}

// svcNotApplied says in one clause why a result is not applied, by the delivery's reason.
func svcNotApplied(reason string) string {
	switch reason {
	case "manual":
		return "automatic applying is off for this run"
	case "not_achieved":
		return "the run did not reach its goal"
	case "halted":
		return "the run is stopped"
	case "other_branch":
		return "the folder is on another branch than the run started on"
	case "history_changed":
		return "the branch no longer contains the commit the run started from, and applying it brings that commit back"
	case "local_changes":
		return "uncommitted changes or files are in the way"
	case "conflict":
		return "the person's own commits conflict with it"
	case "busy":
		return "a git operation is in progress in the folder"
	case "folder_missing":
		return "the folder is missing"
	case "not_repo":
		return "the folder is no longer a git repository"
	case "result_missing":
		return "the result's commit could not be found"
	case "git":
		return "git refused it"
	}
	return "it has not been tried"
}

// toolRunToolsNote is engRunToolsNote as the context block words it: without the code marks.
var toolRunToolsNote = strings.ReplaceAll(engRunToolsNote, "`", "")

// svcViewLine is the first line of the get_run text, made from the run's view alone: its status,
// its turn, its tasks by status and what it has spent. The view counts the tasks by state, so
// the statuses stand in a fixed order here.
func svcViewLine(v model.RunView) string {
	if v.Status == model.RunDraft || v.Status == "" {
		return toolDraftRead(v.Name)
	}
	c := v.Counts
	var tasks []string
	for _, x := range []struct {
		n    int
		name string
	}{{c.Held + c.Deps + c.Blocked + c.Slot, "pending"}, {c.Setup + c.Work, "running"}, {c.Merge, "merging"},
		{c.Done, "done"}, {c.Failed, "failed"}, {c.Cancelled, "cancelled"}} {
		if x.n > 0 {
			tasks = append(tasks, fmt.Sprintf("%d %s", x.n, x.name))
		}
	}
	list := "none"
	if len(tasks) > 0 {
		list = strings.Join(tasks, ", ")
	}
	return fmt.Sprintf("Run %s: %s. Turn %d. Tasks: %s. %s", v.Name, toolRunSaid(v.Status, v.Reason), v.Turns, list, toolCostText(v.Cost, v.CostPartial, v.Agent, nil))
}
