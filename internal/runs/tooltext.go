package runs

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"ai-whiteboard/internal/model"
)

// This file is the texts of the run tools: what each answers, the refusals, and the paging of
// long answers. snapshotText and eventLine are also the engine's: it puts them into the
// orchestrator's prompt. Nothing here takes a lock or reads a file: every function gets the
// records and the texts it writes about.

// The sizes of a tool's answer, in characters.
const (
	toolLimit      = 40000 // no answer of a run tool is longer
	toolPart       = 38800 // a longer text is returned this much at a time, cut at a line end
	toolBody       = 36000 // get_task: what the brief and the report share
	toolReportMin  = 24000 // get_task: the report's part when both do not fit
	toolLineBudget = 16000 // get_run: what the result and error lines of all tasks share
	toolShown      = 12    // get_run: the earlier turns and the chats' changes it lists
	toolFinalMax   = 20000 // get_agent: of the agent's final message
	toolLastSteps  = 15    // get_agent: steps by default
	toolMaxSteps   = 60
	toolMaxMessage = 4000  // tell_orchestrator
	toolNotesLimit = 20000 // set_notes, edit_notes: longer notes are saved with a notice
)

// The refusals and answers that do not depend on the call (T13 §8.1 and §8.2), verbatim.
const (
	toolNotObject    = "the arguments must be an object"
	toolChatNotes    = "The notes are the orchestrator's own memory, so a chat does not write them. To pass something on, use tell_orchestrator; to change the work, change the tasks."
	toolChatWait     = "wait_for is the orchestrator's: it says when its own next turn starts. A chat on the run does not wait; get_run shows what is running."
	toolChatFinish   = "Only the orchestrator ends the run, with its verdict on the goal. The person can stop the run in its view; you can cancel tasks or tell the orchestrator what the person wants."
	toolOrchTell     = "tell_orchestrator is for chats on the run; your own memory is the notes"
	toolDraftChange  = "the run has not started: its goal is still being written in the app. Nothing can be changed yet."
	toolFinished     = "the run is finished; nothing more can be changed"
	toolStopping     = "the run is stopping; try again when it has stopped"
	toolArchived     = "the run is archived; nothing can be changed until the person unarchives it"
	toolGateOrch     = "The notes are empty, so a task that changes files is refused. First record with set_notes what the goal requires, what done means and how it will be checked, and the approach the facts support. If you cannot write that yet, the run needs tasks that investigate (writes: false) before tasks that build."
	toolGateChat     = "The run's notes are empty, so a task that changes files is refused: the orchestrator has not yet recorded what done means. Add a task that investigates (writes: false), or tell the orchestrator what the person wants."
	toolNoNotes      = "The run has no notes yet."
	toolFinishResult = "The run ends when your turn does."
	toolAgentNames   = "Agents are named turn-007 (an orchestrator turn), T03-work, T03-a2-work (attempt 2), T03-merge and T03-merge-r2 (a later merge round); get_task lists the agents of a task."
)

func toolTurnOver(name string) string {
	return "the orchestrator's turn is over; " + name + " was not run"
}

func toolDraftRead(run string) string {
	return "Run " + run + " has not started: its goal is still being written in the app. There is nothing to read yet."
}

// ---- small things ---------------------------------------------------------------

// toolNum is n with a comma between its thousands: 63,509.
func toolNum(n int) string {
	s := strconv.Itoa(n)
	neg := strings.HasPrefix(s, "-")
	s = strings.TrimPrefix(s, "-")
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	if neg {
		return "-" + s
	}
	return s
}

// toolChars is the length of a text as the tools count it: characters, not bytes.
func toolChars(s string) int { return utf8.RuneCountInString(s) }

// toolDur is a duration as the tools write it: 42s, 5m27s, 1h05m.
func toolDur(ms int64) string {
	s := (ms + 500) / 1000
	if s < 0 {
		s = 0
	}
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	m, s := s/60, s%60
	if m < 60 {
		return fmt.Sprintf("%dm%02ds", m, s)
	}
	return fmt.Sprintf("%dh%02dm", m/60, m%60)
}

// toolLine is s on one line (every run of white space becomes one space), cut to max characters.
func toolLine(s string, max int) string { return clip(strings.Join(strings.Fields(s), " "), max) }

// toolHead is the first n characters of s.
func toolHead(s string, n int) string {
	if toolChars(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// toolQuote is an id as a refusal names it: in single quotes, cut when it is very long.
func toolQuote(s string) string { return "'" + clip(s, 80) + "'" }

func toolWrites(writes bool) string {
	if writes {
		return "writes"
	}
	return "reports only"
}

// toolWho says who wrote a notes version or a brief revision.
func toolWho(turn int) string {
	if turn > 0 {
		return fmt.Sprintf("in turn %d", turn)
	}
	return "by a chat on the run"
}

// ---- paging -----------------------------------------------------------------------

// toolPage is the paging every run tool ends with: a text of at most toolLimit characters is
// returned whole; a longer one, or one asked for from an offset, is returned a part at a time, cut
// at a line end, with a last line that says where the part is and how to get the next. args is
// what the call must repeat (` id "T03",`), room how many characters come on top of the part (a
// heading). An offset past the end is a refusal.
func toolPage(text string, offset int, tool, args string, room int) (out, refusal string) {
	r := []rune(text)
	if offset <= 0 && len(r)+room <= toolLimit {
		return text, ""
	}
	if offset < 0 {
		offset = 0
	}
	if offset >= len(r) {
		return "", fmt.Sprintf("offset %d is past the end: the answer has %s characters.", offset, toolNum(len(r)))
	}
	size := toolPart - room
	if size < toolPart/2 {
		size = toolPart / 2
	}
	end := min(len(r), offset+size)
	if end < len(r) {
		for i := end - 1; i > offset+size/2; i-- { // back to the last line end, when that keeps half
			if r[i] == '\n' {
				end = i + 1
				break
			}
		}
	}
	part := string(r[offset:end])
	where := fmt.Sprintf("Characters %s–%s of %s", toolNum(offset+1), toolNum(end), toolNum(len(r)))
	if end < len(r) {
		return part + fmt.Sprintf("\n\n[%s. Call %s again with%s offset %d for the next part.]", where, tool, args, end), ""
	}
	return part + "\n\n[" + where + ": the end.]", ""
}

// ---- task states ----------------------------------------------------------------------

// toolCoarse is a task state as the tools name it: the script's six statuses.
func toolCoarse(s model.TaskState) string {
	switch {
	case s.Waiting():
		return "pending"
	case s == model.TaskMerge:
		return "merging"
	case s.Active():
		return "running"
	}
	return string(s)
}

// toolTaskState says what a task is doing. callerTurn is the turn of the orchestrator that reads
// (its own holds are "the current turn"); 0 for anyone else.
func toolTaskState(l *Loaded, t Task, callerTurn int) string {
	st := t.State()
	var last model.RunPhase
	if n := len(t.Attempts); n > 0 {
		if p := t.Attempts[n-1].Phases; len(p) > 0 {
			last = p[len(p)-1]
		}
	}
	switch st {
	case model.TaskHeld:
		turn, chat := last.Turn, last.Chat
		if last.K != model.TaskHeld && len(t.HeldBy) > 0 {
			turn, chat = t.HeldBy[0].Turn, t.HeldBy[0].Chat
		}
		switch {
		case chat != "":
			return "pending, starts when the chat that changed it ends its reply"
		case turn == 0 || turn == callerTurn:
			return "pending, starts when the current turn ends"
		}
		return fmt.Sprintf("pending, starts when turn %d ends", turn)
	case model.TaskBlocked:
		on := make([]string, 0, len(last.On))
		for _, id := range last.On {
			on = append(on, id+" ("+toolCoarse(toolStateOf(l, id))+")")
		}
		return "pending, blocked by " + strings.Join(on, ", ")
	case model.TaskDeps:
		return "pending, waiting on " + strings.Join(last.On, ", ")
	case model.TaskSlot:
		return "pending, ready to start"
	}
	return toolCoarse(st)
}

func toolTask(l *Loaded, id string) (Task, bool) {
	for i := range l.Tasks {
		if l.Tasks[i].ID == id {
			return l.Tasks[i], true
		}
	}
	return Task{}, false
}

func toolStateOf(l *Loaded, id string) model.TaskState {
	t, ok := toolTask(l, id)
	if !ok {
		return ""
	}
	return t.State()
}

// toolNoTask is the refusal for task ids the run does not have.
func toolNoTask(l *Loaded, ids ...string) string {
	quoted := make([]string, len(ids))
	for i, id := range ids {
		quoted[i] = toolQuote(id)
	}
	have := "there are no tasks yet"
	switch n := len(l.Tasks); {
	case n == 1:
		have = "the run has one task, " + l.Tasks[0].ID
	case n > 1:
		have = "the run has tasks " + l.Tasks[0].ID + " to " + l.Tasks[n-1].ID
	}
	return "there is no task " + strings.Join(quoted, ", ") + " (" + have + ")"
}

// toolDepWarning is what add, update and retry append when a dependency is failed or cancelled.
func toolDepWarning(state func(id string) model.TaskState, deps []string) string {
	var bad []string
	for _, d := range deps {
		if s := state(d); s == model.TaskFailed || s == model.TaskCancelled {
			bad = append(bad, d+" ("+string(s)+")")
		}
	}
	if len(bad) == 0 {
		return ""
	}
	return " Note: it depends on " + strings.Join(bad, ", ") + " and will not start until that is retried and done, or the dependency is removed."
}

// The reading a task may start with before toolReportsWarning speaks: the reports named in
// needs_report, and their characters together (the budget of a task prompt's reports).
const (
	toolReportsMany  = 3
	toolReportsLimit = 60000
)

// toolReportsWarning is what add and update append when a task is given more reading than a task
// should start with. The sizes are the recorded ones of each named task's last attempt; a task
// without a result yet counts as 0.
func toolReportsWarning(l *Loaded, t Task) string {
	n, size := len(t.NeedsReport), 0
	for _, id := range t.NeedsReport {
		if d, ok := toolTask(l, id); ok {
			if r := toolLastAttempt(d).Result; r != nil {
				size += r.ReportSize
			}
		}
	}
	if n <= toolReportsMany && size <= toolReportsLimit {
		return ""
	}
	text := fmt.Sprintf(" Note: its agent is given %d full report(s)", n)
	if size > 0 {
		text += ", " + toolNum(size) + " characters so far,"
	}
	return text + " to read before it writes a line. Name only the reports it cannot work without, and quote what it needs from the others in the brief."
}

// toolTaskCosts is what each task has cost so far: the sum over the run's agents of that task
// (every attempt, work and merge), with the live value of one that is running.
func toolTaskCosts(l *Loaded, live map[string]Live) map[string]float64 {
	costs := map[string]float64{}
	for _, a := range l.Agents {
		if a.Task == "" {
			continue
		}
		if c := a.View(live[a.ID]).Cost; c != nil {
			costs[a.Task] += *c
		}
	}
	return costs
}

// toolNotesSaved is the answer of set_notes and edit_notes: what was done, the size of the notes
// and their version, and the notice when they are long.
func toolNotesSaved(done string, size, v int) string {
	text := fmt.Sprintf("%s; the notes are %s characters (version %d).", done, toolNum(size), v)
	if size > toolNotesLimit {
		text += " They are over " + toolNum(toolNotesLimit) + " characters, and every instance reads all of them: shorten them, keeping what the next instance needs to decide."
	}
	return text
}

// toolWaitText is get_run's line on when the next turn starts, while a wait is set.
func toolWaitText(w *model.RunWait) string {
	return fmt.Sprintf("Next turn: when %s of %s have ended (asked in turn %d), or earlier if a task fails, nothing is left running, or a chat on the run changes it.",
		toolWaitMode(w.Mode), strings.Join(w.Tasks, ", "), w.Turn)
}

// toolWaitMode is a wait's mode as the texts say it: all unless it is any.
func toolWaitMode(mode string) string {
	if mode == "any" {
		return "any"
	}
	return "all"
}

// toolTierOf is a tier as the texts name it: a task recorded before tiers runs on standard.
func toolTierOf(t model.Tier) model.Tier {
	if t == "" {
		return model.TierStandard
	}
	return t
}

// ---- get_run ----------------------------------------------------------------------------

// gitFacts is what a run's snapshot text says of the integration branch. The caller reads it with
// git before it takes any lock (run.gitFacts), so a git failure changes nothing.
type gitFacts struct {
	Head    string // the integration branch's head; "" for a run without git
	Commits int    // the commits on it since the run's base
}

// snapshotText is the run as an orchestrator or a chat reads it: the text of the get_run tool
// without its "New since you last looked" part (its status and limits, every task with its
// status and the summary of its result, what is running, the earlier turns; the notes are not in
// it). The engine puts it into the orchestrator's prompt between <run> and </run>. l is a
// snapshot of the recorded state (Loaded.snapshot, taken under run.mu); nothing is read from
// disk and no lock is taken here.
//
// It is the whole text, never a page of it. It is written for the turn that is running (the last
// one, when its status is running): what that turn holds "starts when the current turn ends",
// and that turn is not among the earlier ones. Durations of what is running are counted up to the
// last time the record has, and the cost is the recorded one.
func snapshotText(meta model.RunMeta, l *Loaded, g gitFacts) string {
	o := toolRunOpts{}
	if l != nil {
		o.now = toolLastTime(l)
		if n := len(l.Turns); n > 0 && l.Turns[n-1].Status == "running" {
			o.callerTurn = l.Turns[n-1].N
		}
	}
	return toolRunText(meta, l, g, o)
}

// eventLine is one event as a line of "Since the last orchestrator turn" (the prompt) and of
// "New since you last looked" (get_run): `- {task} finished. {text}` for a task_done,
// `- {task} failed. {text}` for a task_failed, `- {text}` for a chat_op. No newline at the end.
func eventLine(e model.RunEvent) string {
	switch e.Type {
	case "task_done":
		return "- " + e.Task + " finished. " + e.Text
	case "task_failed":
		return "- " + e.Task + " failed. " + e.Text
	}
	return "- " + e.Text
}

// toolRunOpts is what get_run's text depends on besides the record.
type toolRunOpts struct {
	now        int64           // up to when the durations of what is running are counted
	callerTurn int             // the reading orchestrator's own turn; 0 for a chat
	live       map[string]Live // the running agents' live cost; nil: the recorded one
}

// toolRunText is the get_run text without "New since you last looked".
func toolRunText(meta model.RunMeta, l *Loaded, g gitFacts, o toolRunOpts) string {
	if l == nil {
		return toolDraftRead(meta.Name)
	}
	sum := withLiveCost(l.Summarize(meta.Agent == model.Cursor), l, o.live)
	agents := make(map[string]Agent, len(l.Agents))
	for _, a := range l.Agents {
		agents[a.ID] = a
	}

	// the head: status, counts, cost; limits; the integration branch
	type count struct {
		name string
		n    int
	}
	var counts []count
	busy := 0
	for _, t := range l.Tasks {
		st := t.State()
		if st.Active() {
			busy++
		}
		name := toolCoarse(st)
		if i := slices.IndexFunc(counts, func(c count) bool { return c.name == name }); i >= 0 {
			counts[i].n++
		} else {
			counts = append(counts, count{name, 1})
		}
	}
	tasks := "none"
	if len(counts) > 0 {
		parts := make([]string, len(counts))
		for i, c := range counts {
			parts[i] = fmt.Sprintf("%d %s", c.n, c.name)
		}
		tasks = strings.Join(parts, ", ")
	}
	// The orchestrator's share: the cost of the agents that are no task's (toolTaskCosts has the others).
	costs := toolTaskCosts(l, o.live)
	var orch *float64
	if sum.Cost != nil {
		own := 0.0
		for _, a := range l.Agents {
			if c := a.View(o.live[a.ID]).Cost; a.Task == "" && c != nil {
				own += *c
			}
		}
		orch = &own
	}
	out := []string{fmt.Sprintf("Run %s: %s. Turn %d. Tasks: %s. %s", meta.Name, toolRunSaid(l.State.Status, l.State.Reason),
		len(l.Turns), tasks, toolCostText(sum.Cost, sum.CostPartial, meta.Agent, orch))}
	set := meta.Settings
	lim := []string{fmt.Sprintf("turn %d of %d", len(l.Turns), set.MaxTurns)}
	if set.MaxCost > 0 && sum.Cost != nil { // a kind that reports no cost has no cost limit
		lim = append(lim, fmt.Sprintf("$%.2f of $%.2f", *sum.Cost, set.MaxCost))
	}
	lim = append(lim, fmt.Sprintf("%d of %s busy", busy, toolCount(set.MaxParallel, "task slot")))
	if l.State.IdleStreak > 0 {
		lim = append(lim, fmt.Sprintf("%d of %s in a row", l.State.IdleStreak, toolCount(set.MaxIdleTurns, "idle turn")))
	}
	out = append(out, "Limits: "+strings.Join(lim, ", ")+".")
	if w := l.State.Wait; w != nil {
		out = append(out, toolWaitText(w))
	}
	if gt := l.State.Git; gt != nil {
		head := g.Head
		if head == "" {
			head = gt.ResultHead
		}
		if head == "" {
			head = gt.BaseRef
		}
		if d := l.State.Delivery; d != nil && d.State == model.DeliveryApplied {
			// The integration branch went when the result was applied: the result is in the folder.
			at := d.Commit
			if at == "" {
				at = head
			}
			where := "a detached HEAD"
			if d.Branch != "" {
				where = "branch " + d.Branch
			}
			out = append(out, fmt.Sprintf("The run's result was applied to the person's working folder, %s at %s, %d commit(s) since the run started from %s.",
				where, toolHead(at, 12), g.Commits, toolHead(gt.BaseRef, 12)))
		} else {
			out = append(out, fmt.Sprintf("Integration branch %s at %s, %d commit(s) since the run started from %s.",
				gt.IntegrationBranch, toolHead(head, 12), g.Commits, toolHead(gt.BaseRef, 12)))
		}
	}

	out = append(out, "", "## Notes", "")
	if n := len(l.Notes); n > 0 {
		nv := l.Notes[n-1]
		out = append(out, fmt.Sprintf("Version %d, %s characters, written %s. `get_notes` returns them.", nv.V, toolNum(nv.Size), toolWho(nv.Turn)))
	} else {
		out = append(out, "(empty)")
	}

	out = append(out, "", "## Tasks", "")
	lines := 0
	for _, t := range l.Tasks {
		if a := toolLastAttempt(t); a.Error != "" || a.Result != nil {
			lines++
		}
	}
	width := max(120, min(400, toolLineBudget/max(1, lines)))
	for _, t := range l.Tasks {
		a, st := toolLastAttempt(t), t.State()
		line := fmt.Sprintf("%s [%s, %s, %s] %s", t.ID, t.Kind, toolWrites(t.Writes), toolTierOf(t.Tier), toolTaskState(l, t, o.callerTurn))
		if st.Active() && a.StartedAt > 0 {
			line += " for " + toolDur(o.now-a.StartedAt)
			id := a.Agents.Work
			if st == model.TaskMerge && a.Agents.Merge != "" {
				id = a.Agents.Merge
			}
			if ag, ok := agents[id]; ok && ag.Name != "" {
				line += " (agent " + ag.Name + ")"
			}
		}
		if a.N > 1 {
			line += fmt.Sprintf(", attempt %d", a.N)
		}
		if c := costs[t.ID]; c > 0 {
			line += fmt.Sprintf(", $%.2f", c)
		}
		line += ": " + t.Title
		if len(t.DependsOn) > 0 {
			line += " (depends on " + strings.Join(t.DependsOn, ", ") + ")"
		}
		out = append(out, line)
		switch {
		case a.Error != "":
			out = append(out, "    error: "+toolLine(a.Error, width))
		case a.Result != nil:
			out = append(out, "    result: "+toolLine(a.Result.Summary, width))
		}
	}
	if len(l.Tasks) == 0 {
		out = append(out, "(no tasks yet)")
	}

	var earlier []Turn
	for _, t := range l.Turns {
		if t.N != o.callerTurn && t.Status != "running" {
			earlier = append(earlier, t)
		}
	}
	if n := len(earlier); n > toolShown {
		earlier = earlier[n-toolShown:]
	}
	if len(earlier) > 0 {
		out = append(out, "", "## Earlier turns", "")
		for _, t := range earlier {
			var did []string
			for _, op := range t.Ops {
				if op.Error == "" && !strings.HasPrefix(op.Op, "get_") {
					did = append(did, toolOpName(op))
				}
			}
			what := "no changes"
			if len(did) > 0 {
				what = strings.Join(did, ", ")
			}
			msg := "(no message)"
			switch {
			case t.Summary != "":
				msg = toolLine(t.Summary, 500)
			case t.Error != "":
				msg = "failed: " + toolLine(t.Error, 400)
			}
			out = append(out, fmt.Sprintf("Turn %d (%s): %s", t.N, what, msg))
		}
	}

	if n := len(l.ChatOps); n > 0 {
		out = append(out, "", "## Changes made by chats on the run", "")
		for _, op := range l.ChatOps[max(0, n-toolShown):] {
			what := toolOpName(op)
			if op.Error != "" {
				what += ", refused"
			}
			about := op.Reason
			if about == "" {
				about = op.Text
			}
			if about == "" {
				about = op.Title
			}
			if about == "" { // a refused call records nothing but why it was refused
				about = op.Error
			}
			out = append(out, fmt.Sprintf("After turn %d (%s): %s", op.Turn, what, toolLine(about, 300)))
		}
	}
	return strings.Join(out, "\n")
}

// toolNewSince is get_run's last part: the events the reading turn had not been told about.
func toolNewSince(events []model.RunEvent) string {
	if len(events) == 0 {
		return ""
	}
	out := []string{"", "", "## New since you last looked", ""}
	for _, e := range events {
		out = append(out, eventLine(e))
	}
	return strings.Join(out, "\n")
}

// toolRunSaid is the run's status in a sentence, with the reason of a halt.
func toolRunSaid(st model.RunStatus, reason string) string {
	said := string(st)
	switch st {
	case model.RunError:
		said = "stopped by an error"
	case model.RunCompleted:
		return "completed, goal achieved"
	case model.RunGaveUp:
		return "ended, goal not achieved"
	}
	if reason == "stopped by the user" { // the record's words for a person's stop; the texts say "the person"
		reason = "stopped by the person"
	}
	if reason != "" && (st == model.RunStopped || st == model.RunStalled || st == model.RunError) {
		said += " (" + strings.TrimRight(toolLine(reason, 400), ".") + ")"
	}
	return said
}

// toolCostText is what the run has spent, in a sentence. kind is the kind of the run's agents,
// named when it reports no cost; orch is the orchestrator's share, nil where it is not said.
func toolCostText(cost *float64, partial bool, kind model.AgentKind, orch *float64) string {
	if cost == nil {
		return fmt.Sprintf("Cost unknown: the run's agents (%s) report none.", svcAgentName(kind))
	}
	var notes []string
	if orch != nil {
		notes = append(notes, fmt.Sprintf("orchestrator $%.2f", *orch))
	}
	if partial {
		notes = append(notes, "some agents reported no cost")
	}
	if len(notes) == 0 {
		return fmt.Sprintf("Spent $%.2f.", *cost)
	}
	return fmt.Sprintf("Spent $%.2f (%s).", *cost, strings.Join(notes, ", "))
}

// toolOpName is a call as the lists of get_run name it: the tool, and the task it was about.
func toolOpName(op model.RunOp) string {
	if op.Task != "" {
		return op.Op + " " + op.Task
	}
	return op.Op
}

func toolLastAttempt(t Task) Attempt {
	if n := len(t.Attempts); n > 0 {
		return t.Attempts[n-1]
	}
	return Attempt{}
}

// toolLastTime is the latest time the record has: when its last entry was written, as near as
// the records say.
func toolLastTime(l *Loaded) int64 {
	t := max(l.State.StartedAt, l.State.AsOf, l.State.EndedAt)
	for _, e := range l.State.Inbox {
		t = max(t, e.T)
	}
	for _, s := range l.Stops {
		t = max(t, s.At, s.ResumedAt)
	}
	for _, n := range l.Notes {
		t = max(t, n.At)
	}
	for _, tn := range l.Turns {
		t = max(t, tn.StartedAt, tn.EndedAt)
		for _, op := range tn.Ops {
			t = max(t, op.T)
		}
	}
	for _, op := range l.ChatOps {
		t = max(t, op.T)
	}
	for _, tk := range l.Tasks {
		t = max(t, tk.CreatedAt)
		for _, a := range tk.Attempts {
			t = max(t, a.QueuedAt, a.StartedAt, a.EndedAt, a.MergedAt)
			for _, p := range a.Phases {
				t = max(t, p.T)
			}
		}
	}
	for _, a := range l.Agents {
		t = max(t, a.StartedAt, a.EndedAt)
		for _, ln := range a.Launches {
			t = max(t, ln.StartedAt, ln.EndedAt)
		}
	}
	return t
}

// ---- get_task -----------------------------------------------------------------------------

// toolTaskIn is what get_task's text is made of, read by the caller: the record, and the files of
// the task.
type toolTaskIn struct {
	l       *Loaded
	task    Task
	attempt Attempt // the one asked for; the latest by default
	asked   bool    // the call named the attempt
	brief   string  // the brief in force
	report  string  // the attempt's report; "" when there is none
	changes *model.AttemptChanges
	live    map[string]Live
	now     int64
}

// toolSplit is how many characters of the brief and of the report get_task shows when it is
// asked for the whole task: both whole when together they fit toolBody, else the report gets
// what the brief leaves, but at least toolReportMin, and the brief the rest.
func toolSplit(brief, report int) (b, r int) {
	if brief+report <= toolBody {
		return brief, report
	}
	r = min(report, max(toolBody-brief, toolReportMin))
	return min(brief, toolBody-r), r
}

// toolTaskArgs is what a continued get_task must repeat.
func toolTaskArgs(in toolTaskIn, part string) string {
	args := fmt.Sprintf(" id %q,", in.task.ID)
	if part != "" {
		args += fmt.Sprintf(" part %q,", part)
	}
	if in.asked {
		args += fmt.Sprintf(" attempt %d,", in.attempt.N)
	}
	return args
}

// toolTaskBrief is get_task with part "brief": the brief alone, in full, a part at a time.
func toolTaskBrief(in toolTaskIn, offset int) (text, refusal string) {
	t := in.task
	head := fmt.Sprintf("# %s: brief, revision %d of %d (%s characters)\n\n", t.ID, t.BriefRev, len(t.Briefs), toolNum(toolChars(in.brief)))
	body, refusal := toolPage(in.brief, offset, "get_task", toolTaskArgs(in, "brief"), toolChars(head))
	if refusal != "" {
		return "", refusal
	}
	return head + body, ""
}

// toolTaskReport is get_task with part "report": the summary and the report of one attempt, the
// report in full, a part at a time.
func toolTaskReport(in toolTaskIn, offset int) (text, refusal string) {
	t, a := in.task, in.attempt
	if a.Result == nil {
		return fmt.Sprintf("%s has no report yet (attempt %d).", t.ID, a.N), ""
	}
	head := fmt.Sprintf("# %s: report of attempt %d (%s, %s characters)\n\n", t.ID, a.N, a.Result.Outcome, toolNum(toolChars(in.report)))
	if offset <= 0 {
		head += clip(a.Result.Summary, 8000) + "\n\n"
	}
	report := in.report
	if report == "" {
		report = "(no report)"
	}
	body, refusal := toolPage(report, offset, "get_task", toolTaskArgs(in, "report"), toolChars(head))
	if refusal != "" {
		return "", refusal
	}
	return head + body, ""
}

// toolTaskText is get_task's answer for the whole task.
func toolTaskText(in toolTaskIn, offset int) (text, refusal string) {
	l, t, a := in.l, in.task, in.attempt
	latest := toolLastAttempt(t)
	out := []string{fmt.Sprintf("# %s [%s, %s] %s", t.ID, t.Kind, toolWrites(t.Writes), t.Title), ""}
	switch {
	case a.N != latest.N:
		how := string(a.Outcome)
		if how == "" {
			how = "not finished"
		}
		out = append(out, fmt.Sprintf("Status: %s (attempt %d of %d)", how, a.N, latest.N))
	case a.N > 1:
		out = append(out, fmt.Sprintf("Status: %s (attempt %d)", toolTaskState(l, t, 0), a.N))
	default:
		out = append(out, "Status: "+toolTaskState(l, t, 0))
	}
	line := "Tier: " + string(toolTierOf(t.Tier))
	if t.TierReason != "" {
		line += " (" + t.TierReason + ")"
	}
	if a.Tier != "" && a.Tier != toolTierOf(t.Tier) { // the tier was changed after this attempt was queued
		line += fmt.Sprintf("; attempt %d ran on %s", a.N, a.Tier)
	}
	out = append(out, line)
	line = "Depends on: " + toolIDs(t.DependsOn)
	if len(t.NeedsReport) > 0 {
		line += " (given the full report of " + strings.Join(t.NeedsReport, ", ") + ")"
	}
	out = append(out, line)
	var needed []string
	for _, x := range l.Tasks {
		if slices.Contains(x.DependsOn, t.ID) {
			needed = append(needed, x.ID)
		}
	}
	out = append(out, "Needed by: "+toolIDs(needed))
	added := fmt.Sprintf("Added in turn %d", t.AddedTurn)
	if t.AddedBy != "" {
		added = fmt.Sprintf("Added by a chat on the run after turn %d", t.AddedTurn)
	}
	if len(t.ChangedTurns) > 0 {
		turns := make([]string, len(t.ChangedTurns))
		for i, n := range t.ChangedTurns {
			turns[i] = strconv.Itoa(n)
		}
		added += ", changed in turn " + strings.Join(turns, ", ")
	}
	out = append(out, added)
	if a.StartedAt > 0 {
		end := a.EndedAt
		if end == 0 {
			end = in.now
		}
		out = append(out, "Time: "+toolDur(end-a.StartedAt))
	}
	if a.Error != "" {
		out = append(out, "Error: "+a.Error)
	}
	if a.Cancel != nil {
		out = append(out, "Cancelled: "+a.Cancel.Reason)
	}
	switch {
	case a.Branch != "" && a.Head != "":
		how := ", not merged"
		switch {
		case a.Merged != "":
			how = ", merged into the integration branch"
		case a.Head == a.Base:
			how = ", no changes"
		}
		out = append(out, fmt.Sprintf("Commits: %s..%s on branch %s%s", toolHead(a.Base, 12), toolHead(a.Head, 12), a.Branch, how))
		if c := in.changes; c != nil && len(c.Files) > 0 {
			out = append(out, fmt.Sprintf("%d file(s) changed, +%d -%d:", len(c.Files), c.Add, c.Del))
			for i, f := range c.Files {
				if i == 30 {
					out = append(out, fmt.Sprintf("  … and %d more", len(c.Files)-30))
					break
				}
				out = append(out, fmt.Sprintf("  %s +%d -%d", f.Path, f.Add, f.Del))
			}
		}
	case a.Branch != "" && (a.Outcome == model.TaskFailed || a.Outcome == model.TaskCancelled):
		out = append(out, fmt.Sprintf("Whatever it changed before it stopped is on branch %s, not merged.", a.Branch))
	}
	if len(a.Conflicts) > 0 {
		out = append(out, "Merge conflicts resolved by an agent in: "+strings.Join(a.Conflicts, ", "))
	}

	var ags []Agent
	for _, g := range l.Agents {
		if g.Task == t.ID {
			ags = append(ags, g)
		}
	}
	if len(ags) > 0 {
		slices.SortStableFunc(ags, func(x, y Agent) int { return int(x.StartedAt - y.StartedAt) })
		out = append(out, "", "Agents:")
		for _, g := range ags {
			v := g.View(in.live[g.ID])
			bits := []string{string(v.Status)}
			if v.Tools > 0 {
				bits = append(bits, toolCount(v.Tools, "tool call"))
			}
			if v.Cost != nil {
				bits = append(bits, fmt.Sprintf("$%.2f", *v.Cost))
			}
			if v.PeakContext > 0 {
				bits = append(bits, fmt.Sprintf("context up to %dk tokens", v.PeakContext/1000))
			}
			on := ""
			if v.Model != "" {
				on = ", " + v.Model
				if v.Effort != "" {
					on += ", " + v.Effort + " effort"
				}
			}
			out = append(out, fmt.Sprintf("- %s (%s, attempt %d%s): %s", v.Name, v.Role, max(1, v.Attempt), on, strings.Join(bits, ", ")))
		}
	}

	for _, p := range t.Attempts {
		if p.N == a.N {
			continue
		}
		how := string(p.Outcome)
		if how == "" {
			how = "not finished"
		}
		why := p.Error
		if why == "" && p.Cancel != nil {
			why = p.Cancel.Reason
		}
		if why == "" && p.Result != nil {
			why = p.Result.Summary
		}
		label := "Attempt"
		if p.N < a.N {
			label = "Earlier attempt"
		}
		line := fmt.Sprintf("%s %d (%s): %s. %s", label, p.N, toolTierOf(p.Tier), how, toolLine(why, 600))
		line = strings.TrimRight(line, " ")
		if p.Branch != "" && p.Merged == "" && p.Outcome != "" {
			line += fmt.Sprintf(" Its unfinished work is on branch %s.", p.Branch)
		}
		if p.Result != nil {
			line += fmt.Sprintf(" get_task with attempt %d shows its report.", p.N)
		}
		out = append(out, "", line)
	}

	nb, nr := toolSplit(toolChars(in.brief), toolChars(in.report))
	out = append(out, "", fmt.Sprintf("## Brief (revision %d of %d)", t.BriefRev, len(t.Briefs)), "", strings.TrimRight(toolHead(in.brief, nb), " \t\n"))
	if total := toolChars(in.brief); nb < total {
		out = append(out, fmt.Sprintf("\n[The first %s of %s characters. get_task with id %q, part \"brief\" and offset %d continues.]",
			toolNum(nb), toolNum(total), t.ID, nb))
	}
	switch {
	case a.Result != nil:
		report := strings.TrimRight(toolHead(in.report, nr), " \t\n")
		if report == "" {
			report = "(no report)"
		}
		out = append(out, "", fmt.Sprintf("## Result (%s)", a.Result.Outcome), "", a.Result.Summary, "", report)
		if total := toolChars(in.report); nr < total {
			more := ""
			if in.asked {
				more = fmt.Sprintf(", attempt %d", a.N)
			}
			out = append(out, fmt.Sprintf("\n[The first %s of %s characters of the report. get_task with id %q, part \"report\"%s and offset %d continues.]",
				toolNum(nr), toolNum(total), t.ID, more, nr))
		}
	case a.N == latest.N && t.State().Active():
		name := ""
		for _, g := range l.Agents {
			if g.ID == a.Agents.Work {
				name = g.Name
			}
		}
		if name == "" {
			name = WorkAgentName(t.ID, a.N)
		}
		out = append(out, "", fmt.Sprintf("It has no result yet. `get_agent` with agent %s shows what it is doing.", name))
	}
	return toolPage(strings.Join(out, "\n"), offset, "get_task", toolTaskArgs(in, ""), 0)
}

func toolIDs(ids []string) string {
	if len(ids) == 0 {
		return "nothing"
	}
	return strings.Join(ids, ", ")
}

// ---- get_notes ------------------------------------------------------------------------------

// toolNotesText is get_notes' answer: the heading and the notes, a part at a time. asked: the
// call named the version.
func toolNotesText(nv model.NotesVersion, of int, text string, asked bool, offset int) (out, refusal string) {
	head := fmt.Sprintf("# Notes, version %d of %d (%s characters, written %s)\n\n", nv.V, of, toolNum(nv.Size), toolWho(nv.Turn))
	args := ""
	if asked {
		args = fmt.Sprintf(" version %d,", nv.V)
	}
	return toolPage(head+text, offset, "get_notes", args, 0)
}

// toolCount is a count with its noun: "1 orchestrator turn", "60 orchestrator turns".
func toolCount(n int, one string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + one + "s"
}

// toolBareName is a tool's name without the prefix an MCP tool carries (`mcp__board__get_run`
// is get_run); any other name as it is.
func toolBareName(name string) string {
	if rest, ok := strings.CutPrefix(name, "mcp__"); ok {
		if _, tool, ok := strings.Cut(rest, "__"); ok && tool != "" {
			return tool
		}
	}
	return name
}

// ---- get_agent ------------------------------------------------------------------------------

// toolStepKeys are the fields of a tool's input that say what it was used on, in the order they
// are looked for.
var toolStepKeys = []string{"command", "file_path", "pattern", "description", "prompt", "query", "url", "id", "task", "agent", "title"}

// toolStepLabel is one tool item on one line: `{tool name}: {the first line of what it was used
// on}`, the second part cut to max characters; the name alone when the input names nothing.
func toolStepLabel(it model.Item, max int) string {
	name := toolBareName(it.Name)
	var in map[string]json.RawMessage
	if len(it.Input) > 0 {
		json.Unmarshal(it.Input, &in)
	}
	for _, k := range toolStepKeys {
		raw, ok := in[k]
		if !ok {
			continue
		}
		var s string
		if json.Unmarshal(raw, &s) != nil {
			s = string(raw)
		}
		s = strings.TrimSpace(s)
		if s == "" || s == "null" {
			continue
		}
		first, _, _ := strings.Cut(s, "\n")
		return name + ": " + toolLine(first, max)
	}
	return name
}

// toolSteps is an agent's thread as the steps get_agent lists: what it said, the tools it used,
// the errors of tools and of the app. The message it was sent, permission cards, carried
// results and end marks are not steps.
func toolSteps(items []model.Item) []string {
	var steps []string
	for _, it := range items {
		switch it.Kind {
		case "text":
			if strings.TrimSpace(it.Text) != "" {
				steps = append(steps, "- said: "+toolLine(it.Text, 1200))
			}
		case "tool":
			steps = append(steps, "- used "+toolStepLabel(it, 200))
			if it.IsError && it.Result != nil {
				steps = append(steps, "- tool error: "+toolLine(*it.Result, 300))
			}
		case "note":
			if it.Tone == "error" {
				steps = append(steps, "- note: "+toolLine(it.Text, 300))
			}
		}
	}
	return steps
}

// toolAgentText is get_agent's answer. a is the agent as clients get it (its live cost in it);
// items is its thread. The oldest steps are left out when the text would be longer than a tool's
// answer may be: this tool has no offset.
func toolAgentText(a model.RunAgent, items []model.Item, now int64, last int) string {
	of := fmt.Sprintf("orchestrator, turn %d", a.Turn)
	if a.Task != "" {
		of = fmt.Sprintf("%s of %s", a.Role, a.Task)
	}
	var bits []string
	tools := 0
	final := ""
	for _, it := range items {
		switch it.Kind {
		case "tool":
			tools++
		case "text":
			if strings.TrimSpace(it.Text) != "" {
				final = it.Text
			}
		}
	}
	if tools > 0 {
		bits = append(bits, toolCount(tools, "tool call"))
	}
	if a.Cost != nil {
		bits = append(bits, fmt.Sprintf("$%.2f", *a.Cost))
	}
	end := a.EndedAt
	if end == 0 {
		end = now
	}
	bits = append(bits, toolDur(end-a.StartedAt), fmt.Sprintf("%d launch(es)", len(a.Launches)))
	head := []string{fmt.Sprintf("# Agent %s (%s): %s", a.Name, of, a.Status), strings.Join(bits, ", ")}
	if a.Error != "" {
		head = append(head, "Error: "+a.Error)
	}
	for _, ln := range a.Launches {
		if ln.Error != "" {
			head = append(head, fmt.Sprintf("Launch %d ended with: %s", ln.N, toolLine(ln.Error, 400)))
		}
	}
	var tail []string
	if a.Status == model.AgentDone && final != "" {
		msg := final
		if n := toolChars(final); n > toolFinalMax {
			msg = toolHead(final, toolFinalMax) + fmt.Sprintf("\n\n[The first %s of %s characters. For a task's report use get_task with part \"report\".]", toolNum(toolFinalMax), toolNum(n))
		}
		tail = []string{"", "## Its final message", "", msg}
	}
	steps := toolSteps(items)
	if len(steps) > last {
		steps = steps[len(steps)-last:]
	}
	for {
		out := append([]string{}, head...)
		out = append(out, "", "## Its last "+toolCount(len(steps), "step"), "")
		if len(steps) == 0 {
			out = append(out, "(nothing yet)")
		}
		out = append(out, steps...)
		out = append(out, tail...)
		text := strings.Join(out, "\n")
		if toolChars(text) <= toolLimit || len(steps) <= 1 {
			return clip(text, toolLimit)
		}
		steps = steps[1:]
	}
}
