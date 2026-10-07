package main

import (
	"bytes"
	"context"
	"debug/elf"
	"debug/macho"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/servers"
)

// The scripts of scripts/remote, run through sh as the README calls them, on a scratch data folder
// with its own ports.

// webMark is in the index.html of the stand-in web client: a server that serves it was given the
// folder.
const webMark = "<title>scripts test</title>"

// scriptsDir is scripts/remote of this repository.
func scriptsDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(filepath.Join("..", "..", "scripts", "remote"))
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func copyFile(t *testing.T, from, to string, mode os.FileMode) {
	t.Helper()
	b, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, b, mode); err != nil {
		t.Fatal(err)
	}
}

func writeWeb(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html>"+webMark+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// newScriptInstance is newInstance for the scripts: no remote set-up yet, a free remote port, and
// the remote listener bound on 127.0.0.1 as newRemoteInstance binds it. It skips where sh is
// missing.
func newScriptInstance(t *testing.T) (in *instance, remotePort int) {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	in = newInstance(t)
	t.Setenv("AIWB_REMOTE_BIND", "127.0.0.1")
	return in, freePort(t)
}

// serverFolder is the folder scripts/build-server.sh makes, with a stand-in web client: the
// binary, web/ and the two scripts side by side. The scripts are copied without their executable
// bit, as a copy may lose it. in.bin becomes the folder's binary. The path has no symlink in it.
func (in *instance) serverFolder(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "server folder")
	copyFile(t, in.bin, filepath.Join(dir, "ai-whiteboard"), 0o755)
	for _, name := range []string{"setup-remote.sh", "start-server.sh"} {
		copyFile(t, filepath.Join(scriptsDir(t), name), filepath.Join(dir, name), 0o644)
	}
	writeWeb(t, filepath.Join(dir, "web"))
	// The scripts name their folder with symlinks resolved.
	dir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	in.bin = filepath.Join(dir, "ai-whiteboard")
	return dir
}

// sh runs `sh <script> <args>` in the folder cwd with no input, and returns its output and exit
// code. It must end by itself.
func sh(t *testing.T, cwd, script string, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var out, errOut bytes.Buffer
	cmd := exec.CommandContext(ctx, "sh", append([]string{script}, args...)...)
	cmd.Dir = cwd
	cmd.Stdout, cmd.Stderr = &out, &errOut // Stdin stays nil: the null device
	// The server a script starts holds the pipes of a plain exec.Cmd open; it has its own log.
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	var ee *exec.ExitError
	switch {
	case ctx.Err() != nil:
		t.Fatalf("%s did not end within 60 s\n%s", script, errOut.String())
	case errors.As(err, &ee):
		code = ee.ExitCode()
	case err != nil && !errors.Is(err, exec.ErrWaitDelay):
		t.Fatalf("%s: %v", script, err)
	}
	return out.String(), errOut.String(), code
}

// own runs one of the commands with their own flags (`remote status`, `remote off`) for this data
// folder and server port.
func (in *instance) own(t *testing.T, words ...string) (stdout, stderr string, code int) {
	t.Helper()
	args := append(words, "-home", in.dir)
	if words[len(words)-1] != "off" {
		args = append(args, "-server-port", strconv.Itoa(in.port))
	}
	var out, errOut bytes.Buffer
	cmd := exec.Command(in.bin, args...)
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("%v: %v", words, err)
	}
	return out.String(), errOut.String(), code
}

// setupArgs are the options every run of setup-remote.sh gets here: the scratch data folder and
// the scratch server's port.
func (in *instance) setupArgs(more ...string) []string {
	return append([]string{"--home", in.dir, "--server-port", strconv.Itoa(in.port)}, more...)
}

// startArgs are the server flags start-server.sh passes on.
func (in *instance) startArgs() []string {
	return []string{"-home", in.dir, "-port", strconv.Itoa(in.port), "-claude", in.claude}
}

func wantAll(t *testing.T, what, text string, parts ...string) {
	t.Helper()
	for _, p := range parts {
		if !strings.Contains(text, p) {
			t.Fatalf("%s lacks %q:\n%s", what, p, text)
		}
	}
}

// changed lists the files of remote access that differ between two readings, sorted.
func changed(before, after map[string]string) string {
	var names []string
	for _, name := range []string{"remote-cert.pem", "remote-key.pem", "remote-secret", "remote.json"} {
		if before[name] != after[name] {
			names = append(names, name)
		}
	}
	return strings.Join(names, " ")
}

// testConnection is the test of the Servers dialog against the remote listener on 127.0.0.1.
func testConnection(t *testing.T, port int, fingerprint, secret string) servers.Result {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	target := servers.Target{Address: fmt.Sprintf("https://127.0.0.1:%d", port), Secret: secret, SelfSigned: true, Pin: fingerprint}
	return servers.TestConnection(ctx, target, servers.Identity{}, servers.Options{Root: t.TempDir(), LocalID: testClient, Version: "test"})
}

// AC36: setup-remote.sh asks nothing and prints the names with the port, the fingerprint and the
// secret; a second run changes nothing and prints the same; after the secret was deleted it makes
// a new one and keeps the rest; --new-cert and --new-secret each replace that one thing.
func TestSetupRemoteScript(t *testing.T) {
	in, remotePort := newScriptInstance(t)
	folder := in.serverFolder(t)
	script := filepath.Join(folder, "setup-remote.sh")
	elsewhere := t.TempDir()
	port := strconv.Itoa(remotePort)

	first, stderr, code := sh(t, elsewhere, script, in.setupArgs("--port", port, "--name", "127.0.0.1")...)
	if code != 0 {
		t.Fatalf("first set-up: exit %d\n%s%s", code, first, stderr)
	}
	files := remoteFiles(t, in.dir)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	wantAll(t, "the first set-up", first,
		"Port: "+port+"\n", "127.0.0.1", "  https://127.0.0.1:"+port+"\n", "Fingerprint: "+fp+"\n", "Secret: "+secret+"\n",
		"Next start: will listen\n", `"`+filepath.Join(folder, "start-server.sh")+`" --restart -home "`+in.dir+`" -port `+strconv.Itoa(in.port))
	if on := strings.Contains(first, "firewall"); on != (runtime.GOOS == "darwin") {
		t.Fatalf("the firewall line on %s: %v\n%s", runtime.GOOS, on, first)
	}
	// AC25: the fingerprint the script prints is the one openssl gives for the certificate.
	t.Run("openssl", func(t *testing.T) {
		openssl, err := exec.LookPath("openssl")
		if err != nil {
			t.Skip("no openssl")
		}
		out, err := exec.Command(openssl, "x509", "-noout", "-fingerprint", "-sha256", "-in", remote.FilesIn(in.dir).Cert).CombinedOutput()
		if err != nil {
			t.Fatalf("openssl: %v\n%s", err, out)
		}
		// openssl prints `sha256 Fingerprint=AB:CD:...` (the label's case differs between
		// versions); the pairs and their ":" separators are the script's, so only the letter
		// case is evened out.
		_, theirs, ok := strings.Cut(strings.TrimSpace(string(out)), "=")
		_, rest, ok2 := strings.Cut(first, "Fingerprint: ")
		ours, _, _ := strings.Cut(rest, "\n")
		if !ok || !ok2 || theirs == "" || strings.ToUpper(theirs) != strings.ToUpper(ours) {
			t.Fatalf("the script printed the fingerprint %q, openssl says %q", ours, out)
		}
	})

	// Again, with the same options and with none but the data folder's: nothing changes.
	for _, args := range [][]string{in.setupArgs("--port", port, "--name", "127.0.0.1"), in.setupArgs(), in.setupArgs("--port=" + port)} {
		again, stderr, code := sh(t, elsewhere, script, args...)
		if code != 0 || again != first {
			t.Fatalf("set-up again with %v: exit %d\n%s%s\nfirst:\n%s", args, code, again, stderr, first)
		}
		sameRemoteFiles(t, in.dir, files)
	}

	// The secret deleted: a new one, the rest kept.
	if err := os.Remove(remote.FilesIn(in.dir).Secret); err != nil {
		t.Fatal(err)
	}
	out, stderr, code := sh(t, elsewhere, script, in.setupArgs()...)
	after := remoteFiles(t, in.dir)
	second := secretOf(t, in.dir)
	if code != 0 || changed(files, after) != "remote-secret" || second == secret {
		t.Fatalf("set-up after the secret was deleted: exit %d, changed %q\n%s%s", code, changed(files, after), out, stderr)
	}
	if want := strings.Replace(first, secret, second, 1); out != want {
		t.Fatalf("set-up after the secret was deleted printed\n%s\nwant\n%s", out, want)
	}
	files = after

	// --new-cert: the key and the certificate, nothing else.
	out, stderr, code = sh(t, elsewhere, script, in.setupArgs("--new-cert")...)
	after = remoteFiles(t, in.dir)
	fp2 := fingerprintOf(t, in.dir)
	if code != 0 || changed(files, after) != "remote-cert.pem remote-key.pem" || fp2 == fp {
		t.Fatalf("--new-cert: exit %d, changed %q\n%s%s", code, changed(files, after), out, stderr)
	}
	if want := strings.Replace(strings.Replace(first, secret, second, 1), fp, fp2, 1); out != want {
		t.Fatalf("--new-cert printed\n%s\nwant\n%s", out, want)
	}
	files = after

	// --new-secret: the secret, nothing else. No server runs, so it takes effect at the next start.
	out, stderr, code = sh(t, elsewhere, script, in.setupArgs("--new-secret")...)
	after = remoteFiles(t, in.dir)
	third := secretOf(t, in.dir)
	if code != 0 || changed(files, after) != "remote-secret" || third == second {
		t.Fatalf("--new-secret: exit %d, changed %q\n%s%s", code, changed(files, after), out, stderr)
	}
	wantAll(t, "--new-secret", out, "Secret: "+third+"\n", "Fingerprint: "+fp2+"\n")
	wantAll(t, "--new-secret's stderr", stderr, nextStart)
	if strings.Contains(out, second) {
		t.Fatalf("--new-secret printed the old secret:\n%s", out)
	}
	files = after

	// An option it does not know: usage, and nothing done.
	if _, stderr, code = sh(t, elsewhere, script, in.setupArgs("--bogus")...); code != 2 || !strings.Contains(stderr, "unknown option --bogus") {
		t.Fatalf("--bogus: exit %d\n%s", code, stderr)
	}
	if _, stderr, code = sh(t, elsewhere, script, "--home"); code != 2 || !strings.Contains(stderr, "--home needs a value") {
		t.Fatalf("--home alone: exit %d\n%s", code, stderr)
	}
	sameRemoteFiles(t, in.dir, files)

	// The key removed: set-up remakes no key and exits 1 with the check's message, and the script
	// shows both what is set up and the message.
	if err := os.Remove(remote.FilesIn(in.dir).Key); err != nil {
		t.Fatal(err)
	}
	out, stderr, code = sh(t, elsewhere, script, in.setupArgs()...)
	if code != 1 {
		t.Fatalf("set-up without the key: exit %d\n%s%s", code, out, stderr)
	}
	wantAll(t, "set-up without the key", out, "Next start: the server will not start\n", "Secret: "+third+"\n")
	wantAll(t, "set-up without the key, stderr", stderr, "remote-key.pem", "remote setup -new-cert")
	if _, err := os.Stat(remote.FilesIn(in.dir).Key); !os.IsNotExist(err) {
		t.Fatalf("the key after a plain set-up: %v, want none", err)
	}
}

// restartLine is the command set-up printed to start or restart the server.
func restartLine(t *testing.T, out string) string {
	t.Helper()
	_, rest, ok := strings.Cut(out, "To start it, or to restart it:\n  ")
	if !ok {
		t.Fatalf("set-up printed no restart line:\n%s", out)
	}
	line, _, _ := strings.Cut(rest, "\n")
	return line
}

// The restart line set-up prints is the running server's own: its port when that is not 4747 and
// --server-port was not given, and the full path of a data folder that was given as a relative
// one. Pasted in another folder, it restarts the server where it was.
func TestSetupRemoteScriptRestartLine(t *testing.T) {
	in, remotePort := newScriptInstance(t)
	folder := in.serverFolder(t)
	setup, start := filepath.Join(folder, "setup-remote.sh"), filepath.Join(folder, "start-server.sh")
	cwd, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	in.dir = filepath.Join(cwd, "data four")
	elsewhere := t.TempDir()
	base := `sh "` + start + `" --restart -home "` + in.dir + `"`

	// No server has run: the folder's full path, and no port, which no file names.
	out, stderr, code := sh(t, cwd, setup, "--home", "data four", "--port", strconv.Itoa(remotePort), "--name", "127.0.0.1")
	if code != 0 {
		t.Fatalf("set-up: exit %d\n%s%s", code, out, stderr)
	}
	wantAll(t, "set-up", out, "Remote access is set up in "+in.dir+".\n", "Server port: 4747\n",
		"at its next start, and a new secret at once. To start it, or to restart it:\n")
	if line := restartLine(t, out); line != base {
		t.Fatalf("the restart line with no server\n%s\nwant\n%s", line, base)
	}

	if out, stderr, code := sh(t, elsewhere, start, in.startArgs()...); code != 0 || strings.TrimSpace(out) != in.url {
		t.Fatalf("start-server.sh: exit %d, printed %q\n%s", code, out, stderr)
	}
	pid := in.hello(t).Pid
	in.waitListening(t)

	// The server runs on its own port, and set-up is given the data folder only.
	out, stderr, code = sh(t, cwd, setup, "--home=data four")
	if code != 0 {
		t.Fatalf("set-up beside the running server: exit %d\n%s%s", code, out, stderr)
	}
	wantAll(t, "set-up beside the running server", out, fmt.Sprintf("Server port: %d\n", in.port))
	line := restartLine(t, out)
	if want := base + " -port " + strconv.Itoa(in.port); line != want {
		t.Fatalf("the restart line\n%s\nwant\n%s", line, want)
	}

	// Pasted in another folder. The test adds its stand-in for claude, as every server here gets.
	out, stderr, code = sh(t, elsewhere, "-c", line+` -claude "`+in.claude+`"`)
	if code != 0 || strings.TrimSpace(out) != in.url {
		t.Fatalf("the pasted line: exit %d, printed %q, want %q\n%s", code, out, in.url, stderr)
	}
	waitGone(t, pid)
	if next := in.hello(t).Pid; next == pid {
		t.Fatalf("the pasted line kept the server with pid %d", pid)
	}
	in.waitListening(t)
	// The server on that port is this data folder's.
	if out, stderr, code := in.own(t, "remote", "status"); code != 0 || !strings.HasPrefix(out, "Running: listening\n") {
		t.Fatalf("remote status after the pasted line: exit %d\n%s%s", code, out, stderr)
	}
}

// An option with an empty value is refused and nothing is written: an empty --home would mean the
// default data folder.
func TestSetupRemoteScriptRefusesEmptyValues(t *testing.T) {
	in, _ := newScriptInstance(t)
	folder := in.serverFolder(t)
	script := filepath.Join(folder, "setup-remote.sh")
	cwd := t.TempDir()
	// A scratch home folder: a set-up that went on would write its default data folder there.
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)

	for _, args := range [][]string{
		{"--home", ""}, {"--home="},
		{"--home", in.dir, "--server-port", ""}, {"--home", in.dir, "--server-port="},
		{"--home", in.dir, "--port", ""}, {"--home", in.dir, "--port="},
		{"--home", in.dir, "--name", ""}, {"--home", in.dir, "--name="},
	} {
		opt, _, _ := strings.Cut(args[len(args)-1], "=")
		if opt == "" {
			opt = args[len(args)-2]
		}
		out, stderr, code := sh(t, cwd, script, args...)
		if code != 2 || out != "" || stderr != "setup-remote.sh: "+opt+" needs a value\n" {
			t.Fatalf("%q: exit %d\n%s%s", args, code, out, stderr)
		}
		for _, dir := range []string{userHome, in.dir, cwd} {
			if entries, err := os.ReadDir(dir); err != nil || len(entries) != 0 {
				t.Fatalf("%q: %s holds %d entries (%v), want none", args, dir, len(entries), err)
			}
		}
	}
}

// AC36: start-server.sh works when called from another folder; `remote status` shows off or
// listening, the port, the names and the fingerprint, says whether the next start will work and
// why not, and never the secret; `remote off` removes the configuration only and takes effect at
// the next start. AC35's last clause: a test connection to the server the script set up ends
// connected.
func TestStartServerScriptAndStatus(t *testing.T) {
	in, remotePort := newScriptInstance(t)
	folder := in.serverFolder(t)
	setup, start := filepath.Join(folder, "setup-remote.sh"), filepath.Join(folder, "start-server.sh")
	elsewhere := t.TempDir()
	port := strconv.Itoa(remotePort)

	if out, stderr, code := sh(t, elsewhere, setup, in.setupArgs("--port", port, "--name", "127.0.0.1")...); code != 0 {
		t.Fatalf("set-up: exit %d\n%s%s", code, out, stderr)
	}
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)

	// The start, from a folder that has no web/dist.
	out, stderr, code := sh(t, elsewhere, start, in.startArgs()...)
	if code != 0 || strings.TrimSpace(out) != in.url {
		t.Fatalf("start-server.sh: exit %d, printed %q, want %q\n%s", code, out, in.url, stderr)
	}
	pid := in.hello(t).Pid
	resp, err := httpClient().Get(in.url)
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(page), webMark) {
		t.Fatalf("the web client: status %d, body %q", resp.StatusCode, page)
	}
	in.waitListening(t)
	// A second call finds the running server and starts none.
	if out, _, code := sh(t, elsewhere, start, in.startArgs()...); code != 0 || strings.TrimSpace(out) != in.url || in.hello(t).Pid != pid {
		t.Fatalf("start-server.sh again: exit %d, printed %q", code, out)
	}

	if r := testConnection(t, remotePort, fp, secret); !r.OK || r.Outcome != servers.OutcomeConnected {
		t.Fatalf("the test connection: %+v", r)
	}

	// Status, with a good set-up and with the key removed, against the running server and from
	// the files alone. It never shows the secret.
	listeningLines := []string{"Running: listening\n", "Running port: " + port + "\n", "Running names: ", "127.0.0.1", "Running fingerprint: " + fp + "\n"}
	goodFiles := []string{"Files: the next start will listen\n", "Port: " + port + "\n", "Names: ", "Fingerprint: " + fp + "\n"}
	status := func(what string, wantCode int, parts ...string) string {
		t.Helper()
		out, stderr, code := in.own(t, "remote", "status")
		if code != wantCode {
			t.Fatalf("remote status, %s: exit %d, want %d\n%s%s", what, code, wantCode, out, stderr)
		}
		wantAll(t, "remote status, "+what, out+stderr, parts...)
		if strings.Contains(out+stderr, secret) {
			t.Fatalf("remote status, %s, shows the secret:\n%s%s", what, out, stderr)
		}
		return out + stderr
	}
	status("running, good", 0, append(listeningLines, goodFiles...)...)

	keyPath := remote.FilesIn(in.dir).Key
	key, err := os.ReadFile(keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	status("running, no key", 1, append(listeningLines, "Files: the server will not start\n", "remote-key.pem", "remote setup -new-cert")...)
	in.run(t, "stop")
	waitGone(t, pid)
	status("stopped, no key", 1, "Running: no server\n", "Files: the server will not start\n", "remote-key.pem")
	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		t.Fatal(err)
	}
	if text := status("stopped, good", 0, append(goodFiles, "Running: no server\n")...); strings.Contains(text, "Running port") {
		t.Fatalf("remote status with no server reports a running port:\n%s", text)
	}

	// Off: the configuration only, and the running server keeps listening until its next start.
	if _, stderr, code := sh(t, elsewhere, start, in.startArgs()...); code != 0 {
		t.Fatalf("the second start: exit %d\n%s", code, stderr)
	}
	pid = in.hello(t).Pid
	in.waitListening(t)
	files := remoteFiles(t, in.dir)
	out, stderr, code = in.own(t, "remote", "off")
	if after := remoteFiles(t, in.dir); code != 0 || changed(files, after) != "remote.json" || after["remote.json"] != "" || after["instance-id"] != files["instance-id"] {
		t.Fatalf("remote off: exit %d, changed %q\n%s%s", code, changed(files, after), out, stderr)
	}
	remoteOK(t, remotePort, fp, secret)
	status("running, after off", 0, append(listeningLines, "Files: not set up\n")...)

	if out, stderr, code := sh(t, elsewhere, start, append([]string{"--restart"}, in.startArgs()...)...); code != 0 || strings.TrimSpace(out) != in.url {
		t.Fatalf("start-server.sh --restart: exit %d, printed %q\n%s", code, out, stderr)
	}
	waitGone(t, pid)
	if next := in.hello(t).Pid; next == pid {
		t.Fatalf("--restart kept the server with pid %d", pid)
	}
	if listening(remotePort) {
		t.Fatalf("the remote port %d is open after remote off and a restart", remotePort)
	}
	status("running, off", 0, "Running: off\n", "Files: not set up\n")
}

// start-server.sh says what is missing: the folder's web client, the folder's binary.
func TestStartServerScriptNeedsItsFolder(t *testing.T) {
	in, _ := newScriptInstance(t)
	folder := in.serverFolder(t)
	start := filepath.Join(folder, "start-server.sh")
	if err := os.Remove(filepath.Join(folder, "web", "index.html")); err != nil {
		t.Fatal(err)
	}
	if out, stderr, code := sh(t, t.TempDir(), start, in.startArgs()...); code != 1 || out != "" || !strings.Contains(stderr, "no web client at "+filepath.Join(folder, "web")) {
		t.Fatalf("without web/index.html: exit %d\n%s%s", code, out, stderr)
	}
	if err := os.Remove(in.bin); err != nil {
		t.Fatal(err)
	}
	if out, stderr, code := sh(t, t.TempDir(), start, in.startArgs()...); code != 1 || out != "" ||
		!strings.Contains(stderr, "no ai-whiteboard program at "+in.bin+". Call the script by its real path, not through a link to it.") {
		t.Fatalf("without the binary: exit %d\n%s%s", code, out, stderr)
	}
	in.noServer(t)

	// setup-remote.sh the same, called through a link to it from a folder with no program.
	link := filepath.Join(t.TempDir(), "setup-remote.sh")
	if err := os.Symlink(filepath.Join(folder, "setup-remote.sh"), link); err != nil {
		t.Fatal(err)
	}
	if out, stderr, code := sh(t, t.TempDir(), link, in.setupArgs()...); code != 1 || out != "" ||
		!strings.Contains(stderr, "no ai-whiteboard program beside this script") || !strings.Contains(stderr, "Call the script by its real path, not through a link to it.") {
		t.Fatalf("set-up through a link: exit %d\n%s%s", code, out, stderr)
	}
	if entries, err := os.ReadDir(in.dir); err != nil || len(entries) != 0 {
		t.Fatalf("set-up through a link wrote %d entries in the data folder (%v)", len(entries), err)
	}
}

// AC35: run through sh from the bundle (Contents/Resources/remote/setup-remote.sh, the binary in
// Contents/MacOS), the script sets the app's own server up as a remote server: started as the app
// starts it, a test connection to it ends connected.
func TestSetupRemoteScriptInTheBundle(t *testing.T) {
	in, remotePort := newScriptInstance(t)
	contents := filepath.Join(t.TempDir(), "AI Whiteboard.app", "Contents")
	built := os.Getenv("AIWB_TEST_BUNDLE") // a built AI Whiteboard.app, in place of the hand-made folder
	if built != "" {
		app, err := filepath.Abs(built)
		if err != nil {
			t.Fatal(err)
		}
		contents = filepath.Join(app, "Contents")
	}
	bin := filepath.Join(contents, "MacOS", "ai-whiteboard")
	script := filepath.Join(contents, "Resources", "remote", "setup-remote.sh")
	if built != "" {
		for _, path := range []string{script, bin} {
			if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
				t.Fatalf("the built bundle %s lacks %s (%v)", built, path, err)
			}
		}
	} else {
		copyFile(t, in.bin, bin, 0o755)
		copyFile(t, filepath.Join(scriptsDir(t), "setup-remote.sh"), script, 0o644)
		writeWeb(t, filepath.Join(contents, "Resources", "web"))
	}
	in.bin = bin
	port := strconv.Itoa(remotePort)

	out, stderr, code := sh(t, t.TempDir(), script, in.setupArgs("--port", port, "--name", "127.0.0.1")...)
	if code != 0 {
		t.Fatalf("set-up from the bundle: exit %d\n%s%s", code, out, stderr)
	}
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	wantAll(t, "set-up from the bundle", out, "  https://127.0.0.1:"+port+"\n", "Fingerprint: "+fp+"\n", "Secret: "+secret+"\n",
		`"`+in.exe(t)+`" relaunch -home "`+in.dir+`" -port `+strconv.Itoa(in.port))

	// The app's start: `launch`, which in a bundle serves Contents/Resources/web.
	launched, err := exec.Command(bin, append([]string{"launch"}, in.startArgs()...)...).Output()
	if err != nil || strings.TrimSpace(string(launched)) != in.url {
		t.Fatalf("launch from the bundle: %v, printed %q", err, launched)
	}
	in.waitListening(t)
	if r := testConnection(t, remotePort, fp, secret); !r.OK || r.Outcome != servers.OutcomeConnected {
		t.Fatalf("the test connection: %+v", r)
	}
}

// AC35: the packaging puts the set-up script into the bundle, where
// TestSetupRemoteScriptInTheBundle runs it from: Contents/Resources/remote/setup-remote.sh.
func TestBundleCarriesSetupScript(t *testing.T) {
	yml := filepath.Join("..", "..", "desktop", "electron-builder.yml")
	b, err := os.ReadFile(yml)
	if err != nil {
		t.Fatal(err)
	}
	// The list under extraResources: its lines up to the next key at the left edge.
	_, after, ok := strings.Cut("\n"+string(b), "\nextraResources:\n")
	if !ok {
		t.Fatalf("%s has no extraResources", yml)
	}
	var entries []string // "from to" per entry
	for _, line := range strings.Split(after, "\n") {
		word := strings.TrimSpace(line)
		if word != "" && line[0] != ' ' && line[0] != '#' {
			break
		}
		if from, ok := strings.CutPrefix(word, "- from: "); ok {
			entries = append(entries, from)
		} else if to, ok := strings.CutPrefix(word, "to: "); ok && len(entries) > 0 {
			entries[len(entries)-1] += " " + to
		}
	}
	const from, to = "../scripts/remote/setup-remote.sh", "remote/setup-remote.sh"
	if !slices.Contains(entries, from+" "+to) {
		t.Fatalf("extraResources of %s has no entry from %s to %s: %q", yml, from, to, entries)
	}
	// from is relative to desktop/.
	if info, err := os.Stat(filepath.Join(filepath.Dir(yml), filepath.FromSlash(from))); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("the script the bundle is to carry: %v", err)
	}
}

// AC20: scripts/build-server.sh makes the server folder for each of its four targets, with the
// same files in each and a binary for the target's system and CPU, and refuses another target;
// this machine's folder works as the README says: set-up, start, a test connection. It runs only
// on request: it needs node and npm, builds the web client and writes bin/ of the repository
// (its four folders are removed again).
func TestBuildServerFolders(t *testing.T) {
	if os.Getenv("AIWB_TEST_BUILD") != "1" {
		t.Skip("builds the web client and four server folders into bin/: set AIWB_TEST_BUILD=1 to run it")
	}
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if root, err = filepath.EvalSymlinks(root); err != nil { // the scripts name their folder so
		t.Fatal(err)
	}
	build := func(target string) (string, int) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		cmd := exec.CommandContext(ctx, "bash", "scripts/build-server.sh", target)
		cmd.Dir = root
		out, err := cmd.CombinedOutput()
		var ee *exec.ExitError
		switch {
		case errors.As(err, &ee):
			return string(out), ee.ExitCode()
		case err != nil:
			t.Fatalf("build-server.sh %s: %v\n%s", target, err, out)
		}
		return string(out), 0
	}
	folderOf := func(target string) string {
		return filepath.Join(root, "bin", "ai-whiteboard-server-"+strings.Replace(target, "/", "-", 1))
	}

	targets := []string{"darwin/arm64", "darwin/amd64", "linux/amd64", "linux/arm64"}
	for _, target := range targets {
		dir := folderOf(target)
		t.Cleanup(func() {
			os.RemoveAll(dir)
			os.Remove(filepath.Join(root, "bin")) // when nothing else is in it
		})
		if out, code := build(target); code != 0 || !strings.Contains(out, "Built "+dir+"\n") {
			t.Fatalf("build-server.sh %s: exit %d\n%s", target, code, out)
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, e := range entries {
			info, err := e.Info()
			if err != nil {
				t.Fatal(err)
			}
			names = append(names, e.Name())
			switch e.Name() {
			case "ai-whiteboard", "setup-remote.sh", "start-server.sh":
				if info.Mode() != 0o755 {
					t.Errorf("%s: %s has the mode %v, want 0755", target, e.Name(), info.Mode())
				}
			case "README.md":
				if !info.Mode().IsRegular() {
					t.Errorf("%s: README.md has the mode %v", target, info.Mode())
				}
			}
		}
		if want := []string{"README.md", "ai-whiteboard", "setup-remote.sh", "start-server.sh", "web"}; !slices.Equal(names, want) {
			t.Fatalf("%s: the folder holds %v, want %v", target, names, want)
		}
		for _, name := range []string{"index.html", "version.json"} {
			if info, err := os.Stat(filepath.Join(dir, "web", name)); err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
				t.Fatalf("%s: web/%s: %v", target, name, err)
			}
		}
		for _, name := range []string{"README.md", "setup-remote.sh", "start-server.sh"} {
			got, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			if want, err := os.ReadFile(filepath.Join(scriptsDir(t), name)); err != nil || !bytes.Equal(got, want) {
				t.Fatalf("%s: %s is not the one of scripts/remote (%v)", target, name, err)
			}
		}
		// The binary is the target's: its file format and its CPU.
		bin := filepath.Join(dir, "ai-whiteboard")
		switch target {
		case "darwin/arm64", "darwin/amd64":
			f, err := macho.Open(bin)
			if err != nil {
				t.Fatalf("%s: the binary is no Mach-O file: %v", target, err)
			}
			want := map[string]macho.Cpu{"darwin/arm64": macho.CpuArm64, "darwin/amd64": macho.CpuAmd64}[target]
			if f.Close(); f.Cpu != want {
				t.Fatalf("%s: the binary is for the CPU %v, want %v", target, f.Cpu, want)
			}
		default:
			f, err := elf.Open(bin)
			if err != nil {
				t.Fatalf("%s: the binary is no ELF file: %v", target, err)
			}
			want := map[string]elf.Machine{"linux/amd64": elf.EM_X86_64, "linux/arm64": elf.EM_AARCH64}[target]
			if f.Close(); f.Machine != want {
				t.Fatalf("%s: the binary is for the CPU %v, want %v", target, f.Machine, want)
			}
		}
	}

	// A target it does not build: usage, and no folder.
	if out, code := build("windows/amd64"); code != 2 || !strings.Contains(out, "usage: scripts/build-server.sh") {
		t.Fatalf("build-server.sh windows/amd64: exit %d\n%s", code, out)
	}
	if _, err := os.Stat(folderOf("windows/amd64")); !os.IsNotExist(err) {
		t.Fatalf("the folder of windows/amd64: %v, want none", err)
	}

	// This machine's folder, used as its README says.
	host := runtime.GOOS + "/" + runtime.GOARCH
	if !slices.Contains(targets, host) {
		t.Skipf("no server folder is built for %s: its use is not tried", host)
	}
	in, remotePort := newScriptInstance(t)
	dir := folderOf(host)
	in.bin = filepath.Join(dir, "ai-whiteboard")
	setup, start := filepath.Join(dir, "setup-remote.sh"), filepath.Join(dir, "start-server.sh")
	elsewhere := t.TempDir()
	port := strconv.Itoa(remotePort)

	if out, stderr, code := sh(t, elsewhere, setup, in.setupArgs("--port", port, "--name", "127.0.0.1")...); code != 0 {
		t.Fatalf("set-up: exit %d\n%s%s", code, out, stderr)
	}
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	out, stderr, code := sh(t, elsewhere, start, in.startArgs()...)
	if code != 0 || strings.TrimSpace(out) != in.url {
		t.Fatalf("start-server.sh: exit %d, printed %q, want %q\n%s", code, out, in.url, stderr)
	}
	// The folder's own web client is served.
	resp, err := httpClient().Get(in.url)
	if err != nil {
		t.Fatal(err)
	}
	page, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	index, err := os.ReadFile(filepath.Join(dir, "web", "index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK || !bytes.Equal(page, index) {
		t.Fatalf("the web client: status %d, body %q", resp.StatusCode, page)
	}
	in.waitListening(t)
	if r := testConnection(t, remotePort, fp, secret); !r.OK || r.Outcome != servers.OutcomeConnected {
		t.Fatalf("the test connection: %+v", r)
	}
}
