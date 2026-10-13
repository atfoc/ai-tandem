package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/server"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/linksim"
)

// The tests of this file run two scratch servers as processes, each with a temp data folder, free
// ports and the stand-in agent as its Claude program:
//
//	A  the local server. A stand-in page (pairPage) is connected on its loopback listener, and
//	   every connection it makes to another server is dialed to a link simulator in this process
//	   (the hidden AIWB_TEST_DIAL_VIA), whose target is B's remote port.
//	B  the remote server, with remote access set up on 127.0.0.1. It is an entry of A's server
//	   list, added through A's POST /api/servers with its pin and its secret. An API client of
//	   its own (pairDirect, another client id) reads it directly: what it reads is "B's own".
//
// B shows on A as a section: what is on B is made, read, changed and deleted through A's routes
// under /api/on/<entry> (remotePair.on), with B's own ids, and B's tree is the entry's part of
// "sections" in A's snapshot (remotePair.section). A keeps nothing of it.
//
// Neither is the person's server: no request goes to a port this file did not pick.

const (
	pairPage   = "remote-chat-page" // the stand-in page on A
	pairDirect = apiY               // the direct API client of B
	pairName   = "Studio"           // the name of B's entry in A's list
)

// remotePair is the two servers, the link between them and the stand-in page on A.
type remotePair struct {
	a     *runServer
	b     *apiRunServer
	link  *linksim.Link
	entry string   // the id of B's entry in A's list; "" until addEntry
	page  *watcher // the events of the stand-in page on A
	work  string   // a folder for the chats' agents (both servers are on this machine)
}

// pairEnv is what every server of a pair gets beside its instance's environment (a Cursor config
// folder, and for B the bind of its remote listener on 127.0.0.1): an MCP port of its own, picked
// by the system, so that two servers of one test do not ask for the same one.
func pairEnv(more ...string) []string { return append([]string{"AIWB_MCP_PORT=0"}, more...) }

// startRemotePair starts B, the link with profile p, and A with the page; B is not yet in A's
// list (addEntry). bClaude, when not "", is B's Claude program in place of the plain stand-in.
// Everything is stopped by t.Cleanup.
func startRemotePair(t *testing.T, p linksim.Profile, bClaude string) *remotePair {
	t.Helper()
	return startRemotePairIn(t, p, bClaude, nil)
}

// startRemotePairIn is startRemotePair with more in the environment of both servers: the git
// environment of a scratch repository (agenttest.Repo.Env()), for the pairs that run runs, and
// the waits a test lowers (clock.env).
func startRemotePairIn(t *testing.T, p linksim.Profile, bClaude string, env []string) *remotePair {
	t.Helper()
	rp := newPair(t, p, bClaude, env)
	rp.b.up(t)
	rp.a.start(t)
	rp.page = watch(t, http.DefaultClient, strings.TrimSuffix(rp.a.in.url, "/"), pairPage, nil)
	return rp
}

// newPair is the two servers of startRemotePairIn and the link between them, with neither
// started: B has its data folder, with remote access set up in it, and A has none yet. A test
// that needs a data folder of before on either side writes it and then starts the two itself
// (rp.b.up, rp.a.start and the page's watch).
func newPair(t *testing.T, p linksim.Profile, bClaude string, env []string) *remotePair {
	t.Helper()
	rp := &remotePair{}
	rp.b = &apiRunServer{runServer: newRunServer(t, pairEnv(env...)), port: freePort(t)}
	rp.b.in.setenv(loopbackBind)
	if bClaude != "" {
		rp.b.in.claude = bClaude
	}
	if err := os.MkdirAll(rp.b.in.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	setUpRemote(t, rp.b.in.dir, rp.b.port)
	rp.b.secret, rp.b.fpr = secretOf(t, rp.b.in.dir), fingerprintOf(t, rp.b.in.dir)
	tr := pinned(rp.b.fpr)
	t.Cleanup(tr.CloseIdleConnections)
	rp.b.hc = &http.Client{Transport: tr, Timeout: 60 * time.Second}

	rp.link = linksim.Start(t, fmt.Sprintf("127.0.0.1:%d", rp.b.port), p)
	rp.a = newRunServer(t, pairEnv(append([]string{"AIWB_TEST_DIAL_VIA=" + rp.link.Addr()}, env...)...))
	work, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rp.work = work
	return rp
}

// connectedPair is startRemotePair with B added to A's list and connected. env is more in the
// environment of both servers: the waits a test lowers (clock.env).
func connectedPair(t *testing.T, p linksim.Profile, env ...string) *remotePair {
	t.Helper()
	rp := startRemotePairIn(t, p, "", env)
	rp.addEntry(t)
	return rp
}

// addEntry adds B to A's list through A's route, with its pin and its secret, and waits until
// the entry is connected and A has B's lists.
func (rp *remotePair) addEntry(t *testing.T) {
	t.Helper()
	var saved struct {
		Saved  bool
		Server *servers.View
		Result json.RawMessage
	}
	rp.a.must(t, pairPage, "POST", "/api/servers", map[string]any{"name": pairName,
		"address": fmt.Sprintf("https://127.0.0.1:%d", rp.b.port), "secret": rp.b.secret, "selfSigned": true, "pin": rp.b.fpr}, &saved)
	if !saved.Saved || saved.Server == nil {
		t.Fatalf("the entry was not saved: %s", saved.Result)
	}
	rp.entry = saved.Server.ID
	rp.waitState(t, servers.StateConnected, 30*time.Second)
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if l, ok := rp.state(t).Lists[rp.entry]; ok && slices.Contains(l.Agents, model.Claude) && l.Catalogs[model.Claude] != nil {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("A never had %s's agents and catalog", pairName)
		}
	}
}

// pairState is what the tests read of A's snapshot. Chats are A's own, the chats of this
// computer; what is on B is in Sections, under the entry's id, while A holds B's tree.
type pairState struct {
	Chats   []model.ChatView
	Servers []servers.View
	Lists   map[string]struct {
		Agents   []model.AgentKind
		Catalogs map[model.AgentKind]*model.Catalog
	}
	Sections map[string]*remotes.Tree
}

// state is A's snapshot, as its page reads it.
func (rp *remotePair) state(t *testing.T) pairState {
	t.Helper()
	var s pairState
	rp.a.must(t, pairPage, "GET", "/api/state", nil, &s)
	return s
}

// entryView is B's entry as A's list has it.
func (rp *remotePair) entryView(t *testing.T) servers.View {
	t.Helper()
	var l serversReply
	rp.a.must(t, pairPage, "GET", "/api/servers", nil, &l)
	for _, v := range l.Servers {
		if v.ID == rp.entry {
			return v
		}
	}
	t.Fatalf("A's list has no entry %s: %+v", rp.entry, l.Servers)
	return servers.View{}
}

// waitState waits until B's entry is in the state want, for limit at most, and returns how long
// that took from the call.
func (rp *remotePair) waitState(t *testing.T, want servers.State, limit time.Duration) time.Duration {
	t.Helper()
	start := time.Now()
	for {
		v := rp.entryView(t)
		if v.State == want {
			return time.Since(start)
		}
		if time.Since(start) > limit {
			t.Fatalf("%s is %q (%s) after %s, want %q", pairName, v.State, v.Detail, limit, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// back waits for the entry's return after an outage. A's connection waits between two tries;
// a call of a page that finds the entry not connected makes it try at once, so the wait asks for
// B's folders through A as a page with the folder picker open would.
func (rp *remotePair) back(t *testing.T, limit time.Duration) time.Duration {
	t.Helper()
	start := time.Now()
	for {
		if rp.entryView(t).State == servers.StateConnected {
			return time.Since(start)
		}
		if time.Since(start) > limit {
			v := rp.entryView(t)
			t.Fatalf("%s is %q (%s) %s after its return, want connected", pairName, v.State, v.Detail, limit)
		}
		rp.a.call(t, pairPage, "GET", "/api/dirs?server="+rp.entry+"&path="+rp.work, nil, nil)
		time.Sleep(50 * time.Millisecond)
	}
}

// on is the path, on A, of a call for a thing of B: the path of the same call for a thing of
// this computer (path, which begins with "/" after "/api"), under the entry's section.
func (rp *remotePair) on(path string) string { return "/api/on/" + rp.entry + path }

// inSection is the text every event of a thing of B holds on A's page: the entry's id as the
// event's "server".
func (rp *remotePair) inSection() string { return `"server":"` + rp.entry + `"` }

// section is B's tree as A's snapshot has it under the entry's id; ok is false while A holds no
// tree of the entry (it is not connected, or was removed).
func (rp *remotePair) section(t *testing.T) (tree remotes.Tree, ok bool) {
	t.Helper()
	if tr := rp.state(t).Sections[rp.entry]; tr != nil {
		return *tr, true
	}
	return remotes.Tree{}, false
}

// tree is section for an entry that must have a tree.
func (rp *remotePair) tree(t *testing.T) remotes.Tree {
	t.Helper()
	tree, ok := rp.section(t)
	if !ok {
		t.Fatalf("A's snapshot has no tree of %s (the entry is %q)", pairName, rp.entryView(t).State)
	}
	return tree
}

// noTree checks what a page has of an entry that is not connected: no tree, so no row, and a
// read and a write for a thing of it are refused at once with the entry's name.
func (rp *remotePair) noTree(t *testing.T, when string) {
	t.Helper()
	if tree, ok := rp.section(t); ok {
		t.Fatalf("%s: A's snapshot has a tree of %s: %+v", when, pairName, tree)
	}
	for _, c := range []struct {
		method, path string
		body         any
	}{{"GET", "/chats/00000000-0000-4000-8000-000000000000", nil}, {"POST", "/chats", map[string]any{"group": model.Ungrouped}}} {
		if a := rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", c.method, rp.on(c.path), c.body); !strings.Contains(a.Error, pairName) {
			t.Fatalf("%s: %s %s: %s, want the name %s in the sentence", when, c.method, c.path, a, pairName)
		}
	}
}

// ownTree is B's tree as B's own page has it: what the owner of the remote server sees.
func (rp *remotePair) ownTree(t *testing.T) level5Tree {
	t.Helper()
	_, tree := rp.b.in.tree(t)
	return tree
}

// group makes a group in the section, at its top level: it is made on B through A, and its id is
// B's.
func (rp *remotePair) group(t *testing.T, name string) string {
	t.Helper()
	var g struct{ ID string }
	rp.a.must(t, pairPage, "POST", rp.on("/groups"), map[string]any{"name": name, "parent": ""}, &g)
	if g.ID == "" {
		t.Fatalf("the group %q has no id", name)
	}
	return g.ID
}

// answer is what a route answered: the status, and of the body what the tests read.
type answer struct {
	Status int
	Raw    string
	Code   string          `json:"code"`
	Error  string          `json:"error"`
	Branch string          `json:"branch"`
	Chat   *model.ChatView `json:"chat"`
}

func (a answer) String() string { return fmt.Sprintf("%d %s", a.Status, a.Raw) }

// do makes a call of the page on A.
func (rp *remotePair) do(t *testing.T, method, path string, body any) answer {
	t.Helper()
	status, raw := rp.a.call(t, pairPage, method, path, body, nil)
	a := answer{Status: status, Raw: raw}
	json.Unmarshal([]byte(raw), &a)
	a.Status, a.Raw = status, raw
	return a
}

// ok is do for a call that must answer 200.
func (rp *remotePair) ok(t *testing.T, method, path string, body any) answer {
	t.Helper()
	a := rp.do(t, method, path, body)
	if a.Status != http.StatusOK {
		t.Fatalf("%s %s through A: %s", method, path, a)
	}
	return a
}

// refused is do for a call that must be refused with this status and code.
func (rp *remotePair) refused(t *testing.T, status int, code, method, path string, body any) answer {
	t.Helper()
	a := rp.do(t, method, path, body)
	if a.Status != status || a.Code != code {
		t.Fatalf("%s %s through A: %s, want %d %s", method, path, a, status, code)
	}
	return a
}

// atB makes a call of the direct API client on B.
func (rp *remotePair) atB(t *testing.T, method, path string, body any) answer {
	t.Helper()
	status, raw := rp.b.api(t, pairDirect, method, path, body, nil)
	a := answer{Status: status, Raw: raw}
	json.Unmarshal([]byte(raw), &a)
	a.Status, a.Raw = status, raw
	return a
}

// newChat makes a chat from A's page in the group of the section, with the stand-in as its
// agent: the chat is made on B at once, unstarted, with B's id. It then gets the pair's work
// folder, a change A passes on to B.
func (rp *remotePair) newChat(t *testing.T, group string) string {
	t.Helper()
	var v model.ChatView
	rp.a.must(t, pairPage, "POST", rp.on("/chats"), map[string]any{"agent": "claude", "group": group}, &v)
	if v.ID == "" || v.Locked || v.Group != group {
		t.Fatalf("the new chat: %+v", v)
	}
	if a := rp.ok(t, "PATCH", rp.on("/chats/"+v.ID), map[string]any{"cwd": rp.work}); a.Chat == nil || a.Chat.Cwd != rp.work {
		t.Fatalf("the folder of the new chat: %s", a)
	}
	return v.ID
}

// startChat is newChat and its first message, an ordinary message, which must start the chat on
// B. A learns that the chat has started from B's event, after the answer to the message: the
// chat is waited for until the section's tree has it as started.
func (rp *remotePair) startChat(t *testing.T, group, text string) string {
	t.Helper()
	id := rp.newChat(t, group)
	rp.send(t, id, text)
	eventually(t, 20*time.Second, "the section has the chat as started", func() bool {
		v, ok := rp.listed(t, id)
		return ok && v.Locked
	})
	return id
}

// send sends a message of the page to the chat through A; it must be accepted.
func (rp *remotePair) send(t *testing.T, chat, text string) {
	t.Helper()
	if a := rp.ok(t, "POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": text}); a.Branch != "main" {
		t.Fatalf("the send to %s: %s", chat, a)
	}
}

// view is the chat's view as A answers it for the section.
func (rp *remotePair) view(t *testing.T, chat string) model.ChatView {
	t.Helper()
	var v model.ChatView
	rp.a.must(t, pairPage, "GET", rp.on("/chats/"+chat), nil, &v)
	return v
}

// listed is the chat's view in the section's tree of A's snapshot; ok is false when the tree has
// no such chat, and when A holds no tree of the entry.
func (rp *remotePair) listed(t *testing.T, chat string) (model.ChatView, bool) {
	t.Helper()
	tree, _ := rp.section(t)
	for _, v := range tree.Chats {
		if v.ID == chat {
			return v, true
		}
	}
	return model.ChatView{}, false
}

// thread is a chat's items as one side answers them: each item as the bytes that came.
type thread []json.RawMessage

func threadOf(raw string) (thread, error) {
	var got struct{ Items thread }
	err := json.Unmarshal([]byte(raw), &got)
	return got.Items, err
}

// kinds is the items' kinds, in order.
func (th thread) kinds() []string {
	out := make([]string, len(th))
	for i, raw := range th {
		var it struct{ Kind string }
		json.Unmarshal(raw, &it)
		out[i] = it.Kind
	}
	return out
}

// items decodes the thread.
func (th thread) items(t *testing.T) []model.Item {
	t.Helper()
	out := make([]model.Item, len(th))
	for i, raw := range th {
		if err := json.Unmarshal(raw, &out[i]); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

// users counts the user messages that hold text.
func (th thread) users(t *testing.T, text string) (n int) {
	t.Helper()
	for _, it := range th.items(t) {
		if it.Kind == "user" && strings.Contains(it.Text, text) {
			n++
		}
	}
	return n
}

// ends counts the turns that ended.
func (th thread) ends() (n int) {
	for _, k := range th.kinds() {
		if k == "end" {
			n++
		}
	}
	return n
}

// has reports whether an item's text holds text.
func (th thread) has(t *testing.T, text string) bool {
	t.Helper()
	return slices.ContainsFunc(th.items(t), func(it model.Item) bool { return strings.Contains(it.Text, text) })
}

// through reads the chat's items through A as the page, which follows the chat from then on.
func (rp *remotePair) through(t *testing.T, chat string) thread {
	t.Helper()
	a := rp.ok(t, "GET", rp.on("/chats/"+chat+"/items"), nil)
	th, err := threadOf(a.Raw)
	if err != nil {
		t.Fatalf("the items of %s through A: %v in %s", chat, err, a.Raw)
	}
	return th
}

// own reads the chat's items at B as the direct client, which follows the chat from then on.
func (rp *remotePair) own(t *testing.T, chat string) thread {
	t.Helper()
	a := rp.atB(t, "GET", "/api/chats/"+chat+"/items", nil)
	if a.Status != http.StatusOK {
		t.Fatalf("the items of %s at B: %s", chat, a)
	}
	th, err := threadOf(a.Raw)
	if err != nil {
		t.Fatalf("the items of %s at B: %v in %s", chat, err, a.Raw)
	}
	return th
}

// awaitOwn reads the chat at B every 50 ms, for up to 30 s, until ok says its items are what the
// test waits for.
func (rp *remotePair) awaitOwn(t *testing.T, chat, what string, ok func(thread) bool) thread {
	t.Helper()
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		th := rp.own(t, chat)
		if ok(th) {
			return th
		}
		if time.Now().After(deadline) {
			t.Fatalf("B's items of %s never showed %s: %v", chat, what, th.kinds())
		}
	}
}

// turns waits until n turns of the chat have ended at B.
func (rp *remotePair) turns(t *testing.T, chat string, n int) thread {
	t.Helper()
	return rp.awaitOwn(t, chat, fmt.Sprintf("%d ended turns", n), func(th thread) bool { return th.ends() >= n })
}

// same reads the chat through A and at B and compares the two item by item: the same number of
// items, each the same JSON value. It returns the thread.
func (rp *remotePair) same(t *testing.T, chat, when string) thread {
	t.Helper()
	// B's are read before and after A's: a turn that still writes would differ between the two
	// reads of B itself, and that is no difference between the servers.
	var a, b thread
	for deadline := time.Now().Add(30 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		b = rp.own(t, chat)
		a = rp.through(t, chat)
		if sameThread(b, rp.own(t, chat)) == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s: B's items of %s do not come to rest", when, chat)
		}
	}
	if diff := sameThread(a, b); diff != "" {
		t.Fatalf("%s: the items of %s through A are not B's own: %s\nthrough A: %s\nat B:      %s", when, chat, diff, joinThread(a), joinThread(b))
	}
	return a
}

// sameThread is "" when a and b are the same items, else the first difference.
func sameThread(a, b thread) string {
	if len(a) != len(b) {
		return fmt.Sprintf("%d items against %d", len(a), len(b))
	}
	for i := range a {
		var x, y any
		json.Unmarshal(a[i], &x)
		json.Unmarshal(b[i], &y)
		xs, _ := json.Marshal(x)
		ys, _ := json.Marshal(y)
		if string(xs) != string(ys) {
			return fmt.Sprintf("item %d: %s against %s", i, xs, ys)
		}
	}
	return ""
}

func joinThread(th thread) string {
	parts := make([]string, len(th))
	for i, raw := range th {
		parts[i] = clipText(string(raw), 200)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// seenEvent is one event of a stream with the time it arrived here.
type seenEvent struct {
	At   time.Time
	Type string
	Raw  string
}

// holds reports whether the event is of this type and holds every one of the texts.
func (e seenEvent) holds(typ string, texts ...string) bool {
	if e.Type != typ {
		return false
	}
	for _, s := range texts {
		if !strings.Contains(e.Raw, s) {
			return false
		}
	}
	return true
}

// watcher is an open event stream and every event it was sent so far, hello and snapshot too.
type watcher struct {
	id    string
	stop  context.CancelFunc
	ended chan struct{} // closed when the stream ended, by either side

	mu   sync.Mutex
	evs  []seenEvent
	more chan struct{} // closed and replaced whenever an event arrives
}

// watch opens GET <base>/api/events as the client id and keeps reading until the test ends, the
// server ends the stream or close is called. It returns when the stream's hello has come.
func watch(t *testing.T, hc *http.Client, base, id string, header map[string]string) *watcher {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", base+"/api/events?client="+id, nil)
	req.Header.Set(server.ClientHeader, id)
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := (&http.Client{Transport: hc.Transport}).Do(req) // no time limit: the stream stays open
	if err != nil {
		cancel()
		t.Fatalf("the stream of %s: %v", id, err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		t.Fatalf("the stream of %s: status %d", id, resp.StatusCode)
	}
	w := &watcher{id: id, stop: cancel, ended: make(chan struct{}), more: make(chan struct{})}
	go func() {
		defer close(w.ended)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(nil, 64<<20)
		for sc.Scan() {
			line, ok := strings.CutPrefix(sc.Text(), "data: ")
			if !ok {
				continue
			}
			var head struct{ Type string }
			if json.Unmarshal([]byte(line), &head) != nil {
				continue
			}
			w.mu.Lock()
			w.evs = append(w.evs, seenEvent{At: time.Now(), Type: head.Type, Raw: line})
			close(w.more)
			w.more = make(chan struct{})
			w.mu.Unlock()
		}
	}()
	t.Cleanup(w.close)
	w.await(t, 0, 10*time.Second, "its hello", func(e seenEvent) bool { return e.Type == "hello" })
	return w
}

// close ends the stream, as a closed window does, and waits until it is closed here.
func (w *watcher) close() {
	w.stop()
	<-w.ended
}

// mark is the number of events so far: what since and await take as "from here on".
func (w *watcher) mark() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.evs)
}

// since is the events that arrived after the mark.
func (w *watcher) since(mark int) []seenEvent {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.evs[mark:])
}

// of is the events after the mark of this type that hold the texts.
func (w *watcher) of(mark int, typ string, texts ...string) []seenEvent {
	return slices.DeleteFunc(w.since(mark), func(e seenEvent) bool { return !e.holds(typ, texts...) })
}

// types is the types of the events after the mark, in order.
func (w *watcher) types(mark int) []string {
	var out []string
	for _, e := range w.since(mark) {
		out = append(out, e.Type)
	}
	return out
}

// await waits for limit at most until an event after the mark is one ok accepts, and returns it.
func (w *watcher) await(t *testing.T, mark int, limit time.Duration, what string, ok func(seenEvent) bool) seenEvent {
	t.Helper()
	timeout := time.After(limit)
	for {
		w.mu.Lock()
		evs, more := w.evs[mark:], w.more
		for _, e := range evs {
			if ok(e) {
				w.mu.Unlock()
				return e
			}
		}
		w.mu.Unlock()
		select {
		case <-more:
		case <-timeout:
			t.Fatalf("%s was sent no %s within %s; it was sent %v", w.id, what, limit, w.types(mark))
		}
	}
}

// awaitEvent waits for an event of this type that holds the texts.
func (w *watcher) awaitEvent(t *testing.T, mark int, limit time.Duration, typ string, texts ...string) seenEvent {
	t.Helper()
	return w.await(t, mark, limit, fmt.Sprintf("%s event with %q", typ, texts), func(e seenEvent) bool { return e.holds(typ, texts...) })
}

// chatOf is the view in a chat event.
func chatOf(e seenEvent) model.ChatView {
	var ev struct{ Chat model.ChatView }
	json.Unmarshal([]byte(e.Raw), &ev)
	return ev.Chat
}

// awaitChat waits until the page was sent a chat event of this chat whose view ok accepts.
func (w *watcher) awaitChat(t *testing.T, mark int, limit time.Duration, chat, what string, ok func(model.ChatView) bool) model.ChatView {
	t.Helper()
	return chatOf(w.await(t, mark, limit, "chat event of "+chat+" with "+what, func(e seenEvent) bool {
		if e.Type != "chat" {
			return false
		}
		v := chatOf(e)
		return v.ID == chat && ok(v)
	}))
}

// awaitChat waits until A's page was sent a chat event of this chat of the section, with the
// entry as its "server", whose view ok accepts.
func (rp *remotePair) awaitChat(t *testing.T, mark int, limit time.Duration, chat, what string, ok func(model.ChatView) bool) model.ChatView {
	t.Helper()
	return chatOf(rp.page.await(t, mark, limit, "chat event of "+chat+" in the section with "+what, func(e seenEvent) bool {
		if !e.holds("chat", rp.inSection()) {
			return false
		}
		v := chatOf(e)
		return v.ID == chat && ok(v)
	}))
}

// asOwn is an event A's page was sent for a thing of the section as B sent it: the same JSON
// value without the "server" A adds. What B sent a client of its own is brought to the same
// form, so that the two compare.
func asOwn(raw string) string {
	var ev map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &ev) != nil {
		return raw
	}
	delete(ev, "server")
	out, _ := json.Marshal(ev)
	return string(out)
}

// clientHeaders are the headers of an API client of B beside its id: the secret and the level.
func (rp *remotePair) clientHeaders() map[string]string {
	return map[string]string{remote.SecretHeader: rp.b.secret, servers.LevelHeader: testLevel}
}

// direct opens the event stream of the direct API client on B.
func (rp *remotePair) direct(t *testing.T) *watcher {
	t.Helper()
	return watch(t, rp.b.hc, fmt.Sprintf("https://127.0.0.1:%d", rp.b.port), pairDirect, rp.clientHeaders())
}

// ownPage opens the event stream of B's own page, on B's loopback listener: the owner's page is
// open from then on.
func (rp *remotePair) ownPage(t *testing.T) *watcher {
	t.Helper()
	return watch(t, http.DefaultClient, strings.TrimSuffix(rp.b.in.url, "/"), pairOwnPage, nil)
}

// ownState is what the tests read of B's snapshot for the direct API client.
type ownState struct {
	DefaultCwd string
	Catalogs   map[model.AgentKind]*model.Catalog
}

// ownState is B's snapshot, as the direct client reads it.
func (rp *remotePair) ownState(t *testing.T) ownState {
	t.Helper()
	var s ownState
	a := rp.atB(t, "GET", "/api/state", nil)
	if a.Status != http.StatusOK {
		t.Fatalf("B's snapshot: %s", a)
	}
	if err := json.Unmarshal([]byte(a.Raw), &s); err != nil {
		t.Fatalf("B's snapshot: %v in %s", err, a.Raw)
	}
	return s
}

// noSecret is AC6 between the two servers: B's secret is in no event the watchers were sent, in
// no answer of A's routes that tell of B (the snapshot, the list of servers, the view and the
// items of every started chat of the section) and in nothing A wrote to its output.
func (rp *remotePair) noSecret(t *testing.T, w ...*watcher) {
	t.Helper()
	rp.noText(t, "B's secret", rp.b.secret, w...)
}

// noText is noSecret for any text: what must not be found is named by what.
func (rp *remotePair) noText(t *testing.T, what, text string, w ...*watcher) {
	t.Helper()
	if text == "" {
		t.Fatalf("%s is empty: nothing to search for", what)
	}
	for _, w := range w {
		for i, e := range w.since(0) {
			if strings.Contains(e.Raw, text) {
				t.Fatalf("%s is in event %d of %s: %s", what, i, w.id, clipText(e.Raw, 400))
			}
		}
	}
	paths := []string{"/api/state", "/api/servers"}
	if tree, ok := rp.section(t); ok {
		for _, v := range tree.Chats {
			if v.Locked {
				paths = append(paths, rp.on("/chats/"+v.ID), rp.on("/chats/"+v.ID+"/items"))
			}
		}
	}
	for _, path := range paths {
		// Whatever the status: a refusal is an answer too.
		if _, raw := rp.a.call(t, pairPage, "GET", path, nil, nil); strings.Contains(raw, text) {
			t.Fatalf("%s is in the answer of GET %s through A: %s", what, path, clipText(raw, 400))
		}
	}
	if out := rp.a.out.String(); strings.Contains(out, text) {
		t.Fatalf("%s is in what A wrote to its output", what)
	}
	if log, err := os.ReadFile(filepath.Join(rp.a.home, "server.log")); err == nil && strings.Contains(string(log), text) {
		t.Fatalf("%s is in A's server.log", what)
	}
}

// The cheapest pair of real servers, which the default set runs too (smokeTest): B is an entry of
// A's list, connected through the link to B's remote listener, and a group is made and a chat
// started in B's section through A. Two servers and one turn of the stand-in agent, no run.
// The owner of B sees the chat in the group it was made in, B's only group: there is no group
// "Remote". A's own lists hold nothing of it.
func TestRemotePairStartsAChat(t *testing.T) {
	smokeTest(t)
	rp := connectedPair(t, linksim.Good)
	g := rp.group(t, "Work")
	chat := rp.startChat(t, g, "hi")
	if th := rp.turns(t, chat, 1); th.users(t, "hi") != 1 {
		t.Fatalf("the thread of the chat at B: %s", joinThread(th))
	}
	rp.same(t, chat, "after its first turn")
	own := rp.ownTree(t)
	if len(own.Groups) != 1 || own.Groups[0].ID != g || own.Groups[0].Name != "Work" || own.Groups[0].Parent != "" ||
		len(own.Chats) != 1 || own.Chats[0].ID != chat || own.Chats[0].Group != g || !own.Chats[0].Locked {
		t.Fatalf("the tree of B's own page:\n%s", strings.Join(own.lines(), "\n"))
	}
	if tree := rp.tree(t); len(tree.Groups) != 1 || tree.Groups[0].ID != g || len(tree.Chats) != 1 || tree.Chats[0].ID != chat || tree.Chats[0].Group != g {
		t.Fatalf("the section of %s on A: %+v", pairName, tree)
	}
	var here level5Tree
	rp.a.must(t, pairPage, "GET", "/api/state", nil, &here)
	if len(here.Groups)+len(here.Chats)+len(here.States)+len(here.Boards)+len(here.Runs) != 0 {
		t.Fatalf("A's own lists hold something: %+v", here)
	}
}

// AC15, AC17 and AC29 on the good link: two servers, a chat made, configured and started in B's
// section through A's routes, a permission ask raised on B, and the times of a send's
// acknowledgement and of a content event.
func TestRemoteChatLive(t *testing.T) {
	serverTest(t, "TestSectionCallPassedOn, TestSectionFollows, TestSectionContentEvents (internal/remotes)", "TestServersPackageAgainstTheListener (internal/server)")
	rp := connectedPair(t, linksim.Good)
	g := rp.group(t, "Work")

	// AC29: where the chat is made decides where it lives: made in the section, it is on B at
	// once; then agents and settings, several times, each of them on B; the first message starts
	// the agent chosen last.
	t.Run("AC29 the agent chosen last starts", func(t *testing.T) {
		// The make gives the chat B's default folder and the default model and effort of B's
		// catalog, as B itself states them: the group remembers nothing for B.
		own := rp.ownState(t)
		cat := own.Catalogs[model.Claude]
		if own.DefaultCwd == "" || cat == nil || cat.Default.Model == "" {
			t.Fatalf("B's default folder and catalog: %+v", own)
		}
		var v model.ChatView
		// The question about the place is gone: a call for this computer that names B is refused
		// and makes nothing, here or there.
		rp.refused(t, http.StatusBadRequest, "server_refused", "POST", "/api/chats", map[string]any{"agent": "claude", "group": model.Ungrouped, "server": rp.entry})
		// And B's group is no group of this computer.
		if a := rp.do(t, "POST", "/api/chats", map[string]any{"agent": "claude", "group": g}); a.Status != http.StatusBadRequest || !strings.Contains(a.Error, "no such group") {
			t.Fatalf("a chat of this computer in a group of %s: %s, want 400 for a group that is not here", pairName, a)
		}
		if st, tree := rp.state(t), rp.tree(t); len(st.Chats) != 0 || len(tree.Chats) != 0 || len(rp.ownTree(t).Chats) != 0 {
			t.Fatalf("the refused makes left a chat: %+v on A, %+v in the section", st.Chats, tree.Chats)
		}
		mark := rp.page.mark()
		rp.a.must(t, pairPage, "POST", rp.on("/chats"), map[string]any{"agent": "claude", "group": g}, &v)
		if v.Agent != model.Claude || v.Cwd != own.DefaultCwd || v.Model != cat.Default.Model || v.Effort != cat.Default.Effort || v.Locked || v.Group != g {
			t.Fatalf("the new chat: %+v, want the agent claude, the folder %s and the model %+v of %s", v, own.DefaultCwd, cat.Default, pairName)
		}
		chat := v.ID
		if made, there := rp.ownView(t, chat); !there || made.Locked || made.Cwd != own.DefaultCwd || made.Group != g {
			t.Fatalf("the chat at B before any message: %+v (there: %v)", made, there)
		}
		if got := rp.view(t, chat); got.Locked || got.Group != g {
			t.Fatalf("the chat read through A: %+v", got)
		}
		// It shows in the section by B's event, and is no chat of this computer.
		rp.awaitChat(t, mark, 10*time.Second, chat, "the group it was made in", func(v model.ChatView) bool { return v.Group == g && !v.Locked })
		rp.refused(t, http.StatusNotFound, "not_found", "GET", "/api/chats/"+chat, nil)
		configure := func(body map[string]any) model.ChatView {
			t.Helper()
			a := rp.ok(t, "PATCH", rp.on("/chats/"+chat), body)
			if a.Chat == nil {
				t.Fatalf("configure %v: %s", body, a)
			}
			return *a.Chat
		}
		// The place is final: B refuses a change that names a server, whichever it names.
		rp.refused(t, http.StatusBadRequest, "server_refused", "PATCH", rp.on("/chats/"+chat), map[string]any{"server": servers.LocalID})
		rp.refused(t, http.StatusBadRequest, "server_refused", "PATCH", rp.on("/chats/"+chat), map[string]any{"server": rp.entry})
		// An agent B cannot run is refused and changes nothing; the stand-in is chosen again.
		rp.refused(t, http.StatusConflict, "agent_missing", "PATCH", rp.on("/chats/"+chat), map[string]any{"agent": "pi"})
		rp.refused(t, http.StatusConflict, "agent_missing", "PATCH", rp.on("/chats/"+chat), map[string]any{"agent": "cursor"})
		v = configure(map[string]any{"agent": "claude", "model": "haiku"})
		v = configure(map[string]any{"agent": "claude", "model": "sonnet", "effort": "high"})
		v = configure(map[string]any{"cwd": rp.work})
		if v.Agent != model.Claude || v.Model != "sonnet" || v.Effort != "high" || v.Cwd != rp.work || v.Locked {
			t.Fatalf("the chat before its first message: %+v", v)
		}
		before := len(rp.b.agentFakes(t))
		rp.send(t, chat, "chosen last")
		th := rp.turns(t, chat, 1)
		if !th.has(t, "FAKE(sonnet): chosen last") {
			t.Fatalf("the reply is not the agent's chosen last: %s", joinThread(th))
		}
		rp.same(t, chat, "after the first message")
		if got := rp.view(t, chat); !got.Locked || got.Model != "sonnet" || got.Effort != "high" || got.Group != g {
			t.Fatalf("the started chat through A: %+v", got)
		}
		// One agent process was started for it on B, and none on A.
		if n := len(rp.b.agentFakes(t)) - before; n != 1 {
			t.Fatalf("%d agent processes were started on B for the chat, want 1", n)
		}
		if left := rp.a.agentFakes(t); len(left) != 0 {
			t.Fatalf("A started an agent for a chat on B: %v", left)
		}
		// Server and agent of a started chat are fixed.
		rp.refused(t, http.StatusBadRequest, "server_refused", "PATCH", rp.on("/chats/"+chat), map[string]any{"server": servers.LocalID})
		if a := rp.do(t, "PATCH", rp.on("/chats/"+chat), map[string]any{"agent": "pi"}); a.Status != http.StatusConflict {
			t.Fatalf("an agent change of a started chat: %s", a)
		}
	})

	// AC17: a permission ask raised on B shows in the section's tree and in the chat event of A's
	// page, then the chat is ready again after the answer through A.
	t.Run("AC17 approval and ready", func(t *testing.T) {
		mark := rp.page.mark()
		chat := rp.startChat(t, g, `first [[ask Bash {"command":"ls"}]]`)
		rp.awaitChat(t, mark, 10*time.Second, chat, "the status approval", func(v model.ChatView) bool {
			return v.Status == model.StatusApproval && v.Group == g
		})
		if v, ok := rp.listed(t, chat); !ok || v.Status != model.StatusApproval || v.Approvals != 1 {
			t.Fatalf("the chat in the section at the ask: %+v (listed: %v)", v, ok)
		}
		th := rp.through(t, chat)
		ask := th.items(t)[len(th)-1]
		if ask.Kind != "perm" || ask.ToolName != "Bash" || ask.RequestID == "" || ask.Decided != "" {
			t.Fatalf("the items at the ask through A: %s", joinThread(th))
		}
		mark = rp.page.mark()
		rp.ok(t, "POST", rp.on("/chats/"+chat+"/permission"), map[string]any{"requestId": ask.RequestID, "allow": true})
		rp.awaitChat(t, mark, 10*time.Second, chat, "the status ready", func(v model.ChatView) bool {
			return v.Status == model.StatusReady && v.Approvals == 0
		})
		if v, _ := rp.listed(t, chat); v.Status != model.StatusReady {
			t.Fatalf("the chat in the section after the answer: %+v", v)
		}
		if th := rp.same(t, chat, "after the permission answer"); !th.has(t, "ask Bash -> allow") {
			t.Fatalf("the thread after the answer: %s", joinThread(th))
		}
	})

	// AC15: on the good link a second message is acknowledged in under a second, and a content
	// event reaches A's page within a second of reaching a direct client of B.
	t.Run("AC15 times on the good link", func(t *testing.T) {
		chat := rp.startChat(t, g, "one")
		rp.turns(t, chat, 1)
		d := rp.direct(t)
		rp.same(t, chat, "before the timed message") // both follow the chat from here on
		pm, dm := rp.page.mark(), d.mark()
		sent := time.Now()
		rp.send(t, chat, "two")
		ack := time.Since(sent)
		if ack >= time.Second {
			t.Errorf("the second message was acknowledged after %v, want under 1 s", ack)
		}
		last := func(e seenEvent) bool { return e.holds("chat_items", chat, "FAKE(sonnet): two") }
		atPage := rp.page.await(t, pm, 10*time.Second, "content event with the reply", func(e seenEvent) bool { return last(e) && e.holds("chat_items", rp.inSection()) })
		atB := d.await(t, dm, 10*time.Second, "content event with the reply", last)
		lag := atPage.At.Sub(atB.At)
		if lag >= time.Second {
			t.Errorf("the reply reached A's page %v after B's own client, want under 1 s", lag)
		}
		t.Logf("AC15 on the good link (40 ms round trip): the send was acknowledged in %v; the reply's chat_items event reached A's page %v after B's direct client", ack.Round(time.Millisecond), lag.Round(time.Millisecond))
		// Every content event of the turn came to both, the same event in the same order: A's
		// page got B's, each with the entry as its "server" and nothing else added.
		rp.turns(t, chat, 2)
		time.Sleep(300 * time.Millisecond)
		content := func(w *watcher, mark int) (out []string) {
			for _, e := range w.since(mark) {
				if (e.Type == "chat_items" || e.Type == "tree") && strings.Contains(e.Raw, chat) {
					if w == rp.page && !strings.Contains(e.Raw, rp.inSection()) {
						t.Errorf("a content event of the section's chat names no server: %s", clipText(e.Raw, 300))
					}
					out = append(out, asOwn(e.Raw))
				}
			}
			return out
		}
		if p, b := content(rp.page, pm), content(d, dm); len(p) == 0 || !slices.Equal(p, b) {
			t.Errorf("the content events of the turn: A's page got %d, B's client %d, or they differ:\n%v\n%v", len(p), len(b), p, b)
		}
		rp.same(t, chat, "after the timed message")
	})
}

// pairOwnPage is the client id of B's own page: the calls a person at B's machine would make, on
// B's loopback listener.
const pairOwnPage = "remote-chat-own-page"

// ownView is the chat's view at B, as the direct client reads it; ok is false when B has no such
// chat.
func (rp *remotePair) ownView(t *testing.T, chat string) (v model.ChatView, ok bool) {
	t.Helper()
	a := rp.atB(t, "GET", "/api/chats/"+chat, nil)
	switch a.Status {
	case http.StatusOK:
		if err := json.Unmarshal([]byte(a.Raw), &v); err != nil {
			t.Fatalf("the view of %s at B: %v in %s", chat, err, a.Raw)
		}
		return v, true
	case http.StatusNotFound:
		return v, false
	}
	t.Fatalf("the view of %s at B: %s", chat, a)
	return v, false
}

// eventually polls ok every 20 ms for limit at most.
func eventually(t *testing.T, limit time.Duration, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(limit); !ok(); time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("after %s still not: %s", limit, what)
		}
	}
}

// reconnect cuts the link and brings it back: A's connection to B ends and is made again.
func (rp *remotePair) reconnect(t *testing.T) {
	t.Helper()
	mark := rp.page.mark()
	rp.link.Cut()
	rp.waitState(t, servers.StateUnreachable, 5*time.Second)
	rp.link.Uncut()
	rp.back(t, 45*time.Second)
	rp.treeBack(t, mark)
}

// treeBack waits until the page was sent B's tree again after the mark: the section event of the
// entry that carries a tree, which every page is sent when the entry's connection is up again.
func (rp *remotePair) treeBack(t *testing.T, mark int) {
	t.Helper()
	rp.page.await(t, mark, 20*time.Second, "section event with the tree of "+pairName, func(e seenEvent) bool {
		return e.holds("section", rp.entry) && !strings.Contains(e.Raw, `"tree":null`)
	})
}

// AC33: one case per action on a chat of a section. Each is made on B, through A's route of the
// section, and shows for everyone: in the section of A's page by B's event, and on B's own page.
// The archive marks that are made on B itself show in the section as B has them.
func TestRemoteChatActions(t *testing.T) {
	serverTest(t, "TestSectionCallPassedOn, TestSectionEvents (internal/remotes)", "TestSectionRoutesPassOn (internal/server)")
	rp := connectedPair(t, linksim.Good)
	g, g2 := rp.group(t, "Work"), rp.group(t, "Other")
	d := rp.direct(t)

	// The automatic name is made on B after the first message and reaches the page as a chat
	// event of the section.
	t.Run("automatic name", func(t *testing.T) {
		mark := rp.page.mark()
		chat := rp.startChat(t, g, "name me")
		v := rp.awaitChat(t, mark, 15*time.Second, chat, "the name Fake title", func(v model.ChatView) bool { return v.Name == "Fake title" })
		if v.UserNamed || v.Group != g {
			t.Fatalf("the named chat's event: %+v", v)
		}
		if own, _ := rp.ownView(t, chat); own.Name != "Fake title" {
			t.Fatalf("B's name of the chat: %+v", own)
		}
	})

	// A rename is passed on as a name given by the user.
	t.Run("rename", func(t *testing.T) {
		chat := rp.startChat(t, g, "rename me")
		rp.turns(t, chat, 1)
		// The automatic name is B's event of its own: the rename waits until A has it.
		eventually(t, 15*time.Second, "the chat's automatic name in the section", func() bool {
			v, _ := rp.listed(t, chat)
			return v.Name == "Fake title"
		})
		mark := rp.page.mark()
		// The name is read in B's chat event of the rename, and through A after it.
		if a := rp.ok(t, "PATCH", rp.on("/chats/"+chat), map[string]any{"name": "Mine"}); a.Chat == nil || a.Chat.ID != chat {
			t.Fatalf("the rename's answer: %s", a)
		}
		if own, _ := rp.ownView(t, chat); own.Name != "Mine" || !own.UserNamed {
			t.Fatalf("B's name after the rename: %+v", own)
		}
		rp.awaitChat(t, mark, 5*time.Second, chat, "the name Mine", func(v model.ChatView) bool { return v.Name == "Mine" && v.UserNamed })
		if v := rp.view(t, chat); v.Name != "Mine" || !v.UserNamed {
			t.Fatalf("the chat through A after the rename: %+v", v)
		}
		if v, ok := rp.listed(t, chat); !ok || v.Name != "Mine" || !v.UserNamed {
			t.Fatalf("the chat in the section after the rename: %+v (listed: %v)", v, ok)
		}
		// The namer does not replace it.
		rp.send(t, chat, "again")
		rp.turns(t, chat, 2)
		time.Sleep(500 * time.Millisecond)
		if v := rp.view(t, chat); v.Name != "Mine" {
			t.Fatalf("the name after another turn: %q", v.Name)
		}
	})

	// Archive and unarchive are passed on; at B the chat's agent stops and no message is
	// accepted.
	t.Run("archive and unarchive", func(t *testing.T) {
		skip := rp.b.fakeMessages(t)
		chat := rp.startChat(t, g, "archive me")
		pid, _ := rp.b.waitFakeMessage(t, skip, "archive me")
		rp.turns(t, chat, 1)
		running := func() bool {
			return slices.ContainsFunc(rp.b.fakes(t), func(p fakeProc) bool { return p.Pid == pid })
		}
		if !running() {
			t.Fatalf("the chat's agent (pid %d) does not run at B before the archive", pid)
		}
		mark := rp.page.mark()
		rp.ok(t, "POST", rp.on("/chats/"+chat+"/archive"), nil)
		rp.awaitChat(t, mark, 5*time.Second, chat, "the archived mark", func(v model.ChatView) bool { return v.Archived })
		eventually(t, 5*time.Second, "the chat archived at B", func() bool { v, _ := rp.ownView(t, chat); return v.Archived })
		eventually(t, 10*time.Second, "the chat's agent at B stopped", func() bool { return !running() })
		// The mark in the section is B's own, with the archive action B gave it: A keeps none.
		there, _ := rp.ownView(t, chat)
		if v, _ := rp.listed(t, chat); !v.Archived || v.Op == "" || v.Op != there.Op {
			t.Fatalf("the archived chat in the section: %+v, at B the action %q", v, there.Op)
		}
		// A send and a configure are B's to refuse: what B says to a client of its own is what
		// the page is told through A.
		atB := rp.atB(t, "POST", "/api/chats/"+chat+"/messages", map[string]any{"text": "to the archive"})
		if atB.Status != http.StatusConflict {
			t.Fatalf("a send to the archived chat at B: %s", atB)
		}
		if a := rp.do(t, "POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": "to the archive"}); a.Status != http.StatusConflict || !strings.Contains(a.Error, "archived") || a.Raw != atB.Raw {
			t.Fatalf("a send to the archived chat through A: %s, at B: %s", a, atB)
		}
		if a := rp.do(t, "PATCH", rp.on("/chats/"+chat), map[string]any{"model": "haiku"}); a.Status != http.StatusConflict {
			t.Fatalf("a configure of the archived chat through A: %s", a)
		}
		mark = rp.page.mark()
		rp.ok(t, "POST", rp.on("/chats/"+chat+"/unarchive"), nil)
		rp.awaitChat(t, mark, 5*time.Second, chat, "no archived mark", func(v model.ChatView) bool { return !v.Archived })
		eventually(t, 5*time.Second, "the chat unarchived at B", func() bool { v, _ := rp.ownView(t, chat); return !v.Archived })
		rp.send(t, chat, "back again")
		if th := rp.turns(t, chat, 2); !th.has(t, "FAKE(sonnet): back again") || th.users(t, "to the archive") != 0 {
			t.Fatalf("the thread after the unarchive: %s", joinThread(th))
		}
		rp.same(t, chat, "after the unarchive")
	})

	// An archive made on B's own page shows in the section, as B has it, and is in the tree A is
	// sent when it connects again; the connect of another client changes no mark.
	t.Run("archive made at B", func(t *testing.T) {
		chat := rp.startChat(t, g, "archived there")
		other := rp.startChat(t, g, "left alone")
		rp.turns(t, chat, 1)
		rp.turns(t, other, 1)
		own := rp.ownPage(t) // B's page is open
		defer own.close()
		mark := rp.page.mark()
		rp.b.must(t, pairOwnPage, "POST", "/api/chats/"+chat+"/archive", nil, nil)
		rp.awaitChat(t, mark, 5*time.Second, chat, "the archived mark", func(v model.ChatView) bool { return v.Archived })
		marks := func(when string) {
			t.Helper()
			for id, want := range map[string]bool{chat: true, other: false} {
				there, ok := rp.ownView(t, id)
				if !ok || there.Archived != want {
					t.Fatalf("%s: the chat %s at B: %+v, want archived %v", when, id, there, want)
				}
				if v, ok := rp.listed(t, id); !ok || v.Archived != want || v.Op != there.Op {
					t.Fatalf("%s: the chat %s in the section: %+v, want archived %v with B's action %q", when, id, v, want, there.Op)
				}
			}
		}
		marks("after the archive at B")
		rp.reconnect(t)
		time.Sleep(500 * time.Millisecond) // a change passed on at the connect would have arrived
		marks("after A connected again")
		// Another client connects to B, and a second time.
		for range 2 {
			w := watch(t, rp.b.hc, fmt.Sprintf("https://127.0.0.1:%d", rp.b.port), apiX, rp.clientHeaders())
			time.Sleep(200 * time.Millisecond)
			w.close()
		}
		marks("after another client connected")
		if a := rp.do(t, "POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": "no"}); a.Status != http.StatusConflict {
			t.Fatalf("a send to the chat archived at B: %s", a)
		}
		// The unarchive made at B shows too.
		mark = rp.page.mark()
		rp.b.must(t, pairOwnPage, "POST", "/api/chats/"+chat+"/unarchive", nil, nil)
		rp.awaitChat(t, mark, 5*time.Second, chat, "no archived mark", func(v model.ChatView) bool { return !v.Archived })
	})

	// A fork is made at B, in the source's group, where B's own page has it too, and "fork and
	// edit" leaves the message as the new chat's draft.
	t.Run("fork", func(t *testing.T) {
		chat := rp.startChat(t, g2, "fork one")
		rp.turns(t, chat, 1)
		rp.send(t, chat, "fork two")
		src := rp.turns(t, chat, 2)
		first := slices.Index(src.kinds(), "end") + 1 // the items of the first turn
		var fork model.ChatView
		rp.a.must(t, pairPage, "POST", rp.on("/chats/"+chat+"/fork"), map[string]any{"branch": "main", "at": first}, &fork)
		if fork.ID == "" || fork.ID == chat || fork.Group != g2 || fork.ForkedFrom != chat || !fork.Locked {
			t.Fatalf("the fork's view through A: %+v", fork)
		}
		if there, ok := rp.ownView(t, fork.ID); !ok || there.Group != g2 {
			t.Fatalf("B's chat with the fork's id: %+v (there: %v), want it in the source's group", there, ok)
		}
		eventually(t, 10*time.Second, "the fork in the section, in the source's group", func() bool {
			v, ok := rp.listed(t, fork.ID)
			return ok && v.Group == g2
		})
		if th := rp.same(t, fork.ID, "after the fork"); len(th) != first || th.users(t, "fork two") != 0 {
			t.Fatalf("the fork's items: %s", joinThread(th))
		}
		rp.send(t, fork.ID, "on the fork")
		rp.awaitOwn(t, fork.ID, "the fork's reply", func(th thread) bool { return th.has(t, "FAKE(sonnet): on the fork") && th.ends() >= 2 })
		rp.same(t, fork.ID, "after a message on the fork")
		rp.same(t, chat, "the source after the fork")
		// A fork's agent is fixed too.
		if a := rp.do(t, "PATCH", rp.on("/chats/"+fork.ID), map[string]any{"agent": "pi"}); a.Status != http.StatusConflict {
			t.Fatalf("an agent change of the fork: %s", a)
		}

		// Fork and edit: the second user message becomes the new chat's draft.
		second := slices.IndexFunc(src.items(t), func(it model.Item) bool { return it.Kind == "user" && strings.Contains(it.Text, "fork two") })
		var edit model.ChatView
		rp.a.must(t, pairPage, "POST", rp.on("/chats/"+chat+"/fork"), map[string]any{"branch": "main", "at": second, "message": second}, &edit)
		// The draft is the fork's on B, with B's counter: A keeps none of its own.
		there, _ := rp.ownView(t, edit.ID)
		if edit.Draft == nil || !strings.Contains(edit.Draft.Text, "fork two") || there.Draft == nil || there.Draft.Text != edit.Draft.Text ||
			edit.DraftRev != there.DraftRev || edit.Group != g2 {
			t.Fatalf("the fork-and-edit's view through A: %+v (draft %+v); at B the draft %+v on %d", edit, edit.Draft, there.Draft, there.DraftRev)
		}
		eventually(t, 10*time.Second, "the fork-and-edit in the section, with its draft", func() bool {
			v, _ := rp.listed(t, edit.ID)
			return v.Draft != nil && strings.Contains(v.Draft.Text, "fork two")
		})
	})

	// A branch is made with the same routes and their branch parameter.
	t.Run("branch", func(t *testing.T) {
		chat := rp.startChat(t, g, "branch one")
		rp.turns(t, chat, 1)
		rp.send(t, chat, "branch two")
		main := rp.turns(t, chat, 2)
		first := slices.Index(main.kinds(), "end") + 1
		rp.through(t, chat) // the page follows the chat
		mark := rp.page.mark()
		a := rp.ok(t, "POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": "the other way",
			"target": map[string]any{"branch": "main", "at": first, "new": true}})
		br := a.Branch
		if br == "" || br == "main" {
			t.Fatalf("the send to a point of main: %s", a)
		}
		rp.awaitChat(t, mark, 10*time.Second, chat, "two branches", func(v model.ChatView) bool { return v.Branches == 2 && v.Branch == br })
		rp.page.awaitEvent(t, mark, 10*time.Second, "branch_state", rp.inSection(), chat, `"branch":"`+br+`"`)
		rp.page.awaitEvent(t, mark, 10*time.Second, "tree", rp.inSection(), chat)
		read := func(side func(*testing.T, string, string, any) answer, what string) thread {
			t.Helper()
			var th thread
			eventually(t, 15*time.Second, "the branch's reply "+what, func() bool {
				ans := side(t, "GET", "/api/chats/"+chat+"/items?branch="+br, nil)
				if ans.Status != http.StatusOK {
					t.Fatalf("the branch's items %s: %s", what, ans)
				}
				th, _ = threadOf(ans.Raw)
				return th.has(t, "FAKE(sonnet): the other way") && th.ends() >= 2
			})
			return th
		}
		// throughA is a call for the section's chat, by the path of the same call on B.
		throughA := func(t *testing.T, method, path string, body any) answer {
			t.Helper()
			return rp.do(t, method, rp.on(strings.TrimPrefix(path, "/api")), body)
		}
		atB := read(rp.atB, "at B")
		through := read(throughA, "through A")
		if diff := sameThread(through, atB); diff != "" || through.users(t, "branch two") != 0 {
			t.Fatalf("the branch's items through A against B's: %s\n%s\n%s", diff, joinThread(through), joinThread(atB))
		}
		// The tree through A is B's, and main is as it was.
		ta, tb := rp.ok(t, "GET", rp.on("/chats/"+chat+"/tree"), nil), rp.atB(t, "GET", "/api/chats/"+chat+"/tree", nil)
		if ta.Raw != tb.Raw || !strings.Contains(ta.Raw, br) {
			t.Fatalf("the tree through A against B's:\n%s\n%s", ta.Raw, tb.Raw)
		}
		ma := rp.ok(t, "GET", rp.on("/chats/"+chat+"/items?branch=main"), nil)
		if th, _ := threadOf(ma.Raw); sameThread(th, main) != "" {
			t.Fatalf("main after the branch: %s, was %s", joinThread(th), joinThread(main))
		}
		// A send to the branch's end by its parameter.
		if a := rp.ok(t, "POST", rp.on("/chats/"+chat+"/messages?branch=main"), map[string]any{"text": "main goes on"}); a.Branch != "main" {
			t.Fatalf("the send to main by its parameter: %s", a)
		}
		rp.turns(t, chat, 3) // B's current branch is the new one; main is read below
		eventually(t, 15*time.Second, "main's third turn at B", func() bool {
			th, _ := threadOf(rp.atB(t, "GET", "/api/chats/"+chat+"/items?branch=main", nil).Raw)
			return th.ends() >= 3
		})
		ma, mb := rp.ok(t, "GET", rp.on("/chats/"+chat+"/items?branch=main"), nil), rp.atB(t, "GET", "/api/chats/"+chat+"/items?branch=main", nil)
		x, _ := threadOf(ma.Raw)
		y, _ := threadOf(mb.Raw)
		if diff := sameThread(x, y); diff != "" || !x.has(t, "FAKE(sonnet): main goes on") {
			t.Fatalf("main after its third message, through A against B's: %s", diff)
		}
	})

	// The events of a subagent that runs at B reach the page that follows the chat, and its
	// items read through A are B's.
	t.Run("subagent events", func(t *testing.T) {
		chat := rp.startChat(t, g, "one")
		rp.turns(t, chat, 1)
		rp.same(t, chat, "before the subagent") // both follow
		pm, dm := rp.page.mark(), d.mark()
		rp.send(t, chat, `with help [[mcp spawn_subagent {"prompt":"the helper's job","description":"helper"}]]`)
		sub := rp.page.awaitEvent(t, pm, 15*time.Second, "sub", rp.inSection(), chat)
		var ev struct{ Subagent model.Subagent }
		json.Unmarshal([]byte(sub.Raw), &ev)
		sid := ev.Subagent.ID
		if sid == "" || ev.Subagent.Description != "helper" {
			t.Fatalf("the sub event at A's page: %s", sub.Raw)
		}
		rp.page.awaitEvent(t, pm, 15*time.Second, "sub_items", rp.inSection(), chat, sid)
		var sa, sb answer
		eventually(t, 20*time.Second, "the subagent's reply at B", func() bool {
			sb = rp.atB(t, "GET", "/api/chats/"+chat+"/subagents/"+sid+"/items", nil)
			return sb.Status == http.StatusOK && strings.Contains(sb.Raw, "the helper's job") && strings.Contains(sb.Raw, "FAKE(")
		})
		eventually(t, 20*time.Second, "the chat at rest after the subagent's result", func() bool {
			v, _ := rp.ownView(t, chat)
			return v.Status == model.StatusReady && v.SubsRunning == 0 && v.SubsOwed == 0
		})
		sb = rp.atB(t, "GET", "/api/chats/"+chat+"/subagents/"+sid+"/items", nil)
		sa = rp.ok(t, "GET", rp.on("/chats/"+chat+"/subagents/"+sid+"/items"), nil)
		x, _ := threadOf(sa.Raw)
		y, _ := threadOf(sb.Raw)
		if diff := sameThread(x, y); diff != "" || len(x) == 0 {
			t.Fatalf("the subagent's items through A against B's: %s\n%s\n%s", diff, sa.Raw, sb.Raw)
		}
		rp.same(t, chat, "after the subagent")
		time.Sleep(300 * time.Millisecond)
		subs := func(w *watcher, mark int) (out []string) {
			for _, e := range w.since(mark) {
				if (e.Type == "sub" || e.Type == "sub_items") && strings.Contains(e.Raw, chat) {
					out = append(out, asOwn(e.Raw)) // A's page got B's, with the entry as its "server"
				}
			}
			return out
		}
		if p, b := subs(rp.page, pm), subs(d, dm); len(p) < 2 || !slices.Equal(p, b) {
			t.Fatalf("the subagent's events: A's page got %d, B's client %d, or they differ:\n%v\n%v", len(p), len(b), p, b)
		}
	})

	// A delete is passed on; the chat leaves the section by B's event. No row stays behind: a
	// call for it is B's "not found". A delete with the "local" of before, on this computer's
	// route, has no record to remove.
	t.Run("delete", func(t *testing.T) {
		chat := rp.startChat(t, g, "delete me")
		rp.turns(t, chat, 1)
		rp.refused(t, http.StatusBadRequest, "no_record", "DELETE", "/api/chats/"+chat+"?local=1", nil)
		if _, ok := rp.ownView(t, chat); !ok {
			t.Fatal("B lost the chat to a delete on this computer's route")
		}
		mark := rp.page.mark()
		rp.ok(t, "DELETE", rp.on("/chats/"+chat), nil)
		rp.page.awaitEvent(t, mark, 5*time.Second, "chat_removed", rp.inSection(), chat)
		if _, ok := rp.listed(t, chat); ok {
			t.Fatal("the deleted chat is still in the section")
		}
		if _, ok := rp.ownView(t, chat); ok {
			t.Fatal("B still has the deleted chat")
		}
		for _, c := range [][2]string{{"GET", "/chats/" + chat + "/items"}, {"GET", "/chats/" + chat}, {"DELETE", "/chats/" + chat},
			{"POST", "/chats/" + chat + "/archive"}} {
			rp.refused(t, http.StatusNotFound, "not_found", c[0], rp.on(c[1]), nil)
		}
		rp.refused(t, http.StatusNotFound, "not_found", "POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": "to nobody"})
	})

	// A chat that B's owner deletes on B's own page leaves the section at once, by B's event,
	// and a call for it through A is B's "not found": no greyed row, and no code of A's own.
	t.Run("deleted at B", func(t *testing.T) {
		chat := rp.startChat(t, g, "deleted there")
		rp.turns(t, chat, 1)
		rp.same(t, chat, "before the delete") // the page follows the chat
		own := rp.ownPage(t)
		defer own.close()
		mark := rp.page.mark()
		rp.b.must(t, pairOwnPage, "DELETE", "/api/chats/"+chat, nil, nil)
		rp.page.awaitEvent(t, mark, 5*time.Second, "chat_removed", rp.inSection(), chat)
		if v, ok := rp.listed(t, chat); ok {
			t.Fatalf("the chat deleted at B is still in the section: %+v", v)
		}
		for _, c := range [][2]string{{"GET", "/chats/" + chat + "/items"}, {"GET", "/chats/" + chat}, {"DELETE", "/chats/" + chat}} {
			rp.refused(t, http.StatusNotFound, "not_found", c[0], rp.on(c[1]), nil)
		}
		rp.refused(t, http.StatusNotFound, "not_found", "POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": "to nobody"})
	})

	// A chat is moved between the groups of its section, on B: B's own page has it there.
	t.Run("move", func(t *testing.T) {
		chat := rp.newChat(t, g)
		mark := rp.page.mark()
		if a := rp.ok(t, "PATCH", rp.on("/chats/"+chat), map[string]any{"group": g2}); a.Chat == nil || a.Chat.Group != g2 {
			t.Fatalf("the move's answer: %s", a)
		}
		rp.awaitChat(t, mark, 5*time.Second, chat, "the other group", func(v model.ChatView) bool { return v.Group == g2 })
		if v, ok := rp.ownView(t, chat); !ok || v.Group != g2 {
			t.Fatalf("the moved chat at B: %+v (there: %v)", v, ok)
		}
		// A group of this computer is no place for it: B knows no such group.
		var here struct{ ID string }
		rp.a.must(t, pairPage, "POST", "/api/groups", map[string]any{"name": "Here", "parent": ""}, &here)
		if a := rp.do(t, "PATCH", rp.on("/chats/"+chat), map[string]any{"group": here.ID}); a.Status == http.StatusOK {
			t.Fatalf("the move of a chat of the section into a group of this computer: %s", a)
		}
		if v, _ := rp.ownView(t, chat); v.Group != g2 {
			t.Fatalf("the chat at B after the refused move: %+v", v)
		}
		rp.a.must(t, pairPage, "DELETE", "/api/groups/"+here.ID+"?contents=delete", nil, nil)
	})

	// The delete of a group of the section with its contents deletes its chats on B, the one
	// that has not started too: each removed thing is told, and then the groups without it. The
	// same call on this computer's route finds no such group and deletes nothing.
	t.Run("group delete", func(t *testing.T) {
		gd := rp.group(t, "Gone soon")
		chat := rp.startChat(t, gd, "in the group")
		unstarted := rp.newChat(t, gd)
		rp.turns(t, chat, 1)
		rp.refused(t, http.StatusNotFound, "not_found", "DELETE", "/api/groups/"+gd+"?contents=delete", nil)
		mark := rp.page.mark()
		rp.ok(t, "DELETE", rp.on("/groups/"+gd+"?contents=delete"), nil)
		for _, id := range []string{chat, unstarted} {
			rp.page.awaitEvent(t, mark, 5*time.Second, "chat_removed", rp.inSection(), id)
			if _, ok := rp.listed(t, id); ok {
				t.Fatalf("the chat %s of the deleted group is still in the section", id)
			}
		}
		rp.page.await(t, mark, 5*time.Second, "groups event of the section without the group", func(e seenEvent) bool {
			return e.holds("groups", rp.inSection()) && !strings.Contains(e.Raw, gd)
		})
		for _, id := range []string{chat, unstarted} {
			if _, ok := rp.ownView(t, id); ok {
				t.Fatalf("B still has the chat %s of the deleted group", id)
			}
		}
		own, tree := rp.ownTree(t), rp.tree(t)
		for _, groups := range [][]model.Group{own.Groups, tree.Groups} {
			if slices.ContainsFunc(groups, func(x model.Group) bool { return x.ID == gd }) {
				t.Fatalf("the deleted group is still there: %+v at B, %+v in the section", own.Groups, tree.Groups)
			}
		}
	})
}

// AC27, the removal: an entry with two started chats and one that has not started in its
// section. The removal takes the section away from this app (the tree, the lists, the routes)
// and tells B nothing: B keeps the three chats, where its owner sees them.
func TestRemoteChatRemoval(t *testing.T) {
	serverTest(t, "TestSectionOfAnEntryThatIsRemoved (internal/remotes)", "TestSectionEventAtConnectDropAndRemoval (internal/server)", "TestManagerRemove (internal/servers)")
	rp := connectedPair(t, linksim.Good)
	g := rp.group(t, "Work")
	one, two := rp.startChat(t, g, "one"), rp.startChat(t, g, "two")
	rp.turns(t, one, 1)
	rp.turns(t, two, 1)
	unstarted := rp.newChat(t, g)
	// The removal no longer counts what is on the server.
	if a := rp.do(t, "GET", "/api/servers/"+rp.entry+"/items", nil); a.Status != http.StatusNotFound {
		t.Fatalf("the count of what is on %s: %s, want 404", pairName, a)
	}

	rp.noSecret(t, rp.page)
	mark := rp.page.mark()
	rp.ok(t, "DELETE", "/api/servers/"+rp.entry, nil)
	rp.page.await(t, mark, 5*time.Second, "section event without a tree", func(e seenEvent) bool {
		return e.holds("section", rp.inSection(), `"tree":null`)
	})
	rp.page.await(t, mark, 5*time.Second, "server_lists event without lists", func(e seenEvent) bool {
		return e.holds("server_lists", rp.entry, `"lists":null`)
	})
	for _, id := range []string{one, two, unstarted} {
		rp.refused(t, http.StatusNotFound, "no_server", "GET", rp.on("/chats/"+id), nil)
		rp.refused(t, http.StatusNotFound, "not_found", "GET", "/api/chats/"+id, nil)
	}
	rp.refused(t, http.StatusNotFound, "no_server", "POST", rp.on("/chats"), map[string]any{"group": g})
	st := rp.state(t)
	if len(st.Servers) != 1 || st.Servers[0].ID != servers.LocalID || len(st.Lists) != 0 || st.Sections == nil || len(st.Sections) != 0 {
		t.Fatalf("A's servers, lists and sections after the removal: %+v, %v, %v", st.Servers, st.Lists, st.Sections)
	}
	if len(st.Chats) != 0 {
		t.Fatalf("A's chats after the removal: %+v", st.Chats)
	}
	rp.noSecret(t, rp.page)

	// B was told nothing: it has both chats, started and not archived, with their threads.
	time.Sleep(300 * time.Millisecond)
	for id, text := range map[string]string{one: "FAKE(sonnet): one", two: "FAKE(sonnet): two"} {
		v, ok := rp.ownView(t, id)
		if !ok || !v.Locked || v.Archived || v.Group != g {
			t.Fatalf("the chat %s at B after the removal: %+v (there: %v)", id, v, ok)
		}
		if th := rp.own(t, id); !th.has(t, text) {
			t.Fatalf("the thread of %s at B after the removal: %s", id, joinThread(th))
		}
	}
	// The chat that never started stays there too, as it was made.
	if v, ok := rp.ownView(t, unstarted); !ok || v.Locked || v.Group != g {
		t.Fatalf("the chat that never started at B after the removal: %+v (there: %v)", v, ok)
	}
	if own := rp.ownTree(t); len(own.Chats) != 3 || len(own.Groups) != 1 || own.Groups[0].ID != g {
		t.Fatalf("the tree of B's own page after the removal:\n%s", strings.Join(own.lines(), "\n"))
	}
}

// standInWrap writes a program around the stand-in agent, for B's Claude program, and returns its
// path. It is the stand-in itself except for an agent that is started in a folder with this file:
//
//	.aiwb-fake-refuse   the program answers the handshake and then reads no more: it exits a
//	                    second later, so a first message larger than a pipe holds, which the
//	                    server is still writing then, is a send that fails after the start
//
// The folder is the chat's, so a test decides by the chat's folder what its agent does.
func standInWrap(t *testing.T) string {
	t.Helper()
	real := agenttest.FakeClaude(t)
	path := real + "-wrap" // beside it: runServer.fakes lists the processes by this path too
	const script = `#!/usr/bin/env node
const fs = require("node:fs");
const real = () => require(__dirname + "/fake-claude");
if (!process.argv.includes("--input-format")) real();
else if (fs.existsSync(".aiwb-fake-refuse")) {
  const buf = Buffer.alloc(4096);
  let text = "";
  while (!text.includes("\n")) text += buf.toString("utf8", 0, fs.readSync(0, buf, 0, buf.length));
  const m = JSON.parse(text.slice(0, text.indexOf("\n")));
  process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id,
    response: { models: [{ value: "sonnet", displayName: "Fake Sonnet", description: "scripted" }] } } }) + "\n");
  setTimeout(() => process.exit(0), 1000);
}
else real();
`
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// closedFolder makes a folder for a chat on B and returns it with a function that takes every
// permission from it: an agent's process cannot be started in it from then on, while the folder
// is still there.
func (rp *remotePair) closedFolder(t *testing.T) (dir string, shut func()) {
	t.Helper()
	dir = rp.folder(t, "", "")
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	return dir, func() {
		t.Helper()
		if err := os.Chmod(dir, 0); err != nil {
			t.Fatal(err)
		}
	}
}

// folder makes a folder for a chat on B, with the marker file of standInWrap when mark is not "".
func (rp *remotePair) folder(t *testing.T, mark, content string) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if mark != "" {
		if err := os.WriteFile(filepath.Join(dir, mark), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// newChatIn is newChat with the folder dir.
func (rp *remotePair) newChatIn(t *testing.T, group, dir string) string {
	t.Helper()
	id := rp.newChat(t, group)
	if a := rp.ok(t, "PATCH", rp.on("/chats/"+id), map[string]any{"cwd": dir}); a.Chat == nil || a.Chat.Cwd != dir {
		t.Fatalf("the folder %s of the chat: %s", dir, a)
	}
	return id
}

// AC16 (c), on the good and on the poor link: a first message that B refuses before the agent
// started leaves the chat unstarted on both sides with the reason in the answer, and a retry
// with another folder starts it; a delete after it takes the chat away on B; and an agent that
// starts and then refuses the message leaves the chat started on both sides. The first message
// is an ordinary message to a chat that is on B from the moment it was made in the section.
func TestRemoteChatFailedStart(t *testing.T) {
	serverTest(t, "TestSectionCallAnswers (internal/remotes)", "TestSectionCallsOfAConnectedEntry (internal/server)")
	if !agenttest.HasNode() {
		t.Skip("node is not on PATH (the fake claude is a Node script)")
	}
	wrap := standInWrap(t)
	for _, link := range []struct {
		name string
		p    linksim.Profile
	}{{"good link", linksim.Good}, {"poor link", linksim.Poor}} {
		t.Run(link.name, func(t *testing.T) {
			t.Parallel() // each link has its own pair
			rp := startRemotePair(t, link.p, wrap)
			rp.addEntry(t)
			g := rp.group(t, "Work")
			first := func(chat, text string) answer {
				t.Helper()
				return rp.do(t, "POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": text})
			}
			unstarted := func(chat, when string) model.ChatView {
				t.Helper()
				v := rp.view(t, chat)
				if v.Locked {
					t.Fatalf("%s: the chat through A: %+v, want it unstarted on %s", when, v, pairName)
				}
				if l, ok := rp.listed(t, chat); !ok || l.Locked {
					t.Fatalf("%s: the chat in the section: %+v", when, l)
				}
				if _, err := os.Stat(filepath.Join(rp.a.home, "chats", chat)); !os.IsNotExist(err) {
					t.Fatalf("%s: A keeps a chat of its own for the chat on %s: %v", when, pairName, err)
				}
				return v
			}

			// (c), first case: the agent's program does not start: its process cannot be started in the
			// chat's folder, which is there and cannot be entered.
			t.Run("the program does not start", func(t *testing.T) {
				bad, shut := rp.closedFolder(t)
				chat := rp.newChatIn(t, g, bad)
				shut()
				a := first(chat, "will not start")
				if a.Status < 400 || a.Error == "" {
					t.Fatalf("the first message with a program that does not start: %s", a)
				}
				t.Logf("a program that does not start: %s", a)
				unstarted(chat, "after the failed start")
				// B has the chat as before, and it has not started.
				if v, ok := rp.ownView(t, chat); !ok || v.Locked {
					t.Fatalf("the chat at B after the failed start: %+v (there: %v)", v, ok)
				}
				if th := rp.own(t, chat); th.users(t, "will not start") != 0 {
					t.Fatalf("B's thread after the failed start holds the message: %s", joinThread(th))
				}
				// A retry in another folder and with another model starts it, with both.
				if a := rp.ok(t, "PATCH", rp.on("/chats/"+chat), map[string]any{"cwd": rp.work, "model": "haiku"}); a.Chat == nil || a.Chat.Cwd != rp.work || a.Chat.Model != "haiku" {
					t.Fatalf("the change of folder and model after the failed start: %s", a)
				}
				if a := first(chat, "now it starts"); a.Status != http.StatusOK {
					t.Fatalf("the retry in another folder: %s", a)
				}
				rp.turns(t, chat, 1)
				th := rp.same(t, chat, "after the retry")
				if th.users(t, "now it starts") != 1 || th.users(t, "will not start") != 0 || !th.has(t, "FAKE(haiku): now it starts") {
					t.Fatalf("the thread after the retry: %s", joinThread(th))
				}
				if v := rp.view(t, chat); !v.Locked || v.Cwd != rp.work || v.Model != "haiku" {
					t.Fatalf("the chat after the retry: %+v", v)
				}
				if v, ok := rp.ownView(t, chat); !ok || !v.Locked || v.Cwd != rp.work || v.Model != "haiku" {
					t.Fatalf("the chat at B after the retry: %+v (there: %v)", v, ok)
				}
			})

			// (c), the folder: it is there when it is chosen and gone at the first message.
			t.Run("the folder is missing", func(t *testing.T) {
				gone := filepath.Join(rp.folder(t, "", ""), "gone")
				if err := os.Mkdir(gone, 0o700); err != nil {
					t.Fatal(err)
				}
				chat := rp.newChatIn(t, g, gone)
				if err := os.Remove(gone); err != nil {
					t.Fatal(err)
				}
				// B's refusal of the message, as B gives it to its own page.
				a := first(chat, "nowhere")
				if a.Status != http.StatusConflict || a.Error == "" {
					t.Fatalf("the first message in a folder that is gone: %s, want B's 409 with its reason", a)
				}
				t.Logf("a folder that is missing: %s", a)
				unstarted(chat, "after the refusal")
				if v, ok := rp.ownView(t, chat); !ok || v.Locked {
					t.Fatalf("the chat at B after the refusal: %+v (there: %v)", v, ok)
				}
				// A folder that is not there cannot be chosen; another one starts the chat.
				if a := rp.do(t, "PATCH", rp.on("/chats/"+chat), map[string]any{"cwd": gone}); a.Status == http.StatusOK {
					t.Fatalf("the choice of a folder that is not on B: %s", a)
				}
				rp.ok(t, "PATCH", rp.on("/chats/"+chat), map[string]any{"cwd": rp.work})
				if a := first(chat, "somewhere"); a.Status != http.StatusOK {
					t.Fatalf("the retry in another folder: %s", a)
				}
				rp.turns(t, chat, 1)
				if th := rp.same(t, chat, "after the retry"); th.users(t, "somewhere") != 1 || th.users(t, "nowhere") != 0 {
					t.Fatalf("the thread after the retry: %s", joinThread(th))
				}
			})

			// A delete after a failed start deletes the chat on B.
			t.Run("a delete after a failed start", func(t *testing.T) {
				bad, shut := rp.closedFolder(t)
				chat := rp.newChatIn(t, g, bad)
				shut()
				if a := first(chat, "will not start"); a.Status < 400 {
					t.Fatalf("the first message with a program that does not start: %s", a)
				}
				rp.ok(t, "DELETE", rp.on("/chats/"+chat), nil)
				eventually(t, 30*time.Second, "B no longer has the chat", func() bool { _, ok := rp.ownView(t, chat); return !ok })
				eventually(t, 30*time.Second, "the chat left the section", func() bool { _, ok := rp.listed(t, chat); return !ok })
			})

			// (c), second case: the agent starts and then refuses the message. The chat is started and
			// locked on both sides, and the thread shows the turn that failed.
			t.Run("the agent refuses after its start", func(t *testing.T) {
				chat := rp.newChatIn(t, g, rp.folder(t, ".aiwb-fake-refuse", ""))
				rp.followUnstarted(t, chat)
				mark := rp.page.mark()
				// The message is larger than a pipe holds (64 KB at most), with room to spare: B is
				// still writing it when the agent goes. It is no larger than that needs: the poor
				// link carries it at 1 Mbit/s, and its thread back several times.
				a := first(chat, "refused after the start "+strings.Repeat("x", 160<<10))
				t.Logf("an agent that refuses after its start: %s", clipText(a.String(), 400))
				own, ok := rp.ownView(t, chat)
				if !ok || !own.Locked {
					t.Fatalf("the wrapper did not produce \"started, then refused\": B's chat is %+v (there: %v) after %s", own, ok, clipText(a.String(), 400))
				}
				if a.Status < 400 || a.Error == "" {
					t.Fatalf("the first message that the agent refused: %s, want the refusal", a)
				}
				v := rp.view(t, chat)
				if !v.Locked {
					t.Fatalf("the chat through A after the refusal: %+v", v)
				}
				rp.awaitChat(t, mark, 30*time.Second, chat, "the lock", func(v model.ChatView) bool { return v.Locked })
				th := rp.same(t, chat, "after the refusal")
				if th.users(t, "refused after the start") != 1 {
					t.Fatalf("the thread after the refusal: %s", joinThread(th))
				}
				// The turn that failed shows: the user message is followed by the note of the
				// failure, and no end of a turn is there.
				items := th.items(t)
				at := slices.IndexFunc(items, func(it model.Item) bool {
					return it.Kind == "user" && strings.Contains(it.Text, "refused after the start")
				})
				if at < 0 || at+1 >= len(items) || items[at+1].Kind != "note" || items[at+1].Text == "" || th.ends() != 0 {
					t.Fatalf("the thread after the refusal shows no failed turn after the message: kinds %v", th.kinds())
				}
				t.Logf("the thread of the refused turn: %v, the note: %q", th.kinds(), clipText(items[at+1].Text, 200))
			})
		})
	}
}

// followUnstarted reads an unstarted chat's items through A, so that the page follows it.
func (rp *remotePair) followUnstarted(t *testing.T, chat string) {
	t.Helper()
	if a := rp.do(t, "GET", rp.on("/chats/"+chat+"/items"), nil); a.Status != http.StatusOK {
		t.Fatalf("the items of the unstarted chat %s: %s", chat, a)
	}
}

// later makes a call of the page on A that the test does not wait for: the answer comes on the
// channel, with the status 0 and the error as its text when none came.
func (rp *remotePair) later(method, path string, body any) <-chan answer {
	out := make(chan answer, 1)
	go func() {
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, rp.a.in.url+strings.TrimPrefix(path, "/"), strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(server.ClientHeader, pairPage)
		resp, err := (&http.Client{Timeout: 90 * time.Second}).Do(req)
		if err != nil {
			out <- answer{Raw: err.Error()}
			return
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		a := answer{}
		json.Unmarshal(b, &a)
		a.Status, a.Raw = resp.StatusCode, string(b)
		out <- a
	}()
	return out
}

// took waits for the answer of a call made with later.
func took(t *testing.T, what string, ch <-chan answer, limit time.Duration) answer {
	t.Helper()
	select {
	case a := <-ch:
		return a
	case <-time.After(limit):
		t.Fatalf("%s was not answered within %s", what, limit)
		return answer{}
	}
}

// AC16 (a), (b) and (e): answers that are lost on the way and a cut in the middle of a turn, on
// the good and on the poor link. Nothing is sent twice, and what the page reads through A after
// the return is B's own. While the link is cut the section has no tree and every call for a
// thing of it is refused; the tree A's page is sent at the return is B's as it is then.
func TestRemoteChatLostAnswers(t *testing.T) {
	serverTest(t, "TestSectionServerDropsInACall (internal/remotes)", "TestSectionCallsThatGetNoAnswer, TestServerDropsWithAChatAndARunFollowed (internal/server)")
	for _, link := range []struct {
		name string
		p    linksim.Profile
	}{{"good link", linksim.Good}, {"poor link", linksim.Poor}} {
		t.Run(link.name, func(t *testing.T) {
			t.Parallel() // each link has its own pair
			rp := connectedPair(t, link.p, fast.env(t, "backoff"))
			g := rp.group(t, "Work")
			// restore lets the link carry again and waits for A's connection.
			restore := func(t *testing.T) time.Duration {
				t.Helper()
				mark := rp.page.mark()
				rp.link.Stall(false, false)
				rp.link.Uncut()
				d := rp.back(t, 60*time.Second)
				rp.treeBack(t, mark)
				return d
			}
			message := func(chat, text string) <-chan answer {
				return rp.later("POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": text})
			}

			// (a) A send in a started chat: its body arrives, its answer does not.
			t.Run("a send whose answer is lost", func(t *testing.T) {
				chat := rp.startChat(t, g, "one")
				rp.turns(t, chat, 1)
				rp.same(t, chat, "before the cut")
				rp.link.Stall(true, false) // what B sends waits
				sent := message(chat, "answer lost")
				rp.awaitOwn(t, chat, "the message", func(th thread) bool { return th.users(t, "answer lost") == 1 })
				rp.link.Cut()
				a := took(t, "the send", sent, 10*time.Second)
				if a.Status != http.StatusGatewayTimeout || a.Code != "send_unknown" || !strings.Contains(a.Error, pairName) {
					t.Fatalf("the send whose answer was lost: %s, want 504 send_unknown", a)
				}
				rp.waitState(t, servers.StateUnreachable, 5*time.Second)
				rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": "not sent"})
				rp.noTree(t, "after the lost answer")
				back := restore(t)
				rp.turns(t, chat, 2)
				th := rp.same(t, chat, "after the return")
				if th.users(t, "answer lost") != 1 || th.users(t, "not sent") != 0 || !th.has(t, "FAKE(sonnet): answer lost") {
					t.Fatalf("the thread after the return: %s", joinThread(th))
				}
				t.Logf("%s, (a): 504 send_unknown; connected again %v after the link was back; the message is in the thread once", link.name, back.Round(time.Millisecond))
			})

			// (b) The same at a first message, which is an ordinary message to a chat that is on B
			// already: it is not known whether it arrived, as for any message. While B cannot be
			// reached the section has no tree, so nothing says whether the chat started, and a
			// repeat sends nothing; the tree of the reconnect has the chat as started, in its group.
			t.Run("a first message whose answer is lost", func(t *testing.T) {
				chat := rp.newChat(t, g)
				rp.followUnstarted(t, chat)
				rp.link.Stall(true, false)
				sent := message(chat, "first lost")
				eventually(t, 20*time.Second, "the chat started at B", func() bool { v, ok := rp.ownView(t, chat); return ok && v.Locked })
				rp.link.Cut()
				a := took(t, "the first message", sent, 10*time.Second)
				if a.Status != http.StatusGatewayTimeout || a.Code != "send_unknown" || !strings.Contains(a.Error, pairName) {
					t.Fatalf("the first message whose answer was lost: %s, want 504 send_unknown", a)
				}
				rp.waitState(t, servers.StateUnreachable, 5*time.Second)
				rp.noTree(t, "after the lost answer")
				rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "PATCH", rp.on("/chats/"+chat), map[string]any{"agent": "claude", "model": "haiku"})
				// Repeats while B cannot be reached send nothing.
				for range 2 {
					rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": "first lost"})
				}
				rp.noTree(t, "after two repeats without a connection")
				mark := rp.page.mark()
				back := restore(t)
				// The tree of the return says that the chat started: no event of the chat is needed.
				tree := rp.page.await(t, mark, 10*time.Second, "section event with the started chat", func(e seenEvent) bool {
					return e.holds("section", rp.inSection(), chat) && !strings.Contains(e.Raw, `"tree":null`)
				})
				var ev struct{ Tree remotes.Tree }
				json.Unmarshal([]byte(tree.Raw), &ev)
				if i := slices.IndexFunc(ev.Tree.Chats, func(v model.ChatView) bool { return v.ID == chat }); i < 0 || !ev.Tree.Chats[i].Locked || ev.Tree.Chats[i].Group != g {
					t.Fatalf("the chat in the tree of the reconnect: %s", clipText(tree.Raw, 600))
				}
				if v, ok := rp.listed(t, chat); !ok || !v.Locked || v.Group != g {
					t.Fatalf("the chat in the section after the return: %+v (listed: %v)", v, ok)
				}
				rp.turns(t, chat, 1)
				th := rp.same(t, chat, "after the return")
				if th.users(t, "first lost") != 1 || len(rp.own(t, chat).items(t)) == 0 {
					t.Fatalf("the thread after the return: %s", joinThread(th))
				}
				t.Logf("%s, (b): 504 send_unknown, two repeats without a connection 503; seen started %v after the link was back; one user message at B", link.name, back.Round(time.Millisecond))
			})

			// (e) A cut of 15 s in the middle of a turn, on the clock of the test: A's tries to
			// connect are as many steps into their back-off as after 15 s of the production one.
			t.Run("a cut in the middle of a turn", func(t *testing.T) {
				chat := rp.startChat(t, g, "one")
				rp.turns(t, chat, 1)
				rp.same(t, chat, "before the cut")
				skip := rp.b.fakeMessages(t)
				sent := rp.page.mark()
				rp.send(t, chat, "through the cut [[sleep 3]]")
				rp.b.waitFakeMessage(t, skip, "through the cut")
				// The user's message is content B sends before the cut: the page has it before
				// the mark, so that what comes after the mark is the reply's alone.
				rp.page.awaitEvent(t, sent, 3*time.Second, "chat_items", rp.inSection(), chat, "through the cut")
				mark := rp.page.mark()
				rp.link.Cut()
				cut := time.Now()
				rp.waitState(t, servers.StateUnreachable, 2*time.Second)
				// The page is told that the tree is gone: the section shows no row from here on.
				rp.page.await(t, mark, 5*time.Second, "section event without a tree", func(e seenEvent) bool {
					return e.holds("section", rp.inSection(), `"tree":null`)
				})
				rp.turns(t, chat, 2) // the turn ends at B while A cannot be told
				if evs := rp.page.of(mark, "chat_items", chat); len(evs) != 0 {
					t.Fatalf("the page was sent content events through a cut link: %v", evs)
				}
				rp.noTree(t, "while the link is cut")
				away := fast.of(15 * time.Second)
				time.Sleep(time.Until(cut.Add(away)))
				back := restore(t)
				th := rp.same(t, chat, "after the return")
				if !th.has(t, "FAKE(sonnet): through the cut") || th.ends() != 2 {
					t.Fatalf("the thread after the return: %s", joinThread(th))
				}
				if a, b := rp.view(t, chat), func() model.ChatView { v, _ := rp.ownView(t, chat); return v }(); a.Status != b.Status || a.Status != model.StatusReady {
					t.Fatalf("the chat's status after the return: %q through A, %q at B", a.Status, b.Status)
				}
				t.Logf("%s, (e): cut for %v (15 s of the production clock) in the middle of a turn; connected again %v after the link was back; the thread through A is B's", link.name, max(away, time.Since(cut)-back).Round(100*time.Millisecond), back.Round(time.Millisecond))
			})
		})
	}
}

// A make whose answer was lost (the goal's 3.4): if the thing was made it shows in the section
// like anything else, no clean-up looks for it, and nothing is deleted on its account.
//
// First with the connection up all the while: nothing comes from B for longer than A waits for
// the answer of a fork, and less long than the silence that ends a connection. A answers that B
// did not answer and keeps no memory of the call; when B's answer and events arrive after all,
// the fork is in the section by B's chat event. The wait for a fork is the one of the fast
// clock, 4.5 s for 45 s; the silence is the production one, 35 s, so the connection stays.
// (With AIWB_TEST_REAL_WAITS=1 the wait is the longer of the two, and the fork comes with the
// tree of the connection that is made again.)
//
// Then with a cut: a new chat is made, B's answer waits, and the link is cut. The chat is in
// the tree A's page is sent when the connection is back.
//
// Both are still there after A has been stopped and started again: no start cleans up.
func TestRemoteChatLostMake(t *testing.T) {
	serverTest(t, "TestSectionCallsThatGetNoAnswer (internal/server)", "TestSectionServerDropsInACall, TestSectionEvents (internal/remotes)")
	rp := connectedPair(t, linksim.Good, fast.env(t, "start", "backoff"))
	g := rp.group(t, "Work")
	src := rp.startChat(t, g, "fork me")
	th := rp.turns(t, src, 1)
	chatsAtB := func() map[string]model.ChatView {
		t.Helper()
		out := map[string]model.ChatView{}
		for _, v := range rp.ownTree(t).Chats {
			out[v.ID] = v
		}
		return out
	}
	// madeAtB waits until B has a chat that was not there before, and returns it.
	madeAtB := func(before map[string]model.ChatView, what string) (made model.ChatView) {
		t.Helper()
		eventually(t, 20*time.Second, what+" is made at B", func() bool {
			for id, v := range chatsAtB() {
				if _, was := before[id]; !was {
					made = v
					return true
				}
			}
			return false
		})
		return made
	}

	// The fork: its answer and its event wait at the link until A has given up on the answer.
	before := chatsAtB()
	mark := rp.page.mark()
	rp.link.Stall(true, false) // what B sends waits
	sent := time.Now()
	a := took(t, "the fork", rp.later("POST", rp.on("/chats/"+src+"/fork"), map[string]any{"branch": "main", "at": len(th)}), 80*time.Second)
	if a.Status != http.StatusGatewayTimeout || a.Code != "no_answer" || !strings.Contains(a.Error, pairName) {
		t.Fatalf("the fork whose answer did not come: %s, want 504 no_answer", a)
	}
	t.Logf("the fork: 504 no_answer after %v", time.Since(sent).Round(100*time.Millisecond))
	fork := madeAtB(before, "the fork")
	if fork.ForkedFrom != src || fork.Group != g {
		t.Fatalf("the fork at B: %+v", fork)
	}
	if v, ok := rp.listed(t, fork.ID); ok {
		t.Fatalf("the fork is in the section before B's event came: %+v", v)
	}
	// On the production clock the wait for a fork, 45 s, is longer than the silence that ends a
	// connection, 35 s: there the connection is gone by now, and the fork comes with the tree.
	if v := rp.entryView(t); v.State != servers.StateConnected && !realWaits() {
		t.Fatalf("%s is %q (%s) after the lost answer, want it connected still: the test is of an answer that is lost on a connection that stays", pairName, v.State, v.Detail)
	}
	rp.link.Stall(false, false)
	if realWaits() {
		rp.back(t, 60*time.Second)
		eventually(t, 20*time.Second, "the fork is in the section", func() bool { _, ok := rp.listed(t, fork.ID); return ok })
	} else {
		rp.awaitChat(t, mark, 20*time.Second, fork.ID, "the fork", func(v model.ChatView) bool { return v.ForkedFrom == src && v.Group == g })
		if evs := rp.page.of(mark, "section"); len(evs) != 0 {
			t.Fatalf("the connection was made again on the way: the fork came with a tree, not by its event: %v", evs)
		}
	}
	if v, ok := rp.listed(t, fork.ID); !ok || v.Group != g || !v.Locked {
		t.Fatalf("the fork in the section: %+v (listed: %v)", v, ok)
	}

	// The new chat: its answer waits, and the link is cut.
	before = chatsAtB()
	rp.link.Stall(true, false)
	making := rp.later("POST", rp.on("/chats"), map[string]any{"agent": "claude", "group": g})
	made := madeAtB(before, "the new chat")
	rp.link.Cut()
	if a := took(t, "the make", making, 10*time.Second); a.Status != http.StatusGatewayTimeout || a.Code != "no_answer" || !strings.Contains(a.Error, pairName) {
		t.Fatalf("the make whose answer was lost: %s, want 504 no_answer", a)
	}
	rp.waitState(t, servers.StateUnreachable, 5*time.Second)
	rp.noTree(t, "after the lost answer of the make")
	mark = rp.page.mark()
	rp.link.Stall(false, false)
	rp.link.Uncut()
	rp.back(t, 60*time.Second)
	rp.treeBack(t, mark)
	if v, ok := rp.listed(t, made.ID); !ok || v.Group != g || v.Locked {
		t.Fatalf("the chat of the lost make in the section: %+v (listed: %v)", v, ok)
	}
	// Each is a chat like any other: a message through A starts the one and goes on in the other.
	for _, id := range []string{made.ID, fork.ID} {
		ends := rp.own(t, id).ends()
		rp.send(t, id, "after the lost answer")
		rp.awaitOwn(t, id, "the reply", func(th thread) bool { return th.ends() > ends && th.has(t, "FAKE(sonnet): after the lost answer") })
		rp.same(t, id, "after a message")
	}

	// A keeps no memory of the two calls, so its next start has nothing to clean up: B has both
	// chats after it, and the section shows them.
	if held := holders(folderFiles(t, rp.a.home), []string{made.ID, fork.ID, src, g}); len(held) != 0 {
		t.Fatalf("files of A's data folder that hold something of the chats on %s: %v", pairName, held)
	}
	rp.page.close()
	rp.a.stop(t)
	rp.a.start(t)
	rp.page = watch(t, http.DefaultClient, strings.TrimSuffix(rp.a.in.url, "/"), pairPage, nil)
	rp.back(t, 60*time.Second)
	eventually(t, 20*time.Second, "the section has both chats after A's restart", func() bool {
		_, one := rp.listed(t, made.ID)
		_, two := rp.listed(t, fork.ID)
		return one && two
	})
	time.Sleep(500 * time.Millisecond) // a clean-up at the connect would have reached B
	for _, id := range []string{made.ID, fork.ID, src} {
		if v, ok := rp.ownView(t, id); !ok || v.Archived {
			t.Fatalf("the chat %s at B after A's restart: %+v (there: %v)", id, v, ok)
		}
	}
}

// A first message that is under way when A's process is killed: B has started the chat, and A
// has not been told. A keeps nothing of the chat: no file of its data folder names it. After A's
// next start nothing looks for the chat and nothing is cleaned up: the tree of its connection
// lists the chat as started, in its group, and its thread through A is B's, with the message once.
func TestRemoteChatKilledInAFirstMessage(t *testing.T) {
	serverTest(t, "TestSectionTreeFromSnapshot, TestSectionNothingOnDisk (internal/remotes)")
	rp := connectedPair(t, linksim.Good)
	g := rp.group(t, "Work")
	chat := rp.newChat(t, g)
	rp.followUnstarted(t, chat)
	rp.link.Stall(true, false) // what B sends waits: the message stays under way at A
	sent := rp.later("POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": "cut by a kill"})
	eventually(t, 20*time.Second, "the chat started at B", func() bool { v, ok := rp.ownView(t, chat); return ok && v.Locked })
	select {
	case a := <-sent:
		t.Fatalf("the first message was answered while B's answers wait: %s", a)
	case <-time.After(300 * time.Millisecond):
	}
	rp.a.kill(t)
	if a := took(t, "the first message", sent, 10*time.Second); a.Status != 0 {
		t.Fatalf("the first message of a killed server was answered: %s", a)
	}
	if _, err := os.Stat(filepath.Join(rp.a.home, "chats", chat)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("A keeps a chat of its own for the chat on %s: %v", pairName, err)
	}
	// Nothing of the chat, of its group or of its message is in a file of A: there is no record
	// and no memory of a make that a next start could act on.
	if held := holders(folderFiles(t, rp.a.home), []string{chat, g, "cut by a kill"}); len(held) != 0 {
		t.Fatalf("files of A's data folder that hold something of the chat on %s: %v", pairName, held)
	}

	rp.link.Stall(false, false)
	rp.a.start(t)
	rp.page = watch(t, http.DefaultClient, strings.TrimSuffix(rp.a.in.url, "/"), pairPage, nil)
	back := rp.back(t, 60*time.Second)
	eventually(t, 10*time.Second, "the chat is listed as started", func() bool {
		v, ok := rp.listed(t, chat)
		return ok && v.Locked && v.Group == g
	})
	if _, ok := rp.ownView(t, chat); !ok {
		t.Fatalf("B lost the chat at A's start: nothing may be deleted for a make or a message whose answer was lost")
	}
	rp.turns(t, chat, 1)
	if th := rp.same(t, chat, "after A's restart"); th.users(t, "cut by a kill") != 1 || !th.has(t, "FAKE(sonnet): cut by a kill") {
		t.Fatalf("the thread after A's restart: %s", joinThread(th))
	}
	// Its next message is a message like the first.
	rp.send(t, chat, "after the restart")
	rp.turns(t, chat, 2)
	if th := rp.same(t, chat, "after a send"); th.users(t, "cut by a kill") != 1 || th.users(t, "after the restart") != 1 {
		t.Fatalf("the thread after a send: %s", joinThread(th))
	}
	t.Logf("killed with the first message under way; connected %v after A's start; seen started, one first message at B", back.Round(time.Millisecond))
}

// AC12: B is stopped for 60 s during a turn, and in a second round restarted at once; then the
// link stalls. The entry's state is read with its times, a chat of this computer is used
// meanwhile, and after each return the chat on screen and a second chat are compared with B's.
// While B is away its section has no tree (no row, no last view) and every call for a thing of
// it is refused at once; at the return the page is sent B's tree as it is then, and reads work.
//
// The 60 s, the back-off of A's connection and the silence that ends a stream are those of the
// fast clock: B is away for 6 s, which is past the last step of a back-off of 0.1 to 3 s as 60 s
// are past the last of 1 to 30 s, and the stall is found after 3.5 s. AIWB_TEST_REAL_WAITS=1
// runs the test on the production values (see clock).
func TestRemoteChatOutage(t *testing.T) {
	serverTest(t, "TestSectionStates (internal/remotes)", "TestServerDropsWithAChatAndARunFollowed (internal/server)", "TestConnReconnects, TestConnSilence (internal/servers)")
	rp := connectedPair(t, linksim.Good, fast.env(t, "silence", "backoff"))
	g := rp.group(t, "Work")
	onScreen, second := rp.startChat(t, g, "one"), rp.startChat(t, g, "two")
	both := []string{onScreen, second}
	for _, id := range both {
		rp.turns(t, id, 1)
	}
	var local model.ChatView
	rp.a.must(t, pairPage, "POST", "/api/chats", map[string]any{"agent": "claude", "group": model.Ungrouped}, &local)
	rp.ok(t, "PATCH", "/api/chats/"+local.ID, map[string]any{"cwd": rp.work})
	localTurns := 0
	rp.same(t, second, "before the outage") // opened before the outage, and after it
	rp.same(t, onScreen, "before the outage")

	// down stops B during a turn of the chat on screen, checks what holds while it is away, starts
	// B again after the time away, and checks the return.
	// prod says how the return is waited for: with calls of a page that make A's connection try
	// at once (back), or, when false, by reading the list of servers alone, so that A connects
	// again with no action at all.
	down := func(t *testing.T, name string, away time.Duration, prod bool) {
		skip := rp.b.fakeMessages(t)
		rp.send(t, onScreen, name+" [[sleep 600]]")
		rp.b.waitFakeMessage(t, skip, name)
		mark := rp.page.mark()
		signalled := time.Now()
		rp.b.stop(t)
		exited := time.Now()
		rp.waitState(t, servers.StateUnreachable, 2*time.Second)
		told := rp.page.await(t, mark, 2*time.Second, "server_state event: unreachable", func(e seenEvent) bool {
			return e.holds("server_state", rp.entry, `"unreachable"`)
		})
		if d := told.At.Sub(exited); d > 2*time.Second {
			t.Fatalf("the page was told of the outage %v after B was gone, want within 2 s", d)
		}
		// And that the section has no tree any more: its rows go, the one on screen too.
		rp.page.await(t, mark, 10*time.Second, "section event without a tree", func(e seenEvent) bool {
			return e.holds("section", rp.inSection(), `"tree":null`)
		})
		t.Logf("AC12, %s: the page was told that %s is unreachable %v after B's process was gone (%v after its stop began)",
			name, pairName, max(told.At.Sub(exited), 0).Round(time.Millisecond), told.At.Sub(signalled).Round(time.Millisecond))

		// A send and a read answer at once that the server is not connected, and the section has
		// no tree: nothing of B is listed, the chats that were open neither; a chat of this
		// computer works.
		whileAway := func(when string) {
			t.Helper()
			if v := rp.entryView(t); v.State != servers.StateUnreachable {
				t.Fatalf("%s: %s is %q", when, pairName, v.State)
			}
			start := time.Now()
			rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "POST", rp.on("/chats/"+onScreen+"/messages"), map[string]any{"text": "while away"})
			rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "GET", rp.on("/chats/"+second+"/items"), nil)
			if d := time.Since(start); d > 2*time.Second {
				t.Fatalf("%s: the two refusals took %v", when, d)
			}
			rp.noTree(t, when)
			for _, id := range both {
				if v, ok := rp.listed(t, id); ok {
					t.Fatalf("%s: the chat %s is listed: %+v", when, id, v)
				}
			}
			// Leaving a chat that was open needs no server.
			rp.ok(t, "POST", rp.on("/chats/"+second+"/unfollow"), nil)
		}
		whileAway("while B is away")
		rp.ok(t, "POST", "/api/chats/"+local.ID+"/messages", map[string]any{"text": name + " here"})
		localTurns++
		eventually(t, 20*time.Second, "the reply of the chat on this computer", func() bool {
			th, _ := threadOf(rp.ok(t, "GET", "/api/chats/"+local.ID+"/items", nil).Raw)
			return th.has(t, "FAKE(sonnet): "+name+" here") && th.ends() >= localTurns
		})
		time.Sleep(time.Until(exited.Add(away)))
		whileAway(fmt.Sprintf("after %s without B", away))

		mark = rp.page.mark()
		rp.b.up(t)
		var back time.Duration
		if prod {
			back = rp.back(t, 45*time.Second)
		} else {
			back = rp.waitState(t, servers.StateConnected, 45*time.Second)
		}
		rp.treeBack(t, mark)
		t.Logf("AC12, %s: connected again %v after B answered (%v after B's process was gone)", name, back.Round(time.Millisecond), time.Since(exited).Round(time.Millisecond))
		// What the page reads when the tree is back is B's own: the chat on screen, with the turn the
		// stop ended, and the second chat when it is opened next.
		th := rp.same(t, onScreen, "after the return")
		if th.users(t, name) != 1 || th.users(t, "while away") != 0 {
			t.Fatalf("the thread on screen after the return: %s", joinThread(th))
		}
		rp.same(t, second, "after the return")
		for _, id := range both {
			a, _ := rp.listed(t, id)
			b, there := rp.ownView(t, id)
			if !there || a.Status != b.Status || a.Name != b.Name || a.Group != g {
				t.Fatalf("the chat %s after the return: %+v in the section, %+v at B (there: %v)", id, a, b, there)
			}
		}
		// And it goes on: a message through A is answered, and its events reach the page.
		mark = rp.page.mark()
		ends := th.ends()
		rp.send(t, onScreen, name+" and on")
		rp.page.await(t, mark, 20*time.Second, "content event with the reply", func(e seenEvent) bool {
			return e.holds("chat_items", rp.inSection(), onScreen, "FAKE(sonnet): "+name+" and on")
		})
		rp.awaitOwn(t, onScreen, "the turn after the return", func(th thread) bool { return th.ends() > ends && th.has(t, "FAKE(sonnet): "+name+" and on") })
		rp.same(t, onScreen, "after a message that followed the return")
	}

	t.Run("stopped for 60 s", func(t *testing.T) {
		down(t, "stopped", fast.of(60*time.Second), false)
	})

	t.Run("restarted", func(t *testing.T) {
		down(t, "restarted", 0, false)
	})

	// A link that stalls keeps its connections: the outage is found by the silence. B is up all
	// the while, and its owner renames one chat and deletes another: at the return the section
	// is B's tree as it is then, with the new name and without the deleted chat, whose calls are
	// B's "not found". No event told of either.
	t.Run("stalled link", func(t *testing.T) {
		renamed, deleted := rp.newChat(t, g), rp.newChat(t, g)
		own := rp.ownPage(t)
		defer own.close()
		mark := rp.page.mark()
		rp.link.Stall(true, true)
		found := rp.waitState(t, servers.StateUnreachable, 40*time.Second)
		rp.page.await(t, mark, 2*time.Second, "server_state event: unreachable", func(e seenEvent) bool {
			return e.holds("server_state", rp.entry, `"unreachable"`)
		})
		rp.page.await(t, mark, 10*time.Second, "section event without a tree", func(e seenEvent) bool {
			return e.holds("section", rp.inSection(), `"tree":null`)
		})
		rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "POST", rp.on("/chats/"+onScreen+"/messages"), map[string]any{"text": "stalled"})
		rp.noTree(t, "while the link stalls")
		rp.b.must(t, pairOwnPage, "PATCH", "/api/chats/"+renamed, map[string]any{"name": "Named meanwhile"}, nil)
		rp.b.must(t, pairOwnPage, "DELETE", "/api/chats/"+deleted, nil, nil)
		mark = rp.page.mark()
		rp.link.Stall(false, false)
		back := rp.back(t, 45*time.Second)
		rp.treeBack(t, mark)
		if v, ok := rp.listed(t, renamed); !ok || v.Name != "Named meanwhile" || v.Group != g {
			t.Fatalf("the chat that was renamed at B meanwhile, in the section: %+v (listed: %v)", v, ok)
		}
		if v, ok := rp.listed(t, deleted); ok {
			t.Fatalf("the chat that was deleted at B meanwhile is in the section: %+v", v)
		}
		rp.refused(t, http.StatusNotFound, "not_found", "GET", rp.on("/chats/"+deleted), nil)
		rp.refused(t, http.StatusNotFound, "not_found", "GET", rp.on("/chats/"+deleted+"/items"), nil)
		if evs := append(rp.page.of(mark, "chat_removed", deleted), rp.page.of(mark, "chat", renamed)...); len(evs) != 0 {
			t.Fatalf("the page was sent events of what happened during the outage: %v", evs)
		}
		t.Logf("AC12, a stalled link: %s was unreachable %v after the stall began, and connected again %v after it ended", pairName, found.Round(time.Millisecond), back.Round(time.Millisecond))
		if th := rp.same(t, onScreen, "after the stall"); th.users(t, "stalled") != 0 {
			t.Fatalf("the thread after the stall: %s", joinThread(th))
		}
		rp.same(t, second, "after the stall")
	})
}

// freezeB stops B's process where it is (SIGSTOP): its listeners stay open and take connections,
// and nothing is read or answered. The process is continued when the test ends, whatever its
// result, so that the stop of the server finds a process that can exit.
func (rp *remotePair) freezeB(t *testing.T) {
	t.Helper()
	if rp.b.cmd == nil {
		t.Fatal("freezeB: B is not running")
	}
	pid := rp.b.cmd.Process.Pid
	if err := syscall.Kill(pid, syscall.SIGSTOP); err != nil {
		t.Fatalf("SIGSTOP of B (%d): %v", pid, err)
	}
	t.Cleanup(func() { syscall.Kill(pid, syscall.SIGCONT) })
}

// continueB lets a frozen B go on (SIGCONT).
func (rp *remotePair) continueB(t *testing.T) {
	t.Helper()
	if rp.b.cmd == nil {
		t.Fatal("continueB: B is not running")
	}
	if err := syscall.Kill(rp.b.cmd.Process.Pid, syscall.SIGCONT); err != nil {
		t.Fatalf("SIGCONT of B: %v", err)
	}
}

// A first message sent while B's process is frozen: the message is in B's socket and gets no
// answer, so A answers 504 send_unknown, as for any message, and marks B unreachable: the
// section has no tree from then on. What the person types meanwhile cannot be saved, since the
// draft is B's: the save fails and the page keeps the text. Then B goes on, takes the message
// and starts the chat. With no call but reads of A's snapshot the section has B's tree again,
// with the chat as started and the message once, and its draft can be saved again, on B.
//
// A's limit for a message and the silence that ends its stream before that are those of the
// fast clock: 4.5 s and 3.5 s for 45 s and 35 s.
func TestRemoteChatFrozenFirstMessage(t *testing.T) {
	serverTest(t, "TestSectionCallsThatGetNoAnswer, TestSectionCallsOfAnEntryThatCannotBeAsked, TestTwoPagesInOneDraftOfASectionsChat (internal/server)")
	rp := connectedPair(t, linksim.Good, fast.env(t, "silence", "start"))
	g := rp.group(t, "Work")
	const sentText, typed = "first M1", "first M1 EDITED"
	chat := rp.newChat(t, g)
	rp.followUnstarted(t, chat)
	// The counter the page has for the chat's draft: the one it types on while B is away.
	v, ok := rp.listed(t, chat)
	if !ok || v.Locked || v.Group != g {
		t.Fatalf("the chat before the message: %+v (listed: %v)", v, ok)
	}
	mark := rp.page.mark()
	rp.freezeB(t)
	began := time.Now()
	a := took(t, "the first message", rp.later("POST", rp.on("/chats/"+chat+"/messages"), map[string]any{"text": sentText}), 80*time.Second)
	if a.Status != http.StatusGatewayTimeout || a.Code != "send_unknown" {
		t.Fatalf("the first message to a frozen B: %s, want 504 send_unknown", a)
	}
	t.Logf("504 send_unknown %v after the send; %s is %q", time.Since(began).Round(100*time.Millisecond), pairName, rp.entryView(t).State)
	// The page puts the text back in the box. What the person makes of it cannot be saved while
	// B is away: the draft lives there, and A keeps none. The section has no tree: nothing says
	// whether the chat started.
	rp.waitState(t, servers.StateUnreachable, 20*time.Second)
	rp.page.await(t, mark, 20*time.Second, "section event without a tree", func(e seenEvent) bool {
		return e.holds("section", rp.inSection(), `"tree":null`)
	})
	rp.refused(t, http.StatusServiceUnavailable, "server_unreachable", "PUT", rp.on(fmt.Sprintf("/chats/%s/draft?rev=%d", chat, v.DraftRev)), map[string]any{"text": typed})
	rp.noTree(t, "while "+pairName+" is frozen")
	if held := holders(folderFiles(t, rp.a.home), []string{chat, typed, sentText}); len(held) != 0 {
		t.Fatalf("files of A's data folder that hold something of the chat while %s is away: %v", pairName, held)
	}

	// B goes on. From here nothing is sent through A: its snapshot alone is read.
	rp.continueB(t)
	continued := time.Now()
	var l model.ChatView
	eventually(t, 60*time.Second, "the chat is listed as started on "+pairName, func() bool {
		l, ok = rp.listed(t, chat)
		return ok && l.Locked
	})
	t.Logf("listed as started %v after B went on", time.Since(continued).Round(10*time.Millisecond))
	if l.Group != g || l.Draft != nil {
		t.Fatalf("the started chat in the section: %+v (draft %+v)", l, l.Draft)
	}
	if evs := rp.page.of(mark, "chat_removed", chat); len(evs) != 0 {
		t.Fatalf("the chat was removed on the way: %v", evs)
	}
	// The page was sent B's tree again, with the chat in it.
	rp.page.await(t, mark, 20*time.Second, "section event with the chat", func(e seenEvent) bool {
		return e.holds("section", rp.inSection(), chat) && !strings.Contains(e.Raw, `"tree":null`)
	})
	// B has the message once, and what A hands on is B's thread.
	rp.turns(t, chat, 1)
	if th := rp.own(t, chat); th.users(t, sentText) != 1 || !th.has(t, "FAKE(sonnet): "+sentText) {
		t.Fatalf("B's thread: %s, want %q once and its reply", joinThread(th), sentText)
	}
	if th := rp.same(t, chat, "after B went on"); th.users(t, sentText) != 1 || len(th.items(t)) == 0 {
		t.Fatalf("the thread through A: %s, want %q once", joinThread(th), sentText)
	}
	// The text the page kept is saved now, on B, on the counter B has for the branch.
	l, _ = rp.listed(t, chat)
	var saved struct {
		OK  bool
		Rev int64
	}
	if status, raw := rp.a.call(t, pairPage, "PUT", rp.on(fmt.Sprintf("/chats/%s/draft?rev=%d", chat, l.DraftRev)), map[string]any{"text": typed}, &saved); status != http.StatusOK || !saved.OK {
		t.Fatalf("the save of the draft on counter %d: %d %s", l.DraftRev, status, raw)
	}
	if own, _ := rp.ownView(t, chat); own.Draft == nil || own.Draft.Text != typed || own.DraftRev != saved.Rev {
		t.Fatalf("the draft at B after its save through A: %+v on %d, want %q on %d", own.Draft, own.DraftRev, typed, saved.Rev)
	}
	eventually(t, 10*time.Second, "the section has B's draft", func() bool {
		v, _ := rp.listed(t, chat)
		return v.Draft != nil && v.Draft.Text == typed && v.DraftRev == saved.Rev
	})
}
