package server

import (
	"context"
	"crypto/subtle"
	"crypto/tls"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/version"
)

// SecretHeader carries the secret of a request to the remote listener.
const SecretHeader = "X-AIWB-Secret"

// FeatureLevel is hello's "featureLevel": what this server offers an API client. Level 1 is the
// remote listener with the chat routes, the run routes and the reload of the secret. Level 2 adds
// the boards of an API client (apiboards.go). Level 3 adds the server's prompt library
// (library.go): the library routes, "library" in the API snapshot and the "own_library" event.
// A client takes a library only of a server of level 3 or above (servers.LibraryLevel).
// Level 4 adds a chat made on the server before its first message, the draft of a chat kept on
// the server (PUT /api/chats/{id}/draft), and the images of a message with their two routes
// (images.go).
// Level 5 serves an API client as the server's own page: its snapshot and its events are the
// server's whole tree, whoever made what is in it, and the page's routes for groups, boards, runs
// and new chats take the place of the calls that existed for a client alone (the creation call,
// the make, the start call and the draft check, a board with an id of the client's making).
// A client does not connect to a server below level 5 (servers.MinFeatureLevel), and a server of
// level 5 serves no client below it (MinClientLevel).
const FeatureLevel = 5

// MinClientLevel is the lowest level of a client (servers.LevelHeader: the feature level of the
// app that calls) this server serves anything but hello to: an app of before would file the
// server's whole tree as its own.
const MinClientLevel = 5

// clientTooOld is the refusal of a client below MinClientLevel, or of one that states no level.
const clientTooOld = "This app is too old for this server: update AI Whiteboard on the machine that connects."

// RemoteRoutes is the one table of the routes an API client may call, spelled as registered.
// The remote listener answers every other route, the client files included, with 404. What it
// leaves out is what a client cannot reach: the server list and its secrets, the calls that pass
// on to another server (/api/servers, /api/on), restart, the order of the groups, the reveal of a
// file in this machine's file manager, the status routes and the client files.
var RemoteRoutes = []string{
	"GET /api/hello",
	"GET /api/events",
	"GET /api/state",
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
	"POST /api/runs",
	"GET /api/runs/{id}",
	"PATCH /api/runs/{id}",
	"PUT /api/runs/{id}/draft",
	"POST /api/runs/{id}/start",
	"POST /api/runs/{id}/stop",
	"POST /api/runs/{id}/resume",
	"POST /api/runs/{id}/apply",
	"GET /api/runs/{id}/delivery",
	"DELETE /api/runs/{id}",
	"GET /api/runs/{id}/detail",
	"GET /api/runs/{id}/goal",
	"GET /api/runs/{id}/tasks/{tid}/brief",
	"GET /api/runs/{id}/tasks/{tid}/attempts/{n}/report",
	"GET /api/runs/{id}/tasks/{tid}/attempts/{n}/changes",
	"GET /api/runs/{id}/notes/{v}",
	"POST /api/runs/{id}/archive",
	"POST /api/runs/{id}/unarchive",
	"POST /api/runs/{id}/unfollow",
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

// helloRoute is the one route an API client may call with the server's own id.
const helloRoute = "GET /api/hello"

// Remote is the remote listener's identity and state: what GET /api/remote/status reports, the
// secret its requests must carry, and the log of the requests it refused.
type Remote struct {
	Port        int
	Names       []string // the Host names it answers to
	Fingerprint string   // SHA-256 of its certificate

	secret  atomic.Value // string; "" refuses every request
	serving atomic.Bool  // true while ServeRemote serves
	// secretGen counts the changes of the secret, raised once the new one is the one accepted,
	// so before ReloadSecret closes the API clients' streams; reloads counts the reloads that
	// are done, raised after.
	secretGen atomic.Int64
	reloads   atomic.Int64

	now  func() time.Time
	logf func(format string, args ...any)

	mu      sync.Mutex
	refused map[string]time.Time // source IP -> its last logged refusal
	lastErr time.Time            // the last line of the listener's own error log
}

func NewRemote(port int, names []string, fingerprint, secret string) *Remote {
	rm := &Remote{Port: port, Names: names, Fingerprint: fingerprint, now: time.Now, logf: log.Printf}
	rm.secret.Store(secret)
	return rm
}

// SetSecret replaces the secret: requests with the old one are refused from now on. The streams
// that the old one opened stay open: see Server.ReloadSecret.
func (rm *Remote) SetSecret(s string) {
	rm.secret.Store(s)
	rm.secretGen.Add(1)
}

// secretOK compares got with the current secret in constant time.
func (rm *Remote) secretOK(got string) bool {
	want, _ := rm.secret.Load().(string)
	return want != "" && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// hostOK reports whether host (a request's Host) is <name>:<port> for a listed name, or the bare
// name when the port is 443. Names are compared lower-cased.
func (rm *Remote) hostOK(host string) bool {
	host = strings.ToLower(host)
	port := ":" + strconv.Itoa(rm.Port)
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
func (rm *Remote) once(key string) bool {
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

func (rm *Remote) printf(format string, args ...any) {
	if rm.logf != nil {
		rm.logf(format, args...)
		return
	}
	log.Printf(format, args...)
}

// logRefused logs a request refused with status (401, 403, or 400 for a client that is too old),
// one line per source IP per minute. It never logs a header value other than Host, and it cuts
// what the caller chose: the method at 16 characters, the path and the Host at 80.
func (rm *Remote) logRefused(status int, r *http.Request) {
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

// errorLog is the http.Server's ErrorLog of the remote listener: at most one line a minute, since
// every plain-HTTP or failed TLS connection would log one and server.log is never rotated.
type errorLog struct{ rm *Remote }

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

type remoteKey struct{}

// remoteCall is what RemoteHandler notes of a request it lets through: the count of secret
// changes it read before it checked the request's secret.
type remoteCall struct{ secretGen int64 }

// fromRemote reports whether r came in through the remote listener (behind RemoteHandler).
func fromRemote(r *http.Request) bool {
	_, ok := r.Context().Value(remoteKey{}).(remoteCall)
	return ok
}

// RemoteHandler is the handler of the remote listener. It serves the routes of RemoteRoutes to
// requests that carry the secret, and nothing else: no client files, no route outside the table.
// The loopback guard is not in front of it, so neither is the active-client rule. Per request:
//  1. the secret in X-AIWB-Secret (401 {"error":"unauthorized"} otherwise), before anything else,
//     so that a caller without it learns nothing, not even which Host values are right;
//  2. Host must be <name>:<port> for a listed name (403 {"error":"bad host"}; DNS rebinding);
//  3. the client id: X-AIWB-Client must hold a lowercase version 4 UUID, the caller's instance
//     id (400 with the code "bad_client" otherwise, on every path, one outside the table too; an
//     id in the body or the query does not count). The server's own id is refused on every route
//     but hello (400, code "own_client"): a server is not its own API client;
//  4. the client's level: on every route but hello, X-AIWB-Level must hold an integer of
//     MinClientLevel or more (400 with the code "client_too_old" otherwise, on a path outside the
//     table too). Hello stays open to every app that has the secret, so an older app still shows
//     the server's version;
//  5. the route must be in RemoteRoutes (404 {"error":"not found"}, for a wrong method too);
//  6. the route itself, with fromRemote(r) true.
//
// There is no known-client rule here: a write needs no open stream and marks nothing.
func (s *Server) RemoteHandler() http.Handler {
	rm := s.Remote
	table := map[string]bool{}
	for _, p := range RemoteRoutes {
		table[p] = true
	}
	routes := s.routes()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if rm == nil { // remote access is off
			writeError(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		// Read before the secret is checked: see apiEvents.
		call := remoteCall{secretGen: rm.secretGen.Load()}
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
		// The pattern is the one the routes themselves serve r with, so a route outside the table
		// that is more specific than a wildcard entry of it is not served.
		_, pat := routes.Handler(r)
		if id == s.InstanceID && pat != helloRoute {
			writeErrorCode(w, http.StatusBadRequest, "this is the server's own id", "own_client")
			return
		}
		if pat != helloRoute && !levelOK(r.Header.Get(servers.LevelHeader)) {
			rm.logRefused(http.StatusBadRequest, r)
			writeErrorCode(w, http.StatusBadRequest, clientTooOld, "client_too_old")
			return
		}
		if !table[pat] {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		routes.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), remoteKey{}, call)))
	})
}

// levelOK reports whether v, the value of servers.LevelHeader, is an integer of MinClientLevel or more.
func levelOK(v string) bool {
	n, err := strconv.Atoi(v)
	return err == nil && n >= MinClientLevel
}

// ServeRemote serves RemoteHandler over HTTPS on ln with the certificate pair, and blocks until
// the listener fails or is closed. s.Remote must be set.
func (s *Server) ServeRemote(ln net.Listener, pair tls.Certificate) error {
	rm := s.Remote
	if rm == nil {
		return errors.New("remote listener: not configured")
	}
	srv := &http.Server{
		Handler:           s.RemoteHandler(),
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

// ReloadSecret makes secret the one the remote listener accepts, and then ends the stream of
// every API client. It returns how many streams it ended; 0 and nothing done with remote access
// off. The order is fixed: no stream is closed while the old secret is still accepted, or its
// client would be back with it at once.
func (s *Server) ReloadSecret(secret string) int {
	rm := s.Remote
	if rm == nil {
		return 0
	}
	rm.SetSecret(secret)
	n := s.Bridge.CloseKind(editorbridge.KindAPI)
	rm.reloads.Add(1)
	return n
}

// hello is the body of GET /api/hello, on both listeners. A caller on the remote listener does
// not get the pid.
func (s *Server) hello(r *http.Request) map[string]any {
	out := map[string]any{"app": "ai-whiteboard", "version": version.Version, "webVersion": s.webVersion(), "featureLevel": FeatureLevel}
	if !fromRemote(r) {
		out["pid"] = os.Getpid()
	}
	if s.InstanceID != "" {
		out["instanceId"] = s.InstanceID
	}
	return out
}

// remoteStatus is GET /api/remote/status, on the loopback listener only: whether the remote
// listener serves, and then its port, names and certificate fingerprint, and how many times it
// read its secret again (ReloadSecret).
func (s *Server) remoteStatus(w http.ResponseWriter, r *http.Request) {
	rm := s.Remote
	if rm == nil || !rm.serving.Load() {
		writeJSON(w, map[string]any{"listening": false})
		return
	}
	names := rm.Names
	if names == nil {
		names = []string{}
	}
	writeJSON(w, map[string]any{"listening": true, "port": rm.Port, "names": names, "fingerprint": rm.Fingerprint,
		"secretReloads": rm.reloads.Load()})
}
