package pi

// Real-pi end-to-end tests. They call a real, authenticated pi with a cheap model and therefore
// only run when the caller opts in:
//
//	AIWB_PI_E2E=1 go test -count=1 -run TestE2E ./internal/pi/
//
// AIWB_PI_E2E_MODEL overrides the model (default deepseek/deepseek-flash). The third test (the
// subagent and abort cleanup) is additionally gated behind AIWB_PI_E2E_SUBAGENT=1.
//
// Isolation: every session/state path is a temp dir, and pi's config directory is a temp copy of
// the user's auth.json/models (read-only on the user's side), so the tests never write to
// ~/.ai-whiteboard or ~/.pi. A missing binary, absent credentials or an unavailable model skips
// the test with a clear message instead of failing.

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/pibridge"
	"ai-whiteboard/internal/prompts"
	"ai-whiteboard/internal/store"
)

// e2eModel is the provider-qualified model the e2e uses: cheap and authenticated on the machines
// this was developed on, overridable with AIWB_PI_E2E_MODEL.
func e2eModel() string {
	if m := os.Getenv("AIWB_PI_E2E_MODEL"); m != "" {
		return m
	}
	return "deepseek/deepseek-flash"
}

// e2eAgentDir gates the e2e suite, verifies the pi binary and points pi at a temp config dir
// holding a copy of the user's auth/models. It skips (with a reason) when the e2e is disabled, pi
// is missing, --version fails, or no credentials exist.
func e2eAgentDir(t *testing.T) {
	t.Helper()
	if os.Getenv("AIWB_PI_E2E") != "1" {
		t.Skip("AIWB_PI_E2E is not 1: skipping the real-pi e2e (it calls a paid model)")
	}
	if _, err := exec.LookPath("pi"); err != nil {
		t.Skip("the real pi binary is not on PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "pi", "--version").Output(); err != nil || strings.TrimSpace(string(out)) == "" {
		t.Skipf("pi --version failed (%v); is the real pi installed?", err)
	}

	src := os.Getenv("PI_CODING_AGENT_DIR")
	if src == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("cannot locate the home folder: %v", err)
		}
		src = filepath.Join(home, ".pi", "agent")
	}
	dst := t.TempDir()
	if err := os.MkdirAll(dst, 0o700); err != nil {
		t.Fatal(err)
	}
	copiedAuth := false
	for _, name := range []string{"auth.json", "models.json", "models-store.json"} {
		b, err := os.ReadFile(filepath.Join(src, name))
		if err != nil {
			continue
		}
		if err := os.WriteFile(filepath.Join(dst, name), b, 0o600); err != nil {
			t.Fatal(err)
		}
		if name == "auth.json" {
			copiedAuth = true
		}
	}
	if !copiedAuth && os.Getenv("DEEPSEEK_API_KEY") == "" {
		t.Skipf("no %s/auth.json and no DEEPSEEK_API_KEY: cannot authenticate pi", src)
	}
	t.Setenv("PI_CODING_AGENT_DIR", dst)
}

// e2eLoop is one turn-collection loop: it calls handle for every event and stops after EvTurnEnd
// (ok=true) or EvExit (ok=false).
func e2eTurn(t *testing.T, a agent.Agent, handle func(agent.Event)) bool {
	t.Helper()
	timeout := time.After(3 * time.Minute)
	for {
		select {
		case ev, ok := <-a.Events():
			if !ok {
				t.Fatal("events closed before the turn ended")
			}
			switch ev.Kind {
			case agent.EvTurnEnd:
				if ev.Error != "" {
					t.Fatalf("turn ended with error %q", ev.Error)
				}
				if ev.Aborted {
					t.Fatal("turn ended aborted")
				}
				return true
			case agent.EvExit:
				return false
			default:
				if handle != nil {
					handle(ev)
				}
			}
		case <-timeout:
			t.Fatal("timed out after 3 minutes waiting for the turn to end")
		}
	}
}

// closeAndWaitExit closes the run and asserts the one EvExit arrives.
func closeAndWaitExit(t *testing.T, a agent.Agent) {
	t.Helper()
	a.Close()
	if ev := waitKind(t, a, agent.EvExit); ev.Kind != agent.EvExit {
		t.Fatalf("last event %+v, want EvExit", ev)
	}
}

// TestE2EPlainChat runs a real plain pi chat (no board, no extension) and checks the streamed
// text reaches the turn end.
func TestE2EPlainChat(t *testing.T) {
	e2eAgentDir(t)
	root, home, cwd := t.TempDir(), t.TempDir(), t.TempDir()
	s := &Spawner{Bin: "pi", AppRoot: root, Home: home}
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "e2e-plain", Cwd: cwd, Model: e2eModel()})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a.Close()
	if err := a.Send([]agent.ContentBlock{{Text: "Reply with exactly: pong"}}); err != nil {
		t.Skipf("model %s is unavailable (not authenticated?): %v", e2eModel(), err)
	}

	var text strings.Builder
	if !e2eTurn(t, a, func(ev agent.Event) {
		if ev.Kind == agent.EvTextDelta {
			text.WriteString(ev.Text)
		}
	}) {
		t.Skip("pi exited before the turn ended (model or auth unavailable?)")
	}
	if !strings.Contains(strings.ToLower(text.String()), "pong") {
		t.Fatalf("streamed text %q does not contain pong", text.String())
	}
	t.Logf("plain chat streamed %q", text.String())
	closeAndWaitExit(t, a)
}

// e2eBoardCall is one board RPC the fake browser client answered.
type e2eBoardCall struct {
	chat, board, tool, args string
}

// e2eRecordingRegistry captures the run handle the Spawner mints and delegates
// to the real bridge.
type e2eRecordingRegistry struct {
	agent.BridgeRegistry

	mu       sync.Mutex
	runToken string
}

func (r *e2eRecordingRegistry) RegisterRun(chatID string, h agent.RunHandler) (string, string, error) {
	socket, token, err := r.BridgeRegistry.RegisterRun(chatID, h)
	if err == nil {
		r.mu.Lock()
		r.runToken = token
		r.mu.Unlock()
	}
	return socket, token, err
}

func (r *e2eRecordingRegistry) token() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.runToken
}

// e2eBoardEnv is a real board API environment for the model e2e: the store ›
// editor bridge › boards › chats stack, an httptest server serving the real
// Relay.ServeFixedMCP and the editor SSE endpoint, and a fake browser client
// answering board RPCs with a recognizable text. pi carries the chat's board
// token in the Authorization header of the fixed /mcp endpoint.
type e2eBoardEnv struct {
	editor *editorbridge.Bridge
	reg    *e2eRecordingRegistry
	srv    *httptest.Server

	board model.Board
	chat  string
	token string // the chat's board token: the MCP credential in the header

	mu      sync.Mutex
	reply   string
	errText map[string]string // tool name → error text
	calls   []e2eBoardCall
}

// newE2EBoardEnv builds the environment and starts the fake browser client.
func newE2EBoardEnv(t *testing.T) *e2eBoardEnv {
	t.Helper()
	st, err := store.Open(store.NewPaths(t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	editor := editorbridge.New(nil)
	bds := boards.New(st, editor)
	if err := bds.Load(); err != nil {
		t.Fatal(err)
	}
	m := chats.New(chats.Deps{Store: st, Bridge: editor, Boards: bds, DefaultCwd: t.TempDir()})
	if err := m.Load(); err != nil {
		t.Fatal(err)
	}
	bd, err := bds.Create("e2e", model.Ungrouped, false)
	if err != nil {
		t.Fatal(err)
	}
	v, err := m.Create(model.Claude, "", bd.ID)
	if err != nil {
		t.Fatal(err)
	}
	metas := m.ChatsOfBoard(bd.ID)
	if len(metas) != 1 || metas[0].Token == "" {
		t.Fatalf("board chats %+v", metas)
	}

	pb := pibridge.New(pibridge.SocketPath(t.TempDir()))
	if err := pb.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pb.Close)

	relay := &boardapi.Relay{Bridge: editor, Chats: m, Boards: bds}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /mcp", relay.ServeFixedMCP)
	mux.HandleFunc("GET /api/events", editor.ServeSSE)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	e := &e2eBoardEnv{
		editor: editor, reg: &e2eRecordingRegistry{BridgeRegistry: pb},
		srv: srv, board: bd, chat: v.ID, token: metas[0].Token,
		errText: map[string]string{},
	}
	e.startBrowser(t)
	return e
}

// startBrowser connects the fake browser: it answers every board RPC with the
// configured text (or the tool's configured error) and records every call.
func (e *e2eBoardEnv) startBrowser(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, "GET", e.srv.URL+"/api/events?client=A", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := e.srv.Client().Do(req)
	if err != nil {
		t.Fatalf("board SSE connect: %v", err)
	}
	active := make(chan struct{})
	go func() {
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 1<<20)
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data: ")
			if !ok {
				continue
			}
			var ev map[string]any
			if json.Unmarshal([]byte(line), &ev) != nil {
				continue
			}
			switch ev["type"] {
			case "hello":
				close(active)
			case "rpc":
				p, _ := ev["params"].(map[string]any)
				e.answerRPC(str(ev["id"]), p)
			}
		}
	}()
	select {
	case <-active:
	case <-time.After(2 * time.Second):
		t.Fatal("board browser client did not become active")
	}
}

// answerRPC records one board call and replies with the configured text or the
// tool's configured error.
func (e *e2eBoardEnv) answerRPC(id string, params map[string]any) {
	tool := str(params["name"])
	e.mu.Lock()
	e.calls = append(e.calls, e2eBoardCall{
		chat: str(params["chat"]), board: str(params["board"]), tool: tool,
		args: string(mustJSON(params["args"])),
	})
	reply, errText := e.reply, e.errText[tool]
	e.mu.Unlock()
	if errText != "" {
		e.editor.Reply(id, editorbridge.RPCReply{Error: errText})
		return
	}
	if reply == "" {
		reply = "empty board list"
	}
	e.editor.Reply(id, editorbridge.RPCReply{Result: mustJSON(reply)})
}

func (e *e2eBoardEnv) setReply(reply string) {
	e.mu.Lock()
	e.reply = reply
	e.mu.Unlock()
}

func (e *e2eBoardEnv) setError(tool, text string) {
	e.mu.Lock()
	e.errText[tool] = text
	e.mu.Unlock()
}

func (e *e2eBoardEnv) recorded() []e2eBoardCall {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]e2eBoardCall(nil), e.calls...)
}

// boardAccess is what the app passes to Spawn: the fixed endpoint URL and the
// chat's durable board token, exactly like the Claude path. pi puts the token in
// the Authorization header of AIWB_MCP_CONFIG; it is never a URL segment.
func (e *e2eBoardEnv) boardAccess() *agent.BoardAccess {
	return &agent.BoardAccess{MCPURL: e.srv.URL + "/mcp", Token: e.token}
}

// newSpawner builds the app Spawner over a freshly materialized extension tree
// and the recording bridge registry. extra is the test-only non-board MCP
// config seam (A6), normally nil.
func (e *e2eBoardEnv) newSpawner(t *testing.T, extra map[string]mcpServerConfig) *Spawner {
	t.Helper()
	ext, err := pibridge.MaterializeExtension(filepath.Join(t.TempDir(), "ext"))
	if err != nil {
		t.Fatal(err)
	}
	return &Spawner{Bin: "pi", AppRoot: t.TempDir(), Home: t.TempDir(), Extension: ext,
		Prompt: prompts.Pi(), Bridge: e.reg, mcpConfigExtra: extra}
}

// TestE2EBoardTool runs the whole board path with a real model: real pi loads
// the board tools over MCP, its tools/call reaches the fixed HTTP /mcp with the
// chat's board token in the Authorization header, the relay dispatches to the
// fake browser client, and the board's text is returned as the pi tool result. A
// second turn pins error propagation: a board error comes back as a failed pi
// tool result carrying the board's text (A5).
func TestE2EBoardTool(t *testing.T) {
	e2eAgentDir(t)
	env := newE2EBoardEnv(t)
	env.setReply("E2E-BOARD-TEXT-42")
	env.setError("read_board", "E2E-BOARD-ERROR-99")
	s := env.newSpawner(t, nil)
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "e2e-board", Cwd: t.TempDir(), Model: e2eModel(),
		Board: env.boardAccess()})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a.Close()
	const prompt = "Call the tool named mcp__board__list_boards with an empty object argument. Then " +
		"reply with exactly the text the tool returned, and nothing else."
	if err := a.Send([]agent.ContentBlock{{Text: prompt}}); err != nil {
		t.Skipf("model %s is unavailable (not authenticated?): %v", e2eModel(), err)
	}

	var toolID string
	var result strings.Builder
	var text strings.Builder
	called := false
	if !e2eTurn(t, a, func(ev agent.Event) {
		switch ev.Kind {
		case agent.EvToolStart:
			if ev.ToolName == "mcp__board__list_boards" {
				called = true
				toolID = ev.ToolID
			}
		case agent.EvToolResult:
			if ev.ToolID == toolID {
				result.Reset()
				result.WriteString(ev.Result)
			}
		case agent.EvTextDelta:
			text.WriteString(ev.Text)
		}
	}) {
		t.Skip("pi exited before the turn ended (model or auth unavailable?)")
	}
	if !called {
		t.Fatalf("the model never called mcp__board__list_boards; streamed text %q", text.String())
	}
	if !strings.Contains(result.String(), "E2E-BOARD-TEXT-42") {
		t.Fatalf("tool result %q does not contain the fake client's text", result.String())
	}
	calls := env.recorded()
	if len(calls) == 0 {
		t.Fatal("the fake browser client was never invoked")
	}
	for _, call := range calls {
		if call.tool != "list_boards" || call.chat != env.chat || call.board != env.board.ID {
			t.Fatalf("browser client saw %+v, want list_boards for chat %s board %s", call, env.chat, env.board.ID)
		}
	}

	// The app relay attributed the call to the chat through the board-token
	// header; the run handle is only the non-secret bridge identifier (D15).
	wantRun := env.reg.token()
	if wantRun == "" || wantRun == env.token {
		t.Fatalf("bridge run handle %q (board token %q), want a fresh non-secret handle", wantRun, env.token)
	}
	t.Logf("board tool calls: %+v; run handle %s; result %q; text %q", calls, wantRun, result.String(), text.String())

	// Error propagation: the board's error text must arrive as a failed pi tool
	// result, not as a successful payload.
	if err := a.Send([]agent.ContentBlock{{Text: "Call the tool named mcp__board__read_board with argument " +
		`{"board":"b1"}. Then reply with the error text.`}}); err != nil {
		t.Fatalf("second Send: %v", err)
	}
	errID := ""
	errResult := ""
	sawErr := false
	if !e2eTurn(t, a, func(ev agent.Event) {
		switch ev.Kind {
		case agent.EvToolStart:
			if ev.ToolName == "mcp__board__read_board" {
				errID = ev.ToolID
			}
		case agent.EvToolResult:
			if errID != "" && ev.ToolID == errID {
				sawErr = true
				errResult = ev.Result
				if !ev.IsError {
					t.Errorf("board error result is not a failed pi tool result: %+v", ev)
				}
			}
		}
	}) {
		t.Skip("pi exited before the error turn ended (model or auth unavailable?)")
	}
	if errID == "" {
		t.Fatalf("the model never called mcp__board__read_board on the error turn")
	}
	if !sawErr || !strings.Contains(errResult, "E2E-BOARD-ERROR-99") {
		t.Fatalf("error tool result %q does not carry the board's error text", errResult)
	}
	t.Logf("board error result %q", errResult)
	closeAndWaitExit(t, a)
}

// processArgsContaining returns the pids whose command line contains marker.
func processArgsContaining(t *testing.T, marker string) []int {
	t.Helper()
	out, err := exec.Command("ps", "-eo", "pid=,command=").Output()
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	var pids []int
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		pidField, cmd, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		pid, err := strconv.Atoi(pidField)
		if err != nil || pid <= 1 {
			continue
		}
		if strings.Contains(cmd, marker) {
			pids = append(pids, pid)
		}
	}
	return pids
}

// waitNoProcesses waits until no command line contains marker, failing (and killing leftovers)
// after 15 s.
func waitNoProcesses(t *testing.T, marker string) {
	t.Helper()
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		pids := processArgsContaining(t, marker)
		if len(pids) == 0 {
			return
		}
		if time.Now().After(deadline) {
			for _, pid := range pids {
				syscall.Kill(pid, syscall.SIGKILL)
			}
			t.Fatalf("processes %v still contain the subagent session dir %s", pids, marker)
		}
	}
}

// TestE2ESubagent runs the app subagent tool end to end and then aborts a second child mid-run.
// Gated behind AIWB_PI_E2E_SUBAGENT=1 because it is the most timing-sensitive test.
func TestE2ESubagent(t *testing.T) {
	e2eAgentDir(t)
	if os.Getenv("AIWB_PI_E2E_SUBAGENT") != "1" {
		t.Skip("AIWB_PI_E2E_SUBAGENT is not 1: skipping the subagent e2e")
	}
	root, home, cwd := t.TempDir(), t.TempDir(), t.TempDir()
	ext, err := pibridge.MaterializeExtension(filepath.Join(t.TempDir(), "ext"))
	if err != nil {
		t.Fatal(err)
	}
	br := pibridge.New(pibridge.SocketPath(root))
	if err := br.Start(); err != nil {
		t.Fatal(err)
	}
	defer br.Close()
	s := &Spawner{Bin: "pi", AppRoot: root, Home: home, Extension: ext, Prompt: prompts.Pi(), Bridge: br}

	// Scenario 1: a foreground child completes and leaves no process behind.
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "e2e-sub", Cwd: cwd, Model: e2eModel()})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a.Close()
	if err := a.Send([]agent.ContentBlock{{Text: "Call the subagent tool once with description \"ping test\" " +
		"and prompt \"Reply with exactly: ping\". Then reply with the child's report."}}); err != nil {
		t.Skipf("model %s is unavailable (not authenticated?): %v", e2eModel(), err)
	}
	agentCard := false
	terminal := false
	if !e2eTurn(t, a, func(ev agent.Event) {
		switch ev.Kind {
		case agent.EvToolStart:
			if ev.ToolName == "Agent" {
				agentCard = true
			}
		case agent.EvSub:
			if ev.SubInfo != nil && subTerminal(ev.SubInfo.Status) {
				terminal = true
			}
		}
	}) {
		t.Skip("pi exited before the turn ended (model or auth unavailable?)")
	}
	if !agentCard {
		t.Fatal("no Agent tool card was emitted for the subagent call")
	}
	if !terminal {
		t.Fatal("no EvSub reached a terminal status")
	}
	closeAndWaitExit(t, a)
	waitNoProcesses(t, filepath.Join(root, "chats", "e2e-sub", "subagents"))

	// Scenario 2: abort a running child and check its process tree is gone.
	a2, err := s.Spawn(agent.SpawnOptions{ChatID: "e2e-sub-abort", Cwd: cwd, Model: e2eModel()})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a2.Close()
	if err := a2.Send([]agent.ContentBlock{{Text: "Call the subagent tool once with description \"blocked\" " +
		"and prompt \"Run the shell command sleep 120, then reply done.\" Wait for the child to finish, " +
		"then reply with its report."}}); err != nil {
		t.Skipf("model %s is unavailable (not authenticated?): %v", e2eModel(), err)
	}
	subDir := filepath.Join(root, "chats", "e2e-sub-abort", "subagents")
	started, parentDone := false, false
	deadline := time.Now().Add(3 * time.Minute)
	for !started && !parentDone {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the subagent process")
		}
		select {
		case ev, ok := <-a2.Events():
			if !ok || ev.Kind == agent.EvTurnEnd || ev.Kind == agent.EvExit {
				parentDone = true
			}
		case <-time.After(200 * time.Millisecond):
		}
		if len(processArgsContaining(t, subDir)) > 0 {
			started = true
		}
	}
	if !started {
		t.Skip("the subagent finished before it could be aborted")
	}
	if err := a2.Interrupt(); err != nil {
		t.Fatal(err)
	}
	waitNoProcesses(t, subDir)
	closeAndWaitExit(t, a2)

	// Scenario 3: a board chat's subagent inherits the board MCP tools (A10):
	// the child calls the board tool and its call reaches the fake browser
	// client through the parent's board MCP config.
	env := newE2EBoardEnv(t)
	env.setReply("E2E-BOARD-SUB-TEXT-13")
	s3 := env.newSpawner(t, nil)
	a3, err := s3.Spawn(agent.SpawnOptions{ChatID: "e2e-sub-board", Cwd: cwd, Model: e2eModel(),
		Board: env.boardAccess()})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a3.Close()
	if err := a3.Send([]agent.ContentBlock{{Text: "Call the subagent tool once with description \"board check\" " +
		"and prompt \"Call the tool named mcp__board__list_boards with an empty object argument, then reply " +
		"with exactly the text it returned.\" Then reply with the child's report."}}); err != nil {
		t.Skipf("model %s is unavailable (not authenticated?): %v", e2eModel(), err)
	}
	childCalledBoard := false
	if !e2eTurn(t, a3, func(ev agent.Event) {
		if ev.Kind == agent.EvToolStart && ev.Sub != "" && ev.ToolName == "mcp__board__list_boards" {
			childCalledBoard = true
		}
	}) {
		t.Skip("pi exited before the board-subagent turn ended (model or auth unavailable?)")
	}
	if !childCalledBoard {
		t.Fatalf("the board-chat subagent never called the board tool; browser calls %+v", env.recorded())
	}
	childCalls := env.recorded()
	if len(childCalls) == 0 {
		t.Fatal("the fake browser client was never invoked by the child")
	}
	for _, call := range childCalls {
		if call.tool != "list_boards" {
			t.Fatalf("child board call %+v, want list_boards", call)
		}
	}
	t.Logf("board-chat subagent calls: %+v", childCalls)
	closeAndWaitExit(t, a3)
}

// subTerminal reports whether a subagent status is final.
func subTerminal(s model.SubStatus) bool {
	switch s {
	case model.SubCompleted, model.SubFailed, model.SubStopped:
		return true
	}
	return false
}
