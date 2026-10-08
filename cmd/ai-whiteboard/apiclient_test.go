package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/store"
)

// apiOptions is how the API client id reaches a remote listener with this secret: over HTTPS
// with the certificate pinned, and the secret and its id in their headers.
func apiOptions(t *testing.T, fingerprint, secret, id string) bridgetest.Options {
	t.Helper()
	tr := pinned(fingerprint)
	t.Cleanup(tr.CloseIdleConnections)
	return bridgetest.Options{HTTP: &http.Client{Transport: tr},
		Header: map[string]string{remote.SecretHeader: secret, server.ClientHeader: id}}
}

// apiClient opens the event stream of the API client id on the remote listener of 127.0.0.1:<port>.
func apiClient(t *testing.T, port int, fingerprint, secret, id string) *bridgetest.Page {
	t.Helper()
	return bridgetest.ConnectWith(t, fmt.Sprintf("https://127.0.0.1:%d", port), id, apiOptions(t, fingerprint, secret, id))
}

// streamStatus asks the remote listener for the event stream and returns the answer's status and
// body; it is for a stream that must be refused.
func streamStatus(t *testing.T, port int, fingerprint, secret, id string) (int, string) {
	t.Helper()
	o := apiOptions(t, fingerprint, secret, id)
	req, err := http.NewRequest("GET", fmt.Sprintf("https://127.0.0.1:%d/api/events", port), nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range o.Header {
		req.Header.Set(k, v)
	}
	resp, err := o.HTTP.Do(req)
	if err != nil {
		t.Fatalf("the stream's request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return resp.StatusCode, ""
	}
	var body [512]byte
	n, _ := resp.Body.Read(body[:])
	return resp.StatusCode, string(body[:n])
}

// waitLog waits up to 5 s for the server's log to hold line.
func waitLog(t *testing.T, dir, line string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if strings.Contains(serverLog(t, dir), line) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the log lacks %q:\n%s", line, serverLog(t, dir))
		}
	}
}

// child starts a process of the test's own and returns its pid and a function that reports
// whether it still runs. It is the pid a stand-in hello states: a command that must signal
// nothing leaves it running, since SIGUSR1 ends a sleep.
func child(t *testing.T, name string, args ...string) (pid int, alive func() bool) {
	t.Helper()
	return childOf(t, exec.Command(name, args...))
}

// childOf is child for a command the test prepared, to read its output for one.
func childOf(t *testing.T, cmd *exec.Cmd) (pid int, alive func() bool) {
	t.Helper()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		cmd.Wait()
		close(done)
	}()
	t.Cleanup(func() {
		cmd.Process.Kill()
		<-done
	})
	return cmd.Process.Pid, func() bool {
		select {
		case <-done:
			return false
		case <-time.After(300 * time.Millisecond): // a signal that was sent has ended it by now
			return true
		}
	}
}

// gateServer is a stand-in for a running server as `secret -new` sees it: hello and the remote
// status route, each with the body given ("" = 404), the state read with dataDir as its data
// folder ("" = 404; set before the command runs), and a count of the requests it got.
type gateServer struct {
	*httptest.Server
	hello, status string
	dataDir       string
	asked         atomic.Int64
}

func newGateServer(t *testing.T, hello, status string) *gateServer {
	t.Helper()
	g := &gateServer{hello: hello, status: status}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.asked.Add(1)
		body := map[string]string{"/api/hello": g.hello, "/api/remote/status": g.status}[r.URL.Path]
		if r.URL.Path == "/api/state" && g.dataDir != "" {
			body = fmt.Sprintf(`{"dataDir":%q}`, g.dataDir)
		}
		if body == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, body)
	}))
	t.Cleanup(g.Close)
	return g
}

// The gate of `secret -new`: a server is signalled only when it is this data folder's, of a build
// that has the reload, and listening for remote access. In every other case the command writes
// the secret, says on stderr what holds, exits 0 and signals nothing.
func TestSecretNewGate(t *testing.T) {
	t.Parallel()
	const (
		otherID   = "7b1e9d40-2c5a-4f38-a6d7-0e1f2a3b4c5d"
		next      = "The new secret takes effect at the server's next start.\n"
		older     = "The running server is of an older build and cannot read a secret while it runs. " + next
		off       = "The running server has remote access off. " + next
		listening = `{"listening":true,"port":5123,"names":["mac.local"],"fingerprint":"AB:CD","secretReloads":4}`
	)
	hello := func(pid int, more string) string {
		return fmt.Sprintf(`{"app":"ai-whiteboard","version":"dev","pid":%d%s}`, pid, more)
	}
	this := `,"instanceId":"` + standInID + `"`
	cases := []struct {
		name          string
		hello         func(pid int) string
		status        string
		noServerFile  bool
		noInstanceID  bool
		dataDir       string // the stand-in's data folder when it is not the command's: "none" = no state read
		want          string
		wantNoRequest bool
	}{
		{name: "no server.json", hello: func(pid int) string { return hello(pid, this+`,"featureLevel":1`) }, status: listening,
			noServerFile: true, want: next, wantNoRequest: true},
		{name: "the folder has no instance id", hello: func(pid int) string { return hello(pid, this+`,"featureLevel":1`) }, status: listening,
			noInstanceID: true, want: next, wantNoRequest: true},
		{name: "another folder's server", hello: func(pid int) string { return hello(pid, `,"instanceId":"`+otherID+`","featureLevel":1`) },
			status: listening, want: next},
		{name: "a copy of the server's folder", hello: func(pid int) string { return hello(pid, this+`,"featureLevel":1`) }, status: listening,
			dataDir: filepath.Join(os.TempDir(), "aiwb-the-original"), want: next},
		{name: "no state read", hello: func(pid int) string { return hello(pid, this+`,"featureLevel":1`) }, status: listening,
			dataDir: "none", want: next},
		{name: "hello without an instance id", hello: func(pid int) string { return hello(pid, `,"featureLevel":1`) }, status: listening, want: next},
		{name: "another program", hello: func(pid int) string { return `{"app":"other","pid":1}` }, status: listening, want: next},
		{name: "no feature level", hello: func(pid int) string { return hello(pid, this) }, status: listening, want: older},
		{name: "feature level 0", hello: func(pid int) string { return hello(pid, this+`,"featureLevel":0`) }, status: listening, want: older},
		{name: "no pid", hello: func(int) string { return hello(0, this+`,"featureLevel":1`) }, status: listening, want: older},
		{name: "remote access off", hello: func(pid int) string { return hello(pid, this+`,"featureLevel":1`) }, status: `{"listening":false}`, want: off},
		{name: "no status route", hello: func(pid int) string { return hello(pid, this+`,"featureLevel":1`) }, status: "", want: off},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			pid, alive := child(t, "sleep", "600")
			g := newGateServer(t, tc.hello(pid), tc.status)
			home := t.TempDir()
			if _, _, code := own(t, "remote", "setup", "-home", home); code != 0 {
				t.Fatalf("set-up: code %d", code)
			}
			switch tc.dataDir {
			case "":
				g.dataDir = home
			case "none":
			default:
				g.dataDir = tc.dataDir
			}
			if !tc.noInstanceID {
				asThisFolders(t, home, standInID)
			}
			if !tc.noServerFile {
				writeServerFile(t, store.NewPaths(home), portOf(t, g.Server))
			}
			old := secretOf(t, home)

			out, errOut, code := own(t, "secret", "-new", "-home", home)
			fresh := secretOf(t, home)
			if code != 0 || out != fresh+"\n" || fresh == old {
				t.Fatalf("code %d, stdout %q", code, out)
			}
			if errOut != tc.want {
				t.Fatalf("stderr %q, want %q", errOut, tc.want)
			}
			if !alive() {
				t.Fatal("the process hello names was signalled")
			}
			if n := g.asked.Load(); tc.wantNoRequest && n != 0 {
				t.Fatalf("%d requests to a server the command must not ask", n)
			}
			noSecret(t, fresh, errOut)
			noSecret(t, old, errOut)
		})
	}
}

// With no server.json the command asks no port at all, the default one included: no request
// leaves it.
func TestSecretNewAsksNoDefaultPort(t *testing.T) {
	home := t.TempDir()
	if _, _, code := own(t, "remote", "setup", "-home", home); code != 0 {
		t.Fatalf("set-up: code %d", code)
	}
	asThisFolders(t, home, standInID)
	var asked atomic.Int64
	prev := http.DefaultTransport
	http.DefaultTransport = roundTrip(func(r *http.Request) (*http.Response, error) {
		asked.Add(1)
		return nil, fmt.Errorf("no request may be made, and %s was", r.URL)
	})
	defer func() { http.DefaultTransport = prev }()
	_, errOut, code := own(t, "secret", "-new", "-home", home)
	if code != 0 || errOut != "The new secret takes effect at the server's next start.\n" || asked.Load() != 0 {
		t.Fatalf("code %d, stderr %q, %d requests", code, errOut, asked.Load())
	}
}

// The gate's last two rows: a server that cannot be signalled, and one that takes the signal and
// does not confirm.
func TestSecretNewSignalNotConfirmed(t *testing.T) {
	t.Parallel()
	const listening = `{"listening":true,"port":5123,"names":["mac.local"],"fingerprint":"AB:CD","secretReloads":4}`
	gate := func(t *testing.T, pid int) (errOut string, took time.Duration) {
		t.Helper()
		g := newGateServer(t, fmt.Sprintf(`{"app":"ai-whiteboard","version":"dev","pid":%d,"instanceId":%q,"featureLevel":1}`, pid, standInID), listening)
		home := t.TempDir()
		g.dataDir = home
		if _, _, code := own(t, "remote", "setup", "-home", home); code != 0 {
			t.Fatalf("set-up: code %d", code)
		}
		asThisFolders(t, home, standInID)
		writeServerFile(t, store.NewPaths(home), portOf(t, g.Server))
		start := time.Now()
		out, errOut, code := own(t, "secret", "-new", "-home", home)
		took = time.Since(start)
		if fresh := secretOf(t, home); code != 0 || out != fresh+"\n" {
			t.Fatalf("code %d, stdout %q", code, out)
		}
		return errOut, took
	}

	t.Run("the process is gone", func(t *testing.T) {
		t.Parallel()
		// A pid that no process has or gets: the pid of one that just ended can be given to the
		// next process the machine starts, which the signal would then end.
		const gone = math.MaxInt32
		if err := syscall.Kill(gone, 0); err != syscall.ESRCH {
			t.Fatalf("signal 0 to the pid %d: %v, want %v", gone, err, syscall.ESRCH)
		}
		want := fmt.Sprintf("The running server could not be told (%v). The new secret takes effect at the server's next start.\n", syscall.ESRCH)
		if errOut, _ := gate(t, gone); errOut != want {
			t.Fatalf("stderr %q, want %q", errOut, want)
		}
	})
	t.Run("no confirmation", func(t *testing.T) {
		t.Parallel()
		// A process of this test's that ignores the signal, as a server that hangs would.
		// The shell says when it has set the trap: a signal before that would end it.
		cmd := exec.Command("sh", "-c", `trap "" USR1; echo trapped; exec sleep 600`)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		pid, alive := childOf(t, cmd)
		trapped := make(chan string, 1)
		go func() {
			line, _ := bufio.NewReader(stdout).ReadString('\n')
			trapped <- line
		}()
		select {
		case line := <-trapped:
			if line != "trapped\n" {
				t.Fatalf("the shell printed %q before it set the trap, want %q", line, "trapped\n")
			}
		case <-time.After(30 * time.Second):
			t.Fatal("the shell did not set the trap in 30 s")
		}
		errOut, d := gate(t, pid)
		if errOut != "The running server did not confirm the new secret. Restart it to be sure the old one is refused.\n" {
			t.Fatalf("stderr %q", errOut)
		}
		if d < 2500*time.Millisecond || d > 10*time.Second {
			t.Fatalf("the command waited %v for the confirmation, want about 3 s", d)
		}
		if !alive() {
			t.Fatal("the process that ignores the signal ended")
		}
	})
}

// SIGUSR1 to a server with remote access off: it keeps running and says so in its log.
func TestReloadSignalWithRemoteOff(t *testing.T) {
	serverTest(t, "TestReloadKeepsSecretWhenUnreadable (the signal to a real server), TestSecretNewGate (a server with remote access off is not signalled) (this package)", "TestReloadSecret (internal/server)")
	in := newInstance(t)
	in.run(t, "launch")
	pid := in.hello(t).Pid
	if h := in.helloMap(t); h["featureLevel"] != float64(server.FeatureLevel) {
		t.Fatalf("hello: %v, want the feature level %d", h, server.FeatureLevel)
	}
	for i := 0; i < 2; i++ {
		if err := syscall.Kill(pid, syscall.SIGUSR1); err != nil {
			t.Fatal(err)
		}
	}
	waitLog(t, in.dir, "Remote listener: asked to read the secret again, but remote access is off in this server\n")
	if got := in.hello(t).Pid; got != pid {
		t.Fatalf("the server's pid is %d, was %d", got, pid)
	}
	if st, ok := remoteStatusOf(in.url); !ok || st.Listening {
		t.Fatalf("remote status: %+v, answered %v", st, ok)
	}

	// `secret -new` on this folder, set up after the start: the running server is not signalled.
	setUpRemote(t, in.dir, freePort(t))
	_, errOut, code := own(t, "secret", "-new", "-home", in.dir)
	if code != 0 || errOut != "The running server has remote access off. The new secret takes effect at the server's next start.\n" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	if n := strings.Count(serverLog(t, in.dir), "asked to read the secret again"); n > 2 {
		t.Fatalf("the log has %d reload lines, want the test's own 2 at most", n)
	}
}

// A secret file that cannot be read at the signal: the server keeps the old secret and says so in
// its log without the file's content. No reload is counted, and only a reload closes streams.
func TestReloadKeepsSecretWhenUnreadable(t *testing.T) {
	smokeTest(t)
	in, port := newRemoteInstance(t)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	in.run(t, "launch")
	in.waitListening(t)
	pid := in.hello(t).Pid

	if err := os.WriteFile(remote.FilesIn(in.dir).Secret, []byte("not a secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(pid, syscall.SIGUSR1); err != nil {
		t.Fatal(err)
	}
	waitLog(t, in.dir, "Remote listener: the secret was not read again, the old one stays: ")
	remoteOK(t, port, fp, secret)
	if st := in.waitListening(t); st.SecretReloads != 0 {
		t.Fatalf("secretReloads = %d, want 0", st.SecretReloads)
	}
	log := serverLog(t, in.dir)
	noSecret(t, secret, log)
	if strings.Contains(log, "not a secret") {
		t.Fatalf("the log holds the file's content:\n%s", log)
	}
}

// `secret -new` for another data folder, whose server.json names this folder's server: that
// server is not signalled and keeps its secret.
func TestSecretNewOfAnotherFolderLeavesTheServer(t *testing.T) {
	serverTest(t, "TestSecretNewGate, TestRemoteStatusOfThisFolderOnly (this package)")
	in, port := newRemoteInstance(t)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	in.run(t, "launch")
	in.waitListening(t)

	other := t.TempDir()
	setUpRemote(t, other, freePort(t))
	asThisFolders(t, other, standInID)
	writeServerFile(t, store.NewPaths(other), in.port)
	_, errOut, code := own(t, "secret", "-new", "-home", other)
	if code != 0 || errOut != "The new secret takes effect at the server's next start.\n" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	remoteOK(t, port, fp, secret)
	if st := in.waitListening(t); st.SecretReloads != 0 {
		t.Fatalf("secretReloads = %d, want 0", st.SecretReloads)
	}
	if log := serverLog(t, in.dir); strings.Contains(log, "secret was read again") || strings.Contains(log, "asked to read the secret") {
		t.Fatalf("the server was signalled:\n%s", log)
	}
	// The status of that folder does not report this server either.
	out, _, _ := own(t, "remote", "status", "-home", other)
	if !strings.HasPrefix(out, "Running: no server\n") {
		t.Fatalf("remote status of the other folder:\n%s", out)
	}
	out, _, _ = own(t, "remote", "status", "-home", in.dir)
	if !strings.HasPrefix(out, "Running: listening\n") {
		t.Fatalf("remote status of the server's folder:\n%s", out)
	}
}

// `secret -new` and `remote status` for a copy of the running server's data folder, which carries
// its instance id and its server.json: the server is the original's, not the copy's. It is not
// signalled and keeps its secret, and the status of the copy reports no server.
func TestSecretNewOfACopiedFolderLeavesTheServer(t *testing.T) {
	serverTest(t, "TestSecretNewGate, TestRemoteStatusOfThisFolderOnly (this package)")
	in, port := newRemoteInstance(t)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	in.run(t, "launch")
	in.waitListening(t)

	dup := filepath.Join(t.TempDir(), "copy")
	if b, err := exec.Command("cp", "-Rp", in.dir, dup).CombinedOutput(); err != nil {
		t.Fatalf("cp -Rp: %v\n%s", err, b)
	}
	// What makes the copy look like the server's folder is there.
	if _, p, ok := store.ReadServerFile(store.NewPaths(dup)); !ok || p != in.port {
		t.Fatalf("the copy's server.json: port %d, read %v, want %d", p, ok, in.port)
	}
	if a, b := remoteFiles(t, dup)["instance-id"], remoteFiles(t, in.dir)["instance-id"]; a == "" || a != b {
		t.Fatalf("the copy's instance id %q, the original's %q", a, b)
	}

	out, errOut, code := own(t, "secret", "-new", "-home", dup)
	if code != 0 || errOut != "The new secret takes effect at the server's next start.\n" {
		t.Fatalf("code %d, stderr %q", code, errOut)
	}
	if fresh := secretOf(t, dup); out != fresh+"\n" || fresh == secret || secretOf(t, in.dir) != secret {
		t.Fatalf("the copy's secret was not replaced alone: stdout %q", out)
	}
	remoteOK(t, port, fp, secret)
	if st := in.waitListening(t); st.SecretReloads != 0 {
		t.Fatalf("secretReloads = %d, want 0", st.SecretReloads)
	}
	if log := serverLog(t, in.dir); strings.Contains(log, "secret was read again") || strings.Contains(log, "asked to read the secret") {
		t.Fatalf("the server was signalled:\n%s", log)
	}
	for _, args := range [][]string{{"-home", dup}, {"-home", dup, "-server-port", strconv.Itoa(in.port)}} {
		out, _, _ = own(t, append([]string{"remote", "status"}, args...)...)
		if !strings.HasPrefix(out, "Running: no server\n") {
			t.Fatalf("remote status %v of the copy:\n%s", args, out)
		}
	}
	out, _, _ = own(t, "remote", "status", "-home", in.dir)
	if !strings.HasPrefix(out, "Running: listening\n") {
		t.Fatalf("remote status of the server's folder:\n%s", out)
	}
}

// itemsOf reads the chat's items as the client c, which follows the chat from then on.
func itemsOf(t *testing.T, c *bridgetest.Page, chat string) []model.Item {
	t.Helper()
	status, out := c.Do("GET", "/api/chats/"+chat+"/items", nil)
	if status != http.StatusOK {
		t.Fatalf("the items of %s: %d %s", chat, status, out)
	}
	var got struct{ Items []model.Item }
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	return got.Items
}

// awaitItems reads the chat's items every 100 ms, for up to 30 s, until ok says they are what
// the test waits for.
func awaitItems(t *testing.T, c *bridgetest.Page, chat, what string, ok func([]model.Item) bool) []model.Item {
	t.Helper()
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		items := itemsOf(t, c, chat)
		if ok(items) {
			return items
		}
		if time.Now().After(deadline) {
			raw, _ := json.Marshal(items)
			t.Fatalf("the chat's items never showed %s: %s", what, raw)
		}
	}
}

func ok200(t *testing.T, c *bridgetest.Page, method, path string, body any) map[string]any {
	t.Helper()
	status, out := c.Do(method, path, body)
	if status != http.StatusOK {
		t.Fatalf("%s %s by %s: %d %s", method, path, c.ID, status, out)
	}
	var got map[string]any
	json.Unmarshal(out, &got)
	return got
}

func typesOf(evs []string) (types []string) {
	for _, raw := range evs {
		var e struct{ Type string }
		json.Unmarshal([]byte(raw), &e)
		types = append(types, e.Type)
	}
	return types
}

// Across processes: a real server with the stand-in agent, a stand-in page on loopback that holds
// a board, and an API client over HTTPS that creates a chat, reads it, answers a permission ask,
// sends a second message and stops it. The page keeps its board and saves it meanwhile.
func TestAPIClientBesideAPage(t *testing.T) {
	serverTest(t, "TestAPIClientsTakeNothingFromAPage, TestTableRoutesServeAnAPIClient, TestEventsOfAnAPIClient (internal/server)")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	in, port := newRemoteInstance(t)
	in.claude = agenttest.FakeClaude(t)
	secret, fp := secretOf(t, in.dir), fingerprintOf(t, in.dir)
	in.run(t, "launch")
	in.waitListening(t)

	// The page makes a board, which it then holds, and saves it once.
	p := bridgetest.Connect(t, strings.TrimSuffix(in.url, "/"), "2a6d4c1e-8f3b-4d7a-b5c9-1e0f2d3c4b5a")
	p.Welcome()
	board, _ := ok200(t, p, "POST", "/api/boards", map[string]any{"name": "b", "group": model.Ungrouped})["id"].(string)
	if board == "" {
		t.Fatal("the new board has no id")
	}
	took := ok200(t, p, "POST", "/api/boards/"+board+"/take", map[string]any{"ifFree": false})
	if took["state"] != "held" {
		t.Fatalf("the page's take: %v", took)
	}
	rev := int64(took["rev"].(float64))
	save := func(element string) {
		t.Helper()
		scene := `{"type":"excalidraw","version":2,"elements":[{"id":"` + element + `","type":"rectangle"}],"appState":{},"files":{}}`
		got := ok200(t, p, "PUT", fmt.Sprintf("/api/boards/%s/scene?rev=%d", board, rev), scene)
		if got["ok"] != true || got["rev"] != float64(rev+1) {
			t.Fatalf("the page's save on revision %d: %v", rev, got)
		}
		rev++
	}
	save("one")
	p.Drain(300 * time.Millisecond)

	// The API client connects: its snapshot is its own, and the page is sent nothing.
	c := apiClient(t, port, fp, secret, testClient)
	snap := c.Welcome()
	if _, has := snap["groups"]; has || len(snap["chats"].([]any)) != 0 {
		t.Fatalf("the API client's snapshot: %v", snap)
	}
	// (A catalog that finishes loading just now goes to every client, whoever connects.)
	for _, typ := range typesOf(p.Drain(300 * time.Millisecond)) {
		if typ != "catalog" && typ != "agents" {
			t.Fatalf("at the API client's connect the page was sent %s", typ)
		}
	}

	// The creation call, with a permission ask in the first message.
	const chat = "c3e1f5a7-9b2d-4e6f-8a1c-3d5e7f9a1b2c"
	cwd := t.TempDir()
	made := ok200(t, c, "POST", "/api/chats", map[string]any{"id": chat, "agent": "claude", "cwd": cwd,
		"text": `first [[ask Bash {"command":"ls"}]]`})
	if made["started"] != true || made["sent"] != true || made["ok"] != true {
		t.Fatalf("the creation call: %v", made)
	}
	items := awaitItems(t, c, chat, "the permission ask", func(items []model.Item) bool {
		return len(items) > 0 && items[len(items)-1].Kind == "perm"
	})
	ask := items[len(items)-1]
	if ask.ToolName != "Bash" || ask.RequestID == "" || ask.Decided != "" || items[0].Kind != "user" {
		raw, _ := json.Marshal(items)
		t.Fatalf("the items at the ask: %s", raw)
	}
	save("two") // while the agent waits for the API client's answer
	ok200(t, c, "POST", "/api/chats/"+chat+"/permission", map[string]any{"requestId": ask.RequestID, "allow": true})
	ended := func(turns int, text string) func([]model.Item) bool {
		return func(items []model.Item) bool {
			n, has := 0, false
			for _, it := range items {
				if it.Kind == "end" {
					n++
				}
				has = has || strings.Contains(it.Text, text)
			}
			return n >= turns && has
		}
	}
	awaitItems(t, c, chat, "the reply after the answer", ended(1, "ask Bash -> allow"))

	// A second message, stopped while the agent sleeps.
	ok200(t, c, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "second [[sleep 30]]"})
	save("three")
	sent := time.Now()
	ok200(t, c, "POST", "/api/chats/"+chat+"/interrupt", nil)
	items = awaitItems(t, c, chat, "the end of the stopped turn", ended(2, "second"))
	if d := time.Since(sent); d > 20*time.Second {
		t.Fatalf("the stopped turn ended after %v: the stop did not reach the agent", d)
	}
	for _, it := range items {
		if strings.Contains(it.Text, "FAKE(") && strings.Contains(it.Text, "second") {
			t.Fatalf("the stopped turn was answered: %q", it.Text)
		}
	}
	save("four")

	// The page: its board is its own still, and it was told of the chat in the group "Remote".
	held := ok200(t, p, "POST", "/api/boards/"+board+"/take", map[string]any{"ifFree": true})
	if held["state"] != "held" || held["rev"] != float64(rev) {
		t.Fatalf("the page's hold after the API client's work: %v, want held at revision %d", held, rev)
	}
	if b, err := os.ReadFile(store.NewPaths(in.dir).BoardFile(board)); err != nil || !strings.Contains(string(b), `"four"`) {
		t.Fatalf("the board on disk: %s (%v)", b, err)
	}
	ps := typesOf(p.Drain(500 * time.Millisecond))
	count := func(types []string, typ string) (n int) {
		for _, got := range types {
			if got == typ {
				n++
			}
		}
		return n
	}
	for _, typ := range []string{"release_request", "superseded", "server_stopping"} {
		if count(ps, typ) != 0 {
			t.Errorf("the page was sent %s: %v", typ, ps)
		}
	}
	if count(ps, "groups") == 0 || count(ps, "chat") == 0 || count(ps, "chat_items") != 0 {
		t.Errorf("the page, which lists the chat and does not follow it, was sent %v", ps)
	}
	// The API client: the chat's list and content events, and nothing outside its allow-list.
	cs := typesOf(c.Drain(500 * time.Millisecond))
	if count(cs, "chat") == 0 || count(cs, "chat_items") == 0 || count(cs, "branch_state") == 0 {
		t.Errorf("the API client was sent %v", cs)
	}
	for _, typ := range cs {
		switch typ {
		case "chat", "chat_items", "branch_state", "tree", "sub", "sub_items", "catalog", "agents":
		default:
			t.Errorf("the API client was sent %s", typ)
		}
	}

	// Its state lists the chat; the server's log holds no secret.
	state := ok200(t, c, "GET", "/api/state", nil)
	if chats, _ := state["chats"].([]any); len(chats) != 1 {
		t.Fatalf("the API client's state: %v", state)
	}
	noSecret(t, secret, serverLog(t, in.dir))
}
