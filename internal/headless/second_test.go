//go:build !windows

package headless

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The board host's names (design 1.3): a second manager with these finds its own bundle and Node, and says
// its own name.
var boardHostOptions = Options{Program: "boardhost.mjs", Folder: "boardhost", Name: "board host", NodeEnv: "AIWB_BOARDHOST_NODE"}

var boardHostNaming = naming{Program: "boardhost.mjs", Folder: "boardhost", Name: "board host", NodeEnv: "AIWB_BOARDHOST_NODE"}

// writeBundleAs writes a bundle folder whose program is named program.
func writeBundleAs(t *testing.T, dir, program, version, body string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, program), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	mf, _ := json.Marshal(Manifest{Version: version, OS: "darwin", Arch: "arm64"})
	if err := os.WriteFile(filepath.Join(dir, ManifestFile), mf, 0o644); err != nil {
		t.Fatal(err)
	}
}

// The board host's bundle is found in the same order as the headless writer's, in its own folder, with its own
// program; a headless/ folder (or a boardhost/ folder that holds only headless.mjs) is not it.
func TestFindBundleBoardHost(t *testing.T) {
	t.Parallel()
	n := boardHostNaming
	root := t.TempDir()
	macos := filepath.Join(root, "App.app", "Contents", "MacOS")
	l := (&fakeMachine{exe: filepath.Join(macos, "ai-whiteboard")}).lookups()

	// The headless writer's folders are not the board host's.
	writeBundle(t, filepath.Join(macos, "..", "Resources", "headless"), "dev", "x")
	writeBundle(t, filepath.Join(macos, "headless"), "dev", "x")
	writeBundle(t, filepath.Join(macos, "boardhost"), "dev", "x") // headless.mjs in boardhost/
	_, err := findBundleAs("", "dev", n, l)
	if err == nil || !strings.Contains(err.Error(), "no board host is installed") ||
		!strings.Contains(err.Error(), filepath.Join(macos, "boardhost", "boardhost.mjs")) {
		t.Fatalf("with only the headless writer's bundles: %v, want no board host, boardhost.mjs missing", err)
	}

	// Next to the binary.
	beside := filepath.Join(macos, "boardhost")
	writeBundleAs(t, beside, "boardhost.mjs", "1.0.0", "x")
	if b, err := findBundleAs("", "1.0.0", n, l); err != nil || b.Dir != beside || b.Program != filepath.Join(beside, "boardhost.mjs") {
		t.Fatalf("boardhost beside the binary: %+v, %v", b, err)
	}
	// ../Resources/boardhost comes first.
	res := filepath.Join(macos, "..", "Resources", "boardhost")
	writeBundleAs(t, res, "boardhost.mjs", "1.0.0", "x")
	if b, err := findBundleAs("", "1.0.0", n, l); err != nil || b.Dir != filepath.Clean(res) {
		t.Fatalf("with ../Resources/boardhost too: %+v, %v", b, err)
	}
	// The manifest's version is checked the same way: another version is skipped for the next place.
	writeBundleAs(t, res, "boardhost.mjs", "0.9.0", "x")
	if b, err := findBundleAs("", "1.0.0", n, l); err != nil || b.Dir != beside {
		t.Fatalf("../Resources/boardhost of another version: %+v, %v", b, err)
	}
	if b, err := findBundleAs("", "dev", n, l); err != nil || b.Dir != filepath.Clean(res) {
		t.Fatalf("a dev server takes any version: %+v, %v", b, err)
	}

	// The flag's folder, and then nothing else; its error names the board host's flag.
	given := filepath.Join(root, "given")
	writeBundleAs(t, given, "boardhost.mjs", "dev", "x")
	if b, err := findBundleAs(given, "dev", n, l); err != nil || b.Dir != given || b.Program != filepath.Join(given, "boardhost.mjs") {
		t.Fatalf("the flag: %+v, %v", b, err)
	}
	headlessOnly := filepath.Join(root, "headless-only")
	writeBundle(t, headlessOnly, "dev", "x")
	if _, err := findBundleAs(headlessOnly, "dev", n, l); err == nil ||
		!strings.Contains(err.Error(), "the boardhost folder given with -boardhost-dir") || !strings.Contains(err.Error(), "boardhost.mjs is missing") {
		t.Fatalf("a flag folder with only headless.mjs: %v", err)
	}

	// On Windows, resources/boardhost after the other two.
	app := filepath.Join(t.TempDir(), "AI Whiteboard")
	wl := windowsLookups(winMachine(app))
	winRes := filepath.Join(app, "resources", "boardhost")
	writeBundle(t, filepath.Join(app, "resources", "headless"), "1.0.0", "x")
	if _, err := findBundleAs("", "1.0.0", n, wl); err == nil || !strings.Contains(err.Error(), winRes) {
		t.Fatalf("Windows, only resources/headless: %v, want an error naming %s", err, winRes)
	}
	writeBundleAs(t, winRes, "boardhost.mjs", "1.0.0", "x")
	if b, err := findBundleAs("", "1.0.0", n, wl); err != nil || b.Dir != winRes {
		t.Fatalf("Windows, resources/boardhost: %+v, %v", b, err)
	}
	// Not on another system.
	ml := (&fakeMachine{exe: filepath.Join(app, ServerProgramWindows)}).lookups()
	ml.GOOS = "darwin"
	if _, err := findBundleAs("", "1.0.0", n, ml); err == nil {
		t.Fatalf("resources/boardhost used outside Windows")
	}
}

// The board host's Node: the flag, then its own variable (not the headless writer's), then the same lookups.
func TestFindRuntimeBoardHost(t *testing.T) {
	t.Parallel()
	n := boardHostNaming
	root := t.TempDir()
	envNode := touch(t, filepath.Join(root, "envnode"))
	headlessNode := touch(t, filepath.Join(root, "headlessnode"))
	m := &fakeMachine{
		exe:      filepath.Join(root, "ai-whiteboard"),
		onPath:   map[string]string{"node": "/usr/bin/node"},
		versions: map[string]string{"/usr/bin/node": "v22.3.0"},
		env:      map[string]string{NodeEnv: headlessNode},
	}
	if rt, err := findRuntimeAs("", n, m.lookups()); err != nil || rt.Path != "/usr/bin/node" || rt.Source != "path" {
		t.Errorf("with only AIWB_HEADLESS_NODE: %+v, %v, want node on the PATH", rt, err)
	}
	m.env["AIWB_BOARDHOST_NODE"] = envNode
	if rt, err := findRuntimeAs("", n, m.lookups()); err != nil || rt.Path != envNode || rt.Source != "flag" {
		t.Errorf("with AIWB_BOARDHOST_NODE: %+v, %v", rt, err)
	}
	if _, err := findRuntimeAs(filepath.Join(root, "nothing"), n, m.lookups()); err == nil || !strings.Contains(err.Error(), "-boardhost-node") {
		t.Errorf("a flag that names nothing: %v, want an error naming -boardhost-node", err)
	}
	m.env, m.onPath = nil, map[string]string{}
	if _, err := findRuntimeAs("", n, m.lookups()); err == nil || !strings.Contains(err.Error(), "give one with -boardhost-node") {
		t.Errorf("no Node: %v, want an error naming -boardhost-node", err)
	}
}

// One start of the stand-in as the board host: it runs boardhost.mjs, gets the same configuration line, and the
// manager's log lines and reasons say "board host".
func TestBoardHostStart(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "boardhost")
	writeBundleAs(t, dir, "boardhost.mjs", "dev", standIn)
	o := boardHostOptions
	o.Dir = dir
	r := newRig(t, o)
	id := ensure(t, r)
	if c := r.config(); c.ClientID != id || c.Address != "127.0.0.1:4747" {
		t.Fatalf("configuration line = %+v, want the client id %s", c, id)
	}
	if args, _ := os.ReadFile(filepath.Join(r.out, "args")); !strings.Contains(string(args), filepath.Join(dir, "boardhost.mjs")) {
		t.Errorf("the process was started as %q, want it to run boardhost.mjs", args)
	}
	if r.logs.count("board host: started") != 1 || r.logs.count("headless writer") != 0 {
		t.Errorf("log lines %q, want one \"board host: started\" and no \"headless writer\"", r.logs.all())
	}
	if st := r.m.Status(); !st.Running || st.PID == 0 {
		t.Errorf("Status = %+v, want running", st)
	}
	r.m.Close()
	_, err := r.m.Ensure(context.Background())
	if !errors.Is(err, ErrUnavailable) || err.Error() != "the board host is not available: the server is stopping" {
		t.Fatalf("Ensure after Close = %q, want ErrUnavailable in the board host's words", err)
	}
}

// A board host that cannot start: the reason, the error and the log line say "board host", errors.Is still
// finds ErrUnavailable, and Status strips the prefix as it does for the headless writer. Nothing is started.
func TestBoardHostUnavailable(t *testing.T) {
	t.Parallel()
	o := boardHostOptions
	o.Node = "/nonexistent/node"
	r := newRig(t, o)
	_, err := r.m.Ensure(context.Background())
	if !errors.Is(err, ErrUnavailable) || !strings.HasPrefix(err.Error(), "the board host is not available: the Node given with -boardhost-node") {
		t.Fatalf("Ensure = %q, want ErrUnavailable in the board host's words", err)
	}
	if st := r.m.Status(); st.Available || !strings.HasPrefix(st.Reason, "the Node given with -boardhost-node") {
		t.Errorf("Status = %+v, want the reason without the prefix", st)
	}
	if r.logs.count("board host: not started") != 1 {
		t.Errorf("log lines %q, want one \"board host: not started\"", r.logs.all())
	}
	if len(r.starts()) != 0 {
		t.Errorf("a process was started")
	}
}

// The process's own lines are prefixed with the folder's name: "headless:" by default, "boardhost:" for the
// board host.
func TestTailPrefix(t *testing.T) {
	t.Parallel()
	for prefix, want := range map[string]string{"": "headless: hello", "headless": "headless: hello", "boardhost": "boardhost: hello"} {
		logs := &logSink{}
		tl := &tail{logf: logs.logf, prefix: prefix}
		tl.Write([]byte("hello\n"))
		if got := logs.all(); len(got) != 1 || got[0] != want {
			t.Errorf("prefix %q: %q, want %q", prefix, got, want)
		}
	}
}

// Empty names are today's: the defaults, and the words a person or agent reads.
func TestDefaultNames(t *testing.T) {
	t.Parallel()
	logs := &logSink{}
	m := New(&fakeBridge{dropped: map[string]bool{}}, Listener{Secret: func() string { return "" }}, Options{Logf: logs.logf})
	defer m.Close()
	if m.o.Program != "headless.mjs" || m.o.Folder != "headless" || m.o.Name != "headless writer" || m.o.NodeEnv != "AIWB_HEADLESS_NODE" {
		t.Fatalf("defaults = %q %q %q %q", m.o.Program, m.o.Folder, m.o.Name, m.o.NodeEnv)
	}
	if m.unavail != ErrUnavailable || m.names != defaultNaming {
		t.Fatalf("the default manager's error or names are not today's: %v, %+v", m.unavail, m.names)
	}
	// A machine with Node and no bundle.
	m.look = (&fakeMachine{
		exe:      filepath.Join(t.TempDir(), "ai-whiteboard"),
		onPath:   map[string]string{"node": "/usr/bin/node"},
		versions: map[string]string{"/usr/bin/node": "v22.3.0"},
	}).lookups()
	if st := m.Status(); st.Available || !strings.HasPrefix(st.Reason, "no headless writer is installed with this server") {
		t.Errorf("Status = %+v, want \"no headless writer is installed\"", st)
	}
	_, err := m.Ensure(context.Background())
	if !errors.Is(err, ErrUnavailable) || !strings.HasPrefix(err.Error(), "the headless writer is not available: no headless writer is installed") {
		t.Errorf("Ensure = %q", err)
	}
	if logs.count("headless writer: not started: no headless writer is installed") != 1 {
		t.Errorf("log lines %q", logs.all())
	}
}
