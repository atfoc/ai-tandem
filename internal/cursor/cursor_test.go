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

// sampleNew is a session/new result in the shape `agent acp` returns (trimmed), with the test
// session id.
var sampleNew = raw(`{
 "sessionId": "` + testSessionID + `",
 "modes": {"currentModeId": "agent", "availableModes": [{"id": "agent", "name": "Agent"}]},
 "models": {
  "currentModelId": "gpt-5.4-mini[reasoning=medium]",
  "availableModels": [
   {"modelId": "composer-2.5[fast=false]", "name": "Composer 2.5"},
   {"modelId": "gpt-5.4-mini[reasoning=medium]", "name": "GPT-5.4 Mini"},
   {"modelId": "gpt-5.4-mini[reasoning=high]", "name": "GPT-5.4 Mini High"},
   {"modelId": "gemini-3.8-flash[reasoning=high]", "name": "Gemini 3.8 Flash High"},
   {"modelId": "gemini-3.1-pro[]", "name": "Gemini 3.1 Pro"}
  ]
 },
 "configOptions": [
  {"id": "mode", "name": "Mode", "type": "select", "currentValue": "agent",
   "options": [{"value": "agent", "name": "Agent"}, {"value": "plan", "name": "Plan"}]},
  {"id": "model", "name": "Model", "category": "model", "type": "select",
   "currentValue": "gpt-5.4-mini[reasoning=medium]",
   "options": [
    {"value": "composer-2.5[fast=false]", "name": "Composer 2.5"},
    {"value": "gpt-5.4-mini[reasoning=medium]", "name": "GPT-5.4 Mini"},
    {"value": "gpt-5.4-mini[reasoning=high]", "name": "GPT-5.4 Mini High"},
    {"value": "gemini-3.8-flash[reasoning=high]", "name": "Gemini 3.8 Flash High"},
    {"value": "gemini-3.1-pro[]", "name": "Gemini 3.1 Pro"}
   ]}
 ]
}`)

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

// baseScript answers the handshake with sampleNew.
func baseScript() fakeScript {
	return fakeScript{"session/new": {{Result: sampleNew}}}
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

func TestHandshakeNewSession(t *testing.T) {
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{ChatID: "c1", Model: "gpt-5.4-mini", Effort: "high"})

	evs := until(t, a, isKind(agent.EvCatalog))
	if evs[0].Kind != agent.EvSession || evs[0].SessionID != testSessionID {
		t.Fatalf("first event %+v, want EvSession %s", evs[0], testSessionID)
	}
	if c := evs[len(evs)-1].Catalog; c == nil || len(c.Models) != 4 {
		t.Fatalf("catalog %+v", c)
	}
	send(t, a, "hi")
	until(t, a, isKind(agent.EvTurnEnd))

	rs := readRecord(t, e.record)
	want := []string{"initialize", "authenticate", "session/new", "session/set_config_option", "session/prompt"}
	if got := methods(rs); !reflect.DeepEqual(got, want) {
		t.Fatalf("methods %v, want %v", got, want)
	}
	init, _ := find(rs, "initialize")
	jsonEq(t, init.Params, `{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},"clientInfo":{"name":"ai-whiteboard","version":"`+version.Version+`"}}`)
	auth, _ := find(rs, "authenticate")
	jsonEq(t, auth.Params, `{"methodId":"cursor_login"}`)
	nw, _ := find(rs, "session/new")
	jsonEq(t, nw.Params, `{"cwd":`+string(mustMarshal(e.cwd))+`,"mcpServers":[]}`)
	set, _ := find(rs, "session/set_config_option")
	jsonEq(t, set.Params, `{"sessionId":"`+testSessionID+`","configId":"model","value":"gpt-5.4-mini[reasoning=high]"}`)
	pr, _ := find(rs, "session/prompt")
	jsonEq(t, pr.Params, `{"sessionId":"`+testSessionID+`","prompt":[{"type":"text","text":"hi"}]}`)
}

func TestSetModelFallback(t *testing.T) {
	s := baseScript()
	s["session/set_config_option"] = []fakeStep{{Error: raw(`{"code":-32602,"message":"bad"}`)}}
	e := newEnv(t, s)
	a := e.spawn(t, agent.SpawnOptions{Model: "gemini-3.1-pro"})
	send(t, a, "hi")
	until(t, a, isKind(agent.EvTurnEnd))
	set, ok := find(readRecord(t, e.record), "session/set_model")
	if !ok {
		t.Fatal("no session/set_model")
	}
	jsonEq(t, set.Params, `{"sessionId":"`+testSessionID+`","modelId":"gemini-3.1-pro[]"}`)
}

func TestNoModelNoSetConfig(t *testing.T) {
	e := newEnv(t, baseScript())
	a := e.spawn(t, agent.SpawnOptions{})
	send(t, a, "hi")
	until(t, a, isKind(agent.EvTurnEnd))
	if _, ok := find(readRecord(t, e.record), "session/set_config_option"); ok {
		t.Fatal("set_config_option sent without a model")
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

func TestResumeDropsReplay(t *testing.T) {
	e := newEnv(t, fakeScript{
		"session/load": {
			step("update", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "old"}}),
			step("update", map[string]any{"sessionUpdate": "tool_call", "toolCallId": "t0", "title": "`ls`", "kind": "execute", "status": "completed", "rawInput": map[string]any{"command": "ls"}}),
			step("update", map[string]any{"sessionUpdate": "agent_thought_chunk", "content": map[string]any{"type": "text", "text": "hm"}}),
			{Result: raw(`{}`)},
		},
		"session/prompt": {
			step("update", map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "new"}}),
			{Result: raw(`{"stopReason":"end_turn"}`)},
		},
	})
	a := e.spawn(t, agent.SpawnOptions{SessionID: testSessionID, Resume: true})

	// The meter is read right after session/load (no store here: an error).
	first := until(t, a, isKind(agent.EvUsage))
	if len(first) != 1 || first[0].CtxError != "Cursor session store not found" {
		t.Fatalf("events after load %s %+v", kinds(first), first)
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
	if got := methods(rs); !reflect.DeepEqual(got, []string{"initialize", "authenticate", "session/load", "session/prompt"}) {
		t.Fatalf("methods %v", got)
	}
	ld, _ := find(rs, "session/load")
	jsonEq(t, ld.Params, `{"sessionId":"`+testSessionID+`","cwd":`+string(mustMarshal(e.cwd))+`,"mcpServers":[]}`)
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
	cat, err := e.s.Catalog(10 * time.Second)
	if err != nil {
		t.Fatalf("Catalog: %v", err)
	}
	if want := ParseCatalog(sampleNew); !reflect.DeepEqual(cat, want) {
		t.Fatalf("catalog %+v, want %+v", cat, want)
	}
	rs := readRecord(t, e.record)
	if got := methods(rs); !reflect.DeepEqual(got, []string{"initialize", "authenticate", "session/new"}) {
		t.Fatalf("methods %v", got)
	}
	nw, _ := find(rs, "session/new")
	jsonEq(t, nw.Params, `{"cwd":`+string(mustMarshal(os.TempDir()))+`,"mcpServers":[]}`)
	if !rs[len(rs)-1].EOF {
		t.Fatal("stdin not closed: the process was not ended")
	}
	// The probe's catalog is what a resumed chat's model choice uses.
	if e.s.lastCatalog() != cat {
		t.Fatal("catalog not remembered")
	}
}

func TestCatalogProbeNoModels(t *testing.T) {
	e := newEnv(t, fakeScript{"session/new": {{Result: raw(`{"sessionId":"x","models":{"availableModels":[]}}`)}}})
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

func TestParseCatalog(t *testing.T) {
	got := ParseCatalog(sampleNew)
	want := &model.Catalog{
		Models: []model.CatalogModel{
			{ID: "composer-2.5", Label: "Composer 2.5"},
			{ID: "gpt-5.4-mini", Label: "GPT-5.4 Mini", Efforts: []string{"medium", "high"}},
			{ID: "gemini-3.8-flash", Label: "Gemini 3.8 Flash", Efforts: []string{"high"}},
			{ID: "gemini-3.1-pro", Label: "Gemini 3.1 Pro"},
		},
		Default: model.ModelChoice{Model: "gpt-5.4-mini", Effort: "medium"},
		Values: []string{"composer-2.5[fast=false]", "gpt-5.4-mini[reasoning=medium]", "gpt-5.4-mini[reasoning=high]",
			"gemini-3.8-flash[reasoning=high]", "gemini-3.1-pro[]"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
}

func TestParseCatalogModelsOnly(t *testing.T) {
	got := ParseCatalog(raw(`{"sessionId":"s","models":{"currentModelId":"gpt-5.4-nano[reasoning=medium]",
		"availableModels":[{"modelId":"gpt-5.4-nano[reasoning=medium]","name":"GPT-5.4 Nano"},{"modelId":"auto","name":"Auto"}]}}`))
	if got == nil || len(got.Models) != 2 || got.Models[0].ID != "gpt-5.4-nano" || got.Models[1].Label != "Auto" ||
		got.Default != (model.ModelChoice{Model: "gpt-5.4-nano", Effort: "medium"}) || len(got.Values) != 2 {
		t.Fatalf("got %+v", got)
	}
	for _, in := range []string{`{}`, `{"configOptions":[{"id":"model","options":[]}]}`, `not json`} {
		if c := ParseCatalog(raw(in)); c != nil {
			t.Errorf("ParseCatalog(%s) = %+v, want nil", in, c)
		}
	}
}

// Real values from Cursor: the effort is under "reasoning", "reasoning_effort" or "effort"
// depending on the model; "thinking" is not an effort.
func TestParseCatalogEffortKeys(t *testing.T) {
	got := ParseCatalog(raw(`{"configOptions":[{"id":"model","currentValue":"claude-opus-5-5[context=300k,effort=medium,fast=false]","options":[
		{"value":"gpt-5.4[context=272k,reasoning=medium,fast=false]"},
		{"value":"grok-4.7[context=256k,reasoning_effort=xhigh,fast=false]"},
		{"value":"claude-opus-5-5[context=300k,effort=medium,fast=false]"},
		{"value":"claude-haiku-4-5[thinking=true]"}]}]}`))
	want := map[string][]string{"gpt-5.4": {"medium"}, "grok-4.7": {"xhigh"}, "claude-opus-5-5": {"medium"}, "claude-haiku-4-5": nil}
	if got == nil || len(got.Models) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for _, m := range got.Models {
		if !reflect.DeepEqual(m.Efforts, want[m.ID]) {
			t.Errorf("%s efforts %v, want %v", m.ID, m.Efforts, want[m.ID])
		}
	}
	if got.Default != (model.ModelChoice{Model: "claude-opus-5-5", Effort: "medium"}) {
		t.Errorf("default %+v", got.Default)
	}
	if v := ValueFor(got, "grok-4.7", "xhigh"); v != "grok-4.7[context=256k,reasoning_effort=xhigh,fast=false]" {
		t.Errorf("ValueFor grok = %q", v)
	}
}

func TestValueFor(t *testing.T) {
	c := &model.Catalog{Values: []string{"gpt-5.4-mini[reasoning=medium]", "gpt-5.4-mini[reasoning=low]", "gpt-5.4-nano[reasoning=medium]", "auto"}}
	cases := []struct{ base, effort, want string }{
		{"gpt-5.4-mini", "low", "gpt-5.4-mini[reasoning=low]"},
		{"gpt-5.4-mini", "medium", "gpt-5.4-mini[reasoning=medium]"},
		{"gpt-5.4-mini", "xhigh", "gpt-5.4-mini[reasoning=medium]"}, // first with that base
		{"gpt-5.4-nano", "low", "gpt-5.4-nano[reasoning=medium]"},
		{"auto", "", "auto"},
		{"missing", "low", ""},
	}
	for _, k := range cases {
		if got := ValueFor(c, k.base, k.effort); got != k.want {
			t.Errorf("ValueFor(%q, %q) = %q, want %q", k.base, k.effort, got, k.want)
		}
	}
	if ValueFor(nil, "x", "") != "" {
		t.Error("nil catalog")
	}
}

func TestSplit(t *testing.T) {
	cases := []struct {
		in   string
		base string
		p    map[string]string
	}{
		{"gpt-5.4-mini[reasoning=medium]", "gpt-5.4-mini", map[string]string{"reasoning": "medium"}},
		{"grok-4.7[context=256k,reasoning_effort=xhigh,fast=false]", "grok-4.7", map[string]string{"context": "256k", "reasoning_effort": "xhigh", "fast": "false"}},
		{"gemini-3.1-pro[]", "gemini-3.1-pro", map[string]string{}},
		{"auto", "auto", map[string]string{}},
	}
	for _, c := range cases {
		base, p := split(c.in)
		if base != c.base || !reflect.DeepEqual(p, c.p) {
			t.Errorf("split(%q) = %q %v", c.in, base, p)
		}
	}
}
