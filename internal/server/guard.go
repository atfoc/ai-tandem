package server

import (
	"net/http"
	"strconv"
	"strings"

	"ai-whiteboard/internal/editorbridge"
)

// ClientHeader carries the id of the client making an /api request.
const ClientHeader = "X-AIWB-Client"

// guard rejects requests that could come from a web page other than the client:
//   - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding);
//   - every /api request except GET and the /api/client/* and /api/rpc-reply routes must carry
//     X-AIWB-Client equal to the active client's id (409 {"error":"not_active"} otherwise).
//     A custom header also forces a CORS preflight, which the server never answers.
//
// The MCP listener on 6006 (POST /mcp) gets the same guard for its Host check only: its requests
// are outside /api, so the active-client rule does not apply, and the caller is identified by the
// board token in the Authorization header. /api/client/* and /api/rpc-reply check the client
// themselves (see clientOf), since the id may be in the body.
func guard(b *editorbridge.Bridge, port int, next http.Handler) http.Handler {
	p := strconv.Itoa(port)
	allowed := map[string]bool{"127.0.0.1:" + p: true, "localhost:" + p: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[r.Host] {
			writeError(w, http.StatusForbidden, "bad host")
			return
		}
		if needsActive(r) && !b.IsActive(r.Header.Get(ClientHeader)) {
			writeError(w, http.StatusConflict, "not_active")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// needsActive reports whether r must come from the active client (checked by header).
func needsActive(r *http.Request) bool {
	if r.URL.Path != "/api" && !strings.HasPrefix(r.URL.Path, "/api/") {
		return false
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return false
	}
	if strings.HasPrefix(r.URL.Path, "/api/client/") || r.URL.Path == "/api/rpc-reply" {
		return false
	}
	return true
}

// activeOrPending reports whether id is the active client or the one waiting to take over.
func activeOrPending(b *editorbridge.Bridge, id string) bool {
	return id != "" && (b.IsActive(id) || b.IsPending(id))
}
