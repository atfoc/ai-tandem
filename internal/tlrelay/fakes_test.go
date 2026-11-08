package tlrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/headless"
	"ai-whiteboard/internal/model"
)

const clientHeader = "X-AIWB-Client"

// fakeBridge records SendTo per client and scripts CallBoard. It takes its own lock, as the real
// bridge does: the relay calls it under relay.mu.
type fakeBridge struct {
	mu       sync.Mutex
	known    map[string]bool
	hasCalls map[string]bool
	events   map[string][]any
	tries    map[string]int // SendTo calls per client, sent or not
	specs    []editorbridge.CallSpec
	timeouts []time.Duration
	call     func(spec editorbridge.CallSpec) (json.RawMessage, error)
}

func newFakeBridge() *fakeBridge {
	return &fakeBridge{known: map[string]bool{}, hasCalls: map[string]bool{}, events: map[string][]any{}, tries: map[string]int{}}
}

func (b *fakeBridge) SendTo(id string, ev any) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.tries[id]++
	if !b.known[id] {
		return false
	}
	b.events[id] = append(b.events[id], ev)
	return true
}

func (b *fakeBridge) CallBoard(spec editorbridge.CallSpec, timeout time.Duration) (json.RawMessage, error) {
	b.mu.Lock()
	b.specs = append(b.specs, spec)
	b.timeouts = append(b.timeouts, timeout)
	f := b.call
	b.mu.Unlock()
	if f == nil {
		return json.RawMessage(`"done"`), nil
	}
	return f(spec)
}

func (b *fakeBridge) Known(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.known[id]
}

func (b *fakeBridge) HasCalls(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.hasCalls[id]
}

func (b *fakeBridge) setKnown(id string, k bool) {
	b.mu.Lock()
	b.known[id] = k
	b.mu.Unlock()
}

// take returns and forgets the events sent to id.
func (b *fakeBridge) take(id string) []any {
	b.mu.Lock()
	defer b.mu.Unlock()
	ev := b.events[id]
	delete(b.events, id)
	return ev
}

// triesTo is the number of SendTo calls to id, delivered or not.
func (b *fakeBridge) triesTo(id string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.tries[id]
}

func (b *fakeBridge) all(id string) []any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]any(nil), b.events[id]...)
}

// fakeHost is a Host whose Ensure is scripted.
type fakeHost struct {
	mu       sync.Mutex
	ensure   func(ctx context.Context) (string, error)
	ensures  int
	timedOut int
	status   headless.Status
}

func (h *fakeHost) Ensure(ctx context.Context) (string, error) {
	h.mu.Lock()
	h.ensures++
	f := h.ensure
	h.mu.Unlock()
	return f(ctx)
}

func (h *fakeHost) CallTimedOut() {
	h.mu.Lock()
	h.timedOut++
	h.mu.Unlock()
}

func (h *fakeHost) Status() headless.Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.status
}

func (h *fakeHost) counts() (ensures, timedOut int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ensures, h.timedOut
}

// fakeBoards is a Boards in memory.
type fakeBoards struct {
	mu      sync.Mutex
	boards  map[string]model.Board
	snaps   map[string][]byte
	saveErr error
}

func (s *fakeBoards) Get(id string) (model.Board, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.boards[id]
	return b, ok
}

func (s *fakeBoards) SnapshotAt(id string) ([]byte, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.snaps[id]
	return b, ok, nil
}

func (s *fakeBoards) SaveSnapshot(id string, body []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.saveErr != nil {
		return s.saveErr
	}
	s.snaps[id] = append([]byte(nil), body...)
	return nil
}

func (s *fakeBoards) archive(id string) {
	s.mu.Lock()
	b := s.boards[id]
	b.Archived = true
	s.boards[id] = b
	s.mu.Unlock()
}

// fakeClock is an injectable now.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// rig is a relay with fakes, whose board host "h1" is up, and windows "w1", "w2" with streams.
// Boards: "b1", "b2" (new boards), "old" (classic), "arch" (archived new board).
type rig struct {
	t      *testing.T
	r      *Relay
	br     *fakeBridge
	bs     *fakeBoards
	host   *fakeHost
	ad     headless.Bridge
	mux    *http.ServeMux
	clock  *fakeClock
	logMu  sync.Mutex
	logged []string

	hostMu  sync.Mutex
	current string // the id the fake host's Ensure returns
}

const quiet = time.Minute

func newRig(t *testing.T) *rig {
	g := &rig{t: t, br: newFakeBridge(), clock: &fakeClock{t: time.Unix(1_800_000_000, 0)}}
	g.bs = &fakeBoards{
		boards: map[string]model.Board{
			"b1":   {ID: "b1", Kind: model.KindTL},
			"b2":   {ID: "b2", Kind: model.KindTL},
			"old":  {ID: "old"},
			"arch": {ID: "arch", Kind: model.KindTL, Archive: model.Archive{Archived: true}},
		},
		snaps: map[string][]byte{},
	}
	g.r = New(g.br, g.bs, quiet, func(f string, a ...any) {
		g.logMu.Lock()
		g.logged = append(g.logged, fmt.Sprintf(f, a...))
		g.logMu.Unlock()
	})
	g.r.now = g.clock.now
	g.r.callTimeout = 2 * time.Second
	g.r.openTimeout = 2 * time.Second
	g.ad = g.r.hostAdapter(g.br)
	g.host = &fakeHost{ensure: func(context.Context) (string, error) { return g.hostID(), nil }}
	g.r.SetHost(g.host)
	g.startHost("h1")
	g.br.setKnown("w1", true)
	g.br.setKnown("w2", true)
	g.mux = http.NewServeMux()
	g.r.Mount(g.mux, clientHeader)
	return g
}

func (g *rig) hostID() string {
	g.hostMu.Lock()
	defer g.hostMu.Unlock()
	return g.current
}

// startHost does what the manager and the bridge do for a new process: SetAway, then its stream opens.
func (g *rig) startHost(id string) {
	g.ad.SetAway(id)
	g.br.setKnown(id, true)
	g.hostMu.Lock()
	g.current = id
	g.hostMu.Unlock()
}

// endClient does what the bridge does when a stream ends: the record goes, then OnEnd.
func (g *rig) endClient(id string) {
	g.br.setKnown(id, false)
	g.r.ClientEnded(id)
}

// replaceStream does what the bridge does when a client's stream is replaced by a new one with the
// same id: the new record is already there when OnEnd runs.
func (g *rig) replaceStream(id string) {
	g.r.ClientEnded(id)
}

// do serves one request and returns the status and the decoded JSON body (nil for none).
func (g *rig) do(method, path, client string, body any) (int, map[string]any) {
	g.t.Helper()
	code, raw, _ := g.doRaw(method, path, client, body)
	if len(bytes.TrimSpace(raw)) == 0 {
		return code, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		g.t.Fatalf("%s %s: answer %d is not JSON: %q", method, path, code, raw)
	}
	return code, m
}

func (g *rig) doRaw(method, path, client string, body any) (int, []byte, http.Header) {
	var rd *bytes.Reader
	switch b := body.(type) {
	case nil:
		rd = bytes.NewReader(nil)
	case string:
		rd = bytes.NewReader([]byte(b))
	case []byte:
		rd = bytes.NewReader(b)
	default:
		j, err := json.Marshal(b)
		if err != nil {
			panic(err)
		}
		rd = bytes.NewReader(j)
	}
	req := httptest.NewRequest(method, path, rd)
	if client != "" {
		req.Header.Set(clientHeader, client)
	}
	rec := httptest.NewRecorder()
	g.mux.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes(), rec.Header()
}

// open opens a session and fails the test unless it is answered 200.
func (g *rig) open(board, window string) string {
	g.t.Helper()
	code, m := g.do("POST", "/api/tl/"+board+"/open", window, map[string]any{})
	if code != 200 {
		g.t.Fatalf("open %s by %s: %d %v", board, window, code, m)
	}
	s, _ := m["session"].(string)
	return s
}

func (g *rig) sessionCount() int {
	g.r.mu.Lock()
	defer g.r.mu.Unlock()
	return len(g.r.sessions)
}

func (g *rig) logs() []string {
	g.logMu.Lock()
	defer g.logMu.Unlock()
	return append([]string(nil), g.logged...)
}

// typeOf is the "type" of a recorded event.
func typeOf(ev any) string {
	switch e := ev.(type) {
	case syncEvent:
		return e.Type
	case closedEvent:
		return e.Type
	case sessionEvent:
		return e.Type
	case dropEvent:
		return e.Type
	}
	return fmt.Sprintf("%T", ev)
}

// sessionOf is the session of a recorded event, "" for tl_drop.
func sessionOf(ev any) string {
	switch e := ev.(type) {
	case syncEvent:
		return e.Session
	case closedEvent:
		return e.Session
	case sessionEvent:
		return e.Session
	}
	return ""
}

// types lists the types of events, for messages.
func types(evs []any) string {
	var s []string
	for _, e := range evs {
		s = append(s, typeOf(e)+":"+sessionOf(e))
	}
	return strings.Join(s, " ")
}

// wire is the event as the bridge would send it: marshalled and decoded again.
func wire(t *testing.T, ev any) map[string]any {
	t.Helper()
	j, err := json.Marshal(ev)
	if err != nil {
		t.Fatalf("marshal %#v: %v", ev, err)
	}
	var m map[string]any
	if err := json.Unmarshal(j, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

var errBoom = errors.New("boom")
