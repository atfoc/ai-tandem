package pibridge

// Tests for the extension's handling of the app's AIWB_* handles (app-env.ts): the Node unit tests,
// and a real-pi boot (no model call) that shows the handles are gone from the environment of pi's
// shell commands while the extension still has them after pi evaluates it a second time.

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestAppEnvNode runs the dependency-free app-env unit tests under Node's type
// stripping. Skipped when node is not installed.
func TestAppEnvNode(t *testing.T) {
	runNodeTest(t, "app-env.test.ts")
}

// appEnvNames are the variables the extension takes out of pi's environment.
var appEnvNames = []string{"AIWB_BRIDGE_SOCKET", "AIWB_BRIDGE_RUN", "AIWB_MCP_CONFIG", "AIWB_MCP_CONFIG_FILE", "AIWB_CHAT_DIR", "AIWB_APPEND_PROMPT"}

// appEnvShell prints the six variables as a shell command sees them.
const appEnvShell = `printf 'S=[%s] R=[%s] M=[%s] F=[%s] D=[%s] P=[%s]\n' "$AIWB_BRIDGE_SOCKET" "$AIWB_BRIDGE_RUN" "$AIWB_MCP_CONFIG" "$AIWB_MCP_CONFIG_FILE" "$AIWB_CHAT_DIR" "$AIWB_APPEND_PROMPT"; env | grep -cE '^AIWB_(BRIDGE_SOCKET|BRIDGE_RUN|MCP_CONFIG|MCP_CONFIG_FILE|CHAT_DIR|APPEND_PROMPT)='`

// appEnvShellEmpty is what appEnvShell prints when a shell command inherits none of them.
const appEnvShellEmpty = "S=[] R=[] M=[] F=[] D=[] P=[]\n0"

// appEnvProbeSource wraps the real extension factory. Every evaluation of the factory appends one
// JSON line: how often this module and this factory have run in the process (counted on
// globalThis, which outlives a re-imported module), which of the six variables were in
// process.env before and after the app's factory ran, and whether the factory registered the
// tool_call permission gate. Its /aiwb-reload command runs pi's reload, which imports the
// extension's modules again.
const appEnvProbeSource = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import boardExtension from "./index.ts";

const NAMES = ["AIWB_BRIDGE_SOCKET", "AIWB_BRIDGE_RUN", "AIWB_MCP_CONFIG", "AIWB_MCP_CONFIG_FILE", "AIWB_CHAT_DIR", "AIWB_APPEND_PROMPT"];
const counts = ((globalThis as any).__aiwbAppEnvProbe ??= { module: 0, factory: 0 });
counts.module += 1;

export default function appEnvProbe(pi: ExtensionAPI): void {
  counts.factory += 1;
  let gate = false;
  const api = new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "on") {
        return (name: string, handler: unknown) => {
          if (name === "tool_call") gate = true;
          return (target as any).on(name, handler);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const before = NAMES.filter((name) => name in process.env);
  boardExtension(api as ExtensionAPI);
  pi.registerCommand("aiwb-reload", {
    description: "Reload the extensions (test only)",
    handler: async (_args: unknown, ctx: any) => {
      await ctx.reload();
      return;
    },
  });
  const after = NAMES.filter((name) => name in process.env);
  const line = JSON.stringify({ module: counts.module, factory: counts.factory, pid: process.pid, gate, before, after });
  const outPath = process.env.AIWB_MCP_PROBE_OUT;
  if (outPath) appendFileSync(outPath, line + "\n");
}
`

// appEnvProbeLine is one line of the probe's report.
type appEnvProbeLine struct {
	Module  int      `json:"module"`
	Factory int      `json:"factory"`
	PID     int      `json:"pid"`
	Gate    bool     `json:"gate"`
	Before  []string `json:"before"`
	After   []string `json:"after"`
}

// appEnvProbeLines reads the probe's report once it holds at least n lines.
func appEnvProbeLines(t *testing.T, run *piBootRun, n int) []appEnvProbeLine {
	t.Helper()
	deadline := time.Now().Add(90 * time.Second)
	for {
		var lines []appEnvProbeLine
		if f, err := os.Open(run.resultPath); err == nil {
			sc := bufio.NewScanner(f)
			for sc.Scan() {
				var l appEnvProbeLine
				if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
					t.Fatalf("probe line is not JSON: %v\n%s", err, sc.Text())
				}
				lines = append(lines, l)
			}
			f.Close()
		}
		if len(lines) >= n {
			return lines
		}
		select {
		case werr := <-run.done:
			t.Fatalf("pi exited with %d of %d probe lines (%v)\nstdout:\n%s\nstderr:\n%s", len(lines), n, werr, run.stdout.String(), run.stderr.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("the probe wrote %d of %d lines\nstdout:\n%s\nstderr:\n%s", len(lines), n, run.stdout.String(), run.stderr.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// appEnvRPC sends one RPC command and returns the data of its response.
func appEnvRPC(t *testing.T, run *piBootRun, id string, command map[string]any) json.RawMessage {
	t.Helper()
	command["id"] = id
	b, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(run.stdin, string(b)+"\n"); err != nil {
		t.Fatalf("write %s: %v", b, err)
	}
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		for _, line := range strings.Split(run.stdout.String(), "\n") {
			var resp struct {
				Type    string          `json:"type"`
				ID      string          `json:"id"`
				Success bool            `json:"success"`
				Error   string          `json:"error"`
				Data    json.RawMessage `json:"data"`
			}
			if json.Unmarshal([]byte(line), &resp) != nil || resp.Type != "response" || resp.ID != id {
				continue
			}
			if !resp.Success {
				t.Fatalf("pi answered %s with an error: %s", b, resp.Error)
			}
			return resp.Data
		}
		select {
		case werr := <-run.done:
			t.Fatalf("pi exited instead of answering %s (%v)\nstdout:\n%s\nstderr:\n%s", b, werr, run.stdout.String(), run.stderr.String())
		case <-time.After(100 * time.Millisecond):
		}
	}
	t.Fatalf("pi did not answer %s within 60s\nstdout:\n%s\nstderr:\n%s", b, run.stdout.String(), run.stderr.String())
	return nil
}

// appEnvBash runs a shell command through pi's RPC `bash` command (the executor of its bash tool,
// no model turn) and returns the output.
func appEnvBash(t *testing.T, run *piBootRun, id, command string) string {
	t.Helper()
	var data struct {
		Output string `json:"output"`
	}
	if err := json.Unmarshal(appEnvRPC(t, run, id, map[string]any{"type": "bash", "command": command}), &data); err != nil {
		t.Fatalf("bash response: %v", err)
	}
	return strings.TrimSpace(data.Output)
}

// TestRealPiAppEnvTaken boots real pi the way the app does (bridge handle, MCP config with a
// token, chat folder, prompt file in AIWB_* variables) and checks, with no model call:
//   - a shell command pi runs sees none of the five variables;
//   - a new session makes pi evaluate the extension's factory again in the same process, after
//     the variables are gone, and that evaluation still registers the permission gate and still
//     connects to the MCP server with the token;
//   - so does a reload, which also imports the extension's modules again (their module-level
//     state starts empty).
//
// Without the second half the fix would be worse than the leak: an extension that sees no bridge
// registers no gate (that is its standalone behaviour), so the chat would run unguarded.
func TestRealPiAppEnvTaken(t *testing.T) {
	pi, probePath := bootProbeSetup(t)
	probePath = filepath.Join(filepath.Dir(probePath), "app-env-probe.ts")
	if err := os.WriteFile(probePath, []byte(appEnvProbeSource), 0o600); err != nil {
		t.Fatal(err)
	}

	stub := newBootStub(t)
	configJSON, err := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"board": map[string]any{"type": "http", "url": stub.server.URL + "/mcp",
				"headers": map[string]any{"Authorization": "Bearer APPBTOKEN"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(t.TempDir(), "aiwbdata")
	chatDir := filepath.Join(data, "chats", "c1")
	if err := os.MkdirAll(chatDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chatDir, "chat.json"), []byte(`{"token":"CHATFILETOKEN"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// The app's way: the config with the token is a file in the chat's folder and the variable
	// holds its path. AIWB_MCP_CONFIG is set too (the app does not), with another token: the
	// file must win, and the extension must take both variables.
	configFile := filepath.Join(chatDir, "mcp.json")
	if err := os.WriteFile(configFile, configJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	run := startBootPiWith(t, pi, probePath, bootPiOptions{extraEnv: []string{
		"AIWB_MCP_CONFIG_FILE=" + configFile,
		"AIWB_MCP_CONFIG=" + strings.Replace(string(configJSON), "APPBTOKEN", "ENVVARTOKEN", 1),
		"AIWB_BRIDGE_SOCKET=" + filepath.Join(data, "missing.sock"),
		"AIWB_BRIDGE_RUN=run-app-env-1",
		"AIWB_CHAT_DIR=" + chatDir,
		"AIWB_APPEND_PROMPT=" + filepath.Join(chatDir, "pi", "append-prompt.md"),
	}})

	initializes := func() int {
		n := 0
		for _, req := range stub.methods() {
			if req.Method == "initialize" {
				if req.Auth != "Bearer APPBTOKEN" {
					t.Fatalf("initialize Authorization = %q, want the token from the file AIWB_MCP_CONFIG_FILE names", req.Auth)
				}
				n++
			}
		}
		return n
	}
	waitInitializes := func(want int) {
		t.Helper()
		for deadline := time.Now().Add(30 * time.Second); initializes() < want; time.Sleep(50 * time.Millisecond) {
			if time.Now().After(deadline) {
				t.Fatalf("the MCP server saw %d initialize requests, want %d: the config was lost", initializes(), want)
			}
		}
	}
	checkShell := func(id string) {
		t.Helper()
		out := appEnvBash(t, run, id, appEnvShell)
		t.Logf("%s: a shell command run by pi prints: %q", id, out)
		if out != appEnvShellEmpty {
			t.Fatalf("a shell command run by pi sees the app's variables: %q, want %q", out, appEnvShellEmpty)
		}
		// T07-F1 way 5: with the variable gone the command reads nothing.
		out = appEnvBash(t, run, id+"-cat", `cat "$AIWB_CHAT_DIR/chat.json" "$AIWB_MCP_CONFIG_FILE" 2>&1 </dev/null; echo "$AIWB_MCP_CONFIG"`)
		if strings.Contains(out, "CHATFILETOKEN") || strings.Contains(out, "APPBTOKEN") || strings.Contains(out, "ENVVARTOKEN") {
			t.Fatalf("a shell command run by pi printed a token: %q", out)
		}
	}

	// The first evaluation: the factory finds the six variables and removes them.
	first := appEnvProbeLines(t, run, 1)[0]
	t.Logf("first evaluation: %+v", first)
	if len(first.Before) != len(appEnvNames) {
		t.Fatalf("the first evaluation found %v in the environment, want all of %v", first.Before, appEnvNames)
	}
	if first.PID != run.cmd.Process.Pid {
		t.Fatalf("the factory ran in process %d, not in the pi process %d that was started", first.PID, run.cmd.Process.Pid)
	}
	if len(first.After) != 0 {
		t.Fatalf("the factory left %v in pi's environment", first.After)
	}
	if !first.Gate {
		t.Fatal("the first evaluation registered no permission gate")
	}
	waitInitializes(1)
	checkShell("bash-1")

	// A new session: pi reloads and rebinds its extensions (pi's extensions.md), so the factory
	// runs again in the same process, now without the variables.
	var switched struct {
		Cancelled bool `json:"cancelled"`
	}
	if err := json.Unmarshal(appEnvRPC(t, run, "new-1", map[string]any{"type": "new_session"}), &switched); err != nil || switched.Cancelled {
		t.Fatalf("new_session: %v, cancelled %v", err, switched.Cancelled)
	}
	second := appEnvProbeLines(t, run, 2)[1]
	t.Logf("second evaluation: %+v", second)
	if second.PID != first.PID || second.Factory != 2 {
		t.Fatalf("second evaluation %+v, want the factory's second run in process %d", second, first.PID)
	}
	if len(second.Before) != 0 || len(second.After) != 0 {
		t.Fatalf("the second evaluation saw the variables again: %+v", second)
	}
	if !second.Gate {
		t.Fatal("the second evaluation registered no permission gate: the chat would run without the app-folder guard")
	}
	waitInitializes(2)
	checkShell("bash-2")

	// A reload: pi drops its cache of extension factories and imports the modules again.
	appEnvRPC(t, run, "reload-1", map[string]any{"type": "prompt", "message": "/aiwb-reload"})
	third := appEnvProbeLines(t, run, 3)[2]
	t.Logf("third evaluation: %+v", third)
	if third.PID != first.PID || third.Factory != 3 || third.Module != 2 {
		t.Fatalf("third evaluation %+v, want the factory's third run and the module's second in process %d", third, first.PID)
	}
	if len(third.Before) != 0 || len(third.After) != 0 {
		t.Fatalf("the third evaluation saw the variables again: %+v", third)
	}
	if !third.Gate {
		t.Fatal("the evaluation after a reload registered no permission gate: the chat would run without the app-folder guard")
	}
	waitInitializes(3)
	checkShell("bash-3")
	run.assertRPCAlive(t)
}
