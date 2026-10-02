package boardapi

import "fmt"

// MCPPort is the fixed port of the board MCP listener. It must not be made user-configurable:
// Cursor's org allowlist matches the full URL exactly (plan D1/D10).
const MCPPort = 6006

// MCPURL is the exact URL every agent is configured with. The spelling matters: only
// "localhost", no query, no trailing slash (plan D3).
const MCPURL = "http://localhost:6006/mcp"

// Endpoint returns the MCP URL for a listener port. Production always passes MCPPort, so this is
// exactly MCPURL; the hidden test-only port override passes another port and gets the matching
// localhost URL.
func Endpoint(port int) string {
	if port == MCPPort {
		return MCPURL
	}
	return fmt.Sprintf("http://localhost:%d/mcp", port)
}
