package cursor

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/version"
)

const (
	boardToken = "0123456789abcdef0123456789abcdef"
)

// mcpRawInput is the rawInput of a real Cursor board MCP tool call. Captured from a live
// board round-trip on 2026-10-02 with cursor-agent 2026.10.01-e373342: the first session/update
// is a tool_call titled "MCP: tool", kind "other", status pending and rawInput {}; a following
// tool_call_update adds the title "<server>: <tool>" and the rawInput below. This differs from
// the earlier bundle inference (which expected the provider/tool in the first tool_call).
func mcpRawInput(server, tool string, args map[string]any) map[string]any {
	return map[string]any{"providerIdentifier": server, "toolName": tool, "args": args}
}

func step(kind string, v any) fakeStep {
	b := mustMarshal(v)
	switch kind {
	case "result":
		return fakeStep{Result: b}
	case "update":
		return fakeStep{Update: b}
	case "request":
		return fakeStep{Request: b}
	}
	panic(kind)
}

// baseScript leaves the handshake to the stateful fake Cursor (fakeCursor).
func baseScript() fakeScript {
	return fakeScript{}
}

type env struct {
	home, cwd, record string
	fake              *fakeAgent
	s                 *Spawner
}

// newEnv sets up a fake agent and a Spawner that starts it. Nothing of it is in the test
// process's environment (CURSOR_CONFIG_DIR is empty for every test, see TestMain), so a test that
// uses it can run in parallel with others.
func newEnv(t *testing.T, script fakeScript) *env {
	t.Helper()
	home := t.TempDir()
	cwd := t.TempDir()
	f := fake(t, script)
	return &env{home: home, cwd: cwd, record: f.record, fake: f, s: &Spawner{
		Bin:     f.bin,
		AppRoot: filepath.Join(home, ".ai-whiteboard"),
		Home:    home,
	}}
}

func (e *env) spawn(t *testing.T, o agent.SpawnOptions) agent.Agent {
	t.Helper()
	o.Cwd = e.cwd
	a, err := e.s.Spawn(o)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	t.Cleanup(func() {
		a.Close()
		for range a.Events() {
		}
	})
	return a
}

// until collects events until one satisfies stop (included), failing after a timeout.
func until(t *testing.T, a agent.Agent, stop func(agent.Event) bool) []agent.Event {
	t.Helper()
	var got []agent.Event
	timeout := time.After(mustHappen)
	for {
		select {
		case e, ok := <-a.Events():
			if !ok {
				t.Fatalf("events closed; got %s", kinds(got))
			}
			got = append(got, e)
			if stop(e) {
				return got
			}
		case <-timeout:
			t.Fatalf("timed out; got %s", kinds(got))
		}
	}
}

func isKind(k agent.EventKind) func(agent.Event) bool {
	return func(e agent.Event) bool { return e.Kind == k }
}

var kindNames = map[agent.EventKind]string{
	agent.EvSession: "Session", agent.EvCatalog: "Catalog", agent.EvThinking: "Thinking",
	agent.EvTextStart: "TextStart", agent.EvTextDelta: "TextDelta", agent.EvText: "Text",
	agent.EvToolStart: "ToolStart", agent.EvToolInputDelta: "ToolInputDelta", agent.EvToolInput: "ToolInput",
	agent.EvToolResult: "ToolResult", agent.EvToolDenied: "ToolDenied", agent.EvPermRequest: "PermRequest",
	agent.EvUsage: "Usage", agent.EvTurnEnd: "TurnEnd", agent.EvExit: "Exit", agent.EvSub: "Sub",
}

func kinds(es []agent.Event) string {
	var s []string
	for _, e := range es {
		s = append(s, kindNames[e.Kind])
	}
	return strings.Join(s, ",")
}

// without drops events of the given kinds.
func without(es []agent.Event, ks ...agent.EventKind) []agent.Event {
	var out []agent.Event
	for _, e := range es {
		keep := true
		for _, k := range ks {
			if e.Kind == k {
				keep = false
			}
		}
		if keep {
			out = append(out, e)
		}
	}
	return out
}

func send(t *testing.T, a agent.Agent, text string) {
	t.Helper()
	if err := a.Send([]agent.ContentBlock{{Text: text}}); err != nil {
		t.Fatalf("Send: %v", err)
	}
}

func jsonEq(t *testing.T, got json.RawMessage, want string) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("bad JSON %s: %v", got, err)
	}
	json.Unmarshal([]byte(want), &w)
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("got %s, want %s", got, want)
	}
}

// seed writes the fake Cursor's shared config (as another process would have left it).
func (e *env) seed(t *testing.T, cfg fakeConfig) {
	t.Helper()
	b, _ := json.Marshal(cfg)
	if err := os.WriteFile(e.fake.vars["FAKE_ACP_STATE"], b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// sharedConfig reads the fake Cursor's shared config.
func (e *env) sharedConfig(t *testing.T) fakeConfig {
	t.Helper()
	var cfg fakeConfig
	if b, err := os.ReadFile(e.fake.vars["FAKE_ACP_STATE"]); err == nil {
		json.Unmarshal(b, &cfg)
	}
	return cfg
}

// sets lists the session/set_config_option calls as "configId=value", in order.
func sets(rs []recorded) []string {
	var out []string
	for _, r := range rs {
		if r.Method != "session/set_config_option" {
			continue
		}
		var p struct {
			ConfigID string `json:"configId"`
			Value    string `json:"value"`
		}
		json.Unmarshal(r.Params, &p)
		out = append(out, p.ConfigID+"="+p.Value)
	}
	return out
}

// onlyHandshakeMethods fails when a method other than the handshake's (or extra) was sent: the
// model is only ever set with session/set_config_option.
func onlyHandshakeMethods(t *testing.T, rs []recorded, extra ...string) {
	t.Helper()
	ok := map[string]bool{"initialize": true, "authenticate": true, "session/new": true,
		"cursor/list_available_models": true, "session/set_config_option": true}
	for _, m := range extra {
		ok[m] = true
	}
	for _, m := range methods(rs) {
		if !ok[m] {
			t.Fatalf("unexpected method %s in %v", m, methods(rs))
		}
	}
}

const ctxReadMethod = "<context read>"

// recordCtxReads makes every context meter read show up in the record as ctxReadMethod: the store
// exists, and the sqlite3 binary is a fake that records its call and fails. The fake is a link to
// the test binary, as fakeCost is (cost_test.go), not a script: on a loaded machine the first run
// of a newly written script took longer than sqliteTimeout, the read before the first prompt was
// given up, and the record had the prompt without it.
func (e *env) recordCtxReads(t *testing.T) {
	t.Helper()
	db := StorePath(e.home, testSessionID)
	if err := os.MkdirAll(filepath.Dir(db), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(db, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "sqlite3")
	if err := os.Symlink(self, bin); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(map[string]string{"FAKE_SQLITE_RECORD": e.record})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, fakeEnvFile), b, 0o644); err != nil {
		t.Fatal(err)
	}
	e.s.SQLite = bin
}

// runFakeSQLite is the test binary as the sqlite3 of recordCtxReads (FAKE_SQLITE_RECORD is set):
// it appends one line with ctxReadMethod to that record, in one write, and fails.
func runFakeSQLite(record string) {
	if f, err := os.OpenFile(record, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		f.WriteString(`{"method":"` + ctxReadMethod + `"}` + "\n")
		f.Close()
	}
	os.Exit(1)
}

func TestHandshakeNewSession(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{ChatID: "c1", Model: "claude-sonnet-5", Effort: "low"})

	evs := until(t, a, isKind(agent.EvCatalog))
	if evs[0].Kind != agent.EvSession || evs[0].SessionID != testSessionID {
		t.Fatalf("first event %+v, want EvSession %s", evs[0], testSessionID)
	}
	want := ParseModelList(fakeModels)
	want.Default = model.ModelChoice{Model: "gpt-5.4-mini", Effort: "medium"} // session/new's model
	if c := evs[len(evs)-1].Catalog; !reflect.DeepEqual(c, want) {
		t.Fatalf("catalog %+v, want %+v", c, want)
	}
	send(t, a, "hi")
	until(t, a, isKind(agent.EvTurnEnd))

	rs := readRecord(t, e.record)
	wantM := []string{"initialize", "authenticate", "session/new", "cursor/list_available_models",
		"session/set_config_option", "session/set_config_option", "session/set_config_option", "session/set_config_option",
		"session/prompt"}
	if got := methods(rs); !reflect.DeepEqual(got, wantM) {
		t.Fatalf("methods %v, want %v", got, wantM)
	}
	init, _ := find(rs, "initialize")
	jsonEq(t, init.Params, `{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"_meta":{"parameterizedModelPicker":true,"subagents":true}},"clientInfo":{"name":"ai-whiteboard","version":"`+version.Version+`"}}`)
	auth, _ := find(rs, "authenticate")
	jsonEq(t, auth.Params, `{"methodId":"cursor_login"}`)
	nw, _ := find(rs, "session/new")
	jsonEq(t, nw.Params, `{"cwd":`+string(mustMarshal(e.cwd))+`,"mcpServers":[]}`)
	set, _ := find(rs, "session/set_config_option")
	jsonEq(t, set.Params, `{"sessionId":"`+testSessionID+`","configId":"model","value":"claude-sonnet-5"}`)
	if got := sets(rs); !reflect.DeepEqual(got, []string{"model=claude-sonnet-5", "thinking=true", "context=1m", "effort=low"}) {
		t.Fatalf("sets %v", got)
	}
	pr, _ := find(rs, "session/prompt")
	jsonEq(t, pr.Params, `{"sessionId":"`+testSessionID+`","prompt":[{"type":"text","text":"hi"}]}`)
}

// The policy for each option shape: thinking → true, context → largest, the thought_level option
// (whatever its id) → the chat's effort or the model's list default; fast / optimize_for never.
func TestApplyChoice(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name, model, effort string
		seed                map[string]map[string]string // last-used params left by another process
		want                []string
	}{
		{"effort", "claude-opus-5-5", "max", nil, []string{"model=claude-opus-5-5", "context=1m", "effort=max"}},
		{"reasoning with context listed largest first", "gpt-5.4", "extra-high", nil, []string{"model=gpt-5.4", "context=1m", "reasoning=extra-high"}},
		{"reasoning_effort", "grok-4.7", "low", nil, []string{"model=grok-4.7", "reasoning_effort=low"}},
		{"reasoning without context", "gpt-5.4-mini", "none", nil, []string{"model=gpt-5.4-mini", "reasoning=none"}},
		{"thinking only", "claude-haiku-4-5", "high", nil, []string{"model=claude-haiku-4-5", "thinking=true"}},
		{"no options", "gemini-3.1-pro", "", nil, []string{"model=gemini-3.1-pro"}},
		{"optimize_for untouched", "auto-smart", "", nil, []string{"model=auto-smart"}},
		{"thinking set although last-used false", "claude-sonnet-5", "medium",
			map[string]map[string]string{"claude-sonnet-5": {"thinking": "false", "context": "1m", "effort": "medium"}},
			[]string{"model=claude-sonnet-5", "thinking=true", "context=1m", "effort=medium"}},
		{"unknown effort falls back to the list default", "gpt-5.4-mini", "max",
			map[string]map[string]string{"gpt-5.4-mini": {"reasoning": "high"}},
			[]string{"model=gpt-5.4-mini", "reasoning=medium"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, baseScript())
			if tc.seed != nil {
				e.seed(t, fakeConfig{SelectedModel: "gpt-5.4-mini", ModelParameters: tc.seed})
			}
			a := e.spawn(t, agent.SpawnOptions{Model: tc.model, Effort: tc.effort})
			send(t, a, "hi")
			until(t, a, isKind(agent.EvTurnEnd))
			rs := readRecord(t, e.record)
			if got := sets(rs); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("sets %v, want %v", got, tc.want)
			}
			onlyHandshakeMethods(t, rs, "session/prompt")
			if cfg := e.sharedConfig(t); cfg.SelectedModel != tc.model {
				t.Fatalf("selected model %q", cfg.SelectedModel)
			}
		})
	}
}

func TestEmptyModelUsesReportedModel(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	e.seed(t, fakeConfig{SelectedModel: "claude-opus-5-5",
		ModelParameters: map[string]map[string]string{"claude-opus-5-5": {"context": "300k", "effort": "max"}}})
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "hi")
	until(t, a, isKind(agent.EvTurnEnd))
	if got := sets(readRecord(t, e.record)); !reflect.DeepEqual(got, []string{"model=claude-opus-5-5", "context=1m", "effort=medium"}) {
		t.Fatalf("sets %v", got)
	}
}

func TestPolicyErrorFailsSend(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		script fakeScript
		model  string
		want   string
	}{
		{"list_available_models", fakeScript{"cursor/list_available_models": {{Error: raw(`{"code":-32603,"message":"list broke"}`)}}}, "gpt-5.4", "list broke"},
		{"set_config_option", baseScript(), "no-such-model", "Invalid value for model: no-such-model"},
		{"set_config_option scripted error", fakeScript{"session/set_config_option": {{Error: raw(`{"code":-32602,"message":"Invalid params"}`)}}}, "gpt-5.4", "Invalid params"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, tc.script)
			a := e.spawn(t, agent.SpawnOptions{Model: tc.model, Effort: "low"})
			err := a.Send([]agent.ContentBlock{{Text: "hi"}})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Send error %v, want %q", err, tc.want)
			}
			a.Close()
			rs := readRecord(t, e.record)
			onlyHandshakeMethods(t, rs) // no prompt, and no other way to set the model
		})
	}
}

// Without the flag the fake is the old agent: the model option lists pre-built variants and a bare
// id is rejected, so the policy only works because initialize carries the flag.
func TestFakeWithoutFlagRejectsBareModel(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	conn, err := Start(e.s.bin(), []string{"acp"}, e.cwd)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Call("initialize", map[string]any{"protocolVersion": 1}); err != nil {
		t.Fatal(err)
	}
	res, err := conn.Call("session/new", map[string]any{"cwd": e.cwd, "mcpServers": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	var r sessionResult
	json.Unmarshal(res, &r)
	if got := reportedModel(res); got != "gpt-5.4-mini[reasoning=medium]" {
		t.Fatalf("reported model %q", got)
	}
	for _, o := range r.ConfigOptions {
		if o.ID != "mode" && o.ID != "model" {
			t.Fatalf("per-parameter option %q without the flag", o.ID)
		}
	}
	if _, err := conn.Call("session/set_config_option", map[string]any{"sessionId": testSessionID, "configId": "model", "value": "gpt-5.4"}); err == nil {
		t.Fatal("bare model id accepted without the flag")
	}
	if _, err := conn.Call("session/set_config_option", map[string]any{"sessionId": testSessionID, "configId": "reasoning", "value": "low"}); err == nil {
		t.Fatal("effort option accepted without the flag")
	}
}

func TestHandshakeErrorFailsSend(t *testing.T) {
	t.Parallel()
	e := newEnv(t, fakeScript{"authenticate": {{Error: raw(`{"code":-32000,"message":"Not logged in"}`)}}})
	a := e.spawn(t, agent.SpawnOptions{})
	err := a.Send([]agent.ContentBlock{{Text: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "Not logged in") {
		t.Fatalf("Send error %v", err)
	}
}

func TestSpawnMissingFolder(t *testing.T) {
	t.Parallel()
	s := &Spawner{Bin: os.Args[0]}
	if _, err := s.Spawn(agent.SpawnOptions{Cwd: filepath.Join(t.TempDir(), "gone")}); err != agent.ErrFolderMissing {
		t.Fatalf("got %v, want ErrFolderMissing", err)
	}
}

// Resume after another process changed the shared params: load reports the wrong model, the full
// policy is re-applied from the chat's own settings before the first prompt, and the meter is read
// after it. The history replay is dropped.
func TestResumeReappliesPolicy(t *testing.T) {
	e := newEnv(t, fakeScript{
		"session/load": {
			step("update", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "old"}}),
			step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "t0", "title": "`ls`", "kind": "execute", "status": "completed", "rawInput": map[string]any{"command": "ls"}}),
			step("update", map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"type": "text", "text": "hm"}}),
			{Cursor: true},
		},
		"session/prompt": {
			step("update", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "new"}}),
			{Result: raw(`{"stopReason":"end_turn"}`)},
		},
	})
	e.recordCtxReads(t)
	e.seed(t, fakeConfig{SelectedModel: "gpt-5.4-mini", ModelParameters: map[string]map[string]string{
		"claude-sonnet-5": {"thinking": "false", "context": "300k", "effort": "max"},
	}})
	a := e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true, Model: "claude-sonnet-5", Effort: "low"})

	first := until(t, a, isKind(agent.EvUsage))
	if kinds(first) != "Catalog,Usage" {
		t.Fatalf("events after load %s", kinds(first))
	}
	// No remembered catalog: the first model in the list, with its default effort.
	if d := first[0].Catalog.Default; d != (model.ModelChoice{Model: "claude-opus-5-5", Effort: "medium"}) {
		t.Fatalf("resume catalog default %+v", d)
	}
	send(t, a, "hi")
	evs := without(until(t, a, isKind(agent.EvTurnEnd)), agent.EvUsage)
	if got := kinds(evs); got != "Thinking,TextStart,TextDelta,TurnEnd" {
		t.Fatalf("events %s", got)
	}
	if evs[2].Text != "new" {
		t.Fatalf("text %q", evs[2].Text)
	}

	rs := readRecord(t, e.record)
	got := methods(rs)
	want := []string{"initialize", "authenticate", "session/load", "cursor/list_available_models",
		"session/set_config_option", "session/set_config_option", "session/set_config_option", "session/set_config_option",
		ctxReadMethod, "session/prompt"}
	if len(got) < len(want) || !reflect.DeepEqual(got[:len(want)], want) {
		t.Fatalf("methods %v, want prefix %v", got, want)
	}
	if got := sets(rs); !reflect.DeepEqual(got, []string{"model=claude-sonnet-5", "thinking=true", "context=1m", "effort=low"}) {
		t.Fatalf("sets %v", got)
	}
	ld, _ := find(rs, "session/load")
	jsonEq(t, ld.Params, `{"sessionId":"`+testSessionID+`","cwd":`+string(mustMarshal(e.cwd))+`,"mcpServers":[]}`)
	cfg := e.sharedConfig(t)
	if cfg.SelectedModel != "claude-sonnet-5" || !reflect.DeepEqual(cfg.ModelParameters["claude-sonnet-5"],
		map[string]string{"thinking": "true", "context": "1m", "effort": "low"}) {
		t.Fatalf("shared config after resume %+v", cfg)
	}
}

// On resume the catalog Default is the last remembered one when its model is still listed, never
// what session/load reports; otherwise the first model in the list.
func TestResumeCatalogDefault(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	if _, err := e.s.Catalog(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	e.seed(t, fakeConfig{SelectedModel: "grok-4.7"})
	a := e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true, Model: "gpt-5.4"})
	evs := until(t, a, isKind(agent.EvCatalog))
	if d := evs[len(evs)-1].Catalog.Default; d != (model.ModelChoice{Model: "gpt-5.4-mini", Effort: "medium"}) {
		t.Fatalf("default %+v, want the probe's", d)
	}

	e.s.remember(&model.Catalog{Default: model.ModelChoice{Model: "gone"}})
	b := e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true, Model: "gpt-5.4"})
	evs = until(t, b, isKind(agent.EvCatalog))
	if d := evs[len(evs)-1].Catalog.Default; d != (model.ModelChoice{Model: "claude-opus-5-5", Effort: "medium"}) {
		t.Fatalf("default %+v, want the first model", d)
	}
}

func TestTextItemsBetweenToolCalls(t *testing.T) {
	t.Parallel()
	s := baseScript()
	chunk := func(text string) fakeStep {
		return step("update", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": text}})
	}
	s["session/prompt"] = []fakeStep{
		step("update", map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"type": "text", "text": "hm"}}),
		chunk("Hel"), chunk("lo"),
		step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "`ls -la`", "kind": "execute", "status": "pending", "rawInput": map[string]any{"command": "ls -la"}}),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "in_progress"}),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "rawOutput": map[string]any{"exitCode": 2, "stdout": "out", "stderr": "err"}}),
		step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Read File", "kind": "read", "status": "completed", "locations": []any{map[string]any{"path": "/x/a.go"}},
			"content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "package a"}}}}),
		step("update", map[string]any{"sessionUpdate": "session_info_update", "title": "ignored"}),
		chunk("Done"), chunk("."),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "hi")
	evs := without(until(t, a, isKind(agent.EvTurnEnd)), agent.EvUsage, agent.EvSession, agent.EvCatalog)

	want := "Thinking,Thinking,TextStart,TextDelta,TextDelta,ToolStart,ToolResult,ToolStart,ToolResult,TextStart,TextDelta,TextDelta,TurnEnd"
	if got := kinds(evs); got != want {
		t.Fatalf("events\n got %s\nwant %s", got, want)
	}
	if evs[2].MsgID != "c1" || evs[9].MsgID != "c2" || evs[3].Text != "Hel" || evs[4].Text != "lo" {
		t.Fatalf("text events %+v %+v", evs[2], evs[9])
	}
	if evs[5].ToolName != "Bash" || evs[5].ToolID != "t1" {
		t.Fatalf("tool start %+v", evs[5])
	}
	jsonEq(t, evs[5].Input, `{"command":"ls -la"}`)
	if r := evs[6]; r.Result != "out\nerr" || !r.IsError {
		t.Fatalf("tool result %+v", r)
	}
	if evs[7].ToolName != "Read" {
		t.Fatalf("read tool %+v", evs[7])
	}
	jsonEq(t, evs[7].Input, `{"file_path":"/x/a.go"}`)
	if r := evs[8]; r.Result != "package a" || r.IsError {
		t.Fatalf("read result %+v", r)
	}
	if end := evs[len(evs)-1]; end.Aborted || end.Error != "" {
		t.Fatalf("turn end %+v", end)
	}
}

func TestBoardMCPToolCall(t *testing.T) {
	t.Parallel()
	mcpCall := func(id string) map[string]any {
		return map[string]any{"sessionUpdate": "tool_call", "toolCallId": id, "title": "MCP: tool", "kind": "other", "status": "pending", "rawInput": map[string]any{}}
	}
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("update", mcpCall("b1")),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "b1", "title": "board: read_board",
			"rawInput": mcpRawInput("board", "read_board", map[string]any{"board": "b1"})}),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "b1", "status": "completed", "rawOutput": map[string]any{"success": true}}),
		step("update", mcpCall("b2")),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "b2", "title": "board: apply",
			"rawInput": mcpRawInput("board", "apply", map[string]any{"board": "b1", "create": []any{map[string]any{"type": "rectangle"}}})}),
		step("update", mcpCall("b3")),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "b3", "title": "other: thing",
			"rawInput": mcpRawInput("other", "thing", map[string]any{})}),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}, BoardID: "board"})
	send(t, a, "draw")
	evs := without(until(t, a, isKind(agent.EvTurnEnd)), agent.EvUsage, agent.EvSession, agent.EvCatalog, agent.EvThinking)

	var inputs, results []agent.Event
	for _, ev := range evs {
		switch ev.Kind {
		case agent.EvToolInput:
			inputs = append(inputs, ev)
		case agent.EvToolResult:
			results = append(results, ev)
		}
	}
	if len(inputs) != 3 {
		t.Fatalf("tool input events %s", kinds(evs))
	}
	if inputs[0].ToolName != "mcp__board__read_board" {
		t.Fatalf("read_board tool name %q", inputs[0].ToolName)
	}
	jsonEq(t, inputs[0].Input, `{"board":"b1"}`)
	if inputs[1].ToolName != "mcp__board__apply" {
		t.Fatalf("apply tool name %q", inputs[1].ToolName)
	}
	jsonEq(t, inputs[1].Input, `{"board":"b1","create":[{"type":"rectangle"}]}`)
	// A non-board MCP call keeps its normal presentation.
	if inputs[2].ToolName != "other: thing" {
		t.Fatalf("non-board MCP tool name %q", inputs[2].ToolName)
	}
	jsonEq(t, inputs[2].Input, `{"providerIdentifier":"other","toolName":"thing","args":{}}`)
	// The captured completed update carries rawOutput {"success":true} and no text: no error.
	if len(results) != 1 || results[0].ToolID != "b1" || results[0].IsError || results[0].Result != "" {
		t.Fatalf("tool results %+v", results)
	}
}

// TestBoardMCPSessionHandshake pins the session/new and session/load mcpServers payload for a
// board chat: HTTP type, the exact fixed URL and the chat's board token in an Authorization
// bearer header. The shape matches the live capture (experiment A.1 and the P3 trace).
func TestBoardMCPSessionHandshake(t *testing.T) {
	t.Parallel()
	mcp := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}

	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{MCP: mcp, BoardID: "board"})
	until(t, a, isKind(agent.EvCatalog))
	nw, _ := find(readRecord(t, e.record), "session/new")
	jsonEq(t, nw.Params, `{"cwd":`+string(mustMarshal(e.cwd))+`,"mcpServers":[{"type":"http","name":"board","url":"http://localhost:6006/mcp","headers":[{"name":"Authorization","value":"Bearer `+boardToken+`"}]}]}`)

	e2 := newEnv(t, fakeScript{"session/load": {{Cursor: true}}})
	b := e2.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true, MCP: mcp, BoardID: "board"})
	until(t, b, isKind(agent.EvCatalog))
	ld, _ := find(readRecord(t, e2.record), "session/load")
	jsonEq(t, ld.Params, `{"sessionId":"`+testSessionID+`","cwd":`+string(mustMarshal(e2.cwd))+`,"mcpServers":[{"type":"http","name":"board","url":"http://localhost:6006/mcp","headers":[{"name":"Authorization","value":"Bearer `+boardToken+`"}]}]}`)
}

func TestPlainMCPSessionHandshake(t *testing.T) {
	t.Parallel()
	mcp := &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{MCP: mcp})
	until(t, a, isKind(agent.EvCatalog))
	nw, _ := find(readRecord(t, e.record), "session/new")
	jsonEq(t, nw.Params, `{"cwd":`+string(mustMarshal(e.cwd))+`,"mcpServers":[{"type":"http","name":"board","url":"http://localhost:6006/mcp","headers":[{"name":"Authorization","value":"Bearer `+boardToken+`"}]}]}`)
}

func TestPermissionRequests(t *testing.T) {
	t.Parallel()
	perm := func(cmd string) fakeStep {
		return step("request", map[string]any{"method": "session/request_permission", "params": map[string]any{
			"sessionId": testSessionID,
			"toolCall":  map[string]any{"toolCallId": "call_" + cmd[:4], "title": "`" + cmd + "`", "kind": "execute", "status": "pending"},
			"options": []any{
				map[string]any{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
				map[string]any{"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"},
				map[string]any{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
			},
		}})
	}
	// The P3 live trace showed no permission request at all for a board MCP call (Cursor's agent
	// mode auto-approves MCP tools), but the adapter keeps a defensive auto-approve branch so a
	// request for a board MCP call never reaches the user. This one is synthetic.
	permMCP := func(id, server, tool string, args map[string]any) fakeStep {
		return step("request", map[string]any{"method": "session/request_permission", "params": map[string]any{
			"sessionId": testSessionID,
			"toolCall":  map[string]any{"toolCallId": id, "title": server + ": " + tool, "kind": "other", "status": "pending", "rawInput": mcpRawInput(server, tool, args)},
			"options": []any{
				map[string]any{"optionId": "allow-once", "name": "Allow once", "kind": "allow_once"},
				map[string]any{"optionId": "allow-always", "name": "Allow always", "kind": "allow_always"},
				map[string]any{"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
			},
		}})
	}
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		permMCP("call_board", "board", "apply", map[string]any{"board": "b1"}),
		permMCP("call_other", "other", "thing", map[string]any{}),
		perm("cat ~/.ai-whiteboard/state.json"),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}, BoardID: "board"})
	send(t, a, "go")

	var perms []agent.Event
	until(t, a, func(ev agent.Event) bool {
		if ev.Kind == agent.EvPermRequest {
			perms = append(perms, ev)
			if err := a.Decide(ev.PermID, false); err != nil {
				t.Errorf("Decide: %v", err)
			}
		}
		return ev.Kind == agent.EvTurnEnd
	})
	if len(perms) != 1 {
		t.Fatalf("got %d permission events, want 1 (the non-board MCP call)", len(perms))
	}
	p := perms[0]
	if p.ToolName != "other: thing" || p.ToolID != "call_other" {
		t.Fatalf("perm event %+v", p)
	}
	jsonEq(t, p.Input, `{"providerIdentifier":"other","toolName":"thing","args":{}}`)
	if err := a.Decide(p.PermID, true); err == nil {
		t.Fatal("second Decide on the same request succeeded")
	}

	var answers []string
	for _, r := range readRecord(t, e.record) {
		if r.Method == "" && strings.HasPrefix(string(r.ID), `"srv-`) {
			var res struct {
				Outcome struct{ Outcome, OptionID string } `json:"outcome"`
			}
			json.Unmarshal(r.Result, &res)
			answers = append(answers, string(r.ID)+"="+res.Outcome.Outcome+":"+res.Outcome.OptionID)
		}
	}
	want := []string{`"srv-1"=selected:allow-once`, `"srv-2"=selected:reject-once`, `"srv-3"=selected:reject-once`}
	if !reflect.DeepEqual(answers, want) {
		t.Fatalf("answers %v, want %v", answers, want)
	}
}

// TestBoardMCPPermissionAllowAlways: when Cursor offers only an always-allow option (no
// allow_once), a board MCP call is still auto-approved with that option id. Synthetic (the live
// trace produced no permission request).
func TestBoardMCPPermissionAllowAlways(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("request", map[string]any{"method": "session/request_permission", "params": map[string]any{
			"sessionId": testSessionID,
			"toolCall":  map[string]any{"toolCallId": "call_board", "title": "board: apply", "kind": "other", "rawInput": mcpRawInput("board", "apply", map[string]any{"board": "b1"})},
			"options": []any{
				map[string]any{"optionId": "always", "kind": "allow_always"},
				map[string]any{"optionId": "never", "kind": "reject_once"},
			},
		}}),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}, BoardID: "board"})
	send(t, a, "go")
	until(t, a, isKind(agent.EvTurnEnd))
	for _, r := range readRecord(t, e.record) {
		if string(r.ID) == `"srv-1"` {
			jsonEq(t, r.Result, `{"outcome":{"outcome":"selected","optionId":"always"}}`)
			return
		}
	}
	t.Fatal("no answer recorded")
}

func TestSpawnFamilyMCPAutoApproved(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("request", map[string]any{"method": "session/request_permission", "params": map[string]any{
			"sessionId": testSessionID,
			"toolCall":  map[string]any{"toolCallId": "call_spawn", "title": "board: spawn_subagent", "kind": "other", "rawInput": mcpRawInput("board", "spawn_subagent", map[string]any{"prompt": "go"})},
			"options": []any{
				map[string]any{"optionId": "allow-once", "kind": "allow_once"},
				map[string]any{"optionId": "never", "kind": "reject_once"},
			},
		}}),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}})
	send(t, a, "go")
	var perms int
	until(t, a, func(ev agent.Event) bool {
		if ev.Kind == agent.EvPermRequest {
			perms++
		}
		return ev.Kind == agent.EvTurnEnd
	})
	if perms != 0 {
		t.Fatalf("spawn-family raised %d permission cards", perms)
	}
	for _, r := range readRecord(t, e.record) {
		if string(r.ID) == `"srv-1"` {
			jsonEq(t, r.Result, `{"outcome":{"outcome":"selected","optionId":"allow-once"}}`)
			return
		}
	}
	t.Fatal("no answer recorded")
}

func TestSpawnFamilyToolNormalize(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "s1", "title": "MCP: tool", "kind": "other", "status": "pending", "rawInput": map[string]any{}}),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "s1", "title": "board: spawn_subagent",
			"rawInput": mcpRawInput("board", "spawn_subagent", map[string]any{"prompt": "go", "description": "files"})}),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}})
	send(t, a, "go")
	evs := without(until(t, a, isKind(agent.EvTurnEnd)), agent.EvUsage, agent.EvSession, agent.EvCatalog, agent.EvThinking)
	var input agent.Event
	for _, ev := range evs {
		if ev.Kind == agent.EvToolInput {
			input = ev
			break
		}
	}
	if input.ToolName != "mcp__board__spawn_subagent" {
		t.Fatalf("spawn tool name %q", input.ToolName)
	}
	jsonEq(t, input.Input, `{"description":"files","prompt":"go"}`)
}

// list_subagent_models is spawn-family like the other two: no permission card, and the same
// tool name as Claude's.
func TestListSubagentModelsMCPAutoApproved(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("request", map[string]any{"method": "session/request_permission", "params": map[string]any{
			"sessionId": testSessionID,
			"toolCall":  map[string]any{"toolCallId": "call_models", "title": "board: list_subagent_models", "kind": "other", "rawInput": mcpRawInput("board", "list_subagent_models", map[string]any{"agent": "pi", "filter": "opus"})},
			"options": []any{
				map[string]any{"optionId": "allow-once", "kind": "allow_once"},
				map[string]any{"optionId": "never", "kind": "reject_once"},
			},
		}}),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}})
	send(t, a, "go")
	var perms int
	until(t, a, func(ev agent.Event) bool {
		if ev.Kind == agent.EvPermRequest {
			perms++
		}
		return ev.Kind == agent.EvTurnEnd
	})
	if perms != 0 {
		t.Fatalf("list_subagent_models raised %d permission cards", perms)
	}
	for _, r := range readRecord(t, e.record) {
		if string(r.ID) == `"srv-1"` {
			jsonEq(t, r.Result, `{"outcome":{"outcome":"selected","optionId":"allow-once"}}`)
			return
		}
	}
	t.Fatal("no answer recorded")
}

func TestListSubagentModelsToolNormalize(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "m1", "title": "MCP: tool", "kind": "other", "status": "pending", "rawInput": map[string]any{}}),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "m1", "title": "board: list_subagent_models",
			"rawInput": mcpRawInput("board", "list_subagent_models", map[string]any{"agent": "pi", "filter": "opus"})}),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: boardToken}})
	send(t, a, "go")
	evs := without(until(t, a, isKind(agent.EvTurnEnd)), agent.EvUsage, agent.EvSession, agent.EvCatalog, agent.EvThinking)
	var input agent.Event
	for _, ev := range evs {
		if ev.Kind == agent.EvToolInput {
			input = ev
			break
		}
	}
	if input.ToolName != "mcp__board__list_subagent_models" {
		t.Fatalf("list tool name %q", input.ToolName)
	}
	jsonEq(t, input.Input, `{"agent":"pi","filter":"opus"}`)
}

func TestDecideAllow(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("request", map[string]any{"method": "session/request_permission", "params": map[string]any{
			"sessionId": testSessionID,
			"toolCall":  map[string]any{"toolCallId": "c", "title": "`echo hi > out.txt`", "kind": "execute"},
			"options": []any{
				map[string]any{"optionId": "yes-once", "kind": "allow_once"},
				map[string]any{"optionId": "no-once", "kind": "reject_once"},
			},
		}}),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	until(t, a, func(ev agent.Event) bool {
		if ev.Kind == agent.EvPermRequest {
			a.Decide(ev.PermID, true)
		}
		return ev.Kind == agent.EvTurnEnd
	})
	for _, r := range readRecord(t, e.record) {
		if string(r.ID) == `"srv-1"` {
			jsonEq(t, r.Result, `{"outcome":{"outcome":"selected","optionId":"yes-once"}}`)
			return
		}
	}
	t.Fatal("no answer recorded")
}

func TestUnknownRequestAnsweredMethodNotFound(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("request", map[string]any{"method": "fs/read_text_file", "params": map[string]any{"path": "/x"}}),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	until(t, a, isKind(agent.EvTurnEnd))
	for _, r := range readRecord(t, e.record) {
		if string(r.ID) == `"srv-1"` {
			jsonEq(t, r.Error, `{"code":-32601,"message":"method not found"}`)
			return
		}
	}
	t.Fatal("no answer recorded")
}

func TestInterrupt(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("update", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "working"}}),
		{Wait: "session/cancel"},
		{Result: raw(`{"stopReason":"cancelled"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	until(t, a, isKind(agent.EvTextDelta))
	if err := a.Interrupt(); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	evs := until(t, a, isKind(agent.EvTurnEnd))
	if end := evs[len(evs)-1]; !end.Aborted || end.Error != "" {
		t.Fatalf("turn end %+v", end)
	}
	c, ok := find(readRecord(t, e.record), "session/cancel")
	if !ok || len(c.ID) != 0 {
		t.Fatalf("session/cancel notification not sent: %+v", c)
	}
	jsonEq(t, c.Params, `{"sessionId":"`+testSessionID+`"}`)
}

func TestStopReasonError(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{{Result: raw(`{"stopReason":"refusal"}`)}}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	evs := until(t, a, isKind(agent.EvTurnEnd))
	if end := evs[len(evs)-1]; end.Aborted || end.Error != "Cursor stopped: refusal" {
		t.Fatalf("turn end %+v", end)
	}
}

func TestExitEndsEvents(t *testing.T) {
	t.Parallel()
	s := baseScript()
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	until(t, a, isKind(agent.EvCatalog))
	a.Close()
	evs := until(t, a, isKind(agent.EvExit))
	if len(evs) != 1 {
		t.Fatalf("events before exit %s", kinds(evs))
	}
	select {
	case _, ok := <-a.Events():
		if ok {
			t.Fatal("event after EvExit")
		}
	case <-time.After(mustHappen):
		t.Fatal("events not closed after EvExit")
	}
}

func TestContextUsageFromStore(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{{Result: raw(`{"stopReason":"end_turn"}`)}}
	e := newEnv(t, s)
	makeStore(t, e.home, goodMeta()+blobRow(testBlobID, sampleRoot(15989, 272000)))
	a := e.spawn(t, agent.SpawnOptions{})

	// Not read between session/new and the first prompt.
	if evs := until(t, a, isKind(agent.EvCatalog)); len(without(evs, agent.EvSession, agent.EvCatalog)) != 0 {
		t.Fatalf("events before the first prompt %s", kinds(evs))
	}
	send(t, a, "hi")
	var usage []agent.Event
	for _, ev := range until(t, a, isKind(agent.EvTurnEnd)) {
		if ev.Kind == agent.EvUsage {
			usage = append(usage, ev)
		}
	}
	if len(usage) != 1 || usage[0].CtxIn != 15989 || usage[0].CtxWindow != 272000 || usage[0].CtxOut != 0 || usage[0].CtxError != "" {
		t.Fatalf("usage events %+v", usage)
	}

	if err := os.RemoveAll(filepath.Dir(StorePath(e.home, testSessionID))); err != nil {
		t.Fatal(err)
	}
	send(t, a, "again")
	usage = nil
	for _, ev := range until(t, a, isKind(agent.EvTurnEnd)) {
		if ev.Kind == agent.EvUsage {
			usage = append(usage, ev)
		}
	}
	if len(usage) != 1 || !reflect.DeepEqual(usage[0], agent.Event{Kind: agent.EvUsage, CtxError: "Cursor session store not found"}) {
		t.Fatalf("usage events %+v", usage)
	}
}

func TestContextUsagePollsWhileTurnRuns(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	// The turn runs until the poller has read the store once, and then for several ticks more.
	running, end := cue(t)
	s := baseScript()
	s["session/prompt"] = []fakeStep{running, {Result: raw(`{"stopReason":"end_turn"}`)}}
	e := newEnv(t, s)
	e.s.ctxInterval = 50 * time.Millisecond
	makeStore(t, e.home, goodMeta()+blobRow(testBlobID, sampleRoot(15989, 272000)))
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "hi")
	evs := until(t, a, isKind(agent.EvUsage))
	time.AfterFunc(400*time.Millisecond, end)
	var usage []agent.Event
	for _, ev := range append(evs, until(t, a, isKind(agent.EvTurnEnd))...) {
		if ev.Kind == agent.EvUsage {
			usage = append(usage, ev)
		}
	}
	// Many ticks, one unchanged result: one event from polling, one from the final read.
	if len(usage) != 2 || usage[0].CtxIn != 15989 || usage[1].CtxIn != 15989 {
		t.Fatalf("usage events %+v", usage)
	}
}

// Every turn end carries the store's latest root, as read after session/prompt returned: the
// turn's fork point.
func TestTurnEndPoint(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	cases := []struct {
		name    string
		prompt  []fakeStep
		aborted bool
		wantErr string
	}{
		{"normal", []fakeStep{{Result: raw(`{"stopReason":"end_turn"}`)}}, false, ""},
		{"cancelled", []fakeStep{
			step("update", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "working"}}),
			{Wait: "session/cancel"},
			{Result: raw(`{"stopReason":"cancelled"}`)},
		}, true, ""},
		{"error stop reason", []fakeStep{{Result: raw(`{"stopReason":"refusal"}`)}}, false, "Cursor stopped: refusal"},
		{"failed call", []fakeStep{{Error: raw(`{"code":-32603,"message":"Internal error"}`)}}, false, "session/prompt: Internal error"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t, fakeScript{"session/prompt": c.prompt})
			makeStore(t, e.home, goodMeta()+blobRow(testBlobID, sampleRoot(15989, 272000)))
			a := e.spawn(t, agent.SpawnOptions{})
			until(t, a, isKind(agent.EvCatalog))
			send(t, a, "go")
			if c.aborted {
				until(t, a, isKind(agent.EvTextDelta)) // the prompt has arrived
				if err := a.Interrupt(); err != nil {
					t.Fatalf("Interrupt: %v", err)
				}
			}
			evs := until(t, a, isKind(agent.EvTurnEnd))
			want := agent.Event{Kind: agent.EvTurnEnd, Aborted: c.aborted, Error: c.wantErr, Point: testBlobID}
			if end := evs[len(evs)-1]; !reflect.DeepEqual(end, want) {
				t.Fatalf("turn end %+v, want %+v", end, want)
			}
			for _, ev := range evs[:len(evs)-1] {
				if ev.Point != "" {
					t.Fatalf("a point on %+v", ev)
				}
			}
		})
	}
}

// The point is the root the store has when the prompt returns, not one seen while the turn ran
// (a turn writes several roots, and the poller reads them).
func TestTurnEndPointReadAfterPrompt(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	other := "9d2c4e6f8a0b1c3d5e7f9a1b2c3d4e5f603b1f0c9a7e5d2b4f6a8c0e1d3f5b7a"
	e := newEnv(t, fakeScript{"session/prompt": {
		step("update", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "working"}}),
		{Wait: "session/cancel"},
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}})
	e.s.ctxInterval = 20 * time.Millisecond
	makeStore(t, e.home, goodMeta()+blobRow(testBlobID, sampleRoot(15989, 272000))+blobRow(other, sampleRoot(20000, 272000)))
	a := e.spawn(t, agent.SpawnOptions{})
	until(t, a, isKind(agent.EvCatalog))
	send(t, a, "go")
	// The prompt has arrived and the poller has seen the first root; the turn then writes its
	// final one and returns.
	polled, arrived := false, false
	until(t, a, func(ev agent.Event) bool {
		polled = polled || (ev.Kind == agent.EvUsage && ev.CtxIn == 15989)
		arrived = arrived || ev.Kind == agent.EvTextDelta
		return polled && arrived
	})
	meta := hex.EncodeToString([]byte(`{"latestRootBlobId":"` + other + `"}`))
	writeStore(t, StorePath(e.home, testSessionID), "UPDATE meta SET value = '"+meta+"' WHERE key = '0';")
	if err := a.Interrupt(); err != nil { // the fake's cue to answer the prompt
		t.Fatal(err)
	}
	evs := until(t, a, isKind(agent.EvTurnEnd))
	if end := evs[len(evs)-1]; end.Point != other || end.Error != "" {
		t.Fatalf("turn end %+v", end)
	}
}

// With no readable store the turn end has no point, and the meter's error is what it was.
func TestTurnEndPointWithoutStore(t *testing.T) {
	t.Parallel()
	e := newEnv(t, fakeScript{"session/prompt": {{Result: raw(`{"stopReason":"end_turn"}`)}}})
	a := e.spawn(t, agent.SpawnOptions{})
	until(t, a, isKind(agent.EvCatalog))
	send(t, a, "go")
	evs := without(until(t, a, isKind(agent.EvTurnEnd)), agent.EvThinking)
	want := []agent.Event{
		{Kind: agent.EvUsage, CtxError: "Cursor session store not found"},
		{Kind: agent.EvTurnEnd},
	}
	if !reflect.DeepEqual(evs, want) {
		t.Fatalf("events %+v, want %+v", evs, want)
	}
}

func TestCatalogProbe(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	e.seed(t, fakeConfig{SelectedModel: "claude-sonnet-5"})
	cat, err := e.s.Catalog(10 * time.Second)
	if err != nil {
		t.Fatalf("Catalog: %v", err)
	}
	want := ParseModelList(fakeModels)
	want.Default = model.ModelChoice{Model: "claude-sonnet-5", Effort: "high"}
	if !reflect.DeepEqual(cat, want) {
		t.Fatalf("catalog %+v, want %+v", cat, want)
	}
	rs := readRecord(t, e.record)
	if got := methods(rs); !reflect.DeepEqual(got, []string{"initialize", "authenticate", "session/new", "cursor/list_available_models"}) {
		t.Fatalf("methods %v", got)
	}
	init, _ := find(rs, "initialize")
	var ip struct {
		ClientCapabilities struct {
			Meta map[string]any `json:"_meta"`
		} `json:"clientCapabilities"`
	}
	json.Unmarshal(init.Params, &ip)
	if ip.ClientCapabilities.Meta["parameterizedModelPicker"] != true {
		t.Fatalf("initialize %s", init.Params)
	}
	nw, _ := find(rs, "session/new")
	jsonEq(t, nw.Params, `{"cwd":`+string(mustMarshal(os.TempDir()))+`,"mcpServers":[]}`)
	if !rs[len(rs)-1].EOF {
		t.Fatal("stdin not closed: the process was not ended")
	}
	if cfg := e.sharedConfig(t); cfg.SelectedModel != "claude-sonnet-5" || len(cfg.ModelParameters) != 0 {
		t.Fatalf("probe changed the shared config: %+v", cfg)
	}
	// The probe's catalog is what a resumed chat's catalog Default uses.
	if e.s.lastCatalog() != cat {
		t.Fatal("catalog not remembered")
	}
}

func TestCatalogProbeNoModels(t *testing.T) {
	t.Parallel()
	e := newEnv(t, fakeScript{"cursor/list_available_models": {{Result: raw(`{"models":[]}`)}}})
	if _, err := e.s.Catalog(10 * time.Second); err == nil || err.Error() != "Cursor reported no models" {
		t.Fatalf("got %v", err)
	}
}

func TestCatalogProbeTimeout(t *testing.T) {
	// Not parallel: the start of the fake should fit the first, short time box.
	waitsOutBox(t, 300*time.Millisecond, 20*time.Second, func(box time.Duration, short bool) bool {
		e := newEnv(t, fakeScript{"session/new": {{Hang: true}}})
		start := time.Now()
		_, err := e.s.Catalog(box)
		d := time.Since(start)
		if err == nil {
			t.Fatal("no error on timeout")
		}
		// Catalog returns once the process has ended, so the record is whole. The box counts only
		// when the fake got the request it never answers.
		if _, got := find(readRecordSoFar(e.record), "session/new"); short && !got {
			return false
		}
		if d > box+closeBox {
			t.Fatalf("took %s in a box of %s", d, box)
		}
		if rs := readRecord(t, e.record); !rs[len(rs)-1].EOF {
			t.Fatal("process not ended")
		}
		return true
	})
}

// childUpdate is a session/update of the subagent session sid.
func childUpdate(sid string, u any) fakeStep {
	return fakeStep{Send: mustMarshal(map[string]any{"jsonrpc": "2.0", "method": "session/update",
		"params": map[string]any{"sessionId": sid, "update": u}})}
}

// taskCall is the parent's Task tool_call for a general-purpose subagent.
func taskCall(id, desc, prompt string) fakeStep {
	return step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": id, "title": "Task: " + desc,
		"kind": "other", "status": "pending", "rawInput": map[string]any{"_toolName": "task", "description": desc,
			"prompt": prompt, "subagentType": map[string]any{"unspecified": map[string]any{}}}})
}

func spawned(sid, tool, model string) fakeStep { return spawnedTask(sid, tool, model, "P") }

// spawnedTask is subagent_spawned whose task (Cursor's short prompt preview) is task.
func spawnedTask(sid, tool, model, task string) fakeStep {
	return step("update", map[string]any{"sessionUpdate": "subagent_spawned", "subagentSessionId": sid,
		"name": "generalPurpose", "task": task, "_meta": map[string]any{"cursor": map[string]any{"toolCallId": tool, "model": model}}})
}

func subState(sid, state, errText string) fakeStep {
	u := map[string]any{"sessionUpdate": "subagent_state_update", "subagentSessionId": sid, "state": state}
	if errText != "" {
		u["error"] = errText
	}
	return step("update", u)
}

var endTurn = fakeStep{Result: raw(`{"stopReason":"end_turn"}`)}

func TestInitializeAdvertisesSubagents(t *testing.T) {
	t.Parallel()
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{})
	until(t, a, isKind(agent.EvCatalog))
	init, ok := find(readRecord(t, e.record), "initialize")
	if !ok {
		t.Fatal("no initialize")
	}
	var ip struct {
		ClientCapabilities struct {
			Meta map[string]any `json:"_meta"`
		} `json:"clientCapabilities"`
	}
	json.Unmarshal(init.Params, &ip)
	if ip.ClientCapabilities.Meta["subagents"] != true || ip.ClientCapabilities.Meta["parameterizedModelPicker"] != true {
		t.Fatalf("initialize %s", init.Params)
	}
}

func TestSubagentStream(t *testing.T) {
	t.Parallel()
	const call = "call_1\nfc_1"
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		taskCall(call, "count files", "P"),
		spawned("S1", call, "gpt-5.4-mini-medium"),
		childUpdate("S1", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "hi"}}),
		childUpdate("S1", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "k1", "title": "`ls`", "kind": "execute", "status": "pending", "rawInput": map[string]any{"command": "ls"}}),
		childUpdate("S1", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "k1", "status": "completed", "rawOutput": map[string]any{"exitCode": 0, "stdout": "a\nb\n", "stderr": ""}}),
		subState("S1", "completed", ""),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": call, "status": "completed",
			"content": []any{map[string]any{"type": "content", "content": map[string]any{"type": "text", "text": "2 files"}}}}),
		endTurn,
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	evs := without(until(t, a, isKind(agent.EvTurnEnd)), agent.EvUsage, agent.EvSession, agent.EvCatalog, agent.EvThinking)

	want := "ToolStart,Sub,TextStart,TextDelta,ToolStart,ToolResult,Sub,ToolResult,TurnEnd"
	if got := kinds(evs); got != want {
		t.Fatalf("events\n got %s\nwant %s", got, want)
	}
	if ev := evs[0]; ev.ToolName != "Agent" || ev.ToolID != call || ev.Sub != "" {
		t.Fatalf("parent tool start %+v", ev)
	}
	jsonEq(t, evs[0].Input, `{"description":"count files","prompt":"P","subagent_type":""}`)
	sp := evs[1]
	if sp.Sub != call || sp.SubInfo == nil || !reflect.DeepEqual(*sp.SubInfo, agent.SubInfo{ID: "S1", Type: "generalPurpose",
		Description: "count files", Prompt: "P", Model: "gpt-5.4-mini-medium", Status: model.SubRunning}) {
		t.Fatalf("spawn event %+v %+v", sp, sp.SubInfo)
	}
	for _, ev := range evs[2:6] {
		if ev.Sub != call {
			t.Fatalf("child event without Sub: %+v", ev)
		}
	}
	if evs[2].MsgID != evs[3].MsgID || evs[3].Text != "hi" || evs[2].MsgID == "c1" {
		t.Fatalf("child text %+v %+v", evs[2], evs[3])
	}
	if evs[4].ToolName != "Bash" || evs[4].ToolID != "k1" || evs[5].ToolID != "k1" || evs[5].Result != "a\nb\n" {
		t.Fatalf("child tool %+v %+v", evs[4], evs[5])
	}
	if end := evs[6]; end.Sub != call || end.SubInfo == nil || *end.SubInfo != (agent.SubInfo{Status: model.SubCompleted}) {
		t.Fatalf("end event %+v %+v", end, end.SubInfo)
	}
	if r := evs[7]; r.Sub != "" || r.ToolID != call || r.Result != "2 files" {
		t.Fatalf("parent tool result %+v", r)
	}
	if evs[8].Sub != "" {
		t.Fatalf("turn end %+v", evs[8])
	}
}

// TestSubagentPromptSource: the Task call's full prompt wins over subagent_spawned's task, a short
// preview; the preview is used only when the Task call has no prompt.
func TestSubagentPromptSource(t *testing.T) {
	t.Parallel()
	const full = "You are in a coding workspace. Do the following in order:\n1. list the files\n2. count them"
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		taskCall("t1", "full", full),
		spawnedTask("S1", "t1", "m", "You are in a coding workspace. Do the following in order:"),
		taskCall("t2", "empty", ""),
		spawnedTask("S2", "t2", "m", "Task: preview only"),
		endTurn,
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	got := map[string]string{}
	for _, ev := range until(t, a, isKind(agent.EvTurnEnd)) {
		if ev.Kind == agent.EvSub && ev.SubInfo != nil && ev.SubInfo.ID != "" {
			got[ev.Sub] = ev.SubInfo.Prompt
		}
	}
	want := map[string]string{"t1": full, "t2": "Task: preview only"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("prompts %q, want %q", got, want)
	}
}

func TestSubagentStateMapping(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		spawned("S1", "t1", "m"), spawned("S2", "t2", "m"), spawned("S3", "t3", "m"), spawned("S4", "t4", "m"),
		subState("S1", "cancelled", ""),
		subState("S2", "disconnected", ""),
		subState("S3", "failed", "boom"),
		subState("S4", "running", ""),
		subState("S9", "completed", ""), // unknown: ignored
		endTurn,
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	got := map[string][]agent.SubInfo{}
	for _, ev := range until(t, a, isKind(agent.EvTurnEnd)) {
		if ev.Kind == agent.EvSub && ev.SubInfo.Status != model.SubRunning {
			got[ev.Sub] = append(got[ev.Sub], *ev.SubInfo)
		}
	}
	want := map[string][]agent.SubInfo{
		"t1": {{Status: model.SubStopped}},
		"t2": {{Status: model.SubStopped}},
		"t3": {{Status: model.SubFailed, Error: "boom"}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("states %+v, want %+v", got, want)
	}
}

func TestBackgroundTaskTool(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		taskCall("t1", "bg job", "P"),
		spawned("S1", "t1", "m"),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "rawOutput": map[string]any{"isBackground": true}}),
		endTurn,
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	var bg []agent.Event
	for _, ev := range until(t, a, isKind(agent.EvTurnEnd)) {
		if ev.Kind == agent.EvSub && ev.SubInfo.Background != nil {
			bg = append(bg, ev)
		}
	}
	if len(bg) != 1 || bg[0].Sub != "t1" || !*bg[0].SubInfo.Background || bg[0].SubInfo.Status != "" {
		t.Fatalf("background events %+v", bg)
	}
}

func TestCursorTaskRequest(t *testing.T) {
	t.Parallel()
	const call = "call_abc\nfc_def"
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		taskCall(call, "haiku job", "P"),
		spawned("S1", call, "parent-model"),
		step("request", map[string]any{"method": "cursor/task", "params": map[string]any{"toolCallId": "call_abc", "model": "claude-4.5-haiku-thinking"}}),
		endTurn,
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	var models []agent.Event
	for _, ev := range until(t, a, isKind(agent.EvTurnEnd)) {
		if ev.Kind == agent.EvSub && ev.SubInfo.Status == "" && ev.SubInfo.Model != "" {
			models = append(models, ev)
		}
	}
	if len(models) != 1 || models[0].Sub != call || *models[0].SubInfo != (agent.SubInfo{Model: "claude-4.5-haiku-thinking"}) {
		t.Fatalf("model events %+v", models)
	}
	for _, r := range readRecord(t, e.record) {
		if string(r.ID) == `"srv-1"` {
			if len(r.Error) != 0 {
				t.Fatalf("cursor/task answered with error %s", r.Error)
			}
			jsonEq(t, r.Result, `{}`)
			return
		}
	}
	t.Fatal("no answer recorded")
}

func TestChildContextUsage(t *testing.T) {
	needSQLite(t)
	t.Parallel()
	// The subagent runs until the poller has read its store once, and then for several ticks
	// more; the turn goes on for several ticks after the store was changed.
	running, complete := cue(t)
	after, end := cue(t)
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		spawned("S1", "t1", "m"),
		running,
		subState("S1", "completed", ""),
		after,
		endTurn,
	}
	e := newEnv(t, s)
	e.s.ctxInterval = 50 * time.Millisecond
	db := ChildStorePath(e.home, e.cwd, "S1")
	makeStoreAt(t, db, goodMeta()+blobRow(testBlobID, sampleRoot(14324, 272000)))
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")

	isUsage := func(ev agent.Event) bool { return ev.Kind == agent.EvSub && ev.SubInfo.Tokens != 0 }
	evs := until(t, a, isUsage)
	if u := evs[len(evs)-1]; u.Sub != "t1" || *u.SubInfo != (agent.SubInfo{Tokens: 14324, Window: 272000}) {
		t.Fatalf("usage event %+v %+v", u, u.SubInfo)
	}
	// Polling repeats an unchanged result silently; the terminal state is followed by one last read.
	time.AfterFunc(300*time.Millisecond, complete)
	evs = until(t, a, func(ev agent.Event) bool { return ev.Kind == agent.EvSub && ev.SubInfo.Status == model.SubCompleted })
	for _, ev := range evs {
		if isUsage(ev) {
			t.Fatalf("unchanged usage sent again: %+v", ev.SubInfo)
		}
	}
	until(t, a, isUsage)

	// The poller has stopped: a changed store is no longer read.
	upd := "UPDATE blobs SET data = X'" + hex.EncodeToString(sampleRoot(20000, 272000)) + "' WHERE id = '" + testBlobID + "';"
	writeStore(t, db, upd)
	time.AfterFunc(400*time.Millisecond, end)
	for _, ev := range until(t, a, isKind(agent.EvTurnEnd)) {
		if isUsage(ev) {
			t.Fatalf("child usage after the terminal state: %+v", ev.SubInfo)
		}
	}
}

func TestLoadDropsSubagentReplay(t *testing.T) {
	t.Parallel()
	e := newEnv(t, fakeScript{
		"session/load": {
			spawned("S1", "t1", "m"),
			childUpdate("S1", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "old"}}),
			{Cursor: true},
		},
		"session/prompt": {
			childUpdate("S1", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "new"}}),
			endTurn,
		},
	})
	a := e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true})
	send(t, a, "hi")
	for _, ev := range until(t, a, isKind(agent.EvTurnEnd)) {
		if ev.Kind == agent.EvSub || ev.Sub != "" {
			t.Fatalf("subagent event from the replay: %+v", ev)
		}
	}
}

func TestChildPermission(t *testing.T) {
	t.Parallel()
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		spawned("S1", "t1", "m"),
		step("request", map[string]any{"method": "session/request_permission", "params": map[string]any{
			"sessionId": "S1",
			"toolCall":  map[string]any{"toolCallId": "k1", "title": "`rm x`", "kind": "execute"},
			"options": []any{
				map[string]any{"optionId": "allow-once", "kind": "allow_once"},
				map[string]any{"optionId": "reject-once", "kind": "reject_once"},
			},
		}}),
		endTurn,
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "go")
	var perms []agent.Event
	until(t, a, func(ev agent.Event) bool {
		if ev.Kind == agent.EvPermRequest {
			perms = append(perms, ev)
			a.Decide(ev.PermID, true)
		}
		return ev.Kind == agent.EvTurnEnd
	})
	if len(perms) != 1 || perms[0].Sub != "t1" || perms[0].ToolName != "Bash" {
		t.Fatalf("perm events %+v", perms)
	}
}
