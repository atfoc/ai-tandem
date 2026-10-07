package servers

import (
	"crypto/x509"
	"math/rand/v2"
	"time"
)

// Timing holds the time limits of a connection and of a test. A zero field takes DefaultTiming's.
type Timing struct {
	Dial       time.Duration // the TCP connect
	Handshake  time.Duration // the TLS handshake
	Headers    time.Duration // an answer's headers, after the request was written
	Hello      time.Duration // GET /api/hello, with its body
	FirstEvent time.Duration // the stream's hello and snapshot, after its headers
	Call       time.Duration // a call passed on with Do and no limit of its own
	TestStep   time.Duration // each step of TestConnection
	Silence    time.Duration // a stream without a byte, ping or event, for this long has ended

	// Backoff are the waits between the attempts of a connection that retries; the last one
	// repeats. Each wait is changed by a random part of up to Jitter of it, more or less: 0.2 is
	// ±20 %. A negative Jitter means none.
	Backoff []time.Duration
	Jitter  float64

	// Stable is how long a stream must stay open, from its snapshot on, for the back-off to
	// start again at its first step. A stream that ended sooner counts as one more failed
	// attempt. It belongs to Backoff: a Timing that sets Backoff and leaves Stable 0 starts the
	// back-off again as soon as a stream was open; DefaultTiming's is taken with its Backoff.
	Stable time.Duration
}

// DefaultTiming is what a zero Timing means.
var DefaultTiming = Timing{
	Dial:       3 * time.Second,
	Handshake:  3 * time.Second,
	Headers:    3 * time.Second,
	Hello:      10 * time.Second,
	FirstEvent: 10 * time.Second,
	Call:       15 * time.Second,
	TestStep:   5 * time.Second,
	Silence:    35 * time.Second,
	Backoff:    []time.Duration{time.Second, 2 * time.Second, 5 * time.Second, 10 * time.Second, 30 * time.Second},
	Jitter:     0.2,
	Stable:     30 * time.Second, // the last step of Backoff
}

// withDefaults fills every zero field from DefaultTiming; Stable only together with Backoff.
func (t Timing) withDefaults() Timing {
	if t.Dial <= 0 {
		t.Dial = DefaultTiming.Dial
	}
	if t.Handshake <= 0 {
		t.Handshake = DefaultTiming.Handshake
	}
	if t.Headers <= 0 {
		t.Headers = DefaultTiming.Headers
	}
	if t.Hello <= 0 {
		t.Hello = DefaultTiming.Hello
	}
	if t.FirstEvent <= 0 {
		t.FirstEvent = DefaultTiming.FirstEvent
	}
	if t.Call <= 0 {
		t.Call = DefaultTiming.Call
	}
	if t.TestStep <= 0 {
		t.TestStep = DefaultTiming.TestStep
	}
	if t.Silence <= 0 {
		t.Silence = DefaultTiming.Silence
	}
	if len(t.Backoff) == 0 {
		t.Backoff = DefaultTiming.Backoff
		if t.Stable == 0 {
			t.Stable = DefaultTiming.Stable
		}
	}
	t.Stable = max(t.Stable, 0)
	if t.Jitter == 0 {
		t.Jitter = DefaultTiming.Jitter
	}
	return t
}

// backoff is the wait before the attempt after n failed ones in a row, n from 0: the n-th step
// of Backoff, the last one from then on, with its jitter. t has its defaults.
func (t Timing) backoff(n int) time.Duration {
	if n >= len(t.Backoff) {
		n = len(t.Backoff) - 1
	}
	d := t.Backoff[n]
	if t.Jitter > 0 {
		d += time.Duration(float64(d) * t.Jitter * (2*rand.Float64() - 1))
	}
	return max(d, 0)
}

// Options configures the manager and what dials. Timing, Roots and Dial are test seams: zero
// means the defaults. TestConnection reads LocalID and the seams only.
type Options struct {
	Root    string // the data folder: servers.json is in it
	LocalID string // this server's instance id: the client id sent to a remote server
	Version string // this server's version, for the local entry's view

	// Notify gets the events for the pages (the bridge's Broadcast). It is called from one
	// goroutine, in order, and never with a lock of the manager held.
	Notify func(ev any)

	Timing Timing
	Roots  *x509.CertPool // nil = the system's
	Dial   DialFunc       // nil = net.Dialer
}
