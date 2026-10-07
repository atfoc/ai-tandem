package remote

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// snapshot is the folder as a test compares it: per file its mode, size, modification time and,
// when it can be read, a hash of its content.
func snapshot(t *testing.T, dir string) map[string]string {
	t.Helper()
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	snap := map[string]string{}
	for _, e := range ents {
		fi, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		s := fmt.Sprintf("%v %d %d", fi.Mode(), fi.Size(), fi.ModTime().UnixNano())
		if b, err := os.ReadFile(filepath.Join(dir, e.Name())); err == nil {
			s += fmt.Sprintf(" %x", sha256.Sum256(b))
		}
		snap[e.Name()] = s
	}
	return snap
}

func sameFolder(t *testing.T, dir string, before map[string]string) {
	t.Helper()
	if after := snapshot(t, dir); !reflect.DeepEqual(before, after) {
		t.Errorf("the folder changed:\nbefore %v\nafter  %v", before, after)
	}
}

func write(t *testing.T, path, content string, perm os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), perm); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, perm); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(path, 0o600) }) // so that t.TempDir can remove a mode-000 file's folder
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// setUp is a first set-up with one name and the default port.
func setUp(t *testing.T) (root string, f Files) {
	t.Helper()
	root = t.TempDir()
	if _, err := Setup(root, SetupOptions{Names: []string{"wb.example"}}); err != nil {
		t.Fatal(err)
	}
	return root, FilesIn(root)
}

func TestFilesIn(t *testing.T) {
	want := Files{"/r/remote.json", "/r/remote-secret", "/r/remote-key.pem", "/r/remote-cert.pem", "/r/instance-id"}
	if got := FilesIn("/r"); got != want {
		t.Errorf("FilesIn = %+v", got)
	}
}

func TestNormalName(t *testing.T) {
	for in, want := range map[string]string{
		"Mac.local": "mac.local", "192.168.1.20": "192.168.1.20", "my-host": "my-host", "127.0.0.1": "127.0.0.1",
	} {
		if got, ok := NormalName(in); !ok || got != want {
			t.Errorf("NormalName(%q) = %q, %v", in, got, ok)
		}
	}
	for _, in := range []string{"", "a:4748", "https://a", "::1", "a b", "a_b", "a/b", ".a", "a.", "-a", "a..b", strings.Repeat("a", 254)} {
		if got, ok := NormalName(in); ok {
			t.Errorf("NormalName(%q) = %q, want not a name", in, got)
		}
	}
}

func TestLoadConfig(t *testing.T) {
	root := t.TempDir()
	if c, found, err := LoadConfig(root); found || err != nil || c.Port != 0 {
		t.Fatalf("no file: %+v %v %v", c, found, err)
	}
	f := FilesIn(root)
	write(t, f.Config, `{"port": 5000, "names": ["Mac.local", "10.0.0.2"], "later": true}`, 0o600)
	c, found, err := LoadConfig(root)
	if !found || err != nil || c.Port != 5000 || !reflect.DeepEqual(c.Names, []string{"mac.local", "10.0.0.2"}) {
		t.Fatalf("valid file: %+v %v %v", c, found, err)
	}
	for _, bad := range []string{`nonsense`, `{"port": 0, "names": ["a"]}`, `{"port": 70000, "names": ["a"]}`,
		`{"port": 5000}`, `{"port": 5000, "names": ["a:1"]}`} {
		write(t, f.Config, bad, 0o600)
		if _, found, err := LoadConfig(root); !found || err == nil {
			t.Errorf("%s: found %v, err %v", bad, found, err)
		}
	}
}

func TestLocalNames(t *testing.T) {
	seen := map[string]bool{}
	for _, n := range LocalNames() {
		if nn, ok := NormalName(n); !ok || nn != n || seen[n] || strings.HasPrefix(n, "127.") {
			t.Errorf("LocalNames has %q", n)
		}
		seen[n] = true
	}
}
