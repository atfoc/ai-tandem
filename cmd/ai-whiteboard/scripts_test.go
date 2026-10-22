//go:build !windows

package main

import (
	"bytes"
	"context"
	"debug/elf"
	"debug/macho"
	"errors"
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
)

// The scripts of scripts/remote, run through sh as docs/remote-servers.md calls them, on a scratch
// data folder with its own ports.

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

// newScriptInstance is newBareInstance for the scripts: no set-up yet, which the scripts make.
// It skips where sh is missing.
func newScriptInstance(t *testing.T) *instance {
	t.Helper()
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	return newBareInstance(t)
}

// serverFolder is the folder scripts/build-server.sh makes: the binary and the two scripts side
// by side. The scripts are copied without their executable
// bit, as a copy may lose it. in.bin becomes the folder's binary. The path has no symlink in it.
func (in *instance) serverFolder(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "server folder")
	copyFile(t, in.bin, filepath.Join(dir, "ai-whiteboard"), 0o755)
	for _, name := range []string{"setup-remote.sh", "start-server.sh"} {
		copyFile(t, filepath.Join(scriptsDir(t), name), filepath.Join(dir, name), 0o644)
	}
	// The scripts name their folder with symlinks resolved.
	dir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	in.bin = filepath.Join(dir, "ai-whiteboard")
	return dir
}

// sh runs `sh <script> <args>` in the folder cwd with no input and the instance's environment
// (what a script starts has the script's environment), and returns its output and exit code. It
// must end by itself.
func (in *instance) sh(t *testing.T, cwd, script string, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var out, errOut bytes.Buffer
	cmd := exec.CommandContext(ctx, "sh", append([]string{script}, args...)...)
	cmd.Dir = cwd
	cmd.Env = in.environ()
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

// setupArgs are the options every run of setup-remote.sh gets here: the scratch data folder.
func (in *instance) setupArgs(more ...string) []string {
	return append([]string{"--home", in.dir}, more...)
}

// startArgs are the server flags start-server.sh passes on.
func (in *instance) startArgs() []string { return in.flags() }

// address is what `launch` writes for the instance's server, for a person.
func (in *instance) address() string {
	return "AI Whiteboard is running.\nAddress: " + in.base() + "\nFingerprint: " + in.fpr + "\n"
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

// AC36: setup-remote.sh asks nothing and prints the names with the port, the fingerprint and the
// secret; a second run changes nothing and prints the same; after the secret was deleted it makes
// a new one and keeps the rest; --new-cert and --new-secret each replace that one thing.
func TestSetupRemoteScript(t *testing.T) {
	serverTest(t, "TestRemoteSetupCommand, TestRemoteSetupFlags, TestRemoteSetupNewCertNeedsConfig, TestSecretCommand (the commands the script runs), TestSetupRemoteScriptRefusesEmptyValues (the script itself) (this package)")
	in := newScriptInstance(t)
	folder := in.serverFolder(t)
	script := filepath.Join(folder, "setup-remote.sh")
	elsewhere := t.TempDir()
	port := strconv.Itoa(in.port)

	first, stderr, code := in.sh(t, elsewhere, script, in.setupArgs("--port", port, "--name", "127.0.0.1")...)
	if code != 0 {
		t.Fatalf("first set-up: exit %d\n%s%s", code, first, stderr)
	}
	files := remoteFiles(t, in.dir)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	wantAll(t, "the first set-up", first,
		"Port: "+port+"\n", "127.0.0.1", "  https://127.0.0.1:"+port+"\n", "Fingerprint: "+fp+"\n", "Secret: "+secret+"\n",
		"Next start: will listen\n", `"`+filepath.Join(folder, "start-server.sh")+`" --restart -home "`+in.dir+`"`)
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
		again, stderr, code := in.sh(t, elsewhere, script, args...)
		if code != 0 || again != first {
			t.Fatalf("set-up again with %v: exit %d\n%s%s\nfirst:\n%s", args, code, again, stderr, first)
		}
		sameRemoteFiles(t, in.dir, files)
	}

	// The secret deleted: a new one, the rest kept.
	if err := os.Remove(remote.FilesIn(in.dir).Secret); err != nil {
		t.Fatal(err)
	}
	out, stderr, code := in.sh(t, elsewhere, script, in.setupArgs()...)
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
	out, stderr, code = in.sh(t, elsewhere, script, in.setupArgs("--new-cert")...)
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
	out, stderr, code = in.sh(t, elsewhere, script, in.setupArgs("--new-secret")...)
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
	if _, stderr, code = in.sh(t, elsewhere, script, in.setupArgs("--bogus")...); code != 2 || !strings.Contains(stderr, "unknown option --bogus") {
		t.Fatalf("--bogus: exit %d\n%s", code, stderr)
	}
	if _, stderr, code = in.sh(t, elsewhere, script, "--home"); code != 2 || !strings.Contains(stderr, "--home needs a value") {
		t.Fatalf("--home alone: exit %d\n%s", code, stderr)
	}
	sameRemoteFiles(t, in.dir, files)

	// The key removed: set-up remakes no key and exits 1 with the check's message, and the script
	// shows both what is set up and the message.
	if err := os.Remove(remote.FilesIn(in.dir).Key); err != nil {
		t.Fatal(err)
	}
	out, stderr, code = in.sh(t, elsewhere, script, in.setupArgs()...)
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

// The restart line set-up prints names the full path of a data folder that was given as a
// relative one, and nothing else of the server: it has no port of its own to name. Pasted in
// another folder, it restarts the server where it was.
func TestSetupRemoteScriptRestartLine(t *testing.T) {
	serverTest(t, "TestRemoteSetupCommand, TestStatusOfARunningServer, TestSetupRemoteScriptRefusesEmptyValues (this package)")
	in := newScriptInstance(t)
	folder := in.serverFolder(t)
	setup, start := filepath.Join(folder, "setup-remote.sh"), filepath.Join(folder, "start-server.sh")
	cwd, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	in.dir = filepath.Join(cwd, "data four")
	elsewhere := t.TempDir()
	base := `sh "` + start + `" --restart -home "` + in.dir + `"`

	out, stderr, code := in.sh(t, cwd, setup, "--home", "data four", "--port", strconv.Itoa(in.port), "--name", "127.0.0.1")
	if code != 0 {
		t.Fatalf("set-up: exit %d\n%s%s", code, out, stderr)
	}
	wantAll(t, "set-up", out, "Remote access is set up in "+in.dir+".\n", "at its next start, and a new secret at once. To start it, or to restart it:\n")
	if strings.Contains(out, "Server port") {
		t.Fatalf("set-up names a server port:\n%s", out)
	}
	if line := restartLine(t, out); line != base {
		t.Fatalf("the restart line\n%s\nwant\n%s", line, base)
	}
	in.secret, in.fpr = secretOf(t, in.dir), fingerprintOf(t, in.dir)

	if out, stderr, code := in.sh(t, elsewhere, start, in.startArgs()...); code != 0 || out != in.address() {
		t.Fatalf("start-server.sh: exit %d, printed %q\n%s", code, out, stderr)
	}
	pid := in.hello(t).Pid
	in.waitServing(t)

	// Beside the running server the line is the same.
	out, stderr, code = in.sh(t, cwd, setup, "--home=data four")
	if code != 0 {
		t.Fatalf("set-up beside the running server: exit %d\n%s%s", code, out, stderr)
	}
	if line := restartLine(t, out); line != base {
		t.Fatalf("the restart line\n%s\nwant\n%s", line, base)
	}

	// Pasted in another folder. The test adds its stand-ins for the agents, as every server here gets.
	out, stderr, code = in.sh(t, elsewhere, "-c", base+` -claude "`+in.claude+`" -pi "`+in.pi+`" -cursor "`+in.cursor+`"`)
	if code != 0 || out != in.address() {
		t.Fatalf("the pasted line: exit %d, printed %q, want %q\n%s", code, out, in.address(), stderr)
	}
	waitGone(t, pid)
	if next := in.hello(t).Pid; next == pid {
		t.Fatalf("the pasted line kept the server with pid %d", pid)
	}
	in.waitServing(t)
	// The server is this data folder's.
	if out, stderr, code := in.ends(t, "status"); code != 0 || !strings.HasPrefix(out, "Running: this build ") {
		t.Fatalf("status after the pasted line: exit %d\n%s%s", code, out, stderr)
	}
}

// An option with an empty value is refused and nothing is written: an empty --home would mean the
// default data folder.
func TestSetupRemoteScriptRefusesEmptyValues(t *testing.T) {
	smokeTest(t)
	in := newScriptInstance(t)
	folder := in.serverFolder(t)
	script := filepath.Join(folder, "setup-remote.sh")
	cwd := t.TempDir()
	// A scratch home folder: a set-up that went on would write its default data folder there.
	userHome := t.TempDir()
	in.setenv("HOME=" + userHome)

	for _, args := range [][]string{
		{"--home", ""}, {"--home="},
		{"--home", in.dir, "--port", ""}, {"--home", in.dir, "--port="},
		{"--home", in.dir, "--name", ""}, {"--home", in.dir, "--name="},
	} {
		opt, _, _ := strings.Cut(args[len(args)-1], "=")
		if opt == "" {
			opt = args[len(args)-2]
		}
		out, stderr, code := in.sh(t, cwd, script, args...)
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

// start-server.sh works when called from another folder and prints the server's address and
// fingerprint; before the set-up it starts nothing and names the command that sets it up; `status`
// shows the port, the names and the fingerprint of the running server and of the files, says
// whether the next start will work and why not, and never the secret. A client that has the
// printed address, the fingerprint and the secret connects.
func TestStartServerScriptAndStatus(t *testing.T) {
	serverTest(t, "TestStatusFromFiles, TestStatusOfARunningServer, TestStatusJSON (this package)", "TestNotSetUpRefusesThenStarts (this package)")
	in := newScriptInstance(t)
	folder := in.serverFolder(t)
	setup, start := filepath.Join(folder, "setup-remote.sh"), filepath.Join(folder, "start-server.sh")
	elsewhere := t.TempDir()
	port := strconv.Itoa(in.port)

	// Before the set-up the start says what to do and starts nothing.
	out, stderr, code := in.sh(t, elsewhere, start, in.startArgs()...)
	if code != 1 || out != "" || !strings.Contains(stderr, "AI Whiteboard is not set up on this machine. Set it up once with: ") ||
		!strings.Contains(stderr, `"`+in.bin+`" remote setup -home "`+in.dir+`"`) {
		t.Fatalf("start-server.sh before the set-up: exit %d\n%s%s", code, out, stderr)
	}
	in.noServer(t)

	if out, stderr, code := in.sh(t, elsewhere, setup, in.setupArgs("--port", port, "--name", "127.0.0.1")...); code != 0 {
		t.Fatalf("set-up: exit %d\n%s%s", code, out, stderr)
	}
	in.secret, in.fpr = secretOf(t, in.dir), fingerprintOf(t, in.dir)

	out, stderr, code = in.sh(t, elsewhere, start, in.startArgs()...)
	if code != 0 || out != in.address() {
		t.Fatalf("start-server.sh: exit %d, printed %q, want %q\n%s", code, out, in.address(), stderr)
	}
	pid := in.hello(t).Pid
	in.waitServing(t)
	// The server serves no page, from this folder or any other.
	if status, _ := in.getWith(t, "/", in.secret, "", testLevel); status != 404 {
		t.Fatalf("GET / with the secret: status %d, want 404", status)
	}
	// A second call finds the running server and starts none.
	if out, _, code := in.sh(t, elsewhere, start, in.startArgs()...); code != 0 || out != in.address() || in.hello(t).Pid != pid {
		t.Fatalf("start-server.sh again: exit %d, printed %q", code, out)
	}
	// What a client needs is what the script printed: the address, the fingerprint and the secret.
	in.helloOK(t, in.secret)
	if status, _ := in.getWith(t, "/api/state", in.secret, "", testLevel); status != 200 {
		t.Fatalf("the state with the secret the set-up printed: status %d", status)
	}

	// Status, with a good set-up and with the key removed, against the running server and from
	// the files alone. It never shows the secret.
	listeningLines := []string{"Running: this build ", "Address: " + in.base() + "\n", "Port: " + port + "\n", "Names: ", "127.0.0.1", "Fingerprint: " + in.fpr + "\n", "MCP listener: "}
	goodFiles := []string{"Files: the next start will listen\n", "Port: " + port + "\n", "Names: ", "Fingerprint: " + in.fpr + "\n"}
	status := func(what string, wantCode int, parts ...string) string {
		t.Helper()
		out, stderr, code := in.ends(t, "status")
		if code != wantCode {
			t.Fatalf("status, %s: exit %d, want %d\n%s%s", what, code, wantCode, out, stderr)
		}
		wantAll(t, "status, "+what, out+stderr, parts...)
		if strings.Contains(out+stderr, in.secret) {
			t.Fatalf("status, %s, shows the secret:\n%s%s", what, out, stderr)
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
	if text := status("stopped, good", 0, append(goodFiles, "Running: no server\n")...); strings.Contains(text, "Address:") {
		t.Fatalf("status with no server reports an address:\n%s", text)
	}

	// --restart replaces the server.
	if _, stderr, code := in.sh(t, elsewhere, start, in.startArgs()...); code != 0 {
		t.Fatalf("the second start: exit %d\n%s", code, stderr)
	}
	pid = in.hello(t).Pid
	in.waitServing(t)
	if out, stderr, code := in.sh(t, elsewhere, start, append([]string{"--restart"}, in.startArgs()...)...); code != 0 || out != in.address() {
		t.Fatalf("start-server.sh --restart: exit %d, printed %q\n%s", code, out, stderr)
	}
	waitGone(t, pid)
	if next := in.hello(t).Pid; next == pid {
		t.Fatalf("--restart kept the server with pid %d", pid)
	}
	in.waitServing(t)
	in.helloOK(t, in.secret)
}

// start-server.sh says what is missing: the folder's binary. setup-remote.sh the same.
func TestStartServerScriptNeedsItsFolder(t *testing.T) {
	serverTest(t, "TestSetupRemoteScriptRefusesEmptyValues (a script of the server folder run through sh) (this package)")
	in := newScriptInstance(t)
	folder := in.serverFolder(t)
	start := filepath.Join(folder, "start-server.sh")
	// The folder has no page and the script asks for none.
	if entries, _ := os.ReadDir(folder); len(entries) != 3 {
		t.Fatalf("the folder holds %d entries, want the binary and the two scripts", len(entries))
	}
	if err := os.Remove(in.bin); err != nil {
		t.Fatal(err)
	}
	if out, stderr, code := in.sh(t, t.TempDir(), start, in.startArgs()...); code != 1 || out != "" ||
		!strings.Contains(stderr, "no ai-whiteboard program at "+in.bin+". Call the script by its real path, not through a link to it.") {
		t.Fatalf("without the binary: exit %d\n%s%s", code, out, stderr)
	}
	in.noServer(t)

	// setup-remote.sh the same, called through a link to it from a folder with no program.
	link := filepath.Join(t.TempDir(), "setup-remote.sh")
	if err := os.Symlink(filepath.Join(folder, "setup-remote.sh"), link); err != nil {
		t.Fatal(err)
	}
	if out, stderr, code := in.sh(t, t.TempDir(), link, in.setupArgs()...); code != 1 || out != "" ||
		!strings.Contains(stderr, "no ai-whiteboard program beside this script") || !strings.Contains(stderr, "Call the script by its real path, not through a link to it.") {
		t.Fatalf("set-up through a link: exit %d\n%s%s", code, out, stderr)
	}
	if entries, err := os.ReadDir(in.dir); err != nil || len(entries) != 0 {
		t.Fatalf("set-up through a link wrote %d entries in the data folder (%v)", len(entries), err)
	}
}

// Run through sh from the bundle (Contents/Resources/remote/setup-remote.sh, the binary in
// Contents/MacOS), the script sets the app's own server up: started as the app starts it, a client
// with the address, the fingerprint and the secret it printed connects.
func TestSetupRemoteScriptInTheBundle(t *testing.T) {
	serverTest(t, "TestBundleCarriesSetupScript, TestRemoteSetupCommand (this package)")
	in := newScriptInstance(t)
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
	}
	in.bin = bin
	port := strconv.Itoa(in.port)

	out, stderr, code := in.sh(t, t.TempDir(), script, in.setupArgs("--port", port, "--name", "127.0.0.1")...)
	if code != 0 {
		t.Fatalf("set-up from the bundle: exit %d\n%s%s", code, out, stderr)
	}
	in.secret, in.fpr = secretOf(t, in.dir), fingerprintOf(t, in.dir)
	wantAll(t, "set-up from the bundle", out, "  https://127.0.0.1:"+port+"\n", "Fingerprint: "+in.fpr+"\n", "Secret: "+in.secret+"\n",
		`"`+in.exe(t)+`" relaunch -home "`+in.dir+`"`)

	// The app's start: `launch`.
	launch := exec.Command(bin, append([]string{"launch"}, in.startArgs()...)...)
	launch.Env = in.environ()
	launched, err := launch.Output()
	if err != nil || string(launched) != in.address() {
		t.Fatalf("launch from the bundle: %v, printed %q", err, launched)
	}
	in.waitServing(t)
	in.helloOK(t, in.secret)
}

// AC35: the packaging puts the set-up script into the bundle, where
// TestSetupRemoteScriptInTheBundle runs it from: Contents/Resources/remote/setup-remote.sh.
func TestBundleCarriesSetupScript(t *testing.T) {
	t.Parallel()
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

// scripts/build-server.sh makes the server folder for each of its four targets, with the same files
// in each (the program and the scripts, and no page) and a binary for the target's system and CPU,
// and refuses another target; this machine's folder works as its README says: set-up, start, a
// client that connects. It runs only on request: it builds four binaries and writes bin/ of the
// repository (its four folders are removed again). It needs no node and no build of the page.
func TestBuildServerFolders(t *testing.T) {
	if os.Getenv("AIWB_TEST_BUILD") != "1" {
		t.Skip("builds four server folders into bin/: set AIWB_TEST_BUILD=1 to run it")
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
		if want := []string{"README.md", "ai-whiteboard", "setup-remote.sh", "start-server.sh"}; !slices.Equal(names, want) {
			t.Fatalf("%s: the folder holds %v, want %v: no page beside the program", target, names, want)
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
	in := newScriptInstance(t)
	dir := folderOf(host)
	in.bin = filepath.Join(dir, "ai-whiteboard")
	setup, start := filepath.Join(dir, "setup-remote.sh"), filepath.Join(dir, "start-server.sh")
	elsewhere := t.TempDir()
	port := strconv.Itoa(in.port)

	if out, stderr, code := in.sh(t, elsewhere, setup, in.setupArgs("--port", port, "--name", "127.0.0.1")...); code != 0 {
		t.Fatalf("set-up: exit %d\n%s%s", code, out, stderr)
	}
	in.secret, in.fpr = secretOf(t, in.dir), fingerprintOf(t, in.dir)
	out, stderr, code := in.sh(t, elsewhere, start, in.startArgs()...)
	if code != 0 || out != in.address() {
		t.Fatalf("start-server.sh: exit %d, printed %q, want %q\n%s", code, out, in.address(), stderr)
	}
	in.waitServing(t)
	in.helloOK(t, in.secret)
}
