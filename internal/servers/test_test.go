package servers

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/testset"
)

const (
	testLocalID = "0b0e6f52-1c3d-4a8e-b7f1-93a2c4d5e6f7"
	testOtherID = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
)

// pinned is the target that connects to s: the default secret, the box on, s's fingerprint.
func pinned(s *standin.Server) Target {
	return Target{Address: s.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: s.Fingerprint()}
}

func testOptions() Options {
	return Options{LocalID: testLocalID, Timing: Timing{TestStep: testLimit}}
}

func run(t Target, id Identity, o Options) Result {
	if id.LocalID == "" {
		id.LocalID = testLocalID
	}
	return TestConnection(context.Background(), t, id, o)
}

// hang is a handler that answers nothing until the client leaves or the server stops.
func hang(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }

func answer(status int, contentType, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

// TestTestConnectionRows has one case and more per outcome of the table: outcome, step, message
// and fingerprints.
func TestTestConnectionRows(t *testing.T) {
	t.Parallel()
	good := standin.Start(t, standin.Options{})
	other := standin.Start(t, standin.Options{})
	named := standin.Start(t, standin.Options{Names: []string{"elsewhere.example"}})
	expired := standin.Start(t, standin.Options{NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: time.Now().Add(-time.Hour)})
	badHost := standin.Start(t, standin.Options{Hosts: []string{"studio.example:4748"}})
	notAIWB := standin.NotAIWB(t)
	issued := tlsListener(t, &tls.Config{Certificates: []tls.Certificate{issuedPair(t)}})
	oldTLS := tlsListener(t, &tls.Config{
		Certificates: []tls.Certificate{issuedPair(t)}, MinVersion: tls.VersionTLS10, MaxVersion: tls.VersionTLS11,
	})

	with := func(o Options, f func(*Options)) Options { f(&o); return o }
	short := with(testOptions(), func(o *Options) { o.Timing.TestStep = 300 * time.Millisecond })
	helloServer := func(h http.HandlerFunc) *standin.Server {
		s := standin.Start(t, standin.Options{})
		s.SetHello(h)
		return s
	}
	stateServer := func(snap any, h http.HandlerFunc) *standin.Server {
		s := standin.Start(t, standin.Options{})
		if h != nil {
			s.Handle("GET "+StatePath, h)
		} else {
			s.SetSnapshot(snap)
		}
		return s
	}
	without := func(key string) map[string]any {
		snap := standin.DefaultSnapshot()
		delete(snap, key)
		return snap
	}
	set := func(key string, v any) map[string]any {
		snap := standin.DefaultSnapshot()
		snap[key] = v
		return snap
	}
	noLevel := standin.Start(t, standin.Options{})
	noLevel.SetFeatureLevel(nil)

	cases := []struct {
		name    string
		target  Target
		id      Identity
		opts    Options
		outcome Outcome
		step    int
		message string
		check   func(t *testing.T, r Result)
	}{
		// Step 1.
		{name: "http address", target: Target{Address: "http://127.0.0.1:4748", Secret: "s"}, opts: testOptions(),
			outcome: "bad_address", step: 1, message: "Not a valid https address"},
		{name: "no port", target: Target{Address: "https://studio.example", Secret: "s"}, opts: testOptions(),
			outcome: "bad_address", step: 1, message: "Not a valid https address"},

		// Step 2.
		{name: "refused", target: Target{Address: standin.Refused(t), Secret: "s"}, opts: testOptions(),
			outcome: "refused", step: 2, message: "Nothing listens there: is remote access set up on that machine?"},
		{name: "name not found", target: Target{Address: "https://studio.example:4748", Secret: "s"},
			opts: with(testOptions(), func(o *Options) {
				o.Dial = failDial(&net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: "studio.example", IsNotFound: true}}, nil)
			}),
			outcome: "name_not_found", step: 2, message: "Name not found"},
		{name: "no route", target: Target{Address: "https://studio.example:4748", Secret: "s"},
			opts: with(testOptions(), func(o *Options) {
				o.Dial = failDial(&net.OpError{Op: "dial", Net: "tcp4", Err: syscall.EHOSTUNREACH}, nil)
			}),
			outcome: "no_route", step: 2, message: "No answer: is the VPN up?"},
		{name: "no answer to the dial", target: Target{Address: "https://studio.example:4748", Secret: "s"},
			opts:    with(short, func(o *Options) { o.Timing.TestStep = 200 * time.Millisecond; o.Dial = blockDial }),
			outcome: "no_route", step: 2, message: "No answer: is the VPN up?"},

		// Step 3.
		{name: "accepts and never answers", target: Target{Address: standin.Silent(t), Secret: "s"}, opts: short,
			outcome: "tls_timeout", step: 3,
			message: "No answer: is the VPN up, and does a firewall on the server's machine let the port through?"},
		{name: "plain HTTP", target: Target{Address: standin.PlainHTTP(t), Secret: "s"}, opts: testOptions(),
			outcome: "not_https", step: 3, message: "Not HTTPS: this may be the server's local port"},
		{name: "box on, no pin", target: Target{Address: good.URL(), Secret: standin.DefaultSecret, SelfSigned: true}, opts: testOptions(),
			outcome: "fingerprint", step: 3, message: "Compare this fingerprint with the one shown on the other machine, then accept it",
			check: func(t *testing.T, r Result) {
				if r.Fingerprint != good.Fingerprint() || r.Pinned != "" {
					t.Errorf("fingerprint %q, pinned %q; want %q and none", r.Fingerprint, r.Pinned, good.Fingerprint())
				}
			}},
		{name: "another certificate than the pinned",
			target: Target{Address: good.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: other.Fingerprint()}, opts: testOptions(),
			outcome: "cert_changed", step: 3, message: "Certificate changed",
			check: func(t *testing.T, r Result) {
				if r.Fingerprint != good.Fingerprint() || r.Pinned != other.Fingerprint() {
					t.Errorf("fingerprint %q, pinned %q; want %q, %q", r.Fingerprint, r.Pinned, good.Fingerprint(), other.Fingerprint())
				}
			}},
		{name: "box off, another name", target: Target{Address: named.URL(), Secret: standin.DefaultSecret},
			opts:    with(testOptions(), func(o *Options) { o.Roots = named.Pool() }),
			outcome: "cert_name", step: 3, message: "The certificate is not for this name",
			check: func(t *testing.T, r Result) {
				if !strings.Contains(r.Detail, "127.0.0.1") {
					t.Errorf("detail %q; want Go's text with the name asked for", r.Detail)
				}
			}},
		{name: "box off, expired", target: Target{Address: expired.URL(), Secret: standin.DefaultSecret},
			opts:    with(testOptions(), func(o *Options) { o.Roots = expired.Pool() }),
			outcome: "cert_expired", step: 3, message: "The certificate has expired",
			check: func(t *testing.T, r Result) {
				if !strings.Contains(r.Detail, "expired") {
					t.Errorf("detail %q; want Go's text", r.Detail)
				}
			}},
		{name: "box off, self-signed, the system's roots", target: Target{Address: good.URL(), Secret: standin.DefaultSecret}, opts: testOptions(),
			outcome: "self_signed", step: 3, message: "Self-signed certificate: tick the box"},
		{name: "box off, an unknown CA", target: Target{Address: issued, Secret: "s"},
			opts:    with(testOptions(), func(o *Options) { o.Roots = other.Pool() }),
			outcome: "cert_untrusted", step: 3, message: "The certificate is not trusted",
			check: func(t *testing.T, r Result) {
				if r.Detail == "" {
					t.Error("no detail; want Go's text")
				}
			}},
		{name: "no common TLS version", target: Target{Address: oldTLS, Secret: "s"},
			opts:    with(testOptions(), func(o *Options) { o.Roots = other.Pool() }),
			outcome: "tls_error", step: 3, message: "The secure connection failed",
			check: func(t *testing.T, r Result) {
				if r.Detail == "" {
					t.Error("no detail; want Go's text")
				}
			}},

		// Step 4.
		{name: "another secret", target: Target{Address: good.URL(), Secret: "not-the-secret", SelfSigned: true, Pin: good.Fingerprint()}, opts: testOptions(),
			outcome: "secret_refused", step: 4, message: "Secret not accepted"},
		{name: "a name the server does not know", target: pinned(badHost), opts: testOptions(),
			outcome: "bad_host", step: 4, message: "The server does not know this name: run set-up there with it"},
		{name: "something else, 200 text/html", target: pinned(notAIWB), opts: testOptions(),
			outcome: "not_aiwb", step: 4, message: "Something else answers there"},
		{name: "something else, 404", target: pinned(helloServer(answer(404, "application/json", `{"error":"not found"}`))), opts: testOptions(),
			outcome: "not_aiwb", step: 4, message: "Something else answers there",
			check: func(t *testing.T, r Result) {
				if r.Detail != "HTTP 404: not found" {
					t.Errorf("detail %q", r.Detail)
				}
			}},
		{name: "something else, 403 that is not bad host", target: pinned(helloServer(answer(403, "text/plain", "Forbidden"))), opts: testOptions(),
			outcome: "not_aiwb", step: 4, message: "Something else answers there"},
		{name: "something else, a redirect",
			target: pinned(helloServer(func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, other.URL()+HelloPath, http.StatusFound)
			})),
			opts: testOptions(), outcome: "not_aiwb", step: 4, message: "Something else answers there",
			check: func(t *testing.T, r Result) {
				if len(other.Requests()) != 0 {
					t.Errorf("the redirect was followed: %v", other.Requests())
				}
			}},
		{name: "something else, another app",
			target: pinned(helloServer(answer(200, "application/json", `{"app":"other","instanceId":"`+standin.DefaultInstanceID+`","featureLevel":1}`))),
			opts:   testOptions(), outcome: "not_aiwb", step: 4, message: "Something else answers there"},
		{name: "something else, an id that is none",
			target: pinned(helloServer(answer(200, "application/json", `{"app":"ai-whiteboard","instanceId":"local","featureLevel":1}`))),
			opts:   testOptions(), outcome: "not_aiwb", step: 4, message: "Something else answers there"},
		{name: "something else, a JSON array", target: pinned(helloServer(answer(200, "application/json", `[]`))), opts: testOptions(),
			outcome: "not_aiwb", step: 4, message: "Something else answers there"},
		{name: "no level", target: pinned(noLevel), opts: testOptions(),
			outcome: "too_old", step: 4, message: "Server too old: update it on that machine"},
		{name: "the local server's id", target: pinned(good), id: Identity{LocalID: standin.DefaultInstanceID}, opts: testOptions(),
			outcome: "is_local", step: 4, message: "This is the local server"},
		{name: "another entry's id", target: pinned(good), id: Identity{Others: map[string]string{standin.DefaultInstanceID: "Studio"}}, opts: testOptions(),
			outcome: "duplicate", step: 4, message: "Already added as Studio"},
		{name: "not the edited entry's id", target: pinned(good), id: Identity{Expect: testOtherID}, opts: testOptions(),
			outcome: "another_server", step: 4, message: "Another server answers at this address"},
		{name: "hello never answers", target: pinned(helloServer(hang)), opts: short,
			outcome: "no_answer", step: 4, message: "No answer from the server"},

		// Step 5.
		{name: "connected", target: pinned(good), id: Identity{Expect: standin.DefaultInstanceID, Others: map[string]string{testOtherID: "Studio"}}, opts: testOptions(),
			outcome: "connected", step: 5, message: "Connected",
			check: func(t *testing.T, r Result) {
				if r.Version != standin.DefaultVersion || r.InstanceID != standin.DefaultInstanceID || r.FeatureLevel != 1 ||
					len(r.Agents) != 2 || r.Agents[0] != model.Claude || r.Agents[1] != model.Pi {
					t.Errorf("result %+v; want the stand-in's version, id, level and agents", r)
				}
			}},
		{name: "connected, box off, the certificate as its own root", target: Target{Address: good.URL(), Secret: standin.DefaultSecret},
			opts:    with(testOptions(), func(o *Options) { o.Roots = good.Pool() }),
			outcome: "connected", step: 5, message: "Connected"},
		{name: "the state never answers", target: pinned(stateServer(nil, hang)), opts: short,
			outcome: "no_answer", step: 5, message: "No answer from the server"},
		{name: "state 500", target: pinned(stateServer(nil, answer(500, "application/json", `{"error":"boom"}`))), opts: testOptions(),
			outcome: "no_state", step: 5, message: "Connected, but the server's state could not be read"},
		{name: "state not JSON", target: pinned(stateServer(nil, answer(200, "text/html", `<p>hello`))), opts: testOptions(),
			outcome: "no_state", step: 5, message: "Connected, but the server's state could not be read"},
		{name: "state without agents", target: pinned(stateServer(without("agents"), nil)), opts: testOptions(),
			outcome: "no_state", step: 5, message: "Connected, but the server's state could not be read"},
		{name: "state without catalogs", target: pinned(stateServer(without("catalogs"), nil)), opts: testOptions(),
			outcome: "no_state", step: 5, message: "Connected, but the server's state could not be read"},
		{name: "state with catalogs null", target: pinned(stateServer(set("catalogs", nil), nil)), opts: testOptions(),
			outcome: "no_state", step: 5, message: "Connected, but the server's state could not be read"},
		{name: "state with an empty home", target: pinned(stateServer(set("home", ""), nil)), opts: testOptions(),
			outcome: "no_state", step: 5, message: "Connected, but the server's state could not be read"},
		{name: "state without defaultCwd", target: pinned(stateServer(without("defaultCwd"), nil)), opts: testOptions(),
			outcome: "no_state", step: 5, message: "Connected, but the server's state could not be read"},
		{name: "state with chats an object", target: pinned(stateServer(set("chats", map[string]any{}), nil)), opts: testOptions(),
			outcome: "no_state", step: 5, message: "Connected, but the server's state could not be read"},
		{name: "state without runs and states, defaultCwd empty",
			target: pinned(stateServer(map[string]any{"agents": []string{}, "catalogs": map[string]any{}, "home": "/h", "defaultCwd": "", "chats": []any{}}, nil)),
			opts:   testOptions(), outcome: "connected", step: 5, message: "Connected"},
	}
	var mu sync.Mutex
	seen := map[Outcome]bool{}
	// The cases run in parallel, inside a group that ends when the last of them has.
	t.Run("cases", func(t *testing.T) {
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				t.Parallel()
				r := run(c.target, c.id, c.opts)
				mu.Lock()
				seen[r.Outcome] = true
				mu.Unlock()
				if r.Outcome != c.outcome || r.Step != c.step || r.Message != c.message {
					t.Fatalf("got %s, step %d, %q (detail %q)\nwant %s, step %d, %q", r.Outcome, r.Step, r.Message, r.Detail, c.outcome, c.step, c.message)
				}
				if r.OK != (c.outcome == OutcomeConnected) {
					t.Errorf("ok = %v", r.OK)
				}
				if c.outcome != OutcomeFingerprint && c.outcome != OutcomeCertChanged && (r.Fingerprint != "" || r.Pinned != "") {
					t.Errorf("fingerprints %q, %q; want none", r.Fingerprint, r.Pinned)
				}
				if c.check != nil {
					c.check(t, r)
				}
			})
		}
	})
	for _, row := range outcomes {
		if !seen[row.outcome] {
			t.Errorf("no case gave the outcome %s", row.outcome)
		}
	}
}

// TestOutcomeTableComplete: the table names every outcome once, with a step and its message.
func TestOutcomeTableComplete(t *testing.T) {
	t.Parallel()
	want := map[Outcome]string{
		OutcomeBadAddress:    "Not a valid https address",
		OutcomeRefused:       "Nothing listens there: is remote access set up on that machine?",
		OutcomeNameNotFound:  "Name not found",
		OutcomeNoRoute:       "No answer: is the VPN up?",
		OutcomeTLSTimeout:    "No answer: is the VPN up, and does a firewall on the server's machine let the port through?",
		OutcomeNotHTTPS:      "Not HTTPS: this may be the server's local port",
		OutcomeFingerprint:   "Compare this fingerprint with the one shown on the other machine, then accept it",
		OutcomeCertChanged:   "Certificate changed",
		OutcomeCertName:      "The certificate is not for this name",
		OutcomeCertExpired:   "The certificate has expired",
		OutcomeSelfSigned:    "Self-signed certificate: tick the box",
		OutcomeCertUntrusted: "The certificate is not trusted",
		OutcomeTLSError:      "The secure connection failed",
		OutcomeSecretRefused: "Secret not accepted",
		OutcomeBadHost:       "The server does not know this name: run set-up there with it",
		OutcomeNotAIWB:       "Something else answers there",
		OutcomeTooOld:        "Server too old: update it on that machine",
		OutcomeIsLocal:       "This is the local server",
		OutcomeDuplicate:     "Already added as",
		OutcomeAnotherServer: "Another server answers at this address",
		OutcomeNoAnswer:      "No answer from the server",
		OutcomeConnected:     "Connected",
		OutcomeNoState:       "Connected, but the server's state could not be read",
	}
	if len(outcomes) != len(want) {
		t.Errorf("the table has %d rows; want %d", len(outcomes), len(want))
	}
	last, seen := 1, map[Outcome]bool{}
	for _, row := range outcomes {
		if seen[row.outcome] {
			t.Errorf("%s is in the table twice", row.outcome)
		}
		seen[row.outcome] = true
		if row.message != want[row.outcome] || row.outcome.Message() != row.message {
			t.Errorf("%s: message %q; want %q", row.outcome, row.message, want[row.outcome])
		}
		if row.step < last || row.step > 5 || row.outcome.Step() != row.step {
			t.Errorf("%s: step %d after step %d", row.outcome, row.step, last)
		}
		last = row.step
		if r := result(row.outcome); r.OK != (row.outcome == OutcomeConnected) {
			t.Errorf("%s: ok = %v", row.outcome, r.OK)
		}
	}
	if Outcome("nonsense").Message() != "" || Outcome("nonsense").Step() != 0 {
		t.Error("an unknown code has a message or a step")
	}
	if MinFeatureLevel != 1 || HelloPath != "/api/hello" || StatePath != "/api/state" || StreamPath != "/api/events" {
		t.Error("the level or a path changed")
	}
}

// TestSecretNotSentBeforeCertificate: a certificate that was not accepted gets no request, and
// so no secret.
func TestSecretNotSentBeforeCertificate(t *testing.T) {
	t.Parallel()
	other := standin.Start(t, standin.Options{})
	for _, c := range []struct {
		name    string
		options standin.Options
		target  func(s *standin.Server) Target
		roots   bool // Roots = the stand-in's pool; else the system's
		want    Outcome
	}{
		{"fingerprint", standin.Options{}, func(s *standin.Server) Target {
			return Target{Address: s.URL(), Secret: standin.DefaultSecret, SelfSigned: true}
		}, false, OutcomeFingerprint},
		{"cert_changed", standin.Options{}, func(s *standin.Server) Target {
			return Target{Address: s.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: other.Fingerprint()}
		}, false, OutcomeCertChanged},
		{"self_signed", standin.Options{}, func(s *standin.Server) Target {
			return Target{Address: s.URL(), Secret: standin.DefaultSecret}
		}, false, OutcomeSelfSigned},
		{"cert_name", standin.Options{Names: []string{"elsewhere.example"}}, func(s *standin.Server) Target {
			return Target{Address: s.URL(), Secret: standin.DefaultSecret}
		}, true, OutcomeCertName},
		{"cert_expired", standin.Options{NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: time.Now().Add(-time.Hour)}, func(s *standin.Server) Target {
			return Target{Address: s.URL(), Secret: standin.DefaultSecret}
		}, true, OutcomeCertExpired},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			s := standin.Start(t, c.options)
			o := testOptions()
			if c.roots {
				o.Roots = s.Pool()
			}
			r := run(c.target(s), Identity{}, o)
			if r.Outcome != c.want || r.Step != 3 || r.OK {
				t.Fatalf("got %s at step %d; want %s at step 3", r.Outcome, r.Step, c.want)
			}
			time.Sleep(50 * time.Millisecond) // a request on its way would have arrived
			if s.Handshakes() != 1 {
				t.Errorf("%d handshakes; want 1", s.Handshakes())
			}
			if reqs := s.Requests(); len(reqs) != 0 {
				t.Errorf("requests %v; want none", reqs)
			}
			if b, _ := json.Marshal(r); strings.Contains(string(b), standin.DefaultSecret) {
				t.Errorf("the result holds the secret: %s", b)
			}
		})
	}
}

// TestPinnedConnects: with the pin the test sends hello and the state on one connection, each
// with the secret and the local id.
func TestPinnedConnects(t *testing.T) {
	t.Parallel()
	s := standin.Start(t, standin.Options{})
	r := run(pinned(s), Identity{}, testOptions())
	if !r.OK || r.Outcome != OutcomeConnected || r.Step != 5 {
		t.Fatalf("result %+v; want connected", r)
	}
	want := []standin.Request{
		{Method: "GET", Path: HelloPath, Secret: standin.DefaultSecret, Client: testLocalID},
		{Method: "GET", Path: StatePath, Secret: standin.DefaultSecret, Client: testLocalID},
	}
	got := s.Requests()
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("requests %v; want %v", got, want)
	}
	if s.Handshakes() != 1 {
		t.Errorf("%d handshakes; want 1: steps 4 and 5 use the connection of steps 2 and 3", s.Handshakes())
	}
	if s.Streams() != 0 {
		t.Errorf("%d streams; want none", s.Streams())
	}
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON := `{"ok":true,"step":5,"outcome":"connected","message":"Connected","version":"standin",` +
		`"instanceId":"` + standin.DefaultInstanceID + `","featureLevel":1,"agents":["claude","pi"]}`
	if string(b) != wantJSON {
		t.Errorf("JSON %s\nwant %s", b, wantJSON)
	}

	// Identity.LocalID empty: Options.LocalID is the client id.
	r = TestConnection(context.Background(), pinned(s), Identity{}, Options{LocalID: standin.DefaultInstanceID, Timing: Timing{TestStep: testLimit}})
	if r.Outcome != OutcomeIsLocal {
		t.Errorf("with Options.LocalID alone: %s; want %s", r.Outcome, OutcomeIsLocal)
	}
	if got := s.Requests(); got[len(got)-1].Client != standin.DefaultInstanceID {
		t.Errorf("client header %q", got[len(got)-1].Client)
	}
}

// TestHTTP1Connects: a server without HTTP/2 that closes after every answer is tested too. The
// state then needs a second connection, made under the same pin.
func TestHTTP1Connects(t *testing.T) {
	t.Parallel()
	pair := issuedPair(t)
	var handshakes atomic.Int32
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Connection", "close")
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Path == HelloPath {
				_, _ = io.WriteString(w, `{"app":"ai-whiteboard","version":"v","instanceId":"`+standin.DefaultInstanceID+`","featureLevel":2}`)
				return
			}
			_ = json.NewEncoder(w).Encode(standin.DefaultSnapshot())
		}),
		TLSConfig: &tls.Config{
			NextProtos: []string{"http/1.1"},
			GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
				handshakes.Add(1)
				return &pair, nil
			},
		},
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){}, // no HTTP/2
		ErrorLog:     log.New(io.Discard, "", 0),
	}
	go func() { _ = srv.ServeTLS(ln, "", "") }()
	t.Cleanup(func() { _ = srv.Close() })

	target := Target{Address: "https://" + ln.Addr().String(), Secret: "s", SelfSigned: true, Pin: remote.Fingerprint(pair.Certificate[0])}
	r := run(target, Identity{}, testOptions())
	if r.Outcome != OutcomeConnected || r.FeatureLevel != 2 || len(r.Agents) != 2 {
		t.Fatalf("result %+v; want connected at level 2", r)
	}
	if n := handshakes.Load(); n != 2 {
		t.Errorf("%d handshakes; want 2", n)
	}
}

// TestExpiredPinnedConnects: under a pin, dates and names are not checked.
func TestExpiredPinnedConnects(t *testing.T) {
	t.Parallel()
	s := standin.Start(t, standin.Options{
		Names: []string{"elsewhere.example"}, Hosts: []string{"127.0.0.1"},
		NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: time.Now().Add(-time.Hour),
	})
	if r := run(pinned(s), Identity{}, testOptions()); !r.OK || r.Outcome != OutcomeConnected {
		t.Fatalf("result %+v; want connected", r)
	}
}

// TestSelfSignedBoxOff: without the box a self-signed certificate is refused against the
// system's roots, with or without a pin left in the form, and gets no request.
func TestSelfSignedBoxOff(t *testing.T) {
	t.Parallel()
	s := standin.Start(t, standin.Options{})
	for _, target := range []Target{
		{Address: s.URL(), Secret: standin.DefaultSecret},
		{Address: s.URL(), Secret: standin.DefaultSecret, Pin: s.Fingerprint()}, // the pin counts with the box alone
	} {
		r := run(target, Identity{}, testOptions())
		if r.OK || r.Outcome != OutcomeSelfSigned || r.Step != 3 || r.Message != "Self-signed certificate: tick the box" {
			t.Fatalf("result %+v; want self_signed at step 3", r)
		}
	}
	if reqs := s.Requests(); len(reqs) != 0 {
		t.Errorf("requests %v; want none", reqs)
	}
}

// TestTooOld: a level below the minimum, or none, ends the test at step 4; the state is not asked.
func TestTooOld(t *testing.T) {
	t.Parallel()
	for name, level := range map[string]*int{"level 0": standin.Level(0), "no level": nil, "level -1": standin.Level(-1)} {
		s := standin.Start(t, standin.Options{})
		s.SetFeatureLevel(level)
		// Identity plays no part: the level is checked first.
		r := run(pinned(s), Identity{Expect: standin.DefaultInstanceID}, testOptions())
		if r.OK || r.Outcome != OutcomeTooOld || r.Step != 4 || r.Message != "Server too old: update it on that machine" {
			t.Errorf("%s: result %+v; want too_old at step 4", name, r)
		}
		if r.Agents != nil || r.Version != standin.DefaultVersion {
			t.Errorf("%s: agents %v, version %q; want no agents and the version", name, r.Agents, r.Version)
		}
		if reqs := s.Requests(); len(reqs) != 1 || reqs[0].Path != HelloPath {
			t.Errorf("%s: requests %v; want hello alone", name, reqs)
		}
	}
	s := standin.Start(t, standin.Options{})
	s.SetHello(answer(200, "application/json", `{"app":"ai-whiteboard","version":"v","instanceId":"`+standin.DefaultInstanceID+`","featureLevel":"1"}`))
	if r := run(pinned(s), Identity{}, testOptions()); r.Outcome != OutcomeTooOld {
		t.Errorf("a level that is no integer: %s; want too_old", r.Outcome)
	}
	s = standin.Start(t, standin.Options{FeatureLevel: standin.Level(7)})
	if r := run(pinned(s), Identity{}, testOptions()); !r.OK || r.FeatureLevel != 7 {
		t.Errorf("a higher level: %+v; want connected", r)
	}
}

// TestIdentityOutcomes: the id decides "this is the local server", "already added as …" and
// "another server answers at this address", in that order, and none asks for the state.
func TestIdentityOutcomes(t *testing.T) {
	t.Parallel()
	s := standin.Start(t, standin.Options{})
	id := standin.DefaultInstanceID
	cases := []struct {
		name    string
		id      Identity
		want    Outcome
		message string
	}{
		{"local", Identity{LocalID: id}, OutcomeIsLocal, "This is the local server"},
		{"local before duplicate", Identity{LocalID: id, Others: map[string]string{id: "Studio"}, Expect: testOtherID}, OutcomeIsLocal, "This is the local server"},
		{"duplicate", Identity{Others: map[string]string{id: "Studio", testOtherID: "Attic"}}, OutcomeDuplicate, "Already added as Studio"},
		{"duplicate before another server", Identity{Others: map[string]string{id: "Studio"}, Expect: testOtherID}, OutcomeDuplicate, "Already added as Studio"},
		{"another server", Identity{Others: map[string]string{testOtherID: "Attic"}, Expect: testOtherID}, OutcomeAnotherServer, "Another server answers at this address"},
		{"the expected server", Identity{Others: map[string]string{testOtherID: "Attic"}, Expect: id}, OutcomeConnected, "Connected"},
		{"a new server", Identity{Others: map[string]string{testOtherID: "Attic"}}, OutcomeConnected, "Connected"},
	}
	for _, c := range cases {
		before := len(s.Requests())
		r := run(pinned(s), c.id, testOptions())
		if r.Outcome != c.want || r.Message != c.message || r.OK != (c.want == OutcomeConnected) {
			t.Errorf("%s: got %s, %q; want %s, %q", c.name, r.Outcome, r.Message, c.want, c.message)
			continue
		}
		if r.InstanceID != id {
			t.Errorf("%s: instance id %q", c.name, r.InstanceID)
		}
		wantRequests, wantStep := 1, 4
		if c.want == OutcomeConnected {
			wantRequests, wantStep = 2, 5
		}
		if n := len(s.Requests()) - before; n != wantRequests || r.Step != wantStep {
			t.Errorf("%s: %d requests, step %d; want %d, %d", c.name, n, r.Step, wantRequests, wantStep)
		}
	}
}

// TestStepLimit: a step ends at Timing.TestStep.
func TestStepLimit(t *testing.T) {
	t.Parallel()
	const slack = 2 * time.Second // for a loaded machine; without the limit a step takes DefaultTiming's 5 s
	o := testOptions()
	o.Timing.TestStep = 300 * time.Millisecond
	start := time.Now()
	r := run(Target{Address: standin.Silent(t), Secret: "s"}, Identity{}, o)
	took := time.Since(start)
	if r.Outcome != OutcomeTLSTimeout || r.Step != 3 {
		t.Fatalf("result %+v; want tls_timeout at step 3", r)
	}
	if took < 300*time.Millisecond || took > 300*time.Millisecond+slack {
		t.Errorf("took %v; want 300 ms and up to %v more", took, slack)
	}

	// Each step has the limit for itself: hello after 200 ms and a state that never answers end
	// after the state's own 300 ms.
	s := standin.Start(t, standin.Options{})
	s.SetHello(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		answer(200, "application/json", `{"app":"ai-whiteboard","version":"v","instanceId":"`+standin.DefaultInstanceID+`","featureLevel":1}`)(w, r)
	})
	s.Handle("GET "+StatePath, hang)
	start = time.Now()
	r = run(pinned(s), Identity{}, o)
	took = time.Since(start)
	if r.Outcome != OutcomeNoAnswer || r.Step != 5 || r.Version != "v" {
		t.Fatalf("result %+v; want no_answer at step 5", r)
	}
	if took < 500*time.Millisecond || took > 500*time.Millisecond+slack {
		t.Errorf("took %v; want 500 ms and up to %v more", took, slack)
	}

	if !reflect.DeepEqual((Timing{}).withDefaults(), DefaultTiming) || DefaultTiming.TestStep != 5*time.Second {
		t.Errorf("a zero Timing gives %+v", (Timing{}).withDefaults())
	}
}

// TestCallerCancelEndsTheTest: the caller's context ends a step before its limit.
func TestCallerCancelEndsTheTest(t *testing.T) {
	t.Parallel()
	s := standin.Start(t, standin.Options{})
	s.SetHello(hang)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	r := TestConnection(ctx, pinned(s), Identity{LocalID: testLocalID}, testOptions())
	if r.Outcome != OutcomeNoAnswer || r.Step != 4 || time.Since(start) > time.Second {
		t.Errorf("result %+v after %v; want no_answer at step 4 soon", r, time.Since(start))
	}
}

// TestTextFromTheServerIsCleaned: Detail, Version and Agents lose control characters and are cut.
func TestTextFromTheServerIsCleaned(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("é", 400)
	s := standin.Start(t, standin.Options{})
	hello, _ := json.Marshal(map[string]any{
		"app": "ai-whiteboard", "version": "1.2\x1b[31m\n\t3\u0000" + long, "instanceId": standin.DefaultInstanceID, "featureLevel": 1,
	})
	s.SetHello(answer(200, "application/json", string(hello)))
	s.SetSnapshot(map[string]any{
		"agents": []string{"cla\u0007ude", "\n", long + "x"}, "catalogs": map[string]any{}, "home": "/h", "defaultCwd": "/h", "chats": []any{},
	})
	r := run(pinned(s), Identity{}, testOptions())
	if !r.OK {
		t.Fatalf("result %+v; want connected", r)
	}
	if want := ("1.2[31m3" + long)[:len("1.2[31m3")+2*(300-len("1.2[31m3"))]; r.Version != want {
		t.Errorf("version %q\nwant %q", r.Version, want)
	}
	if len(r.Agents) != 2 || r.Agents[0] != "claude" || string(r.Agents[1]) != strings.Repeat("é", 300) {
		t.Errorf("agents %q", r.Agents)
	}

	s.SetHello(answer(502, "application/json", `{"error":"bad\u0000 gate\nway `+long+`"}`))
	r = run(pinned(s), Identity{}, testOptions())
	if r.Outcome != OutcomeNotAIWB || !strings.HasPrefix(r.Detail, "HTTP 502: bad gateway ééé") || len([]rune(r.Detail)) > 310 {
		t.Errorf("outcome %s, detail %q", r.Outcome, r.Detail)
	}
	if got := clean("a\x00b\r\nc\u0085d\xff� " + strings.Repeat("x", 400)); got != "abcd "+strings.Repeat("x", 295) {
		t.Errorf("clean = %q", got)
	}
}

// TestNameNotFoundReal does the one real look-up of the suite, of a name under ".invalid". It is
// in the full set alone, and skipped when the resolver here does not answer "no such host"
// within 2 s.
func TestNameNotFoundReal(t *testing.T) {
	t.Parallel()
	testset.SkipUnlessFull(t, "a real DNS look-up, which needs the network's resolver; TestTestConnectionRows and TestDialClassifies (the case of each named for it) cover the outcome with the resolver's error given by the dial")
	const name = "aiwb-no-such-host.invalid"
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := net.DefaultResolver.LookupHost(ctx, name)
	var dns *net.DNSError
	if err == nil || !errors.As(err, &dns) || !dns.IsNotFound {
		t.Skipf("the look-up of %s answered %v, not \"no such host\"", name, err)
	}
	r := run(Target{Address: "https://" + name + ":1", Secret: "s"}, Identity{}, testOptions())
	if r.Outcome != OutcomeNameNotFound || r.Step != 2 || r.Message != "Name not found" {
		t.Errorf("result %+v; want name_not_found at step 2", r)
	}
}
