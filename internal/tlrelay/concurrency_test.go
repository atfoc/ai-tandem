package tlrelay

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/headless"
	"ai-whiteboard/internal/testset"
)

// unlocked fails the test when relay.mu is held. Only for a rig used by one goroutine.
func unlocked(t *testing.T, r *Relay, what string) {
	t.Helper()
	if !r.mu.TryLock() {
		t.Errorf("%s was called with relay.mu held", what)
		return
	}
	r.mu.Unlock()
}

// lockedHost is a fakeHost that checks relay.mu on every call.
type lockedHost struct {
	*fakeHost
	t *testing.T
	r *Relay
}

func (h lockedHost) Ensure(ctx context.Context) (string, error) {
	unlocked(h.t, h.r, "Ensure")
	return h.fakeHost.Ensure(ctx)
}
func (h lockedHost) CallTimedOut() { unlocked(h.t, h.r, "CallTimedOut"); h.fakeHost.CallTimedOut() }
func (h lockedHost) Status() headless.Status {
	unlocked(h.t, h.r, "Status")
	return h.fakeHost.Status()
}

func TestNoHostOrCallBoardUnderTheLock(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	g.r.SetHost(lockedHost{g.host, t, g.r})
	g.br.call = func(editorbridge.CallSpec) (json.RawMessage, error) {
		unlocked(t, g.r, "CallBoard")
		return nil, fmt.Errorf("%w tool", editorbridge.ErrTimeout)
	}
	g.open("b1", "w1")
	g.r.CallTool(toolCall("apply"))
	g.r.Status()
	if e, to := g.host.counts(); e != 2 || to != 1 {
		t.Fatalf("Ensure %d, CallTimedOut %d", e, to)
	}
}

// Opens, syncs, closes, outs, the ends of windows and of hosts, and BoardGone, all at once. Afterwards: no
// session of an ended client or of an old host is left, and each session's events are in order.
func TestConcurrentInvariants(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	rounds := 150
	if testset.Full() {
		rounds = 1000
	}
	windows := []string{"w1", "w2", "w3", "w4"}
	for _, w := range windows {
		g.br.setKnown(w, true)
	}
	boards := []string{"b1", "b2"}

	var hostSeq atomic.Int64
	hostSeq.Store(1)
	// Ensure returns the current host; a quarter of the time that host dies right after (before the
	// open registers), and the manager starts a new one.
	var dieMu sync.Mutex // one host death at a time, as one manager does
	kill := func() {
		dieMu.Lock()
		defer dieMu.Unlock()
		id := g.hostID()
		g.endClient(id)
		g.startHost(fmt.Sprintf("h%d", hostSeq.Add(1)))
	}
	g.host.mu.Lock()
	g.host.ensure = func(context.Context) (string, error) {
		id := g.hostID()
		if rand.IntN(4) == 0 {
			kill()
		}
		return id, nil
	}
	g.host.mu.Unlock()

	var sessMu sync.Mutex
	var all []string // every session ever opened
	opened := map[string]string{}
	addSession := func(s, w string) {
		sessMu.Lock()
		all = append(all, s)
		opened[s] = w
		sessMu.Unlock()
	}
	pick := func() string {
		sessMu.Lock()
		defer sessMu.Unlock()
		if len(all) == 0 {
			return "s_none"
		}
		return all[rand.IntN(len(all))]
	}

	var wg sync.WaitGroup
	for _, w := range windows {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var mine []string
			for i := 0; i < rounds; i++ {
				b := boards[rand.IntN(len(boards))]
				switch k := rand.IntN(10); {
				case k < 3 || len(mine) == 0:
					code, m := g.do("POST", "/api/tl/"+b+"/open", w, nil)
					if code == 200 {
						s := m["session"].(string)
						mine = append(mine, s)
						addSession(s, w)
					} else if code != 503 && code != 409 {
						t.Errorf("open: %d %v", code, m)
					}
				case k < 8:
					s := mine[rand.IntN(len(mine))]
					code, _ := g.do("POST", "/api/tl/"+b+"/sync", w, map[string]any{"session": s, "messages": []string{"m"}})
					if code != 200 && code != 410 {
						t.Errorf("sync: %d", code)
					}
				default:
					s := mine[rand.IntN(len(mine))]
					if code, _ := g.do("POST", "/api/tl/"+b+"/close", w, map[string]any{"session": s}); code != 200 {
						t.Errorf("close: %d", code)
					}
				}
			}
		}()
	}
	// the host sends messages and closes
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < rounds; i++ {
			body := map[string]any{"out": []any{
				map[string]any{"session": pick(), "messages": []string{"o"}},
				map[string]any{"session": pick(), "messages": []string{"p"}},
			}}
			if i%5 == 0 {
				body["closed"] = []any{map[string]any{"session": pick(), "reason": "rejected"}}
			}
			if code, _ := g.do("POST", "/api/tl-host/out", g.hostID(), body); code != 200 && code != 403 {
				t.Errorf("out: %d", code)
			}
		}
	}()
	// streams end: windows reconnect with the same id, hosts are replaced, boards go
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < rounds/3; i++ {
			switch rand.IntN(3) {
			case 0:
				w := windows[rand.IntN(len(windows))]
				g.endClient(w)
				g.br.setKnown(w, true)
			case 1:
				kill()
			default:
				g.r.BoardGone(boards[rand.IntN(len(boards))], "deleted")
			}
			g.r.ScreenClient(boards[0])
			g.ad.HoldsAny(g.hostID())
		}
	}()
	// agent calls, with a host that may vanish
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < rounds/3; i++ {
			g.r.CallTool(toolCall("read_board"))
			g.r.Status()
		}
	}()
	wg.Wait()

	// No session of an ended client or of an old host is left.
	cur := g.hostID()
	g.r.mu.Lock()
	if g.r.hostID != cur {
		t.Errorf("relay's host %q, current %q", g.r.hostID, cur)
	}
	left := map[string]*session{}
	for id, s := range g.r.sessions {
		left[id] = s
		if s.host != cur || !g.br.Known(s.window) {
			t.Errorf("session %s of host %s, window %s is left (current host %s)", id, s.host, s.window, cur)
		}
	}
	g.r.mu.Unlock()

	// Each session's events are in order, on both sides.
	hosts := map[string]bool{}
	for i := int64(1); i <= hostSeq.Load(); i++ {
		hosts[fmt.Sprintf("h%d", i)] = true
	}
	sessMu.Lock()
	defer sessMu.Unlock()
	for h := range hosts {
		state := map[string]string{} // session → last event type at this host
		for _, ev := range g.br.all(h) {
			s, ty := sessionOf(ev), typeOf(ev)
			switch ty {
			case "tl_drop":
				continue
			case "tl_open":
				if state[s] != "" {
					t.Errorf("%s: tl_open of %s after %s", h, s, state[s])
				}
			case "tl_sync", "tl_close":
				if state[s] == "" || state[s] == "tl_close" {
					t.Errorf("%s: %s of %s after %q", h, ty, s, state[s])
				}
			default:
				t.Errorf("%s got %s", h, ty)
			}
			state[s] = ty
		}
		for s, st := range state {
			if l := left[s]; l != nil && (l.host != h || st == "tl_close") {
				t.Errorf("open session %s: last event at %s is %s", s, h, st)
			}
		}
	}
	for _, w := range windows {
		closed := map[string]bool{}
		for _, ev := range g.br.all(w) {
			s, ty := sessionOf(ev), typeOf(ev)
			if opened[s] != w {
				t.Errorf("%s got %s of %s, a session it did not open", w, ty, s)
			}
			if closed[s] {
				t.Errorf("%s got %s of %s after its tl_closed", w, ty, s)
			}
			if ty == "tl_closed" {
				closed[s] = true
				if left[s] != nil {
					t.Errorf("session %s is left after tl_closed", s)
				}
			} else if ty != "tl_sync" {
				t.Errorf("%s got %s", w, ty)
			}
		}
	}
	// every session left was told to its host
	for s, l := range left {
		found := false
		for _, ev := range g.br.all(l.host) {
			if sessionOf(ev) == s && typeOf(ev) == "tl_open" {
				found = true
			}
		}
		if !found {
			t.Errorf("session %s was never opened at %s", s, l.host)
		}
	}
	if testing.Verbose() {
		t.Logf("%d sessions opened, %d left, %d hosts", len(all), len(left), len(hosts))
	}
}

// Opens race with host deaths: every open is answered with a session of a live host or 503, never an orphan.
func TestOpenRacesHostDeath(t *testing.T) {
	t.Parallel()
	g := newRig(t)
	var seq atomic.Int64
	seq.Store(1)
	var dieMu sync.Mutex
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
			}
			dieMu.Lock()
			g.endClient(g.hostID())
			g.startHost(fmt.Sprintf("h%d", seq.Add(1)))
			dieMu.Unlock()
			for j := 0; j < 20; j++ { // let some opens through between the deaths
				runtime.Gosched()
			}
		}
	}()
	var wg sync.WaitGroup
	var ok, refused atomic.Int64
	for _, w := range []string{"w1", "w2"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 200; i++ {
				code, m := g.do("POST", "/api/tl/b1/open", w, nil)
				switch code {
				case 200:
					ok.Add(1)
				case 503:
					refused.Add(1)
				default:
					t.Errorf("open: %d %v", code, m)
				}
			}
		}()
	}
	wg.Wait()
	close(stop)
	<-done
	cur := g.hostID()
	g.r.mu.Lock()
	for id, s := range g.r.sessions {
		if s.host != cur {
			t.Errorf("orphan session %s of %s (current %s)", id, s.host, cur)
		}
	}
	g.r.mu.Unlock()
	if testing.Verbose() {
		t.Logf("%d opened, %d refused, %d hosts", ok.Load(), refused.Load(), seq.Load())
	}
}
