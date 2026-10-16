package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
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

// helloWith asks the client listener for /api/hello over HTTPS, as a client does: the certificate
// is pinned by its fingerprint, and the secret, the client id and the level are in their headers
// when they are not "". host, when not "", replaces the Host value. It returns the status and the
// decoded body.
func (in *instance) helloWith(t *testing.T, secret, host string) (int, map[string]any) {
	t.Helper()
	return in.getWith(t, "/api/hello", secret, host, testLevel)
}

// getWith is helloWith for any path, with the level a client states ("" states none).
func (in *instance) getWith(t *testing.T, path, secret, host, level string) (int, map[string]any) {
	t.Helper()
	tr := pinned(in.fpr)
	defer tr.CloseIdleConnections()
	req, err := http.NewRequest("GET", in.base()+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	if secret != "" {
		req.Header.Set(server.SecretHeader, secret)
	}
	req.Header.Set(server.ClientHeader, testClient)
	if level != "" {
		req.Header.Set(server.LevelHeader, level)
	}
	resp, err := (&http.Client{Transport: tr, Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer resp.Body.Close()
	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body) // a page or an empty body is no JSON
	return resp.StatusCode, body
}

// helloOK asks for hello with the secret and must get it.
func (in *instance) helloOK(t *testing.T, secret string) map[string]any {
	t.Helper()
	status, body := in.helloWith(t, secret, "")
	if status != http.StatusOK || body["app"] != "ai-whiteboard" {
		t.Fatalf("hello: status %d, body %v", status, body)
	}
	return body
}

// messageLines checks that text holds every line of the check's message.
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

// lsofListeners returns the TCP listeners of process pid, one line each; nil when there is no lsof.
func lsofListeners(t *testing.T, pid int, more ...string) []string {
	t.Helper()
	lsof, err := exec.LookPath("lsof")
	if err != nil {
		t.Log("no lsof: the process's listeners are not counted")
		return nil
	}
	out, _ := exec.Command(lsof, append([]string{"-nP", "-a", "-p", strconv.Itoa(pid), "-iTCP"}, append(more, "-sTCP:LISTEN")...)...).Output()
	lines := []string{}
	for _, line := range strings.Split(string(out), "\n") {
		if strings.Contains(line, "(LISTEN)") {
			lines = append(lines, line)
		}
	}
	return lines
}

func TestHelloInstanceIDSurvivesRestart(t *testing.T) {
	serverTest(t, "TestInstanceID (internal/remote)", "TestHelloInstanceID (internal/server)")
	in := newInstance(t)
	in.launchJSON(t, "launch")
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
		t.Fatalf("hello still reports the old pid %d", old)
	}
	if got := in.helloMap(t)["instanceId"]; got != id {
		t.Fatalf("after a restart hello's instanceId is %v, want %q", got, id)
	}
}

// The client listener of a real server: HTTPS, the secret for every route but hello, a listed
// Host, a client of level 7; no page at any address; two TCP listeners, the clients' and the MCP
// one.
func TestClientListenerServes(t *testing.T) {
	smokeTest(t)
	in := newInstance(t)
	in.launchJSON(t, "launch")
	st, _ := in.waitServing(t).statusOf()
	if st.Client.Port != in.port || st.Client.Fingerprint != in.fpr || !slices.Contains(st.Client.Names, "127.0.0.1") {
		t.Fatalf("status %+v, want port %d, fingerprint %s and the name 127.0.0.1", st, in.port, in.fpr)
	}

	local := in.helloMap(t)
	body := in.helloOK(t, in.secret)
	if _, ok := body["pid"]; ok {
		t.Fatalf("the client hello gives the pid: %v", body)
	}
	if body["instanceId"] != local["instanceId"] || body["instanceId"] == nil {
		t.Fatalf("the client hello's instanceId is %v, the control socket's %v", body["instanceId"], local["instanceId"])
	}
	if body["featureLevel"] != float64(7) || local["featureLevel"] != float64(7) || server.FeatureLevel != 7 {
		t.Fatalf("the feature level is %v in the client hello, %v in the control socket's and %d in the server; want 7", body["featureLevel"], local["featureLevel"], server.FeatureLevel)
	}
	// The first question is answered without the secret.
	if status, body := in.helloWith(t, "", ""); status != http.StatusOK || body["app"] != "ai-whiteboard" {
		t.Fatalf("hello without the secret: status %d, %v", status, body)
	}

	const wrong = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	// (The log holds one line a minute for an address: the 401 comes first, and is the one looked for below.)
	// Every other route needs the secret: it is refused with none and with a wrong one, also from
	// this machine, and nothing serves a page at any address.
	for _, path := range []string{"/api/state", "/", "/index.html", "/assets/app.js", "/api/servers", "/api/on/s_0123456789ab/state", "/api/restart",
		"/api/mcp/status", "/api/remote/status", "/api/groups/order", "/api/boards/b_00000000/reveal"} {
		for _, secret := range []string{"", wrong} {
			if status, _ := in.getWith(t, path, secret, "", testLevel); status != http.StatusUnauthorized {
				t.Fatalf("GET %s with the secret %q: status %d, want 401", path, secret, status)
			}
		}
		if status, body := in.getWith(t, path, in.secret, "", testLevel); status != http.StatusNotFound && path != "/api/state" {
			t.Fatalf("GET %s with the secret: status %d (%v), want 404", path, status, body)
		}
	}
	for _, c := range []struct {
		what, secret, host string
		status             int
	}{
		{"another Host", in.secret, "evil.example:" + strconv.Itoa(in.port), http.StatusForbidden},
		{"another Host without the secret", "", "evil.example:" + strconv.Itoa(in.port), http.StatusForbidden},
		{"a listed name with another port", in.secret, "127.0.0.1:1", http.StatusForbidden},
		{"localhost", in.secret, "localhost:" + strconv.Itoa(in.port), http.StatusOK},
		{"127.0.0.1 with the port", in.secret, "127.0.0.1:" + strconv.Itoa(in.port), http.StatusOK},
	} {
		if status, body := in.helloWith(t, c.secret, c.host); status != c.status {
			t.Fatalf("%s: status %d, want %d (%v)", c.what, status, c.status, body)
		}
	}
	if status, _ := in.getWith(t, "/api/state", in.secret, "", testLevel); status != http.StatusOK {
		t.Fatalf("the state with the secret: status %d", status)
	}
	// A client of level 5, or one that states none, is refused every route but hello.
	for _, level := range []string{"", "5", "five"} {
		status, body := in.getWith(t, "/api/state", in.secret, "", level)
		if status != http.StatusBadRequest || body["code"] != "client_too_old" {
			t.Fatalf("the state for a client of the level %q: status %d: %v; want 400 client_too_old", level, status, body)
		}
	}

	resp, err := (&http.Client{Timeout: 5 * time.Second}).Get(fmt.Sprintf("http://127.0.0.1:%d/api/hello", in.port))
	if err != nil {
		t.Fatalf("plain HTTP: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("plain HTTP: status %d, want 400", resp.StatusCode)
	}

	// Two TCP listeners, the clients' and the MCP one, and no other.
	if lines := lsofListeners(t, in.hello(t).Pid); lines != nil {
		on := func(port int) bool {
			return slices.ContainsFunc(lines, func(line string) bool { return strings.Contains(line, fmt.Sprintf(":%d (LISTEN)", port)) })
		}
		if len(lines) != 2 || !on(in.port) || !on(in.mcpPort) {
			t.Fatalf("lsof: want two listeners, on the ports %d and %d, got:\n%s", in.port, in.mcpPort, strings.Join(lines, "\n"))
		}
	}

	log := serverLog(t, in.dir)
	if want := fmt.Sprintf("Remote listener: https://127.0.0.1:%d  names ", in.port); !strings.Contains(log, want) || !strings.Contains(log, "certificate SHA-256 "+in.fpr) {
		t.Fatalf("the log lacks %q or the fingerprint:\n%s", want, log)
	}
	if !strings.Contains(log, "remote listener: refused 401 from 127.0.0.1") {
		t.Fatalf("the log has no line for the refused requests:\n%s", log)
	}
	noSecret(t, in.secret, log)
	noSecret(t, wrong, log)
}

// The one test without the bind override: the client port is bound on every IPv4 address of the
// machine and on no IPv6 one. On macOS it runs only on request, because the wildcard bind of a
// freshly built binary can raise the macOS firewall dialog.
func TestClientListenerBindsWildcardIPv4(t *testing.T) {
	serverTest(t, "TestRemoteBindSetting, TestClientListenerServes (this package)")
	if runtime.GOOS == "darwin" && os.Getenv("AIWB_TEST_WILDCARD") != "1" {
		t.Skip("binds 0.0.0.0, which can raise the macOS firewall dialog: set AIWB_TEST_WILDCARD=1 to run it (in the full set)")
	}
	in := newInstance(t)
	in.setenv("AIWB_REMOTE_BIND=") // whatever this process has

	in.launchJSON(t, "launch")
	if want := fmt.Sprintf("Remote listener: https://0.0.0.0:%d  names ", in.port); !strings.Contains(serverLog(t, in.dir), want) {
		t.Fatalf("the log lacks %q:\n%s", want, serverLog(t, in.dir))
	}
	if lines := lsofListeners(t, in.hello(t).Pid, ":"+strconv.Itoa(in.port)); lines != nil {
		if len(lines) != 1 || !strings.Contains(lines[0], fmt.Sprintf("TCP *:%d (LISTEN)", in.port)) || !strings.Contains(lines[0], "IPv4") {
			t.Fatalf("lsof: want one IPv4 listener on *:%d, got:\n%s", in.port, strings.Join(lines, "\n"))
		}
	}
	if c, err := net.DialTimeout("tcp6", fmt.Sprintf("[::1]:%d", in.port), time.Second); err == nil {
		c.Close()
		t.Fatalf("a dial to [::1]:%d was accepted: the listener answers IPv6", in.port)
	}
	in.helloOK(t, in.secret)
}

// Every fatal row of the start's check ends `serve` with exit code 1 and the check's message, and
// the start creates nothing: no listener, no server.json, no file in the data folder.
func TestStartCheckFatalRows(t *testing.T) {
	serverTest(t, "TestCheckFatalRows, TestMessageWorstCase (internal/remote)", "TestNotSetUpRefusesThenStarts (this package)")
	first := newInstance(t)
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
		port func(in *instance) int                    // the client port; nil: a free one
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
		{name: "port equal to the MCP port",
			port: func(in *instance) int { return in.mcpPort },
			want: func(in *instance, f remote.Files) string {
				return fmt.Sprintf("the remote port %d is the MCP port", in.mcpPort)
			},
			fix: "remote setup -port N"},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			in := *first // the same binary and MCP port: no start of a row gets as far as a bind
			in.dir = t.TempDir()
			f := remote.FilesIn(in.dir)
			in.port = freePort(t)
			if row.port != nil {
				in.port = row.port(&in)
			}
			in.setUp(t)
			if row.ruin != nil {
				row.ruin(t, f)
			}
			before := folder(t, in.dir)
			message := remote.Check(in.dir, in.mcpPort).Message(in.exe(t), in.dir)

			stdout, stderr, code := in.ends(t, "serve")
			if code != 1 || stdout != "" {
				t.Fatalf("serve: exit code %d, stdout %q, want 1 and nothing\n%s", code, stdout, stderr)
			}
			// The message is all the start says: nothing is logged before it.
			lines := strings.Split(strings.TrimRight(stderr, "\n"), "\n")
			if !strings.HasSuffix(stderr, message+"\n") || len(lines) != strings.Count(message, "\n")+1 || len(lines) > 5 {
				t.Fatalf("serve said:\n%s\nwant the message alone, at most five lines:\n%s", stderr, message)
			}
			for _, want := range []string{
				"Remote access: " + row.want(&in, f),
				"\nThe start creates nothing.\n",
				fmt.Sprintf("\nTo repair: %q %s", in.exe(t), row.fix),
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

// The row the check cannot see: another listener holds the client port. The start ends the same
// way, after its binds and before it writes anything.
func TestStartBindRow(t *testing.T) {
	serverTest(t, "TestBindMessage (internal/remote)", "TestNotSetUpRefusesThenStarts (a start that ends and creates nothing) (this package)")
	in := newInstance(t)
	holder, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", in.port))
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
	// No bind is tried again. The port is still held, and the start did not wait for it.
	if c, err := net.DialTimeout("tcp4", holder.Addr().String(), time.Second); err != nil {
		t.Fatalf("the holder of port %d is gone: %v", in.port, err)
	} else {
		c.Close()
	}
	if took >= 3*time.Second {
		t.Fatalf("serve ended after %s with the port still held, want under 3 s: it waited for the port", took)
	}
	if n := strings.Count(stderr, "\n"); n != 3 {
		t.Fatalf("serve said %d lines, want the message's three:\n%s", n, stderr)
	}
	for _, want := range []string{
		fmt.Sprintf("Remote access: the remote port %d cannot be bound: ", in.port),
		"address already in use",
		"\nThe start creates nothing.\n",
		fmt.Sprintf("\nTo repair: free port %d, or %q remote setup -port N -home %q\n", in.port, in.exe(t), in.dir),
	} {
		if !strings.Contains(stderr, want) {
			t.Fatalf("serve's message lacks %q:\n%s", want, stderr)
		}
	}
	in.noServerFiles(t)
	if listening(in.mcpPort) {
		t.Fatalf("something accepts on the MCP port %d", in.mcpPort)
	}
	sameFolder(t, in.dir, before)
}

// The check comes before any bind. With the MCP port held by another program, a start with a
// fatal row of the check ends with the check's message and never gets as far as the MCP port's
// own message.
func TestStartCheckComesBeforeTheBinds(t *testing.T) {
	serverTest(t, "TestNotSetUpRefusesThenStarts (this package)")
	in := newInstance(t)
	mcp, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", in.mcpPort))
	if err != nil {
		t.Fatal(err)
	}
	defer mcp.Close()
	f := remote.FilesIn(in.dir)
	if err := os.Remove(f.Key); err != nil {
		t.Fatal(err)
	}
	before := folder(t, in.dir)
	message := remote.Check(in.dir, in.mcpPort).Message(in.exe(t), in.dir)

	stdout, stderr, code := in.ends(t, "serve")
	if code != 1 || stdout != "" {
		t.Fatalf("serve: exit code %d, stdout %q, want 1 and nothing\n%s", code, stdout, stderr)
	}
	// The message is all the start says, after the log's date and time.
	said, isLog := strings.CutSuffix(stderr, message+"\n")
	if _, err := time.Parse("2006/01/02 15:04:05 ", said); !isLog || err != nil || !strings.HasPrefix(message, "Remote access: the key "+f.Key+" is missing\n") {
		t.Fatalf("serve said:\n%s\nwant the check's message alone:\n%s", stderr, message)
	}
	if strings.Contains(stderr, "cannot serve the MCP endpoint") {
		t.Fatalf("serve got as far as a bind:\n%s", stderr)
	}
	in.noServer(t)
	sameFolder(t, in.dir, before)
}

// launch says what the check found, whole, and starts no server.
func TestLaunchShowsTheCheckMessage(t *testing.T) {
	serverTest(t, "TestMessageWorstCase (internal/remote)", "TestLaunchOfAFolderNeverSetUp (this package)")
	in := newInstance(t)
	f := remote.FilesIn(in.dir)
	for _, path := range []string{f.Secret, f.Key} {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	before := remoteFiles(t, in.dir)
	message := remote.Check(in.dir, in.mcpPort).Message(in.exe(t), in.dir)
	if n := strings.Count(message, "\n") + 1; n != 4 {
		t.Fatalf("the message has %d lines, want the four of the worst case:\n%s", n, message)
	}

	stdout, stderr, code := in.ends(t, "launch")
	if code != 1 || stdout != "" {
		t.Fatalf("launch: exit code %d, stdout %q, want 1 and nothing\n%s", code, stdout, stderr)
	}
	if !strings.HasPrefix(stderr, "AI Whiteboard: the server was not started\n") {
		t.Fatalf("launch said:\n%s", stderr)
	}
	messageLines(t, stderr, message)
	in.noServer(t)
	sameRemoteFiles(t, in.dir, before)
}

// relaunch runs the check before it stops anything: with a set-up that would end the new start,
// the running server stays.
func TestRelaunchRefusesBrokenSetup(t *testing.T) {
	serverTest(t, "TestCheckFatalRows (internal/remote)", "TestRelaunchRefusesBeforeItStopsAnything (this package)")
	in := newInstance(t)
	in.launchJSON(t, "launch")
	in.waitServing(t)
	pid := in.hello(t).Pid

	refused := func(what string) {
		t.Helper()
		message := remote.Check(in.dir, in.mcpPort).Message(in.exe(t), in.dir)
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
		in.helloOK(t, in.secret)
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
	// Put right, relaunch replaces the server.
	if l := in.launchJSON(t, "relaunch"); l.PID == pid {
		t.Fatalf("relaunch still reports the old pid %d", pid)
	}
	in.waitServing(t)
	in.helloOK(t, in.secret)
}

// A restart keeps the secret and the certificate: a client set up once goes on working.
func TestSecretSurvivesRestart(t *testing.T) {
	serverTest(t, "TestSetupMakesWhatIsMissing (internal/remote)", "TestRemoteSecretAndHost (internal/server)", "TestClientListenerServes (this package)")
	in := newInstance(t)
	in.launchJSON(t, "launch")
	old := in.hello(t).Pid
	in.page(t, testClient).Welcome()

	in.run(t, "relaunch")
	if pid := in.hello(t).Pid; pid == old {
		t.Fatalf("hello still reports the old pid %d", old)
	}
	if st, _ := in.waitServing(t).statusOf(); st.Client.Fingerprint != in.fpr {
		t.Fatalf("after a restart the fingerprint is %s, want %s", st.Client.Fingerprint, in.fpr)
	}
	in.page(t, testClient).Welcome()
	if got := secretOf(t, in.dir); got != in.secret {
		t.Fatal("the restart changed the secret")
	}
}

// `secret -new` writes the new secret and tells the running server, which accepts the new one
// alone from then on and ends the streams of its clients. A restart keeps the new secret.
func TestSecretNewReachesAClient(t *testing.T) {
	smokeTest(t)
	in := newInstance(t)
	old := in.secret
	in.launchJSON(t, "launch")
	in.waitServing(t)
	pid := in.hello(t).Pid
	c := in.page(t, testClient)
	c.Welcome()

	out, errOut, code := in.ends(t, "secret", "-new")
	fresh := strings.TrimSpace(out)
	if code != 0 || fresh == old || fresh != secretOf(t, in.dir) || out != fresh+"\n" {
		t.Fatalf("secret -new: code %d, stdout %q, stderr %q", code, out, errOut)
	}
	if errOut != "The running server accepts the new secret only, from now on. Its clients were disconnected and need the new secret.\n" {
		t.Fatalf("stderr %q", errOut)
	}
	// The command returned after the server confirmed: no wait is needed here.
	if status, _ := in.getWith(t, "/api/state", old, "", testLevel); status != http.StatusUnauthorized {
		t.Fatalf("the old secret after secret -new: status %d, want 401", status)
	}
	c.ExpectEnded()
	in.secret = fresh
	in.helloOK(t, fresh)
	in.page(t, testClient).Welcome()
	if st, _ := in.waitServing(t).statusOf(); st.Client.SecretReloads != 1 {
		t.Fatalf("secretReloads = %d, want 1", st.Client.SecretReloads)
	}
	if got := in.hello(t).Pid; got != pid {
		t.Fatalf("the server's pid is %d, was %d: the signal ended it", got, pid)
	}
	if log := serverLog(t, in.dir); !strings.Contains(log, "Remote listener: the secret was read again; 1 client streams closed\n") {
		t.Fatalf("the log lacks the reload's line:\n%s", log)
	}
	noSecret(t, old, serverLog(t, in.dir), errOut)
	noSecret(t, fresh, serverLog(t, in.dir), errOut)

	in.run(t, "relaunch")
	if st, _ := in.waitServing(t).statusOf(); st.Client.SecretReloads != 0 {
		t.Fatalf("secretReloads after a restart = %d, want 0", st.Client.SecretReloads)
	}
	in.page(t, testClient).Welcome()
	if status, _ := in.getWith(t, "/api/state", old, "", testLevel); status != http.StatusUnauthorized {
		t.Fatalf("the old secret after the restart: status %d, want 401", status)
	}
}

// Setting remote access up again while a client is connected changes nothing for it: the running
// server serves what it was started with. `status` says what it serves and what the next start
// will do, and the next start does it.
func TestSetupWithAClientConnected(t *testing.T) {
	serverTest(t, "TestStatusOfARunningServer, TestStatusJSON (this package: against a stand-in)")
	in := newInstance(t)
	in.launchJSON(t, "launch")
	in.waitServing(t)
	c := in.page(t, testClient)
	c.Welcome()
	pid := in.hello(t).Pid
	oldPort := in.port

	next := freePort(t)
	out, errOut, code := in.ends(t, "remote", "setup", "-port", strconv.Itoa(next), "-name", "extra.example")
	if code != 0 || !strings.Contains(out, fmt.Sprintf("Port: %d\n", next)) || !strings.Contains(out, "Next start: will listen\n") {
		t.Fatalf("remote setup: code %d, stdout %q, stderr %q", code, out, errOut)
	}
	// The connected client is still served, on the old port, with the same certificate.
	if status, _, err := in.request(context.Background(), testClient, "GET", "/api/state", nil); err != nil || status != http.StatusOK {
		t.Fatalf("the client after the set-up: %d, %v", status, err)
	}
	c.ExpectNone(300 * time.Millisecond)
	if listening(next) {
		t.Fatalf("the running server listens on the new port %d", next)
	}

	var status struct {
		Running struct {
			PID    int
			Client struct {
				Port  int
				Names []string
			}
		}
		Files struct {
			Port  int
			Names []string
		}
	}
	jsonOut, errOut, code := in.ends(t, "status", "-json")
	if code != 0 || json.Unmarshal([]byte(jsonOut), &status) != nil {
		t.Fatalf("status -json: code %d, stdout %q, stderr %q", code, jsonOut, errOut)
	}
	if status.Running.PID != pid || status.Running.Client.Port != oldPort || slices.Contains(status.Running.Client.Names, "extra.example") ||
		status.Files.Port != next || !slices.Contains(status.Files.Names, "extra.example") {
		t.Fatalf("status: %+v", status)
	}
	text := in.run(t, "status")
	if !strings.Contains(text, fmt.Sprintf("Port: %d\n", oldPort)) || !strings.Contains(text, fmt.Sprintf("Files: the next start will listen\nPort: %d\n", next)) {
		t.Fatalf("status:\n%s", text)
	}

	// The next start does what the files say.
	in.port = next
	in.secret, in.fpr = secretOf(t, in.dir), fingerprintOf(t, in.dir)
	if l := in.launchJSON(t, "relaunch"); l.Address != in.base() || l.Fingerprint != in.fpr {
		t.Fatalf("relaunch -json: %+v, want the address %s", l, in.base())
	}
	in.waitServing(t)
	in.helloOK(t, in.secret)
}

// A start deletes the server list of an earlier version from the data folder, with the copies set
// aside as unreadable, and holds none from then on; nothing else of the folder is touched.
func TestStartDeletesTheOldServerList(t *testing.T) {
	serverTest(t, "TestRemoveServerList (internal/store)", "TestServeOnADataFolderWithRunData (this package)")
	in := newInstance(t)
	list := filepath.Join(in.dir, "servers.json")
	aside := filepath.Join(in.dir, "servers.json.unreadable-20260101T000000Z")
	for _, p := range []string{list, aside} {
		if err := os.WriteFile(p, []byte(`{"version":1,"servers":[{"id":"s_0123456789ab","secret":"`+strings.Repeat("a", 64)+`"}]}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	other := filepath.Join(in.dir, "servers-notes.txt")
	if err := os.WriteFile(other, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	in.launchJSON(t, "launch")
	for _, p := range []string{list, aside} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s after the start: %v, want it gone", p, err)
		}
	}
	if b, err := os.ReadFile(other); err != nil || string(b) != "mine" {
		t.Errorf("a file that is no server list: %q, %v", b, err)
	}
	if log := serverLog(t, in.dir); !strings.Contains(log, "the server list of an earlier version is removed from "+in.dir) {
		t.Errorf("the log lacks the line for the removal:\n%s", log)
	}
	// It is held no more: a client asks the routes of the list and finds none, and the folder has
	// none a moment later either.
	for _, path := range []string{"/api/servers", "/api/state"} {
		_, raw := in.call(t, testClient, "GET", path, nil, nil)
		if strings.Contains(raw, "servers.json") || strings.Contains(raw, "s_0123456789ab") {
			t.Errorf("GET %s holds the list: %s", path, raw)
		}
	}
	if _, err := os.Stat(list); !os.IsNotExist(err) {
		t.Errorf("servers.json after the requests: %v", err)
	}
}

// A start, a restart and a stop leave the files of remote access as set-up wrote them; the start
// adds the instance id alone.
func TestStartChangesNoFile(t *testing.T) {
	serverTest(t, "TestInstanceID, TestCheckNotes (internal/remote)", "TestClientListenerServes (this package)")
	in := newInstance(t)
	before := remoteFiles(t, in.dir)
	if before["instance-id"] != "" {
		t.Fatal("set-up made an instance id")
	}

	in.launchJSON(t, "launch")
	before["instance-id"] = remoteFiles(t, in.dir)["instance-id"]
	if before["instance-id"] == "" {
		t.Fatal("the start made no instance id")
	}
	sameRemoteFiles(t, in.dir, before)

	in.run(t, "relaunch")
	in.waitServing(t)
	sameRemoteFiles(t, in.dir, before)

	if out := in.run(t, "stop"); !strings.Contains(out, "AI Whiteboard stopped") {
		t.Fatalf("stop printed %q", out)
	}
	sameRemoteFiles(t, in.dir, before)
	in.noServer(t)
}

// A server that was set up before this build, with names that do not include 127.0.0.1, is
// reached at https://127.0.0.1:<port> with its fingerprint and its secret, and keeps its files.
func TestAServerSetUpBeforeIsReachedOnLoopback(t *testing.T) {
	serverTest(t, "TestClientListenerServes (this package: the names of the test include 127.0.0.1); TestClientHostRule (internal/server)")
	in := newBareInstance(t)
	// Set up with a name that is not 127.0.0.1: what an earlier set-up on a laptop wrote, and the
	// names the machine has are not in it.
	if _, err := remote.Setup(in.dir, remote.SetupOptions{Port: in.port, Names: []string{"laptop.example"}}); err != nil {
		t.Fatal(err)
	}
	in.secret, in.fpr = secretOf(t, in.dir), fingerprintOf(t, in.dir)
	before := remoteFiles(t, in.dir)

	l := in.launchJSON(t, "launch")
	if l.Address != in.base() || l.Fingerprint != in.fpr {
		t.Fatalf("launch -json: %+v", l)
	}
	in.helloOK(t, in.secret)
	if status, _ := in.getWith(t, "/api/state", in.secret, "", testLevel); status != http.StatusOK {
		t.Fatalf("the state at 127.0.0.1: status %d", status)
	}
	before["instance-id"] = remoteFiles(t, in.dir)["instance-id"]
	sameRemoteFiles(t, in.dir, before)
}

// The owner's own pair, here an RSA one in the two files, is loaded and served as it is; that its
// names are not the list's is a note in the log.
func TestOwnersPairIsServed(t *testing.T) {
	serverTest(t, "TestCheckOwnersPair (internal/remote)")
	in := newInstance(t)
	made := in.fpr

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
	in.fpr = fp

	l := in.launchJSON(t, "launch")
	if l.Fingerprint != fp {
		t.Fatalf("launch states the fingerprint %s, want the owner's %s", l.Fingerprint, fp)
	}
	in.helloOK(t, in.secret)
	log := serverLog(t, in.dir)
	if !strings.Contains(log, "certificate SHA-256 "+fp) || !strings.Contains(log, "Remote listener: note: the certificate's names (127.0.0.1) differ from the list") {
		t.Fatalf("the log lacks the owner's fingerprint or the note on its names:\n%s", log)
	}
	before["instance-id"] = remoteFiles(t, in.dir)["instance-id"]
	sameRemoteFiles(t, in.dir, before)
}

// internal/remote and internal/server each spell the header names: they must agree.
func TestHeaderNamesAgree(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
