package agenttest_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/claude"
)

// claudeTurn sends one message to a process of the real Claude adapter and returns the text items
// of the turn and its end.
func claudeTurn(t *testing.T, ag agent.Agent, msg string) (texts []string, end agent.Event) {
	t.Helper()
	if err := ag.Send([]agent.ContentBlock{{Text: msg}}); err != nil {
		t.Fatal(err)
	}
	open := false
	timeout := time.After(30 * time.Second)
	for {
		select {
		case ev, ok := <-ag.Events():
			if !ok {
				t.Fatalf("the process ended before the turn did (texts %q)", texts)
			}
			switch ev.Kind {
			case agent.EvText:
				texts, open = append(texts, ev.Text), false
			case agent.EvTextStart:
				texts, open = append(texts, ""), true
			case agent.EvTextDelta:
				if !open {
					texts, open = append(texts, ""), true
				}
				texts[len(texts)-1] += ev.Text
			case agent.EvTurnEnd:
				return texts, ev
			case agent.EvExit:
				t.Fatalf("the process exited in the turn: %s", ev.ExitErr)
			}
		case <-timeout:
			t.Fatal("no turn end from the fake claude")
		}
	}
}

func startFakeClaude(t *testing.T) agent.Agent {
	t.Helper()
	return startFakeClaudeIn(t, t.TempDir())
}

// startFakeClaudeIn starts the fake with cwd as its working directory. Its permission requests
// reach the test, which answers them.
func startFakeClaudeIn(t *testing.T, cwd string) agent.Agent {
	t.Helper()
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH")
	}
	bin := agenttest.FakeClaude(t)
	if fi, err := os.Stat(bin); err != nil || fi.Mode().Perm()&0o100 == 0 {
		t.Fatalf("the fake claude is not executable: %v", err)
	}
	sp := &claude.Spawner{Bin: bin, AppRoot: t.TempDir(), Home: t.TempDir()}
	ag, err := sp.Spawn(agent.SpawnOptions{ChatID: "c1", SessionID: "11111111-1111-4111-8111-111111111111",
		Cwd: cwd, Model: "sonnet"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ag.Close()
		for range ag.Events() { // until the process has exited
		}
	})
	return ag
}

// askTurn sends one message that holds an [[ask …]] and returns the permission request it raises.
func askTurn(t *testing.T, ag agent.Agent, msg string) agent.Event {
	t.Helper()
	if err := ag.Send([]agent.ContentBlock{{Text: msg}}); err != nil {
		t.Fatal(err)
	}
	timeout := time.After(30 * time.Second)
	for {
		select {
		case ev, ok := <-ag.Events():
			if !ok {
				t.Fatal("the process ended before it asked")
			}
			switch ev.Kind {
			case agent.EvPermRequest:
				return ev
			case agent.EvTurnEnd:
				t.Fatalf("the turn ended before it asked: %+v", ev)
			case agent.EvExit:
				t.Fatalf("the process exited before it asked: %s", ev.ExitErr)
			}
		case <-timeout:
			t.Fatal("no permission request from the fake claude")
		}
	}
}

// turnEnd waits for the end of the turn that is running and returns it; a permission request on
// the way fails the test.
func turnEnd(t *testing.T, ag agent.Agent) agent.Event {
	t.Helper()
	timeout := time.After(30 * time.Second)
	for {
		select {
		case ev, ok := <-ag.Events():
			if !ok {
				t.Fatal("the process ended before the turn did")
			}
			switch ev.Kind {
			case agent.EvPermRequest:
				t.Fatalf("a second permission request: %+v", ev)
			case agent.EvTurnEnd:
				return ev
			case agent.EvExit:
				t.Fatalf("the process exited in the turn: %s", ev.ExitErr)
			}
		case <-timeout:
			t.Fatal("no turn end from the fake claude")
		}
	}
}

// [[ask]] raises a permission request with the tool and its input, and the reply says what the
// answer was; <<ask>> is the same directive.
func TestFakeClaudeAskAllowAndDeny(t *testing.T) {
	ag := startFakeClaude(t)
	for _, c := range []struct {
		msg, tool, input string
		allow            bool
		tail             string
	}{
		{`list it [[ask Bash {"command":"ls"}]]`, "Bash", `{"command":"ls"}`, true, "ask Bash -> allow"},
		{`list it [[ask Bash {"command":"ls"}]]`, "Bash", `{"command":"ls"}`, false, "ask Bash -> deny"},
		{`edit it <<ask Edit {"file_path":"a.txt"}>>`, "Edit", `{"file_path":"a.txt"}`, true, "ask Edit -> allow"},
		{`bare [[ask]]`, "Bash", `{}`, false, "ask Bash -> deny"},
		{`named <<ask Read>>`, "Read", `{}`, true, "ask Read -> allow"},
	} {
		req := askTurn(t, ag, c.msg)
		if req.PermID == "" || req.ToolID == "" || req.ToolName != c.tool || string(req.Input) != c.input {
			t.Errorf("%s: request id %q, tool id %q, tool %q, input %s; want tool %q, input %s", c.msg, req.PermID, req.ToolID, req.ToolName, req.Input, c.tool, c.input)
		}
		if err := ag.Decide(req.PermID, c.allow); err != nil {
			t.Fatalf("%s: Decide: %v", c.msg, err)
		}
		end := turnEnd(t, ag)
		if end.Error != "" || end.Aborted {
			t.Fatalf("%s: turn end: %+v", c.msg, end)
		}
		if !strings.HasSuffix(end.Final, c.tail) || strings.Contains(end.Final, "ask "+c.tool+" {") {
			t.Errorf("%s: the reply does not end %q:\n%s", c.msg, c.tail, end.Final)
		}
	}
}

// An interrupt while the fake waits for the answer ends the turn as aborted, and the process
// takes the next turn.
func TestFakeClaudeAskInterrupted(t *testing.T) {
	ag := startFakeClaude(t)
	askTurn(t, ag, `[[ask Bash {"command":"ls"}]] [[ask Bash {"command":"pwd"}]]`)
	if err := ag.Interrupt(); err != nil {
		t.Fatal(err)
	}
	if end := turnEnd(t, ag); !end.Aborted {
		t.Errorf("turn end after the interrupt: %+v, want aborted", end)
	}
	texts, end := claudeTurn(t, ag, "after")
	if end.Error != "" || end.Aborted || len(texts) == 0 || texts[len(texts)-1] != "FAKE(sonnet): after" {
		t.Errorf("the turn after the interrupt: %+v, texts %q", end, texts)
	}
}

// The Node fake through the real Claude adapter: a turn with a cost.
func TestFakeClaudeCost(t *testing.T) {
	t.Parallel()
	ag := startFakeClaude(t)
	texts, end := claudeTurn(t, ag, "do the job [[cost 0.01]]")
	if end.Error != "" || end.Aborted {
		t.Fatalf("turn end: %+v", end)
	}
	if !end.HasCost || end.CostUSD != 0.01 || end.OutTokens != 1000 || end.CumOutTokens != 1000 {
		t.Errorf("cost: has %v usd %v out %d cum %d, want true 0.01 1000 1000", end.HasCost, end.CostUSD, end.OutTokens, end.CumOutTokens)
	}
	if len(texts) == 0 {
		t.Fatal("the turn wrote no text")
	}
	last := texts[len(texts)-1]
	if last != "FAKE(sonnet): do the job" {
		t.Errorf("the final text:\n%s", last)
	}
	if end.Final != last {
		t.Errorf("Final is not the last text:\n%s", end.Final)
	}

	// A second turn of the process: the total and the model's tokens are cumulative, the turn's
	// tokens are its own.
	_, end = claudeTurn(t, ag, "more [[cost 0.02]]")
	if !end.HasCost || end.CostUSD != 0.03 || end.OutTokens != 2000 || end.CumOutTokens != 3000 {
		t.Errorf("second cost: has %v usd %v out %d cum %d, want true 0.03 2000 3000", end.HasCost, end.CostUSD, end.OutTokens, end.CumOutTokens)
	}
	// A turn with no [[cost]] still reports the total.
	_, end = claudeTurn(t, ag, "nothing")
	if !end.HasCost || end.CostUSD != 0.03 || end.OutTokens != 5 || end.CumOutTokens != 3005 {
		t.Errorf("third cost: has %v usd %v out %d cum %d, want true 0.03 5 3005", end.HasCost, end.CostUSD, end.OutTokens, end.CumOutTokens)
	}
}

// [[final]] is the reply to the subagents' results; [[if]] gates directives; [[fail]] ends a turn
// with an error.
func TestFakeClaudeFinalIfFail(t *testing.T) {
	t.Parallel()
	ag := startFakeClaude(t)
	texts, end := claudeTurn(t, ag, "start [[final all done]]")
	if end.Error != "" || len(texts) == 0 || texts[len(texts)-1] != "FAKE(sonnet): start" {
		t.Fatalf("the first reply: %+v %q", end, texts)
	}
	texts, end = claudeTurn(t, ag, "<subagent-results>\nThis message was written by the app.\n</subagent-results>")
	if end.Error != "" || len(texts) == 0 {
		t.Fatalf("turn end %+v", end)
	}
	if last := texts[len(texts)-1]; last != "all done" {
		t.Errorf("reply to the results:\n%s", last)
	}

	texts, end = claudeTurn(t, ag, "This is turn 2. [[if This is turn 1.]] [[fail wrong turn]] [[if This is turn 2.]] [[cost 0.5]] [[if]] [[cost 0.25]]")
	if end.Error != "" || end.OutTokens != 75000 {
		t.Errorf("[[if]]: error %q, out tokens %d (want none, 75000); texts %q", end.Error, end.OutTokens, texts)
	}
	_, end = claudeTurn(t, ag, "[[fail it broke]]")
	if end.Error != "it broke" {
		t.Errorf("[[fail]]: %+v", end)
	}
}

// [[write]] changes a file in the process's working directory, in its conditional part only, and
// a directive may hold a JSON array.
func TestFakeClaudeWriteAndArrays(t *testing.T) {
	t.Parallel()
	cwd := t.TempDir()
	ag := startFakeClaudeIn(t, cwd)
	texts, end := claudeTurn(t, ag, `the job [[write notes/a.txt one\ntwo]] [[if not in the message]] [[write b.txt no]] [[if the job]] `+
		`[[mcp apply {"delete":["E01","E02"],"board":"x"}]] <<write c.txt three>>`)
	if end.Error != "" || end.Aborted || len(texts) == 0 {
		t.Fatalf("turn end: %+v, texts %q", end, texts)
	}
	for name, want := range map[string]string{"notes/a.txt": "one\ntwo\n", "c.txt": "three\n"} {
		if b, err := os.ReadFile(filepath.Join(cwd, name)); err != nil || string(b) != want {
			t.Errorf("%s: %q, %v; want %q", name, b, err, want)
		}
	}
	if _, err := os.Stat(filepath.Join(cwd, "b.txt")); err == nil {
		t.Error("a [[write]] behind an [[if]] that does not hold was carried out")
	}
	last := texts[len(texts)-1]
	// The whole [[mcp …]] directive was read, array and all: the process has no MCP endpoint and
	// says so, and nothing of the directive is left in the reply.
	if !strings.Contains(last, "apply -> no --mcp-config") || strings.Contains(last, "E02") || !strings.Contains(last, "write notes/a.txt -> written") {
		t.Errorf("the reply:\n%s", last)
	}
}

// The app passes --mcp-config as the path of a file (the token is not to be on the command line):
// the fake reads it, and calls the endpoint with the header it names.
func TestFakeClaudeMCPConfigFromAFile(t *testing.T) {
	t.Parallel()
	var auth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth.Store(r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"from the endpoint"}]}}`)
	}))
	defer srv.Close()

	if !agenttest.HasNode() {
		t.Skip("node is not on PATH")
	}
	appRoot := t.TempDir()
	sp := &claude.Spawner{Bin: agenttest.FakeClaude(t), AppRoot: appRoot, Home: t.TempDir()}
	ag, err := sp.Spawn(agent.SpawnOptions{ChatID: "c1", SessionID: "11111111-1111-4111-8111-111111111111",
		Cwd: t.TempDir(), Model: "sonnet", MCP: &agent.BoardAccess{MCPURL: srv.URL, Token: "file-tok"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ag.Close()
		for range ag.Events() {
		}
	})
	if fi, err := os.Stat(filepath.Join(appRoot, "chats", "c1", "mcp.json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("the --mcp-config file: %v, %v; want mode 600", fi, err)
	}
	texts, end := claudeTurn(t, ag, `[[mcp read_board {}]]`)
	if end.Error != "" || len(texts) == 0 {
		t.Fatalf("turn end: %+v, texts %q", end, texts)
	}
	if got, _ := auth.Load().(string); got != "Bearer file-tok" {
		t.Errorf("the endpoint was called with Authorization %q, want the token of the file", got)
	}
	if last := texts[len(texts)-1]; strings.Contains(last, "no --mcp-config") || !strings.Contains(last, "from the endpoint") {
		t.Errorf("the reply:\n%s", last)
	}
}
