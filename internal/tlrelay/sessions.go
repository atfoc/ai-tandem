package tlrelay

import (
	"crypto/rand"
	"encoding/json"
	"math/big"
)

// session is one window showing one new board (design 2.1).
type session struct {
	id     string
	board  string
	window string // the window's client id
	host   string // the board host's client id the session was opened with
	seq    uint64
}

// The stream events of design 2.3. Messages is the bytes the sender gave, never parsed here.
type syncEvent struct {
	Type     string          `json:"type"` // "tl_sync"
	Board    string          `json:"board"`
	Session  string          `json:"session"`
	Messages json.RawMessage `json:"messages"`
}

type closedEvent struct {
	Type    string `json:"type"` // "tl_closed"
	Board   string `json:"board"`
	Session string `json:"session"`
	Reason  string `json:"reason"`
}

// sessionEvent is tl_open and tl_close.
type sessionEvent struct {
	Type    string `json:"type"`
	Board   string `json:"board"`
	Session string `json:"session"`
}

type dropEvent struct {
	Type   string `json:"type"` // "tl_drop"
	Board  string `json:"board"`
	Reason string `json:"reason"`
}

// ReasonHostStopped is the reason of tl_closed when the board host's stream ended.
const ReasonHostStopped = "host_stopped"

const base36 = "0123456789abcdefghijklmnopqrstuvwxyz"

// newSessionID returns "s_" and 16 random base36 characters.
func newSessionID() string {
	b := make([]byte, 2, 18)
	copy(b, "s_")
	n := big.NewInt(int64(len(base36)))
	for i := 0; i < 16; i++ {
		k, err := rand.Int(rand.Reader, n)
		if err != nil {
			panic("tlrelay: crypto/rand: " + err.Error())
		}
		b = append(b, base36[k.Int64()])
	}
	return string(b)
}

// addLocked registers a new session and sends tl_open to its host. It reports false, and registers
// nothing, when the host's stream is gone.
func (r *Relay) addLocked(board, window, host string) (*session, bool) {
	id := newSessionID()
	for r.sessions[id] != nil {
		id = newSessionID()
	}
	r.seq++
	s := &session{id: id, board: board, window: window, host: host, seq: r.seq}
	if !r.bridge.SendTo(host, sessionEvent{Type: "tl_open", Board: board, Session: id}) {
		return nil, false
	}
	r.sessions[id] = s
	return s, true
}

// closeToHostLocked drops s and tells its host (tl_close).
func (r *Relay) closeToHostLocked(s *session) {
	delete(r.sessions, s.id)
	r.bridge.SendTo(s.host, sessionEvent{Type: "tl_close", Board: s.board, Session: s.id})
}

// closeToWindowLocked drops s and tells its window (tl_closed with reason).
func (r *Relay) closeToWindowLocked(s *session, reason string) {
	delete(r.sessions, s.id)
	r.bridge.SendTo(s.window, closedEvent{Type: "tl_closed", Board: s.board, Session: s.id, Reason: reason})
}

// ClientEnded is the bridge's OnEnd hook: a client's stream ended or was replaced. It is called
// without the bridge's lock.
//
// For the board host (or an older one) every session opened with it is closed with "host_stopped"
// to its window. The host id itself is not touched: it is owned by the manager alone, through the
// adapter's SetAway, because a host's stream can end while its process lives on and reconnects with
// the same client id (a dropped connection, or a stream the bridge replaced; then the new stream is
// already registered and Known(clientID) is true here). In that case the host is also sent tl_close
// for each dropped session, so its room forgets those sockets; the windows open new sessions.
//
// For a window its sessions are closed and their host is sent tl_close.
func (r *Relay) ClientEnded(clientID string) {
	if clientID == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	alive := r.bridge.Known(clientID)
	for _, s := range r.sessions {
		switch clientID {
		case s.host:
			r.closeToWindowLocked(s, ReasonHostStopped)
			if alive {
				r.bridge.SendTo(s.host, sessionEvent{Type: "tl_close", Board: s.board, Session: s.id})
			}
		case s.window:
			r.closeToHostLocked(s)
		}
	}
}

// BoardGone closes every session of the board (tl_closed with reason, "archived" or "deleted") and
// tells the current board host, if its stream is there, to close its room (tl_drop). Call it after
// the store's change.
func (r *Relay) BoardGone(id, reason string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.sessions {
		if s.board == id {
			r.closeToWindowLocked(s, reason)
		}
	}
	if r.hostID != "" && r.bridge.Known(r.hostID) {
		r.bridge.SendTo(r.hostID, dropEvent{Type: "tl_drop", Board: id, Reason: reason})
	}
}

// ScreenClient returns the window with the newest open session on the board, for the calls about a
// screen (get_view, show_board). A found window counts one screen call.
func (r *Relay) ScreenClient(board string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var best *session
	for _, s := range r.sessions {
		if s.board == board && (best == nil || s.seq > best.seq) && r.bridge.Known(s.window) {
			best = s
		}
	}
	if best == nil {
		return "", false
	}
	r.screenCalls++
	return best.window, true
}
