package runs

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// The run tools end to end: the real MCP handler (tools/list and tools/call with a chat's token),
// the real chat manager resolving the token, and the real Service answering.
//
// The chats are chat.json files written by hand, one per kind of caller: the orchestrator's with
// the id the run gives its turn's agent, a task agent's, a merge agent's, a person's chat on the
// run, the same in runs of the other wake modes, and an ordinary chat.
func TestToolsThroughTheMCPHandler(t *testing.T) {
	x := newToolRun(t, false)
	n := x.turnStart("start")
	// A second run, whose wake mode is each, and a third whose wake mode is idle: their
	// orchestrators have no wait_for.
	each, idle := x.startRun("r_tools002", "Each", false), x.startRun("r_tools003", "Idle", false)
	for r, mode := range map[*run]string{each: "each", idle: "idle"} {
		r.mu.Lock()
		r.meta.Settings.Wake = mode
		r.mu.Unlock()
	}
	list, call := toolMCP(t, x.svcEnv, []model.ChatMeta{
		{ID: x.orchChat(n), Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(), Token: "tok-orchestrator", Run: x.id, Role: model.RoleOrchestrator},
		{ID: toolChat, Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(), Token: "tok-chat", Run: x.id},
		{ID: AgentChatID(x.id, "T01-work"), Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(), Token: "tok-task", Run: x.id, Role: model.RoleTask},
		{ID: AgentChatID(x.id, "T01-merge"), Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(), Token: "tok-merge", Run: x.id, Role: model.RoleMerge},
		{ID: AgentChatID(each.id, TurnAgentName(1)), Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(), Token: "tok-each", Run: each.id, Role: model.RoleOrchestrator},
		{ID: "chat-2", Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(), Token: "tok-each-chat", Run: each.id},
		{ID: AgentChatID(idle.id, TurnAgentName(1)), Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(), Token: "tok-idle", Run: idle.id, Role: model.RoleOrchestrator},
		{ID: "chat-3", Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(), Token: "tok-plain"},
	})

	// Who is offered what: the complete list of every kind of caller. (A subagent's token is made
	// by the chat manager when it spawns one: internal/boardapi lists a subagent of a task agent.)
	const (
		orchEach = "get_run get_task get_agent get_notes set_notes edit_notes add_task update_task cancel_task retry_task finish_run"
		runChat  = "get_run get_task get_agent get_notes add_task update_task cancel_task retry_task tell_orchestrator spawn_subagent stop_subagent list_subagent_models"
		spawn    = "spawn_subagent stop_subagent list_subagent_models"
	)
	for _, c := range [][3]string{
		{"the orchestrator, wake mode declared", "tok-orchestrator", "get_run get_task get_agent get_notes set_notes edit_notes add_task update_task cancel_task retry_task wait_for finish_run"},
		{"the orchestrator, wake mode each", "tok-each", orchEach},
		{"the orchestrator, wake mode idle", "tok-idle", orchEach},
		{"a person's chat on a run", "tok-chat", runChat},
		{"a person's chat on a run in wake mode each", "tok-each-chat", runChat},
		{"a task agent", "tok-task", spawn},
		{"a merge agent", "tok-merge", spawn},
		{"an ordinary chat", "tok-plain", spawn},
	} {
		if got := list(c[1]); got != c[2] {
			t.Fatalf("%s is listed\n     %s\nwant %s", c[0], got, c[2])
		}
	}

	if text, isErr := call("tok-orchestrator", "add_task", toolAdd("Read the old importer", "research", false)); isErr ||
		text != "Added T01: Read the old importer. It starts after your turn ends, once its dependencies are done." {
		t.Fatalf("the orchestrator's add_task: %q", text)
	}
	if text, isErr := call("tok-orchestrator", "get_run", `{}`); isErr ||
		!strings.Contains(text, "\nT01 [research, reports only, standard] pending, starts when the current turn ends: Read the old importer") {
		t.Fatalf("the orchestrator's get_run: %q", text)
	}
	if text, isErr := call("tok-chat", "get_run", `{}`); isErr || !strings.Contains(text, "\nT01 [research, reports only, standard] pending, starts when turn 1 ends: Read the old importer") {
		t.Fatalf("the chat's get_run: %q", text)
	}
	if text, isErr := call("tok-chat", "tell_orchestrator", `{"text":"Small tasks, please."}`); isErr || !strings.HasPrefix(text, "Passed on.") {
		t.Fatalf("the chat's tell_orchestrator: %q", text)
	}
	// What the caller is not listed is refused, with the service's own sentence.
	for _, c := range [][3]string{
		{"tok-chat", "set_notes", toolChatNotes}, {"tok-chat", "finish_run", toolChatFinish}, {"tok-orchestrator", "tell_orchestrator", toolOrchTell},
		{"tok-chat", "edit_notes", toolChatNotes}, {"tok-chat", "wait_for", toolChatWait}, {"tok-each-chat", "wait_for", toolChatWait},
		{"tok-task", "wait_for", "wait_for is not available to this agent"}, {"tok-merge", "edit_notes", "edit_notes is not available to this agent"},
		{"tok-plain", "wait_for", "wait_for is not available on this chat"},
		{"tok-each", "wait_for", "unknown tool wait_for"}, {"tok-idle", "wait_for", "unknown tool wait_for"},
		{"tok-orchestrator", "spawn_subagent", "spawn_subagent is not available to this agent"},
		{"tok-orchestrator", "list_boards", "list_boards is not available on this chat"}, {"tok-chat", "apply", "apply is not available on this chat"},
	} {
		if text, isErr := call(c[0], c[1], `{}`); !isErr || text != c[2] {
			t.Fatalf("%s calls %s: %q", c[0], c[1], text)
		}
	}
	// The calls were made as the callers they are: the orchestrator's are ops of turn 1, the
	// chat's change is a chatOps record of the chat's id.
	l := x.state()
	var ops []string
	for _, op := range l.Turns[0].Ops {
		ops = append(ops, op.Op)
	}
	if fmt.Sprint(ops) != "[add_task get_run tell_orchestrator]" || len(l.ChatOps) != 5 || l.ChatOps[0].Chat != toolChat || l.ChatOps[0].Op != "tell_orchestrator" ||
		len(l.State.Inbox) != 1 || l.Tasks[0].AddedTurn != 1 {
		t.Fatalf("ops of turn 1 %v; chatOps %+v", ops, l.ChatOps)
	}
	// Once the turn is over, the same token changes nothing.
	x.turnEnd("One task.", 0.1)
	if text, isErr := call("tok-orchestrator", "add_task", toolAdd("Too late", "research", false)); !isErr || text != "the orchestrator's turn is over; add_task was not run" {
		t.Fatalf("after the turn: %q", text)
	}
	if got := len(x.state().Tasks); got != 1 {
		t.Fatalf("%d tasks", got)
	}
}

// toolMCP writes the chats as chat.json files, loads them with the real chat manager and returns
// the real MCP handler's tools/list (the names, in order) and tools/call (the text and isError)
// for a bearer token.
func toolMCP(t *testing.T, x *svcEnv, metas []model.ChatMeta) (list func(token string) string, call func(token, name, args string) (string, bool)) {
	t.Helper()
	st := x.s.Store
	for _, meta := range metas {
		if err := os.MkdirAll(st.P.ChatDir(meta.ID), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := store.WriteJSONAtomic(filepath.Join(st.P.ChatDir(meta.ID), "chat.json"), meta, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	br := editorbridge.New(nil)
	bds := boards.New(st, br)
	if err := bds.Load(); err != nil {
		t.Fatal(err)
	}
	m := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bds, DefaultCwd: x.cwd})
	if err := m.Load(); err != nil {
		t.Fatal(err)
	}
	for _, meta := range metas {
		if c, ok := m.ResolveToken(meta.Token); !ok || c.Meta.ID != meta.ID || c.Meta.Run != meta.Run || c.Meta.Role != meta.Role {
			// Not a skip: these tests are the proof of who is offered which run tool.
			t.Fatalf("the chat manager did not load the chat of %s from chats/ as written: %+v %v", meta.Token, c.Meta, ok)
		}
	}
	relay := &boardapi.Relay{Bridge: br, Chats: m, Boards: bds, Runs: x.s}
	rpc := func(token, method, params string) map[string]any {
		t.Helper()
		body := fmt.Sprintf(`{"jsonrpc":"2.0","id":1,"method":%q,"params":%s}`, method, params)
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		relay.ServeFixedMCP(w, req)
		var out struct {
			Result map[string]any `json:"result"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || out.Result == nil {
			t.Fatalf("%s: status %d, body %s", method, w.Code, w.Body.String())
		}
		return out.Result
	}
	list = func(token string) string {
		t.Helper()
		var names []string
		for _, tl := range rpc(token, "tools/list", `{}`)["tools"].([]any) {
			names = append(names, tl.(map[string]any)["name"].(string))
		}
		return strings.Join(names, " ")
	}
	call = func(token, name, args string) (string, bool) {
		t.Helper()
		res := rpc(token, "tools/call", fmt.Sprintf(`{"name":%q,"arguments":%s}`, name, args))
		isErr, _ := res["isError"].(bool)
		return res["content"].([]any)[0].(map[string]any)["text"].(string), isErr
	}
	return list, call
}

// toolRunIn is another started run of x's service, in the wake mode given.
func toolRunIn(x *toolRun, id, name, wake string) *toolRun {
	y := &toolRun{svcEnv: x.svcEnv, id: id}
	y.r = y.startRun(id, name, false)
	y.wake(wake)
	return y
}

// wait_for in each wake mode, called by the orchestrator while its turn runs: in declared it is
// listed and sets the wait; in each and idle it is not listed, a call is answered as an unknown
// tool's is, the turn records it as refused, and no wait is set.
func TestWaitForInEachWakeModeThroughTheMCPHandler(t *testing.T) {
	x := newToolRun(t, false)
	runs := map[string]*toolRun{"declared": x, "each": toolRunIn(x, "r_tools002", "Each", "each"), "idle": toolRunIn(x, "r_tools003", "Idle", "idle")}
	modes := []string{"declared", "each", "idle"}
	var metas []model.ChatMeta
	for _, mode := range modes {
		y := runs[mode]
		n := y.turnStart("start")
		metas = append(metas, model.ChatMeta{ID: y.orchChat(n), Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(),
			Token: "tok-" + mode, Run: y.id, Role: model.RoleOrchestrator})
	}
	list, call := toolMCP(t, x.svcEnv, metas)
	for _, mode := range modes {
		y, tok := runs[mode], "tok-"+mode
		if text, isErr := call(tok, "add_task", toolAdd("Read the old importer", "research", false)); isErr {
			t.Fatalf("%s: add_task: %q", mode, text)
		}
		listed := slices.Contains(strings.Fields(list(tok)), "wait_for")
		text, isErr := call(tok, "wait_for", `{"tasks":["T01"]}`)
		l := y.state()
		ops := l.Turns[0].Ops
		if len(ops) != 2 || ops[0].Op != "add_task" || ops[1].Op != "wait_for" {
			t.Fatalf("%s: the ops of turn 1: %+v", mode, ops)
		}
		if mode == "declared" {
			want := &model.RunWait{Tasks: []string{"T01"}, Mode: "all", Turn: 1}
			if !listed || isErr || !reflect.DeepEqual(l.State.Wait, want) || ops[1].Error != "" || !reflect.DeepEqual(ops[1].Tasks, want.Tasks) {
				t.Errorf("declared: listed %v, answer %q (error %v), wait %+v, op %+v", listed, text, isErr, l.State.Wait, ops[1])
			}
			continue
		}
		if listed || !isErr || text != "unknown tool wait_for" || l.State.Wait != nil || ops[1].Error != "unknown tool wait_for" {
			t.Errorf("%s: listed %v, answer %q (error %v), wait %+v, op %+v", mode, listed, text, isErr, l.State.Wait, ops[1])
		}
	}
}

// Who calls is what the bearer token says and nothing else: arguments that name another run, chat
// or role change neither the run a call works on nor what the caller may do, and a chat's id is
// not a token.
func TestToolCallerIsTheTokens(t *testing.T) {
	x := newToolRun(t, false)
	n := x.turnStart("start")
	other := toolRunIn(x, "r_tools002", "Other", "declared")
	on := other.turnStart("start")
	chat := func(id, tok, run string, role model.AgentRole) model.ChatMeta {
		return model.ChatMeta{ID: id, Agent: model.Claude, Cwd: x.cwd, Model: "sonnet", Created: x.clock.Now(), Token: tok, Run: run, Role: role}
	}
	list, call := toolMCP(t, x.svcEnv, []model.ChatMeta{
		chat(x.orchChat(n), "tok-orchestrator", x.id, model.RoleOrchestrator),
		chat(toolChat, "tok-chat", x.id, ""),
		chat(AgentChatID(x.id, "T01-work"), "tok-task", x.id, model.RoleTask),
		chat(other.orchChat(on), "tok-other", other.id, model.RoleOrchestrator),
		chat("chat-3", "tok-plain", "", ""),
	})
	// What an agent could add to its arguments to pass for another caller.
	as := func(args, run, chat, role string) string {
		var m map[string]any
		if err := json.Unmarshal([]byte(args), &m); err != nil {
			t.Fatal(err)
		}
		m["run"], m["run_id"], m["chat"], m["chat_id"], m["role"] = run, run, chat, chat, role
		return toolArgsJSON(t, m)
	}
	untouched := func(when string) {
		t.Helper()
		if l := other.state(); len(l.Tasks) != 0 || len(l.Notes) != 0 || len(l.Turns[0].Ops) != 0 || len(l.ChatOps) != 0 || len(l.State.Inbox) != 0 || l.State.Wait != nil || l.State.Result != nil {
			t.Fatalf("%s: the other run changed: %d tasks, %d notes, ops %+v, chatOps %+v, state %+v", when, len(l.Tasks), len(l.Notes), l.Turns[0].Ops, l.ChatOps, l.State)
		}
	}

	// The orchestrator of one run names the other run: the task is its own run's, added by its turn.
	if text, isErr := call("tok-orchestrator", "add_task", as(toolAdd("Read the old importer", "research", false), other.id, other.orchChat(on), "orchestrator")); isErr ||
		!strings.HasPrefix(text, "Added T01: Read the old importer.") {
		t.Fatalf("the orchestrator's add_task: %q", text)
	}
	untouched("the orchestrator names the other run")
	if l := x.state(); len(l.Tasks) != 1 || l.Tasks[0].AddedTurn != n || len(l.Turns[0].Ops) != 1 || len(l.ChatOps) != 0 {
		t.Fatalf("the orchestrator's own run: %d tasks, ops %+v, chatOps %+v", len(l.Tasks), l.Turns[0].Ops, l.ChatOps)
	}
	// It names a person's chat and no role: it is still the orchestrator, who cannot tell itself.
	if text, isErr := call("tok-orchestrator", "tell_orchestrator", as(`{"text":"Hurry."}`, x.id, toolChat, "")); !isErr || text != toolOrchTell {
		t.Errorf("the orchestrator as a chat: %q", text)
	}
	// A person's chat names the orchestrator: it has the chat's tools and is recorded as the chat.
	if text, isErr := call("tok-chat", "finish_run", as(`{"outcome":"achieved","summary":"Done."}`, x.id, x.orchChat(n), "orchestrator")); !isErr || text != toolChatFinish {
		t.Errorf("a chat as the orchestrator, finish_run: %q", text)
	}
	if text, isErr := call("tok-chat", "wait_for", as(`{"tasks":["T01"]}`, x.id, x.orchChat(n), "orchestrator")); !isErr || text != toolChatWait {
		t.Errorf("a chat as the orchestrator, wait_for: %q", text)
	}
	if text, isErr := call("tok-chat", "tell_orchestrator", as(`{"text":"Small tasks, please."}`, other.id, "chat-9", "orchestrator")); isErr || !strings.HasPrefix(text, "Passed on.") {
		t.Errorf("a chat names the other run: %q", text)
	}
	untouched("a chat names the other run")
	l := x.state()
	if l.State.Result != nil || l.State.Wait != nil || len(l.State.Inbox) != 1 || l.State.Inbox[0].Chat != toolChat || len(l.Turns[0].Ops) != 2 {
		t.Errorf("after the chat's calls: state %+v, ops of turn 1 %+v", l.State, l.Turns[0].Ops)
	}
	for _, op := range l.ChatOps {
		if op.Chat != toolChat {
			t.Errorf("a chat's op is recorded for %q: %+v", op.Chat, op)
		}
	}
	// A task agent and a chat on no run have no run tool, whatever they say they are.
	before := x.state().Version
	for _, c := range [][2]string{{"tok-task", "add_task is not available to this agent"}, {"tok-plain", "add_task is not available on this chat"}} {
		if text, isErr := call(c[0], "add_task", as(toolAdd("Sneak in", "research", false), x.id, x.orchChat(n), "orchestrator")); !isErr || text != c[1] {
			t.Errorf("%s as the orchestrator: %q", c[0], text)
		}
	}
	// A chat's id is not a token: nothing is listed and nothing is run.
	for _, id := range []string{x.orchChat(n), toolChat, other.orchChat(on)} {
		if got := list(id); got != "" {
			t.Errorf("the chat id %s as a token is listed %q", id, got)
		}
		if text, isErr := call(id, "add_task", toolAdd("Sneak in", "research", false)); !isErr || text != "unknown board token" {
			t.Errorf("the chat id %s as a token: %q", id, text)
		}
	}
	if l := x.state(); l.Version != before || len(l.Tasks) != 1 {
		t.Errorf("the refused calls changed the run: version %d, was %d; %d tasks", l.Version, before, len(l.Tasks))
	}
	untouched("at the end")
}
