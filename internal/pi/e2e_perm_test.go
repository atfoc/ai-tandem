package pi

// Real-pi end-to-end tests for the permission path: the app extension's tool_call hook → the
// app bridge's ask frame → the adapter's EvPermRequest/Decide round trip, plus the app-folder
// auto-deny. Like e2e_test.go these only run when the caller opts in (AIWB_PI_E2E=1, real pi on
// PATH); see that file for the gate, model override and isolation notes.
//
//	AIWB_PI_E2E=1 go test -count=1 -run 'TestE2EPermissionAllowDeny|TestE2EAppDirDenied' -v ./internal/pi/

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/pibridge"
)

// e2ePermWait bounds how long a permission turn waits for the model's first permission ask. A
// model that decides not to call the gated tool skips instead of hanging or burning budget;
// after the first ask arrives the ordinary 3-minute turn bound takes over.
const e2ePermWait = 90 * time.Second

// e2ePermTurn collects the pieces of one permission turn: the asks the extension raised, the
// tool results (IsError decides truthfulness) and the streamed text.
type e2ePermTurn struct {
	asks    []agent.Event
	results []agent.Event
	text    strings.Builder
}

func (r *e2ePermTurn) handle(ev agent.Event) {
	switch ev.Kind {
	case agent.EvPermRequest:
		r.asks = append(r.asks, ev)
	case agent.EvToolResult:
		r.results = append(r.results, ev)
	case agent.EvText, agent.EvTextDelta:
		r.text.WriteString(ev.Text)
	}
}

// resultsFor returns the results of the tool calls whose ids are in ids.
func (r *e2ePermTurn) resultsFor(ids map[string]bool) []agent.Event {
	var out []agent.Event
	for _, ev := range r.results {
		if ids[ev.ToolID] {
			out = append(out, ev)
		}
	}
	return out
}

// e2ePermLoop drives one turn until it ends, calling answer for every permission ask so the
// extension is never left blocked. It returns false when pi exited before the turn ended, and
// skips when no ask arrives within e2ePermWait (the model chose not to call a gated tool).
func e2ePermLoop(t *testing.T, a agent.Agent, run *e2ePermTurn, answer func(agent.Event)) bool {
	t.Helper()
	askTimer := time.After(e2ePermWait)
	turnTimer := time.After(3 * time.Minute)
	for {
		select {
		case ev, open := <-a.Events():
			if !open {
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
			}
			run.handle(ev)
			if ev.Kind == agent.EvPermRequest {
				if len(run.asks) == 1 {
					askTimer = nil // the model cooperated; drop the no-ask bound
				}
				answer(ev)
			}
		case <-askTimer:
			t.Skipf("no tool permission ask arrived within %s: the model did not attempt a gated tool", e2ePermWait)
		case <-turnTimer:
			t.Fatal("timed out after 3 minutes waiting for the turn to end")
		}
	}
}

// TestE2EPermissionAllowDeny runs the whole permission round trip against real pi twice: the
// first bash ask is denied and must not return a successful PERM-MARKER result, the second is
// allowed and must. Both turns use the same short prompt so the model spend stays tiny.
func TestE2EPermissionAllowDeny(t *testing.T) {
	e2eAgentDir(t)
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
	s := &Spawner{Bin: "pi", AppRoot: root, Home: home, Extension: ext, Bridge: br}
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "e2e-perm", Cwd: cwd, Model: e2eModel()})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a.Close()

	const permPrompt = "Use the bash tool to run exactly this command: echo PERM-MARKER. " +
		"Then reply with the command output."
	if err := a.Send([]agent.ContentBlock{{Text: permPrompt}}); err != nil {
		t.Skipf("model %s is unavailable (not authenticated?): %v", e2eModel(), err)
	}

	// Turn 1: deny. The turn must continue and no successful result may carry the marker.
	deny := &e2ePermTurn{}
	denied := map[string]bool{}
	if !e2ePermLoop(t, a, deny, func(ev agent.Event) {
		if ev.ToolName != "bash" {
			_ = a.Decide(ev.PermID, false) // keep a stray ask from blocking the turn
			return
		}
		if ev.PermID == "" || ev.ToolID == "" || len(ev.Input) == 0 {
			t.Errorf("permission ask %+v: want a bash tool-call id and input", ev)
		}
		denied[ev.PermID] = true
		if err := a.Decide(ev.PermID, false); err != nil {
			t.Errorf("Decide(%q, false): %v", ev.PermID, err)
		}
	}) {
		t.Skip("pi exited before the deny turn ended (model or auth unavailable?)")
	}
	if len(denied) == 0 {
		t.Skipf("the model did not attempt the bash tool on the deny turn; asks %+v text %q", deny.asks, deny.text.String())
	}
	sawErrorResult := false
	for _, ev := range deny.resultsFor(denied) {
		if ev.IsError {
			sawErrorResult = true
		}
		if !ev.IsError && strings.Contains(ev.Result, "PERM-MARKER") {
			t.Fatalf("denied bash call produced a successful result %q", ev.Result)
		}
	}
	if !sawErrorResult {
		t.Errorf("denied bash asks %v produced no error tool result; results %+v", denied, deny.results)
	}
	t.Logf("deny turn: asks %+v; results %+v; text %q", deny.asks, deny.results, deny.text.String())

	// Turn 2: allow. The same command must now return the marker in a successful result.
	if err := a.Send([]agent.ContentBlock{{Text: permPrompt}}); err != nil {
		t.Fatalf("second Send: %v", err)
	}
	allow := &e2ePermTurn{}
	allowed := map[string]bool{}
	if !e2ePermLoop(t, a, allow, func(ev agent.Event) {
		if ev.ToolName != "bash" {
			_ = a.Decide(ev.PermID, false)
			return
		}
		if ev.PermID == "" || ev.ToolID == "" || len(ev.Input) == 0 {
			t.Errorf("permission ask %+v: want a bash tool-call id and input", ev)
		}
		allowed[ev.PermID] = true
		if err := a.Decide(ev.PermID, true); err != nil {
			t.Errorf("Decide(%q, true): %v", ev.PermID, err)
		}
	}) {
		t.Skip("pi exited before the allow turn ended (model or auth unavailable?)")
	}
	if len(allowed) == 0 {
		t.Skipf("the model did not attempt the bash tool on the allow turn; asks %+v text %q", allow.asks, allow.text.String())
	}
	found := false
	for _, ev := range allow.resultsFor(allowed) {
		if !ev.IsError && strings.Contains(ev.Result, "PERM-MARKER") {
			found = true
		}
	}
	if !found {
		t.Fatalf("allowed bash asks %v produced no successful result with PERM-MARKER; results %+v", allowed, allow.results)
	}
	t.Logf("allow turn: asks %+v; results %+v; text %q", allow.asks, allow.results, allow.text.String())
	closeAndWaitExit(t, a)
}

// TestE2EAppDirDenied checks the app-folder guard end to end: a real read of a file inside the
// temp AppRoot is denied by the adapter without any permission card, the tool result carries the
// denial reason, and the file content never reaches the stream.
func TestE2EAppDirDenied(t *testing.T) {
	e2eAgentDir(t)
	root, home, cwd := t.TempDir(), t.TempDir(), t.TempDir()
	const secret = "E2E-APPDIR-SECRET-7"
	statePath := filepath.Join(root, "state.json")
	if err := os.WriteFile(statePath, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	ext, err := pibridge.MaterializeExtension(filepath.Join(t.TempDir(), "ext"))
	if err != nil {
		t.Fatal(err)
	}
	br := pibridge.New(pibridge.SocketPath(root))
	if err := br.Start(); err != nil {
		t.Fatal(err)
	}
	defer br.Close()
	s := &Spawner{Bin: "pi", AppRoot: root, Home: home, Extension: ext, Bridge: br}
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "e2e-appdir", Cwd: cwd, Model: e2eModel()})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a.Close()

	prompt := fmt.Sprintf("Use the read tool to read the file %s and reply with its exact contents.", statePath)
	if err := a.Send([]agent.ContentBlock{{Text: prompt}}); err != nil {
		t.Skipf("model %s is unavailable (not authenticated?): %v", e2eModel(), err)
	}

	var asks, results []agent.Event
	var text strings.Builder
	pathIDs := map[string]bool{}
	if !e2eTurn(t, a, func(ev agent.Event) {
		switch ev.Kind {
		case agent.EvPermRequest:
			asks = append(asks, ev)
			_ = a.Decide(ev.PermID, false) // the guard must answer before this; unblock anyway
		case agent.EvToolStart, agent.EvToolInput:
			if strings.Contains(string(ev.Input), statePath) {
				pathIDs[ev.ToolID] = true
			}
		case agent.EvToolResult:
			results = append(results, ev)
		case agent.EvText, agent.EvTextDelta:
			text.WriteString(ev.Text)
		}
	}) {
		t.Skip("pi exited before the turn ended (model or auth unavailable?)")
	}

	if len(pathIDs) == 0 {
		t.Skipf("the model never attempted to read the app-dir file; asks %+v text %q", asks, text.String())
	}
	for _, ev := range asks {
		if ev.ToolName == "read" || strings.Contains(string(ev.Input), statePath) {
			t.Fatalf("app-dir access raised a permission card instead of auto-deny: %+v", ev)
		}
	}
	checked := false
	for _, ev := range results {
		if !pathIDs[ev.ToolID] {
			continue
		}
		checked = true
		if !ev.IsError {
			t.Fatalf("app-dir tool result is not an error: %+v", ev)
		}
		if !strings.Contains(ev.Result, agent.AppDirDenied) {
			t.Fatalf("app-dir tool result %q does not mention the app-folder reason %q", ev.Result, agent.AppDirDenied)
		}
	}
	if !checked {
		t.Fatalf("no tool result arrived for the app-dir attempts %v", pathIDs)
	}
	for _, ev := range results {
		if strings.Contains(ev.Result, secret) {
			t.Fatalf("tool result leaked the app-dir file content: %+v", ev)
		}
	}
	if strings.Contains(text.String(), secret) {
		t.Fatalf("streamed text leaked the app-dir file content: %q", text.String())
	}
	t.Logf("app-dir turn: attempts %v; asks %+v; results %+v; text %q", pathIDs, asks, results, text.String())
	closeAndWaitExit(t, a)
}

// TestE2EMCPNonBoardPermission is the A6 real-pi leg: an app board chat whose
// AIWB_MCP_CONFIG also carries a test-only non-board server (config key
// "other") served by the same board MCP endpoint whose serverInfo.name is
// also "board". The board tool is auto-allowed (no ask); the non-board tool
// asks exactly once and runs after the user allows it.
func TestE2EMCPNonBoardPermission(t *testing.T) {
	e2eAgentDir(t)
	env := newE2EBoardEnv(t)
	env.setReply("E2E-MCP-TEXT-77")
	s := env.newSpawner(t, map[string]mcpServerConfig{
		"other": {Type: "http", URL: env.srv.URL + "/mcp/" + env.token},
	})
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "e2e-perm-mcp", Cwd: t.TempDir(), Model: e2eModel(),
		Board: env.boardAccess()})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a.Close()

	// Turn 1: the app-sourced board tool is auto-allowed and must not ask.
	if err := a.Send([]agent.ContentBlock{{Text: "Call the tool named mcp__board__list_boards with an empty " +
		"object argument. Then reply with the text it returned."}}); err != nil {
		t.Skipf("model %s is unavailable (not authenticated?): %v", e2eModel(), err)
	}
	var boardAsks []agent.Event
	boardCalled := false
	if !e2eTurn(t, a, func(ev agent.Event) {
		switch ev.Kind {
		case agent.EvPermRequest:
			boardAsks = append(boardAsks, ev)
			_ = a.Decide(ev.PermID, false) // keep an unexpected ask from blocking the turn
		case agent.EvToolStart:
			if ev.ToolName == "mcp__board__list_boards" {
				boardCalled = true
			}
		}
	}) {
		t.Skip("pi exited before the board turn ended (model or auth unavailable?)")
	}
	if !boardCalled {
		t.Fatalf("the model never called mcp__board__list_boards; board asks %+v", boardAsks)
	}
	if len(boardAsks) != 0 {
		t.Fatalf("the auto-allowed board tool raised permission asks: %+v", boardAsks)
	}

	// Turn 2: the non-board server's tool asks exactly once and runs after the
	// allow decision.
	if err := a.Send([]agent.ContentBlock{{Text: "Call the tool named mcp__other__list_boards with an empty " +
		"object argument. Then reply with the text it returned."}}); err != nil {
		t.Fatalf("second Send: %v", err)
	}
	other := &e2ePermTurn{}
	allowed := map[string]bool{}
	if !e2ePermLoop(t, a, other, func(ev agent.Event) {
		if ev.ToolName != "mcp__other__list_boards" {
			_ = a.Decide(ev.PermID, false)
			return
		}
		allowed[ev.PermID] = true
		if err := a.Decide(ev.PermID, true); err != nil {
			t.Errorf("Decide(%q, true): %v", ev.PermID, err)
		}
	}) {
		t.Skip("pi exited before the non-board turn ended (model or auth unavailable?)")
	}
	if len(other.asks) == 0 {
		t.Skipf("the model did not attempt mcp__other__list_boards; text %q", other.text.String())
	}
	if len(allowed) != 1 {
		t.Fatalf("non-board tool asks = %d %+v, want exactly one", len(allowed), other.asks)
	}
	for _, ev := range other.asks {
		if strings.HasPrefix(ev.ToolName, "mcp__board__") {
			t.Fatalf("the board tool raised a permission ask: %+v", ev)
		}
		if ev.ToolName != "mcp__other__list_boards" {
			t.Fatalf("unexpected permission ask %+v", ev)
		}
	}
	found := false
	for _, ev := range other.resultsFor(allowed) {
		if !ev.IsError && strings.Contains(ev.Result, "E2E-MCP-TEXT-77") {
			found = true
		}
	}
	if !found {
		t.Fatalf("allowed non-board call produced no successful result with the MCP text; results %+v", other.results)
	}
	t.Logf("non-board turn: asks %+v; results %+v; text %q", other.asks, other.results, other.text.String())
	closeAndWaitExit(t, a)
}
