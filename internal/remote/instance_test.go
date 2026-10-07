package remote

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstanceID(t *testing.T) {
	root := filepath.Join(t.TempDir(), "home") // made when missing
	f := FilesIn(root)
	id, err := EnsureInstanceID(root)
	if err != nil {
		t.Fatal(err)
	}
	if !ValidID(id) {
		t.Errorf("id %q is not a lowercase version 4 UUID", id)
	}
	if got := read(t, f.InstanceID); got != id+"\n" {
		t.Errorf("file holds %q", got)
	}
	if fi, _ := os.Stat(f.InstanceID); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode())
	}
	before := snapshot(t, root)
	if again, err := EnsureInstanceID(root); err != nil || again != id {
		t.Errorf("second call: %q, %v; want %q", again, err, id)
	}
	sameFolder(t, root, before)

	for _, bad := range []string{"", "nonsense\n", "6F9619FF-8B86-4D01-B42D-00CF4FC964FF\n", id + "\n" + id + "\n"} {
		write(t, f.InstanceID, bad, 0o600)
		fresh, err := EnsureInstanceID(root)
		if err != nil || !ValidID(fresh) || fresh == id {
			t.Errorf("over %q: %q, %v", bad, fresh, err)
		}
		if got := read(t, f.InstanceID); got != fresh+"\n" {
			t.Errorf("over %q: file holds %q", bad, got)
		}
	}
	if other, err := EnsureInstanceID(t.TempDir()); err != nil || other == id {
		t.Errorf("another folder: %q, %v", other, err)
	}
}

func TestValidID(t *testing.T) {
	if !ValidID("6f9619ff-8b86-4d01-b42d-00cf4fc964ff") {
		t.Error("a version 4 UUID is refused")
	}
	for _, s := range []string{"", "6F9619FF-8B86-4D01-B42D-00CF4FC964FF", "6f9619ff-8b86-1d01-b42d-00cf4fc964ff",
		"6f9619ff-8b86-4d01-c42d-00cf4fc964ff", "6f9619ff8b864d01b42d00cf4fc964ff", "6f9619ff-8b86-4d01-b42d-00cf4fc964ff\n"} {
		if ValidID(s) {
			t.Errorf("ValidID(%q)", s)
		}
	}
}
