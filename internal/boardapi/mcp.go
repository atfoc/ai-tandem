// Package boardapi is the board API for agents: MCP at /mcp/{token} (Claude) and the command
// endpoint /agent/{token}/{tool} (Cursor). Both go through Relay.Call, the one path from an
// agent to the client, which owns the board engine.
package boardapi

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
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

// Relay is the one path from an agent to the client, shared by MCP and commands.
type Relay struct {
	Bridge *editorbridge.Bridge
	Chats  *chats.Manager
	Boards *boards.Service
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
	if !isTool(tool) {
		return "unknown tool " + tool, true
	}
	bd, _ := r.Boards.Get(meta.Board)
	log.Printf("board tool %s %s %s", short(meta.ID), tool, trunc(string(args), 200))
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

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// ---- MCP ------------------------------------------------------------------

// The board API served as an MCP server (Streamable HTTP, JSON responses only) at
// POST /mcp/{token}. serverInfo.name is "board", so Claude names the tools mcp__board__<tool>.

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

// ServeMCP serves POST /mcp/{token}.
func (r *Relay) ServeMCP(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	token := req.PathValue("token")
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
		}
		json.Unmarshal(rq.Params, &p)
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
