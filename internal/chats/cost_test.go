package chats

// The cost of a run's chats: the rule, and what the pump feeds it.

import (
	"math"
	"sync/atomic"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

// costProc is the reports of one Claude process: (total, output tokens of the turn, cumulative
// output tokens) per turn end.
type costProc [][3]float64

// costEv is a turn end that reports a cost and no tokens.
func costEv(usd float64, out, cumOut int) agent.Event {
	return agent.Event{Kind: agent.EvTurnEnd, CostUSD: usd, HasCost: true, OutTokens: out, CumOutTokens: cumOut}
}

func costRun(k *model.ChatCost, procs ...costProc) {
	for _, p := range procs {
		for i, r := range p {
			costSample(k, model.Claude, i == 0, costEv(r[0], int(r[1]), int(r[2])))
		}
	}
}

// The rule on the numbers measured with the real CLI (T08, scenario c6): the state a resumed
// Claude process starts from is saved when a process exits in an orderly way, not at a turn end.
func TestCostRule(t *testing.T) {
	t.Parallel()
	// (i) P1: a turn, then SIGKILL. P2: resume. Nothing is restored: the two totals add up.
	var k model.ChatCost
	costRun(&k, costProc{{0.008066, 44, 44}}, costProc{{0.002583, 46, 46}})
	if c := costTotal(&k); !near(c.USD, 0.010649) || !c.Known || c.Partial {
		t.Fatalf("c6 (i): %+v, want 0.010649 (%+v)", c, k)
	}

	// (ii) P1: a turn, then Close. P2: resume, a turn, then SIGKILL. P3: resume: it starts from
	// P1's total again, and what P2 spent is not in its total.
	k = model.ChatCost{}
	costRun(&k, costProc{{0.008073, 45, 45}})
	if c := costTotal(&k); !near(c.USD, 0.008073) {
		t.Fatalf("c6 (ii) after P1: %+v", c)
	}
	costRun(&k, costProc{{0.010650, 44, 89}})
	if c := costTotal(&k); !near(c.USD, 0.010650) { // restored: the sum of the totals would be 0.018723
		t.Fatalf("c6 (ii) after P2: %+v (%+v)", c, k)
	}
	costRun(&k, costProc{{0.010223, 44, 89}})
	if c := costTotal(&k); !near(c.USD, 0.012800) { // the newest total alone would be 0.010223
		t.Fatalf("c6 (ii) after P3: %+v, want 0.012800 (%+v)", c, k)
	}
	if len(k.Marks) != 2 {
		t.Fatalf("marks kept: %+v", k.Marks)
	}

	// A fourth process after P3 exited in an orderly way starts from P3's total: among the two
	// reports with 89 tokens put out, the newer one is the baseline.
	costRun(&k, costProc{{0.010223 + 0.003, 30, 119}})
	if c := costTotal(&k); !near(c.USD, 0.015800) {
		t.Fatalf("a resume after an orderly exit: %+v, want 0.015800 (%+v)", c, k)
	}
	// And one after P3 was killed instead starts from P1's again, which is still known.
	k2 := model.ChatCost{}
	costRun(&k2, costProc{{0.008073, 45, 45}}, costProc{{0.010650, 44, 89}}, costProc{{0.010223, 44, 89}}, costProc{{0.008073 + 0.002, 40, 85}})
	if c := costTotal(&k2); !near(c.USD, 0.014800) {
		t.Fatalf("a resume after a second kill: %+v, want 0.014800 (%+v)", c, k2)
	}

	// Several turns in one process: the newest total counts, once; the marks do not grow.
	k = model.ChatCost{}
	costRun(&k, costProc{{0.01, 10, 10}, {0.03, 20, 30}, {0.06, 30, 60}})
	if c := costTotal(&k); !near(c.USD, 0.06) || len(k.Marks) != 1 || k.Marks[0] != (model.CostMark{Out: 60, USD: 0.06}) {
		t.Fatalf("three turns of one process: %+v (%+v)", c, k)
	}
	// An orderly resume of it: the baseline is that total.
	costRun(&k, costProc{{0.07, 5, 65}, {0.09, 5, 70}})
	if c := costTotal(&k); !near(c.USD, 0.09) || len(k.Marks) != 2 {
		t.Fatalf("an orderly resume: %+v (%+v)", c, k)
	}
	// A total that names an output count no report had: the nearest one below it is the baseline.
	k = model.ChatCost{}
	costRun(&k, costProc{{0.01, 10, 10}}, costProc{{0.05, 10, 25}})
	if c := costTotal(&k); !near(c.USD, 0.05) || !near(k.Base, 0.01) {
		t.Fatalf("a baseline between reports: %+v (%+v)", c, k)
	}
	// No report at or below it: the baseline is 0.
	k = model.ChatCost{Marks: []model.CostMark{{Out: 50, USD: 0.04}}, Last: 0.04, Known: true}
	costSample(&k, model.Claude, true, costEv(0.02, 10, 30))
	if c := costTotal(&k); !near(c.USD, 0.06) || k.Base != 0 {
		t.Fatalf("no report below the baseline's count: %+v (%+v)", c, k)
	}

	// A fresh send closes the session: its cost stays in the sum and the next session starts at 0.
	k = model.ChatCost{}
	costRun(&k, costProc{{0.008073, 45, 45}}, costProc{{0.010650, 44, 89}})
	costFresh(&k)
	if c := costTotal(&k); !near(c.USD, 0.010650) || k.Base != 0 || k.Last != 0 || k.Marks != nil {
		t.Fatalf("after a fresh send: %+v (%+v)", c, k)
	}
	costRun(&k, costProc{{0.004, 20, 20}})
	if c := costTotal(&k); !near(c.USD, 0.014650) {
		t.Fatalf("the session after a fresh send: %+v (%+v)", c, k)
	}

	// pi reports the session's total, across processes: the newest one is the cost.
	k = model.ChatCost{}
	costSample(&k, model.Pi, true, costEv(0.02, 0, 0))
	costSample(&k, model.Pi, false, costEv(0.05, 0, 0))
	costSample(&k, model.Pi, true, costEv(0.07, 0, 0)) // a new process of the same session
	if c := costTotal(&k); !near(c.USD, 0.07) || !c.Known {
		t.Fatalf("pi: %+v (%+v)", c, k)
	}
	costFresh(&k)
	costSample(&k, model.Pi, true, costEv(0.01, 0, 0))
	if c := costTotal(&k); !near(c.USD, 0.08) {
		t.Fatalf("pi after a fresh send: %+v (%+v)", c, k)
	}

	// Cursor reports nothing.
	k = model.ChatCost{}
	costSample(&k, model.Cursor, true, costEv(0.5, 1, 1))
	if c := costTotal(&k); c != (Cost{}) {
		t.Fatalf("cursor: %+v", c)
	}
	// Subagents and lost processes.
	k = model.ChatCost{Sum: 0.01, Subs: 0.02, Lost: 1, Known: true}
	if c := costTotal(&k); !near(c.USD, 0.03) || !c.Partial {
		t.Fatalf("subs and lost: %+v", c)
	}
	if c := costTotal(nil); c != (Cost{}) {
		t.Fatalf("no record: %+v", c)
	}
}

// ownFakeEnv is a run env whose agents of kind are agenttest.Fake processes, all stopped when the
// test ends.
func ownFakeEnv(t *testing.T, kind model.AgentKind) (*env, *fakeRuns, *agenttest.Fake) {
	t.Helper()
	e, fr := runEnv(t)
	f := agenttest.New(kind)
	e.m.Spawners[kind] = f
	t.Cleanup(func() {
		m := e.m // the manager the test ends with: one before a restart was stopped by the test
		_, agents := m.ChatsOfRun(ownRun)
		for _, a := range agents {
			m.StopOwned(a.ID, 0)
		}
		for _, v := range m.Views() {
			m.Stop(v.ID)
		}
		waitFor(t, "the scripted processes to end", func() bool { return f.Live() == 0 })
	})
	return e, fr, f
}

// settle sends one message to a run agent's chat and waits for the chat to settle.
func (e *env) settle(id, text string, o OwnedSend) Settled {
	e.t.Helper()
	if err := e.m.SendOwned(id, text, o); err != nil {
		e.t.Fatalf("SendOwned: %v", err)
	}
	return e.settled(id)
}

func (e *env) settled(id string) Settled {
	e.t.Helper()
	select {
	case a := <-e.waitOwned(id):
		if a.err != nil {
			e.t.Fatalf("WaitOwned: %v", a.err)
		}
		return a.s
	}
}

func (e *env) cost(id string) Cost {
	e.t.Helper()
	c, err := e.m.CostOf(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return c
}

// The pump feeds the rule with every turn end and the cost is in chat.json: c6 (ii) through a
// real manager, with a restart in the middle, then a fresh send.
func TestCostOfARunAgent(t *testing.T) {
	t.Parallel()
	e, fr, f := ownFakeEnv(t, model.Claude)
	id := e.agentChat("agent-1", model.RoleTask, model.Claude)
	if c := e.cost(id); c != (Cost{}) {
		t.Fatalf("cost of a new chat: %+v", c)
	}
	reports := [][3]float64{{0.008073, 45, 45}, {0.010650, 44, 89}, {0.010223, 44, 89}, {0.004, 20, 20}}
	var n atomic.Int32
	var hang atomic.Bool
	started := make(chan struct{}, 8)
	f.Script(func(tn *agenttest.Turn) {
		r := reports[n.Load()]
		tn.Say("turn")
		tn.Cost(r[0], int(r[1]), int(r[2]))
		if hang.Load() {
			started <- struct{}{}
			tn.Hang() // the process is closed in this turn: its end, and its cost, never come
		}
	})

	// P1: a turn, then an orderly close.
	if s := e.settle(id, "one", OwnedSend{}); s.Outcome != EndClean {
		t.Fatalf("%+v", s)
	}
	if c := e.cost(id); !near(c.USD, 0.008073) || !c.Known || c.Partial {
		t.Fatalf("after P1: %+v", c)
	}
	e.m.StopOwned(id, 0)
	if k := e.runMeta(id, true).Cost; k == nil || !near(k.Last, 0.008073) || !k.Known {
		t.Fatalf("chat.json after P1: %+v", k)
	}

	// P2: a resume and a turn; then a restart of the server, as after a kill.
	n.Store(1)
	if s := e.settle(id, "two", OwnedSend{}); s.Outcome != EndClean {
		t.Fatalf("%+v", s)
	}
	if c := e.cost(id); !near(c.USD, 0.010650) || c.Partial {
		t.Fatalf("after P2: %+v", c)
	}
	e.m.StopOwned(id, 0)
	waitFor(t, "the process to end", func() bool { return f.Live() == 0 })
	e.reboot(fr)
	e.m.Spawners[model.Claude] = f
	if c := e.cost(id); !near(c.USD, 0.010650) || !c.Known || c.Partial {
		t.Fatalf("after the restart: %+v", c)
	}

	// P3: a resume that starts from P1's total again.
	n.Store(2)
	if s := e.settle(id, "three", OwnedSend{}); s.Outcome != EndClean {
		t.Fatalf("%+v", s)
	}
	if c := e.cost(id); !near(c.USD, 0.012800) || c.Partial {
		t.Fatalf("after P3: %+v, want 0.012800", c)
	}

	// A fresh send: the session's cost stays, the new session counts from 0.
	n.Store(3)
	if s := e.settle(id, "four", OwnedSend{Fresh: true}); s.Outcome != EndClean {
		t.Fatalf("%+v", s)
	}
	if c := e.cost(id); !near(c.USD, 0.016800) || c.Partial {
		t.Fatalf("after a fresh send: %+v, want 0.016800", c)
	}

	// A process killed in a turn: nothing reports what that turn spent.
	hang.Store(true)
	e.sendOwned(id, "five")
	<-started
	e.m.StopOwned(id, 0)
	if c := e.cost(id); !near(c.USD, 0.016800) || !c.Partial || !c.Known {
		t.Fatalf("after a process closed in its turn: %+v", c)
	}
	if k := e.runMeta(id, true).Cost; k == nil || k.Lost != 1 {
		t.Fatalf("chat.json: %+v", k)
	}
	if _, err := e.m.CostOf("nope"); err == nil {
		t.Fatal("CostOf an unknown chat")
	}
}

// A turn cut off by the end of the server is counted when the chat is read again.
func TestCostLostAcrossARestart(t *testing.T) {
	t.Parallel()
	e, fr := runEnv(t)
	id := e.agentChat("agent-1", model.RoleTask, model.Claude)
	e.sendOwned(id, "one")
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvText, Text: "working"})
	e.m.Shutdown() // the process says nothing more: its turn never ends
	e.reboot(fr)
	if c := e.cost(id); !c.Partial {
		t.Fatalf("after a restart in a turn: %+v", c)
	}
	// Reading the thread clears the turn's mark and writes the count with it: once.
	e.items(id)
	if m := e.runMeta(id, true); m.TurnActive || m.Cost == nil || m.Cost.Lost != 1 {
		t.Fatalf("chat.json: turnActive %v cost %+v", m.TurnActive, m.Cost)
	}
	e.reboot(fr)
	if k := e.runMeta(id, true).Cost; k.Lost != 1 {
		t.Fatalf("counted again at the next start: %+v", k)
	}
}

// A subagent's turn end is counted on its parent's chat, and saved with it; a subagent stopped in
// its turn leaves the cost partial. Cursor reports nothing, whatever its turns do.
func TestCostOfSubagentsAndOtherKinds(t *testing.T) {
	t.Parallel()
	e, id, ag, w := ownStart(t)
	_, c1 := e.ownChild(id, "one")
	_, c2 := e.ownChild(id, "two")
	ag.emit(t, agent.Event{Kind: agent.EvText, Text: "spawned"}, agent.Event{Kind: agent.EvTurnEnd, CostUSD: 0.01, HasCost: true, OutTokens: 9, CumOutTokens: 9})
	c1.emit(t, agent.Event{Kind: agent.EvText, Text: "r1"}, agent.Event{Kind: agent.EvTurnEnd, CostUSD: 0.004, HasCost: true, OutTokens: 3, CumOutTokens: 3})
	waitFor(t, "the delivery", func() bool { return len(ag.sent()) == 2 })
	if c := e.cost(id); !near(c.USD, 0.014) || !c.Known || c.Partial {
		t.Fatalf("with one subagent done: %+v", c)
	}
	if k := e.runMeta(id, true).Cost; k == nil || !near(k.Subs, 0.004) {
		t.Fatalf("chat.json after a subagent's turn end: %+v", k)
	}
	// The second one is stopped in its turn, with the chat.
	ag.emit(t, agent.Event{Kind: agent.EvText, Text: "got one"}, agent.Event{Kind: agent.EvTurnEnd, CostUSD: 0.015, HasCost: true, OutTokens: 4, CumOutTokens: 13})
	ownNotYet(t, w, "the second subagent runs")
	e.m.StopOwned(id, 0)
	waitFor(t, "the child's close", c2.isClosed)
	if c := e.cost(id); !near(c.USD, 0.019) || !c.Partial {
		t.Fatalf("with a subagent stopped in its turn: %+v", c)
	}
	if k := e.runMeta(id, true).Cost; k.Lost != 1 {
		t.Fatalf("chat.json: %+v", k)
	}

	// Cursor: never known.
	ec, _, fc := ownFakeEnv(t, model.Cursor)
	cid := ec.agentChat("agent-c", model.RoleTask, model.Cursor)
	fc.Script(func(tn *agenttest.Turn) { tn.Say("ok"); tn.Cost(0.5, 10, 10) })
	if s := ec.settle(cid, "one", OwnedSend{}); s.Outcome != EndClean {
		t.Fatalf("%+v", s)
	}
	if c := ec.cost(cid); c != (Cost{}) {
		t.Fatalf("cursor: %+v", c)
	}
	// pi: the session's total; a process closed in a turn loses nothing of it.
	ep, _, fp := ownFakeEnv(t, model.Pi)
	pid := ep.agentChat("agent-p", model.RoleTask, model.Pi)
	total := 0.0
	fp.Script(func(tn *agenttest.Turn) { total += 0.02; tn.Say("ok"); tn.Cost(total, 0, 0) })
	ep.settle(pid, "one", OwnedSend{})
	ep.m.StopOwned(pid, 0)
	if s := ep.settle(pid, "two", OwnedSend{}); s.Outcome != EndClean {
		t.Fatalf("%+v", s)
	}
	if c := ep.cost(pid); !near(c.USD, 0.04) || !c.Known || c.Partial {
		t.Fatalf("pi: %+v", c)
	}

	// The cost is kept for the chats of a run only, a person's chat on it included.
	v := e.onRun(model.Claude)
	e.send(v.ID, "hello", "")
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvTurnEnd, CostUSD: 0.03, HasCost: true, OutTokens: 9, CumOutTokens: 9})
	if c := e.cost(v.ID); !near(c.USD, 0.03) || !c.Known {
		t.Fatalf("a person's chat on a run: %+v", c)
	}
	plain := e.create(model.Claude, gOne, "")
	e.send(plain.ID, "hello", "")
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvTurnEnd, CostUSD: 0.03, HasCost: true, OutTokens: 9, CumOutTokens: 9})
	if c := e.cost(plain.ID); c != (Cost{}) || e.meta(plain.ID).Cost != nil {
		t.Fatalf("a chat outside a run: %+v", c)
	}
}

// tokEv is a Claude turn end as a result line gives it: the process's cost and tokens so far.
func tokEv(usd float64, out, cumOut int, cum model.TokenCount) agent.Event {
	ev := costEv(usd, out, cumOut)
	ev.CumTokens, ev.HasTokens = cum, true
	return ev
}

// The tokens follow the cost: a process's counts less those it started from, never a sum of
// result lines.
func TestTokenRule(t *testing.T) {
	t.Parallel()
	tc := func(in, out, read, write int64) model.TokenCount {
		return model.TokenCount{In: in, Out: out, CacheRead: read, CacheWrite: write}
	}
	// A chat that reported a cost and no tokens: not known.
	var k model.ChatCost
	costSample(&k, model.Claude, true, costEv(0.01, 10, 10))
	if c := costTotal(&k); c.TokensKnown || c.Tokens != (model.TokenCount{}) || !c.Known {
		t.Fatalf("no tokens reported: %+v", c)
	}

	// An orderly resume: P2 starts from what P1 had reached, so its first line counts P1 again.
	k = model.ChatCost{}
	costSample(&k, model.Claude, true, tokEv(0.01, 40, 40, tc(100, 40, 1000, 200)))
	costSample(&k, model.Claude, false, tokEv(0.03, 60, 100, tc(250, 100, 3000, 500)))
	if c := costTotal(&k); c.Tokens != tc(250, 100, 3000, 500) || !c.TokensKnown {
		t.Fatalf("one process: %+v", c)
	}
	costSample(&k, model.Claude, true, tokEv(0.04, 30, 130, tc(300, 130, 4500, 600)))
	if c := costTotal(&k); c.Tokens != tc(300, 130, 4500, 600) || k.TokBase != tc(250, 100, 3000, 500) || k.TokSum != tc(250, 100, 3000, 500) {
		t.Fatalf("after an orderly resume: %+v (%+v)", c, k)
	}
	if n := len(k.Marks); n != 2 || k.Marks[0].Tok != tc(250, 100, 3000, 500) || k.Marks[1].Tok != tc(300, 130, 4500, 600) {
		t.Fatalf("marks: %+v", k.Marks)
	}

	// A killed process: P2 was killed after a turn, so P3 starts from P1's last line again, and
	// what P2 used stays counted. The baseline is that of the mark the cost's was found at.
	k = model.ChatCost{}
	costSample(&k, model.Claude, true, tokEv(0.008, 45, 45, tc(10, 45, 1000, 100)))
	costSample(&k, model.Claude, true, tokEv(0.011, 44, 89, tc(20, 89, 2100, 150)))
	costSample(&k, model.Claude, true, tokEv(0.010, 44, 89, tc(25, 89, 2300, 100)))
	// P1 10/45/1000/100, P2 +10/+44/+1100/+50, P3 +15/+44/+1300/+0.
	if c := costTotal(&k); c.Tokens != tc(35, 133, 3400, 150) || k.TokBase != tc(10, 45, 1000, 100) {
		t.Fatalf("after a killed process: %+v (%+v)", c, k)
	}
	// A session whose earlier process was killed before any orderly exit: the process counts from 0.
	k = model.ChatCost{}
	costSample(&k, model.Claude, true, tokEv(0.01, 10, 10, tc(5, 10, 100, 10)))
	costSample(&k, model.Claude, true, tokEv(0.02, 20, 20, tc(8, 20, 300, 20)))
	if c := costTotal(&k); c.Tokens != tc(13, 30, 400, 30) || k.TokBase != (model.TokenCount{}) {
		t.Fatalf("a process that starts from 0: %+v (%+v)", c, k)
	}
	// A count that is below the baseline's did not start from it: it is counted from 0.
	k = model.ChatCost{}
	costSample(&k, model.Claude, true, tokEv(0.01, 40, 40, tc(100, 40, 1000, 200)))
	costSample(&k, model.Claude, true, tokEv(0.02, 30, 70, tc(150, 70, 400, 50)))
	if c := costTotal(&k); c.Tokens != tc(150, 70, 1400, 250) {
		t.Fatalf("counts that restarted: %+v (%+v)", c, k)
	}

	// A fresh send closes the session: its tokens stay and the next session counts from 0.
	k = model.ChatCost{}
	costSample(&k, model.Claude, true, tokEv(0.01, 40, 40, tc(100, 40, 1000, 200)))
	costSample(&k, model.Claude, true, tokEv(0.02, 30, 70, tc(150, 70, 1800, 260)))
	costFresh(&k)
	if c := costTotal(&k); c.Tokens != tc(150, 70, 1800, 260) || k.TokBase != (model.TokenCount{}) || k.TokLast != (model.TokenCount{}) {
		t.Fatalf("after a fresh send: %+v (%+v)", c, k)
	}
	costSample(&k, model.Claude, true, tokEv(0.004, 20, 20, tc(7, 20, 50, 900)))
	if c := costTotal(&k); c.Tokens != tc(157, 90, 1850, 1160) {
		t.Fatalf("the session after a fresh send: %+v (%+v)", c, k)
	}

	// pi reports the session's counts, across processes; they come also without a cost.
	k = model.ChatCost{}
	costSample(&k, model.Pi, true, agent.Event{CumTokens: tc(10, 5, 100, 20), HasTokens: true})
	if c := costTotal(&k); c.Tokens != tc(10, 5, 100, 20) || !c.TokensKnown || c.Known {
		t.Fatalf("pi without a cost: %+v", c)
	}
	costSample(&k, model.Pi, true, tokEv(0.07, 0, 0, tc(30, 15, 400, 60)))
	costFresh(&k)
	costSample(&k, model.Pi, true, tokEv(0.01, 0, 0, tc(1, 2, 3, 4)))
	if c := costTotal(&k); c.Tokens != tc(31, 17, 403, 64) || !near(c.USD, 0.08) {
		t.Fatalf("pi after a fresh send: %+v", c)
	}

	// Cursor reports nothing.
	k = model.ChatCost{}
	costSample(&k, model.Cursor, true, tokEv(0.5, 1, 1, tc(1, 1, 1, 1)))
	if c := costTotal(&k); c != (Cost{}) {
		t.Fatalf("cursor: %+v", c)
	}
}

// Through the manager: the tokens of every turn end and of an app-spawned subagent, the peak of
// the chat's own requests, both in chat.json; and a chat with two branches.
func TestTokensAndPeakOfARunAgent(t *testing.T) {
	t.Parallel()
	tc := func(in, out, read, write int64) model.TokenCount {
		return model.TokenCount{In: in, Out: out, CacheRead: read, CacheWrite: write}
	}
	e, id, ag, w := ownStart(t)
	_, c1 := e.ownChild(id, "one")
	ag.emit(t, agent.Event{Kind: agent.EvUsage, CtxIn: 5000}, agent.Event{Kind: agent.EvUsage, CtxIn: 42000}, agent.Event{Kind: agent.EvUsage, CtxIn: 9000},
		agent.Event{Kind: agent.EvText, Text: "spawned"}, tokEv(0.01, 9, 9, tc(10, 9, 800, 70)))
	// The subagent's own context is not the chat's peak; its tokens are the chat's.
	c1.emit(t, agent.Event{Kind: agent.EvUsage, CtxIn: 90000}, agent.Event{Kind: agent.EvText, Text: "r1"}, tokEv(0.004, 3, 3, tc(4, 3, 200, 30)))
	waitFor(t, "the delivery", func() bool { return len(ag.sent()) == 2 })
	if c := e.cost(id); c.Tokens != tc(14, 12, 1000, 100) || !c.TokensKnown || c.Peak != 42000 {
		t.Fatalf("with a subagent done: %+v", c)
	}
	ag.emit(t, agent.Event{Kind: agent.EvText, Text: "got one"}, tokEv(0.015, 4, 13, tc(15, 13, 1700, 90)))
	ownGot(t, w)
	if c := e.cost(id); c.Tokens != tc(19, 16, 1900, 120) || c.Peak != 42000 {
		t.Fatalf("after the second turn: %+v", c)
	}
	if k := e.runMeta(id, true).Cost; k == nil || k.TokSubs != tc(4, 3, 200, 30) || k.TokLast != tc(15, 13, 1700, 90) || !k.TokKnown || k.Peak != 42000 {
		t.Fatalf("chat.json: %+v", k)
	}

	// A second branch of the chat: the tokens are summed and the largest peak counts.
	top, err := e.m.topChat(id)
	if err != nil {
		t.Fatal(err)
	}
	kid := &Chat{}
	kid.meta.Cost = &model.ChatCost{TokLast: tc(1, 2, 3, 4), TokKnown: true, Peak: 50000}
	e.m.mu.Lock()
	top.kids = append(top.kids, kid)
	e.m.mu.Unlock()
	c := e.cost(id)
	e.m.mu.Lock()
	top.kids = top.kids[:len(top.kids)-1]
	e.m.mu.Unlock()
	if c.Tokens != tc(20, 18, 1903, 124) || c.Peak != 50000 {
		t.Fatalf("two branches: %+v", c)
	}

	// A chat that is not on a run keeps neither.
	plain := e.create(model.Claude, gOne, "").ID
	e.send(plain, "hi", "")
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvUsage, CtxIn: 7000}, tokEv(0.01, 1, 1, tc(1, 1, 1, 1)))
	waitFor(t, "the turn's end", func() bool { return e.meta(plain).Usage.Turns == 1 })
	if k := e.meta(plain).Cost; k != nil {
		t.Fatalf("a chat outside a run: %+v", k)
	}
}
