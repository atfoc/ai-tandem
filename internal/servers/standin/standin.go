// Package standin is a stand-in for a remote AI Whiteboard server, for tests: a TLS listener on
// loopback that answers the hello, the state and the event stream a remote server answers, behind
// the secret and Host checks. It is not a _test package, so the tests of other packages import it.
// It must not import internal/servers: that package's tests import this one.
package standin

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
)

// The defaults of Options, exported so a test can connect without setting them.
const (
	DefaultSecret     = "5a17c0de5a17c0de5a17c0de5a17c0de5a17c0de5a17c0de5a17c0de5a17c0de"
	DefaultInstanceID = "5d0c3a1e-7b42-4f6a-9c1d-2e8f0a6b4c37"
	DefaultVersion    = "standin"
	DefaultPingEvery  = 50 * time.Millisecond
)

const (
	helloPath  = "/api/hello"
	statePath  = "/api/state"
	streamPath = "/api/events"
)

// Options configures Start. The zero value gives a server that a client with DefaultSecret and
// the pin Fingerprint() connects to.
type Options struct {
	Names               []string  // the certificate's names; default {"127.0.0.1"}
	NotBefore, NotAfter time.Time // default now-1h, now+1h

	Secret, InstanceID, Version string // defaults: DefaultSecret, DefaultInstanceID, DefaultVersion

	// FeatureLevel is hello's "featureLevel". nil here means the default, 1; to leave the field
	// out of hello, call SetFeatureLevel(nil) after Start.
	FeatureLevel *int

	// Hosts are the accepted Host values, each "host:port" or a host for any port. Default: the
	// listener's own address and every name of the certificate with the listener's port.
	Hosts []string

	Snapshot any // answers GET /api/state and the stream's second event; default DefaultSnapshot()

	PingEvery time.Duration // the stream's ": ping" interval; default DefaultPingEvery
}

// Request is one request the server received, refused ones too.
type Request struct {
	Method, Path, Secret, Client string
}

// Server is a running stand-in. All methods are safe for concurrent use.
type Server struct {
	t     testing.TB
	addr  string // "127.0.0.1:<port>", kept over Stop and Restart
	port  string
	html  bool // NotAIWB: 200 text/html on every path, no checks
	mux   *http.ServeMux
	every time.Duration

	mu         sync.Mutex
	srv        *http.Server
	done       chan struct{} // closed when srv's Serve returned
	cert       *tls.Certificate
	names      []string
	secret     string
	instanceID string
	version    string
	level      *int
	hosts      []string
	snapshot   any
	hello      http.HandlerFunc
	pings      bool
	streams    map[*stream]struct{}
	requests   []Request
	handshakes int
}

// stream is one open event stream: a queue of marshalled events and its wake-up.
type stream struct {
	queue [][]byte
	wake  chan struct{} // capacity 1
	done  chan struct{} // closed by DropStreams and Stop
}

// Level returns a pointer to n, for Options.FeatureLevel and SetFeatureLevel.
func Level(n int) *int { return &n }

// DefaultSnapshot is the minimal API snapshot of a remote server: every part a client requires,
// and empty lists of chats, states and runs.
func DefaultSnapshot() map[string]any {
	return map[string]any{
		"agents": []model.AgentKind{model.Claude, model.Pi},
		"catalogs": map[model.AgentKind]*model.Catalog{
			model.Claude: {
				Models:  []model.CatalogModel{{ID: "standin-model", Label: "Stand-in model"}},
				Default: model.ModelChoice{Model: "standin-model"},
			},
			model.Pi: nil,
		},
		"home":       "/home/standin",
		"defaultCwd": "/home/standin/work",
		"chats":      []any{},
		"states":     []any{},
		"runs":       []any{},
	}
}

// Start runs a stand-in on 127.0.0.1:0 with TLS and HTTP/2. t.Cleanup stops it.
func Start(t testing.TB, o Options) *Server {
	t.Helper()
	return start(t, o, false)
}

// NotAIWB runs a TLS server that is not AI Whiteboard: it answers 200 text/html on every path
// and checks neither secret nor Host. Requests are still recorded.
func NotAIWB(t testing.TB) *Server {
	t.Helper()
	return start(t, Options{}, true)
}

func start(t testing.TB, o Options, html bool) *Server {
	t.Helper()
	if len(o.Names) == 0 {
		o.Names = []string{"127.0.0.1"}
	}
	if o.NotBefore.IsZero() {
		o.NotBefore = time.Now().Add(-time.Hour)
	}
	if o.NotAfter.IsZero() {
		o.NotAfter = time.Now().Add(time.Hour)
	}
	if o.Secret == "" {
		o.Secret = DefaultSecret
	}
	if o.InstanceID == "" {
		o.InstanceID = DefaultInstanceID
	}
	if o.Version == "" {
		o.Version = DefaultVersion
	}
	if o.FeatureLevel == nil {
		o.FeatureLevel = Level(1)
	}
	if o.Snapshot == nil {
		o.Snapshot = DefaultSnapshot()
	}
	if o.PingEvery <= 0 {
		o.PingEvery = DefaultPingEvery
	}
	s := &Server{
		t: t, html: html, mux: http.NewServeMux(), every: o.PingEvery,
		secret: o.Secret, instanceID: o.InstanceID, version: o.Version, level: o.FeatureLevel,
		hosts: append([]string(nil), o.Hosts...), snapshot: o.Snapshot,
		pings: true, streams: map[*stream]struct{}{},
	}
	s.SwapCert(o.Names, o.NotBefore, o.NotAfter)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("standin: listen: %v", err)
	}
	s.addr = ln.Addr().String()
	_, s.port, _ = net.SplitHostPort(s.addr)
	s.serve(ln)
	t.Cleanup(s.Stop)
	return s
}

// serve starts a new http.Server on ln. The certificate is chosen at every handshake, so
// SwapCert needs no restart; session tickets are off, so every connection shows it.
func (s *Server) serve(ln net.Listener) {
	srv := &http.Server{
		Handler: http.HandlerFunc(s.handle),
		TLSConfig: &tls.Config{
			MinVersion:             tls.VersionTLS12,
			SessionTicketsDisabled: true,
			GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
				s.mu.Lock()
				defer s.mu.Unlock()
				s.handshakes++
				return s.cert, nil
			},
		},
		ErrorLog: log.New(io.Discard, "", 0), // refused handshakes are what the tests are about
	}
	done := make(chan struct{})
	s.mu.Lock()
	s.srv, s.done = srv, done
	s.mu.Unlock()
	go func() {
		defer close(done)
		_ = srv.ServeTLS(ln, "", "") // http2 is set up by ServeTLS
	}()
}

// URL is "https://127.0.0.1:<port>". It stays the same over Stop, Restart and SwapCert.
func (s *Server) URL() string { return "https://" + s.addr }

// Fingerprint is the fingerprint of the certificate served now, in remote.Fingerprint's form.
func (s *Server) Fingerprint() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return remote.Fingerprint(s.cert.Certificate[0])
}

// Pool holds the certificate served now as its own root, for a client that verifies.
func (s *Server) Pool() *x509.CertPool {
	s.mu.Lock()
	defer s.mu.Unlock()
	pool := x509.NewCertPool()
	pool.AddCert(s.cert.Leaf)
	return pool
}

// SetSecret changes the accepted secret. Open streams stay open: call DropStreams for what a
// secret reload does.
func (s *Server) SetSecret(v string) { s.set(func() { s.secret = v }) }

// SetInstanceID changes hello's "instanceId".
func (s *Server) SetInstanceID(v string) { s.set(func() { s.instanceID = v }) }

// SetFeatureLevel changes hello's "featureLevel"; nil leaves the field out.
func (s *Server) SetFeatureLevel(v *int) { s.set(func() { s.level = v }) }

// SetSnapshot changes the answer of GET /api/state and of the stream's second event.
func (s *Server) SetSnapshot(v any) { s.set(func() { s.snapshot = v }) }

// SetHello replaces the answer of GET /api/hello, still behind the secret and Host checks; nil
// brings the built-in answer back.
func (s *Server) SetHello(h http.HandlerFunc) { s.set(func() { s.hello = h }) }

// SetPings turns the streams' ": ping" lines on (the start's state) or off, open streams included.
func (s *Server) SetPings(on bool) { s.set(func() { s.pings = on }) }

func (s *Server) set(f func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f()
}

// Handle adds a route behind the secret and Host checks, with http.ServeMux's patterns. A
// pattern that matches one of the built-in paths replaces it.
func (s *Server) Handle(pattern string, h http.HandlerFunc) { s.mux.HandleFunc(pattern, h) }

// Send writes ev as one event to every open stream, after that stream's snapshot and in the
// order of the calls. A stream that opens later does not get it.
func (s *Server) Send(ev any) {
	msg, err := json.Marshal(ev)
	if err != nil {
		s.t.Errorf("standin: Send: %v", err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for st := range s.streams {
		st.queue = append(st.queue, msg)
		select {
		case st.wake <- struct{}{}:
		default:
		}
	}
}

// DropStreams ends every open stream; the connections stay. Streams() is 0 when it returns.
func (s *Server) DropStreams() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for st := range s.streams {
		close(st.done)
		delete(s.streams, st)
	}
}

// Stop closes the listener and every connection. The port then refuses. A second Stop does nothing.
func (s *Server) Stop() {
	s.mu.Lock()
	srv, done := s.srv, s.done
	s.srv = nil
	s.mu.Unlock()
	if srv == nil {
		return
	}
	s.DropStreams()
	_ = srv.Close()
	<-done
}

// Restart listens again on the same port with the same pair and settings, after a Stop when the
// server still runs. Requests() and Handshakes() keep counting.
func (s *Server) Restart() {
	s.t.Helper()
	s.Stop()
	var ln net.Listener
	var err error
	for end := time.Now().Add(3 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if ln, err = net.Listen("tcp4", s.addr); err == nil || time.Now().After(end) {
			break
		}
	}
	if err != nil {
		s.t.Fatalf("standin: restart on %s: %v", s.addr, err)
		return
	}
	s.serve(ln)
}

// SwapCert makes a new pair, served on the same port from the next handshake on. Connections
// that are open keep the old one: DropStreams or Stop and Restart end them.
func (s *Server) SwapCert(names []string, notBefore, notAfter time.Time) {
	s.t.Helper()
	certPEM, keyPEM, err := remote.GenerateCert(names, notBefore, notAfter)
	if err != nil {
		s.t.Fatalf("standin: certificate: %v", err)
		return
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		s.t.Fatalf("standin: pair: %v", err)
		return
	}
	if cert.Leaf == nil {
		block, _ := pem.Decode(certPEM)
		if cert.Leaf, err = x509.ParseCertificate(block.Bytes); err != nil {
			s.t.Fatalf("standin: leaf: %v", err)
			return
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cert, s.names = &cert, append([]string(nil), names...)
}

// Requests are the requests received so far, in order, those refused with 400, 401 or 403 too.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}

// Handshakes counts the TLS handshakes begun so far (one per client hello), also those the
// client then refused.
func (s *Server) Handshakes() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.handshakes
}

// Streams is the number of open event streams.
func (s *Server) Streams() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.streams)
}

// ---- serving ----

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.requests = append(s.requests, Request{
		Method: r.Method, Path: r.URL.Path,
		Secret: r.Header.Get(remote.SecretHeader), Client: r.Header.Get(remote.ClientHeader),
	})
	hostOK, secretOK, hello := s.hostOKLocked(r.Host), r.Header.Get(remote.SecretHeader) == s.secret, s.hello
	own := s.instanceID
	s.mu.Unlock()

	if s.html {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<!doctype html><title>Something else</title><p>Not AI Whiteboard.</p>\n")
		return
	}
	// the real listener's order: the secret, the Host, the client id
	if !secretOK {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if !hostOK {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "bad host"})
		return
	}
	client := r.Header.Get(remote.ClientHeader)
	if !remote.ValidID(client) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad client id", "code": "bad_client"})
		return
	}
	if client == own && !(r.Method == http.MethodGet && r.URL.Path == helloPath) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "this is the server's own id", "code": "own_client"})
		return
	}
	if _, pattern := s.mux.Handler(r); pattern != "" {
		s.mux.ServeHTTP(w, r)
		return
	}
	switch r.URL.Path {
	case helloPath, statePath, streamPath:
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
			return
		}
	}
	switch r.URL.Path {
	case helloPath:
		if hello != nil {
			hello(w, r)
			return
		}
		s.serveHello(w)
	case statePath:
		s.mu.Lock()
		snap := s.snapshot
		s.mu.Unlock()
		writeJSON(w, http.StatusOK, snap)
	case streamPath:
		s.serveStream(w, r)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

// hostOKLocked reports whether the request's Host is accepted.
func (s *Server) hostOKLocked(host string) bool {
	accepted := s.hosts
	if len(accepted) == 0 {
		accepted = []string{s.addr}
		for _, n := range s.names {
			accepted = append(accepted, net.JoinHostPort(n, s.port))
		}
	}
	name := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		name = h
	}
	for _, a := range accepted {
		if strings.EqualFold(a, host) || strings.EqualFold(a, name) {
			return true
		}
	}
	return false
}

func (s *Server) serveHello(w http.ResponseWriter) {
	s.mu.Lock()
	hello := map[string]any{
		"app": "ai-whiteboard", "version": s.version, "webVersion": s.version, "instanceId": s.instanceID,
	}
	if s.level != nil {
		hello["featureLevel"] = *s.level
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, hello)
}

// serveStream sends hello, the snapshot with its fields inline, then what Send gives it, with
// ": ping" lines in between, until the client leaves or the stream is dropped.
func (s *Server) serveStream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "no flusher"})
		return
	}
	s.mu.Lock()
	raw, err := json.Marshal(s.snapshot)
	s.mu.Unlock()
	snap := map[string]json.RawMessage{}
	if err == nil {
		_ = json.Unmarshal(raw, &snap) // a non-object snapshot is dropped
	}
	if snap == nil {
		snap = map[string]json.RawMessage{}
	}
	snap["type"] = json.RawMessage(`"snapshot"`)
	first, _ := json.Marshal(map[string]any{"type": "hello", "client": r.URL.Query().Get("client")})
	second, _ := json.Marshal(snap)

	st := &stream{queue: [][]byte{first, second}, wake: make(chan struct{}, 1), done: make(chan struct{})}
	s.mu.Lock()
	s.streams[st] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.streams, st)
		s.mu.Unlock()
	}()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	fl.Flush()

	ping := time.NewTicker(s.every)
	defer ping.Stop()
	for {
		s.mu.Lock()
		queue, pings := st.queue, s.pings
		st.queue = nil
		s.mu.Unlock()
		for _, msg := range queue {
			if _, err := w.Write(append(append([]byte("data: "), msg...), '\n', '\n')); err != nil {
				return
			}
		}
		if len(queue) > 0 {
			fl.Flush()
		}
		select {
		case <-st.wake:
		case <-ping.C:
			if pings {
				if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
					return
				}
				fl.Flush()
			}
		case <-st.done:
			return
		case <-r.Context().Done():
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ---- ports that are not a server ----

// Refused is the address of a loopback port nothing listens on.
func Refused(t testing.TB) string {
	t.Helper()
	ln := listen(t)
	addr := ln.Addr().String()
	_ = ln.Close()
	return "https://" + addr
}

// Silent is the address of a loopback port that accepts connections and never answers. The
// connections are closed by t.Cleanup.
func Silent(t testing.TB) string {
	t.Helper()
	ln := listen(t)
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			_ = c.Close()
		}
	})
	return "https://" + ln.Addr().String()
}

// PlainHTTP is the address of a loopback port that speaks HTTP without TLS, written as an https
// address: what a server's local port looks like to a client.
func PlainHTTP(t testing.TB) string {
	t.Helper()
	ln := listen(t)
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]string{"plain": "http"})
		}),
		ErrorLog: log.New(io.Discard, "", 0),
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return "https://" + ln.Addr().String()
}

func listen(t testing.TB) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("standin: listen: %v", err)
	}
	return ln
}
