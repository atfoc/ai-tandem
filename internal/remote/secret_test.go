package remote

import (
	"errors"
	"os"
	"testing"
)

func TestReadSecret(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	f := FilesIn(root)
	if _, err := ReadSecret(root); !errors.Is(err, ErrNoSecret) {
		t.Errorf("no file: %v", err)
	}
	good := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for _, bad := range []string{"", "\n", "abc\n", good[:63] + "G\n", good + "0\n", " " + good} {
		write(t, f.Secret, bad, 0o600)
		if _, err := ReadSecret(root); !errors.Is(err, ErrBadSecret) {
			t.Errorf("%q: %v", bad, err)
		}
	}
	for _, ok := range []string{good, good + "\n", good + " \r\n\n"} {
		write(t, f.Secret, ok, 0o600)
		if s, err := ReadSecret(root); err != nil || s != good {
			t.Errorf("%q: %q, %v", ok, s, err)
		}
	}
}

func TestNewSecret(t *testing.T) {
	t.Parallel()
	// Without a configuration: ErrNotSetUp, and nothing is written, not even over an old secret.
	bare := t.TempDir()
	write(t, FilesIn(bare).Secret, "old\n", 0o600)
	before := snapshot(t, bare)
	if s, err := NewSecret(bare); !errors.Is(err, ErrNotSetUp) || s != "" {
		t.Errorf("no configuration: %q, %v", s, err)
	}
	sameFolder(t, bare, before)
	write(t, FilesIn(bare).Config, "nonsense", 0o600)
	before = snapshot(t, bare)
	if _, err := NewSecret(bare); !errors.Is(err, ErrNotSetUp) {
		t.Errorf("invalid configuration: %v", err)
	}
	sameFolder(t, bare, before)

	root, f := setUp(t)
	old, err := ReadSecret(root)
	if err != nil {
		t.Fatal(err)
	}
	cert, key, conf := read(t, f.Cert), read(t, f.Key), read(t, f.Config)
	s, err := NewSecret(root)
	if err != nil {
		t.Fatal(err)
	}
	if s == old || !secretForm.MatchString(s) {
		t.Errorf("new secret %q, old %q", s, old)
	}
	if got := read(t, f.Secret); got != s+"\n" {
		t.Errorf("file holds %q", got)
	}
	if fi, _ := os.Stat(f.Secret); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode())
	}
	if read(t, f.Cert) != cert || read(t, f.Key) != key || read(t, f.Config) != conf {
		t.Error("NewSecret changed another file")
	}
	// A bad secret is replaced too: it is the repair the check names.
	write(t, f.Secret, "", 0o600)
	if s2, err := NewSecret(root); err != nil || s2 == s {
		t.Errorf("over an empty file: %q, %v", s2, err)
	}
	if rep := Check(root, 1, 2); !rep.OK() {
		t.Errorf("after NewSecret: %+v", rep.Fatal)
	}
}
