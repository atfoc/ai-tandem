package chats

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// The client mark at level 5 (the contract's 2.8, "The marks"): a chat.json from before may hold
// the client id of the API client that made the chat ("client"). The file loads and the field is
// not read. So the chat is in every list, it is served without the field, it reads and feeds the
// defaults of its group like any other chat, a fork or a branch of it has none, and the next save
// of its chat.json writes none.

// clientX is the client id of an API client of before level 5.
const clientX = "a1a1a1a1-0000-4000-8000-00000000000a"

// diskMark is the client mark the chat.json in the folder dir holds, and whether it holds one.
func diskMark(t *testing.T, dir string) (mark string, ok bool) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "chat.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	v, ok := m["client"]
	mark, _ = v.(string)
	return mark, ok
}

// markOnDisk writes the client mark client into the chat.json in the folder dir, and changes
// nothing else of it: what a server before level 5 left of a chat an API client made.
func markOnDisk(t *testing.T, dir, client string) {
	t.Helper()
	file := filepath.Join(dir, "chat.json")
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["client"], err = json.Marshal(client); err != nil {
		t.Fatal(err)
	}
	if raw, err = json.Marshal(m); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

// fromBefore is the chats of markedEnv: each has the mark clientX in its chat.json.
type fromBefore struct {
	plain   string // in gTwo, not started
	started string // in gOne, with one turn on main and a second branch, which is the current one
	branch  string // that branch's id, and bid its server id
	bid     string
	fork    string // a fork of started, with no message of its own
	dirs    map[string]string
}

// tops are the ids of the chats people see.
func (f fromBefore) tops() []string {
	ids := []string{f.plain, f.started, f.fork}
	sort.Strings(ids)
	return ids
}

// markedEnv is a server that starts on the data folder of one from before level 5: it holds a
// plain chat, a chat with a branch and a fork of that chat, all with the client mark clientX in
// their chat.json, the branch's too. Every group has sticky defaults that are not
// the catalogs' defaults: for Claude opus and low, for Cursor gpt-5.4-mini.
func markedEnv(t *testing.T) (*env, fromBefore) {
	t.Helper()
	e := newEnv(t)
	var f fromBefore
	f.plain = e.newChat(NewChat{Agent: model.Claude, Group: gTwo}).ID
	f.started, _ = e.talked(model.Claude, "", 1)
	var a *fakeAgent
	f.branch, f.bid, a = e.branchTo(f.started, newAt(3), "aside")
	a.emit(t, reply("2")...)
	f.fork = e.fork(f.started, 3).ID
	e.m.naming.Wait()

	f.dirs = map[string]string{
		f.plain:   e.st.P.ChatDir(f.plain),
		f.started: e.st.P.ChatDir(f.started),
		f.bid:     e.st.P.ChatDir(f.bid),
		f.fork:    e.st.P.ChatDir(f.fork),
	}
	for _, dir := range f.dirs {
		markOnDisk(t, dir, clientX)
	}
	sd := model.LocalDefaults(model.ServerDefaults{ByAgent: map[model.AgentKind]model.ModelChoice{
		model.Claude: {Model: "opus", Effort: "low"}, model.Cursor: {Model: "gpt-5.4-mini"}}})
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{gOne: sd, gTwo: sd, model.Ungrouped: sd}})
	e.boot()
	return e, f
}

// unmarked checks that the chat id, one people see, is served with no client mark: neither its
// view nor the state records of its branches hold the field or the client's id.
func (e *env) unmarked(what, id string) {
	e.t.Helper()
	var states []model.BranchState
	for _, s := range e.m.States() {
		if s.Chat == id {
			states = append(states, s)
		}
	}
	raw, err := json.Marshal(map[string]any{"chat": e.view(id), "states": states})
	if err != nil || len(states) == 0 || strings.Contains(string(raw), `"client"`) || strings.Contains(string(raw), clientX) {
		e.t.Fatalf("%s is served with a mark: %s %v", what, raw, err)
	}
}

func TestNoChatIsLoadedWithAClientMark(t *testing.T) {
	t.Parallel()
	e, f := markedEnv(t)
	// The load wrote nothing: the marks are still where the server before left them.
	for id, dir := range f.dirs {
		if got, _ := diskMark(t, dir); got != clientX {
			t.Fatalf("the chat.json of %s holds the mark %q before any save", id, got)
		}
	}
	// Every one of them was loaded, the branch too.
	if objects := len(e.m.all()); objects != len(f.dirs) {
		t.Fatalf("%d chat objects were loaded, want %d", objects, len(f.dirs))
	}
	for _, id := range f.tops() {
		e.unmarked("a chat from before", id)
	}

	// Each is listed like any other chat, with a state record for each of its branches.
	var listed []string
	for _, v := range e.m.Views() {
		listed = append(listed, v.ID)
		if v != e.view(v.ID) {
			t.Fatalf("Views gives %+v, View %+v", v, e.view(v.ID))
		}
	}
	sort.Strings(listed)
	if !reflect.DeepEqual(listed, f.tops()) {
		t.Fatalf("Views lists %v, want %v", listed, f.tops())
	}
	states := map[string]int{}
	for _, s := range e.m.States() {
		states[s.Chat]++
	}
	if want := map[string]int{f.plain: 1, f.started: 2, f.fork: 1}; !reflect.DeepEqual(states, want) {
		t.Fatalf("States has the records %v, want %v", states, want)
	}
}

// A chat that had a mark takes its group's sticky choice where a marked one took the catalog's
// default, and what is chosen in it is its group's choice from then on.
func TestChatThatHadAMarkReadsAndFeedsItsGroupsDefaults(t *testing.T) {
	t.Parallel()
	e, f := markedEnv(t)
	evs := e.listen()
	local := func(group string) model.ServerDefaults { return e.defaultsOf().Groups[group].Local() }

	// An agent change reads the group's model for the new agent, and is the group's agent.
	e.configure(f.plain, ConfigReq{Agent: model.Cursor})
	if v := e.view(f.plain); v.Agent != model.Cursor || v.Model != "gpt-5.4-mini" || v.Effort != "" {
		t.Fatalf("after an agent change the chat did not take its group's choice: %+v", v)
	}
	if got := local(gTwo).Agent; got != model.Cursor {
		t.Fatalf("after an agent change the group's agent is %q", got)
	}
	// A model that is chosen is the group's.
	e.configure(f.plain, ConfigReq{Model: "composer-2", Effort: "low"})
	if got := local(gTwo).ByAgent[model.Cursor]; got != (model.ModelChoice{Model: "composer-2", Effort: "low"}) {
		t.Fatalf("after a model was chosen the group's choice for the agent is %+v", got)
	}
	// The first message records the folder and the subagent settings as well.
	e.send(f.plain, "hello", "")
	d := e.defaultsOf().Groups[gTwo]
	if sd := d.Local(); sd.Cwd != e.cwd || sd.Subagents == nil ||
		sd.ByAgent[model.Cursor] != (model.ModelChoice{Model: "composer-2", Effort: "low"}) {
		t.Fatalf("the group's defaults after the chat's first message: %+v", d)
	}
	if got := ofType(evs.drain(t, e.br), "defaults"); len(got) != 3 {
		t.Fatalf("%d defaults events for an agent change, a model and a first message, want 3", len(got))
	}

	// What was saved holds no mark.
	if got, ok := diskMark(t, f.dirs[f.plain]); ok {
		t.Fatalf("the chat.json of %s was saved with the mark %q", f.plain, got)
	}
	e.m.naming.Wait()
}

// A fork and a branch of a chat that had a mark have none, whichever branch they are made of, and
// a chat.json that is saved loses the mark it had.
func TestForkOfAChatThatHadAMarkHasNone(t *testing.T) {
	t.Parallel()
	e, f := markedEnv(t)
	forks := map[string]string{"a fork of the chat": e.fork(f.started, 3).ID, "a fork at the start": e.fork(f.started, 0).ID,
		"a fork of the fork": e.fork(f.fork, 3).ID}
	ofBranch, err := e.m.Fork(f.started, ForkReq{Branch: f.branch, At: 3})
	if err != nil {
		t.Fatalf("Fork of the branch: %v", err)
	}
	forks["a fork of the chat's second branch"] = ofBranch.ID
	for what, id := range forks {
		e.unmarked(what, id)
		if got, ok := diskMark(t, e.st.P.ChatDir(id)); ok {
			t.Fatalf("the chat.json of %s holds the mark %q", what, got)
		}
	}

	// A message on the branch saves its chat.json; a new branch split from it has a new one.
	a := e.turn(f.started, nil, 3)
	if a.opts.ChatID != f.bid {
		t.Fatalf("the message went to %s, want the chat's current branch %s", a.opts.ChatID, f.bid)
	}
	e.sendTo(f.started, Target{Branch: f.branch, At: 3, New: true}, "another way")
	third := e.cur(f.started)
	if third == f.branch || third == model.MainBranch {
		t.Fatalf("the message made no branch: the current one is %q", third)
	}
	if got, ok := diskMark(t, e.st.P.ChatDir(branchChatID(f.started, third))); ok {
		t.Fatalf("the chat.json of a branch split from the second branch holds the mark %q", got)
	}
	// A rename saves the chat.json of a chat people see.
	for _, id := range []string{f.started, f.fork} {
		if err := e.m.Rename(id, "Renamed", true); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{f.started, f.bid, f.fork} {
		if got, ok := diskMark(t, f.dirs[id]); ok {
			t.Fatalf("the chat.json of %s was saved with the mark %q", id, got)
		}
	}
	for _, id := range f.tops() {
		e.unmarked("a chat from before, after its fork", id)
	}
	e.m.naming.Wait()
}
