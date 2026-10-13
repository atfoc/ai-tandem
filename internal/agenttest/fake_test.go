package agenttest

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// next reads events until one of kind arrives and returns it with the ones before it.
func next(t *testing.T, ag agent.Agent, kind agent.EventKind) (agent.Event, []agent.Event) {
	t.Helper()
	var before []agent.Event
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-ag.Events():
			if !ok {
				t.Fatalf("the channel closed before event %v (got %d events)", kind, len(before))
			}
			if ev.Kind == kind {
				return ev, before
			}
			before = append(before, ev)
		case <-timeout:
			t.Fatalf("no event %v", kind)
		}
	}
}

func closed(t *testing.T, ag agent.Agent) {
	t.Helper()
	select {
	case ev, ok := <-ag.Events():
		if ok {
			t.Fatalf("an event after the exit: %+v", ev)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the channel did not close after the exit")
	}
}

func send(t *testing.T, ag agent.Agent, blocks ...string) {
	t.Helper()
	var bs []agent.ContentBlock
	for _, b := range blocks {
		bs = append(bs, agent.ContentBlock{Text: b})
	}
	if err := ag.Send(bs); err != nil {
		t.Fatal(err)
	}
}

func TestFakeTurn(t *testing.T) {
	f := New(model.Claude)
	f.Script(func(tn *Turn) {
		tn.Tool("Bash", map[string]any{"command": "ls"}, "a.txt", false)
		tn.Say("first")
		tn.Say("done " + tn.Text)
		tn.Cost(0.25, 40, 140)
	})
	opts := agent.SpawnOptions{ChatID: "c1", SessionID: "s1", Cwd: t.TempDir(), Model: "m"}
	ag, err := f.Spawn(opts)
	if err != nil {
		t.Fatal(err)
	}
	send(t, ag, "ctx", "hello")
	end, evs := next(t, ag, agent.EvTurnEnd)
	var kinds []agent.EventKind
	for _, ev := range evs {
		kinds = append(kinds, ev.Kind)
	}
	want := []agent.EventKind{agent.EvThinking, agent.EvToolStart, agent.EvToolInput, agent.EvToolResult, agent.EvText, agent.EvText}
	if len(kinds) != len(want) {
		t.Fatalf("events %v, want %v", kinds, want)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Fatalf("events %v, want %v", kinds, want)
		}
	}
	if evs[1].ToolName != "Bash" || string(evs[1].Input) != `{"command":"ls"}` || evs[3].Result != "a.txt" || evs[3].ToolID != evs[1].ToolID {
		t.Errorf("tool events: %+v %+v", evs[1], evs[3])
	}
	if evs[5].Text != "done ctx\n\nhello" {
		t.Errorf("the message as the script saw it: %q", evs[5].Text)
	}
	if end.Aborted || end.Error != "" || !end.HasCost || end.CostUSD != 0.25 || end.OutTokens != 40 || end.CumOutTokens != 140 || end.Final != "done ctx\n\nhello" {
		t.Errorf("turn end: %+v", end)
	}
	// The second message is turn 2 of the same process.
	var n int
	var blocks []string
	f.Script(func(tn *Turn) { n, blocks = tn.N, tn.Blocks })
	send(t, ag, "again")
	if end, _ := next(t, ag, agent.EvTurnEnd); end.HasCost || end.Aborted {
		t.Errorf("second end: %+v", end)
	}
	if n != 2 || len(blocks) != 1 || blocks[0] != "again" {
		t.Errorf("turn %d, blocks %q", n, blocks)
	}
	if got := f.Spawns(); len(got) != 1 || got[0].ChatID != "c1" || got[0].SessionID != "s1" {
		t.Errorf("Spawns: %+v", got)
	}
	if f.Live() != 1 {
		t.Errorf("Live %d, want 1", f.Live())
	}
	ag.Close()
	if ex, _ := next(t, ag, agent.EvExit); ex.ExitErr != "" {
		t.Errorf("exit: %+v", ex)
	}
	closed(t, ag)
	if f.Live() != 0 {
		t.Errorf("Live %d after Close", f.Live())
	}
	if err := ag.Send(nil); err == nil {
		t.Error("Send to an ended process succeeded")
	}
}

func TestFakeFailExitHangInterrupt(t *testing.T) {
	f := New(model.Pi)
	cwd := t.TempDir()
	started := make(chan *Turn, 1)

	// Fail: an error end, later output is not shown, the process stays.
	f.Script(func(tn *Turn) { tn.Say("a"); tn.Fail("boom"); tn.Say("never") })
	ag, _ := f.Spawn(agent.SpawnOptions{SessionID: "s", Cwd: cwd})
	send(t, ag, "x")
	end, evs := next(t, ag, agent.EvTurnEnd)
	if end.Error != "boom" || end.Aborted || len(evs) != 2 {
		t.Fatalf("fail: %+v after %d events", end, len(evs))
	}

	// Hang, ended by an interrupt: a stopped end with its cost, nothing shown after the interrupt.
	f.Script(func(tn *Turn) {
		tn.Cost(1, 0, 0)
		started <- tn
		tn.Hang()
		tn.Say("never")
		if text, isErr := tn.Call("read_board", nil); text != "" || !isErr {
			t.Errorf("Call after an interrupt: %q %v", text, isErr)
		}
	})
	send(t, ag, "y")
	tn := <-started
	select {
	case <-tn.Interrupted():
		t.Fatal("interrupted before the interrupt")
	default:
	}
	if err := ag.Interrupt(); err != nil {
		t.Fatal(err)
	}
	end, evs = next(t, ag, agent.EvTurnEnd)
	if !end.Aborted || end.Error != "" || !end.HasCost || end.CostUSD != 1 || len(evs) != 1 {
		t.Fatalf("interrupt: %+v after %d events", end, len(evs))
	}
	select {
	case <-tn.Interrupted():
	default:
		t.Error("Interrupted is not closed")
	}
	// An interrupt with no turn does nothing.
	if err := ag.Interrupt(); err != nil {
		t.Fatal(err)
	}

	// Exit: no turn end, EvExit with the text, the channel closes.
	f.Script(func(tn *Turn) { tn.Say("b"); tn.Exit("crashed"); tn.Say("never") })
	send(t, ag, "z")
	ex, evs := next(t, ag, agent.EvExit)
	if ex.ExitErr != "crashed" {
		t.Errorf("exit: %+v", ex)
	}
	for _, ev := range evs {
		if ev.Kind == agent.EvTurnEnd {
			t.Error("a turn end before the exit")
		}
	}
	closed(t, ag)
	if err := ag.Interrupt(); err == nil {
		t.Error("Interrupt of an ended process succeeded")
	}
}

// Close in a turn: the process ends with no turn end, and a hanging script returns.
func TestFakeCloseInTurn(t *testing.T) {
	f := New(model.Cursor)
	back := make(chan struct{})
	f.Script(func(tn *Turn) { tn.Hang(); close(back) })
	ag, _ := f.Spawn(agent.SpawnOptions{Cwd: t.TempDir()})
	if ev, _ := next(t, ag, agent.EvSession); ev.SessionID == "" {
		t.Error("a process with no session id did not report one")
	}
	send(t, ag, "x")
	next(t, ag, agent.EvThinking)
	ag.Close()
	ex, evs := next(t, ag, agent.EvExit)
	if ex.ExitErr != "exit status 143" || len(evs) != 0 {
		t.Errorf("exit %+v after %d events", ex, len(evs))
	}
	closed(t, ag)
	select {
	case <-back:
	case <-time.After(5 * time.Second):
		t.Fatal("the script still hangs after Close")
	}
	ag.Close() // twice is fine
}

func TestFakeSpawnErrors(t *testing.T) {
	f := New(model.Claude)
	if _, err := f.Spawn(agent.SpawnOptions{Cwd: filepath.Join(t.TempDir(), "gone")}); !errors.Is(err, agent.ErrFolderMissing) {
		t.Errorf("missing folder: %v", err)
	}
	boom := errors.New("boom")
	f.FailSpawn(boom)
	if _, err := f.Spawn(agent.SpawnOptions{Cwd: t.TempDir()}); err != boom {
		t.Errorf("FailSpawn: %v", err)
	}
	if _, err := f.Spawn(agent.SpawnOptions{Cwd: t.TempDir()}); err != nil {
		t.Errorf("the Spawn after the failed one: %v", err)
	}
	if n := len(f.Spawns()); n != 3 {
		t.Errorf("%d spawns recorded, want 3", n)
	}
}

// Call and Tools make real MCP requests on Fake.MCP with the process's token.
func TestFakeCallAndTools(t *testing.T) {
	type seen struct{ auth, path, method, tool, args string }
	var got []seen
	f := New(model.Claude)
	f.MCP = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var rq struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
			Params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"params"`
		}
		if err := json.Unmarshal(body, &rq); err != nil || rq.ID == nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		got = append(got, seen{r.Header.Get("Authorization"), r.URL.Path, rq.Method, rq.Params.Name, string(rq.Params.Arguments)})
		var result any
		switch {
		case rq.Method == "tools/list":
			result = map[string]any{"tools": []map[string]any{{"name": "read_board"}, {"name": "apply"}}}
		case rq.Params.Name == "apply":
			result = map[string]any{"content": []map[string]any{{"type": "text", "text": "applied"}}}
		default:
			result = map[string]any{"content": []map[string]any{{"type": "text", "text": "unknown tool"}}, "isError": true}
		}
		json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": rq.ID, "result": result})
	})
	var names []string
	var text, text2 string
	var isErr, isErr2 bool
	f.Script(func(tn *Turn) {
		names = tn.Tools()
		text, isErr = tn.Call("apply", map[string]any{"title": "x"})
		text2, isErr2 = tn.Call("nope", nil)
	})
	ag, _ := f.Spawn(agent.SpawnOptions{Cwd: t.TempDir(), SessionID: "s", MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "tok-1"}})
	send(t, ag, "x")
	_, evs := next(t, ag, agent.EvTurnEnd)
	if len(names) != 2 || names[0] != "read_board" || names[1] != "apply" {
		t.Errorf("Tools: %v", names)
	}
	if text != "applied" || isErr || text2 != "unknown tool" || !isErr2 {
		t.Errorf("Call: %q %v, %q %v", text, isErr, text2, isErr2)
	}
	want := []seen{{"Bearer tok-1", "/mcp", "tools/list", "", ""}, {"Bearer tok-1", "/mcp", "tools/call", "apply", `{"title":"x"}`},
		{"Bearer tok-1", "/mcp", "tools/call", "nope", `{}`}}
	if len(got) != len(want) {
		t.Fatalf("requests: %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("request %d: %+v, want %+v", i, got[i], want[i])
		}
	}
	// Each call is a tool item with its result.
	var tools []string
	for _, ev := range evs {
		if ev.Kind == agent.EvToolStart {
			tools = append(tools, ev.ToolName)
		}
		if ev.Kind == agent.EvToolResult && ev.Result == "unknown tool" && !ev.IsError {
			t.Error("the refused call's item is not an error")
		}
	}
	if len(tools) != 2 || tools[0] != "mcp__board__apply" || tools[1] != "mcp__board__nope" {
		t.Errorf("tool items: %v", tools)
	}

	// No handler, or a process without MCP access: an error text, no panic.
	f2 := New(model.Claude)
	f2.Script(func(tn *Turn) {
		if text, isErr := tn.Call("read_board", nil); !isErr || text == "" {
			t.Errorf("Call with no MCP: %q %v", text, isErr)
		}
		if tn.Tools() != nil {
			t.Error("Tools with no MCP is not nil")
		}
	})
	ag2, _ := f2.Spawn(agent.SpawnOptions{Cwd: t.TempDir(), SessionID: "s"})
	send(t, ag2, "x")
	next(t, ag2, agent.EvTurnEnd)
}
