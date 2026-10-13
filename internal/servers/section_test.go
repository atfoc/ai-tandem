package servers

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"testing"
	"time"

	"ai-whiteboard/internal/servers/standin"
)

// TestSectionLevels: the lowest level connected to is 5, this client states 5 in the level
// header, and the stand-in is a server of that level.
func TestSectionLevels(t *testing.T) {
	t.Parallel()
	if MinFeatureLevel != 5 || ClientLevel != 5 || LevelHeader != "X-AIWB-Level" {
		t.Errorf("the lowest level %d, the client's level %d in %q; want 5 and 5 in X-AIWB-Level", MinFeatureLevel, ClientLevel, LevelHeader)
	}
	if LibraryLevel != 3 || LibraryLevel >= MinFeatureLevel {
		t.Errorf("the library's level %d; want 3, below the lowest level connected to", LibraryLevel)
	}
	if standin.DefaultFeatureLevel != MinFeatureLevel {
		t.Errorf("the stand-in reports the level %d; want %d", standin.DefaultFeatureLevel, MinFeatureLevel)
	}
}

// TestSectionFirstLevelThatConnects: a test of a connection ends as too old, at hello and with
// the server's version and level, for every level below 5 and for none; from 5 on it connects.
func TestSectionFirstLevelThatConnects(t *testing.T) {
	t.Parallel()
	s := standin.Start(t, standin.Options{Version: "1.4"})
	levels := []*int{nil}
	for n := 0; n <= 6; n++ {
		levels = append(levels, standin.Level(n))
	}
	for _, level := range levels {
		name, n := "none", 0
		if level != nil {
			name, n = strconv.Itoa(*level), *level
		}
		s.SetFeatureLevel(level)
		sent := len(s.Requests())
		r := run(pinned(s), Identity{}, testOptions())
		if r.Version != "1.4" || r.FeatureLevel != n || r.InstanceID != standin.DefaultInstanceID {
			t.Errorf("level %s: result %+v; want the server's version, level and id", name, r)
		}
		if n >= 5 {
			if !r.OK || r.Outcome != OutcomeConnected {
				t.Errorf("level %s: result %+v; want connected", name, r)
			}
			continue
		}
		if r.OK || r.Outcome != OutcomeTooOld || r.Step != 4 || r.Message != "Server too old: update it on that machine" {
			t.Errorf("level %s: result %+v; want too old at step 4", name, r)
		}
		if got := paths(s)[sent:]; !slices.Equal(got, []string{HelloPath}) {
			t.Errorf("level %s: requests %q; want hello alone", name, got)
		}
	}
}

// TestSectionLevel4IsTooOld: an entry whose server reports level 4, the level before this one,
// ends as too old with that server's version, and nothing but hello is asked of it. Once the
// server reports 5 the entry connects by itself, at its next hello (Timing.TooOld, lowered
// here), with nobody doing anything on this machine.
func TestSectionLevel4IsTooOld(t *testing.T) {
	t.Parallel()
	s := standin.Start(t, standin.Options{Version: "1.4", FeatureLevel: standin.Level(4)})
	s.SetLevelCheck(false) // a server of level 4 knows no level header
	r := startRig(t, func(o *Options) { o.Timing.TooOld = 30 * time.Millisecond })
	id := r.add(form("Studio", s))
	if v := r.waitState(id, StateTooOld); v.Version != "1.4" || !v.State.stops() || len(v.Agents) != 0 {
		t.Errorf("view %+v; want too old, with the server's version", v)
	}
	if res := r.m.Test(context.Background(), pinned(s)); res.OK || res.Outcome != OutcomeTooOld || res.Version != "1.4" || res.FeatureLevel != 4 {
		t.Errorf("a test of the same server: %+v; want too old, with its version and level", res)
	}
	waitFor(t, "the entry asks again", func() bool { return len(s.Requests()) >= 4 })
	for _, q := range s.Requests() {
		if q.Path != HelloPath || q.Level != clientLevel {
			t.Fatalf("request %+v; want hello alone, with the level header", q)
		}
	}
	if _, ok := r.m.Lists(id); ok || r.m.Level(id) != 0 {
		t.Errorf("lists %v and level %d of a server that was never connected", ok, r.m.Level(id))
	}
	if got := r.callsOf(id); !slices.Equal(got, []string{"state connecting > too_old"}) {
		t.Errorf("hooks %q; want too_old once", got)
	}
	r.wantStateEvents(id, "too_old")

	// The server is updated on its machine: it reports 5 and checks its clients' level.
	s.SetLevelCheck(true)
	s.SetFeatureLevel(standin.Level(5))
	if v := r.waitState(id, StateConnected); v.Version != "1.4" || len(v.Agents) == 0 {
		t.Errorf("view %+v; want connected, with the server's agents", v)
	}
	if got := r.callsOf(id); !slices.Equal(got, []string{"state connecting > too_old", "snapshot", "state too_old > connected"}) {
		t.Errorf("hooks %q; want connected straight from too_old", got)
	}
	r.wantStateEvents(id, "too_old", "connected")
	if got := r.m.Level(id); got != 5 {
		t.Errorf("the level %d; want 5", got)
	}
	if rep, err := r.m.Do(context.Background(), id, http.MethodGet, StatePath, nil, 0); err != nil || rep.Status != http.StatusOK {
		t.Errorf("Do after the update: %d, %v", rep.Status, err)
	}
}

// TestSectionLevelHeaderOnEveryRequest: every request to a remote server states this client's
// level: both requests of a connection test, a connection's hello and its stream, a call passed
// on with Do and with DoAs, and the hello and the stream of a connection that is made again.
// The stand-in makes the level check of a server of level 5, so a request without the header
// would have been refused.
func TestSectionLevelHeaderOnEveryRequest(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	s := standin.Start(t, standin.Options{})
	s.Handle("POST /api/chats", answer(http.StatusOK, "application/json", `{"id":"c1"}`))
	s.Handle("POST /api/chats/c1/images", answer(http.StatusOK, "application/json", `{"id":"i1"}`))
	r := startRig(t, nil)

	// A save with its test, then the entry's connection.
	v, saved, res, err := r.m.Add(ctx, form("Studio", s), false)
	if err != nil || !saved || res == nil || !res.OK {
		t.Fatalf("Add: saved %v, result %+v, err %v", saved, res, err)
	}
	id := v.ID
	r.waitState(id, StateConnected)
	if rep, err := r.m.Do(ctx, id, http.MethodPost, "/api/chats", []byte(`{}`), 0); err != nil || rep.Status != http.StatusOK {
		t.Fatalf("Do: %d (%s), %v", rep.Status, rep.Body, err)
	}
	if rep, err := r.m.DoAs(ctx, id, http.MethodPost, "/api/chats/c1/images", "image/png", []byte("png"), 0); err != nil || rep.Status != http.StatusOK {
		t.Fatalf("DoAs: %d (%s), %v", rep.Status, rep.Body, err)
	}
	// A test of an unsaved form, which the entry's connection takes no part in.
	if res := run(pinned(s), Identity{}, testOptions()); !res.OK {
		t.Fatalf("TestConnection: %+v", res)
	}
	q := func(method, path string) standin.Request {
		return standin.Request{Method: method, Path: path, Secret: standin.DefaultSecret, Client: testLocalID, Level: clientLevel}
	}
	want := []standin.Request{
		q("GET", HelloPath), q("GET", StatePath), // the test of the save
		q("GET", HelloPath), q("GET", StreamPath), // the connection
		q("POST", "/api/chats"), q("POST", "/api/chats/c1/images"),
		q("GET", HelloPath), q("GET", StatePath), // the test
	}
	if got := s.Requests(); !slices.Equal(got, want) {
		t.Fatalf("requests %+v; want %+v", got, want)
	}

	// The stream ends and the entry connects again.
	s.DropStreams()
	r.waitCall(id, "back", 1)
	r.waitState(id, StateConnected)
	again := s.Requests()[len(want):]
	if len(again) < 2 {
		t.Fatalf("requests of the second connection: %+v", again)
	}
	for _, got := range again {
		if got != q("GET", HelloPath) && got != q("GET", StreamPath) {
			t.Errorf("request %+v; want a hello or a stream with the level header", got)
		}
	}
}

// TestSectionStandinChecksThisClientsLevel holds the stand-in's level check to the header and
// the level of this package: a request as identify makes it is served, one that states the
// level below, or none, is refused as too old a client, and hello is answered either way.
func TestSectionStandinChecksThisClientsLevel(t *testing.T) {
	t.Parallel()
	s := standin.Start(t, standin.Options{})
	tr := newTransport(nil, Trust{SelfSigned: true, Pin: s.Fingerprint()}, fastTiming())
	t.Cleanup(tr.CloseIdleConnections)
	client := &http.Client{Transport: tr, Timeout: 10 * time.Second}
	get := func(path string, edit func(*http.Request)) (int, map[string]string) {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, s.URL()+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		identify(req, standin.DefaultSecret, testLocalID)
		if edit != nil {
			edit(req)
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer resp.Body.Close()
		var body map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&body) // a state is no object of strings
		return resp.StatusCode, body
	}
	below := func(r *http.Request) { r.Header.Set(LevelHeader, strconv.Itoa(ClientLevel-1)) }
	none := func(r *http.Request) { r.Header.Del(LevelHeader) }

	if status, _ := get(StatePath, nil); status != http.StatusOK {
		t.Errorf("the state for this client: %d; want 200", status)
	}
	for name, edit := range map[string]func(*http.Request){"the level below": below, "no level": none} {
		status, body := get(StatePath, edit)
		if status != http.StatusBadRequest || body["code"] != "client_too_old" ||
			body["error"] != "This app is too old for this server: update AI Whiteboard on the machine that connects." {
			t.Errorf("the state with %s: %d %v; want 400 client_too_old", name, status, body)
		}
		if status, body := get(HelloPath, edit); status != http.StatusOK || body["app"] != "ai-whiteboard" {
			t.Errorf("hello with %s: %d %v; want the hello", name, status, body)
		}
	}
}
