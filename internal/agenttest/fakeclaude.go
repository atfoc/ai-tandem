package agenttest

import (
	_ "embed"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

//go:embed fake-claude
var fakeClaude []byte

// HasNode reports whether node is on PATH. The fake claude is a Node script: a test that uses
// FakeClaude skips when this is false.
func HasNode() bool {
	_, err := exec.LookPath("node")
	return err == nil
}

// FakeClaude writes an executable copy of the scripted stand-in for the claude program into
// t.TempDir() and returns its path, to give a server as its claude binary. What it answers is
// decided by directives in the message it gets; the head of the script (fake-claude in this
// package) lists them: [[sleep n]], <<sleep n>>, [[mcp TOOL {json}]], [[tools]], [[final TEXT]],
// [[write PATH TEXT]], [[ask TOOL {json}]], [[fail text]], [[exit n]], [[cost usd]], [[if TEXT]], and
// [[bg SECONDS]] (a real detached `sleep` announced as a background command, which ends with a turn the
// process begins by itself) with [[leave]] (the process exits after the turn, leaving the command) and
// [[bglate SECONDS]] (the same, but the shell is started only after the announcement and the file
// $FAKE_CLAUDE_BG_GATE). The file $FAKE_CLAUDE_BGPIDS, when set, gets the pid of each such command's
// shell, and a process that leaves waits for the file $FAKE_CLAUDE_LEAVE_GATE to exist, when that is
// set. $FAKE_CLAUDE_LOG gets {"turn":"self"} when a turn begins after stdin has closed.
// $FAKE_CLAUDE_MCP_HOST_MAP ("host.docker.internal=127.0.0.1", comma-separated pairs) rewrites the
// host of the --mcp-config URL before the fake calls it, for a stand-in docker that runs it on the host.
//
// It answers `auth status | logout | login` as Claude Code 2.1 does, with the login of an account
// in $CLAUDE_CONFIG_DIR/fake-login.json: status prints JSON (exit 1 when logged out; with
// $CLAUDE_CONFIG_DIR unset it is signed in as fake@example.com, exit 0; $FAKE_CLAUDE_AUTH=garbled
// or =slow), logout removes the file, login prints a URL and "Paste code here if prompted > " and
// reads codes: the good one ($FAKE_CLAUDE_LOGIN_CODE, default "good#code") writes the file
// ($FAKE_CLAUDE_LOGIN_EMAIL) and exits 0, one without "#" is refused and another read, any other
// fails the login (exit 1). $FAKE_CLAUDE_LOGIN_ANSI=1 writes as in a terminal (CSI, OSC 8 link,
// \r\n), $FAKE_CLAUDE_LOGIN_WRAP=<n> breaks the URL's line at column n, $FAKE_CLAUDE_LOGIN_STATE
// fixes the URL's state.
func FakeClaude(t testing.TB) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-claude")
	if err := os.WriteFile(path, fakeClaude, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
