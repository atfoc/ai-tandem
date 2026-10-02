package pibridge

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestProtocolNode runs the dependency-free protocol unit tests under Node's
// type stripping. Skipped when node is not installed.
func TestProtocolNode(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping node test in short mode")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	testPath, err := filepath.Abs(filepath.Join("extension", "test", "protocol.test.ts"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "--test", "--experimental-strip-types", testPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node --test failed: %v\n%s", err, out)
	}
	t.Logf("node --test:\n%s", out)
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
	if testing.Short() {
		t.Skip("skipping node test in short mode")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	testPath, err := filepath.Abs(filepath.Join("extension", "test", "mcp.test.ts"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "--test", "--experimental-strip-types", testPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node --test failed: %v\n%s", err, out)
	}
	t.Logf("node --test:\n%s", out)
}

// TestMCPWiringNode runs the dependency-free MCP wiring unit tests under
// Node's type stripping. Skipped when node is not installed.
func TestMCPWiringNode(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping node test in short mode")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	testPath, err := filepath.Abs(filepath.Join("extension", "test", "mcp-wiring.test.ts"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "--test", "--experimental-strip-types", testPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node --test failed: %v\n%s", err, out)
	}
	t.Logf("node --test:\n%s", out)
}

// TestPermissionsNode runs the permission-gate unit tests under Node's type
// stripping. Skipped when node is not installed.
func TestPermissionsNode(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping node test in short mode")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	testPath, err := filepath.Abs(filepath.Join("extension", "test", "permissions.test.ts"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "--test", "--experimental-strip-types", testPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node --test failed: %v\n%s", err, out)
	}
	t.Logf("node --test:\n%s", out)
}

// TestSubagentNode runs the subagent-tool unit tests under Node's type
// stripping. Skipped when node is not installed.
func TestSubagentNode(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping node test in short mode")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not available")
	}
	testPath, err := filepath.Abs(filepath.Join("extension", "test", "subagent.test.ts"))
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, "--test", "--experimental-strip-types", testPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node --test failed: %v\n%s", err, out)
	}
	t.Logf("node --test:\n%s", out)
}
