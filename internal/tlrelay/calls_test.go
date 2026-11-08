package tlrelay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/headless"
)

func toolCall(tool string) ToolCall {
	return ToolCall{
		Chat: "c_1", Branch: "main", ChatBoard: "b0", Board: "b1", Tool: tool,
		Args:  map[string]any{"ops": []any{map[string]any{"op": "delete", "key": "k"}}},
		Agent: Agent{Kind: "claude", Label: "Claude"},
	}
}

func TestCallToolSpec(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	g.br.call = func(spec editorbridge.CallSpec) (json.RawMessage, error) {
		g.clock.add(42 * time.Millisecond)
		return json.RawMessage(`{"text":"ok"}`), nil
	}
	res, err := g.r.CallTool(toolCall("apply"))
	if err != nil || string(res) != `{"text":"ok"}` {
		t.Fatalf("CallTool: %s %v", res, err)
	}
	if len(g.br.specs) != 1 {
		t.Fatalf("%d calls", len(g.br.specs))
	}
	spec := g.br.specs[0]
	if spec.Method != "tool" || spec.Board != "b1" || spec.Client != "h1" || spec.Lost != ErrHostLost || spec.Screen || spec.Away || spec.ChatBoard != "" {
		t.Fatalf("spec %+v", spec)
	}
	if g.br.timeouts[0] != g.r.callTimeout {
		t.Fatalf("timeout %v", g.br.timeouts[0])
	}
	j, _ := json.Marshal(spec.Params)
	var got map[string]any
	json.Unmarshal(j, &got)
	want := map[string]any{
		"chat": "c_1", "branch": "main", "board": "b0", "target": "b1", "name": "apply",
		"args": map[string]any{"ops": []any{map[string]any{"op": "delete", "key": "k"}}},
		"kind": "tl", "agent": map[string]any{"kind": "claude", "label": "Claude"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("params %s", j)
	}
	// RawMessage args go as they are
	c := toolCall("read_board")
	c.Args = json.RawMessage(`{"x":1}`)
	g.r.CallTool(c)
	j, _ = json.Marshal(g.br.specs[1].Params)
	if !regexp.MustCompile(`"args":\{"x":1\}`).Match(j) {
		t.Fatalf("params %s", j)
	}
	logs := g.logs()
	if len(logs) != 2 || logs[0] != "tl: apply board=b1 chat=c_1 -> board host ok 42ms" {
		t.Fatalf("log %q", logs)
	}
}

func TestCallToolOutcomes(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	cases := []struct {
		name    string
		err     error
		text    string // the error's text; "" for the host's own
		is      error
		log     string
		timeout bool
	}{
		{"host error", errors.New("BAD_ARGS: ops[0].key is unknown"), "BAD_ARGS: ops[0].key is unknown", nil, "error BAD_ARGS", false},
		{"no code", errors.New("something odd"), "something odd", nil, "error UNKNOWN", false},
		{"lost", ErrHostLost, HostStoppedText, ErrHostLost, "lost", false},
		{"gone before the send", editorbridge.ErrNoClient, HostStoppedText, ErrHostLost, "lost", false},
		{"timeout", fmt.Errorf("%w tool in 30s", editorbridge.ErrTimeout), TimeoutText, editorbridge.ErrTimeout, "timeout", true},
	}
	for i, c := range cases {
		g.br.mu.Lock()
		g.br.call = func(editorbridge.CallSpec) (json.RawMessage, error) { return nil, c.err }
		g.br.mu.Unlock()
		res, err := g.r.CallTool(toolCall(c.name))
		if res != nil || err == nil || err.Error() != c.text {
			t.Errorf("%s: %s %v", c.name, res, err)
		}
		if c.is != nil && !errors.Is(err, c.is) {
			t.Errorf("%s: %v is not %v", c.name, err, c.is)
		}
		if l := g.logs()[i]; l != "tl: "+c.name+" board=b1 chat=c_1 -> board host "+c.log+" 0ms" {
			t.Errorf("%s: log %q", c.name, l)
		}
		// the timeout is the last case: CallTimedOut is called for it and for nothing before it
		if _, timedOut := g.host.counts(); (timedOut == 1) != c.timeout {
			t.Errorf("%s: CallTimedOut %d times", c.name, timedOut)
		}
	}
	if _, timedOut := g.host.counts(); timedOut != 1 {
		t.Fatalf("CallTimedOut %d times", timedOut)
	}
	st := g.r.Status()
	want := map[string]*Counts{
		"host error": {Error: 1}, "no code": {Error: 1}, "lost": {Lost: 1},
		"gone before the send": {Lost: 1}, "timeout": {Timeout: 1},
	}
	if !reflect.DeepEqual(st.Calls, want) {
		t.Fatalf("counts %v", st.Calls)
	}
}

func TestCallToolUnavailable(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	g.host.mu.Lock()
	g.host.ensure = func(context.Context) (string, error) {
		return "", fmt.Errorf("%w: node was not found.", headless.ErrUnavailable)
	}
	g.host.mu.Unlock()
	_, err := g.r.CallTool(toolCall("read_board"))
	want := "UNAVAILABLE: the board host could not start: node was not found. New boards cannot be read or changed until it can; tell the user."
	if err == nil || err.Error() != want || err.Error() != UnavailableText("node was not found") {
		t.Fatalf("err %v", err)
	}
	if !errors.Is(err, headless.ErrUnavailable) {
		t.Fatalf("err does not wrap the cause")
	}
	g.r.SetHost(nil)
	_, err = g.r.CallTool(toolCall("read_board"))
	if err == nil || err.Error() != UnavailableText(noHostReason) {
		t.Fatalf("no host: %v", err)
	}
	if len(g.br.specs) != 0 {
		t.Fatal("CallBoard was called")
	}
	if c := g.r.Status().Calls["read_board"]; c == nil || *c != (Counts{Unavailable: 2}) {
		t.Fatalf("counts %v", c)
	}
	if l := g.logs(); len(l) != 2 || l[0] != "tl: read_board board=b1 chat=c_1 -> board host unavailable 0ms" {
		t.Fatalf("log %q", l)
	}
}

func TestTexts(t *testing.T) {
	t.Parallel()
	if HostStoppedText != "HOST_STOPPED: the board host stopped while it ran this call, so the call did not finish. The board is as it was after your last finished change. Read the board again before you change it." {
		t.Error("HostStoppedText")
	}
	if TimeoutText != "TIMEOUT: the board host did not answer in 30 s and was restarted. Read the board again before you change it." {
		t.Error("TimeoutText")
	}
	if ErrHostLost.Error() != HostStoppedText {
		t.Error("ErrHostLost")
	}
}

func TestAdapter(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	g.br.mu.Lock()
	g.br.hasCalls["h1"] = true
	g.br.mu.Unlock()
	if !g.ad.Known("h1") || g.ad.Known("hx") || !g.ad.HasCalls("h1") || g.ad.HasCalls("w1") {
		t.Fatal("Known/HasCalls are not the bridge's")
	}
	if g.ad.HoldsAny("h1") {
		t.Fatal("idle host is busy")
	}
	s := g.open("b1", "w1")
	if !g.ad.HoldsAny("h1") {
		t.Fatal("a host with a session is idle")
	}
	if g.ad.HoldsAny("h2") {
		t.Fatal("another host is busy with h1's session")
	}
	g.do("POST", "/api/tl/b1/close", "w1", map[string]any{"session": s})
	if g.ad.HoldsAny("h1") {
		t.Fatal("busy after the close")
	}

	// a tool call keeps it busy for quiet after its end
	g.br.call = func(editorbridge.CallSpec) (json.RawMessage, error) {
		if !g.ad.HoldsAny("h1") {
			t.Error("idle during a call")
		}
		g.clock.add(10 * time.Second)
		return json.RawMessage(`"ok"`), nil
	}
	g.r.CallTool(toolCall("read_board"))
	g.clock.add(quiet - time.Second)
	if !g.ad.HoldsAny("h1") {
		t.Fatal("idle within quiet of the last call")
	}
	g.clock.add(time.Second)
	if g.ad.HoldsAny("h1") {
		t.Fatal("busy quiet after the last call")
	}
	// a call that is refused counts too (its start)
	g.r.SetHost(nil)
	g.r.CallTool(toolCall("read_board"))
	if !g.ad.HoldsAny("h1") {
		t.Fatal("idle right after a call")
	}
}

func TestStatus(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	if st := g.r.Status(); st.Calls == nil || len(st.Calls) != 0 || st.Running {
		t.Fatalf("status %+v", st)
	}
	g.host.mu.Lock()
	g.host.status = headless.Status{Available: true, Running: true, PID: 1234, Boards: 9}
	g.host.mu.Unlock()
	g.open("b1", "w1")
	g.open("b2", "w2")
	g.r.CallTool(toolCall("apply"))
	g.r.CallTool(toolCall("apply"))
	g.r.ScreenClient("b1")
	st := g.r.Status()
	if !st.Available || !st.Running || st.PID != 1234 || st.Reason != "" || st.Sessions != 2 || st.ScreenCalls != 1 ||
		len(st.Calls) != 1 || *st.Calls["apply"] != (Counts{OK: 2}) {
		t.Fatalf("status %+v %v", st, st.Calls["apply"])
	}
	st.Calls["apply"].OK = 100
	if g.r.Status().Calls["apply"].OK != 2 {
		t.Fatal("Status is not a copy")
	}
	j, _ := json.Marshal(g.r.Status())
	want := `{"available":true,"reason":"","running":true,"pid":1234,"sessions":2,"calls":{"apply":{"ok":2,"error":0,"lost":0,"timeout":0,"unavailable":0}},"screenCalls":1}`
	if string(j) != want {
		t.Fatalf("json %s", j)
	}
	g.r.SetHost(nil)
	if st := g.r.Status(); st.Available || st.Running || st.PID != 0 || st.Sessions != 2 {
		t.Fatalf("no host: %+v", st)
	}
}

func TestScreenClient(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	if _, ok := g.r.ScreenClient("b1"); ok {
		t.Fatal("a window for a board nobody shows")
	}
	g.open("b1", "w1")
	g.open("b2", "w1")
	g.open("b1", "w2")
	if w, ok := g.r.ScreenClient("b1"); !ok || w != "w2" {
		t.Fatalf("ScreenClient = %q %v, want the newest, w2", w, ok)
	}
	g.br.setKnown("w2", false) // its stream ended, ClientEnded not yet in
	if w, ok := g.r.ScreenClient("b1"); !ok || w != "w1" {
		t.Fatalf("ScreenClient = %q %v, want w1", w, ok)
	}
	g.r.ClientEnded("w2")
	g.endClient("w1")
	if _, ok := g.r.ScreenClient("b1"); ok {
		t.Fatal("a window after every window ended")
	}
	if n := g.r.Status().ScreenCalls; n != 2 {
		t.Fatalf("screenCalls %d", n)
	}
}
