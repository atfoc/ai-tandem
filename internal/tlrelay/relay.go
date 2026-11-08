// Package tlrelay is the Go side of multiplayer on the new (tldraw) boards: it keeps the sessions
// (one window showing one new board), relays tldraw's sync messages between a window and the board
// host as opaque bytes, serves the board host's snapshot loads and saves, and sends the agents' tool
// calls on new boards to the board host (better-board design 2, 3.2–3.4, 5.1).
//
// # Locking
//
// All of the relay's state (the current host id, the session table, the time of the last tool call,
// the counters) is under one mutex, Relay.mu. The lock order is
//
//	headless manager's lock → Relay.mu → editor bridge's lock
//
// The relay calls the bridge's SendTo, Known and HasCalls while it holds Relay.mu: the bridge never
// calls the relay while it holds its own lock (its OnEnd hook, ClientEnded here, is called after its
// unlock). The manager may call the adapter (SetAway, HoldsAny) while it holds its own lock, so the
// relay never calls a Host method (Ensure, CallTimedOut, Status) nor the bridge's CallBoard while it
// holds Relay.mu. Nor does it call the Boards store while it holds Relay.mu.
//
// A session's events are sent in the same critical section as the change of the session table they
// belong to, so each session's events keep their order (tl_open before any tl_sync; tl_close or
// tl_closed after the last tl_sync) and no event goes out for a session that was dropped.
package tlrelay

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/headless"
	"ai-whiteboard/internal/model"
)

// Production values of the waits; tests lower the Relay's fields.
const (
	// CallTimeout bounds a tool call on the board host, and the start of the host before it.
	CallTimeout = 30 * time.Second
	// OpenTimeout bounds the wait of an open for the board host's start, on top of the request's own
	// context.
	OpenTimeout = 30 * time.Second
)

// Host is what tlrelay needs of the board host's process manager (a *headless.Manager made with the
// board host's options).
type Host interface {
	Ensure(ctx context.Context) (clientID string, err error)
	CallTimedOut()
	Status() headless.Status
}

// Bridge is what tlrelay needs of the editor bridge.
type Bridge interface {
	SendTo(clientID string, ev any) bool
	CallBoard(spec editorbridge.CallSpec, timeout time.Duration) (json.RawMessage, error)
	Known(clientID string) bool
	HasCalls(clientID string) bool
}

// Boards is what tlrelay needs of the board store.
type Boards interface {
	Get(id string) (model.Board, bool)
	SnapshotAt(id string) ([]byte, bool, error) // bool: a snapshot exists
	SaveSnapshot(id string, body []byte) error
}

// Counts are the outcomes of the tool calls of one tool.
type Counts struct {
	OK          int `json:"ok"`
	Error       int `json:"error"`
	Lost        int `json:"lost"`
	Timeout     int `json:"timeout"`
	Unavailable int `json:"unavailable"`
}

// Status is what `status -json` shows under "boardhost" (design 3.4).
type Status struct {
	Available   bool               `json:"available"`
	Reason      string             `json:"reason"`
	Running     bool               `json:"running"`
	PID         int                `json:"pid"`
	Sessions    int                `json:"sessions"`
	Calls       map[string]*Counts `json:"calls"`
	ScreenCalls int                `json:"screenCalls"`
}

// Relay is the session table, the routes, and the agents' calls on new boards.
type Relay struct {
	bridge Bridge
	boards Boards
	quiet  time.Duration
	logf   func(string, ...any)

	// callTimeout and openTimeout are CallTimeout and OpenTimeout; now is time.Now. Fields so that
	// tests need not wait out production waits.
	callTimeout time.Duration
	openTimeout time.Duration
	now         func() time.Time

	mu          sync.Mutex
	host        Host
	hostID      string // the board host's client id, as last given through the adapter's SetAway
	sessions    map[string]*session
	seq         uint64    // order of the sessions' opening, for ScreenClient
	lastCall    time.Time // start or end of the last tool call
	calls       map[string]*Counts
	screenCalls int
}

// New makes a relay. quiet is how long after its last tool call the board host counts as busy (Go's
// process quiet, 60 s in production). logf may be nil.
func New(b Bridge, bs Boards, quiet time.Duration, logf func(string, ...any)) *Relay {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Relay{
		bridge: b, boards: bs, quiet: quiet, logf: logf,
		callTimeout: CallTimeout, openTimeout: OpenTimeout, now: time.Now,
		sessions: map[string]*session{}, calls: map[string]*Counts{},
	}
}

// SetHost sets the board host's manager. Set it once, after the manager is made; until then every
// open and tool call finds the board host unavailable.
func (r *Relay) SetHost(h Host) {
	r.mu.Lock()
	r.host = h
	r.mu.Unlock()
}

func (r *Relay) getHost() Host {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.host
}

// Status returns the host's state and the relay's counters. The map is a copy.
func (r *Relay) Status() Status {
	var s Status
	if h := r.getHost(); h != nil {
		hs := h.Status() // never under r.mu
		s.Available, s.Reason, s.Running, s.PID = hs.Available, hs.Reason, hs.Running, hs.PID
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	s.Sessions = len(r.sessions)
	s.ScreenCalls = r.screenCalls
	s.Calls = make(map[string]*Counts, len(r.calls))
	for k, v := range r.calls {
		c := *v
		s.Calls[k] = &c
	}
	return s
}

// HostAdapter is the headless.Bridge the board host's manager is made with (design 5.1).
func (r *Relay) HostAdapter(b *editorbridge.Bridge) headless.Bridge {
	return r.hostAdapter(b)
}

// clientBridge is the part of the bridge the adapter passes through.
type clientBridge interface {
	Known(clientID string) bool
	HasCalls(clientID string) bool
}

func (r *Relay) hostAdapter(b clientBridge) headless.Bridge { return &adapter{r: r, b: b} }

type adapter struct {
	r *Relay
	b clientBridge
}

func (a *adapter) Known(id string) bool    { return a.b.Known(id) }
func (a *adapter) HasCalls(id string) bool { return a.b.HasCalls(id) }

// SetAway records the board host's client id ("" after its exit). The sessions of an older host
// stay until that host's ClientEnded; a sync on one of them is refused meanwhile.
func (a *adapter) SetAway(id string) {
	a.r.mu.Lock()
	a.r.hostID = id
	a.r.mu.Unlock()
}

// HoldsAny reports whether the board host is busy: a session opened with it is open, or a tool call
// started or ended less than quiet ago.
func (a *adapter) HoldsAny(id string) bool {
	r := a.r
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.sessions {
		if s.host == id {
			return true
		}
	}
	return !r.lastCall.IsZero() && r.now().Sub(r.lastCall) < r.quiet
}
