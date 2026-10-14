package server

import (
	"net/http"
	"os"
	"strconv"

	"ai-whiteboard/internal/boardapi"
)

// ControlHandler is the handler of the control socket: a Unix socket in the data folder that
// only the user of this machine can open. It answers the server program's own commands (status,
// stop, launch, ...) and nothing else: it is no listener on the network and no part of the client
// API, and it asks no secret. It serves GET /hello and GET /status; every other route is 404.
// dataDir is the data folder, which hello names so that a command can tell the server of its own
// folder from another.
func (s *Server) ControlHandler(dataDir string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /hello", func(w http.ResponseWriter, r *http.Request) {
		out := s.hello()
		out["pid"] = os.Getpid()
		out["dataDir"] = dataDir
		writeJSON(w, out)
	})
	mux.HandleFunc("GET /status", s.controlStatus)
	return mux
}

// controlStatus is GET /status: the client listener's state and the MCP listener's identity with
// the last MCP contact per chat. It carries no secret, no token and no board content.
func (s *Server) controlStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{"client": s.clientStatus(), "mcp": s.mcpStatus()})
}

// clientStatus is whether the client listener serves, and then its address, port, names and
// certificate fingerprint, and how many times it read its secret again (ReloadSecret).
func (s *Server) clientStatus() map[string]any {
	rm := s.Clients
	if rm == nil || !rm.serving.Load() {
		return map[string]any{"listening": false}
	}
	names := rm.Names
	if names == nil {
		names = []string{}
	}
	return map[string]any{"listening": true, "address": "https://127.0.0.1:" + strconv.Itoa(rm.Port), "port": rm.Port,
		"names": names, "fingerprint": rm.Fingerprint, "secretReloads": rm.reloads.Load()}
}

// mcpStatus is the MCP listener's identity and the last MCP contact per chat (chat id, client,
// method/tool, outcome, time).
func (s *Server) mcpStatus() map[string]any {
	up := false
	if s.MCPUp != nil {
		up = s.MCPUp()
	}
	chats := []boardapi.Contact{}
	if s.Relay != nil {
		chats = s.Relay.Contacts.Snapshot()
	}
	return map[string]any{
		"listener": map[string]any{"port": s.MCPPort, "url": s.MCPURL, "up": up},
		"chats":    chats,
	}
}
