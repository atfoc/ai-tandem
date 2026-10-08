package chats

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// How a chat starts: made with no agent named or with an id, given an agent until its first
// message, which is recorded as its group's, and only with an agent the server can use.

// programs is the look-up of a test's usable.Set: a kind's program is found while has holds it.
type programs struct {
	mu  sync.Mutex
	has map[model.AgentKind]bool
}

var programBins = map[model.AgentKind]string{model.Claude: "claude", model.Cursor: "agent", model.Pi: "pi"}

// set makes kinds the agents whose programs are found.
func (p *programs) set(kinds ...model.AgentKind) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.has = map[model.AgentKind]bool{}
	for _, k := range kinds {
		p.has[k] = true
	}
}

func (p *programs) look(bin string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, b := range programBins {
		if b == bin && p.has[k] {
			return "/bin/" + bin, nil
		}
	}
	return "", errors.New("not found")
}

// startEnv is an env whose agents are agenttest.Fake processes and whose manager looks the
// agents' programs up in the programs returned: kinds are found at first.
func startEnv(t *testing.T, kinds ...model.AgentKind) (*env, *programs, map[model.AgentKind]*agenttest.Fake) {
	t.Helper()
	e := newEnv(t)
	p := &programs{}
	p.set(kinds...)
	e.m.Agents = usable.NewWith(programBins, p.look)
	fakes := map[model.AgentKind]*agenttest.Fake{}
	for _, k := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		fakes[k] = agenttest.New(k)
		e.m.Spawners[k] = fakes[k]
	}
	t.Cleanup(func() {
		for _, v := range e.m.Views() {
			e.m.Stop(v.ID)
		}
	})
	return e, p, fakes
}

func (e *env) newChat(n NewChat) model.ChatView {
	e.t.Helper()
	v, err := e.m.CreateChat(n)
	if err != nil {
		e.t.Fatalf("CreateChat %+v: %v", n, err)
	}
	return v
}

// metaOf is chat.json of a chat, wherever it lives.
func (e *env) metaOf(v model.ChatView) model.ChatMeta {
	e.t.Helper()
	if v.Run != "" {
		return e.runMeta(v.ID, false)
	}
	return e.meta(v.ID)
}

// chatFolders lists the chat folders there are: those in chats/ and those of ownRun.
func (e *env) chatFolders() []string {
	e.t.Helper()
	var out []string
	for _, dir := range []string{e.st.P.Chats, filepath.Dir(e.st.P.RunChatDir(ownRun, false, "x"))} {
		ents, err := os.ReadDir(dir)
		if err != nil && !os.IsNotExist(err) {
			e.t.Fatal(err)
		}
		for _, ent := range ents {
			out = append(out, filepath.Join(dir, ent.Name()))
		}
	}
	sort.Strings(out)
	return out
}

func (e *env) tokens() int {
	e.m.extrasMu.Lock()
	defer e.m.extrasMu.Unlock()
	return len(e.m.used)
}

func spawnCounts(fakes map[model.AgentKind]*agenttest.Fake) [3]int {
	return [3]int{len(fakes[model.Claude].Spawns()), len(fakes[model.Cursor].Spawns()), len(fakes[model.Pi].Spawns())}
}

// ---- AC29: the agent can be changed until the first message -----------------

func TestAgentChangesUntilTheFirstMessage(t *testing.T) {
	t.Parallel()
	e, _, fakes := startEnv(t, model.Claude, model.Cursor, model.Pi)
	v := e.newChat(NewChat{Group: gOne})
	first := e.meta(v.ID)
	if v.Agent != model.Claude || v.Model != "sonnet" || v.Locked || first.SessionID == "" || first.Token == "" {
		t.Fatalf("a chat made with no agent named: %+v, chat.json %+v", v, first)
	}

	// The requests that are refused change nothing: an unknown kind, an unknown server, and a
	// model of the agent before, which is checked against the new agent's list.
	for _, tc := range []struct {
		req  ConfigReq
		want string
	}{
		{ConfigReq{Agent: "nobody"}, `unknown agent "nobody"`},
		{ConfigReq{Server: "elsewhere"}, `unknown server "elsewhere"`},
		{ConfigReq{Agent: model.Cursor, Model: "sonnet"}, `unknown model "sonnet"`},
		{ConfigReq{Agent: model.Cursor, Effort: "max"}, `no effort "max"`},
	} {
		if err := e.m.Configure(v.ID, tc.req); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("Configure %+v: %v, want %q", tc.req, err, tc.want)
		}
		if got := e.meta(v.ID); !reflect.DeepEqual(got, first) {
			t.Fatalf("Configure %+v was refused and left %+v, was %+v", tc.req, got, first)
		}
	}
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Cursor, Model: "sonnet"}); !errors.Is(err, ErrBadChoice) {
		t.Fatalf("a model the new agent lacks: %v, want ErrBadChoice", err)
	}
	// The local server is the only one there is, and the chat's own agent is no change.
	if err := e.m.Configure(v.ID, ConfigReq{Server: model.LocalServer, Agent: model.Claude}); err != nil {
		t.Fatal(err)
	}
	if got := e.meta(v.ID); !reflect.DeepEqual(got, first) {
		t.Fatalf("the chat's own agent and server changed it: %+v, was %+v", got, first)
	}

	// Cursor: its default model and effort, and no session id.
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Cursor}); err != nil {
		t.Fatal(err)
	}
	cur := e.meta(v.ID)
	if cur.Agent != model.Cursor || cur.Model != "composer-2" || cur.Effort != "high" || cur.SessionID != "" {
		t.Fatalf("the chat as Cursor's: %+v", cur)
	}
	if cur.ID != first.ID || cur.Token != first.Token || cur.Cwd != first.Cwd || cur.Group != first.Group || cur.Locked {
		t.Fatalf("an agent change touched more than the agent's own: %+v, was %+v", cur, first)
	}
	if got := e.view(v.ID); got.Agent != model.Cursor || got.Model != "composer-2" {
		t.Fatalf("the view after the change: %+v", got)
	}

	// pi, with a model in the same request: a session id of its own.
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Pi, Model: "pi-model"}); err != nil {
		t.Fatal(err)
	}
	pi := e.meta(v.ID)
	if pi.Agent != model.Pi || pi.Model != "pi-model" || pi.SessionID == "" || pi.SessionID == first.SessionID {
		t.Fatalf("the chat as pi's: %+v (Claude's session was %q)", pi, first.SessionID)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Pi}); err != nil {
		t.Fatal(err)
	}
	if got := e.meta(v.ID); !reflect.DeepEqual(got, pi) {
		t.Fatalf("the same agent again changed the chat: %+v, was %+v", got, pi)
	}

	if n := spawnCounts(fakes); n != [3]int{} {
		t.Fatalf("spawns before the first message: %v", n)
	}
	e.send(v.ID, "hello", "")
	waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	if n := spawnCounts(fakes); n != [3]int{0, 0, 1} {
		t.Fatalf("spawns after the first message: %v, want one, of pi", n)
	}
	if o := fakes[model.Pi].Spawns()[0]; o.SessionID != pi.SessionID || o.Resume || o.Model != "pi-model" {
		t.Fatalf("pi was started with %+v, want the session %q made at the last agent change", o, pi.SessionID)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Claude}); !errors.Is(err, ErrAgentFixed) {
		t.Fatalf("an agent change after the first message: %v, want ErrAgentFixed", err)
	}
}

func TestAgentChangeAfterAFailedStart(t *testing.T) {
	t.Parallel()
	e, _, fakes := startEnv(t, model.Claude, model.Cursor, model.Pi)
	v := e.newChat(NewChat{Group: gOne})
	fakes[model.Claude].FailSpawn(errors.New("claude: bad login"))
	if err := e.m.Send(v.ID, "hello", "", nil); err == nil {
		t.Fatal("Send with a start that fails gave no error")
	}
	if got := e.view(v.ID); got.Status != model.StatusError || got.Error != "claude: bad login" || got.Locked {
		t.Fatalf("after the failed start: %+v", got)
	}

	// Another agent: the error was the other agent's, and goes.
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Cursor}); err != nil {
		t.Fatal(err)
	}
	if got := e.view(v.ID); got.Status != model.StatusReady || got.Error != "" || got.Agent != model.Cursor {
		t.Fatalf("after the agent change: %+v", got)
	}
	e.send(v.ID, "hello", "")
	waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	if n := spawnCounts(fakes); n != [3]int{1, 1, 0} {
		t.Fatalf("spawns: %v, want Claude's failed one and one of Cursor", n)
	}
	if items := e.items(v.ID); kindsOf(items) != "user end" {
		t.Fatalf("items: %s", kindsOf(items))
	}

	// A missing folder is the chat's, whatever its agent: that error stays until the folder is
	// replaced.
	dir := filepath.Join(t.TempDir(), "gone")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	w := e.newChat(NewChat{Group: gTwo})
	if err := e.m.Configure(w.ID, ConfigReq{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Send(w.ID, "hello", "", nil); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("Send in a missing folder: %v", err)
	}
	if err := e.m.Configure(w.ID, ConfigReq{Agent: model.Pi}); err != nil {
		t.Fatal(err)
	}
	if got := e.view(w.ID); got.Agent != model.Pi || !got.FolderMissing || got.Status != model.StatusError || got.Error == "" {
		t.Fatalf("an agent change took the missing folder's error back: %+v", got)
	}
	if err := e.m.Configure(w.ID, ConfigReq{Agent: model.Claude, Cwd: e.cwd}); err != nil {
		t.Fatal(err)
	}
	if got := e.view(w.ID); got.Agent != model.Claude || got.FolderMissing || got.Status != model.StatusReady || got.Error != "" || got.Cwd != e.cwd {
		t.Fatalf("after an agent and a folder: %+v", got)
	}
}

func TestAgentChangeOnARun(t *testing.T) {
	t.Parallel()
	e, p, fakes := startEnv(t, model.Claude, model.Cursor, model.Pi)
	e.m.Runs = &fakeRuns{runs: map[string]RunInfo{ownRun: {Group: gOne, Cwd: e.cwd, Agent: model.Claude, Model: "opus", Effort: "max"}}}
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne: model.LocalDefaults(model.ServerDefaults{Agent: model.Pi, Cwd: t.TempDir(), ByAgent: map[model.AgentKind]model.ModelChoice{
			model.Claude: {Model: "haiku"}, model.Pi: {Model: "pi-model", Effort: "low"}}}),
	}})
	was := e.defaultsOf()

	// With no agent named a chat on a run is of its group's sticky kind, not of the run's, on
	// the group's choice for that kind and in the run's folder. "+" records nothing.
	v := e.newChat(NewChat{Run: ownRun})
	first := e.metaOf(v)
	if v.Agent != model.Pi || v.Model != "pi-model" || v.Effort != "low" || v.Cwd != e.cwd || v.Run != ownRun || v.Group != "" {
		t.Fatalf("a chat on a run: %+v", v)
	}
	if got := e.defaultsOf(); !reflect.DeepEqual(got, was) {
		t.Fatalf("the defaults after a new chat on a run: %+v, were %+v", got, was)
	}
	// The run's kind: the group's choice for it, not the deep tier's. The folder stays the run's.
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Claude}); err != nil {
		t.Fatal(err)
	}
	if m := e.metaOf(v); m.Agent != model.Claude || m.Model != "haiku" || m.Cwd != e.cwd || m.SessionID == first.SessionID || m.SessionID == "" || m.Run != ownRun {
		t.Fatalf("the chat on the run as Claude's: %+v", m)
	}
	// A kind the group has no choice for: its catalog's default.
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Cursor}); err != nil {
		t.Fatal(err)
	}
	e.send(v.ID, "hello", "")
	waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	if n := spawnCounts(fakes); n != [3]int{0, 1, 0} {
		t.Fatalf("spawns: %v, want one, of Cursor", n)
	}
	// A chat on a run feeds the defaults of its group with its agent, model and effort, as any
	// chat does, and not with the run's folder: the next chat on the run starts as this one was.
	got, cur := e.defaultsOf().Groups[gOne].On(model.LocalServer), e.metaOf(v)
	if got.Agent != model.Cursor || got.ByAgent[model.Cursor] != (model.ModelChoice{Model: cur.Model, Effort: cur.Effort}) || cur.Model == "" ||
		got.Cwd != was.Groups[gOne].On(model.LocalServer).Cwd || got.ByAgent[model.Claude].Model != "haiku" || e.defaultsOf().Groups[gOne].Server != "" {
		t.Fatalf("the defaults after a chat on a run: %+v, were %+v", got, was)
	}
	if w := e.newChat(NewChat{Run: ownRun}); w.Agent != model.Cursor || w.Model != cur.Model || w.Effort != cur.Effort || w.Cwd != e.cwd {
		t.Fatalf("the next chat on the run: %+v", w)
	}

	// The sticky kind is not usable: the run's kind, when that is.
	p.set(model.Claude, model.Pi)
	if w := e.newChat(NewChat{Run: ownRun}); w.Agent != model.Claude || w.Model != "haiku" || w.Cwd != e.cwd {
		t.Fatalf("a chat on a run whose group's kind is not usable: %+v", w)
	}

	// A run agent's chat is the run's: no agent change, and its start is the run's matter, which
	// the first-message check of a person's chat does not look at.
	id := e.agentChat("turn-001", model.RoleOrchestrator, model.Claude)
	if err := e.m.Configure(id, ConfigReq{Agent: model.Pi}); !errors.Is(err, ErrRunAgent) {
		t.Fatalf("an agent change of a run agent's chat: %v, want ErrRunAgent", err)
	}
	e.sendOwned(id, "go")
	if n := len(fakes[model.Claude].Spawns()); n != 1 {
		t.Fatalf("%d Claude spawns, want the run agent's", n)
	}
}

// ---- AC30: fixed once started; the id of a new chat ----------------------------

func TestAgentIsFixedOnceStarted(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.talked(model.Claude, "", 2)
	fixed := func(what, chat, branch string) {
		t.Helper()
		was := e.meta(chat)
		for _, req := range []ConfigReq{
			{Agent: model.Pi}, {Agent: model.Claude}, {Server: model.LocalServer},
			{Agent: model.Pi, Model: "opus"}, {Server: model.LocalServer, Cwd: e.cwd},
		} {
			if err := e.m.ConfigureOf(chat, branch, req); !errors.Is(err, ErrAgentFixed) {
				t.Fatalf("%s, Configure %+v: %v, want ErrAgentFixed", what, req, err)
			}
		}
		if got := e.meta(chat); !reflect.DeepEqual(got, was) {
			t.Fatalf("%s: the refused changes left %+v, was %+v", what, got, was)
		}
	}
	fixed("after the first message", id, "")
	// The other refusal of a started chat is as it was.
	if err := e.m.Configure(id, ConfigReq{Model: "opus"}); !errors.Is(err, ErrLocked) {
		t.Fatalf("a model after the first message: %v, want ErrLocked", err)
	}

	// A fork at its start has had no message, and is a fork: its model still changes.
	v0, err := e.forkWith(id, 0, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if e.meta(v0.ID).Locked {
		t.Fatal("a fork at the start is locked")
	}
	fixed("in a fork at its start", v0.ID, "")
	if err := e.m.Configure(v0.ID, ConfigReq{Model: "opus", Effort: "max"}); err != nil {
		t.Fatal(err)
	}
	if m := e.meta(v0.ID); m.Model != "opus" || m.Effort != "max" || m.Agent != model.Claude {
		t.Fatalf("the fork at its start, configured: %+v", m)
	}

	// A fork with a conversation: the refusal comes before the change of a fresh fork's model.
	v3 := e.fork(id, 3)
	if m := e.meta(v3.ID); !m.Fresh {
		t.Fatalf("a fork with a conversation is not fresh: %+v", m)
	}
	fixed("in a fresh fork", v3.ID, "")
	if err := e.m.Configure(v3.ID, ConfigReq{Model: "haiku"}); err != nil {
		t.Fatal(err)
	}
	if m := e.meta(v3.ID); m.Model != "haiku" || m.Agent != model.Claude {
		t.Fatalf("the fresh fork, given a model: %+v", m)
	}

	// A branch, named or current.
	b, bid, ba := e.branchTo(id, Target{Branch: model.MainBranch, At: 3, New: true}, "aside")
	ba.emit(t, reply("q1")...)
	was := e.meta(bid)
	for _, branch := range []string{b, "", model.MainBranch} {
		for _, req := range []ConfigReq{{Agent: model.Pi}, {Server: model.LocalServer}} {
			if err := e.m.ConfigureOf(id, branch, req); !errors.Is(err, ErrAgentFixed) {
				t.Fatalf("branch %q, Configure %+v: %v, want ErrAgentFixed", branch, req, err)
			}
		}
	}
	if got := e.meta(bid); !reflect.DeepEqual(got, was) {
		t.Fatalf("the refused changes left the branch %+v, was %+v", got, was)
	}
}

func TestCreateWithAnIDWhichForms(t *testing.T) {
	t.Parallel()
	e, _ := runEnv(t)
	const good = "0b8f3c1e-5a4d-4e2b-9c7a-1f2e3d4c5b6a"
	before := e.chatFolders()
	for _, id := range []string{
		"../../etc", "a/b", "..", "x",
		strings.ToUpper(good),
		"0b8f3c1e-5a4d-1e2b-9c7a-1f2e3d4c5b6a", // version 1
		"0b8f3c1e-5a4d-4e2b-7c7a-1f2e3d4c5b6a", // not the variant of a version 4
		good + "\n", "\n" + good, " " + good, good + "/..", "{" + good + "}",
		strings.ReplaceAll(good, "-", ""),
		good[:35], good + "0",
	} {
		for _, n := range []NewChat{{ID: id, Group: gOne}, {ID: id, Run: ownRun}, {ID: id, Agent: model.Pi, Group: gOne}} {
			if _, err := e.m.CreateChat(n); !errors.Is(err, ErrBadID) {
				t.Fatalf("CreateChat %+v: %v, want ErrBadID", n, err)
			}
		}
	}
	if got := e.chatFolders(); !reflect.DeepEqual(got, before) || len(e.m.Views()) != 0 || e.tokens() != 0 {
		t.Fatalf("the refused ids left folders %v, %d chats, %d tokens", got, len(e.m.Views()), e.tokens())
	}

	// Every id the server makes has the form.
	for i := 0; i < 1000; i++ {
		if id := uuid(); !chatID.MatchString(id) {
			t.Fatalf("uuid() gave %q, which CreateChat would refuse", id)
		}
	}

	// A good id is the chat's: in chats/, and under its run.
	v := e.newChat(NewChat{ID: good, Group: gOne})
	if v.ID != good || e.meta(good).ID != good || v.Agent != model.Claude {
		t.Fatalf("a chat with a given id: %+v", v)
	}
	const onRun = "7d1c9a52-3b6e-4f80-a1d4-9e8c7b6a5f40"
	r := e.newChat(NewChat{ID: onRun, Run: ownRun})
	if r.ID != onRun || e.runMeta(onRun, false).Run != ownRun {
		t.Fatalf("a chat on a run with a given id: %+v", r)
	}
	e.send(good, "hello", "")
	if e.claude.count() != 1 || e.claude.last(t).opts.ChatID != good {
		t.Fatal("the chat with a given id did not start as any chat does")
	}
}

func TestCreateWithATakenID(t *testing.T) {
	t.Parallel()
	e, _ := runEnv(t)
	bd, err := e.bds.Create("board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	const id = "0b8f3c1e-5a4d-4e2b-9c7a-1f2e3d4c5b6a"
	v := e.newChat(NewChat{ID: id, Agent: model.Pi, Group: gOne})
	was, folders, tokens := e.meta(id), e.chatFolders(), e.tokens()
	for _, n := range []NewChat{{ID: id, Group: gOne}, {ID: id, Agent: model.Claude, Group: gTwo}, {ID: id, Board: bd.ID}, {ID: id, Run: ownRun}} {
		if _, err := e.m.CreateChat(n); !errors.Is(err, ErrIDTaken) {
			t.Fatalf("CreateChat %+v with a chat's id: %v, want ErrIDTaken", n, err)
		}
	}
	if got := e.meta(id); !reflect.DeepEqual(got, was) || e.view(id) != v {
		t.Fatalf("the chat whose id was asked for again: %+v, was %+v", got, was)
	}

	// A chat on a run has its id too, and so has a folder that holds no chat that could be read.
	const onRun, stray = "7d1c9a52-3b6e-4f80-a1d4-9e8c7b6a5f40", "c3a1f0e2-9b7d-4c5a-8e6f-0a1b2c3d4e5f"
	e.newChat(NewChat{ID: onRun, Run: ownRun})
	if err := os.Mkdir(e.st.P.ChatDir(stray), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(e.st.P.ChatDir(stray), "notes.txt"), []byte("kept"), 0o600); err != nil {
		t.Fatal(err)
	}
	folders, tokens = e.chatFolders(), e.tokens()
	for _, n := range []NewChat{{ID: onRun, Group: gOne}, {ID: onRun, Run: ownRun}, {ID: stray, Group: gOne}, {ID: stray, Run: ownRun}} {
		if _, err := e.m.CreateChat(n); !errors.Is(err, ErrIDTaken) {
			t.Fatalf("CreateChat %+v: %v, want ErrIDTaken", n, err)
		}
	}
	if raw, err := os.ReadFile(filepath.Join(e.st.P.ChatDir(stray), "notes.txt")); err != nil || string(raw) != "kept" {
		t.Fatalf("the folder whose name was asked for: %q %v", raw, err)
	}
	if got := e.chatFolders(); !reflect.DeepEqual(got, folders) || e.tokens() != tokens || len(e.m.Views()) != 2 {
		t.Fatalf("the refused creations left folders %v (were %v), %d tokens (were %d), %d chats", got, folders, e.tokens(), tokens, len(e.m.Views()))
	}

	// Asked for by many at once, an id is one chat's.
	const raced = "5e6f7a8b-1c2d-4e3f-b4a5-6c7d8e9f0a1b"
	errs := make(chan error, 8)
	for i := 0; i < cap(errs); i++ {
		go func() {
			_, err := e.m.CreateChat(NewChat{ID: raced, Group: gOne})
			errs <- err
		}()
	}
	made := 0
	for i := 0; i < cap(errs); i++ {
		if err := <-errs; err == nil {
			made++
		} else if !errors.Is(err, ErrIDTaken) {
			t.Fatalf("a creation that lost the id: %v, want ErrIDTaken", err)
		}
	}
	if made != 1 || len(e.m.Views()) != 3 || e.tokens() != tokens+1 {
		t.Fatalf("%d creations got the id; %d chats, %d tokens (were %d)", made, len(e.m.Views()), e.tokens(), tokens)
	}
}

func TestRefusedCreateLeavesNothing(t *testing.T) {
	t.Parallel()
	e, _, _ := startEnv(t, model.Claude)
	e.m.Runs = &fakeRuns{runs: map[string]RunInfo{
		ownRun:  {Group: gOne, Cwd: e.cwd, Agent: model.Claude, Model: "sonnet"},
		"r_old": {Group: gOne, Cwd: e.cwd, Agent: model.Claude, Archived: true},
	}}
	const id, taken = "0b8f3c1e-5a4d-4e2b-9c7a-1f2e3d4c5b6a", "7d1c9a52-3b6e-4f80-a1d4-9e8c7b6a5f40"
	e.newChat(NewChat{ID: taken, Group: gOne})
	evs := e.listen()
	was := e.defaultsOf()
	folders, tokens := e.chatFolders(), e.tokens()
	var missing *usable.MissingError
	for _, tc := range []struct {
		n    NewChat
		want func(error) bool
	}{
		{NewChat{ID: id, Agent: "nobody", Group: gOne}, func(err error) bool { return strings.Contains(err.Error(), `unknown agent "nobody"`) }},
		{NewChat{ID: "nope", Group: gOne}, func(err error) bool { return errors.Is(err, ErrBadID) }},
		{NewChat{ID: id, Group: "g_none"}, func(err error) bool { return strings.Contains(err.Error(), "no such group") }},
		{NewChat{ID: id}, func(err error) bool { return strings.Contains(err.Error(), "no such group") }},
		{NewChat{ID: id, Board: "b_none"}, func(err error) bool { return err.Error() != "" && !errors.Is(err, ErrIDTaken) }},
		{NewChat{ID: id, Run: "r_none"}, func(err error) bool { return errors.Is(err, ErrNoRun) }},
		{NewChat{ID: id, Run: "../x"}, func(err error) bool { return errors.Is(err, ErrNoRun) }},
		{NewChat{ID: id, Run: "r_old"}, func(err error) bool { return errors.Is(err, ErrRunArchived) }},
		{NewChat{ID: id, Agent: model.Cursor, Group: gOne}, func(err error) bool { return errors.As(err, &missing) }},
		{NewChat{Agent: model.Pi, Run: ownRun}, func(err error) bool { return errors.Is(err, usable.ErrMissing) }},
		{NewChat{ID: taken, Group: gOne}, func(err error) bool { return errors.Is(err, ErrIDTaken) }},
	} {
		if _, err := e.m.CreateChat(tc.n); err == nil || !tc.want(err) {
			t.Fatalf("CreateChat %+v: %v", tc.n, err)
		}
		if got := e.chatFolders(); !reflect.DeepEqual(got, folders) || e.tokens() != tokens || len(e.m.Views()) != 1 {
			t.Fatalf("the refused CreateChat %+v left folders %v (were %v), %d tokens (were %d), %d chats",
				tc.n, got, folders, e.tokens(), tokens, len(e.m.Views()))
		}
	}

	// A creation that fails while the chat is written takes its folder and its token back.
	if err := os.Chmod(e.st.P.Chats, 0o500); err != nil {
		t.Fatal(err)
	}
	_, err := e.m.CreateChat(NewChat{ID: id, Group: gOne})
	if cerr := os.Chmod(e.st.P.Chats, 0o700); cerr != nil {
		t.Fatal(cerr)
	}
	if err == nil {
		t.Fatal("a chat was made in a folder that cannot be written")
	}
	if got := e.chatFolders(); !reflect.DeepEqual(got, folders) || e.tokens() != tokens || len(e.m.Views()) != 1 {
		t.Fatalf("the failed creation left folders %v (were %v), %d tokens (were %d), %d chats", got, folders, e.tokens(), tokens, len(e.m.Views()))
	}
	if _, err := e.m.View(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the chat that was not made: %v", err)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("the refused creations sent %d events: %+v", len(got), got)
	}
	// Creation records nothing, refused or not.
	e.newChat(NewChat{ID: id, Group: gOne})
	if got := e.defaultsOf(); !reflect.DeepEqual(got, was) {
		t.Fatalf("the defaults after creations: %+v, were %+v", got, was)
	}
}

// ---- AC31: the choice is the group's ---------------------------------------------

func TestSecondChatStartsAsTheFirst(t *testing.T) {
	t.Parallel()
	e, _, fakes := startEnv(t, model.Claude, model.Cursor, model.Pi)
	local := func(g string) model.ServerDefaults { return e.defaultsOf().Groups[g].On(model.LocalServer) }
	first := e.newChat(NewChat{Group: gOne})
	if first.Agent != model.Claude || first.Cwd != e.cwd || first.Model != "sonnet" {
		t.Fatalf("the first chat of the group: %+v", first)
	}
	if d := e.defaultsOf(); len(d.Groups) != 0 {
		t.Fatalf(`"+" recorded defaults: %+v`, d)
	}

	// An agent change records the agent, and nothing of the model it brought.
	if err := e.m.Configure(first.ID, ConfigReq{Agent: model.Pi}); err != nil {
		t.Fatal(err)
	}
	want := model.Defaults{Groups: map[string]model.GroupDefaults{gOne: model.LocalDefaults(model.ServerDefaults{Agent: model.Pi})}}
	if d := e.defaultsOf(); !reflect.DeepEqual(d, want) {
		t.Fatalf("the defaults after an agent change: %+v, want %+v", d, want)
	}
	dir := t.TempDir()
	if err := e.m.Configure(first.ID, ConfigReq{Cwd: dir, Model: "pi-model", Effort: "low"}); err != nil {
		t.Fatal(err)
	}

	// The second "+" in the group, before any message: as the first chat is now.
	second := e.newChat(NewChat{Group: gOne})
	if second.Agent != model.Pi || second.Cwd != dir || second.Model != "pi-model" || second.Effort != "low" {
		t.Fatalf("the second chat of the group: %+v", second)
	}
	if m := e.meta(second.ID); m.SessionID == "" || m.SessionID == e.meta(first.ID).SessionID || m.Token == e.meta(first.ID).Token {
		t.Fatalf("the second chat's own: %+v", m)
	}
	// Another group, and the ungrouped chats, are not affected.
	for _, g := range []string{gTwo, model.Ungrouped} {
		if v := e.newChat(NewChat{Group: g}); v.Agent != model.Claude || v.Cwd != e.cwd || v.Model != "sonnet" {
			t.Fatalf("a chat in %s: %+v", g, v)
		}
	}
	// An agent and its model in one request, in the second chat: both are the group's now.
	if err := e.m.Configure(second.ID, ConfigReq{Agent: model.Cursor, Effort: "low"}); err != nil {
		t.Fatal(err)
	}
	if sd := local(gOne); sd.Agent != model.Cursor || sd.Cwd != dir ||
		sd.ByAgent[model.Cursor] != (model.ModelChoice{Effort: "low"}) || sd.ByAgent[model.Pi] != (model.ModelChoice{Model: "pi-model", Effort: "low"}) {
		t.Fatalf("the group's defaults: %+v", sd)
	}
	if v := e.newChat(NewChat{Group: gOne}); v.Agent != model.Cursor || v.Model != "composer-2" || v.Effort != "high" || v.Cwd != dir {
		// An effort alone is no choice of a model: Cursor's default one, with its own effort.
		t.Fatalf("the third chat of the group: %+v", v)
	}
	if d := e.defaultsOf(); len(d.Groups) != 1 || d.Groups[gOne].Server != "" {
		t.Fatalf("the defaults before any message: %+v", d)
	}

	// The first message confirms the lot, and the server with it.
	e.send(first.ID, "hello", "")
	waitFor(t, "the turn to end", func() bool { return e.view(first.ID).Usage.Turns == 1 })
	if n := spawnCounts(fakes); n != [3]int{0, 0, 1} {
		t.Fatalf("spawns: %v", n)
	}
	d := e.defaultsOf()
	if sd := d.Groups[gOne].On(model.LocalServer); d.Groups[gOne].Server != model.LocalServer || sd.Agent != model.Pi || sd.Cwd != dir ||
		sd.ByAgent[model.Pi] != (model.ModelChoice{Model: "pi-model", Effort: "low"}) || len(d.Groups) != 1 {
		t.Fatalf("the defaults after the first message: %+v", d)
	}
}

func TestWhatTheFirstMessageRecords(t *testing.T) {
	t.Parallel()
	e, _ := runEnv(t)
	bd, err := e.bds.Create("board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	// A chat on a board is where its board is: its first message records no server.
	b := e.newChat(NewChat{Board: bd.ID})
	if b.Board != bd.ID || b.Group != "" || b.Agent != model.Claude {
		t.Fatalf("a chat on a board: %+v", b)
	}
	if err := e.m.Configure(b.ID, ConfigReq{Agent: model.Cursor}); err != nil {
		t.Fatal(err)
	}
	e.send(b.ID, "hello", "")
	want := model.Defaults{Groups: map[string]model.GroupDefaults{gTwo: model.LocalDefaults(model.ServerDefaults{
		Agent: model.Cursor, Cwd: e.cwd, ByAgent: map[model.AgentKind]model.ModelChoice{model.Cursor: {Model: "composer-2", Effort: "high"}},
	})}}
	if d := e.defaultsOf(); !reflect.DeepEqual(d, want) {
		t.Fatalf("the defaults after a board chat's first message: %+v, want %+v", d, want)
	}

	// A chat on a run is where its run is, in the run's folder: it records its agent, model and
	// effort in its run's group, and no server and no folder.
	r := e.newChat(NewChat{Run: ownRun})
	if err := e.m.Configure(r.ID, ConfigReq{Agent: model.Pi, Model: "pi-model"}); err != nil {
		t.Fatal(err)
	}
	e.send(r.ID, "hello", "")
	want.Groups[gOne] = model.LocalDefaults(model.ServerDefaults{Agent: model.Pi, ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: {Model: "pi-model", Effort: e.metaOf(r).Effort}}})
	if d := e.defaultsOf(); !reflect.DeepEqual(d, want) {
		t.Fatalf("the defaults after a run chat's first message: %+v, want %+v", d, want)
	}

	// A chat in a group records the server too, with the agent it was made with.
	g := e.newChat(NewChat{Group: gOne, Agent: model.Claude})
	e.send(g.ID, "hello", "")
	entry := model.LocalDefaults(model.ServerDefaults{
		Agent: model.Claude, Cwd: e.cwd, ByAgent: map[model.AgentKind]model.ModelChoice{
			model.Claude: {Model: "sonnet", Effort: "high"}, model.Pi: want.Groups[gOne].On(model.LocalServer).ByAgent[model.Pi]},
	})
	entry.Server = model.LocalServer
	want.Groups[gOne] = entry
	if d := e.defaultsOf(); !reflect.DeepEqual(d, want) {
		t.Fatalf("the defaults after a group chat's first message: %+v, want %+v", d, want)
	}
}

// ---- AC44: only the agents the server can use ------------------------------------

func TestAgentOutsideTheList(t *testing.T) {
	t.Parallel()
	e, p, fakes := startEnv(t, model.Claude, model.Pi)
	if got := e.m.UsableAgents(); !reflect.DeepEqual(got, []model.AgentKind{model.Claude, model.Pi}) {
		t.Fatalf("UsableAgents: %v", got)
	}
	isMissing := func(when string, err error, a model.AgentKind) {
		t.Helper()
		var me *usable.MissingError
		if !errors.Is(err, usable.ErrMissing) || !errors.As(err, &me) || me.Agent != a {
			t.Fatalf("%s: %v, want the missing program of %s", when, err, a)
		}
	}

	// Creation.
	_, err := e.m.CreateChat(NewChat{Agent: model.Cursor, Group: gOne})
	isMissing("creation", err, model.Cursor)
	if want := `Cursor's program ("agent") was not found on this server: install it, or choose another agent`; err.Error() != want {
		t.Fatalf("the refusal reads %q, want %q", err, want)
	}
	_, err = e.m.Create(model.Cursor, gOne, "")
	isMissing("Create", err, model.Cursor)
	if len(e.m.Views()) != 0 {
		t.Fatal("a refused creation made a chat")
	}

	// Configuration: nothing of the request is taken.
	v := e.newChat(NewChat{Group: gOne})
	was := e.meta(v.ID)
	isMissing("configuration", e.m.Configure(v.ID, ConfigReq{Agent: model.Cursor, Cwd: t.TempDir()}), model.Cursor)
	if got := e.meta(v.ID); !reflect.DeepEqual(got, was) {
		t.Fatalf("the refused configuration left %+v, was %+v", got, was)
	}
	if d := e.defaultsOf(); len(d.Groups) != 0 {
		t.Fatalf("the refused configuration recorded defaults: %+v", d)
	}

	// The first message: the program went after the chat was made. Nothing is left, and the
	// text is kept.
	p.set(model.Pi)
	draft := model.Draft{Text: "hello"}
	if _, _, err := e.m.SetDraft(v.ID, 0, draft); err != nil {
		t.Fatal(err)
	}
	evs := e.listen()
	isMissing("the first message", e.m.Send(v.ID, "hello", "", nil), model.Claude)
	got := e.view(v.ID)
	if got.Locked || got.Status != model.StatusReady || got.Error != "" || got.Draft == nil || got.Draft.Text != "hello" || got.Agent != model.Claude {
		t.Fatalf("the chat after the refused message: %+v", got)
	}
	if len(e.items(v.ID)) != 0 || spawnCounts(fakes) != [3]int{} || len(e.defaultsOf().Groups) != 0 {
		t.Fatalf("the refused message left items %d, spawns %v, defaults %+v", len(e.items(v.ID)), spawnCounts(fakes), e.defaultsOf())
	}
	if sent := evs.drain(t, e.br); len(sent) != 0 {
		t.Fatalf("the refused message sent %d events: %+v", len(sent), sent)
	}
	// The look-up of the refusal is the list's: no wait for the next round.
	if got := e.m.UsableAgents(); !reflect.DeepEqual(got, []model.AgentKind{model.Pi}) {
		t.Fatalf("UsableAgents after the refusal: %v", got)
	}

	// The program is back: the same message goes.
	p.set(model.Claude, model.Pi)
	e.send(v.ID, "hello", "")
	waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	if n := spawnCounts(fakes); n != [3]int{1, 0, 0} {
		t.Fatalf("spawns: %v", n)
	}
	// A chat that has started is not looked at here: what its start says is the agent's own.
	p.set()
	e.send(v.ID, "again", "")
	waitFor(t, "the second turn to end", func() bool { return e.view(v.ID).Usage.Turns == 2 })
}

func TestChatWithNoAgent(t *testing.T) {
	t.Parallel()
	e, p, fakes := startEnv(t)
	e.m.Runs = &fakeRuns{runs: map[string]RunInfo{ownRun: {Group: gOne, Cwd: e.cwd, Agent: model.Claude, Model: "sonnet", Effort: "high"}}}
	if got := e.m.UsableAgents(); got == nil || len(got) != 0 {
		t.Fatalf("UsableAgents with no program: %#v, want an empty list", got)
	}
	// The chat is made all the same, in a group and on a run.
	for _, n := range []NewChat{{Group: gOne}, {Run: ownRun}} {
		v := e.newChat(n)
		m := e.metaOf(v)
		if v.Agent != "" || v.Model != "" || v.Effort != "" || v.Cwd != e.cwd || m.SessionID != "" || m.Token == "" || v.Status != model.StatusReady {
			t.Fatalf("a chat made with no usable agent (%+v): %+v, chat.json %+v", n, v, m)
		}
	}
	_, err := e.m.CreateChat(NewChat{Agent: model.Claude, Group: gOne})
	if !errors.Is(err, usable.ErrMissing) {
		t.Fatalf("a named agent with none usable: %v", err)
	}

	v := e.newChat(NewChat{Group: gTwo})
	none := func(when string, want error) {
		t.Helper()
		err := e.m.Send(v.ID, "hello", "", nil)
		if err != want || !errors.Is(err, usable.ErrNone) {
			t.Fatalf("%s, Send: %v, want %v, which is usable.ErrNone", when, err, want)
		}
		if got := e.view(v.ID); got.Locked || got.Agent != "" || got.Status != model.StatusReady || len(e.items(v.ID)) != 0 {
			t.Fatalf("%s: the refused message left %+v", when, got)
		}
	}
	none("with no usable agent", usable.ErrNone)

	// An agent that appears is not given to the chat behind the composer: the user picks it, and
	// the refusal says so, no longer that none was found.
	p.set(model.Pi)
	none("with pi installed since", usable.ErrUnchosen)
	if err := e.m.Send(v.ID, "hello", "", nil); err.Error() != "no agent is chosen: choose one of the agents this server can use" {
		t.Fatalf("the refusal with pi installed since: %q", err)
	}
	// With no look-up there is no list to choose from: the chat has no agent, and that is all.
	set := e.m.Agents
	e.m.Agents = nil
	none("with no look-up", usable.ErrNone)
	e.m.Agents = set
	if err := e.m.Configure(v.ID, ConfigReq{Model: "pi-model"}); !errors.Is(err, ErrBadChoice) {
		t.Fatalf("a model for a chat with no agent: %v, want ErrBadChoice", err)
	}
	dir := t.TempDir()
	if err := e.m.Configure(v.ID, ConfigReq{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	if sd := e.defaultsOf().Groups[gTwo].On(model.LocalServer); sd.Cwd != dir || sd.Agent != "" || len(sd.ByAgent) != 0 {
		t.Fatalf("the defaults after a folder for a chat with no agent: %+v", sd)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Pi, Model: "pi-model"}); err != nil {
		t.Fatal(err)
	}
	if m := e.meta(v.ID); m.Agent != model.Pi || m.Model != "pi-model" || m.SessionID == "" || m.Cwd != dir {
		t.Fatalf("the chat given an agent: %+v", m)
	}
	e.send(v.ID, "hello", "")
	waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	if n := spawnCounts(fakes); n != [3]int{0, 0, 1} {
		t.Fatalf("spawns: %v", n)
	}
	// A new chat now has the agent that is there.
	if w := e.newChat(NewChat{Group: gOne}); w.Agent != model.Pi {
		t.Fatalf("a chat made once pi is there: %+v", w)
	}
}

func TestStickyAgentThatIsGone(t *testing.T) {
	t.Parallel()
	e, p, _ := startEnv(t, model.Claude, model.Cursor, model.Pi)
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne:            model.LocalDefaults(model.ServerDefaults{Agent: model.Cursor}),
		model.Ungrouped: model.LocalDefaults(model.ServerDefaults{Agent: model.Pi}),
	}})
	was := e.defaultsOf()
	agentIn := func(g string) model.AgentKind { return e.newChat(NewChat{Group: g}).Agent }
	if a, b := agentIn(gOne), agentIn(gTwo); a != model.Cursor || b != model.Pi {
		t.Fatalf("with every agent usable: %s in the group, %s in a group with no value", a, b)
	}
	// The group's is gone: the ungrouped group's, which a group with no value follows.
	p.set(model.Claude, model.Pi)
	if a := agentIn(gOne); a != model.Pi {
		t.Fatalf("the group's sticky agent is gone: %s, want the ungrouped group's", a)
	}
	// Both are gone: the first usable of the fixed order.
	p.set(model.Claude)
	if a, b := agentIn(gOne), agentIn(gTwo); a != model.Claude || b != model.Claude {
		t.Fatalf("both sticky agents are gone: %s and %s, want claude", a, b)
	}
	// What is stored stays: the agent is the group's again once its program is back.
	if got := e.defaultsOf(); !reflect.DeepEqual(got, was) {
		t.Fatalf("the fallback changed the defaults: %+v, were %+v", got, was)
	}
	p.set(model.Claude, model.Cursor)
	if a, b := agentIn(gOne), agentIn(gTwo); a != model.Cursor || b != model.Claude {
		t.Fatalf("with Cursor back: %s and %s", a, b)
	}
}

func TestSubagentOfAnUnusableKind(t *testing.T) {
	t.Parallel()
	e, p, fakes := startEnv(t, model.Claude, model.Pi)
	v := e.newChat(NewChat{Group: gOne})
	e.send(v.ID, "hello", "")
	waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })
	refused := func(kind model.AgentKind, want string) {
		t.Helper()
		// Both tools go through the same check: list_subagent_models and spawn_subagent.
		if _, _, _, err := e.m.SpawnDefaults(v.ID, kind); err == nil || err.Error() != want {
			t.Fatalf("SpawnDefaults %q: %v, want %q", kind, err, want)
		}
		if _, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "work", Kind: kind}); err == nil || err.Error() != want {
			t.Fatalf("SpawnSubagent %q: %v, want %q", kind, err, want)
		}
		if subs := e.subs(v.ID); len(subs) != 0 {
			t.Fatalf("the refused spawn left a subagent: %+v", subs)
		}
	}
	refused(model.Cursor, `agent "cursor" cannot be used on this server: its program was not found. Usable: claude, pi`)
	if kind, _, _, err := e.m.SpawnDefaults(v.ID, model.Pi); err != nil || kind != model.Pi {
		t.Fatalf("SpawnDefaults for a usable kind: %q %v", kind, err)
	}
	if kind, _, _, err := e.m.SpawnDefaults(v.ID, ""); err != nil || kind != model.Claude {
		t.Fatalf("SpawnDefaults for the chat's own kind: %q %v", kind, err)
	}

	// The chat's own kind, named or not, once its program is gone.
	p.set(model.Pi)
	refused("", `agent "claude" cannot be used on this server: its program was not found. Usable: pi`)
	refused(model.Claude, `agent "claude" cannot be used on this server: its program was not found. Usable: pi`)
	p.set()
	refused(model.Pi, `agent "pi" cannot be used on this server: its program was not found. Usable: none`)
	if n := spawnCounts(fakes); n != [3]int{1, 0, 0} {
		t.Fatalf("spawns: %v, want the chat's own alone", n)
	}

	// A program that is back is found by the next call.
	p.set(model.Pi)
	sa, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "work", Kind: model.Pi})
	if err != nil || sa.Kind != model.Pi {
		t.Fatalf("a subagent of a usable kind: %+v %v", sa, err)
	}
}

// With no look-up every kind is usable: what the tests of this package that give none rely on.
func TestNoLookUpMeansEveryAgent(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if got := e.m.UsableAgents(); !reflect.DeepEqual(got, []model.AgentKind{model.Claude, model.Cursor, model.Pi}) {
		t.Fatalf("UsableAgents with no look-up: %v", got)
	}
	if v := e.newChat(NewChat{Group: gOne}); v.Agent != model.Claude {
		t.Fatalf("a chat with no agent named: %+v", v)
	}
	// Create and CreateOnRun are CreateChat: an agent is named or not.
	if v := e.create("", gOne, ""); v.Agent != model.Claude {
		t.Fatalf("Create with no agent: %+v", v)
	}
	v := e.create(model.Cursor, gOne, "")
	if err := e.m.Configure(v.ID, ConfigReq{Agent: model.Pi}); err != nil {
		t.Fatal(err)
	}
	e.send(v.ID, "hello", "")
	if e.pi.count() != 1 || e.cursor.count() != 0 {
		t.Fatalf("spawns: %d of pi, %d of Cursor", e.pi.count(), e.cursor.count())
	}
}
