package model

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// A chat that is on no run reads and writes exactly as before the run fields existed.
func TestChatMetaWithoutRunFields(t *testing.T) {
	const old = `{"id":"c1","agent":"claude","name":"A chat","group":"g_1","cwd":"/work","model":"sonnet","sessionId":"s1","locked":true,` +
		`"token":"tok","created":"2026-01-02T03:04:05Z","usage":{"ctxIn":1,"ctxOut":2,"ctxWindow":3,"turns":4}}`
	var m ChatMeta
	if err := json.Unmarshal([]byte(old), &m); err != nil {
		t.Fatal(err)
	}
	if m.Run != "" || m.Role != "" || m.Cost != nil {
		t.Errorf("an old chat.json read with run fields set: %+v", m)
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != old {
		t.Errorf("an old chat.json is written differently:\n%s\n%s", b, old)
	}
	v := ViewOf(m, StatusReady, "", "", false)
	if vb, _ := json.Marshal(v); strings.Contains(string(vb), `"run"`) || strings.Contains(string(vb), `"role"`) || strings.Contains(string(vb), `"cost"`) {
		t.Errorf("the view of a chat on no run names run, role or cost: %s", vb)
	}
	if v != ViewOf(m, StatusReady, "", "", false) { // still comparable with ==
		t.Error("two views of the same chat differ")
	}
}

// A run agent's chat: run, role and cost are kept in chat.json; the view has run and role and
// never the cost or the token.
func TestChatMetaRunFields(t *testing.T) {
	m := ChatMeta{ID: "c1", Agent: Claude, Run: "r_1", Role: RoleTask, Cwd: "/work", Model: "sonnet", Token: "secret", Created: time.Unix(1, 0).UTC(),
		Cost: &ChatCost{Sum: 1.5, Base: 0.25, Last: 0.5, Subs: 0.125, Marks: []CostMark{{Out: 100, USD: 0.25}, {Out: 300, USD: 0.5}}, Known: true, Lost: 1}}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"run":"r_1"`, `"role":"task"`, `"cost":{"sum":1.5,"base":0.25,"last":0.5,"subs":0.125,"marks":[{"out":100,"usd":0.25},{"out":300,"usd":0.5}],"known":true,"lost":1}`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("chat.json lacks %s:\n%s", want, b)
		}
	}
	var back ChatMeta
	if err := json.Unmarshal(b, &back); err != nil || back.Run != "r_1" || back.Role != RoleTask || back.Cost == nil || back.Cost.Lost != 1 || len(back.Cost.Marks) != 2 {
		t.Errorf("read back: %+v, %v", back, err)
	}
	// A cost with nothing in it but a sum of zero still says "sum".
	if zb, _ := json.Marshal(ChatCost{}); string(zb) != `{"sum":0}` {
		t.Errorf("an empty cost: %s", zb)
	}
	v := ViewOf(m, StatusReady, "", "", false)
	vb, _ := json.Marshal(v)
	if v.Run != "r_1" || v.Role != RoleTask || strings.Contains(string(vb), "cost") || strings.Contains(string(vb), "secret") {
		t.Errorf("view: %s", vb)
	}
}

func TestRunStatusesAndDefaults(t *testing.T) {
	for _, s := range []RunStatus{RunRunning, RunStopping, RunStopped, RunStalled, RunError, RunCompleted, RunGaveUp} {
		if !s.Started() {
			t.Errorf("%q is not started", s)
		}
		if s.Live() != (s == RunRunning || s == RunStopping) || s.Final() != (s == RunCompleted || s == RunGaveUp) {
			t.Errorf("%q: live %v final %v", s, s.Live(), s.Final())
		}
	}
	if RunDraft.Started() || RunStatus("").Started() {
		t.Error("a draft is started")
	}
	n := 0
	for _, s := range []TaskState{TaskHeld, TaskDeps, TaskBlocked, TaskSlot, TaskSetup, TaskWork, TaskMerge, TaskDone, TaskFailed, TaskCancelled} {
		for _, is := range []bool{s.Waiting(), s.Active(), s.Final()} {
			if is {
				n++
			}
		}
	}
	if n != 10 {
		t.Errorf("the ten task states fall into %d classes, want each into exactly one", n)
	}
	if d := DefaultRunSettings(); d.MaxParallel != 8 || d.MaxTurns != 60 || d.MaxCost != 0 || d.Wake != "declared" || d.MaxIdleTurns != 3 ||
		d.AgentTimeoutSec != 10800 || d.AgentRetries != 2 || d.KeepWorktrees || d.Setup != "" {
		t.Errorf("default settings: %+v", d)
	}
	// run.json of a draft has no "started"; a started one has it.
	m := RunMeta{ID: "r_1", Name: "New run", Group: Ungrouped, Created: time.Unix(1, 0).UTC(), Agent: Claude, Settings: DefaultRunSettings()}
	if b, _ := json.Marshal(m); strings.Contains(string(b), "started") || strings.Contains(string(b), `"git"`) || strings.Contains(string(b), "draft") {
		t.Errorf("a draft's run.json: %s", b)
	}
	m.Started, m.Git = time.Unix(2, 0).UTC(), true
	if b, _ := json.Marshal(m); !strings.Contains(string(b), `"started":"1970-01-01T00:00:02Z"`) || !strings.Contains(string(b), `"git":true`) {
		t.Errorf("a started run's run.json: %s", b)
	}
	// Defaults without run defaults name none, and a group with nothing stored is empty.
	if b, _ := json.Marshal(LocalDefaults(ServerDefaults{Cwd: "/w"})); string(b) != `{"servers":{"local":{"cwd":"/w"}}}` {
		t.Errorf("group defaults: %s", b)
	}
	if b, _ := json.Marshal(GroupDefaults{}); string(b) != `{}` {
		t.Errorf("empty group defaults: %s", b)
	}
	full := GroupDefaults{Server: LocalServer, Servers: map[string]ServerDefaults{LocalServer: {Agent: Pi, Cwd: "/w",
		ByAgent: map[AgentKind]ModelChoice{Claude: {Model: "opus", Effort: "max"}}, Run: &RunDefaults{Agent: Cursor, MaxParallel: 2, MaxTurns: 10}}}}
	if b, _ := json.Marshal(full); string(b) != `{"server":"local","servers":{"local":{"agent":"pi","cwd":"/w","byAgent":{"claude":{"model":"opus","effort":"max"}},"run":{"agent":"cursor","maxParallel":2,"maxTurns":10,"maxCost":0}}}}` {
		t.Errorf("full group defaults: %s", b)
	}
	if got := full.On(LocalServer); got.Agent != Pi || got.Cwd != "/w" || got.Run == nil {
		t.Errorf("On(local) = %+v", got)
	}
	if got := full.On("srv_far"); got.Agent != "" || got.Cwd != "" || got.ByAgent != nil || got.Run != nil {
		t.Errorf("On of a server with no part = %+v, want the zero value", got)
	}
	if got := (GroupDefaults{}).On(LocalServer); got.Cwd != "" || got.Run != nil {
		t.Errorf("On of an empty group = %+v, want the zero value", got)
	}
}

// A run of this computer reads and writes exactly as before the fields of remote runs existed.
func TestRunWithoutRemoteFields(t *testing.T) {
	const oldMeta = `{"id":"r_1","name":"A run","userNamed":true,"group":"g_1","created":"2026-01-02T03:04:05Z","agent":"claude",` +
		`"tiers":{"deep":{"model":"opus","effort":"high"},"standard":{"model":"sonnet","effort":"medium"},"light":{"model":"haiku","effort":"low"}},` +
		`"cwd":"/work","settings":{"maxParallel":8,"maxTurns":60,"maxCost":0,"wake":"declared","maxIdleTurns":3,"agentTimeoutSec":10800,"agentRetries":2},` +
		`"draft":{"text":"goal"},"started":"2026-01-02T03:05:05Z","git":true,"client":"cl_1","archived":true}`
	const oldView = `{"id":"r_1","name":"A run","group":"g_1","created":"2026-01-02T03:04:05Z","agent":"claude",` +
		`"tiers":{"deep":{"model":"opus","effort":"high"},"standard":{"model":"sonnet","effort":"medium"},"light":{"model":"haiku","effort":"low"}},` +
		`"cwd":"/work","git":true,"settings":{"maxParallel":8,"maxTurns":60,"maxCost":0,"wake":"declared","maxIdleTurns":3,"agentTimeoutSec":10800,"agentRetries":2},` +
		`"started":"2026-01-02T03:05:05Z","status":"stopped","reason":"why","activeMs":50,"asOf":200,"turns":3,"idleStreak":1,` +
		`"counts":{"held":0,"deps":1,"blocked":0,"slot":0,"setup":0,"work":2,"merge":0,"done":3,"failed":0,"cancelled":0},"cost":1.5,"attention":2,"delivery":"kept"}`
	var m RunMeta
	if err := json.Unmarshal([]byte(oldMeta), &m); err != nil {
		t.Fatal(err)
	}
	if m.Server != "" || m.RemoteStart != "" {
		t.Errorf("an old run.json read with remote fields set: %+v", m)
	}
	if b, err := json.Marshal(m); err != nil || string(b) != oldMeta {
		t.Errorf("an old run.json is written differently (%v):\n%s\n%s", err, b, oldMeta)
	}
	var v RunView
	if err := json.Unmarshal([]byte(oldView), &v); err != nil {
		t.Fatal(err)
	}
	if v.Server != "" || v.Start != "" || v.Gone || v.Was != "" {
		t.Errorf("an old run view read with remote fields set: %+v", v)
	}
	if b, err := json.Marshal(v); err != nil || string(b) != oldView {
		t.Errorf("an old run view is written differently (%v):\n%s\n%s", err, b, oldView)
	}

	// The fields of a remote run, under their names.
	m.Server, m.RemoteStart = "s_1", RemoteUnconfirmed
	if b, _ := json.Marshal(m); !strings.Contains(string(b), `"client":"cl_1","server":"s_1","remoteStart":"unconfirmed"`) {
		t.Errorf("run.json of a remote draft: %s", b)
	}
	v.Server, v.Start, v.Gone, v.Was = "s_1", RemoteUnconfirmed, true, "r_0"
	if b, _ := json.Marshal(v); !strings.HasSuffix(string(b), `"delivery":"kept","server":"s_1","start":"unconfirmed","gone":true,"was":"r_0"}`) {
		t.Errorf("the view of a remote run: %s", b)
	}
}
