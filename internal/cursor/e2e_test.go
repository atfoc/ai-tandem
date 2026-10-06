package cursor

// Real-CLI end-to-end test. It calls the real, logged-in Cursor agent with cheap models and
// therefore only runs when the caller opts in:
//
//	AIWB_CURSOR_E2E=1 go test -count=1 -v -run TestE2E ./internal/cursor/
//
// Isolation: CURSOR_CONFIG_DIR points at a temp folder holding a copy of the user's
// cli-config.json (read-only on the user's side), so the session stores and the last-used model
// are written there and never under ~/.cursor; the app folder, CURSOR_DATA_DIR and the working
// folder are temp dirs too. A missing binary, sqlite3 or config, or a first turn that fails (no
// login, model not offered) skips the test with the reason.
//
// Cursor's agent starts a worker-server of its own for the working folder (which starts language
// servers), and that one outlives the close of the agent. The server ends such processes with
// agent.EndAll when it stops; the test ends the process groups of the agents it started.

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
)

const (
	e2eModelA  = "gpt-5.4-nano" // the source's model
	e2eEffortA = "low"
	e2eFamilyA = "nano"             // in every name Cursor's store gives model A
	e2eModelB  = "claude-haiku-4-5" // the forks' model, of another family
	e2eFamilyB = "haiku"
	e2ePlant   = "Remember the word KIWI. Reply OK."
	e2eAsk     = "Which word?"
)

// e2eEnv is one test's spawner, its working folder and Cursor's config folder, and the process
// groups of the agents it has started.
type e2eEnv struct {
	s        *Spawner
	cwd, cfg string
	procs    []*proc
}

// own hands a started process to the environment, which ends it and its process group when the
// test ends.
func (e *e2eEnv) own(a agent.Agent) {
	e.procs = append(e.procs, a.(*proc))
}

// end closes the processes and ends what they left in their process groups (each agent leads a
// group of its own): SIGTERM, then SIGKILL to what is still there after 3 s.
func (e *e2eEnv) end() {
	var pgids []int
	for _, p := range e.procs {
		p.Close()
		pgids = append(pgids, p.conn.cmd.Process.Pid)
	}
	left := func() bool {
		return slices.ContainsFunc(pgids, func(pgid int) bool { return syscall.Kill(-pgid, 0) != syscall.ESRCH })
	}
	for _, pgid := range pgids {
		syscall.Kill(-pgid, syscall.SIGTERM)
	}
	for deadline := time.Now().Add(3 * time.Second); left() && time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
	}
	for _, pgid := range pgids {
		syscall.Kill(-pgid, syscall.SIGKILL)
	}
	for deadline := time.Now().Add(2 * time.Second); left() && time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
	}
}

// newE2EEnv gates the e2e and builds the spawner over temp folders, with Cursor's config folder
// a temp copy of the user's cli-config.json.
func newE2EEnv(t *testing.T) *e2eEnv {
	t.Helper()
	if os.Getenv("AIWB_CURSOR_E2E") != "1" {
		t.Skip("AIWB_CURSOR_E2E is not 1: skipping the real-Cursor e2e (it calls paid models)")
	}
	bin := "cursor-agent"
	if _, err := exec.LookPath(bin); err != nil {
		bin = "agent"
		if _, err := exec.LookPath(bin); err != nil {
			t.Skip("the real Cursor agent (cursor-agent or agent) is not on PATH")
		}
	}
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 is not on PATH")
	}
	src := os.Getenv("CURSOR_CONFIG_DIR")
	if src == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("cannot locate the home folder: %v", err)
		}
		src = filepath.Join(home, ".cursor")
	}
	config, err := os.ReadFile(filepath.Join(src, "cli-config.json"))
	if err != nil {
		t.Skipf("no %s/cli-config.json: is Cursor's agent logged in?", src)
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg, cwd := filepath.Join(base, "config"), filepath.Join(base, "project")
	for _, dir := range []string{cfg, cwd, filepath.Join(base, "app", "store")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(cfg, "cli-config.json"), config, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CURSOR_CONFIG_DIR", cfg)
	e := &e2eEnv{cwd: cwd, cfg: cfg,
		s: &Spawner{Bin: bin, AppRoot: filepath.Join(base, "app", "store"), Home: filepath.Join(base, "nohome")}}
	t.Cleanup(e.end) // before the temp folders are removed
	return e
}

// e2eReply is what one turn of a real Cursor chat produced.
type e2eReply struct {
	text string
	end  agent.Event // the turn end
}

// e2eTurn sends one prompt, allows every permission request and collects the turn up to its end.
// The turn end is returned as it came, with its error if any; a Send that fails is returned too.
func e2eTurn(t *testing.T, a agent.Agent, prompt string) (e2eReply, error) {
	t.Helper()
	if err := a.Send([]agent.ContentBlock{{Text: prompt}}); err != nil {
		return e2eReply{}, err
	}
	var r e2eReply
	var sb strings.Builder
	timeout := time.After(3 * time.Minute)
	for {
		select {
		case ev, ok := <-a.Events():
			if !ok || ev.Kind == agent.EvExit {
				t.Fatalf("Cursor exited before the turn ended: %+v", ev)
			}
			switch ev.Kind {
			case agent.EvTextDelta, agent.EvText:
				if ev.Sub == "" {
					sb.WriteString(ev.Text)
				}
			case agent.EvPermRequest:
				if err := a.Decide(ev.PermID, true); err != nil {
					t.Errorf("Decide: %v", err)
				}
			case agent.EvTurnEnd:
				r.text, r.end = sb.String(), ev
				return r, nil
			}
		case <-timeout:
			t.Fatal("timed out after 3 minutes waiting for the turn to end")
		}
	}
}

// e2eSay is e2eTurn for a turn that must end without an error.
func e2eSay(t *testing.T, a agent.Agent, prompt string) e2eReply {
	t.Helper()
	r, err := e2eTurn(t, a, prompt)
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if r.end.Error != "" || r.end.Aborted {
		t.Fatalf("turn ended with error %q aborted %v", r.end.Error, r.end.Aborted)
	}
	return r
}

// e2eClose closes the process and waits for its exit.
func e2eClose(t *testing.T, a agent.Agent) {
	t.Helper()
	a.Close()
	timeout := time.After(15 * time.Second)
	for {
		select {
		case ev, ok := <-a.Events():
			if !ok || ev.Kind == agent.EvExit {
				return
			}
		case <-timeout:
			t.Fatal("Cursor did not exit within 15 s of its close")
		}
	}
}

// e2eRunning fails the test when the process has exited.
func e2eRunning(t *testing.T, what string, a agent.Agent) {
	t.Helper()
	for {
		select {
		case ev, ok := <-a.Events():
			if !ok || ev.Kind == agent.EvExit {
				t.Fatalf("%s has exited: %+v", what, ev)
			}
		default:
			return
		}
	}
}

var e2eModelNameRe = regexp.MustCompile(`"modelName":"([^"]+)"`)

// e2eStore is what a session store tells about the model of the session's turns.
type e2eStore struct {
	blobs map[string]bool // the ids of its blobs
	// prompt is the model the system message of the latest root was built for
	// (providerOptions.cursor.systemPromptFingerprint.model). Cursor writes a new system message
	// when a session's first request on another model is made, so after a turn it names the
	// model that turn ran on.
	prompt string
	// stamps are the model names on the reasoning parts of answers
	// (providerOptions.cursor.modelName) in the blobs that are not among the known ones. An
	// answer with no reasoning part has none.
	stamps []string
}

// e2eReadStore reads a session store. Blob ids are content hashes, so with known the blobs of a
// fork's source, the stamps are those of the fork's own turns.
func e2eReadStore(t *testing.T, s *Spawner, sessionID string, known map[string]bool) e2eStore {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := runSQLiteCtx(ctx, s.sqlite(), "", StorePath(s.Home, sessionID),
		"SELECT value FROM meta WHERE key = '0';", "SELECT id || ' ' || hex(data) FROM blobs;")
	if err != nil {
		t.Fatalf("read the store of session %s: %v", sessionID, err)
	}
	lines := strings.Split(out, "\n")
	var meta struct {
		Root string `json:"latestRootBlobId"`
	}
	if b, err := hex.DecodeString(lines[0]); err != nil || json.Unmarshal(b, &meta) != nil || meta.Root == "" {
		t.Fatalf("the store of session %s has no latest root in its meta row %q", sessionID, lines[0])
	}
	st := e2eStore{blobs: map[string]bool{}}
	data := map[string][]byte{}
	for _, line := range lines[1:] {
		id, raw, _ := strings.Cut(line, " ")
		b, err := hex.DecodeString(raw)
		if err != nil {
			t.Fatal(err)
		}
		st.blobs[id], data[id] = true, b
		if known[id] {
			continue
		}
		for _, m := range e2eModelNameRe.FindAllSubmatch(b, -1) {
			if name := string(m[1]); !slices.Contains(st.stamps, name) {
				st.stamps = append(st.stamps, name)
			}
		}
	}
	// The root is a protobuf message that names the conversation's messages by their raw ids.
	root, prompts := data[meta.Root], 0
	for id, b := range data {
		var msg struct {
			Role            string `json:"role"`
			ProviderOptions struct {
				Cursor struct {
					Fingerprint struct {
						Model string `json:"model"`
					} `json:"systemPromptFingerprint"`
				} `json:"cursor"`
			} `json:"providerOptions"`
		}
		rawID, _ := hex.DecodeString(id)
		if json.Unmarshal(b, &msg) == nil && msg.Role == "system" && bytes.Contains(root, rawID) {
			st.prompt = msg.ProviderOptions.Cursor.Fingerprint.Model
			prompts++
		}
	}
	if prompts != 1 {
		t.Fatalf("the latest root of session %s names %d system messages, want 1", sessionID, prompts)
	}
	return st
}

// e2eRunsOn reads a session's store after a turn and fails the test unless it shows that the turn
// ran on a model of the family. It returns the store's blob ids.
func e2eRunsOn(t *testing.T, s *Spawner, what, sessionID string, known map[string]bool, family string) map[string]bool {
	t.Helper()
	st := e2eReadStore(t, s, sessionID, known)
	t.Logf("%s: its store's system message was built for %s; its own answers are stamped %q", what, st.prompt, st.stamps)
	if !strings.Contains(st.prompt, family) {
		t.Fatalf("%s: the system message of its latest root was built for %q, want a %s model", what, st.prompt, family)
	}
	for _, name := range st.stamps {
		if !strings.Contains(name, family) {
			t.Fatalf("%s: an answer is stamped %q, want only %s models (all: %q)", what, name, family, st.stamps)
		}
	}
	return st.blobs
}

// e2eLastUsed fails the test unless the config folder's cli-config.json names the model as the
// last one selected: Cursor writes it there when the adapter applies a session's model. It is one
// value for the whole config folder, so it tells only about the session started last.
func e2eLastUsed(t *testing.T, what, cfg, want string) {
	t.Helper()
	got := ""
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		var c struct {
			SelectedModel struct {
				ModelID string `json:"modelId"`
			} `json:"selectedModel"`
		}
		if b, err := os.ReadFile(filepath.Join(cfg, "cli-config.json")); err == nil && json.Unmarshal(b, &c) == nil {
			got = c.SelectedModel.ModelID
		}
		if got == want || time.Now().After(deadline) {
			break
		}
	}
	t.Logf("%s: cli-config.json names %s as the selected model", what, got)
	if got != want {
		t.Errorf("%s: cli-config.json names %q as the selected model, want %q", what, got, want)
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
// the real Cursor agent: a fork that runs on a model of another family than its source, and a
// fork that is given another model before its first message. The second is done the way the app
// will do it: a new fork of the same source is started on the new model first, and only then the
// old fork's process is closed and its store discarded, so that a start that fails would leave
// the old fork usable.
//
// The model of a process is read from what Cursor wrote, never from what the model says about
// itself: after a turn, the model the session store names for it (e2eStore), and right after a
// start, the selected model in the config folder's cli-config.json. A fork with no message has
// had no turn, so only the second tells about it.
func TestE2EForkOtherModel(t *testing.T) {
	e := newE2EEnv(t)
	s, cwd, cfg := e.s, e.cwd, e.cfg
	optsA := agent.SpawnOptions{Cwd: cwd, Model: e2eModelA, Effort: e2eEffortA}
	optsB := agent.SpawnOptions{Cwd: cwd, Model: e2eModelB}
	storeDir := func(id string) string { return filepath.Dir(StorePath(s.Home, id)) }

	// 1. The source on model A plants the word.
	srcA, err := s.Spawn(optsA)
	if err != nil {
		t.Skipf("Cursor could not start: %v", err)
	}
	e.own(srcA)
	first, err := e2eTurn(t, srcA, e2ePlant)
	if err != nil {
		t.Skipf("the source did not get ready (not logged in, or %s is not offered?): %v", e2eModelA, err)
	}
	if first.end.Error != "" {
		t.Skipf("the first turn failed (not logged in, or %s is not offered?): %s", e2eModelA, first.end.Error)
	}
	if first.end.Point == "" {
		t.Fatalf("the source's turn ended with no point: %+v", first.end)
	}
	srcID := srcA.(*proc).sessionID
	srcBlobs := e2eRunsOn(t, s, "source", srcID, nil, e2eFamilyA)
	src := agent.ForkSource{SessionID: srcID, Point: first.end.Point, End: true}

	// 2. A fork at that turn's end on model B, of another family.
	asked := time.Now()
	oneA, oneID, err := s.SpawnFork(optsB, src)
	if err != nil {
		t.Fatalf("SpawnFork on %s: %v", e2eModelB, err)
	}
	e.own(oneA)
	t.Logf("fork (%s -> %s): session %s ready %s after it was asked for", e2eModelA, e2eModelB, oneID,
		time.Since(asked).Round(time.Millisecond))
	e2eLastUsed(t, "fork", cfg, e2eModelB)
	r := e2eSay(t, oneA, e2eAsk)
	e2eRecalls(t, "fork on "+e2eModelB, r.text)
	e2eRunsOn(t, s, "fork", oneID, srcBlobs, e2eFamilyB)
	e2eClose(t, oneA)

	// 3. Another fork on model A (fork 1) gets no message; then its model is changed. First the
	// same source is forked again on model B (fork 2), then fork 1 is closed and discarded.
	asked = time.Now()
	oldA, oldID, err := s.SpawnFork(optsA, src)
	if err != nil {
		t.Fatalf("SpawnFork on %s: %v", e2eModelA, err)
	}
	e.own(oldA)
	t.Logf("fork 1 (%s): session %s ready %s after it was asked for", e2eModelA, oldID, time.Since(asked).Round(time.Millisecond))
	e2eLastUsed(t, "fork 1", cfg, e2eModelA)
	if _, err := os.Stat(StorePath(s.Home, oldID)); err != nil {
		t.Fatalf("fork 1 has no store: %v", err)
	}
	changed := time.Now()
	newA, newID, err := s.SpawnFork(optsB, src)
	if err != nil {
		t.Fatalf("SpawnFork again on %s, with fork 1 still running: %v", e2eModelB, err)
	}
	e.own(newA)
	ready := time.Since(changed)
	if newID == "" || newID == oldID || newID == oneID || newID == srcID {
		t.Fatalf("fork 2 has session id %q (source %s, earlier forks %s and %s)", newID, srcID, oneID, oldID)
	}
	e2eLastUsed(t, "fork 2", cfg, e2eModelB)
	e2eRunning(t, "fork 1, while fork 2 started", oldA)
	if _, err := os.Stat(StorePath(s.Home, oldID)); err != nil {
		t.Fatalf("fork 1's store is gone before it was discarded: %v", err)
	}
	e2eClose(t, oldA)
	s.DiscardFork(oldID)
	t.Logf("model change (%s -> %s): fork 2 (session %s) ready %s after it was asked for, fork 1 closed and discarded %s later",
		e2eModelA, e2eModelB, newID, ready.Round(time.Millisecond), (time.Since(changed) - ready).Round(time.Millisecond))
	if _, err := os.Stat(storeDir(oldID)); !os.IsNotExist(err) {
		t.Fatalf("fork 1's store folder %s is still there after DiscardFork (stat: %v)", storeDir(oldID), err)
	}
	r = e2eSay(t, newA, e2eAsk)
	e2eRecalls(t, "fork 2 on "+e2eModelB, r.text)
	e2eRunsOn(t, s, "fork 2", newID, srcBlobs, e2eFamilyB)
	if _, err := os.Stat(storeDir(oldID)); !os.IsNotExist(err) {
		t.Fatalf("fork 1's store folder %s is back after fork 2's turn (stat: %v)", storeDir(oldID), err)
	}
	e2eClose(t, newA)

	// 4. The source, alive the whole time, answers on its own model A.
	r = e2eSay(t, srcA, e2eAsk)
	e2eRecalls(t, "source on "+e2eModelA, r.text)
	e2eRunsOn(t, s, "source after the forks", srcID, srcBlobs, e2eFamilyA)
	e2eClose(t, srcA)
}
