package servers

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"unicode"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
)

const (
	maxDetail = 300      // characters of a text of Go's or of the other server's
	maxAgents = 16       // agent kinds taken from another server
	maxHello  = 64 << 10 // bytes read of a hello
	maxState  = 32 << 20 // bytes read of a state
)

// Target is what a test connects to: the form's fields as typed.
type Target struct {
	Address, Secret string
	SelfSigned      bool
	Pin             string
}

// Identity is what a test compares the answering server's instance id with.
type Identity struct {
	LocalID string            // this server's instance id; "" takes Options.LocalID
	Others  map[string]string // instance id → name of the entry that has it; without the edited entry
	Expect  string            // the instance id the edited entry has stored, or ""
}

// Result is a test's answer to the page. Every text in it is plain text.
type Result struct {
	OK           bool              `json:"ok"` // true for connected alone
	Step         int               `json:"step"`
	Outcome      Outcome           `json:"outcome"`
	Message      string            `json:"message"`
	Detail       string            `json:"detail,omitempty"`      // Go's text or the other server's
	Fingerprint  string            `json:"fingerprint,omitempty"` // the presented certificate's
	Pinned       string            `json:"pinned,omitempty"`
	Version      string            `json:"version,omitempty"`
	InstanceID   string            `json:"instanceId,omitempty"`
	FeatureLevel int               `json:"featureLevel,omitempty"`
	Agents       []model.AgentKind `json:"agents,omitempty"`
}

// result is the Result of an outcome at its step of the table.
func result(o Outcome) Result {
	return Result{OK: o == OutcomeConnected, Step: o.Step(), Outcome: o, Message: o.Message()}
}

// problemResult is the Result of a connection that was not made. Go's text may quote the
// server's certificate, so it is shown without secret.
func problemResult(err error, secret string) Result {
	var p *Problem
	if !errors.As(err, &p) {
		r := result(OutcomeTLSError)
		r.Detail = cleanOf(err.Error(), secret)
		return r
	}
	r := result(p.Outcome)
	r.Detail, r.Fingerprint, r.Pinned = hide(p.Detail, secret), p.Fingerprint, p.Pinned
	return r
}

// TestConnection tries t in five steps and says where it ended: the address, the dial, TLS,
// hello and the state. Each step has Timing.TestStep. The secret is sent from step 4 on, so only
// after the certificate was accepted: with the box on and no pin the test ends at step 3 with
// the fingerprint of the certificate, read in a handshake that sends no request. No text of the
// Result holds the secret, whatever the server answers.
func TestConnection(ctx context.Context, t Target, id Identity, o Options) Result {
	step := o.Timing.withDefaults().TestStep
	local := id.LocalID
	if local == "" {
		local = o.LocalID
	}

	// 1: the address.
	address, host, port, err := ParseAddress(t.Address)
	if err != nil {
		return result(OutcomeBadAddress)
	}

	// 2 and 3: the dial and TLS.
	if t.SelfSigned && t.Pin == "" {
		fp, err := readCertificate(ctx, o.Dial, host, port, step, step)
		if err != nil {
			return problemResult(err, t.Secret)
		}
		r := result(OutcomeFingerprint)
		r.Fingerprint = fp
		return r
	}
	trust := Trust{SelfSigned: t.SelfSigned, Pin: t.Pin, Roots: o.Roots}
	conn, err := dialTLS(ctx, o.Dial, host, port, trust, step, step)
	if err != nil {
		return problemResult(err, t.Secret)
	}
	defer conn.Close()

	// Steps 4 and 5 use that connection. Should the server close it in between, the next one is
	// made by dialTLS under the same trust.
	tr := newTransport(o.Dial, trust, Timing{Dial: step, Handshake: step, Headers: step})
	defer tr.CloseIdleConnections()
	var first atomic.Pointer[tls.Conn]
	first.Store(conn)
	again := tr.DialTLSContext
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if c := first.Swap(nil); c != nil {
			return c, nil
		}
		return again(ctx, network, addr)
	}
	client := &http.Client{
		Transport: tr,
		// A redirect is not followed: the secret goes to the tested address alone.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	get := func(path string, limit int64) (status int, body []byte, err error) {
		sctx, cancel := context.WithTimeout(ctx, step)
		defer cancel()
		req, err := http.NewRequestWithContext(sctx, http.MethodGet, address+path, nil)
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set(remote.SecretHeader, t.Secret)
		req.Header.Set(remote.ClientHeader, local)
		resp, err := client.Do(req)
		if err != nil {
			return 0, nil, err
		}
		defer resp.Body.Close()
		body, err = io.ReadAll(io.LimitReader(resp.Body, limit))
		return resp.StatusCode, body, err
	}

	// 4: hello.
	status, body, err := get(HelloPath, maxHello)
	if err != nil {
		return noAnswer(err, 4, t.Secret)
	}
	switch {
	case status == http.StatusUnauthorized:
		return result(OutcomeSecretRefused)
	case status == http.StatusForbidden && errorOf(body) == "bad host":
		return result(OutcomeBadHost)
	case status != http.StatusOK:
		r := result(OutcomeNotAIWB)
		r.Detail = "HTTP " + strconv.Itoa(status)
		if msg := cleanOf(errorOf(body), t.Secret); msg != "" {
			r.Detail += ": " + msg
		}
		return r
	}
	var hello map[string]json.RawMessage
	if json.Unmarshal(body, &hello) != nil {
		return result(OutcomeNotAIWB)
	}
	instance := stringOf(hello["instanceId"])
	if stringOf(hello["app"]) != "ai-whiteboard" || !remote.ValidID(instance) {
		return result(OutcomeNotAIWB)
	}
	version := cleanOf(stringOf(hello["version"]), t.Secret)
	level := 0 // a missing level, or one that is no integer, counts as 0
	_ = json.Unmarshal(hello["featureLevel"], &level)
	seen := func(o Outcome) Result {
		r := result(o)
		r.Version, r.InstanceID, r.FeatureLevel = version, instance, level
		return r
	}
	switch {
	case level < MinFeatureLevel:
		return seen(OutcomeTooOld)
	case instance == local:
		return seen(OutcomeIsLocal)
	}
	if name, ok := id.Others[instance]; ok {
		r := seen(OutcomeDuplicate)
		r.Message += " " + name
		return r
	}
	if id.Expect != "" && instance != id.Expect {
		return seen(OutcomeAnotherServer)
	}

	// 5: the state.
	status, body, err = get(StatePath, maxState)
	if err != nil {
		r := noAnswer(err, 5, t.Secret)
		r.Version, r.InstanceID, r.FeatureLevel = version, instance, level
		return r
	}
	agents, ok := stateAgents(body, t.Secret)
	if status != http.StatusOK || !ok {
		return seen(OutcomeNoState)
	}
	r := seen(OutcomeConnected)
	r.Agents = agents
	return r
}

// noAnswer is the Result of a request of step 4 or 5 that got no answer: the outcome of a new
// connection that was refused, or no_answer.
func noAnswer(err error, step int, secret string) Result {
	var p *Problem
	if errors.As(err, &p) {
		return problemResult(p, secret)
	}
	r := result(OutcomeNoAnswer)
	r.Step = step
	var netErr net.Error
	if !errors.Is(err, context.DeadlineExceeded) && !(errors.As(err, &netErr) && netErr.Timeout()) {
		r.Detail = cleanOf(err.Error(), secret)
	}
	return r
}

// errorOf is the "error" text of a JSON error answer, or "".
func errorOf(body []byte) string {
	var v struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &v) != nil {
		return ""
	}
	return v.Error
}

// stringOf is raw as a JSON string, or "" when it is none.
func stringOf(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

// stateAgents checks the parts of an API snapshot a client requires (agents, catalogs, home,
// defaultCwd, chats) and returns its usable agents as cleanAgents makes them.
func stateAgents(body []byte, secret string) ([]model.AgentKind, bool) {
	var parts map[string]json.RawMessage
	if json.Unmarshal(body, &parts) != nil {
		return nil, false
	}
	var (
		agents     []string
		catalogs   map[string]json.RawMessage
		home, cwd  string
		chats      []json.RawMessage
		isArray    = func(raw json.RawMessage) bool { return bytes.HasPrefix(bytes.TrimSpace(raw), []byte("[")) }
		isObject   = func(raw json.RawMessage) bool { return bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) }
		isString   = func(raw json.RawMessage) bool { return bytes.HasPrefix(bytes.TrimSpace(raw), []byte(`"`)) }
		unmarshals = json.Unmarshal(parts["agents"], &agents) == nil &&
			json.Unmarshal(parts["catalogs"], &catalogs) == nil &&
			json.Unmarshal(parts["home"], &home) == nil &&
			json.Unmarshal(parts["defaultCwd"], &cwd) == nil &&
			json.Unmarshal(parts["chats"], &chats) == nil
	)
	// Unmarshal takes null for anything, so the kinds are checked too.
	if !unmarshals || !isArray(parts["agents"]) || !isObject(parts["catalogs"]) || home == "" ||
		!isString(parts["defaultCwd"]) || !isArray(parts["chats"]) {
		return nil, false
	}
	return cleanAgents(agents, secret), true
}

// cleanAgents makes a list of agent kinds from another server fit to show: each one cleaned and
// without secret, the empty ones left out, at most maxAgents of them.
func cleanAgents(in []string, secret string) []model.AgentKind {
	out := make([]model.AgentKind, 0, min(len(in), maxAgents))
	for _, a := range in {
		if len(out) == maxAgents {
			break
		}
		if a = cleanOf(a, secret); a != "" {
			out = append(out, model.AgentKind(a))
		}
	}
	return out
}

// clean makes a text of Go's or of another server fit to show: valid UTF-8, no control
// characters, at most maxDetail characters.
func clean(s string) string { return cut(strip(s)) }

// cleanOf is clean for a text the server of an entry or of a test may have written: every
// occurrence of that entry's secret in it is replaced by "…", before the text is cut. The secret
// is looked for once more after the characters that are not shown are gone, which may have
// stood inside it.
func cleanOf(s, secret string) string {
	return cut(hide(strip(hide(s, secret)), secret))
}

// hide replaces every occurrence of secret in s by "…": no text of another server brings an
// entry's secret back to a page.
func hide(s, secret string) string {
	if secret == "" {
		return s
	}
	return strings.ReplaceAll(s, secret, "…")
}

// strip takes out of s what is not shown: invalid UTF-8, control characters, space at the ends.
func strip(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == unicode.ReplacementChar {
			return -1
		}
		return r
	}, strings.ToValidUTF8(s, ""))
	return strings.TrimSpace(s)
}

// cut is s with at most maxDetail characters.
func cut(s string) string {
	if r := []rune(s); len(r) > maxDetail {
		s = string(r[:maxDetail])
	}
	return s
}
