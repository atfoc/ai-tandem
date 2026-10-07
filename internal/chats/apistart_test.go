package chats

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// The creation call of an API client (Start), the client mark of a chat, and "no defaults" for a
// chat that has one.

// clientX and clientY are the client ids of two API clients.
const (
	clientX = "a1a1a1a1-0000-4000-8000-00000000000a"
	clientY = "b2b2b2b2-0000-4000-8000-00000000000b"
)

// places is the Place of a creation call: it gives the group g and counts how often it was asked.
type places struct {
	g   string
	err error
	n   atomic.Int32
}

func (p *places) place() (string, error) {
	p.n.Add(1)
	return p.g, p.err
}

// startReq is a creation call of client for a Claude chat in the folder e.cwd.
func (e *env) startReq(id, client string) StartReq {
	return StartReq{ID: id, Client: client, Agent: model.Claude, Cwd: e.cwd, Text: "first of " + id[:4]}
}

// start is a creation call that must succeed.
func (e *env) start(req StartReq) StartResult {
	e.t.Helper()
	res, err := e.m.Start(req)
	if err != nil {
		e.t.Fatalf("Start %s: %v", req.ID, err)
	}
	return res
}

// markOf is the client mark the bridge has of the chat id.
func (e *env) markOf(id string) string { return e.br.MarkOf(editorbridge.Chat(id)) }

// defaultsRaw is the store's defaults as they are written.
func (e *env) defaultsRaw() string {
	e.t.Helper()
	var raw []byte
	var err error
	e.st.Read(func(s *model.State) { raw, err = json.Marshal(s.Defaults) })
	if err != nil {
		e.t.Fatal(err)
	}
	return string(raw)
}

// sticky gives both groups and the ungrouped group defaults that no marked chat may take.
func (e *env) sticky() (dir string) {
	e.t.Helper()
	dir = e.t.TempDir()
	sd := model.LocalDefaults(model.ServerDefaults{Cwd: dir, ByAgent: map[model.AgentKind]model.ModelChoice{
		model.Claude: {Model: "opus", Effort: "low"}, model.Cursor: {Model: "gpt-5.4-mini"}}})
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{gOne: sd, gTwo: sd, model.Ungrouped: sd}})
	return dir
}

// noStart is a spawner whose program does not start.
type noStart struct{ n atomic.Int32 }

func (s *noStart) Spawn(agent.SpawnOptions) (agent.Agent, error) {
	s.n.Add(1)
	return nil, errors.New("the program is not there")
}

// refusing is a spawner whose agents start and refuse every message.
type refusing struct {
	*fakeSpawner
	t *testing.T
}

func (s refusing) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	ag, err := s.fakeSpawner.Spawn(o)
	if err == nil {
		s.fakeSpawner.last(s.t).failSends(errors.New("the agent refused the message"))
	}
	return ag, err
}

const (
	idA = "0b8f3c1e-5a4d-4e2b-9c7a-1f2e3d4c5b6a"
	idB = "7d1c9a52-3b6e-4f80-a1d4-9e8c7b6a5f40"
	idC = "c3a1f0e2-9b7d-4c5a-8e6f-0a1b2c3d4e5f"
	idD = "5e6f7a8b-1c2d-4e3f-b4a5-6c7d8e9f0a1b"
	idE = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
)

// ---- the creation call ------------------------------------------------------

func TestStartMakesTheChatAndSendsOnce(t *testing.T) {
	e := newEnv(t)
	stickyDir := e.sticky()
	was := e.defaultsRaw()
	evs := e.listen()
	// A client may follow an id before its chat is there: a read notes the follow first.
	if !e.br.Follow(listenID, editorbridge.Chat(idA)) {
		t.Fatal("the listening client could not follow an id that is no chat's yet")
	}
	dir, p := t.TempDir(), &places{g: gTwo}
	req := StartReq{ID: idA, Client: clientX, Agent: model.Claude, Cwd: dir, Model: "opus", Effort: "low",
		Name: "  From afar ", UserNamed: true, Text: "hello there", Place: p.place}
	res, err := e.m.Start(req)
	if err != nil {
		t.Fatal(err)
	}
	v := res.Chat
	if !res.Exists || !res.Started || !res.Sent || !res.Tried {
		t.Fatalf("the first call's result: %+v", res)
	}
	if v.ID != idA || v.Agent != model.Claude || v.Group != gTwo || v.Cwd != dir || v.Model != "opus" || v.Effort != "low" ||
		v.Name != "From afar" || !v.Locked || v.Run != "" || v.Board != "" {
		t.Fatalf("the chat that was made: %+v", v)
	}
	meta := e.meta(idA)
	if meta.Client != clientX || !meta.UserNamed || meta.Name != "From afar" || !meta.Locked {
		t.Fatalf("chat.json of the chat that was made: %+v", meta)
	}
	if got, err := e.m.ClientOf(idA); err != nil || got != clientX || e.markOf(idA) != clientX {
		t.Fatalf("the mark: ClientOf %q %v, the bridge's %q", got, err, e.markOf(idA))
	}
	if p.n.Load() != 1 {
		t.Fatalf("the group was asked for %d times", p.n.Load())
	}
	a := e.claude.last(t)
	if e.claude.count() != 1 || len(a.sent()) != 1 || a.opts.Cwd != dir || a.opts.Model != "opus" || a.opts.Effort != "low" {
		t.Fatalf("%d processes, %d messages, options %+v", e.claude.count(), len(a.sent()), a.opts)
	}
	if got := texts(a.sent()[0]); len(got) != 1 || got[0] != "hello there" {
		t.Fatalf("the agent was sent %q", got)
	}
	e.m.naming.Wait()
	if calls := e.namer.callList(); len(calls) != 0 {
		t.Fatalf("a chat that came with its name was named: %q", calls)
	}
	// The one who followed before the chat was there is sent its content.
	evs.wait(t, func(ev map[string]any) bool { return ev["type"] == "chat_items" && ev["chat"] == idA })
	evs.wait(t, func(ev map[string]any) bool {
		c, _ := ev["chat"].(map[string]any)
		return ev["type"] == "chat" && c["id"] == idA
	})

	// A repeat finds the chat started: nothing of it is applied, nothing is sent.
	again := req
	again.Cwd, again.Model, again.Effort, again.Name, again.Text, again.Agent = t.TempDir(), "sonnet", "high", "Renamed", "hello again", model.Pi
	res, err = e.m.Start(again)
	if err != nil || !res.Exists || !res.Started || res.Sent || res.Tried {
		t.Fatalf("the repeat: %+v, %v", res, err)
	}
	e.m.naming.Wait()
	if got := e.meta(idA); !reflect.DeepEqual(got, meta) {
		t.Fatalf("the repeat changed the chat:\n%+v\nwas\n%+v", got, meta)
	}
	if res.Chat.Model != "opus" || res.Chat.Name != "From afar" || res.Chat.Agent != model.Claude || res.Chat.Cwd != dir {
		t.Fatalf("the repeat's chat: %+v", res.Chat)
	}
	if e.claude.count() != 1 || e.pi.count() != 0 || len(a.sent()) != 1 || p.n.Load() != 1 || len(e.m.Views()) != 1 {
		t.Fatalf("after the repeat: %d and %d processes, %d messages, the group asked for %d times, %d chats",
			e.claude.count(), e.pi.count(), len(a.sent()), p.n.Load(), len(e.m.Views()))
	}

	// With no model and no effort the chat gets the default of the agent's catalog, whatever is
	// sticky in its group; a model alone gets that model's effort.
	res = e.start(StartReq{ID: idB, Client: clientX, Agent: model.Claude, Cwd: dir, Text: "two", Place: p.place})
	if v := res.Chat; v.Model != "sonnet" || v.Effort != "high" || v.Cwd != dir || v.Cwd == stickyDir || v.Group != gTwo {
		t.Fatalf("a chat with no model named: %+v", v)
	}
	res = e.start(StartReq{ID: idC, Client: clientX, Agent: model.Claude, Cwd: dir, Model: "haiku", Text: "three", Place: p.place})
	if v := res.Chat; v.Model != "haiku" || v.Effort != "" {
		t.Fatalf("a chat with a model that has no efforts: %+v", v)
	}
	// With no Place the chat is in the ungrouped group.
	res = e.start(StartReq{ID: idD, Client: clientY, Agent: model.Claude, Cwd: dir, Text: "four"})
	if v := res.Chat; v.Group != model.Ungrouped || v.Model != "sonnet" {
		t.Fatalf("a chat with no place: %+v", v)
	}
	e.m.naming.Wait()
	if got := e.view(idB).Name; got != "Named title" {
		t.Fatalf("a chat that came with no name is called %q", got)
	}
	if got := e.defaultsRaw(); got != was {
		t.Fatalf("the defaults after four creation calls:\n%s\nwere\n%s", got, was)
	}
	if got := ofType(evs.drain(t, e.br), "defaults"); len(got) != 0 {
		t.Fatalf("%d defaults events", len(got))
	}
	if n := e.m.ids.held(); n != 0 {
		t.Fatalf("%d creation locks are left", n)
	}
}

func TestStartManyAtOnce(t *testing.T) {
	e := newEnv(t)
	p := &places{g: gOne}
	req := e.startReq(idA, clientX)
	req.Place = p.place
	type answer struct {
		res StartResult
		err error
	}
	const calls = 24
	got := make(chan answer, calls)
	for i := 0; i < calls; i++ {
		go func() {
			res, err := e.m.Start(req)
			got <- answer{res, err}
		}()
	}
	sent := 0
	for i := 0; i < calls; i++ {
		a := <-got
		if a.err != nil || !a.res.Exists || !a.res.Started || a.res.Chat.ID != idA {
			t.Fatalf("a call of %d at once: %+v, %v", calls, a.res, a.err)
		}
		if a.res.Sent {
			sent++
		}
	}
	if sent != 1 || e.claude.count() != 1 || len(e.claude.last(t).sent()) != 1 || len(e.m.Views()) != 1 || p.n.Load() != 1 {
		t.Fatalf("%d calls sent; %d processes, %d messages, %d chats, the group asked for %d times",
			sent, e.claude.count(), len(e.claude.last(t).sent()), len(e.m.Views()), p.n.Load())
	}
	if n := e.m.ids.held(); n != 0 {
		t.Fatalf("%d creation locks are left after %d calls at once", n, calls)
	}
	e.m.naming.Wait()
}

func TestStartChecksItsValues(t *testing.T) {
	e, _ := runEnv(t)
	p := &places{g: gOne}
	good := e.startReq(idA, clientX)
	good.Place = p.place
	for _, id := range []string{"", "x", "../../etc", strings.ToUpper(idA), idA + "\n", idA[:35],
		"0b8f3c1e-5a4d-1e2b-9c7a-1f2e3d4c5b6a", "0b8f3c1e-5a4d-4e2b-7c7a-1f2e3d4c5b6a", "{" + idA + "}"} {
		req := good
		req.ID = id
		if res, err := e.m.Start(req); !errors.Is(err, ErrBadID) || res != (StartResult{}) {
			t.Fatalf("Start with the id %q: %+v, %v, want ErrBadID", id, res, err)
		}
	}
	for what, change := range map[string]func(*StartReq){
		"no client":      func(r *StartReq) { r.Client = "" },
		"no agent":       func(r *StartReq) { r.Agent = "" },
		"no text":        func(r *StartReq) { r.Text = "" },
		"a blank text":   func(r *StartReq) { r.Text = " \n\t" },
		"no folder":      func(r *StartReq) { r.Cwd = "" },
		"a blank folder": func(r *StartReq) { r.Cwd = "  " },
	} {
		req := good
		change(&req)
		if res, err := e.m.Start(req); !errors.Is(err, ErrStartValue) || res != (StartResult{}) {
			t.Fatalf("Start with %s: %+v, %v, want ErrStartValue", what, res, err)
		}
	}
	if len(e.m.Views()) != 0 || p.n.Load() != 0 || e.claude.count() != 0 || e.m.ids.held() != 0 || len(e.chatFolders()) != 0 {
		t.Fatalf("the refused calls left %d chats, %d questions for the group, %d processes, %d locks, folders %v",
			len(e.m.Views()), p.n.Load(), e.claude.count(), e.m.ids.held(), e.chatFolders())
	}
	// A chat cannot be made with a mark and no agent by any caller: nothing would choose one.
	if _, err := e.m.CreateChat(NewChat{Client: clientX, Group: gOne}); !errors.Is(err, ErrStartValue) {
		t.Fatalf("CreateChat with a mark and no agent: %v", err)
	}
}

func TestRefusedStartLeavesNothing(t *testing.T) {
	e, _, _ := startEnv(t, model.Claude)
	e.m.Runs = &fakeRuns{runs: map[string]RunInfo{
		ownRun:  {Group: gOne, Cwd: e.cwd, Agent: model.Claude, Model: "sonnet"},
		"r_old": {Group: gOne, Cwd: e.cwd, Agent: model.Claude, Archived: true},
	}}
	file := filepath.Join(e.cwd, "a-file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	evs := e.listen()
	was, folders, tokens := e.defaultsRaw(), e.chatFolders(), e.tokens()
	p := &places{g: gTwo}
	var missing *usable.MissingError
	for what, tc := range map[string]struct {
		change func(*StartReq)
		want   func(error) bool
	}{
		"a folder that is not there": {func(r *StartReq) { r.Cwd = filepath.Join(e.cwd, "nope") },
			func(err error) bool {
				return errors.Is(err, agent.ErrFolderMissing) && errors.Is(err, ErrFolderMissing)
			}},
		"a file as the folder": {func(r *StartReq) { r.Cwd = file }, func(err error) bool { return errors.Is(err, agent.ErrFolderMissing) }},
		"the app's own folder": {func(r *StartReq) { r.Cwd = e.root }, func(err error) bool { return errors.Is(err, ErrAppFolder) }},
		"a model the catalog lacks": {func(r *StartReq) { r.Model = "no-such-model" },
			func(err error) bool { return errors.Is(err, ErrBadChoice) }},
		"an effort the model lacks": {func(r *StartReq) { r.Model, r.Effort = "haiku", "high" },
			func(err error) bool { return errors.Is(err, ErrBadChoice) }},
		"an unknown agent": {func(r *StartReq) { r.Agent = "nobody" },
			func(err error) bool { return strings.Contains(err.Error(), `unknown agent "nobody"`) }},
		"an agent the server lacks": {func(r *StartReq) { r.Agent = model.Cursor },
			func(err error) bool { return errors.As(err, &missing) && errors.Is(err, usable.ErrMissing) }},
		"a run that is not there": {func(r *StartReq) { r.Run = "r_none" }, func(err error) bool { return errors.Is(err, ErrNoRun) }},
		"a run with a bad name":   {func(r *StartReq) { r.Run = "../x" }, func(err error) bool { return errors.Is(err, ErrNoRun) }},
		"an archived run":         {func(r *StartReq) { r.Run = "r_old" }, func(err error) bool { return errors.Is(err, ErrRunArchived) }},
	} {
		req := e.startReq(idA, clientX)
		req.Place = p.place
		tc.change(&req)
		res, err := e.m.Start(req)
		if err == nil || !tc.want(err) || res != (StartResult{}) {
			t.Fatalf("Start with %s: %+v, %v", what, res, err)
		}
		if got := e.chatFolders(); !reflect.DeepEqual(got, folders) || e.tokens() != tokens || len(e.m.Views()) != 0 {
			t.Fatalf("Start with %s left folders %v, %d tokens (were %d), %d chats", what, got, e.tokens(), tokens, len(e.m.Views()))
		}
		if p.n.Load() != 0 || e.markOf(idA) != "" || e.m.ids.held() != 0 {
			t.Fatalf("Start with %s: the group was asked for %d times, the bridge's mark is %q, %d locks are left",
				what, p.n.Load(), e.markOf(idA), e.m.ids.held())
		}
	}

	// A group that cannot be given: the id was free and stays so.
	bad := &places{err: errors.New("no group to give")}
	req := e.startReq(idA, clientX)
	req.Place = bad.place
	if res, err := e.m.Start(req); !errors.Is(err, bad.err) || res != (StartResult{}) || bad.n.Load() != 1 {
		t.Fatalf("Start whose group cannot be given: %+v, %v, asked %d times", res, err, bad.n.Load())
	}
	if got := e.chatFolders(); !reflect.DeepEqual(got, folders) || e.tokens() != tokens || len(e.m.Views()) != 0 || e.markOf(idA) != "" {
		t.Fatalf("it left folders %v, %d tokens, %d chats, the mark %q", got, e.tokens(), len(e.m.Views()), e.markOf(idA))
	}

	// A creation that fails while the chat is written leaves no mark either.
	if err := os.Chmod(e.st.P.Chats, 0o500); err != nil {
		t.Fatal(err)
	}
	req.Place = p.place
	res, err := e.m.Start(req)
	if cerr := os.Chmod(e.st.P.Chats, 0o700); cerr != nil {
		t.Fatal(cerr)
	}
	if err == nil || res != (StartResult{}) || e.markOf(idA) != "" || len(e.m.Views()) != 0 || e.tokens() != tokens {
		t.Fatalf("Start in a folder that cannot be written: %+v, %v; the mark %q, %d chats", res, err, e.markOf(idA), len(e.m.Views()))
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("the refused calls sent %d events: %+v", len(got), got)
	}
	if got := e.defaultsRaw(); got != was || e.m.ids.held() != 0 {
		t.Fatalf("the defaults after the refused calls: %s, were %s; %d locks", got, was, e.m.ids.held())
	}
	// The id is free: the next call makes the chat.
	if res := e.start(req); !res.Sent || !res.Started || res.Chat.Group != gTwo {
		t.Fatalf("the call after the refused ones: %+v", res)
	}
}

func TestStartAgainAfterAFailedStart(t *testing.T) {
	e := newEnv(t)
	e.sticky()
	was := e.defaultsRaw()
	dirA, dirB := t.TempDir(), t.TempDir()
	p := &places{g: gTwo}
	gone := &noStart{}
	e.m.Spawners[model.Claude] = gone
	evs := e.listen()

	first := StartReq{ID: idA, Client: clientX, Agent: model.Claude, Cwd: dirA, Model: "opus", Effort: "low",
		Name: "First try", UserNamed: true, Text: "hello", Place: p.place}
	res, err := e.m.Start(first)
	if err == nil || !res.Tried || res.Sent || !res.Exists || res.Started || gone.n.Load() != 1 {
		t.Fatalf("a start whose program does not start: %+v, %v (%d starts)", res, err, gone.n.Load())
	}
	if v := res.Chat; v.ID != idA || v.Locked || v.Model != "opus" || v.Cwd != dirA || v.Name != "First try" || v.Group != gTwo {
		t.Fatalf("the chat the failed start left: %+v", v)
	}
	if len(e.items(idA)) != 0 || e.markOf(idA) != clientX {
		t.Fatalf("the failed start left %d items, the mark %q", len(e.items(idA)), e.markOf(idA))
	}
	// The same call again fails the same way and makes no second chat.
	if res, err := e.m.Start(first); err == nil || !res.Tried || res.Sent || res.Started || len(e.m.Views()) != 1 || gone.n.Load() != 2 {
		t.Fatalf("the same call again: %+v, %v", res, err)
	}

	// A retry with another agent, folder, model and name applies them all, and sends.
	res, err = e.m.Start(StartReq{ID: idA, Client: clientX, Agent: model.Cursor, Cwd: dirB, Model: "gpt-5.4-mini",
		Name: "Second try", Text: "hello again", Place: p.place})
	if err != nil || !res.Tried || !res.Sent || !res.Exists || !res.Started {
		t.Fatalf("the retry: %+v, %v", res, err)
	}
	v := res.Chat
	if v.Agent != model.Cursor || v.Cwd != dirB || v.Model != "gpt-5.4-mini" || v.Effort != "" || v.Name != "Second try" || !v.Locked || v.Error != "" {
		t.Fatalf("the chat after the retry: %+v", v)
	}
	if meta := e.meta(idA); meta.UserNamed || meta.Client != clientX || meta.Group != gTwo {
		t.Fatalf("chat.json after the retry: %+v", meta)
	}
	a := e.cursor.last(t)
	if e.cursor.count() != 1 || a.opts.Cwd != dirB || a.opts.Model != "gpt-5.4-mini" || len(a.sent()) != 1 {
		t.Fatalf("the retry's process: %d, %+v, %d messages", e.cursor.count(), a.opts, len(a.sent()))
	}
	if p.n.Load() != 1 || len(e.m.Views()) != 1 {
		t.Fatalf("the group was asked for %d times; %d chats", p.n.Load(), len(e.m.Views()))
	}

	// A retry that names no model gets the catalog's default, not the one of the call before.
	if _, err := e.m.Start(StartReq{ID: idB, Client: clientX, Agent: model.Claude, Cwd: dirA, Model: "opus", Effort: "low", Text: "b", Place: p.place}); err == nil {
		t.Fatal("the second chat's program started")
	}
	e.m.Spawners[model.Claude] = e.claude
	res = e.start(StartReq{ID: idB, Client: clientX, Agent: model.Claude, Cwd: dirA, Text: "b again", Place: p.place})
	if v := res.Chat; v.Model != "sonnet" || v.Effort != "high" || !res.Sent || v.Error != "" {
		t.Fatalf("a retry with no model named: %+v", res)
	}

	// With a catalog that is not known a model and an effort that are not named are none.
	e.m.Spawners[model.Pi] = gone
	if _, err := e.m.Start(StartReq{ID: idC, Client: clientX, Agent: model.Pi, Cwd: dirA, Model: "pi-big", Effort: "high", Text: "c", Place: p.place}); err == nil {
		t.Fatal("the third chat's program started")
	}
	if meta := e.meta(idC); meta.Model != "pi-big" || meta.Effort != "high" {
		t.Fatalf("the third chat as its failed start left it: %+v", meta)
	}
	e.m.Spawners[model.Pi] = e.pi
	res = e.start(StartReq{ID: idC, Client: clientX, Agent: model.Pi, Cwd: dirA, Model: "pi-small", Text: "c again", Place: p.place})
	if v := res.Chat; v.Model != "pi-small" || v.Effort != "" || e.pi.last(t).opts.Effort != "" {
		t.Fatalf("a retry with a model and no effort: %+v", v)
	}

	e.m.naming.Wait()
	if got := e.defaultsRaw(); got != was {
		t.Fatalf("the defaults after the retries:\n%s\nwere\n%s", got, was)
	}
	if got := ofType(evs.drain(t, e.br), "defaults"); len(got) != 0 || e.m.ids.held() != 0 {
		t.Fatalf("%d defaults events, %d locks", len(got), e.m.ids.held())
	}
}

func TestStartWhenTheAgentRefusesTheMessage(t *testing.T) {
	e := newEnv(t)
	e.m.Spawners[model.Pi] = refusing{e.pi, t}
	req := e.startReq(idA, clientX)
	req.Agent = model.Pi
	res, err := e.m.Start(req)
	if err == nil || !strings.Contains(err.Error(), "refused the message") {
		t.Fatalf("a start whose agent refuses the message: %v", err)
	}
	if !res.Tried || !res.Sent || !res.Exists || !res.Started || !res.Chat.Locked {
		t.Fatalf("its result: %+v", res)
	}
	a := e.pi.last(t)
	items := e.items(idA)
	if len(items) == 0 || items[0].Kind != "user" || items[0].Text != req.Text || a.refused() != 1 {
		t.Fatalf("the thread after the refusal: %+v (%d refusals)", items, a.refused())
	}
	// The repeat finds the chat started and sends nothing.
	res, err = e.m.Start(req)
	if err != nil || res.Sent || res.Tried || !res.Started || !res.Exists {
		t.Fatalf("the repeat: %+v, %v", res, err)
	}
	if a.refused() != 1 || len(a.sent()) != 0 || e.pi.count() != 1 || len(e.items(idA)) != len(items) {
		t.Fatalf("the repeat reached the agent: %d refusals, %d messages, %d processes", a.refused(), len(a.sent()), e.pi.count())
	}
	e.m.naming.Wait()
}

func TestStartWithATakenID(t *testing.T) {
	e, fr := runEnv(t)
	fr.set("r_two", RunInfo{Group: gOne, Cwd: e.cwd, Agent: model.Claude, Model: "sonnet"})
	p := &places{g: gTwo}
	taken := func(what string, req StartReq) {
		t.Helper()
		req.Place = p.place
		asked, folders, procs := p.n.Load(), e.chatFolders(), e.claude.count()
		res, err := e.m.Start(req)
		if !errors.Is(err, ErrIDTaken) || res != (StartResult{}) {
			t.Fatalf("Start with the id of %s: %+v, %v, want ErrIDTaken", what, res, err)
		}
		if p.n.Load() != asked || !reflect.DeepEqual(e.chatFolders(), folders) || e.claude.count() != procs || e.m.ids.held() != 0 {
			t.Fatalf("Start with the id of %s asked for the group, left a folder, a process or a lock", what)
		}
	}

	// A chat made on this server, and one of another client.
	e.newChat(NewChat{ID: idA, Agent: model.Claude, Group: gOne})
	taken("a chat with no mark", e.startReq(idA, clientX))
	other := e.startReq(idB, clientY)
	other.Place = p.place
	e.start(other)
	e.m.naming.Wait()
	metaB := e.meta(idB)
	taken("another client's chat", e.startReq(idB, clientX))
	if got := e.meta(idB); !reflect.DeepEqual(got, metaB) || e.markOf(idB) != clientY {
		t.Fatalf("another client's chat after the call: %+v, mark %q", got, e.markOf(idB))
	}

	// A fork of the caller's own chat has its mark, and is no chat a creation call finds.
	e.claude.last(t).emit(t, reply("1")...)
	fork := e.fork(idB, 3)
	if e.meta(fork.ID).Client != clientY {
		t.Fatalf("the fork's mark: %q", e.meta(fork.ID).Client)
	}
	taken("a fork", e.startReq(fork.ID, clientY))

	// A chat on a run: the call must name that run.
	onRun := e.startReq(idC, clientX)
	onRun.Run, onRun.Place = ownRun, p.place
	e.start(onRun)
	taken("a chat on a run, with no run named", e.startReq(idC, clientX))
	elsewhere := e.startReq(idC, clientX)
	elsewhere.Run = "r_two"
	taken("a chat on another run", elsewhere)
	plain := e.startReq(idD, clientX)
	plain.Place = p.place
	e.start(plain)
	moved := e.startReq(idD, clientX)
	moved.Run = ownRun
	taken("a plain chat, with a run named", moved)

	// A run agent's chat, loaded or not, and a folder that holds no chat that could be read.
	const agentID, unloaded, strayOnRun, stray = "1f2e3d4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f", "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
		"3b4c5d6e-7f8a-4b9c-8d0e-2f3a4b5c6d7e", "4c5d6e7f-8a9b-4c0d-9e1f-3a4b5c6d7e8f"
	e.agentChat(agentID, model.RoleTask, model.Claude)
	taken("a run agent's chat", e.startReq(agentID, clientX))
	sameRun := e.startReq(agentID, clientX)
	sameRun.Run = ownRun
	taken("a run agent's chat, with its run named", sameRun)
	for _, dir := range []string{e.st.P.RunChatDir("r_two", true, unloaded), e.st.P.RunChatDir("r_two", false, strayOnRun), e.st.P.ChatDir(stray)} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	taken("a run agent's chat that is not loaded", e.startReq(unloaded, clientX))
	taken("a folder among a run's chats", e.startReq(strayOnRun, clientX))
	taken("a folder among the chats", e.startReq(stray, clientX))
	// The page's creation with an id answers the same for them.
	for _, id := range []string{agentID, unloaded, strayOnRun, stray} {
		if _, err := e.m.CreateChat(NewChat{ID: id, Agent: model.Claude, Group: gOne}); !errors.Is(err, ErrIDTaken) {
			t.Fatalf("CreateChat with the id %s: %v, want ErrIDTaken", id, err)
		}
	}

	// The id of a chat that was deleted is free again, for any client.
	if err := e.m.Delete(idD); err != nil {
		t.Fatal(err)
	}
	if e.markOf(idD) != "" {
		t.Fatalf("the mark of the deleted chat: %q", e.markOf(idD))
	}
	again := e.startReq(idD, clientY)
	again.Place = p.place
	res := e.start(again)
	if !res.Sent || !res.Started || res.Chat.ID != idD || e.markOf(idD) != clientY || e.meta(idD).Client != clientY {
		t.Fatalf("a creation with the id of a deleted chat: %+v, mark %q", res, e.markOf(idD))
	}
	e.m.naming.Wait()
}

func TestStartOnARun(t *testing.T) {
	e, _ := runEnv(t)
	e.sticky()
	was := e.defaultsRaw()
	p := &places{g: gTwo}
	req := StartReq{ID: idA, Client: clientX, Run: ownRun, Agent: model.Claude, Cwd: t.TempDir(), Text: "about the run", Place: p.place}
	res := e.start(req)
	v := res.Chat
	if !res.Sent || !res.Started || v.Run != ownRun || v.Cwd != e.cwd || v.Group != "" || v.Model != "sonnet" || v.Effort != "high" {
		t.Fatalf("a chat made on a run: %+v", res)
	}
	if p.n.Load() != 0 {
		t.Fatalf("the group was asked for %d times for a chat on a run", p.n.Load())
	}
	if meta := e.runMeta(idA, false); meta.Client != clientX || meta.Run != ownRun || meta.Group != "" {
		t.Fatalf("its chat.json: %+v", meta)
	}
	if e.markOf(idA) != clientX {
		t.Fatalf("its mark in the bridge: %q", e.markOf(idA))
	}
	a := e.claude.last(t)
	if a.opts.Cwd != e.cwd || len(a.sent()) != 1 {
		t.Fatalf("its process: %+v, %d messages", a.opts, len(a.sent()))
	}
	if got := texts(a.sent()[0]); len(got) != 2 || !strings.Contains(got[0], ownRun) || got[1] != "about the run" {
		t.Fatalf("the agent was sent %q", got)
	}
	// With no folder named too, and of another agent kind than the run's: the catalog's default.
	req = StartReq{ID: idB, Client: clientX, Run: ownRun, Agent: model.Cursor, Text: "no folder"}
	if v := e.start(req).Chat; v.Cwd != e.cwd || v.Model != "composer-2" || v.Effort != "high" || v.Run != ownRun {
		t.Fatalf("a chat made on a run with no folder named: %+v", v)
	}
	e.m.naming.Wait()
	if got := e.defaultsRaw(); got != was {
		t.Fatalf("the defaults after chats on a run:\n%s\nwere\n%s", got, was)
	}
	if got := e.m.ViewsOf(clientX); len(got) != 2 {
		t.Fatalf("the client's chats: %+v", got)
	}
}

// ---- the mark -----------------------------------------------------------------

func TestClientMarkOnForksAndBranches(t *testing.T) {
	e := newEnv(t)
	req := e.startReq(idA, clientX)
	e.start(req)
	a := e.claude.last(t)
	a.emit(t, reply("1")...)
	e.turn(idA, a, 2)
	e.m.naming.Wait()

	fork := e.fork(idA, 3)
	if e.meta(fork.ID).Client != clientX || e.markOf(fork.ID) != clientX {
		t.Fatalf("a fork: chat.json has %q, the bridge %q", e.meta(fork.ID).Client, e.markOf(fork.ID))
	}
	if got, err := e.m.ClientOf(fork.ID); err != nil || got != clientX {
		t.Fatalf("ClientOf the fork: %q, %v", got, err)
	}
	early := e.fork(idA, 0) // a fork at the start has started nothing
	if e.meta(early.ID).Client != clientX || e.markOf(early.ID) != clientX {
		t.Fatalf("a fork at the start: chat.json has %q, the bridge %q", e.meta(early.ID).Client, e.markOf(early.ID))
	}
	again := e.fork(fork.ID, 3) // a fork of a fork
	if e.meta(again.ID).Client != clientX || e.markOf(again.ID) != clientX {
		t.Fatalf("a fork of a fork: chat.json has %q, the bridge %q", e.meta(again.ID).Client, e.markOf(again.ID))
	}
	_, bid, _ := e.branchTo(idA, newAt(3), "aside")
	if got := e.meta(bid).Client; got != clientX {
		t.Fatalf("a branch's chat.json has the mark %q", got)
	}
	c, err := e.m.get(bid)
	if err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	inMemory := c.meta.Client
	c.mu.Unlock()
	if inMemory != clientX {
		t.Fatalf("a branch's chat object has the mark %q", inMemory)
	}

	// A fork that fails leaves no mark in the bridge.
	var failed atomic.Value
	e.claude.set(func(s *fakeSpawner) {
		s.forkErr = errors.New("no fork")
		s.onFork = func(o agent.SpawnOptions) { failed.Store(o.ChatID) }
	})
	if _, err := e.m.Fork(idA, ForkReq{Branch: model.MainBranch, At: 3}); err == nil {
		t.Fatal("the fork did not fail")
	}
	e.claude.set(func(s *fakeSpawner) { s.forkErr, s.onFork = nil, nil })
	if id, _ := failed.Load().(string); id == "" || id == idA || e.markOf(id) != "" {
		t.Fatalf("the failed fork %q has the mark %q", id, e.markOf(id))
	}

	// A chat made on this server has none, and neither has its fork, whoever asks for it.
	plain, pa := e.talked(model.Claude, "", 1)
	_ = pa
	pf := e.fork(plain, 3)
	if e.meta(plain).Client != "" || e.meta(pf.ID).Client != "" || e.markOf(plain) != "" || e.markOf(pf.ID) != "" {
		t.Fatalf("a chat of this server or its fork has a mark")
	}
	if got, err := e.m.ClientOf(plain); err != nil || got != "" {
		t.Fatalf("ClientOf a chat of this server: %q, %v", got, err)
	}
	if _, err := e.m.ClientOf("nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ClientOf no chat: %v", err)
	}

	// After a restart on the same folder the bridge is told again.
	e.boot()
	for _, id := range []string{idA, fork.ID, early.ID, again.ID} {
		if e.markOf(id) != clientX {
			t.Fatalf("after a restart the bridge has the mark %q of %s", e.markOf(id), id)
		}
	}
	if e.markOf(plain) != "" || e.markOf(pf.ID) != "" {
		t.Fatal("after a restart a chat of this server has a mark")
	}
	if got := e.m.ViewsOf(clientX); len(got) != 4 {
		t.Fatalf("after a restart the client has %d chats", len(got))
	}

	// A delete takes the mark away with its chat_removed; the other chats keep theirs.
	if err := e.m.Delete(idA); err != nil {
		t.Fatal(err)
	}
	if e.markOf(idA) != "" || e.markOf(fork.ID) != clientX {
		t.Fatalf("after the delete: the chat's mark %q, its fork's %q", e.markOf(idA), e.markOf(fork.ID))
	}
	if got := e.m.ViewsOf(clientX); len(got) != 3 {
		t.Fatalf("after the delete the client has %d chats", len(got))
	}
}

func TestClientMarkOfARunsChats(t *testing.T) {
	e, fr := runEnv(t)
	onRun := e.startReq(idA, clientX)
	onRun.Run = ownRun
	e.start(onRun)
	e.m.naming.Wait()
	// A removal that sends no chat_removed takes the mark away itself.
	const agentID = "1f2e3d4c-5b6a-4c7d-8e9f-0a1b2c3d4e5f"
	e.agentChat(agentID, model.RoleTask, model.Claude)
	e.br.SetMark(editorbridge.Chat(agentID), clientX)
	e.reboot(fr)
	if e.markOf(idA) != clientX {
		t.Fatalf("after a restart the bridge has the mark %q of a chat on a run", e.markOf(idA))
	}
	e.br.SetMark(editorbridge.Chat(agentID), clientX)
	if err := e.m.DeleteOwned(agentID); err != nil {
		t.Fatal(err)
	}
	if e.markOf(agentID) != "" || e.m.ids.held() != 0 {
		t.Fatalf("after DeleteOwned: the mark %q, %d locks", e.markOf(agentID), e.m.ids.held())
	}
}

func TestViewsAndStatesOfAClient(t *testing.T) {
	e := newEnv(t)
	ids := func(vs []model.ChatView) []string {
		out := []string{}
		for _, v := range vs {
			out = append(out, v.ID)
		}
		sort.Strings(out)
		return out
	}
	chatsOf := func(sts []model.BranchState) map[string]int {
		out := map[string]int{}
		for _, s := range sts {
			out[s.Chat]++
		}
		return out
	}
	for _, client := range []string{clientX, clientY, ""} {
		if vs, sts := e.m.ViewsOf(client), e.m.StatesOf(client); vs == nil || sts == nil || len(vs) != 0 || len(sts) != 0 {
			t.Fatalf("with no chats, of %q: %#v, %#v", client, vs, sts)
		}
	}
	e.start(e.startReq(idA, clientX))
	a := e.claude.last(t)
	a.emit(t, reply("1")...)
	e.start(e.startReq(idB, clientX))
	e.start(e.startReq(idC, clientY))
	own := e.create(model.Claude, gOne, "")
	fork := e.fork(idA, 3)
	e.branchTo(idA, newAt(3), "aside")
	e.m.naming.Wait()

	wantX := []string{idA, idB, fork.ID}
	sort.Strings(wantX)
	if got := ids(e.m.ViewsOf(clientX)); !reflect.DeepEqual(got, wantX) {
		t.Fatalf("ViewsOf X: %v, want %v", got, wantX)
	}
	if got := ids(e.m.ViewsOf(clientY)); !reflect.DeepEqual(got, []string{idC}) {
		t.Fatalf("ViewsOf Y: %v", got)
	}
	if got := e.m.ViewsOf(""); got == nil || len(got) != 0 {
		t.Fatalf("ViewsOf no client: %#v", got)
	}
	if got := e.m.ViewsOf("c3c3c3c3-0000-4000-8000-00000000000c"); got == nil || len(got) != 0 {
		t.Fatalf("ViewsOf a client with no chats: %#v", got)
	}
	if got := len(e.m.Views()); got != 5 {
		t.Fatalf("Views has %d chats", got)
	}
	if got := chatsOf(e.m.StatesOf(clientX)); !reflect.DeepEqual(got, map[string]int{idA: 2, idB: 1, fork.ID: 1}) {
		t.Fatalf("StatesOf X: %v", got)
	}
	if got := chatsOf(e.m.StatesOf(clientY)); !reflect.DeepEqual(got, map[string]int{idC: 1}) {
		t.Fatalf("StatesOf Y: %v", got)
	}
	if got := e.m.StatesOf(""); got == nil || len(got) != 0 {
		t.Fatalf("StatesOf no client: %#v", got)
	}
	if got := chatsOf(e.m.States()); len(got) != 5 || got[own.ID] != 1 || got[idA] != 2 {
		t.Fatalf("States: %v", got)
	}
	// A view of a client's chat is the one every caller gets.
	for _, v := range e.m.ViewsOf(clientX) {
		if v != e.view(v.ID) {
			t.Fatalf("ViewsOf gives %+v, View %+v", v, e.view(v.ID))
		}
	}
}

// ---- no defaults --------------------------------------------------------------

func TestMarkedChatFeedsAndReadsNoDefaults(t *testing.T) {
	e := newEnv(t)
	stickyDir := e.sticky()
	was := e.defaultsRaw()
	evs := e.listen()
	dirA, dirB := t.TempDir(), t.TempDir()
	same := func(after string) {
		t.Helper()
		e.m.naming.Wait()
		if got := e.defaultsRaw(); got != was {
			t.Fatalf("the defaults after %s:\n%s\nwere\n%s", after, got, was)
		}
		if got := ofType(evs.drain(t, e.br), "defaults"); len(got) != 0 {
			t.Fatalf("%d defaults events after %s", len(got), after)
		}
	}
	configure := func(id string, req ConfigReq) {
		t.Helper()
		if err := e.m.Configure(id, req); err != nil {
			t.Fatalf("Configure %s %+v: %v", id, req, err)
		}
	}
	p := &places{g: gTwo}

	// Creation and the first message.
	req := StartReq{ID: idA, Client: clientX, Agent: model.Claude, Cwd: dirA, Model: "claude-fable-5-1", Effort: "max", Text: "one", Place: p.place}
	e.start(req)
	a := e.claude.last(t)
	same("a creation call")

	// A marked chat that has not started: made, configured, moved, configured, sent to.
	v, err := e.m.CreateChat(NewChat{ID: idB, Client: clientX, Agent: model.Claude, Group: gTwo})
	if err != nil {
		t.Fatal(err)
	}
	if v.Model != "sonnet" || v.Effort != "high" || v.Cwd != e.cwd || v.Cwd == stickyDir || e.markOf(idB) != clientX {
		t.Fatalf("a marked chat's creation took a sticky value: %+v", v)
	}
	same("a marked chat's creation")
	configure(idB, ConfigReq{Agent: model.Cursor})
	if v := e.view(idB); v.Agent != model.Cursor || v.Model != "composer-2" || v.Effort != "high" {
		t.Fatalf("a marked chat's agent change took a sticky value: %+v", v)
	}
	same("an agent change")
	configure(idB, ConfigReq{Model: "gpt-5.4-mini"})
	configure(idB, ConfigReq{Cwd: dirB})
	configure(idB, ConfigReq{Server: model.LocalServer, Agent: model.Claude, Model: "opus", Effort: "medium", Cwd: dirA})
	same("configure with agent, model and folder")
	if err := e.m.Move(idB, gOne); err != nil {
		t.Fatal(err)
	}
	configure(idB, ConfigReq{Agent: model.Cursor})
	if v := e.view(idB); v.Group != gOne || v.Model != "composer-2" {
		t.Fatalf("after the move, an agent change took a sticky value: %+v", v)
	}
	configure(idB, ConfigReq{Agent: model.Claude, Model: "opus", Effort: "xhigh", Cwd: dirB})
	same("configure after a move to another group")
	e.send(idB, "first, from the owner", "")
	b := e.claude.last(t)
	same("the first message after a move")
	if err := e.m.Move(idB, model.Ungrouped); err != nil {
		t.Fatal(err)
	}
	same("a move to the ungrouped group")

	// A fork: at the start (nothing fixed yet) and after a turn, configured and sent to.
	a.emit(t, reply("1")...)
	early := e.fork(idA, 0)
	configure(early.ID, ConfigReq{Model: "opus", Effort: "low", Cwd: dirB})
	if err := e.m.Move(early.ID, gOne); err != nil {
		t.Fatal(err)
	}
	configure(early.ID, ConfigReq{Model: "sonnet", Cwd: dirA})
	e.send(early.ID, "the fork's first", "")
	same("a fork's configure and first message")
	fresh := e.fork(idA, 3)
	configure(fresh.ID, ConfigReq{Model: "opus"})
	same("a started fork's configure")

	// A subagent of another kind than the chat's gets that kind's catalog default.
	b.emit(t, reply("1")...)
	sub := e.spawn(idB, SpawnSubRequest{Prompt: "look", Kind: model.Cursor})
	if child := waitChild(t, e.cursor, 1); child.opts.Model != "composer-2" || child.opts.Effort != "high" || sub.Model != "composer-2" {
		t.Fatalf("a marked chat's subagent took a sticky value: %+v, %+v", child.opts, sub)
	}
	same("a subagent of another kind")

	// A folder fix, on a chat with a branch: the new folder is the chat's and no default.
	e.branchTo(idA, newAt(3), "aside")
	e.m.Stop(idA)
	if err := os.Remove(dirA); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Open(idA); err != nil {
		t.Fatal(err)
	}
	if v := e.view(idA); !v.FolderMissing {
		t.Fatalf("the chat whose folder is gone: %+v", v)
	}
	configure(idA, ConfigReq{Cwd: dirB})
	if v := e.view(idA); v.FolderMissing || v.Cwd != dirB || e.meta(idA).Cwd != dirB {
		t.Fatalf("after the folder fix: %+v, main's folder %q", v, e.meta(idA).Cwd)
	}
	same("a folder fix on a branch")
	if err := e.m.Move(idA, gOne); err != nil {
		t.Fatal(err)
	}
	e.m.Stop(idA)
	if err := os.Remove(dirB); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Open(idA); err != nil {
		t.Fatal(err)
	}
	fixed := t.TempDir()
	configure(idA, ConfigReq{Cwd: fixed})
	if v := e.view(idA); v.FolderMissing || v.Cwd != fixed {
		t.Fatalf("after the second folder fix: %+v", v)
	}
	same("a folder fix after a move")

	// The same on a chat with no mark does record: the checks above can fail.
	own := e.create(model.Claude, gTwo, "")
	configure(own.ID, ConfigReq{Model: "haiku"})
	if got := e.defaultsRaw(); got == was {
		t.Fatal("a chat of this server recorded no default")
	}
}

// ---- a delete that crosses a creation ------------------------------------------

// A creation call with the id of a chat that is being deleted waits until the delete has sent
// chat_removed: the bridge drops the mark with that event, and would drop the new chat's.
func TestStartWaitsForADeleteOfItsID(t *testing.T) {
	e := newEnv(t)
	e.start(e.startReq(idA, clientX))
	e.claude.last(t).emit(t, reply("1")...)
	// After a restart the chat is not loaded: its stop sends nothing, so chat_removed is the
	// delete's only event.
	e.boot()
	evs := e.listen()
	old, err := e.m.get(idA)
	if err != nil {
		t.Fatal(err)
	}

	// The delete is held just before it sends chat_removed, which goes out under the chat's
	// goneMu: the chat is out of the map, its folder is gone, and the bridge still has the old mark.
	old.goneMu.Lock()
	held := true
	release := func() {
		if held {
			held = false
			old.goneMu.Unlock()
		}
	}
	defer release()
	deleted := make(chan error, 1)
	go func() { deleted <- e.m.Delete(idA) }()
	waitFor(t, "the chat to leave the map and its folder to go", func() bool {
		_, gerr := e.m.get(idA)
		_, serr := os.Stat(e.st.P.ChatDir(idA))
		return gerr != nil && os.IsNotExist(serr)
	})
	if e.markOf(idA) != clientX {
		t.Fatalf("the mark before chat_removed: %q", e.markOf(idA))
	}

	type answer struct {
		res StartResult
		err error
	}
	started := make(chan answer, 1)
	go func() {
		res, err := e.m.Start(e.startReq(idA, clientY))
		started <- answer{res, err}
	}()
	select {
	case a := <-started:
		t.Fatalf("the creation call did not wait for the delete: %+v, %v", a.res, a.err)
	case err := <-deleted:
		t.Fatalf("the delete got past its chat_removed: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	if _, err := e.m.get(idA); err == nil || e.markOf(idA) != clientX {
		t.Fatalf("while the delete waits: the chat is there (%v), the mark is %q", err == nil, e.markOf(idA))
	}

	release()
	if err := <-deleted; err != nil {
		t.Fatal(err)
	}
	a := <-started
	if a.err != nil || !a.res.Sent || !a.res.Started || a.res.Chat.ID != idA {
		t.Fatalf("the creation call after the delete: %+v, %v", a.res, a.err)
	}
	if got, err := e.m.ClientOf(idA); err != nil || got != clientY || e.markOf(idA) != clientY {
		t.Fatalf("the new chat's mark: %q (%v), the bridge's %q", got, err, e.markOf(idA))
	}
	// The old chat's chat_removed went out before anything of the new chat.
	e.m.naming.Wait()
	removed, made := -1, -1
	for i, ev := range evs.drain(t, e.br) {
		c, _ := ev["chat"].(map[string]any)
		switch {
		case ev["type"] == "chat_removed" && ev["id"] == idA:
			if removed >= 0 {
				t.Fatal("chat_removed was sent twice")
			}
			removed = i
		case ev["type"] == "chat" && c["id"] == idA && made < 0:
			made = i
		}
	}
	if removed < 0 || made < 0 || removed > made {
		t.Fatalf("chat_removed is event %d, the new chat's first event %d", removed, made)
	}
	if n := e.m.ids.held(); n != 0 {
		t.Fatalf("%d creation locks are left", n)
	}
}

// A delete that began before a creation call got to its send is seen by the call: no process is
// started for a chat that is going.
func TestStartOfAChatThatIsBeingDeleted(t *testing.T) {
	e := newEnv(t)
	gone := &noStart{}
	e.m.Spawners[model.Claude] = gone
	if _, err := e.m.Start(e.startReq(idA, clientX)); err == nil {
		t.Fatal("the program started")
	}
	e.m.Spawners[model.Claude] = e.claude
	c, err := e.m.get(idA)
	if err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	c.removing = true // as remove sets it before it stops the chat
	c.mu.Unlock()
	res, err := e.m.Start(e.startReq(idA, clientX))
	if !errors.Is(err, ErrNotFound) || res != (StartResult{}) || e.claude.count() != 0 {
		t.Fatalf("a creation call for a chat that is being deleted: %+v, %v, %d processes", res, err, e.claude.count())
	}
	if err := e.m.Delete(idA); err != nil {
		t.Fatal(err)
	}
	if res := e.start(e.startReq(idA, clientX)); !res.Sent || e.claude.count() != 1 {
		t.Fatalf("the call after the delete: %+v", res)
	}
	e.m.naming.Wait()
}

// ---- the group "Remote" in the state ---------------------------------------------

func TestRemoteGroupIsKeptInTheState(t *testing.T) {
	e := newEnv(t)
	stateFile := func() map[string]any {
		t.Helper()
		raw, err := os.ReadFile(e.st.P.State)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	if _, ok := stateFile()["remoteGroup"]; ok {
		t.Fatal("state.json names a group \"Remote\" before any was made")
	}
	if err := e.st.Update(func(s *model.State) error { s.RemoteGroup = gTwo; return nil }); err != nil {
		t.Fatal(err)
	}
	if got := stateFile()["remoteGroup"]; got != gTwo {
		t.Fatalf("state.json has remoteGroup %v", got)
	}
	e.boot()
	var got string
	e.st.Read(func(s *model.State) { got = s.RemoteGroup })
	if got != gTwo {
		t.Fatalf("after a restart the state's RemoteGroup is %q", got)
	}
}

// ---- the creation locks ---------------------------------------------------------

func TestIDLocksLeaveNothing(t *testing.T) {
	var l idLocks
	if l.held() != 0 {
		t.Fatal("a new set of locks holds one")
	}
	unlock := l.lock("a")
	other := l.lock("b") // another id does not wait
	if l.held() != 2 {
		t.Fatalf("%d locks with two held", l.held())
	}
	const waiters = 24
	var in, most atomic.Int32
	done := make(chan struct{}, waiters)
	for i := 0; i < waiters; i++ {
		go func() {
			u := l.lock("a")
			if n := in.Add(1); n > most.Load() {
				most.Store(n)
			}
			time.Sleep(time.Millisecond)
			in.Add(-1)
			u()
			done <- struct{}{}
		}()
	}
	waitFor(t, "the waiters", func() bool {
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.m["a"].n == waiters+1
	})
	if in.Load() != 0 {
		t.Fatal("a waiter got the lock while it was held")
	}
	other()
	unlock()
	for i := 0; i < waiters; i++ {
		<-done
	}
	if most.Load() != 1 || l.held() != 0 {
		t.Fatalf("%d held the lock of one id at once; %d locks are left", most.Load(), l.held())
	}
}
