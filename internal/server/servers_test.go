package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// The routes of the server list against the real handler, with a stand-in (loopback, TLS) as the
// remote server. The entries are saved with the box ticked and the stand-in's fingerprint as the
// pin, so no certificate store of the machine is asked.

const (
	testLocalID  = "11111111-2222-4333-8444-555555555555"
	secondSecret = "another-secret-9f8e7d6c5b4a39281706f5e4d3c2b1a0"
	noSuchServer = "s_000000000000"
)

// withServers gives the server a list in a folder of its own, as serve does: its events go to the
// bridge, and the app's snapshot reads it. An entry other than the local one counts 2 chats and
// 1 run.
func withServers(t *testing.T) (func(*Server), *string) {
	root := t.TempDir()
	return func(s *Server) {
		m, err := servers.Open(servers.Options{Root: root, LocalID: testLocalID, Version: "test", Notify: s.Bridge.Broadcast})
		if err != nil {
			t.Fatal(err)
		}
		m.Counts = func(id string) (int, int) {
			if id == servers.LocalID {
				return 0, 0
			}
			return 2, 1
		}
		t.Cleanup(m.Close)
		s.Servers, s.App.Servers = m, m
		m.Start()
	}, &root
}

type serverList struct {
	Servers []servers.View `json:"servers"`
	Notice  string         `json:"notice"`
}

type savedReply struct {
	Saved  bool            `json:"saved"`
	Server *servers.View   `json:"server"`
	Result *servers.Result `json:"result"`
}

func (e *env) serverList() serverList {
	e.t.Helper()
	return decode[serverList](e.t, e.expect(200, "GET", "/api/servers", ""))
}

// serverIn waits until the entry is in the state and returns its view.
func (e *env) serverIn(id string, want servers.State) servers.View {
	e.t.Helper()
	var last servers.View
	for end := time.Now().Add(10 * time.Second); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
		for _, v := range e.serverList().Servers {
			if v.ID == id {
				if last = v; v.State == want {
					return v
				}
			}
		}
	}
	e.t.Fatalf("server %s is %q (%s), want %q", id, last.State, last.Detail, want)
	return last
}

// listRefusal checks an error answer's status and code.
func (e *env) listRefusal(what string, status int, code, method, path, body string) string {
	e.t.Helper()
	got, out := e.do(method, path, body)
	var r struct{ Error, Code string }
	json.Unmarshal([]byte(out), &r)
	if got != status || r.Code != code || r.Error == "" {
		e.t.Fatalf("%s: %d %s, want %d with the code %q", what, got, out, status, code)
	}
	return r.Error
}

// form is the body of an add, an edit or a test.
func form(kv ...any) string {
	m := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i].(string)] = kv[i+1]
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func listFile(t *testing.T, root string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, servers.FileName))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// An entry is added, edited, tested and removed through the routes; the local entry is first and
// can be neither edited nor removed.
func TestServerRoutes(t *testing.T) {
	with, root := withServers(t)
	e := newEnv(t, with)
	st := standin.Start(t, standin.Options{})
	fp := st.Fingerprint()

	// The list of a new installation: the local entry alone.
	l := e.serverList()
	if len(l.Servers) != 1 || l.Notice != "" {
		t.Fatalf("first list: %+v", l)
	}
	if v := l.Servers[0]; v.ID != servers.LocalID || !v.Local || v.Name != servers.LocalName ||
		v.State != servers.StateConnected || v.InstanceID != testLocalID || v.Version != "test" {
		t.Fatalf("local entry: %+v", v)
	}

	// This server offered as an entry: the test says so, and nothing is saved (AC4).
	me := standin.Start(t, standin.Options{InstanceID: testLocalID})
	self := decode[savedReply](t, e.expect(200, "POST", "/api/servers",
		form("name", "Me", "address", me.URL(), "secret", standin.DefaultSecret, "selfSigned", true, "pin", me.Fingerprint())))
	if self.Saved || self.Server != nil || self.Result == nil || self.Result.OK || self.Result.Outcome != servers.OutcomeIsLocal {
		t.Fatalf("add of this server: %+v %+v", self, self.Result)
	}
	if raw := decode[map[string]any](t, e.expect(200, "POST", "/api/servers",
		form("name", "Me", "address", me.URL(), "secret", standin.DefaultSecret, "selfSigned", true, "pin", me.Fingerprint()))); raw["saved"] != false || field(raw, "result", "outcome") != "is_local" {
		t.Fatalf("add of this server, as sent: %v", raw)
	}
	if _, err := os.Stat(filepath.Join(*root, servers.FileName)); !os.IsNotExist(err) {
		t.Fatalf("the add of this server wrote the list: %v", err)
	}
	if l := e.serverList(); len(l.Servers) != 1 || !l.Servers[0].Local {
		t.Fatalf("list after the add of this server: %+v", l)
	}

	// The test of a form: without a fingerprint it ends at the certificate and sends no request.
	r := decode[servers.Result](t, e.expect(200, "POST", "/api/servers/test",
		form("address", st.URL(), "secret", standin.DefaultSecret, "selfSigned", true)))
	if r.OK || r.Outcome != servers.OutcomeFingerprint || r.Fingerprint != fp || r.Step != 3 {
		t.Fatalf("test without a pin: %+v", r)
	}
	if got := st.Requests(); len(got) != 0 {
		t.Fatalf("requests before a fingerprint was accepted: %+v", got)
	}
	r = decode[servers.Result](t, e.expect(200, "POST", "/api/servers/test",
		form("address", st.URL(), "secret", standin.DefaultSecret, "selfSigned", true, "pin", fp)))
	if !r.OK || r.Outcome != servers.OutcomeConnected || r.Message != "Connected" || r.Version == "" {
		t.Fatalf("test with the pin: %+v", r)
	}
	r = decode[servers.Result](t, e.expect(200, "POST", "/api/servers/test", form("address", "http://127.0.0.1:1", "secret", "x")))
	if r.OK || r.Outcome != servers.OutcomeBadAddress || r.Step != 1 {
		t.Fatalf("test of a bad address: %+v", r)
	}

	// Add: the form's errors, a test that does not pass, then a save.
	good := []any{"name", "Studio", "address", st.URL(), "secret", standin.DefaultSecret, "selfSigned", true, "pin", fp}
	bad := func(k string, v any) string { return form(append(append([]any{}, good...), k, v)...) }
	e.listRefusal("add without a name", 400, "bad_name", "POST", "/api/servers", bad("name", " "))
	e.listRefusal("add with a plain address", 400, "bad_address", "POST", "/api/servers", bad("address", "http://127.0.0.1:4748"))
	e.listRefusal("add without a secret", 400, "bad_secret", "POST", "/api/servers", bad("secret", ""))
	e.listRefusal("add with a bad pin", 400, "bad_pin", "POST", "/api/servers", bad("pin", "zz"))
	e.listRefusal("forced add without a name", 400, "bad_name", "POST", "/api/servers", form(append(append([]any{}, good...), "name", "", "force", true)...))
	if code, out := e.do("POST", "/api/servers", "{"); code != 400 {
		t.Fatalf("add with a broken body: %d %s", code, out)
	}
	s := decode[savedReply](t, e.expect(200, "POST", "/api/servers", bad("pin", "")))
	if s.Saved || s.Server != nil || s.Result == nil || s.Result.Outcome != servers.OutcomeFingerprint {
		t.Fatalf("add without a pin: %+v %+v", s, s.Result)
	}
	if _, err := os.Stat(filepath.Join(*root, servers.FileName)); !os.IsNotExist(err) {
		t.Fatalf("a refused add wrote the list: %v", err)
	}
	s = decode[savedReply](t, e.expect(200, "POST", "/api/servers", form(good...)))
	if !s.Saved || s.Server == nil || s.Result == nil || !s.Result.OK {
		t.Fatalf("add: %+v", s)
	}
	id := s.Server.ID
	if !strings.HasPrefix(id, "s_") || len(id) != 14 || s.Server.Name != "Studio" || s.Server.Address != st.URL() ||
		!s.Server.SelfSigned || s.Server.Pin != fp || s.Server.InstanceID != standin.DefaultInstanceID {
		t.Fatalf("added entry: %+v", s.Server)
	}
	if v := e.serverIn(id, servers.StateConnected); v.Version == "" || len(v.Agents) == 0 {
		t.Fatalf("connected entry: %+v", v)
	}
	if l := e.serverList(); len(l.Servers) != 2 || l.Servers[0].ID != servers.LocalID || l.Servers[1].ID != id {
		t.Fatalf("list after the add: %+v", l)
	}
	if info, err := os.Stat(filepath.Join(*root, servers.FileName)); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("list file: %v, %v", info, err)
	}
	msg := e.listRefusal("second entry with the address", 409, "duplicate", "POST", "/api/servers", form(append(append([]any{}, good...), "name", "Twice")...))
	if !strings.Contains(msg, "Studio") {
		t.Fatalf("duplicate: %q", msg)
	}

	// A forced add makes no request before the save.
	nothing := standin.Refused(t)
	s = decode[savedReply](t, e.expect(200, "POST", "/api/servers", form("name", "Away", "address", nothing, "secret", "abc", "force", true)))
	if !s.Saved || s.Server == nil || s.Result != nil {
		t.Fatalf("forced add: %+v", s)
	}
	away := s.Server.ID
	e.serverIn(away, servers.StateUnreachable)

	// Edit: the name alone, a test that does not pass, the local entry, an unknown one.
	s = decode[savedReply](t, e.expect(200, "PATCH", "/api/servers/"+id, form("name", "Studio 2")))
	if !s.Saved || s.Server == nil || s.Server.ID != id || s.Server.Name != "Studio 2" || s.Result != nil {
		t.Fatalf("rename: %+v", s)
	}
	s = decode[savedReply](t, e.expect(200, "PATCH", "/api/servers/"+away, form("secret", "abcd")))
	if s.Saved || s.Result == nil || s.Result.Outcome != servers.OutcomeRefused || s.Result.Step != 2 {
		t.Fatalf("edit that does not connect: %+v %+v", s, s.Result)
	}
	if strings.Contains(listFile(t, *root), `"abcd"`) {
		t.Fatal("an edit that was not saved changed the file")
	}
	s = decode[savedReply](t, e.expect(200, "PATCH", "/api/servers/"+away, form("secret", "abcd", "force", true)))
	if !s.Saved || s.Server == nil || s.Server.ID != away || !strings.Contains(listFile(t, *root), `"abcd"`) {
		t.Fatalf("forced edit: %+v", s)
	}
	s = decode[savedReply](t, e.expect(200, "PATCH", "/api/servers/"+away, form("name", "Far", "secret", "")))
	if !s.Saved || !strings.Contains(listFile(t, *root), `"abcd"`) {
		t.Fatalf("an edit with an empty secret did not keep the stored one: %+v", s)
	}
	e.listRefusal("edit to the other entry's address", 409, "duplicate", "PATCH", "/api/servers/"+away, form("address", st.URL(), "force", true))
	e.listRefusal("edit with a bad address", 400, "bad_address", "PATCH", "/api/servers/"+id, form("address", "mac.local"))
	if msg := e.listRefusal("edit of the local entry", 409, "local_entry", "PATCH", "/api/servers/local", form("name", "Mine")); msg != "this computer cannot be edited" {
		t.Fatalf("edit of the local entry: %q", msg)
	}
	e.expect(404, "PATCH", "/api/servers/"+noSuchServer, form("name", "x"))

	// Items: the counts this app keeps for the entry.
	if got := e.expect(200, "GET", "/api/servers/"+id+"/items", ""); strings.TrimSpace(got) != `{"chats":2,"runs":1}` {
		t.Fatalf("items: %s", got)
	}
	if got := e.expect(200, "GET", "/api/servers/local/items", ""); strings.TrimSpace(got) != `{"chats":0,"runs":0}` {
		t.Fatalf("items of the local entry: %s", got)
	}
	e.expect(404, "GET", "/api/servers/"+noSuchServer+"/items", "")

	// The test of a saved entry: as stored, and with a field of the form in its place.
	r = decode[servers.Result](t, e.expect(200, "POST", "/api/servers/"+id+"/test", ""))
	if !r.OK || r.InstanceID != standin.DefaultInstanceID {
		t.Fatalf("test of the saved entry: %+v", r)
	}
	r = decode[servers.Result](t, e.expect(200, "POST", "/api/servers/"+id+"/test", form("secret", "not-the-secret")))
	if r.OK || r.Outcome != servers.OutcomeSecretRefused || r.Step != 4 {
		t.Fatalf("test with another secret: %+v", r)
	}
	r = decode[servers.Result](t, e.expect(200, "POST", "/api/servers/"+away+"/test", "{}"))
	if r.OK || r.Outcome != servers.OutcomeRefused {
		t.Fatalf("test of the entry nothing answers for: %+v", r)
	}
	e.expect(404, "POST", "/api/servers/"+noSuchServer+"/test", "")
	e.listRefusal("test of the local entry", 409, "local_entry", "POST", "/api/servers/local/test", "")

	// Accept: a fingerprint becomes the pin and the box is set.
	e.listRefusal("accept of no fingerprint", 400, "bad_pin", "POST", "/api/servers/"+away+"/accept", form("fingerprint", "AB:CD"))
	e.expect(404, "POST", "/api/servers/"+noSuchServer+"/accept", form("fingerprint", fp))
	e.listRefusal("accept for the local entry", 409, "local_entry", "POST", "/api/servers/local/accept", form("fingerprint", fp))
	acc := decode[struct{ Server servers.View }](t, e.expect(200, "POST", "/api/servers/"+away+"/accept", form("fingerprint", fp)))
	if acc.Server.ID != away || acc.Server.Pin != fp || !acc.Server.SelfSigned {
		t.Fatalf("accept: %+v", acc.Server)
	}

	// Remove: the local entry stays, the others go, and the server is sent nothing.
	if msg := e.listRefusal("remove of the local entry", 409, "local_entry", "DELETE", "/api/servers/local", ""); msg != "this computer cannot be removed" {
		t.Fatalf("remove of the local entry: %q", msg)
	}
	e.expect(404, "DELETE", "/api/servers/"+noSuchServer, "")
	e.serverIn(id, servers.StateConnected)
	before := len(st.Requests())
	for _, x := range []string{id, away} {
		if got := e.expect(200, "DELETE", "/api/servers/"+x, ""); strings.TrimSpace(got) != `{"ok":true}` {
			t.Fatalf("remove: %s", got)
		}
	}
	e.expect(404, "DELETE", "/api/servers/"+id, "")
	if l := e.serverList(); len(l.Servers) != 1 || l.Servers[0].ID != servers.LocalID {
		t.Fatalf("list after the removes: %+v", l)
	}
	if got := listFile(t, *root); strings.Contains(got, id) || strings.Contains(got, standin.DefaultSecret) {
		t.Fatalf("the file after the removes: %s", got)
	}
	for end := time.Now().Add(5 * time.Second); st.Streams() != 0; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("the stream of a removed entry stays open")
		}
	}
	if after := len(st.Requests()); after != before {
		t.Fatalf("the remove sent the server %d requests: %+v", after-before, st.Requests()[before:])
	}
}

// Without a manager the list is the local entry and no other route exists.
func TestServerRoutesWithoutAManager(t *testing.T) {
	e := newEnv(t)
	l := e.serverList()
	if len(l.Servers) != 1 || l.Servers[0].ID != servers.LocalID || !l.Servers[0].Local || l.Notice != "" {
		t.Fatalf("list: %+v", l)
	}
	for _, c := range [][2]string{
		{"POST", "/api/servers"}, {"PATCH", "/api/servers/local"}, {"DELETE", "/api/servers/local"},
		{"GET", "/api/servers/local/items"}, {"POST", "/api/servers/test"},
		{"POST", "/api/servers/local/test"}, {"POST", "/api/servers/local/accept"},
	} {
		e.expect(404, c[0], c[1], "{}")
	}
}

// The routes that change the list are for a known client: a call without the header, or with an
// id that has no stream, is refused and saves nothing.
func TestServerRoutesNeedAClient(t *testing.T) {
	with, root := withServers(t)
	e := newEnv(t, with)
	s := decode[savedReply](t, e.expect(200, "POST", "/api/servers", form("name", "Kept", "address", "https://127.0.0.1:1", "secret", "abc", "force", true)))
	kept := s.Server.ID
	before := listFile(t, *root)

	add := form("name", "Studio", "address", "https://127.0.0.1:2", "secret", "abc", "force", true)
	for _, client := range []string{"", "B"} {
		for _, c := range [][3]string{
			{"POST", "/api/servers", add},
			{"PATCH", "/api/servers/" + kept, form("name", "Changed")},
			{"DELETE", "/api/servers/" + kept, ""},
			{"POST", "/api/servers/test", add},
			{"POST", "/api/servers/" + kept + "/test", ""},
			{"POST", "/api/servers/" + kept + "/accept", form("fingerprint", strings.Repeat("AB:", 31)+"AB")},
		} {
			code, out := e.doAs(client, c[0], c[1], c[2])
			if code != 409 || decode[map[string]string](t, out)["error"] != "unknown_client" {
				t.Fatalf("%s %s from %q: %d %s", c[0], c[1], client, code, out)
			}
		}
	}
	// A page of another origin sends no header it would need a preflight for.
	if code, out, _ := e.foreign("POST", "/api/servers", add); code != 409 {
		t.Fatalf("add from another origin: %d %s", code, out)
	}
	if after := listFile(t, *root); after != before {
		t.Fatalf("a refused call changed the list:\n%s\n%s", before, after)
	}
	if l := e.serverList(); len(l.Servers) != 2 || l.Servers[1].Name != "Kept" || l.Servers[1].Pin != "" {
		t.Fatalf("list: %+v", l)
	}
	// The reads need no header.
	for _, path := range []string{"/api/servers", "/api/servers/" + kept + "/items"} {
		if code, out := e.doAs("", "GET", path, ""); code != 200 {
			t.Fatalf("GET %s without a client: %d %s", path, code, out)
		}
	}
}

// No answer of a list route, no state and no event holds a secret: the one an entry was added
// with, or the one an edit gave it.
func TestNoAnswerOrEventHoldsTheSecret(t *testing.T) {
	with, root := withServers(t)
	e := newEnv(t, with)
	st := standin.Start(t, standin.Options{})
	fp := st.Fingerprint()
	p := bridgetest.Connect(t, e.url, "B")
	first, _ := json.Marshal(p.Welcome())
	if !strings.Contains(string(first), `"servers":[{"id":"local"`) {
		t.Fatalf("the stream's snapshot: %s", first)
	}

	seen := []string{"snapshot: " + string(first)}
	call := func(method, path, body string) string {
		t.Helper()
		var b any
		if body != "" {
			b = body
		}
		status, out := p.Do(method, path, b)
		if status != 200 {
			t.Fatalf("%s %s: %d %s", method, path, status, out)
		}
		seen = append(seen, method+" "+path+": "+string(out))
		return string(out)
	}
	reads := func(id string) {
		t.Helper()
		call("GET", "/api/servers", "")
		call("GET", "/api/state", "")
		call("GET", "/api/servers/"+id+"/items", "")
	}
	full := []any{"name", "Studio", "address", st.URL(), "secret", standin.DefaultSecret, "selfSigned", true, "pin", fp}

	call("POST", "/api/servers/test", form(full...))
	call("POST", "/api/servers/test", form("address", st.URL(), "secret", standin.DefaultSecret, "selfSigned", true))
	call("POST", "/api/servers", form("name", "Studio", "address", st.URL(), "secret", standin.DefaultSecret, "selfSigned", true))
	id := decode[savedReply](t, call("POST", "/api/servers", form(full...))).Server.ID
	e.serverIn(id, servers.StateConnected)
	reads(id)
	call("POST", "/api/servers/"+id+"/test", "")
	call("POST", "/api/servers/"+id+"/test", form("secret", secondSecret))
	call("POST", "/api/servers/"+id+"/accept", form("fingerprint", fp))
	e.serverIn(id, servers.StateConnected)

	// The refusals: each call's body holds a secret, and its answer is kept with the others.
	refusal := func(status int, method, path, body string) {
		t.Helper()
		if !strings.Contains(body, standin.DefaultSecret) {
			t.Fatalf("%s %s: the body holds no secret", method, path)
		}
		got, out := p.Do(method, path, body)
		if got != status {
			t.Fatalf("%s %s: %d %s, want %d", method, path, got, out, status)
		}
		if len(out) == 0 {
			t.Fatalf("%s %s: an empty answer", method, path)
		}
		seen = append(seen, method+" "+path+" refused: "+string(out))
	}
	with1 := func(k string, v any) string { return form(append(append([]any{}, full...), k, v)...) }
	refusal(400, "POST", "/api/servers", with1("name", " "))
	refusal(400, "POST", "/api/servers", with1("address", "http://127.0.0.1:4748"))
	refusal(400, "POST", "/api/servers", with1("pin", "zz"))
	refusal(409, "POST", "/api/servers", with1("name", "Twice"))
	refusal(400, "POST", "/api/servers", `{"name":"Studio","secret":"`+standin.DefaultSecret+`",`)
	refusal(400, "POST", "/api/servers/test", `{"secret":"`+standin.DefaultSecret+`",`)
	refusal(400, "PATCH", "/api/servers/"+id, form("secret", standin.DefaultSecret+" with spaces"))
	refusal(400, "PATCH", "/api/servers/"+id, `{"secret":"`+standin.DefaultSecret+`",`)
	refusal(409, "PATCH", "/api/servers/local", form("secret", standin.DefaultSecret))
	refusal(404, "PATCH", "/api/servers/"+noSuchServer, form("secret", standin.DefaultSecret))
	refusal(404, "POST", "/api/servers/"+noSuchServer+"/test", form("secret", standin.DefaultSecret))
	e.serverIn(id, servers.StateConnected)

	// The server gets a new secret: the entry stops, and an edit gives it the new one.
	st.SetSecret(secondSecret)
	st.DropStreams()
	e.serverIn(id, servers.StateSecretNotAccepted)
	reads(id)
	call("POST", "/api/servers/"+id+"/test", "")
	if s := decode[savedReply](t, call("PATCH", "/api/servers/"+id, form("name", "Studio 2", "secret", secondSecret))); !s.Saved {
		t.Fatalf("edit with the new secret: %+v", s.Result)
	}
	e.serverIn(id, servers.StateConnected)
	reads(id)
	if got := listFile(t, *root); !strings.Contains(got, secondSecret) {
		t.Fatalf("the edit did not store the new secret: %s", got)
	}
	used := map[string]bool{}
	for _, r := range st.Requests() {
		used[r.Secret] = true
	}
	if !used[standin.DefaultSecret] || !used[secondSecret] {
		t.Fatal("the stand-in was not sent both secrets")
	}
	call("DELETE", "/api/servers/"+id, "")
	reads(servers.LocalID)

	// The events of the page's stream, up to the list without the entry.
	types := map[string]int{}
	for {
		raw := p.NextRaw()
		seen = append(seen, "event: "+raw)
		var ev struct {
			Type    string
			Servers []servers.View
		}
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			t.Fatalf("event %q: %v", raw, err)
		}
		types[ev.Type]++
		if ev.Type == "servers" && len(ev.Servers) == 1 {
			break
		}
	}
	if types["servers"] < 4 || types["server_state"] < 3 {
		t.Fatalf("events read: %v", types)
	}
	for _, text := range seen {
		for _, secret := range []string{standin.DefaultSecret, secondSecret} {
			if strings.Contains(text, secret) {
				t.Fatalf("a secret is in %s", text)
			}
		}
		if strings.Contains(text, `"secret"`) {
			t.Fatalf("a secret field is in %s", text)
		}
	}
}

// The snapshot, as GET /api/state and as a stream's second event, lists the servers.
func TestSnapshotHasServers(t *testing.T) {
	with, _ := withServers(t)
	e := newEnv(t, with)
	s := decode[savedReply](t, e.expect(200, "POST", "/api/servers", form("name", "Away", "address", "https://127.0.0.1:1", "secret", "abc", "force", true)))

	check := func(what string, raw []byte) {
		t.Helper()
		var snap struct {
			Servers []servers.View `json:"servers"`
			Notice  *string        `json:"notice"`
		}
		if err := json.Unmarshal(raw, &snap); err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		if len(snap.Servers) != 2 || snap.Servers[0].ID != servers.LocalID || !snap.Servers[0].Local ||
			snap.Servers[0].InstanceID != testLocalID || snap.Servers[1].ID != s.Server.ID || snap.Servers[1].Name != "Away" ||
			snap.Servers[1].Address != "https://127.0.0.1:1" || snap.Servers[1].State == "" {
			t.Fatalf("%s: servers %+v", what, snap.Servers)
		}
		if snap.Notice != nil {
			t.Fatalf("%s: the snapshot has a notice", what)
		}
	}
	check("GET /api/state", []byte(e.expect(200, "GET", "/api/state", "")))
	raw, _ := json.Marshal(bridgetest.Connect(t, e.url, "B").Welcome())
	check("the stream's snapshot", raw)

	// Without a manager: the local entry.
	raw = []byte(newEnv(t).expect(200, "GET", "/api/state", ""))
	var snap struct{ Servers []servers.View }
	if json.Unmarshal(raw, &snap) != nil || len(snap.Servers) != 1 || snap.Servers[0].ID != servers.LocalID {
		t.Fatalf("state without a manager: %s", raw)
	}
}

// The remote listener serves none of the list's routes: every one answers 404 there, with the
// secret and a known name.
func TestServersAnswer404OnRemoteHandler(t *testing.T) {
	with, _ := withServers(t)
	e := newEnv(t, with, withRemote)
	s := decode[savedReply](t, e.expect(200, "POST", "/api/servers", form("name", "Away", "address", "https://127.0.0.1:1", "secret", "abc", "force", true)))
	id := s.Server.ID
	for _, p := range RemoteRoutes {
		if strings.Contains(p, "/api/servers") {
			t.Fatalf("the table of the remote listener has %q", p)
		}
	}
	h := e.s.RemoteHandler()
	n := 0
	for _, p := range e.s.routes().patterns {
		method, path, _ := strings.Cut(p, " ")
		if !strings.HasPrefix(path, "/api/servers") {
			continue
		}
		n++
		path = strings.ReplaceAll(path, "{id}", id)
		wantReply(t, remoteDo(h, method, path, testHost, testSecret), p, 404, "")
		wantReply(t, remoteDo(h, method, strings.ReplaceAll(path, id, servers.LocalID), testHost, testSecret), p, 404, "")
	}
	if n != 8 {
		t.Fatalf("%d list routes registered, want 8", n)
	}
	if l := e.serverList(); len(l.Servers) != 2 {
		t.Fatalf("list after the calls: %+v", l)
	}
}

// A body past the limit is refused and nothing is saved.
func TestServerRoutesLimitTheBody(t *testing.T) {
	with, root := withServers(t)
	e := newEnv(t, with)
	file := func() string {
		b, _ := os.ReadFile(filepath.Join(*root, servers.FileName))
		return string(b)
	}
	before := file()
	big := form("name", strings.Repeat("n", 1<<20), "address", "https://mac.local:4748", "secret", secondSecret, "force", true)
	for _, c := range [][2]string{
		{"POST", "/api/servers"},
		{"PATCH", "/api/servers/" + noSuchServer},
		{"POST", "/api/servers/test"},
		{"POST", "/api/servers/" + noSuchServer + "/test"},
		{"POST", "/api/servers/" + noSuchServer + "/accept"},
	} {
		if code, out := e.do(c[0], c[1], big); code != 400 || !strings.Contains(out, "request body too large") {
			t.Fatalf("%s %s with a body of 1 MB: %d %s, want it refused for its size", c[0], c[1], code, cut(out, 200))
		}
	}
	if got := file(); got != before {
		t.Fatalf("the list's file changed: %q, was %q", cut(got, 200), cut(before, 200))
	}
	if l := e.serverList(); len(l.Servers) != 1 {
		t.Fatalf("the list has %d entries, want the local one alone", len(l.Servers))
	}
}
