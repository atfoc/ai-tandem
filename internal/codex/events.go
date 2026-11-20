package codex

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

type usageTokens struct {
	InputTokens, OutputTokens, CachedInputTokens, CacheWriteInputTokens int
}

type usageUpdate struct {
	ThreadID, TurnID string
	Usage            *struct {
		Last, Total        usageTokens
		ModelContextWindow int
	} `json:"tokenUsage"`
}

func (u usageUpdate) event() agent.Event {
	return agent.Event{Kind: agent.EvUsage, CtxIn: u.Usage.Last.InputTokens,
		CtxOut: u.Usage.Last.OutputTokens, CtxWindow: u.Usage.ModelContextWindow}
}

func (p *proc) onUsage(raw json.RawMessage) {
	var u usageUpdate
	if json.Unmarshal(raw, &u) != nil || u.Usage == nil {
		return
	}
	p.mu.Lock()
	if p.threadID == "" {
		// Resume can report usage before dispatching its response.
		p.pendingUsage = &u
		p.mu.Unlock()
		return
	}
	if u.ThreadID != p.threadID {
		p.mu.Unlock()
		return
	}
	if p.active != nil && p.active.id == u.TurnID && u.TurnID != "" {
		p.tokens = u.Usage.Total
		p.hasTokens = true
	}
	p.mu.Unlock()
	p.emit(u.event())
}

type itemState struct {
	text  strings.Builder
	input json.RawMessage
}

type fileChange struct {
	Path, Diff string
	Kind       struct{ Type string }
}

type toolItem struct {
	ID, Type, Status, ClientID      string
	Text, Command, AggregatedOutput string
	Path, Cwd, Server, Tool, Query  string
	ExitCode                        int
	Changes                         []fileChange
	Arguments                       json.RawMessage
	Result                          struct {
		Content []struct{ Type, Text string }
		IsError bool
	}
	Error   *struct{ Message string }
	Success *bool
}

func (p *proc) onNotification(method string, raw json.RawMessage) {
	if method == "thread/tokenUsage/updated" {
		p.onUsage(raw)
		return
	}
	var msg struct {
		ThreadID, TurnID, ItemID, Delta string
		RequestID                       json.RawMessage
		Item                            toolItem
		Changes                         []fileChange

		Turn struct {
			ID, Status string
			Error      *struct {
				Message           string
				AdditionalDetails string
				CodexErrorInfo    json.RawMessage
			}
		}
	}
	if json.Unmarshal(raw, &msg) != nil {
		return
	}
	p.mu.Lock()
	t := p.active
	if t == nil || msg.ThreadID != p.threadID ||
		(t.id != "" && msg.TurnID != "" && t.id != msg.TurnID) {
		p.mu.Unlock()
		return
	}
	switch method {
	case "turn/started":
		p.hasTokens = false
		if t.id == "" && msg.Turn.ID != "" {
			t.id = msg.Turn.ID
			close(t.ready)
		}
	case "turn/completed":
		if t.id != "" && t.id != msg.Turn.ID {
			p.mu.Unlock()
			return
		}
		if t.id == "" {
			close(t.ready)
		}
		p.active = nil
		clear(p.perm)
	case "serverRequest/resolved":
		delete(p.perm, string(msg.RequestID))
	}
	p.mu.Unlock()

	switch method {
	case "turn/started", "item/reasoning/summaryTextDelta":
		p.emit(agent.Event{Kind: agent.EvThinking})
	case "item/started":
		p.startItem(msg.Item)
	case "item/agentMessage/delta":
		p.textDelta(msg.ItemID, msg.Delta)
	case "item/completed":
		if msg.Item.Type == "userMessage" && msg.Item.ClientID != "" {
			p.emit(agent.Event{Kind: agent.EvSteerConsumed, MsgID: msg.Item.ClientID})
		}
		p.finishItem(msg.Item)
	case "item/fileChange/patchUpdated":
		if len(msg.Changes) != 0 {
			p.emit(agent.Event{Kind: agent.EvToolInput, ToolID: msg.ItemID, ToolName: "Edit", Input: editInput(msg.Changes)})
		}
	case "turn/completed":
		clear(p.items)
		ev := agent.Event{Kind: agent.EvTurnEnd, Point: msg.Turn.ID, Aborted: msg.Turn.Status == "interrupted"}
		if msg.Turn.Error != nil && !ev.Aborted {
			ev.Error = p.redact(turnErrorText(msg.Turn.Error.Message, msg.Turn.Error.AdditionalDetails))
			ev.Temporary = temporaryError(msg.Turn.Error.CodexErrorInfo)
		} else if msg.Turn.Status == "failed" {
			ev.Error = "Codex turn failed."
		}
		if p.hasTokens {
			u := p.tokens
			ev.HasTokens = true
			ev.CumOutTokens = u.OutputTokens
			ev.CumTokens = model.TokenCount{
				In:  int64(max(0, u.InputTokens-u.CachedInputTokens-u.CacheWriteInputTokens)),
				Out: int64(u.OutputTokens), CacheRead: int64(u.CachedInputTokens), CacheWrite: int64(u.CacheWriteInputTokens),
			}
		}
		p.emit(ev)
	}
}

// turnErrorText keeps Codex's `additionalDetails` (the underlying cause, such as an HTTP status
// and URL behind "stream disconnected") instead of dropping it, unless the message already says it.
func turnErrorText(message, details string) string {
	details = strings.TrimSpace(details)
	if details == "" || strings.Contains(message, details) {
		return message
	}
	return message + ": " + details
}

func temporaryError(info json.RawMessage) agent.Temporary {
	var kind string
	if json.Unmarshal(info, &kind) != nil {
		return connectionError(info)
	}
	switch kind {
	case "unauthorized":
		return agent.TempLogin
	case "usageLimitExceeded", "rateLimitExceeded":
		return agent.TempRate
	case "serverOverloaded", "flexUnavailable":
		return agent.TempOverloaded
	case "internalServerError":
		return agent.TempServer
	default:
		return ""
	}
}

// Network errors are tagged objects rather than strings on the App Server wire.
func connectionError(info json.RawMessage) agent.Temporary {
	var errorKinds map[string]struct{ HTTPStatusCode int }
	if json.Unmarshal(info, &errorKinds) != nil {
		return ""
	}
	for _, kind := range []string{"httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"} {
		e, ok := errorKinds[kind]
		if !ok {
			continue
		}
		switch {
		case e.HTTPStatusCode == 401:
			return agent.TempLogin
		case e.HTTPStatusCode == 429:
			return agent.TempRate
		case e.HTTPStatusCode == 0 || e.HTTPStatusCode == 408 || e.HTTPStatusCode >= 500:
			return agent.TempServer
		}
	}
	return ""
}

func (p *proc) textDelta(id, delta string) {
	st := p.items[id]
	if st == nil {
		st = &itemState{}
		p.items[id] = st
	}
	if st.text.Len() == 0 && delta != "" {
		p.emit(agent.Event{Kind: agent.EvTextStart, MsgID: id})
	}
	if delta != "" {
		st.text.WriteString(delta)
		p.emit(agent.Event{Kind: agent.EvTextDelta, MsgID: id, Text: delta})
	}
}

func (p *proc) startItem(item toolItem) {
	name, input := item.toolInput()
	if name == "" || item.ID == "" || p.items[item.ID] != nil {
		return
	}
	p.items[item.ID] = &itemState{input: input}
	p.emit(agent.Event{Kind: agent.EvToolStart, ToolID: item.ID, ToolName: name, Input: input})
}

func (p *proc) finishItem(item toolItem) {
	if item.ID == "" {
		return
	}
	if item.Type == "agentMessage" {
		st := p.items[item.ID]
		if st == nil && item.Text != "" {
			p.emit(agent.Event{Kind: agent.EvText, MsgID: item.ID, Text: item.Text})
		} else if st != nil && st.text.Len() > 0 {
			if suffix, ok := strings.CutPrefix(item.Text, st.text.String()); ok && suffix != "" {
				p.emit(agent.Event{Kind: agent.EvTextDelta, MsgID: item.ID, Text: suffix})
			}
		}
		delete(p.items, item.ID)
		return
	}
	name, input := item.toolInput()
	if name == "" {
		return
	}
	p.startItem(item)
	p.emit(agent.Event{Kind: agent.EvToolInput, ToolID: item.ID, ToolName: name, Input: input})
	denied := item.Status == "declined"
	if denied {
		p.emit(agent.Event{Kind: agent.EvToolDenied, ToolID: item.ID})
	}
	result, failed := item.toolResult()
	p.emit(agent.Event{Kind: agent.EvToolResult, ToolID: item.ID, Result: p.redact(result), IsError: failed || denied})
	delete(p.items, item.ID)
}

func (item toolItem) toolInput() (string, json.RawMessage) {
	switch item.Type {
	case "commandExecution":
		return "Bash", toolJSON(map[string]string{"command": item.Command, "cwd": item.Cwd})
	case "fileChange":
		return "Edit", editInput(item.Changes)
	case "mcpToolCall":
		return "mcp__" + item.Server + "__" + item.Tool, item.Arguments
	case "dynamicToolCall":
		return item.Tool, item.Arguments
	case "webSearch":
		return "WebSearch", toolJSON(map[string]string{"query": item.Query})
	case "imageView":
		return "Read", toolJSON(map[string]string{"file_path": item.Path})
	case "contextCompaction":
		return "Context compaction", nil
	default:
		return "", nil
	}
}

func toolJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func editInput(changes []fileChange) json.RawMessage {
	if len(changes) != 1 {
		fields := make([]map[string]string, 0, len(changes))
		for _, c := range changes {
			fields = append(fields, map[string]string{"path": c.Path, "diff": c.Diff})
		}
		return toolJSON(map[string]any{"changes": fields})
	}
	c := changes[0]
	var old, new strings.Builder
	if c.Kind.Type == "add" {
		new.WriteString(c.Diff)
	} else if c.Kind.Type == "delete" {
		old.WriteString(c.Diff)
	} else {
		for line := range strings.SplitSeq(c.Diff, "\n") {
			switch {
			case strings.HasPrefix(line, "+++ "), strings.HasPrefix(line, "--- "):
			case strings.HasPrefix(line, "-"):
				old.WriteString(line[1:] + "\n")
			case strings.HasPrefix(line, "+"):
				new.WriteString(line[1:] + "\n")
			case strings.HasPrefix(line, " "):
				old.WriteString(line[1:] + "\n")
				new.WriteString(line[1:] + "\n")
			}
		}
	}
	return toolJSON(map[string]string{"file_path": c.Path, "old_string": old.String(), "new_string": new.String()})
}

func (item toolItem) toolResult() (string, bool) {
	failed := item.Status == "failed" || item.ExitCode != 0 || (item.Success != nil && !*item.Success)
	if item.Error != nil {
		return item.Error.Message, true
	}
	if item.Type == "mcpToolCall" {
		var parts []string
		for _, content := range item.Result.Content {
			if content.Type == "text" {
				parts = append(parts, content.Text)
			}
		}
		return strings.Join(parts, "\n"), failed || item.Result.IsError
	}
	return item.AggregatedOutput, failed
}

type approval struct {
	id          json.RawMessage
	allow, deny any
}

func (p *proc) onRequest(id json.RawMessage, method string, raw json.RawMessage) {
	var req struct {
		ThreadID, TurnID, ItemID, Command, Reason, Cwd, GrantRoot string
		NetworkApprovalContext                                    *struct{ Host string }
		AdditionalPermissions                                     json.RawMessage
		Permissions                                               json.RawMessage
		AvailableDecisions                                        []json.RawMessage
		Mode, ServerName, Message                                 string
		RequestedSchema                                           struct {
			Type       string
			Properties map[string]json.RawMessage
			Required   []string
		}
		MCPApproval struct {
			Kind    string          `json:"codex_approval_kind"`
			Tool    string          `json:"tool_name"`
			Args    json.RawMessage `json:"tool_params"`
			Persist json.RawMessage `json:"persist"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		_ = p.conn.reply(id, nil, &rpcError{Code: -32602, Message: "invalid approval request"})
		return
	}
	a := approval{id: id, allow: map[string]string{"decision": "accept"}, deny: map[string]string{"decision": "decline"}}
	var name string
	var input json.RawMessage
	switch method {
	case "item/commandExecution/requestApproval":
		name = "Bash"
		args := map[string]string{}
		if st := p.items[req.ItemID]; st != nil {
			_ = json.Unmarshal(st.input, &args)
		}
		if req.Command != "" {
			args["command"] = req.Command
		}
		if req.Cwd != "" {
			args["cwd"] = req.Cwd
		}
		args["description"] = "Codex requests command approval."
		if req.Reason != "" {
			args["description"] += " " + req.Reason
		}
		if req.NetworkApprovalContext != nil {
			args["description"] += " Network host: " + req.NetworkApprovalContext.Host
		}
		if len(req.AdditionalPermissions) != 0 && string(req.AdditionalPermissions) != "null" {
			args["description"] += " Additional permissions: " + string(req.AdditionalPermissions)
		}
		input = toolJSON(args)
		if len(req.AvailableDecisions) > 0 {
			if !hasDecision(req.AvailableDecisions, "accept") {
				a.allow = nil // the UI only represents a one-time approval
			}
			if !hasDecision(req.AvailableDecisions, "decline") {
				a.deny = map[string]string{"decision": "cancel"}
			}
		}
	case "item/fileChange/requestApproval":
		name = "Edit"
		args := struct {
			FilePath string `json:"file_path"`
		}{}
		if st := p.items[req.ItemID]; st != nil {
			_ = json.Unmarshal(st.input, &args)
		}
		if req.GrantRoot != "" {
			args.FilePath = req.GrantRoot
		}
		input = toolJSON(map[string]string{"description": req.Reason, "file_path": args.FilePath})
	case "item/permissions/requestApproval":
		name = "request_permissions"
		input = toolJSON(map[string]string{"description": req.Reason + " Requested permissions: " + string(req.Permissions)})
		a.allow = map[string]any{"scope": "turn", "permissions": req.Permissions}
		a.deny = map[string]any{"scope": "turn", "permissions": map[string]any{}}
	case "mcpServer/elicitation/request":
		// Codex uses an empty form for a tool approval. Other elicitations
		// can require form data, authentication, or a URL flow.
		if req.Mode != "form" || req.MCPApproval.Kind != "mcp_tool_call" ||
			req.ServerName == "" || req.MCPApproval.Tool == "" || req.RequestedSchema.Type != "object" ||
			len(req.RequestedSchema.Properties) != 0 || len(req.RequestedSchema.Required) != 0 {
			_ = p.conn.reply(id, nil, &rpcError{Code: -32601, Message: "unsupported Codex MCP elicitation"})
			return
		}
		name = "mcp__" + req.ServerName + "__" + req.MCPApproval.Tool
		description := req.Message
		if len(req.MCPApproval.Args) > 0 && string(req.MCPApproval.Args) != "null" {
			description += "\n" + string(req.MCPApproval.Args)
		}
		accept := map[string]any{"action": "accept", "content": map[string]any{}}
		if req.ServerName == "board" && req.MCPApproval.Tool == "spawn_subagent" &&
			p.opts.MCP != nil && p.opts.MCP.MCPURL != "" && !p.opts.Subagent && !p.opts.NoSpawn &&
			gitWorkerSpawn(req.MCPApproval.Args) && offersSessionApproval(req.MCPApproval.Persist) {
			description = "Allow this Git worker and future subagent spawns from this Codex session.\n" + description
			accept["_meta"] = map[string]string{"persist": "session"}
		}
		input = toolJSON(map[string]string{"description": description})
		a.allow = accept
		a.deny = map[string]any{"action": "decline", "content": nil}
	default:
		_ = p.conn.reply(id, nil, &rpcError{Code: -32601, Message: "unsupported Codex request: " + method})
		return
	}
	p.mu.Lock()
	if p.active == nil || req.ThreadID != p.threadID || a.allow == nil ||
		(p.active.id != "" && req.TurnID != "" && req.TurnID != p.active.id) {
		p.mu.Unlock()
		_ = p.conn.reply(id, a.deny, nil)
		return
	}
	key := string(id)
	p.perm[key] = a
	p.mu.Unlock()
	p.emit(agent.Event{Kind: agent.EvPermRequest, ToolID: req.ItemID, ToolName: name, PermID: key, Input: json.RawMessage(p.redact(string(input)))})
}

func gitWorkerSpawn(raw json.RawMessage) bool {
	var args struct {
		Agent model.AgentKind
		Git   bool
	}
	return json.Unmarshal(raw, &args) == nil && args.Git && (args.Agent == "" || args.Agent == model.Codex)
}

func offersSessionApproval(raw json.RawMessage) bool {
	if string(raw) == `"session"` {
		return true
	}
	var choices []string
	return json.Unmarshal(raw, &choices) == nil && slices.Contains(choices, "session")
}

func hasDecision(choices []json.RawMessage, decision string) bool {
	for _, choice := range choices {
		if string(choice) == fmt.Sprintf("%q", decision) {
			return true
		}
	}
	return false
}

func (p *proc) Decide(id string, allow bool) error {
	p.mu.Lock()
	a, ok := p.perm[id]
	delete(p.perm, id)
	p.mu.Unlock()
	if !ok {
		return errors.New("Codex approval request is no longer pending")
	}
	result := a.deny
	if allow {
		result = a.allow
	}
	return p.conn.reply(a.id, result, nil)
}
