package pibridge

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/testset"
)

// runNodeTest runs one file of the extension's unit tests under Node's type stripping, in parallel
// with the other tests: the files share nothing. The file is run as a program, which runs its
// tests like node --test does, without the second node process that --test starts for the file.
// Skipped when node is not installed.
func runNodeTest(t *testing.T, file string) {
	t.Helper()
	runNodeTestEnv(t, file)
}

// runNodeTestEnv is runNodeTest with variables added to the environment of the node process, each
// as "NAME=value". It returns what the file printed.
func runNodeTestEnv(t *testing.T, file string, env ...string) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	t.Parallel()
	testPath, err := filepath.Abs(filepath.Join("extension", "test", file))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "--experimental-strip-types", testPath)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node test failed: %v\n%s", err, out)
	}
	t.Logf("node test:\n%s", out)
	return string(out)
}

// TestProtocolNode runs the dependency-free protocol unit tests under Node's
// type stripping. Skipped when node is not installed.
func TestProtocolNode(t *testing.T) {
	runNodeTest(t, "protocol.test.ts")
}

func TestMaterializeExtension(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pi-extension")
	index, err := MaterializeExtension(dir)
	if err != nil {
		t.Fatalf("MaterializeExtension: %v", err)
	}
	if !filepath.IsAbs(index) {
		t.Fatalf("index path %q is not absolute", index)
	}
	if index != filepath.Join(dir, "index.ts") {
		t.Fatalf("index path = %q, want %q", index, filepath.Join(dir, "index.ts"))
	}

	want, err := extensionFS.ReadFile("extension/index.ts")
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(index)
	if err != nil {
		t.Fatalf("read materialized index.ts: %v", err)
	}
	if string(got) != string(want) {
		t.Fatal("materialized index.ts differs from the embedded asset")
	}

	for _, rel := range []string{"index.ts", "protocol.ts", "mcp.ts", "mcp-wiring.ts", "permissions.ts", "subagent.ts", "test/protocol.test.ts", "test/mcp.test.ts", "test/mcp-wiring.test.ts"} {
		p := filepath.Join(dir, rel)
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatalf("missing materialized %s: %v", rel, err)
		}
		if got := fi.Mode().Perm(); got != 0o600 {
			t.Fatalf("%s mode = %o, want 600", rel, got)
		}
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := di.Mode().Perm(); got != 0o700 {
		t.Fatalf("dir mode = %o, want 700", got)
	}

	// A second materialization is idempotent (identical content is skipped).
	again, err := MaterializeExtension(dir)
	if err != nil {
		t.Fatalf("second MaterializeExtension: %v", err)
	}
	if again != index {
		t.Fatalf("second index path = %q, want %q", again, index)
	}
}

// TestMCPNode runs the dependency-free MCP client unit tests under Node's type
// stripping. Skipped when node is not installed.
func TestMCPNode(t *testing.T) {
	runNodeTest(t, "mcp.test.ts")
}

// TestMCPWiringNode runs the dependency-free MCP wiring unit tests under
// Node's type stripping. Skipped when node is not installed.
func TestMCPWiringNode(t *testing.T) {
	runNodeTest(t, "mcp-wiring.test.ts")
}

// TestPermissionsNode runs the permission-gate unit tests under Node's type
// stripping. Skipped when node is not installed.
func TestPermissionsNode(t *testing.T) {
	runNodeTest(t, "permissions.test.ts")
}

// TestSubagentNode runs the subagent-tool unit tests under Node's type
// stripping. Skipped when node is not installed.
//
// All of them start some thirty node processes, so the default set runs a few: the file itself
// thins them (its defaultTest), and it is told here which set runs, not by the variable of this
// process, so that -short gives the default set there too. The file prints which set it ran and
// how many of its tests; a run of the wrong set fails.
func TestSubagentNode(t *testing.T) {
	full, want := "0", "subagent.test.ts: default set, running "
	if testset.Full() {
		full, want = "1", "subagent.test.ts: full set, running all "
	}
	out := runNodeTestEnv(t, "subagent.test.ts", testset.Env+"="+full)
	if !strings.Contains(out, want) {
		t.Fatalf("the node test did not run the set it was told to: its output has no %q", want)
	}
}
