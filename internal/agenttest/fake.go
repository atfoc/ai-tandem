// Package agenttest is test support shared by the packages that drive agents: a scripted
// agent.Spawner (Fake) and a scripted stand-in for the claude program (FakeClaude). It imports
// only agent and model of the project, so every package's tests can use it.
package agenttest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// Fake is an agent.Spawner whose processes are driven by a script. A process behaves toward the
// chat manager as a real adapter's does: it emits the events of a turn on Events, ends a turn
// with EvTurnEnd, ends itself with EvExit and then closes the channel, and honours Interrupt and
// Close.
type Fake struct {
	Kind model.AgentKind
	MCP  http.Handler // the app's /mcp handler; set by the test's environment

	mu        sync.Mutex
	script    func(t *Turn)
	spawns    []agent.SpawnOptions
	failSpawn error
	procs     []*proc
	sessions  int
}

// New returns a Fake of the given kind whose turns end cleanly with no output until Script is
// called.
func New(kind model.AgentKind) *Fake {
	return &Fake{Kind: kind}
}

// Script sets what a process does with each message; it runs on its own goroutine and the turn
// ends cleanly when it returns, unless it ended the turn itself (Fail, Exit) or the turn was
// interrupted, in which case it ends as stopped. It applies to the turns that start after the
// call, of every process of the Fake; t.Opts says which process a turn belongs to. A message whose
// process is closed before its turn has begun never reaches the script: a test that waits for
// something the script does must first know that the script runs.
func (f *Fake) Script(h func(t *Turn)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.script = h
}

// Spawns returns the options of every Spawn so far, failed ones included.
func (f *Fake) Spawns() []agent.SpawnOptions {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]agent.SpawnOptions(nil), f.spawns...)
}

// FailSpawn makes the next Spawn fail with err.
func (f *Fake) FailSpawn(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failSpawn = err
}

// Live is the number of processes that were started and have not ended.
func (f *Fake) Live() int {
	f.mu.Lock()
	procs := append([]*proc(nil), f.procs...)
	f.mu.Unlock()
	n := 0
	for _, p := range procs {
		select {
		case <-p.done:
		default:
			n++
		}
	}
	return n
}

// LiveSpawns is what the processes that have not ended were started with, for a test that has
// to say which process was left.
func (f *Fake) LiveSpawns() []agent.SpawnOptions {
	f.mu.Lock()
	procs := append([]*proc(nil), f.procs...)
	f.mu.Unlock()
	var out []agent.SpawnOptions
	for _, p := range procs {
		if !p.gone() {
			out = append(out, p.opts)
		}
	}
	return out
}

// Spawn starts a scripted process. Like the real adapters it fails with agent.ErrFolderMissing
// when o.Cwd does not exist. A process started with no session id reports one with EvSession, as
// Cursor does after session/new.
func (f *Fake) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	f.mu.Lock()
	f.spawns = append(f.spawns, o)
	if err := f.failSpawn; err != nil {
		f.failSpawn = nil
		f.mu.Unlock()
		return nil, err
	}
	if _, err := os.Stat(o.Cwd); err != nil {
		f.mu.Unlock()
		return nil, agent.ErrFolderMissing
	}
	p := &proc{f: f, opts: o, ch: make(chan agent.Event, 1024), done: make(chan struct{}), session: o.SessionID}
	if p.session == "" {
		f.sessions++
		p.session = fmt.Sprintf("fake-session-%d", f.sessions)
	}
	f.procs = append(f.procs, p)
	f.mu.Unlock()

	if o.SessionID == "" {
		p.emit(agent.Event{Kind: agent.EvSession, SessionID: p.session})
	}
	return p, nil
}

// proc is one scripted process.
type proc struct {
	f       *Fake
	opts    agent.SpawnOptions
	session string
	ch      chan agent.Event
	done    chan struct{} // closed when the process has ended

	// emitMu makes an event and the end of the process one step each: nothing is sent on ch once
	// it is closed.
	emitMu sync.Mutex
	exited bool

	mu      sync.Mutex
	queue   []*Turn // the turns not over yet; the first one runs
	running bool    // a goroutine works through queue
	turns   int
	tools   int
}

func (p *proc) Events() <-chan agent.Event { return p.ch }

// emit sends events unless the process has ended; it reports whether it did.
func (p *proc) emit(evs ...agent.Event) bool {
	p.emitMu.Lock()
	defer p.emitMu.Unlock()
	if p.exited {
		return false
	}
	for _, ev := range evs {
		p.ch <- ev
	}
	return true
}

// exit ends the process: last, EvExit with msg, and the channel closes.
func (p *proc) exit(msg string, last ...agent.Event) {
	p.emitMu.Lock()
	if p.exited {
		p.emitMu.Unlock()
		return
	}
	for _, ev := range last {
		p.ch <- ev
	}
	p.exited = true
	p.ch <- agent.Event{Kind: agent.EvExit, ExitErr: msg}
	close(p.ch)
	close(p.done)
	p.emitMu.Unlock()
	// Whatever the script still does goes nowhere, and a Hang returns.
	p.mu.Lock()
	for _, t := range p.queue {
		t.stop()
	}
	p.mu.Unlock()
}

func (p *proc) gone() bool {
	select {
	case <-p.done:
		return true
	default:
		return false
	}
}

var errGone = errors.New("the agent's process has ended")

// Send takes one message: its turn runs the script once the turns before it are over.
func (p *proc) Send(blocks []agent.ContentBlock) error {
	if p.gone() {
		return errGone
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.Image == nil { // an image block has no text: Text and Blocks are the text blocks
			parts = append(parts, b.Text)
		}
	}
	p.mu.Lock()
	p.turns++
	t := &Turn{Opts: p.opts, Text: strings.Join(parts, "\n\n"), Blocks: parts, Raw: blocks, N: p.turns, p: p, intr: make(chan struct{})}
	p.queue = append(p.queue, t)
	start := !p.running
	p.running = true
	p.mu.Unlock()
	if start {
		go p.work()
	}
	return nil
}

// work runs the queued turns, one after the other.
func (p *proc) work() {
	for {
		p.mu.Lock()
		if len(p.queue) == 0 || p.gone() {
			p.running = false
			p.mu.Unlock()
			return
		}
		t := p.queue[0]
		p.mu.Unlock()

		p.emit(agent.Event{Kind: agent.EvThinking})
		p.f.mu.Lock()
		script := p.f.script
		p.f.mu.Unlock()
		if script != nil {
			script(t)
		}
		t.finish()

		p.mu.Lock()
		if len(p.queue) > 0 && p.queue[0] == t {
			p.queue = p.queue[1:]
		}
		p.mu.Unlock()
	}
}

// Interrupt stops the turn that runs (or, when none has begun, the first one waiting): what its
// script does from then on is not shown, a Hang returns, and the turn ends as stopped when the
// script returns. With no turn it does nothing.
func (p *proc) Interrupt() error {
	if p.gone() {
		return errGone
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.queue) > 0 {
		p.queue[0].stop()
	}
	return nil
}

// Decide: a scripted process never asks.
func (p *proc) Decide(requestID string, allow bool) error {
	return fmt.Errorf("unknown permission request %q", requestID)
}

// Close ends the process at once and does not wait: a turn that runs gets no turn end, as when a
// real process is killed in a turn.
func (p *proc) Close() {
	msg := ""
	if p.f.Kind == model.Cursor {
		msg = "exit status 143"
	}
	go p.exit(msg)
}

// Turn is one message to a scripted process and what the script makes of it. Its methods are for
// the script's goroutine. Once the turn is over (Fail, Exit), was interrupted, or its process has
// ended, they show nothing more and Call calls nothing.
type Turn struct {
	Opts   agent.SpawnOptions   // what the turn's process was started with
	Text   string               // the message: its blocks joined by a blank line
	Blocks []string             // the message's text blocks, as the manager sent them
	Raw    []agent.ContentBlock // every block of the message, image blocks included, in order
	N      int                  // its number in this process, from 1

	p    *proc
	intr chan struct{} // closed by an interrupt and by the end of the process

	mu      sync.Mutex
	stopped bool // intr is closed
	ended   bool // the turn end (or the exit) is out
	final   string
	cost    *turnCost
	tokens  *model.TokenCount
}

type turnCost struct {
	usd         float64
	out, cumOut int
}

func (t *Turn) stop() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.stopped {
		t.stopped = true
		close(t.intr)
	}
}

// live reports whether the turn can still show something.
func (t *Turn) live() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.ended && !t.stopped && !t.p.gone()
}

// Say adds a text item to the thread.
func (t *Turn) Say(text string) {
	if !t.live() {
		return
	}
	t.mu.Lock()
	t.final = text
	t.mu.Unlock()
	t.p.emit(agent.Event{Kind: agent.EvText, MsgID: t.id("msg"), Text: text})
}

// Tool adds a tool item with its result, as a tool the agent ran by itself.
func (t *Turn) Tool(name string, input any, result string, isErr bool) {
	if !t.live() {
		return
	}
	id, raw := t.id("toolu"), rawJSON(input)
	t.p.emit(agent.Event{Kind: agent.EvToolStart, ToolID: id, ToolName: name, Input: raw},
		agent.Event{Kind: agent.EvToolInput, ToolID: id, ToolName: name, Input: raw},
		agent.Event{Kind: agent.EvToolResult, ToolID: id, Result: result, IsError: isErr})
}

// Call makes a real MCP tools/call on Fake.MCP with the token and URL the process was spawned
// with, and returns the tool's text and whether it is an error. The call shows in the thread as
// the tool item mcp__board__<tool>. A turn that is over or interrupted calls nothing and gets
// ("", true), as does a process without MCP access.
func (t *Turn) Call(tool string, args any) (text string, isErr bool) {
	if !t.live() {
		return "", true
	}
	id, raw := t.id("toolu"), rawJSON(args)
	name := "mcp__board__" + tool
	t.p.emit(agent.Event{Kind: agent.EvToolStart, ToolID: id, ToolName: name, Input: raw},
		agent.Event{Kind: agent.EvToolInput, ToolID: id, ToolName: name, Input: raw})
	var res struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := t.rpc("tools/call", map[string]any{"name": tool, "arguments": raw}, &res); err != nil {
		text, isErr = err.Error(), true
	} else {
		parts := make([]string, 0, len(res.Content))
		for _, c := range res.Content {
			parts = append(parts, c.Text)
		}
		text, isErr = strings.Join(parts, "\n"), res.IsError
	}
	if t.live() {
		t.p.emit(agent.Event{Kind: agent.EvToolResult, ToolID: id, Result: text, IsError: isErr})
	}
	return text, isErr
}

// Tools makes a real MCP tools/list and returns the names, in the server's order. nil when the
// process has no MCP access or the turn is over.
func (t *Turn) Tools() []string {
	if !t.live() {
		return nil
	}
	var res struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if err := t.rpc("tools/list", map[string]any{}, &res); err != nil {
		return nil
	}
	names := make([]string, 0, len(res.Tools))
	for _, tl := range res.Tools {
		names = append(names, tl.Name)
	}
	return names
}

// rpc posts one JSON-RPC request to Fake.MCP as the process would: to the URL it was given, with
// its token as the bearer credential.
func (t *Turn) rpc(method string, params any, result any) error {
	h, acc := t.p.f.MCP, t.Opts.MCP
	if h == nil || acc == nil {
		return errors.New("the process has no MCP access")
	}
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": t.id("rpc"), "method": method, "params": params})
	if err != nil {
		return err
	}
	url := acc.MCPURL
	if url == "" {
		url = "/mcp"
	}
	req := httptest.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+acc.Token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		return fmt.Errorf("mcp %s: status %d: %s", method, w.Code, strings.TrimSpace(w.Body.String()))
	}
	var out struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		return fmt.Errorf("mcp %s: %w", method, err)
	}
	if out.Error != nil {
		return fmt.Errorf("mcp %s: %s", method, out.Error.Message)
	}
	return json.Unmarshal(out.Result, result)
}

// Cost sets what the turn's end reports: CostUSD (with HasCost), OutTokens and CumOutTokens, raw
// as an adapter gives them. A Cursor process reports no cost, whatever the script says.
func (t *Turn) Cost(usd float64, out, cumOut int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cost = &turnCost{usd, out, cumOut}
}

// Tokens sets the token counts the turn's end reports: CumTokens (with HasTokens), raw as an
// adapter gives them. A Cursor process reports no tokens, whatever the script says.
func (t *Turn) Tokens(cum model.TokenCount) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.tokens = &cum
}

// Context reports the context a request of the turn was made with: EvUsage with CtxIn.
func (t *Turn) Context(in int) {
	if !t.live() {
		return
	}
	t.p.emit(agent.Event{Kind: agent.EvUsage, CtxIn: in})
}

// Fail ends the turn with an error. The process stays.
func (t *Turn) Fail(text string) {
	if !t.live() {
		return
	}
	t.end(agent.Event{Kind: agent.EvTurnEnd, Error: text})
}

// FailTemp ends the turn with an error the CLI reported as temporary (design D1). The process stays.
func (t *Turn) FailTemp(kind agent.Temporary, text string) {
	if !t.live() {
		return
	}
	t.end(agent.Event{Kind: agent.EvTurnEnd, Error: text, Temporary: kind})
}

// Exit ends the process in the turn: no turn end, EvExit with text.
func (t *Turn) Exit(text string) {
	t.mu.Lock()
	if t.ended {
		t.mu.Unlock()
		return
	}
	t.ended = true
	t.mu.Unlock()
	t.p.exit(text)
}

// Hang blocks until the turn is interrupted or its process is closed.
func (t *Turn) Hang() { <-t.intr }

// Interrupted is closed when the turn is interrupted or its process is closed.
func (t *Turn) Interrupted() <-chan struct{} { return t.intr }

// end sends the turn's end with its cost and tokens, once.
func (t *Turn) end(ev agent.Event) {
	t.mu.Lock()
	if t.ended {
		t.mu.Unlock()
		return
	}
	t.ended = true
	if c := t.cost; c != nil && t.p.f.Kind != model.Cursor {
		ev.CostUSD, ev.HasCost, ev.OutTokens, ev.CumOutTokens = c.usd, true, c.out, c.cumOut
	}
	if c := t.tokens; c != nil && t.p.f.Kind != model.Cursor {
		ev.CumTokens, ev.HasTokens = *c, true
	}
	if t.p.f.Kind == model.Claude {
		ev.NumTurns, ev.Final = 1, t.final
	}
	t.mu.Unlock()
	t.p.emit(ev)
}

// finish is the script's return: the turn ends as stopped when it was interrupted, else cleanly.
func (t *Turn) finish() {
	t.mu.Lock()
	stopped := t.stopped
	t.mu.Unlock()
	t.end(agent.Event{Kind: agent.EvTurnEnd, Aborted: stopped})
}

func (t *Turn) id(prefix string) string {
	t.p.mu.Lock()
	defer t.p.mu.Unlock()
	t.p.tools++
	return fmt.Sprintf("%s_%s_%d", prefix, t.p.session, t.p.tools)
}

func rawJSON(v any) json.RawMessage {
	if v == nil {
		return json.RawMessage(`{}`)
	}
	if raw, ok := v.(json.RawMessage); ok {
		return raw
	}
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return b
}
