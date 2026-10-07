package pi

// Real-pi end-to-end tests for the app's handles in pi's environment: the extension takes
// AIWB_BRIDGE_SOCKET, AIWB_BRIDGE_RUN, AIWB_MCP_CONFIG_FILE (the path of the file with the chat's
// token; the token itself is never in the environment), AIWB_CHAT_DIR and AIWB_APPEND_PROMPT out
// of process.env, so the shell commands pi runs do not inherit them, and
// keeps the values, so a fork (pi runs the extension's factory again in the same process) still
// has the permission gate and the app-folder guard. Gated like e2e_test.go (AIWB_PI_E2E=1, real
// pi on PATH); see that file for the gate, model override and isolation notes.
//
//	AIWB_PI_E2E=1 go test -count=1 -run 'TestE2EShellEnv|TestE2EForkKeepsGuard' -v ./internal/pi/
//
// TestE2EShellEnv makes no model call; TestE2EForkKeepsGuard makes three short turns.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

// e2eAppEnvNames are the variables the extension takes out of pi's environment.
var e2eAppEnvNames = []string{"AIWB_BRIDGE_SOCKET", "AIWB_BRIDGE_RUN", "AIWB_MCP_CONFIG_FILE", "AIWB_CHAT_DIR", "AIWB_APPEND_PROMPT"}

// e2eEnvShell prints the five variables (and AIWB_MCP_CONFIG, which the app no longer sets) as a
// shell command sees them, and how many of them are in its environment at all.
const e2eEnvShell = `echo "APPENV[$AIWB_BRIDGE_SOCKET|$AIWB_BRIDGE_RUN|$AIWB_MCP_CONFIG_FILE|$AIWB_MCP_CONFIG|$AIWB_CHAT_DIR|$AIWB_APPEND_PROMPT]"; ` +
	`echo "COUNT[$(env | grep -cE '^AIWB_(BRIDGE_SOCKET|BRIDGE_RUN|MCP_CONFIG|MCP_CONFIG_FILE|CHAT_DIR|APPEND_PROMPT)=')]"`

// e2eEnvShellEmpty is what e2eEnvShell prints when the command inherits none of them.
const e2eEnvShellEmpty = "APPENV[|||||]\nCOUNT[0]"

// e2eEnvSpawner is the app's Spawner over a data folder with a distinctive name, so the
// app-folder guard (a text match that includes the folder's last name) refuses nothing by chance.
// cwd is a chat folder next to it: a model asked to read a file in the data folder then sees a
// neighbouring folder, not some unrelated temp folder it may decline to open.
func e2eEnvSpawner(t *testing.T, env *e2eBoardEnv) (s *Spawner, cwd string) {
	t.Helper()
	base := t.TempDir()
	s = env.newSpawner(t, nil)
	s.AppRoot = filepath.Join(base, "aiwbdata")
	cwd = filepath.Join(base, "project")
	for _, dir := range []string{s.AppRoot, cwd} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return s, cwd
}

// e2eGivenAppEnv checks the precondition: the adapter did start this pi process with the named
// variables (all five when none is named). It returns the values of those it was given.
func e2eGivenAppEnv(t *testing.T, p *proc, names ...string) map[string]string {
	t.Helper()
	if len(names) == 0 {
		names = e2eAppEnvNames
	}
	given := map[string]string{}
	for _, kv := range p.cmd.Env {
		if k, v, ok := strings.Cut(kv, "="); ok && contains(e2eAppEnvNames, k) {
			given[k] = v
		}
	}
	for _, name := range names {
		if given[name] == "" {
			t.Fatalf("the adapter started pi without %s; the test would prove nothing", name)
		}
	}
	return given
}

// e2eRPCBash runs a shell command through pi's RPC `bash` command (the executor of its bash tool,
// no model turn) and returns the output.
func e2eRPCBash(t *testing.T, p *proc, command string) string {
	t.Helper()
	res, err := p.rpc.call("bash", map[string]any{"command": command}, 30*time.Second)
	if err != nil || !res.Success {
		t.Fatalf("pi bash %q: %v %s", command, err, res.Error)
	}
	var data struct {
		Output string `json:"output"`
	}
	if err := json.Unmarshal(res.Data, &data); err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(data.Output)
}

// e2eNoAppEnv checks that a shell command run by pi sees none of the five variables and that
// nothing in its whole environment carries one of their values.
func e2eNoAppEnv(t *testing.T, what string, p *proc, given map[string]string) {
	t.Helper()
	out := e2eRPCBash(t, p, e2eEnvShell)
	t.Logf("%s: a shell command run by pi prints %q", what, out)
	if out != e2eEnvShellEmpty {
		t.Fatalf("%s: a shell command run by pi sees the app's variables: %q, want %q", what, out, e2eEnvShellEmpty)
	}
	all := e2eRPCBash(t, p, "env")
	for name, value := range given {
		if strings.Contains(all, value) {
			t.Fatalf("%s: the value of %s is in the environment of pi's shell commands", what, name)
		}
	}
	var left []string
	for _, line := range strings.Split(all, "\n") {
		if name, _, ok := strings.Cut(line, "="); ok && strings.HasPrefix(name, "AIWB_") {
			left = append(left, name)
		}
	}
	t.Logf("%s: AIWB_* variables a shell command still sees: %v", what, left)
}

// TestE2EShellEnv starts a board chat's pi the way the app does and checks, with no model call,
// that a shell command pi runs gets none of the app's five variables: not the chat's token, not
// the bridge socket and run handle, not the chat's folder. The T07-F1 command
// `cat "$AIWB_CHAT_DIR/chat.json"` no longer prints the chat file.
func TestE2EShellEnv(t *testing.T) {
	e2eAgentDir(t)
	env := newE2EBoardEnv(t)
	s, cwd := e2eEnvSpawner(t, env)
	const chatID = "e2e-env"
	chatDir := filepath.Join(s.AppRoot, "chats", chatID)
	if err := os.MkdirAll(chatDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(chatDir, "chat.json"), []byte(`{"token":"`+env.token+`"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	a, err := s.Spawn(agent.SpawnOptions{ChatID: chatID, Cwd: cwd, Model: e2eModel(),
		MCP: env.boardAccess(), BoardID: "b"})
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer a.Close()
	e2eReady(t, a)
	p := a.(*proc)
	given := e2eGivenAppEnv(t, p)
	configFile := filepath.Join(chatDir, "mcp.json")
	if given["AIWB_CHAT_DIR"] != chatDir || given["AIWB_MCP_CONFIG_FILE"] != configFile {
		t.Fatalf("the adapter's variables are not the chat's: %v", given)
	}
	// The token is in the file only the user can read, and nowhere in what `ps` shows of pi.
	if got := readMCPFile(t, configFile); !strings.Contains(got, "Bearer "+env.token) {
		t.Fatalf("the chat's MCP config file does not hold its token: %q", got)
	}
	assertNoToken(t, env.token, p.cmd.Args, p.cmd.Env)
	ps, err := exec.Command("ps", "eww", fmt.Sprint(p.cmd.Process.Pid)).CombinedOutput()
	if err != nil || !strings.Contains(string(ps), "AIWB_CHAT_ID="+chatID) {
		t.Logf("ps eww does not show the start environment here (%v): nothing to check", err)
	} else if strings.Contains(string(ps), env.token) || strings.Contains(string(ps), "Bearer") {
		t.Fatalf("ps eww of the pi process shows the token: %q", ps)
	} else {
		t.Logf("ps eww of pi shows its start environment (%d bytes), with neither the token nor \"Bearer\"", len(ps))
	}

	e2eNoAppEnv(t, "new chat", p, given)
	out := e2eRPCBash(t, p, `cat "$AIWB_CHAT_DIR/chat.json" "$AIWB_MCP_CONFIG_FILE" 2>&1 </dev/null; echo "$AIWB_MCP_CONFIG"`)
	t.Logf(`cat "$AIWB_CHAT_DIR/chat.json" "$AIWB_MCP_CONFIG_FILE"; echo "$AIWB_MCP_CONFIG" prints %q`, out)
	if strings.Contains(out, env.token) {
		t.Fatalf("a shell command run by pi printed the chat's token: %q", out)
	}
	closeAndWaitExit(t, a)
}

// TestE2EForkKeepsGuard forks a real pi session the way the app does (the handshake's clone
// rebinds the process to the new session, and pi runs the extension's factory again, now with
// the variables gone) and checks that the fork still has everything the variables carried:
//   - the permission gate and the app-folder guard: a read of a file in the app's folder is
//     denied, and the file's content never reaches the stream;
//   - the board MCP tools (the config with the token is read at every session start);
//   - and that a command run by the model's bash tool sees none of the five variables.
func TestE2EForkKeepsGuard(t *testing.T) {
	e2eAgentDir(t)
	env := newE2EBoardEnv(t)
	env.setReply("E2E-BOARD-TEXT-42")
	s, cwd := e2eEnvSpawner(t, env)
	// No board prompt: it tells the model to leave the app's folder alone, and the model then
	// never tries the read the guard has to refuse. (So no AIWB_APPEND_PROMPT here; TestE2EShellEnv
	// covers it.)
	s.Prompt = ""
	const secret = "E2E-APPDIR-NOTE-9"
	statePath := filepath.Join(s.AppRoot, "notes.txt")
	if err := os.WriteFile(statePath, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	opts := func(chatID, sessionID string) agent.SpawnOptions {
		return agent.SpawnOptions{ChatID: chatID, SessionID: sessionID, Cwd: cwd,
			Model: e2eModel(), MCP: env.boardAccess(), BoardID: "b"}
	}

	const srcChat, srcSession = "A", "22222222-2222-4222-8222-222222222222"
	srcA, err := s.Spawn(opts(srcChat, srcSession))
	if err != nil {
		t.Skipf("pi could not start: %v", err)
	}
	defer srcA.Close()
	e2eReady(t, srcA)
	first := e2eSay(t, srcA, "Reply with only: ok", nil)
	if first.end.Point == "" {
		t.Fatal("the source's turn ended without a fork point")
	}

	const branch = srcChat + "/branches/b1"
	forkA, forkID, err := s.SpawnFork(opts(branch, ""), agent.ForkSource{ChatID: srcChat, SessionID: srcSession,
		Point: first.end.Point, End: true})
	if err != nil {
		t.Fatalf("SpawnFork at the end: %v", err)
	}
	defer forkA.Close()
	fork := forkA.(*proc)
	t.Logf("fork %s: session %s file %s", branch, forkID, fork.sessionFile)
	given := e2eGivenAppEnv(t, fork, "AIWB_BRIDGE_SOCKET", "AIWB_BRIDGE_RUN", "AIWB_MCP_CONFIG_FILE", "AIWB_CHAT_DIR")
	assertNoToken(t, env.token, fork.cmd.Args, fork.cmd.Env)

	// No model call: the fork's shell commands see none of the variables.
	e2eNoAppEnv(t, "after the fork", fork, given)

	// The gate and the guard: the adapter refuses the read, with the app-folder reason.
	var results []agent.Event
	pathIDs := map[string]bool{}
	r := e2eSay(t, forkA, fmt.Sprintf("Use the read tool to read the file %s and tell me what the tool returned.", statePath),
		func(ev agent.Event) {
			switch ev.Kind {
			case agent.EvPermRequest:
				t.Errorf("the fork raised a permission card: %+v", ev)
			case agent.EvToolStart, agent.EvToolInput:
				if strings.Contains(string(ev.Input), statePath) {
					pathIDs[ev.ToolID] = true
				}
			case agent.EvToolResult:
				results = append(results, ev)
			}
		})
	if len(pathIDs) == 0 {
		t.Skipf("the model never attempted to read the app-dir file; text %q", r.text)
	}
	denied := 0
	for _, ev := range results {
		if strings.Contains(ev.Result, secret) {
			t.Fatalf("after the fork a tool result leaked the app-dir file: %+v", ev)
		}
		if !pathIDs[ev.ToolID] {
			continue
		}
		if !ev.IsError || !strings.Contains(ev.Result, agent.AppDirDenied) {
			t.Fatalf("after the fork the app-dir read was not refused by the guard: %+v", ev)
		}
		denied++
		t.Logf("after the fork: the app-dir read is refused: isError=%v result=%q", ev.IsError, ev.Result)
	}
	if denied == 0 {
		t.Fatalf("no tool result arrived for the app-dir attempts %v", pathIDs)
	}
	if strings.Contains(r.text, secret) {
		t.Fatalf("after the fork the streamed text leaked the app-dir file: %q", r.text)
	}

	// The model's own bash tool, and the board tool: one turn for both.
	r = e2eSay(t, forkA, "Do these two things. First: use the bash tool to run exactly this command, unchanged: "+
		e2eEnvShell+` ; echo "SESSIONFILE[$PI_SESSION_FILE]"`+
		" . Second: call the tool named mcp__board__read_board with an empty object argument. Then reply with only: done", nil)
	t.Logf("fork bash and board turn: tools %v results %q", r.tools, r.results)
	all := strings.Join(r.results, "\n")
	if !contains(r.tools, "bash") || !strings.Contains(all, "COUNT[") {
		t.Skipf("the model did not run the bash command; tools %v text %q", r.tools, r.text)
	}
	if !strings.Contains(all, "APPENV[||||]") || !strings.Contains(all, "COUNT[0]") {
		t.Fatalf("the model's bash tool sees the app's variables after the fork: %q", all)
	}
	for name, value := range given {
		if name != "AIWB_CHAT_DIR" && strings.Contains(all, value) {
			t.Fatalf("the value of %s reached the model's bash tool: %q", name, all)
		}
	}
	if !contains(r.tools, "mcp__board__read_board") || !strings.Contains(all, "E2E-BOARD-TEXT-42") {
		t.Fatalf("the board tool did not work after the fork: tools %v results %q", r.tools, r.results)
	}
	closeAndWaitExit(t, forkA)
	closeAndWaitExit(t, srcA)
}
