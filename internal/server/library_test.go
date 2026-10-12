package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/library"
)

// The routes of the prompt library against the real handler: what a page reads and gets on its
// stream, and the rules of the library (section 3 of the goal), which the server checks for
// every caller. The rules themselves are tested one by one in package library; here each is
// broken once through a route, by a caller that is not the popup.

// withLibrary gives the server this computer's library in the folder root, as serve does.
func withLibrary(t *testing.T, root string) func(*Server) {
	return func(s *Server) {
		if err := s.App.OpenLibrary(root); err != nil {
			t.Fatal(err)
		}
	}
}

const localLibrary = "/api/library/local"

// libraries reads GET /api/library.
func (e *env) libraries() []library.View {
	e.t.Helper()
	return decode[libraryList](e.t, e.expect(200, "GET", "/api/library", "")).Libraries
}

// local is this computer's library, which is the first and for now the only one of the list.
func (e *env) local() library.View {
	e.t.Helper()
	l := e.libraries()
	if len(l) != 1 || l[0].Server != "local" || l[0].Name != "This computer" || !l[0].Connected || l[0].Groups == nil || l[0].Prompts == nil {
		e.t.Fatalf("the libraries: %+v", l)
	}
	return l[0]
}

// libraryPaths lists a library as the paths of its groups ("git/") and prompts ("git/name=text"),
// sorted.
func libraryPaths(v library.View) string {
	byID := map[string]library.Group{}
	for _, g := range v.Groups {
		byID[g.ID] = g
	}
	var path func(id string) string
	path = func(id string) string {
		if id == "" {
			return ""
		}
		return path(byID[id].Parent) + byID[id].Name + "/"
	}
	out := []string{}
	for _, g := range v.Groups {
		out = append(out, path(g.ID))
	}
	for _, p := range v.Prompts {
		out = append(out, path(p.Parent)+p.Name+"="+p.Text)
	}
	sort.Strings(out)
	return strings.Join(out, " | ")
}

func (e *env) wantLibrary(want string) {
	e.t.Helper()
	if got := libraryPaths(e.local()); got != want {
		e.t.Fatalf("the library: %s\nwant:        %s", got, want)
	}
}

func (e *env) newGroup(name, parent string) library.Group {
	e.t.Helper()
	return decode[groupReply](e.t, e.expect(200, "POST", localLibrary+"/groups", form("name", name, "parent", parent))).Group
}

func (e *env) newPrompt(name, parent, text string) library.Prompt {
	e.t.Helper()
	return decode[promptReply](e.t, e.expect(200, "POST", localLibrary+"/prompts", form("name", name, "parent", parent, "text", text))).Prompt
}

// Lines 1 and 4 of section 10 through the routes: a group, a prompt in it and a group in that
// group are created, renamed, moved and deleted, a deleted group takes everything in it along,
// and all of it is there after the server restarts.
func TestLibraryRoutes(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	e := newEnv(t, withLibrary(t, root))
	e.wantLibrary("")

	git := e.newGroup("git", "")
	commit := e.newPrompt("commit message", git.ID, "Write a commit message.\n\nKeep it short.")
	hooks := e.newGroup("hooks", git.ID)
	if git.ID == "" || git.Parent != "" || commit.Parent != git.ID || commit.Text != "Write a commit message.\n\nKeep it short." || hooks.Parent != git.ID {
		t.Fatalf("made %+v, %+v, %+v", git, commit, hooks)
	}
	const made = "git/ | git/commit message=Write a commit message.\n\nKeep it short. | git/hooks/"
	e.wantLibrary(made)
	// The page's snapshot has the same list.
	var snap struct{ Libraries []library.View }
	if json.Unmarshal([]byte(e.expect(200, "GET", "/api/state", "")), &snap) != nil || len(snap.Libraries) != 1 || libraryPaths(snap.Libraries[0]) != made {
		t.Fatalf("the snapshot's libraries: %+v", snap.Libraries)
	}

	// Renamed, and the prompt's text changed; a field that is left out stays.
	g := decode[groupReply](t, e.expect(200, "PATCH", localLibrary+"/groups/"+git.ID, `{"name":"Git"}`)).Group
	if g.ID != git.ID || g.Name != "Git" || g.Parent != "" {
		t.Fatalf("the renamed group: %+v", g)
	}
	e.expect(200, "PATCH", localLibrary+"/groups/"+hooks.ID, `{"name":"pre-commit"}`)
	p := decode[promptReply](t, e.expect(200, "PATCH", localLibrary+"/prompts/"+commit.ID, `{"name":"message"}`)).Prompt
	if p.ID != commit.ID || p.Name != "message" || p.Parent != git.ID || p.Text != commit.Text {
		t.Fatalf("the renamed prompt: %+v", p)
	}
	p = decode[promptReply](t, e.expect(200, "PATCH", localLibrary+"/prompts/"+commit.ID, `{"text":"Shorter."}`)).Prompt
	if p.Name != "message" || p.Text != "Shorter." {
		t.Fatalf("the prompt with a new text: %+v", p)
	}
	e.wantLibrary("Git/ | Git/message=Shorter. | Git/pre-commit/")

	// Moved: the prompt into the inner group, the inner group to the top, the outer one into it.
	p = decode[promptReply](t, e.expect(200, "PATCH", localLibrary+"/prompts/"+commit.ID, form("parent", hooks.ID))).Prompt
	if p.Parent != hooks.ID || p.Name != "message" || p.Text != "Shorter." {
		t.Fatalf("the moved prompt: %+v", p)
	}
	e.expect(200, "PATCH", localLibrary+"/groups/"+hooks.ID, `{"parent":""}`)
	e.expect(200, "PATCH", localLibrary+"/groups/"+git.ID, form("parent", hooks.ID))
	const moved = "pre-commit/ | pre-commit/Git/ | pre-commit/message=Shorter."
	e.wantLibrary(moved)

	// After a restart: a second server on the same data folder.
	again := newEnv(t, withLibrary(t, root))
	again.wantLibrary(moved)
	if n := again.local().Notice; n != "" {
		t.Fatalf("the notice after a restart: %q", n)
	}

	// Deleted: a prompt, and a group with what is in it.
	top := again.newPrompt("top", "", "stays")
	again.newPrompt("deep", git.ID, "goes")
	if out := again.expect(200, "DELETE", localLibrary+"/prompts/"+commit.ID, ""); !decode[struct{ OK bool }](t, out).OK {
		t.Fatalf("the delete's answer: %s", out)
	}
	again.wantLibrary("pre-commit/ | pre-commit/Git/ | pre-commit/Git/deep=goes | top=stays")
	again.expect(200, "DELETE", localLibrary+"/groups/"+hooks.ID, "")
	again.wantLibrary("top=stays")
	last := newEnv(t, withLibrary(t, root))
	last.wantLibrary("top=stays")
	last.expect(200, "DELETE", localLibrary+"/prompts/"+top.ID, "")
	newEnv(t, withLibrary(t, root)).wantLibrary("")
}

// Lines 2, 3, 5 and 6: a call that breaks a rule is refused by the server whoever sends it, with
// a sentence and a code, and changes nothing.
func TestLibraryRoutesRefuseWhatBreaksARule(t *testing.T) {
	t.Parallel()
	e := newEnv(t, withLibrary(t, t.TempDir()))
	git := e.newGroup("git", "")
	inner := e.newGroup("inner", git.ID)
	misc := e.newGroup("misc", "")
	review := e.newPrompt("Review", git.ID, "one")
	const before = "git/ | git/Review=one | git/inner/ | misc/"
	groups, prompts := localLibrary+"/groups", localLibrary+"/prompts"

	refused := func(status int, code, says, method, path, body string) {
		t.Helper()
		msg := e.refusedWith(status, code, method, path, body)
		if !strings.Contains(msg, says) || !strings.HasSuffix(msg, ".") {
			t.Fatalf("%s %s %s: refused with %q, want a sentence with %q", method, path, body, msg, says)
		}
		e.wantLibrary(before)
	}

	// Line 2: a name of the group, also when only the case differs, for a prompt and for a group.
	for _, name := range []string{"Review", "review", "REVIEW"} {
		refused(409, "name_taken", `"Review"`, "POST", prompts, form("name", name, "parent", git.ID, "text", "two"))
		refused(409, "name_taken", `"Review"`, "POST", groups, form("name", name, "parent", git.ID))
	}
	refused(409, "name_taken", `"inner"`, "PATCH", prompts+"/"+review.ID, `{"name":"INNER"}`)
	refused(409, "name_taken", `"git"`, "PATCH", groups+"/"+misc.ID, `{"name":"Git"}`)
	refused(409, "name_taken", "at the top", "PATCH", groups+"/"+inner.ID, `{"name":"MISC","parent":""}`)

	// Line 3: a name with "/", an empty one and one of more than 80 characters.
	long := strings.Repeat("n", 81)
	for name, says := range map[string]string{"a/b": `"/"`, "": "empty", "  ": "empty", long: "80 characters", "a\nb": "line break"} {
		refused(400, "bad_name", says, "POST", groups, form("name", name))
		refused(400, "bad_name", says, "POST", prompts, form("name", name, "parent", git.ID, "text", "t"))
		refused(400, "bad_name", says, "PATCH", groups+"/"+git.ID, form("name", name))
		refused(400, "bad_name", says, "PATCH", prompts+"/"+review.ID, form("name", name, "text", "not saved either"))
	}
	refused(400, "bad_name", "empty", "POST", groups, `{}`) // no name at all

	// Line 5: a group into itself or below itself.
	refused(409, "bad_move", "into itself", "PATCH", groups+"/"+git.ID, form("parent", git.ID))
	refused(409, "bad_move", "below it", "PATCH", groups+"/"+git.ID, form("parent", inner.ID))

	// What is not there: the item of the call (deleted meanwhile), and the group it should go to.
	refused(404, "not_found", "prompt no longer exists", "PATCH", prompts+"/p_000000000000", `{"text":"x"}`)
	refused(404, "not_found", "prompt no longer exists", "DELETE", prompts+"/"+git.ID, "")
	refused(404, "not_found", "group no longer exists", "PATCH", groups+"/g_000000000000", `{"name":"x"}`)
	refused(404, "not_found", "group no longer exists", "DELETE", groups+"/"+review.ID, "")
	refused(404, "no_group", "no longer exists", "POST", prompts, form("name", "x", "parent", "g_000000000000"))
	refused(404, "no_group", "no longer exists", "PATCH", prompts+"/"+review.ID, form("parent", review.ID))

	// The sizes: a text past its limit, and a body past the route's.
	refused(413, "text_too_long", "100,000 characters", "PATCH", prompts+"/"+review.ID, form("text", strings.Repeat("x", library.MaxText+1)))
	refused(413, "text_too_long", "more than a prompt can hold", "POST", prompts, form("name", "big", "text", strings.Repeat("x", libraryBodyMax)))

	// A body that is no JSON, and a field of another type.
	for _, body := range []string{"", "nonsense", `{"name":7}`, `[]`} {
		if code, out := e.do("POST", prompts, body); code != 400 {
			t.Fatalf("POST %q: %d %s", body, code, out)
		}
	}
	e.wantLibrary(before)

	// The same name in another group is accepted (line 2), and so is a name of 80 characters.
	e.newPrompt("review", misc.ID, "three")
	e.newPrompt("Review", "", "four")
	e.newGroup(long[:80], misc.ID)
	e.wantLibrary("Review=four | " + before + " | misc/" + long[:80] + "/ | misc/review=three")
}

// The calls that change a library need a known client, as every write on this port; the read
// does not.
func TestLibraryChangesNeedAKnownClient(t *testing.T) {
	t.Parallel()
	e := newEnv(t, withLibrary(t, t.TempDir()))
	g := e.newGroup("g", "")
	p := e.newPrompt("p", g.ID, "text")
	for _, client := range []string{"", "B"} {
		for _, c := range [][3]string{
			{"POST", "/groups", `{"name":"x"}`},
			{"POST", "/prompts", `{"name":"x"}`},
			{"PATCH", "/groups/" + g.ID, `{"name":"x"}`},
			{"PATCH", "/prompts/" + p.ID, `{"text":"x"}`},
			{"DELETE", "/groups/" + g.ID, ""},
			{"DELETE", "/prompts/" + p.ID, ""},
		} {
			code, out := e.doAs(client, c[0], localLibrary+c[1], c[2])
			if code != 409 || decode[map[string]string](t, out)["error"] != "unknown_client" {
				t.Fatalf("%s %s from the client %q: %d %s", c[0], c[1], client, code, out)
			}
		}
	}
	if code, out := e.doAs("", "GET", "/api/library", ""); code != 200 || libraryPaths(decode[libraryList](t, out).Libraries[0]) != "g/ | g/p=text" {
		t.Fatalf("the read without a client: %d %s", code, out)
	}
}

// Every change reaches every open window on its stream, as the whole library of the server that
// changed; a call that changes nothing sends nothing.
func TestLibraryChangesReachEveryPage(t *testing.T) {
	t.Parallel()
	e := newEnv(t, withLibrary(t, t.TempDir()))
	e.newGroup("before", "")
	b, c := bridgetest.Connect(t, e.url, "B"), bridgetest.Connect(t, e.url, "C")
	for _, p := range []*bridgetest.Page{b, c} {
		raw, _ := json.Marshal(p.Welcome()["libraries"])
		if l := decode[[]library.View](t, string(raw)); len(l) != 1 || libraryPaths(l[0]) != "before/" {
			t.Fatalf("page %s: the libraries of the stream's snapshot: %s", p.ID, raw)
		}
	}
	// event reads the next event of both pages: the library after the change.
	event := func(want string) {
		t.Helper()
		for _, p := range []*bridgetest.Page{b, c} {
			raw := p.NextRaw()
			ev := decode[library.Event](t, raw)
			if v := ev.Library; ev.Type != "library" || v.Server != "local" || v.Name != "This computer" || !v.Connected || libraryPaths(v) != want {
				t.Fatalf("page %s got %s\nwant the library %s", p.ID, raw, want)
			}
		}
	}
	do := func(p *bridgetest.Page, method, path string, body any) []byte {
		t.Helper()
		status, out := p.Do(method, path, body)
		if status != 200 {
			t.Fatalf("%s %s: %d %s", method, path, status, out)
		}
		return out
	}

	g := decode[groupReply](t, string(do(b, "POST", localLibrary+"/groups", `{"name":"git"}`))).Group
	event("before/ | git/")
	p := decode[promptReply](t, string(do(c, "POST", localLibrary+"/prompts", library.NewPrompt{Name: "review", Parent: g.ID, Text: "one"}))).Prompt
	event("before/ | git/ | git/review=one")
	// Two windows save the same prompt: the later save wins.
	do(b, "PATCH", localLibrary+"/prompts/"+p.ID, `{"text":"from B"}`)
	do(c, "PATCH", localLibrary+"/prompts/"+p.ID, `{"text":"from C"}`)
	event("before/ | git/ | git/review=from B")
	event("before/ | git/ | git/review=from C")
	do(c, "PATCH", localLibrary+"/groups/"+g.ID, `{"name":"Git","parent":""}`)
	event("Git/ | Git/review=from C | before/")
	do(b, "DELETE", localLibrary+"/groups/"+g.ID, nil)
	event("before/")

	// Nothing for a save that changes nothing, a refused call or a read.
	do(b, "PATCH", localLibrary+"/groups/"+e.local().Groups[0].ID, `{"name":"before"}`)
	b.Do("POST", localLibrary+"/groups", `{"name":"a/b"}`)
	do(c, "GET", "/api/library", nil)
	b.ExpectNone(200 * time.Millisecond)
	c.ExpectNone(0)
}

// A library is named by its server's id in every changing call. This computer's is the only one
// here: a call for another server is refused, and a server without a library has an empty list.
func TestLibraryOfAnotherServer(t *testing.T) {
	t.Parallel()
	e := newEnv(t, withLibrary(t, t.TempDir()))
	g := e.newGroup("g", "")
	for _, server := range []string{noSuchServer, "LOCAL", "this computer"} {
		at := "/api/library/" + strings.ReplaceAll(server, " ", "%20")
		for _, c := range [][3]string{
			{"POST", "/groups", `{"name":"x"}`},
			{"POST", "/prompts", `{"name":"x"}`},
			{"PATCH", "/groups/" + g.ID, `{"name":"x"}`},
			{"DELETE", "/groups/" + g.ID, ""},
			{"DELETE", "/prompts/p_000000000000", ""},
		} {
			e.refusedWith(404, CodeNoServer, c[0], at+c[1], c[2])
		}
	}
	e.wantLibrary("g/")

	none := newEnv(t)
	if l := none.libraries(); l == nil || len(l) != 0 {
		t.Fatalf("the libraries of a server without one: %+v", l)
	}
	if out := none.expect(200, "GET", "/api/state", ""); !strings.Contains(out, `"libraries":[]`) {
		t.Fatalf("the snapshot of a server without a library: %s", cut(out, 300))
	}
	none.refusedWith(404, CodeNoServer, "POST", localLibrary+"/groups", `{"name":"x"}`)
}

// A library file that cannot be read is set aside and reported in the library's notice; the
// server starts with an empty library that works.
func TestLibraryFileThatCannotBeRead(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	path := filepath.Join(root, library.FileName)
	if err := os.WriteFile(path, []byte(`{"version":1,"prompts":[{"id":"p_0000000000aa","name":"a/b"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, withLibrary(t, root))
	v := e.local()
	if !strings.Contains(v.Notice, path) || !strings.Contains(v.Notice, "set aside as "+library.FileName+".unreadable-") || len(v.Groups)+len(v.Prompts) != 0 {
		t.Fatalf("the library: %+v", v)
	}
	aside, _ := filepath.Glob(path + ".unreadable-*")
	if len(aside) != 1 {
		t.Fatalf("set aside: %v", aside)
	}
	if b, _ := os.ReadFile(aside[0]); !strings.Contains(string(b), `"a/b"`) {
		t.Fatalf("the file set aside holds %q", b)
	}
	e.newPrompt("new", "", "text")
	e.wantLibrary("new=text")
}
