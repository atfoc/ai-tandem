package claude

// Real-CLI end-to-end tests. They call the real, logged-in claude with cheap models and therefore
// only run when the caller opts in:
//
//	AIWB_CLAUDE_E2E=1 go test -count=1 -v -run TestE2E ./internal/claude/
//
// Isolation: the working folder and the app folder are temp dirs. The CLI itself runs with the
// user's own login and config, which the tests do not change. It keeps its session files under
// its config folder (~/.claude/projects/<the working folder's path with dashes>/) and the output
// of background tasks under /tmp/claude-<uid>/<the same name>/: the tests remove those folders of
// their temp working folders when they end, once their processes have exited. A missing binary
// or a first turn that fails (no login, model not offered) skips the test with the reason.

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

const (
	e2eModelA = "haiku"  // the source's model
	e2eModelB = "sonnet" // the forks' model, of another family
	e2ePlant  = "Remember the word KIWI. Reply OK."
	e2eAsk    = "Which word?"
)

// e2eGate skips the test unless the real-CLI e2e is enabled and the claude binary is there.
func e2eGate(t *testing.T) {
	t.Helper()
	if os.Getenv("AIWB_CLAUDE_E2E") != "1" {
		t.Skip("AIWB_CLAUDE_E2E is not 1: skipping the real-claude e2e (it calls paid models)")
	}
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("the real claude binary is not on PATH")
	}
}

// e2eEnv is one test's spawner and working folder, and the processes it has started.
type e2eEnv struct {
	s     *Spawner
	cwd   string
	procs []*proc
}

// newE2EEnv builds the spawner over temp folders. When the test ends, the processes given to own
// are closed and waited for (a CLI that is still exiting writes its session file once more), and
// then the folders the CLI made for the temp working folder are removed.
func newE2EEnv(t *testing.T) *e2eEnv {
	t.Helper()
	cwd, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	e := &e2eEnv{s: &Spawner{Bin: "claude", AppRoot: t.TempDir(), Home: t.TempDir()}, cwd: cwd}
	t.Cleanup(func() {
		for _, p := range e.procs {
			p.Close()
		}
		for _, p := range e.procs {
			select {
			case <-p.done:
			case <-time.After(10 * time.Second):
				t.Errorf("a claude process (pid %d) did not exit within 10 s of its close", p.cmd.Process.Pid)
			}
		}
		// The CLI names its folders after the working folder: its path, every character that is
		// not a letter or a digit replaced by a dash.
		name := regexp.MustCompile(`[^a-zA-Z0-9]`).ReplaceAllString(cwd, "-")
		if !strings.Contains(name, "TestE2E") {
			return
		}
		os.RemoveAll(filepath.Join(e2eConfigDir(), "projects", name))
		tasks, _ := filepath.Glob(filepath.Join("/tmp", "claude-*", name))
		for _, dir := range tasks {
			os.RemoveAll(dir)
		}
	})
	return e
}

// own hands a started process to the environment, which closes it when the test ends.
func (e *e2eEnv) own(a agent.Agent) *proc {
	p := a.(*proc)
	e.procs = append(e.procs, p)
	return p
}

// session returns a new session id.
func (e *e2eEnv) session(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	b[6], b[8] = b[6]&0x0f|0x40, b[8]&0x3f|0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func (e *e2eEnv) opts(sessionID, model string) agent.SpawnOptions {
	return agent.SpawnOptions{SessionID: sessionID, Cwd: e.cwd, Model: model}
}

// e2eConfigDir is the CLI's config folder.
func e2eConfigDir() string {
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// e2eSessionFile is the CLI's file of a session, "" when it has none.
func e2eSessionFile(sessionID string) string {
	files, _ := filepath.Glob(filepath.Join(e2eConfigDir(), "projects", "*", sessionID+".jsonl"))
	if len(files) == 0 {
		return ""
	}
	return files[0]
}

// e2eAnswerModels is the model id the CLI recorded on each assistant message of a session file,
// in order (one per message; the CLI's own "<synthetic>" messages are left out).
func e2eAnswerModels(t *testing.T, sessionID string) []string {
	t.Helper()
	file := e2eSessionFile(sessionID)
	if file == "" {
		t.Fatalf("session %s has no file", sessionID)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var models []string
	last := ""
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var entry struct {
			Type    string `json:"type"`
			Message struct {
				ID    string `json:"id"`
				Model string `json:"model"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(line), &entry) != nil || entry.Type != "assistant" ||
			entry.Message.Model == "<synthetic>" || entry.Message.ID == last {
			continue
		}
		last = entry.Message.ID
		models = append(models, entry.Message.Model)
	}
	return models
}

// e2eReply is what one turn of a real claude chat produced.
type e2eReply struct {
	text  string
	tools []string
	end   agent.Event // the turn end
}

// e2eTurn sends one prompt, allows every permission request and collects the turn up to its end.
// The turn end is returned as it came, with its error if any.
func e2eTurn(t *testing.T, a agent.Agent, prompt string) e2eReply {
	t.Helper()
	if err := a.Send([]agent.ContentBlock{{Text: prompt}}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	var r e2eReply
	var sb strings.Builder
	timeout := time.After(3 * time.Minute)
	for {
		select {
		case ev, ok := <-a.Events():
			if !ok || ev.Kind == agent.EvExit {
				t.Fatalf("claude exited before the turn ended: %+v; stderr %q", ev, a.(*proc).stderr.String())
			}
			switch ev.Kind {
			case agent.EvTextDelta, agent.EvText:
				if ev.Sub == "" {
					sb.WriteString(ev.Text)
				}
			case agent.EvToolInput:
				r.tools = append(r.tools, ev.ToolName)
			case agent.EvPermRequest:
				if err := a.Decide(ev.PermID, true); err != nil {
					t.Errorf("Decide: %v", err)
				}
			case agent.EvTurnEnd:
				r.text, r.end = sb.String(), ev
				return r
			}
		case <-timeout:
			t.Fatal("timed out after 3 minutes waiting for the turn to end")
		}
	}
}

// e2eSay is e2eTurn for a turn that must end without an error.
func e2eSay(t *testing.T, a agent.Agent, prompt string) e2eReply {
	t.Helper()
	r := e2eTurn(t, a, prompt)
	if r.end.Error != "" || r.end.Aborted {
		t.Fatalf("turn ended with error %q aborted %v", r.end.Error, r.end.Aborted)
	}
	return r
}

// e2eClose closes the process and waits for its exit. It returns the events that came before
// the exit.
func e2eClose(t *testing.T, a agent.Agent) []agent.Event {
	t.Helper()
	a.Close()
	var evs []agent.Event
	timeout := time.After(15 * time.Second)
	for {
		select {
		case ev, ok := <-a.Events():
			if !ok || ev.Kind == agent.EvExit {
				<-a.(*proc).done
				return evs
			}
			evs = append(evs, ev)
		case <-timeout:
			t.Fatal("claude did not exit within 15 s of its close")
		}
	}
}

// e2eRunsOn fails the test unless the CLI's last system/init line of the process named a model
// of the family (the adapter keeps it; the CLI prints the line when a message starts a turn).
// It is read once the turn has ended, when the read loop is idle.
func e2eRunsOn(t *testing.T, a agent.Agent, what, family string) {
	t.Helper()
	got := a.(*proc).model
	t.Logf("%s: system/init names model %s", what, got)
	if !strings.Contains(got, family) {
		t.Fatalf("%s runs on %q by its system/init line, want a %s model", what, got, family)
	}
}

// e2eAnswered fails the test unless the session file records its answers as given by models of
// these families, in this order.
func e2eAnswered(t *testing.T, what, sessionID string, families ...string) {
	t.Helper()
	got := e2eAnswerModels(t, sessionID)
	t.Logf("%s: the session file records answers by %q", what, got)
	if len(got) != len(families) {
		t.Fatalf("%s: the session file records %d answers %q, want %d by %q", what, len(got), got, len(families), families)
	}
	for i, family := range families {
		if !strings.Contains(got[i], family) {
			t.Fatalf("%s: answer %d is by %q, want a %s model (all: %q)", what, i+1, got[i], family, got)
		}
	}
}

func e2eRecalls(t *testing.T, what, text string) {
	t.Helper()
	t.Logf("%s recall: %q", what, text)
	if !strings.Contains(strings.ToUpper(text), "KIWI") {
		t.Fatalf("%s recall %q lacks KIWI", what, text)
	}
}

// TestE2EForkOtherModel covers the model choice of phase 3 of the concurrent branches plan with
// the real CLI: a fork that runs on a model of another family than its source (Haiku to Sonnet),
// and a fork that is given another model before its first message. The second is done the way
// the app will do it: the fork's process, which has been sent nothing, is closed, and SpawnFork is
// called again with the same source, the same fork id and the new model. The model of a process
// is read from the CLI's system/init line and from the model id the CLI recorded on each answer
// in the session file, never from what the model says about itself.
func TestE2EForkOtherModel(t *testing.T) {
	e2eGate(t)
	e := newE2EEnv(t)
	srcID, oneID, twoID := e.session(t), e.session(t), e.session(t)

	// 1. The source on model A plants the word.
	srcA, err := e.s.Spawn(e.opts(srcID, e2eModelA))
	if err != nil {
		t.Skipf("claude could not start: %v", err)
	}
	e.own(srcA)
	first := e2eTurn(t, srcA, e2ePlant)
	if first.end.Error != "" {
		t.Skipf("the first turn failed (not logged in, or %s is not offered?): %s", e2eModelA, first.end.Error)
	}
	if first.end.Point == "" {
		t.Fatalf("the source's turn ended with no point: %+v", first.end)
	}
	e2eRunsOn(t, srcA, "source", e2eModelA)
	srcFile := e2eSessionFile(srcID)
	before, err := os.ReadFile(srcFile)
	if err != nil {
		t.Fatalf("the source's session file: %v", err)
	}
	src := agent.ForkSource{SessionID: srcID, Point: first.end.Point, End: true}

	// 2. A fork at that turn's end on model B, of another family.
	asked := time.Now()
	oneA, id, err := e.s.SpawnFork(e.opts(oneID, e2eModelB), src)
	if err != nil {
		t.Fatalf("SpawnFork on %s: %v", e2eModelB, err)
	}
	e.own(oneA)
	t.Logf("fork 1 (%s -> %s): session %s ready %s after it was asked for", e2eModelA, e2eModelB, id,
		time.Since(asked).Round(time.Millisecond))
	if id != oneID {
		t.Fatalf("fork 1 has session id %q, want the app's %q", id, oneID)
	}
	r := e2eSay(t, oneA, e2eAsk)
	e2eRecalls(t, "fork 1 on "+e2eModelB, r.text)
	e2eRunsOn(t, oneA, "fork 1", e2eModelB)
	e2eAnswered(t, "fork 1", oneID, e2eModelA, e2eModelB)
	e2eClose(t, oneA)

	// 3. A second fork on model A gets no message; then its model is changed: its process is
	// closed and the fork is made again from the same source on model B.
	asked = time.Now()
	twoA, _, err := e.s.SpawnFork(e.opts(twoID, e2eModelA), src)
	if err != nil {
		t.Fatalf("SpawnFork on %s: %v", e2eModelA, err)
	}
	e.own(twoA)
	t.Logf("fork 2 (%s): session %s ready %s after it was asked for", e2eModelA, twoID, time.Since(asked).Round(time.Millisecond))
	changed := time.Now()
	evs := e2eClose(t, twoA)
	exited := time.Since(changed)
	// The CLI prints no system/init line before the first message, so nothing but the launch
	// arguments tells which model a fork with no message would have run on.
	args := twoA.(*proc).cmd.Args
	t.Logf("fork 2 before the change: events %v, system/init model %q, launched with --model %s", kinds(evs),
		twoA.(*proc).model, args[slices.Index(args, "--model")+1])
	if slices.Contains(kinds(evs), agent.EvTurnEnd) {
		t.Errorf("fork 2 ended a turn though it was sent nothing: %+v", evs)
	}
	if file := e2eSessionFile(twoID); file != "" {
		t.Fatalf("fork 2 has the session file %s though it was sent nothing: the second fork would resume it", file)
	}
	againA, id, err := e.s.SpawnFork(e.opts(twoID, e2eModelB), src)
	if err != nil {
		t.Fatalf("SpawnFork again on %s: %v", e2eModelB, err)
	}
	e.own(againA)
	t.Logf("fork 2 model change (%s -> %s): closed in %s, ready on the new model %s after the close began",
		e2eModelA, e2eModelB, exited.Round(time.Millisecond), time.Since(changed).Round(time.Millisecond))
	if args = againA.(*proc).cmd.Args; id != twoID || !slices.Contains(args, "--fork-session") {
		t.Fatalf("the second start of fork 2 has id %q (want %q) and arguments %q, want a fork of the source", id, twoID, args)
	}
	r = e2eSay(t, againA, e2eAsk)
	e2eRecalls(t, "fork 2 on "+e2eModelB, r.text)
	e2eRunsOn(t, againA, "fork 2 after the change", e2eModelB)
	e2eAnswered(t, "fork 2", twoID, e2eModelA, e2eModelB)
	e2eClose(t, againA)

	// 4. The source, alive the whole time and untouched by the forks, answers on its own model A.
	if after, _ := os.ReadFile(srcFile); string(after) != string(before) {
		t.Fatalf("the forks changed the source's session file: %d bytes, was %d", len(after), len(before))
	}
	r = e2eSay(t, srcA, e2eAsk)
	e2eRecalls(t, "source on "+e2eModelA, r.text)
	e2eRunsOn(t, srcA, "source after the forks", e2eModelA)
	e2eAnswered(t, "source", srcID, e2eModelA, e2eModelA)
	e2eClose(t, srcA)
}

// TestE2EForkOtherModelWithFile is the model change on a fork with no message yet whose session
// file exists all the same: the CLI writes it at the fork's start when the copied part holds a
// background task of the source that had not finished. The second SpawnFork is then refused by
// the CLI as "already in use" and the adapter resumes the fork's own session, on the new model.
func TestE2EForkOtherModelWithFile(t *testing.T) {
	e2eGate(t)
	e := newE2EEnv(t)
	srcID, forkID := e.session(t), e.session(t)
	// The background command outlives the CLI's close: it is found and killed by this marker.
	marker := "aiwb-e2e-" + srcID[:8]
	t.Cleanup(func() { exec.Command("pkill", "-f", marker).Run() })

	// The source on model A starts a background task that is still running at the turn's end.
	srcA, err := e.s.Spawn(e.opts(srcID, e2eModelA))
	if err != nil {
		t.Skipf("claude could not start: %v", err)
	}
	e.own(srcA)
	first := e2eTurn(t, srcA, "Call the Bash tool once, with run_in_background set to true, and this exact command: "+
		`python3 -c "import time; time.sleep(600)" `+marker+"\nDo not wait for it and do not check on it. "+
		"Then remember the word KIWI and reply OK.")
	if first.end.Error != "" {
		t.Skipf("the first turn failed (not logged in, or %s is not offered?): %s", e2eModelA, first.end.Error)
	}
	if exec.Command("pgrep", "-f", marker).Run() != nil {
		t.Skipf("the model did not leave the background command running (tools %q, text %q): nothing to cover",
			first.tools, first.text)
	}
	if first.end.Point == "" {
		t.Fatalf("the source's turn ended with no point: %+v", first.end)
	}
	src := agent.ForkSource{SessionID: srcID, Point: first.end.Point, End: true}

	// A fork on model A: it is sent nothing, and yet it has a session file.
	asked := time.Now()
	oneA, _, err := e.s.SpawnFork(e.opts(forkID, e2eModelA), src)
	if err != nil {
		t.Fatalf("SpawnFork on %s: %v", e2eModelA, err)
	}
	e.own(oneA)
	t.Logf("fork (%s): session %s ready %s after it was asked for", e2eModelA, forkID, time.Since(asked).Round(time.Millisecond))
	for deadline := time.Now().Add(10 * time.Second); e2eSessionFile(forkID) == ""; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the fork has no session file 10 s after its start, though its source has an unfinished background task")
		}
	}
	time.Sleep(time.Second) // the CLI's empty result for the task it reports as stopped
	changed := time.Now()
	evs := e2eClose(t, oneA)
	exited := time.Since(changed)
	file := e2eSessionFile(forkID)
	fi, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	copied := e2eAnswerModels(t, forkID) // the source's turn: the tool call and the reply
	t.Logf("fork before the change: events %v, session file of %d bytes, answers by %q", kinds(evs), fi.Size(), copied)
	if slices.Contains(kinds(evs), agent.EvTurnEnd) {
		t.Errorf("the fork ended a turn though it was sent nothing: %+v", evs)
	}

	// The model change: the same SpawnFork call on model B. The fork's own session is resumed.
	againA, id, err := e.s.SpawnFork(e.opts(forkID, e2eModelB), src)
	if err != nil {
		t.Fatalf("SpawnFork again on %s: %v", e2eModelB, err)
	}
	e.own(againA)
	t.Logf("fork model change (%s -> %s): closed in %s, ready on the new model %s after the close began",
		e2eModelA, e2eModelB, exited.Round(time.Millisecond), time.Since(changed).Round(time.Millisecond))
	args := againA.(*proc).cmd.Args
	if i := slices.Index(args, "--resume"); id != forkID || i < 0 || args[i+1] != forkID || slices.Contains(args, "--fork-session") {
		t.Fatalf("the second start of the fork has id %q (want %q) and arguments %q, want a resume of the fork's own session", id, forkID, args)
	}
	r := e2eSay(t, againA, e2eAsk+" Reply with only the word.")
	e2eRecalls(t, "fork on "+e2eModelB, r.text)
	e2eRunsOn(t, againA, "fork after the change", e2eModelB)
	e2eAnswered(t, "fork", forkID, append(slices.Repeat([]string{e2eModelA}, len(copied)), e2eModelB)...)
	e2eClose(t, againA)
	e2eClose(t, srcA)
}
