package remote

import (
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func leafOf(t *testing.T, certPath string) *x509.Certificate {
	t.Helper()
	c, err := firstCert([]byte(read(t, certPath)))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode().Perm()
}

func TestSetupMakesWhatIsMissing(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), "home")
	f := FilesIn(root)
	made, err := Setup(root, SetupOptions{Names: []string{"WB.example", "10.1.2.3"}})
	if err != nil {
		t.Fatal(err)
	}
	if made != (Made{Secret: true, Pair: true, Config: true}) {
		t.Errorf("made %+v", made)
	}
	if m := mode(t, root); m != 0o700 {
		t.Errorf("folder mode %v", m)
	}
	for path, want := range map[string]os.FileMode{f.Config: 0o600, f.Secret: 0o600, f.Key: 0o600, f.Cert: 0o644} {
		if m := mode(t, path); m != want {
			t.Errorf("%s: mode %v, want %v", filepath.Base(path), m, want)
		}
	}
	if _, err := os.Stat(f.InstanceID); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("set-up made the instance id: %v", err)
	}

	c, found, err := LoadConfig(root)
	if !found || err != nil {
		t.Fatalf("configuration: %v %v", found, err)
	}
	want := addName(addName(LocalNames(), "wb.example"), "10.1.2.3")
	if c.Port != DefaultPort || !reflect.DeepEqual(c.Names, want) {
		t.Errorf("configuration %+v, want names %v", c, want)
	}
	if s := read(t, f.Secret); !secretForm.MatchString(s[:len(s)-1]) || s[len(s)-1] != '\n' {
		t.Errorf("secret file %q", s)
	}
	if blk, rest := pem.Decode([]byte(read(t, f.Key))); blk == nil || blk.Type != "PRIVATE KEY" || len(rest) != 0 {
		t.Errorf("key file is not one PRIVATE KEY block")
	}
	if blk, rest := pem.Decode([]byte(read(t, f.Cert))); blk == nil || blk.Type != "CERTIFICATE" || len(rest) != 0 {
		t.Errorf("certificate file is not one CERTIFICATE block")
	}
	leaf := leafOf(t, f.Cert)
	in := append([]string(nil), leaf.DNSNames...)
	for _, ip := range leaf.IPAddresses {
		in = append(in, ip.String())
	}
	if len(in) != len(c.Names) {
		t.Errorf("certificate names %v, list %v", in, c.Names)
	}
	for _, n := range c.Names {
		if err := leaf.VerifyHostname(n); err != nil {
			t.Errorf("certificate is not for %s: %v", n, err)
		}
	}
	if d := time.Until(leaf.NotAfter); d < 3649*24*time.Hour || d > 3654*24*time.Hour || time.Since(leaf.NotBefore) < time.Hour {
		t.Errorf("certificate runs from %v to %v", leaf.NotBefore, leaf.NotAfter)
	}
	rep := Check(root, 4747, 6006)
	if !rep.OK() || len(rep.Notes) != 0 || rep.Pair == nil || rep.Secret == "" {
		t.Errorf("check after set-up: %+v %v", rep.Fatal, rep.Notes)
	}

	// A second run changes nothing, with the same options or none.
	before := snapshot(t, root)
	for _, o := range []SetupOptions{{Names: []string{"wb.example", "10.1.2.3"}}, {}, {Port: DefaultPort}} {
		if made, err := Setup(root, o); err != nil || made != (Made{}) {
			t.Errorf("second run %+v: made %+v, %v", o, made, err)
		}
	}
	sameFolder(t, root, before)
}

func TestSetupNewCert(t *testing.T) {
	t.Parallel()
	// Without a configuration: ErrNotSetUp and an unchanged folder, stray files and all.
	bare := t.TempDir()
	write(t, FilesIn(bare).Key, "stray", 0o600)
	before := snapshot(t, bare)
	if made, err := Setup(bare, SetupOptions{NewCert: true, Names: []string{"a"}}); !errors.Is(err, ErrNotSetUp) || made != (Made{}) {
		t.Errorf("no configuration: %+v, %v", made, err)
	}
	sameFolder(t, bare, before)
	write(t, FilesIn(bare).Config, `{"port": 0}`, 0o600)
	before = snapshot(t, bare)
	if _, err := Setup(bare, SetupOptions{NewCert: true}); !errors.Is(err, ErrNotSetUp) {
		t.Errorf("invalid configuration: %v", err)
	}
	sameFolder(t, bare, before)
	missing := filepath.Join(t.TempDir(), "none")
	if _, err := Setup(missing, SetupOptions{NewCert: true}); !errors.Is(err, ErrNotSetUp) {
		t.Errorf("no folder: %v", err)
	}
	if _, err := os.Stat(missing); !errors.Is(err, os.ErrNotExist) {
		t.Error("the folder was made")
	}

	root, f := setUp(t)
	secret, conf, key, cert := read(t, f.Secret), read(t, f.Config), read(t, f.Key), read(t, f.Cert)
	made, err := Setup(root, SetupOptions{NewCert: true})
	if err != nil {
		t.Fatal(err)
	}
	if made != (Made{Pair: true}) {
		t.Errorf("made %+v", made)
	}
	if read(t, f.Key) == key || read(t, f.Cert) == cert {
		t.Error("key or certificate was kept")
	}
	if read(t, f.Secret) != secret || read(t, f.Config) != conf {
		t.Error("secret or configuration changed")
	}
	if mode(t, f.Key) != 0o600 || mode(t, f.Cert) != 0o644 {
		t.Errorf("modes %v %v", mode(t, f.Key), mode(t, f.Cert))
	}
	if rep := Check(root, 4747, 6006); !rep.OK() || len(rep.Notes) != 0 {
		t.Errorf("check: %+v %v", rep.Fatal, rep.Notes)
	}

	// With a new name in the same run, the new certificate has the list of that moment.
	if _, err := Setup(root, SetupOptions{NewCert: true, Names: []string{"other.example"}}); err != nil {
		t.Fatal(err)
	}
	if err := leafOf(t, f.Cert).VerifyHostname("other.example"); err != nil {
		t.Error(err)
	}
	// One of the two removed (a start between the two writes): the command run again repairs it.
	os.Remove(f.Cert)
	if _, err := Setup(root, SetupOptions{NewCert: true}); err != nil {
		t.Fatal(err)
	}
	if rep := Check(root, 4747, 6006); !rep.OK() {
		t.Errorf("check: %+v", rep.Fatal)
	}
}

func TestSetupRemakesMissingSecretOnly(t *testing.T) {
	t.Parallel()
	root, f := setUp(t)
	old, conf, key, cert := read(t, f.Secret), read(t, f.Config), read(t, f.Key), read(t, f.Cert)
	os.Remove(f.Secret)
	made, err := Setup(root, SetupOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if made != (Made{Secret: true}) {
		t.Errorf("made %+v", made)
	}
	if s := read(t, f.Secret); s == old || !secretForm.MatchString(s[:len(s)-1]) {
		t.Errorf("secret %q", s)
	}
	if read(t, f.Config) != conf || read(t, f.Key) != key || read(t, f.Cert) != cert {
		t.Error("another file changed")
	}

	// A bad secret is left for `secret -new`; one file of the pair alone is not remade either.
	write(t, f.Secret, "", 0o600)
	os.Remove(f.Key)
	before := snapshot(t, root)
	if made, err := Setup(root, SetupOptions{}); err != nil || made != (Made{}) {
		t.Errorf("made %+v, %v", made, err)
	}
	sameFolder(t, root, before)

	// Both of the pair missing: made anew, the rest kept.
	os.Remove(f.Cert)
	if made, err := Setup(root, SetupOptions{}); err != nil || made != (Made{Pair: true}) {
		t.Errorf("made %+v, %v", made, err)
	}
	if read(t, f.Secret) != "" || read(t, f.Config) != conf {
		t.Error("secret or configuration changed")
	}
}

func TestSetupAddsNameAndPort(t *testing.T) {
	t.Parallel()
	root, f := setUp(t)
	c0, _, _ := LoadConfig(root)
	secret, key, cert := read(t, f.Secret), read(t, f.Key), read(t, f.Cert)
	made, err := Setup(root, SetupOptions{Port: 5001, Names: []string{"New.example", "wb.example", "10.9.8.7"}})
	if err != nil {
		t.Fatal(err)
	}
	if made != (Made{Config: true}) {
		t.Errorf("made %+v", made)
	}
	c, _, err := LoadConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if want := append(append([]string(nil), c0.Names...), "new.example", "10.9.8.7"); c.Port != 5001 || !reflect.DeepEqual(c.Names, want) {
		t.Errorf("configuration %+v, want port 5001 and %v", c, want)
	}
	if mode(t, f.Config) != 0o600 {
		t.Errorf("mode %v", mode(t, f.Config))
	}
	if read(t, f.Secret) != secret || read(t, f.Key) != key || read(t, f.Cert) != cert {
		t.Error("secret, key or certificate changed")
	}
	// The certificate is not remade: the check says that its names differ, and starts.
	if rep := Check(root, 4747, 6006); !rep.OK() || len(rep.Notes) != 1 {
		t.Errorf("check: %+v %v", rep.Fatal, rep.Notes)
	}
	// Port 0 keeps the port.
	if _, err := Setup(root, SetupOptions{Names: []string{"third.example"}}); err != nil {
		t.Fatal(err)
	}
	if c, _, _ := LoadConfig(root); c.Port != 5001 || c.Names[len(c.Names)-1] != "third.example" {
		t.Errorf("configuration %+v", c)
	}

	// A bad name or port writes nothing.
	before := snapshot(t, root)
	for _, o := range []SetupOptions{{Names: []string{"ok.example", "a:1"}}, {Port: 70000}, {Port: -1}} {
		if made, err := Setup(root, o); err == nil || made != (Made{}) {
			t.Errorf("%+v: made %+v, %v", o, made, err)
		}
	}
	sameFolder(t, root, before)
}

func TestSetupWritesBadConfigAnew(t *testing.T) {
	t.Parallel()
	root, f := setUp(t)
	secret, cert := read(t, f.Secret), read(t, f.Cert)
	write(t, f.Config, "nonsense", 0o600)
	made, err := Setup(root, SetupOptions{Port: 5002, Names: []string{"wb.example"}})
	if err != nil {
		t.Fatal(err)
	}
	if made != (Made{Config: true}) {
		t.Errorf("made %+v", made)
	}
	if c, _, err := LoadConfig(root); err != nil || c.Port != 5002 || c.Names[len(c.Names)-1] != "wb.example" {
		t.Errorf("configuration %+v, %v", c, err)
	}
	if read(t, f.Secret) != secret || read(t, f.Cert) != cert {
		t.Error("secret or certificate changed")
	}
}

func TestOffRemovesConfigOnly(t *testing.T) {
	t.Parallel()
	root, f := setUp(t)
	secret := read(t, f.Secret)
	fp := Check(root, 4747, 6006).Fingerprint
	conf := read(t, f.Config)
	before := snapshot(t, root)
	delete(before, filepath.Base(f.Config))

	was, err := Off(root)
	if err != nil || !was {
		t.Fatalf("Off: %v, %v", was, err)
	}
	sameFolder(t, root, before)
	if rep := Check(root, 4747, 6006); rep.Configured || !rep.OK() {
		t.Errorf("check after off: %+v", rep)
	}
	if was, err := Off(root); err != nil || was {
		t.Errorf("second Off: %v, %v", was, err)
	}
	if was, err := Off(filepath.Join(root, "none")); err != nil || was {
		t.Errorf("Off without a folder: %v, %v", was, err)
	}

	// Set-up after it gives the same secret and fingerprint.
	made, err := Setup(root, SetupOptions{Names: []string{"wb.example"}})
	if err != nil || made != (Made{Config: true}) {
		t.Fatalf("set-up after off: %+v, %v", made, err)
	}
	rep := Check(root, 4747, 6006)
	if !rep.OK() || len(rep.Notes) != 0 || rep.Fingerprint != fp || rep.Secret+"\n" != secret || read(t, f.Config) != conf {
		t.Errorf("after off and set-up: %+v %v, fingerprint %s, want %s", rep.Fatal, rep.Notes, rep.Fingerprint, fp)
	}
}
