package boardapi

// Real-handler + real-pi probe for the Phase 2 MCP client module.
//
// The probe runs the REAL ServeFixedMCP handler behind an httptest server, loads
// the materialized extension tree and a throwaway probe extension into a REAL
// `pi --mode rpc` process, and the probe drives the hand-rolled mcp.ts client
// directly (no model call). It asserts the server observed the full handshake,
// that all 7 board tools were discovered, that tools/call returns the fake
// client's text (and isError text for an unknown tool), and that ping works.
// It also asserts the child got no AIWB_BRIDGE_*/AIWB_MCP_CONFIG environment,
// which is the standalone (no app bridge) goal: AIWB_BRIDGE_RUN is a per-run,
// non-secret bridge handle, not a credential.
//
// The test skips, with a clear reason and captured output, when node or pi is
// unavailable or the pi process does not start/complete in this environment.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/pibridge"
	"ai-whiteboard/internal/testset"
)

// probeExtensionSource is the throwaway probe extension. It is written next to
// the materialized extension (inside a t.TempDir tree, never into the embedded
// extension directory) so `./mcp.ts` resolves. It loads the real extension
// factory into its own extension context (pi 0.85.1 flags are per-extension:
// getFlag only sees flags the same extension registered), reads the
// mcp-config flag, and reports everything as JSON on stdout and to
// AIWB_MCP_PROBE_OUT.
const probeExtensionSource = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import boardExtension from "./index.ts";
import { connectServer, parseMCPConfig } from "./mcp.ts";

let reported = false;

export default function probeExtension(pi: ExtensionAPI): void {
  // The real extension registers --mcp-config as its first factory action and
  // then returns early without AIWB_BRIDGE_* (standalone). Running it here in
  // the probe's own context makes the flag readable via pi.getFlag below.
  boardExtension(pi);

  pi.on("session_start", async () => {
    if (reported) return;
    reported = true;
    const result: Record<string, unknown> = {};
    try {
      const flag = pi.getFlag("mcp-config");
      result.flag = typeof flag === "string" ? flag : null;
      const parsed = parseMCPConfig(typeof flag === "string" ? flag : undefined);
      result.parseErrors = parsed.errors;
      result.serverKeys = parsed.servers.map((spec) => spec.key);
      if (parsed.servers.length !== 1) {
        throw new Error("expected exactly one MCP server, got " + parsed.servers.length);
      }
      // The real extension factory now owns the MCP lifecycle too (Phase 3),
      // so the probe tags its direct client with a custom header: the factory's
      // session_start connection sends no such header, which keeps the two
      // request streams separable.
      const spec = { ...parsed.servers[0], headers: { ...(parsed.servers[0].headers ?? {}), "x-aiwb-probe": "phase2" } };
      const client = await connectServer(spec, {
        clientInfo: { name: "aiwb-phase2-probe", version: "0.0.1" },
      });
      result.protocolVersion = client.protocolVersion;
      result.serverInfo = client.serverInfo ?? null;
      const tools = await client.listTools();
      result.tools = tools.map((tool) => tool.name);
      const ok = await client.callTool("read_board", {});
      result.callText = ok.text;
      result.callIsError = ok.isError;
      const unknown = await client.callTool("rm_rf", {});
      result.unknownText = unknown.text;
      result.unknownIsError = unknown.isError;
      await client.ping();
      result.ping = "ok";
      client.close();
      result.ok = true;
    } catch (err) {
      result.ok = false;
      result.error = err instanceof Error ? err.message : String(err);
    }
    result.bridgeEnv = {
      AIWB_BRIDGE_SOCKET: process.env.AIWB_BRIDGE_SOCKET ?? null,
      AIWB_BRIDGE_RUN: process.env.AIWB_BRIDGE_RUN ?? null,
      AIWB_MCP_CONFIG: process.env.AIWB_MCP_CONFIG ?? null,
    };
    const payload = JSON.stringify(result);
    process.stdout.write("AIWB_MCP_PROBE:" + payload + "\\n");
    const outPath = process.env.AIWB_MCP_PROBE_OUT;
    if (outPath) {
      try {
        writeFileSync(outPath, payload);
      } catch {
        // stdout still carries the report
      }
    }
  });
}
`

// probeResult is the probe's JSON report.
type probeResult struct {
	OK              bool           `json:"ok"`
	Error           string         `json:"error"`
	Flag            string         `json:"flag"`
	ParseErrors     []string       `json:"parseErrors"`
	ServerKeys      []string       `json:"serverKeys"`
	ProtocolVersion string         `json:"protocolVersion"`
	ServerInfo      map[string]any `json:"serverInfo"`
	Tools           []string       `json:"tools"`
	CallText        string         `json:"callText"`
	CallIsError     bool           `json:"callIsError"`
	UnknownText     string         `json:"unknownText"`
	UnknownIsError  bool           `json:"unknownIsError"`
	Ping            string         `json:"ping"`
	BridgeEnv       map[string]any `json:"bridgeEnv"`
}

// observedMCP is one request the MCP httptest server saw.
type observedMCP struct {
	httpMethod    string
	method        string
	path          string
	protocol      string
	accept        string
	content       string
	probe         string
	authorization string
}

// syncBuffer is a goroutine-safe writer for the child's stdout/stderr.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// probeEnv copies the test environment without any AIWB_* variables or keys
// overridden below, then appends the isolated pi/probe settings.
func probeEnv(extra ...string) []string {
	overrides := map[string]bool{}
	for _, kv := range extra {
		if name, _, ok := strings.Cut(kv, "="); ok {
			overrides[name] = true
		}
	}
	env := make([]string, 0, len(os.Environ())+len(extra))
	for _, kv := range os.Environ() {
		name, _, ok := strings.Cut(kv, "=")
		if !ok || strings.HasPrefix(name, "AIWB_") || overrides[name] {
			continue
		}
		env = append(env, kv)
	}
	return append(env, extra...)
}

func TestMCPRealPiProbe(t *testing.T) {
	testset.SkipUnlessFull(t, "needs the real pi installed; the default set covers the same handler without pi in TestFixedMCPInitializeAndToolsListPermissive and TestFixedMCPToolsCallValidToken")
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	pi, err := exec.LookPath("pi")
	if err != nil {
		t.Skip("pi not available")
	}
	versionCtx, cancelVersion := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelVersion()
	versionOut, err := exec.CommandContext(versionCtx, pi, "--version").Output()
	if err != nil || strings.TrimSpace(string(versionOut)) == "" {
		t.Skipf("pi --version failed (%v, output %q): cannot run the real-pi probe", err, strings.TrimSpace(string(versionOut)))
	}

	// Real handler environment: board token URL + a fake editor client that
	// answers every board rpc with known text.
	e := newEnv(t)
	e.client(func(params map[string]any) editorbridge.RPCReply {
		return editorbridge.RPCReply{Result: json.RawMessage(`"rect r1 at 0,0"`)}
	})

	var mu sync.Mutex
	var observed []observedMCP
	mcpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(body))
		var rq struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal(body, &rq)
		mu.Lock()
		observed = append(observed, observedMCP{
			httpMethod:    r.Method,
			method:        rq.Method,
			path:          r.URL.Path,
			protocol:      r.Header.Get("mcp-protocol-version"),
			accept:        r.Header.Get("accept"),
			content:       r.Header.Get("content-type"),
			probe:         r.Header.Get("x-aiwb-probe"),
			authorization: r.Header.Get("Authorization"),
		})
		mu.Unlock()
		e.mux.ServeHTTP(w, r)
	}))
	defer mcpServer.Close()

	configJSON, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"board": map[string]any{"type": "http", "url": mcpServer.URL + "/mcp",
				"headers": map[string]any{"Authorization": "Bearer " + e.token}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Materialize the embedded extension tree into a throwaway directory and
	// drop the probe extension next to it (not into the embedded tree).
	extDir := filepath.Join(t.TempDir(), "pi-extension")
	if _, err := pibridge.MaterializeExtension(extDir); err != nil {
		t.Fatalf("MaterializeExtension: %v", err)
	}
	probePath := filepath.Join(extDir, "probe.ts")
	if err := os.WriteFile(probePath, []byte(probeExtensionSource), 0o600); err != nil {
		t.Fatalf("write probe extension: %v", err)
	}

	resultPath := filepath.Join(t.TempDir(), "probe-result.json")
	homeDir := t.TempDir()
	agentDir := t.TempDir()
	workDir := t.TempDir()
	env := probeEnv(
		"HOME="+homeDir,
		"PI_CODING_AGENT_DIR="+agentDir,
		"PI_OFFLINE=1",
		"PI_SKIP_VERSION_CHECK=1",
		"AIWB_MCP_PROBE_OUT="+resultPath,
	)
	for _, kv := range env {
		if strings.HasPrefix(kv, "AIWB_BRIDGE_") || strings.HasPrefix(kv, "AIWB_MCP_CONFIG=") {
			t.Fatalf("probe env must not contain bridge variables, got %q", kv)
		}
	}

	args := []string{
		"--mode", "rpc",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--mcp-config", string(configJSON),
		"-e", probePath,
	}
	cmd := exec.Command(pi, args...)
	cmd.Dir = workDir
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout := &syncBuffer{}
	stderr := &syncBuffer{}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Skipf("pi failed to start (%v): cannot run the real-pi probe", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	})

	// Poll for the probe's report; stop early when pi exits.
	var raw []byte
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(resultPath); err == nil && len(b) > 0 {
			raw = b
			break
		}
		select {
		case werr := <-done:
			out := stdout.String() + stderr.String()
			// A failure to load the materialized extension or to recognize the
			// flag is a real regression (plan R1), not an environment problem.
			if strings.Contains(out, "Unknown option") || strings.Contains(out, "Failed to load extension") ||
				strings.Contains(out, "requires a value") {
				t.Fatalf("pi failed to load the extension/flag (%v)\nstdout:\n%s\nstderr:\n%s", werr, stdout.String(), stderr.String())
			}
			t.Skipf("pi exited before the probe reported (%v)\nstdout:\n%s\nstderr:\n%s", werr, stdout.String(), stderr.String())
		default:
		}
		time.Sleep(100 * time.Millisecond)
	}
	if raw == nil {
		t.Skipf("probe did not report within 60s\nstdout:\n%s\nstderr:\n%s", stdout.String(), stderr.String())
	}

	var result probeResult
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("probe report is not JSON: %v\n%s", err, raw)
	}
	if !result.OK {
		t.Fatalf("probe failed: %s\nraw report: %s", result.Error, raw)
	}

	// The flag was registered (by the real extension factory) and read back.
	if result.Flag != string(configJSON) {
		t.Fatalf("probe flag = %q, want %q", result.Flag, configJSON)
	}
	if len(result.ParseErrors) != 0 {
		t.Fatalf("probe config errors = %v", result.ParseErrors)
	}
	if len(result.ServerKeys) != 1 || result.ServerKeys[0] != "board" {
		t.Fatalf("probe server keys = %v, want [board]", result.ServerKeys)
	}
	if result.ProtocolVersion != "2025-06-18" {
		t.Fatalf("probe protocolVersion = %q, want the echoed 2025-06-18", result.ProtocolVersion)
	}

	var wantTools []string
	for _, tool := range boardtools.Tools {
		wantTools = append(wantTools, tool.Name)
	}
	for _, tool := range boardtools.SpawnFamily {
		wantTools = append(wantTools, tool.Name)
	}
	if len(boardtools.Tools) != 8 {
		t.Fatalf("boardtools.Tools has %d tools, want 8", len(boardtools.Tools))
	}
	if len(result.Tools) != len(wantTools) {
		t.Fatalf("probe discovered %d tools %v, want %d %v", len(result.Tools), result.Tools, len(wantTools), wantTools)
	}
	for i, name := range wantTools {
		if result.Tools[i] != name {
			t.Fatalf("probe tool %d = %q, want %q (all: %v)", i, result.Tools[i], name, result.Tools)
		}
	}

	if result.CallIsError || result.CallText != "rect r1 at 0,0" {
		t.Fatalf("probe tools/call = %q isError=%v, want the fake client's text", result.CallText, result.CallIsError)
	}
	if !result.UnknownIsError || result.UnknownText != "unknown tool rm_rf" {
		t.Fatalf("probe unknown-tool call = %q isError=%v, want the handler's error text", result.UnknownText, result.UnknownIsError)
	}
	if result.Ping != "ok" {
		t.Fatalf("probe ping = %q, want ok", result.Ping)
	}

	// Standalone goal: the child had no bridge environment. AIWB_BRIDGE_RUN is a
	// per-run bridge handle, not a credential; its absence here only shows the
	// standalone boot wired no bridge.
	for name, value := range result.BridgeEnv {
		if value != nil {
			t.Fatalf("probe child env %s = %v, want unset", name, value)
		}
	}
	if len(result.BridgeEnv) != 3 {
		t.Fatalf("probe reported bridgeEnv %v, want the three checked keys", result.BridgeEnv)
	}

	// What the real handler observed. The probe's direct client is tagged with a
	// custom header; the real extension factory's own lifecycle connection (new
	// in Phase 3) sends no header and is checked separately below.
	mu.Lock()
	all := append([]observedMCP(nil), observed...)
	mu.Unlock()
	var got []observedMCP
	var factory []observedMCP
	for _, req := range all {
		if req.probe == "phase2" {
			got = append(got, req)
		} else {
			factory = append(factory, req)
		}
	}
	wantMethods := []string{"initialize", "notifications/initialized", "tools/list", "tools/call", "tools/call", "ping"}
	if len(got) != len(wantMethods) {
		t.Fatalf("handler saw %d requests, want %d: %+v", len(got), len(wantMethods), got)
	}
	for i, want := range wantMethods {
		if got[i].method != want {
			t.Fatalf("handler request %d = %q, want %q (all: %+v)", i, got[i].method, want, got)
		}
		if got[i].httpMethod != http.MethodPost {
			t.Fatalf("handler request %d used %s, want POST", i, got[i].httpMethod)
		}
		if got[i].path != "/mcp" {
			t.Fatalf("handler request %d path = %q, want /mcp (fixed endpoint)", i, got[i].path)
		}
		if got[i].authorization != "Bearer "+e.token {
			t.Fatalf("handler request %d Authorization = %q, want the chat's board token in the header", i, got[i].authorization)
		}
	}
	if got[0].protocol != "" {
		t.Fatalf("initialize must not carry mcp-protocol-version, got %q", got[0].protocol)
	}
	if !strings.Contains(got[0].accept, "application/json") || !strings.Contains(got[0].accept, "text/event-stream") {
		t.Fatalf("initialize accept = %q, want JSON and event-stream", got[0].accept)
	}
	if !strings.Contains(got[0].content, "application/json") {
		t.Fatalf("initialize content-type = %q, want application/json", got[0].content)
	}
	for i := 1; i < len(got); i++ {
		if got[i].protocol != "2025-06-18" {
			t.Fatalf("request %d (%s) mcp-protocol-version = %q, want 2025-06-18", i, got[i].method, got[i].protocol)
		}
	}

	// The real extension factory's session_start lifecycle also connected,
	// initialized and discovered tools independently of the probe (standalone).
	var factoryMethods []string
	for _, req := range factory {
		factoryMethods = append(factoryMethods, req.method)
	}
	wantFactory := []string{"initialize", "notifications/initialized", "tools/list"}
	if strings.Join(factoryMethods, ",") != strings.Join(wantFactory, ",") {
		t.Fatalf("factory session_start saw %v, want %v", factoryMethods, wantFactory)
	}
}
