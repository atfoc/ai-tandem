package servers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
)

// ErrNotConnected is Do's answer for an entry whose stream is not open: nothing was sent.
var ErrNotConnected = errors.New("the server is not connected")

// ErrTooLong ends a stream with an event, and a call with an answer, of more than maxState bytes.
var ErrTooLong = errors.New("the server's answer is too long")

// Reply is a remote server's answer to a call passed on with Do, whatever its status.
type Reply struct {
	Status      int
	ContentType string
	Body        []byte
	Header      http.Header // the answer's headers; nil for a Reply that came with an error
}

// The causes of an ending that no outcome of the test's table names.
const (
	causeNoStream = "no_stream" // the stream did not open, or its first events did not come
	causeEnded    = "ended"     // the open stream ended
	causeSilence  = "silence"   // the open stream was silent for Timing.Silence
)

// The detail of an unreachable entry whose attempt got as far as the stream.
const (
	detailNoStream = "The server's event stream did not open"
	detailEnded    = "The connection to the server ended"
	detailSilence  = "The server went silent"
)

// conn is the connection of one entry as it was saved: one goroutine that says hello, holds the
// event stream and opens it again. An edit of more than the name, and an accept, make a new conn
// for the entry; the new one starts when the old one's goroutine has ended, so the hooks of one
// entry are called in order.
type conn struct {
	m      *Manager
	entry  Entry // as saved when the conn was made; the name and the instance id are read from the list
	ctx    context.Context
	cancel context.CancelFunc
	prev   <-chan struct{} // the end of the conn this one replaced, or nil
	done   chan struct{}   // closed when the goroutine ended
	retry  chan struct{}   // capacity 1; see Retry

	// Under m.mu.
	shown    shown
	cause    string // what the last attempt ended with: an Outcome or a cause; "" before any
	lists    Lists
	hasLists bool
	link     *link // set while the stream is open and its snapshot was read
	waiting  bool  // the goroutine waits for the back-off or for Retry
	removed  bool  // ended by Remove: Hooks.Removed is the goroutine's last call
}

// link is one open stream, with the client the calls of Do go through while it is open.
type link struct {
	client  *http.Client
	stop    context.CancelFunc // ends the stream
	refused atomic.Bool        // a call was answered 401
}

// ending is how an attempt ended: the state to enter and what the view then shows.
type ending struct {
	state               State
	cause               string
	detail, fingerprint string
	version             string        // hello's, when a valid hello was read
	up                  bool          // the stream was open
	open                time.Duration // how long it was, from its snapshot on
}

// ended is the ending of an outcome of the test's table, with the outcome's message as detail
// for the states that have no text of their own.
func ended(o Outcome) ending {
	e := ending{state: stateOf(o), cause: string(o)}
	if e.state == StateUnreachable || e.state == StateAnotherServer {
		e.detail = o.Message()
	}
	return e
}

// failed is the ending of a request that got no answer: the outcome of the connection that was
// not made, or no_answer. Go's text may quote the server's certificate, so it is shown without
// secret.
func failed(err error, secret string) ending {
	var p *Problem
	if !errors.As(err, &p) {
		return ended(OutcomeNoAnswer)
	}
	e := ended(p.Outcome)
	switch e.state {
	case StateCertificateNotAccepted:
		if e.detail = hide(p.Detail, secret); e.detail == "" { // Go's text
			e.detail = p.Outcome.Message()
		}
	case StateCertificateChanged:
		e.fingerprint = p.Fingerprint
	}
	return e
}

// run is the conn's goroutine.
func (c *conn) run() {
	m := c.m
	defer m.wg.Done()
	defer close(c.done)
	if c.prev != nil {
		<-c.prev
	}
	select {
	case <-m.started:
	case <-c.ctx.Done():
	}
	if c.ctx.Err() == nil {
		c.change(func() {}) // tells Hooks.State that a replaced conn's state became connecting
		c.loop()
	}
	m.mu.Lock()
	removed, h := c.removed, m.hooks
	m.mu.Unlock()
	if removed && h.Removed != nil {
		h.Removed(c.entry.ID)
	}
}

// loop makes attempts until the conn is cancelled. After an attempt that ended in a state that
// retries it waits for the back-off; in a state that stops it waits for Retry. The back-off
// starts again after a stream that stayed open for Timing.Stable: one that ended sooner counts
// as one more failed attempt, so a server that drops every stream is asked ever less often.
func (c *conn) loop() {
	tm := c.m.o.Timing
	for n := 0; ; {
		e := c.attempt()
		if c.ctx.Err() != nil {
			return
		}
		if e.up && e.open >= tm.Stable {
			n = 0
		}
		c.enter(e)
		if e.state.stops() {
			if !c.wait(0, true) {
				return
			}
			c.enter(ending{state: StateConnecting})
			n = 0
			continue
		}
		if !c.wait(tm.backoff(n), false) {
			return
		}
		n++
	}
}

// wait blocks for d, or without end when stopped is set. Retry ends it early. It returns false
// when the conn was cancelled.
func (c *conn) wait(d time.Duration, stopped bool) bool {
	m := c.m
	m.mu.Lock()
	c.waiting = true
	select {
	case <-c.retry: // a Retry of before this wait
	default:
	}
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		c.waiting = false
		m.mu.Unlock()
	}()
	var over <-chan time.Time
	if !stopped {
		t := time.NewTimer(d)
		defer t.Stop()
		over = t.C
	}
	select {
	case <-c.ctx.Done():
		return false
	case <-c.retry:
		return true
	case <-over:
		return true
	}
}

// Retry makes a conn that waits try now: one in a stopped state goes to connecting, one in its
// back-off keeps its state. A conn that is connected or in an attempt is left alone, and so is
// one that only an accept or an edit gets going again.
func (c *conn) Retry() {
	m := c.m
	m.mu.Lock()
	defer m.mu.Unlock()
	if !c.waiting || c.shown.state == StateFingerprintNotAccepted || c.shown.state == StateCertificateChanged {
		return
	}
	select {
	case c.retry <- struct{}{}:
	default:
	}
}

// change runs f, which changes the conn's fields, under the manager's lock. When the conn's part
// of the view is then another, a server_state event is queued, and Hooks.State is told a new
// state. A conn that was replaced or removed changes nothing.
func (c *conn) change(f func()) {
	m, id := c.m, c.entry.ID
	m.mu.Lock()
	if m.conns[id] != c {
		m.mu.Unlock()
		return
	}
	was := c.shown
	f()
	if !was.equal(c.shown) {
		if e, ok := m.list.Get(id); ok {
			m.queueLocked(stateEvent{Type: "server_state", Server: viewOf(e, c.shown)})
		}
	}
	from, to := m.told[id], c.shown.state
	m.told[id] = to
	h := m.hooks
	m.mu.Unlock()
	if from != to && h.State != nil {
		h.State(id, from, to)
	}
}

// enter puts the conn in the state an attempt ended with. While a state that retries stays for
// the same cause, its detail stays too: Go's text may differ at every attempt, and no event is
// sent per attempt.
func (c *conn) enter(e ending) {
	c.change(func() {
		s := &c.shown
		if e.version != "" {
			s.version = e.version
		}
		if s.state == e.state && c.cause == e.cause && e.state.retries() {
			return
		}
		s.state, s.detail, s.fingerprint, c.cause = e.state, e.detail, e.fingerprint, e.cause
	})
}

// noRedirect keeps a client from following a redirect: the secret goes to the entry's address alone.
func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// headerLimit returns ctx for one request and the function to call when its answer's headers
// arrived. cancel, which must end ctx, is called when they did not arrive within limit after the
// request was written. The transport's own header limit is not used: it would also end the calls
// of Do, whose limits are their callers'.
func headerLimit(ctx context.Context, cancel context.CancelFunc, limit time.Duration) (context.Context, func()) {
	var mu sync.Mutex
	var timer *time.Timer
	arrived := false
	trace := &httptrace.ClientTrace{WroteRequest: func(httptrace.WroteRequestInfo) {
		mu.Lock()
		defer mu.Unlock()
		if !arrived && timer == nil {
			timer = time.AfterFunc(limit, cancel)
		}
	}}
	return httptrace.WithClientTrace(ctx, trace), func() {
		mu.Lock()
		defer mu.Unlock()
		arrived = true
		if timer != nil {
			timer.Stop()
		}
	}
}

// request is a request to the entry's server with the secret and this server's id as client id.
func (c *conn) request(ctx context.Context, method, pathAndQuery string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.entry.Address+pathAndQuery, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set(remote.SecretHeader, c.entry.Secret)
	req.Header.Set(remote.ClientHeader, c.m.o.LocalID)
	return req, nil
}

// attempt is one attempt: hello, the identity and level checks, then the stream until it ends.
// Nothing is dialed with the box on and no pin. Every connection is made by dialTLS, by a
// transport of this attempt alone.
func (c *conn) attempt() ending {
	m, tm, id := c.m, c.m.o.Timing, c.entry.ID
	if c.entry.SelfSigned && c.entry.Pin == "" {
		return ended(OutcomeFingerprint)
	}
	noHeaderLimit := tm
	noHeaderLimit.Headers = 0
	tr := newTransport(m.o.Dial, Trust{SelfSigned: c.entry.SelfSigned, Pin: c.entry.Pin, Roots: m.o.Roots}, noHeaderLimit)
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, CheckRedirect: noRedirect}

	// Hello.
	status, body, err := c.hello(client)
	if err != nil {
		return failed(err, c.entry.Secret)
	}
	switch {
	case status == http.StatusUnauthorized:
		return ended(OutcomeSecretRefused)
	case status == http.StatusForbidden && errorOf(body) == "bad host":
		return ended(OutcomeBadHost)
	case status != http.StatusOK:
		return ended(OutcomeNotAIWB)
	}
	var hello map[string]json.RawMessage
	if json.Unmarshal(body, &hello) != nil {
		return ended(OutcomeNotAIWB)
	}
	instance := stringOf(hello["instanceId"])
	if stringOf(hello["app"]) != "ai-whiteboard" || !remote.ValidID(instance) {
		return ended(OutcomeNotAIWB)
	}
	version := cleanOf(stringOf(hello["version"]), c.entry.Secret)
	with := func(e ending) ending { e.version = version; return e }
	level := 0 // a missing level, or one that is no integer, counts as 0
	_ = json.Unmarshal(hello["featureLevel"], &level)
	if level < MinFeatureLevel {
		return with(ended(OutcomeTooOld))
	}
	refusal, name, current := m.claim(c, instance)
	if !current {
		return ending{}
	}
	if refusal != "" {
		e := ended(refusal)
		if refusal == OutcomeDuplicate {
			e.detail += " " + name
		}
		return with(e)
	}

	// The stream. It has no time limit but for its headers and its first events; the watchdog
	// ends it when no byte came for Silence.
	sctx, stop := context.WithCancel(c.ctx)
	defer stop()
	hctx, arrived := headerLimit(sctx, stop, tm.Headers)
	req, err := c.request(hctx, http.MethodGet, StreamPath+"?client="+url.QueryEscape(m.o.LocalID), nil)
	if err != nil {
		return with(ended(OutcomeNoAnswer))
	}
	req.Header.Set("Accept", "text/event-stream")
	resp, err := client.Do(req)
	arrived()
	if err != nil {
		return with(failed(err, c.entry.Secret))
	}
	defer resp.Body.Close()
	notOpen := with(ending{state: StateUnreachable, cause: causeNoStream, detail: detailNoStream})
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return with(ended(OutcomeSecretRefused))
	case resp.StatusCode == http.StatusForbidden:
		first := time.AfterFunc(tm.FirstEvent, stop)
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxHello))
		first.Stop()
		if errorOf(body) == "bad host" {
			return with(ended(OutcomeBadHost))
		}
		return notOpen
	case resp.StatusCode != http.StatusOK,
		!strings.HasPrefix(strings.ToLower(resp.Header.Get("Content-Type")), "text/event-stream"):
		return notOpen
	}
	var silent atomic.Bool
	first := time.AfterFunc(tm.FirstEvent, stop)
	defer first.Stop()
	silence := time.AfterFunc(tm.Silence, func() { silent.Store(true); stop() })
	defer silence.Stop()
	br := bufio.NewReaderSize(&watched{r: resp.Body, seen: func() { silence.Reset(tm.Silence) }}, 32<<10)

	// The stream begins with hello and the snapshot; anything before the snapshot is passed over.
	var raw []byte
	for {
		if raw, err = readEvent(br); err != nil {
			return notOpen
		}
		typ, ok := typeOf(raw)
		if !ok {
			return notOpen
		}
		if typ == "snapshot" {
			break
		}
	}
	lists, ok := listsOf(raw, c.entry.Secret)
	if !ok {
		return with(ended(OutcomeNoState))
	}
	if !first.Stop() {
		return notOpen
	}

	// Connected: the lists, Hooks.Snapshot, Hooks.Back, then the state.
	since := time.Now()
	l := &link{client: client, stop: stop}
	m.mu.Lock()
	if m.conns[id] != c {
		m.mu.Unlock()
		return ending{}
	}
	c.lists, c.hasLists, c.link = lists, true, l
	before, h := m.before[id], m.hooks
	m.before[id] = true
	m.mu.Unlock()
	if h.Snapshot != nil {
		h.Snapshot(id, raw)
	}
	if before && h.Back != nil {
		h.Back(id)
	}
	c.change(func() {
		c.shown, c.cause = shown{state: StateConnected, version: version, agents: lists.Agents}, string(OutcomeConnected)
	})

	for c.ctx.Err() == nil {
		if raw, err = readEvent(br); err != nil {
			break
		}
		typ, ok := typeOf(raw)
		if !ok {
			break // not an event of ours: the next stream starts from a snapshot again
		}
		c.keep(typ, raw)
		if h.Event != nil {
			h.Event(id, typ, raw)
		}
	}

	m.mu.Lock()
	c.link = nil
	m.mu.Unlock()
	e := with(ending{state: StateUnreachable, cause: causeEnded, detail: detailEnded})
	switch {
	case l.refused.Load():
		e = with(ended(OutcomeSecretRefused))
	case silent.Load():
		e.cause, e.detail = causeSilence, detailSilence
	}
	e.up, e.open = true, time.Since(since)
	return e
}

// hello asks GET /api/hello within Timing.Hello, its headers within Timing.Headers.
func (c *conn) hello(client *http.Client) (status int, body []byte, err error) {
	ctx, cancel := context.WithTimeout(c.ctx, c.m.o.Timing.Hello)
	defer cancel()
	hctx, arrived := headerLimit(ctx, cancel, c.m.o.Timing.Headers)
	req, err := c.request(hctx, http.MethodGet, HelloPath, nil)
	if err != nil {
		return 0, nil, err
	}
	resp, err := client.Do(req)
	arrived()
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err = io.ReadAll(io.LimitReader(resp.Body, maxHello))
	return resp.StatusCode, body, err
}

// keep takes from an event what the manager itself shows and hands out: the usable agents of an
// "agents" event go to the view and the lists, the model list of a "catalog" event to the lists.
// A catalog of anything but an agent kind this build knows is not kept: the server chooses the
// names, and each one would stay for as long as the connection.
func (c *conn) keep(typ string, raw []byte) {
	switch typ {
	case "agents":
		var ev struct {
			Agents []string `json:"agents"`
		}
		if json.Unmarshal(raw, &ev) != nil {
			return
		}
		agents := cleanAgents(ev.Agents, c.entry.Secret)
		c.change(func() { c.shown.agents, c.lists.Agents = agents, agents })
	case "catalog":
		var ev struct {
			Agent   string         `json:"agent"`
			Catalog *model.Catalog `json:"catalog"`
		}
		if json.Unmarshal(raw, &ev) != nil || !catalogKind(model.AgentKind(ev.Agent)) {
			return
		}
		c.change(func() {
			catalogs := make(map[model.AgentKind]*model.Catalog, len(c.lists.Catalogs)+1)
			for k, v := range c.lists.Catalogs {
				catalogs[k] = v
			}
			catalogs[model.AgentKind(ev.Agent)] = ev.Catalog
			c.lists.Catalogs = catalogs
		})
	}
}

// do passes one call on through l's client. A 401 ends the stream: the secret is not accepted.
func (c *conn) do(ctx context.Context, l *link, method, path string, body []byte, limit time.Duration) (Reply, error) {
	if limit <= 0 {
		limit = c.m.o.Timing.Call
	}
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := c.request(ctx, method, path, rd)
	if err != nil {
		return Reply{}, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := l.client.Do(req)
	if err != nil {
		return Reply{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		l.refused.Store(true)
		l.stop()
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxState+1))
	if err != nil {
		return Reply{}, err
	}
	if len(b) > maxState {
		return Reply{}, ErrTooLong
	}
	return Reply{Status: resp.StatusCode, ContentType: resp.Header.Get("Content-Type"), Body: b, Header: resp.Header}, nil
}

// watched calls seen for every read that brought bytes: the stream's sign of life.
type watched struct {
	r    io.Reader
	seen func()
}

func (w *watched) Read(p []byte) (int, error) {
	n, err := w.r.Read(p)
	if n > 0 {
		w.seen()
	}
	return n, err
}

// readEvent reads an event stream up to the end of its next event and returns that event's data.
// Comment lines, the pings among them, and fields other than data are passed over.
func readEvent(br *bufio.Reader) ([]byte, error) {
	var data []byte
	have := false
	for {
		line, err := readLine(br, maxState-len(data))
		if err != nil {
			return nil, err
		}
		switch {
		case len(line) == 0:
			if have {
				return data, nil
			}
		case bytes.HasPrefix(line, []byte("data:")):
			if have {
				data = append(data, '\n')
			}
			data = append(data, bytes.TrimPrefix(line[len("data:"):], []byte(" "))...)
			have = true
		}
	}
}

// readLine reads one line of at most limit bytes, without its end.
func readLine(br *bufio.Reader, limit int) ([]byte, error) {
	var line []byte
	for {
		part, err := br.ReadSlice('\n')
		if len(line)+len(part) > limit {
			return nil, ErrTooLong
		}
		line = append(line, part...)
		if err == nil {
			return bytes.TrimRight(line, "\r\n"), nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

// typeOf is an event's "type"; ok is false for data that is no JSON object.
func typeOf(raw []byte) (typ string, ok bool) {
	var ev struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &ev) != nil {
		return "", false
	}
	return ev.Type, true
}

// listsOf reads the lists of an API snapshot; ok is false when a part a client requires is missing.
func listsOf(raw []byte, secret string) (Lists, bool) {
	agents, ok := stateAgents(raw, secret)
	if !ok {
		return Lists{}, false
	}
	var v struct {
		Catalogs   map[model.AgentKind]*model.Catalog `json:"catalogs"`
		Home       string                             `json:"home"`
		DefaultCwd string                             `json:"defaultCwd"`
	}
	if json.Unmarshal(raw, &v) != nil {
		return Lists{}, false
	}
	for k := range v.Catalogs {
		if !catalogKind(k) {
			delete(v.Catalogs, k)
		}
	}
	return Lists{Agents: agents, Catalogs: v.Catalogs, Home: v.Home, DefaultCwd: v.DefaultCwd}, true
}

// catalogKind reports whether k is an agent kind whose model list is kept.
func catalogKind(k model.AgentKind) bool {
	return k == model.Claude || k == model.Cursor || k == model.Pi
}
