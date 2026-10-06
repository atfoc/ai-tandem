package boardapi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// Tool lists and dispatch for callers whose chat belongs to a run, through the MCP handler with
// real tokens. The run service is a fake: what is checked here is who reaches it, and with what.

// fakeRuns is a RunService that lists what the real one lists and records every call.
type fakeRuns struct {
	mu     sync.Mutex
	calls  []string
	greedy bool // Tools also names tools that are no run tools
	each   bool // the run's wake mode is not declared: the orchestrator has no wait_for
}

func (f *fakeRuns) Tools(c RunCaller) []boardtools.Tool {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []boardtools.Tool
	switch {
	case c.Subagent:
	case c.Role == model.RoleOrchestrator:
		out = boardtools.RunToolsFor(true, !f.each)
	case c.Role == "":
		out = boardtools.RunChatTools()
	}
	if f.greedy {
		out = append(out, boardtools.Tools...)
		out = append(out, boardtools.SpawnFamily...)
		out = append(out, boardtools.RunTools...)
	}
	return out
}

// Call answers like the real service where it matters here: a run tool the caller is not listed
// (set_notes, edit_notes, wait_for and finish_run for a chat, tell_orchestrator for the orchestrator) is refused by the
// service itself, with a text of its own.
func (f *fakeRuns) Call(c RunCaller, name string, args json.RawMessage) (string, bool) {
	listed := false
	for _, tl := range f.Tools(c) {
		listed = listed || tl.Name == name
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, fmt.Sprintf("%s run=%s chat=%s role=%s sub=%v args=%s", name, c.Run, c.Chat, c.Role, c.Subagent, args))
	if !listed {
		return "the run service refuses " + name, true
	}
	return "ran " + name, false
}

func (f *fakeRuns) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// runCallers is every kind of caller the run rule tells apart, each with a real token.
type runCallers struct {
	e    *env
	runs *fakeRuns
	ids  map[string]string // by who
	toks map[string]string
}

const testRun = "r_testrun1"

// newRunCallers makes the chats of a run: its orchestrator, a task agent, a merge agent and a
// person's chat on it, each with a subagent, beside the env's board chat and a plain chat.
//
// The chat manager of this checkout has no way yet to make a chat on a run (CreateOnRun and
// CreateOwned are built at the same time as this file), so the chats are made as plain ones and
// given their run and role in chat.json, and the manager is loaded again.
func newRunCallers(t *testing.T) *runCallers {
	t.Helper()
	e := newEnv(t)
	rc := &runCallers{e: e, runs: &fakeRuns{}, ids: map[string]string{"board chat": e.chat}, toks: map[string]string{}}
	roles := map[string]model.AgentRole{"orchestrator": model.RoleOrchestrator, "task agent": model.RoleTask, "merge agent": model.RoleMerge, "chat on the run": ""}
	m := e.relay.Chats
	for who, role := range roles {
		v, err := m.Create(model.Claude, model.Ungrouped, "")
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(m.Store.P.ChatDir(v.ID), "chat.json")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var meta model.ChatMeta
		if err := json.Unmarshal(raw, &meta); err != nil {
			t.Fatal(err)
		}
		meta.Run, meta.Role, meta.Group = testRun, role, ""
		if err := store.WriteJSONAtomic(path, meta, 0o600); err != nil {
			t.Fatal(err)
		}
		rc.ids[who] = v.ID
	}
	rc.ids["plain chat"], _ = e.createPlain()
	nm := chats.New(chats.Deps{Store: m.Store, Bridge: e.relay.Bridge, Boards: e.relay.Boards, DefaultCwd: m.DefaultCwd, MCPURL: m.MCPURL, Spawners: m.Spawners})
	if err := nm.Load(); err != nil {
		t.Fatal(err)
	}
	e.relay.Chats, e.relay.Runs = nm, rc.runs
	for who, id := range rc.ids {
		rc.toks[who] = e.chatToken(id)
		if _, err := nm.SpawnSubagent(id, chats.SpawnSubRequest{Prompt: "help"}); err != nil {
			t.Fatalf("subagent of the %s: %v", who, err)
		}
		rc.toks["subagent of the "+who] = e.claude.last(t).opts.MCP.Token
	}
	for who, tok := range rc.toks {
		caller, ok := nm.ResolveToken(tok)
		if !ok || caller.Subagent != strings.HasPrefix(who, "subagent") {
			t.Fatalf("the token of the %s resolves to %+v %v", who, caller, ok)
		}
		if on := who != "board chat" && who != "plain chat" && !strings.HasSuffix(who, "the board chat") && !strings.HasSuffix(who, "the plain chat"); (caller.Meta.Run == testRun) != on {
			t.Fatalf("the %s is on run %q", who, caller.Meta.Run)
		}
	}
	return rc
}

var (
	runWho  = []string{"orchestrator", "task agent", "merge agent", "chat on the run"}
	spawnNm = namesOf(boardtools.SpawnFamily)
)

func TestRunToolsListPerCaller(t *testing.T) {
	rc := newRunCallers(t)
	e := rc.e
	board := append(namesOf(boardtools.Tools), spawnNm...)
	want := map[string][]string{
		"orchestrator":    namesOf(boardtools.OrchestratorTools()),
		"task agent":      spawnNm,
		"merge agent":     spawnNm,
		"chat on the run": append(namesOf(boardtools.RunChatTools()), spawnNm...),
		"board chat":      board,
		"plain chat":      spawnNm,
		// A subagent of anything in a run gets nothing; outside a run it is as it always was.
		"subagent of the orchestrator":    {},
		"subagent of the task agent":      {},
		"subagent of the merge agent":     {},
		"subagent of the chat on the run": {},
		"subagent of the board chat":      namesOf(boardtools.Tools),
		"subagent of the plain chat":      {},
	}
	if len(want) != len(rc.toks) {
		t.Fatalf("%d callers, %d expectations", len(rc.toks), len(want))
	}
	for who, names := range want {
		if got := e.listNames(rc.toks[who]); !joinEq(got, names) {
			t.Errorf("the %s is listed %v, want %v", who, got, names)
		}
	}
	// The complete lists by name, for every kind of caller the contract tells apart.
	const (
		orchDeclared = "get_run get_task get_agent get_notes set_notes edit_notes add_task update_task cancel_task retry_task wait_for finish_run"
		orchEach     = "get_run get_task get_agent get_notes set_notes edit_notes add_task update_task cancel_task retry_task finish_run"
		runChat      = "get_run get_task get_agent get_notes add_task update_task cancel_task retry_task tell_orchestrator spawn_subagent stop_subagent list_subagent_models"
		spawn        = "spawn_subagent stop_subagent list_subagent_models"
	)
	listed := func(who string) string { return strings.Join(e.listNames(rc.toks[who]), " ") }
	check := func(mode string, exact map[string]string) {
		t.Helper()
		for who, names := range exact {
			if got := listed(who); got != names {
				t.Errorf("wake mode %s: the %s is listed\n     %s\nwant %s", mode, who, got, names)
			}
		}
	}
	rest := map[string]string{"chat on the run": runChat, "task agent": spawn, "merge agent": spawn, "subagent of the task agent": "",
		"subagent of the merge agent": "", "subagent of the orchestrator": "", "subagent of the chat on the run": "", "plain chat": spawn}
	check("declared", map[string]string{"orchestrator": orchDeclared})
	check("declared", rest)
	// A run in another wake mode: its orchestrator has no wait_for, and nobody else's list changes.
	rc.runs.mu.Lock()
	rc.runs.each = true
	rc.runs.mu.Unlock()
	check("each", map[string]string{"orchestrator": orchEach})
	check("each", rest)
	// No board tool for anything in a run, whatever the run service answers.
	rc.runs.greedy = true
	for _, who := range runWho {
		for _, name := range e.listNames(rc.toks[who]) {
			if boardtools.IsTool(name) {
				t.Fatalf("the %s is listed the board tool %s", who, name)
			}
		}
		if got := e.listNames(rc.toks["subagent of the "+who]); len(got) != 0 {
			t.Fatalf("the subagent of the %s is listed %v", who, got)
		}
	}
	if got := e.listNames(rc.toks["task agent"]); !joinEq(got, spawnNm) {
		t.Fatalf("a task agent with a greedy run service is listed %v", got)
	}
	rc.runs.greedy = false
	// The schemas are the run tools' own.
	for _, tl := range e.listSchemas(rc.toks["orchestrator"]) {
		if tl["name"] == "add_task" {
			schema := tl["inputSchema"].(map[string]any)
			if req := fmt.Sprint(schema["required"]); req != "[title brief kind writes tier tier_reason]" {
				t.Fatalf("add_task requires %s", req)
			}
		}
	}
	// Without a run service a chat on a run has no run tool, and still no board tool.
	e.relay.Runs = nil
	if got := e.listNames(rc.toks["orchestrator"]); len(got) != 0 {
		t.Fatalf("the orchestrator without a run service: %v", got)
	}
	if got := e.listNames(rc.toks["chat on the run"]); !joinEq(got, spawnNm) {
		t.Fatalf("a chat on a run without a run service: %v", got)
	}
	// An archived chat on a run is listed nothing, like any archived chat.
	e.relay.Runs = rc.runs
	if err := e.relay.Chats.SetArchive(rc.ids["chat on the run"], model.Archive{Archived: true, Op: "op1"}); err != nil {
		t.Fatal(err)
	}
	if got := e.listNames(rc.toks["chat on the run"]); len(got) != 0 {
		t.Fatalf("an archived chat on a run: %v", got)
	}
	if text, isErr, _ := e.toolsCall(rc.toks["chat on the run"], "get_run", `{}`); !isErr || text != "this chat is archived" {
		t.Fatalf("get_run of an archived chat: %q", text)
	}
}

// probeArgs are arguments with which a tool that is let through answers something of its own,
// without starting anything.
func probeArgs(name string) string {
	switch name {
	case "stop_subagent":
		return `{"sid":"no-such-subagent"}`
	case "spawn_subagent":
		return `{}` // "prompt is required": it got as far as its own check
	}
	return `{}`
}

func TestRunToolsDispatchPerCaller(t *testing.T) {
	rc := newRunCallers(t)
	e := rc.e
	var all []string
	for _, list := range [][]boardtools.Tool{boardtools.Tools, boardtools.SpawnFamily, boardtools.RunTools} {
		all = append(all, namesOf(list)...)
	}
	refusedText := func(text, name string) bool {
		return text == name+" is not available on this chat" || text == name+" is not available to this agent" || text == name+" is not available to subagents" ||
			text == "the run service refuses "+name
	}

	// Dispatch agrees with the list, tool by tool, for every caller: what is listed is let
	// through, and what is not listed is refused. This is the access control: the adapters only
	// allow what is listed, so a listed tool can be called unasked.
	for who, tok := range rc.toks {
		listed := map[string]bool{}
		for _, name := range e.listNames(tok) {
			listed[name] = true
		}
		for _, name := range all {
			text, isErr, status := e.toolsCall(tok, name, probeArgs(name))
			if status != 200 {
				t.Fatalf("the %s calls %s: status %d", who, name, status)
			}
			if refused := isErr && refusedText(text, name); refused == listed[name] {
				t.Errorf("the %s: %s is listed %v, and the call answered %q", who, name, listed[name], text)
			}
		}
		if text, isErr, _ := e.toolsCall(tok, "rm_rf", `{}`); !isErr || text != "unknown tool rm_rf" {
			t.Errorf("the %s calls a tool that is none: %q", who, text)
		}
	}

	// The refusal texts, per kind of caller and kind of tool.
	type row struct{ who, tool, want string }
	for _, c := range []row{
		{"orchestrator", "spawn_subagent", "spawn_subagent is not available to this agent"},
		{"orchestrator", "stop_subagent", "stop_subagent is not available to this agent"},
		{"orchestrator", "list_subagent_models", "list_subagent_models is not available to this agent"},
		{"orchestrator", "list_boards", "list_boards is not available on this chat"},
		{"orchestrator", "apply", "apply is not available on this chat"},
		{"task agent", "get_run", "get_run is not available to this agent"},
		{"task agent", "add_task", "add_task is not available to this agent"},
		{"task agent", "finish_run", "finish_run is not available to this agent"},
		{"task agent", "read_board", "read_board is not available on this chat"},
		{"merge agent", "get_task", "get_task is not available to this agent"},
		{"merge agent", "set_notes", "set_notes is not available to this agent"},
		{"merge agent", "list_boards", "list_boards is not available on this chat"},
		{"chat on the run", "list_boards", "list_boards is not available on this chat"},
		{"subagent of the orchestrator", "get_run", "get_run is not available to subagents"},
		{"subagent of the orchestrator", "finish_run", "finish_run is not available to subagents"},
		{"subagent of the task agent", "spawn_subagent", "spawn_subagent is not available to subagents"},
		{"subagent of the task agent", "get_run", "get_run is not available to subagents"},
		{"subagent of the merge agent", "list_boards", "list_boards is not available to subagents"},
		{"subagent of the chat on the run", "add_task", "add_task is not available to subagents"},
		{"subagent of the chat on the run", "tell_orchestrator", "tell_orchestrator is not available to subagents"},
		{"subagent of the chat on the run", "read_board", "read_board is not available to subagents"},
		{"board chat", "get_run", "get_run is not available on this chat"},
		{"board chat", "add_task", "add_task is not available on this chat"},
		{"plain chat", "finish_run", "finish_run is not available on this chat"},
		{"plain chat", "tell_orchestrator", "tell_orchestrator is not available on this chat"},
		{"subagent of the board chat", "get_run", "get_run is not available to subagents"},
		{"subagent of the plain chat", "set_notes", "set_notes is not available to subagents"},
	} {
		if text, isErr, _ := e.toolsCall(rc.toks[c.who], c.tool, probeArgs(c.tool)); !isErr || text != c.want {
			t.Errorf("the %s calls %s: %q, want %q", c.who, c.tool, text, c.want)
		}
	}

	// Only the orchestrator and a person's chat ever reached the run service, each with all
	// thirteen run tools: those a caller may not use are refused by the service itself, which has
	// a sentence for each.
	seen := map[string]int{}
	for _, call := range rc.runs.called() {
		switch {
		case strings.Contains(call, "run="+testRun+" chat="+rc.ids["orchestrator"]+" role=orchestrator sub=false"):
			seen["orchestrator"]++
		case strings.Contains(call, "run="+testRun+" chat="+rc.ids["chat on the run"]+" role= sub=false"):
			seen["chat"]++
		default:
			t.Fatalf("the run service was called by someone else: %s", call)
		}
	}
	if seen["orchestrator"] != 13 || seen["chat"] != 13 {
		t.Fatalf("calls that reached the run service: %v", seen)
	}

	// A call is handed on as it came, and its answer goes back as it is.
	before := len(rc.runs.called())
	text, isErr, _ := e.toolsCall(rc.toks["orchestrator"], "add_task", `{"title":"Read","writes":false}`)
	calls := rc.runs.called()
	if isErr || text != "ran add_task" || len(calls) != before+1 || !strings.HasSuffix(calls[before], `args={"title":"Read","writes":false}`) {
		t.Fatalf("the orchestrator's add_task: %q; the service saw %v", text, calls[before:])
	}
	// Spawning works for the three that are listed it.
	for _, who := range []string{"task agent", "merge agent", "chat on the run"} {
		if text, isErr, _ := e.toolsCall(rc.toks[who], "spawn_subagent", `{"prompt":"look into it"}`); isErr || !strings.HasPrefix(text, "spawned subagent ") {
			t.Fatalf("the %s spawns: %q", who, text)
		}
		if text, isErr, _ := e.toolsCall(rc.toks[who], "list_subagent_models", `{}`); isErr || !strings.Contains(text, "model") {
			t.Fatalf("the %s lists models: %q", who, text)
		}
	}
	// Without a run service a chat on a run is refused every run tool.
	e.relay.Runs = nil
	for _, who := range []string{"orchestrator", "chat on the run"} {
		if text, isErr, _ := e.toolsCall(rc.toks[who], "get_run", `{}`); !isErr || text != "get_run is not available on this chat" {
			t.Fatalf("the %s without a run service: %q", who, text)
		}
	}
}

// A run makes a chat per agent: those are not kept in the contact table, which is for the chats
// people have. A person's chat on a run is.
func TestRunAgentsAreNotContacts(t *testing.T) {
	rc := newRunCallers(t)
	e := rc.e
	for _, who := range []string{"orchestrator", "task agent", "merge agent", "chat on the run", "plain chat"} {
		e.mcp(rc.toks[who], `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"claude-code","version":"2"}}}`)
		e.toolsCall(rc.toks[who], "get_run", `{}`)
	}
	var got []string
	for _, c := range e.relay.Contacts.Snapshot() {
		got = append(got, c.Chat)
	}
	want := map[string]bool{short(rc.ids["chat on the run"]): true, short(rc.ids["plain chat"]): true}
	if len(got) != 2 || !want[got[0]] || !want[got[1]] || got[0] == got[1] {
		t.Fatalf("contacts: %v", got)
	}
}
