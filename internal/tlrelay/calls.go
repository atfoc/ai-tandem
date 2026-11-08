package tlrelay

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/headless"
)

// Agent is the agent of a tool call, as its marker on the board names it (design 8).
type Agent struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
}

// ToolCall is one agent tool call on a new board.
type ToolCall struct {
	Chat, Branch string
	ChatBoard    string // the chat's board → params "board"
	Board        string // the board the call is about → params "target" and CallSpec.Board
	Tool         string // → params "name"
	Args         any    // → params "args", marshalled as given
	Agent        Agent  // → params "agent"
}

// toolParams are the params of the rpc the board host gets (design 3.2).
type toolParams struct {
	Chat   string `json:"chat"`
	Branch string `json:"branch"`
	Board  string `json:"board"`
	Target string `json:"target"`
	Name   string `json:"name"`
	Args   any    `json:"args"`
	Kind   string `json:"kind"`
	Agent  Agent  `json:"agent"`
}

// The texts the agent reads (design 3.2, 3.3). CallTool's errors have these as their Error().
const (
	HostStoppedText = "HOST_STOPPED: the board host stopped while it ran this call, so the call did not finish. " +
		"The board is as it was after your last finished change. Read the board again before you change it."
	TimeoutText = "TIMEOUT: the board host did not answer in 30 s and was restarted. Read the board again before you change it."
)

// UnavailableText is what the agent reads when the board host cannot run.
func UnavailableText(reason string) string {
	return "UNAVAILABLE: the board host could not start: " + strings.TrimRight(reason, ". ") +
		". New boards cannot be read or changed until it can; tell the user."
}

// ErrHostLost is the CallSpec.Lost of a tool call: the board host's stream ended while it ran.
// Its text is HostStoppedText.
var ErrHostLost = errors.New(HostStoppedText)

// noHostReason is the reason when no host manager was set.
const noHostReason = "this server does not run the board host"

// textError is an error whose text is what the agent reads, and that unwraps to its cause.
type textError struct {
	text  string
	cause error
}

func (e *textError) Error() string { return e.text }
func (e *textError) Unwrap() error { return e.cause }

// reasonOf turns a failed Ensure into the reason a person reads.
func reasonOf(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "it did not start in time"
	case errors.Is(err, context.Canceled):
		return "the request was cancelled"
	}
	// The manager's error is "<its words for ErrUnavailable>: <reason>" ("the board host is not
	// available: …"); the reason alone is what goes into the texts.
	if errors.Is(err, headless.ErrUnavailable) {
		if inner := errors.Unwrap(err); inner != nil {
			return strings.TrimPrefix(err.Error(), inner.Error()+": ")
		}
	}
	return err.Error()
}

// CallTool sends an agent's tool call on a new board to the board host and returns its answer: a
// JSON string or {text, image}. A returned error's Error() is the complete text for the agent.
func (r *Relay) CallTool(c ToolCall) (json.RawMessage, error) {
	start := r.now()
	r.mu.Lock()
	host := r.host
	r.lastCall = start
	r.mu.Unlock()

	res, outcome, err := r.callTool(host, c)

	end := r.now()
	r.mu.Lock()
	r.lastCall = end
	n := r.calls[c.Tool]
	if n == nil {
		n = &Counts{}
		r.calls[c.Tool] = n
	}
	switch outcome {
	case "ok":
		n.OK++
	case "lost":
		n.Lost++
	case "timeout":
		n.Timeout++
	case "unavailable":
		n.Unavailable++
	default:
		n.Error++
	}
	r.mu.Unlock()

	r.logf("tl: %s board=%s chat=%s -> board host %s %dms", c.Tool, c.Board, c.Chat, outcome, end.Sub(start).Milliseconds())
	return res, err
}

// callTool does the call with no lock held. outcome is "ok", "error CODE", "lost", "timeout" or
// "unavailable".
func (r *Relay) callTool(host Host, c ToolCall) (json.RawMessage, string, error) {
	if host == nil {
		return nil, "unavailable", &textError{text: UnavailableText(noHostReason)}
	}
	ctx, cancel := context.WithTimeout(context.Background(), r.callTimeout)
	hostID, err := host.Ensure(ctx)
	cancel()
	if err != nil {
		return nil, "unavailable", &textError{text: UnavailableText(reasonOf(err)), cause: err}
	}
	spec := editorbridge.CallSpec{
		Method: "tool",
		Params: toolParams{
			Chat: c.Chat, Branch: c.Branch, Board: c.ChatBoard, Target: c.Board,
			Name: c.Tool, Args: c.Args, Kind: "tl", Agent: c.Agent,
		},
		Board:  c.Board,
		Client: hostID,
		Lost:   ErrHostLost,
	}
	res, err := r.bridge.CallBoard(spec, r.callTimeout)
	switch {
	case err == nil:
		return res, "ok", nil
	case errors.Is(err, ErrHostLost), errors.Is(err, editorbridge.ErrNoClient):
		return nil, "lost", &textError{text: HostStoppedText, cause: ErrHostLost}
	case errors.Is(err, editorbridge.ErrTimeout):
		host.CallTimedOut()
		return nil, "timeout", &textError{text: TimeoutText, cause: err}
	}
	return nil, "error " + codeOf(err.Error()), err
}

// codeOf is the code of a "CODE: text" error, "UNKNOWN" when the text has none.
func codeOf(s string) string {
	if i := strings.IndexByte(s, ':'); i > 0 && !strings.ContainsAny(s[:i], " \t\n") {
		return s[:i]
	}
	return "UNKNOWN"
}
