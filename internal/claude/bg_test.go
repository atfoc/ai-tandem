package claude

import (
	"bufio"
	"os"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
)

// playFixture runs a recorded stream (testdata/bg) through a Translator and returns every event, in order.
func playFixture(t *testing.T, name string) []agent.Event {
	t.Helper()
	f, err := os.Open("testdata/bg/" + name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	tr := NewTranslator()
	var evs []agent.Event
	for sc.Scan() {
		evs = append(evs, tr.Line(sc.Bytes())...)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return evs
}

func ofKind(evs []agent.Event, k agent.EventKind) []agent.Event {
	var out []agent.Event
	for _, ev := range evs {
		if ev.Kind == k {
			out = append(out, ev)
		}
	}
	return out
}

// A shell and a Monitor in the background (goal 2.1): the state the process reports goes through
// every step of the stream, and each turn's end carries the state at its end.
func TestBackgroundStateOfShellAndMonitor(t *testing.T) {
	evs := playFixture(t, "shell_and_monitor.jsonl")

	var states []agent.Background
	for _, ev := range ofKind(evs, agent.EvBackground) {
		states = append(states, ev.Background)
	}
	wantStates := []agent.Background{{Running: 1}, {Running: 2}, {Running: 2, Unread: true}, {Running: 1, Unread: true},
		{Running: 1}, {Running: 1, Unread: true}, {Running: 0, Unread: true}, {}}
	if !reflect.DeepEqual(states, wantStates) {
		t.Errorf("EvBackground states %+v, want %+v", states, wantStates)
	}

	ends := ofKind(evs, agent.EvTurnEnd)
	wantBg := []agent.Background{{Running: 2}, {Running: 1}, {Running: 1}, {Running: 1}, {}}
	wantSelf := []bool{false, true, true, true, true}
	wantFinal := []string{"waiting", "The shell printed shell-done.", "tick 1", "tick 2",
		"All done: the shell printed shell-done and the monitor ticked twice."}
	if len(ends) != 5 {
		t.Fatalf("%d turn ends, want 5: %s", len(ends), dump(ends))
	}
	for i, e := range ends {
		if e.Background != wantBg[i] || e.SelfBegun != wantSelf[i] || e.Final != wantFinal[i] {
			t.Errorf("turn end %d: background %+v, self-begun %v, final %q; want %+v, %v, %q",
				i, e.Background, e.SelfBegun, e.Final, wantBg[i], wantSelf[i], wantFinal[i])
		}
	}
	if subs := ofKind(evs, agent.EvSub); len(subs) != 0 {
		t.Errorf("local_bash tasks gave subagent events: %s", dump(subs))
	}
}

// A change of the state comes before the usage and the end of the turn that the same line gives,
// and the usage still comes right before the end.
func TestBackgroundEventComesBeforeTheTurnEnd(t *testing.T) {
	p := &proc{}
	translateLine(t, p, `{"type":"system","subtype":"task_started","task_id":"b","tool_use_id":"t","task_type":"local_bash"}`)
	translateLine(t, p, `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b","task_type":"local_bash"}]}`)
	// The state is already reported; make the result line itself change it, as a fresh process would.
	p.bgSent = agent.Background{}
	evs := translateLine(t, p, `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"x"}`)
	if len(evs) != 3 || evs[0].Kind != agent.EvBackground || evs[1].Kind != agent.EvUsage || evs[2].Kind != agent.EvTurnEnd {
		t.Fatalf("events %s, want EvBackground, EvUsage, EvTurnEnd", dump(evs))
	}
	if evs[2].Background != (agent.Background{Running: 1}) {
		t.Errorf("turn end background %+v, want 1 running", evs[2].Background)
	}
}

// The notice of a background command is no lost task (goal 3.5): it counts for no empty result.
func TestBackgroundNoticesAreNoOrphans(t *testing.T) {
	p := &proc{}
	translateLine(t, p, `{"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"toolu_b1","task_type":"local_bash"}`)
	translateLine(t, p, `{"type":"system","subtype":"task_notification","task_id":"b1","status":"completed","summary":"x"}`)
	if p.orphans != 0 {
		t.Errorf("orphans = %d after a background command's notice, want 0", p.orphans)
	}
	if !p.bgUnread {
		t.Error("the notice of a background command did not mark an unread notice")
	}
	translateLine(t, p, `{"type":"system","subtype":"task_notification","task_id":"lost-1","status":"completed","summary":"x"}`)
	if p.orphans != 1 {
		t.Errorf("orphans = %d after a lost task's notice, want 1", p.orphans)
	}
}

// A resumed session's lost tasks give empty results that are skipped; a background command's notice
// does not, and a result with an error is a turn's own even when no turn made a request.
func TestResumeNoticesSkipOnlyEmptyResults(t *testing.T) {
	evs := playFixture(t, "resume_notices.jsonl")
	ends := ofKind(evs, agent.EvTurnEnd)
	if len(ends) != 2 {
		t.Fatalf("%d turn ends, want 2: %s", len(ends), dump(ends))
	}
	if ends[0].Final != "started b9" || ends[0].Background != (agent.Background{Running: 1}) {
		t.Errorf("first turn end %s, want the message's turn with b9 running", dump(ends[:1]))
	}
	if ends[1].Error != "API Error: 529 overloaded" || !ends[1].SelfBegun {
		t.Errorf("second turn end %s, want the failed self-begun turn", dump(ends[1:]))
	}

	p := &proc{}
	for _, l := range []string{
		`{"type":"system","subtype":"task_started","task_id":"b9","tool_use_id":"t","task_type":"local_bash"}`,
		`{"type":"system","subtype":"task_notification","task_id":"b9","status":"completed","summary":"x"}`,
	} {
		translateLine(t, p, l)
	}
	if p.orphans != 0 {
		t.Errorf("orphans = %d after the b9 notice, want 0", p.orphans)
	}
}

func TestAmbientAndAgentTasksAreNotBackgroundWork(t *testing.T) {
	p := &proc{}
	evs := translateLine(t, p, `{"type":"system","subtype":"background_tasks_changed","tasks":[`+
		`{"task_id":"amb","task_type":"local_bash","ambient":true},{"task_id":"sub","task_type":"local_agent"}]}`)
	if len(evs) != 0 {
		t.Errorf("tasks that are no background work gave %s", dump(evs))
	}
	if got := p.bgState(); got != (agent.Background{}) {
		t.Errorf("state %+v, want none running", got)
	}
	evs = translateLine(t, p, `{"type":"system","subtype":"task_started","task_id":"sub","tool_use_id":"toolu_A","description":"d","task_type":"local_agent","subagent_type":"general-purpose"}`)
	if len(evs) != 1 || evs[0].Kind != agent.EvSub || evs[0].Sub != "toolu_A" {
		t.Errorf("a local_agent task_started gave %s, want its EvSub", dump(evs))
	}
	// An ambient task's notice is no notice to read.
	translateLine(t, p, `{"type":"system","subtype":"task_notification","task_id":"amb","status":"completed","ambient":true}`)
	if p.bgUnread || p.orphans != 0 {
		t.Errorf("an ambient notice left unread = %v, orphans = %d", p.bgUnread, p.orphans)
	}
}

func TestNoBackgroundEventWithoutChange(t *testing.T) {
	p := &proc{}
	const line = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b","task_type":"local_bash"}]}`
	if evs := translateLine(t, p, line); len(evs) != 1 || evs[0].Kind != agent.EvBackground || evs[0].Background.Running != 1 {
		t.Fatalf("first line gave %s, want one EvBackground with 1 running", dump(evs))
	}
	if evs := translateLine(t, p, line); len(evs) != 0 {
		t.Errorf("the same level again gave %s", dump(evs))
	}
}

// A subagent's own status line is no request of the parent's: it does not read the notices.
func TestSubagentStatusDoesNotReadNotices(t *testing.T) {
	p := &proc{bgUnread: true}
	translateLine(t, p, `{"type":"system","subtype":"status","status":"requesting","parent_tool_use_id":"toolu_A"}`)
	if !p.bgUnread {
		t.Error("a subagent's status line cleared the unread notices")
	}
	translateLine(t, p, `{"type":"system","subtype":"status","status":"requesting"}`)
	if p.bgUnread {
		t.Error("the parent's status line left the notices unread")
	}
}
