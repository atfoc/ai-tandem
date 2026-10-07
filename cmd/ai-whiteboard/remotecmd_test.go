package main

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/store"
)

// own runs one of the commands of ownCommand in-process. Every test passes its own -home.
func own(t *testing.T, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	var out, errOut bytes.Buffer
	cmd, rest := command(args)
	code, ok := ownCommand(cmd, rest, &out, &errOut)
	if !ok {
		t.Fatalf("ownCommand did not take %q", args)
	}
	return out.String(), errOut.String(), code
}

// folder reads every file of dir: name to mode and content.
func folder(t *testing.T, dir string) map[string]string {
	t.Helper()
	got := map[string]string{}
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		got[e.Name()] = fmt.Sprintf("%v %s", info.Mode(), b)
	}
	return got
}

func sameFolder(t *testing.T, dir string, want map[string]string) {
	t.Helper()
	got := folder(t, dir)
	if len(got) != len(want) {
		t.Fatalf("the folder has %d files, want %d", len(got), len(want))
	}
	for name, v := range want {
		if got[name] != v {
			t.Fatalf("%s changed", name)
		}
	}
}

// secretOf reads the secret of home, to assert that an output does not hold it.
func secretOf(t *testing.T, home string) string {
	t.Helper()
	s, err := remote.ReadSecret(home)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func noSecret(t *testing.T, secret string, streams ...string) {
	t.Helper()
	for _, s := range streams {
		if strings.Contains(s, secret) {
			t.Fatalf("the output holds the secret:\n%s", s)
		}
	}
}

var fingerprintForm = regexp.MustCompile(`^([0-9A-F]{2}:){31}[0-9A-F]{2}$`)

func TestRemoteSetupCommand(t *testing.T) {
	home := filepath.Join(t.TempDir(), "data")
	out, errOut, code := own(t, "remote", "setup", "-home", home, "-name", "wb.example")
	if code != 0 || errOut != "" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	c, found, err := remote.LoadConfig(home)
	if !found || err != nil {
		t.Fatalf("configuration: found %v, %v", found, err)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 6 {
		t.Fatalf("want six lines, got:\n%s", out)
	}
	want := []string{
		"Remote access is set up in " + home + ".",
		"Port: 4748",
		"Names: " + strings.Join(c.Names, ", "),
		"",
		"Server port: 4747",
		"Next start: will listen",
	}
	for i, w := range want {
		if w != "" && lines[i] != w {
			t.Fatalf("line %d = %q, want %q", i+1, lines[i], w)
		}
	}
	fp, ok := strings.CutPrefix(lines[3], "Fingerprint: ")
	if !ok || !fingerprintForm.MatchString(fp) {
		t.Fatalf("line 4 = %q", lines[3])
	}
	certPEM, err := os.ReadFile(remote.FilesIn(home).Cert)
	if err != nil {
		t.Fatal(err)
	}
	if onDisk, err := remote.FingerprintOfPEM(certPEM); err != nil || onDisk != fp {
		t.Fatalf("fingerprint %q, on disk %q (%v)", fp, onDisk, err)
	}
	if c.Names[len(c.Names)-1] != "wb.example" {
		t.Fatalf("names = %v", c.Names)
	}
	noSecret(t, secretOf(t, home), out, errOut)

	// A second run prints the same and changes no file.
	before := folder(t, home)
	out2, errOut2, code := own(t, "remote", "setup", "-home", home)
	if code != 0 || errOut2 != "" || out2 != out {
		t.Fatalf("second run: code %d, stderr %q, stdout:\n%s", code, errOut2, out2)
	}
	sameFolder(t, home, before)
}

func TestRemoteSetupFlags(t *testing.T) {
	home := t.TempDir()
	out, errOut, code := own(t, "remote", "setup", "-port", "5099", "-name", "One.example", "--name", "10.1.2.3", "-home", home)
	if code != 0 {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	c, _, err := remote.LoadConfig(home)
	if err != nil {
		t.Fatal(err)
	}
	n := len(c.Names)
	if c.Port != 5099 || n < 2 || c.Names[n-2] != "one.example" || c.Names[n-1] != "10.1.2.3" {
		t.Fatalf("configuration = %+v", c)
	}
	if !strings.Contains(out, "Port: 5099\n") || !strings.Contains(out, "one.example, 10.1.2.3\n") {
		t.Fatalf("stdout:\n%s", out)
	}

	// A later run keeps what it is not given.
	if _, _, code := own(t, "remote", "setup", "--home", home, "--name", "two.example"); code != 0 {
		t.Fatalf("code %d", code)
	}
	c, _, _ = remote.LoadConfig(home)
	if c.Port != 5099 || len(c.Names) != n+1 || c.Names[n] != "two.example" {
		t.Fatalf("configuration = %+v", c)
	}

	// The remote port equal to the server's own: the check is fatal.
	out, errOut, code = own(t, "remote", "setup", "-home", home, "-server-port", "5099")
	if code != 1 || !strings.Contains(out, "Next start: the server will not start\n") {
		t.Fatalf("code %d, stdout:\n%s", code, out)
	}
	for _, want := range []string{"Remote access: the remote port 5099", "To repair: ", "remote setup -port N -home ", "remote off -home "} {
		if !strings.Contains(errOut, want) {
			t.Fatalf("stderr lacks %q:\n%s", want, errOut)
		}
	}

	// Usage errors exit 2 and write nothing.
	before := folder(t, home)
	for _, args := range [][]string{
		{"remote", "setup", "-home", home, "-name", "https://x.example"},
		{"remote", "setup", "-home", home, "-name", "x.example:4748"},
		{"remote", "setup", "-home", home, "-port", "70000"},
		{"remote", "setup", "-home", home, "-port", "x"},
		{"remote", "setup", "-home", home, "-nope"},
		{"remote", "setup", "-home", home, "extra"},
	} {
		out, errOut, code := own(t, args...)
		if code != 2 || out != "" || errOut == "" {
			t.Fatalf("%q: code %d, stdout %q, stderr %q", args, code, out, errOut)
		}
	}
	sameFolder(t, home, before)
}

func TestRemoteSetupNewCertNeedsConfig(t *testing.T) {
	home := filepath.Join(t.TempDir(), "data")
	out, errOut, code := own(t, "remote", "setup", "-new-cert", "-home", home)
	if code != 1 || out != "" {
		t.Fatalf("code %d, stdout %q", code, out)
	}
	if !strings.HasPrefix(errOut, "Remote access is not set up: run ") || !strings.Contains(errOut, fmt.Sprintf(" remote setup -home %q\n", home)) {
		t.Fatalf("stderr %q", errOut)
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("the folder was made: %v", err)
	}

	// With a configuration: key and certificate are replaced, the rest is kept.
	if _, _, code := own(t, "remote", "setup", "-home", home); code != 0 {
		t.Fatalf("code %d", code)
	}
	before := folder(t, home)
	out, errOut, code = own(t, "remote", "setup", "--new-cert", "-home", home)
	if code != 0 || !strings.Contains(out, "Next start: will listen\n") {
		t.Fatalf("code %d, stderr %q, stdout:\n%s", code, errOut, out)
	}
	after := folder(t, home)
	for _, name := range []string{"remote-key.pem", "remote-cert.pem"} {
		if after[name] == before[name] {
			t.Fatalf("%s was not replaced", name)
		}
	}
	for _, name := range []string{"remote.json", "remote-secret"} {
		if after[name] != before[name] {
			t.Fatalf("%s changed", name)
		}
	}
}

func TestRemoteOffCommand(t *testing.T) {
	home := t.TempDir()
	out, errOut, code := own(t, "remote", "off", "-home", home)
	if code != 0 || errOut != "" || out != "Remote access was not set up in "+home+".\n" {
		t.Fatalf("code %d, stderr %q, stdout %q", code, errOut, out)
	}

	setup, _, _ := own(t, "remote", "setup", "-home", home)
	secret := secretOf(t, home)
	out, errOut, code = own(t, "remote", "off", "-home", home)
	if code != 0 || errOut != "" || out != "Remote access is off in "+home+". A running server keeps it until its next start.\n" {
		t.Fatalf("code %d, stderr %q, stdout %q", code, errOut, out)
	}
	if _, found, _ := remote.LoadConfig(home); found {
		t.Fatal("remote.json is still there")
	}

	// A set-up after it gives the same secret and fingerprint.
	again, _, code := own(t, "remote", "setup", "-home", home)
	if code != 0 || again != setup || secretOf(t, home) != secret {
		t.Fatalf("code %d, stdout:\n%s\nwant:\n%s", code, again, setup)
	}

	if _, _, code := own(t, "remote", "off", "-home", home, "extra"); code != 2 {
		t.Fatalf("code %d, want 2", code)
	}
}

func TestRemoteStatusFromFiles(t *testing.T) {
	home := t.TempDir()
	// Nothing listens on this port: the status asks no other.
	port := strconv.Itoa(freePort(t))

	out, errOut, code := own(t, "remote", "status", "-home", home, "-server-port", port)
	if code != 0 || errOut != "" || out != "Running: no server\nFiles: not set up\n" {
		t.Fatalf("code %d, stderr %q, stdout %q", code, errOut, out)
	}

	setup, _, _ := own(t, "remote", "setup", "-home", home, "-server-port", port)
	secret := secretOf(t, home)
	before := folder(t, home)
	out, errOut, code = own(t, "remote", "status", "-home", home, "-server-port", port)
	if code != 0 || errOut != "" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	// The files' part is set-up's three lines.
	fromFiles := strings.Join(strings.Split(setup, "\n")[1:4], "\n")
	if want := "Running: no server\nFiles: the next start will listen\n" + fromFiles + "\n"; out != want {
		t.Fatalf("stdout:\n%s\nwant:\n%s", out, want)
	}
	noSecret(t, secret, out, errOut)

	// The remote port equal to the server's own.
	out, errOut, code = own(t, "remote", "status", "-home", home, "-server-port", "4748")
	if code != 1 || !strings.Contains(out, "Files: the server will not start\nPort: 4748\n") || !strings.Contains(errOut, "remote setup -port N") {
		t.Fatalf("code %d, stdout:\n%s\nstderr:\n%s", code, out, errOut)
	}

	// The key removed: exit 1 with the check's message.
	f := remote.FilesIn(home)
	if err := os.Remove(f.Key); err != nil {
		t.Fatal(err)
	}
	out, errOut, code = own(t, "remote", "status", "-home", home, "-server-port", port)
	if code != 1 {
		t.Fatalf("code %d, want 1", code)
	}
	for _, want := range []string{"Running: no server\n", "Files: the server will not start\n", "Port: 4748\n", "Names: ", "Fingerprint: "} {
		if !strings.Contains(out, want) {
			t.Fatalf("stdout lacks %q:\n%s", want, out)
		}
	}
	for _, want := range []string{"Remote access: ", f.Key, "The start creates nothing.", "To repair: ", "remote setup -new-cert -home ", "To start without remote access: ", "remote off -home "} {
		if !strings.Contains(errOut, want) {
			t.Fatalf("stderr lacks %q:\n%s", want, errOut)
		}
	}
	if n := strings.Count(errOut, "\n"); n > 6 || !strings.HasSuffix(errOut, "\n") {
		t.Fatalf("stderr has %d lines:\n%s", n, errOut)
	}
	noSecret(t, secret, out, errOut)

	// The status writes nothing.
	delete(before, "remote-key.pem")
	sameFolder(t, home, before)

	if _, _, code := own(t, "remote", "status", "-home", home, "-server-port", "x"); code != 2 {
		t.Fatalf("code %d, want 2", code)
	}
}

// standInID is the instance id the stand-in servers state in hello.
const standInID = "0d9f1c52-6a3e-4b7f-8c21-5e4d3c2b1a09"

// asThisFolders writes id as home's instance id, as the folder's first start does: a server that
// states it in hello then counts as this data folder's.
func asThisFolders(t *testing.T, home, id string) {
	t.Helper()
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(remote.FilesIn(home).InstanceID, []byte(id+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// standIn is a server that answers hello, with the instance id standInID and no feature level,
// the state read, with home as its data folder, and, when status is not "", the remote status
// route.
func standIn(home, status string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/hello":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"app":"ai-whiteboard","version":"dev","pid":%d,"instanceId":%q}`, os.Getpid(), standInID)
		case r.URL.Path == "/api/state":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"dataDir":%q}`, home)
		case r.URL.Path == "/api/remote/status" && status != "":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, status)
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestRemoteStatusAgainstServer(t *testing.T) {
	const fp = "AB:CD:EF"
	cases := []struct {
		name, status, want string
	}{
		{"listening", `{"listening":true,"port":5123,"names":["mac.local","192.168.1.20"],"fingerprint":"` + fp + `"}`,
			"Running: listening\nRunning port: 5123\nRunning names: mac.local, 192.168.1.20\nRunning fingerprint: " + fp + "\n"},
		{"off", `{"listening":false}`, "Running: off\n"},
		{"older build", "", "Running: older build, reported from the files alone\n"},
		{"not JSON", "<html>", "Running: older build, reported from the files alone\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			srv := standIn(home, tc.status)
			defer srv.Close()
			asThisFolders(t, home, standInID)
			port := strconv.Itoa(portOf(t, srv))

			out, errOut, code := own(t, "remote", "status", "-home", home, "-server-port", port)
			if code != 0 || errOut != "" || out != tc.want+"Files: not set up\n" {
				t.Fatalf("code %d, stderr %q, stdout:\n%s", code, errOut, out)
			}

			// Found through server.json too, and the files are reported after it.
			writeServerFile(t, store.NewPaths(home), portOf(t, srv))
			if _, _, code := own(t, "remote", "setup", "-home", home); code != 0 {
				t.Fatalf("set-up: code %d", code)
			}
			out, errOut, code = own(t, "remote", "status", "-home", home)
			if code != 0 || errOut != "" || !strings.HasPrefix(out, tc.want+"Files: the next start will listen\nPort: 4748\nNames: ") {
				t.Fatalf("code %d, stderr %q, stdout:\n%s", code, errOut, out)
			}
			noSecret(t, secretOf(t, home), out, errOut)
		})
	}
}

// untouched is a listener that must get no connection: it stands where a command must not look.
// The function it returns fails the test when one arrived.
func untouched(t *testing.T) (port int, check func(what string)) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var n atomic.Int64
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			n.Add(1)
			c.Close()
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return ln.Addr().(*net.TCPAddr).Port, func(what string) {
		t.Helper()
		if got := n.Load(); got != 0 {
			t.Fatalf("%s: %d connections to a port the command must not ask", what, got)
		}
	}
}

// The status reports a running server only when it is this data folder's: another folder's
// server on the port is not it, and no port but the given one, or else server.json's, is asked.
func TestRemoteStatusOfThisFolderOnly(t *testing.T) {
	const listening = `{"listening":true,"port":5123,"names":["mac.local"],"fingerprint":"AB:CD"}`
	const otherID = "7b1e9d40-2c5a-4f38-a6d7-0e1f2a3b4c5d"
	mine := t.TempDir()
	srv := standIn(mine, listening) // states standInID and the data folder mine
	defer srv.Close()
	srvPort := strconv.Itoa(portOf(t, srv))
	const alone = "Running: no server\nFiles: not set up\n"

	status := func(t *testing.T, want string, args ...string) {
		t.Helper()
		out, errOut, code := own(t, append([]string{"remote", "status"}, args...)...)
		if code != 0 || errOut != "" || out != want {
			t.Fatalf("code %d, stderr %q, stdout:\n%s\nwant:\n%s", code, errOut, out, want)
		}
	}

	t.Run("another folder's server on the given port", func(t *testing.T) {
		home := t.TempDir()
		asThisFolders(t, home, otherID)
		// server.json names a second port: with -server-port given it is not asked.
		second, check := untouched(t)
		writeServerFile(t, store.NewPaths(home), second)
		status(t, alone, "-home", home, "-server-port", srvPort)
		check("another instance id on -server-port")
	})
	t.Run("another folder's server on server.json's port", func(t *testing.T) {
		home := t.TempDir()
		asThisFolders(t, home, otherID)
		writeServerFile(t, store.NewPaths(home), portOf(t, srv))
		status(t, alone, "-home", home)
	})
	t.Run("no instance id yet", func(t *testing.T) {
		home := t.TempDir()
		status(t, alone, "-home", home, "-server-port", srvPort)
		writeServerFile(t, store.NewPaths(home), portOf(t, srv))
		status(t, alone, "-home", home)
	})
	t.Run("no server.json and no port given", func(t *testing.T) {
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		var asked atomic.Int64
		prev := http.DefaultTransport
		http.DefaultTransport = roundTrip(func(r *http.Request) (*http.Response, error) {
			asked.Add(1)
			return nil, errors.New("no request may be made")
		})
		defer func() { http.DefaultTransport = prev }()
		status(t, alone, "-home", home)
		if asked.Load() != 0 {
			t.Fatalf("%d requests with no port to ask", asked.Load())
		}
	})
	t.Run("a copy of the server's folder", func(t *testing.T) {
		home := t.TempDir()
		asThisFolders(t, home, standInID)
		status(t, alone, "-home", home, "-server-port", srvPort)
		writeServerFile(t, store.NewPaths(home), portOf(t, srv))
		status(t, alone, "-home", home)
	})
	t.Run("this folder's server", func(t *testing.T) {
		asThisFolders(t, mine, standInID)
		const running = "Running: listening\nRunning port: 5123\nRunning names: mac.local\nRunning fingerprint: AB:CD\nFiles: not set up\n"
		status(t, running, "-home", mine, "-server-port", srvPort)
		// The folder by another path: a symlink to it is the same folder.
		link := filepath.Join(t.TempDir(), "link")
		if err := os.Symlink(mine, link); err != nil {
			t.Fatal(err)
		}
		status(t, running, "-home", link, "-server-port", srvPort)
	})
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestSecretCommand(t *testing.T) {
	home := filepath.Join(t.TempDir(), "data")

	// Without a configuration: 1, the repair, nothing written.
	for _, args := range [][]string{{"secret", "-home", home}, {"secret", "-new", "-home", home}} {
		out, errOut, code := own(t, args...)
		if code != 1 || out != "" || !strings.Contains(errOut, fmt.Sprintf(" remote setup -home %q\n", home)) {
			t.Fatalf("%q: code %d, stdout %q, stderr %q", args, code, out, errOut)
		}
		if _, err := os.Stat(home); !os.IsNotExist(err) {
			t.Fatalf("%q made the folder: %v", args, err)
		}
	}

	own(t, "remote", "setup", "-home", home)
	secret := secretOf(t, home)
	out, errOut, code := own(t, "secret", "-home", home)
	if code != 0 || errOut != "" || out != secret+"\n" {
		t.Fatalf("code %d, stderr %q, stdout %q", code, errOut, out)
	}

	before := folder(t, home)
	out, errOut, code = own(t, "secret", "--new", "-home", home)
	fresh := secretOf(t, home)
	if code != 0 || out != fresh+"\n" || fresh == secret {
		t.Fatalf("code %d, stdout %q, the old secret %q", code, out, secret)
	}
	if errOut != "The new secret takes effect at the server's next start.\n" {
		t.Fatalf("stderr %q", errOut)
	}
	noSecret(t, fresh, errOut)
	after := folder(t, home)
	if !strings.HasPrefix(after["remote-secret"], "-rw------- ") {
		t.Fatalf("the secret's mode: %q", after["remote-secret"][:11])
	}
	for name, v := range before {
		if name != "remote-secret" && after[name] != v {
			t.Fatalf("%s changed", name)
		}
	}
	if len(after) != len(before) {
		t.Fatalf("the folder has %d files, want %d", len(after), len(before))
	}
	if out, _, _ := own(t, "secret", "-home", home); out != fresh+"\n" {
		t.Fatalf("secret = %q, want the new one", out)
	}

	// A secret that is not in set-up's form: 1, and the repair is secret -new.
	if err := os.WriteFile(remote.FilesIn(home).Secret, []byte("not a secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out, errOut, code = own(t, "secret", "-home", home)
	if code != 1 || out != "" || !strings.Contains(errOut, fmt.Sprintf("To repair: %q secret -new -home %q\n", exePath(), home)) {
		t.Fatalf("code %d, stdout %q, stderr %q", code, out, errOut)
	}
	if strings.Contains(errOut, "not a secret") {
		t.Fatalf("stderr holds the file's content: %q", errOut)
	}

	// After remote off, secret -new is refused and the secret is kept.
	own(t, "secret", "-new", "-home", home)
	kept := secretOf(t, home)
	own(t, "remote", "off", "-home", home)
	if _, _, code := own(t, "secret", "-new", "-home", home); code != 1 || secretOf(t, home) != kept {
		t.Fatalf("code %d, or the secret changed", code)
	}

	if _, _, code := own(t, "secret", "-home", home, "extra"); code != 2 {
		t.Fatalf("code %d, want 2", code)
	}
}

func TestOwnCommand(t *testing.T) {
	for _, cmd := range []string{"serve", "launch", "relaunch", "stop", "nope"} {
		var out, errOut bytes.Buffer
		if code, ok := ownCommand(cmd, []string{"-home", t.TempDir()}, &out, &errOut); ok || code != 0 || out.Len()+errOut.Len() != 0 {
			t.Fatalf("%s: taken (code %d, output %q %q)", cmd, code, out.String(), errOut.String())
		}
	}
	for _, args := range [][]string{
		{"remote"},
		{"remote", "x"},
		{"remote", "-home", t.TempDir()},
		{"secret", "-x"},
	} {
		out, errOut, code := own(t, args...)
		if code != 2 || out != "" || errOut == "" {
			t.Fatalf("%q: code %d, stdout %q, stderr %q", args, code, out, errOut)
		}
	}
}
