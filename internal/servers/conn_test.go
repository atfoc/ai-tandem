package servers

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers/standin"
)

const (
	waitLimit = 10 * time.Second       // what a test waits for at most
	quiet     = 150 * time.Millisecond // long enough for several back-offs of fastTiming
)

// fastTiming has limits no healthy loopback request reaches and a back-off of 20 and 40 ms.
func fastTiming() Timing {
	const limit = 3 * time.Second
	return Timing{
		Dial: limit, Handshake: limit, Headers: limit, Hello: limit, FirstEvent: limit, Call: limit,
		TestStep: limit, Silence: limit,
		Backoff: []time.Duration{20 * time.Millisecond, 40 * time.Millisecond}, Jitter: -1,
	}
}

// rig is a manager with everything it tells recorded: the events for the pages and the hooks.
type rig struct {
	t     *testing.T
	m     *Manager
	dials atomic.Int64 // TCP connects begun

	mu     sync.Mutex
	events [][]byte // every Notify event, as JSON
	calls  []string // every hook call: "<entry> snapshot", "<entry> event <type>", "<entry> state <from> > <to>", "<entry> back", "<entry> removed"
	raws   []string // the raw JSON of every Hooks.Event, in order
}

// openRig opens a manager on root without starting it. set may change the options.
func openRig(t *testing.T, root string, set func(*Options)) *rig {
	t.Helper()
	r := &rig{t: t}
	o := Options{Root: root, LocalID: testLocalID, Version: "v-local", Timing: fastTiming()}
	o.Notify = func(ev any) {
		b, err := json.Marshal(ev)
		if err != nil {
			t.Errorf("Notify: %v", err)
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		r.events = append(r.events, b)
	}
	if set != nil {
		set(&o)
	}
	dial := o.Dial
	if dial == nil {
		dial = (&net.Dialer{}).DialContext
	}
	o.Dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		r.dials.Add(1)
		return dial(ctx, network, addr)
	}
	m, err := Open(o)
	if err != nil {
		t.Fatal(err)
	}
	r.m = m
	note := func(s string) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.calls = append(r.calls, s)
	}
	m.SetHooks(Hooks{
		Snapshot: func(entry string, raw json.RawMessage) { note(entry + " snapshot") },
		Event: func(entry, typ string, raw json.RawMessage) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.calls = append(r.calls, entry+" event "+typ)
			r.raws = append(r.raws, string(raw))
		},
		State:   func(entry string, from, to State) { note(fmt.Sprintf("%s state %s > %s", entry, from, to)) },
		Back:    func(entry string) { note(entry + " back") },
		Removed: func(entry string) { note(entry + " removed") },
	})
	t.Cleanup(m.Close)
	return r
}

// startRig opens a manager on a new folder and starts it.
func startRig(t *testing.T, set func(*Options)) *rig {
	t.Helper()
	r := openRig(t, t.TempDir(), set)
	r.m.Start()
	return r
}

// form is the input that connects to s under a pin.
func form(name string, s *standin.Server) Input {
	return Input{Name: name, Address: s.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: s.Fingerprint()}
}

// add saves in without a test and returns the entry's id.
func (r *rig) add(in Input) string {
	r.t.Helper()
	v, saved, res, err := r.m.Add(context.Background(), in, true)
	if err != nil || !saved || res != nil {
		r.t.Fatalf("Add with force: saved %v, result %+v, err %v", saved, res, err)
	}
	if v.State != StateConnecting {
		r.t.Fatalf("a new entry's state is %q; want connecting", v.State)
	}
	return v.ID
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(waitLimit); ; time.Sleep(2 * time.Millisecond) {
		if ok() {
			return
		}
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func (r *rig) view(id string) View {
	r.t.Helper()
	v, ok := r.m.View(id)
	if !ok {
		r.t.Fatalf("no entry %s", id)
	}
	return v
}

// told is the state Hooks.State was last told for the entry: connecting before any call.
func (r *rig) told(id string) State {
	told := StateConnecting
	for _, c := range r.callsOf(id) {
		if _, to, ok := strings.Cut(c, " > "); ok && strings.HasPrefix(c, "state ") {
			told = State(to)
		}
	}
	return told
}

// waitState waits until the entry is in want, and Hooks.State was told so: the hook is called
// after the view changed. It returns the entry's view.
func (r *rig) waitState(id string, want State) View {
	r.t.Helper()
	for end := time.Now().Add(waitLimit); ; time.Sleep(2 * time.Millisecond) {
		v := r.view(id)
		if v.State == want && r.told(id) == want {
			return v
		}
		if time.Now().After(end) {
			r.t.Fatalf("entry %s is %q (%s); want %q. Hooks: %q", id, v.State, v.Detail, want, r.callsOf(id))
		}
	}
}

// callsOf are the hook calls for the entry, in order, without its id.
func (r *rig) callsOf(id string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, c := range r.calls {
		if rest, ok := strings.CutPrefix(c, id+" "); ok {
			out = append(out, rest)
		}
	}
	return out
}

func (r *rig) count(id, call string) int {
	n := 0
	for _, c := range r.callsOf(id) {
		if c == call {
			n++
		}
	}
	return n
}

// waitCall waits until the hooks got call for the entry at least n times.
func (r *rig) waitCall(id, call string, n int) {
	r.t.Helper()
	for end := time.Now().Add(waitLimit); ; time.Sleep(2 * time.Millisecond) {
		if r.count(id, call) >= n {
			return
		}
		if time.Now().After(end) {
			r.t.Fatalf("no %d× %q for %s. Hooks: %q", n, call, id, r.callsOf(id))
		}
	}
}

// eventsOf are the Notify events of typ so far, decoded.
func (r *rig) eventsOf(typ string) []map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []map[string]any
	for _, b := range r.events {
		var ev map[string]any
		if err := json.Unmarshal(b, &ev); err != nil {
			r.t.Errorf("event %s: %v", b, err)
			continue
		}
		if ev["type"] == typ {
			out = append(out, ev)
		}
	}
	return out
}

// stateEvents are the states of the entry's server_state events so far, in order.
func (r *rig) stateEvents(id string) []string {
	var out []string
	for _, ev := range r.eventsOf("server_state") {
		if s, _ := ev["server"].(map[string]any); s["id"] == id {
			out = append(out, fmt.Sprint(s["state"]))
		}
	}
	return out
}

// wantStateEvents checks the states of the entry's server_state events so far. The events come
// from the sender's goroutine, so it waits for as many as it wants.
func (r *rig) wantStateEvents(id string, want ...string) {
	r.t.Helper()
	waitFor(r.t, "the server_state events", func() bool { return len(r.stateEvents(id)) >= len(want) })
	if got := r.stateEvents(id); !slices.Equal(got, want) {
		r.t.Errorf("server_state events %q; want %q", got, want)
	}
}

// paths are the paths of the requests s received so far.
func paths(s *standin.Server) []string {
	var out []string
	for _, r := range s.Requests() {
		out = append(out, r.Path)
	}
	return out
}

// staysQuiet checks that s sees no handshake and no request for a while.
func staysQuiet(t *testing.T, s *standin.Server) {
	t.Helper()
	handshakes, requests := s.Handshakes(), len(s.Requests())
	time.Sleep(quiet)
	if h, r := s.Handshakes(), len(s.Requests()); h != handshakes || r != requests {
		t.Errorf("the server saw %d handshakes and %d requests more; want none (requests %q)", h-handshakes, r-requests, paths(s))
	}
}

// silentStream is a stream that opens and sends nothing.
func silentStream(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	w.(http.Flusher).Flush()
	<-r.Context().Done()
}

// TestConnStates has one case and more per state: the outcome of an attempt that enters it, what
// the view then shows, and whether the connection retries or stops.
func TestConnStates(t *testing.T) {
	// Each short limit is the one its case is about: the others stay out of reach.
	const short = 250 * time.Millisecond
	type setup struct {
		in  Input
		srv *standin.Server // nil when nothing of ours answers
		set func(*Options)
	}
	with := func(f func(s *standin.Server)) func(t *testing.T) setup {
		return func(t *testing.T) setup {
			s := standin.Start(t, standin.Options{})
			in := form("Studio", s)
			f(s)
			return setup{in: in, srv: s}
		}
	}
	elsewhere := func(url string) Input {
		return Input{Name: "Studio", Address: url, Secret: standin.DefaultSecret}
	}
	cases := []struct {
		name    string
		setup   func(t *testing.T) setup
		want    State
		detail  string // a part of the view's detail; "" for none at all
		retries bool
	}{
		{"connected", with(func(*standin.Server) {}), StateConnected, "", false},

		{"unreachable: refused", func(t *testing.T) setup {
			return setup{in: elsewhere(standin.Refused(t))}
		}, StateUnreachable, "Nothing listens there", true},
		{"unreachable: name not found", func(t *testing.T) setup {
			return setup{in: elsewhere("https://studio.example:4748"), set: func(o *Options) {
				o.Dial = failDial(&net.DNSError{Err: "no such host", Name: "studio.example", IsNotFound: true}, nil)
			}}
		}, StateUnreachable, "Name not found", true},
		{"unreachable: no route", func(t *testing.T) setup {
			return setup{in: elsewhere("https://10.9.8.7:4748"), set: func(o *Options) {
				o.Dial = failDial(&net.OpError{Op: "dial", Net: "tcp4", Err: syscall.EHOSTUNREACH}, nil)
			}}
		}, StateUnreachable, "is the VPN up?", true},
		{"unreachable: no handshake", func(t *testing.T) setup {
			return setup{in: elsewhere(standin.Silent(t)), set: func(o *Options) { o.Timing.Handshake = short }}
		}, StateUnreachable, "does a firewall", true},
		{"unreachable: not https", func(t *testing.T) setup {
			return setup{in: elsewhere(standin.PlainHTTP(t))}
		}, StateUnreachable, "Not HTTPS", true},
		{"unreachable: tls error", func(t *testing.T) setup {
			return setup{in: elsewhere(tlsListener(t, &tls.Config{
				Certificates: []tls.Certificate{issuedPair(t)}, MinVersion: tls.VersionTLS10, MaxVersion: tls.VersionTLS11,
			}))}
		}, StateUnreachable, "The secure connection failed", true},
		{"unreachable: hello not answered", func(t *testing.T) setup {
			s := with(func(s *standin.Server) { s.SetHello(hang) })(t)
			s.set = func(o *Options) { o.Timing.Hello = short }
			return s
		}, StateUnreachable, "No answer from the server", true},
		{"unreachable: stream not found", with(func(s *standin.Server) {
			s.Handle("GET "+StreamPath, answer(http.StatusNotFound, "application/json", `{"error":"not found"}`))
		}), StateUnreachable, detailNoStream, true},
		{"unreachable: stream is no stream", with(func(s *standin.Server) {
			s.Handle("GET "+StreamPath, answer(http.StatusOK, "application/json", `{"type":"snapshot"}`))
		}), StateUnreachable, detailNoStream, true},
		{"unreachable: stream's headers do not come", func(t *testing.T) setup {
			s := with(func(s *standin.Server) { s.Handle("GET "+StreamPath, hang) })(t)
			s.set = func(o *Options) { o.Timing.Headers = short }
			return s
		}, StateUnreachable, "No answer from the server", true},
		{"unreachable: stream's first events do not come", func(t *testing.T) setup {
			s := with(func(s *standin.Server) { s.Handle("GET "+StreamPath, silentStream) })(t)
			s.set = func(o *Options) { o.Timing.FirstEvent = short }
			return s
		}, StateUnreachable, detailNoStream, true},
		{"unreachable: snapshot without its parts", with(func(s *standin.Server) {
			s.SetSnapshot(map[string]any{"agents": []string{"claude"}})
		}), StateUnreachable, "state could not be read", true},

		{"certificate not accepted: self-signed", func(t *testing.T) setup {
			s := standin.Start(t, standin.Options{})
			return setup{in: elsewhere(s.URL()), srv: s} // against the system's roots
		}, StateCertificateNotAccepted, "x509", true},
		{"certificate not accepted: not for this name", func(t *testing.T) setup {
			s := standin.Start(t, standin.Options{Names: []string{"elsewhere.example"}})
			return setup{in: elsewhere(s.URL()), srv: s, set: func(o *Options) { o.Roots = s.Pool() }}
		}, StateCertificateNotAccepted, "IP SANs", true},
		{"certificate not accepted: expired", func(t *testing.T) setup {
			s := standin.Start(t, standin.Options{NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: time.Now().Add(-time.Hour)})
			return setup{in: elsewhere(s.URL()), srv: s, set: func(o *Options) { o.Roots = s.Pool() }}
		}, StateCertificateNotAccepted, "expired", true},
		{"certificate not accepted: not trusted", func(t *testing.T) setup {
			return setup{in: elsewhere(tlsListener(t, &tls.Config{Certificates: []tls.Certificate{issuedPair(t)}})), set: func(o *Options) {
				o.Roots = standin.Start(t, standin.Options{}).Pool()
			}}
		}, StateCertificateNotAccepted, "x509", true},

		{"secret not accepted", func(t *testing.T) setup {
			s := with(func(*standin.Server) {})(t)
			s.in.Secret = "another-secret"
			return s
		}, StateSecretNotAccepted, "", false},
		{"secret not accepted: at the stream", with(func(s *standin.Server) {
			s.Handle("GET "+StreamPath, answer(http.StatusUnauthorized, "application/json", `{"error":"unauthorized"}`))
		}), StateSecretNotAccepted, "", false},
		{"fingerprint not accepted", func(t *testing.T) setup {
			s := with(func(*standin.Server) {})(t)
			s.in.Pin = ""
			return s
		}, StateFingerprintNotAccepted, "", false},
		{"certificate changed", func(t *testing.T) setup {
			s := with(func(*standin.Server) {})(t)
			s.in.Pin = pinA
			return s
		}, StateCertificateChanged, "", false},
		{"name not known", func(t *testing.T) setup {
			s := standin.Start(t, standin.Options{Hosts: []string{"studio.example:4748"}})
			return setup{in: form("Studio", s), srv: s}
		}, StateNameNotKnown, "", false},
		{"name not known: at the stream", with(func(s *standin.Server) {
			s.Handle("GET "+StreamPath, answer(http.StatusForbidden, "application/json", `{"error":"bad host"}`))
		}), StateNameNotKnown, "", false},
		{"not aiwb", func(t *testing.T) setup {
			s := standin.NotAIWB(t)
			return setup{in: form("Studio", s), srv: s}
		}, StateNotAIWB, "", false},
		{"not aiwb: a redirect", with(func(s *standin.Server) {
			s.SetHello(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, "https://elsewhere.example:4748/api/hello", http.StatusFound)
			})
		}), StateNotAIWB, "", false},
		{"too old", with(func(s *standin.Server) { s.SetFeatureLevel(standin.Level(0)) }), StateTooOld, "", false},
		{"another server: the local one", with(func(s *standin.Server) { s.SetInstanceID(testLocalID) }),
			StateAnotherServer, "This is the local server", false},
	}
	seen := map[State]bool{StateConnecting: true} // every new entry's first state; see add
	for _, c := range cases {
		seen[c.want] = true
		t.Run(c.name, func(t *testing.T) {
			su := c.setup(t)
			r := startRig(t, su.set)
			id := r.add(su.in)
			v := r.waitState(id, c.want)
			if c.detail == "" && v.Detail != "" || !strings.Contains(v.Detail, c.detail) {
				t.Errorf("detail %q; want %q in it", v.Detail, c.detail)
			}
			if c.want.retries() != c.retries || c.want.stops() != (!c.retries && c.want != StateConnected) {
				t.Errorf("state %q: retries %v, stops %v", c.want, c.want.retries(), c.want.stops())
			}
			if _, err := r.m.Do(context.Background(), id, http.MethodGet, StatePath, nil, 0); (err == nil) != (c.want == StateConnected) {
				t.Errorf("Do in %q: err %v", c.want, err)
			} else if err != nil && !errors.Is(err, ErrNotConnected) {
				t.Errorf("Do in %q: err %v; want ErrNotConnected", c.want, err)
			}
			switch {
			case c.retries:
				// Without end: attempt after attempt, and no event for any but the first.
				dials := r.dials.Load()
				waitFor(t, "three more attempts", func() bool { return r.dials.Load() >= dials+3 })
				r.wantStateEvents(id, string(c.want))
				if got := r.callsOf(id); !slices.Equal(got, []string{"state connecting > " + string(c.want)}) {
					t.Errorf("hooks %q", got)
				}
			case su.srv != nil:
				staysQuiet(t, su.srv)
				want := int64(1)
				if c.want == StateFingerprintNotAccepted {
					want = 0
				}
				if dials := r.dials.Load(); dials != want {
					t.Errorf("%d dials; want %d", dials, want)
				}
			}
			if v := r.view(id); v.State != c.want {
				t.Errorf("state is %q in the end; want %q", v.State, c.want)
			}
		})
	}
	for _, s := range allStates {
		if !seen[s] {
			t.Errorf("no case for the state %q", s)
		}
	}
	if len(allStates) != 11 {
		t.Errorf("%d states; want eleven", len(allStates))
	}
}

var allStates = []State{
	StateConnecting, StateConnected, StateUnreachable, StateSecretNotAccepted, StateFingerprintNotAccepted,
	StateCertificateChanged, StateCertificateNotAccepted, StateNameNotKnown, StateNotAIWB, StateTooOld,
	StateAnotherServer,
}

// TestConnConnecting: an entry is connecting while its first attempt runs, and the table of
// states holds for the outcomes of the test's table.
func TestConnConnecting(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	release := make(chan struct{})
	s.SetHello(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
		answer(http.StatusOK, "application/json",
			`{"app":"ai-whiteboard","version":"held","instanceId":"`+standin.DefaultInstanceID+`","featureLevel":1}`)(w, r)
	})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	waitFor(t, "the hello", func() bool { return len(s.Requests()) == 1 })
	time.Sleep(50 * time.Millisecond)
	if v := r.view(id); v.State != StateConnecting || v.Version != "" {
		t.Errorf("view %+v; want connecting", v)
	}
	if got := r.callsOf(id); len(got) != 0 {
		t.Errorf("hooks %q before anything happened", got)
	}
	close(release)
	if v := r.waitState(id, StateConnected); v.Version != "held" {
		t.Errorf("version %q", v.Version)
	}

	want := map[Outcome]State{
		OutcomeRefused: StateUnreachable, OutcomeNameNotFound: StateUnreachable, OutcomeNoRoute: StateUnreachable,
		OutcomeTLSTimeout: StateUnreachable, OutcomeNotHTTPS: StateUnreachable, OutcomeTLSError: StateUnreachable,
		OutcomeNoAnswer: StateUnreachable, OutcomeNoState: StateUnreachable, OutcomeBadAddress: StateUnreachable,
		OutcomeSelfSigned: StateCertificateNotAccepted, OutcomeCertName: StateCertificateNotAccepted,
		OutcomeCertExpired: StateCertificateNotAccepted, OutcomeCertUntrusted: StateCertificateNotAccepted,
		OutcomeSecretRefused: StateSecretNotAccepted, OutcomeFingerprint: StateFingerprintNotAccepted,
		OutcomeCertChanged: StateCertificateChanged, OutcomeBadHost: StateNameNotKnown, OutcomeNotAIWB: StateNotAIWB,
		OutcomeTooOld: StateTooOld, OutcomeIsLocal: StateAnotherServer, OutcomeDuplicate: StateAnotherServer,
		OutcomeAnotherServer: StateAnotherServer, OutcomeConnected: StateConnected,
	}
	for _, row := range outcomes {
		if got, ok := want[row.outcome]; !ok || stateOf(row.outcome) != got {
			t.Errorf("stateOf(%q) = %q; want %q", row.outcome, stateOf(row.outcome), got)
		}
	}
}

// TestConnNoPinSendsNothing: with the box on and no fingerprint accepted nothing is dialed, and
// an accept connects.
func TestConnNoPinSendsNothing(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	in := form("Studio", s)
	in.Pin = ""
	id := r.add(in)
	r.waitState(id, StateFingerprintNotAccepted)
	time.Sleep(quiet)
	if s.Handshakes() != 0 || len(s.Requests()) != 0 || r.dials.Load() != 0 {
		t.Fatalf("%d dials, %d handshakes, requests %q; want none", r.dials.Load(), s.Handshakes(), paths(s))
	}

	// A test of the saved entry reads the certificate, sends no request, and does not get the
	// connection going: only an accept does.
	res, err := r.m.TestSaved(context.Background(), id, Patch{})
	if err != nil || res.Outcome != OutcomeFingerprint || res.Fingerprint != s.Fingerprint() {
		t.Fatalf("TestSaved: %+v, %v", res, err)
	}
	time.Sleep(quiet)
	if s.Handshakes() != 1 || len(s.Requests()) != 0 {
		t.Fatalf("%d handshakes, requests %q after the test; want 1 and none", s.Handshakes(), paths(s))
	}
	r.wantStateEvents(id, "fingerprint_not_accepted")

	if _, err := r.m.Accept(id, "not a fingerprint"); !errors.Is(err, ErrBadPin) {
		t.Errorf("Accept of no fingerprint: %v", err)
	}
	if _, err := r.m.Accept(id, ""); !errors.Is(err, ErrBadPin) {
		t.Errorf("Accept of an empty fingerprint: %v", err)
	}
	v, err := r.m.Accept(id, res.Fingerprint)
	if err != nil || v.State != StateConnecting || v.Pin != s.Fingerprint() || !v.SelfSigned {
		t.Fatalf("Accept: %+v, %v", v, err)
	}
	r.waitState(id, StateConnected)
	for _, q := range s.Requests() {
		if q.Secret != standin.DefaultSecret || q.Client != testLocalID {
			t.Errorf("request %+v", q)
		}
	}
	if got, want := r.callsOf(id), []string{
		"state connecting > fingerprint_not_accepted", "state fingerprint_not_accepted > connecting",
		"snapshot", "state connecting > connected",
	}; !slices.Equal(got, want) {
		t.Errorf("hooks %q; want %q", got, want)
	}
}

// TestConnOtherCertRefused: a server that presents another certificate at a reconnect is refused
// in the handshake: no request, both fingerprints in the view, no retry. An accept connects.
func TestConnOtherCertRefused(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)
	old, requests := s.Fingerprint(), len(s.Requests())

	s.SwapCert([]string{"127.0.0.1"}, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	s.DropStreams()
	v := r.waitState(id, StateCertificateChanged)
	if v.Fingerprint != s.Fingerprint() || v.Pin != old || v.Fingerprint == old {
		t.Errorf("view %+v; want the presented %s and the pinned %s", v, s.Fingerprint(), old)
	}
	staysQuiet(t, s)
	if got := len(s.Requests()); got != requests {
		t.Errorf("%d requests after the certificate changed (%q)", got-requests, paths(s)[requests:])
	}
	if _, err := r.m.Do(context.Background(), id, http.MethodGet, StatePath, nil, 0); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Do: %v", err)
	}
	// A test of the saved entry shows both fingerprints and leaves the state.
	res, err := r.m.TestSaved(context.Background(), id, Patch{})
	if err != nil || res.Outcome != OutcomeCertChanged || res.Fingerprint != s.Fingerprint() || res.Pinned != old {
		t.Fatalf("TestSaved: %+v, %v", res, err)
	}
	time.Sleep(quiet)
	if v := r.view(id); v.State != StateCertificateChanged || len(s.Requests()) != requests {
		t.Errorf("after the test: state %q, requests %q", v.State, paths(s)[requests:])
	}

	if _, err := r.m.Accept(id, v.Fingerprint); err != nil {
		t.Fatal(err)
	}
	if v := r.waitState(id, StateConnected); v.Fingerprint != "" || v.Pin != s.Fingerprint() {
		t.Errorf("view after the accept %+v", v)
	}
	if n := r.count(id, "back"); n != 1 {
		t.Errorf("%d× Back after the accept; want 1", n)
	}
}

// TestConnExpiredPinned: under a pin the certificate's dates and names are not checked.
func TestConnExpiredPinned(t *testing.T) {
	s := standin.Start(t, standin.Options{
		Names: []string{"elsewhere.example"}, NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: time.Now().Add(-time.Hour),
		Hosts: []string{"127.0.0.1"},
	})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)
}

// TestConnSelfSignedBoxOffRetries: without the box a self-signed certificate is refused before
// any request, with Go's text, and the connection keeps trying.
func TestConnSelfSignedBoxOffRetries(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(Input{Name: "Studio", Address: s.URL(), Secret: standin.DefaultSecret})
	v := r.waitState(id, StateCertificateNotAccepted)
	if !strings.Contains(v.Detail, "x509") || v.Fingerprint != "" || v.Pin != "" {
		t.Errorf("view %+v; want Go's text as detail", v)
	}
	waitFor(t, "four handshakes", func() bool { return s.Handshakes() >= 4 })
	if got := paths(s); len(got) != 0 {
		t.Errorf("requests %q; want none", got)
	}
	r.wantStateEvents(id, "certificate_not_accepted")

	// The cure may be on the user's side: with the box and the fingerprint it connects.
	if _, err := r.m.Accept(id, s.Fingerprint()); err != nil {
		t.Fatal(err)
	}
	r.waitState(id, StateConnected)
}

// TestConnLocalID: a server that answers with this server's own id is not connected to.
func TestConnLocalID(t *testing.T) {
	s := standin.Start(t, standin.Options{InstanceID: testLocalID})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	v := r.waitState(id, StateAnotherServer)
	if v.Detail != "This is the local server" || v.InstanceID != "" {
		t.Errorf("view %+v", v)
	}
	staysQuiet(t, s)
	if got := paths(s); !slices.Equal(got, []string{HelloPath}) {
		t.Errorf("requests %q; want the hello alone", got)
	}
	// The test of a form says the same, so such an entry is not saved without "anyway".
	if res := r.m.Test(context.Background(), pinned(s)); res.Outcome != OutcomeIsLocal || res.OK {
		t.Errorf("Test: %+v", res)
	}

	// Offered as an entry it is refused, and nothing is saved or told (AC4).
	root := t.TempDir()
	r = openRig(t, root, nil)
	r.m.Start()
	before := len(s.Requests())
	v, saved, res, err := r.m.Add(context.Background(), form("Me", s), false)
	if err != nil || saved || res == nil || res.OK || res.Outcome != OutcomeIsLocal || v.ID != "" {
		t.Fatalf("Add of the local server: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	if views := r.m.Views(); len(views) != 1 || !views[0].Local {
		t.Errorf("views after the refused add: %+v", views)
	}
	if got := fileEntries(t, root); got != nil {
		t.Errorf("the refused add wrote the list: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(root, FileName)); !os.IsNotExist(err) {
		t.Errorf("the list file after the refused add: %v", err)
	}
	staysQuiet(t, s)
	if got := paths(s)[before:]; !slices.Equal(got, []string{HelloPath}) {
		t.Errorf("the refused add sent %q; want the test's hello alone", got)
	}
	if n := len(r.eventsOf("servers")) + len(r.eventsOf("server_state")); n != 0 {
		t.Errorf("%d events of the list after the refused add", n)
	}
}

// TestConnOneIDTwoAddresses: one server under two addresses is one entry: the second is refused
// by the test, and saved anyway it shows the first one's name and connects to nothing.
func TestConnOneIDTwoAddresses(t *testing.T) {
	s := standin.Start(t, standin.Options{Names: []string{"127.0.0.1", "localhost"}})
	_, port := hostPort(t, s.URL())
	// Both names lead to the stand-in, whatever this machine's resolver says.
	r := startRig(t, func(o *Options) {
		o.Dial = func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
		}
	})
	v, saved, res, err := r.m.Add(context.Background(), form("Studio", s), false)
	if err != nil || !saved || res == nil || !res.OK || v.InstanceID != standin.DefaultInstanceID {
		t.Fatalf("Add: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	first := v.ID
	r.waitState(first, StateConnected)

	second := form("Studio by name", s)
	second.Address = "https://localhost:" + port
	_, saved, res, err = r.m.Add(context.Background(), second, false)
	if err != nil || saved || res == nil || res.Outcome != OutcomeDuplicate || res.Message != "Already added as Studio" {
		t.Fatalf("Add of the second address: saved %v, result %+v, err %v", saved, res, err)
	}
	if got := len(r.m.Views()); got != 2 {
		t.Fatalf("%d views; want the local entry and one", got)
	}

	id := r.add(second)
	w := r.waitState(id, StateAnotherServer)
	if w.Detail != "Already added as Studio" || w.InstanceID != "" {
		t.Errorf("view %+v", w)
	}
	requests := len(s.Requests())
	staysQuiet(t, s)
	if got := paths(s)[requests-1:]; !slices.Equal(got, []string{HelloPath}) {
		t.Errorf("the second entry's last requests %q; want its hello alone", got)
	}
	if v := r.view(first); v.State != StateConnected || s.Streams() != 1 {
		t.Errorf("the first entry is %q with %d streams", v.State, s.Streams())
	}
	if v, ok := r.m.ByInstance(standin.DefaultInstanceID); !ok || v.ID != first {
		t.Errorf("ByInstance: %+v, %v", v, ok)
	}
}

// TestConnTwoForcedEntriesOneServer: two entries saved anyway for one server, connecting at the
// same time: one connects and the other is refused, never both.
func TestConnTwoForcedEntriesOneServer(t *testing.T) {
	s := standin.Start(t, standin.Options{Names: []string{"127.0.0.1", "localhost"}})
	_, port := hostPort(t, s.URL())
	r := openRig(t, t.TempDir(), func(o *Options) {
		o.Dial = func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort("127.0.0.1", port))
		}
	})
	a := r.add(form("A", s))
	second := form("B", s)
	second.Address = "https://localhost:" + port
	b := r.add(second)
	r.m.Start()
	waitFor(t, "both entries to settle", func() bool {
		return r.view(a).State != StateConnecting && r.view(b).State != StateConnecting
	})
	states := []State{r.view(a).State, r.view(b).State}
	slices.Sort(states)
	if !slices.Equal(states, []State{StateAnotherServer, StateConnected}) {
		t.Errorf("states %q; want one connected and one another_server", states)
	}
}

// TestConnOtherIDAtReconnect: another id at a reconnect is another server: no stream, no retry.
func TestConnOtherIDAtReconnect(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	if v := r.waitState(id, StateConnected); v.InstanceID != standin.DefaultInstanceID {
		t.Fatalf("view %+v; want the server's id stored", v)
	}
	requests := len(s.Requests())

	s.SetInstanceID(testOtherID)
	s.DropStreams()
	v := r.waitState(id, StateAnotherServer)
	if v.Detail != "Another server answers at this address" || v.InstanceID != standin.DefaultInstanceID {
		t.Errorf("view %+v", v)
	}
	staysQuiet(t, s)
	if got := paths(s)[requests:]; !slices.Equal(got, []string{HelloPath}) {
		t.Errorf("requests after the id changed %q; want one hello", got)
	}
	if _, err := r.m.Do(context.Background(), id, http.MethodGet, StatePath, nil, 0); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Do: %v", err)
	}
}

// TestConnTooOld: a level below the minimum, or none, is not connected to and not retried; a
// test after the update on that machine connects.
func TestConnTooOld(t *testing.T) {
	for name, level := range map[string]*int{"lower": standin.Level(MinFeatureLevel - 1), "missing": nil} {
		t.Run(name, func(t *testing.T) {
			s := standin.Start(t, standin.Options{Version: "0.9"})
			s.SetFeatureLevel(level)
			r := startRig(t, nil)
			id := r.add(form("Studio", s))
			if v := r.waitState(id, StateTooOld); v.Version != "0.9" || len(v.Agents) != 0 {
				t.Errorf("view %+v; want the old server's version", v)
			}
			staysQuiet(t, s)
			if got := paths(s); !slices.Equal(got, []string{HelloPath}) {
				t.Errorf("requests %q; want one hello", got)
			}
			if _, err := r.m.Do(context.Background(), id, http.MethodPost, "/api/chats", []byte(`{}`), 0); !errors.Is(err, ErrNotConnected) {
				t.Errorf("Do: %v", err)
			}
			if got := paths(s); len(got) != 1 {
				t.Errorf("Do sent a request: %q", got)
			}
			if _, ok := r.m.Lists(id); ok {
				t.Error("Lists of a server that was never connected")
			}

			// A test of the saved entry tries again; the level decides again.
			res, err := r.m.TestSaved(context.Background(), id, Patch{})
			if err != nil || res.Outcome != OutcomeTooOld || res.OK {
				t.Fatalf("TestSaved: %+v, %v", res, err)
			}
			waitFor(t, "the retry's hello", func() bool { return len(s.Requests()) == 3 })
			r.waitState(id, StateTooOld)
			staysQuiet(t, s)

			s.SetFeatureLevel(standin.Level(MinFeatureLevel))
			if res, err = r.m.TestSaved(context.Background(), id, Patch{}); err != nil || !res.OK {
				t.Fatalf("TestSaved after the update: %+v, %v", res, err)
			}
			r.waitState(id, StateConnected)
		})
	}
}

// TestConnReconnects: the server stops and comes back: unreachable, then connected again, with
// the snapshot of the new stream, Back once, and the pin checked at a new handshake.
func TestConnReconnects(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)
	handshakes := s.Handshakes()

	s.Stop()
	r.waitState(id, StateUnreachable)
	dials := r.dials.Load()
	waitFor(t, "retries while it is down", func() bool { return r.dials.Load() >= dials+3 })
	if _, err := r.m.Do(context.Background(), id, http.MethodGet, StatePath, nil, 0); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Do while unreachable: %v", err)
	}
	if v := r.view(id); v.Version != standin.DefaultVersion || len(v.Agents) != 2 {
		t.Errorf("view while unreachable %+v; want the last known version and agents", v)
	}

	s.Restart()
	r.waitState(id, StateConnected)
	if got, want := r.callsOf(id), []string{
		"snapshot", "state connecting > connected", "state connected > unreachable",
		"snapshot", "back", "state unreachable > connected",
	}; !slices.Equal(got, want) {
		t.Errorf("hooks %q; want %q", got, want)
	}
	if got := s.Handshakes(); got <= handshakes {
		t.Errorf("%d handshakes after the restart, %d before", got, handshakes)
	}
	// One event for the outage, however many attempts; a second when the detail became the
	// refused port's.
	waitFor(t, "the events", func() bool { e := r.stateEvents(id); return len(e) >= 3 && e[len(e)-1] == "connected" })
	got := r.stateEvents(id)
	if n := len(got); n < 3 || n > 4 || got[0] != "connected" || got[1] != "unreachable" || got[n-1] != "connected" {
		t.Errorf("server_state events %q", got)
	}
	if rep, err := r.m.Do(context.Background(), id, http.MethodGet, StatePath, nil, 0); err != nil || rep.Status != http.StatusOK {
		t.Errorf("Do after the return: %+v, %v", rep.Status, err)
	}
}

// TestConnSilence: a stream on which nothing arrives, no ping either, for Silence has ended.
func TestConnSilence(t *testing.T) {
	const silence = 400 * time.Millisecond
	s := standin.Start(t, standin.Options{})
	r := startRig(t, func(o *Options) { o.Timing.Silence = silence })
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)

	// With pings the stream outlives Silence.
	time.Sleep(2 * silence)
	if got := r.callsOf(id); len(got) != 2 || s.Streams() != 1 {
		t.Fatalf("hooks %q, %d streams; want the first stream still open", got, s.Streams())
	}

	s.SetPings(false)
	start := time.Now()
	r.waitCall(id, "state connected > unreachable", 1)
	if took := time.Since(start); took < silence-2*standin.DefaultPingEvery || took > silence+2*time.Second {
		t.Errorf("unreachable after %v of silence; want about %v", took, silence)
	}
	waitFor(t, "the event with the silence as detail", func() bool {
		return slices.ContainsFunc(r.eventsOf("server_state"), func(ev map[string]any) bool {
			s := ev["server"].(map[string]any)
			return s["state"] == "unreachable" && s["detail"] == detailSilence
		})
	})
	// It connects again at once: the server is there, only silent.
	r.waitCall(id, "snapshot", 2)
}

// TestConnSecretChanged: after a new secret on the server the entry stops at "secret not
// accepted"; an edit with the new secret connects, and Back says so.
func TestConnSecretChanged(t *testing.T) {
	const newSecret = "a-new-secret-0123456789"
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)
	requests := len(s.Requests())

	s.SetSecret(newSecret) // what a secret reload does: the new secret first, then the streams end
	s.DropStreams()
	r.waitState(id, StateSecretNotAccepted)
	staysQuiet(t, s)
	if got := paths(s)[requests:]; !slices.Equal(got, []string{HelloPath}) {
		t.Errorf("requests after the secret changed %q; want one hello", got)
	}

	// The same values again are no cure; the server refuses them in the edit's test.
	old := standin.DefaultSecret
	if _, saved, res, err := r.m.Edit(context.Background(), id, Patch{Secret: &old}, false); err != nil || !saved || res != nil {
		t.Errorf("Edit with the stored secret: saved %v, result %+v, err %v", saved, res, err)
	}
	r.waitState(id, StateSecretNotAccepted)

	secret := newSecret
	v, saved, res, err := r.m.Edit(context.Background(), id, Patch{Secret: &secret}, false)
	if err != nil || !saved || res == nil || !res.OK || v.ID != id || v.State != StateConnecting {
		t.Fatalf("Edit: %+v, saved %v, result %+v, err %v", v, saved, res, err)
	}
	r.waitState(id, StateConnected)
	if n := r.count(id, "back"); n != 1 {
		t.Errorf("%d× Back; want 1. Hooks: %q", n, r.callsOf(id))
	}
	if n := r.count(id, "snapshot"); n != 2 {
		t.Errorf("%d× Snapshot; want 2", n)
	}
	last := s.Requests()[len(s.Requests())-1]
	if last.Path != StreamPath || last.Secret != newSecret {
		t.Errorf("last request %+v; want the stream with the new secret", last)
	}
}

// TestConnSecretRefusedAtACall: a 401 on a call passed on is "secret not accepted" too.
func TestConnSecretRefusedAtACall(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)

	s.SetSecret("a-new-secret-0123456789") // the stream stays open
	rep, err := r.m.Do(context.Background(), id, http.MethodGet, StatePath, nil, 0)
	if err != nil || rep.Status != http.StatusUnauthorized {
		t.Fatalf("Do: %+v, %v; want the 401", rep, err)
	}
	r.waitState(id, StateSecretNotAccepted)
	waitFor(t, "the stream's end", func() bool { return s.Streams() == 0 })
	requests := len(s.Requests())
	staysQuiet(t, s)
	if _, err := r.m.Do(context.Background(), id, http.MethodGet, StatePath, nil, 0); !errors.Is(err, ErrNotConnected) {
		t.Errorf("Do after it: %v", err)
	}
	if got := len(s.Requests()); got != requests {
		t.Errorf("requests after the 401: %q", paths(s)[requests:])
	}
}

// TestDoHeadersAndLimit: a call carries the secret and the client id, takes its limit from the
// caller or from Timing.Call, and its end leaves the stream open.
func TestDoHeadersAndLimit(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	var got atomic.Value
	s.Handle("POST /api/echo", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got.Store(r.Header.Get("Content-Type") + " " + r.URL.RawQuery + " " + string(body))
		answer(http.StatusTeapot, "application/json", `{"echo":true}`)(w, r)
	})
	s.Handle("GET /api/slow", hang)
	s.Handle("GET /api/late", func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(900 * time.Millisecond)
		answer(http.StatusOK, "text/plain", "late")(w, r)
	})
	r := startRig(t, func(o *Options) {
		o.Timing.Headers = 500 * time.Millisecond // of hello and the stream; no limit of a call
		o.Timing.Call = 300 * time.Millisecond
	})
	ctx := context.Background()

	if _, err := r.m.Do(ctx, LocalID, http.MethodGet, StatePath, nil, 0); !errors.Is(err, ErrLocalEntry) {
		t.Errorf("Do for the local entry: %v", err)
	}
	if _, err := r.m.Do(ctx, "s_000000000000", http.MethodGet, StatePath, nil, 0); !errors.Is(err, ErrNotFound) {
		t.Errorf("Do for no entry: %v", err)
	}
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)
	requests := len(s.Requests())

	rep, err := r.m.Do(ctx, id, http.MethodPost, "/api/echo?x=1", []byte(`{"a":1}`), 0)
	if err != nil || rep.Status != http.StatusTeapot || rep.ContentType != "application/json" || string(rep.Body) != `{"echo":true}` {
		t.Fatalf("Do: %+v (%s), %v", rep, rep.Body, err)
	}
	if got.Load() != `application/json x=1 {"a":1}` {
		t.Errorf("the server got %q", got.Load())
	}
	if q := s.Requests()[requests]; q != (standin.Request{Method: http.MethodPost, Path: "/api/echo", Secret: standin.DefaultSecret, Client: testLocalID}) {
		t.Errorf("request %+v", q)
	}

	// A path that is none is not sent: it could put another host in the address's place.
	requests = len(s.Requests())
	for _, path := range []string{"", "api/state", "@elsewhere.example/api/state", "0.elsewhere.example/"} {
		if _, err := r.m.Do(ctx, id, http.MethodGet, path, nil, 0); err == nil || errors.Is(err, ErrNotConnected) {
			t.Errorf("Do(%q): %v", path, err)
		}
	}
	if got := paths(s)[requests:]; len(got) != 0 || r.dials.Load() != 1 {
		t.Errorf("requests for paths that are none: %q, %d dials", got, r.dials.Load())
	}

	for name, c := range map[string]struct{ limit, want time.Duration }{
		"the caller's limit": {500 * time.Millisecond, 500 * time.Millisecond},
		"Timing.Call":        {0, 300 * time.Millisecond},
	} {
		start := time.Now()
		_, err := r.m.Do(ctx, id, http.MethodGet, "/api/slow", nil, c.limit)
		if took := time.Since(start); !errors.Is(err, context.DeadlineExceeded) || took < c.want || took > c.want+2*time.Second {
			t.Errorf("%s: ended after %v with %v; want %v and the deadline", name, took, err, c.want)
		}
	}
	// An answer later than Timing.Headers and within the call's limit is an answer.
	if rep, err := r.m.Do(ctx, id, http.MethodGet, "/api/late", nil, 3*time.Second); err != nil || string(rep.Body) != "late" {
		t.Errorf("a late answer: %+v, %v", rep, err)
	}
	// The caller's context ends a call too.
	cctx, cancel := context.WithCancel(ctx)
	time.AfterFunc(100*time.Millisecond, cancel)
	if _, err := r.m.Do(cctx, id, http.MethodGet, "/api/slow", nil, 3*time.Second); !errors.Is(err, context.Canceled) {
		t.Errorf("a cancelled call: %v", err)
	}

	// The stream is the one of before, and still delivers.
	s.Send(map[string]any{"type": "after"})
	r.waitCall(id, "event after", 1)
	if got := r.callsOf(id); !slices.Equal(got, []string{"snapshot", "state connecting > connected", "event after"}) || s.Streams() != 1 {
		t.Errorf("hooks %q, %d streams; want the first stream still open", got, s.Streams())
	}
}

// TestStreamHasNoLimit: the limits of hello, of the stream's start and of a call end no stream.
func TestStreamHasNoLimit(t *testing.T) {
	const limit = 400 * time.Millisecond
	s := standin.Start(t, standin.Options{})
	r := startRig(t, func(o *Options) {
		o.Timing.Headers, o.Timing.Hello, o.Timing.FirstEvent, o.Timing.Call, o.Timing.TestStep = limit, limit, limit, limit, limit
	})
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)
	time.Sleep(3 * limit)
	s.Send(map[string]any{"type": "late"})
	r.waitCall(id, "event late", 1)
	if got := r.callsOf(id); !slices.Equal(got, []string{"snapshot", "state connecting > connected", "event late"}) {
		t.Errorf("hooks %q; want one stream", got)
	}
	if got := paths(s); !slices.Equal(got, []string{HelloPath, StreamPath}) {
		t.Errorf("requests %q", got)
	}
}

// TestEventsInOrder: every event after the snapshot reaches Hooks.Event, in the order sent.
func TestEventsInOrder(t *testing.T) {
	const n = 200
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	r.waitState(id, StateConnected)
	big := strings.Repeat("x", 100<<10) // longer than the reader's buffer
	for i := range n {
		ev := map[string]any{"type": "n", "n": i}
		if i == n/2 {
			ev["big"] = big
		}
		s.Send(ev)
	}
	r.waitCall(id, "event n", n)
	r.mu.Lock()
	raws := slices.Clone(r.raws)
	r.mu.Unlock()
	if len(raws) != n {
		t.Fatalf("%d events; want %d", len(raws), n)
	}
	for i, raw := range raws {
		var ev struct {
			N   int
			Big string
		}
		if err := json.Unmarshal([]byte(raw), &ev); err != nil || ev.N != i {
			t.Fatalf("event %d is %.80s (%v)", i, raw, err)
		}
		if i == n/2 && ev.Big != big {
			t.Errorf("the long event lost %d of its bytes", len(big)-len(ev.Big))
		}
	}
	if got := r.callsOf(id)[:2]; !slices.Equal(got, []string{"snapshot", "state connecting > connected"}) {
		t.Errorf("hooks begin with %q", got)
	}
}

// TestAgentsEventUpdatesView: the usable agents of the snapshot, then of an "agents" event, are
// in the view, in a server_state event and in Lists; a "catalog" event updates Lists.
func TestAgentsEventUpdatesView(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	r := startRig(t, nil)
	id := r.add(form("Studio", s))
	v := r.waitState(id, StateConnected)
	if !slices.Equal(v.Agents, []model.AgentKind{model.Claude, model.Pi}) || v.Version != standin.DefaultVersion {
		t.Fatalf("view %+v", v)
	}
	l, ok := r.m.Lists(id)
	if !ok || !slices.Equal(l.Agents, v.Agents) || l.Home != "/home/standin" || l.DefaultCwd != "/home/standin/work" ||
		l.Catalogs[model.Claude] == nil || l.Catalogs[model.Claude].Default.Model != "standin-model" {
		t.Fatalf("Lists: %+v, %v", l, ok)
	}
	if c, has := l.Catalogs[model.Pi]; !has || c != nil {
		t.Errorf("pi's catalog: %+v, %v; want a nil one", c, has)
	}

	s.Send(map[string]any{"type": "agents", "agents": []string{"cursor", "new\u0007kind"}})
	s.Send(map[string]any{"type": "catalog", "agent": "pi", "catalog": model.Catalog{Models: []model.CatalogModel{{ID: "pi-1"}}}})
	r.waitCall(id, "event catalog", 1)
	want := []model.AgentKind{model.Cursor, "newkind"}
	if v := r.view(id); !slices.Equal(v.Agents, want) {
		t.Errorf("agents in the view %q; want %q", v.Agents, want)
	}
	if l, _ := r.m.Lists(id); !slices.Equal(l.Agents, want) || l.Catalogs[model.Pi] == nil || l.Catalogs[model.Pi].Models[0].ID != "pi-1" || l.Catalogs[model.Claude] == nil {
		t.Errorf("Lists after the events: %+v", l)
	}
	if got := r.callsOf(id); !slices.Equal(got, []string{"snapshot", "state connecting > connected", "event agents", "event catalog"}) {
		t.Errorf("hooks %q", got)
	}
	waitFor(t, "the second server_state event", func() bool { return len(r.stateEvents(id)) == 2 })
	last := r.eventsOf("server_state")[1]["server"].(map[string]any)
	if fmt.Sprint(last["agents"]) != "[cursor newkind]" || last["state"] != "connected" {
		t.Errorf("event %v", last)
	}
	// A list given out is the caller's.
	l, _ = r.m.Lists(id)
	l.Agents[0], l.Catalogs[model.Claude] = "changed", nil
	if again, _ := r.m.Lists(id); again.Agents[0] != model.Cursor || again.Catalogs[model.Claude] == nil {
		t.Error("a change of a returned Lists reached the manager")
	}
}

// TestReadEvent: the stream's format: data lines, comments, other fields, a last event cut off.
func TestReadEvent(t *testing.T) {
	stream := ": ping\n\ndata: {\"a\":1}\n\n: ping\n\nevent: x\nid: 7\ndata:{\"b\":\ndata: 2}\r\n\r\n\n\ndata: {\"cut\":"
	br := bufioReader(stream)
	for _, want := range []string{`{"a":1}`, "{\"b\":\n2}"} {
		got, err := readEvent(br)
		if err != nil || string(got) != want {
			t.Fatalf("event %q, %v; want %q", got, err, want)
		}
	}
	if got, err := readEvent(br); !errors.Is(err, io.EOF) {
		t.Errorf("after the last whole event: %q, %v; want EOF", got, err)
	}
	if _, err := readLine(bufioReader(strings.Repeat("x", 100)+"\n"), 50); !errors.Is(err, ErrTooLong) {
		t.Errorf("a line over its limit: %v", err)
	}
	if typ, ok := typeOf([]byte(`{"type":"x"}`)); typ != "x" || !ok {
		t.Errorf("typeOf: %q, %v", typ, ok)
	}
	if _, ok := typeOf([]byte(`[1]`)); ok {
		t.Error("typeOf takes an array")
	}
}

// TestTiming: the defaults of the plan, and the back-off with its ±20 %.
func TestTiming(t *testing.T) {
	const s = time.Second
	d := (Timing{}).withDefaults()
	if d.Dial != 3*s || d.Handshake != 3*s || d.Headers != 3*s || d.Hello != 10*s || d.FirstEvent != 10*s ||
		d.Call != 15*s || d.TestStep != 5*s || d.Silence != 35*s || d.Jitter != 0.2 || d.Stable != 30*s ||
		!slices.Equal(d.Backoff, []time.Duration{1 * s, 2 * s, 5 * s, 10 * s, 30 * s}) {
		t.Errorf("defaults %+v", d)
	}
	for n, step := range []time.Duration{1 * s, 2 * s, 5 * s, 10 * s, 30 * s, 30 * s, 30 * s} {
		low, high := step, step
		for range 500 {
			got := d.backoff(n)
			low, high = min(low, got), max(high, got)
		}
		if low < step*8/10 || high > step*12/10 || low > step*9/10 || high < step*11/10 {
			t.Errorf("back-off %d of %v is between %v and %v; want ±20 %%", n, step, low, high)
		}
	}
	exact := Timing{Backoff: []time.Duration{7 * time.Millisecond}, Jitter: -1}.withDefaults()
	if exact.backoff(0) != 7*time.Millisecond || exact.backoff(9) != 7*time.Millisecond {
		t.Errorf("back-off without jitter: %v, %v", exact.backoff(0), exact.backoff(9))
	}
	// Stable is the default's with the default's back-off alone.
	if got := (Timing{Dial: s}).withDefaults().Stable; got != 30*s {
		t.Errorf("Stable of a Timing without Backoff: %v", got)
	}
	if got := (Timing{Backoff: []time.Duration{s}, Stable: 2 * s}).withDefaults().Stable; exact.Stable != 0 || got != 2*s {
		t.Errorf("Stable of a Timing with Backoff: %v and %v; want 0 and 2s", exact.Stable, got)
	}
}

func bufioReader(s string) *bufio.Reader { return bufio.NewReaderSize(bytes.NewReader([]byte(s)), 16) }
