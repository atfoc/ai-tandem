package runs

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/model"
)

var toolNextOffset = regexp.MustCompile(`offset (\d+) for the next part\.\]$`)

// toolFollow reads a long answer part by part, as its last lines say, and returns the parts
// without those lines, put together. Every part must fit a tool's answer.
func toolFollow(t *testing.T, call func(offset int) (string, bool)) (whole string, parts int) {
	t.Helper()
	offset := 0
	for {
		text, isErr := call(offset)
		if isErr {
			t.Fatalf("offset %d: refused: %s", offset, clip(text, 300))
		}
		if n := toolChars(text); n > toolLimit {
			t.Fatalf("offset %d: the part has %d characters", offset, n)
		}
		parts++
		i := strings.LastIndex(text, "\n\n[Characters ")
		if i < 0 {
			if parts > 1 {
				t.Fatalf("offset %d: a later part without its last line", offset)
			}
			return text, parts
		}
		whole += text[:i]
		last := text[i+2:]
		if strings.HasSuffix(last, ": the end.]") {
			return whole, parts
		}
		m := toolNextOffset.FindStringSubmatch(last)
		if m == nil {
			t.Fatalf("offset %d: the last line does not say how to go on: %s", offset, last)
		}
		next, _ := strconv.Atoi(m[1])
		if next <= offset {
			t.Fatalf("offset %d: the next part starts at %d", offset, next)
		}
		if !strings.HasSuffix(text[:i], "\n") {
			t.Fatalf("offset %d: the part is not cut at a line end", offset)
		}
		offset = next
	}
}

func TestToolPage(t *testing.T) {
	whole := strings.Repeat("x", toolLimit)
	if got, refusal := toolPage(whole, 0, "get_run", "", 0); got != whole || refusal != "" {
		t.Fatalf("a text of %d characters was not returned whole", toolLimit)
	}
	var b strings.Builder
	for i := 0; b.Len() < 200_000; i++ { // 200,000 bytes: about 105,000 characters
		fmt.Fprintf(&b, "line %d: %s\n", i, strings.Repeat("é", i%90))
	}
	text := b.String()
	got, parts := toolFollow(t, func(offset int) (string, bool) {
		out, refusal := toolPage(text, offset, "get_notes", " version 3,", 0)
		return out + refusal, refusal != ""
	})
	if got != text || parts < 3 {
		t.Fatalf("%d parts; put together they are %d characters of %d", parts, toolChars(got), toolChars(text))
	}
	first, _ := toolPage(text, 0, "get_notes", " version 3,", 0)
	total := toolNum(toolChars(text))
	if m := regexp.MustCompile(`\n\n\[Characters 1–([\d,]+) of ` + total + `\. Call get_notes again with version 3, offset (\d+) for the next part\.\]$`).FindStringSubmatch(first); m == nil ||
		strings.ReplaceAll(m[1], ",", "") != m[2] {
		t.Fatalf("the last line of the first part: %q", first[len(first)-160:])
	}
	if _, refusal := toolPage(text, toolChars(text), "get_notes", "", 0); refusal != "offset "+strconv.Itoa(toolChars(text))+" is past the end: the answer has "+total+" characters." {
		t.Fatalf("past the end: %q", refusal)
	}
	// One line longer than a part is cut where the part ends.
	if out, _ := toolPage(strings.Repeat("y", 90_000), 0, "get_run", "", 0); !strings.HasPrefix(out, strings.Repeat("y", toolPart)+"\n\n[Characters 1–38,800 of 90,000. Call get_run again with offset 38800") {
		t.Fatalf("one long line: %q", out[toolPart-5:])
	}
	if toolNum(0) != "0" || toolNum(999) != "999" || toolNum(1000) != "1,000" || toolNum(1234567) != "1,234,567" {
		t.Fatal("toolNum")
	}
	for ms, want := range map[int64]string{0: "0s", 41_600: "42s", 327_000: "5m27s", 3_900_000: "1h05m", -5: "0s"} {
		if got := toolDur(ms); got != want {
			t.Fatalf("toolDur(%d) = %q, want %q", ms, got, want)
		}
	}
}

// Notes longer than a tool's answer are read a part at a time, by the orchestrator and by a chat.
func TestToolNotesArePaged(t *testing.T) {
	x := newToolRun(t, false)
	x.turnStart("start")
	var b strings.Builder
	for i := 0; b.Len() < 92_000; i++ {
		fmt.Fprintf(&b, "- Fact %d: the importer %s.\n", i, strings.Repeat("really ", i%12))
	}
	notes := strings.TrimSpace(b.String())
	x.ok("orchestrator", "set_notes", toolArgsJSON(t, map[string]string{"notes": notes}))
	want := fmt.Sprintf("# Notes, version 1 of 1 (%s characters, written in turn 1)\n\n%s", toolNum(toolChars(notes)), notes)
	for _, who := range []string{"orchestrator", "chat"} {
		call := x.orch
		if who == "chat" {
			call = x.chat
		}
		got, parts := toolFollow(t, func(offset int) (string, bool) { return call("get_notes", fmt.Sprintf(`{"offset":%d}`, offset)) })
		if got != want || parts != 3 {
			t.Fatalf("%s: %d parts, %d characters of %d", who, parts, toolChars(got), toolChars(want))
		}
	}
	// A continued call must repeat the version it was made for.
	text, _ := x.chat("get_notes", `{"version":1}`)
	if !strings.Contains(text, "Call get_notes again with version 1, offset ") {
		t.Fatalf("the last line: %q", text[len(text)-150:])
	}
}

// A brief and a report that do not fit one answer together are cut, and each can be read whole.
func TestToolTaskLongTexts(t *testing.T) {
	x := newToolRun(t, false)
	x.turnStart("start")
	para := func(word string, size int) string {
		var b strings.Builder
		for i := 0; b.Len() < size; i++ {
			fmt.Fprintf(&b, "%s %d: %s\n", word, i, strings.Repeat("lorem ", 1+i%20))
		}
		return strings.TrimSpace(b.String())
	}
	brief, report := para("Requirement", 30_000), para("Finding", 55_000)
	x.ok("orchestrator", "add_task", toolArgsJSON(t, map[string]any{"title": "Review everything", "brief": brief, "kind": "review", "writes": false, "tier": "deep", "tier_reason": "Nothing checks a review."}))
	x.turnEnd("Added.", 0.1)
	x.taskRuns("T01")
	x.taskResult("T01", "completed", "Twelve findings.", report, 3)
	x.taskDone("T01")

	text := x.ok("chat", "get_task", `{"id":"T01"}`)
	nb, nr := toolSplit(toolChars(brief), toolChars(report))
	if nb != toolBody-toolReportMin || nr != toolReportMin || toolChars(text) > toolLimit {
		t.Fatalf("split %d + %d, %d characters", nb, nr, toolChars(text))
	}
	for _, want := range []string{
		fmt.Sprintf("\n\n[The first %s of %s characters. get_task with id \"T01\", part \"brief\" and offset %d continues.]\n", toolNum(nb), toolNum(toolChars(brief)), nb),
		fmt.Sprintf("\n\n[The first %s of %s characters of the report. get_task with id \"T01\", part \"report\" and offset %d continues.]", toolNum(nr), toolNum(toolChars(report)), nr),
		"\n\n## Result (completed)\n\nTwelve findings.\n\nFinding 0: lorem \n",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("the answer lacks %q", want)
		}
	}
	if strings.Contains(text, "[Characters ") {
		t.Fatal("the cut answer is paged as well")
	}
	// The rest of each, from where the answer says.
	rest, isErr := x.chat("get_task", fmt.Sprintf(`{"id":"T01","part":"brief","offset":%d}`, nb))
	if isErr || !strings.HasPrefix(rest, fmt.Sprintf("# T01: brief, revision 1 of 1 (%s characters)\n\n", toolNum(toolChars(brief)))) ||
		!strings.Contains(rest, string([]rune(brief)[nb:])+"\n\n[Characters ") || !strings.HasSuffix(rest, ": the end.]") {
		t.Fatalf("the rest of the brief: %q … %q", rest[:80], rest[len(rest)-80:])
	}
	head := fmt.Sprintf("# T01: report of attempt 1 (completed, %s characters)\n\n", toolNum(toolChars(report)))
	got, parts := toolFollow(t, func(offset int) (string, bool) {
		out, isErr := x.chat("get_task", fmt.Sprintf(`{"id":"T01","part":"report","offset":%d}`, offset))
		if !strings.HasPrefix(out, head) {
			t.Fatalf("offset %d: the part starts %q", offset, out[:60])
		}
		out = strings.TrimPrefix(out, head)
		if offset == 0 {
			out = strings.TrimPrefix(out, "Twelve findings.\n\n")
		}
		return out, isErr
	})
	if got != report || parts != 2 {
		t.Fatalf("the report in %d parts: %d characters of %d", parts, toolChars(got), toolChars(report))
	}
	// The whole brief fits one answer.
	if whole := x.ok("chat", "get_task", `{"id":"T01","part":"brief"}`); !strings.HasSuffix(whole, brief) || toolChars(whole) > toolLimit {
		t.Fatalf("the brief alone: %d characters", toolChars(whole))
	}
}

// toolBigRun is a run with n finished tasks, each with a long summary, and a turn per five tasks.
func toolBigRun(t *testing.T, n int) *toolRun {
	x := newToolRun(t, true)
	x.turnStart("start")
	x.ok("orchestrator", "set_notes", toolNotes)
	summary := strings.Repeat("It found and fixed what the brief asked for, and says how it checked. ", 9)
	for i := 1; i <= n; i++ {
		deps := []string{}
		if i > 1 {
			deps = []string{TaskID(i - 1)}
		}
		x.ok("orchestrator", "add_task", toolAdd(fmt.Sprintf("Review and fix part %d of the importer and of its tests", i), "implement", true, deps...))
		if i%5 == 0 {
			x.turnEnd(strings.Repeat("Added five tasks and looked at what came back. ", 12), 0.5)
			for j := i - 4; j <= i; j++ {
				x.tick(time.Minute)
				x.taskRuns(TaskID(j))
				x.taskResult(TaskID(j), "completed", summary, "# Report", 2)
				x.taskDone(TaskID(j))
			}
			x.turnStart("events")
		}
	}
	return x
}

// The run text of a run with 50 tasks is one answer; a much bigger one is read in parts.
func TestToolRunWithManyTasks(t *testing.T) {
	x := toolBigRun(t, 50)
	for _, who := range []string{"orchestrator", "chat"} {
		text := x.ok(who, "get_run", `{}`)
		if n := toolChars(text); n > toolLimit || strings.Contains(text, "[Characters ") {
			t.Fatalf("%s: get_run of 50 tasks has %d characters", who, n)
		}
		if !strings.Contains(text, "\nT50 [implement, writes, standard] done, $2.00: Review and fix part 50") || strings.Count(text, "\n    result: ") != 50 {
			t.Fatalf("%s: not every task is in the answer", who)
		}
		// The summaries share a budget: 16,000 characters over 50 lines.
		for _, line := range strings.Split(text, "\n") {
			if strings.HasPrefix(line, "    result: ") && toolChars(strings.TrimPrefix(line, "    result: ")) != toolLineBudget/50 {
				t.Fatalf("a result line of %d characters", toolChars(line))
			}
		}
		if strings.Count(text, "\nTurn ") != 10 { // every turn that ended
			t.Fatalf("%s: %d earlier turns listed", who, strings.Count(text, "\nTurn "))
		}
	}
	text := x.ok("chat", "get_run", `{}`)
	if !strings.HasPrefix(text, "Run Port the importer: running. Turn 11. Tasks: 50 done. Spent $105.00 (orchestrator $5.00).\nLimits: turn 11 of 60, 0 of 8 task slots busy.\n") {
		t.Fatalf("the head: %q", text[:160])
	}

	big := toolBigRun(t, 200)
	big.r.mu.Lock()
	snap, meta := big.r.L.snapshot(), big.r.meta
	big.r.mu.Unlock()
	whole := toolRunText(meta, snap, gitFacts{}, toolRunOpts{now: big.s.nowMs()})
	if toolChars(whole) <= toolLimit {
		t.Fatalf("200 tasks make only %d characters", toolChars(whole))
	}
	if n := strings.Count(whole, "\nTurn "); n != toolShown || !strings.Contains(whole, "\nTurn 40 (") || strings.Contains(whole, "\nTurn 28 (") {
		t.Fatalf("%d earlier turns listed of 40", n)
	}
	got, parts := toolFollow(t, func(offset int) (string, bool) { return big.chat("get_run", fmt.Sprintf(`{"offset":%d}`, offset)) })
	if got != whole || parts < 2 {
		t.Fatalf("get_run of 200 tasks in %d parts: %d characters of %d", parts, toolChars(got), toolChars(whole))
	}
	// The snapshot for the orchestrator's prompt is the whole text, never a part of it.
	if text := snapshotText(meta, snap, gitFacts{}); toolChars(text) <= toolLimit || strings.Contains(text, "[Characters ") {
		t.Fatalf("the snapshot has %d characters", toolChars(text))
	}
	// The orchestrator's first part takes what is new; its later parts are parts of that same
	// text, so what was new stands at its end.
	big.ok("chat", "tell_orchestrator", `{"text":"Stop adding tasks."}`)
	got, parts = toolFollow(t, func(offset int) (string, bool) { return big.orch("get_run", fmt.Sprintf(`{"offset":%d}`, offset)) })
	if parts < 2 || !strings.HasSuffix(got, "\n\n## New since you last looked\n\n- Message from the person, passed on by a chat on the run:\nStop adding tasks.") {
		t.Fatalf("the orchestrator's get_run in %d parts ends %q", parts, got[len(got)-200:])
	}
	if l := big.state(); len(l.State.Inbox) != 0 || len(l.Turns[len(l.Turns)-1].Learned) != 1 {
		t.Fatalf("inbox %+v", l.State.Inbox)
	}
}

// get_agent has no offset: when the steps asked for do not fit, the oldest are left out.
func TestToolAgentStaysUnderTheLimit(t *testing.T) {
	x := toolUpdateRun(t)
	var items []model.Item
	for i := 0; i < 80; i++ {
		items = append(items, model.Item{Kind: "text", Text: fmt.Sprintf("Step %d. ", i) + strings.Repeat("long thought ", 200)})
	}
	items = append(items, model.Item{Kind: "text", Text: strings.Repeat("The report. ", 3000)})
	x.host.items[AgentChatID(x.id, "T01-work")] = items
	text := x.ok("chat", "get_agent", `{"agent":"T01-work","last":60}`)
	if n := toolChars(text); n > toolLimit {
		t.Fatalf("%d characters", n)
	}
	m := regexp.MustCompile(`## Its last (\d+) steps`).FindStringSubmatch(text)
	if m == nil || m[1] == "60" || !strings.Contains(text, "\n- said: Step 79. ") || strings.Contains(text, "\n- said: Step 30. ") {
		t.Fatalf("steps: %v", m)
	}
	if !strings.HasSuffix(text, "\n\n[The first 20,000 of 36,000 characters. For a task's report use get_task with part \"report\".]") {
		t.Fatalf("the end: %q", text[len(text)-120:])
	}
	// A step is one line, cut: 1,200 characters of what it said.
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "- said: ") && toolChars(line) > 1208 {
			t.Fatalf("a step of %d characters", toolChars(line))
		}
	}
}

// An orchestrator's call counts only while its turn is the run's running one, checked inside the
// entry: after the turn ended it is refused and changes nothing.
func TestToolTurnCheck(t *testing.T) {
	x := newToolRun(t, false)
	n := x.turnStart("start")
	first := x.orchChat(n)
	x.ok("orchestrator", "add_task", toolAdd("Read the old importer", "research", false))
	entries := func() int { return len(readEntries(t, x.r.dir)) }
	evs := func() int { return len(x.allEvents()) }

	// The chat manager says its process is in no turn: refused before any lock.
	x.host.setStopped(first, true)
	before, sent := entries(), evs()
	for _, c := range [][2]string{{"add_task", toolAdd("Another", "research", false)}, {"get_run", `{}`}, {"set_notes", toolNotes}, {"cancel_task", `{"id":"T01","reason":"no"}`}} {
		if text, isErr := x.orch(c[0], c[1]); !isErr || text != "the orchestrator's turn is over; "+c[0]+" was not run" {
			t.Fatalf("%s with no turn running: %q %v", c[0], text, isErr)
		}
	}
	if entries() != before || evs() != sent {
		t.Fatal("a refused call was recorded")
	}
	x.host.setStopped(first, false)

	// The turn ends between the question to the chat manager and the entry (the script's B17):
	// the check inside the entry refuses it, and no task is added.
	x.host.mu.Lock()
	x.host.asked = func(string) {
		x.host.mu.Lock()
		x.host.asked = nil
		x.host.mu.Unlock()
		x.turnEnd("Done.", 0.1)
	}
	x.host.mu.Unlock()
	if text, isErr := x.orch("add_task", toolAdd("Too late", "research", false)); !isErr || text != "the orchestrator's turn is over; add_task was not run" {
		t.Fatalf("a call that arrived as the turn ended: %q %v", text, isErr)
	}
	l := x.state()
	if len(l.Tasks) != 1 || len(l.Turns[0].Ops) != 1 || l.Turns[0].Status != "done" {
		t.Fatalf("after the late call: %d tasks, ops %+v", len(l.Tasks), l.Turns[0].Ops)
	}
	before, sent = entries(), evs()
	for _, name := range []string{"get_run", "get_task", "get_agent", "get_notes", "set_notes", "add_task", "update_task", "cancel_task", "retry_task", "finish_run"} {
		if text, isErr := x.orchOf(n, name, `{"id":"T01","reason":"r","notes":"n","outcome":"achieved","summary":"s","agent":"turn-001"}`); !isErr || text != "the orchestrator's turn is over; "+name+" was not run" {
			t.Fatalf("%s after the turn: %q %v", name, text, isErr)
		}
	}
	if entries() != before || evs() != sent || x.state().Version != l.Version {
		t.Fatal("a call after the turn's end changed the run")
	}

	// The next turn: its own chat is heard, the chat of the turn before is not.
	second := x.turnStart("idle")
	if text, isErr := x.orchOf(n, "add_task", toolAdd("From the old turn", "research", false)); !isErr || text != "the orchestrator's turn is over; add_task was not run" {
		t.Fatalf("the earlier turn's chat: %q %v", text, isErr)
	}
	if text, isErr := x.orchOf(second, "add_task", toolAdd("From this turn", "research", false)); isErr || !strings.HasPrefix(text, "Added T02: From this turn.") {
		t.Fatalf("this turn's chat: %q %v", text, isErr)
	}
	l = x.state()
	if len(l.Tasks) != 2 || len(l.Turns[1].Ops) != 1 || l.Tasks[1].AddedTurn != 2 {
		t.Fatalf("tasks %d, ops of turn 2 %+v", len(l.Tasks), l.Turns[1].Ops)
	}
	// A chat on the run needs no turn at all.
	x.turnEnd("Done.", 0.1)
	if text, isErr := x.chat("add_task", toolAdd("From the chat", "research", false)); isErr {
		t.Fatalf("a chat with no turn running: %s", text)
	}
}

// What a chat on the run changes: applied at once, recorded in chatOps, told to the orchestrator
// with a chat_op event, and held by the chat. Its reads leave no trace.
func TestToolChatOps(t *testing.T) {
	x := newToolRun(t, false)
	x.turnStart("start")
	x.ok("orchestrator", "add_task", toolAdd("Read the old importer", "research", false))
	x.ok("orchestrator", "add_task", toolAdd("Measure the old importer", "verify", false))
	x.turnEnd("Two tasks.", 0.1)
	x.taskRuns("T02")
	x.taskFail("T02", "agent T02-work failed")
	x.turnStart("events")
	x.turnEnd("Looked.", 0.1)
	base := x.state()
	x.events()

	// Reads: no entry, no event, nothing in chatOps.
	for _, c := range [][2]string{{"get_run", `{}`}, {"get_task", `{"id":"T01"}`}, {"get_agent", `{"agent":"T02-work"}`}, {"get_notes", `{}`}, {"get_task", `{"id":"nope"}`}} {
		x.chat(c[0], c[1])
	}
	if l := x.state(); l.Version != base.Version || len(l.ChatOps) != 0 {
		t.Fatalf("a chat's reads were recorded: version %d → %d", base.Version, l.Version)
	}

	x.ok("chat", "add_task", toolAdd("Check by hand", "verify", false))
	x.ok("chat", "update_task", `{"id":"T01","title":"Read the importer"}`)
	x.ok("chat", "retry_task", `{"id":"T02","reason":"the data is there now"}`)
	x.ok("chat", "tell_orchestrator", `{"text":"Prefer small tasks."}`)
	x.ok("chat", "cancel_task", `{"id":"T03","reason":"not needed after all"}`)
	if _, isErr := x.chat("update_task", `{"id":"T09","title":"x"}`); !isErr {
		t.Fatal("a change of a task that is not there was accepted")
	}
	l := x.state()
	var ops, texts []string
	for i, op := range l.ChatOps {
		if op.I != i || op.Chat != toolChat || op.Turn != 2 || op.T == 0 {
			t.Fatalf("chatOps[%d]: %+v", i, op)
		}
		ops = append(ops, strings.Join(strings.Fields(op.Op+" "+op.Task+" "+op.Error), " "))
	}
	if fmt.Sprint(ops) != "[add_task T03 update_task T01 retry_task T02 tell_orchestrator cancel_task T03 update_task there is no task 'T09' (the run has tasks T01 to T03)]" {
		t.Fatalf("chatOps: %v", ops)
	}
	for _, e := range l.State.Inbox {
		if e.Type != "chat_op" || e.Chat != toolChat || e.Seq == 0 {
			t.Fatalf("event: %+v", e)
		}
		texts = append(texts, e.Text)
	}
	want := []string{
		"A chat on the run added T03 [verify, reports only]: Check by hand.",
		"A chat on the run changed T01 (title).",
		"A chat on the run queued T02 again as attempt 2: the data is there now",
		"Message from the person, passed on by a chat on the run:\nPrefer small tasks.",
		"A chat on the run cancelled T03: not needed after all",
	}
	if fmt.Sprint(texts) != fmt.Sprint(want) {
		t.Fatalf("events:\n%s", strings.Join(texts, "\n"))
	}
	// Held by the chat: the task it changed and the one it queued again; not the one it cancelled.
	held := map[string]string{}
	for _, task := range l.Tasks {
		held[task.ID] = fmt.Sprint(task.HeldBy) + " " + string(task.State())
	}
	if fmt.Sprint(held) != "map[T01:[{0 chat-1}] held T02:[{0 chat-1}] held T03:[] cancelled]" {
		t.Fatalf("holds: %v", held)
	}
	// Each change was one `op` entry with the chat in its head, sent as one run_detail patch.
	es := readEntries(t, x.r.dir)
	lastE := es[len(es)-1]
	if lastE.Kind != KOp || lastE.Chat != toolChat || lastE.Op != "update_task" || lastE.Error == "" || lastE.Turn != 0 || len(lastE.Patch.ChatOps) != 1 {
		t.Fatalf("the last entry: %+v", lastE)
	}
	var patches int
	for _, ev := range x.events() {
		if d, ok := ev.(detailEvent); ok && len(d.Patch.ChatOps) == 1 {
			patches++
		}
	}
	if patches != 6 {
		t.Fatalf("%d run_detail events carry a chat's op", patches)
	}
	// When the chat's reply has ended, what it held may start.
	x.chatIdle(toolChat)
	if t1, _ := toolTask(x.state(), "T01"); t1.State() != model.TaskSlot {
		t.Fatalf("T01 after the chat's reply: %s", t1.State())
	}
}

// Who is listed which run tools.
func TestToolLists(t *testing.T) {
	e := newSvcEnv(t)
	s := e.s
	names := func(c boardapi.RunCaller) string {
		var out []string
		for _, tl := range s.Tools(c) {
			out = append(out, tl.Name)
		}
		return strings.Join(out, " ")
	}
	const reads, tasks = "get_run get_task get_agent get_notes", "add_task update_task cancel_task retry_task"
	if got := names(boardapi.RunCaller{Run: "r", Chat: "c", Role: model.RoleOrchestrator}); got != reads+" set_notes edit_notes "+tasks+" wait_for finish_run" {
		t.Fatalf("the orchestrator: %s", got)
	}
	// wait_for is the orchestrator's only in the wake mode declared, which an empty one counts as.
	for mode, wait := range map[string]string{"declared": " wait_for", "": " wait_for", "each": "", "idle": ""} {
		r := e.in("r_wake_"+mode, model.RunRunning)
		r.mu.Lock()
		r.meta.Settings.Wake = mode
		r.mu.Unlock()
		if got := names(boardapi.RunCaller{Run: r.id, Chat: "c", Role: model.RoleOrchestrator}); got != reads+" set_notes edit_notes "+tasks+wait+" finish_run" {
			t.Fatalf("the orchestrator in the wake mode %q: %s", mode, got)
		}
		if got := names(boardapi.RunCaller{Run: r.id, Chat: "c"}); got != reads+" "+tasks+" tell_orchestrator" {
			t.Fatalf("a chat on a run in the wake mode %q: %s", mode, got)
		}
	}
	if got := names(boardapi.RunCaller{Run: "r", Chat: "c"}); got != reads+" "+tasks+" tell_orchestrator" {
		t.Fatalf("a chat on the run: %s", got)
	}
	for _, c := range []boardapi.RunCaller{{Run: "r", Chat: "c", Role: model.RoleTask}, {Run: "r", Chat: "c", Role: model.RoleMerge},
		{Run: "r", Chat: "c", Subagent: true}, {Run: "r", Chat: "c", Role: model.RoleOrchestrator, Subagent: true}, {Chat: "c"}, {Run: "r", Chat: "c", Role: "reviewer"}} {
		if got := names(c); got != "" {
			t.Fatalf("%+v is listed %s", c, got)
		}
	}
	if len(boardtools.RunTools) != 13 {
		t.Fatalf("%d run tools", len(boardtools.RunTools))
	}
	var _ boardapi.RunService = s
}

// The entries of the orchestrator's calls name the turn, the tool, the chat and the task.
func TestToolEntryHeads(t *testing.T) {
	x := newToolRun(t, false)
	n := x.turnStart("start")
	x.ok("orchestrator", "add_task", toolAdd("Read the old importer", "research", false))
	x.orch("update_task", `{"id":"T01"}`)
	x.ok("orchestrator", "get_task", `{"id":"T01"}`)
	es := readEntries(t, x.r.dir)
	var got []string
	for _, e := range es[2:] {
		b, _ := json.Marshal(struct {
			K EntryKind
			T int
			O string
			C bool
			A string
			E string
		}{e.Kind, e.Turn, e.Op, e.Chat == x.orchChat(n), e.Task, e.Error})
		got = append(got, string(b))
	}
	want := []string{
		`{"K":"op","T":1,"O":"add_task","C":true,"A":"T01","E":""}`,
		`{"K":"op","T":1,"O":"update_task","C":true,"A":"T01","E":"nothing to change: give title, brief, kind, writes, tier, tier_reason, depends_on or needs_report"}`,
		`{"K":"op","T":1,"O":"get_task","C":true,"A":"T01","E":""}`,
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("entries:\n%s", strings.Join(got, "\n"))
	}
}
