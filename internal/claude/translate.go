package claude

import (
	"strings"

	"ai-whiteboard/internal/agent"
)

// translate maps one Claude stream-json line (other than control lines) to agent events.
// It keeps per-message state on p and is only called from the read loop.
func (p *proc) translate(m map[string]any) []agent.Event {
	if m["parent_tool_use_id"] != nil {
		return nil // subagent chatter
	}
	if p.streamed == nil {
		p.streamed = map[string]bool{}
	}
	if p.blocks == nil {
		p.blocks = map[int]string{}
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
		var evs []agent.Event
		for _, c := range list(msg["content"]) {
			b := obj(c)
			switch b["type"] {
			case "tool_use":
				evs = append(evs, agent.Event{Kind: agent.EvToolInput, ToolID: str(b["id"]),
					ToolName: str(b["name"]), Input: rawJSON(b["input"])})
			case "text":
				if t := str(b["text"]); t != "" && !p.streamed[id] {
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
		win := 0
		for _, u := range obj(m["modelUsage"]) {
			win = max(win, int(num(obj(u)["contextWindow"])))
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
