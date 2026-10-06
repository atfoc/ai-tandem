package runs

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/model"
)

// The texts of the run tools against golden files (testdata/tools): every refusal and every
// answer of the contract (T13 §8), for the orchestrator and for a chat on the run. Each test
// plays a small run and writes down what the tools say.

func toolAdd(title, kind string, writes bool, deps ...string) string {
	m := map[string]any{"title": title, "brief": toolBrief, "kind": kind, "writes": writes, "tier": "standard", "tier_reason": "A build or a later task checks it."}
	if deps != nil {
		m["depends_on"] = deps
	}
	b, _ := json.Marshal(m)
	return string(b)
}

const toolNotes = `{"notes":"# Goal\n\nPort the importer. Done means the old tests pass against the new code.\n"}`

// sayAs calls a tool as any caller and writes it into the transcript.
func (x *toolRun) sayAs(title, who string, c boardapi.RunCaller, name, args string) {
	text, isErr := x.s.Call(c, name, json.RawMessage(args))
	x.write(title, who, name, args, text, isErr)
}

// The checks every tool shares (§8.1), in the contract's order.
func TestToolTextsCommon(t *testing.T) {
	x := newToolRun(t, true)
	n := x.turnStart("start")
	orch := boardapi.RunCaller{Run: x.id, Chat: x.orchChat(n), Role: model.RoleOrchestrator}

	x.sayAs("a subagent of the orchestrator", "subagent", boardapi.RunCaller{Run: x.id, Chat: orch.Chat, Role: model.RoleOrchestrator, Subagent: true}, "get_run", `{}`)
	x.sayAs("a subagent of a chat on the run", "subagent", boardapi.RunCaller{Run: x.id, Chat: toolChat, Subagent: true}, "add_task", toolAdd("Read", "research", false))
	x.sayAs("a task agent", "task agent", boardapi.RunCaller{Run: x.id, Chat: "t", Role: model.RoleTask}, "get_run", `{}`)
	x.sayAs("a merge agent", "merge agent", boardapi.RunCaller{Run: x.id, Chat: "m", Role: model.RoleMerge}, "add_task", toolAdd("Read", "research", false))
	x.sayAs("a chat that is on no run", "chat", boardapi.RunCaller{Chat: "c"}, "get_run", `{}`)
	x.sayAs("a chat on a run that does not exist", "chat", boardapi.RunCaller{Run: "r_gone0000", Chat: "c"}, "get_run", `{}`)
	x.say("a tool that is none of the run tools", "orchestrator", "rm_rf", `{}`)
	x.say("the arguments are not an object, the orchestrator", "orchestrator", "add_task", `["T01"]`)
	x.say("the arguments are not an object, a chat's change", "chat", "cancel_task", `"T01"`)
	x.say("the arguments are not an object, a chat's read", "chat", "get_task", `7`)
	x.say("no arguments at all are an empty object", "chat", "get_notes", ``)
	x.say("a chat calls set_notes", "chat", "set_notes", toolNotes)
	x.say("a chat calls finish_run", "chat", "finish_run", `{"outcome":"achieved","summary":"Done."}`)
	x.say("the orchestrator calls tell_orchestrator", "orchestrator", "tell_orchestrator", `{"text":"note to self"}`)

	// A git failure while get_run reads the integration branch: nothing is consumed.
	x.fake.set(func(f *svcFake) { f.gitErr = errors.New("git rev-parse failed in /work/int: exit status 128") })
	x.say("any other failure", "orchestrator", "get_run", `{}`)
	x.fake.set(func(f *svcFake) { f.gitErr = nil })

	// The orchestrator's turn is over: nothing is run, nothing is recorded.
	x.ok("orchestrator", "set_notes", toolNotes)
	x.turnEnd("Notes written.", 0.10)
	x.sayAs("the orchestrator's turn is over, a change", "orchestrator", orch, "add_task", toolAdd("Read", "research", false))
	x.sayAs("the orchestrator's turn is over, a read", "orchestrator", orch, "get_run", `{}`)
	x.sayAs("the orchestrator's turn is over and the arguments are not an object", "orchestrator", orch, "get_run", `[]`)
	x.turnStart("idle")
	x.sayAs("a call of the chat of an earlier turn", "orchestrator", orch, "add_task", toolAdd("Read", "research", false))

	// A run that is stopping.
	x.must(x.r, KRunStopping, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.Halting = model.RunStopping, &Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}
		return nil
	})
	x.say("the run is stopping, the orchestrator's change", "orchestrator", "add_task", toolAdd("Read", "research", false))
	x.say("the run is stopping, a chat's change", "chat", "add_task", toolAdd("Read", "research", false))
	if text, isErr := x.chat("get_notes", `{}`); isErr || !strings.HasPrefix(text, "# Notes, version 1 of 1") {
		t.Fatalf("a read in a stopping run: %q %v", text, isErr)
	}
	// Halted: the turn is still `running`, and a call of its orchestrator that is still on its
	// way must not change the stopped run.
	if err := x.fake.halted(x.r); err != nil {
		t.Fatal(err)
	}
	x.say("the run is stopped, a call of the orchestrator that was on its way", "orchestrator", "add_task", toolAdd("Read", "research", false))
	if text, isErr := x.chat("add_task", toolAdd("Read", "research", false)); isErr {
		t.Fatalf("a chat's change in a stopped run: %s", text)
	}

	// An archived run.
	if err := x.s.Archive(x.id, model.Archive{Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	x.say("the run is archived, a chat's change", "chat", "add_task", toolAdd("Read", "research", false))
	if text, isErr := x.chat("get_notes", `{}`); isErr || !strings.HasPrefix(text, "# Notes, version 1 of 1") {
		t.Fatalf("a read in an archived run: %q %v", text, isErr)
	}

	// A draft, and a finished run.
	d := x.draft("r_draft001")
	draft := boardapi.RunCaller{Run: d.id, Chat: toolChat}
	x.sayAs("the run is a draft, a read", "chat", draft, "get_run", `{}`)
	x.sayAs("the run is a draft, another read", "chat", draft, "get_task", `{"id":"T01"}`)
	x.sayAs("the run is a draft, a change", "chat", draft, "add_task", toolAdd("Read", "research", false))
	fin := x.in("r_done0001", model.RunCompleted)
	x.sayAs("the run is finished, a chat's change", "chat", boardapi.RunCaller{Run: fin.id, Chat: toolChat}, "tell_orchestrator", `{"text":"one more thing"}`)
	x.golden("common")

	// What was recorded: the draft has no journal; the finished run has the refused change.
	if d.L != nil {
		t.Fatal("a call on a draft made a record")
	}
	if l := svcState(t, fin); len(l.ChatOps) != 1 || l.ChatOps[0].Error != toolFinished || len(l.State.Inbox) != 0 {
		t.Fatalf("chatOps of the finished run: %+v, inbox %+v", l.ChatOps, l.State.Inbox)
	}
}

func TestToolTextsSetNotes(t *testing.T) {
	x := newToolRun(t, false)
	x.turnStart("start")
	x.say("the notes are empty", "orchestrator", "set_notes", `{"notes":"  \n "}`)
	x.say("no notes given", "orchestrator", "set_notes", `{}`)
	x.say("saved", "orchestrator", "set_notes", toolNotes)
	x.say("saved again: a new version", "orchestrator", "set_notes", `{"notes":"# Goal\n\nShorter.\n"}`)
	long := strings.Repeat("A fact the run established, with where it came from.\n", 800)
	text, isErr := x.orch("set_notes", toolArgsJSON(t, map[string]string{"notes": long}))
	x.write("saved, over 20,000 characters", "orchestrator", "set_notes", `{"notes": 800 lines}`, text, isErr)
	x.golden("set_notes")

	l := x.state()
	if len(l.Notes) != 3 || l.Notes[2].V != 3 || l.Notes[2].Turn != 1 || l.Notes[2].Size != toolChars(strings.TrimSpace(long)) {
		t.Fatalf("notes index: %+v", l.Notes)
	}
	if got, err := readNotes(x.r.dir, 2); err != nil || got != "# Goal\n\nShorter.\n" {
		t.Fatalf("notes file: %q %v", got, err)
	}
	ops := l.Turns[0].Ops
	if len(ops) != 5 || ops[0].Error != "the notes are empty" || ops[2].NotesVersion != 1 || ops[2].Size != l.Notes[0].Size || ops[2].Error != "" {
		t.Fatalf("ops: %+v", ops)
	}
}

// wake sets the run's wake mode, which a started run never changes: for a run that was started
// in another one.
func (x *toolRun) wake(mode string) {
	x.r.mu.Lock()
	x.r.meta.Settings.Wake = mode
	x.r.mu.Unlock()
}

func TestToolTextsEditNotes(t *testing.T) {
	x := newToolRun(t, false)
	x.turnStart("start")
	x.say("a chat calls edit_notes", "chat", "edit_notes", `{"heading":"Facts","text":"The user wants it fast."}`)
	x.say("the heading is empty", "orchestrator", "edit_notes", `{"heading":" ## ","text":"x"}`)
	x.say("no heading given", "orchestrator", "edit_notes", `{"text":"x"}`)
	x.say("nothing to remove: there are no notes", "orchestrator", "edit_notes", `{"heading":"Facts","text":""}`)
	if text, isErr := x.orch("add_task", toolAdd("Build", "implement", true)); !isErr || text != toolGateOrch {
		t.Fatalf("a writing task without notes: %q", text)
	}
	x.say("added: the first version of the notes", "orchestrator", "edit_notes", `{"heading":"Facts","text":"The old importer reads CSV in three passes (T01).\n"}`)
	x.ok("orchestrator", "add_task", toolAdd("Build", "implement", true)) // the notes gate is open
	x.say("added at the end, the heading given with its marks", "orchestrator", "edit_notes", `{"heading":"### Sources ","text":"T01."}`)
	x.say("added: a second section", "orchestrator", "edit_notes", `{"heading":"Plan","text":"Build it, then measure."}`)
	x.say("replaced: the name in another case, its inner section goes with it", "orchestrator", "edit_notes", `{"heading":"  facts","text":"One pass is enough (T02)."}`)
	x.say("no text given", "orchestrator", "edit_notes", `{"heading":"Plan"}`)
	x.say("removed: the text is empty", "orchestrator", "edit_notes", `{"heading":"Plan","text":"  "}`)
	x.say("nothing to remove", "orchestrator", "edit_notes", `{"heading":"Plan","text":"  "}`)
	x.say("removing the only section", "orchestrator", "edit_notes", `{"heading":"Facts","text":""}`)
	notes, err := readNotes(x.r.dir, 5)
	if err != nil {
		t.Fatal(err)
	}
	x.note("the notes now (version 5)", strings.TrimRight(notes, "\n"))
	x.ok("orchestrator", "set_notes", `{"notes":"## Facts\n\nOne.\n\n## Plan\n\nx\n\n## facts\n\nTwo.\n"}`)
	x.say("two sections of that name", "orchestrator", "edit_notes", `{"heading":"Facts","text":"Three."}`)
	long := strings.Repeat("A fact the run established, with where it came from.\n", 400)
	text, isErr := x.orch("edit_notes", toolArgsJSON(t, map[string]string{"heading": "Plan", "text": long}))
	x.write("replaced, the notes are over 20,000 characters", "orchestrator", "edit_notes", `{"heading":"Plan","text": 400 lines}`, text, isErr)
	x.say("a heading of 150 characters", "orchestrator", "edit_notes", toolArgsJSON(t, map[string]string{"heading": strings.Repeat("Risks ", 25), "text": "None."}))
	x.golden("edit_notes")

	l := x.state()
	if len(l.Notes) != 8 || l.Notes[0].V != 1 || l.Notes[0].Turn != 1 || l.Notes[7].V != 8 {
		t.Fatalf("notes index: %+v", l.Notes)
	}
	if got, err := readNotes(x.r.dir, 1); err != nil || got != "## Facts\n\nThe old importer reads CSV in three passes (T01).\n" {
		t.Fatalf("version 1: %q %v", got, err)
	}
	if got, err := readNotes(x.r.dir, 3); err != nil || got != "## Facts\n\nThe old importer reads CSV in three passes (T01).\n\n### Sources\n\nT01.\n\n## Plan\n\nBuild it, then measure.\n" {
		t.Fatalf("version 3: %q %v", got, err)
	}
	if got, err := readNotes(x.r.dir, 5); err != nil || got != "## Facts\n\nOne pass is enough (T02).\n" {
		t.Fatalf("version 5: %q %v", got, err)
	}
	ops := l.Turns[0].Ops
	var said []string
	for _, op := range ops {
		if op.Op == "edit_notes" {
			said = append(said, fmt.Sprintf("%d/%d/%s/%v", op.NotesVersion, op.Size, clip(op.Heading, 12), op.Error != ""))
		}
	}
	want := fmt.Sprintf("0/0//true 0/0//true 0/0//true 1/%d/Facts/false 2/%d/### Sources/false 3/%d/Plan/false 4/%d/facts/false 0/0//true 5/%d/Plan/false 0/0//true 0/0//true 0/0//true 7/%d/Plan/false 8/%d/Risks Risks…/false",
		l.Notes[0].Size, l.Notes[1].Size, l.Notes[2].Size, l.Notes[3].Size, l.Notes[4].Size, l.Notes[6].Size, l.Notes[7].Size)
	if got := strings.Join(said, " "); got != want {
		t.Fatalf("edit_notes ops:\n got %s\nwant %s", got, want)
	}
	if last := ops[len(ops)-1]; toolChars(last.Heading) != 120 || l.Notes[7].Size != l.Notes[6].Size+len("\n\n## ")+149+len("\n\nNone.") {
		t.Fatalf("the long heading: %d characters in the op; sizes %d, %d", toolChars(last.Heading), l.Notes[6].Size, l.Notes[7].Size)
	}
	if len(l.ChatOps) != 1 || l.ChatOps[0].Op != "edit_notes" || l.ChatOps[0].Error != toolChatNotes || len(l.State.Inbox) != 0 {
		t.Fatalf("chatOps: %+v", l.ChatOps)
	}
}

func TestToolTextsWaitFor(t *testing.T) {
	x := toolUpdateRun(t) // T01 done, T02 merging, T03 failed, T04 blocked, T05 running, T06 waiting
	x.say("a chat calls wait_for", "chat", "wait_for", `{"tasks":["T05"]}`)
	x.say("no tasks given", "orchestrator", "wait_for", `{}`)
	x.say("tasks is not a list", "orchestrator", "wait_for", `{"tasks":"T05"}`)
	x.say("tasks is a list of other things", "orchestrator", "wait_for", `{"tasks":[5]}`)
	x.say("an empty list", "orchestrator", "wait_for", `{"tasks":[]}`)
	x.say("a mode that is none", "orchestrator", "wait_for", `{"tasks":["T05"],"mode":"first"}`)
	x.say("tasks that do not exist", "orchestrator", "wait_for", `{"tasks":["T05","T9","T10"]}`)
	x.say("tasks that have ended", "orchestrator", "wait_for", `{"tasks":["T01","T05","T03"]}`)
	if w := x.state().State.Wait; w != nil {
		t.Fatalf("a refused wait_for set a wait: %+v", w)
	}
	x.say("all of two, one named twice", "orchestrator", "wait_for", `{"tasks":["T05","T02","T05"]}`)
	if w := x.state().State.Wait; w == nil || fmt.Sprint(w.Tasks) != "[T05 T02]" || w.Mode != "all" || w.Turn != 2 {
		t.Fatalf("the wait: %+v", w)
	}
	x.say("again in the same turn: the last one holds", "orchestrator", "wait_for", `{"tasks":["T06","T04","T05"],"mode":"any"}`)
	if w := x.state().State.Wait; w == nil || fmt.Sprint(w.Tasks) != "[T06 T04 T05]" || w.Mode != "any" || w.Turn != 2 {
		t.Fatalf("the wait: %+v", w)
	}
	if text := x.ok("orchestrator", "get_run", `{}`); !strings.Contains(text, "\nNext turn: when any of T06, T04, T05 have ended (asked in turn 2), or earlier if a task fails, nothing is left running, or a chat on the run changes it.\n") {
		t.Fatalf("get_run does not say what is waited for:\n%s", text)
	}
	x.say("a refused call leaves the wait as it is", "orchestrator", "wait_for", `{"tasks":["T01"]}`)
	if w := x.state().State.Wait; w == nil || len(w.Tasks) != 3 {
		t.Fatalf("the wait: %+v", w)
	}
	x.say("mode all, given", "orchestrator", "wait_for", `{"tasks":["T05"],"mode":"all"}`)
	// A run whose wake mode is not declared has no wait_for: it is refused as an unknown tool is.
	x.wake("each")
	x.say("the run's wake mode is each", "orchestrator", "wait_for", `{"tasks":["T02"]}`)
	x.say("the run's wake mode is each, a chat", "chat", "wait_for", `{"tasks":["T02"]}`)
	x.wake("idle")
	x.say("the run's wake mode is idle", "orchestrator", "wait_for", `{"tasks":["T02"]}`)
	x.wake("")
	x.say("no wake mode recorded counts as declared", "orchestrator", "wait_for", `{"tasks":["T02"],"mode":""}`)
	x.wake("declared")
	// A stopping run is not changed.
	x.must(x.r, KRunStopping, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.Halting = model.RunStopping, &Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}
		return nil
	})
	x.say("the run is stopping", "orchestrator", "wait_for", `{"tasks":["T05"]}`)
	x.golden("wait_for")

	l := x.state()
	if w := l.State.Wait; w == nil || fmt.Sprint(w.Tasks) != "[T02]" || w.Mode != "all" {
		t.Fatalf("the wait at the end: %+v", w)
	}
	var said []string
	for _, op := range l.Turns[1].Ops {
		if op.Op == "wait_for" {
			said = append(said, fmt.Sprintf("%v/%s/%v", op.Tasks, op.Mode, op.Error != ""))
		}
	}
	if got := strings.Join(said, " "); got != "[]//true []//true []//true []//true []//true []//true []//true [T05 T02]/all/false [T06 T04 T05]/any/false []//true [T05]/all/false []//true []//true [T02]/all/false []//true" {
		t.Fatalf("wait_for ops: %s", got)
	}
	for _, op := range l.Turns[1].Ops {
		if op.Op == "wait_for" && op.Error == "unknown tool wait_for" {
			said = nil
		}
	}
	if said != nil {
		t.Fatal("the call in the wake mode each is not recorded as a refused op")
	}
	if len(l.ChatOps) != 2 || l.ChatOps[0].Error != toolChatWait || l.ChatOps[1].Error != toolChatWait || len(l.State.Inbox) != 0 {
		t.Fatalf("chatOps: %+v; inbox %+v", l.ChatOps, l.State.Inbox)
	}
}

func TestToolTextsAddTask(t *testing.T) {
	x := newToolRun(t, true)
	x.turnStart("start")
	x.say("fields are missing", "orchestrator", "add_task", `{"title":"Read the importer"}`)
	x.say("the tier and its reason are missing", "orchestrator", "add_task", `{"title":"Read","brief":"`+toolBrief+`","kind":"research","writes":false}`)
	x.say("the tier is none of the three", "orchestrator", "add_task", `{"title":"  ","brief":"`+toolBrief+`","kind":"research","writes":false,"tier":"heavy","tier_reason":"A later task checks it."}`)
	x.say("the tier's reason is empty", "orchestrator", "add_task", `{"title":"  ","brief":"`+toolBrief+`","kind":"research","writes":false,"tier":"light","tier_reason":" \n "}`)
	x.say("the title is empty", "orchestrator", "add_task", `{"title":"  ","brief":"`+toolBrief+`","kind":"research","writes":false,"tier":"standard","tier_reason":"A later task checks it."}`)
	x.say("the brief is too short", "orchestrator", "add_task", `{"title":"Read","brief":"Read it.","kind":"research","writes":false,"tier":"standard","tier_reason":"A later task checks it."}`)
	x.say("the kind is no word", "orchestrator", "add_task", `{"title":"Read","brief":"`+toolBrief+`","kind":"!!!","writes":false,"tier":"standard","tier_reason":"A later task checks it."}`)
	x.say("the kind starts with a digit", "orchestrator", "add_task", `{"title":"Read","brief":"`+toolBrief+`","kind":"2nd pass","writes":false,"tier":"standard","tier_reason":"A later task checks it."}`)
	x.say("writes is not a boolean", "orchestrator", "add_task", `{"title":"Read","brief":"`+toolBrief+`","kind":"research","writes":"no","tier":"standard","tier_reason":"A later task checks it."}`)
	x.say("depends_on is not a list", "orchestrator", "add_task", `{"title":"Read","brief":"`+toolBrief+`","kind":"research","writes":false,"tier":"standard","tier_reason":"A later task checks it.","depends_on":"T01"}`)
	x.say("depends_on names tasks that do not exist", "orchestrator", "add_task", toolAdd("Read", "research", false, "T07", "T09", "T07"))
	x.say("needs_report is not a list", "orchestrator", "add_task", `{"title":"Read","brief":"`+toolBrief+`","kind":"research","writes":false,"tier":"standard","tier_reason":"A later task checks it.","needs_report":"T01"}`)
	x.say("needs_report names a task it does not depend on", "orchestrator", "add_task", `{"title":"Read","brief":"`+toolBrief+`","kind":"research","writes":false,"tier":"standard","tier_reason":"A later task checks it.","needs_report":["T01"]}`)
	x.say("the notes gate", "orchestrator", "add_task", toolAdd("Build the importer", "implement", true))
	x.say("the notes gate, a chat", "chat", "add_task", toolAdd("Build the importer", "implement", true))
	x.say("added: a task that only reports", "orchestrator", "add_task", toolAdd("  Read the   old importer ", "Research", false))
	x.ok("orchestrator", "set_notes", toolNotes)
	x.say("added: a task that writes and depends on another", "orchestrator", "add_task", toolAdd("Build the importer", "implement", true, "T01", "T01"))
	x.say("added: the kind is made one word", "orchestrator", "add_task", toolAdd("Look at it again", "Code Review!", false))
	x.turnEnd("Three tasks added.", 0.25)
	x.taskRuns("T01")
	x.taskFail("T01", "agent T01-work failed: the process ended in the turn")
	x.turnStart("events")
	x.say("added: it depends on a failed task", "orchestrator", "add_task", toolAdd("Write the migration notes", "docs", false, "T01", "T02"))
	x.say("added by a chat", "chat", "add_task", toolAdd("Check the importer by hand", "verify", false, "T02"))
	x.say("added: on the deep tier, given the full report of one task", "orchestrator", "add_task",
		`{"title":"Decide the file format","brief":"`+toolBrief+`","kind":"design","writes":false,"tier":"deep","tier_reason":"  The other tasks are\nbuilt on its decision. ","depends_on":["T02","T03"],"needs_report":["T03","T03"]}`)
	x.say("added: given more full reports than a task should start with", "orchestrator", "add_task",
		`{"title":"Review the whole port","brief":"`+toolBrief+`","kind":"review","writes":false,"tier":"deep","tier_reason":"Nothing checks it.","depends_on":["T02","T03","T04","T06"],"needs_report":["T02","T03","T04","T06"]}`)
	x.golden("add_task")

	l := x.state()
	t1, _ := toolTask(l, "T01")
	if t1.Title != "Read the old importer" || t1.Kind != "research" || t1.Writes || t1.AddedTurn != 1 || t1.BriefRev != 1 || len(t1.Briefs) != 1 ||
		t1.Briefs[0].Turn != 1 || t1.Briefs[0].Size != toolChars(toolBrief) {
		t.Fatalf("T01: %+v", t1)
	}
	if brief, err := readBrief(x.r.dir, "T01", 1); err != nil || brief != toolBrief+"\n" {
		t.Fatalf("brief file: %q %v", brief, err)
	}
	t2, _ := toolTask(l, "T02")
	if !t2.Writes || fmt.Sprint(t2.DependsOn) != "[T01]" {
		t.Fatalf("T02: %+v", t2)
	}
	// Held by the turn that added it, then by nobody; held by the chat until its reply ends.
	t4, _ := toolTask(l, "T04")
	if fmt.Sprint(t4.HeldBy) != "[{2 }]" || t4.State() != model.TaskHeld || t4.AddedTurn != 2 || t4.AddedBy != "" {
		t.Fatalf("T04: held by %+v, %s", t4.HeldBy, t4.State())
	}
	t5, _ := toolTask(l, "T05")
	if fmt.Sprint(t5.HeldBy) != "[{0 chat-1}]" || t5.AddedBy != toolChat || t5.AddedTurn != 2 || t5.Attempts[0].QueuedBy != toolChat || t5.Briefs[0].Chat != toolChat {
		t.Fatalf("T05: %+v", t5)
	}
	if p := t5.Attempts[0].Phases; len(p) != 1 || p[0].K != model.TaskHeld || p[0].Chat != toolChat {
		t.Fatalf("T05 phases: %+v", p)
	}
	// The orchestrator's calls are ops of its turn, accepted and refused; the chat's are chatOps.
	ops := l.Turns[0].Ops
	if len(ops) != 18 || ops[0].Error != "missing: brief, kind, writes, tier, tier_reason" || ops[14].Task != "T01" || ops[14].Title != "Read the old importer" ||
		ops[14].Kind != "research" || ops[14].Writes == nil || *ops[14].Writes || ops[14].BriefRev != 1 || ops[16].Task != "T02" ||
		ops[14].Tier != model.TierStandard || ops[14].TierReason != "A build or a later task checks it." || len(ops[14].NeedsReport) != 0 {
		t.Fatalf("turn 1 ops: %+v", ops)
	}
	// The tier, its reason and the reports: on the task, on its first attempt, in the op.
	t6, _ := toolTask(l, "T06")
	if t6.Tier != model.TierDeep || t6.TierReason != "The other tasks are built on its decision." || fmt.Sprint(t6.NeedsReport) != "[T03]" || t6.Attempts[0].Tier != model.TierDeep {
		t.Fatalf("T06: %+v", t6)
	}
	if t1.Tier != model.TierStandard || t1.NeedsReport == nil || len(t1.NeedsReport) != 0 || t1.Attempts[0].Tier != model.TierStandard {
		t.Fatalf("T01's tier and reports: %+v", t1)
	}
	if op := l.Turns[1].Ops[1]; op.Task != "T06" || op.Tier != model.TierDeep || op.TierReason != t6.TierReason || fmt.Sprint(op.NeedsReport) != "[T03]" {
		t.Fatalf("the op of T06: %+v", op)
	}
	for i, op := range ops {
		if op.I != i || op.T == 0 || op.Op == "" {
			t.Fatalf("op %d: %+v", i, op)
		}
	}
	if len(l.ChatOps) != 2 || l.ChatOps[0].Error != clip(toolGateChat, 400) || l.ChatOps[0].Turn != 1 || l.ChatOps[1].Task != "T05" ||
		l.ChatOps[1].Chat != toolChat || l.ChatOps[1].Turn != 2 || l.ChatOps[1].I != 1 {
		t.Fatalf("chatOps: %+v", l.ChatOps)
	}
	// Only the accepted change of the chat made an event (the two task events were taken by turn 2).
	if in := l.State.Inbox; len(in) != 1 || in[0].Type != "chat_op" || in[0].Chat != toolChat || in[0].Task != "T05" ||
		in[0].Text != "A chat on the run added T05 [verify, reports only]: Check the importer by hand." {
		t.Fatalf("inbox: %+v", in)
	}
}

// toolUpdateRun is a run with a task in every state update_task tells apart.
func toolUpdateRun(t *testing.T) *toolRun {
	x := newToolRun(t, true)
	x.turnStart("start")
	x.ok("orchestrator", "set_notes", toolNotes)
	x.ok("orchestrator", "add_task", toolAdd("Read the old importer", "research", false))        // T01: done
	x.ok("orchestrator", "add_task", toolAdd("Build the importer", "implement", true))           // T02: merging
	x.ok("orchestrator", "add_task", toolAdd("Measure the old importer", "verify", false))       // T03: failed
	x.ok("orchestrator", "add_task", toolAdd("Write the migration notes", "docs", false, "T03")) // T04: blocked
	x.ok("orchestrator", "add_task", toolAdd("Port the tests", "implement", true))               // T05: running
	x.ok("orchestrator", "add_task", toolAdd("Clean up", "implement", true, "T02"))              // T06: waiting on T02
	x.turnEnd("Six tasks added.", 0.25)
	for _, tid := range []string{"T01", "T02", "T03", "T05"} {
		x.tick(2 * time.Second)
		x.taskRuns(tid)
	}
	x.tick(4 * time.Minute)
	x.taskResult("T01", "completed", "The old importer reads CSV in three passes.", "# Report\n\nThree passes: sniff, parse, write.", 0.5)
	x.taskDone("T01")
	x.taskResult("T02", "completed", "Built the importer.", "# Report\n\nOne pass.", 1.25)
	x.taskFail("T03", "its agent reported that it could not do the task: there is no benchmark data in the repository")
	x.tick(time.Minute)
	x.turnStart("events")
	return x
}

func TestToolTextsUpdateTask(t *testing.T) {
	x := toolUpdateRun(t)
	x.say("no such task", "orchestrator", "update_task", `{"id":"T09","title":"x"}`)
	x.say("no id", "orchestrator", "update_task", `{"title":"x"}`)
	x.say("a done task", "orchestrator", "update_task", `{"id":"T01","title":"Read it again"}`)
	x.say("a task that is being merged", "orchestrator", "update_task", `{"id":"T02","title":"Build it better"}`)
	x.say("a running task", "orchestrator", "update_task", `{"id":"T05","title":"Port all the tests"}`)
	x.say("nothing to change", "orchestrator", "update_task", `{"id":"T06"}`)
	x.say("it already is as described", "orchestrator", "update_task", `{"id":"T06","title":"Clean  up","kind":"implement","writes":true,"depends_on":["T02"],"brief":"`+toolBrief+`"}`)
	x.say("the title is empty", "orchestrator", "update_task", `{"id":"T06","title":""}`)
	x.say("the brief is too short", "orchestrator", "update_task", `{"id":"T06","brief":"Tidy."}`)
	x.say("it cannot depend on itself", "orchestrator", "update_task", `{"id":"T06","depends_on":["T06"]}`)
	x.say("a dependency cycle", "orchestrator", "update_task", `{"id":"T03","depends_on":["T04"]}`)
	x.say("depends_on names tasks that do not exist", "orchestrator", "update_task", `{"id":"T06","depends_on":["T02","T77"]}`)
	x.say("the tier is none of the three", "orchestrator", "update_task", `{"id":"T06","tier":"cheap"}`)
	x.say("the tier's reason is empty", "orchestrator", "update_task", `{"id":"T06","tier_reason":""}`)
	x.say("needs_report is not a list", "orchestrator", "update_task", `{"id":"T06","needs_report":"T02"}`)
	x.say("needs_report names a task it does not depend on", "orchestrator", "update_task", `{"id":"T06","needs_report":["T02","T01"]}`)
	x.say("updated: a waiting task", "orchestrator", "update_task", `{"id":"T06","title":"Clean up the old importer","brief":"Remove the old importer once the new one is merged, with its tests and its fixtures.","depends_on":["T02","T05"]}`)
	x.say("updated: a failed task", "orchestrator", "update_task", `{"id":"T03","brief":"Measure the old importer on the fixture files under testdata/, three runs each, and report the times."}`)
	x.say("updated: it depends on a failed task", "orchestrator", "update_task", `{"id":"T04","kind":"Writing"}`)
	x.say("updated by a chat", "chat", "update_task", `{"id":"T04","title":"Write the migration guide","writes":true}`)
	x.say("refused for a chat", "chat", "update_task", `{"id":"T01","title":"x"}`)
	x.say("updated: the tier of a waiting task, and the reports it is given", "orchestrator", "update_task", `{"id":"T06","tier":"light","tier_reason":"It follows a recipe.","needs_report":["T05","T02"]}`)
	x.say("updated: it no longer depends on a task whose report it was given", "orchestrator", "update_task", `{"id":"T06","depends_on":["T02"]}`)
	x.say("updated: the tier of a failed task", "orchestrator", "update_task", `{"id":"T03","tier":"deep"}`)

	// The notes gate, in a run that has no notes.
	y := newToolRun(t, true)
	y.turnStart("start")
	y.ok("orchestrator", "add_task", toolAdd("Read the old importer", "research", false))
	text, isErr := y.orch("update_task", `{"id":"T01","writes":true}`)
	x.write("the notes gate", "orchestrator", "update_task", `{"id":"T01","writes":true}`, text, isErr)
	text, isErr = y.chat("update_task", `{"id":"T01","writes":true}`)
	x.write("the notes gate, a chat", "chat", "update_task", `{"id":"T01","writes":true}`, text, isErr)
	x.golden("update_task")

	l := x.state()
	t6, _ := toolTask(l, "T06")
	if t6.Title != "Clean up the old importer" || t6.BriefRev != 2 || len(t6.Briefs) != 2 || t6.Briefs[1].Turn != 2 || fmt.Sprint(t6.DependsOn) != "[T02]" ||
		t6.Tier != model.TierLight || t6.TierReason != "It follows a recipe." || fmt.Sprint(t6.NeedsReport) != "[T02]" || toolLastAttempt(t6).Tier != model.TierLight ||
		fmt.Sprint(t6.ChangedTurns) != "[2]" || fmt.Sprint(t6.HeldBy) != "[{2 }]" || t6.State() != model.TaskHeld {
		t.Fatalf("T06: %+v", t6)
	}
	if brief, err := readBrief(x.r.dir, "T06", 2); err != nil || !strings.HasPrefix(brief, "Remove the old importer") {
		t.Fatalf("T06 brief 2: %q %v", brief, err)
	}
	// A failed task keeps its state and is not held; a chat's change holds a waiting task by the chat.
	t3, _ := toolTask(l, "T03")
	if t3.State() != model.TaskFailed || len(t3.HeldBy) != 0 || t3.BriefRev != 2 {
		t.Fatalf("T03: %s, held %+v, rev %d", t3.State(), t3.HeldBy, t3.BriefRev)
	}
	// Its tier is the next attempt's: the attempt that failed keeps the one it ran on.
	if t3.Tier != model.TierDeep || toolLastAttempt(t3).Tier != model.TierStandard {
		t.Fatalf("T03: tier %s, its attempt's %s", t3.Tier, toolLastAttempt(t3).Tier)
	}
	t4, _ := toolTask(l, "T04")
	if t4.Kind != "writing" || !t4.Writes || t4.Title != "Write the migration guide" || fmt.Sprint(t4.HeldBy) != "[{2 } {0 chat-1}]" || fmt.Sprint(t4.ChangedTurns) != "[2]" {
		t.Fatalf("T04: %+v", t4)
	}
	ops := l.Turns[1].Ops
	last := ops[len(ops)-6]
	if last.Task != "T06" || fmt.Sprint(last.Changed) != "[title brief depends_on]" || last.BriefRev != 2 || fmt.Sprint(last.DependsOn) != "[T02 T05]" || last.Title != "Clean up the old importer" {
		t.Fatalf("the op of the update: %+v", last)
	}
	if op := ops[len(ops)-3]; fmt.Sprint(op.Changed) != "[tier tier_reason needs_report]" || op.Tier != model.TierLight || fmt.Sprint(op.NeedsReport) != "[T05 T02]" {
		t.Fatalf("the op of the tier's update: %+v", op)
	}
	if op := ops[len(ops)-2]; fmt.Sprint(op.Changed) != "[depends_on needs_report]" || fmt.Sprint(op.DependsOn) != "[T02]" || fmt.Sprint(op.NeedsReport) != "[T02]" {
		t.Fatalf("the op of the cut: %+v", op)
	}
	if len(l.ChatOps) != 2 || fmt.Sprint(l.ChatOps[0].Changed) != "[title writes]" || l.ChatOps[1].Error == "" || l.ChatOps[1].Task != "T01" {
		t.Fatalf("chatOps: %+v", l.ChatOps)
	}
	if in := l.State.Inbox; len(in) != 1 || in[0].Text != "A chat on the run changed T04 (title, writes)." {
		t.Fatalf("inbox: %+v", in)
	}
}

func TestToolTextsCancelTask(t *testing.T) {
	x := toolUpdateRun(t)
	failedAt := x.last("T03").EndedAt
	x.say("no such task", "orchestrator", "cancel_task", `{"id":"T9","reason":"not needed"}`)
	x.say("the reason is empty", "orchestrator", "cancel_task", `{"id":"T06","reason":"  "}`)
	x.say("a done task", "orchestrator", "cancel_task", `{"id":"T01","reason":"not needed"}`)
	x.tick(time.Minute)
	x.say("cancelled: a failed task that another waits for", "orchestrator", "cancel_task", `{"id":"T03","reason":"there is nothing to measure"}`)
	x.say("already cancelled", "orchestrator", "cancel_task", `{"id":"T03","reason":"again"}`)
	x.ok("orchestrator", "wait_for", `{"tasks":["T04","T02"],"mode":"any"}`)
	x.say("cancelled: a waiting task that the orchestrator waits for", "orchestrator", "cancel_task", `{"id":"T04","reason":"the notes are not needed"}`)
	if w := x.state().State.Wait; w == nil || fmt.Sprint(w.Tasks) != "[T02]" || w.Mode != "any" || w.Turn != 2 {
		t.Fatalf("the wait without T04: %+v", w)
	}

	// A task that has a slot is the engine's to end; what it answers is the refusal.
	x.fake.set(func(f *svcFake) { f.cancel = "T02 has finished and is being merged; it can no longer be cancelled." })
	x.say("a task that is being merged", "orchestrator", "cancel_task", `{"id":"T02","reason":"wrong approach"}`)
	x.fake.set(func(f *svcFake) { f.cancel = "T05 is starting; try again in a moment" })
	x.say("a task that is starting", "orchestrator", "cancel_task", `{"id":"T05","reason":"wrong approach"}`)
	x.fake.set(func(f *svcFake) { f.cancel = "T05 is being stopped but has not let go yet; look again with get_run" })
	x.say("a task whose agent does not let go", "orchestrator", "cancel_task", `{"id":"T05","reason":"wrong approach"}`)
	x.fake.set(func(f *svcFake) { f.cancel = "" })
	real := x.s.engine.cancelActive
	x.s.engine.cancelActive = func(r *run, tid string, c model.AttemptCancel) string {
		x.taskResult(tid, "completed", "Ported the tests.", "", 0.75) // it finished while it was being stopped
		return ""
	}
	x.say("a task that ended otherwise while it was being stopped", "orchestrator", "cancel_task", `{"id":"T05","reason":"wrong approach"}`)
	x.s.engine.cancelActive = real
	if w := x.state().State.Wait; w == nil || fmt.Sprint(w.Tasks) != "[T02]" {
		t.Fatalf("a refused cancel changed the wait: %+v", w)
	}
	x.say("cancelled: a running task, the last one waited for", "orchestrator", "cancel_task", `{"id":"T02","reason":"wrong approach"}`)
	if w := x.state().State.Wait; w != nil {
		t.Fatalf("a wait with no task is left: %+v", w)
	}
	x.ok("orchestrator", "add_task", toolAdd("Try the other approach", "implement", true))
	x.ok("orchestrator", "wait_for", `{"tasks":["T07","T06"]}`)
	x.say("cancelled by a chat: the orchestrator's wait stays", "chat", "cancel_task", `{"id":"T07","reason":"the user changed their mind"}`)
	if w := x.state().State.Wait; w == nil || fmt.Sprint(w.Tasks) != "[T07 T06]" {
		t.Fatalf("a chat's cancel changed the wait: %+v", w)
	}
	x.say("refused for a chat", "chat", "cancel_task", `{"id":"T07","reason":"again"}`)
	x.golden("cancel_task")

	l := x.state()
	// A failed task that is cancelled keeps the end, the error and the phases of its failure.
	t3, _ := toolTask(l, "T03")
	a := toolLastAttempt(t3)
	if a.Outcome != model.TaskCancelled || a.EndedAt != failedAt || a.Error == "" || a.Cancel == nil || a.Cancel.Turn != 2 || a.Cancel.Reason != "there is nothing to measure" {
		t.Fatalf("T03: %+v cancel %+v", a.RunAttempt, a.Cancel)
	}
	// A waiting task ends now and loses its holds.
	t4, _ := toolTask(l, "T04")
	if a := toolLastAttempt(t4); a.Outcome != model.TaskCancelled || a.EndedAt != a.Cancel.T || a.EndedAt == 0 || len(t4.HeldBy) != 0 {
		t.Fatalf("T04: %+v", a.RunAttempt)
	}
	t7, _ := toolTask(l, "T07")
	if a := toolLastAttempt(t7); a.Outcome != model.TaskCancelled || a.Cancel.Chat != toolChat || a.Cancel.Turn != 0 || len(t7.HeldBy) != 0 {
		t.Fatalf("T07: %+v", a.Cancel)
	}
	if in := l.State.Inbox; len(in) != 1 || in[0].Text != "A chat on the run cancelled T07: the user changed their mind" || in[0].Task != "T07" {
		t.Fatalf("inbox: %+v", in)
	}
	if got := strings.Join(x.fake.called(), "; "); strings.Count(got, "cancelActive") != 4 {
		t.Fatalf("the engine was asked: %s", got)
	}
	// No cancel of the orchestrator makes an event; every one is an op with its reason.
	var reasons []string
	for _, op := range l.Turns[1].Ops {
		if op.Op == "cancel_task" && op.Error == "" {
			reasons = append(reasons, op.Task+": "+op.Reason)
		}
	}
	if fmt.Sprint(reasons) != "[T03: there is nothing to measure T04: the notes are not needed T02: wrong approach]" {
		t.Fatalf("accepted cancels: %v", reasons)
	}
}

func TestToolTextsRetryTask(t *testing.T) {
	x := toolUpdateRun(t)
	x.say("no such task", "orchestrator", "retry_task", `{"id":"T44","reason":"again"}`)
	x.say("the reason is empty", "orchestrator", "retry_task", `{"id":"T03"}`)
	x.say("a waiting task", "orchestrator", "retry_task", `{"id":"T06","reason":"again"}`)
	x.say("a running task", "orchestrator", "retry_task", `{"id":"T05","reason":"again"}`)
	x.say("a task that is being merged", "orchestrator", "retry_task", `{"id":"T02","reason":"again"}`)
	x.say("a done task", "orchestrator", "retry_task", `{"id":"T01","reason":"again"}`)
	x.say("the tier is none of the three", "orchestrator", "retry_task", `{"id":"T03","reason":"again","tier":"deeper"}`)
	x.say("queued again", "orchestrator", "retry_task", `{"id":"T03","reason":"the fixture files are in testdata/ now"}`)
	x.ok("orchestrator", "cancel_task", `{"id":"T03","reason":"not after all"}`)
	x.ok("orchestrator", "cancel_task", `{"id":"T04","reason":"not needed"}`)
	x.say("queued again by a chat: it depends on a cancelled task", "chat", "retry_task", `{"id":"T04","reason":"the user wants the notes"}`)
	x.say("refused for a chat", "chat", "retry_task", `{"id":"T04","reason":"again"}`)
	x.say("queued again on a higher tier", "orchestrator", "retry_task", `{"id":"T03","reason":"it was  too hard\nfor its agent","tier":"deep"}`)

	// Without git there is no checkout to speak of.
	y := newToolRun(t, false)
	y.turnStart("start")
	y.ok("orchestrator", "add_task", toolAdd("Read the old importer", "research", false))
	y.ok("orchestrator", "cancel_task", `{"id":"T01","reason":"not yet"}`)
	text, isErr := y.orch("retry_task", `{"id":"T01","reason":"now"}`)
	x.write("queued again, in a run without git", "orchestrator", "retry_task", `{"id":"T01","reason":"now"}`, text, isErr)
	x.golden("retry_task")

	l := x.state()
	t3, _ := toolTask(l, "T03")
	if len(t3.Attempts) != 3 || t3.Attempts[0].Outcome != model.TaskFailed || t3.Attempts[0].Cancel != nil || t3.Attempts[1].QueuedTurn != 2 ||
		t3.Attempts[1].Outcome != model.TaskCancelled || fmt.Sprint(t3.ChangedTurns) != "[2]" {
		t.Fatalf("T03: %+v", t3.Attempts)
	}
	// A retry on another tier changes the task's tier, with the retry's reason; the earlier attempts keep theirs.
	if t3.Tier != model.TierDeep || t3.TierReason != "it was too hard for its agent" || t3.Attempts[1].Tier != model.TierStandard || t3.Attempts[2].Tier != model.TierDeep {
		t.Fatalf("T03: tier %s (%s), attempts %s and %s", t3.Tier, t3.TierReason, t3.Attempts[1].Tier, t3.Attempts[2].Tier)
	}
	ops := l.Turns[1].Ops
	if op := ops[len(ops)-1]; op.Op != "retry_task" || op.Attempt != 3 || op.Tier != model.TierDeep {
		t.Fatalf("the op of the retry: %+v", op)
	}
	t4, _ := toolTask(l, "T04")
	if len(t4.Attempts) != 2 || t4.Attempts[1].QueuedBy != toolChat || fmt.Sprint(t4.HeldBy) != "[{0 chat-1}]" || t4.State() != model.TaskHeld ||
		t4.Attempts[0].Cancel == nil || t4.Attempts[0].Cancel.Reason != "not needed" {
		t.Fatalf("T04: %+v held %+v", t4.Attempts, t4.HeldBy)
	}
	if in := l.State.Inbox; len(in) != 1 || in[0].Text != "A chat on the run queued T04 again as attempt 2: the user wants the notes" {
		t.Fatalf("inbox: %+v", in)
	}
	if len(l.ChatOps) != 2 || l.ChatOps[0].Attempt != 2 || l.ChatOps[0].Reason != "the user wants the notes" || l.ChatOps[1].Error == "" {
		t.Fatalf("chatOps: %+v", l.ChatOps)
	}
}

func TestToolTextsFinishRun(t *testing.T) {
	x := toolUpdateRun(t)
	x.say("the outcome is neither", "orchestrator", "finish_run", `{"outcome":"done","summary":"Done."}`)
	x.say("the summary is empty", "orchestrator", "finish_run", `{"outcome":"achieved","summary":" "}`)
	x.say("tasks are not finished", "orchestrator", "finish_run", `{"outcome":"achieved","summary":"The importer is ported."}`)
	x.ok("orchestrator", "cancel_task", `{"id":"T02","reason":"not needed"}`)
	x.ok("orchestrator", "cancel_task", `{"id":"T04","reason":"not needed"}`)
	x.ok("orchestrator", "cancel_task", `{"id":"T05","reason":"not needed"}`)
	x.ok("orchestrator", "cancel_task", `{"id":"T06","reason":"not needed"}`)
	x.say("the run ends: failed and cancelled tasks do not stand in the way", "orchestrator", "finish_run", `{"outcome":"not_achieved","summary":"The importer could not be ported: there is nothing to measure it against."}`)
	x.say("after finish_run, the orchestrator's change", "orchestrator", "add_task", toolAdd("One more", "research", false))
	x.say("after finish_run, a chat's change", "chat", "add_task", toolAdd("One more", "research", false))
	x.say("after finish_run, finish_run again", "orchestrator", "finish_run", `{"outcome":"achieved","summary":"Done after all."}`)
	if text, isErr := x.orch("get_notes", `{}`); isErr {
		t.Fatalf("a read after finish_run: %s", text)
	}
	x.golden("finish_run")

	l := x.state()
	if r := l.State.Result; r == nil || r.Outcome != model.NotAchieved || r.Turn != 2 || r.At == 0 || !strings.HasPrefix(r.Summary, "The importer could not") {
		t.Fatalf("result: %+v", r)
	}
	if l.State.Status != model.RunRunning {
		t.Fatalf("the tool ended the run itself: %s", l.State.Status)
	}
	ops := l.Turns[1].Ops
	if op := ops[len(ops)-4]; op.Op != "finish_run" || op.Outcome != model.NotAchieved || op.Text == "" || op.Error != "" {
		t.Fatalf("the op: %+v", op)
	}
}

func TestToolTextsTellOrchestrator(t *testing.T) {
	x := newToolRun(t, false)
	x.say("the message is empty", "chat", "tell_orchestrator", `{"text":" "}`)
	x.say("the message is too long", "chat", "tell_orchestrator", toolArgsJSON(t, map[string]string{"text": strings.Repeat("word ", 801)}))
	x.say("passed on: no turn is running", "chat", "tell_orchestrator", `{"text":"Use the new CSV library, not the old one."}`)
	x.turnStart("events")
	x.say("passed on: a turn is running", "chat", "tell_orchestrator", `{"text":"And keep the old flags."}`)
	x.turnEnd("Noted.", 0.1)
	x.must(x.r, KRunStopping, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.Halting = model.RunStopping, &Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser}
		return nil
	})
	if err := x.fake.halted(x.r); err != nil {
		t.Fatal(err)
	}
	x.say("passed on: the run is stopped", "chat", "tell_orchestrator", `{"text":"When you go on: tests first."}`)
	x.golden("tell_orchestrator")

	l := x.state()
	if w := l.Turns[0].WokenBy; len(w) != 1 || w[0].Type != "chat_op" || w[0].Chat != toolChat ||
		w[0].Text != "Message from the person, passed on by a chat on the run:\nUse the new CSV library, not the old one." {
		t.Fatalf("turn 1 was woken by %+v", w)
	}
	if len(l.State.Inbox) != 2 || len(l.ChatOps) != 5 || l.ChatOps[2].Text != "Use the new CSV library, not the old one." || l.ChatOps[0].Error != "the message is empty" {
		t.Fatalf("inbox %+v, chatOps %+v", l.State.Inbox, l.ChatOps)
	}
	// A message makes no hold: there is no task.
	for _, task := range l.Tasks {
		if len(task.HeldBy) != 0 {
			t.Fatalf("%s is held by %+v", task.ID, task.HeldBy)
		}
	}
}

func TestToolTextsGetNotes(t *testing.T) {
	x := newToolRun(t, false)
	x.turnStart("start")
	x.say("no notes yet", "orchestrator", "get_notes", `{}`)
	x.say("no notes yet, a chat asks for a version", "chat", "get_notes", `{"version":2}`)
	x.ok("orchestrator", "set_notes", toolNotes)
	x.turnEnd("Notes written.", 0.1)
	x.must(x.r, KOp, func(tx *Tx) error { // a second version, as the first turn's
		tx.AddNotes(model.NotesVersion{V: 2, At: tx.Now(), Turn: 1, Size: 15})
		tx.File(notesRel(2), []byte("# Goal\n\nShorter."))
		return nil
	})
	x.turnStart("idle")
	x.say("the current version", "orchestrator", "get_notes", `{}`)
	x.say("an earlier version", "chat", "get_notes", `{"version":1}`)
	x.say("no such version", "chat", "get_notes", `{"version":7}`)
	x.say("the version is no number", "orchestrator", "get_notes", `{"version":"two"}`)
	x.say("the offset is no number", "orchestrator", "get_notes", `{"offset":"start"}`)
	x.say("the offset is past the end", "chat", "get_notes", `{"offset":5000}`)
	x.say("from an offset", "chat", "get_notes", `{"version":1,"offset":70}`)
	x.golden("get_notes")

	// The orchestrator's reads are ops of its turn; a chat's reads are recorded nowhere.
	l := x.state()
	if ops := l.Turns[1].Ops; len(ops) != 3 || ops[0].NotesVersion != 2 || ops[1].Error == "" || len(l.ChatOps) != 0 {
		t.Fatalf("turn 2 ops %+v, chatOps %+v", ops, l.ChatOps)
	}
}

func TestToolTextsGetTask(t *testing.T) {
	x := toolUpdateRun(t)
	x.ok("orchestrator", "retry_task", `{"id":"T03","reason":"it was too hard for its agent","tier":"deep"}`)
	x.ok("chat", "add_task", toolAdd("Check the importer by hand", "verify", false, "T02"))
	x.ok("orchestrator", "cancel_task", `{"id":"T05","reason":"the tests move with the importer"}`)
	x.ok("orchestrator", "update_task", `{"id":"T06","tier":"light","tier_reason":"It follows a recipe.","needs_report":["T02"]}`)
	x.turnEnd("Retried T03.", 0.2)
	x.tick(30 * time.Second)
	x.taskDone("T02")
	x.taskRuns("T03")
	x.must(x.r, KTaskStep, func(tx *Tx) error { // what the engine records of an agent's usage and of its model's effort
		tx.Agent(AgentChatID(x.id, "T02-work")).PeakContext = 148300
		g := tx.Agent(AgentChatID(x.id, "T03-a2-work"))
		g.Model, g.Effort = "opus", "high"
		return nil
	})
	x.tick(95 * time.Second)

	x.say("no such task", "chat", "get_task", `{"id":"T77"}`)
	x.say("no id", "chat", "get_task", `{}`)
	x.say("no such attempt", "chat", "get_task", `{"id":"T03","attempt":3}`)
	x.say("the part is neither", "chat", "get_task", `{"id":"T03","part":"result"}`)
	x.say("a done task that only reports", "chat", "get_task", `{"id":"T01"}`)
	x.say("a done task that writes: commits, files, agents, result, report", "chat", "get_task", `{"id":"T02"}`)
	x.say("a running task in its second attempt", "chat", "get_task", `{"id":"T03"}`)
	x.say("its first attempt", "chat", "get_task", `{"id":"T03","attempt":1}`)
	x.say("a task that waits for a failed one", "chat", "get_task", `{"id":"T04"}`)
	x.say("a cancelled task with a branch", "chat", "get_task", `{"id":"T05"}`)
	x.say("a task a chat added, held by the chat", "chat", "get_task", `{"id":"T07"}`)
	x.say("only the brief", "chat", "get_task", `{"id":"T06","part":"brief"}`)
	x.say("only the report", "chat", "get_task", `{"id":"T02","part":"report"}`)
	x.say("only the report, of an attempt that has none", "chat", "get_task", `{"id":"T03","part":"report"}`)
	x.say("only the report, past its end", "chat", "get_task", `{"id":"T02","part":"report","offset":900}`)
	x.turnStart("events")
	x.say("the orchestrator reads a task: its tier, and the report it is given", "orchestrator", "get_task", `{"id":"T06"}`)
	x.say("the orchestrator asks for a task that is not there", "orchestrator", "get_task", `{"id":"T0"}`)
	x.golden("get_task")

	l := x.state()
	if ops := l.Turns[2].Ops; len(ops) != 2 || ops[0].Op != "get_task" || ops[0].Task != "T06" || ops[0].Error != "" || ops[1].Error == "" {
		t.Fatalf("turn 3 ops: %+v", ops)
	}
	if len(l.ChatOps) != 1 { // the chat's add_task; none of its reads
		t.Fatalf("chatOps: %+v", l.ChatOps)
	}
}

func TestToolTextsGetAgent(t *testing.T) {
	x := toolUpdateRun(t)
	str := func(s string) *string { return &s }
	x.host.items[AgentChatID(x.id, "T05-work")] = []model.Item{
		{Kind: "user", Text: "You are one of the agents of an automated build run."},
		{Kind: "text", Text: "I'll start by reading\nthe old tests."},
		{Kind: "tool", Name: "Read", Input: json.RawMessage(`{"file_path":"internal/importer/importer_test.go"}`), Result: str("…")},
		{Kind: "tool", Name: "Bash", Input: json.RawMessage(`{"command":"go test ./internal/importer/ 2>&1 | tail -5\necho done","description":"Run the tests"}`), Result: str("exit status 1\nFAIL"), IsError: true},
		{Kind: "perm", ToolName: "Bash"},
		{Kind: "tool", Name: "Grep", Input: json.RawMessage(`{"pattern":"func Test","path":"internal"}`), Result: str("…")},
		{Kind: "note", Text: "The agent's process ended.", Tone: "error"},
		{Kind: "note", Text: "Stopped.", Tone: "muted"},
		{Kind: "tool", Name: "mcp__board__spawn_subagent", Input: json.RawMessage(`{"prompt":"Port TestSniff.","description":"Port one test"}`)},
		{Kind: "subresult", Subagent: "s1"},
		{Kind: "tool", Name: "TodoWrite", Input: json.RawMessage(`{"todos":[]}`)},
		{Kind: "text", Text: "Two of five tests are ported."},
		{Kind: "end"},
	}
	x.host.items[AgentChatID(x.id, "T01-work")] = []model.Item{
		{Kind: "text", Text: "Reading the importer."},
		{Kind: "tool", Name: "Read", Input: json.RawMessage(`{"file_path":"internal/importer/importer.go"}`), Result: str("…")},
		{Kind: "text", Text: "<result>\n<outcome>completed</outcome>\n<summary>The old importer reads CSV in three passes.</summary>\n</result>"},
		{Kind: "end"},
	}
	x.tick(42 * time.Second)

	x.say("no such agent", "chat", "get_agent", `{"agent":"T09-work"}`)
	x.say("no agent named", "chat", "get_agent", `{}`)
	x.say("last is no number", "chat", "get_agent", `{"agent":"T05-work","last":"many"}`)
	x.say("a running agent", "chat", "get_agent", `{"agent":"T05-work"}`)
	x.say("its last three steps", "chat", "get_agent", `{"agent":"T05-work","last":3}`)
	x.say("an agent that is done: its final message", "chat", "get_agent", `{"agent":"T01-work"}`)
	x.say("an agent that failed, with nothing in its thread", "chat", "get_agent", `{"agent":"T03-work"}`)
	x.say("an orchestrator's agent", "chat", "get_agent", `{"agent":"turn-001"}`)
	x.say("the orchestrator looks at an agent", "orchestrator", "get_agent", `{"agent":" T05-work ","last":1}`)
	x.say("the orchestrator asks for an agent that is not there", "orchestrator", "get_agent", `{"agent":"T05"}`)
	x.golden("get_agent")

	l := x.state()
	if ops := l.Turns[1].Ops; len(ops) != 2 || ops[0].Agent != "T05-work" || ops[1].Error == "" {
		t.Fatalf("turn 2 ops: %+v", ops)
	}
}

func TestToolTextsGetRun(t *testing.T) {
	x := toolUpdateRun(t)
	x.fake.set(func(f *svcFake) { f.git = gitFacts{Head: "cac8e1710d84aaaabbbbccccddddeeeeffff0000", Commits: 3} })
	x.r.mu.Lock()
	x.r.meta.Settings.MaxCost = 20
	x.r.mu.Unlock()
	x.tick(87 * time.Second)
	x.say("a chat reads the run", "chat", "get_run", `{}`)
	x.taskDone("T02")
	x.taskFail("T05", "agent T05-work failed: the process ended in the turn")
	x.say("the orchestrator reads the run: what is new since it last looked", "orchestrator", "get_run", `{}`)
	x.ok("orchestrator", "retry_task", `{"id":"T03","reason":"the fixture files are in testdata/ now"}`)
	x.ok("chat", "add_task", toolAdd("Check the importer by hand", "verify", false, "T02"))
	x.ok("chat", "tell_orchestrator", `{"text":"Keep the old command-line flags."}`)
	x.chat("cancel_task", `{"id":"T01","reason":"not needed"}`)
	x.ok("orchestrator", "add_task", toolAdd("Write the changelog", "docs", false))
	x.say("the orchestrator reads it again: a chat's changes are new", "orchestrator", "get_run", `{}`)
	x.say("and again: nothing is new", "orchestrator", "get_run", `{}`)
	x.say("a chat reads it now", "chat", "get_run", `{}`)
	x.say("the offset is no number", "chat", "get_run", `{"offset":-1}`)
	x.say("the offset is past the end", "chat", "get_run", `{"offset":99999}`)
	x.turnEnd("Retried T03 and added the changelog task.", 0.4)
	x.chatIdle(toolChat)
	x.tick(10 * time.Second)

	// The same text is the snapshot the engine puts into the next orchestrator's prompt.
	n := x.turnStart("events")
	x.r.mu.Lock()
	snap, meta := x.r.L.snapshot(), x.r.meta
	x.r.mu.Unlock()
	x.note("the snapshot for the prompt of turn 3", snapshotText(meta, snap, gitFacts{Head: "cac8e1710d84aaaabbbbccccddddeeeeffff0000", Commits: 3}))
	if got, _ := x.orch("get_run", `{}`); got != snapshotText(meta, snap, gitFacts{Head: "cac8e1710d84aaaabbbbccccddddeeeeffff0000", Commits: 3}) {
		t.Fatalf("get_run of turn %d with an empty inbox is not the snapshot:\n%s", n, got)
	}

	// The first line for every way a run can stand, and the runs that have no git and no cost.
	for _, c := range []struct {
		title  string
		change func(l *Loaded, m *model.RunMeta)
	}{
		{"stopping", func(l *Loaded, m *model.RunMeta) { l.State.Status = model.RunStopping }},
		{"stopped, with the reason", func(l *Loaded, m *model.RunMeta) {
			l.State.Status, l.State.Reason = model.RunStopped, "stopped by the user"
		}},
		{"stalled on idle turns", func(l *Loaded, m *model.RunMeta) {
			l.State.Status, l.State.IdleStreak = model.RunStalled, 3
			l.State.Reason = "the orchestrator was started 3 times in a row with nothing running and neither added work nor finished the run"
		}},
		{"stopped by an error", func(l *Loaded, m *model.RunMeta) {
			l.State.Status, l.State.Reason = model.RunError, "orchestrator turn 3: agent turn-003 failed: the process ended in the turn."
		}},
		{"completed", func(l *Loaded, m *model.RunMeta) {
			l.State.Status, l.State.Git.ResultHead = model.RunCompleted, "0123456789abcdef0123456789abcdef01234567"
		}},
		{"gave up", func(l *Loaded, m *model.RunMeta) { l.State.Status = model.RunGaveUp }},
		{"an agent kind that reports no cost, no cost limit, no git", func(l *Loaded, m *model.RunMeta) {
			m.Agent, m.Settings.MaxCost, l.State.Git = model.Cursor, 0, nil
		}},
		{"an agent kind that reports no cost, a cost limit set", func(l *Loaded, m *model.RunMeta) { m.Agent = model.Cursor }},
		{"an agent that reported no cost", func(l *Loaded, m *model.RunMeta) { l.Agents[0].Cost = nil }},
		{"the orchestrator waits for all of two tasks", func(l *Loaded, m *model.RunMeta) {
			l.State.Wait = &model.RunWait{Tasks: []string{"T03", "T05"}, Mode: "all", Turn: 2}
		}},
		{"the orchestrator waits for any of two tasks", func(l *Loaded, m *model.RunMeta) {
			l.State.Wait = &model.RunWait{Tasks: []string{"T03", "T05"}, Mode: "any", Turn: 2}
		}},
	} {
		l, m := snap.snapshot(), meta
		l.State.Git = clonePtr(l.State.Git)
		c.change(l, &m)
		g := gitFacts{}
		if c.title == "stopping" {
			g = gitFacts{Head: "cac8e1710d84aaaabbbbccccddddeeeeffff0000", Commits: 3}
		}
		head := strings.SplitN(toolRunText(m, l, g, toolRunOpts{}), "\n\n", 2)[0]
		x.note("the head: "+c.title, head)
	}
	nogit := snap.snapshot()
	nogit.State.Git = nil
	x.note("the whole text in a run without git", toolRunText(meta, nogit, gitFacts{}, toolRunOpts{}))
	x.note("a run with nothing in it", snapshotText(model.RunMeta{Name: "New run", Agent: model.Claude, Settings: model.DefaultRunSettings()},
		&Loaded{State: State{Status: model.RunRunning}}, gitFacts{}))
	x.golden("get_run")

	// The orchestrator's get_run took the inbox into its turn's Learned, in the entry it answered
	// from: once with events (a `learned` entry), without them an `op` entry. A chat's never did.
	l := x.state()
	t2 := l.Turns[1]
	if len(t2.WokenBy) != 2 || len(t2.Learned) != 4 || t2.Learned[0].Type != "task_done" || t2.Learned[1].Type != "task_failed" ||
		t2.Learned[2].Type != "chat_op" || t2.Learned[3].Type != "chat_op" {
		t.Fatalf("turn 2: woken by %+v, learned %+v", t2.WokenBy, t2.Learned)
	}
	var kinds []string
	for _, e := range readEntries(t, x.r.dir) {
		if e.Op == "get_run" {
			kinds = append(kinds, fmt.Sprintf("%s/%d", e.Kind, e.Turn))
		}
	}
	if fmt.Sprint(kinds) != "[learned/2 learned/2 op/2 op/3]" {
		t.Fatalf("get_run entries: %v", kinds)
	}
	if len(l.Turns[2].WokenBy) != 0 || len(l.State.Inbox) != 0 {
		t.Fatalf("turn 3 was woken by %+v; inbox %+v", l.Turns[2].WokenBy, l.State.Inbox)
	}
}
