package boardapi

import (
	"net/url"
	"testing"
)

// TestMCPURLEndpoint pins the exact production URL string. Cursor's org allowlist matches the
// full URL exactly, so a query, a trailing slash, a 127.0.0.1 spelling or a different port must
// fail here rather than silently in production (plan §4, D1, D3, D10).
func TestMCPURLEndpoint(t *testing.T) {
	if MCPPort != 6006 {
		t.Fatalf("MCPPort = %d, want 6006", MCPPort)
	}
	if MCPURL != "http://localhost:6006/mcp" {
		t.Fatalf("MCPURL = %q, want %q", MCPURL, "http://localhost:6006/mcp")
	}
	u, err := url.Parse(MCPURL)
	if err != nil {
		t.Fatalf("parse %q: %v", MCPURL, err)
	}
	if u.Host != "localhost:6006" || u.Path != "/mcp" || u.RawQuery != "" || u.Fragment != "" {
		t.Fatalf("parsed URL = %+v", u)
	}
	if got := Endpoint(MCPPort); got != MCPURL {
		t.Fatalf("Endpoint(%d) = %q, want %q", MCPPort, got, MCPURL)
	}
	if got := Endpoint(0); got != "http://localhost:0/mcp" {
		t.Fatalf("Endpoint(0) = %q", got)
	}
}
