package headless

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakeMachine builds lookups over a folder: the server binary is root/exe, PATH holds only what is in
// onPath (name → path), and `--version` of a path answers versions[path].
type fakeMachine struct {
	exe      string
	onPath   map[string]string
	versions map[string]string
	env      map[string]string
	versRuns int
}

func (f *fakeMachine) lookups() lookups {
	l := systemLookups()
	l.Executable = func() (string, error) { return f.exe, nil }
	l.LookPath = func(name string) (string, error) {
		if p, ok := f.onPath[name]; ok {
			return p, nil
		}
		if filepath.IsAbs(name) {
			if _, err := os.Stat(name); err == nil {
				return name, nil
			}
		}
		return "", &exec.Error{Name: name, Err: exec.ErrNotFound}
	}
	l.Getenv = func(k string) string { return f.env[k] }
	l.NodeVer = func(p string) (string, error) {
		f.versRuns++
		v, ok := f.versions[p]
		if !ok {
			return "", errors.New("cannot run")
		}
		return v, nil
	}
	return l
}

func touch(t *testing.T, path string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// winMachine is a machine whose GOOS is "windows" and whose server is <app>/ai-whiteboard.exe.
func winMachine(app string) *fakeMachine {
	return &fakeMachine{
		exe:      filepath.Join(app, ServerProgramWindows),
		onPath:   map[string]string{"node": "/usr/bin/node"},
		versions: map[string]string{"/usr/bin/node": "v22.3.0"},
	}
}

func windowsLookups(m *fakeMachine) lookups {
	l := m.lookups()
	l.GOOS = "windows"
	return l
}

func TestFindRuntimeWindowsApp(t *testing.T) {
	t.Parallel()
	app := filepath.Join(t.TempDir(), "AI Whiteboard")
	electron := touch(t, filepath.Join(app, ElectronProgramWindows))
	m := winMachine(app)

	// Next to ai-whiteboard.exe: the app's Electron, before the PATH.
	if rt, err := findRuntime("", windowsLookups(m)); err != nil || rt.Path != electron || !rt.Electron || rt.Source != "electron" {
		t.Errorf("next to ai-whiteboard.exe: %+v, %v", rt, err)
	}
	// The name of the server binary is compared without regard to case, like Windows does.
	m.exe = filepath.Join(app, "AI-Whiteboard.EXE")
	if rt, err := findRuntime("", windowsLookups(m)); err != nil || rt.Path != electron || !rt.Electron {
		t.Errorf("a server named AI-Whiteboard.EXE: %+v, %v", rt, err)
	}
	// A server of another name, or without the program beside it, is not the app's.
	m.exe = filepath.Join(app, "other.exe")
	if rt, err := findRuntime("", windowsLookups(m)); err != nil || rt.Path != "/usr/bin/node" || rt.Electron || rt.Source != "path" {
		t.Errorf("a server of another name: %+v, %v", rt, err)
	}
	m.exe = filepath.Join(app, "server", ServerProgramWindows)
	if rt, err := findRuntime("", windowsLookups(m)); err != nil || rt.Path != "/usr/bin/node" || rt.Electron {
		t.Errorf("a server in a folder without the program: %+v, %v", rt, err)
	}
	// The flag still wins.
	m.exe = filepath.Join(app, ServerProgramWindows)
	flagNode := touch(t, filepath.Join(app, "mynode.exe"))
	if rt, err := findRuntime(flagNode, windowsLookups(m)); err != nil || rt.Path != flagNode || rt.Electron || rt.Source != "flag" {
		t.Errorf("with the flag: %+v, %v", rt, err)
	}
	// Not the Mac's rule: the same layout on another system is not the Windows app.
	l := m.lookups()
	l.GOOS = "linux"
	if rt, err := findRuntime("", l); err != nil || rt.Electron {
		t.Errorf("the Windows layout on linux: %+v, %v", rt, err)
	}
	// The app without its program falls back to the PATH and says why.
	os.Remove(electron)
	m.onPath = nil
	if _, err := findRuntime("", windowsLookups(m)); err == nil || !strings.Contains(err.Error(), ElectronProgramWindows) {
		t.Errorf("the app without its program and without node: %v, want an error naming %s", err, ElectronProgramWindows)
	}
}

func TestFindBundleWindowsApp(t *testing.T) {
	t.Parallel()
	app := filepath.Join(t.TempDir(), "AI Whiteboard")
	l := windowsLookups(winMachine(app))
	res := filepath.Join(app, "resources", "headless")

	if _, err := findBundle("", "dev", l); err == nil || !strings.Contains(err.Error(), res) {
		t.Fatalf("without a bundle: %v, want an error naming %s", err, res)
	}
	writeBundle(t, res, "1.0.0", "x")
	if b, err := findBundle("", "1.0.0", l); err != nil || b.Dir != res || b.Program != filepath.Join(res, BundleFile) {
		t.Fatalf("resources/headless beside the server: %+v, %v", b, err)
	}
	// The two places that were there first keep their order, ahead of resources/headless.
	beside := filepath.Join(app, "headless")
	writeBundle(t, beside, "1.0.0", "x")
	if b, err := findBundle("", "1.0.0", l); err != nil || b.Dir != beside {
		t.Fatalf("with headless beside the server too: %+v, %v", b, err)
	}
	macRes := filepath.Join(app, "..", "Resources", "headless")
	writeBundle(t, macRes, "1.0.0", "x")
	if b, err := findBundle("", "1.0.0", l); err != nil || b.Dir != filepath.Clean(macRes) {
		t.Fatalf("with ../Resources/headless too: %+v, %v", b, err)
	}
	// A bundle of another version is skipped for the next place.
	if err := os.RemoveAll(macRes); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(beside); err != nil {
		t.Fatal(err)
	}
	if _, err := findBundle("", "2.0.0", l); err == nil || !strings.Contains(err.Error(), `"1.0.0"`) {
		t.Fatalf("another version in resources/headless: %v", err)
	}
}

// resources/headless is the Windows app's place only: on macOS and Linux the candidates are the two
// that were there first, and the error names only those.
func TestFindBundleResourcesOnlyOnWindows(t *testing.T) {
	t.Parallel()
	for _, goos := range []string{"darwin", "linux"} {
		app := filepath.Join(t.TempDir(), "AI Whiteboard")
		m := winMachine(app)
		l := m.lookups()
		l.GOOS = goos
		res := filepath.Join(app, "resources", "headless")
		writeBundle(t, res, "1.0.0", "x")
		_, err := findBundle("", "1.0.0", l)
		if err == nil {
			t.Fatalf("%s: a bundle in resources/headless was used", goos)
		}
		for _, want := range []string{
			filepath.Join(app, "..", "Resources", "headless", BundleFile),
			filepath.Join(app, "headless", BundleFile),
		} {
			if !strings.Contains(err.Error(), filepath.Clean(want)) {
				t.Errorf("%s: error %q does not name %s", goos, err, want)
			}
		}
		if strings.Contains(err.Error(), "resources") {
			t.Errorf("%s: error %q names resources/headless", goos, err)
		}
		if n := strings.Count(err.Error(), "; ") + 1; n != 2 {
			t.Errorf("%s: error %q has %d reasons, want 2", goos, err, n)
		}
	}
}
