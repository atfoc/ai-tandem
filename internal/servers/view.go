package servers

import (
	"slices"

	"ai-whiteboard/internal/model"
)

// State is what an entry's connection is in: the eleven states the pages show.
type State string

const (
	StateConnecting             State = "connecting"               // a first attempt runs
	StateConnected              State = "connected"                // the stream is open and its snapshot was read
	StateUnreachable            State = "unreachable"              // no connection, or the stream ended; retried
	StateSecretNotAccepted      State = "secret_not_accepted"      // 401
	StateFingerprintNotAccepted State = "fingerprint_not_accepted" // box on and no pin: nothing is sent
	StateCertificateChanged     State = "certificate_changed"      // the pin refused the certificate
	StateCertificateNotAccepted State = "certificate_not_accepted" // box off and verification failed; retried
	StateNameNotKnown           State = "name_not_known"           // 403 "bad host"
	StateNotAIWB                State = "not_aiwb"                 // something else answers there
	StateTooOld                 State = "too_old"                  // hello's level is below MinFeatureLevel
	StateAnotherServer          State = "another_server"           // another id answers, the local one, or one of another entry
)

// retries reports whether a connection in s tries again by itself, with back-off and without end.
func (s State) retries() bool {
	return s == StateUnreachable || s == StateCertificateNotAccepted
}

// stops reports whether a connection in s sends nothing more until the user does something.
func (s State) stops() bool {
	return s != StateConnecting && s != StateConnected && !s.retries()
}

// Stopped reports whether an entry in s waits for the user: nothing is sent until an edit, an
// accept or a test gets it going again.
func (s State) Stopped() bool { return s.stops() }

// stateOf is the state a connection enters when an attempt ended with o.
func stateOf(o Outcome) State {
	switch o {
	case OutcomeConnected:
		return StateConnected
	case OutcomeSelfSigned, OutcomeCertName, OutcomeCertExpired, OutcomeCertUntrusted:
		return StateCertificateNotAccepted
	case OutcomeSecretRefused:
		return StateSecretNotAccepted
	case OutcomeFingerprint:
		return StateFingerprintNotAccepted
	case OutcomeCertChanged:
		return StateCertificateChanged
	case OutcomeBadHost:
		return StateNameNotKnown
	case OutcomeNotAIWB:
		return StateNotAIWB
	case OutcomeTooOld:
		return StateTooOld
	case OutcomeIsLocal, OutcomeDuplicate, OutcomeAnotherServer:
		return StateAnotherServer
	}
	// refused, name_not_found, no_route, tls_timeout, not_https, tls_error, no_answer, no_state.
	return StateUnreachable
}

// View is one entry as the pages get it: the wire shape. It has no secret field.
type View struct {
	ID          string            `json:"id"`
	Local       bool              `json:"local,omitempty"`
	Name        string            `json:"name"`
	Address     string            `json:"address,omitempty"`
	SelfSigned  bool              `json:"selfSigned,omitempty"`
	Pin         string            `json:"pin,omitempty"`
	InstanceID  string            `json:"instanceId,omitempty"`
	State       State             `json:"state"`
	Detail      string            `json:"detail,omitempty"`      // plain text: Go's, or a sentence of this package
	Fingerprint string            `json:"fingerprint,omitempty"` // certificate_changed: the presented certificate's
	Version     string            `json:"version,omitempty"`
	Agents      []model.AgentKind `json:"agents,omitempty"`
}

// localView is the local entry: the first of every list, always connected.
func localView(version, instanceID string) View {
	return View{ID: LocalID, Local: true, Name: LocalName, State: StateConnected, Version: version, InstanceID: instanceID}
}

// shown is a connection's part of its entry's view. A change of any field of it is a
// server_state event.
type shown struct {
	state               State
	detail, fingerprint string
	version             string
	agents              []model.AgentKind
}

func (s shown) equal(o shown) bool {
	return s.state == o.state && s.detail == o.detail && s.fingerprint == o.fingerprint &&
		s.version == o.version && slices.Equal(s.agents, o.agents)
}

// viewOf joins a stored entry with its connection's part.
func viewOf(e Entry, s shown) View {
	return View{
		ID: e.ID, Name: e.Name, Address: e.Address, SelfSigned: e.SelfSigned, Pin: e.Pin, InstanceID: e.InstanceID,
		State: s.state, Detail: s.detail, Fingerprint: s.fingerprint, Version: s.version,
		Agents: slices.Clone(s.agents),
	}
}

// listEvent and stateEvent are the two events the manager gives to Options.Notify.
type listEvent struct {
	Type    string `json:"type"` // "servers"
	Servers []View `json:"servers"`
	Notice  string `json:"notice"`
}

type stateEvent struct {
	Type   string `json:"type"` // "server_state"
	Server View   `json:"server"`
}
