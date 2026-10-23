package boardapi

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

// The chat's agent calls resume_subagent for a subagent it started that does not run, and gets
// the receipt; the subagent's process is started again on its session with the carry-on message.
// The subagent is paused (its turns fail with a temporary error until its retries are used up) or
// stopped: a resume takes either.
func TestResumeSubagentTool(t *testing.T) {
	for _, paused := range []bool{true, false} {
		name := "stopped"
		if paused {
			name = "paused"
		}
		t.Run(name, func(t *testing.T) { resumeSubagentTool(t, paused) })
	}
}

func resumeSubagentTool(t *testing.T, paused bool) {
	e := newEnv(t)
	f := agenttest.New(model.Claude)
	f.MCP = http.HandlerFunc(e.relay.ServeFixedMCP)
	e.relay.Chats.Spawners[model.Claude] = f
	v, err := e.relay.Chats.Create(model.Claude, model.Ungrouped, "")
	if err != nil {
		t.Fatal(err)
	}
	e.limits(1, 100, v.ID)
	e.withRetries()
	m := e.relay.Chats
	t.Cleanup(func() { m.Stop(v.ID) })

	var mu sync.Mutex
	seen := map[string]string{}
	note := func(k, v string) { mu.Lock(); seen[k] = v; mu.Unlock() }
	f.Script(func(tn *agenttest.Turn) {
		switch {
		case tn.Text == "start":
			text, _ := tn.Call("spawn_subagent", map[string]any{"prompt": "work"})
			note("spawn", text)
		case tn.Opts.Subagent && strings.Contains(tn.Text, "<carry-on>") && !strings.Contains(tn.Text, "Your last turn ended"): // a retry says that; a resume does not
			note("carry-on", tn.Text)
			tn.Say("work done")
		case tn.Opts.Subagent && paused:
			tn.FailTemp(agent.TempLogin, "Please run /login · API Error: 401 authentication_failed")
		case tn.Opts.Subagent:
			tn.Hang()
		case strings.HasSuffix(tn.Text, "carry on"): // after the list of the paused subagents, when there is one
			mu.Lock()
			sid := strings.Fields(seen["spawn"])[2]
			mu.Unlock()
			text, isErr := tn.Call("resume_subagent", map[string]any{"sid": sid})
			note("resume", text)
			note("resume error", fmt.Sprint(isErr))
		}
	})
	if err := m.Send(v.ID, "start", "", nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the subagent's process", func() bool { return len(f.Spawns()) >= 2 })
	waitFor(t, "the chat's agent to end its turn", func() bool { return !m.Busy(v.ID) })
	mu.Lock()
	sid := strings.Fields(seen["spawn"])[2]
	mu.Unlock()
	var before int // the processes there are once the subagent does not run
	if paused {
		// The first turn and the four attempts fail: five processes, then the pause.
		waitFor(t, "the subagent to be paused", func() bool {
			_, _, subs, err := m.Items(v.ID)
			return err == nil && len(subs) == 1 && subs[0].Status == model.SubPaused
		})
		before = 6
	} else {
		if err := m.StopSubagent(v.ID, sid); err != nil {
			t.Fatal(err)
		}
		before = 2
	}
	if n := len(f.Spawns()); n != before {
		t.Fatalf("%d processes started before the resume, want %d", n, before)
	}
	if err := m.Send(v.ID, "carry on", "", nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the subagent's result", func() bool {
		_, _, subs, err := m.Items(v.ID)
		return err == nil && len(subs) == 1 && subs[0].Status == model.SubCompleted
	})
	mu.Lock()
	defer mu.Unlock()
	if want := fmt.Sprintf("resumed subagent %s (running)", sid); seen["resume"] != want || seen["resume error"] != "false" {
		t.Fatalf("resume answered %q (error %s), want %q", seen["resume"], seen["resume error"], want)
	}
	if !strings.Contains(seen["carry-on"], "<carry-on>") {
		t.Fatalf("the resumed subagent's message:\n%s", seen["carry-on"])
	}
	if n := len(f.Spawns()); n != before+1 {
		t.Fatalf("%d processes started, want the %d before and the resume's", n, before)
	}
}

// A sid that cannot be resumed, one that is not there and none at all give error results with
// the manager's sentences.
func TestResumeSubagentToolRefusals(t *testing.T) {
	e := newEnv(t)
	text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"work"}`)
	if isErr {
		t.Fatalf("spawn %q", text)
	}
	waitFor(t, "the subagent's process", func() bool { return e.claude.count() == 1 })
	sid := e.subs(e.chat)[0].ID
	for _, tc := range []struct{ args, want string }{
		{fmt.Sprintf(`{"sid":%q}`, sid), fmt.Sprintf("subagent %s is running: only a paused or stopped subagent can be resumed", sid)},
		{`{"sid":"no-such-subagent"}`, "no such subagent"},
		{`{}`, "sid is required"},
		{`{"sid":5}`, "invalid resume_subagent arguments"},
	} {
		got, isErr, status := e.toolsCall(e.token, "resume_subagent", tc.args)
		if status != 200 || !isErr || got != tc.want {
			t.Fatalf("resume_subagent %s: %q isErr=%v status=%d, want %q", tc.args, got, isErr, status, tc.want)
		}
	}
	if n := e.claude.count(); n != 1 {
		t.Fatalf("%d processes started, want the subagent's alone", n)
	}
}

// A chat whose subagents are off is refused resume_subagent as it is spawn_subagent.
func TestResumeSubagentNeedsTheFamily(t *testing.T) {
	e := newEnv(t)
	e.limits(0, 100, e.chat)
	text, isErr, status := e.toolsCall(e.token, "resume_subagent", `{"sid":"x"}`)
	if status != 200 || !isErr || text != "resume_subagent is not available: subagents are off in this chat" {
		t.Fatalf("resume_subagent with subagents off: %q isErr=%v status=%d", text, isErr, status)
	}
}
