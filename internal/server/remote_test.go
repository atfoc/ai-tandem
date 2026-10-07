package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
)

const (
	testSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	testHost   = "mac.local:4748"
	// testAPIClient is the client id the tests' API client states: another server's instance id.
	testAPIClient = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
)

// withRemote gives the server a remote listener on port 4748 with two names.
func withRemote(s *Server) {
	s.Remote = NewRemote(4748, []string{"mac.local", "192.168.1.20"}, "AB:CD", testSecret)
}

// remoteDo sends one request to h as the remote listener would get it from the API client
// testAPIClient; secret "" sends no secret header.
func remoteDo(h http.Handler, method, path, host, secret string) *httptest.ResponseRecorder {
	return remoteDoAs(h, testAPIClient, method, path, host, secret, "")
}

// remoteDoAs is remoteDo for the API client with this id ("" sends no client header) and with a
// body.
func remoteDoAs(h http.Handler, client, method, path, host, secret, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Host = host
	if secret != "" {
		req.Header.Set(SecretHeader, secret)
	}
	if client != "" {
		req.Header.Set(ClientHeader, client)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func wantReply(t *testing.T, w *httptest.ResponseRecorder, what string, status int, errText string) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("%s: status %d, want %d (%s)", what, w.Code, status, w.Body)
	}
	if errText != "" && strings.TrimSpace(w.Body.String()) != `{"error":"`+errText+`"}` {
		t.Fatalf("%s: body %q, want the error %q", what, w.Body, errText)
	}
}

func TestRemoteSecretAndHost(t *testing.T) {
	e := newEnv(t, withRemote)
	h := e.s.RemoteHandler()
	loopback := strings.TrimPrefix(e.url, "http://")

	wrong := strings.Replace(testSecret, "0", "f", 1)
	for _, secret := range []string{"", wrong, testSecret[:63], testSecret + "0"} {
		for _, rq := range [][2]string{{"GET", "/api/hello"}, {"GET", "/api/state"}, {"GET", "/"},
			{"GET", "/api/events"}, {"POST", "/api/boards"}, {"OPTIONS", "/api/hello"}} {
			for _, host := range []string{testHost, "evil.example:4748", loopback} {
				what := fmt.Sprintf("%s %s host %s secret %q", rq[0], rq[1], host, secret)
				wantReply(t, remoteDo(h, rq[0], rq[1], host, secret), what, 401, "unauthorized")
			}
		}
	}

	for _, host := range []string{testHost, "192.168.1.20:4748", "MAC.local:4748"} {
		w := remoteDo(h, "GET", "/api/hello", host, testSecret)
		wantReply(t, w, "hello with host "+host, 200, "")
		if got := decode[map[string]any](t, w.Body.String())["app"]; got != "ai-whiteboard" {
			t.Fatalf("hello with host %s: app %v", host, got)
		}
	}
	for _, host := range []string{"evil.example:4748", loopback, "localhost:4748", "127.0.0.1:4748", "mac.local",
		"mac.local:4749", "mac.local:443", "", "192.168.1.21:4748"} {
		wantReply(t, remoteDo(h, "GET", "/api/hello", host, testSecret), "hello with host "+host, 403, "bad host")
		// The Host is checked before the table: a route that is not served says 403 too.
		wantReply(t, remoteDo(h, "GET", "/api/state", host, testSecret), "state with host "+host, 403, "bad host")
	}

	// The loopback listener is as before: no secret needed, and the listed names are not its own.
	e.expect(200, "GET", "/api/hello", "")
	req, _ := http.NewRequest("GET", e.url+"/api/hello", nil)
	req.Host = testHost
	req.Header.Set(SecretHeader, testSecret)
	req.Header.Set(ClientHeader, testAPIClient)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("loopback listener with a remote Host: status %d, want 403", resp.StatusCode)
	}

	// The bare name is a Host only on port 443.
	e.s.Remote = NewRemote(443, []string{"mac.local"}, "AB:CD", testSecret)
	h = e.s.RemoteHandler()
	wantReply(t, remoteDo(h, "GET", "/api/hello", "mac.local", testSecret), "bare name on 443", 200, "")
	wantReply(t, remoteDo(h, "GET", "/api/hello", "mac.local:443", testSecret), "name:443", 200, "")
	wantReply(t, remoteDo(h, "GET", "/api/hello", "other.local", testSecret), "other bare name", 403, "bad host")

	// Without a secret, or without a Remote at all, nothing is served.
	e.s.Remote = NewRemote(4748, []string{"mac.local"}, "AB:CD", "")
	wantReply(t, remoteDo(e.s.RemoteHandler(), "GET", "/api/hello", testHost, ""), "empty secret", 401, "unauthorized")
	e.s.Remote = nil
	wantReply(t, remoteDo(e.s.RemoteHandler(), "GET", "/api/hello", testHost, testSecret), "no Remote", 401, "unauthorized")
}

// The secret does not travel on to the route's handler.
func TestRemoteSecretHeaderIsDropped(t *testing.T) {
	e := newEnv(t, withRemote)
	req := httptest.NewRequest("GET", "/api/hello", nil)
	req.Host = testHost
	req.Header.Set(SecretHeader, testSecret)
	req.Header.Set(ClientHeader, testAPIClient)
	w := httptest.NewRecorder()
	e.s.RemoteHandler().ServeHTTP(w, req)
	if w.Code != 200 || req.Header.Get(SecretHeader) != "" {
		t.Fatalf("status %d, secret header %q after the request", w.Code, req.Header.Get(SecretHeader))
	}
}

var pathWildcard = regexp.MustCompile(`\{[^}]*\}`)

func TestRemoteServesOnlyTheTable(t *testing.T) {
	client := t.TempDir()
	for _, f := range []string{"index.html", "app.js"} {
		if err := os.WriteFile(filepath.Join(client, f), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	e := newEnv(t, withRemote, func(s *Server) { s.Client = client })
	h := e.s.RemoteHandler()

	patterns := e.s.routes().patterns
	if len(patterns) < 60 {
		t.Fatalf("%d patterns recorded, want at least 60: %v", len(patterns), patterns)
	}
	for _, p := range RemoteRoutes {
		if !slices.Contains(patterns, p) {
			t.Errorf("table entry %q is not a registered route", p)
		}
	}
	if !slices.Contains(patterns, "/") || !slices.Contains(patterns, "GET /api/remote/status") {
		t.Fatalf("the client files or the status route were not recorded: %v", patterns)
	}

	// Without the secret, and with a wrong one, every route answers 401: one of the table, one
	// outside it and one that is no route alike.
	for _, p := range append(slices.Clone(patterns), "POST /mcp") {
		method, path, ok := strings.Cut(p, " ")
		if !ok {
			method, path = "GET", p
		}
		path = pathWildcard.ReplaceAllString(strings.ReplaceAll(path, "{$}", ""), "x")
		for _, secret := range []string{"", strings.Repeat("0", len(testSecret)), testSecret + "0", testSecret[:len(testSecret)-1]} {
			wantReply(t, remoteDo(h, method, path, testHost, secret), p+" with the secret "+strconv.Quote(secret), 401, "unauthorized")
		}
	}

	served := 0
	for _, p := range append(slices.Clone(patterns), "POST /mcp", "GET /index.html", "GET /app.js") {
		method, path, ok := strings.Cut(p, " ")
		if !ok {
			method, path = "GET", p
		}
		path = pathWildcard.ReplaceAllString(strings.ReplaceAll(path, "{$}", ""), "x")
		// The stream never returns by itself: its request is cancelled before it is made, so the
		// handler writes the stream's first bytes and ends.
		req := httptest.NewRequest(method, path, nil)
		if p == "GET /api/events" {
			ctx, cancel := context.WithCancel(req.Context())
			cancel()
			req = req.WithContext(ctx)
		}
		req.Host = testHost
		req.Header.Set(SecretHeader, testSecret)
		req.Header.Set(ClientHeader, testAPIClient)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		// The gate's answer is told by its body: a route of the table may answer 404 itself, as
		// the read of a chat that is not there does.
		gate := w.Code == 404 && strings.TrimSpace(w.Body.String()) == `{"error":"not found"}`
		if slices.Contains(RemoteRoutes, p) {
			served++
			if gate {
				t.Errorf("%s (%s %s): the gate's 404 for a route of the table", p, method, path)
			}
			continue
		}
		if !gate {
			t.Errorf("%s (%s %s): status %d body %q, want 404 not found", p, method, path, w.Code, w.Body)
		}
	}
	if served != len(RemoteRoutes) || served != 40 {
		t.Errorf("%d routes of the table were asked for, the table has %d, want 40", served, len(RemoteRoutes))
	}
	if n := len(e.s.Bridge.Followers(editorbridge.Chat("x"))); n != 0 {
		t.Errorf("%d followers of the chat the reads named: a read with no open stream follows nothing", n)
	}

	// A listed path with another method is 404 too, not 405.
	for _, method := range []string{"POST", "PUT", "DELETE", "OPTIONS"} {
		wantReply(t, remoteDo(h, method, "/api/hello", testHost, testSecret), method+" /api/hello", 404, "not found")
	}
	// The same requests are served on the loopback listener.
	e.expect(200, "GET", "/index.html", "")
	e.expect(200, "GET", "/api/state", "")
}

func TestHelloInstanceID(t *testing.T) {
	e := newEnv(t)
	out := decode[map[string]any](t, e.expect(200, "GET", "/api/hello", ""))
	if _, ok := out["instanceId"]; ok {
		t.Fatalf("hello of a server without an instance id has one: %v", out)
	}
	if out["app"] != "ai-whiteboard" || out["pid"] != float64(os.Getpid()) || out["webVersion"] != "dev" || out["version"] == nil {
		t.Fatalf("hello: %v", out)
	}

	const id = "3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c"
	e = newEnv(t, func(s *Server) { s.InstanceID = id })
	out = decode[map[string]any](t, e.expect(200, "GET", "/api/hello", ""))
	if out["instanceId"] != id || out["pid"] != float64(os.Getpid()) {
		t.Fatalf("hello: %v", out)
	}
}

func TestRemoteHelloHasNoPid(t *testing.T) {
	const id = "3f2b8c1e-7a4d-4e9b-9c55-0d1e2f3a4b5c"
	e := newEnv(t, withRemote, func(s *Server) { s.InstanceID = id })
	w := remoteDo(e.s.RemoteHandler(), "GET", "/api/hello", testHost, testSecret)
	wantReply(t, w, "remote hello", 200, "")
	out := decode[map[string]any](t, w.Body.String())
	if _, ok := out["pid"]; ok {
		t.Fatalf("remote hello has a pid: %v", out)
	}
	local := decode[map[string]any](t, e.expect(200, "GET", "/api/hello", ""))
	delete(local, "pid")
	if len(out) != 5 || fmt.Sprint(out) != fmt.Sprint(local) || out["instanceId"] != id || out["featureLevel"] != float64(FeatureLevel) {
		t.Fatalf("remote hello %v, want the loopback one without pid %v", out, local)
	}
}

func TestRemoteStatusRoute(t *testing.T) {
	// Off: no Remote.
	e := newEnv(t)
	if out := strings.TrimSpace(e.expect(200, "GET", "/api/remote/status", "")); out != `{"listening":false}` {
		t.Fatalf("status without a remote listener: %s", out)
	}

	// Configured but not serving, then serving.
	e = newEnv(t, withRemote)
	if out := strings.TrimSpace(e.expect(200, "GET", "/api/remote/status", "")); out != `{"listening":false}` {
		t.Fatalf("status before the listener serves: %s", out)
	}
	e.s.Remote.serving.Store(true)
	out := e.expect(200, "GET", "/api/remote/status", "")
	var st struct {
		Listening   bool
		Port        int
		Names       []string
		Fingerprint string
	}
	if err := json.Unmarshal([]byte(out), &st); err != nil {
		t.Fatal(err)
	}
	if !st.Listening || st.Port != 4748 || !slices.Equal(st.Names, []string{"mac.local", "192.168.1.20"}) || st.Fingerprint != "AB:CD" {
		t.Fatalf("status while serving: %s", out)
	}
	if strings.Contains(out, testSecret) {
		t.Fatalf("the status holds the secret: %s", out)
	}

	// Not on the remote listener.
	wantReply(t, remoteDo(e.s.RemoteHandler(), "GET", "/api/remote/status", testHost, testSecret), "remote status", 404, "not found")
}

func TestRefusedLog(t *testing.T) {
	e := newEnv(t, withRemote)
	rm := e.s.Remote
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	var lines []string
	rm.now = func() time.Time { return now }
	rm.logf = func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
	h := e.s.RemoteHandler()
	wrong := strings.Replace(testSecret, "0", "f", 1)

	do := func(addr, method, path, host, secret string) int {
		req := httptest.NewRequest(method, path, nil)
		req.RemoteAddr, req.Host = addr, host
		req.Header.Set(ClientHeader, testAPIClient)
		if secret != "" {
			req.Header.Set(SecretHeader, secret)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w.Code
	}
	want := func(what string, n int, last string) {
		t.Helper()
		if len(lines) != n {
			t.Fatalf("%s: %d log lines, want %d: %q", what, len(lines), n, lines)
		}
		if n > 0 && lines[n-1] != last {
			t.Fatalf("%s: logged %q, want %q", what, lines[n-1], last)
		}
	}

	long := "/" + strings.Repeat("a", 200)
	do("10.0.0.1:5000", "GET", long+"?token="+wrong, testHost, wrong)
	l1 := `remote listener: refused 401 from 10.0.0.1: GET "/` + strings.Repeat("a", 79) + `"`
	want("first refusal", 1, l1)
	// The same address within the minute, from another port, 401 or 403: nothing more.
	do("10.0.0.1:5001", "GET", "/api/hello", testHost, "")
	do("10.0.0.1:5002", "GET", "/api/hello", "evil.example:4748", testSecret)
	now = now.Add(59 * time.Second)
	do("10.0.0.1:5003", "POST", "/api/boards", testHost, wrong)
	want("the same address within a minute", 1, l1)
	// Another address has its own line; a 403 names the Host.
	do("10.0.0.2:5000", "POST", "/api/boards", "Evil.example:4748", testSecret)
	l2 := `remote listener: refused 403 from 10.0.0.2: POST "/api/boards" host="Evil.example:4748"`
	want("another address", 2, l2)
	// Served and 404 requests are not logged.
	if do("10.0.0.3:5000", "GET", "/api/hello", testHost, testSecret) != 200 || do("10.0.0.3:5000", "GET", "/api/mcp/status", testHost, testSecret) != 404 {
		t.Fatal("hello or a route outside the table with the secret: unexpected status")
	}
	want("served requests", 2, l2)
	// After the minute the first address is logged again.
	now = now.Add(time.Second)
	do("10.0.0.1:5004", "GET", "/api/hello", testHost, "")
	want("after a minute", 3, `remote listener: refused 401 from 10.0.0.1: GET "/api/hello"`)

	// A long method is cut, in a 401 and in a 403.
	method := strings.Repeat("M", 1<<20)
	do("10.0.0.4:5000", method, "/api/hello", testHost, wrong)
	want("a long method", 4, `remote listener: refused 401 from 10.0.0.4: `+strings.Repeat("M", 16)+` "/api/hello"`)
	do("10.0.0.5:5000", method, "/api/hello", "evil.example:4748", testSecret)
	want("a long method and a bad host", 5, `remote listener: refused 403 from 10.0.0.5: `+strings.Repeat("M", 16)+` "/api/hello" host="evil.example:4748"`)

	for _, l := range lines {
		if strings.Contains(l, testSecret) || strings.Contains(l, wrong) {
			t.Fatalf("a log line holds a secret: %q", l)
		}
	}

	// A flood of addresses does not grow the log's memory without end.
	for i := 0; i < 3*refusedLogMax; i++ {
		do(fmt.Sprintf("10.1.%d.%d:1", i/250, i%250), "GET", "/", testHost, "")
	}
	if n := len(rm.refused); n > refusedLogMax {
		t.Fatalf("the refused log remembers %d addresses, want at most %d", n, refusedLogMax)
	}
}

func TestRemoteSetSecret(t *testing.T) {
	e := newEnv(t, withRemote)
	h := e.s.RemoteHandler()
	next := strings.Repeat("ab", 32)
	wantReply(t, remoteDo(h, "GET", "/api/hello", testHost, testSecret), "old secret", 200, "")
	wantReply(t, remoteDo(h, "GET", "/api/hello", testHost, next), "new secret before the change", 401, "unauthorized")
	e.s.Remote.SetSecret(next)
	wantReply(t, remoteDo(h, "GET", "/api/hello", testHost, next), "new secret", 200, "")
	wantReply(t, remoteDo(h, "GET", "/api/hello", testHost, testSecret), "old secret after the change", 401, "unauthorized")
	e.s.Remote.SetSecret("")
	wantReply(t, remoteDo(h, "GET", "/api/hello", testHost, ""), "empty secret", 401, "unauthorized")
}

func TestServeRemote(t *testing.T) {
	ts := httptest.NewTLSServer(nil)
	pair := ts.TLS.Certificates[0]
	ts.Close()

	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	var mu sync.Mutex
	var lines []string
	e := newEnv(t, func(s *Server) {
		s.Remote = NewRemote(port, []string{"127.0.0.1"}, "AB:CD", testSecret)
		s.Remote.logf = func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			lines = append(lines, fmt.Sprintf(format, args...))
		}
	})
	done := make(chan error, 1)
	go func() { done <- e.s.ServeRemote(ln, pair) }()
	t.Cleanup(func() {
		ln.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("ServeRemote did not return after its listener was closed")
		}
		if e.s.Remote.serving.Load() {
			t.Error("the listener still counts as serving")
		}
	})

	tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, ForceAttemptHTTP2: true}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr, Timeout: 10 * time.Second}
	get := func(url, secret string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set(ClientHeader, testAPIClient)
		if secret != "" {
			req.Header.Set(SecretHeader, secret)
		}
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, string(b)
	}
	base := fmt.Sprintf("https://127.0.0.1:%d", port)

	resp, body := get(base+"/api/hello", testSecret)
	if resp.StatusCode != 200 || resp.ProtoMajor != 2 {
		t.Fatalf("hello over HTTPS: status %d, %s (%s), want 200 over HTTP/2", resp.StatusCode, resp.Proto, body)
	}
	out := decode[map[string]any](t, body)
	if _, ok := out["pid"]; ok || out["app"] != "ai-whiteboard" {
		t.Fatalf("hello over HTTPS: %v", out)
	}
	if resp, _ := get(base+"/api/hello", ""); resp.StatusCode != 401 {
		t.Fatalf("hello without the secret: status %d, want 401", resp.StatusCode)
	}
	if resp, _ := get(base+"/api/mcp/status", testSecret); resp.StatusCode != 404 {
		t.Fatalf("a route outside the table over HTTPS: status %d, want 404", resp.StatusCode)
	}
	if resp, _ := get(fmt.Sprintf("https://localhost:%d/api/hello", port), testSecret); resp.StatusCode != 403 {
		t.Fatalf("hello with an unlisted Host: status %d, want 403", resp.StatusCode)
	}

	// The loopback listener reports it.
	st := decode[map[string]any](t, e.expect(200, "GET", "/api/remote/status", ""))
	if st["listening"] != true || st["port"] != float64(port) || st["fingerprint"] != "AB:CD" {
		t.Fatalf("status while serving: %v", st)
	}

	// Plain HTTP gets 400, and the listener's own error log is at most one line a minute.
	for i := 0; i < 3; i++ {
		req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/api/hello", port), nil)
		req.Header.Set(SecretHeader, testSecret)
		req.Header.Set(ClientHeader, testAPIClient)
		resp, err := (&http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("plain HTTP: status %d, want 400", resp.StatusCode)
		}
	}
	// A TLS client is still served after them.
	if resp, _ := get(base+"/api/hello", testSecret); resp.StatusCode != 200 {
		t.Fatalf("hello after plain HTTP: status %d", resp.StatusCode)
	}
	mu.Lock()
	defer mu.Unlock()
	errs := 0
	for _, l := range lines {
		if strings.Contains(l, testSecret) {
			t.Fatalf("a log line holds the secret: %q", l)
		}
		if !strings.Contains(l, "refused") {
			errs++
		}
	}
	if errs > 1 {
		t.Fatalf("%d lines of the listener's error log within a minute, want at most 1: %q", errs, lines)
	}
}

// ServeRemote without a Remote fails instead of serving an open listener.
func TestServeRemoteNeedsRemote(t *testing.T) {
	e := newEnv(t)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err := e.s.ServeRemote(ln, tls.Certificate{}); err == nil {
		t.Fatal("ServeRemote without a Remote returned no error")
	}
}

// A wildcard entry of the table does not open a more specific route outside it: the gate asks the
// routes themselves which pattern serves the request.
func TestRemoteWildcardEntryServesNoOtherRoute(t *testing.T) {
	old := RemoteRoutes
	RemoteRoutes = []string{"GET /api/hello", "GET /api/{x}"}
	t.Cleanup(func() { RemoteRoutes = old })
	e := newEnv(t, withRemote)
	h := e.s.RemoteHandler()
	wantReply(t, remoteDo(h, "GET", "/api/state", testHost, testSecret), "a route outside the table", 404, "not found")
	wantReply(t, remoteDo(h, "GET", "/api/remote/status", testHost, testSecret), "a deeper route outside the table", 404, "not found")
	wantReply(t, remoteDo(h, "GET", "/api/hello", testHost, testSecret), "hello", 200, "")
	wantReply(t, remoteDo(h, "GET", "/api//hello", testHost, testSecret), "a path to clean", 301, "")
}
