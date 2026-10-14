package server

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"errors"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/version"
)

// The headers of a client's request.
const (
	// SecretHeader carries the secret of a request to the client listener.
	SecretHeader = "X-AIWB-Secret"
	// ClientHeader carries the id of the client making an /api request.
	ClientHeader = "X-AIWB-Client"
	// LevelHeader carries the feature level of the app that calls.
	LevelHeader = "X-AIWB-Level"
	// SceneRevHeader carries the revision of the drawing in the answer of GET /api/boards/{id}/scene.
	SceneRevHeader = "X-AIWB-Scene-Rev"
)

// FeatureLevel is hello's "featureLevel": what this server offers a client. Level 1 is the
// client listener with the chat routes and the reload of the secret. Level 2 adds the boards of
// a client (apiboards.go). Level 3 adds the server's prompt library (library.go): the library
// routes, "library" in the snapshot and the "own_library" event. Level 4 adds a chat made on the
// server before its first message, the draft of a chat kept on the server
// (PUT /api/chats/{id}/draft), and the images of a message with their two routes (images.go).
// Level 5 serves a client as the server's own page: its snapshot and its events are the server's
// whole tree, whoever made what is in it. Level 6 is the client listener as the one API of the
// server, for the app on this machine as for one on another: no loopback listener, no page, no
// list of other servers, and the secret from every client.
// A client does not connect to a server below level 6, and a server of level 6 serves no client
// below it (MinClientLevel).
const FeatureLevel = 6

// MinClientLevel is the lowest level of a client (LevelHeader: the feature level of the app that
// calls) this server serves anything but hello to: an app of before would file the server's
// whole tree as its own.
const MinClientLevel = 6

// clientTooOld is the refusal of a client below MinClientLevel, or of one that states no level.
const clientTooOld = "This app is too old for this server: update AI Whiteboard on the machine that connects."

// ClientRoutes is the one table of the routes a client may call, spelled as registered: the
// client API. The client listener answers every other route with 404 (401 without the secret).
// There is no page file, no route of the owner's things (restart, the server's log, the state of
// the MCP listener, the reveal of a file in the file manager: the app does them itself) and no
// route that names another server.
var ClientRoutes = []string{
	"GET /api/hello",
	"GET /api/events",
	"GET /api/state",
	"POST /api/client/flushed",
	"POST /api/groups",
	"PATCH /api/groups/{id}",
	"POST /api/groups/{id}/move",
	"DELETE /api/groups/{id}",
	"POST /api/groups/{id}/archive",
	"POST /api/groups/{id}/unarchive",
	"POST /api/chats",
	"GET /api/chats/{id}",
	"GET /api/chats/{id}/items",
	"GET /api/chats/{id}/tree",
	"GET /api/chats/{id}/context",
	"GET /api/chats/{id}/subagents/{sid}/items",
	"PATCH /api/chats/{id}",
	"POST /api/chats/{id}/messages",
	"POST /api/chats/{id}/interrupt",
	"POST /api/chats/{id}/permission",
	"PUT /api/chats/{id}/label",
	"PUT /api/chats/{id}/draft",
	"POST /api/chats/{id}/images",
	"GET /api/chats/{id}/images/{image}",
	"POST /api/chats/{id}/open",
	"POST /api/chats/{id}/fork",
	"POST /api/chats/{id}/archive",
	"POST /api/chats/{id}/unarchive",
	"DELETE /api/chats/{id}",
	"POST /api/chats/{id}/unfollow",
	"GET /api/dirs",
	"GET /api/usage/{agent}",
	"POST /api/boards",
	"GET /api/boards/{id}/scene",
	"PUT /api/boards/{id}/scene",
	"POST /api/boards/{id}/take",
	"POST /api/boards/{id}/release",
	"POST /api/boards/{id}/rename",
	"PATCH /api/boards/{id}",
	"POST /api/boards/{id}/archive",
	"POST /api/boards/{id}/unarchive",
	"POST /api/boards/{id}/seen",
	"DELETE /api/boards/{id}",
	"POST /api/rpc-reply",
	"GET /api/library",
	"POST /api/library/{server}/groups",
	"PATCH /api/library/{server}/groups/{id}",
	"DELETE /api/library/{server}/groups/{id}",
	"POST /api/library/{server}/prompts",
	"PATCH /api/library/{server}/prompts/{id}",
	"DELETE /api/library/{server}/prompts/{id}",
}

// helloRoute is the one route that is answered without the secret, and the one a client may call
// with the server's own id.
const helloRoute = "GET /api/hello"

// ClientListener is the client listener's identity and state: what the control socket's /status
// reports, the secret its requests must carry, and the log of the requests it refused.
type ClientListener struct {
	Port        int
	Names       []string // the Host names it answers to
	Fingerprint string   // SHA-256 of its certificate

	secret  atomic.Value // string; "" refuses every request
	serving atomic.Bool  // true while ServeClients serves
	// secretGen counts the changes of the secret, raised once the new one is the one accepted,
	// so before ReloadSecret closes the clients' streams; reloads counts the reloads that
	// are done, raised after.
	secretGen atomic.Int64
	reloads   atomic.Int64

	now  func() time.Time
	logf func(format string, args ...any)

	mu      sync.Mutex
	refused map[string]time.Time // source IP -> its last logged refusal
	lastErr time.Time            // the last line of the listener's own error log
}

func NewClientListener(port int, names []string, fingerprint, secret string) *ClientListener {
	rm := &ClientListener{Port: port, Names: names, Fingerprint: fingerprint, now: time.Now, logf: log.Printf}
	rm.secret.Store(secret)
	return rm
}

// SetSecret replaces the secret: requests with the old one are refused from now on. The streams
// that the old one opened stay open: see Server.ReloadSecret.
func (rm *ClientListener) SetSecret(s string) {
	rm.secret.Store(s)
	rm.secretGen.Add(1)
}

// secretOK compares got with the current secret in constant time.
func (rm *ClientListener) secretOK(got string) bool {
	want, _ := rm.secret.Load().(string)
	return want != "" && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// hostOK reports whether host (a request's Host) is <name>:<port> for a listed name, the bare
// name when the port is 443, or 127.0.0.1:<port> or localhost:<port>: the app on this machine
// reaches the server by its loopback address whatever names the set-up has. Names are compared
// lower-cased.
func (rm *ClientListener) hostOK(host string) bool {
	host = strings.ToLower(host)
	port := ":" + strconv.Itoa(rm.Port)
	if host == "127.0.0.1"+port || host == "localhost"+port {
		return true
	}
	for _, n := range rm.Names {
		n = strings.ToLower(n)
		if host == n+port || (rm.Port == 443 && host == n) {
			return true
		}
	}
	return false
}

// refusedLogMax is how many source IPs the refused log remembers before it drops the old ones.
const refusedLogMax = 1024

// once reports whether a line may be logged now for key: one per key per minute.
func (rm *ClientListener) once(key string) bool {
	now := time.Now()
	if rm.now != nil {
		now = rm.now()
	}
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if last, ok := rm.refused[key]; ok && now.Sub(last) < time.Minute {
		return false
	}
	if rm.refused == nil {
		rm.refused = map[string]time.Time{}
	}
	if len(rm.refused) >= refusedLogMax {
		for k, last := range rm.refused {
			if now.Sub(last) >= time.Minute {
				delete(rm.refused, k)
			}
		}
		if len(rm.refused) >= refusedLogMax { // a flood from many addresses: say nothing more
			return false
		}
	}
	rm.refused[key] = now
	return true
}

func (rm *ClientListener) printf(format string, args ...any) {
	if rm.logf != nil {
		rm.logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

// logRefused logs a request refused with status (401, 403, or 400 for a client that is too old),
// one line per source IP per minute. It never logs a header value other than Host, and it cuts
// what the caller chose: the method at 16 characters, the path and the Host at 80.
func (rm *ClientListener) logRefused(status int, r *http.Request) {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if !rm.once(ip) {
		return
	}
	switch status {
	case http.StatusForbidden:
		rm.printf("remote listener: refused %d from %s: %s %q host=%q", status, ip, cut(r.Method, 16), cut(r.URL.Path, 80), cut(r.Host, 80))
		return
	case http.StatusBadRequest:
		rm.printf("remote listener: refused %d from %s: %s %q: %s", status, ip, cut(r.Method, 16), cut(r.URL.Path, 80), clientTooOld)
		return
	}
	rm.printf("remote listener: refused %d from %s: %s %q", status, ip, cut(r.Method, 16), cut(r.URL.Path, 80))
}

// cut returns s shortened to at most n characters.
func cut(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// errorLog is the http.Server's ErrorLog of the client listener: at most one line a minute, since
// every plain-HTTP or failed TLS connection would log one and server.log is never rotated.
type errorLog struct{ rm *ClientListener }

func (l errorLog) Write(p []byte) (int, error) {
	rm := l.rm
	now := time.Now()
	if rm.now != nil {
		now = rm.now()
	}
	rm.mu.Lock()
	quiet := !rm.lastErr.IsZero() && now.Sub(rm.lastErr) < time.Minute
	if !quiet {
		rm.lastErr = now
	}
	rm.mu.Unlock()
	if !quiet {
		rm.printf("remote listener: %s", strings.TrimRight(string(p), "\n"))
	}
	return len(p), nil
}

type callKey struct{}

// clientCall is what ClientHandler notes of a request it lets through: the count of secret
// changes it read before it checked the request's secret.
type clientCall struct{ secretGen int64 }

// ClientHandler is the handler of the client listener, the one API of the server. Per request:
//
// GET /api/hello is answered without the secret, to whoever asks the right Host (403
// {"error":"bad host"} otherwise): the app, the version, the feature level and the instance id,
// nothing else. Every other request:
//  1. the secret in X-AIWB-Secret (401 {"error":"unauthorized"} otherwise), before anything else,
//     so that a caller without it learns nothing, not even which Host values are right;
//  2. Host must be <name>:<port> for a listed name, or the loopback address (403
//     {"error":"bad host"}; DNS rebinding);
//  3. the client id: X-AIWB-Client must hold a lowercase version 4 UUID, the caller's id (400 with
//     the code "bad_client" otherwise, on every path, one outside the table too; an id in the
//     body or the query does not count). The server's own id is refused (400, code
//     "own_client"): a server is not its own client;
//  4. the client's level: X-AIWB-Level must hold an integer of MinClientLevel or more (400 with
//     the code "client_too_old" otherwise, on a path outside the table too). Hello stays open to
//     every app, so an older app still shows the server's version;
//  5. the route must be in ClientRoutes (404 {"error":"not found"}, for a wrong method too);
//  6. the route itself.
//
// There is no known-client rule: a write needs no open stream and marks nothing.
func (s *Server) ClientHandler() http.Handler {
	rm := s.Clients
	table := map[string]bool{}
	for _, p := range ClientRoutes {
		table[p] = true
	}
	routes := s.routes()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rm == nil { // a server without a listener's identity, in a test, serves nothing
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		// The pattern is the one the routes themselves serve r with, so a route outside the table
		// that is more specific than a wildcard entry of it is not served.
		_, pat := routes.Handler(r)
		if pat == helloRoute && r.URL.Path == "/api/hello" { // a path to clean is no hello: the route redirects it
			if !rm.hostOK(r.Host) {
				rm.logRefused(http.StatusForbidden, r)
				writeError(w, http.StatusForbidden, "bad host")
				return
			}
			writeJSON(w, s.hello())
			return
		}
		// Read before the secret is checked: see apiEvents.
		call := clientCall{secretGen: rm.secretGen.Load()}
		if !rm.secretOK(r.Header.Get(SecretHeader)) {
			rm.logRefused(http.StatusUnauthorized, r)
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		r.Header.Del(SecretHeader)
		if !rm.hostOK(r.Host) {
			rm.logRefused(http.StatusForbidden, r)
			writeError(w, http.StatusForbidden, "bad host")
			return
		}
		id := r.Header.Get(ClientHeader)
		if !remote.ValidID(id) {
			writeErrorCode(w, http.StatusBadRequest, "bad client id", "bad_client")
			return
		}
		if id == s.InstanceID {
			writeErrorCode(w, http.StatusBadRequest, "this is the server's own id", "own_client")
			return
		}
		if !levelOK(r.Header.Get(LevelHeader)) {
			rm.logRefused(http.StatusBadRequest, r)
			writeErrorCode(w, http.StatusBadRequest, clientTooOld, "client_too_old")
			return
		}
		if !table[pat] {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		routes.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callKey{}, call)))
	})
}

// levelOK reports whether v, the value of LevelHeader, is an integer of MinClientLevel or more.
func levelOK(v string) bool {
	n, err := strconv.Atoi(v)
	return err == nil && n >= MinClientLevel
}

// ServeClients serves ClientHandler over HTTPS on ln with the certificate pair, and blocks until
// the listener fails or is closed. s.Clients must be set.
func (s *Server) ServeClients(ln net.Listener, pair tls.Certificate) error {
	rm := s.Clients
	if rm == nil {
		return errors.New("client listener: not configured")
	}
	srv := &http.Server{
		Handler:           s.ClientHandler(),
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{pair}, MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          log.New(errorLog{rm}, "", 0),
		// No write time-out: an event stream stays open.
	}
	rm.serving.Store(true)
	defer rm.serving.Store(false)
	return srv.ServeTLS(ln, "", "")
}

// ReloadSecret makes secret the one the client listener accepts, and then ends the stream of
// every client. It returns how many streams it ended; 0 and nothing done without a listener. The
// order is fixed: no stream is closed while the old secret is still accepted, or its client
// would be back with it at once.
func (s *Server) ReloadSecret(secret string) int {
	rm := s.Clients
	if rm == nil {
		return 0
	}
	rm.SetSecret(secret)
	n := s.Bridge.CloseAll()
	rm.reloads.Add(1)
	return n
}

// hello is the body of GET /api/hello: what a client asks first, answered without the secret.
func (s *Server) hello() map[string]any {
	out := map[string]any{"app": "ai-whiteboard", "version": version.Version, "featureLevel": FeatureLevel}
	if s.InstanceID != "" {
		out["instanceId"] = s.InstanceID
	}
	return out
}
