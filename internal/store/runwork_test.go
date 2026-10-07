package store

import (
	"os"
	"path/filepath"
	"testing"
)

// InRunWork: the folder of the runs' checkouts and what is inside it, through links and ".." too;
// not the data folder, the parent of both or a folder whose name only starts the same.
func TestInRunWork(t *testing.T) {
	base := t.TempDir()
	p := NewPaths(filepath.Join(base, "data"))
	if err := os.MkdirAll(filepath.Join(p.RunWork, "r_x", "int"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(p.Root, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(p.RunWork, link); err != nil {
		t.Fatal(err)
	}
	for _, in := range []string{p.RunWork, p.RunWork + string(filepath.Separator), p.RunWorkDir("r_x"), filepath.Join(p.RunWork, "r_x", "int"),
		filepath.Join(p.RunWork, "r_gone", "not", "there"), link, filepath.Join(link, "r_x"), filepath.Join(link, "r_gone"),
		filepath.Join(p.Root, "..", filepath.Base(p.RunWork), "r_x")} {
		if !p.InRunWork(in) {
			t.Errorf("%s is not taken as inside the runs' work folder", in)
		}
	}
	for _, out := range []string{base, p.Root, p.Runs, p.RunDir("r_x"), p.RunWork + "-other", filepath.Join(base, "elsewhere"), filepath.Join(p.RunWork, "..")} {
		if p.InRunWork(out) {
			t.Errorf("%s is taken as inside the runs' work folder", out)
		}
	}
}
