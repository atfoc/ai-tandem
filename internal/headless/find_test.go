//go:build !windows

package headless

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"ai-whiteboard/internal/testset"
)

func TestFindRuntimeOrder(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	macos := filepath.Join(root, "AI Whiteboard.app", "Contents", "MacOS")
	electron := touch(t, filepath.Join(macos, ElectronProgram))
	flagNode := touch(t, filepath.Join(root, "mynode"))
	envNode := touch(t, filepath.Join(root, "envnode"))
	m := &fakeMachine{
		exe:      filepath.Join(macos, "ai-whiteboard"),
		onPath:   map[string]string{"node": "/usr/bin/node"},
		versions: map[string]string{"/usr/bin/node": "v22.3.0"},
		env:      map[string]string{NodeEnv: envNode},
	}
	l := m.lookups()

	// 1. The flag wins over everything, and its program is not asked for a version.
	if rt, err := findRuntime(flagNode, l); err != nil || rt.Path != flagNode || rt.Electron || rt.Source != "flag" {
		t.Errorf("with the flag: %+v, %v", rt, err)
	}
	if m.versRuns != 0 {
		t.Errorf("the flag's program was asked for its version")
	}
	// ... then the environment variable.
	if rt, err := findRuntime("", l); err != nil || rt.Path != envNode || rt.Source != "flag" {
		t.Errorf("with the variable: %+v, %v", rt, err)
	}
	// A flag that names nothing is an error, not a fall through to the next.
	if _, err := findRuntime(filepath.Join(root, "nothing"), l); err == nil || !strings.Contains(err.Error(), "-headless-node") {
		t.Errorf("with a flag that names nothing: %v, want an error naming the flag", err)
	}
	m.env = nil
	l = m.lookups()
	// 2. The app's Electron, with ELECTRON_RUN_AS_NODE, before the PATH.
	if rt, err := findRuntime("", l); err != nil || rt.Path != electron || !rt.Electron || rt.Source != "electron" {
		t.Errorf("next to …/Contents/MacOS/ai-whiteboard: %+v, %v", rt, err)
	}
	// Not the app's Electron when the binary is elsewhere in the app, or when the program is missing.
	m.exe = filepath.Join(root, "server", "ai-whiteboard")
	if rt, err := findRuntime("", m.lookups()); err != nil || rt.Path != "/usr/bin/node" || rt.Electron || rt.Source != "path" {
		t.Errorf("a server folder: %+v, %v", rt, err)
	}
	os.Remove(electron)
	m.exe = filepath.Join(macos, "ai-whiteboard")
	if rt, err := findRuntime("", m.lookups()); err != nil || rt.Path != "/usr/bin/node" {
		t.Errorf("the app without its program: %+v, %v", rt, err)
	}
}

func TestFindRuntimeNodeOnPath(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	for _, c := range []struct {
		name, version, want string // want: "" for success, else a part of the error
		noNode              bool
	}{
		{name: "22", version: "v22.0.0"},
		{name: "newer", version: "v24.3.0"},
		{name: "older", version: "v20.11.1", want: "version 22 or later"},
		{name: "much older", version: "v8.0.0", want: "version 22 or later"},
		{name: "garbage", version: "hello", want: "not understood"},
		{name: "none", noNode: true, want: "-headless-node"},
	} {
		m := &fakeMachine{exe: filepath.Join(root, "ai-whiteboard"), onPath: map[string]string{}, versions: map[string]string{}}
		if !c.noNode {
			m.onPath["node"] = "/usr/local/bin/node"
			m.versions["/usr/local/bin/node"] = c.version
		}
		rt, err := findRuntime("", m.lookups())
		switch {
		case c.want == "" && (err != nil || rt.Path != "/usr/local/bin/node"):
			t.Errorf("%s: %+v, %v", c.name, rt, err)
		case c.want != "" && (err == nil || !strings.Contains(err.Error(), c.want)):
			t.Errorf("%s: %+v, %v, want an error with %q", c.name, rt, err, c.want)
		}
	}
	// `node --version` that fails.
	m := &fakeMachine{exe: filepath.Join(root, "ai-whiteboard"), onPath: map[string]string{"node": "/x/node"}}
	if _, err := findRuntime("", m.lookups()); err == nil || !strings.Contains(err.Error(), "does not tell its version") {
		t.Errorf("a node that cannot run: %v", err)
	}
}

func TestNodeMajor(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]int{"v22.3.0": 22, "22.0.0": 22, "v100.1.2\n": 100, "v9.11.2": 9} {
		if got, ok := nodeMajor(in); !ok || got != want {
			t.Errorf("nodeMajor(%q) = %d, %v, want %d", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "node", "vx.1"} {
		if _, ok := nodeMajor(in); ok {
			t.Errorf("nodeMajor(%q) understood", in)
		}
	}
}

func TestFindBundle(t *testing.T) {
	t.Parallel()
	mk := func(t *testing.T) (root, macos, server string, l lookups) {
		root = t.TempDir()
		macos = filepath.Join(root, "App.app", "Contents", "MacOS")
		server = filepath.Join(root, "server")
		m := &fakeMachine{exe: filepath.Join(macos, "ai-whiteboard")}
		return root, macos, server, m.lookups()
	}
	t.Run("the flag", func(t *testing.T) {
		t.Parallel()
		root, macos, _, l := mk(t)
		flagDir := filepath.Join(root, "given")
		writeBundle(t, flagDir, "dev", "x")
		writeBundle(t, filepath.Join(macos, "..", "Resources", "headless"), "dev", "x")
		b, err := findBundle(flagDir, "dev", l)
		if err != nil || b.Dir != flagDir || b.Program != filepath.Join(flagDir, BundleFile) {
			t.Fatalf("%+v, %v", b, err)
		}
		// A flag that does not hold a bundle does not fall through to the app's.
		if _, err := findBundle(filepath.Join(root, "nothing"), "dev", l); err == nil || !strings.Contains(err.Error(), "-headless-dir") {
			t.Errorf("with a bad flag: %v, want an error naming the flag", err)
		}
	})
	t.Run("Resources, then next to the binary", func(t *testing.T) {
		t.Parallel()
		_, macos, _, l := mk(t)
		beside := filepath.Join(macos, "headless")
		writeBundle(t, beside, "dev", "x")
		if b, err := findBundle("", "dev", l); err != nil || b.Dir != beside {
			t.Fatalf("beside the binary: %+v, %v", b, err)
		}
		res := filepath.Join(macos, "..", "Resources", "headless")
		writeBundle(t, res, "dev", "x")
		if b, err := findBundle("", "dev", l); err != nil || b.Dir != filepath.Clean(res) {
			t.Fatalf("with Resources too: %+v, %v", b, err)
		}
	})
	t.Run("version", func(t *testing.T) {
		t.Parallel()
		_, macos, _, l := mk(t)
		res := filepath.Join(macos, "..", "Resources", "headless")
		beside := filepath.Join(macos, "headless")
		writeBundle(t, res, "1.0.0", "x")
		// The same version: used. Another: not, and the error says both versions.
		if _, err := findBundle("", "1.0.0", l); err != nil {
			t.Fatalf("the same version: %v", err)
		}
		_, err := findBundle("", "1.1.0", l)
		if err == nil || !strings.Contains(err.Error(), `"1.0.0"`) || !strings.Contains(err.Error(), `"1.1.0"`) {
			t.Fatalf("another version: %v, want an error with both versions", err)
		}
		// A bundle of another version is skipped for the next place.
		writeBundle(t, beside, "1.1.0", "x")
		if b, err := findBundle("", "1.1.0", l); err != nil || b.Dir != beside {
			t.Fatalf("falls through to the next place: %+v, %v", b, err)
		}
		// "dev" takes any.
		if b, err := findBundle("", "dev", l); err != nil || b.Dir != filepath.Clean(res) {
			t.Fatalf("a dev server: %+v, %v", b, err)
		}
	})
	t.Run("broken", func(t *testing.T) {
		t.Parallel()
		root, _, _, l := mk(t)
		d := filepath.Join(root, "b")
		writeBundle(t, d, "dev", "x")
		os.Remove(filepath.Join(d, ManifestFile))
		if _, err := findBundle(d, "dev", l); err == nil || !strings.Contains(err.Error(), ManifestFile) {
			t.Errorf("no manifest: %v", err)
		}
		touch(t, filepath.Join(d, ManifestFile))
		if _, err := findBundle(d, "dev", l); err == nil || !strings.Contains(err.Error(), "not valid") {
			t.Errorf("a manifest that is not JSON: %v", err)
		}
		os.Remove(filepath.Join(d, BundleFile))
		if _, err := findBundle(d, "dev", l); err == nil || !strings.Contains(err.Error(), BundleFile) {
			t.Errorf("no program: %v", err)
		}
		if _, err := findBundle("", "dev", l); err == nil || !strings.Contains(err.Error(), "no headless writer is installed") {
			t.Errorf("nowhere: %v", err)
		}
	})
}

// The real thing: the real `node --version`, and a real Node running a stand-in program, started through the
// same code as the server's. Full set: it needs Node 22 on the machine.
func TestRealNode(t *testing.T) {
	testset.SkipUnlessFull(t, "needs Node 22 or later installed; TestConfigLineAndLife covers the same start with a shell")
	path, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	v, err := nodeVersion(path)
	if err != nil {
		t.Fatalf("node --version: %v", err)
	}
	if major, ok := nodeMajor(v); !ok || major < MinNodeMajor {
		t.Skipf("node is %s, %d or later is needed", v, MinNodeMajor)
	}
	r := newRig(t, Options{Node: path})
	writeBundle(t, r.bundle, "dev", `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const out = process.env.STANDIN_OUT;
const rl = createInterface({ input: process.stdin });
rl.once("line", (line) => {
  writeFileSync(out + "/config", line + "\n");
  writeFileSync(out + "/connected." + JSON.parse(line).clientId, "");
});
process.stdin.on("end", () => { writeFileSync(out + "/exits", "saved\n"); process.exit(0); });
process.stdin.resume();
`)
	if st := r.m.Status(); !st.Available {
		t.Fatalf("Status = %+v", st)
	}
	id := ensure(t, r)
	if c := r.config(); c.ClientID != id || c.Secret != "s3cret-value" {
		t.Fatalf("configuration = %+v", c)
	}
	r.m.Close()
	if b, _ := os.ReadFile(filepath.Join(r.out, "exits")); string(b) != "saved\n" {
		t.Errorf("node did not end on its stdin closing: %q", b)
	}
	// And the default lookup finds the Node on the PATH, with the Node's own version check.
	m := New(r.b, Listener{Secret: func() string { return "s" }}, Options{Dir: r.bundle, Env: []string{"STANDIN_OUT=" + r.out}, Logf: func(string, ...any) {}})
	defer m.Close()
	if _, err := m.Ensure(context.Background()); err != nil {
		t.Fatalf("Ensure with the default lookup: %v", err)
	}
}
