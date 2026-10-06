package runs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
)

// Test support of the engine: a scripted ChatHost that settles on demand, and a run started the
// way the service's Start starts one, in a temp folder or a temp git repository.

// ---- the fake chat manager -----------------------------------------------------

// engHost is a ChatHost whose agents are a script: on runs once per accepted message, on its
// own goroutine, and says how the turn ends (Say, Block, Fail, Exit, NoSession; a script that
// returns without saying ends the turn cleanly with no text). StopOwned ends a turn that has not
// ended as aborted.
type engHost struct {
	nopHost
	mu     sync.Mutex
	chats  map[string]*engChat
	on     func(m *engMsg)       // the script
	refuse func(m *engMsg) error // what SendOwned answers, when it returns an error
	gate   chan struct{}         // when set, SendOwned blocks until it is closed or the chat is stopped
	sends  []*engMsg             // every accepted message, in order
	stops  []string              // the names of the chats StopOwned was called for
	costs  map[string]chats.Cost
	acts   map[string]chats.Activity
	busy   map[string]bool // chats that are not idle
	boom   string          // CreateOwned panics for the chat with this name
	turns  sync.WaitGroup  // the scripts that run
}

type engChat struct {
	spec    chats.OwnedSpec
	session bool // it has had a message: the next one resumes
	process bool
	sent    int
	wait    *engWait
	stopped chan struct{} // closed when StopOwned ends the process that took the last message
	text    string
}

type engWait struct {
	done    chan struct{}
	settled chats.Settled
	set     bool
}

// engMsg is one message the engine sent, and the turn it started.
type engMsg struct {
	h       *engHost
	c       *engChat
	w       *engWait
	ID      string
	Name    string
	Role    model.AgentRole
	Cwd     string
	Text    string
	N       int  // the number of the message in its chat, from 1
	Fresh   bool // the engine asked for a new session
	Resumed bool // the chat had a session and the message resumed it
	stopped chan struct{}
}

func newEngHost() *engHost {
	return &engHost{chats: map[string]*engChat{}, costs: map[string]chats.Cost{}, acts: map[string]chats.Activity{}, busy: map[string]bool{}}
}

// restarted is the host after a server restart: the chats and their sessions are there, no
// process is, and nothing was sent yet.
func (h *engHost) restarted() *engHost {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := newEngHost()
	n.on, n.refuse = h.on, h.refuse
	for id, c := range h.chats {
		n.chats[id] = &engChat{spec: c.spec, session: c.session, text: c.text}
	}
	for id, c := range h.costs {
		n.costs[id] = c
	}
	return n
}

func (h *engHost) CreateOwned(s chats.OwnedSpec) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.boom != "" && s.Name == h.boom {
		panic("the chat manager fell over")
	}
	if c, ok := h.chats[s.ID]; ok {
		if c.spec.Run != s.Run || c.spec.Role != s.Role {
			return false, fmt.Errorf("chat %s belongs to another run or role", s.ID)
		}
		return false, nil
	}
	if _, err := os.Stat(s.Cwd); err != nil {
		return false, fmt.Errorf("the folder %s does not exist", s.Cwd)
	}
	h.chats[s.ID] = &engChat{spec: s}
	return true, nil
}

func (h *engHost) SendOwned(id, text string, o chats.OwnedSend) error {
	h.mu.Lock()
	c, ok := h.chats[id]
	if !ok {
		h.mu.Unlock()
		return chats.ErrNotFound
	}
	if gate := h.gate; gate != nil {
		// A send that hangs in the adapter: only closing the process ends it.
		stopped := make(chan struct{})
		c.stopped = stopped
		h.mu.Unlock()
		select {
		case <-gate:
		case <-stopped:
			return errors.New("the process was closed")
		}
		h.mu.Lock()
	}
	if c.wait != nil && !c.wait.set {
		h.mu.Unlock()
		return chats.ErrBusy
	}
	m := &engMsg{h: h, c: c, ID: id, Name: c.spec.Name, Role: c.spec.Role, Cwd: c.spec.Cwd, Text: text, N: c.sent + 1,
		Fresh: o.Fresh, Resumed: c.session && !o.Fresh && !c.process}
	if h.refuse != nil {
		refuse := h.refuse
		h.mu.Unlock()
		if err := refuse(m); err != nil {
			return err
		}
		h.mu.Lock()
	}
	c.session, c.process = true, true
	c.sent++
	m.w = &engWait{done: make(chan struct{})}
	m.stopped = make(chan struct{})
	c.wait, c.stopped = m.w, m.stopped
	h.sends = append(h.sends, m)
	on := h.on
	h.turns.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.turns.Done()
		if on != nil {
			on(m)
		}
		m.settle(chats.Settled{Outcome: chats.EndClean})
	}()
	return nil
}

func (h *engHost) WaitOwned(ctx context.Context, id string) (chats.Settled, error) {
	h.mu.Lock()
	c, ok := h.chats[id]
	var w *engWait
	if ok {
		w = c.wait
	}
	h.mu.Unlock()
	switch {
	case !ok:
		return chats.Settled{}, chats.ErrNotFound
	case w == nil:
		return chats.Settled{}, chats.ErrNothingSent
	}
	select {
	case <-w.done:
		h.mu.Lock()
		defer h.mu.Unlock()
		return w.settled, nil
	case <-ctx.Done():
		return chats.Settled{}, ctx.Err()
	}
}

func (h *engHost) StopOwned(id string, grace time.Duration) {
	h.mu.Lock()
	c, ok := h.chats[id]
	if !ok {
		h.mu.Unlock()
		return
	}
	h.stops = append(h.stops, c.spec.Name)
	c.process = false
	w, stopped := c.wait, c.stopped
	c.stopped = nil
	h.mu.Unlock()
	// The turn ends as aborted before its script can end it any other way.
	if w != nil {
		h.settle(c, w, chats.Settled{Outcome: chats.EndAborted, Error: "stopped"})
	}
	if stopped != nil {
		close(stopped)
	}
}

// closeAll is the chat manager shutting down: every process ends, and a turn that had not ended
// ends as aborted.
func (h *engHost) closeAll() {
	h.mu.Lock()
	type open struct {
		c       *engChat
		w       *engWait
		stopped chan struct{}
	}
	var all []open
	for _, c := range h.chats {
		all = append(all, open{c, c.wait, c.stopped})
		c.process, c.stopped = false, nil
	}
	h.mu.Unlock()
	for _, o := range all {
		if o.w != nil {
			h.settle(o.c, o.w, chats.Settled{Outcome: chats.EndAborted, Error: "stopped"})
		}
		if o.stopped != nil {
			close(o.stopped)
		}
	}
}

func (h *engHost) settle(c *engChat, w *engWait, s chats.Settled) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if w.set {
		return
	}
	w.set, w.settled = true, s
	if s.Outcome == chats.EndClean || s.Text != "" {
		c.text = s.Text
	}
	close(w.done)
}

func (h *engHost) OwnedState(id string) (chats.OwnedState, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c, ok := h.chats[id]
	if !ok {
		return chats.OwnedState{}, chats.ErrNotFound
	}
	return chats.OwnedState{Exists: true, Locked: c.session, HasProcess: c.process, Text: c.text}, nil
}

func (h *engHost) CostOf(id string) (chats.Cost, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.costs[id], nil
}

func (h *engHost) Activity(id string) (chats.Activity, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.acts[id], nil
}

func (h *engHost) Idle(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return !h.busy[id]
}

func (h *engHost) setCost(id string, usd float64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.costs[id] = chats.Cost{USD: usd, Known: true}
}

func (h *engHost) setBusy(id string, busy bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.busy[id] = busy
}

// sent lists the accepted messages to the chat called name, in order.
func (h *engHost) sent(name string) []*engMsg {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []*engMsg
	for _, m := range h.sends {
		if m.Name == name {
			out = append(out, m)
		}
	}
	return out
}

// all lists every accepted message, in order.
func (h *engHost) all() []*engMsg {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]*engMsg(nil), h.sends...)
}

// names lists the chats that got a message, in the order of their first one.
func (h *engHost) names() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	seen := map[string]bool{}
	for _, m := range h.sends {
		if !seen[m.Name] {
			seen[m.Name] = true
			out = append(out, m.Name)
		}
	}
	return out
}

// stopped lists the names StopOwned was called for.
func (h *engHost) stoppedNames() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.stops...)
}

func (m *engMsg) settle(s chats.Settled) { m.h.settle(m.c, m.w, s) }

// Say ends the turn cleanly with text as its last text.
func (m *engMsg) Say(text string) { m.settle(chats.Settled{Outcome: chats.EndClean, Text: text}) }

// Block ends the turn cleanly with a result block.
func (m *engMsg) Block(outcome, summary, report string) {
	m.Say("Done.\n\n" + agenttest.Block(outcome, summary, report))
}

// Fail ends the turn with an error; Exit says the process ended in it. text is what the turn
// had written by then.
func (m *engMsg) Fail(errText, text string) {
	m.settle(chats.Settled{Outcome: chats.EndError, Error: errText, Text: text})
}

func (m *engMsg) Exit(errText string) {
	m.settle(chats.Settled{Outcome: chats.EndExit, Error: errText})
}

// NoSession ends the turn the way Claude says that the session to resume does not exist.
func (m *engMsg) NoSession() {
	m.settle(chats.Settled{Outcome: chats.EndError, NoSession: true, Error: "No conversation found with session ID"})
}

// Hang blocks until the engine stops the agent.
func (m *engMsg) Hang() { <-m.stopped }

// engGates lets a test hold an agent's turn until it says go: a script calls pass first, which
// blocks for the names the test has blocked until open is called or the agent is stopped.
type engGates struct {
	mu sync.Mutex
	ch map[string]chan struct{}
}

func (g *engGates) get(name string, make_ bool) chan struct{} {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ch == nil {
		g.ch = map[string]chan struct{}{}
	}
	c, ok := g.ch[name]
	if !ok && make_ {
		c = make(chan struct{})
		g.ch[name] = c
	}
	return c
}

// block makes the turns of the agents called names wait.
func (g *engGates) block(names ...string) {
	for _, n := range names {
		g.get(n, true)
	}
}

// open lets the agent called name go on, now and from now on.
func (g *engGates) open(name string) {
	c := g.get(name, true)
	select {
	case <-c:
	default:
		close(c)
	}
}

// pass waits for the agent's gate; false when the agent was stopped meanwhile.
func (g *engGates) pass(m *engMsg) bool {
	c := g.get(m.Name, false)
	if c == nil {
		return true
	}
	select {
	case <-c:
		return true
	case <-m.stopped:
		return false
	}
}

// ---- a run for the engine --------------------------------------------------------

// engEnv is a service with the fake chat manager, and when git is asked for a temp repository
// with one commit that runs work in.
type engEnv struct {
	*testEnv
	host  *engHost
	repo  *agenttest.Repo
	gates engGates
}

func newEngEnv(t *testing.T, git bool) *engEnv {
	t.Helper()
	e := &engEnv{testEnv: newTestEnv(t), host: newEngHost()}
	// Paths are compared with what git prints: no symlink in them (/var is /private/var).
	root, err := filepath.EvalSymlinks(filepath.Dir(e.root))
	if err != nil {
		t.Fatal(err)
	}
	e.root = filepath.Join(root, "data")
	if e.cwd, err = filepath.EvalSymlinks(e.cwd); err != nil {
		t.Fatal(err)
	}
	if git {
		e.repo = agenttest.NewRepo(t)
		e.repo.Write("README.md", "the project\n")
		e.repo.Write("f.txt", "one\ntwo\nthree\n")
		e.repo.Commit("first")
		e.cwd = e.repo.Dir()
	}
	e.wire()
	t.Cleanup(func() {
		// Nothing of a run may be left working when its temp folders are removed.
		e.s.eng.quit.Store(true)
		for _, r := range e.s.all() {
			r.stopEngine(20 * time.Second)
		}
		e.host.closeAll()
		e.host.turns.Wait()
	})
	return e
}

// wire makes a fresh Service on the data folder, as a server start does, with the host and the
// git environment.
func (e *engEnv) wire() *Service {
	e.boot()
	e.s.Chats = e.host
	if e.repo != nil {
		e.s.GitEnv = e.repo.Env()
	}
	return e.s
}

// restart is a server that went away without Shutdown and came back: the old service's engines
// are cancelled and write no run_halted (a worker may still record that its agent was
// interrupted, which a real crash would not; the engine treats both records alike), every agent
// process is gone, and the run is read from its folder by a new service. Boot is not called.
func (e *engEnv) restart(id string) *run {
	e.t.Helper()
	old := e.s
	old.eng.quit.Store(true)
	for _, r := range old.all() {
		if !r.stopEngine(20 * time.Second) {
			e.t.Fatal("the old engine did not stop")
		}
	}
	e.host.closeAll()
	e.host.turns.Wait()
	return e.reload(id)
}

// reload is the server's start after the old one is gone: a new chat manager that has the chats
// and their sessions but no process, a new service, and the run read from its folder.
func (e *engEnv) reload(id string) *run {
	e.t.Helper()
	e.host.closeAll()
	e.host.turns.Wait()
	e.host = e.host.restarted()
	e.wire()
	meta, err := readMeta(e.s.Store.P.RunDir(id))
	if err != nil {
		e.t.Fatal(err)
	}
	r := newRun(e.s, meta)
	if err := r.open(); err != nil {
		e.t.Fatal(err)
	}
	e.s.add(r)
	return r
}

// run starts a run the way the service's Start does (leftovers removed, goal.md, entry 1 with
// the git facts, a checkpoint, run.json with Started) and returns it without an engine. mod may
// change the settings first.
func (e *engEnv) run(id string, mod func(m *model.RunMeta)) *run {
	e.t.Helper()
	r := e.draft(id)
	r.meta.Cwd = e.cwd
	r.meta.Name = "the run"
	if mod != nil {
		mod(&r.meta)
	}
	const goal = "Build the thing.\n"
	var g *Git
	if e.repo != nil {
		repo, err := e.s.openRepo(context.Background(), e.cwd)
		if err != nil {
			e.t.Fatal(err)
		}
		base, err := repo.Resolve(context.Background(), "HEAD")
		if err != nil {
			e.t.Fatal(err)
		}
		work := e.s.Store.P.RunWorkDir(id)
		g = &Git{RunGit: model.RunGit{BaseRef: base, IntegrationBranch: "aiwb/" + id + "/integration"}, Repo: repo.Root(),
			Integration: filepath.Join(work, "int"), Orchestrator: filepath.Join(work, "orch")}
		r.meta.Git = true
	}
	if err := removeRecord(r.dir); err != nil {
		e.t.Fatal(err)
	}
	if err := writeGoal(r.dir, goal); err != nil {
		e.t.Fatal(err)
	}
	e.must(r, KRunStarted, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.StartedAt, st.AsOf, st.GoalSize, st.Git = model.RunRunning, tx.Now(), tx.Now(), len(goal), g
		return nil
	})
	if err := r.checkpoint(); err != nil {
		e.t.Fatal(err)
	}
	r.mu.Lock()
	r.meta.Started = e.clock.Now()
	err := writeMeta(r.dir, r.meta)
	r.refreshView()
	r.mu.Unlock()
	if err != nil {
		e.t.Fatal(err)
	}
	return r
}

// The run tools the orchestrator would call, as the entries they make.

// engAdd adds a task in turn n (held by it), with its brief, and returns its id.
func (e *engEnv) add(r *run, turn int, title string, writes bool, deps ...string) string {
	e.t.Helper()
	id := ""
	e.must(r, KOp, func(tx *Tx) error {
		id = TaskID(len(tx.L().Tasks) + 1)
		brief := "Do this: " + title + ".\n"
		t := Task{ID: id, Title: title, Kind: "build", Writes: writes, DependsOn: deps, AddedTurn: turn, CreatedAt: tx.Now(), BriefRev: 1,
			Briefs:   []model.BriefRev{{Rev: 1, At: tx.Now(), Turn: turn, Size: len(brief)}},
			Attempts: []Attempt{{RunAttempt: model.RunAttempt{N: 1, QueuedTurn: turn, QueuedAt: tx.Now()}}}}
		if turn > 0 {
			t.HeldBy = []Holder{{Turn: turn}}
		}
		tx.AddTask(t)
		tx.File(briefRel(id, 1), []byte(brief))
		tx.Head(Entry{Op: "add_task", Task: id, Turn: turn})
		return nil
	})
	return id
}

// engFinish records finish_run.
func (e *engEnv) finishRun(r *run, turn int, outcome model.RunOutcome) {
	e.t.Helper()
	e.must(r, KOp, func(tx *Tx) error {
		tx.State().Result = &model.RunResult{Outcome: outcome, Summary: "all done", Turn: turn, At: tx.Now()}
		tx.Head(Entry{Op: "finish_run", Turn: turn})
		return nil
	})
}

// retry adds a new attempt to a failed or cancelled task, held by turn.
func (e *engEnv) retry(r *run, turn int, tid string) {
	e.t.Helper()
	e.must(r, KOp, func(tx *Tx) error {
		t := tx.Task(tid)
		t.Attempts = append(t.Attempts, Attempt{RunAttempt: model.RunAttempt{N: len(t.Attempts) + 1, QueuedTurn: turn, QueuedAt: tx.Now()}})
		if turn > 0 {
			t.HeldBy = []Holder{{Turn: turn}}
		}
		tx.Head(Entry{Op: "retry_task", Task: tid, Turn: turn})
		return nil
	})
}

// ---- reading a run in a test -----------------------------------------------------

// engPatience bounds a wait of an engine test on the wall clock, as mxWait does in the matrix. What
// is waited for is the run's git work, and how long that takes is the machine's to say: a task
// whose merge goes three rounds is some 200 git commands, each of them 6 ms on a quiet Mac and
// 45 ms and more when other tests start processes next to it (agenttest.SpawnBound). Thirty
// seconds were too few for that when other suites ran on the machine.
const engPatience = mxWait

// engUntil waits until ok is true; it fails the test with what after engPatience.
func engUntil(t testing.TB, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(engPatience)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (r *run) engSt() model.RunStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.L == nil {
		return r.viewNow().Status // read from its checkpoint only
	}
	return r.L.State.Status
}

func (r *run) engState() State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return cloneState(r.L.State)
}

func (r *run) engTaskState(id string) model.TaskState {
	t, ok := r.engTask(id)
	if !ok {
		return ""
	}
	return t.State()
}

func (r *run) engLast(t testing.TB, id string) Attempt {
	t.Helper()
	_, a, err := r.engAttempt(id)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func (r *run) engTurns() []Turn {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Turn(nil), r.L.Turns...)
}

func (r *run) engAgentNamed(name string) (Agent, bool) { return r.engAgent(AgentChatID(r.id, name)) }

func (r *run) engHasEngine() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.eng != nil
}

// engState waits for the run to reach a status.
func engStatus(t testing.TB, r *run, want model.RunStatus) {
	t.Helper()
	engUntil(t, fmt.Sprintf("run status %s (it is %s: %s)", want, r.engSt(), r.engState().Reason), func() bool { return r.engSt() == want })
}

// engTask waits for a task to reach a state.
func engTask(t testing.TB, r *run, id string, want model.TaskState) {
	t.Helper()
	deadline := time.Now().Add(engPatience)
	for r.engTaskState(id) != want {
		if time.Now().After(deadline) {
			tk, _ := r.engTask(id)
			errText := ""
			if n := len(tk.Attempts); n > 0 {
				errText = tk.Attempts[n-1].Error
			}
			t.Fatalf("timed out waiting for %s to be %s: it is %s %s", id, want, r.engTaskState(id), errText)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// kindsOf lists the kinds of a run's journal entries.
func engKinds(t testing.TB, r *run) []EntryKind {
	t.Helper()
	var out []EntryKind
	for _, e := range readEntries(t, r.dir) {
		out = append(out, e.Kind)
	}
	return out
}

func engCount(kinds []EntryKind, k EntryKind) int {
	n := 0
	for _, x := range kinds {
		if x == k {
			n++
		}
	}
	return n
}

// engGit runs git in dir with the repository's environment and fails the test on an error.
func (e *engEnv) git(dir string, args ...string) string {
	e.t.Helper()
	out, err := e.repo.GitIn(dir, args...)
	if err != nil {
		e.t.Fatalf("git %s in %s: %v\n%s", strings.Join(args, " "), dir, err, out)
	}
	return out
}

// writeIn writes a file below dir.
func engWrite(t testing.TB, dir, rel, content string) {
	t.Helper()
	path := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// engRepo opens the run's repository as the engine does.
func (e *engEnv) open() *rungit.Repo {
	e.t.Helper()
	repo, err := e.s.openRepo(context.Background(), e.repo.Dir())
	if err != nil {
		e.t.Fatal(err)
	}
	return repo
}
