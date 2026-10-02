package pi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"ai-whiteboard/internal/agent"
)

// Spawner starts pi chat processes.
type Spawner struct {
	Bin       string // -pi flag, default "pi"
	AppRoot   string // data folder
	Home      string
	Extension string // absolute path of the materialized app extension ("" = none)
	Prompt    string // prompts.Pi(); written to a file for board chats
	Bridge    agent.BridgeRegistry

	// mcpConfigExtra is a test-only seam: extra non-board MCP servers merged into the
	// board chat's AIWB_MCP_CONFIG so tests can exercise the A6 permission rule (a
	// non-board MCP tool asks; the board tool does not). Production code never sets it,
	// and it can never replace the app-owned "board" key.
	mcpConfigExtra map[string]mcpServerConfig
}

const (
	stderrCap        = 64 * 1024
	eventsCap        = 512
	handshakeTimeout = 30 * time.Second
	rpcTimeout       = 30 * time.Second
)

// killGraceNanos is the graceful-shutdown window Close gives a run before it SIGTERMs the
// process group and killGroup waits before SIGKILL. Atomic so tests can shorten it without
// racing the shutdown goroutines.
var killGraceNanos atomic.Int64

func init() { killGraceNanos.Store(int64(3 * time.Second)) }

// killGrace is the current graceful-shutdown window.
func killGrace() time.Duration { return time.Duration(killGraceNanos.Load()) }

var (
	_ agent.Spawner         = (*Spawner)(nil)
	_ agent.Agent           = (*proc)(nil)
	_ agent.ContextSplitter = (*proc)(nil)
	_ agent.RunHandler      = (*proc)(nil)
)

func (s *Spawner) bin() string {
	if s.Bin == "" {
		return "pi"
	}
	return s.Bin
}

// lookPath resolves the pi binary, naming it in the error so a missing pi is understandable. The
// result is absolute: children get it as AIWB_PI_BIN.
func (s *Spawner) lookPath() (string, error) {
	bin, err := exec.LookPath(s.bin())
	if err != nil {
		return "", fmt.Errorf("cannot find the pi binary %q: %w", s.bin(), err)
	}
	if abs, err := filepath.Abs(bin); err == nil {
		bin = abs
	}
	return bin, nil
}

type proc struct {
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	rpc      *rpcClient
	events   chan agent.Event
	ready    chan struct{} // closed by the handshake
	done     chan struct{} // closed once the process has been waited for
	readyErr error         // written before ready is closed, read after
	s        *Spawner
	o        agent.SpawnOptions
	stderr   *cappedBuffer

	socketPath  string
	runToken    string
	sessionID   string
	sessionFile string
	modelWindow atomic.Int64

	closing atomic.Bool
	emu     sync.Mutex // guards closed and sends on events
	closed  bool

	abortMu      sync.Mutex
	abortPending bool

	perms sync.Map // tool call id → chan permDecision (a pending ask)

	// translate state (only touched by the read loop)
	msgSeq      int
	toolByIndex map[int]string // content index → tool call id
	toolEmit    map[string]*toolEmit
	extErrOnce  sync.Once

	// subagent activity ordering (see subagent.go)
	subMu     sync.Mutex
	announced map[string]bool
	subQueue  []queuedActivity
}

type toolEmit struct{ start, input bool }

// cappedBuffer keeps the first max bytes written and drops the rest (a stderr tail).
type cappedBuffer struct {
	buf bytes.Buffer
	max int
}

func (w *cappedBuffer) Write(b []byte) (int, error) {
	if room := w.max - w.buf.Len(); room > 0 {
		if len(b) > room {
			w.buf.Write(b[:room])
		} else {
			w.buf.Write(b)
		}
	}
	return len(b), nil
}

func (w *cappedBuffer) String() string { return w.buf.String() }

// Spawn starts pi in the chat's folder and returns at once; the handshake continues in the
// background and Send waits for it.
func (s *Spawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	if fi, err := os.Stat(o.Cwd); err != nil || !fi.IsDir() {
		return nil, agent.ErrFolderMissing
	}
	bin, err := s.lookPath()
	if err != nil {
		return nil, err
	}
	p := &proc{
		events:      make(chan agent.Event, eventsCap),
		ready:       make(chan struct{}),
		done:        make(chan struct{}),
		s:           s,
		o:           o,
		stderr:      &cappedBuffer{max: stderrCap},
		toolByIndex: map[int]string{},
		toolEmit:    map[string]*toolEmit{},
		announced:   map[string]bool{},
	}
	if s.Bridge != nil {
		boardToken := ""
		if o.Board != nil {
			boardToken = o.Board.Token
		}
		socketPath, runToken, err := s.Bridge.RegisterRun(o.ChatID, boardToken, p)
		if err != nil {
			return nil, fmt.Errorf("pi bridge: %w", err)
		}
		p.socketPath, p.runToken = socketPath, runToken
	}
	fail := func(err error) (agent.Agent, error) {
		if p.runToken != "" {
			s.Bridge.DeregisterRun(p.runToken)
		}
		return nil, err
	}
	sessionDir := filepath.Join(s.AppRoot, "chats", o.ChatID, "pi")
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		return fail(err)
	}
	appendPrompt := ""
	if o.Board != nil && s.Prompt != "" {
		appendPrompt = filepath.Join(sessionDir, "append-prompt.md")
		if err := os.WriteFile(appendPrompt, []byte(s.Prompt), 0o600); err != nil {
			return fail(err)
		}
	}
	cmd := exec.Command(bin, s.args(o, sessionDir, appendPrompt)...)
	cmd.Dir = o.Cwd
	cmd.Env = s.env(o, bin, p.socketPath, p.runToken, appendPrompt)
	cmd.Stderr = p.stderr
	stdin, err1 := cmd.StdinPipe()
	stdout, err2 := cmd.StdoutPipe()
	if err := errors.Join(err1, err2); err != nil {
		return fail(err)
	}
	if err := agent.StartGroup(cmd); err != nil {
		return fail(err)
	}
	p.cmd = cmd
	p.stdin = stdin
	p.rpc = newRPC(stdin, p.translateLine)
	go p.rpc.readLoop(stdout)
	go p.handshake()
	go p.waitExit()
	return p, nil
}

func (p *proc) Events() <-chan agent.Event { return p.events }

// emit sends an event unless the channel has been closed.
func (p *proc) emit(ev agent.Event) {
	p.emu.Lock()
	defer p.emu.Unlock()
	if !p.closed {
		p.events <- ev
	}
}

// emitEvents emits translated events in order, announcing every tool start so queued subagent
// activity for that tool call can flush (subagent.go).
func (p *proc) emitEvents(evs []agent.Event) {
	for _, ev := range evs {
		p.emit(ev)
		if ev.Kind == agent.EvToolStart {
			p.announceTool(ev.ToolID)
		}
	}
}

// handshake probes the process, reconciles the session and applies the model and thinking level
// before closing ready. Errors become readyErr and are reported by Send.
func (p *proc) handshake() {
	defer close(p.ready)
	p.readyErr = p.doHandshake()
}

// doHandshake: get_state (readiness + session) → get_available_models → set_model →
// set_thinking_level → EvSession (when the reconciled id differs) + one EvCatalog.
func (p *proc) doHandshake() error {
	deadline := time.Now().Add(handshakeTimeout)
	call := func(command string, fields map[string]any) (rpcResponse, error) {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return rpcResponse{}, fmt.Errorf("pi handshake timed out after %s", handshakeTimeout)
		}
		return p.rpc.call(command, fields, remaining)
	}

	state, err := call("get_state", nil)
	if err != nil {
		return err
	}
	if !state.Success {
		return fmt.Errorf("pi get_state: %s", state.Error)
	}
	models, err := call("get_available_models", nil)
	if err != nil {
		return err
	}
	if !models.Success {
		return fmt.Errorf("pi get_available_models: %s", models.Error)
	}
	cat := catalogFrom(state.Data, models.Data)
	if cat == nil {
		return errors.New("pi reported no models")
	}
	p.applyState(state.Data)

	if p.o.Model != "" {
		provider, modelID, ok := strings.Cut(p.o.Model, "/")
		if !ok {
			provider, modelID = "", p.o.Model
		}
		res, err := call("set_model", map[string]any{"provider": provider, "modelId": modelID})
		if err != nil {
			return err
		}
		if !res.Success {
			return fmt.Errorf("pi set_model %s: %s", p.o.Model, res.Error)
		}
		p.applyModelWindow(res.Data)
	}
	if p.o.Effort != "" {
		res, err := call("set_thinking_level", map[string]any{"level": p.o.Effort})
		if err != nil {
			return err
		}
		if !res.Success {
			return fmt.Errorf("pi set_thinking_level %s: %s", p.o.Effort, res.Error)
		}
	}

	if p.sessionID != "" && p.o.SessionID != "" && p.sessionID != p.o.SessionID {
		p.emit(agent.Event{Kind: agent.EvSession, SessionID: p.sessionID})
	}
	p.emit(agent.Event{Kind: agent.EvCatalog, Catalog: cat})
	return nil
}

// applyState records the session and current model from get_state's data.
func (p *proc) applyState(raw []byte) {
	var st struct {
		SessionID   string          `json:"sessionId"`
		SessionFile string          `json:"sessionFile"`
		Model       json.RawMessage `json:"model"`
	}
	if json.Unmarshal(raw, &st) != nil {
		return
	}
	p.sessionID, p.sessionFile = st.SessionID, st.SessionFile
	p.applyModelWindow(st.Model)
}

// applyModelWindow reads a Model object's contextWindow, if any.
func (p *proc) applyModelWindow(raw []byte) {
	var m struct {
		ContextWindow int `json:"contextWindow"`
	}
	if json.Unmarshal(raw, &m) == nil && m.ContextWindow > 0 {
		p.modelWindow.Store(int64(m.ContextWindow))
	}
}

// waitExit reaps the process, cleans the run up and emits exactly one EvExit, then closes the
// events channel.
func (p *proc) waitExit() {
	<-p.rpc.readDone
	err := p.cmd.Wait()
	agent.Exited(p.cmd)
	// Whatever the agent spawned shares its group, so once the leader is gone kill what is left
	// before it can orphan. This runs for Close too (not only unexpected exits): Close's graceful
	// window can end with the leader exiting first. After Wait the leader's pid may already be
	// reused, so this check is best-effort; killing the remaining group below is the backstop.
	if pgid := p.cmd.Process.Pid; syscall.Kill(-pgid, 0) == nil {
		go killGroup(pgid, killGrace())
	}
	if p.runToken != "" && p.s.Bridge != nil {
		p.s.Bridge.DeregisterRun(p.runToken)
	}
	p.denyPending()
	close(p.done)
	msg := strings.TrimSpace(p.stderr.String())
	if msg == "" && err != nil {
		msg = err.Error()
	}
	p.emu.Lock()
	if !p.closed {
		p.closed = true
		p.events <- agent.Event{Kind: agent.EvExit, ExitErr: msg}
		close(p.events)
	}
	p.emu.Unlock()
}

// killGroup ends what is left of a run's process group after its leader exited: SIGTERM, then
// SIGKILL after grace.
func killGroup(pgid int, grace time.Duration) {
	if err := syscall.Kill(-pgid, syscall.SIGTERM); err != nil {
		return
	}
	for deadline := time.Now().Add(grace); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		if errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH) {
			return
		}
	}
	syscall.Kill(-pgid, syscall.SIGKILL)
}

// Send posts one user turn. It waits for the handshake, joins the blocks' texts and writes one
// prompt command, returning its rejection.
func (p *proc) Send(blocks []agent.ContentBlock) error {
	select {
	case <-p.ready:
	case <-p.done:
		return errors.New("pi exited before the chat was ready")
	}
	if p.readyErr != nil {
		return p.readyErr
	}
	// An Interrupt that arrived while idle must not mark this turn as aborted.
	p.abortMu.Lock()
	p.abortPending = false
	p.abortMu.Unlock()
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	p.emit(agent.Event{Kind: agent.EvThinking})
	resp, err := p.rpc.call("prompt", map[string]any{"message": strings.Join(parts, "\n\n")}, rpcTimeout)
	if err != nil {
		return err
	}
	if !resp.Success {
		text := "pi rejected the prompt: " + resp.Error
		p.emit(agent.Event{Kind: agent.EvTurnEnd, Error: text})
		return errors.New(text)
	}
	return nil
}

// Interrupt asks pi to stop the current turn and tells the run's extension connections to kill
// the subagent trees they own. The abort flag is set before the command so an agent_settled
// racing the write still marks the turn aborted.
func (p *proc) Interrupt() error {
	p.abortMu.Lock()
	p.abortPending = true
	p.abortMu.Unlock()
	if err := p.rpc.send("abort", nil); err != nil {
		return err
	}
	if p.runToken != "" && p.s.Bridge != nil {
		p.s.Bridge.AbortRun(p.runToken)
	}
	return nil
}

// takeAbort consumes the user-abort flag for the turn that is settling.
func (p *proc) takeAbort() bool {
	p.abortMu.Lock()
	defer p.abortMu.Unlock()
	a := p.abortPending
	p.abortPending = false
	return a
}

// Close deregisters the run, closes stdin for the graceful window and then ends the run's whole
// process group (SIGTERM, then SIGKILL after a short grace). The group kill is the shutdown
// backstop: children spawned by the agent share the run's group, so deleting a chat must not
// leave them behind.
func (p *proc) Close() {
	if p.runToken != "" && p.s.Bridge != nil {
		p.s.Bridge.DeregisterRun(p.runToken)
	}
	if !p.closing.CompareAndSwap(false, true) {
		return
	}
	p.stdin.Close()
	pgid := p.cmd.Process.Pid
	grace := killGrace()
	go func() {
		select {
		case <-p.done:
			// The leader exited; waitExit reaps the rest of the group.
		case <-time.After(grace):
			// The graceful window is over: end the group, then SIGKILL what survives.
			syscall.Kill(-pgid, syscall.SIGTERM)
			select {
			case <-p.done:
			case <-time.After(grace):
				syscall.Kill(-pgid, syscall.SIGKILL)
			}
		}
	}()
}
