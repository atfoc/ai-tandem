package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGuardMCPHosts(t *testing.T) {
	t.Parallel()
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusTeapot) })
	h := guard(6006, ok)
	for _, c := range []struct {
		host string
		want bool
	}{
		{"127.0.0.1:6006", true},
		{"localhost:6006", true},
		{"host.docker.internal:6006", true}, // Docker Desktop: a container's request
		{"172.17.0.1:6006", true},           // Linux: the docker0 bridge gateway
		{"172.18.0.1:6006", true},           // the bridge after a Docker restart / another network
		{"10.0.0.5:6006", true},
		{"192.168.1.20:6006", true},
		{"[fd00::1]:6006", true},

		{"host.docker.internal:6007", false}, // the right name, a wrong port
		{"host.docker.internal", false},      // no port
		{"172.17.0.1", false},
		{"localhost:4748", false},
		{"evil.example:6006", false},
		{"docker.internal:6006", false},
		{"host.docker.internal.evil.example:6006", false},
		{"HOST.DOCKER.INTERNAL:6006", false},
		{"8.8.8.8:6006", false}, // public IP
		{"172.32.0.1:6006", false},
		{"[2001:db8::1]:6006", false},
		{"[::1]:6006", false},
		{"0.0.0.0:6006", false},
		{"169.254.1.1:6006", false},
		{"", false},
		{":6006", false},
	} {
		req := httptest.NewRequest("POST", "/mcp", nil)
		req.Host = c.host
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		got := w.Code == http.StatusTeapot
		if got != c.want {
			t.Errorf("host %q: allowed=%v, want %v (status %d %s)", c.host, got, c.want, w.Code, w.Body)
		}
		if !got && (w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"bad host"`)) {
			t.Errorf("host %q: refused with %d %q, want 403 bad host", c.host, w.Code, w.Body)
		}
	}
}

func TestGuardMCPHandlerFromContainer(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	h := e.s.MCPHandler(6006)
	for _, host := range []string{"host.docker.internal:6006", "172.17.0.1:6006"} {
		req := httptest.NewRequest("POST", "/mcp", nil)
		req.Host = host
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		if w.Code == http.StatusForbidden {
			t.Fatalf("host %s: refused by the guard (%s)", host, w.Body)
		}
	}
	req := httptest.NewRequest("POST", "/mcp", nil)
	req.Host = "host.docker.internal:6007"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Fatalf("wrong port: status %d, want 403", w.Code)
	}
}
