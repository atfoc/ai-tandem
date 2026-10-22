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
func FakeClaude(t testing.TB) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-claude")
	if err := os.WriteFile(path, fakeClaude, 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}
