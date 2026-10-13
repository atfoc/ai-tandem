package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
)

// Every type a chat takes is written with its own extension and named with its own word, GIF
// among them; the file holds the bytes, in the directory asked for.
func TestImageFilesWriteEveryType(t *testing.T) {
	t.Parallel()
	want := map[string][2]string{
		"image/png": {".png", "(PNG)"}, "image/jpeg": {".jpg", "(JPEG)"},
		"image/gif": {".gif", "(GIF)"}, "image/webp": {".webp", "(WEBP)"},
	}
	if len(want) != len(model.ImageTypes) {
		t.Fatalf("the test knows %d types, a chat takes %v", len(want), model.ImageTypes)
	}
	dir := filepath.Join(t.TempDir(), "imgs")
	f := ImageFiles{Dir: dir}
	for _, typ := range model.ImageTypes {
		data := []byte("bytes of an " + typ)
		path, err := f.Write(typ, data)
		if err != nil {
			t.Fatalf("%s: %v", typ, err)
		}
		if !filepath.IsAbs(path) || filepath.Dir(path) != dir || filepath.Ext(path) != want[typ][0] ||
			!strings.HasPrefix(filepath.Base(path), "img-") {
			t.Errorf("%s: path %q", typ, path)
		}
		if b, err := os.ReadFile(path); err != nil || string(b) != string(data) {
			t.Errorf("%s: file %q: %v %q", typ, path, err, b)
		}
		if got, wantText := ImageFileText(path, typ), "Image file: "+path+" "+want[typ][1]+". Open it with your file tools."; got != wantText {
			t.Errorf("%s: text %q, want %q", typ, got, wantText)
		}
	}
}

// A type a chat does not take is refused, and nothing is made for it.
func TestImageFilesRefuseOtherTypes(t *testing.T) {
	t.Parallel()
	for _, typ := range []string{"image/svg+xml", "text/html", ""} {
		dir := filepath.Join(t.TempDir(), "imgs")
		if path, err := (ImageFiles{Dir: dir}).Write(typ, []byte("<svg/>")); err == nil {
			t.Errorf("%q was written to %s", typ, path)
		}
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Errorf("%q: the directory exists: %v", typ, err)
		}
	}
}

// Who can read a file: the directory is 0700 and the file 0600, and a directory that was looser
// is tightened.
func TestImageFilesArePrivate(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no unix modes")
	}
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "imgs")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.Chmod(dir, 0o755)
	path, err := ImageFiles{Dir: dir}.Write("image/gif", []byte("GIF89a"))
	if err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(dir); err != nil || fi.Mode().Perm() != 0o700 {
		t.Errorf("dir %v %v", fi, err)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("file %v %v", fi, err)
	}
}

// When a file goes: one older than the age is removed at the next write. A newer one stays, and
// so does a file that is not ours. With no age set the age is an hour.
func TestImageFilesSweep(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name     string
		age      time.Duration // ImageFiles.MaxAge
		old, new time.Duration // how long ago the two files were written
	}{
		{"lowered", time.Minute, 2 * time.Minute, 30 * time.Second},
		{"an hour", 0, 61 * time.Minute, 59 * time.Minute},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			dir := filepath.Join(t.TempDir(), "imgs")
			f := ImageFiles{Dir: dir, MaxAge: c.age}
			write := func() string {
				t.Helper()
				p, err := f.Write("image/png", []byte("x"))
				if err != nil {
					t.Fatal(err)
				}
				return p
			}
			oldP, newP := write(), write()
			other := filepath.Join(dir, "notes.txt")
			if err := os.WriteFile(other, []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			for p, ago := range map[string]time.Duration{oldP: c.old, other: c.old, newP: c.new} {
				at := time.Now().Add(-ago)
				if err := os.Chtimes(p, at, at); err != nil {
					t.Fatal(err)
				}
			}
			third := write()
			for p, want := range map[string]bool{oldP: false, newP: true, third: true, other: true} {
				if _, err := os.Stat(p); (err == nil) != want {
					t.Errorf("%s exists %v, want %v (%v)", filepath.Base(p), err == nil, want, err)
				}
			}
		})
	}
}

// With no directory set the files go to a folder of the user in the OS temp dir.
func TestImageFilesDefaultDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)
	t.Setenv("TEMP", tmp)
	path, err := ImageFiles{}.Write("image/png", []byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(tmp, fmt.Sprintf("aiwb-images-%d", os.Getuid())); filepath.Dir(path) != want {
		t.Errorf("path %q is not in %q", path, want)
	}
}

// A directory that is a symlink is refused, and nothing is written through the link.
func TestImageFilesSymlinkRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("no symlinks to rely on")
	}
	t.Parallel()
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "imgs")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if path, err := (ImageFiles{Dir: link}).Write("image/png", []byte("x")); err == nil || !strings.Contains(err.Error(), "is not a directory") {
		t.Errorf("path %q, error %v", path, err)
	}
	if es, _ := os.ReadDir(target); len(es) != 0 {
		t.Errorf("%d entries were written through the link", len(es))
	}
}
