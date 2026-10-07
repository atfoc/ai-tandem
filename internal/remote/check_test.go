package remote

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"
)

const (
	testExe  = "/Applications/AI Whiteboard.app/Contents/Resources/ai-whiteboard"
	testHome = "/tmp/a home"
)

// checkMessage holds a fatal report's message to its layout: at most six lines, the problems'
// lines first, then the three fixed ones.
func checkMessage(t *testing.T, rep Report, repair string) {
	t.Helper()
	for _, home := range []string{"", testHome} {
		msg := rep.Message(testExe, home)
		lines := strings.Split(msg, "\n")
		n := len(rep.Fatal)
		if len(lines) != n+3 || len(lines) > 6 {
			t.Fatalf("message has %d lines for %d problems:\n%s", len(lines), n, msg)
		}
		for i, p := range rep.Fatal {
			if lines[i] != p.Line || !strings.HasPrefix(p.Line, "Remote access: ") || strings.Contains(p.Line, "\n") {
				t.Errorf("line %d is %q, the problem's %q", i, lines[i], p.Line)
			}
		}
		suffix := ""
		if home != "" {
			suffix = ` -home "` + home + `"`
		}
		want := []string{
			"The start creates nothing.",
			"To repair: " + strings.ReplaceAll(strings.ReplaceAll(repair, "EXE", `"`+testExe+`"`), " HOME", suffix),
			`To start without remote access: "` + testExe + `" remote off` + suffix,
		}
		for i, w := range want {
			if lines[n+i] != w {
				t.Errorf("line %d is\n%q, want\n%q", n+i, lines[n+i], w)
			}
		}
	}
}

func TestCheckNotConfigured(t *testing.T) {
	if rep := Check(t.TempDir(), 4747, 6006); !reflect0(rep) {
		t.Errorf("empty folder: %+v", rep)
	}
	if rep := Check("/nonexistent/aiwb-test-home", 4747, 6006); !reflect0(rep) {
		t.Errorf("no folder: %+v", rep)
	}
	for _, perm := range []os.FileMode{0o600, 0} {
		root := t.TempDir()
		f := FilesIn(root)
		for _, path := range []string{f.Secret, f.Key, f.Cert} {
			write(t, path, "garbage \x00\xff", perm)
		}
		before := snapshot(t, root)
		rep := Check(root, DefaultPort, DefaultPort) // even the port rows are not looked at
		if !reflect0(rep) || !rep.OK() || rep.Message(testExe, "") != "" {
			t.Errorf("mode %v: %+v", perm, rep)
		}
		sameFolder(t, root, before)
	}
}

// reflect0 reports whether rep is the Report of "not configured".
func reflect0(rep Report) bool {
	return !rep.Configured && rep.Config.Port == 0 && rep.Config.Names == nil && rep.Fatal == nil && rep.Notes == nil &&
		rep.Fingerprint == "" && rep.Secret == "" && rep.Pair == nil
}

func TestCheckFatalRows(t *testing.T) {
	now := time.Now()
	otherCert, otherKey, err := GenerateCert([]string{"wb.example"}, now.Add(-time.Hour), now.AddDate(10, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	const setup, newCert = "EXE remote setup HOME", "EXE remote setup -new-cert HOME (or put your own certificate and key right)"
	cases := []struct {
		name    string
		break_  func(t *testing.T, f Files)
		ports   [2]int // the server's and the MCP port; zero: 4747 and 6006
		kind    ProblemKind
		in      func(f Files) []string // what the line names
		notIn   func(f Files) []string
		repair  string
		needsFP bool // the certificate on disk still parses
	}{
		{name: "configuration not JSON", break_: func(t *testing.T, f Files) { write(t, f.Config, "{nonsense", 0o600) },
			kind: BadConfig, in: func(f Files) []string { return []string{f.Config} }, repair: setup},
		{name: "configuration empty", break_: func(t *testing.T, f Files) { write(t, f.Config, "", 0o600) },
			kind: BadConfig, in: func(f Files) []string { return []string{f.Config} }, repair: setup},
		{name: "port 0", break_: func(t *testing.T, f Files) { write(t, f.Config, `{"port": 0, "names": ["wb.example"]}`, 0o600) },
			kind: BadConfig, in: func(f Files) []string { return []string{f.Config, "port 0"} }, repair: setup},
		{name: "no names", break_: func(t *testing.T, f Files) { write(t, f.Config, `{"port": 4748, "names": []}`, 0o600) },
			kind: BadConfig, in: func(f Files) []string { return []string{f.Config, "no names"} }, repair: setup},
		{name: "a bad name", break_: func(t *testing.T, f Files) { write(t, f.Config, `{"port": 4748, "names": ["a:4748"]}`, 0o600) },
			kind: BadConfig, in: func(f Files) []string { return []string{f.Config, `"a:4748"`} }, repair: setup},
		{name: "configuration unreadable", break_: func(t *testing.T, f Files) { unreadable(t, f.Config) },
			kind: BadConfig, in: func(f Files) []string { return []string{f.Config, "permission denied"} }, repair: setup},

		{name: "secret missing", break_: func(t *testing.T, f Files) { os.Remove(f.Secret) },
			kind: SecretMissing, in: func(f Files) []string { return []string{f.Secret, "missing"} }, repair: setup, needsFP: true},
		{name: "secret empty", break_: func(t *testing.T, f Files) { write(t, f.Secret, "", 0o600) },
			kind: SecretBad, in: func(f Files) []string { return []string{f.Secret, "empty"} }, repair: "EXE secret -new HOME", needsFP: true},
		{name: "secret only a newline", break_: func(t *testing.T, f Files) { write(t, f.Secret, "\n", 0o600) },
			kind: SecretBad, in: func(f Files) []string { return []string{f.Secret, "empty"} }, repair: "EXE secret -new HOME", needsFP: true},
		{name: "secret of a wrong form", break_: func(t *testing.T, f Files) { write(t, f.Secret, "MySecretPassword\n", 0o600) },
			kind: SecretBad, in: func(f Files) []string { return []string{f.Secret} },
			notIn: func(f Files) []string { return []string{"MySecretPassword"} }, repair: "EXE secret -new HOME", needsFP: true},
		{name: "secret unreadable", break_: func(t *testing.T, f Files) { unreadable(t, f.Secret) },
			kind: SecretBad, in: func(f Files) []string { return []string{f.Secret, "permission denied"} }, repair: "EXE secret -new HOME", needsFP: true},

		{name: "pair both missing", break_: func(t *testing.T, f Files) { os.Remove(f.Key); os.Remove(f.Cert) },
			kind: PairMissing, in: func(f Files) []string { return []string{f.Key, f.Cert, "missing"} }, repair: setup},
		{name: "key missing", break_: func(t *testing.T, f Files) { os.Remove(f.Key) },
			kind: PairBad, in: func(f Files) []string { return []string{f.Key, "missing"} },
			notIn: func(f Files) []string { return []string{f.Cert} }, repair: newCert, needsFP: true},
		{name: "certificate missing", break_: func(t *testing.T, f Files) { os.Remove(f.Cert) },
			kind: PairBad, in: func(f Files) []string { return []string{f.Cert, "missing"} },
			notIn: func(f Files) []string { return []string{f.Key} }, repair: newCert},
		{name: "certificate empty", break_: func(t *testing.T, f Files) { write(t, f.Cert, "", 0o644) },
			kind: PairBad, in: func(f Files) []string {
				return []string{f.Cert, "tls: failed to find any PEM data in certificate input"}
			},
			notIn: func(f Files) []string { return []string{f.Key} }, repair: newCert},
		{name: "key without PEM data", break_: func(t *testing.T, f Files) { write(t, f.Key, "not a key\n", 0o600) },
			kind: PairBad, in: func(f Files) []string { return []string{f.Key, "tls: failed to find any PEM data in key input"} },
			notIn: func(f Files) []string { return []string{f.Cert} }, repair: newCert, needsFP: true},
		{name: "the two swapped", break_: func(t *testing.T, f Files) {
			c, k := read(t, f.Cert), read(t, f.Key)
			write(t, f.Cert, k, 0o644)
			write(t, f.Key, c, 0o600)
		}, kind: PairBad, in: func(f Files) []string { return []string{f.Cert, f.Key, "tls: "} }, repair: newCert},
		{name: "key file holds a certificate", break_: func(t *testing.T, f Files) { write(t, f.Key, read(t, f.Cert), 0o600) },
			kind: PairBad, in: func(f Files) []string { return []string{f.Key, "tls: "} },
			notIn: func(f Files) []string { return []string{f.Cert} }, repair: newCert, needsFP: true},
		{name: "a pair that does not fit", break_: func(t *testing.T, f Files) { write(t, f.Key, string(otherKey), 0o600) },
			kind: PairBad, in: func(f Files) []string { return []string{f.Cert, f.Key, "tls: private key does not match public key"} },
			repair: newCert, needsFP: true},
		{name: "another certificate", break_: func(t *testing.T, f Files) { write(t, f.Cert, string(otherCert), 0o644) },
			kind: PairBad, in: func(f Files) []string { return []string{f.Cert, f.Key, "tls: private key does not match public key"} },
			repair: newCert, needsFP: true},
		{name: "key unreadable", break_: func(t *testing.T, f Files) { unreadable(t, f.Key) },
			kind: PairBad, in: func(f Files) []string { return []string{f.Key, "permission denied"} },
			notIn: func(f Files) []string { return []string{f.Cert} }, repair: newCert, needsFP: true},
		{name: "certificate unreadable", break_: func(t *testing.T, f Files) { unreadable(t, f.Cert) },
			kind: PairBad, in: func(f Files) []string { return []string{f.Cert, "permission denied"} },
			notIn: func(f Files) []string { return []string{f.Key} }, repair: newCert},

		{name: "port equal to the server's", ports: [2]int{DefaultPort, 6006},
			kind: PortEqual, in: func(f Files) []string { return []string{"4748", "server's own port"} },
			repair: "EXE remote setup -port N HOME", needsFP: true},
		{name: "port equal to the MCP port", ports: [2]int{4747, DefaultPort},
			kind: PortEqual, in: func(f Files) []string { return []string{"4748", "MCP port"} },
			repair: "EXE remote setup -port N HOME", needsFP: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root, f := setUp(t)
			if tc.break_ != nil {
				tc.break_(t, f)
			}
			if tc.ports == [2]int{} {
				tc.ports = [2]int{4747, 6006}
			}
			before := snapshot(t, root)
			rep := Check(root, tc.ports[0], tc.ports[1])
			sameFolder(t, root, before)
			if !rep.Configured || rep.OK() || len(rep.Fatal) != 1 || rep.Fatal[0].Kind != tc.kind {
				t.Fatalf("report: configured %v, fatal %+v", rep.Configured, rep.Fatal)
			}
			line := rep.Fatal[0].Line
			for _, s := range tc.in(f) {
				if !strings.Contains(line, s) {
					t.Errorf("line %q does not hold %q", line, s)
				}
			}
			if tc.notIn != nil {
				for _, s := range tc.notIn(f) {
					if strings.Contains(line, s) {
						t.Errorf("line %q holds %q", line, s)
					}
				}
			}
			if strings.Count(line, root) > 2 {
				t.Errorf("line names a path twice: %q", line)
			}
			if (rep.Fingerprint != "") != tc.needsFP {
				t.Errorf("fingerprint %q", rep.Fingerprint)
			}
			if rep.Secret != "" && strings.Contains(rep.Message(testExe, testHome), rep.Secret) {
				t.Error("the message holds the secret")
			}
			checkMessage(t, rep, tc.repair)
		})
	}
}

// unreadable takes every right from path; the row cannot be made for root, who reads anything.
func unreadable(t *testing.T, path string) {
	t.Helper()
	if os.Getuid() == 0 {
		t.Skip("root reads a mode-000 file")
	}
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(path, 0o600) })
}

func TestMessageWorstCase(t *testing.T) {
	root, f := setUp(t)
	write(t, f.Secret, "", 0o600)
	os.Remove(f.Key)
	rep := Check(root, DefaultPort, 6006)
	if len(rep.Fatal) != 3 || rep.Fatal[0].Kind != SecretBad || rep.Fatal[1].Kind != PairBad || rep.Fatal[2].Kind != PortEqual {
		t.Fatalf("fatal %+v", rep.Fatal)
	}
	if n := strings.Count(rep.Message(testExe, testHome), "\n") + 1; n != 6 {
		t.Errorf("%d lines", n)
	}
	checkMessage(t, rep, "EXE secret -new HOME") // the first problem's repair

	// The other worst case: secret and pair missing, the port the MCP port's.
	os.Remove(f.Secret)
	os.Remove(f.Cert)
	rep = Check(root, 4747, DefaultPort)
	if len(rep.Fatal) != 3 || rep.Fatal[0].Kind != SecretMissing || rep.Fatal[1].Kind != PairMissing || rep.Fatal[2].Kind != PortEqual {
		t.Fatalf("fatal %+v", rep.Fatal)
	}
	checkMessage(t, rep, "EXE remote setup HOME")

	// A bad configuration ends the check: one problem, whatever else is wrong.
	write(t, f.Config, `{"port": 4748}`, 0o600)
	rep = Check(root, 4747, DefaultPort)
	if len(rep.Fatal) != 1 || rep.Fatal[0].Kind != BadConfig {
		t.Fatalf("fatal %+v", rep.Fatal)
	}
	checkMessage(t, rep, "EXE remote setup HOME")
}

func TestBindMessage(t *testing.T) {
	err := errors.New("listen tcp4 0.0.0.0:4748: bind: address already in use")
	for home, suffix := range map[string]string{"": "", testHome: ` -home "` + testHome + `"`} {
		got := strings.Split(BindMessage(testExe, home, 4748, err), "\n")
		want := []string{
			"Remote access: the remote port 4748 cannot be bound: " + err.Error(),
			"The start creates nothing.",
			`To repair: free port 4748, or "` + testExe + `" remote setup -port N` + suffix,
			`To start without remote access: "` + testExe + `" remote off` + suffix,
		}
		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Errorf("home %q:\n%s\nwant\n%s", home, strings.Join(got, "\n"), strings.Join(want, "\n"))
		}
	}
}

func TestCheckNotes(t *testing.T) {
	root, f := setUp(t)
	c, _, _ := LoadConfig(root)
	rep := Check(root, 4747, 6006)
	if !rep.OK() || len(rep.Notes) != 0 || rep.Pair == nil || len(rep.Fingerprint) != 95 ||
		rep.Secret+"\n" != read(t, f.Secret) || rep.Config.Port != DefaultPort || rep.Fingerprint != Fingerprint(rep.Pair.Certificate[0]) {
		t.Fatalf("a good set-up: %+v %v", rep.Fatal, rep.Notes)
	}

	putPair := func(names []string, from, to time.Time) {
		certPEM, keyPEM, err := GenerateCert(names, from, to)
		if err != nil {
			t.Fatal(err)
		}
		write(t, f.Cert, string(certPEM), 0o644)
		write(t, f.Key, string(keyPEM), 0o600)
	}
	now := time.Now()

	putPair(c.Names, now.AddDate(-2, 0, 0), now.AddDate(-1, 0, 0))
	before := snapshot(t, root)
	rep = Check(root, 4747, 6006)
	sameFolder(t, root, before)
	if !rep.OK() || rep.Pair == nil || len(rep.Notes) != 1 || !strings.Contains(rep.Notes[0], "expired") || !strings.Contains(rep.Notes[0], f.Cert) {
		t.Errorf("expired: fatal %+v, notes %q", rep.Fatal, rep.Notes)
	}

	putPair([]string{"elsewhere.example", "10.0.0.9"}, now.Add(-time.Hour), now.AddDate(10, 0, 0))
	rep = Check(root, 4747, 6006)
	if !rep.OK() || rep.Pair == nil || len(rep.Notes) != 1 || !strings.Contains(rep.Notes[0], "elsewhere.example") ||
		!strings.Contains(rep.Notes[0], "10.0.0.9") || !strings.Contains(rep.Notes[0], "wb.example") {
		t.Errorf("other names: fatal %+v, notes %q", rep.Fatal, rep.Notes)
	}

	putPair([]string{"elsewhere.example"}, now.AddDate(-2, 0, 0), now.AddDate(-1, 0, 0))
	if rep = Check(root, 4747, 6006); !rep.OK() || len(rep.Notes) != 2 || rep.Message(testExe, "") != "" {
		t.Errorf("both: fatal %+v, notes %q", rep.Fatal, rep.Notes)
	}

	// The same names in another order and case are the list.
	rev := make([]string, len(c.Names))
	for i, n := range c.Names {
		rev[len(rev)-1-i] = n
	}
	putPair(rev, now.Add(-time.Hour), now.AddDate(10, 0, 0))
	if rep = Check(root, 4747, 6006); !rep.OK() || len(rep.Notes) != 0 {
		t.Errorf("the list in another order: notes %q", rep.Notes)
	}
}

func TestCheckOwnersPair(t *testing.T) {
	root, f := setUp(t)
	c, _, _ := LoadConfig(root)
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	edPub, edKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8 := func(key any) []byte {
		der, err := x509.MarshalPKCS8PrivateKey(key)
		if err != nil {
			t.Fatal(err)
		}
		return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	}
	for _, tc := range []struct {
		name     string
		pub, key any
		keyPEM   []byte
	}{
		{"RSA, PKCS #8", &rsaKey.PublicKey, rsaKey, pkcs8(rsaKey)},
		{"RSA, PKCS #1", &rsaKey.PublicKey, rsaKey, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(rsaKey)})},
		{"Ed25519", edPub, edKey, pkcs8(edKey)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tmpl := &x509.Certificate{
				SerialNumber: big.NewInt(7),
				Subject:      pkix.Name{CommonName: "the owner's"},
				NotBefore:    time.Now().Add(-time.Hour),
				NotAfter:     time.Now().Add(24 * time.Hour),
				DNSNames:     c.Names,
			}
			der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, tc.pub, tc.key)
			if err != nil {
				t.Fatal(err)
			}
			write(t, f.Cert, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), 0o644)
			write(t, f.Key, string(tc.keyPEM), 0o600)
			before := snapshot(t, root)
			rep := Check(root, 4747, 6006)
			sameFolder(t, root, before)
			if !rep.OK() || rep.Pair == nil || rep.Fingerprint != Fingerprint(der) {
				t.Fatalf("fatal %+v, fingerprint %q", rep.Fatal, rep.Fingerprint)
			}
			if len(rep.Pair.Certificate) != 1 || string(rep.Pair.Certificate[0]) != string(der) {
				t.Error("the pair is not the owner's certificate")
			}
			// Set-up keeps an owner's pair.
			if made, err := Setup(root, SetupOptions{}); err != nil || made != (Made{}) {
				t.Errorf("set-up over the owner's pair: %+v, %v", made, err)
			}
			sameFolder(t, root, before)
		})
	}
}
