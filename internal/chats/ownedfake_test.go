package chats

// A run's agents on the shared scripted spawner (agenttest.Fake): what each kind of chat's process
// starts with, and how a session that does not exist shows for each kind of agent.

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/model"
)

func namesOf(ts []boardtools.Tool) []string {
	out := make([]string, len(ts))
	for i, t := range ts {
		out[i] = t.Name
	}
	return out
}

// spawnsOf are the options of the processes started for the chat object chatID, in order.
func spawnsOf(f *agenttest.Fake, chatID string) []agent.SpawnOptions {
	var out []agent.SpawnOptions
	for _, o := range f.Spawns() {
		if o.ChatID == chatID {
			out = append(out, o)
		}
	}
	return out
}

// The options table: what the manager sets per kind of chat, whole structs compared.
func TestSpawnOptionsPerKindOfChat(t *testing.T) {
	t.Parallel()
	e, _, f := ownFakeEnv(t, model.Claude)
	// A run's agent can start a subagent only inside a turn of its own: the turn that is sent
	// "spawn" starts one, as an agent's spawn_subagent call does.
	spawned := make(chan model.Subagent, 1)
	f.Script(func(tn *agenttest.Turn) {
		if tn.Text == "spawn" {
			sa, err := e.m.SpawnSubagent(tn.Opts.ChatID, SpawnSubRequest{Prompt: "child work"})
			if err != nil {
				t.Errorf("SpawnSubagent in the turn of %s: %v", tn.Opts.ChatID, err)
			}
			spawned <- sa
		}
		tn.Say("ok")
	})
	const url = "http://localhost:6006/mcp"
	spawnFamily := []string{"spawn_subagent", "stop_subagent", "list_subagent_models"}
	if got := namesOf(boardtools.SpawnFamily); !reflect.DeepEqual(got, spawnFamily) {
		t.Fatalf("the spawn family: %v", got)
	}
	orchTools, chatTools := namesOf(boardtools.OrchestratorTools()), namesOf(boardtools.RunChatTools())
	if len(orchTools) != 12 || len(chatTools) != 9 {
		t.Fatalf("%d orchestrator tools, %d run chat tools", len(orchTools), len(chatTools))
	}
	same := func(what string, got, want agent.SpawnOptions) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s:\n got %+v\nwant %+v", what, got, want)
		}
	}
	// childOf spawns an app subagent on the chat and returns what its process started with, once
	// its result has been delivered and the chat rests again.
	childOf := func(id string, runAgent bool) agent.SpawnOptions {
		t.Helper()
		var sa model.Subagent
		if runAgent {
			// Outside a turn it is refused, and nothing is started.
			if _, err := e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "child work"}); !errors.Is(err, ErrTurnOver) {
				t.Fatalf("SpawnSubagent for %s with no turn running: %v", id, err)
			}
			if err := e.m.SendOwned(id, "spawn", OwnedSend{}); err != nil {
				t.Fatal(err)
			}
			sa = <-spawned
		} else {
			sa = e.spawn(id, SpawnSubRequest{Prompt: "child work"})
		}
		waitFor(t, "the subagent's result to be delivered", func() bool { return e.m.Idle(id) && e.view(id).SubsOwed == 0 })
		sp := spawnsOf(f, id+"/subagents/"+sa.ID)
		if len(sp) != 1 {
			t.Fatalf("%d processes for the subagent of %s", len(sp), id)
		}
		return sp[0]
	}

	// The run's agents.
	for _, role := range []model.AgentRole{model.RoleOrchestrator, model.RoleTask, model.RoleMerge} {
		id := e.agentChat("agent-"+string(role), role, model.Claude)
		m := e.runMeta(id, true)
		e.settle(id, "one", OwnedSend{})
		e.m.StopOwned(id, 0)
		e.settle(id, "two", OwnedSend{})
		sp := spawnsOf(f, id)
		if len(sp) != 2 {
			t.Fatalf("%s: %d processes", role, len(sp))
		}
		want := agent.SpawnOptions{ChatID: id, SessionID: m.SessionID, Cwd: e.cwd, Model: "sonnet",
			MCP: &agent.BoardAccess{MCPURL: url, Token: m.Token}, Dir: e.st.P.RunChatDir(ownRun, true, id),
			Unattended: true, MCPTools: spawnFamily}
		if role == model.RoleOrchestrator {
			want.ReadOnly, want.MCPTools = true, orchTools
		}
		same(string(role)+", first start", sp[0], want)
		want.Resume, want.NeedHistory = true, true
		same(string(role)+", resume", sp[1], want)

		if role == model.RoleOrchestrator {
			continue // it has no spawn tools
		}
		got := childOf(id, true)
		same("a subagent of the "+string(role)+" agent", got, agent.SpawnOptions{ChatID: got.ChatID, SessionID: got.SessionID,
			Cwd: e.cwd, Model: "sonnet", MCP: &agent.BoardAccess{MCPURL: url, Token: got.MCP.Token}, Subagent: true,
			Dir:        e.st.P.RunChatDir(ownRun, true, id) + "/subagents/" + strings.TrimPrefix(got.ChatID, id+"/subagents/"),
			Unattended: true, MCPTools: []string{}})
		if got.MCPTools == nil || got.MCP.Token == m.Token {
			t.Errorf("a run agent's subagent: tools %v, its parent's token %v", got.MCPTools, got.MCP.Token == m.Token)
		}
	}

	// A person's chat on the run, and a chat outside any run.
	for _, onRun := range []bool{true, false} {
		var v model.ChatView
		what := "a chat outside a run"
		dir := ""
		if onRun {
			v, what = e.onRun(model.Claude), "a person's chat on a run"
			dir = e.st.P.RunChatDir(ownRun, false, v.ID)
		} else {
			v = e.create(model.Claude, gOne, "")
			dir = e.st.P.ChatDir(v.ID)
		}
		turns := func(n int) {
			t.Helper()
			waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == n })
		}
		e.send(v.ID, "one", "")
		turns(1)
		e.m.Stop(v.ID)
		e.send(v.ID, "two", "")
		turns(2)
		var m model.ChatMeta
		if onRun {
			m = e.runMeta(v.ID, false)
		} else {
			m = e.meta(v.ID)
		}
		sp := spawnsOf(f, v.ID)
		if len(sp) != 2 {
			t.Fatalf("%s: %d processes", what, len(sp))
		}
		want := agent.SpawnOptions{ChatID: v.ID, SessionID: m.SessionID, Cwd: v.Cwd, Model: v.Model, Effort: v.Effort,
			MCP: &agent.BoardAccess{MCPURL: url, Token: m.Token}, Dir: dir}
		wantSub := []string(nil)
		if onRun {
			want.MCPTools = append(append([]string{}, chatTools...), spawnFamily...)
			wantSub = []string{}
		}
		same(what+", first start", sp[0], want)
		want.Resume = true // never NeedHistory: a person sees what a resume makes of the session
		same(what+", resume", sp[1], want)
		got := childOf(v.ID, false)
		same("a subagent of "+what, got, agent.SpawnOptions{ChatID: got.ChatID, SessionID: got.SessionID, Cwd: v.Cwd,
			Model: v.Model, Effort: v.Effort, MCP: &agent.BoardAccess{MCPURL: url, Token: got.MCP.Token}, Subagent: true,
			Dir: dir + "/subagents/" + strings.TrimPrefix(got.ChatID, v.ID+"/subagents/"), MCPTools: wantSub})
	}
}

// A session that does not exist, for each kind of agent, and the fresh start that follows it.
func TestNoSessionPerKind(t *testing.T) {
	t.Parallel()
	for _, kind := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		t.Run(string(kind), func(t *testing.T) {
			e, _, f := ownFakeEnv(t, kind)
			f.Script(func(tn *agenttest.Turn) { tn.Say("did " + tn.Text) })
			id := e.agentChat("agent-1", model.RoleTask, kind)
			if s := e.settle(id, "one", OwnedSend{}); s.Outcome != EndClean || s.Text != "did one" {
				t.Fatalf("%+v", s)
			}
			e.m.StopOwned(id, 0)
			waitFor(t, "the process to end", func() bool { return f.Live() == 0 })
			sid := e.runMeta(id, true).SessionID
			if sid == "" {
				t.Fatal("the chat has no session id")
			}
			f.NoSession(sid) // the provider lost it

			err := e.m.SendOwned(id, "two", OwnedSend{})
			sp := spawnsOf(f, id)
			if last := sp[len(sp)-1]; !last.Resume || !last.NeedHistory || last.SessionID != sid {
				t.Fatalf("the resume: %+v", last)
			}
			if kind == model.Claude {
				// The message is taken; the process says so itself, with a turn end, and exits.
				if err != nil {
					t.Fatalf("SendOwned: %v", err)
				}
				s := e.settled(id)
				if !s.NoSession || s.Outcome != EndError || !strings.Contains(s.Error, "No conversation found") || s.Text != "" {
					t.Fatalf("%+v", s)
				}
			} else if !errors.Is(err, agent.ErrNoSession) {
				t.Fatalf("SendOwned: %v", err)
			}
			// Either way the chat is free and the process is gone: Cursor's stays alive after the
			// refusal, and is closed by the manager.
			waitFor(t, "the process to end", func() bool { return f.Live() == 0 })
			if e.m.Busy(id) || e.m.TurnRunning(id) {
				t.Fatal("the chat is busy after \"no session\"")
			}
			// The manager learns of the exit from the process's events, a moment after the
			// process has ended.
			waitFor(t, "the manager to see the exit", func() bool { st, _ := e.m.OwnedState(id); return !st.HasProcess })
			if st, _ := e.m.OwnedState(id); st.HasProcess {
				t.Fatalf("a process is left: %+v", st)
			}

			// The engine starts again, with a new session.
			if s := e.settle(id, "from the start", OwnedSend{Fresh: true}); s.Outcome != EndClean || s.Text != "did from the start" || s.NoSession {
				t.Fatalf("after the fresh start: %+v", s)
			}
			sp = spawnsOf(f, id)
			last := sp[len(sp)-1]
			if last.Resume || last.NeedHistory || last.SessionID == sid {
				t.Fatalf("the fresh start: %+v", last)
			}
			if now := e.runMeta(id, true).SessionID; now == "" || now == sid {
				t.Fatalf("the session after a fresh start: %q, was %q", now, sid)
			}
			// And the session it made can be resumed.
			e.m.StopOwned(id, 0)
			if s := e.settle(id, "three", OwnedSend{}); s.Outcome != EndClean || s.Text != "did three" {
				t.Fatalf("%+v", s)
			}
		})
	}
}
