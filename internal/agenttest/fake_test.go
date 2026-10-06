package agenttest

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
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
		if text, isErr := tn.Call("get_run", nil); text != "" || !isErr {
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

func TestFakeNoSessionPerKind(t *testing.T) {
	cwd := t.TempDir()
	resume := agent.SpawnOptions{SessionID: "s9", Resume: true, Cwd: cwd, NeedHistory: true}

	t.Run("claude, a Send first", func(t *testing.T) {
		f := New(model.Claude)
		f.NoSessionDelay = time.Minute
		f.NoSession("s9")
		ag, _ := f.Spawn(resume)
		send(t, ag, "go on")
		end, evs := next(t, ag, agent.EvTurnEnd)
		if !end.NoSession || end.Error != "No conversation found with session ID: s9" || len(evs) != 0 {
			t.Fatalf("turn end %+v after %d events", end, len(evs))
		}
		if ex, _ := next(t, ag, agent.EvExit); ex.ExitErr != end.Error {
			t.Errorf("exit %+v", ex)
		}
		closed(t, ag)
	})
	t.Run("claude, no Send", func(t *testing.T) {
		f := New(model.Claude)
		f.NoSessionDelay = 10 * time.Millisecond
		f.NoSession("s9")
		ag, _ := f.Spawn(resume)
		if end, _ := next(t, ag, agent.EvTurnEnd); !end.NoSession {
			t.Fatalf("turn end %+v", end)
		}
		next(t, ag, agent.EvExit)
		closed(t, ag)
	})
	t.Run("cursor", func(t *testing.T) {
		f := New(model.Cursor)
		f.NoSession("s9")
		ag, _ := f.Spawn(resume)
		err := ag.Send([]agent.ContentBlock{{Text: "go on"}})
		if !errors.Is(err, agent.ErrNoSession) || !strings.Contains(err.Error(), `Session \"s9\" not found`) {
			t.Fatalf("Send: %v", err)
		}
		select {
		case ev := <-ag.Events():
			t.Fatalf("an event: %+v", ev)
		case <-time.After(30 * time.Millisecond):
		}
		if f.Live() != 1 {
			t.Error("the process did not stay alive")
		}
		ag.Close()
		next(t, ag, agent.EvExit)
	})
	t.Run("pi", func(t *testing.T) {
		f := New(model.Pi)
		f.NoSession("s9")
		ag, _ := f.Spawn(resume)
		err := ag.Send([]agent.ContentBlock{{Text: "go on"}})
		if !errors.Is(err, agent.ErrNoSession) || err.Error() != "pi has no messages in session s9" {
			t.Fatalf("Send: %v", err)
		}
		if end, _ := next(t, ag, agent.EvTurnEnd); end.Error != err.Error() || end.NoSession {
			t.Errorf("turn end %+v", end)
		}
		next(t, ag, agent.EvExit)
		closed(t, ag)
	})
	t.Run("a fresh start makes the session", func(t *testing.T) {
		f := New(model.Pi)
		f.NoSession("s9")
		fresh := resume
		fresh.Resume = false
		ag, _ := f.Spawn(fresh)
		send(t, ag, "start")
		if end, _ := next(t, ag, agent.EvTurnEnd); end.Error != "" {
			t.Fatalf("turn end %+v", end)
		}
		ag2, _ := f.Spawn(resume)
		send(t, ag2, "go on")
		if end, _ := next(t, ag2, agent.EvTurnEnd); end.Error != "" {
			t.Fatalf("the resume after a fresh start: %+v", end)
		}
	})
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
			result = map[string]any{"tools": []map[string]any{{"name": "get_run"}, {"name": "add_task"}}}
		case rq.Params.Name == "add_task":
			result = map[string]any{"content": []map[string]any{{"type": "text", "text": "T01"}}}
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
		text, isErr = tn.Call("add_task", map[string]any{"title": "x"})
		text2, isErr2 = tn.Call("nope", nil)
	})
	ag, _ := f.Spawn(agent.SpawnOptions{Cwd: t.TempDir(), SessionID: "s", MCP: &agent.BoardAccess{MCPURL: "http://localhost:6006/mcp", Token: "tok-1"}})
	send(t, ag, "x")
	_, evs := next(t, ag, agent.EvTurnEnd)
	if len(names) != 2 || names[0] != "get_run" || names[1] != "add_task" {
		t.Errorf("Tools: %v", names)
	}
	if text != "T01" || isErr || text2 != "unknown tool" || !isErr2 {
		t.Errorf("Call: %q %v, %q %v", text, isErr, text2, isErr2)
	}
	want := []seen{{"Bearer tok-1", "/mcp", "tools/list", "", ""}, {"Bearer tok-1", "/mcp", "tools/call", "add_task", `{"title":"x"}`},
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
	if len(tools) != 2 || tools[0] != "mcp__board__add_task" || tools[1] != "mcp__board__nope" {
		t.Errorf("tool items: %v", tools)
	}

	// No handler, or a process without MCP access: an error text, no panic.
	f2 := New(model.Claude)
	f2.Script(func(tn *Turn) {
		if text, isErr := tn.Call("get_run", nil); !isErr || text == "" {
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

func TestBlock(t *testing.T) {
	got := Block("completed", "It works.", "## Report\n\n```go\nx := 1\n```")
	want := "<result>\n<outcome>completed</outcome>\n<summary>It works.</summary>\n<report>\n## Report\n\n```go\nx := 1\n```\n</report>\n</result>"
	if got != want {
		t.Errorf("Block:\n%s", got)
	}
}

func TestClock(t *testing.T) {
	start := time.UnixMilli(1_700_000_000_000)
	c := NewClock(start)
	if !c.Now().Equal(start) {
		t.Fatal("Now is not the start")
	}
	select {
	case at := <-c.After(0):
		if !at.Equal(start) {
			t.Errorf("After(0) gave %v", at)
		}
	default:
		t.Fatal("After(0) did not fire at once")
	}
	a, b := c.After(2*time.Second), c.After(time.Second)
	if c.Waiting() != 2 {
		t.Errorf("Waiting %d, want 2", c.Waiting())
	}
	c.Advance(999 * time.Millisecond)
	select {
	case <-a:
		t.Fatal("fired early")
	case <-b:
		t.Fatal("fired early")
	default:
	}
	c.Advance(time.Millisecond)
	select {
	case at := <-b:
		if !at.Equal(start.Add(time.Second)) {
			t.Errorf("fired at %v", at)
		}
	default:
		t.Fatal("the one-second timer did not fire")
	}
	select {
	case <-a:
		t.Fatal("the two-second timer fired at one second")
	default:
	}
	c.Advance(time.Hour) // nobody has to read a
	if c.Waiting() != 0 || !c.Now().Equal(start.Add(time.Hour+time.Second)) {
		t.Errorf("Waiting %d, Now %v", c.Waiting(), c.Now())
	}
	<-a
}

func TestRepo(t *testing.T) {
	// Poison the environment: the repository must not follow it.
	t.Setenv("GIT_DIR", "/nowhere")
	t.Setenv("GIT_AUTHOR_NAME", "Somebody Else")
	r := NewRepo(t)
	if resolved, err := filepath.EvalSymlinks(r.Dir()); err != nil || resolved != r.Dir() {
		t.Errorf("Dir %s is not resolved (%s, %v)", r.Dir(), resolved, err)
	}
	if got := r.Git("rev-parse", "--show-toplevel"); got != r.Dir() {
		t.Errorf("top level %s, want %s", got, r.Dir())
	}
	if got := r.Git("symbolic-ref", "--short", "HEAD"); got != "main" {
		t.Errorf("branch %q", got)
	}
	r.Write("dir/a.txt", "one\n")
	head := r.Commit("first")
	if len(head) != 40 || r.Git("rev-parse", "HEAD") != head {
		t.Errorf("head %q", head)
	}
	if got := r.Git("log", "-1", "--format=%an <%ae>|%s"); got != "Run Tester <run-tester@localhost>|first" {
		t.Errorf("commit: %s", got)
	}
	if r.Git("status", "--porcelain") != "" {
		t.Error("the work tree is not clean after Commit")
	}
	if head2 := r.Commit("empty"); head2 == head {
		t.Error("Commit with nothing changed made no commit")
	}
	env := strings.Join(r.Env(), "\n")
	for _, want := range []string{"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1"} {
		if !strings.Contains(env, want) {
			t.Errorf("Env lacks %s", want)
		}
	}
	if r.Git("config", "commit.gpgsign") != "false" {
		t.Error("commit.gpgsign is not false")
	}
	// Another program with the same environment sees the same repository.
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir, cmd.Env = r.Dir(), append(cleanEnv(), r.Env()...)
	if out, err := cmd.Output(); err != nil || strings.TrimSpace(string(out)) != r.Git("rev-parse", "HEAD") {
		t.Errorf("git with Env: %s %v", out, err)
	}
	if _, err := r.GitIn(r.Dir(), "rev-parse", "no-such-ref"); err == nil {
		t.Error("GitIn did not report a failure")
	}
}

// DueIn counts the Afters asked for with that duration since the clock last moved.
func TestClockDueIn(t *testing.T) {
	c := NewClock(time.Unix(1000, 0))
	c.After(time.Second)
	if c.DueIn(2*time.Second) != 0 {
		t.Fatal("an After of one second counted as one of two")
	}
	ch := c.After(2 * time.Second)
	if c.DueIn(2*time.Second) != 1 {
		t.Fatal("the After of two seconds is not counted")
	}
	c.Advance(time.Second)
	if c.DueIn(2*time.Second) != 0 || c.DueIn(time.Second) != 1 {
		t.Fatal("after a move of one second the After is not one second ahead")
	}
	c.Advance(time.Second)
	<-ch
	if c.DueIn(0) != 0 {
		t.Fatal("a fired After is still counted")
	}
}
