package server

import (
	"net/http"
	"strconv"
	"strings"

	"ai-whiteboard/internal/editorbridge"
)

// ClientHeader carries the id of the client making an /api request.
const ClientHeader = "X-AIWB-Client"

// SceneRevHeader carries the revision of the drawing in the answer of GET /api/boards/{id}/scene.
const SceneRevHeader = "X-AIWB-Scene-Rev"

// guard rejects requests that could come from a web page other than the client:
//   - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding);
//   - every /api request except GET and HEAD must carry in X-AIWB-Client the id of a known
//     client, one with an open event stream (409 {"error":"unknown_client"} otherwise). No route
//     is exempt, and an id in the body does not count: a custom header forces a CORS preflight,
//     which the server never answers.
//
// The MCP listener on 6006 (POST /mcp) gets the same guard for its Host check only: its requests
// are outside /api, so the known-client rule does not apply, and the caller is identified by the
// board token in the Authorization header. Every /api request with the id of a known client in the
// header, a GET or HEAD too, also marks that client as one that acted (see
// editorbridge.Bridge.Acted): a page that has only read since its stream opened is still asked a
// board tool call, and a client that only opened a stream is given no board.
func guard(b *editorbridge.Bridge, port int, next http.Handler) http.Handler {
	p := strconv.Itoa(port)
	allowed := map[string]bool{"127.0.0.1:" + p: true, "localhost:" + p: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[r.Host] {
			writeError(w, http.StatusForbidden, "bad host")
			return
		}
		known := false
		if id := r.Header.Get(ClientHeader); id != "" && isAPI(r) {
			known = b.Acted(id)
		}
		if needsClient(r) && !known {
			writeError(w, http.StatusConflict, "unknown_client")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// isAPI reports whether r is an /api request.
func isAPI(r *http.Request) bool {
	return r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/")
}

// needsClient reports whether r must come from a known client (checked by header).
func needsClient(r *http.Request) bool {
	return isAPI(r) && r.Method != http.MethodGet && r.Method != http.MethodHead
}
