//go:build !windows

package agenttest_test

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/testset"
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

// [[bg SECONDS]] is a real background command in the stream claude writes: the turn that starts it
// ends with one task running, the command's end gives the notice, and the turn the process begins by
// itself ends with none.
func TestFakeClaudeBackgroundCommand(t *testing.T) {
	pids := filepath.Join(t.TempDir(), "bgpids")
	t.Setenv("FAKE_CLAUDE_BGPIDS", pids)
	t.Cleanup(func() { // a failing test leaves no sleep behind
		b, _ := os.ReadFile(pids)
		for _, f := range strings.Fields(string(b)) {
			if pid, err := strconv.Atoi(f); err == nil && pid > 1 {
				syscall.Kill(-pid, syscall.SIGKILL)
			}
		}
	})
	ag := startFakeClaude(t)
	if err := ag.Send([]agent.ContentBlock{{Text: "[[bg 0.3]]"}}); err != nil {
		t.Fatal(err)
	}
	var states []agent.Background
	var ends []agent.Event
	var texts []string
	timeout := time.After(30 * time.Second)
	for len(ends) < 2 {
		select {
		case ev, ok := <-ag.Events():
			if !ok {
				t.Fatalf("the process ended early (states %v, texts %q)", states, texts)
			}
			switch ev.Kind {
			case agent.EvBackground:
				states = append(states, ev.Background)
			case agent.EvText:
				texts = append(texts, ev.Text)
			case agent.EvTurnEnd:
				ends = append(ends, ev)
			case agent.EvExit:
				t.Fatalf("the process exited: %s", ev.ExitErr)
			}
		case <-timeout:
			t.Fatalf("no second turn end (states %v, ends %d)", states, len(ends))
		}
	}
	want := []agent.Background{{Running: 1}, {Running: 1, Unread: true}, {Running: 0, Unread: true}, {Running: 0}}
	if len(states) != len(want) {
		t.Fatalf("background states %v, want %v", states, want)
	}
	for i := range want {
		if states[i] != want[i] {
			t.Errorf("background state %d: %v, want %v", i, states[i], want[i])
		}
	}
	if ends[0].SelfBegun || ends[0].Background != want[0] {
		t.Errorf("first turn end: self-begun %v, background %v; want a message's turn with %v", ends[0].SelfBegun, ends[0].Background, want[0])
	}
	if !ends[1].SelfBegun || ends[1].Background != (agent.Background{}) {
		t.Errorf("second turn end: self-begun %v, background %v; want a self-begun turn with none", ends[1].SelfBegun, ends[1].Background)
	}
	if len(texts) != 2 || texts[0] != "waiting" || texts[1] != "bg1 done" {
		t.Errorf("texts %q, want waiting and bg1 done", texts)
	}
	if b, _ := os.ReadFile(pids); len(strings.Fields(string(b))) != 1 {
		t.Errorf("recorded pids %q, want one", b)
	}
}

// pidsOf reads the pids the fake wrote to file, one per line.
func pidsOf(t *testing.T, file string) []int {
	t.Helper()
	b, _ := os.ReadFile(file)
	var pids []int
	for _, f := range strings.Fields(string(b)) {
		if pid, err := strconv.Atoi(f); err == nil && pid > 1 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// groupGone waits until no process is left in the group pgid. A shell the fake started is the
// leader of its group, and it is waited for by the fake or by init.
func groupGone(t *testing.T, what string, pgid int) {
	t.Helper()
	for deadline := time.Now().Add(20 * time.Second); !errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			syscall.Kill(-pgid, syscall.SIGKILL)
			t.Fatalf("%s: the group %d is still there", what, pgid)
		}
	}
}

// waitEvent returns the first event of kind k, failing at the exit of the process.
func waitEvent(t *testing.T, ag agent.Agent, k agent.EventKind) agent.Event {
	t.Helper()
	timeout := time.After(30 * time.Second)
	for {
		select {
		case ev, ok := <-ag.Events():
			if !ok {
				t.Fatalf("the events ended before kind %v", k)
			}
			if ev.Kind == k {
				return ev
			}
			if ev.Kind == agent.EvExit {
				t.Fatalf("the process exited before kind %v: %s", k, ev.ExitErr)
			}
		case <-timeout:
			t.Fatalf("no event of kind %v", k)
		}
	}
}

// Stopping an agent with a command in the background starts no turn: Close ends the process
// before its shell, so the notice of the shell's end has no process to begin a turn on (the
// stand-in logs {"turn":"self"} for a turn begun after stdin closed). The shell's group is gone.
func TestFakeClaudeCloseStartsNoTurn(t *testing.T) {
	dir := t.TempDir()
	pids, log := filepath.Join(dir, "bgpids"), filepath.Join(dir, "log")
	t.Setenv("FAKE_CLAUDE_BGPIDS", pids)
	t.Setenv("FAKE_CLAUDE_LOG", log)
	t.Cleanup(func() { // a failing test leaves no sleep behind
		for _, pid := range pidsOf(t, pids) {
			syscall.Kill(-pid, syscall.SIGKILL)
		}
	})
	ag := startFakeClaude(t)
	if err := ag.Send([]agent.ContentBlock{{Text: "[[bg 60.481516]]"}}); err != nil {
		t.Fatal(err)
	}
	if end := waitEvent(t, ag, agent.EvTurnEnd); end.Background.Running != 1 {
		t.Fatalf("the turn ended with %+v, want one command running", end.Background)
	}
	shells := pidsOf(t, pids)
	if len(shells) != 1 {
		t.Fatalf("shells %v, want one", shells)
	}

	ag.Close()
	waitEvent(t, ag, agent.EvExit)
	groupGone(t, "after Close", shells[0])
	// The stand-in writes the line when its turn begins, which is after the shell's end reached it.
	// Give it the time it would take; the process itself is gone, so nothing is waited for.
	time.Sleep(200 * time.Millisecond)
	if b, _ := os.ReadFile(log); strings.Contains(string(b), `"turn":"self"`) {
		t.Errorf("the stopped process began a turn of its own:\n%s", b)
	}
}

// A command that is announced before its shell exists is still ended with the process when it
// exits by itself: the end of the turn looks for the shell again, while it is the process's
// descendant.
func TestFakeClaudeLateShellEndsWithASelfExit(t *testing.T) {
	testset.SkipUnlessFull(t, "needs node and waits for a ps to end; TestLateShellEndsWithASelfExit in internal/claude covers the same behaviour on the test binary's own fake")
	dir := t.TempDir()
	pids, bgGate, leaveGate := filepath.Join(dir, "bgpids"), filepath.Join(dir, "bggate"), filepath.Join(dir, "leavegate")
	t.Setenv("FAKE_CLAUDE_BGPIDS", pids)
	t.Setenv("FAKE_CLAUDE_BG_GATE", bgGate)
	t.Setenv("FAKE_CLAUDE_LEAVE_GATE", leaveGate)
	logFile := filepath.Join(dir, "log")
	t.Setenv("FAKE_CLAUDE_LOG", logFile)
	t.Cleanup(func() {
		for _, pid := range pidsOf(t, pids) {
			syscall.Kill(-pid, syscall.SIGKILL)
		}
	})
	ag := startFakeClaude(t)
	// A test that fails before it opens the gates leaves no fake waiting for them.
	t.Cleanup(func() { os.WriteFile(bgGate, nil, 0o644); os.WriteFile(leaveGate, nil, 0o644) })
	if err := ag.Send([]agent.ContentBlock{{Text: "[[bglate 60.481517]] [[leave]]"}}); err != nil {
		t.Fatal(err)
	}
	// The announcement is out, the shell does not exist: what looks for it at the announcement
	// finds nothing. Then the shell starts and the turn ends.
	waitEvent(t, ag, agent.EvBackground)
	// What the announcement started lists the machine's processes once (a ps): wait for longer
	// than a ps takes now, so that the shell does not exist when that list is made.
	start := time.Now()
	exec.Command("ps", "-A", "-o", "pid=").Run()
	time.Sleep(3 * time.Since(start))
	if len(pidsOf(t, pids)) != 0 {
		t.Fatal("the shell started before its gate was opened")
	}
	if err := os.WriteFile(bgGate, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	waitEvent(t, ag, agent.EvTurnEnd)
	shells := pidsOf(t, pids)
	if len(shells) != 1 {
		t.Fatalf("shells %v, want one", shells)
	}
	// The process may leave once the walk after the turn's end has found the shell.
	var first struct{ Pid int }
	b, _ := os.ReadFile(logFile)
	if err := json.Unmarshal([]byte(strings.SplitN(string(b), "\n", 2)[0]), &first); err != nil || first.Pid <= 1 {
		t.Fatalf("the stand-in's log does not start with its pid: %q", b)
	}
	pid := first.Pid
	for deadline := time.Now().Add(20 * time.Second); !slices.Contains(agent.AdoptedGroups(pid), shells[0]); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the shell %d was not adopted at the end of the turn: %v", shells[0], agent.AdoptedGroups(pid))
		}
	}
	if err := os.WriteFile(leaveGate, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if ev := waitEvent(t, ag, agent.EvExit); ev.ExitErr != "" {
		t.Errorf("exit error %q, want the stand-in's own clean exit", ev.ExitErr)
	}
	groupGone(t, "after the process exited by itself", shells[0])
}

// [[apierror CLASS N]] fails the turn and the next N-1 of the session as the CLI fails a turn the API
// refused, across processes: a process started again with --resume fails its turn too, whatever it is
// sent, and the turn after the count answers.
func TestFakeClaudeAPIError(t *testing.T) {
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH")
	}
	t.Setenv("FAKE_CLAUDE_STATE", t.TempDir())
	sp := &claude.Spawner{Bin: agenttest.FakeClaude(t), AppRoot: t.TempDir(), Home: t.TempDir()}
	const session = "22222222-2222-4222-8222-222222222222"
	start := func(resume bool) agent.Agent {
		ag, err := sp.Spawn(agent.SpawnOptions{ChatID: "c1", SessionID: session, Resume: resume, Cwd: t.TempDir(), Model: "sonnet"})
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
	const text = "Failed to authenticate. API Error: 401 OAuth token has expired."
	for i, msg := range []string{"[[apierror authentication_failed 2]] hi", "carry on"} {
		texts, end := claudeTurn(t, start(i > 0), msg)
		if end.Error != text || end.Temporary != agent.TempLogin || len(texts) != 0 {
			t.Errorf("process %d: texts %q, turn end %+v; want no text, error %q and Temporary login", i+1, texts, end, text)
		}
	}
	texts, end := claudeTurn(t, start(true), "carry on")
	if end.Error != "" || end.Temporary != "" || len(texts) != 1 || texts[0] != "FAKE(sonnet): carry on" {
		t.Errorf("process 3: texts %q, turn end %+v; want the answer", texts, end)
	}
}
