// Package linksim is a link simulator for tests: a TCP forwarder with a round trip time, a rate
// in each direction, a cut and a stall. It forwards bytes and knows nothing of what they are, so
// TLS, the pin and the Host header of a connection through it are the real ones.
//
// The remote listener's Host check includes the port, so a client cannot be given the link's
// address in the server's place. The link sits in the dial instead: Link.Dial is a
// servers.DialFunc, and a server process is given Addr() to dial.
package linksim

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// Profile is what a link is like. RTT is the round trip: half of it is added in each direction.
// Down limits the bytes from the target to the caller and Up those from the caller to the
// target, in bits per second; 0 is no limit. A rate is shared by the link's connections.
type Profile struct {
	RTT      time.Duration
	Down, Up int
}

var (
	Good = Profile{40 * time.Millisecond, 20e6, 20e6}
	Poor = Profile{200 * time.Millisecond, 2e6, 1e6}
)

const (
	bufSize  = 32 << 10              // the most one read takes
	slice    = 20 * time.Millisecond // what one read takes of a limited direction, at most
	credit   = 50 * time.Millisecond // how far a limited direction may run behind its rate and catch up
	queueLen = 256                   // chunks on their way in one direction of one connection
	relisten = 3 * time.Second       // what Uncut waits for its port at most
	dialWait = 10 * time.Second      // the connect to the target
)

// Link is one running simulator. Its methods may be called from any goroutine.
type Link struct {
	t        testing.TB
	target   string
	addr     string
	rtt      time.Duration
	down, up *lane

	mu          sync.Mutex
	ln          net.Listener // nil while cut and after the end
	ended       bool
	back, forth bool          // Stall
	flow        chan struct{} // closed and replaced at every Stall
	conns       map[*pair]struct{}
	wg          sync.WaitGroup
}

// Start listens on 127.0.0.1:0 and forwards every connection to target (host:port) under p.
// t.Cleanup stops it: the listener and every connection are closed and its goroutines have
// ended.
func Start(t testing.TB, target string, p Profile) *Link {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("linksim: listen: %v", err)
	}
	l := &Link{
		t: t, target: target, addr: ln.Addr().String(), rtt: p.RTT,
		down: newLane(p.Down), up: newLane(p.Up),
		ln: ln, flow: make(chan struct{}), conns: map[*pair]struct{}{},
	}
	l.wg.Add(1)
	go l.accept(ln)
	t.Cleanup(l.stop)
	return l
}

// Addr is the link's address, 127.0.0.1:port: the same one for as long as the link runs.
func (l *Link) Addr() string { return l.addr }

// Dial is a servers.DialFunc: it dials the link whatever addr is, so the caller keeps the
// target's real address for TLS and for the Host header.
func (l *Link) Dial(ctx context.Context, network, addr string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, "tcp4", l.addr)
}

// Cut ends every open connection and refuses new ones until Uncut. A second Cut does nothing.
func (l *Link) Cut() {
	l.mu.Lock()
	ln := l.ln
	l.ln = nil
	conns := l.takeLocked()
	l.mu.Unlock()
	if ln != nil {
		_ = ln.Close()
	}
	for _, c := range conns {
		c.close()
	}
}

// Uncut listens again on the same port. It does nothing for a link that is not cut.
func (l *Link) Uncut() {
	l.t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.ln != nil || l.ended {
		return
	}
	var ln net.Listener
	var err error
	for end := time.Now().Add(relisten); ; time.Sleep(20 * time.Millisecond) {
		if ln, err = net.Listen("tcp4", l.addr); err == nil || time.Now().After(end) {
			break
		}
	}
	if err != nil {
		l.t.Errorf("linksim: uncut on %s: %v", l.addr, err)
		return
	}
	l.ln = ln
	l.wg.Add(1)
	go l.accept(ln)
}

// Stall holds bytes back while the connections stay open. back: the bytes from the target wait;
// forth: the bytes to the target wait. Stall(false, false) lets them flow again, in their order.
// Bytes that wait fill the link: after some hundred kilobytes the sender's writes block.
func (l *Link) Stall(back, forth bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.back, l.forth = back, forth
	close(l.flow)
	l.flow = make(chan struct{})
}

func (l *Link) stop() {
	l.mu.Lock()
	l.ended = true
	l.mu.Unlock()
	l.Cut()
	l.wg.Wait()
}

func (l *Link) takeLocked() []*pair {
	conns := make([]*pair, 0, len(l.conns))
	for c := range l.conns {
		conns = append(conns, c)
	}
	return conns
}

func (l *Link) accept(ln net.Listener) {
	defer l.wg.Done()
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		l.wg.Add(1)
		go l.forward(ln, c)
	}
}

// forward serves one accepted connection until one side ends it or the link is cut.
func (l *Link) forward(ln net.Listener, near net.Conn) {
	defer l.wg.Done()
	far, err := net.DialTimeout("tcp4", l.target, dialWait)
	if err != nil {
		reset(near) // the target refuses: so does the link, as far as an open connection can
		return
	}
	p := &pair{near: near, far: far, done: make(chan struct{})}
	l.mu.Lock()
	if l.ln != ln { // cut since the accept
		l.mu.Unlock()
		p.close()
		return
	}
	l.conns[p] = struct{}{}
	l.mu.Unlock()

	var both sync.WaitGroup
	both.Add(2)
	go func() { defer both.Done(); l.pipe(p, near, far, l.up, false) }()
	go func() { defer both.Done(); l.pipe(p, far, near, l.down, true) }()
	both.Wait()
	p.close()
	l.mu.Lock()
	delete(l.conns, p)
	l.mu.Unlock()
}

// chunk is bytes on their way: they leave the link at due, or later while it is stalled.
type chunk struct {
	data []byte
	due  time.Time
}

// pipe carries one direction of p: what is read from src is written to dst half a round trip
// later, at the lane's rate. The end of src is passed on after the bytes before it.
func (l *Link) pipe(p *pair, src, dst net.Conn, ln *lane, back bool) {
	queue := make(chan chunk, queueLen)
	go func() {
		defer close(queue)
		buf := make([]byte, ln.readSize())
		for {
			n, err := src.Read(buf)
			if n > 0 {
				if !p.sleep(ln.reserve(n)) {
					return
				}
				c := chunk{data: append([]byte(nil), buf[:n]...), due: time.Now().Add(l.rtt / 2)}
				select {
				case queue <- c:
				case <-p.done:
					return
				}
			}
			if err != nil {
				if !errors.Is(err, io.EOF) {
					p.close()
				}
				return
			}
		}
	}()
	for c := range queue {
		if !p.sleep(c.due) || !l.flowing(p, back) {
			return
		}
		if _, err := dst.Write(c.data); err != nil {
			p.close()
			return
		}
	}
	select {
	case <-p.done:
	default:
		if tc, ok := dst.(*net.TCPConn); ok {
			_ = tc.CloseWrite()
		}
	}
}

// flowing waits while the direction is stalled. It returns false when p ended meanwhile.
func (l *Link) flowing(p *pair, back bool) bool {
	for {
		l.mu.Lock()
		stalled, flow := l.forth, l.flow
		if back {
			stalled = l.back
		}
		l.mu.Unlock()
		if !stalled {
			return true
		}
		select {
		case <-flow:
		case <-p.done:
			return false
		}
	}
}

// pair is one forwarded connection: the caller's side and the target's.
type pair struct {
	near, far net.Conn
	once      sync.Once
	done      chan struct{}
}

// close ends both sides at once: bytes on their way are lost, as on a link that is cut.
func (p *pair) close() {
	p.once.Do(func() {
		close(p.done)
		reset(p.near)
		reset(p.far)
	})
}

// sleep waits until at. It returns false when p ended meanwhile.
func (p *pair) sleep(at time.Time) bool {
	d := time.Until(at)
	if d <= 0 {
		select {
		case <-p.done:
			return false
		default:
			return true
		}
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-p.done:
		return false
	}
}

// reset closes c without waiting for what was written to it.
func reset(c net.Conn) {
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetLinger(0)
	}
	_ = c.Close()
}

// lane is one direction's rate, shared by the link's connections: a clock that says when the
// bytes taken so far have passed.
type lane struct {
	rate int // bits per second; 0 = no limit

	mu   sync.Mutex
	free time.Time // when the lane has passed everything reserved
}

func newLane(rate int) *lane { return &lane{rate: max(rate, 0)} }

// readSize is what one read may take: a slice's worth of a limited lane, so that the bytes
// pass evenly.
func (ln *lane) readSize() int {
	if ln.rate == 0 {
		return bufSize
	}
	return min(bufSize, max(256, int(int64(ln.rate)/8*int64(slice)/int64(time.Second))))
}

// reserve takes n bytes of the lane and returns when the last of them has passed: not after now
// without a limit. A lane that ran behind by a timer's lateness catches up, by credit at most,
// so an idle lane lets a credit's worth pass at once.
func (ln *lane) reserve(n int) time.Time {
	now := time.Now()
	if ln.rate == 0 {
		return now
	}
	ln.mu.Lock()
	defer ln.mu.Unlock()
	if earliest := now.Add(-credit); ln.free.Before(earliest) {
		ln.free = earliest
	}
	ln.free = ln.free.Add(time.Duration(int64(n) * 8 * int64(time.Second) / int64(ln.rate)))
	return ln.free
}
