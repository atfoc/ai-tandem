package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/app"
	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
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
	return fmt.Sprintf(`{"version":1,"servers":[{"id":"s_0123456789ab","name":"Studio","address":%q,"secret":%q,"selfSigned":true,"pin":%q}]}`,
		st.URL(), standin.DefaultSecret, st.Fingerprint())
}

// wired runs startServers on a scratch folder, as serve does, and returns what it set. The app
// has a run service, as serve's has.
func wired(t *testing.T, root string) (*app.App, *server.Server, *chats.Manager) {
	t.Helper()
	return wiredWith(t, root, true)
}

// wiredWith is wired for an app with or without a run service.
func wiredWith(t *testing.T, root string, withRuns bool) (*app.App, *server.Server, *chats.Manager) {
	t.Helper()
	p := store.NewPaths(root)
	st, err := store.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	br := editorbridge.New(func() any { return nil })
	a, srv := &app.App{St: st, Bridge: br, DataDir: root}, &server.Server{}
	if withRuns {
		a.Runs = runs.New(runs.Deps{Store: st, Emit: br, DefaultCwd: t.TempDir(), HaltWait: 300 * time.Millisecond})
	}
	cm := chats.New(chats.Deps{Store: st, Bridge: br, Boards: boards.New(st, br), DefaultCwd: t.TempDir()})
	a.Chats = cm
	if withRuns {
		a.Runs.Chats = cm
		t.Cleanup(func() { a.Runs.Shutdown(time.Second) })
	}
	t.Cleanup(startServers(p, br, cm, a, srv, testWaits{}))
	return a, srv, cm
}

// startServers gives the app and the routes one manager, and the saved entries connect with this
// installation's instance id as their client id.
func TestStartServersConnectsSavedEntries(t *testing.T) {
	t.Parallel()
	st := standin.Start(t, standin.Options{})
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, servers.FileName), []byte(savedEntry(st)), 0o600); err != nil {
		t.Fatal(err)
	}
	a, srv, cm := wired(t, root)
	if a.Servers == nil || a.Servers != srv.Servers {
		t.Fatalf("the app has %p, the routes have %p", a.Servers, srv.Servers)
	}
	if a.Remotes == nil || a.Remotes != srv.Remotes || cm.Servers != chats.RemoteServers(a.Remotes) || a.Servers.Counts == nil ||
		a.Runs.Remote != runs.Remote(a.Remotes) {
		t.Fatalf("the relay: the app has %p, the routes have %p, the chat manager has %v, the run service has %p, counts set: %v",
			a.Remotes, srv.Remotes, cm.Servers, a.Runs.Remote, a.Servers.Counts != nil)
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
		v, _ = a.Servers.View("s_0123456789ab")
	}
	if local := a.Servers.Views()[0]; local.ID != servers.LocalID || local.InstanceID != id {
		t.Fatalf("local entry: %+v, want the instance id %s", local, id)
	}
	// The relay's hooks were set before the entry connected: its snapshot went through them.
	for end := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if _, ok := a.Remotes.Lists()["s_0123456789ab"]; ok {
			break
		}
		if time.Now().After(end) {
			t.Fatal("the relay never had the entry's lists: its hooks were not set at the first connect")
		}
	}
	if chats, runs := a.Servers.Counts("s_0123456789ab"); chats != 0 || runs != 0 {
		t.Fatalf("the counts of an entry without chats: %d, %d", chats, runs)
	}
	reqs := st.Requests()
	if len(reqs) == 0 {
		t.Fatal("the stand-in got no request")
	}
	for _, r := range reqs {
		if r.Client != id || r.Secret != standin.DefaultSecret {
			t.Fatalf("request %+v, want the client %s", r, id)
		}
	}
}

// Contract 3.9: startServers gives the relay the run service and the run service the relay, both
// before the list starts. A draft run of this server on an entry is then the relay's to start (a
// relay without a run service answers "no such run" for it); and an app without a run service
// gets a relay that keeps no runs.
func TestStartServersWiresRuns(t *testing.T) {
	t.Parallel()
	const entry = "s_0123456789ab"
	st := standin.Start(t, standin.Options{})
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, servers.FileName), []byte(savedEntry(st)), 0o600); err != nil {
		t.Fatal(err)
	}
	a, _, _ := wired(t, root)
	if a.Runs == nil || a.Remotes == nil || a.Runs.Remote != runs.Remote(a.Remotes) {
		t.Fatalf("the run service asks %p about the other servers, want the relay %p", a.Runs.Remote, a.Remotes)
	}
	for end := time.Now().Add(10 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if _, ok := a.Remotes.Lists()[entry]; ok {
			break
		}
		if time.Now().After(end) {
			t.Fatal("the relay never had the entry's lists")
		}
	}
	v, err := a.Runs.Create(model.Ungrouped, "On the entry")
	if err != nil {
		t.Fatal(err)
	}
	on := entry
	if v, err = a.Runs.Patch(v.ID, runs.PatchReq{Server: &on}); err != nil || v.Server != entry {
		t.Fatalf("the draft run on the entry: %+v, %v", v, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// The relay knows the draft: it refuses the blank goal, before any call.
	if r := a.Remotes.StartRun(ctx, v.ID, " "); r.Status != http.StatusBadRequest || !strings.Contains(string(r.Body), runs.ErrNoGoal.Error()) {
		t.Fatalf("the relay's start of the draft run: %d %s, want 400 for the blank goal", r.Status, r.Body)
	}
	if got := a.Remotes.RunViews(); len(got) != 0 {
		t.Fatalf("the relay's runs: %+v", got)
	}

	// No run service: the relay is there for the chats, and has no runs.
	root = t.TempDir()
	if err := os.WriteFile(filepath.Join(root, servers.FileName), []byte(savedEntry(st)), 0o600); err != nil {
		t.Fatal(err)
	}
	b, _, cm := wiredWith(t, root, false)
	if b.Runs != nil || b.Remotes == nil || cm.Servers != chats.RemoteServers(b.Remotes) {
		t.Fatalf("without a run service: runs %p, relay %p", b.Runs, b.Remotes)
	}
	if r := b.Remotes.StartRun(ctx, v.ID, "a goal"); r.Status != http.StatusNotFound {
		t.Fatalf("the start of a run by a relay without a run service: %d %s, want 404", r.Status, r.Body)
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
	a, _, _ := wired(t, root)
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
