package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/linksim"
)

// The rig of the tests of both halves (plans/remote-server-sections-contract.md 4.6, point 2;
// the files both_*_test.go): one remote server and two local servers that are each a client of
// it, all of them real and in one process. The remote server is an env with a remote listener,
// stand-in agents and a run service; its own port is the owner's. Each local server is the A of
// a pair (boardpair_test.go) whose B is that one server: wired as the program wires it, with
// its own client id, its own entry for the remote server and its own link. The pages of all
// three are stand-in pages on the real bridges. Nothing is scripted between the servers, and a
// test asserts what a page sees: the routes of a section, GET /api/state and the events.

const (
	// The client ids of the two local servers: the instance ids they state to the remote server.
	bothID1 = testLocalID
	bothID2 = "22222222-3333-4444-8555-666666666666"
	// bothThird is the client id of a third local server, of the tests that need one more.
	bothThird = "33333333-4444-4555-8666-777777777777"
)

// bothAsk is one request the remote listener of the rig got.
type bothAsk struct{ Client, Method, Path string }

// front is the remote listener of the rig's remote server: RemoteHandler over TLS with the
// settings of ServeRemote, behind a note of every request, and served here so that a test can
// stop the listener for real and start it again on its port.
type front struct {
	t *testing.T
	l *listener
	h http.Handler

	mu   sync.Mutex
	srv  *http.Server
	done chan struct{}
	got  []bothAsk
}

func (f *front) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.got = append(f.got, bothAsk{r.Header.Get(ClientHeader), r.Method, r.URL.Path})
	f.mu.Unlock()
	f.h.ServeHTTP(w, r)
}

// start serves on ln; nil listens on the listener's port again, which a stop has left.
func (f *front) start(ln net.Listener) {
	f.t.Helper()
	for end := time.Now().Add(waitLimit); ln == nil; time.Sleep(10 * time.Millisecond) {
		var err error
		if ln, err = net.Listen("tcp4", f.l.host); err != nil && time.Now().After(end) {
			f.t.Fatalf("the remote listener does not get its port again: %v", err)
		}
	}
	srv := &http.Server{
		Handler:           f,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{f.l.pair}, MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.ServeTLS(ln, "", "")
	}()
	f.mu.Lock()
	f.srv, f.done = srv, done
	f.mu.Unlock()
}

// stop closes the listener and every connection it has, the streams among them, at once. A
// second stop does nothing.
func (f *front) stop() {
	f.mu.Lock()
	srv, done := f.srv, f.done
	f.srv = nil
	f.mu.Unlock()
	if srv == nil {
		return
	}
	srv.Close()
	<-done
}

// requests are the requests the listener got so far.
func (f *front) requests() []bothAsk {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.got)
}

// wiring says how a server is made a client of other servers.
type wiring struct {
	root   string           // the folder of its server list
	id     string           // its instance id: the client id it states
	limits remotes.Limits   // the relay's; zero fields are the defaults
	dial   servers.DialFunc // nil = the plain dialer
	taken  func(entry string)
}

// wire makes s a client of the servers of its list, as the program wires it (startServers of
// cmd/ai-whiteboard, and newPairWith): a real servers.Manager on the list in w.root and a real
// relay. taken is called when the relay was given a snapshot of an entry. The caller adds the
// entries and starts the manager.
func (w wiring) wire(t *testing.T, s *Server) (*servers.Manager, *remotes.Relay) {
	t.Helper()
	// The remote server's bridge sends no pings here, so a quiet stream is no dead one: an
	// outage of these tests is the link's or the listener's alone.
	timing := farTiming()
	timing.Silence = 10 * time.Minute
	var listed atomic.Pointer[remotes.Relay]
	m, err := servers.Open(servers.Options{Root: w.root, LocalID: w.id, Version: "test", Timing: timing, Dial: w.dial,
		Notify: func(ev any) {
			s.Bridge.Broadcast(ev)
			if rm := listed.Load(); rm != nil {
				rm.ServersChanged()
			}
		}})
	if err != nil {
		t.Fatal(err)
	}
	rm, err := remotes.Open(remotes.Options{Servers: m, Bridge: s.Bridge, Limits: w.limits, Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	s.Servers, s.App.Servers = m, m
	s.Remotes, s.App.Remotes = rm, rm
	s.Bridge.OnUnfollowed(rm.Unfollowed)
	s.Bridge.OnBoardFree(rm.BoardFree)
	ownRev := s.Bridge.SceneRev
	s.Bridge.SceneRev = func(key string) int64 {
		if rev, ok := rm.BoardRev(key); ok {
			return rev
		}
		return ownRev(key)
	}
	hooks := rm.Hooks()
	snapshot := hooks.Snapshot
	hooks.Snapshot = func(entry string, raw json.RawMessage) {
		snapshot(entry, raw)
		if w.taken != nil {
			w.taken(entry)
		}
	}
	m.SetHooks(hooks)
	listed.Store(rm)
	t.Cleanup(func() { // the order of a shutdown
		m.Close()
		rm.Close()
	})
	return m, rm
}

// entryFor adds the remote listener l to the list of m under this name, and returns the entry's id.
func entryFor(t *testing.T, m *servers.Manager, name string, l *listener) string {
	t.Helper()
	v, saved, _, err := m.Add(context.Background(), servers.Input{
		Name: name, Address: l.base, Secret: testSecret, SelfSigned: true, Pin: l.pin,
	}, true)
	if err != nil || !saved {
		t.Fatalf("the entry %s is not saved: %v", name, err)
	}
	return v.ID
}

// side is one local server of the rig: the A of a pair whose B is the rig's remote server.
type side struct {
	*pair
	id   string // the client id it states to the remote server
	name string // the name of its entry for the remote server
	who  string // what a failure calls it
}

// cut cuts this side's link and waits until both ends know: its entry is not connected, and
// the remote server has no stream of it.
func (sd *side) cut() {
	sd.t.Helper()
	sd.link.Cut()
	sd.away()
}

// away waits until both ends know that this side's connection is gone.
func (sd *side) away() {
	sd.t.Helper()
	sd.wait(sd.who+"'s entry is not connected", func() bool {
		v, _ := sd.m.View(sd.entry)
		_, held := sd.rm.Sections()[sd.entry]
		return v.State != servers.StateConnected && !held
	})
	sd.wait("the remote server has no stream of "+sd.who, func() bool { return !sd.b.s.Bridge.Known(sd.id) })
}

// notConnected is the sentence of a call for the entry while it is not connected.
func (sd *side) notConnected() string { return sd.name + " is not connected." }

// both is the rig: the remote server, and the local servers that are its clients.
type both struct {
	t     *testing.T
	b     *env          // the remote server; its own port is the owner's
	l     *listener     // its remote listener's address and certificate
	fr    *front        // its remote listener
	sp    *apiSpawner   // the agents of its chats
	rs    *runs.Service // its runs
	c     []*side
	marks atomic.Int64
}

// bothOpt says how a rig differs from the usual one.
type bothOpt struct {
	clients int             // the local servers; 0 = the two
	limits  remotes.Limits  // of every local server's relay
	link    linksim.Profile // of every link; the zero value adds no time
	withB   []func(*Server) // set up the remote server
	withA   []func(*Server) // set up every local server, before it is wired
	noRuns  bool            // the remote server has no run service
}

// newBoth starts the remote server and then its clients, and waits until each holds its tree.
func newBoth(t *testing.T, o bothOpt) *both {
	t.Helper()
	bo := &both{t: t, sp: &apiSpawner{}}
	bo.l = newListener(t)
	// The consumer (internal/servers) requires a home that is not empty.
	home := func(s *Server) { s.App.Home = "/home/owner" }
	with := []func(*Server){bo.l.set, home, withAgents(bo.sp)}
	if !o.noRuns {
		with = append(with, bo.withRuns)
	}
	// The data folder has a name of its own: a run refuses a folder whose path holds that name,
	// and the name of a test's folder is a number that a path may well hold.
	bo.b = newEnvIn(t, filepath.Join(t.TempDir(), "aiwb-both-data"), append(with, o.withB...)...)
	bo.fr = &front{t: t, l: bo.l, h: bo.b.s.RemoteHandler()}
	bo.fr.start(bo.l.ln)
	t.Cleanup(bo.fr.stop)
	if o.clients == 0 {
		o.clients = 2
	}
	for i := range o.clients {
		id := []string{bothID1, bothID2, bothThird}[i]
		name := []string{"Studio", "Atelier", "Workshop"}[i]
		bo.c = append(bo.c, bo.join(id, name, fmt.Sprintf("client %d", i+1), o))
	}
	return bo
}

// pair is a pair of the rig's first client and the remote server, for its helpers that read a
// page's events.
func (bo *both) pair() *pair { return bo.c[0].pair }

// withRuns gives the remote server a run service, as the program wires it. Its agents are the
// chat manager's: the stand-ins of the rig.
func (bo *both) withRuns(s *Server) {
	rs := runs.New(runs.Deps{Store: s.App.St, Emit: s.Bridge, DefaultCwd: s.App.DefaultCwd, HaltWait: 300 * time.Millisecond})
	if err := rs.Load(); err != nil {
		bo.t.Fatal(err)
	}
	rs.Chats = s.App.Chats
	s.App.Chats.Runs = rs
	s.App.Runs, s.Relay.Runs = rs, rs
	bo.rs = rs
	bo.t.Cleanup(func() { rs.Shutdown(5 * time.Second) })
}

// join starts a local server that is a client of the remote server, and waits for its tree.
func (bo *both) join(id, name, who string, o bothOpt) *side {
	bo.t.Helper()
	pr := &pair{t: bo.t, b: bo.b, l: bo.l, sp: bo.sp, root: bo.t.TempDir()}
	// The local server dials the link whatever the entry's address is, so the address, the pin
	// and the Host of its requests stay the remote listener's own.
	pr.link = linksim.Start(bo.t, bo.l.host, o.link)
	sd := &side{pair: pr, id: id, name: name, who: who}
	pr.a = newEnv(bo.t, append(slices.Clone(o.withA), func(s *Server) { sd.wire(s, o.limits, true) })...)
	pr.returned(1)
	return sd
}

// rejoin builds the local server of a side anew on the folder of its list, as a restart does:
// a new server with a new manager and a new relay, which know what the folder holds and nothing
// else. The link is the old side's, in whatever state it is; the old side's manager and relay
// must be closed. It does not wait for the tree.
func (bo *both) rejoin(old *side) *side {
	bo.t.Helper()
	pr := &pair{t: bo.t, b: bo.b, l: bo.l, sp: bo.sp, root: old.root, link: old.link}
	sd := &side{pair: pr, id: old.id, name: old.name, who: old.who + ", rebuilt"}
	pr.a = newEnv(bo.t, func(s *Server) { sd.wire(s, remotes.Limits{}, false) })
	for _, v := range pr.m.Views() {
		if !v.Local {
			pr.entry = v.ID
		}
	}
	return sd
}

// wire makes s this side's server: a client of the servers in the list of the side's folder.
// With add, the remote server joins the list as a new entry; without, the list is as the folder
// has it. The manager is started.
func (sd *side) wire(s *Server, limits remotes.Limits, add bool) {
	sd.t.Helper()
	pr := sd.pair
	pr.m, pr.rm = wiring{root: pr.root, id: sd.id, limits: limits, dial: pr.link.Dial, taken: func(string) { pr.ups.Add(1) }}.wire(sd.t, s)
	if add {
		pr.entry = entryFor(sd.t, pr.m, sd.name, pr.l)
	}
	pr.m.Start()
}

// ---- who uses the remote server -------------------------------------------------

// user is one who uses the remote server through a page: the owner, on that server's own port,
// or a page of a local server that is its client.
type user struct {
	who   string
	p     *bridgetest.Page
	sd    *side  // nil for the owner
	entry string // "" for the owner: what an event of the remote server has as "server" on this page
	at    string // what the path of a call for a thing of the remote server starts with
}

// owner connects a page of the remote server's own.
func (bo *both) owner(id string) *user {
	bo.t.Helper()
	return &user{who: "the owner's page " + id, p: bo.b.page(id), at: "/api"}
}

// page connects a page of the local server.
func (sd *side) page(id string) *user {
	sd.t.Helper()
	return &user{who: sd.who + "'s page " + id, p: sd.a.page(id), sd: sd, entry: sd.entry, at: strings.TrimSuffix(sd.on(""), "/")}
}

// three are a page of the owner and a page of each of the two clients.
func (bo *both) three() []*user {
	bo.t.Helper()
	return []*user{bo.owner("owner-page"), bo.c[0].page("P1"), bo.c[1].page("P2")}
}

// call is a call of the user for a thing of the remote server: rest is the path after /api.
func (u *user) call(method, rest string, body any) (int, string) {
	status, out := u.p.Do(method, u.at+rest, body)
	return status, strings.TrimSpace(string(out))
}

// want is a call that must be answered with this status. It returns the body.
func (u *user) want(t *testing.T, status int, method, rest string, body any) string {
	t.Helper()
	got, out := u.call(method, rest, body)
	if got != status {
		t.Fatalf("%s %s by %s: status %d, want %d (%s)", method, rest, u.who, got, status, out)
	}
	return out
}

// refused is a call that must be refused with this status and this code. It returns the sentence.
func (u *user) refused(t *testing.T, status int, code, method, rest string, body any) string {
	t.Helper()
	got, out := u.call(method, rest, body)
	var r struct{ Error, Code string }
	json.Unmarshal([]byte(out), &r)
	if got != status || r.Code != code || r.Error == "" {
		t.Fatalf("%s %s by %s: %d %s, want %d with the code %q", method, rest, u.who, got, out, status, code)
	}
	return r.Error
}

// tree is what the user's page is handed of the remote server's tree by a fresh GET /api/state,
// as JSON: the lists of the owner's own state, or the section of the client's entry; "" when
// the client's state has no section of the entry. "collapsed", which is the owner's own matter
// and no part of a section, is taken out of the owner's groups.
func (u *user) tree(t *testing.T) string {
	t.Helper()
	status, out := u.p.Do("GET", "/api/state", nil)
	if status != 200 {
		t.Fatalf("GET /api/state by %s: %d %s", u.who, status, out)
	}
	state := decode[map[string]json.RawMessage](t, string(out))
	if u.sd != nil {
		sections := decode[map[string]json.RawMessage](t, string(state["sections"]))
		if strings.Contains(string(sections[u.entry]), `"collapsed"`) {
			t.Errorf("the section of %s has collapsed: %s", u.who, sections[u.entry])
		}
		return string(sections[u.entry])
	}
	tree := map[string]any{}
	for _, k := range []string{"groups", "boards", "chats", "states", "runs", "defaults"} {
		tree[k] = decode[any](t, string(state[k]))
	}
	for _, g := range tree["groups"].([]any) {
		delete(g.(map[string]any), "collapsed")
	}
	raw, _ := json.Marshal(tree)
	return string(raw)
}

// plain is an event of the remote server as the user's page got it, without what tells whose
// it is: a client's page must have it with the entry's id as "server", which is taken out, and
// the owner's page without one. Of the owner's groups "collapsed" is taken out. The keys are
// sorted, so two pages got the same event when their plain ones are equal.
func (u *user) plain(t *testing.T, raw string) string {
	t.Helper()
	ev := decode[map[string]any](t, raw)
	if server, _ := ev["server"].(string); server != u.entry {
		t.Fatalf("%s got an event with the server %q, want %q: %s", u.who, server, u.entry, raw)
	}
	delete(ev, "server")
	if u.sd != nil && strings.Contains(raw, `"collapsed"`) {
		t.Errorf("%s got collapsed in an event of the section: %s", u.who, raw)
	}
	if groups, ok := ev["groups"].([]any); ok && u.sd == nil {
		for _, g := range groups {
			delete(g.(map[string]any), "collapsed")
		}
	}
	out, _ := json.Marshal(ev)
	return string(out)
}

// bothTree is the event types that tell a change of a server's tree, and bothContent the ones
// that tell the content of a chat or a run to who follows it, and bothRole a board's.
var (
	bothTree    = []string{"groups", "defaults", "board", "board_removed", "chat", "chat_removed", "branch_state", "run", "run_removed"}
	bothContent = []string{"tree", "chat_items", "sub", "sub_items", "run_detail", "run_activity"}
	bothRole    = []string{"held", "release_request", "superseded", "rpc"}
)

// next reads the page's events up to the next event of the remote server, and returns it made
// plain: an event of the tree, of the content of a chat or a run, or of a board's hold. What a
// local server sends of its own (the states of its list, its own tree) is no event of the
// remote server and is left out. With a mark, the event of that mark (reach) ends the read
// instead: marked is true then.
func (u *user) next(t *testing.T, mark string) (plain string, marked bool) {
	t.Helper()
	last := "catalog"
	if u.sd != nil {
		last = "server_lists"
	}
	for {
		raw := u.p.NextRaw()
		typ := typeOf(raw)
		if mark != "" && typ == last && strings.Contains(raw, mark) {
			return "", true
		}
		if !slices.Contains(bothTree, typ) && !slices.Contains(bothContent, typ) && !slices.Contains(bothRole, typ) {
			continue
		}
		// A client's page has a tree of its own server too: its events have no "server".
		if u.sd != nil && !strings.Contains(raw, `"server":"`+u.entry+`"`) {
			continue
		}
		return u.plain(t, raw), false
	}
}

// upTo reads the user's events of the remote server up to the first of this type that holds
// every one of has, and returns them, that one last.
func (u *user) upTo(t *testing.T, typ string, has ...string) []string {
	t.Helper()
	var got []string
	for {
		ev, _ := u.next(t, "")
		got = append(got, ev)
		if l5Count(got[len(got)-1:], typ, has...) == 1 {
			return got
		}
	}
}

// reach returns, for each user, the events of the remote server its page was sent and has not
// read yet, each made plain (next). The remote server sends a model list with a name of this
// call's own, which the owner's page gets as it is and a client's page as the lists of the
// entry: what the remote server sent before is in front of it on every stream, in that
// server's order. Every user's server must be connected.
func (bo *both) reach(users ...*user) [][]string {
	bo.t.Helper()
	mark := fmt.Sprintf("both-mark-%d", bo.marks.Add(1))
	bo.b.s.Bridge.Broadcast(map[string]any{"type": "catalog", "agent": model.Pi,
		"catalog": model.Catalog{Models: []model.CatalogModel{{ID: mark, Label: mark}}, Default: model.ModelChoice{Model: mark}}})
	out := make([][]string, len(users))
	for i, u := range users {
		for {
			ev, marked := u.next(bo.t, mark)
			if marked {
				break
			}
			out[i] = append(out[i], ev)
		}
	}
	return out
}

// same reads what the users were sent (reach) and fails unless every one of them was sent the
// same events of the tree, in the same order: the first user's are returned. No event says who
// made a thing.
func (bo *both) same(what string, users ...*user) []string {
	bo.t.Helper()
	return bo.told(what, users)
}

// told is same for a change that is told a moment after its call was answered: the events of a
// run come from the run service's own queue. Each of waits is a type and what the event holds;
// each user is read until it was sent every one of them, and then up to the mark of reach.
func (bo *both) told(what string, users []*user, waits ...[]string) []string {
	bo.t.Helper()
	got := make([][]string, len(users))
	for i, u := range users {
		left := slices.Clone(waits)
		for len(left) > 0 {
			ev, _ := u.next(bo.t, "")
			got[i] = append(got[i], ev)
			left = slices.DeleteFunc(left, func(w []string) bool { return l5Count([]string{ev}, w[0], w[1:]...) == 1 })
		}
	}
	for i, rest := range bo.reach(users...) {
		got[i] = append(got[i], rest...)
	}
	lists := make([][]string, len(users))
	for i, evs := range got {
		lists[i] = only(evs, bothTree...)
		for _, raw := range evs {
			l5Unmarked(bo.t, "an event "+users[i].who+" was sent", raw)
		}
	}
	for i := range users[1:] {
		if !slices.Equal(lists[i+1], lists[0]) {
			bo.t.Fatalf("%s: %s was sent\n%s\nand %s\n%s", what, users[i+1].who, strings.Join(lists[i+1], "\n"), users[0].who, strings.Join(lists[0], "\n"))
		}
	}
	return lists[0]
}

// last is the last of the events that is of this type and holds has; the test fails without one.
func (bo *both) last(what string, evs []string, typ string, has ...string) string {
	bo.t.Helper()
	for i := len(evs) - 1; i >= 0; i-- {
		if l5Count(evs[i:i+1], typ, has...) == 1 {
			return evs[i]
		}
	}
	bo.t.Fatalf("%s: no %s event with %v among %v", what, typ, has, evs)
	return ""
}

// level fails unless a fresh GET /api/state hands every user the same tree of the remote
// server: the same groups in the same order, and the same boards, chats, branch states, runs
// and defaults. No row says who made it. It returns that tree, as the first user has it.
func (bo *both) level(what string, users ...*user) string {
	bo.t.Helper()
	first := users[0].tree(bo.t)
	l5Unmarked(bo.t, "the tree of "+users[0].who, first)
	for _, u := range users[1:] {
		tree := u.tree(bo.t)
		if tree == "" {
			bo.t.Fatalf("%s: %s has no tree of the remote server", what, u.who)
		}
		l5Unmarked(bo.t, "the tree of "+u.who, tree)
		for _, f := range []string{"groups", "boards", "chats", "states", "runs", "defaults"} {
			if !l5SameList(bo.t, first, tree, f) {
				bo.t.Fatalf("%s: the %s of %s are\n%s\nand of %s\n%s", what, f, u.who, l5Field(bo.t, tree, f), users[0].who, l5Field(bo.t, first, f))
			}
		}
	}
	return first
}

// orchestrator waits until the run has its first turn, and returns the chat of that turn's
// agent, as the user reads it in the run's detail. The detail names the chat a moment before
// the engine has made it: the chat is waited for too, so that a read of it finds it.
func (bo *both) orchestrator(u *user, run string) string {
	bo.t.Helper()
	for end := time.Now().Add(waitLimit); ; time.Sleep(5 * time.Millisecond) {
		status, out := u.call("GET", "/runs/"+run+"/detail", nil)
		if status == 200 {
			if d := decode[model.RunDetail](bo.t, out); len(d.Turns) > 0 && d.Turns[0].Agent != "" {
				if status, out = u.call("GET", "/chats/"+d.Turns[0].Agent, nil); status == 200 {
					return d.Turns[0].Agent
				}
			}
		}
		if time.Now().After(end) {
			bo.t.Fatalf("the run %s has no turn: %d %s", run, status, out)
		}
	}
}

// stopRun stops a run that works, as the user, and waits until it has stopped. The stand-in
// agent of its turn ends the turn when it is told to: without that the run would stop only when
// the server does.
func (bo *both) stopRun(u *user, run string) {
	bo.t.Helper()
	// The turn's program is waited for before the stop, so that the stop finds a turn that
	// works, whose program can be told to end it.
	ag := bo.sp.of(bo.t, bo.orchestrator(u, run))
	u.want(bo.t, 200, "POST", "/runs/"+run+"/stop", nil)
	reply(bo.t, &ag.fakeAgent, "Stopped.", "")
	for end := time.Now().Add(waitLimit); ; time.Sleep(5 * time.Millisecond) {
		v := decode[model.RunView](bo.t, u.want(bo.t, 200, "GET", "/runs/"+run, nil))
		if v.Status == model.RunStopped {
			return
		}
		if time.Now().After(end) {
			bo.t.Fatalf("the run %s did not stop: %+v", run, v)
		}
	}
}

// untouched runs do and fails when the remote listener got a request meanwhile.
func (bo *both) untouched(what string, do func()) {
	bo.t.Helper()
	before := len(bo.fr.requests())
	do()
	if got := bo.fr.requests(); len(got) != before {
		bo.t.Errorf("%s: the remote server was sent %+v", what, got[before:])
	}
}

// sectionEvent reads the page's events up to the next section event of the entry, and returns
// its tree as JSON: "null" for one without a tree.
func (u *user) sectionEvent(t *testing.T) string {
	t.Helper()
	for end := time.Now().Add(waitLimit); time.Now().Before(end); {
		raw := u.p.NextRaw()
		if typeOf(raw) != "section" {
			continue
		}
		ev := decode[struct {
			Server string
			Tree   json.RawMessage
		}](t, raw)
		if ev.Server == u.entry {
			return string(ev.Tree)
		}
	}
	t.Fatalf("%s got no section event", u.who)
	return ""
}
