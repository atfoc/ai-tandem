package linksim_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/linksim"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/testset"
)

// Link.Dial is what servers.Options.Dial takes.
var _ servers.DialFunc = (*linksim.Link)(nil).Dial

const waitLimit = 10 * time.Second

// echo is a server that sends back what it gets and keeps count of it.
type echo struct {
	addr string

	mu   sync.Mutex
	got  []byte
	open int
}

func startEcho(t *testing.T) *echo {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	e := &echo{addr: ln.Addr().String()}
	var conns sync.WaitGroup
	t.Cleanup(func() { _ = ln.Close(); conns.Wait() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			conns.Add(1)
			go func() {
				defer conns.Done()
				defer c.Close()
				e.count(1)
				defer e.count(-1)
				buf := make([]byte, 32<<10)
				for {
					n, err := c.Read(buf)
					if n > 0 {
						e.mu.Lock()
						e.got = append(e.got, buf[:n]...)
						e.mu.Unlock()
						if _, err := c.Write(buf[:n]); err != nil {
							return
						}
					}
					if err != nil {
						return
					}
				}
			}()
		}
	}()
	return e
}

func (e *echo) count(d int) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.open += d
}

func (e *echo) received() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return string(e.got)
}

func (e *echo) conns() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.open
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(waitLimit); ; time.Sleep(2 * time.Millisecond) {
		if ok() {
			return
		}
		if time.Now().After(end) {
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

// dial connects through the link the way a servers.Manager does: by Link.Dial, with an address
// that is not the link's.
func dial(t *testing.T, l *linksim.Link) net.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
	defer cancel()
	c, err := l.Dial(ctx, "tcp", "studio.example:8443")
	if err != nil {
		t.Fatalf("dial through the link: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// trip writes msg and reads its echo, and returns how long that took.
func trip(t *testing.T, c net.Conn, msg string) time.Duration {
	t.Helper()
	start := time.Now()
	_ = c.SetDeadline(start.Add(waitLimit))
	if _, err := c.Write([]byte(msg)); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != msg {
		t.Fatalf("echo %q, %v; want %q", buf, err, msg)
	}
	return time.Since(start)
}

// TestRoundTrip: the measured round trip is the profile's, within 20 % or a few milliseconds.
func TestRoundTrip(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name string
		p    linksim.Profile
	}{
		{"none", linksim.Profile{}},
		{"good", linksim.Good},
		{"poor", linksim.Poor},
		{"rtt alone", linksim.Profile{RTT: 100 * time.Millisecond}},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			l := linksim.Start(t, startEcho(t).addr, c.p)
			conn := dial(t, l)
			trip(t, conn, "warm") // the connect to the target is not part of a round trip
			const trips = 5
			var sum time.Duration
			for range trips {
				sum += trip(t, conn, "ping")
			}
			got := sum / trips
			slack := max(c.p.RTT/5, 8*time.Millisecond)
			if got < c.p.RTT || got > c.p.RTT+slack {
				t.Errorf("round trip %v; want %v, up to %v more", got, c.p.RTT, slack)
			}
		})
	}
}

// TestAddr: the address is a loopback one that forwards as Dial does, to another process too.
func TestAddr(t *testing.T) {
	t.Parallel()
	e := startEcho(t)
	l := linksim.Start(t, e.addr, linksim.Profile{})
	host, _, err := net.SplitHostPort(l.Addr())
	if err != nil || host != "127.0.0.1" || l.Addr() == e.addr {
		t.Fatalf("Addr %q (the target is %q), %v", l.Addr(), e.addr, err)
	}
	c, err := net.Dial("tcp", l.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	trip(t, c, "by address")

	// The end of the caller's side reaches the target, after the bytes before it.
	if _, err := c.Write([]byte("last")); err != nil {
		t.Fatal(err)
	}
	_ = c.(*net.TCPConn).CloseWrite()
	rest, err := io.ReadAll(c)
	if err != nil || string(rest) != "last" {
		t.Errorf("after the half close: %q, %v", rest, err)
	}
	waitFor(t, "the target's connection to end", func() bool { return e.conns() == 0 })
}

// TestRate: 1 MB at 2e6 bit/s takes about 4 s, in each direction. The default set sends a fifth
// of it, 40 slices of the rate's clock: about 0.8 s.
func TestRate(t *testing.T) {
	t.Parallel()
	const rate = 2_000_000
	size := 200_000
	if testset.Full() {
		size = 1_000_000
	}
	want := time.Duration(size) * 8 * time.Second / rate
	for _, c := range []struct {
		name string
		p    linksim.Profile
	}{
		{"down", linksim.Profile{Down: rate}},
		{"up", linksim.Profile{Up: rate}},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			l := linksim.Start(t, startEcho(t).addr, c.p)
			conn := dial(t, l)
			trip(t, conn, "warm")
			data := make([]byte, size)
			for i := range data {
				data[i] = byte(i * 7)
			}
			start := time.Now()
			_ = conn.SetDeadline(start.Add(3 * want))
			go func() { _, _ = conn.Write(data) }()
			back := make([]byte, size)
			if _, err := io.ReadFull(conn, back); err != nil {
				t.Fatalf("read: %v", err)
			}
			took := time.Since(start)
			if !bytes.Equal(back, data) {
				t.Error("the bytes that came back are not the ones sent")
			}
			if took < want*7/10 || took > want*13/10 {
				t.Errorf("%d bytes at %d bit/s took %v; want %v within 30 %%", size, rate, took, want)
			}
		})
	}
}

// TestCut: a cut ends the open connections and refuses new ones; after Uncut new ones pass, on
// the same address.
func TestCut(t *testing.T) {
	t.Parallel()
	e := startEcho(t)
	l := linksim.Start(t, e.addr, linksim.Good)
	addr := l.Addr()
	one, two := dial(t, l), dial(t, l)
	trip(t, one, "one")
	trip(t, two, "two")
	l.Uncut() // not cut: nothing happens
	trip(t, one, "still")

	l.Cut()
	for _, c := range []net.Conn{one, two} {
		_ = c.SetDeadline(time.Now().Add(waitLimit))
		var netErr net.Error
		if n, err := c.Read(make([]byte, 1)); err == nil || errors.As(err, &netErr) && netErr.Timeout() {
			t.Errorf("a read on a cut connection: %d bytes, %v; want its end", n, err)
		}
	}
	waitFor(t, "the target's connections to end", func() bool { return e.conns() == 0 })
	for range 3 {
		ctx, cancel := context.WithTimeout(context.Background(), waitLimit)
		c, err := l.Dial(ctx, "tcp", "studio.example:8443")
		cancel()
		if !errors.Is(err, syscall.ECONNREFUSED) {
			t.Errorf("a dial while cut: %v; want connection refused", err)
		}
		if c != nil {
			_ = c.Close()
		}
	}
	if c, err := net.DialTimeout("tcp", addr, waitLimit); !errors.Is(err, syscall.ECONNREFUSED) {
		t.Errorf("a dial of the address while cut: %v; want connection refused", err)
		if c != nil {
			_ = c.Close()
		}
	}
	l.Cut() // a second Cut does nothing

	l.Uncut()
	if l.Addr() != addr {
		t.Errorf("Addr %q after Uncut; was %q", l.Addr(), addr)
	}
	three := dial(t, l)
	if d := trip(t, three, "three"); d < linksim.Good.RTT {
		t.Errorf("a round trip of %v after Uncut; the profile's is %v", d, linksim.Good.RTT)
	}
	if got := e.received(); got != "onetwostillthree" {
		t.Errorf("the target received %q", got)
	}
}

// TestStall: with the way back stalled the connection stays open, the bytes to the target
// arrive and those from it wait; they come in their order afterwards. The same the other way.
func TestStall(t *testing.T) {
	t.Parallel()
	const hold = 150 * time.Millisecond
	// silent checks that nothing can be read from c for a while and that c is still open.
	silent := func(t *testing.T, c net.Conn) {
		t.Helper()
		_ = c.SetReadDeadline(time.Now().Add(hold))
		var netErr net.Error
		if n, err := c.Read(make([]byte, 64)); n != 0 || !errors.As(err, &netErr) || !netErr.Timeout() {
			t.Fatalf("a read while stalled: %d bytes, %v; want nothing and the connection open", n, err)
		}
	}
	read := func(t *testing.T, c net.Conn, want string) {
		t.Helper()
		_ = c.SetReadDeadline(time.Now().Add(waitLimit))
		buf := make([]byte, len(want))
		if _, err := io.ReadFull(c, buf); err != nil || string(buf) != want {
			t.Fatalf("read %q, %v; want %q", buf, err, want)
		}
	}
	write := func(t *testing.T, c net.Conn, s string) {
		t.Helper()
		_ = c.SetWriteDeadline(time.Now().Add(waitLimit))
		if _, err := c.Write([]byte(s)); err != nil {
			t.Fatalf("write %q: %v", s, err)
		}
	}

	t.Run("back", func(t *testing.T) {
		t.Parallel()
		e := startEcho(t)
		l := linksim.Start(t, e.addr, linksim.Good)
		c := dial(t, l)
		trip(t, c, "before ")
		l.Stall(true, false)
		for _, s := range []string{"one ", "two ", "three "} {
			write(t, c, s)
			waitFor(t, "the target to get "+s, func() bool { return strings.HasSuffix(e.received(), s) })
		}
		silent(t, c)
		// A connection made during the stall is held the same way.
		late := dial(t, l)
		write(t, late, "late")
		waitFor(t, "the target to get the late bytes", func() bool { return strings.HasSuffix(e.received(), "late") })
		silent(t, late)
		if e.conns() != 2 {
			t.Errorf("%d connections at the target during the stall; want 2", e.conns())
		}

		l.Stall(false, false)
		read(t, c, "one two three ")
		read(t, late, "late")
		if d := trip(t, c, "after"); d > linksim.Good.RTT*3 {
			t.Errorf("a round trip of %v after the stall", d)
		}
	})

	t.Run("forth", func(t *testing.T) {
		t.Parallel()
		e := startEcho(t)
		l := linksim.Start(t, e.addr, linksim.Good)
		c := dial(t, l)
		trip(t, c, "before ")
		l.Stall(false, true)
		write(t, c, "one ")
		write(t, c, "two ")
		silent(t, c)
		if got := e.received(); got != "before " {
			t.Errorf("the target received %q during the stall", got)
		}
		l.Stall(false, false)
		read(t, c, "one two ")
		if got := e.received(); got != "before one two " {
			t.Errorf("the target received %q", got)
		}
	})

	t.Run("both, then a cut", func(t *testing.T) {
		t.Parallel()
		e := startEcho(t)
		l := linksim.Start(t, e.addr, linksim.Profile{})
		c := dial(t, l)
		trip(t, c, "before ")
		l.Stall(true, true)
		write(t, c, "lost")
		silent(t, c)
		l.Cut()
		_ = c.SetReadDeadline(time.Now().Add(waitLimit))
		var netErr net.Error
		if n, err := c.Read(make([]byte, 8)); n != 0 || err == nil || errors.As(err, &netErr) && netErr.Timeout() {
			t.Errorf("a read after the cut: %d bytes, %v; want the connection's end", n, err)
		}
		waitFor(t, "the target's connection to end", func() bool { return e.conns() == 0 })
		if got := e.received(); got != "before " {
			t.Errorf("the target received %q", got)
		}
		// The stall outlives the cut: it is the link's, not a connection's.
		l.Uncut()
		again := dial(t, l)
		write(t, again, "again")
		silent(t, again)
		l.Stall(false, false)
		read(t, again, "again")
	})
}

// TestBehindAManager: a servers.Manager dials through the link and keeps the server's real
// address, so TLS, the pin and the Host check are the real ones. A cut is an outage; after
// Uncut, Retry brings the entry back although its back-off is long.
func TestBehindAManager(t *testing.T) {
	t.Parallel()
	s := standin.Start(t, standin.Options{})
	target := s.URL()[len("https://"):]
	l := linksim.Start(t, target, linksim.Good)
	const limit = 5 * time.Second
	m, err := servers.Open(servers.Options{
		Root: t.TempDir(), LocalID: "11111111-1111-4111-8111-111111111111", Version: "v-local",
		Dial: l.Dial,
		Timing: servers.Timing{
			Dial: limit, Handshake: limit, Headers: limit, Hello: limit, FirstEvent: limit, Call: limit,
			TestStep: limit, Silence: limit, Backoff: []time.Duration{time.Minute}, Jitter: -1,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m.Close)
	m.Start()
	in := servers.Input{Name: "Studio", Address: s.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: s.Fingerprint()}
	v, saved, res, err := m.Add(context.Background(), in, false)
	if err != nil || !saved {
		t.Fatalf("Add through the link: saved %v, result %+v, %v", saved, res, err)
	}
	state := func() servers.State {
		got, _ := m.View(v.ID)
		return got.State
	}
	waitFor(t, "connected", func() bool { return state() == servers.StateConnected })
	if got, _ := m.View(v.ID); got.Address != s.URL() {
		t.Errorf("the entry's address is %q; want the server's, %q", got.Address, s.URL())
	}
	// Connected at all: the stand-in checks the Host header against its own address, port
	// included, and the pin was checked against its certificate.

	l.Cut()
	waitFor(t, "unreachable", func() bool { return state() == servers.StateUnreachable })
	if _, err := m.Do(context.Background(), v.ID, "GET", servers.StatePath, nil, 0); !errors.Is(err, servers.ErrNotConnected) {
		t.Errorf("a call during the cut: %v", err)
	}
	l.Uncut()
	// The wait begins a moment after the state: Retry is called as the relay calls it, at every
	// call that finds the entry not connected.
	waitFor(t, "connected again", func() bool {
		m.Retry(v.ID)
		return state() == servers.StateConnected
	})
}
