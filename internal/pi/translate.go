package pi

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"

	"ai-whiteboard/internal/agent"
)

// translate maps one pi RPC event line to agent events. It touches only the read-loop's own
// state and returns the events; the read loop emits them (and announces tool starts).
//
// Event table (pi 0.85.1):
//
//	agent_start / turn_start / turn_end      no event
//	message_start (role assistant)           bumps the per-message id sequence
//	message_update.text_start                EvTextStart (MsgID "m<message>-<contentIndex>")
//	message_update.text_delta                EvTextDelta
//	message_update.thinking_*                EvThinking
//	message_update.toolcall_start            EvToolStart
//	message_update.toolcall_delta            EvToolInputDelta (id by contentIndex)
//	message_update.toolcall_end              EvToolInput (deduped per toolCallId)
//	tool_execution_start                     EvToolStart / EvToolInput when not already emitted
//	tool_execution_update                    subagent tool: EvSub progress; never tool input
//	tool_execution_end                       EvToolResult
//	message_end (role assistant)             EvUsage (input + cache read/write, output, window)
//	agent_settled                            get_session_stats → EvUsage + EvTurnEnd (the idle signal)
//	extension_error                          logged once
//	compaction_*, auto_retry_*,              ignored, like every unknown type, so a newer pi
//	summarization_retry_*, queue_update,     cannot break the stream
//	bash_execution_update, session_info_changed, thinking_level_changed,
//	entry_appended, extension_ui_request, …
func (p *proc) translate(m map[string]any) []agent.Event {
	p.initMaps()
	switch str(m["type"]) {
	case "message_start":
		if str(obj(m["message"])["role"]) == "assistant" {
			p.msgSeq++
		}
		return nil

	case "message_update":
		return p.messageUpdate(obj(m["assistantMessageEvent"]))

	case "tool_execution_start":
		return p.toolExecutionStart(m)

	case "tool_execution_update":
		return p.toolExecutionUpdate(m)

	case "tool_execution_end":
		isErr, _ := m["isError"].(bool)
		return []agent.Event{{Kind: agent.EvToolResult, ToolID: str(m["toolCallId"]),
			Result: contentText(obj(m["result"])["content"]), IsError: isErr}}

	case "message_end":
		msg := obj(m["message"])
		if str(msg["role"]) != "assistant" {
			return nil
		}
		u := obj(msg["usage"])
		in := int(num(u["input"]) + num(u["cacheRead"]) + num(u["cacheWrite"]))
		return []agent.Event{{Kind: agent.EvUsage, CtxIn: in, CtxOut: int(num(u["output"])),
			CtxWindow: int(p.modelWindow.Load())}}

	case "agent_settled":
		p.onSettled()
		return nil

	case "extension_error":
		p.extErrOnce.Do(func() {
			log.Printf("pi extension error: %s (%s): %s", str(m["extensionPath"]), str(m["event"]), str(m["error"]))
		})
		return nil
	}
	return nil
}

// messageUpdate maps one streamed assistant-message event.
func (p *proc) messageUpdate(e map[string]any) []agent.Event {
	idx := int(num(e["contentIndex"]))
	switch str(e["type"]) {
	case "text_start":
		return []agent.Event{{Kind: agent.EvTextStart, MsgID: fmt.Sprintf("m%d-%d", p.msgSeq, idx)}}
	case "text_delta":
		return []agent.Event{{Kind: agent.EvTextDelta, Text: str(e["delta"])}}
	case "thinking_start", "thinking_delta", "thinking_end":
		return []agent.Event{{Kind: agent.EvThinking}}
	case "toolcall_start":
		id, name := str(e["id"]), normalize(str(e["toolName"]))
		if id == "" {
			return nil
		}
		p.toolByIndex[idx] = id
		st := p.toolState(id)
		if st.start { // tool_execution_start beat the stream to it
			return nil
		}
		st.start = true
		return []agent.Event{{Kind: agent.EvToolStart, ToolID: id, ToolName: name}}
	case "toolcall_delta":
		id := p.toolByIndex[idx]
		if id == "" {
			return nil
		}
		return []agent.Event{{Kind: agent.EvToolInputDelta, ToolID: id, Text: str(e["delta"])}}
	case "toolcall_end":
		tc := obj(e["toolCall"])
		id := str(tc["id"])
		if id == "" {
			id = p.toolByIndex[idx]
		}
		if id == "" {
			return nil
		}
		name := normalize(str(tc["name"]))
		input := rawJSON(tc["arguments"])
		st := p.toolState(id)
		var evs []agent.Event
		if !st.start { // toolcall_start should have; a bare toolcall_end still makes the card
			st.start = true
			evs = append(evs, agent.Event{Kind: agent.EvToolStart, ToolID: id, ToolName: name})
		}
		if !st.input {
			st.input = true
			evs = append(evs, agent.Event{Kind: agent.EvToolInput, ToolID: id, ToolName: name, Input: input})
		}
		return evs
	}
	return nil
}

// toolExecutionStart reports a tool that is about to run. The toolcall_* stream usually reported
// it first, so each part is emitted only once per tool call id.
func (p *proc) toolExecutionStart(m map[string]any) []agent.Event {
	id := str(m["toolCallId"])
	if id == "" {
		return nil
	}
	name := normalize(str(m["toolName"]))
	args := rawJSON(m["args"])
	st := p.toolState(id)
	var evs []agent.Event
	if !st.start {
		st.start = true
		evs = append(evs, agent.Event{Kind: agent.EvToolStart, ToolID: id, ToolName: name})
	}
	if !st.input && len(args) > 0 {
		st.input = true // the args are already the final input
		evs = append(evs, agent.Event{Kind: agent.EvToolInput, ToolID: id, ToolName: name, Input: args})
	}
	return evs
}

// toolExecutionUpdate carries accumulated execution progress, not input. Only the app subagent
// tool has a useful signal here: its bounded progress text patches the subagent row. Everything
// else is ignored; it is never appended as tool input.
func (p *proc) toolExecutionUpdate(m map[string]any) []agent.Event {
	if str(m["toolName"]) != "subagent" {
		return nil
	}
	id := str(m["toolCallId"])
	if id == "" {
		return nil
	}
	text := contentText(obj(m["partialResult"])["content"])
	if text == "" {
		return nil
	}
	return []agent.Event{{Kind: agent.EvSub, Sub: id, SubInfo: &agent.SubInfo{Progress: boundProgress(text)}}}
}

// onSettled is pi's idle signal. It asks for the session stats without blocking the read loop;
// the response emits the context numbers and the turn end.
func (p *proc) onSettled() {
	aborted := p.takeAbort()
	if p.rpc == nil {
		p.emit(agent.Event{Kind: agent.EvTurnEnd, Aborted: aborted})
		return
	}
	err := p.rpc.expect("get_session_stats", nil, func(resp rpcResponse) {
		p.emitStatsTurnEnd(resp, aborted)
	})
	if err != nil { // the command could not even be written: the turn still ends
		p.emit(agent.Event{Kind: agent.EvTurnEnd, Aborted: aborted})
	}
}

// emitStatsTurnEnd emits the context usage get_session_stats reported (when it has numbers) and
// then, always, the turn end.
func (p *proc) emitStatsTurnEnd(resp rpcResponse, aborted bool) {
	if resp.Success {
		var stats struct {
			ContextUsage *struct {
				Tokens        *int `json:"tokens"`
				ContextWindow int  `json:"contextWindow"`
			} `json:"contextUsage"`
		}
		if json.Unmarshal(resp.Data, &stats) == nil && stats.ContextUsage != nil && stats.ContextUsage.Tokens != nil {
			ev := agent.Event{Kind: agent.EvUsage, CtxIn: *stats.ContextUsage.Tokens, CtxWindow: stats.ContextUsage.ContextWindow}
			if ev.CtxIn != 0 || ev.CtxWindow != 0 {
				p.emit(ev)
			}
		}
	}
	p.emit(agent.Event{Kind: agent.EvTurnEnd, Aborted: aborted})
}

// translateLine is the RPC read loop's event callback: it decodes one wire line, translates it
// and emits the result (announcing tool starts for the subagent ordering fix).
func (p *proc) translateLine(line []byte) {
	var m map[string]any
	if json.Unmarshal(line, &m) != nil {
		return
	}
	p.emitEvents(p.translate(m))
}

// normalize is the display name of a pi tool: the app subagent tool becomes Agent, everything
// else keeps its name. Board tools arrive from pi already namespaced (mcp__board__*), so they
// pass through unchanged; raw native board names are no longer rewritten.
func normalize(name string) string {
	if name == "subagent" {
		return "Agent"
	}
	return name
}

// contentText joins the text parts of a content list (pi's TextContent blocks).
func contentText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	var sb strings.Builder
	for _, c := range list(v) {
		sb.WriteString(str(obj(c)["text"]))
	}
	return sb.String()
}

// initMaps creates the translate state's maps that are still nil (tests build a bare &proc{}).
func (p *proc) initMaps() {
	if p.toolByIndex == nil {
		p.toolByIndex = map[int]string{}
	}
	if p.toolEmit == nil {
		p.toolEmit = map[string]*toolEmit{}
	}
	if p.announced == nil {
		p.announced = map[string]bool{}
	}
}

// toolState is the per-tool-call emission record, created on first use.
func (p *proc) toolState(id string) *toolEmit {
	if p.toolEmit == nil {
		p.toolEmit = map[string]*toolEmit{}
	}
	st := p.toolEmit[id]
	if st == nil {
		st = &toolEmit{}
		p.toolEmit[id] = st
	}
	return st
}

func rawJSON(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return b
}

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func list(v any) []any         { l, _ := v.([]any); return l }
func str(v any) string         { s, _ := v.(string); return s }
func num(v any) float64        { f, _ := v.(float64); return f }
