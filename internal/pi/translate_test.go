package pi

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

func TestTranslateTextAndThinking(t *testing.T) {
	p := &proc{}
	cases := []struct {
		line string
		want []agent.Event
	}{
		{`{"type":"agent_start"}`, nil},
		{`{"type":"turn_start"}`, nil},
		{`{"type":"message_start","message":{"role":"user","content":[]}}`, nil},
		{`{"type":"message_start","message":{"role":"assistant","content":[]}}`, nil},
		{`{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}`,
			[]agent.Event{{Kind: agent.EvTextStart, MsgID: "m1-0"}}},
		{`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"He"}}`,
			[]agent.Event{{Kind: agent.EvTextDelta, Text: "He"}}},
		{`{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":1}}`,
			[]agent.Event{{Kind: agent.EvThinking}}},
		{`{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":1,"delta":"…"}}`,
			[]agent.Event{{Kind: agent.EvThinking}}},
		{`{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":1,"content":"…"}}`,
			[]agent.Event{{Kind: agent.EvThinking}}},
		{`{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hey"}}`, nil},
		// a second assistant message in the same turn gets a new id
		{`{"type":"message_start","message":{"role":"assistant","content":[]}}`, nil},
		{`{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}`,
			[]agent.Event{{Kind: agent.EvTextStart, MsgID: "m2-0"}}},
		{`{"type":"turn_end"}`, nil},
		{`{"type":"agent_end","messages":[]}`, nil},
		{`{"type":"queue_update","steering":[]}`, nil},
		{`{"type":"compaction_start","reason":"manual"}`, nil},
		{`{"type":"auto_retry_start","attempt":1}`, nil},
		{`{"type":"entry_appended","entry":{}}`, nil},
		{`{"type":"extension_ui_request","method":"notify"}`, nil},
		{`{"type":"some_future_event"}`, nil},
	}
	for _, c := range cases {
		got := translateStr(t, p, c.line)
		if !eventsEqual(got, c.want) {
			t.Errorf("translate(%s)\n got  %s\n want %s", c.line, dump(got), dump(c.want))
		}
	}
}

func TestTranslateToolcallStream(t *testing.T) {
	p := &proc{}
	translateStr(t, p, `{"type":"message_start","message":{"role":"assistant","content":[]}}`)

	if got := translateStr(t, p, `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_1","toolName":"mcp__board__list_boards"}}`); !eventsEqual(got,
		[]agent.Event{{Kind: agent.EvToolStart, ToolID: "call_1", ToolName: "mcp__board__list_boards"}}) {
		t.Fatalf("toolcall_start gave %s", dump(got))
	}
	if got := translateStr(t, p, `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\"board\":"}}`); !eventsEqual(got,
		[]agent.Event{{Kind: agent.EvToolInputDelta, ToolID: "call_1", Text: `{"board":`}}) {
		t.Fatalf("toolcall_delta gave %s", dump(got))
	}
	if got := translateStr(t, p, `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"id":"call_1","name":"mcp__board__list_boards","arguments":{"board":"b1"}}}}`); !eventsEqual(got,
		[]agent.Event{{Kind: agent.EvToolInput, ToolID: "call_1", ToolName: "mcp__board__list_boards", Input: mustJSON(map[string]string{"board": "b1"})}}) {
		t.Fatalf("toolcall_end gave %s", dump(got))
	}
	// Execution events for a call already emitted produce nothing.
	if got := translateStr(t, p, `{"type":"tool_execution_start","toolCallId":"call_1","toolName":"mcp__board__list_boards","args":{"board":"b1"}}`); got != nil {
		t.Fatalf("tool_execution_start duplicated %s", dump(got))
	}
	if got := translateStr(t, p, `{"type":"tool_execution_end","toolCallId":"call_1","toolName":"mcp__board__list_boards","result":{"content":[{"type":"text","text":"ok"}]},"isError":false}`); !eventsEqual(got,
		[]agent.Event{{Kind: agent.EvToolResult, ToolID: "call_1", Result: "ok"}}) {
		t.Fatalf("tool_execution_end gave %s", dump(got))
	}
}

func TestNormalize(t *testing.T) {
	// Board tool names arrive from pi already namespaced and pass through unchanged.
	if got := normalize("mcp__board__list_boards"); got != "mcp__board__list_boards" {
		t.Errorf("normalize(namespaced board name) = %q, want pass-through", got)
	}
	// Raw native board names are no longer rewritten.
	for _, raw := range []string{"list_boards", "read_board", "get_view", "apply", "delete_elements", "create_board", "show_board"} {
		if got := normalize(raw); got != raw {
			t.Errorf("normalize(%q) = %q, want pass-through", raw, got)
		}
	}
	// The app subagent tool still becomes the Agent card.
	if got := normalize("subagent"); got != "Agent" {
		t.Errorf("normalize(subagent) = %q, want Agent", got)
	}
	if got := normalize("bash"); got != "bash" {
		t.Errorf("normalize(bash) = %q, want bash", got)
	}
}

func TestTranslateExecutionFirstDedupe(t *testing.T) {
	p := &proc{}
	args := mustJSON(map[string]string{"nonce": "abc"})
	if got := translateStr(t, p, `{"type":"tool_execution_start","toolCallId":"call_2","toolName":"subagent","args":{"nonce":"abc"}}`); !eventsEqual(got,
		[]agent.Event{{Kind: agent.EvToolStart, ToolID: "call_2", ToolName: "Agent"},
			{Kind: agent.EvToolInput, ToolID: "call_2", ToolName: "Agent", Input: args}}) {
		t.Fatalf("execution-first start gave %s", dump(got))
	}
	// The streamed start/input that follow must not duplicate it.
	if got := translateStr(t, p, `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"id":"call_2","toolName":"subagent"}}`); got != nil {
		t.Fatalf("toolcall_start duplicated %s", dump(got))
	}
	if got := translateStr(t, p, `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"id":"call_2","name":"subagent","arguments":{"nonce":"abc"}}}}`); got != nil {
		t.Fatalf("toolcall_end duplicated %s", dump(got))
	}
	if got := translateStr(t, p, `{"type":"tool_execution_end","toolCallId":"call_2","toolName":"subagent","result":{"content":[{"type":"text","text":"err"}],"details":{}},"isError":true}`); !eventsEqual(got,
		[]agent.Event{{Kind: agent.EvToolResult, ToolID: "call_2", Result: "err", IsError: true}}) {
		t.Fatalf("tool_execution_end gave %s", dump(got))
	}
}

func TestTranslateExecutionUpdateIsProgressNotInput(t *testing.T) {
	p := &proc{}
	if got := translateStr(t, p, `{"type":"tool_execution_update","toolCallId":"t1","toolName":"bash","partialResult":{"content":[{"type":"text","text":"working"}]}}`); got != nil {
		t.Fatalf("non-subagent update gave %s, want nothing", dump(got))
	}
	got := translateStr(t, p, `{"type":"tool_execution_update","toolCallId":"t2","toolName":"subagent","partialResult":{"content":[{"type":"text","text":"child says hi"}]}}`)
	want := []agent.Event{{Kind: agent.EvSub, Sub: "t2", SubInfo: &agent.SubInfo{Progress: "child says hi"}}}
	if !eventsEqual(got, want) {
		t.Fatalf("subagent update gave %s\nwant %s", dump(got), dump(want))
	}
	for _, ev := range got {
		if ev.Kind == agent.EvToolInputDelta || ev.Kind == agent.EvToolInput {
			t.Fatalf("execution update leaked tool input: %s", dump(got))
		}
	}
}

func TestTranslateMessageEndUsage(t *testing.T) {
	p := &proc{}
	p.modelWindow.Store(1000)
	if got := translateStr(t, p, `{"type":"message_end","message":{"role":"assistant","usage":{"input":10,"output":5,"cacheRead":100,"cacheWrite":50}}}`); !eventsEqual(got,
		[]agent.Event{{Kind: agent.EvUsage, CtxIn: 160, CtxOut: 5, CtxWindow: 1000}}) {
		t.Fatalf("assistant message_end gave %s", dump(got))
	}
	if got := translateStr(t, p, `{"type":"message_end","message":{"role":"toolResult","usage":{"input":1}}}`); got != nil {
		t.Fatalf("toolResult message_end gave %s, want nothing", dump(got))
	}
}

func TestSettledStatsTurnEnd(t *testing.T) {
	p, w := unitProc()
	p.translateLine([]byte(`{"type":"agent_settled"}`))
	cmds := w.commands(t)
	if len(cmds) != 1 || cmds[0]["type"] != "get_session_stats" {
		t.Fatalf("commands %v, want one get_session_stats", cmds)
	}
	id := str(cmds[0]["id"])
	p.rpc.handleLine([]byte(fmt.Sprintf(`{"type":"response","id":%q,"command":"get_session_stats","success":true,"data":{"contextUsage":{"tokens":300,"contextWindow":1000}}}`, id)))
	got := drainEvents(p)
	want := []agent.Event{{Kind: agent.EvUsage, CtxIn: 300, CtxWindow: 1000}, {Kind: agent.EvTurnEnd}}
	if !eventsEqual(got, want) {
		t.Fatalf("settled events %s\nwant %s", dump(got), dump(want))
	}
}

func TestSettledStatsFailureStillEndsTurn(t *testing.T) {
	p, w := unitProc()
	p.translateLine([]byte(`{"type":"agent_settled"}`))
	id := str(w.commands(t)[0]["id"])
	p.rpc.handleLine([]byte(fmt.Sprintf(`{"type":"response","id":%q,"command":"get_session_stats","success":false,"error":"nope"}`, id)))
	got := drainEvents(p)
	if !eventsEqual(got, []agent.Event{{Kind: agent.EvTurnEnd}}) {
		t.Fatalf("failed stats gave %s, want only the turn end", dump(got))
	}

	// A null usage (right after compaction) also ends the turn without a usage event.
	p, w = unitProc()
	p.translateLine([]byte(`{"type":"agent_settled"}`))
	id = str(w.commands(t)[0]["id"])
	p.rpc.handleLine([]byte(fmt.Sprintf(`{"type":"response","id":%q,"command":"get_session_stats","success":true,"data":{"contextUsage":{"tokens":null,"contextWindow":1000}}}`, id)))
	if got := drainEvents(p); !eventsEqual(got, []agent.Event{{Kind: agent.EvTurnEnd}}) {
		t.Fatalf("null usage gave %s", dump(got))
	}
}

func TestSettledAfterUserAbort(t *testing.T) {
	p, w := unitProc()
	p.abortMu.Lock()
	p.abortPending = true
	p.abortMu.Unlock()
	p.translateLine([]byte(`{"type":"agent_settled"}`))
	id := str(w.commands(t)[0]["id"])
	p.rpc.handleLine([]byte(fmt.Sprintf(`{"type":"response","id":%q,"command":"get_session_stats","success":true,"data":{"contextUsage":{"tokens":10,"contextWindow":100}}}`, id)))
	got := drainEvents(p)
	want := []agent.Event{{Kind: agent.EvUsage, CtxIn: 10, CtxWindow: 100}, {Kind: agent.EvTurnEnd, Aborted: true}}
	if !eventsEqual(got, want) {
		t.Fatalf("aborted settled events %s\nwant %s", dump(got), dump(want))
	}
	// The flag was consumed: the next settle is not aborted.
	p.abortMu.Lock()
	rest := p.abortPending
	p.abortMu.Unlock()
	if rest {
		t.Error("abort flag was not consumed")
	}
}

func TestTranslateMalformedAndUnknown(t *testing.T) {
	p, _ := unitProc()
	p.translateLine([]byte("not json"))
	p.translateLine([]byte(`{"type":"unknown"}`))
	p.translateLine([]byte{0xff, 0xfe, '\n'})
	if got := drainEvents(p); len(got) != 0 {
		t.Fatalf("malformed lines gave %s", dump(got))
	}
}

func TestActivityMapping(t *testing.T) {
	sub := &agent.SubIdentity{Parent: "tool-1", Depth: 0, Child: "child-1"}
	yes := true
	cases := []struct {
		name string
		act  agent.SubActivity
		want []agent.Event
	}{
		{"start", agent.SubActivity{Type: "start", ID: "ignored", AgentType: "general", Description: "d",
			Prompt: "p", Model: "m", Background: true},
			[]agent.Event{{Kind: agent.EvSub, Sub: "tool-1", SubInfo: &agent.SubInfo{ID: "child-1", Type: "general",
				Description: "d", Prompt: "p", Model: "m", Background: &yes, Status: model.SubRunning}}}},
		{"thinking", agent.SubActivity{Type: "thinking"},
			[]agent.Event{{Kind: agent.EvThinking, Sub: "tool-1"}}},
		{"text", agent.SubActivity{Type: "text", Text: "hi"},
			[]agent.Event{{Kind: agent.EvTextDelta, Sub: "tool-1", Text: "hi"}}},
		{"tool_start", agent.SubActivity{Type: "tool_start", ID: "ct1", Name: "mcp__board__list_boards"},
			[]agent.Event{{Kind: agent.EvToolStart, Sub: "tool-1", ToolID: "ct1", ToolName: "mcp__board__list_boards"}}},
		{"tool_start subagent", agent.SubActivity{Type: "tool_start", ID: "ct2", Name: "subagent"},
			[]agent.Event{{Kind: agent.EvToolStart, Sub: "tool-1", ToolID: "ct2", ToolName: "Agent"}}},
		{"tool_input", agent.SubActivity{Type: "tool_input", ID: "ct3", Name: "mcp__board__apply", Input: mustJSON(map[string]string{"board": "b"})},
			[]agent.Event{{Kind: agent.EvToolInput, Sub: "tool-1", ToolID: "ct3", ToolName: "mcp__board__apply",
				Input: mustJSON(map[string]string{"board": "b"})}}},
		{"tool_result", agent.SubActivity{Type: "tool_result", ID: "ct3", Result: "ok", IsError: true},
			[]agent.Event{{Kind: agent.EvToolResult, Sub: "tool-1", ToolID: "ct3", Result: "ok", IsError: true}}},
		{"usage", agent.SubActivity{Type: "usage", Tokens: 100, Window: 1000, ToolUses: 3},
			[]agent.Event{{Kind: agent.EvSub, Sub: "tool-1", SubInfo: &agent.SubInfo{Tokens: 100, Window: 1000, ToolUses: 3}}}},
		{"progress", agent.SubActivity{Type: "progress", Text: "halfway"},
			[]agent.Event{{Kind: agent.EvSub, Sub: "tool-1", SubInfo: &agent.SubInfo{Progress: "halfway"}}}},
		{"done completed", agent.SubActivity{Type: "done", Status: "completed", Summary: "s", Tokens: 5, Window: 6, ToolUses: 1},
			[]agent.Event{{Kind: agent.EvSub, Sub: "tool-1", SubInfo: &agent.SubInfo{Status: model.SubCompleted,
				Summary: "s", Tokens: 5, Window: 6, ToolUses: 1}}}},
		{"done failed", agent.SubActivity{Type: "done", Status: "failed", Error: "e"},
			[]agent.Event{{Kind: agent.EvSub, Sub: "tool-1", SubInfo: &agent.SubInfo{Status: model.SubFailed, Error: "e"}}}},
		{"done stopped", agent.SubActivity{Type: "done", Status: "stopped"},
			[]agent.Event{{Kind: agent.EvSub, Sub: "tool-1", SubInfo: &agent.SubInfo{Status: model.SubStopped}}}},
		{"unknown", agent.SubActivity{Type: "future"}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := mapActivity(sub, c.act); !eventsEqual(got, c.want) {
				t.Fatalf("mapActivity gave %s\nwant %s", dump(got), dump(c.want))
			}
		})
	}
}

func TestActivityQueuedBeforeAnnounce(t *testing.T) {
	p, _ := unitProc()
	sub := &agent.SubIdentity{Parent: "inner-1", Depth: 1, Child: "grandchild"}
	p.Activity(sub, agent.SubActivity{Type: "text", Text: "hi"})
	if got := drainEvents(p); len(got) != 0 {
		t.Fatalf("activity was emitted before its parent card: %s", dump(got))
	}
	// The parent's tool card arrives: the queued activity flushes behind it.
	p.emitEvents([]agent.Event{{Kind: agent.EvToolStart, ToolID: "inner-1", ToolName: "Agent"}})
	got := drainEvents(p)
	want := []agent.Event{
		{Kind: agent.EvToolStart, ToolID: "inner-1", ToolName: "Agent"},
		{Kind: agent.EvTextDelta, Sub: "inner-1", Text: "hi"},
	}
	if !eventsEqual(got, want) {
		t.Fatalf("flush gave %s\nwant %s", dump(got), dump(want))
	}
}

func TestActivityNestedToolStartAnnounces(t *testing.T) {
	p, _ := unitProc()
	// The outer Agent card is already on stream.
	p.emitEvents([]agent.Event{{Kind: agent.EvToolStart, ToolID: "outer-1", ToolName: "Agent"}})
	drainEvents(p)
	outer := &agent.SubIdentity{Parent: "outer-1", Depth: 0, Child: "child"}
	p.Activity(outer, agent.SubActivity{Type: "tool_start", ID: "inner-2", Name: "subagent"})
	if got := drainEvents(p); !eventsEqual(got, []agent.Event{{Kind: agent.EvToolStart, Sub: "outer-1", ToolID: "inner-2", ToolName: "Agent"}}) {
		t.Fatalf("nested tool start gave %s", dump(got))
	}
	// inner-2 is now announced: a grandchild talks immediately.
	p.Activity(&agent.SubIdentity{Parent: "inner-2", Depth: 1, Child: "grandchild"},
		agent.SubActivity{Type: "thinking"})
	if got := drainEvents(p); !eventsEqual(got, []agent.Event{{Kind: agent.EvThinking, Sub: "inner-2"}}) {
		t.Fatalf("grandchild activity gave %s", dump(got))
	}
}

func TestActivityProgressIsBounded(t *testing.T) {
	long := strings.Repeat("x", maxProgress+100)
	got := mapActivity(&agent.SubIdentity{Parent: "t"}, agent.SubActivity{Type: "progress", Text: long})
	if len(got) != 1 || got[0].SubInfo == nil || len(got[0].SubInfo.Progress) != maxProgress {
		t.Fatalf("progress %d events, want one bounded at %d", len(got), maxProgress)
	}
	if !strings.HasSuffix(got[0].SubInfo.Progress, "x") {
		t.Error("bounded progress lost its tail")
	}
}

func TestTranslateExtensionErrorLoggedOnce(t *testing.T) {
	p := &proc{}
	line := `{"type":"extension_error","extensionPath":"/x/index.ts","event":"tool_call","error":"boom"}`
	for i := 0; i < 3; i++ {
		if got := translateStr(t, p, line); got != nil {
			t.Fatalf("extension_error gave %s", dump(got))
		}
	}
}

func TestRawJSON(t *testing.T) {
	if rawJSON(nil) != nil {
		t.Error("rawJSON(nil) is not nil")
	}
	if got := string(rawJSON(map[string]int{"a": 1})); got != `{"a":1}` {
		t.Errorf("rawJSON = %s", got)
	}
	if !jsonEqual(rawJSON(4), json.RawMessage("4")) {
		t.Error("rawJSON(4) differs")
	}
}
