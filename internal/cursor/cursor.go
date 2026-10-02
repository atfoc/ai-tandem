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
	last *model.Catalog // the last catalog Cursor reported, for a resumed session's catalog Default
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

// stream is one session's streaming state: the parent's, or a subagent's.
type stream struct {
	inText bool // a text item is open
	msgSeq int
	tools  map[string]toolCall // toolCallId → the tool_call as first reported (kind, title, input)
}

// child is a subagent session (subagentSessionId) and the parent tool call that started it.
type child struct {
	id, tool string
	stream
	stop, done chan struct{} // the context poller; stop is nil once it has been stopped
	readMu     sync.Mutex    // held during a read of its store
	last       ContextUsage  // the last read sent
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

	mu       sync.Mutex        // guards main, children and every child's stream and stop
	main     stream            // the parent session's streaming state
	children map[string]*child // subagents by subagentSessionId

	emu    sync.Mutex // guards closed and sends on events
	closed bool
	gate   sync.RWMutex // read-held by the handshake and each turn; EvExit waits for them
}

// Spawn starts `agent acp` in the chat's folder; the handshake continues in the background.
func (s *Spawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if fi, err := os.Stat(o.Cwd); err != nil || !fi.IsDir() {
		return nil, agent.ErrFolderMissing
	}
	// Hook file is read once when session/new or session/load builds session resources, so write
	// it before Start. Isolate this process with an app-owned CURSOR_DATA_DIR (not ~/.cursor).
	dataDir := s.cursorDataDir()
	if err := writeTaskHook(dataDir, o.Cwd); err != nil {
		return nil, fmt.Errorf("cannot write Cursor Task deny hook: %w", err)
	}
	conn, err := Start(s.bin(), []string{"acp"}, o.Cwd, "CURSOR_DATA_DIR="+dataDir)
	if err != nil {
		return nil, fmt.Errorf("cannot start Cursor (%s): %w", s.bin(), err)
	}
	p := &proc{
		conn:     conn,
		o:        o,
		events:   make(chan agent.Event, 256),
		ready:    make(chan struct{}),
		main:     stream{tools: map[string]toolCall{}},
		children: map[string]*child{},
		s:        s,
	}
	p.ctx.interval = s.ctxInterval
	conn.OnNotify = p.onUpdate
	conn.OnRequest = p.onRequest
	p.gate.RLock()
	go p.handshake()
	go func() {
		err := conn.Wait()
		p.ctx.stopPolling()
		p.stopChildren()
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
			// Cursor's parameterized model picker: "model" takes a bare id and each model
			// parameter (effort, thinking, context, ...) is its own config option.
			// subagents: subagent_spawned / subagent_state_update and each child's own
			// session/update stream. A plain clientCapabilities.subagents is stripped by Cursor's
			// SDK; only _meta gets through.
			"_meta": map[string]any{"parameterizedModelPicker": true, "subagents": true},
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

// doHandshake: initialize → authenticate → session/new | session/load →
// cursor/list_available_models → EvCatalog → applyChoice (always, even on resume) → on resume, the
// context meter read. Errors become readyErr, so no prompt runs before the policy is applied.
func (p *proc) doHandshake() error {
	c := p.conn
	if _, err := c.Call("initialize", initializeParams()); err != nil {
		return err
	}
	if _, err := c.Call("authenticate", map[string]any{"methodId": "cursor_login"}); err != nil {
		return err
	}
	var reported string // the model Cursor reports for the session
	if p.o.Resume {
		p.loading.Store(true)
		res, err := c.Call("session/load", map[string]any{"sessionId": p.o.SessionID, "cwd": p.o.Cwd, "mcpServers": mcpServers(p.o)})
		p.loading.Store(false)
		if err != nil {
			return err
		}
		p.sessionID = p.o.SessionID
		reported = reportedModel(res)
	} else {
		res, err := c.Call("session/new", map[string]any{"cwd": p.o.Cwd, "mcpServers": mcpServers(p.o)})
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
		reported = reportedModel(res)
		p.emit(agent.Event{Kind: agent.EvSession, SessionID: r.SessionID})
	}

	res, err := c.Call("cursor/list_available_models", map[string]any{})
	if err != nil {
		return err
	}
	cat := ParseModelList(res)
	if cat == nil {
		return errors.New("Cursor reported no models")
	}
	if p.o.Resume {
		// session/load reports the shared last-used model, not a starting point: keep the last
		// known Default when that model is still offered.
		def := ""
		if last := p.s.lastCatalog(); last != nil {
			def = last.Default.Model
		}
		setDefault(cat, def)
	} else {
		setDefault(cat, reported)
	}
	p.s.remember(cat)
	p.emit(agent.Event{Kind: agent.EvCatalog, Catalog: cat})

	m := p.o.Model
	if m == "" {
		m = reported
	}
	if m == "" {
		m = cat.Default.Model
	}
	if err := applyChoice(c, p.sessionID, cat, m, p.o.Effort); err != nil {
		return err
	}
	if p.o.Resume {
		p.readCtx() // a resumed chat shows its meter before the next turn
	}
	return nil
}

func (p *proc) Events() <-chan agent.Event { return p.events }

// mcpServers is the ACP mcpServers value for a chat. Whenever MCP is set the process gets the
// board server: HTTP type, the exact fixed URL (an org policy matches the full URL, plan D1/D3)
// and this process's token in an Authorization bearer header. SpawnOptions without MCP get an
// empty array. The headers array must exist even when empty: Cursor's ACP schema requires it for
// an HTTP entry (experiment A.1).
func mcpServers(o agent.SpawnOptions) []any {
	if o.MCP == nil || o.MCP.MCPURL == "" {
		return []any{}
	}
	return []any{map[string]any{
		"type": "http",
		"name": "board",
		"url":  o.MCP.MCPURL,
		"headers": []any{
			map[string]any{"name": "Authorization", "value": "Bearer " + o.MCP.Token},
		},
	}}
}

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
	p.main.inText = false
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
		p.main.inText = false
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
		return // session/load's replay (including its synthetic subagent lines) is dropped
	}
	var env struct {
		SessionID string          `json:"sessionId"`
		Update    json.RawMessage `json:"update"`
	}
	if json.Unmarshal(params, &env) != nil {
		return
	}
	var u update
	if json.Unmarshal(env.Update, &u) != nil {
		return
	}
	switch u.SessionUpdate {
	case "subagent_spawned":
		p.onSpawned(env.Update)
		return
	case "subagent_state_update":
		p.onSubState(env.Update)
		return
	}
	// A known subagent session feeds that subagent; anything else is the parent's. Comparing with
	// p.sessionID is avoided on purpose: the handshake goroutine writes it.
	p.mu.Lock()
	st, sub := &p.main, ""
	if c, ok := p.children[env.SessionID]; ok {
		st, sub = &c.stream, c.tool
	}
	p.mu.Unlock()
	p.streamUpdate(st, sub, u)
}

// streamUpdate turns one session/update into events of the session st streams: the parent's
// (sub == "") or the subagent started by the parent tool call sub.
func (p *proc) streamUpdate(st *stream, sub string, u update) {
	switch u.SessionUpdate {
	case "agent_thought_chunk":
		p.emit(agent.Event{Kind: agent.EvThinking, Sub: sub})
	case "agent_message_chunk":
		var c struct {
			Text string `json:"text"`
		}
		json.Unmarshal(u.Content, &c)
		p.mu.Lock()
		start := !st.inText
		if start {
			st.msgSeq++
			st.inText = true
		}
		id := "c" + strconv.Itoa(st.msgSeq)
		if sub != "" {
			id = "c" + sub + "-" + strconv.Itoa(st.msgSeq)
		}
		p.mu.Unlock()
		if start {
			p.emit(agent.Event{Kind: agent.EvTextStart, MsgID: id, Sub: sub})
		}
		p.emit(agent.Event{Kind: agent.EvTextDelta, MsgID: id, Text: c.Text, Sub: sub})
	case "tool_call", "tool_call_update":
		tc := u.toolCall
		json.Unmarshal(u.Content, &tc.Content)
		p.mu.Lock()
		if u.SessionUpdate == "tool_call" {
			st.inText = false
			st.tools[tc.ToolCallID] = tc
		} else {
			tc = mergeTool(st.tools[tc.ToolCallID], tc)
			st.tools[tc.ToolCallID] = tc
		}
		p.mu.Unlock()
		if u.SessionUpdate == "tool_call" {
			name, input := p.normalizeTool(tc)
			p.emit(agent.Event{Kind: agent.EvToolStart, ToolID: tc.ToolCallID, ToolName: name, Input: input, Sub: sub})
		} else if present(u.RawInput) {
			name, input := p.normalizeTool(tc)
			p.emit(agent.Event{Kind: agent.EvToolInput, ToolID: tc.ToolCallID, ToolName: name, Input: input, Sub: sub})
		}
		switch tc.Status {
		case "completed":
			p.emit(agent.Event{Kind: agent.EvToolResult, ToolID: tc.ToolCallID, Result: resultText(tc), IsError: exitCode(tc) != 0, Sub: sub})
		case "failed":
			p.emit(agent.Event{Kind: agent.EvToolResult, ToolID: tc.ToolCallID, Result: resultText(tc), IsError: true, Sub: sub})
		}
		// A background child's Task tool completes about 130 ms after launch with
		// rawOutput {"isBackground":true}.
		if sub == "" && tc.Status == "completed" && isTaskTool(tc) {
			var out struct {
				IsBackground bool `json:"isBackground"`
			}
			if present(tc.RawOutput) && json.Unmarshal(tc.RawOutput, &out) == nil && out.IsBackground {
				p.emit(agent.Event{Kind: agent.EvSub, Sub: tc.ToolCallID, SubInfo: &agent.SubInfo{Background: ptr(true)}})
			}
		}
	}
	// Other kinds (session_info_update, available_commands_update, plan, modes, …) are ignored.
}

func ptr[T any](v T) *T { return &v }

// taskArgs is the part of a Task tool call's rawInput the app shows.
type taskArgs struct {
	Description, Prompt, Type string // Type: the custom agent's name, "" for the general-purpose one
	Background                bool
}

// isTaskTool reports whether a tool call is the Task (subagent) tool: rawInput._toolName "task",
// or, before rawInput arrives, a kind "other" call titled "Task: …".
func isTaskTool(tc toolCall) bool {
	var in struct {
		ToolName string `json:"_toolName"`
	}
	if present(tc.RawInput) && json.Unmarshal(tc.RawInput, &in) == nil && in.ToolName != "" {
		return in.ToolName == "task"
	}
	return tc.Kind == "other" && strings.HasPrefix(tc.Title, "Task: ")
}

// taskInput reads rawInput {description, prompt, subagentType: {custom: {name}} | {unspecified: {}},
// runInBackground | run_in_background}. The description falls back to the title after "Task: ".
func taskInput(tc toolCall) taskArgs {
	var in struct {
		Description  string `json:"description"`
		Prompt       string `json:"prompt"`
		SubagentType struct {
			Custom *struct {
				Name string `json:"name"`
			} `json:"custom"`
		} `json:"subagentType"`
		RunInBackground  bool `json:"runInBackground"`
		RunInBackground2 bool `json:"run_in_background"`
	}
	if present(tc.RawInput) {
		json.Unmarshal(tc.RawInput, &in)
	}
	a := taskArgs{Description: in.Description, Prompt: in.Prompt, Background: in.RunInBackground || in.RunInBackground2}
	if in.SubagentType.Custom != nil {
		a.Type = in.SubagentType.Custom.Name
	}
	if a.Description == "" {
		a.Description = strings.TrimPrefix(tc.Title, "Task: ")
	}
	return a
}

// onSpawned opens a subagent: subagent_spawned {subagentSessionId, name, task,
// _meta.cursor.{toolCallId, model}}. The description comes from the parent's Task tool call.
func (p *proc) onSpawned(raw json.RawMessage) {
	var s struct {
		SubagentSessionID string `json:"subagentSessionId"`
		Name              string `json:"name"`
		Task              string `json:"task"`
		Meta              struct {
			Cursor struct {
				ToolCallID string `json:"toolCallId"`
				Model      string `json:"model"`
			} `json:"cursor"`
		} `json:"_meta"`
	}
	if json.Unmarshal(raw, &s) != nil || s.SubagentSessionID == "" || s.Meta.Cursor.ToolCallID == "" {
		return
	}
	p.mu.Lock()
	if _, ok := p.children[s.SubagentSessionID]; ok {
		p.mu.Unlock()
		return
	}
	c := &child{id: s.SubagentSessionID, tool: s.Meta.Cursor.ToolCallID, stream: stream{tools: map[string]toolCall{}}}
	p.children[c.id] = c
	parent := p.main.tools[c.tool]
	p.mu.Unlock()
	a := taskInput(parent)
	// The spawn update's task is a short preview; the Task call carries the full prompt.
	info := &agent.SubInfo{ID: c.id, Type: s.Name, Description: a.Description, Prompt: a.Prompt,
		Model: s.Meta.Cursor.Model, Status: model.SubRunning}
	if a.Type != "" {
		info.Type = a.Type
	}
	if info.Prompt == "" {
		info.Prompt = s.Task
	}
	if a.Background {
		info.Background = ptr(true)
	}
	p.emit(agent.Event{Kind: agent.EvSub, Sub: c.tool, SubInfo: info})
	p.pollChild(c)
}

// onSubState ends a subagent: subagent_state_update {subagentSessionId, state, error?}.
// completed → completed; failed → failed; cancelled and disconnected (a cancel that timed out) →
// stopped. The final status goes out at once; the poller is stopped and the store read one last
// time in the background, so the read loop never waits on sqlite3.
func (p *proc) onSubState(raw json.RawMessage) {
	var s struct {
		SubagentSessionID string `json:"subagentSessionId"`
		State             string `json:"state"`
		Error             string `json:"error"`
	}
	if json.Unmarshal(raw, &s) != nil {
		return
	}
	p.mu.Lock()
	c := p.children[s.SubagentSessionID]
	p.mu.Unlock()
	if c == nil {
		return
	}
	var st model.SubStatus
	switch s.State {
	case "completed":
		st = model.SubCompleted
	case "failed", "error":
		st = model.SubFailed
	case "cancelled", "disconnected":
		st = model.SubStopped
	default:
		return // not final
	}
	p.emit(agent.Event{Kind: agent.EvSub, Sub: c.tool, SubInfo: &agent.SubInfo{Status: st, Error: s.Error}})
	go func() {
		p.stopChild(c)
		p.readChildCtx(c, false)
	}()
}

// onCursorTask takes the subagent's real model from cursor/task {toolCallId, model}: for custom
// agents it is right where subagent_spawned's _meta.cursor.model names the parent's model.
func (p *proc) onCursorTask(params json.RawMessage) {
	var t struct {
		ToolCallID string `json:"toolCallId"`
		Model      string `json:"model"`
	}
	if json.Unmarshal(params, &t) != nil || t.ToolCallID == "" || t.Model == "" {
		return
	}
	if tool := p.taskToolID(t.ToolCallID); tool != "" {
		p.emit(agent.Event{Kind: agent.EvSub, Sub: tool, SubInfo: &agent.SubInfo{Model: t.Model}})
	}
}

// taskToolID finds the parent tool call id that id names: an exact match among the children's
// tools and the parent's tool calls, else a match on the part before the first "\n" (Cursor's ids
// are "call_…\nfc_…", and cursor/task may give only the first part). "" when none matches.
func (p *proc) taskToolID(id string) string {
	head := func(s string) string { h, _, _ := strings.Cut(s, "\n"); return h }
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.children {
		if c.tool == id {
			return c.tool
		}
	}
	if _, ok := p.main.tools[id]; ok {
		return id
	}
	for tid := range p.main.tools {
		if head(tid) == head(id) {
			return tid
		}
	}
	return ""
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

// mcpCallInput is the rawInput of a Cursor MCP tool call. The real shape was captured from a
// live board round-trip on 2026-10-02 (cursor-agent 2026.10.01-e373342): the first tool_call
// carries title "MCP: tool", kind "other" and an empty rawInput, and a following
// tool_call_update adds title "board: <tool>" and this rawInput. The server name is the MCP
// server's `name` ("board"), the tool name is the MCP tool name and args are its arguments.
type mcpCallInput struct {
	ProviderIdentifier string          `json:"providerIdentifier"`
	ToolName           string          `json:"toolName"`
	Args               json.RawMessage `json:"args"`
}

// boardMCPCall reports whether tc is a call of this app's "board" MCP server, and returns the
// tool name and its arguments. Board-engine tools and the spawn family both qualify so a spawn
// row normalizes to mcp__board__spawn_subagent whenever the server is attached. Every other MCP
// call (another server, an unknown tool) keeps its normal tool presentation.
func boardMCPCall(tc toolCall) (string, json.RawMessage, bool) {
	if !present(tc.RawInput) {
		return "", nil, false
	}
	var in mcpCallInput
	if json.Unmarshal(tc.RawInput, &in) != nil || in.ProviderIdentifier != "board" ||
		!(boardtools.IsTool(in.ToolName) || boardtools.IsSpawnFamily(in.ToolName)) {
		return "", nil, false
	}
	args := in.Args
	if !present(args) {
		args = json.RawMessage("{}")
	}
	return in.ToolName, args, true
}

// normalizeTool maps a Cursor tool call to the tool name and input the chat shows, so that a
// board MCP call gets the same card as Claude's and pi's board tools and a shell command Claude's
// Bash card.
func (p *proc) normalizeTool(tc toolCall) (string, json.RawMessage) {
	if isTaskTool(tc) {
		a := taskInput(tc)
		return "Agent", mustJSON(map[string]string{"description": a.Description, "prompt": a.Prompt, "subagent_type": a.Type})
	}
	if p.o.MCP != nil {
		if tool, args, ok := boardMCPCall(tc); ok {
			return "mcp__board__" + tool, args
		}
	}
	path := ""
	if len(tc.Locations) > 0 {
		path = tc.Locations[0].Path
	}
	switch tc.Kind {
	case "execute":
		return "Bash", mustJSON(map[string]string{"command": command(tc)})
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
	if method == "cursor/task" {
		p.conn.Reply(id, map[string]any{}, nil) // was "method not found"
		p.onCursorTask(params)
		return
	}
	if method != "session/request_permission" {
		p.conn.Reply(id, nil, map[string]any{"code": -32601, "message": "method not found"})
		return
	}
	var req struct {
		SessionID string   `json:"sessionId"`
		ToolCall  toolCall `json:"toolCall"`
		Options   []struct {
			OptionID string `json:"optionId"`
			Kind     string `json:"kind"`
		} `json:"options"`
	}
	json.Unmarshal(params, &req)
	tc := req.ToolCall
	allow, reject := "allow-once", "reject-once"
	allowOnce, allowAlways := "", ""
	for _, o := range req.Options {
		switch o.Kind {
		case "allow_once":
			allowOnce = o.OptionID
		case "allow_always":
			allowAlways = o.OptionID
		case "reject_once":
			reject = o.OptionID
		case "reject_always":
			reject = o.OptionID
		}
	}
	// Prefer allow_once so an auto-approved board call writes nothing to the user's config; fall
	// back to an always-allow option when Cursor offers only that.
	if allowOnce != "" {
		allow = allowOnce
	} else if allowAlways != "" {
		allow = allowAlways
	}
	selected := func(opt string) any {
		return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": opt}}
	}
	if tool, _, ok := boardMCPCall(tc); ok {
		spawnOK := boardtools.IsSpawnFamily(tool) && p.o.MCP != nil
		boardOK := boardtools.IsTool(tool) && p.o.BoardID != ""
		if spawnOK || boardOK {
			p.conn.Reply(id, selected(allow), nil) // spawn-family whenever MCP is attached; board tools only with board extras
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
	sub := ""
	p.mu.Lock()
	if c, ok := p.children[req.SessionID]; ok {
		sub = c.tool // asked by a subagent; the card stays in the parent's thread
	}
	p.mu.Unlock()
	p.emit(agent.Event{Kind: agent.EvPermRequest, PermID: rid, ToolName: name, ToolID: tc.ToolCallID, Input: input, Sub: sub})
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
	p.stopChildren()
	p.conn.Close()
}
