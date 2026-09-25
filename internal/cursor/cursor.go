// Package cursor drives Cursor's `agent acp` (JSON-RPC 2.0 over stdio) as an agent.Agent.
package cursor

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/version"
)

type Spawner struct {
	Bin     string // -cursor flag, default "agent"
	SQLite  string // sqlite3 binary for the context meter, default "sqlite3"
	AppRoot string
	Home    string

	// OnCatalog is not used; catalogs come back as EvCatalog.

	ctxInterval time.Duration // context poll interval; 0 = 1 s (tests shorten it)

	mu   sync.Mutex
	last *model.Catalog // the last catalog Cursor reported, for ValueFor on a resumed session
}

func (s *Spawner) bin() string {
	if s.Bin == "" {
		return "agent"
	}
	return s.Bin
}

func (s *Spawner) sqlite() string {
	if s.SQLite == "" {
		return "sqlite3"
	}
	return s.SQLite
}

func (s *Spawner) remember(c *model.Catalog) {
	if c == nil {
		return
	}
	s.mu.Lock()
	s.last = c
	s.mu.Unlock()
}

func (s *Spawner) lastCatalog() *model.Catalog {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last
}

type permEntry struct {
	id            json.RawMessage
	allow, reject string
}

type proc struct {
	conn      *Conn
	o         agent.SpawnOptions
	events    chan agent.Event
	ready     chan struct{} // closed when the session is usable
	readyErr  error
	sessionID string
	loading   atomic.Bool // true during session/load: its replayed updates are dropped
	perms     sync.Map    // our request id string → permEntry
	permSeq   atomic.Int64
	ctx       ctxPoller // context usage reads (ctxusage.go)
	s         *Spawner

	mu     sync.Mutex // guards inText, msgSeq, tools
	inText bool       // a text item is open
	msgSeq int
	tools  map[string]toolCall // toolCallId → the tool_call as first reported (kind, title, input)

	emu    sync.Mutex // guards closed and sends on events
	closed bool
	gate   sync.RWMutex // read-held by the handshake and each turn; EvExit waits for them
}

// Spawn starts `agent acp` in the chat's folder; the handshake continues in the background.
func (s *Spawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if fi, err := os.Stat(o.Cwd); err != nil || !fi.IsDir() {
		return nil, agent.ErrFolderMissing
	}
	conn, err := Start(s.bin(), []string{"acp"}, o.Cwd)
	if err != nil {
		return nil, fmt.Errorf("cannot start Cursor (%s): %w", s.bin(), err)
	}
	p := &proc{
		conn:   conn,
		o:      o,
		events: make(chan agent.Event, 256),
		ready:  make(chan struct{}),
		tools:  map[string]toolCall{},
		s:      s,
	}
	p.ctx.interval = s.ctxInterval
	conn.OnNotify = p.onUpdate
	conn.OnRequest = p.onRequest
	p.gate.RLock()
	go p.handshake()
	go func() {
		err := conn.Wait()
		p.ctx.stopPolling()
		p.gate.Lock() // the handshake and running turns have sent their last events
		defer p.gate.Unlock()
		e := agent.Event{Kind: agent.EvExit}
		if err != nil {
			e.ExitErr = err.Error()
		}
		p.emu.Lock()
		p.events <- e
		p.closed = true
		close(p.events)
		p.emu.Unlock()
	}()
	return p, nil
}

// emit sends an event unless the channel has been closed.
func (p *proc) emit(e agent.Event) {
	p.emu.Lock()
	defer p.emu.Unlock()
	if !p.closed {
		p.events <- e
	}
}

func initializeParams() map[string]any {
	return map[string]any{
		"protocolVersion": 1,
		"clientCapabilities": map[string]any{
			"fs":       map[string]any{"readTextFile": false, "writeTextFile": false},
			"terminal": false,
		},
		"clientInfo": map[string]any{"name": "ai-whiteboard", "version": version.Version},
	}
}

func (p *proc) handshake() {
	defer p.gate.RUnlock()
	defer close(p.ready)
	if err := p.doHandshake(); err != nil {
		p.readyErr = err
	}
}

func (p *proc) doHandshake() error {
	c := p.conn
	if _, err := c.Call("initialize", initializeParams()); err != nil {
		return err
	}
	if _, err := c.Call("authenticate", map[string]any{"methodId": "cursor_login"}); err != nil {
		return err
	}
	var cat *model.Catalog
	if p.o.Resume {
		p.loading.Store(true)
		res, err := c.Call("session/load", map[string]any{"sessionId": p.o.SessionID, "cwd": p.o.Cwd, "mcpServers": []any{}})
		p.loading.Store(false)
		if err != nil {
			return err
		}
		p.sessionID = p.o.SessionID
		if cat = ParseCatalog(res); cat != nil {
			p.s.remember(cat)
			p.emit(agent.Event{Kind: agent.EvCatalog, Catalog: cat})
		}
		p.readCtx() // a resumed chat shows its meter before the next turn
	} else {
		res, err := c.Call("session/new", map[string]any{"cwd": p.o.Cwd, "mcpServers": []any{}})
		if err != nil {
			return err
		}
		var r struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(res, &r) != nil || r.SessionID == "" {
			return errors.New("session/new: Cursor returned no sessionId")
		}
		p.sessionID = r.SessionID
		cat = ParseCatalog(res)
		p.s.remember(cat)
		p.emit(agent.Event{Kind: agent.EvSession, SessionID: r.SessionID})
		if cat != nil {
			p.emit(agent.Event{Kind: agent.EvCatalog, Catalog: cat})
		}
	}
	if p.o.Model != "" {
		if cat == nil {
			cat = p.s.lastCatalog()
		}
		if v := ValueFor(cat, p.o.Model, p.o.Effort); v != "" {
			_, err := c.Call("session/set_config_option", map[string]any{"sessionId": p.sessionID, "configId": "model", "value": v})
			if err != nil {
				if _, err2 := c.Call("session/set_model", map[string]any{"sessionId": p.sessionID, "modelId": v}); err2 != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (p *proc) Events() <-chan agent.Event { return p.events }

// Send runs one user turn; it waits for the handshake.
func (p *proc) Send(blocks []agent.ContentBlock) error {
	<-p.ready
	if p.readyErr != nil {
		return p.readyErr
	}
	prompt := make([]map[string]any, 0, len(blocks))
	for _, b := range blocks {
		prompt = append(prompt, map[string]any{"type": "text", "text": b.Text})
	}
	p.mu.Lock()
	p.inText = false
	p.mu.Unlock()
	p.emit(agent.Event{Kind: agent.EvThinking})
	p.ctx.startPolling(p)
	p.gate.RLock()
	go func() {
		defer p.gate.RUnlock()
		res, err := p.conn.Call("session/prompt", map[string]any{"sessionId": p.sessionID, "prompt": prompt})
		p.ctx.stopPolling()
		p.readCtx() // one final read after every turn, errors included
		if err != nil {
			p.emit(agent.Event{Kind: agent.EvTurnEnd, Error: err.Error()})
			return
		}
		p.mu.Lock()
		p.inText = false
		p.mu.Unlock()
		var r struct {
			StopReason string `json:"stopReason"`
		}
		json.Unmarshal(res, &r)
		e := agent.Event{Kind: agent.EvTurnEnd, Aborted: r.StopReason == "cancelled"}
		switch r.StopReason {
		case "end_turn", "cancelled", "max_tokens":
		default:
			e.Error = "Cursor stopped: " + r.StopReason
		}
		p.emit(e)
	}()
	return nil
}

func (p *proc) Interrupt() error {
	select {
	case <-p.ready:
	default:
		return errNotReady
	}
	if p.readyErr != nil {
		return p.readyErr
	}
	return p.conn.Notify("session/cancel", map[string]any{"sessionId": p.sessionID})
}

// toolCall is a tool_call / tool_call_update, or a permission request's toolCall.
type toolCall struct {
	SessionUpdate string            `json:"sessionUpdate"`
	ToolCallID    string            `json:"toolCallId"`
	Title         string            `json:"title"`
	Kind          string            `json:"kind"`
	Status        string            `json:"status"`
	RawInput      json.RawMessage   `json:"rawInput"`
	RawOutput     json.RawMessage   `json:"rawOutput"`
	Content       []json.RawMessage `json:"content"`
	Locations     []struct {
		Path string `json:"path"`
	} `json:"locations"`
}

type update struct {
	toolCall
	Content json.RawMessage `json:"content"` // a content block for chunks, a list for tool calls
}

func present(raw json.RawMessage) bool { return len(raw) > 0 && string(raw) != "null" }

func (p *proc) onUpdate(method string, params json.RawMessage) {
	if method != "session/update" || p.loading.Load() {
		return
	}
	var env struct {
		Update json.RawMessage `json:"update"`
	}
	if json.Unmarshal(params, &env) != nil {
		return
	}
	var u update
	if json.Unmarshal(env.Update, &u) != nil {
		return
	}
	switch u.SessionUpdate {
	case "agent_thought_chunk":
		p.emit(agent.Event{Kind: agent.EvThinking})
	case "agent_message_chunk":
		var c struct {
			Text string `json:"text"`
		}
		json.Unmarshal(u.Content, &c)
		p.mu.Lock()
		start := !p.inText
		if start {
			p.msgSeq++
			p.inText = true
		}
		id := "c" + strconv.Itoa(p.msgSeq)
		p.mu.Unlock()
		if start {
			p.emit(agent.Event{Kind: agent.EvTextStart, MsgID: id})
		}
		p.emit(agent.Event{Kind: agent.EvTextDelta, MsgID: id, Text: c.Text})
	case "tool_call", "tool_call_update":
		tc := u.toolCall
		json.Unmarshal(u.Content, &tc.Content)
		p.mu.Lock()
		if u.SessionUpdate == "tool_call" {
			p.inText = false
			p.tools[tc.ToolCallID] = tc
		} else {
			tc = mergeTool(p.tools[tc.ToolCallID], tc)
			p.tools[tc.ToolCallID] = tc
		}
		p.mu.Unlock()
		if u.SessionUpdate == "tool_call" {
			name, input := p.normalizeTool(tc)
			p.emit(agent.Event{Kind: agent.EvToolStart, ToolID: tc.ToolCallID, ToolName: name, Input: input})
		} else if present(u.RawInput) {
			name, input := p.normalizeTool(tc)
			p.emit(agent.Event{Kind: agent.EvToolInput, ToolID: tc.ToolCallID, ToolName: name, Input: input})
		}
		switch tc.Status {
		case "completed":
			p.emit(agent.Event{Kind: agent.EvToolResult, ToolID: tc.ToolCallID, Result: resultText(tc), IsError: exitCode(tc) != 0})
		case "failed":
			p.emit(agent.Event{Kind: agent.EvToolResult, ToolID: tc.ToolCallID, Result: resultText(tc), IsError: true})
		}
	}
	// Other kinds (session_info_update, available_commands_update, plan, modes, …) are ignored.
}

// mergeTool fills an update's missing fields from the tool_call it updates, and remembers the
// update's own fields for later updates.
func mergeTool(base, u toolCall) toolCall {
	if u.Title == "" {
		u.Title = base.Title
	}
	if u.Kind == "" {
		u.Kind = base.Kind
	}
	if !present(u.RawInput) {
		u.RawInput = base.RawInput
	}
	if len(u.Locations) == 0 {
		u.Locations = base.Locations
	}
	return u
}

// command is the shell command of an execute tool call: rawInput.command, else the title
// without its backticks.
func command(tc toolCall) string {
	var in struct {
		Command string `json:"command"`
	}
	if present(tc.RawInput) && json.Unmarshal(tc.RawInput, &in) == nil && in.Command != "" {
		return in.Command
	}
	return strings.Trim(tc.Title, "`")
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

// normalizeTool maps a Cursor tool call to the tool name and input the chat shows, so that a
// board command gets the same card as Claude's board tool and a shell command Claude's Bash card.
func (p *proc) normalizeTool(tc toolCall) (string, json.RawMessage) {
	path := ""
	if len(tc.Locations) > 0 {
		path = tc.Locations[0].Path
	}
	switch tc.Kind {
	case "execute":
		cmd := command(tc)
		if p.o.Board != nil {
			if tok, tool, args, ok := boardtools.ParseCommand(cmd); ok && tok == p.o.Board.Token {
				return "mcp__board__" + tool, args
			}
		}
		return "Bash", mustJSON(map[string]string{"command": cmd})
	case "read":
		return "Read", mustJSON(map[string]string{"file_path": path})
	case "edit":
		return "Edit", mustJSON(map[string]string{"file_path": path})
	case "search":
		return "Grep", mustJSON(map[string]string{"pattern": tc.Title})
	case "fetch":
		var in struct {
			URL string `json:"url"`
		}
		json.Unmarshal(tc.RawInput, &in)
		return "WebFetch", mustJSON(map[string]string{"url": in.URL})
	}
	if !present(tc.RawInput) {
		return tc.Title, nil
	}
	return tc.Title, tc.RawInput
}

type execOutput struct {
	ExitCode *int   `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

func exitCode(tc toolCall) int {
	var o execOutput
	if present(tc.RawOutput) && json.Unmarshal(tc.RawOutput, &o) == nil && o.ExitCode != nil {
		return *o.ExitCode
	}
	return 0
}

// resultText is rawOutput.stdout (plus stderr when non-empty) for execute; else the text of the
// content blocks; else "".
func resultText(tc toolCall) string {
	if tc.Kind == "execute" && present(tc.RawOutput) {
		var o execOutput
		if json.Unmarshal(tc.RawOutput, &o) == nil && (o.Stdout != "" || o.Stderr != "") {
			out := o.Stdout
			if o.Stderr != "" {
				if out != "" && !strings.HasSuffix(out, "\n") {
					out += "\n"
				}
				out += o.Stderr
			}
			return out
		}
	}
	var parts []string
	for _, raw := range tc.Content {
		var c struct {
			Text    string `json:"text"`
			Content struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal(raw, &c) != nil {
			continue
		}
		if c.Content.Text != "" {
			parts = append(parts, c.Content.Text)
		} else if c.Text != "" {
			parts = append(parts, c.Text)
		}
	}
	return strings.Join(parts, "\n")
}

func (p *proc) onRequest(id json.RawMessage, method string, params json.RawMessage) {
	if method != "session/request_permission" {
		p.conn.Reply(id, nil, map[string]any{"code": -32601, "message": "method not found"})
		return
	}
	var req struct {
		ToolCall toolCall `json:"toolCall"`
		Options  []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	json.Unmarshal(params, &req)
	tc := req.ToolCall
	allow, reject := "allow-once", "reject-once"
	for _, o := range req.Options {
		switch o.Kind {
		case "allow_once":
			allow = o.OptionID
		case "reject_once":
			reject = o.OptionID
		}
	}
	selected := func(opt string) any {
		return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": opt}}
	}
	if p.o.Board != nil {
		if tok, _, _, ok := boardtools.ParseCommand(command(tc)); ok && tok == p.o.Board.Token {
			p.conn.Reply(id, selected(allow), nil) // board commands never ask
			return
		}
	}
	if agent.TouchesAppDir(params, p.s.AppRoot, p.s.Home) {
		p.conn.Reply(id, selected(reject), nil)
		return
	}
	rid := "p" + strconv.FormatInt(p.permSeq.Add(1), 10)
	p.perms.Store(rid, permEntry{id: id, allow: allow, reject: reject})
	name, input := p.normalizeTool(tc)
	p.emit(agent.Event{Kind: agent.EvPermRequest, PermID: rid, ToolName: name, ToolID: tc.ToolCallID, Input: input})
}

// Decide answers a permission request raised as EvPermRequest.
func (p *proc) Decide(requestID string, allow bool) error {
	v, ok := p.perms.LoadAndDelete(requestID)
	if !ok {
		return fmt.Errorf("unknown permission request %q", requestID)
	}
	e := v.(permEntry)
	opt := e.reject
	if allow {
		opt = e.allow
	}
	return p.conn.Reply(e.id, map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": opt}}, nil)
}

// Close ends the process: stdin is closed, and it is killed after 3 s.
func (p *proc) Close() {
	p.ctx.stopPolling()
	p.conn.Close()
}
