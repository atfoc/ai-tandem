package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/boardapi"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/store"
)

// serversReply is the answer of GET /api/servers.
type serversReply struct {
	Servers []servers.View `json:"servers"`
	Notice  string         `json:"notice"`
}

// serverList asks the running server for its list.
func (in *instance) serverList(t *testing.T) serversReply {
	t.Helper()
	resp, err := httpClient().Get(in.url + "api/servers")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var l serversReply
	if err := json.NewDecoder(resp.Body).Decode(&l); err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("servers: status %d, %v", resp.StatusCode, err)
	}
	return l
}

// listFiles is the names in dir that begin with the list file's name.
func listFiles(t *testing.T, dir string) []string {
	t.Helper()
	got, err := filepath.Glob(filepath.Join(dir, servers.FileName+"*"))
	if err != nil {
		t.Fatal(err)
	}
	for i := range got {
		got[i] = filepath.Base(got[i])
	}
	return got
}

// savedEntry is a list file with one entry for the stand-in, its certificate pinned.
func savedEntry(st *standin.Server) string {
	return fmt.Sprintf(`{"version":1,"servers":[{"id":"`+savedEntryID+`","name":"Studio","address":%q,"secret":%q,"selfSigned":true,"pin":%q}]}`,
		st.URL(), standin.DefaultSecret, st.Fingerprint())
}

// program is a server wired in this process as serve wires it, on a scratch data folder: the
// store, the bridge, the boards, the chats, the run service when it has one, this computer's
// prompt library, and what startServers adds. Its routes are served on a loopback port, as a page reaches them.
type program struct {
	a    *app.App
	srv  *server.Server
	cm   *chats.Manager
	url  string // of the routes, without a slash at its end
	stop func() // ends it as a quit ends the server; the test's end calls it too
}

// wired runs startServers on the data folder root, as serve does, and returns what it set. The
// app has a run service, as serve's has.
func wired(t *testing.T, root string) *program {
	t.Helper()
	return wiredWith(t, root, true)
}

// wiredWith is wired for an app with or without a run service.
func wiredWith(t *testing.T, root string, withRuns bool) *program {
	t.Helper()
	return wiredWaits(t, root, withRuns, testWaits{})
}

// wiredWaits is wiredWith for a server that was given these waits (AIWB_TEST_WAITS). The boards,
// the runs and the chats are loaded from the folder before startServers, in serve's order.
func wiredWaits(t *testing.T, root string, withRuns bool, w testWaits) *program {
	t.Helper()
	p := store.NewPaths(root)
	st, err := store.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	var a *app.App
	br := editorbridge.New(func() any { return a.Snapshot() })
	bs := boards.New(st, br)
	br.SceneRev = bs.Rev
	cwd := t.TempDir()
	cm := chats.New(chats.Deps{Store: st, Bridge: br, Boards: bs, DefaultCwd: cwd})
	a = &app.App{St: st, Boards: bs, Chats: cm, Bridge: br, DataDir: root, DefaultCwd: cwd}
	relay := &boardapi.Relay{Bridge: br, Chats: cm, Boards: bs}
	if err := bs.Load(); err != nil {
		t.Fatal(err)
	}
	if withRuns {
		rs := runs.New(runs.Deps{Store: st, Emit: br, DefaultCwd: cwd, HaltWait: 300 * time.Millisecond})
		if err := rs.Load(); err != nil {
			t.Fatal(err)
		}
		rs.Chats, cm.Runs = cm, rs
		a.Runs, relay.Runs = rs, rs
	}
	if err := cm.Load(); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if err := a.OpenLibrary(root); err != nil { // this computer's prompt library, as serve opens it
		t.Fatal(err)
	}
	srv := &server.Server{App: a, Relay: relay, Bridge: br, Port: ln.Addr().(*net.TCPAddr).Port}
	stopServers := startServers(p, br, cm, a, srv, w)
	hs := &httptest.Server{Listener: ln, Config: &http.Server{Handler: srv.Handler()}}
	hs.Start()
	pr := &program{a: a, srv: srv, cm: cm, url: hs.URL}
	pr.stop = sync.OnceFunc(func() { // in the order of serve's quit, and then the listener
		if a.Runs != nil {
			a.Runs.Shutdown(time.Second)
		}
		cm.Shutdown()
		stopServers()
		hs.CloseClientConnections() // the streams of the pages that are still open
		hs.Close()
	})
	t.Cleanup(pr.stop)
	return pr
}

// page opens the event stream of a stand-in page of the program: from then on the id is a known
// client, whose writes are taken.
func (pr *program) page(t *testing.T, id string) *watcher {
	t.Helper()
	return watch(t, http.DefaultClient, pr.url, id, nil)
}

// send makes a call of the page id whose body, when there is one, is these bytes of this type,
// and returns the answer with its body.
func (pr *program) send(t *testing.T, id, method, path, contentType string, body []byte) (*http.Response, []byte) {
	t.Helper()
	return pageSend(t, pr.url, id, method, path, contentType, body)
}

// call makes a call of the page id with body as JSON (nil: none) and returns what the route
// answered.
func (pr *program) call(t *testing.T, id, method, path string, body any) answer {
	t.Helper()
	return pageCall(t, pr.url, id, method, path, body)
}

// pageSend makes a call of the page id on the routes of the server at base, in this process or
// in another: its body, when there is one, is these bytes of this type. It returns the answer
// with its body.
func pageSend(t *testing.T, base, id, method, path, contentType string, body []byte) (*http.Response, []byte) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, base+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(server.ClientHeader, id)
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp, raw
}

// pageCall is pageSend with body as JSON (nil: none); it returns what the route answered.
func pageCall(t *testing.T, base, id, method, path string, body any) answer {
	t.Helper()
	var b []byte
	if body != nil {
		var err error
		if b, err = json.Marshal(body); err != nil {
			t.Fatal(err)
		}
	}
	resp, raw := pageSend(t, base, id, method, path, "application/json", b)
	a := answer{}
	json.Unmarshal(raw, &a)
	a.Status, a.Raw = resp.StatusCode, string(raw)
	return a
}

// sectionOf is the tree the relay holds of the entry; ok is false while it holds none.
func (pr *program) sectionOf(entry string) (tree remotes.Tree, ok bool) {
	tree, ok = pr.a.Remotes.Sections()[entry]
	return tree, ok
}

// until waits for good, for ten seconds at most.
func until(t *testing.T, what string, good func() bool) {
	t.Helper()
	for end := time.Now().Add(10 * time.Second); !good(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("waited in vain: %s", what)
		}
	}
}

// savedEntryID is the id of the entry savedEntry writes.
const savedEntryID = "s_0123456789ab"

// A saved entry whose server is too old is asked again by itself, as often as the waits say
// (five minutes when they say nothing), and connects once that server reports the level: the
// relay then has its lists and its tree, with nothing done here. Until then the server is sent
// hello alone, the entry says that it is too old with the version that server reports, no page
// is handed a tree of it, and a call for a thing of it says that the server must be updated.
func TestStartServersTooOldEntryConnectsAfterTheUpdate(t *testing.T) {
	t.Parallel()
	const entry = savedEntryID
	st := standin.Start(t, standin.Options{FeatureLevel: standin.Level(servers.MinFeatureLevel - 1)})
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, servers.FileName), []byte(savedEntry(st)), 0o600); err != nil {
		t.Fatal(err)
	}
	w, err := parseTestWaits("tooold=40ms")
	if err != nil {
		t.Fatal(err)
	}
	pr := wiredWaits(t, root, false, w)
	a := pr.a
	state := func() servers.State {
		v, _ := a.Servers.View(entry)
		return v.State
	}
	until(t, "the entry is too old", func() bool { return state() == servers.StateTooOld })
	until(t, "the entry asks again, and again", func() bool { return len(st.Requests()) >= 3 })
	if v, _ := a.Servers.View(entry); v.State != servers.StateTooOld || v.Version != standin.DefaultVersion {
		t.Fatalf("the entry of a server that is too old: %+v, want its version %q", v, standin.DefaultVersion)
	}
	page := pr.page(t, "page")
	var snap struct {
		Sections map[string]json.RawMessage
		Servers  []servers.View
	}
	if got := pr.call(t, "page", "GET", "/api/state", nil); json.Unmarshal([]byte(got.Raw), &snap) != nil || snap.Sections == nil || len(snap.Sections) != 0 ||
		len(snap.Servers) != 2 || snap.Servers[1].State != servers.StateTooOld || snap.Servers[1].Version != standin.DefaultVersion {
		t.Fatalf("the page's snapshot with an entry that is too old: %s", got)
	}
	for _, c := range []struct {
		method, path string
		body         any
	}{
		{"GET", "/chats/2a000000-0000-4000-8000-00000000000a", nil},
		{"POST", "/chats", map[string]any{"group": model.Ungrouped}},
		{"POST", "/boards/b_aaaa0001/take", map[string]any{"ifFree": true}},
	} {
		got := pr.call(t, "page", c.method, "/api/on/"+entry+c.path, c.body)
		if got.Status != http.StatusServiceUnavailable || got.Code != "server_unreachable" || got.Error != "Studio is too old: update the server on that machine." {
			t.Fatalf("%s %s for an entry that is too old: %s", c.method, c.path, got)
		}
	}
	for _, r := range st.Requests() {
		if r.Path != servers.HelloPath {
			t.Fatalf("the too old server was sent %s %s", r.Method, r.Path)
		}
	}
	if _, ok := a.Remotes.Lists()[entry]; ok || state() != servers.StateTooOld {
		t.Fatalf("the entry before the update: %q, lists known %v", state(), ok)
	}
	if _, ok := pr.sectionOf(entry); ok {
		t.Fatal("the relay holds a tree of a server that is too old")
	}

	mark := page.mark()
	st.SetFeatureLevel(standin.Level(servers.MinFeatureLevel))
	until(t, "the entry is connected", func() bool { return state() == servers.StateConnected })
	until(t, "the relay has the entry's lists", func() bool { _, ok := a.Remotes.Lists()[entry]; return ok })
	until(t, "the relay has the entry's tree", func() bool { _, ok := pr.sectionOf(entry); return ok })
	page.await(t, mark, 10*time.Second, "section event with the tree of the updated server", func(e seenEvent) bool {
		return e.holds("section", entry, `"tree":{`)
	})
}

// startServers gives the app and the routes one manager and one relay, and the saved entries
// connect with this installation's instance id as their client id and with the level of this app
// stated on every request.
func TestStartServersConnectsSavedEntries(t *testing.T) {
	t.Parallel()
	st := standin.Start(t, standin.Options{})
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, servers.FileName), []byte(savedEntry(st)), 0o600); err != nil {
		t.Fatal(err)
	}
	pr := wired(t, root)
	a, srv := pr.a, pr.srv
	if a.Servers == nil || a.Servers != srv.Servers {
		t.Fatalf("the app has %p, the routes have %p", a.Servers, srv.Servers)
	}
	if a.Remotes == nil || a.Remotes != srv.Remotes {
		t.Fatalf("the relay: the app has %p, the routes have %p", a.Remotes, srv.Remotes)
	}
	id, err := remote.EnsureInstanceID(root)
	if err != nil || id == "" {
		t.Fatalf("instance id: %q, %v", id, err)
	}
	var v servers.View
	for end := time.Now().Add(10 * time.Second); v.State != servers.StateConnected; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("the entry is %q (%s)", v.State, v.Detail)
		}
		v, _ = a.Servers.View(savedEntryID)
	}
	if local := a.Servers.Views()[0]; local.ID != servers.LocalID || local.InstanceID != id {
		t.Fatalf("local entry: %+v, want the instance id %s", local, id)
	}
	// The relay's hooks were set before the entry connected: its snapshot went through them.
	until(t, "the relay has the entry's lists: its hooks were set at the first connect", func() bool {
		_, ok := a.Remotes.Lists()[savedEntryID]
		return ok
	})
	until(t, "the relay has the entry's tree", func() bool { _, ok := pr.sectionOf(savedEntryID); return ok })
	reqs := st.Requests()
	if len(reqs) == 0 {
		t.Fatal("the stand-in got no request")
	}
	for _, r := range reqs {
		if r.Client != id || r.Secret != standin.DefaultSecret || r.Level != strconv.Itoa(servers.ClientLevel) {
			t.Fatalf("request %+v, want the client %s and the level %d", r, id, servers.ClientLevel)
		}
	}
}

// startServers wires the relay the same for an app with a run service and for one without: the
// runs of another server are in its section and are reached through the relay, which asks no
// run service, and the runs of this computer are the run service's own, which knows nothing of
// another server.
func TestStartServersWiresRuns(t *testing.T) {
	t.Parallel()
	const entry, there = savedEntryID, "r_there001"
	far := model.RunView{ID: there, Name: "There", Group: model.Ungrouped, Agent: model.Claude, Status: model.RunDraft}
	snap := standin.DefaultSnapshot()
	snap["runs"] = []model.RunView{far}
	st := standin.Start(t, standin.Options{Snapshot: snap})
	st.Handle("GET /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(far)
	})
	for _, withRuns := range []bool{true, false} {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, servers.FileName), []byte(savedEntry(st)), 0o600); err != nil {
			t.Fatal(err)
		}
		pr := wiredWith(t, root, withRuns)
		if (pr.a.Runs != nil) != withRuns || pr.a.Remotes == nil {
			t.Fatalf("with a run service %v: runs %p, relay %p", withRuns, pr.a.Runs, pr.a.Remotes)
		}
		until(t, "the relay has the entry's tree", func() bool { _, ok := pr.sectionOf(entry); return ok })
		if tree, _ := pr.sectionOf(entry); len(tree.Runs) != 1 || tree.Runs[0].ID != there {
			t.Fatalf("with a run service %v: the runs of the section: %+v", withRuns, tree.Runs)
		}
		pr.page(t, "page")
		if got := pr.call(t, "page", "GET", "/api/on/"+entry+"/runs/"+there, nil); got.Status != http.StatusOK || !strings.Contains(got.Raw, there) {
			t.Fatalf("with a run service %v: the run of the section through the routes: %s", withRuns, got)
		}
		// The route of this computer's own runs finds no such run, and sends that server nothing.
		sent := len(st.Requests())
		if got := pr.call(t, "page", "GET", "/api/runs/"+there, nil); got.Status != http.StatusNotFound {
			t.Fatalf("with a run service %v: the run of the section on the route of this computer's runs: %s", withRuns, got)
		}
		if got := st.Requests(); len(got) != sent {
			t.Fatalf("with a run service %v: the stand-in was sent %+v for a run of this computer", withRuns, got[sent:])
		}
		var state struct{ Runs []model.RunView }
		if withRuns {
			here, err := pr.a.Runs.Create(model.Ungrouped, "Here")
			if err != nil {
				t.Fatal(err)
			}
			if got := pr.call(t, "page", "GET", "/api/state", nil); json.Unmarshal([]byte(got.Raw), &state) != nil || len(state.Runs) != 1 || state.Runs[0].ID != here.ID {
				t.Fatalf("this computer's runs in the snapshot: %s", got)
			}
		} else if got := pr.call(t, "page", "GET", "/api/state", nil); json.Unmarshal([]byte(got.Raw), &state) != nil || len(state.Runs) != 0 {
			t.Fatalf("the runs in the snapshot of an app without runs: %s", got)
		}
		if tree, _ := pr.sectionOf(entry); len(tree.Runs) != 1 || tree.Runs[0].ID != there {
			t.Fatalf("with a run service %v: the runs of the section at the end: %+v", withRuns, tree.Runs)
		}
	}
}

// The hidden AIWB_TEST_DIAL_VIA override: without it the entry's own address is dialed; with it
// every dial goes to the address it names, whatever address is asked for.
func TestStartServersDialOverride(t *testing.T) {
	t.Setenv("AIWB_TEST_DIAL_VIA", "")
	if testDial() != nil {
		t.Fatal("a dial override without the setting")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		b := make([]byte, 5)
		n, _ := io.ReadFull(c, b)
		got <- string(b[:n])
	}()
	t.Setenv("AIWB_TEST_DIAL_VIA", " "+ln.Addr().String()+" ")
	dial := testDial()
	if dial == nil {
		t.Fatal("no dial override with the setting")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := dial(ctx, "tcp", "192.0.2.1:9") // an address of no machine: it is not dialed
	if err != nil {
		t.Fatalf("the dial through the override: %v", err)
	}
	defer c.Close()
	if _, err := c.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	select {
	case s := <-got:
		if s != "hello" {
			t.Fatalf("the override's address got %q", s)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the override's address got no connection")
	}
}

// A list file that cannot be read does not stop the start: it is set aside, and the list is this
// computer with the notice.
func TestStartServersWithUnreadableList(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, servers.FileName), []byte("garbage\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := wired(t, root).a
	if a.Servers == nil {
		t.Fatal("no manager")
	}
	if got := a.Servers.Views(); len(got) != 1 || got[0].ID != servers.LocalID {
		t.Fatalf("list: %+v", got)
	}
	if n := a.Servers.Notice(); !strings.Contains(n, "cannot be read") || !strings.Contains(n, "set aside") {
		t.Fatalf("notice: %q", n)
	}
}

// A server started with a list file that cannot be read starts all the same: the list is the
// local entry, the answer and the log say what happened, and the file is set aside with its bytes.
func TestServeWithUnreadableServerList(t *testing.T) {
	serverTest(t, "TestStartServersWithUnreadableList (this package)", "TestListUnreadableSetAside, TestManagerUnreadableList (internal/servers)")
	in := newInstance(t)
	const garbage = "{\"version\":1,\"servers\":[{\"secret\":\"kept-for-the-owner\"\n"
	path := filepath.Join(in.dir, servers.FileName)
	if err := os.WriteFile(path, []byte(garbage), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := in.run(t, "launch"); got != in.url+"\n" {
		t.Fatalf("launch printed %q", got)
	}
	in.hello(t)

	l := in.serverList(t)
	if len(l.Servers) != 1 || l.Servers[0].ID != servers.LocalID || !l.Servers[0].Local || l.Servers[0].State != servers.StateConnected {
		t.Fatalf("list: %+v", l.Servers)
	}
	files := listFiles(t, in.dir)
	if len(files) != 1 || !strings.HasPrefix(files[0], servers.FileName+".unreadable-") {
		t.Fatalf("files: %v, want the list set aside and no new one", files)
	}
	aside := filepath.Join(in.dir, files[0])
	if b, err := os.ReadFile(aside); err != nil || string(b) != garbage {
		t.Fatalf("the file set aside: %q, %v", b, err)
	}
	if info, err := os.Stat(aside); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the file set aside: %v, %v", info, err)
	}
	for _, want := range []string{"server list: " + path + " cannot be read", "set aside as " + files[0], "starting with this computer only"} {
		if !strings.Contains(l.Notice, want) {
			t.Errorf("notice %q lacks %q", l.Notice, want)
		}
		if log := serverLog(t, in.dir); !strings.Contains(log, want) {
			t.Errorf("the log lacks %q:\n%s", want, log)
		}
	}
	if strings.Contains(l.Notice, "kept-for-the-owner") || strings.Contains(serverLog(t, in.dir), "kept-for-the-owner") {
		t.Fatal("the notice or the log repeats the file's content")
	}
}

// Without entries the start is today's: the list is this computer alone, no list file is made,
// the log says nothing of servers, and nothing is dialed.
func TestServeDialsNothingWithoutEntries(t *testing.T) {
	serverTest(t, "TestListMissingAndEmptyFile, TestManagerViews (internal/servers)", "TestSnapshotHasServers (internal/server)")
	in := newInstance(t)
	if got := in.run(t, "launch"); got != in.url+"\n" {
		t.Fatalf("launch printed %q", got)
	}
	id, _ := in.helloMap(t)["instanceId"].(string)
	if id == "" {
		t.Fatal("hello has no instance id")
	}
	l := in.serverList(t)
	if len(l.Servers) != 1 || l.Notice != "" {
		t.Fatalf("list: %+v", l)
	}
	if v := l.Servers[0]; v.ID != servers.LocalID || !v.Local || v.Name != servers.LocalName || v.State != servers.StateConnected ||
		v.InstanceID != id || v.Address != "" {
		t.Fatalf("local entry: %+v, want the instance id %s", v, id)
	}
	resp, err := httpClient().Get(in.url + "api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var snap struct {
		Servers []servers.View `json:"servers"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil || len(snap.Servers) != 1 || snap.Servers[0].ID != servers.LocalID {
		t.Fatalf("state: %+v, %v", snap.Servers, err)
	}
	if files := listFiles(t, in.dir); len(files) != 0 {
		t.Fatalf("the start made %v", files)
	}
	if log := serverLog(t, in.dir); strings.Contains(log, "server list") {
		t.Fatalf("the log speaks of the server list:\n%s", log)
	}
	// The same folder with one entry: the server that starts next connects to it, so the list is
	// what makes a start dial.
	st := standin.Start(t, standin.Options{})
	in.run(t, "stop")
	if n := st.Handshakes(); n != 0 {
		t.Fatalf("%d handshakes before an entry exists", n)
	}
	if err := os.WriteFile(filepath.Join(in.dir, servers.FileName), []byte(savedEntry(st)), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := in.run(t, "launch"); got != in.url+"\n" {
		t.Fatalf("second launch printed %q", got)
	}
	for end := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		l = in.serverList(t)
		if len(l.Servers) == 2 && l.Servers[1].State == servers.StateConnected {
			break
		}
		if time.Now().After(end) {
			t.Fatalf("the saved entry did not connect: %+v", l.Servers)
		}
	}
	for _, r := range st.Requests() {
		if r.Client != id {
			t.Fatalf("request %+v, want the client %s", r, id)
		}
	}
}
