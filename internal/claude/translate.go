package claude

import (
	"strings"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// translate maps one Claude stream-json line (other than control lines) to agent events.
// It keeps per-message state on p and is only called from the read loop.
func (p *proc) translate(m map[string]any) []agent.Event {
	p.initMaps()
	if m["type"] == "system" {
		switch m["subtype"] {
		case "task_started", "task_progress", "task_updated", "task_notification":
			return p.taskEvent(m)
		case "init":
			p.model = str(m["model"])
			return nil
		}
	}
	if pid := str(m["parent_tool_use_id"]); pid != "" {
		return p.subLine(pid, m)
	}
	switch m["type"] {
	case "system":
		switch m["subtype"] {
		case "status":
			if m["status"] == "requesting" {
				return []agent.Event{{Kind: agent.EvThinking}}
			}
		case "permission_denied":
			return []agent.Event{{Kind: agent.EvToolDenied, ToolID: str(m["tool_use_id"])}}
		}
	case "stream_event":
		return p.streamEvent(obj(m["event"]))
	case "assistant":
		msg := obj(m["message"])
		id := str(msg["id"])
		// An API error is the CLI's own message, not text the model wrote: the errored result that
		// follows carries the same text. The CLI's mark decides, not the "<synthetic>" model name,
		// which its other locally written messages have too.
		apiErr, _ := m["is_api_error_message"].(bool)
		var evs []agent.Event
		for _, c := range list(msg["content"]) {
			b := obj(c)
			switch b["type"] {
			case "tool_use":
				evs = append(evs, agent.Event{Kind: agent.EvToolInput, ToolID: str(b["id"]),
					ToolName: str(b["name"]), Input: rawJSON(b["input"])})
			case "text":
				if t := str(b["text"]); t != "" && !p.streamed[id] && !apiErr {
					evs = append(evs, agent.Event{Kind: agent.EvText, MsgID: id, Text: t})
				}
			}
		}
		return evs
	case "user":
		var evs []agent.Event
		for _, c := range list(obj(m["message"])["content"]) {
			b := obj(c)
			if b["type"] != "tool_result" {
				continue
			}
			isErr, _ := b["is_error"].(bool)
			evs = append(evs, agent.Event{Kind: agent.EvToolResult, ToolID: str(b["tool_use_id"]),
				Result: resultText(b["content"]), IsError: isErr})
		}
		return evs
	case "result":
		orphan := p.orphan
		p.orphan = false
		if orphan && num(m["num_turns"]) == 0 {
			return nil // the empty result a resume sends after reporting a lost agent
		}
		// The chat's window is the parent model's; 0 (unchanged) when that is unknown.
		usage := obj(m["modelUsage"])
		for id, u := range usage {
			if w := int(num(obj(u)["contextWindow"])); w > 0 {
				p.windows[id] = w
			}
		}
		win := int(num(obj(usage[p.model])["contextWindow"]))
		if win == 0 && len(usage) == 1 {
			for _, u := range usage {
				win = int(num(obj(u)["contextWindow"]))
			}
		}
		aborted := m["terminal_reason"] == "aborted_streaming"
		isErr, _ := m["is_error"].(bool)
		errText := ""
		if isErr && !aborted {
			errText = str(m["result"])
			if errText == "" {
				reason := str(m["terminal_reason"])
				if reason == "" {
					reason = "unknown"
				}
				errText = "Error: " + reason
			}
		}
		return []agent.Event{
			{Kind: agent.EvUsage, CtxWindow: win},
			{Kind: agent.EvTurnEnd, Aborted: aborted, Error: errText},
		}
	}
	return nil
}

// taskEvent maps a system/task_* line of a subagent (task_type local_agent) to EvSub. Lines of
// other task types (a subagent's Bash commands, local_bash) and of unknown tasks give nothing.
func (p *proc) taskEvent(m map[string]any) []agent.Event {
	id := str(m["task_id"])
	if m["subtype"] == "task_started" {
		tool := str(m["tool_use_id"])
		if m["task_type"] != "local_agent" || id == "" || tool == "" {
			return nil
		}
		p.taskTool[id] = tool
		bg, _ := m["is_backgrounded"].(bool)
		return []agent.Event{{Kind: agent.EvSub, Sub: tool, SubInfo: &agent.SubInfo{
			ID: id, Type: str(m["subagent_type"]), Description: str(m["description"]),
			Prompt: str(m["prompt"]), Background: &bg, Status: model.SubRunning}}}
	}
	tool, ok := p.taskTool[id]
	if !ok {
		if m["subtype"] == "task_notification" && id != "" && (m["task_type"] == nil || m["task_type"] == "local_agent") {
			p.orphan = true // an agent lost with an earlier process, reported after --resume
		}
		return nil
	}
	info := &agent.SubInfo{Window: p.windowFor(p.subModel[tool])}
	switch m["subtype"] {
	case "task_progress":
		u := obj(m["usage"])
		info.Progress = str(m["summary"])
		info.Tokens, info.ToolUses = int(num(u["total_tokens"])), int(num(u["tool_uses"]))
	case "task_updated":
		patch := obj(m["patch"])
		info.Status, info.Error = claudeStatus(str(patch["status"])), str(patch["error"])
		if b, ok := patch["is_backgrounded"].(bool); ok {
			info.Background = &b
		}
	case "task_notification":
		u := obj(m["usage"])
		info.Status, info.Summary = claudeStatus(str(m["status"])), str(m["summary"])
		info.Tokens, info.ToolUses = int(num(u["total_tokens"])), int(num(u["tool_uses"]))
	}
	return []agent.Event{{Kind: agent.EvSub, Sub: tool, SubInfo: info}}
}

// claudeStatus maps a task status to a final SubStatus; "" for any other value (running, pending).
func claudeStatus(s string) model.SubStatus {
	switch s {
	case "completed":
		return model.SubCompleted
	case "failed":
		return model.SubFailed
	case "killed", "stopped":
		return model.SubStopped
	}
	return ""
}

// subLine maps a line of a subagent's own conversation (parent_tool_use_id = tool) to that
// subagent's events. Its messages come whole (never as stream_event), so text is EvText. Its first
// prompt (a user text message) is skipped: task_started carries it.
func (p *proc) subLine(tool string, m map[string]any) []agent.Event {
	switch m["type"] {
	case "assistant":
		msg := obj(m["message"])
		info := agent.SubInfo{}
		if mod := str(msg["model"]); mod != "" && mod != "<synthetic>" {
			p.subModel[tool], info.Model = mod, mod
		}
		if u, ok := msg["usage"].(map[string]any); ok { // output_tokens here is a first-chunk snapshot: not used
			info.Tokens = int(num(u["input_tokens"]) + num(u["cache_creation_input_tokens"]) + num(u["cache_read_input_tokens"]))
		}
		info.Window = p.windowFor(p.subModel[tool])
		var evs []agent.Event
		if info != (agent.SubInfo{}) {
			evs = append(evs, agent.Event{Kind: agent.EvSub, Sub: tool, SubInfo: &info})
		}
		id := str(msg["id"])
		for _, c := range list(msg["content"]) {
			b := obj(c)
			switch b["type"] {
			case "tool_use":
				evs = append(evs, agent.Event{Kind: agent.EvToolInput, Sub: tool, ToolID: str(b["id"]),
					ToolName: str(b["name"]), Input: rawJSON(b["input"])})
			case "text":
				if t := str(b["text"]); t != "" {
					evs = append(evs, agent.Event{Kind: agent.EvText, Sub: tool, MsgID: id, Text: t})
				}
			}
		}
		return evs
	case "user":
		var evs []agent.Event
		for _, c := range list(obj(m["message"])["content"]) {
			b := obj(c)
			if b["type"] == "tool_result" {
				isErr, _ := b["is_error"].(bool)
				evs = append(evs, agent.Event{Kind: agent.EvToolResult, Sub: tool, ToolID: str(b["tool_use_id"]),
					Result: resultText(b["content"]), IsError: isErr})
			}
		}
		return evs
	case "system":
		if m["subtype"] == "permission_denied" {
			return []agent.Event{{Kind: agent.EvToolDenied, Sub: tool, ToolID: str(m["tool_use_id"])}}
		}
	}
	return nil
}

// windowFor is a model's context window: from the last result's modelUsage, else from the built-in
// list by alias ("claude-haiku-4-5-…" contains "-haiku"), else 0.
func (p *proc) windowFor(id string) int {
	if id == "" {
		return 0
	}
	if w := p.windows[id]; w > 0 {
		return w
	}
	for _, c := range Catalog.Models {
		if strings.Contains(id, "-"+c.ID) {
			return c.ContextWindow
		}
	}
	return 0
}

// initMaps creates the translate state's maps that are still nil (tests build a bare &proc{}).
func (p *proc) initMaps() {
	if p.streamed == nil {
		p.streamed = map[string]bool{}
	}
	if p.blocks == nil {
		p.blocks = map[int]string{}
	}
	if p.taskTool == nil {
		p.taskTool = map[string]string{}
	}
	if p.subModel == nil {
		p.subModel = map[string]string{}
	}
	if p.windows == nil {
		p.windows = map[string]int{}
	}
}

func (p *proc) streamEvent(e map[string]any) []agent.Event {
	switch e["type"] {
	case "message_start":
		msg := obj(e["message"])
		p.curMsg = str(msg["id"])
		if p.curMsg != "" {
			p.streamed[p.curMsg] = true
		}
		p.blocks = map[int]string{}
		if u, ok := msg["usage"].(map[string]any); ok {
			in := num(u["input_tokens"]) + num(u["cache_creation_input_tokens"]) + num(u["cache_read_input_tokens"])
			return []agent.Event{{Kind: agent.EvUsage, CtxIn: int(in), CtxOut: int(num(u["output_tokens"]))}}
		}
	case "message_delta":
		if out := int(num(obj(e["usage"])["output_tokens"])); out != 0 {
			return []agent.Event{{Kind: agent.EvUsage, CtxOut: out}}
		}
	case "content_block_start":
		idx := int(num(e["index"]))
		b := obj(e["content_block"])
		switch b["type"] {
		case "text":
			p.blocks[idx] = "text"
			evs := []agent.Event{{Kind: agent.EvTextStart, MsgID: p.curMsg}}
			if t := str(b["text"]); t != "" {
				evs = append(evs, agent.Event{Kind: agent.EvTextDelta, Text: t})
			}
			return evs
		case "tool_use":
			id := str(b["id"])
			p.blocks[idx] = id
			return []agent.Event{{Kind: agent.EvToolStart, ToolID: id, ToolName: str(b["name"])}}
		case "thinking":
			return []agent.Event{{Kind: agent.EvThinking}}
		}
	case "content_block_delta":
		d := obj(e["delta"])
		switch d["type"] {
		case "text_delta":
			return []agent.Event{{Kind: agent.EvTextDelta, Text: str(d["text"])}}
		case "input_json_delta":
			id := p.blocks[int(num(e["index"]))]
			if id == "" || id == "text" {
				return nil
			}
			return []agent.Event{{Kind: agent.EvToolInputDelta, ToolID: id, Text: str(d["partial_json"])}}
		}
	}
	return nil
}

// resultText is a tool_result's content as text: a string, or the text parts of a block list.
func resultText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	var sb strings.Builder
	for _, c := range list(v) {
		sb.WriteString(str(obj(c)["text"]))
	}
	return sb.String()
}

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func list(v any) []any         { l, _ := v.([]any); return l }
func str(v any) string         { s, _ := v.(string); return s }
func num(v any) float64        { f, _ := v.(float64); return f }
