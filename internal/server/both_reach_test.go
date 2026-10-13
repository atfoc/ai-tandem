package server

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// What a client cannot reach, with both halves real and a third server behind the remote one
// (goal, section 5: "No chain" and "What a client cannot reach"; 3.11, last bullet; D18;
// contract 2.3): the remote server is itself a client of a third server. Its owner's page has
// that server as a section. A client is handed nothing of it, by a snapshot, an event or a
// route, and reaches nothing of the remote server's own list, settings, restart or files:
// neither through its local server nor on the remote listener with the secret.
func TestBothWhatAClientCannotReach(t *testing.T) {
	t.Parallel()
	// The third server: a stand-in that has a group and a chat.
	snap := standin.DefaultSnapshot()
	snap["groups"] = []model.Group{groupThere(farGroup, "There")}
	snap["chats"] = []model.ChatView{viewThere(farChatA)}
	snap["states"] = []model.BranchState{model.StateOf(farChatA, "main", viewThere(farChatA))}
	third := standin.Start(t, standin.Options{Snapshot: snap})
	files := t.TempDir()
	for name, content := range map[string]string{"index.html": "<!doctype html><title>the page</title>", "version.json": `{"version":"9.9.9"}`} {
		if err := os.WriteFile(filepath.Join(files, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var (
		restarts   atomic.Int32
		rm         *remotes.Relay
		thirdEntry string
	)
	bo := newBoth(t, bothOpt{withB: []func(*Server){func(s *Server) {
		s.Client = files
		s.Restart = func() error { restarts.Add(1); return nil }
		// The remote server is a client too, wired as any: its list has the third server.
		var m *servers.Manager
		m, rm = wiring{root: t.TempDir(), id: ownID}.wire(t, s)
		v, saved, _, err := m.Add(t.Context(), servers.Input{Name: "Third", Address: third.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: third.Fingerprint()}, true)
		if err != nil || !saved {
			t.Fatalf("the entry of the third server is not saved: %v", err)
		}
		thirdEntry = v.ID
		m.Start()
	}}})
	c1 := bo.c[0]
	us := bo.three()
	owner, one, two := us[0], us[1], us[2]
	c1.wait("the remote server holds the tree of the third server", func() bool { return len(rm.Sections()) == 1 })
	// What names the third server, or is its own: none of it may reach a client.
	secrets := []string{thirdEntry, farChatA, farGroup, "Third", strings.TrimPrefix(third.URL(), "https://"), standin.DefaultSecret, third.Fingerprint()}
	clean := func(what, raw string) {
		t.Helper()
		for _, part := range secrets {
			if strings.Contains(raw, part) {
				t.Errorf("%s holds %q of the third server: %s", what, part, raw)
			}
		}
	}

	// The remote server's own things, made by a client.
	group := l5ID(t, one.want(t, 200, "POST", "/groups", obj{"name": "Work", "parent": ""}))
	chat := l5ID(t, one.want(t, 200, "POST", "/chats", obj{"agent": "claude", "group": group}))
	board := l5ID(t, one.want(t, 200, "POST", "/boards", obj{"name": "plan", "group": group}))
	one.want(t, 200, "POST", "/boards/"+board+"/release", nil)
	bo.same("the set-up", us...)
	// The owner's page has the third server: in its list, and as a section with that server's chat.
	state := decode[struct {
		Sections map[string]*remotes.Tree
		Servers  []servers.View
	}](t, string(do(t, owner.p, "GET", "/api/state", nil)))
	if sec := state.Sections[thirdEntry]; sec == nil || len(sec.Chats) != 1 || sec.Chats[0].ID != farChatA || len(state.Servers) != 2 {
		t.Fatalf("the owner's page has the sections %+v and the servers %+v", state.Sections, state.Servers)
	}
	before := owner.tree(t)
	sent := len(third.Requests())

	// ---- a client's API connection: its snapshot is the remote server's own tree and nothing
	// of the servers it connects to.
	x, snapshot := bo.l.api(bothThird)
	keys := keysOf(t, snapshot)
	if keys = slices.DeleteFunc(keys, func(k string) bool { return k == "type" }); !slices.Equal(keys, l5SnapshotFields) {
		t.Errorf("the snapshot of a client has the fields %v, want %v", keys, l5SnapshotFields)
	}
	clean("the snapshot of a client", snapshot)
	_, direct := bo.l.call(bothThird, testSecret, "GET", "/api/state", "")
	clean("the state on the remote listener", direct)
	// ---- a client's page: its section is the remote server's tree, and its own server knows
	// the one entry.
	for _, u := range []*user{one, two} {
		own := string(do(t, u.p, "GET", "/api/state", nil))
		clean("the state of "+u.who, own)
		got := decode[struct {
			Sections map[string]json.RawMessage
			Servers  []servers.View
		}](t, own)
		if len(got.Sections) != 1 || len(got.Servers) != 2 || got.Servers[1].ID != u.entry {
			t.Errorf("%s has the sections %v and the servers %+v", u.who, got.Sections, got.Servers)
		}
	}
	bo.level("with a third server behind the remote one", us...)

	// ---- the events: what the third server tells reaches the owner's page, with its entry,
	// and no client: not its page, not its API stream.
	told := viewThere(farChatA)
	told.Name = "Renamed on the third server"
	third.Send(map[string]any{"type": "chat", "chat": told})
	bo.pair().event(owner.p, "chat", func(ev map[string]any) bool { return ev["server"] == thirdEntry && field(ev, "chat", "id") == farChatA })
	for i, evs := range bo.reach(one, two) {
		if len(evs) != 0 {
			t.Errorf("the change on the third server told %s %v", us[i+1].who, evs)
		}
	}
	// The API stream is read up to an event of the remote server's own, which every client gets.
	one.want(t, 200, "PATCH", "/chats/"+chat, obj{"name": "Renamed on the remote server"})
	for {
		raw := x.NextRaw()
		clean("an event of a client's API stream", raw)
		if strings.Contains(raw, `"server"`) {
			t.Errorf("a client's API stream has an event with a server: %s", raw)
		}
		if typeOf(raw) == "chat" && strings.Contains(raw, "Renamed on the remote server") {
			break
		}
	}
	bo.same("the rename", us...)

	// ---- through a local server: a path under the prefix that is no row of a section's table
	// is 404, and nothing is sent to the remote server. Every route the remote server has is
	// tried under the prefix, and what would reach the third server through it.
	rows := (&Server{}).sectionRoutes().patterns
	fill := strings.NewReplacer("{id}", chat, "{server}", "local", "{agent}", "claude", "{image}", strings.Repeat("a", 64), "{sid}", "s1", "{tid}", "t1", "{n}", "1", "{v}", "1")
	none := [][2]string{
		{"GET", "/on/" + thirdEntry + "/chats/" + farChatA}, {"POST", "/on/" + thirdEntry + "/chats"}, {"GET", "/on/" + thirdEntry + "/chats/" + farChatA + "/items"},
		{"GET", "/servers"}, {"POST", "/servers"}, {"DELETE", "/servers/" + thirdEntry}, {"PATCH", "/servers/" + thirdEntry}, {"GET", "/servers/" + thirdEntry + "/items"},
		{"POST", "/restart"}, {"GET", "/remote/status"}, {"GET", "/mcp/status"}, {"POST", "/client/flushed"}, {"PUT", "/groups/order"},
		{"GET", "/state"}, {"GET", "/events"}, {"GET", "/hello"}, {"GET", "/dirs"}, {"GET", "/usage/claude"}, {"POST", "/rpc-reply"},
		{"GET", "/library"}, {"POST", "/library/" + thirdEntry + "/groups"}, {"GET", ""}, {"GET", "/"}, {"GET", "/index.html"},
		{"PUT", "/chats/" + chat}, {"PUT", "/boards/" + board}, {"GET", "/boards/" + board},
	}
	for _, route := range bo.b.s.routes().patterns {
		method, path, found := strings.Cut(route, " ")
		rest, api := strings.CutPrefix(path, "/api")
		if !found || !api || slices.Contains(rows, method+" "+sectionPrefix+"{server}"+rest) {
			continue // the client files, and the rows of the table
		}
		none = append(none, [2]string{method, fill.Replace(rest)})
	}
	bo.untouched("a path under the prefix that is no row", func() {
		for _, c := range none {
			for _, body := range []any{nil, `{"ids":["` + group + `"],"name":"n","url":"https://127.0.0.1:1"}`} {
				status, out := one.call(c[0], c[1], body)
				if status != 404 || out != `{"error":"not found"}` {
					t.Errorf("%s %s%s for a client's page: %d %s", c[0], one.at, c[1], status, out)
				}
			}
		}
	})
	// The reveal of a file of that machine is refused by the client's own server.
	bo.untouched("the reveal of a board of a section", func() {
		one.refused(t, 400, "not_here", "POST", "/boards/"+board+"/reveal", nil)
	})

	// ---- on the remote listener, with the secret, a client id and the level: what the bounds
	// keep from a client is 404, as a route that is not there.
	place := strings.NewReplacer("{board}", board, "{chat}", chat, "s_0123456789ab", thirdEntry)
	asks := slices.Clone(l5Outside)
	asks = append(asks, [2]string{"GET", "/api/on/" + thirdEntry + "/chats/" + farChatA + "/items"}, [2]string{"GET", "/api/on/" + thirdEntry + "/chats/" + farChatA + "/tree"},
		[2]string{"POST", "/api/on/" + thirdEntry + "/chats/" + farChatA + "/messages"})
	for _, a := range asks {
		status, out := l5Call(x, a[0], place.Replace(a[1]), nil)
		if a[0] == "HEAD" {
			if status != 404 {
				t.Errorf("%s %s for a client: %d", a[0], a[1], status)
			}
			continue
		}
		l5Is(t, a[0]+" "+a[1]+" for a client", status, out, 404, l5Gate)
	}
	if restarts.Load() != 0 {
		t.Error("a client restarted the remote server")
	}
	// A route of the table that names a server reaches the remote server itself and no other:
	// the folders and the plan usage are that machine's whatever "server" says, and a prompt
	// library is that server's own.
	for _, rest := range []string{"/api/dirs", "/api/usage/claude"} {
		status, out := l5Call(x, "GET", rest+"?server="+thirdEntry, nil)
		own, ownOut := l5Call(x, "GET", rest, nil)
		if status != own || out != ownOut {
			t.Errorf("GET %s for the third server's entry: %d %s; for the remote server itself: %d %s", rest, status, out, own, ownOut)
		}
		clean("GET "+rest+" for the third server's entry", out)
	}
	if out := l5Want(t, x, 200, "GET", "/api/dirs?server="+thirdEntry, nil); !strings.Contains(out, `"path":"`+bo.b.a.DefaultCwd+`"`) {
		t.Errorf("the folders for the third server's entry are not the remote server's: %s", out)
	}
	l5Code(t, x, 404, CodeNoServer, "POST", "/api/library/"+thirdEntry+"/groups", `{"name":"n"}`)
	clean("the libraries of a client", l5Want(t, x, 200, "GET", "/api/library", nil))
	// The app's own folder is not listed to a client.
	for _, dir := range []string{bo.b.a.DataDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, c := range []*bridgetest.Page{x} {
			status, out := l5Call(c, "GET", "/api/dirs?path="+url.QueryEscape(dir), nil)
			l5Is(t, "the folder "+dir+" for a client", status, out, 400, `{"error":"the app's own folder can't be used as a working folder"}`)
		}
		// Through its local server a client's page is answered the same.
		if status, out := one.p.Do("GET", "/api/dirs?server="+one.entry+"&path="+url.QueryEscape(dir), nil); status != 400 || strings.Contains(string(out), `"dirs"`) {
			t.Errorf("the folder %s for a client's page: %d %s", dir, status, out)
		}
	}

	// Nothing of all that changed the remote server, and the third server was asked nothing
	// since the remote server connected to it.
	if after := owner.tree(t); !l5Same(t, l5Field(t, after, "groups"), l5Field(t, before, "groups")) || !l5SameList(t, after, before, "boards") {
		t.Errorf("the calls changed the remote server:\nbefore %s\nafter  %s", before, after)
	}
	if got := third.Requests(); len(got) != sent {
		t.Errorf("the third server was sent %+v", got[sent:])
	}
	// The owner's port serves its page what a client is refused.
	if out := l5Want(t, owner.p, 200, "GET", "/api/servers", nil); !strings.Contains(out, thirdEntry) {
		t.Errorf("the server list on the owner's port: %s", out)
	}
	if out := l5Want(t, owner.p, 200, "GET", "/", nil); !strings.Contains(out, "the page") {
		t.Errorf("the client files on the owner's port: %s", out)
	}
	// And its page's call for a thing of the third server is passed on to that server: the
	// chain a client has no way into.
	owner.p.Do("GET", sectionPrefix+thirdEntry+"/chats/"+farChatA, nil)
	if got := third.Requests(); len(got) != sent+1 || got[sent].Method != "GET" || got[sent].Path != "/api/chats/"+farChatA || got[sent].Client != ownID {
		t.Errorf("the call of the owner's page for a chat of the third server sent that server %+v", got[sent:])
	}
}
