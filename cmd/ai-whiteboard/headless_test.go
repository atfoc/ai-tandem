package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/headless"
	"ai-whiteboard/internal/model"
)

// ---- the default set: flags, the test waits, the status ----

// The flags of the headless writer are the server's and launch's: launch passes them on to the
// server it starts as it was given them, and a flag that was not given is not passed.
func TestHeadlessFlags(t *testing.T) {
	t.Parallel()
	o := parseFlags("launch", []string{"-home", "/data/x", "-headless-node", "/opt/node", "-headless-dir=/opt/headless", "-headless-quiet", "90s"})
	want := []string{"-home", "/data/x", "-headless-dir=/opt/headless", "-headless-node=/opt/node", "-headless-quiet=1m30s"}
	if !slices.Equal(o.serveArgs, want) || o.headlessNode != "/opt/node" || o.headlessDir != "/opt/headless" || o.headlessQuiet != 90*time.Second {
		t.Fatalf("serveArgs %q, node %q, dir %q, quiet %v; want %q", o.serveArgs, o.headlessNode, o.headlessDir, o.headlessQuiet, want)
	}
	// What launch passes on, serve reads back the same.
	back := parseFlags("serve", o.serveArgs)
	if back.headlessNode != o.headlessNode || back.headlessDir != o.headlessDir || back.headlessQuiet != o.headlessQuiet {
		t.Fatalf("serve read %q %q %v back", back.headlessNode, back.headlessDir, back.headlessQuiet)
	}
	// None given: the defaults are the manager's own, and nothing is passed on.
	o = parseFlags("serve", []string{"-home", "/data/x"})
	if o.headlessNode != "" || o.headlessDir != "" || o.headlessQuiet != headless.QuietDefault || !slices.Equal(o.serveArgs, []string{"-home", "/data/x"}) {
		t.Fatalf("defaults: node %q, dir %q, quiet %v, serveArgs %q", o.headlessNode, o.headlessDir, o.headlessQuiet, o.serveArgs)
	}
}

// -headless-quiet must be above 0: the program ends with 2 and says so.
func TestHeadlessQuietMustBePositive(t *testing.T) {
	t.Parallel()
	if os.Getenv("AIWB_TEST_BAD_QUIET") == "1" {
		parseFlags("serve", []string{"-home", t.TempDir(), "-headless-quiet", "0s"})
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run", "^TestHeadlessQuietMustBePositive$")
	cmd.Env = append(os.Environ(), "AIWB_TEST_BAD_QUIET=1")
	out, err := cmd.CombinedOutput()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 2 || !strings.Contains(string(out), "-headless-quiet 0s: the time must be above 0") {
		t.Fatalf("a quiet time of 0: %v\n%s", err, out)
	}
}

// AIWB_TEST_WAITS names the headless writer's waits; the manager gets them where they are set, the
// flag's quiet time where the list has none, and the bridge's hand-off gets the list's, the writer's
// four fifths of it.
func TestHeadlessTestWaits(t *testing.T) {
	t.Parallel()
	w, err := parseTestWaits("quiet=3s, hstart=4s,linger=200ms,handover=5s")
	if err != nil || w != (testWaits{quiet: 3 * time.Second, hstart: 4 * time.Second, linger: 200 * time.Millisecond, hov: 5 * time.Second}) {
		t.Fatalf("%+v, %v", w, err)
	}
	flags := options{headlessNode: "/opt/node", headlessDir: "/opt/headless", headlessQuiet: 90 * time.Second}
	got := w.headlessOptions(flags)
	if got.Node != "/opt/node" || got.Dir != "/opt/headless" || got.Quiet != 3*time.Second || got.StartLimit != 4*time.Second ||
		got.Linger != 200*time.Millisecond || got.Handover != 4*time.Second {
		t.Fatalf("with the waits: %+v", got)
	}
	// No list: the flag's quiet time, and every other wait the manager's own.
	got = (testWaits{}).headlessOptions(flags)
	if got.Quiet != 90*time.Second || got.StartLimit != 0 || got.Linger != 0 || got.Handover != 0 {
		t.Fatalf("without the waits: %+v", got)
	}
	for _, bad := range []string{"quiet=0s", "hstart=-1s", "linger=soon", "handover", "quiet"} {
		if w, err := parseTestWaits(bad); err == nil || w != (testWaits{}) {
			t.Fatalf("%q was read as %+v", bad, w)
		}
	}
	// What the clock helper writes is read as it means.
	env := strings.TrimPrefix(fast.env(t, "quiet", "linger", "handover"), "AIWB_TEST_WAITS=")
	if w, err := parseTestWaits(env); err != nil || !realWaits() &&
		w != (testWaits{quiet: headless.QuietDefault / 10, linger: 500 * time.Millisecond, hov: time.Second}) {
		t.Fatalf("the waits of the fast clock: %+v, %v", w, err)
	}
}

type fakeHeadless headless.Status

func (f fakeHeadless) Status() headless.Status { return headless.Status(f) }

// The control socket's /status gets "headless" and keeps everything else of it; every other
// request is the control handler's.
func TestWithHeadlessStatus(t *testing.T) {
	t.Parallel()
	next := http.NewServeMux()
	next.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Seen", "yes")
		w.Write([]byte(`{"client":{"listening":true},"mcp":{"chats":[]}}`))
	})
	next.HandleFunc("GET /hello", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"app":"x"}`)) })
	next.HandleFunc("GET /broken", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", http.StatusInternalServerError) })
	h := withHeadlessStatus(next, fakeHeadless{Available: true, Running: true, PID: 42, Boards: 2})

	get := func(path string) (int, string, http.Header) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		return rec.Code, rec.Body.String(), rec.Header()
	}
	code, body, header := get("/status")
	var st struct {
		Client   map[string]any
		MCP      map[string]any
		Headless headless.Status
	}
	if code != 200 || json.Unmarshal([]byte(body), &st) != nil || st.Client["listening"] != true || st.MCP["chats"] == nil ||
		st.Headless != (headless.Status{Available: true, Running: true, PID: 42, Boards: 2}) || header.Get("X-Seen") != "yes" ||
		header.Get("Content-Length") != strconv.Itoa(len(body)) {
		t.Fatalf("/status: %d %s %v", code, body, header)
	}
	if code, body, _ := get("/hello"); code != 200 || body != `{"app":"x"}` {
		t.Fatalf("/hello: %d %s", code, body)
	}
	if code, body, _ := get("/broken"); code != 500 || strings.Contains(body, "headless") {
		t.Fatalf("/broken: %d %s", code, body)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("POST", "/status", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /status: %d", rec.Code)
	}
}

// `status -json` tells what the server tells under "headless", and null for a server that tells
// nothing; `status` says it in words.
func TestStatusJSONHeadless(t *testing.T) {
	t.Parallel()
	run := func(t *testing.T, s *standIn) (string, string) {
		t.Helper()
		home := t.TempDir()
		own(t, "remote", "setup", "-home", home, "-port", "5099", "-name", "wb.example")
		asThisFolders(t, home, standInID)
		s.withPid(t).this(t, home, true)
		jsonOut, _, code := own(t, "status", "-json", "-home", home)
		if code != 0 {
			t.Fatalf("status -json: code %d: %s", code, jsonOut)
		}
		words, _, _ := own(t, "status", "-home", home)
		return jsonOut, words
	}
	headlessOf := func(t *testing.T, out string) any {
		t.Helper()
		var r struct{ Running map[string]any }
		if err := json.Unmarshal([]byte(out), &r); err != nil {
			t.Fatal(err)
		}
		h, has := r.Running["headless"]
		if !has {
			t.Fatalf("running has no headless: %s", out)
		}
		return h
	}
	for name, c := range map[string]struct {
		status headless.Status
		words  string
	}{
		"running":     {headless.Status{Available: true, Running: true, PID: 4242, Boards: 3}, "Headless writer: running (pid 4242, 3 boards)\n"},
		"available":   {headless.Status{Available: true}, "Headless writer: available, not running\n"},
		"unavailable": {headless.Status{Reason: "node is not on the PATH"}, "Headless writer: not available: node is not on the PATH\n"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			jsonOut, words := run(t, &standIn{version: "1.2.3", listening: true, port: 5123, headless: c.status})
			var want map[string]any
			wantRaw, _ := json.Marshal(c.status)
			json.Unmarshal(wantRaw, &want)
			got, _ := headlessOf(t, jsonOut).(map[string]any)
			if !reflect.DeepEqual(got, want) || len(got) != 5 || !strings.Contains(words, c.words) {
				t.Fatalf("headless %v, want %v (all five fields); status:\n%s", got, want, words)
			}
		})
	}
	t.Run("a server that tells nothing", func(t *testing.T) {
		t.Parallel()
		jsonOut, words := run(t, &standIn{version: "1.2.3", listening: true, port: 5123})
		if h := headlessOf(t, jsonOut); h != nil || strings.Contains(words, "Headless") {
			t.Fatalf("headless %v; status:\n%s", h, words)
		}
	})
}

// ---- the full set: real server processes ----

// standInProgram is the stand-in headless writer (testdata/headlessstandin), built once for the
// test binary into a folder that TestMain removes.
var standInProgram struct {
	once sync.Once
	dir  string
	path string
	err  error
}

func buildStandIn(t *testing.T) string {
	t.Helper()
	p := &standInProgram
	p.once.Do(func() {
		if p.dir, p.err = os.MkdirTemp("", "aiwb-cmd-standin-"); p.err != nil {
			return
		}
		p.path = filepath.Join(p.dir, "headlessstandin")
		if out, err := exec.Command("go", "build", "-o", p.path, "ai-whiteboard/cmd/ai-whiteboard/testdata/headlessstandin").CombinedOutput(); err != nil {
			p.err = &buildError{err, string(out)}
		}
	})
	if p.err != nil {
		t.Fatal(p.err)
	}
	return p.path
}

type buildError struct {
	err error
	out string
}

func (e *buildError) Error() string {
	return "go build of the stand-in headless writer: " + e.err.Error() + "\n" + e.out
}

// standInBundle is a bundle folder for the stand-in: headless.mjs, which the stand-in never reads,
// and a manifest.
func standInBundle(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range map[string]string{headless.BundleFile: "// the stand-in does not read this\n", headless.ManifestFile: `{"version":"dev","os":"any","arch":"any"}`} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// headlessOf is the "headless" of `status -json`.
func (in *instance) headlessOf(t *testing.T) headless.Status {
	t.Helper()
	var r struct {
		Running struct{ Headless *headless.Status }
	}
	if err := json.Unmarshal([]byte(in.run(t, "status", "-json")), &r); err != nil || r.Running.Headless == nil {
		t.Fatalf("status -json has no headless: %v", err)
	}
	return *r.Running.Headless
}

// boardChat makes a board and a chat on it, as the client testClient, which holds no stream: no
// window is connected. It returns their ids.
func (in *instance) boardChat(t *testing.T) (board, chat string) {
	t.Helper()
	var made struct{ ID string }
	in.must(t, testClient, "POST", "/api/boards", map[string]any{"name": "away", "group": model.Ungrouped}, &made)
	board = made.ID
	in.must(t, testClient, "POST", "/api/chats", map[string]any{"agent": "claude", "board": board}, &made)
	chat = made.ID
	in.must(t, testClient, "PATCH", "/api/chats/"+chat, map[string]any{"cwd": t.TempDir()}, nil)
	return board, chat
}

// say sends the text to the chat and waits up to a minute for the end of its turn; it returns the
// text of the agent's reply (the fake claude writes each tool's result in it).
func (in *instance) say(t *testing.T, chat, text string) string {
	t.Helper()
	itemsNow := func() []model.Item {
		var got struct{ Items []model.Item }
		in.must(t, testClient, "GET", "/api/chats/"+chat+"/items", nil, &got)
		return got.Items
	}
	ends := func() (n int) {
		for _, it := range itemsNow() {
			if it.Kind == "end" {
				n++
			}
		}
		return n
	}
	before := ends()
	in.must(t, testClient, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": text}, nil)
	for deadline := time.Now().Add(60 * time.Second); ; time.Sleep(100 * time.Millisecond) {
		if ends() > before {
			var reply strings.Builder
			for _, it := range itemsNow() {
				reply.WriteString(it.Text + "\n")
			}
			return reply.String()
		}
		if time.Now().After(deadline) {
			t.Fatalf("the turn did not end:\n%s", serverLog(t, in.dir))
		}
	}
}

// (a) A server that cannot run the headless writer works as before: an agent's call on a free
// board is told there is no window, a window that is connected is told of its button, nothing is
// started, and `status -json` says why.
func TestHeadlessUnavailable(t *testing.T) {
	serverTest(t, "TestHeadlessFlags, TestHeadlessTestWaits, TestWithHeadlessStatus, TestStatusJSONHeadless; internal/headless and internal/boardapi: the manager's reasons and the relay's texts")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	in := newInstance(t)
	in.claude = agenttest.FakeClaude(t)
	noNode := filepath.Join(t.TempDir(), "no-node")
	in.setenv("AIWB_TEST_WAITS=" + strings.TrimPrefix(fast.env(t, "linger"), "AIWB_TEST_WAITS="))
	if out := in.run(t, "launch", "-headless-node", noNode, "-headless-dir", t.TempDir()); !strings.Contains(out, "running") {
		t.Fatalf("launch: %s", out)
	}
	in.waitServing(t)

	if h := in.headlessOf(t); h.Available || h.Running || h.PID != 0 || h.Boards != 0 || !strings.Contains(h.Reason, "-headless-node") || !strings.Contains(h.Reason, noNode) {
		t.Fatalf("status -json headless = %+v", h)
	}
	_, chat := in.boardChat(t)

	// No window: the text of a closed window.
	reply := in.say(t, chat, "read [[mcp read_board {}]]")
	if !strings.Contains(reply, "read_board -> "+boardapi.NoClientText) || strings.Contains(reply, boardapi.NoEditorText) {
		t.Fatalf("with no window the agent was told:\n%s", reply)
	}
	// A window: the text that names its button.
	in.activate(t, "9d1e2f3a-4b5c-4d6e-8f70-a1b2c3d4e5f6")
	reply = in.say(t, chat, "read again [[mcp read_board {}]]")
	if !strings.Contains(reply, "read_board -> "+boardapi.NoEditorText) {
		t.Fatalf("with a window the agent was told:\n%s", reply)
	}
	if h := in.headlessOf(t); h.Running || h.PID != 0 {
		t.Fatalf("status -json after the calls: %+v", h)
	}
	log := serverLog(t, in.dir)
	if n := strings.Count(log, "headless writer: not started"); n != 1 {
		t.Fatalf("the log has %d lines about the start that failed, want one (the second call fails at once):\n%s", n, log)
	}
	if strings.Contains(log, "headless writer: started") {
		t.Fatalf("a process was started:\n%s", log)
	}
	noSecret(t, in.secret, log)
}

// (b) With a stand-in for the process, an agent's call on a free board is answered by it, the
// server starts it once for the calls that follow, tells it what it must, shows it in
// `status -json`, and stops it when it holds nothing; the next call starts another, and the
// server's stop ends it.
func TestHeadlessStandIn(t *testing.T) {
	serverTest(t, "TestHeadlessFlags, TestHeadlessTestWaits, TestWithHeadlessStatus; internal/headless: the manager's start, idle stop and credentials against its own stand-in")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	standIn := buildStandIn(t)
	in := newInstance(t)
	in.claude = agenttest.FakeClaude(t)
	out := t.TempDir()
	bundle := standInBundle(t)
	in.setenv("STANDIN_OUT="+out, "AIWB_TEST_WAITS="+strings.TrimPrefix(fast.env(t, "quiet", "linger"), "AIWB_TEST_WAITS="))
	if got := in.run(t, "launch", "-headless-node", standIn, "-headless-dir", bundle); !strings.Contains(got, "running") {
		t.Fatalf("launch: %s", got)
	}
	in.waitServing(t)

	if h := in.headlessOf(t); !h.Available || h.Running || h.PID != 0 {
		t.Fatalf("before any call: %+v", h)
	}
	board, chat := in.boardChat(t)

	reply := in.say(t, chat, "read [[mcp read_board {}]]")
	if !strings.Contains(reply, "read_board -> STANDIN: the headless writer's fixed answer") {
		t.Fatalf("the agent was told:\n%s\nlog:\n%s", reply, serverLog(t, in.dir))
	}
	first := in.headlessOf(t)
	if !first.Available || !first.Running || first.PID <= 0 || first.Boards != 1 {
		t.Fatalf("while it holds the board: %+v", first)
	}
	if _, err := os.Stat(filepath.Join(out, "config")); err != nil {
		t.Fatal(err)
	}
	var cfg struct {
		Address, Fingerprint, Secret, ClientID, InstanceID, Version string
		QuietMs, HandoverMs                                         int64
	}
	raw, _ := os.ReadFile(filepath.Join(out, "config"))
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatalf("config %q: %v", raw, err)
	}
	if cfg.Address != "127.0.0.1:"+strconv.Itoa(in.port) || cfg.Fingerprint != in.fpr || cfg.InstanceID != in.hello(t).InstanceID || cfg.InstanceID == "" ||
		len(cfg.ClientID) != 36 || cfg.QuietMs != fast.of(headless.QuietDefault).Milliseconds() || cfg.HandoverMs != 8000 || cfg.Secret != "" {
		t.Fatalf("what the process was told: %+v", cfg)
	}
	if rpcs := readLines(t, filepath.Join(out, "rpcs")); !slices.Equal(rpcs, []string{"tool read_board " + board}) {
		t.Fatalf("the process was asked %q", rpcs)
	}

	// The next call of the chat is answered by the same process.
	if reply := in.say(t, chat, "read again [[mcp read_board {}]]"); !strings.Contains(reply, "STANDIN") {
		t.Fatalf("the second call: %s", reply)
	}
	if again := in.headlessOf(t); again.PID != first.PID || !again.Running {
		t.Fatalf("the second call started another process: %+v then %+v", first, again)
	}

	// After the quiet time it lets the board go, and after two looks without a board it is stopped.
	for deadline := time.Now().Add(60 * time.Second); in.headlessOf(t).Running; time.Sleep(200 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("the process still runs:\n%s", serverLog(t, in.dir))
		}
	}
	waitGone(t, first.PID)
	if released := readLines(t, filepath.Join(out, "released")); !slices.Equal(released, []string{board + " free"}) {
		t.Fatalf("released %q", released)
	}
	if h := in.headlessOf(t); !h.Available || h.Running || h.PID != 0 || h.Boards != 0 {
		t.Fatalf("after the idle stop: %+v", h)
	}
	if log := serverLog(t, in.dir); !strings.Contains(log, "headless writer: it holds no board, it is stopped") {
		t.Fatalf("the log does not tell of the idle stop:\n%s", log)
	}

	// A new call starts a new process; the server's stop ends it.
	if reply := in.say(t, chat, "read once more [[mcp read_board {}]]"); !strings.Contains(reply, "STANDIN") {
		t.Fatalf("the third call: %s", reply)
	}
	third := in.headlessOf(t)
	if !third.Running || third.PID == first.PID {
		t.Fatalf("the third call: %+v (first pid %d)", third, first.PID)
	}
	if got := in.run(t, "stop"); !strings.Contains(got, "AI Whiteboard stopped") {
		t.Fatalf("stop printed %q", got)
	}
	waitGone(t, third.PID)
	log := serverLog(t, in.dir)
	noSecret(t, in.secret, log)
	if !syscallGone(first.PID) {
		t.Fatalf("the first process is back")
	}
}

func syscallGone(pid int) bool { return syscall.Kill(pid, 0) == syscall.ESRCH }

// readLines is the lines of a file, none when it is not there.
func readLines(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	} else if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}
