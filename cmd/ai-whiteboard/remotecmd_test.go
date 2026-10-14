package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"ai-whiteboard/internal/remote"
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

// fingerprintOf is the fingerprint of the certificate in dir.
func fingerprintOf(t *testing.T, dir string) string {
	t.Helper()
	b, err := os.ReadFile(remote.FilesIn(dir).Cert)
	if err != nil {
		t.Fatal(err)
	}
	fp, err := remote.FingerprintOfPEM(b)
	if err != nil {
		t.Fatal(err)
	}
	return fp
}

var fingerprintForm = regexp.MustCompile(`^([0-9A-F]{2}:){31}[0-9A-F]{2}$`)

func TestRemoteSetupCommand(t *testing.T) {
	t.Parallel()
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
	if len(lines) != 5 {
		t.Fatalf("want five lines, got:\n%s", out)
	}
	want := []string{
		"Remote access is set up in " + home + ".",
		"Port: 4748",
		"Names: " + strings.Join(c.Names, ", "),
		"",
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
	if onDisk := fingerprintOf(t, home); onDisk != fp {
		t.Fatalf("fingerprint %q, on disk %q", fp, onDisk)
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
	t.Parallel()
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
	if strings.Contains(out, "Server port") {
		t.Fatalf("set-up still prints a server port:\n%s", out)
	}

	// A later run keeps what it is not given.
	if _, _, code := own(t, "remote", "setup", "--home", home, "--name", "two.example"); code != 0 {
		t.Fatalf("code %d", code)
	}
	c, _, _ = remote.LoadConfig(home)
	if c.Port != 5099 || len(c.Names) != n+1 || c.Names[n] != "two.example" {
		t.Fatalf("configuration = %+v", c)
	}

	// The client port equal to the MCP port: the check is fatal.
	out, errOut, code = own(t, "remote", "setup", "-home", home, "-port", strconv.Itoa(mcpPort()))
	if code != 1 || !strings.Contains(out, "Next start: the server will not start\n") {
		t.Fatalf("code %d, stdout:\n%s", code, out)
	}
	for _, want := range []string{"is the MCP port", "To repair: ", "remote setup -port N -home "} {
		if !strings.Contains(errOut, want) {
			t.Fatalf("stderr lacks %q:\n%s", want, errOut)
		}
	}
	if strings.Contains(errOut, "remote off") {
		t.Fatalf("stderr offers the command that is gone:\n%s", errOut)
	}

	// Usage errors exit 2 and write nothing. -server-port is gone.
	own(t, "remote", "setup", "-home", home, "-port", "5099")
	before := folder(t, home)
	for _, args := range [][]string{
		{"remote", "setup", "-home", home, "-name", "https://x.example"},
		{"remote", "setup", "-home", home, "-name", "x.example:4748"},
		{"remote", "setup", "-home", home, "-port", "70000"},
		{"remote", "setup", "-home", home, "-port", "x"},
		{"remote", "setup", "-home", home, "-nope"},
		{"remote", "setup", "-home", home, "-server-port", "4747"},
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
	t.Parallel()
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

// "remote off" is gone and "remote status" is "status": both end with exit 2 and say so, and
// change nothing.
func TestRemoteOffAndStatusAreGone(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	own(t, "remote", "setup", "-home", home)
	before := folder(t, home)
	const message = `"remote status" is now "status"; "remote off" is gone: a server always serves its clients over HTTPS with the secret.` + "\n"
	for _, args := range [][]string{
		{"remote", "off", "-home", home},
		{"remote", "status", "-home", home},
		{"remote", "off"},
		{"remote", "status", "-home", home, "-server-port", "4747"},
	} {
		out, errOut, code := own(t, args...)
		if code != 2 || out != "" || errOut != message {
			t.Fatalf("%q: code %d, stdout %q, stderr %q", args, code, out, errOut)
		}
	}
	sameFolder(t, home, before)
}

// ---- status ------------------------------------------------------------------------------------

func TestStatusFromFiles(t *testing.T) {
	t.Parallel()
	home := t.TempDir()

	// Never set up: exit 1 with the message that names the set-up command.
	out, errOut, code := own(t, "status", "-home", home)
	if code != 1 || out != "Running: no server\nFiles: not set up\n" ||
		errOut != "AI Whiteboard is not set up on this machine. Set it up once with: "+fmt.Sprintf("%q remote setup -home %q\n", exePath(), home) {
		t.Fatalf("code %d, stdout %q, stderr %q", code, out, errOut)
	}

	setup, _, _ := own(t, "remote", "setup", "-home", home)
	secret := secretOf(t, home)
	before := folder(t, home)
	out, errOut, code = own(t, "status", "-home", home)
	if code != 0 || errOut != "" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	// The files' part is set-up's three lines.
	fromFiles := strings.Join(strings.Split(setup, "\n")[1:4], "\n")
	if want := "Running: no server\nFiles: the next start will listen\n" + fromFiles + "\n"; out != want {
		t.Fatalf("stdout:\n%s\nwant:\n%s", out, want)
	}
	noSecret(t, secret, out, errOut)

	// The client port equal to the MCP port.
	own(t, "remote", "setup", "-home", home, "-port", strconv.Itoa(mcpPort()))
	out, errOut, code = own(t, "status", "-home", home)
	if code != 1 || !strings.Contains(out, "Files: the server will not start\nPort: "+strconv.Itoa(mcpPort())+"\n") || !strings.Contains(errOut, "remote setup -port N") {
		t.Fatalf("code %d, stdout:\n%s\nstderr:\n%s", code, out, errOut)
	}
	own(t, "remote", "setup", "-home", home, "-port", "4748")

	// The key removed: exit 1 with the check's message.
	f := remote.FilesIn(home)
	if err := os.Remove(f.Key); err != nil {
		t.Fatal(err)
	}
	out, errOut, code = own(t, "status", "-home", home)
	if code != 1 {
		t.Fatalf("code %d, want 1", code)
	}
	for _, want := range []string{"Running: no server\n", "Files: the server will not start\n", "Port: 4748\n", "Names: ", "Fingerprint: "} {
		if !strings.Contains(out, want) {
			t.Fatalf("stdout lacks %q:\n%s", want, out)
		}
	}
	for _, want := range []string{"Remote access: ", f.Key, "The start creates nothing.", "To repair: ", "remote setup -new-cert -home "} {
		if !strings.Contains(errOut, want) {
			t.Fatalf("stderr lacks %q:\n%s", want, errOut)
		}
	}
	if n := strings.Count(errOut, "\n"); n > 5 || !strings.HasSuffix(errOut, "\n") {
		t.Fatalf("stderr has %d lines:\n%s", n, errOut)
	}
	noSecret(t, secret, out, errOut)

	// The status writes nothing.
	delete(before, "remote-key.pem")
	_ = before
	if _, _, code := own(t, "status", "-home", home, "-server-port", "x"); code != 2 {
		t.Fatalf("code %d, want 2", code)
	}
	if _, _, code := own(t, "status", "-home", home, "extra"); code != 2 {
		t.Fatalf("code %d, want 2", code)
	}
}

// The status of a server running: this build's address, port, names, fingerprint and MCP listener
// from the control socket, what the files say after it, and for the build before a line.
func TestStatusOfARunningServer(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	own(t, "remote", "setup", "-home", home)
	asThisFolders(t, home, standInID)
	s := (&standIn{version: "1.2.3", listening: true, port: 5123, names: []string{"mac.local", "192.168.1.20"}, fingerprint: "AB:CD:EF"}).withPid(t)
	s.this(t, home, true)

	out, errOut, code := own(t, "status", "-home", home)
	if code != 0 || errOut != "" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	wantRunning := "Running: this build 1.2.3 (pid " + strconv.Itoa(s.pid) + ")\nAddress: https://127.0.0.1:5123\nPort: 5123\nNames: mac.local, 192.168.1.20\n" +
		"Fingerprint: AB:CD:EF\nMCP listener: http://localhost:6006/mcp (up)\nFiles: the next start will listen\nPort: 4748\n"
	if !strings.HasPrefix(out, wantRunning) {
		t.Fatalf("stdout:\n%s\nwant it to start:\n%s", out, wantRunning)
	}
	noSecret(t, secretOf(t, home), out, errOut)

	// A server that does not serve yet has no address.
	home2 := t.TempDir()
	own(t, "remote", "setup", "-home", home2)
	asThisFolders(t, home2, standInID)
	(&standIn{version: "1.2.3"}).withPid(t).this(t, home2, true)
	out, _, _ = own(t, "status", "-home", home2)
	if !strings.HasPrefix(out, "Running: this build 1.2.3 (pid ") || strings.Contains(out, "Address:") || !strings.Contains(out, "MCP listener: http://localhost:6006/mcp (up)\nFiles: ") {
		t.Fatalf("stdout:\n%s", out)
	}

	// The build before: a line, and the files.
	home3 := t.TempDir()
	own(t, "remote", "setup", "-home", home3)
	asThisFolders(t, home3, standInID)
	old := (&standIn{version: "0.9.0"}).withPid(t)
	old.older(t, home3, true)
	out, errOut, code = own(t, "status", "-home", home3)
	if code != 0 || errOut != "" || !strings.HasPrefix(out, "Running: older build 0.9.0 (pid "+strconv.Itoa(old.pid)+")\nFiles: the next start will listen\n") {
		t.Fatalf("code %d, stderr %q, stdout:\n%s", code, errOut, out)
	}
}

// `status -json` is one object, also when the exit is 1.
func TestStatusJSON(t *testing.T) {
	t.Parallel()
	type result struct {
		Running map[string]any
		Files   map[string]any
	}
	status := func(t *testing.T, home string, wantCode int) (result, string) {
		t.Helper()
		out, errOut, code := own(t, "status", "-json", "-home", home)
		var r result
		if code != wantCode || strings.Count(out, "\n") != 1 || json.Unmarshal([]byte(out), &r) != nil {
			t.Fatalf("code %d (want %d), stdout %q, stderr %q", code, wantCode, out, errOut)
		}
		return r, errOut
	}

	t.Run("not set up", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		r, errOut := status(t, home, 1)
		if r.Running != nil || r.Files["setUp"] != false || r.Files["ok"] != false || !strings.Contains(fmt.Sprint(r.Files["message"]), "Set it up once with: ") ||
			r.Files["notes"] == nil || errOut == "" {
			t.Fatalf("%+v, stderr %q", r, errOut)
		}
		if _, has := r.Files["port"]; has {
			t.Fatalf("a folder never set up has a port: %v", r.Files)
		}
	})
	t.Run("this build", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		own(t, "remote", "setup", "-home", home, "-port", "5099", "-name", "wb.example")
		asThisFolders(t, home, standInID)
		s := (&standIn{version: "1.2.3", listening: true, port: 5123}).withPid(t)
		s.this(t, home, true)
		r, errOut := status(t, home, 0)
		if errOut != "" {
			t.Fatalf("stderr %q", errOut)
		}
		client, _ := r.Running["client"].(map[string]any)
		mcp, _ := r.Running["mcp"].(map[string]any)
		listener, _ := mcp["listener"].(map[string]any)
		if r.Running["build"] != "this" || r.Running["version"] != "1.2.3" || r.Running["pid"] != float64(s.pid) || r.Running["featureLevel"] != float64(6) ||
			r.Running["instanceId"] != standInID || client["listening"] != true || client["address"] != "https://127.0.0.1:5123" || client["port"] != float64(5123) ||
			client["fingerprint"] != "AB:CD:EF" || client["secretReloads"] != float64(0) || listener["up"] != true || mcp["chats"] == nil {
			t.Fatalf("running: %+v", r.Running)
		}
		// What the next start will do is the files': the port set up after the server started.
		if r.Files["setUp"] != true || r.Files["ok"] != true || r.Files["port"] != float64(5099) || !fingerprintForm.MatchString(fmt.Sprint(r.Files["fingerprint"])) {
			t.Fatalf("files: %+v", r.Files)
		}
		if names, _ := r.Files["names"].([]any); len(names) == 0 || names[len(names)-1] != "wb.example" {
			t.Fatalf("files: %+v", r.Files)
		}
		if _, has := r.Files["message"]; has {
			t.Fatalf("files has a message though it is ok: %v", r.Files)
		}
	})
	t.Run("the build before", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		own(t, "remote", "setup", "-home", home)
		asThisFolders(t, home, standInID)
		s := (&standIn{version: "0.9.0"}).withPid(t)
		s.older(t, home, true)
		r, _ := status(t, home, 0)
		if r.Running["build"] != "older" || r.Running["version"] != "0.9.0" || r.Running["pid"] != float64(s.pid) || r.Running["featureLevel"] != float64(5) ||
			r.Running["client"] != nil || r.Running["mcp"] != nil {
			t.Fatalf("running: %+v", r.Running)
		}
	})
	t.Run("broken files", func(t *testing.T) {
		t.Parallel()
		home := t.TempDir()
		own(t, "remote", "setup", "-home", home)
		if err := os.Remove(remote.FilesIn(home).Secret); err != nil {
			t.Fatal(err)
		}
		r, _ := status(t, home, 1)
		if r.Files["setUp"] != true || r.Files["ok"] != false || !strings.Contains(fmt.Sprint(r.Files["message"]), "To repair: ") || r.Running != nil {
			t.Fatalf("files: %+v", r.Files)
		}
	})
}

// ---- secret ------------------------------------------------------------------------------------

func TestSecretCommand(t *testing.T) {
	t.Parallel()
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

	if _, _, code := own(t, "secret", "-home", home, "extra"); code != 2 {
		t.Fatalf("code %d, want 2", code)
	}
}

func TestOwnCommand(t *testing.T) {
	t.Parallel()
	for _, cmd := range []string{"serve", "launch", "relaunch", "nope"} {
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
		{"stop", "-port", "4747"},
		{"status", "-claude", "x"},
	} {
		out, errOut, code := own(t, args...)
		if code != 2 || out != "" || errOut == "" {
			t.Fatalf("%q: code %d, stdout %q, stderr %q", args, code, out, errOut)
		}
	}
}
