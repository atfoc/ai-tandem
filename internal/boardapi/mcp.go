// Package boardapi is the board API for agents: the fixed MCP endpoint /mcp on the dedicated
// listener (identity in the Authorization header). It goes through Relay.Call, the one path from
// an agent to the client, which owns the board engine.
package boardapi

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/boards"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge"
)

// callTimeout is how long a board tool call waits for the client's answer.
const callTimeout = 30 * time.Second

// NoClientText is what an agent is told when no client is active.
const NoClientText = "The board isn't open: the AI Whiteboard window is closed. " +
	"Board work needs the window open. Tell the user, and don't retry until they ask again."

// Relay is the one path from an agent to the client, shared by every agent's board MCP server.
type Relay struct {
	Bridge *editorbridge.Bridge
	Chats  *chats.Manager
	Boards *boards.Service
	// Contacts is the last MCP contact per chat, read by GET /api/mcp/status. Its zero value is
	// ready to use.
	Contacts ContactLog
}

func isTool(name string) bool {
	for _, t := range boardtools.Tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

// Call runs a board tool for the chat with this token and returns the text for the agent.
// Errors come back as text too (isErr = true), so the agent can tell the user.
func (r *Relay) Call(token, tool string, args json.RawMessage) (text string, isErr bool) {
	meta, ok := r.Chats.ByToken(token)
	if !ok {
		return "unknown board token", true
	}
	if meta.Archived {
		return "this chat is archived", true
	}
	if meta.InstructionsSent {
		return "this chat used the old board connection", true
	}
	if !isTool(tool) {
		return "unknown tool " + tool, true
	}
	bd, _ := r.Boards.Get(meta.Board)
	out, err := r.Bridge.Call("tool", map[string]any{
		"chat": meta.ID, "board": bd.ID, "name": tool, "args": args,
	}, callTimeout)
	if errors.Is(err, editorbridge.ErrNoClient) {
		return NoClientText, true
	}
	if err != nil {
		return err.Error(), true
	}
	if json.Unmarshal(out, &text) != nil {
		text = string(out)
	}
	return text, false
}

func short(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}

// Contact is the last MCP contact observed for one chat (or for an unresolved credential). It
// carries no credential and no board content, so it is safe on the read-only status surface.
type Contact struct {
	Chat          string    `json:"chat"`                    // short chat id, or "unknown"
	Client        string    `json:"client,omitempty"`        // initialize clientInfo.name
	ClientVersion string    `json:"clientVersion,omitempty"` // initialize clientInfo.version
	Method        string    `json:"method"`                  // "initialize" or "tools/call"
	Tool          string    `json:"tool,omitempty"`          // tools/call name
	Outcome       string    `json:"outcome,omitempty"`       // tools/call: "ok" or "error"
	At            time.Time `json:"at"`
}

// ContactLog is the MCP observation point's in-memory last-contact tracker. The MCP listener is
// concurrent with GET /api/mcp/status reads on 4747, so every access is guarded. It keeps one
// entry per chat, so it stays bounded and cheap.
type ContactLog struct {
	mu sync.Mutex
	m  map[string]Contact
}

// unknownContact is the entry key for a credential that resolved to no chat. It is deliberately
// constant, never derived from the credential.
const unknownContact = "unknown"

// recordInit records an initialize for the chat keyed by key (the full chat id, or unknown).
func (l *ContactLog) recordInit(key, chat, client, version string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.m == nil {
		l.m = map[string]Contact{}
	}
	c := l.m[key]
	c.Chat, c.Client, c.ClientVersion = chat, client, version
	c.Method, c.Tool, c.Outcome = "initialize", "", ""
	c.At = time.Now()
	l.m[key] = c
}

// recordCall records a tools/call for the chat keyed by key (the full chat id, or unknown).
func (l *ContactLog) recordCall(key, chat, tool, outcome string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.m == nil {
		l.m = map[string]Contact{}
	}
	c := l.m[key]
	c.Chat, c.Method, c.Tool, c.Outcome = chat, "tools/call", tool, outcome
	c.At = time.Now()
	l.m[key] = c
}

// Snapshot returns the last contact per chat, most recent first.
func (l *ContactLog) Snapshot() []Contact {
	l.mu.Lock()
	out := make([]Contact, 0, len(l.m))
	for _, c := range l.m {
		out = append(out, c)
	}
	l.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out
}

// ---- MCP ------------------------------------------------------------------

// The board API served as an MCP server (Streamable HTTP, JSON responses only): the fixed
// POST /mcp on the dedicated listener. serverInfo.name is "board", so Claude names the tools
// mcp__board__<tool>.

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// mcpTools is boardtools.Tools in MCP's tools/list shape.
func mcpTools() []map[string]any {
	out := make([]map[string]any, 0, len(boardtools.Tools))
	for _, t := range boardtools.Tools {
		schema := t.Schema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		out = append(out, map[string]any{"name": t.Name, "description": t.Description, "inputSchema": schema})
	}
	return out
}

// ServeFixedMCP serves the fixed POST /mcp on the dedicated listener. The credential is the
// chat's durable board token in the Authorization header (bearer form).
func (r *Relay) ServeFixedMCP(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	r.serveRPC(w, req, bearerToken(req.Header.Get("Authorization")))
}

// bearerToken returns the token of an "Authorization: Bearer <token>" header, or "".
func bearerToken(header string) string {
	const prefix = "Bearer "
	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

// serveRPC decodes and answers one JSON-RPC request for the board token token.
func (r *Relay) serveRPC(w http.ResponseWriter, req *http.Request, token string) {
	body, _ := io.ReadAll(req.Body)
	var rq rpcReq
	if err := json.Unmarshal(body, &rq); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if rq.ID == nil { // a notification
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	var rpcErr map[string]any
	switch rq.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
			ClientInfo      struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"clientInfo"`
		}
		json.Unmarshal(rq.Params, &p)
		r.logInitialize(token, p.ClientInfo.Name, p.ClientInfo.Version)
		result = map[string]any{
			"protocolVersion": p.ProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "board", "version": "0.0.1"},
		}
	case "tools/list":
		result = map[string]any{"tools": mcpTools()}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		json.Unmarshal(rq.Params, &p)
		text, isErr := r.Call(token, p.Name, p.Arguments)
		r.logToolCall(token, p.Name, isErr)
		res := map[string]any{"content": []map[string]any{{"type": "text", "text": text}}}
		if isErr {
			res["isError"] = true
		}
		result = res
	case "ping":
		result = map[string]any{}
	default:
		rpcErr = map[string]any{"code": -32601, "message": "method not found"}
	}
	resp := map[string]any{"jsonrpc": "2.0", "id": rq.ID}
	if rpcErr != nil {
		resp["error"] = rpcErr
	} else {
		resp["result"] = result
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// chatKey resolves a credential to its short chat id and tracker key. An unknown or empty
// credential maps to the constant unknown marker; the credential itself is never returned.
func (r *Relay) chatKey(token string) (label, key string) {
	if meta, ok := r.Chats.ByToken(token); ok {
		return short(meta.ID), meta.ID
	}
	return unknownContact, unknownContact
}

// logInitialize writes one structured MCP access line and records the contact. It never logs the
// credential; the agent-supplied client name/version are quoted.
func (r *Relay) logInitialize(token, name, version string) {
	label, key := r.chatKey(token)
	log.Printf("mcp initialize chat=%s client=%q version=%q", label, name, version)
	r.Contacts.recordInit(key, label, name, version)
}

// logToolCall writes one structured MCP access line and records the contact. It is the only
// line a tools/call produces (the arguments are deliberately left out) and never logs the
// credential; the agent-supplied tool name is quoted.
func (r *Relay) logToolCall(token, tool string, isErr bool) {
	outcome := "ok"
	if isErr {
		outcome = "error"
	}
	label, key := r.chatKey(token)
	log.Printf("mcp tools/call chat=%s tool=%q outcome=%s", label, tool, outcome)
	r.Contacts.recordCall(key, label, tool, outcome)
}
