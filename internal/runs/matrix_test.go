package runs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// This file is the harness of the test matrix: the run server as main wires it, without a server
// process and without an agent program. The Service, the chat manager and the MCP endpoint are
// the real ones; the agents are agenttest.Fake processes whose scripts call the run tools through
// the real endpoint with their own tokens; the clock is moved by hand; git runs in a temp
// repository. A test can drop the server the way a crash would (at a journal entry of its choice)
// or the way a quit would, and start a new one on the same folders.

// mx is one test's server and what outlives its restarts.
type mx struct {
	t     *testing.T
	root  string          // the test's own temp folder, symlinks resolved
	home  string          // root/aiwb-mx-data
	cwd   string          // the run's folder
	repo  *agenttest.Repo // nil: the run's folder is no repository
	clock *agenttest.Clock
	fakes map[model.AgentKind]*agenttest.Fake
	relay atomic.Pointer[boardapi.Relay]

	chatMu sync.Mutex // makes "find the person's chat or make it" one step

	mu       sync.Mutex
	w        *mxWorld
	worlds   []*mxWorld
	id       string // the run
	script   func(a *mxTurn)
	frozen   bool       // every script blocks at its next step until its process ends
	log      []mxEvent  // spawns, turns, agents recorded done, in the order they happened
	prompts  []mxPrompt // every message a fake got
	spawned  []agent.SpawnOptions
	wrote    map[string]bool // every file a script wrote, by absolute path
	names    map[string]string
	dropAt   int64                // crash when this entry is committed (0 = never)
	trigger  func(l *Loaded) bool // or when this first holds of the recorded state
	quit     bool                 // the trigger asks for a quit, not a crash
	fired    chan struct{}        // closed when dropAt or trigger fired
	snap     string               // the copy of home a crash took
	onEntry  func(l *Loaded)      // sees the state after every entry, with the run's lock held
	noFreeze bool
	still    bool // wait does not move the clock
	gates    map[string]*mxGate
	// sendHook, when set, may replace the process a spawn made (a process whose Send blocks or
	// fails); name is the run agent's name.
	sendHook func(name string, ag agent.Agent) agent.Agent
	// turnRunning, when set, sees every answer of the chat manager's TurnRunning before the
	// service gets it.
	turnRunning func(chat string, running bool)
	// beforeSend, when set, is called with the agent's name before each message of the engine
	// goes to the chat manager; it may block.
	beforeSend func(name string)
	guard      bool     // every turn checks its working directory for files nobody wrote
	had        []string // a plain folder's files before the run
}

// mxGate is a point a script waits at until the test lets it go on.
type mxGate struct {
	at   chan struct{} // closed when a script got there
	open chan struct{} // closed when it may go on
}

func (h *mx) gate(name string) *mxGate {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.gates == nil {
		h.gates = map[string]*mxGate{}
	}
	g := h.gates[name]
	if g == nil {
		g = &mxGate{at: make(chan struct{}), open: make(chan struct{})}
		h.gates[name] = g
	}
	return g
}

// Gate blocks the script until the test opens the gate; false when the turn was interrupted
// first.
func (a *mxTurn) Gate(name string) bool {
	g := a.h.gate(name)
	select {
	case <-g.at:
	default:
		func() {
			a.h.mu.Lock()
			defer a.h.mu.Unlock()
			select {
			case <-g.at:
			default:
				close(g.at)
			}
		}()
	}
	select {
	case <-g.open:
		return a.OK()
	case <-a.Interrupted():
		return false
	}
}

// atGate waits until a script is at the gate.
func (h *mx) atGate(name string) {
	h.t.Helper()
	g := h.gate(name)
	h.wait("an agent to be at "+name, func() bool {
		select {
		case <-g.at:
			return true
		default:
			return false
		}
	})
}

// open lets the scripts at the gate go on, now and later.
func (h *mx) open(names ...string) {
	for _, name := range names {
		g := h.gate(name)
		h.mu.Lock()
		select {
		case <-g.open:
		default:
			close(g.open)
		}
		h.mu.Unlock()
	}
}

// regate makes the gate new: closed, with nobody at it.
func (h *mx) regate(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.gates, name)
}

// mxHost is the chat manager as the service sees it in these tests: itself, with one answer a
// test can watch.
type mxHost struct {
	*chats.Manager
	h       *mx
	sending *atomic.Int32 // the world's
}

func (m mxHost) TurnRunning(id string) bool {
	v := m.Manager.TurnRunning(id)
	m.h.mu.Lock()
	f := m.h.turnRunning
	m.h.mu.Unlock()
	if f != nil {
		f(id, v)
	}
	return v
}

// SendOwned counts the messages that are on their way (see down) and calls beforeSend.
func (m mxHost) SendOwned(id, text string, o chats.OwnedSend) error {
	m.sending.Add(1)
	defer m.sending.Add(-1)
	m.h.mu.Lock()
	f, name := m.h.beforeSend, m.h.names[id]
	m.h.mu.Unlock()
	if f != nil {
		f(name)
	}
	return m.Manager.SendOwned(id, text, o)
}

// mxWorld is one life of the server: from its start to its crash or quit.
type mxWorld struct {
	st   *store.Store
	s    *Service
	cm   *chats.Manager
	dead atomic.Bool
	// sending is the number of the engine's messages that are inside SendOwned.
	sending atomic.Int32
}

type mxEvent struct {
	Kind string // "spawn", "turn", "done"
	Chat string
	Name string
}

type mxPrompt struct {
	Name string
	Text string
}

// mxTurn is one message to a scripted agent, with who the agent is.
type mxTurn struct {
	*agenttest.Turn
	h    *mx
	w    *mxWorld
	Name string          // "turn-001", "T01-work", "T02-merge"; "" for a person's chat and for a subagent
	Role model.AgentRole // "" for a person's chat
	Sub  bool            // an app-spawned subagent
	Task string          // the task of a work or merge agent
	Cwd  string
}

// newMx builds the server on a fresh home. git: the run's folder is a repository with one commit
// that holds shared.txt ("base\n").
func newMx(t *testing.T, git bool) *mx {
	t.Helper()
	if !git {
		return newMxIn(t, nil)
	}
	return newMxIn(t, func(r *agenttest.Repo) {
		r.Write("shared.txt", "base\n")
		r.Write("README.md", "the project\n")
		r.Commit("first")
	})
}

// newMxIn is newMx with the repository prepared by prep; nil: the run's folder is a plain folder.
func newMxIn(t *testing.T, prep func(r *agenttest.Repo)) *mx {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := &mx{t: t, root: root, home: filepath.Join(root, "aiwb-mx-data"), clock: agenttest.NewClock(testStart),
		fakes: map[model.AgentKind]*agenttest.Fake{}, wrote: map[string]bool{}, names: map[string]string{}}
	if prep != nil {
		h.repo = agenttest.NewRepo(t)
		prep(h.repo)
		h.cwd = h.repo.Dir()
	} else {
		h.cwd = filepath.Join(root, "plain-folder")
		if err := os.MkdirAll(h.cwd, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mcp := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rl := h.relay.Load(); rl != nil {
			rl.ServeFixedMCP(w, r)
			return
		}
		http.Error(w, "no server", http.StatusServiceUnavailable)
	})
	for _, k := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		f := agenttest.New(k)
		f.MCP = mcp
		// Long enough that the manager's Send always comes first, as it does with the real
		// process (which takes about a second): a process that is gone before the Send is an
		// ordinary failure with a back-off, not a session that is gone.
		f.NoSessionDelay = 10 * time.Second
		f.Script(h.run)
		h.fakes[k] = f
	}
	h.script = mxRefScript
	h.start()
	t.Cleanup(h.end)
	return h
}

// mxSpawner notes every spawn before the fake makes the process.
type mxSpawner struct {
	h *mx
	f *agenttest.Fake
}

func (s mxSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	s.h.mu.Lock()
	s.h.log = append(s.h.log, mxEvent{Kind: "spawn", Chat: o.ChatID})
	s.h.spawned = append(s.h.spawned, o)
	hook, name := s.h.sendHook, s.h.names[o.ChatID]
	s.h.mu.Unlock()
	ag, err := s.f.Spawn(o)
	if err == nil && hook != nil && !o.Subagent {
		ag = hook(name, ag)
	}
	return ag, err
}

// mxStuck is a process whose Send does not return until the process is closed, as an adapter
// that waits for a handshake that never comes.
type mxStuck struct {
	agent.Agent
	closed chan struct{}
	once   *sync.Once
	in     chan struct{} // closed when a Send is in flight
	inOnce *sync.Once
}

func mxNewStuck(ag agent.Agent) *mxStuck {
	return &mxStuck{Agent: ag, closed: make(chan struct{}), once: &sync.Once{}, in: make(chan struct{}), inOnce: &sync.Once{}}
}

func (a *mxStuck) Send(blocks []agent.ContentBlock) error {
	a.inOnce.Do(func() { close(a.in) })
	<-a.closed
	return errors.New("the agent's process has ended")
}

func (a *mxStuck) Close() {
	a.once.Do(func() { close(a.closed) })
	a.Agent.Close()
}

// mxRefusing is a process that refuses its first message, as Cursor does when a session cannot
// be loaded for another reason than that it is gone.
type mxRefusing struct {
	agent.Agent
	text string
	used *atomic.Bool
}

func (a mxRefusing) Send(blocks []agent.ContentBlock) error {
	if a.used.CompareAndSwap(false, true) {
		return errors.New(a.text)
	}
	return a.Agent.Send(blocks)
}

// start makes a new life of the server on the home as it is: main's order, without Boot.
func (h *mx) start() *mxWorld {
	h.t.Helper()
	st, err := store.Open(store.NewPaths(h.home))
	if err != nil {
		h.t.Fatal(err)
	}
	br := editorbridge.New(nil)
	bds := boards.New(st, br)
	if err := bds.Load(); err != nil {
		h.t.Fatal(err)
	}
	d := Deps{Store: st, Emit: br, DefaultCwd: h.cwd, Clock: h.clock, HaltWait: 20 * time.Second}
	if h.repo != nil {
		d.GitEnv = h.repo.Env()
	}
	rs := New(d)
	spawners := map[model.AgentKind]agent.Spawner{}
	for k, f := range h.fakes {
		spawners[k] = mxSpawner{h, f}
	}
	cm := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bds, Runs: rs, DefaultCwd: h.cwd,
		MCPURL: "http://localhost:6006/mcp", Spawners: spawners})
	if err := rs.Load(); err != nil {
		h.t.Fatal(err)
	}
	if err := cm.Load(); err != nil {
		h.t.Fatal(err)
	}
	w := &mxWorld{st: st, s: rs, cm: cm}
	rs.Chats = mxHost{cm, h, &w.sending}
	h.relay.Store(&boardapi.Relay{Bridge: br, Chats: cm, Boards: bds, Runs: rs})
	h.mu.Lock()
	h.w = w
	h.worlds = append(h.worlds, w)
	id := h.id
	h.mu.Unlock()
	if id != "" {
		h.hook()
	}
	return w
}

// world is the server's current life.
func (h *mx) world() *mxWorld {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.w
}

func (h *mx) s() *Service        { return h.world().s }
func (h *mx) cm() *chats.Manager { return h.world().cm }

// r is the run in the server's current life.
func (h *mx) r() *run {
	h.t.Helper()
	r, err := h.s().run(h.id)
	if err != nil {
		h.t.Fatalf("run %s: %v", h.id, err)
	}
	return r
}

// hook makes the harness see every entry of the run, with the run's lock held.
func (h *mx) hook() {
	r := h.r()
	w := h.world()
	r.mu.Lock()
	r.onDetail = func(ev detailEvent) { h.entry(w, r) }
	r.mu.Unlock()
}

// entry is called after every committed entry, with r.mu held.
func (h *mx) entry(w *mxWorld, r *run) {
	l := r.L
	h.mu.Lock()
	for i := range l.Agents {
		a := &l.Agents[i]
		if a.Status == model.AgentDone && !slices.ContainsFunc(h.log, func(e mxEvent) bool { return e.Kind == "done" && e.Chat == a.ID }) {
			h.log = append(h.log, mxEvent{Kind: "done", Chat: a.ID, Name: a.Name})
		}
		h.names[a.ID] = a.Name
	}
	fire := h.fired != nil && ((h.dropAt != 0 && l.Version >= h.dropAt) || (h.trigger != nil && h.trigger(l)))
	quit, fired, on := h.quit, h.fired, h.onEntry
	if fire {
		h.dropAt, h.trigger, h.fired = 0, nil, nil
		if !h.noFreeze {
			h.frozen = true
		}
	}
	h.mu.Unlock()
	if on != nil {
		on(l)
	}
	if !fire {
		return
	}
	if !quit {
		h.crashLocked(w, r)
	}
	close(fired)
}

// crashLocked is the instant a server dies, with r.mu held: nothing more is written to the run's
// record, the engine's goroutines are told to go without ending any agent, and the home folder
// is copied as it is now (the chats' files too: what a dead server leaves is what was on disk).
func (h *mx) crashLocked(w *mxWorld, r *run) {
	w.dead.Store(true)
	r.gone = true
	w.s.eng.quit.Store(true)
	if r.eng != nil {
		r.eng.stop()
	}
	snap := filepath.Join(h.root, fmt.Sprintf("crash-image-%d", time.Now().UnixNano()))
	if err := mxCopyTree(h.home, snap); err != nil {
		h.t.Errorf("copy the home folder at the crash: %v", err)
	}
	h.mu.Lock()
	h.snap = snap
	h.mu.Unlock()
}

// mxCopyTree copies a folder; a file that goes away while it is read (a temp file of an atomic
// write) is left out.
func mxCopyTree(src, dst string) error {
	return filepath.Walk(src, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		rel, _ := filepath.Rel(src, path)
		if fi.IsDir() {
			return os.MkdirAll(filepath.Join(dst, rel), 0o700)
		}
		if !fi.Mode().IsRegular() {
			return nil
		}
		in, err := os.Open(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(filepath.Join(dst, rel), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, fi.Mode().Perm())
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, in)
		return err
	})
}

// crashAtEntry arms a crash for the moment entry k of the run is committed; crashWhen and
// quitWhen for the first entry after which ok holds of the recorded state. The returned channel
// is closed when it happened: the caller then calls reboot.
func (h *mx) crashAtEntry(k int64) <-chan struct{} { return h.arm(k, nil, false) }

func (h *mx) crashWhen(ok func(l *Loaded) bool) <-chan struct{} { return h.arm(0, ok, false) }
func (h *mx) quitWhen(ok func(l *Loaded) bool) <-chan struct{}  { return h.arm(0, ok, true) }

func (h *mx) arm(k int64, ok func(l *Loaded) bool, quit bool) <-chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.dropAt, h.trigger, h.quit = k, ok, quit
	h.fired = make(chan struct{})
	return h.fired
}

// crash is a crash now.
func (h *mx) crash() {
	h.t.Helper()
	w, r := h.world(), h.r()
	h.mu.Lock()
	h.frozen = true
	h.mu.Unlock()
	r.mu.Lock()
	h.crashLocked(w, r)
	r.mu.Unlock()
	h.reboot(false)
}

// kill is a crash now, without the new start: the test can change what the dead server left
// before it calls boot.
func (h *mx) kill() {
	h.t.Helper()
	w, r := h.world(), h.r()
	h.mu.Lock()
	h.frozen = true
	h.mu.Unlock()
	r.mu.Lock()
	h.crashLocked(w, r)
	r.mu.Unlock()
	h.stopWorld(false)
}

// boot starts the server on the folders as they are, with Boot.
func (h *mx) boot() {
	h.t.Helper()
	h.mu.Lock()
	h.frozen = false
	h.mu.Unlock()
	h.start()
	h.s().Boot()
}

// restartQuit is an orderly quit now and a new start.
func (h *mx) restartQuit() {
	h.t.Helper()
	h.reboot(true)
}

// reboot ends the server's current life and starts the next on the same folders, with Boot. quit:
// the old one goes down as main does (Service.Shutdown, then the chat manager's). Otherwise it
// was dropped by crashLocked: its goroutines are waited for, its processes die, and the home
// folder is put back as it was at the instant of the crash.
func (h *mx) reboot(quit bool) {
	h.t.Helper()
	h.stopWorld(quit)
	h.mu.Lock()
	h.frozen = false
	h.mu.Unlock()
	h.start()
	h.s().Boot()
}

// down ends the chat manager of a server's life, and with it every process of that life, as the
// end of the server's process does. A message of the engine that was on its way when the server
// went can start its process after Shutdown has looked at the chat: the engine does not wait for
// it and the manager does not refuse it (a known defect, see TestQuitWhileAnAgentStarts). So the
// messages on their way are waited for, and what they started is closed too.
func (h *mx) down(w *mxWorld) {
	w.cm.Shutdown()
	for deadline := time.Now().Add(20 * time.Second); w.sending.Load() > 0 && time.Now().Before(deadline); {
		time.Sleep(2 * time.Millisecond)
	}
	for _, f := range h.fakes {
		if f.Live() > 0 {
			w.cm.Shutdown()
			return
		}
	}
}

// stopWorld ends the server's current life.
func (h *mx) stopWorld(quit bool) {
	h.t.Helper()
	old := h.world()
	if quit {
		old.s.Shutdown(20 * time.Second)
	}
	old.dead.Store(true)
	if !old.s.eng.wait(nil, 30*time.Second) {
		h.t.Fatal("the old server's run workers did not return")
	}
	h.down(old)
	h.noProcess("after the old server went")
	old.s.svcFlush()
	h.mu.Lock()
	snap := h.snap
	h.snap = ""
	h.mu.Unlock()
	if !quit && snap != "" {
		// The dead server's chat manager still records the ends of its processes: the home folder
		// is put back when it has done that, so that nothing of it lands in the crash image.
		h.settled(old)
		var err error
		for i := 0; i < 200; i++ {
			if err = os.RemoveAll(h.home); err == nil {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		if err != nil {
			h.t.Fatal(err)
		}
		if err := os.Rename(snap, h.home); err != nil {
			h.t.Fatal(err)
		}
	}
}

// settled waits until a chat manager whose processes have ended has taken note of every end.
func (h *mx) settled(w *mxWorld) {
	h.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		busy := 0
		people, agents := w.cm.ChatsOfRun(h.id)
		for _, c := range agents {
			if st, err := w.cm.OwnedState(c.ID); err == nil && st.HasProcess {
				busy++
			}
		}
		for _, c := range people {
			if w.cm.Busy(c.ID) {
				busy++
			}
		}
		if busy == 0 {
			return
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("%d chats of the old server still have a process", busy)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// noProcess waits until no scripted process is alive.
func (h *mx) noProcess(when string) {
	h.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		n := 0
		for _, f := range h.fakes {
			n += f.Live()
		}
		if n == 0 {
			return
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("%d agent processes are alive %s: %s\n%s", n, when, h.liveNames(), h.dump())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// liveNames names the agents whose scripted processes are alive.
func (h *mx) liveNames() string {
	var out []string
	for _, f := range h.fakes {
		for _, o := range f.LiveSpawns() {
			h.mu.Lock()
			name := h.names[o.ChatID]
			h.mu.Unlock()
			out = append(out, fmt.Sprintf("%s (chat %s, session %s, resume %v)", name, o.ChatID, o.SessionID, o.Resume))
		}
	}
	sort.Strings(out)
	return strings.Join(out, "; ")
}

// end is every test's last act: the server goes down as main does, and then nothing of it may be
// left: no agent process, no engine goroutine in any of its lives.
func (h *mx) end() {
	w := h.world()
	if !w.dead.Load() {
		w.s.Shutdown(20 * time.Second)
		w.dead.Store(true)
		h.down(w)
	}
	h.mu.Lock()
	h.frozen = false
	worlds := slices.Clone(h.worlds)
	h.mu.Unlock()
	deadline := time.Now().Add(20 * time.Second)
	for {
		n := 0
		for _, f := range h.fakes {
			n += f.Live()
		}
		engines := 0
		for _, w := range worlds {
			w.s.eng.mu.Lock()
			engines += len(w.s.eng.active)
			w.s.eng.mu.Unlock()
		}
		if n == 0 && engines == 0 {
			break
		}
		if time.Now().After(deadline) {
			h.t.Errorf("left at the end of the test: %d agent processes (%s), %d engines", n, h.liveNames(), engines)
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	for _, w := range worlds {
		w.s.svcFlush()
	}
}

// ---- the run ---------------------------------------------------------------------------------

const mxGoal = "Write the two lines, report on them, and do what the chat asks.\n"

// newRun makes a draft run on the harness's folder; set may change its settings (also the ones
// the composer does not offer).
func (h *mx) newRun(set func(m *model.RunMeta)) string {
	h.t.Helper()
	s := h.s()
	v, err := s.Create(model.Ungrouped, "")
	if err != nil {
		h.t.Fatal(err)
	}
	h.mu.Lock()
	h.id = v.ID
	h.mu.Unlock()
	cwd := h.cwd
	if _, err := s.Patch(v.ID, PatchReq{Cwd: &cwd}); err != nil {
		h.t.Fatal(err)
	}
	if set != nil {
		if err := s.svcSetMeta(h.r(), func(m *model.RunMeta) error { set(m); return nil }); err != nil {
			h.t.Fatal(err)
		}
	}
	h.hook()
	return v.ID
}

// begin starts the run: the goal is sent.
func (h *mx) begin() {
	h.t.Helper()
	if _, err := h.s().Start(h.id, mxGoal); err != nil {
		h.t.Fatalf("start: %v", err)
	}
}

// startRun is newRun and begin.
func (h *mx) startRun(set func(m *model.RunMeta)) string {
	h.t.Helper()
	id := h.newRun(set)
	h.begin()
	return id
}

// L is the run's recorded state now.
func (h *mx) L() *Loaded {
	h.t.Helper()
	return svcState(h.t, h.r())
}

func (h *mx) view() model.RunView { return h.r().viewNow() }

// task is a task as recorded now, and its current attempt.
func (h *mx) task(id string) (Task, Attempt) {
	h.t.Helper()
	l := h.L()
	for _, t := range l.Tasks {
		if t.ID == id {
			if len(t.Attempts) == 0 {
				return t, Attempt{}
			}
			return t, t.Attempts[len(t.Attempts)-1]
		}
	}
	h.t.Fatalf("no task %s", id)
	return Task{}, Attempt{}
}

// agent is the record of the agent called name; ok false when the run has none.
func mxAgent(l *Loaded, name string) (Agent, bool) {
	for _, a := range l.Agents {
		if a.Name == name {
			return a, true
		}
	}
	return Agent{}, false
}

func mxTask(l *Loaded, id string) (Task, bool) {
	if l == nil {
		return Task{}, false
	}
	for _, t := range l.Tasks {
		if t.ID == id {
			return t, true
		}
	}
	return Task{}, false
}

// mxByTitle finds a task by its title.
func mxByTitle(l *Loaded, title string) (Task, bool) {
	if l == nil {
		return Task{}, false
	}
	for _, t := range l.Tasks {
		if t.Title == title {
			return t, true
		}
	}
	return Task{}, false
}

func mxState(l *Loaded, id string) model.TaskState {
	if t, ok := mxTask(l, id); ok {
		return t.State()
	}
	return ""
}

// wait blocks until ok holds, for at most mxWait of the wall clock. Unless h.still is set it
// moves the service's clock half a second ahead at every look, so the scheduler's tick, the
// ticker and a back-off go by; a test that measures the clock sets h.still and moves it itself.
func (h *mx) wait(what string, ok func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(mxWait)
	for !ok() {
		if time.Now().After(deadline) {
			h.t.Fatalf("timed out waiting for %s\n%s", what, h.dump())
		}
		h.mu.Lock()
		still := h.still
		h.mu.Unlock()
		if !still {
			h.clock.Advance(500 * time.Millisecond)
		}
		time.Sleep(3 * time.Millisecond)
	}
}

// mxWait bounds every wait on the wall clock.
const mxWait = 90 * time.Second

// waitL waits until ok holds of the recorded state.
func (h *mx) waitL(what string, ok func(l *Loaded) bool) *Loaded {
	h.t.Helper()
	var got *Loaded
	skipped := 0
	h.wait(what, func() bool {
		// The record is copied whole: while its version stands it is looked at again only now
		// and then, for what ok may see beside the record.
		if got != nil && skipped < 20 && h.version() == got.Version {
			skipped++
			return false
		}
		skipped = 0
		got = h.L()
		return ok(got)
	})
	return got
}

// version is the version of the run's record as loaded now; -1 when it is not loaded.
func (h *mx) version() int64 {
	r, err := h.s().run(h.id)
	if err != nil {
		return -1
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.L == nil {
		return -1
	}
	return r.L.Version
}

// waitStatus waits for the run's status.
func (h *mx) waitStatus(want ...model.RunStatus) *Loaded {
	h.t.Helper()
	return h.waitL(fmt.Sprintf("the run to be %v", want), func(l *Loaded) bool { return slices.Contains(want, l.State.Status) })
}

// waitTask waits for a task's state.
func (h *mx) waitTask(id string, want ...model.TaskState) *Loaded {
	h.t.Helper()
	return h.waitL(fmt.Sprintf("%s to be %v", id, want), func(l *Loaded) bool { return slices.Contains(want, mxState(l, id)) })
}

// tick moves the clock and gives the goroutines woken by it a moment.
func (h *mx) tick(d time.Duration) {
	h.clock.Advance(d)
	time.Sleep(5 * time.Millisecond)
}

// dump is the run as a failed wait shows it: its status, tasks, agents and the journal's tail.
func (h *mx) dump() string {
	var b strings.Builder
	w := h.world()
	r, err := w.s.run(h.id)
	if err != nil {
		return "no run: " + err.Error()
	}
	if r.load() != nil {
		return "the run is not started"
	}
	r.mu.Lock()
	l := r.L.snapshot()
	eng := r.eng != nil
	r.mu.Unlock()
	fmt.Fprintf(&b, "run %s: %s (%s) v%d, engine %v, result %v, inbox %d, idle streak %d\n", h.id, l.State.Status, l.State.Reason,
		l.Version, eng, l.State.Result != nil, len(l.State.Inbox), l.State.IdleStreak)
	for _, t := range l.Tasks {
		fmt.Fprintf(&b, "  %s %q %s held %v", t.ID, t.Title, t.State(), t.HeldBy)
		if n := len(t.Attempts); n > 0 {
			a := t.Attempts[n-1]
			fmt.Fprintf(&b, " a%d setup %v work %v head %.8s merged %.8s round %d/%d err %q", a.N, a.SetupDone, a.WorkDone, a.Head, a.Merged,
				a.MergeAgentDone, a.MergeRound, a.Error)
		}
		b.WriteByte('\n')
	}
	for _, t := range l.Turns {
		fmt.Fprintf(&b, "  turn %d %s %s idle %v err %q\n", t.N, t.Reason, t.Status, t.Idle, t.Error)
	}
	for _, a := range l.Agents {
		fmt.Fprintf(&b, "  agent %s %s launches %d failures %d resumable %v err %q\n", a.Name, a.Status, len(a.Launches), a.Failures, a.Resumable, a.Error)
	}
	es, _, _, _ := readJournal(r.dir, 0)
	for _, e := range es[max(0, len(es)-12):] {
		fmt.Fprintf(&b, "  v%d %s turn %d task %s op %s %s\n", e.V, e.Kind, e.Turn, e.Task, e.Op, e.Error)
	}
	return b.String()
}

// ---- the scripted agents -----------------------------------------------------------------------

var mxAgentName = regexp.MustCompile(`^(T\d+)(?:-a\d+)?-(work|merge(?:-r\d+)?)$`)

// run is the script of every fake: it finds out who the agent is and hands the turn to the
// test's script.
func (h *mx) run(t *agenttest.Turn) {
	w := h.world()
	a := &mxTurn{Turn: t, h: h, w: w, Cwd: t.Opts.Cwd, Sub: t.Opts.Subagent}
	if !a.Sub {
		if meta, ok := h.agentChat(w, t.Opts.ChatID); ok {
			a.Name, a.Role = meta.Name, meta.Role
			if m := mxAgentName.FindStringSubmatch(a.Name); m != nil {
				a.Task = m[1]
			}
		}
	}
	h.mu.Lock()
	h.log = append(h.log, mxEvent{Kind: "turn", Chat: t.Opts.ChatID, Name: a.Name})
	h.prompts = append(h.prompts, mxPrompt{Name: a.Name, Text: t.Text})
	script, guard := h.script, h.guard
	h.mu.Unlock()
	if guard {
		for _, f := range h.strangers(a.Cwd) {
			h.t.Errorf("agent %q found %s in its working directory %s: no agent wrote it and it is not the repository's", a.Name, f, a.Cwd)
		}
	}
	if !a.OK() || script == nil {
		return
	}
	script(a)
}

// strangers lists the files below dir that neither belong to the folder as the run found it (the
// files git tracks there; in a plain folder the files it had) nor were written by a scripted
// agent.
func (h *mx) strangers(dir string) []string {
	known := map[string]bool{}
	if h.repo != nil {
		out, err := h.repo.GitIn(dir, "ls-files", "--full-name")
		if err != nil {
			return []string{"(git ls-files failed: " + out + ")"}
		}
		top, _ := h.repo.GitIn(dir, "rev-parse", "--show-toplevel")
		for _, f := range strings.Split(out, "\n") {
			known[filepath.Join(top, f)] = true
		}
	}
	h.mu.Lock()
	for f := range h.wrote {
		known[f] = true
	}
	for _, f := range h.had {
		known[filepath.Join(h.cwd, f)] = true
	}
	h.mu.Unlock()
	var bad []string
	filepath.Walk(dir, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if fi.Name() == ".git" {
			if fi.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !fi.IsDir() && !known[path] {
			bad = append(bad, path)
		}
		return nil
	})
	// An agent that shares the folder may have written a file after the list above was taken and
	// before the walk came to it: a file is recorded before it exists, so the record is there now.
	h.mu.Lock()
	bad = slices.DeleteFunc(bad, func(f string) bool { return h.wrote[f] })
	h.mu.Unlock()
	return bad
}

// mxFiles lists the files below dir, as paths relative to it; skip names folders to leave out.
func mxFiles(t testing.TB, dir string, skip ...string) []string {
	t.Helper()
	var out []string
	err := filepath.Walk(dir, func(path string, fi os.FileInfo, err error) error {
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		rel, _ := filepath.Rel(dir, path)
		if fi.IsDir() {
			if slices.Contains(skip, rel) {
				return filepath.SkipDir
			}
			return nil
		}
		out = append(out, rel)
		return nil
	})
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	sort.Strings(out)
	return out
}

// agentChat finds the run agent whose chat id is; ok false for a person's chat.
func (h *mx) agentChat(w *mxWorld, id string) (model.ChatMeta, bool) {
	_, agents := w.cm.ChatsOfRun(h.id)
	for _, m := range agents {
		if m.ID == id {
			return m, true
		}
	}
	return model.ChatMeta{}, false
}

// OK reports whether the script may go on: false once the turn was interrupted or its process
// ended. While the harness is frozen (the server is about to go) it blocks until then.
func (a *mxTurn) OK() bool {
	select {
	case <-a.Interrupted():
		return false
	default:
	}
	a.h.mu.Lock()
	frozen := a.h.frozen
	a.h.mu.Unlock()
	if frozen || a.w.dead.Load() {
		a.Hang()
		return false
	}
	return true
}

// Write writes a file in the agent's working directory, as a Write tool would.
func (a *mxTurn) Write(rel, content string) {
	if !a.OK() {
		return
	}
	path := filepath.Join(a.Cwd, rel)
	a.h.mu.Lock()
	a.h.wrote[path] = true // before the file exists: another agent's guard may look at once
	a.h.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		a.h.t.Errorf("agent %s: %v", a.Name, err)
		return
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		a.h.t.Errorf("agent %s: %v", a.Name, err)
		return
	}
	a.Tool("Write", map[string]any{"file_path": path}, "written", false)
}

// Read reads a file of the agent's working directory; "" when there is none.
func (a *mxTurn) Read(rel string) string {
	b, _ := os.ReadFile(filepath.Join(a.Cwd, rel))
	return string(b)
}

// Done ends the agent's answer with a result block.
func (a *mxTurn) Done(summary string) {
	if a.OK() {
		a.Say("Done.\n\n" + agenttest.Block("completed", summary, "# Report\n\n"+summary))
	}
}

// State is the run's recorded state as the server of this turn has it; nil when it is gone.
func (a *mxTurn) State() *Loaded {
	r, err := a.w.s.run(a.h.id)
	if err != nil || a.w.dead.Load() {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.L == nil {
		return nil
	}
	return r.L.snapshot()
}

// Until blocks until ok holds of the run's state; false when the turn was interrupted first.
func (a *mxTurn) Until(ok func(l *Loaded) bool) bool {
	for {
		if !a.OK() {
			return false
		}
		if l := a.State(); l != nil && ok(l) {
			return true
		}
		select {
		case <-a.Interrupted():
			return false
		case <-time.After(3 * time.Millisecond):
		}
	}
}

// The titles of the reference run's tasks: the scripts know a task by its title.
const (
	mxOne    = "Write line one"
	mxTwo    = "Write line two"
	mxReport = "Report on the lines"
	mxFourth = "Write the chat's file"
	mxAsk    = "Please add the fourth task."
)

// mxBrief is a brief long enough for add_task.
func mxBrief(what string) string {
	return what + " Keep to this file and report what you did, with the evidence, when you are done."
}

// mxRefScript is the reference run: the orchestrator adds two writing tasks that change the same
// line of shared.txt (so the second to merge conflicts and a merge agent runs) and a reporting
// task that depends on both; while the reporting task works, a person's chat on the run adds a
// fourth task through the run tools; the orchestrator finishes when all four are done. Every
// agent does only what is still missing, so a turn that is run again after a restart ends the
// same.
func mxRefScript(a *mxTurn) {
	switch {
	case a.Sub:
		a.Say("Looked.")
	case a.Role == model.RoleOrchestrator:
		mxRefOrchestrator(a)
	case a.Role == model.RoleMerge:
		mxRefMerge(a)
	case a.Role == model.RoleTask:
		mxRefTask(a)
	default:
		mxRefChat(a)
	}
}

func mxRefOrchestrator(a *mxTurn) {
	a.Cost(0.02, 20, 20)
	l := a.State()
	if l == nil {
		return
	}
	a.Call("get_run", map[string]any{})
	if _, ok := mxByTitle(l, mxReport); !ok {
		if len(l.Notes) == 0 {
			a.Call("set_notes", map[string]any{"notes": "Done means: shared.txt has both lines and the report exists."})
		}
		ids := map[string]string{}
		for _, title := range []string{mxOne, mxTwo} {
			if !a.OK() {
				return
			}
			if t, ok := mxByTitle(a.State(), title); ok {
				ids[title] = t.ID
				continue
			}
			text, isErr := a.Call("add_task", map[string]any{"title": title, "kind": "implement", "writes": true, "tier": "standard", "tier_reason": "A test task.",
				"brief": mxBrief("Put your line into shared.txt in place of the line that says base.")})
			if isErr {
				a.Say("add_task was refused: " + text)
				return
			}
			if t, ok := mxByTitle(a.State(), title); ok {
				ids[title] = t.ID
			}
		}
		if !a.OK() {
			return
		}
		if text, isErr := a.Call("add_task", map[string]any{"title": mxReport, "kind": "review", "writes": false, "tier": "standard", "tier_reason": "A test task.",
			"depends_on": []string{ids[mxOne], ids[mxTwo]}, "brief": mxBrief("Read shared.txt and report what is in it.")}); isErr {
			a.Say("add_task was refused: " + text)
			return
		}
		a.Say("Three tasks planned.")
		return
	}
	done := 0
	for _, t := range l.Tasks {
		if t.State() == model.TaskDone {
			done++
		}
	}
	if _, ok := mxByTitle(l, mxFourth); ok && done == len(l.Tasks) && done >= 4 {
		if text, isErr := a.Call("finish_run", map[string]any{"outcome": "achieved", "summary": "Both lines are in and the report exists."}); isErr {
			a.Say("finish_run was refused: " + text)
			return
		}
		a.Say("The run is finished.")
		return
	}
	a.Say("Nothing to change yet.")
}

func mxRefTask(a *mxTurn) {
	a.Cost(0.01, 10, 10)
	l := a.State()
	if l == nil {
		return
	}
	t, _ := mxTask(l, a.Task)
	switch t.Title {
	case mxOne, mxTwo:
		line := "line of " + t.ID + "\n"
		old := a.Read("shared.txt")
		switch {
		case strings.Contains(old, line):
		case old == "base\n":
			a.Write("shared.txt", line)
		default:
			a.Write("shared.txt", old+line)
		}
		a.Write(strings.ToLower(t.ID)+".txt", "the own file of "+t.ID+"\n")
		a.Done("Put the line of " + t.ID + " into shared.txt.")
	case mxReport:
		// The person's chat adds the fourth task while this one works.
		if !a.Until(func(l *Loaded) bool {
			if _, ok := mxByTitle(l, mxFourth); ok {
				return true
			}
			a.h.askChat(a.w)
			return false
		}) {
			return
		}
		a.Done("shared.txt holds: " + strings.TrimSpace(a.Read("shared.txt")))
	case mxFourth:
		a.Write("chat.txt", "what the chat asked for\n")
		a.Done("Wrote chat.txt.")
	default:
		a.Done("Nothing to do.")
	}
}

// mxRefMerge resolves the conflict in shared.txt: every task's line, once, in order.
func mxRefMerge(a *mxTurn) {
	a.Cost(0.03, 30, 30)
	a.Write("shared.txt", mxResolved(a.Read("shared.txt")))
	a.Done("Kept both lines.")
}

// mxResolved is a conflicted shared.txt with every side's lines and no marker.
func mxResolved(conflicted string) string {
	var lines []string
	for _, line := range strings.Split(conflicted, "\n") {
		if strings.HasPrefix(line, "line of ") && !slices.Contains(lines, line) {
			lines = append(lines, line)
		}
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n") + "\n"
}

func mxRefChat(a *mxTurn) {
	if !strings.Contains(a.Text, mxAsk) {
		a.Say("Hello.")
		return
	}
	a.Call("get_run", map[string]any{})
	l := a.State()
	if l == nil {
		return
	}
	if _, ok := mxByTitle(l, mxFourth); !ok {
		if text, isErr := a.Call("add_task", map[string]any{"title": mxFourth, "kind": "implement", "writes": true, "tier": "standard", "tier_reason": "A test task.",
			"brief": mxBrief("Write chat.txt with one line in it.")}); isErr {
			a.Say("add_task was refused: " + text)
			return
		}
	}
	a.Say("The fourth task is added.")
}

// askChat makes the person's chat on the run (once) and asks it for the fourth task, unless it
// is answering already. A script calls it again and again until the task exists.
func (h *mx) askChat(w *mxWorld) {
	if w.dead.Load() {
		return
	}
	id := h.personChat(w)
	if id == "" || w.cm.Busy(id) {
		return
	}
	w.cm.Send(id, mxAsk, "", nil)
}

// personChat is the id of the person's chat on the run, made when there is none.
func (h *mx) personChat(w *mxWorld) string {
	// Not h.mu: the chat manager spawns with a chat's lock held, and the spawner takes h.mu.
	h.chatMu.Lock()
	defer h.chatMu.Unlock()
	people, _ := w.cm.ChatsOfRun(h.id)
	if len(people) > 0 {
		return people[0].ID
	}
	v, err := w.cm.CreateOnRun(model.Claude, h.id)
	if err != nil {
		if !w.dead.Load() {
			h.t.Errorf("a chat on the run: %v", err)
		}
		return ""
	}
	return v.ID
}

// ---- what a finished reference run must look like ---------------------------------------------

// mxEnd is what the reference run left, for comparing a restarted run with an uninterrupted one.
type mxEnd struct {
	Status  model.RunStatus
	Outcome model.RunOutcome
	Tasks   map[string]model.TaskState // by title
	Files   map[string]string          // the result's files
	// Delivery is the state and reason of the delivery; Folder is what the person's folder holds
	// afterwards (the files git knows there).
	Delivery string
	Folder   map[string]string
}

// refEnd checks the end of a reference run and returns what it left: completed and achieved,
// every task done, both lines in shared.txt of the result with no conflict marker, no agent that
// was recorded done launched again, no checkout and no work-tree record left, the result applied
// to the person's folder (its HEAD is the result, its status is clean, and the run's branches
// that are in the result are gone), and the journal readable to its end.
func (h *mx) refEnd() mxEnd {
	h.t.Helper()
	l := h.waitStatus(model.RunCompleted, model.RunGaveUp, model.RunStalled, model.RunError)
	if l.State.Status != model.RunCompleted || l.State.Result == nil || l.State.Result.Outcome != model.Achieved {
		h.t.Fatalf("the run ended %s (%s)\n%s", l.State.Status, l.State.Reason, h.dump())
	}
	end := mxEnd{Status: l.State.Status, Outcome: l.State.Result.Outcome, Tasks: map[string]model.TaskState{}, Files: map[string]string{}}
	for _, t := range l.Tasks {
		end.Tasks[t.Title] = t.State()
		if t.State() != model.TaskDone {
			h.t.Errorf("%s (%s) ended %s", t.ID, t.Title, t.State())
		}
	}
	for _, title := range []string{mxOne, mxTwo, mxReport, mxFourth} {
		if _, ok := end.Tasks[title]; !ok {
			h.t.Errorf("no task %q", title)
		}
	}
	for _, tn := range l.Turns {
		if tn.Status != "done" {
			h.t.Errorf("turn %d is %s", tn.N, tn.Status)
		}
	}
	for _, a := range l.Agents {
		if a.Status == model.AgentRunning {
			h.t.Errorf("agent %s is still recorded as running", a.Name)
		}
	}
	h.noRelaunchOfDone()
	h.journalWhole()
	if h.repo != nil {
		ib := h.resultRef()
		for _, f := range strings.Fields(h.repo.Git("ls-tree", "-r", "--name-only", ib)) {
			end.Files[f] = h.repo.Git("show", ib+":"+f)
		}
		one, _ := mxByTitle(l, mxOne)
		two, _ := mxByTitle(l, mxTwo)
		shared := end.Files["shared.txt"]
		if !strings.Contains(shared, "line of "+one.ID) || !strings.Contains(shared, "line of "+two.ID) || strings.Contains(shared, "base") {
			h.t.Errorf("shared.txt on the integration branch:\n%s", shared)
		}
		for f, text := range end.Files {
			if strings.Contains(text, "<<<<<<<") || strings.Contains(text, ">>>>>>>") || strings.Contains(text, "=======") {
				h.t.Errorf("%s has a conflict marker:\n%s", f, text)
			}
		}
		if _, ok := end.Files["chat.txt"]; !ok {
			h.t.Errorf("chat.txt is not on the integration branch: %v", end.Files)
		}
		if l.State.Git.ResultHead != h.repo.Git("rev-parse", ib) {
			h.t.Errorf("the result's head %s is not the integration branch's", l.State.Git.ResultHead)
		}
		h.noCheckouts()
		end.Delivery, end.Folder = h.delivered(l), map[string]string{}
		for _, f := range strings.Fields(h.repo.Git("ls-files")) {
			b, _ := os.ReadFile(filepath.Join(h.repo.Dir(), f))
			end.Folder[f] = strings.TrimRight(string(b), "\n")
		}
	}
	h.noAgentProcess("when the run is finished")
	return end
}

// noAgentProcess checks that no process of a run agent is alive: the chats people have on the
// run keep their agents, as every chat does, so those are ended first.
func (h *mx) noAgentProcess(when string) {
	h.t.Helper()
	people, _ := h.cm().ChatsOfRun(h.id)
	for _, c := range people {
		h.cm().Stop(c.ID)
	}
	h.noProcess(when)
}

// noRelaunchOfDone checks that no agent got a process or a message after it was recorded done.
func (h *mx) noRelaunchOfDone() {
	h.t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	done := map[string]string{}
	for _, e := range h.log {
		switch {
		case e.Kind == "done":
			done[e.Chat] = e.Name
		case done[e.Chat] != "":
			h.t.Errorf("agent %s got a %s after it was recorded done", done[e.Chat], e.Kind)
		}
	}
}

// journalWhole checks that the journal can be read to its end and that its versions rise by one.
func (h *mx) journalWhole() []Entry {
	h.t.Helper()
	es, _, torn, err := readJournal(h.r().dir, 0)
	if err != nil || torn {
		h.t.Fatalf("the journal: torn %v, %v", torn, err)
	}
	for i, e := range es {
		if e.V != int64(i+1) {
			h.t.Fatalf("journal entry %d has version %d", i+1, e.V)
		}
	}
	return es
}

// noCheckouts checks that the repository lists no work tree but its own and that the folder of
// the run's checkouts is empty or gone.
func (h *mx) noCheckouts() {
	h.t.Helper()
	if list := h.repo.Git("worktree", "list", "--porcelain"); strings.Count(list, "worktree ") != 1 {
		h.t.Errorf("work trees left:\n%s", list)
	}
	ents, _ := os.ReadDir(h.world().st.P.RunWorkDir(h.id))
	if len(ents) > 0 {
		var names []string
		for _, e := range ents {
			names = append(names, e.Name())
		}
		h.t.Errorf("checkouts left: %v", names)
	}
}

// branches lists the repository's branches.
func (h *mx) branches() []string {
	h.t.Helper()
	return strings.Fields(h.repo.Git("for-each-ref", "--format=%(refname:short)", "refs/heads"))
}

// spawnsOf counts the processes started for the agent called name.
func (h *mx) spawnsOf(name string) int {
	id := AgentChatID(h.id, name)
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, e := range h.log {
		if e.Kind == "spawn" && e.Chat == id {
			n++
		}
	}
	return n
}

// turnsOf counts the messages the agent called name got.
func (h *mx) turnsOf(name string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, e := range h.log {
		if e.Kind == "turn" && e.Name == name {
			n++
		}
	}
	return n
}

// promptsOf is every message the agent called name got.
func (h *mx) promptsOf(name string) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, p := range h.prompts {
		if p.Name == name {
			out = append(out, p.Text)
		}
	}
	return out
}

// setScript replaces the script of every agent.
func (h *mx) setScript(s func(a *mxTurn)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.script = s
}

// mcp makes one MCP request with a token, as an agent's process does.
func (h *mx) mcp(token, method string, params any) (result map[string]any) {
	h.t.Helper()
	return mxRPC(h.t, h.relay.Load(), token, method, params)
}

// spawnsWith are the options of every process started for the agent called name.
func (h *mx) spawnsWith(name string) []agent.SpawnOptions {
	id := AgentChatID(h.id, name)
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []agent.SpawnOptions
	for _, o := range h.spawned {
		if o.ChatID == id && !o.Subagent {
			out = append(out, o)
		}
	}
	return out
}

// token is the MCP token of the run agent called name.
func (h *mx) token(name string) string {
	h.t.Helper()
	_, agents := h.cm().ChatsOfRun(h.id)
	for _, m := range agents {
		if m.Name == name {
			return m.Token
		}
	}
	h.t.Fatalf("no chat of agent %s", name)
	return ""
}

// call makes a tools/call with a token and returns the tool's text and whether it is an error.
func (h *mx) call(token, tool string, args any) (string, bool) {
	h.t.Helper()
	return mxCallText(h.mcp(token, "tools/call", map[string]any{"name": tool, "arguments": args}))
}

// newChat makes a person's chat on the run and returns its id and token.
func (h *mx) newChat() (id, token string) {
	h.t.Helper()
	v, err := h.cm().CreateOnRun(model.Claude, h.id)
	if err != nil {
		h.t.Fatal(err)
	}
	people, _ := h.cm().ChatsOfRun(h.id)
	for _, m := range people {
		if m.ID == v.ID {
			return m.ID, m.Token
		}
	}
	h.t.Fatal("the new chat is not listed")
	return "", ""
}

// ctx is a context for a test's own git reads.
func mxCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	return ctx
}

// mxRPC posts one JSON-RPC request to the MCP endpoint with a bearer token and returns its result.
func mxRPC(t testing.TB, relay *boardapi.Relay, token, method string, params any) map[string]any {
	t.Helper()
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	relay.ServeFixedMCP(w, req)
	var out struct {
		Result map[string]any `json:"result"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &out) != nil || out.Result == nil {
		t.Fatalf("%s: status %d, body %s", method, w.Code, w.Body.String())
	}
	return out.Result
}

// mxList is the tool names of a tools/list answer, in the server's order.
func mxList(res map[string]any) []string {
	names := []string{}
	tools, _ := res["tools"].([]any)
	for _, tl := range tools {
		if m, ok := tl.(map[string]any); ok {
			name, _ := m["name"].(string)
			names = append(names, name)
		}
	}
	return names
}

// mxCallText is the text and the error mark of a tools/call answer.
func mxCallText(res map[string]any) (string, bool) {
	isErr, _ := res["isError"].(bool)
	var parts []string
	content, _ := res["content"].([]any)
	for _, c := range content {
		if m, ok := c.(map[string]any); ok {
			text, _ := m["text"].(string)
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n"), isErr
}

// ---- scripts made of parts ----------------------------------------------------------------------

// mxPlan is a script made of parts; a part that is nil does the least that keeps the run going.
type mxPlan struct {
	Turn  func(a *mxTurn, n int)  // the orchestrator's turn n
	Task  func(a *mxTurn, t Task) // a work agent, with its task
	Merge func(a *mxTurn, t Task)
	Chat  func(a *mxTurn)
	Sub   func(a *mxTurn)
}

func (p mxPlan) script(a *mxTurn) {
	switch {
	case a.Sub:
		if p.Sub != nil {
			p.Sub(a)
			return
		}
		a.Say("Looked.")
	case a.Role == model.RoleOrchestrator:
		if p.Turn != nil {
			n := 0
			fmt.Sscanf(a.Name, "turn-%d", &n)
			p.Turn(a, n)
			return
		}
		a.Say("Nothing to change.")
	case a.Role == model.RoleTask, a.Role == model.RoleMerge:
		t, _ := mxTask(a.State(), a.Task)
		switch {
		case a.Role == model.RoleMerge && p.Merge != nil:
			p.Merge(a, t)
		case a.Role == model.RoleMerge:
			mxRefMerge(a)
		case p.Task != nil:
			p.Task(a, t)
		default:
			a.Done("Did " + t.ID + ".")
		}
	default:
		if p.Chat != nil {
			p.Chat(a)
			return
		}
		a.Say("Hello.")
	}
}

// plan sets a script made of parts.
func (h *mx) plan(p mxPlan) { h.setScript(p.script) }

var mxAdded = regexp.MustCompile(`^Added (T\d+)`)

// Add calls add_task and returns the new task's id; "" and the refusal when it was refused.
func (a *mxTurn) Add(title string, writes bool, deps ...string) (id, refusal string) {
	args := map[string]any{"title": title, "kind": "implement", "writes": writes, "tier": "standard", "tier_reason": "A test task.", "brief": mxBrief("Do: " + title + ".")}
	if len(deps) > 0 {
		args["depends_on"] = deps
	}
	text, isErr := a.Call("add_task", args)
	if isErr {
		return "", text
	}
	if m := mxAdded.FindStringSubmatch(text); m != nil {
		return m[1], ""
	}
	return "", text
}

// Finish calls finish_run and returns the refusal, "" when the run is finished.
func (a *mxTurn) Finish() string {
	text, isErr := a.Call("finish_run", map[string]any{"outcome": "achieved", "summary": "All of it is done."})
	if isErr {
		return text
	}
	return ""
}

// AllDone reports whether the run has tasks and every one of them is done.
func mxAllDone(l *Loaded) bool {
	if l == nil || len(l.Tasks) == 0 {
		return false
	}
	for _, t := range l.Tasks {
		if t.State() != model.TaskDone {
			return false
		}
	}
	return true
}

// finishWhenDone is the usual later turn: finish the run once every task is done.
func mxFinishWhenDone(a *mxTurn) {
	if mxAllDone(a.State()) {
		if refusal := a.Finish(); refusal != "" {
			a.Say("finish_run was refused: " + refusal)
			return
		}
		a.Say("Finished.")
		return
	}
	a.Say("Nothing to change yet.")
}

// writer is a work agent that writes one file of its own and reports.
func mxWriter(a *mxTurn, t Task) {
	a.Write(strings.ToLower(t.ID)+".txt", "the file of "+t.ID+"\n")
	a.Done("Wrote the file of " + t.ID + ".")
}

// reasons are the reasons of the run's turns, in order.
func mxReasons(l *Loaded) []string {
	var out []string
	for _, t := range l.Turns {
		out = append(out, t.Reason)
	}
	return out
}

// Notes calls set_notes, which the first writing task needs.
func (a *mxTurn) Notes() {
	a.Call("set_notes", map[string]any{"notes": "Done means: every task's file exists."})
}

// stopRun asks the run to stop and waits until it has.
func (h *mx) stopRun() *Loaded {
	h.t.Helper()
	if _, err := h.s().Stop(h.id); err != nil {
		h.t.Fatalf("stop: %v", err)
	}
	return h.waitStatus(model.RunStopped)
}

// resume resumes the run.
func (h *mx) resume() {
	h.t.Helper()
	if _, err := h.s().Resume(h.id, ResumeReq{}); err != nil {
		h.t.Fatalf("resume: %v", err)
	}
}

// idleEngine checks that a halted run has nothing working: no engine, no worker, no agent
// process, and no agent recorded as running.
func (h *mx) idleEngine() {
	h.t.Helper()
	r := h.r()
	h.wait("the engine to be gone", func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return r.eng == nil
	})
	// The scheduler's goroutine is the last to go: it takes itself off the list as it returns.
	es := &h.s().eng
	h.wait("the engine's goroutines to return", func() bool {
		es.mu.Lock()
		defer es.mu.Unlock()
		return len(es.active) == 0
	})
	for _, a := range h.L().Agents {
		if a.Status == model.AgentRunning {
			h.t.Errorf("agent %s is recorded as running", a.Name)
		}
	}
	h.noAgentProcess("when the run is halted")
}

// finished waits for the run to be completed and checks that nothing of it is left working.
func (h *mx) finished() *Loaded {
	h.t.Helper()
	l := h.waitStatus(model.RunCompleted, model.RunGaveUp, model.RunStalled, model.RunError)
	if l.State.Status != model.RunCompleted {
		h.t.Fatalf("the run ended %s (%s)\n%s", l.State.Status, l.State.Reason, h.dump())
	}
	h.idleEngine()
	h.noRelaunchOfDone()
	h.journalWhole()
	return l
}

// intFile is a file of the run's merged work (resultRef); "" when it has none.
func (h *mx) intFile(name string) string {
	h.t.Helper()
	out, err := h.repo.GitIn(h.repo.Dir(), "show", h.resultRef()+":"+name)
	if err != nil {
		return ""
	}
	return out
}

// resultRef names the run's merged work: the integration branch while the run has not ended, the
// result's head from then on (the branch goes, a moment after the run's last entry, when the
// result was applied to the person's folder).
func (h *mx) resultRef() string {
	h.t.Helper()
	if g := h.L().State.Git; g != nil && g.ResultHead != "" {
		return g.ResultHead
	}
	return svcIntegrationBranch(h.id)
}

// delivered checks that the result of the finished run l was applied to the person's folder by
// the run's end: the folder's HEAD is the result and nothing in it is uncommitted, the record
// says so, and no branch of the run that is part of the result is left. It returns the delivery's
// state and reason. A run that was restarted between the fast-forward and its last entry finds
// the result in the folder ("already").
func (h *mx) delivered(l *Loaded) string {
	h.t.Helper()
	d, g := l.State.Delivery, l.State.Git
	if d == nil {
		h.t.Errorf("the finished run has no delivery")
		return ""
	}
	head := h.repo.Git("rev-parse", "HEAD")
	if d.State != model.DeliveryApplied || !d.Auto || (d.How != "ff" && d.How != "already") || d.Result != g.ResultHead || d.Commit != head ||
		head != g.ResultHead || d.Branch != g.Branch || d.Partial || d.At == 0 {
		h.t.Errorf("the delivery: %+v; the folder's HEAD %s, the result %s", *d, head, g.ResultHead)
	}
	if st := h.repo.Git("status", "--porcelain"); st != "" {
		h.t.Errorf("the person's folder is not clean after the delivery:\n%s", st)
	}
	// The branches go after the entry that ends the run.
	h.wait("the run's branches that are in the result to be gone", func() bool {
		for _, b := range h.branches() {
			if !strings.HasPrefix(b, "aiwb/"+h.id+"/") {
				continue
			}
			if _, err := h.repo.GitIn(h.repo.Dir(), "merge-base", "--is-ancestor", b, g.ResultHead); err == nil {
				return false
			}
		}
		return true
	})
	return string(d.State) + "/" + d.Reason
}
