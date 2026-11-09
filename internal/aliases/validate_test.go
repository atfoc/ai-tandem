package aliases

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"ai-whiteboard/internal/container"
)

func TestCleanName(t *testing.T) {
	if got, err := CleanName("  Work  "); err != nil || got != "Work" {
		t.Fatalf("%q %v", got, err)
	}
	for _, s := range []string{"", "   ", "\t\n"} {
		if _, err := CleanName(s); !errors.Is(err, ErrNoName) {
			t.Fatalf("%q: %v", s, err)
		}
	}
}

func TestCleanImage(t *testing.T) {
	for in, want := range map[string]string{
		"":                                   "",
		"  my/image:2 ":                      "my/image:2",
		container.DefaultImage():             "",
		" " + container.DefaultImage() + " ": "",
		"registry.example.com:5000/team/claude:1.2_rc-3": "registry.example.com:5000/team/claude:1.2_rc-3",
		"ubuntu@sha256:0123abcd":                         "ubuntu@sha256:0123abcd",
	} {
		if got, err := CleanImage(in); err != nil || got != want {
			t.Fatalf("%q: %q %v, want %q", in, got, err, want)
		}
	}
}

// Review finding #4: an image that docker create would read as an option, or that is not one
// word, is refused.
func TestCleanImageRefusals(t *testing.T) {
	for _, in := range []string{"--privileged", "-v=/:/host", "-v", "ubuntu --privileged", "ubuntu\tx",
		"ubuntu\nx", "ubu\x00ntu", ".hidden", "/abs", "a;b", "a$(x)"} {
		got, err := CleanImage(in)
		var ie *ImageError
		if !errors.As(err, &ie) || got != "" {
			t.Errorf("%q: %q %v, want an *ImageError", in, got, err)
		}
	}
}

// mountFixture is a home with .claude, a data folder root, and two project folders.
type mountFixture struct {
	home, claude, root, p1, p2 string
}

func newMountFixture(t *testing.T) mountFixture {
	t.Helper()
	base := t.TempDir()
	f := mountFixture{
		home: filepath.Join(base, "home"),
		root: filepath.Join(base, "home", "data"),
		p1:   filepath.Join(base, "projects", "one"),
		p2:   filepath.Join(base, "projects", "two"),
	}
	f.claude = filepath.Join(f.home, ".claude")
	for _, d := range []string{f.claude, f.root, f.p1, f.p2} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return f
}

func symlink(t *testing.T, target, link string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symbolic links need privileges on Windows")
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	return link
}

func TestCleanMountsRefusals(t *testing.T) {
	f := newMountFixture(t)
	file := filepath.Join(f.p1, "notes.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	links := t.TempDir()
	toP1 := symlink(t, f.p1, filepath.Join(links, "p1"))
	toClaude := symlink(t, f.claude, filepath.Join(links, "claude"))
	toInside := symlink(t, f.root, filepath.Join(links, "data"))
	inside := filepath.Join(f.root, "aliases", "a_00000001")
	if err := os.MkdirAll(inside, 0o700); err != nil {
		t.Fatal(err)
	}
	// Review finding #3: a folder inside ~/.claude (its sessions) is refused too.
	projects := filepath.Join(f.claude, "projects")
	if err := os.MkdirAll(projects, 0o700); err != nil {
		t.Fatal(err)
	}
	toProjects := symlink(t, projects, filepath.Join(links, "projects"))
	missing := filepath.Join(f.p1, "missing")
	colon := filepath.Join(f.p1, "a:b")
	if err := os.MkdirAll(colon, 0o700); err != nil && runtime.GOOS != "windows" {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		mounts []string
		folder string
		why    string
	}{
		{"relative", []string{"projects/one"}, "projects/one", "is not an absolute path"},
		{"empty", []string{f.p1, ""}, "", "is not an absolute path"},
		{"missing", []string{missing}, missing, "does not exist"},
		{"file", []string{file}, file, "is not a folder"},
		{"colon", []string{f.p2, colon}, colon, "has a “:” in its path, which Docker cannot mount"},
		{"twice", []string{f.p1, f.p2, f.p1}, f.p1, "is listed twice"},
		{"twice with a slash", []string{f.p1, f.p1 + "/"}, f.p1 + "/", "is listed twice"},
		{"twice through a link", []string{f.p1, toP1}, toP1, "is listed twice"},
		{"home", []string{f.home}, f.home, "holds this computer's Claude login (~/.claude)"},
		{"claude", []string{f.claude}, f.claude, "holds this computer's Claude login (~/.claude)"},
		{"link to claude", []string{toClaude}, toClaude, "holds this computer's Claude login (~/.claude)"},
		{"inside claude", []string{f.p1, projects}, projects, "is inside this computer's Claude folder (~/.claude)"},
		{"link inside claude", []string{toProjects}, toProjects, "is inside this computer's Claude folder (~/.claude)"},
		{"root", []string{f.p1, f.root}, f.root, "holds the app's data folder"},
		{"link to root", []string{toInside}, toInside, "holds the app's data folder"},
		{"inside root", []string{inside}, inside, "is inside the app's data folder"},
		{"inside root through a link", []string{filepath.Join(toInside, "aliases")}, filepath.Join(toInside, "aliases"), "is inside the app's data folder"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if c.name == "colon" && runtime.GOOS == "windows" {
				t.Skip("no “:” in a Windows file name")
			}
			got, err := CleanMounts(c.mounts, f.home, f.root)
			var fe *FolderError
			if !errors.As(err, &fe) {
				t.Fatalf("got %v %v, want a *FolderError", got, err)
			}
			if want := c.folder + " " + c.why; fe.Folder != c.folder || fe.Why != c.why || err.Error() != want {
				t.Fatalf("%q, want %q", err.Error(), want)
			}
		})
	}
}

func TestCleanMountsParentOfRoot(t *testing.T) {
	// root is under a folder of its own here, away from home, so the parent holds only root.
	f := newMountFixture(t)
	parent := filepath.Join(t.TempDir(), "app")
	root := filepath.Join(parent, "data")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := CleanMounts([]string{parent}, f.home, root)
	if err == nil || err.Error() != parent+" holds the app's data folder" {
		t.Fatalf("%v", err)
	}
}

func TestCleanMountsAllowed(t *testing.T) {
	f := newMountFixture(t)
	nested := filepath.Join(f.p1, "sub")
	if err := os.MkdirAll(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	// A "," is fine: docker create -v mounts it (checked with Docker).
	comma := filepath.Join(f.p1, "x,y")
	if err := os.MkdirAll(comma, 0o700); err != nil {
		t.Fatal(err)
	}
	if got, err := CleanMounts([]string{comma}, f.home, f.root); err != nil || !slices.Equal(got, []string{comma}) {
		t.Fatalf("comma: %v %v", got, err)
	}
	in := []string{f.p2 + "/", nested, f.p1 + "/./"}
	got, err := CleanMounts(in, f.home, f.root)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{f.p2, nested, f.p1}; !slices.Equal(got, want) {
		t.Fatalf("%v, want %v", got, want)
	}
	for _, none := range [][]string{nil, {}} {
		got, err := CleanMounts(none, f.home, f.root)
		if err != nil || got == nil || len(got) != 0 {
			t.Fatalf("no folders: %#v %v", got, err)
		}
	}
	// Without a home, its .claude is not checked.
	if _, err := CleanMounts([]string{f.home}, "", f.p1); err != nil {
		t.Fatalf("no home: %v", err)
	}
}
