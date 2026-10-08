package servers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
)

// A server made here for what the stand-in does not do: one that drops its streams, echoes the
// secret it was sent, or offers more than a server has.

const ownSecret = "the-own-secret-CCCC3333"

// ownServer serves routes over TLS, HTTP/2 too, on loopback.
func ownServer(t *testing.T, routes map[string]http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	for path, h := range routes {
		mux.HandleFunc(path, h)
	}
	s := httptest.NewUnstartedServer(mux)
	s.EnableHTTP2 = true
	s.StartTLS()
	t.Cleanup(func() {
		s.CloseClientConnections()
		s.Close()
	})
	return s
}

// ownForm is the input that connects to s under a pin, with ownSecret.
func ownForm(s *httptest.Server) Input {
	return Input{Name: "Own", Address: s.URL, Secret: ownSecret, SelfSigned: true, Pin: remote.Fingerprint(s.Certificate().Raw)}
}

// ownHello answers hello with a version made from the request.
func ownHello(version func(r *http.Request) string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"app": "ai-whiteboard", "version": version(r), "instanceId": testOtherID, "featureLevel": MinFeatureLevel,
		})
	}
}

func plainVersion(*http.Request) string { return "v-own" }

// ownSnapshot is a state a client accepts, with agents and catalogs.
func ownSnapshot(agents []string, catalogs map[string]any) map[string]any {
	return map[string]any{
		"type": "snapshot", "agents": agents, "catalogs": catalogs, "home": "/h", "defaultCwd": "/h", "chats": []any{},
	}
}

// ownStream opens an event stream on w and returns what sends one event on it.
func ownStream(w http.ResponseWriter) func(v any) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	return func(v any) {
		b, _ := json.Marshal(v)
		_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
		w.(http.Flusher).Flush()
	}
}

// TestBackoffOfADroppingServer: a server that sends hello and the snapshot and then drops the
// stream. While no stream stays open for Stable the back-off goes on growing and stays at its
// last step; with Stable 0, and after a stream that was open for Stable, it starts again.
func TestBackoffOfADroppingServer(t *testing.T) {
	t.Parallel()
	// dropping records when each stream was asked for, and drops it after hold.
	dropping := func(t *testing.T, hold time.Duration) (*httptest.Server, func() []time.Time) {
		var mu sync.Mutex
		var asked []time.Time
		s := ownServer(t, map[string]http.HandlerFunc{
			HelloPath: ownHello(plainVersion),
			StreamPath: func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				asked = append(asked, time.Now())
				mu.Unlock()
				send := ownStream(w)
				send(map[string]any{"type": "hello"})
				send(ownSnapshot([]string{"claude"}, map[string]any{}))
				select {
				case <-time.After(hold):
				case <-r.Context().Done():
				}
			},
		})
		return s, func() []time.Time {
			mu.Lock()
			defer mu.Unlock()
			return append([]time.Time{}, asked...)
		}
	}
	timing := func(stable time.Duration, backoff ...time.Duration) func(*Options) {
		return func(o *Options) { o.Timing.Backoff, o.Timing.Stable = backoff, stable }
	}

	t.Run("it grows while no stream is stable", func(t *testing.T) {
		t.Parallel()
		steps := []time.Duration{30 * time.Millisecond, 90 * time.Millisecond, 200 * time.Millisecond}
		s, asked := dropping(t, 0)
		r := startRig(t, timing(time.Minute, steps...))
		id := r.add(ownForm(s))
		const attempts = 7
		waitFor(t, "the attempts", func() bool { return len(asked()) >= attempts })
		at := asked()
		for i := 1; i < attempts; i++ {
			want := steps[min(i-1, len(steps)-1)]
			if gap := at[i].Sub(at[i-1]); gap < want {
				t.Errorf("attempt %d came %v after the one before; want the back-off's %v at least", i+1, gap, want)
			}
		}
		// Every one of them got as far as its snapshot.
		if n := r.count(id, "snapshot"); n < attempts-1 {
			t.Errorf("%d snapshots for %d streams", n, attempts)
		}
	})

	// The third step is longer than the test waits: the attempts come only while the back-off
	// starts again each time.
	long := []time.Duration{20 * time.Millisecond, 20 * time.Millisecond, time.Minute}
	t.Run("Stable 0 starts it again at once", func(t *testing.T) {
		t.Parallel()
		s, asked := dropping(t, 0)
		r := startRig(t, timing(0, long...))
		r.add(ownForm(s))
		waitFor(t, "the attempts", func() bool { return len(asked()) >= 7 })
	})
	t.Run("a stream that was open for Stable starts it again", func(t *testing.T) {
		t.Parallel()
		s, asked := dropping(t, 150*time.Millisecond)
		r := startRig(t, timing(50*time.Millisecond, long...))
		r.add(ownForm(s))
		waitFor(t, "the attempts", func() bool { return len(asked()) >= 5 })
	})
	t.Run("one that was not does not", func(t *testing.T) {
		t.Parallel()
		s, asked := dropping(t, 0)
		r := startRig(t, timing(time.Minute, long...))
		r.add(ownForm(s))
		waitFor(t, "the attempts", func() bool { return len(asked()) >= 3 })
		time.Sleep(quiet)
		if n := len(asked()); n != 3 {
			t.Errorf("%d attempts; want 3 and then the long step", n)
		}
	})
}

// TestNoSecretFromTheServer: a server that writes the secret it was sent into every text it has.
// Neither a test's Result nor an event for the pages holds it, whole or with characters in it
// that are not shown.
func TestNoSecretFromTheServer(t *testing.T) {
	t.Parallel()
	sent := func(r *http.Request) string { return r.Header.Get(remote.SecretHeader) }
	split := func(s string) string { return s[:5] + "\x00" + s[5:10] + "\u0007" + s[10:] }
	lacksSecret := func(t *testing.T, what string, b []byte) {
		t.Helper()
		if strings.Contains(string(b), ownSecret) {
			t.Errorf("%s holds the secret: %s", what, b)
		}
	}
	marshal := func(v any) []byte {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	target := func(s *httptest.Server) Target {
		in := ownForm(s)
		return Target{Address: in.Address, Secret: in.Secret, SelfSigned: true, Pin: in.Pin}
	}

	t.Run("the error text of hello", func(t *testing.T) {
		t.Parallel()
		for _, text := range []func(string) string{
			func(s string) string { return "got " + s },
			func(s string) string { return "got " + split(s) },
			func(s string) string { return strings.Repeat("x", maxDetail-10) + s }, // the cut would leave a part
		} {
			s := ownServer(t, map[string]http.HandlerFunc{HelloPath: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTeapot)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": text(sent(r))})
			}})
			res := run(target(s), Identity{}, testOptions())
			if res.Outcome != OutcomeNotAIWB || !strings.HasPrefix(res.Detail, "HTTP 418: ") || !strings.HasSuffix(res.Detail, "…") {
				t.Errorf("result %+v; want not_aiwb with the server's text and … for the secret", res)
			}
			lacksSecret(t, "the result", marshal(res))
			if strings.Contains(res.Detail, ownSecret[:8]) {
				t.Errorf("detail holds a part of the secret: %q", res.Detail)
			}
		}
	})

	t.Run("version and agents", func(t *testing.T) {
		t.Parallel()
		more := make(chan struct{})
		routes := map[string]http.HandlerFunc{
			HelloPath: ownHello(func(r *http.Request) string { return "v1 " + sent(r) + " " + split(sent(r)) }),
			StatePath: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(ownSnapshot([]string{"claude", sent(r), "a" + split(sent(r))}, map[string]any{}))
			},
			StreamPath: func(w http.ResponseWriter, r *http.Request) {
				send := ownStream(w)
				send(ownSnapshot([]string{"claude", sent(r), "a" + split(sent(r))}, map[string]any{}))
				select {
				case <-more:
					send(map[string]any{"type": "agents", "agents": []string{"pi", "b" + sent(r), split(sent(r)) + "c"}})
				case <-r.Context().Done():
					return
				}
				<-r.Context().Done()
			},
		}
		s := ownServer(t, routes)

		res := run(target(s), Identity{}, testOptions())
		if !res.OK || res.Version != "v1 … …" || fmt.Sprint(res.Agents) != "[claude … a…]" {
			t.Errorf("result %+v; want connected with … for the secret", res)
		}
		lacksSecret(t, "the result", marshal(res))

		r := startRig(t, nil)
		id := r.add(ownForm(s))
		v := r.waitState(id, StateConnected)
		if v.Version != "v1 … …" || fmt.Sprint(v.Agents) != "[claude … a…]" {
			t.Errorf("view %+v; want … for the secret", v)
		}
		close(more)
		r.waitCall(id, "event agents", 1)
		waitFor(t, "the agents of the event", func() bool { return fmt.Sprint(r.view(id).Agents) == "[pi b… …c]" })
		waitFor(t, "the second server_state event", func() bool { return len(r.stateEvents(id)) == 2 })
		if l, _ := r.m.Lists(id); fmt.Sprint(l.Agents) != "[pi b… …c]" {
			t.Errorf("Lists' agents %q", l.Agents)
		}
		lacksSecret(t, "the views", marshal(r.m.Views()))
		saved, err := r.m.TestSaved(context.Background(), id, Patch{})
		if err != nil || !saved.OK {
			t.Errorf("TestSaved: %+v, %v", saved, err)
		}
		lacksSecret(t, "the result of the saved entry's test", marshal(saved))
		r.mu.Lock()
		defer r.mu.Unlock()
		if len(r.events) < 3 {
			t.Errorf("%d events", len(r.events))
		}
		for _, ev := range r.events {
			lacksSecret(t, "an event", ev)
		}
	})
}

// TestWhatAServerCanMakeUsKeep: a catalog is kept for the agent kinds of this build alone, and
// of the agents a server names the first 16.
func TestWhatAServerCanMakeUsKeep(t *testing.T) {
	t.Parallel()
	names := func(prefix string) []string {
		out := make([]string, 100)
		for i := range out {
			out[i] = fmt.Sprintf("%s%d", prefix, i)
		}
		return out
	}
	catalog := model.Catalog{Models: []model.CatalogModel{{ID: "m-1"}}}
	snapshot := func() map[string]any {
		catalogs := map[string]any{"claude": catalog}
		for _, n := range names("snap") {
			catalogs[n] = catalog
		}
		return ownSnapshot(names("agent"), catalogs)
	}
	more := make(chan struct{})
	s := ownServer(t, map[string]http.HandlerFunc{
		HelloPath: ownHello(plainVersion),
		StatePath: func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(snapshot())
		},
		StreamPath: func(w http.ResponseWriter, r *http.Request) {
			send := ownStream(w)
			send(snapshot())
			select {
			case <-more:
			case <-r.Context().Done():
				return
			}
			for _, n := range names("kind") {
				send(map[string]any{"type": "catalog", "agent": n, "catalog": catalog})
			}
			send(map[string]any{"type": "catalog", "agent": "", "catalog": catalog})
			send(map[string]any{"type": "catalog", "agent": "pi", "catalog": catalog})
			send(map[string]any{"type": "catalog", "agent": "cursor", "catalog": catalog})
			send(map[string]any{"type": "agents", "agents": names("later")})
			<-r.Context().Done()
		},
	})
	check := func(when string, l Lists, agents []model.AgentKind, first string, kinds ...model.AgentKind) {
		t.Helper()
		if len(agents) != maxAgents || maxAgents != 16 || string(agents[0]) != first+"0" || string(agents[15]) != first+"15" {
			t.Errorf("%s: %d agents in the view: %q; want the first 16", when, len(agents), agents)
		}
		if fmt.Sprint(l.Agents) != fmt.Sprint(agents) {
			t.Errorf("%s: Lists' agents %q; want the view's", when, l.Agents)
		}
		if len(l.Catalogs) != len(kinds) {
			t.Errorf("%s: %d catalogs; want those of %q", when, len(l.Catalogs), kinds)
		}
		for _, k := range kinds {
			if c := l.Catalogs[k]; c == nil || len(c.Models) != 1 {
				t.Errorf("%s: the catalog of %s: %+v", when, k, c)
			}
		}
	}

	in := ownForm(s)
	res := run(Target{Address: in.Address, Secret: in.Secret, SelfSigned: true, Pin: in.Pin}, Identity{}, testOptions())
	if !res.OK || len(res.Agents) != 16 || res.Agents[15] != "agent15" {
		t.Errorf("the test's result has %d agents: %+v", len(res.Agents), res)
	}

	r := startRig(t, nil)
	id := r.add(in)
	v := r.waitState(id, StateConnected)
	l, _ := r.m.Lists(id)
	check("after the snapshot", l, v.Agents, "agent", model.Claude)

	close(more)
	r.waitCall(id, "event agents", 1)
	if n := r.count(id, "event catalog"); n != 103 {
		t.Errorf("%d catalog events reached the hook; want all 103", n)
	}
	waitFor(t, "the agents of the event", func() bool { a := r.view(id).Agents; return len(a) > 0 && a[0] == "later0" })
	l, _ = r.m.Lists(id)
	check("after the events", l, r.view(id).Agents, "later", model.Claude, model.Cursor, model.Pi)
}
