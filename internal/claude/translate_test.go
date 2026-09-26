package claude

import (
	"encoding/json"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
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

func TestTranslateParentContextWindow(t *testing.T) {
	result := `{"type":"result","is_error":false,"num_turns":1,"terminal_reason":"completed","modelUsage":{"claude-haiku-4-5":{"contextWindow":200000},"claude-sonnet-5":{"contextWindow":1000000}}}`
	p := &proc{}
	translateLine(t, p, `{"type":"system","subtype":"init","model":"claude-haiku-4-5"}`)
	if evs := translateLine(t, p, result); len(evs) != 2 || evs[0].CtxWindow != 200000 {
		t.Errorf("with init: %+v, want the parent model's window (200000)", evs)
	}
	if evs := translateLine(t, &proc{}, result); len(evs) != 2 || evs[0].CtxWindow != 0 {
		t.Errorf("no init, two entries: %+v, want 0 (unchanged)", evs)
	}
	one := `{"type":"result","is_error":false,"num_turns":1,"terminal_reason":"completed","modelUsage":{"x":{"contextWindow":300000}}}`
	if evs := translateLine(t, &proc{}, one); len(evs) != 2 || evs[0].CtxWindow != 300000 {
		t.Errorf("no init, one entry: %+v, want that entry (300000)", evs)
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

func TestTranslateSubagentLines(t *testing.T) {
	f, tr := false, true
	cases := []struct {
		line string
		want []agent.Event
	}{
		{`{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"toolu_T","description":"Look around","task_type":"local_agent","subagent_type":"general-purpose","prompt":"List the files","is_backgrounded":false}`,
			[]agent.Event{{Kind: agent.EvSub, Sub: "toolu_T", SubInfo: &agent.SubInfo{ID: "a1", Type: "general-purpose",
				Description: "Look around", Prompt: "List the files", Background: &f, Status: model.SubRunning}}}},
		{`{"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"toolu_B","description":"ls","task_type":"local_bash"}`,
			nil},
		{`{"type":"assistant","message":{"id":"msg_s1","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":10,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000,"output_tokens":2},"content":[{"type":"text","text":"Looking."},{"type":"tool_use","id":"toolu_R","name":"Read","input":{"file_path":"a"}}]},"parent_tool_use_id":"toolu_T"}`,
			[]agent.Event{
				{Kind: agent.EvSub, Sub: "toolu_T", SubInfo: &agent.SubInfo{Model: "claude-haiku-4-5-20251001", Tokens: 3210, Window: 200000}},
				{Kind: agent.EvText, Sub: "toolu_T", MsgID: "msg_s1", Text: "Looking."},
				{Kind: agent.EvToolInput, Sub: "toolu_T", ToolID: "toolu_R", ToolName: "Read", Input: json.RawMessage(`{"file_path":"a"}`)},
			}},
		{`{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_R","type":"tool_result","content":"x"}]},"parent_tool_use_id":"toolu_T"}`,
			[]agent.Event{{Kind: agent.EvToolResult, Sub: "toolu_T", ToolID: "toolu_R", Result: "x"}}},
		{`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"List the files"}]},"parent_tool_use_id":"toolu_T"}`,
			nil},
		{`{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"hi"}},"parent_tool_use_id":"toolu_T"}`,
			nil},
		{`{"type":"system","subtype":"status","status":"requesting","parent_tool_use_id":"toolu_T"}`,
			nil},
		{`{"type":"system","subtype":"task_progress","task_id":"a1","summary":"Reading files","usage":{"total_tokens":5000,"tool_uses":3}}`,
			[]agent.Event{{Kind: agent.EvSub, Sub: "toolu_T", SubInfo: &agent.SubInfo{Progress: "Reading files", Tokens: 5000, ToolUses: 3, Window: 200000}}}},
		{`{"type":"system","subtype":"task_updated","task_id":"a1","patch":{"status":"killed"}}`,
			[]agent.Event{{Kind: agent.EvSub, Sub: "toolu_T", SubInfo: &agent.SubInfo{Status: model.SubStopped, Window: 200000}}}},
		{`{"type":"system","subtype":"task_updated","task_id":"a1","patch":{"is_backgrounded":true}}`,
			[]agent.Event{{Kind: agent.EvSub, Sub: "toolu_T", SubInfo: &agent.SubInfo{Background: &tr, Window: 200000}}}},
		{`{"type":"system","subtype":"task_updated","task_id":"a1","patch":{"status":"failed","error":"x"}}`,
			[]agent.Event{{Kind: agent.EvSub, Sub: "toolu_T", SubInfo: &agent.SubInfo{Status: model.SubFailed, Error: "x", Window: 200000}}}},
		{`{"type":"system","subtype":"task_notification","task_id":"a1","status":"completed","summary":"Found 3 files.","usage":{"total_tokens":6000,"tool_uses":4}}`,
			[]agent.Event{{Kind: agent.EvSub, Sub: "toolu_T", SubInfo: &agent.SubInfo{Status: model.SubCompleted, Summary: "Found 3 files.", Tokens: 6000, ToolUses: 4, Window: 200000}}}},
		{`{"type":"system","subtype":"task_notification","task_id":"zz","status":"completed","summary":"?"}`,
			nil},
	}
	p := &proc{}
	for _, c := range cases {
		got := translateLine(t, p, c.line)
		if !eventsEqual(got, c.want) {
			t.Errorf("translate(%s)\n got  %s\n want %s", c.line, dump(got), dump(c.want))
		}
	}
}

func TestTranslateWindowFromModelUsage(t *testing.T) {
	p := &proc{}
	translateLine(t, p, `{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"toolu_T","task_type":"local_agent"}`)
	translateLine(t, p, `{"type":"result","is_error":false,"num_turns":1,"terminal_reason":"completed","modelUsage":{"claude-haiku-4-5-20251001":{"contextWindow":150000}}}`)
	evs := translateLine(t, p, `{"type":"assistant","message":{"id":"m","model":"claude-haiku-4-5-20251001","content":[]},"parent_tool_use_id":"toolu_T"}`)
	if len(evs) != 1 || evs[0].SubInfo == nil || evs[0].SubInfo.Window != 150000 {
		t.Errorf("events %s, want an EvSub with Window 150000", dump(evs))
	}
}

func TestTranslateResumeOrphanResult(t *testing.T) {
	empty := `{"type":"result","subtype":"success","is_error":false,"num_turns":0,"terminal_reason":"completed"}`
	p := &proc{}
	if evs := translateLine(t, p, `{"type":"system","subtype":"task_notification","task_id":"lost","status":"stopped","summary":"x"}`); len(evs) != 0 {
		t.Errorf("orphan notification gave %s", dump(evs))
	}
	if evs := translateLine(t, p, empty); len(evs) != 0 {
		t.Errorf("empty result after an orphan gave %s", dump(evs))
	}
	evs := translateLine(t, p, `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"terminal_reason":"completed"}`)
	if len(evs) != 2 || evs[0].Kind != agent.EvUsage || evs[1].Kind != agent.EvTurnEnd {
		t.Errorf("real result gave %s, want EvUsage + EvTurnEnd", dump(evs))
	}
	evs = translateLine(t, &proc{}, empty)
	if len(evs) != 2 || evs[1].Kind != agent.EvTurnEnd {
		t.Errorf("num_turns 0 without an orphan gave %s, want the turn to end", dump(evs))
	}
}

// dump prints events with their SubInfo spelled out.
func dump(evs []agent.Event) string {
	b, _ := json.Marshal(evs)
	return string(b)
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
