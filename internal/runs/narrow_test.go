package runs

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/model"
)

// This file is what a task's agent is given of the tasks it depends on, in whole runs: the
// reports it needs (needs_report) while they fit, a file to read for the rest, and always the
// last attempt's.

// narrowReport is a report of exactly n characters that names its task in every line.
func narrowReport(id string, n int) string {
	line := id + " found this and wrote it down.\n"
	return strings.Repeat(line, n/len(line)+1)[:n-1] + "."
}

// narrowCall calls a run tool from a turn's script; false, with the refusal as the turn's answer,
// when it was refused.
func narrowCall(a *mxTurn, name string, args map[string]any) bool {
	text, isErr := a.Call(name, args)
	if isErr {
		a.Say(name + " was refused: " + text)
	}
	return !isErr
}

func narrowAdd(title string, deps, needs []string) map[string]any {
	args := map[string]any{"title": title, "kind": "research", "writes": false, "tier": "standard", "tier_reason": "A later task reads it.",
		"brief": mxBrief("Look at " + title + ".")}
	if deps != nil {
		args["depends_on"] = deps
	}
	if needs != nil {
		args["needs_report"] = needs
	}
	return args
}

// A whole run with needs_report. T04 depends on T01, T02, T03 and T05 and needs the reports of
// T03, T02 and T01, which are 100, 50,000 and 30,000 characters (T01, T02, T03). Its agent's
// prompt has the first two whole, in the order of the dependencies; the third does not fit the
// 60,000 characters and is named as a file, which is there with the report in it when the agent
// gets its first message. T05, which it does not need, is its summary and a file.
func TestNeedsReportInAWholeRun(t *testing.T) {
	t.Parallel()
	for _, git := range []bool{false, true} {
		t.Run(fmt.Sprintf("git %v", git), func(t *testing.T) {
			t.Parallel()
			reports := map[string]string{"T01": narrowReport("T01", 100), "T02": narrowReport("T02", 50000), "T03": narrowReport("T03", 30000),
				"T05": narrowReport("T05", 2000)}
			h := newMx(t, git)
			var mu sync.Mutex
			found := map[string]string{} // the readable copies as T04's agent finds them, by task
			h.plan(mxPlan{
				Turn: func(a *mxTurn, n int) {
					if n > 1 {
						mxFinishWhenDone(a)
						return
					}
					for _, title := range []string{"Part one", "Part two", "Part three"} {
						if !narrowCall(a, "add_task", narrowAdd(title, nil, nil)) {
							return
						}
					}
					if !narrowCall(a, "add_task", narrowAdd("Decide", []string{"T01", "T02", "T03"}, []string{"T03", "T02", "T01"})) ||
						!narrowCall(a, "add_task", narrowAdd("Part five", nil, nil)) ||
						!narrowCall(a, "update_task", map[string]any{"id": "T04", "depends_on": []string{"T01", "T02", "T03", "T05"}, "needs_report": []string{"T03", "T02", "T01"}}) ||
						!narrowCall(a, "wait_for", map[string]any{"tasks": []string{"T04"}}) {
						return
					}
					a.Say("Five tasks.")
				},
				Task: func(a *mxTurn, tk Task) {
					if tk.ID != "T04" {
						a.Say(agentBlock("completed", "The summary of "+tk.ID+".", reports[tk.ID]))
						return
					}
					if a.N == 1 {
						if r, err := a.w.s.run(h.id); err == nil {
							mu.Lock()
							for _, id := range []string{"T03", "T05"} {
								b, err := os.ReadFile(filepath.Join(r.ctxDir(), ctxReportRel(id, 1)))
								if err != nil {
									b = []byte("not there: " + err.Error())
								}
								found[id] = string(b)
							}
							mu.Unlock()
						}
					}
					a.Done("Decided.")
				},
			})
			h.startRun(nil)
			l := h.finished()

			t4, _ := mxTask(l, "T04")
			if fmt.Sprint(t4.DependsOn, t4.NeedsReport) != "[T01 T02 T03 T05] [T03 T02 T01]" {
				t.Fatalf("T04 depends on %v and needs %v", t4.DependsOn, t4.NeedsReport)
			}
			for id, rep := range reports {
				tk, _ := mxTask(l, id)
				if len(tk.Attempts) != 1 || tk.Attempts[0].Result == nil || tk.Attempts[0].Result.ReportSize != len(rep) {
					t.Fatalf("%s: its report of %d characters is recorded as %+v", id, len(rep), tk.Attempts)
				}
			}
			prompts := h.promptsOf("T04-work")
			if len(prompts) != 1 {
				t.Fatalf("T04's agent got %d messages", len(prompts))
			}
			p := prompts[0]
			path := func(id string) string { return filepath.Join(h.r().ctxDir(), ctxReportRel(id, 1)) }
			for _, id := range []string{"T01", "T02", "T03", "T05"} {
				if !strings.Contains(p, "The summary of "+id+".") {
					t.Errorf("the summary of %s is not in T04's prompt", id)
				}
			}
			// Whole, and in the order of the dependencies.
			one, two := strings.Index(p, "<report>\n"+reports["T01"]+"\n</report>"), strings.Index(p, "<report>\n"+reports["T02"]+"\n</report>")
			if one < 0 || two < 0 || one > two {
				t.Errorf("the reports of T01 and T02 are not whole and in order in T04's prompt (at %d and %d of %d characters)", one, two, len(p))
			}
			if strings.Contains(p, path("T01")) || strings.Contains(p, path("T02")) {
				t.Error("a report that is in the prompt is named as a file too")
			}
			// As files: nothing of the report is in the prompt, its path is.
			for _, id := range []string{"T03", "T05"} {
				if strings.Contains(p, reports[id][:60]) {
					t.Errorf("the report of %s is in T04's prompt", id)
				}
				if !strings.Contains(p, path(id)) {
					t.Errorf("T04's prompt does not name %s", path(id))
				}
				mu.Lock()
				got := found[id]
				mu.Unlock()
				if strings.TrimRight(got, "\n") != reports[id] {
					t.Errorf("%s when T04's agent got its first message: %d characters, want the report's %d: %.80q", path(id), len(got), len(reports[id]), got)
				}
			}
		})
	}
}

// A dependency that failed and was retried: the task that depends on it is given the summary and
// the report of its last attempt, in its prompt when it needs the report and as that attempt's
// file when it does not, and nothing of the first.
func TestRetriedDependencyGivesItsLastAttempt(t *testing.T) {
	t.Parallel()
	const first, second = "The first try found nothing usable.", "The second try found the three passes."
	h := newMx(t, false)
	var mu sync.Mutex
	found := "" // the readable copy of the second report as T03's agent finds it
	h.plan(mxPlan{
		Turn: func(a *mxTurn, n int) {
			l := a.State()
			switch {
			case n == 1:
				if !narrowCall(a, "add_task", narrowAdd("Read it", nil, nil)) ||
					!narrowCall(a, "add_task", narrowAdd("Decide", []string{"T01"}, []string{"T01"})) ||
					!narrowCall(a, "add_task", narrowAdd("Check", []string{"T01"}, nil)) {
					return
				}
				a.Say("Three tasks.")
			case len(l.Tasks[0].Attempts) == 1 && l.Tasks[0].State() == model.TaskFailed:
				if narrowCall(a, "retry_task", map[string]any{"id": "T01", "reason": "It should work now."}) {
					a.Say("Again.")
				}
			default:
				mxFinishWhenDone(a)
			}
		},
		Task: func(a *mxTurn, tk Task) {
			switch {
			case tk.ID == "T01" && len(tk.Attempts) == 1:
				a.Say(agentBlock("failed", "Summary one.", first))
			case tk.ID == "T01":
				a.Say(agentBlock("completed", "Summary two.", second))
			default:
				if r, err := a.w.s.run(h.id); err == nil && tk.ID == "T03" {
					b, err := os.ReadFile(filepath.Join(r.ctxDir(), ctxReportRel("T01", 2)))
					if err != nil {
						b = []byte("not there: " + err.Error())
					}
					mu.Lock()
					found = string(b)
					mu.Unlock()
				}
				a.Done("Did " + tk.ID + ".")
			}
		},
	})
	h.startRun(nil)
	l := h.finished()

	t1, _ := mxTask(l, "T01")
	if len(t1.Attempts) != 2 || t1.Attempts[0].Result == nil || t1.Attempts[0].Result.Summary != "Summary one." || t1.Attempts[0].Result.ReportSize != len(first) ||
		t1.Attempts[1].Result == nil || t1.Attempts[1].Result.Summary != "Summary two." {
		t.Fatalf("T01's attempts: %+v", t1.Attempts)
	}
	dir := h.r().ctxDir()
	a1, a2 := filepath.Join(dir, ctxReportRel("T01", 1)), filepath.Join(dir, ctxReportRel("T01", 2))
	for _, name := range []string{"T02-work", "T03-work"} {
		prompts := h.promptsOf(name)
		if len(prompts) != 1 {
			t.Fatalf("%s got %d messages", name, len(prompts))
		}
		p := prompts[0]
		if !strings.Contains(p, "Summary two.") || strings.Contains(p, "Summary one.") || strings.Contains(p, first) || strings.Contains(p, a1) {
			t.Errorf("%s is not given the last attempt of T01 alone:\n%s", name, p)
		}
		if needs := name == "T02-work"; strings.Contains(p, "<report>\n"+second+"\n</report>") != needs || strings.Contains(p, a2) == needs {
			t.Errorf("%s (needs the report: %v):\n%s", name, needs, p)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.TrimRight(found, "\n") != second {
		t.Errorf("%s when T03's agent got its message: %q", a2, found)
	}
}
