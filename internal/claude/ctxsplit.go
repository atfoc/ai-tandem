package claude

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// get_context_usage is answered by the process without a model call: it counts the context
// locally and costs nothing. MCP tools are listed at once but counted (tokens > 0) only about 2 s
// after the start, so a process asked early is asked again until they are, for up to
// splitWait.
const (
	splitWait     = 10 * time.Second
	replyTimeout  = 10 * time.Second
	errCtxExited  = "claude exited before it answered"
	errCtxTimeout = "claude did not answer within %s"
)

// splitRetry is the pause before the process is asked again. A variable so that a test can shorten it.
var splitRetry = 300 * time.Millisecond

// controlReply is the "response" of a control_response line.
type controlReply struct {
	Subtype   string          `json:"subtype"`
	RequestID string          `json:"request_id"`
	Error     string          `json:"error"`
	Response  json.RawMessage `json:"response"`
}

// reply hands a control_response line to the request waiting for it, if any.
func (p *proc) reply(line []byte) {
	var m struct {
		Response controlReply `json:"response"`
	}
	if json.Unmarshal(line, &m) != nil {
		return
	}
	if ch, ok := p.replies.LoadAndDelete(m.Response.RequestID); ok {
		ch.(chan controlReply) <- m.Response
	}
}

// request sends a control request and waits for its answer, the process's exit or replyTimeout.
func (p *proc) request(subtype string) (json.RawMessage, error) {
	id := "ctx_" + randHex(4)
	ch := make(chan controlReply, 1)
	p.replies.Store(id, ch)
	defer p.replies.Delete(id)
	if err := p.write(map[string]any{"type": "control_request", "request_id": id,
		"request": map[string]any{"subtype": subtype}}); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		if r.Subtype == "error" {
			return nil, fmt.Errorf("claude %s: %s", subtype, r.Error)
		}
		return r.Response, nil
	case <-p.done:
		return nil, errors.New(errCtxExited)
	case <-time.After(replyTimeout):
		return nil, fmt.Errorf(errCtxTimeout, replyTimeout)
	}
}

// ContextSplit asks the process for its context split (get_context_usage), again until its MCP
// tools are counted or splitWait has passed.
func (p *proc) ContextSplit() (model.ContextSplit, error) {
	deadline := time.Now().Add(splitWait)
	for {
		raw, err := p.request("get_context_usage")
		if err != nil {
			return model.ContextSplit{}, err
		}
		s, counted, err := ParseContextUsage(raw)
		if err != nil || counted || time.Now().Add(splitRetry).After(deadline) {
			return s, err
		}
		time.Sleep(splitRetry)
	}
}

// ReadContextSplit starts a process on a fork of the chat's session (--fork-session: nothing is
// written to the session, and no new one is kept while nothing is sent), asks it for the context
// split and closes it. With o.Point the session is read up to that point only
// (--resume-session-at), as a fork made there is. It takes about 2 s.
func (s *Spawner) ReadContextSplit(o agent.SpawnOptions) (model.ContextSplit, error) {
	o.Resume = true
	extra := []string{"--fork-session"}
	if o.Point != "" {
		extra = append(extra, "--resume-session-at", o.Point)
	}
	p, err := s.start(o, extra...)
	if err != nil {
		return model.ContextSplit{}, err
	}
	go func() {
		for range p.events { // nothing is sent: only the exit and the catalog event the initialize answer yields, both drained
		}
	}()
	split, err := p.ContextSplit()
	p.Close()
	<-p.done
	if err != nil { // a session that cannot be resumed ends the process: say why
		if msg := firstLine(p.stderr.String()); msg != "" {
			err = fmt.Errorf("claude: %s", msg)
		}
	}
	return split, err
}

// usageAnswer is get_context_usage's answer (Claude Code 2.1). gridRows, the terminal's grid,
// is not read.
type usageAnswer struct {
	Categories []struct {
		Name       string `json:"name"`
		Tokens     int    `json:"tokens"`
		Kind       string `json:"kind"`
		IsDeferred bool   `json:"isDeferred"`
	} `json:"categories"`
	TotalTokens int    `json:"totalTokens"`
	MaxTokens   int    `json:"maxTokens"`
	Model       string `json:"model"`
	MemoryFiles []struct {
		Path   string `json:"path"`
		Type   string `json:"type"`
		Tokens int    `json:"tokens"`
	} `json:"memoryFiles"`
	MCPTools []struct {
		Name       string `json:"name"`
		ServerName string `json:"serverName"`
		Tokens     int    `json:"tokens"`
		IsLoaded   bool   `json:"isLoaded"`
	} `json:"mcpTools"`
	Agents []struct {
		AgentType string `json:"agentType"`
		Source    string `json:"source"`
		Tokens    int    `json:"tokens"`
	} `json:"agents"`
	SlashCommands *struct {
		TotalCommands    int `json:"totalCommands"`
		IncludedCommands int `json:"includedCommands"`
		Tokens           int `json:"tokens"`
	} `json:"slashCommands"`
	Skills *struct {
		TotalSkills      int `json:"totalSkills"`
		IncludedSkills   int `json:"includedSkills"`
		SkillFrontmatter []struct {
			Name   string `json:"name"`
			Source string `json:"source"`
			Tokens int    `json:"tokens"`
		} `json:"skillFrontmatter"`
	} `json:"skills"`
	AutoCompactThreshold int  `json:"autoCompactThreshold"`
	IsAutoCompactEnabled bool `json:"isAutoCompactEnabled"`
	MessageBreakdown     *struct {
		ToolCallTokens          int `json:"toolCallTokens"`
		ToolResultTokens        int `json:"toolResultTokens"`
		AttachmentTokens        int `json:"attachmentTokens"`
		AssistantMessageTokens  int `json:"assistantMessageTokens"`
		UserMessageTokens       int `json:"userMessageTokens"`
		RedirectedContextTokens int `json:"redirectedContextTokens"`
		UnattributedTokens      int `json:"unattributedTokens"`
		ToolCallsByType         []struct {
			Name         string `json:"name"`
			CallTokens   int    `json:"callTokens"`
			ResultTokens int    `json:"resultTokens"`
		} `json:"toolCallsByType"`
		AttachmentsByType []struct {
			Name   string `json:"name"`
			Tokens int    `json:"tokens"`
		} `json:"attachmentsByType"`
	} `json:"messageBreakdown"`
}

// ParseContextUsage turns get_context_usage's answer into a split: Claude's categories in its
// order, with the lists that belong to them as items and the messages broken into parts.
// counted is false while an MCP tool is still at 0 tokens (not counted yet).
func ParseContextUsage(raw json.RawMessage) (split model.ContextSplit, counted bool, err error) {
	var a usageAnswer
	if err := json.Unmarshal(raw, &a); err != nil {
		return model.ContextSplit{}, false, fmt.Errorf("claude get_context_usage: %w", err)
	}
	if len(a.Categories) == 0 {
		return model.ContextSplit{}, false, errors.New("claude get_context_usage: no categories in its answer")
	}
	counted = true
	var loaded, deferred []model.ContextItem
	for _, t := range a.MCPTools {
		counted = counted && t.Tokens > 0
		it := model.ContextItem{Name: t.Name, Tokens: t.Tokens, Note: t.ServerName}
		if t.IsLoaded {
			loaded = append(loaded, it)
		} else {
			deferred = append(deferred, it)
		}
	}
	split = model.ContextSplit{Total: a.TotalTokens, Window: a.MaxTokens, Categories: []model.ContextCategory{}}
	for _, c := range a.Categories {
		cat := model.ContextCategory{ID: snake(c.Name), Label: c.Name, Tokens: c.Tokens, Kind: c.Kind}
		switch {
		case c.IsDeferred:
			cat.Kind = "deferred"
		case cat.Kind == "":
			cat.Kind = "used"
		}
		switch c.Name {
		case "MCP tools":
			cat.Items = loaded
		case "MCP tools (deferred)":
			cat.Items = deferred
		case "Skills":
			if a.Skills != nil {
				for _, s := range a.Skills.SkillFrontmatter {
					cat.Items = append(cat.Items, model.ContextItem{Name: s.Name, Tokens: s.Tokens, Note: s.Source})
				}
			}
		case "Memory files":
			for _, f := range a.MemoryFiles {
				cat.Items = append(cat.Items, model.ContextItem{Name: f.Path, Tokens: f.Tokens, Note: f.Type})
			}
		case "Custom agents":
			for _, g := range a.Agents {
				cat.Items = append(cat.Items, model.ContextItem{Name: g.AgentType, Tokens: g.Tokens, Note: g.Source})
			}
		case "Messages":
			cat.Parts = messageParts(a)
		}
		split.Categories = append(split.Categories, cat)
	}
	if a.Model != "" {
		split.Facts = append(split.Facts, model.ContextFact{Label: "Model", Value: a.Model})
	}
	if a.IsAutoCompactEnabled && a.AutoCompactThreshold > 0 {
		split.Facts = append(split.Facts, model.ContextFact{Label: "Auto-compact", Value: "at " + commas(a.AutoCompactThreshold) + " tokens"})
	} else {
		split.Facts = append(split.Facts, model.ContextFact{Label: "Auto-compact", Value: "off"})
	}
	if s := a.Skills; s != nil {
		split.Facts = append(split.Facts, model.ContextFact{Label: "Skills listed", Value: fmt.Sprintf("%d of %d", s.IncludedSkills, s.TotalSkills)})
	}
	if c := a.SlashCommands; c != nil {
		split.Facts = append(split.Facts, model.ContextFact{Label: "Slash commands listed",
			Value: fmt.Sprintf("%d of %d · %s tokens", c.IncludedCommands, c.TotalCommands, commas(c.Tokens))})
	}
	return split, counted, nil
}

// messageParts is the Messages category broken down: the tool calls and results by tool, the
// attachments by type, the replies, the user's messages and what Claude could not place.
func messageParts(a usageAnswer) []model.ContextCategory {
	b := a.MessageBreakdown
	if b == nil {
		return nil
	}
	var calls, results, atts []model.ContextItem
	for _, t := range b.ToolCallsByType {
		calls = append(calls, model.ContextItem{Name: t.Name, Tokens: t.CallTokens})
		results = append(results, model.ContextItem{Name: t.Name, Tokens: t.ResultTokens})
	}
	for _, t := range b.AttachmentsByType {
		atts = append(atts, model.ContextItem{Name: t.Name, Tokens: t.Tokens})
	}
	part := func(id, label string, tokens int, items []model.ContextItem) model.ContextCategory {
		return model.ContextCategory{ID: id, Label: label, Tokens: tokens, Kind: "used", Items: items}
	}
	return []model.ContextCategory{
		part("tool_calls", "Tool calls", b.ToolCallTokens, calls),
		part("tool_results", "Tool results", b.ToolResultTokens, results),
		part("attachments", "Attachments", b.AttachmentTokens, atts),
		part("assistant", "Responses", b.AssistantMessageTokens, nil),
		part("user", "Your messages", b.UserMessageTokens, nil),
		part("redirected", "Redirected context", b.RedirectedContextTokens, nil),
		part("unattributed", "Unattributed", b.UnattributedTokens, nil),
	}
}

// snake is a category name as an id: "MCP tools (deferred)" → "mcp_tools_deferred".
func snake(s string) string {
	var b strings.Builder
	under := false
	for _, r := range strings.ToLower(s) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			if under && b.Len() > 0 {
				b.WriteByte('_')
			}
			b.WriteRune(r)
			under = false
		} else {
			under = true
		}
	}
	return b.String()
}

// commas writes n with thousands separators: 967000 → "967,000".
func commas(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0 && s[i-1] != '-'; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
