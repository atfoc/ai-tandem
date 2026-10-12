package remotes

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/library"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// The copies of the other servers' prompt libraries, against a stand-in server that sends what
// a test tells it: what no real server sends is sent here. The two real stacks are in
// internal/server (libraryremote_test.go).

const (
	groupGit     = "g_0000000000a1"
	promptReview = "p_0000000000b1"
)

// gitLibrary is a library with one group and one prompt in it.
func gitLibrary() map[string]any {
	return map[string]any{
		"groups":  []any{map[string]any{"id": groupGit, "name": "git", "parent": ""}},
		"prompts": []any{map[string]any{"id": promptReview, "name": "review", "parent": groupGit, "text": "Look at it.\nTwice."}},
	}
}

// withLibrary is the stand-in's snapshot with this library.
func withLibrary(lib any) map[string]any {
	snap := standin.DefaultSnapshot()
	snap["library"] = lib
	return snap
}

// libraryRig is a rig whose stand-in reports the level of a server with a library and sends
// this snapshot.
func libraryRig(t *testing.T, snapshot any) *rig {
	t.Helper()
	return newRig(t, rigOpt{snapshot: snapshot, prepare: func(rg *rig) {
		rg.s.SetFeatureLevel(standin.Level(servers.LibraryLevel))
	}})
}

// shown lists the copies as "name connected: path | path".
func (rg *rig) shown() string {
	var out []string
	for _, v := range rg.r.Libraries() {
		if v.Server != rg.entry || v.Groups == nil || v.Prompts == nil || v.Notice != "" {
			rg.t.Fatalf("a copy: %+v", v)
		}
		line := v.Name + " " + map[bool]string{true: "connected", false: "not connected"}[v.Connected] + ":"
		for _, g := range v.Groups {
			line += " " + g.Name + "/"
		}
		for _, p := range v.Prompts {
			line += " " + p.Name + "=" + p.Text
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// libraryEvents are the "library" and "library_removed" events among evs, each as "library
// <connected> <prompts>" or "removed".
func libraryEvents(evs []map[string]any) (out []string) {
	for _, ev := range evs {
		switch ev["type"] {
		case library.EventLibrary:
			v := ev["library"].(map[string]any)
			out = append(out, "library "+map[bool]string{true: "connected", false: "not connected"}[v["connected"] == true]+" "+itoa(len(v["prompts"].([]any))))
		case library.EventRemoved:
			out = append(out, "removed")
		}
	}
	return out
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

const gitShown = "Studio connected: git/ review=Look at it.\nTwice."

// Line 24 of section 10: a server built before the feature connects as before and shows no
// library and no error, whatever it sends; so does a later one that has no library.
func TestLibraryOfAServerWithoutOne(t *testing.T) {
	t.Parallel()
	for name, c := range map[string]struct {
		level    *int
		snapshot any
	}{
		"an older server":                        {standin.Level(servers.LibraryLevel - 1), standin.DefaultSnapshot()},
		"a server that reports no level it has":  {standin.Level(servers.MinFeatureLevel), withLibrary(gitLibrary())},
		"an older server that sends a library":   {standin.Level(servers.LibraryLevel - 1), withLibrary(gitLibrary())},
		"a server of today without a library":    {standin.Level(servers.LibraryLevel), withLibrary(nil)},
		"a server of today that leaves it out":   {standin.Level(servers.LibraryLevel), standin.DefaultSnapshot()},
		"a later server without a library":       {standin.Level(servers.LibraryLevel + 4), withLibrary(nil)},
		"a server whose library is no library":   {standin.Level(servers.LibraryLevel - 1), withLibrary("none")},
		"a server of today, library of no shape": {standin.Level(servers.LibraryLevel), withLibrary(nil)},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			rg := newRig(t, rigOpt{snapshot: c.snapshot, prepare: func(rg *rig) { rg.s.SetFeatureLevel(c.level) }})
			p, _ := rg.page("P")
			rg.state(servers.StateConnected)
			// What such a server sends later is not taken either.
			rg.s.Send(map[string]any{"type": library.EventOwn, "groups": []any{}, "prompts": []any{}})
			if got := libraryEvents(rg.barrier(p)[0]); len(got) != 0 {
				t.Fatalf("the page was sent %v", got)
			}
			if got := rg.r.Libraries(); got == nil || len(got) != 0 {
				t.Fatalf("the copies: %+v", got)
			}
			if _, ok := rg.r.Library(context.Background(), rg.entry); ok {
				t.Fatal("a library to change")
			}
			if v, _ := rg.m.View(rg.entry); v.State != servers.StateConnected || v.Detail != "" {
				t.Fatalf("the entry: %+v", v)
			}
			if n := rg.logs.count("prompt library"); n != 0 {
				t.Fatalf("logged: %v", rg.logs.all())
			}
		})
	}
}

// What a server sends is held to the rules and limits of a library before it is kept or passed
// on: a library that breaks one is not shown, in a snapshot and in an event, and the next one
// that breaks none is.
func TestLibraryThatBreaksARule(t *testing.T) {
	t.Parallel()
	group := func(id, name, parent string) map[string]any {
		return map[string]any{"id": id, "name": name, "parent": parent}
	}
	prompt := func(id, name, parent, text string) map[string]any {
		return map[string]any{"id": id, "name": name, "parent": parent, "text": text}
	}
	lib := func(groups, prompts []any) map[string]any {
		return map[string]any{"groups": groups, "prompts": prompts}
	}
	var many []any
	for i := 0; i <= library.MaxItems; i++ {
		many = append(many, prompt("p_"+strings.Repeat("0", 12-len(itoa(i)))+itoa(i), "n"+itoa(i), "", ""))
	}
	var heavy []any // names and texts of more bytes than a library holds, each text within its own limit
	for i := 0; i*library.MaxText <= library.MaxBytes; i++ {
		heavy = append(heavy, prompt("p_"+strings.Repeat("0", 12-len(itoa(i)))+itoa(i), "n"+itoa(i), "", strings.Repeat("t", library.MaxText)))
	}
	var deep []any
	for i, parent := 0, ""; i <= library.MaxDepth; i++ {
		id := "g_" + strings.Repeat("0", 12-len(itoa(i))) + itoa(i)
		deep = append(deep, group(id, "g", parent))
		parent = id
	}
	bad := map[string]any{
		"a name of 81 characters":       lib([]any{group(groupGit, strings.Repeat("n", library.MaxName+1), "")}, nil),
		"a name with a slash":           lib(nil, []any{prompt(promptReview, "a/b", "", "")}),
		"a name with a line break":      lib(nil, []any{prompt(promptReview, "a\nb", "", "")}),
		"an empty name":                 lib([]any{group(groupGit, "", "")}, nil),
		"a name with spaces around":     lib([]any{group(groupGit, " git ", "")}, nil),
		"two names that differ in case": lib([]any{group(groupGit, "Review", "")}, []any{prompt(promptReview, "review", "", "")}),
		"a text that is too long":       lib(nil, []any{prompt(promptReview, "review", "", strings.Repeat("t", library.MaxText+1))}),
		"a text that is no text":        lib(nil, []any{map[string]any{"id": promptReview, "name": "review", "parent": "", "text": 7}}),
		"an id of another form":         lib(nil, []any{prompt("<img src=x onerror=alert(1)>", "review", "", "")}),
		"an id used twice":              lib(nil, []any{prompt(promptReview, "a", "", ""), prompt(promptReview, "b", "", "")}),
		"a group that is not there":     lib(nil, []any{prompt(promptReview, "review", "g_00000000dead", "")}),
		"a group in itself":             lib([]any{group(groupGit, "git", groupGit)}, nil),
		"groups too deep":               lib(deep, nil),
		"too many items":                lib(nil, many),
		"too many bytes":                lib(nil, heavy),
		"no library at all":             "<script>",
	}

	rg := libraryRig(t, withLibrary(gitLibrary()))
	p, snap := rg.page("P")
	if snap == nil || rg.shown() != gitShown {
		t.Fatalf("the copy: %s", rg.shown())
	}
	own := func(lib any) map[string]any {
		ev := map[string]any{"type": library.EventOwn}
		if m, ok := lib.(map[string]any); ok {
			for k, v := range m {
				ev[k] = v
			}
		} else {
			ev["groups"] = lib
		}
		return ev
	}
	for name, lib := range bad {
		// In an event: the copy goes, and the page is told once.
		rg.s.Send(own(lib))
		if got := libraryEvents(rg.barrier(p)[0]); len(got) != 1 || got[0] != "removed" {
			t.Fatalf("%s: the page was sent %v", name, got)
		}
		if got := rg.shown(); got != "" {
			t.Fatalf("%s: the copy: %s", name, got)
		}
		if _, ok := rg.r.Library(context.Background(), rg.entry); ok {
			t.Fatalf("%s: a library to change", name)
		}
		// The next one that breaks no rule is shown again.
		rg.s.Send(own(gitLibrary()))
		if got := libraryEvents(rg.barrier(p)[0]); len(got) != 1 || got[0] != "library connected 1" {
			t.Fatalf("%s: after a good library the page was sent %v", name, got)
		}
	}
	// The reason is logged, and not once per event: a server that sends nothing else fills no log.
	if n := rg.logs.count("prompt library of the server " + rg.entry + " is not shown"); n != 1 {
		t.Fatalf("%d log lines: %v", n, rg.logs.all())
	}
	for _, line := range rg.logs.all() {
		if len(line) > 600 {
			t.Fatalf("a log line of %d bytes", len(line))
		}
	}

	// In a snapshot: a stream that starts with such a library shows none.
	rg.s.SetSnapshot(withLibrary(bad["a name with a slash"]))
	n := rg.local.upCount()
	rg.s.DropStreams()
	rg.returned(n + 1)
	if got := rg.shown(); got != "" {
		t.Fatalf("after a snapshot with a bad library: %s", got)
	}
	// The page is told that the server dropped, and then that its library is gone.
	var told []map[string]any
	for len(told) == 0 || told[len(told)-1]["type"] != library.EventRemoved {
		told = append(told, p.Next())
	}
	if got := libraryEvents(told); len(got) != 2 || got[0] != "library not connected 1" {
		t.Fatalf("the page was sent %v", got)
	}
	rg.s.Send(own(gitLibrary()))
	rg.barrier(p)
	if got := rg.shown(); got != gitShown {
		t.Fatalf("after a good library: %s", got)
	}
}

// libraryServer is a stand-in that answers the library routes as a test says.
type libraryServer struct {
	mu     sync.Mutex
	status int
	body   string
	then   func() // after the answer was written
	got    []string
}

func (ls *libraryServer) answer(status int, body string, then func()) {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	ls.status, ls.body, ls.then = status, body, then
}

func (ls *libraryServer) requests() []string {
	ls.mu.Lock()
	defer ls.mu.Unlock()
	return append([]string(nil), ls.got...)
}

func (ls *libraryServer) serve(rg *rig) {
	h := func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		ls.mu.Lock()
		ls.got = append(ls.got, r.Method+" "+r.URL.Path+" "+string(body))
		status, out, then := ls.status, ls.body, ls.then
		ls.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, out)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		if then != nil {
			then()
		}
	}
	for _, pattern := range []string{
		"POST /api/library/{server}/groups", "PATCH /api/library/{server}/groups/{id}", "DELETE /api/library/{server}/groups/{id}",
		"POST /api/library/{server}/prompts", "PATCH /api/library/{server}/prompts/{id}", "DELETE /api/library/{server}/prompts/{id}",
	} {
		rg.s.Handle(pattern, h)
	}
}

// A call for a remote library is passed on to the library's own server, under that server's
// local id, and what comes back is held to the rules before the page gets it: an item that is
// none is refused, a refusal keeps its code and gets a sentence of plain text, and anything
// else is this server's own answer.
func TestRemoteLibraryCalls(t *testing.T) {
	t.Parallel()
	rg := libraryRig(t, withLibrary(gitLibrary()))
	ls := &libraryServer{}
	ls.serve(rg)
	rg.r.libs.wait = 30 * time.Millisecond // nothing arrives on the stream unless a case sends it
	l, ok := rg.r.Library(context.Background(), rg.entry)
	if !ok {
		t.Fatal("no library to change")
	}
	name, text := "new", "x"

	// What is sent: the server's own library, the call's fields and nothing else.
	ls.answer(200, `{"prompt":{"id":"p_0000000000c1","name":"new","parent":"`+groupGit+`","text":"x"}}`, nil)
	if got, err := l.CreatePrompt("new", groupGit, "x"); err != nil || got.ID != "p_0000000000c1" || got.Text != "x" {
		t.Fatalf("the prompt: %+v, %v", got, err)
	}
	ls.answer(200, `{"group":{"id":"`+groupGit+`","name":"new","parent":""}}`, nil)
	if got, err := l.ChangeGroup(groupGit, library.GroupChange{Name: &name}); err != nil || got.Name != "new" {
		t.Fatalf("the group: %+v, %v", got, err)
	}
	ls.answer(200, `{"ok":true}`, nil)
	if err := l.DeletePrompt(promptReview); err != nil {
		t.Fatal(err)
	}
	want := []string{
		`POST /api/library/local/prompts {"name":"new","parent":"` + groupGit + `","text":"x"}`,
		`PATCH /api/library/local/groups/` + groupGit + ` {"name":"new"}`,
		`DELETE /api/library/local/prompts/` + promptReview + ` `,
	}
	if got := ls.requests(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("the server was asked\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	for _, r := range rg.s.Requests() {
		if strings.HasPrefix(r.Path, "/api/library") && (r.Secret != standin.DefaultSecret || r.Client != testLocalID) {
			t.Fatalf("a call without the entry's secret or this server's id: %+v", r)
		}
	}
	// None of it changed the copy: only the stream does.
	if got := rg.shown(); got != gitShown {
		t.Fatalf("the copy: %s", got)
	}

	// An answer that is not what the call answers with.
	for what, body := range map[string]string{
		"no JSON":                 `<html>`,
		"no prompt":               `{"ok":true}`,
		"an id of another form":   `{"prompt":{"id":"../x","name":"new","parent":"","text":""}}`,
		"a name with a slash":     `{"prompt":{"id":"p_0000000000c1","name":"a/b","parent":"","text":""}}`,
		"a name that is too long": `{"prompt":{"id":"p_0000000000c1","name":"` + strings.Repeat("n", library.MaxName+1) + `","parent":"","text":""}}`,
		"a parent that is no id":  `{"prompt":{"id":"p_0000000000c1","name":"new","parent":"<b>","text":""}}`,
		"a text that is too long": `{"prompt":{"id":"p_0000000000c1","name":"new","parent":"","text":"` + strings.Repeat("t", library.MaxText+1) + `"}}`,
	} {
		ls.answer(200, body, nil)
		var e *Error
		if _, err := l.ChangePrompt(promptReview, library.PromptChange{Text: &text}); !errors.As(err, &e) || e.Status != 502 || e.Code != "bad_answer" {
			t.Errorf("%s: %v", what, err)
		}
	}

	// A refusal of the library's rules: its code, and its sentence as one line of plain text.
	ls.answer(409, `{"error":"There is already\u0000 a prompt\ncalled \"new\".","code":"name_taken"}`, nil)
	var refusal *library.Refusal
	if _, err := l.CreatePrompt("new", "", ""); !errors.As(err, &refusal) || refusal.Code != library.CodeNameTaken || refusal.Text != `There is already  a prompt called "new".` {
		t.Fatalf("the refusal: %#v", err)
	}
	ls.answer(400, `{"error":"`+strings.Repeat("long ", 1000)+`","code":"bad_name"}`, nil)
	if _, err := l.CreateGroup("x", ""); !errors.As(err, &refusal) || refusal.Code != library.CodeBadName || len([]rune(refusal.Text)) > saidMax+1 {
		t.Fatalf("a long refusal: %v", err)
	}
	ls.answer(404, `{"code":"not_found"}`, nil)
	if err := l.DeleteGroup(groupGit); !errors.As(err, &refusal) || refusal.Code != library.CodeNotFound || refusal.Text != "Studio refused this." {
		t.Fatalf("a refusal without a sentence: %v", err)
	}
	// Any other answer is none of the library's: 502, whatever status and code the server chose.
	for what, c := range map[string]struct {
		status     int
		body, text string
	}{
		"a failure there":         {500, `{"error":"disk full"}`, "Studio could not do this: disk full"},
		"a code of another thing": {409, `{"error":"unknown_client","code":"unknown_client"}`, "Studio could not do this: unknown_client"},
		"no sentence":             {418, `{}`, "Studio answered with status 418."},
		"a server without routes": {404, `{"error":"not found"}`, "Studio could not do this: not found"},
		"a redirect":              {307, ``, "Studio answered with status 307."},
	} {
		ls.answer(c.status, c.body, nil)
		var e *Error
		if _, err := l.CreateGroup("x", ""); !errors.As(err, &e) || e.Status != 502 || e.Code != "" || e.Text != c.text {
			t.Errorf("%s: %#v", what, err)
		}
	}
	// An id that is none is refused here: it is never part of a path.
	n := len(ls.requests())
	for _, id := range []string{"", "..", "g_1", "x_0000000000a1", "g_0000000000A1", "g_0000000000a1/../x", "p_0000000000b1?x=1"} {
		if _, err := l.ChangeGroup(id, library.GroupChange{Name: &name}); !errors.As(err, &refusal) || refusal.Code != library.CodeNotFound {
			t.Errorf("the group %q: %v", id, err)
		}
		if err := l.DeleteGroup(id); !errors.As(err, &refusal) || refusal.Code != library.CodeNotFound {
			t.Errorf("the group %q: %v", id, err)
		}
		if _, err := l.ChangePrompt(id, library.PromptChange{Text: &text}); !errors.As(err, &refusal) || refusal.Code != library.CodeNotFound {
			t.Errorf("the prompt %q: %v", id, err)
		}
		if err := l.DeletePrompt(id); !errors.As(err, &refusal) || refusal.Code != library.CodeNotFound {
			t.Errorf("the prompt %q: %v", id, err)
		}
	}
	// A group's id is no prompt's, and the reverse.
	if err := l.DeletePrompt(groupGit); !errors.As(err, &refusal) {
		t.Errorf("a group's id as a prompt's: %v", err)
	}
	if err := l.DeleteGroup(promptReview); !errors.As(err, &refusal) {
		t.Errorf("a prompt's id as a group's: %v", err)
	}
	if len(ls.requests()) != n {
		t.Fatalf("an id that is none was sent: %v", ls.requests()[n:])
	}

	// The secret is no longer the server's: the entry stops, and the copy stays, marked.
	p, _ := rg.page("P")
	ls.answer(401, `{"error":"unauthorized"}`, nil)
	var e *Error
	if _, err := l.CreateGroup("x", ""); !errors.As(err, &e) || e.Status != 503 || e.Code != "server_unreachable" {
		t.Fatalf("after a 401: %v", err)
	}
	rg.state(servers.StateSecretNotAccepted)
	for ev := p.Next(); ev["type"] != library.EventLibrary; ev = p.Next() {
	}
	if got := rg.shown(); got != "Studio not connected: git/ review=Look at it.\nTwice." {
		t.Fatalf("the copy: %s", got)
	}
	n = len(ls.requests())
	if _, err := l.CreateGroup("x", ""); !errors.As(err, &e) || e.Status != 503 || e.Code != "server_unreachable" ||
		e.Text != "Studio is not connected: its prompts cannot be changed until it is back." || len(ls.requests()) != n {
		t.Fatalf("a call for a library that is not connected: %v", err)
	}
}

// A call that changed a library is answered when the change has arrived on the stream and the
// pages were sent it, as a call for this computer's library is.
func TestRemoteLibraryCallWaitsForItsChange(t *testing.T) {
	t.Parallel()
	rg := libraryRig(t, withLibrary(gitLibrary()))
	ls := &libraryServer{}
	ls.serve(rg)
	p, _ := rg.page("P")
	l, _ := rg.r.Library(context.Background(), rg.entry)
	after := gitLibrary()
	after["prompts"] = append(after["prompts"].([]any), map[string]any{"id": "p_0000000000c1", "name": "new", "parent": "", "text": "x"})
	// The server answers first and sends the event a moment later.
	ls.answer(200, `{"prompt":{"id":"p_0000000000c1","name":"new","parent":"","text":"x"}}`, func() {
		time.Sleep(100 * time.Millisecond)
		ev := map[string]any{"type": library.EventOwn}
		for k, v := range after {
			ev[k] = v
		}
		rg.s.Send(ev)
	})
	if _, err := l.CreatePrompt("new", "", "x"); err != nil {
		t.Fatal(err)
	}
	if got := rg.shown(); got != gitShown+" new=x" {
		t.Fatalf("when the call returned the copy was: %s", got)
	}
	if ev := p.Next(); ev["type"] != library.EventLibrary {
		t.Fatalf("the page's next event: %v", ev)
	}
	// A delete waits for the item to be gone, and does not wait for what is gone already.
	ls.answer(200, `{"ok":true}`, func() {
		ev := map[string]any{"type": library.EventOwn}
		for k, v := range gitLibrary() {
			ev[k] = v
		}
		rg.s.Send(ev)
	})
	if err := l.DeletePrompt("p_0000000000c1"); err != nil || rg.shown() != gitShown {
		t.Fatalf("after the delete: %v, %s", err, rg.shown())
	}
	ls.answer(200, `{"ok":true}`, nil)
	start := time.Now()
	if err := l.DeletePrompt("p_0000000000c1"); err != nil || time.Since(start) > libraryWait/2 {
		t.Fatalf("a delete of what is gone: %v after %v", err, time.Since(start))
	}
}

// Nothing of a copy survives a restart of this server: a server that is still unreachable then
// shows no prompts until it connects. The copy is in no file.
func TestLibraryCopyIsInMemoryOnly(t *testing.T) {
	t.Parallel()
	rg := libraryRig(t, withLibrary(gitLibrary()))
	p, _ := rg.page("P")
	if rg.shown() != gitShown {
		t.Fatalf("the copy: %s", rg.shown())
	}
	rg.s.Stop()
	rg.state(servers.StateUnreachable)
	for ev := p.Next(); ev["type"] != library.EventLibrary; ev = p.Next() {
	}
	if got := rg.shown(); got != "Studio not connected: git/ review=Look at it.\nTwice." {
		t.Fatalf("the copy of a server that dropped: %s", got)
	}
	// This server stops, and writes what it keeps.
	rg.m.Close()
	rg.r.Close()
	err := filepath.WalkDir(rg.root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		if b, _ := os.ReadFile(path); strings.Contains(string(b), "Look at it.") || strings.Contains(string(b), "review") {
			t.Errorf("the file %s holds the library", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// It starts again, with the same list; the other server is still down.
	again := newRig(t, rigOpt{root: rg.root, hold: true})
	again.m.Start()
	again.state(servers.StateUnreachable)
	if got := again.r.Libraries(); len(got) != 0 {
		t.Fatalf("the copies after a restart: %+v", got)
	}
	if _, ok := again.r.Library(context.Background(), again.entry); ok {
		t.Fatal("a library to change after a restart")
	}
	q := bridgetest.Connect(t, again.web.URL, "Q")
	q.Welcome()
	// The other server is back: its library is shown.
	rg.s.Restart()
	again.returned(1)
	for ev := q.Next(); ev["type"] != library.EventLibrary; ev = q.Next() {
	}
	if got := again.r.Libraries(); len(got) != 1 || got[0].Server != again.entry || !got[0].Connected || len(got[0].Prompts) != 1 {
		t.Fatalf("the copies after the server is back: %+v", got)
	}
}
