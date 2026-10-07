package standin

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/remote"
)

// testClient is the client id the tests send: a lowercase version 4 UUID, as the server asks.
const testClient = "0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d"

// plainClient is a client that skips verification; fp, when set, receives the fingerprint of
// each certificate it was shown.
func plainClient(t *testing.T, fp *string) *http.Client {
	t.Helper()
	tr := &http.Transport{
		ForceAttemptHTTP2: true,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
			VerifyConnection: func(cs tls.ConnectionState) error {
				if fp != nil {
					*fp = remote.Fingerprint(cs.PeerCertificates[0].Raw)
				}
				return nil
			},
		},
	}
	t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: tr, Timeout: 5 * time.Second}
}

func get(t *testing.T, c *http.Client, url, secret string, edit func(*http.Request)) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if secret != "" {
		req.Header.Set(remote.SecretHeader, secret)
	}
	req.Header.Set(remote.ClientHeader, testClient)
	if edit != nil {
		edit(req)
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("GET %s: body: %v", url, err)
	}
	return res, body
}

func object(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("not a JSON object: %v: %q", err, body)
	}
	return m
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); !ok(); time.Sleep(5 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// events reads a stream: lines holds every non-empty line, in order.
type events struct {
	res   *http.Response
	lines chan string
}

func openStream(t *testing.T, c *http.Client, s *Server) *events {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.URL()+"/api/events?client="+testClient, nil)
	req.Header.Set(remote.SecretHeader, DefaultSecret)
	req.Header.Set(remote.ClientHeader, testClient)
	res, err := (&http.Client{Transport: c.Transport}).Do(req) // no time-out: the stream stays open
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	e := &events{res: res, lines: make(chan string, 1024)}
	go func() {
		defer close(e.lines)
		defer res.Body.Close()
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			if sc.Text() != "" {
				e.lines <- sc.Text()
			}
		}
	}()
	return e
}

// next returns the next event, skipping pings; ok is false when the stream ended.
func (e *events) next(t *testing.T) (m map[string]any, ok bool) {
	t.Helper()
	for {
		select {
		case line, open := <-e.lines:
			if !open {
				return nil, false
			}
			if strings.HasPrefix(line, ":") {
				continue
			}
			data, found := strings.CutPrefix(line, "data: ")
			if !found {
				t.Fatalf("stream line is neither data nor comment: %q", line)
			}
			return object(t, []byte(data)), true
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for a stream event")
		}
	}
}

func TestHello(t *testing.T) {
	s := Start(t, Options{})
	c := plainClient(t, nil)
	res, body := get(t, c, s.URL()+"/api/hello", DefaultSecret, nil)
	if res.StatusCode != 200 || res.ProtoMajor != 2 {
		t.Fatalf("status %d over %s, want 200 over HTTP/2", res.StatusCode, res.Proto)
	}
	if ct := res.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("content type %q", ct)
	}
	m := object(t, body)
	want := map[string]any{
		"app": "ai-whiteboard", "version": DefaultVersion, "webVersion": DefaultVersion,
		"instanceId": DefaultInstanceID, "featureLevel": float64(1),
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("hello[%q] = %v, want %v", k, m[k], v)
		}
	}
	if !remote.ValidID(DefaultInstanceID) {
		t.Error("the default instance id is not a valid id")
	}

	s.SetFeatureLevel(nil)
	s.SetInstanceID("11111111-2222-4333-8444-555555555555")
	_, body = get(t, c, s.URL()+"/api/hello", DefaultSecret, nil)
	m = object(t, body)
	if _, has := m["featureLevel"]; has {
		t.Errorf("featureLevel present after SetFeatureLevel(nil): %s", body)
	}
	if m["instanceId"] != "11111111-2222-4333-8444-555555555555" {
		t.Errorf("instanceId = %v", m["instanceId"])
	}
	s.SetFeatureLevel(Level(0))
	_, body = get(t, c, s.URL()+"/api/hello", DefaultSecret, nil)
	if v, has := object(t, body)["featureLevel"]; !has || v != float64(0) {
		t.Errorf("featureLevel = %v, %v; want 0", v, has)
	}

	s.SetHello(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "hi") })
	if _, body = get(t, c, s.URL()+"/api/hello", DefaultSecret, nil); string(body) != "hi" {
		t.Errorf("SetHello: body %q", body)
	}
	if res, _ = get(t, c, s.URL()+"/api/hello", "wrong", nil); res.StatusCode != 401 {
		t.Errorf("SetHello without the secret: %d, want 401", res.StatusCode)
	}
	s.SetHello(nil)
	if _, body = get(t, c, s.URL()+"/api/hello", DefaultSecret, nil); object(t, body)["app"] != "ai-whiteboard" {
		t.Errorf("SetHello(nil): body %q", body)
	}
}

func TestOptions(t *testing.T) {
	s := Start(t, Options{
		Secret: "s3", InstanceID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", Version: "9.9",
		FeatureLevel: Level(7), Snapshot: map[string]any{"home": "/x"},
	})
	c := plainClient(t, nil)
	_, body := get(t, c, s.URL()+"/api/hello", "s3", nil)
	m := object(t, body)
	if m["version"] != "9.9" || m["instanceId"] != "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" || m["featureLevel"] != float64(7) {
		t.Errorf("hello = %s", body)
	}
	_, body = get(t, c, s.URL()+"/api/state", "s3", nil)
	if m = object(t, body); len(m) != 1 || m["home"] != "/x" {
		t.Errorf("state = %s", body)
	}
}

func TestRefusals(t *testing.T) {
	s := Start(t, Options{})
	c := plainClient(t, nil)
	for _, path := range []string{"/api/hello", "/api/state", "/api/events?client=x", "/api/other"} {
		for _, secret := range []string{"", "wrong"} {
			res, body := get(t, c, s.URL()+path, secret, nil)
			if res.StatusCode != 401 || object(t, body)["error"] != "unauthorized" {
				t.Errorf("%s with secret %q: %d %s", path, secret, res.StatusCode, body)
			}
		}
		res, body := get(t, c, s.URL()+path, DefaultSecret, func(r *http.Request) { r.Host = "evil.example" })
		if res.StatusCode != 403 || object(t, body)["error"] != "bad host" {
			t.Errorf("%s with another Host: %d %s", path, res.StatusCode, body)
		}
		// the secret is checked before the Host
		res, body = get(t, c, s.URL()+path, "wrong", func(r *http.Request) { r.Host = "evil.example" })
		if res.StatusCode != 401 || object(t, body)["error"] != "unauthorized" {
			t.Errorf("%s with a wrong secret and another Host: %d %s", path, res.StatusCode, body)
		}
	}
	if res, _ := get(t, c, s.URL()+"/api/other", DefaultSecret, nil); res.StatusCode != 404 {
		t.Errorf("unknown path: %d, want 404", res.StatusCode)
	}

	s.SetSecret("next")
	if res, _ := get(t, c, s.URL()+"/api/hello", DefaultSecret, nil); res.StatusCode != 401 {
		t.Errorf("old secret after SetSecret: %d, want 401", res.StatusCode)
	}
	if res, _ := get(t, c, s.URL()+"/api/hello", "next", nil); res.StatusCode != 200 {
		t.Errorf("new secret after SetSecret: %d, want 200", res.StatusCode)
	}
}

// TestClientID: after the secret and the Host, the client id is checked as the real listener
// checks it: a missing or malformed one is refused on every path, the server's own on every
// path but hello.
func TestClientID(t *testing.T) {
	const own = "11111111-2222-4333-8444-555555555555"
	s := Start(t, Options{InstanceID: own})
	c := plainClient(t, nil)
	with := func(id string) func(*http.Request) {
		return func(r *http.Request) {
			r.Header.Del(remote.ClientHeader)
			if id != "" {
				r.Header.Set(remote.ClientHeader, id)
			}
		}
	}
	paths := []string{"/api/hello", "/api/state", "/api/events", "/api/other"}
	for _, path := range paths {
		for _, id := range []string{"", "client-1", strings.ToUpper(testClient), DefaultInstanceID[:35]} {
			res, body := get(t, c, s.URL()+path, DefaultSecret, with(id))
			m := object(t, body)
			if res.StatusCode != 400 || m["code"] != "bad_client" || m["error"] != "bad client id" || len(m) != 2 {
				t.Errorf("%s with client id %q: %d %s", path, id, res.StatusCode, body)
			}
		}
		// the secret and the Host come first
		if res, _ := get(t, c, s.URL()+path, "wrong", with("")); res.StatusCode != 401 {
			t.Errorf("%s with a wrong secret and no client id: %d, want 401", path, res.StatusCode)
		}
		res, _ := get(t, c, s.URL()+path, DefaultSecret, func(r *http.Request) { with("")(r); r.Host = "evil.example" })
		if res.StatusCode != 403 {
			t.Errorf("%s with another Host and no client id: %d, want 403", path, res.StatusCode)
		}
	}

	res, body := get(t, c, s.URL()+"/api/hello", DefaultSecret, with(own))
	if res.StatusCode != 200 || object(t, body)["instanceId"] != own {
		t.Errorf("hello with the server's own id: %d %s", res.StatusCode, body)
	}
	for _, path := range paths[1:] {
		res, body := get(t, c, s.URL()+path, DefaultSecret, with(own))
		m := object(t, body)
		if res.StatusCode != 400 || m["code"] != "own_client" || m["error"] != "this is the server's own id" || len(m) != 2 {
			t.Errorf("%s with the server's own id: %d %s", path, res.StatusCode, body)
		}
	}
	// only GET of hello is let through
	req, _ := http.NewRequest(http.MethodPost, s.URL()+"/api/hello", nil)
	req.Header.Set(remote.SecretHeader, DefaultSecret)
	req.Header.Set(remote.ClientHeader, own)
	if res, err := c.Do(req); err != nil {
		t.Fatal(err)
	} else if res.Body.Close(); res.StatusCode != 400 {
		t.Errorf("POST hello with the server's own id: %d, want 400", res.StatusCode)
	}
	if s.Streams() != 0 {
		t.Errorf("Streams() = %d: a refused stream was opened", s.Streams())
	}

	// the id follows SetInstanceID
	s.SetInstanceID(testClient)
	if res, _ := get(t, c, s.URL()+"/api/state", DefaultSecret, with(own)); res.StatusCode != 200 {
		t.Errorf("state with the former own id: %d, want 200", res.StatusCode)
	}
	if res, body := get(t, c, s.URL()+"/api/state", DefaultSecret, nil); res.StatusCode != 400 || object(t, body)["code"] != "own_client" {
		t.Errorf("state with the new own id: %d %s", res.StatusCode, body)
	}
}

func TestHosts(t *testing.T) {
	byName := Start(t, Options{Names: []string{"127.0.0.1", "localhost"}})
	listed := Start(t, Options{Hosts: []string{"box.example", "other.example:1"}})
	c := plainClient(t, nil)
	host := func(s *Server, h string) int {
		res, _ := get(t, c, s.URL()+"/api/hello", DefaultSecret, func(r *http.Request) {
			if h != "" {
				r.Host = h
			}
		})
		return res.StatusCode
	}
	_, p, _ := net.SplitHostPort(strings.TrimPrefix(byName.URL(), "https://"))
	for h, want := range map[string]int{"": 200, "localhost:" + p: 200, "LOCALHOST:" + p: 200, "localhost:1": 403, "box.example:" + p: 403} {
		if got := host(byName, h); got != want {
			t.Errorf("names: Host %q: %d, want %d", h, got, want)
		}
	}
	for h, want := range map[string]int{"": 403, "box.example:77": 200, "box.example": 200, "other.example:1": 200, "other.example:2": 403} {
		if got := host(listed, h); got != want {
			t.Errorf("hosts: Host %q: %d, want %d", h, got, want)
		}
	}
}

func TestState(t *testing.T) {
	s := Start(t, Options{})
	c := plainClient(t, nil)
	res, body := get(t, c, s.URL()+"/api/state", DefaultSecret, nil)
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	m := object(t, body)
	if _, has := m["type"]; has {
		t.Error("state has a type")
	}
	if a, _ := m["agents"].([]any); len(a) != 2 || a[0] != "claude" || a[1] != "pi" {
		t.Errorf("agents = %v", m["agents"])
	}
	cat, _ := m["catalogs"].(map[string]any)
	if cat["claude"] == nil {
		t.Errorf("catalogs = %v", m["catalogs"])
	}
	if v, has := cat["pi"]; !has || v != nil {
		t.Errorf("catalogs.pi = %v, %v; want null", v, has)
	}
	if h, _ := m["home"].(string); h == "" {
		t.Error("home is empty")
	}
	if _, ok := m["defaultCwd"].(string); !ok {
		t.Error("defaultCwd is not a string")
	}
	for _, k := range []string{"chats", "states", "runs"} {
		if l, ok := m[k].([]any); !ok || len(l) != 0 {
			t.Errorf("%s = %v, want an empty array", k, m[k])
		}
	}

	s.SetSnapshot(map[string]any{"home": "/elsewhere"})
	_, body = get(t, c, s.URL()+"/api/state", DefaultSecret, nil)
	if object(t, body)["home"] != "/elsewhere" {
		t.Errorf("after SetSnapshot: %s", body)
	}
}

func TestStream(t *testing.T) {
	s := Start(t, Options{PingEvery: 10 * time.Millisecond})
	c := plainClient(t, nil)
	e := openStream(t, c, s)
	if ct := e.res.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("content type %q", ct)
	}
	if m, _ := e.next(t); m["type"] != "hello" {
		t.Fatalf("first event %v, want hello", m)
	}
	m, _ := e.next(t)
	if m["type"] != "snapshot" || m["home"] != "/home/standin" || m["agents"] == nil || m["chats"] == nil {
		t.Fatalf("second event %v, want the snapshot with its fields inline", m)
	}
	waitFor(t, "one stream", func() bool { return s.Streams() == 1 })

	for i := 0; i < 200; i++ {
		s.Send(map[string]any{"type": "n", "i": i})
	}
	for i := 0; i < 200; i++ {
		if m, _ := e.next(t); m["type"] != "n" || m["i"] != float64(i) {
			t.Fatalf("event %d: %v", i, m)
		}
	}

	// pings while they are on, none while they are off
	sawPing := func(d time.Duration) bool {
		for end := time.After(d); ; {
			select {
			case line := <-e.lines:
				if line == ": ping" {
					return true
				}
			case <-end:
				return false
			}
		}
	}
	if !sawPing(5 * time.Second) {
		t.Fatal("no ping while pings are on")
	}
	s.SetPings(false)
	time.Sleep(50 * time.Millisecond)
	for len(e.lines) > 0 {
		<-e.lines
	}
	if sawPing(150 * time.Millisecond) {
		t.Error("a ping while pings are off")
	}
	s.Send(map[string]any{"type": "still-open"})
	if m, ok := e.next(t); !ok || m["type"] != "still-open" {
		t.Errorf("after SetPings(false): %v, %v", m, ok)
	}
	s.SetPings(true)
	if !sawPing(5 * time.Second) {
		t.Error("no ping after SetPings(true)")
	}

	// a second stream gets its own hello and snapshot, and what is sent from then on
	e2 := openStream(t, c, s)
	if m, _ := e2.next(t); m["type"] != "hello" {
		t.Fatalf("second stream: first event %v", m)
	}
	if m, _ := e2.next(t); m["type"] != "snapshot" {
		t.Fatalf("second stream: second event %v", m)
	}
	if s.Streams() != 2 {
		t.Errorf("Streams() = %d, want 2", s.Streams())
	}
	s.Send(map[string]any{"type": "both"})
	for _, x := range []*events{e, e2} {
		if m, _ := x.next(t); m["type"] != "both" {
			t.Errorf("event %v, want both", m)
		}
	}
}

func TestDropStreams(t *testing.T) {
	s := Start(t, Options{})
	c := plainClient(t, nil)
	e := openStream(t, c, s)
	e.next(t)
	e.next(t)
	before := s.Handshakes()
	s.DropStreams()
	if s.Streams() != 0 {
		t.Errorf("Streams() = %d after DropStreams", s.Streams())
	}
	if m, ok := e.next(t); ok {
		t.Fatalf("an event after DropStreams: %v", m)
	}
	// the server still answers, and a new stream opens
	if res, _ := get(t, c, s.URL()+"/api/hello", DefaultSecret, nil); res.StatusCode != 200 {
		t.Errorf("hello after DropStreams: %d", res.StatusCode)
	}
	e = openStream(t, c, s)
	if m, _ := e.next(t); m["type"] != "hello" {
		t.Errorf("new stream: %v", m)
	}
	if s.Handshakes() != before {
		t.Errorf("DropStreams closed the connection: %d handshakes, was %d", s.Handshakes(), before)
	}
}

func TestStreamEndsWhenClientLeaves(t *testing.T) {
	s := Start(t, Options{})
	c := plainClient(t, nil)
	e := openStream(t, c, s)
	e.next(t)
	waitFor(t, "one stream", func() bool { return s.Streams() == 1 })
	e.res.Body.Close()
	waitFor(t, "no stream", func() bool { return s.Streams() == 0 })
}

func TestStopAndRestart(t *testing.T) {
	s := Start(t, Options{})
	c := plainClient(t, nil)
	url, fp := s.URL(), s.Fingerprint()
	e := openStream(t, c, s)
	e.next(t)
	e.next(t)

	s.Stop()
	if m, ok := e.next(t); ok {
		t.Fatalf("an event after Stop: %v", m)
	}
	if s.Streams() != 0 {
		t.Errorf("Streams() = %d after Stop", s.Streams())
	}
	_, err := c.Get(url + "/api/hello")
	if !errors.Is(err, syscall.ECONNREFUSED) {
		t.Fatalf("after Stop: %v, want connection refused", err)
	}
	s.Stop() // a second Stop does nothing

	s.Restart()
	if s.URL() != url || s.Fingerprint() != fp {
		t.Errorf("Restart: %s %s, want %s %s", s.URL(), s.Fingerprint(), url, fp)
	}
	var seen string
	c2 := plainClient(t, &seen)
	if res, _ := get(t, c2, url+"/api/hello", DefaultSecret, nil); res.StatusCode != 200 {
		t.Errorf("after Restart: %d", res.StatusCode)
	}
	if seen != fp {
		t.Errorf("certificate after Restart %s, want %s", seen, fp)
	}
	s.Restart() // of a running server: the same again
	if res, _ := get(t, plainClient(t, nil), url+"/api/hello", DefaultSecret, nil); res.StatusCode != 200 {
		t.Errorf("after a second Restart: %d", res.StatusCode)
	}
}

func TestSwapCert(t *testing.T) {
	s := Start(t, Options{})
	url, old := s.URL(), s.Fingerprint()
	if _, err := remote.ParseFingerprint(old); err != nil {
		t.Fatalf("Fingerprint() = %q: %v", old, err)
	}
	var seen string
	get(t, plainClient(t, &seen), url+"/api/hello", DefaultSecret, nil)
	if seen != old {
		t.Fatalf("served %s, Fingerprint() %s", seen, old)
	}

	s.SwapCert([]string{"other.example"}, time.Now().Add(-48*time.Hour), time.Now().Add(-24*time.Hour))
	if s.URL() != url {
		t.Errorf("URL changed to %s", s.URL())
	}
	if s.Fingerprint() == old {
		t.Fatal("Fingerprint() did not change")
	}
	res, _ := get(t, plainClient(t, &seen), url+"/api/hello", DefaultSecret, nil)
	if seen != s.Fingerprint() {
		t.Errorf("served %s, Fingerprint() %s", seen, s.Fingerprint())
	}
	if res.StatusCode != 200 {
		t.Errorf("hello by the address after a swap to another name: %d", res.StatusCode)
	}
	leaf := res.TLS.PeerCertificates[0]
	if len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != "other.example" || !leaf.NotAfter.Before(time.Now()) {
		t.Errorf("leaf: names %v, not after %v", leaf.DNSNames, leaf.NotAfter)
	}
}

// TestPool: a client that verifies against Pool() accepts the pair, and refuses another name
// and an expired one with Go's own error types.
func TestPool(t *testing.T) {
	verifying := func(s *Server) *http.Client {
		tr := &http.Transport{ForceAttemptHTTP2: true, TLSClientConfig: &tls.Config{RootCAs: s.Pool()}}
		t.Cleanup(tr.CloseIdleConnections)
		return &http.Client{Transport: tr, Timeout: 5 * time.Second}
	}
	s := Start(t, Options{})
	if res, _ := get(t, verifying(s), s.URL()+"/api/hello", DefaultSecret, nil); res.StatusCode != 200 {
		t.Errorf("good pair: %d", res.StatusCode)
	}

	s.SwapCert([]string{"other.example"}, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	_, err := verifying(s).Get(s.URL() + "/api/hello")
	var nameErr x509.HostnameError
	if !errors.As(err, &nameErr) {
		t.Errorf("another name: %v, want x509.HostnameError", err)
	}

	s.SwapCert([]string{"127.0.0.1"}, time.Now().Add(-48*time.Hour), time.Now().Add(-24*time.Hour))
	_, err = verifying(s).Get(s.URL() + "/api/hello")
	var invalid x509.CertificateInvalidError
	if !errors.As(err, &invalid) || invalid.Reason != x509.Expired {
		t.Errorf("expired: %v, want x509.CertificateInvalidError with Expired", err)
	}
	if n := len(s.Requests()); n != 1 {
		t.Errorf("%d requests, want 1: a refused certificate sends none", n)
	}
}

func TestRequestsAndHandshakes(t *testing.T) {
	s := Start(t, Options{})
	if len(s.Requests()) != 0 || s.Handshakes() != 0 || s.Streams() != 0 {
		t.Fatalf("a new server: %v, %d, %d", s.Requests(), s.Handshakes(), s.Streams())
	}

	// a handshake that reads the certificate and sends nothing
	conn, err := tls.Dial("tcp4", strings.TrimPrefix(s.URL(), "https://"), &tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := remote.Fingerprint(conn.ConnectionState().PeerCertificates[0].Raw); got != s.Fingerprint() {
		t.Errorf("read %s, Fingerprint() %s", got, s.Fingerprint())
	}
	conn.Close()
	if s.Handshakes() != 1 || len(s.Requests()) != 0 {
		t.Errorf("after a bare handshake: %d handshakes, %d requests", s.Handshakes(), len(s.Requests()))
	}

	// a handshake the client refuses counts, and sends no request
	refusing := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true,
		VerifyConnection:   func(tls.ConnectionState) error { return errors.New("not the pin") },
	}}}
	if _, err := refusing.Get(s.URL() + "/api/hello"); err == nil {
		t.Fatal("the refusing client got an answer")
	}
	if s.Handshakes() != 2 || len(s.Requests()) != 0 {
		t.Errorf("after a refused handshake: %d handshakes, %d requests", s.Handshakes(), len(s.Requests()))
	}

	c := plainClient(t, nil)
	get(t, c, s.URL()+"/api/hello", DefaultSecret, nil)
	get(t, c, s.URL()+"/api/state?x=1", "wrong", nil)
	req, _ := http.NewRequest(http.MethodPost, s.URL()+"/api/things", strings.NewReader("{}"))
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	want := []Request{
		{"GET", "/api/hello", DefaultSecret, testClient},
		{"GET", "/api/state", "wrong", testClient},
		{"POST", "/api/things", "", ""},
	}
	got := s.Requests()
	if len(got) != len(want) {
		t.Fatalf("Requests() = %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("request %d = %v, want %v", i, got[i], want[i])
		}
	}
	if s.Handshakes() != 3 {
		t.Errorf("%d handshakes, want 3: one connection carried the three requests", s.Handshakes())
	}
	s.Restart()
	get(t, plainClient(t, nil), s.URL()+"/api/hello", DefaultSecret, nil)
	if s.Handshakes() != 4 || len(s.Requests()) != 4 {
		t.Errorf("after Restart: %d handshakes, %d requests; the counts go on", s.Handshakes(), len(s.Requests()))
	}
}

func TestHandle(t *testing.T) {
	s := Start(t, Options{})
	c := plainClient(t, nil)
	s.Handle("POST /api/chats/{id}/send", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_, _ = io.WriteString(w, r.PathValue("id")+":"+string(body))
	})
	post := func(secret, client, host string) (int, string) {
		req, _ := http.NewRequest(http.MethodPost, s.URL()+"/api/chats/c7/send", strings.NewReader("hi"))
		req.Header.Set(remote.SecretHeader, secret)
		if client != "" {
			req.Header.Set(remote.ClientHeader, client)
		}
		if host != "" {
			req.Host = host
		}
		res, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(body)
	}
	if code, body := post(DefaultSecret, testClient, ""); code != 200 || body != "c7:hi" {
		t.Errorf("handled route: %d %q", code, body)
	}
	if code, _ := post("wrong", testClient, ""); code != 401 {
		t.Errorf("handled route without the secret: %d, want 401", code)
	}
	// a handled route gets the same checks, in the same order, as a built-in one
	if code, _ := post("wrong", testClient, "evil.example"); code != 401 {
		t.Errorf("handled route with a wrong secret and another Host: %d, want 401", code)
	}
	if code, body := post(DefaultSecret, testClient, "evil.example"); code != 403 || object(t, []byte(body))["error"] != "bad host" {
		t.Errorf("handled route with another Host: %d %s", code, body)
	}
	for _, id := range []string{"", "client-1"} {
		code, body := post(DefaultSecret, id, "")
		if m := object(t, []byte(body)); code != 400 || m["code"] != "bad_client" || m["error"] != "bad client id" {
			t.Errorf("handled route with client id %q: %d %s", id, code, body)
		}
	}
	code, body := post(DefaultSecret, DefaultInstanceID, "")
	if m := object(t, []byte(body)); code != 400 || m["code"] != "own_client" || m["error"] != "this is the server's own id" {
		t.Errorf("handled route with the server's own id: %d %s", code, body)
	}
	// a pattern for a built-in path replaces it
	s.Handle("GET /api/state", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "broken", 500) })
	if res, _ := get(t, c, s.URL()+"/api/state", DefaultSecret, nil); res.StatusCode != 500 {
		t.Errorf("replaced state: %d, want 500", res.StatusCode)
	}
	if res, _ := get(t, c, s.URL()+"/api/hello", DefaultSecret, nil); res.StatusCode != 200 {
		t.Errorf("hello beside handled routes: %d", res.StatusCode)
	}
}

func TestRefused(t *testing.T) {
	url := Refused(t)
	if !strings.HasPrefix(url, "https://127.0.0.1:") {
		t.Fatalf("url %q", url)
	}
	_, err := plainClient(t, nil).Get(url + "/api/hello")
	if !errors.Is(err, syscall.ECONNREFUSED) {
		t.Errorf("%v, want connection refused", err)
	}
}

func TestSilent(t *testing.T) {
	url := Silent(t)
	if !strings.HasPrefix(url, "https://127.0.0.1:") {
		t.Fatalf("url %q", url)
	}
	addr := strings.TrimPrefix(url, "https://")
	conn, err := net.DialTimeout("tcp4", addr, 2*time.Second)
	if err != nil {
		t.Fatalf("the port does not accept: %v", err)
	}
	conn.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url+"/api/hello", nil)
	began := time.Now()
	_, err = (&http.Client{Transport: plainClient(t, nil).Transport}).Do(req)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("%v, want the deadline", err)
	}
	if d := time.Since(began); d < 250*time.Millisecond {
		t.Errorf("ended after %v, before the limit", d)
	}
}

func TestPlainHTTP(t *testing.T) {
	url := PlainHTTP(t)
	if !strings.HasPrefix(url, "https://127.0.0.1:") {
		t.Fatalf("url %q", url)
	}
	// a TLS dial of one's own: http.Transport's built-in one hides the type behind its own text
	_, err := tls.Dial("tcp4", strings.TrimPrefix(url, "https://"), &tls.Config{InsecureSkipVerify: true})
	var record tls.RecordHeaderError
	if !errors.As(err, &record) {
		t.Errorf("%v, want tls.RecordHeaderError", err)
	}
	res, err := http.Get("http://" + strings.TrimPrefix(url, "https://") + "/")
	if err != nil {
		t.Fatalf("plain http: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Errorf("plain http: %d", res.StatusCode)
	}
}

func TestNotAIWB(t *testing.T) {
	s := NotAIWB(t)
	c := plainClient(t, nil)
	for _, path := range []string{"/", "/api/hello", "/api/state", "/anything/else"} {
		res, body := get(t, c, s.URL()+path, "", nil)
		if res.StatusCode != 200 || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") {
			t.Errorf("%s: %d %q", path, res.StatusCode, res.Header.Get("Content-Type"))
		}
		if json.Valid(body) {
			t.Errorf("%s: the body is JSON: %q", path, body)
		}
	}
	if len(s.Requests()) != 4 || s.Fingerprint() == "" {
		t.Errorf("requests %d, fingerprint %q", len(s.Requests()), s.Fingerprint())
	}
}
