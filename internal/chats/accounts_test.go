package chats

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// Chats on a Claude account (an agent kind of its own, "claude:<id>"): the account's spawner,
// its catalog and defaults, and the account gate of every start (goal §1.4.5–1.4.7, §1.5.4,
// §1.7.3, §4.2). The accounts themselves (internal/aliases) are faked here: this package must not
// import them, so their refusals are stood in for by errors of the test's own, which must come
// back unchanged.

const (
	acct  = model.AgentKind("claude:a_k3j2m9x0")
	acct2 = model.AgentKind("claude:a_p0q9r8s7")
)

// errGoneT stands in for aliases.ErrRemoved.
var errGoneT = errors.New("This account was removed")

// mountErrT stands in for *aliases.MountError.
type mountErrT struct{ pending bool }

func (e *mountErrT) Error() string {
	if e.pending {
		return "Restart Claude · Work to use this folder"
	}
	return "This folder isn't mounted in Claude · Work — Add it in Settings"
}

// folderCheck is one call of fakeAccounts.CheckFolder.
type folderCheck struct {
	kind model.AgentKind
	cwd  string
}

// fakeAccounts is a chats.Accounts: a spawner per account kind, what CheckFolder answers, and a
// Prepare that records its calls and can fail (prepErr) or wait (holdPrepare).
type fakeAccounts struct {
	mu       sync.Mutex
	spawners map[model.AgentKind]agent.Spawner
	folder   map[model.AgentKind]error
	checks   []folderCheck
	prepared []model.AgentKind
	prepErr  map[model.AgentKind]error
	prepGate chan struct{}        // non-nil: Prepare waits until it is closed
	prepIn   chan model.AgentKind // non-nil: Prepare sends its kind here when it starts waiting
}

func (a *fakeAccounts) Prepare(k model.AgentKind) error {
	a.mu.Lock()
	a.prepared = append(a.prepared, k)
	gate, in, err := a.prepGate, a.prepIn, a.prepErr[k]
	a.mu.Unlock()
	if gate != nil {
		in <- k
		<-gate
	}
	return err
}

// holdPrepare makes every Prepare from now on wait until release is called; reached gets the
// kind of each Prepare once it waits.
func (a *fakeAccounts) holdPrepare() (reached <-chan model.AgentKind, release func()) {
	gate, in := make(chan struct{}), make(chan model.AgentKind, 16)
	a.mu.Lock()
	a.prepGate, a.prepIn = gate, in
	a.mu.Unlock()
	var once sync.Once
	return in, func() {
		once.Do(func() {
			a.mu.Lock()
			a.prepGate = nil
			a.mu.Unlock()
			close(gate)
		})
	}
}

// failPrepare makes Prepare of k answer err (nil: the container is ready).
func (a *fakeAccounts) failPrepare(k model.AgentKind, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.prepErr == nil {
		a.prepErr = map[model.AgentKind]error{}
	}
	a.prepErr[k] = err
}

// preparedKinds are the kinds Prepare was called with, in order.
func (a *fakeAccounts) preparedKinds() []model.AgentKind {
	a.mu.Lock()
	defer a.mu.Unlock()
	return slices.Clone(a.prepared)
}

func (a *fakeAccounts) Spawner(k model.AgentKind) agent.Spawner {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.spawners[k] // an untyped nil for no account
}

func (a *fakeAccounts) Namer(model.AgentKind) Namer { return nil }

func (a *fakeAccounts) CheckFolder(k model.AgentKind, cwd string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.checks = append(a.checks, folderCheck{k, cwd})
	return a.folder[k]
}

// setFolder makes CheckFolder answer err for k (nil: the folder is mounted).
func (a *fakeAccounts) setFolder(k model.AgentKind, err error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.folder[k] = err
}

func (a *fakeAccounts) setSpawner(k model.AgentKind, sp agent.Spawner) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if sp == nil {
		delete(a.spawners, k)
		return
	}
	a.spawners[k] = sp
}

func (a *fakeAccounts) checked() []folderCheck {
	a.mu.Lock()
	defer a.mu.Unlock()
	return slices.Clone(a.checks)
}

// fakeExtra is a usable.Extra: the accounts' kinds and why each cannot be used.
type fakeExtra struct {
	mu    sync.Mutex
	kinds []model.AgentKind
	why   map[model.AgentKind]error
}

func (x *fakeExtra) Kinds() []model.AgentKind {
	x.mu.Lock()
	defer x.mu.Unlock()
	return slices.Clone(x.kinds)
}

func (x *fakeExtra) Check(a model.AgentKind) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	if !slices.Contains(x.kinds, a) {
		return errGoneT
	}
	return x.why[a]
}

func (x *fakeExtra) Name(a model.AgentKind) string { return "Claude · " + string(a) }

// set makes Check answer err for a (nil: usable).
func (x *fakeExtra) set(a model.AgentKind, err error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.why[a] = err
}

// remove takes a out of the accounts, as removing the account does.
func (x *fakeExtra) remove(a model.AgentKind) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.kinds = slices.DeleteFunc(x.kinds, func(k model.AgentKind) bool { return k == a })
}

// acctEnv is an env with two Claude accounts, acct and acct2, whose processes are agenttest.Fake
// ones, and a usable.Set that knows them.
type acctEnv struct {
	*env
	f, f2 *agenttest.Fake
	acc   *fakeAccounts
	x     *fakeExtra
}

func accountEnv(t *testing.T) *acctEnv {
	t.Helper()
	e := newEnv(t)
	f, f2 := agenttest.New(acct), agenttest.New(acct2)
	acc := &fakeAccounts{spawners: map[model.AgentKind]agent.Spawner{acct: f, acct2: f2}, folder: map[model.AgentKind]error{}}
	x := &fakeExtra{kinds: []model.AgentKind{acct, acct2}, why: map[model.AgentKind]error{}}
	set := usable.NewWith(map[model.AgentKind]string{model.Claude: "claude", model.Cursor: "cursor", model.Pi: "pi"},
		func(bin string) (string, error) { return "/bin/" + bin, nil })
	set.SetExtra(x)
	e.m.Accounts, e.m.Agents = acc, set
	t.Cleanup(func() {
		for _, v := range e.m.Views() {
			e.m.Stop(v.ID)
		}
	})
	return &acctEnv{env: e, f: f, f2: f2, acc: acc, x: x}
}

// turnsAre waits until the chat id has had n turns.
func (e *acctEnv) turnsAre(id string, n int) {
	e.t.Helper()
	waitFor(e.t, "the turn to end", func() bool { return e.view(id).Usage.Turns == n })
}

// A chat made on an account, or given one before its first message, runs on the account's
// spawner with the options of any chat, and keeps the account for its life.
func TestAccountChatRunsOnTheAccount(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	e.f.Script(func(tn *agenttest.Turn) { tn.Say("ok") })
	v := e.create(acct, gOne, "")
	if v.Agent != acct || v.Model != claude.Catalog.Default.Model {
		t.Fatalf("new chat on the account: agent %q model %q", v.Agent, v.Model)
	}
	e.send(v.ID, "hello", "")
	e.turnsAre(v.ID, 1)
	m := e.meta(v.ID)
	sp := e.f.Spawns()
	if len(sp) != 1 {
		t.Fatalf("%d spawns on the account", len(sp))
	}
	o := sp[0]
	if o.ChatID != v.ID || o.Cwd != v.Cwd || o.Resume || o.SessionID != m.SessionID || o.SessionID == "" ||
		o.MCP == nil || o.MCP.Token != m.Token || o.MCP.MCPURL != "http://localhost:6006/mcp" ||
		o.Model != v.Model || o.Effort != v.Effort || o.Dir != e.st.P.ChatDir(v.ID) {
		t.Fatalf("spawn options %+v (chat %+v)", o, m)
	}
	if m.Agent != acct || !m.Locked {
		t.Fatalf("chat.json: agent %q locked %v", m.Agent, m.Locked)
	}
	if e.claude.count() != 0 {
		t.Fatal("the computer's own Claude was started for a chat on an account")
	}
	if c := e.acc.checked(); len(c) == 0 || c[0] != (folderCheck{acct, v.Cwd}) {
		t.Fatalf("folder checks %+v", c)
	}
	for _, other := range []model.AgentKind{model.Claude, acct2} {
		if err := e.m.Configure(v.ID, ConfigReq{Agent: other}); !errors.Is(err, ErrAgentFixed) {
			t.Fatalf("agent changed to %s after the first message: %v", other, err)
		}
	}

	// A chat of the computer's Claude given the account before its first message.
	w := e.create(model.Claude, gOne, "")
	if err := e.m.Configure(w.ID, ConfigReq{Agent: acct, Model: "opus"}); err != nil {
		t.Fatal(err)
	}
	e.send(w.ID, "hi", "")
	e.turnsAre(w.ID, 1)
	if m := e.meta(w.ID); m.Agent != acct || m.Model != "opus" {
		t.Fatalf("configured chat: %+v", m)
	}
	if got := spawnsOf(e.f, w.ID); len(got) != 1 || got[0].Model != "opus" || e.claude.count() != 0 {
		t.Fatalf("configured chat's spawns %+v, %d on Claude", got, e.claude.count())
	}
}

// A folder the account's container does not have (or has only once it is restarted) refuses every
// start, with the accounts' error as it came, and leaves nothing: no process, no item, no record.
func TestAccountFolderRefusesEveryStart(t *testing.T) {
	t.Parallel()
	for _, pending := range []bool{false, true} {
		name := "not mounted"
		if pending {
			name = "pending"
		}
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			e := accountEnv(t)
			e.f.Script(func(tn *agenttest.Turn) {
				if tn.Opts.Subagent {
					tn.Hang()
				}
			})
			want := &mountErrT{pending: pending}
			refused := func(what string, err error) {
				t.Helper()
				var me *mountErrT
				if !errors.Is(err, want) || !errors.As(err, &me) || err.Error() != want.Error() {
					t.Fatalf("%s: %v, want the accounts' refusal unchanged", what, err)
				}
			}

			// Before: a started chat whose process has ended, with a stopped subagent on the account;
			// a chat that has not started, with a draft; a chat of the computer's Claude.
			a := e.create(acct, gOne, "")
			e.send(a.ID, "one", "")
			e.turnsAre(a.ID, 1)
			sa := e.spawn(a.ID, SpawnSubRequest{Prompt: "child"})
			waitFor(t, "the subagent's process", func() bool { return len(spawnsOf(e.f, a.ID+"/subagents/"+sa.ID)) == 1 })
			e.m.Stop(a.ID)
			waitFor(t, "the processes to end", func() bool { return e.f.Live() == 0 })
			if s := e.subFile(a.ID, sa.ID); s.Status != model.SubStopped || s.Kind != acct {
				t.Fatalf("subagent after Stop: %+v", s)
			}
			n := e.create(acct, gOne, "")
			if _, _, err := e.m.SetDraft(n.ID, 0, model.Draft{Text: "draft"}); err != nil {
				t.Fatal(err)
			}
			b := e.create(model.Claude, gOne, "")
			itemsA, spawns := len(e.items(a.ID)), len(e.f.Spawns())

			e.acc.setFolder(acct, want)
			refused("the first message", e.m.Send(n.ID, "draft", "", nil))
			if items := e.items(n.ID); len(items) != 0 || e.meta(n.ID).Locked || e.draftsOf(n.ID)["main"] != "draft" {
				t.Fatalf("the refused first message left items %s, locked %v, drafts %v", kindsOf(items), e.meta(n.ID).Locked, e.draftsOf(n.ID))
			}
			if v := e.view(n.ID); v.Status == model.StatusError || v.Error != "" {
				t.Fatalf("the refused first message shows on the chat: %q %q", v.Status, v.Error)
			}
			refused("the resume", e.m.Send(a.ID, "two", "", nil))
			if got := len(e.items(a.ID)); got != itemsA {
				t.Fatalf("the refused resume left items: %d, was %d", got, itemsA)
			}
			_, err := e.m.SpawnSubagent(b.ID, SpawnSubRequest{Prompt: "on the account", Kind: acct})
			refused("a subagent on the account of a Claude chat", err)
			if subs := e.subs(b.ID); len(subs) != 0 {
				t.Fatalf("a refused spawn left records %+v", subs)
			}
			_, err = e.m.SpawnSubagent(a.ID, SpawnSubRequest{Prompt: "inherits"})
			refused("a subagent of the account's chat", err)
			if subs := e.subs(a.ID); len(subs) != 1 {
				t.Fatalf("a refused spawn left records %+v", subs)
			}
			_, err = e.m.ResumeSubagent(a.ID, sa.ID)
			refused("the resume of a subagent", err)
			if s := e.subFile(a.ID, sa.ID); s.Status != model.SubStopped {
				t.Fatalf("the refused resume changed the subagent: %+v", s)
			}
			views := len(e.m.Views())
			_, err = e.m.Fork(a.ID, ForkReq{Branch: model.MainBranch, At: itemsA})
			refused("a fork", err)
			if len(e.m.Views()) != views {
				t.Fatal("a refused fork left a chat")
			}
			if got := e.f.Spawns(); len(got) != spawns {
				t.Fatalf("refused starts started processes: %+v", got[spawns:])
			}
			for _, c := range e.acc.checked() {
				if c.kind != acct || c.cwd != a.Cwd {
					t.Fatalf("folder checked %+v", c)
				}
			}

			// Once the folder is mounted, the chat goes on.
			e.acc.setFolder(acct, nil)
			e.send(a.ID, "two", "")
			e.turnsAre(a.ID, 2)
			if o := spawnsOf(e.f, a.ID); len(o) != 2 || !o[1].Resume {
				t.Fatalf("resume after the mount: %+v", o)
			}
		})
	}
}

// A fork and a new branch of a chat on an account start their process on the account's spawner,
// and are refused before anything is made while the folder is not mounted.
func TestAccountFolderRefusesForkAndBranch(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	sp := &fakeSpawner{}
	e.acc.setSpawner(acct, sp)
	v := e.create(acct, gOne, "")
	e.send(v.ID, "one", "")
	sp.last(t).emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p1"})
	at := len(e.items(v.ID))
	want := &mountErrT{}
	e.acc.setFolder(acct, want)

	views := len(e.m.Views())
	if _, err := e.m.Fork(v.ID, ForkReq{Branch: model.MainBranch, At: at}); !errors.Is(err, want) {
		t.Fatalf("fork: %v", err)
	}
	if _, err := e.m.SendToBranch(v.ID, Target{Branch: model.MainBranch, At: at, New: true}, "branch", "", nil); !errors.Is(err, want) {
		t.Fatalf("new branch: %v", err)
	}
	if len(sp.forkCalls()) != 0 || sp.count() != 1 || len(e.m.Views()) != views {
		t.Fatalf("refused: %d forks, %d spawns, %d chats (was %d)", len(sp.forkCalls()), sp.count(), len(e.m.Views()), views)
	}
	tr, err := e.m.Tree(v.ID)
	if err != nil || len(tr.Branches) != 1 {
		t.Fatalf("tree after a refused branch: %+v %v", tr, err)
	}

	e.acc.setFolder(acct, nil)
	f, err := e.m.Fork(v.ID, ForkReq{Branch: model.MainBranch, At: at})
	if err != nil {
		t.Fatal(err)
	}
	if calls := sp.forkCalls(); len(calls) != 1 || calls[0].opts.ChatID != f.ID || f.Agent != acct {
		t.Fatalf("fork on the account: %+v, agent %q", calls, f.Agent)
	}

	// The fork's model is changed before its first message by starting its process again: refused
	// with the process and the choice kept.
	e.acc.setFolder(acct, want)
	if err := e.m.Configure(f.ID, ConfigReq{Model: "opus"}); !errors.Is(err, want) {
		t.Fatalf("the fresh fork's model change: %v", err)
	}
	if len(sp.forkCalls()) != 1 || sp.lastFork(t).isClosed() || e.view(f.ID).Model == "opus" {
		t.Fatalf("the refused change: %d forks, closed %v, model %q", len(sp.forkCalls()), sp.lastFork(t).isClosed(), e.view(f.ID).Model)
	}
}

// A retry of a chat's agent or of a subagent whose start the account refuses shows the refusal,
// as a failed start does, and starts nothing.
func TestAccountRefusesARetry(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	fastRetries(e.env)
	want := &mountErrT{}
	e.f.Script(func(tn *agenttest.Turn) {
		if strings.Contains(tn.Text, "flaky") {
			e.acc.setFolder(acct, want) // before the attempt
			tn.FailTemp(agent.TempOverloaded, "Overloaded")
		}
	})

	v := e.create(acct, gOne, "")
	e.send(v.ID, "flaky", "")
	waitFor(t, "the attempt to be refused", func() bool { return e.view(v.ID).Status == model.StatusError })
	if got := e.view(v.ID); got.Error != want.Error() || len(spawnsOf(e.f, v.ID)) != 1 || e.meta(v.ID).TurnActive {
		t.Fatalf("after the refused attempt: error %q, %d spawns, turn active %v", got.Error, len(spawnsOf(e.f, v.ID)), e.meta(v.ID).TurnActive)
	}

	e.acc.setFolder(acct, nil)
	w := e.create(model.Claude, gOne, "")
	sa := e.spawn(w.ID, SpawnSubRequest{Prompt: "flaky", Kind: acct})
	waitFor(t, "the subagent to fail", func() bool { return e.subFile(w.ID, sa.ID).Status == model.SubFailed })
	if s := e.subFile(w.ID, sa.ID); !strings.Contains(s.Error, want.Error()) || len(spawnsOf(e.f, w.ID+"/subagents/"+sa.ID)) != 1 {
		t.Fatalf("subagent after the refused attempt: %+v, %d spawns", s, len(spawnsOf(e.f, w.ID+"/subagents/"+sa.ID)))
	}
}

// A removed account (goal §4.2): its chats stay readable, and every start is refused with the
// accounts' reason.
func TestRemovedAccountRefusesStarts(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	e.f.Script(func(tn *agenttest.Turn) { tn.Say("ok") })
	v := e.create(acct, gOne, "")
	e.send(v.ID, "one", "")
	e.turnsAre(v.ID, 1)
	e.m.Stop(v.ID)
	waitFor(t, "the process to end", func() bool { return e.f.Live() == 0 })
	items := e.items(v.ID)

	e.x.remove(acct)
	e.acc.setFolder(acct, errGoneT)
	e.acc.setSpawner(acct, nil)
	check := func(what string, err error) {
		t.Helper()
		var ue *usable.UnusableError
		if !errors.Is(err, errGoneT) || !errors.As(err, &ue) || ue.Agent != acct || err.Error() != errGoneT.Error() {
			t.Fatalf("%s: %v", what, err)
		}
	}
	check("a message", e.m.Send(v.ID, "two", "", nil))
	_, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "child"})
	check("a subagent", err)
	_, err = e.m.ContextSplit(v.ID, true)
	check("the context split", err)
	if got := e.items(v.ID); len(got) != len(items) || len(e.f.Spawns()) != 1 {
		t.Fatalf("the removed account's chat: %s (was %s), %d spawns", kindsOf(got), kindsOf(items), len(e.f.Spawns()))
	}
	if slices.Contains(e.m.UsableAgents(), acct) {
		t.Fatal("a removed account is listed as usable")
	}
}

// Docker down (goal §1.7.3): a message is refused with Docker's reason, as a missing program's is.
func TestDockerReasonRefusesAMessage(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	v := e.create(acct, gOne, "")
	docker := errors.New("Docker is not running")
	e.x.set(acct, docker)
	err := e.m.Send(v.ID, "hello", "", nil)
	var ue *usable.UnusableError
	if !errors.As(err, &ue) || ue.Agent != acct || err.Error() != "Docker is not running" || !errors.Is(err, docker) || !errors.Is(err, usable.ErrMissing) {
		t.Fatalf("message while Docker is down: %v", err)
	}
	if len(e.f.Spawns()) != 0 || len(e.items(v.ID)) != 0 {
		t.Fatal("the refused message left something")
	}
	// A fixed kind is not affected.
	w := e.create(model.Claude, gOne, "")
	e.send(w.ID, "hello", "")
	if e.claude.count() != 1 {
		t.Fatal("Claude Code's chat did not start while Docker is down")
	}
}

// A subagent of a chat on an account runs on the account unless the spawn names another agent:
// the computer's Claude, or another account.
func TestSubagentOfAnAccountChat(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	e.f.Script(func(tn *agenttest.Turn) {
		if tn.Opts.Subagent {
			tn.Hang()
		}
	})
	e.f2.Script(func(tn *agenttest.Turn) { tn.Hang() })
	v := e.create(acct, gOne, "")
	if err := e.m.Configure(v.ID, ConfigReq{Model: "opus", Effort: "low"}); err != nil {
		t.Fatal(err)
	}
	e.send(v.ID, "delegate", "")
	e.turnsAre(v.ID, 1)

	own := e.spawn(v.ID, SpawnSubRequest{Prompt: "inherit"})
	if own.Kind != acct || own.Model != "opus" || own.Effort != "low" {
		t.Fatalf("inherited subagent %+v", own)
	}
	waitFor(t, "its process", func() bool { return len(spawnsOf(e.f, v.ID+"/subagents/"+own.ID)) == 1 })
	if o := spawnsOf(e.f, v.ID+"/subagents/"+own.ID)[0]; o.Model != "opus" || o.Effort != "low" || !o.Subagent || o.Cwd != v.Cwd {
		t.Fatalf("its spawn options %+v", o)
	}

	host := e.spawn(v.ID, SpawnSubRequest{Prompt: "host", Kind: model.Claude})
	if host.Kind != model.Claude || host.Model != claude.Catalog.Default.Model {
		t.Fatalf("subagent on the computer's Claude %+v", host)
	}
	waitFor(t, "its process", func() bool { return e.claude.count() == 1 })

	other := e.spawn(v.ID, SpawnSubRequest{Prompt: "other", Kind: acct2})
	if other.Kind != acct2 || other.Model != claude.Catalog.Default.Model {
		t.Fatalf("subagent on the other account %+v", other)
	}
	waitFor(t, "its process", func() bool { return len(e.f2.Spawns()) == 1 })
	if o := e.f2.Spawns()[0]; o.ChatID != v.ID+"/subagents/"+other.ID {
		t.Fatalf("the other account's spawn %+v", o)
	}
}

// An account's catalog is the built-in Claude one until its own process reports one, which is
// stored and broadcast under the account's kind; Claude's own slot is left alone.
func TestAccountCatalogIsItsOwn(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	sp := &fakeSpawner{}
	e.acc.setSpawner(acct, sp)
	if c := e.m.catalog(acct); c == nil || c.Default != claude.Catalog.Default || len(c.Models) != len(claude.Catalog.Models) {
		t.Fatalf("the account's catalog before its report: %+v", c)
	}
	evs := listen(t, e.br)
	v := e.create(acct, gOne, "")
	e.send(v.ID, "hello", "")
	cat := model.Catalog{Models: []model.CatalogModel{{ID: "opus-x", Label: "Opus X"}}, Default: model.ModelChoice{Model: "opus-x"}}
	sp.last(t).emit(t, agent.Event{Kind: agent.EvCatalog, Catalog: &cat})

	ev := evs.wait(t, func(ev map[string]any) bool { return ev["type"] == "catalog" && ev["agent"] == string(acct) })
	raw, _ := json.Marshal(ev["catalog"])
	if !strings.Contains(string(raw), `"opus-x"`) {
		t.Fatalf("broadcast catalog %s", raw)
	}
	e.st.Read(func(s *model.State) {
		if c := s.Catalog(acct); c == nil || c.Default.Model != "opus-x" {
			t.Fatalf("stored catalog of the account %+v", c)
		}
		if c := s.Catalog(model.Claude); c != nil {
			t.Fatalf("Claude's own catalog was written: %+v", c)
		}
	})
	if c := e.m.catalog(model.Claude); c.Default != claude.Catalog.Default {
		t.Fatalf("Claude's catalog %+v", c)
	}
	if c := e.m.catalog(acct2); c.Default != claude.Catalog.Default {
		t.Fatalf("the other account's catalog %+v", c)
	}
}

// The model and effort a chat on an account starts with are the account's own defaults, kept
// apart from Claude Code's.
func TestAccountDefaultsAreItsOwn(t *testing.T) {
	t.Parallel()
	e := accountEnv(t)
	v := e.create(acct, gOne, "")
	if err := e.m.Configure(v.ID, ConfigReq{Model: "haiku"}); err != nil {
		t.Fatal(err)
	}
	e.send(v.ID, "hello", "")
	e.turnsAre(v.ID, 1)
	e.st.Read(func(s *model.State) {
		by := s.Defaults.Groups[gOne].Local().ByAgent
		if got := by[acct]; got.Model != "haiku" {
			t.Fatalf("the account's defaults %+v", by)
		}
		if got, ok := by[model.Claude]; ok && got.Model == "haiku" {
			t.Fatalf("Claude Code's defaults took the account's: %+v", by)
		}
	})
	if w := e.create(acct, gOne, ""); w.Model != "haiku" {
		t.Fatalf("a new chat on the account starts with %q", w.Model)
	}
	if w := e.create(model.Claude, gOne, ""); w.Model != claude.Catalog.Default.Model {
		t.Fatalf("a new Claude Code chat starts with %q", w.Model)
	}
	if w := e.create(acct2, gOne, ""); w.Model != claude.Catalog.Default.Model {
		t.Fatalf("a new chat on the other account starts with %q", w.Model)
	}
}
