package claude

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
)

func TestClaudeTemporaryTable(t *testing.T) {
	cases := []struct {
		class string
		// want is the class for a turn the CLI retried and for one it did not
		retried, plain agent.Temporary
	}{
		{"authentication_failed", agent.TempLogin, agent.TempLogin},
		{"cloud_credential_error", agent.TempLogin, agent.TempLogin},
		{"rate_limit", agent.TempRate, agent.TempRate},
		{"overloaded", agent.TempOverloaded, agent.TempOverloaded},
		{"server_error", agent.TempServer, agent.TempServer},
		{"billing_error", "", ""},
		{"invalid_request", "", ""},
		{"model_not_found", "", ""},
		{"max_output_tokens", "", ""},
		{"oauth_org_not_allowed", "", ""},
		{"account_on_hold", "", ""},
		{"verification_required", "", ""},
		{"unknown", agent.TempRetried, ""},
		{"", agent.TempRetried, ""},
		{"a_class_of_a_newer_cli", agent.TempRetried, ""},
	}
	for _, c := range cases {
		if got := claudeTemporary(c.class, "", true); got != c.retried {
			t.Errorf("class %q retried: %q, want %q", c.class, got, c.retried)
		}
		if got := claudeTemporary(c.class, "", false); got != c.plain {
			t.Errorf("class %q not retried: %q, want %q", c.class, got, c.plain)
		}
		// With no class on the assistant line, the class of the CLI's retry lines is used.
		if got := claudeTemporary("", c.class, true); c.class != "" && got != c.retried {
			t.Errorf("retry class %q: %q, want %q", c.class, got, c.retried)
		}
		if got := claudeTemporary("", c.class, false); c.class != "" && got != c.plain {
			t.Errorf("retry class %q without retried: %q, want %q", c.class, got, c.plain)
		}
	}
	// The assistant line's class wins over the retry lines'.
	if got := claudeTemporary("billing_error", "overloaded", true); got != "" {
		t.Errorf("billing after overloaded retries: %q, want none", got)
	}
}

// replayTurns plays a fixture through p and returns the turn ends.
func replayTurns(t *testing.T, p *proc, file string) []agent.Event {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", file))
	if err != nil {
		t.Fatal(err)
	}
	var ends []agent.Event
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		for _, ev := range translateLine(t, p, line) {
			if ev.Kind == agent.EvTurnEnd {
				ends = append(ends, ev)
			}
		}
	}
	return ends
}

// Six of the fixtures are synthesized in the shape of the real ones (api_error_auth.jsonl and
// api_error_model.jsonl): their classes and texts are those of Claude Code 2.1.309's strings. The end
// of the refresh text is [not verified]: only its start was read from the binary.
func TestTemporaryOfAPIErrorTurns(t *testing.T) {
	cases := []struct {
		file string
		want agent.Temporary
		err  string
	}{
		{"api_error_auth.jsonl", agent.TempLogin, "Failed to authenticate. API Error: 401 API key is invalid."},
		{"api_error_model.jsonl", "", "There's an issue with the selected model (claude-no-such-model-j4). It may not exist or you may not have access to it. Run --model to pick a different model."},
		{"api_error_overloaded.jsonl", agent.TempOverloaded, "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment."},
		{"api_error_rate.jsonl", agent.TempRate, "API Error: 429 Rate limited."},
		{"api_error_refresh.jsonl", agent.TempServer, "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute."},
		{"api_error_billing.jsonl", "", "Credit balance is too low"},
		{"api_error_unknown_retried.jsonl", agent.TempRetried, "API Error: 500 Internal server error"},
		{"api_error_unknown.jsonl", "", "An unknown error occurred"},
	}
	for _, c := range cases {
		ends := replayTurns(t, &proc{}, c.file)
		if len(ends) != 1 || ends[0].Error != c.err || ends[0].Temporary != c.want || ends[0].Aborted {
			t.Errorf("%s: turn ends %s, want one with error %q and Temporary %q", c.file, dump(ends), c.err, c.want)
		}
	}
}

func TestAbortedIsNeverTemporary(t *testing.T) {
	p := &proc{}
	translateLine(t, p, `{"type":"assistant","message":{"id":"m1","model":"<synthetic>","content":[{"type":"text","text":"API Error: 529 Overloaded"}]},"parent_tool_use_id":null,"error":"overloaded","is_api_error_message":true}`)
	evs := translateLine(t, p, `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming","num_turns":1}`)
	end := evs[len(evs)-1]
	if end.Kind != agent.EvTurnEnd || !end.Aborted || end.Temporary != "" {
		t.Errorf("aborted turn ended %+v, want aborted with no Temporary", end)
	}
}

func TestTemporaryClearedAfterEachResult(t *testing.T) {
	p := &proc{}
	if ends := replayTurns(t, p, "api_error_auth.jsonl"); len(ends) != 1 || ends[0].Temporary != agent.TempLogin {
		t.Fatalf("first turn ends %s, want login", dump(ends))
	}
	evs := translateLine(t, p, `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom","num_turns":1}`)
	end := evs[len(evs)-1]
	if end.Kind != agent.EvTurnEnd || end.Error != "boom" || end.Temporary != "" {
		t.Errorf("second turn ended %+v, want error boom and no Temporary", end)
	}
}

func TestSubagentAPIErrorLinesIgnored(t *testing.T) {
	p := &proc{}
	translateLine(t, p, `{"type":"assistant","message":{"id":"m1","model":"<synthetic>","content":[{"type":"text","text":"API Error: 529 Overloaded"}]},"parent_tool_use_id":"toolu_1","error":"overloaded","is_api_error_message":true}`)
	translateLine(t, p, `{"type":"system","subtype":"api_retry","attempt":1,"error_status":500,"error":"server_error","parent_tool_use_id":"toolu_1"}`)
	evs := translateLine(t, p, `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom","num_turns":1}`)
	end := evs[len(evs)-1]
	if end.Kind != agent.EvTurnEnd || end.Error != "boom" || end.Temporary != "" {
		t.Errorf("turn ended %+v, want error boom and no Temporary", end)
	}
}
