package claude

import (
	"encoding/json"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
)

// The sample lines of docs/research/claude-rpc.md section 2, in the order they arrive,
// with the trimmed parts ("…") filled in.
var sampleTurn = []struct {
	line string
	want []agent.Event
}{
	{`{"type":"system","subtype":"init","cwd":"/tmp/claude-rpc-multiturn","session_id":"9d9c65ba","tools":["Bash"],"mcp_servers":[{"name":"board","status":"connected","source":"dynamic"}],"model":"claude-haiku-4-5-20251001","permissionMode":"default","claude_code_version":"2.1.281","capabilities":["interrupt_receipt_v1"]}`,
		nil},
	{`{"type":"system","subtype":"status","status":"requesting","session_id":"9d9c65ba"}`,
		[]agent.Event{{Kind: agent.EvThinking}}},
	{`{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000,"output_tokens":1}}},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvUsage, CtxIn: 3210, CtxOut: 1}}},
	{`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvThinking}}},
	{`{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50}`,
		nil},
	{`{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvTextStart, MsgID: "msg_1"}}},
	{`{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hey"}},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvTextDelta, Text: "Hey"}}},
	{`{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_01VR","name":"Bash","input":{}}},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvToolStart, ToolID: "toolu_01VR", ToolName: "Bash"}}},
	{`{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"command\": \"curl -s"}},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvToolInputDelta, ToolID: "toolu_01VR", Text: `{"command": "curl -s`}}},
	{`{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvUsage, CtxOut: 42}}},
	// the complete message of the streamed one: its text is not repeated
	{`{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hey"},{"type":"tool_use","id":"toolu_01VR","name":"Bash","input":{"command":"curl -s x"}}]},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvToolInput, ToolID: "toolu_01VR", ToolName: "Bash", Input: json.RawMessage(`{"command":"curl -s x"}`)}}},
	{`{"type":"assistant","message":{"id":"msg_2","content":[{"type":"tool_use","id":"toolu_01Eb","name":"mcp__board__get_board","input":{}}]},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvToolInput, ToolID: "toolu_01Eb", ToolName: "mcp__board__get_board", Input: json.RawMessage(`{}`)}}},
	{`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01Eb","type":"tool_result","content":[{"type":"text","text":"{\"elements\":[],\"rev\":1}"}]}]},"tool_use_result":[]}`,
		[]agent.Event{{Kind: agent.EvToolResult, ToolID: "toolu_01Eb", Result: `{"elements":[],"rev":1}`}}},
	{`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01VR","type":"tool_result","content":"boom","is_error":true}]}}`,
		[]agent.Event{{Kind: agent.EvToolResult, ToolID: "toolu_01VR", Result: "boom", IsError: true}}},
	{`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"}}`,
		nil},
	{`{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_016n","message":"touch in 'made-by-agent.txt' needs approval."}`,
		[]agent.Event{{Kind: agent.EvToolDenied, ToolID: "toolu_016n"}}},
	// a message that was not streamed: its text arrives whole
	{`{"type":"assistant","message":{"id":"msg_3","model":"<synthetic>","content":[{"type":"text","text":"Done."}]},"parent_tool_use_id":null}`,
		[]agent.Event{{Kind: agent.EvText, MsgID: "msg_3", Text: "Done."}}},
	{`{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"Done. The new revision number is **2**.","session_id":"9d9c65ba","usage":{"input_tokens":10,"output_tokens":40},"modelUsage":{"claude-haiku-4-5-20251001":{"contextWindow":200000}},"duration_ms":5736,"permission_denials":[],"terminal_reason":"completed","stop_reason":"end_turn"}`,
		[]agent.Event{{Kind: agent.EvUsage, CtxWindow: 200000}, {Kind: agent.EvTurnEnd}}},
}

func translateLine(t *testing.T, p *proc, line string) []agent.Event {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("bad test line %s: %v", line, err)
	}
	return p.translate(m)
}

func TestTranslateSampleTurn(t *testing.T) {
	p := &proc{}
	for _, c := range sampleTurn {
		got := translateLine(t, p, c.line)
		if !eventsEqual(got, c.want) {
			t.Errorf("translate(%s)\n got  %+v\n want %+v", c.line, got, c.want)
		}
	}
}

func TestTranslateLargestContextWindow(t *testing.T) {
	evs := translateLine(t, &proc{}, `{"type":"result","is_error":false,"terminal_reason":"completed","modelUsage":{"a":{"contextWindow":200000},"b":{"contextWindow":1000000}}}`)
	if w := evs[0].CtxWindow; w != 1000000 {
		t.Errorf("window = %d, want the largest (1000000)", w)
	}
}

func TestTranslateResultErrors(t *testing.T) {
	cases := []struct {
		line    string
		aborted bool
		err     string
	}{
		{`{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"}`, true, ""},
		{`{"type":"result","subtype":"success","is_error":true,"result":"model not found","terminal_reason":"api_error","api_error_status":404}`, false, "model not found"},
		{`{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error"}`, false, "Error: api_error"},
	}
	for _, c := range cases {
		evs := translateLine(t, &proc{}, c.line)
		if len(evs) != 2 || evs[1].Kind != agent.EvTurnEnd {
			t.Fatalf("translate(%s) = %+v", c.line, evs)
		}
		if evs[1].Aborted != c.aborted || evs[1].Error != c.err {
			t.Errorf("translate(%s): aborted %v error %q, want %v %q", c.line, evs[1].Aborted, evs[1].Error, c.aborted, c.err)
		}
	}
}

func TestTranslateSubagentLinesGiveNothing(t *testing.T) {
	p := &proc{}
	lines := []string{
		`{"type":"system","subtype":"status","status":"requesting","parent_tool_use_id":"toolu_task"}`,
		`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hi"}},"parent_tool_use_id":"toolu_task"}`,
		`{"type":"assistant","message":{"id":"msg_sub","content":[{"type":"text","text":"sub"},{"type":"tool_use","id":"t","name":"Read","input":{}}]},"parent_tool_use_id":"toolu_task"}`,
		`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t","type":"tool_result","content":"x"}]},"parent_tool_use_id":"toolu_task"}`,
	}
	for _, l := range lines {
		if evs := translateLine(t, p, l); len(evs) != 0 {
			t.Errorf("subagent line %s gave %+v", l, evs)
		}
	}
}

// eventsEqual compares events, with JSON inputs compared by meaning.
func eventsEqual(a, b []agent.Event) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if !jsonEqual(x.Input, y.Input) {
			return false
		}
		x.Input, y.Input = nil, nil
		if !reflect.DeepEqual(x, y) {
			return false
		}
	}
	return true
}

func jsonEqual(a, b json.RawMessage) bool {
	if len(a) == 0 || len(b) == 0 {
		return len(a) == len(b)
	}
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	return reflect.DeepEqual(x, y)
}
