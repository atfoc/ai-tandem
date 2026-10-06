package pi

// Real-pi end-to-end tests for the permission path: the app extension's tool_call hook → the app
// bridge's ask frame → the adapter's auto-allow, plus the app-folder auto-deny. pi tool calls are
// always approved, so no EvPermRequest must ever arrive and the gated tools must run. Like
// e2e_test.go these only run when the caller opts in (AIWB_PI_E2E=1, real pi on PATH); see that
// file for the gate, model override and isolation notes.
//
//	AIWB_PI_E2E=1 go test -count=1 -run 'TestE2EPermissionAutoApproved|TestE2EAppDirDenied|TestE2EMCPToolsAutoApproved' -v ./internal/pi/

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/pibridge"
)

// TestE2EPermissionAutoApproved runs a gated bash call against real pi: the call must run with no
// permission ask and return the marker.
func TestE2EPermissionAutoApproved(t *testing.T) {
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

	var asks, results []agent.Event
	bashIDs := map[string]bool{}
	var text strings.Builder
	if !e2eTurn(t, a, func(ev agent.Event) {
		switch ev.Kind {
		case agent.EvPermRequest:
			asks = append(asks, ev)
			_ = a.Decide(ev.PermID, true) // must never happen; unblock anyway
		case agent.EvToolStart, agent.EvToolInput:
			if ev.ToolName == "bash" {
				bashIDs[ev.ToolID] = true
			}
		case agent.EvToolResult:
			results = append(results, ev)
		case agent.EvText, agent.EvTextDelta:
			text.WriteString(ev.Text)
		}
	}) {
		t.Skip("pi exited before the turn ended (model or auth unavailable?)")
	}
	if len(bashIDs) == 0 {
		t.Skipf("the model did not attempt the bash tool; asks %+v text %q", asks, text.String())
	}
	if len(asks) != 0 {
		t.Fatalf("tool calls raised permission asks: %+v", asks)
	}
	found := false
	for _, ev := range results {
		if bashIDs[ev.ToolID] && !ev.IsError && strings.Contains(ev.Result, "PERM-MARKER") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the auto-approved bash call produced no successful result with PERM-MARKER; results %+v", results)
	}
	t.Logf("auto-approve turn: bash ids %v; results %+v; text %q", bashIDs, results, text.String())
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
			_ = a.Decide(ev.PermID, true) // the guard must answer before this; unblock anyway
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

// TestE2EMCPToolsAutoApproved is the A6 real-pi leg: an app board chat whose MCP config file also
// carries a test-only non-board server (config key "other") served by the same board MCP endpoint
// whose serverInfo.name is also "board". Both the app-sourced board tool and the non-board tool
// must run with no permission ask.
func TestE2EMCPToolsAutoApproved(t *testing.T) {
	e2eAgentDir(t)
	env := newE2EBoardEnv(t)
	env.setReply("E2E-MCP-TEXT-77")
	s := env.newSpawner(t, map[string]mcpServerConfig{
		"other": {Type: "http", URL: env.srv.URL + "/mcp", Headers: map[string]string{
			"Authorization": "Bearer " + env.token}},
	})
	a, err := s.Spawn(agent.SpawnOptions{ChatID: "e2e-perm-mcp", Cwd: t.TempDir(), Model: e2eModel(),
		MCP: env.boardAccess(), BoardID: "e2e-board"})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a.Close()

	// Turn 1: the app-sourced board tool runs with no ask.
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
			_ = a.Decide(ev.PermID, true) // unblock an unexpected ask
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
		t.Fatalf("the board tool raised permission asks: %+v", boardAsks)
	}

	// Turn 2: the non-board server's tool also runs with no ask.
	if err := a.Send([]agent.ContentBlock{{Text: "Call the tool named mcp__other__list_boards with an empty " +
		"object argument. Then reply with the text it returned."}}); err != nil {
		t.Fatalf("second Send: %v", err)
	}
	var otherAsks, otherResults []agent.Event
	otherCalled := false
	if !e2eTurn(t, a, func(ev agent.Event) {
		switch ev.Kind {
		case agent.EvPermRequest:
			otherAsks = append(otherAsks, ev)
			_ = a.Decide(ev.PermID, true) // unblock an unexpected ask
		case agent.EvToolStart:
			if ev.ToolName == "mcp__other__list_boards" {
				otherCalled = true
			}
		case agent.EvToolResult:
			otherResults = append(otherResults, ev)
		}
	}) {
		t.Skip("pi exited before the non-board turn ended (model or auth unavailable?)")
	}
	if !otherCalled {
		t.Skipf("the model did not attempt mcp__other__list_boards; asks %+v", otherAsks)
	}
	if len(otherAsks) != 0 {
		t.Fatalf("the non-board tool raised permission asks: %+v", otherAsks)
	}
	found := false
	for _, ev := range otherResults {
		if !ev.IsError && strings.Contains(ev.Result, "E2E-MCP-TEXT-77") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the non-board call produced no successful result with the MCP text; results %+v", otherResults)
	}
	t.Logf("non-board turn: asks %+v; results %+v", otherAsks, otherResults)
	closeAndWaitExit(t, a)
}
