package pi

// Real-pi end-to-end tests. They call a real, authenticated pi with a cheap model and therefore
// only run when the caller opts in:
//
//	AIWB_PI_E2E=1 go test -count=1 -run TestE2E ./internal/pi/
//
// AIWB_PI_E2E_MODEL overrides the model (default deepseek/deepseek-flash). The subagent tests
// are additionally gated behind AIWB_PI_E2E_SUBAGENT=1: TestE2ESubagent (app-managed MCP spawn
// family via Manager.SpawnSubagent, a child's ending and stop, abort cleanup) and
// TestE2ESubagentDelivery (a pi parent that spawns over the real MCP endpoint and gets the results
// as messages from the app). Native Agent/Task/subagent is not registered on app chats and is not
// an escape hatch.
//
// Isolation: every session/state path is a temp dir, and pi's config directory is a temp copy of
// the user's auth.json/models (read-only on the user's side), so the tests never write to
// ~/.ai-whiteboard or ~/.pi. A missing binary, absent credentials or an unavailable model skips
// the test with a clear message instead of failing.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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
// answering board RPCs with a recognizable text. pi carries the chat's MCP
// token in the Authorization header of the fixed /mcp endpoint.
type e2eBoardEnv struct {
	editor *editorbridge.Bridge
	reg    *e2eRecordingRegistry
	srv    *httptest.Server
	m      *chats.Manager

	board model.Board
	chat  string
	token string // the chat's MCP token: the credential in the Authorization header

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
	m.MCPURL = srv.URL + "/mcp"

	e := &e2eBoardEnv{
		editor: editor, reg: &e2eRecordingRegistry{BridgeRegistry: pb},
		srv: srv, m: m, board: bd, chat: v.ID, token: metas[0].Token,
		errText: map[string]string{},
	}
	t.Cleanup(m.Shutdown)
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
// chat's durable MCP token, exactly like the Claude path. pi puts the token in
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
		MCP: env.boardAccess(), BoardID: "e2e-board"})
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

// newE2EPiManager builds a chats.Manager that spawns real Pi processes through s.
func newE2EPiManager(t *testing.T, s *Spawner, cwd string) *chats.Manager {
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
	m := chats.New(chats.Deps{
		Store: st, Bridge: editor, Boards: bds,
		Spawners:   map[model.AgentKind]agent.Spawner{model.Pi: s},
		DefaultCwd: cwd,
	})
	if err := m.Load(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Shutdown)
	return m
}

func e2eCreatePi(t *testing.T, m *chats.Manager) model.ChatView {
	t.Helper()
	v, err := m.Create(model.Pi, model.Ungrouped, "")
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func e2eSpawnPi(t *testing.T, m *chats.Manager, chatID string, req chats.SpawnSubRequest) model.Subagent {
	t.Helper()
	if req.Model == "" {
		req.Model = e2eModel()
	}
	sa, err := m.SpawnSubagent(chatID, req)
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	if sa.Kind != model.Pi || !sa.Background {
		t.Fatalf("receipt %+v, want kind=pi background", sa)
	}
	return sa
}

// e2eSub returns one subagent of a chat as the manager's items give it.
func e2eSub(t *testing.T, m *chats.Manager, chatID, sid string) model.Subagent {
	t.Helper()
	_, _, subs, err := m.Items(chatID)
	if err != nil {
		t.Fatal(err)
	}
	for _, sa := range subs {
		if sa.ID == sid {
			return sa
		}
	}
	t.Fatalf("no subagent %s in %+v", sid, subs)
	return model.Subagent{}
}

// e2eEndedSub returns the subagent once it has ended, or as it is after three minutes.
func e2eEndedSub(t *testing.T, m *chats.Manager, chatID, sid string) model.Subagent {
	t.Helper()
	deadline := time.Now().Add(3 * time.Minute)
	for {
		sa := e2eSub(t, m, chatID, sid)
		if subTerminal(sa.Status) || time.Now().After(deadline) {
			return sa
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func skipIfSubUnavailable(t *testing.T, r model.Subagent) {
	t.Helper()
	if r.Status == model.SubCompleted {
		return
	}
	msg := strings.ToLower(r.Error + " " + r.Last)
	for _, needle := range []string{"unavailable", "not authenticated", "handshake", "could not start"} {
		if strings.Contains(msg, needle) {
			t.Skipf("pi subagent did not run: status=%s error=%q last=%q", r.Status, r.Error, r.Last)
		}
	}
}

// TestE2ESubagent drives app-spawned Pi subagents through chats.Manager.SpawnSubagent (the MCP
// spawn family), not the extension's native subagent tool, which is not registered on app chats.
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
	m := newE2EPiManager(t, s, cwd)

	// Scenario 1: an app-spawned child completes; kind/background persist; no leftover process.
	v := e2eCreatePi(t, m)
	sa := e2eSpawnPi(t, m, v.ID, chats.SpawnSubRequest{Prompt: "Reply with exactly: ping", Description: "ping test"})
	childDir := filepath.Join(root, "chats", v.ID, "subagents")
	parentDir := filepath.Join(root, "chats", v.ID, "pi")
	if childDir == parentDir {
		t.Fatalf("child session dir %q reuses the parent", childDir)
	}
	got := e2eEndedSub(t, m, v.ID, sa.ID)
	skipIfSubUnavailable(t, got)
	if got.Status != model.SubCompleted {
		t.Fatalf("subagent status %s error %q last %q, want completed", got.Status, got.Error, got.Last)
	}
	if !strings.Contains(strings.ToLower(got.Last), "ping") {
		t.Fatalf("completed last %q does not contain ping", got.Last)
	}
	_, _, subs, err := m.Items(v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || subs[0].ID != sa.ID || subs[0].Kind != model.Pi || !subs[0].Background {
		t.Fatalf("items subagents %+v", subs)
	}
	raw, err := os.ReadFile(filepath.Join(m.Store.P.ChatDir(v.ID), "subagents", sa.ID, "subagent.json"))
	if err != nil {
		t.Fatal(err)
	}
	var disk model.Subagent
	if err := json.Unmarshal(raw, &disk); err != nil {
		t.Fatal(err)
	}
	if disk.Kind != model.Pi || !disk.Background || disk.Status != model.SubCompleted {
		t.Fatalf("subagent.json %+v", disk)
	}
	waitNoProcesses(t, childDir)

	// Scenario 2: StopSubagent kills a running child; no leftover process.
	v2 := e2eCreatePi(t, m)
	sa2 := e2eSpawnPi(t, m, v2.ID, chats.SpawnSubRequest{
		Prompt: "Run the shell command sleep 120, then reply done.", Description: "blocked",
	})
	subDir := filepath.Join(root, "chats", v2.ID, "subagents")
	started := false
	deadline := time.Now().Add(3 * time.Minute)
	for !started {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the subagent process")
		}
		if subTerminal(e2eSub(t, m, v2.ID, sa2.ID).Status) {
			t.Skip("the subagent finished before it could be aborted")
		}
		if len(processArgsContaining(t, subDir)) > 0 {
			started = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if err := m.StopSubagent(v2.ID, sa2.ID); err != nil {
		t.Fatal(err)
	}
	stopped := e2eEndedSub(t, m, v2.ID, sa2.ID)
	if stopped.Status != model.SubStopped {
		t.Fatalf("after StopSubagent status %s error %q, want stopped", stopped.Status, stopped.Error)
	}
	waitNoProcesses(t, subDir)

	// Scenario 3: a board-parent app-spawned Pi child inherits board tools; the call reaches
	// the fake browser client. Distinct ChatID so the parent bridge is not retired.
	env := newE2EBoardEnv(t)
	env.setReply("E2E-BOARD-SUB-TEXT-13")
	s3 := env.newSpawner(t, nil)
	if env.m.Spawners == nil {
		env.m.Spawners = map[model.AgentKind]agent.Spawner{}
	}
	env.m.Spawners[model.Pi] = s3
	pv, err := env.m.Create(model.Pi, "", env.board.ID)
	if err != nil {
		t.Fatal(err)
	}
	sa3 := e2eSpawnPi(t, env.m, pv.ID, chats.SpawnSubRequest{
		Prompt: "Call the tool named mcp__board__list_boards with an empty object argument. Then " +
			"reply with exactly the text the tool returned, and nothing else.",
		Description: "board check",
	})
	boardChildDir := filepath.Join(s3.AppRoot, "chats", pv.ID, "subagents")
	boardGot := e2eEndedSub(t, env.m, pv.ID, sa3.ID)
	skipIfSubUnavailable(t, boardGot)
	if boardGot.Status != model.SubCompleted {
		t.Fatalf("board subagent status %s error %q last %q, want completed", boardGot.Status, boardGot.Error, boardGot.Last)
	}
	childCalls := env.recorded()
	if len(childCalls) == 0 {
		t.Fatalf("the fake browser client was never invoked by the child; last %q", boardGot.Last)
	}
	for _, call := range childCalls {
		if call.tool != "list_boards" {
			t.Fatalf("child board call %+v, want list_boards", call)
		}
	}
	if !strings.Contains(boardGot.Last, "E2E-BOARD-SUB-TEXT-13") {
		t.Fatalf("child last %q does not contain the board text", boardGot.Last)
	}
	t.Logf("board-chat subagent calls: %+v", childCalls)
	waitNoProcesses(t, boardChildDir)
}

// e2eChat is one chat of a real-pi manager, as the delivery scenario reads it. seen, when set, is
// handed every reading the chat's watches take.
type e2eChat struct {
	t    *testing.T
	m    *chats.Manager
	id   string
	seen func(e2eSnap)
}

// e2eSnap is one reading of a chat: its thread and subagents, then its view.
type e2eSnap struct {
	view  model.ChatView
	items []model.Item
	subs  []model.Subagent
}

func e2eBusy(st model.Status) bool {
	switch st {
	case model.StatusThinking, model.StatusWriting, model.StatusTool, model.StatusApproval:
		return true
	}
	return false
}

func (c e2eChat) snap() e2eSnap {
	c.t.Helper()
	_, items, subs, err := c.m.Items(c.id)
	if err != nil {
		c.t.Fatal(err)
	}
	v, err := c.m.View(c.id)
	if err != nil {
		c.t.Fatal(err)
	}
	return e2eSnap{view: v, items: items, subs: subs}
}

// line is the state a reading shows, on one line: turn count, status, the two counts and every
// subagent's status and delivery state.
func (s e2eSnap) line() string {
	var subs []string
	for _, sa := range s.subs {
		d := string(sa.Delivery)
		if d == "" {
			d = "-"
		}
		subs = append(subs, fmt.Sprintf("%s:%s/%s", sa.ID, sa.Status, d))
	}
	return fmt.Sprintf("turns=%d status=%s running=%d owed=%d subagents=[%s]",
		s.view.Usage.Turns, s.view.Status, s.view.SubsRunning, s.view.SubsOwed, strings.Join(subs, " "))
}

// thread is the chat's thread, one short line per item.
func (s e2eSnap) thread() string {
	var b strings.Builder
	short := func(v string) string {
		v = strings.Join(strings.Fields(v), " ")
		if len(v) > 160 {
			v = v[:160] + "…"
		}
		return v
	}
	for i, it := range s.items {
		switch it.Kind {
		case "tool":
			input := string(it.Input)
			if input == "" {
				input = it.Partial
			}
			fmt.Fprintf(&b, "  %2d tool %s %s\n", i, it.Name, short(input))
		case "subresult":
			fmt.Fprintf(&b, "  %2d subresult %s\n", i, it.Subagent)
		case "note":
			fmt.Fprintf(&b, "  %2d note(%s) %s\n", i, it.Tone, short(it.Text))
		default:
			fmt.Fprintf(&b, "  %2d %s %s\n", i, it.Kind, short(it.Text))
		}
	}
	return b.String()
}

func (s e2eSnap) sub(sid string) model.Subagent {
	for _, sa := range s.subs {
		if sa.ID == sid {
			return sa
		}
	}
	return model.Subagent{}
}

// row is the index of the subagent's result row in the thread and how many rows it has.
func (s e2eSnap) row(sid string) (at, n int) {
	at = -1
	for i, it := range s.items {
		if it.Kind == "subresult" && it.Subagent == sid {
			at = i
			n++
		}
	}
	return at, n
}

// notes counts the thread's notes of one tone ("" = any) with the given text ("" = any).
func (s e2eSnap) notes(tone, text string) int {
	n := 0
	for _, it := range s.items {
		if it.Kind == "note" && (tone == "" || it.Tone == tone) && (text == "" || it.Text == text) {
			n++
		}
	}
	return n
}

// lastUser is the index of the last message of the human's, -1 when there is none.
func (s e2eSnap) lastUser() int {
	for i := len(s.items) - 1; i >= 0; i-- {
		if s.items[i].Kind == "user" {
			return i
		}
	}
	return -1
}

// text is what the agent wrote in items[from:to], lower-cased.
func (s e2eSnap) text(from, to int) string {
	var b strings.Builder
	for i := max(from, 0); i < min(to, len(s.items)); i++ {
		if s.items[i].Kind == "text" {
			b.WriteString(s.items[i].Text)
			b.WriteString("\n")
		}
	}
	return strings.ToLower(b.String())
}

// sleeps are the agent's own tool calls in items[from:to] that sleep: what an agent that waits for
// its subagents, instead of ending its turn, runs. A spawn_subagent call may name a sleep in the
// task it hands over; the subagent's own calls are in its own thread, not in items.
func (s e2eSnap) sleeps(from, to int) []string {
	var out []string
	for i := max(from, 0); i < min(to, len(s.items)); i++ {
		it := s.items[i]
		if it.Kind != "tool" || strings.HasSuffix(it.Name, "spawn_subagent") {
			continue
		}
		if call := it.Name + " " + string(it.Input) + it.Partial; strings.Contains(strings.ToLower(call), "sleep") {
			out = append(out, call)
		}
	}
	return out
}

// until polls the chat until done reports true and returns that reading. Every change of the turn
// count, the status or a subagent's state is logged, so a run shows what the agent did and when.
// After three minutes it fails with what and the thread.
func (c e2eChat) until(what string, done func(e2eSnap) bool) e2eSnap {
	c.t.Helper()
	return c.watch(3*time.Minute, what, done, true)
}

// stays polls the chat for d and fails as soon as ok reports false.
func (c e2eChat) stays(d time.Duration, what string, ok func(e2eSnap) bool) e2eSnap {
	c.t.Helper()
	return c.watch(d, what, func(s e2eSnap) bool { return !ok(s) }, false)
}

func (c e2eChat) watch(d time.Duration, what string, hit func(e2eSnap) bool, want bool) e2eSnap {
	c.t.Helper()
	deadline := time.Now().Add(d)
	last := ""
	for {
		s := c.snap()
		if c.seen != nil {
			c.seen(s)
		}
		if line := s.line(); line != last {
			c.t.Logf("    %s", line)
			last = line
		}
		if hit(s) {
			if !want {
				c.t.Fatalf("not true any more: %s; %s; thread:\n%s", what, s.line(), s.thread())
			}
			return s
		}
		if time.Now().After(deadline) {
			if want {
				c.t.Fatalf("timed out waiting until %s; %s; thread:\n%s", what, s.line(), s.thread())
			}
			return s
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (c e2eChat) send(text string) {
	c.t.Helper()
	if err := c.m.Send(c.id, text, "", nil); err != nil {
		c.t.Fatalf("Send %q: %v", text, err)
	}
}

// spawned waits for the subagent the agent's running turn starts through spawn_subagent, the one
// not in known, and fails when the turn (the one after `turns`) ends without one. The subagent
// must run on the e2e model, like its parent.
func (c e2eChat) spawned(known map[string]bool, turns int) string {
	c.t.Helper()
	sid := ""
	c.until("the agent calls spawn_subagent", func(s e2eSnap) bool {
		for _, sa := range s.subs {
			if !known[sa.ID] {
				sid = sa.ID
				if sa.Kind != model.Pi || sa.Model != e2eModel() {
					c.t.Fatalf("subagent %+v, want a pi subagent on %s", sa, e2eModel())
				}
				return true
			}
		}
		if s.view.Usage.Turns > turns && !e2eBusy(s.view.Status) {
			c.t.Fatalf("the agent's turn ended without a spawn_subagent call; thread:\n%s", s.thread())
		}
		return false
	})
	known[sid] = true
	return sid
}

// e2eDescendants returns the processes under pid, itself not included: its children and theirs.
// pi renames its process, so once it runs it cannot be found by its arguments (waitNoProcesses
// sees a pi process only in its first moments); its place in the process tree stays.
func e2eDescendants(t *testing.T, pid int) []int {
	t.Helper()
	cmd := exec.Command("ps", "-axo", "pid=,ppid=")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	children := map[int][]int{}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		p, err1 := strconv.Atoi(f[0])
		pp, err2 := strconv.Atoi(f[1])
		if err1 != nil || err2 != nil || p == cmd.Process.Pid {
			continue
		}
		children[pp] = append(children[pp], p)
	}
	var all []int
	for next := children[pid]; len(next) > 0; {
		p := next[0]
		next = append(next[1:], children[p]...)
		all = append(all, p)
	}
	return all
}

// e2eAlive returns those of pids that are still processes.
func e2eAlive(pids []int) []int {
	var alive []int
	for _, pid := range pids {
		if syscall.Kill(pid, 0) == nil {
			alive = append(alive, pid)
		}
	}
	return alive
}

// e2eWaitGone waits until none of the processes pids() returns is left, failing (and killing the
// leftovers) after 15 s.
func e2eWaitGone(t *testing.T, what string, pids func() []int) {
	t.Helper()
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		left := pids()
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			for _, pid := range left {
				syscall.Kill(pid, syscall.SIGKILL)
			}
			t.Fatalf("%s: processes %v are still running", what, left)
		}
	}
}

// TestE2ESubagentDelivery checks push delivery of subagent results with a real pi parent. The
// parent runs through Manager.Send on a manager that has the pi spawner and the real MCP endpoint,
// so the model itself calls spawn_subagent over MCP and the app sends it the results. pi has no
// steering for this but the tool's description. Three parts, on one chat:
//
//   - Delivery: the agent spawns a subagent and ends its turn while the subagent still runs (the
//     chat is ready with a subagent running); the result reaches it as a message from the app,
//     which starts its second turn; it did not sleep to wait.
//   - A completion during a turn of the agent's: the result waits (owed) while the agent works on
//     a message of the human's, and is delivered as a new turn once that turn has settled. This is
//     a prompt sent to pi straight after its settle signal.
//   - Stop while waiting: Interrupt with the agent idle and a subagent running stops the subagent
//     and starts no turn, and the idle pi process takes the next message normally.
//
// Gated like TestE2ESubagent.
func TestE2ESubagentDelivery(t *testing.T) {
	e2eAgentDir(t)
	if os.Getenv("AIWB_PI_E2E_SUBAGENT") != "1" {
		t.Skip("AIWB_PI_E2E_SUBAGENT is not 1: skipping the subagent delivery e2e")
	}
	// Registered first, so it runs after the manager's Shutdown: no process of this run is left.
	t.Cleanup(func() {
		e2eWaitGone(t, "after Shutdown", func() []int { return e2eDescendants(t, os.Getpid()) })
	})
	env := newE2EBoardEnv(t)
	s := env.newSpawner(t, nil)
	m := env.m
	m.Spawners = map[model.AgentKind]agent.Spawner{model.Pi: s}
	v := e2eCreatePi(t, m)
	if err := m.Configure(v.ID, chats.ConfigReq{Model: e2eModel()}); err != nil {
		t.Fatal(err)
	}
	c := e2eChat{t: t, m: m, id: v.ID}
	known := map[string]bool{}
	// The agent's own process and what it keeps running; a subagent's processes come on top.
	var parent []int
	subProcs := func() []int {
		var out []int
		for _, pid := range e2eDescendants(t, os.Getpid()) {
			if !slices.Contains(parent, pid) {
				out = append(out, pid)
			}
		}
		return out
	}
	spawnPrompt := func(task, description, then string) string {
		return fmt.Sprintf("Start one subagent with the spawn_subagent tool: its prompt is %q and its description is %q.%s",
			task, description, then)
	}
	const repeat = " When its result arrives, reply with the word it reported."

	// Part 1, delivery. The subagent's task takes a few seconds, so the agent's first turn ends
	// before it does and the result is delivered to an idle agent. A subagent that ended during
	// that turn would have its result sent after the turn settles (part 2's path) instead. Every
	// reading from the spawn to the second turn's end is checked (the watches read every 50 ms;
	// the window is seconds long): at least one must show the first turn ended with the chat ready
	// and the subagent running.
	t.Log("delivery: the agent spawns a subagent, ends its turn while it runs, and gets the result as a message")
	var readings []string
	var first *e2eSnap
	waited := false
	c.seen = func(s e2eSnap) {
		if line := s.line(); len(readings) == 0 || readings[len(readings)-1] != line {
			readings = append(readings, line)
		}
		if s.view.Usage.Turns == 1 && first == nil {
			first = &s
		}
		if s.view.Usage.Turns == 1 && s.view.Status == model.StatusReady && s.view.SubsRunning > 0 {
			waited = true
		}
	}
	if err := m.Send(v.ID, spawnPrompt("Run the shell command sleep 5, then reply with exactly: QUOKKA", "word", repeat), "", nil); err != nil {
		t.Skipf("model %s is unavailable (not authenticated?): %v", e2eModel(), err)
	}
	parent = e2eDescendants(t, os.Getpid())
	sid := c.spawned(known, 0)
	got := c.until("the result is delivered and the turn it starts ends", func(s e2eSnap) bool {
		return s.view.Usage.Turns >= 2 && !e2eBusy(s.view.Status) && s.view.SubsRunning == 0
	})
	c.seen = nil
	if first != nil {
		t.Logf("delivery: when the agent's first turn was seen ended: %s", first.line())
	}
	sa := got.sub(sid)
	skipIfSubUnavailable(t, sa)
	if !waited {
		t.Fatalf("no reading shows the agent's first turn ended while its subagent was still running (chat ready, running above zero); readings:\n  %s\nthread:\n%s",
			strings.Join(readings, "\n  "), got.thread())
	}
	if sa.Status != model.SubCompleted || !strings.Contains(strings.ToLower(sa.Last), "quokka") {
		t.Fatalf("subagent status %s error %q last %q, want completed with quokka", sa.Status, sa.Error, sa.Last)
	}
	at, rows := got.row(sid)
	if rows != 1 {
		t.Fatalf("%d result rows for the subagent, want one; thread:\n%s", rows, got.thread())
	}
	if sa.Delivery != model.SubSent {
		t.Fatalf("the result's delivery state is %q, want sent; %d error notes; thread:\n%s", sa.Delivery, got.notes("error", ""), got.thread())
	}
	if got.view.Usage.Turns != 2 {
		t.Fatalf("the agent ran %d turns, want two (its own and the one the result started); thread:\n%s", got.view.Usage.Turns, got.thread())
	}
	if reply := got.text(at, len(got.items)); !strings.Contains(reply, "quokka") {
		t.Fatalf("the agent's text after the result row %q does not repeat the word; thread:\n%s", reply, got.thread())
	}
	if sl := got.sleeps(0, len(got.items)); len(sl) > 0 {
		t.Fatalf("the agent slept to wait for its subagent: %q", sl)
	}
	if n := got.notes("", ""); n != 0 {
		t.Fatalf("%d notes in the thread, want none; thread:\n%s", n, got.thread())
	}
	e2eWaitGone(t, "the subagent has ended", subProcs)
	t.Logf("delivery: thread\n%s", got.thread())

	// Part 2, a completion during a turn of the agent's.
	t.Log("pending: a subagent ends while the agent works; the result is delivered after that turn")
	turns := got.view.Usage.Turns
	c.send(spawnPrompt("Run the shell command sleep 20, then reply with exactly: WOMBAT", "slow word", repeat))
	sid = c.spawned(known, turns)
	idle := c.until("the agent's turn ends", func(s e2eSnap) bool { return s.view.Usage.Turns > turns && !e2eBusy(s.view.Status) })
	if idle.sub(sid).Status != model.SubRunning || idle.view.SubsRunning != 1 {
		t.Fatalf("the subagent ended before the agent's turn did, so no message of the human's can meet it: %s", idle.line())
	}
	human := len(idle.items)
	c.send("Run the shell command sleep 45, then reply with exactly: BUSY-DONE")
	owed := c.until("the subagent ends", func(s e2eSnap) bool { return subTerminal(s.sub(sid).Status) })
	if sa := owed.sub(sid); sa.Delivery != model.SubOwed || !e2eBusy(owed.view.Status) || owed.view.SubsOwed != 1 {
		t.Fatalf("the subagent ended with the agent working: delivery %q, want owed, with the chat busy: %s", sa.Delivery, owed.line())
	}
	if _, rows := owed.row(sid); rows != 0 {
		t.Fatalf("a result row before the agent's turn ended; thread:\n%s", owed.thread())
	}
	got = c.until("the agent's turn ends, the result is delivered and the turn it starts ends", func(s e2eSnap) bool {
		return s.view.Usage.Turns >= turns+3 && !e2eBusy(s.view.Status) && !s.sub(sid).Delivery.Owed()
	})
	sa = got.sub(sid)
	if sa.Status != model.SubCompleted || !strings.Contains(strings.ToLower(sa.Last), "wombat") {
		t.Fatalf("subagent status %s error %q last %q, want completed with wombat", sa.Status, sa.Error, sa.Last)
	}
	at, rows = got.row(sid)
	if rows != 1 || sa.Delivery != model.SubSent {
		t.Fatalf("%d result rows, delivery %q, want one row and sent; thread:\n%s", rows, sa.Delivery, got.thread())
	}
	if got.lastUser() != human || at < human {
		t.Fatalf("the result row (item %d) is not after the human's message (item %d) with no message in between; thread:\n%s", at, human, got.thread())
	}
	if busyDone := got.text(human, at); !strings.Contains(busyDone, "busy-done") {
		t.Fatalf("the agent's reply to the human %q is not before the result row; thread:\n%s", busyDone, got.thread())
	}
	if reply := got.text(at, len(got.items)); !strings.Contains(reply, "wombat") {
		t.Fatalf("the agent's text after the result row %q does not repeat the word; thread:\n%s", reply, got.thread())
	}
	if got.view.Usage.Turns != turns+3 {
		t.Fatalf("the agent ran %d turns in this part, want three (the spawn, the human's message, the result); thread:\n%s", got.view.Usage.Turns-turns, got.thread())
	}
	if n := got.notes("", ""); n != 0 {
		t.Fatalf("%d notes in the thread, want none; thread:\n%s", n, got.thread())
	}
	e2eWaitGone(t, "the subagent has ended", subProcs)
	t.Logf("pending: thread from the human's message\n%s", e2eSnap{items: got.items[human:]}.thread())

	// Part 3, Stop while waiting.
	t.Log("stop: Interrupt with the agent idle and a subagent running")
	turns = got.view.Usage.Turns
	parent = e2eDescendants(t, os.Getpid())
	c.send(spawnPrompt("Run the shell command sleep 120, then reply done.", "sleeper", ""))
	sid = c.spawned(known, turns)
	idle = c.until("the agent's turn ends", func(s e2eSnap) bool { return s.view.Usage.Turns > turns && !e2eBusy(s.view.Status) })
	if idle.sub(sid).Status != model.SubRunning || idle.view.SubsRunning != 1 || idle.view.Status != model.StatusReady {
		t.Fatalf("the chat is not idle with its subagent running: %s", idle.line())
	}
	// Its process, and the shell command it was told to run.
	var procs []int
	for deadline := time.Now().Add(time.Minute); ; time.Sleep(100 * time.Millisecond) {
		_, subItems, err := m.SubItems(v.ID, sid)
		if err != nil {
			t.Fatal(err)
		}
		procs = subProcs()
		if len(procs) > 0 && slices.ContainsFunc(subItems, func(it model.Item) bool { return it.Kind == "tool" }) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for the subagent to run its command: processes %v, thread:\n%s", procs, e2eSnap{items: subItems}.thread())
		}
	}
	time.Sleep(time.Second) // the command's own process
	procs = subProcs()
	t.Logf("stop: the subagent runs as processes %v", procs)
	if err := m.Interrupt(v.ID); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}
	stopped := func(s e2eSnap) bool {
		_, rows := s.row(sid)
		sa := s.sub(sid)
		return sa.Status == model.SubStopped && sa.Delivery == model.SubNotOwed && rows == 0 &&
			s.notes("", "") == 1 && s.notes("muted", "Stopped.") == 1 &&
			s.view.Usage.Turns == turns+1 && s.view.Status == model.StatusReady && s.view.SubsRunning == 0 && s.view.SubsOwed == 0
	}
	if now := c.snap(); !stopped(now) {
		t.Fatalf("after Interrupt: %s, want the subagent stopped with nothing owed, one \"Stopped.\" note and no turn; thread:\n%s", now.line(), now.thread())
	}
	e2eWaitGone(t, "after Interrupt", func() []int { return append(e2eAlive(procs), subProcs()...) })
	// An idle pi that answered the interrupt with a turn end would show here as a turn, a second note or a busy chat.
	c.stays(10*time.Second, "the subagent is stopped, with one \"Stopped.\" note, no result row and no new turn", stopped)
	c.send("Reply with exactly: pong")
	got = c.until("the follow-up message's turn ends", func(s e2eSnap) bool { return s.view.Usage.Turns > turns+1 && !e2eBusy(s.view.Status) })
	if reply := got.text(got.lastUser(), len(got.items)); !strings.Contains(reply, "pong") {
		t.Fatalf("the reply to the follow-up message %q does not contain pong; thread:\n%s", reply, got.thread())
	}
	if _, rows := got.row(sid); rows != 0 || got.sub(sid).Status != model.SubStopped || got.view.Usage.Turns != turns+2 ||
		got.notes("", "") != 1 || got.notes("muted", "Stopped.") != 1 {
		t.Fatalf("after the follow-up message: %s, want the subagent still stopped, no result row, one note and one more turn; thread:\n%s", got.line(), got.thread())
	}
	t.Logf("stop: thread from the spawn\n%s", e2eSnap{items: got.items[max(got.lastUser()-4, 0):]}.thread())
}

// subTerminal reports whether a subagent status is final.
func subTerminal(s model.SubStatus) bool {
	switch s {
	case model.SubCompleted, model.SubFailed, model.SubStopped:
		return true
	}
	return false
}
