package runs

import (
	"fmt"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// The reports warning: nothing up to three reports and 60,000 characters together; the count
// alone above three; the recorded sizes above 60,000 characters, and again on update_task.
func TestToolReportsWarning(t *testing.T) {
	x := newToolRun(t, false)
	x.turnStart("start")
	for i := 1; i <= 5; i++ {
		x.ok("orchestrator", "add_task", toolAdd(fmt.Sprintf("Read part %d", i), "research", false))
	}
	x.turnEnd("Five tasks.", 0.1)
	for i, size := range []int{20000, 20000, 20000, 61000} {
		tid := TaskID(i + 1)
		x.taskRuns(tid)
		x.taskResult(tid, "completed", "Read it.", strings.Repeat("x", size), 0.1)
		x.taskDone(tid)
	}
	x.turnStart("events")
	add := func(needs ...string) string {
		return x.ok("orchestrator", "add_task", toolArgsJSON(t, map[string]any{"title": "Decide", "brief": toolBrief, "kind": "design", "writes": false,
			"tier": "deep", "tier_reason": "The rest is built on it.", "depends_on": []string{"T01", "T02", "T03", "T04", "T05"}, "needs_report": needs}))
	}
	const rest = " to read before it writes a line. Name only the reports it cannot work without, and quote what it needs from the others in the brief."
	plain := "Added T06: Decide. It starts after your turn ends, once its dependencies are done."
	if got := add("T01", "T02", "T03"); got != plain {
		t.Errorf("three reports of 60,000 characters together: %q", got)
	}
	if got := add("T04"); got != strings.Replace(plain, "T06", "T07", 1)+" Note: its agent is given 1 full report(s), 61,000 characters so far,"+rest {
		t.Errorf("one report over 60,000 characters: %q", got)
	}
	// A task that has no result yet counts as a report and as no characters.
	if got := add("T05"); got != strings.Replace(plain, "T06", "T08", 1) {
		t.Errorf("a report that is not written yet: %q", got)
	}
	x.ok("orchestrator", "cancel_task", `{"id":"T05","reason":"not needed"}`)
	x.ok("orchestrator", "retry_task", `{"id":"T05","reason":"needed after all"}`)
	if got := x.ok("orchestrator", "update_task", `{"id":"T06","needs_report":["T01","T02","T03","T05"]}`); got !=
		"Updated T06 (needs_report). Note: its agent is given 4 full report(s), 60,000 characters so far,"+rest {
		t.Errorf("four reports on update_task: %q", got)
	}
	if got := x.ok("orchestrator", "update_task", `{"id":"T08","needs_report":["T02","T04"]}`); got !=
		"Updated T08 (needs_report). Note: its agent is given 2 full report(s), 81,000 characters so far,"+rest {
		t.Errorf("two reports over 60,000 characters on update_task: %q", got)
	}
	// The warning is about the task as it stands after the call, whatever the call changed.
	if got := x.ok("orchestrator", "update_task", `{"id":"T08","title":"Decide it"}`); !strings.HasSuffix(got, "81,000 characters so far,"+rest) {
		t.Errorf("an update of the title: %q", got)
	}
	if got := x.ok("orchestrator", "update_task", `{"id":"T08","needs_report":[]}`); got != "Updated T08 (needs_report)." {
		t.Errorf("no reports any more: %q", got)
	}
}

// update_task with depends_on and no needs_report keeps the reports of the tasks still depended
// on, in their order, and says so only when that changed the list.
func TestToolNeedsReportCut(t *testing.T) {
	x := newToolRun(t, false)
	x.turnStart("start")
	for i := 1; i <= 3; i++ {
		x.ok("orchestrator", "add_task", toolAdd(fmt.Sprintf("Read part %d", i), "research", false))
	}
	x.ok("orchestrator", "add_task", toolArgsJSON(t, map[string]any{"title": "Decide", "brief": toolBrief, "kind": "design", "writes": false,
		"tier": "deep", "tier_reason": "The rest is built on it.", "depends_on": []string{"T01", "T02", "T03"}, "needs_report": []string{"T03", "T01"}}))
	needs := func() string {
		tk, _ := toolTask(x.state(), "T04")
		return fmt.Sprint(tk.DependsOn, tk.NeedsReport)
	}
	if got := x.ok("orchestrator", "update_task", `{"id":"T04","depends_on":["T03","T01"]}`); got != "Updated T04 (depends_on)." || needs() != "[T03 T01] [T03 T01]" {
		t.Errorf("a dependency without a report is dropped: %q, %s", got, needs())
	}
	if got := x.ok("orchestrator", "update_task", `{"id":"T04","depends_on":["T01","T02"]}`); got != "Updated T04 (depends_on, needs_report)." || needs() != "[T01 T02] [T01]" {
		t.Errorf("a dependency with a report is dropped: %q, %s", got, needs())
	}
	// Given both, needs_report is checked against the new depends_on and is not cut.
	if text, isErr := x.orch("update_task", `{"id":"T04","depends_on":["T02"],"needs_report":["T01"]}`); !isErr ||
		text != "needs_report names tasks this one does not depend on: T01. Add them to depends_on as well." {
		t.Errorf("both, and they disagree: %q", text)
	}
	if got := x.ok("orchestrator", "update_task", `{"id":"T04","depends_on":[]}`); got != "Updated T04 (depends_on, needs_report)." || needs() != "[] []" {
		t.Errorf("no dependencies any more: %q, %s", got, needs())
	}
	tk, _ := toolTask(x.state(), "T04")
	if tk.NeedsReport == nil {
		t.Error("needsReport is null")
	}
	ops := x.state().Turns[0].Ops
	if op := ops[len(ops)-1]; len(op.NeedsReport) != 0 || op.Tier != model.TierDeep {
		t.Errorf("the op of the last update: %+v", op)
	}
}

// A retry on another tier is a new agent on that tier's model; a tier changed on a failed task is
// the one its next attempt runs on. The attempts that ran keep the tier they ran on.
func TestRetryOnAnotherTier(t *testing.T) {
	t.Parallel()
	h := newMx(t, false)
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			l := a.State()
			call := func(name string, args map[string]any) bool {
				text, isErr := a.Call(name, args)
				if isErr {
					a.Say(name + " was refused: " + text)
				}
				return !isErr
			}
			switch {
			case n == 1:
				for _, tier := range []string{"standard", "light"} {
					if !call("add_task", map[string]any{"title": "On " + tier, "kind": "research", "writes": false, "tier": tier,
						"tier_reason": "A later task checks it.", "brief": mxBrief("Look at it.")}) {
						return
					}
				}
				a.Say("Two tasks.")
			case len(l.Tasks[0].Attempts) == 1 && l.Tasks[0].State() == model.TaskFailed && l.Tasks[1].State() == model.TaskFailed:
				if !call("retry_task", map[string]any{"id": "T01", "reason": "It was too hard for its agent.", "tier": "deep"}) ||
					!call("update_task", map[string]any{"id": "T02", "tier": "deep"}) ||
					!call("retry_task", map[string]any{"id": "T02", "reason": "On the tier it has now."}) {
					return
				}
				a.Say("Again, higher.")
			case l.Tasks[0].State().Final() && l.Tasks[1].State().Final():
				a.Finish()
				a.Say("Finished.")
			default:
				a.Say("Waiting.")
			}
		},
		Task: func(a *mxTurn, tk Task) {
			if len(tk.Attempts) == 1 {
				a.Say(agentBlock("failed", "Could not do it.", "Too hard."))
				return
			}
			a.Done("Did it.")
		},
	})
	tiers := model.RunTiers{Deep: model.ModelChoice{Model: "opus", Effort: "high"}, Standard: model.ModelChoice{Model: "sonnet", Effort: "medium"},
		Light: model.ModelChoice{Model: "haiku"}}
	h.startRun(func(m *model.RunMeta) { m.Tiers = tiers })
	l := h.finished()

	t1, _ := mxTask(l, "T01")
	if len(t1.Attempts) != 2 || t1.Tier != model.TierDeep || t1.TierReason != "It was too hard for its agent." ||
		t1.Attempts[0].Tier != model.TierStandard || t1.Attempts[1].Tier != model.TierDeep || t1.Attempts[1].Outcome != model.TaskDone {
		t.Errorf("T01: tier %s (%s), attempts %+v", t1.Tier, t1.TierReason, t1.Attempts)
	}
	t2, _ := mxTask(l, "T02")
	if len(t2.Attempts) != 2 || t2.Tier != model.TierDeep || t2.TierReason != "A later task checks it." ||
		t2.Attempts[0].Tier != model.TierLight || t2.Attempts[1].Tier != model.TierDeep || t2.Attempts[1].Outcome != model.TaskDone {
		t.Errorf("T02: tier %s (%s), attempts %+v", t2.Tier, t2.TierReason, t2.Attempts)
	}
	got := map[string]string{}
	for _, a := range l.Agents {
		if a.Role == model.RoleTask {
			got[a.Name] = fmt.Sprintf("%s %s %s", a.Tier, a.Model, a.Effort)
		}
	}
	want := map[string]string{"T01-work": "standard sonnet medium", "T01-a2-work": "deep opus high", "T02-work": "light haiku ", "T02-a2-work": "deep opus high"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("the task agents ran on %v, want %v", got, want)
	}
	var ops []string
	for _, tn := range l.Turns {
		for _, op := range tn.Ops {
			if op.Error == "" && (op.Op == "retry_task" || op.Op == "update_task") {
				ops = append(ops, fmt.Sprintf("%s %s %s %v", op.Op, op.Task, op.Tier, op.Changed))
			}
		}
	}
	if fmt.Sprint(ops) != "[retry_task T01 deep [] update_task T02 deep [tier] retry_task T02 deep []]" {
		t.Errorf("ops: %v", ops)
	}
}
