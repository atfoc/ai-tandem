package cursor

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// The test binary doubles as a fake `agent acp` (the helper-process pattern): with
// FAKE_ACP_SCRIPT set, TestMain plays that script instead of running the tests. The variables
// named here come from the file a test wrote for its fake (fakeEnvFile), not from the test
// process's environment.
//
// A script maps a method to the steps run when a request or notification with that method
// arrives. A request with no script entry is answered by the stateful fake Cursor (fakeCursor)
// when it knows the method, else with the result {}. Every received line is appended to
// FAKE_ACP_RECORD; "EOF" is appended when stdin closes, and the fake then exits.
type fakeStep struct {
	Send    json.RawMessage `json:"send,omitempty"`    // write this message as is
	Update  json.RawMessage `json:"update,omitempty"`  // write a session/update notification with this update
	Result  json.RawMessage `json:"result,omitempty"`  // answer the current request with this result
	Error   json.RawMessage `json:"error,omitempty"`   // answer the current request with this error
	Request json.RawMessage `json:"request,omitempty"` // {method, params}: send a request, wait for its answer
	Wait    string          `json:"wait,omitempty"`    // wait until a message with this method arrives
	Sleep   int             `json:"sleep,omitempty"`   // milliseconds
	Until   string          `json:"until,omitempty"`   // wait until this file exists (the test's cue, see cue)
	Hang    bool            `json:"hang,omitempty"`    // never answer; wait for stdin to close
	Cursor  bool            `json:"cursor,omitempty"`  // answer the current request as fakeCursor does
}

type fakeScript map[string][]fakeStep

// More of the fake, each switched on by a variable:
//
//	FAKE_ACP_ARGS      file the fake writes its arguments to, one per line
//	FAKE_ACP_CHILDREN  file: the fake starts one child in its own process group and one that
//	                   leads a group of its own (each sleeps for fakeStays and holds none of the fake's
//	                   pipes) and writes "<pid> <pid>" there
//	FAKE_ACP_STAY      set: the fake keeps running after stdin closes, as `agent acp` does
//	FAKE_ACP_SLEEP     set: the test binary only sleeps, for fakeStays (a child of FAKE_ACP_CHILDREN)
//	FAKE_ACP_HOLD      set: the child of FAKE_ACP_CHILDREN that leads its own group holds the
//	                   fake's stdout and stderr open
//	FAKE_ACP_LATE      file: once stdin has closed, the fake starts one more child that leads a
//	                   group of its own (it holds none of the fake's pipes) and writes its pid there
//	FAKE_ACP_TRAP      file: the fake and its children do not end on SIGTERM; the fake appends
//	                   "TERM" to the file when it gets one
func TestMain(m *testing.M) {
	loadFakeEnv()
	if f := os.Getenv("FAKE_COST_ARGS"); f != "" {
		runFakeCost(f)
	}
	if f := os.Getenv("FAKE_SQLITE_RECORD"); f != "" {
		runFakeSQLite(f)
	}
	if os.Getenv("FAKE_ACP_SLEEP") != "" {
		if os.Getenv("FAKE_ACP_TRAP") != "" {
			signal.Ignore(syscall.SIGTERM)
		}
		time.Sleep(fakeStays)
		os.Exit(0)
	}
	if path := os.Getenv("FAKE_ACP_SCRIPT"); path != "" {
		if f := os.Getenv("FAKE_ACP_ARGS"); f != "" {
			os.WriteFile(f, []byte(strings.Join(os.Args[1:], "\n")), 0o644)
		}
		if f := os.Getenv("FAKE_ACP_TRAP"); f != "" {
			trapTerm(f)
		}
		if f := os.Getenv("FAKE_ACP_CHILDREN"); f != "" {
			startFakeChildren(f)
		}
		runFakeACP(path, os.Getenv("FAKE_ACP_RECORD"), os.Getenv("FAKE_ACP_STATE"))
		if f := os.Getenv("FAKE_ACP_LATE"); f != "" {
			pid := startFakeChild(true, false)
			os.WriteFile(f, []byte(strconv.Itoa(pid)), 0o644)
		}
		if os.Getenv("FAKE_ACP_STAY") != "" {
			time.Sleep(fakeStays)
		}
		os.Exit(0)
	}
	// For every test, as the fakes inherit it and tests that run in parallel cannot set it: no
	// CURSOR_CONFIG_DIR from outside, and a -race fake does not wait 1 s before exiting.
	outsideConfigDir = os.Getenv("CURSOR_CONFIG_DIR")
	os.Setenv("CURSOR_CONFIG_DIR", "")
	fakesExitAtOnce()
	// No test waits for this bound; on a loaded machine a sqlite3 start alone can take longer
	// than the 2 s it is outside the tests.
	sqliteTimeout = 20 * time.Second
	os.Exit(m.Run())
}

// mustHappen is how long a test waits for something that must happen: an event, a process that
// has to start or to be gone. On a machine that is busy starting processes 10 s was too short for
// that; a wait ends as soon as the thing happened, so only a failure takes this long.
//
// fakeStays is after how long a fake that stays (FAKE_ACP_STAY) and a sleeping child of a fake
// (FAKE_ACP_SLEEP) exit on their own, so that none outlives a test binary that died before its
// cleanup. It has to stay longer than mustHappen: what nobody ended must still be running when a
// wait for it to be gone gives up, or the checks that Close ends a process pass by themselves.
// Derived from the wait, so that the two cannot drift apart.
const (
	mustHappen = 60 * time.Second
	fakeStays  = 3 * mustHappen
)

// outsideConfigDir is the CURSOR_CONFIG_DIR the test process was started with, which TestMain
// clears: the real-Cursor e2e finds the user's login there.
var outsideConfigDir string

// fakesExitAtOnce sets GORACE for the processes the tests start, the fakes: a fake built with -race
// would otherwise sleep 1 s before every exit (the race detector's atexit_sleep_ms). What GORACE
// already holds is kept. The test binary itself read its GORACE when it started, so its own race
// reporting is as it was.
func fakesExitAtOnce() {
	if old := os.Getenv("GORACE"); !strings.Contains(old, "atexit_sleep_ms") {
		os.Setenv("GORACE", strings.TrimSpace(old+" atexit_sleep_ms=0"))
	}
}

// trapTerm makes the fake outlive SIGTERM and note each one it gets in file.
func trapTerm(file string) {
	got := make(chan os.Signal, 4)
	signal.Notify(got, syscall.SIGTERM)
	go func() {
		for range got {
			if f, err := os.OpenFile(file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
				f.WriteString("TERM\n")
				f.Close()
			}
		}
	}()
}

// startFakeChild starts a copy of the test binary that only sleeps, in the fake's process group
// or as the leader of its own, and returns its pid. With hold it has the fake's stdout and stderr.
func startFakeChild(ownGroup, hold bool) int {
	child := exec.Command(os.Args[0])
	child.Env = append(os.Environ(), "FAKE_ACP_SLEEP=1")
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: ownGroup}
	if hold {
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
	}
	if err := child.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "fake: ", err)
		os.Exit(2)
	}
	return child.Process.Pid
}

func startFakeChildren(file string) {
	var pids []string
	for _, ownGroup := range []bool{false, true} {
		pid := startFakeChild(ownGroup, ownGroup && os.Getenv("FAKE_ACP_HOLD") != "")
		pids = append(pids, strconv.Itoa(pid))
	}
	os.WriteFile(file, []byte(strings.Join(pids, " ")), 0o644)
}

func runFakeACP(scriptPath, recordPath, statePath string) {
	// Side file: FAKE_ACP_RECORD is JSON-unmarshaled per line, so CURSOR_DATA_DIR cannot go there.
	if dump := os.Getenv("FAKE_ACP_CURSOR_DATA_DIR"); dump != "" {
		_ = os.WriteFile(dump, []byte(os.Getenv("CURSOR_DATA_DIR")), 0o644)
	}
	b, err := os.ReadFile(scriptPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake: ", err)
		os.Exit(2)
	}
	var script fakeScript
	if err := json.Unmarshal(b, &script); err != nil {
		fmt.Fprintln(os.Stderr, "fake: ", err)
		os.Exit(2)
	}
	rec, err := os.OpenFile(recordPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		os.Exit(2)
	}
	defer rec.Close()
	fc := newFakeCursor(statePath)

	in := make(chan msg, 64)
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 1<<20), 64<<20)
		for sc.Scan() {
			rec.Write(append(append([]byte{}, sc.Bytes()...), '\n'))
			var m msg
			if json.Unmarshal(sc.Bytes(), &m) == nil {
				in <- m
			}
		}
		rec.WriteString("EOF\n")
		close(in)
	}()
	out := bufio.NewWriter(os.Stdout)
	write := func(v any) {
		b, _ := json.Marshal(v)
		out.Write(append(b, '\n'))
		out.Flush()
	}

	var queue []msg
	next := func() (msg, bool) {
		if len(queue) > 0 {
			m := queue[0]
			queue = queue[1:]
			return m, true
		}
		m, ok := <-in
		return m, ok
	}
	answer := func(m msg) {
		res, rpcErr := fc.handle(m.Method, m.Params)
		if rpcErr != nil {
			write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": rpcErr})
		} else {
			write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": res})
		}
	}
	srvSeq := 0
	for {
		m, ok := next()
		if !ok {
			return
		}
		if m.Method == "" {
			continue
		}
		steps, scripted := script[m.Method]
		answered := false
		for _, s := range steps {
			switch {
			case s.Send != nil:
				out.Write(append(append([]byte{}, s.Send...), '\n'))
				out.Flush()
			case s.Update != nil:
				write(map[string]any{"jsonrpc": "2.0", "method": "session/update",
					"params": map[string]any{"sessionId": "fake", "update": s.Update}})
			case s.Result != nil:
				write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": s.Result})
				answered = true
			case s.Error != nil:
				write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": s.Error})
				answered = true
			case s.Request != nil:
				srvSeq++
				id := fmt.Sprintf("srv-%d", srvSeq)
				var r struct {
					Method string          `json:"method"`
					Params json.RawMessage `json:"params"`
				}
				json.Unmarshal(s.Request, &r)
				write(map[string]any{"jsonrpc": "2.0", "id": id, "method": r.Method, "params": r.Params})
				for {
					a, ok := <-in
					if !ok {
						return
					}
					if a.Method == "" && string(a.ID) == `"`+id+`"` {
						break
					}
					queue = append(queue, a)
				}
			case s.Wait != "":
				found := false
				for i, q := range queue {
					if q.Method == s.Wait {
						queue = append(queue[:i], queue[i+1:]...)
						found = true
						break
					}
				}
				for !found {
					a, ok := <-in
					if !ok {
						return
					}
					if a.Method == s.Wait {
						break
					}
					queue = append(queue, a)
				}
			case s.Sleep > 0:
				time.Sleep(time.Duration(s.Sleep) * time.Millisecond)
			case s.Until != "":
				for {
					if _, err := os.Stat(s.Until); err == nil {
						break
					}
					select {
					case a, ok := <-in:
						if !ok {
							return
						}
						queue = append(queue, a)
					case <-time.After(5 * time.Millisecond):
					}
				}
			case s.Cursor:
				answer(m)
				answered = true
			case s.Hang:
				for range in {
				}
				return
			}
		}
		if !scripted && len(m.ID) > 0 && !answered {
			answer(m)
		}
	}
}

// fakeEnvFile is the file the fake reads its variables from. It lies next to the name the fake
// was started under: each test starts the fake through a link of its own to the test binary
// (fakeAgent.bin), so the variables reach the fake without going through the test process's
// environment, and tests that start a fake can run in parallel.
const fakeEnvFile = "fake-env.json"

// loadFakeEnv puts the variables of fakeEnvFile, when there is one next to the name this process
// was started under, into the environment. The test process itself has none.
func loadFakeEnv() {
	b, err := os.ReadFile(filepath.Join(filepath.Dir(os.Args[0]), fakeEnvFile))
	if err != nil {
		return
	}
	var vars map[string]string
	if err := json.Unmarshal(b, &vars); err != nil {
		fmt.Fprintln(os.Stderr, "fake: ", err)
		os.Exit(2)
	}
	for k, v := range vars {
		os.Setenv(k, v)
	}
}

// fakeAgent is the fake agent set up for one test.
type fakeAgent struct {
	bin    string // what the test starts: a link to the test binary, with fakeEnvFile next to it
	record string // the fake's record file
	vars   map[string]string
}

// fake sets up the fake agent for one test.
func fake(t *testing.T, script fakeScript) *fakeAgent {
	t.Helper()
	dir := t.TempDir()
	b, err := json.Marshal(script)
	if err != nil {
		t.Fatal(err)
	}
	sp := filepath.Join(dir, "script.json")
	if err := os.WriteFile(sp, b, 0o644); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// The link has the test binary's name: alive tells a fake by it.
	f := &fakeAgent{bin: filepath.Join(dir, filepath.Base(os.Args[0])), record: filepath.Join(dir, "record.jsonl")}
	if err := os.Symlink(self, f.bin); err != nil {
		t.Fatal(err)
	}
	f.vars = map[string]string{
		"FAKE_ACP_STATE":           filepath.Join(dir, "cli-config.json"),
		"FAKE_ACP_SCRIPT":          sp,
		"FAKE_ACP_RECORD":          f.record,
		"FAKE_ACP_CURSOR_DATA_DIR": filepath.Join(dir, "cursor-data-dir"),
		"FAKE_ACP_ARGS":            filepath.Join(dir, "args"),
	}
	f.write(t)
	return f
}

// cue returns a step at which the fake waits until the test calls give. A test paces a turn with
// it where it has to see something first: unlike a sleep in the script, that takes no longer than
// it must and does not depend on how fast the machine is.
func cue(t *testing.T) (wait fakeStep, give func()) {
	t.Helper()
	file := filepath.Join(t.TempDir(), "cue")
	// give may be called from a timer that fires after the test has ended (it failed early), and
	// t.Error would then panic the whole test binary: once the test is over, give does nothing.
	var mu sync.Mutex
	over := false
	t.Cleanup(func() {
		mu.Lock()
		over = true
		mu.Unlock()
	})
	return fakeStep{Until: file}, func() {
		mu.Lock()
		defer mu.Unlock()
		if over {
			return
		}
		if err := os.WriteFile(file, nil, 0o644); err != nil {
			t.Error(err) // not Fatal: give may be called from a timer
		}
	}
}

// readRecordSoFar is readRecord for a fake that may not have started or may have been killed in
// the middle of a line: no file is no lines, and a line that is not whole is left out.
func readRecordSoFar(path string) []recorded {
	b, _ := os.ReadFile(path)
	var out []recorded
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var r recorded
		if line == "EOF" {
			out = append(out, recorded{EOF: true})
		} else if json.Unmarshal([]byte(line), &r) == nil {
			out = append(out, r)
		}
	}
	return out
}

// waitsOutBox runs a test of a time-out inside which a fake has to start first. Such a box is
// short so that the test is fast, and on a loaded machine the start alone can take longer than
// it: the box then ends before the fake got the request it never answers, which says nothing
// about what the test is about. So run gets short boxes in turn (first, then 2 s and 8 s), each
// with short set, and returns false when the fake did not get that far (and only then: everything
// else it checks fails the test in every box). The last box, full, counts whatever happened in it.
func waitsOutBox(t *testing.T, first, full time.Duration, run func(box time.Duration, short bool) bool) {
	t.Helper()
	for _, d := range []time.Duration{first, 2 * time.Second, 8 * time.Second} {
		if run(d, true) {
			return
		}
		t.Logf("%s was too short on this machine now", d)
	}
	run(full, false)
}

// fakeGone waits until no process started under the fake's name is left. For a fake whose record
// cannot tell (it may have been ended before it wrote a line).
func fakeGone(t *testing.T, f *fakeAgent) {
	t.Helper()
	for stop := time.Now().Add(20 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		// pgrep exits 1 when it found none.
		err := exec.Command("pgrep", "-f", "^"+regexp.QuoteMeta(f.bin)+"( |$)").Run()
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 1 {
			return
		}
		if time.Now().After(stop) {
			t.Fatalf("the fake %s is still running (pgrep: %v)", f.bin, err)
		}
	}
}

// set sets one more of the fake's variables. It holds for the fakes started after it.
func (f *fakeAgent) set(t *testing.T, key, value string) {
	t.Helper()
	f.vars[key] = value
	f.write(t)
}

func (f *fakeAgent) write(t *testing.T) {
	t.Helper()
	b, err := json.Marshal(f.vars)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(f.bin), fakeEnvFile), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// recorded is one line the fake received.
type recorded struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
	EOF    bool            `json:"-"`
}

func readRecord(t *testing.T, path string) []recorded {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []recorded
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "EOF" {
			out = append(out, recorded{EOF: true})
			continue
		}
		var r recorded
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("bad record line %q: %v", line, err)
		}
		out = append(out, r)
	}
	return out
}

func methods(rs []recorded) []string {
	var out []string
	for _, r := range rs {
		if r.Method != "" {
			out = append(out, r.Method)
		}
	}
	return out
}

func find(rs []recorded, method string) (recorded, bool) {
	for _, r := range rs {
		if r.Method == method {
			return r, true
		}
	}
	return recorded{}, false
}

// fakeModels is the fake Cursor's cursor/list_available_models result: each option's currentValue
// is the model's default. It covers every shape the policy meets: context + effort, thinking +
// context + effort, thinking only, reasoning without context, reasoning_effort + fast, no options,
// and optimize_for. Context values are deliberately not always in ascending order.
var fakeModels = raw(`{"models":[
 {"value":"claude-opus-5-5","name":"Claude Opus 5.5","configOptions":[
  {"id":"context","name":"Context","category":"model_config","currentValue":"300k","options":[{"value":"300k","name":"300K"},{"value":"1m","name":"1M"}]},
  {"id":"effort","name":"Effort","category":"thought_level","currentValue":"medium","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra High"},{"value":"max","name":"Max"}]},
  {"id":"fast","name":"Fast","category":"model_config","currentValue":"false","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]}]},
 {"value":"claude-sonnet-5","name":"Claude Sonnet 5","configOptions":[
  {"id":"thinking","name":"Thinking","category":"thought_level","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]},
  {"id":"context","name":"Context","category":"model_config","currentValue":"300k","options":[{"value":"300k","name":"300K"},{"value":"1m","name":"1M"}]},
  {"id":"effort","name":"Effort","category":"thought_level","currentValue":"high","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"max","name":"Max"}]}]},
 {"value":"claude-haiku-4-5","name":"Claude Haiku 4.5","configOptions":[
  {"id":"thinking","name":"Thinking","category":"thought_level","currentValue":"true","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]}]},
 {"value":"gpt-5.4","name":"GPT-5.4","configOptions":[
  {"id":"context","name":"Context","category":"model_config","currentValue":"272k","options":[{"value":"1m","name":"1M"},{"value":"272k","name":"272K"}]},
  {"id":"reasoning","name":"Reasoning","category":"thought_level","currentValue":"medium","options":[{"value":"none","name":"None"},{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"extra-high","name":"Extra High"}]},
  {"id":"fast","name":"Fast","category":"model_config","currentValue":"false","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]}]},
 {"value":"gpt-5.4-mini","name":"GPT-5.4 Mini","configOptions":[
  {"id":"reasoning","name":"Reasoning","category":"thought_level","currentValue":"medium","options":[{"value":"none","name":"None"},{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra High"}]}]},
 {"value":"grok-4.7","name":"Grok 4.7","configOptions":[
  {"id":"reasoning_effort","name":"Reasoning Effort","category":"thought_level","currentValue":"xhigh","options":[{"value":"low","name":"Low"},{"value":"medium","name":"Medium"},{"value":"high","name":"High"},{"value":"xhigh","name":"Extra High"}]},
  {"id":"fast","name":"Fast","category":"model_config","currentValue":"false","options":[{"value":"false","name":"Off"},{"value":"true","name":"On"}]}]},
 {"value":"gemini-3.1-pro","name":"Gemini 3.1 Pro","configOptions":[]},
 {"value":"auto-smart","name":"Auto","configOptions":[
  {"id":"optimize_for","name":"Optimize For","category":"model_config","currentValue":"balanced","options":[{"value":"intelligence","name":"Intelligence"},{"value":"balanced","name":"Balanced"},{"value":"cost","name":"Cost"}]}]}
]}`)

// fakeModelDefault is the model the fake Cursor selects when its shared config names none.
const fakeModelDefault = "gpt-5.4-mini"

// fakeConfig is the fake's cli-config.json: the last-used model and each model's last-used params,
// shared by every fake process of a test (as Cursor shares ~/.cursor/cli-config.json).
type fakeConfig struct {
	SelectedModel   string                       `json:"selectedModel"`
	ModelParameters map[string]map[string]string `json:"modelParameters"`
}

// fakeCursor answers initialize, session/new, session/load, cursor/list_available_models and
// session/set_config_option like `agent acp`. With the parameterized model picker flag in
// initialize, "model" takes a bare id and each model parameter is its own config option. Without
// it, "model" takes only pre-built variant values ("gpt-5.4-mini[reasoning=medium]") and there are
// no per-parameter options. Like Cursor, it reads the shared config at start and writes it back
// after every set: session/new and session/load both report the last-used model and params.
type fakeCursor struct {
	path   string
	flag   bool
	models []struct {
		Value         string         `json:"value"`
		Name          string         `json:"name"`
		ConfigOptions []configOption `json:"configOptions"`
	}
	cfg fakeConfig
}

func newFakeCursor(path string) *fakeCursor {
	fc := &fakeCursor{path: path}
	var list struct {
		Models json.RawMessage `json:"models"`
	}
	json.Unmarshal(fakeModels, &list)
	json.Unmarshal(list.Models, &fc.models)
	if b, err := os.ReadFile(path); err == nil {
		json.Unmarshal(b, &fc.cfg)
	}
	if fc.cfg.SelectedModel == "" {
		fc.cfg.SelectedModel = fakeModelDefault
	}
	if fc.cfg.ModelParameters == nil {
		fc.cfg.ModelParameters = map[string]map[string]string{}
	}
	return fc
}

func (fc *fakeCursor) save() {
	if fc.path == "" {
		return
	}
	b, _ := json.Marshal(fc.cfg)
	os.WriteFile(fc.path, b, 0o644)
}

// params returns a model's options with their last-used values, or nil when it is unknown.
func (fc *fakeCursor) params(id string) ([]configOption, bool) {
	for _, m := range fc.models {
		if m.Value != id {
			continue
		}
		out := make([]configOption, len(m.ConfigOptions))
		for i, o := range m.ConfigOptions {
			if v, ok := fc.cfg.ModelParameters[id][o.ID]; ok {
				o.CurrentValue = v
			}
			out[i] = o
		}
		return out, true
	}
	return nil, false
}

// variant is a model's pre-built variant value, from its list defaults (the old picker).
func (fc *fakeCursor) variant(id string) string {
	for _, m := range fc.models {
		if m.Value == id {
			var kv []string
			for _, o := range m.ConfigOptions {
				kv = append(kv, o.ID+"="+o.CurrentValue)
			}
			return id + "[" + strings.Join(kv, ",") + "]"
		}
	}
	return id
}

func (fc *fakeCursor) configOptions() []any {
	mode := map[string]any{"id": "mode", "name": "Mode", "type": "select", "currentValue": "agent",
		"options": []any{map[string]any{"value": "agent", "name": "Agent"}}}
	var values []any
	for _, m := range fc.models {
		v := m.Value
		if !fc.flag {
			v = fc.variant(m.Value)
		}
		values = append(values, map[string]any{"value": v, "name": m.Name})
	}
	current := fc.cfg.SelectedModel
	if !fc.flag {
		current = fc.variant(current)
	}
	out := []any{mode, map[string]any{"id": "model", "name": "Model", "category": "model", "type": "select",
		"currentValue": current, "options": values}}
	if fc.flag {
		ps, _ := fc.params(fc.cfg.SelectedModel)
		for _, o := range ps {
			out = append(out, o)
		}
	}
	return out
}

func invalid(what string) map[string]any {
	return map[string]any{"code": -32602, "message": "Invalid params", "data": what}
}

func (fc *fakeCursor) handle(method string, params json.RawMessage) (result any, rpcErr any) {
	switch method {
	case "initialize":
		var p struct {
			ClientCapabilities struct {
				Meta struct {
					ParameterizedModelPicker bool `json:"parameterizedModelPicker"`
				} `json:"_meta"`
			} `json:"clientCapabilities"`
		}
		json.Unmarshal(params, &p)
		fc.flag = p.ClientCapabilities.Meta.ParameterizedModelPicker
		return map[string]any{"protocolVersion": 1}, nil
	case "session/new":
		return map[string]any{"sessionId": testSessionID, "configOptions": fc.configOptions()}, nil
	case "session/load":
		return map[string]any{"configOptions": fc.configOptions()}, nil
	case "cursor/list_available_models":
		return fakeModels, nil
	case "session/set_config_option":
		var p struct {
			ConfigID string `json:"configId"`
			Value    string `json:"value"`
		}
		json.Unmarshal(params, &p)
		if p.ConfigID == "model" {
			id := p.Value
			if !fc.flag {
				id, _, _ = strings.Cut(p.Value, "[")
				if fc.variant(id) != p.Value {
					return nil, invalid("Invalid value for model: " + p.Value)
				}
			}
			if _, ok := fc.params(id); !ok {
				return nil, invalid("Invalid value for model: " + p.Value)
			}
			fc.cfg.SelectedModel = id
			fc.save()
			return map[string]any{"configOptions": fc.configOptions()}, nil
		}
		ps, _ := fc.params(fc.cfg.SelectedModel)
		for _, o := range ps {
			if fc.flag && o.ID == p.ConfigID && contains(o.values(), p.Value) {
				if fc.cfg.ModelParameters[fc.cfg.SelectedModel] == nil {
					fc.cfg.ModelParameters[fc.cfg.SelectedModel] = map[string]string{}
				}
				fc.cfg.ModelParameters[fc.cfg.SelectedModel][o.ID] = p.Value
				fc.save()
				return map[string]any{"configOptions": fc.configOptions()}, nil
			}
		}
		return nil, invalid("Invalid value for " + p.ConfigID + ": " + p.Value)
	}
	return map[string]any{}, nil
}

func raw(s string) json.RawMessage { return json.RawMessage(s) }

func mustMarshal(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
