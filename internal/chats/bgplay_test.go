package chats

import (
	"bufio"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/model"
)

// Recorded streams of the real Claude process, played through the manager (goal 6): the lines of a
// fixture in internal/claude/testdata/bg go through claude.Translator, as the read loop of a real
// process would send them, and the fake agent emits the events.

// playStep is one step of a recorded Claude stream: the agent events of its lines (through
// claude.Translator), then what the agent is expected to be once they are applied.
type playStep struct {
	name, expect string
	evs          []agent.Event
}

// loadPlay reads ../claude/testdata/bg/<fixture> and splits it at its {"type":"aiwb_step"} lines.
// Lines after the last step line would belong to no step and are an error.
func loadPlay(t *testing.T, fixture string) []playStep {
	t.Helper()
	f, err := os.Open(filepath.Join("..", "claude", "testdata", "bg", fixture))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tr := claude.NewTranslator()
	var steps []playStep
	var evs []agent.Event
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		var m struct{ Type, Name, Expect string }
		if err := json.Unmarshal(line, &m); err != nil {
			t.Fatalf("%s: %v in %q", fixture, err, line)
		}
		if m.Type == "aiwb_step" {
			steps = append(steps, playStep{name: m.Name, expect: m.Expect, evs: evs})
			evs = nil
			continue
		}
		evs = append(evs, tr.Line(line)...)
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	if len(evs) > 0 {
		t.Fatalf("%s: events after the last step", fixture)
	}
	return steps
}

// chatPhase is what the chat is, in the words of the fixtures: in a turn is working, waiting is
// waiting, idle is done.
func chatPhase(v model.ChatView) string {
	switch v.Status {
	case model.StatusThinking, model.StatusWriting, model.StatusTool, model.StatusApproval:
		return "working"
	case model.StatusWaiting:
		return "waiting"
	case model.StatusReady:
		return "done"
	}
	return string(v.Status)
}

// subPhase is what the subagent is, in the words of the fixtures.
func subPhase(s model.Subagent) string {
	switch {
	case s.Status != model.SubRunning:
		return "done"
	case s.Waiting:
		return "waiting"
	}
	return "working"
}

// playToChat sends a message to a new Claude chat and plays steps to its process. After each step
// it calls check with the chat's view and the step. It returns the chat's id.
func (e *env) playToChat(steps []playStep, check func(v model.ChatView, st playStep)) string {
	e.t.Helper()
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "start a shell command and a monitor", "")
	e.m.naming.Wait()
	a := e.claude.last(e.t)
	for _, st := range steps {
		a.emit(e.t, st.evs...)
		check(e.view(v.ID), st)
	}
	return v.ID
}

func TestBackgroundSamePhasesForChatAndSubagent(t *testing.T) {
	t.Parallel()
	steps := loadPlay(t, "shell_and_monitor.jsonl")
	e := newEnv(t)
	e.m.bgQuietWait = time.Hour

	// One recording, played to a subagent of one chat and to the own agent of another.
	subChat, _ := e.nested(2)
	sa, pa := e.child(subChat, "", "delegate")
	var subPhases []string
	for _, st := range steps {
		pa.emit(t, st.evs...)
		e.m.handoffs.Wait()
		subPhases = append(subPhases, subPhase(e.sub(subChat, sa.ID)))
	}

	var chatPhases []string
	e.playToChat(steps, func(v model.ChatView, st playStep) { chatPhases = append(chatPhases, chatPhase(v)) })

	var want []string
	for _, st := range steps {
		want = append(want, st.expect)
	}
	if !slices.Equal(subPhases, want) {
		t.Errorf("the subagent's phases\n got %q\nwant %q", subPhases, want)
	}
	if !slices.Equal(chatPhases, want) {
		t.Errorf("the chat's phases\n got %q\nwant %q", chatPhases, want)
	}
	if !slices.Equal(subPhases, chatPhases) {
		t.Errorf("the subagent and the chat differ\n sub  %q\n chat %q", subPhases, chatPhases)
	}
}

func TestSubagentPlaysShellAndMonitor(t *testing.T) {
	t.Parallel()
	steps := loadPlay(t, "shell_and_monitor.jsonl")
	e := newEnv(t)
	e.m.bgQuietWait = time.Hour
	id, parent := e.nested(2)
	sa, pa := e.child(id, "", "delegate")

	pa.emit(t, steps[0].evs...)
	e.m.handoffs.Wait()
	s := e.sub(id, sa.ID)
	if s.Status != model.SubRunning || !s.Waiting || !s.BgWaiting || s.Ended != 0 || s.Delivery != model.SubNotOwed {
		t.Fatalf("after the first turn end, with two running: %+v", s)
	}
	if agentClosed(pa) || len(parent.sent()) != 1 {
		t.Fatalf("closed %v, %d messages to the chat's agent; want it open and nothing handed", agentClosed(pa), len(parent.sent()))
	}

	for _, st := range steps[1:] {
		pa.emit(t, st.evs...)
		e.m.handoffs.Wait()
		if st.expect == "waiting" && agentClosed(pa) {
			t.Fatalf("closed at %q", st.name)
		}
		if st.expect == "waiting" && len(parent.sent()) != 1 {
			t.Fatalf("at %q the chat's agent was handed something", st.name)
		}
	}
	const report = "All done: the shell printed shell-done and the monitor ticked twice."
	s = e.sub(id, sa.ID)
	if s.Status != model.SubCompleted || s.Waiting || s.BgWaiting || s.Last != report {
		t.Fatalf("at the end: %+v", s)
	}
	closed(t, "its process", pa)
	if len(parent.sent()) != 2 || !slices.Equal(deliveredSids(parent.sent()[1]), []string{sa.ID}) {
		t.Fatalf("the chat's agent got %d messages, want the human's and one delivery", len(parent.sent()))
	}
	msg := lastSend(t, parent)
	if !strings.Contains(msg, "<report>"+report+"</report>") || strings.Contains(msg, "<report>waiting</report>") {
		t.Fatalf("the report is not the last turn's text:\n%s", msg)
	}
	want := []string{"waiting", "The shell printed shell-done.", "tick 1", "tick 2", report}
	if got := itemTexts(e.subItems(id, sa.ID)); !slices.Equal(got, want) {
		t.Fatalf("the subagent's texts %q, want %q", got, want)
	}
	// The subagent's usage is the context window its process reports, kept through the self-begun
	// turns as through any turn (the fixture has no streamed context fill).
	if s.Window != 200000 {
		t.Fatalf("the subagent's window %d, want 200000", s.Window)
	}
}

func TestChatPlaysShellAndMonitor(t *testing.T) {
	t.Parallel()
	steps := loadPlay(t, "shell_and_monitor.jsonl")
	e := newEnv(t)
	e.m.bgQuietWait = time.Hour
	var seen []string
	var ends []agent.Event
	for _, st := range steps {
		for _, ev := range st.evs {
			if ev.Kind == agent.EvTurnEnd {
				ends = append(ends, ev)
			}
		}
	}
	id := e.playToChat(steps, func(v model.ChatView, st playStep) {
		seen = append(seen, chatPhase(v))
		switch st.expect {
		case "waiting":
			if v.Status != model.StatusWaiting || !e.m.Busy(v.ID) {
				t.Errorf("after %q: status %q, busy %v; want waiting, busy", st.name, v.Status, e.m.Busy(v.ID))
			}
		case "working":
			if v.Status != model.StatusThinking {
				t.Errorf("after %q: status %q, want thinking", st.name, v.Status)
			}
		case "done":
			if v.Status != model.StatusReady || e.m.Busy(v.ID) {
				t.Errorf("after %q: status %q, want ready", st.name, v.Status)
			}
		}
	})
	if t.Failed() {
		t.Fatalf("phases %q", seen)
	}
	items := e.items(id)
	want := []string{"waiting", "The shell printed shell-done.", "tick 1", "tick 2",
		"All done: the shell printed shell-done and the monitor ticked twice."}
	if got := itemTexts(items); !slices.Equal(got, want) {
		t.Fatalf("texts %q, want %q", got, want)
	}
	if n := countKind(items, "end"); n != 5 {
		t.Fatalf("%d end marks, want 5", n)
	}
	if n := countKind(items, "user"); n != 1 {
		t.Fatalf("%d user items, want the one message", n)
	}
	meta := e.meta(id)
	if meta.Usage.Turns != 5 || meta.TurnActive {
		t.Fatalf("turns %d, TurnActive %v; want 5, false", meta.Usage.Turns, meta.TurnActive)
	}
	// Tokens and cost are counted like any turn's (goal 6.5). The manager keeps the turn count and
	// the context window the process reports at every turn end, the self-begun turns' too (the
	// fixture has no streamed context fill); the cost and the output tokens ride on the turn-end
	// events as the process's running totals, five turns of 0.0012 and 20 output tokens each, and
	// every one reaches the pump.
	if u := meta.Usage; u.CtxWindow != 200000 {
		t.Fatalf("context window %d, want 200000", u.CtxWindow)
	}
	if len(ends) != 5 {
		t.Fatalf("%d turn ends in the stream, want 5", len(ends))
	}
	out := 0
	for i, ev := range ends {
		out += ev.OutTokens
		if want := 20 * (i + 1); ev.CumOutTokens != want {
			t.Errorf("turn end %d: %d output tokens so far, want %d", i+1, ev.CumOutTokens, want)
		}
		if want := 0.0012 * float64(i+1); !ev.HasCost || math.Abs(ev.CostUSD-want) > 1e-9 {
			t.Errorf("turn end %d: cost %v (reported %v), want %v", i+1, ev.CostUSD, ev.HasCost, want)
		}
	}
	if out != 100 {
		t.Errorf("%d output tokens over the five turn ends, want 100", out)
	}
}

func TestChainTwoLevelsWithTheMonitorAtTheBottom(t *testing.T) {
	t.Parallel()
	steps := loadPlay(t, "shell_and_monitor.jsonl")
	e := newEnv(t)
	e.m.bgQuietWait = time.Hour
	id, parent := e.nested(2)
	a, pa := e.child(id, "", "level one")
	emitSpawnItem(t, pa, "tool-b", "mcp__board__spawn_subagent", `{"prompt":"level two"}`)
	b, pb := e.child(id, a.ID, "level two")
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "b is on it"}, subBgEnd(0, false))
	e.m.handoffs.Wait()
	if s := e.sub(id, a.ID); s.Status != model.SubRunning || !s.Waiting || s.BgWaiting {
		t.Fatalf("A after its own turn, waiting on B: %+v", s)
	}

	for _, st := range steps {
		pb.emit(t, st.evs...)
		e.m.handoffs.Wait()
		sb, sa := e.sub(id, b.ID), e.sub(id, a.ID)
		if got := subPhase(sb); got != st.expect {
			t.Fatalf("at %q: B is %s (%+v), want %s", st.name, got, sb, st.expect)
		}
		if st.expect == "done" {
			break
		}
		if sa.Status != model.SubRunning || !sa.Waiting || agentClosed(pa) || len(pa.sent()) != 1 {
			t.Fatalf("at %q: A %+v, closed %v, %d messages; want it waiting and handed nothing", st.name, sa, agentClosed(pa), len(pa.sent()))
		}
	}
	if s := e.sub(id, b.ID); s.Status != model.SubCompleted {
		t.Fatalf("B at the end: %+v", s)
	}
	if len(pa.sent()) != 2 || !slices.Equal(deliveredSids(pa.sent()[1]), []string{b.ID}) {
		t.Fatalf("A got %d messages, want its prompt and B's result", len(pa.sent()))
	}
	if s := e.sub(id, a.ID); s.Status != model.SubRunning || s.Waiting {
		t.Fatalf("A in the turn of the delivery: %+v", s)
	}
	if len(parent.sent()) != 1 {
		t.Fatal("the chat's agent was handed something before A's report")
	}

	pa.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvText, Text: "A's report"}, subBgEnd(0, false))
	e.m.handoffs.Wait()
	if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Last != "A's report" {
		t.Fatalf("A at the end: %+v", s)
	}
	if len(parent.sent()) != 2 || !slices.Equal(deliveredSids(parent.sent()[1]), []string{a.ID}) {
		t.Fatalf("the chat's agent got %d messages, want the human's and A's result", len(parent.sent()))
	}
	if msg := lastSend(t, parent); !strings.Contains(msg, "<report>A's report</report>") {
		t.Fatalf("the chat's agent got:\n%s", msg)
	}
}

func TestResumeNoticesThroughTheManager(t *testing.T) {
	t.Parallel()
	steps := loadPlay(t, "resume_notices.jsonl")
	e := newEnv(t)
	e.m.bgQuietWait = time.Hour
	// Turns after each step: the lost tasks' empty results are no turn, the message's turn is one,
	// and the self-begun turn that fails is the second.
	turns := []int{0, 1, 1, 1, 2}
	i := 0
	id := e.playToChat(steps, func(v model.ChatView, st playStep) {
		if n := e.meta(v.ID).Usage.Turns; n != turns[i] {
			t.Errorf("after %q: %d turns, want %d", st.name, n, turns[i])
		}
		switch i {
		case 1, 2, 3:
			if v.Status != model.StatusWaiting {
				t.Errorf("after %q: status %q, want waiting", st.name, v.Status)
			}
		case 4:
			if v.Status != model.StatusReady {
				t.Errorf("after %q: status %q, want ready", st.name, v.Status)
			}
		}
		i++
	})
	if got := notes(e.items(id), "error"); !slices.Equal(got, []string{"API Error: 529 overloaded"}) {
		t.Fatalf("error notes %q", got)
	}
}
