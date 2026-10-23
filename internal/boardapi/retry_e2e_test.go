package boardapi

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// retryFirst is the first pause of the retry schedule these tests run with. The schedule keeps
// its ratios (1, 3, 9, 24), so the longest pause is 24 ms, 30 ms with the jitter.
const retryFirst = time.Millisecond

// withRetries replaces the relay's manager by one whose retries wait retryFirst, as limits does
// for the subagent settings: the chats are read from the store again.
func (e *env) withRetries() {
	e.t.Helper()
	m := e.relay.Chats
	nm := chats.New(chats.Deps{Store: m.Store, Bridge: e.relay.Bridge, Boards: e.relay.Boards, DefaultCwd: m.DefaultCwd, MCPURL: m.MCPURL, Spawners: m.Spawners, RetryFirst: retryFirst})
	if err := nm.Load(); err != nil {
		e.t.Fatal(err)
	}
	e.relay.Chats = nm
}

// A lead L, started by the chat's agent, starts a chunk K and then its turns fail with a login
// error until its retries are used up and it is paused. K finishes meanwhile and owes its result
// to L. Nothing resumes L but the chat's agent: the person's next message carries the list of the
// paused subagents, the agent calls resume_subagent, and L starts again on its session with
// "carry on" and K's result (scenarios 2 and 3; goal 5.3, the app does not resume because a
// message arrived).
func TestContinueResumesPausedLead(t *testing.T) {
	e := newEnv(t)
	f := agenttest.New(model.Claude)
	f.MCP = http.HandlerFunc(e.relay.ServeFixedMCP)
	e.relay.Chats.Spawners[model.Claude] = f
	v, err := e.relay.Chats.Create(model.Claude, model.Ungrouped, "")
	if err != nil {
		t.Fatal(err)
	}
	e.limits(2, 100, v.ID)
	e.withRetries()
	m := e.relay.Chats
	t.Cleanup(func() { m.Stop(v.ID) })

	const login = "Please run /login · API Error: 401 authentication_failed"
	var mu sync.Mutex
	seen := map[string]string{} // what the script noted, by name
	note := func(k, v string) { mu.Lock(); seen[k] = v; mu.Unlock() }
	var leadTurns []agent.SpawnOptions // the options of the process of each turn of L, in order
	leadPaused := make(chan struct{})  // closed by the test once L's record is paused
	f.Script(func(tn *agenttest.Turn) {
		switch {
		case !tn.Opts.Subagent && strings.Contains(tn.Text, "<subagent-results>"):
			note("results", tn.Text)
			tn.Say("all done")
		case !tn.Opts.Subagent && tn.Text == "start":
			text, _ := tn.Call("spawn_subagent", map[string]any{"prompt": "lead", "description": "Lead"})
			note("spawn", text)
		case !tn.Opts.Subagent && strings.HasSuffix(tn.Text, "continue"): // the list of paused subagents comes first
			note("continue", tn.Text)
			mu.Lock()
			sid := strings.Fields(seen["spawn"])[2]
			mu.Unlock()
			if strings.Contains(tn.Text, "<subagents-paused-or-stopped>") && strings.Contains(tn.Text, sid) {
				text, isErr := tn.Call("resume_subagent", map[string]any{"sid": sid})
				note("resume", text)
				note("resume error", fmt.Sprint(isErr))
			}
		case tn.Opts.Subagent && tn.Text == "chunk":
			select {
			case <-leadPaused:
			case <-tn.Interrupted():
				return
			}
			tn.Say("chunk done")
		case tn.Opts.Subagent && tn.Text == "lead":
			mu.Lock()
			leadTurns = append(leadTurns, tn.Opts)
			mu.Unlock()
			tn.Call("spawn_subagent", map[string]any{"prompt": "chunk", "description": "Chunk"})
			tn.FailTemp(agent.TempLogin, login)
		case tn.Opts.Subagent && tn.Opts.Resume:
			mu.Lock()
			leadTurns = append(leadTurns, tn.Opts)
			n := len(leadTurns)
			mu.Unlock()
			if n < 6 {
				tn.FailTemp(agent.TempLogin, login)
				return
			}
			note("lead turn", tn.Text)
			tn.Say("lead done")
		}
	})
	if err := m.Send(v.ID, "start", "", nil); err != nil {
		t.Fatal(err)
	}
	var lead, chunk model.Subagent
	find := func() {
		for _, sa := range e.subs(v.ID) {
			if sa.Parent == "" {
				lead = sa
			} else {
				chunk = sa
			}
		}
	}
	waitFor(t, "the lead to be paused", func() bool {
		find()
		return lead.Status == model.SubPaused
	})
	if lead.Cause != model.CauseRetriesFailed || lead.ErrorKind != string(agent.TempLogin) || lead.Error != login || lead.Session == "" {
		t.Fatalf("the paused lead: %+v", lead)
	}
	close(leadPaused)
	waitFor(t, "the chunk's result to be owed to the lead", func() bool {
		find()
		return chunk.Status == model.SubCompleted && chunk.Delivery == model.SubOwed && chunk.Parent == lead.ID
	})
	waitFor(t, "the chat's agent to end its turn", func() bool { return !m.Busy(v.ID) })

	// Goal 5.3: ten times the longest pause later, the lead is still paused and has not been
	// started again. A first message of the chat's agent, a spawn of the lead, a spawn of the chunk
	// and five of the lead's turns are the processes there are.
	time.Sleep(10 * 30 * time.Millisecond)
	find()
	if lead.Status != model.SubPaused || len(f.Spawns()) != 7 {
		t.Fatalf("after the wait the lead is %+v, %d processes started, want it paused and 7", lead, len(f.Spawns()))
	}
	mu.Lock()
	if len(leadTurns) != 5 {
		t.Fatalf("the lead had %d turns, want 5", len(leadTurns))
	}
	mu.Unlock()

	if err := m.Send(v.ID, "continue", "", nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the lead to finish", func() bool {
		find()
		return lead.Status == model.SubCompleted
	})
	waitFor(t, "the chat's agent to answer the result", func() bool {
		_, items, _, err := m.Items(v.ID)
		return err == nil && len(items) > 1 && items[len(items)-1].Kind == "end" && items[len(items)-2].Text == "all done"
	})

	mu.Lock()
	defer mu.Unlock()
	if want := fmt.Sprintf("resumed subagent %s (running)", lead.ID); seen["resume"] != want || seen["resume error"] != "false" {
		t.Fatalf("resume_subagent answered %q (error %s), want %q; the agent's message:\n%s", seen["resume"], seen["resume error"], want, seen["continue"])
	}
	got := seen["lead turn"]
	if !strings.Contains(got, "<carry-on>") || !strings.Contains(got, "chunk done") {
		t.Fatalf("the resumed lead's message:\n%s", got)
	}
	if len(leadTurns) != 6 || leadTurns[0].Resume || !leadTurns[5].Resume || leadTurns[0].SessionID == "" ||
		leadTurns[5].SessionID != leadTurns[0].SessionID || lead.Session != leadTurns[0].SessionID {
		t.Fatalf("the lead's turns started with %+v, its session %q", leadTurns, lead.Session)
	}
	if n := len(f.Spawns()); n != 8 {
		t.Fatalf("%d processes started, want 8: the resume is the only start after the pause", n)
	}
	if !strings.Contains(seen["results"], "lead done") {
		t.Fatalf("the chat's agent's results:\n%s", seen["results"])
	}
}
