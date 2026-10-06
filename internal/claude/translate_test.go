package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// Sample stream-json lines of one Claude turn, in the order they arrive.
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
		[]agent.Event{{Kind: agent.EvUsage, CtxWindow: 200000},
			{Kind: agent.EvTurnEnd, NumTurns: 3, OutTokens: 40, Final: "Done. The new revision number is **2**."}}},
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
		{`{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_tools"}`, true, ""},
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

// The result line's cost and token numbers go out as they are: total_cost_usd and modelUsage are
// cumulative for the process, num_turns and usage are the turn's. The lines are those of a real
// session (Claude Code 2.1.284): a turn, and the first turn of the process that resumed it.
func TestTranslateResultCost(t *testing.T) {
	turn := `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.0278674,"num_turns":1,"duration_ms":5118,"result":"Four.","result_index":1,` +
		`"usage":{"input_tokens":10,"cache_creation_input_tokens":223,"cache_read_input_tokens":19231,"output_tokens":342},` +
		`"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":52,"outputTokens":1155,"costUSD":0.0278674,"contextWindow":200000}},"terminal_reason":"completed"}`
	evs := translateLine(t, &proc{}, turn)
	want := agent.Event{Kind: agent.EvTurnEnd, CostUSD: 0.0278674, HasCost: true, NumTurns: 1, OutTokens: 342, CumOutTokens: 1155, Final: "Four.",
		CumTokens: model.TokenCount{In: 52, Out: 1155}, HasTokens: true}
	if len(evs) != 2 || !reflect.DeepEqual(evs[1], want) {
		t.Errorf("turn end %s\nwant %s", dump(evs), dump([]agent.Event{want}))
	}

	// Two models in one process (a subagent's, or plan mode's): the cumulative output is their sum.
	two := `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.155,"num_turns":4,"result":"ok",` +
		`"usage":{"output_tokens":270},"modelUsage":{"claude-haiku-4-5-20251001":{"outputTokens":1425},"claude-sonnet-5-5":{"outputTokens":600}}}`
	evs = translateLine(t, &proc{}, two)
	if len(evs) != 2 || evs[1].CumOutTokens != 2025 || evs[1].OutTokens != 270 || evs[1].CostUSD != 0.155 || !evs[1].HasCost {
		t.Errorf("two models: %s", dump(evs))
	}

	// The four token counts are the sums over the models, cumulative for the process as the cost is.
	// (The counters' names are Claude Code's; the numbers here are made up.)
	usage := `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.2,"num_turns":2,"result":"ok","usage":{"output_tokens":270},` +
		`"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":52,"outputTokens":1425,"cacheReadInputTokens":19231,"cacheCreationInputTokens":223,"contextWindow":200000},` +
		`"claude-sonnet-5-5":{"inputTokens":8,"outputTokens":600,"cacheReadInputTokens":769,"cacheCreationInputTokens":4000}}}`
	evs = translateLine(t, &proc{}, usage)
	if tok := (model.TokenCount{In: 60, Out: 2025, CacheRead: 20000, CacheWrite: 4223}); len(evs) != 2 || evs[1].CumTokens != tok || !evs[1].HasTokens || evs[1].CumOutTokens != 2025 {
		t.Errorf("token counts: %s", dump(evs))
	}

	// An interrupted turn still reports what the process has spent; it has no result text.
	stopped := `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_tools","stop_reason":"tool_use","total_cost_usd":0.010191,"num_turns":4,` +
		`"errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],"usage":{"output_tokens":120},"modelUsage":{"claude-haiku-4-5-20251001":{"outputTokens":120}}}`
	evs = translateLine(t, &proc{}, stopped)
	want = agent.Event{Kind: agent.EvTurnEnd, Aborted: true, CostUSD: 0.010191, HasCost: true, NumTurns: 4, OutTokens: 120, CumOutTokens: 120,
		CumTokens: model.TokenCount{Out: 120}, HasTokens: true}
	if len(evs) != 2 || !reflect.DeepEqual(evs[1], want) {
		t.Errorf("stopped turn %s\nwant %s", dump(evs), dump([]agent.Event{want}))
	}

	// A cost of 0 that was reported is still a report; a line without the field reports none.
	if evs := translateLine(t, &proc{}, `{"type":"result","is_error":false,"num_turns":1,"total_cost_usd":0}`); !evs[1].HasCost || evs[1].CostUSD != 0 {
		t.Errorf("zero cost: %s", dump(evs))
	} else if evs[1].HasTokens {
		t.Errorf("a line without modelUsage reports tokens: %s", dump(evs))
	}
	if evs := translateLine(t, &proc{}, `{"type":"result","is_error":false,"num_turns":1}`); evs[1].HasCost {
		t.Errorf("no cost field: %s", dump(evs))
	}
}

// --resume of a session Claude does not have: the result line Claude Code 2.1.284 writes about a
// second after the start, before any message. Its only text is in errors[].
func TestTranslateNoSession(t *testing.T) {
	line := `{"type":"result","subtype":"error_during_execution","duration_ms":0,"duration_api_ms":0,"is_error":true,"num_turns":0,"stop_reason":null,"session_id":"dfe38768","total_cost_usd":0,"modelUsage":{},"errors":["No conversation found with session ID: dfe38768"],"result_index":0}`
	evs := translateLine(t, &proc{}, line)
	want := agent.Event{Kind: agent.EvTurnEnd, Error: "No conversation found with session ID: dfe38768", NoSession: true, HasCost: true}
	if len(evs) != 2 || !reflect.DeepEqual(evs[1], want) {
		t.Errorf("turn end %s\nwant %s", dump(evs), dump([]agent.Event{want}))
	}

	for name, line := range map[string]string{
		"another error":        `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["Error: Session ID x is already in use."]}`,
		"a turn that ran":      `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":2,"errors":["No conversation found with session ID: x"]}`,
		"not an error":         `{"type":"result","subtype":"success","is_error":false,"num_turns":0,"errors":["No conversation found with session ID: x"]}`,
		"the text as a result": `{"type":"result","subtype":"success","is_error":true,"num_turns":0,"result":"No conversation found with session ID: x"}`,
	} {
		if evs := translateLine(t, &proc{}, line); len(evs) != 2 || evs[1].NoSession {
			t.Errorf("%s: %s, want no NoSession", name, dump(evs))
		}
	}
}

// An errored result without result text takes its text from errors[], unless that is only a line
// of the CLI's own diagnostics.
func TestTranslateResultErrorsList(t *testing.T) {
	cases := []struct{ line, err string }{
		{`{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,"errors":["Error: Session ID x is already in use."]}`,
			"Error: Session ID x is already in use."},
		{`{"type":"result","subtype":"success","is_error":true,"result":"model not found","errors":["something else"],"terminal_reason":"api_error"}`,
			"model not found"},
		{`{"type":"result","subtype":"error_during_execution","is_error":true,"errors":[],"terminal_reason":"max_turns"}`,
			"Error: max_turns"},
		{`{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],"terminal_reason":"max_turns"}`,
			"Error: max_turns"},
		{`{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["[ede_diagnostic] x"]}`,
			"Error: unknown"},
	}
	for _, c := range cases {
		if evs := translateLine(t, &proc{}, c.line); len(evs) != 2 || evs[1].Error != c.err || evs[1].Aborted {
			t.Errorf("translate(%s): %s, want the error %q", c.line, dump(evs), c.err)
		}
	}
}

// The fixtures are the lines Claude Code 2.1.284 wrote for real turns the API refused: a model id
// it does not know, and a key it rejects (after the CLI's own retries). The init line is cut down
// to the fields testdata/usage.jsonl keeps; the other lines are as written.
func TestTranslateAPIErrorTurn(t *testing.T) {
	cases := []struct {
		file, err string
	}{
		{"api_error_model.jsonl", "There's an issue with the selected model (claude-no-such-model-j4). It may not exist or you may not have access to it. Run --model to pick a different model."},
		{"api_error_auth.jsonl", "Failed to authenticate. API Error: 401 API key is invalid."},
	}
	for _, c := range cases {
		raw, err := os.ReadFile(filepath.Join("testdata", c.file))
		if err != nil {
			t.Fatal(err)
		}
		p := &proc{}
		var ends []agent.Event
		for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			for _, ev := range translateLine(t, p, line) {
				switch ev.Kind {
				case agent.EvText, agent.EvTextStart, agent.EvTextDelta, agent.EvToolStart, agent.EvToolInput, agent.EvPermRequest:
					t.Errorf("%s: the CLI's error arrived as model output: %s", c.file, dump([]agent.Event{ev}))
				case agent.EvTurnEnd:
					ends = append(ends, ev)
				}
			}
		}
		if len(ends) != 1 || ends[0].Error != c.err || ends[0].Aborted {
			t.Errorf("%s: turn ends %s, want one with error %q", c.file, dump(ends), c.err)
		}
	}

	// The mark decides, with or without the "<synthetic>" model name; an unmarked line is text.
	marked := `{"type":"assistant","message":{"id":"m1","model":"claude-haiku-4-5","content":[{"type":"text","text":"API Error: 529 Overloaded"}]},"parent_tool_use_id":null,"error":"overloaded","is_api_error_message":true}`
	if evs := translateLine(t, &proc{}, marked); len(evs) != 0 {
		t.Errorf("marked line gave %s, want nothing", dump(evs))
	}
	unmarked := `{"type":"assistant","message":{"id":"m1","model":"<synthetic>","content":[{"type":"text","text":"API Error: 529 Overloaded"}]},"parent_tool_use_id":null,"is_api_error_message":false}`
	if evs := translateLine(t, &proc{}, unmarked); !eventsEqual(evs, []agent.Event{{Kind: agent.EvText, MsgID: "m1", Text: "API Error: 529 Overloaded"}}) {
		t.Errorf("unmarked line gave %s, want its text", dump(evs))
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

// The fork point of a turn is the uuid of its last own assistant or user line (lines shaped like
// testdata/usage.jsonl), never message.id or the result line's uuid.
func TestTranslateForkPoint(t *testing.T) {
	const (
		result  = `{"type":"result","subtype":"success","is_error":false,"num_turns":1,"terminal_reason":"completed","session_id":"s","uuid":"uuid-result"}`
		aborted = `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","session_id":"s","uuid":"uuid-result"}`
		failed  = `{"type":"result","subtype":"success","is_error":true,"result":"model not found","terminal_reason":"api_error","num_turns":1,"uuid":"uuid-result"}`
		phantom = `{"type":"result","subtype":"success","is_error":false,"num_turns":0,"terminal_reason":"completed","uuid":"uuid-result"}`
		think   = `{"type":"assistant","message":{"id":"msg_1","content":[{"type":"thinking","thinking":"hm"}]},"parent_tool_use_id":null,"session_id":"s","uuid":"uuid-think"}`
		toolUse = `{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}]},"parent_tool_use_id":null,"session_id":"s","uuid":"uuid-tool-use"}`
		toolRes = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":"ok"}]},"parent_tool_use_id":null,"session_id":"s","uuid":"uuid-tool-result"}`
		text    = `{"type":"assistant","message":{"id":"msg_2","content":[{"type":"text","text":"ok"}]},"parent_tool_use_id":null,"session_id":"s","uuid":"uuid-text"}`
		partial = `{"type":"assistant","message":{"id":"msg_3","content":[{"type":"text","text":"I"}]},"parent_tool_use_id":null,"session_id":"s","uuid":"uuid-partial"}`
		stopped = `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]},"parent_tool_use_id":null,"session_id":"s","uuid":"uuid-interrupt"}`
		apiErr  = `{"type":"assistant","message":{"id":"e1","model":"<synthetic>","content":[{"type":"text","text":"model not found"}]},"parent_tool_use_id":null,"session_id":"s","uuid":"uuid-error","error":"model_not_found"}`
		subText = `{"type":"assistant","message":{"id":"msg_s","content":[{"type":"text","text":"sub"}]},"parent_tool_use_id":"toolu_T","session_id":"s","uuid":"uuid-sub-assistant"}`
		subRes  = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_R","type":"tool_result","content":"x"}]},"parent_tool_use_id":"toolu_T","session_id":"s","uuid":"uuid-sub-user"}`
		stream  = `{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":4}},"parent_tool_use_id":null,"session_id":"s","uuid":"uuid-stream"}`
		status  = `{"type":"system","subtype":"status","status":"requesting","session_id":"s","uuid":"uuid-status"}`
		lost    = `{"type":"system","subtype":"task_notification","task_id":"lost","status":"stopped","summary":"x","uuid":"uuid-lost"}`
	)
	// The turns of one process, in order: each ends with its result line.
	turns := []struct {
		name  string
		lines []string
		want  string // the Point of the turn's EvTurnEnd
		none  bool   // the result line gives no event
	}{
		{"last assistant line", []string{status, think, text, stream, result}, "uuid-text", false},
		{"no assistant or user line: nothing leaks from the turn before", []string{status, result}, "", false},
		{"tool result, then an assistant line", []string{toolUse, toolRes, text, result}, "uuid-text", false},
		{"a tool result last", []string{toolUse, toolRes, result}, "uuid-tool-result", false},
		{"subagent lines never count", []string{text, subText, subRes, result}, "uuid-text", false},
		{"only subagent lines", []string{subText, subRes, result}, "", false},
		{"interrupted", []string{partial, stopped, aborted}, "uuid-interrupt", false},
		{"failed", []string{apiErr, failed}, "uuid-error", false},
		{"the swallowed result of a lost agent", []string{lost, text, phantom}, "", true},
		{"nothing leaks from the swallowed result", []string{result}, "", false},
		{"a line without a uuid", []string{text, `{"type":"assistant","message":{"id":"msg_4","content":[]},"parent_tool_use_id":null}`, result}, "", false},
	}
	p := &proc{}
	for _, c := range turns {
		var evs []agent.Event
		for _, l := range c.lines {
			evs = translateLine(t, p, l)
		}
		if c.none {
			if len(evs) != 0 {
				t.Errorf("%s: the result line gave %s, want nothing", c.name, dump(evs))
			}
			continue
		}
		if len(evs) != 2 || evs[1].Kind != agent.EvTurnEnd {
			t.Fatalf("%s: the result line gave %s, want EvUsage + EvTurnEnd", c.name, dump(evs))
		}
		if evs[1].Point != c.want {
			t.Errorf("%s: Point %q, want %q", c.name, evs[1].Point, c.want)
		}
		if evs[0].Point != "" {
			t.Errorf("%s: EvUsage carries Point %q", c.name, evs[0].Point)
		}
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
