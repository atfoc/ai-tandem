package cursor

import (
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
	otherToken = "fedcba9876543210fedcba9876543210"
)

func boardCmd(token string) string {
	return "curl -s --data-binary @- http://127.0.0.1:4321/agent/" + token + "/apply <<'JSON'\n{\"create\":[{\"type\":\"rectangle\"}]}\nJSON"
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
	s                 *Spawner
}

func newEnv(t *testing.T, script fakeScript) *env {
	t.Helper()
	t.Setenv("CURSOR_CONFIG_DIR", "")
	home := t.TempDir()
	cwd := t.TempDir()
	rec := fake(t, script)
	return &env{home: home, cwd: cwd, record: rec, s: &Spawner{
		Bin:     os.Args[0],
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
	timeout := time.After(10 * time.Second)
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
	agent.EvUsage: "Usage", agent.EvTurnEnd: "TurnEnd", agent.EvExit: "Exit",
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
func seed(t *testing.T, cfg fakeConfig) {
	t.Helper()
	b, _ := json.Marshal(cfg)
	if err := os.WriteFile(os.Getenv("FAKE_ACP_STATE"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// sharedConfig reads the fake Cursor's shared config.
func sharedConfig(t *testing.T) fakeConfig {
	t.Helper()
	var cfg fakeConfig
	if b, err := os.ReadFile(os.Getenv("FAKE_ACP_STATE")); err == nil {
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
// exists, and the sqlite3 binary is a script that records its call and fails.
func (e *env) recordCtxReads(t *testing.T) {
	t.Helper()
	db := StorePath(e.home, testSessionID)
	if err := os.MkdirAll(filepath.Dir(db), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(db, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	sh := filepath.Join(t.TempDir(), "sqlite3")
	script := "#!/bin/sh\necho '{\"method\":\"" + ctxReadMethod + "\"}' >> '" + e.record + "'\nexit 1\n"
	if err := os.WriteFile(sh, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	e.s.SQLite = sh
}

func TestHandshakeNewSession(t *testing.T) {
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
	jsonEq(t, init.Params, `{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false,"_meta":{"parameterizedModelPicker":true}},"clientInfo":{"name":"ai-whiteboard","version":"`+version.Version+`"}}`)
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
			e := newEnv(t, baseScript())
			if tc.seed != nil {
				seed(t, fakeConfig{SelectedModel: "gpt-5.4-mini", ModelParameters: tc.seed})
			}
			a := e.spawn(t, agent.SpawnOptions{Model: tc.model, Effort: tc.effort})
			send(t, a, "hi")
			until(t, a, isKind(agent.EvTurnEnd))
			rs := readRecord(t, e.record)
			if got := sets(rs); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("sets %v, want %v", got, tc.want)
			}
			onlyHandshakeMethods(t, rs, "session/prompt")
			if cfg := sharedConfig(t); cfg.SelectedModel != tc.model {
				t.Fatalf("selected model %q", cfg.SelectedModel)
			}
		})
	}
}

func TestEmptyModelUsesReportedModel(t *testing.T) {
	e := newEnv(t, baseScript())
	seed(t, fakeConfig{SelectedModel: "claude-opus-5-5",
		ModelParameters: map[string]map[string]string{"claude-opus-5-5": {"context": "300k", "effort": "max"}}})
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "hi")
	until(t, a, isKind(agent.EvTurnEnd))
	if got := sets(readRecord(t, e.record)); !reflect.DeepEqual(got, []string{"model=claude-opus-5-5", "context=1m", "effort=medium"}) {
		t.Fatalf("sets %v", got)
	}
}

func TestPolicyErrorFailsSend(t *testing.T) {
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
	e := newEnv(t, fakeScript{"authenticate": {{Error: raw(`{"code":-32000,"message":"Not logged in"}`)}}})
	a := e.spawn(t, agent.SpawnOptions{})
	err := a.Send([]agent.ContentBlock{{Text: "hi"}})
	if err == nil || !strings.Contains(err.Error(), "Not logged in") {
		t.Fatalf("Send error %v", err)
	}
}

func TestSpawnMissingFolder(t *testing.T) {
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
	seed(t, fakeConfig{SelectedModel: "gpt-5.4-mini", ModelParameters: map[string]map[string]string{
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
	cfg := sharedConfig(t)
	if cfg.SelectedModel != "claude-sonnet-5" || !reflect.DeepEqual(cfg.ModelParameters["claude-sonnet-5"],
		map[string]string{"thinking": "true", "context": "1m", "effort": "low"}) {
		t.Fatalf("shared config after resume %+v", cfg)
	}
}

// On resume the catalog Default is the last remembered one when its model is still listed, never
// what session/load reports; otherwise the first model in the list.
func TestResumeCatalogDefault(t *testing.T) {
	e := newEnv(t, baseScript())
	if _, err := e.s.Catalog(10 * time.Second); err != nil {
		t.Fatal(err)
	}
	seed(t, fakeConfig{SelectedModel: "grok-4.7"})
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

func TestBoardCommandToolCall(t *testing.T) {
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "b1", "title": "`" + boardCmd(boardToken) + "`", "kind": "execute", "status": "pending", "rawInput": map[string]any{"command": boardCmd(boardToken)}}),
		step("update", map[string]any{"sessionUpdate": "tool_call_update", "toolCallId": "b1", "status": "completed", "rawOutput": map[string]any{"exitCode": 0, "stdout": `{"ok":true,"created":["r1"]}`, "stderr": ""}}),
		step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "b2", "title": "x", "kind": "execute", "status": "pending", "rawInput": map[string]any{"command": boardCmd(otherToken)}}),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{Board: &agent.BoardAccess{CommandURL: "http://127.0.0.1:4321/agent/" + boardToken, Token: boardToken}})
	send(t, a, "draw")
	evs := without(until(t, a, isKind(agent.EvTurnEnd)), agent.EvUsage, agent.EvSession, agent.EvCatalog, agent.EvThinking)
	if got := kinds(evs); got != "ToolStart,ToolResult,ToolStart,TurnEnd" {
		t.Fatalf("events %s", got)
	}
	if evs[0].ToolName != "mcp__board__apply" {
		t.Fatalf("tool name %q", evs[0].ToolName)
	}
	jsonEq(t, evs[0].Input, `{"create":[{"type":"rectangle"}]}`)
	if evs[1].Result != `{"ok":true,"created":["r1"]}` || evs[1].IsError {
		t.Fatalf("result %+v", evs[1])
	}
	if evs[2].ToolName != "Bash" {
		t.Fatalf("another chat's board command shown as %q", evs[2].ToolName)
	}
}

func TestPermissionRequests(t *testing.T) {
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
	s := baseScript()
	s["session/prompt"] = []fakeStep{
		perm(boardCmd(boardToken)),
		perm(boardCmd(otherToken)),
		perm("cat ~/.ai-whiteboard/state.json"),
		{Result: raw(`{"stopReason":"end_turn"}`)},
	}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{Board: &agent.BoardAccess{Token: boardToken}})
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
		t.Fatalf("got %d permission events, want 1", len(perms))
	}
	p := perms[0]
	if p.ToolName != "Bash" || p.ToolID != "call_curl" {
		t.Fatalf("perm event %+v", p)
	}
	jsonEq(t, p.Input, string(mustMarshal(map[string]string{"command": boardCmd(otherToken)})))
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

func TestDecideAllow(t *testing.T) {
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
	case <-time.After(5 * time.Second):
		t.Fatal("events not closed after EvExit")
	}
}

func TestContextUsageFromStore(t *testing.T) {
	needSQLite(t)
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
	s := baseScript()
	s["session/prompt"] = []fakeStep{{Sleep: 700}, {Result: raw(`{"stopReason":"end_turn"}`)}}
	e := newEnv(t, s)
	e.s.ctxInterval = 50 * time.Millisecond
	makeStore(t, e.home, goodMeta()+blobRow(testBlobID, sampleRoot(15989, 272000)))
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "hi")
	var usage []agent.Event
	for _, ev := range until(t, a, isKind(agent.EvTurnEnd)) {
		if ev.Kind == agent.EvUsage {
			usage = append(usage, ev)
		}
	}
	// Many ticks, one unchanged result: one event from polling, one from the final read.
	if len(usage) != 2 || usage[0].CtxIn != 15989 || usage[1].CtxIn != 15989 {
		t.Fatalf("usage events %+v", usage)
	}
}

func TestCatalogProbe(t *testing.T) {
	e := newEnv(t, baseScript())
	seed(t, fakeConfig{SelectedModel: "claude-sonnet-5"})
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
	if cfg := sharedConfig(t); cfg.SelectedModel != "claude-sonnet-5" || len(cfg.ModelParameters) != 0 {
		t.Fatalf("probe changed the shared config: %+v", cfg)
	}
	// The probe's catalog is what a resumed chat's catalog Default uses.
	if e.s.lastCatalog() != cat {
		t.Fatal("catalog not remembered")
	}
}

func TestCatalogProbeNoModels(t *testing.T) {
	e := newEnv(t, fakeScript{"cursor/list_available_models": {{Result: raw(`{"models":[]}`)}}})
	if _, err := e.s.Catalog(10 * time.Second); err == nil || err.Error() != "Cursor reported no models" {
		t.Fatalf("got %v", err)
	}
}

func TestCatalogProbeTimeout(t *testing.T) {
	e := newEnv(t, fakeScript{"session/new": {{Hang: true}}})
	start := time.Now()
	if _, err := e.s.Catalog(300 * time.Millisecond); err == nil {
		t.Fatal("no error on timeout")
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("took %s", d)
	}
	if rs := readRecord(t, e.record); !rs[len(rs)-1].EOF {
		t.Fatal("process not ended")
	}
}
