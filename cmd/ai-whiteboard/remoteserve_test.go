package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
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
	"ai-whiteboard/internal/server"
)

// newRemoteInstance is newInstance with remote access set up on a free port, with the name
// 127.0.0.1. Its servers bind the remote port on 127.0.0.1 through the hidden test-only override:
// a wildcard bind by a freshly built binary can raise the macOS firewall dialog.
func newRemoteInstance(t *testing.T) (in *instance, remotePort int) {
	t.Helper()
	in = newInstance(t)
	t.Setenv("AIWB_REMOTE_BIND", "127.0.0.1")
	remotePort = freePort(t)
	setUpRemote(t, in.dir, remotePort)
	return in, remotePort
}

// setUpRemote is `remote setup -port <port> -name 127.0.0.1` for dir.
func setUpRemote(t *testing.T, dir string, port int) {
	t.Helper()
	if _, err := remote.Setup(dir, remote.SetupOptions{Port: port, Names: []string{"127.0.0.1"}}); err != nil {
		t.Fatal(err)
	}
}

// ends runs `ai-whiteboard <command> <flags>`, which must end by itself, and returns its output
// and exit code.
func (in *instance) ends(t *testing.T, command string) (stdout, stderr string, code int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var out, errOut bytes.Buffer
	cmd := exec.CommandContext(ctx, in.bin, append([]string{command}, in.flags()...)...)
	cmd.Stdout, cmd.Stderr = &out, &errOut
	err := cmd.Run()
	var ee *exec.ExitError
	switch {
	case ctx.Err() != nil:
		t.Fatalf("%s did not end within 60 s\n%s", command, errOut.String())
	case errors.As(err, &ee):
		code = ee.ExitCode()
	case err != nil:
		t.Fatalf("%s: %v", command, err)
	}
	return out.String(), errOut.String(), code
}

// exe is the binary's path as a message writes it: symlinks resolved.
func (in *instance) exe(t *testing.T) string {
	t.Helper()
	exe, err := filepath.EvalSymlinks(in.bin)
	if err != nil {
		t.Fatal(err)
	}
	return exe
}

// noServer checks what a start that ended must leave: nothing accepts on the app port and there
// is no server.json.
func (in *instance) noServer(t *testing.T) {
	t.Helper()
	if listening(in.port) {
		t.Fatalf("something accepts on the app port %d", in.port)
	}
	if _, err := os.Stat(filepath.Join(in.dir, "server.json")); !os.IsNotExist(err) {
		t.Fatalf("server.json: %v, want none", err)
	}
}

// remoteFiles reads the files of remote access in dir: name to mode and content, "" when missing.
func remoteFiles(t *testing.T, dir string) map[string]string {
	t.Helper()
	f := remote.FilesIn(dir)
	got := map[string]string{}
	for _, path := range []string{f.Config, f.Secret, f.Key, f.Cert, f.InstanceID} {
		info, err := os.Stat(path)
		if os.IsNotExist(err) {
			got[filepath.Base(path)] = ""
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		got[filepath.Base(path)] = fmt.Sprintf("%v %s", info.Mode(), b)
	}
	return got
}

func sameRemoteFiles(t *testing.T, dir string, want map[string]string) {
	t.Helper()
	for name, v := range remoteFiles(t, dir) {
		if v != want[name] {
			t.Fatalf("%s changed", name)
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

func serverLog(t *testing.T, dir string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "server.log"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// waitListening waits up to 5 s for the running server to report that its remote listener serves.
func (in *instance) waitListening(t *testing.T) remoteStatusReply {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if st, ok := remoteStatusOf(in.url); ok && st.Listening {
			return st
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server at %s does not report a remote listener", in.url)
		}
	}
}

// helloMap is the whole answer of GET /api/hello on the loopback listener.
func (in *instance) helloMap(t *testing.T) map[string]any {
	t.Helper()
	resp, err := httpClient().Get(in.url + "api/hello")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var h map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&h); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("hello: status %d, %v", resp.StatusCode, err)
	}
	return h
}

// testClient is the client id the tests' API client states: an instance id of no server here.
const testClient = "5f0c2a7e-3b1d-4c6a-9e2f-7a8b9c0d1e2f"

// pinned is a transport that accepts the certificate with this fingerprint alone: it is
// self-signed, so it is pinned and not verified.
func pinned(fingerprint string) *http.Transport {
	return &http.Transport{ForceAttemptHTTP2: true, TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if got := remote.Fingerprint(cs.PeerCertificates[0].Raw); got != fingerprint {
				return fmt.Errorf("the certificate's fingerprint is %s, want %s", got, fingerprint)
			}
			return nil
		},
	}}
}

// remoteHello asks the remote listener on 127.0.0.1:<port> for /api/hello over HTTPS, as an API
// client does: the certificate is pinned by its fingerprint, the secret and the client id are in
// their headers. host, when not "", replaces the Host value. It returns the status and the
// decoded body.
func remoteHello(t *testing.T, port int, fingerprint, secret, host string) (int, map[string]any) {
	t.Helper()
	tr := pinned(fingerprint)
	defer tr.CloseIdleConnections()
	req, err := http.NewRequest("GET", fmt.Sprintf("https://127.0.0.1:%d/api/hello", port), nil)
	if err != nil {
		t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	if secret != "" {
		req.Header.Set(remote.SecretHeader, secret)
	}
	req.Header.Set(server.ClientHeader, testClient)
	resp, err := (&http.Client{Transport: tr, Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("remote hello: %v", err)
	}
	defer resp.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("remote hello: status %d, body: %v", resp.StatusCode, err)
	}
	return resp.StatusCode, body
}

// remoteOK asks for hello with the secret and must get it.
func remoteOK(t *testing.T, port int, fingerprint, secret string) map[string]any {
	t.Helper()
	status, body := remoteHello(t, port, fingerprint, secret, "")
	if status != http.StatusOK || body["app"] != "ai-whiteboard" {
		t.Fatalf("remote hello: status %d, body %v", status, body)
	}
	return body
}

// messageLines checks that text holds every line of the check's message, and returns the message.
func messageLines(t *testing.T, text, message string) {
	t.Helper()
	if message == "" {
		t.Fatal("the check has no message")
	}
	for _, line := range strings.Split(message, "\n") {
		if !strings.Contains(text, line) {
			t.Fatalf("the line %q is missing in:\n%s", line, text)
		}
	}
}

// Without remote.json the start is today's: stray secret, key and certificate files are neither
// read nor replaced, and nothing listens for remote access.
func TestServeWithoutConfigIsToday(t *testing.T) {
	in := newInstance(t)
	t.Setenv("AIWB_REMOTE_BIND", "127.0.0.1")
	f := remote.FilesIn(in.dir)
	for _, path := range []string{f.Secret, f.Key, f.Cert} {
		if err := os.WriteFile(path, []byte("garbage\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	before := remoteFiles(t, in.dir)

	if got := in.run(t, "launch"); got != in.url+"\n" {
		t.Fatalf("launch printed %q", got)
	}
	pid := in.hello(t).Pid
	if st, ok := remoteStatusOf(in.url); !ok || st.Listening {
		t.Fatalf("remote status: %+v, answered %v; want not listening", st, ok)
	}
	// AC1: the process listens on the app port and the MCP port, and on nothing else.
	if lsof, err := exec.LookPath("lsof"); err != nil {
		t.Log("no lsof: the process's listeners are not counted")
	} else {
		out, _ := exec.Command(lsof, "-nP", "-a", "-p", strconv.Itoa(pid), "-iTCP", "-sTCP:LISTEN").Output()
		var lines []string
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(line, "(LISTEN)") {
				lines = append(lines, line)
			}
		}
		on := func(port int) bool {
			return slices.ContainsFunc(lines, func(line string) bool {
				return strings.Contains(line, fmt.Sprintf(":%d (LISTEN)", port))
			})
		}
		if len(lines) != 2 || !on(in.port) || !on(in.mcpPort) {
			t.Fatalf("lsof: want two listeners, on the ports %d and %d, got:\n%s", in.port, in.mcpPort, out)
		}
	}
	out, _, code := own(t, "remote", "status", "-home", in.dir, "-server-port", strconv.Itoa(in.port))
	if code != 0 || !strings.Contains(out, "Running: off\n") || !strings.Contains(out, "Files: not set up\n") {
		t.Fatalf("remote status: code %d\n%s", code, out)
	}
	if log := serverLog(t, in.dir); strings.Contains(log, "Remote") {
		t.Fatalf("the log speaks of remote access:\n%s", log)
	}
	before["instance-id"] = remoteFiles(t, in.dir)["instance-id"] // the start makes the instance id
	if before["instance-id"] == "" {
		t.Fatal("the start made no instance id")
	}
	sameRemoteFiles(t, in.dir, before)
}

// Hello gives the instance id, which is made at the first start and kept from then on.
func TestHelloInstanceIDSurvivesRestart(t *testing.T) {
	in := newInstance(t)
	t.Setenv("AIWB_REMOTE_BIND", "127.0.0.1")
	in.run(t, "launch")
	old := in.hello(t).Pid
	id, _ := in.helloMap(t)["instanceId"].(string)
	if !remote.ValidID(id) {
		t.Fatalf("hello's instanceId is %q, want a version 4 UUID", id)
	}
	b, err := os.ReadFile(remote.FilesIn(in.dir).InstanceID)
	if err != nil || string(b) != id+"\n" {
		t.Fatalf("the instance-id file holds %q (%v), want %q", b, err, id)
	}

	in.run(t, "relaunch")
	if pid := in.hello(t).Pid; pid == old {
		t.Fatalf("/api/hello still reports the old pid %d", old)
	}
	if got := in.helloMap(t)["instanceId"]; got != id {
		t.Fatalf("after a restart hello's instanceId is %v, want %q", got, id)
	}
}

// With a set-up the start serves hello over HTTPS to a caller with the secret and a listed Host,
// and to nobody else; the loopback listener is as before.
func TestRemoteListenerServes(t *testing.T) {
	in, port := newRemoteInstance(t)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)

	if got := in.run(t, "launch"); got != in.url+"\n" {
		t.Fatalf("launch printed %q", got)
	}
	st := in.waitListening(t)
	if st.Port != port || st.Fingerprint != fp || !strings.Contains(" "+strings.Join(st.Names, " ")+" ", " 127.0.0.1 ") {
		t.Fatalf("remote status %+v, want port %d, fingerprint %s and the name 127.0.0.1", st, port, fp)
	}
	out, errOut, code := own(t, "remote", "status", "-home", in.dir, "-server-port", strconv.Itoa(in.port))
	if code != 0 || !strings.Contains(out, "Running: listening\n") || !strings.Contains(out, "Running fingerprint: "+fp+"\n") ||
		!strings.Contains(out, "Files: the next start will listen\n") {
		t.Fatalf("remote status: code %d\n%s%s", code, out, errOut)
	}

	local := in.helloMap(t)
	if _, ok := local["pid"]; !ok {
		t.Fatalf("the loopback hello has no pid: %v", local)
	}
	body := remoteOK(t, port, fp, secret)
	if _, ok := body["pid"]; ok {
		t.Fatalf("the remote hello gives the pid: %v", body)
	}
	if body["instanceId"] != local["instanceId"] || body["instanceId"] == nil {
		t.Fatalf("the remote hello's instanceId is %v, the loopback one's %v", body["instanceId"], local["instanceId"])
	}

	const wrong = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	for _, c := range []struct {
		what, secret, host string
		status             int
	}{
		{"no secret", "", "", http.StatusUnauthorized},
		{"a wrong secret", wrong, "", http.StatusUnauthorized},
		{"a wrong secret and another Host", wrong, "evil.example:" + strconv.Itoa(port), http.StatusUnauthorized},
		{"another Host", secret, "evil.example:" + strconv.Itoa(port), http.StatusForbidden},
		{"a listed name with another port", secret, "127.0.0.1:" + strconv.Itoa(in.port), http.StatusForbidden},
		{"a listed name without the port", secret, "127.0.0.1", http.StatusForbidden},
	} {
		if status, body := remoteHello(t, port, fp, c.secret, c.host); status != c.status {
			t.Fatalf("%s: status %d, want %d (%v)", c.what, status, c.status, body)
		}
	}

	resp, err := httpClient().Get(fmt.Sprintf("http://127.0.0.1:%d/api/hello", port))
	if err != nil {
		t.Fatalf("plain HTTP: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("plain HTTP: status %d, want 400", resp.StatusCode)
	}

	log := serverLog(t, in.dir)
	if want := fmt.Sprintf("Remote listener: https://127.0.0.1:%d  names ", port); !strings.Contains(log, want) || !strings.Contains(log, "certificate SHA-256 "+fp) {
		t.Fatalf("the log lacks %q or the fingerprint:\n%s", want, log)
	}
	if !strings.Contains(log, "remote listener: refused 401 from 127.0.0.1") {
		t.Fatalf("the log has no line for the refused requests:\n%s", log)
	}
	noSecret(t, secret, log, out, errOut)
	noSecret(t, wrong, log)
}

// The one test without the bind override: the remote port is bound on every IPv4 address of the
// machine and on no IPv6 one. On macOS it runs only on request, because the wildcard bind of a
// freshly built binary can raise the macOS firewall dialog.
func TestRemoteListenerBindsWildcardIPv4(t *testing.T) {
	if runtime.GOOS == "darwin" && os.Getenv("AIWB_TEST_WILDCARD") != "1" {
		t.Skip("binds 0.0.0.0, which can raise the macOS firewall dialog: set AIWB_TEST_WILDCARD=1 to run it (it is skipped with -short too)")
	}
	in := newInstance(t)
	t.Setenv("AIWB_REMOTE_BIND", "")
	port := freePort(t)
	setUpRemote(t, in.dir, port)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)

	in.run(t, "launch")
	in.waitListening(t)
	if want := fmt.Sprintf("Remote listener: https://0.0.0.0:%d  names ", port); !strings.Contains(serverLog(t, in.dir), want) {
		t.Fatalf("the log lacks %q:\n%s", want, serverLog(t, in.dir))
	}

	if lsof, err := exec.LookPath("lsof"); err != nil {
		t.Log("no lsof: the bound address is checked by the dials alone")
	} else {
		out, _ := exec.Command(lsof, "-nP", "-a", "-p", strconv.Itoa(in.hello(t).Pid), "-iTCP:"+strconv.Itoa(port), "-sTCP:LISTEN").Output()
		var lines []string
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(line, "(LISTEN)") {
				lines = append(lines, line)
			}
		}
		if len(lines) != 1 || !strings.Contains(lines[0], fmt.Sprintf("TCP *:%d (LISTEN)", port)) || !strings.Contains(lines[0], "IPv4") {
			t.Fatalf("lsof: want one IPv4 listener on *:%d, got:\n%s", port, out)
		}
	}
	if c, err := net.DialTimeout("tcp6", fmt.Sprintf("[::1]:%d", port), time.Second); err == nil {
		c.Close()
		t.Fatalf("a dial to [::1]:%d was accepted: the listener answers IPv6", port)
	}
	remoteOK(t, port, fp, secret)
}

// Every fatal row of the start's check ends `serve` with exit code 1 and the check's message, and
// the start creates nothing: no listener, no server.json, no file in the data folder.
func TestStartCheckFatalRows(t *testing.T) {
	first := newInstance(t)
	t.Setenv("AIWB_REMOTE_BIND", "127.0.0.1")
	write := func(t *testing.T, path, content string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	remove := func(t *testing.T, paths ...string) {
		t.Helper()
		for _, path := range paths {
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}
	}
	rows := []struct {
		name string
		port func(in *instance) int                    // the remote port; nil: a free one
		ruin func(t *testing.T, f remote.Files)        // what is wrong with the files
		want func(in *instance, f remote.Files) string // the row's line, after "Remote access: "
		fix  string                                    // the repair's words
	}{
		{name: "configuration not JSON",
			ruin: func(t *testing.T, f remote.Files) { write(t, f.Config, "{") },
			want: func(in *instance, f remote.Files) string {
				return "the configuration " + f.Config + " is unreadable or not valid"
			},
			fix: "remote setup -home"},
		{name: "configuration without names",
			ruin: func(t *testing.T, f remote.Files) { write(t, f.Config, `{"port": 4748, "names": []}`) },
			want: func(in *instance, f remote.Files) string {
				return "the configuration " + f.Config + " is unreadable or not valid"
			},
			fix: "remote setup -home"},
		{name: "secret missing",
			ruin: func(t *testing.T, f remote.Files) { remove(t, f.Secret) },
			want: func(in *instance, f remote.Files) string { return "the secret " + f.Secret + " is missing" },
			fix:  "remote setup -home"},
		{name: "secret empty",
			ruin: func(t *testing.T, f remote.Files) { write(t, f.Secret, "\n") },
			want: func(in *instance, f remote.Files) string { return "the secret " + f.Secret + " is empty" },
			fix:  "secret -new"},
		{name: "secret not in set-up's form",
			ruin: func(t *testing.T, f remote.Files) { write(t, f.Secret, "my own password\n") },
			want: func(in *instance, f remote.Files) string { return "the secret " + f.Secret + " is not" },
			fix:  "secret -new"},
		{name: "certificate and key missing",
			ruin: func(t *testing.T, f remote.Files) { remove(t, f.Cert, f.Key) },
			want: func(in *instance, f remote.Files) string {
				return "the certificate " + f.Cert + " and the key " + f.Key + " are missing"
			},
			fix: "remote setup -home"},
		{name: "key missing",
			ruin: func(t *testing.T, f remote.Files) { remove(t, f.Key) },
			want: func(in *instance, f remote.Files) string { return "the key " + f.Key + " is missing" },
			fix:  "remote setup -new-cert"},
		{name: "certificate missing",
			ruin: func(t *testing.T, f remote.Files) { remove(t, f.Cert) },
			want: func(in *instance, f remote.Files) string { return "the certificate " + f.Cert + " is missing" },
			fix:  "remote setup -new-cert"},
		{name: "certificate without PEM data",
			ruin: func(t *testing.T, f remote.Files) { write(t, f.Cert, "garbage\n") },
			want: func(in *instance, f remote.Files) string { return "the certificate " + f.Cert + " is not right" },
			fix:  "remote setup -new-cert"},
		{name: "key empty",
			ruin: func(t *testing.T, f remote.Files) { write(t, f.Key, "") },
			want: func(in *instance, f remote.Files) string { return "the key " + f.Key + " is not right" },
			fix:  "remote setup -new-cert"},
		{name: "certificate and key do not fit",
			ruin: func(t *testing.T, f remote.Files) {
				_, key, err := remote.GenerateCert([]string{"127.0.0.1"}, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
				if err != nil {
					t.Fatal(err)
				}
				write(t, f.Key, string(key))
			},
			want: func(in *instance, f remote.Files) string {
				return "the certificate " + f.Cert + " and the key " + f.Key + " are not right"
			},
			fix: "remote setup -new-cert"},
		{name: "port equal to the server's own",
			port: func(in *instance) int { return in.port },
			want: func(in *instance, f remote.Files) string {
				return fmt.Sprintf("the remote port %d is the server's own port", in.port)
			},
			fix: "remote setup -port N"},
		{name: "port equal to the MCP port",
			port: func(in *instance) int { return in.mcpPort },
			want: func(in *instance, f remote.Files) string {
				return fmt.Sprintf("the remote port %d is the MCP port", in.mcpPort)
			},
			fix: "remote setup -port N"},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			in := *first // the same binary and ports: no start of a row gets as far as a bind
			in.dir = t.TempDir()
			f := remote.FilesIn(in.dir)
			port := freePort(t)
			if row.port != nil {
				port = row.port(&in)
			}
			setUpRemote(t, in.dir, port)
			if row.ruin != nil {
				row.ruin(t, f)
			}
			before := folder(t, in.dir)
			message := remote.Check(in.dir, in.port, in.mcpPort).Message(in.exe(t), in.dir)

			stdout, stderr, code := in.ends(t, "serve")
			if code != 1 || stdout != "" {
				t.Fatalf("serve: exit code %d, stdout %q, want 1 and nothing\n%s", code, stdout, stderr)
			}
			// The message is all the start says: nothing is logged before it.
			lines := strings.Split(strings.TrimRight(stderr, "\n"), "\n")
			if !strings.HasSuffix(stderr, message+"\n") || len(lines) != strings.Count(message, "\n")+1 || len(lines) > 6 {
				t.Fatalf("serve said:\n%s\nwant the message alone, at most six lines:\n%s", stderr, message)
			}
			for _, want := range []string{
				"Remote access: " + row.want(&in, f),
				"\nThe start creates nothing.\n",
				fmt.Sprintf("\nTo repair: %q %s", in.exe(t), row.fix),
				fmt.Sprintf("\nTo start without remote access: %q remote off -home %q\n", in.exe(t), in.dir),
			} {
				if !strings.Contains(stderr, want) {
					t.Fatalf("serve's message lacks %q:\n%s", want, stderr)
				}
			}
			in.noServer(t)
			sameFolder(t, in.dir, before)
		})
	}
}

// The row the check cannot see: another listener holds the remote port. The start ends the same
// way, after its binds and before it writes anything.
func TestStartBindRow(t *testing.T) {
	in, port := newRemoteInstance(t)
	holder, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()
	before := folder(t, in.dir)

	began := time.Now()
	stdout, stderr, code := in.ends(t, "serve")
	took := time.Since(began)
	if code != 1 || stdout != "" {
		t.Fatalf("serve: exit code %d, stdout %q, want 1 and nothing\n%s", code, stdout, stderr)
	}
	// AC22: no bind is tried again. The port is still held, and the start did not wait for it.
	if c, err := net.DialTimeout("tcp4", holder.Addr().String(), time.Second); err != nil {
		t.Fatalf("the holder of port %d is gone: %v", port, err)
	} else {
		c.Close()
	}
	if took >= 3*time.Second {
		t.Fatalf("serve ended after %s with the port still held, want under 3 s: it waited for the port", took)
	}
	if n := strings.Count(stderr, "\n"); n != 4 {
		t.Fatalf("serve said %d lines, want the message's four:\n%s", n, stderr)
	}
	for _, want := range []string{
		fmt.Sprintf("Remote access: the remote port %d cannot be bound: ", port),
		"address already in use",
		"\nThe start creates nothing.\n",
		fmt.Sprintf("\nTo repair: free port %d, or %q remote setup -port N -home %q\n", port, in.exe(t), in.dir),
		fmt.Sprintf("\nTo start without remote access: %q remote off -home %q\n", in.exe(t), in.dir),
	} {
		if !strings.Contains(stderr, want) {
			t.Fatalf("serve's message lacks %q:\n%s", want, stderr)
		}
	}
	in.noServer(t)
	if listening(in.mcpPort) {
		t.Fatalf("something accepts on the MCP port %d", in.mcpPort)
	}
	sameFolder(t, in.dir, before)
}

// AC37: the check comes before any bind. With the app port and the MCP port both held by others,
// a start with a fatal row of the check ends with the check's message and never gets as far as
// the port's own message.
func TestStartCheckComesBeforeTheBinds(t *testing.T) {
	first := newInstance(t)
	t.Setenv("AIWB_REMOTE_BIND", "127.0.0.1")
	srv := hello("other")
	defer srv.Close()
	first.port = portOf(t, srv)
	first.url = fmt.Sprintf("http://127.0.0.1:%d/", first.port)
	mcp, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", first.mcpPort))
	if err != nil {
		t.Fatal(err)
	}
	defer mcp.Close()

	rows := []struct {
		name string
		port func(in *instance) int             // the remote port; nil: a free one
		ruin func(t *testing.T, f remote.Files) // what is wrong with the files
		want func(in *instance, f remote.Files) string
	}{
		{name: "key missing",
			ruin: func(t *testing.T, f remote.Files) {
				if err := os.Remove(f.Key); err != nil {
					t.Fatal(err)
				}
			},
			want: func(in *instance, f remote.Files) string { return "the key " + f.Key + " is missing" }},
		{name: "port equal to the server's own",
			port: func(in *instance) int { return in.port },
			want: func(in *instance, f remote.Files) string {
				return fmt.Sprintf("the remote port %d is the server's own port", in.port)
			}},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			in := *first
			in.dir = t.TempDir()
			f := remote.FilesIn(in.dir)
			port := freePort(t)
			if row.port != nil {
				port = row.port(&in)
			}
			setUpRemote(t, in.dir, port)
			if row.ruin != nil {
				row.ruin(t, f)
			}
			before := folder(t, in.dir)
			message := remote.Check(in.dir, in.port, in.mcpPort).Message(in.exe(t), in.dir)

			stdout, stderr, code := in.ends(t, "serve")
			if code != 1 || stdout != "" {
				t.Fatalf("serve: exit code %d, stdout %q, want 1 and nothing\n%s", code, stdout, stderr)
			}
			// The message is all the start says, after the log's date and time.
			said, isLog := strings.CutSuffix(stderr, message+"\n")
			if _, err := time.Parse("2006/01/02 15:04:05 ", said); !isLog || err != nil || !strings.HasPrefix(message, "Remote access: "+row.want(&in, f)+"\n") {
				t.Fatalf("serve said:\n%s\nwant the check's message alone:\n%s", stderr, message)
			}
			if strings.Contains(stderr, "cannot listen on port") {
				t.Fatalf("serve got as far as a bind:\n%s", stderr)
			}
			// The holder of the app port was left alone and still answers.
			if h := in.helloMap(t); h["app"] != "other" {
				t.Fatalf("the holder of port %d: hello %v", in.port, h)
			}
			if _, err := os.Stat(filepath.Join(in.dir, "server.json")); !os.IsNotExist(err) {
				t.Fatalf("server.json: %v, want none", err)
			}
			sameFolder(t, in.dir, before)
		})
	}
}

// launch passes the check's message on whole, also when it has its six lines.
func TestLaunchShowsTheCheckMessage(t *testing.T) {
	in := newInstance(t)
	t.Setenv("AIWB_REMOTE_BIND", "127.0.0.1")
	setUpRemote(t, in.dir, in.port) // the server's own port
	f := remote.FilesIn(in.dir)
	for _, path := range []string{f.Secret, f.Key} {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	before := remoteFiles(t, in.dir)
	message := remote.Check(in.dir, in.port, in.mcpPort).Message(in.exe(t), in.dir)
	if n := strings.Count(message, "\n") + 1; n != 6 {
		t.Fatalf("the message has %d lines, want the six of the worst case:\n%s", n, message)
	}

	stdout, stderr, code := in.ends(t, "launch")
	if code != 1 || stdout != "" {
		t.Fatalf("launch: exit code %d, stdout %q, want 1 and nothing\n%s", code, stdout, stderr)
	}
	if !strings.Contains(stderr, "AI Whiteboard: the server stopped while starting") {
		t.Fatalf("launch said:\n%s", stderr)
	}
	messageLines(t, stderr, message)
	in.noServer(t)
	sameRemoteFiles(t, in.dir, before)
}

// relaunch runs the check before it stops anything: with a set-up that would end the new start,
// the running server stays.
func TestRelaunchRefusesBrokenSetup(t *testing.T) {
	in, port := newRemoteInstance(t)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	in.run(t, "launch")
	in.waitListening(t)
	pid := in.hello(t).Pid

	refused := func(what string) {
		t.Helper()
		message := remote.Check(in.dir, in.port, in.mcpPort).Message(in.exe(t), in.dir)
		stdout, stderr, code := in.ends(t, "relaunch")
		if code != 1 || stdout != "" {
			t.Fatalf("%s: relaunch: exit code %d, stdout %q, want 1 and nothing\n%s", what, code, stdout, stderr)
		}
		if !strings.Contains(stderr, "AI Whiteboard: the server was not restarted") {
			t.Fatalf("%s: relaunch said:\n%s", what, stderr)
		}
		messageLines(t, stderr, message)
		if got := in.hello(t).Pid; got != pid {
			t.Fatalf("%s: the server has pid %d, want the one before, %d", what, got, pid)
		}
		remoteOK(t, port, fp, secret)
	}

	key := remote.FilesIn(in.dir).Key
	keyPEM, err := os.ReadFile(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(key); err != nil {
		t.Fatal(err)
	}
	refused("key removed")
	if err := os.WriteFile(key, keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}

	setUpRemote(t, in.dir, in.port)
	refused("remote port equal to the server's")

	// Put right, relaunch replaces the server.
	setUpRemote(t, in.dir, port)
	if got := in.run(t, "relaunch"); got != in.url+"\n" {
		t.Fatalf("relaunch printed %q", got)
	}
	if got := in.hello(t).Pid; got == pid {
		t.Fatalf("/api/hello still reports the old pid %d", pid)
	}
	in.waitListening(t)
	remoteOK(t, port, fp, secret)
}

// A restart keeps the secret and the certificate: a client set up once goes on working.
func TestSecretSurvivesRestart(t *testing.T) {
	in, port := newRemoteInstance(t)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	in.run(t, "launch")
	in.waitListening(t)
	old := in.hello(t).Pid
	remoteOK(t, port, fp, secret)

	in.run(t, "relaunch")
	if pid := in.hello(t).Pid; pid == old {
		t.Fatalf("/api/hello still reports the old pid %d", old)
	}
	if st := in.waitListening(t); st.Fingerprint != fp {
		t.Fatalf("after a restart the fingerprint is %s, want %s", st.Fingerprint, fp)
	}
	remoteOK(t, port, fp, secret)
	if got := secretOf(t, in.dir); got != secret {
		t.Fatal("the restart changed the secret")
	}
}

// `secret -new` writes the new secret and tells the running server, which accepts the new one
// alone from then on and ends the streams of its API clients. A restart keeps the new secret.
func TestSecretNewThenRestart(t *testing.T) {
	in, port := newRemoteInstance(t)
	old, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	in.run(t, "launch")
	in.waitListening(t)
	pid := in.hello(t).Pid
	c := apiClient(t, port, fp, old, testClient)
	c.Welcome()

	out, errOut, code := own(t, "secret", "-new", "-home", in.dir)
	fresh := strings.TrimSpace(out)
	if code != 0 || fresh == old || fresh != secretOf(t, in.dir) || out != fresh+"\n" {
		t.Fatalf("secret -new: code %d, stderr %q", code, errOut)
	}
	if errOut != "The running server accepts the new secret only, from now on. Its API clients were disconnected and need the new secret.\n" {
		t.Fatalf("stderr %q", errOut)
	}
	// The command returned after the server confirmed: no wait is needed here.
	if status, _ := remoteHello(t, port, fp, old, ""); status != http.StatusUnauthorized {
		t.Fatalf("the old secret after secret -new: status %d, want 401", status)
	}
	c.ExpectEnded()
	remoteOK(t, port, fp, fresh)
	if status, _ := streamStatus(t, port, fp, old, testClient); status != http.StatusUnauthorized {
		t.Fatalf("a stream with the old secret: status %d, want 401", status)
	}
	apiClient(t, port, fp, fresh, testClient).Welcome()
	if st := in.waitListening(t); st.SecretReloads != 1 {
		t.Fatalf("secretReloads = %d, want 1", st.SecretReloads)
	}
	if got := in.hello(t).Pid; got != pid {
		t.Fatalf("the server's pid is %d, was %d: the signal ended it", got, pid)
	}
	if log := serverLog(t, in.dir); !strings.Contains(log, "Remote listener: the secret was read again; 1 API client streams closed\n") {
		t.Fatalf("the log lacks the reload's line:\n%s", log)
	}
	noSecret(t, old, serverLog(t, in.dir), errOut)
	noSecret(t, fresh, serverLog(t, in.dir), errOut)

	in.run(t, "relaunch")
	if st := in.waitListening(t); st.SecretReloads != 0 {
		t.Fatalf("secretReloads after a restart = %d, want 0", st.SecretReloads)
	}
	remoteOK(t, port, fp, fresh)
	if status, _ := remoteHello(t, port, fp, old, ""); status != http.StatusUnauthorized {
		t.Fatalf("the old secret after the restart: status %d, want 401", status)
	}
	noSecret(t, old, serverLog(t, in.dir))
	noSecret(t, fresh, serverLog(t, in.dir))
}

// A start, a restart and a stop leave the files of remote access as set-up wrote them; the start
// adds the instance id alone.
func TestStartChangesNoFile(t *testing.T) {
	in, _ := newRemoteInstance(t)
	before := remoteFiles(t, in.dir)
	if before["instance-id"] != "" {
		t.Fatal("set-up made an instance id")
	}

	in.run(t, "launch")
	in.waitListening(t)
	before["instance-id"] = remoteFiles(t, in.dir)["instance-id"]
	if before["instance-id"] == "" {
		t.Fatal("the start made no instance id")
	}
	sameRemoteFiles(t, in.dir, before)

	in.run(t, "relaunch")
	in.waitListening(t)
	sameRemoteFiles(t, in.dir, before)

	if out := in.run(t, "stop"); !strings.Contains(out, "AI Whiteboard stopped") {
		t.Fatalf("stop printed %q", out)
	}
	sameRemoteFiles(t, in.dir, before)
	if listening(in.port) {
		t.Fatalf("something still accepts on port %d", in.port)
	}
}

// The owner's own pair, here an RSA one in the two files, is loaded and served as it is; that its
// names are not the list's is a note in the log.
func TestOwnersPairIsServed(t *testing.T) {
	in, port := newRemoteInstance(t)
	secret, made := secretOf(t, in.dir), fingerprintOf(t, in.dir)

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "the owner's"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	f := remote.FilesIn(in.dir)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err := os.WriteFile(f.Key, keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.Cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	fp := remote.Fingerprint(der)
	if fp == made {
		t.Fatal("the owner's certificate has set-up's fingerprint")
	}
	before := remoteFiles(t, in.dir)

	in.run(t, "launch")
	if st := in.waitListening(t); st.Fingerprint != fp {
		t.Fatalf("the server reports the fingerprint %s, want the owner's %s", st.Fingerprint, fp)
	}
	remoteOK(t, port, fp, secret)
	log := serverLog(t, in.dir)
	if !strings.Contains(log, "certificate SHA-256 "+fp) || !strings.Contains(log, "Remote listener: note: the certificate's names (127.0.0.1) differ from the list") {
		t.Fatalf("the log lacks the owner's fingerprint or the note on its names:\n%s", log)
	}
	before["instance-id"] = remoteFiles(t, in.dir)["instance-id"]
	sameRemoteFiles(t, in.dir, before)
}

// internal/remote and internal/server each spell the header names: they must agree.
func TestHeaderNamesAgree(t *testing.T) {
	if remote.SecretHeader != server.SecretHeader {
		t.Fatalf("the secret's header is %q in internal/remote and %q in internal/server", remote.SecretHeader, server.SecretHeader)
	}
	if remote.ClientHeader != server.ClientHeader {
		t.Fatalf("the client's header is %q in internal/remote and %q in internal/server", remote.ClientHeader, server.ClientHeader)
	}
}

// The hidden AIWB_REMOTE_BIND override defaults to every IPv4 address; it is not a flag.
func TestRemoteBindSetting(t *testing.T) {
	t.Setenv("AIWB_REMOTE_BIND", "")
	if got := remoteBind(); got != "0.0.0.0" {
		t.Fatalf("unset override: got %q, want 0.0.0.0", got)
	}
	t.Setenv("AIWB_REMOTE_BIND", " 127.0.0.1 ")
	if got := remoteBind(); got != "127.0.0.1" {
		t.Fatalf("override: got %q, want 127.0.0.1", got)
	}
}

// The commands of a message name the data folder unless it is the default one.
func TestMessageHome(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip(err)
	}
	if got := messageHome(filepath.Join(home, ".ai-whiteboard")); got != "" {
		t.Fatalf("the default folder: got %q, want none", got)
	}
	dir := t.TempDir()
	if got := messageHome(dir); got != dir {
		t.Fatalf("another folder: got %q, want %q", got, dir)
	}
}
