package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
)

// The prompt libraries of several servers (section 7 of the goal). Two kinds of test: the remote
// listener alone, asked as an API client asks it, and two real stacks in one process (pair, see
// boardpair_test.go): B, a server with a remote listener and a library, and A, the user's own
// server with B in its list. A's pages are stand-in pages on the real bridge. Nothing is
// scripted between the two: what A sends is what B's routes get, and what A shows of B's
// library is what came over the stream it holds to B.

func isLibraryRoute(route string) bool { return strings.Contains(route, " /api/library") }

// ---- the remote listener ----

// apiLibrary is the answer of an API client's call for the library: the status and the body.
func (l *listener) library(method, path, body string) (int, map[string]any) {
	l.t.Helper()
	status, out := l.call(apiX, testSecret, method, path, body)
	got := map[string]any{}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		l.t.Fatalf("%s %s: %d %s", method, path, status, out)
	}
	return status, got
}

// ownLibrary reads the library in an "own_library" event or in an API snapshot.
func ownLibrary(t *testing.T, raw string) library.View {
	t.Helper()
	var v struct {
		Type    string
		Library *library.Tree
		Groups  []library.Group
		Prompts []library.Prompt
	}
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatal(err)
	}
	if v.Type == "snapshot" {
		if v.Library == nil {
			t.Fatalf("the snapshot has no library: %s", raw)
		}
		return library.View{Groups: v.Library.Groups, Prompts: v.Library.Prompts}
	}
	return library.View{Groups: v.Groups, Prompts: v.Prompts}
}

// Line 26 of section 10, and the part of the remote port in lines 20 and 21: every library
// route of the table does for an API client what it does for a page, on the server's own
// library and on no other; the server checks the rules itself; and the client gets the library
// by itself, in its snapshot and after every change, whoever made it.
func TestLibraryRoutesOfAnAPIClient(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	// A file that was set aside: the page is told, with the folder's path; an API client is not.
	if err := os.WriteFile(filepath.Join(root, library.FileName), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	e, l := remoteEnv(t, withLibrary(t, root))
	if e.local().Notice == "" {
		t.Fatal("the page's library has no notice")
	}
	owner := e.page("owner")
	x, snapX := l.api(apiX)
	y, snapY := l.api(apiY)
	if got := ownLibrary(t, snapX); libraryPaths(got) != "" || got.Groups == nil || got.Prompts == nil {
		t.Fatalf("the library of the snapshot: %s", snapX)
	}
	_, hello := l.call(apiX, testSecret, "GET", "/api/hello", "")
	if got := decode[obj](t, hello); got["featureLevel"] != float64(FeatureLevel) || FeatureLevel < servers.LibraryLevel {
		t.Fatalf("hello: %s; a client takes a library from level %d", hello, servers.LibraryLevel)
	}

	called := map[string]bool{}
	call := func(want int, route, id, body string) map[string]any {
		t.Helper()
		if !slices.Contains(RemoteRoutes, route) {
			t.Fatalf("%s is no route of the table", route)
		}
		called[route] = true
		method, p, _ := strings.Cut(route, " ")
		p = strings.Replace(strings.Replace(p, "{server}", "local", 1), "{id}", id, 1)
		status, got := l.library(method, p, body)
		if status != want {
			t.Fatalf("%s %s: %d %v, want %d", method, p, status, got, want)
		}
		return got
	}
	// own reads the next "own_library" event of an API client.
	own := func(c *bridgetest.Page) string {
		t.Helper()
		for {
			if raw := c.NextRaw(); typeOf(raw) == "own_library" {
				return libraryPaths(ownLibrary(t, raw))
			}
		}
	}

	git := call(200, "POST /api/library/{server}/groups", "", form("name", "git", "parent", ""))["group"].(map[string]any)["id"].(string)
	const one = "git/"
	if a, b := own(x), own(y); a != one || b != one {
		t.Fatalf("after the group the clients were sent %q and %q", a, b)
	}
	review := call(200, "POST /api/library/{server}/prompts", "", form("name", "review", "parent", git, "text", "Look at it.\nTwice."))["prompt"].(map[string]any)["id"].(string)
	const two = "git/ | git/review=Look at it.\nTwice."
	if a, b := own(x), own(y); a != two || b != two {
		t.Fatalf("after the prompt the clients were sent %q and %q", a, b)
	}
	// The list of an API client is the server's own library: without the notice.
	list := call(200, "GET /api/library", "", "")
	if raw, _ := json.Marshal(list); strings.Contains(string(raw), "notice") || strings.Contains(string(raw), root) {
		t.Fatalf("the list of an API client: %s", raw)
	}
	if libs := decode[libraryList](t, func() string { _, out := l.call(apiX, testSecret, "GET", "/api/library", ""); return out }()).Libraries; len(libs) != 1 || libs[0].Server != "local" || !libs[0].Connected || libraryPaths(libs[0]) != two {
		t.Fatalf("the list of an API client: %+v", libs)
	}
	if got := call(200, "PATCH /api/library/{server}/groups/{id}", git, form("name", "Git"))["group"].(map[string]any); got["name"] != "Git" {
		t.Fatalf("the renamed group: %v", got)
	}
	if got := call(200, "PATCH /api/library/{server}/prompts/{id}", review, form("text", "Look again."))["prompt"].(map[string]any); got["text"] != "Look again." || got["name"] != "review" {
		t.Fatalf("the changed prompt: %v", got)
	}
	const changed = "Git/ | Git/review=Look again."
	own(x)
	own(y)
	if a, b := own(x), own(y); a != changed || b != changed {
		t.Fatalf("after the changes the clients were sent %q and %q", a, b)
	}
	// It is the owner's library: the owner's page has every change, as "library" events of its
	// own computer, and is sent nothing of the API clients' kind.
	e.wantLibrary(changed)
	evs := e.reach(owner)[0]
	if n := len(only(evs, "library")); n != 4 || len(only(evs, "own_library")) != 0 {
		t.Fatalf("the owner's page was sent %v", types(evs))
	}

	// The rules of section 3, broken by a caller that is no popup: each one is refused by the
	// server, with a sentence and its code, and nothing changes.
	for _, c := range []struct {
		what, route, id, body string
		status                int
		code                  string
	}{
		{"a name that is taken, in another case", "POST /api/library/{server}/prompts", "", form("name", "REVIEW", "parent", git, "text", ""), 409, library.CodeNameTaken},
		{"a group with a prompt's name", "POST /api/library/{server}/groups", "", form("name", "Review", "parent", git), 409, library.CodeNameTaken},
		{"a name with a slash", "POST /api/library/{server}/groups", "", form("name", "a/b", "parent", ""), 400, library.CodeBadName},
		{"an empty name", "PATCH /api/library/{server}/prompts/{id}", review, form("name", "  "), 400, library.CodeBadName},
		{"a name of 81 characters", "PATCH /api/library/{server}/groups/{id}", git, form("name", strings.Repeat("n", 81)), 400, library.CodeBadName},
		{"a group moved into itself", "PATCH /api/library/{server}/groups/{id}", git, form("parent", git), 409, library.CodeBadMove},
		{"a group that is not there", "POST /api/library/{server}/prompts", "", form("name", "x", "parent", "g_000000000000", "text", ""), 404, library.CodeNoGroup},
		{"a prompt that is not there", "DELETE /api/library/{server}/prompts/{id}", "p_000000000000", "", 404, library.CodeNotFound},
		{"a text that is too long", "PATCH /api/library/{server}/prompts/{id}", review, form("text", strings.Repeat("t", library.MaxText+1)), 413, library.CodeTextTooLong},
	} {
		if got := call(c.status, c.route, c.id, c.body); got["code"] != c.code || got["error"] == "" {
			t.Errorf("%s: %v, want the code %s and a sentence", c.what, got, c.code)
		}
	}
	e.wantLibrary(changed)
	// An API client reaches this server's own library and no other, whatever it names.
	for _, server := range []string{"s_1", "nobody", testAPIClient} {
		if status, got := l.library("POST", "/api/library/"+server+"/groups", form("name", "x")); status != 404 || got["code"] != CodeNoServer {
			t.Errorf("a call for the library of %q: %d %v", server, status, got)
		}
	}

	// The owner changes it: both clients get it, and the page its own event.
	e.newPrompt("commit", "", "Write it.")
	const three = "Git/ | Git/review=Look again. | commit=Write it."
	if a, b := own(x), own(y); a != three || b != three {
		t.Fatalf("after the owner's prompt the clients were sent %q and %q", a, b)
	}
	// A stream that starts now begins with the library as it is.
	y.Close()
	_, snapY = l.api(apiY)
	if got := libraryPaths(ownLibrary(t, snapY)); got != three {
		t.Fatalf("the library of a later snapshot: %q", got)
	}

	call(200, "DELETE /api/library/{server}/prompts/{id}", review, "")
	call(200, "DELETE /api/library/{server}/groups/{id}", git, "")
	e.wantLibrary("commit=Write it.")
	for _, route := range RemoteRoutes {
		if isLibraryRoute(route) && !called[route] {
			t.Errorf("the route %s of the table was not called", route)
		}
	}
	if !strings.Contains(snapX, `"library":{"groups":[],"prompts":[]}`) {
		t.Errorf("the first snapshot: %s", snapX)
	}
}

// A server without a library tells its API clients so, and refuses the calls.
func TestNoLibraryForAnAPIClient(t *testing.T) {
	t.Parallel()
	_, l := remoteEnv(t)
	if _, snap := l.api(apiX); !strings.Contains(snap, `"library":null`) {
		t.Fatalf("the snapshot: %s", snap)
	}
	if status, got := l.library("GET", "/api/library", ""); status != 200 || len(got["libraries"].([]any)) != 0 {
		t.Fatalf("the list: %d %v", status, got)
	}
	if status, got := l.library("POST", "/api/library/local/groups", form("name", "x")); status != 404 || got["code"] != CodeNoServer {
		t.Fatalf("a call: %d %v", status, got)
	}
}

// ---- two servers ----

// libraryPair is a pair whose two servers have a library each. seed fills B's before A connects.
type libraryPair struct {
	*pair
	rootA, rootB string
}

func newLibraryPair(t *testing.T, seed func(l *library.Store)) *libraryPair {
	t.Helper()
	lp := &libraryPair{rootA: t.TempDir(), rootB: t.TempDir()}
	seeded := func(s *Server) {
		if seed != nil {
			seed(s.App.Library)
		}
	}
	lp.pair = newPairWith(t, remotes.Limits{},
		[]func(*Server){withLibrary(t, lp.rootA)},
		[]func(*Server){withLibrary(t, lp.rootB), seeded})
	return lp
}

// seedGit makes the group "git" with the prompt "review" in it.
func seedGit(t *testing.T) func(l *library.Store) {
	return func(l *library.Store) {
		g, err := l.CreateGroup("git", "")
		if err == nil {
			_, err = l.CreatePrompt("review", g.ID, "Look at it.\nTwice.")
		}
		if err != nil {
			t.Fatal(err)
		}
	}
}

const gitSeed = "git/ | git/review=Look at it.\nTwice."

// viewIn is the library of this server in a list.
func viewIn(list []library.View, server string) (library.View, bool) {
	for _, v := range list {
		if v.Server == server {
			return v, true
		}
	}
	return library.View{}, false
}

// there is B's library as A has it now.
func (lp *libraryPair) there() library.View {
	lp.t.Helper()
	list := lp.a.libraries()
	v, ok := viewIn(list, lp.entry)
	if !ok || len(list) != 2 || list[0].Server != "local" || list[1].Server != lp.entry {
		lp.t.Fatalf("A's libraries: %+v", list)
	}
	return v
}

// libraryEvent reads the page's events up to the next "library" event of this server that is
// good, and returns its library.
func (lp *libraryPair) libraryEvent(p *bridgetest.Page, server string, good func(v library.View) bool) library.View {
	lp.t.Helper()
	var got library.View
	lp.event(p, "library", func(ev map[string]any) bool {
		raw, _ := json.Marshal(ev["library"])
		var v library.View
		if json.Unmarshal(raw, &v) != nil || v.Server != server || !good(v) {
			return false
		}
		got = v
		return true
	})
	return got
}

func (lp *libraryPair) path(rest string) string { return "/api/library/" + lp.entry + rest }

// noFileHolds fails when a file under root holds text.
func noFileHolds(t *testing.T, root, text string) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(path)
		if err == nil && strings.Contains(string(b), text) {
			t.Errorf("the file %s holds %q", path, text)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
}

// Lines 19, 21 and 25: with a remote server connected, its library is in the list of the
// libraries after this computer's, under the server's name, in the page's snapshot and in the
// list; a change its owner makes arrives at the page by itself; and a server with another name
// shows that name. Without a remote server the list is this computer's alone (TestLibraryRoutes).
func TestRemoteLibraryIsShown(t *testing.T) {
	t.Parallel()
	lp := newLibraryPair(t, seedGit(t))
	if v := lp.there(); v.Name != "Studio" || !v.Connected || v.Notice != "" || libraryPaths(v) != gitSeed {
		t.Fatalf("B's library on A: %+v", v)
	}
	p := bridgetest.Connect(t, lp.a.url, "P")
	raw, _ := json.Marshal(p.Welcome()["libraries"])
	var snap []library.View
	if err := json.Unmarshal(raw, &snap); err != nil || len(snap) != 2 || snap[0].Server != "local" || libraryPaths(snap[0]) != "" ||
		snap[1].Server != lp.entry || snap[1].Name != "Studio" || !snap[1].Connected || libraryPaths(snap[1]) != gitSeed {
		t.Fatalf("the libraries of the page's snapshot: %s", raw)
	}

	// The owner works in their own app.
	git := lp.b.local().Groups[0]
	lp.b.newPrompt("commit message", git.ID, "Write it.")
	const more = "git/ | git/commit message=Write it. | git/review=Look at it.\nTwice."
	if v := lp.libraryEvent(p, lp.entry, func(library.View) bool { return true }); libraryPaths(v) != more || v.Name != "Studio" || !v.Connected {
		t.Fatalf("after the owner's prompt the page was sent %+v", v)
	}
	lp.b.expect(200, "DELETE", localLibrary+"/prompts/"+lp.b.local().Prompts[0].ID, "")
	const less = "git/ | git/commit message=Write it."
	if v := lp.libraryEvent(p, lp.entry, func(library.View) bool { return true }); libraryPaths(v) != less {
		t.Fatalf("after the owner's delete the page was sent %+v", v)
	}
	if v := lp.there(); libraryPaths(v) != less {
		t.Fatalf("B's library on A: %+v", v)
	}

	// The server gets another name in the list: its library is shown under it.
	do(t, p, "PATCH", "/api/servers/"+lp.entry, obj{"name": "Workshop"})
	if v := lp.libraryEvent(p, lp.entry, func(v library.View) bool { return v.Name == "Workshop" }); libraryPaths(v) != less || !v.Connected {
		t.Fatalf("after the rename the page was sent %+v", v)
	}
	if v := lp.there(); v.Name != "Workshop" {
		t.Fatalf("B's library on A after the rename: %+v", v)
	}
	// What is B's stays B's: nothing of it is in a file of A, and A's own library is empty.
	noFileHolds(t, lp.rootA, "commit message")
	noFileHolds(t, lp.root, "commit message")
	if own, _ := viewIn(lp.a.libraries(), "local"); libraryPaths(own) != "" {
		t.Fatalf("A's own library: %+v", own)
	}
}

// Line 20, and line 26 through another server: a prompt and a group created, changed and
// deleted on a remote server from this app are changed there; the owner's page and a second
// client get the change by themselves; the page that asked has it before its call returns; and
// what breaks a rule is refused by the library's own server, with that server's sentence.
func TestRemoteLibraryIsChangedFromHere(t *testing.T) {
	t.Parallel()
	lp := newLibraryPair(t, seedGit(t))
	p := lp.a.page("P")
	owner := lp.b.page("owner")
	second, _ := lp.l.api(apiY) // another app that has B in its list
	git := lp.there().Groups[0]

	// now is B's library on A at this moment: a call that returned needs no wait and no read.
	now := func(what, want string) {
		t.Helper()
		if got := libraryPaths(lp.there()); got != want {
			t.Fatalf("%s, B's library on A is %s\nwant %s", what, got, want)
		}
		if got := libraryPaths(lp.b.local()); got != want {
			t.Fatalf("%s, B's library is %s\nwant %s", what, got, want)
		}
	}
	hooks := decode[groupReply](t, string(do(t, p, "POST", lp.path("/groups"), obj{"name": " hooks ", "parent": git.ID}))).Group
	if hooks.Name != "hooks" || hooks.Parent != git.ID || !library.IsGroupID(hooks.ID) {
		t.Fatalf("the group A's page got: %+v", hooks)
	}
	now("after the group", "git/ | git/hooks/ | git/review=Look at it.\nTwice.")
	commit := decode[promptReply](t, string(do(t, p, "POST", lp.path("/prompts"), obj{"name": "commit", "parent": hooks.ID, "text": "Write it.\n"}))).Prompt
	if commit.Name != "commit" || commit.Parent != hooks.ID || commit.Text != "Write it.\n" {
		t.Fatalf("the prompt A's page got: %+v", commit)
	}
	now("after the prompt", "git/ | git/hooks/ | git/hooks/commit=Write it.\n | git/review=Look at it.\nTwice.")
	if got := decode[promptReply](t, string(do(t, p, "PATCH", lp.path("/prompts/"+commit.ID), obj{"name": "Commit", "parent": "", "text": "Better."}))).Prompt; got.Name != "Commit" || got.Parent != "" || got.Text != "Better." {
		t.Fatalf("the changed prompt: %+v", got)
	}
	if got := decode[groupReply](t, string(do(t, p, "PATCH", lp.path("/groups/"+hooks.ID), obj{"name": "Hooks", "parent": ""}))).Group; got.Name != "Hooks" || got.Parent != "" {
		t.Fatalf("the changed group: %+v", got)
	}
	const moved = "Commit=Better. | Hooks/ | git/ | git/review=Look at it.\nTwice."
	now("after the changes", moved)
	// A change that changes nothing is answered too, with no event to wait for.
	do(t, p, "PATCH", lp.path("/prompts/"+commit.ID), obj{"text": "Better."})

	// Each of the four changes reached A's page, the owner's page and the second client.
	last := func(c *bridgetest.Page, typ string) string {
		t.Helper()
		evs := only(lp.b.reach(c)[0], typ)
		if len(evs) != 4 {
			t.Fatalf("%s was sent %d %s events, want 4", c.ID, len(evs), typ)
		}
		v := ownLibrary(t, evs[3])
		if typ == "library" {
			v = decode[library.Event](t, evs[3]).Library
		}
		return libraryPaths(v)
	}
	if got := last(owner, "library"); got != moved {
		t.Fatalf("the owner's page has %s", got)
	}
	if got := last(second, "own_library"); got != moved {
		t.Fatalf("the second client has %s", got)
	}
	if v := lp.libraryEvent(p, lp.entry, func(v library.View) bool { return libraryPaths(v) == moved }); !v.Connected || v.Name != "Studio" {
		t.Fatalf("A's page was sent %+v", v)
	}

	// The rules are B's: A hands on what B refused, with B's sentence and code.
	for _, c := range []struct {
		what, method, path string
		body               obj
		status             int
		code, text         string
	}{
		{"a name that is taken", "POST", "/prompts", obj{"name": "COMMIT", "parent": "", "text": ""}, 409, library.CodeNameTaken, `There is already a prompt called "Commit" at the top of the library.`},
		{"a name with a slash", "PATCH", "/groups/" + hooks.ID, obj{"name": "a/b"}, 400, library.CodeBadName, `A name cannot contain "/".`},
		{"an empty name", "POST", "/groups", obj{"name": "", "parent": ""}, 400, library.CodeBadName, "A name cannot be empty."},
		{"a group moved into itself", "PATCH", "/groups/" + hooks.ID, obj{"parent": hooks.ID}, 409, library.CodeBadMove, "A group cannot be moved into itself."},
		{"a group that is gone", "POST", "/prompts", obj{"name": "x", "parent": "g_000000000000", "text": ""}, 404, library.CodeNoGroup, "The group it should be in no longer exists."},
		{"a prompt that is gone", "PATCH", "/prompts/p_000000000000", obj{"text": "x"}, 404, library.CodeNotFound, "This prompt no longer exists."},
		{"an id that is none", "DELETE", "/groups/G_1%2F..%2Fx", nil, 404, library.CodeNotFound, "This group no longer exists."},
		{"a text that is too long", "PATCH", "/prompts/" + commit.ID, obj{"text": strings.Repeat("t", library.MaxText+1)}, 413, library.CodeTextTooLong, "The text of a prompt can have at most 100,000 characters."},
	} {
		status, out := p.Do(c.method, lp.path(c.path), c.body)
		if got := lp.refusal(c.what, c.status, c.code, status, out); got["error"] != c.text {
			t.Errorf("%s: the sentence %q, want %q", c.what, got["error"], c.text)
		}
	}
	now("after the refusals", moved)
	// The known-client rule of A's own port covers the calls for another server's library too.
	if status, out := lp.a.doAs("nobody", "POST", lp.path("/groups"), `{"name":"x"}`); status != 409 || !strings.Contains(out, "unknown_client") {
		t.Fatalf("a call of an unknown client: %d %s", status, out)
	}

	do(t, p, "DELETE", lp.path("/prompts/"+commit.ID), nil)
	do(t, p, "DELETE", lp.path("/groups/"+git.ID), nil)
	now("after the deletes", "Hooks/")

	// The two libraries stay apart: what is made in A's own is not B's, and B's library is in
	// B's file alone.
	lp.a.newPrompt("mine", "", "Only here.")
	if got := libraryPaths(lp.b.local()); got != "Hooks/" {
		t.Fatalf("B's library after a prompt in A's own: %s", got)
	}
	if own, _ := viewIn(lp.a.libraries(), "local"); libraryPaths(own) != "mine=Only here." {
		t.Fatalf("A's own library: %+v", own)
	}
	noFileHolds(t, lp.rootA, "Hooks")
	noFileHolds(t, lp.root, "Hooks")
	noFileHolds(t, lp.rootB, "Only here.")
	if b, err := os.ReadFile(filepath.Join(lp.rootB, library.FileName)); err != nil || !strings.Contains(string(b), `"Hooks"`) {
		t.Fatalf("B's file: %s, %v", b, err)
	}
}

// Line 22: when the server stops answering, its prompts are still listed, marked not connected,
// and cannot be changed; when it is back they are the server's as they are then, and can.
func TestRemoteLibraryOfAServerThatDrops(t *testing.T) {
	t.Parallel()
	lp := newLibraryPair(t, seedGit(t))
	p := lp.a.page("P")
	git := lp.there().Groups[0]

	lp.cut()
	if v := lp.libraryEvent(p, lp.entry, func(v library.View) bool { return !v.Connected }); libraryPaths(v) != gitSeed || v.Name != "Studio" {
		t.Fatalf("after the drop the page was sent %+v", v)
	}
	if v := lp.there(); v.Connected || libraryPaths(v) != gitSeed {
		t.Fatalf("B's library on A after the drop: %+v", v)
	}
	// A page that opens now has the copy, marked.
	q := bridgetest.Connect(t, lp.a.url, "Q")
	if raw, _ := json.Marshal(q.Welcome()["libraries"]); !strings.Contains(string(raw), `"connected":false`) || !strings.Contains(string(raw), `"name":"review"`) {
		t.Fatalf("the libraries of a later snapshot: %s", raw)
	}
	for _, c := range []struct {
		method, path string
		body         obj
	}{
		{"POST", "/groups", obj{"name": "new"}},
		{"POST", "/prompts", obj{"name": "new", "text": "x"}},
		{"PATCH", "/groups/" + git.ID, obj{"name": "Git"}},
		{"DELETE", "/groups/" + git.ID, nil},
		{"PATCH", "/prompts/" + lp.there().Prompts[0].ID, obj{"text": "changed"}},
		{"DELETE", "/prompts/" + lp.there().Prompts[0].ID, nil},
	} {
		status, out := p.Do(c.method, lp.path(c.path), c.body)
		if got := lp.refusal(c.method+" "+c.path, 503, "server_unreachable", status, out); got["error"] != "Studio is not connected: its prompts cannot be changed until it is back." {
			t.Errorf("%s %s: the sentence %q", c.method, c.path, got["error"])
		}
	}
	// The owner goes on meanwhile.
	lp.b.newPrompt("commit", "", "Write it.")
	if v := lp.there(); v.Connected || libraryPaths(v) != gitSeed {
		t.Fatalf("B's library on A while B cannot be reached: %+v", v)
	}

	lp.mend()
	const back = "commit=Write it. | git/ | git/review=Look at it.\nTwice."
	if v := lp.libraryEvent(p, lp.entry, func(v library.View) bool { return v.Connected }); libraryPaths(v) != back {
		t.Fatalf("after the return the page was sent %+v", v)
	}
	do(t, p, "PATCH", lp.path("/groups/"+git.ID), obj{"name": "Git"})
	if v := lp.there(); !v.Connected || libraryPaths(v) != "Git/ | Git/review=Look at it.\nTwice. | commit=Write it." {
		t.Fatalf("B's library on A after a change: %+v", v)
	}
}

// Line 23: a server that is removed from the list takes its library along.
func TestRemoteLibraryOfAServerThatIsRemoved(t *testing.T) {
	t.Parallel()
	lp := newLibraryPair(t, seedGit(t))
	p := lp.a.page("P")
	lp.there()
	do(t, p, "DELETE", "/api/servers/"+lp.entry, nil)
	lp.event(p, "library_removed", func(ev map[string]any) bool { return ev["server"] == lp.entry })
	if list := lp.a.libraries(); len(list) != 1 || list[0].Server != "local" {
		t.Fatalf("A's libraries after the removal: %+v", list)
	}
	status, out := p.Do("POST", lp.path("/groups"), obj{"name": "x"})
	lp.refusal("a call for the library of a removed server", 404, CodeNoServer, status, out)
	if got := libraryPaths(lp.b.local()); got != gitSeed {
		t.Fatalf("B's library after A removed B: %s", got)
	}
}
