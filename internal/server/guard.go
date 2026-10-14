package server

import (
	"net/http"
	"strconv"
)

// guard rejects requests to the MCP listener that could come from a web page: Host must be
// 127.0.0.1:<port> or localhost:<port> (DNS rebinding). The caller of POST /mcp is identified by
// the board token in the Authorization header, and no CORS headers are added.
func guard(port int, next http.Handler) http.Handler {
	p := strconv.Itoa(port)
	allowed := map[string]bool{"127.0.0.1:" + p: true, "localhost:" + p: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowed[r.Host] {
			writeError(w, http.StatusForbidden, "bad host")
			return
		}
		next.ServeHTTP(w, r)
	})
}
