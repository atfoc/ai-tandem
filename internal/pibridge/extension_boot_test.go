package pibridge

// Real-pi boot tests for the MCP wiring: the standalone (--mcp-config, no
// bridge) legs from Phase 3 and the app-env (AIWB_MCP_CONFIG + bridge-like)
// switchover leg from Phase 4.
//
// It boots the REAL materialized extension (index.ts) inside a real
// `pi --mode rpc` process with only `--mcp-config` and NO AIWB_BRIDGE_*
// environment, using a throwaway probe extension that imports the real factory,
// captures every pi.registerTool definition, and reports `pi.getAllTools()`,
// the captured definitions, and one successful/one failing tool call as JSON.
//
// Success leg: a Go stub MCP server observes initialize +
// notifications/initialized + paginated tools/list, the extension registers the
// namespaced tools sequentially, and calls forward (throwing on isError).
// Failure leg: a dead server produces a clear prefixed stderr line, pi stays
// alive and responsive, and no tools are registered.
// Stalling legs: a server that answers initialize but never
// notifications/initialized, and one that never answers initialize, must be
// bounded by the connect/discovery timeout: the extension reports the prefixed
// notice and pi still answers get_state.
// No-config leg: plain boot registers no MCP tools and pi stays alive.
// App-env leg (Phase 4/A3): an app-style AIWB_MCP_CONFIG plus a bridge-like
// AIWB_BRIDGE_* environment registers the board MCP tools plus the spawn-family
// mcp__board__* tools — never a raw native board tool name and never the native
// subagent tool (the MCP spawn family replaces it).
//
// The test follows the Phase 2 probe's isolation: HOME/PI_CODING_AGENT_DIR
// overrides, --no-session, PI_OFFLINE=1, stdin kept open, the process group
// killed at the end. It skips, with captured output, when node/pi are
// unavailable or pi cannot start in this environment.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/boardtools"
)

// bootProbeSource is a throwaway probe extension written next to the
// materialized extension so `./index.ts` resolves. It wraps registerTool to
// capture definitions (pi's getAllTools() does not expose executionMode or
// execute), calls the real factory, and reports after the factory's own
// session_start handler has run.
const bootProbeSource = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import boardExtension from "./index.ts";

let started = false;

export default function bootProbe(pi: ExtensionAPI): void {
  const captured: any[] = [];
  const api = new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (tool: any) => {
          captured.push(tool);
          (target as any).registerTool(tool);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  boardExtension(api as ExtensionAPI);

  pi.on("session_start", async () => {
    if (started) return;
    started = true;
    const result: Record<string, unknown> = { ok: false };
    try {
      result.allTools = pi.getAllTools().map((tool: any) => tool.name);
      result.captured = captured.map((tool: any) => ({
        name: tool.name,
        label: tool.label,
        executionMode: tool.executionMode,
        description: tool.description,
        promptSnippet: tool.promptSnippet,
        hasParameters: Boolean(tool.parameters),
      }));
      const echo = captured.find((tool: any) => tool.name === "mcp__board__echo");
      if (echo) {
        const out = await echo.execute("call-1", { q: "hi" }, undefined, undefined, undefined);
        result.callText = out?.content?.[0]?.text ?? null;
      }
      const bad = captured.find((tool: any) => tool.name === "mcp__board__bad");
      if (bad) {
        try {
          await bad.execute("call-2", {}, undefined, undefined, undefined);
          result.badError = null;
        } catch (err) {
          result.badError = err instanceof Error ? err.message : String(err);
        }
      }
      result.ok = true;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    const payload = JSON.stringify(result);
    process.stdout.write("AIWB_MCP_BOOT:" + payload + "\n");
    const outPath = process.env.AIWB_MCP_PROBE_OUT;
    if (outPath) {
      try { writeFileSync(outPath, payload); } catch {}
    }
  });
}
`

// bootCaptured is one captured registerTool definition.
type bootCaptured struct {
	Name          string `json:"name"`
	Label         string `json:"label"`
	ExecutionMode string `json:"executionMode"`
	Description   string `json:"description"`
	PromptSnippet string `json:"promptSnippet"`
	HasParameters bool   `json:"hasParameters"`
}

// bootReport is the probe's JSON report.
type bootReport struct {
	OK       bool           `json:"ok"`
	Error    string         `json:"error"`
	AllTools []string       `json:"allTools"`
	Captured []bootCaptured `json:"captured"`
	CallText *string        `json:"callText"`
	BadError *string        `json:"badError"`
}

// bootObserved is one request the stub MCP server saw.
type bootObserved struct {
	Method   string
	Protocol string
	Path     string
	Auth     string
}

// bootStub is a minimal JSON-only Streamable HTTP MCP server: initialize echo,
// 202 notifications, a two-page tools/list, tools/call echo/isError, 405 GET.
// extraTools are appended to the first tools/list page (after echo/bad).
// listOverride, if non-nil, replaces the paginated list with a single page.
type bootStub struct {
	server *httptest.Server

	mu           sync.Mutex
	observed     []bootObserved
	extraTools   []map[string]any
	listOverride []map[string]any
}

func newBootStub(t *testing.T) *bootStub {
	t.Helper()
	return newBootStubTools(t, nil, nil)
}

func newBootStubTools(t *testing.T, extra, override []map[string]any) *bootStub {
	t.Helper()
	s := &bootStub{extraTools: extra, listOverride: override}
	s.server = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.server.Close)
	return s
}

type bootRPCRequest struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params struct {
		ProtocolVersion string `json:"protocolVersion"`
		Cursor          string `json:"cursor"`
		Name            string `json:"name"`
	} `json:"params"`
}

func (s *bootStub) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var rq bootRPCRequest
	_ = json.Unmarshal(body, &rq)

	s.mu.Lock()
	s.observed = append(s.observed, bootObserved{
		Method:   rq.Method,
		Protocol: r.Header.Get("mcp-protocol-version"),
		Path:     r.URL.Path,
		Auth:     r.Header.Get("Authorization"),
	})
	s.mu.Unlock()

	if len(rq.ID) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	reply := func(result any) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": rq.ID, "result": result})
	}
	switch rq.Method {
	case "initialize":
		reply(map[string]any{
			"protocolVersion": rq.Params.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "board", "version": "0.0.1"},
		})
	case "tools/list":
		if s.listOverride != nil {
			reply(map[string]any{"tools": s.listOverride})
			return
		}
		if rq.Params.Cursor == "" {
			tools := []map[string]any{
				{
					"name":        "echo",
					"description": "Echo a value",
					"inputSchema": map[string]any{
						"type":       "object",
						"properties": map[string]any{"q": map[string]any{"type": "string"}},
					},
				},
				{
					"name":        "bad",
					"description": "Always fails",
					"inputSchema": map[string]any{"type": "object"},
				},
			}
			tools = append(tools, s.extraTools...)
			reply(map[string]any{
				"tools":      tools,
				"nextCursor": "p2",
			})
			return
		}
		reply(map[string]any{
			"tools": []map[string]any{{"name": "third", "description": "Third tool"}},
		})
	case "tools/call":
		switch rq.Params.Name {
		case "echo":
			reply(map[string]any{"content": []map[string]any{{"type": "text", "text": "echo:hi"}}})
		case "bad":
			reply(map[string]any{
				"content": []map[string]any{{"type": "text", "text": "board boom"}},
				"isError": true,
			})
		default:
			reply(map[string]any{
				"content": []map[string]any{{"type": "text", "text": "unknown tool " + rq.Params.Name}},
				"isError": true,
			})
		}
	case "ping":
		reply(map[string]any{})
	default:
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": rq.ID,
			"error": map[string]any{"code": -32601, "message": "method not found"},
		})
	}
}

func (s *bootStub) methods() []bootObserved {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]bootObserved(nil), s.observed...)
}

// bootStallStub is a minimal MCP server that answers everything except one
// stalling method (`initialize` or `notifications/initialized`), which is held
// open until the client aborts or the test cleanup closes the connection.
// It exercises the extension's connect/discovery budget end to end.
type bootStallStub struct {
	server      *httptest.Server
	stallMethod string

	mu       sync.Mutex
	observed []bootObserved
}

func newBootStallStub(t *testing.T, stallMethod string) *bootStallStub {
	t.Helper()
	s := &bootStallStub{stallMethod: stallMethod}
	s.server = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(func() {
		// Unblock the held handler before Close waits for it.
		s.server.CloseClientConnections()
		s.server.Close()
	})
	return s
}

func (s *bootStallStub) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	body, _ := io.ReadAll(r.Body)
	var rq bootRPCRequest
	_ = json.Unmarshal(body, &rq)

	s.mu.Lock()
	s.observed = append(s.observed, bootObserved{
		Method:   rq.Method,
		Protocol: r.Header.Get("mcp-protocol-version"),
		Path:     r.URL.Path,
		Auth:     r.Header.Get("Authorization"),
	})
	s.mu.Unlock()

	if rq.Method == s.stallMethod {
		// Deliberately never answer: hold the request open until the client's
		// deadline aborts it (or cleanup closes the connection).
		<-r.Context().Done()
		return
	}
	if len(rq.ID) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	reply := func(result any) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": rq.ID, "result": result})
	}
	switch rq.Method {
	case "initialize":
		reply(map[string]any{
			"protocolVersion": rq.Params.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "board", "version": "0.0.1"},
		})
	case "tools/list":
		reply(map[string]any{"tools": []map[string]any{}})
	case "ping":
		reply(map[string]any{})
	default:
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"jsonrpc": "2.0", "id": rq.ID,
			"error": map[string]any{"code": -32601, "message": "method not found"},
		})
	}
}

func (s *bootStallStub) methods() []bootObserved {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]bootObserved(nil), s.observed...)
}

// bootBuffer is a goroutine-safe writer for the child's stdout/stderr.
type bootBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *bootBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *bootBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// bootEnv copies the test environment without any AIWB_* variables, then
// appends the isolated pi settings.
func bootEnv(extra ...string) []string {
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

// piBootRun is one real-pi boot: the child, its output buffers and the probe's
// report path.
type piBootRun struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	stdout     *bootBuffer
	stderr     *bootBuffer
	done       chan error
	resultPath string
}

// bootPiOptions controls one real-pi boot.
type bootPiOptions struct {
	// configFlag is the --mcp-config value; "" omits the flag.
	configFlag string
	// extraEnv is appended after the isolation overrides (may carry
	// AIWB_MCP_CONFIG and AIWB_BRIDGE_* for app-style legs).
	extraEnv []string
	// standalone asserts no AIWB_BRIDGE_*/AIWB_MCP_CONFIG reaches the child, so
	// the standalone legs stay honest.
	standalone bool
}

func startBootPiWith(t *testing.T, pi, probePath string, opts bootPiOptions) *piBootRun {
	t.Helper()
	homeDir := t.TempDir()
	agentDir := t.TempDir()
	workDir := t.TempDir()
	resultPath := filepath.Join(t.TempDir(), "boot-report.json")
	env := bootEnv(append([]string{
		"HOME=" + homeDir,
		"PI_CODING_AGENT_DIR=" + agentDir,
		"PI_OFFLINE=1",
		"PI_SKIP_VERSION_CHECK=1",
		"AIWB_MCP_PROBE_OUT=" + resultPath,
	}, opts.extraEnv...)...)
	if opts.standalone {
		for _, kv := range env {
			if strings.HasPrefix(kv, "AIWB_BRIDGE_") || strings.HasPrefix(kv, "AIWB_MCP_CONFIG=") {
				t.Fatalf("standalone boot env must not contain bridge variables, got %q", kv)
			}
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
	}
	if opts.configFlag != "" {
		args = append(args, "--mcp-config", opts.configFlag)
	}
	args = append(args, "-e", probePath)

	cmd := exec.Command(pi, args...)
	cmd.Dir = workDir
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, stderr := &bootBuffer{}, &bootBuffer{}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Skipf("pi failed to start (%v): cannot run the standalone boot test", err)
	}
	run := &piBootRun{
		cmd:        cmd,
		stdin:      stdin,
		stdout:     stdout,
		stderr:     stderr,
		done:       make(chan error, 1),
		resultPath: resultPath,
	}
	go func() { run.done <- cmd.Wait() }()
	t.Cleanup(run.stop)
	return run
}

// startBootPi is the standalone flavor: a --mcp-config flag and no bridge env.
func startBootPi(t *testing.T, pi, probePath, configJSON string, extraEnv ...string) *piBootRun {
	t.Helper()
	return startBootPiWith(t, pi, probePath, bootPiOptions{configFlag: configJSON, extraEnv: extraEnv, standalone: true})
}

// stop kills the whole process group, not only the leader. It is safe to call
// after the run already exited.
func (r *piBootRun) stop() {
	select {
	case <-r.done:
		_ = r.stdin.Close()
		return
	default:
	}
	_ = r.stdin.Close()
	if r.cmd.Process != nil {
		_ = syscall.Kill(-r.cmd.Process.Pid, syscall.SIGKILL)
	}
	select {
	case <-r.done:
	case <-time.After(5 * time.Second):
	}
}

// waitReport polls for the probe's report file, failing hard on extension-load
// problems and skipping on environment problems.
func (r *piBootRun) waitReport(t *testing.T, timeout time.Duration) []byte {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(r.resultPath); err == nil && len(b) > 0 {
			return b
		}
		select {
		case werr := <-r.done:
			out := r.stdout.String() + r.stderr.String()
			if strings.Contains(out, "Unknown option") || strings.Contains(out, "Failed to load extension") ||
				strings.Contains(out, "requires a value") {
				t.Fatalf("pi failed to load the extension/flag (%v)\nstdout:\n%s\nstderr:\n%s", werr, r.stdout.String(), r.stderr.String())
			}
			t.Skipf("pi exited before the boot probe reported (%v)\nstdout:\n%s\nstderr:\n%s", werr, r.stdout.String(), r.stderr.String())
		default:
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("boot probe did not report within %s\nstdout:\n%s\nstderr:\n%s", timeout, r.stdout.String(), r.stderr.String())
	return nil
}

// waitStderr polls for a substring in the child's stderr, so a notice that is
// flushed just after the probe report still gets observed.
func (r *piBootRun) waitStderr(t *testing.T, substr string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if strings.Contains(r.stderr.String(), substr) {
			return r.stderr.String()
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("stderr lacks %q within %s:\n%s", substr, timeout, r.stderr.String())
	return ""
}

// assertRPCAlive proves the pi process survived a failure leg by getting an RPC
// response after the probe reported.
func (r *piBootRun) assertRPCAlive(t *testing.T) {
	t.Helper()
	if _, err := io.WriteString(r.stdin, "{\"id\":\"alive-1\",\"type\":\"get_state\"}\n"); err != nil {
		t.Fatalf("write get_state: %v", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(r.stdout.String(), `"alive-1"`) {
			return
		}
		select {
		case werr := <-r.done:
			t.Fatalf("pi exited instead of answering get_state (%v)\nstdout:\n%s\nstderr:\n%s", werr, r.stdout.String(), r.stderr.String())
		case <-time.After(100 * time.Millisecond):
		}
	}
	t.Fatalf("pi did not answer get_state within 30s\nstdout:\n%s\nstderr:\n%s", r.stdout.String(), r.stderr.String())
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func decodeBootReport(t *testing.T, raw []byte) bootReport {
	t.Helper()
	var report bootReport
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatalf("boot report is not JSON: %v\n%s", err, raw)
	}
	if !report.OK {
		t.Fatalf("boot probe failed: %s\nraw report: %s", report.Error, raw)
	}
	return report
}

// checkNoNativeBoardTools asserts the standalone boot registered no raw board
// tool names (native registration is app-run-only in Phase 3).
func checkNoNativeBoardTools(t *testing.T, allTools []string) {
	t.Helper()
	for _, name := range allTools {
		if boardtools.IsTool(name) {
			t.Fatalf("standalone boot registered native board tool %q; all tools: %v", name, allTools)
		}
	}
}

func spawnFamilyToolDefs() []map[string]any {
	return []map[string]any{
		{"name": "spawn_subagent", "description": "Spawn a subagent", "inputSchema": map[string]any{"type": "object"}},
		{"name": "wait_subagents", "description": "Wait for subagents", "inputSchema": map[string]any{"type": "object"}},
		{"name": "stop_subagent", "description": "Stop a subagent", "inputSchema": map[string]any{"type": "object"}},
	}
}

func spawnFamilyRegisteredNames() []string {
	return []string{
		"mcp__board__spawn_subagent",
		"mcp__board__wait_subagents",
		"mcp__board__stop_subagent",
	}
}

func isSpawnFamilyName(name string) bool {
	switch name {
	case "spawn_subagent", "wait_subagents", "stop_subagent":
		return true
	}
	return strings.HasSuffix(name, "__spawn_subagent") ||
		strings.HasSuffix(name, "__wait_subagents") ||
		strings.HasSuffix(name, "__stop_subagent")
}

func checkNoNativeSubagent(t *testing.T, captured []bootCaptured, allTools []string) {
	t.Helper()
	for _, tool := range captured {
		if tool.Name == "subagent" {
			t.Fatalf("registered native subagent: %+v", captured)
		}
	}
	for _, name := range allTools {
		if name == "subagent" {
			t.Fatalf("getAllTools includes native subagent: %v", allTools)
		}
	}
}

func checkNoBoardWording(t *testing.T, captured []bootCaptured) {
	t.Helper()
	for _, tool := range captured {
		if strings.Contains(tool.Description, "including the board tools") ||
			strings.Contains(tool.PromptSnippet, "including the board tools") {
			t.Fatalf("tool %s promises board tools: desc=%q snippet=%q", tool.Name, tool.Description, tool.PromptSnippet)
		}
	}
}

func checkSpawnFamilyNotSequential(t *testing.T, captured []bootCaptured) {
	t.Helper()
	for _, tool := range captured {
		if !isSpawnFamilyName(tool.Name) {
			continue
		}
		if tool.ExecutionMode == "sequential" {
			t.Fatalf("spawn-family tool %s executionMode = %q, want omitted/empty (not sequential)", tool.Name, tool.ExecutionMode)
		}
	}
}

// bootProbeSetup resolves node/pi, materializes the real extension tree and
// writes the probe beside it. It skips (never fails) when the environment
// cannot run a real-pi boot.
func bootProbeSetup(t *testing.T) (pi, probePath string) {
	t.Helper()
	if testing.Short() {
		t.Skip("skipping real-pi boot test in short mode")
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not available")
	}
	var err error
	pi, err = exec.LookPath("pi")
	if err != nil {
		t.Skip("pi not available")
	}
	versionCtx, cancelVersion := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelVersion()
	versionOut, err := exec.CommandContext(versionCtx, pi, "--version").Output()
	if err != nil || strings.TrimSpace(string(versionOut)) == "" {
		t.Skipf("pi --version failed (%v, output %q): cannot run the real-pi boot test", err, strings.TrimSpace(string(versionOut)))
	}

	extDir := filepath.Join(t.TempDir(), "pi-extension")
	if _, err := MaterializeExtension(extDir); err != nil {
		t.Fatalf("MaterializeExtension: %v", err)
	}
	probePath = filepath.Join(extDir, "boot-probe.ts")
	if err := os.WriteFile(probePath, []byte(bootProbeSource), 0o600); err != nil {
		t.Fatalf("write boot probe: %v", err)
	}
	return pi, probePath
}

func TestMCPRealPiStandaloneBoot(t *testing.T) {
	pi, probePath := bootProbeSetup(t)

	t.Run("success", func(t *testing.T) {
		stub := newBootStub(t)
		configJSON, err := json.Marshal(map[string]any{
			"mcpServers": map[string]any{
				"board": map[string]any{"type": "http", "url": stub.server.URL + "/mcp",
					"headers": map[string]any{"Authorization": "Bearer TESTTOKEN"}},
			},
		})
		if err != nil {
			t.Fatal(err)
		}

		run := startBootPi(t, pi, probePath, string(configJSON))
		report := decodeBootReport(t, run.waitReport(t, 90*time.Second))

		wantNames := []string{"mcp__board__echo", "mcp__board__bad", "mcp__board__third"}
		if len(report.Captured) != len(wantNames) {
			t.Fatalf("registered %d tools, want %d: %+v", len(report.Captured), len(wantNames), report.Captured)
		}
		for i, want := range wantNames {
			got := report.Captured[i]
			if got.Name != want {
				t.Fatalf("tool %d name = %q, want %q (all: %+v)", i, got.Name, want, report.Captured)
			}
			if got.ExecutionMode != "sequential" {
				t.Fatalf("tool %s executionMode = %q, want sequential", got.Name, got.ExecutionMode)
			}
			if !got.HasParameters {
				t.Fatalf("tool %s registered without parameters", got.Name)
			}
			if got.PromptSnippet == "" {
				t.Fatalf("tool %s registered without a promptSnippet", got.Name)
			}
			if !strings.Contains(strings.Join(report.AllTools, ","), got.Name) {
				t.Fatalf("tool %s missing from getAllTools: %v", got.Name, report.AllTools)
			}
		}
		checkNoNativeBoardTools(t, report.AllTools)
		if report.CallText == nil || *report.CallText != "echo:hi" {
			t.Fatalf("echo call = %v, want echo:hi", report.CallText)
		}
		if report.BadError == nil || *report.BadError != "board boom" {
			t.Fatalf("isError call = %v, want the board text thrown", report.BadError)
		}

		// The stub observed the full handshake and paginated discovery.
		observed := stub.methods()
		var methods []string
		for _, req := range observed {
			methods = append(methods, req.Method)
		}
		wantMethods := []string{"initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call", "tools/call"}
		if strings.Join(methods, ",") != strings.Join(wantMethods, ",") {
			t.Fatalf("stub saw %v, want %v", methods, wantMethods)
		}
		for _, req := range observed {
			if req.Path != "/mcp" {
				t.Fatalf("stub request path = %q, want /mcp", req.Path)
			}
			if req.Auth != "Bearer TESTTOKEN" {
				t.Fatalf("stub request Authorization = %q, want the board token in the header", req.Auth)
			}
		}
		if observed[0].Protocol != "" {
			t.Fatalf("initialize must not carry mcp-protocol-version, got %q", observed[0].Protocol)
		}
		for _, req := range observed[1:] {
			if req.Protocol != "2025-06-18" {
				t.Fatalf("%s mcp-protocol-version = %q, want 2025-06-18", req.Method, req.Protocol)
			}
		}

		run.assertRPCAlive(t)
	})

	t.Run("connect failure", func(t *testing.T) {
		deadPort := freeTCPPort(t)
		configJSON := fmt.Sprintf(`{"mcpServers":{"board":{"url":"http://127.0.0.1:%d/mcp"}}}`, deadPort)
		run := startBootPi(t, pi, probePath, configJSON)
		report := decodeBootReport(t, run.waitReport(t, 90*time.Second))

		if len(report.Captured) != 0 {
			t.Fatalf("failed server still registered tools: %+v", report.Captured)
		}
		for _, name := range report.AllTools {
			if strings.HasPrefix(name, "mcp__") {
				t.Fatalf("failed server still registered %q in getAllTools: %v", name, report.AllTools)
			}
		}
		checkNoNativeBoardTools(t, report.AllTools)

		stderr := run.waitStderr(t, `ai-whiteboard pi extension: MCP server "board" failed:`, 10*time.Second)
		if !strings.Contains(stderr, "MCP initialize failed") {
			t.Fatalf("stderr lacks the transport error detail:\n%s", stderr)
		}
		if !strings.Contains(stderr, "ECONNREFUSED") && !strings.Contains(stderr, "bad port") {
			t.Fatalf("stderr lacks the connection-refused detail:\n%s", stderr)
		}
		run.assertRPCAlive(t)
	})

	// A server that accepts requests but never answers one phase must not hold
	// pi's session_start open: the per-server handshake budget expires, the
	// failure is reported, and pi answers get_state. The env override keeps the
	// legs at ~1 s instead of the 10 s production default.
	for _, tc := range []struct {
		name        string
		stallMethod string
	}{
		{name: "initialize never answered", stallMethod: "initialize"},
		{name: "notification never answered", stallMethod: "notifications/initialized"},
	} {
		t.Run("stalling server/"+tc.name, func(t *testing.T) {
			stub := newBootStallStub(t, tc.stallMethod)
			configJSON := fmt.Sprintf(`{"mcpServers":{"board":{"url":%q}}}`, stub.server.URL+"/mcp")
			run := startBootPi(t, pi, probePath, configJSON, "AIWB_MCP_HANDSHAKE_TIMEOUT_MS=1000")
			report := decodeBootReport(t, run.waitReport(t, 90*time.Second))

			if len(report.Captured) != 0 {
				t.Fatalf("stalling server registered tools: %+v", report.Captured)
			}
			for _, name := range report.AllTools {
				if strings.HasPrefix(name, "mcp__") {
					t.Fatalf("stalling server registered %q in getAllTools: %v", name, report.AllTools)
				}
			}
			checkNoNativeBoardTools(t, report.AllTools)

			stderr := run.waitStderr(t, `ai-whiteboard pi extension: MCP server "board" failed:`, 10*time.Second)
			if !strings.Contains(stderr, "MCP handshake timed out after 1000ms") {
				t.Fatalf("stderr lacks the handshake timeout detail:\n%s", stderr)
			}

			// The stall must have happened where expected and discovery must not
			// have run. (The client may also send a best-effort cancellation after
			// an id-bearing request is aborted, so only the prefix is pinned.)
			var methods []string
			for _, req := range stub.methods() {
				methods = append(methods, req.Method)
			}
			if len(methods) == 0 || methods[0] != "initialize" {
				t.Fatalf("stub saw %v, want the stall to begin with initialize", methods)
			}
			if tc.stallMethod == "notifications/initialized" &&
				(len(methods) < 2 || methods[1] != "notifications/initialized") {
				t.Fatalf("stub saw %v, want the notification to be stalled", methods)
			}
			for _, method := range methods {
				if method == "tools/list" {
					t.Fatalf("stall did not prevent discovery: %v", methods)
				}
			}
			run.assertRPCAlive(t)
		})
	}

	t.Run("no config", func(t *testing.T) {
		run := startBootPi(t, pi, probePath, "")
		report := decodeBootReport(t, run.waitReport(t, 90*time.Second))
		if len(report.Captured) != 0 {
			t.Fatalf("config-less boot registered tools: %+v", report.Captured)
		}
		for _, name := range report.AllTools {
			if strings.HasPrefix(name, "mcp__") {
				t.Fatalf("config-less boot registered %q: %v", name, report.AllTools)
			}
		}
		checkNoNativeBoardTools(t, report.AllTools)
		run.assertRPCAlive(t)
	})
}

// TestMCPRealPiAppEnvBoot is the Phase 4 half of A3: an app-style boot with
// AIWB_MCP_CONFIG (env source) and bridge-like AIWB_BRIDGE_* variables must
// register the board MCP tools plus the spawn-family mcp__board__* tools, and
// no raw native board tool name and no native subagent tool — the native
// registration is gone and the MCP spawn family replaces it.
//
// The bridge is simulated with a nonexistent socket path and a fake run handle:
// the extension uses the bridge only for the permission gate, hello/abort and
// the best-effort control channel, all of which tolerate an unreachable
// socket; the probe drives the MCP tools directly, so no UDS server is needed.
func TestMCPRealPiAppEnvBoot(t *testing.T) {
	pi, probePath := bootProbeSetup(t)

	stub := newBootStubTools(t, spawnFamilyToolDefs(), nil)
	configJSON, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"board": map[string]any{"type": "http", "url": stub.server.URL + "/mcp",
				"headers": map[string]any{"Authorization": "Bearer APPBTOKEN"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	run := startBootPiWith(t, pi, probePath, bootPiOptions{extraEnv: []string{
		"AIWB_MCP_CONFIG=" + string(configJSON),
		"AIWB_BRIDGE_SOCKET=" + filepath.Join(t.TempDir(), "missing.sock"),
		"AIWB_BRIDGE_RUN=run-app-1",
	}})
	report := decodeBootReport(t, run.waitReport(t, 90*time.Second))

	// Board-engine MCP tools plus the spawn family; native subagent is gone.
	want := map[string]bool{
		"mcp__board__echo":           true,
		"mcp__board__bad":            true,
		"mcp__board__third":          true,
		"mcp__board__spawn_subagent": true,
		"mcp__board__wait_subagents": true,
		"mcp__board__stop_subagent":  true,
	}
	got := map[string]bool{}
	for _, tool := range report.Captured {
		if boardtools.IsTool(tool.Name) {
			t.Fatalf("app boot registered the raw native board tool %q: %+v", tool.Name, report.Captured)
		}
		got[tool.Name] = true
		if isSpawnFamilyName(tool.Name) {
			if tool.ExecutionMode == "sequential" {
				t.Fatalf("spawn-family tool %s executionMode = %q, want omitted/empty", tool.Name, tool.ExecutionMode)
			}
		} else if tool.ExecutionMode != "sequential" {
			t.Fatalf("board MCP tool %s executionMode = %q, want sequential", tool.Name, tool.ExecutionMode)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("app boot registered %d tools, want %d: %+v", len(got), len(want), report.Captured)
	}
	for name := range want {
		if !got[name] {
			t.Fatalf("tool %q missing from the registered set: %+v", name, report.Captured)
		}
	}
	checkNoNativeSubagent(t, report.Captured, report.AllTools)
	checkNoNativeBoardTools(t, report.AllTools)
	checkSpawnFamilyNotSequential(t, report.Captured)
	for name := range want {
		found := false
		for _, all := range report.AllTools {
			if all == name {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("tool %q missing from getAllTools: %v", name, report.AllTools)
		}
	}

	// The env-sourced config reached the stub through the fixed path with the
	// board-token header, and the MCP call path works from the env source.
	methods := make([]string, 0, len(stub.methods()))
	for _, req := range stub.methods() {
		methods = append(methods, req.Method)
		if req.Path != "/mcp" {
			t.Fatalf("stub request path = %q, want /mcp", req.Path)
		}
		if req.Auth != "Bearer APPBTOKEN" {
			t.Fatalf("stub request Authorization = %q, want the board token in the header", req.Auth)
		}
	}
	if len(methods) == 0 || methods[0] != "initialize" {
		t.Fatalf("stub saw %v, want an MCP handshake", methods)
	}
	if report.CallText == nil || *report.CallText != "echo:hi" {
		t.Fatalf("echo call = %v, want echo:hi", report.CallText)
	}
	run.assertRPCAlive(t)
}

// TestMCPRealPiAppPlainChatBoot is the A4 app-run leg: a plain chat's boot has
// the bridge environment (permission gate, hello/abort) and AIWB_MCP_CONFIG
// pointing at a spawn-family MCP server. It must register the spawn-family
// mcp__board__* tools without sequential execution, never native subagent, and
// never promise board-engine tools in wording.
func TestMCPRealPiAppPlainChatBoot(t *testing.T) {
	pi, probePath := bootProbeSetup(t)

	stub := newBootStubTools(t, nil, spawnFamilyToolDefs())
	configJSON, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"board": map[string]any{"type": "http", "url": stub.server.URL + "/mcp",
				"headers": map[string]any{"Authorization": "Bearer PLAINTOKEN"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	run := startBootPiWith(t, pi, probePath, bootPiOptions{extraEnv: []string{
		"AIWB_MCP_CONFIG=" + string(configJSON),
		"AIWB_BRIDGE_SOCKET=" + filepath.Join(t.TempDir(), "missing.sock"),
		"AIWB_BRIDGE_RUN=run-plain-1",
	}})
	report := decodeBootReport(t, run.waitReport(t, 90*time.Second))

	want := map[string]bool{}
	for _, name := range spawnFamilyRegisteredNames() {
		want[name] = true
	}
	got := map[string]bool{}
	for _, tool := range report.Captured {
		got[tool.Name] = true
	}
	if len(got) != len(want) {
		t.Fatalf("plain app boot registered %+v, want exactly %v", report.Captured, spawnFamilyRegisteredNames())
	}
	for name := range want {
		if !got[name] {
			t.Fatalf("tool %q missing from the registered set: %+v", name, report.Captured)
		}
	}
	checkNoNativeSubagent(t, report.Captured, report.AllTools)
	checkNoNativeBoardTools(t, report.AllTools)
	checkNoBoardWording(t, report.Captured)
	checkSpawnFamilyNotSequential(t, report.Captured)
	for _, tool := range report.Captured {
		if !isSpawnFamilyName(tool.Name) {
			t.Fatalf("plain app boot registered non-spawn-family tool %q: %+v", tool.Name, report.Captured)
		}
		if tool.ExecutionMode != "" {
			t.Fatalf("spawn-family tool %s executionMode = %q, want empty/omitted", tool.Name, tool.ExecutionMode)
		}
	}
	run.assertRPCAlive(t)
}
