// Package codex runs Codex App Server as a Tandem chat runtime.
package codex

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/gitworker"
)

const (
	rpcTimeout        = 20 * time.Second
	permissionProfile = "tandem"
	gitWorkerProfile  = "tandem-git-worker"
)

type Spawner struct {
	Bin     string
	AppRoot string
	Prompt  string
}

var (
	_ agent.Spawner = (*Spawner)(nil)
	_ agent.Forker  = (*Spawner)(nil)
	_ agent.Agent   = (*proc)(nil)
)

type proc struct {
	conn     *rpcConn
	opts     agent.SpawnOptions
	events   chan agent.Event
	ready    chan struct{}
	readyErr error
	threadID string // written during handshake

	mu           sync.Mutex
	active       *activeTurn
	perm         map[string]approval
	pendingUsage *usageUpdate

	// Item state belongs to the notification reader.
	items     map[string]*itemState
	tokens    usageTokens
	hasTokens bool
}

type activeTurn struct {
	id    string
	ready chan struct{}
}

func (s *Spawner) bin() string {
	if s.Bin == "" {
		return "codex"
	}
	return s.Bin
}

func initialize(ctx context.Context, c *rpcConn) error {
	if err := c.call(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "tandem", "title": "AI Whiteboard", "version": "1"},
		"capabilities": map[string]bool{"experimentalApi": true},
	}, nil); err != nil {
		return err
	}
	return c.notify("initialized", nil)
}

func (s *Spawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	return s.start(o, nil)
}

func (s *Spawner) SpawnFork(o agent.SpawnOptions, src agent.ForkSource) (agent.Agent, string, error) {
	if src.SessionID == "" || (src.Point == "" && !src.End) {
		return nil, "", errors.New("Codex needs a completed turn to fork this session")
	}
	p, err := s.start(o, &src)
	if err != nil {
		return nil, "", err
	}
	<-p.ready
	if p.readyErr != nil {
		p.Close()
		if p.threadID != "" {
			s.DiscardFork(p.threadID)
		}
		return nil, "", p.readyErr
	}
	return p, p.threadID, nil
}

func (s *Spawner) DiscardFork(sessionID string) {
	if sessionID == "" {
		return
	}
	// Deletion operates by thread ID, independent of the chat's MCP credentials.
	_ = s.probe(func(ctx context.Context, c *rpcConn) error {
		return c.call(ctx, "thread/delete", map[string]string{"threadId": sessionID}, nil)
	})
}

func (s *Spawner) start(o agent.SpawnOptions, src *agent.ForkSource) (*proc, error) {
	if o.GitWorkspace.Path != "" {
		if !o.Subagent || s.AppRoot == "" || o.Cwd != o.GitWorkspace.Path {
			return nil, errors.New("a Git workspace requires a Codex subagent and Whiteboard state directory")
		}
		if err := gitworker.Validate(s.AppRoot, o.GitWorkspace); err != nil {
			return nil, err
		}
	}
	if o.Cwd != "" {
		if fi, err := os.Stat(o.Cwd); os.IsNotExist(err) || (err == nil && !fi.IsDir()) {
			return nil, agent.ErrFolderMissing
		} else if err != nil {
			return nil, err
		}
	}
	p := &proc{
		opts:   o,
		events: make(chan agent.Event, 128),
		ready:  make(chan struct{}),
		perm:   make(map[string]approval),
		items:  make(map[string]*itemState),
	}
	c, err := startRPC(context.Background(), s.bin(), []string{"app-server"}, o.Cwd, nil, p.onNotification, p.onRequest)
	if err != nil {
		return nil, err
	}
	p.conn = c
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), rpcTimeout)
		defer cancel()
		p.readyErr = s.openThread(ctx, p, src)
		if p.readyErr != nil {
			p.readyErr = errors.New(p.redact(p.readyErr.Error()))
		}
		close(p.ready)
		if p.readyErr != nil {
			_ = c.close()
		}
		<-c.done
		e := agent.Event{Kind: agent.EvExit}
		if p.readyErr != nil {
			e.ExitErr = p.readyErr.Error()
		} else if err := c.err(); err != nil {
			e.ExitErr = p.redact(err.Error())
		}
		p.events <- e
		close(p.events)
	}()
	return p, nil
}

func (s *Spawner) openThread(ctx context.Context, p *proc, src *agent.ForkSource) error {
	if err := initialize(ctx, p.conn); err != nil {
		return err
	}
	o := p.opts
	params := s.threadParams(o)
	method := "thread/start"
	switch {
	case src != nil:
		method = "thread/fork"
		params["threadId"] = src.SessionID
		params["excludeTurns"] = true
		if src.Point != "" {
			params["lastTurnId"] = src.Point
		}
	case o.Resume && o.SessionID != "":
		method = "thread/resume"
		params["threadId"] = o.SessionID
		params["excludeTurns"] = true
	}
	var r struct {
		Thread                  struct{ ID string }
		ActivePermissionProfile *struct{ ID string }
		RuntimeWorkspaceRoots   []string
	}
	if err := p.conn.call(ctx, method, params, &r); err != nil {
		return err
	}
	if r.Thread.ID == "" {
		return fmt.Errorf("%s: Codex returned no thread ID", method)
	}
	p.mu.Lock()
	p.threadID = r.Thread.ID
	usage := p.pendingUsage
	p.pendingUsage = nil
	p.mu.Unlock()
	if profile, ok := params["permissions"].(string); ok && (r.ActivePermissionProfile == nil || r.ActivePermissionProfile.ID != profile) {
		return errors.New("Codex did not apply Tandem's sandbox profile. Use Codex CLI 0.170.0 or later.")
	}
	if o.GitWorkspace.Path != "" && !slices.Equal(r.RuntimeWorkspaceRoots, []string{o.Cwd}) {
		return fmt.Errorf("Codex did not use the Git clone as its sole runtime workspace root: %v", r.RuntimeWorkspaceRoots)
	}
	if method == "thread/start" {
		// App Server creates the rollout lazily. Make the ID resumable even if
		// the first turn is rejected or the process stops before it starts.
		if err := p.conn.call(ctx, "thread/name/set", map[string]string{
			"threadId": p.threadID, "name": "Tandem chat",
		}, nil); err != nil {
			return err
		}
	}
	p.emit(agent.Event{Kind: agent.EvSession, SessionID: p.threadID})
	if usage != nil && usage.ThreadID == p.threadID {
		p.emit(usage.event())
	}
	return nil
}

func (s *Spawner) threadParams(o agent.SpawnOptions) map[string]any {
	config := map[string]any{"features.multi_agent": false}
	params := map[string]any{
		"config": config, "approvalPolicy": "on-request", "approvalsReviewer": "user",
	}
	if s.AppRoot != "" {
		profile := permissionProfile
		filesystem := map[string]string{s.AppRoot: "deny"}
		if binding := o.GitWorkspace; binding.Path != "" {
			profile = gitWorkerProfile
			// Parent metadata can live under an inherited writable temp root, or
			// outside the checkout entirely when the chat uses a linked worktree.
			filesystem[binding.SourceRoot] = "read"
			filesystem[filepath.Join(binding.SourceRoot, ".git")] = "deny"
			filesystem[binding.SourceGitDir] = "deny"
			filesystem[binding.SourceCommonDir] = "deny"
			filesystem[filepath.Join(binding.Path, ".git")] = "write"
			params["runtimeWorkspaceRoots"] = []string{binding.Path}
		}
		config["permissions"] = map[string]any{
			profile: map[string]any{
				"extends":    ":workspace",
				"filesystem": filesystem,
			},
		}
		params["permissions"] = profile
		// `permissions` selects the profile for thread/start only. Codex rebuilds its
		// configuration from the config layers when it sets up each model request (Codex
		// 0.170.0, workspace routing), and a config that defines profiles but names no
		// default fails there with "failed to load workspace requirements: invalid input
		// parameter", after thread/start has already succeeded. Name the default too.
		config["default_permissions"] = profile
	} else {
		params["sandbox"] = "workspace-write"
	}
	if o.Cwd != "" {
		params["cwd"] = o.Cwd
	}
	if o.Model != "" {
		params["model"] = o.Model
	}
	if o.Effort != "" {
		config["model_reasoning_effort"] = o.Effort
	}
	if o.BoardID != "" && s.Prompt != "" {
		params["developerInstructions"] = s.Prompt
	}
	if o.MCP != nil && o.MCP.MCPURL != "" {
		config["mcp_servers.board"] = map[string]any{
			"url": o.MCP.MCPURL, "required": true,
			"http_headers": map[string]string{"Authorization": "Bearer " + o.MCP.Token},
		}
	}
	return params
}

func (p *proc) Events() <-chan agent.Event { return p.events }

func (p *proc) emit(e agent.Event) {
	if p.conn.ctx.Err() != nil {
		return
	}
	select {
	case p.events <- e:
	case <-p.conn.ctx.Done():
	}
}

func (p *proc) redact(s string) string {
	if mcp := p.opts.MCP; mcp != nil && mcp.Token != "" {
		return strings.ReplaceAll(s, mcp.Token, "[redacted]")
	}
	return s
}

func (p *proc) Send(blocks []agent.ContentBlock) error {
	<-p.ready
	if p.readyErr != nil {
		return p.readyErr
	}
	input := make([]map[string]any, 0, len(blocks))
	for _, b := range blocks {
		switch {
		case b.Image != nil:
			url := "data:" + b.Image.Type + ";base64," + base64.StdEncoding.EncodeToString(b.Image.Data)
			input = append(input, map[string]any{"type": "image", "url": url})
		case b.Text != "":
			input = append(input, map[string]any{"type": "text", "text": b.Text, "text_elements": []any{}})
		}
	}
	if len(input) == 0 {
		return errors.New("the message is empty")
	}
	p.mu.Lock()
	if p.active != nil {
		p.mu.Unlock()
		return errors.New("a Codex turn is already running")
	}
	t := &activeTurn{ready: make(chan struct{})}
	p.active = t
	p.mu.Unlock()

	params := map[string]any{"threadId": p.threadID, "input": input}
	if p.opts.Effort != "" {
		params["effort"] = p.opts.Effort
	}
	var r struct{ Turn struct{ ID string } }
	ctx, cancel := context.WithTimeout(context.Background(), rpcTimeout)
	defer cancel()
	err := p.conn.call(ctx, "turn/start", params, &r)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.active != t {
		return nil // the turn completed before its start response was dispatched
	}
	if err != nil || r.Turn.ID == "" {
		p.active = nil
		if t.id == "" {
			close(t.ready)
		}
		if err == nil {
			err = errors.New("turn/start: Codex returned no turn ID")
		}
		return err
	}
	if t.id == "" {
		t.id = r.Turn.ID
		close(t.ready)
	}
	return nil
}

// Steer targets the current turn by ID so a race with its completion cannot
// accidentally start a new turn.
func (p *proc) Steer(steerID string, blocks []agent.ContentBlock) error {
	input := make([]map[string]any, 0, len(blocks))
	for _, b := range blocks {
		if b.Image != nil {
			input = append(input, map[string]any{"type": "image", "url": "data:" + b.Image.Type + ";base64," + base64.StdEncoding.EncodeToString(b.Image.Data)})
		} else if b.Text != "" {
			input = append(input, map[string]any{"type": "text", "text": b.Text, "text_elements": []any{}})
		}
	}
	if len(input) == 0 {
		return errors.New("the message is empty")
	}
	p.mu.Lock()
	t := p.active
	p.mu.Unlock()
	if t == nil {
		return agent.ErrSteerUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), rpcTimeout)
	defer cancel()
	select {
	case <-t.ready:
	case <-p.conn.done:
		return p.conn.err()
	case <-ctx.Done():
		return ctx.Err()
	}
	p.mu.Lock()
	live, id := p.active == t, t.id
	p.mu.Unlock()
	if !live || id == "" {
		return agent.ErrSteerUnavailable
	}
	err := p.conn.call(ctx, "turn/steer", map[string]any{"threadId": p.threadID, "expectedTurnId": id, "clientUserMessageId": steerID, "input": input}, nil)
	var rejection *rpcError
	if errors.As(err, &rejection) {
		return fmt.Errorf("%w: %v", agent.ErrSteerUnavailable, err)
	}
	return err
}

func (p *proc) Interrupt() error {
	p.mu.Lock()
	t := p.active
	p.mu.Unlock()
	if t == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), rpcTimeout)
	defer cancel()
	select {
	case <-t.ready:
	case <-p.conn.done:
		return p.conn.err()
	case <-ctx.Done():
		return ctx.Err()
	}
	p.mu.Lock()
	live := p.active == t
	id := t.id
	p.mu.Unlock()
	if !live {
		return nil
	}
	return p.conn.call(ctx, "turn/interrupt", map[string]string{"threadId": p.threadID, "turnId": id}, nil)
}

func (p *proc) Close() { _ = p.conn.close() }
