package server

import (
	"net"
	"net/http"
	"strconv"
)

// guard rejects requests to the MCP listener that could come from a web page (DNS rebinding):
// Host must be <name>:<port> with name 127.0.0.1, localhost or host.docker.internal (a Claude
// account's claude reaches the listener from its Docker container by that name), or an IP literal
// in a private range (on Linux the Docker bridge gateway, e.g. 172.17.0.1, which can change when
// Docker restarts). An IP-literal Host cannot come from DNS rebinding. Any other name, another
// port, a public IP or no port is refused. The caller of POST /mcp is identified by the board
// token in the Authorization header, and no CORS headers are added.
func guard(port int, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !mcpHostAllowed(r.Host, port) {
			writeError(w, http.StatusForbidden, "bad host")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// mcpHostAllowed is guard's check of one Host header.
func mcpHostAllowed(hostport string, port int) bool {
	h, p, err := net.SplitHostPort(hostport)
	if err != nil || p != strconv.Itoa(port) {
		return false
	}
	switch h {
	case "127.0.0.1", "localhost", "host.docker.internal":
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsPrivate()
}
