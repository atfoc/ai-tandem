package chats

// A chat's server before its first message (remote.go), against a scripted server list.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/usable"
)

// fakeServers is the server list of a test: its entries, and the folders each of them has.
type fakeServers struct {
	mu      sync.Mutex
	entries map[string]RemoteEntry
	dirs    map[string]string   // entry + " " + path as asked → the absolute path there
	dirErr  error               // what every Dir answers, when set
	inDir   func()              // called inside every Dir
	asked   []string            // entry + " " + path, of every Dir
	dropped []string            // entry + " " + chat, of every DropLeftover
	boards  map[string]farBoard // the boards on other servers BoardOn knows
}

// farBoard is a board on another server, as the server list keeps it.
type farBoard struct {
	entry, group string
	archived     bool
}

// setBoard makes BoardOn know the board id; with no entry it forgets it.
func (f *fakeServers) setBoard(id string, b farBoard) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.boards == nil {
		f.boards = map[string]farBoard{}
	}
	if b.entry == "" {
		delete(f.boards, id)
		return
	}
	f.boards[id] = b
}

func (f *fakeServers) Entry(id string) (RemoteEntry, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e, ok := f.entries[id]
	return e, ok
}

func (f *fakeServers) ByKey(key string) (RemoteEntry, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, e := range f.entries {
		if e.Key == key && key != "" {
			return e, true
		}
	}
	return RemoteEntry{}, false
}

func (f *fakeServers) Dir(entry, path string) (string, error) {
	f.mu.Lock()
	f.asked = append(f.asked, entry+" "+path)
	abs, ok := f.dirs[entry+" "+path]
	err, in := f.dirErr, f.inDir
	f.mu.Unlock()
	if in != nil {
		in()
	}
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("%w: %s is not a directory", agent.ErrFolderMissing, path)
	}
	return abs, nil
}

func (f *fakeServers) DropLeftover(entry, chat string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dropped = append(f.dropped, entry+" "+chat)
}

func (f *fakeServers) BoardOn(id string) (entry, group string, archived, ok bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.boards[id]
	return b.entry, b.group, b.archived, ok
}

// change changes the entry id.
func (f *fakeServers) change(id string, g func(e *RemoteEntry)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	e := f.entries[id]
	g(&e)
	f.entries[id] = e
}

func (f *fakeServers) drops() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.dropped)
}

func (f *fakeServers) asks() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.asked)
}

// The two other servers of the tests: Bee can use Claude and pi, and has a list of models for
// Claude alone; Sea can use Cursor.
const (
	entB, keyB = "s_bbbbbbbb", "inst-bee"
	entC, keyC = "s_cccccccc", "inst-sea"
	farHome    = "/home/bee" // folders that are on no disk of the test's
	farWork    = "/home/bee/work"
	farSrv     = "/srv/far"
)

var farCatalog = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "far-1", Label: "Far 1", Efforts: []string{"low", "high"}, DefaultEffort: "low"},
		{ID: "far-2", Label: "Far 2"},
	},
	Default: model.ModelChoice{Model: "far-1", Effort: "low"},
}

// remoteEnv is an env with a server list of Bee and Sea, both connected. This computer finds
// the programs of kinds alone.
func remoteEnv(t *testing.T, kinds ...model.AgentKind) (*env, *fakeServers) {
	t.Helper()
	e := newEnv(t)
	p := &programs{}
	p.set(kinds...)
	e.m.Agents = usable.NewWith(programBins, p.look)
	fs := &fakeServers{
		entries: map[string]RemoteEntry{
			entB: {ID: entB, Name: "Bee", Key: keyB, Connected: true, HasLists: true,
				Agents:   []model.AgentKind{model.Claude, model.Pi},
				Catalogs: map[model.AgentKind]*model.Catalog{model.Claude: farCatalog},
				Home:     farHome, DefaultCwd: farWork},
			entC: {ID: entC, Name: "Sea", Key: keyC, Connected: true, HasLists: true,
				Agents:   []model.AgentKind{model.Cursor},
				Catalogs: map[model.AgentKind]*model.Catalog{model.Cursor: cursorCatalog},
				Home:     "/home/sea", DefaultCwd: "/home/sea"},
		},
		dirs: map[string]string{
			entB + " ~/proj":    farHome + "/proj",
			entB + " " + farSrv: farSrv,
			entC + " ~":         "/home/sea",
		},
	}
	e.m.Servers = fs
	return e, fs
}

// spawned is the number of agent processes the env's spawners started.
func (e *env) spawned() int { return e.claude.count() + e.cursor.count() + e.pi.count() }

// defs is a copy of the stored defaults.
func (e *env) defs() model.Defaults {
	var d model.Defaults
	e.st.Read(func(s *model.State) { d = defaults.Copy(s.Defaults) })
	return d
}

// onBee makes a chat in group that will start on Bee.
func (e *env) onBee(group string) model.ChatView {
	e.t.Helper()
	v := e.newChat(NewChat{Group: group, Server: entB})
	followAll(e.br)
	if v.Server != entB {
		e.t.Fatalf("a chat made on Bee: %+v", v)
	}
	return v
}

// four are the agent, folder, model and effort of a chat.
type four struct {
	Agent              model.AgentKind
	Cwd, Model, Effort string
}

func fourOf(m model.ChatMeta) four { return four{m.Agent, m.Cwd, m.Model, m.Effort} }
func fourOfView(v model.ChatView) four {
	return four{v.Agent, v.Cwd, v.Model, v.Effort}
}

// ---- the model and the paths -------------------------------------------------

func TestServerOnTheWire(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	local := e.create(model.Claude, gOne, "")
	raw, _ := json.Marshal(local)
	for _, key := range []string{`"server"`, `"start"`, `"gone"`} {
		if bytes.Contains(raw, []byte(key)) {
			t.Fatalf("a chat on this computer has %s on the wire: %s", key, raw)
		}
	}
	if raw, _ := os.ReadFile(filepath.Join(e.st.P.ChatDir(local.ID), "chat.json")); bytes.Contains(raw, []byte(`"server"`)) || bytes.Contains(raw, []byte(`"remoteStart"`)) {
		t.Fatalf("chat.json of a chat on this computer: %s", raw)
	}

	v := e.onBee(gOne)
	if raw, _ = json.Marshal(v); !bytes.Contains(raw, []byte(`"server":"`+entB+`"`)) || bytes.Contains(raw, []byte(`"start"`)) {
		t.Fatalf("a chat on Bee on the wire: %s", raw)
	}
	if m := e.meta(v.ID); m.Server != entB || m.RemoteStart != "" {
		t.Fatalf("chat.json of a chat on Bee: %+v", m)
	}
	// The view is still comparable, with the new fields in the comparison.
	if w := e.view(v.ID); w != v {
		t.Fatalf("the view read again: %+v, made %+v", w, v)
	}

	p := store.NewPaths("/data")
	if p.RemoteChats != filepath.Join("/data", "remote", "chats") || p.RemoteChatFile("abc") != filepath.Join("/data", "remote", "chats", "abc.json") {
		t.Fatalf("the paths of the remote chats: %q, %q", p.RemoteChats, p.RemoteChatFile("abc"))
	}
}

// ---- "+" ---------------------------------------------------------------------

func TestPlusStartsOnTheStickyServer(t *testing.T) {
	t.Parallel()
	// This computer can use Cursor alone: what Bee's chats get is checked nowhere here.
	e, fs := remoteEnv(t, model.Cursor)
	bee := model.ServerDefaults{Agent: model.Pi, Cwd: farSrv, ByAgent: map[model.AgentKind]model.ModelChoice{
		model.Pi: {Model: "pi-far", Effort: "high"}, model.Claude: {Model: "far-2"}}}
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne: {Server: keyB, Servers: map[string]model.ServerDefaults{keyB: bee, model.LocalServer: {Cwd: e.cwd}}},
		gTwo: {Server: "inst-nobody", Servers: map[string]model.ServerDefaults{"inst-nobody": bee}},
	}})

	v := e.newChat(NewChat{Group: gOne})
	if v.Server != entB || fourOfView(v) != (four{model.Pi, farSrv, "pi-far", "high"}) || v.Locked || v.Status != model.StatusReady {
		t.Fatalf("\"+\" in a group whose sticky server is Bee: %+v", v)
	}
	if m := e.meta(v.ID); m.Server != entB || m.Token == "" || m.SessionID == "" {
		t.Fatalf("its chat.json: %+v", m)
	}
	if len(fs.asks()) != 0 {
		t.Fatalf("a sticky folder was asked of the server: %v", fs.asks())
	}
	// An agent named for it is one of Bee's, with Bee's sticky model for it.
	if w := e.newChat(NewChat{Group: gOne, Agent: model.Claude}); w.Server != entB || fourOfView(w) != (four{model.Claude, farSrv, "far-2", ""}) {
		t.Fatalf("\"+\" with an agent of Bee's: %+v", w)
	}
	if _, err := e.m.CreateChat(NewChat{Group: gOne, Agent: model.Cursor}); !errors.Is(err, usable.ErrMissing) {
		t.Fatalf("\"+\" with an agent Bee cannot use: %v, want a missing agent", err)
	}

	// A sticky key of no entry: this computer.
	if w := e.newChat(NewChat{Group: gTwo}); w.Server != "" || fourOfView(w) != (four{model.Cursor, e.cwd, "composer-2", "high"}) {
		t.Fatalf("\"+\" in a group whose sticky server is no entry: %+v", w)
	}
	// A sticky key of an entry that waits for the user: this computer, with its own part.
	fs.change(entB, func(en *RemoteEntry) { en.Stopped = true })
	if w := e.newChat(NewChat{Group: gOne}); w.Server != "" || fourOfView(w) != (four{model.Cursor, e.cwd, "composer-2", "high"}) {
		t.Fatalf("\"+\" in a group whose sticky server is stopped: %+v", w)
	}
	// Named, such a server is refused; an id of no entry too.
	if _, err := e.m.CreateChat(NewChat{Group: gOne, Server: entB}); !errors.Is(err, ErrServerUnusable) {
		t.Fatalf("a chat made on a stopped server: %v, want ErrServerUnusable", err)
	}
	if _, err := e.m.CreateChat(NewChat{Group: gOne, Server: "s_nobody"}); !errors.Is(err, ErrServerUnknown) {
		t.Fatalf("a chat made on no entry: %v, want ErrServerUnknown", err)
	}
	// The server named wins over the sticky one, "local" included.
	fs.change(entB, func(en *RemoteEntry) { en.Stopped = false })
	if w := e.newChat(NewChat{Group: gOne, Server: model.LocalServer}); w.Server != "" || w.Agent != model.Cursor {
		t.Fatalf("\"+\" on this computer in a group whose sticky server is Bee: %+v", w)
	}
	if w := e.newChat(NewChat{Group: gOne, Server: entC}); w.Server != entC || fourOfView(w) != (four{model.Cursor, "/home/sea", "composer-2", "high"}) {
		t.Fatalf("\"+\" on Sea, which has no part in the defaults: %+v", w)
	}
}

func TestPlusWithNoListsKnown(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude)
	// AC44: an entry whose lists are not known gives no agent, and a model with none is refused.
	fs.change(entB, func(en *RemoteEntry) {
		en.HasLists, en.Agents, en.Catalogs, en.DefaultCwd, en.Connected = false, nil, nil, "", false
	})
	v := e.newChat(NewChat{Group: gOne, Server: entB})
	if v.Server != entB || fourOfView(v) != (four{}) {
		t.Fatalf("a chat on a server whose lists are not known: %+v", v)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Model: "far-1"}); !errors.Is(err, ErrBadChoice) {
		t.Fatalf("a model for a chat with no agent: %v, want ErrBadChoice", err)
	}
	// With no list to check against, an agent is taken as named, and its model too.
	e.configure(v.ID, ConfigReq{Agent: model.Pi, Model: "whatever"})
	if m := e.meta(v.ID); m.Agent != model.Pi || m.Model != "whatever" {
		t.Fatalf("an agent named while the lists are not known: %+v", m)
	}
}

// ---- a server change ---------------------------------------------------------

func TestServerChange(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude)
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne: {Servers: map[string]model.ServerDefaults{
			keyB: {Agent: model.Claude, Cwd: farSrv, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "far-1", Effort: "high"}}},
		}},
	}})
	ev := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	first := e.meta(v.ID)
	ev.drain(t, e.br)

	e.configure(v.ID, ConfigReq{Server: entB})
	m := e.meta(v.ID)
	if m.Server != entB || fourOf(m) != (four{model.Claude, farSrv, "far-1", "high"}) {
		t.Fatalf("after the change to Bee: %+v", m)
	}
	if m.SessionID == "" || m.SessionID == first.SessionID || m.Token != first.Token || m.ID != first.ID {
		t.Fatalf("the session id %q (was %q), the token and the id after the change", m.SessionID, first.SessionID)
	}
	evs := ev.drain(t, e.br)
	chatEvs := ofType(evs, "chat")
	if len(chatEvs) != 1 || chatEvs[0]["chat"].(map[string]any)["server"] != entB {
		t.Fatalf("the chat events of the change: %v", chatEvs)
	}
	// The server is no default yet, and nothing was chosen by hand.
	if d := e.defs().Groups[gOne]; d.Server != "" || d.Servers[keyB].Agent != model.Claude || len(d.Servers) != 1 {
		t.Fatalf("the defaults after a server change: %+v", d)
	}

	// A chat left on Bee by a first message that did not start it: the change drops it there,
	// and nothing is known of a first message on the new server.
	if err := e.m.SetRemoteStart(v.ID, model.RemoteLeft); err != nil {
		t.Fatal(err)
	}
	e.configure(v.ID, ConfigReq{Server: entC})
	m2 := e.meta(v.ID)
	if m2.Server != entC || m2.RemoteStart != "" || fourOf(m2) != (four{model.Cursor, "/home/sea", "composer-2", "high"}) || m2.SessionID != "" {
		t.Fatalf("after the change to Sea: %+v", m2)
	}
	if got := fs.drops(); !reflect.DeepEqual(got, []string{entB + " " + v.ID}) {
		t.Fatalf("the chats dropped: %v", got)
	}

	// Server, agent, folder and model in one request: the defaults first, then what is named.
	e.configure(v.ID, ConfigReq{Server: entB, Agent: model.Pi, Cwd: "~/proj", Model: "pi-far"})
	m3 := e.meta(v.ID)
	if m3.Server != entB || fourOf(m3) != (four{model.Pi, farHome + "/proj", "pi-far", ""}) || m3.SessionID == "" || m3.SessionID == m.SessionID {
		t.Fatalf("after server, agent, folder and model in one request: %+v", m3)
	}
	if d := e.defs().Groups[gOne]; d.Server != "" || d.Servers[keyB].Agent != model.Pi || d.Servers[keyB].Cwd != farHome+"/proj" ||
		d.Servers[keyB].ByAgent[model.Pi].Model != "pi-far" {
		t.Fatalf("what was named with the server is under its key: %+v", d)
	}
	if len(fs.drops()) != 1 {
		t.Fatalf("a chat with nothing left behind was dropped: %v", fs.drops())
	}

	// Back to this computer: its own part, and the chat is a local one again.
	e.configure(v.ID, ConfigReq{Server: model.LocalServer})
	m4 := e.meta(v.ID)
	if m4.Server != "" || fourOf(m4) != (four{model.Claude, e.cwd, "sonnet", "high"}) {
		t.Fatalf("after the change back: %+v", m4)
	}
	if _, ok := e.m.RemoteUnstarted(v.ID); ok {
		t.Fatal("a chat on this computer is reported as one of another server")
	}
	// The chat's own server is no change.
	e.configure(v.ID, ConfigReq{Server: model.LocalServer})
	if got := e.meta(v.ID); !reflect.DeepEqual(got, m4) {
		t.Fatalf("the chat's own server changed it: %+v, was %+v", got, m4)
	}
	e.configure(v.ID, ConfigReq{Server: entB})
	was := e.meta(v.ID)
	e.configure(v.ID, ConfigReq{Server: entB})
	if got := e.meta(v.ID); !reflect.DeepEqual(got, was) {
		t.Fatalf("the chat's own server changed it: %+v, was %+v", got, was)
	}
}

// A server change takes back what a start that failed here left on the chat.
func TestServerChangeTakesBackAFailedStart(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	v := e.create(model.Claude, gOne, "")
	dir := filepath.Join(t.TempDir(), "gone")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	e.configure(v.ID, ConfigReq{Cwd: dir})
	if err := os.Remove(dir); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Send(v.ID, "hi", "", nil); !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("the send: %v", err)
	}
	if w := e.view(v.ID); !w.FolderMissing || w.Status != model.StatusError {
		t.Fatalf("after the failed start: %+v", w)
	}
	e.configure(v.ID, ConfigReq{Server: entB})
	if w := e.view(v.ID); w.FolderMissing || w.Error != "" || w.Status != model.StatusReady || w.Server != entB || w.Cwd != farWork {
		t.Fatalf("after the change to Bee: %+v", w)
	}
}

// ---- refusals ----------------------------------------------------------------

func TestRemoteChoiceRefusals(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude, model.Cursor, model.Pi)
	v := e.onBee(gOne)
	was := e.meta(v.ID)
	var missing *usable.MissingError
	for _, tc := range []struct {
		what string
		req  ConfigReq
		ok   func(error) bool
	}{
		{"an agent outside the entry's list", ConfigReq{Agent: model.Cursor}, func(err error) bool {
			return errors.As(err, &missing) && missing.Agent == model.Cursor
		}},
		{"a model outside its catalog", ConfigReq{Model: "sonnet"}, func(err error) bool { return errors.Is(err, ErrBadChoice) }},
		{"an effort its model lacks", ConfigReq{Effort: "max"}, func(err error) bool { return errors.Is(err, ErrBadChoice) }},
		{"a folder the server refuses", ConfigReq{Cwd: "/nowhere"}, func(err error) bool { return errors.Is(err, ErrFolderMissing) }},
		{"a folder that is on this computer alone", ConfigReq{Cwd: e.cwd}, func(err error) bool { return errors.Is(err, ErrFolderMissing) }},
		{"another server's agent with this one's model", ConfigReq{Server: entC, Model: "far-1"}, func(err error) bool { return errors.Is(err, ErrBadChoice) }},
		{"another server with an agent it lacks", ConfigReq{Server: entC, Agent: model.Claude}, func(err error) bool { return errors.Is(err, usable.ErrMissing) }},
	} {
		if err := e.m.Configure(v.ID, tc.req); !tc.ok(err) {
			t.Fatalf("%s: %v", tc.what, err)
		}
		if got := e.meta(v.ID); !reflect.DeepEqual(got, was) {
			t.Fatalf("%s was refused and left %+v, was %+v", tc.what, got, was)
		}
	}
	fs.mu.Lock()
	fs.dirErr = ErrServerUnreachable
	fs.mu.Unlock()
	if err := e.m.Configure(v.ID, ConfigReq{Cwd: "~/proj"}); !errors.Is(err, ErrServerUnreachable) {
		t.Fatalf("a folder of a server that is not connected: %v, want ErrServerUnreachable", err)
	}
	if _, err := e.m.CreateChat(NewChat{Group: gOne, Server: entB, Cwd: "~/proj"}); !errors.Is(err, ErrServerUnreachable) {
		t.Fatalf("a chat made with a folder of a server that is not connected: %v", err)
	}
	if got := e.meta(v.ID); !reflect.DeepEqual(got, was) {
		t.Fatalf("the refused folder left %+v, was %+v", got, was)
	}
	if d := e.defs().Groups[gOne]; len(d.Servers) != 0 || d.Server != "" {
		t.Fatalf("refused changes left defaults: %+v", d)
	}
}

// The six refusals of a configure that names a server.
func TestServerRefusals(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude, model.Cursor, model.Pi)
	fr := &fakeRuns{runs: map[string]RunInfo{ownRun: {Group: gOne, Cwd: e.cwd, Agent: model.Claude, Model: "sonnet", Effort: "high"}}}
	e.m.Runs = fr
	refused := func(what, id, branch string, req ConfigReq, want error) {
		t.Helper()
		was := e.metaOf(e.view(id))
		if err := e.m.ConfigureOf(id, branch, req); !errors.Is(err, want) {
			t.Fatalf("%s, Configure %+v: %v, want %v", what, req, err, want)
		}
		if got := e.metaOf(e.view(id)); !reflect.DeepEqual(got, was) {
			t.Fatalf("%s: the refused change left %+v, was %+v", what, got, was)
		}
	}

	// 1. No entry has the id.
	plain := e.create(model.Claude, gOne, "")
	refused("an unknown server", plain.ID, "", ConfigReq{Server: "s_nobody"}, ErrServerUnknown)

	// 2. A chat on a board stays on this computer (AC34), and so does a new one.
	bd, err := e.bds.Create("Board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	onBoard := e.create(model.Claude, "", bd.ID)
	refused("a chat on a board", onBoard.ID, "", ConfigReq{Server: entB}, ErrBoardLocal)
	e.configure(onBoard.ID, ConfigReq{Server: model.LocalServer})
	if _, err := e.m.CreateChat(NewChat{Board: bd.ID, Server: entB}); !errors.Is(err, ErrBoardLocal) {
		t.Fatalf("a chat made on a board with another server: %v, want ErrBoardLocal", err)
	}
	if w := e.newChat(NewChat{Board: bd.ID, Server: model.LocalServer}); w.Server != "" || w.Board != bd.ID {
		t.Fatalf("a chat made on a board with this computer named: %+v", w)
	}

	// 3. A chat on a run is on the run's server.
	onRun := e.newChat(NewChat{Run: ownRun})
	refused("a chat on a run", onRun.ID, "", ConfigReq{Server: entB}, ErrServerFixed)
	e.configure(onRun.ID, ConfigReq{Server: model.LocalServer})
	if _, err := e.m.CreateChat(NewChat{Run: ownRun, Server: entB}); !errors.Is(err, ErrServerFixed) {
		t.Fatalf("a chat made on a run with another server: %v, want ErrServerFixed", err)
	}

	// 4. An entry that waits for the user (AC5), unless the chat is on it already.
	onSea := e.newChat(NewChat{Group: gOne, Server: entC})
	fs.change(entC, func(en *RemoteEntry) { en.Stopped = true })
	refused("a stopped server", plain.ID, "", ConfigReq{Server: entC}, ErrServerUnusable)
	e.configure(onSea.ID, ConfigReq{Server: entC, Model: "gpt-5.4-mini"})

	// 5. A chat that has started, a fork and a branch.
	id, _ := e.talked(model.Claude, "", 2)
	refused("after the first message", id, "", ConfigReq{Server: entB}, ErrAgentFixed)
	fork := e.fork(id, 0)
	refused("a fork at its start", fork.ID, "", ConfigReq{Server: entB}, ErrAgentFixed)
	b, _, ba := e.branchTo(id, Target{Branch: model.MainBranch, At: 3, New: true}, "aside")
	ba.emit(t, reply("q1")...)
	for _, branch := range []string{b, model.MainBranch} {
		if err := e.m.ConfigureOf(id, branch, ConfigReq{Server: entB}); !errors.Is(err, ErrAgentFixed) {
			t.Fatalf("branch %q: %v, want ErrAgentFixed", branch, err)
		}
	}

	// 6. A first message that may have arrived fixes server and agent; the rest still changes.
	fs.change(entC, func(en *RemoteEntry) { en.Stopped = false })
	far := e.onBee(gOne)
	if err := e.m.SetRemoteStart(far.ID, model.RemoteUnconfirmed); err != nil {
		t.Fatal(err)
	}
	for _, req := range []ConfigReq{{Server: entC}, {Server: model.LocalServer}, {Server: entB}, {Agent: model.Pi}, {Agent: model.Claude}} {
		refused("a first message that may have arrived", far.ID, "", req, ErrStartUnconfirmed)
	}
	e.configure(far.ID, ConfigReq{Model: "far-2"})
	if len(fs.drops()) != 0 {
		t.Fatalf("refused changes dropped chats: %v", fs.drops())
	}
}

// ---- nothing is checked here for a chat on another server -------------------------

func TestNoLocalCheckForARemoteChat(t *testing.T) {
	t.Parallel()
	// This computer finds no program at all, and has no folder and no model of Bee's.
	e, fs := remoteEnv(t)
	if _, err := os.Stat(farHome); err == nil {
		t.Skip(farHome + " exists on this machine")
	}
	v := e.newChat(NewChat{Group: gOne, Server: entB})
	if fourOfView(v) != (four{model.Claude, farWork, "far-1", "low"}) {
		t.Fatalf("a chat made on Bee: %+v", v)
	}
	held := make(chan bool, 1)
	fs.mu.Lock()
	fs.inDir = func() {
		// The chat's lock is not held while the server is asked: its view can be read.
		done := make(chan struct{})
		go func() { e.m.View(v.ID); close(done) }()
		select {
		case <-done:
			held <- false
		case <-time.After(2 * time.Second):
			held <- true
		}
	}
	fs.mu.Unlock()
	e.configure(v.ID, ConfigReq{Cwd: "~/proj", Model: "far-2"})
	if <-held {
		t.Fatal("the chat's lock was held while its server was asked for the folder")
	}
	e.configure(v.ID, ConfigReq{Agent: model.Pi, Model: "a-model-nobody-here-knows", Effort: "xhigh"})
	m := e.meta(v.ID)
	if fourOf(m) != (four{model.Pi, farHome + "/proj", "a-model-nobody-here-knows", "xhigh"}) {
		t.Fatalf("after the changes: %+v", m)
	}
	if got := fs.asks(); !reflect.DeepEqual(got, []string{entB + " ~/proj"}) {
		t.Fatalf("the folders asked of servers: %v", got)
	}
	// Made with all of it named.
	w := e.newChat(NewChat{Group: gOne, Server: entB, Agent: model.Claude, Cwd: farSrv, Model: "far-1", Effort: "high"})
	if fourOfView(w) != (four{model.Claude, farSrv, "far-1", "high"}) {
		t.Fatalf("a chat made on Bee with everything named: %+v", w)
	}
	if _, err := e.m.CreateChat(NewChat{Group: gOne, Server: entB, Agent: model.Claude, Model: "sonnet"}); !errors.Is(err, ErrBadChoice) {
		t.Fatalf("a chat made on Bee with a model of this computer's: %v, want ErrBadChoice", err)
	}
	// The same on this computer is refused, as ever.
	if _, err := e.m.CreateChat(NewChat{Group: gOne, Server: model.LocalServer, Agent: model.Claude}); !errors.Is(err, usable.ErrMissing) {
		t.Fatalf("a chat made here with an agent this computer lacks: %v", err)
	}
}

// ---- AC29 ---------------------------------------------------------------------

func TestServerThenAgentsAnyNumberOfTimes(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude, model.Cursor)
	v := e.create(model.Claude, gOne, "")
	sessions := map[string]bool{e.meta(v.ID).SessionID: true}
	for i, step := range []struct {
		req  ConfigReq
		want four
		on   string
	}{
		{ConfigReq{Server: entB}, four{model.Claude, farWork, "far-1", "low"}, entB},
		{ConfigReq{Agent: model.Pi}, four{model.Pi, farWork, "", ""}, entB},
		{ConfigReq{Agent: model.Claude}, four{model.Claude, farWork, "far-1", "low"}, entB},
		{ConfigReq{Server: entC}, four{model.Cursor, "/home/sea", "composer-2", "high"}, entC},
		{ConfigReq{Server: model.LocalServer}, four{model.Claude, e.cwd, "sonnet", "high"}, ""},
		{ConfigReq{Agent: model.Cursor}, four{model.Cursor, e.cwd, "composer-2", "high"}, ""},
		{ConfigReq{Server: entB, Agent: model.Pi}, four{model.Pi, farWork, "", ""}, entB},
		{ConfigReq{Agent: model.Claude, Effort: "high"}, four{model.Claude, farWork, "far-1", "high"}, entB},
	} {
		e.configure(v.ID, step.req)
		m := e.meta(v.ID)
		if fourOf(m) != step.want || m.Server != step.on || m.Locked {
			t.Fatalf("step %d, %+v: %+v", i, step.req, m)
		}
		if m.Agent != model.Cursor {
			if sessions[m.SessionID] || m.SessionID == "" {
				t.Fatalf("step %d: the session id %q is not a new one", i, m.SessionID)
			}
			sessions[m.SessionID] = true
		} else if m.SessionID != "" {
			t.Fatalf("step %d: a Cursor chat has the session id %q", i, m.SessionID)
		}
	}
	if e.spawned() != 0 {
		t.Fatalf("%d agents were started by changes", e.spawned())
	}
	// What is handed over is the agent chosen last.
	meta, err := e.m.HandOver(v.ID)
	if err != nil || fourOf(meta) != (four{model.Claude, farWork, "far-1", "high"}) {
		t.Fatalf("HandOver: %+v, %v", meta, err)
	}
}

// ---- defaults -------------------------------------------------------------------

func TestRemoteDefaults(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude)
	fs.mu.Lock()
	fs.dirs[entB+" /b/one"], fs.dirs[entB+" /b/two"], fs.dirs[entC+" /c/one"] = "/b/one", "/b/two", "/c/one"
	fs.mu.Unlock()
	ev := listen(t, e.br)

	// A change records under the server's key, and no sticky server.
	v := e.onBee(gOne)
	e.configure(v.ID, ConfigReq{Agent: model.Pi})
	e.configure(v.ID, ConfigReq{Cwd: "/b/one", Model: "pi-big", Effort: "high"})
	want := model.GroupDefaults{Servers: map[string]model.ServerDefaults{
		keyB: {Agent: model.Pi, Cwd: "/b/one", ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: {Model: "pi-big", Effort: "high"}}},
	}}
	if d := e.defs().Groups[gOne]; !reflect.DeepEqual(d, want) {
		t.Fatalf("the defaults after changes on Bee: %+v", d)
	}
	if evs := ofType(ev.drain(t, e.br), "defaults"); len(evs) != 2 {
		t.Fatalf("%d defaults events for two changes", len(evs))
	}

	// AC31: a second "+" in the group is on this computer still (no first message was sent), and
	// one made on Bee starts with the four of the first.
	if w := e.newChat(NewChat{Group: gOne}); w.Server != "" || w.Agent != model.Claude {
		t.Fatalf("\"+\" before any first message: %+v", w)
	}
	if w := e.newChat(NewChat{Group: gOne, Server: entB}); fourOfView(w) != (four{model.Pi, "/b/one", "pi-big", "high"}) {
		t.Fatalf("a second chat on Bee: %+v", w)
	}

	// The hand-over, which is the first message, records all five.
	if _, err := e.m.HandOver(v.ID); err != nil {
		t.Fatal(err)
	}
	want.Server = keyB
	if d := e.defs().Groups[gOne]; !reflect.DeepEqual(d, want) {
		t.Fatalf("the defaults after the hand-over: %+v", d)
	}
	second := e.newChat(NewChat{Group: gOne})
	if second.Server != entB || fourOfView(second) != (four{model.Pi, "/b/one", "pi-big", "high"}) {
		t.Fatalf("AC31, a second \"+\" after the first chat's first message: %+v", second)
	}
	// A hand-over of a chat nothing was changed in records what it was made with.
	other := e.newChat(NewChat{Group: gTwo, Server: entB})
	if _, err := e.m.HandOver(other.ID); err != nil {
		t.Fatal(err)
	}
	if d := e.defs().Groups[gTwo]; d.Server != keyB || d.Servers[keyB].Agent != model.Claude || d.Servers[keyB].Cwd != farWork ||
		d.Servers[keyB].ByAgent[model.Claude] != (model.ModelChoice{Model: "far-1", Effort: "low"}) {
		t.Fatalf("the defaults of a group after its first hand-over: %+v", d)
	}

	// Per server: Sea's part is its own, and Bee's stays.
	onSea := e.newChat(NewChat{Group: gOne, Server: entC})
	e.configure(onSea.ID, ConfigReq{Cwd: "/c/one", Model: "gpt-5.4-mini"})
	if _, err := e.m.HandOver(onSea.ID); err != nil {
		t.Fatal(err)
	}
	d := e.defs().Groups[gOne]
	if d.Server != keyC || !reflect.DeepEqual(d.Servers[keyB], want.Servers[keyB]) ||
		d.Servers[keyC].Agent != model.Cursor || d.Servers[keyC].Cwd != "/c/one" || d.Servers[keyC].ByAgent[model.Cursor].Model != "gpt-5.4-mini" {
		t.Fatalf("the defaults with a part per server: %+v", d)
	}
	if w := e.newChat(NewChat{Group: gOne}); w.Server != entC || fourOfView(w) != (four{model.Cursor, "/c/one", "gpt-5.4-mini", ""}) {
		t.Fatalf("\"+\" after a first message on Sea: %+v", w)
	}
	if w := e.newChat(NewChat{Group: gOne, Server: entB}); fourOfView(w) != (four{model.Pi, "/b/one", "pi-big", "high"}) {
		t.Fatalf("a chat on Bee after a first message on Sea: %+v", w)
	}

	// A first message sent here makes this computer the sticky server again.
	here := e.newChat(NewChat{Group: gOne, Server: model.LocalServer})
	e.send(here.ID, "hi", "")
	if d := e.defs().Groups[gOne]; d.Server != model.LocalServer || d.Servers[model.LocalServer].Agent != model.Claude || len(d.Servers) != 3 {
		t.Fatalf("the defaults after a first message here: %+v", d)
	}
	if w := e.newChat(NewChat{Group: gOne}); w.Server != "" || w.Agent != model.Claude {
		t.Fatalf("\"+\" after a first message here: %+v", w)
	}

	// A group with no values of its own takes the ungrouped group's, server included.
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{model.Ungrouped: e.defs().Groups[gTwo]}})
	if w := e.newChat(NewChat{Group: gOne}); w.Server != entB || fourOfView(w) != (four{model.Claude, farWork, "far-1", "low"}) {
		t.Fatalf("\"+\" in a group with no values: %+v", w)
	}
}

func TestRemoteDefaultsWithoutAKeyAndOnARun(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude)
	ev := listen(t, e.br)

	// An entry that has not said who it is has no key: nothing is recorded for it.
	fs.change(entB, func(en *RemoteEntry) { en.Key = "" })
	v := e.onBee(gOne)
	e.configure(v.ID, ConfigReq{Agent: model.Pi, Cwd: "~/proj", Model: "pi-big"})
	if _, err := e.m.HandOver(v.ID); err != nil {
		t.Fatal(err)
	}
	if d := e.defs(); len(d.Groups) != 0 {
		t.Fatalf("defaults were recorded with no key: %+v", d)
	}
	// And none for an entry that left the list before the hand-over.
	gone := e.onBee(gOne)
	fs.mu.Lock()
	delete(fs.entries, entB)
	fs.mu.Unlock()
	if _, err := e.m.HandOver(gone.ID); err != nil {
		t.Fatal(err)
	}
	if d := e.defs(); len(d.Groups) != 0 {
		t.Fatalf("defaults were recorded for an entry that is gone: %+v", d)
	}
	if evs := ofType(ev.drain(t, e.br), "defaults"); len(evs) != 0 {
		t.Fatalf("defaults events with nothing recorded: %v", evs)
	}

	// A run on Sea: its chats are there, with the run's folder, and feed the defaults of the
	// run's group for Sea with their agent, model and effort alone: the next one starts with them.
	fr := &fakeRuns{runs: map[string]RunInfo{ownRun: {Group: gOne, Cwd: "/c/run", Agent: model.Cursor, Model: "gpt-5.4-mini", Server: entC}}}
	e.m.Runs = fr
	onRun := e.newChat(NewChat{Run: ownRun})
	if onRun.Server != entC || fourOfView(onRun) != (four{model.Cursor, "/c/run", "gpt-5.4-mini", ""}) || onRun.Run != ownRun {
		t.Fatalf("a chat on a run on Sea: %+v", onRun)
	}
	if err := e.m.Configure(onRun.ID, ConfigReq{Server: model.LocalServer}); !errors.Is(err, ErrServerFixed) {
		t.Fatalf("a chat on a run on Sea, moved here: %v, want ErrServerFixed", err)
	}
	e.configure(onRun.ID, ConfigReq{Server: entC, Model: "composer-2", Effort: "low"})
	meta, err := e.m.HandOver(onRun.ID)
	if err != nil || meta.Run != ownRun || meta.Model != "composer-2" {
		t.Fatalf("HandOver of a chat on a run: %+v, %v", meta, err)
	}
	wantDefs := model.Defaults{Groups: map[string]model.GroupDefaults{gOne: {Servers: map[string]model.ServerDefaults{keyC: {
		Agent: model.Cursor, ByAgent: map[model.AgentKind]model.ModelChoice{model.Cursor: {Model: "composer-2", Effort: "low"}},
	}}}}}
	if d := e.defs(); !reflect.DeepEqual(d, wantDefs) {
		t.Fatalf("the defaults a chat on a run on Sea fed: %+v, want %+v", d, wantDefs)
	}
	if next := e.newChat(NewChat{Run: ownRun}); next.Server != entC || fourOfView(next) != (four{model.Cursor, "/c/run", "composer-2", "low"}) {
		t.Fatalf("the next chat on the run on Sea: %+v", next)
	}
	if _, err := os.Stat(e.st.P.RunChatDir(ownRun, false, onRun.ID)); !os.IsNotExist(err) {
		t.Fatalf("the folder of the chat on the run after the hand-over: %v", err)
	}
}

// AC32: a new group starts with a copy of every server's part, and a state file of before
// chats had servers is not written by a load.
func TestSeededGroupsCopyEveryServersPart(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne: {Server: keyB, Servers: map[string]model.ServerDefaults{
			keyB:              {Agent: model.Pi, Cwd: farSrv, ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: {Model: "pi-big"}}},
			keyC:              {Agent: model.Cursor, Cwd: "/c/one"},
			model.LocalServer: {Agent: model.Claude, Cwd: e.cwd, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "low"}}},
		}},
	}})
	const sub = "g_sub"
	if err := e.st.Update(func(s *model.State) error {
		s.Groups = append(s.Groups, model.Group{ID: sub, Name: "Sub", Parent: gOne})
		defaults.SeedGroup(&s.Defaults, sub, gOne)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if d := e.defs(); !reflect.DeepEqual(d.Groups[sub], d.Groups[gOne]) {
		t.Fatalf("the seeded group: %+v, its parent %+v", d.Groups[sub], d.Groups[gOne])
	}
	for server, want := range map[string]four{
		"":                {model.Pi, farSrv, "pi-big", ""},
		entB:              {model.Pi, farSrv, "pi-big", ""},
		entC:              {model.Cursor, "/c/one", "composer-2", "high"},
		model.LocalServer: {model.Claude, e.cwd, "opus", "low"},
	} {
		if w := e.newChat(NewChat{Group: sub, Server: server}); fourOfView(w) != want {
			t.Fatalf("\"+\" in the seeded group on %q: %+v, want %+v", server, w, want)
		}
	}
	// A copy: a change in the new group does not reach its parent.
	v := e.newChat(NewChat{Group: sub})
	e.configure(v.ID, ConfigReq{Agent: model.Claude})
	if d := e.defs(); d.Groups[gOne].Servers[keyB].Agent != model.Pi || d.Groups[sub].Servers[keyB].Agent != model.Claude {
		t.Fatalf("after a change in the seeded group: %+v", d.Groups)
	}
}

// phase3State is a state file as the build before chats had servers wrote it: a sticky server
// that is an instance id, and a part per server.
const phase3State = `{
  "version": 1,
  "groups": [
    {
      "id": "g_one",
      "name": "One"
    },
    {
      "id": "g_two",
      "name": "Two",
      "parent": "g_one",
      "collapsed": true
    }
  ],
  "defaults": {
    "groups": {
      "__ungrouped__": {
        "server": "local",
        "servers": {
          "local": {
            "agent": "claude",
            "cwd": "/Users/someone/code",
            "byAgent": {
              "claude": {
                "model": "opus",
                "effort": "high"
              }
            }
          }
        }
      },
      "g_one": {
        "server": "inst-bee",
        "servers": {
          "inst-bee": {
            "agent": "pi",
            "cwd": "/srv/far",
            "byAgent": {
              "pi": {
                "model": "pi-big"
              }
            },
            "run": {
              "agent": "pi",
              "maxParallel": 3,
              "maxTurns": 0,
              "maxCost": 0
            }
          },
          "local": {
            "cwd": "/Users/someone/code"
          }
        }
      }
    }
  },
  "catalogs": {
    "cursor": {
      "models": [
        {
          "id": "composer-2",
          "label": "Composer 2",
          "efforts": [
            "low",
            "high"
          ]
        }
      ],
      "default": {
        "model": "composer-2",
        "effort": "high"
      }
    }
  },
  "remoteGroup": "g_two"
}
`

func TestPhase3StateFileIsNotWrittenByALoad(t *testing.T) {
	t.Parallel()
	root := filepath.Join(t.TempDir(), ".ai-whiteboard")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(root, "state.json")
	if err := os.WriteFile(state, []byte(phase3State), 0o600); err != nil {
		t.Fatal(err)
	}
	// A chat of that build, too: its chat.json is read and not written.
	const id = "0b8f3c1e-5a4d-4e2b-9c7a-1f2e3d4c5b6a"
	chatJSON := `{"id":"` + id + `","agent":"claude","group":"g_one","cwd":"/tmp","model":"opus","locked":false,"token":"tok","created":"2026-01-02T03:04:05Z","usage":{}}`
	chatFile := filepath.Join(root, "chats", id, "chat.json")
	if err := os.MkdirAll(filepath.Dir(chatFile), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(chatFile, []byte(chatJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(state)
	if err != nil {
		t.Fatal(err)
	}

	e := &env{t: t, root: root, cwd: t.TempDir()}
	e.clock.Store(testNow)
	e.boot()
	e.m.Servers = &fakeServers{entries: map[string]RemoteEntry{entB: {ID: entB, Key: keyB, HasLists: true, Agents: []model.AgentKind{model.Pi}, DefaultCwd: farWork}}}

	got, err := os.ReadFile(state)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != phase3State {
		t.Fatalf("the state file after a load:\n%s", got)
	}
	if after, _ := os.Stat(state); !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("the state file was written by the load")
	}
	if got, _ := os.ReadFile(chatFile); string(got) != chatJSON {
		t.Fatalf("chat.json after a load: %s", got)
	}
	if _, err := os.Stat(e.st.P.RemoteChats); !os.IsNotExist(err) {
		t.Fatalf("the load made the folder of the remote chats: %v", err)
	}
	// What it holds is read as it was meant: the chat is one of this computer, a "+" in the
	// group goes to the entry that has the key, and reading changes no byte either.
	if v := e.view(id); v.Server != "" || v.Start != "" || v.Gone {
		t.Fatalf("the chat of the old file: %+v", v)
	}
	if v := e.newChat(NewChat{Group: gOne}); v.Server != entB || fourOfView(v) != (four{model.Pi, farSrv, "pi-big", ""}) {
		t.Fatalf("\"+\" by the old file's defaults: %+v", v)
	}
	if got, _ := os.ReadFile(state); string(got) != phase3State {
		t.Fatalf("the state file after a \"+\":\n%s", got)
	}
	// This build writes the file as that one did: a write that changes nothing gives the same bytes.
	if err := e.st.Update(func(*model.State) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(state); string(got) != phase3State {
		t.Fatalf("the state file written by this build:\n%s", got)
	}
}

// ---- the hand-over ---------------------------------------------------------------

func TestHandOver(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	ev := listen(t, e.br)
	v := e.onBee(gOne)
	keep := e.onBee(gOne)
	local := e.create(model.Claude, gOne, "")
	if _, _, err := e.m.SetDraft(v.ID, 0, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}
	was := e.meta(v.ID)
	item := editorbridge.Chat(v.ID)
	e.br.SetMark(item, listenID)
	if _, ok := e.m.ByToken(was.Token); !ok || !e.br.Followed(item) {
		t.Fatal("before the hand-over the chat has no token or no follower")
	}
	ev.drain(t, e.br)

	meta, err := e.m.HandOver(v.ID)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := json.Marshal(meta)
	want, _ := json.Marshal(was)
	if string(got) != string(want) || meta.DraftRevs[model.MainBranch] != 1 || meta.Token == "" {
		t.Fatalf("HandOver returned %s, chat.json was %s", got, want)
	}
	// The object, its folder and its token are gone.
	if _, err := os.Stat(e.st.P.ChatDir(v.ID)); !os.IsNotExist(err) {
		t.Fatalf("the chat's folder after the hand-over: %v", err)
	}
	if _, ok := e.m.ByToken(was.Token); ok {
		t.Fatal("the chat's token still names a chat")
	}
	if _, err := e.m.View(v.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the chat's view after the hand-over: %v, want ErrNotFound", err)
	}
	for _, w := range e.m.Views() {
		if w.ID == v.ID {
			t.Fatal("the chat is still listed")
		}
	}
	// Of the chat nothing was sent, and the bridge still has its followers and its mark.
	sent := ev.drain(t, e.br)
	for _, got := range sent {
		if got["type"] != "defaults" {
			t.Fatalf("the hand-over sent %v", got)
		}
	}
	if len(sent) != 1 {
		t.Fatalf("the hand-over sent %d defaults events", len(sent))
	}
	if !e.br.Followed(item) || e.br.MarkOf(item) != listenID {
		t.Fatalf("after the hand-over: followed %v, mark %q", e.br.Followed(item), e.br.MarkOf(item))
	}
	// Nothing can be done with the id any more, and the calls that come late leave no folder.
	if _, err := e.m.HandOver(v.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a second hand-over: %v, want ErrNotFound", err)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Model: "far-2"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a change after the hand-over: %v, want ErrNotFound", err)
	}
	if err := e.m.SetRemoteStart(v.ID, model.RemoteLeft); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SetRemoteStart after the hand-over: %v, want ErrNotFound", err)
	}
	if _, err := os.Stat(e.st.P.ChatDir(v.ID)); !os.IsNotExist(err) {
		t.Fatalf("late calls made the chat's folder again: %v", err)
	}
	// The id is free for whoever keeps the record: nothing of the manager holds it.
	if e.m.idTaken(v.ID) {
		t.Fatal("the id is still taken")
	}

	// Only a chat that will start on another server is handed over.
	for what, id := range map[string]string{"a chat on this computer": local.ID, "no chat": "0b8f3c1e-5a4d-4e2b-9c7a-1f2e3d4c5b6a"} {
		if _, err := e.m.HandOver(id); !errors.Is(err, ErrNotFound) {
			t.Fatalf("HandOver of %s: %v, want ErrNotFound", what, err)
		}
	}
	if e.view(local.ID).ID != local.ID || e.view(keep.ID).Server != entB {
		t.Fatal("the other chats are not as they were")
	}
	if _, err := os.Stat(e.st.P.ChatDir(local.ID)); err != nil {
		t.Fatalf("the folder of the chat on this computer: %v", err)
	}
	// A restart finds the chat that was not handed over, and not the one that was.
	e.boot()
	if _, err := e.m.View(v.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("the handed-over chat after a restart: %v", err)
	}
	if w := e.view(keep.ID); w.Server != entB {
		t.Fatalf("the chat on Bee after a restart: %+v", w)
	}
}

// Changes and a hand-over at once: the chat ends handed over once, and every change either
// came before it or found no chat.
func TestHandOverAndChangesAtOnce(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	for round := 0; round < 20; round++ {
		v := e.onBee(gOne)
		var wg sync.WaitGroup
		errs := make([]error, 6)
		for i := range errs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				switch i {
				case 0, 1:
					_, errs[i] = e.m.HandOver(v.ID)
				case 2:
					errs[i] = e.m.Configure(v.ID, ConfigReq{Model: "far-2"})
				case 3:
					errs[i] = e.m.Configure(v.ID, ConfigReq{Server: model.LocalServer})
				case 4:
					errs[i] = e.m.SetRemoteStart(v.ID, model.RemoteLeft)
				case 5:
					errs[i] = e.m.Send(v.ID, "hi", "", nil)
				}
			}()
		}
		wg.Wait()
		if _, err := e.m.View(v.ID); err == nil {
			// The move to this computer came first: both hand-overs found a chat of this computer.
			if errs[3] != nil || !errors.Is(errs[0], ErrNotFound) || !errors.Is(errs[1], ErrNotFound) || e.view(v.ID).Server != "" {
				t.Fatalf("round %d: the chat is still here: %v", round, errs)
			}
			e.m.Stop(v.ID)
			continue
		}
		if (errs[0] == nil) == (errs[1] == nil) {
			t.Fatalf("round %d: the two hand-overs: %v, %v", round, errs[0], errs[1])
		}
		for i, err := range errs[2:] {
			if err != nil && !errors.Is(err, ErrNotFound) && !errors.Is(err, ErrRemoteStart) {
				t.Fatalf("round %d, call %d: %v", round, i+2, err)
			}
		}
		if _, err := os.Stat(e.st.P.ChatDir(v.ID)); !os.IsNotExist(err) {
			t.Fatalf("round %d: the folder after the hand-over: %v", round, err)
		}
	}
	if n := e.claude.count() + e.pi.count(); n > 20 {
		t.Fatalf("%d agents started", n)
	}
}

// ---- the server is up, the server is gone ------------------------------------------

func TestServerUp(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude)
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne: {Servers: map[string]model.ServerDefaults{keyB: {Agent: model.Pi, Cwd: farSrv, ByAgent: map[model.AgentKind]model.ModelChoice{model.Pi: {Model: "pi-big", Effort: "high"}}}}},
	}})
	// Made while Bee's lists were not known: no agent, and no folder in a group with none.
	lists := fs.entries[entB]
	fs.change(entB, func(en *RemoteEntry) { en.HasLists, en.Agents, en.Catalogs, en.DefaultCwd = false, nil, nil, "" })
	none := e.newChat(NewChat{Group: gOne, Server: entB})
	bare := e.newChat(NewChat{Group: gTwo, Server: entB})
	if fourOfView(none) != (four{Cwd: farSrv}) || fourOfView(bare) != (four{}) {
		t.Fatalf("made with no lists: %+v, %+v", none, bare)
	}
	e.m.ServerUp(entB) // still no lists: nothing to choose from
	if got := e.view(none.ID); got != none {
		t.Fatalf("ServerUp with no lists changed the chat: %+v", got)
	}

	fs.change(entB, func(en *RemoteEntry) { *en = lists })
	kept := e.newChat(NewChat{Group: gOne, Server: entB, Agent: model.Claude, Model: "far-2"}) // an agent Bee can use: left alone
	lost := e.newChat(NewChat{Group: gOne, Server: entB, Agent: model.Pi})
	sent := e.newChat(NewChat{Group: gOne, Server: entB, Agent: model.Pi})
	onSea := e.newChat(NewChat{Group: gOne, Server: entC})
	local := e.create(model.Claude, gOne, "")
	if err := e.m.SetRemoteStart(sent.ID, model.RemoteUnconfirmed); err != nil {
		t.Fatal(err)
	}
	// Bee comes back without pi.
	fs.change(entB, func(en *RemoteEntry) { en.Agents = []model.AgentKind{model.Claude} })
	keptMeta, sentMeta, lostSession := e.meta(kept.ID), e.meta(sent.ID), e.meta(lost.ID).SessionID
	ev := listen(t, e.br)
	ev.drain(t, e.br)
	e.m.ServerUp(entB)

	for what, tc := range map[string]struct {
		id   string
		want four
	}{
		"a chat that had no agent":                       {none.ID, four{model.Claude, farSrv, "far-1", "low"}},
		"a chat that had no agent and no folder":         {bare.ID, four{model.Claude, farWork, "far-1", "low"}},
		"a chat whose agent the server no longer has":    {lost.ID, four{model.Claude, farSrv, "far-1", "low"}},
		"a chat whose agent the server can use":          {kept.ID, four{model.Claude, farSrv, "far-2", ""}},
		"a chat whose first message may have arrived":    {sent.ID, four{model.Pi, farSrv, "pi-big", "high"}},
		"a chat on another server":                       {onSea.ID, fourOfView(onSea)},
		"a chat on this computer":                        {local.ID, fourOfView(local)},
		"a chat that had no agent, read from the server": {none.ID, fourOfView(e.view(none.ID))},
	} {
		if m := e.meta(tc.id); fourOf(m) != tc.want {
			t.Fatalf("%s: %+v, want %+v", what, fourOf(m), tc.want)
		}
	}
	if m := e.meta(lost.ID); m.SessionID == "" || m.SessionID == lostSession || m.Server != entB {
		t.Fatalf("the chat given another agent: %+v", m)
	}
	if got := e.meta(kept.ID); !reflect.DeepEqual(got, keptMeta) {
		t.Fatalf("a chat with a usable agent was changed: %+v", got)
	}
	if got := e.meta(sent.ID); !reflect.DeepEqual(got, sentMeta) {
		t.Fatalf("a chat whose first message may have arrived was changed: %+v", got)
	}
	changed := map[string]bool{}
	for _, got := range ofType(ev.drain(t, e.br), "chat") {
		changed[got["chat"].(map[string]any)["id"].(string)] = true
	}
	if !reflect.DeepEqual(changed, map[string]bool{none.ID: true, bare.ID: true, lost.ID: true}) {
		t.Fatalf("the chats sent by ServerUp: %v", changed)
	}
	// Once more: nothing is left to do, and nothing is sent.
	e.m.ServerUp(entB)
	e.m.ServerUp("s_nobody")
	e.m.ServerUp(model.LocalServer)
	if evs := ofType(ev.drain(t, e.br), "chat"); len(evs) != 0 {
		t.Fatalf("a second ServerUp sent %v", evs)
	}
	// A server that can use nothing: the chats on it have no agent.
	fs.change(entB, func(en *RemoteEntry) { en.Agents = nil })
	e.m.ServerUp(entB)
	if m := e.meta(kept.ID); m.Agent != "" || m.Model != "" || m.Cwd != farSrv {
		t.Fatalf("a chat on a server that can use no agent: %+v", m)
	}
}

func TestResetServerAndUnstartedOn(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude)
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne: {Server: keyB, Servers: map[string]model.ServerDefaults{
			model.LocalServer: {Cwd: e.cwd, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "low"}}},
		}},
	}})
	a := e.newChat(NewChat{Group: gOne})
	e.clock.Add(1000)
	b := e.newChat(NewChat{Group: gTwo, Server: entB, Agent: model.Pi})
	onSea := e.newChat(NewChat{Group: gOne, Server: entC})
	local := e.create(model.Claude, gTwo, "")
	if err := e.m.SetRemoteStart(b.ID, model.RemoteLeft); err != nil {
		t.Fatal(err)
	}

	ids := func(ms []model.ChatMeta) []string {
		out := []string{}
		for _, m := range ms {
			if m.Token == "" || m.Server == "" {
				t.Fatalf("a listed chat: %+v", m)
			}
			out = append(out, m.ID)
		}
		slices.Sort(out)
		return out
	}
	both := []string{a.ID, b.ID}
	slices.Sort(both)
	if got := ids(e.m.UnstartedOn(entB)); !reflect.DeepEqual(got, both) {
		t.Fatalf("UnstartedOn(Bee): %v, want %v", got, both)
	}
	if got := ids(e.m.UnstartedOn(entC)); !reflect.DeepEqual(got, []string{onSea.ID}) {
		t.Fatalf("UnstartedOn(Sea): %v", got)
	}
	for _, entry := range []string{"", model.LocalServer, "s_nobody"} {
		if got := e.m.UnstartedOn(entry); len(got) != 0 {
			t.Fatalf("UnstartedOn(%q): %v", entry, got)
		}
	}
	if m, ok := e.m.RemoteUnstarted(b.ID); !ok || m.ID != b.ID || m.Server != entB || m.RemoteStart != model.RemoteLeft || m.Token == "" {
		t.Fatalf("RemoteUnstarted of a chat on Bee: %+v, %v", m, ok)
	}
	for what, id := range map[string]string{"a chat on this computer": local.ID, "no chat": "nobody"} {
		if _, ok := e.m.RemoteUnstarted(id); ok {
			t.Fatalf("RemoteUnstarted of %s", what)
		}
	}

	// The entry is removed: its chats are put on this computer, with this computer's part.
	fs.mu.Lock()
	delete(fs.entries, entB)
	fs.mu.Unlock()
	if err := e.m.Configure(b.ID, ConfigReq{Model: "x"}); !errors.Is(err, ErrServerUnknown) {
		t.Fatalf("a change of a chat whose entry is gone: %v, want ErrServerUnknown", err)
	}
	ev := listen(t, e.br)
	ev.drain(t, e.br)
	session := e.meta(b.ID).SessionID
	for _, id := range []string{a.ID, b.ID} {
		if err := e.m.ResetServer(id); err != nil {
			t.Fatal(err)
		}
	}
	if m := e.meta(a.ID); m.Server != "" || fourOf(m) != (four{model.Claude, e.cwd, "opus", "low"}) {
		t.Fatalf("a chat put back on this computer: %+v", m)
	}
	mb := e.meta(b.ID)
	if mb.Server != "" || mb.RemoteStart != "" || fourOf(mb) != (four{model.Claude, e.cwd, "sonnet", "high"}) || mb.SessionID == "" || mb.SessionID == session {
		t.Fatalf("a chat put back on this computer: %+v", mb)
	}
	evs := ofType(ev.drain(t, e.br), "chat")
	if len(evs) != 2 {
		t.Fatalf("%d chat events for two resets", len(evs))
	}
	for _, got := range evs {
		if c := got["chat"].(map[string]any); c["server"] != nil || c["agent"] != "claude" {
			t.Fatalf("a chat sent by a reset: %v", c)
		}
	}
	if len(fs.drops()) != 0 {
		t.Fatalf("a reset sent something to the server: %v", fs.drops())
	}
	if got := e.m.UnstartedOn(entB); len(got) != 0 {
		t.Fatalf("UnstartedOn(Bee) after the resets: %v", got)
	}
	// A chat of this computer is left as it is; no chat is an error.
	was := e.meta(local.ID)
	if err := e.m.ResetServer(local.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.meta(local.ID); !reflect.DeepEqual(got, was) {
		t.Fatalf("ResetServer changed a chat of this computer: %+v", got)
	}
	if err := e.m.ResetServer("nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ResetServer of no chat: %v, want ErrNotFound", err)
	}
	if evs := ofType(ev.drain(t, e.br), "chat"); len(evs) != 0 {
		t.Fatalf("resets that changed nothing sent %v", evs)
	}
	// The chat is one of this computer now: its first message starts an agent here.
	e.send(a.ID, "hi", "")
	if e.claude.count() != 1 {
		t.Fatalf("%d Claude processes after the first message of the chat put back", e.claude.count())
	}
}

func TestSetRemoteStart(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	v := e.onBee(gOne)
	local := e.create(model.Claude, gOne, "")
	ev := listen(t, e.br)
	ev.drain(t, e.br)
	for _, step := range []struct {
		state string
		start any // "start" of the chat event; nil = absent
		sends bool
	}{
		{model.RemoteUnconfirmed, model.RemoteUnconfirmed, true},
		{model.RemoteUnconfirmed, nil, false}, // the state it has: nothing is sent
		{model.RemoteLeft, nil, true},
		{"", nil, true},
		{model.RemoteLeft, nil, true},
	} {
		if err := e.m.SetRemoteStart(v.ID, step.state); err != nil {
			t.Fatalf("SetRemoteStart %q: %v", step.state, err)
		}
		if m := e.meta(v.ID); m.RemoteStart != step.state || m.Server != entB {
			t.Fatalf("chat.json after SetRemoteStart %q: %+v", step.state, m)
		}
		evs := ofType(ev.drain(t, e.br), "chat")
		if !step.sends {
			if len(evs) != 0 {
				t.Fatalf("SetRemoteStart %q again sent %v", step.state, evs)
			}
			continue
		}
		if len(evs) != 1 || evs[0]["chat"].(map[string]any)["start"] != step.start || evs[0]["chat"].(map[string]any)["server"] != entB {
			t.Fatalf("the chat events of SetRemoteStart %q: %v", step.state, evs)
		}
		want := ""
		if step.start != nil {
			want = model.RemoteUnconfirmed
		}
		if w := e.view(v.ID); w.Start != want {
			t.Fatalf("the view after SetRemoteStart %q: start %q", step.state, w.Start)
		}
	}
	// It is kept across a restart.
	e.boot()
	if m, ok := e.m.RemoteUnstarted(v.ID); !ok || m.RemoteStart != model.RemoteLeft {
		t.Fatalf("after a restart: %+v, %v", m, ok)
	}
	if err := e.m.SetRemoteStart(v.ID, "started"); err == nil {
		t.Fatal("an unknown state was taken")
	}
	for what, id := range map[string]string{"a chat on this computer": local.ID, "no chat": "nobody"} {
		if err := e.m.SetRemoteStart(id, model.RemoteLeft); !errors.Is(err, ErrNotFound) {
			t.Fatalf("SetRemoteStart of %s: %v, want ErrNotFound", what, err)
		}
	}
	if m := e.meta(local.ID); m.RemoteStart != "" {
		t.Fatalf("the chat on this computer: %+v", m)
	}
}

// ---- no agent starts here ------------------------------------------------------------

func TestNoAgentStartsForARemoteChat(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude, model.Cursor, model.Pi)
	v := e.onBee(gOne)
	was := e.meta(v.ID)
	if _, _, err := e.m.SetDraft(v.ID, 0, model.Draft{Text: "typed"}); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Send(v.ID, "hi", "", nil); !errors.Is(err, ErrRemoteStart) {
		t.Fatalf("Send: %v, want ErrRemoteStart", err)
	}
	if b, err := e.m.SendBranch(v.ID, "hi", "", nil); !errors.Is(err, ErrRemoteStart) || b != "" {
		t.Fatalf("SendBranch: %q, %v, want ErrRemoteStart", b, err)
	}
	for _, tg := range []Target{{Branch: model.MainBranch, At: 0, New: true}, {Branch: model.MainBranch}, {Branch: model.MainBranch, End: true}} {
		if b, err := e.m.SendToBranch(v.ID, tg, "hi", "", nil); !errors.Is(err, ErrRemoteStart) || b != "" {
			t.Fatalf("SendToBranch %+v: %q, %v, want ErrRemoteStart", tg, b, err)
		}
	}
	if _, err := e.m.Fork(v.ID, ForkReq{Branch: model.MainBranch, At: 0}); !errors.Is(err, ErrRemoteStart) {
		t.Fatalf("Fork: %v, want ErrRemoteStart", err)
	}
	if err := e.m.Open(v.ID); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if e.spawned() != 0 {
		t.Fatalf("%d agents were started for a chat of another server", e.spawned())
	}
	m := e.meta(v.ID)
	if m.Locked || m.Drafts[model.MainBranch] == nil || m.Drafts[model.MainBranch].Text != "typed" || m.Token != was.Token {
		t.Fatalf("the refused sends left %+v", m)
	}
	if items := e.items(v.ID); len(items) != 0 {
		t.Fatalf("the refused sends left items: %+v", items)
	}
	if got := len(e.chatDirs()); got != 1 {
		t.Fatalf("%d chat folders after the refused sends", got)
	}
	if d := e.defs(); len(d.Groups) != 0 {
		t.Fatalf("the refused sends recorded defaults: %+v", d)
	}
	if w := e.view(v.ID); w.Status != model.StatusReady || w.Error != "" || w.Branches != 0 {
		t.Fatalf("the view after the refused sends: %+v", w)
	}

	// The delete of a chat that may be on its server asks the server to drop it; of one that
	// was never sent, not.
	if err := e.m.Delete(v.ID); err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{model.RemoteLeft, model.RemoteUnconfirmed} {
		w := e.onBee(gOne)
		if err := e.m.SetRemoteStart(w.ID, state); err != nil {
			t.Fatal(err)
		}
		if err := e.m.Delete(w.ID); err != nil {
			t.Fatal(err)
		}
		if got := fs.drops(); len(got) == 0 || got[len(got)-1] != entB+" "+w.ID {
			t.Fatalf("the delete of a chat with the state %q dropped %v", state, got)
		}
	}
	local := e.create(model.Claude, gOne, "")
	if err := e.m.Delete(local.ID); err != nil {
		t.Fatal(err)
	}
	if got := fs.drops(); len(got) != 2 {
		t.Fatalf("the chats dropped: %v", got)
	}
}

// ---- boards (AC34) ---------------------------------------------------------------

func TestBoardChatsStayOnThisComputer(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	sticky := model.GroupDefaults{Server: keyB, Servers: map[string]model.ServerDefaults{
		keyB: {Agent: model.Pi, Cwd: farSrv},
	}}
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{gOne: sticky, model.Ungrouped: sticky}})
	bd, err := e.bds.Create("Board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.CreateChat(NewChat{Board: bd.ID, Server: entB}); !errors.Is(err, ErrBoardLocal) {
		t.Fatalf("a chat made on a board with another server: %v, want ErrBoardLocal", err)
	}
	if n := len(e.chatDirs()); n != 0 {
		t.Fatalf("the refused creation left %d folders", n)
	}
	// The group's sticky server is Bee: a plain chat goes there, the board's chat does not.
	if w := e.newChat(NewChat{Group: gOne}); w.Server != entB {
		t.Fatalf("a plain chat in the group: %+v", w)
	}
	v := e.newChat(NewChat{Board: bd.ID})
	if v.Server != "" || fourOfView(v) != (four{model.Claude, e.cwd, "sonnet", "high"}) || v.Board != bd.ID {
		t.Fatalf("a chat on a board in a group whose sticky server is Bee: %+v", v)
	}
	if _, ok := e.m.RemoteUnstarted(v.ID); ok {
		t.Fatal("a chat on a board is reported as one of another server")
	}
	if err := e.m.Configure(v.ID, ConfigReq{Server: entB}); !errors.Is(err, ErrBoardLocal) {
		t.Fatalf("a board chat moved to Bee: %v, want ErrBoardLocal", err)
	}
	// Its first message starts an agent here and leaves the sticky server as it was.
	e.send(v.ID, "hi", "")
	if e.claude.count() != 1 {
		t.Fatalf("%d Claude processes after the board chat's first message", e.claude.count())
	}
	d := e.defs().Groups[gOne]
	if d.Server != keyB || !reflect.DeepEqual(d.Servers[keyB], sticky.Servers[keyB]) || d.Servers[model.LocalServer].Agent != model.Claude {
		t.Fatalf("the defaults after the board chat's first message: %+v", d)
	}
	if w := e.newChat(NewChat{Group: gOne}); w.Server != entB || w.Agent != model.Pi {
		t.Fatalf("\"+\" after the board chat's first message: %+v", w)
	}
}

// TestChatsOnARemoteBoard: a chat on a board that lives on another server is on that server,
// whatever is named and whatever the sticky server of the board's group.
func TestChatsOnARemoteBoard(t *testing.T) {
	t.Parallel()
	const far, shut, lost = "b_far00001", "b_far00002", "b_far00003"
	e, fs := remoteEnv(t, model.Claude)
	fs.setBoard(far, farBoard{entry: entB, group: gOne})
	fs.setBoard(shut, farBoard{entry: entB, group: gOne, archived: true})
	sticky := model.GroupDefaults{Server: keyC, Servers: map[string]model.ServerDefaults{
		keyB: {Agent: model.Pi, Cwd: farSrv},
	}}
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{gOne: sticky}})

	// With no server named (Cmd+N on the board) and with the board's: on the board's entry.
	for _, server := range []string{"", entB} {
		v := e.newChat(NewChat{Board: far, Server: server})
		if v.Server != entB || v.Board != far || v.Group != "" || fourOfView(v) != (four{model.Pi, farSrv, "", ""}) {
			t.Fatalf("a chat on a remote board, server %q named: %+v", server, v)
		}
		meta, ok := e.m.RemoteUnstarted(v.ID)
		if !ok || meta.Board != far || meta.Server != entB {
			t.Fatalf("it is not one that starts on Bee: %+v, %v", meta, ok)
		}
		if g := e.m.GroupOf(meta); g != gOne {
			t.Fatalf("its group: %q, want the record's", g)
		}
	}
	made := len(e.chatDirs())

	// Another server than the board's, this computer among them.
	for _, server := range []string{entC, model.LocalServer} {
		if _, err := e.m.CreateChat(NewChat{Board: far, Server: server}); !errors.Is(err, ErrServerFixed) {
			t.Errorf("a chat on a remote board made on %q: %v, want ErrServerFixed", server, err)
		}
	}
	// An archived board, one nobody knows, and an API client's chat, which is on a board here.
	if _, err := e.m.CreateChat(NewChat{Board: shut}); !errors.Is(err, boards.ErrArchived) {
		t.Errorf("a chat on an archived remote board: %v", err)
	}
	if _, err := e.m.CreateChat(NewChat{Board: lost}); !errors.Is(err, boards.ErrNotFound) {
		t.Errorf("a chat on a board nobody knows: %v", err)
	}
	if _, err := e.m.CreateChat(NewChat{Board: far, Client: "cli", Agent: model.Claude}); !errors.Is(err, boards.ErrNotFound) {
		t.Errorf("a chat of an API client on a remote board: %v", err)
	}
	if n := len(e.chatDirs()); n != made {
		t.Fatalf("the refused creations left %d folders", n-made)
	}

	// The chat stays on the board's server.
	v := e.newChat(NewChat{Board: far})
	was := e.meta(v.ID)
	for _, server := range []string{entC, model.LocalServer} {
		if err := e.m.Configure(v.ID, ConfigReq{Server: server}); !errors.Is(err, ErrServerFixed) {
			t.Errorf("a chat on a remote board moved to %q: %v, want ErrServerFixed", server, err)
		}
	}
	if got := e.meta(v.ID); !reflect.DeepEqual(got, was) {
		t.Fatalf("the refused moves left %+v", got)
	}
	e.configure(v.ID, ConfigReq{Server: entB, Agent: model.Claude})
	if got := e.meta(v.ID); got.Server != entB || got.Agent != model.Claude || got.Board != far {
		t.Fatalf("after a change that names the board's server: %+v", got)
	}

	// The hand-over records the agent for Bee in the board's group, and no sticky server.
	if _, err := e.m.HandOver(v.ID); err != nil {
		t.Fatal(err)
	}
	if d := e.defs().Groups[gOne]; d.Server != keyC || d.Servers[keyB].Agent != model.Claude {
		t.Fatalf("the defaults after the hand-over: %+v", d)
	}

	// A board of this computer wins over a record of its id, and stays here.
	bd, err := e.bds.Create("Board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	fs.setBoard(bd.ID, farBoard{entry: entB, group: gOne})
	if _, err := e.m.CreateChat(NewChat{Board: bd.ID, Server: entB}); !errors.Is(err, ErrBoardLocal) {
		t.Errorf("a chat on a local board made on Bee: %v, want ErrBoardLocal", err)
	}
	here := e.newChat(NewChat{Board: bd.ID})
	if here.Server != "" || e.m.GroupOf(e.meta(here.ID)) != gTwo {
		t.Errorf("a chat on a local board: %+v", here)
	}
	if err := e.m.Configure(here.ID, ConfigReq{Server: entB}); !errors.Is(err, ErrBoardLocal) {
		t.Errorf("a chat on a local board moved to Bee: %v, want ErrBoardLocal", err)
	}

	// A record that is gone: the chat counts as ungrouped.
	w := e.newChat(NewChat{Board: far})
	fs.setBoard(far, farBoard{})
	if g := e.m.GroupOf(e.meta(w.ID)); g != model.Ungrouped {
		t.Errorf("the group of a chat whose board is gone: %q", g)
	}
}

// ---- a chat of an API client, and a manager with no server list ---------------------------

func TestClientChatsAreNeverRemote(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	sticky := model.GroupDefaults{Server: keyB, Servers: map[string]model.ServerDefaults{keyB: {Agent: model.Pi, Cwd: farSrv}}}
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{gOne: sticky, model.Ungrouped: sticky}})
	v := e.newChat(NewChat{Group: gOne, Client: "cli", Agent: model.Claude})
	if v.Server != "" || v.Cwd != e.cwd {
		t.Fatalf("a chat of an API client in a group whose sticky server is Bee: %+v", v)
	}
	if _, err := e.m.CreateChat(NewChat{Group: gOne, Client: "cli", Agent: model.Claude, Server: entB}); err == nil || !strings.Contains(err.Error(), `unknown server "`+entB+`"`) {
		t.Fatalf("a chat of an API client made on Bee: %v", err)
	}
	was := e.meta(v.ID)
	if err := e.m.Configure(v.ID, ConfigReq{Server: entB}); err == nil || !strings.Contains(err.Error(), `unknown server "`+entB+`"`) {
		t.Fatalf("a chat of an API client moved to Bee: %v", err)
	}
	if got := e.meta(v.ID); !reflect.DeepEqual(got, was) {
		t.Fatalf("the refused move left %+v", got)
	}
	e.configure(v.ID, ConfigReq{Server: model.LocalServer})
	if d := e.defs(); !reflect.DeepEqual(d.Groups[gOne], sticky) {
		t.Fatalf("a chat of an API client changed the defaults: %+v", d.Groups[gOne])
	}
}

func TestNoServerListIsThisComputerAlone(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne: {Server: keyB, Servers: map[string]model.ServerDefaults{keyB: {Agent: model.Pi, Cwd: farSrv}}},
	}})
	v := e.newChat(NewChat{Group: gOne})
	if v.Server != "" || v.Agent != model.Claude || v.Cwd != e.cwd {
		t.Fatalf("\"+\" with no server list: %+v", v)
	}
	if _, err := e.m.CreateChat(NewChat{Group: gOne, Server: entB}); err == nil || !strings.Contains(err.Error(), `unknown server "`+entB+`"`) {
		t.Fatalf("a chat made on another server with no list: %v", err)
	}
	if err := e.m.Configure(v.ID, ConfigReq{Server: entB}); err == nil || !strings.Contains(err.Error(), `unknown server "`+entB+`"`) {
		t.Fatalf("a chat moved with no list: %v", err)
	}
	e.m.ServerUp(entB)
	if got := e.m.UnstartedOn(entB); len(got) != 0 {
		t.Fatalf("UnstartedOn with no list: %v", got)
	}
	if _, err := e.m.HandOver(v.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("HandOver with no list: %v", err)
	}
	// A chat that was put on a server by a manager that had a list is still refused its send.
	e.m.Servers = &fakeServers{entries: map[string]RemoteEntry{entB: {ID: entB, Key: keyB}}}
	far := e.newChat(NewChat{Group: gTwo, Server: entB})
	e.boot()
	if err := e.m.Send(far.ID, "hi", "", nil); !errors.Is(err, ErrRemoteStart) {
		t.Fatalf("a send to a chat of another server, with no list: %v, want ErrRemoteStart", err)
	}
	if err := e.m.Delete(far.ID); err != nil {
		t.Fatal(err)
	}
}

// TestRunFolderGoesWithItsLastChat: a chat that has not started, on a run that is on another
// server, lives in the run's folder here, and nothing else does: no run.json is there. The
// folder goes with the last chat in it, at a hand-over and at a delete before the first message.
// A folder that holds a run.json, as that of a run of this server does, stays.
func TestRunFolderGoesWithItsLastChat(t *testing.T) {
	t.Parallel()
	e, _ := remoteEnv(t, model.Claude)
	const farRun = "r_far"
	e.m.Runs = &fakeRuns{runs: map[string]RunInfo{farRun: {Group: gOne, Cwd: "/c/run", Agent: model.Cursor, Model: "gpt-5.4-mini", Server: entC}}}
	runDir := e.st.P.RunDir(farRun)
	there := func() bool {
		t.Helper()
		_, err := os.Stat(runDir)
		if err != nil && !os.IsNotExist(err) {
			t.Fatal(err)
		}
		return err == nil
	}
	onRun := func() model.ChatView {
		t.Helper()
		v := e.newChat(NewChat{Run: farRun})
		if _, err := os.Stat(e.st.P.RunChatDir(farRun, false, v.ID)); err != nil || v.Server != entC {
			t.Fatalf("a chat on the run on Sea: %+v, its folder: %v", v, err)
		}
		return v
	}

	// Handed over: the folder stays while another chat is in it, and goes with the last one.
	first, second := onRun(), onRun()
	if _, err := e.m.HandOver(first.ID); err != nil || !there() {
		t.Fatalf("the hand-over of one of two chats: %v, the run's folder is there: %v", err, there())
	}
	if _, err := os.Stat(e.st.P.RunChatDir(farRun, false, second.ID)); err != nil {
		t.Fatalf("the folder of the other chat: %v", err)
	}
	if _, err := e.m.HandOver(second.ID); err != nil || there() {
		t.Fatalf("the hand-over of the last chat: %v, the run's folder is there: %v", err, there())
	}
	// Deleted before its first message.
	third := onRun()
	if err := e.m.Delete(third.ID); err != nil || there() {
		t.Fatalf("the delete of the last chat: %v, the run's folder is there: %v", err, there())
	}

	// A folder with a run.json in it is a run's own: it stays, and so does the file.
	fourth, fifth := onRun(), onRun()
	runFile := filepath.Join(runDir, "run.json")
	if err := os.WriteFile(runFile, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.HandOver(fourth.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Delete(fifth.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(runFile); err != nil {
		t.Fatalf("the run's file after its chats went: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runDir, "chats")); !os.IsNotExist(err) {
		t.Fatalf("the folder of the run's chats after the last one went: %v", err)
	}
}
