package servers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/servers/standin"
)

func ptr[T any](v T) *T { return &v }

// fileEntries reads the list file of root; nil when there is none.
func fileEntries(t *testing.T, root string) []Entry {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, FileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var f listFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f.Servers
}

// TestManagerViews: the local entry is the first of every list, also of a manager that is nil.
func TestManagerViews(t *testing.T) {
	var none *Manager
	want := View{ID: LocalID, Local: true, Name: LocalName, State: StateConnected}
	if got := none.Views(); len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Errorf("a nil manager's views %+v", got)
	}
	if none.Notice() != "" {
		t.Error("a nil manager has a notice")
	}
	b, _ := json.Marshal(none.Views())
	if string(b) != `[{"id":"local","local":true,"name":"This computer","state":"connected"}]` {
		t.Errorf("the local entry on the wire: %s", b)
	}

	r := startRig(t, nil)
	want.Version, want.InstanceID = "v-local", testLocalID
	if got := r.m.Views(); len(got) != 1 || !reflect.DeepEqual(got[0], want) {
		t.Errorf("views without entries %+v", got)
	}
	if v, ok := r.m.View(LocalID); !ok || !reflect.DeepEqual(v, want) {
		t.Errorf("View(local): %+v, %v", v, ok)
	}
	if v, ok := r.m.ByInstance(testLocalID); !ok || v.ID != LocalID {
		t.Errorf("ByInstance of the local id: %+v, %v", v, ok)
	}
	if _, ok := r.m.ByInstance(""); ok {
		t.Error("ByInstance of no id")
	}
	if _, ok := r.m.ByInstance(testOtherID); ok {
		t.Error("ByInstance of an unknown id")
	}
	if _, ok := r.m.View("s_000000000000"); ok {
		t.Error("View of an unknown id")
	}
	if _, ok := r.m.Lists(LocalID); ok {
		t.Error("Lists of the local entry")
	}
	if r.m.Notice() != "" || r.m.Counts != nil {
		t.Errorf("notice %q, Counts set %v", r.m.Notice(), r.m.Counts != nil)
	}
	// The view is the wire shape, and nothing of it is a secret.
	typ := reflect.TypeOf(View{})
	for i := range typ.NumField() {
		if f := typ.Field(i); strings.Contains(strings.ToLower(f.Name+f.Tag.Get("json")), "secret") {
			t.Errorf("View has the field %s", f.Name)
		}
	}
}

// TestManagerAdd: a failed test saves nothing; a passed one saves and connects; "anyway" saves
// and sends no request before the connect.
func TestManagerAdd(t *testing.T) {
	ctx := context.Background()
	s := standin.Start(t, standin.Options{})
	root := t.TempDir()
	r := openRig(t, root, nil) // not started: nothing connects yet

	// The form's checks come first, and send nothing.
	for want, in := range map[error]Input{
		ErrBadName:    {Name: " ", Address: s.URL(), Secret: "x"},
		ErrBadAddress: {Name: "Studio", Address: "http://127.0.0.1:4748", Secret: "x"},
		ErrBadSecret:  {Name: "Studio", Address: s.URL(), Secret: "two words"},
		ErrBadPin:     {Name: "Studio", Address: s.URL(), Secret: "x", SelfSigned: true, Pin: "AB:CD"},
	} {
		for _, force := range []bool{false, true} {
			if _, saved, res, err := r.m.Add(ctx, in, force); !errors.Is(err, want) || saved || res != nil {
				t.Errorf("Add(%+v, force %v): saved %v, result %+v, err %v; want %v", in, force, saved, res, err, want)
			}
		}
	}
	if s.Handshakes() != 0 {
		t.Fatalf("%d handshakes for forms that are wrong", s.Handshakes())
	}

	// A test that fails saves nothing.
	bad := form("Studio", s)
	bad.Secret = "not-the-secret"
	v, saved, res, err := r.m.Add(ctx, bad, false)
	if err != nil || saved || res == nil || res.Outcome != OutcomeSecretRefused || res.OK || v.ID != "" {
		t.Fatalf("Add with a wrong secret: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	noPin := form("Studio", s)
	noPin.Pin = ""
	requests := len(s.Requests())
	if _, saved, res, err = r.m.Add(ctx, noPin, false); err != nil || saved || res == nil || res.Outcome != OutcomeFingerprint || res.Fingerprint != s.Fingerprint() {
		t.Fatalf("Add without a fingerprint: saved %v, result %+v, err %v", saved, res, err)
	}
	if got := len(s.Requests()); got != requests {
		t.Errorf("%d requests before a fingerprint was accepted", got-requests)
	}
	if len(r.m.Views()) != 1 || fileEntries(t, root) != nil || len(r.eventsOf("servers")) != 0 {
		t.Fatalf("after failed tests: views %+v, file %+v, events %d", r.m.Views(), fileEntries(t, root), len(r.eventsOf("servers")))
	}

	// "Anyway": saved without a request.
	handshakes, requests := s.Handshakes(), len(s.Requests())
	v, saved, res, err = r.m.Add(ctx, bad, true)
	if err != nil || !saved || res != nil || !entryID.MatchString(v.ID) || v.State != StateConnecting || v.InstanceID != "" {
		t.Fatalf("Add anyway: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	time.Sleep(quiet)
	if s.Handshakes() != handshakes || len(s.Requests()) != requests || r.dials.Load() != 2 {
		t.Errorf("a forced save sent something: %d handshakes, %d requests more", s.Handshakes()-handshakes, len(s.Requests())-requests)
	}
	if got := fileEntries(t, root); len(got) != 1 || got[0].ID != v.ID || got[0].Secret != "not-the-secret" {
		t.Errorf("file %+v", got)
	}
	// A second entry with the address is refused, tested or not.
	var dup *DuplicateError
	for _, force := range []bool{false, true} {
		if _, saved, _, err := r.m.Add(ctx, form("Again", s), force); !errors.As(err, &dup) || dup.Name != "Studio" || saved {
			t.Errorf("Add of the address again (force %v): saved %v, err %v", force, saved, err)
		}
	}
	if err := r.m.Remove(v.ID); err != nil {
		t.Fatal(err)
	}

	// A test that passes saves, with the server's id.
	v, saved, res, err = r.m.Add(ctx, form("  Studio  ", s), false)
	if err != nil || !saved || res == nil || !res.OK || res.Outcome != OutcomeConnected {
		t.Fatalf("Add: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	if v.Name != "Studio" || v.Address != s.URL() || !v.SelfSigned || v.Pin != s.Fingerprint() ||
		v.InstanceID != standin.DefaultInstanceID || v.State != StateConnecting || v.Local {
		t.Errorf("view %+v", v)
	}
	waitFor(t, "three servers events", func() bool { return len(r.eventsOf("servers")) == 3 })
	ev := r.eventsOf("servers")[2]
	list, _ := ev["servers"].([]any)
	if notice, has := ev["notice"]; !has || notice != "" || len(list) != 2 ||
		list[0].(map[string]any)["id"] != LocalID || list[1].(map[string]any)["id"] != v.ID {
		t.Errorf("servers event %v", ev)
	}
	requests = len(s.Requests())
	time.Sleep(quiet)
	if got := len(s.Requests()); got != requests {
		t.Errorf("%d requests before Start", got-requests)
	}
	r.m.Start()
	r.waitState(v.ID, StateConnected)
	r.m.Start() // a second Start does nothing
	if got := r.callsOf(v.ID); !slices.Equal(got, []string{"snapshot", "state connecting > connected"}) {
		t.Errorf("hooks %q", got)
	}
}

// TestManagerEdit: the id stays; another identity is refused; the name alone does not reconnect.
func TestManagerEdit(t *testing.T) {
	ctx := context.Background()
	s := standin.Start(t, standin.Options{})
	other := standin.Start(t, standin.Options{InstanceID: testOtherID})
	root := t.TempDir()
	r := openRig(t, root, nil)
	r.m.Start()
	v, saved, _, err := r.m.Add(ctx, form("Studio", s), false)
	if err != nil || !saved {
		t.Fatal(saved, err)
	}
	id := v.ID
	r.waitState(id, StateConnected)

	if _, _, _, err := r.m.Edit(ctx, LocalID, Patch{Name: ptr("Mine")}, false); !errors.Is(err, ErrLocalEntry) {
		t.Errorf("Edit of the local entry: %v", err)
	}
	if _, _, _, err := r.m.Edit(ctx, "s_000000000000", Patch{Name: ptr("x")}, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("Edit of no entry: %v", err)
	}
	for want, p := range map[error]Patch{
		ErrBadName: {Name: ptr("")}, ErrBadAddress: {Address: ptr("")}, ErrBadPin: {Pin: ptr("AB")},
		ErrBadSecret: {Secret: ptr("two words")},
	} {
		if _, saved, _, err := r.m.Edit(ctx, id, p, true); !errors.Is(err, want) || saved {
			t.Errorf("Edit(%+v): saved %v, err %v; want %v", p, saved, err, want)
		}
	}

	// The name alone, and the whole form with nothing but the name changed: no test, no reconnect.
	requests := len(s.Requests())
	for _, p := range []Patch{
		{Name: ptr("Studio 2")},
		{Name: ptr("Studio 3"), Address: ptr(strings.ToUpper(s.URL()[:5]) + s.URL()[5:] + "/"), Secret: ptr(""),
			SelfSigned: ptr(true), Pin: ptr(strings.ToLower(s.Fingerprint()))},
		{},
	} {
		v, saved, res, err := r.m.Edit(ctx, id, p, false)
		if err != nil || !saved || res != nil || v.ID != id || v.State != StateConnected {
			t.Fatalf("Edit(%+v): %+v, saved %v, result %+v, err %v", p, v, saved, res, err)
		}
		if p.Name != nil && v.Name != *p.Name {
			t.Errorf("name %q after the edit to %q", v.Name, *p.Name)
		}
	}
	time.Sleep(quiet)
	if got := r.callsOf(id); !slices.Equal(got, []string{"snapshot", "state connecting > connected"}) || s.Streams() != 1 || len(s.Requests()) != requests {
		t.Errorf("after edits of the name: hooks %q, %d streams, requests %q", got, s.Streams(), paths(s)[requests:])
	}
	if got := fileEntries(t, root); len(got) != 1 || got[0].ID != id || got[0].Name != "Studio 3" || got[0].Secret != standin.DefaultSecret {
		t.Errorf("file %+v", got)
	}
	waitFor(t, "the servers events", func() bool { return len(r.eventsOf("servers")) == 4 })
	if name := r.eventsOf("servers")[2]["servers"].([]any)[1].(map[string]any)["name"]; name != "Studio 3" {
		t.Errorf("the edit's event has the name %v", name)
	}

	// Another server at the new address: refused, and nothing changes.
	toOther := Patch{Address: ptr(other.URL()), Pin: ptr(other.Fingerprint())}
	v, saved, res, err := r.m.Edit(ctx, id, toOther, false)
	if err != nil || saved || res == nil || res.Outcome != OutcomeAnotherServer || v.ID != "" {
		t.Fatalf("Edit to another server: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	if v := r.view(id); v.Address != s.URL() || v.State != StateConnected || s.Streams() != 1 {
		t.Errorf("after the refused edit: %+v", v)
	}
	// A wrong secret: refused by the test.
	if _, saved, res, err = r.m.Edit(ctx, id, Patch{Secret: ptr("wrong")}, false); err != nil || saved || res == nil || res.Outcome != OutcomeSecretRefused {
		t.Fatalf("Edit to a wrong secret: saved %v, result %+v, err %v", saved, res, err)
	}
	if got := fileEntries(t, root); got[0].Secret != standin.DefaultSecret || got[0].Address != s.URL() {
		t.Errorf("file after refused edits %+v", got)
	}

	// Saved anyway, the identity is enforced at the connect: the entry keeps its id and its
	// server's id, and the other server gets a hello and no more.
	v, saved, res, err = r.m.Edit(ctx, id, toOther, true)
	if err != nil || !saved || res != nil || v.ID != id || v.Address != other.URL() || v.State != StateConnecting ||
		v.InstanceID != standin.DefaultInstanceID || v.Version != "" || len(v.Agents) != 0 {
		t.Fatalf("Edit anyway: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	if w := r.waitState(id, StateAnotherServer); w.Detail != "Another server answers at this address" {
		t.Errorf("view %+v", w)
	}
	waitFor(t, "the old stream's end", func() bool { return s.Streams() == 0 })
	staysQuiet(t, other)
	if got := paths(other); !slices.Equal(got[len(got)-1:], []string{HelloPath}) || other.Streams() != 0 {
		t.Errorf("the other server's requests %q", got)
	}

	// Back to its own server, tested: connected again, and Back says so.
	v, saved, res, err = r.m.Edit(ctx, id, Patch{Address: ptr(s.URL()), Pin: ptr(s.Fingerprint())}, false)
	if err != nil || !saved || res == nil || !res.OK || v.ID != id {
		t.Fatalf("Edit back: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	r.waitState(id, StateConnected)
	if got, want := r.callsOf(id), []string{
		"snapshot", "state connecting > connected", "state connected > connecting", "state connecting > another_server",
		"state another_server > connecting", "snapshot", "back", "state connecting > connected",
	}; !slices.Equal(got, want) {
		t.Errorf("hooks %q; want %q", got, want)
	}

	// Without the box the pin goes.
	r2 := openRig(t, t.TempDir(), func(o *Options) { o.Roots = s.Pool() })
	r2.m.Start()
	id2 := r2.add(form("Studio", s))
	r2.waitState(id2, StateConnected)
	v, saved, res, err = r2.m.Edit(ctx, id2, Patch{SelfSigned: ptr(false)}, false)
	if err != nil || !saved || res == nil || !res.OK || v.Pin != "" || v.SelfSigned {
		t.Fatalf("Edit to the box off: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	r2.waitState(id2, StateConnected)
}

// TestManagerRemove: the stream ends and the server is sent nothing; the entry is gone from the
// list, the file and the events.
func TestManagerRemove(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	root := t.TempDir()
	r := openRig(t, root, nil)
	r.m.Start()
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)
	requests := len(s.Requests())

	if err := r.m.Remove(LocalID); !errors.Is(err, ErrLocalEntry) {
		t.Errorf("Remove of the local entry: %v", err)
	}
	if err := r.m.Remove("s_000000000000"); !errors.Is(err, ErrNotFound) {
		t.Errorf("Remove of no entry: %v", err)
	}
	if err := r.m.Remove(id); err != nil {
		t.Fatal(err)
	}
	if views := r.m.Views(); len(views) != 1 || views[0].ID != LocalID {
		t.Errorf("views after the remove %+v", views)
	}
	if _, ok := r.m.View(id); ok {
		t.Error("the removed entry has a view")
	}
	if _, err := r.m.Do(context.Background(), id, http.MethodGet, StatePath, nil, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("Do for the removed entry: %v", err)
	}
	if _, err := r.m.TestSaved(context.Background(), id, Patch{}); !errors.Is(err, ErrNotFound) {
		t.Errorf("TestSaved for the removed entry: %v", err)
	}
	if _, err := r.m.Accept(id, s.Fingerprint()); !errors.Is(err, ErrNotFound) {
		t.Errorf("Accept for the removed entry: %v", err)
	}
	if err := r.m.Remove(id); !errors.Is(err, ErrNotFound) {
		t.Errorf("a second Remove: %v", err)
	}
	waitFor(t, "the stream's end", func() bool { return s.Streams() == 0 })
	r.waitCall(id, "removed", 1)
	staysQuiet(t, s)
	if got := paths(s)[requests:]; len(got) != 0 {
		t.Errorf("requests after the remove: %q", got)
	}
	if got := r.callsOf(id); !slices.Equal(got, []string{"snapshot", "state connecting > connected", "removed"}) {
		t.Errorf("hooks %q; want Removed as the last and no state after it", got)
	}
	if got := fileEntries(t, root); len(got) != 0 {
		t.Errorf("file %+v", got)
	}
	waitFor(t, "the remove's event", func() bool { return len(r.eventsOf("servers")) == 2 })
	if list := r.eventsOf("servers")[1]["servers"].([]any); len(list) != 1 {
		t.Errorf("the remove's event lists %v", list)
	}
	if got := r.stateEvents(id); !slices.Equal(got, []string{"connected"}) {
		t.Errorf("server_state events %q", got)
	}

	// The same server again is a new entry, connected for the first time: no Back.
	again := r.add(form("Studio", s))
	r.waitState(again, StateConnected)
	if again == id || r.count(again, "back") != 0 {
		t.Errorf("the new entry: id %s (was %s), hooks %q", again, id, r.callsOf(again))
	}
}

// TestManagerRestart: a second manager on the same folder has the same entries and connects
// them; Open alone dials nothing.
func TestManagerRestart(t *testing.T) {
	ctx := context.Background()
	s := standin.Start(t, standin.Options{})
	down := standin.Refused(t)
	root := t.TempDir()
	r := openRig(t, root, nil)
	r.m.Start()
	v, saved, _, err := r.m.Add(ctx, form("Studio", s), false)
	if err != nil || !saved {
		t.Fatal(saved, err)
	}
	other := r.add(Input{Name: "Down", Address: down, Secret: "s3cret"})
	r.waitState(v.ID, StateConnected)
	r.waitState(other, StateUnreachable)
	before := r.m.Views()
	r.m.Close()
	waitFor(t, "the stream's end", func() bool { return s.Streams() == 0 })
	r.m.Close() // a second Close does nothing
	if _, saved, _, err := r.m.Add(ctx, Input{Name: "Late", Address: "https://late.example:1", Secret: "x"}, true); err != nil || !saved {
		t.Errorf("Add after Close: saved %v, err %v", saved, err)
	}
	if err := r.m.Remove(r.m.Views()[3].ID); err != nil {
		t.Error(err)
	}

	handshakes, requests := s.Handshakes(), len(s.Requests())
	r2 := openRig(t, root, nil)
	views := r2.m.Views()
	if len(views) != 3 || views[1].ID != v.ID || views[2].ID != other {
		t.Fatalf("views of the second manager %+v", views)
	}
	for i, w := range views[1:] {
		want := before[i+1]
		want.State, want.Detail, want.Version, want.Agents = StateConnecting, "", "", nil
		if !reflect.DeepEqual(w, want) {
			t.Errorf("view %d before Start: %+v; want %+v", i+1, w, want)
		}
	}
	time.Sleep(quiet)
	if s.Handshakes() != handshakes || len(s.Requests()) != requests || r2.dials.Load() != 0 {
		t.Fatalf("Open dialed: %d dials", r2.dials.Load())
	}
	r2.m.Start()
	r2.waitState(v.ID, StateConnected)
	r2.waitState(other, StateUnreachable)
	if got := r2.callsOf(v.ID); !slices.Equal(got, []string{"snapshot", "state connecting > connected"}) {
		t.Errorf("hooks of the second manager %q; want no Back: it is another process", got)
	}
}

// TestManagerUnreadableList: the list's notice is the manager's, and the manager works.
func TestManagerUnreadableList(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, FileName), []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := openRig(t, root, nil)
	if n := r.m.Notice(); !strings.Contains(n, "set aside") || len(r.m.Views()) != 1 {
		t.Fatalf("notice %q, views %+v", n, r.m.Views())
	}
	r.m.Start()
	id := r.add(Input{Name: "Studio", Address: "https://studio.example:4748", Secret: "s3cret", SelfSigned: true})
	r.waitState(id, StateFingerprintNotAccepted)
	waitFor(t, "the servers event", func() bool { return len(r.eventsOf("servers")) == 1 })
	if notice := r.eventsOf("servers")[0]["notice"]; notice != r.m.Notice() {
		t.Errorf("the event's notice %q", notice)
	}
	if _, err := Open(Options{}); err == nil {
		t.Error("Open without a folder")
	}
}

// TestManagerTestSaved: the stored values with the given ones in their place; only a test of
// what is stored gets the connection going.
func TestManagerTestSaved(t *testing.T) {
	ctx := context.Background()
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	if _, err := r.m.TestSaved(ctx, LocalID, Patch{}); !errors.Is(err, ErrLocalEntry) {
		t.Errorf("TestSaved of the local entry: %v", err)
	}
	in := form("Studio", s)
	in.Secret = "old-secret"
	id := r.add(in)
	r.waitState(id, StateSecretNotAccepted)
	staysQuiet(t, s)
	requests := len(s.Requests())

	// The form's secret in place of the stored one: the test passes, the entry stays as it is.
	res, err := r.m.TestSaved(ctx, id, Patch{Secret: ptr(standin.DefaultSecret)})
	if err != nil || !res.OK {
		t.Fatalf("TestSaved with the right secret: %+v, %v", res, err)
	}
	time.Sleep(quiet)
	if got := paths(s)[requests:]; !slices.Equal(got, []string{HelloPath, StatePath}) || r.view(id).State != StateSecretNotAccepted {
		t.Errorf("after the test of a changed form: requests %q, state %q", got, r.view(id).State)
	}
	if res, err = r.m.TestSaved(ctx, id, Patch{Address: ptr("nonsense")}); err != nil || res.Outcome != OutcomeBadAddress {
		t.Errorf("TestSaved with a bad address: %+v, %v", res, err)
	}
	if res, err = r.m.TestSaved(ctx, id, Patch{Pin: ptr("")}); err != nil || res.Outcome != OutcomeFingerprint {
		t.Errorf("TestSaved without the pin: %+v, %v", res, err)
	}
	if res = r.m.Test(ctx, pinned(s)); !res.OK {
		t.Errorf("Test of an unsaved form: %+v", res)
	}

	// The stored values, given or not: the test, then one more attempt.
	requests = len(s.Requests())
	for i, over := range []Patch{{}, {Name: ptr("ignored"), Address: ptr(""), Secret: ptr(" "), SelfSigned: ptr(true), Pin: ptr(s.Fingerprint())}} {
		if res, err = r.m.TestSaved(ctx, id, over); err != nil || res.Outcome != OutcomeSecretRefused {
			t.Fatalf("TestSaved: %+v, %v", res, err)
		}
		waitFor(t, "the retry's hello", func() bool { return len(s.Requests()) == requests+2*(i+1) })
		r.waitState(id, StateSecretNotAccepted)
	}
	staysQuiet(t, s)
	if got := r.count(id, "state secret_not_accepted > connecting"); got != 2 {
		t.Errorf("%d retries; want 2. Hooks: %q", got, r.callsOf(id))
	}

	// After the cure on the other machine a test connects.
	s.SetSecret("old-secret")
	if res, err = r.m.TestSaved(ctx, id, Patch{}); err != nil || !res.OK {
		t.Fatalf("TestSaved after the cure: %+v, %v", res, err)
	}
	r.waitState(id, StateConnected)
	// A test of a connected entry leaves its stream alone.
	if res, err = r.m.TestSaved(ctx, id, Patch{}); err != nil || !res.OK {
		t.Fatalf("TestSaved while connected: %+v, %v", res, err)
	}
	time.Sleep(quiet)
	if n := r.count(id, "snapshot"); n != 1 || s.Streams() != 1 {
		t.Errorf("%d snapshots, %d streams after a test while connected", n, s.Streams())
	}
}

// TestManagerNoSecretAnywhere: no event, no view and no result holds a secret, the stored one or
// one given in an edit.
func TestManagerNoSecretAnywhere(t *testing.T) {
	ctx := context.Background()
	const first, second = "the-first-secret-AAAA1111", "the-second-secret-BBBB2222"
	s := standin.Start(t, standin.Options{Secret: first})
	r := startRig(t, nil)
	var said [][]byte
	say := func(v any) {
		t.Helper()
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		said = append(said, b)
	}
	in := form("Studio", s)
	in.Secret = second
	_, _, res, err := r.m.Add(ctx, in, false) // refused: the secret is the wrong one
	say(res)
	say(err)
	in.Secret = first
	v, saved, res, err := r.m.Add(ctx, in, false)
	if err != nil || !saved {
		t.Fatal(saved, err)
	}
	say(v)
	say(res)
	id := v.ID
	r.waitState(id, StateConnected)

	s.SetSecret(second)
	s.DropStreams()
	say(r.waitState(id, StateSecretNotAccepted))
	res2, err := r.m.TestSaved(ctx, id, Patch{})
	say(res2)
	say(err)
	say(r.m.Test(ctx, Target{Address: s.URL(), Secret: second, SelfSigned: true, Pin: s.Fingerprint()}))
	v, saved, res, err = r.m.Edit(ctx, id, Patch{Secret: ptr(second)}, false)
	if err != nil || !saved {
		t.Fatal(saved, err)
	}
	say(v)
	say(res)
	say(r.waitState(id, StateConnected))
	v, err = r.m.Accept(id, s.Fingerprint())
	say(v)
	say(err)
	say(r.waitState(id, StateConnected))
	v, _, _, _ = r.m.Edit(ctx, id, Patch{Name: ptr("Renamed")}, true)
	say(v)
	say(r.m.Views())
	l, _ := r.m.Lists(id)
	say(l)
	if _, _, _, err = r.m.Add(ctx, in, true); err == nil {
		t.Error("a second entry with the address was saved")
	}
	say(err.Error())
	if err := r.m.Remove(id); err != nil {
		t.Fatal(err)
	}
	say(r.m.Views())

	waitFor(t, "the events", func() bool { return len(r.eventsOf("servers")) == 5 })
	r.mu.Lock()
	events := slices.Clone(r.events)
	r.mu.Unlock()
	if len(events) < 9 {
		t.Errorf("only %d events", len(events))
	}
	for _, b := range append(said, events...) {
		for _, secret := range []string{first, second} {
			if bytes.Contains(b, []byte(secret)) {
				t.Errorf("a secret is in %s", b)
			}
		}
		if bytes.Contains(bytes.ToLower(b), []byte(`"secret"`)) {
			t.Errorf("a secret field is in %s", b)
		}
	}
}

// TestManagerEvents: the two events' shapes, and their order: each state after the one before.
func TestManagerEvents(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)
	s.Stop()
	r.waitState(id, StateUnreachable)
	if _, err := r.m.Accept(id, pinA); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the accept's event", func() bool { return len(r.eventsOf("servers")) == 2 })
	if err := r.m.Remove(id); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the remove's event", func() bool { return len(r.eventsOf("servers")) == 3 })

	r.mu.Lock()
	events := slices.Clone(r.events)
	r.mu.Unlock()
	var order []string
	for _, b := range events {
		var ev struct {
			Type    string
			Servers []View
			Notice  *string
			Server  *View
		}
		if err := json.Unmarshal(b, &ev); err != nil {
			t.Fatal(err)
		}
		var keys map[string]json.RawMessage
		_ = json.Unmarshal(b, &keys)
		switch ev.Type {
		case "servers":
			if len(keys) != 3 || ev.Notice == nil || len(ev.Servers) == 0 || ev.Servers[0].ID != LocalID {
				t.Errorf("servers event %s", b)
			}
			order = append(order, "servers")
		case "server_state":
			if len(keys) != 2 || ev.Server == nil || ev.Server.ID != id || ev.Server.Name != "Studio" || ev.Server.Address != s.URL() {
				t.Errorf("server_state event %s", b)
			}
			order = append(order, string(ev.Server.State))
		default:
			t.Errorf("event %s", b)
		}
	}
	// add; connected; the outage, with a second event when its detail became the refused
	// port's; accept; what the accepted pin leads to, if the remove did not come first; remove.
	want := []string{"servers", "connected", "unreachable", "servers", "servers"}
	got := slices.DeleteFunc(slices.Clone(order), func(s string) bool { return s == "certificate_changed" || s == "unreachable" })
	if !slices.Equal(got, []string{"servers", "connected", "servers", "servers"}) || !slices.Contains(order, "unreachable") ||
		slices.Index(order, "unreachable") != 2 {
		t.Errorf("events in the order %q; want about %q", order, want)
	}
}

// TestManagerNotifyOutsideLock: Notify is called with no lock of the manager held, from one
// goroutine at a time: a Notify under the bridge's lock, and a snapshot under the same lock that
// calls Views, do not block each other.
func TestManagerNotifyOutsideLock(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	var bridge sync.Mutex // what the bridge holds in Broadcast, and while it builds a snapshot
	var m *Manager
	var notified, inNotify, overlaps int
	r := openRig(t, t.TempDir(), func(o *Options) {
		o.Notify = func(ev any) {
			bridge.Lock()
			defer bridge.Unlock()
			if inNotify++; inNotify > 1 {
				overlaps++
			}
			_ = m.Views()
			_, _ = m.View(LocalID)
			_ = m.Notice()
			time.Sleep(time.Millisecond)
			notified++
			inNotify--
		}
	})
	m = r.m
	m.Start()

	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { // the bridge sending a page its snapshot, again and again
		defer wg.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			bridge.Lock()
			_ = m.Views()
			bridge.Unlock()
		}
	}()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for i := range 20 {
			id := r.add(form("Studio", s))
			if i%2 == 0 {
				r.waitState(id, StateConnected)
			}
			if _, _, _, err := m.Edit(context.Background(), id, Patch{Name: ptr("Renamed")}, false); err != nil {
				t.Error(err)
			}
			if err := m.Remove(id); err != nil {
				t.Error(err)
			}
		}
	}()
	select {
	case <-finished:
	case <-time.After(30 * time.Second):
		t.Fatal("the manager and its Notify block each other")
	}
	waitFor(t, "the events", func() bool {
		bridge.Lock()
		defer bridge.Unlock()
		return notified >= 60
	})
	close(done)
	wg.Wait()
	bridge.Lock()
	defer bridge.Unlock()
	if overlaps != 0 {
		t.Errorf("Notify ran %d times beside itself", overlaps)
	}
}

// TestManagerCloseEndsEverything: after Close no stream is open, nothing retries, and neither a
// hook nor Notify is called.
func TestManagerCloseEndsEverything(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	down := r.add(Input{Name: "Down", Address: standin.Refused(t), Secret: "s3cret"})
	r.waitState(id, StateConnected)
	r.waitState(down, StateUnreachable)
	r.m.Close()
	waitFor(t, "the stream's end", func() bool { return s.Streams() == 0 })
	r.mu.Lock()
	calls, events := len(r.calls), len(r.events)
	r.mu.Unlock()
	dials := r.dials.Load()
	s.Send(map[string]any{"type": "late"})
	time.Sleep(quiet)
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.calls) != calls || len(r.events) != events || r.dials.Load() != dials {
		t.Errorf("after Close: %d hook calls, %d events, %d dials more", len(r.calls)-calls, len(r.events)-events, r.dials.Load()-dials)
	}
}

// TestManagerRetry: Retry ends a back-off wait at once; a connected entry, one that waits for
// the user, the local entry and an unknown id are left alone.
func TestManagerRetry(t *testing.T) {
	// The back-off is longer than the test: an attempt after an outage comes from Retry alone.
	long := func(o *Options) { o.Timing.Backoff = []time.Duration{time.Minute} }
	waiting := func(r *rig, id string) {
		t.Helper()
		waitFor(t, "the conn's wait", func() bool {
			r.m.mu.Lock()
			defer r.m.mu.Unlock()
			c := r.m.conns[id]
			return c != nil && c.waiting
		})
	}

	t.Run("a back-off wait ends", func(t *testing.T) {
		s := standin.Start(t, standin.Options{})
		r := startRig(t, long)
		id := r.add(form("Studio", s))
		r.waitState(id, StateConnected)

		// Connected: nothing happens.
		dials, requests := r.dials.Load(), len(s.Requests())
		r.m.Retry(id)
		staysQuiet(t, s)
		if r.dials.Load() != dials || len(s.Requests()) != requests || s.Streams() != 1 || r.view(id).State != StateConnected {
			t.Errorf("Retry of a connected entry: %d dials, requests %q, %d streams, state %q",
				r.dials.Load()-dials, paths(s)[requests:], s.Streams(), r.view(id).State)
		}

		for _, outage := range []struct {
			name      string
			down, up  func()
			backCalls int
		}{
			{"the server stopped and started", s.Stop, s.Restart, 1},
			{"the stream dropped", s.DropStreams, func() {}, 2},
		} {
			outage.down()
			r.waitState(id, StateUnreachable)
			waiting(r, id)
			outage.up()
			dials = r.dials.Load()
			time.Sleep(quiet)
			if r.dials.Load() != dials || r.view(id).State != StateUnreachable {
				t.Fatalf("%s: %d dials and state %q during the back-off", outage.name, r.dials.Load()-dials, r.view(id).State)
			}
			start := time.Now()
			r.m.Retry(id)
			r.waitState(id, StateConnected)
			if d := time.Since(start); d > 5*time.Second {
				t.Errorf("%s: connected %v after Retry", outage.name, d)
			}
			r.waitCall(id, "back", outage.backCalls)
		}
		// One Retry is one attempt.
		if got := r.count(id, "snapshot"); got != 3 {
			t.Errorf("%d snapshots; want 3. Hooks: %q", got, r.callsOf(id))
		}
	})

	t.Run("a second Retry during the attempt does nothing", func(t *testing.T) {
		s := standin.Start(t, standin.Options{})
		r := startRig(t, long)
		id := r.add(form("Studio", s))
		r.waitState(id, StateConnected)
		s.Stop()
		r.waitState(id, StateUnreachable)
		waiting(r, id)
		dials := r.dials.Load()
		for range 5 {
			r.m.Retry(id)
		}
		// The server is still down: the attempt fails and the entry waits again, for a minute.
		waitFor(t, "the attempt", func() bool { return r.dials.Load() > dials })
		waiting(r, id)
		time.Sleep(quiet)
		if got := r.dials.Load() - dials; got != 1 || r.view(id).State != StateUnreachable {
			t.Errorf("%d dials after five calls of Retry, state %q; want 1 and unreachable", got, r.view(id).State)
		}
	})

	t.Run("an entry that waits for the user stays", func(t *testing.T) {
		s := standin.Start(t, standin.Options{})
		r := startRig(t, long)
		in := form("Studio", s)
		in.Secret = "old-secret"
		id := r.add(in)
		r.waitState(id, StateSecretNotAccepted)
		waiting(r, id)
		dials, requests := r.dials.Load(), len(s.Requests())
		r.m.Retry(id)
		staysQuiet(t, s)
		if r.dials.Load() != dials || len(s.Requests()) != requests || r.view(id).State != StateSecretNotAccepted ||
			r.count(id, "state secret_not_accepted > connecting") != 0 {
			t.Errorf("Retry of a stopped entry: %d dials, requests %q, hooks %q",
				r.dials.Load()-dials, paths(s)[requests:], r.callsOf(id))
		}
	})

	t.Run("the local entry, an unknown id, no manager", func(t *testing.T) {
		r := startRig(t, long)
		r.m.Retry(LocalID)
		r.m.Retry("s_nobody")
		r.m.Retry("")
		(*Manager)(nil).Retry("s_nobody")
		if r.dials.Load() != 0 {
			t.Errorf("%d dials", r.dials.Load())
		}
	})
}

// TestStateStopped: Stopped is true for the states that wait for the user and for no other.
func TestStateStopped(t *testing.T) {
	want := map[State]bool{
		StateConnecting:             false,
		StateConnected:              false,
		StateUnreachable:            false,
		StateCertificateNotAccepted: false,
		StateSecretNotAccepted:      true,
		StateFingerprintNotAccepted: true,
		StateCertificateChanged:     true,
		StateNameNotKnown:           true,
		StateNotAIWB:                true,
		StateTooOld:                 true,
		StateAnotherServer:          true,
	}
	if len(want) != 11 {
		t.Fatalf("%d states in the table; want the eleven", len(want))
	}
	for s, stopped := range want {
		if s.Stopped() != stopped || s.Stopped() != s.stops() {
			t.Errorf("%q: Stopped %v, stops %v; want %v", s, s.Stopped(), s.stops(), stopped)
		}
		if s.Stopped() && s.retries() {
			t.Errorf("%q both stops and retries", s)
		}
	}
}
