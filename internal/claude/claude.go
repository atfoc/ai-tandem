// Package claude is the agent adapter for the Claude Code CLI, driven as
// `claude -p` with stream-json on stdin and stdout, one process per chat.
package claude

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/boardtools"
)

// Spawner starts Claude chat processes.
type Spawner struct {
	Bin     string // -claude flag, default "claude"
	AppRoot string // data folder
	Home    string
	Prompt  string // prompts.Claude()
}

const stderrCap = 64 * 1024

type proc struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	writeMu sync.Mutex
	events  chan agent.Event // buffered 1024
	perms   sync.Map         // request id → can_use_tool request (pending)
	stderr  *bytes.Buffer
	s       *Spawner
	done    chan struct{} // closed once the process has been waited for

	// translate state (only touched by the read loop)
	curMsg   string
	streamed map[string]bool
	blocks   map[int]string // content block index → "text" or the tool_use id
}

// Args are the command-line arguments for one chat process.
func (s *Spawner) Args(o agent.SpawnOptions) []string {
	args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json",
		"--verbose", "--include-partial-messages", "--permission-mode", "auto", "--permission-prompt-tool", "stdio"}
	if o.Resume {
		args = append(args, "--resume", o.SessionID)
	} else {
		args = append(args, "--session-id", o.SessionID)
	}
	if o.Model != "" {
		args = append(args, "--model", o.Model)
	}
	if o.Effort != "" && o.Model != "haiku" {
		args = append(args, "--effort", o.Effort)
	}
	args = append(args, "--disallowedTools", strings.Join(AppDirRules(s.AppRoot, s.Home), ","))
	if o.Board != nil {
		mcp := fmt.Sprintf(`{"mcpServers":{"board":{"type":"http","url":%q}}}`, o.Board.MCPURL)
		allowed := []string{}
		for _, t := range boardtools.Tools {
			allowed = append(allowed, "mcp__board__"+t.Name)
		}
		args = append(args, "--append-system-prompt", s.Prompt, "--mcp-config", mcp,
			"--allowedTools", strings.Join(allowed, ","))
	}
	return args
}

// AppDirRules are Claude permission rules that deny the app's folder.
// Under the home folder they use "~/" paths, otherwise "//" absolute paths (Claude's rule syntax).
func AppDirRules(root, home string) []string {
	p := "//" + strings.TrimPrefix(root, "/")
	if rel, ok := under(home, root); ok {
		p = "~/" + rel
	}
	base := filepath.Base(root)
	return []string{"Read(" + p + "/**)", "Edit(" + p + "/**)", "Write(" + p + "/**)", "Bash(*" + base + "*)"}
}

// under reports whether path lies strictly inside dir, and returns it relative to dir (with "/").
func under(dir, path string) (string, bool) {
	if dir == "" || path == "" {
		return "", false
	}
	rel, err := filepath.Rel(filepath.Clean(dir), filepath.Clean(path))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, "../") || filepath.IsAbs(rel) {
		return "", false
	}
	return filepath.ToSlash(rel), true
}

// Spawn starts the process and returns at once.
func (s *Spawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if _, err := os.Stat(o.Cwd); err != nil {
		return nil, agent.ErrFolderMissing
	}
	bin := s.Bin
	if bin == "" {
		bin = "claude"
	}
	p := &proc{
		events:   make(chan agent.Event, 1024),
		stderr:   &bytes.Buffer{},
		s:        s,
		done:     make(chan struct{}),
		streamed: map[string]bool{},
		blocks:   map[int]string{},
	}
	cmd := exec.Command(bin, s.Args(o)...)
	cmd.Dir = o.Cwd
	cmd.Env = append(os.Environ(), "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1") // chats neither read nor write auto-memory
	cmd.Stderr = &cappedWriter{buf: p.stderr, max: stderrCap}
	stdin, err1 := cmd.StdinPipe()
	stdout, err2 := cmd.StdoutPipe()
	if err := errors.Join(err1, err2); err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p.cmd = cmd
	p.stdin = stdin
	go p.readLoop(stdout)
	return p, nil
}

// cappedWriter keeps the first max bytes written and drops the rest.
type cappedWriter struct {
	buf *bytes.Buffer
	max int
}

func (w *cappedWriter) Write(b []byte) (int, error) {
	if room := w.max - w.buf.Len(); room > 0 {
		if len(b) > room {
			w.buf.Write(b[:room])
		} else {
			w.buf.Write(b)
		}
	}
	return len(b), nil
}

func (p *proc) Events() <-chan agent.Event { return p.events }

func (p *proc) readLoop(stdout io.Reader) {
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		var m map[string]any
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		switch m["type"] {
		case "control_request":
			p.handleControl(m)
			continue
		case "control_response":
			continue // answers to our interrupts; the result line tells the rest
		}
		for _, ev := range p.translate(m) {
			p.events <- ev
		}
	}
	// Drain whatever is left so the process is not blocked writing to a full pipe.
	io.Copy(io.Discard, stdout)
	err := p.cmd.Wait()
	close(p.done)
	msg := strings.TrimSpace(p.stderr.String())
	if msg == "" && err != nil {
		msg = err.Error()
	}
	p.events <- agent.Event{Kind: agent.EvExit, ExitErr: msg}
	close(p.events)
}

func (p *proc) handleControl(m map[string]any) {
	id, _ := m["request_id"].(string)
	req, _ := m["request"].(map[string]any)
	if req["subtype"] != "can_use_tool" {
		p.write(map[string]any{"type": "control_response", "response": map[string]any{
			"subtype": "error", "request_id": id, "error": "unsupported control request"}})
		return
	}
	input := rawJSON(req["input"])
	if agent.TouchesAppDir(input, p.s.AppRoot, p.s.Home) {
		p.write(deny(id, agent.AppDirDenied)) // no card
		return
	}
	p.perms.Store(id, req)
	toolName, _ := req["tool_name"].(string)
	toolID, _ := req["tool_use_id"].(string)
	p.events <- agent.Event{Kind: agent.EvPermRequest, PermID: id, ToolName: toolName, ToolID: toolID, Input: input}
}

func deny(id, message string) map[string]any {
	return map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": id,
		"response": map[string]any{"behavior": "deny", "message": message}}}
}

// Decide answers a pending can_use_tool request.
func (p *proc) Decide(requestID string, allow bool) error {
	v, ok := p.perms.LoadAndDelete(requestID)
	if !ok {
		return errors.New("no such request")
	}
	if !allow {
		return p.write(deny(requestID, "The user said no in AI Whiteboard."))
	}
	req := v.(map[string]any)
	return p.write(map[string]any{"type": "control_response", "response": map[string]any{
		"subtype": "success", "request_id": requestID,
		"response": map[string]any{"behavior": "allow", "updatedInput": req["input"]}}})
}

func (p *proc) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_, err = p.stdin.Write(append(b, '\n'))
	return err
}

// Send posts one user turn.
func (p *proc) Send(blocks []agent.ContentBlock) error {
	content := make([]map[string]any, 0, len(blocks))
	for _, b := range blocks {
		content = append(content, map[string]any{"type": "text", "text": b.Text})
	}
	return p.write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})
}

// Interrupt stops the current turn; the process stays alive.
func (p *proc) Interrupt() error {
	return p.write(map[string]any{"type": "control_request", "request_id": "int_" + randHex(4),
		"request": map[string]any{"subtype": "interrupt"}})
}

// Close closes stdin, then kills the process if it has not exited after 3 s.
func (p *proc) Close() {
	p.writeMu.Lock()
	p.stdin.Close()
	p.writeMu.Unlock()
	go func() {
		select {
		case <-p.done:
		case <-time.After(3 * time.Second):
			p.cmd.Process.Kill()
		}
	}()
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// rawJSON re-encodes a decoded JSON value; nil stays nil.
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
